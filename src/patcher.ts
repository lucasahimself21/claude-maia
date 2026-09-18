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
  readonly id: "autoBrowser" | "contextInChat" | "contextFullWindow" | "hideSessionManager";
  readonly title: string;
  readonly file: "webview/index.js" | "extension.js";
  readonly find: string | RegExp;
  /** texto fixo, ou função pra patch que depende de configuração (fonte) */
  readonly replace: string | (() => string);
  /** trecho que só existe depois do patch */
  readonly marker: string;
}

export const PATCHES: readonly Patch[] = [
  {
    id: "autoBrowser",
    title: "navegador (Claude in Chrome) conecta sozinho em toda mensagem (equivale ao @browser)",
    file: "webview/index.js",
    find: "let z=Y?.expandMentions!==!1,q=await LT1($,J,G,",
    replace:
      'let z=Y?.expandMentions!==!1;if(z&&(this.config?.value?.browserIntegrationSupported??!1)&&this.chromeMcpState?.value?.status==="disconnected"){try{await this.ensureChromeMcpEnabled()}catch(_){}}let q=await LT1($,J,G,',
    marker: 'this.chromeMcpState?.value?.status==="disconnected"){try{await this.ensureChromeMcpEnabled()}'
  },
  {
    id: "contextInChat",
    title: "Ctx 36% (363k/1000k) no rodapé do chat, cores da status line",
    file: "webview/index.js",
    find: "function VV0({usedTokens:$,contextWindow:J,onCompact:Z,buttonClassName:X}){let Y=J>0?Math.min($/J*100,100):0,Q=OD1!==null?OD1:Y,G=100-Q;if(OD1===null){if(J===0)return null;if(G>=50)return null}return F(i75,{percentageUsed:Q,onCompact:Z,buttonClassName:X})}",
    replace:
      'function VV0({usedTokens:$,contextWindow:J,onCompact:Z,buttonClassName:X}){let Y=J>0?Math.min($/J*100,100):0,Q=OD1!==null?OD1:Y;var mk=function(n){return n>=1000?(n/1000).toFixed(1)+"k":String(n)},mc=$>=400000?"#e06c75":$>=200000?"#e5c07b":"#98c379",mw=J>0?J:1e6,mt="Ctx "+Math.round(J>0?Q:$/mw*100)+"% ("+mk($)+"/"+mk(mw)+")";return R("span",{style:{display:"inline-flex",alignItems:"center",gap:"4px"},children:[J>0&&F(i75,{percentageUsed:Q,onCompact:Z,buttonClassName:X}),F("span",{style:{color:mc,fontSize:"11px",whiteSpace:"nowrap"},title:"Contexto usado (tokens/janela). Cor pelo token bruto: 200k amarelo, 400k vermelho.",children:mt})]})}',
    marker: 'mw=J>0?J:1e6,mt="Ctx "'
  },
  {
    id: "contextFullWindow",
    title: "Ctx conta sobre a janela inteira (1000k), igual à status line",
    file: "webview/index.js",
    find: "contextWindow:$.usageData.value.contextWindow-$.usageData.value.maxOutputTokens-13000,",
    replace: "contextWindow:$.usageData.value.contextWindow/*claude-maia*/,",
    marker: "contextWindow:$.usageData.value.contextWindow/*claude-maia*/,"
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
      const count =
        typeof p.find === "string"
          ? content.split(p.find).length - 1
          : (content.match(new RegExp(p.find.source, "g")) ?? []).length;
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
  const run = async (interactive: boolean) => {
    if (!vscode.workspace.getConfiguration("claudeMaia").get<boolean>("patchClaudeCode", true) && !interactive) {
      return;
    }
    const r = applyPatches(log);
    if (!r.extensionDir) {
      if (interactive) {
        void vscode.window.showWarningMessage(
          "Claude Maia: extensão Claude Code (anthropic.claude-code) não encontrada."
        );
      }
      return;
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
