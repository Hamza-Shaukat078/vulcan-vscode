import * as vscode from "vscode";
import * as auth from "./auth";
import * as diagStore from "./diagnostics";
import { VulcanVuln } from "./types";

interface VulnGroup {
  file: string;       // display name (relative)
  fullPath: string;   // absolute path for opening
  vulns: VulcanVuln[];
}

export class VulcanWebviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "vulcan.panel";

  private _view?: vscode.WebviewView;

  // Callbacks wired by extension.ts
  private _onLogin?: (email: string, password: string) => Promise<void>;
  private _onLogout?: () => Promise<void>;
  private _onScanFile?: () => Promise<void>;
  private _onScanWorkspace?: () => Promise<void>;
  private _onGeneratePatch?: (vulnId: string) => Promise<void>;

  constructor(private readonly _ctx: vscode.ExtensionContext) {}

  // ── Wiring ────────────────────────────────────────────────────────────────
  onLogin(fn: (e: string, p: string) => Promise<void>)  { this._onLogin = fn; }
  onLogout(fn: () => Promise<void>)                      { this._onLogout = fn; }
  onScanFile(fn: () => Promise<void>)                    { this._onScanFile = fn; }
  onScanWorkspace(fn: () => Promise<void>)               { this._onScanWorkspace = fn; }
  onGeneratePatch(fn: (id: string) => Promise<void>)     { this._onGeneratePatch = fn; }

  // ── VS Code hook ─────────────────────────────────────────────────────────
  resolveWebviewView(view: vscode.WebviewView): void {
    this._view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this._buildHtml();

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          await this._pushCurrentState();
          break;
        case "login":
          await this._onLogin?.(msg.email, msg.password);
          break;
        case "logout":
          await this._onLogout?.();
          break;
        case "scanFile":
          await this._onScanFile?.();
          break;
        case "scanWorkspace":
          await this._onScanWorkspace?.();
          break;
        case "generatePatch":
          await this._onGeneratePatch?.(msg.vulnId);
          break;
        case "jumpTo":
          await this._jumpToLine(msg.file, msg.line);
          break;
        case "openSettings":
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "vulcan"
          );
          break;
      }
    }, undefined, this._ctx.subscriptions);
  }

  // ── Public API called from extension.ts ──────────────────────────────────
  post(msg: unknown): void {
    this._view?.webview.postMessage(msg);
  }

  setLoggedIn(email: string): void {
    this.post({ type: "loggedIn", email });
  }

  setLoggedOut(): void {
    this.post({ type: "loggedOut" });
  }

  setLoginError(message: string): void {
    this.post({ type: "loginError", message });
  }

  setScanStatus(text: string, progress?: number): void {
    this.post({ type: "scanStatus", text, progress });
  }

  setScanIdle(): void {
    this.post({ type: "scanIdle" });
  }

  updateVulns(): void {
    const groups = this._buildVulnGroups();
    this.post({ type: "updateVulns", groups });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private async _pushCurrentState(): Promise<void> {
    const token = await auth.getToken();
    if (token) {
      this.post({ type: "loggedIn", email: "" });
      this.updateVulns();
    } else {
      this.post({ type: "loggedOut" });
    }
  }

  private _buildVulnGroups(): VulnGroup[] {
    const groups: VulnGroup[] = [];
    for (const [uriStr, vulns] of diagStore.allVulns()) {
      if (vulns.length === 0) { continue; }
      const uri = vscode.Uri.parse(uriStr);
      const fullPath = uri.fsPath;
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      const file = ws
        ? fullPath.replace(ws, "").replace(/^[\\/]/, "")
        : fullPath.split(/[\\/]/).slice(-2).join("/");
      groups.push({ file, fullPath, vulns });
    }
    return groups;
  }

  private async _jumpToLine(fullPath: string, line: number): Promise<void> {
    try {
      const uri = vscode.Uri.file(fullPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter
      );
    } catch { /* ignore */ }
  }

  // ── HTML ──────────────────────────────────────────────────────────────────
  private _buildHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:       var(--vscode-sideBar-background, #0d1117);
    --bg2:      var(--vscode-editor-background, #161b22);
    --bg3:      rgba(255,255,255,.03);
    --border:   rgba(0,212,255,.12);
    --border2:  rgba(255,255,255,.06);
    --text:     var(--vscode-foreground, #c9d1d9);
    --muted:    var(--vscode-descriptionForeground, #8b949e);
    --accent:   #00d4ff;
    --accent2:  #0080ff;
    --crit:     #ff4757;
    --high:     #ff7f00;
    --med:      #f0c040;
    --low:      #4a9eff;
    --info:     #888;
    --success:  #22c55e;
    --btn-bg:   rgba(0,212,255,.07);
    --btn-hover:rgba(0,212,255,.16);
    --radius:   7px;
    --radius-sm:4px;
    --font:     var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
    --mono:     var(--vscode-editor-font-family, 'Cascadia Code', 'Courier New', monospace);
  }

  body {
    font-family: var(--font);
    font-size: 12px;
    color: var(--text);
    background: var(--bg);
    height: 100vh;
    overflow-x: hidden;
    user-select: none;
  }

  /* ── Screens ─────────────────────────────────────────────────────────── */
  .screen { display: none; flex-direction: column; height: 100vh; }
  .screen.active { display: flex; }

  /* ══════════════════════════════════════════
     LOGIN SCREEN
  ══════════════════════════════════════════ */
  #login {
    align-items: center;
    justify-content: center;
    padding: 28px 22px;
    gap: 0;
    background: var(--bg);
  }
  .logo-wrap { margin-bottom: 18px; }
  .logo-svg { width: 56px; height: 56px; filter: drop-shadow(0 0 12px rgba(0,212,255,.5)); }
  .brand { text-align: center; margin-bottom: 26px; }
  .brand h1 {
    font-size: 15px; font-weight: 700; letter-spacing: 3px;
    color: var(--accent); text-transform: uppercase;
  }
  .brand p { color: var(--muted); font-size: 11px; margin-top: 5px; }

  .form-group { width: 100%; margin-bottom: 12px; }
  .form-group label {
    display: block; font-size: 10px; letter-spacing: 1px;
    text-transform: uppercase; color: var(--muted); margin-bottom: 5px;
  }
  .form-group input {
    width: 100%;
    background: var(--bg2);
    border: 1px solid var(--border2);
    border-radius: var(--radius);
    color: var(--text);
    font-family: var(--font);
    font-size: 12px;
    padding: 8px 11px;
    outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  .form-group input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(0,212,255,.1);
  }

  .btn-primary {
    display: flex; align-items: center; justify-content: center; gap: 7px;
    width: 100%; padding: 9px 14px;
    border: none; border-radius: var(--radius);
    background: linear-gradient(135deg, var(--accent2), var(--accent));
    color: #000;
    font-family: var(--font);
    font-size: 12px; font-weight: 700; letter-spacing: .5px;
    cursor: pointer;
    transition: opacity .15s, transform .1s;
    text-transform: uppercase;
    margin-top: 4px;
  }
  .btn-primary:hover:not(:disabled) { opacity: .9; }
  .btn-primary:active:not(:disabled) { transform: scale(.98); }
  .btn-primary:disabled { opacity: .45; cursor: not-allowed; }

  .error-msg {
    color: var(--crit); font-size: 11px; text-align: center;
    min-height: 16px; margin-top: 8px; line-height: 1.4;
  }

  /* ══════════════════════════════════════════
     SHARED HEADER
  ══════════════════════════════════════════ */
  .panel-header {
    display: flex; align-items: center; gap: 6px;
    padding: 9px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg2);
    flex-shrink: 0;
    min-height: 40px;
  }
  .logo-sm { width: 18px; height: 18px; flex-shrink: 0; }
  .header-title {
    font-size: 11px; font-weight: 700; letter-spacing: 2px;
    color: var(--accent); text-transform: uppercase; flex: 1;
  }
  .online-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 6px var(--success);
    flex-shrink: 0;
  }
  .user-email {
    font-size: 10px; color: var(--muted); max-width: 90px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .icon-btn {
    background: none; border: none; cursor: pointer;
    color: var(--muted); font-size: 13px; padding: 3px 5px;
    border-radius: var(--radius-sm); line-height: 1;
    transition: color .12s, background .12s;
  }
  .icon-btn:hover { color: var(--text); background: var(--btn-bg); }

  .back-btn {
    display: flex; align-items: center; gap: 5px;
    background: none; border: none; cursor: pointer;
    color: var(--accent); font-size: 11px; font-weight: 600;
    padding: 3px 6px; border-radius: var(--radius-sm);
    font-family: var(--font); letter-spacing: .3px;
    transition: background .12s;
    flex-shrink: 0;
  }
  .back-btn:hover { background: var(--btn-bg); }

  /* ══════════════════════════════════════════
     DASHBOARD SCREEN
  ══════════════════════════════════════════ */
  #dashboard { overflow: hidden; }
  .dash-body { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .dash-body::-webkit-scrollbar { width: 3px; }
  .dash-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  /* Card */
  .card {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .card-header {
    font-size: 9px; font-weight: 700; letter-spacing: 2px;
    text-transform: uppercase; color: var(--muted);
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
  }
  .card-body { padding: 8px; display: flex; flex-direction: column; gap: 6px; }

  /* Scan buttons */
  .scan-btn {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 12px;
    border: 1px solid rgba(0,212,255,.2);
    border-radius: var(--radius);
    background: rgba(0,212,255,.05);
    color: var(--text);
    font-family: var(--font); font-size: 12px;
    cursor: pointer;
    transition: border-color .15s, background .15s, color .15s;
    text-align: left; width: 100%;
  }
  .scan-btn:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--btn-hover);
    color: var(--accent);
  }
  .scan-btn:active:not(:disabled) { transform: scale(.99); }
  .scan-btn:disabled { opacity: .4; cursor: not-allowed; }
  .scan-btn .icon { font-size: 16px; flex-shrink: 0; }
  .scan-btn .info { display: flex; flex-direction: column; gap: 1px; }
  .scan-btn .label { font-weight: 600; font-size: 12px; }
  .scan-btn .sub { font-size: 10px; color: var(--muted); }

  /* Progress */
  #progress-card { display: none; }
  .progress-bar-wrap {
    height: 3px; background: var(--border);
    border-radius: 2px; overflow: hidden; margin-bottom: 6px;
  }
  .progress-bar {
    height: 100%; width: 0%;
    background: linear-gradient(90deg, var(--accent2), var(--accent));
    border-radius: 2px;
    transition: width .3s ease;
  }
  .progress-text { font-size: 10px; color: var(--muted); }

  /* Stats */
  .stats-grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
  }
  .stat {
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    padding: 9px 4px;
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--bg3); cursor: pointer;
    transition: border-color .15s, background .15s;
  }
  .stat:hover { background: var(--btn-bg); }
  .stat .count { font-size: 19px; font-weight: 700; line-height: 1; font-family: var(--mono); }
  .stat .slabel { font-size: 9px; letter-spacing: .8px; text-transform: uppercase; color: var(--muted); }
  .stat.crit .count { color: var(--crit); }
  .stat.high .count { color: var(--high); }
  .stat.med  .count { color: var(--med); }
  .stat.low  .count { color: var(--low); }
  .stat.active-filter { border-color: var(--accent); background: var(--btn-bg); }

  /* Filter tabs */
  .filter-row {
    display: flex; gap: 4px; flex-wrap: wrap; padding: 2px 0;
  }
  .filter-tab {
    padding: 3px 9px; font-size: 10px; font-weight: 600;
    border: 1px solid var(--border2); border-radius: 20px;
    background: transparent; color: var(--muted);
    cursor: pointer; font-family: var(--font);
    transition: all .12s; letter-spacing: .3px;
  }
  .filter-tab:hover { border-color: var(--accent); color: var(--accent); }
  .filter-tab.active { border-color: var(--accent); color: var(--accent); background: var(--btn-bg); }
  .filter-tab.active.crit { border-color: var(--crit); color: var(--crit); background: rgba(255,71,87,.08); }
  .filter-tab.active.high { border-color: var(--high); color: var(--high); background: rgba(255,127,0,.08); }
  .filter-tab.active.med  { border-color: var(--med);  color: var(--med);  background: rgba(240,192,64,.08); }
  .filter-tab.active.low  { border-color: var(--low);  color: var(--low);  background: rgba(74,158,255,.08); }

  /* Vuln list */
  #vuln-list-card .card-header { gap: 6px; }
  .total-badge {
    background: var(--border); border-radius: 10px;
    padding: 1px 7px; font-size: 10px; color: var(--text);
  }
  .clear-btn {
    background: none; border: 1px solid var(--border2);
    color: var(--muted); font-size: 9px; padding: 2px 8px;
    border-radius: 3px; cursor: pointer; font-family: var(--font);
    margin-left: auto; transition: border-color .12s, color .12s;
  }
  .clear-btn:hover { border-color: var(--crit); color: var(--crit); }

  .vuln-empty {
    padding: 28px 16px; text-align: center; color: var(--muted);
  }
  .vuln-empty .icon { font-size: 26px; display: block; margin-bottom: 8px; }
  .vuln-empty p { font-size: 11px; line-height: 1.5; }

  .file-group { border-bottom: 1px solid var(--border); }
  .file-group:last-child { border-bottom: none; }
  .file-name {
    display: flex; align-items: center; gap: 5px;
    padding: 7px 10px 4px;
    font-size: 11px; font-weight: 600; color: var(--text);
    font-family: var(--mono);
  }
  .file-icon { color: var(--muted); }
  .file-count {
    margin-left: auto;
    font-size: 10px; color: var(--muted);
    background: var(--border); border-radius: 10px;
    padding: 1px 6px;
  }

  .vuln-item {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 10px 5px 14px;
    cursor: pointer; border-radius: var(--radius-sm);
    margin: 1px 4px; transition: background .1s;
  }
  .vuln-item:hover { background: var(--btn-bg); }
  .sev-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .sev-dot.crit { background: var(--crit); box-shadow: 0 0 5px var(--crit); }
  .sev-dot.high { background: var(--high); box-shadow: 0 0 4px rgba(255,127,0,.6); }
  .sev-dot.med  { background: var(--med); }
  .sev-dot.low  { background: var(--low); }

  .vuln-info { flex: 1; min-width: 0; }
  .vuln-type { font-size: 11px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vuln-meta { font-size: 10px; color: var(--muted); margin-top: 1px; }

  .fix-btn {
    background: none; border: 1px solid rgba(0,212,255,.25);
    color: var(--accent); font-size: 10px; padding: 3px 9px;
    border-radius: var(--radius-sm); cursor: pointer; flex-shrink: 0;
    font-family: var(--font); font-weight: 600;
    transition: background .12s, border-color .12s;
    white-space: nowrap;
  }
  .fix-btn:hover { background: var(--btn-bg); border-color: var(--accent); }

  /* ══════════════════════════════════════════
     DETAIL SCREEN
  ══════════════════════════════════════════ */
  #detail { overflow: hidden; }
  .detail-body {
    flex: 1; overflow-y: auto; padding: 12px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .detail-body::-webkit-scrollbar { width: 3px; }
  .detail-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  .detail-hero {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 12px;
    background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
  }
  .hero-dot {
    width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; margin-top: 2px;
  }
  .hero-dot.crit { background: var(--crit); box-shadow: 0 0 8px var(--crit); }
  .hero-dot.high { background: var(--high); box-shadow: 0 0 6px var(--high); }
  .hero-dot.med  { background: var(--med); }
  .hero-dot.low  { background: var(--low); }
  .hero-info { flex: 1; min-width: 0; }
  .hero-type { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 4px; }
  .sev-badge {
    display: inline-block;
    padding: 2px 8px; border-radius: 3px;
    font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
    font-family: var(--mono);
  }
  .sev-badge.crit { background: rgba(255,71,87,.15); color: var(--crit); border: 1px solid rgba(255,71,87,.3); }
  .sev-badge.high { background: rgba(255,127,0,.12); color: var(--high); border: 1px solid rgba(255,127,0,.3); }
  .sev-badge.med  { background: rgba(240,192,64,.1); color: var(--med);  border: 1px solid rgba(240,192,64,.3); }
  .sev-badge.low  { background: rgba(74,158,255,.1); color: var(--low);  border: 1px solid rgba(74,158,255,.3); }

  .detail-section {
    background: var(--bg2); border: 1px solid var(--border);
    border-radius: var(--radius); overflow: hidden;
  }
  .detail-section-title {
    font-size: 9px; font-weight: 700; letter-spacing: 2px;
    text-transform: uppercase; color: var(--muted);
    padding: 6px 10px; border-bottom: 1px solid var(--border);
  }
  .detail-rows { display: flex; flex-direction: column; }
  .detail-row {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 7px 10px; border-bottom: 1px solid var(--border);
  }
  .detail-row:last-child { border-bottom: none; }
  .detail-label {
    font-size: 10px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: .5px;
    flex-shrink: 0; width: 52px; padding-top: 1px;
  }
  .detail-value {
    font-size: 11px; color: var(--text); word-break: break-all; line-height: 1.5;
  }
  .detail-value.mono { font-family: var(--mono); font-size: 10.5px; }
  .detail-value.accent { color: var(--accent); }
  .confidence-bar-wrap {
    flex: 1; display: flex; align-items: center; gap: 8px;
  }
  .confidence-bar-track {
    flex: 1; height: 4px; background: var(--border); border-radius: 2px; overflow: hidden;
  }
  .confidence-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent2), var(--accent));
    border-radius: 2px;
    transition: width .4s ease;
  }
  .confidence-pct {
    font-size: 11px; font-weight: 700; font-family: var(--mono);
    color: var(--accent); flex-shrink: 0;
  }

  .code-block {
    margin: 0; padding: 10px 12px;
    font-family: var(--mono); font-size: 11px;
    color: var(--text); background: var(--bg);
    white-space: pre; overflow-x: auto;
    line-height: 1.5;
    max-height: 160px;
  }
  .code-block::-webkit-scrollbar { height: 3px; }
  .code-block::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  .flow-list { padding: 6px 10px; display: flex; flex-direction: column; gap: 4px; }
  .flow-step {
    display: flex; align-items: flex-start; gap: 8px;
    font-size: 10.5px; color: var(--muted); line-height: 1.4;
  }
  .flow-num {
    flex-shrink: 0; width: 16px; height: 16px;
    background: var(--border); border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 9px; font-weight: 700; color: var(--accent);
  }
  .flow-arrow {
    padding-left: 12px; color: var(--border2); font-size: 9px;
  }

  .remediation-text {
    padding: 10px 12px; font-size: 11px; color: var(--text);
    line-height: 1.6;
  }

  .detail-fix-btn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 10px 14px; width: 100%;
    border: none; border-radius: var(--radius);
    background: linear-gradient(135deg, var(--accent2), var(--accent));
    color: #000; font-family: var(--font);
    font-size: 12px; font-weight: 700; letter-spacing: .5px;
    cursor: pointer; transition: opacity .15s;
    text-transform: uppercase; flex-shrink: 0;
  }
  .detail-fix-btn:hover { opacity: .88; }

  .jump-link {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 7px; width: 100%;
    border: 1px solid var(--border); border-radius: var(--radius);
    background: transparent; color: var(--muted);
    font-family: var(--font); font-size: 11px; cursor: pointer;
    transition: border-color .15s, color .15s;
  }
  .jump-link:hover { border-color: var(--accent); color: var(--accent); }

  /* ── Shared ── */
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner {
    display: inline-block; width: 11px; height: 11px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin .7s linear infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .pulsing { animation: pulse 1.2s ease-in-out infinite; }
</style>
</head>
<body>

<!-- ══════════════════════ LOGIN SCREEN ══════════════════════ -->
<div id="login" class="screen active">
  <div class="logo-wrap">
    <svg class="logo-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="lgg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#00d4ff"/>
          <stop offset="100%" style="stop-color:#0080ff"/>
        </linearGradient>
      </defs>
      <polygon points="50,4 96,27 96,73 50,96 4,73 4,27" fill="none" stroke="url(#lgg)" stroke-width="2.5"/>
      <polygon points="50,16 84,34 84,66 50,84 16,66 16,34" fill="rgba(0,212,255,0.06)" stroke="url(#lgg)" stroke-width="1.2"/>
      <text x="50" y="64" font-family="'Segoe UI',sans-serif" font-size="38" font-weight="700" text-anchor="middle" fill="url(#lgg)">V</text>
    </svg>
  </div>
  <div class="brand">
    <h1>Vulcan Security</h1>
    <p>AI-Powered Vulnerability Detection</p>
  </div>

  <div class="form-group">
    <label>Email</label>
    <input id="email-input" type="email" placeholder="you@example.com" autocomplete="email"/>
  </div>
  <div class="form-group">
    <label>Password</label>
    <input id="pass-input" type="password" placeholder="••••••••" autocomplete="current-password"/>
  </div>

  <button class="btn-primary" id="login-btn" onclick="doLogin()">
    <span id="login-icon">⚡</span>
    <span id="login-label">Authenticate</span>
  </button>
  <div class="error-msg" id="login-error"></div>
</div>

<!-- ══════════════════════ DASHBOARD SCREEN ══════════════════════ -->
<div id="dashboard" class="screen">

  <!-- Header -->
  <div class="panel-header">
    <svg class="logo-sm" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <polygon points="50,4 96,27 96,73 50,96 4,73 4,27" fill="none" stroke="#00d4ff" stroke-width="5"/>
      <text x="50" y="67" font-family="'Segoe UI',sans-serif" font-size="48" font-weight="700" text-anchor="middle" fill="#00d4ff">V</text>
    </svg>
    <span class="header-title">Vulcan</span>
    <div class="online-dot"></div>
    <span class="user-email" id="user-email"></span>
    <button class="icon-btn" title="Refresh / Re-scan" onclick="doRescan()">↻</button>
    <button class="icon-btn" title="Settings" onclick="doSettings()">⚙</button>
    <button class="icon-btn" title="Logout" onclick="doLogout()">⏻</button>
  </div>

  <!-- Body -->
  <div class="dash-body">

    <!-- Scan Controls -->
    <div class="card">
      <div class="card-header">Scan</div>
      <div class="card-body">
        <button class="scan-btn" id="scan-file-btn" onclick="doScanFile()">
          <span class="icon">⚡</span>
          <span class="info">
            <span class="label">Scan Current File</span>
            <span class="sub">Analyse the active editor</span>
          </span>
        </button>
        <button class="scan-btn" id="scan-ws-btn" onclick="doScanWorkspace()">
          <span class="icon">🔍</span>
          <span class="info">
            <span class="label">Scan Entire Workspace</span>
            <span class="sub">All .py / .js / .ts files</span>
          </span>
        </button>
      </div>
    </div>

    <!-- Progress (hidden when idle) -->
    <div class="card" id="progress-card">
      <div class="card-body" style="padding:10px">
        <div class="progress-bar-wrap">
          <div class="progress-bar" id="progress-bar"></div>
        </div>
        <div class="progress-text pulsing" id="progress-text">Scanning…</div>
      </div>
    </div>

    <!-- Stats (clickable filters) -->
    <div class="stats-grid">
      <div class="stat crit" id="sf-CRITICAL" onclick="clickStatFilter('CRITICAL')">
        <span class="count" id="stat-crit">0</span><span class="slabel">Critical</span>
      </div>
      <div class="stat high" id="sf-HIGH" onclick="clickStatFilter('HIGH')">
        <span class="count" id="stat-high">0</span><span class="slabel">High</span>
      </div>
      <div class="stat med" id="sf-MEDIUM" onclick="clickStatFilter('MEDIUM')">
        <span class="count" id="stat-med">0</span><span class="slabel">Med</span>
      </div>
      <div class="stat low" id="sf-LOW" onclick="clickStatFilter('LOW')">
        <span class="count" id="stat-low">0</span><span class="slabel">Low</span>
      </div>
    </div>

    <!-- Vulnerabilities -->
    <div class="card" id="vuln-list-card">
      <div class="card-header">
        <span>Vulnerabilities</span>
        <span class="total-badge" id="total-badge">0</span>
        <button class="clear-btn" onclick="doClear()">Clear</button>
      </div>

      <!-- Filter tabs -->
      <div class="filter-row" style="padding:7px 10px 4px">
        <button class="filter-tab active" data-f="ALL"      onclick="setFilter('ALL')">All</button>
        <button class="filter-tab crit"   data-f="CRITICAL" onclick="setFilter('CRITICAL')">Critical</button>
        <button class="filter-tab high"   data-f="HIGH"     onclick="setFilter('HIGH')">High</button>
        <button class="filter-tab med"    data-f="MEDIUM"   onclick="setFilter('MEDIUM')">Medium</button>
        <button class="filter-tab low"    data-f="LOW"      onclick="setFilter('LOW')">Low</button>
      </div>

      <div id="vuln-list">
        <div class="vuln-empty">
          <span class="icon">🛡️</span>
          <p>Run a scan to detect vulnerabilities</p>
        </div>
      </div>
    </div>

  </div><!-- /dash-body -->
</div><!-- /dashboard -->

<!-- ══════════════════════ DETAIL SCREEN ══════════════════════ -->
<div id="detail" class="screen">

  <!-- Header with back button -->
  <div class="panel-header">
    <button class="back-btn" onclick="showDashboard()">◀ Back</button>
    <span class="header-title" id="detail-header-title" style="font-size:10px">Detail</span>
  </div>

  <!-- Body -->
  <div class="detail-body" id="detail-body">
    <!-- populated by showDetail() -->
  </div>

</div><!-- /detail -->

<script>
const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'ready' });

// ── State ──────────────────────────────────────────────────────────────────
let allGroups = [];
let activeFilter = 'ALL';
let vulnRegistry = {};   // id → { vuln, fullPath }
let currentDetailId = null;

// ── Login screen ───────────────────────────────────────────────────────────
document.getElementById('email-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('pass-input').focus();
});
document.getElementById('pass-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

function doLogin() {
  const email = document.getElementById('email-input').value.trim();
  const pass  = document.getElementById('pass-input').value;
  const err   = document.getElementById('login-error');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'Enter your email and password.'; return; }
  setLoginLoading(true);
  vscode.postMessage({ type: 'login', email, password: pass });
}

function setLoginLoading(on) {
  const btn  = document.getElementById('login-btn');
  const icon = document.getElementById('login-icon');
  const lbl  = document.getElementById('login-label');
  btn.disabled = on;
  icon.innerHTML = on ? '<span class="spinner"></span>' : '⚡';
  lbl.textContent = on ? 'Authenticating…' : 'Authenticate';
}

// ── Dashboard actions ──────────────────────────────────────────────────────
function doLogout()   { vscode.postMessage({ type: 'logout' }); }
function doSettings() { vscode.postMessage({ type: 'openSettings' }); }

function doRescan() {
  setScanningState(true, 'Rescanning workspace…', 0);
  vscode.postMessage({ type: 'scanWorkspace' });
}

function doScanFile() {
  setScanningState(true, 'Scanning current file…');
  vscode.postMessage({ type: 'scanFile' });
}

function doScanWorkspace() {
  setScanningState(true, 'Starting workspace scan…', 0);
  vscode.postMessage({ type: 'scanWorkspace' });
}

function doClear() {
  allGroups = [];
  vulnRegistry = {};
  renderVulnList();
  ['stat-crit','stat-high','stat-med','stat-low'].forEach(id =>
    document.getElementById(id).textContent = '0');
  document.getElementById('total-badge').textContent = '0';
  vscode.postMessage({ type: 'clearDiagnostics' });
}

function setScanningState(on, text, pct) {
  const pc = document.getElementById('progress-card');
  const pb = document.getElementById('progress-bar');
  const pt = document.getElementById('progress-text');
  const sf = document.getElementById('scan-file-btn');
  const sw = document.getElementById('scan-ws-btn');
  if (on) {
    pc.style.display = 'block';
    pt.textContent = text || 'Scanning…';
    if (pct !== undefined) pb.style.width = (pct * 100) + '%';
  } else {
    pc.style.display = 'none';
    sf.disabled = false; sw.disabled = false;
  }
  sf.disabled = on; sw.disabled = on;
}

// ── Filter ─────────────────────────────────────────────────────────────────
function setFilter(sev) {
  activeFilter = sev;
  document.querySelectorAll('.filter-tab').forEach(t => {
    const isActive = t.dataset.f === sev;
    t.classList.toggle('active', isActive);
  });
  // Stat box highlight
  ['CRITICAL','HIGH','MEDIUM','LOW'].forEach(s => {
    const el = document.getElementById('sf-' + s);
    if (el) el.classList.toggle('active-filter', s === sev);
  });
  renderVulnList();
}

function clickStatFilter(sev) {
  // Toggle: clicking active filter returns to ALL
  setFilter(activeFilter === sev ? 'ALL' : sev);
}

// ── Message receiver ───────────────────────────────────────────────────────
window.addEventListener('message', ({ data: msg }) => {
  switch (msg.type) {
    case 'loggedIn':
      setLoginLoading(false);
      document.getElementById('login-error').textContent = '';
      if (msg.email) document.getElementById('user-email').textContent = msg.email;
      showScreen('dashboard');
      break;

    case 'loggedOut':
      showScreen('login');
      setScanningState(false);
      allGroups = []; vulnRegistry = {};
      renderVulnList();
      break;

    case 'loginError':
      setLoginLoading(false);
      document.getElementById('login-error').textContent = msg.message;
      break;

    case 'scanStatus':
      setScanningState(true, msg.text,
        msg.progress !== undefined ? msg.progress : undefined);
      break;

    case 'scanIdle':
      setScanningState(false);
      break;

    case 'updateVulns':
      allGroups = msg.groups || [];
      updateStats();
      renderVulnList();
      break;
  }
});

// ── Screen switch ──────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showDashboard() { showScreen('dashboard'); }

// ── Stats ──────────────────────────────────────────────────────────────────
function updateStats() {
  const all = allGroups.flatMap(g => g.vulns);
  const c = s => all.filter(v => (v.severity || '').toUpperCase() === s).length;
  document.getElementById('stat-crit').textContent = c('CRITICAL');
  document.getElementById('stat-high').textContent = c('HIGH');
  document.getElementById('stat-med').textContent  = c('MEDIUM');
  document.getElementById('stat-low').textContent  = c('LOW') + c('INFO');
  document.getElementById('total-badge').textContent = all.length;
}

// ── Vuln list rendering ────────────────────────────────────────────────────
function renderVulnList() {
  const list = document.getElementById('vuln-list');

  // Rebuild registry & apply filter
  vulnRegistry = {};
  const filtered = allGroups.map(g => {
    const vulns = g.vulns.filter(v => {
      vulnRegistry[v.id] = { vuln: v, fullPath: g.fullPath };
      if (activeFilter === 'ALL') return true;
      return (v.severity || '').toUpperCase() === activeFilter;
    });
    return { ...g, vulns };
  }).filter(g => g.vulns.length > 0);

  const totalAll = allGroups.flatMap(g => g.vulns).length;

  if (totalAll === 0) {
    list.innerHTML = \`<div class="vuln-empty">
      <span class="icon">🛡️</span>
      <p>No vulnerabilities found.<br>Run a scan to check your code.</p>
    </div>\`;
    return;
  }

  if (filtered.length === 0) {
    const label = activeFilter.charAt(0) + activeFilter.slice(1).toLowerCase();
    list.innerHTML = \`<div class="vuln-empty">
      <span class="icon">✅</span>
      <p>No \${label} severity issues found.</p>
    </div>\`;
    return;
  }

  list.innerHTML = filtered.map(group => \`
    <div class="file-group">
      <div class="file-name">
        <span class="file-icon">📄</span>
        <span title="\${esc(group.fullPath)}">\${esc(group.file)}</span>
        <span class="file-count">\${group.vulns.length}</span>
      </div>
      \${group.vulns.map(v => vulnRow(v, group.fullPath)).join('')}
    </div>
  \`).join('');
}

function sevClass(sev) {
  const s = (sev || '').toUpperCase();
  if (s === 'CRITICAL') return 'crit';
  if (s === 'HIGH')     return 'high';
  if (s === 'MEDIUM')   return 'med';
  return 'low';
}

function vulnRow(v, fullPath) {
  const sc   = sevClass(v.severity);
  const label = (v.type || '').replace(/_/g, ' ');
  const line  = v.location?.line ?? v.location?.start_line ?? '';
  const cwe   = v.cwe || '';
  return \`<div class="vuln-item" onclick="showDetail('\${esc(v.id)}')"
      title="Click for details — \${esc(v.type)}\${cwe ? ' · ' + cwe : ''}">
    <span class="sev-dot \${sc}"></span>
    <span class="vuln-info">
      <div class="vuln-type">\${esc(label)}</div>
      <div class="vuln-meta">\${line ? 'Line ' + line : ''}  \${cwe ? '· ' + esc(cwe) : ''}</div>
    </span>
    <button class="fix-btn"
      onclick="event.stopPropagation(); fixVuln('\${esc(v.id)}')">⚡ Fix</button>
  </div>\`;
}

// ── Detail screen ──────────────────────────────────────────────────────────
function showDetail(id) {
  const entry = vulnRegistry[id];
  if (!entry) return;
  const { vuln: v, fullPath } = entry;
  currentDetailId = id;

  const sc    = sevClass(v.severity);
  const label = (v.type || '').replace(/_/g, ' ');
  const sev   = (v.severity || 'LOW').toUpperCase();
  const line  = v.location?.line ?? v.location?.start_line ?? '';
  const conf  = Math.round((v.confidence ?? 0) * 100);

  document.getElementById('detail-header-title').textContent = label;

  // Build detail body HTML
  const rows = [
    v.cwe   ? row('CWE',    \`<span class="detail-value accent">\${esc(v.cwe)}</span>\`) : '',
    v.owasp ? row('OWASP',  \`<span class="detail-value">\${esc(v.owasp)}</span>\`) : '',
    line    ? row('Line',   \`<span class="detail-value mono">\${line}</span>\`) : '',
    row('File', \`<span class="detail-value mono" title="\${esc(fullPath)}">\${esc(fullPath.split(/[\\\\/]/).pop() || fullPath)}</span>\`),
    row('Severity', \`<span class="sev-badge \${sc}">\${sev}</span>\`),
    conf > 0 ? row('Confidence', \`
      <div class="confidence-bar-wrap">
        <div class="confidence-bar-track">
          <div class="confidence-bar-fill" style="width:\${conf}%"></div>
        </div>
        <span class="confidence-pct">\${conf}%</span>
      </div>\`) : '',
  ].filter(Boolean).join('');

  const snippetSection = v.evidence?.code_snippet ? \`
    <div class="detail-section">
      <div class="detail-section-title">Vulnerable Code</div>
      <pre class="code-block">\${esc(v.evidence.code_snippet)}</pre>
    </div>\` : '';

  const flowPath = v.evidence?.data_flow_path ?? [];
  const flowSection = flowPath.length > 0 ? \`
    <div class="detail-section">
      <div class="detail-section-title">Data Flow Path</div>
      <div class="flow-list">
        \${flowPath.map((step, i) => \`
          <div class="flow-step">
            <span class="flow-num">\${i + 1}</span>
            <span>\${esc(step)}</span>
          </div>
        \`).join('')}
      </div>
    </div>\` : '';

  const evidenceRows = [
    v.evidence?.source ? row('Source', \`<span class="detail-value mono">\${esc(v.evidence.source)}</span>\`) : '',
    v.evidence?.sink   ? row('Sink',   \`<span class="detail-value mono">\${esc(v.evidence.sink)}</span>\`) : '',
  ].filter(Boolean).join('');
  const evidenceSection = evidenceRows ? \`
    <div class="detail-section">
      <div class="detail-section-title">Taint Analysis</div>
      <div class="detail-rows">\${evidenceRows}</div>
    </div>\` : '';

  const remediationSection = v.analysis?.remediation ? \`
    <div class="detail-section">
      <div class="detail-section-title">Remediation</div>
      <div class="remediation-text">\${esc(v.analysis.remediation)}</div>
    </div>\` : '';

  document.getElementById('detail-body').innerHTML = \`
    <div class="detail-hero">
      <span class="hero-dot \${sc}"></span>
      <div class="hero-info">
        <div class="hero-type">\${esc(label)}</div>
        <span class="sev-badge \${sc}">\${sev}</span>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Overview</div>
      <div class="detail-rows">\${rows}</div>
    </div>

    \${snippetSection}
    \${flowSection}
    \${evidenceSection}
    \${remediationSection}

    <button class="detail-fix-btn" onclick="fixFromDetail()">
      ⚡ Generate AI Fix
    </button>
    <button class="jump-link" onclick="jumpTo('\${esc(fullPath)}', \${line || 1})">
      ↗ Jump to Line \${line || '?'} in Editor
    </button>
  \`;

  showScreen('detail');
}

function row(label, valueHtml) {
  return \`<div class="detail-row">
    <span class="detail-label">\${label}</span>
    \${valueHtml}
  </div>\`;
}

function fixVuln(id)      { vscode.postMessage({ type: 'generatePatch', vulnId: id }); }
function fixFromDetail()  { if (currentDetailId) fixVuln(currentDetailId); }
function jumpTo(file, line) { vscode.postMessage({ type: 'jumpTo', file, line }); }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
</script>
</body>
</html>`;
  }
}
