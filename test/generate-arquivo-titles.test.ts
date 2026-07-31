/**
 * test/generate-arquivo-titles.test.ts (#4265 item 1)
 *
 * Cobre a parte PURA de `scripts/generate-arquivo-titles.ts` (buildTitlesCache
 * + publishDateLabel) — sem tocar disco/`data/beehiiv-cache/`, que não existe
 * em sessão cloud/CI (junction local do OneDrive). O I/O (`loadRawPosts`/
 * `main`) não é coberto aqui de propósito: é só glue de leitura de diretório,
 * já protegido por um erro explícito (`diretório não encontrado`) quando
 * `data/` está ausente — testar isso exigiria mockar `node:fs` pra um cenário
 * que só acontece em sessão sem o junction, baixo valor.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildTitlesCache,
  publishDateLabel,
  type RawCachedPost,
} from "../scripts/generate-arquivo-titles.ts";

describe("publishDateLabel (#4265 item 1)", () => {
  it("converte publish_date (Unix seconds) pra YYYY-MM-DD ajustado pra BRT (UTC-3)", () => {
    // 2026-07-28T02:00:00Z → BRT (UTC-3) é 2026-07-27 23:00 — ainda dia 27.
    // Sem o ajuste de -3h, isso vazaria pro dia 28 (madrugada UTC).
    const unixSeconds = Date.UTC(2026, 6, 28, 2, 0, 0) / 1000;
    assert.equal(publishDateLabel(unixSeconds), "2026-07-27");
  });

  it("horário BRT dentro do mesmo dia UTC não muda a data", () => {
    const unixSeconds = Date.UTC(2026, 6, 28, 18, 0, 0) / 1000;
    assert.equal(publishDateLabel(unixSeconds), "2026-07-28");
  });
});

describe("buildTitlesCache (#4265 item 1)", () => {
  it("usa o campo slug explícito quando presente", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "anthropic-lan-a-o-claude-opus-5",
        title: "Anthropic lança o Claude Opus 5",
        publish_date: Date.UTC(2026, 6, 28, 18, 0, 0) / 1000,
      },
    ];
    const { cache, warnings } = buildTitlesCache(posts);
    assert.deepEqual(cache["anthropic-lan-a-o-claude-opus-5"], {
      title: "Anthropic lança o Claude Opus 5",
      publishDate: "2026-07-28",
    });
    assert.deepEqual(warnings, []);
  });

  it("deriva o slug de web_url quando o campo slug está ausente (match por SLUG, nunca por URL completa)", () => {
    // web_url aponta pro domínio ANTIGO (diaria.beehiiv.com) — só o último
    // segmento do path (o slug) precisa bater com o sitemap (diar.ia.br).
    const posts: RawCachedPost[] = [
      {
        title: "Google lança Gemini 4",
        web_url: "https://diaria.beehiiv.com/p/google-lanca-gemini-4",
        publish_date: Date.UTC(2026, 6, 20, 18, 0, 0) / 1000,
      },
    ];
    const { cache } = buildTitlesCache(posts);
    assert.deepEqual(cache["google-lanca-gemini-4"], {
      title: "Google lança Gemini 4",
      publishDate: "2026-07-20",
    });
  });

  it("usa subject como fallback quando title está ausente", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "edicao-x",
        subject: "Título via subject",
        publish_date: Date.UTC(2026, 6, 15, 18, 0, 0) / 1000,
      },
    ];
    const { cache } = buildTitlesCache(posts);
    assert.equal(cache["edicao-x"]?.title, "Título via subject");
  });

  it("pula (com warning, sem lançar) posts sem slug resolvível", () => {
    const posts: RawCachedPost[] = [
      { title: "Sem slug nem web_url", publish_date: 1753000000 },
    ];
    const { cache, warnings } = buildTitlesCache(posts);
    assert.deepEqual(cache, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sem slug resolvível/);
  });

  it("pula (com warning) posts sem title/subject", () => {
    const posts: RawCachedPost[] = [
      { slug: "sem-titulo", publish_date: 1753000000 },
    ];
    const { cache, warnings } = buildTitlesCache(posts);
    assert.deepEqual(cache, {});
    assert.match(warnings[0], /sem title\/subject/);
  });

  it("pula (com warning) posts sem publish_date", () => {
    const posts: RawCachedPost[] = [
      { slug: "sem-data", title: "Tem título, sem data" },
    ];
    const { cache, warnings } = buildTitlesCache(posts);
    assert.deepEqual(cache, {});
    assert.match(warnings[0], /sem publish_date/);
  });

  it("processa uma mistura de posts válidos e inválidos sem lançar — só os válidos entram no cache", () => {
    const posts: RawCachedPost[] = [
      { slug: "valido-1", title: "Válido 1", publish_date: Date.UTC(2026, 6, 1, 18) / 1000 },
      { title: "Sem slug", publish_date: 1753000000 },
      { slug: "valido-2", title: "Válido 2", publish_date: Date.UTC(2026, 6, 2, 18) / 1000 },
    ];
    const { cache, warnings } = buildTitlesCache(posts);
    assert.equal(Object.keys(cache).length, 2);
    assert.ok(cache["valido-1"]);
    assert.ok(cache["valido-2"]);
    assert.equal(warnings.length, 1);
  });
});
