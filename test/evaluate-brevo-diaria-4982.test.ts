/**
 * test/evaluate-brevo-diaria-4982.test.ts (#4982)
 *
 * Guard de reconciliação de seeds ausentes: `EDITOR_SEED_EMAILS`
 * (`scripts/lib/editor-copy.ts`) ficam vinculados MANUALMENTE à lista Brevo
 * `brevo_diaria`, fora do store de propósito (sonda de deliverability
 * cross-provedor, não assinante real) — mas nada checava se os 5 continuavam
 * de fato vinculados à lista. 2 já caíram sem detecção antes desta issue.
 * `findMissingSeedEmails`/`reconcileStoreWithBrevoList` fecham esse gap no
 * sentido OPOSTO de `findOrphanContacts` (#4579, ver
 * `evaluate-brevo-diaria-4579.test.ts`): em vez de e-mail-na-lista-mas-fora-
 * do-store, é seed-esperado-mas-fora-da-lista.
 *
 * NUNCA chama a API Brevo real — `globalThis.fetch` sempre mockado, mesmo
 * padrão do resto do arquivo (#4579/#4266).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findMissingSeedEmails,
  reconcileStoreWithBrevoList,
} from "../scripts/evaluate-brevo-diaria.ts";
import { EDITOR_SEED_EMAILS } from "../scripts/lib/editor-copy.ts";
import type { BrevoDiariaContact, BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

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

function storeOf(contacts: BrevoDiariaContact[]): BrevoDiariaStore {
  return { contacts };
}

// Mecanismo puro testado contra uma fixture LITERAL própria (via o 2º
// parâmetro de `findMissingSeedEmails`, sempre sobrescrevível — ver último
// teste do bloco) em vez do `EDITOR_SEED_EMAILS` real: decopla estes testes
// de mecanismo do tamanho/conteúdo atual da lista de produção. Reduzida de 5
// pra 2 endereços em 16/09/2026 (decisão do editor, ver docstring de
// `editor-copy.ts`) — antes dessa mudança, vários destes testes hardcodeavam
// e-mails específicos da lista de produção e quebraram junto com a redução.
const FIXTURE_SEEDS = ["seed-a@example.com", "seed-b@example.com", "seed-c@example.com"];

describe("findMissingSeedEmails — diff puro, sentido OPOSTO de findOrphanContacts (#4982)", () => {
  it("todos os seeds presentes na lista Brevo → nenhum ausente", () => {
    const brevoListEmails = ["known@a.com", ...FIXTURE_SEEDS];
    assert.deepEqual(findMissingSeedEmails(brevoListEmails, FIXTURE_SEEDS), []);
  });

  it("1 dos seeds ausente da lista Brevo → reportado", () => {
    const present = FIXTURE_SEEDS.filter((e) => e !== "seed-c@example.com");
    const brevoListEmails = ["known@a.com", ...present];
    assert.deepEqual(findMissingSeedEmails(brevoListEmails, FIXTURE_SEEDS), ["seed-c@example.com"]);
  });

  it("2 de 3 ausentes → os 2 reportados, na ordem de `seedEmails`", () => {
    const present = FIXTURE_SEEDS.filter((e) => e !== "seed-a@example.com" && e !== "seed-b@example.com");
    const missing = findMissingSeedEmails(present, FIXTURE_SEEDS);
    assert.deepEqual(missing, ["seed-a@example.com", "seed-b@example.com"]);
  });

  it("lista Brevo vazia → todos os seeds reportados como ausentes", () => {
    assert.deepEqual(findMissingSeedEmails([], FIXTURE_SEEDS), [...FIXTURE_SEEDS]);
  });

  it("normaliza e-mail (case/trim) antes de comparar — seed presente com capitalização diferente não é reportado ausente", () => {
    const brevoListEmails = FIXTURE_SEEDS.map((e) => `  ${e.toUpperCase()}  `);
    assert.deepEqual(findMissingSeedEmails(brevoListEmails, FIXTURE_SEEDS), []);
  });

  it("default de seedEmails é EDITOR_SEED_EMAILS quando o chamador não passa o 2º parâmetro", () => {
    const brevoListEmails = ["known@a.com", ...EDITOR_SEED_EMAILS];
    assert.deepEqual(findMissingSeedEmails(brevoListEmails), []);
    assert.deepEqual(findMissingSeedEmails(["known@a.com"]), [...EDITOR_SEED_EMAILS]);
  });

  it("seedEmails é sobrescrevível — chamador pode passar uma lista diferente (ex: teste isolado)", () => {
    const missing = findMissingSeedEmails(["present@a.com"], ["present@a.com", "custom-missing@a.com"]);
    assert.deepEqual(missing, ["custom-missing@a.com"]);
  });
});

describe("reconcileStoreWithBrevoList — checagem de seeds ausentes integrada (#4982)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("seed ausente → summary.missingSeedEmails preenchido + log com ALERTA citando o e-mail e #4982", async () => {
    const missingSeed = EDITOR_SEED_EMAILS[EDITOR_SEED_EMAILS.length - 1];
    const present = EDITOR_SEED_EMAILS.filter((e) => e !== missingSeed);
    globalThis.fetch = (async () =>
      jsonRes(200, { contacts: [{ email: "known@a.com" }, ...present.map((email) => ({ email }))] })) as typeof fetch;
    const logs: string[] = [];
    try {
      const store = storeOf([contact("known@a.com")]);
      const summary = await reconcileStoreWithBrevoList({ brevoApiKey: "key", listId: 7, store, log: (m) => logs.push(m) });
      assert.deepEqual(summary.missingSeedEmails, [missingSeed]);
      assert.ok(
        logs.some((l) => l.includes("ALERTA") && l.includes(missingSeed) && l.includes("#4982")),
        "esperava log de ALERTA citando o seed ausente e a issue #4982",
      );
    } finally {
      restore();
    }
  });

  it("todos os EDITOR_SEED_EMAILS presentes → summary.missingSeedEmails vazio + log informativo, sem ALERTA de seed", async () => {
    globalThis.fetch = (async () =>
      jsonRes(200, { contacts: [{ email: "known@a.com" }, ...EDITOR_SEED_EMAILS.map((email) => ({ email }))] })) as typeof fetch;
    const logs: string[] = [];
    try {
      const store = storeOf([contact("known@a.com")]);
      const summary = await reconcileStoreWithBrevoList({ brevoApiKey: "key", listId: 7, store, log: (m) => logs.push(m) });
      assert.deepEqual(summary.missingSeedEmails, []);
      assert.ok(logs.some((l) => l.includes("reconciliação de seeds (#4982)") && l.includes("presentes")));
      assert.ok(!logs.some((l) => l.includes("ALERTA") && l.includes("#4982")));
    } finally {
      restore();
    }
  });

  it("nunca muta o store dado, mesmo com seeds ausentes", async () => {
    const present = EDITOR_SEED_EMAILS.slice(0, 1);
    globalThis.fetch = (async () => jsonRes(200, { contacts: present.map((email) => ({ email })) })) as typeof fetch;
    try {
      const store = storeOf([contact("known@a.com")]);
      const before = JSON.stringify(store);
      await reconcileStoreWithBrevoList({ brevoApiKey: "key", listId: 7, store, log: () => {} });
      assert.equal(JSON.stringify(store), before, "reconcileStoreWithBrevoList é read-only sobre o store, também pro guard de seeds");
    } finally {
      restore();
    }
  });

  it("órfão E seed ausente no mesmo run → summary reporta os dois independentemente", async () => {
    const missingSeed = EDITOR_SEED_EMAILS[EDITOR_SEED_EMAILS.length - 1];
    const present = EDITOR_SEED_EMAILS.filter((e) => e !== missingSeed);
    globalThis.fetch = (async () =>
      jsonRes(200, {
        contacts: [{ email: "known@a.com" }, { email: "orphan@a.com" }, ...present.map((email) => ({ email }))],
      })) as typeof fetch;
    const logs: string[] = [];
    try {
      const store = storeOf([contact("known@a.com")]);
      const summary = await reconcileStoreWithBrevoList({ brevoApiKey: "key", listId: 7, store, log: (m) => logs.push(m) });
      assert.deepEqual(summary.orphanEmails, ["orphan@a.com"]);
      assert.deepEqual(summary.missingSeedEmails, [missingSeed]);
      assert.ok(logs.some((l) => l.includes("ALERTA reconciliação (#4579)") && l.includes("orphan@a.com")));
      assert.ok(logs.some((l) => l.includes("ALERTA reconciliação (#4982)") && l.includes(missingSeed)));
    } finally {
      restore();
    }
  });
});
