/**
 * stage-1-validator.test.ts (#581)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateOutputsPresent,
  validateAiRelevanceRatio,
  validateEiaFormat,
  validateDriveSyncConfirmed,
  validateSequentialNumbering,
  validateSectionMinimums,
  runStage1Validation,
} from "../scripts/lib/stage-1-validator.ts";

// Default options pra rodar os testes de integração sem trip nos novos
// assertions adicionados pós-#776 (drive_sync, section_minimums) — fixtures
// existentes não populam drive-cache nem 5+ artigos por bucket.
const TEST_OPTS_NO_AUX = {
  driveCachePath: null,
  sectionMinimums: { minLancamento: 0, minPesquisa: 0, minNoticias: 0 },
};

describe("validateOutputsPresent (#581)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stage1-validator-"));
    mkdirSync(join(tmpDir, "_internal"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("blocker quando 01-categorized.md ausente", () => {
    const result = validateOutputsPresent(tmpDir);
    assert.equal(result.status, "blocker");
    assert.ok(result.message.includes("01-categorized.md"));
  });

  it("warn quando arquivo presente mas < 200 bytes", () => {
    writeFileSync(join(tmpDir, "01-categorized.md"), "# tiny\n", "utf8");
    writeFileSync(join(tmpDir, "_internal", "01-categorized.json"), JSON.stringify({ noticias: [] }), "utf8");
    const result = validateOutputsPresent(tmpDir);
    assert.equal(result.status, "warn");
    assert.ok(result.message.includes("pequenos"));
  });

  it("ok quando ambos arquivos presentes e > 200 bytes", () => {
    writeFileSync(join(tmpDir, "01-categorized.md"), "x".repeat(300), "utf8");
    writeFileSync(join(tmpDir, "_internal", "01-categorized.json"), JSON.stringify({ noticias: [], extra: "x".repeat(300) }), "utf8");
    const result = validateOutputsPresent(tmpDir);
    assert.equal(result.status, "ok");
  });
});

describe("validateAiRelevanceRatio (#581 → #580)", () => {
  it("ok quando 100% on-topic", () => {
    const categorized = {
      noticias: [
        { url: "u1", title: "GPT-5 launches" },
        { url: "u2", title: "New diffusion model from Anthropic" },
        { url: "u3", title: "LLM benchmarks update" },
      ],
    };
    const result = validateAiRelevanceRatio(categorized);
    assert.equal(result.status, "ok");
    assert.equal((result.details as Record<string, unknown>).ratio, 1);
  });

  it("warn quando < 70% on-topic (default threshold)", () => {
    const categorized = {
      noticias: [
        { url: "u1", title: "GPT-5 release" }, // on-topic (match GPT)
        { url: "u2", title: "Stock market analysis" }, // off-topic
        { url: "u3", title: "Political coverage" }, // off-topic
        { url: "u4", title: "Recipe of the day" }, // off-topic
      ],
    };
    const result = validateAiRelevanceRatio(categorized);
    assert.equal(result.status, "warn");
    const details = result.details as Record<string, unknown>;
    assert.equal(details.total, 4);
    assert.equal(details.on_topic, 1);
    assert.equal(details.off_topic_count, 3);
    assert.ok((details.ratio as number) < 0.7);
  });

  it("ok quando bucket vazio", () => {
    const result = validateAiRelevanceRatio({ noticias: [] });
    assert.equal(result.status, "ok");
    assert.ok(result.message.includes("vazio"));
  });

  it("threshold customizado", () => {
    const categorized = {
      noticias: [
        { url: "u1", title: "GPT-5 launches" },
        { url: "u2", title: "Stock market analysis" },
      ],
    };
    // 50% on-topic. Default 0.7 → warn. Threshold 0.5 → ok.
    assert.equal(validateAiRelevanceRatio(categorized).status, "warn");
    assert.equal(validateAiRelevanceRatio(categorized, { threshold: 0.5 }).status, "ok");
  });

  it("respeita opts.bucket pra checar lancamento ou pesquisa", () => {
    const categorized = {
      noticias: [{ url: "u1", title: "Stock analysis" }],
      lancamento: [{ url: "u2", title: "GPT-5 launches" }],
    };
    // noticias: 0% on-topic → warn
    assert.equal(validateAiRelevanceRatio(categorized, { bucket: "noticias" }).status, "warn");
    // lancamento: 100% on-topic → ok
    assert.equal(validateAiRelevanceRatio(categorized, { bucket: "lancamento" }).status, "ok");
  });

  it("inclui lista dos URLs off-topic em details (max 10)", () => {
    const categorized = {
      noticias: Array.from({ length: 15 }, (_, i) => ({
        url: `https://x.com/${i}`,
        title: "stock market trends",
      })),
    };
    const result = validateAiRelevanceRatio(categorized);
    const offTopic = (result.details as Record<string, unknown>).off_topic_urls as string[];
    assert.equal(offTopic.length, 10, "limita lista a 10 URLs");
  });
});

describe("validateEiaFormat (#581 → #578)", () => {
  it("ok quando hyperlinks Markdown presentes", () => {
    const md = "Operação aérea [Häfeli DH-5](https://pt.wikipedia.org/wiki/H%C3%A4feli_DH-5) — autor desconhecido / [Swisstopo](https://www.swisstopo.admin.ch/) / [Public domain](https://creativecommons.org/publicdomain/mark/1.0/).";
    const result = validateEiaFormat(md);
    assert.equal(result.status, "ok");
  });

  it("warn quando contém UnknownUnknown (artefato de prompt)", () => {
    const md = "Foto autor UnknownUnknown / Wikipedia.";
    const result = validateEiaFormat(md);
    assert.equal(result.status, "warn");
    assert.ok(result.message.includes("Unknown"));
  });

  it("warn quando sem hyperlinks Markdown", () => {
    const md = "Operação aérea — autor desconhecido / Swisstopo / Public domain.";
    const result = validateEiaFormat(md);
    assert.equal(result.status, "warn");
    assert.ok(result.message.includes("hyperlinks"));
  });

  it("ok quando eiaMd é null (edição sem É IA?)", () => {
    const result = validateEiaFormat(null);
    assert.equal(result.status, "ok");
    assert.ok(result.message.includes("ausente"));
  });
});

describe("runStage1Validation (#581) — integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stage1-run-"));
    mkdirSync(join(tmpDir, "_internal"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("agrega assertions e contagens em ValidationResult", () => {
    writeFileSync(join(tmpDir, "01-categorized.md"), "x".repeat(300), "utf8");
    writeFileSync(
      join(tmpDir, "_internal", "01-categorized.json"),
      JSON.stringify({
        noticias: [
          { url: "u1", title: "GPT-5 release", summary: "x".repeat(60) },
          { url: "u2", title: "AI alignment progress", summary: "x".repeat(60) },
          { url: "u3", title: "Transformer benchmarks", summary: "x".repeat(60) },
        ],
      }),
      "utf8",
    );
    writeFileSync(
      join(tmpDir, "01-eia.md"),
      "Foto [aérea](https://wiki.org/x) — autor / [domínio público](https://creativecommons.org/x).",
      "utf8",
    );

    const result = runStage1Validation("260506", tmpDir, TEST_OPTS_NO_AUX);
    assert.equal(result.edition, "260506");
    assert.equal(result.blocking_count, 0);
    assert.equal(result.warning_count, 0);
    assert.ok(result.ok_count >= 3, `ok_count >= 3 (outputs + ratio + eia), got ${result.ok_count}`);
  });

  it("blocker aborta runs subsequentes (não roda ratio nem eia se outputs ausentes)", () => {
    // Sem 01-categorized.md → outputs blocker → demais não rodam
    const result = runStage1Validation("260506", tmpDir, TEST_OPTS_NO_AUX);
    assert.equal(result.blocking_count, 1);
    assert.equal(result.assertions.length, 1, "só uma assertion (outputs) — demais skipadas");
    assert.equal(result.assertions[0].name, "outputs_present");
  });

  it("warn de ai_relevance_ratio + ok de outputs = 1 warn, 2 ok", () => {
    writeFileSync(join(tmpDir, "01-categorized.md"), "x".repeat(300), "utf8");
    writeFileSync(
      join(tmpDir, "_internal", "01-categorized.json"),
      JSON.stringify({
        noticias: [
          { url: "u1", title: "Stock market down", summary: "x".repeat(60) },
          { url: "u2", title: "Soccer scores", summary: "x".repeat(60) },
          { url: "u3", title: "Recipe corner", summary: "x".repeat(60) },
        ],
      }),
      "utf8",
    );
    // sem 01-eia.md → assertion eia retorna ok com "ausente"

    const result = runStage1Validation("260506", tmpDir, TEST_OPTS_NO_AUX);
    assert.equal(result.blocking_count, 0);
    assert.equal(result.warning_count, 1);
    assert.ok(result.ok_count >= 2, `ok_count >= 2 (outputs + section_minimums + ...), got ${result.ok_count}`);
    const ratio = result.assertions.find((a) => a.name === "ai_relevance_ratio");
    assert.equal(ratio?.status, "warn");
  });
});

// ─── Tests for new assertions added in this PR ─────────────────────────────

describe("validateDriveSyncConfirmed (#581 → #577)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "drive-sync-validator-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("ok quando cachePath é null (drive_sync desabilitado)", () => {
    const result = validateDriveSyncConfirmed(null, "260506");
    assert.equal(result.status, "ok");
    assert.ok(result.message.includes("desabilitado"));
  });

  it("warn quando cache não existe", () => {
    const cachePath = join(tmpDir, "drive-cache.json");
    const result = validateDriveSyncConfirmed(cachePath, "260506");
    assert.equal(result.status, "warn");
    assert.ok(result.message.includes("ausente") || result.message.includes("não foi possível"));
  });

  it("warn quando edition entry sem push_count", () => {
    const cachePath = join(tmpDir, "drive-cache.json");
    writeFileSync(cachePath, JSON.stringify({ editions: { "260506": { files: {} } } }), "utf8");
    const result = validateDriveSyncConfirmed(cachePath, "260506", ["01-categorized.md"]);
    assert.equal(result.status, "warn");
    assert.ok(result.message.includes("01-categorized.md"));
  });

  it("ok quando push_count > 0 para todos os arquivos requeridos", () => {
    const cachePath = join(tmpDir, "drive-cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        editions: {
          "260506": {
            files: {
              "01-categorized.md": { push_count: 1 },
            },
          },
        },
      }),
      "utf8",
    );
    const result = validateDriveSyncConfirmed(cachePath, "260506", ["01-categorized.md"]);
    assert.equal(result.status, "ok");
  });
});

describe("validateSequentialNumbering (#581 → #579)", () => {
  it("ok quando MD não tem itens numerados", () => {
    const md = "# Título\n\nTexto livre sem listas numeradas.\n";
    const result = validateSequentialNumbering(md);
    assert.equal(result.status, "ok");
  });

  it("ok quando numeração é contínua 1..N cross-section", () => {
    const md = `## Lançamentos

1. [80] Item A — https://a.com — 2026-04-25
2. [75] Item B — https://b.com — 2026-04-25

## Pesquisas

3. [70] Paper C — https://c.com — 2026-04-25

## Notícias

4. [65] News D — https://d.com — 2026-04-25
5. [60] News E — https://e.com — 2026-04-25
`;
    const result = validateSequentialNumbering(md);
    assert.equal(result.status, "ok");
  });

  it("warn quando numeração reseta por seção (cenário #579)", () => {
    const md = `## Lançamentos

1. Item A — https://a.com — 2026-04-25
2. Item B — https://b.com — 2026-04-25

## Pesquisas

1. Paper C — https://c.com — 2026-04-25

## Notícias

1. News D — https://d.com — 2026-04-25
`;
    const result = validateSequentialNumbering(md);
    assert.equal(result.status, "warn");
    assert.ok(result.message.includes("não-sequencial") || result.message.includes("#579"));
  });

  it("warn quando numeração começa em 5 (gap inicial)", () => {
    const md = `## Lançamentos

5. Item — https://a.com — 2026-04-25
6. Item — https://b.com — 2026-04-25
`;
    const result = validateSequentialNumbering(md);
    assert.equal(result.status, "warn");
  });
});

describe("validateSectionMinimums (#581 → #488)", () => {
  it("ok quando todos os mínimos atingidos (3/3/5)", () => {
    const categorized = {
      lancamento: [{ url: "1" }, { url: "2" }, { url: "3" }],
      pesquisa: [{ url: "1" }, { url: "2" }, { url: "3" }],
      noticias: [{ url: "1" }, { url: "2" }, { url: "3" }, { url: "4" }, { url: "5" }],
    };
    const result = validateSectionMinimums(categorized);
    assert.equal(result.status, "ok");
  });

  it("warn quando lançamentos abaixo do mínimo", () => {
    const categorized = {
      lancamento: [{ url: "1" }],
      pesquisa: [{ url: "1" }, { url: "2" }, { url: "3" }],
      noticias: Array.from({ length: 5 }, (_, i) => ({ url: `${i}` })),
    };
    const result = validateSectionMinimums(categorized);
    assert.equal(result.status, "warn");
    assert.ok(result.message.includes("lancamento 1/3"));
  });

  it("warn lista todos os shortfalls juntos", () => {
    const categorized = { lancamento: [], pesquisa: [], noticias: [] };
    const result = validateSectionMinimums(categorized);
    assert.equal(result.status, "warn");
    assert.ok(result.message.includes("lancamento 0/3"));
    assert.ok(result.message.includes("pesquisa 0/3"));
    assert.ok(result.message.includes("noticias 0/5"));
  });

  it("respeita opts override (mínimos custom)", () => {
    const categorized = { lancamento: [{ url: "1" }], pesquisa: [], noticias: [] };
    const result = validateSectionMinimums(categorized, {
      minLancamento: 1,
      minPesquisa: 0,
      minNoticias: 0,
    });
    assert.equal(result.status, "ok");
  });
});
