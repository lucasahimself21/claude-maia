import * as assert from "assert";
import { withBrowserRules, BROWSER_RULES } from "../../claudeMd";

const START = "<!-- claude-maia:navegador -->";
const END = "<!-- /claude-maia:navegador -->";

describe("withBrowserRules", () => {
  it("insere o bloco no topo da seção Navegador e tira as linhas antigas soltas", () => {
    const md = [
      "# Instruções",
      "",
      "## Navegador e geração",
      "",
      "- **Extensão Claude in Chrome é o navegador padrão** texto velho",
      '- **Se der "Browser extension is not connected":** texto velho',
      "- **Abas:** texto velho",
      "- **Problema de geração é seu pra resolver.** fica",
      "",
      "## Outra"
    ].join("\n");
    const out = withBrowserRules(md)!;
    assert.ok(out.includes(START) && out.includes(END));
    assert.strictEqual((out.match(/Browser extension is not connected/g) ?? []).length, 1);
    assert.ok(out.includes("- **Problema de geração é seu pra resolver.** fica"));
    assert.ok(out.indexOf(START) < out.indexOf("Problema de geração"));
    assert.ok(out.indexOf("## Navegador e geração") < out.indexOf(START));
  });

  it("não mexe quando o bloco já está igual", () => {
    const md = "## Navegador e geração\n\n" + [START, ...BROWSER_RULES, END].join("\n") + "\n";
    assert.strictEqual(withBrowserRules(md), undefined);
  });

  it("reescreve o bloco quando alguém alterou o texto", () => {
    const md = "## Navegador e geração\n\n" + [START, "- texto mexido", END].join("\n") + "\n- **Problema** fica\n";
    const out = withBrowserRules(md)!;
    assert.ok(!out.includes("- texto mexido"));
    assert.ok(out.includes(BROWSER_RULES[1]));
    assert.ok(out.endsWith("- **Problema** fica\n"));
  });

  it("sem a seção, cria no fim", () => {
    const out = withBrowserRules("# Só isso\n")!;
    assert.ok(out.startsWith("# Só isso\n"));
    assert.ok(out.includes("## Navegador e geração\n\n" + START));
  });
});
