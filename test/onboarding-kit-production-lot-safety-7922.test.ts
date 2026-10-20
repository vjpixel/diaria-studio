/**
 * test/onboarding-kit-production-lot-safety-7922.test.ts
 *
 * Re-review do fleet review da PR #10607 (#7922), sobre o caminho de
 * PRODUÇÃO do transporte Kit do onboarding:
 *
 *   1. Releitura pós-PATCH ilegível/divergente + DELETE falho: o broadcast
 *      PODE ESTAR AGENDADO com audiência não confirmada. A limpeza tenta
 *      desagendar (PATCH `send_at: null` + filtro) e apagar de novo; se nada
 *      funciona, a mensagem manda apagar no painel do Kit AGORA (com o id) e
 *      o alerta imediato dispara.
 *   2. `--approve-email3-lot` em produção passa pela mesma confirmação:
 *      tag + filtro relido antes do PATCH, filtro + `scheduled` com `send_at`
 *      ecoado depois; senão, apaga.
 *
 * Deps do Kit falsas, em memória — nenhuma rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runProductionKitLot, approveProductionEmail3Lot } from "../scripts/onboarding-kit-transport-run.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";
import type { PilotKitDeps } from "../scripts/lib/onboarding-kit-pilot.ts";
import type { OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";

const TAG = 777;
const FILTER = [{ all: [{ type: "tag", ids: [TAG] }] }];

interface FakeOpts {
  /** Releitura pós-PATCH devolve um filtro DIVERGENTE. */
  postFilterDivergent?: boolean;
  /** Releitura pós-PATCH lança (rede). */
  postRereadThrows?: boolean;
  /** PATCH agenda? (default true) */
  patchSchedules?: boolean;
  /** DELETE devolve este status (default sucesso). */
  deleteStatus?: number;
  /** PATCH de desagendamento (`send_at: null`) lança. */
  unscheduleThrows?: boolean;
  /** Filtro do rascunho na releitura PRÉ-PATCH (default o da tag). */
  preFilter?: unknown;
}

function fakeKit(o: FakeOpts = {}) {
  const calls: string[] = [];
  let broadcast: { status: string; send_at: string | null; subscriber_filter: unknown } | null = null;
  let rereads = 0;
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
      return ["d601@example.com"];
    },
    async createBroadcast(input) {
      calls.push(`create send_at=${input.send_at}`);
      broadcast = { status: "draft", send_at: null, subscriber_filter: input.subscriber_filter };
      return { id: 4242, status: "draft", send_at: null };
    },
    async getBroadcast() {
      rereads++;
      calls.push("get");
      if (rereads >= 2 && o.postRereadThrows) throw new Error("ECONNRESET");
      const filter = rereads === 1 ? (o.preFilter ?? broadcast!.subscriber_filter) : o.postFilterDivergent ? [{ all: [{ type: "tag", ids: [1] }] }] : broadcast!.subscriber_filter;
      return { status: broadcast!.status, send_at: broadcast!.send_at, subscriber_filter: filter };
    },
    async updateBroadcast(_id, patch) {
      calls.push(`patch send_at=${patch.send_at}`);
      if (patch.send_at === null) {
        if (o.unscheduleThrows) throw new Error("500 unschedule");
        broadcast!.status = "draft";
        broadcast!.send_at = null;
        return { status: "draft", send_at: null };
      }
      if (o.patchSchedules !== false) {
        broadcast!.status = "scheduled";
        broadcast!.send_at = patch.send_at;
      }
      return { status: broadcast!.status, send_at: broadcast!.send_at };
    },
    async deleteBroadcast() {
      calls.push("delete");
      if (o.deleteStatus) throw new KitApiError("/broadcasts/4242", o.deleteStatus, JSON.stringify({ errors: ["mock"] }));
      broadcast = null;
    },
    async sleep() {},
    warn() {},
  };
  return { deps, calls, get broadcast() { return broadcast; } };
}

function lot(over: Partial<OnboardingKitLot> = {}): OnboardingKitLot {
  return {
    lot_id: "email3-2026-10-20-01",
    kind: "email3",
    tag_name: "onboarding-email3-2026-10-20-01",
    tag_id: null,
    broadcast_id: null,
    recipient_subscription_ids: ["601"],
    recipient_emails: ["d601@example.com"],
    status: "pending",
    created_at: new Date().toISOString(),
    send_at: null,
    last_reconciled_at: null,
    last_error: null,
    ...over,
  };
}

const lotOpts = (alerts: unknown[]) => ({
  kitIdBySubscription: { "601": 601 },
  subject: "s",
  content: "c",
  sendAtFn: () => new Date(Date.now() + 5 * 60_000).toISOString(),
  tagCheckAttempts: 1,
  tagCheckDelayMs: 0,
  alert: async (info: unknown) => {
    alerts.push(info);
  },
});

describe("#7922 — DELETE falho depois do PATCH (broadcast pode estar agendado)", () => {
  it("releitura pós-PATCH divergente + DELETE 500 + desagendar falha → schedule_failed, mensagem 'PODE ESTAR AGENDADO' com o id, alerta disparado", async () => {
    const k = fakeKit({ postFilterDivergent: true, deleteStatus: 500, unscheduleThrows: true });
    const l = lot();
    const alerts: { broadcast_id: number; reason: string }[] = [];
    await assert.rejects(runProductionKitLot(k.deps, l, lotOpts(alerts)), /PODE ESTAR AGENDADO/);
    assert.equal(l.status, "created");
    assert.equal(l.schedule_failed, true);
    assert.match(l.last_error ?? "", /broadcast 4242/);
    assert.match(l.last_error ?? "", /APAGUE NO PAINEL DO KIT AGORA, antes que saia/);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].broadcast_id, 4242);
    assert.ok(k.calls.includes("patch send_at=null"), "tentou desagendar antes de desistir");
    assert.equal(k.calls.filter((c) => c === "delete").length, 1, "sem desagendamento, não repete o DELETE");
  });

  it("releitura pós-PATCH divergente + DELETE 500, mas desagendar funciona → 2º DELETE; se ok, lote cancelled e sem alerta", async () => {
    let deletes = 0;
    const k = fakeKit({ postFilterDivergent: true });
    const realDelete = k.deps.deleteBroadcast;
    k.deps.deleteBroadcast = async (id) => {
      deletes++;
      if (deletes === 1) throw new KitApiError("/broadcasts/4242", 500, "boom");
      return realDelete(id);
    };
    const l = lot();
    const alerts: unknown[] = [];
    await assert.rejects(runProductionKitLot(k.deps, l, lotOpts(alerts)), /apagado, lote cancelado/);
    assert.equal(l.status, "cancelled");
    assert.equal(alerts.length, 0);
    assert.equal(deletes, 2);
  });

  it("releitura pós-PATCH que LANÇA + DELETE 500 + desagendar falha → também 'PODE ESTAR AGENDADO' + alerta", async () => {
    const k = fakeKit({ postRereadThrows: true, deleteStatus: 500, unscheduleThrows: true });
    const l = lot();
    const alerts: unknown[] = [];
    await assert.rejects(runProductionKitLot(k.deps, l, lotOpts(alerts)), /PODE ESTAR AGENDADO/);
    assert.equal(alerts.length, 1);
  });

  it("releitura pós-PATCH confirma RASCUNHO (PATCH não agendou) + DELETE 500 → 'rascunho ficou no Kit', sem alerta", async () => {
    const k = fakeKit({ patchSchedules: false, deleteStatus: 500 });
    const l = lot();
    const alerts: unknown[] = [];
    await assert.rejects(runProductionKitLot(k.deps, l, lotOpts(alerts)), /rascunho do broadcast 4242 ficou no Kit/);
    assert.equal(l.schedule_failed, true);
    assert.equal(alerts.length, 0);
    assert.ok(!k.calls.includes("patch send_at=null"), "rascunho comprovado não precisa desagendar");
  });

  it("caminho feliz: rascunho → releitura → PATCH → releitura → scheduled", async () => {
    const k = fakeKit();
    const l = lot();
    await runProductionKitLot(k.deps, l, lotOpts([]));
    assert.equal(l.status, "scheduled");
    assert.ok(l.send_at);
    assert.deepEqual(k.calls.filter((c) => c.startsWith("create")), ["create send_at=null"]);
  });
});

describe("#7922 — --approve-email3-lot em produção passa pela mesma confirmação", () => {
  const draftLot = () => lot({ tag_id: TAG, broadcast_id: 4242, status: "created" });
  const sendAt = () => new Date(Date.now() + 60 * 60_000).toISOString();

  it("ok: tag conferida, filtro relido antes e depois, agenda com send_at ecoado", async () => {
    const k = fakeKit();
    await k.deps.createBroadcast({ subject: "s", content: "c", public: false, send_at: null, subscriber_filter: FILTER as never });
    k.calls.length = 0;
    const l = draftLot();
    await approveProductionEmail3Lot(k.deps, l, { sendAt: sendAt(), tagCheckAttempts: 1, tagCheckDelayMs: 0 });
    assert.equal(l.status, "scheduled");
    assert.ok(l.send_at);
    assert.deepEqual(k.calls.filter((c) => c === "get" || c.startsWith("patch")).map((c) => c.split(" ")[0]), ["get", "patch", "get"]);
  });

  it("filtro do rascunho divergente antes do PATCH → nunca agenda, rascunho apagado", async () => {
    const k = fakeKit({ preFilter: [{ all: [{ type: "tag", ids: [1] }] }] });
    await k.deps.createBroadcast({ subject: "s", content: "c", public: false, send_at: null, subscriber_filter: FILTER as never });
    k.calls.length = 0;
    const l = draftLot();
    await assert.rejects(approveProductionEmail3Lot(k.deps, l, { sendAt: sendAt(), tagCheckAttempts: 1, tagCheckDelayMs: 0 }), /NÃO confirmada antes de agendar/);
    assert.ok(!k.calls.some((c) => c.startsWith("patch")), "nunca agenda sem ver o filtro");
    assert.ok(k.calls.includes("delete"));
    assert.equal(l.status, "cancelled");
  });

  it("PATCH que não agenda → rascunho apagado, lote cancelled", async () => {
    const k = fakeKit({ patchSchedules: false });
    await k.deps.createBroadcast({ subject: "s", content: "c", public: false, send_at: null, subscriber_filter: FILTER as never });
    const l = draftLot();
    await assert.rejects(approveProductionEmail3Lot(k.deps, l, { sendAt: sendAt(), tagCheckAttempts: 1, tagCheckDelayMs: 0 }), /sem agendamento na releitura/);
    assert.equal(l.status, "cancelled");
  });

  it("tag com membro estranho → aborta antes do PATCH", async () => {
    const k = fakeKit();
    k.deps.listTagMemberEmails = async () => ["d601@example.com", "outra@example.com"];
    await k.deps.createBroadcast({ subject: "s", content: "c", public: false, send_at: null, subscriber_filter: FILTER as never });
    k.calls.length = 0;
    const l = draftLot();
    await assert.rejects(approveProductionEmail3Lot(k.deps, l, { sendAt: sendAt(), tagCheckAttempts: 1, tagCheckDelayMs: 0 }), /guard de audiência/);
    assert.ok(!k.calls.some((c) => c.startsWith("patch")));
  });

  it("recusa lote que não é rascunho de e-mail 3 com tag", async () => {
    const k = fakeKit();
    await assert.rejects(approveProductionEmail3Lot(k.deps, lot({ kind: "email1", tag_id: TAG, broadcast_id: 1, status: "created" }), { sendAt: sendAt() }), /não "email3"/);
    await assert.rejects(approveProductionEmail3Lot(k.deps, lot({ tag_id: null, broadcast_id: 1, status: "created" }), { sendAt: sendAt() }), /sem tag_id/);
    await assert.rejects(approveProductionEmail3Lot(k.deps, lot({ tag_id: TAG, broadcast_id: 1, status: "scheduled" }), { sendAt: sendAt() }), /só um rascunho/);
  });
});
