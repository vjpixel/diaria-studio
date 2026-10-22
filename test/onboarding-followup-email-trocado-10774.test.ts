/**
 * test/onboarding-followup-email-trocado-10774.test.ts (#10774)
 *
 * O link do formulário é assinado com o e-mail ATUAL do Kit (#10657), mas a
 * resposta era casada pelo e-mail da 1ª gravação no store. Quem trocou de
 * e-mail no Kit respondia, a resposta caía em `unmatched` e o lembrete
 * seguia saindo para sempre. Agora a leitura singular atualiza o e-mail do
 * store e o antigo continua casando via `previous_emails`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyFormResponses,
  FOLLOWUP_PREVIOUS_EMAILS_MAX,
  refreshPeopleEmailsFromChecks,
  type FollowupPerson,
  type LiveSubscriberCheck,
} from "../scripts/lib/onboarding-followup.ts";

function person(id: number, email: string): FollowupPerson {
  return { kit_subscriber_id: id, email, cadastro_at: null, sends: [] };
}

const check = (email: string | null): LiveSubscriberCheck => ({ state: "active", apoioNivel: "", email });

describe("#10774 resposta do formulário com e-mail trocado no Kit", () => {
  it("cenário da issue: troca no Kit, resposta com o e-mail novo casa e marca preencheu", () => {
    const people: Record<string, FollowupPerson> = { "7": person(7, "antigo@x.com") };
    // Sem a atualização, a resposta assinada com o e-mail novo não casa.
    const before = applyFormResponses(structuredClone(people), [{ email: "novo@x.com", submitted_at: "2026-10-22T10:00:00Z" }]);
    assert.deepEqual(before, { marked: 0, unmatched: 1 });

    assert.equal(refreshPeopleEmailsFromChecks(people, new Map([[7, check("Novo@X.com ")]])), 1);
    assert.equal(people["7"]!.email, "novo@x.com");
    assert.deepEqual(people["7"]!.previous_emails, ["antigo@x.com"]);

    const r = applyFormResponses(people, [{ email: "novo@x.com", submitted_at: "2026-10-22T10:00:00Z" }]);
    assert.deepEqual(r, { marked: 1, unmatched: 0 });
    assert.equal(people["7"]!.form_filled_at, "2026-10-22T10:00:00Z");
  });

  it("resposta já enviada com o e-mail antigo continua casando depois da troca", () => {
    const people: Record<string, FollowupPerson> = { "7": person(7, "antigo@x.com") };
    refreshPeopleEmailsFromChecks(people, new Map([[7, check("novo@x.com")]]));
    assert.deepEqual(applyFormResponses(people, [{ email: "antigo@x.com", submitted_at: "2026-10-20T10:00:00Z" }]), { marked: 1, unmatched: 0 });
  });

  it("e-mail antigo de uma pessoa nunca rouba a resposta do e-mail ATUAL de outra", () => {
    const people: Record<string, FollowupPerson> = { "7": person(7, "a@x.com"), "8": person(8, "b@x.com") };
    refreshPeopleEmailsFromChecks(people, new Map([[7, check("c@x.com")]]));
    // 8 assume o e-mail que já foi de 7
    refreshPeopleEmailsFromChecks(people, new Map([[8, check("a@x.com")]]));
    applyFormResponses(people, [{ email: "a@x.com", submitted_at: "2026-10-22T10:00:00Z" }]);
    assert.equal(people["8"]!.form_filled_at, "2026-10-22T10:00:00Z");
    assert.equal(people["7"]!.form_filled_at, undefined);
  });

  it("leitura falha, sem e-mail ou igual não mexe; pessoa fora do store é ignorada; histórico tem teto", () => {
    const people: Record<string, FollowupPerson> = { "7": person(7, "a@x.com") };
    const n = refreshPeopleEmailsFromChecks(people, new Map<number, LiveSubscriberCheck | null>([[7, null], [9, check("z@x.com")]]));
    assert.equal(n, 0);
    assert.equal(refreshPeopleEmailsFromChecks(people, new Map([[7, check("")]])), 0);
    assert.equal(refreshPeopleEmailsFromChecks(people, new Map([[7, check(" A@x.com")]])), 0);
    assert.equal(people["9"], undefined);
    assert.equal(people["7"]!.previous_emails, undefined);

    for (let i = 0; i < FOLLOWUP_PREVIOUS_EMAILS_MAX + 3; i++) {
      refreshPeopleEmailsFromChecks(people, new Map([[7, check(`n${i}@x.com`)]]));
    }
    assert.equal(people["7"]!.previous_emails!.length, FOLLOWUP_PREVIOUS_EMAILS_MAX);
    assert.ok(!people["7"]!.previous_emails!.includes(people["7"]!.email));
  });
});
