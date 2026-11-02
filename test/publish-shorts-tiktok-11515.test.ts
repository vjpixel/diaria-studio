/**
 * test/publish-shorts-tiktok-11515.test.ts (#11515)
 *
 * TikTok como destino do vertical pela Buffer (decisão do editor de
 * 28/10/2026): o plano devolve um passo `buffer` com o canal e o
 * `metadata.tiktok`, o `--publish` só sobe o vídeo (R2), e o registro vem do
 * `--mark tiktok=buffer:{id}`, que grava `scheduled`, nunca `published`
 * (#573). Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SHORTS_CONFIG,
  TIKTOK_TITLE_MAX_CHARS,
  buildTikTokPost,
  listShortDestinations,
  loadShortsConfig,
  shortDestinationAccount,
} from "../scripts/lib/diaria/short-video.ts";
import { planCoverDestination } from "../scripts/lib/diaria/short-cover.ts";
import { buildMarkEntry, parseMarkArg, parseThumbnailOffsetArg, planShortsPublish, prepareBufferItem, assignShortsDestinationOwners } from "../scripts/publish-shorts.ts";
import { resolveShortEntryState } from "../scripts/lib/publish-state.ts";
import { EXTERNAL_UTM_SURFACES } from "../scripts/lib/shared/utm-registry.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANNEL = "6ae86defe29c69a17136bace";
const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const shorts = {
  facebook_pages: ["diaria"],
  instagram: false,
  linkedin_profile: false,
  linkedin_page_repost: false,
  x: true,
  tiktok: true,
  tiktok_buffer_channel_id: CHANNEL,
  threads_profile: false,
  facebook_profile: false,
  schedule: SCHEDULE,
};
const D1 = { title: "Você já viu IA mentir. Já viu roubar?", body: "Um modelo da **OpenAI** gastou o saldo de terceiros. O caso foi descoberto depois." };
const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA\n\n[${D1.title}](https://example.com/a)\n\n${D1.body}\n\nPor que isso importa: x.\n`;
const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
const base = {
  aammdd: "261103",
  reviewedMd: REVIEWED,
  editionUrl: "https://diar.ia.br/p/x",
  config: { publishing: { shorts } },
  pages: [page("diaria")],
  instagramReady: false,
  published: { aammdd: "261103", entries: [] },
  video: { path: "/v/short.mp4", exists: true, sizeBytes: 10 },
  publicVideo: { ready: true } as const,
  youtubeApi: { ready: true } as const,
};
const BEFORE = new Date("2026-11-03T03:00:00Z"); // 00:00 BRT

describe("#11515 config do TikTok", () => {
  it("desligado no código; ligado exige o canal da Buffer", () => {
    assert.equal(DEFAULT_SHORTS_CONFIG.tiktok, false);
    assert.ok(!listShortDestinations(DEFAULT_SHORTS_CONFIG).some((d) => d.id === "tiktok"));
    assert.throws(() => loadShortsConfig({ publishing: { shorts: { ...shorts, tiktok_buffer_channel_id: undefined } } }), /tiktok_buffer_channel_id/);
    assert.throws(() => loadShortsConfig({ publishing: { shorts: { ...shorts, tiktok_buffer_channel_id: "a b" } } }), /tiktok_buffer_channel_id/);
    const cfg = loadShortsConfig({ publishing: { shorts } });
    assert.equal(cfg.tiktokBufferChannelId, CHANNEL);
    const ids = listShortDestinations(cfg).map((d) => d.id);
    assert.ok(ids.indexOf("tiktok") === ids.indexOf("x") + 1, ids.join(","));
  });

  it("o platform.config.json real liga o TikTok com o canal conectado em 02/11", () => {
    const cfg = loadShortsConfig(JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")));
    assert.equal(cfg.tiktok, true);
    assert.equal(cfg.tiktokBufferChannelId, CHANNEL);
  });

  it("conta própria na grade (não colide com o X)", () => {
    const cfg = loadShortsConfig({ publishing: { shorts } });
    const tk = listShortDestinations(cfg).find((d) => d.id === "tiktok")!;
    const x = listShortDestinations(cfg).find((d) => d.id === "x")!;
    assert.ok(shortDestinationAccount(tk, cfg));
    assert.notEqual(shortDestinationAccount(tk, cfg), shortDestinationAccount(x, cfg));
  });
});

describe("#11515 legenda do TikTok", () => {
  it("título, gancho, a frase da newsletter e hashtags; sem link nem #Shorts", () => {
    const p = buildTikTokPost({ d1: D1 });
    assert.match(p.caption, /^Você já viu IA mentir\. Já viu roubar\?\n\nUm modelo da OpenAI gastou o saldo de terceiros\./);
    assert.match(p.caption, /A diar\.ia\.br é a newsletter/);
    assert.doesNotMatch(p.caption, /https?:\/\/|utm_|#Shorts/);
    assert.equal(p.title, "Você já viu IA mentir. Já viu roubar?");
  });

  it("título longo é cortado no teto do metadata.tiktok.title", () => {
    const p = buildTikTokPost({ d1: { title: "a".repeat(200), body: "x." } });
    assert.equal(Array.from(p.title).length, TIKTOK_TITLE_MAX_CHARS);
    assert.ok(p.title.endsWith("…"));
  });
});

describe("#11515 plano e --publish do TikTok", () => {
  it("passo buffer com canal, metadata.tiktok (isAiGenerated false) e horário do vertical", () => {
    const p = planShortsPublish({ ...base, now: BEFORE });
    const item = p.items.find((i) => i.destination === "tiktok") as any;
    assert.equal(item.action, "buffer");
    assert.equal(item.mode, "guided");
    assert.equal(item.channelId, CHANNEL);
    assert.deepEqual(item.tiktok, { title: D1.title, isAiGenerated: false });
    assert.ok(item.scheduledAt, "antes do horário: dueAt futuro");
    assert.match(item.detail, /--mark tiktok=buffer:/);
    const owner = p.owners.find((o) => o.destination === "tiktok")!;
    assert.equal(owner.by, "agent");
    assert.equal(p.cover.destinations.tiktok, "automatic");
  });

  it("sem URL pública (R2) fica pendente, não terminal (mesma regra do X, #11478)", () => {
    const p = planShortsPublish({ ...base, publicVideo: { ready: false, reason: "sem R2" }, now: BEFORE });
    const item = p.items.find((i) => i.destination === "tiktok") as any;
    assert.equal(item.action, "skip_missing_credentials");
    assert.equal(item.cause, "public_video");
  });

  it("--publish devolve o que a skill passa ao create_post (canal e metadata)", async () => {
    const p = planShortsPublish({ ...base, now: BEFORE });
    const item = p.items.find((i) => i.destination === "tiktok") as any;
    const r = await prepareBufferItem(item, async () => "https://media.diar.ia.br/shorts/x.mp4", 1500);
    assert.ok(r.ok);
    assert.deepEqual(r.buffer, {
      text: item.caption,
      dueAt: item.scheduledAt,
      videoUrl: "https://media.diar.ia.br/shorts/x.mp4",
      thumbnailOffset: 1500,
      channelId: CHANNEL,
      metadata: { tiktok: { title: D1.title, isAiGenerated: false } },
    });
    // O X segue sem canal/metadata no buffer (o canal dele vem do config do Twitter).
    const x = p.items.find((i) => i.destination === "x") as any;
    const rx = await prepareBufferItem(x, async () => "u");
    assert.equal(rx.buffer!.channelId, undefined);
    assert.equal(rx.buffer!.metadata, undefined);
  });

  it("capa: só o thumbnailOffset, como o X", () => {
    const ctx = { coverPath: "/c.jpg", coverUploadReady: true, bufferOffsetMs: 2000 };
    assert.equal(planCoverDestination({ destination: "tiktok" }, ctx), "thumbnail_offset 2000 ms");
  });
});

describe("#11515 --mark tiktok=buffer:{id}", () => {
  it("registra scheduled (nunca published) e a capa do offset", () => {
    const mark = parseMarkArg("tiktok=buffer:abc123");
    assert.deepEqual(mark, { destination: "tiktok", url: null, bufferId: "abc123" });
    const built = buildMarkEntry(mark, "2026-11-03T11:00:00Z", "2026-11-03T03:00:00Z", 500);
    assert.ok(built.ok);
    if (!built.ok) return;
    assert.equal(built.entry.destination, "tiktok");
    assert.equal(built.entry.status, "scheduled");
    assert.equal(built.entry.id, "buffer:abc123");
    assert.deepEqual(built.entry.cover, { method: "thumbnail_offset", ok: true, offset_ms: 500 });
    assert.equal(resolveShortEntryState(built.entry, new Date("2026-11-03T12:00:00Z")), "unknown", "passado o horário, só o get_post confirma");
    assert.deepEqual(parseThumbnailOffsetArg("500", true), { ok: true, value: 500 });
  });

  it("confirmação pela URL e recusa de buffer: em destino que não é da Buffer", () => {
    assert.deepEqual(parseMarkArg("tiktok=https://www.tiktok.com/@diar.ia.br/video/1"), { destination: "tiktok", url: "https://www.tiktok.com/@diar.ia.br/video/1" });
    assert.throws(() => parseMarkArg("youtube_shorts=buffer:abc"), /DESTINO=URL/);
    // Regressão: o X segue igual.
    assert.deepEqual(parseMarkArg("x=buffer:zz"), { destination: "x", url: null, bufferId: "zz" });
  });

  it("owners: o passo da Buffer é do agente nesta rodada", () => {
    const owners = assignShortsDestinationOwners(
      [{ destination: "tiktok", mode: "guided", action: "buffer", caption: "t", scheduledAt: null, detail: "" }],
      { aammdd: "261103", now: BEFORE, instagramViaTimer: false },
    );
    assert.equal(owners[0].by, "agent");
  });
});

describe("#11515 bio do TikTok no inventário de UTM", () => {
  it("perfil-tiktok declarado, ainda sem appliedAt (conta Empresa pendente)", () => {
    const s = EXTERNAL_UTM_SURFACES.find((x) => x.id === "perfil-tiktok");
    assert.ok(s);
    assert.equal(s!.source, "tiktok");
    assert.equal(s!.campaign, "perfil-tiktok");
    assert.equal(s!.medium, "bio");
    assert.equal(s!.appliedAt, undefined);
  });
});
