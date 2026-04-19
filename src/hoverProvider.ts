import * as vscode from "vscode";
import * as diagnostics from "./diagnostics";

export class VulcanHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const vuln = diagnostics.getVulnAt(document.uri, position);
    if (!vuln) {
      return undefined;
    }

    const severityIcon =
      vuln.severity === "CRITICAL" || vuln.severity === "HIGH"
        ? "$(error)"
        : vuln.severity === "MEDIUM"
        ? "$(warning)"
        : "$(info)";

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = true;

    md.appendMarkdown(
      `### ${severityIcon} Vulcan — ${vuln.type.replace(/_/g, " ")}\n\n`
    );
    md.appendMarkdown(`**Severity:** \`${vuln.severity}\`  \n`);
    md.appendMarkdown(
      `**Confidence:** ${Math.round(vuln.confidence * 100)}%  \n`
    );
    if (vuln.cwe) {
      md.appendMarkdown(`**CWE:** ${vuln.cwe}  \n`);
    }
    if (vuln.owasp) {
      md.appendMarkdown(`**OWASP:** ${vuln.owasp}  \n`);
    }
    if (vuln.evidence?.source) {
      md.appendMarkdown(`**Source:** \`${vuln.evidence.source}\`  \n`);
    }
    if (vuln.evidence?.sink) {
      md.appendMarkdown(`**Sink:** \`${vuln.evidence.sink}\`  \n`);
    }
    if (vuln.evidence?.dataflow) {
      md.appendMarkdown(`**Data flow:** \`${vuln.evidence.dataflow}\`  \n`);
    }
    const remediation = vuln.analysis?.llm_classification?.remediation ?? vuln.analysis?.remediation;
    if (remediation) {
      md.appendMarkdown(`\n**Remediation:** ${remediation}  \n`);
    }

    // "Fix with Vulcan" inline command link
    const cmdUri = vscode.Uri.parse(
      `command:vulcan.generatePatch?${encodeURIComponent(
        JSON.stringify([vuln.id])
      )}`
    );
    md.appendMarkdown(`\n\n[⚡ Fix with Vulcan](${cmdUri})`);

    return new vscode.Hover(md);
  }
}
