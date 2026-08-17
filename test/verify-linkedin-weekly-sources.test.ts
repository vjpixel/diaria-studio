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
import { isSourceUsableForSummary, candidatesAvailableForSwap, main as verifyMain } from "../scripts/verify-linkedin-weekly-sources.ts";

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

function writeSelection(
  root: string,
  cycle: string,
  headlines: Array<Record<string, unknown>>,
  headlineCandidatesRanked: Array<Record<string, unknown>> = [],
): void {
  const dir = join(root, "data/weekly", cycle, "_internal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ln-selection.json"),
    JSON.stringify({ cycle, headlines, headlineCandidatesRanked }, null, 2),
    "utf8",
  );
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

  // #5538: manchete kind==="section" com fonte inacessível deve trocar pelo
  // próximo candidato elegível, nunca publicar o stub de 1 linha.
  it('kind==="section" inacessível troca pelo próximo candidato elegível (não publica stub)', async () => {
    const root = mkTmpRoot();
    try {
      writeSelection(
        root,
        "26w34",
        [
          {
            url: "https://exemplo.com/radar-inacessivel",
            title: "Manchete de RADAR (fonte caiu)",
            body: "Só 1 linha levantada.",
            why: "",
            kind: "section",
            editionDate: "260810",
            category: "RADAR",
          },
        ],
        [
          {
            url: "https://exemplo.com/radar-inacessivel",
            title: "Manchete de RADAR (fonte caiu)",
            kind: "section",
            editionDate: "260810",
          },
          {
            url: "https://exemplo.com/proximo-candidato",
            title: "Próximo candidato do ranking",
            body: "Corpo do próximo candidato.",
            why: "",
            kind: "section",
            editionDate: "260811",
            category: "RADAR",
          },
        ],
      );
      process.argv = ["node", "verify-linkedin-weekly-sources.ts", "--cycle", "26w34"];

      const stubVerify = async (url: string) => {
        if (url.includes("radar-inacessivel")) return { verdict: "paywall", finalUrl: url };
        return { verdict: "accessible", finalUrl: url };
      };

      await verifyMain(root, stubVerify as any);

      const selectionPath = join(root, "data/weekly/26w34/_internal/ln-selection.json");
      const written = JSON.parse(readFileSync(selectionPath, "utf8"));
      assert.equal(written.headlines.length, 1);
      assert.equal(written.headlines[0].title, "Próximo candidato do ranking");
      assert.equal(written.headlines[0].url, "https://exemplo.com/proximo-candidato");
      assert.equal(written.headlines[0].sourceAccessibility.accessible, true);
      assert.ok(
        written.warnings.some((w: string) => w.includes("trocada por") && w.includes("#5538")),
        "esperava warning de troca registrado em selection.warnings",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('kind==="section" inacessível SEM candidato de reposição elegível mantém o stub original (fallback, #5538)', async () => {
    const root = mkTmpRoot();
    try {
      writeSelection(
        root,
        "26w35",
        [
          {
            url: "https://exemplo.com/radar-inacessivel",
            title: "Manchete de RADAR (fonte caiu)",
            body: "Só 1 linha levantada.",
            why: "",
            kind: "section",
            editionDate: "260810",
            category: "RADAR",
          },
        ],
        [
          {
            url: "https://exemplo.com/radar-inacessivel",
            title: "Manchete de RADAR (fonte caiu)",
            kind: "section",
            editionDate: "260810",
          },
        ],
      );
      process.argv = ["node", "verify-linkedin-weekly-sources.ts", "--cycle", "26w35"];
      const stubVerify = async (url: string) => ({ verdict: "paywall", finalUrl: url });

      await verifyMain(root, stubVerify as any);

      const selectionPath = join(root, "data/weekly/26w35/_internal/ln-selection.json");
      const written = JSON.parse(readFileSync(selectionPath, "utf8"));
      assert.equal(written.headlines.length, 1);
      assert.equal(written.headlines[0].title, "Manchete de RADAR (fonte caiu)");
      assert.equal(written.headlines[0].sourceAccessibility.accessible, false);
      assert.ok(
        written.warnings.some((w: string) => w.includes("nenhum candidato de reposição elegível")),
        "esperava warning de pool esgotado",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('kind==="destaque" inacessível NUNCA troca (corpo já substancial, comportamento pré-#5538 preservado)', async () => {
    const root = mkTmpRoot();
    try {
      writeSelection(
        root,
        "26w36",
        [
          {
            url: "https://exemplo.com/destaque-inacessivel",
            title: "Destaque com fonte caída",
            body: "Corpo completo de 3 parágrafos já levantado.",
            why: "",
            kind: "destaque",
            editionDate: "260810",
            category: "DESTAQUE 1",
          },
        ],
        [
          {
            url: "https://exemplo.com/destaque-inacessivel",
            title: "Destaque com fonte caída",
            kind: "destaque",
            editionDate: "260810",
          },
          {
            url: "https://exemplo.com/outro-candidato",
            title: "Outro candidato que NÃO deveria ser usado",
            kind: "section",
            editionDate: "260811",
          },
        ],
      );
      process.argv = ["node", "verify-linkedin-weekly-sources.ts", "--cycle", "26w36"];
      const stubVerify = async (url: string) => ({ verdict: "paywall", finalUrl: url });

      await verifyMain(root, stubVerify as any);

      const selectionPath = join(root, "data/weekly/26w36/_internal/ln-selection.json");
      const written = JSON.parse(readFileSync(selectionPath, "utf8"));
      assert.equal(written.headlines[0].title, "Destaque com fonte caída");
      assert.equal(written.headlines[0].sourceAccessibility.accessible, false);
      assert.equal(written.warnings, undefined); // nenhuma troca — sem campo `warnings` novo no output
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("candidatesAvailableForSwap", () => {
  it("filtra candidatos cujas URLs já estão em uso (normalizada)", () => {
    const pool = [
      { url: "https://exemplo.com/a", title: "A" },
      { url: "https://exemplo.com/b/", title: "B" },
      { url: "https://exemplo.com/c", title: "C" },
    ];
    const used = new Set(["https://exemplo.com/a", "https://exemplo.com/b"]);
    const available = candidatesAvailableForSwap(pool, used);
    assert.deepEqual(available.map((c) => c.title), ["C"]);
  });
});
