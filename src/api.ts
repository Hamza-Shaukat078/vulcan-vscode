import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import { LoginResponse, ScanResult, PatchResult, VulcanVuln } from "./types";

function baseUrl(): string {
  const url = vscode.workspace
    .getConfiguration("vulcan")
    .get<string>("backendUrl", "http://localhost:8000")
    .replace(/\/$/, "");
  return url + "/api/v1";
}

function request<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl() + path);
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (payload) {
      headers["Content-Length"] = Buffer.byteLength(payload).toString();
    }

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          let msg = `HTTP ${res.statusCode}`;
          try {
            const parsed = JSON.parse(data);
            msg = parsed.detail || parsed.message || msg;
          } catch {}
          reject(new Error(msg));
          return;
        }
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          resolve(data as unknown as T);
        }
      });
    });

    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

export async function login(
  email: string,
  password: string
): Promise<LoginResponse> {
  return request<LoginResponse>("POST", "/auth/login", { email, password });
}

export async function scanFile(
  code: string,
  language: string,
  filename: string,
  token: string
): Promise<ScanResult> {
  const enableLLM = vscode.workspace
    .getConfiguration("vulcan")
    .get<boolean>("enableLLM", true);
  return request<ScanResult>(
    "POST",
    "/scan",
    { filename, code, language, enable_llm: enableLLM },
    token
  );
}

export async function generatePatch(
  vuln: VulcanVuln,
  token: string
): Promise<PatchResult> {
  return request<PatchResult>(
    "POST",
    "/patches/generate",
    {
      vulnerability_id: vuln.id,
      context: {
        vulnerability_id: vuln.id,
        file_path: vuln.location.file,
        language: vuln.location.file.endsWith(".py") ? "python" : "javascript",
        vuln_type: vuln.type,
        cwe: vuln.cwe,
        owasp: vuln.owasp,
        vulnerable_slice: vuln.evidence?.code_snippet ?? "",
        taint_path: vuln.evidence?.data_flow_path ?? [],
        sink: vuln.evidence?.sink,
        source: vuln.evidence?.source,
      },
    },
    token
  );
}

export async function validatePatch(
  patchId: string,
  token: string
): Promise<{ status: string }> {
  return request<{ status: string }>(
    "POST",
    `/patches/${patchId}/validate`,
    undefined,
    token
  );
}

export async function approvePatch(
  patchId: string,
  token: string
): Promise<void> {
  await request("POST", `/patches/${patchId}/approve`, undefined, token);
}

export async function rejectPatch(
  patchId: string,
  token: string
): Promise<void> {
  await request("POST", `/patches/${patchId}/reject`, undefined, token);
}

export async function exportPatch(
  patchId: string,
  token: string
): Promise<string> {
  return request<string>(
    "GET",
    `/patches/${patchId}/export`,
    undefined,
    token
  );
}
