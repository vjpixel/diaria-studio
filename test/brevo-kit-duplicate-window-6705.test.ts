/**
 * test/brevo-kit-duplicate-window-6705.test.ts (#6705)
 *
 * Cobre a instrumentação de MEDIÇÃO da janela de duplicidade Kit×Brevo:
 * (1) a função pura `buildDuplicateWindowEntry` (`lib/brevo-kit-duplicate-
 *     window.ts`) — cálculo de `hours_since_last_brevo_send` e os
 *     fail-safes de timestamp ausente/não-parseável;
 * (2) `runEvaluation` (`scripts/evaluate-brevo-diaria.ts`) chama a
 *     dependência injetável `appendDuplicateWindowLog` exatamente quando
 *     detecta, em `push:true`, um contato de origem Kit já `active` — e
 *     NUNCA quando a dependência é omitida (garante que a suíte de testes
 *     existente, que não passa esse parâmetro, nunca grava em disco).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDuplicateWindowEntry,
  type BrevoKitDuplicateWindowEntry,
} from "../scripts/lib/brevo-kit-duplicate-window.ts";
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

function kitSubscriberRes(id: number, state: string, email: string, createdAt = "2026-08-01T00:00:00.000Z"): Response {
  return jsonRes(200, { subscriber: { id, email_address: email, state, created_at: createdAt } });
}

describe("buildDuplicateWindowEntry — pura (#6705)", () => {
  const NOW_MS = new Date("2026-08-30T12:00:00.000Z").getTime();

  it("calcula hours_since_last_brevo_send arredondado a 1 casa", () => {
    const entry = buildDuplicateWindowEntry({
      email: "a@b.com",
      kitSubscriberCreatedAt: "2026-08-20T00:00:00.000Z",
      lastBrevoSendAt: "2026-08-30T00:00:00.000Z", // 12h antes de NOW_MS
      brevoSendsCount: 3,
      nowMs: NOW_MS,
    });
    assert.equal(entry.hours_since_last_brevo_send, 12);
    assert.equal(entry.detected_at, "2026-08-30T12:00:00.000Z");
    assert.equal(entry.kit_subscriber_created_at, "2026-08-20T00:00:00.000Z");
    assert.equal(entry.last_brevo_send_at, "2026-08-30T00:00:00.000Z");
    assert.equal(entry.brevo_sends_count, 3);
    assert.equal(entry.email, "a@b.com");
  });

  it("lastBrevoSendAt null → hours_since_last_brevo_send null (contato nunca recebeu envio Brevo)", () => {
    const entry = buildDuplicateWindowEntry({
      email: "nunca-enviado@b.com",
      kitSubscriberCreatedAt: "2026-08-20T00:00:00.000Z",
      lastBrevoSendAt: null,
      brevoSendsCount: 0,
      nowMs: NOW_MS,
    });
    assert.equal(entry.hours_since_last_brevo_send, null);
    assert.equal(entry.last_brevo_send_at, null);
  });

  it("lastBrevoSendAt não-parseável → hours_since_last_brevo_send null (fail-safe, nunca NaN)", () => {
    const entry = buildDuplicateWindowEntry({
      email: "malformado@b.com",
      kitSubscriberCreatedAt: null,
      lastBrevoSendAt: "não-é-uma-data",
      brevoSendsCount: 1,
      nowMs: NOW_MS,
    });
    assert.equal(entry.hours_since_last_brevo_send, null);
    assert.equal(Number.isNaN(entry.hours_since_last_brevo_send as unknown as number), false);
  });

  it("kitSubscriberCreatedAt null é preservado (Kit indisponível/não confirmado)", () => {
    const entry = buildDuplicateWindowEntry({
      email: "sem-kit@b.com",
      kitSubscriberCreatedAt: null,
      lastBrevoSendAt: null,
      brevoSendsCount: 0,
      nowMs: NOW_MS,
    });
    assert.equal(entry.kit_subscriber_created_at, null);
  });
});

describe("runEvaluation — instrumentação da janela de duplicidade (#6705)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("push:true + contato kit: ATIVO → appendDuplicateWindowLog chamado 1x com os dados corretos (email, sends/last-send da Brevo, created_at do Kit)", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.kit.com")) return kitSubscriberRes(123, "active", "kit-ativo@b.com", "2026-08-15T00:00:00.000Z");
      if (init?.method === "PUT") return jsonRes(200, {});
      if (u.includes("/contacts/")) {
        return jsonRes(200, {
          emailBlacklisted: false,
          statistics: {
            messagesSent: [{ campaignId: 1, date: "2026-08-29T10:00:00.000Z" }, { campaignId: 2, date: "2026-08-29T18:00:00.000Z" }],
            opened: [],
          },
        });
      }
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    const entries: BrevoKitDuplicateWindowEntry[] = [];
    try {
      const contacts = [contact("kit-ativo@b.com", { beehiiv_subscription_id: "kit:123" })];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
        kitApiKey: "kkey",
        appendDuplicateWindowLog: (entry) => entries.push(entry),
      });
      assert.equal(result.selfConfirmed, 1);
      assert.equal(entries.length, 1, "exatamente 1 entrada — nunca 0, nunca duplicada");
      const [entry] = entries;
      assert.equal(entry.email, "kit-ativo@b.com");
      assert.equal(entry.kit_subscriber_created_at, "2026-08-15T00:00:00.000Z");
      assert.equal(entry.last_brevo_send_at, "2026-08-29T18:00:00.000Z", "o envio mais recente dos 2 messagesSent");
      assert.equal(entry.brevo_sends_count, 2);
      assert.equal(typeof entry.detected_at, "string");
      assert.ok(entry.hours_since_last_brevo_send !== null && entry.hours_since_last_brevo_send >= 0);
    } finally {
      restore();
    }
  });

  it("push:false (dry-run) + contato kit: ATIVO → appendDuplicateWindowLog NUNCA chamado (mesma disciplina dos outros efeitos colaterais de push)", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.kit.com")) return kitSubscriberRes(456, "active", "kit-dry@b.com");
      if (u.includes("/contacts/")) return jsonRes(200, { emailBlacklisted: false, statistics: { messagesSent: [], opened: [] } });
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    const entries: BrevoKitDuplicateWindowEntry[] = [];
    try {
      const contacts = [contact("kit-dry@b.com", { beehiiv_subscription_id: "kit:456" })];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
        kitApiKey: "kkey",
        appendDuplicateWindowLog: (entry) => entries.push(entry),
      });
      assert.equal(result.selfConfirmed, 1, "auto-confirmação ainda é contada em dry-run — só o efeito colateral não roda");
      assert.equal(entries.length, 0);
    } finally {
      restore();
    }
  });

  it("contato kit: INACTIVE (ainda não confirmou) → appendDuplicateWindowLog NUNCA chamado", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.kit.com")) return kitSubscriberRes(789, "inactive", "kit-pendente@b.com");
      if (u.includes("/contacts/")) return jsonRes(200, { emailBlacklisted: false, statistics: { messagesSent: [], opened: [] } });
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    const entries: BrevoKitDuplicateWindowEntry[] = [];
    try {
      const contacts = [contact("kit-pendente@b.com", { beehiiv_subscription_id: "kit:789" })];
      await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
        kitApiKey: "kkey",
        appendDuplicateWindowLog: (entry) => entries.push(entry),
      });
      assert.equal(entries.length, 0);
    } finally {
      restore();
    }
  });

  it("appendDuplicateWindowLog OMITIDO (default da suíte de testes pré-#6705) → runEvaluation não lança, promoção segue normal", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.kit.com")) return kitSubscriberRes(999, "active", "kit-sem-callback@b.com");
      if (init?.method === "PUT") return jsonRes(200, {});
      if (u.includes("/contacts/")) return jsonRes(200, { emailBlacklisted: false, statistics: { messagesSent: [], opened: [] } });
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("kit-sem-callback@b.com", { beehiiv_subscription_id: "kit:999" })];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
        kitApiKey: "kkey",
        // appendDuplicateWindowLog OMITIDO de propósito
      });
      assert.equal(result.selfConfirmed, 1);
      assert.equal(result.failed, 0);
    } finally {
      restore();
    }
  });

  it("self-review: appendDuplicateWindowLog LANÇA (ex: disco cheio) → não bloqueia a promoção real (unlink/applySelfConfirmed seguem rodando, failed não incrementa)", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.kit.com")) return kitSubscriberRes(111, "active", "kit-log-falha@b.com");
      if (init?.method === "PUT") return jsonRes(200, {});
      if (u.includes("/contacts/")) return jsonRes(200, { emailBlacklisted: false, statistics: { messagesSent: [], opened: [] } });
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    const logMessages: string[] = [];
    try {
      const contacts = [contact("kit-log-falha@b.com", { beehiiv_subscription_id: "kit:111" })];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: (msg) => logMessages.push(msg),
        kitApiKey: "kkey",
        appendDuplicateWindowLog: () => {
          throw new Error("ENOSPC simulado — disco cheio");
        },
      });
      // A promoção real (self-confirmed) precisa ter acontecido de qualquer jeito —
      // uma falha na MEDIÇÃO nunca pode impedir o efeito que ela só observa.
      assert.equal(result.selfConfirmed, 1);
      assert.equal(result.failed, 0, "falha da instrumentação nunca conta como falha de negócio");
      assert.ok(
        logMessages.some((m) => m.includes("#6705") && m.includes("ENOSPC simulado")),
        "o erro deve aparecer no log, não desaparecer em silêncio",
      );
    } finally {
      restore();
    }
  });
});
