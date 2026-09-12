/**
 * prep-weekly-twitter.test.ts (#8056)
 *
 * Testa `buildTwitterWeeklyPost` — o núcleo determinístico de
 * `prep-weekly-twitter.ts` (recebe itens já selecionados + edições root,
 * devolve o payload pronto pro Buffer MCP). Não testa `runOneMode`/`main`
 * (dependem de seleção por clique + cache Beehiiv/Kit, cobertos
 * indiretamente pelo dry-run manual — ver conversa da sessão 260912).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildTwitterWeeklyPost } from "../scripts/prep-weekly-twitter.ts";
import { TWITTER_WEEKLY_MAX_ITEMS } from "../scripts/lib/format-weekly-social.ts";
import type { InstagramRankedCandidate } from "../scripts/lib/weekly-instagram-select.ts";

function candidateFixture(
  overrides: Partial<InstagramRankedCandidate> & Pick<InstagramRankedCandidate, "title" | "url" | "editionDate" | "destaqueNumber">,
): InstagramRankedCandidate {
  return {
    body: "",
    why: "",
    category: "NOTÍCIAS",
    kind: "destaque",
    uniqueVerifiedClicks: 0,
    webUniqueClicks: 0,
    opens: 100,
    ratePct: 0,
    excluded: false,
    hasClickData: true,
    ...overrides,
  };
}

function makeEditionWithImage(root: string, date: string, n: 1 | 2 | 3): void {
  const dir = resolve(root, date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "06-public-images.json"), JSON.stringify({ images: { [`d${n}`]: { url: `https://cdn.example.com/${date}-d${n}.jpg` } } }), "utf8");
}

describe("buildTwitterWeeklyPost (#8056)", () => {
  it("corta pra TWITTER_WEEKLY_MAX_ITEMS ANTES de resolver imagem — nunca resolve imagem de item que será descartado", async () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-twitter-"));
    try {
      const dates = ["260908", "260909", "260910", "260911", "260912"]; // 5 itens
      dates.forEach((d) => makeEditionWithImage(root, d, 1));
      const items = dates.map((d, i) => candidateFixture({ title: `Item ${i + 1}`, url: `https://x/${d}`, editionDate: d, destaqueNumber: 1 }));
      assert.equal(items.length, 5, "sanity check — pool tem mais itens que o cap do X");

      const result = await buildTwitterWeeklyPost(items, root, "clicked", "weekly-clicked", "2026-09-13T11:00:00-03:00");
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.post.imageUrls.length, TWITTER_WEEKLY_MAX_ITEMS, `deveria ter só ${TWITTER_WEEKLY_MAX_ITEMS} imagens, veio ${result.post.imageUrls.length}`);
      assert.equal(result.post.altTexts.length, TWITTER_WEEKLY_MAX_ITEMS);
      // Item 5 (260912) NUNCA deveria aparecer — nem no texto, nem nas imagens.
      assert.ok(!result.post.imageUrls.some((u) => u.includes("260912")), "5º item (descartado) não deveria ter imagem resolvida");
      assert.ok(!result.post.text.includes("Item 5"), "5º item (descartado) não deveria aparecer no texto");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("texto e imagens SEMPRE descrevem os MESMOS itens, na mesma ordem — nunca um subconjunto diferente do outro", async () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-twitter-order-"));
    try {
      const dates = ["260908", "260909", "260910"];
      dates.forEach((d) => makeEditionWithImage(root, d, 2));
      const items = dates.map((d, i) => candidateFixture({ title: `Título ${i + 1}`, url: `https://x/${d}`, editionDate: d, destaqueNumber: 2 }));
      const result = await buildTwitterWeeklyPost(items, root, "highlights", "weekly-highlights", "2026-09-12T15:00:00-03:00");
      assert.equal(result.ok, true);
      if (!result.ok) return;
      // Ordem das imagens bate com a ordem dos itens (mesma ordem de `dates`).
      assert.deepEqual(result.post.imageUrls, dates.map((d) => `https://cdn.example.com/${d}-d2.jpg`));
      // O texto numera os itens na MESMA ordem.
      items.forEach((it, i) => {
        assert.ok(result.post.text.includes(`${i + 1}. ${it.title}`), `texto deveria conter "${i + 1}. ${it.title}"`);
      });
      assert.deepEqual(result.post.altTexts, items.map((it) => it.title));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("propaga falha de resolução de imagem (nunca publica parcial — mesmo racional do Instagram/Facebook/Threads)", async () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-twitter-fail-"));
    try {
      mkdirSync(resolve(root, "260908"), { recursive: true }); // SEM 06-public-images.json
      const items = [candidateFixture({ title: "Sem imagem", url: "https://x/1", editionDate: "260908", destaqueNumber: 1 })];
      const result = await buildTwitterWeeklyPost(items, root, "highlights", "weekly-highlights", "2026-09-12T15:00:00-03:00");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /public_image_url_missing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("destaqueKey e dueAt passados são preservados literalmente no post", async () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-twitter-fields-"));
    try {
      makeEditionWithImage(root, "260908", 1);
      const items = [candidateFixture({ title: "T", url: "https://x/1", editionDate: "260908", destaqueNumber: 1 })];
      const result = await buildTwitterWeeklyPost(items, root, "clicked", "weekly-clicked", "2026-09-13T11:00:00-03:00");
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.post.destaque, "weekly-clicked");
      assert.equal(result.post.dueAt, "2026-09-13T11:00:00-03:00");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
