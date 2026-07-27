/**
 * test/poll-worker-legacy-domain-4125.test.ts (#4125 item 8)
 *
 * `poll-worker-healthcheck.ts` e `preflight-poll-dispatch.ts` usavam
 * `poll.diaria.workers.dev` como default do worker `poll`, enquanto o resto
 * do repo já migrou para `DIARIA_EIA_URL` (`eia.diar.ia.br`, #3904). Só
 * afeta a mensagem/URL usada quando `POLL_WORKER_URL` não está no env — sem
 * impacto funcional em produção (onde a env var é sempre setada), mas o
 * diagnóstico ficava referenciando o domínio legado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORKER_URL } from "../scripts/poll-worker-healthcheck.ts";
import { resolvePollWorkerUrl } from "../scripts/preflight-poll-dispatch.ts";
import { DIARIA_EIA_URL } from "../scripts/lib/canonical-urls.ts";

describe("poll-worker-healthcheck.ts — DEFAULT_WORKER_URL (#4125 item 8)", () => {
  it("usa DIARIA_EIA_URL, não o domínio legado poll.diaria.workers.dev", () => {
    assert.equal(DEFAULT_WORKER_URL, DIARIA_EIA_URL);
    assert.doesNotMatch(DEFAULT_WORKER_URL, /poll\.diaria\.workers\.dev/);
  });
});

describe("preflight-poll-dispatch.ts — resolvePollWorkerUrl (#4125 item 8)", () => {
  it("sem POLL_WORKER_URL no env → cai em DIARIA_EIA_URL, não no domínio legado", () => {
    const url = resolvePollWorkerUrl({});
    assert.equal(url, DIARIA_EIA_URL);
    assert.doesNotMatch(url, /poll\.diaria\.workers\.dev/);
  });

  it("com POLL_WORKER_URL setado no env → override é respeitado (comportamento preservado)", () => {
    const url = resolvePollWorkerUrl({ POLL_WORKER_URL: "https://mock-poll.invalid" });
    assert.equal(url, "https://mock-poll.invalid");
  });
});
