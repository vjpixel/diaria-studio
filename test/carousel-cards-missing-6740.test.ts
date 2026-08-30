/**
 * test/carousel-cards-missing-6740.test.ts (#6740, regressão #633)
 *
 * Duas frentes do #6740:
 *
 *   1. Causa raiz: `.claude/skills/diaria-3-imagens/SKILL.md` (fluxo
 *      STANDALONE, usado headless por `run-edition-stages.ts` via
 *      `STAGE_PLAN`) nunca chamava `gen-carousel-cards.ts` nem delegava a
 *      `scripts/stage-3-run.ts` — só `.claude/agents/orchestrator-stage-3.md`
 *      (usado por `/diaria-edicao`) sabia do carrossel (#6005 Parte B). Uma
 *      edição rodada via `/diaria-3-imagens --no-gates` reportava OK sem
 *      gerar nenhum dos 12 slides. Coberto por
 *      `test/diaria-3-imagens-card-4x5-5822.test.ts` (atualizado neste PR
 *      para verificar a delegação).
 *
 *   2. Gap no guard: os 3 checks de carrossel existentes
 *      (`carousel-cards-stale`, `carousel-upload-incomplete`,
 *      `carousel-upload-stale`) só comparam DIVERGÊNCIA entre estados que já
 *      existem — cada um sai cedo com `if (!slidesOnDisk) continue`, que é
 *      uma saída legítima quando SÓ aquele destaque não tem carrossel, mas
 *      também engole silenciosamente o caso "NENHUM destaque tem carrossel
 *      nesta edição inteira" (achado ao vivo: `check-invariants --stage 4`
 *      não acusou nada com 0 dos 12 arquivos presentes). Este arquivo testa
 *      o novo `carousel-cards-missing`, que fecha esse buraco.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAROUSEL_SLIDE_SLOTS, carouselSlideFilename } from "../scripts/lib/daily-carousel-card.ts";
import { checkCarouselCardsMissing } from "../scripts/lib/invariant-checks/stage-4.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";

function makeEdition(destaqueCount: 2 | 3 = 3): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-carousel-missing-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(
    join(dir, "_internal", "01-approved-capped.json"),
    JSON.stringify({ highlights: Array.from({ length: destaqueCount }, () => ({})) }),
  );
  return dir;
}

function writeSocial(dir: string, destaques: string[] = ["d1", "d2", "d3"]): void {
  const body = destaques.map((d) => `## ${d}\n\nTexto de ${d}, primeiro parágrafo.\n`).join("\n");
  writeFileSync(join(dir, "03-social.md"), `# Social\n\n${body}`, "utf8");
}

function writeSlides(dir: string, destaque: string): void {
  for (const slot of CAROUSEL_SLIDE_SLOTS) {
    writeFileSync(join(dir, carouselSlideFilename(destaque, slot)), Buffer.from("jpg"));
  }
}

describe("checkCarouselCardsMissing (#6740)", () => {
  it("ERROR quando NENHUM dos 12 slides existe pra uma edição de 3 destaques com texto — o bug ao vivo do #6740", () => {
    const dir = makeEdition(3);
    try {
      writeSocial(dir, ["d1", "d2", "d3"]);
      // Stage 3 rodou (03-social.md existe, tem texto) mas gen-carousel-cards.ts
      // nunca foi invocado — nenhum arquivo 04-d{N}-carousel-*.jpg existe.
      const violations = checkCarouselCardsMissing(dir);
      assert.equal(violations.length, 1, JSON.stringify(violations));
      assert.equal(violations[0].rule, "carousel-cards-missing");
      assert.equal(violations[0].severity, "error", "ausência total é regressão de produto, não degrade-graceful");
      assert.match(violations[0].message, /gen-carousel-cards/);
      assert.match(violations[0].message, /d1, d2, d3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ERROR também numa edição de 2 destaques (não fica restrito a 3)", () => {
    const dir = makeEdition(2);
    try {
      writeSocial(dir, ["d1", "d2"]);
      const violations = checkCarouselCardsMissing(dir);
      assert.equal(violations.length, 1);
      assert.match(violations[0].message, /d1, d2/);
      assert.ok(!/d3/.test(violations[0].message), "edição de 2 destaques não pode citar d3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("limpo quando TODOS os destaques têm carrossel completo (caminho feliz)", () => {
    const dir = makeEdition(3);
    try {
      writeSocial(dir, ["d1", "d2", "d3"]);
      writeSlides(dir, "d1");
      writeSlides(dir, "d2");
      writeSlides(dir, "d3");
      assert.deepEqual(checkCarouselCardsMissing(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("limpo quando ao menos 1 destaque tem carrossel — não é ausência TOTAL (escopo deliberadamente estreito)", () => {
    const dir = makeEdition(3);
    try {
      writeSocial(dir, ["d1", "d2", "d3"]);
      writeSlides(dir, "d1"); // só d1 — d2/d3 podem ter estourado o limite de texto (#6078), best-effort
      assert.deepEqual(
        checkCarouselCardsMissing(dir),
        [],
        "1 destaque com carrossel já basta pra não ser 'ausência total' — outros checks cobrem o parcial",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("limpo sem 03-social.md (Stage 2 nem rodou — não é assunto deste check)", () => {
    const dir = makeEdition(3);
    try {
      assert.deepEqual(checkCarouselCardsMissing(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("limpo quando 03-social.md não tem a seção '# Social' (coberto por carousel-cards-stale, não por este)", () => {
    const dir = makeEdition(3);
    try {
      writeFileSync(join(dir, "03-social.md"), "texto solto sem cabeçalho\n", "utf8");
      assert.deepEqual(checkCarouselCardsMissing(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("limpo quando os destaques não têm texto nenhum no corpo (nada que devesse ter sido rasterizado)", () => {
    const dir = makeEdition(3);
    try {
      writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\n## d2\n\n## d3\n", "utf8");
      assert.deepEqual(checkCarouselCardsMissing(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("está registrada no Stage 4 — sem registro o gate nunca roda o check", () => {
    const ids = getRulesForStage(4).map((r) => r.id);
    assert.ok(ids.includes("carousel-cards-missing"));
  });
});
