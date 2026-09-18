import * as assert from "assert";
import { tabLabelMatches, sessionsMatchingTab } from "../../liveSessions";

describe("tabLabelMatches", () => {
  it("matches an identical label", () => {
    assert.strictEqual(tabLabelMatches("Google", "Google"), true);
  });

  it("matches a label truncated with an ellipsis character", () => {
    assert.strictEqual(tabLabelMatches("Producer gerar producer.…", "Producer gerar producer.txt regra"), true);
  });

  it("matches a label truncated with three dots", () => {
    assert.strictEqual(tabLabelMatches("Producer gerar...", "Producer gerar producer.txt regra"), true);
  });

  it("does not match a different title", () => {
    assert.strictEqual(tabLabelMatches("Google", "Google Ads"), false);
    assert.strictEqual(tabLabelMatches("Producer…", "Google"), false);
  });

  it("does not treat a bare ellipsis as a wildcard", () => {
    assert.strictEqual(tabLabelMatches("…", "Google"), false);
  });
});

describe("sessionsMatchingTab", () => {
  const escala = { title: "ESCALA", titles: ["ESCALA", "Mano bora otimizar"] };
  const ade = { title: "ADE", titles: ["ADE", "ESCALA", "extensao"] };

  it("título atual ganha de título antigo", () => {
    assert.deepStrictEqual(sessionsMatchingTab("ESCALA", [ade, escala]), [escala]);
  });

  it("sem título atual casando, usa o histórico (aba renomeada)", () => {
    assert.deepStrictEqual(sessionsMatchingTab("extensao", [ade, escala]), [ade]);
  });

  it("nada casa", () => {
    assert.deepStrictEqual(sessionsMatchingTab("Outro", [ade, escala]), []);
  });
});
