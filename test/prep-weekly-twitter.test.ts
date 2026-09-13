/**
 * prep-weekly-twitter.test.ts (#8056)
 *
 * Testa `buildTwitterWeeklyPost` — o núcleo determinístico de
 * `prep-weekly-twitter.ts` (recebe itens já selecionados + edições root,
 * devolve o payload pronto pro Buffer MCP). Não testa `runOneMode`/`main`
 * (dependem de seleção por clique + cache Beehiiv/Kit, cobertos
 * cobertos por dry-run manual contra a edição real 260912 antes deste commit
 * (não reproduzível aqui — sem artefato no repo, só a confirmação de que o
 * output bateu com os 2 posts publicados manualmente naquela rodada).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildTwitterWeeklyPost, runOneMode } from "../scripts/prep-weekly-twitter.ts";
import { TWITTER_WEEKLY_MAX_ITEMS } from "../scripts/lib/format-weekly-social.ts";
import { appendSocialPosts } from "../scripts/lib/social-published-store.ts";
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

/** Mesmo padrão de `test/publish-weekly-social.test.ts::setupEdition` —
 * escreve um `02-reviewed.md` mínimo com 1 destaque D1, mais a imagem 4:5
 * correspondente, pra `runOneMode` conseguir extrair/selecionar/resolver
 * de ponta a ponta. */
function setupEditionWithD1(editionsRoot: string, date: string, title: string): void {
  const dir = resolve(editionsRoot, date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "02-reviewed.md"),
    `DESTAQUE 1 | Notícias\n${title}\nhttps://exemplo.com/${date}\n\nCorpo do D1.\n\nPor que isso importa:\nExplicação.`,
    "utf8",
  );
  makeEditionWithImage(editionsRoot, date, 1);
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
      assert.equal(result.post.images.length, TWITTER_WEEKLY_MAX_ITEMS, `deveria ter só ${TWITTER_WEEKLY_MAX_ITEMS} imagens, veio ${result.post.images.length}`);
      // Item 5 (260912) NUNCA deveria aparecer — nem no texto, nem nas imagens.
      assert.ok(!result.post.images.some((img) => img.url.includes("260912")), "5º item (descartado) não deveria ter imagem resolvida");
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
      // Ordem das imagens bate com a ordem dos itens (mesma ordem de `dates`),
      // e cada imagem carrega o altText do MESMO item, estruturalmente (1
      // array de objetos, não 2 arrays paralelos — #8057 review).
      assert.deepEqual(
        result.post.images,
        dates.map((d, i) => ({ url: `https://cdn.example.com/${d}-d2.jpg`, altText: items[i].title })),
      );
      // O texto numera os itens na MESMA ordem.
      items.forEach((it, i) => {
        assert.ok(result.post.text.includes(`${i + 1}. ${it.title}`), `texto deveria conter "${i + 1}. ${it.title}"`);
      });
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

describe("runOneMode (#8056, achados #8057 review)", () => {
  const SATURDAY = "271225"; // futuro, evita colisão com testes de horário passado

  it("skip-existing reconhece status 'draft' — não só 'scheduled'/'published' (#8057, alta confiança: sem isso um post que só chegou a rascunho no Buffer seria duplicado num re-run)", async () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-twitter-draft-"));
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-twitter-draft-data-"));
    try {
      setupEditionWithD1(editionsRoot, "271220", "Título A");
      const publishedPath = resolve(dataRoot, "weekly", SATURDAY, "06-weekly-published.json");
      mkdirSync(resolve(dataRoot, "weekly", SATURDAY), { recursive: true });
      appendSocialPosts(publishedPath, [
        { platform: "twitter", destaque: "weekly-highlights", url: null, status: "draft", scheduled_at: null } as any,
      ]);

      // forceIncompleteWeek=true: isola o comportamento de skip-existing sendo
      // testado aqui — sem isso, o guard de WEEKLY_MIN_ITEMS (testado à parte
      // abaixo) dispararia primeiro com só 1 edição no pool.
      const { posts, skipped } = await runOneMode("highlights", SATURDAY, editionsRoot, dataRoot, "11:00", undefined, true, true, false);
      assert.equal(posts.length, 0);
      assert.deepEqual(skipped, [{ destaque: "weekly-highlights", reason: "already_draft" }]);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("seleção com menos itens que WEEKLY_MIN_ITEMS é pulada (nunca publica silenciosamente sobre semana curta) — mesma semântica que publish-weekly-social.ts já aplica a Instagram/Facebook/Threads (#8057)", async () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-twitter-shortweek-"));
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-twitter-shortweek-data-"));
    try {
      // Só 2 edições na semana (WEEKLY_MIN_ITEMS = 4) — modo "highlights" pega
      // no máximo 1 D1 por dia, então o pool nunca passa de 2 itens aqui.
      setupEditionWithD1(editionsRoot, "271220", "Título A");
      setupEditionWithD1(editionsRoot, "271221", "Título B");

      const { posts, skipped } = await runOneMode("highlights", SATURDAY, editionsRoot, dataRoot, "11:00", undefined, true, false, false);
      assert.equal(posts.length, 0);
      assert.equal(skipped.length, 1);
      assert.equal(skipped[0].destaque, "weekly-highlights");
      assert.match(skipped[0].reason, /^incomplete_week:/);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("--force-incomplete-week (forceIncompleteWeek=true) prossegue mesmo com seleção curta", async () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-twitter-forceweek-"));
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-twitter-forceweek-data-"));
    try {
      setupEditionWithD1(editionsRoot, "271220", "Título A");
      setupEditionWithD1(editionsRoot, "271221", "Título B");

      const { posts, skipped } = await runOneMode("highlights", SATURDAY, editionsRoot, dataRoot, "11:00", undefined, true, true, false);
      assert.equal(skipped.length, 0);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].images.length, 2);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
