import * as vscode from "vscode";
import * as api from "./api";

const TOKEN_KEY = "vulcan.jwt";

let _context: vscode.ExtensionContext;

export function init(context: vscode.ExtensionContext): void {
  _context = context;
}

export async function getToken(): Promise<string | undefined> {
  return _context.secrets.get(TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  await _context.secrets.store(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  await _context.secrets.delete(TOKEN_KEY);
}

export async function isLoggedIn(): Promise<boolean> {
  const token = await getToken();
  return !!token;
}

export async function login(): Promise<boolean> {
  const email = await vscode.window.showInputBox({
    prompt: "Vulcan — Email",
    placeHolder: "you@example.com",
    ignoreFocusOut: true,
  });
  if (!email) {
    return false;
  }

  const password = await vscode.window.showInputBox({
    prompt: "Vulcan — Password",
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) {
    return false;
  }

  try {
    const response = await api.login(email, password);
    await setToken(response.access_token);
    vscode.window.showInformationMessage("Vulcan: Logged in successfully.");
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Vulcan login failed: ${msg}`);
    return false;
  }
}

export async function logout(): Promise<void> {
  await clearToken();
  vscode.window.showInformationMessage("Vulcan: Logged out.");
}

export async function requireToken(): Promise<string | undefined> {
  let token = await getToken();
  if (!token) {
    const ok = await login();
    if (!ok) {
      return undefined;
    }
    token = await getToken();
  }
  return token;
}
