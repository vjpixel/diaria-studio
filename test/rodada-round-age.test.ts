/**
 * test/rodada-round-age.test.ts (#3889) — cobertura da lógica PURA de
 * idade/staleness do acompanhamento de rodada
 * (`scripts/studio-ui/public/rodada-round-age.js`). Mesmo padrão de
 * `test/edicao-stage-age.test.ts` (#3871): o módulo não toca
 * `document`/`fetch`, então é testável com fixtures puras, sem DOM real.
 *
 * Regressão coberta (#3889, auditoria #3866):
 * 1. `roundFreshness` — o rótulo "atualizado" de rodada.js usava
 *    `new Date()` do CLIENTE (avançava a cada fetch, mesmo com o plan.json
 *    parado de escrever — uma rodada travada há 3h continuava dizendo
 *    "atualizado agora"). `roundFreshness` usa `data.updatedAt` (mtime real
 *    do plan.json, vindo do servidor via `studio-round.ts`) — se o arquivo
 *    não mudou, o rótulo não avança.
 * 2. `unitAge` — a linha da timeline cuja unidade está "em andamento" não
 *    tinha NENHUM indicador de há quanto tempo está nesse estado.
 *    `unitAge` reusa `computeStageAge` (edicao-stage-age.js, #3871) sobre
 *    `row.ultimoEventoISO` (o timestamp `timeline.*` mais recente da
 *    unidade, não só `dispatch` — ver `getLastEventISO` em
 *    render-overnight-timeline.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STAGE_AGE_STALE_MINUTES } from "../scripts/studio-ui/public/edicao-stage-age.js";
import { unitAge, roundFreshness } from "../scripts/studio-ui/public/rodada-round-age.js";

const NOW = new Date("2026-07-22T12:00:00.000Z").getTime();

describe("unitAge (#3889)", () => {
  it("unidade sem ultimoEventoISO — ageMinutes null, stale true (mesmo fallback de computeStageAge sem eventos)", () => {
    const result = unitAge({ unidade: "#3712", ultimoEventoISO: null }, NOW);
    assert.equal(result.ageMinutes, null);
    assert.equal(result.stale, true);
  });

  it("evento recente (5min atrás) — não stale, label com minutos exatos", () => {
    const row = { unidade: "#4001", ultimoEventoISO: "2026-07-22T11:55:00.000Z" };
    const result = unitAge(row, NOW);
    assert.equal(result.ageMinutes, 5);
    assert.equal(result.stale, false);
  });

  it(`evento acima do limiar (${STAGE_AGE_STALE_MINUTES + 1}min) — stale=true`, () => {
    const ts = new Date(NOW - (STAGE_AGE_STALE_MINUTES + 1) * 60_000).toISOString();
    const row = { unidade: "#4002", ultimoEventoISO: ts };
    const result = unitAge(row, NOW);
    assert.equal(result.ageMinutes, STAGE_AGE_STALE_MINUTES + 1);
    assert.equal(result.stale, true);
  });

  it("2 rows com unidades DIFERENTES não interferem entre si (cada chamada sintetiza seu próprio array)", () => {
    const rowFresh = { unidade: "lote a (#1, #2)", ultimoEventoISO: "2026-07-22T11:59:00.000Z" };
    const rowStale = { unidade: "lote b (#3, #4)", ultimoEventoISO: "2026-07-22T10:00:00.000Z" };
    const ageFresh = unitAge(rowFresh, NOW);
    const ageStale = unitAge(rowStale, NOW);
    assert.equal(ageFresh.stale, false);
    assert.equal(ageStale.stale, true);
  });

  it("row nulo/indefinido não quebra — trata como sem evento (defensivo)", () => {
    // @ts-expect-error — teste defensivo de input malformado
    const result = unitAge(null, NOW);
    assert.equal(result.ageMinutes, null);
    assert.equal(result.stale, true);
  });

  it("usa Date.now() quando `now` é omitido (assinatura compatível com computeStageAge)", () => {
    const row = { unidade: "#5001", ultimoEventoISO: new Date().toISOString() };
    const result = unitAge(row);
    assert.equal(result.ageMinutes, 0);
    assert.equal(result.stale, false);
  });
});

describe("roundFreshness (#3889)", () => {
  it("sem data (fetch ainda não completou) — updatedAt null, stale false", () => {
    const result = roundFreshness(null, NOW);
    assert.equal(result.updatedAt, null);
    assert.equal(result.stale, false);
  });

  it("data sem updatedAt (sessão não encontrada) — updatedAt null, stale false", () => {
    const result = roundFreshness({ found: false, timeline: [] }, NOW);
    assert.equal(result.updatedAt, null);
    assert.equal(result.stale, false);
  });

  it("plan.json atualizado recentemente, SEM unidade em andamento — nunca stale (nada pra travar)", () => {
    const data = {
      updatedAt: "2026-07-22T09:00:00.000Z", // 3h atrás — velho, mas sem unidade rodando
      timeline: [{ unidade: "#1", fim: "mergeado" }],
    };
    const result = roundFreshness(data, NOW);
    assert.equal(result.updatedAt, "2026-07-22T09:00:00.000Z");
    assert.equal(result.stale, false, "sem unidade 'em andamento', staleness não é acionável — não deve alarmar");
  });

  it("plan.json parado há 3h COM unidade em andamento — stale true (cenário central da issue #3889)", () => {
    const data = {
      updatedAt: "2026-07-22T09:00:00.000Z", // 3h atrás
      timeline: [
        { unidade: "#1", fim: "mergeado" },
        { unidade: "#2", fim: "em andamento" },
      ],
    };
    const result = roundFreshness(data, NOW);
    assert.equal(result.stale, true);
    assert.match(result.ageLabel, /há \d+min/);
  });

  it("plan.json atualizado agora mesmo COM unidade em andamento — não stale (fresco)", () => {
    const data = {
      updatedAt: new Date(NOW).toISOString(),
      timeline: [{ unidade: "#1", fim: "em andamento" }],
    };
    const result = roundFreshness(data, NOW);
    assert.equal(result.stale, false);
  });

  it("timeline ausente/malformado não quebra — trata como vazio (defensivo, mesma disciplina de rowLabels)", () => {
    const data = { updatedAt: "2026-07-22T09:00:00.000Z" };
    const result = roundFreshness(data, NOW);
    assert.equal(result.stale, false);
  });

  it("duas chamadas com o MESMO updatedAt retornam o MESMO resultado — rótulo não avança sozinho (regressão central #3889)", () => {
    const data = {
      updatedAt: "2026-07-22T11:50:00.000Z",
      timeline: [{ unidade: "#1", fim: "em andamento" }],
    };
    const first = roundFreshness(data, NOW);
    const second = roundFreshness(data, NOW + 5000); // "agora" do cliente avançou 5s, o dado não mudou
    assert.equal(first.updatedAt, second.updatedAt);
  });
});
