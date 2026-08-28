/**
 * test/carousel-text-overflow-stage2.test.ts (#6439, regressão #633)
 *
 * `carousel-text-overflow` (a checagem "parágrafo do carrossel diário não
 * cabe no card em tamanho fixo", #6078) rodava só no gate do Stage 4 — tarde
 * o bastante pra custar reescrita manual + 2 rodadas de humanizador (edição
 * 260828, issue #6439: 5 de 9 parágrafos entre 313 e 368 chars estouraram
 * apesar do teto do prompt já estar em ~260, #6136). #6439 registra a MESMA
 * checagem pura (`checkCarouselTextOverflow`, `scripts/lib/invariant-checks/
 * stage-4.ts`) também em `STAGE_2_RULES`, pra falhar cedo (logo após o
 * `social-writer`, dispatch barato de repetir) em vez de só no gate.
 *
 * Este teste cobre exatamente o cenário da issue: fixture com parágrafo de
 * ~300 caracteres (acima do teto de 260 do prompt e do que cabe em 62px)
 * deve ser rejeitada pelo invariante do Stage 2 — não só pelo do Stage 4.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGE_2_RULES, checkCarouselTextOverflowStage2 } from "../scripts/lib/invariant-checks/stage-2.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";

function makeEdition(destaqueCount: 2 | 3 = 3): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-carousel-stage2-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(
    join(dir, "_internal", "01-approved-capped.json"),
    JSON.stringify({ highlights: Array.from({ length: destaqueCount }, () => ({})) }),
  );
  return dir;
}

function writeSocial(dir: string, textoD1: string): void {
  writeFileSync(
    join(dir, "03-social.md"),
    ["# Social", "", "## d1", "", textoD1, "", "## d2", "", "Texto d2.", "", "## d3", "", "Texto d3.", ""].join("\n"),
    "utf8",
  );
}

/** Parágrafo denso de `n` caracteres, sem pontuação — mesmo padrão do fixture irmão em test/carousel-freshness-invariants.test.ts. */
function paraDe(n: number): string {
  let s = "";
  while (s.length < n) s += (s ? " " : "") + "palavra";
  return s.slice(0, n).trim();
}

describe("carousel-text-overflow registrado no Stage 2 (#6439)", () => {
  it("a regra está registrada em STAGE_2_RULES", () => {
    const ids = getRulesForStage(2).map((r) => r.id);
    assert.ok(ids.includes("carousel-text-overflow"), "sem registro, check-invariants.ts --stage 2 nunca roda o check");
    const rule = STAGE_2_RULES.find((r) => r.id === "carousel-text-overflow");
    assert.ok(rule);
    assert.equal(rule!.stage, 2);
  });

  it("fixture com parágrafo de ~300 caracteres (issue #6439): ERROR no Stage 2, não só no Stage 4", () => {
    const dir = makeEdition();
    try {
      // 300 chars — acima do teto de ~260 do prompt do social-writer e do que
      // cabe em 62px/12 linhas (DAILY_CAROUSEL_BODY_SIZE). Cenário exato da
      // issue: parágrafo grande demais escapando o teto do prompt.
      writeSocial(dir, [paraDe(80), paraDe(300), paraDe(90)].join("\n\n"));
      const violations = checkCarouselTextOverflowStage2(dir);
      assert.equal(violations.length, 1, "parágrafo de 300 chars deve estourar o card e ser reportado");
      assert.equal(violations[0].rule, "carousel-text-overflow");
      assert.equal(violations[0].severity, "error", "conteúdo que não rasteriza bloqueia, não avisa");
      assert.match(violations[0].message, /## d1/);
      assert.match(violations[0].message, /p2/, "diz QUAL parágrafo (slot) encurtar");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("texto dentro do limite: nenhuma violação no Stage 2", () => {
    const dir = makeEdition();
    try {
      writeSocial(
        dir,
        ["Primeiro parágrafo do destaque um.", "Segundo parágrafo, com a virada.", "Terceiro parágrafo, o fecho."].join(
          "\n\n",
        ),
      );
      assert.deepEqual(checkCarouselTextOverflowStage2(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("03-social.md ausente: silencioso no Stage 2 também (outro check cobre estrutura)", () => {
    const dir = makeEdition();
    try {
      assert.deepEqual(checkCarouselTextOverflowStage2(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
