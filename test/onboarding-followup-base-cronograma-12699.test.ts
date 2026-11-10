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

  it("ask_min_gap_days (11) só adia: em 18/11 o lembrete 1 espera o 11º dia do convite e sai em 21/11", () => {
    const p = basePerson();
    const plan = (day: string) =>
      planFollowup({
        apoioCandidates: [],
        formCandidates: [{ kit_subscriber_id: 1, email: "a@x.com", anchorSec: null }],
        people: { "1": p },
        nowSec: round(day),
        cfg,
        apoioBlocked: null,
        formBlocked: null,
      });
    const d18 = plan("2026-11-18");
    assert.deepEqual(d18.due, []);
    assert.deepEqual(d18.askDeferred.map((d) => d.kind), ["form_lembrete"]);
    // 09/11 19:39 UTC + 11 dias = 20/11 19:39 UTC; a rodada seguinte é a de 21/11.
    assert.deepEqual(plan("2026-11-20").due, []);
    assert.deepEqual(plan("2026-11-21").due.map((d) => d.kind), ["form_lembrete"]);
  });
});
