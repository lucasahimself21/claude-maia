import * as assert from "assert";
import { tabLabelMatches } from "../../liveSessions";

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
