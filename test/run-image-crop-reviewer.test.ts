/**
 * test/run-image-crop-reviewer.test.ts (#3951)
 *
 * Testes unitários para scripts/run-image-crop-reviewer.ts.
 *
 * O núcleo do revisor é um subagente vision/multimodal (não unit-testável
 * aqui — precisaria do Agent tool contra imagens reais, #207 impede
 * dispatch de dentro de um subagente overnight). A lógica TS de
 * descoberta/orquestração/parsing É 100% testável:
 *
 *  (a) discoverCropPairs: descoberta determinística dos pares hero/crop no disco.
 *  (b) normalizeCropReviewResult: valida e normaliza o output do subagente.
 *  (c) formatGateSummary: formata a seção do gate (sempre warning-only).
 *  (d) CLI (modo descoberta + modo --input-json): wiring determinístico,
 *      exit codes, persistência do JSON.
 *
 * Nenhum teste aqui avalia a QUALIDADE do julgamento do agente vision —
 * apenas o mecanismo de dispatch/wiring/warning ao redor dele (ver PR body).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  discoverCropPairs,
  normalizeCropReviewResult,
  formatGateSummary,
  type CropReviewResult,
} from "../scripts/run-image-crop-reviewer.ts";

function runCli(editionDir: string, extraArgs: string[] = []) {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "run-image-crop-reviewer.ts");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--edition-dir", editionDir, ...extraArgs],
    { cwd: projectRoot, encoding: "utf8" },
  );
}

function makeTmpEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "crop-reviewer-test-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// discoverCropPairs
// ---------------------------------------------------------------------------

describe("discoverCropPairs (#3951)", () => {
  it("descobre par completo (hero 2:1 + crop 1:1) quando ambos existem", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(join(dir, "04-d1-2x1.jpg"), "fake-jpg-bytes");
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "fake-jpg-bytes");
      const pairs = discoverCropPairs(dir);
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0].destaque, "d1");
      assert.ok(pairs[0].hero_path?.endsWith("04-d1-2x1.jpg"));
      assert.ok(pairs[0].crop_path.endsWith("04-d1-1x1.jpg"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hero_path é null quando só o 1:1 nativo existe (sem crop real)", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "fake-jpg-bytes");
      const pairs = discoverCropPairs(dir);
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0].destaque, "d2");
      assert.equal(pairs[0].hero_path, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição de 2 destaques (sem d3) não inclui d3 na lista — #2316/#3369", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(join(dir, "04-d1-2x1.jpg"), "x");
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "x");
      writeFileSync(join(dir, "04-d2-2x1.jpg"), "x");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "x");
      // sem 04-d3-*
      const pairs = discoverCropPairs(dir);
      assert.equal(pairs.length, 2);
      assert.ok(!pairs.some((p) => p.destaque === "d3"), "d3 não deve aparecer sem arquivo no disco");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição de 3 destaques inclui os 3 pares", () => {
    const dir = makeTmpEdition();
    try {
      for (const d of ["d1", "d2", "d3"]) {
        writeFileSync(join(dir, `04-${d}-2x1.jpg`), "x");
        writeFileSync(join(dir, `04-${d}-1x1.jpg`), "x");
      }
      const pairs = discoverCropPairs(dir);
      assert.equal(pairs.length, 3);
      assert.deepEqual(pairs.map((p) => p.destaque).sort(), ["d1", "d2", "d3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nenhuma imagem no disco → array vazio", () => {
    const dir = makeTmpEdition();
    try {
      assert.deepEqual(discoverCropPairs(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeCropReviewResult
// ---------------------------------------------------------------------------

describe("normalizeCropReviewResult (#3951)", () => {
  it("normaliza output bem-formado do subagente", () => {
    const raw = {
      edition: "260722",
      checked_at: "2026-07-22T10:00:00.000Z",
      results: [
        { destaque: "d1", status: "ok" },
        { destaque: "d2", status: "warn", motivo: "sujeito cortado", sugestao: "regenerar" },
      ],
    };
    const result = normalizeCropReviewResult(raw, "260722");
    assert.equal(result.edition, "260722");
    assert.equal(result.results.length, 2);
    assert.equal(result.summary.total, 2);
    assert.equal(result.summary.ok, 1);
    assert.equal(result.summary.warn, 1);
  });

  it("filtra entries inválidas (destaque fora de d1/d2/d3, status inválido)", () => {
    const raw = {
      results: [
        { destaque: "d1", status: "ok" },
        { destaque: "d4", status: "ok" }, // destaque inválido
        { destaque: "d2", status: "maybe" }, // status inválido
        null, // inválido
      ],
    };
    const result = normalizeCropReviewResult(raw, "260722");
    assert.equal(result.results.length, 1, "deve filtrar entries inválidas");
    assert.equal(result.results[0].destaque, "d1");
  });

  it("recalcula summary a partir dos results, independente do raw", () => {
    const raw = {
      results: [
        { destaque: "d1", status: "warn" },
        { destaque: "d2", status: "warn" },
        { destaque: "d3", status: "ok" },
      ],
      summary: { total: 999, ok: 999, warn: 0 }, // valores errados propositais
    };
    const result = normalizeCropReviewResult(raw, "260722");
    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.warn, 2);
    assert.equal(result.summary.ok, 1);
  });

  it("results vazio → summary zerado", () => {
    const result = normalizeCropReviewResult({ results: [] }, "260722");
    assert.equal(result.summary.total, 0);
    assert.equal(result.summary.ok, 0);
    assert.equal(result.summary.warn, 0);
  });

  it("lança erro se raw não é objeto", () => {
    assert.throws(() => normalizeCropReviewResult(null, "260722"), /não é um objeto JSON/);
    assert.throws(() => normalizeCropReviewResult("string", "260722"), /não é um objeto JSON/);
  });

  it("motivo/sugestao ausentes viram undefined, não string vazia", () => {
    const result = normalizeCropReviewResult({ results: [{ destaque: "d1", status: "ok" }] }, "260722");
    assert.equal(result.results[0].motivo, undefined);
    assert.equal(result.results[0].sugestao, undefined);
  });
});

// ---------------------------------------------------------------------------
// formatGateSummary — sempre warning-only, nunca linguagem de bloqueio
// ---------------------------------------------------------------------------

const EMPTY_RESULT: CropReviewResult = {
  edition: "260722",
  checked_at: "2026-07-22T10:00:00Z",
  results: [],
  summary: { total: 0, ok: 0, warn: 0 },
};

describe("formatGateSummary (#3951)", () => {
  it("sem results → mensagem informativa", () => {
    const s = formatGateSummary(EMPTY_RESULT);
    assert.ok(s.includes("REVISOR DE CROP"));
    assert.ok(s.includes("Nenhum destaque"));
  });

  it("todos ok → mensagem positiva, sem ⚠️", () => {
    const result: CropReviewResult = {
      ...EMPTY_RESULT,
      results: [
        { destaque: "d1", status: "ok" },
        { destaque: "d2", status: "ok" },
      ],
      summary: { total: 2, ok: 2, warn: 0 },
    };
    const s = formatGateSummary(result);
    assert.ok(s.includes("✅"));
    assert.ok(!s.includes("⚠️"));
  });

  it("destaque com warn aparece com ⚠️ + motivo + sugestão", () => {
    const result: CropReviewResult = {
      ...EMPTY_RESULT,
      results: [
        { destaque: "d1", status: "ok" },
        { destaque: "d2", status: "warn", motivo: "sujeito cortado nas bordas", sugestao: "regenerar D2" },
      ],
      summary: { total: 2, ok: 1, warn: 1 },
    };
    const s = formatGateSummary(result);
    assert.ok(s.includes("⚠️"));
    assert.ok(s.includes("D2"));
    assert.ok(s.includes("sujeito cortado nas bordas"));
    assert.ok(s.includes("regenerar D2"));
  });

  it("nunca inclui linguagem de bloqueio (warning-only, #3951)", () => {
    const result: CropReviewResult = {
      ...EMPTY_RESULT,
      results: [{ destaque: "d1", status: "warn", motivo: "x" }],
      summary: { total: 1, ok: 0, warn: 1 },
    };
    const s = formatGateSummary(result);
    assert.ok(!/bloque|abort|impedir|não pode publicar/i.test(s), `não deve conter linguagem de bloqueio: ${s}`);
    assert.ok(s.includes("Decisão final"), "deve remeter a decisão final ao editor");
  });
});

// ---------------------------------------------------------------------------
// CLI — modo descoberta (default)
// ---------------------------------------------------------------------------

describe("run-image-crop-reviewer CLI — modo descoberta (#3951)", () => {
  it("com imagens no disco → exit 0 + JSON com pairs no stdout", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(join(dir, "04-d1-2x1.jpg"), "x");
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "x");
      const result = runCli(dir);
      assert.equal(result.status, 0, `exit 0 esperado. stderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout) as { edition: string; pairs: unknown[] };
      assert.ok(Array.isArray(parsed.pairs));
      assert.equal(parsed.pairs.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem nenhuma imagem no disco → exit 1 (Stage 3 ainda não gerou imagens)", () => {
    const dir = makeTmpEdition();
    try {
      const result = runCli(dir);
      assert.equal(result.status, 1, "deve falhar quando não há imagens");
      assert.ok(result.stderr.includes("Nenhum par"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha com exit 1 se --edition-dir não fornecido", () => {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "run-image-crop-reviewer.ts");
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("edition-dir"));
  });
});

// ---------------------------------------------------------------------------
// CLI — modo --input-json (integração com output do subagente)
// ---------------------------------------------------------------------------

describe("run-image-crop-reviewer CLI --input-json (#3951)", () => {
  it("grava 04-crop-review.json e mostra warning no stdout — sempre exit 0", () => {
    const dir = makeTmpEdition();
    try {
      const agentOutput = {
        edition: "260722",
        checked_at: "2026-07-22T10:00:00Z",
        results: [
          { destaque: "d1", status: "ok" },
          { destaque: "d2", status: "warn", motivo: "sujeito cortado", sugestao: "regenerar" },
        ],
      };
      const inputJsonPath = join(dir, "agent-output.json");
      writeFileSync(inputJsonPath, JSON.stringify(agentOutput), "utf8");

      const result = runCli(dir, ["--input-json", inputJsonPath]);
      // Warning-only: mesmo com warn presente, exit deve ser sempre 0 (#3951,
      // mesmo racional do fact-checker #2468 finding 4 — exit != 0 esconderia
      // o warning do editor em vez de mostrá-lo no gate).
      assert.equal(result.status, 0, `exit 0 esperado (warning-only). stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("⚠️"), "stdout deve conter ⚠️ para o warn");

      const outPath = join(dir, "_internal", "04-crop-review.json");
      assert.ok(existsSync(outPath), "04-crop-review.json deve ter sido gravado");
      const saved = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(saved.summary.warn, 1);
      assert.equal(saved.summary.ok, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("todos ok → exit 0 + stdout sem ⚠️", () => {
    const dir = makeTmpEdition();
    try {
      const agentOutput = {
        results: [
          { destaque: "d1", status: "ok" },
          { destaque: "d2", status: "ok" },
        ],
      };
      const inputJsonPath = join(dir, "agent-output.json");
      writeFileSync(inputJsonPath, JSON.stringify(agentOutput), "utf8");

      const result = runCli(dir, ["--input-json", inputJsonPath]);
      assert.equal(result.status, 0);
      assert.ok(!result.stdout.includes("⚠️"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--input-json apontando pra arquivo inexistente → exit 1", () => {
    const dir = makeTmpEdition();
    try {
      const result = runCli(dir, ["--input-json", join(dir, "nao-existe.json")]);
      assert.equal(result.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
