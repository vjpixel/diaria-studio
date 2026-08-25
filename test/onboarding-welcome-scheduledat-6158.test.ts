/**
 * test/onboarding-welcome-scheduledat-6158.test.ts (#6158)
 *
 * Regressão do incidente #6042: `sendTransactionalEmail` mandava
 * `POST /v3/smtp/email` SEM `scheduledAt` — envio imediato recebe um
 * messageId formato SMTP (`...@smtp-relay.mailin.fr`), que o endpoint
 * `DELETE /v3/smtp/email/{id}` NUNCA aceita (585 e-mails indevidos,
 * impossíveis de cancelar). Fix: sempre `scheduledAt` mínimo (60s à
 * frente) — a Brevo só devolve um id formato UUIDv4 (cancelável) quando o
 * envio é agendado, não imediato.
 *
 * Cobre (unitário, `fetch` mockado — NUNCA toca a API real, ver guard de
 * publicação em context/overnight-dispatch-rules.md item 1):
 *
 *   1. `computeMinScheduledAt` — ISO válido, >= `TRANSACTIONAL_SCHEDULE_LEAD_MS`
 *      à frente do instante passado.
 *   2. `sendTransactionalEmail` — o payload do POST inclui `scheduledAt`
 *      (nunca ausente); retorna `messageId` quando presente, `batchId`
 *      como fallback quando a Brevo só devolve esse campo (agendamento em
 *      lote), `null` quando nenhum dos dois vem no corpo.
 *   3. `applySendResult` — persiste `email1_brevo_id`/`email2_brevo_id` na
 *      entry certa a partir do id retornado (é isto que fecha o item 2 da
 *      issue: "persistir o messageId/batchId no store").
 *   4. `runCancelPending` — lê o store, cancela via DELETE cada id
 *      pendente, limpa o campo em caso de sucesso, preserva em caso de
 *      falha (retry na próxima invocação) — e persiste o resultado de
 *      volta no arquivo (não só na memória).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  computeMinScheduledAt,
  TRANSACTIONAL_SCHEDULE_LEAD_MS,
  sendTransactionalEmail,
  applySendResult,
  runCancelPending,
} from "../scripts/onboarding-welcome-run.ts";
import { writeStore, type OnboardingEntry, type OnboardingStore } from "../scripts/lib/onboarding-store.ts";

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: { cancel: async () => {} },
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
  } as unknown as Response;
}

let origFetch: typeof fetch;
beforeEach(() => {
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

// ─── computeMinScheduledAt ───────────────────────────────────────────────

describe("computeMinScheduledAt (#6158)", () => {
  it("retorna ISO válido, TRANSACTIONAL_SCHEDULE_LEAD_MS à frente do instante passado", () => {
    const now = Date.parse("2026-08-25T12:00:00.000Z");
    const out = computeMinScheduledAt(now);
    assert.equal(Date.parse(out), now + TRANSACTIONAL_SCHEDULE_LEAD_MS);
    assert.equal(TRANSACTIONAL_SCHEDULE_LEAD_MS >= 60_000, true, "lead mínimo pedido pela issue é 60s");
  });
});

// ─── sendTransactionalEmail ──────────────────────────────────────────────

describe("sendTransactionalEmail (#6158) — payload sempre com scheduledAt", () => {
  it("REGRESSÃO #6042: o body do POST /smtp/email inclui scheduledAt (nunca envio imediato)", async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(String(url), "https://api.brevo.com/v3/smtp/email");
      return jsonRes(201, { messageId: "11111111-1111-4111-8111-111111111111" });
    }) as typeof fetch;

    await sendTransactionalEmail({
      apiKey: "test-key",
      sender: { email: "oi@example.com", name: "diar.ia.br" },
      to: "leitor@example.com",
      subject: "Bem-vindo",
      htmlContent: "<p>oi</p>",
    });

    assert.ok(capturedBody, "POST deveria ter sido chamado");
    assert.ok(typeof capturedBody.scheduledAt === "string", "scheduledAt ausente do payload — regressão #6042");
    const scheduledMs = Date.parse(capturedBody.scheduledAt);
    assert.ok(!Number.isNaN(scheduledMs), `scheduledAt não é uma data ISO válida: ${capturedBody.scheduledAt}`);
    assert.ok(
      scheduledMs >= Date.now() + 55_000,
      `scheduledAt deveria estar pelo menos ~60s no futuro — obteve ${capturedBody.scheduledAt}`,
    );
  });

  it("retorna messageId quando presente na resposta", async () => {
    globalThis.fetch = (async () =>
      jsonRes(201, { messageId: "22222222-2222-4222-8222-222222222222" })) as typeof fetch;
    const id = await sendTransactionalEmail({
      apiKey: "k",
      sender: { email: "a@b.com", name: "n" },
      to: "x@y.com",
      subject: "s",
      htmlContent: "<p>c</p>",
    });
    assert.equal(id, "22222222-2222-4222-8222-222222222222");
  });

  it("cai pra batchId quando messageId ausente (envio agendado em lote)", async () => {
    globalThis.fetch = (async () =>
      jsonRes(201, { batchId: "33333333-3333-4333-8333-333333333333" })) as typeof fetch;
    const id = await sendTransactionalEmail({
      apiKey: "k",
      sender: { email: "a@b.com", name: "n" },
      to: "x@y.com",
      subject: "s",
      htmlContent: "<p>c</p>",
    });
    assert.equal(id, "33333333-3333-4333-8333-333333333333");
  });

  it("retorna null quando a Brevo não devolve nem messageId nem batchId", async () => {
    globalThis.fetch = (async () => jsonRes(201, {})) as typeof fetch;
    const id = await sendTransactionalEmail({
      apiKey: "k",
      sender: { email: "a@b.com", name: "n" },
      to: "x@y.com",
      subject: "s",
      htmlContent: "<p>c</p>",
    });
    assert.equal(id, null);
  });
});

// ─── applySendResult ─────────────────────────────────────────────────────

function baseEntry(over: Partial<OnboardingEntry> = {}): OnboardingEntry {
  return {
    subscription_id: "sub-1",
    email: "novo@example.com",
    status_detectado: "active",
    created_at: 1_755_000_000,
    detected_at: new Date(1_755_000_000 * 1000).toISOString(),
    email1_sent_at: null,
    email1_brevo_id: null,
    email2_sent_at: null,
    email2_brevo_id: null,
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
    ...over,
  };
}

describe("applySendResult (#6158) — persiste o id no campo certo", () => {
  it("email1: grava email1_sent_at + email1_brevo_id, não toca email2", () => {
    const e = baseEntry();
    applySendResult(e, "email1", "id-1", "2026-08-25T12:00:00.000Z");
    assert.equal(e.email1_sent_at, "2026-08-25T12:00:00.000Z");
    assert.equal(e.email1_brevo_id, "id-1");
    assert.equal(e.email2_sent_at, null);
    assert.equal(e.email2_brevo_id, null);
  });

  it("email2: grava email2_sent_at + email2_brevo_id, não toca email1", () => {
    const e = baseEntry({ email1_sent_at: "2026-08-22T12:00:00.000Z", email1_brevo_id: "id-old" });
    applySendResult(e, "email2", "id-2", "2026-08-25T12:00:00.000Z");
    assert.equal(e.email2_sent_at, "2026-08-25T12:00:00.000Z");
    assert.equal(e.email2_brevo_id, "id-2");
    assert.equal(e.email1_sent_at, "2026-08-22T12:00:00.000Z");
    assert.equal(e.email1_brevo_id, "id-old");
  });

  it("id null (Brevo não devolveu) é persistido como null, não quebra", () => {
    const e = baseEntry();
    applySendResult(e, "email1", null, "2026-08-25T12:00:00.000Z");
    assert.equal(e.email1_sent_at, "2026-08-25T12:00:00.000Z");
    assert.equal(e.email1_brevo_id, null);
  });
});

// ─── runCancelPending ────────────────────────────────────────────────────

function tmpStorePath(): { dir: string; path: string } {
  const dir = mkdtempSync(resolve(tmpdir(), "diaria-onboarding-cancel-6158-"));
  return { dir, path: resolve(dir, "store.json") };
}

function storeWith(entries: Record<string, OnboardingEntry>): OnboardingStore {
  return { version: 1, last_detection_cursor: 123, d10_brevo_list_id: null, entries };
}

describe("runCancelPending (#6158)", () => {
  it("cancela via DELETE cada id pendente e limpa o campo em caso de sucesso", async () => {
    const { dir, path } = tmpStorePath();
    try {
      const store = storeWith({
        "sub-1": baseEntry({ subscription_id: "sub-1", email: "a@x.com", email1_brevo_id: "id-a" }),
        "sub-2": baseEntry({
          subscription_id: "sub-2",
          email: "b@x.com",
          email1_brevo_id: "id-b1",
          email2_brevo_id: "id-b2",
        }),
      });
      writeStore(store, path);

      const deletedPaths: string[] = [];
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        assert.equal(init?.method, "DELETE");
        deletedPaths.push(String(url));
        return jsonRes(204, {});
      }) as typeof fetch;

      const results = await runCancelPending({ apiKey: "test-key", storePath: path });

      assert.equal(results.length, 3);
      assert.ok(results.every((r) => r.ok));
      assert.deepEqual(
        deletedPaths.sort(),
        [
          "https://api.brevo.com/v3/smtp/email/id-a",
          "https://api.brevo.com/v3/smtp/email/id-b1",
          "https://api.brevo.com/v3/smtp/email/id-b2",
        ].sort(),
      );

      const written = JSON.parse(readFileSync(path, "utf8")) as OnboardingStore;
      assert.equal(written.entries["sub-1"].email1_brevo_id, null, "sucesso deveria limpar o id do store");
      assert.equal(written.entries["sub-2"].email1_brevo_id, null);
      assert.equal(written.entries["sub-2"].email2_brevo_id, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha de DELETE preserva o id (retry na próxima invocação) e não derruba o lote", async () => {
    const { dir, path } = tmpStorePath();
    try {
      const store = storeWith({
        "sub-1": baseEntry({ subscription_id: "sub-1", email: "a@x.com", email1_brevo_id: "id-fail" }),
        "sub-2": baseEntry({ subscription_id: "sub-2", email: "b@x.com", email1_brevo_id: "id-ok" }),
      });
      writeStore(store, path);

      globalThis.fetch = (async (url: string | URL) => {
        if (String(url).endsWith("id-fail")) return jsonRes(404, { message: "not found — already sent" });
        return jsonRes(204, {});
      }) as typeof fetch;

      const results = await runCancelPending({ apiKey: "test-key", storePath: path });

      const failed = results.find((r) => r.id === "id-fail");
      const ok = results.find((r) => r.id === "id-ok");
      assert.equal(failed?.ok, false);
      assert.ok(failed?.error, "falha deveria carregar mensagem de erro");
      assert.equal(ok?.ok, true);

      const written = JSON.parse(readFileSync(path, "utf8")) as OnboardingStore;
      assert.equal(written.entries["sub-1"].email1_brevo_id, "id-fail", "falha nunca deveria limpar o id");
      assert.equal(written.entries["sub-2"].email1_brevo_id, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("store sem nenhum id pendente: attempted=0, nenhuma chamada de rede", async () => {
    const { dir, path } = tmpStorePath();
    try {
      writeStore(storeWith({ "sub-1": baseEntry({ subscription_id: "sub-1" }) }), path);
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonRes(204, {});
      }) as typeof fetch;

      const results = await runCancelPending({ apiKey: "test-key", storePath: path });
      assert.equal(results.length, 0);
      assert.equal(calls, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
