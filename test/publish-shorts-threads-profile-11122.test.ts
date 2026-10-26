/**
 * test/publish-shorts-threads-profile-11122.test.ts (#11122, filha da #10772)
 *
 * Threads PESSOAL no `publish-shorts.ts`: destino `threads_profile`, fail-soft
 * sem `THREADS_PERSONAL_*`, `send_unknown` conta como feito (nunca re-posta) e
 * `--mark threads_profile=URL` registra o resultado conferido. Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THREADS_PERSONAL_ACCOUNT,
  isDestinationDone,
  knownDestinationIds,
  loadShortsConfig,
  parseShortsPublishedFile,
  upsertShortEntry,
} from "../scripts/lib/diaria/short-video.ts";
import { MARKABLE_DESTINATIONS, buildMarkEntry, parseMarkArg, planShortsPublish } from "../scripts/publish-shorts.ts";
import { THREADS_PROFILE_DESTINATION } from "../scripts/lib/threads-personal-video.ts";
import { gridFromShortsPublished } from "../scripts/lib/social-slot-planner.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const SCHEDULE = { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };
const D1 = { title: "Você já viu IA mentir. Já viu roubar?", body: "Um modelo da OpenAI gastou o saldo de terceiros. O caso foi descoberto depois." };
const EDITION_URL = "https://diar.ia.br/p/voce-ja-viu-ia-mentir-ja-viu-roubar";
const YT = "https://youtu.be/MMyBVHVQELI";
const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[${D1.title}](https://alignment.openai.com/x)

${D1.body}

Por que isso importa: porque sim.
`;
const CONFIG = {
  publishing: { shorts: { facebook_pages: [], instagram: false, linkedin_profile: false, linkedin_page_repost: false, x: false, threads_profile: true, schedule: SCHEDULE } },
};
const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });

const base = {
  aammdd: "261022",
  reviewedMd: REVIEWED,
  config: CONFIG,
  pages: [page("diaria")],
  instagramReady: false,
  published: { aammdd: "261022", entries: [] },
  video: { path: "v.mp4", exists: true, sizeBytes: 10 },
  editionUrl: EDITION_URL,
  youtubeVideoUrl: YT,
  threadsPersonal: { ready: true } as const,
  publicVideo: { ready: true } as const,
};
const item = (p: ReturnType<typeof planShortsPublish>) => p.items.find((i) => i.destination === "threads_profile") as any;

describe("#11122 config e destino", () => {
  it("threads_profile entra no default e é desligável; não-boolean lança", () => {
    assert.equal(loadShortsConfig(undefined).threadsProfile, true);
    assert.ok(knownDestinationIds(loadShortsConfig(undefined)).has("threads_profile"));
    assert.equal(loadShortsConfig({ publishing: { shorts: { ...CONFIG.publishing.shorts, threads_profile: false } } }).threadsProfile, false);
    assert.throws(() => loadShortsConfig({ publishing: { shorts: { ...CONFIG.publishing.shorts, threads_profile: "sim" } } }), /threads_profile precisa ser boolean/);
  });

  it("o id do destino é o mesmo do módulo do Threads pessoal", () => {
    assert.equal(THREADS_PROFILE_DESTINATION, "threads_profile");
  });
});

describe("#11122 plano", () => {
  it("sem THREADS_PERSONAL_*: pulado com aviso (fail-soft), não some", () => {
    const p = planShortsPublish({ ...base, now: new Date("2026-10-22T16:00:00Z"), threadsPersonal: { ready: false, reason: "threads_profile pulado: THREADS_PERSONAL_ACCESS_TOKEN ausente(s)." } });
    assert.equal(item(p).action, "skip_missing_credentials");
    assert.ok(p.warnings.some((w) => w.startsWith("threads_profile: threads_profile pulado")));
    assert.ok(!p.slots.some((s) => s.destination === "threads_profile"), "sem credencial não disputa a grade");
  });

  it("credencial não conferida (campo ausente) também pula", () => {
    const { threadsPersonal: _drop, ...rest } = base;
    assert.equal(item(planShortsPublish({ ...rest, now: new Date("2026-10-22T16:00:00Z") })).action, "skip_missing_credentials");
  });

  it("sem R2: pulado (o Threads só recebe vídeo por URL pública)", () => {
    const p = planShortsPublish({ ...base, now: new Date("2026-10-22T16:00:00Z"), publicVideo: { ready: false, reason: "falta SHORTS_R2_BUCKET" } });
    assert.equal(item(p).action, "skip_missing_credentials");
    assert.ok(p.warnings.some((w) => w.startsWith("threads_profile:") && w.includes("SHORTS_R2_BUCKET")));
  });

  it("antes do horário: pending_schedule (a Threads API não agenda); conta threads:pessoal na grade", () => {
    const p = planShortsPublish({ ...base, now: new Date("2026-10-22T03:00:00Z") });
    assert.equal(item(p).action, "pending_schedule");
    assert.equal(p.slots.find((s) => s.destination === "threads_profile")?.account, THREADS_PERSONAL_ACCOUNT);
  });

  it("no horário (ou --now): publish com texto do Threads (UTM threads/video/{AAMMDD})", () => {
    const p = planShortsPublish({ ...base, now: new Date("2026-10-22T03:00:00Z"), forceNow: true });
    const it0 = item(p);
    assert.equal(it0.action, "publish");
    assert.ok(it0.caption.includes("utm_source=threads&utm_medium=video&utm_campaign=261022"), it0.caption);
    assert.ok(it0.caption.includes(YT));
  });

  it("muito depois do horário: skip_late apontando o --mark threads_profile", () => {
    const p = planShortsPublish({ ...base, now: new Date("2026-10-23T12:00:00Z") });
    assert.equal(item(p).action, "skip_late");
    assert.match(item(p).detail, /--mark threads_profile=URL/);
  });

  it("send_unknown registrado conta como feito: a rodada seguinte NÃO re-posta", () => {
    const published = upsertShortEntry(
      { aammdd: "261022", entries: [] },
      { destination: "threads_profile", status: "send_unknown", id: "send_unknown-2026-10-22T15:00:00Z", scheduled_at: null, at: "2026-10-22T15:00:00Z" },
    );
    const roundTrip = parseShortsPublishedFile(JSON.stringify(published), "261022");
    assert.equal(isDestinationDone(roundTrip, "threads_profile"), true);
    const p = planShortsPublish({ ...base, now: new Date("2026-10-22T16:00:00Z"), forceNow: true, published: roundTrip });
    assert.equal(item(p).action, "skip_done");
    // e o registro ocupa a grade do perfil pessoal do Threads
    assert.deepEqual(gridFromShortsPublished(roundTrip).map((s) => s.account), [THREADS_PERSONAL_ACCOUNT]);
  });
});

describe("#11122 --mark threads_profile", () => {
  it("allowlist aceita threads_profile e grava published com a URL", () => {
    assert.ok(MARKABLE_DESTINATIONS.has("threads_profile"));
    const mark = parseMarkArg("threads_profile=https://www.threads.com/@vjpixel/post/ABC");
    const built = buildMarkEntry(mark, undefined, "2026-10-22T16:00:00Z");
    assert.ok(built.ok);
    if (built.ok) {
      assert.equal(built.entry.destination, "threads_profile");
      assert.equal(built.entry.status, "published");
      assert.equal(built.entry.url, "https://www.threads.com/@vjpixel/post/ABC");
    }
  });

  it("--mark sobre um send_unknown troca o registro pelo published conferido", () => {
    const unknown = upsertShortEntry({ aammdd: "261022", entries: [] }, { destination: "threads_profile", status: "send_unknown", id: "send_unknown-x", at: "2026-10-22T15:00:00Z" });
    const built = buildMarkEntry(parseMarkArg("threads_profile=https://www.threads.com/@vjpixel/post/ABC"), undefined, "2026-10-22T16:00:00Z");
    assert.ok(built.ok);
    const after = upsertShortEntry(unknown, (built as { ok: true; entry: any }).entry);
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0].status, "published");
  });
});
