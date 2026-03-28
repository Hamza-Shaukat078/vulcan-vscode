import * as vscode from "vscode";
import * as auth from "./auth";
import * as diagStore from "./diagnostics";
import * as statusBar from "./statusBar";
import * as api from "./api";
import { VulcanHoverProvider } from "./hoverProvider";
import { VulcanCodeLensProvider } from "./codelensProvider";
import { VulcanSidebarProvider } from "./sidebarProvider";
import {
  PatchContentProvider,
  contentProvider,
  generateAndShow,
} from "./patchProvider";

const SUPPORTED_LANGS = ["python", "javascript", "typescript"];
const CHANGE_DEBOUNCE_MS = 1000; // debounce for typing
const MAX_CONCURRENT_SCANS = 3;  // max parallel API calls during workspace scan
const MAX_FILE_LINES = 600;      // skip very large files

let sidebar: VulcanSidebarProvider;
let codelens: VulcanCodeLensProvider;

// Per-document debounce timers (keyed by URI string)
const changeTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Track which URIs have been scanned this session so we don't double-scan
const scannedUris = new Set<string>();

// Track ongoing workspace scan so we don't start two at once
let workspaceScanRunning = false;

export function activate(context: vscode.ExtensionContext): void {
  // ── Init modules ──────────────────────────────────────────────────────────
  auth.init(context);
  diagStore.init(context);
  statusBar.init(context);

  // ── Providers ─────────────────────────────────────────────────────────────
  codelens = new VulcanCodeLensProvider();
  sidebar = new VulcanSidebarProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      PatchContentProvider.scheme,
      contentProvider
    ),
    vscode.languages.registerHoverProvider(
      SUPPORTED_LANGS.map((l) => ({ language: l })),
      new VulcanHoverProvider()
    ),
    vscode.languages.registerCodeLensProvider(
      SUPPORTED_LANGS.map((l) => ({ language: l })),
      codelens
    ),
    vscode.window.registerTreeDataProvider("vulcan.vulnerabilities", sidebar)
  );

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("vulcan.login", async () => {
      const ok = await auth.login();
      if (ok) {
        statusBar.setIdle();
        // Start workspace scan right after login
        await scanWorkspace();
      }
    }),

    vscode.commands.registerCommand("vulcan.logout", async () => {
      await auth.logout();
      diagStore.clearAll();
      scannedUris.clear();
      sidebar.refresh();
      codelens.refresh();
      statusBar.setLoggedOut();
    }),

    vscode.commands.registerCommand("vulcan.scanFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !SUPPORTED_LANGS.includes(editor.document.languageId)) {
        vscode.window.showWarningMessage(
          "Vulcan: Open a Python or JavaScript file to scan."
        );
        return;
      }
      scannedUris.delete(editor.document.uri.toString()); // force rescan
      await scanDocument(editor.document);
    }),

    vscode.commands.registerCommand("vulcan.scanWorkspace", async () => {
      scannedUris.clear();
      await scanWorkspace();
    }),

    vscode.commands.registerCommand(
      "vulcan.generatePatch",
      async (vulnId: string) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage("Vulcan: No active editor.");
          return;
        }
        const vulns = diagStore.getVulnsForUri(editor.document.uri);
        await generateAndShow(vulnId, vulns, editor.document);
      }
    ),

    vscode.commands.registerCommand("vulcan.clearDiagnostics", () => {
      diagStore.clearAll();
      scannedUris.clear();
      sidebar.refresh();
      codelens.refresh();
      statusBar.setIdle();
    })
  );

  // ── Real-time file watchers ───────────────────────────────────────────────

  // 1. Scan every file as it's opened in an editor
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (!editor) { return; }
      const doc = editor.document;
      if (!SUPPORTED_LANGS.includes(doc.languageId)) { return; }
      // Only scan if we haven't scanned this file this session
      if (scannedUris.has(doc.uri.toString())) { return; }
      await scanDocument(doc);
    })
  );

  // 2. Re-scan while typing (debounced — waits 1s after last keystroke)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const doc = event.document;
      if (!SUPPORTED_LANGS.includes(doc.languageId)) { return; }
      if (event.contentChanges.length === 0) { return; }

      const key = doc.uri.toString();
      const existing = changeTimers.get(key);
      if (existing) { clearTimeout(existing); }

      const timer = setTimeout(async () => {
        changeTimers.delete(key);
        scannedUris.delete(key); // mark stale so it rescans
        await scanDocument(doc);
      }, CHANGE_DEBOUNCE_MS);

      changeTimers.set(key, timer);
    })
  );

  // 3. Also re-scan on save (immediate, no debounce)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!SUPPORTED_LANGS.includes(doc.languageId)) { return; }
      // Cancel any pending change debounce for this file
      const key = doc.uri.toString();
      const existing = changeTimers.get(key);
      if (existing) {
        clearTimeout(existing);
        changeTimers.delete(key);
      }
      scannedUris.delete(key);
      await scanDocument(doc);
    })
  );

  // 4. Clear diagnostics when a file is deleted
  context.subscriptions.push(
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        diagStore.clearUri(uri);
        scannedUris.delete(uri.toString());
      }
      sidebar.refresh();
    })
  );

  // ── Startup: auto-scan the whole workspace ────────────────────────────────
  // Small delay to let VS Code finish initialising before we fire off requests
  setTimeout(() => startupScan(), 1500);
}

// ── Startup scan ─────────────────────────────────────────────────────────────

async function startupScan(): Promise<void> {
  const token = await auth.getToken();

  if (!token) {
    // Not logged in — show a one-time prompt
    statusBar.setLoggedOut();
    const action = await vscode.window.showInformationMessage(
      "Vulcan Security: Log in to start real-time vulnerability scanning.",
      "Login Now",
      "Later"
    );
    if (action === "Login Now") {
      const ok = await auth.login();
      if (ok) {
        await scanWorkspace();
      }
    }
    return;
  }

  await scanWorkspace();
}

// ── Workspace-wide scan ───────────────────────────────────────────────────────

async function scanWorkspace(): Promise<void> {
  if (workspaceScanRunning) { return; }
  workspaceScanRunning = true;

  const token = await auth.getToken();
  if (!token) {
    workspaceScanRunning = false;
    return;
  }

  // Find all supported files, excluding build/dependency dirs
  const exclude = "**/{node_modules,.venv,venv,__pycache__,dist,build,.git}/**";
  const [pyFiles, jsFiles] = await Promise.all([
    vscode.workspace.findFiles("**/*.py", exclude, 200),
    vscode.workspace.findFiles("**/*.{js,ts}", exclude, 200),
  ]);

  const allFiles = [...pyFiles, ...jsFiles].filter(
    (uri) => !scannedUris.has(uri.toString())
  );

  if (allFiles.length === 0) {
    workspaceScanRunning = false;
    statusBar.setIdle();
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Vulcan: Scanning workspace",
      cancellable: true,
    },
    async (progress, token_cancel) => {
      let done = 0;
      let totalVulns = 0;

      // Process in batches of MAX_CONCURRENT_SCANS
      for (let i = 0; i < allFiles.length; i += MAX_CONCURRENT_SCANS) {
        if (token_cancel.isCancellationRequested) { break; }

        const batch = allFiles.slice(i, i + MAX_CONCURRENT_SCANS);

        await Promise.all(
          batch.map(async (uri) => {
            try {
              const doc = await vscode.workspace.openTextDocument(uri);
              if (doc.lineCount > MAX_FILE_LINES) { return; } // skip huge files
              const count = await scanDocumentSilent(doc, token);
              totalVulns += count;
            } catch {
              // skip files that can't be opened
            }
          })
        );

        done += batch.length;
        const pct = Math.round((done / allFiles.length) * 100);
        progress.report({
          message: `${done}/${allFiles.length} files — ${totalVulns} issues found`,
          increment: (batch.length / allFiles.length) * 100,
        });

        // Update status bar live
        const allVulns = [...diagStore.allVulns().values()].flat();
        const crits = allVulns.filter((v) => v.severity === "CRITICAL").length;
        const highs = allVulns.filter((v) => v.severity === "HIGH").length;
        statusBar.setResults(crits, highs, allVulns.length);
        sidebar.refresh();
        codelens.refresh();
      }

      // Final summary notification
      if (totalVulns > 0) {
        const action = await vscode.window.showWarningMessage(
          `Vulcan: Found ${totalVulns} vulnerabilit${totalVulns !== 1 ? "ies" : "y"} across ${allFiles.length} files.`,
          "Show Panel"
        );
        if (action === "Show Panel") {
          vscode.commands.executeCommand("vulcan.vulnerabilities.focus");
        }
      } else {
        vscode.window.showInformationMessage(
          `Vulcan: Scanned ${allFiles.length} files — no vulnerabilities found.`
        );
      }
    }
  );

  workspaceScanRunning = false;
}

// ── Per-document scan (with status bar updates + notifications) ───────────────

async function scanDocument(doc: vscode.TextDocument): Promise<void> {
  const token = await auth.getToken();
  if (!token) {
    statusBar.setLoggedOut();
    return;
  }

  statusBar.setScanning();
  const count = await scanDocumentSilent(doc, token);
  codelens.refresh();
  sidebar.refresh();

  // Update status bar with total across all files
  const allVulns = [...diagStore.allVulns().values()].flat();
  const crits = allVulns.filter((v) => v.severity === "CRITICAL").length;
  const highs = allVulns.filter((v) => v.severity === "HIGH").length;
  statusBar.setResults(crits, highs, allVulns.length);

  if (count > 0) {
    const fname = doc.fileName.split(/[\\/]/).pop();
    const action = await vscode.window.showWarningMessage(
      `Vulcan: ${count} vulnerabilit${count !== 1 ? "ies" : "y"} in ${fname}`,
      "Show Panel"
    );
    if (action === "Show Panel") {
      vscode.commands.executeCommand("vulcan.vulnerabilities.focus");
    }
  }
}

// ── Core scan — returns vuln count, no notifications ─────────────────────────

async function scanDocumentSilent(
  doc: vscode.TextDocument,
  token: string
): Promise<number> {
  const key = doc.uri.toString();
  try {
    const lang = doc.languageId === "typescript" ? "javascript" : doc.languageId;
    const result = await api.scanFile(
      doc.getText(),
      lang,
      doc.fileName.split(/[\\/]/).pop() ?? "file",
      token
    );
    const vulns = result.vulnerabilities ?? [];
    diagStore.setVulns(doc.uri, vulns);
    scannedUris.add(key);
    return vulns.length;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) {
      await auth.clearToken();
      statusBar.setLoggedOut();
      const action = await vscode.window.showErrorMessage(
        "Vulcan: Session expired.",
        "Login"
      );
      if (action === "Login") {
        await auth.login();
      }
    }
    return 0;
  }
}

export function deactivate(): void {
  for (const timer of changeTimers.values()) {
    clearTimeout(timer);
  }
  changeTimers.clear();
}
