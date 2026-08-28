/**
 * test/rv-split-preview-format.test.ts (#6447 Fatia 3)
 *
 * Testa a formatação/lógica PURA (sem DOM) do split view de revisão —
 * `scripts/studio-ui/public/rv-split-preview-format.js` — mesmo padrão de
 * test/rv-gate-format.test.ts/test/rv-highlights-format.test.ts: importa o
 * módulo client-side direto (sem harness de DOM/browser).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DRAFT_PREVIEW_DEBOUNCE_MS,
  isDraftPreviewSlug,
  isRawEchoSlug,
  shouldApplyDraftPreviewResponse,
  nextDraftPreviewSeq,
  resolveMobileView,
} from "../scripts/studio-ui/public/rv-split-preview-format.js";

describe("isDraftPreviewSlug", () => {
  it("reviewed e social têm preview reativo (Markdown 1:1 com o preview)", () => {
    assert.equal(isDraftPreviewSlug("reviewed"), true);
    assert.equal(isDraftPreviewSlug("social"), true);
  });

  it("categorized NÃO tem preview reativo — preview sempre deriva de 02-reviewed.md, não do texto digitado ali", () => {
    assert.equal(isDraftPreviewSlug("categorized"), false);
  });

  it("html-final/html-final-patronos NÃO passam pelo preview-draft do servidor (eco local, ver isRawEchoSlug)", () => {
    assert.equal(isDraftPreviewSlug("html-final"), false);
    assert.equal(isDraftPreviewSlug("html-final-patronos"), false);
  });

  it("slug desconhecido -> false (fail-safe)", () => {
    assert.equal(isDraftPreviewSlug("qualquer-coisa"), false);
  });
});

describe("isRawEchoSlug", () => {
  it("html-final e html-final-patronos são eco direto (sem parsing)", () => {
    assert.equal(isRawEchoSlug("html-final"), true);
    assert.equal(isRawEchoSlug("html-final-patronos"), true);
  });

  it("reviewed/social/categorized não são eco direto", () => {
    assert.equal(isRawEchoSlug("reviewed"), false);
    assert.equal(isRawEchoSlug("social"), false);
    assert.equal(isRawEchoSlug("categorized"), false);
  });
});

describe("shouldApplyDraftPreviewResponse (guard de sequência, item 4 do escopo)", () => {
  it("resposta da request MAIS RECENTE -> aplica", () => {
    assert.equal(shouldApplyDraftPreviewResponse(3, 3), true);
  });

  it("resposta de uma request MAIS ANTIGA chegando fora de ordem -> descarta", () => {
    // Cenário real: request #1 disparada, depois #2 (usuário continuou
    // digitando) — #2 responde primeiro (rede mais rápida), #1 chega depois.
    // `latestSeq` já é 2 quando a resposta atrasada de #1 chega.
    assert.equal(shouldApplyDraftPreviewResponse(1, 2), false);
  });

  it("resposta nunca pode ser MAIOR que a última sequência disparada, mas se for (bug hipotético em outro lugar) ainda assim não aplica silenciosamente errado", () => {
    assert.equal(shouldApplyDraftPreviewResponse(5, 3), false);
  });
});

describe("nextDraftPreviewSeq", () => {
  it("incrementa", () => {
    assert.equal(nextDraftPreviewSeq(0), 1);
    assert.equal(nextDraftPreviewSeq(41), 42);
  });
});

describe("resolveMobileView (toggle Editor/Preview, item 1 do escopo)", () => {
  it("'preview' -> 'preview'", () => {
    assert.equal(resolveMobileView("preview"), "preview");
  });

  it("'editor' -> 'editor'", () => {
    assert.equal(resolveMobileView("editor"), "editor");
  });

  it("qualquer outro valor (undefined, string desconhecida) -> 'editor' (fail-safe, nunca um 3º estado)", () => {
    assert.equal(resolveMobileView(undefined), "editor");
    assert.equal(resolveMobileView("lint"), "editor");
    assert.equal(resolveMobileView(""), "editor");
  });
});

describe("DRAFT_PREVIEW_DEBOUNCE_MS", () => {
  it("está dentro da faixa sugerida na issue (600-800ms)", () => {
    assert.ok(DRAFT_PREVIEW_DEBOUNCE_MS >= 600 && DRAFT_PREVIEW_DEBOUNCE_MS <= 800);
  });
});
