/**
 * test/log-dedup.test.ts (#3891, item 6) — cobertura da lógica PURA de
 * dedup de eventos de run-log (`scripts/studio-ui/public/log-dedup.js`).
 * Mesmo padrão de `test/edicao-stage-age.test.ts`/`test/gate-chat-bridge.test.ts`:
 * o módulo não toca `document`/`fetch`, então é testável com fixtures puras,
 * sem DOM real.
 *
 * Regressão coberta (#3891 item 6): eventos de run-log não têm seq/id (ver
 * scripts/lib/run-log.ts > PersistedEvent). No reconnect do SSE
 * (`GET /api/events`), o servidor reenvia a TAIL inteira via `log-init`
 * (server.ts > handleApiEvents, `tailJsonl`) — antes deste fix,
 * `appendLogRow` (app.js) e `pushLogEvents` (edicao.js) reprocessavam essas
 * linhas sem checar se já tinham sido vistas, duplicando o log ao vivo a
 * cada reconexão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { logEventKey, createLogDeduper } from "../scripts/studio-ui/public/log-dedup.js";

describe("logEventKey (#3891)", () => {
  it("mesma combinação timestamp+agent+message produz a mesma chave", () => {
    const a = { timestamp: "2026-07-22T10:00:00.000Z", agent: "orchestrator", message: "Stage 1 iniciado" };
    const b = { timestamp: "2026-07-22T10:00:00.000Z", agent: "orchestrator", message: "Stage 1 iniciado" };
    assert.equal(logEventKey(a), logEventKey(b));
  });

  it("timestamp, agent ou message diferente produz chave diferente", () => {
    const base = { timestamp: "2026-07-22T10:00:00.000Z", agent: "orchestrator", message: "Stage 1 iniciado" };
    assert.notEqual(logEventKey(base), logEventKey({ ...base, timestamp: "2026-07-22T10:00:01.000Z" }));
    assert.notEqual(logEventKey(base), logEventKey({ ...base, agent: "writer" }));
    assert.notEqual(logEventKey(base), logEventKey({ ...base, message: "Stage 2 iniciado" }));
  });

  it("evento malformado (null/undefined/campos ausentes) nunca lança", () => {
    assert.doesNotThrow(() => logEventKey(null));
    assert.doesNotThrow(() => logEventKey(undefined));
    assert.doesNotThrow(() => logEventKey({}));
    assert.equal(logEventKey({}), "||");
  });
});

describe("createLogDeduper (#3891) — PoC exato do bug: reconnect reenvia a mesma tail", () => {
  it("1ª vez que um evento aparece -> isNew true; reenvio EXATO do mesmo evento (reconnect) -> isNew false", () => {
    const deduper = createLogDeduper(500);
    const event = { timestamp: "2026-07-22T10:00:00.000Z", agent: "orchestrator", message: "Stage 1 iniciado", edition: "260722" };

    assert.equal(deduper.isNew(event), true);
    // reconnect: `log-init` reenvia a MESMA tail — mesmo evento de novo.
    assert.equal(deduper.isNew(event), false);
    assert.equal(deduper.isNew({ ...event }), false); // objeto novo, mesmo conteúdo -> mesma chave
  });

  it("eventos genuinamente diferentes nunca são tratados como duplicata", () => {
    const deduper = createLogDeduper(500);
    assert.equal(deduper.isNew({ timestamp: "t1", agent: "a", message: "m1" }), true);
    assert.equal(deduper.isNew({ timestamp: "t2", agent: "a", message: "m2" }), true);
    assert.equal(deduper.isNew({ timestamp: "t1", agent: "b", message: "m1" }), true); // agent diferente
    assert.equal(deduper.size(), 3);
  });

  it("janela deslizante: excede maxSize -> a chave mais ANTIGA sai da janela e pode reaparecer sem ser tratada como duplicata", () => {
    const deduper = createLogDeduper(2);
    assert.equal(deduper.isNew({ timestamp: "t1", agent: "a", message: "m1" }), true); // janela: [t1]
    assert.equal(deduper.isNew({ timestamp: "t2", agent: "a", message: "m2" }), true); // janela: [t1, t2]
    assert.equal(deduper.size(), 2);
    // 3º evento empurra o 1º (t1) pra fora da janela -> janela: [t2, t3].
    assert.equal(deduper.isNew({ timestamp: "t3", agent: "a", message: "m3" }), true);
    assert.equal(deduper.size(), 2);
    // t1 "esqueceu" (saiu da janela no passo anterior) — reaparece como novo
    // (trade-off documentado no PR) -> empurra t2 pra fora -> janela: [t3, t1].
    assert.equal(deduper.isNew({ timestamp: "t1", agent: "a", message: "m1" }), true);
    // t3 ainda está na janela — continua dedupado.
    assert.equal(deduper.isNew({ timestamp: "t3", agent: "a", message: "m3" }), false);
    // t2 já saiu da janela (evicted no passo anterior) — reaparece como novo.
    assert.equal(deduper.isNew({ timestamp: "t2", agent: "a", message: "m2" }), true);
  });

  it("simula a rajada de log-init no reconnect: N eventos repetidos filtrados -> só os NOVOS passam", () => {
    const deduper = createLogDeduper(500);
    const tail = [
      { timestamp: "t1", agent: "a", message: "m1" },
      { timestamp: "t2", agent: "a", message: "m2" },
      { timestamp: "t3", agent: "a", message: "m3" },
    ];
    // 1ª conexão: todos novos.
    const firstPass = tail.filter((e) => deduper.isNew(e));
    assert.equal(firstPass.length, 3);

    // reconnect: server reenvia a MESMA tail inteira via log-init.
    const secondPass = tail.filter((e) => deduper.isNew(e));
    assert.equal(secondPass.length, 0, "nenhum evento da tail reenviada deveria passar — todos já vistos");

    // + 1 evento genuinamente novo chega no meio da rajada reenviada.
    const mixed = [...tail, { timestamp: "t4", agent: "a", message: "m4" }];
    const thirdPass = mixed.filter((e) => deduper.isNew(e));
    assert.equal(thirdPass.length, 1);
    assert.equal(thirdPass[0].timestamp, "t4");
  });
});
