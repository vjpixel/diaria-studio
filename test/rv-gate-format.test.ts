/**
 * test/rv-gate-format.test.ts (#6449 review — fecha o gap de cobertura
 * apontado pelo pr-test-analyzer e pelo self-review sobre `rv-gate.js`)
 *
 * Testa a formatação PURA (sem DOM) do painel Gate —
 * `scripts/studio-ui/public/rv-gate-format.js` — mesmo padrão de
 * `test/revisao-guards.test.ts`/`test/revisao-inline-edit.test.ts`: importa
 * o módulo client-side direto (sem harness de DOM/browser) e testa as
 * funções puras que ele exporta.
 *
 * `formatMetaDescription` em particular fecha um bug real achado no
 * self-review do #6449: `metaDescriptionSuggestion` tem 3 estados
 * (`null`/`''`/string) e um `if (value)` ingênuo conflava os 2 primeiros.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatMetaDescription,
  formatWhatsappUrl,
  formatFactCheckSummary,
  formatAutofixSummary,
  formatBoxSlotLine,
  lintFailureRows,
  formatRenderWarningRow,
  formatGateDecision,
} from "../scripts/studio-ui/public/rv-gate-format.js";

describe("formatMetaDescription (#6449 — bug real: null vs '' conflados)", () => {
  it("null (ainda não computada) -> available:false, mensagem distinta de ''", () => {
    const r = formatMetaDescription(null);
    assert.equal(r.available, false);
    assert.match(r.text, /ainda não computada/);
  });

  it("'' (computada, sem sugestão aproveitável) -> available:false, mensagem DIFERENTE de null", () => {
    const r = formatMetaDescription("");
    assert.equal(r.available, false);
    assert.match(r.text, /sem prosa aproveitável/);
    assert.notEqual(r.text, formatMetaDescription(null).text);
  });

  it("string não-vazia -> available:true, texto é o valor literal", () => {
    const r = formatMetaDescription("Resumo do D1 pra SEO.");
    assert.equal(r.available, true);
    assert.equal(r.text, "Resumo do D1 pra SEO.");
  });
});

describe("formatWhatsappUrl", () => {
  it("null -> available:false", () => {
    const r = formatWhatsappUrl(null);
    assert.equal(r.available, false);
  });

  it("string -> available:true, texto é a URL", () => {
    const r = formatWhatsappUrl("https://diar.ia.br/x?utm=whatsapp");
    assert.equal(r.available, true);
    assert.equal(r.text, "https://diar.ia.br/x?utm=whatsapp");
  });
});

describe("formatFactCheckSummary", () => {
  it("available:false -> usa o note do estado", () => {
    const text = formatFactCheckSummary({ available: false, note: "fact-check.json indisponível" });
    assert.equal(text, "fact-check.json indisponível");
  });

  it("available:true -> monta a linha com os 5 campos do summary", () => {
    const text = formatFactCheckSummary({
      available: true,
      summary: { total: 3, sustained: 2, divergent: 1, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 1 },
    });
    assert.match(text, /3 claim\(s\)/);
    assert.match(text, /2 confirmado/);
    assert.match(text, /1 divergente/);
    assert.match(text, /1 pedindo atenção/);
  });
});

describe("formatAutofixSummary", () => {
  it("available:false -> null (caller decide se mostra o note)", () => {
    assert.equal(formatAutofixSummary({ available: false, note: "indisponível" }), null);
  });

  it("available:true sem social modificado -> sem menção a 03-social.md", () => {
    const text = formatAutofixSummary({ available: true, summary: { total_divergent: 2, applied: 1, skipped: 1 }, socialModified: false });
    assert.match(text, /1 correção/);
    assert.doesNotMatch(text, /03-social\.md/);
  });

  it("available:true com social modificado -> menciona 03-social.md", () => {
    const text = formatAutofixSummary({ available: true, summary: { total_divergent: 2, applied: 2, skipped: 0 }, socialModified: true });
    assert.match(text, /03-social\.md/);
  });
});

describe("formatBoxSlotLine", () => {
  it("slot com file -> mostra nome (ou file) + mode", () => {
    const text = formatBoxSlotLine({ slot: 1, mode: "auto", file: "apoio.md", nome: "Apoio", score: 0.8, trend: null, editionsAppeared: 3, seasonal: false });
    assert.equal(text, "Slot 1: Apoio (auto)");
  });

  it("slot sem file -> 'vazio'", () => {
    const text = formatBoxSlotLine({ slot: 2, mode: "disabled", file: null, nome: null, score: null, trend: null, editionsAppeared: null, seasonal: null });
    assert.equal(text, "Slot 2: vazio (disabled)");
  });
});

describe("lintFailureRows", () => {
  it("filtra só checks com ok:false ou crashed, prefixa com sourceLabel", () => {
    const report = {
      ok: false,
      checks: [
        { id: "a", label: "Check A", blocking: true, ok: true, crashed: false },
        { id: "b", label: "Check B", blocking: true, ok: false, crashed: false },
        { id: "c", label: "Check C", blocking: false, ok: false, crashed: false },
      ],
      skipped: [],
    };
    const rows = lintFailureRows(report, "newsletter");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].severity, "fail");
    assert.match(rows[0].text, /\[newsletter\]/);
    assert.match(rows[0].text, /Check B/);
    assert.equal(rows[1].severity, "warn");
  });

  it("report nulo/sem checks -> array vazio, nunca lança", () => {
    assert.deepEqual(lintFailureRows(null, "social"), []);
    assert.deepEqual(lintFailureRows({}, "social"), []);
  });
});

describe("formatRenderWarningRow", () => {
  it("evento com slot -> inclui o número do slot", () => {
    const text = formatRenderWarningRow({ event: "divulgacao_box_dropped_no_gap", edition: "260716", slot: 2 });
    assert.match(text, /divulgacao_box_dropped_no_gap/);
    assert.match(text, /slot 2/);
  });

  it("evento sem slot -> não menciona slot nenhum", () => {
    const text = formatRenderWarningRow({ event: "whatsapp_share_no_d1", edition: "260716" });
    assert.doesNotMatch(text, /slot/);
  });
});

describe("formatGateDecision (#6447 Fatia 4, achado 7)", () => {
  it("decision null -> approved:false", () => {
    const r = formatGateDecision(null);
    assert.equal(r.approved, false);
    assert.match(r.text, /Ainda não aprovado/);
  });

  it("decision com shape inesperado (decision !== 'approved') -> approved:false", () => {
    const r = formatGateDecision({ decision: "rejected", decided_at: "2026-08-28T10:00:00.000Z" });
    assert.equal(r.approved, false);
  });

  it("approved -> approved:true, texto com minutos decorridos a partir de nowMs injetado", () => {
    const decidedAt = new Date("2026-08-28T10:00:00.000Z").getTime();
    const nowMs = decidedAt + 5 * 60_000;
    const r = formatGateDecision({ decision: "approved", decided_at: new Date(decidedAt).toISOString(), decided_via: "studio" }, nowMs);
    assert.equal(r.approved, true);
    assert.match(r.text, /Já aprovado/);
    assert.match(r.text, /5min atrás/);
  });

  it("decided_at malformado -> approved:true mas sem sufixo de tempo relativo (nunca lança)", () => {
    const r = formatGateDecision({ decision: "approved", decided_at: "não-é-uma-data" });
    assert.equal(r.approved, true);
    assert.doesNotMatch(r.text, /atrás/);
  });
});
