import * as vscode from "vscode";
import * as api from "./api";
import * as auth from "./auth";
import { VulcanVuln, PatchResult } from "./types";

// In-memory store: vulnId → latest patch result
const patchCache = new Map<string, PatchResult>();

// Virtual document provider so we can show patched content in the diff viewer
export class PatchContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "vulcan-patch";
  private contents = new Map<string, string>();

  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
}

export const contentProvider = new PatchContentProvider();

// Apply a unified diff to source text — minimal line-by-line parser
function applyUnifiedDiff(original: string, diff: string): string {
  const originalLines = original.split("\n");
  const result = [...originalLines];
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  const diffLines = diff.split("\n");
  let i = 0;
  // Skip file headers
  while (i < diffLines.length && (diffLines[i].startsWith("---") || diffLines[i].startsWith("+++"))) {
    i++;
  }

  const edits: Array<{ start: number; deleteCount: number; insert: string[] }> = [];

  while (i < diffLines.length) {
    const match = hunkRe.exec(diffLines[i]);
    if (!match) {
      i++;
      continue;
    }
    const oldStart = parseInt(match[1], 10) - 1; // 0-based
    const oldCount = parseInt(match[2] ?? "1", 10);
    i++;

    const removed: string[] = [];
    const added: string[] = [];

    while (i < diffLines.length && !diffLines[i].startsWith("@@")) {
      const line = diffLines[i];
      if (line.startsWith("-")) {
        removed.push(line.slice(1));
      } else if (line.startsWith("+")) {
        added.push(line.slice(1));
      }
      i++;
    }

    edits.push({ start: oldStart, deleteCount: oldCount, insert: added });
  }

  // Apply edits in reverse order to preserve line offsets
  for (const edit of edits.reverse()) {
    result.splice(edit.start, edit.deleteCount, ...edit.insert);
  }

  return result.join("\n");
}

export async function generateAndShow(
  vulnId: string,
  vulnsForFile: VulcanVuln[],
  document: vscode.TextDocument
): Promise<void> {
  let token = await auth.requireToken();
  if (!token) {
    return;
  }

  const vuln = vulnsForFile.find((v) => v.id === vulnId);
  if (!vuln) {
    vscode.window.showErrorMessage(`Vulcan: Vulnerability ${vulnId} not found.`);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Vulcan: Generating patch for ${vuln.type.replace(/_/g, " ")}…`,
      cancellable: false,
    },
    async () => {
      try {
        const patch = await api.generatePatch(vuln, token!);
        patchCache.set(vulnId, patch);

        // Build patched content
        const originalText = document.getText();
        const patchedText = applyUnifiedDiff(originalText, patch.unified_diff);

        // Register virtual URIs for the diff viewer
        const originalUri = document.uri;
        const patchedUri = vscode.Uri.parse(
          `${PatchContentProvider.scheme}:${document.uri.path}?patch=${patch.patch_id}`
        );
        contentProvider.set(patchedUri, patchedText);

        // Show diff
        await vscode.commands.executeCommand(
          "vscode.diff",
          originalUri,
          patchedUri,
          `Vulcan Patch — ${vuln.type} (${Math.round(patch.confidence * 100)}% confidence)`
        );

        // Action buttons
        const action = await vscode.window.showInformationMessage(
          `Patch generated — ${patch.score_breakdown.label} confidence (${Math.round(
            patch.confidence * 100
          )}%). ${patch.explanation}`,
          "Apply",
          "Approve",
          "Reject",
          "Dismiss"
        );

        if (action === "Apply") {
          await applyPatch(patch, document);
        } else if (action === "Approve") {
          await approvePatch(patch.patch_id, token);
        } else if (action === "Reject") {
          await rejectPatch(patch.patch_id, token);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);

        // Token expired or invalidated — clear it and prompt re-login
        if (msg.includes("401") || msg.toLowerCase().includes("invalid token") || msg.toLowerCase().includes("not authenticated")) {
          await auth.clearToken();
          const action = await vscode.window.showErrorMessage(
            "Vulcan: Session expired. Please log in again.",
            "Login"
          );
          if (action === "Login") {
            vscode.commands.executeCommand("vulcan.panel.focus");
          }
          return;
        }

        // Role/permission error
        if (msg.includes("403") || msg.toLowerCase().includes("not authorized") || msg.toLowerCase().includes("forbidden")) {
          vscode.window.showErrorMessage(
            "Vulcan: Your account does not have permission to generate patches. Contact your admin."
          );
          return;
        }

        vscode.window.showErrorMessage(`Vulcan patch generation failed: ${msg}`);
      }
    }
  );
}

async function applyPatch(
  patch: PatchResult,
  document: vscode.TextDocument
): Promise<void> {
  const originalText = document.getText();
  const patchedText = applyUnifiedDiff(originalText, patch.unified_diff);

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(originalText.length)
  );
  edit.replace(document.uri, fullRange, patchedText);
  const ok = await vscode.workspace.applyEdit(edit);
  if (ok) {
    vscode.window.showInformationMessage(
      "Vulcan: Patch applied. Save the file to persist the changes."
    );
  } else {
    vscode.window.showErrorMessage("Vulcan: Failed to apply patch.");
  }
}

async function approvePatch(patchId: string, token: string): Promise<void> {
  try {
    await api.approvePatch(patchId, token);
    vscode.window.showInformationMessage("Vulcan: Patch approved.");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Vulcan approve failed: ${msg}`);
  }
}

async function rejectPatch(patchId: string, token: string): Promise<void> {
  try {
    await api.rejectPatch(patchId, token);
    vscode.window.showInformationMessage("Vulcan: Patch rejected.");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Vulcan reject failed: ${msg}`);
  }
}
