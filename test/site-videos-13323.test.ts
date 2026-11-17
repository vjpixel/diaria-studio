/**
 * test/site-videos-13323.test.ts (#13323)
 *
 * Vídeos da diar.ia.br no site: seção "Vídeos" na home (6 horizontais mais
 * recentes) e página `/videos` (todos). A fonte é a página da edição já
 * commitada (`VideoObject`/player do #12080) — sem `data/`, sem YouTube API.
 * Travado: ordem por data, edição sem vídeo pulada, edição futura fora,
 * limite de 6 na home, fallback de título, UTM do registry, JSON-LD
 * `ItemList`, e o repo real (página gerada em dia, sitemap e allowlist).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  HOME_VIDEO_LIMIT,
  KNOWN_STATIC_SITEMAP_PATHS,
  buildIndexHtml,
  buildVideoFeed,
  extractPageVideo,
  siteVideoYouTubeUrl,
  siteVideosSubscribeUrl,
} from "../scripts/lib/site-home-page.ts";
import { buildVideosItemListJsonLd, buildVideosPageHtml, VIDEOS_PAGE_FILE } from "../scripts/lib/site-videos-page.ts";
import { buildVideoEmbedHtml, buildVideoObjectJsonLd } from "../scripts/lib/site-page-video.ts";
import { SITE_VIDEOS_UTM, UTM_EMITTERS } from "../scripts/lib/shared/utm-registry.ts";
import { DIARIA_YOUTUBE_SUBSCRIBE_URL } from "../scripts/lib/canonical-urls.ts";

const ROOT = join(import.meta.dirname, "..");
const PUBLIC = join(ROOT, "workers", "site", "public");

/** Página de edição com vídeo, no formato que `buildArchivePageHtml` grava (#12080). */
function pageWithVideo(title: string, videoId: string, name?: string, uploadDate = "2026-11-10T09:00:00Z"): string {
  const ld = name
    ? buildVideoObjectJsonLd({ videoId, name, description: `${title}.`, uploadDate })
    : "";
  return `<html><head><title>${title}</title><meta name="description" content="${title}. D2 | D3">${ld}</head><body>${buildVideoEmbedHtml(videoId, title)}</body></html>`;
}

function pageWithoutVideo(title: string): string {
  return `<html><head><title>${title}</title></head><body><img class="hero" src="https://x/y.jpg"></body></html>`;
}

function sitemap(entries: Array<[string, string]>): string {
  return `<urlset>${entries.map(([slug, d]) => `<url><loc>https://diar.ia.br/p/${slug}</loc><lastmod>${d}</lastmod></url>`).join("")}</urlset>`;
}

describe("#13323 — extractPageVideo", () => {
  it("lê id, título e data do VideoObject", () => {
    assert.deepEqual(extractPageVideo(pageWithVideo("D1", "MJXHg3HekNE", "Título do vídeo")), {
      videoId: "MJXHg3HekNE",
      name: "Título do vídeo",
      uploadDate: "2026-11-10T09:00:00Z",
    });
  });

  it("sem JSON-LD, cai no id do player", () => {
    assert.deepEqual(extractPageVideo(pageWithVideo("D1", "abcdefghijk")), { videoId: "abcdefghijk", name: "", uploadDate: null });
  });

  it("página sem player = null (o JSON-LD NewsArticle não conta)", () => {
    const html = `<script type="application/ld+json">{"@type":"NewsArticle","headline":"x"}</script>${pageWithoutVideo("x")}`;
    assert.equal(extractPageVideo(html), null);
  });
});

describe("#13323 — buildVideoFeed", () => {
  // Fixture da issue: 3 edições, 1 sem vídeo.
  const pages: Record<string, string> = {
    nova: pageWithVideo("Edição nova", "aaaaaaaaaaa", "Vídeo novo"),
    meio: pageWithoutVideo("Edição sem vídeo"),
    velha: pageWithVideo("Edição velha", "bbbbbbbbbbb"),
  };
  const xml = sitemap([["velha", "2026-11-03"], ["nova", "2026-11-10"], ["meio", "2026-11-05"]]);
  const read = (s: string) => pages[s] ?? null;

  it("mais recente primeiro, pula a edição sem vídeo, título cai no da edição", () => {
    const feed = buildVideoFeed(xml, read, Infinity, { todayBrt: "2026-11-16" });
    assert.deepEqual(
      feed.map((v) => [v.slug, v.videoId, v.title, v.date]),
      [
        ["nova", "aaaaaaaaaaa", "Vídeo novo", "2026-11-10"],
        ["velha", "bbbbbbbbbbb", "Edição velha", "2026-11-03"],
      ],
    );
    assert.equal(feed[0].url, "https://diar.ia.br/p/nova");
    assert.equal(feed[1].uploadDate, "2026-11-03", "sem VideoObject, a data editorial");
  });

  it("edição com data futura fica fora (#7686)", () => {
    const feed = buildVideoFeed(xml, read, Infinity, { todayBrt: "2026-11-09" });
    assert.deepEqual(feed.map((v) => v.slug), ["velha"]);
  });

  it("limite da home: 6, sem a edição sem vídeo consumir vaga", () => {
    const many: Record<string, string> = {};
    const entries: Array<[string, string]> = [];
    for (let i = 0; i < 9; i++) {
      const slug = `e${i}`;
      many[slug] = i === 1 ? pageWithoutVideo(slug) : pageWithVideo(slug, `vid${String(i).padStart(8, "0")}`);
      entries.push([slug, `2026-11-${String(20 - i).padStart(2, "0")}`]);
    }
    const feed = buildVideoFeed(sitemap(entries), (s) => many[s] ?? null, HOME_VIDEO_LIMIT, { todayBrt: "2026-11-30" });
    assert.equal(HOME_VIDEO_LIMIT, 6);
    assert.deepEqual(feed.map((v) => v.slug), ["e0", "e2", "e3", "e4", "e5", "e6"]);
  });
});

describe("#13323 — render", () => {
  const videos = buildVideoFeed(
    sitemap([["nova", "2026-11-10"], ["velha", "2026-11-03"]]),
    (s) => (s === "nova" ? pageWithVideo("Edição nova", "aaaaaaaaaaa", "Vídeo novo") : pageWithVideo("Edição velha", "bbbbbbbbbbb")),
    Infinity,
    { todayBrt: "2026-11-16" },
  );

  it("UTM dos links pro YouTube vem do registry e está catalogada", () => {
    const u = new URL(siteVideoYouTubeUrl("aaaaaaaaaaa"));
    assert.equal(u.searchParams.get("v"), "aaaaaaaaaaa");
    assert.equal(u.searchParams.get("utm_source"), SITE_VIDEOS_UTM.source);
    assert.equal(u.searchParams.get("utm_medium"), SITE_VIDEOS_UTM.medium);
    assert.equal(u.searchParams.get("utm_campaign"), SITE_VIDEOS_UTM.campaign);
    const sub = new URL(siteVideosSubscribeUrl());
    assert.equal(sub.searchParams.get("sub_confirmation"), new URL(DIARIA_YOUTUBE_SUBSCRIBE_URL).searchParams.get("sub_confirmation"));
    assert.ok(UTM_EMITTERS.some((e) => e.source === "site" && e.campaignPattern === SITE_VIDEOS_UTM.campaign));
  });

  it("home: seção com card pra página da edição, YouTube secundário, sem iframe", () => {
    const html = buildIndexHtml({ feature: null, archive: [], videos });
    const section = html.match(/<section class="videos"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.ok(section, "seção Vídeos presente");
    assert.ok(section.includes('<a href="/videos">Ver todos os vídeos</a>'));
    assert.ok(section.includes('<h3 class="video-title"><a href="https://diar.ia.br/p/nova">Vídeo novo</a></h3>'));
    assert.ok(section.includes('src="https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg"'));
    assert.ok(section.includes(">Ver no YouTube</a>"));
    assert.ok(section.includes(">Inscreva-se no canal</a>"));
    assert.ok(!/<iframe/i.test(section));
    assert.ok(!/[→←]/.test(section), "sem seta na copy (#9721)");
  });

  it("home sem vídeo nenhum: sem seção", () => {
    assert.ok(!buildIndexHtml({ feature: null, archive: [], videos: [] }).includes('class="videos"'));
    assert.ok(!buildIndexHtml({ feature: null, archive: [] }).includes('class="videos"'));
  });

  it("/videos: grade completa e ItemList de VideoObject", () => {
    const html = buildVideosPageHtml(videos);
    assert.equal((html.match(/<li class="video-card">/g) ?? []).length, 2);
    assert.ok(html.includes('<link rel="canonical" href="https://diar.ia.br/videos">'));
    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(ld);
    const node = JSON.parse(ld) as { "@type": string; itemListElement: Array<{ position: number; item: Record<string, unknown> }> };
    assert.equal(node["@type"], "ItemList");
    assert.deepEqual(node.itemListElement.map((i) => [i.position, i.item["@type"], i.item.name, i.item.uploadDate]), [
      [1, "VideoObject", "Vídeo novo", "2026-11-10T09:00:00Z"],
      [2, "VideoObject", "Edição velha", "2026-11-03"],
    ]);
    assert.ok(!/[→←]/.test(html));
  });

  it("vídeo sem data fica fora do JSON-LD, sem item nenhum não sai script", () => {
    assert.equal(buildVideosItemListJsonLd([{ ...videos[0], uploadDate: null }]), "");
  });
});

describe("#13323 — repo real", () => {
  it("/videos committed existe, está no sitemap e na allowlist", () => {
    const committed = join(PUBLIC, VIDEOS_PAGE_FILE);
    assert.ok(existsSync(committed), "rode npx tsx scripts/gen-videos-page.ts");
    const sitemapXml = readFileSync(join(PUBLIC, "sitemap.xml"), "utf8");
    assert.ok(sitemapXml.includes("<loc>https://diar.ia.br/videos</loc>"));
    assert.ok(KNOWN_STATIC_SITEMAP_PATHS.includes("/videos"));
    const html = readFileSync(committed, "utf8");
    assert.match(html, /<h1>Vídeos<\/h1>/);
    assert.match(html, /<li class="video-card">/);
  });

  it("a home committed tem a seção Vídeos", () => {
    const home = readFileSync(join(PUBLIC, "index.html"), "utf8");
    assert.match(home, /<section class="videos" id="videos">/);
  });

  it("regen-home.yml regenera e commita /videos", () => {
    const wf = readFileSync(join(ROOT, ".github", "workflows", "regen-home.yml"), "utf8");
    assert.ok(wf.includes("npx tsx scripts/gen-videos-page.ts"));
    assert.match(wf, /git add -- [^\n]*workers\/site\/public\/videos/);
  });
});
