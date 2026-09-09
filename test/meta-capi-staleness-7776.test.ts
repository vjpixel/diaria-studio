/**
 * test/meta-capi-staleness-7776.test.ts (#7776, follow-up do #5504)
 *
 * Cobre `scripts/lib/meta-capi-staleness.ts`: staleness pura
 * (`computeCapiStaleness`), leitura de rede injetável
 * (`fetchDatasetServerLastFiredTime`, mock — NUNCA chama a Meta ao vivo) e
 * o veredito consolidado (`evaluateMetaCapiStaleness`). Cenários exigidos
 * explicitamente pelo dispatch: dataset nunca disparou (epoch 0), disparou
 * há N dias, disparou recentemente, e API indisponível.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCapiStaleness,
  fetchDatasetServerLastFiredTime,
  evaluateMetaCapiStaleness,
  shouldSendMetaCapiStalenessAlarm,
  markMetaCapiStalenessAlarmed,
  emptyMetaCapiStalenessAlarmState,
  buildMetaCapiStalenessAlarmEmail,
  DEFAULT_CAPI_STALENESS_THRESHOLD_DAYS,
  META_CAPI_STALENESS_DEFAULT_DATASET_ID,
} from "../scripts/lib/meta-capi-staleness.ts";

const NOW = new Date("2026-09-09T12:00:00Z");

describe("#7776 — computeCapiStaleness", () => {
  it("dataset nunca disparou (serverLastFiredTime null) → neverFired + isStale", () => {
    const r = computeCapiStaleness(null, NOW, 2);
    assert.deepEqual(r, { isStale: true, neverFired: true, daysSinceLastFired: null });
  });

  it("epoch 0 (o valor 'nunca disparou' que a Meta devolve, ex: 1969-12-31T16:00:00-0800) → neverFired + isStale", () => {
    const r = computeCapiStaleness("1969-12-31T16:00:00-0800", NOW, 2);
    assert.deepEqual(r, { isStale: true, neverFired: true, daysSinceLastFired: null });
  });

  it("epoch 0 em UTC puro também conta", () => {
    const r = computeCapiStaleness("1970-01-01T00:00:00Z", NOW, 2);
    assert.equal(r.neverFired, true);
    assert.equal(r.isStale, true);
  });

  it("disparou há N dias, ACIMA do threshold → isStale true, neverFired false", () => {
    const fiveDaysAgo = new Date(NOW.getTime() - 5 * 86_400_000).toISOString();
    const r = computeCapiStaleness(fiveDaysAgo, NOW, 2);
    assert.equal(r.neverFired, false);
    assert.equal(r.isStale, true);
    assert.equal(r.daysSinceLastFired, 5);
  });

  it("disparou recentemente (dentro do threshold) → isStale false", () => {
    const today = new Date(NOW.getTime() - 3600_000).toISOString(); // 1h atrás
    const r = computeCapiStaleness(today, NOW, 2);
    assert.equal(r.neverFired, false);
    assert.equal(r.isStale, false);
    assert.equal(r.daysSinceLastFired, 0);
  });

  it("exatamente no threshold (não excedeu) → não é stale (fronteira: > thresholdDays, não >=)", () => {
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 86_400_000).toISOString();
    const r = computeCapiStaleness(twoDaysAgo, NOW, 2);
    assert.equal(r.isStale, false);
    assert.equal(r.daysSinceLastFired, 2);
  });

  it("string inválida (não-parseável) → tratada como neverFired (fail-toward-alarming, não crash)", () => {
    const r = computeCapiStaleness("não é uma data", NOW, 2);
    assert.equal(r.neverFired, true);
    assert.equal(r.isStale, true);
  });

  it("usa DEFAULT_CAPI_STALENESS_THRESHOLD_DAYS quando thresholdDays é omitido", () => {
    const withinDefault = new Date(NOW.getTime() - (DEFAULT_CAPI_STALENESS_THRESHOLD_DAYS - 1) * 86_400_000).toISOString();
    const r = computeCapiStaleness(withinDefault, NOW);
    assert.equal(r.isStale, false);
  });
});

describe("#7776 — fetchDatasetServerLastFiredTime (rede injetável, nunca lança)", () => {
  it("sem accessToken → not_configured, NENHUMA chamada de rede", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchDatasetServerLastFiredTime({ accessToken: undefined, fetchImpl });
    assert.deepEqual(r, { ok: false, reason: "not_configured" });
    assert.equal(called, false);
  });

  it("caminho feliz — Meta responde 200 com server_last_fired_time", async () => {
    const fetchImpl = (async (url: string | URL) => {
      assert.match(String(url), new RegExp(META_CAPI_STALENESS_DEFAULT_DATASET_ID));
      return new Response(JSON.stringify({ id: "x", server_last_fired_time: "2026-09-09T10:00:00-0700" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const r = await fetchDatasetServerLastFiredTime({ accessToken: "tok", fetchImpl });
    assert.deepEqual(r, { ok: true, serverLastFiredTime: "2026-09-09T10:00:00-0700" });
  });

  it("caminho feliz — campo ausente na resposta vira serverLastFiredTime:null (nunca lança)", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ id: "x" }), { status: 200 })) as unknown as typeof fetch;
    const r = await fetchDatasetServerLastFiredTime({ accessToken: "tok", fetchImpl });
    assert.deepEqual(r, { ok: true, serverLastFiredTime: null });
  });

  it("Meta retorna erro HTTP (ex: token inválido) → meta_error com status, NUNCA lança", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "bad token" }), { status: 401 })) as unknown as typeof fetch;
    const r = await fetchDatasetServerLastFiredTime({ accessToken: "tok-invalido", fetchImpl });
    assert.deepEqual(r, { ok: false, reason: "meta_error", status: 401 });
  });

  it("rede indisponível (fetch lança) → network_error, NUNCA propaga a exceção", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await fetchDatasetServerLastFiredTime({ accessToken: "tok", fetchImpl });
    assert.deepEqual(r, { ok: false, reason: "network_error" });
  });

  it("resposta 200 com corpo não-JSON → meta_error, NUNCA lança", async () => {
    const fetchImpl = (async () => new Response("<html>não é json</html>", { status: 200 })) as unknown as typeof fetch;
    const r = await fetchDatasetServerLastFiredTime({ accessToken: "tok", fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "meta_error");
  });
});

describe("#7776 — evaluateMetaCapiStaleness (veredito consolidado)", () => {
  it("API indisponível → cannot-verify, NUNCA 'stale' (fail-soft do próprio alarme: nunca alarme falso a partir de leitura que falhou)", async () => {
    const fetchImpl = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const r = await evaluateMetaCapiStaleness({ accessToken: "tok", fetchImpl }, NOW);
    assert.equal(r.verdict, "cannot-verify");
    assert.equal(r.cannotVerifyReason, "network_error");
    assert.equal(r.check, null);
  });

  it("sem token → cannot-verify com reason not_configured (distinto de erro de rede)", async () => {
    const r = await evaluateMetaCapiStaleness({ accessToken: undefined }, NOW);
    assert.equal(r.verdict, "cannot-verify");
    assert.equal(r.cannotVerifyReason, "not_configured");
  });

  it("dataset nunca disparou (epoch 0 lido da Meta) → verdict stale, neverFired true", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ server_last_fired_time: "1969-12-31T16:00:00-0800" }), { status: 200 })) as unknown as typeof fetch;
    const r = await evaluateMetaCapiStaleness({ accessToken: "tok", fetchImpl }, NOW);
    assert.equal(r.verdict, "stale");
    assert.equal(r.check?.neverFired, true);
  });

  it("disparou recentemente → verdict ok", async () => {
    const recent = new Date(NOW.getTime() - 3600_000).toISOString();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ server_last_fired_time: recent }), { status: 200 })) as unknown as typeof fetch;
    const r = await evaluateMetaCapiStaleness({ accessToken: "tok", fetchImpl }, NOW, 2);
    assert.equal(r.verdict, "ok");
  });

  it("disparou há muitos dias → verdict stale, neverFired false", async () => {
    const old = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ server_last_fired_time: old }), { status: 200 })) as unknown as typeof fetch;
    const r = await evaluateMetaCapiStaleness({ accessToken: "tok", fetchImpl }, NOW, 2);
    assert.equal(r.verdict, "stale");
    assert.equal(r.check?.neverFired, false);
    assert.equal(r.check?.daysSinceLastFired, 10);
  });
});

describe("#7776 — idempotência do e-mail (1x/dia-calendário, mesmo padrão de ads-spend-ingest-alarm)", () => {
  it("estado vazio + verdict stale → deve enviar", () => {
    const evalStale = { verdict: "stale" as const, check: { isStale: true, neverFired: true, daysSinceLastFired: null }, serverLastFiredTime: null, cannotVerifyReason: null };
    assert.equal(shouldSendMetaCapiStalenessAlarm(evalStale, emptyMetaCapiStalenessAlarmState(), NOW), true);
  });

  it("já alarmado hoje → não reenvia", () => {
    const evalStale = { verdict: "stale" as const, check: { isStale: true, neverFired: true, daysSinceLastFired: null }, serverLastFiredTime: null, cannotVerifyReason: null };
    const state = markMetaCapiStalenessAlarmed(NOW);
    assert.equal(shouldSendMetaCapiStalenessAlarm(evalStale, state, NOW), false);
  });

  it("alarmado ONTEM, hoje ainda stale → reenvia (novo dia-calendário)", () => {
    const evalStale = { verdict: "stale" as const, check: { isStale: true, neverFired: true, daysSinceLastFired: null }, serverLastFiredTime: null, cannotVerifyReason: null };
    const yesterday = new Date(NOW.getTime() - 86_400_000);
    const state = markMetaCapiStalenessAlarmed(yesterday);
    assert.equal(shouldSendMetaCapiStalenessAlarm(evalStale, state, NOW), true);
  });

  it("verdict ok → nunca envia, independente do estado", () => {
    const evalOk = { verdict: "ok" as const, check: { isStale: false, neverFired: false, daysSinceLastFired: 0 }, serverLastFiredTime: "x", cannotVerifyReason: null };
    assert.equal(shouldSendMetaCapiStalenessAlarm(evalOk, emptyMetaCapiStalenessAlarmState(), NOW), false);
  });

  it("verdict cannot-verify → nunca envia (fail-soft: leitura que falhou nunca dispara alarme)", () => {
    const evalCannot = { verdict: "cannot-verify" as const, check: null, serverLastFiredTime: null, cannotVerifyReason: "network_error" as const };
    assert.equal(shouldSendMetaCapiStalenessAlarm(evalCannot, emptyMetaCapiStalenessAlarmState(), NOW), false);
  });
});

describe("#7776 — buildMetaCapiStalenessAlarmEmail", () => {
  it("nunca disparou → menciona epoch 0 explicitamente", () => {
    const { subject, body } = buildMetaCapiStalenessAlarmEmail(
      { verdict: "stale", check: { isStale: true, neverFired: true, daysSinceLastFired: null }, serverLastFiredTime: null, cannotVerifyReason: null },
      "",
    );
    assert.match(subject, /Meta-Capi-Staleness-Alarm/);
    assert.match(body, /NUNCA registrou/);
    assert.match(body, /META_CAPI_ACCESS_TOKEN/);
  });

  it("disparou há N dias → cita a contagem de dias no corpo", () => {
    const { body } = buildMetaCapiStalenessAlarmEmail(
      { verdict: "stale", check: { isStale: true, neverFired: false, daysSinceLastFired: 7 }, serverLastFiredTime: "2026-09-02T00:00:00Z", cannotVerifyReason: null },
      "",
    );
    assert.match(body, /7 dia\(s\)/);
  });
});
