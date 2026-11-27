/**
 * test/brevo-diaria-stage5-skip-rapido-13981.test.ts (#13981)
 *
 * Regressão: no regime semanal (#11226), a edição que não é de segunda saía
 * `skipped` só DEPOIS do `brevo-diaria-run.ts --apply` (>5 min de rede: pool
 * Pending, MV, Brevo, Kit). Agora a decisão por data vem antes de qualquer
 * sub-script: zero chamadas a `exec` (o único caminho de rede do dispatch).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runStage5BrevoDispatch, type Stage5BrevoDeps } from "../scripts/brevo-diaria-stage5-dispatch.ts";
import type { BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";

function deps(calls: string[], contacts: readonly BrevoDiariaContact[] = [], semanal: unknown = { enabled: true, desde: "2026-11-02" }): Stage5BrevoDeps {
  return {
    rootDir: "/fake",
    exec: (script) => {
      calls.push(script);
      return { code: 0, stdout: JSON.stringify({ warnings: [] }), stderr: "" };
    },
    storeExists: () => true,
    readContacts: () => contacts,
    readPlatformConfig: () => ({ brevo_diaria: { stage5_target_total: 290, semanal } }),
    readPublished: () => (calls.includes("scripts/publish-daily-brevo.ts") ? { campaign_id: 7 } : null),
  };
}

describe("brevo-diaria stage5 — skip rápido fora da segunda (#13981)", () => {
  for (const edition of ["261124", "261125", "261126", "261127", "261128"]) {
    it(`REGRESSÃO: ${edition} (não é segunda) ⇒ skipped com a mesma saída, ZERO chamadas de sub-script/rede`, () => {
      const calls: string[] = [];
      const r = runStage5BrevoDispatch(`/fake/data/editions/2611/${edition}`, deps(calls));
      assert.deepEqual(r, {
        status: "skipped",
        reason: `regime semanal (#11226): a edição ${edition} não é de segunda — sem campanha Brevo.`,
        warnings: [],
      });
      assert.deepEqual(calls, []);
    });
  }

  it("segunda (261123) ⇒ caminho cheio: --apply e campanha", () => {
    const calls: string[] = [];
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", deps(calls));
    assert.equal(r.status, "ok");
    assert.deepEqual(calls, ["scripts/brevo-diaria-run.ts", "scripts/publish-daily-brevo.ts"]);
  });

  it("guarda de transição (#10533): kit-sem-abertura: em in_brevo ⇒ sem skip rápido, sai diária", () => {
    const calls: string[] = [];
    const residuo = [{ email: "a@x.com", status: "in_brevo", beehiiv_subscription_id: "kit-sem-abertura:123" }] as unknown as BrevoDiariaContact[];
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261125", deps(calls, residuo));
    assert.equal(r.status, "ok");
    assert.ok(calls.includes("scripts/brevo-diaria-run.ts"));
  });

  it("regime semanal desligado ⇒ diária como antes, --apply roda", () => {
    const calls: string[] = [];
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261125", deps(calls, [], null));
    assert.equal(r.status, "ok");
    assert.ok(calls.includes("scripts/brevo-diaria-run.ts"));
  });
});
