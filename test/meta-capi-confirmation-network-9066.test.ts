/**
 * Regressão #9066: `network_error` no lote de confirmação Meta não gravava nada
 * no índice. Se o snapshot base avançasse antes do próximo sucesso (o assinante
 * passa a constar `active` na base e deixa de ser "confirmação nova"), o
 * candidato saía de `selectConfirmationCandidates` E do loop de retry (que só
 * reconsidera entradas `failed` do índice) — sumia sem registro.
 * Agora rede grava `failed` sem consumir tentativa, como 5xx/429 (#9022).
 * Nenhum teste toca a Meta: `sendFn` é mock; índice em dir temporário.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  META_CONFIRMATION_MAX_FAILED_ATTEMPTS,
  loadMetaConfirmationIndex,
  runMetaConfirmationBatch,
  type RunMetaConfirmationBatchDeps,
} from "../scripts/lib/meta-capi-confirmation-batch.ts";
import type { ConfirmationRosterEntry } from "../scripts/lib/google-ads-confirmation-batch.ts";
import type { SubscriberStateRecord } from "../scripts/lib/subscriber-state-snapshot.ts";
import type { MetaCapiSendResult } from "../scripts/lib/shared/meta-capi.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.now());
const BASE_DATE_MS = NOW.getTime() - 2 * DAY_MS;
const BASE_DATE = new Date(BASE_DATE_MS).toISOString().slice(0, 10);
const NEXT_BASE_DATE = new Date(NOW.getTime() - DAY_MS).toISOString().slice(0, 10);
const CREATED_AT = new Date(BASE_DATE_MS).toISOString();

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "meta-confirm-9066-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const sub = (id: number): ConfirmationRosterEntry => ({
  id,
  email_address: `leitor${id}@example.com`,
  state: "active",
  created_at: CREATED_AT,
});
const base = (id: number, state: string): SubscriberStateRecord => ({ id, state, created_at: CREATED_AT });

/** sendFn mock: `network_error` nas primeiras `failures` chamadas, depois ok. */
function flakySend(failures: number): { sendFn: NonNullable<RunMetaConfirmationBatchDeps["sendFn"]>; calls: () => number } {
  let n = 0;
  const sendFn = async (): Promise<MetaCapiSendResult> => {
    n++;
    return n <= failures ? { ok: false, status: 502, reason: "network_error" } : { ok: true, status: 200 };
  };
  return { sendFn, calls: () => n };
}

function deps(dir: string, over: Partial<RunMetaConfirmationBatchDeps>): RunMetaConfirmationBatchDeps {
  return {
    roster: [sub(1)],
    baseSnapshot: [base(1, "inactive")],
    baseDate: BASE_DATE,
    indexPath: join(dir, "idx.json"),
    dryRun: false,
    accessToken: "tok",
    now: NOW,
    log: () => {},
    ...over,
  };
}

describe("#9066 — network_error não deixa o candidato sair da fila sem registro", () => {
  it("snapshot base avança após falha de rede: próxima rodada ainda reenvia e marca sent", () =>
    withTmp(async (dir) => {
      const { sendFn, calls } = flakySend(1);
      const r1 = await runMetaConfirmationBatch(deps(dir, { sendFn }));
      assert.equal(r1.failed, 1);
      assert.equal(r1.transientFailed, 1);
      assert.equal(loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"].status, "failed");

      // Base nova já registra o assinante como `active`: deixou de ser confirmação nova.
      const r2 = await runMetaConfirmationBatch(
        deps(dir, { sendFn, baseSnapshot: [base(1, "active")], baseDate: NEXT_BASE_DATE }),
      );
      assert.equal(calls(), 2, "reenviou via pool de retry do índice");
      assert.equal(r2.sent, 1);
      assert.equal(loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"].status, "sent");
    }));

  it("rede caindo por mais de MAX_FAILED_ATTEMPTS rodadas NÃO vira skipped-failed-permanent", () =>
    withTmp(async (dir) => {
      const runs = META_CONFIRMATION_MAX_FAILED_ATTEMPTS + 2;
      const { sendFn, calls } = flakySend(runs);
      for (let i = 0; i < runs; i++) {
        const r = await runMetaConfirmationBatch(deps(dir, { sendFn }));
        assert.equal(r.failedPermanent, 0, `rodada ${i + 1}`);
      }
      assert.equal(calls(), runs);
      const e = loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"];
      assert.equal(e.status, "failed");
      assert.equal(e.attempts ?? 0, 0);
    }));

  it("rede preserva tentativas já consumidas por 4xx (não zera, não incrementa)", () =>
    withTmp(async (dir) => {
      let n = 0;
      const sendFn = async (): Promise<MetaCapiSendResult> =>
        ++n === 1 ? { ok: false, status: 400, reason: "meta_error" } : { ok: false, status: 502, reason: "network_error" };
      await runMetaConfirmationBatch(deps(dir, { sendFn }));
      await runMetaConfirmationBatch(deps(dir, { sendFn }));
      assert.equal(loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"].attempts, 1);
    }));
});
