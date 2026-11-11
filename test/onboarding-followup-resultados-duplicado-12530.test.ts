/**
 * test/onboarding-followup-resultados-duplicado-12530.test.ts (#12530)
 *
 * O e-mail dos resultados (#12495) sai só para quem respondeu pela 1ª vez
 * DEPOIS da edição especial. A 1ª resposta vinha só do que o store já tinha
 * visto, e o executor lia `/api/respostas` sem `?historico=1` (a mais recente
 * por e-mail). Cenário da issue: P responde antes de `results_published_at`
 * (recebe a edição especial), o store não grava (gate travado ou e-mail sem
 * par), P reenvia depois da publicação; o store só via a resposta nova e
 * `formResultsStepDue` devolvia `form_resultados`, um e-mail duplicado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyFormResponses, formResultsStepDue, resolveFollowupConfig, type FollowupPerson } from "../scripts/lib/onboarding-followup.ts";
import { fetchFormResponsesReal, formResponsesHistoryUrl, mergeFormResponseLists } from "../scripts/onboarding-followup-run.ts";
import type { FormResponse } from "../scripts/lib/onboarding-form-contract.ts";

const PUBLISHED = "2026-12-01T12:00:00Z";
const RESULTS = { url: "https://resultados.example/r", published_at: PUBLISHED };
const BEFORE: FormResponse = { email: "p@x.com", submitted_at: "2026-11-20T10:00:00Z", answers: { q: "antes" } };
const AFTER: FormResponse = { email: "p@x.com", submitted_at: "2026-12-10T10:00:00Z", answers: { q: "depois" } };

function person(over: Partial<FollowupPerson> = {}): FollowupPerson {
  return { kit_subscriber_id: 1, email: "p@x.com", cadastro_at: null, sends: [], ...over };
}

describe("#12530 a 1ª resposta vem do histórico", () => {
  it("cenário da issue: store não viu a 1ª resposta, reenvio depois da publicação não gera os resultados", () => {
    // Store nunca gravou a resposta de antes (gate travado / unmatched).
    const people = { "1": person() };
    // Executor lê a lista atual (só AFTER) + o histórico (BEFORE e AFTER).
    applyFormResponses(people, mergeFormResponseLists([AFTER], [BEFORE, AFTER]));
    const p = people["1"]!;
    assert.equal(p.form_filled_at, AFTER.submitted_at, "vale a mais recente para o reenvio anual");
    assert.equal(p.form_answers!.q, "depois");
    assert.equal(p.form_first_filled_at, BEFORE.submitted_at);
    assert.deepEqual(formResultsStepDue(p, RESULTS), { due: null, motivo: "recebeu_edicao_especial" });
  });

  it("store já com a resposta nova (rodada anterior ao fix) também é corrigido pelo histórico", () => {
    const people = { "1": person({ form_filled_at: AFTER.submitted_at }) };
    assert.deepEqual(formResultsStepDue(people["1"], RESULTS), { due: "form_resultados" }, "o bug: sem o histórico, sairia o e-mail");
    const r = applyFormResponses(people, [AFTER, BEFORE]);
    assert.deepEqual(r, { marked: 0, unmatched: 0 });
    assert.equal(people["1"]!.form_first_filled_at, BEFORE.submitted_at);
    assert.deepEqual(formResultsStepDue(people["1"], RESULTS), { due: null, motivo: "recebeu_edicao_especial" });
  });

  it("quem respondeu pela 1ª vez depois da publicação continua recebendo os resultados", () => {
    const people = { "1": person() };
    applyFormResponses(people, mergeFormResponseLists([AFTER], [AFTER]));
    assert.equal(people["1"]!.form_first_filled_at ?? null, null);
    assert.deepEqual(formResultsStepDue(people["1"], RESULTS), { due: "form_resultados" });
  });

  it("1ª registrada mais antiga que o histórico não é sobrescrita; e-mail antigo (previous_emails) conta", () => {
    const people = { "1": person({ email: "novo@x.com", previous_emails: ["p@x.com"], form_filled_at: "2026-12-05T10:00:00Z", form_first_filled_at: "2026-10-01T10:00:00Z" }) };
    applyFormResponses(people, [BEFORE, AFTER]);
    assert.equal(people["1"]!.form_first_filled_at, "2026-10-01T10:00:00Z");
    const people2 = { "1": person({ email: "novo@x.com", previous_emails: ["p@x.com"], form_filled_at: AFTER.submitted_at }) };
    applyFormResponses(people2, [{ ...AFTER, email: "novo@x.com" }, BEFORE]);
    assert.equal(people2["1"]!.form_first_filled_at, BEFORE.submitted_at);
  });
});

describe("#12530 fetchFormResponsesReal lê a lista atual e o histórico", () => {
  const cfg = resolveFollowupConfig({ enabled: true, form_url: "https://f.example/", form_responses_url: "https://f.example/api/respostas" });

  it("faz as duas leituras e junta sem repetir o mesmo envio", async () => {
    const urls: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const responses = new URL(url).searchParams.get("historico") === "1" ? [BEFORE, AFTER] : [AFTER];
      return new Response(JSON.stringify({ responses, next_cursor: null }), { status: 200 });
    }) as typeof fetch;
    const prev = process.env[cfg.formResponsesTokenEnv];
    process.env[cfg.formResponsesTokenEnv] = "tok";
    try {
      const out = await fetchFormResponsesReal(cfg, fake);
      assert.deepEqual(urls, ["https://f.example/api/respostas", "https://f.example/api/respostas?historico=1"]);
      assert.deepEqual(out.map((r) => r.submitted_at).sort(), [BEFORE.submitted_at, AFTER.submitted_at]);
    } finally {
      if (prev == null) delete process.env[cfg.formResponsesTokenEnv];
      else process.env[cfg.formResponsesTokenEnv] = prev;
    }
  });

  it("falha do histórico lança (nunca lista parcial)", async () => {
    const fake = (async (input: string | URL | Request) => {
      const hist = new URL(String(input)).searchParams.get("historico") === "1";
      return hist ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ responses: [AFTER], next_cursor: null }), { status: 200 });
    }) as typeof fetch;
    const prev = process.env[cfg.formResponsesTokenEnv];
    process.env[cfg.formResponsesTokenEnv] = "tok";
    try {
      await assert.rejects(fetchFormResponsesReal(cfg, fake), /HTTP 503/);
    } finally {
      if (prev == null) delete process.env[cfg.formResponsesTokenEnv];
      else process.env[cfg.formResponsesTokenEnv] = prev;
    }
  });

  it("formResponsesHistoryUrl preserva os parâmetros existentes", () => {
    assert.equal(formResponsesHistoryUrl("https://f.example/api/respostas?x=1"), "https://f.example/api/respostas?x=1&historico=1");
  });
});
