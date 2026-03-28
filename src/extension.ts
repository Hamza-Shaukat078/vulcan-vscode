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
const SCAN_DEBOUNCE_MS = 1500;

let sidebar: VulcanSidebarProvider;
let codelens: VulcanCodeLensProvider;
let saveDebounce: ReturnType<typeof setTimeout> | undefined;

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
      await auth.login();
      statusBar.setIdle();
    }),

    vscode.commands.registerCommand("vulcan.logout", async () => {
      await auth.logout();
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
      await scanDocument(editor.document);
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
      sidebar.refresh();
      codelens.refresh();
      statusBar.setIdle();
    })
  );

  // ── Auto-scan on save ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const scanOnSave = vscode.workspace
        .getConfiguration("vulcan")
        .get<boolean>("scanOnSave", true);
      if (!scanOnSave) {
        return;
      }
      if (!SUPPORTED_LANGS.includes(doc.languageId)) {
        return;
      }
      // Debounce rapid saves
      if (saveDebounce) {
        clearTimeout(saveDebounce);
      }
      saveDebounce = setTimeout(() => scanDocument(doc), SCAN_DEBOUNCE_MS);
    }),

    // Clear stale diagnostics when a file is closed
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagStore.clearUri(doc.uri);
      sidebar.refresh();
    })
  );

  // ── Trigger scan on the active file at startup ─────────────────────────────
  const activeDoc = vscode.window.activeTextEditor?.document;
  if (activeDoc && SUPPORTED_LANGS.includes(activeDoc.languageId)) {
    setTimeout(() => scanDocument(activeDoc), 1000);
  }
}

async function scanDocument(doc: vscode.TextDocument): Promise<void> {
  const token = await auth.getToken();
  if (!token) {
    statusBar.setLoggedOut();
    return;
  }

  statusBar.setScanning();

  try {
    const lang =
      doc.languageId === "typescript" ? "javascript" : doc.languageId;
    const result = await api.scanFile(
      doc.getText(),
      lang,
      doc.fileName.split(/[\\/]/).pop() ?? "file",
      token
    );

    const vulns = result.vulnerabilities ?? [];
    diagStore.setVulns(doc.uri, vulns);
    codelens.refresh();
    sidebar.refresh();

    const criticals = vulns.filter((v) => v.severity === "CRITICAL").length;
    const highs = vulns.filter((v) => v.severity === "HIGH").length;
    statusBar.setResults(criticals, highs, vulns.length);

    if (vulns.length > 0) {
      const msg = `Vulcan found ${vulns.length} vulnerability${
        vulns.length !== 1 ? "ies" : "y"
      } in ${doc.fileName.split(/[\\/]/).pop()}`;
      const action = await vscode.window.showWarningMessage(msg, "Show Panel");
      if (action === "Show Panel") {
        vscode.commands.executeCommand("vulcan.vulnerabilities.focus");
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    statusBar.setError(msg);
    // 401 → prompt login
    if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) {
      const action = await vscode.window.showErrorMessage(
        "Vulcan: Session expired. Please log in again.",
        "Login"
      );
      if (action === "Login") {
        await auth.login();
      }
    }
  }
}

export function deactivate(): void {
  if (saveDebounce) {
    clearTimeout(saveDebounce);
  }
}
