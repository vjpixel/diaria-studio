/**
 * test/onboarding-form-history-12490.test.ts (#12490)
 *
 * Reenvio anual do formulário de perfil (decisão do editor de 09/11/2026): a
 * cada 12 meses, quem já respondeu recebe o formulário de novo. Trava:
 *
 *  - versão das perguntas em cada resposta (`FORM_VERSION`, presa à
 *    impressão digital de `FORM_QUESTIONS`: mudar pergunta sem subir a versão
 *    quebra este teste);
 *  - histórico no Worker sem sobrescrever (`hist:`), inclusive a resposta
 *    gravada antes do histórico existir; `resp:` segue a mais recente;
 *  - `applyFormResponses` passa a valer a resposta MAIS RECENTE (o prazo de
 *    12 meses conta dela), guardando a 1ª;
 *  - `formAnnualStepDue`: 365 dias da última resposta, 1 lembrete, ciclo zera
 *    ao responder de novo, quem saiu do Kit não volta;
 *  - lote anual um mês de resposta por vez ("você respondeu em {mês/ano}");
 *  - rodada do executor ponta a ponta (sem rede): convite sai, texto com o mês.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FORM_QUESTIONS,
  FORM_VERSION,
  formHistoryKey,
  formQuestionsFingerprint,
  formResponseKey,
  formVersionOf,
  parseFormResponsesPayload,
  planFormResponseWrites,
  type FormResponse,
} from "../scripts/lib/onboarding-form-contract.ts";
import {
  ALL_FOLLOWUP_STEPS,
  applyFormResponses,
  brtMonthYearLabel,
  formAnnualContentGate,
  formAnnualStepDue,
  formStepDue,
  idsInConfirmedFollowupLots,
  parseFollowupSnippet,
  pickAnnualMonthBatch,
  planFollowup,
  renderStepBody,
  resolveFollowupConfig,
  snippetFileFor,
  type FollowupLot,
  type FollowupPerson,
  type FollowupSnippets,
} from "../scripts/lib/onboarding-followup.ts";
import { summarizeAnnualResend } from "../scripts/lib/onboarding-followup-panel.ts";
import { runFollowupRound, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, readStore, writeStore } from "../scripts/lib/onboarding-store.ts";
import worker, { type Env } from "../workers/onboarding-form/src/index.ts";
import { signFormEmail } from "../scripts/lib/onboarding-form-link-sig.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-11-20T12:00:00Z") / 1000;
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const cfg = resolveFollowupConfig({ enabled: true, form_url: "https://f.example/", form_responses_url: "https://f.example/api/respostas" });
const annualCfg = { formAnnualDays: cfg.formAnnualDays, formAnnualReminderMax: cfg.formAnnualReminderMax, formReminderDays: cfg.formReminderDays };

function person(over: Partial<FollowupPerson> = {}): FollowupPerson {
  return { kit_subscriber_id: 1, email: "a@x.com", cadastro_at: null, sends: [], ...over };
}

/** Impressão digital (sha256, 16 hex) das perguntas de cada versão. */
const FINGERPRINT_BY_VERSION: Record<number, string> = {
  2: "9e5db495e2032072",
  3: "9ec3f169aa47babe", // v3 (#10605, aprovada pelo editor em 09/11/2026)
};

describe("#12490 versão das perguntas", () => {
  it("FORM_VERSION está presa às perguntas atuais (mudou pergunta? suba FORM_VERSION e registre a impressão aqui)", () => {
    const fp = createHash("sha256").update(formQuestionsFingerprint(FORM_QUESTIONS)).digest("hex").slice(0, 16);
    assert.equal(FINGERPRINT_BY_VERSION[FORM_VERSION], fp, `FORM_VERSION ${FORM_VERSION} não corresponde às perguntas atuais (impressão ${fp})`);
  });

  it("a impressão muda quando uma opção muda (o guard discrimina)", () => {
    // #12510: a union discriminada narra pelo `kind` (`"options" in q` não narra mais: a aberta tem `options?: never`).
    const changed = FORM_QUESTIONS.map((q) => (q.id === "uso_ia" && q.kind === "select" ? { ...q, options: [...q.options, "nova"] } : q));
    assert.notEqual(formQuestionsFingerprint(changed), formQuestionsFingerprint(FORM_QUESTIONS));
  });

  it("payload: form_version válida é preservada; ausente ou lixo vira legado (v2)", () => {
    const [a, b, c] = parseFormResponsesPayload({
      responses: [
        { email: "a@x.com", submitted_at: "2026-11-01T00:00:00Z", answers: {}, form_version: 3 },
        { email: "b@x.com", submitted_at: "2026-11-01T00:00:00Z", answers: {} },
        { email: "c@x.com", submitted_at: "2026-11-01T00:00:00Z", answers: {}, form_version: "3" },
      ],
    });
    assert.equal(a!.form_version, 3);
    assert.equal(b!.form_version, undefined);
    assert.equal(c!.form_version, undefined);
    assert.equal(formVersionOf(b!), 2);
  });
});

describe("#12490 histórico de respostas no Worker", () => {
  const rec = (at: string): FormResponse => ({ email: "a@x.com", submitted_at: at, answers: { nivel_ia: "x" }, form_version: FORM_VERSION });

  it("1ª resposta: hist + resp, nessa ordem (resp por último)", () => {
    const w = planFormResponseWrites(rec("2027-11-20T10:00:00.000Z"), null);
    assert.deepEqual(w.map((x) => x.key), ["hist:a@x.com:2027-11-20T10:00:00.000Z", "resp:a@x.com"]);
  });

  it("resposta anterior gravada só em resp: (antes do histórico) é preservada em hist: antes da nova", () => {
    const prev = JSON.stringify({ email: "a@x.com", submitted_at: "2026-11-20T10:00:00.000Z", answers: { nivel_ia: "velha" } });
    const w = planFormResponseWrites(rec("2027-11-21T10:00:00.000Z"), prev);
    assert.deepEqual(w.map((x) => x.key), [
      "hist:a@x.com:2026-11-20T10:00:00.000Z",
      "hist:a@x.com:2027-11-21T10:00:00.000Z",
      "resp:a@x.com",
    ]);
    assert.equal(w[0]!.value, prev, "a anterior é copiada como estava");
  });

  it("anterior ilegível ou com o mesmo instante: não duplica nem lança", () => {
    assert.equal(planFormResponseWrites(rec("2027-01-01T00:00:00.000Z"), "{lixo").length, 2);
    const same = JSON.stringify(rec("2027-01-01T00:00:00.000Z"));
    assert.equal(planFormResponseWrites(rec("2027-01-01T00:00:00.000Z"), same).length, 2);
  });

  it("Worker: POST grava versão + histórico + resp; ?historico=1 lista o histórico", async () => {
    const SECRET = "segredo-de-teste-com-32-caracteres-ou-mais";
    const kv = new Map<string, string>([[formResponseKey("a@x.com"), JSON.stringify({ email: "a@x.com", submitted_at: "2026-01-01T00:00:00.000Z", answers: {} })]]);
    const ns = {
      async put(k: string, v: string) {
        kv.set(k, v);
      },
      async get(k: string) {
        return kv.get(k) ?? null;
      },
      async list({ prefix }: { prefix: string }) {
        return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: undefined };
      },
    };
    const env = { ONBOARDING_FORM: ns as unknown as KVNamespace, RESPONSES_TOKEN: "tok", ONBOARDING_FORM_LINK_SECRET: SECRET } as Env;
    const sig = await signFormEmail("a@x.com", SECRET);
    const required = FORM_QUESTIONS.filter((q) => q.required && "options" in q).map((q) => [q.id, (q as { options: readonly string[] }).options[0]!]);
    const res = await worker.fetch(new Request("https://f.example/enviar", { method: "POST", body: new URLSearchParams([["email", "a@x.com"], ["sig", sig], ...required]) }), env);
    assert.equal(res.status, 200);
    const latest = JSON.parse(kv.get("resp:a@x.com")!) as FormResponse;
    assert.equal(latest.form_version, FORM_VERSION);
    assert.ok(kv.has(formHistoryKey("a@x.com", "2026-01-01T00:00:00.000Z")), "a resposta de antes do histórico não se perdeu");
    assert.ok(kv.has(formHistoryKey("a@x.com", latest.submitted_at)));

    const auth = { headers: { authorization: "Bearer tok" } };
    const hist = (await (await worker.fetch(new Request("https://f.example/api/respostas?historico=1", auth), env)).json()) as { responses: FormResponse[] };
    assert.equal(hist.responses.length, 2);
    const cur = (await (await worker.fetch(new Request("https://f.example/api/respostas", auth), env)).json()) as { responses: FormResponse[] };
    assert.equal(cur.responses.length, 1, "sem ?historico, a mais recente por pessoa (executor e perfil de audiência)");
  });
});

describe("#12490 applyFormResponses vale a resposta mais recente", () => {
  it("resposta nova atualiza data e respostas e guarda a 1ª; igual ou mais antiga não muda nada", () => {
    const people = { "1": person({ form_filled_at: "2026-11-20T10:00:00Z", form_answers: { q: "velha" } }) };
    assert.deepEqual(applyFormResponses(people, [{ email: "a@x.com", submitted_at: "2026-11-20T10:00:00Z", answers: { q: "outra" } }]), { marked: 0, unmatched: 0 });
    assert.deepEqual(applyFormResponses(people, [{ email: "a@x.com", submitted_at: "2026-10-01T10:00:00Z" }]), { marked: 0, unmatched: 0 });
    assert.equal(people["1"]!.form_answers!.q, "velha");
    assert.equal(people["1"]!.form_filled_at, "2026-11-20T10:00:00Z");
    // #12530: o envio mais antigo (histórico) vira a 1ª resposta, sem mexer na mais recente.
    assert.equal(people["1"]!.form_first_filled_at, "2026-10-01T10:00:00Z");
    assert.deepEqual(applyFormResponses(people, [{ email: "a@x.com", submitted_at: "2027-12-01T10:00:00Z", answers: { q: "nova" } }]), { marked: 1, unmatched: 0 });
    assert.equal(people["1"]!.form_filled_at, "2027-12-01T10:00:00Z");
    assert.equal(people["1"]!.form_first_filled_at, "2026-10-01T10:00:00Z");
    assert.equal(people["1"]!.form_answers!.q, "nova");
    // 3ª resposta: a 1ª continua a de 2026.
    applyFormResponses(people, [{ email: "a@x.com", submitted_at: "2028-12-01T10:00:00Z" }]);
    assert.equal(people["1"]!.form_first_filled_at, "2026-10-01T10:00:00Z");
  });

  it("o D+6 e o lembrete continuam parados para quem respondeu (nada do anual vaza para lá)", () => {
    const p = person({ form_filled_at: iso(T0), sends: [{ step: "form", at: iso(T0 - DAY), lot_id: "a" }] });
    assert.deepEqual(formStepDue(T0, T0 + 400 * DAY, p, cfg), { due: null, motivo: "preencheu" });
  });
});

describe("#12490 formAnnualStepDue", () => {
  const filled = T0;
  const send = (step: "form_anual" | "form_anual_lembrete", sec: number, id: string) => ({ step, at: iso(sec), lot_id: id });

  it("nunca respondeu: nada", () => {
    assert.deepEqual(formAnnualStepDue(person(), T0 + 900 * DAY, annualCfg), { due: null, motivo: "nunca_respondeu" });
  });

  it("365 dias da ÚLTIMA resposta: antes não, no dia sim", () => {
    const p = person({ form_filled_at: iso(filled) });
    assert.deepEqual(formAnnualStepDue(p, filled + 364 * DAY, annualCfg), { due: null, motivo: "nao_venceu" });
    assert.deepEqual(formAnnualStepDue(p, filled + 365 * DAY, annualCfg), { due: "form_anual" });
  });

  it("depois do convite: 1 lembrete 30 dias depois, e para no teto", () => {
    const inv = filled + 365 * DAY;
    const p = person({ form_filled_at: iso(filled), sends: [send("form_anual", inv, "a1")] });
    assert.deepEqual(formAnnualStepDue(p, inv + 29 * DAY, annualCfg), { due: null, motivo: "nao_venceu" });
    assert.deepEqual(formAnnualStepDue(p, inv + 30 * DAY, annualCfg), { due: "form_anual_lembrete" });
    p.sends.push(send("form_anual_lembrete", inv + 30 * DAY, "l1"));
    assert.deepEqual(formAnnualStepDue(p, inv + 400 * DAY, annualCfg), { due: null, motivo: "teto_lembretes" });
    assert.deepEqual(formAnnualStepDue(p, inv + 30 * DAY, { ...annualCfg, formAnnualReminderMax: 0 }), { due: null, motivo: "teto_lembretes" });
  });

  it("responder de novo zera o ciclo: o próximo convite é 365 dias depois da resposta nova", () => {
    const inv = filled + 365 * DAY;
    const again = inv + 3 * DAY;
    const p = person({ form_filled_at: iso(again), form_first_filled_at: iso(filled), sends: [send("form_anual", inv, "a1")] });
    assert.deepEqual(formAnnualStepDue(p, inv + 30 * DAY, annualCfg), { due: null, motivo: "nao_venceu" }, "sem lembrete para quem respondeu");
    assert.deepEqual(formAnnualStepDue(p, again + 365 * DAY, annualCfg), { due: "form_anual" });
  });

  it("quem saiu do Kit numa etapa do formulário não volta", () => {
    const p = person({ form_filled_at: iso(filled), skips: [{ step: "form_anual", at: iso(filled + 365 * DAY), motivo: "nao_ativo" }] });
    assert.deepEqual(formAnnualStepDue(p, filled + 800 * DAY, annualCfg), { due: null, motivo: "saiu" });
  });

  it("lote confirmado do anual não vira 'ja_em_lote' no ano seguinte", () => {
    const lot = { kind: "form_anual", broadcast_id: 1, status: "completed", recipient_subscription_ids: ["1"] } as unknown as FollowupLot;
    assert.equal(idsInConfirmedFollowupLots({ x: lot }, "form_anual").size, 0);
  });
});

describe("#12490 plano, mês do lote e texto", () => {
  it("planFollowup: o anual só entra com annualBlocked definido; travado conta, não entra", () => {
    const people = { "1": person({ form_filled_at: iso(T0) }) };
    const base = { apoioCandidates: [], formCandidates: [], people, nowSec: T0 + 366 * DAY, cfg, apoioBlocked: null, formBlocked: null };
    assert.deepEqual(planFollowup(base).due, [], "chamador antigo: não avalia");
    assert.deepEqual(planFollowup({ ...base, annualBlocked: null }).due.map((d) => d.kind), ["form_anual"]);
    const blocked = planFollowup({ ...base, annualBlocked: "texto_pendente" });
    assert.deepEqual(blocked.due, []);
    assert.equal(blocked.counts.form_anual?.bloqueado_texto_pendente, 1);
    const brevo = planFollowup({ ...base, annualBlocked: null, excludedEmails: new Set(["a@x.com"]) });
    assert.equal(brevo.counts.form_anual?.envio_brevo, 1);
  });

  it("pickAnnualMonthBatch: sai o mês mais antigo, o resto adia; outras etapas passam", () => {
    const nov = Date.parse("2026-11-15T12:00:00Z") / 1000;
    const dez = Date.parse("2026-12-02T12:00:00Z") / 1000;
    const people = {
      "1": person({ kit_subscriber_id: 1, form_filled_at: iso(dez) }),
      "2": person({ kit_subscriber_id: 2, form_filled_at: iso(nov) }),
      "3": person({ kit_subscriber_id: 3, form_filled_at: iso(nov + DAY) }),
    };
    const due = [
      { kit_subscriber_id: 1, email: "1@x", kind: "form_anual" as const },
      { kit_subscriber_id: 2, email: "2@x", kind: "form_anual" as const },
      { kit_subscriber_id: 3, email: "3@x", kind: "form_anual" as const },
      { kit_subscriber_id: 9, email: "9@x", kind: "apoio30" as const },
    ];
    const r = pickAnnualMonthBatch(due, people);
    assert.deepEqual(r.keep.map((d) => d.kit_subscriber_id), [2, 3, 9]);
    assert.deepEqual(r.deferred.map((d) => d.kit_subscriber_id), [1]);
    assert.equal(r.labels.form_anual, "novembro de 2026");
  });

  it("mês no horário de Brasília: 01/12 às 01:00 UTC ainda é novembro", () => {
    assert.equal(brtMonthYearLabel(Date.parse("2026-12-01T01:00:00Z") / 1000), "novembro de 2026");
  });

  it("renderStepBody: link assinado + mês; sem o mês com o placeholder no corpo, lança (nunca sai cru)", () => {
    const body = "Em {{RESPONDEU_EM}} você respondeu. {{FORM_URL}}";
    const out = renderStepBody("form_anual", body, { formUrl: "https://f.example/", results: null, respondeuEm: "novembro de 2026" });
    assert.ok(out.startsWith("Em novembro de 2026 você respondeu."));
    assert.ok(out.includes("https://f.example/?email={{ subscriber.email_address }}&sig={{ subscriber.form_sig }}"));
    assert.throws(() => renderStepBody("form_anual", body, { formUrl: "https://f.example/", results: null }));
  });

  it("gate do anual: textos próprios, independente do D+6; texto sem {{FORM_URL}} trava", () => {
    assert.equal(formAnnualContentGate({}).blocked, true);
    const ok = parseFollowupSnippet(`<!--\nassunto: "A"\n-->\nCorpo {{FORM_URL}}`);
    assert.deepEqual(formAnnualContentGate({ form_anual: ok, form_anual_lembrete: ok }), { blocked: false });
    const semLink = parseFollowupSnippet(`<!--\nassunto: "A"\n-->\nCorpo`);
    assert.equal(formAnnualContentGate({ form_anual: ok, form_anual_lembrete: semLink }).blocked, true);
    assert.equal(snippetFileFor("form_anual"), "formulario-anual.md");
    assert.ok(ALL_FOLLOWUP_STEPS.includes("form_anual_lembrete"));
  });

  it("painel: elegíveis, convidados e quem respondeu de novo", () => {
    const people = {
      "1": person({ kit_subscriber_id: 1, form_filled_at: iso(T0) }),
      "2": person({ kit_subscriber_id: 2, form_filled_at: iso(T0 + 370 * DAY), form_first_filled_at: iso(T0), sends: [{ step: "form_anual", at: iso(T0 + 365 * DAY), lot_id: "a" }] }),
      "3": person({ kit_subscriber_id: 3, form_filled_at: iso(T0), sends: [{ step: "form_anual", at: iso(T0 + 365 * DAY), lot_id: "a" }] }),
    };
    assert.deepEqual(summarizeAnnualResend(people, T0 + 380 * DAY, annualCfg), { elegiveis: 1, convidados: 2, responderamDeNovo: 1 });
  });
});

describe("#12490 rodada do executor (sem rede)", () => {
  const SECRET = "segredo-de-teste-com-32-caracteres-ou-mais";
  const okText = (extra = "") => parseFollowupSnippet(`<!--\nassunto: "Assunto"\n-->\nCorpo {{FORM_URL}} ${extra}`);
  const snippets: FollowupSnippets = {
    form: okText(),
    form_lembrete: okText(),
    form_lembrete2: okText(),
    form_lembrete3: okText(),
    form_anual: okText("Em {{RESPONDEU_EM}}"),
    form_anual_lembrete: okText(),
  };

  function setup(): string {
    const p = join(mkdtempSync(join(tmpdir(), "followup-12490-")), "store.json");
    const store = emptyStore();
    store.followup = {
      people: {
        "1": person({ kit_subscriber_id: 1, email: "1@x.com", form_filled_at: "2026-11-10T15:00:00.000Z" }),
        "2": person({ kit_subscriber_id: 2, email: "2@x.com", form_filled_at: "2026-12-10T15:00:00.000Z" }),
        "3": person({ kit_subscriber_id: 3, email: "3@x.com", form_filled_at: "2027-06-10T15:00:00.000Z" }),
      },
      lots: {},
    };
    writeStore(store, p);
    return p;
  }

  function deps(responses: { email: string; submitted_at: string }[] = []): FollowupRoundDeps & { bodies: string[]; recipients: string[][] } {
    const bodies: string[] = [];
    const recipients: string[][] = [];
    let seq = 0;
    return {
      bodies,
      recipients,
      async listActiveSubscribers() {
        return [];
      },
      async getSubscriber() {
        return { state: "active", apoioNivel: "" };
      },
      async listEnvioBrevoEmails() {
        return [];
      },
      async setFormSig(_id: number, sig: string) {
        return { kind: "stored" as const, value: sig };
      },
      async probeFormLink() {
        return { status: 200, bodyHasForm: true };
      },
      async fetchFormResponses() {
        return responses;
      },
      async runLot(lot, content) {
        bodies.push(content.body);
        recipients.push([...lot.recipient_subscription_ids]);
        lot.broadcast_id = 9000 + ++seq;
        lot.tag_id = 5;
        lot.status = "scheduled";
        lot.send_at = lot.created_at;
      },
    };
  }

  it("dia 1: sai o convite de novembro; dezembro adia; quem respondeu em junho não é devido", async () => {
    const storePath = setup();
    const d = deps();
    const now = Date.parse("2027-12-20T12:00:00Z");
    const r = await runFollowupRound({ storePath, formLinkSecret: SECRET, send: true, cfg, snippets, nowMs: now }, d);
    assert.equal(r.run.form_annual_blocked, null);
    assert.deepEqual(d.recipients, [["1"]]);
    assert.ok(d.bodies[0]!.includes("Em novembro de 2026"), d.bodies[0]);
    assert.ok(!d.bodies[0]!.includes("{{RESPONDEU_EM}}") && !d.bodies[0]!.includes("{{FORM_URL}}"), "nenhum placeholder nosso cru");
    assert.equal(r.run.counts.form_anual?.adiado_mes, 1);
    // dia 2: dezembro sai.
    const r2 = await runFollowupRound({ storePath, formLinkSecret: SECRET, send: true, cfg, snippets, nowMs: now + DAY * 1000 }, d);
    assert.deepEqual(d.recipients[1], ["2"]);
    assert.ok(d.bodies[1]!.includes("Em dezembro de 2026"));
    assert.equal(r2.run.counts.form_anual?.adiado_mes, undefined);
    const people = readStore(storePath).store.followup!.people;
    assert.equal(people["1"]!.sends.filter((s) => s.step === "form_anual").length, 1);
  });

  it("textos do anual pendentes: o anual trava e o resto do formulário segue", async () => {
    const storePath = setup();
    const d = deps();
    const pending = { ...snippets, form_anual: null };
    const r = await runFollowupRound({ storePath, formLinkSecret: SECRET, send: true, cfg, snippets: pending, nowMs: Date.parse("2027-12-20T12:00:00Z") }, d);
    assert.equal(r.run.form_blocked, null);
    assert.equal(r.run.form_annual_blocked?.motivo, "snippet_ausente");
    assert.deepEqual(d.recipients, []);
  });

  it("resposta nova vinda do Worker tira a pessoa do convite (prazo recomeça)", async () => {
    const storePath = setup();
    const d = deps([{ email: "1@x.com", submitted_at: "2027-12-01T10:00:00.000Z" }]);
    await runFollowupRound({ storePath, formLinkSecret: SECRET, send: true, cfg, snippets, nowMs: Date.parse("2027-12-20T12:00:00Z") }, d);
    assert.deepEqual(d.recipients, [["2"]], "1 respondeu de novo em dez/2027; sai o 2 (dez/2026)");
    const p1 = readStore(storePath).store.followup!.people["1"]!;
    assert.equal(p1.form_filled_at, "2027-12-01T10:00:00.000Z");
    assert.equal(p1.form_first_filled_at, "2026-11-10T15:00:00.000Z");
  });
});
