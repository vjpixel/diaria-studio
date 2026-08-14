/**
 * test/push-clarice-hour-test-kv.test.ts (#5189)
 *
 * Cobre `pushClariceHourTestState` (scripts/push-clarice-hour-test-kv.ts) em
 * `--dry-run` — o único modo testável sem tocar rede/credenciais Cloudflare
 * reais (mesmo racional de `discoverCyclesWithPrioritized`, testado sem
 * exercitar `uploadTextToWorkerKV`, ver test/brevo-dashboard-link-section-4184.test.ts).
 *
 * Verifica que a função:
 *   (a) lê o estado LOCAL (`data/clarice-hour-test.json`) via
 *       `readClariceHourTestState` — nunca lança mesmo com root vazio (estado
 *       ausente = inativo, comportamento fail-soft já coberto em
 *       test/clarice-hour-test-5140.test.ts).
 *   (b) em `--dry-run`, NUNCA chama `uploadTextToWorkerKV` (nenhuma rede) —
 *       verificado indiretamente: roda sem CLOUDFLARE_ACCOUNT_ID/
 *       CLOUDFLARE_WORKERS_TOKEN no env e sem lançar (uploadTextToWorkerKV
 *       lançaria "credenciais ausentes" se fosse chamado de verdade).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pushClariceHourTestState } from "../scripts/push-clarice-hour-test-kv.ts";
import { startClariceHourTest } from "../scripts/lib/clarice-hour-test.ts";

function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "push-hour-test-kv-"));
  mkdirSync(join(root, "data"), { recursive: true });
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("pushClariceHourTestState — --dry-run (#5189)", () => {
  it("estado ausente (inativo) → dry-run não lança, nenhuma credencial necessária", async () => {
    await withRoot(async (root) => {
      // Sem CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN — se o dry-run
      // tentasse chamar uploadTextToWorkerKV de verdade, lançaria aqui.
      const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
      const savedToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      delete process.env.CLOUDFLARE_WORKERS_TOKEN;
      try {
        await assert.doesNotReject(() => pushClariceHourTestState(root, true));
      } finally {
        if (savedAccount !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
        if (savedToken !== undefined) process.env.CLOUDFLARE_WORKERS_TOKEN = savedToken;
      }
    });
  });

  it("estado ativo → dry-run computa a projeção sem lançar (sem credenciais)", async () => {
    await withRoot(async (root) => {
      startClariceHourTest(root, { hoursBrt: [6, 10], now: () => new Date("2026-08-01T00:00:00Z") });
      const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
      const savedToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      delete process.env.CLOUDFLARE_WORKERS_TOKEN;
      try {
        await assert.doesNotReject(() => pushClariceHourTestState(root, true));
      } finally {
        if (savedAccount !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
        if (savedToken !== undefined) process.env.CLOUDFLARE_WORKERS_TOKEN = savedToken;
      }
    });
  });
});
