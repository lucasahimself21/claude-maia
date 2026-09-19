// Regras do navegador no ~/.claude/CLAUDE.md: a Claude Maia é quem liga o Claude in Chrome (patch
// autoBrowser), então é ela que garante no CLAUDE.md como a conexão/reconexão e as abas funcionam.
// O bloco fica entre marcadores e é reescrito se alguém mudar o texto; o resto do arquivo é do Lucas.
// A regra de reconexão depende do sistema (comandos do Mac não existem no Windows/Linux).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CLAUDE_MD_PATH = path.join(os.homedir(), ".claude", "CLAUDE.md");
const START = "<!-- claude-maia:navegador -->";
const END = "<!-- /claude-maia:navegador -->";
const SECTION = "## Navegador e geração";

const RECONNECT_URL = "https://clau.de/chrome/reconnect";

const RECONNECT_BY_PLATFORM: Record<string, string> = {
  darwin:
    "Chrome fechado (`pgrep -x \"Google Chrome\"` vazio): `open -gj -a \"Google Chrome\"` (em segundo plano, sem trazer pra frente), espere ~4s e repita a chamada. Chrome aberto: abra a URL de reconexão da extensão numa aba da janela que já existe (a extensão intercepta, reconecta e fecha a aba sozinha; o Chrome não vem pra frente): `osascript -e 'tell application \"Google Chrome\"' -e 'set w to window 1' -e 'set a to active tab index of w' -e 'make new tab at end of tabs of w with properties {URL:\"" +
    RECONNECT_URL +
    "\"}' -e 'set active tab index of w to a' -e 'end tell'`, ~4s e repita. Nada pisca: a aba fica 1-2s no fim da barra de abas, nunca em primeiro plano. **NUNCA feche/reinicie o Chrome** (`quit app`, `killall`, fechar janelas que não são suas)",
  win32:
    'Abra a URL de reconexão da extensão no Chrome: no Git Bash `cmd //c start chrome "' +
    RECONNECT_URL +
    '"`, no PowerShell `Start-Process chrome "' +
    RECONNECT_URL +
    '"` (Chrome fechado: abre; aberto: vira uma aba na janela que já existe; a extensão intercepta, reconecta e fecha a aba sozinha), espere ~4s e repita a chamada. **NUNCA feche/reinicie o Chrome** (`taskkill`, `Stop-Process`, fechar janelas que não são suas)',
  linux:
    'Abra a URL de reconexão da extensão no Chrome: `google-chrome "' +
    RECONNECT_URL +
    '" &` (Chrome fechado: abre; aberto: vira uma aba na janela que já existe; a extensão intercepta, reconecta e fecha a aba sozinha), espere ~4s e repita a chamada. **NUNCA feche/reinicie o Chrome** (`pkill`, `killall`, fechar janelas que não são suas)'
};

/** Regras pro sistema informado (padrão: o que está rodando). */
export function browserRules(platform: string = process.platform): string[] {
  const reconnect = RECONNECT_BY_PLATFORM[platform] ?? RECONNECT_BY_PLATFORM.linux;
  return [
    "- **Extensão Claude in Chrome é o navegador padrão** pra tudo (abrir site, testar, print, login, baixar, automação): usa meu Chrome principal, já logado, e não pede aprovação por site. Uso o Claude Code pela extensão do VS Code (chat lateral). O navegador liga sozinho na primeira mensagem de cada chat (extensão Claude Maia, patch `autoBrowser`). Nunca o navegador interno do app nem abrir no navegador padrão do sistema (`open`/`start`/`xdg-open`).",
    '- **Se der "Browser extension is not connected":** você resolve, sem depender da Claude Maia e **sem abrir janela nova**. ' +
      reconnect +
      " nem crie janela nova: eu posso estar usando; se nem assim conectar, me avise em uma linha e pare.",
    '- **Abas:** cada chat tem a própria janela/grupo "Claude (MCP)" (a extensão sempre abre janela nova ao criar o grupo). Ao entrar, feche abas sobrando do grupo; ao terminar uma tarefa, feche as que sobraram e deixe uma aberta, pra não abrir outra janela no próximo pedido do mesmo chat. Só feche a última quando a conversa acabar.'
  ];
}

export const BROWSER_RULES = browserRules();

function block(platform: string): string {
  return [START, ...browserRules(platform), END].join("\n");
}

/** Linhas antigas soltas (sem marcador) que o bloco substitui, pra não duplicar. */
const LEGACY_PREFIXES = ["- **Extensão Claude in Chrome", '- **Se der "Browser extension', "- **Abas:**"];

/** Devolve o conteúdo com o bloco garantido, ou undefined se já está certo. */
export function withBrowserRules(content: string, platform: string = process.platform): string | undefined {
  const wanted = block(platform);
  const s = content.indexOf(START);
  const e = content.indexOf(END);
  if (s !== -1 && e > s) {
    const current = content.slice(s, e + END.length);
    return current === wanted ? undefined : content.slice(0, s) + wanted + content.slice(e + END.length);
  }
  const lines = content.split("\n").filter((l) => !LEGACY_PREFIXES.some((p) => l.trim().startsWith(p)));
  const idx = lines.findIndex((l) => l.trim() === SECTION);
  if (idx === -1) {
    const tail = content.endsWith("\n") ? "" : "\n";
    return content + tail + "\n" + SECTION + "\n\n" + wanted + "\n";
  }
  // logo depois do título (pula a linha em branco)
  let at = idx + 1;
  if (lines[at]?.trim() === "") {
    at++;
  }
  lines.splice(at, 0, wanted);
  return lines.join("\n");
}

export function ensureClaudeMdBrowserRules(log: (msg: string) => void): void {
  try {
    if (!fs.existsSync(CLAUDE_MD_PATH)) {
      return;
    }
    const content = fs.readFileSync(CLAUDE_MD_PATH, "utf8");
    const next = withBrowserRules(content);
    if (next === undefined) {
      return;
    }
    fs.writeFileSync(CLAUDE_MD_PATH, next);
    log(`[claude.md] regras do navegador (conexão, reconexão, abas) garantidas pra ${process.platform}`);
  } catch (err) {
    log(`[claude.md] não deu pra checar/atualizar (${String(err)})`);
  }
}
