import * as vscode from "vscode";
import { VulcanVuln } from "./types";

// Severity → VS Code DiagnosticSeverity (case-insensitive — backend returns lowercase)
function toDiagSeverity(sev: string): vscode.DiagnosticSeverity {
  switch ((sev ?? "").toUpperCase()) {
    case "CRITICAL":
    case "HIGH":
      return vscode.DiagnosticSeverity.Error;
    case "MEDIUM":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

// Keyed by document URI string → list of vulns (so hover/codelens can look up)
const vulnMap = new Map<string, VulcanVuln[]>();

let collection: vscode.DiagnosticCollection;

export function init(ctx: vscode.ExtensionContext): void {
  collection = vscode.languages.createDiagnosticCollection("vulcan");
  ctx.subscriptions.push(collection);
}

export function setVulns(uri: vscode.Uri, vulns: VulcanVuln[]): void {
  vulnMap.set(uri.toString(), vulns);

  const diagnostics: vscode.Diagnostic[] = vulns.map((v) => {
    // Backend sends start_line (1-based); VS Code lines are 0-based
    const line = Math.max(0, (v.location.start_line ?? v.location.line ?? 1) - 1);
    const col = Math.max(0, (v.location.column ?? 1) - 1);
    const range = new vscode.Range(line, col, line, col + 200);

    const diag = new vscode.Diagnostic(
      range,
      buildMessage(v),
      toDiagSeverity(v.severity)
    );
    diag.source = "Vulcan";
    diag.code = v.cwe ?? v.type;
    return diag;
  });

  collection.set(uri, diagnostics);
}

export function clearAll(): void {
  collection.clear();
  vulnMap.clear();
}

export function clearUri(uri: vscode.Uri): void {
  collection.delete(uri);
  vulnMap.delete(uri.toString());
}

export function getVulnsForUri(uri: vscode.Uri): VulcanVuln[] {
  return vulnMap.get(uri.toString()) ?? [];
}

export function getVulnAt(
  uri: vscode.Uri,
  position: vscode.Position
): VulcanVuln | undefined {
  const vulns = getVulnsForUri(uri);
  return vulns.find((v) => {
    const line = Math.max(0, (v.location.start_line ?? v.location.line ?? 1) - 1);
    return position.line === line;
  });
}

export function allVulns(): Map<string, VulcanVuln[]> {
  return vulnMap;
}

function buildMessage(v: VulcanVuln): string {
  const parts = [`[${v.severity}] ${v.type}`];
  if (v.cwe) {
    parts.push(`(${v.cwe})`);
  }
  if (v.evidence?.sink) {
    parts.push(`→ sink: ${v.evidence.sink}`);
  }
  return parts.join(" ");
}
