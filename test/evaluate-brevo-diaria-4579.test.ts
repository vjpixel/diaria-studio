/**
 * test/evaluate-brevo-diaria-4579.test.ts (#4579)
 *
 * Guard de reconciliação de órfãos: `brunopierro2@gmail.com` estava
 * vinculado à lista Brevo (`listIds` incluindo o `list_id` deste canal) e
 * recebendo envios, mas ausente de `data/brevo-diaria/contacts.json` —
 * `runEvaluation` só avalia `store.contacts.filter(status === "in_brevo")`,
 * então um contato órfão nunca é avaliado pra promoção/supressão. Estes
 * testes cobrem só o item 2 da issue (guard determinístico) — o item 1
 * (adicionar `brunopierro2@gmail.com` retroativamente ao store real) é ação
 * separada do editor, fora do escopo desta unidade e nunca tocado aqui.
 *
 * NUNCA chama a API Brevo real — `globalThis.fetch` sempre mockado, mesmo
 * padrão do resto de `evaluate-brevo-diaria-4266.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fetchBrevoListEmails,
  findOrphanContacts,
  reconcileStoreWithBrevoList,
} from "../scripts/evaluate-brevo-diaria.ts";
import type { BrevoDiariaContact, BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fixture — contato mínimo do store, com overrides pontuais por teste. */
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

function storeOf(contacts: BrevoDiariaContact[]): BrevoDiariaStore {
  return { contacts };
}

describe("findOrphanContacts — diff puro entre lista Brevo e store (#4579)", () => {
  it("e-mail na lista Brevo mas ausente do store inteiro → órfão", () => {
    const store = storeOf([contact("known@a.com")]);
    const orphans = findOrphanContacts(["known@a.com", "brunopierro2@gmail.com"], store);
    assert.deepEqual(orphans, ["brunopierro2@gmail.com"]);
  });

  it("todos os e-mails da lista já conhecidos pelo store → nenhum órfão", () => {
    const store = storeOf([contact("a@x.com"), contact("b@x.com")]);
    const orphans = findOrphanContacts(["a@x.com", "b@x.com"], store);
    assert.deepEqual(orphans, []);
  });

  it("lista Brevo vazia → nenhum órfão, mesmo com store não-vazio", () => {
    const store = storeOf([contact("a@x.com")]);
    assert.deepEqual(findOrphanContacts([], store), []);
  });

  it("contato com QUALQUER status resolvido no store (não só in_brevo) conta como conhecido, não é órfão", () => {
    const store = storeOf([
      contact("promoted@x.com", { status: "promoted_beehiiv" }),
      contact("suppressed@x.com", { status: "suppressed" }),
      contact("unsub@x.com", { status: "unsubscribed" }),
    ]);
    const orphans = findOrphanContacts(["promoted@x.com", "suppressed@x.com", "unsub@x.com"], store);
    assert.deepEqual(orphans, [], "status resolvido ainda é 'conhecido' — a definição de órfão é 'nunca ingerido', não 'in_brevo'");
  });

  it("normaliza e-mail (case/trim) antes de comparar — mesma pessoa com capitalização diferente não é órfão", () => {
    const store = storeOf([contact("known@a.com")]);
    const orphans = findOrphanContacts(["  Known@A.com  "], store);
    assert.deepEqual(orphans, []);
  });

  it("dedup do input — o mesmo e-mail repetido na lista Brevo (ex: páginas adjacentes) conta 1x só", () => {
    const store = storeOf([]);
    const orphans = findOrphanContacts(["dup@a.com", "DUP@a.com", "dup@a.com"], store);
    assert.deepEqual(orphans, ["dup@a.com"]);
  });

  it("mistura de órfãos e conhecidos → devolve exatamente a diferença, na ordem de aparição", () => {
    const store = storeOf([contact("known1@a.com"), contact("known2@a.com")]);
    const orphans = findOrphanContacts(["orphan1@a.com", "known1@a.com", "orphan2@a.com", "known2@a.com"], store);
    assert.deepEqual(orphans, ["orphan1@a.com", "orphan2@a.com"]);
  });

  it("caso da issue #4579: reproduz 98 conhecidos + 5 sondas editoriais + 1 órfão (brunopierro2) → só o órfão retorna", () => {
    const known = Array.from({ length: 98 }, (_, i) => contact(`known${i}@a.com`));
    const editorSeeds = ["pixel@memelab.com.br", "vjpixel@gmail.com", "seed3@a.com", "seed4@a.com", "seed5@a.com"].map((e) =>
      contact(e),
    );
    const store = storeOf([...known, ...editorSeeds]);
    const brevoListEmails = [...known.map((c) => c.email), ...editorSeeds.map((c) => c.email), "brunopierro2@gmail.com"];
    assert.equal(brevoListEmails.length, 104, "98 + 5 + 1 = 104, mesma conta reportada na issue");
    const orphans = findOrphanContacts(brevoListEmails, store);
    assert.deepEqual(orphans, ["brunopierro2@gmail.com"]);
  });
});

describe("fetchBrevoListEmails — paginação + fail-loud (#4579)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("agrega e-mails de múltiplas páginas até a página final (< limit)", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("offset=0")) {
        const contacts = Array.from({ length: 50 }, (_, i) => ({ email: `p1-${i}@a.com` }));
        return jsonRes(200, { contacts });
      }
      if (u.includes("offset=50")) {
        return jsonRes(200, { contacts: [{ email: "p2-0@a.com" }, { email: "p2-1@a.com" }] });
      }
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    try {
      const emails = await fetchBrevoListEmails("key", 7);
      assert.equal(emails.length, 52);
      assert.ok(emails.includes("p2-1@a.com"));
      assert.equal(calls.length, 2, "para de paginar assim que uma página vem menor que o limit");
    } finally {
      restore();
    }
  });

  it("contato sem e-mail (linha malformada) é ignorado, não quebra a paginação", async () => {
    globalThis.fetch = (async () => jsonRes(200, { contacts: [{ email: "ok@a.com" }, {}] })) as typeof fetch;
    try {
      const emails = await fetchBrevoListEmails("key", 7);
      assert.deepEqual(emails, ["ok@a.com"]);
    } finally {
      restore();
    }
  });

  it("403 (auth/config) FALHA ALTO via brevoGet — nunca trata como lista vazia (#4579, mesma disciplina do #4532)", async () => {
    globalThis.fetch = (async () => jsonRes(403, { message: "forbidden" })) as typeof fetch;
    try {
      // brevoGet já lança pra qualquer 4xx != 404 (ver brevo-client.ts) —
      // fetchBrevoListEmails nunca chega a engolir esse erro como "vazio".
      await assert.rejects(() => fetchBrevoListEmails("key", 7), /falhou \(403\)/);
    } finally {
      restore();
    }
  });

  it("404 (list_id inexistente/permissão revogada) FALHA ALTO — brevoGet devolve status sem lançar, mas fetchBrevoListEmails recusa tratar como lista vazia (#4579, mesma disciplina do #4532)", async () => {
    // brevoGet trata 404 como {status:404, body:{}} sem lançar (desenhado pra
    // lookup de contato único) — é o guard explícito em fetchBrevoListEmails
    // que impede isso de virar um falso "zero órfãos" aqui.
    globalThis.fetch = (async () => jsonRes(404, {})) as typeof fetch;
    try {
      await assert.rejects(() => fetchBrevoListEmails("key", 7), /retornou status 404/);
    } finally {
      restore();
    }
  });
});

describe("reconcileStoreWithBrevoList — orquestração fetch+diff+log, nunca escreve no store (#4579)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("órfão encontrado → summary.orphanEmails preenchido + log com ALERTA citando o e-mail e a issue", async () => {
    globalThis.fetch = (async () =>
      jsonRes(200, { contacts: [{ email: "known@a.com" }, { email: "brunopierro2@gmail.com" }] })) as typeof fetch;
    const logs: string[] = [];
    try {
      const store = storeOf([contact("known@a.com")]);
      const summary = await reconcileStoreWithBrevoList({ brevoApiKey: "key", listId: 7, store, log: (m) => logs.push(m) });
      assert.equal(summary.brevoListCount, 2);
      assert.deepEqual(summary.orphanEmails, ["brunopierro2@gmail.com"]);
      assert.ok(logs.some((l) => l.includes("ALERTA") && l.includes("brunopierro2@gmail.com") && l.includes("#4579")));
    } finally {
      restore();
    }
  });

  it("nenhum órfão → log informativo, sem ALERTA", async () => {
    globalThis.fetch = (async () => jsonRes(200, { contacts: [{ email: "known@a.com" }] })) as typeof fetch;
    const logs: string[] = [];
    try {
      const store = storeOf([contact("known@a.com")]);
      const summary = await reconcileStoreWithBrevoList({ brevoApiKey: "key", listId: 7, store, log: (m) => logs.push(m) });
      assert.deepEqual(summary.orphanEmails, []);
      assert.ok(logs.some((l) => l.includes("nenhum órfão")));
      assert.ok(!logs.some((l) => l.includes("ALERTA")));
    } finally {
      restore();
    }
  });

  it("nunca muta o store dado — o objeto retornado em summary não inclui campos de store, e o store original permanece intacto", async () => {
    globalThis.fetch = (async () => jsonRes(200, { contacts: [{ email: "orphan@a.com" }] })) as typeof fetch;
    try {
      const store = storeOf([contact("known@a.com")]);
      const before = JSON.stringify(store);
      await reconcileStoreWithBrevoList({ brevoApiKey: "key", listId: 7, store, log: () => {} });
      assert.equal(JSON.stringify(store), before, "reconcileStoreWithBrevoList é read-only sobre o store");
    } finally {
      restore();
    }
  });

  it("falha na chamada Brevo (403) propaga (o caller em main() decide o fail-safe, não esta função)", async () => {
    globalThis.fetch = (async () => jsonRes(403, {})) as typeof fetch;
    try {
      const store = storeOf([]);
      await assert.rejects(() => reconcileStoreWithBrevoList({ brevoApiKey: "key", listId: 7, store, log: () => {} }));
    } finally {
      restore();
    }
  });
});
