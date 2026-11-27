/**
 * test/onboarding-followup-tag-retryable-14338.test.ts
 *
 * Regressão #14338: em 27/11/2026 o passo `followup` abortou o lote
 * `form_lembrete-2026-11-27-01` no guard de audiência com a tag VAZIA na
 * releitura (esperado 2). `runProductionKitLot` já relia com espera e lançava
 * `PilotTagAudienceRetryableError` (#11340), mas o executor do followup
 * contava o erro em `lots_failed` sem distinguir, e `resolveFollowupExitCode`
 * devolvia 1: unit `failed` e alarme #6787 reaberto por um atraso do Kit.
 *
 *   - tag vazia na 1ª releitura e cheia na 2ª → lote agendado, rodada sem falha;
 *   - vazia em todas → lote `pending`, sem broadcast, `lots_failed_retryable`,
 *     exit 0; a rodada seguinte retoma o MESMO lote e envia;
 *   - membro estranho (guard não retentável) continua saindo 1, sem broadcast.
 *
 * Kit fingido em memória, nenhuma rede, nenhum envio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFollowupSnippet,
  resolveFollowupConfig,
  resolveFollowupExitCode,
  isFailedFollowupRun,
  type FollowupRunRecord,
  type FollowupSnippets,
} from "../scripts/lib/onboarding-followup.ts";
import { runFollowupRound, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { runProductionKitLot } from "../scripts/onboarding-kit-transport-run.ts";
import { PilotTagAudienceRetryableError, type PilotKitDeps } from "../scripts/lib/onboarding-kit-pilot.ts";
import type { OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";
import { emptyStore, readStore, writeStore } from "../scripts/lib/onboarding-store.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;
const TAG = 26105806;

/** `memberReads()` decide os membros devolvidos em cada releitura da tag. */
function fakeKit(memberReads: (lot: { recipient_emails: string[] }, read: number) => string[]) {
  const calls: string[] = [];
  let reads = 0;
  let current: { recipient_emails: string[] } = { recipient_emails: [] };
  const bc: { status: string; send_at: string | null } = { status: "draft", send_at: null };
  let nextId = 4200;
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
      calls.push("list");
      return memberReads(current, reads++);
    },
    async createBroadcast() {
      calls.push("create");
      bc.status = "draft";
      bc.send_at = null;
      return { id: ++nextId, status: "draft", send_at: null };
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
  return {
    deps,
    calls,
    bind(lot: { recipient_emails: string[] }) {
      current = lot;
    },
    resetReads() {
      reads = 0;
    },
  };
}

const lotOpts = (ids: string[]) => ({
  kitIdBySubscription: Object.fromEntries(ids.map((id) => [id, Number(id)])),
  subject: "s",
  content: "c",
  sendAtFn: () => new Date(Date.now() + 5 * 60_000).toISOString(),
  tagCheckAttempts: 2,
  tagCheckDelayMs: 0,
  alert: async () => {},
});

function formLembreteLot(): OnboardingKitLot {
  return {
    lot_id: "form_lembrete-2026-11-27-01",
    kind: "form_lembrete",
    tag_name: "onboarding-form_lembrete-2026-11-27-01",
    tag_id: TAG,
    broadcast_id: null,
    recipient_subscription_ids: ["1", "2"],
    recipient_emails: ["1@x.com", "2@x.com"],
    status: "pending",
    created_at: new Date().toISOString(),
    send_at: null,
    last_reconciled_at: null,
    last_error: null,
  } as unknown as OnboardingKitLot;
}

describe("#14338 — guard de audiência do form_lembrete: releitura com espera", () => {
  it("tag vazia na 1ª releitura e cheia na 2ª → lote agendado", async () => {
    const k = fakeKit((lot, i) => (i === 0 ? [] : lot.recipient_emails));
    const l = formLembreteLot();
    k.bind(l);
    await runProductionKitLot(k.deps, l, lotOpts(l.recipient_subscription_ids));
    assert.equal(l.status, "scheduled");
    assert.ok(l.broadcast_id != null);
    assert.deepEqual(k.calls.filter((c) => c === "list" || c === "sleep"), ["list", "sleep", "list"], "espera antes de reler");
  });

  it("vazia nas duas releituras → erro retentável, sem broadcast, lote pending", async () => {
    const k = fakeKit(() => []);
    const l = formLembreteLot();
    k.bind(l);
    await assert.rejects(runProductionKitLot(k.deps, l, lotOpts(l.recipient_subscription_ids)), (e) => {
      assert.ok(e instanceof PilotTagAudienceRetryableError);
      assert.match((e as Error).message, /VAZIA na releitura \(esperado 2\)/);
      return true;
    });
    assert.ok(!k.calls.includes("create"), "nenhum broadcast criado");
    assert.equal(l.status, "pending");
    assert.equal(l.broadcast_id, null);
  });
});

// ---------------------------------------------------------------------------
// Rodada real do executor (store em disco), runLot = transporte de produção
// sobre o Kit fingido
// ---------------------------------------------------------------------------

function tempStore(): string {
  const p = join(mkdtempSync(join(tmpdir(), "followup-14338-")), "store.json");
  writeStore(emptyStore(), p);
  return p;
}

const ok = parseFollowupSnippet(`<!--\nassunto: "Assunto"\npreview_text: "Prev"\n-->\nCorpo`);
const snippets: FollowupSnippets = { apoio30: ok, apoio90: ok, apoio180: ok, apoio360: ok, form: null, form_lembrete: null };

const COHORT = [1, 2].map((i) => ({ kit_subscriber_id: i, email: `${i}@x.com`, cadastro_at: new Date(T0 * 1000).toISOString() }));

function roundDeps(k: ReturnType<typeof fakeKit>): FollowupRoundDeps & { runs: number } {
  const d = {
    runs: 0,
    async listActiveSubscribers() {
      return COHORT;
    },
    async getSubscriber() {
      return { state: "active", apoioNivel: "" };
    },
    async listEnvioBrevoEmails() {
      return [];
    },
    async fetchFormResponses() {
      return [];
    },
    async runLot(lot: Parameters<FollowupRoundDeps["runLot"]>[0], content: { subject: string; body: string; previewText?: string }) {
      d.runs++;
      k.bind(lot);
      k.resetReads();
      await runProductionKitLot(k.deps, lot as unknown as OnboardingKitLot, {
        ...lotOpts(lot.recipient_subscription_ids),
        subject: content.subject,
        content: content.body,
        previewText: content.previewText,
      });
    },
  };
  return d as FollowupRoundDeps & { runs: number };
}

function run(over: Partial<FollowupRunRecord> = {}): FollowupRunRecord {
  return { at: "2026-11-27T12:16:00Z", apoio_blocked: null, form_blocked: null, lots_created: 0, lots_failed: 0, over_cap: 0, lookups_failed: 0, counts: {}, ...over };
}

describe("#14338 — executor do followup: tag atrasada não derruba a unit", () => {
  it("vazia nas duas releituras → lote pending, exit 0, e a rodada seguinte retoma o mesmo lote e envia", async () => {
    const storePath = tempStore();
    const cfg = resolveFollowupConfig({ enabled: true });
    let tagReady = false;
    const k = fakeKit((lot) => (tagReady ? lot.recipient_emails : []));
    const d = roundDeps(k);
    const day = (n: number) => (T0 + 90 * DAY + n * DAY) * 1000;

    const r1 = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: day(0) }, d);
    assert.equal(r1.run.lots_failed, 1);
    assert.equal(r1.run.lots_failed_retryable, 1);
    assert.equal(resolveFollowupExitCode(r1.run), 0, "atraso de consistência do Kit não vira exit 1");
    assert.equal(isFailedFollowupRun(r1.run), true, "segue no relatório e na streak do alarme de continuidade");
    assert.ok(!k.calls.includes("create"), "nada criado no Kit além da tag");
    const lots1 = Object.values(readStore(storePath).store.followup!.lots);
    assert.equal(lots1.length, 1);
    assert.equal(lots1[0].status, "pending");
    assert.equal(lots1[0].broadcast_id, null);
    assert.match(lots1[0].last_error ?? "", /VAZIA na releitura/);

    tagReady = true;
    const r2 = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: day(1) }, d);
    assert.equal(r2.run.lots_failed, 0);
    assert.equal(r2.run.lots_created, 1);
    assert.equal(resolveFollowupExitCode(r2.run), 0);
    const lots2 = Object.values(readStore(storePath).store.followup!.lots);
    assert.equal(lots2.length, 1, "retoma o mesmo lote, sem tag nova");
    assert.equal(lots2[0].lot_id, lots1[0].lot_id);
    assert.equal(lots2[0].status, "scheduled");
  });

  it("membro estranho na tag (não retentável) continua saindo 1, sem broadcast", async () => {
    const storePath = tempStore();
    const cfg = resolveFollowupConfig({ enabled: true });
    const k = fakeKit((lot) => [...lot.recipient_emails, "intruso@x.com"]);
    const d = roundDeps(k);
    const r = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: (T0 + 90 * DAY) * 1000 }, d);
    assert.equal(r.run.lots_failed, 1);
    assert.equal(r.run.lots_failed_retryable ?? 0, 0);
    assert.equal(resolveFollowupExitCode(r.run), 1);
    assert.ok(!k.calls.includes("create"), "o guard continua barrando o envio");
  });

  it("resolveFollowupExitCode: só o subconjunto retentável é perdoado", () => {
    assert.equal(resolveFollowupExitCode(run({ lots_failed: 2, lots_failed_retryable: 2 })), 0);
    assert.equal(resolveFollowupExitCode(run({ lots_failed: 2, lots_failed_retryable: 1 })), 1, "outra falha real no mesmo dia segue 1");
    assert.equal(resolveFollowupExitCode(run({ lots_failed: 1, lots_failed_retryable: 5 })), 0, "contador inconsistente nunca fica negativo");
    assert.equal(resolveFollowupExitCode(run({ lots_failed: 1, lots_failed_retryable: 1, over_cap: 1 })), 1);
  });
});
