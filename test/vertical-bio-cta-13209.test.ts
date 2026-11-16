/**
 * test/vertical-bio-cta-13209.test.ts (#13209)
 *
 * Decisão do editor no briefing do overnight 261116:
 *   1. "Vídeo completo: link na bio" só entra na legenda do vertical que tem o
 *      MESMO título de um horizontal publicado (além da fala `cta_vertical`).
 *   2. TikTok (conta pessoal, sem campo Site na bio): a linha só entra com a
 *      flag `publishing.shorts.tiktok_bio_link`, default desligada.
 * Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TIKTOK_NO_BIO_CTA_LINE,
  TIKTOK_NO_BIO_CTA_MAX_CHARS,
  VERTICAL_BIO_CTA_LINE,
  buildTikTokPost,
  loadShortsConfig,
  normalizeVideoTitle,
  resolveVerticalBioCta,
} from "../scripts/lib/diaria/short-video.ts";
import { planShortsPublish, verticalBioCtaFromHorizontal } from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const D1 = {
  title: "Você já viu IA mentir. Já viu roubar?",
  body: "Um modelo da **OpenAI** gastou o saldo de uma carteira de terceiros. O caso foi descoberto depois.",
};
const URL_H = "https://youtu.be/AbCdEfGhIjK";
const BIO = /Vídeo completo: link na bio/;
const NO_BIO_CTA = /Vídeo completo no YouTube: @diariabr/; // #13274

const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[${D1.title}](https://alignment.openai.com/x)

${D1.body}

Por que isso importa: porque sim.
`;

function page(slug: string): ResolvedFacebookPage {
  return { slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null };
}

const shortsCfg = {
  facebook_pages: ["diaria"],
  instagram: true,
  linkedin_profile: false,
  linkedin_page_repost: false,
  x: false,
  threads_profile: true,
  tiktok: true,
  tiktok_buffer_channel_id: "tiktokchan01",
  facebook_profile: false,
  schedule: { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" },
};

function plan(opts: { recordTitle: string | null; noVideo?: boolean; ctaVertical?: boolean; tiktokBioLink?: boolean; only?: string[]; writer?: string }) {
  return planShortsPublish({
    aammdd: "261022",
    reviewedMd: REVIEWED,
    config: { publishing: { shorts: { ...shortsCfg, ...(opts.tiktokBioLink === undefined ? {} : { tiktok_bio_link: opts.tiktokBioLink }) } } },
    pages: [page("diaria")],
    instagramReady: true,
    linkedinPersonal: { ready: true } as const,
    threadsPersonal: { ready: true } as const,
    publicVideo: { ready: true } as const,
    published: { aammdd: "261022", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: "https://diar.ia.br/p/x",
    now: new Date("2026-10-22T03:00:00Z"),
    ...(opts.only ? { only: opts.only } : {}),
    ...(opts.writer ? { writer: opts.writer } : {}),
    horizontalVideo: { recordTitle: opts.recordTitle, noVideo: opts.noVideo ?? false, url: opts.noVideo ? null : URL_H, ctaVertical: opts.ctaVertical ?? true },
  } as Parameters<typeof planShortsPublish>[0]);
}

const textOf = (p: ReturnType<typeof planShortsPublish>, id: string): string => {
  const it = p.items.find((i) => i.destination === id) as { caption?: string; text?: string } | undefined;
  assert.ok(it, `destino ${id} ausente`);
  return String(it.caption ?? it.text ?? "");
};

describe("#13209 ponto 1: linha da bio só com o mesmo título do horizontal publicado", () => {
  it("resolveVerticalBioCta: fala + mesmo título liga; título diferente, sem registro ou sem vídeo desliga", () => {
    assert.deepEqual(resolveVerticalBioCta({ ctaFala: true, d1Title: D1.title, recordTitle: D1.title }), { ctaVertical: true, reason: null, criterio: "titulo" });
    assert.equal(resolveVerticalBioCta({ ctaFala: true, d1Title: D1.title, recordTitle: "Outro título" }).reason, "titulo-diferente");
    assert.equal(resolveVerticalBioCta({ ctaFala: true, d1Title: D1.title, recordTitle: null }).reason, "sem-horizontal-publicado");
    assert.equal(resolveVerticalBioCta({ ctaFala: true, d1Title: D1.title, recordTitle: D1.title, noVideo: true }).reason, "sem-horizontal-publicado");
    assert.equal(resolveVerticalBioCta({ ctaFala: false, d1Title: D1.title, recordTitle: D1.title }).reason, "sem-fala");
  });

  it("comparação ignora caixa, espaços e markdown do D1", () => {
    assert.equal(normalizeVideoTitle("  **Você**   já viu IA mentir. "), normalizeVideoTitle("você já viu ia mentir."));
    assert.equal(resolveVerticalBioCta({ ctaFala: true, d1Title: `**${D1.title}**`, recordTitle: `  ${D1.title.toUpperCase()} ` }).ctaVertical, true);
  });

  it("plano: título igual leva a linha no Instagram e no Threads; título diferente tira e registra a premissa", () => {
    const same = plan({ recordTitle: D1.title });
    assert.match(textOf(same, "threads_profile"), BIO);
    const sameIg = plan({ recordTitle: D1.title, only: ["instagram"], writer: "instagram-timer" });
    assert.match(textOf(sameIg, "instagram"), BIO);

    const diff = plan({ recordTitle: "IA rouba carteira: o caso que ninguém viu" });
    assert.doesNotMatch(textOf(diff, "threads_profile"), BIO);
    assert.equal(diff.horizontalLinks?.threads_profile.replyText, undefined, "sem a linha, o Threads não planeja a resposta");
    assert.ok(!diff.warnings.some((w) => w.includes("bio NÃO conferida")), "sem a linha, nada de aviso de bio");
    assert.ok(diff.premises.some((p) => p.includes(VERTICAL_BIO_CTA_LINE) && p.includes("título do vertical difere") && p.includes("#13209")), diff.premises.join("\n"));
    const diffIg = plan({ recordTitle: "Outro", only: ["instagram"], writer: "instagram-timer" });
    assert.doesNotMatch(textOf(diffIg, "instagram"), BIO);
  });

  it("plano sem horizontal publicado: sem linha, mas o aviso da fala sem horizontal continua", () => {
    const p = plan({ recordTitle: null, noVideo: true });
    assert.doesNotMatch(textOf(p, "threads_profile"), BIO);
    assert.ok(p.warnings.some((w) => w.startsWith("threads_profile: roteiro com cta_vertical")), p.warnings.join("\n"));
    assert.ok(p.premises.some((x) => x.includes("sem horizontal publicado")));
  });

  it("rotas de troca de texto usam a mesma regra", () => {
    assert.equal(verticalBioCtaFromHorizontal({ recordTitle: D1.title, noVideo: false, ctaVertical: true }, D1.title), true);
    assert.equal(verticalBioCtaFromHorizontal({ recordTitle: "Outro", noVideo: false, ctaVertical: true }, D1.title), false);
    assert.equal(verticalBioCtaFromHorizontal({ recordTitle: D1.title, noVideo: false }, D1.title), false);
  });
});

describe("#13209 ponto 2: TikTok só com tiktok_bio_link", () => {
  it("buildTikTokPost: linha só com ctaVertical E a flag", () => {
    assert.doesNotMatch(buildTikTokPost({ d1: D1, ctaVertical: true }).caption, BIO);
    assert.doesNotMatch(buildTikTokPost({ d1: D1, ctaVertical: true, tiktokBioLink: false }).caption, BIO);
    assert.doesNotMatch(buildTikTokPost({ d1: D1, ctaVertical: false, tiktokBioLink: true }).caption, BIO);
    assert.match(buildTikTokPost({ d1: D1, ctaVertical: true, tiktokBioLink: true }).caption, BIO);
  });

  it("loadShortsConfig: ausente = false; não-boolean lança", () => {
    assert.equal(loadShortsConfig({ publishing: { shorts: shortsCfg } }).tiktokBioLink, false);
    assert.equal(loadShortsConfig({ publishing: { shorts: { ...shortsCfg, tiktok_bio_link: true } } }).tiktokBioLink, true);
    assert.throws(() => loadShortsConfig({ publishing: { shorts: { ...shortsCfg, tiktok_bio_link: "sim" } } }), /tiktok_bio_link/);
  });

  it("plano: default desligado tira a linha do TikTok e o aviso de bio dele; Threads segue com a linha", () => {
    const off = plan({ recordTitle: D1.title });
    assert.doesNotMatch(textOf(off, "tiktok"), BIO);
    assert.match(textOf(off, "threads_profile"), BIO);
    assert.ok(!off.warnings.some((w) => w.startsWith("tiktok: bio NÃO conferida")));
    assert.match(off.horizontalLinks!.tiktok.note, /tiktok_bio_link desligada/);
    const on = plan({ recordTitle: D1.title, tiktokBioLink: true });
    assert.match(textOf(on, "tiktok"), BIO);
    assert.ok(on.warnings.some((w) => w.startsWith("tiktok: bio NÃO conferida")));
  });

  it("#13274: flag desligada troca a linha da bio pela chamada sem link; ligada, volta a da bio", () => {
    assert.ok(Array.from(TIKTOK_NO_BIO_CTA_LINE).length <= TIKTOK_NO_BIO_CTA_MAX_CHARS);
    assert.doesNotMatch(TIKTOK_NO_BIO_CTA_LINE, /link na bio/);
    const off = buildTikTokPost({ d1: D1, ctaVertical: true, tiktokBioLink: false }).caption;
    assert.doesNotMatch(off, /link na bio/);
    assert.match(off, NO_BIO_CTA);
    assert.match(buildTikTokPost({ d1: D1, ctaVertical: true }).caption, NO_BIO_CTA);
    assert.doesNotMatch(buildTikTokPost({ d1: D1, ctaVertical: true, tiktokBioLink: true }).caption, NO_BIO_CTA);
    for (const flag of [true, false]) assert.doesNotMatch(buildTikTokPost({ d1: D1, ctaVertical: false, tiktokBioLink: flag }).caption, NO_BIO_CTA);
  });

  it("#13274 plano: TikTok sem 'link na bio' e com a chamada sem link; Threads segue com a bio; título diferente tira as duas", () => {
    const off = plan({ recordTitle: D1.title });
    assert.doesNotMatch(textOf(off, "tiktok"), /link na bio/);
    assert.match(textOf(off, "tiktok"), NO_BIO_CTA);
    assert.match(textOf(off, "threads_profile"), BIO);
    assert.match(off.horizontalLinks!.tiktok.note, /#13274/);
    assert.doesNotMatch(textOf(plan({ recordTitle: D1.title, tiktokBioLink: true }), "tiktok"), NO_BIO_CTA);
    const diff = plan({ recordTitle: "Outro título qualquer" });
    assert.doesNotMatch(textOf(diff, "tiktok"), NO_BIO_CTA);
    assert.doesNotMatch(textOf(diff, "tiktok"), BIO);
  });

  it("platform.config.json versionado mantém a flag desligada", () => {
    const cfg = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
    assert.equal(cfg.publishing.shorts.tiktok_bio_link, false);
    assert.equal(loadShortsConfig(cfg).tiktokBioLink, false);
  });
});
