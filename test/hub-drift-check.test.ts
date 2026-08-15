/**
 * test/hub-drift-check.test.ts (#4750)
 *
 * Regressão pura pra `scripts/lib/hub-drift-check.ts` — decisão de drift por
 * hub (ok/broken/error), fingerprint + idempotência do alarme, e o texto do
 * e-mail. Nenhum teste bate em rede/Worker publicado real — o resultado do
 * fetch entra já resolvido.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateHubDrift,
  evaluateAllHubDrift,
  hasPendingHubDrift,
  computeHubDriftFingerprint,
  emptyHubDriftAlarmState,
  advanceHubDriftState,
  shouldAlarmHubDrift,
  buildHubDriftAlarmEmail,
  hubDriftFindingKey,
  type HubCheckInput,
  type HubDriftResult,
} from "../scripts/lib/hub-drift-check.ts";

const HUB: HubCheckInput = {
  slug: "anthropic-claude",
  label: "Anthropic e Claude",
  url: "https://arquivo.diar.ia.br/temas/anthropic-claude",
  httpStatus: null,
  fetchError: null,
};

describe("evaluateHubDrift (#4750)", () => {
  it("200 -> status ok", () => {
    const r = evaluateHubDrift({ ...HUB, httpStatus: 200 });
    assert.equal(r.status, "ok");
    assert.equal(r.httpStatus, 200);
    assert.equal(r.fetchError, null);
  });

  it("404 -> status broken, httpStatus preservado", () => {
    const r = evaluateHubDrift({ ...HUB, httpStatus: 404 });
    assert.equal(r.status, "broken");
    assert.equal(r.httpStatus, 404);
    assert.match(r.message, /404/);
  });

  it("500 -> status broken", () => {
    const r = evaluateHubDrift({ ...HUB, httpStatus: 500 });
    assert.equal(r.status, "broken");
    assert.equal(r.httpStatus, 500);
  });

  it("falha de rede (fetchError preenchido) -> status error, httpStatus null mesmo se ambos vierem preenchidos", () => {
    const r = evaluateHubDrift({ ...HUB, httpStatus: 200, fetchError: "ECONNREFUSED" });
    assert.equal(r.status, "error");
    assert.equal(r.httpStatus, null);
    assert.match(r.message, /ECONNREFUSED/);
  });

  it("mensagem inclui a URL checada", () => {
    const r = evaluateHubDrift({ ...HUB, httpStatus: 404 });
    assert.match(r.message, /arquivo\.diar\.ia\.br\/temas\/anthropic-claude/);
  });
});

describe("evaluateAllHubDrift (#4750)", () => {
  it("mapeia evaluateHubDrift sobre a lista inteira, preservando ordem", () => {
    const results = evaluateAllHubDrift([
      { ...HUB, slug: "a", httpStatus: 200 },
      { ...HUB, slug: "b", httpStatus: 404 },
    ]);
    assert.deepEqual(results.map((r) => r.slug), ["a", "b"]);
    assert.deepEqual(results.map((r) => r.status), ["ok", "broken"]);
  });

  it("lista vazia -> lista vazia", () => {
    assert.deepEqual(evaluateAllHubDrift([]), []);
  });
});

describe("hasPendingHubDrift (#4750)", () => {
  it("todos ok -> false", () => {
    const results = evaluateAllHubDrift([
      { ...HUB, slug: "a", httpStatus: 200 },
      { ...HUB, slug: "b", httpStatus: 200 },
    ]);
    assert.equal(hasPendingHubDrift(results), false);
  });

  it("1 broken entre N ok -> true", () => {
    const results = evaluateAllHubDrift([
      { ...HUB, slug: "a", httpStatus: 200 },
      { ...HUB, slug: "b", httpStatus: 404 },
    ]);
    assert.equal(hasPendingHubDrift(results), true);
  });

  it("1 error entre N ok -> true (error conta como pendência, ver docstring do módulo)", () => {
    const results = evaluateAllHubDrift([
      { ...HUB, slug: "a", httpStatus: 200 },
      { ...HUB, slug: "b", fetchError: "timeout" },
    ]);
    assert.equal(hasPendingHubDrift(results), true);
  });
});

describe("computeHubDriftFingerprint (#4750)", () => {
  it("determinístico e independente da ordem de chegada", () => {
    const a = evaluateAllHubDrift([
      { ...HUB, slug: "a", httpStatus: 404 },
      { ...HUB, slug: "b", httpStatus: 500 },
    ]);
    const b = evaluateAllHubDrift([
      { ...HUB, slug: "b", httpStatus: 500 },
      { ...HUB, slug: "a", httpStatus: 404 },
    ]);
    assert.equal(computeHubDriftFingerprint(a), computeHubDriftFingerprint(b));
  });

  it("ignora hubs 'ok' no fingerprint", () => {
    const withOk = evaluateAllHubDrift([
      { ...HUB, slug: "a", httpStatus: 404 },
      { ...HUB, slug: "b", httpStatus: 200 },
    ]);
    const withoutOk = evaluateAllHubDrift([{ ...HUB, slug: "a", httpStatus: 404 }]);
    assert.equal(computeHubDriftFingerprint(withOk), computeHubDriftFingerprint(withoutOk));
  });

  it("muda quando o httpStatus de um hub pendente muda (404 -> 500)", () => {
    const fp404 = computeHubDriftFingerprint(evaluateAllHubDrift([{ ...HUB, httpStatus: 404 }]));
    const fp500 = computeHubDriftFingerprint(evaluateAllHubDrift([{ ...HUB, httpStatus: 500 }]));
    assert.notEqual(fp404, fp500);
  });

  it("sem pendência -> string vazia", () => {
    const results = evaluateAllHubDrift([{ ...HUB, httpStatus: 200 }]);
    assert.equal(computeHubDriftFingerprint(results), "");
  });
});

describe("shouldAlarmHubDrift (#4750)", () => {
  it("sem drift pendente -> false, mesmo com state vazio", () => {
    const results = evaluateAllHubDrift([{ ...HUB, httpStatus: 200 }]);
    assert.equal(shouldAlarmHubDrift(emptyHubDriftAlarmState(), results), false);
  });

  it("drift novo (state vazio) -> true", () => {
    const results = evaluateAllHubDrift([{ ...HUB, httpStatus: 404 }]);
    assert.equal(shouldAlarmHubDrift(emptyHubDriftAlarmState(), results), true);
  });

  it("mesmo drift já alarmado (fingerprint igual) -> false (não realarma)", () => {
    const results = evaluateAllHubDrift([{ ...HUB, httpStatus: 404 }]);
    const fp = computeHubDriftFingerprint(results);
    const state = advanceHubDriftState(fp, new Date("2026-08-01T00:00:00Z"));
    assert.equal(shouldAlarmHubDrift(state, results), false);
  });

  it("drift mudou de shape (novo hub quebrado) -> true", () => {
    const before = evaluateAllHubDrift([{ ...HUB, httpStatus: 404 }]);
    const state = advanceHubDriftState(computeHubDriftFingerprint(before), new Date("2026-08-01T00:00:00Z"));
    const after = evaluateAllHubDrift([
      { ...HUB, slug: "a", httpStatus: 404 },
      { ...HUB, slug: "b", httpStatus: 500 },
    ]);
    assert.equal(shouldAlarmHubDrift(state, after), true);
  });

  it("drift resolvido (re-armado, fingerprint null) e reaparecendo depois -> true", () => {
    const cleared = advanceHubDriftState(null, new Date("2026-08-01T00:00:00Z"));
    const results = evaluateAllHubDrift([{ ...HUB, httpStatus: 404 }]);
    assert.equal(shouldAlarmHubDrift(cleared, results), true);
  });
});

describe("advanceHubDriftState (#4750)", () => {
  it("grava fingerprint + timestamp ISO", () => {
    const now = new Date("2026-08-08T12:00:00Z");
    const state = advanceHubDriftState("a:broken:404:-", now);
    assert.equal(state.lastAlarmedFingerprint, "a:broken:404:-");
    assert.equal(state.lastCheckedAt, now.toISOString());
  });

  it("fingerprint null é preservado (drift limpo/re-armado)", () => {
    const state = advanceHubDriftState(null, new Date("2026-08-08T12:00:00Z"));
    assert.equal(state.lastAlarmedFingerprint, null);
  });
});

describe("buildHubDriftAlarmEmail (#4750)", () => {
  it("lista só os hubs broken/error, com slug/label/URL/detalhe", () => {
    const results: HubDriftResult[] = [
      evaluateHubDrift({
        ...HUB,
        slug: "ok-hub",
        label: "OK Hub",
        url: "https://arquivo.diar.ia.br/temas/ok-hub",
        httpStatus: 200,
      }),
      evaluateHubDrift({
        ...HUB,
        slug: "broken-hub",
        label: "Broken Hub",
        url: "https://arquivo.diar.ia.br/temas/broken-hub",
        httpStatus: 404,
      }),
      evaluateHubDrift({
        ...HUB,
        slug: "error-hub",
        label: "Error Hub",
        url: "https://arquivo.diar.ia.br/temas/error-hub",
        fetchError: "ETIMEDOUT",
      }),
    ];
    const { subject, body } = buildHubDriftAlarmEmail(results, new Date("2026-08-08T12:00:00Z"));
    assert.match(subject, /2 hub/);
    assert.doesNotMatch(body, /ok-hub/);
    assert.match(body, /broken-hub/);
    assert.match(body, /Broken Hub/);
    assert.match(body, /HTTP 404/);
    assert.match(body, /error-hub/);
    assert.match(body, /ETIMEDOUT/);
    assert.match(body, /arquivo\.diar\.ia\.br\/temas\/broken-hub/);
  });

  it("distingue explicitamente do hub-registry-completeness.test.ts no corpo (evita confusão de camadas)", () => {
    const results = [evaluateHubDrift({ ...HUB, httpStatus: 404 })];
    const { body } = buildHubDriftAlarmEmail(results);
    assert.match(body, /hub-registry-completeness\.test\.ts/);
  });

  it("assunto reflete a contagem exata de hubs quebrados", () => {
    const results = [
      evaluateHubDrift({ ...HUB, slug: "a", httpStatus: 404 }),
      evaluateHubDrift({ ...HUB, slug: "b", httpStatus: 500 }),
      evaluateHubDrift({ ...HUB, slug: "c", httpStatus: 200 }),
    ];
    const { subject } = buildHubDriftAlarmEmail(results);
    assert.match(subject, /^\[diar\.ia\.br\] 2 hub/);
  });
});

describe("buildHubDriftAlarmEmail com issueRefs (#5339)", () => {
  it("cita o número da issue quando issueRefs tem entry pro achado (action: created/reused)", () => {
    const r = evaluateHubDrift({ ...HUB, slug: "broken-hub", httpStatus: 404 });
    const issueRefs = new Map([
      [hubDriftFindingKey(r), { issueNumber: 5340, url: "https://github.com/vjpixel/diaria-studio/issues/5340", action: "created" }],
    ]);
    const { body } = buildHubDriftAlarmEmail([r], new Date("2026-08-15T12:00:00Z"), issueRefs);
    assert.match(body, /Issue: #5340/);
    assert.match(body, /issues\/5340/);
  });

  it("action 'failed' cita o motivo em vez de um número — e-mail nunca perde o achado por falha de gh", () => {
    const r = evaluateHubDrift({ ...HUB, slug: "broken-hub", httpStatus: 404 });
    const issueRefs = new Map([
      [hubDriftFindingKey(r), { issueNumber: null, url: null, action: "failed", error: "gh não autenticado" }],
    ]);
    const { body } = buildHubDriftAlarmEmail([r], new Date("2026-08-15T12:00:00Z"), issueRefs);
    assert.match(body, /falha ao criar\/reusar \(gh não autenticado\)/);
  });

  it("sem issueRefs (undefined) — corpo sai igual ao comportamento pré-#5339, sem quebrar", () => {
    const r = evaluateHubDrift({ ...HUB, slug: "broken-hub", httpStatus: 404 });
    const { body } = buildHubDriftAlarmEmail([r]);
    assert.doesNotMatch(body, /Issue:/);
  });
});
