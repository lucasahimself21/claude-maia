// Regras do navegador no ~/.claude/CLAUDE.md: a Claude Maia é quem liga o Claude in Chrome (patch
// autoBrowser), então é ela que garante no CLAUDE.md como a conexão/reconexão e as abas funcionam.
// O bloco fica entre marcadores e é reescrito se alguém mudar o texto; o resto do arquivo é do Lucas.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CLAUDE_MD_PATH = path.join(os.homedir(), ".claude", "CLAUDE.md");
const START = "<!-- claude-maia:navegador -->";
const END = "<!-- /claude-maia:navegador -->";
const SECTION = "## Navegador e geração";

export const BROWSER_RULES = [
  "- **Extensão Claude in Chrome é o navegador padrão** pra tudo (abrir site, testar, print, login, baixar, automação): usa meu Chrome principal, já logado, e não pede aprovação por site. Uso o Claude Code pela extensão do VS Code (chat lateral). O navegador liga sozinho na primeira mensagem de cada chat (extensão Claude Maia, patch `autoBrowser`). Nunca o navegador interno do app nem `open` no navegador padrão.",
  '- **Se der "Browser extension is not connected":** você resolve, sem depender da Claude Maia. Chrome fechado (`pgrep -x "Google Chrome"` vazio): `open -a "Google Chrome"`, espere ~4s e repita a chamada. Chrome já aberto: abra só uma janela nova (`osascript -e \'tell application "Google Chrome" to make new window\'`), ~4s e repita. **NUNCA feche/reinicie o Chrome** (`quit app`, `killall`, fechar janelas que não são suas): eu posso estar usando; se nem a janela nova conectar, me avise em uma linha e pare.',
  '- **Abas:** cada chat tem a própria janela/grupo "Claude (MCP)" (a extensão sempre abre janela nova ao criar o grupo). Ao entrar, feche abas sobrando do grupo; ao terminar uma tarefa, feche as que sobraram e deixe uma aberta, pra não abrir outra janela no próximo pedido do mesmo chat. Só feche a última quando a conversa acabar.'
];

const BLOCK = [START, ...BROWSER_RULES, END].join("\n");

/** Linhas antigas soltas (sem marcador) que o bloco substitui, pra não duplicar. */
const LEGACY_PREFIXES = ["- **Extensão Claude in Chrome", '- **Se der "Browser extension', "- **Abas:**"];

/** Devolve o conteúdo com o bloco garantido, ou undefined se já está certo. */
export function withBrowserRules(content: string): string | undefined {
  const s = content.indexOf(START);
  const e = content.indexOf(END);
  if (s !== -1 && e > s) {
    const current = content.slice(s, e + END.length);
    return current === BLOCK ? undefined : content.slice(0, s) + BLOCK + content.slice(e + END.length);
  }
  const lines = content.split("\n").filter((l) => !LEGACY_PREFIXES.some((p) => l.trim().startsWith(p)));
  const idx = lines.findIndex((l) => l.trim() === SECTION);
  if (idx === -1) {
    const tail = content.endsWith("\n") ? "" : "\n";
    return content + tail + "\n" + SECTION + "\n\n" + BLOCK + "\n";
  }
  // logo depois do título (pula a linha em branco)
  let at = idx + 1;
  if (lines[at]?.trim() === "") {
    at++;
  }
  lines.splice(at, 0, BLOCK);
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
    log("[claude.md] regras do navegador (conexão, reconexão, abas) garantidas");
  } catch (err) {
    log(`[claude.md] não deu pra checar/atualizar (${String(err)})`);
  }
}
