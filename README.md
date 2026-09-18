# Claude Maia

Extensão do VS Code (uso pessoal) que junta o que falta na "Claude Code for VS Code" da Anthropic:

- **Sessões**: lista plana das sessões do Claude Code (de `~/.claude/projects`) no Explorer. Clique abre a sessão no chat da extensão oficial (ou foca, se já estiver aberta). Bolinha verde nas sessões abertas (terminal ou chat da IDE; pulsa enquanto responde), sessão em foco fica selecionada, renomear e apagar no hover. Fork de [vscode-claude-sessions](https://github.com/ShahadIshraq/claude-session-vs-code-extension).
- **Uso do plano na barra inferior**: `5h 32%/40% (2h51m) | 7d 46%/57% (3h11m)`, igual à status line do terminal (usado/cota do tempo já passado, tempo pra resetar; verde abaixo da cota, amarelo acima). Token do Claude Code no Keychain do macOS + endpoint `/api/oauth/usage`.
- **Patches automáticos na extensão oficial** (`~/.vscode/extensions/anthropic.claude-code-*/`), reaplicados ao ativar, de hora em hora e quando ela atualiza; cada um desligável nas configurações (`claudeMaia.patch.*`):
  1. navegador (Claude in Chrome) liga sozinho, sem `@browser`, quando a mensagem fala de site, chrome, página, url, login, print ou uma das ferramentas (utmify, pagarfy, trackfy...); não conecta em conversa que não precisa (conectar abre o Chrome);
  2. `Ctx 36% (363k/1000k)` sempre visível no rodapé do chat, cores da status line (200k amarelo, 400k vermelho);
  3. esconde a barra lateral "Session Manager" da extensão oficial (a lista fica aqui).
     Original guardado em `<arquivo>.orig`; comandos "Claude Maia: reaplicar patches" e "restaurar a extensão original". Se a versão nova mudar o código e um patch não encaixar, avisa em vez de quebrar.

**Instalar**: baixe o `.vsix` da [última release](https://github.com/lucasahimself21/claude-maia/releases/latest) e rode `code --install-extension claude-maia-<versão>.vsix` (ou, no VS Code, Extensions → `...` → Install from VSIX). Precisa da extensão oficial [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) instalada e logada. macOS (o uso do plano lê o token no Keychain).

**Atualizar**: a extensão confere o GitHub Releases ao abrir, sempre que a view "Claude Maia" aparece (no máximo 1 vez a cada 2 min) e a cada 6 h; quando tem versão nova aparece o botão de download no título da view "Claude Maia" (e um aviso). Clicou, baixa e instala sozinha; só recarregar a janela. Comando manual: "Claude Maia: procurar atualização".

**Desenvolver**: `npm install && npm run compile && npx @vscode/vsce package`. Publicar: `gh release create v<versão> claude-maia-<versão>.vsix --title v<versão> --notes "..."`.

---

## What It Provides

- `Claude Sessions` view in Explorer.
- `Claude Sessions` Activity Bar icon with a dedicated sidebar view.
- Lists sessions for the currently opened workspace folder(s), sourced from `~/.claude/projects`.
- Session row title + always-visible last-used token (for example `2d ago`).
- Per-session prompt list: one tree entry per user prompt in that session.
- `Open Prompt Preview` for any prompt entry (opens full prompt in a read-only virtual tab).
- `Open Claude Session` action (green terminal icon) to run:
  - `claude --resume <sessionId>`
- `Open Session (Skip Permissions)` action (red terminal icon) to run:
  - `claude --dangerously-skip-permissions --resume <sessionId>`
  - protected by a confirmation modal (configurable via `claudeSessions.confirmDangerousSkipPermissions`)
- `Rename Session` action (edit icon): give any session a custom title.
  - Right-click a session and choose `Rename Session`, or use the edit icon on hover.
  - The custom title is stored inside the transcript file as a `custom-title` record.
  - Renaming preserves the session's original timestamp, so it stays in its sorted position.
- `Delete Session` action: permanently remove a session transcript and all associated data.
  - Right-click a session and choose `Delete Session`.
  - Keyboard shortcut: `Delete` (Windows/Linux) or `Cmd+Backspace` (Mac) when a session is focused.
- `Selection Mode` for bulk operations:
  - Toggle via the checklist icon in the view title bar.
  - Checkboxes appear on all sessions — check the ones you want to act on.
  - A trash icon appears once any session is checked; click it to delete all checked sessions.
  - Selection mode is automatically cleared after deletion or refresh.
- `Search Sessions` command: filter sessions by keyword across all prompt content.
  - Active filter is shown as a tree node with a hover X to clear it.
  - The search icon is hidden while a filter is active to reduce clutter.
- `Clear Filter` command: reset the search filter and show all sessions.
- `Refresh Claude Sessions` command.
  - Re-runs the active search filter against fresh data if one is set.
  - Clears selection mode.
- `Focus Claude Sessions View` command.

## Configuration

| Setting                                          | Type      | Default | Description                                                                                 |
| ------------------------------------------------ | --------- | ------- | ------------------------------------------------------------------------------------------- |
| `claudeSessions.confirmDangerousSkipPermissions` | `boolean` | `true`  | Show a confirmation modal before launching a session with `--dangerously-skip-permissions`. |

## Usage

### Session list with prompt history

Browse all Claude Code sessions for your workspace, each expandable to show individual prompts.

![Session list with prompt history](media/project-session-list.jpg)

### Resume or open a session

Hover a session to reveal actions: resume in a terminal (green icon) or resume with `--dangerously-skip-permissions` (red icon).

![Open Claude Session](media/open-session.jpg)

### Session details with inline actions

Expand a session to see prompts and timestamps. Click the green or red terminal icons to resume.

![Session detail view](media/project-session-view.jpg)

### Rename a session

Right-click a session and select `Rename Session` to give it a custom title. The new title replaces the auto-generated one in the tree view. Renaming preserves the session's original timestamp so it stays in its sorted position.

### Delete sessions

Right-click a session and select `Delete Session` to permanently remove it and all associated data (subagents, environment snapshots, file history, debug logs, and tasks). You can also use `Delete` / `Cmd+Backspace` when a session is focused.

For bulk deletion, click the checklist icon in the title bar to enter selection mode. Checkboxes appear on every session — check the ones you want to remove, then click the trash icon. A confirmation dialog shows how many sessions will be deleted.

### Search sessions

Use the search icon in the view title bar to filter sessions by keyword. Matching sessions are shown in the tree with a `Filter: "<query>"` banner. Clear the filter to restore the full list.

![Search sessions](media/search-view.jpg)

### Prompt preview

Click a prompt entry to open its full content in a read-only editor tab.

![Prompt preview](media/prompt-wide-view.jpg)

## Requirements

- VS Code desktop.
- Node.js 20+.
- Claude Code CLI installed and available on PATH as `claude`.
- Local Claude history at `~/.claude/projects`.

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Build once:

```bash
npm run compile
```

3. (Optional) watch mode while editing:

```bash
npm run watch
```

4. Open this folder in VS Code and press `F5` to launch the Extension Development Host.

5. In the Extension Host window:

- Open the `Claude Sessions` icon in the Activity Bar, or
- Run `Focus Claude Sessions View` from Command Palette.

## Install

### From Marketplace

Search for **Claude Sessions Explorer** in the VS Code Extensions view, or install from the command line:

```bash
code --install-extension ShahadIshraq.vscode-claude-sessions
```

Also available on [Open VSX](https://open-vsx.org/extension/ShahadIshraq/vscode-claude-sessions) for compatible editors.

### From GitHub Releases

Download the latest `.vsix` from [GitHub Releases](https://github.com/ShahadIshraq/claude-session-vs-code-extension/releases), then:

1. Open Command Palette (`Cmd+Shift+P`).
2. Run `Extensions: Install from VSIX...`.
3. Select the downloaded `.vsix` file.
4. Reload when prompted.

## Build + Install From Source

### Package as VSIX

From the project root:

```bash
npx @vscode/vsce package
```

This creates a `.vsix` file such as:

- `vscode-claude-sessions-x.y.z.vsix`

### Install VSIX

In VS Code:

1. Open Command Palette.
2. Run `Extensions: Install from VSIX...`.
3. Select the generated `.vsix` file.
4. Reload when prompted.

## Useful Commands

- `npm run compile`
- `npm run lint`
- `npm run test`

## Notes

- Prompt previews open in a WebviewPanel, so closing them does not create file delete/save prompts.
- Session prompt list filters out command-wrapper/system-noise entries (for example command metadata wrappers).
