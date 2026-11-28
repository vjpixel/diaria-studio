/**
 * test/short-related-short-published-14369.test.ts (#14369)
 *
 * O vínculo do vídeo relacionado só sai com o Short PÚBLICO pela API, e a
 * janela de desistência passou de 1 h para 3 h depois do horário do Short.
 * Casos reais: 17/11 e 19/11 o horizontal estava público, mas o Short não
 * estava no canal no horário do slot, e a task desistiu 1 h depois.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SHORT_RELATED_ALERT_GRACE_MINUTES,
  SHORT_RELATED_GIVE_UP_MINUTES,
  brtInstant,
  buildShortRelatedAlert,
  decideShortRelatedPlan,
  type ShortRelatedPlanInput,
} from "../scripts/lib/diaria/youtube-short-related.ts";

const H = "MMyBVHVQELI";
const S = "K3GqRK5gFds";
const ED = "261117"; // terça-feira, um dos dias da issue
const SHORT_AT = brtInstant(ED, "06:30");

function input(over: Partial<ShortRelatedPlanInput> = {}): ShortRelatedPlanInput {
  return {
    aammdd: ED,
    now: brtInstant(ED, "06:05"),
    editionExists: true,
    noVideo: false,
    videoEvidence: { hasEvidence: true, sources: ["shorts-registry"], reason: "evidência de vídeo: shorts-registry" },
    horizontal: { id: H, source: "upload-record" },
    short: { id: S, source: "shorts-registry" },
    horizontalState: "published",
    horizontalTitle: "Título do D1",
    shortState: "published",
    shortAt: SHORT_AT,
    record: null,
    ...over,
  };
}

describe("#14369 — o Short precisa estar público para vincular", () => {
  it("horizontal público e Short ainda agendado → wait, nunca link", () => {
    const p = decideShortRelatedPlan(input({ shortState: "scheduled" }));
    assert.equal(p.action, "wait");
    assert.match(p.reason, /Short K3GqRK5gFds ainda não está público \(estado scheduled\)/);
    assert.equal(p.shortState, "scheduled");
  });

  it("Short não conferido (a API não devolveu o vídeo) → wait", () => {
    const p = decideShortRelatedPlan(input({ shortState: null }));
    assert.equal(p.action, "wait");
    assert.match(p.reason, /não conferido/);
  });

  it("os dois públicos → link (o caso que já funcionava)", () => {
    assert.equal(decideShortRelatedPlan(input({ now: brtInstant(ED, "06:32") })).action, "link");
  });

  it("o alerta cita o estado do Short", () => {
    const p = decideShortRelatedPlan(input({ shortState: "scheduled", now: brtInstant(ED, "09:31") }));
    assert.match(buildShortRelatedAlert(p, null).body, /Short: K3GqRK5gFds \(scheduled\)/);
  });
});

describe("#14369 — janela maior que 1 h", () => {
  it("o prazo de desistência passou de 60 para 180 min", () => {
    assert.ok(SHORT_RELATED_GIVE_UP_MINUTES > 60);
    assert.equal(SHORT_RELATED_GIVE_UP_MINUTES, 180);
  });

  it("cenário de 17/11: Short ausente 1 h depois do slot → ainda wait (antes: alert, a task desistia)", () => {
    const p = decideShortRelatedPlan(input({ short: null, now: brtInstant(ED, "07:31") }));
    assert.equal(p.action, "wait");
    assert.equal(p.alertDue, true);
    assert.equal(p.giveUpAt, brtInstant(ED, "09:30").toISOString());
  });

  it("Short que vira público 2 h depois do slot ainda é vinculado", () => {
    const p = decideShortRelatedPlan(input({ now: brtInstant(ED, "08:30") }));
    assert.equal(p.action, "link");
    assert.match(p.reason, /depois do horário do Short/);
  });

  it("passado o prazo de 3 h → alert", () => {
    assert.equal(decideShortRelatedPlan(input({ short: null, now: brtInstant(ED, "09:30") })).action, "alert");
  });

  it("folga antes do alerta: Short agendado logo depois do slot não pede alerta", () => {
    const justAfter = decideShortRelatedPlan(input({ shortState: "scheduled", now: brtInstant(ED, "06:31") }));
    assert.equal(justAfter.action, "wait");
    assert.equal(justAfter.alertDue, false);
    const afterGrace = decideShortRelatedPlan(
      input({ shortState: "scheduled", now: new Date(SHORT_AT.getTime() + SHORT_RELATED_ALERT_GRACE_MINUTES * 60_000) }),
    );
    assert.equal(afterGrace.alertDue, true);
  });
});
