/**
 * test/scheduled-tasks-failover-tier-12982.test.ts (#12982)
 *
 * Toda task do registro declara o tier de contingência (`failover`), e o
 * conjunto `critical` (o que o Neo roda quando o 300 cai) é uma decisão
 * explícita: mudar a lista exige mudar este teste, com justificativa na PR.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FAILOVER_TIERS, SCHEDULED_TASKS, resolveFailoverTier } from "../scripts/lib/scheduled-tasks.ts";

describe("#12982 — tier de failover no registro", () => {
  it("toda task tem `failover` com valor válido", () => {
    const sem = SCHEDULED_TASKS.filter((t) => !(FAILOVER_TIERS as readonly string[]).includes((t as { failover?: unknown }).failover as string));
    assert.deepEqual(
      sem.map((t) => t.name),
      [],
      "task sem `failover` (ou com valor fora de critical/catchup/skip): declare o tier ao criar a task (default: skip)",
    );
  });

  it("o conjunto critical é o decidido no #12982", () => {
    const critical = SCHEDULED_TASKS.filter((t) => t.failover === "critical")
      .map((t) => t.name)
      .sort();
    assert.deepEqual(critical, [
      "Diaria-Circle-Stack-Weekly-Publish",
      "Diaria-Clarice-Envio",
      "Diaria-Clarice-Envio-Guard",
      "Diaria-Clarice-Novos",
      "Diaria-Clarice-Novos-Tarde",
      "Diaria-Onboarding-Watch-Returning",
      "Diaria-Onboarding-Welcome-Run",
      "Diaria-Shorts-Cortes",
      "Diaria-Shorts-Instagram",
      "Diaria-Shorts-Instagram-Catchup",
      "Diaria-Shorts-LinkedIn-Profile",
      "Diaria-Shorts-LinkedIn-Profile-Catchup",
      "Diaria-Shorts-Threads-Profile",
      "Diaria-Shorts-Threads-Profile-Catchup",
      "Diaria-Video-D1-Link-Watch",
    ]);
  });

  it("nenhuma task critical é mensal nem desabilitada (o Neo não arma nenhuma das duas)", () => {
    for (const t of SCHEDULED_TASKS.filter((x) => x.failover === "critical")) {
      assert.notEqual(t.schedule.kind, "monthly", `${t.name}: schedule monthly não tem trigger no failover do Neo`);
      assert.notEqual(t.enabled, false, `${t.name}: task critical desabilitada não faz sentido no failover`);
    }
  });

  it("nenhuma task de alarme/drift/staleness é critical", () => {
    const suspeitas = SCHEDULED_TASKS.filter((t) => t.failover === "critical" && /Alarm|Drift|Staleness|-Check$/.test(t.name));
    assert.deepEqual(suspeitas.map((t) => t.name), []);
  });

  it("Nightly-Chain fica fora (overnight não roda no Neo, ver docs/failover-neo.md)", () => {
    const t = SCHEDULED_TASKS.find((x) => x.name === "Diaria-Nightly-Chain");
    assert.ok(t);
    assert.equal(t.failover, "skip");
  });

  it("resolveFailoverTier: ausente vira skip", () => {
    assert.equal(resolveFailoverTier({}), "skip");
    assert.equal(resolveFailoverTier({ failover: "critical" }), "critical");
  });
});
