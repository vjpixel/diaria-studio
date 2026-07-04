/**
 * test/fetch-poll-stats.test.ts (#2948)
 *
 * `fetchPollStats` foi extraído do CLI de fetch-poll-stats.ts (que só tinha
 * main(), sem CLI guard) pra ser reusável pelo pipeline mensal
 * (`monthly-eia-prev-result.ts`) sem invocar subprocesso. Este teste cobre:
 *   - query sem `&brand=` quando brand omitido/"diaria" (default do Worker)
 *   - query com `&brand=clarice` quando brand="clarice" (#1905 namespacing)
 *   - abaixo do piso de confiança (MIN_RESPONSES=5) → below_threshold +
 *     pct_correct null (mesmo critério de `buildPrevResultLine`)
 *   - falha de rede/host não mockado → fail-soft (nunca lança), total_responses 0
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { fetchPollStats } from "../scripts/fetch-poll-stats.ts";

let mockAgent: MockAgent;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

after(async () => {
  await mockAgent.close();
  setGlobalDispatcher(originalDispatcher);
});

describe("fetchPollStats (#2948)", () => {
  it("brand omitido (default diaria) — sem &brand= na query", async () => {
    const pool = mockAgent.get("https://poll.diaria.workers.dev");
    pool.intercept({ path: "/stats?edition=260601", method: "GET" }).reply(
      200,
      { total: 10, correct_pct: 70, correct_answer: "A", correct_count: 7 },
      { headers: { "content-type": "application/json" } },
    );

    const out = await fetchPollStats("260601");
    assert.equal(out.edition, "260601");
    assert.equal(out.total_responses, 10);
    assert.equal(out.correct_responses, 7);
    assert.equal(out.pct_correct, 70);
    assert.equal(out.correct_choice, "A");
    assert.equal(out.below_threshold, false);
    assert.equal(out.skipped, undefined);
    assert.equal(out.source, "poll-worker");
  });

  it('brand="clarice" — anexa &brand=clarice na query (#1905 namespacing)', async () => {
    const pool = mockAgent.get("https://poll.diaria.workers.dev");
    pool.intercept({ path: "/stats?edition=2605-06&brand=clarice", method: "GET" }).reply(
      200,
      { total: 8, correct_pct: 62, correct_answer: "B", correct_count: 5 },
      { headers: { "content-type": "application/json" } },
    );

    const out = await fetchPollStats("2605-06", { brand: "clarice" });
    assert.equal(out.total_responses, 8);
    assert.equal(out.pct_correct, 62);
    assert.equal(out.below_threshold, false);
  });

  it('brand="diaria" explícito não anexa &brand= (mesmo comportamento do omitido)', async () => {
    const pool = mockAgent.get("https://poll.diaria.workers.dev");
    pool.intercept({ path: "/stats?edition=260603", method: "GET" }).reply(
      200,
      { total: 6, correct_pct: 50, correct_answer: "A", correct_count: 3 },
      { headers: { "content-type": "application/json" } },
    );

    const out = await fetchPollStats("260603", { brand: "diaria" });
    assert.equal(out.total_responses, 6);
  });

  it("abaixo do piso de confiança (MIN_RESPONSES=5) → below_threshold + pct_correct null", async () => {
    const pool = mockAgent.get("https://poll.diaria.workers.dev");
    pool.intercept({ path: "/stats?edition=260602&brand=clarice", method: "GET" }).reply(
      200,
      { total: 3, correct_pct: 100, correct_answer: "A", correct_count: 3 },
      { headers: { "content-type": "application/json" } },
    );

    const out = await fetchPollStats("260602", { brand: "clarice" });
    assert.equal(out.below_threshold, true);
    assert.equal(out.pct_correct, null, "pct_correct deve ser null mesmo com correct_pct=100 no payload — piso não atingido");
    assert.equal(out.skipped, "fewer_than_5_responses");
  });

  it("0 votos → below_threshold true, pct_correct null", async () => {
    const pool = mockAgent.get("https://poll.diaria.workers.dev");
    pool.intercept({ path: "/stats?edition=260604", method: "GET" }).reply(
      200,
      { total: 0, correct_pct: null, correct_answer: null, correct_count: 0 },
      { headers: { "content-type": "application/json" } },
    );

    const out = await fetchPollStats("260604");
    assert.equal(out.total_responses, 0);
    assert.equal(out.below_threshold, true);
    assert.equal(out.pct_correct, null);
  });

  it("falha de rede (host sem interceptor registrado) → fail-soft, nunca lança", async () => {
    // Sem pool.intercept() registrado — mockAgent.disableNetConnect() faz
    // qualquer request pra esse host lançar MockNotMatchedError, que
    // fetchPollStats deve engolir (mesmo fail-soft de sempre no CLI original).
    const out = await fetchPollStats("999999", {
      brand: "clarice",
      workerUrl: "https://unmocked-poll-host.example",
    });
    assert.equal(out.total_responses, 0);
    assert.equal(out.below_threshold, true);
    assert.equal(out.pct_correct, null);
    assert.equal(out.correct_choice, null);
  });

  it("workerUrl customizado é respeitado (override de POLL_WORKER_URL)", async () => {
    const pool = mockAgent.get("https://custom-poll.example");
    pool.intercept({ path: "/stats?edition=260605&brand=clarice", method: "GET" }).reply(
      200,
      { total: 5, correct_pct: 40, correct_answer: "B", correct_count: 2 },
      { headers: { "content-type": "application/json" } },
    );

    const out = await fetchPollStats("260605", { brand: "clarice", workerUrl: "https://custom-poll.example" });
    assert.equal(out.total_responses, 5);
    assert.equal(out.pct_correct, 40);
  });
});
