/**
 * test/site-page-video-12080.test.ts (#12080)
 *
 * Página web da edição: o vídeo do D1 vira player (`youtube-nocookie`) no
 * lugar da imagem com link, ganha `VideoObject` no <head>, os links do
 * YouTube saem com UTM da web, e o vídeo lido do disco vence o link do canal
 * que ficou no HTML do e-mail (261028, 261103). Edição sem vídeo: sem player.
 * Republicação depois do envio: `siteVideoRepublishDecision` +
 * `republishSitePageIfVideoMissing` (task `video-d1-link-watch.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWebVideo, buildVideoObjectJsonLd, rewriteVideoUtmsForWeb } from "../scripts/lib/site-page-video.ts";
import { buildEditionArchivePost } from "../scripts/lib/edition-site-page.ts";
import { buildArchivePageHtml } from "../scripts/lib/site-archive-pages.ts";
import { renderHeroImageInner } from "../scripts/lib/newsletter-render-html.ts";
import { buildD1VideoLink } from "../scripts/lib/diaria/d1-video-hero.ts";
import { extractHeroImage } from "../scripts/lib/site-home-page.ts";
import { readEditionVideoMeta } from "../scripts/lib/edition-video-meta.ts";
import { siteVideoRepublishDecision } from "../scripts/lib/site-page-video-republish.ts";
import { readEditionInputs } from "../scripts/publish-edition-site-page.ts";
import { republishSitePageIfVideoMissing, sitePageRepublishArgs } from "../scripts/video-d1-link-watch.ts";

const ID = "RVQp8Ov9FK8";
const COVER = "https://eia.diar.ia.br/img/img-261103-04-d1-2x1-1a2b3c4d.jpg";
const PLAY = "https://eia.diar.ia.br/img/img-261103-04-d1-2x1-play-5e6f7a8b.jpg";
const D2 = "https://eia.diar.ia.br/img/img-261103-04-d2-2x1-9c0d1e2f.jpg";

/** Corpo como o render do e-mail sai: hero do D1 com link (vídeo ou canal). */
function body(videoUrl: string | null): string {
  const d1 = renderHeroImageInner("04-d1-2x1-play.jpg", "D1", "IMAGEM: GEMINI", buildD1VideoLink(videoUrl, "261103").href).replace(
    "{{IMG:04-d1-2x1-play.jpg}}",
    PLAY,
  );
  const d2 = renderHeroImageInner("04-d2-2x1.jpg", "D2", "IMAGEM: GEMINI").replace("{{IMG:04-d2-2x1.jpg}}", D2);
  return `<html><head></head><body><table><tr><td>${d1}</td></tr><tr><td>${d2}</td></tr>` +
    `<tr><td><a href="https://example.com/artigo?utm_source=newsletter&amp;utm_medium=email">artigo</a></td></tr></table></body></html>`;
}

function page(html: string, video?: Parameters<typeof buildArchivePageHtml>[1]): string {
  const built = buildEditionArchivePost({
    html,
    postUrl: "https://diar.ia.br/p/edicao-teste-12080",
    title: "Só o Claude Opus 5.5 supera a IA aberta da Mistral",
    subtitle: "Sub",
    publishedAtIso: "2026-11-03T09:00:00.000Z",
    coverImageUrl: COVER,
  });
  assert.ok(built.ok);
  return buildArchivePageHtml(built.post, video ?? {});
}

function ldNodes(html: string): Array<Record<string, unknown>> {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}

describe("#12080 — player do vídeo na página web", () => {
  it("hero com link pro vídeo vira o player; sem a legenda de crédito; D2 intacto", () => {
    const html = page(body(`https://youtu.be/${ID}`));
    assert.ok(html.includes(`src="https://www.youtube-nocookie.com/embed/${ID}"`), "iframe do youtube-nocookie");
    assert.ok(!html.includes('class="hero-video"'), "o link com a imagem do e-mail sai");
    assert.ok(!html.includes(PLAY), "a cópia com o convite (só do e-mail) não aparece na web");
    assert.ok(html.includes(D2), "o hero do D2 continua");
    assert.equal(html.split("IMAGEM: GEMINI").length - 1, 1, "só a legenda do D2 fica");
  });

  it("VideoObject no head com os campos obrigatórios do Google", () => {
    const html = page(body(`https://youtu.be/${ID}`), {
      video: { videoUrl: `https://youtu.be/${ID}`, name: "Título do vídeo", uploadDate: "2026-11-03T09:00:00Z" },
    });
    const video = ldNodes(html).find((n) => n["@type"] === "VideoObject");
    assert.ok(video, "VideoObject presente");
    assert.equal(video!.name, "Título do vídeo");
    assert.equal(video!.uploadDate, "2026-11-03T09:00:00Z");
    assert.equal(video!.embedUrl, `https://www.youtube-nocookie.com/embed/${ID}`);
    assert.deepEqual(video!.thumbnailUrl, [`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`]);
    assert.ok(typeof video!.description === "string" && (video!.description as string).length > 0);
    assert.equal(ldNodes(html)[0]["@type"], "NewsArticle", "NewsArticle segue sendo o 1º node");
  });

  it("sem uploadDate do registro, a data é a da edição", () => {
    const video = ldNodes(page(body(`https://youtu.be/${ID}`))).find((n) => n["@type"] === "VideoObject");
    assert.match(String(video?.uploadDate), /^2026-11-03/);
    assert.equal(buildVideoObjectJsonLd({ videoId: ID, name: "x", description: "", uploadDate: null }), undefined);
  });

  it("hero pro canal + vídeo no disco: o player usa o vídeo do disco (261028, 261103)", () => {
    const html = page(body(null), { video: { videoUrl: `https://youtu.be/${ID}` } });
    assert.ok(html.includes(`/embed/${ID}"`));
    assert.ok(!html.includes("youtube.com/@diariabr"), "o link pro canal sai junto com a imagem");
  });

  it("hero pro canal sem vídeo no disco: sem player, link pro canal com UTM da web", () => {
    const html = page(body(null));
    assert.ok(!html.includes("youtube-nocookie"));
    assert.ok(!ldNodes(html).some((n) => n["@type"] === "VideoObject"));
    const href = html.match(/<a class="hero-video" href="([^"]+)"/)?.[1].replace(/&amp;/g, "&");
    assert.ok(href);
    const u = new URL(href!);
    assert.equal(u.searchParams.get("utm_source"), "site");
    assert.equal(u.searchParams.get("utm_medium"), "web");
    assert.equal(u.searchParams.get("utm_campaign"), "video-d1-261103", "campanha preservada");
  });

  it("UTM da web só nos links do YouTube vindos do e-mail; o resto fica igual", () => {
    const html = `<a href="https://youtu.be/${ID}?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=video-box0-261103">box</a>` +
      `<a href="https://example.com/a?utm_source=newsletter&amp;utm_medium=email">artigo</a>` +
      `<a href="https://www.youtube.com/@diariabr">canal sem utm</a>`;
    const out = rewriteVideoUtmsForWeb(html);
    assert.ok(out.includes("utm_source=site&amp;utm_medium=web&amp;utm_campaign=video-box0-261103"));
    assert.ok(out.includes("https://example.com/a?utm_source=newsletter&amp;utm_medium=email"));
    assert.ok(out.includes('href="https://www.youtube.com/@diariabr"'));
  });

  it("página sem hero de vídeo (edição sem vídeo, acervo antigo) não muda", () => {
    const html = "<html><head></head><body><p>corpo</p></body></html>";
    assert.deepEqual(applyWebVideo(html, {}, "t"), { html, videoId: null });
  });

  it("card da home usa a capa (og:image), não o hero do D2, quando o D1 virou player", () => {
    assert.equal(extractHeroImage(page(body(`https://youtu.be/${ID}`))), "/img/img-261103-04-d1-2x1-1a2b3c4d.jpg");
  });
});

function editionWith(files: Record<string, string>): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "site-video-12080-"));
  const dir = join(root, "2611", "261103");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
  return { root, dir };
}

describe("#12080 — vídeo do disco e republicação depois do envio", () => {
  it("readEditionInputs traz o vídeo do disco (título e data do registro do mesmo vídeo)", () => {
    const { root, dir } = editionWith({
      "_internal/newsletter-final.html": body(null),
      "_internal/05-video-url.txt": `https://www.youtube.com/watch?v=${ID}\n`,
      "_internal/05-youtube-published.json": JSON.stringify({
        videoId: ID,
        title: "Vídeo da terça",
        requested: { publishAt: "2026-11-03T09:00:00.000Z" },
        rereadStatus: { publishAt: "2026-11-03T09:00:00Z" },
      }),
    });
    try {
      const inputs = readEditionInputs(dir, "edicao-teste-12080");
      assert.deepEqual(inputs?.video, {
        videoUrl: `https://youtu.be/${ID}`,
        name: "Vídeo da terça",
        uploadDate: "2026-11-03T09:00:00Z",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registro de OUTRO vídeo não empresta título nem data; marcada sem vídeo = sem vídeo", () => {
    const { root, dir } = editionWith({
      "_internal/05-video-url.txt": `https://youtu.be/${ID}\n`,
      "_internal/05-youtube-published.json": JSON.stringify({ videoId: "zzzzzzzzzzz", title: "Outro" }),
    });
    try {
      assert.deepEqual(readEditionVideoMeta(dir), { videoUrl: `https://youtu.be/${ID}`, videoId: ID, title: null, uploadDate: null });
      writeFileSync(join(dir, "_internal", "no-video.json"), "{}");
      assert.equal(readEditionVideoMeta(dir), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("decisão: republica só página publicada sem este vídeo", () => {
    const url = `https://youtu.be/${ID}`;
    assert.equal(siteVideoRepublishDecision({ published: true, video_url: null }, url).republish, true);
    assert.equal(siteVideoRepublishDecision({ published: true }, url).republish, true, "state anterior ao #12080");
    assert.equal(siteVideoRepublishDecision({ published: true, video_url: "https://youtu.be/zzzzzzzzzzz" }, url).republish, true);
    assert.equal(siteVideoRepublishDecision({ published: true, video_url: `https://www.youtube.com/watch?v=${ID}` }, url).republish, false);
    assert.equal(siteVideoRepublishDecision({ published: false }, url).republish, false);
    assert.equal(siteVideoRepublishDecision(null, url).republish, false);
    assert.equal(siteVideoRepublishDecision({ published: true }, null).republish, false);
  });

  it("task do vídeo republica a página com o mesmo comando do §5b-site; não repete", () => {
    const { root, dir } = editionWith({
      "_internal/05-video-url.txt": `https://youtu.be/${ID}\n`,
      "_internal/site-page-published.json": JSON.stringify({ published: true, video_url: null }),
    });
    try {
      const calls: string[][] = [];
      const out = republishSitePageIfVideoMissing(dir, () => {}, (args) => {
        calls.push(args);
        return { status: 0 };
      });
      assert.equal(out.ran, true);
      assert.equal(out.ok, true);
      assert.deepEqual(calls, [sitePageRepublishArgs(dir)]);
      assert.ok(calls[0].includes("--slug-from-d1") && calls[0].includes("--no-wait-merge"));

      writeFileSync(join(dir, "_internal", "site-page-published.json"), JSON.stringify({ published: true, video_url: `https://youtu.be/${ID}` }));
      const again = republishSitePageIfVideoMissing(dir, () => {}, () => {
        throw new Error("não deveria republicar");
      });
      assert.equal(again.ran, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falha da republicação vira desfecho ok:false, sem lançar", () => {
    const { root, dir } = editionWith({
      "_internal/05-video-url.txt": `https://youtu.be/${ID}\n`,
      "_internal/site-page-published.json": JSON.stringify({ published: true }),
    });
    try {
      const out = republishSitePageIfVideoMissing(dir, () => {}, () => ({ status: 3 }));
      assert.deepEqual({ ran: out.ran, ok: out.ok, exitCode: out.exitCode }, { ran: true, ok: false, exitCode: 3 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
