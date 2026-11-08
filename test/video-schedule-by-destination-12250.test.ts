/**
 * test/video-schedule-by-destination-12250.test.ts (#12250)
 *
 * Decisão do editor (05/11/2026, corrigida no comentário da issue): o
 * horizontal sai às 06:00 BRT, o YouTube Shorts às 06:30 e todos os outros
 * destinos do vertical às 12:00 — horário POR DESTINO, lido pelo
 * `publish-shorts.ts` e pelos timers do 300 a partir do mesmo config. O teste
 * rotativo 06:30/08:00/12:00 do #10831 foi encerrado (rotation_end 261106).
 * Horário já passado publica na hora (comportamento de antes). Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SHORT_SCHEDULE_RAW,
  SCHEDULE_DESTINATION_IDS,
  listShortDestinations,
  loadShortScheduleConfig,
  loadShortsConfig,
  planShortSlots,
  resolveShortTime,
  timerDueTimes,
  type ShortDestination,
} from "../scripts/lib/diaria/short-video.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import { resolveYouTubeSchedule } from "../scripts/lib/diaria/youtube-video.ts";
import { extraVerticalTime } from "../scripts/lib/diaria/extra-verticals.ts";
import { planShortsPublish } from "../scripts/publish-shorts.ts";
import { linkedinVerticalTime } from "../scripts/shorts-linkedin-profile-timer.ts";
import { decideInstagramTimerRun } from "../scripts/shorts-instagram-timer.ts";
import { decideThreadsTimerRun } from "../scripts/shorts-threads-profile-timer.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const LIVE = JSON.parse(readFileSync(join(import.meta.dirname, "..", "platform.config.json"), "utf8"));
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-03:00`).toISOString();

/** Cópia FIXA da decisão (não depende do config vivo): os casos de lógica não quebram se o config mudar. */
const FIXED = {
  rotation_times: ["06:30", "08:00", "12:00"],
  rotation_start: "2026-10-26",
  rotation_end: "2026-11-06",
  default_time: "12:00",
  by_destination: { youtube_shorts: "06:30" },
};
const sched = loadShortScheduleConfig({ publishing: { shorts: { schedule: FIXED } } });

describe("#12250 config vivo: a decisão do editor está no platform.config.json", () => {
  const live = loadShortScheduleConfig(LIVE);
  it("YouTube Shorts 06:30, os outros destinos 12:00 (261109, 1ª segunda depois do teste)", () => {
    assert.equal(resolveShortTime(live, "261109", "youtube_shorts").hhmm, "06:30");
    for (const d of ["facebook:diaria", "facebook:vjpixel", "instagram", "linkedin_profile", "x", "tiktok", "threads_profile"]) {
      assert.equal(resolveShortTime(live, "261109", d).hhmm, "12:00", d);
    }
    assert.equal(resolveShortTime(live, "261109").hhmm, "12:00");
  });

  it("teste rotativo encerrado: rotation_end = 2026-11-06, e o default do código acompanha", () => {
    assert.equal(LIVE.publishing.shorts.schedule.rotation_end, "2026-11-06");
    assert.equal(DEFAULT_SHORT_SCHEDULE_RAW.rotation_end, "2026-11-06");
    assert.deepEqual({ ...DEFAULT_SHORT_SCHEDULE_RAW.by_destination }, LIVE.publishing.shorts.schedule.by_destination);
    // 261113 (fim antigo do teste) e 261110 (08:00 no teste antigo) agora seguem o horário fixo.
    assert.equal(resolveShortTime(live, "261110", "instagram").hhmm, "12:00");
    assert.equal(resolveShortTime(live, "261113", "youtube_shorts").hhmm, "06:30");
  });

  it("o horizontal segue às 06:00 BRT (publish-youtube.ts)", () => {
    const sch = resolveYouTubeSchedule("261109", new Date("2026-11-09T03:00:00Z"));
    assert.equal(sch.mode, "scheduled");
    assert.equal(sch.publishAt, at("2026-11-09", "06:00"));
  });
});

describe("#12250 resolveShortTime por destino", () => {
  it("destino com horário próprio vs. default", () => {
    assert.deepEqual(
      { hhmm: resolveShortTime(sched, "261109", "youtube_shorts").hhmm, source: resolveShortTime(sched, "261109", "youtube_shorts").source },
      { hhmm: "06:30", source: "destination" },
    );
    assert.equal(resolveShortTime(sched, "261109", "instagram").source, "default");
  });

  it("dentro da janela encerrada a rotação histórica vale pra todos os destinos (re-derivar dias passados)", () => {
    // 261027 = 2º dia da rotação (08:00), inclusive no YouTube.
    assert.equal(resolveShortTime(sched, "261027", "youtube_shorts").hhmm, "08:00");
    assert.equal(resolveShortTime(sched, "261027", "instagram").hhmm, "08:00");
    assert.equal(resolveShortTime(sched, "261027").source, "rotation");
  });

  it("loader recusa o Short do YouTube às 06:00 (ou antes) do horizontal — vídeo relacionado precisa do horizontal público (#10811)", () => {
    for (const bad of ["06:00", "05:30"]) {
      assert.throws(() => loadShortScheduleConfig({ publishing: { shorts: { schedule: { ...FIXED, by_destination: { youtube_shorts: bad } } } } }), /depois das 06:00/);
    }
    assert.throws(() => loadShortScheduleConfig({ publishing: { shorts: { schedule: { ...FIXED, by_destination: { instagram: "12h" } } } } }), /by_destination\.instagram precisa ser HH:MM/);
    assert.throws(() => loadShortScheduleConfig({ publishing: { shorts: { schedule: { ...FIXED, by_destination: ["06:30"] } } } }), /by_destination precisa ser um objeto/);
  });

  it("loader recusa chave de destino desconhecida (typo `youtube_short`), em vez de cair em silêncio no default_time", () => {
    const load = (by: Record<string, string>) => loadShortScheduleConfig({ publishing: { shorts: { schedule: { ...FIXED, by_destination: by } } } });
    for (const bad of ["youtube_short", "Instagram", "linkedin", "facebook:", "facebook: diaria", "threads"]) {
      assert.throws(() => load({ [bad]: "06:30" }), /destino desconhecido/, bad);
    }
    // Ids válidos (inclusive `facebook:{slug}`) passam.
    const ok = load({ youtube_shorts: "06:30", "facebook:diaria": "12:30", instagram: "12:00", linkedin_profile: "12:00", linkedin_page_repost: "12:00", x: "12:00", tiktok: "12:00", threads_profile: "12:00", facebook_profile: "12:00" });
    assert.equal(resolveShortTime(ok, "261109", "facebook:diaria").hhmm, "12:30");
  });

  it("SCHEDULE_DESTINATION_IDS cobre todo id fixo que listShortDestinations emite", () => {
    // Todos os destinos ligados (só os campos que listShortDestinations lê).
    const allOn = { facebookPages: ["diaria"], instagram: true, linkedinProfile: true, linkedinPageRepost: true, x: true, tiktok: true, threadsProfile: true, facebookProfile: true };
    const all = listShortDestinations(allOn as unknown as ReturnType<typeof loadShortsConfig>);
    assert.equal(all.length, 9);
    for (const d of all) {
      if (d.kind === "facebook_page") continue;
      assert.ok(SCHEDULE_DESTINATION_IDS.has(d.id as never), d.id);
    }
  });
});

describe("#12250 guards de par timer×horário enxergam by_destination", () => {
  it("timerDueTimes inclui rotation_times, default_time e o horário próprio do destino", () => {
    const s = loadShortScheduleConfig({ publishing: { shorts: { schedule: { ...FIXED, by_destination: { youtube_shorts: "06:30", instagram: "07:15" } } } } });
    assert.deepEqual(timerDueTimes(s, "instagram").sort(), ["06:30", "07:15", "08:00", "12:00"]);
    assert.deepEqual(timerDueTimes(s, "threads_profile").sort(), ["06:30", "08:00", "12:00"]);
  });

  it("horário próprio fora da hora cheia sem diária logo depois é pego (Instagram 07:15 vs. diária 06:31)", () => {
    const s = loadShortScheduleConfig({ publishing: { shorts: { schedule: { ...FIXED, by_destination: { youtube_shorts: "06:30", instagram: "07:15" } } } } });
    const daily = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Shorts-Instagram")!.schedule as { kind: "daily"; hour: number; minute: number };
    const uncovered = timerDueTimes(s, "instagram").filter((t) => {
      const [h, m] = t.split(":").map(Number);
      if (m === 0) return false;
      const delta = daily.hour * 60 + daily.minute - (h * 60 + m);
      return !(delta >= 0 && delta <= 2);
    });
    assert.deepEqual(uncovered, ["07:15"]);
  });
});

describe("#12250 timers do 300 leem o horário do PRÓPRIO destino no config", () => {
  it("LinkedIn pessoal: 12:00 no config vivo; um override por destino chega no timer", () => {
    assert.equal(linkedinVerticalTime(LIVE, "261109").hhmm, "12:00");
    const override = structuredClone(LIVE);
    override.publishing.shorts.schedule.by_destination = { youtube_shorts: "06:30", linkedin_profile: "13:15" };
    assert.deepEqual(linkedinVerticalTime(override, "261109"), { hhmm: "13:15", at: at("2026-11-09", "13:15") });
  });

  it("Instagram e Threads pessoais esperam até 12:00 (às 07:00 BRT ainda é antes)", () => {
    const common = { config: LIVE, reviewedExists: true, registryRaws: [], aammdd: "261109", now: new Date(at("2026-11-09", "07:00")), videoSeen: true };
    const ig = decideInstagramTimerRun(common) as { kind: string; hhmm?: string };
    assert.equal(ig.kind, "wait");
    assert.equal(ig.hhmm, "12:00");
    const th = decideThreadsTimerRun(common) as { kind: string; hhmm?: string };
    assert.equal(th.kind, "wait");
    assert.equal(th.hhmm, "12:00");
  });
});

const REVIEWED = "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo do destaque. Segunda frase.\n\nPor que isso importa: porque sim.\n";
const pages: ResolvedFacebookPage[] = [{ slug: "diaria", enabled: true, pageId: "1", token: "t1", missing: [], utmContent: null }];
const SHORTS = { facebook_pages: ["diaria"], instagram: false, linkedin_profile: false, linkedin_page_repost: false, x: false, tiktok: false, threads_profile: false, youtube_shorts_api: true, schedule: FIXED };

function plan(now: string, extra: Record<string, unknown> = {}) {
  return planShortsPublish({
    aammdd: "261109",
    reviewedMd: REVIEWED,
    now: new Date(now),
    config: { publishing: { shorts: SHORTS } },
    pages,
    instagramReady: false,
    published: { aammdd: "261109", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: "https://diar.ia.br/p/x",
    youtubeApi: { ready: true },
    grid: [],
    ...extra,
  } as Parameters<typeof planShortsPublish>[0]);
}

describe("#12250 plano do publish-shorts", () => {
  it("rodando cedo: Short do YouTube agendado 06:30, página do Facebook 12:00", () => {
    const p = plan("2026-11-09T03:00:00Z"); // 00:00 BRT
    const yt = p.items.find((i) => i.destination === "youtube_shorts") as { action: string; scheduledAt: string | null };
    assert.equal(yt.action, "publish");
    assert.equal(yt.scheduledAt, at("2026-11-09", "06:30"));
    const fb = p.items.find((i) => i.destination === "facebook:diaria") as { action: string; scheduledAt: string | null };
    assert.equal(fb.action, "publish");
    assert.equal(fb.scheduledAt, at("2026-11-09", "12:00"));
    assert.equal(p.shortTime.hhmm, "12:00");
    assert.equal(p.destinationTimes.youtube_shorts.hhmm, "06:30");
    assert.equal(p.destinationTimes["facebook:diaria"].hhmm, "12:00");
    assert.ok(p.premises.some((m) => m.startsWith("horário de youtube_shorts: 06:30 BRT")), p.premises.join("\n"));
  });

  it("YouTube Studio guiado (sem credencial): o passo carrega o horário do Short, não o dos outros destinos", () => {
    const p = plan("2026-11-09T03:00:00Z", { youtubeApi: { ready: false, reason: "sem token" } });
    const yt = p.items.find((i) => i.destination === "youtube_shorts") as { action: string; at?: string; detail: string };
    assert.equal(yt.action, "guided");
    assert.equal(yt.at, at("2026-11-09", "06:30"));
    assert.match(yt.detail, /06:30 BRT/);
  });

  it("edição rodando depois das 12:00: tudo publica na hora, com premissa", () => {
    const p = plan("2026-11-09T15:30:00Z"); // 12:30 BRT
    const fb = p.items.find((i) => i.destination === "facebook:diaria") as { action: string; scheduledAt: string | null };
    assert.equal(fb.action, "publish");
    assert.equal(fb.scheduledAt, null);
    const yt = p.items.find((i) => i.destination === "youtube_shorts") as { scheduledAt: string | null };
    assert.equal(yt.scheduledAt, null);
    assert.ok(p.premises.some((m) => /facebook:diaria: 12:00 BRT do dia da edição já passou/.test(m)), p.premises.join("\n"));
  });

  it("entre 06:30 e 12:00: o Short já publica na hora, a página ainda agenda 12:00", () => {
    const p = plan("2026-11-09T12:00:00Z"); // 09:00 BRT
    assert.equal((p.items.find((i) => i.destination === "youtube_shorts") as { scheduledAt: string | null }).scheduledAt, null);
    assert.equal((p.items.find((i) => i.destination === "facebook:diaria") as { scheduledAt: string | null }).scheduledAt, at("2026-11-09", "12:00"));
  });
});

describe("#12250 planShortSlots e a vertical extra", () => {
  it("timeFor dá horário por destino; colisão com post da mesma conta mantém o horário e avisa", () => {
    const dests: ShortDestination[] = [{ id: "facebook:diaria", kind: "facebook_page", mode: "api", slug: "diaria" }];
    const slots = planShortSlots({
      aammdd: "261109",
      time: { hhmm: "12:00", source: "default", reason: "x" },
      timeAt: at("2026-11-09", "12:00"),
      timeFor: () => ({ time: { hhmm: "12:00", source: "default", reason: "x" }, at: at("2026-11-09", "12:00") }),
      destinations: dests,
      cfg: { instagramAuthorPage: null },
      grid: [{ account: "facebook:diaria", at: at("2026-11-09", "12:15") }],
    });
    assert.equal(slots[0].at, at("2026-11-09", "12:00"));
    assert.equal(slots[0].rule, "fixed-time");
    assert.match(slots[0].warning ?? "", /12:15 BRT/);
  });

  it("a vertical extra pula os dois horários fixos da principal (06:30 e 12:00) e sai às 08:00", () => {
    const t = extraVerticalTime(sched, "261110");
    assert.equal(t.hhmm, "08:00");
    assert.equal(t.collides, false);
  });
});
