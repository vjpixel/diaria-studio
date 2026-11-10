/**
 * #12748: o vertical (horário fixo por destino, #12250) conta no espaçamento
 * de 2 h (#10819) dos posts sociais das Etapas 5/6, e a tabela de horários do
 * `/diaria-publica` ganha a coluna Vertical.
 *
 * Regressão: com a rotação do #10305, todo dia útil um post caía a 1 h do
 * vertical das 12:00 (D1 11:00 ou 13:00) nas mesmas contas (Facebook,
 * Instagram em collab, X), e a tabela não mostrava o vertical.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeScheduledAt } from "../scripts/compute-social-schedule.ts";
import {
  clearPostTimesFromVertical,
  clearedDailyPostTimes,
  dailySocialAccounts,
  verticalBlockingTimes,
} from "../scripts/lib/diaria/vertical-social-clearance.ts";
import { buildScheduleTable, renderScheduleTableMarkdown } from "../scripts/lib/diaria/publish-schedule-table.ts";
import { d1SocialSlotAt } from "../scripts/lib/diaria/youtube-video-link-gate.ts";
import { useMelhorPostConfigState } from "../scripts/lib/use-melhor-post.ts";

process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";

const REAL_CONFIG = JSON.parse(readFileSync(join(import.meta.dirname, "..", "platform.config.json"), "utf8"));
const PLATFORMS = ["linkedin", "facebook", "instagram", "threads", "twitter"] as const;
const TYPES = ["um", "d1", "d2", "d3"] as const;
const brt = (iso: string) => new Date(Date.parse(iso) - 3 * 3_600_000).toISOString().slice(11, 16);
const min = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Config sintético: rotação do #10305 + vertical fixo 12:00 (YouTube 06:30), como o real em 10/11/2026. */
function syntheticConfig(over: { shorts?: unknown; dayOffset?: number } = {}) {
  return {
    publishing: {
      social: {
        timezone: "America/Sao_Paulo",
        use_melhor_time: "07:45",
        fallback_schedule: { d1_time: "09:45", d2_time: "12:15", d3_time: "17:15", day_offset: over.dayOffset ?? 0 },
        rotation: {
          enabled: true,
          start_date: "2026-10-20",
          end_date: "2026-11-20",
          weekday_candidates: ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"],
          weekend_candidates: ["08:00", "11:00", "15:00", "19:00"],
        },
      },
      ...("shorts" in over
        ? over.shorts === undefined
          ? {}
          : { shorts: over.shorts }
        : {
            shorts: {
              facebook_pages: ["diaria", "vjpixel"],
              instagram: true,
              instagram_author_page: null,
              instagram_collaborators: ["vjpixel"],
              x: true,
              schedule: {
                rotation_times: ["06:30", "08:00", "12:00"],
                rotation_start: "2026-10-26",
                rotation_end: "2026-11-06",
                default_time: "12:00",
                by_destination: { youtube_shorts: "06:30" },
              },
            },
          }),
    },
  };
}

function dayTimes(config: unknown, ed: string, platform: (typeof PLATFORMS)[number] = "linkedin") {
  return Object.fromEntries(
    TYPES.map((d) => [d, brt(computeScheduledAt({ config: config as any, editionDate: ed, destaque: d, platform, disablePastSlotShift: true }))]),
  ) as Record<(typeof TYPES)[number], string>;
}

describe("clearPostTimesFromVertical (#12748)", () => {
  it("dia par da rotação (07/11/15/19): o 11:00 desvia para 10:00, o resto fica", () => {
    const r = clearPostTimesFromVertical({ um: "07:00", d1: "11:00", d2: "15:00", d3: "19:00" }, ["12:00"]);
    assert.equal(r.d1.time, "10:00");
    assert.equal(r.d1.shifted, true);
    assert.equal(r.d1.blockedBy, "12:00");
    assert.deepEqual([r.um.time, r.d2.time, r.d3.time], ["07:00", "15:00", "19:00"]);
    assert.equal(r.um.shifted, false);
  });

  it("dia ímpar (09/13/17/21): o 13:00 desvia para 14:00", () => {
    const r = clearPostTimesFromVertical({ um: "09:00", d1: "13:00", d2: "17:00", d3: "21:00" }, ["12:00"]);
    assert.equal(r.d1.time, "14:00");
  });

  it("post desligado (null) fica desligado; sem bloqueio nada muda", () => {
    const r = clearPostTimesFromVertical({ um: null, d1: "11:00", d2: "15:00", d3: "19:00" }, []);
    assert.equal(r.um.time, null);
    assert.equal(r.d1.time, "11:00");
    assert.equal(r.d1.shifted, false);
  });

  it("sem horário que caiba: mantém o original com aviso", () => {
    const r = clearPostTimesFromVertical({ um: "07:00", d1: "11:00", d2: "15:00", d3: "19:00" }, ["12:00"], {
      windowStart: "10:30",
      windowEnd: "13:30",
    });
    assert.equal(r.d1.time, "11:00");
    assert.equal(r.d1.shifted, false);
    assert.match(r.d1.warning ?? "", /vertical \(12:00 BRT\)/);
  });
});

describe("contas e horários do vertical que bloqueiam (#12748)", () => {
  it("só os destinos em conta do Stage 5 bloqueiam; YouTube Shorts 06:30 não", () => {
    const cfg = syntheticConfig();
    assert.deepEqual(verticalBlockingTimes(cfg, "261111"), ["12:00"]);
    assert.ok(dailySocialAccounts(cfg).includes("twitter:diaria"));
  });

  it("sem o bloco publishing.shorts não há vertical: nada bloqueia", () => {
    assert.deepEqual(verticalBlockingTimes(syntheticConfig({ shorts: undefined }), "261111"), []);
  });
});

describe("computeScheduledAt desvia do vertical (#12748)", () => {
  it("regressão: nenhum post a menos de 2 h das 12:00 em nenhum dia útil, com o config REAL", () => {
    const ed0 = Date.UTC(2026, 10, 9);
    for (let i = 0; i < 21; i++) {
      const d = new Date(ed0 + i * 86_400_000);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const ed = d.toISOString().slice(2, 10).replace(/-/g, "");
      const t = dayTimes(REAL_CONFIG, ed);
      for (const type of TYPES) {
        assert.ok(Math.abs(min(t[type]) - min("12:00")) >= 120, `${ed} ${type} ${t[type]} cola no vertical das 12:00`);
      }
      const all = Object.values(t).map(min).sort((a, b) => a - b);
      for (let k = 1; k < all.length; k++) assert.ok(all[k] - all[k - 1] >= 120, `${ed}: posts do dia a menos de 2 h (${JSON.stringify(t)})`);
    }
  });

  it("o desvio é o mesmo nas 5 redes (horário único por tipo, #10305)", () => {
    const cfg = syntheticConfig();
    const ref = dayTimes(cfg, "261111");
    assert.equal(ref.d1, "10:00");
    for (const p of PLATFORMS) assert.deepEqual(dayTimes(cfg, "261111", p), ref, p);
  });

  it("fora da rotação, o fixo 12:15 do D2 desvia para 14:00", () => {
    assert.deepEqual(dayTimes(syntheticConfig(), "261123"), { um: "07:45", d1: "09:45", d2: "14:00", d3: "17:15" });
  });

  it("sem publishing.shorts, com applyVerticalClearance:false ou com day_offset, nada muda", () => {
    assert.equal(dayTimes(syntheticConfig({ shorts: undefined }), "261111").d1, "11:00");
    const off = computeScheduledAt({
      config: syntheticConfig() as any,
      editionDate: "261111",
      destaque: "d1",
      platform: "facebook",
      disablePastSlotShift: true,
      applyVerticalClearance: false,
    });
    assert.equal(brt(off), "11:00");
    // day_offset 1: o social sai em 12/11 (dia ímpar → 13:00) e o vertical em 11/11, sem colisão.
    assert.equal(dayTimes(syntheticConfig({ dayOffset: 1 }), "261111").d1, "13:00");
  });

  it("superfícies de exibição chegam no mesmo horário (D1 do link do vídeo, Use Melhor)", () => {
    const cfg = syntheticConfig();
    const d1 = d1SocialSlotAt("261111", cfg.publishing.social as any, cfg);
    assert.equal(d1?.toISOString(), "2026-11-11T13:00:00.000Z");
    assert.equal(clearedDailyPostTimes(cfg, { year: 2026, month: 11, day: 11 }, "261111")?.d1.time, "10:00");
    // 261123 (fora da rotação): o Use Melhor 07:45 não colide e segue o fixo.
    assert.equal(useMelhorPostConfigState(cfg, "261123").time, "07:45");
  });
});

describe("tabela de horários com o vertical (#12748)", () => {
  const posts = (times: Record<string, string>) =>
    PLATFORMS.flatMap((p) =>
      Object.entries(times).map(([d, hhmm]) => ({ platform: p, destaque: d, status: "scheduled", scheduled_at: `2026-11-11T${hhmm}:00-03:00` })),
    );

  it("coluna Vertical, linhas só do vertical e marca previsto antes da Parte B", () => {
    const table = buildScheduleTable({
      aammdd: "261111",
      config: REAL_CONFIG,
      social: { posts: posts({ um: "07:00", d1: "10:00", d2: "15:00", d3: "19:00" }) },
      shorts: null,
    });
    const md = renderScheduleTableMarkdown(table);
    assert.match(md, /^\| Rede \| Use Melhor \| D1 \| D2 \| D3 \| Vertical \|$/m);
    assert.match(md, /^\| Facebook \| 07:00 \| 10:00 \| 15:00 \| 19:00 \| 12:00 \(previsto\) \|$/m);
    assert.match(md, /^\| Threads \| 07:00 \| 10:00 \| 15:00 \| 19:00 \| — \|$/m);
    assert.match(md, /^\| LinkedIn \| 07:00 \| 10:00 \| 15:00 \| 19:00 \| Parte B \|$/m);
    assert.match(md, /^\| YouTube Shorts \| — \| — \| — \| — \| 06:30 \(previsto\) \|$/m);
    assert.match(md, /^\| TikTok \| — \| — \| — \| — \| 12:00 \(previsto\) \|$/m);
    assert.deepEqual(table.warnings, []);
  });

  it("o cenário da issue (D1 11:00 × vertical 12:00) sai com aviso na tabela; horário registrado vence o previsto", () => {
    const table = buildScheduleTable({
      aammdd: "261111",
      config: REAL_CONFIG,
      social: { posts: posts({ um: "07:00", d1: "11:00", d2: "15:00", d3: "19:00" }) },
      shorts: {
        aammdd: "261111",
        entries: [
          { destination: "x", status: "scheduled", id: "b1", scheduled_at: "2026-11-11T12:00:00-03:00", at: "2026-11-10T20:00:00Z" },
          { destination: "linkedin_page_repost", status: "published", id: "u", at: "2026-11-11T16:30:00Z" },
        ],
      },
    });
    const x = table.rows.find((r) => r.label === "X");
    assert.equal(x?.cells.vertical.text, "12:00");
    assert.equal(table.rows.find((r) => r.label === "LinkedIn")?.cells.vertical.text, "13:30");
    assert.ok(table.warnings.some((w) => /^X: D1 11:00 e Vertical 12:00 BRT a 60 min/.test(w)), JSON.stringify(table.warnings));
    assert.ok(table.warnings.some((w) => /^Facebook: D1 11:00/.test(w)));
    assert.ok(!table.warnings.some((w) => /^Threads:/.test(w)));
  });
});
