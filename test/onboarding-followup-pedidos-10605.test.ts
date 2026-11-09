/**
 * test/onboarding-followup-pedidos-10605.test.ts (#10605 v3, decisão do editor de 09/11/2026)
 *
 * Regra de pedidos e cadência nova dos lembretes do formulário:
 *  - `isAsk` é o ponto único do que é pedido;
 *  - lembretes do onboarding em D+19/49/79 da âncora, os da base a cada 30
 *    dias, um texto por lembrete, teto de 3;
 *  - depois do 1º mês, dois pedidos nunca a 10 dias ou menos (`ask_min_gap_days` 11);
 *  - REGRESSÃO: o pedido adiado pelo espaçamento espera e nunca é descartado
 *    pela janela de `grace_days` (puro e no executor, com o store em disco);
 *  - REGRESSÃO: confirmação tardia do cadastro (as duas âncoras se deslocam)
 *    e a regra continua valendo, sem nenhum pedido descartado.
 * Mais: tag de quem respondeu (`--tag-respondents`), `--status`, lista de
 * conversas e resposta mais recente por e-mail.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASK_RULE_STARTS_AFTER_DAYS,
  FORM_RESPONDENT_TAG,
  apoioStepDue,
  applyFormResponses,
  askContextFromEntries,
  formStepDue,
  isAsk,
  parseFollowupSnippet,
  planFollowup,
  planRespondentTagging,
  recordAskDeferrals,
  resolveFollowupConfig,
  type AskContext,
  type FollowupPerson,
  type FollowupSnippets,
  type FollowupStepKind,
} from "../scripts/lib/onboarding-followup.ts";
import { formStatusReport, runFollowupRound, runTagRespondents, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { conversaRows, parseConversaArgs, renderConversaTable } from "../scripts/onboarding-form-conversas.ts";
import { FORM_CONVERSA_SIM, type FormResponse } from "../scripts/lib/onboarding-form-contract.ts";
import { emptyStore, readStore, writeStore, type OnboardingEntry } from "../scripts/lib/onboarding-store.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const cfg = resolveFollowupConfig({ enabled: true, form_url: "https://form.example/", form_responses_url: "https://form.example/api/respostas" });

function person(over: Partial<FollowupPerson> = {}): FollowupPerson {
  return { kit_subscriber_id: 1, email: "a@x.com", cadastro_at: null, sends: [], ...over };
}

describe("#10605 v3: config e ponto único do que é pedido", () => {
  it("defaults: ask_min_gap_days 11 (no lugar do min_gap_days 7), lembretes do onboarding em 19/49/79", () => {
    assert.equal(cfg.askMinGapDays, 11);
    assert.deepEqual(cfg.formReminderDaysOnboarding, [19, 49, 79]);
    assert.equal(ASK_RULE_STARTS_AFTER_DAYS, 30);
    assert.equal("minGapDays" in cfg, false);
    const custom = resolveFollowupConfig({ ask_min_gap_days: 14, form_reminder_days_onboarding: [20, 50] });
    assert.deepEqual([custom.askMinGapDays, custom.formReminderDaysOnboarding], [14, [20, 50]]);
    assert.deepEqual(resolveFollowupConfig({ form_reminder_days_onboarding: [49, 19] }).formReminderDaysOnboarding, [19, 49, 79], "fora de ordem cai no default");
  });

  it("isAsk: apoio, convites, os 3 lembretes e o e-mail 3 da escada; edições e e-mails 1/2 não", () => {
    for (const k of ["apoio30", "apoio90", "apoio180", "apoio360", "form", "form_base", "form_lembrete", "form_lembrete2", "form_lembrete3", "email3"]) assert.ok(isAsk(k), k);
    for (const k of ["email1", "email2", "edicao", "diaria"]) assert.ok(!isAsk(k), k);
  });
});

describe("#10605 v3: lembretes do formulário", () => {
  it("convite da base: cada lembrete 30 dias depois do anterior, um texto por lembrete, até 3", () => {
    const p = person({ sends: [{ step: "form_base", at: iso(T0), lot_id: "b" }] });
    const kinds = ["form_lembrete", "form_lembrete2", "form_lembrete3"] as const;
    let at = T0;
    for (const k of kinds) {
      assert.equal(formStepDue(null, at + 29 * DAY, p, cfg).due, null);
      assert.deepEqual(formStepDue(null, at + 30 * DAY, p, cfg), { due: k });
      at += 30 * DAY;
      p.sends.push({ step: k, at: iso(at), lot_id: k });
    }
    assert.deepEqual(formStepDue(null, at + 300 * DAY, p, cfg), { due: null, motivo: "teto_lembretes" });
  });

  it("registro antigo com vários `form_lembrete` conta para o teto e escolhe o texto seguinte", () => {
    const p = person({ sends: [{ step: "form", at: iso(T0 + 6 * DAY), lot_id: "f" }, { step: "form_lembrete", at: iso(T0 + 36 * DAY), lot_id: "l1" }, { step: "form_lembrete", at: iso(T0 + 66 * DAY), lot_id: "l2" }] });
    assert.deepEqual(formStepDue(T0, T0 + 79 * DAY, p, cfg), { due: "form_lembrete3" });
  });
});

const cad = (sec: number) => [{ kit_subscriber_id: 1, email: "a@x.com", cadastro_at: iso(sec) }];
const formCand = (anchor: number | null) => [{ kit_subscriber_id: 1, email: "a@x.com", anchorSec: anchor }];

describe("#10605 v3: regra de pedidos", () => {
  it("no 1º mês não barra: lembrete do D+19 sai 9 dias depois do e-mail 3 (D+10)", () => {
    const people = { "1": person({ cadastro_at: iso(T0), sends: [{ step: "form", at: iso(T0 + 6 * DAY), lot_id: "f" }] }) };
    const askContext = new Map<number, AskContext>([[1, { anchorSec: T0, extraAskSecs: [T0 + 10 * DAY] }]]);
    const plan = planFollowup({ apoioCandidates: cad(T0), formCandidates: formCand(T0), people, nowSec: T0 + 19 * DAY, cfg, apoioBlocked: null, formBlocked: null, askContext });
    assert.deepEqual(plan.due.map((d) => d.kind), ["form_lembrete"]);
  });

  it("fecha com o D+19 diante do apoio do D+30: 11 dias, sai no dia", () => {
    const people = { "1": person({ cadastro_at: iso(T0), sends: [{ step: "form", at: iso(T0 + 6 * DAY), lot_id: "f" }, { step: "form_lembrete", at: iso(T0 + 19 * DAY), lot_id: "l" }] }) };
    const plan = planFollowup({ apoioCandidates: cad(T0), formCandidates: formCand(T0), people, nowSec: T0 + 30 * DAY, cfg, apoioBlocked: null, formBlocked: null });
    assert.deepEqual(plan.due.map((d) => d.kind), ["apoio30"]);
  });

  it("o e-mail 3 da escada conta como pedido anterior depois do 1º mês", () => {
    // Cadastro T0, e-mail 3 em T0+25: o apoio do D+30 espera até T0+36.
    const askContext = new Map<number, AskContext>([[1, { anchorSec: T0, extraAskSecs: [T0 + 25 * DAY] }]]);
    const at = (d: number) => planFollowup({ apoioCandidates: cad(T0), formCandidates: [], people: {}, nowSec: T0 + d * DAY, cfg, apoioBlocked: null, formBlocked: null, askContext });
    assert.deepEqual(at(30).due, []);
    assert.deepEqual(at(30).askDeferred.map((d) => d.kind), ["apoio30"]);
    assert.deepEqual(at(36).due.map((d) => d.kind), ["apoio30"]);
  });

  it("askContextFromEntries: âncora da escada e a hora do e-mail 3 só quando ele saiu", () => {
    const base = { kit_subscriber_id: 7, email: "a@x.com", status_detectado: "active", created_at: T0, detected_at: iso(T0), email1_sent_at: iso(T0 + 2 * DAY), email1_brevo_id: null, email2_sent_at: null, email2_brevo_id: null, email3_campaign_id: null } as const;
    const ctx = askContextFromEntries([
      { ...base, subscription_id: "7", email3_state: "campaign_created", email3_decided_at: iso(T0 + 12 * DAY) } as OnboardingEntry,
      { ...base, kit_subscriber_id: 8, subscription_id: "8", email3_state: "skipped_no_open", email3_decided_at: iso(T0 + 12 * DAY) } as OnboardingEntry,
    ]);
    assert.deepEqual(ctx.get(7), { anchorSec: T0 + 2 * DAY, extraAskSecs: [T0 + 12 * DAY] });
    assert.deepEqual(ctx.get(8)?.extraAskSecs, []);
  });
});

describe("#10605 v3 REGRESSÃO: adiamento por espaçamento nunca é descartado por grace_days", () => {
  // Lembrete da base em T0+38: o apoio do D+30 (janela [30, 40)) só pode sair em T0+49, fora da janela.
  const sends = () => [{ step: "form_base" as const, at: iso(T0 + 8 * DAY), lot_id: "b" }, { step: "form_lembrete" as const, at: iso(T0 + 38 * DAY), lot_id: "l" }];

  it("puro: sem a marca a etapa vence; com a marca de adiamento continua devida e sai depois do intervalo", () => {
    const plain = person({ cadastro_at: iso(T0), sends: sends() });
    assert.deepEqual(apoioStepDue(T0, T0 + 45 * DAY, plain, 10), { due: null, vencidas: ["apoio30"] }, "sem adiamento: vencida (nunca atrasada)");
    const plan38 = planFollowup({ apoioCandidates: cad(T0), formCandidates: [], people: { "1": plain }, nowSec: T0 + 39 * DAY, cfg, apoioBlocked: null, formBlocked: null });
    assert.deepEqual(plan38.askDeferred.map((d) => d.kind), ["apoio30"]);
    const people = { "1": plain };
    assert.equal(recordAskDeferrals(people, plan38.askDeferred, iso(T0 + 39 * DAY)), 1);
    assert.equal(recordAskDeferrals(people, plan38.askDeferred, iso(T0 + 40 * DAY)), 0, "idempotente");
    assert.equal(apoioStepDue(T0, T0 + 45 * DAY, people["1"], 10).due, "apoio30", "adiada: não vence pela janela");
    const at = (d: number) => planFollowup({ apoioCandidates: cad(T0), formCandidates: [], people, nowSec: T0 + d * DAY, cfg, apoioBlocked: null, formBlocked: null });
    assert.deepEqual(at(48).due, [], "ainda dentro dos 10 dias");
    assert.equal(at(48).counts.apoio30?.vencida, undefined);
    assert.deepEqual(at(49).due.map((d) => d.kind), ["apoio30"], "sai no 11º dia");
  });

  it("convite D+6 adiado também espera (exceção vale para o form)", () => {
    const p = person({ ask_deferred: [{ step: "form", at: iso(T0) }] });
    assert.deepEqual(formStepDue(T0, T0 + 40 * DAY, p, cfg), { due: "form" });
    assert.deepEqual(formStepDue(T0, T0 + 40 * DAY, person(), cfg), { due: null, motivo: "vencida" });
  });

  it("executor: a rodada --send grava ask_deferred e a rodada fora da janela manda o pedido", async () => {
    const dir = mkdtempSync(join(tmpdir(), "followup-pedidos-"));
    const storePath = join(dir, "store.json");
    const s = emptyStore();
    s.followup!.people["1"] = person({ cadastro_at: iso(T0), sends: sends() });
    writeStore(s, storePath);
    const ok = parseFollowupSnippet(`<!--\nassunto: "A"\n-->\nCorpo`);
    const snippets: FollowupSnippets = { apoio30: ok, apoio90: ok, apoio180: ok, apoio360: ok };
    const calls: string[] = [];
    let nowMs = 0;
    const deps: FollowupRoundDeps = {
      listActiveSubscribers: async () => cad(T0),
      getSubscriber: async () => ({ state: "active", apoioNivel: "" }),
      listEnvioBrevoEmails: async () => [],
      fetchFormResponses: async () => [],
      async runLot(lot) {
        calls.push(lot.kind);
        lot.broadcast_id = 99;
        lot.tag_id = 5;
        lot.status = "scheduled";
        lot.send_at = new Date(nowMs).toISOString();
      },
    };
    nowMs = (T0 + 39 * DAY) * 1000;
    const r1 = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs }, deps);
    assert.equal(r1.run.counts.apoio30?.espacamento, 1);
    assert.deepEqual(readStore(storePath).store.followup!.people["1"].ask_deferred?.map((d) => d.step), ["apoio30"]);
    nowMs = (T0 + 49 * DAY) * 1000;
    const r2 = await runFollowupRound({ storePath, send: true, cfg, snippets, nowMs }, deps);
    assert.equal(r2.run.counts.apoio30?.vencida, undefined);
    assert.equal(r2.run.cap_window_overflow, 0, "adiada não conta como excedente de janela");
    assert.deepEqual(calls, ["apoio30"]);
    assert.ok(readStore(storePath).store.followup!.people["1"].sends.some((x) => x.step === "apoio30"));
  });
});

/**
 * Simula as rodadas diárias (pura) de uma pessoa até `days`, aplicando os
 * envios e as marcas de adiamento como o executor faria.
 */
function simulate(cadastroSec: number, anchorSec: number, days: number): { sends: { step: FollowupStepKind | "email3"; sec: number }[]; vencidas: number } {
  const people: Record<string, FollowupPerson> = { "1": person({ cadastro_at: iso(cadastroSec) }) };
  const email3 = anchorSec + 10 * DAY;
  const out: { step: FollowupStepKind | "email3"; sec: number }[] = [];
  let vencidas = 0;
  for (let d = 0; d <= days; d++) {
    const nowSec = cadastroSec + d * DAY;
    if (nowSec >= email3 && !out.some((x) => x.step === "email3")) out.push({ step: "email3", sec: email3 });
    const askContext = new Map<number, AskContext>([[1, { anchorSec, extraAskSecs: nowSec >= email3 ? [email3] : [] }]]);
    const plan = planFollowup({ apoioCandidates: cad(cadastroSec), formCandidates: formCand(anchorSec), people, nowSec, cfg, apoioBlocked: null, formBlocked: null, askContext });
    vencidas += Object.values(plan.counts).reduce((a, c) => a + (c?.vencida ?? 0), 0);
    recordAskDeferrals(people, plan.askDeferred, iso(nowSec));
    for (const due of plan.due) {
      people["1"].sends.push({ step: due.kind, at: iso(nowSec), lot_id: `${due.kind}-${d}` });
      out.push({ step: due.kind, sec: nowSec });
    }
  }
  return { sends: out.sort((a, b) => a.sec - b.sec), vencidas };
}

/** Depois do 1º mês nenhum pedido destas sequências sai a menos de 11 dias do
 *  anterior (o e-mail 3 conta como anterior). O e-mail 3 em si sai no relógio
 *  da escada (`onboarding-state.ts`), fora desta regra: com confirmação mais
 *  de 20 dias depois do cadastro ele cai depois do 1º mês e pode ficar perto
 *  de um pedido anterior (resíduo declarado na PR #12471). */
function assertAskRule(sends: readonly { step: string; sec: number }[], firstMonthEnd: number): void {
  for (let i = 1; i < sends.length; i++) {
    if (sends[i].sec < firstMonthEnd || sends[i].step === "email3") continue;
    const gap = (sends[i].sec - sends[i - 1].sec) / DAY;
    assert.ok(gap >= 11, `${sends[i - 1].step} → ${sends[i].step}: ${gap} dias`);
  }
}

describe("#10605 v3 REGRESSÃO: confirmação tardia do cadastro (âncoras deslocadas)", () => {
  it("confirmação no mesmo dia: D+6, D+10, D+19, D+30, D+49, D+79, D+90 no calendário", () => {
    const { sends, vencidas } = simulate(T0, T0, 100);
    assert.equal(vencidas, 0);
    assert.deepEqual(sends.map((s) => [s.step, (s.sec - T0) / DAY]), [
      ["form", 6], ["email3", 10], ["form_lembrete", 19], ["apoio30", 30], ["form_lembrete2", 49], ["form_lembrete3", 79], ["apoio90", 90],
    ]);
    assertAskRule(sends, T0 + 30 * DAY);
  });

  for (const delay of [5, 15, 25]) {
    it(`confirmação ${delay} dias depois do cadastro: a regra continua valendo e nenhum pedido é descartado`, () => {
      const anchor = T0 + delay * DAY;
      const { sends, vencidas } = simulate(T0, anchor, 200);
      assert.equal(vencidas, 0, "nada descartado pela janela");
      for (const k of ["form", "apoio30", "form_lembrete", "form_lembrete2", "form_lembrete3", "apoio90", "apoio180"]) {
        assert.equal(sends.filter((s) => s.step === k).length, 1, `${k} saiu uma vez`);
      }
      assertAskRule(sends, T0 + 30 * DAY);
      const lembrete1 = sends.find((s) => s.step === "form_lembrete")!;
      assert.ok(lembrete1.sec >= anchor + 19 * DAY, "lembrete conta da confirmação, não do cadastro");
    });
  }
});

describe("#10605 v3: respostas (histórico) e tag de quem respondeu", () => {
  const resp = (email: string, at: string, answers: Record<string, string> = { uso_ia: "x" }) => ({ email, submitted_at: at, answers });

  it("applyFormResponses: vale o envio mais recente; reenvio troca as respostas sem contar como novo preenchimento", () => {
    const people = { "1": person() };
    assert.deepEqual(applyFormResponses(people, [resp("a@x.com", "2026-11-11T00:00:00Z", { v: "2" }), resp("a@x.com", "2026-11-10T00:00:00Z", { v: "1" })]), { marked: 1, unmatched: 0 });
    assert.deepEqual(people["1"].form_answers, { v: "2" });
    assert.equal(people["1"].form_filled_at, "2026-11-11T00:00:00Z");
    assert.deepEqual(applyFormResponses(people, [resp("a@x.com", "2026-11-12T00:00:00Z", { v: "3" })]), { marked: 0, unmatched: 0 });
    assert.deepEqual(people["1"].form_answers, { v: "3" });
  });

  it("planRespondentTagging: só quem falta; id do store (também por e-mail antigo); fora do store à parte", () => {
    const people = { "1": person(), "2": person({ kit_subscriber_id: 2, email: "novo@x.com", previous_emails: ["velho@x.com"] }) };
    const plan = planRespondentTagging(
      [resp("a@x.com", "2026-11-10T00:00:00Z"), resp("A@x.com", "2026-11-11T00:00:00Z"), resp("velho@x.com", "2026-11-10T00:00:00Z"), resp("ja@x.com", "2026-11-10T00:00:00Z"), resp("fora@x.com", "2026-11-10T00:00:00Z")],
      people,
      new Set(["JA@x.com"]),
    );
    assert.equal(plan.respondents, 4);
    assert.equal(plan.alreadyTagged, 1);
    assert.deepEqual(plan.toTag, [{ email: "a@x.com", kit_subscriber_id: 1 }, { email: "velho@x.com", kit_subscriber_id: 2 }]);
    assert.deepEqual(plan.unresolved, ["fora@x.com"]);
  });

  function tagDeps(over: { tagId?: number | null; tagged?: string[] } = {}) {
    const tagged = new Set(over.tagged ?? []);
    const calls: string[] = [];
    const deps = {
      calls,
      findTagId: async (name: string) => (calls.push(`find:${name}`), over.tagId === undefined ? 77 : over.tagId),
      listTaggedEmails: async () => [...tagged],
      fetchFormResponses: async () => [resp("a@x.com", "2026-11-10T00:00:00Z"), resp("fora@x.com", "2026-11-10T00:00:00Z")],
      lookupIdByEmail: async (email: string) => (email === "fora@x.com" ? 9 : null),
      tag: async (tagId: number, kitId: number) => {
        calls.push(`tag:${tagId}:${kitId}`);
        tagged.add(kitId === 1 ? "a@x.com" : "fora@x.com");
      },
    };
    return deps;
  }

  it("tag inexistente: avisa e para (exit 2), sem ler respostas nem gravar", async () => {
    const deps = tagDeps({ tagId: null });
    const out = await runTagRespondents({ "1": person() }, true, deps);
    assert.equal(out.code, 2);
    assert.equal(out.report.error, "tag_ausente");
    assert.match(String(out.report.detalhe), /não a cria/);
    assert.deepEqual(deps.calls, [`find:${FORM_RESPONDENT_TAG}`]);
  });

  it("dry-run por padrão: conta, não grava; --apply marca, relê a tag e confirma", async () => {
    const dry = tagDeps();
    const r1 = await runTagRespondents({ "1": person() }, false, dry);
    assert.equal(r1.code, 0);
    assert.equal(r1.report.a_marcar, 2);
    assert.ok(!dry.calls.some((c) => c.startsWith("tag:")));
    const real = tagDeps();
    const r2 = await runTagRespondents({ "1": person() }, true, real);
    assert.equal(r2.code, 0);
    assert.deepEqual(real.calls.filter((c) => c.startsWith("tag:")), ["tag:77:1", "tag:77:9"]);
    assert.equal(r2.report.marcados_confirmados, 2);
  });

  it("--apply com escrita que não aparece na releitura sai 1", async () => {
    const deps = tagDeps();
    deps.tag = async (tagId: number, kitId: number) => void deps.calls.push(`tag:${tagId}:${kitId}`);
    const out = await runTagRespondents({ "1": person() }, true, deps);
    assert.equal(out.code, 1);
    assert.equal(out.report.nao_confirmados, 2);
  });
});

describe("#10605 v3: --status e lista de conversas", () => {
  const R = (email: string, at: string, answers: Record<string, string>, extra: Partial<FormResponse> = {}): FormResponse => ({ email, submitted_at: at, answers, ...extra });

  it("--status: respondentes por versão e tempo em segundos e minutos", () => {
    const rep = formStatusReport([R("a@x.com", "2026-11-10T00:00:00Z", {}, { form_version: "v3", duration_s: 120 }), R("b@x.com", "2026-11-10T00:00:00Z", {}, { form_version: "v3", duration_s: 240 }), R("c@x.com", "2026-10-10T00:00:00Z", {})]);
    assert.equal(rep.respondentes, 3);
    assert.deepEqual(rep.por_versao, { v3: 2, "v1/v2": 1 });
    assert.deepEqual(rep.tempo_de_preenchimento, { respostas_com_tempo: 2, mediana_s: 120, p75_s: 240, mediana_min: 2, p75_min: 4 });
  });

  it("conversas: só quem marcou, mais recente por e-mail, filtros por trecho sem acento, relato só aqui", () => {
    const base = { uso_ia: "Já montei coisas mais elaboradas (assistentes personalizados, automações, prompts reutilizáveis)", situacao: "Tenho meu próprio negócio", area: "Outra", area_outro: "Arquitetura", motivacao: "Crescer ou melhorar meu negócio", dificuldades: "Falta tempo para aprender | Outro", dificuldades_outro: "custo", maior_gasto: "Até R$ 100", relato_falha: "inventou\nnúmeros" };
    const rows = conversaRows([
      R("a@x.com", "2026-11-09T00:00:00Z", { ...base, conversa: FORM_CONVERSA_SIM }),
      R("a@x.com", "2026-11-10T00:00:00Z", { ...base }),
      R("b@x.com", "2026-11-11T00:00:00Z", { ...base, situacao: "Estudante", conversa: FORM_CONVERSA_SIM }),
      R("c@x.com", "2026-11-12T00:00:00Z", { ...base, conversa: FORM_CONVERSA_SIM }),
    ]);
    assert.deepEqual(rows.map((r) => r.email), ["c@x.com", "b@x.com"], "a@ desmarcou no envio mais recente");
    assert.equal(rows[0].area, "Outra (Arquitetura)");
    assert.equal(rows[0].dificuldades, "Falta tempo para aprender; Outro (custo)");
    assert.deepEqual(conversaRows([R("b@x.com", "2026-11-11T00:00:00Z", { ...base, situacao: "Estudante", conversa: FORM_CONVERSA_SIM })], { situacao: "ESTUDANTE" }).length, 1);
    assert.equal(conversaRows([R("c@x.com", "2026-11-12T00:00:00Z", { ...base, conversa: FORM_CONVERSA_SIM })], { situacao: "estudante" }).length, 0);
    assert.equal(conversaRows([R("c@x.com", "2026-11-12T00:00:00Z", { ...base, conversa: FORM_CONVERSA_SIM })], { uso_ia: "automacoes" }).length, 1);
    assert.equal(conversaRows([R("c@x.com", "2026-11-12T00:00:00Z", { ...base, conversa: FORM_CONVERSA_SIM })], { desde: "2026-11-13" }).length, 0);
    assert.match(renderConversaTable(rows), /relato: {7}inventou \/ números/);
    assert.match(renderConversaTable([]), /Ninguém/);
    assert.deepEqual(parseConversaArgs(["--area", "saude", "--json"]), { filters: { area: "saude" }, json: true });
    assert.throws(() => parseConversaArgs(["--nada"]), /desconhecida/);
  });
});

describe("#10605 v3 / #12490: Worker grava histórico, versão e tempo de preenchimento", () => {
  const SECRET = "segredo-de-teste-com-32-caracteres-ou-mais";
  function memKv(seed: Record<string, string> = {}) {
    const m = new Map(Object.entries(seed));
    return {
      m,
      ns: {
        async put(k: string, v: string) {
          m.set(k, v);
        },
        async get(k: string) {
          return m.get(k) ?? null;
        },
        async list({ prefix }: { prefix: string }) {
          return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true, cursor: undefined };
        },
      },
    };
  }
  const minimal: [string, string][] = [
    ["uso_ia", "Uso pouco: só testei ou uso de vez em quando"],
    ["situacao", "Estudante"],
    ["area", "Contabilidade"],
    ["uso_recente", "Mudei a forma de fazer uma tarefa"],
    ["ferramentas", "ChatGPT"],
    ["motivacao", "Ganhar tempo nas tarefas do meu trabalho"],
    ["dificuldades", "Falta tempo para aprender"],
    ["produto_formato", "Nada disso, a newsletter já me basta"],
    ["quem_paga", "Ninguém: só uso versões gratuitas"],
    ["maior_gasto", "Até R$ 100"],
  ];

  it("dois envios da mesma pessoa: duas chaves, o anterior não é sobrescrito; /api/respostas devolve os dois e o legado", async () => {
    const { default: worker } = await import("../workers/onboarding-form/src/index.ts");
    const { signFormEmail } = await import("../scripts/lib/onboarding-form-link-sig.ts");
    const legacy = { email: "a@x.com", submitted_at: "2026-10-01T00:00:00Z", answers: { nivel_ia: "x" } };
    const kv = memKv({ "resp:a@x.com": JSON.stringify(legacy) });
    const env = { ONBOARDING_FORM: kv.ns, RESPONSES_TOKEN: "tok", ONBOARDING_FORM_LINK_SECRET: SECRET } as never;
    const sig = await signFormEmail("a@x.com", SECRET);
    const page = await (await worker.fetch(new Request(`https://f.example/?email=a@x.com&sig=${sig}`), env)).text();
    const t = /name="t" value="([^"]+)"/.exec(page)?.[1];
    assert.ok(t, "página leva a hora assinada");
    for (let i = 0; i < 2; i++) {
      const body = new URLSearchParams([["email", "a@x.com"], ["sig", sig], ["t", t!], ...minimal]);
      const res = await worker.fetch(new Request("https://f.example/enviar", { method: "POST", body }), env);
      assert.equal(res.status, 200);
      await new Promise((r) => setTimeout(r, 5));
    }
    const keys = [...kv.m.keys()].filter((k) => k.startsWith("resp:a@x.com:"));
    assert.equal(keys.length, 2, "histórico: uma chave por envio");
    assert.ok(kv.m.has("resp:a@x.com"), "legado intacto");
    const rec = JSON.parse(kv.m.get(keys[0])!);
    assert.equal(rec.form_version, "v3");
    assert.equal(typeof rec.duration_s, "number");
    assert.ok(rec.duration_s >= 0 && rec.duration_s < 60);
    // Token forjado: grava sem duration_s.
    const forged = new URLSearchParams([["email", "a@x.com"], ["sig", sig], ["t", "1.AAAA"], ...minimal]);
    await worker.fetch(new Request("https://f.example/enviar", { method: "POST", body: forged }), env);
    const all = await (await worker.fetch(new Request("https://f.example/api/respostas", { headers: { authorization: "Bearer tok" } }), env)).json() as { responses: FormResponse[] };
    assert.equal(all.responses.length, 4);
    assert.equal(all.responses.filter((r) => r.form_version === "v3" && r.duration_s == null).length, 1, "forjado sem tempo");
    assert.equal(all.responses.filter((r) => r.form_version == null).length, 1, "legado lido junto");
  });
});
