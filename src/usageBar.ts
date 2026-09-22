// Uso do plano do Claude na barra inferior, igual à status line do terminal (maia:statusline):
//   5h 32%/40% (2h51m)  |  7d 46%/57% (3h11m)  = usado/cota do tempo já passado na janela (reset em)
// Verde enquanto o uso está abaixo da cota, amarelo quando passou. Token OAuth do Claude Code: Keychain
// no Mac, ~/.claude/.credentials.json no Windows/Linux (onde o Claude Code guarda o login).
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// escrito pelo patch "usageFromChat" na extensão Claude Code a cada resposta do chat (e por esta
// barra quando ela mesma consulta a API, pra guardar o estado)
const USAGE_FILE = path.join(os.homedir(), ".claude", "claude-maia-usage.json");

const GREEN = "#98c379";
const YELLOW = "#e5c07b";
const RED = "#e06c75";

interface Window {
  readonly utilization?: number | null;
  readonly resets_at?: string | null;
}

/** Uso vindo do chat: utilization 0-1 e resetsAt em segundos; converte pro formato do endpoint. */
function readUsageFile(): { at: number; five_hour?: Window; seven_day?: Window } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")) as {
      at?: number;
      windows?: Record<string, { utilization?: number; resetsAt?: number } | null>;
    };
    if (!raw.at || !raw.windows) {
      return null;
    }
    const conv = (w: { utilization?: number; resetsAt?: number } | null | undefined): Window | undefined =>
      w && w.utilization !== undefined
        ? { utilization: w.utilization * 100, resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null }
        : undefined;
    return { at: raw.at, five_hour: conv(raw.windows.five_hour), seven_day: conv(raw.windows.seven_day) };
  } catch {
    return null;
  }
}

const CREDENTIALS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");

function parseToken(raw: string): string | null {
  try {
    return (JSON.parse(raw.trim()) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function keychainToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], (err, out) => {
      resolve(err ? null : parseToken(out));
    });
  });
}

function fileToken(): string | null {
  try {
    return parseToken(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function oauthToken(): Promise<string | null> {
  if (process.platform === "darwin") {
    return (await keychainToken()) ?? fileToken();
  }
  return fileToken();
}

async function fetchUsage(): Promise<{ five_hour?: Window; seven_day?: Window }> {
  const token = await oauthToken();
  if (!token) {
    throw new Error("sem login");
  }
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-maia" }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${String(res.status)}`);
  }
  return (await res.json()) as { five_hour?: Window; seven_day?: Window };
}

/** Guarda o que a API devolveu no mesmo formato do chat (utilization 0-1, resetsAt em segundos). */
function writeUsageFile(u: { five_hour?: Window; seven_day?: Window }): void {
  const conv = (w?: Window) =>
    w && w.utilization !== null && w.utilization !== undefined
      ? {
          utilization: w.utilization / 100,
          resetsAt: w.resets_at ? Math.round(new Date(w.resets_at).getTime() / 1000) : undefined
        }
      : null;
  try {
    fs.writeFileSync(
      USAGE_FILE,
      JSON.stringify({ at: Date.now(), windows: { five_hour: conv(u.five_hour), seven_day: conv(u.seven_day) } })
    );
  } catch {
    // sem disco: só não persiste
  }
}

/** Janela cujo reset já passou: o dado guardado não vale mais. */
function expired(u: { five_hour?: Window; seven_day?: Window }): boolean {
  const past = (w?: Window) => !!w?.resets_at && new Date(w.resets_at).getTime() <= Date.now();
  return past(u.five_hour) || past(u.seven_day);
}

function secsLeft(iso?: string | null): number | null {
  return iso ? Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000)) : null;
}

function fmtReset(diff: number | null): string {
  if (diff === null) {
    return "--";
  }
  let h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    h %= 24;
    return `${String(d)}d${String(h).padStart(2, "0")}h`;
  }
  return `${String(h)}h${String(m).padStart(2, "0")}m`;
}

// cota da janela em unidades inteiras (5h -> 20%/h, 7d -> ~14%/dia), igual à status line
function budget(diff: number | null, windowS: number, unitS: number): number | null {
  if (diff === null) {
    return null;
  }
  const units = Math.floor(windowS / unitS);
  const left = Math.floor(diff / unitS);
  return Math.round(((units - left) * 100) / units);
}

function colorFor(pct: number): string {
  return pct >= 90 ? RED : pct >= 70 ? YELLOW : GREEN;
}

function part(
  label: string,
  w: Window | undefined,
  windowS: number,
  unitS: number
): { text: string; color?: string; tooltip: string } {
  if (!w || w.utilization === null || w.utilization === undefined) {
    return { text: `${label} --`, tooltip: "sem dado" };
  }
  const used = Math.round(w.utilization);
  const diff = secsLeft(w.resets_at);
  const limit = budget(diff, windowS, unitS);
  if (limit === null) {
    return {
      text: `${label} ${String(used)}% (${fmtReset(diff)})`,
      color: colorFor(used),
      tooltip: `${String(used)}% usado`
    };
  }
  return {
    text: `${label} ${String(used)}%/${String(limit)}% (${fmtReset(diff)})`,
    color: used < limit ? GREEN : YELLOW,
    tooltip: `${String(used)}% usado · cota do tempo já passado ${String(limit)}% · reseta em ${fmtReset(diff)}`
  };
}

export function setupUsageBar(context: vscode.ExtensionContext): void {
  const five = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1002);
  const week = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1001);
  five.command = "claudeMaia.refreshUsage";
  week.command = "claudeMaia.refreshUsage";
  // aparece já, mesmo antes da primeira resposta (um 429 logo de cara deixava a barra vazia)
  five.text = "5h …";
  week.text = "7d …";
  five.tooltip = "Claude: consultando uso do plano";
  five.show();
  week.show();
  context.subscriptions.push(five, week);

  const enabled = () => vscode.workspace.getConfiguration("claudeMaia").get<boolean>("usageBar", true);
  let lastAt = 0;
  let blockedUntil = 0;

  const render = (u: { five_hour?: Window; seven_day?: Window }, origem: string) => {
    const a = part("5h", u.five_hour, 5 * 3600, 3600);
    const b = part("7d", u.seven_day, 7 * 86400, 86400);
    five.text = a.text;
    five.color = a.color;
    five.tooltip = `Claude, janela de 5 horas: ${a.tooltip} (${origem})`;
    week.text = b.text;
    week.color = b.color;
    week.tooltip = `Claude, janela de 7 dias: ${b.tooltip} (${origem})`;
    scheduleReset(u);
  };

  // Regra: o dado vem do chat (arquivo) e só muda quando um chat responde. A API só entra
  // quando NÃO há dado ou quando o reset da janela já passou; nesses casos consulta uma vez e
  // grava no arquivo pra guardar o estado. Clique na barra = força uma consulta.
  const refresh = async (force = false) => {
    if (!enabled()) {
      five.hide();
      week.hide();
      return;
    }
    const file = readUsageFile();
    if (file) {
      render(file, "do chat");
      five.show();
      week.show();
      // 22/09: dado do chat com mais de 5 min também vale consulta (antes só no reset da janela ou no clique)
      const stale = Date.now() - file.at > 5 * 60000;
      if (!force && !expired(file) && !stale) {
        return;
      }
    }
    const now = Date.now();
    if (now < blockedUntil || (!force && now - lastAt < 60000)) {
      return;
    }
    lastAt = now;
    try {
      const u = await fetchUsage();
      render(u, "da API");
      writeUsageFile(u);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "erro";
      if (msg === "HTTP 429") {
        blockedUntil = Date.now() + 5 * 60000;
        five.tooltip = "Claude: o endpoint de uso limitou as consultas; tenta de novo em 5 min";
      } else if (!file) {
        five.text = "5h --";
        five.color = undefined;
        five.tooltip = `Uso indisponível (${msg}); volta sozinho na próxima resposta de um chat, ou clique pra tentar`;
        week.text = "7d --";
        week.color = undefined;
      } else {
        five.tooltip = `${five.tooltip ?? ""} · janela resetou, API indisponível (${msg})`;
      }
    }
    five.show();
    week.show();
  };

  // o dado diz quando reseta: agenda a próxima consulta pra esse instante (nada de polling)
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReset = (u: { five_hour?: Window; seven_day?: Window }) => {
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = undefined;
    }
    const times = [u.five_hour?.resets_at, u.seven_day?.resets_at]
      .map((iso) => (iso ? new Date(iso).getTime() : NaN))
      .filter((t) => !isNaN(t) && t > Date.now());
    if (times.length === 0) {
      return;
    }
    const delay = Math.min(Math.min(...times) - Date.now() + 2000, 2 ** 31 - 1);
    resetTimer = setTimeout(() => void refresh(), delay);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeMaia.refreshUsage", () => void refresh(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeMaia.usageBar")) {
        void refresh();
      }
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        void refresh();
      }
    }),
    { dispose: () => resetTimer && clearTimeout(resetTimer) }
  );
  // o chat escreveu uso novo: atualiza na hora
  try {
    fs.watchFile(USAGE_FILE, { interval: 300 }, () => void refresh());
    context.subscriptions.push({ dispose: () => fs.unwatchFile(USAGE_FILE) });
  } catch {
    // sem watcher: fica o timer
  }
  void refresh();
}
