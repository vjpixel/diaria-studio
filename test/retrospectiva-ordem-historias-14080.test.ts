/**
 * #14080: a Retrospectiva do Mês herdava a numeração d1/d2/d3 da diária, e com
 * a grade do #10305 (D1 18:00, D2 12:00, D3 21:00) a história 2 saía antes da
 * 1. O planner do #10819 desvia colisão, mas decide cada post sozinho e não
 * respeita a ordem (no domingo, com o carrossel semanal das 19:00 na grade, a
 * história 3 caía de manhã). Regressão: história 1 antes da 2 e da 3, em dia
 * de semana e no domingo, sem colar no carrossel das 19:00.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planRetrospectivaPostSchedule } from "../scripts/publish-retrospectiva-social.ts";
import {
  orderRetrospectivaScheduleByHistoria,
  resolveRetrospectivaPostScheduledAts,
  localIsoAt,
  retrospectivaSlots,
} from "../scripts/lib/mensal/retrospectiva-schedule.ts";
import { RETROSPECTIVA_HISTORIAS, RETROSPECTIVA_POST_CHANNELS, type RetrospectivaPostKey } from "../scripts/lib/mensal/retrospectiva-divulgacao.ts";
import type { ScheduledSlot } from "../scripts/lib/social-slot-planner.ts";

process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";

/** O config real: a grade nova do #10305 é a que o teste precisa cobrir. */
const CONFIG = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
const ALL_KEYS = RETROSPECTIVA_HISTORIAS.flatMap((h) => RETROSPECTIVA_POST_CHANNELS.map((ch) => `${ch}:${h}` as RetrospectivaPostKey));
const FB = ["facebook:diaria"];
const ACCOUNTS = ["linkedin:diaria", "instagram:diaria", "threads:diaria", "twitter:diaria", "facebook:diaria"];
const MIN = 60_000;

function assertAscending(s: ReturnType<typeof resolveRetrospectivaPostScheduledAts>, label: string) {
  for (const ch of RETROSPECTIVA_POST_CHANNELS) {
    const [a, b, c] = RETROSPECTIVA_HISTORIAS.map((h) => Date.parse(s[h][ch]));
    assert.ok(a < b && b < c, `${label} ${ch}: esperado d1 < d2 < d3, veio ${s.d1[ch]} | ${s.d2[ch]} | ${s.d3[ch]}`);
  }
}

describe("#14080: slots próprios da Retrospectiva em ordem crescente", () => {
  it("a grade do #10305 (18:00/12:00/21:00) vira 12:00/18:00/21:00 para as histórias 1/2/3", () => {
    assert.deepEqual(CONFIG.publishing.social.fallback_schedule.d1_time, "18:00", "premissa: grade do #10305 no config");
    assert.deepEqual(retrospectivaSlots(CONFIG.publishing.social.fallback_schedule), { d1: "12:00", d2: "18:00", d3: "21:00" });
    assert.deepEqual(retrospectivaSlots(undefined), { d1: "12:00", d2: "18:00", d3: "21:00" });
    // grade já crescente fica como está; slot ausente cai no da diária de mesmo número
    assert.deepEqual(retrospectivaSlots({ d1_time: "09:45", d2_time: "12:15", d3_time: "17:15" }), { d1: "09:45", d2: "12:15", d3: "17:15" });
    assert.deepEqual(retrospectivaSlots({ d1_time: "9:30" }), { d1: "9:30", d2: "12:00", d3: "21:00" });
    assert.throws(() => retrospectivaSlots({ d1_time: "18h" }), /HH:MM/);
  });

  it("preferência por história: 1 antes da 2 antes da 3, nas 5 redes", () => {
    const s = resolveRetrospectivaPostScheduledAts(CONFIG, { baseDate: "2026-12-05", now: Date.parse("2026-12-01T12:00:00Z") });
    assert.equal(s.d1.linkedin_pagina, "2026-12-06T12:00:00-03:00");
    assert.equal(s.d2.linkedin_pagina, "2026-12-06T18:00:00-03:00");
    assert.equal(s.d3.linkedin_pagina, "2026-12-06T21:00:00-03:00");
    assertAscending(s, "preferência");
  });

  it("dia de semana, grade vazia: depois do planner a história 1 sai antes da 2 e da 3", () => {
    const now = Date.parse("2026-12-01T12:00:00Z");
    const preferred = resolveRetrospectivaPostScheduledAts(CONFIG, { baseDate: "2026-12-07", now }); // posts na terça 08/12
    const s = planRetrospectivaPostSchedule(preferred, [], ALL_KEYS, FB, undefined, now);
    assertAscending(s, "terça");
  });

  it("domingo com o carrossel semanal das 19:00 na grade: ordem crescente e ≥2 h do carrossel", () => {
    const now = Date.parse("2026-12-01T12:00:00Z");
    const preferred = resolveRetrospectivaPostScheduledAts(CONFIG, { baseDate: "2026-12-05", now }); // 1º sábado → domingo 06/12
    const carousel = localIsoAt("2026-12-06", "19:00");
    const grid: ScheduledSlot[] = ACCOUNTS.map((account) => ({ account, at: carousel, label: "carrossel semanal" }));
    const s = planRetrospectivaPostSchedule(preferred, grid, ALL_KEYS, FB, undefined, now);
    assertAscending(s, "domingo");
    for (const ch of RETROSPECTIVA_POST_CHANNELS) {
      const ts = RETROSPECTIVA_HISTORIAS.map((h) => Date.parse(s[h][ch]));
      for (const t of ts) {
        assert.ok(Math.abs(t - Date.parse(carousel)) >= 120 * MIN, `${ch}: ${new Date(t).toISOString()} a menos de 2 h do carrossel das 19:00`);
        assert.ok(t >= Date.parse(localIsoAt("2026-12-06", "06:00")) && t <= Date.parse(localIsoAt("2026-12-06", "22:00")), `${ch}: fora da janela`);
      }
      assert.ok(ts[1] - ts[0] >= 120 * MIN && ts[2] - ts[1] >= 120 * MIN, `${ch}: histórias a menos de 2 h entre si`);
    }
  });

  it("a reordenação não muda o conjunto de horários de cada rede e não toca história fora das chaves", () => {
    const base = resolveRetrospectivaPostScheduledAts(CONFIG, { baseDate: "2026-12-05", now: Date.parse("2026-12-01T12:00:00Z") });
    const bagunçado = {
      d1: { ...base.d1, x: "2026-12-06T20:00:00-03:00", instagram: "2026-12-06T15:00:00-03:00" },
      d2: { ...base.d2, x: "2026-12-06T09:00:00-03:00", instagram: "2026-12-06T10:00:00-03:00" },
      d3: { ...base.d3, x: "2026-12-06T14:00:00-03:00", instagram: "2026-12-06T08:00:00-03:00" },
    };
    const keys = [
      { channel: "x" as const, historia: "d1" as const },
      { channel: "x" as const, historia: "d2" as const },
      { channel: "x" as const, historia: "d3" as const },
      { channel: "instagram" as const, historia: "d2" as const },
      { channel: "instagram" as const, historia: "d3" as const },
    ];
    const o = orderRetrospectivaScheduleByHistoria(bagunçado, keys);
    assert.deepEqual([o.d1.x, o.d2.x, o.d3.x], ["2026-12-06T09:00:00-03:00", "2026-12-06T14:00:00-03:00", "2026-12-06T20:00:00-03:00"]);
    // instagram:d1 fora das chaves (já publicado): mantém o horário; d2/d3 trocam entre si
    assert.equal(o.d1.instagram, "2026-12-06T15:00:00-03:00");
    assert.deepEqual([o.d2.instagram, o.d3.instagram], ["2026-12-06T08:00:00-03:00", "2026-12-06T10:00:00-03:00"]);
    assert.equal(bagunçado.d1.x, "2026-12-06T20:00:00-03:00", "entrada não é mutada");
  });
});
