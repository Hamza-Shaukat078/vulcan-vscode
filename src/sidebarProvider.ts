import * as vscode from "vscode";
import { VulcanVuln } from "./types";
import * as diagnostics from "./diagnostics";

type VulnNode = FileNode | VulnItem;

class FileNode extends vscode.TreeItem {
  readonly type = "file" as const;
  constructor(
    public readonly filePath: string,
    public readonly vulns: VulcanVuln[]
  ) {
    super(
      filePath.split(/[\\/]/).pop() ?? filePath,
      vscode.TreeItemCollapsibleState.Expanded
    );
    this.tooltip = filePath;
    this.description = `${vulns.length} issue${vulns.length !== 1 ? "s" : ""}`;
    this.iconPath = new vscode.ThemeIcon("file-code");
    this.contextValue = "vulcanFile";
  }
}

class VulnItem extends vscode.TreeItem {
  readonly type = "vuln" as const;
  constructor(public readonly vuln: VulcanVuln) {
    const label = vuln.type.replace(/_/g, " ");
    super(label, vscode.TreeItemCollapsibleState.None);

    const icon =
      vuln.severity === "CRITICAL" || vuln.severity === "HIGH"
        ? "error"
        : vuln.severity === "MEDIUM"
        ? "warning"
        : "info";
    this.iconPath = new vscode.ThemeIcon(icon);
    this.description = `Line ${vuln.location.line} · ${vuln.severity}`;
    this.tooltip = [
      `${vuln.type} — ${vuln.severity}`,
      vuln.cwe ? `CWE: ${vuln.cwe}` : "",
      vuln.owasp ? `OWASP: ${vuln.owasp}` : "",
      vuln.evidence?.sink ? `Sink: ${vuln.evidence.sink}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    this.command = {
      command: "vulcan.generatePatch",
      title: "Generate Patch",
      arguments: [vuln.id],
    };
    this.contextValue = "vulcanVuln";
  }
}

export class VulcanSidebarProvider
  implements vscode.TreeDataProvider<VulnNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: VulnNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: VulnNode): VulnNode[] {
    if (!element) {
      // Root: one FileNode per URI that has vulns
      const roots: FileNode[] = [];
      for (const [uriStr, vulns] of diagnostics.allVulns()) {
        if (vulns.length === 0) {
          continue;
        }
        const filePath = vscode.Uri.parse(uriStr).fsPath;
        roots.push(new FileNode(filePath, vulns));
      }
      return roots;
    }

    if (element instanceof FileNode) {
      return element.vulns.map((v) => new VulnItem(v));
    }

    return [];
  }
}
