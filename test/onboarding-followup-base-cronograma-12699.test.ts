/**
 * test/onboarding-followup-base-cronograma-12699.test.ts (#12699, decisão do editor de 10/11/2026)
 *
 * Cronograma dos lembretes de quem recebeu o e-mail da base (`form_base`,
 * lote `form_base-2026-11-09-01`, enviado em 09/11/2026 às 19:39 UTC):
 * D+9 (18/11, quarta), D+24 (03/12, quinta), D+64 (12/01/2027, terça),
 * contados do DIA (BRT) do envio, com o executor diário às 09:05 BRT.
 *
 * REGRESSÃO: antes, a base recebia o lembrete `form_reminder_days` (30)
 * depois do envio anterior (09/12, 08/01, 07/02). E o lembrete do convite
 * ANUAL continua em `form_reminder_days`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  baseReminderDueSec,
  brtDayStartSec,
  formAnnualStepDue,
  formStepDue,
  isAskGapExempt,
  planFollowup,
  resolveFollowupConfig,
  type FollowupPerson,
} from "../scripts/lib/onboarding-followup.ts";

const DAY = 86_400;
const sec = (iso: string) => Date.parse(iso) / 1000;
const iso = (s: number) => new Date(s * 1000).toISOString();
/** Rodada do executor (09:05 BRT = 12:05 UTC) no dia BRT `AAAA-MM-DD`. */
const round = (day: string) => sec(`${day}T12:05:00Z`);
/** Dia da semana BRT (0 = domingo). */
const weekdayBrt = (s: number) => new Date((s - 3 * 3600) * 1000).getUTCDay();

const INVITE = "2026-11-09T19:39:00.000Z";
const raw = { enabled: true, form_url: "https://form.example/", form_responses_url: "https://form.example/api/respostas" };
const cfg = resolveFollowupConfig({ ...raw, form_reminder_days_base: [9, 24, 64] });

function basePerson(over: Partial<FollowupPerson> = {}): FollowupPerson {
  return {
    kit_subscriber_id: 1,
    email: "a@x.com",
    cadastro_at: "2025-09-02T10:00:00.000Z",
    sends: [{ step: "form_base", at: INVITE, lot_id: "form_base-2026-11-09-01" }],
    form_invite: "form_base",
    ...over,
  };
}

/** Primeiro dia (rodada das 09:05 BRT) em que `formStepDue` devolve o lembrete. */
function firstDueDay(p: FollowupPerson, fromDay: string, c = cfg): { day: string; kind: string } {
  let t = round(fromDay);
  for (let i = 0; i < 200; i++, t += DAY) {
    const r = formStepDue(null, t, p, c);
    if (r.due) return { day: iso(t).slice(0, 10), kind: r.due };
  }
  throw new Error("nenhum lembrete em 200 dias");
}

describe("#12699: config form_reminder_days_base", () => {
  it("ausente = null (regra antiga); lista válida é lida; inválida avisa e cai na regra antiga", () => {
    assert.equal(resolveFollowupConfig(raw).formReminderDaysBase, null);
    assert.deepEqual(cfg.formReminderDaysBase, [9, 24, 64]);
    const warns: string[] = [];
    const bad = resolveFollowupConfig({ ...raw, form_reminder_days_base: [24, 9] }, (m) => warns.push(m));
    assert.equal(bad.formReminderDaysBase, null);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /form_reminder_days_base inválido/);
  });

  it("platform.config.json traz [9, 24, 64] e mantém form_reminder_days 30 (anual) e o onboarding em [19, 49, 79]", () => {
    const pc = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
    const real = resolveFollowupConfig(pc.onboarding.followup);
    assert.deepEqual(real.formReminderDaysBase, [9, 24, 64]);
    assert.equal(real.formReminderDays, 30);
    assert.deepEqual(real.formReminderDaysOnboarding, [19, 49, 79]);
  });
});

describe("#12699: cronograma da base a partir de 09/11/2026", () => {
  it("brtDayStartSec: 19:39 UTC de 09/11 é 16:39 BRT do mesmo dia", () => {
    assert.equal(brtDayStartSec(sec(INVITE)), sec("2026-11-09T03:00:00Z"));
    assert.equal(brtDayStartSec(sec("2026-11-10T02:59:59Z")), sec("2026-11-09T03:00:00Z"), "23:59 BRT ainda é 09/11");
  });

  it("D+9, D+24, D+64 caem em 18/11, 03/12 e 12/01/2027, na rodada das 09:05 BRT", () => {
    const p = basePerson();
    const expected = [
      { day: "2026-11-18", kind: "form_lembrete" },
      { day: "2026-12-03", kind: "form_lembrete2" },
      { day: "2027-01-12", kind: "form_lembrete3" },
    ];
    let from = "2026-11-10";
    for (const e of expected) {
      const got = firstDueDay(p, from);
      assert.deepEqual(got, e);
      p.sends.push({ step: e.kind as "form_lembrete", at: iso(round(e.day) + 600), lot_id: e.kind });
      from = e.day;
    }
    assert.deepEqual(formStepDue(null, round("2027-06-01"), p, cfg), { due: null, motivo: "teto_lembretes" });
  });

  it("os 4 envios (convite + 3 lembretes) caem em 4 dias da semana diferentes: seg, qua, qui, ter", () => {
    const p = basePerson();
    const dues = [0, 1, 2].map((n) => baseReminderDueSec(p, n, [9, 24, 64]) as number);
    const weekdays = [sec(INVITE), ...dues].map(weekdayBrt);
    assert.deepEqual(weekdays, [1, 3, 4, 2]);
    assert.equal(new Set(weekdays).size, 4);
  });

  it("conta do convite, não do lembrete anterior: lembrete 1 atrasado (21/11) não empurra o 2 para depois de 03/12", () => {
    const p = basePerson();
    p.sends.push({ step: "form_lembrete", at: iso(round("2026-11-21")), lot_id: "l1" });
    assert.deepEqual(firstDueDay(p, "2026-11-22"), { day: "2026-12-03", kind: "form_lembrete2" });
  });

  it("baseReminderDueSec: sem convite da base ou além da lista = null", () => {
    assert.equal(baseReminderDueSec(basePerson({ sends: [] }), 0, [9]), null);
    assert.equal(baseReminderDueSec(basePerson(), 3, [9, 24, 64]), null);
  });

  it("REGRESSÃO: sem a lista, a base volta à regra antiga (+30 do envio anterior)", () => {
    const legacy = resolveFollowupConfig(raw);
    assert.deepEqual(firstDueDay(basePerson(), "2026-11-10", legacy), { day: "2026-12-10", kind: "form_lembrete" });
  });
});

describe("#12699: o que NÃO muda", () => {
  it("lembrete do convite anual continua form_reminder_days (30) depois do convite", () => {
    const filled = sec("2025-11-01T12:00:00Z");
    const invite = filled + 400 * DAY;
    const p: FollowupPerson = {
      kit_subscriber_id: 2,
      email: "b@x.com",
      cadastro_at: null,
      form_filled_at: iso(filled),
      sends: [{ step: "form_anual", at: iso(invite), lot_id: "a" }],
    };
    const annualCfg = { formAnnualDays: cfg.formAnnualDays, formAnnualReminderMax: cfg.formAnnualReminderMax, formReminderDays: cfg.formReminderDays };
    assert.deepEqual(formAnnualStepDue(p, invite + 29 * DAY, annualCfg), { due: null, motivo: "nao_venceu" });
    assert.deepEqual(formAnnualStepDue(p, invite + 30 * DAY, annualCfg), { due: "form_anual_lembrete" });
  });

  it("quem recebeu o D+6 da escada segue D+19/49/79 da âncora", () => {
    const anchor = sec("2026-11-01T12:00:00Z");
    const p: FollowupPerson = { kit_subscriber_id: 3, email: "c@x.com", cadastro_at: null, sends: [{ step: "form", at: iso(anchor + 6 * DAY), lot_id: "f" }] };
    assert.equal(formStepDue(anchor, anchor + 19 * DAY - 1, p, cfg).due, null);
    assert.deepEqual(formStepDue(anchor, anchor + 19 * DAY, p, cfg), { due: "form_lembrete" });
  });
});

describe("#12699: 1º lembrete da base isento de ask_min_gap_days (decisão do editor de 11/11/2026)", () => {
  const plan = (p: FollowupPerson, day: string, c = cfg) =>
    planFollowup({
      apoioCandidates: [],
      formCandidates: [{ kit_subscriber_id: 1, email: "a@x.com", anchorSec: null }],
      people: { "1": p },
      nowSec: round(day),
      cfg: c,
      apoioBlocked: null,
      formBlocked: null,
    });

  it("REGRESSÃO: convite 09/11 19:39 UTC, pedido anterior a 9 dias (< 11): o lembrete 1 sai em 18/11, não em 21/11", () => {
    const d18 = plan(basePerson(), "2026-11-18");
    assert.deepEqual(d18.due.map((d) => d.kind), ["form_lembrete"]);
    assert.deepEqual(d18.askDeferred, []);
    assert.equal(d18.counts.form_lembrete?.espacamento, undefined);
    // Antes do D+9 continua não vencido.
    assert.deepEqual(plan(basePerson(), "2026-11-17").due, []);
  });

  it("isento mesmo com outro pedido (apoio) a 2 dias: só a regra de 11 dias é dispensada", () => {
    const p = basePerson();
    p.sends.push({ step: "apoio90", at: "2026-11-16T12:10:00.000Z", lot_id: "ap" });
    assert.deepEqual(plan(p, "2026-11-18").due.map((d) => d.kind), ["form_lembrete"]);
  });

  it("o 2º lembrete ainda respeita o mínimo: apoio em 30/11 adia o D+24 (03/12) até a rodada de 12/12", () => {
    const p = basePerson();
    p.sends.push({ step: "form_lembrete", at: iso(round("2026-11-18") + 600), lot_id: "l1" });
    p.sends.push({ step: "apoio90", at: "2026-11-30T12:10:00.000Z", lot_id: "ap" });
    const d03 = plan(p, "2026-12-03");
    assert.deepEqual(d03.due, []);
    assert.deepEqual(d03.askDeferred.map((d) => d.kind), ["form_lembrete2"]);
    assert.deepEqual(plan(p, "2026-12-10").due, []);
    // 30/11 12:10 UTC + 11 dias = 11/12 12:10 UTC: a rodada de 11/12 (12:05) ainda segura; sai em 12/12.
    assert.deepEqual(plan(p, "2026-12-11").due, []);
    assert.deepEqual(plan(p, "2026-12-12").due.map((d) => d.kind), ["form_lembrete2"]);
  });

  it("sem o cronograma da base (regra antiga) não há isenção: o lembrete segue a regra de 11 dias", () => {
    const legacy = resolveFollowupConfig(raw);
    const p = basePerson();
    // Regra antiga: lembrete em 10/12 (+30); um apoio em 05/12 adia.
    p.sends.push({ step: "apoio90", at: "2026-12-05T12:10:00.000Z", lot_id: "ap" });
    const r = plan(p, "2026-12-10", legacy);
    assert.deepEqual(r.due, []);
    assert.deepEqual(r.askDeferred.map((d) => d.kind), ["form_lembrete"]);
  });

  it("isAskGapExempt: só form_lembrete, só convite da base registrado, só com a lista configurada", () => {
    assert.equal(isAskGapExempt("form_lembrete", basePerson(), cfg), true);
    assert.equal(isAskGapExempt("form_lembrete2", basePerson(), cfg), false);
    assert.equal(isAskGapExempt("form_lembrete3", basePerson(), cfg), false);
    assert.equal(isAskGapExempt("apoio90", basePerson(), cfg), false);
    assert.equal(isAskGapExempt("form_lembrete", basePerson(), resolveFollowupConfig(raw)), false);
    const onboarding: FollowupPerson = { kit_subscriber_id: 3, email: "c@x.com", cadastro_at: null, sends: [{ step: "form", at: INVITE, lot_id: "f" }] };
    assert.equal(isAskGapExempt("form_lembrete", onboarding, cfg), false);
  });

  it("o mínimo global não muda: platform.config.json mantém ask_min_gap_days 11", () => {
    const pc = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
    assert.equal(resolveFollowupConfig(pc.onboarding.followup).askMinGapDays, 11);
  });
});
