// Uso do plano do Claude na barra inferior, igual à status line do terminal (maia:statusline):
//   5h 32%/40% (2h51m)  |  7d 46%/57% (3h11m)  = usado/cota do tempo já passado na janela (reset em)
// Verde enquanto o uso está abaixo da cota, amarelo quando passou. Token OAuth do Claude Code no Keychain.
import { execFile } from "child_process";
import * as vscode from "vscode";

const GREEN = "#98c379";
const YELLOW = "#e5c07b";
const RED = "#e06c75";

interface Window {
  readonly utilization?: number | null;
  readonly resets_at?: string | null;
}

function keychainToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], (err, out) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        resolve(
          (JSON.parse(out.trim()) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken ?? null
        );
      } catch {
        resolve(null);
      }
    });
  });
}

async function fetchUsage(): Promise<{ five_hour?: Window; seven_day?: Window }> {
  const token = await keychainToken();
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

  // 429 = o endpoint limitou: espera 5 min antes de tentar de novo; fora isso, 1 chamada/min no máximo
  let lastAt = 0;
  let blockedUntil = 0;
  const refresh = async (force = false) => {
    const now = Date.now();
    if (now < blockedUntil || (!force && now - lastAt < 60000)) {
      return;
    }
    lastAt = now;
    if (!enabled()) {
      five.hide();
      week.hide();
      return;
    }
    try {
      const u = await fetchUsage();
      const a = part("5h", u.five_hour, 5 * 3600, 3600);
      const b = part("7d", u.seven_day, 7 * 86400, 86400);
      five.text = a.text;
      five.color = a.color;
      five.tooltip = `Claude, janela de 5 horas: ${a.tooltip}`;
      week.text = b.text;
      week.color = b.color;
      week.tooltip = `Claude, janela de 7 dias: ${b.tooltip}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "erro";
      if (msg === "HTTP 429") {
        blockedUntil = Date.now() + 5 * 60000;
        five.tooltip = "Claude: o endpoint de uso limitou as consultas; tenta de novo em 5 min";
        return; // mantém o último valor na barra
      }
      five.text = `5h ${msg}`;
      five.color = undefined;
      five.tooltip = "Uso indisponível: abra o Claude Code (login) e clique pra tentar de novo.";
      week.text = "7d --";
      week.color = undefined;
    }
    five.show();
    week.show();
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  const schedule = () => {
    if (timer) {
      clearInterval(timer);
    }
    const secs = Math.max(60, vscode.workspace.getConfiguration("claudeMaia").get<number>("usageIntervalSeconds", 60));
    timer = setInterval(() => void refresh(true), secs * 1000);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeMaia.refreshUsage", () => void refresh(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeMaia")) {
        schedule();
        void refresh();
      }
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        void refresh();
      }
    }),
    { dispose: () => timer && clearInterval(timer) }
  );
  void refresh(true);
  schedule();
}
