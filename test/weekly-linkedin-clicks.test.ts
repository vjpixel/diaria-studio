/**
 * test/weekly-linkedin-clicks.test.ts (#4456)
 *
 * Cruzamento de candidatos com o cache local de cliques do Beehiiv — sem
 * rede, sem disco (opera sobre fixtures em memória, mesmo padrão do resto
 * da suíte desta issue).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aammddFromEpochSeconds,
  matchPostsToWindow,
  identifyWeeklyPostsNeedingClicks,
  clickCountsForUrl,
  uniqueOpensOf,
  normalizeUrl,
  type BeehiivCachePost,
} from "../scripts/lib/weekly-linkedin-clicks.ts";

function epochFor(aammdd: string): number {
  const yy = Number(aammdd.slice(0, 2));
  const mm = Number(aammdd.slice(2, 4));
  const dd = Number(aammdd.slice(4, 6));
  return Math.floor(new Date(2000 + yy, mm - 1, dd, 8, 0, 0).getTime() / 1000);
}

describe("aammddFromEpochSeconds", () => {
  it("converte epoch seconds pra AAMMDD local", () => {
    assert.equal(aammddFromEpochSeconds(epochFor("260728")), "260728");
  });
});

describe("matchPostsToWindow", () => {
  const posts: BeehiivCachePost[] = [
    { id: "post_a", status: "confirmed", publish_date: epochFor("260728") },
    { id: "post_b", status: "confirmed", publish_date: epochFor("260729") },
    { id: "post_c", status: "draft", publish_date: epochFor("260730") }, // não confirmado — fora
    { id: "post_d", status: "confirmed", publish_date: epochFor("260801") }, // fora da janela
  ];
  const window = ["260727", "260728", "260729", "260730", "260731"];

  it("mapeia AAMMDD → post só pros confirmados dentro da janela", () => {
    const map = matchPostsToWindow(posts, window);
    assert.equal(map.size, 2);
    assert.equal(map.get("260728")?.id, "post_a");
    assert.equal(map.get("260729")?.id, "post_b");
    assert.equal(map.has("260730"), false);
    assert.equal(map.has("260801"), false);
  });
});

describe("identifyWeeklyPostsNeedingClicks — SEM corte de idade (diferente de beehiiv-sync.ts)", () => {
  it("post recente (2 dias) com email.clicks>0 e stats.clicks vazio entra no manifest", () => {
    const posts = new Map<string, BeehiivCachePost>([
      ["260731", { id: "post_recent", title: "Post recente", status: "confirmed", stats: { email: { clicks: 5, unique_opens: 100 } } }],
    ]);
    const manifest = identifyWeeklyPostsNeedingClicks(posts);
    assert.deepEqual(manifest, [{ id: "post_recent", title: "Post recente", email_clicks: 5 }]);
  });

  it("post já enriquecido (stats.clicks não-vazio) NÃO entra no manifest", () => {
    const posts = new Map<string, BeehiivCachePost>([
      [
        "260731",
        {
          id: "post_ok",
          status: "confirmed",
          stats: { email: { clicks: 5, unique_opens: 100 }, clicks: [{ url: "https://x.com", email: { unique_verified_clicks: 5 } }] },
        },
      ],
    ]);
    assert.deepEqual(identifyWeeklyPostsNeedingClicks(posts), []);
  });

  it("post sem clique agregado (email.clicks=0) NÃO entra no manifest", () => {
    const posts = new Map<string, BeehiivCachePost>([
      ["260731", { id: "post_zero", status: "confirmed", stats: { email: { clicks: 0, unique_opens: 100 } } }],
    ]);
    assert.deepEqual(identifyWeeklyPostsNeedingClicks(posts), []);
  });

  it("post sem stats.email (não só clicks: 0) NÃO entra no manifest", () => {
    const posts = new Map<string, BeehiivCachePost>([["260731", { id: "post_no_email", status: "confirmed", stats: {} }]]);
    assert.deepEqual(identifyWeeklyPostsNeedingClicks(posts), []);
  });

  it('recalibração 260802 (fleet review #4383 achado 1): usa email.verified_clicks como denominador — reproduz post real "Anthropic lança Claude Opus 4.7" (7 linhas, clicks=32, verified=24, soma=9) — completo pelo piso de linhas', () => {
    const rows = [
      { url: "a", email: { verified_clicks: 9 } },
      { url: "b", email: { verified_clicks: 0 } },
      { url: "c", email: { verified_clicks: 0 } },
      { url: "d", email: { verified_clicks: 0 } },
      { url: "e", email: { verified_clicks: 0 } },
      { url: "f", email: { verified_clicks: 0 } },
      { url: "g", email: { verified_clicks: 0 } },
    ];
    const posts = new Map<string, BeehiivCachePost>([
      [
        "260731",
        {
          id: "post_real_4383",
          status: "confirmed",
          stats: { email: { clicks: 32, verified_clicks: 24 }, clicks: rows },
        },
      ],
    ]);
    assert.deepEqual(identifyWeeklyPostsNeedingClicks(posts), []);
  });

  it("#4493: post com cache PARCIAL — 1 linha cobrindo bem menos da metade do agregado — entra no manifest", () => {
    // Reprodução do achado real (26w31): 5 posts confirmados tinham
    // exatamente 1 linha em stats.clicks apesar de email.clicks 34-51. O
    // gate antigo (stats.clicks.length > 0) nunca detectava isso.
    const posts = new Map<string, BeehiivCachePost>([
      [
        "260731",
        {
          id: "post_partial",
          title: "Post parcial",
          status: "confirmed",
          stats: {
            email: { clicks: 38, unique_opens: 134 },
            clicks: [{ url: "https://exemplo.com/a", email: { verified_clicks: 1 } }],
          },
        },
      ],
    ]);
    assert.deepEqual(identifyWeeklyPostsNeedingClicks(posts), [
      { id: "post_partial", title: "Post parcial", email_clicks: 38 },
    ]);
  });

  it("#4493: post com cache saudável (24+ linhas somando perto do agregado) NÃO entra no manifest", () => {
    const healthyRows = Array.from({ length: 24 }, (_, i) => ({
      url: `https://exemplo.com/link-${i}`,
      email: { verified_clicks: 1 },
    }));
    const posts = new Map<string, BeehiivCachePost>([
      [
        "260731",
        {
          id: "post_healthy",
          status: "confirmed",
          stats: { email: { clicks: 24, unique_opens: 134 }, clicks: healthyRows }, // soma = 24/24 = 100%
        },
      ],
    ]);
    assert.deepEqual(identifyWeeklyPostsNeedingClicks(posts), []);
  });
});

describe("clickCountsForUrl", () => {
  const clicks = [
    { url: "https://exemplo.com/a?utm_source=x", base_url: "https://exemplo.com/a", email: { unique_verified_clicks: 3 }, web: { total_unique_clicked: 1 } },
    { url: "https://exemplo.com/a?utm_source=y", base_url: "https://exemplo.com/a", email: { unique_verified_clicks: 2 }, web: { total_unique_clicked: 0 } },
    { url: "https://exemplo.com/b", email: { unique_verified_clicks: 9 } },
  ];

  it("soma cliques de todas as variantes (query string) que casam com a mesma base_url", () => {
    const c = clickCountsForUrl("https://exemplo.com/a", clicks);
    assert.equal(c.uniqueVerifiedClicks, 5);
    assert.equal(c.webUniqueClicks, 1);
  });

  it("URL sem match retorna zero (nunca lança)", () => {
    const c = clickCountsForUrl("https://exemplo.com/nao-existe", clicks);
    assert.deepEqual(c, { uniqueVerifiedClicks: 0, webUniqueClicks: 0 });
  });

  it("clicks undefined/vazio retorna zero", () => {
    assert.deepEqual(clickCountsForUrl("https://exemplo.com/a", undefined), { uniqueVerifiedClicks: 0, webUniqueClicks: 0 });
    assert.deepEqual(clickCountsForUrl("https://exemplo.com/a", []), { uniqueVerifiedClicks: 0, webUniqueClicks: 0 });
  });
});

describe("uniqueOpensOf", () => {
  it("lê stats.email.unique_opens", () => {
    assert.equal(uniqueOpensOf({ id: "x", stats: { email: { unique_opens: 179 } } }), 179);
  });
  it("post undefined ou sem stats retorna 0", () => {
    assert.equal(uniqueOpensOf(undefined), 0);
    assert.equal(uniqueOpensOf({ id: "x" }), 0);
  });
});

describe("normalizeUrl", () => {
  it("remove query/hash/barra final e lowercase o host", () => {
    assert.equal(normalizeUrl("HTTPS://Exemplo.com/Artigo/?utm_source=x#frag"), "https://exemplo.com/Artigo");
  });
});
