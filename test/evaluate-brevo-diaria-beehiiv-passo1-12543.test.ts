/**
 * test/evaluate-brevo-diaria-beehiiv-passo1-12543.test.ts (#12543)
 *
 * Regressão do probe de 09/11/2026 no 300: `diaria-brevo-diaria-evaluate`
 * saiu com exit 3 e reabriu o alarme #6786 porque 22 contatos tiveram
 * `falha ao checar status Beehiiv (Passo 1)` (429 da Beehiiv), com o push
 * concluído e o store gravado. A Beehiiv é só arquivo desde o #11225: sem o
 * status dela o único efeito é adiar a auto-confirmação, e o contato segue
 * avaliado pela abertura. A falha do Passo 1 virou aviso
 * (`beehiivStatusUnavailable`), fora de `failed` e do exit code.
 *
 * A fronteira fica travada também: a falha da Beehiiv no Passo 0 (contato
 * `emailBlacklisted`, que fica sem decisão nenhuma) continua em `failed`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  beehiivStatusUnavailableMessage,
  resolveEvaluateExitCode,
  runEvaluation,
} from "../scripts/evaluate-brevo-diaria.ts";
import type { BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function contact(email: string, overrides: Partial<BrevoDiariaContact> = {}): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: `sub_${email}`,
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: "2026-07-01T00:00:00.000Z",
    last_evaluated_at: null,
    ...overrides,
  };
}

describe("evaluate-brevo-diaria — status Beehiiv indisponível no Passo 1 é aviso, não falha (#12543)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("429 da Beehiiv no Passo 1 em vários contatos (push): failed=0, exit 0, aviso com e-mail + motivo, contato avaliado pela abertura", async () => {
    const logs: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return new Response("rate limited", { status: 429 });
      // GET /contacts/{email} da Brevo: sem blacklist, sem envios → "keep".
      return jsonRes(200, { emailBlacklisted: false, statistics: {} });
    }) as typeof fetch;

    try {
      const contacts = [contact("a@b.com"), contact("c@d.com"), contact("e@f.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: (m) => logs.push(m),
      });

      assert.equal(result.failed, 0, "falha da Beehiiv no Passo 1 não entra em failed");
      assert.equal(result.failedContacts.length, 0);
      assert.equal(resolveEvaluateExitCode(result), 0, "a rodada não sai com exit 3 por causa da Beehiiv");
      assert.deepEqual(
        result.beehiivStatusUnavailable.map((e) => e.email),
        ["a@b.com", "c@d.com", "e@f.com"],
      );
      assert.match(result.beehiivStatusUnavailable[0].reason, /Beehiiv API 429/);
      assert.equal(result.selfConfirmed, 0, "sem status, nunca auto-confirma");
      assert.equal(result.kept, 3, "todos seguem pra avaliação normal (Passo 2)");
      for (const c of result.store.contacts) assert.equal(c.status, "in_brevo");
      assert.ok(logs.some((l) => l.includes("falha ao checar status Beehiiv de a@b.com")), "o warn por contato continua no log");
    } finally {
      restore();
    }
  });

  it("falha da Beehiiv no Passo 0 (emailBlacklisted) continua em failed: ali o contato fica sem decisão", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return new Response("rate limited", { status: 429 });
      return jsonRes(200, { emailBlacklisted: true, statistics: {} });
    }) as typeof fetch;

    try {
      const contacts = [contact("bl@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 1);
      assert.match(result.failedContacts[0].reason, /Passo 0/);
      assert.equal(result.beehiivStatusUnavailable.length, 0, "o Passo 1 nem roda pra ele (continue no Passo 0)");
      assert.notEqual(resolveEvaluateExitCode(result), 0);
    } finally {
      restore();
    }
  });

  it("mensagem do resumo diz quantos, quem e que não muda o exit code", () => {
    const m = beehiivStatusUnavailableMessage([
      { email: "a@b.com", reason: "Beehiiv API 429 em subscriptions/by_email/a@b.com" },
      { email: "c@d.com", reason: "rede" },
    ]);
    assert.match(m, /^warn: 2 contato\(s\) sem status Beehiiv no Passo 1/);
    assert.match(m, /não muda o exit code/);
    assert.match(m, /a@b\.com \[Beehiiv API 429/);
    assert.match(m, /c@d\.com \[rede\]/);
  });
});
