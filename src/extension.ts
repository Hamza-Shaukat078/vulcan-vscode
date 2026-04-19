import * as vscode from "vscode";
import * as auth from "./auth";
import * as diagStore from "./diagnostics";
import * as statusBar from "./statusBar";
import * as api from "./api";
import { VulcanHoverProvider } from "./hoverProvider";
import { VulcanCodeLensProvider } from "./codelensProvider";
import { VulcanWebviewProvider } from "./webviewProvider";
import {
  PatchContentProvider,
  contentProvider,
  generateAndShow,
} from "./patchProvider";

const SUPPORTED_LANGS = ["python", "javascript", "typescript"];
const CHANGE_DEBOUNCE_MS = 2500;
const MAX_CONCURRENT_SCANS = 3;
const MAX_FILE_LINES = 600;

let codelens: VulcanCodeLensProvider;
let webview: VulcanWebviewProvider;

const changeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const scannedUris  = new Set<string>();
let workspaceScanRunning = false;

export function activate(context: vscode.ExtensionContext): void {
  auth.init(context);
  diagStore.init(context);
  statusBar.init(context);

  codelens = new VulcanCodeLensProvider();
  webview  = new VulcanWebviewProvider(context);

  // ── Wire webview callbacks ─────────────────────────────────────────────
  webview.onLogin(async (email, password) => {
    try {
      const res = await api.login(email, password);
      await auth.setToken(res.access_token);
      webview.setLoggedIn(email);
      statusBar.setIdle();
      await scanWorkspace();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      webview.setLoginError(msg);
    }
  });

  webview.onLogout(async () => {
    await auth.logout();
    diagStore.clearAll();
    scannedUris.clear();
    codelens.refresh();
    statusBar.setLoggedOut();
    webview.setLoggedOut();
  });

  webview.onScanFile(async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !SUPPORTED_LANGS.includes(editor.document.languageId)) {
      webview.setScanStatus("Open a Python or JS file first", undefined);
      setTimeout(() => webview.setScanIdle(), 2000);
      return;
    }
    scannedUris.delete(editor.document.uri.toString());
    await scanDocument(editor.document);
    webview.setScanIdle();
  });

  webview.onScanWorkspace(async () => {
    scannedUris.clear();
    await scanWorkspace();
  });

  webview.onGeneratePatch(async (vulnId) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }
    const vulns = diagStore.getVulnsForUri(editor.document.uri);
    // Also search all files if not in current editor
    const allVulns = [...diagStore.allVulns().values()].flat();
    const found = vulns.find(v => v.id === vulnId) ?? allVulns.find(v => v.id === vulnId);
    if (!found) { return; }
    await generateAndShow(vulnId, [found, ...vulns], editor.document);
  });

  // ── Providers ────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      PatchContentProvider.scheme,
      contentProvider
    ),
    vscode.languages.registerHoverProvider(
      SUPPORTED_LANGS.map(l => ({ language: l })),
      new VulcanHoverProvider()
    ),
    vscode.languages.registerCodeLensProvider(
      SUPPORTED_LANGS.map(l => ({ language: l })),
      codelens
    ),
    vscode.window.registerWebviewViewProvider(
      VulcanWebviewProvider.viewType,
      webview,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Commands ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("vulcan.login", async () => {
      // Show the sidebar panel so the login form is visible
      vscode.commands.executeCommand("vulcan.panel.focus");
    }),

    vscode.commands.registerCommand("vulcan.logout", async () => {
      await auth.logout();
      diagStore.clearAll();
      scannedUris.clear();
      codelens.refresh();
      statusBar.setLoggedOut();
      webview.setLoggedOut();
    }),

    vscode.commands.registerCommand("vulcan.scanFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !SUPPORTED_LANGS.includes(editor.document.languageId)) { return; }
      scannedUris.delete(editor.document.uri.toString());
      await scanDocument(editor.document);
      webview.setScanIdle();
    }),

    vscode.commands.registerCommand("vulcan.scanWorkspace", async () => {
      scannedUris.clear();
      await scanWorkspace();
    }),

    vscode.commands.registerCommand("vulcan.generatePatch", async (vulnId: string) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }
      const vulns = diagStore.getVulnsForUri(editor.document.uri);
      await generateAndShow(vulnId, vulns, editor.document);
    }),

    vscode.commands.registerCommand("vulcan.clearDiagnostics", () => {
      diagStore.clearAll();
      scannedUris.clear();
      codelens.refresh();
      statusBar.setIdle();
      webview.updateVulns();
    })
  );

  // ── Real-time file watchers ───────────────────────────────────────────────
  context.subscriptions.push(
    // Scan every file as it becomes active (once per session)
    vscode.window.onDidChangeActiveTextEditor(async editor => {
      if (!editor) { return; }
      const doc = editor.document;
      if (!SUPPORTED_LANGS.includes(doc.languageId)) { return; }
      if (scannedUris.has(doc.uri.toString())) { return; }
      await scanDocument(doc);
      webview.setScanIdle();
    }),

    // Re-scan while typing (debounced)
    vscode.workspace.onDidChangeTextDocument(event => {
      const doc = event.document;
      if (!SUPPORTED_LANGS.includes(doc.languageId)) { return; }
      if (event.contentChanges.length === 0) { return; }
      const key = doc.uri.toString();
      const t = changeTimers.get(key);
      if (t) { clearTimeout(t); }
      changeTimers.set(key, setTimeout(async () => {
        changeTimers.delete(key);
        scannedUris.delete(key);
        await scanDocument(doc);
        webview.setScanIdle();
      }, CHANGE_DEBOUNCE_MS));
    }),

    // Re-scan on save (cancels pending change timer)
    vscode.workspace.onDidSaveTextDocument(async doc => {
      if (!SUPPORTED_LANGS.includes(doc.languageId)) { return; }
      const key = doc.uri.toString();
      const t = changeTimers.get(key);
      if (t) { clearTimeout(t); changeTimers.delete(key); }
      scannedUris.delete(key);
      await scanDocument(doc);
      webview.setScanIdle();
    }),

    // Clear stale diagnostics on file delete
    vscode.workspace.onDidDeleteFiles(event => {
      for (const uri of event.files) {
        diagStore.clearUri(uri);
        scannedUris.delete(uri.toString());
      }
      webview.updateVulns();
      codelens.refresh();
    })
  );

  // ── Startup ──────────────────────────────────────────────────────────────
  setTimeout(() => startupScan(), 1500);
}

// ── Startup ───────────────────────────────────────────────────────────────

async function startupScan(): Promise<void> {
  const token = await auth.getToken();
  if (!token) {
    statusBar.setLoggedOut();
    // Open the panel so the login form is immediately visible
    vscode.commands.executeCommand("vulcan.panel.focus");
    return;
  }
  await scanWorkspace();
}

// ── Workspace scan ────────────────────────────────────────────────────────

async function scanWorkspace(): Promise<void> {
  if (workspaceScanRunning) { return; }
  workspaceScanRunning = true;

  const token = await auth.getToken();
  if (!token) { workspaceScanRunning = false; return; }

  const exclude = "**/{node_modules,.venv,venv,__pycache__,dist,build,.git}/**";
  const [pyFiles, jsFiles] = await Promise.all([
    vscode.workspace.findFiles("**/*.py", exclude, 200),
    vscode.workspace.findFiles("**/*.{js,ts}", exclude, 200),
  ]);

  const allFiles = [...pyFiles, ...jsFiles].filter(
    uri => !scannedUris.has(uri.toString())
  );

  if (allFiles.length === 0) {
    workspaceScanRunning = false;
    statusBar.setIdle();
    webview.setScanIdle();
    return;
  }

  let done = 0;
  let totalVulns = 0;

  for (let i = 0; i < allFiles.length; i += MAX_CONCURRENT_SCANS) {
    const batch = allFiles.slice(i, i + MAX_CONCURRENT_SCANS);
    await Promise.all(batch.map(async uri => {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (doc.lineCount > MAX_FILE_LINES) { return; }
        totalVulns += await scanDocumentSilent(doc, token);
      } catch { /* skip */ }
    }));

    done += batch.length;
    const pct = done / allFiles.length;
    const name = allFiles[Math.min(i, allFiles.length - 1)].fsPath.split(/[\\/]/).pop();
    webview.setScanStatus(
      `${done}/${allFiles.length} files — ${totalVulns} issue${totalVulns !== 1 ? "s" : ""} found`,
      pct
    );
    statusBar.setScanning();
    webview.updateVulns();
    codelens.refresh();
  }

  workspaceScanRunning = false;
  webview.setScanIdle();
  webview.updateVulns();
  codelens.refresh();

  const allVulns = [...diagStore.allVulns().values()].flat();
  const crits = allVulns.filter(v => v.severity === "CRITICAL").length;
  const highs = allVulns.filter(v => v.severity === "HIGH").length;
  statusBar.setResults(crits, highs, allVulns.length);

  if (totalVulns > 0) {
    vscode.window.showWarningMessage(
      `Vulcan: ${totalVulns} vulnerabilit${totalVulns !== 1 ? "ies" : "y"} found across workspace.`,
      "Show Panel"
    ).then(a => { if (a === "Show Panel") vscode.commands.executeCommand("vulcan.panel.focus"); });
  }
}

// ── Per-document scan ─────────────────────────────────────────────────────

async function scanDocument(doc: vscode.TextDocument): Promise<void> {
  const token = await auth.getToken();
  if (!token) { statusBar.setLoggedOut(); return; }

  const fname = doc.fileName.split(/[\\/]/).pop() ?? "file";
  statusBar.setScanning();
  webview.setScanStatus(`Scanning ${fname}…`);

  await scanDocumentSilent(doc, token);

  codelens.refresh();
  webview.updateVulns();

  const allVulns = [...diagStore.allVulns().values()].flat();
  const crits = allVulns.filter(v => v.severity === "CRITICAL").length;
  const highs = allVulns.filter(v => v.severity === "HIGH").length;
  statusBar.setResults(crits, highs, allVulns.length);
}

// ── Core scan (no UI side-effects) ────────────────────────────────────────

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
    const vulns = (result.vulnerabilities ?? []).filter(v => (v.confidence ?? 0) >= 0.5);
    diagStore.setVulns(doc.uri, vulns);
    scannedUris.add(key);
    return vulns.length;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) {
      await auth.clearToken();
      statusBar.setLoggedOut();
      webview.setLoggedOut();
    }
    return 0;
  }
}

export function deactivate(): void {
  for (const t of changeTimers.values()) { clearTimeout(t); }
  changeTimers.clear();
}
