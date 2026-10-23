/**
 * #10924: desde o #10784 o 1º `<img class="hero">` do corpo da edição é a
 * cópia do D1 com o convite/play do vídeo (`04-d1-2x1-play.jpg`, só para o
 * e-mail), dentro de `<a class="hero-video">`. Quem derivava a capa da página
 * do site (JSON-LD/og:image via backfill, card da home, og:image do acervo)
 * lia esse hero — o compartilhamento mostrava o play como se fosse vídeo.
 * A capa passa a vir de `images.cover.url` (`04-d1-2x1.jpg` original).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEditionArchivePost } from "../scripts/lib/edition-site-page.ts";
import { buildArchivePageHtml } from "../scripts/lib/site-archive-pages.ts";
import { backfillArchivePageOnDisk } from "../scripts/lib/site-archive-page-backfill.ts";
import { extractHeroImage } from "../scripts/lib/site-home-page.ts";
import { readD1CoverPublicUrl } from "../scripts/publish-edition-site-page.ts";
import { renderHeroImageInner } from "../scripts/lib/newsletter-render-html.ts";

const COVER = "https://eia.diar.ia.br/img/img-261023-04-d1-2x1-1a2b3c4d.jpg";
const PLAY = "https://eia.diar.ia.br/img/img-261023-04-d1-2x1-play-5e6f7a8b.jpg";
const D2 = "https://eia.diar.ia.br/img/img-261023-04-d2-2x1-9c0d1e2f.jpg";

/** Corpo como o render real da newsletter sai: hero do D1 com link pro vídeo. */
function bodyWithVideoHero(): string {
  const d1 = renderHeroImageInner("04-d1-2x1-play.jpg", "D1", "crédito", "https://youtu.be/abc").replace(
    "{{IMG:04-d1-2x1-play.jpg}}",
    PLAY,
  );
  const d2 = renderHeroImageInner("04-d2-2x1.jpg", "D2", "crédito").replace("{{IMG:04-d2-2x1.jpg}}", D2);
  return `<table><tr><td>${d1}</td></tr><tr><td>${d2}</td></tr></table>`;
}

function buildPage(coverImageUrl: string | null): string {
  const built = buildEditionArchivePost({
    html: bodyWithVideoHero(),
    postUrl: "https://diar.ia.br/p/edicao-teste-10924",
    title: "Edição teste",
    subtitle: "Sub",
    publishedAtIso: "2026-10-23T09:00:00.000Z",
    coverImageUrl,
  });
  assert.ok(built.ok);
  return buildArchivePageHtml(built.post);
}

describe("#10924 — capa da página da edição é o D1 original, sem o play", () => {
  it("readD1CoverPublicUrl lê images.cover.url (nunca a cópia d1_play)", () => {
    const dir = mkdtempSync(join(tmpdir(), "site-10924-"));
    try {
      assert.equal(readD1CoverPublicUrl(dir), null, "sem arquivo → null");
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({ images: { cover: { url: COVER }, d1_play: { url: PLAY } } }),
      );
      assert.equal(readD1CoverPublicUrl(dir), COVER);
      writeFileSync(join(dir, "06-public-images.json"), "{ quebrado");
      assert.equal(readD1CoverPublicUrl(dir), null, "ilegível → null, nunca lança");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("og:image, twitter:image e image do JSON-LD apontam pra capa original", () => {
    const html = buildPage(COVER);
    const og = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/)?.[1];
    assert.equal(og, COVER);
    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(ld);
    assert.equal((JSON.parse(ld) as { image?: { url?: string } }).image?.url, COVER);
    assert.ok(!/<meta[^>]+content="[^"]*-play-[^"]*"/.test(html), "nenhuma meta aponta pra cópia com play");
  });

  it("backfill do publish (#8645) não troca a capa pelo hero com play", () => {
    const { html } = backfillArchivePageOnDisk(buildPage(COVER), {
      slug: "edicao-teste-10924",
      publishDateUnixSeconds: 1792746000,
    });
    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    assert.equal((JSON.parse(ld ?? "{}") as { image?: { url?: string } }).image?.url, COVER);
  });

  it("card da home/acervo (extractHeroImage) usa a capa original quando o hero é o do vídeo", () => {
    assert.equal(extractHeroImage(buildPage(COVER)), "/img/img-261023-04-d1-2x1-1a2b3c4d.jpg");
  });

  it("página sem capa conhecida segue com o hero do corpo (comportamento anterior)", () => {
    assert.equal(extractHeroImage(buildPage(null)), "/img/img-261023-04-d1-2x1-play-5e6f7a8b.jpg");
  });

  it("hero comum (sem link de vídeo) não consulta og:image", () => {
    const html = `<meta property="og:image" content="${COVER}"><img class="hero" src="${D2}">`;
    assert.equal(extractHeroImage(html), "/img/img-261023-04-d2-2x1-9c0d1e2f.jpg");
  });
});
