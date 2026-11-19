/**
 * #13612: rodada overnight com sufixo (`data/overnight/261118b/`) gravava o
 * run-log sob duas edições — `coordinator_tokens_estimate` sob `261118b`
 * (record-overnight-wave.ts, nome da pasta) e `subagent_metrics`/
 * `review_metrics` sob `261118` (a SKILL manda `--edition {AAMMDD}`) — e o
 * gate de instrumentação acusava falta nas duas.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  editionMatches,
  resolveEmitterEdition,
  roundEditionBase,
  runEditionFromPlanPath,
  sameRoundEdition,
} from "../scripts/lib/overnight-round-edition.ts";
import {
  countTokenInstrumentationEvents,
  editionSpellingsSeen,
  resolveEditionFromArgs,
  resolveTokenInstrumentationVerdict,
} from "../scripts/check-overnight-token-instrumentation.ts";
import { lastCoordinatorCumulativeBase } from "../scripts/coordinator-usage-estimate.ts";
import { indexExistingEvents } from "../scripts/subagent-usage-metrics.ts";

const SID = "c3525b07-a30d-48af-a92f-93a73b03fab9";
const OTHER = "11111111-2222-3333-4444-555555555555";
const ev = (edition: string, message: string, details: Record<string, unknown>) =>
  JSON.stringify({ edition, agent: "overnight", level: "info", message, details });

/** O run-log da 261118b como saiu em 18/11/2026, mais um evento da outra rodada do dia. */
const lines = [
  ev("261118b", "coordinator_tokens_estimate", { phase: "onda w1", tokens: 100, cumulative_tokens: 100, source: "context_size_proxy", session_id: SID }),
  ev("261118", "subagent_metrics", { papel: "dev-implementador", subagent_tokens: 50, agent_id: "a1", session_id: SID }),
  ev("261118", "review_metrics", { agent_id: "r1", session_id: SID }),
  ev("261118", "coordinator_tokens_estimate", { phase: "fase_0", tokens: 7, cumulative_tokens: 7, session_id: OTHER }),
];

describe("#13612: grafias da edição de uma rodada", () => {
  it("base e mesma rodada", () => {
    assert.equal(roundEditionBase("261118b"), "261118");
    assert.equal(roundEditionBase("261118"), "261118");
    assert.equal(roundEditionBase("2611"), null);
    assert.equal(sameRoundEdition("261118", "261118b"), true);
    assert.equal(sameRoundEdition("261118c", "261118b"), true);
    assert.equal(sameRoundEdition("261117", "261118b"), false);
  });

  it("a outra grafia só casa com sessão", () => {
    assert.equal(editionMatches("261118", "261118b", SID), true);
    assert.equal(editionMatches("261118", "261118b", null), false);
    assert.equal(editionMatches("261118b", "261118b", null), true);
  });

  it("edição do plano: o nome da pasta", () => {
    assert.equal(runEditionFromPlanPath("/r/data/overnight/261118b/plan.json"), "261118b");
    assert.equal(runEditionFromPlanPath("/tmp/x/plan.json"), null);
  });

  it("emissores com --plan: a pasta vence o AAMMDD do mesmo dia; dia diferente é erro", () => {
    const plan = "/r/data/overnight/261118b/plan.json";
    assert.deepEqual(resolveEmitterEdition({ plan }), { edition: "261118b" });
    const r = resolveEmitterEdition({ edition: "261118", plan });
    assert.ok(!("error" in r));
    assert.equal(r.edition, "261118b");
    assert.ok("error" in resolveEmitterEdition({ edition: "261117", plan }));
    assert.deepEqual(resolveEmitterEdition({ edition: "261118" }), { edition: "261118" });
    assert.ok("error" in resolveEmitterEdition({}));
  });
});

describe("#13612: check-overnight-token-instrumentation aceita as duas grafias da mesma sessão", () => {
  it("--edition 261118 e --edition 261118b, com a sessão do plano: OK nas duas", () => {
    for (const edition of ["261118", "261118b"]) {
      const counts = countTokenInstrumentationEvents(lines, edition, SID);
      assert.deepEqual(counts, { subagent_metrics: 1, coordinator_tokens_estimate: 1, review_metrics: 1 }, edition);
      assert.equal(resolveTokenInstrumentationVerdict(counts).status, "ok", edition);
    }
    assert.deepEqual(editionSpellingsSeen(lines, "261118", SID), ["261118", "261118b"]);
  });

  it("sem filtro de sessão, só a edição exata (a 261118 é compartilhada com a outra rodada)", () => {
    assert.deepEqual(countTokenInstrumentationEvents(lines, "261118b"), { subagent_metrics: 0, coordinator_tokens_estimate: 1, review_metrics: 0 });
  });

  it("evento da outra sessão na 261118 não conta para esta", () => {
    assert.equal(countTokenInstrumentationEvents(lines, "261118b", SID).coordinator_tokens_estimate, 1);
  });

  it("só --plan basta para a edição", () => {
    assert.equal(resolveEditionFromArgs({ plan: "/r/data/overnight/261118b/plan.json" }), "261118b");
  });
});

describe("#13612: emissores leem a base/dedup nas duas grafias da mesma sessão", () => {
  it("delta do coordenador: checkpoint sob 261118 usa a base gravada sob 261118b (mesma sessão)", () => {
    assert.equal(lastCoordinatorCumulativeBase(lines, "261118", "overnight", SID), 100);
    // A outra sessão segue com a base dela.
    assert.equal(lastCoordinatorCumulativeBase(lines, "261118", "overnight", OTHER), 7);
  });

  it("subagent-usage-metrics: o tipo já gravado sob a outra grafia conta como presente", () => {
    const idx = indexExistingEvents(lines, "261118b", SID);
    assert.ok(idx.presentInEdition.has("subagent_metrics"));
    assert.ok(idx.presentInEdition.has("review_metrics"));
  });
});
