/**
 * test/subscribe-redirect-drift-check.test.ts (#6365)
 *
 * Regressão pura pra `scripts/lib/subscribe-redirect-drift-check.ts` —
 * decisão de drift por alvo (ok/broken/error, incluindo "200 mas marcador
 * ausente"), fingerprint + idempotência do alarme, e o texto do e-mail.
 * Nenhum teste bate em rede real — o resultado do fetch entra já resolvido.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDefaultTargets,
  evaluateSubscribeDrift,
  evaluateAllSubscribeDrift,
  hasPendingSubscribeDrift,
  computeSubscribeDriftFingerprint,
  emptySubscribeDriftAlarmState,
  advanceSubscribeDriftState,
  shouldAlarmSubscribeDrift,
  buildSubscribeDriftAlarmEmail,
  subscribeDriftFindingKey,
  KIT_SUBSCRIBE_URL,
  KIT_SUBSCRIBE_EXPECTED_MARKERS,
  type DriftCheckInput,
  type DriftCheckResult,
} from "../scripts/lib/subscribe-redirect-drift-check.ts";

const TARGET: DriftCheckInput = {
  key: "kit-subscribe",
  label: "Destino do redirect /subscribe (perfil hospedado Kit)",
  url: KIT_SUBSCRIBE_URL,
  expectedMarkers: KIT_SUBSCRIBE_EXPECTED_MARKERS,
  markerDescription: "campo de e-mail + botão \"Subscribe\"",
  httpStatus: null,
  fetchError: null,
  body: null,
};

const OK_BODY = '<form><input type="email" name="email_address"><button>Subscribe</button></form>';

describe("buildDefaultTargets (#6365)", () => {
  const targets = buildDefaultTargets({
    workerDevHost: "diaria-site.diaria.workers.dev",
    expectedRootMarker: "<title>diar.ia.br</title>",
    sampleArchiveSlug: "exemplo-slug",
  });

  it("inclui os 3 alvos: kit-subscribe, worker-root, worker-sample-page", () => {
    assert.deepEqual(targets.map((t) => t.key), ["kit-subscribe", "worker-root", "worker-sample-page"]);
  });

  it("kit-subscribe aponta pro destino Kit confirmado ao vivo", () => {
    assert.equal(targets[0].url, "https://diar-ia-br.kit.com/");
  });

  it("worker-root usa o host workers.dev informado + marcador da home", () => {
    assert.equal(targets[1].url, "https://diaria-site.diaria.workers.dev/");
    assert.deepEqual(targets[1].expectedMarkers, ["<title>diar.ia.br</title>"]);
  });

  it("worker-sample-page usa o slug informado + canonical apontando pro apex", () => {
    assert.equal(targets[2].url, "https://diaria-site.diaria.workers.dev/p/exemplo-slug");
    assert.deepEqual(targets[2].expectedMarkers, ['href="https://diar.ia.br/p/exemplo-slug"']);
  });
});

describe("evaluateSubscribeDrift (#6365)", () => {
  it("200 + todos os marcadores presentes -> ok", () => {
    const r = evaluateSubscribeDrift({ ...TARGET, httpStatus: 200, body: OK_BODY });
    assert.equal(r.status, "ok");
    assert.equal(r.httpStatus, 200);
    assert.equal(r.fetchError, null);
  });

  it("404 -> broken, httpStatus preservado", () => {
    const r = evaluateSubscribeDrift({ ...TARGET, httpStatus: 404, body: "not found" });
    assert.equal(r.status, "broken");
    assert.equal(r.httpStatus, 404);
    assert.match(r.message, /404/);
  });

  it("500 -> broken", () => {
    const r = evaluateSubscribeDrift({ ...TARGET, httpStatus: 500, body: "boom" });
    assert.equal(r.status, "broken");
    assert.equal(r.httpStatus, 500);
  });

  it("200 mas SEM os marcadores esperados -> broken (página de erro/placeholder servida com 200)", () => {
    const r = evaluateSubscribeDrift({ ...TARGET, httpStatus: 200, body: "<html>Oops, something went wrong</html>" });
    assert.equal(r.status, "broken");
    assert.equal(r.httpStatus, 200);
    assert.match(r.message, /marcador/);
  });

  it("200 com SÓ ALGUNS dos marcadores esperados -> broken (todos são exigidos)", () => {
    const r = evaluateSubscribeDrift({ ...TARGET, httpStatus: 200, body: '<input type="email">' });
    assert.equal(r.status, "broken");
  });

  it("200 com body null -> broken (tratado como marcador ausente, fail closed)", () => {
    const r = evaluateSubscribeDrift({ ...TARGET, httpStatus: 200, body: null });
    assert.equal(r.status, "broken");
  });

  it("falha de rede (fetchError preenchido) -> error, httpStatus null mesmo se ambos vierem preenchidos", () => {
    const r = evaluateSubscribeDrift({ ...TARGET, httpStatus: 200, body: OK_BODY, fetchError: "ECONNREFUSED" });
    assert.equal(r.status, "error");
    assert.equal(r.httpStatus, null);
    assert.match(r.message, /ECONNREFUSED/);
  });

  it("mensagem inclui a URL checada", () => {
    const r = evaluateSubscribeDrift({ ...TARGET, httpStatus: 404, body: "x" });
    assert.match(r.message, /diar-ia-br\.kit\.com/);
  });
});

describe("evaluateAllSubscribeDrift (#6365)", () => {
  it("mapeia evaluateSubscribeDrift sobre a lista inteira, preservando ordem", () => {
    const results = evaluateAllSubscribeDrift([
      { ...TARGET, key: "a", httpStatus: 200, body: OK_BODY },
      { ...TARGET, key: "b", httpStatus: 404, body: "x" },
    ]);
    assert.deepEqual(results.map((r) => r.key), ["a", "b"]);
    assert.deepEqual(results.map((r) => r.status), ["ok", "broken"]);
  });

  it("lista vazia -> lista vazia", () => {
    assert.deepEqual(evaluateAllSubscribeDrift([]), []);
  });
});

describe("hasPendingSubscribeDrift (#6365)", () => {
  it("todos ok -> false", () => {
    const results = evaluateAllSubscribeDrift([
      { ...TARGET, key: "a", httpStatus: 200, body: OK_BODY },
      { ...TARGET, key: "b", httpStatus: 200, body: OK_BODY },
    ]);
    assert.equal(hasPendingSubscribeDrift(results), false);
  });

  it("1 broken entre N ok -> true", () => {
    const results = evaluateAllSubscribeDrift([
      { ...TARGET, key: "a", httpStatus: 200, body: OK_BODY },
      { ...TARGET, key: "b", httpStatus: 404, body: "x" },
    ]);
    assert.equal(hasPendingSubscribeDrift(results), true);
  });

  it("1 error entre N ok -> true", () => {
    const results = evaluateAllSubscribeDrift([
      { ...TARGET, key: "a", httpStatus: 200, body: OK_BODY },
      { ...TARGET, key: "b", fetchError: "timeout" },
    ]);
    assert.equal(hasPendingSubscribeDrift(results), true);
  });
});

describe("computeSubscribeDriftFingerprint (#6365)", () => {
  it("determinístico e independente da ordem de chegada", () => {
    const a = evaluateAllSubscribeDrift([
      { ...TARGET, key: "a", httpStatus: 404, body: "x" },
      { ...TARGET, key: "b", httpStatus: 500, body: "x" },
    ]);
    const b = evaluateAllSubscribeDrift([
      { ...TARGET, key: "b", httpStatus: 500, body: "x" },
      { ...TARGET, key: "a", httpStatus: 404, body: "x" },
    ]);
    assert.equal(computeSubscribeDriftFingerprint(a), computeSubscribeDriftFingerprint(b));
  });

  it("ignora alvos 'ok' no fingerprint", () => {
    const withOk = evaluateAllSubscribeDrift([
      { ...TARGET, key: "a", httpStatus: 404, body: "x" },
      { ...TARGET, key: "b", httpStatus: 200, body: OK_BODY },
    ]);
    const withoutOk = evaluateAllSubscribeDrift([{ ...TARGET, key: "a", httpStatus: 404, body: "x" }]);
    assert.equal(computeSubscribeDriftFingerprint(withOk), computeSubscribeDriftFingerprint(withoutOk));
  });

  it("muda quando o httpStatus de um alvo pendente muda (404 -> 500)", () => {
    const fp404 = computeSubscribeDriftFingerprint(evaluateAllSubscribeDrift([{ ...TARGET, httpStatus: 404, body: "x" }]));
    const fp500 = computeSubscribeDriftFingerprint(evaluateAllSubscribeDrift([{ ...TARGET, httpStatus: 500, body: "x" }]));
    assert.notEqual(fp404, fp500);
  });

  it("200-sem-marcador e 404 têm fingerprints diferentes (detalhe do status muda a chave)", () => {
    const fpNoMarker = computeSubscribeDriftFingerprint(
      evaluateAllSubscribeDrift([{ ...TARGET, httpStatus: 200, body: "erro generico" }]),
    );
    const fp404 = computeSubscribeDriftFingerprint(evaluateAllSubscribeDrift([{ ...TARGET, httpStatus: 404, body: "x" }]));
    assert.notEqual(fpNoMarker, fp404);
  });

  it("sem pendência -> string vazia", () => {
    const results = evaluateAllSubscribeDrift([{ ...TARGET, httpStatus: 200, body: OK_BODY }]);
    assert.equal(computeSubscribeDriftFingerprint(results), "");
  });
});

describe("shouldAlarmSubscribeDrift (#6365)", () => {
  it("sem drift pendente -> false, mesmo com state vazio", () => {
    const results = evaluateAllSubscribeDrift([{ ...TARGET, httpStatus: 200, body: OK_BODY }]);
    assert.equal(shouldAlarmSubscribeDrift(emptySubscribeDriftAlarmState(), results), false);
  });

  it("drift novo (state vazio) -> true", () => {
    const results = evaluateAllSubscribeDrift([{ ...TARGET, httpStatus: 404, body: "x" }]);
    assert.equal(shouldAlarmSubscribeDrift(emptySubscribeDriftAlarmState(), results), true);
  });

  it("mesmo drift já alarmado (fingerprint igual) -> false (não realarma)", () => {
    const results = evaluateAllSubscribeDrift([{ ...TARGET, httpStatus: 404, body: "x" }]);
    const fp = computeSubscribeDriftFingerprint(results);
    const state = advanceSubscribeDriftState(fp, new Date("2026-08-01T00:00:00Z"));
    assert.equal(shouldAlarmSubscribeDrift(state, results), false);
  });

  it("drift mudou de shape (novo alvo quebrado) -> true", () => {
    const before = evaluateAllSubscribeDrift([{ ...TARGET, httpStatus: 404, body: "x" }]);
    const state = advanceSubscribeDriftState(computeSubscribeDriftFingerprint(before), new Date("2026-08-01T00:00:00Z"));
    const after = evaluateAllSubscribeDrift([
      { ...TARGET, key: "a", httpStatus: 404, body: "x" },
      { ...TARGET, key: "b", httpStatus: 500, body: "x" },
    ]);
    assert.equal(shouldAlarmSubscribeDrift(state, after), true);
  });

  it("drift resolvido (re-armado, fingerprint null) e reaparecendo depois -> true", () => {
    const cleared = advanceSubscribeDriftState(null, new Date("2026-08-01T00:00:00Z"));
    const results = evaluateAllSubscribeDrift([{ ...TARGET, httpStatus: 404, body: "x" }]);
    assert.equal(shouldAlarmSubscribeDrift(cleared, results), true);
  });
});

describe("advanceSubscribeDriftState (#6365)", () => {
  it("grava fingerprint + timestamp ISO", () => {
    const now = new Date("2026-08-08T12:00:00Z");
    const state = advanceSubscribeDriftState("kit-subscribe:broken:404:-", now);
    assert.equal(state.lastAlarmedFingerprint, "kit-subscribe:broken:404:-");
    assert.equal(state.lastCheckedAt, now.toISOString());
  });

  it("fingerprint null é preservado (drift limpo/re-armado)", () => {
    const state = advanceSubscribeDriftState(null, new Date("2026-08-08T12:00:00Z"));
    assert.equal(state.lastAlarmedFingerprint, null);
  });
});

describe("subscribeDriftFindingKey (#6365)", () => {
  it("mesma fórmula usada dentro de computeSubscribeDriftFingerprint", () => {
    const r = evaluateSubscribeDrift({ ...TARGET, httpStatus: 404, body: "x" });
    assert.equal(subscribeDriftFindingKey(r), computeSubscribeDriftFingerprint([r]));
  });
});

describe("buildSubscribeDriftAlarmEmail (#6365)", () => {
  it("lista só os alvos broken/error, com key/label/URL/detalhe", () => {
    const results: DriftCheckResult[] = [
      evaluateSubscribeDrift({ ...TARGET, key: "ok-alvo", label: "OK", httpStatus: 200, body: OK_BODY }),
      evaluateSubscribeDrift({ ...TARGET, key: "kit-subscribe", label: "Kit", httpStatus: 404, body: "x" }),
    ];
    const { subject, body } = buildSubscribeDriftAlarmEmail(results, new Date("2026-08-27T00:00:00Z"));
    assert.match(subject, /1 alvo/);
    assert.doesNotMatch(body, /ok-alvo/);
    assert.match(body, /kit-subscribe/);
    assert.match(body, /404/);
    assert.match(body, new RegExp(KIT_SUBSCRIBE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("sem alvos quebrados -> subject com 0", () => {
    const results = [evaluateSubscribeDrift({ ...TARGET, httpStatus: 200, body: OK_BODY })];
    const { subject } = buildSubscribeDriftAlarmEmail(results);
    assert.match(subject, /0 alvo/);
  });

  it("cita a issue quando issueRefs traz uma entry pro fingerprint do achado", () => {
    const r = evaluateSubscribeDrift({ ...TARGET, httpStatus: 404, body: "x" });
    const issueRefs = new Map([[subscribeDriftFindingKey(r), { issueNumber: 123, url: "https://github.com/x/y/issues/123", action: "created" }]]);
    const { body } = buildSubscribeDriftAlarmEmail([r], new Date(), issueRefs);
    assert.match(body, /#123/);
  });
});
