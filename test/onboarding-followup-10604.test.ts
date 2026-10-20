/**
 * test/onboarding-followup-10604.test.ts (#10604, #10605)
 *
 * Sequência de apoio D+30/90/180/360 e formulário D+6 + lembrete a cada 30
 * dias: cadência (janela "nunca atrasada", base atual), idempotência, filtro
 * "não apoia"/só ativo perto do envio, espaçamento mínimo entre apoio e
 * formulário, envio travado pelos textos pendentes (sem chamar o Kit), teto de
 * lote, e preservação do bloco `followup` no store pelos outros executores.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apoioStepDue,
  formStepDue,
  planFollowup,
  filterDueByLiveCheck,
  applyFollowupLotToPeople,
  applyFormResponses,
  apoioContentGate,
  formContentGate,
  renderFollowupBody,
  resolveFollowupConfig,
  evaluateFollowupHealth,
  recordFollowupRun,
  parseFollowupSnippet,
  snippetTemplate,
  formCandidatesFromEntries,
  type FollowupPerson,
  type FollowupLot,
  type FollowupSnippets,
  type FollowupRunRecord,
} from "../scripts/lib/onboarding-followup.ts";
import { runFollowupRound, initFollowupSnippets, loadFollowupSnippets, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, readStore, writeStore, mergeStoreDelta, cloneStore } from "../scripts/lib/onboarding-store.ts";
import { decideOnboardingBroadcastExclusion } from "../scripts/lib/onboarding-broadcast-exclusion.ts";
import type { OnboardingEntry } from "../scripts/lib/onboarding-store.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;
const cfg = resolveFollowupConfig({ enabled: true, form_url: "https://form.example/", form_responses_url: "https://form.example/api/respostas" });

function person(over: Partial<FollowupPerson> = {}): FollowupPerson {
  return { kit_subscriber_id: 1, email: "ana@x.com", cadastro_at: null, sends: [], ...over };
}

function okSnippet(withPlaceholder = false): string {
  return `<!--\nassunto: "Assunto"\npreview_text: "Prev"\n-->\nCorpo${withPlaceholder ? " {{FORM_URL}}" : ""}`;
}

function allApproved(): FollowupSnippets {
  return {
    apoio30: parseFollowupSnippet(okSnippet()),
    apoio90: parseFollowupSnippet(okSnippet()),
    apoio180: parseFollowupSnippet(okSnippet()),
    apoio360: parseFollowupSnippet(okSnippet()),
    form: parseFollowupSnippet(okSnippet(true)),
    form_lembrete: parseFollowupSnippet(okSnippet(true)),
  };
}

describe("#10604 cadência do pedido de apoio", () => {
  it("D+30 dentro da janela é devido; antes não", () => {
    assert.equal(apoioStepDue(T0, T0 + 29 * DAY, undefined, 10).due, null);
    assert.equal(apoioStepDue(T0, T0 + 30 * DAY, undefined, 10).due, "apoio30");
    assert.equal(apoioStepDue(T0, T0 + 39 * DAY, undefined, 10).due, "apoio30");
  });

  it("base atual: quem já passou da janela pula a etapa e nunca recebe atrasada — entra só na próxima", () => {
    const r = apoioStepDue(T0, T0 + 46 * DAY, undefined, 10);
    assert.equal(r.due, null);
    assert.deepEqual(r.vencidas, ["apoio30"]);
    assert.equal(apoioStepDue(T0, T0 + 90 * DAY, undefined, 10).due, "apoio90");
    // Cadastro há 200 dias: 30/90/180 vencidas de uma vez, nenhuma enviada.
    const old = apoioStepDue(T0, T0 + 200 * DAY, undefined, 10);
    assert.equal(old.due, null);
    assert.deepEqual(old.vencidas, ["apoio30", "apoio90", "apoio180"]);
  });

  it("idempotência: etapa já enviada (ou pulada por 'apoia') nunca volta", () => {
    const sent = person({ sends: [{ step: "apoio30", at: new Date((T0 + 30 * DAY) * 1000).toISOString(), lot_id: "l1" }] });
    assert.equal(apoioStepDue(T0, T0 + 31 * DAY, sent, 10).due, null);
    const skipped = person({ skips: [{ step: "apoio30", at: "2026-02-01T00:00:00Z", motivo: "apoia" }] });
    assert.equal(apoioStepDue(T0, T0 + 31 * DAY, skipped, 10).due, null);
  });

  it("lote confirmado aplicado 2 vezes registra o envio 1 vez só", () => {
    const people: Record<string, FollowupPerson> = {};
    const lot: FollowupLot = {
      lot_id: "apoio30-2026-01-31-01", kind: "apoio30", tag_name: "t", tag_id: 9, broadcast_id: 77,
      recipient_subscription_ids: ["5"], recipient_emails: ["b@x.com"], status: "scheduled",
      created_at: "2026-01-31T12:00:00Z", send_at: "2026-01-31T12:05:00Z", last_reconciled_at: null, last_error: null,
    };
    assert.equal(applyFollowupLotToPeople(people, lot, "2026-01-31T12:00:00Z"), 1);
    assert.equal(applyFollowupLotToPeople(people, lot, "2026-01-31T12:00:00Z"), 0);
    assert.equal(people["5"].sends.length, 1);
    assert.equal(people["5"].sends[0].at, "2026-01-31T12:05:00Z");
    // Lote não confirmado nunca registra envio.
    const failed = { ...lot, lot_id: "x", status: "cancelled" as const };
    assert.equal(applyFollowupLotToPeople({}, failed, "2026-01-31T12:00:00Z"), 0);
  });
});

describe("#10604 filtro 'não apoia' e só ativo, perto do envio", () => {
  const due = [
    { kit_subscriber_id: 1, email: "a@x.com", kind: "apoio30" as const },
    { kit_subscriber_id: 2, email: "b@x.com", kind: "apoio30" as const },
    { kit_subscriber_id: 3, email: "c@x.com", kind: "apoio30" as const },
    { kit_subscriber_id: 4, email: "d@x.com", kind: "apoio30" as const },
    { kit_subscriber_id: 5, email: "e@x.com", kind: "form" as const },
  ];
  it("apoia/não ativo/consulta falha nunca recebem pedido de apoio; formulário vale pra quem apoia", () => {
    const checks = new Map([
      [1, { state: "active", apoioNivel: "" }],
      [2, { state: "active", apoioNivel: "mantenedor" }],
      [3, { state: "cancelled", apoioNivel: "" }],
      [4, null],
      [5, { state: "active", apoioNivel: "patrono" }],
    ]);
    const r = filterDueByLiveCheck(due, checks);
    assert.deepEqual(r.send.map((d) => d.kit_subscriber_id), [1, 5]);
    assert.deepEqual(r.excluded.map((x) => [x.due.kit_subscriber_id, x.motivo]), [[2, "apoia"], [3, "nao_ativo"], [4, "consulta_falhou"]]);
  });
});

describe("#10605 cadência do formulário", () => {
  it("D+6 da confirmação; quem preencheu nunca recebe; lembrete a cada 30 dias do envio anterior, sem teto", () => {
    assert.deepEqual(formStepDue(T0, T0 + 5 * DAY, undefined, cfg), { due: null, motivo: "nao_venceu" });
    assert.deepEqual(formStepDue(T0, T0 + 6 * DAY, undefined, cfg), { due: "form" });
    assert.deepEqual(formStepDue(null, T0 + 6 * DAY, undefined, cfg), { due: null, motivo: "sem_ancora" });
    assert.deepEqual(formStepDue(T0, T0 + 20 * DAY, undefined, cfg), { due: null, motivo: "vencida" });
    assert.deepEqual(formStepDue(T0, T0 + 6 * DAY, person({ form_filled_at: "2026-01-02T00:00:00Z" }), cfg), { due: null, motivo: "preencheu" });

    const p = person();
    let at = T0 + 6 * DAY;
    for (let i = 0; i < 12; i++) {
      p.sends.push({ step: i === 0 ? "form" : "form_lembrete", at: new Date(at * 1000).toISOString(), lot_id: `l${i}` });
      assert.deepEqual(formStepDue(T0, at + 29 * DAY, p, cfg), { due: null, motivo: "nao_venceu" });
      assert.deepEqual(formStepDue(T0, at + 30 * DAY, p, cfg), { due: "form_lembrete" }, `lembrete ${i + 1} segue devido (sem teto)`);
      at += 30 * DAY;
    }
  });

  it("resposta do formulário para os lembretes na hora", () => {
    const people = { "1": person({ email: "Ana@X.com" }) };
    assert.deepEqual(applyFormResponses(people, [{ email: "ana@x.com", submitted_at: "2026-01-09T00:00:00Z", answers: { q: "v" } }, { email: "z@x.com", submitted_at: "2026-01-09T00:00:00Z" }]), { marked: 1, unmatched: 1 });
    assert.equal(formStepDue(T0, T0 + 100 * DAY, people["1"], cfg).due, null);
  });

  it("candidatos do formulário saem da escada (fora piloto e recuperação manual)", () => {
    const base: OnboardingEntry = {
      subscription_id: "123", email: "a@x.com", status_detectado: "active", created_at: T0, detected_at: "2026-01-01T00:00:00Z",
      email1_sent_at: "2026-01-01T12:00:00Z", email1_brevo_id: null, email2_sent_at: null, email2_brevo_id: null,
      email3_state: "pending", email3_campaign_id: null, email3_decided_at: null,
    };
    const r = formCandidatesFromEntries([
      base,
      { ...base, subscription_id: "pilot:x" },
      { ...base, subscription_id: "456", seeded_by: "#7665" },
      { ...base, subscription_id: "sub_abc" },
      { ...base, subscription_id: "sub_def", kit_subscriber_id: 789 },
    ]);
    assert.deepEqual(r.candidates.map((c) => c.kit_subscriber_id), [123, 789]);
    assert.equal(r.semKitId, 1);
    assert.equal(r.candidates[0].anchorSec, T0);
  });
});

describe("#10605 espaçamento mínimo entre apoio e formulário", () => {
  const base = { nowSec: T0 + 30 * DAY, cfg, apoioBlocked: null, formBlocked: null };
  it("os dois vencendo juntos: sai o de apoio, o formulário espera", () => {
    const plan = planFollowup({
      ...base,
      apoioCandidates: [{ kit_subscriber_id: 1, email: "a@x.com", cadastro_at: new Date(T0 * 1000).toISOString() }],
      formCandidates: [{ kit_subscriber_id: 1, email: "a@x.com", anchorSec: T0 + 24 * DAY }],
      people: {},
    });
    assert.deepEqual(plan.due.map((d) => d.kind), ["apoio30"]);
    assert.equal(plan.counts.form?.espacamento, 1);
  });

  it("e-mail das sequências há menos de min_gap_days: nada sai pra pessoa nesta rodada", () => {
    const p = person({ sends: [{ step: "form", at: new Date((T0 + 27 * DAY) * 1000).toISOString(), lot_id: "f" }] });
    const plan = planFollowup({
      ...base,
      apoioCandidates: [{ kit_subscriber_id: 1, email: "a@x.com", cadastro_at: new Date(T0 * 1000).toISOString() }],
      formCandidates: [],
      people: { "1": p },
    });
    assert.equal(plan.due.length, 0);
    assert.equal(plan.counts.apoio30?.espacamento, 1);
    // Na janela de 10 dias ainda dá pra sair depois do intervalo (D+34 = 7 dias depois).
    const later = planFollowup({ ...base, nowSec: T0 + 34 * DAY, apoioCandidates: [{ kit_subscriber_id: 1, email: "a@x.com", cadastro_at: new Date(T0 * 1000).toISOString() }], formCandidates: [], people: { "1": p } });
    assert.deepEqual(later.due.map((d) => d.kind), ["apoio30"]);
  });
});

describe("#10604/#10605 envio travado até os textos serem aprovados", () => {
  it("texto ausente, pendente ou incompleto bloqueia com motivo explícito; os 4 de apoio destravam juntos", () => {
    assert.equal((apoioContentGate({}) as { motivo: string }).motivo, "snippet_ausente");
    const pend = allApproved();
    pend.apoio360 = parseFollowupSnippet(snippetTemplate("apoio360"));
    assert.equal((apoioContentGate(pend) as { motivo: string }).motivo, "texto_pendente");
    assert.equal(apoioContentGate(allApproved()).blocked, false);
    const semAssunto = allApproved();
    semAssunto.apoio90 = parseFollowupSnippet(`<!--\nassunto: ""\n-->\ncorpo`);
    assert.equal((apoioContentGate(semAssunto) as { motivo: string }).motivo, "snippet_invalido");
  });

  it("formulário exige o link no corpo e o Worker configurado", () => {
    assert.equal(formContentGate(allApproved(), cfg).blocked, false);
    const semLink = allApproved();
    semLink.form = parseFollowupSnippet(okSnippet(false));
    assert.equal((formContentGate(semLink, cfg) as { motivo: string }).motivo, "snippet_invalido");
    assert.equal((formContentGate(allApproved(), resolveFollowupConfig({})) as { motivo: string }).motivo, "form_nao_configurado");
  });

  it("link do formulário leva o e-mail pré-preenchido via merge tag do Kit", () => {
    assert.equal(renderFollowupBody("Responda: {{FORM_URL}}", "https://f.example/"), "Responda: https://f.example/?email={{ subscriber.email_address | url_encode }}");
  });

  it("--init-snippets cria os 6 textos com o marcador e nunca sobrescreve", () => {
    const dir = mkdtempSync(join(tmpdir(), "followup-snip-"));
    writeFileSync(join(dir, "apoio-30.md"), "editado pelo editor");
    const created = initFollowupSnippets(dir);
    assert.equal(created.length, 5);
    assert.equal(readFileSync(join(dir, "apoio-30.md"), "utf8"), "editado pelo editor");
    const snips = loadFollowupSnippets(dir);
    assert.equal(snips.apoio90?.hasPendingMarker, true);
    assert.equal(snips.form?.hasPendingMarker, true);
  });
});

function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "followup-store-"));
  const p = join(dir, "store.json");
  writeStore(emptyStore(), p);
  return p;
}

function fakeDeps(over: Partial<FollowupRoundDeps> = {}): FollowupRoundDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listActiveSubscribers() {
      calls.push("list");
      return [];
    },
    async getSubscriber(id) {
      calls.push(`get:${id}`);
      return { state: "active", apoioNivel: "" };
    },
    async fetchFormResponses() {
      calls.push("responses");
      return [];
    },
    async runLot(lot) {
      calls.push(`lot:${lot.kind}`);
      lot.broadcast_id = 1000 + calls.length;
      lot.tag_id = 5;
      lot.status = "scheduled";
      lot.send_at = "2026-01-31T12:05:00Z";
    },
    ...over,
  };
}

describe("#10604 rodada do executor (store real em disco, Kit fingido)", () => {
  it("textos pendentes dos dois lados: nenhuma chamada ao Kit nem ao formulário; bloqueio registrado", async () => {
    const storePath = tempStore();
    const deps = fakeDeps();
    const { run } = await runFollowupRound({ storePath, send: true, cfg, snippets: {} }, deps);
    assert.deepEqual(deps.calls, []);
    assert.equal(run.apoio_blocked?.motivo, "snippet_ausente");
    assert.equal(run.form_blocked?.motivo, "snippet_ausente");
  });

  it("envia D+30 pra quem não apoia, grava por pessoa, pula quem apoia e não repete na rodada seguinte", async () => {
    const storePath = tempStore();
    const cad = new Date(T0 * 1000).toISOString();
    const nowMs = (T0 + 30 * DAY) * 1000;
    const deps = fakeDeps({
      async listActiveSubscribers() {
        return [
          { kit_subscriber_id: 1, email: "a@x.com", cadastro_at: cad },
          { kit_subscriber_id: 2, email: "b@x.com", cadastro_at: cad },
        ];
      },
      async getSubscriber(id) {
        return { state: "active", apoioNivel: id === 2 ? "apoiador" : "" };
      },
    });
    const snippets = { ...allApproved(), form: null };
    const r1 = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs }, deps);
    assert.equal(r1.run.lots_created, 1);
    assert.equal(r1.run.counts.apoio30?.enviado, 1);
    assert.equal(r1.run.counts.apoio30?.apoia, 1);
    const { store } = readStore(storePath);
    assert.deepEqual(store.followup?.people["1"].sends.map((s) => s.step), ["apoio30"]);
    assert.equal(store.followup?.people["2"].skips?.[0].motivo, "apoia");
    assert.equal(store.followup?.people["2"].sends.length, 0);
    assert.equal(Object.keys(store.followup?.lots ?? {}).length, 1);

    const r2 = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs: nowMs + DAY * 1000 }, deps);
    assert.equal(r2.run.lots_created, 0, "etapa já enviada/pulada não volta");
  });

  it("acima do teto de lote: nada sai e a rodada conta como falha", async () => {
    const storePath = tempStore();
    const cad = new Date(T0 * 1000).toISOString();
    const deps = fakeDeps({
      async listActiveSubscribers() {
        return [1, 2, 3].map((i) => ({ kit_subscriber_id: i, email: `${i}@x.com`, cadastro_at: cad }));
      },
    });
    const small = { ...cfg, maxRecipientsPerLot: 2 };
    const { run } = await runFollowupRound({ storePath, send: true, cfg: small, snippets: { ...allApproved(), form: null }, nowMs: (T0 + 30 * DAY) * 1000 }, deps);
    assert.equal(run.over_cap, 1);
    assert.equal(deps.calls.filter((c) => c.startsWith("lot:")).length, 0);
    const block = { people: {}, lots: {} };
    recordFollowupRun(block, run);
    assert.equal((block as { consecutive_failed_runs?: number }).consecutive_failed_runs, 1);
  });

  it("dry-run não grava nada no store nem cria lote", async () => {
    const storePath = tempStore();
    const before = readFileSync(storePath, "utf8");
    const cad = new Date(T0 * 1000).toISOString();
    const deps = fakeDeps({ async listActiveSubscribers() { return [{ kit_subscriber_id: 1, email: "a@x.com", cadastro_at: cad }]; } });
    await runFollowupRound({ storePath, send: false, cfg, snippets: { ...allApproved(), form: null }, nowMs: (T0 + 30 * DAY) * 1000 }, deps);
    assert.equal(readFileSync(storePath, "utf8"), before);
    assert.equal(deps.calls.filter((c) => c.startsWith("lot:")).length, 0);
  });

  it("respostas do formulário indisponíveis travam os lembretes (nunca supõe que ninguém preencheu)", async () => {
    const storePath = tempStore();
    const deps = fakeDeps({ async fetchFormResponses() { throw new Error("HTTP 500"); } });
    const { run } = await runFollowupRound({ storePath, send: true, cfg, snippets: { ...allApproved(), apoio30: null } }, deps);
    assert.equal(run.form_blocked?.motivo, "respostas_indisponiveis");
  });
});

describe("#10604 store: bloco followup sobrevive aos outros executores", () => {
  it("readStore preserva e o merge do executor Brevo não apaga", () => {
    const p = tempStore();
    const s = emptyStore();
    s.followup = { people: { "1": person() }, lots: {}, consecutive_failed_runs: 2 };
    writeStore(s, p);
    const { store } = readStore(p);
    assert.equal(store.followup?.people["1"].email, "ana@x.com");
    assert.equal(store.followup?.consecutive_failed_runs, 2);
    const baseline = cloneStore(store);
    const updated = cloneStore(store);
    updated.last_detection_cursor = 123;
    delete (updated as { followup?: unknown }).followup;
    const merged = mergeStoreDelta(cloneStore(store), baseline, updated).store;
    assert.equal(merged.followup?.people["1"].email, "ana@x.com");
    assert.ok(existsSync(p));
  });

  it("broadcasts das sequências ficam fora da ingestão de edições (leitor-v1)", () => {
    const ex = decideOnboardingBroadcastExclusion({
      storeExists: true,
      corrupted: false,
      lots: { a: { lot_id: "a", status: "scheduled", broadcast_id: 1 }, b: { lot_id: "apoio30-x", status: "scheduled", broadcast_id: 2 } },
      kitTransportEnabled: true,
      storePath: "x",
    });
    assert.deepEqual([...ex.ids].sort(), ["1", "2"]);
  });
});

describe("#10604/#10605 saúde do executor (alarme de continuidade)", () => {
  const now = new Date("2026-03-01T12:00:00Z");
  const run = (over: Partial<FollowupRunRecord> = {}): FollowupRunRecord => ({
    at: "2026-03-01T09:10:00Z", apoio_blocked: null, form_blocked: null, lots_created: 0, lots_failed: 0, over_cap: 0, lookups_failed: 0, counts: {}, ...over,
  });
  it("sem rodada / rodada parada / falhas seguidas viram stale; travado por texto é ok", () => {
    assert.equal(evaluateFollowupHealth(true, false, { people: {}, lots: {} }, now).reason, "rodada_ausente");
    assert.equal(evaluateFollowupHealth(true, false, { people: {}, lots: {}, last_run: run({ at: "2026-02-20T00:00:00Z" }) }, now).reason, "rodada_parada");
    assert.equal(evaluateFollowupHealth(true, false, { people: {}, lots: {}, last_run: run(), consecutive_failed_runs: 2 }, now).reason, "rodadas_falhando");
    const blocked = { people: {}, lots: {} };
    recordFollowupRun(blocked, run({ apoio_blocked: { motivo: "texto_pendente", detalhe: "x" }, form_blocked: { motivo: "texto_pendente", detalhe: "x" } }));
    assert.equal(evaluateFollowupHealth(true, false, blocked, now).verdict, "ok");
    assert.equal(evaluateFollowupHealth(false, false, undefined, now).verdict, "cannot-verify");
  });
});
