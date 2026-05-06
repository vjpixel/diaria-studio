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
  runStage1Validation,
} from "../scripts/lib/stage-1-validator.ts";

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

    const result = runStage1Validation("260506", tmpDir);
    assert.equal(result.edition, "260506");
    assert.equal(result.blocking_count, 0);
    assert.equal(result.warning_count, 0);
    assert.ok(result.ok_count >= 3, `ok_count >= 3 (outputs + ratio + eia), got ${result.ok_count}`);
  });

  it("blocker aborta runs subsequentes (não roda ratio nem eia se outputs ausentes)", () => {
    // Sem 01-categorized.md → outputs blocker → demais não rodam
    const result = runStage1Validation("260506", tmpDir);
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

    const result = runStage1Validation("260506", tmpDir);
    assert.equal(result.blocking_count, 0);
    assert.equal(result.warning_count, 1);
    assert.equal(result.ok_count, 2);
    const ratio = result.assertions.find((a) => a.name === "ai_relevance_ratio");
    assert.equal(ratio?.status, "warn");
  });
});
