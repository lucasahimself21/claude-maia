import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ClaudeSessionDiscoveryService } from "./discovery";
import { markShellClosed, readLiveSessions, shellPidOf, SESSIONS_DIR } from "./liveSessions";
import { setupAutoPatch } from "./patcher";
import { setupUsageBar } from "./usageBar";
import { ClaudeTerminalService } from "./terminal";
import { SessionTreeStateManager, SessionTreeViewProvider } from "./webview";
import { SessionNode, SessionPromptNode } from "./models";
import { registerSearchCommands } from "./search/searchCommand";
import { truncateForTreeLabel } from "./utils/formatting";
import { confirmAndDeleteSessions, confirmDangerousLaunch } from "./utils/sessionActions";
import { buildSessionViewHtml } from "./sessionViewHtml";
import { md, htmlDocument, renderMessageBlock, escapeHtml, formatTimestamp } from "./viewHtml";
export { escapeHtml } from "./viewHtml";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const currentVersion = (
    vscode.extensions.getExtension("maia.claude-maia")?.packageJSON as { version?: string } | undefined
  )?.version as string | undefined;
  const previousVersion = context.globalState.get<string>("extensionVersion");
  if (previousVersion && currentVersion && previousVersion !== currentVersion) {
    void vscode.window
      .showInformationMessage(
        `Claude Maia atualizada pra v${currentVersion}. Please reload the window for changes to take effect.`,
        "Reload Window"
      )
      .then((choice) => {
        if (choice === "Reload Window") {
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
  }
  if (currentVersion) {
    void context.globalState.update("extensionVersion", currentVersion);
  }

  const outputChannel = vscode.window.createOutputChannel("Claude Maia");
  setupAutoPatch(context, (msg) => outputChannel.appendLine(msg));
  setupUsageBar(context);
  const discovery = new ClaudeSessionDiscoveryService(outputChannel);
  const terminalService = new ClaudeTerminalService(outputChannel);
  const stateManager = new SessionTreeStateManager(discovery);
  outputChannel.appendLine("[lifecycle] Claude Maia activated.");
  outputChannel.appendLine(`[lifecycle] workspaceFolders=${String(vscode.workspace.workspaceFolders?.length ?? 0)}`);

  context.subscriptions.push(outputChannel);

  let hasRefreshed = false;
  const lazyRefresh = async () => {
    if (!hasRefreshed) {
      hasRefreshed = true;
      await stateManager.refresh();
    }
  };

  // Prompt preview panels
  const promptPanels = new Map<string, vscode.WebviewPanel>();

  const openPromptPreview = (node: SessionPromptNode) => {
    const uniqueId = `${node.sessionId}-${node.promptId}`;
    const existing = promptPanels.get(uniqueId);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const tabTitle = truncateForTreeLabel(node.promptTitle, 35);
    const panel = vscode.window.createWebviewPanel(
      "claudeSessionsPromptPreview",
      tabTitle,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: false }
    );

    panel.webview.html = buildPromptPreviewHtml(node);
    promptPanels.set(uniqueId, panel);
    panel.onDidDispose(() => promptPanels.delete(uniqueId));
  };

  // Session view panels (read-only full conversation)
  const sessionViewPanels = new Map<string, vscode.WebviewPanel>();
  const sessionViewInFlight = new Set<string>();

  const openSessionView = async (session: SessionNode) => {
    const existing = sessionViewPanels.get(session.sessionId);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Beside);
      return;
    }
    if (sessionViewInFlight.has(session.sessionId)) {
      return;
    }
    sessionViewInFlight.add(session.sessionId);

    try {
      const prompts = await discovery.getUserPrompts(session);

      const tabTitle = truncateForTreeLabel(session.title, 35);
      const panel = vscode.window.createWebviewPanel(
        "claudeSessionsView",
        tabTitle,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: false }
      );

      panel.webview.html = buildSessionViewHtml(session, prompts);
      sessionViewPanels.set(session.sessionId, panel);
      panel.onDidDispose(() => sessionViewPanels.delete(session.sessionId));
    } catch (err) {
      outputChannel.appendLine(`[viewSession] Failed to open session ${session.sessionId}: ${String(err)}`);
      void vscode.window.showErrorMessage(`Failed to open session: ${String(err)}`);
    } finally {
      sessionViewInFlight.delete(session.sessionId);
    }
  };

  // Create two webview providers sharing the same state
  const explorerProvider = new SessionTreeViewProvider(
    context.extensionUri,
    stateManager,
    terminalService,
    discovery,
    outputChannel,
    openPromptPreview,
    openSessionView
  );

  const sidebarProvider = new SessionTreeViewProvider(
    context.extensionUri,
    stateManager,
    terminalService,
    discovery,
    outputChannel,
    openPromptPreview,
    openSessionView
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("claudeSessionsExplorer", explorerProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("claudeSessionsSidebarView", sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Register search commands
  registerSearchCommands(
    context,
    () => {
      explorerProvider.postFocusSearch();
      sidebarProvider.postFocusSearch();
    },
    () => {
      stateManager.setFilter(undefined, undefined);
      vscode.commands.executeCommand("setContext", "claudeSessions.filterActive", false);
    }
  );

  // Lazy refresh on activation
  lazyRefresh();

  // Refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessions.refresh", async () => {
      hasRefreshed = true;
      await stateManager.refresh();

      // Re-run filter against fresh data if one is active
      const activeQuery = stateManager.getFilterQuery();
      if (activeQuery) {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const entries = await discovery.getSearchableEntries(workspaceFolders);
        const lowerQuery = activeQuery.toLowerCase();
        const matchingIds = new Set<string>();
        for (const entry of entries) {
          if (entry.contentText.toLowerCase().includes(lowerQuery)) {
            matchingIds.add(entry.sessionId);
          }
        }
        stateManager.setFilter(activeQuery, matchingIds);
      }

      // Clear selection mode
      stateManager.setSelectionMode(false);
      vscode.commands.executeCommand("setContext", "claudeSessions.selectionMode", false);
      vscode.commands.executeCommand("setContext", "claudeSessions.hasCheckedSessions", false);
    })
  );

  // Open session commands (for toolbar/command palette use)
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessions.openSession", async (session: SessionNode) => {
      if (!session || session.kind !== "session") {
        return;
      }
      await terminalService.openSession(session);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessions.openSessionDangerously", async (session: SessionNode) => {
      if (!session || session.kind !== "session") {
        return;
      }
      const confirmed = await confirmDangerousLaunch(session.title);
      if (!confirmed) {
        outputChannel.appendLine(`[terminal] Dangerous launch canceled for session ${session.sessionId}.`);
        return;
      }
      await terminalService.openSession(session, { dangerouslySkipPermissions: true });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessions.focusView", async () => {
      await vscode.commands.executeCommand("claudeSessionsExplorer.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessions.openPromptPreview", async (node: SessionPromptNode) => {
      if (!node || node.kind !== "sessionPrompt") {
        return;
      }
      openPromptPreview(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessions.viewSession", async (session: SessionNode) => {
      if (!session || session.kind !== "session") {
        return;
      }
      await openSessionView(session);
    })
  );

  // Rename command (triggers inline rename via webview)
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessions.renameSession", async (session: SessionNode) => {
      if (!session || session.kind !== "session") {
        return;
      }
      explorerProvider.postStartRename(session.sessionId);
      sidebarProvider.postStartRename(session.sessionId);
    })
  );

  // Toggle selection mode
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessions.toggleSelectionMode", () => {
      const entering = !stateManager.selectionMode;
      stateManager.clearChecked();
      stateManager.setSelectionMode(entering);
      vscode.commands.executeCommand("setContext", "claudeSessions.selectionMode", entering);
      vscode.commands.executeCommand("setContext", "claudeSessions.hasCheckedSessions", false);
    })
  );

  // Unselect all checked sessions
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessions.clearSelection", () => {
      stateManager.clearChecked();
      vscode.commands.executeCommand("setContext", "claudeSessions.hasCheckedSessions", false);
    })
  );

  // Delete checked sessions (toolbar button)
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessions.deleteSession", async () => {
      // In webview mode, bulk delete is handled by the webview provider via deleteChecked message
      // This command is kept for the toolbar button
      const sessions = stateManager.getCheckedSessions();
      await confirmAndDeleteSessions(sessions, discovery, stateManager, outputChannel);
    })
  );

  // Workspace folders changed
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      outputChannel.appendLine("[lifecycle] Workspace folders changed. Refreshing tree.");
      hasRefreshed = true;
      await stateManager.refresh();
    })
  );

  // Auto-refresh: watch ~/.claude/projects for new/changed session transcripts (debounced)
  {
    const home = os.homedir();
    const pattern = new vscode.RelativePattern(vscode.Uri.file(path.join(home, ".claude", "projects")), "**/*.jsonl");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        hasRefreshed = true;
        await stateManager.refresh();
      }, 300);
    };
    watcher.onDidCreate(schedule);
    watcher.onDidChange(schedule);
    watcher.onDidDelete(schedule);
    context.subscriptions.push(watcher);

    // ~/.claude/sessions/<pid>.json muda a cada interação (status/updatedAt): só re-renderiza (rápido)
    let liveTimer: ReturnType<typeof setTimeout>;
    const notifyLive = () => {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => stateManager.notifyLive(), 300);
    };
    const liveWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(SESSIONS_DIR), "*.json")
    );
    liveWatcher.onDidCreate(notifyLive);
    liveWatcher.onDidChange(notifyLive);
    liveWatcher.onDidDelete(notifyLive);
    context.subscriptions.push(liveWatcher);

    // pid do shell de cada terminal, pra saber qual claude morreu quando um terminal fecha
    const shellPids = new Map<vscode.Terminal, number>();
    const track = (t: vscode.Terminal) =>
      void t.processId.then((pid) => {
        if (pid) {
          shellPids.set(t, pid);
        }
      });
    vscode.window.terminals.forEach(track);
    context.subscriptions.push(vscode.window.onDidOpenTerminal(track));

    // enquanto a sessão roda, resolve o shell dela em background (cache) pra o fechamento ser instantâneo
    const mapLive = () => {
      const known = new Set(shellPids.values());
      for (const info of readLiveSessions().values()) {
        shellPidOf(info.pid, known);
      }
    };
    let lastLiveKey = "";
    const pollIde = () => {
      const key = [...readLiveSessions().entries()]
        .map(([id, i]) => `${id}:${i.source}`)
        .sort()
        .join(",");
      if (key !== lastLiveKey) {
        lastLiveKey = key;
        stateManager.notifyLive();
      }
    };
    const ideTick = setInterval(pollIde, 3000);
    context.subscriptions.push({ dispose: () => clearInterval(ideTick) });
    setTimeout(mapLive, 3000);
    const mapTick = setInterval(mapLive, 10000);
    context.subscriptions.push({ dispose: () => clearInterval(mapTick) });

    // trava do rename das abas (declarada aqui porque o updateActive precisa dela)
    let syncing = false;

    // sessão cujo terminal está em foco fica selecionada na lista
    // (não escuta onDidChangeState: o rename das abas troca o terminal ativo e viraria loop)
    const updateActive = () => {
      if (syncing) {
        return;
      }
      const active = vscode.window.activeTerminal;
      const shell = active ? shellPids.get(active) : undefined;
      let activeId: string | undefined;
      if (shell) {
        const known = new Set(shellPids.values());
        for (const [sessionId, info] of readLiveSessions()) {
          if (shellPidOf(info.pid, known) === shell) {
            activeId = sessionId;
            break;
          }
        }
      }
      // aba do chat da extensão Claude Code em foco: casa pelo título da aba
      if (!activeId) {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const input = tab?.input;
        if (tab && input instanceof vscode.TabInputWebview && /claude/i.test(input.viewType)) {
          const session = stateManager.getSessionByTitle(tab.label);
          if (session && readLiveSessions().get(session.sessionId)?.source === "ide") {
            activeId = session.sessionId;
          }
        }
      }
      stateManager.setActiveSession(activeId);
    };
    context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(updateActive));
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => updateActive()));
    const activeTick = setInterval(updateActive, 2000);
    context.subscriptions.push({ dispose: () => clearInterval(activeTick) });

    // aba do terminal = nome da sessão na lista (renomeia quando divergir e confere o resultado)
    const syncTerminalNames = async () => {
      if (syncing) {
        return;
      }
      syncing = true;
      const before = vscode.window.activeTerminal;
      try {
        const known = new Set(shellPids.values());
        for (const [sessionId, info] of readLiveSessions()) {
          const session = stateManager.getSessionById(sessionId);
          if (!session) {
            continue;
          }
          const shell = shellPidOf(info.pid, known);
          const terminal = shell ? [...shellPids.entries()].find(([, p]) => p === shell)?.[0] : undefined;
          if (!terminal || terminal.name === session.title) {
            continue;
          }
          terminal.show(true);
          await vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name: session.title });
          outputChannel.appendLine(
            `[title] ${sessionId.slice(0, 8)}: "${terminal.name}" -> "${session.title}" ${terminal.name === session.title ? "ok" : "FALHOU"}`
          );
        }
      } finally {
        // devolve o foco pro terminal que estava ativo antes do rename
        if (before && vscode.window.activeTerminal !== before) {
          before.show(true);
        }
        syncing = false;
      }
    };
    context.subscriptions.push(stateManager.onDidChangeState(() => void syncTerminalNames()));
    setTimeout(() => void syncTerminalNames(), 4000);

    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((t) => {
        const pid = shellPids.get(t);
        shellPids.delete(t);
        if (pid) {
          markShellClosed(pid);
        }
        stateManager.notifyLive();
        setTimeout(() => stateManager.notifyLive(), 1500);
      })
    );
  }
}

export function deactivate(): void {
  // no-op
}

export function buildPromptPreviewHtml(node: SessionPromptNode): string {
  const ts = formatTimestamp(node.timestampMs, node.timestampIso) || "unavailable";

  const responseBlock = node.responseRaw ? renderMessageBlock("assistant", md.render(node.responseRaw)) : "";

  const extraStyles = `
  .prompt-header {
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    padding-bottom: 12px;
    margin-bottom: 20px;
  }
  .prompt-header h1 { font-size: 1.3em; margin: 0 0 6px 0; }
  .prompt-meta {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  .prompt-meta code {
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.95em;
  }`;

  const body = `
  <div class="prompt-header">
    <h1>${escapeHtml(node.sessionTitle)}</h1>
    <div class="prompt-meta">
      <span>Session: <code>${escapeHtml(node.sessionId)}</code></span>
      <span>Prompt #${String(node.promptIndex + 1)}</span>
      <span>${escapeHtml(ts)}</span>
    </div>
  </div>
  ${renderMessageBlock("user", md.render(node.promptRaw))}
  ${responseBlock}`;

  return htmlDocument(extraStyles, body);
}
