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
