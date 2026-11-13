/**
 * test/social-feed-reconcile-13009.test.ts (#13009, #13008)
 *
 * Reconciliação pós-disparo contra o feed da conta: permalink gravado quando
 * o post está no feed; `send_unknown` (absent_from_feed) quando o horário venceu e
 * o feed cobre a janela sem o post — o caso do `um` do Instagram de 261023,
 * que o reconciliador do Worker marcou "confirmado com alta confiança".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyFeedDecision,
  contentTokens,
  decideFeedReconcile,
  earliestPendingSchedule,
  formatAbsentAlarm,
  needsFeedReconcile,
  parseFeedTime,
  reconcilePostsAgainstFeeds,
  tokenOverlap,
  type FeedItem,
  type FeedRead,
} from "../scripts/lib/social-feed-reconcile.ts";
import {
  fetchInstagramFeed,
  fetchLinkedInPageFeed,
  parseGraphPage,
  parseLinkedInPage,
  readFeedPages,
} from "../scripts/lib/social-feed-fetch.ts";
import { lookbackEditions, makeTextResolver, readPendingFeeds } from "../scripts/reconcile-social-permalinks.ts";
import { analyzePrevSocial, formatPrevSocialSummary } from "../scripts/lib/prev-social-status.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const UM_TEXT =
  "O InfoMoney liberou um ebook gratuito que ensina a montar planilhas de orçamento com o ChatGPT, passo a passo, para quem nunca usou fórmulas.";
const D1_TEXT = "O Nubank anunciou que vai usar agentes de inteligência artificial para detectar fraude em transferências Pix em tempo real.";

function entry(over: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "instagram",
    destaque: "um",
    url: null,
    status: "scheduled",
    scheduled_at: "2026-10-23T13:00:00-03:00", // 16:00Z
    worker_queue_key: "queue:2026-10-23T16:00:00.000Z:abc",
    ...over,
  };
}

function item(over: Partial<FeedItem> = {}): FeedItem {
  return { id: "m1", permalink: "https://www.instagram.com/p/AAA/", timestamp: "2026-10-23T16:00:40+0000", text: null, productType: "FEED", ...over };
}

function feed(items: FeedItem[], coveredSince = "2026-10-20T00:00:00.000Z"): FeedRead {
  return { items, coveredSince, error: null };
}

const LATE = new Date("2026-10-24T13:44:00Z");

describe("caso real 261023 (#13008): IG `um` dado como publicado e ausente do feed", () => {
  // O feed daquele dia: só os posts das 12:00Z e 20:00Z (outros conteúdos),
  // nenhum perto das 16:00Z nem com o texto do `um`.
  const published = entry({
    status: "published",
    published_at: "2026-10-24T13:44:27.335Z",
    verification_note: "confirmed_by_worker_high_confidence: Graph API media_publish ...",
  });
  const realFeed = feed([
    item({ id: "noon", timestamp: "2026-10-23T12:00:05+0000", text: "Reels do dia sobre outro assunto completamente diferente", productType: "REELS" }),
    item({ id: "eve", timestamp: "2026-10-23T20:00:03+0000", text: D1_TEXT }),
  ]);

  it("vira send_unknown (nunca failed) com absent_from_feed, preservando o status anterior", () => {
    const { posts, summary } = reconcilePostsAgainstFeeds([published], { instagram: realFeed }, () => UM_TEXT, LATE);
    // send_unknown, não failed: a retomada da Etapa 5 pula send_unknown e
    // repostaria um failed (duplicata se o casamento errou — review PR #13016).
    assert.equal(posts[0].status, "send_unknown");
    assert.notEqual(posts[0].status, "failed");
    assert.match(posts[0].failure_reason as string, /^absent_from_feed:/);
    assert.equal(posts[0].previous_status, "published");
    assert.match(posts[0].verification_note as string, /confirmed_by_worker_high_confidence/);
    assert.equal(summary.absent.length, 1);
    assert.match(formatAbsentAlarm(summary) ?? "", /ALARME \(#13008\): 1 post.*instagram\/um/);
  });

  it("o check 0l passa a listar o post com rótulo próprio", () => {
    const { posts } = reconcilePostsAgainstFeeds([published], { instagram: realFeed }, () => UM_TEXT, LATE);
    const report = analyzePrevSocial(posts, LATE);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].reason, "absent-from-feed");
    assert.match(formatPrevSocialSummary(report, "261023") ?? "", /ausente do feed da conta/);
  });

  it("a entrada ausente não volta a ser reconciliada e um registro antigo `failed` mantém o rótulo", () => {
    const { posts } = reconcilePostsAgainstFeeds([published], { instagram: realFeed }, () => UM_TEXT, LATE);
    assert.equal(needsFeedReconcile(posts[0]), false);
    const legacy = { ...posts[0], status: "failed" as const };
    assert.equal(analyzePrevSocial([legacy], LATE).findings[0].reason, "absent-from-feed");
    const plainUnknown = { ...posts[0], failure_reason: "worker_send_unknown: timeout" };
    assert.equal(analyzePrevSocial([plainUnknown], LATE).findings[0].reason, "send-unknown");
  });
});

describe("decideFeedReconcile — casamento", () => {
  it("casa pelo texto e grava permalink + horário do FEED (não o da reconciliação)", () => {
    const f = feed([item({ timestamp: "2026-10-23T16:07:00+0000", text: UM_TEXT + " #ChatGPT" })]);
    const { posts, summary } = reconcilePostsAgainstFeeds([entry()], { instagram: f }, () => UM_TEXT, LATE);
    assert.equal(summary.matched, 1);
    assert.equal(posts[0].status, "published");
    assert.equal(posts[0].url, "https://www.instagram.com/p/AAA/");
    assert.equal(posts[0].published_at, "2026-10-23T16:07:00.000Z");
    assert.equal(posts[0].platform_post_id, "m1");
    assert.match(posts[0].verification_note as string, /^confirmed_in_feed:/);
  });

  it("texto que não bate não casa, mesmo no horário exato — e não vira ausência (legenda pode ter sido reescrita)", () => {
    const d = decideFeedReconcile([entry()], [UM_TEXT], feed([item({ text: D1_TEXT })]), LATE);
    assert.equal(d[0].action, "none");
  });

  it("texto diferente FORA da janela curta não segura a ausência", () => {
    const d = decideFeedReconcile([entry()], [UM_TEXT], feed([item({ timestamp: "2026-10-23T19:00:00+0000", text: D1_TEXT })]), LATE);
    assert.equal(d[0].action, "absent");
  });

  it("sem texto, casa só pelo horário na janela curta", () => {
    const d = decideFeedReconcile([entry()], [null], feed([item({ timestamp: "2026-10-23T16:40:00+0000" })]), LATE);
    assert.equal(d[0].action, "matched");
    assert.equal(d[0].action === "matched" && d[0].by, "time");
  });

  it("sem texto, item 2h depois (fora da janela curta) não confirma o post", () => {
    const d = decideFeedReconcile([entry()], [null], feed([item({ timestamp: "2026-10-23T18:00:00+0000" })]), LATE);
    assert.equal(d[0].action, "absent");
  });

  it("Reels nunca confirma post de feed no Instagram (e vice-versa)", () => {
    const reels = item({ timestamp: "2026-10-23T16:01:00+0000", productType: "REELS" });
    assert.equal(decideFeedReconcile([entry()], [null], feed([reels]), LATE)[0].action, "absent");
    const reelsEntry = entry({ format: "reels" });
    assert.equal(decideFeedReconcile([reelsEntry], [null], feed([reels]), LATE)[0].action, "matched");
  });

  it("dois itens na janela curta sem texto = ambíguo, nada muda", () => {
    const f = feed([item({ id: "a", timestamp: "2026-10-23T16:00:00+0000" }), item({ id: "b", timestamp: "2026-10-23T16:30:00+0000" })]);
    const d = decideFeedReconcile([entry()], [null], f, LATE);
    assert.equal(d[0].action, "none");
    assert.equal(applyFeedDecision(entry(), d[0], LATE), null);
  });

  it("um item do feed casa com no máximo uma entrada", () => {
    const e1 = entry({ destaque: "d1", scheduled_at: "2026-10-23T13:00:00-03:00" });
    const e2 = entry({ destaque: "d2", scheduled_at: "2026-10-23T13:05:00-03:00" });
    const f = feed([item({ id: "only", timestamp: "2026-10-23T16:01:00+0000" })]);
    const d = decideFeedReconcile([e1, e2], [null, null], f, LATE);
    assert.deepEqual(d.map((x) => x.action), ["matched", "absent"]);
  });

  it("com texto, cada entrada fica com o item do próprio texto", () => {
    const e1 = entry({ destaque: "d1" });
    const e2 = entry({ destaque: "um" });
    const f = feed([item({ id: "x-um", text: UM_TEXT }), item({ id: "x-d1", timestamp: "2026-10-23T16:02:00+0000", text: D1_TEXT })]);
    const d = decideFeedReconcile([e1, e2], [D1_TEXT, UM_TEXT], f, LATE);
    assert.equal(d[0].action === "matched" && d[0].item.id, "x-d1");
    assert.equal(d[1].action === "matched" && d[1].item.id, "x-um");
  });
});

describe("decideFeedReconcile — quando NÃO declara ausência", () => {
  it("antes de 6h do horário agendado", () => {
    const d = decideFeedReconcile([entry()], [UM_TEXT], feed([]), new Date("2026-10-23T19:00:00Z"));
    assert.equal(d[0].action, "none");
  });
  it("leitura do feed falhou", () => {
    const d = decideFeedReconcile([entry()], [UM_TEXT], { items: [], coveredSince: null, error: "HTTP 500" }, LATE);
    assert.equal(d[0].action, "none");
  });
  it("leitura não alcançou o horário agendado (teto de páginas)", () => {
    const d = decideFeedReconcile([entry()], [UM_TEXT], feed([], "2026-10-23T18:00:00.000Z"), LATE);
    assert.equal(d[0].action, "none");
  });
});

describe("needsFeedReconcile / earliestPendingSchedule", () => {
  it("só IG/Threads/LinkedIn principal, sem url, scheduled ou published", () => {
    assert.equal(needsFeedReconcile(entry()), true);
    assert.equal(needsFeedReconcile(entry({ status: "published" })), true);
    assert.equal(needsFeedReconcile(entry({ url: "https://x" })), false);
    assert.equal(needsFeedReconcile(entry({ status: "failed" })), false);
    assert.equal(needsFeedReconcile(entry({ platform: "facebook" })), false);
    assert.equal(needsFeedReconcile(entry({ platform: "twitter" })), false);
    assert.equal(needsFeedReconcile(entry({ platform: "linkedin", subtype: "comment_diaria" })), false);
    assert.equal(needsFeedReconcile(entry({ platform: "linkedin", subtype: "main" })), true);
  });
  it("earliestPendingSchedule ignora entradas já com link", () => {
    const posts = [entry({ scheduled_at: "2026-10-23T07:00:00-03:00", url: "https://x" }), entry({ scheduled_at: "2026-10-23T11:00:00-03:00" })];
    assert.equal(earliestPendingSchedule(posts, "instagram"), "2026-10-23T14:00:00.000Z");
    assert.equal(earliestPendingSchedule(posts, "threads"), null);
  });
  it("reconcilePostsAgainstFeeds não toca canal sem feed lido", () => {
    const { posts, summary } = reconcilePostsAgainstFeeds([entry({ platform: "threads" })], { instagram: feed([]) }, () => null, LATE);
    assert.equal(posts[0].status, "scheduled");
    assert.equal(summary.undecided, 0);
  });
});

describe("tokens e horário", () => {
  it("parseFeedTime aceita +0000 da Graph API", () => {
    assert.equal(parseFeedTime("2026-10-23T16:00:09+0000"), Date.parse("2026-10-23T16:00:09Z"));
  });
  it("contentTokens tira acento, URL e palavras curtas", () => {
    const t = contentTokens("Inteligência é https://x.com/a muito útil");
    assert.ok(t.has("inteligencia"));
    assert.ok(t.has("muito"));
    assert.ok(!t.has("é"));
    assert.ok(![...t].some((x) => x.includes("http")));
    assert.equal(tokenOverlap(new Set(), t), 0);
  });
});

describe("social-feed-fetch", () => {
  it("parseGraphPage pula item sem permalink e lê o next", () => {
    const p = parseGraphPage(
      { data: [{ id: "1", permalink: "https://i/p/1", timestamp: "2026-10-23T16:00:00+0000", caption: "oi", media_product_type: "FEED" }, { id: "2" }], paging: { next: "https://n" } },
      "caption",
    );
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].text, "oi");
    assert.equal(p.next, "https://n");
    assert.throws(() => parseGraphPage({}, "caption"));
  });

  it("parseLinkedInPage monta o permalink pela URN e encerra em página incompleta", () => {
    const p = parseLinkedInPage({ elements: [{ id: "urn:li:share:1", publishedAt: Date.parse("2026-10-23T16:00:00Z"), commentary: "texto" }] }, "https://next", 50);
    assert.equal(p.items[0].permalink, "https://www.linkedin.com/feed/update/urn:li:share:1/");
    assert.equal(p.items[0].timestamp, "2026-10-23T16:00:00.000Z");
    assert.equal(p.next, null);
  });

  it("readFeedPages: feed esgotado cobre desde sempre; teto de páginas cobre só o lido", async () => {
    const one = async () => ({ items: [item({ timestamp: "2026-10-23T16:00:00+0000" })], next: null });
    const done = await readFeedPages("u", one, "2026-10-01T00:00:00Z");
    assert.equal(done.coveredSince, "1970-01-01T00:00:00.000Z");
    const endless = async () => ({ items: [item({ timestamp: "2026-10-23T16:00:00+0000" })], next: "more" });
    const capped = await readFeedPages("u", endless, "2026-10-01T00:00:00Z", 2);
    assert.equal(capped.coveredSince, "2026-10-23T16:00:00.000Z");
    const boom = await readFeedPages("u", async () => { throw new Error("HTTP 500"); }, "2026-10-01T00:00:00Z");
    assert.equal(boom.error, "HTTP 500");
  });

  it("fetchInstagramFeed: sem credencial vira erro (nunca ausência); token vai no header", async () => {
    const noCreds = await fetchInstagramFeed("2026-10-23T00:00:00Z", {});
    assert.match(noCreds.error ?? "", /credencial ausente/);
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string>).Authorization });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    await fetchInstagramFeed("2026-10-23T00:00:00Z", { INSTAGRAM_BUSINESS_ACCOUNT_ID: "17", INSTAGRAM_ACCESS_TOKEN: "SECRET" }, fakeFetch);
    assert.equal(seen[0].auth, "Bearer SECRET");
    assert.ok(!seen[0].url.includes("SECRET"));
  });

  it("fetchLinkedInPageFeed: finder por autor, versão no header", async () => {
    let headers: Record<string, string> = {};
    let url = "";
    const fakeFetch = async (u: string, init?: RequestInit) => {
      url = u;
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    };
    const r = await fetchLinkedInPageFeed(
      "2026-10-23T00:00:00Z",
      { LINKEDIN_ACCESS_TOKEN: "T", LINKEDIN_AUTHOR_URN: "urn:li:organization:9" },
      fakeFetch,
      new Date("2026-11-13T00:00:00Z"),
    );
    assert.equal(r.error, null);
    assert.match(url, /q=author&author=urn%3Ali%3Aorganization%3A9/);
    assert.equal(headers["LinkedIn-Version"], "202609");
    assert.equal(headers["X-RestLi-Method"], "FINDER");
  });
});

describe("reconcile-social-permalinks CLI helpers", () => {
  const md = "# Social\n\n## um\n\nTexto longo do social\n\n## um-cards\n\ncards\n\n# Curto\n\n## um\n\nTexto curto do threads\n";
  it("Threads lê `# Curto`; IG/LinkedIn leem `# Social`", () => {
    const t = makeTextResolver(md);
    assert.equal(t(entry({ platform: "threads" })), "Texto curto do threads");
    assert.equal(t(entry({ platform: "instagram" })), "Texto longo do social");
    assert.equal(t(entry({ platform: "linkedin", destaque: "d9" })), null);
    assert.equal(makeTextResolver(null)(entry()), null);
  });

  it("readPendingFeeds lê só canal com pendência, desde 1h antes, e converte exceção em erro", async () => {
    const calls: string[] = [];
    const feeds = await readPendingFeeds([entry(), entry({ platform: "linkedin" })], {
      instagram: async (since) => {
        calls.push(`ig:${since}`);
        return feed([]);
      },
      threads: async () => {
        calls.push("threads");
        return feed([]);
      },
      linkedin: async () => {
        throw new Error("rede");
      },
    });
    assert.deepEqual(calls, ["ig:2026-10-23T15:00:00.000Z"]);
    assert.equal(feeds.linkedin?.error, "rede");
    assert.equal(feeds.threads, undefined);
  });

  it("lookbackEditions volta N dias, virando mês e ano", () => {
    assert.deepEqual(lookbackEditions("261111", 3), ["261111", "261110", "261109"]);
    assert.deepEqual(lookbackEditions("270101", 2), ["270101", "261231"]);
    assert.deepEqual(lookbackEditions("261111", 0), ["261111"]);
    assert.deepEqual(lookbackEditions("abc", 3), []);
  });
});
