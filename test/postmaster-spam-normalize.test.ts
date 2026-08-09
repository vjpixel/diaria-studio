/**
 * test/postmaster-spam-normalize.test.ts (#4154, achado do self-review do #4342)
 *
 * `normalizePostmasterSpamEntry` (workers/brevo-dashboard/src/brevo-api.ts) é o
 * ÚNICO choke point de leitura do KV `postmaster:spam` — usado tanto pelo
 * render do dashboard quanto por `GET /api/postmaster-spam`. Reconstruía o
 * objeto campo a campo e NUNCA copiava `producedBy`: todo entry gravado pelos
 * dois produtores (postmaster-spam-sync.ts="auto", postmaster-spam-entry.ts=
 * "manual") saía normalizado com `producedBy: undefined`, então o rótulo
 * dinâmico da aba Rampa nunca refletia a origem real da leitura em produção —
 * só nos testes que constroem o objeto direto, sem passar por este boundary.
 * Este arquivo trava a regressão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePostmasterSpamEntry } from "../workers/brevo-dashboard/src/index.ts";

describe("normalizePostmasterSpamEntry — producedBy passa pelo boundary do KV (#4154, #4342)", () => {
  it("producedBy 'auto' é preservado", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      producedBy: "auto",
    });
    assert.equal(entry?.producedBy, "auto");
  });

  it("producedBy 'manual' é preservado", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      producedBy: "manual",
    });
    assert.equal(entry?.producedBy, "manual");
  });

  it("producedBy ausente (entry pré-#4154) vira undefined, nunca inferido", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
    });
    assert.equal(entry?.producedBy, undefined);
  });

  it("valor de producedBy fora do enum não é confiado cegamente", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      producedBy: "algo-invalido",
    });
    assert.equal(entry?.producedBy, undefined);
  });

  it("spamRatePct/recordedAt continuam obrigatórios (regra pré-existente intacta)", () => {
    assert.equal(normalizePostmasterSpamEntry(null), null);
    assert.equal(normalizePostmasterSpamEntry({ producedBy: "auto" }), null);
    assert.equal(
      normalizePostmasterSpamEntry({ spamRatePct: NaN, recordedAt: "2026-07-30T09:00:00.000Z", producedBy: "auto" }),
      null,
    );
  });
});

// #4544 (achado code-reviewer, confidence 84): `daysWithData`/`daysProbed`
// (#4541) são a MESMA classe de risco que `producedBy` acima — omitir a
// cópia em `normalizePostmasterSpamEntry` derrubaria silenciosamente o guard
// de cobertura mínima de `resolveSpamSignal` pra todo mundo que lê via
// `GET /api/postmaster-spam` (ex: `scripts/clarice-schedule-ramp.ts`), mesmo
// que o KV tenha os campos. Espelha os casos de `producedBy` acima.
describe("normalizePostmasterSpamEntry — daysWithData/daysProbed passam pelo boundary do KV (#4541, #4544)", () => {
  it("daysWithData/daysProbed presentes e numéricos são preservados", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      daysWithData: 3,
      daysProbed: 10,
    });
    assert.equal(entry?.daysWithData, 3);
    assert.equal(entry?.daysProbed, 10);
  });

  it("daysWithData/daysProbed ausentes (entry manual ou pré-#4541) viram undefined, nunca inferidos", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
    });
    assert.equal(entry?.daysWithData, undefined);
    assert.equal(entry?.daysProbed, undefined);
  });

  it("daysWithData/daysProbed não-numéricos (payload corrompido) não são confiados cegamente", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      daysWithData: "três",
      daysProbed: NaN,
    });
    assert.equal(entry?.daysWithData, undefined);
    assert.equal(entry?.daysProbed, undefined);
  });
});

// #4716 (fleet review do #4703/#4704, achado type-design-analyzer): mesma
// classe de risco de novo — `dailyReadings` (#4704, série diária persistida
// pela migração v2) não era copiado em `normalizePostmasterSpamEntry`, então
// todo entry gravado por `buildAveragedEntry` (que sempre a popula) saía
// normalizado sem ela pra qualquer consumidor deste choke point. Espelha os
// casos de `producedBy`/`daysWithData` acima.
describe("normalizePostmasterSpamEntry — dailyReadings passa pelo boundary do KV (#4704, #4716)", () => {
  it("dailyReadings presente e bem formado é preservado", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-08-03",
      spamRatePct: 0.137,
      recordedAt: "2026-08-06T09:00:00.000Z",
      dailyReadings: [
        { date: "2026-08-01", spamRatePct: 0 },
        { date: "2026-08-02", spamRatePct: 0.41 },
        { date: "2026-08-03", spamRatePct: 0 },
      ],
    });
    assert.deepEqual(entry?.dailyReadings, [
      { date: "2026-08-01", spamRatePct: 0 },
      { date: "2026-08-02", spamRatePct: 0.41 },
      { date: "2026-08-03", spamRatePct: 0 },
    ]);
  });

  it("dailyReadings ausente (entry manual ou pré-#4704) vira undefined, nunca inferido", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
    });
    assert.equal(entry?.dailyReadings, undefined);
  });

  it("dailyReadings vazio vira undefined (mesma disciplina de daysWithData/daysProbed — nunca []falso)", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      dailyReadings: [],
    });
    assert.equal(entry?.dailyReadings, undefined);
  });

  it("dailyReadings não-array ou com itens corrompidos não é confiado cegamente", () => {
    const notArray = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      dailyReadings: "não é array",
    });
    assert.equal(notArray?.dailyReadings, undefined);

    const corruptedItems = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      dailyReadings: [{ date: "2026-08-01", spamRatePct: 0 }, { date: "2026-08-02" }, "lixo"],
    });
    assert.deepEqual(corruptedItems?.dailyReadings, [{ date: "2026-08-01", spamRatePct: 0 }]);
  });
});

// #4705: mesma classe de risco de novo — `worstCampaignSpamRatePct`/
// `worstCampaignFeedbackLoopId` (pico por campanha, produzido por
// `postmaster-spam-sync.ts`) precisam passar por este choke point ou
// `resolveSpamSignal` nunca os vê em produção, mesmo com o KV gravado
// corretamente — regressão silenciosa idêntica à de `producedBy`/
// `dailyReadings` acima, só que para o dado que #4705 introduziu.
describe("normalizePostmasterSpamEntry — worstCampaignSpamRatePct/worstCampaignFeedbackLoopId passam pelo boundary do KV (#4705)", () => {
  it("presentes e bem formados são preservados", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-08-03",
      spamRatePct: 0.137,
      recordedAt: "2026-08-06T09:00:00.000Z",
      worstCampaignSpamRatePct: 1.39,
      worstCampaignFeedbackLoopId: "11130585_107",
    });
    assert.equal(entry?.worstCampaignSpamRatePct, 1.39);
    assert.equal(entry?.worstCampaignFeedbackLoopId, "11130585_107");
  });

  it("ausentes (sem campanha atribuível na janela, ou entry pré-#4705) viram undefined, nunca inferidos", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
    });
    assert.equal(entry?.worstCampaignSpamRatePct, undefined);
    assert.equal(entry?.worstCampaignFeedbackLoopId, undefined);
  });

  it("payload corrompido (tipo errado) não é confiado cegamente", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      worstCampaignSpamRatePct: "um pico qualquer",
      worstCampaignFeedbackLoopId: 107,
    });
    assert.equal(entry?.worstCampaignSpamRatePct, undefined);
    assert.equal(entry?.worstCampaignFeedbackLoopId, undefined);
  });

  it("worstCampaignSpamRatePct não-finito (NaN/Infinity) é descartado", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      worstCampaignSpamRatePct: NaN,
      worstCampaignFeedbackLoopId: "11130585_107",
    });
    assert.equal(entry?.worstCampaignSpamRatePct, undefined);
    // o par não é acoplado estruturalmente (mesma disciplina de
    // daysWithData/daysProbed, #4544) — o outro campo válido sobrevive.
    assert.equal(entry?.worstCampaignFeedbackLoopId, "11130585_107");
  });
});

// #4780 (item 3 do fleet review pré-merge do #4779): worstCampaignDaysWithData
// é a MESMA classe de risco de novo — sem copiar no boundary, o CLI de
// agendamento da ramp nunca veria a cobertura do pico por campanha, mesmo
// com o KV gravado corretamente. Espelha os casos de
// worstCampaignSpamRatePct/worstCampaignFeedbackLoopId acima.
describe("normalizePostmasterSpamEntry — worstCampaignDaysWithData passa pelo boundary do KV (#4780)", () => {
  it("presente e numérico é preservado", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-08-03",
      spamRatePct: 0.137,
      recordedAt: "2026-08-06T09:00:00.000Z",
      worstCampaignSpamRatePct: 1.39,
      worstCampaignFeedbackLoopId: "11130585_107",
      worstCampaignDaysWithData: 3,
    });
    assert.equal(entry?.worstCampaignDaysWithData, 3);
  });

  it("ausente (sem campanha atribuível na janela, ou entry pré-#4780) vira undefined, nunca inferido", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      worstCampaignSpamRatePct: 1.39,
      worstCampaignFeedbackLoopId: "11130585_107",
    });
    assert.equal(entry?.worstCampaignDaysWithData, undefined);
  });

  it("não-numérico (payload corrompido) não é confiado cegamente", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      worstCampaignDaysWithData: "três",
    });
    assert.equal(entry?.worstCampaignDaysWithData, undefined);
  });

  it("NaN é descartado, não acoplado estruturalmente aos outros 2 campos do par", () => {
    const entry = normalizePostmasterSpamEntry({
      date: "2026-07-30",
      spamRatePct: 0.05,
      recordedAt: "2026-07-30T09:00:00.000Z",
      worstCampaignSpamRatePct: 1.39,
      worstCampaignFeedbackLoopId: "11130585_107",
      worstCampaignDaysWithData: NaN,
    });
    assert.equal(entry?.worstCampaignDaysWithData, undefined);
    assert.equal(entry?.worstCampaignSpamRatePct, 1.39);
    assert.equal(entry?.worstCampaignFeedbackLoopId, "11130585_107");
  });
});
