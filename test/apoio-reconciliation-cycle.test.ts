/**
 * test/apoio-reconciliation-cycle.test.ts (self-review consolidado do PR #4503)
 *
 * Testa `runApoioReconciliationCycle` (`scripts/lib/apoio-reconciliation-cycle.ts`)
 * — a orquestração extraída do bloco de ~40 linhas antes DUPLICADO entre
 * `scripts/sync-apoio-nivel-beehiiv.ts::main()` e
 * `scripts/apoios-diff-alarm.ts::main()`. Cobre os 2 achados críticos do
 * fleet review pré-merge:
 *
 *   (a) achado crítico 1 (code-reviewer + comment-analyzer, convergência
 *       independente): notificação de PAGAMENTO CONFIRMADO ("novo apoio")
 *       vira contato mesmo no caminho automatizado — antes, só `.promessas`
 *       era processado, nunca `.notifications`, e o cursor único do drain
 *       avançava por cima delas de qualquer jeito.
 *   (b) achado crítico 2 (silent-failure-hunter): `ApoiaSeAuthError` propaga
 *       pra `authError` (nunca misturada com `warning` genérico) em vez de
 *       manter toda promessa pendente em silêncio; mutações já aplicadas
 *       ANTES do auth error (ex: notificação confirmada) não são perdidas.
 *   (c) erro transiente (rede/API não-auth) durante a reconciliação de uma
 *       promessa loga um aviso e mantém a promessa pendente — mesmo
 *       comportamento de antes do #4503, agora com log (antes: `catch {}`
 *       vazio, nem log nem sinal).
 *
 * Nenhum teste bate rede real — `drainImpl`/`fetchImpl` são sempre
 * injetados. `rootDir` é sempre um tmpdir real (`mkdtempSync`) quando o
 * ciclo pode escrever `contacts.jsonl`/`pending-promises.jsonl` — `saveContacts`/
 * `savePendingPromises` fazem I/O de verdade (mesmo padrão de
 * `test/studio-apoios.test.ts`).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApoioReconciliationCycle } from "../scripts/lib/apoio-reconciliation-cycle.ts";
import { contactsFilePath } from "../scripts/studio-ui/studio-apoios.ts";
import { pendingPromisesPath, type PendingPromise } from "../scripts/lib/apoio-promise-store.ts";
import { RateLimiter } from "../scripts/lib/apoia-se.ts";
import type { DrainApoiaSeResult } from "../scripts/lib/apoia-se-gmail-drain.ts";

const TEST_APOIA_ENV = { apiKey: "test-key", apiSecret: "test-secret", campaign: "diaria" };
// Limiter "rápido" — evita o throttle real de 200ms/chamada do singleton
// default do módulo apoia-se (mesmo padrão de outros testes do domínio).
const fastLimiter = new RateLimiter({ maxPerSecond: 1000 });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function emptyDrain(): DrainApoiaSeResult {
  return { notifications: [], most_recent_iso: null, skipped: false };
}

function pendingPromise(overrides: Partial<PendingPromise> = {}): PendingPromise {
  return {
    name: "Fabiana",
    email: "fabiana@example.com",
    value: 50,
    receivedAtIso: "2026-08-02T21:45:00.000Z",
    ...overrides,
  };
}

describe("runApoioReconciliationCycle (self-review consolidado do PR #4503)", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "apoio-reconciliation-cycle-"));
  });
  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  // ── achado crítico 1 ────────────────────────────────────────────────────

  it("achado crítico 1: notificação de pagamento CONFIRMADO vira contato novo no ciclo automatizado", async () => {
    const drainImpl = async (): Promise<DrainApoiaSeResult> => ({
      notifications: [{ name: "Almir", email: "almir@example.com", value: 25 }],
      most_recent_iso: "2026-08-02T21:00:00Z",
      skipped: false,
    });

    const result = await runApoioReconciliationCycle(rootDir, {
      contacts: [],
      env: TEST_APOIA_ENV,
      drainImpl,
    });

    assert.equal(result.notificationsImported, 1);
    assert.equal(result.authError, null);
    assert.equal(result.warning, null);
    assert.equal(result.contacts.length, 1);
    assert.equal(result.contacts[0].emails[0], "almir@example.com");
    assert.match(result.contacts[0].notes, /apoia\.se/);

    // Persistido de verdade em contacts.jsonl — não só em memória (a causa
    // raiz do #4490: o cursor do drain avança independente do que o caller
    // faz, então a persistência real é o que impede a perda permanente).
    const persisted = JSON.parse(readFileSync(contactsFilePath(rootDir), "utf-8").trim());
    assert.equal(persisted.emails[0], "almir@example.com");
  });

  it("notificação confirmada não duplica contato já existente (dedup por e-mail)", async () => {
    const drainImpl = async (): Promise<DrainApoiaSeResult> => ({
      notifications: [{ name: "Almir", email: "almir@example.com", value: 25 }],
      most_recent_iso: "2026-08-02T21:00:00Z",
      skipped: false,
    });
    const existing = {
      id: "c1",
      name: "Almir Original",
      emails: ["almir@example.com"],
      notes: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const result = await runApoioReconciliationCycle(rootDir, {
      contacts: [existing],
      env: TEST_APOIA_ENV,
      drainImpl,
    });

    assert.equal(result.notificationsImported, 0);
    assert.equal(result.contacts.length, 1);
    assert.equal(result.contacts[0].name, "Almir Original");
  });

  it("dedup-ordering: promessa CONFIRMADA cujo e-mail já foi importado como notificação na mesma leva não duplica contato (mesma ordem de refreshApoiosData)", async () => {
    const drainImpl = async (): Promise<DrainApoiaSeResult> => ({
      notifications: [{ name: "Almir", email: "almir@example.com", value: 25 }],
      promessas: [{ name: "Almir", email: "almir@example.com", value: 25, receivedAtIso: "2026-08-02T21:05:00Z" }],
      most_recent_iso: "2026-08-02T21:05:00Z",
      skipped: false,
    });
    // A promessa TAMBÉM confirma pagamento nesta rodada — exercita o caminho
    // real de dedup: `reconcilePendingPromises` tenta promover via
    // `importNewApoiadoresFromGmail`, que já acha o contato recém-criado
    // pela notificação (processada ANTES, achado crítico 1) e não duplica.
    const fetchImpl = (async () =>
      jsonResponse(200, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 })) as unknown as typeof fetch;

    const result = await runApoioReconciliationCycle(rootDir, {
      contacts: [],
      env: TEST_APOIA_ENV,
      drainImpl,
      checkOpts: { fetchImpl, limiter: fastLimiter, cacheDir: rootDir, now: new Date("2026-08-02T22:00:00Z") },
    });

    assert.equal(result.notificationsImported, 1);
    assert.equal(result.promoted.length, 1, "a promessa ainda conta como confirmada/promovida");
    assert.equal(result.remainingPending.length, 0);
    assert.equal(result.contacts.length, 1, "não deve duplicar — a promessa do mesmo e-mail já achou o contato recém-criado");
  });

  // ── achado crítico 2 ────────────────────────────────────────────────────

  it("achado crítico 2: ApoiaSeAuthError propaga pra `authError` (nunca misturada com `warning`), sem perder notificação já importada", async () => {
    const drainImpl = async (): Promise<DrainApoiaSeResult> => ({
      notifications: [{ name: "Almir", email: "almir@example.com", value: 25 }],
      promessas: [{ ...pendingPromise(), receivedAtIso: "2026-08-02T21:45:00Z" }],
      most_recent_iso: "2026-08-02T21:45:00Z",
      skipped: false,
    });
    const fetchImpl = (async () =>
      jsonResponse(401, { message: "chave inválida" })) as unknown as typeof fetch;

    const result = await runApoioReconciliationCycle(rootDir, {
      contacts: [],
      env: TEST_APOIA_ENV,
      drainImpl,
      checkOpts: { fetchImpl, limiter: fastLimiter, cacheDir: rootDir, now: new Date("2026-08-02T22:00:00Z") },
    });

    assert.match(result.authError ?? "", /401|chave inválida|apoia\.se/i);
    assert.equal(result.warning, null, "authError nunca deve se misturar com o warning genérico");

    // A notificação CONFIRMADA já tinha sido importada ANTES do auth error
    // (que só acontece no passo seguinte, reconciliação de promessas) —
    // nunca deve ser descartada.
    assert.equal(result.notificationsImported, 1);
    assert.equal(result.contacts.length, 1);
    assert.equal(result.contacts[0].emails[0], "almir@example.com");
    const persistedContacts = JSON.parse(readFileSync(contactsFilePath(rootDir), "utf-8").trim());
    assert.equal(persistedContacts.emails[0], "almir@example.com", "persistido em disco mesmo com auth error no passo seguinte");

    // A promessa recém-drenada (cursor do Gmail já avançou) não pode ficar
    // perdida — mesma classe do achado crítico 1: precisa continuar no
    // store de pendentes, mesmo que a reconciliação em si tenha abortado.
    assert.equal(result.remainingPending.length, 1);
    assert.equal(result.remainingPending[0].email, "fabiana@example.com");
    const persistedPending = readFileSync(pendingPromisesPath(rootDir, "diaria"), "utf-8").trim();
    assert.match(persistedPending, /fabiana@example\.com/);
  });

  it("env apoia.se ausente é fail-soft (warning, nunca authError) e não lança", async () => {
    // `env` não injetado E sem as 3 env vars no processo de teste —
    // `readApoiaSeEnv()` (chamada internamente) deve lançar um Error
    // genérico de env ausente (não `ApoiaSeAuthError`, que só vem de um 401
    // HTTP real). Salva/restaura só as 3 chaves (mesmo escopo mínimo de
    // `test/apoia-se.test.ts`), nunca o objeto `process.env` inteiro.
    const KEYS = ["APOIA_SE_API_KEY", "APOIA_SE_API_SECRET", "APOIA_SE_CAMPAIGN"] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const result = await runApoioReconciliationCycle(rootDir, { contacts: [] });
      assert.equal(result.authError, null);
      assert.ok(result.warning, "env ausente deve produzir um warning genérico, fail-soft");
      assert.equal(result.notificationsImported, 0);
      assert.deepEqual(result.contacts, []);
      // Sem `promisesPath` resolvido, nenhuma escrita deve ter sido tentada.
      assert.equal(existsSync(contactsFilePath(rootDir)), false);
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  // ── (c) erro transiente ──────────────────────────────────────────────────

  it("erro transiente (rede/API não-auth) durante a reconciliação loga um aviso e mantém a promessa pendente", async () => {
    const drainImpl = async (): Promise<DrainApoiaSeResult> => emptyDrain();
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const origWrite = process.stderr.write.bind(process.stderr);
    let stderrOutput = "";
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    };

    let result;
    try {
      result = await runApoioReconciliationCycle(rootDir, {
        contacts: [],
        env: TEST_APOIA_ENV,
        drainImpl,
        pendingPromises: [pendingPromise()],
        checkOpts: { fetchImpl, limiter: fastLimiter, cacheDir: rootDir, now: new Date("2026-08-02T22:00:00Z") },
      });
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(result.authError, null);
    assert.equal(result.warning, null, "erro transiente de UMA promessa não deve virar o warning genérico do ciclo inteiro");
    assert.equal(result.remainingPending.length, 1);
    assert.equal(result.remainingPending[0].email, "fabiana@example.com");
    assert.ok(stderrOutput.includes("aviso"), `esperava um log de aviso — stderr: ${stderrOutput}`);
    assert.ok(
      stderrOutput.includes("fabiana@example.com"),
      `esperava o e-mail da promessa no log de aviso — stderr: ${stderrOutput}`,
    );

    // Mantida no store persistido (mesmo comportamento de antes do #4503,
    // agora com o log acima).
    const persistedPending = readFileSync(pendingPromisesPath(rootDir, "diaria"), "utf-8").trim();
    assert.match(persistedPending, /fabiana@example\.com/);
  });

  it("drain pulado (Gmail indisponível) é fail-soft — reconciliação segue só com o store existente", async () => {
    const drainImpl = async (): Promise<DrainApoiaSeResult> => ({
      notifications: [],
      most_recent_iso: null,
      skipped: true,
      reason: "auth_expired",
    });

    const result = await runApoioReconciliationCycle(rootDir, {
      contacts: [],
      env: TEST_APOIA_ENV,
      drainImpl,
      pendingPromises: [],
    });

    assert.equal(result.drainSkipped, true);
    assert.equal(result.drainSkipReason, "auth_expired");
    assert.equal(result.authError, null);
    assert.equal(result.warning, null);
  });
});
