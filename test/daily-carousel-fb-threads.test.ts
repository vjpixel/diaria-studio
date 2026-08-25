/**
 * daily-carousel-fb-threads.test.ts (#6095)
 *
 * Carrossel diário no Facebook e no Threads — mesmo padrão do Instagram
 * (#6005 Parte B): se os 5 slides (capa `d{N}_4x5` + `d{N}_carousel_{p1,p2,
 * p3,cta}`) estiverem completos em 06-public-images.json, publica carrossel
 * reusando a infra do semanal (`publishFacebookCarouselByUrl` /
 * `fireThreadsCarousel` via `image_urls` no payload do Worker); QUALQUER
 * slide faltando → fallback single-image/texto, tudo-ou-nada, sem bloquear
 * o canal.
 *
 * Cobertura espelhada de publish-instagram/daily-carousel-card:
 *   - resolveCarouselImageUrls contra fixtures realistas do mapa `images`
 *     (completo → 5 URLs na ordem capa→p1→p2→p3→cta; 1 ausente → null);
 *   - wiring estático dos 2 scripts diários (mesmo estilo "verificação
 *     estática do script" já usado nestes arquivos de teste).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCarouselImageUrls } from "../scripts/lib/daily-carousel-card.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FB_SRC = readFileSync(resolve(__ROOT, "scripts/publish-facebook.ts"), "utf8");
const THREADS_SRC = readFileSync(resolve(__ROOT, "scripts/publish-threads.ts"), "utf8");

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Mapa `images` completo pro d1 (shape real de 06-public-images.json). */
function imagesMapCompleto(destaque: string): Record<string, { url?: string }> {
  return {
    [`${destaque}_4x5`]: { url: `https://cdn.test/${destaque}-capa-4x5.jpg` },
    [`${destaque}_carousel_p1`]: { url: `https://cdn.test/${destaque}-p1.jpg` },
    [`${destaque}_carousel_p2`]: { url: `https://cdn.test/${destaque}-p2.jpg` },
    [`${destaque}_carousel_p3`]: { url: `https://cdn.test/${destaque}-p3.jpg` },
    [`${destaque}_carousel_cta`]: { url: `https://cdn.test/${destaque}-cta.jpg` },
  };
}

function removerSlide(images: Record<string, { url?: string }>, chave: string): Record<string, { url?: string }> {
  const rest = { ...images };
  delete rest[chave];
  return rest;
}

const SLIDES = ["p1", "p2", "p3", "cta"] as const;

// ─── Tudo-ou-nada (comportamento compartilhado pelos 3 canais) ──────────────

describe("#6095 resolveCarouselImageUrls — tudo-ou-nada (fixtures FB/Threads)", () => {
  it("5 slides completos → 5 URLs na ordem capa→p1→p2→p3→cta", () => {
    const urls = resolveCarouselImageUrls(imagesMapCompleto("d1"), "d1");
    assert.deepEqual(urls, [
      "https://cdn.test/d1-capa-4x5.jpg",
      "https://cdn.test/d1-p1.jpg",
      "https://cdn.test/d1-p2.jpg",
      "https://cdn.test/d1-p3.jpg",
      "https://cdn.test/d1-cta.jpg",
    ]);
  });

  it("06-public-images.json ausente (undefined) → null (fallback single-image)", () => {
    assert.equal(resolveCarouselImageUrls(undefined, "d1"), null);
  });

  it("capa ausente → null", () => {
    const images = removerSlide(imagesMapCompleto("d1"), "d1_4x5");
    assert.equal(resolveCarouselImageUrls(images, "d1"), null);
  });

  for (const slot of SLIDES) {
    it(`slide ${slot} ausente → null (nunca carrossel incompleto)`, () => {
      const images = removerSlide(imagesMapCompleto("d1"), `d1_carousel_${slot}`);
      assert.equal(resolveCarouselImageUrls(images, "d1"), null);
    });
  }

  it("url presente mas vazia conta como ausente", () => {
    const images = imagesMapCompleto("d2");
    images["d2_carousel_p2"] = {};
    assert.equal(resolveCarouselImageUrls(images, "d2"), null);
  });

  it("não vaza slides de outro destaque (d2 não usa chaves de d1)", () => {
    const images = { ...imagesMapCompleto("d2") };
    assert.equal(resolveCarouselImageUrls(images, "d1"), null);
  });
});

// ─── Wiring Facebook ────────────────────────────────────────────────────────

describe("#6095 publish-facebook.ts — wiring do carrossel diário", () => {
  it("reusa resolveCarouselImageUrls de daily-carousel-card.ts (sem duplicar lógica)", () => {
    assert.match(
      FB_SRC,
      /import \{ resolveCarouselImageUrls \} from "\.\/lib\/daily-carousel-card\.ts"/,
      "#6095: publish-facebook.ts deve importar resolveCarouselImageUrls",
    );
  });

  it("lê o mapa `images` de 06-public-images.json", () => {
    assert.match(FB_SRC, /resolve\(editionDir, "06-public-images\.json"\)/);
  });

  it("resolve o carrossel por destaque dentro do loop de publicação", () => {
    assert.match(
      FB_SRC,
      /const carouselImageUrls = resolveCarouselImageUrls\(publicImages, d\);/,
    );
  });

  it("chama publishFacebookCarouselByUrl quando o carrossel existe (infra do semanal #5348)", () => {
    // O call site novo usa a MESMA função já exercida em produção pelo weekly.
    assert.match(
      FB_SRC,
      /carouselImageUrls\s*\n\s*\?\s*await publishFacebookCarouselByUrl\(/,
      "#6095: caminho carrossel deve passar por publishFacebookCarouselByUrl",
    );
  });

  it("mantém o fallback single-image (publishPhoto) quando qualquer slide falta", () => {
    assert.match(
      FB_SRC,
      /:\s*await publishPhoto\(/,
      "#6095: fallback deve continuar sendo o publishPhoto de sempre",
    );
  });

  it("publishFacebookCarouselByUrl segue exportada (contrato usado pelo weekly)", () => {
    assert.match(FB_SRC, /export async function publishFacebookCarouselByUrl\(/);
  });
});

// ─── Wiring Threads ─────────────────────────────────────────────────────────

describe("#6095 publish-threads.ts — wiring do carrossel diário (--schedule)", () => {
  it("reusa resolveCarouselImageUrls de daily-carousel-card.ts (sem duplicar lógica)", () => {
    assert.match(
      THREADS_SRC,
      /import \{ resolveCarouselImageUrls \} from "\.\/lib\/daily-carousel-card\.ts"/,
      "#6095: publish-threads.ts deve importar resolveCarouselImageUrls",
    );
  });

  it("lê o mapa `images` de 06-public-images.json", () => {
    assert.match(THREADS_SRC, /resolve\(editionDir, "06-public-images\.json"\)/);
  });

  it("payload do Worker inclui image_urls quando o carrossel está completo", () => {
    // Spread condicional: omitido (undefined) quando null — preserva o payload
    // de sempre (image_url null → fireThreadsText no Worker), mesmo padrão do
    // Instagram (`...(imageUrls.length > 1 && { image_urls: imageUrls })`).
    assert.match(
      THREADS_SRC,
      /\.\.\.\(carouselImageUrls && \{ image_urls: carouselImageUrls \}\)/,
      "#6095: payload --schedule deve carregar image_urls condicionalmente",
    );
  });

  it("mantém image_url: null no payload (fallback text-only intacto)", () => {
    assert.match(THREADS_SRC, /image_url: null,/);
  });

  it("payload segue indo com channel: \"threads\"", () => {
    assert.match(THREADS_SRC, /channel: "threads",/);
  });

  it("nenhuma mudança esperada no Worker (fireThreadsCarousel já genérico #5348)", () => {
    // Guard documentacional: a resolução por contagem no Worker é
    // `resolveImageUrls` → fireThreadsCarousel p/ N>1. Se isso sumir, o
    // payload image_urls desta issue fica órfão.
    const workerSrc = readFileSync(resolve(__ROOT, "workers/linkedin-cron/src/dispatch.ts"), "utf8");
    assert.match(workerSrc, /function resolveImageUrls\(/);
    assert.match(workerSrc, /fireThreadsCarousel\(/);
  });
});
