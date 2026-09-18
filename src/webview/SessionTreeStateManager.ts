import * as vscode from "vscode";
import { readIdeTabTitles, readLiveSessions } from "../liveSessions";

const IDE_BUSY_WINDOW_MS = 6000;
import { SessionNode } from "../models";
import { ISessionDiscoveryService, SessionPrompt } from "../discovery/types";
import { formatAgeToken, truncateForTreeLabel, findHighlightRanges } from "../utils/formatting";
import { WebviewTreeState, WebviewWorkspaceGroup, WebviewSessionItem, WebviewPromptItem } from "./messages";

export class SessionTreeStateManager {
  private readonly _onDidChangeState = new vscode.EventEmitter<void>();
  public readonly onDidChangeState = this._onDidChangeState.event;

  private sessionsByWorkspace = new Map<string, SessionNode[]>();
  private globalInfoMessage: string | undefined;
  private filterQuery: string | undefined;
  private filteredSessionIds: Set<string> | undefined;
  private checkedSessionIds = new Set<string>();
  private expandedWorkspaces = new Set<string>();
  private expandedSessions = new Set<string>();
  private promptsCache = new Map<string, SessionPrompt[]>();
  private hasLoaded = false;
  private activeSessionId: string | undefined;
  /** sessionId -> quando ficou aberta (ordem de abertura, pra lista não reordenar enquanto aberta) */
  private liveSince = new Map<string, number>();
  private fireTimeout: ReturnType<typeof setTimeout> | undefined;

  public constructor(private readonly discoveryService: ISessionDiscoveryService) {}

  public getFilterQuery(): string | undefined {
    return this.filterQuery;
  }

  /** Marca a sessão cujo terminal está em foco (só re-renderiza se mudou). */
  public setActiveSession(sessionId: string | undefined): void {
    if (sessionId === this.activeSessionId) {
      return;
    }
    this.activeSessionId = sessionId;
    this._onDidChangeState.fire();
  }

  /** Re-renderiza com o estado atual (bolinha/tempo) sem reler os transcripts. */
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Re-renderiza depois da janela de "busy" da IDE, pra bolinha parar de pulsar sozinha. */
  private scheduleIdleCheck(): void {
    if (this.idleTimer) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.notifyLive();
    }, IDE_BUSY_WINDOW_MS + 500);
  }

  public notifyLive(): void {
    this._onDidChangeState.fire();
  }

  public async refresh(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const result = await this.discoveryService.discover(workspaceFolders);
    this.sessionsByWorkspace = result.sessionsByWorkspace;
    this.globalInfoMessage = result.globalInfoMessage;
    this.hasLoaded = true;
    this.promptsCache.clear();

    // Auto-expand all workspaces on first load
    if (this.expandedWorkspaces.size === 0) {
      for (const folder of workspaceFolders) {
        this.expandedWorkspaces.add(folder.uri.toString());
      }
    }

    this._onDidChangeState.fire();
  }

  public setFilter(query: string | undefined, matchingSessionIds: Set<string> | undefined): void {
    this.filterQuery = query;
    this.filteredSessionIds = matchingSessionIds;
    this.scheduleStateChange();
  }

  public toggleCheck(sessionId: string): void {
    if (this.checkedSessionIds.has(sessionId)) {
      this.checkedSessionIds.delete(sessionId);
    } else {
      this.checkedSessionIds.add(sessionId);
    }
    this.scheduleStateChange();
  }

  public selectSessions(sessionIds: string[]): void {
    for (const id of sessionIds) {
      this.checkedSessionIds.add(id);
    }
    this.scheduleStateChange();
  }

  public getCheckedSessions(): SessionNode[] {
    const result: SessionNode[] = [];
    for (const sessions of this.sessionsByWorkspace.values()) {
      for (const session of sessions) {
        if (this.checkedSessionIds.has(session.sessionId)) {
          result.push(session);
        }
      }
    }
    return result;
  }

  public clearChecked(): void {
    this.checkedSessionIds.clear();
    this.scheduleStateChange();
  }

  public toggleWorkspaceExpand(workspaceUri: string): void {
    if (this.expandedWorkspaces.has(workspaceUri)) {
      this.expandedWorkspaces.delete(workspaceUri);
    } else {
      this.expandedWorkspaces.add(workspaceUri);
    }
    this.scheduleStateChange();
  }

  public toggleSessionExpand(sessionId: string): void {
    if (this.expandedSessions.has(sessionId)) {
      this.expandedSessions.delete(sessionId);
    } else {
      this.expandedSessions.add(sessionId);
      // Eagerly load prompts
      this.loadPromptsForSession(sessionId);
    }
    this.scheduleStateChange();
  }

  /** Sessão pelo título da aba (a extensão Claude Code nomeia a aba com o título da sessão). */
  /** Sessão com esse título; se houver mais de uma (dois chats "Google"), a de escrita mais recente. */
  public getSessionByTitle(title: string): SessionNode | undefined {
    let best: SessionNode | undefined;
    for (const sessions of this.sessionsByWorkspace.values()) {
      for (const s of sessions) {
        if (s.title === title && (!best || s.updatedAt > best.updatedAt)) {
          best = s;
        }
      }
    }
    return best;
  }

  public getSessionById(sessionId: string): SessionNode | undefined {
    for (const sessions of this.sessionsByWorkspace.values()) {
      const found = sessions.find((s) => s.sessionId === sessionId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  public hasCheckedSessions(): boolean {
    return this.checkedSessionIds.size > 0;
  }

  public getPromptById(sessionId: string, promptId: string): SessionPrompt | undefined {
    const prompts = this.promptsCache.get(sessionId);
    if (!prompts) {
      return undefined;
    }
    return prompts.find((p) => p.promptId === promptId);
  }

  public getPromptIndex(sessionId: string, promptId: string): number {
    const prompts = this.promptsCache.get(sessionId);
    if (!prompts) {
      return 0;
    }
    const idx = prompts.findIndex((p) => p.promptId === promptId);
    return idx >= 0 ? idx : 0;
  }

  public async buildWebviewState(): Promise<WebviewTreeState> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const workspaces: WebviewWorkspaceGroup[] = [];

    if (workspaceFolders.length > 0) {
      // Flatten sessions from every open folder into a single, chronologically
      // sorted list instead of one group per folder: a session already has
      // access to the whole workspace, so splitting by folder added a
      // distinction without a difference.
      let sessions: SessionNode[] = [];
      const seenSessionIds = new Set<string>();
      for (const folder of workspaceFolders) {
        for (const session of this.sessionsByWorkspace.get(folder.uri.toString()) ?? []) {
          if (!seenSessionIds.has(session.sessionId)) {
            seenSessionIds.add(session.sessionId);
            sessions.push(session);
          }
        }
      }
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);

      let infoMessage: string | undefined;

      if (this.filteredSessionIds !== undefined) {
        sessions = sessions.filter((s) => this.filteredSessionIds!.has(s.sessionId));
        if (sessions.length === 0) {
          infoMessage = "No matches.";
        }
      } else if (sessions.length === 0) {
        if (!this.hasLoaded) {
          infoMessage = "Loading sessions...";
        } else if (this.globalInfoMessage) {
          infoMessage = this.globalInfoMessage;
        } else {
          infoMessage = undefined; // sem sessão fica vazio
        }
      }

      const liveSessions = readLiveSessions();
      const ideTabs = readIdeTabTitles();
      // N abas abertas com um título = as N sessões desse título de escrita mais recente estão abertas
      // (sem isso, dois chats "Google" acendiam a bolinha nos dois com uma aba só)
      const titleRank = new Map<string, number>();
      const seenTitles = new Map<string, number>();
      for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
        const n = seenTitles.get(s.title) ?? 0;
        titleRank.set(s.sessionId, n);
        seenTitles.set(s.title, n + 1);
      }
      const openInIde = (s: SessionNode) => (titleRank.get(s.sessionId) ?? 0) < (ideTabs.get(s.title) ?? 0);
      const sessionItems: WebviewSessionItem[] = [];
      for (const session of sessions) {
        // só a sessão expandida precisa dos prompts: parsear o transcript de todas a cada
        // re-render travava a lista enquanto o chat respondia
        const prompts = this.expandedSessions.has(session.sessionId) ? await this.getPromptsForSession(session) : [];
        const promptItems: WebviewPromptItem[] = prompts.map((prompt, index) => {
          const label = truncateForTreeLabel(prompt.promptTitle, 64);
          const highlightRanges = this.filterQuery ? findHighlightRanges(label, this.filterQuery) : [];
          const lowerQuery = this.filterQuery?.toLowerCase();
          const rawMatches = lowerQuery ? prompt.promptRaw.toLowerCase().includes(lowerQuery) : false;
          const responseMatches =
            lowerQuery && prompt.responseRaw ? prompt.responseRaw.toLowerCase().includes(lowerQuery) : false;

          let matchType: "title" | "prompt" | "response" | undefined;
          if (highlightRanges.length > 0) {
            matchType = "title";
          } else if (rawMatches) {
            matchType = "prompt";
          } else if (responseMatches) {
            matchType = "response";
          }

          return {
            promptId: prompt.promptId,
            sessionId: prompt.sessionId,
            sessionTitle: session.title,
            promptIndex: index,
            promptTitle: label,
            promptRaw: prompt.promptRaw,
            responseRaw: prompt.responseRaw,
            timestampIso: prompt.timestampIso,
            timestampMs: prompt.timestampMs,
            highlightRanges: highlightRanges.length > 0 ? highlightRanges : undefined,
            matchType
          };
        });

        let live = liveSessions.get(session.sessionId);
        // aba do chat aberta = viva na IDE (instantâneo; o processo pode demorar a aparecer/sumir)
        if (!live && openInIde(session)) {
          live = { pid: 0, updatedAt: 0, source: "ide" };
        } else if (live?.source === "ide" && !openInIde(session) && live.pid > 0) {
          live = undefined; // aba fechada, processo ainda morrendo
        }
        const lastUsed = Math.max(session.updatedAt, live?.updatedAt ?? 0);
        // IDE não publica busy/idle: transcript mudando nos últimos segundos = respondendo
        const ideBusy = live?.source === "ide" && Date.now() - session.updatedAt < IDE_BUSY_WINDOW_MS;
        if (ideBusy) {
          this.scheduleIdleCheck();
        }

        if (live) {
          if (!this.liveSince.has(session.sessionId)) {
            this.liveSince.set(session.sessionId, Date.now());
          }
        } else {
          this.liveSince.delete(session.sessionId);
        }
        sessionItems.push({
          sessionId: session.sessionId,
          title: session.title,
          live: live ? (live.status === "busy" || ideBusy ? "busy" : "idle") : undefined,
          active: live !== undefined && session.sessionId === this.activeSessionId,
          // aberta = "now" fixo; o tempo só começa a contar depois que fecha
          description: live ? "now" : formatAgeToken(lastUsed),
          tooltip: [
            `Session: ${session.sessionId}`,
            `Title: ${session.title}`,
            live
              ? `Open in ${live.source === "ide" ? "Claude Code" : "terminal"} (pid ${String(live.pid)}, ${live.status ?? (ideBusy ? "busy" : "idle")})`
              : "Not running",
            `Last used: ${new Date(lastUsed).toLocaleString()}`,
            `CWD: ${session.cwd}`,
            `Transcript: ${session.transcriptPath}`
          ].join("\n"),
          transcriptPath: session.transcriptPath,
          cwd: session.cwd,
          updatedAt: session.updatedAt,
          lastUsed,
          prompts: this.expandedSessions.has(session.sessionId) ? promptItems : undefined
        });
      }

      // abertas no topo, na ordem em que abriram (não trocam de lugar enquanto abertas);
      // fechadas abaixo, da mais recente pra mais antiga
      sessionItems.sort((a, b) => {
        const aLive = a.live !== undefined ? 1 : 0;
        const bLive = b.live !== undefined ? 1 : 0;
        if (aLive !== bLive) {
          return bLive - aLive;
        }
        if (aLive) {
          return (this.liveSince.get(a.sessionId) ?? 0) - (this.liveSince.get(b.sessionId) ?? 0);
        }
        return b.lastUsed - a.lastUsed;
      });

      workspaces.push({
        workspaceUri: "",
        workspaceName: "",
        sessions: sessionItems,
        infoMessage: sessionItems.length === 0 ? infoMessage : undefined
      });
    }

    if (workspaceFolders.length === 0) {
      workspaces.push({
        workspaceUri: "",
        workspaceName: "",
        sessions: [],
        infoMessage: "Open a folder to view Claude sessions."
      });
    }

    return {
      workspaces,
      filterQuery: this.filterQuery,
      checkedSessionIds: Array.from(this.checkedSessionIds),
      expandedWorkspaces: Array.from(this.expandedWorkspaces),
      expandedSessions: Array.from(this.expandedSessions)
    };
  }

  private async getPromptsForSession(session: SessionNode): Promise<SessionPrompt[]> {
    const cached = this.promptsCache.get(session.sessionId);
    if (cached) {
      return cached;
    }
    const prompts = await this.discoveryService.getUserPrompts(session);
    this.promptsCache.set(session.sessionId, prompts);
    return prompts;
  }

  private async loadPromptsForSession(sessionId: string): Promise<void> {
    const session = this.getSessionById(sessionId);
    if (!session) {
      return;
    }
    if (this.promptsCache.has(sessionId)) {
      return;
    }
    const prompts = await this.discoveryService.getUserPrompts(session);
    this.promptsCache.set(sessionId, prompts);
    this._onDidChangeState.fire();
  }

  private scheduleStateChange(): void {
    if (this.fireTimeout !== undefined) {
      clearTimeout(this.fireTimeout);
    }
    this.fireTimeout = setTimeout(() => {
      this.fireTimeout = undefined;
      this._onDidChangeState.fire();
    }, 16);
  }

  public dispose(): void {
    if (this.fireTimeout !== undefined) {
      clearTimeout(this.fireTimeout);
    }
    this._onDidChangeState.dispose();
  }
}
