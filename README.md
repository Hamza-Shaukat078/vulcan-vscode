# Vulcan Security — VS Code Extension

Real-time vulnerability detection and AI-powered patch generation for Python and JavaScript/TypeScript, built on top of the [Vulcan backend](https://github.com/Hamza-Shaukat078/vulcan-backend).

---

## Features

| Feature | Description |
|---|---|
| **Live scanning** | Files are scanned automatically when opened, saved, or edited (1-second debounce) |
| **Workspace scan** | Scans all `.py`, `.js`, and `.ts` files in the workspace in parallel batches |
| **Inline diagnostics** | Vulnerabilities appear as red/yellow squiggles directly in the editor |
| **Sidebar panel** | Dedicated activity-bar panel showing stats, filters, and a grouped vulnerability list |
| **Vulnerability detail view** | Click any vulnerability to see CWE, OWASP, code snippet, data-flow path, taint source/sink, confidence score, and remediation hint |
| **AI patch generation** | Click **⚡ Fix** on any vulnerability to generate a unified diff patch via the backend LLM |
| **Patch viewer** | Generated patches open in a read-only diff view inside VS Code |
| **Severity filters** | Filter the list by Critical / High / Medium / Low with one click |
| **Jump to line** | Click any vulnerability or use the "Jump to Editor" button to navigate directly to the vulnerable line |
| **Hover tooltips** | Hover over any flagged line to see the vulnerability type, CWE, and evidence |
| **Code Lens** | Inline "⚡ Fix" actions appear above every flagged line |
| **Status bar** | Bottom-left indicator shows total issue count and live scanning state |

---

## Requirements

- **VS Code** 1.85 or newer
- **Vulcan backend** running locally (see [vulcan-backend](https://github.com/Hamza-Shaukat078/vulcan-backend))
- A Vulcan user account (register via the backend API or admin panel)

---

## Running the Extension (Development)

### 1 — Start the backend

```bash
# From the vulcan-backend directory
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

The backend must be reachable at `http://localhost:8000` (default).

### 2 — Install extension dependencies

```bash
cd vulcan-vscode
npm install
```

### 3 — Compile TypeScript

```bash
npm run compile
# or watch mode (recompiles on every save):
npm run watch
```

### 4 — Launch in Extension Development Host

1. Open the `vulcan-vscode` folder in VS Code
2. Press **F5**
3. A new **Extension Development Host** window opens
4. The Vulcan icon appears in the activity bar on the left

> If F5 shows a debugger picker instead of launching, make sure `.vscode/launch.json` exists (see below).

### 5 — Log in

1. Click the **Vulcan** shield icon in the activity bar
2. Enter your email and password in the login form
3. The extension scans your workspace automatically after login

---

## Required `.vscode/launch.json`

If the extension does not launch with F5, create this file inside `vulcan-vscode/.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "preLaunchTask": "npm: compile",
      "outFiles": ["${workspaceFolder}/out/**/*.js"]
    }
  ]
}
```

---

## Extension Settings

Open **File → Preferences → Settings** and search for `Vulcan`:

| Setting | Default | Description |
|---|---|---|
| `vulcan.backendUrl` | `http://localhost:8000` | Base URL of the Vulcan backend |
| `vulcan.scanOnSave` | `true` | Re-scan the file every time it is saved |
| `vulcan.enableLLM` | `true` | Use LLM classification during scans (more accurate, slightly slower) |

---

## Commands

Access these from the **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---|---|
| `Vulcan: Login` | Open the Vulcan sidebar panel |
| `Vulcan: Logout` | Log out and clear all diagnostics |
| `Vulcan: Scan Current File` | Force-scan the active editor file |
| `Vulcan: Scan Entire Workspace` | Scan all Python and JS/TS files in the workspace |
| `Vulcan: Generate Patch` | Generate an AI fix for a specific vulnerability |
| `Vulcan: Clear All Diagnostics` | Remove all squiggles and reset the panel |

---

## Sidebar Panel Walkthrough

```
┌─────────────────────────────────┐
│  V  VULCAN          • user@x  ↻ ⚙ ⏻  │  ← header (refresh / settings / logout)
├─────────────────────────────────┤
│  SCAN                           │
│  ⚡ Scan Current File           │  ← scans the active editor
│  🔍 Scan Entire Workspace       │  ← scans all .py/.js/.ts
├─────────────────────────────────┤
│  ████████░░░░░  8/12 files…    │  ← progress bar (visible during scan)
├─────────────────────────────────┤
│  11        41       17      0  │
│  Critical  High     Med    Low │  ← click to filter list
├─────────────────────────────────┤
│  VULNERABILITIES          42  Clear │
│  [All] [Critical] [High] [Med] [Low]│  ← filter tabs
│                                 │
│  📄 app.py                    7 │
│  ● SQL Injection    Line 14   ⚡ Fix │
│  ● Path Traversal   Line 27   ⚡ Fix │
│  ...                            │
└─────────────────────────────────┘
```

Clicking any row opens the **Detail View**:

```
┌─────────────────────────────────┐
│  ◀ Back          SQL INJECTION  │  ← back button returns to list
├─────────────────────────────────┤
│  ● SQL Injection   [HIGH]       │
│                                 │
│  OVERVIEW                       │
│  CWE     CWE-89                 │
│  OWASP   A03:2021               │
│  Line    14                     │
│  File    app.py                 │
│  Confidence  ████████░░  82%   │
│                                 │
│  VULNERABLE CODE                │
│  query = "SELECT * FROM …"     │
│                                 │
│  DATA FLOW PATH                 │
│  1 → req.args['id']             │
│  2 → query string concat        │
│  3 → db.execute(query)          │
│                                 │
│  TAINT ANALYSIS                 │
│  Source  req.args['id']         │
│  Sink    db.execute             │
│                                 │
│  ⚡ Generate AI Fix             │
│  ↗ Jump to Line 14 in Editor   │
└─────────────────────────────────┘
```

---

## Packaging (`.vsix`)

To produce an installable `.vsix` file:

```bash
npm install -g @vscode/vsce
npm run compile
vsce package
```

This generates `vulcan-security-0.1.0.vsix`. Install it in any VS Code instance:

```
Extensions panel → ⋯ → Install from VSIX…
```

---

## Project Structure

```
vulcan-vscode/
├── src/
│   ├── extension.ts          # Activation, commands, file watchers
│   ├── webviewProvider.ts    # Sidebar panel (HTML/CSS/JS)
│   ├── api.ts                # HTTP client for the Vulcan backend
│   ├── auth.ts               # JWT storage via VS Code SecretStorage
│   ├── diagnostics.ts        # DiagnosticCollection + vuln store
│   ├── hoverProvider.ts      # Hover tooltips on flagged lines
│   ├── codelensProvider.ts   # Inline "Fix" code lens actions
│   ├── patchProvider.ts      # Patch viewer (virtual document)
│   ├── statusBar.ts          # Bottom-left status bar item
│   └── types.ts              # Shared TypeScript interfaces
├── media/
│   └── vulcan-icon.svg       # Activity bar icon
├── out/                      # Compiled JS (generated by tsc)
├── package.json              # Extension manifest
└── tsconfig.json
```

---

## Backend API Endpoints Used

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/auth/login` | POST | Authenticate and receive JWT |
| `/api/v1/scan` | POST | Scan a file for vulnerabilities |
| `/api/v1/patches/generate` | POST | Generate an AI patch for a vulnerability |
| `/api/v1/patches/{id}/validate` | POST | Validate a generated patch |
| `/api/v1/patches/{id}/approve` | POST | Approve a patch |
| `/api/v1/patches/{id}/export` | GET | Export patch as unified diff |

---

## Supported Languages

- Python (`.py`)
- JavaScript (`.js`)
- TypeScript (`.ts`)

---

## License

MIT
