/**
 * test/onboarding-kit-tag-retryable-11340.test.ts
 *
 * Regressão #11340: em 27/10/2026 o lote `email2-2026-10-27-01` abortou no
 * guard de audiência com a tag VAZIA na releitura (atraso de consistência do
 * Kit, marcado `retryable`). O lote ficou `pending` e é refeito na rodada
 * seguinte, mas a falha contava em `lots_failed` e o passo `kit` saía 1 —
 * a unit `diaria-onboarding-welcome-run.service` ficava `failed` e reabria o
 * alarme P1 #6787 por algo que se resolve sozinho.
 *
 *   - releitura vazia uma vez e cheia na 2ª → o lote segue (sem falha);
 *   - vazia em todas as releituras → `PilotTagAudienceRetryableError`, nenhum
 *     broadcast criado, lote `pending`, contado em `lots_failed_retryable`;
 *   - a rodada só com essa falha sai 0, mas continua em `lots_failed` (relatório
 *     + streak do alarme de continuidade);
 *   - membro estranho / contagem a mais (`retryable: false`) segue derrubando.
 *
 * Deps do Kit falsas, em memória — nenhuma rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runProductionKitLot, isRetryableLotFailure } from "../scripts/onboarding-kit-transport-run.ts";
import { assertPilotTagAudience, PilotTagAudienceRetryableError, type PilotKitDeps } from "../scripts/lib/onboarding-kit-pilot.ts";
import {
  shouldExitNonZeroForKitSendRun,
  isFailedKitSendRun,
  type KitSendRunRecord,
  type OnboardingKitLot,
} from "../scripts/lib/onboarding-kit-transport.ts";

const TAG = 25079126;
const EMAIL = "d701@example.com";

/** `memberReads[i]` = membros devolvidos na i-ésima releitura (o último se repete). */
function fakeKit(memberReads: string[][]) {
  const calls: string[] = [];
  let reads = 0;
  const bc: { status: string; send_at: string | null } = { status: "draft", send_at: null };
  const deps: PilotKitDeps = {
    async findTagIdByName() {
      return TAG;
    },
    async createTag() {
      return { id: TAG };
    },
    async tagSubscriber() {
      calls.push("tag");
    },
    async listTagMemberEmails() {
      const r = memberReads[Math.min(reads, memberReads.length - 1)]!;
      reads++;
      calls.push("list");
      return r;
    },
    async createBroadcast() {
      calls.push("create");
      return { id: 4242, status: "draft", send_at: null };
    },
    async getBroadcast() {
      calls.push("get");
      return { ...bc, subscriber_filter: [{ all: [{ type: "tag", ids: [TAG] }] }] };
    },
    async updateBroadcast(_id, patch) {
      calls.push("patch");
      bc.status = "scheduled";
      bc.send_at = patch.send_at;
      return { ...bc };
    },
    async deleteBroadcast() {
      calls.push("delete");
    },
    async sleep() {
      calls.push("sleep");
    },
    warn() {},
  };
  return { deps, calls };
}

function lot(): OnboardingKitLot {
  return {
    lot_id: "email2-2026-10-27-01",
    kind: "email2",
    tag_name: "onboarding-email2-2026-10-27-01",
    tag_id: TAG,
    broadcast_id: null,
    recipient_subscription_ids: ["701"],
    recipient_emails: [EMAIL],
    status: "pending",
    created_at: new Date().toISOString(),
    send_at: null,
    last_reconciled_at: null,
    last_error: null,
  };
}

const opts = {
  kitIdBySubscription: { "701": 701 },
  subject: "s",
  content: "c",
  sendAtFn: () => new Date(Date.now() + 5 * 60_000).toISOString(),
  tagCheckAttempts: 3,
  tagCheckDelayMs: 0,
  alert: async () => {},
};

function rec(over: Partial<KitSendRunRecord>): KitSendRunRecord {
  return {
    at: "2026-10-27T12:13:00.000Z",
    lots_created: 0,
    lots_failed: 0,
    lots_unverified: 0,
    blocked_concurrent: 0,
    refresh_candidates: 0,
    refresh_failed: 0,
    content_skipped: 0,
    ...over,
  };
}

describe("#11340 — tag vazia na releitura (atraso do Kit) não derruba a unit", () => {
  it("releitura vazia uma vez e cheia na 2ª → o lote segue e é agendado", async () => {
    const k = fakeKit([[], [EMAIL]]);
    const l = lot();
    await runProductionKitLot(k.deps, l, opts);
    assert.equal(l.status, "scheduled");
    assert.equal(l.broadcast_id, 4242);
    assert.deepEqual(k.calls.filter((c) => c === "list" || c === "sleep"), ["list", "sleep", "list"]);
  });

  it("vazia em todas as releituras → erro retentável, sem broadcast, lote pending", async () => {
    const k = fakeKit([[]]);
    const l = lot();
    let err: unknown;
    try {
      await runProductionKitLot(k.deps, l, opts);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof PilotTagAudienceRetryableError, `esperado retentável, veio ${String(err)}`);
    assert.equal(isRetryableLotFailure(err), true);
    assert.match((err as Error).message, /VAZIA na releitura/);
    assert.equal(k.calls.filter((c) => c === "list").length, 3, "esgota as releituras antes de desistir");
    assert.ok(!k.calls.includes("create"), "nenhum broadcast criado");
    assert.equal(l.status, "pending");
    assert.equal(l.broadcast_id, null);
    assert.match(l.last_error ?? "", /VAZIA/);
  });

  it("membro estranho (retryable: false) → erro comum, nunca retentável", async () => {
    const k = fakeKit([[EMAIL, "intruso@example.com"]]);
    let err: unknown;
    try {
      await runProductionKitLot(k.deps, lot(), opts);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error);
    assert.equal(isRetryableLotFailure(err), false);
    assert.match((err as Error).message, /fora do lote\/allowlist/);
  });

  it("assertPilotTagAudience: nome resolvendo pra OUTRO id não é retentável", async () => {
    const k = fakeKit([[EMAIL]]);
    k.deps.findTagIdByName = async () => 1;
    await assert.rejects(
      assertPilotTagAudience(k.deps, lot(), [EMAIL], 3, 0),
      (e: unknown) => e instanceof Error && !(e instanceof PilotTagAudienceRetryableError) && /OUTRO id/.test(e.message),
    );
  });

  it("assertPilotTagAudience: nome que nunca resolve (propagação) esgota como retentável", async () => {
    const k = fakeKit([[EMAIL]]);
    k.deps.findTagIdByName = async () => null;
    await assert.rejects(assertPilotTagAudience(k.deps, lot(), [EMAIL], 2, 0), PilotTagAudienceRetryableError);
  });

  it("exit code: rodada só com falha retentável sai 0, mas segue falha no relatório/streak", () => {
    const soft = rec({ lots_failed: 1, lots_failed_retryable: 1 });
    assert.equal(shouldExitNonZeroForKitSendRun(soft), false);
    assert.equal(isFailedKitSendRun(soft), true, "segue contando na streak do alarme de continuidade");
  });

  it("exit code: falha retentável junto de falha real → 1; abort → 1; registro legado sem o campo → 1", () => {
    assert.equal(shouldExitNonZeroForKitSendRun(rec({ lots_failed: 2, lots_failed_retryable: 1 })), true);
    assert.equal(shouldExitNonZeroForKitSendRun(rec({ lots_failed: 1, lots_failed_retryable: 1, aborted: true })), true);
    assert.equal(shouldExitNonZeroForKitSendRun(rec({ lots_failed: 1 })), true);
    assert.equal(shouldExitNonZeroForKitSendRun(rec({ lots_failed: 0, lots_failed_retryable: 3 })), false, "nunca negativo");
  });
});
