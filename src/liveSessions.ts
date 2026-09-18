// Sessões do Claude Code em execução: lê ~/.claude/sessions/<pid>.json
// (o CLI grava sessionId, pid, status busy/idle e updatedAt a cada interação).
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");

export interface LiveSessionInfo {
  readonly pid: number;
  readonly status?: string;
  readonly updatedAt: number;
  /** "terminal" = ~/.claude/sessions (CLI no terminal); "ide" = processo da extensão Claude Code */
  readonly source: "terminal" | "ide";
}

// Sessões abertas na extensão Claude Code do VS Code: ela não grava em ~/.claude/sessions,
// mas sobe um processo `claude ... --resume=<id>` ou `--session-id=<id>`. Cache curto porque `ps` custa.
let ideCache: { at: number; map: Map<string, number> } | undefined;
export function readIdeSessions(): Map<string, number> {
  if (ideCache && Date.now() - ideCache.at < 2000) {
    return ideCache.map;
  }
  const map = new Map<string, number>();
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || !/(^|\/)claude(\s|$)/.test(m[2]) || !/--(resume|session-id)=/.test(m[2])) {
        continue;
      }
      const id = /--(?:resume|session-id)=([0-9a-f-]{36})/.exec(m[2])?.[1];
      if (id) {
        map.set(id, Number(m[1]));
      }
    }
  } catch {
    // sem ps: só terminal
  }
  ideCache = { at: Date.now(), map };
  return map;
}

// pid do claude -> pid do shell (terminal do VS Code) que o iniciou
const shellPidCache = new Map<number, number>();
// shells de terminais que o VS Code já fechou (o claude ainda pode estar morrendo)
const closedShells = new Set<number>();

export function markShellClosed(shellPid: number): void {
  closedShells.add(shellPid);
  setTimeout(() => closedShells.delete(shellPid), 15000);
}

function parentPid(pid: number): number {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

/** Sobe a árvore de processos até achar um pid que seja shell de terminal. */
export function shellPidOf(pid: number, shellPids: Set<number>): number | undefined {
  const cached = shellPidCache.get(pid);
  if (cached && shellPids.has(cached)) {
    return cached;
  }
  let cur = pid;
  for (let i = 0; i < 6 && cur > 1; i++) {
    if (shellPids.has(cur)) {
      shellPidCache.set(pid, cur);
      return cur;
    }
    cur = parentPid(cur);
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Map sessionId -> { pid, status, updatedAt } só para processos vivos. */
/** Títulos das abas de chat da extensão Claude Code abertas nesta janela (a aba leva o título da sessão). */
export function readIdeTabTitles(): Set<string> {
  const titles = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputWebview && /claude/i.test(input.viewType)) {
        titles.add(tab.label);
      }
    }
  }
  return titles;
}

export function invalidateIdeCache(): void {
  ideCache = undefined;
}

export function readLiveSessions(): Map<string, LiveSessionInfo> {
  const live = new Map<string, LiveSessionInfo>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
      if (!data.sessionId || !data.pid || !pidAlive(data.pid)) {
        continue;
      }
      const shell = shellPidCache.get(data.pid);
      if (shell && closedShells.has(shell)) {
        continue; // terminal já fechado, processo só não morreu ainda
      }
      const prev = live.get(data.sessionId);
      if (!prev || (data.updatedAt ?? 0) > (prev.updatedAt ?? 0)) {
        live.set(data.sessionId, {
          pid: data.pid,
          status: data.status,
          updatedAt: data.updatedAt ?? 0,
          source: "terminal"
        });
      }
    } catch {
      // arquivo parcial/corrompido: ignora
    }
  }
  for (const [sessionId, pid] of readIdeSessions()) {
    if (!live.has(sessionId)) {
      live.set(sessionId, { pid, updatedAt: 0, source: "ide" });
    }
  }
  return live;
}

/** Acha o terminal do VS Code em cuja árvore de processos o claude (pid) roda. */
export async function findTerminalForPid(
  terminals: readonly vscode.Terminal[],
  pid: number
): Promise<vscode.Terminal | undefined> {
  const shellPids = new Map<number, vscode.Terminal>();
  for (const t of terminals) {
    const p = await t.processId;
    if (p) {
      shellPids.set(p, t);
    }
  }
  const shell = shellPidOf(pid, new Set(shellPids.keys()));
  return shell ? shellPids.get(shell) : undefined;
}
