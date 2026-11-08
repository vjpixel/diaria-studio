/**
 * test/onboarding-form-base-invite-10605.test.ts (#10605, decisões do editor de 08/11/2026)
 *
 * Regra A: o lembrete vale para quem recebeu o D+6 (`form`) OU o e-mail único
 * da base (`form_base`) e não respondeu, 30 dias depois do último e-mail do
 * formulário, teto de 3 por pessoa; o store registra qual convite a pessoa
 * recebeu (`form_invite`).
 * Regra B: o público do e-mail da base exclui quem já recebeu o D+6, quem vai
 * recebê-lo em até 7 dias e quem já respondeu o formulário NOVO.
 * E o script de preparo (`onboarding-form-base-prep.ts`): assinaturas em lote
 * (dry-run, teto, idempotente) e rascunho no Kit que nunca agenda nem envia.
 * Tudo com fakes: nenhuma rede, store e textos em `mkdtempSync`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyBaseInviteToPeople,
  applyFollowupLotToPeople,
  baseInviteRecipientIds,
  decideBaseInviteConfirm,
  formBaseCandidatesFromPeople,
  formInviteOf,
  formStepDue,
  planFollowup,
  resolveFollowupConfig,
  selectBaseInviteAudience,
  type FollowupBaseInvite,
  type FollowupLot,
  type FollowupPerson,
} from "../scripts/lib/onboarding-followup.ts";
import { emptyStore, readStore, writeStore, type OnboardingEntry } from "../scripts/lib/onboarding-store.ts";
import { PENDING_BODY_MARKER } from "../scripts/lib/onboarding-state.ts";
import { signFormEmail } from "../scripts/lib/onboarding-form-link-sig.ts";
import { buildOnboardingLotFilter } from "../scripts/lib/onboarding-kit-transport.ts";
import type { PilotKitDeps } from "../scripts/lib/onboarding-kit-pilot.ts";
import { confirmBaseInviteIfSent, FOLLOWUP_DRAFTS_DIR } from "../scripts/onboarding-followup-run.ts";
import {
  BASE_TAG_SPACING_MS,
  basePrepExitCode,
  runBaseConfirm,
  runBaseDraft,
  runBaseReset,
  runBaseSigs,
  CliExitWithMessage,
  type BasePrepDeps,
  type BasePrepOpts,
  type ActiveSubscriberRow,
} from "../scripts/onboarding-form-base-prep.ts";

const DAY = 86_400;
const T0 = Math.floor(Date.parse("2026-11-01T12:00:00Z") / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const SECRET = "segredo-de-teste-com-32-caracteres-ou-mais";
const cfg = resolveFollowupConfig({ enabled: true, form_url: "https://f.example/", form_responses_url: "https://f.example/api/respostas" });

function person(over: Partial<FollowupPerson> = {}): FollowupPerson {
  return { kit_subscriber_id: 1, email: "a@x.com", cadastro_at: null, sends: [], ...over };
}

function entry(id: number, email: string, email1At: string | null, createdSec: number | null = T0 - 400 * DAY): OnboardingEntry {
  return {
    subscription_id: String(id), email, status_detectado: "active", created_at: createdSec, detected_at: iso(createdSec ?? T0),
    email1_sent_at: email1At, email1_brevo_id: null, email2_sent_at: null, email2_brevo_id: null,
    email3_state: "pending", email3_campaign_id: null, email3_decided_at: null,
  };
}

describe("regra A: lembrete para os dois convites, teto de 3, convite registrado", () => {
  it("quem recebeu o e-mail da base vira candidato do lembrete 30 dias depois, até 3", () => {
    const p = person({ kit_subscriber_id: 7, email: "b@x.com", sends: [{ step: "form_base", at: iso(T0), lot_id: "form_base-x-01" }], form_invite: "form_base" });
    const people = { "7": p };
    const cands = formBaseCandidatesFromPeople(people, new Set());
    assert.deepEqual(cands, [{ kit_subscriber_id: 7, email: "b@x.com", anchorSec: null }]);
    assert.deepEqual(formBaseCandidatesFromPeople(people, new Set([7])), [], "já candidato da escada não duplica");
    const plan = (nowSec: number) =>
      planFollowup({ apoioCandidates: [], formCandidates: cands, people, nowSec, cfg, apoioBlocked: null, formBlocked: null }).due.map((d) => d.kind);
    assert.deepEqual(plan(T0 + 29 * DAY), []);
    assert.deepEqual(plan(T0 + 30 * DAY), ["form_lembrete"], "nunca o D+6: já recebeu um convite");
    let at = T0;
    for (let i = 0; i < 3; i++) {
      at += 30 * DAY;
      p.sends.push({ step: "form_lembrete", at: iso(at), lot_id: `l${i}` });
    }
    const r = planFollowup({ apoioCandidates: [], formCandidates: cands, people, nowSec: at + 60 * DAY, cfg, apoioBlocked: null, formBlocked: null });
    assert.deepEqual(r.due, [], "depois do 3º lembrete, para");
    assert.equal(r.counts.form_lembrete?.teto_lembretes, 1);
  });

  it("o teto conta os lembretes, não o convite; formReminderMax configurável", () => {
    const p = person({ sends: [{ step: "form", at: iso(T0), lot_id: "a" }, { step: "form_lembrete", at: iso(T0 + 30 * DAY), lot_id: "b" }] });
    assert.deepEqual(formStepDue(T0, T0 + 60 * DAY, p, cfg), { due: "form_lembrete" });
    assert.deepEqual(formStepDue(T0, T0 + 60 * DAY, p, { ...cfg, formReminderMax: 1 }), { due: null, motivo: "teto_lembretes" });
  });

  it("o envio confirmado grava qual convite a pessoa recebeu (o primeiro vale)", () => {
    const people: Record<string, FollowupPerson> = {};
    const lot = (kind: FollowupLot["kind"], id: string): FollowupLot => ({
      lot_id: id, kind, tag_name: `t-${id}`, tag_id: 1, broadcast_id: 9, recipient_subscription_ids: ["5"], recipient_emails: ["c@x.com"],
      status: "scheduled", created_at: iso(T0), send_at: iso(T0), last_reconciled_at: null, last_error: null,
    });
    applyFollowupLotToPeople(people, lot("form", "form-1"), iso(T0));
    applyFollowupLotToPeople(people, lot("form_lembrete", "lemb-1"), iso(T0 + 30 * DAY));
    assert.equal(people["5"].form_invite, "form");
    const invite: FollowupBaseInvite = {
      lot_id: "form_base-2026-11-08-01", tag_name: "t", tag_id: 1, broadcast_id: 2, recipient_subscription_ids: ["5", "6"], recipient_emails: ["c@x.com", "d@x.com"],
      status: "draft", created_at: iso(T0), send_at: null, confirmed_at: null, last_error: null,
    };
    assert.equal(applyBaseInviteToPeople(people, invite, iso(T0 + DAY), iso(T0 + DAY)), 2);
    assert.equal(applyBaseInviteToPeople(people, invite, iso(T0 + DAY), iso(T0 + DAY)), 0, "idempotente");
    assert.equal(people["5"].form_invite, "form", "não troca o convite já registrado");
    assert.equal(people["6"].form_invite, "form_base");
    assert.equal(formInviteOf({ ...people["6"], form_invite: undefined }), "form_base", "deriva de sends sem o campo");
    assert.equal(formInviteOf(undefined), null);
  });

  it("decideBaseInviteConfirm: só saindo/saído conta como envio; agendado é estado próprio", () => {
    const now = iso(T0);
    assert.deepEqual(decideBaseInviteConfirm({ status: "draft", send_at: null }, now), { action: "still_draft" });
    assert.deepEqual(decideBaseInviteConfirm({ status: "scheduled", send_at: "2026-11-10T09:00:00Z" }, now), { action: "scheduled", sendAt: "2026-11-10T09:00:00Z" }, "agendado não é envio: o editor pode desagendar");
    assert.equal(decideBaseInviteConfirm({ status: "aborted" }, now).action, "unknown");
    assert.equal(decideBaseInviteConfirm({ status: "scheduled", send_at: null }, now).action, "unknown");
    assert.deepEqual(decideBaseInviteConfirm({ status: "completed" }, now), { action: "sent", sendAt: now });
    assert.equal(decideBaseInviteConfirm({}, now).action, "unknown");
  });
});

describe("regra B: público do e-mail da base", () => {
  const anchorFor = (startInDays: number) => iso(T0 + startInDays * DAY - cfg.formFirstDays * DAY);
  const subs = (n: number) => Array.from({ length: n }, (_, i) => ({ kit_subscriber_id: i + 1, email: `p${i + 1}@x.com` }));

  it("exclui quem recebeu o D+6, quem vai recebê-lo em até 7 dias e quem respondeu o formulário novo", () => {
    const entries = [
      entry(2, "p2@x.com", anchorFor(5)), // D+6 daqui a 5 dias: em breve
      entry(3, "p3@x.com", anchorFor(-2)), // dentro da janela, ainda não enviado: em breve
      entry(4, "p4@x.com", anchorFor(-30)), // janela fechou sem envio (base travada): RECEBE
      entry(9, "p9@x.com", null, T0 - 2 * DAY), // cadastro recente sem confirmação: em breve
      entry(10, "p10@x.com", null, T0 - 300 * DAY), // sem âncora e antigo: RECEBE
    ];
    const people: Record<string, FollowupPerson> = {
      "1": person({ kit_subscriber_id: 1, email: "p1@x.com", sends: [{ step: "form", at: iso(T0 - 40 * DAY), lot_id: "f" }] }),
      "5": person({ kit_subscriber_id: 5, email: "p5@x.com", form_filled_at: iso(T0 - DAY) }),
      "7": person({ kit_subscriber_id: 7, email: "p7@x.com", sends: [{ step: "form_base", at: iso(T0 - DAY), lot_id: "b" }] }),
      "11": person({ kit_subscriber_id: 11, email: "p11@x.com", previous_emails: ["antigo11@x.com"] }),
    };
    const r = selectBaseInviteAudience({
      subscribers: [...subs(11), { kit_subscriber_id: 4, email: "p4@x.com" }],
      entries,
      people,
      lots: {},
      responseEmails: new Set(["P6@x.com", "antigo11@x.com"]),
      excludedEmails: new Set(["p8@x.com"]),
      nowSec: T0,
      cfg,
    });
    assert.deepEqual(r.recipients.map((x) => x.kit_subscriber_id), [4, 10], "só a base sem convite, sem resposta e fora da janela do D+6");
    assert.equal(r.excluded.ja_recebeu_formulario, 1);
    assert.equal(r.excluded.formulario_em_breve, 3);
    assert.equal(r.excluded.respondeu, 3, "form_filled_at, resposta no Worker (caixa), e-mail anterior");
    assert.equal(r.excluded.ja_recebeu_base, 1);
    assert.equal(r.excluded.envio_brevo, 1);
  });

  it("janela configurável: D+6 a mais de N dias não exclui; lote 'form' não cancelado exclui", () => {
    const base = { people: {}, responseEmails: new Set<string>(), nowSec: T0 };
    const far = selectBaseInviteAudience({ ...base, subscribers: subs(1), entries: [entry(1, "p1@x.com", anchorFor(5))], cfg: { ...cfg, baseInviteWindowDays: 3 } });
    assert.equal(far.recipients.length, 1);
    const lot = { lot_id: "form-1", kind: "form", status: "created", recipient_subscription_ids: ["1"] } as unknown as FollowupLot;
    const inLot = selectBaseInviteAudience({ ...base, subscribers: subs(1), entries: [], lots: { x: lot }, cfg });
    assert.equal(inLot.excluded.ja_recebeu_formulario, 1);
    const cancelled = selectBaseInviteAudience({ ...base, subscribers: subs(1), entries: [], lots: { x: { ...lot, status: "cancelled" } }, cfg });
    assert.equal(cancelled.recipients.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Script de preparo, com fakes
// ---------------------------------------------------------------------------

/** Store com uma entrada de piloto (fora do público): store vazio é recusado. */
function seededStore() {
  const s = emptyStore();
  s.entries["pilot:seed"] = { ...entry(999, "seed@x.com", null), subscription_id: "pilot:seed" };
  return s;
}

function setup(approved: boolean): { opts: BasePrepOpts; storePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "form-base-10605-"));
  const storePath = join(dir, "store.json");
  writeStore(seededStore(), storePath);
  const snippetsDir = join(dir, "snippets");
  const draft = readFileSync(join(FOLLOWUP_DRAFTS_DIR, "pesquisa-base.md"), "utf8");
  const text = approved ? draft.split("\n").filter((l) => !l.includes(PENDING_BODY_MARKER)).join("\n") : draft;
  mkdirSync(snippetsDir, { recursive: true });
  writeFileSync(join(snippetsDir, "pesquisa-base.md"), text);
  return { storePath, opts: { storePath, cfg, snippetsDir, apply: false, formLinkSecret: SECRET, nowMs: T0 * 1000, tagCheckAttempts: 1, tagCheckDelayMs: 0 } };
}

interface Fake {
  deps: BasePrepDeps;
  calls: string[];
  created: unknown[];
  sigWrites: number[];
}

interface FakeOver {
  getBroadcast?: PilotKitDeps["getBroadcast"];
  deleteBroadcast?: PilotKitDeps["deleteBroadcast"];
  createBroadcast?: PilotKitDeps["createBroadcast"];
  /** form_sig que o GET singular mostra, por id (ausente = o da listagem). */
  liveSig?: Map<number, string | null>;
}

function fakeDeps(rows: ActiveSubscriberRow[], over: FakeOver = {}): Fake {
  const calls: string[] = [];
  const created: unknown[] = [];
  const sigWrites: number[] = [];
  const tagged = new Map<number, Set<string>>();
  let tagId = 0;
  const byId = new Map(rows.map((r) => [r.kit_subscriber_id, r]));
  const kit: PilotKitDeps = {
    async findTagIdByName(name) {
      calls.push(`findTag:${name}`);
      return tagId > 0 ? tagId : null;
    },
    async createTag() {
      calls.push("createTag");
      tagId = 77;
      tagged.set(77, new Set());
      return { id: 77 };
    },
    async tagSubscriber(t, id) {
      calls.push(`tag:${id}`);
      tagged.get(t)!.add(byId.get(id)!.email);
    },
    async listTagMemberEmails(t) {
      return [...(tagged.get(t) ?? [])];
    },
    async createBroadcast(input) {
      calls.push("createBroadcast");
      created.push(input);
      if (over.createBroadcast) return over.createBroadcast(input);
      return { id: 555, status: "draft", send_at: null };
    },
    async getBroadcast(id) {
      if (over.getBroadcast) return over.getBroadcast(id);
      return { status: "draft", send_at: null, subscriber_filter: buildOnboardingLotFilter(77) };
    },
    async updateBroadcast() {
      calls.push("updateBroadcast");
      throw new Error("NUNCA agendar");
    },
    async deleteBroadcast(id) {
      calls.push("deleteBroadcast");
      if (over.deleteBroadcast) await over.deleteBroadcast(id);
    },
    async sleep() {},
    warn() {},
  };
  const deps: BasePrepDeps = {
    async listActiveSubscribers() {
      calls.push("list");
      return rows;
    },
    async listEnvioBrevoEmails() {
      return [];
    },
    async fetchFormResponses() {
      return [];
    },
    async getSubscriber(id) {
      calls.push(`get:${id}`);
      const sig = over.liveSig?.has(id) ? over.liveSig.get(id)! : byId.get(id)!.formSig;
      return { state: "active", apoioNivel: null, email: byId.get(id)!.email, formSig: sig };
    },
    async setFormSig(id, sig) {
      sigWrites.push(id);
      return { kind: "stored", value: sig };
    },
    async probeFormLink() {
      calls.push("probe");
      return { status: 200, bodyHasForm: true };
    },
    kit,
  };
  return { deps, calls, created, sigWrites };
}

async function rowsWithSigs(n: number, signed: number[]): Promise<ActiveSubscriberRow[]> {
  const out: ActiveSubscriberRow[] = [];
  for (let i = 1; i <= n; i++) {
    const email = `p${i}@x.com`;
    out.push({ kit_subscriber_id: i, email, formSig: signed.includes(i) ? await signFormEmail(email, SECRET) : null });
  }
  return out;
}

describe("onboarding-form-base-prep: assinaturas em lote", () => {
  it("dry-run conta e não escreve; --apply respeita o teto e pula quem já tem a assinatura certa", async () => {
    const { opts } = setup(false);
    const rows = await rowsWithSigs(5, [2]);
    const dry = fakeDeps(rows);
    const r0 = await runBaseSigs(opts, dry.deps);
    assert.equal(r0.mode, "dry-run");
    assert.deepEqual([r0.ja_assinados, r0.pendentes, r0.gravados], [1, 4, 0]);
    assert.deepEqual(dry.sigWrites, []);

    const f = fakeDeps(rows);
    const r1 = await runBaseSigs({ ...opts, apply: true, maxWrites: 3 }, f.deps);
    assert.deepEqual(f.sigWrites, [1, 3, 4], "teto de 3 por rodada, nunca regrava o já assinado");
    assert.deepEqual([r1.gravados, r1.restantes], [3, 1]);
  });

  it("sem segredo do link ou sem formulário configurado: recusa", async () => {
    const { opts } = setup(false);
    const f = fakeDeps(await rowsWithSigs(1, []));
    await assert.rejects(runBaseSigs({ ...opts, formLinkSecret: "curto" }, f.deps), CliExitWithMessage);
    await assert.rejects(runBaseSigs({ ...opts, cfg: resolveFollowupConfig({}) }, f.deps), CliExitWithMessage);
  });
});

describe("onboarding-form-base-prep: rascunho no Kit", () => {
  it("texto com o marcador de pendência: recusa antes de qualquer leitura do Kit", async () => {
    const { opts } = setup(false);
    const f = fakeDeps(await rowsWithSigs(2, [1, 2]));
    await assert.rejects(runBaseDraft({ ...opts, apply: true }, f.deps), /texto_pendente/);
    assert.deepEqual(f.calls, []);
  });

  it("dry-run: conta público e quem está sem assinatura, nenhuma escrita no Kit nem no store", async () => {
    const { opts, storePath } = setup(true);
    const f = fakeDeps(await rowsWithSigs(3, [1, 3]));
    const r = await runBaseDraft(opts, f.deps);
    assert.deepEqual([r.audience, r.recipients, r.excluded.sem_assinatura], [3, 2, 1]);
    assert.match(r.subject, /pesquisa nova/);
    assert.deepEqual(f.calls, ["list"]);
    assert.equal(readStore(storePath).store.followup?.base_invite, undefined);
  });

  it("--apply cria só RASCUNHO (send_at null, nunca PATCH de agendamento), grava no store e recusa a 2ª vez", async () => {
    const { opts, storePath } = setup(true);
    const f = fakeDeps(await rowsWithSigs(3, [1, 3]));
    await assert.rejects(runBaseDraft({ ...opts, apply: true }, f.deps), /sem a assinatura certa pelo GET singular.*Ids: 2 \(sem_assinatura\)/);
    assert.deepEqual(f.calls.filter((c) => !c.startsWith("get:") && c !== "list"), [], "faltando assinatura: nenhuma escrita no Kit");
    assert.equal(readStore(storePath).store.followup?.base_invite, undefined, "nem no store");

    // A listagem estava defasada (#6425): o GET singular mostra a 2 já assinada.
    const rows = await rowsWithSigs(3, [1, 3]);
    const g = fakeDeps(rows, { liveSig: new Map([[2, await signFormEmail("p2@x.com", SECRET)]]) });
    const r = await runBaseDraft({ ...opts, apply: true }, g.deps);
    assert.equal(r.status, "draft");
    assert.equal(r.broadcast_id, 555);
    assert.equal(r.confirmados_por_get, 1);
    assert.equal(r.recipients, 3);
    assert.ok(!g.calls.includes("get:1") && g.calls.includes("get:2"), "GET só de quem a listagem mostra sem");
    assert.ok(!g.calls.includes("updateBroadcast"), "nunca agenda");
    const input = g.created[0] as { send_at: unknown; public: boolean; content: string };
    assert.equal(input.send_at, null);
    assert.equal(input.public, false);
    assert.ok(input.content.includes("{{ subscriber.form_sig }}") && !input.content.includes("{{FORM_URL}}"));
    const inv = readStore(storePath).store.followup!.base_invite!;
    assert.deepEqual([inv.status, inv.broadcast_id, inv.recipient_subscription_ids], ["draft", 555, ["1", "3", "2"]]);
    assert.equal(Object.keys(readStore(storePath).store.followup!.lots).length, 0, "fora de `lots`: a releitura diária nunca apaga o rascunho");
    await assert.rejects(runBaseDraft({ ...opts, apply: true }, fakeDeps(await rowsWithSigs(3, [1, 3])).deps), /e-mail único/);
  });

  it("confirmação: rascunho segue rascunho; agendado vira 'scheduled' sem registro; desagendado volta; saindo com o filtro da tag grava form_base e libera o lembrete", async () => {
    const { opts, storePath } = setup(true);
    await runBaseDraft({ ...opts, apply: true }, fakeDeps(await rowsWithSigs(2, [1, 2])).deps);
    const block = () => readStore(storePath).store.followup!;
    const filter = buildOnboardingLotFilter(77);
    assert.equal((await confirmBaseInviteIfSent(storePath, block(), { getBroadcast: async () => ({ status: "draft", send_at: null }) }, T0 * 1000))?.decision, "still_draft");
    assert.deepEqual(block().people, {});
    const sendAt = iso(T0 + DAY);
    const sched = await confirmBaseInviteIfSent(storePath, block(), { getBroadcast: async () => ({ status: "scheduled", send_at: sendAt, subscriber_filter: filter }) }, T0 * 1000);
    assert.deepEqual([sched?.decision, sched?.marked, sched?.failed], ["scheduled", 0, false]);
    assert.equal(block().base_invite?.status, "scheduled");
    assert.deepEqual(block().people, {}, "agendado não grava por pessoa");
    const unsched = await confirmBaseInviteIfSent(storePath, block(), { getBroadcast: async () => ({ status: "draft", send_at: null }) }, T0 * 1000);
    assert.equal(unsched?.decision, "unscheduled");
    assert.equal(block().base_invite?.status, "draft");
    const out = await confirmBaseInviteIfSent(storePath, block(), { getBroadcast: async () => ({ status: "completed", send_at: sendAt, subscriber_filter: filter }) }, T0 * 1000);
    assert.deepEqual([out?.decision, out?.marked], ["sent", 2]);
    const b = block();
    assert.equal(b.base_invite?.status, "sent");
    assert.equal(b.people["1"].form_invite, "form_base");
    const cands = formBaseCandidatesFromPeople(b.people, new Set());
    const plan = planFollowup({ apoioCandidates: [], formCandidates: cands, people: b.people, nowSec: T0 + 31 * DAY, cfg, apoioBlocked: null, formBlocked: null });
    assert.deepEqual(plan.due.map((d) => d.kind), ["form_lembrete", "form_lembrete"]);
    assert.equal(await confirmBaseInviteIfSent(storePath, b, { getBroadcast: async () => ({ status: "completed" }) }, T0 * 1000), null, "já confirmado: nada a fazer");
  });

  it("readStore preserva o base_invite (outros executores não apagam o registro)", () => {
    const { storePath } = setup(true);
    const s = emptyStore();
    s.followup!.base_invite = {
      lot_id: "form_base-x-01", tag_name: "t", tag_id: 1, broadcast_id: 2, recipient_subscription_ids: [], recipient_emails: [],
      status: "draft", created_at: iso(T0), send_at: null, confirmed_at: null, last_error: null,
    };
    writeStore(s, storePath);
    const again = readStore(storePath).store;
    writeStore(again, storePath);
    assert.equal(readStore(storePath).store.followup?.base_invite?.lot_id, "form_base-x-01");
  });
});

// ---------------------------------------------------------------------------
// Review do fleet (PR #12461): falha fechada em todo ponto incerto
// ---------------------------------------------------------------------------

describe("onboarding-form-base-prep: store ausente/vazio recusa e nunca é criado", () => {
  it("arquivo ausente: recusa nos três passos, sem criar o arquivo", async () => {
    const { opts } = setup(true);
    const missing = join(mkdtempSync(join(tmpdir(), "form-base-missing-")), "store.json");
    const f = fakeDeps(await rowsWithSigs(2, [1, 2]));
    await assert.rejects(runBaseSigs({ ...opts, storePath: missing, apply: true }, f.deps), (e: Error) => e instanceof CliExitWithMessage && /não existe/.test(e.message));
    await assert.rejects(runBaseDraft({ ...opts, storePath: missing, apply: true }, f.deps), /não existe/);
    await assert.rejects(runBaseConfirm({ ...opts, storePath: missing, apply: true }, f.deps), /não existe/);
    assert.equal(existsSync(missing), false);
    assert.deepEqual(f.calls, [], "nenhuma leitura nem escrita no Kit");
  });

  it("store sem nenhuma entrada nem pessoa: recusa", async () => {
    const { opts, storePath } = setup(true);
    writeStore(emptyStore(), storePath);
    const f = fakeDeps(await rowsWithSigs(2, [1, 2]));
    await assert.rejects(runBaseDraft({ ...opts, apply: true }, f.deps), /sem nenhuma entrada/);
    assert.deepEqual(f.calls, []);
  });
});

describe("onboarding-form-base-prep: audiência do rascunho não confirmada", () => {
  const draftWith = async (over: FakeOver) => {
    const { opts, storePath } = setup(true);
    const f = fakeDeps(await rowsWithSigs(2, [1, 2]), over);
    const err = await runBaseDraft({ ...opts, apply: true }, f.deps).then(
      () => null,
      (e: Error) => e,
    );
    return { err, f, storePath, opts, inv: () => readStore(storePath).store.followup!.base_invite! };
  };

  it("filtro divergente e a exclusão FALHA: fica 'divergent' com os dois motivos; confirm e executor nunca marcam 'sent'", async () => {
    const { err, f, storePath, inv } = await draftWith({
      getBroadcast: async () => ({ status: "draft", send_at: null, subscriber_filter: buildOnboardingLotFilter(1) }),
      deleteBroadcast: async () => {
        throw new Error("Kit 503");
      },
    });
    assert.ok(err instanceof CliExitWithMessage);
    assert.ok(f.calls.includes("deleteBroadcast"));
    const i = inv();
    assert.equal(i.status, "divergent");
    assert.equal(i.broadcast_id, 555);
    assert.match(i.last_error!, /DIVERGENTE/, "motivo original preservado");
    assert.match(i.last_error!, /exclusão do broadcast 555 falhou \(Kit 503\)/, "erro do delete anexado");
    const block = readStore(storePath).store.followup!;
    const sent = { getBroadcast: async () => ({ status: "completed", send_at: iso(T0), subscriber_filter: buildOnboardingLotFilter(77) }) };
    const out = await confirmBaseInviteIfSent(storePath, block, sent, T0 * 1000);
    assert.deepEqual([out?.decision, out?.failed, out?.marked], ["refused", true, 0]);
    assert.equal(readStore(storePath).store.followup!.base_invite!.status, "divergent");
    assert.deepEqual(readStore(storePath).store.followup!.people, {});
    assert.equal(basePrepExitCode("confirm", { result: out }), 1);
    assert.ok(baseInviteRecipientIds(i).has("1"), "D+6 segue suspenso para eles");
  });

  it("filtro divergente com exclusão ok: apaga, volta a 'pending' com o motivo e sai com erro", async () => {
    const { err, inv } = await draftWith({ getBroadcast: async () => ({ status: "draft", send_at: null, subscriber_filter: buildOnboardingLotFilter(1) }) });
    assert.ok(err instanceof CliExitWithMessage);
    const i = inv();
    assert.deepEqual([i.status, i.broadcast_id], ["pending", null]);
    assert.match(i.last_error!, /apagado; nada agendado/);
  });

  const unconfirmed: [string, PilotKitDeps["getBroadcast"], RegExp][] = [
    ["não ecoado", async () => ({ status: "draft", send_at: null }), /not_echoed/],
    [
      "releitura falhando",
      async () => {
        throw new Error("timeout");
      },
      /read_failed/,
    ],
  ];
  for (const [label, getBroadcast, motivo] of unconfirmed) {
    it(`filtro ${label}: tratado como falha — apaga o rascunho e volta a 'pending'`, async () => {
      const { err, f, inv } = await draftWith({ getBroadcast });
      assert.ok(err instanceof CliExitWithMessage, "exit não-zero");
      assert.ok(f.calls.includes("deleteBroadcast"));
      const i = inv();
      assert.deepEqual([i.status, i.broadcast_id], ["pending", null]);
      assert.match(i.last_error!, motivo);
    });
  }

  it("confirm: saindo com filtro divergente ou não ecoado nunca marca 'sent'", async () => {
    for (const subscriber_filter of [buildOnboardingLotFilter(1), undefined]) {
      const { opts, storePath } = setup(true);
      await runBaseDraft({ ...opts, apply: true }, fakeDeps(await rowsWithSigs(2, [1, 2])).deps);
      const block = readStore(storePath).store.followup!;
      const out = await confirmBaseInviteIfSent(storePath, block, { getBroadcast: async () => ({ status: "sending", send_at: iso(T0), subscriber_filter }) }, T0 * 1000);
      assert.deepEqual([out?.decision, out?.failed], ["filter_unverified", true]);
      const after = readStore(storePath).store.followup!;
      assert.equal(after.base_invite?.status, "draft");
      assert.deepEqual(after.people, {});
      assert.match(after.base_invite?.last_error ?? "", /NÃO confirmada/);
    }
  });

  it("createBroadcast sem resposta: a próxima montagem recusa (o Kit pode ter criado o rascunho)", async () => {
    const { err, opts, inv } = await draftWith({
      createBroadcast: async () => {
        throw new Error("timeout");
      },
    });
    assert.match(err!.message, /timeout/);
    assert.ok(inv().create_attempted_at, "marcado antes de criar");
    await assert.rejects(runBaseDraft({ ...opts, apply: true }, fakeDeps(await rowsWithSigs(2, [1, 2])).deps), /pode ter criado um rascunho/);
  });
});

describe("onboarding-form-base-prep: assinaturas — exit e motivos", () => {
  it("falha de gravação ou campo ausente: exit 1 com o motivo por pessoa", async () => {
    const { opts } = setup(false);
    const rows = await rowsWithSigs(3, []);
    const f = fakeDeps(rows);
    f.deps.setFormSig = async (id, sig) => {
      if (id === 2) throw new Error("HTTP 401 unauthorized");
      return { kind: "stored", value: sig };
    };
    f.deps.isTransientLookupError = () => false;
    const r = await runBaseSigs({ ...opts, apply: true }, f.deps);
    assert.deepEqual([r.gravados, r.falhas], [2, 1]);
    assert.deepEqual(r.falhas_por_motivo, { assinatura_falhou: 1 });
    assert.match(r.erros[0], /^2: assinatura_falhou: HTTP 401/);
    assert.equal(basePrepExitCode("sigs", r), 1);

    const g = fakeDeps(rows);
    g.deps.setFormSig = async () => ({ kind: "absent" });
    const r2 = await runBaseSigs({ ...opts, apply: true }, g.deps);
    assert.ok(r2.campo_ausente);
    assert.equal(basePrepExitCode("sigs", r2), 1);

    const ok = await runBaseSigs({ ...opts, apply: true }, fakeDeps(rows).deps);
    assert.equal(basePrepExitCode("sigs", ok), 0);
  });

  it("espaçamento das escritas de tag fica perto de 550 ms (limite da API)", () => {
    assert.ok(BASE_TAG_SPACING_MS >= 500);
  });
});

describe("onboarding-form-base-prep: --step reset", () => {
  const drafted = async () => {
    const { opts, storePath } = setup(true);
    await runBaseDraft({ ...opts, apply: true }, fakeDeps(await rowsWithSigs(2, [1, 2])).deps);
    return { opts, storePath };
  };
  const notFound = Object.assign(new Error("404"), { notFound: true });
  const resetDeps = (getBroadcast: BasePrepDeps["getBroadcast"]): BasePrepDeps => ({
    ...fakeDeps([]).deps,
    getBroadcast,
    isNotFoundError: (e) => (e as { notFound?: boolean }).notFound === true,
  });

  it("broadcast apagado (404) ou 'aborted': volta a 'pending' e a montagem seguinte usa tag nova se alguém saiu do público", async () => {
    const gone: BasePrepDeps["getBroadcast"][] = [
      async () => {
        throw notFound;
      },
      async () => ({ status: "aborted" }),
    ];
    for (const gb of gone) {
      const { opts, storePath } = await drafted();
      const dry = await runBaseReset(opts, resetDeps(gb));
      assert.equal(dry.mode, "dry-run");
      assert.equal(readStore(storePath).store.followup!.base_invite!.status, "draft", "dry-run não escreve");
      await runBaseReset({ ...opts, apply: true }, resetDeps(gb));
      const i = readStore(storePath).store.followup!.base_invite!;
      assert.deepEqual([i.status, i.broadcast_id], ["pending", null]);
      assert.match(i.last_error!, /reset em/);
      // A pessoa 2 saiu do público: a tag antiga a tem, então a nova tentativa usa outra tag.
      const f = fakeDeps(await rowsWithSigs(1, [1]));
      await runBaseDraft({ ...opts, apply: true }, f.deps);
      const again = readStore(storePath).store.followup!.base_invite!;
      assert.equal(again.attempt, 2);
      assert.match(again.tag_name, /-t2$/);
      assert.deepEqual(again.recipient_subscription_ids, ["1"]);
    }
  });

  it("broadcast em 'draft'/'scheduled'/'completed' no Kit: recusa mesmo com --force", async () => {
    for (const status of ["draft", "scheduled", "completed"]) {
      const { opts, storePath } = await drafted();
      await assert.rejects(runBaseReset({ ...opts, apply: true, force: true }, resetDeps(async () => ({ status }))), CliExitWithMessage);
      assert.equal(readStore(storePath).store.followup!.base_invite!.status, "draft");
    }
  });

  it("releitura falhando: só com --force; convite 'sent' nunca", async () => {
    const { opts, storePath } = await drafted();
    const boom = async () => {
      throw new Error("rede");
    };
    await assert.rejects(runBaseReset({ ...opts, apply: true }, resetDeps(boom)), /--force/);
    const r = await runBaseReset({ ...opts, apply: true, force: true }, resetDeps(boom));
    assert.equal(r.forced, true);
    assert.equal(readStore(storePath).store.followup!.base_invite!.status, "pending");
    const s = readStore(storePath).store;
    s.followup!.base_invite = { ...s.followup!.base_invite!, status: "sent" };
    writeStore(s, storePath);
    await assert.rejects(runBaseReset({ ...opts, apply: true, force: true }, resetDeps(boom)), /já enviado/);
  });
});

describe("executor: D+6 suspenso enquanto o e-mail da base pode sair", () => {
  it("destinatário do e-mail da base em rascunho/agendado não recebe o D+6; depois de 'sent' só o lembrete", () => {
    const anchor = T0 - cfg.formFirstDays * DAY; // D+6 vence hoje
    const cands = [
      { kit_subscriber_id: 1, email: "p1@x.com", anchorSec: anchor },
      { kit_subscriber_id: 2, email: "p2@x.com", anchorSec: anchor },
    ];
    const invite: FollowupBaseInvite = {
      lot_id: "form_base-x-01", tag_name: "t", tag_id: 1, broadcast_id: 9, recipient_subscription_ids: ["1"], recipient_emails: ["p1@x.com"],
      status: "draft", created_at: iso(T0), send_at: null, confirmed_at: null, last_error: null,
    };
    for (const status of ["draft", "scheduled", "divergent"] as const) {
      const plan = planFollowup({
        apoioCandidates: [], formCandidates: cands, people: {}, nowSec: T0, cfg, apoioBlocked: null, formBlocked: null,
        baseInviteRecipientIds: baseInviteRecipientIds({ ...invite, status }),
      });
      assert.deepEqual(plan.due.map((d) => d.kit_subscriber_id), [2], status);
      assert.equal(plan.counts.form?.email_da_base_pendente, 1);
    }
    assert.equal(baseInviteRecipientIds({ ...invite, status: "pending", broadcast_id: null }).size, 0, "pending sem broadcast: nada pode sair");
    assert.equal(baseInviteRecipientIds({ ...invite, status: "pending", broadcast_id: null, create_attempted_at: iso(T0) }).size, 1, "createBroadcast sem resposta: pode existir");
    assert.equal(baseInviteRecipientIds({ ...invite, status: "sent" }).size, 0, "enviado: o registro por pessoa assume");
  });
});
