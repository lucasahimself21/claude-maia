// Fonte do chat da extensão Claude Code: a própria extensão lê chat.fontFamily/chat.fontSize e
// chat.editor.fontFamily/fontSize do VS Code (está no HTML da webview dela), então basta gravar
// essas configurações. A JetBrains Mono a Claude Maia instala se faltar: Homebrew no macOS, winget no
// Windows; no Linux só avisa.
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const JETBRAINS = "JetBrains Mono";
const CASK = "font-jetbrains-mono";
const WINGET_ID = "DEVCOM.JetBrainsMono";
const MANUAL = "https://www.jetbrains.com/lp/mono/";

function fontDirs(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return [path.join(home, "Library", "Fonts"), "/Library/Fonts"];
    case "win32":
      return [
        path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Microsoft", "Windows", "Fonts"),
        path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts")
      ];
    default:
      return [path.join(home, ".local", "share", "fonts"), path.join(home, ".fonts"), "/usr/share/fonts"];
  }
}

function fontInstalled(): boolean {
  for (const dir of fontDirs()) {
    try {
      if (fs.readdirSync(dir).some((f) => f.startsWith("JetBrainsMono"))) {
        return true;
      }
    } catch {
      // pasta não existe
    }
  }
  return false;
}

function brewPath(): string | undefined {
  return ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((p) => fs.existsSync(p));
}

/** Comando de instalação do sistema, ou undefined se não tem como instalar sozinha. */
function installer(log: (msg: string) => void): { cmd: string; args: string[] } | undefined {
  if (process.platform === "darwin") {
    const brew = brewPath();
    if (brew) {
      return { cmd: brew, args: ["install", "--cask", CASK] };
    }
    log(`[fonte] JetBrains Mono ausente e sem Homebrew; instale à mão: ${MANUAL}`);
    return undefined;
  }
  if (process.platform === "win32") {
    return {
      cmd: "winget",
      args: ["install", "--id", WINGET_ID, "-e", "--accept-source-agreements", "--accept-package-agreements"]
    };
  }
  log(`[fonte] JetBrains Mono ausente; instale pelo gerenciador do sistema ou à mão: ${MANUAL}`);
  return undefined;
}

async function installFont(log: (msg: string) => void): Promise<boolean> {
  const inst = installer(log);
  if (!inst) {
    return false;
  }
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Claude Maia: instalando a fonte JetBrains Mono…" },
    () =>
      new Promise<boolean>((resolve) => {
        execFile(inst.cmd, inst.args, { timeout: 180000, shell: process.platform === "win32" }, (err, _out, stderr) => {
          if (err) {
            log(
              `[fonte] ${inst.cmd} ${inst.args.join(" ")} falhou: ${String(stderr || err.message).trim()}; à mão: ${MANUAL}`
            );
            resolve(false);
          } else {
            log("[fonte] JetBrains Mono instalada");
            resolve(true);
          }
        });
      })
  );
}

/** Garante fonte instalada e as configs chat.* iguais às da Claude Maia (ao ativar e quando a config muda). */
export function setupChatFont(context: vscode.ExtensionContext, log: (msg: string) => void): void {
  let installing = false;
  const run = async () => {
    const cfg = vscode.workspace.getConfiguration("claudeMaia");
    if (!cfg.get<boolean>("chatFont", true)) {
      return;
    }
    const family = cfg.get<string>("chatFontFamily", JETBRAINS).trim();
    const size = cfg.get<number>("chatFontSize", 13);
    if (family === JETBRAINS && !fontInstalled() && !installing) {
      installing = true;
      try {
        await installFont(log);
      } finally {
        installing = false;
      }
    }
    const all = vscode.workspace.getConfiguration();
    const wanted: [string, string | number][] = [
      ["chat.fontFamily", family],
      ["chat.fontSize", size],
      ["chat.editor.fontFamily", family],
      ["chat.editor.fontSize", size]
    ];
    const changed: string[] = [];
    for (const [key, value] of wanted) {
      if (!family && key.endsWith("fontFamily")) {
        continue;
      }
      if (all.get(key) !== value) {
        await all.update(key, value, vscode.ConfigurationTarget.Global);
        changed.push(key);
      }
    }
    if (changed.length > 0) {
      log(
        `[fonte] ${changed.join(", ")} = ${family || "(padrão)"} ${String(size)}px; chats novos já usam, os abertos depois de recarregar`
      );
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeMaia.chatFont")) {
        void run();
      }
    })
  );
  setTimeout(() => void run(), 3000);
}
