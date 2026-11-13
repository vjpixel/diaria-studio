/**
 * test/social-reconcile-extra-stores-13009.test.ts (#13009, resíduo da PR #13016)
 *
 * A reconciliação pós-disparo conferia só o `06-social-published.json` das
 * edições, e o Facebook só da edição anterior. Aqui:
 *   - registros extras com o mesmo formato (semanal, divulgação mensal,
 *     anual) são achados quando têm post pendente na janela;
 *   - um item do feed já gravado como link de outro post nunca casa de novo
 *     (o semanal casado só por horário herdaria o link do destaque diário);
 *   - o Facebook olha as edições anteriores (os posts das 15:00/19:00 da
 *     edição anterior ainda estão agendados quando o Stage 0 roda).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  claimedFeedKeys,
  feedKey,
  needsFeedReconcile,
  reconcilePostsAgainstFeeds,
  withoutClaimedItems,
  type FeedItem,
  type FeedRead,
} from "../scripts/lib/social-feed-reconcile.ts";
import {
  discoverExtraSocialStores,
  isPendingInWindow,
  listExtraSocialStores,
  lookbackEditions,
  type StoreFs,
} from "../scripts/lib/social-reconcile-targets.ts";
import { lookbackEditions as lookbackFromCli } from "../scripts/reconcile-social-permalinks.ts";
import { facebookVerifyEditionDirs, isFacebookPendingEntry } from "../scripts/verify-facebook-posts.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const NOW = new Date("2026-11-03T12:00:00Z");

function weeklyEntry(over: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "instagram",
    destaque: "weekly-highlights",
    url: null,
    status: "scheduled",
    scheduled_at: "2026-10-31T14:15:00-03:00", // 17:15Z
    worker_queue_key: "queue:2026-10-31T17:15:00.000Z:x",
    ...over,
  };
}

function item(over: Partial<FeedItem> = {}): FeedItem {
  return { id: "m-daily", permalink: "https://www.instagram.com/p/DAILY/", timestamp: "2026-10-31T17:20:00+0000", text: "outro post", productType: "FEED", ...over };
}

function feed(items: FeedItem[]): FeedRead {
  return { items, coveredSince: "2026-10-25T00:00:00.000Z", error: null };
}

describe("item do feed já atribuído não casa de novo (#13009)", () => {
  it("regressão: o semanal sem texto não herda o link do post diário já reconciliado em outro arquivo", () => {
    const daily: PostEntry = {
      platform: "instagram",
      destaque: "d2",
      url: "https://www.instagram.com/p/DAILY/",
      platform_post_id: "m-daily",
      status: "published",
      scheduled_at: "2026-10-31T14:00:00-03:00",
    };
    const f = { instagram: feed([item()]) };

    // Sem a exclusão (o comportamento da PR #13016), o único item da janela
    // curta casava por horário e o semanal "saía publicado" com o link alheio.
    const naive = reconcilePostsAgainstFeeds([weeklyEntry()], f, () => null, NOW);
    assert.equal(naive.posts[0].url, "https://www.instagram.com/p/DAILY/", "premissa: sem claimed, casa por horário");

    const claimed = claimedFeedKeys([daily]);
    const { posts, summary } = reconcilePostsAgainstFeeds([weeklyEntry()], f, () => null, NOW, undefined, claimed);
    assert.notEqual(posts[0].url, "https://www.instagram.com/p/DAILY/");
    assert.equal(summary.matched, 0);
    // O feed cobre a janela e nada sobra: ausente, nunca "publicado".
    assert.equal(posts[0].status, "send_unknown");
  });

  it("dentro do mesmo arquivo, o link já gravado de uma entrada também fica fora", () => {
    const d2: PostEntry = { ...weeklyEntry({ destaque: "d2" }), url: "https://www.instagram.com/p/DAILY", status: "published" };
    const { posts } = reconcilePostsAgainstFeeds([d2, weeklyEntry()], { instagram: feed([item()]) }, () => null, NOW);
    assert.equal(posts[1].url, null);
  });

  it("o post do próprio semanal no feed continua casando", () => {
    const own = item({ id: "m-weekly", permalink: "https://www.instagram.com/p/WEEK/", timestamp: "2026-10-31T17:15:30+0000" });
    const claimed = claimedFeedKeys([{ ...weeklyEntry({ destaque: "d2" }), url: "https://www.instagram.com/p/DAILY/", platform_post_id: "m-daily" }]);
    const { posts } = reconcilePostsAgainstFeeds([weeklyEntry()], { instagram: feed([item(), own]) }, () => null, NOW, undefined, claimed);
    assert.equal(posts[0].url, "https://www.instagram.com/p/WEEK/");
    assert.equal(posts[0].status, "published");
  });

  it("feedKey ignora barra final e caixa; Facebook/Twitter não entram nas chaves", () => {
    assert.equal(feedKey("https://www.Instagram.com/p/X/"), feedKey("https://www.instagram.com/p/X"));
    const keys = claimedFeedKeys([
      { platform: "facebook", destaque: "d1", url: "https://facebook.com/p/1", status: "published", scheduled_at: null },
      { platform: "threads", destaque: "d1", url: "https://threads.com/p/2/", status: "published", scheduled_at: null },
    ]);
    assert.deepEqual([...keys], ["https://threads.com/p/2"]);
  });

  it("withoutClaimedItems preserva coveredSince e error", () => {
    const f: FeedRead = { items: [item()], coveredSince: "2026-10-01T00:00:00.000Z", error: null };
    const out = withoutClaimedItems(f, new Set(["m-daily"]));
    assert.equal(out.items.length, 0);
    assert.equal(out.coveredSince, f.coveredSince);
  });
});

function fakeFs(files: Record<string, unknown>): StoreFs {
  const paths = Object.keys(files);
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    exists: (p) => p in files,
    isDir: (p) => dirs.has(p),
    list: (dir) => [...new Set([...paths, ...dirs].filter((p) => p.startsWith(dir + "/")).map((p) => p.slice(dir.length + 1).split("/")[0]))],
    readJson: (p) => {
      const v = files[p];
      if (v === "BROKEN") throw new Error("json inválido");
      return v;
    },
  };
}

describe("registros extras (#13009)", () => {
  const D = "data";
  const weeklyPath = join(D, "weekly", "261031", "06-weekly-published.json");
  const oldWeekly = join(D, "weekly", "261017", "06-weekly-published.json");
  const monthly = join(D, "monthly", "2610-11", "_internal", "divulgacao-social-d2-published.json");
  const monthlyOther = join(D, "monthly", "2610-11", "_internal", "divulgacao-published.json");
  const annual = join(D, "annual", "2026-aniversario", "social", "tema-1", "_internal", "06-social-published.json");
  const broken = join(D, "weekly", "261024", "06-weekly-published.json");
  const fs = fakeFs({
    [weeklyPath]: { posts: [weeklyEntry()] },
    [oldWeekly]: { posts: [weeklyEntry({ scheduled_at: "2026-10-17T14:15:00-03:00" })] },
    [monthly]: { posts: [weeklyEntry({ destaque: "especial-retrospectiva", url: "https://www.instagram.com/p/OK/", status: "published" })] },
    [monthlyOther]: { posts: [weeklyEntry()] },
    [annual]: { posts: [weeklyEntry({ destaque: "anual-tema-1", scheduled_at: "2026-11-02T09:00:00-03:00" })] },
    [broken]: "BROKEN",
  });

  it("lista semanal, divulgação social da mensal e anual — e nada além disso", () => {
    const all = listExtraSocialStores(D, fs);
    assert.ok(all.includes(weeklyPath) && all.includes(oldWeekly) && all.includes(monthly) && all.includes(annual));
    assert.ok(!all.includes(monthlyOther), "divulgacao-published.json não é registro de posts sociais");
  });

  it("descobre só os que têm post pendente dentro da janela; JSON quebrado é pulado", () => {
    const found = discoverExtraSocialStores(D, needsFeedReconcile, NOW, 4, fs);
    assert.deepEqual(found.sort(), [annual, weeklyPath].sort());
  });

  it("isPendingInWindow: futuro e antigo ficam fora", () => {
    const pending = (e: PostEntry) => needsFeedReconcile(e);
    assert.equal(isPendingInWindow(weeklyEntry({ scheduled_at: "2026-11-04T09:00:00-03:00" }), pending, NOW, 4), false);
    assert.equal(isPendingInWindow(weeklyEntry({ scheduled_at: "2026-10-20T09:00:00-03:00" }), pending, NOW, 4), false);
    assert.equal(isPendingInWindow(weeklyEntry({ scheduled_at: null }), pending, NOW, 4), false);
    assert.equal(isPendingInWindow(weeklyEntry(), pending, NOW, 4), true);
  });

  it("o Facebook acha o registro pelo próprio predicado (scheduled com fb_post_id)", () => {
    const fbFs = fakeFs({
      [weeklyPath]: {
        posts: [{ platform: "facebook", destaque: "weekly-highlights", url: "x", status: "scheduled", scheduled_at: "2026-10-31T14:15:00-03:00", fb_post_id: "1_2" }],
      },
      [monthly]: {
        posts: [{ platform: "facebook", destaque: "especial", url: "x", status: "published", scheduled_at: "2026-11-02T14:15:00-03:00", fb_post_id: "1_3" }],
      },
    });
    assert.deepEqual(discoverExtraSocialStores(D, isFacebookPendingEntry, NOW, 4, fbFs), [weeklyPath]);
    assert.equal(isFacebookPendingEntry({ platform: "facebook", destaque: "d1", url: null, status: "scheduled", scheduled_at: null }), false);
  });
});

describe("Facebook com lookback (#13009)", () => {
  it("regressão: a edição anterior e as 2 antes dela entram, virando o mês", () => {
    const dirs = facebookVerifyEditionDirs("data/editions/2611/261101/", 3);
    assert.equal(dirs[0], "data/editions/2611/261101/");
    assert.deepEqual(dirs.slice(1), [join("data", "editions", "2610", "261031"), join("data", "editions", "2610", "261030")]);
  });

  it("sem lookback (ou diretório sem AAMMDD) é só o pedido", () => {
    assert.deepEqual(facebookVerifyEditionDirs("data/editions/2611/261101", 1), ["data/editions/2611/261101"]);
    assert.deepEqual(facebookVerifyEditionDirs("tmp/x", 3), ["tmp/x"]);
  });

  it("lookbackEditions segue reexportada pelo CLI do feed", () => {
    assert.equal(lookbackFromCli, lookbackEditions);
  });
});
