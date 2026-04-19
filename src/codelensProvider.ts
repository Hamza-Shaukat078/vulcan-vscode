import * as vscode from "vscode";
import * as diagnostics from "./diagnostics";

export class VulcanCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(
    document: vscode.TextDocument
  ): vscode.CodeLens[] {
    const vulns = diagnostics.getVulnsForUri(document.uri);
    return vulns.map((v) => {
      const line = Math.max(0, (v.location.start_line ?? v.location.line ?? 1) - 1);
      const range = new vscode.Range(line, 0, line, 0);
      const severity =
        v.severity === "CRITICAL"
          ? "🔴"
          : v.severity === "HIGH"
          ? "🟠"
          : v.severity === "MEDIUM"
          ? "🟡"
          : "🔵";
      return new vscode.CodeLens(range, {
        title: `${severity} ${v.type.replace(/_/g, " ")} — ⚡ Fix with Vulcan`,
        command: "vulcan.generatePatch",
        arguments: [v.id],
        tooltip: `${v.cwe ?? ""} ${v.owasp ?? ""}`.trim(),
      });
    });
  }
}
