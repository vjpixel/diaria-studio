/**
 * test/verify-linkedin-weekly-sources.test.ts (#5108 item 3)
 *
 * Cobre `isSourceUsableForSummary` (pura) + o boundary real do CLI
 * (`main()`, verifyFn injetado — sem bater rede de verdade) contra um
 * `ln-selection.json` de fixture, mesmo padrão de
 * `select-linkedin-weekly-integration.test.ts`.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSourceUsableForSummary, main as verifyMain } from "../scripts/verify-linkedin-weekly-sources.ts";

describe("isSourceUsableForSummary", () => {
  it("accessible → true", () => {
    assert.equal(isSourceUsableForSummary("accessible", undefined), true);
  });

  it("anti_bot COM access_uncertain (publisher confiável, #320) → true", () => {
    assert.equal(isSourceUsableForSummary("anti_bot", true), true);
  });

  it("anti_bot SEM access_uncertain → false (não é publisher confiável)", () => {
    assert.equal(isSourceUsableForSummary("anti_bot", false), false);
    assert.equal(isSourceUsableForSummary("anti_bot", undefined), false);
  });

  for (const verdict of ["paywall", "blocked", "aggregator", "uncertain", "needs_reverify", "video"]) {
    it(`${verdict} → false (nunca resume a partir de fonte não confirmada acessível)`, () => {
      assert.equal(isSourceUsableForSummary(verdict, undefined), false);
    });
  }
});

const originalArgv = process.argv;
after(() => {
  process.argv = originalArgv;
});

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "verify-linkedin-weekly-sources-test-"));
}

function writeSelection(root: string, cycle: string, headlines: Array<{ url: string; title: string }>): void {
  const dir = join(root, "data/weekly", cycle, "_internal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ln-selection.json"), JSON.stringify({ cycle, headlines }, null, 2), "utf8");
}

describe("main() — boundary real do CLI", () => {
  it("grava sourceAccessibility por headline, sem tocar title/body/why", async () => {
    const root = mkTmpRoot();
    try {
      writeSelection(root, "26w32", [
        { url: "https://exemplo.com/acessivel", title: "Matéria acessível" },
        { url: "https://exemplo.com/paywall", title: "Matéria com paywall" },
      ]);
      process.argv = ["node", "verify-linkedin-weekly-sources.ts", "--cycle", "26w32"];

      const stubVerify = async (url: string) => {
        if (url.includes("paywall")) return { verdict: "paywall", finalUrl: url };
        return { verdict: "accessible", finalUrl: url };
      };

      await verifyMain(root, stubVerify as any);

      const selectionPath = join(root, "data/weekly/26w32/_internal/ln-selection.json");
      const written = JSON.parse(readFileSync(selectionPath, "utf8"));
      assert.equal(written.headlines[0].title, "Matéria acessível");
      assert.equal(written.headlines[0].sourceAccessibility.accessible, true);
      assert.equal(written.headlines[0].sourceAccessibility.verdict, "accessible");
      assert.equal(written.headlines[1].sourceAccessibility.accessible, false);
      assert.equal(written.headlines[1].sourceAccessibility.verdict, "paywall");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem headlines (seleção ainda vazia) — não escreve nada de novo, não lança", async () => {
    const root = mkTmpRoot();
    try {
      writeSelection(root, "26w33", []);
      process.argv = ["node", "verify-linkedin-weekly-sources.ts", "--cycle", "26w33"];
      const stubVerify = async (url: string) => ({ verdict: "accessible", finalUrl: url });
      await verifyMain(root, stubVerify as any);
      assert.ok(existsSync(join(root, "data/weekly/26w33/_internal/ln-selection.json")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
