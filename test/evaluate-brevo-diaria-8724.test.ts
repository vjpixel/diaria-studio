/**
 * test/evaluate-brevo-diaria-8724.test.ts (#8724)
 *
 * Regressão: quando `runEvaluation` incrementa `failed` pra um contato, o
 * email + motivo precisam sobreviver no resultado estruturado
 * (`failedContacts`), não só num `log()` de stderr — achado ao vivo
 * (edição 260923): 2 de 109 contatos falharam, o resumo mostrou "2
 * falha(s)", mas nenhum e-mail era correlacionável no output truncado que
 * `brevo-diaria-run.ts`/`brevo-diaria-stage5-dispatch.ts` capturam (só as
 * últimas 8/4 linhas de stderr) — os `warn:` individuais desses 2 contatos
 * ficaram soterrados por logs de contatos posteriores, bloqueando o
 * dispatch do canal Brevo diária pra edição inteira sem dar pista de qual
 * contato ou por quê.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEvaluation } from "../scripts/evaluate-brevo-diaria.ts";
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

describe("runEvaluation — failedContacts correlaciona email + motivo (#8724)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("falha transitória na checagem de estado Brevo (Passo 0) — email + motivo aparecem em result.failedContacts", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/contacts/falha-transitoria%40b.com")) {
        throw new Error("network timeout simulado");
      }
      // Contatos "normais" no meio, simulando um lote grande onde o contato
      // com falha não é nem o primeiro nem o último — mesma forma do
      // incidente real (2 falhas em 109 contatos).
      return jsonRes(200, { emailBlacklisted: false, statistics: {} });
    }) as typeof fetch;

    try {
      const contacts = [
        contact("ok-1@b.com"),
        contact("falha-transitoria@b.com"),
        contact("ok-2@b.com"),
      ];
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
      assert.equal(result.failedContacts.length, 1, "cada failed++ tem exatamente 1 entrada correspondente em failedContacts");
      assert.equal(result.failedContacts[0].email, "falha-transitoria@b.com");
      assert.match(result.failedContacts[0].reason, /estado Brevo/);
      assert.match(result.failedContacts[0].reason, /network timeout simulado/);
    } finally {
      restore();
    }
  });

  it("2 falhas entre vários contatos OK (mesma forma do incidente real: 2 de 109) — failed === failedContacts.length, ambos e-mails presentes", async () => {
    const failingEmails = new Set(["falha-1@b.com", "falha-2@b.com"]);
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      for (const email of failingEmails) {
        if (u.includes(`/contacts/${encodeURIComponent(email)}`)) {
          throw new Error(`falha simulada pra ${email}`);
        }
      }
      return jsonRes(200, { emailBlacklisted: false, statistics: {} });
    }) as typeof fetch;

    try {
      const contacts = [
        contact("ok-1@b.com"),
        contact("falha-1@b.com"),
        contact("ok-2@b.com"),
        contact("ok-3@b.com"),
        contact("falha-2@b.com"),
        contact("ok-4@b.com"),
      ];
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

      assert.equal(result.failed, 2);
      assert.equal(result.failedContacts.length, result.failed, "1 entrada por incremento, sem desync entre o contador e o array");
      const failedEmails = result.failedContacts.map((f) => f.email).sort();
      assert.deepEqual(failedEmails, ["falha-1@b.com", "falha-2@b.com"]);
    } finally {
      restore();
    }
  });

  it("nenhuma falha → failedContacts vazio", async () => {
    globalThis.fetch = (async () => jsonRes(200, { emailBlacklisted: false, statistics: {} })) as typeof fetch;
    try {
      const contacts = [contact("tudo-ok@b.com")];
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
      assert.equal(result.failed, 0);
      assert.deepEqual(result.failedContacts, []);
    } finally {
      restore();
    }
  });
});
