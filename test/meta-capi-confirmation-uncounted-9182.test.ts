/**
 * Regressão #9182 (par do #9157 do Google): `network_error` no lote de
 * confirmação Meta gravava `failed` sem incrementar nada, então o mesmo evento
 * era reenviado a cada rodada horária até a janela de 7 dias (~168x) — e a
 * exceção de rede pode vir DEPOIS de a Meta ter processado o POST. Agora rede
 * consome `uncountedPostAttempts` com teto próprio; 5xx/429 (#9022) seguem
 * fora de qualquer teto além da janela.
 * Nenhum teste toca a Meta: `sendFn` é mock; índice em dir temporário.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  META_CONFIRMATION_MAX_FAILED_ATTEMPTS,
  META_CONFIRMATION_MAX_UNCOUNTED_POST_ATTEMPTS,
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
const CREATED_AT = new Date(BASE_DATE_MS).toISOString();

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "meta-confirm-9182-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const sub = (id: number): ConfirmationRosterEntry => ({
  id,
  email_address: `leitor${id}@example.com`,
  state: "active",
  created_at: CREATED_AT,
});
const base = (id: number, state: string): SubscriberStateRecord => ({ id, state, created_at: CREATED_AT });

function countingSend(result: (n: number) => MetaCapiSendResult) {
  let n = 0;
  const sendFn = async (): Promise<MetaCapiSendResult> => result(++n);
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

const NET: MetaCapiSendResult = { ok: false, status: 502, reason: "network_error" };

describe("#9182 — falha de rede ambígua tem teto próprio no lote Meta", () => {
  it("teto é maior que MAX_FAILED_ATTEMPTS (tolera horas de rede instável)", () => {
    assert.ok(META_CONFIRMATION_MAX_UNCOUNTED_POST_ATTEMPTS > META_CONFIRMATION_MAX_FAILED_ATTEMPTS);
  });

  it("rede caindo até o teto vira skipped-failed-permanent e para de reenviar", () =>
    withTmp(async (dir) => {
      const { sendFn, calls } = countingSend(() => NET);
      const max = META_CONFIRMATION_MAX_UNCOUNTED_POST_ATTEMPTS;
      for (let i = 1; i < max; i++) {
        const r = await runMetaConfirmationBatch(deps(dir, { sendFn }));
        assert.equal(r.failedPermanent, 0, `rodada ${i}`);
        const e = loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"];
        assert.equal(e.status, "failed");
        assert.equal(e.uncountedPostAttempts, i);
        assert.equal(e.attempts ?? 0, 0, "rede nunca consome attempts");
      }
      const last = await runMetaConfirmationBatch(deps(dir, { sendFn }));
      assert.equal(last.failedPermanent, 1);
      assert.equal(last.failed, 1);
      assert.equal(last.transientFailed, 1);
      const e = loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"];
      assert.equal(e.status, "skipped-failed-permanent");
      assert.equal(e.uncountedPostAttempts, max);

      // Rodada seguinte: não reenvia mais o evento.
      const after = await runMetaConfirmationBatch(deps(dir, { sendFn }));
      assert.equal(calls(), max, "nenhum POST além do teto");
      assert.equal(after.toSend, 0);
    }));

  it("5xx/429 NÃO consomem o teto — continuam reenviando além dele (#9022)", () =>
    withTmp(async (dir) => {
      const runs = META_CONFIRMATION_MAX_UNCOUNTED_POST_ATTEMPTS + 2;
      const { sendFn, calls } = countingSend((n) => ({ ok: false, status: n % 2 ? 503 : 429, reason: "meta_error" }));
      for (let i = 0; i < runs; i++) {
        const r = await runMetaConfirmationBatch(deps(dir, { sendFn }));
        assert.equal(r.failedPermanent, 0, `rodada ${i + 1}`);
      }
      assert.equal(calls(), runs);
      const e = loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"];
      assert.equal(e.status, "failed");
      assert.equal(e.uncountedPostAttempts, undefined);
    }));

  it("5xx preserva o contador de rede já acumulado; 4xx também", () =>
    withTmp(async (dir) => {
      const seq: MetaCapiSendResult[] = [
        NET,
        NET,
        { ok: false, status: 500, reason: "meta_error" },
        { ok: false, status: 400, reason: "meta_error" },
      ];
      const { sendFn } = countingSend((n) => seq[n - 1]);
      for (let i = 0; i < 3; i++) await runMetaConfirmationBatch(deps(dir, { sendFn }));
      let e = loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"];
      assert.equal(e.uncountedPostAttempts, 2);
      await runMetaConfirmationBatch(deps(dir, { sendFn }));
      e = loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"];
      assert.equal(e.attempts, 1);
      assert.equal(e.uncountedPostAttempts, 2);
    }));

  it("sucesso após falhas de rede grava sent", () =>
    withTmp(async (dir) => {
      const { sendFn, calls } = countingSend((n) => (n <= 3 ? NET : { ok: true, status: 200 }));
      for (let i = 0; i < 5; i++) await runMetaConfirmationBatch(deps(dir, { sendFn }));
      const e = loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"];
      assert.equal(e.status, "sent");
      assert.equal(e.uncountedPostAttempts, undefined, "sent não herda contador");
      assert.equal(calls(), 4, "após sent, não reenvia");
    }));

  it("4xx anterior preservado quando a rede esgota o teto", () =>
    withTmp(async (dir) => {
      const { sendFn } = countingSend((n) => (n === 1 ? { ok: false, status: 400, reason: "meta_error" } : NET));
      for (let i = 0; i <= META_CONFIRMATION_MAX_UNCOUNTED_POST_ATTEMPTS; i++) {
        await runMetaConfirmationBatch(deps(dir, { sendFn }));
      }
      const e = loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"];
      assert.equal(e.status, "skipped-failed-permanent");
      assert.equal(e.attempts, 1);
      assert.equal(e.uncountedPostAttempts, META_CONFIRMATION_MAX_UNCOUNTED_POST_ATTEMPTS);
    }));
});
