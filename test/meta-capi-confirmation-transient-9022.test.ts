/**
 * Regressão #9022: com a task horária (#8983), 3 tentativas = ~3h. 5xx/429 da
 * Meta (instabilidade/throttling) NÃO podem consumir tentativa — senão uma queda
 * de 3h marca o candidato como `skipped-failed-permanent` para sempre.
 * 4xx permanente continua consumindo e desiste na 3ª.
 * Nenhum teste toca a Meta: `fetchImpl` é mock; índice em dir temporário.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  META_CONFIRMATION_MAX_FAILED_ATTEMPTS,
  isTransientMetaStatus,
  loadMetaConfirmationIndex,
  runMetaConfirmationBatch,
  type RunMetaConfirmationBatchDeps,
} from "../scripts/lib/meta-capi-confirmation-batch.ts";
import type { ConfirmationRosterEntry } from "../scripts/lib/google-ads-confirmation-batch.ts";
import type { SubscriberStateRecord } from "../scripts/lib/subscriber-state-snapshot.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.now());
const BASE_DATE_MS = NOW.getTime() - 2 * DAY_MS;
const BASE_DATE = new Date(BASE_DATE_MS).toISOString().slice(0, 10);
const CREATED_AT = new Date(BASE_DATE_MS).toISOString();

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "meta-confirm-9022-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const sub = (id: number): ConfirmationRosterEntry => ({
  id,
  email_address: `leitor${id}@example.com`,
  state: "active",
  created_at: CREATED_AT,
});
const base = (id: number): SubscriberStateRecord => ({ id, state: "inactive", created_at: CREATED_AT });

/** fetch mock que responde a sequência de status dada (repete o último). */
function seqFetch(statuses: number[]): { fetchImpl: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchImpl = (async () => {
    const status = statuses[Math.min(n, statuses.length - 1)];
    n++;
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => n };
}

function deps(dir: string, fetchImpl: typeof fetch, now: Date = NOW): RunMetaConfirmationBatchDeps {
  return {
    roster: [sub(1)],
    baseSnapshot: [base(1)],
    baseDate: BASE_DATE,
    indexPath: join(dir, "idx.json"),
    dryRun: false,
    accessToken: "tok",
    now,
    fetchImpl,
    log: () => {},
  };
}

describe("#9022 — isTransientMetaStatus", () => {
  it("5xx e 429 são transitórios; 4xx (fora 429) não", () => {
    for (const s of [429, 500, 502, 503, 504, 599]) assert.equal(isTransientMetaStatus(s), true, String(s));
    for (const s of [400, 401, 403, 404, 408, 422, 499, 600]) assert.equal(isTransientMetaStatus(s), false, String(s));
  });
});

describe("#9022 — 5xx/429 não consomem tentativa", () => {
  for (const status of [500, 503, 429]) {
    it(`${status} por mais de MAX_FAILED_ATTEMPTS rodadas seguidas NÃO vira skipped-failed-permanent`, () =>
      withTmp(async (dir) => {
        const { fetchImpl, calls } = seqFetch([status]);
        const d = deps(dir, fetchImpl);
        const runs = META_CONFIRMATION_MAX_FAILED_ATTEMPTS + 3;
        for (let i = 0; i < runs; i++) {
          const r = await runMetaConfirmationBatch(d);
          assert.equal(r.failed, 1);
          assert.equal(r.transientFailed, 1);
          assert.equal(r.failedPermanent, 0, `rodada ${i + 1}`);
        }
        assert.equal(calls(), runs, "reenviou em toda rodada");
        const e = loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"];
        assert.equal(e.status, "failed");
        assert.equal(e.attempts ?? 0, 0, "tentativa não consumida");
      }));
  }

  it("instabilidade de horas seguida de recuperação: envia com sucesso", () =>
    withTmp(async (dir) => {
      const { fetchImpl } = seqFetch([503, 503, 429, 500, 200]);
      const d = deps(dir, fetchImpl);
      for (let i = 0; i < 4; i++) await runMetaConfirmationBatch(d);
      const r = await runMetaConfirmationBatch(d);
      assert.equal(r.sent, 1);
      assert.equal(loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"].status, "sent");
    }));

  it("transitório preserva as tentativas já consumidas por 4xx (não zera, não incrementa)", () =>
    withTmp(async (dir) => {
      const { fetchImpl } = seqFetch([400, 503, 503, 400, 400]);
      const d = deps(dir, fetchImpl);
      await runMetaConfirmationBatch(d); // 400 -> attempts 1
      await runMetaConfirmationBatch(d); // 503 -> attempts 1
      await runMetaConfirmationBatch(d); // 503 -> attempts 1
      assert.equal(loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"].attempts, 1);
      await runMetaConfirmationBatch(d); // 400 -> attempts 2
      const r = await runMetaConfirmationBatch(d); // 400 -> attempts 3 -> permanente
      assert.equal(r.failedPermanent, 1);
      const e = loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"];
      assert.equal(e.status, "skipped-failed-permanent");
      assert.equal(e.attempts, 3);
    }));

  it("teto do transitório é a janela da CAPI: fora dela vira skipped-out-of-window, sem reenvio", () =>
    withTmp(async (dir) => {
      const { fetchImpl, calls } = seqFetch([503]);
      await runMetaConfirmationBatch(deps(dir, fetchImpl));
      assert.equal(calls(), 1);
      const later = new Date(NOW.getTime() + 10 * DAY_MS);
      const r = await runMetaConfirmationBatch(deps(dir, fetchImpl, later));
      assert.equal(calls(), 1, "não reenviou fora da janela");
      assert.equal(r.outOfWindow, 1);
      assert.equal(loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"].status, "skipped-out-of-window");
    }));
});

describe("#9022 — 4xx permanente preserva o comportamento", () => {
  for (const status of [400, 403]) {
    it(`${status} consome tentativa e desiste na ${META_CONFIRMATION_MAX_FAILED_ATTEMPTS}ª`, () =>
      withTmp(async (dir) => {
        const { fetchImpl, calls } = seqFetch([status]);
        const d = deps(dir, fetchImpl);
        for (let i = 0; i < META_CONFIRMATION_MAX_FAILED_ATTEMPTS; i++) {
          const r = await runMetaConfirmationBatch(d);
          assert.equal(r.transientFailed, 0);
        }
        const e = loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"];
        assert.equal(e.status, "skipped-failed-permanent");
        await runMetaConfirmationBatch(d);
        assert.equal(calls(), META_CONFIRMATION_MAX_FAILED_ATTEMPTS, "não reenvia após permanente");
      }));
  }
});
