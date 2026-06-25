/**
 * dedup-evergreen-buckets.test.ts (#2548 — Furo 1)
 *
 * Testa dedup pós-categorização para buckets evergreen (use_melhor / video).
 *
 * Regressão principal (#2548 Furo 1):
 *   `eugeneyan.com//writing/working-with-ai/` entrou no USE MELHOR mesmo tendo
 *   sido publicado em 3 edições anteriores além da janela de 4. O dedup.ts
 *   (passo 1l) usa janela de 4 edições — adequada para notícias efêmeras, mas
 *   insuficiente para evergreen que é re-descoberto semanas depois.
 *
 * Cenários reais cobertos:
 *   1. URL evergreen publicada há 6 edições + bucket use_melhor → removida.
 *   2. URL radar publicada há 6 edições → NÃO removida (janela curta do dedup.ts).
 *   3. URL nova (não em nenhuma edição passada) → preservada.
 *   4. Bucket video também coberto.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dedupEvergreenBuckets,
} from "../scripts/dedup-evergreen-buckets.ts";
import { extractPastUrlsUnbounded } from "../scripts/dedup.ts";

// ---------------------------------------------------------------------------
// Fixture: past-editions.md com 6 edições, url-evergreen só aparece em ed. 6+
// ---------------------------------------------------------------------------

/**
 * Simula um past-editions.md com 8 edições passadas.
 * A URL evergreen (`eugeneyan.com/writing/working-with-ai/`) aparece na edição
 * mais antiga (260501) — além da janela de 4 que dedup.ts usa.
 */
const PAST_MD = `# Últimas edições publicadas

## 2026-06-22 — "Edição recente"

Links usados:
- https://techcrunch.com/recent-news
- https://openai.com/blog/recent-post

---

## 2026-06-21 — "Edição -2"

Links usados:
- https://example.com/news-2

---

## 2026-06-20 — "Edição -3"

Links usados:
- https://example.com/news-3

---

## 2026-06-19 — "Edição -4"

Links usados:
- https://example.com/news-4

---

## 2026-06-18 — "Edição -5"

Links usados:
- https://example.com/news-5

---

## 2026-06-17 — "Edição -6 (além da janela de 4)"

Links usados:
- https://eugeneyan.com/writing/working-with-ai/
- https://example.com/another-old-news

---

## 2026-06-16 — "Edição -7"

Links usados:
- https://example.com/news-7

---

## 2026-06-15 — "Edição -8"

Links usados:
- https://example.com/news-8

---
`;

// ---------------------------------------------------------------------------
// extractPastUrlsUnbounded
// ---------------------------------------------------------------------------

describe("extractPastUrlsUnbounded (#2548 Furo 1)", () => {
  it("extrai URLs de TODAS as edições passadas (sem limite de janela)", () => {
    const urls = extractPastUrlsUnbounded(PAST_MD);

    // URL da edição -6 deve estar incluída (além da janela de 4).
    // canonicalize() strip trailing slash: .../working-with-ai/ → .../working-with-ai
    assert.ok(
      urls.has("https://eugeneyan.com/writing/working-with-ai"),
      `URL evergreen da edição -6 deve estar incluída. URLs encontradas: ${[...urls].filter(u => u.includes("eugeneyan")).join(", ")}`,
    );

    // URL da edição mais recente também
    assert.ok(urls.has("https://techcrunch.com/recent-news"));

    // Total: 8 edições × ~2 URLs = pelo menos 8 URLs
    assert.ok(urls.size >= 8, `esperado >= 8 URLs, got ${urls.size}`);
  });

  it("retorna Set vazio para MD vazio", () => {
    const urls = extractPastUrlsUnbounded("");
    assert.equal(urls.size, 0);
  });

  it("canonicaliza URLs (remove utm_source)", () => {
    const md = `## 2026-06-22 — "X"

Links usados:
- https://example.com/article?utm_source=newsletter&id=1
`;
    const urls = extractPastUrlsUnbounded(md);
    assert.ok(urls.has("https://example.com/article?id=1"));
    assert.ok(!urls.has("https://example.com/article?utm_source=newsletter&id=1"));
  });
});

// ---------------------------------------------------------------------------
// dedupEvergreenBuckets — cenário real #2548 Furo 1
// ---------------------------------------------------------------------------

describe("dedupEvergreenBuckets — regressão #2548 Furo 1", () => {
  const pastUrls = extractPastUrlsUnbounded(PAST_MD);

  it("CENÁRIO REAL: remove use_melhor com URL publicada há 6 edições (além da janela 4)", () => {
    // URL publicada na edição -6 (além da janela de 4 do dedup.ts).
    // Com dedup.ts sozinho, passaria. Com dedup-evergreen-buckets, é removida.
    const input = {
      lancamento: [],
      radar: [],
      use_melhor: [
        {
          // canonicalize() strips trailing slash → same as what extractPastUrlsUnbounded returns
          url: "https://eugeneyan.com/writing/working-with-ai",
          title: "Working with AI: A Practical Guide for Developers",
        },
        {
          url: "https://example-new.com/fresh-tutorial",
          title: "New AI Tutorial Never Published Before",
        },
      ],
      video: [],
    };

    const { kept, removed } = dedupEvergreenBuckets(input, pastUrls);

    assert.equal(removed.length, 1, "deve remover 1 item (URL já publicada)");
    assert.equal(
      removed[0].url,
      "https://eugeneyan.com/writing/working-with-ai",
      "deve remover a URL evergreen repetida",
    );
    assert.equal(removed[0].bucket, "use_melhor");
    assert.ok(
      removed[0].dedup_note.includes("dedup evergreen"),
      `dedup_note deve mencionar 'dedup evergreen': ${removed[0].dedup_note}`,
    );

    assert.equal(kept.use_melhor?.length, 1, "deve preservar o tutorial novo");
    assert.equal(
      kept.use_melhor?.[0].url,
      "https://example-new.com/fresh-tutorial",
    );
  });

  it("CENÁRIO REAL: URL radar publicada há 6 edições NÃO é removida por este script", () => {
    // Este script só toca use_melhor e video.
    // O radar com URL antiga deve passar — dedup.ts 1l já o controla com janela 4.
    const input = {
      lancamento: [],
      radar: [
        {
          url: "https://eugeneyan.com/writing/working-with-ai",
          title: "Qualquer título — radar com URL antiga",
        },
      ],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupEvergreenBuckets(input, pastUrls);

    // RADAR não é tocado por este script — só use_melhor e video
    assert.equal(removed.length, 0, "radar não deve ser removido por dedup-evergreen-buckets");
    assert.equal(kept.radar?.length, 1, "radar deve ser preservado integralmente");
  });

  it("URL nova (não em nenhuma edição passada) é preservada no use_melhor", () => {
    const input = {
      lancamento: [],
      radar: [],
      use_melhor: [
        {
          url: "https://brand-new-tutorial.com/ai-guide-2026",
          title: "Brand New Tutorial Never Published",
        },
      ],
      video: [],
    };

    const { kept, removed } = dedupEvergreenBuckets(input, pastUrls);

    assert.equal(removed.length, 0);
    assert.equal(kept.use_melhor?.length, 1);
  });

  it("bucket video também é coberto pelo dedup evergreen", () => {
    const input = {
      lancamento: [],
      radar: [],
      use_melhor: [],
      video: [
        {
          url: "https://example.com/news-7",
          title: "Vídeo com URL já publicada na edição -7",
        },
      ],
    };

    const { kept, removed } = dedupEvergreenBuckets(input, pastUrls);

    assert.equal(removed.length, 1, "URL de video já publicada deve ser removida");
    assert.equal(removed[0].bucket, "video");
    assert.equal(kept.video?.length, 0);
  });

  it("preserva campos extras do input (highlights, runners_up, metadata)", () => {
    const input = {
      lancamento: [],
      radar: [],
      use_melhor: [],
      video: [],
      highlights: [{ rank: 1, url: "https://h.com", title: "Destaque" }],
      metadata: { edition: "260626" },
    };

    const { kept } = dedupEvergreenBuckets(input, pastUrls);

    assert.deepEqual(
      (kept as { highlights: unknown }).highlights,
      input.highlights,
      "highlights deve ser preservado",
    );
    assert.deepEqual(
      (kept as { metadata: unknown }).metadata,
      input.metadata,
      "metadata deve ser preservada",
    );
  });

  it("pastUrls vazio = nenhuma remoção (bootstrap/CI sem past-editions.md)", () => {
    const input = {
      lancamento: [],
      radar: [],
      use_melhor: [
        { url: "https://eugeneyan.com/writing/working-with-ai/", title: "Tutorial" },
      ],
      video: [],
    };

    const { kept, removed } = dedupEvergreenBuckets(input, new Set());

    assert.equal(removed.length, 0, "sem histórico = sem remoção");
    assert.equal(kept.use_melhor?.length, 1);
  });

  it("lancamento NÃO é tocado pelo dedup evergreen", () => {
    const input = {
      // URL publicada na edição -6 mas está em lancamento, não use_melhor
      lancamento: [
        {
          url: "https://eugeneyan.com/writing/working-with-ai",
          title: "Launch from old URL in lancamento bucket",
        },
      ],
      radar: [],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupEvergreenBuckets(input, pastUrls);

    assert.equal(removed.length, 0, "lancamento não deve ser tocado");
    assert.equal(kept.lancamento?.length, 1);
  });
});
