/**
 * #10305 — fim do teste rotativo: grade fixa decidida pelo editor em
 * 25/11/2026 (`/diaria-develop 261125`, comentário `decisao-editor` da issue).
 *
 *   dia útil, iguais nas 5 redes: Use Melhor 09:00 (quando sair), D2 12:00,
 *   D1 18:00, D3 21:00; sábado e domingo 19:00; rotação encerrada.
 *
 * Lê o `platform.config.json` real (a fonte que os publicadores leem) e passa
 * pelos mesmos helpers que eles usam (`computeScheduledAt`,
 * `resolveDailyPostTime`, `resolveWeeklyTime`/`computeWeeklyScheduledAt`). O
 * desvio do vertical (#12748) fica fora (`applyVerticalClearance: false`):
 * aqui se trava a grade, não a interação com o vídeo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScheduledAt } from "../scripts/compute-social-schedule.ts";
import {
  DEFAULT_WEEKLY_CAROUSEL_TIME,
  ROTATION_POST_TYPES,
  baseTimesFromSocial,
  buildRotationPlan,
  parseIsoCivilDate,
  readSocialRotation,
  resolveDailyPostTime,
  resolveLinkedinArticleTime,
} from "../scripts/lib/social-schedule-rotation.ts";
import { DEFAULT_WEEKLY_TIME, computeWeeklyScheduledAt, resolveWeeklyTime } from "../scripts/publish-weekly-social.ts";
import { dailyRotationRowsForEdition } from "../scripts/lib/social-schedule-rotation-record.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
const SOCIAL = CONFIG.publishing.social;

const GRADE = { um: "09:00", d1: "18:00", d2: "12:00", d3: "21:00" } as const;
const PLATFORMS = ["linkedin", "facebook", "instagram", "threads", "twitter"] as const;
// Bem antes de qualquer edição testada: o past-slot guard nunca desloca.
const NOW = Date.parse("2026-01-01T00:00:00-03:00");

function scheduled(editionDate: string, destaque: keyof typeof GRADE, platform: (typeof PLATFORMS)[number], config = CONFIG): string {
  return computeScheduledAt({ config, editionDate, destaque, platform, now: NOW, applyVerticalClearance: false });
}

describe("#10305 grade fixa — config real", () => {
  it("rotação desligada, com o bloco mantido como registro do teste", () => {
    assert.equal(SOCIAL.rotation.enabled, false);
    assert.equal(SOCIAL.rotation.start_date, "2026-10-20");
    assert.equal(SOCIAL.rotation.end_date, "2026-11-20");
    assert.equal(readSocialRotation(SOCIAL), null);
  });

  it("horários fixos do dia útil e do fim de semana", () => {
    assert.deepEqual(SOCIAL.fallback_schedule, { d1_time: "18:00", d2_time: "12:00", d3_time: "21:00", day_offset: 0 });
    assert.equal(SOCIAL.use_melhor_time, "09:00");
    assert.deepEqual(baseTimesFromSocial(SOCIAL).weekday, GRADE);
    assert.equal(DEFAULT_WEEKLY_CAROUSEL_TIME, "19:00");
    assert.equal(DEFAULT_WEEKLY_TIME, "19:00");
  });
});

describe("#10305 grade fixa — dia útil nas 5 redes", () => {
  for (const ed of ["261201", "261204"]) {
    for (const type of ROTATION_POST_TYPES) {
      it(`${ed} ${type}: ${GRADE[type]} em LinkedIn, Facebook, Instagram, Threads e X`, () => {
        const iso = `20${ed.slice(0, 2)}-${ed.slice(2, 4)}-${ed.slice(4, 6)}T${GRADE[type]}:00-03:00`;
        for (const p of PLATFORMS) assert.equal(scheduled(ed, type, p), iso, `${p}/${type}`);
      });
    }
  }

  it("dia dentro da antiga janela do teste (261021) também cai na grade fixa", () => {
    for (const type of ROTATION_POST_TYPES) {
      assert.equal(scheduled("261021", type, "linkedin"), `2026-10-21T${GRADE[type]}:00-03:00`);
      const r = resolveDailyPostTime(SOCIAL, parseIsoCivilDate("2026-10-21"), type);
      assert.deepEqual(r, { time: GRADE[type], base: GRADE[type], source: "base" });
    }
  });

  it("os publicadores não gravam mais linha de rotação no registro", () => {
    assert.deepEqual(dailyRotationRowsForEdition(SOCIAL, "261201"), []);
    assert.deepEqual(dailyRotationRowsForEdition(SOCIAL, "261021"), []);
  });

  it("artigo semanal do LinkedIn segue no fixo de 09:30, fora da rotação", () => {
    assert.deepEqual(resolveLinkedinArticleTime(SOCIAL, parseIsoCivilDate("2026-11-30")), { time: "09:30", source: "base" });
  });
});

describe("#10305 grade fixa — sem Use Melhor o dia fica com 3 posts", () => {
  const semUm = { ...CONFIG, publishing: { ...CONFIG.publishing, social: { ...SOCIAL, use_melhor_time: null } } };

  it("D1/D2/D3 mantêm os horários e o 4º post não tem horário", () => {
    assert.equal(scheduled("261201", "d1", "instagram", semUm), "2026-12-01T18:00:00-03:00");
    assert.equal(scheduled("261201", "d2", "instagram", semUm), "2026-12-01T12:00:00-03:00");
    assert.equal(scheduled("261201", "d3", "instagram", semUm), "2026-12-01T21:00:00-03:00");
    assert.throws(() => scheduled("261201", "um", "instagram", semUm), /use_melhor_time/);
    assert.equal(resolveDailyPostTime(semUm.publishing.social, parseIsoCivilDate("2026-12-01"), "um").time, null);
  });

  it("o plano do dia tem só as 3 linhas dos destaques", () => {
    const d = parseIsoCivilDate("2026-12-01");
    const rows = buildRotationPlan(null, baseTimesFromSocial(semUm.publishing.social), d, d);
    assert.deepEqual(
      rows.map((r) => (r.kind === "weekday" ? `${r.type} ${r.time}` : r.kind)),
      ["d1 18:00", "d2 12:00", "d3 21:00"],
    );
  });
});

describe("#10305 grade fixa — sábado e domingo 19:00", () => {
  // 261128 é sábado; clicked sai no domingo (dayOffset 1).
  for (const [label, dayOffset, date] of [
    ["sábado (highlights)", 0, "2026-11-28"],
    ["domingo (clicked)", 1, "2026-11-29"],
  ] as const) {
    it(`${label}: 19:00`, () => {
      const time = resolveWeeklyTime({ social: SOCIAL, saturday: "261128", dayOffset });
      assert.equal(time, "19:00");
      assert.equal(
        computeWeeklyScheduledAt({ saturday: "261128", time, timezone: SOCIAL.timezone, dayOffset }),
        `${date}T19:00:00-03:00`,
      );
    });
  }

  it("sábado dentro da antiga janela (261031) também sai às 19:00", () => {
    assert.equal(resolveWeeklyTime({ social: SOCIAL, saturday: "261031", dayOffset: 0 }), "19:00");
  });

  it("--time explícito continua sobrepondo", () => {
    assert.equal(resolveWeeklyTime({ explicitTime: "14:15", social: SOCIAL, saturday: "261128", dayOffset: 0 }), "14:15");
  });
});
