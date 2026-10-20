/**
 * test/onboarding-followup-reconcile-10628.test.ts (#10628)
 *
 * Regressão: lote de apoio/formulário em `schedule_failed` (PATCH aplicado no
 * Kit, releitura pós-PATCH falhou, DELETE/desagendar também falharam) não pode
 * virar um lote NOVO para as mesmas pessoas no dia seguinte — o broadcast
 * pendente pode ter saído. O `--send` do executor das sequências relê esses
 * lotes antes de planejar (mesma regra `confirmOrCleanUpScheduledLot` da
 * escada) e, enquanto seguem não resolvidos, tira os destinatários de `due` e
 * conta a rodada como falha.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  idsInUnresolvedFollowupLots,
  isFailedFollowupRun,
  parseFollowupSnippet,
  resolveFollowupConfig,
  type FollowupLot,
  type FollowupSnippets,
} from "../scripts/lib/onboarding-followup.ts";
import { runFollowupRound, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, readStore, writeStore, type OnboardingEntry } from "../scripts/lib/onboarding-store.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;
const cfg = resolveFollowupConfig({ enabled: true, form_url: "https://form.example/", form_responses_url: "https://form.example/api/respostas" });

function snip(withPlaceholder = false) {
  return parseFollowupSnippet(`<!--\nassunto: "Assunto"\npreview_text: "Prev"\n-->\nCorpo${withPlaceholder ? " {{FORM_URL}}" : ""}`);
}
const apoioOnly: FollowupSnippets = { apoio30: snip(), apoio90: snip(), apoio180: snip(), apoio360: snip(), form: null, form_lembrete: null };
const formOnly: FollowupSnippets = { apoio30: null, apoio90: null, apoio180: null, apoio360: null, form: snip(true), form_lembrete: snip(true) };

function tempStore(seed?: (s: ReturnType<typeof emptyStore>) => void): string {
  const p = join(mkdtempSync(join(tmpdir(), "followup-10628-")), "store.json");
  const s = emptyStore();
  seed?.(s);
  writeStore(s, p);
  return p;
}

/** runLot que reproduz o cenário da issue: broadcast criado e PATCH aplicado,
 *  releitura falha e a limpeza (DELETE + desagendar) também — lote fica
 *  `created` + `schedule_failed` e a rodada lança. */
function failingRunLot(calls: string[]): FollowupRoundDeps["runLot"] {
  return async (lot) => {
    calls.push(`lot:${lot.kind}`);
    lot.tag_id = 5;
    lot.broadcast_id = 9001;
    lot.status = "created";
    lot.schedule_failed = true;
    lot.last_error = "releitura falhou; DELETE falhou — PODE ESTAR AGENDADO";
    throw new Error(lot.last_error);
  };
}

function deps(over: Partial<FollowupRoundDeps> & { calls: string[] }): FollowupRoundDeps {
  const { calls, ...rest } = over;
  return {
    async listActiveSubscribers() {
      return [];
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
    async runLot(lot) {
      calls.push(`lot:${lot.kind}`);
      lot.broadcast_id = 2000;
      lot.status = "scheduled";
      lot.send_at = "2026-03-01T12:05:00Z";
    },
    ...rest,
  };
}

const cad = new Date(T0 * 1000).toISOString();
const apoioSubs = async () => [{ kit_subscriber_id: 1, email: "a@x.com", cadastro_at: cad }];

async function dayOneApoio(storePath: string): Promise<void> {
  const calls: string[] = [];
  const r = await runFollowupRound(
    { storePath, send: true, cfg, snippets: apoioOnly, nowMs: (T0 + 30 * DAY) * 1000 },
    deps({ calls, listActiveSubscribers: apoioSubs, runLot: failingRunLot(calls) }),
  );
  assert.equal(r.run.lots_failed, 1);
  const lots = Object.values(readStore(storePath).store.followup!.lots);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].schedule_failed, true);
  assert.equal(lots[0].status, "created");
}

describe("#10628 apoio: lote schedule_failed não vira lote duplicado no dia seguinte", () => {
  it("releitura falha de novo: nenhum lote novo, destinatário fora de due, rodada conta falha", async () => {
    const storePath = tempStore();
    await dayOneApoio(storePath);

    const calls: string[] = [];
    const r2 = await runFollowupRound(
      { storePath, send: true, cfg, snippets: apoioOnly, nowMs: (T0 + 31 * DAY) * 1000 },
      deps({
        calls,
        listActiveSubscribers: apoioSubs,
        async getBroadcast() {
          calls.push("getBroadcast");
          throw new Error("ECONNRESET");
        },
        async deleteBroadcast() {
          calls.push("deleteBroadcast");
        },
      }),
    );
    assert.ok(calls.includes("getBroadcast"), "o lote foi relido");
    assert.equal(calls.filter((c) => c.startsWith("lot:")).length, 0, "nenhum broadcast novo");
    assert.equal(r2.run.lots_created, 0);
    assert.equal(r2.run.lots_unresolved, 1);
    assert.equal(r2.run.counts.apoio30?.lote_nao_confirmado, 1);
    assert.equal(isFailedFollowupRun(r2.run), true, "conta pro alarme de continuidade");
    const block = readStore(storePath).store.followup!;
    assert.equal(Object.keys(block.lots).length, 1, "nenhum lote novo no store");
    assert.equal(Object.values(block.lots)[0].schedule_failed, true);
  });

  it("releitura mostra o broadcast enviado: lote vira completed e o envio é gravado por pessoa (sem lote novo)", async () => {
    const storePath = tempStore();
    await dayOneApoio(storePath);

    const calls: string[] = [];
    const r2 = await runFollowupRound(
      { storePath, send: true, cfg, snippets: apoioOnly, nowMs: (T0 + 31 * DAY) * 1000 },
      deps({
        calls,
        listActiveSubscribers: apoioSubs,
        async getBroadcast() {
          return { status: "completed", send_at: "2026-01-31T12:05:00Z" };
        },
        async deleteBroadcast() {
          calls.push("deleteBroadcast");
        },
      }),
    );
    assert.equal(calls.filter((c) => c.startsWith("lot:") || c === "deleteBroadcast").length, 0);
    assert.equal(r2.run.lots_unresolved, 0);
    assert.equal(isFailedFollowupRun(r2.run), false);
    const block = readStore(storePath).store.followup!;
    const lot = Object.values(block.lots)[0];
    assert.equal(lot.status, "completed");
    assert.equal(lot.schedule_failed, undefined);
    assert.deepEqual(block.people["1"].sends.map((s) => [s.step, s.at]), [["apoio30", "2026-01-31T12:05:00Z"]]);
  });

  it("releitura mostra rascunho e o DELETE funciona: lote cancelado e a pessoa volta ao plano na mesma rodada", async () => {
    const storePath = tempStore();
    await dayOneApoio(storePath);

    const calls: string[] = [];
    const r2 = await runFollowupRound(
      { storePath, send: true, cfg, snippets: apoioOnly, nowMs: (T0 + 31 * DAY) * 1000 },
      deps({
        calls,
        listActiveSubscribers: apoioSubs,
        async getBroadcast() {
          return { status: "draft", send_at: null };
        },
        async deleteBroadcast() {
          calls.push("deleteBroadcast");
        },
      }),
    );
    assert.deepEqual(calls, ["deleteBroadcast", "lot:apoio30"]);
    assert.equal(r2.run.lots_unresolved, 0);
    assert.equal(r2.run.lots_created, 1);
    const lots = Object.values(readStore(storePath).store.followup!.lots);
    assert.deepEqual(lots.map((l) => l.status).sort(), ["cancelled", "scheduled"]);
  });

  it("404 na releitura NÃO cancela (lote sem conta Kit gravada): segue não resolvido", async () => {
    const storePath = tempStore();
    await dayOneApoio(storePath);
    const calls: string[] = [];
    const r2 = await runFollowupRound(
      { storePath, send: true, cfg, snippets: apoioOnly, nowMs: (T0 + 31 * DAY) * 1000 },
      deps({
        calls,
        listActiveSubscribers: apoioSubs,
        async getBroadcast() {
          throw new KitApiError("/broadcasts/9001", 404, "Not Found");
        },
        async deleteBroadcast() {
          calls.push("deleteBroadcast");
        },
      }),
    );
    assert.equal(calls.filter((c) => c.startsWith("lot:")).length, 0);
    assert.equal(r2.run.lots_unresolved, 1);
  });

  it("dry-run não chama o Kit nem grava, mas também não planeja o destinatário pendente", async () => {
    const storePath = tempStore();
    await dayOneApoio(storePath);
    const calls: string[] = [];
    const r2 = await runFollowupRound(
      { storePath, send: false, cfg, snippets: apoioOnly, nowMs: (T0 + 31 * DAY) * 1000 },
      deps({
        calls,
        listActiveSubscribers: apoioSubs,
        async getBroadcast() {
          calls.push("getBroadcast");
          return { status: "completed" };
        },
      }),
    );
    assert.deepEqual(calls, []);
    assert.equal(r2.run.counts.apoio30?.lote_nao_confirmado, 1);
    assert.equal(Object.values(readStore(storePath).store.followup!.lots)[0].status, "created");
  });
});

describe("#10633 conta Kit gravada no lote: 404 na releitura cancela quando a conta confere", () => {
  async function dayOneWithAccount(storePath: string, accountId: () => Promise<string>): Promise<void> {
    const calls: string[] = [];
    const r = await runFollowupRound(
      { storePath, send: true, cfg, snippets: apoioOnly, nowMs: (T0 + 30 * DAY) * 1000 },
      deps({ calls, listActiveSubscribers: apoioSubs, runLot: failingRunLot(calls), getAccountId: accountId }),
    );
    assert.equal(r.run.lots_failed, 1);
  }
  const notFound = async () => {
    throw new KitApiError("/broadcasts/9001", 404, "Not Found");
  };

  it("o envio real grava kit_account_id no lote (persistido no store)", async () => {
    const storePath = tempStore();
    await dayOneWithAccount(storePath, async () => "acc-1");
    const lot = Object.values(readStore(storePath).store.followup!.lots)[0];
    assert.equal(lot.kit_account_id, "acc-1");
  });

  it("404 + mesma conta: lote cancelado, rodada não conta falha e a pessoa volta ao plano", async () => {
    const storePath = tempStore();
    await dayOneWithAccount(storePath, async () => "acc-1");
    const calls: string[] = [];
    const r2 = await runFollowupRound(
      { storePath, send: true, cfg, snippets: apoioOnly, nowMs: (T0 + 31 * DAY) * 1000 },
      deps({
        calls,
        listActiveSubscribers: apoioSubs,
        getBroadcast: notFound,
        async deleteBroadcast() {
          calls.push("deleteBroadcast");
        },
        async getAccountId() {
          return "acc-1";
        },
      }),
    );
    assert.equal(r2.run.lots_unresolved, 0);
    assert.equal(isFailedFollowupRun(r2.run), false, "alarme não toca de novo");
    assert.deepEqual(calls, ["lot:apoio30"], "a pessoa entra num lote novo");
    const lots = Object.values(readStore(storePath).store.followup!.lots);
    assert.deepEqual(lots.map((l) => l.status).sort(), ["cancelled", "scheduled"]);
  });

  it("404 + conta diferente: NÃO cancela (credencial de outra conta dá 404 em tudo)", async () => {
    const storePath = tempStore();
    await dayOneWithAccount(storePath, async () => "acc-1");
    const calls: string[] = [];
    const r2 = await runFollowupRound(
      { storePath, send: true, cfg, snippets: apoioOnly, nowMs: (T0 + 31 * DAY) * 1000 },
      deps({
        calls,
        listActiveSubscribers: apoioSubs,
        getBroadcast: notFound,
        async getAccountId() {
          return "acc-2";
        },
      }),
    );
    assert.equal(calls.filter((c) => c.startsWith("lot:")).length, 0);
    assert.equal(r2.run.lots_unresolved, 1);
    assert.equal(Object.values(readStore(storePath).store.followup!.lots)[0].status, "created");
  });

  it("GET /account falhando na criação não trava o envio: lote sai sem id e 404 depois não cancela", async () => {
    const storePath = tempStore();
    await dayOneWithAccount(storePath, async () => {
      throw new Error("HTTP 503");
    });
    const lot = Object.values(readStore(storePath).store.followup!.lots)[0];
    assert.equal(lot.kit_account_id, undefined);
    const calls: string[] = [];
    const r2 = await runFollowupRound(
      { storePath, send: true, cfg, snippets: apoioOnly, nowMs: (T0 + 31 * DAY) * 1000 },
      deps({
        calls,
        listActiveSubscribers: apoioSubs,
        getBroadcast: notFound,
        async getAccountId() {
          return "acc-1";
        },
      }),
    );
    assert.equal(r2.run.lots_unresolved, 1);
  });
});

describe("#10628 form_lembrete: mesma barreira (a dedup dele dependia só de people.sends)", () => {
  const entry: OnboardingEntry = {
    subscription_id: "7", email: "f@x.com", status_detectado: "active", created_at: T0, detected_at: "2026-01-01T00:00:00Z",
    email1_sent_at: "2026-01-01T12:00:00Z", email1_brevo_id: null, email2_sent_at: null, email2_brevo_id: null,
    email3_state: "pending", email3_campaign_id: null, email3_decided_at: null,
  };
  const seed = (s: ReturnType<typeof emptyStore>) => {
    s.entries["7"] = entry;
    s.followup = {
      people: { "7": { kit_subscriber_id: 7, email: "f@x.com", cadastro_at: null, sends: [{ step: "form", at: new Date((T0 + 6 * DAY) * 1000).toISOString(), lot_id: "form-x-01" }] } },
      lots: {},
    };
  };
  const day1 = (T0 + 36 * DAY) * 1000;

  it("PATCH ok + releitura falha + limpeza falha → dia seguinte não cria outro lembrete", async () => {
    const storePath = tempStore(seed);
    const c1: string[] = [];
    const r1 = await runFollowupRound({ storePath, send: true, cfg, snippets: formOnly, nowMs: day1 }, deps({ calls: c1, runLot: failingRunLot(c1) }));
    assert.deepEqual(c1, ["lot:form_lembrete"]);
    assert.equal(r1.run.lots_failed, 1);

    const c2: string[] = [];
    const r2 = await runFollowupRound(
      { storePath, send: true, cfg, snippets: formOnly, nowMs: day1 + DAY * 1000 },
      deps({
        calls: c2,
        async getBroadcast() {
          throw new Error("HTTP 429");
        },
        async deleteBroadcast() {
          c2.push("deleteBroadcast");
        },
      }),
    );
    assert.equal(c2.filter((c) => c.startsWith("lot:")).length, 0, "lembrete NÃO sai em dobro");
    assert.equal(r2.run.counts.form_lembrete?.lote_nao_confirmado, 1);
    assert.equal(r2.run.lots_unresolved, 1);
    assert.equal(Object.keys(readStore(storePath).store.followup!.lots).length, 1);
  });

  it("sem as deps de releitura o lote também fica não resolvido (nunca libera às cegas)", async () => {
    const storePath = tempStore(seed);
    const c1: string[] = [];
    await runFollowupRound({ storePath, send: true, cfg, snippets: formOnly, nowMs: day1 }, deps({ calls: c1, runLot: failingRunLot(c1) }));
    const c2: string[] = [];
    const r2 = await runFollowupRound({ storePath, send: true, cfg, snippets: formOnly, nowMs: day1 + DAY * 1000 }, deps({ calls: c2 }));
    assert.equal(c2.length, 0);
    assert.equal(r2.run.lots_unresolved, 1);
  });
});

describe("#10628 idsInUnresolvedFollowupLots", () => {
  it("conta lotes created (com ou sem schedule_failed) de qualquer etapa; ignora pending/cancelled/confirmados", () => {
    const mk = (id: string, over: Partial<FollowupLot>): FollowupLot => ({
      lot_id: id, kind: "apoio30", tag_name: "t", tag_id: 1, broadcast_id: 1, recipient_subscription_ids: [id], recipient_emails: [],
      status: "created", created_at: "2026-01-01T00:00:00Z", send_at: null, last_reconciled_at: null, last_error: null, ...over,
    });
    const ids = idsInUnresolvedFollowupLots({
      a: mk("a", { schedule_failed: true }),
      b: mk("b", { kind: "form_lembrete" }),
      c: mk("c", { status: "pending", broadcast_id: null }),
      d: mk("d", { status: "cancelled" }),
      e: mk("e", { status: "scheduled" }),
    });
    assert.deepEqual([...ids].sort(), ["a", "b"]);
  });
});
