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

  it("#5101 item 3a: título em NFD (acento decomposto) sai normalizado em NFC no cache", () => {
    // "Educação" com "ç" e "ã" DECOMPOSTOS (base + diacrítico combinante
    // separado) — mesma causa-raiz do slug quebrado do #5101 item 3a,
    // mas aqui do lado do TÍTULO exibido pelo Worker `arquivo` (não do slug,
    // que já está imutável uma vez publicado).
    const nfdTitle = "Nova regra de educa̧ão de IA".normalize("NFD");
    assert.notEqual(nfdTitle, nfdTitle.normalize("NFC")); // pré-condição: fixture é NFD

    const posts: RawCachedPost[] = [
      {
        slug: "nova-regra-educacao-ia",
        title: nfdTitle,
        publish_date: Date.UTC(2026, 6, 28, 18, 0, 0) / 1000,
      },
    ];
    const { cache } = buildTitlesCache(posts);
    assert.equal(cache["nova-regra-educacao-ia"]?.title, nfdTitle.normalize("NFC"));
  });

  it("#5101 item 3a: título já em NFC (caso comum) passa inalterado", () => {
    const nfcTitle = "Nova regra de educação de IA";
    assert.equal(nfcTitle, nfcTitle.normalize("NFC")); // pré-condição: já é NFC

    const posts: RawCachedPost[] = [
      {
        slug: "nova-regra-educacao-ia-2",
        title: nfcTitle,
        publish_date: Date.UTC(2026, 6, 28, 18, 0, 0) / 1000,
      },
    ];
    const { cache } = buildTitlesCache(posts);
    assert.equal(cache["nova-regra-educacao-ia-2"]?.title, nfcTitle);
  });

  it("#5101 item 3a: fallback subject (título ausente) em NFD também sai normalizado em NFC — mesmo caminho do title, não coberto antes (achado do pr-test-analyzer)", () => {
    const nfdSubject = "Nova regra de educação de IA via subject".normalize("NFD");
    assert.notEqual(nfdSubject, nfdSubject.normalize("NFC")); // pré-condição: fixture é NFD

    const posts: RawCachedPost[] = [
      {
        slug: "nova-regra-educacao-ia-subject",
        subject: nfdSubject,
        publish_date: Date.UTC(2026, 6, 28, 18, 0, 0) / 1000,
      },
    ];
    const { cache } = buildTitlesCache(posts);
    assert.equal(cache["nova-regra-educacao-ia-subject"]?.title, nfdSubject.normalize("NFC"));
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

describe("buildTitlesCache — coverImageUrl (#5131)", () => {
  it("post com thumbnail_url → coverImageUrl entra no cache", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "com-capa",
        title: "Edição com capa",
        publish_date: Date.UTC(2026, 6, 1, 18) / 1000,
        thumbnail_url: "https://media.beehiiv.com/cdn-cgi/image/capa.jpg",
      },
    ];
    const { cache } = buildTitlesCache(posts);
    assert.equal(cache["com-capa"]?.coverImageUrl, "https://media.beehiiv.com/cdn-cgi/image/capa.jpg");
  });

  it("post SEM thumbnail_url → coverImageUrl ausente do objeto (não `undefined` explícito, não string vazia)", () => {
    const posts: RawCachedPost[] = [
      { slug: "sem-capa", title: "Edição sem capa", publish_date: Date.UTC(2026, 6, 1, 18) / 1000 },
    ];
    const { cache } = buildTitlesCache(posts);
    assert.deepEqual(cache["sem-capa"], { title: "Edição sem capa", publishDate: "2026-07-01" });
    assert.equal("coverImageUrl" in cache["sem-capa"], false);
  });

  it("thumbnail_url string vazia → tratado como ausente (nunca og:image morto)", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "capa-vazia",
        title: "Edição com thumbnail_url vazia",
        publish_date: Date.UTC(2026, 6, 1, 18) / 1000,
        thumbnail_url: "",
      },
    ];
    const { cache } = buildTitlesCache(posts);
    assert.equal("coverImageUrl" in cache["capa-vazia"], false);
  });
});

describe("buildTitlesCache — propagação do override de data (#4803)", () => {
  it("um override presente e válido vence o publish_date bruto no cache final", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "edicao-antiga",
        title: "Edição antiga",
        // publish_date aponta pro dia do import em lote — bem depois da
        // data real que o override corrige.
        publish_date: Date.UTC(2025, 8, 3, 18, 0, 0) / 1000,
      },
    ];
    const { cache, warnings } = buildTitlesCache(posts, {
      overrides: { "edicao-antiga": "2025-06-15" },
      discarded: [],
    });
    assert.equal(cache["edicao-antiga"]?.publishDate, "2025-06-15");
    assert.deepEqual(warnings, []);
  });

  it("overridesResult.error (arquivo malformado) vira warning visível — não silencioso em stderr só", () => {
    const posts: RawCachedPost[] = [
      { slug: "edicao-x", title: "Edição X", publish_date: Date.UTC(2026, 6, 1, 18) / 1000 },
    ];
    const { cache, warnings } = buildTitlesCache(posts, {
      overrides: {},
      error: "Unexpected token } in JSON at position 12",
      discarded: [],
    });
    // Sem override utilizável, cai no publish_date bruto normalmente — o
    // erro não bloqueia o resto do processamento.
    assert.equal(cache["edicao-x"]?.publishDate, "2026-07-01");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /malformado/);
  });

  it("overridesResult.discarded (entrada de formato inválido) vira warning visível", () => {
    const posts: RawCachedPost[] = [
      { slug: "edicao-y", title: "Edição Y", publish_date: Date.UTC(2026, 6, 1, 18) / 1000 },
    ];
    const { warnings } = buildTitlesCache(posts, {
      overrides: {},
      discarded: [`slug "edicao-y": valor de override inválido (esperado "YYYY-MM-DD", recebido "2025-13-45")`],
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /edicao-y/);
  });
});
