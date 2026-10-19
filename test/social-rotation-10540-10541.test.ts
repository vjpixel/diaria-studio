/**
 * #10540 / #10541 — defeitos de medição do teste rotativo #10305.
 *
 * #10540: o leitor default da CLI `--record` lia só
 *   `{edição}/06-social-published.json`, mas os 5 publicadores gravam em
 *   `_internal/`. A linha `um` nunca era gravada e o aviso "rode --record de
 *   novo" aparecia toda edição. Teste SEM injeção do reader.
 * #10541 item 1: edição de 2 destaques gravava a célula `d3` como coberta.
 * #10541 item 2: o conselho "dia seguinte, mesmo horário" do carrossel
 *   semanal mudava de horário sob a rotação (sábado → slot do domingo, o
 *   mesmo do carrossel `clicked`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  dailyRotationRowsForEdition,
  destaqueScheduledIn,
  filterUseMelhorRowsByPublished,
  readEditionPublishedPosts,
} from "../scripts/lib/social-schedule-rotation-record.ts";
import { readSocialRotation, weekdayCoverage } from "../scripts/lib/social-schedule-rotation.ts";
import { editionDir } from "../scripts/lib/edition-paths.ts";
import { checkWeeklySlot, formatSlotAdvice } from "../scripts/lib/weekly-slot-check.ts";
import { resolveWeeklyTime, weeklyNextDayTime } from "../scripts/publish-weekly-social.ts";

process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";

const ROTATION = {
  enabled: true,
  start_date: "2026-10-20",
  end_date: "2026-11-20",
  weekday_candidates: ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"],
  weekend_candidates: ["08:00", "11:00", "15:00", "19:00"],
  linkedin_weekly_article_candidates: ["07:30", "09:30", "12:30", "18:30"],
};
const social = () => ({
  timezone: "America/Sao_Paulo",
  fallback_schedule: { d1_time: "09:45", d2_time: "12:15", d3_time: "17:15", day_offset: 0 },
  use_melhor_time: "07:45",
  linkedin_weekly_article_time: "09:30",
  rotation: ROTATION,
});
const types = (rows: ReturnType<typeof dailyRotationRowsForEdition>) =>
  rows.map((r) => (r.kind === "weekday" ? r.type : r.kind)).sort();

function withEdition(fn: (root: string, edDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rot-10540-"));
  try {
    const edDir = join(root, editionDir("261020"));
    mkdirSync(join(edDir, "_internal"), { recursive: true });
    fn(root, edDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const published = (...destaques: string[]) =>
  JSON.stringify({ posts: destaques.map((d) => ({ platform: "linkedin", destaque: d, status: "scheduled", url: null, scheduled_at: null })) });

describe("#10540 — --record lê _internal/06-social-published.json (sem reader injetado)", () => {
  it("arquivo só em _internal/ (onde os publicadores gravam): grava as 4 linhas, sem aviso", () => {
    withEdition((root, edDir) => {
      writeFileSync(join(edDir, "_internal", "06-social-published.json"), published("d1", "d2", "d3", "um"));
      const warns: string[] = [];
      const out = filterUseMelhorRowsByPublished(dailyRotationRowsForEdition(social(), "261020"), social(), root, (m) => warns.push(m));
      assert.deepEqual(types(out), ["d1", "d2", "d3", "um"]);
      assert.deepEqual(warns, []);
    });
  });
  it("_internal/ vence a raiz legada", () => {
    withEdition((_root, edDir) => {
      writeFileSync(join(edDir, "_internal", "06-social-published.json"), published("um"));
      writeFileSync(join(edDir, "06-social-published.json"), published("d1"));
      assert.deepEqual(readEditionPublishedPosts(edDir)?.map((p) => p.destaque), ["um"]);
    });
  });
  it("só a raiz legada: ainda lida; nenhum dos dois: null", () => {
    withEdition((_root, edDir) => {
      assert.equal(readEditionPublishedPosts(edDir), null);
      writeFileSync(join(edDir, "06-social-published.json"), published("d1"));
      assert.deepEqual(readEditionPublishedPosts(edDir)?.map((p) => p.destaque), ["d1"]);
    });
  });
  it("a CLI usa o leitor default (sem injetar readPublished)", () => {
    const src = readFileSync(resolve(import.meta.dirname, "..", "scripts", "social-schedule-rotation.ts"), "utf8");
    assert.match(src, /filterUseMelhorRowsByPublished\(rows, social, ROOT\)/);
  });
});

describe("#10541 item 1 — edição de 2 destaques não grava a célula d3", () => {
  it("dailyRotationRowsForEdition: d3Scheduled=false tira só a linha d3", () => {
    const rows = dailyRotationRowsForEdition(social(), "261020", { d3Scheduled: false });
    assert.deepEqual(types(rows), ["d1", "d2", "um"]);
    const cov = weekdayCoverage(readSocialRotation(social())!, rows);
    assert.equal(Object.values(cov).reduce((n, c) => n + c.d3, 0), 0);
    assert.equal(dailyRotationRowsForEdition(social(), "261020", { d3Scheduled: true }).length, 4);
    assert.equal(dailyRotationRowsForEdition(social(), "261020").length, 4, "undefined mantém");
  });
  it("destaqueScheduledIn: só scheduled/published do destaque pedido", () => {
    assert.equal(destaqueScheduledIn([{ destaque: "d1", status: "scheduled" }, { destaque: "d2", status: "scheduled" }], "d3"), false);
    assert.equal(destaqueScheduledIn([{ destaque: "d3", status: "failed" }], "d3"), false);
    assert.equal(destaqueScheduledIn([{ destaque: "d3", status: "published" }], "d3"), true);
  });
  it("CLI --record: published sem d3 (2 destaques) → linha d3 não gravada; arquivo ausente mantém d3", () => {
    withEdition((root, edDir) => {
      const rows = dailyRotationRowsForEdition(social(), "261020");
      const warns: string[] = [];
      assert.deepEqual(types(filterUseMelhorRowsByPublished(rows, social(), root, (m) => warns.push(m))), ["d1", "d2", "d3"]);
      writeFileSync(join(edDir, "_internal", "06-social-published.json"), published("d1", "d2", "um"));
      assert.deepEqual(types(filterUseMelhorRowsByPublished(rows, social(), root, (m) => warns.push(m))), ["d1", "d2", "um"]);
    });
  });
  it("os 4 publicadores diários passam d3Scheduled ao registro", () => {
    for (const f of ["publish-facebook", "publish-linkedin", "publish-instagram", "publish-threads"]) {
      const src = readFileSync(resolve(import.meta.dirname, "..", "scripts", `${f}.ts`), "utf8");
      assert.match(src, /recordDailyRotationFailSoft\(ROOT, editionDate, \{[^}]*d3Scheduled: destaqueScheduledIn\(results, "d3"\)/, f);
    }
  });
});

describe("#10541 item 2 — conselho de slot vencido não muda o horário em silêncio", () => {
  // Sábado 24/10/2026 (dentro da janela): highlights sai no sábado, clicked no domingo.
  const SAT = "261024";
  it("weeklyNextDayTime(highlights) = horário do domingo da rotação = o do clicked", () => {
    const next = weeklyNextDayTime(social(), SAT, 0);
    assert.equal(next.fromRotation, true);
    assert.equal(next.time, resolveWeeklyTime({ social: social(), saturday: SAT, dayOffset: 1 }));
  });
  it("sábado vencido sob a rotação: sugere --time com o horário do slot e avisa da colisão", () => {
    const satTime = resolveWeeklyTime({ social: social(), saturday: SAT, dayOffset: 0 });
    const next = weeklyNextDayTime(social(), SAT, 0);
    assert.notEqual(satTime, next.time, "premissa do cenário: a rotação muda o horário de sábado pra domingo");
    const scheduledAt = `2026-10-24T${satTime}:00-03:00`;
    const now = new Date("2026-10-24T23:00:00-03:00");
    const text = formatSlotAdvice({ mode: "highlights", saturday: SAT, check: checkWeeklySlot(scheduledAt, now), now, dayOffset: 0, nextDay: next }).join("\n");
    assert.match(text, new RegExp(`--day-offset 1 --time ${satTime}`));
    assert.match(text, new RegExp(`sem --time, o dia seguinte cai em ${next.time}`));
    assert.match(text, /clicked/);
    assert.ok(!/mesmo horário: .*--day-offset 1$/m.test(text), "não pode sobrar o conselho antigo sem --time");
  });
  it("fora da rotação (horário igual): conselho antigo, sem --time", () => {
    const now = new Date("2026-10-17T23:00:00-03:00");
    const text = formatSlotAdvice({
      mode: "highlights",
      saturday: "261017",
      check: checkWeeklySlot("2026-10-17T11:00:00-03:00", now),
      now,
      dayOffset: 0,
      nextDay: { time: "11:00", fromRotation: false },
    }).join("\n");
    assert.match(text, /dia seguinte, mesmo horário: .*--day-offset 1$/m);
    assert.ok(!/--time 11:00/.test(text));
  });
});
