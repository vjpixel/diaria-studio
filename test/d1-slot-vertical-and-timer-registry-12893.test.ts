/**
 * #12893 — duas sobras do #12748 (vertical conta no espaçamento de 2 h):
 *
 * 1. `loadD1SlotAtFromConfig` (trava "vídeo antes do D1") chamava
 *    `d1SocialSlotAt` sem o config inteiro e não aplicava o desvio do
 *    vertical. O upload (`publish-youtube`) e o `link-video-d1` aplicavam:
 *    o mesmo vídeo tinha veredito diferente nas duas pontas. Agora os três
 *    passam por `d1SocialSlotAtFromConfig`.
 * 2. `publish-schedule-table.ts` lia só `06-shorts-published.json`, sem os
 *    registros dos timers do 300 (`.instagram-timer`, `.linkedin-timer`,
 *    `.threads-timer`): esses destinos ficavam "previsto" depois de
 *    publicados.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadD1SlotAtFromConfig } from "../scripts/lib/diaria/video-before-publish.ts";
import { d1SocialSlotAt, d1SocialSlotAtFromConfig } from "../scripts/lib/diaria/youtube-video-link-gate.ts";
import { readScheduleTableStores } from "../scripts/publish-schedule-table.ts";
import { buildScheduleTable } from "../scripts/lib/diaria/publish-schedule-table.ts";

const ROOT = join(import.meta.dirname, "..");

/** Rotação do #10305 + vertical fixo 12:00 (YouTube 06:30), como o config real em 10/11/2026. */
function syntheticConfig() {
  return {
    publishing: {
      social: {
        timezone: "America/Sao_Paulo",
        use_melhor_time: "07:45",
        fallback_schedule: { d1_time: "09:45", d2_time: "12:15", d3_time: "17:15", day_offset: 0 },
        rotation: {
          enabled: true,
          start_date: "2026-10-20",
          end_date: "2026-11-20",
          weekday_candidates: ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"],
          weekend_candidates: ["08:00", "11:00", "15:00", "19:00"],
        },
      },
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
    },
  };
}

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "d1-slot-12893-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("horário do D1 com o desvio do vertical em todos os consumidores (#12893)", () => {
  it("loadD1SlotAtFromConfig aplica o desvio: 261111 (D1 11:00 × vertical 12:00) dá 10:00 BRT", () => {
    const cfg = syntheticConfig();
    withTmp((root) => {
      writeFileSync(join(root, "platform.config.json"), JSON.stringify(cfg));
      const fromFile = loadD1SlotAtFromConfig("261111", root);
      // Sem o config inteiro o D1 seria 11:00 BRT (14:00Z): o valor que a trava usava antes.
      assert.equal(d1SocialSlotAt("261111", cfg.publishing.social)?.toISOString(), "2026-11-11T14:00:00.000Z");
      assert.equal(fromFile?.toISOString(), "2026-11-11T13:00:00.000Z");
      assert.equal(fromFile?.toISOString(), d1SocialSlotAtFromConfig("261111", cfg)?.toISOString());
    });
  });

  it("config ausente ou ilegível: null, sem lançar", () => {
    withTmp((root) => {
      assert.equal(loadD1SlotAtFromConfig("261111", root), null);
      writeFileSync(join(root, "platform.config.json"), "{");
      assert.equal(loadD1SlotAtFromConfig("261111", root), null);
    });
    assert.equal(d1SocialSlotAtFromConfig("261111", null), null);
  });

  it("nenhum chamador em scripts/ usa d1SocialSlotAt direto (só via d1SocialSlotAtFromConfig)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(join("diaria", "youtube-video-link-gate.ts"))) {
          if (/\bd1SocialSlotAt\s*\(/.test(readFileSync(p, "utf8"))) offenders.push(p.slice(ROOT.length + 1));
        }
      }
    };
    walk(join(ROOT, "scripts"));
    assert.deepEqual(offenders, []);
    // Os três consumidores da issue passam pelo helper.
    for (const f of ["scripts/publish-youtube.ts", "scripts/link-video-d1.ts", "scripts/lib/diaria/video-before-publish.ts"]) {
      assert.match(readFileSync(join(ROOT, f), "utf8"), /d1SocialSlotAtFromConfig\(aammdd, cfg\)/, f);
    }
  });
});

describe("tabela de horários lê os registros dos timers do vertical (#12893)", () => {
  const edition = (files: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "schedule-table-12893-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, "_internal", name), JSON.stringify(content));
    return dir;
  };

  it("Instagram publicado pelo timer sai com o horário real, não 'previsto'", () => {
    const dir = edition({
      "06-shorts-published.json": {
        aammdd: "261111",
        entries: [{ destination: "x", status: "scheduled", id: "b1", scheduled_at: "2026-11-11T12:00:00-03:00", at: "2026-11-10T20:00:00Z" }],
      },
      "06-shorts-published.instagram-timer.json": {
        aammdd: "261111",
        entries: [{ destination: "instagram", status: "published", id: "ig1", at: "2026-11-11T15:20:00Z" }],
      },
      "06-shorts-published.threads-timer.json": {
        aammdd: "261111",
        entries: [{ destination: "threads_profile", status: "published", id: "th1", at: "2026-11-11T15:40:00Z" }],
      },
    });
    try {
      const table = buildScheduleTable({ aammdd: "261111", config: syntheticConfig(), ...readScheduleTableStores(dir, "261111") });
      const cell = (account: string) => table.rows.find((r) => r.account === account)?.cells.vertical;
      assert.equal(cell("instagram:diaria")?.text, "12:20");
      assert.equal(cell("instagram:diaria")?.planned, undefined);
      assert.equal(cell("twitter:diaria")?.text, "12:00");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem registro em _internal/: shorts null (tudo previsto), como antes", () => {
    const dir = edition({});
    try {
      assert.equal(readScheduleTableStores(dir, "261111").shorts, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registro de timer ilegível é erro, não tabela silenciosamente sem o destino", () => {
    const dir = edition({ "06-shorts-published.linkedin-timer.json": { aammdd: "261110", entries: [] } });
    try {
      assert.throws(() => readScheduleTableStores(dir, "261111"), /261110/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
