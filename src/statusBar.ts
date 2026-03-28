import * as vscode from "vscode";

let item: vscode.StatusBarItem;

export function init(ctx: vscode.ExtensionContext): void {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = "vulcan.scanFile";
  ctx.subscriptions.push(item);
  setIdle();
  item.show();
}

export function setIdle(): void {
  item.text = "$(shield) Vulcan";
  item.tooltip = "Click to scan current file";
  item.backgroundColor = undefined;
}

export function setScanning(): void {
  item.text = "$(sync~spin) Vulcan: Scanning…";
  item.tooltip = "Vulcan is scanning the file";
  item.backgroundColor = undefined;
}

export function setResults(criticals: number, highs: number, total: number): void {
  if (total === 0) {
    item.text = "$(shield-check) Vulcan: Clean";
    item.tooltip = "No vulnerabilities found";
    item.backgroundColor = undefined;
  } else {
    const hasCritical = criticals > 0 || highs > 0;
    item.text = `$(shield) Vulcan: ${total} issue${total !== 1 ? "s" : ""}`;
    item.tooltip = `${total} vulnerabilities — ${criticals} critical, ${highs} high`;
    item.backgroundColor = hasCritical
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : new vscode.ThemeColor("statusBarItem.warningBackground");
  }
}

export function setError(msg: string): void {
  item.text = "$(shield) Vulcan: Error";
  item.tooltip = msg;
  item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
}

export function setLoggedOut(): void {
  item.text = "$(shield) Vulcan: Not logged in";
  item.tooltip = "Click to log in";
  item.backgroundColor = undefined;
}
