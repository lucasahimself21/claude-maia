// Patches na extensão oficial anthropic.claude-code (a "Claude Code for VS Code").
// A extensão atualiza sozinha e perde qualquer alteração local; a Claude Maia
// reaplica ao ativar, de hora em hora e quando aparece pasta nova em ~/.vscode/extensions.
// Cada patch é uma troca de trecho exato (ou regex) no bundle minificado, com marcador
// pra saber que já foi aplicado. Original guardado em <arquivo>.orig.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export interface Patch {
  readonly id:
    | "autoBrowser"
    | "contextInChat"
    | "contextFullWindow"
    | "usageFromChat"
    | "chatFont"
    | "hideSessionManager";
  readonly title: string;
  readonly file: "webview/index.js" | "extension.js";
  readonly find: RegExp;
  /** texto fixo, ou função pra patch que depende de configuração (fonte) */
  readonly replace: string | (() => string);
  /** trecho que só existe depois do patch */
  readonly marker: string;
}

// Os nomes minificados (z, Y, LT1, VV0, o...) mudam a cada build/plataforma da extensão
// (2.1.276-darwin-arm64 ≠ 2.1.274-win32-x64): cada patch casa por REGEX nas partes estáveis
// (nomes de propriedade e strings) e reaproveita os nomes capturados no replace ($1, $2...).
export const PATCHES: readonly Patch[] = [
  {
    id: "autoBrowser",
    title: "navegador (Claude in Chrome) conecta sozinho em toda mensagem (equivale ao @browser)",
    file: "webview/index.js",
    find: /let ([\w$]+)=([\w$]+)\?\.expandMentions!==!1,([\w$]+)=await ([\w$]+)\(/,
    replace:
      'let $1=$2?.expandMentions!==!1;if($1&&(this.config?.value?.browserIntegrationSupported??!1)&&this.chromeMcpState?.value?.status==="disconnected"){try{await this.ensureChromeMcpEnabled()}catch(_){}}let $3=await $4(',
    marker: 'this.chromeMcpState?.value?.status==="disconnected"){try{await this.ensureChromeMcpEnabled()}'
  },
  {
    id: "contextInChat",
    title: "Ctx 36% (363k/1000k) no rodapé do chat, cores da status line",
    file: "webview/index.js",
    // $1 fn, $2 usedTokens, $3 contextWindow, $4 onCompact, $5 buttonClassName, $6 pct, $7 Q, $8 override, $9 G, $10 jsx, $11 pieComponent
    find: /function ([\w$]+)\(\{usedTokens:([\w$]+),contextWindow:([\w$]+),onCompact:([\w$]+),buttonClassName:([\w$]+)\}\)\{let ([\w$]+)=[\w$]+>0\?Math\.min\([\w$]+\/[\w$]+\*100,100\):0,([\w$]+)=([\w$]+)!==null\?[\w$]+:[\w$]+,([\w$]+)=100-[\w$]+;if\([\w$]+===null\)\{if\([\w$]+===0\)return null;if\([\w$]+>=50\)return null\}return ([\w$]+)\(([\w$]+),\{percentageUsed:[\w$]+,onCompact:[\w$]+,buttonClassName:[\w$]+\}\)\}/,
    replace:
      'function $1({usedTokens:$2,contextWindow:$3,onCompact:$4,buttonClassName:$5}){let $6=$3>0?Math.min($2/$3*100,100):0,$7=$8!==null?$8:$6;var mk=function(n){return n>=1000?(n/1000).toFixed(1)+"k":String(n)},mc=$2>=400000?"#e06c75":$2>=200000?"#e5c07b":"#98c379",mw=$3>0?$3:1e6,mt="Ctx "+Math.round($3>0?$7:$2/mw*100)+"% ("+mk($2)+"/"+mk(mw)+")";return $10("span",{style:{display:"inline-flex",alignItems:"center",gap:"4px"},children:[$3>0&&$10($11,{percentageUsed:$7,onCompact:$4,buttonClassName:$5}),$10("span",{style:{color:mc,fontSize:"11px",whiteSpace:"nowrap"},title:"Contexto usado (tokens/janela). Cor pelo token bruto: 200k amarelo, 400k vermelho.",children:mt})]})}',
    marker: 'mt="Ctx "+Math.round('
  },
  {
    id: "contextFullWindow",
    title: "Ctx conta sobre a janela inteira (1000k), igual à status line",
    file: "webview/index.js",
    find: /contextWindow:([\w$]+)\.usageData\.value\.contextWindow-\1\.usageData\.value\.maxOutputTokens-13000,/,
    replace: "contextWindow:$1.usageData.value.contextWindow/*claude-maia*/,",
    marker: ".usageData.value.contextWindow/*claude-maia*/,"
  },
  {
    id: "usageFromChat",
    title: "grava o uso do plano (5h/7d) que chega com cada resposta, pra barra não precisar consultar a API",
    file: "extension.js",
    find: /this\.onRateLimitWindows\(([\w$]+)\.rate_limit_info\.unifiedWindows\)/,
    replace:
      'this.onRateLimitWindows($1.rate_limit_info.unifiedWindows);try{require("fs").writeFileSync(require("path").join(require("os").homedir(),".claude","claude-maia-usage.json"),JSON.stringify({at:Date.now(),windows:$1.rate_limit_info.unifiedWindows}))}catch(_){}/*claude-maia-usage*/',
    marker: "/*claude-maia-usage*/"
  },
  {
    id: "chatFont",
    title: "fonte, tamanho e entrelinha do chat = os do editor (ou claudeMaia.chatFont*)",
    file: "webview/index.js",
    // prepend: roda antes do app. O bundle embute a pilha do sistema (-apple-system, BlinkMacSystemFont...)
    // em vez da variável do VS Code, então só uma folha de estilo com !important muda o texto do chat;
    // os ícones (codicon) ficam de fora pra não virar quadradinho.
    find: /^/,
    replace: () => {
      const f = chatFont();
      if (!f.family && !f.size && !f.lineHeight) {
        return "";
      }
      const css: string[] = [];
      const vars: string[] = [];
      if (f.family) {
        const j = JSON.stringify(f.family);
        css.push(`body,body *:not(.codicon):not(.codicon *){font-family:${j},monospace!important}`);
        vars.push(`s.setProperty("--vscode-font-family",${j});s.setProperty("--vscode-editor-font-family",${j})`);
      }
      if (f.size) {
        css.push(`body{font-size:${String(f.size)}px!important}`);
        vars.push(`s.setProperty("--vscode-font-size",${JSON.stringify(`${String(f.size)}px`)})`);
      }
      if (f.lineHeight) {
        css.push(`body{line-height:${String(f.lineHeight)}!important}`);
      }
      const cssJson = JSON.stringify(css.join(""));
      return (
        `/*claude-maia-font*/try{var s=document.documentElement.style;${vars.join(";")};` +
        `var st=document.createElement("style");st.id="claude-maia-font";st.textContent=${cssJson};` +
        `(document.head||document.documentElement).appendChild(st)}catch(_){}\n`
      );
    },
    marker: "/*claude-maia-font*/"
  },
  {
    id: "hideSessionManager",
    title: "esconde a barra lateral Session Manager da extensão oficial",
    file: "extension.js",
    find: /executeCommand\("setContext","claude-vscode\.sessionsListEnabled",!0\)/,
    replace: 'executeCommand("setContext","claude-vscode.sessionsListEnabled",!1/*claude-maia*/)',
    marker: '"claude-vscode.sessionsListEnabled",!1/*claude-maia*/'
  }
];

export interface PatchResult {
  readonly extensionDir: string | undefined;
  readonly applied: string[];
  readonly skipped: string[];
  readonly failed: string[];
}

export const EXTENSIONS_DIR = path.join(os.homedir(), ".vscode", "extensions");

function versionOf(dir: string): number[] {
  const m = /anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(dir);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** Pasta da versão mais nova instalada da extensão oficial (o VS Code guarda a antiga até limpar). */
export function findClaudeCodeDir(): string | undefined {
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(EXTENSIONS_DIR)
      .filter(
        (d) => d.startsWith("anthropic.claude-code-") && fs.existsSync(path.join(EXTENSIONS_DIR, d, "extension.js"))
      );
  } catch {
    return undefined;
  }
  dirs.sort((a, b) => {
    const va = versionOf(a);
    const vb = versionOf(b);
    for (let i = 0; i < 3; i++) {
      if (va[i] !== vb[i]) {
        return vb[i] - va[i];
      }
    }
    return 0;
  });
  return dirs[0] ? path.join(EXTENSIONS_DIR, dirs[0]) : undefined;
}

/** Fonte do chat: claudeMaia.chatFont* ou, vazio/0, os valores do editor. lineHeight do editor
 * só vale como multiplicador (< 8); em px o VS Code usa outra escala e aqui não faria sentido. */
function chatFont(): { family: string; size: number; lineHeight: number } {
  const own = vscode.workspace.getConfiguration("claudeMaia");
  const editor = vscode.workspace.getConfiguration("editor");
  const family = own.get<string>("chatFontFamily", "").trim() || (editor.get<string>("fontFamily") ?? "").trim();
  const size = own.get<number>("chatFontSize", 0) || editor.get<number>("fontSize", 0);
  const ownLh = own.get<number>("chatLineHeight", 0);
  const editorLh = editor.get<number>("lineHeight", 0);
  const lineHeight = ownLh || (editorLh > 0 && editorLh < 8 ? editorLh : 0);
  return { family, size, lineHeight };
}

function enabledPatches(): readonly Patch[] {
  const cfg = vscode.workspace.getConfiguration("claudeMaia");
  return PATCHES.filter((p) => cfg.get<boolean>(`patch.${p.id}`, true));
}

/** Aplica os patches, sempre a partir do ORIGINAL (.orig): uma versão anterior da Claude Maia
 * com patch diferente não deixa o arquivo num estado que o patch novo não reconhece. */
export function applyPatches(log: (msg: string) => void): PatchResult {
  const dir = findClaudeCodeDir();
  const result = { extensionDir: dir, applied: [] as string[], skipped: [] as string[], failed: [] as string[] };
  if (!dir) {
    return result;
  }
  const byFile = new Map<string, Patch[]>();
  for (const p of enabledPatches()) {
    byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
  }
  for (const file of ["webview/index.js", "extension.js"] as const) {
    const patches = byFile.get(file) ?? [];
    const full = path.join(dir, file);
    const orig = `${full}.orig`;
    let current: string;
    try {
      current = fs.readFileSync(full, "utf8");
    } catch (err) {
      for (const p of patches) {
        result.failed.push(`${p.title}: ${String(err)}`);
      }
      continue;
    }
    let base = current;
    if (fs.existsSync(orig)) {
      base = fs.readFileSync(orig, "utf8");
    } else if (patches.length > 0) {
      fs.writeFileSync(orig, current, "utf8");
    }
    let content = base;
    for (const p of patches) {
      const count = (content.match(new RegExp(p.find.source, "g")) ?? []).length;
      if (count !== 1) {
        result.failed.push(
          `${p.title} (trecho ${count === 0 ? "não encontrado" : "ambíguo"} em ${path.basename(dir)})`
        );
        continue;
      }
      const replacement = typeof p.replace === "function" ? p.replace() : p.replace;
      if (replacement === "") {
        continue; // patch sem efeito com a configuração atual (ex.: sem fonte)
      }
      content = content.replace(p.find, replacement);
      if (current.includes(p.marker)) {
        result.skipped.push(p.title);
      } else {
        result.applied.push(p.title);
      }
    }
    if (content !== current) {
      fs.writeFileSync(full, content, "utf8");
      log(`[patch] ${file}: ${result.applied.join("; ") || "reescrito a partir do original"}`);
    }
  }
  return result;
}

/** Volta os arquivos originais (.orig) da versão instalada. */
export function restoreOriginals(): string[] {
  const dir = findClaudeCodeDir();
  const restored: string[] = [];
  if (!dir) {
    return restored;
  }
  for (const file of ["webview/index.js", "extension.js"]) {
    const full = path.join(dir, file);
    const orig = `${full}.orig`;
    if (fs.existsSync(orig)) {
      fs.copyFileSync(orig, full);
      fs.unlinkSync(orig);
      restored.push(file);
    }
  }
  return restored;
}

/** Roda ao ativar, de hora em hora e quando aparece pasta nova da extensão. Avisa só quando muda algo. */
export function setupAutoPatch(context: vscode.ExtensionContext, log: (msg: string) => void): void {
  let installing = false;
  const run = async (interactive: boolean) => {
    if (!vscode.workspace.getConfiguration("claudeMaia").get<boolean>("patchClaudeCode", true) && !interactive) {
      return;
    }
    let r = applyPatches(log);
    if (!r.extensionDir) {
      // extensão oficial não instalada: instala do marketplace e aplica os patches em seguida
      if (installing) {
        return;
      }
      installing = true;
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Claude Maia: instalando a extensão Claude Code (Anthropic)…"
          },
          async () => {
            await vscode.commands.executeCommand("workbench.extensions.installExtension", "anthropic.claude-code");
          }
        );
        log("[patch] anthropic.claude-code instalada pelo marketplace");
      } catch (err) {
        installing = false;
        void vscode.window.showWarningMessage(
          `Claude Maia: não deu pra instalar a Claude Code (${String(err)}). Instale pelo marketplace e rode "Claude Maia: reaplicar patches".`
        );
        return;
      }
      installing = false;
      r = applyPatches(log);
      if (!r.extensionDir) {
        void vscode.window.showWarningMessage(
          "Claude Maia: Claude Code instalada, mas a pasta ainda não apareceu; recarregue a janela e os patches entram sozinhos."
        );
        return;
      }
    }
    if (r.failed.length > 0) {
      void vscode.window.showWarningMessage(
        `Claude Maia: patch não encaixou na versão nova da Claude Code: ${r.failed.join(" · ")}`
      );
    }
    if (r.applied.length > 0) {
      const choice = await vscode.window.showInformationMessage(
        `Claude Maia: patches aplicados na Claude Code (${r.applied.length}). Recarregue a janela pra valer.`,
        "Reload Window"
      );
      if (choice) {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    } else if (interactive) {
      void vscode.window.showInformationMessage(
        `Claude Maia: nada a fazer, ${r.skipped.length} patch(es) já aplicados em ${path.basename(r.extensionDir)}.`
      );
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeMaia.restartChrome", async () => {
      // "Browser extension is not connected" com o Chrome aberto: só fechar e abrir de novo resolve
      const cp = await import("child_process");
      try {
        if (process.platform === "darwin") {
          cp.execSync("osascript -e 'quit app \"Google Chrome\"'", { stdio: "pipe" });
          await new Promise((r) => setTimeout(r, 2500));
          cp.execSync("open -a 'Google Chrome'");
        } else if (process.platform === "win32") {
          cp.execSync("taskkill /IM chrome.exe /F", { stdio: "pipe" });
          await new Promise((r) => setTimeout(r, 2500));
          cp.execSync("start chrome", { shell: "cmd.exe" });
        } else {
          cp.execSync("pkill -x chrome || pkill -x google-chrome || true", { stdio: "pipe" });
          await new Promise((r) => setTimeout(r, 2500));
          cp.spawn("google-chrome", [], { detached: true, stdio: "ignore" }).unref();
        }
        void vscode.window.showInformationMessage(
          "Claude Maia: Chrome reiniciado. Manda a próxima mensagem que o navegador reconecta."
        );
      } catch (err) {
        void vscode.window.showWarningMessage(`Claude Maia: não deu pra reiniciar o Chrome (${String(err)})`);
      }
    }),
    vscode.commands.registerCommand("claudeMaia.patchClaudeCode", () => run(true)),
    vscode.commands.registerCommand("claudeMaia.unpatchClaudeCode", async () => {
      const restored = restoreOriginals();
      const choice = await vscode.window.showInformationMessage(
        restored.length
          ? `Claude Maia: original restaurado (${restored.join(", ")}). Recarregue a janela.`
          : "Claude Maia: nada pra restaurar.",
        ...(restored.length ? ["Reload Window"] : [])
      );
      if (choice) {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    })
  );

  // mudou fonte ou ligou/desligou um patch: reaplica (sempre a partir do .orig)
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeMaia")) {
        void run(false);
      }
    })
  );
  setTimeout(() => void run(false), 2000);
  const tick = setInterval(() => void run(false), 60 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });
  try {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(EXTENSIONS_DIR), "anthropic.claude-code-*/extension.js")
    );
    let timer: ReturnType<typeof setTimeout>;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(false), 5000);
    };
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    context.subscriptions.push(watcher);
  } catch {
    // sem watcher: fica o timer
  }
}
