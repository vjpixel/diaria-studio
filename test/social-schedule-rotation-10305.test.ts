/**
 * #10305 — teste rotativo dos horários das redes.
 *
 * Trava: (1) a lógica pura (`scripts/lib/social-schedule-rotation.ts`) cobre
 * cada horário × tipo de post exatamente uma vez por ciclo, é determinística e
 * respeita janela/fim de semana; (2) `computeScheduledAt` aplica a rotação
 * igual nos 5 canais, sem tocar no slot explícito nem no artigo especial;
 * (3) o carrossel semanal e o artigo de segunda do LinkedIn giram semana a
 * semana; (4) o `platform.config.json` REAL liga o teste com cobertura
 * completa dentro da janela 07:00–21:00 do método de 15/10.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  ROTATION_POST_TYPES,
  baseTimesFromSocial,
  buildRotationPlan,
  civilDayNumber,
  civilFromDayNumber,
  civilWeekday,
  countWeekdaysBetween,
  linkedinArticleRotationSlot,
  parseIsoCivilDate,
  publishDateForEdition,
  readSocialRotation,
  resolveDailyPostTime,
  resolveLinkedinArticleTime,
  weekdayCoverage,
  weekdayRotationSlot,
  weekendRotationSlot,
} from "../scripts/lib/social-schedule-rotation.ts";
import { computeScheduledAt } from "../scripts/compute-social-schedule.ts";
import { resolveArtigoEspecialScheduledAts } from "../scripts/lib/artigo-especial-schedule.ts";
import { DEFAULT_WEEKLY_TIME, resolveWeeklyTime } from "../scripts/publish-weekly-social.ts";
import { newRowsToRecord, parseCliDate, resolveCliPlanDate } from "../scripts/social-schedule-rotation.ts";
import {
  dailyRotationRowsForEdition,
  editionForPublishDate,
  filterUseMelhorRowsByPublished,
  recordDailyRotationFailSoft,
  recordRotationRows,
  useMelhorScheduledIn,
} from "../scripts/lib/social-schedule-rotation-record.ts";
import { describeUseMelhorPostStatus, useMelhorPostConfigState } from "../scripts/lib/use-melhor-post.ts";

process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";

const WEEKDAY = ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"];
const WEEKEND = ["08:00", "11:00", "15:00", "19:00"];
const ARTICLE = ["07:30", "09:30", "12:30", "18:30"];

const ROTATION = {
  enabled: true,
  start_date: "2026-10-20",
  end_date: "2026-11-20",
  weekday_candidates: WEEKDAY,
  weekend_candidates: WEEKEND,
  linkedin_weekly_article_candidates: ARTICLE,
};

const social = (rotation: unknown = ROTATION) => ({
  timezone: "America/Sao_Paulo",
  fallback_schedule: { d1_time: "09:45", d2_time: "12:15", d3_time: "17:15", day_offset: 0 },
  use_melhor_time: "07:45",
  linkedin_weekly_article_time: "09:30",
  rotation,
});
const config = (rotation: unknown = ROTATION) => ({ publishing: { social: social(rotation) } });

const rot = readSocialRotation(social())!;
const d = (s: string) => parseIsoCivilDate(s);
// 2027 inteiro no futuro — o past-slot guard nunca interfere.
const FAR_PAST_NOW = Date.parse("2026-01-01T00:00:00Z");

describe("readSocialRotation (#10305)", () => {
  it("desligada sem bloco, com enabled !== true", () => {
    assert.equal(readSocialRotation({}), null);
    assert.equal(readSocialRotation(undefined), null);
    assert.equal(readSocialRotation(social({ ...ROTATION, enabled: false })), null);
    assert.equal(readSocialRotation(social({ ...ROTATION, enabled: "true" })), null);
  });
  it("ligada e malformada LANÇA (horário inválido, <4 candidatos, repetido, fim antes do início, sem start)", () => {
    assert.throws(() => readSocialRotation(social({ ...ROTATION, weekday_candidates: ["7:00", ...WEEKDAY.slice(1)] })), /inválido/);
    assert.throws(() => readSocialRotation(social({ ...ROTATION, weekday_candidates: WEEKDAY.slice(0, 3) })), /mínimo 4/);
    assert.throws(() => readSocialRotation(social({ ...ROTATION, weekend_candidates: ["11:00", "11:00"] })), /repetido/);
    assert.throws(() => readSocialRotation(social({ ...ROTATION, end_date: "2026-10-01" })), /antes de start_date/);
    assert.throws(() => readSocialRotation(social({ ...ROTATION, start_date: undefined })), /start_date ausente/);
    assert.throws(() => readSocialRotation(social({ ...ROTATION, start_date: "2026-02-31" })), /não existe/);
  });
  it("candidatos do artigo são opcionais (vazio = artigo fora da rotação)", () => {
    const r = readSocialRotation(social({ ...ROTATION, linkedin_weekly_article_candidates: undefined }))!;
    assert.deepEqual(r.article, []);
    assert.equal(linkedinArticleRotationSlot(r, d("2026-10-26")), null);
  });
});

describe("countWeekdaysBetween — confere com força bruta", () => {
  it("bate com a contagem dia a dia em vários intervalos", () => {
    const start = d("2026-10-17");
    for (let len = 0; len < 60; len++) {
      const to = civilFromDayNumber(civilDayNumber(start) + len);
      let brute = 0;
      for (let n = civilDayNumber(start); n < civilDayNumber(to); n++) {
        const wd = civilWeekday(civilFromDayNumber(n));
        if (wd !== 0 && wd !== 6) brute++;
      }
      assert.equal(countWeekdaysBetween(start, to), brute, `len=${len}`);
    }
  });
});

describe("dia útil — rotação horário × tipo", () => {
  it("1º dia (ter 2026-10-20): um/d1/d2/d3 em 4 candidatos distintos, espaçados N/4", () => {
    const times = ROTATION_POST_TYPES.map((t) => weekdayRotationSlot(rot, d("2026-10-20"), t)!.time);
    assert.deepEqual(times, ["07:00", "11:00", "15:00", "19:00"]);
  });
  it("todo dia útil da janela tem os 4 posts em horários distintos", () => {
    for (let n = civilDayNumber(rot.start); n <= civilDayNumber(rot.end!); n++) {
      const day = civilFromDayNumber(n);
      const wd = civilWeekday(day);
      if (wd === 0 || wd === 6) continue;
      const times = ROTATION_POST_TYPES.map((t) => weekdayRotationSlot(rot, day, t)!.time);
      assert.equal(new Set(times).size, 4, `${n}: ${times}`);
    }
  });
  it("em N dias úteis seguidos cada (horário × tipo) recebe exatamente 1 post — o critério do método de 15/10", () => {
    const counts = new Map<string, number>();
    let seen = 0;
    for (let n = civilDayNumber(rot.start); seen < WEEKDAY.length; n++) {
      const day = civilFromDayNumber(n);
      const wd = civilWeekday(day);
      if (wd === 0 || wd === 6) continue;
      seen++;
      for (const t of ROTATION_POST_TYPES) {
        const k = `${weekdayRotationSlot(rot, day, t)!.time}|${t}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    assert.equal(counts.size, WEEKDAY.length * ROTATION_POST_TYPES.length);
    for (const [k, c] of counts) assert.equal(c, 1, k);
  });
  it("sábado/domingo, antes do início e depois do fim → null (horário fixo)", () => {
    assert.equal(weekdayRotationSlot(rot, d("2026-10-24"), "d1"), null);
    assert.equal(weekdayRotationSlot(rot, d("2026-10-25"), "d1"), null);
    assert.equal(weekdayRotationSlot(rot, d("2026-10-19"), "d1"), null);
    assert.equal(weekdayRotationSlot(rot, d("2026-11-23"), "d1"), null);
    assert.ok(weekdayRotationSlot(rot, d("2026-11-20"), "d1"), "end_date é inclusivo");
    assert.equal(weekdayRotationSlot(null, d("2026-10-20"), "d1"), null);
  });
  it("determinística: mesma data, mesmo horário (não depende de now nem do fuso do runner)", () => {
    const a = weekdayRotationSlot(rot, d("2026-11-04"), "d2");
    const b = weekdayRotationSlot(readSocialRotation(social())!, d("2026-11-04"), "d2");
    assert.deepEqual(a, b);
  });
});

describe("fim de semana e artigo de segunda — semana a semana", () => {
  it("sábado e domingo da mesma semana caem em horários diferentes", () => {
    for (let w = 0; w < 4; w++) {
      const sat = civilFromDayNumber(civilDayNumber(d("2026-10-24")) + 7 * w);
      const sun = civilFromDayNumber(civilDayNumber(sat) + 1);
      assert.notEqual(weekendRotationSlot(rot, sat)!.time, weekendRotationSlot(rot, sun)!.time);
    }
  });
  it("em M semanas cada dia do fim de semana passa por todos os M candidatos", () => {
    const sats = new Set<string>();
    const suns = new Set<string>();
    for (let w = 0; w < WEEKEND.length; w++) {
      const sat = civilFromDayNumber(civilDayNumber(d("2026-10-24")) + 7 * w);
      sats.add(weekendRotationSlot(rot, sat)!.time);
      suns.add(weekendRotationSlot(rot, civilFromDayNumber(civilDayNumber(sat) + 1))!.time);
    }
    assert.deepEqual([...sats].sort(), [...WEEKEND].sort());
    assert.deepEqual([...suns].sort(), [...WEEKEND].sort());
  });
  it("dia útil → null no slot de fim de semana", () => {
    assert.equal(weekendRotationSlot(rot, d("2026-10-21")), null);
  });
  it("artigo de segunda: só segunda, gira entre os candidatos; fora da janela usa linkedin_weekly_article_time", () => {
    assert.equal(linkedinArticleRotationSlot(rot, d("2026-10-27")), null, "terça não é dia de artigo");
    const mondays = ["2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"].map((s) => linkedinArticleRotationSlot(rot, d(s))!.time);
    assert.deepEqual([...mondays].sort(), [...ARTICLE].sort());
    assert.deepEqual(resolveLinkedinArticleTime(social(), d("2026-10-19")), { time: "09:30", source: "base" });
    assert.deepEqual(resolveLinkedinArticleTime({ ...social(), linkedin_weekly_article_time: "10:15", rotation: undefined }, d("2026-10-26")), {
      time: "10:15",
      source: "base",
    });
  });
  it("resolveWeeklyTime: --time vence; sábado/domingo seguem a rotação; fora dela, DEFAULT_WEEKLY_TIME", () => {
    assert.equal(resolveWeeklyTime({ explicitTime: "10:00", social: social(), saturday: "261024", dayOffset: 0 }), "10:00");
    assert.equal(resolveWeeklyTime({ social: social(), saturday: "261024", dayOffset: 0 }), weekendRotationSlot(rot, d("2026-10-24"))!.time);
    // modo "clicked" sai no domingo (dayOffset 1) → candidato do domingo, não do sábado.
    assert.equal(resolveWeeklyTime({ social: social(), saturday: "261024", dayOffset: 1 }), weekendRotationSlot(rot, d("2026-10-25"))!.time);
    assert.equal(resolveWeeklyTime({ social: social(), saturday: "261017", dayOffset: 0 }), DEFAULT_WEEKLY_TIME);
    assert.equal(resolveWeeklyTime({ social: social({ ...ROTATION, enabled: false }), saturday: "261024", dayOffset: 0 }), DEFAULT_WEEKLY_TIME);
  });
});

describe("computeScheduledAt com rotação (#10305)", () => {
  const PLATFORMS = ["linkedin", "facebook", "instagram", "threads", "twitter"] as const;
  it("mesmo horário nos 5 canais, por tipo de post", () => {
    for (const destaque of ROTATION_POST_TYPES) {
      const expected = weekdayRotationSlot(rot, d("2026-10-21"), destaque)!.time;
      for (const platform of PLATFORMS) {
        const iso = computeScheduledAt({ config: config(), editionDate: "261021", destaque, platform, now: FAR_PAST_NOW });
        assert.equal(iso, `2026-10-21T${expected}:00-03:00`, `${platform}/${destaque}`);
      }
    }
  });
  it("fora da janela / desligada / applyRotation:false → horário fixo do config", () => {
    const base = (cfg: unknown, edition: string, extra: object = {}) =>
      computeScheduledAt({ config: cfg as never, editionDate: edition, destaque: "d1", platform: "linkedin", now: FAR_PAST_NOW, ...extra });
    assert.equal(base(config(), "261019"), "2026-10-19T09:45:00-03:00");
    assert.equal(base(config({ ...ROTATION, enabled: false }), "261021"), "2026-10-21T09:45:00-03:00");
    assert.equal(base(config(), "261021", { applyRotation: false }), "2026-10-21T09:45:00-03:00");
  });
  it("day_offset: a rotação usa a data de PUBLICAÇÃO (edição + offset)", () => {
    const iso = computeScheduledAt({ config: config(), editionDate: "261020", destaque: "d1", platform: "facebook", dayOffsetOverride: 1, now: FAR_PAST_NOW });
    assert.equal(iso, `2026-10-21T${weekdayRotationSlot(rot, d("2026-10-21"), "d1")!.time}:00-03:00`);
  });
  it("4º post sem use_melhor_time continua desligado (lança), mesmo com rotação ligada", () => {
    const cfg = config();
    (cfg.publishing.social as Record<string, unknown>).use_melhor_time = null;
    assert.throws(() => computeScheduledAt({ config: cfg, editionDate: "261021", destaque: "um", platform: "linkedin", now: FAR_PAST_NOW }), /time inválido/);
  });
  it("artigo especial NÃO gira com a diária (horário próprio 09:00/09:30)", () => {
    const now = Date.parse("2026-10-20T12:00:00-03:00");
    const r = resolveArtigoEspecialScheduledAts(config() as never, { now, baseDate: "2026-10-20" });
    assert.equal(r.pagina, "2026-10-21T09:00:00-03:00");
    assert.equal(r.perfil, "2026-10-22T09:30:00-03:00");
  });
});

describe("plano consultável e registro (#10305)", () => {
  it("buildRotationPlan: base fora da janela, rotação dentro, cobertura uniforme", () => {
    const rows = buildRotationPlan(rot, baseTimesFromSocial(social()), d("2026-10-19"), d("2026-11-23"));
    const before = rows.filter((r) => r.date === "2026-10-19");
    assert.ok(before.every((r) => r.source === "base"));
    assert.deepEqual(
      before.filter((r) => r.kind === "weekday").map((r) => r.time),
      ["07:45", "09:45", "12:15", "17:15"],
    );
    const cov = weekdayCoverage(rot, rows);
    for (const [time, byType] of Object.entries(cov)) {
      for (const t of ROTATION_POST_TYPES) assert.equal(byType[t], 3, `${time}/${t}`);
    }
  });
  it("newRowsToRecord é idempotente e ignora linha corrompida", () => {
    const rows = buildRotationPlan(rot, baseTimesFromSocial(social()), d("2026-10-20"), d("2026-10-20"));
    assert.equal(newRowsToRecord("", rows).length, 4);
    const existing = rows.slice(0, 2).map((r) => JSON.stringify(r)).join("\n") + "\n{quebrado\n";
    assert.equal(newRowsToRecord(existing, rows).length, 2);
  });
  it("parseCliDate aceita AAMMDD e AAAA-MM-DD", () => {
    assert.deepEqual(parseCliDate("261020"), parseCliDate("2026-10-20"));
  });
});

describe("platform.config.json REAL (#10305)", () => {
  const real = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "platform.config.json"), "utf8"));
  const realSocial = real.publishing.social;
  const realRot = readSocialRotation(realSocial);

  it("teste ligado por config explícita", () => {
    assert.equal(realSocial.rotation?.enabled, true);
    assert.ok(realRot);
  });
  it("candidatos de dia útil dentro da janela 07:00–21:00 do método de 15/10", () => {
    for (const t of realRot!.weekday) assert.ok(t >= "07:00" && t <= "21:00", t);
  });
  it("a janela cobre cada horário × tipo pelo menos 1 vez (e uniformemente)", () => {
    const rows = buildRotationPlan(realRot, baseTimesFromSocial(realSocial), realRot!.start, realRot!.end!);
    const cov = weekdayCoverage(realRot!, rows);
    const values = Object.values(cov).flatMap((c) => ROTATION_POST_TYPES.map((t) => c[t]));
    assert.ok(Math.min(...values) >= 1, JSON.stringify(cov));
    assert.equal(Math.min(...values), Math.max(...values), "janela = nº inteiro de ciclos (sem viés por célula)");
  });
  it("a janela cobre ≥4 semanas, todos os candidatos de fim de semana e de artigo", () => {
    assert.ok(civilDayNumber(realRot!.end!) - civilDayNumber(realRot!.start) >= 27);
    const rows = buildRotationPlan(realRot, baseTimesFromSocial(realSocial), realRot!.start, realRot!.end!);
    for (const day of ["sabado", "domingo"] as const) {
      const times = new Set(rows.filter((r) => r.kind === "weekend" && r.day === day && r.source === "rotation").map((r) => r.time));
      assert.deepEqual([...times].sort(), [...realRot!.weekend].sort(), day);
    }
    const art = new Set(rows.filter((r) => r.kind === "linkedin_article" && r.source === "rotation").map((r) => r.time));
    assert.deepEqual([...art].sort(), [...realRot!.article].sort());
  });
  it("artigo de segunda tem fonte de config (linkedin_weekly_article_time)", () => {
    assert.match(realSocial.linkedin_weekly_article_time, /^\d{2}:\d{2}$/);
  });
});

// ── Fixer do PR #10417 (findings 1-3 do self-review) ─────────────────────────

describe("finding 1 — superfícies de exibição mostram o horário da rotação", () => {
  it("resolveDailyPostTime bate com computeScheduledAt nos 4 tipos (mesma função pura)", () => {
    for (const edition of ["261020", "261021", "261103", "261120"]) {
      const date = publishDateForEdition(edition, social())!;
      for (const type of ROTATION_POST_TYPES) {
        const iso = computeScheduledAt({ config: config(), editionDate: edition, destaque: type, platform: "linkedin", now: FAR_PAST_NOW });
        assert.equal(iso.slice(11, 16), resolveDailyPostTime(social(), date, type).time, `${edition}/${type}`);
      }
    }
  });
  it("fora da janela devolve o fixo, com source=base", () => {
    assert.deepEqual(resolveDailyPostTime(social(), d("2026-10-19"), "um"), { time: "07:45", base: "07:45", source: "base" });
  });
  it("publishDateForEdition aplica day_offset e rejeita não-AAMMDD", () => {
    assert.deepEqual(publishDateForEdition("261020", social()), d("2026-10-20"));
    const s = { ...social(), fallback_schedule: { ...social().fallback_schedule, day_offset: 1 } };
    assert.deepEqual(publishDateForEdition("261020", s), d("2026-10-21"));
    assert.equal(publishDateForEdition("edicao", social()), null);
    assert.equal(publishDateForEdition("261332", social()), null);
  });
  it("gate 4 / preview: useMelhorPostConfigState com a edição mostra o rotacionado e o fixo", () => {
    const st = useMelhorPostConfigState(config(), "261021");
    const expected = weekdayRotationSlot(rot, d("2026-10-21"), "um")!.time;
    assert.equal(st.enabled, true);
    assert.equal(st.time, expected);
    assert.equal(st.baseTime, "07:45");
    const lines = describeUseMelhorPostStatus({
      config: st, state: null, reviewedMd: null, approved: null, hasSocialSection: true, hasCurtoSection: true, carouselSlots: null,
    }).lines;
    assert.match(lines[0], new RegExp(`às ${expected} BRT \\(teste rotativo #10305; fixo 07:45;`));
  });
  it("#10443: --day-offset manual conhecido muda o dia e o horário exibidos (mesma conta do agendamento)", () => {
    // Edição de terça 261020 publicada com --day-offset 1: o post sai na quarta.
    const st = useMelhorPostConfigState(config(), "261020", 1);
    const iso = computeScheduledAt({
      config: config(), editionDate: "261020", destaque: "um", platform: "linkedin", dayOffsetOverride: 1, now: FAR_PAST_NOW,
    });
    assert.equal(st.time, iso.slice(11, 16));
    assert.equal(st.publishDate, "2026-10-21");
    assert.notEqual(
      weekdayRotationSlot(rot, d("2026-10-20"), "um")!.time,
      st.time,
      "pré-condição: terça e quarta têm horários diferentes na rotação",
    );
  });
  it("#10443: o aviso do gate diz de qual dia é o horário e que um --day-offset manual o muda", () => {
    const st = useMelhorPostConfigState(config(), "261020");
    assert.equal(st.publishDate, "2026-10-20");
    const lines = describeUseMelhorPostStatus({
      config: st, state: null, reviewedMd: null, approved: null, hasSocialSection: true, hasCurtoSection: true, carouselSlots: null,
    }).lines;
    assert.match(lines[0], /horário do dia 2026-10-20, um --day-offset manual no Stage 5 muda o horário\)/);
  });
  it("#10443: CLI --date + --day-offset mostra o plano do dia de publicação", () => {
    assert.deepEqual(resolveCliPlanDate("261020"), d("2026-10-20"));
    assert.deepEqual(resolveCliPlanDate("261020", "1"), d("2026-10-21"));
    assert.deepEqual(resolveCliPlanDate("2026-10-31", "1"), d("2026-11-01"));
    assert.deepEqual(resolveCliPlanDate("261020", "0"), d("2026-10-20"));
    assert.throws(() => resolveCliPlanDate("261020", "1.5"), /--day-offset inválido/);
    assert.throws(() => resolveCliPlanDate("261020", ""), /--day-offset inválido/);
  });
  it("sem edição (ou fora da janela) segue o fixo 07:45, sem baseTime — chamadores antigos inalterados", () => {
    assert.deepEqual(useMelhorPostConfigState(config()), { enabled: true, time: "07:45" });
    assert.deepEqual(useMelhorPostConfigState(config(), "261019"), { enabled: true, time: "07:45" });
  });
});

describe("finding 2 — past-slot shift registra a célula perdida", () => {
  it("slot rotacionado no passado → shift + WARN 'célula perdida' no stderr", () => {
    const prevQuiet = process.env.DIARIA_QUIET_SCHEDULE_LOG;
    delete process.env.DIARIA_QUIET_SCHEDULE_LOG;
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      const now = Date.parse("2026-10-20T23:30:00-03:00"); // depois de todos os slots do dia
      const iso = computeScheduledAt({ config: config(), editionDate: "261020", destaque: "d1", platform: "linkedin", now });
      assert.ok(Date.parse(iso) > now, iso);
    } finally {
      console.error = orig;
      if (prevQuiet === undefined) delete process.env.DIARIA_QUIET_SCHEDULE_LOG;
      else process.env.DIARIA_QUIET_SCHEDULE_LOG = prevQuiet;
    }
    assert.ok(errs.some((e) => /\[rotação #10305\] WARN: célula perdida — 261020 linkedin\/d1 planejado 11:00/.test(e)), errs.join("\n"));
  });
  it("fora da rotação o shift não fala em célula perdida", () => {
    const prevQuiet = process.env.DIARIA_QUIET_SCHEDULE_LOG;
    delete process.env.DIARIA_QUIET_SCHEDULE_LOG;
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      computeScheduledAt({ config: config(), editionDate: "261019", destaque: "d1", platform: "linkedin", now: Date.parse("2026-10-19T23:30:00-03:00") });
    } finally {
      console.error = orig;
      if (prevQuiet === undefined) delete process.env.DIARIA_QUIET_SCHEDULE_LOG;
      else process.env.DIARIA_QUIET_SCHEDULE_LOG = prevQuiet;
    }
    assert.ok(errs.some((e) => /WARN \(#2552\)/.test(e)));
    assert.ok(!errs.some((e) => /célula perdida/.test(e)));
  });
});

describe("finding 3 — o agendamento grava o registro sozinho (idempotente)", () => {
  it("dailyRotationRowsForEdition: 4 linhas de rotação no dia útil da janela, nada fora dela", () => {
    const rows = dailyRotationRowsForEdition(social(), "261020");
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.kind === "weekday" && r.source === "rotation" && r.date === "2026-10-20"));
    assert.deepEqual(dailyRotationRowsForEdition(social(), "261019"), []);
    assert.deepEqual(dailyRotationRowsForEdition(social(), "261024"), []); // sábado: o semanal grava o seu
  });
  it("recordRotationRows grava uma vez; a 2ª chamada (2º publicador) não duplica", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "rot-10305-"));
    try {
      const log = resolve(dir, "sub", "rot.jsonl");
      const rows = dailyRotationRowsForEdition(social(), "261021");
      assert.equal(recordRotationRows(log, rows, "2026-10-21T00:00:00Z"), 4);
      assert.equal(recordRotationRows(log, rows), 0);
      const lines = readFileSync(log, "utf8").trim().split("\n");
      assert.equal(lines.length, 4);
      assert.equal(JSON.parse(lines[0]).recorded_at, "2026-10-21T00:00:00Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("recordDailyRotationFailSoft não grava sob o test runner sem destino explícito, e nunca lança", () => {
    assert.ok(process.env.NODE_TEST_CONTEXT, "suite roda sob node --test");
    assert.doesNotThrow(() => recordDailyRotationFailSoft("/caminho/que/nao/existe", "261020"));
  });
  it("os 4 publicadores diários chamam o registro no --schedule", () => {
    for (const f of ["publish-facebook", "publish-linkedin", "publish-instagram", "publish-threads"]) {
      const src = readFileSync(resolve(import.meta.dirname, "..", "scripts", `${f}.ts`), "utf8");
      assert.match(
        src,
        /if \(doSchedule\) recordDailyRotationFailSoft\(ROOT, editionDate, \{ useMelhorScheduled: useMelhorScheduledIn\(results\)/,
        f,
      );
    }
  });
});

describe("#10427 — registro não conta o Use Melhor que não foi agendado", () => {
  const editionPathPattern = /2610[\\/]261020/;

  it("#11081: assert do aviso aceita separadores POSIX, Windows e misturados", () => {
    for (const path of [
      "data/editions/2610/261020/_internal/06-social-published.json",
      "data\\editions\\2610\\261020\\_internal\\06-social-published.json",
      "data\\editions\\2610\\261020/_internal/06-social-published.json",
    ]) {
      assert.match(path, editionPathPattern);
    }
    assert.doesNotMatch("data/editions/2610/261021", editionPathPattern);
  });

  it("buildRotationPlan pula `um` sem use_melhor_time (o 4º post desligado nunca é agendado)", () => {
    const semUm = { ...social(), use_melhor_time: undefined };
    const rows = buildRotationPlan(rot, baseTimesFromSocial(semUm), d("2026-10-20"), d("2026-11-20"));
    assert.ok(!rows.some((r) => r.kind === "weekday" && r.type === "um"));
    const cov = weekdayCoverage(rot, rows);
    for (const [time, byType] of Object.entries(cov)) assert.equal(byType.um, 0, time);
    assert.equal(dailyRotationRowsForEdition(semUm, "261020").length, 3);
    // coerente com computeScheduledAt, que recusa o `um` sem horário fixo
    assert.throws(() =>
      computeScheduledAt({
        config: { publishing: { social: semUm } } as never,
        editionDate: "261020",
        destaque: "um",
        platform: "linkedin",
        now: FAR_PAST_NOW,
      }),
    );
  });
  it("dailyRotationRowsForEdition: useMelhorScheduled=false tira só a linha `um`", () => {
    const rows = dailyRotationRowsForEdition(social(), "261020", { useMelhorScheduled: false });
    assert.deepEqual(rows.map((r) => (r.kind === "weekday" ? r.type : r.kind)), ["d1", "d2", "d3"]);
    assert.equal(dailyRotationRowsForEdition(social(), "261020", { useMelhorScheduled: true }).length, 4);
  });
  it("publicador sem `um` grava 3; outro que agendou o `um` completa a 4ª sem duplicar", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "rot-10427-"));
    try {
      const log = resolve(dir, "rot.jsonl");
      assert.equal(recordRotationRows(log, dailyRotationRowsForEdition(social(), "261021", { useMelhorScheduled: false })), 3);
      assert.ok(!readFileSync(log, "utf8").includes('"type":"um"'));
      assert.equal(recordRotationRows(log, dailyRotationRowsForEdition(social(), "261021", { useMelhorScheduled: true })), 1);
      assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("editionForPublishDate inverte o day_offset do config", () => {
    assert.equal(editionForPublishDate("2026-10-20", social()), "261020");
    assert.equal(editionForPublishDate("2026-10-20", { fallback_schedule: { day_offset: 1 } }), "261019");
    assert.equal(editionForPublishDate("2026-11-01", { fallback_schedule: { day_offset: 1 } }), "261031");
  });
  it("CLI --record: linha `um` só passa com o post um agendado em 06-social-published.json", () => {
    const rows = dailyRotationRowsForEdition(social(), "261020");
    assert.equal(rows.length, 4);
    const types = (rs: typeof rows) => rs.map((r) => (r.kind === "weekday" ? r.type : r.kind)).sort();
    const warns: string[] = [];
    const asked: string[] = [];
    const run = (posts: Array<{ destaque: string; status: string }> | null) =>
      filterUseMelhorRowsByPublished(rows, social(), "/nao-usado", (m) => warns.push(m), (ed) => {
        asked.push(ed);
        return posts;
      });
    // arquivo ausente: não grava `um` e avisa
    assert.deepEqual(types(run(null)), ["d1", "d2", "d3"]);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /06-social-published\.json ausente/);
    assert.match(warns[0], editionPathPattern);
    assert.deepEqual(asked, ["261020"]);
    // arquivo presente sem o `um` agendado (falhou / só destaques)
    // (#10541: o `d3` agendado entra na fixture — sem ele a linha d3 também sai)
    const d3 = { destaque: "d3", status: "scheduled" };
    assert.deepEqual(types(run([{ destaque: "d1", status: "scheduled" }, d3, { destaque: "um", status: "failed" }])), ["d1", "d2", "d3"]);
    // `um` agendado: as 4 linhas
    assert.deepEqual(types(run([d3, { destaque: "um", status: "scheduled" }])), ["d1", "d2", "d3", "um"]);
    assert.equal(warns.length, 1, "só o caso de arquivo ausente avisa");
  });
  it("CLI --record: default lê 06-social-published.json via editionDir sob rootDir", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "rot-10432-"));
    try {
      const rows = dailyRotationRowsForEdition(social(), "261020");
      const warns: string[] = [];
      assert.equal(filterUseMelhorRowsByPublished(rows, social(), dir, (m) => warns.push(m)).length, 3);
      assert.equal(warns.length, 1);
      const edDir = resolve(dir, "data/editions/2610/261020");
      mkdirSync(edDir, { recursive: true });
      writeFileSync(
        resolve(edDir, "06-social-published.json"),
        JSON.stringify({
          posts: [
            { platform: "linkedin", destaque: "d3", status: "scheduled", url: null, scheduled_at: null },
            { platform: "linkedin", destaque: "um", status: "scheduled", url: null, scheduled_at: null },
          ],
        }),
      );
      assert.equal(filterUseMelhorRowsByPublished(rows, social(), dir, (m) => warns.push(m)).length, 4);
      assert.equal(warns.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("useMelhorScheduledIn: só scheduled/published do `um` contam", () => {
    assert.equal(useMelhorScheduledIn([{ destaque: "d1", status: "scheduled" }]), false);
    assert.equal(useMelhorScheduledIn([{ destaque: "um", status: "failed" }]), false);
    assert.equal(useMelhorScheduledIn([{ destaque: "um", status: "draft" }]), false);
    assert.equal(useMelhorScheduledIn([{ destaque: "um", status: "scheduled" }]), true);
    assert.equal(useMelhorScheduledIn([{ destaque: "um", status: "published" }]), true);
  });
  it("dayOffsetOverride do publicador muda a data registrada, como em computeScheduledAt", () => {
    // edição 261019 (seg, fora da janela) + --day-offset 1 → publica 20/10 (dentro)
    assert.deepEqual(dailyRotationRowsForEdition(social(), "261019"), []);
    const rows = dailyRotationRowsForEdition(social(), "261019", { dayOffsetOverride: 1 });
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.date === "2026-10-20"));
    const at = computeScheduledAt({
      config: config() as never,
      editionDate: "261019",
      destaque: "d1",
      platform: "facebook",
      dayOffsetOverride: 1,
      now: FAR_PAST_NOW,
    });
    const d1 = rows.find((r) => r.kind === "weekday" && r.type === "d1")!;
    assert.ok(at.startsWith(`2026-10-20T${d1.time}`), `${at} vs ${d1.time}`);
    assert.deepEqual(publishDateForEdition("261019", social(), Number.NaN), d("2026-10-19"));
  });
});
