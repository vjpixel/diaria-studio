/**
 * #9365 (causa 2): bônus de score por menção em newsletter recebida —
 * +5 por newsletter DISTINTA que cita o item, teto +15 (decisão do editor,
 * 01/10/2026). Regressão: antes, ser citado em N newsletters não pesava no
 * score, e o item perdia no ranking (31% das inclusões manuais medidas).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NEWSLETTER_MENTION_BONUS_CAP,
  NEWSLETTER_MENTION_BONUS_PER,
  articleNewsletterMentions,
  newsletterMentionBonus,
  unionNewsletterMentions,
} from "../scripts/lib/newsletter-mention-bonus.ts";
import { processThreads, mergeCapturedArticles, type CapturedThread } from "../scripts/capture-newsletter-urls.ts";
import { mergeInjectedIntoPool, type SyntheticInboxArticle } from "../scripts/inject-inbox-urls.ts";
import { mergeChunks } from "../scripts/merge-scored-chunks.ts";
import { toClusterSource } from "../scripts/lib/cluster-sources.ts";
import type { Categorized } from "../scripts/split-articles-for-scoring.ts";

const thread = (id: string, sender: string, body: string): CapturedThread => ({
  thread_id: id,
  sender,
  subject: `s-${id}`,
  date: "2026-10-01T10:00:00Z",
  body,
});

describe("newsletterMentionBonus (#9365)", () => {
  it("+5 por newsletter distinta, teto +15", () => {
    assert.equal(NEWSLETTER_MENTION_BONUS_PER, 5);
    assert.equal(NEWSLETTER_MENTION_BONUS_CAP, 15);
    assert.equal(newsletterMentionBonus(0), 0);
    assert.equal(newsletterMentionBonus(1), 5);
    assert.equal(newsletterMentionBonus(2), 10);
    assert.equal(newsletterMentionBonus(3), 15);
    assert.equal(newsletterMentionBonus(4), 15);
    assert.equal(newsletterMentionBonus(10), 15);
  });

  it("entrada inválida vira 0", () => {
    assert.equal(newsletterMentionBonus(-1), 0);
    assert.equal(newsletterMentionBonus(Number.NaN), 0);
  });

  it("união normaliza caixa e ignora lixo", () => {
    assert.deepEqual(unionNewsletterMentions(["A@x.com", "b@y.com"], ["a@X.com", "", 3, null], undefined), [
      "a@x.com",
      "b@y.com",
    ]);
  });

  it("conta menções do artigo + perdedores do cluster sem duplicar", () => {
    const m = articleNewsletterMentions({
      newsletter_mentions: ["a@x.com"],
      cluster_sources: [{ url: "u2", newsletter_mentions: ["b@y.com", "a@x.com"] }, { url: "u3" }],
    });
    assert.deepEqual(m, ["a@x.com", "b@y.com"]);
  });
});

describe("capture-newsletter-urls grava newsletter_mentions (#9365)", () => {
  it("mesma URL em 3 newsletters distintas → 1 artigo com 3 menções", () => {
    const threads = [
      thread("t1", "The Rundown <news@daily.therundown.ai>", "Leia https://openai.com/index/x hoje"),
      thread("t2", "AI Breakfast <aibreakfast@mail.beehiiv.com>", "Veja https://openai.com/index/x"),
      thread("t3", "Deep View <newsletter@thedeepview.co>", "Link https://openai.com/index/x e https://example.org/y"),
    ];
    const { articles } = processThreads(threads, { processed_thread_ids: [] });
    const openai = articles.filter((a) => a.url.includes("openai.com"));
    assert.equal(openai.length, 1);
    assert.deepEqual(openai[0].newsletter_mentions, [
      "news@daily.therundown.ai",
      "aibreakfast@mail.beehiiv.com",
      "newsletter@thedeepview.co",
    ]);
    const other = articles.find((a) => a.url.includes("example.org"));
    assert.deepEqual(other?.newsletter_mentions, ["newsletter@thedeepview.co"]);
  });

  it("2 edições da MESMA newsletter contam 1 vez", () => {
    const threads = [
      thread("t1", "Rundown <news@daily.therundown.ai>", "https://openai.com/index/x"),
      thread("t2", "Rundown <news@daily.therundown.ai>", "https://openai.com/index/x"),
    ];
    const { articles } = processThreads(threads, { processed_thread_ids: [] });
    assert.deepEqual(articles[0].newsletter_mentions, ["news@daily.therundown.ai"]);
  });

  it("re-run da edição une menções com a saída já gravada", () => {
    const existing: SyntheticInboxArticle[] = [
      { url: "https://a.com/1", source: "s", title: "t", flag: "newsletter_extracted", newsletter_mentions: ["a@x.com"] },
    ];
    const fresh: SyntheticInboxArticle[] = [
      { url: "https://a.com/1", source: "s", title: "t", flag: "newsletter_extracted", newsletter_mentions: ["b@y.com"] },
      { url: "https://a.com/2", source: "s", title: "t", flag: "newsletter_extracted", newsletter_mentions: ["b@y.com"] },
    ];
    const merged = mergeCapturedArticles(existing, fresh);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0].newsletter_mentions, ["a@x.com", "b@y.com"]);
    assert.deepEqual(existing[0].newsletter_mentions, ["a@x.com"], "não muta a entrada");
  });
});

describe("inject-inbox-urls preserva menções em URL que a pesquisa já trouxe (#9365)", () => {
  it("anota o artigo do pool em vez de descartar a menção", () => {
    const pool = [{ url: "https://a.com/1", title: "pesquisa" }];
    const injected: SyntheticInboxArticle[] = [
      { url: "https://a.com/1", source: "s", title: "t", flag: "newsletter_extracted", newsletter_mentions: ["a@x.com"] },
      { url: "https://a.com/2", source: "s", title: "t", flag: "newsletter_extracted", newsletter_mentions: ["b@y.com"] },
    ];
    const { merged, newInjected } = mergeInjectedIntoPool(pool, injected);
    assert.equal(merged.length, 2);
    assert.equal(newInjected.length, 1);
    assert.deepEqual((merged[0] as { newsletter_mentions?: string[] }).newsletter_mentions, ["a@x.com"]);
    assert.equal((merged[0] as { title: string }).title, "pesquisa");
    assert.equal((pool[0] as { newsletter_mentions?: string[] }).newsletter_mentions, undefined, "não muta o pool");
  });
});

describe("toClusterSource preserva newsletter_mentions do perdedor (#9365)", () => {
  it("campo presente só quando há menção", () => {
    assert.deepEqual(toClusterSource({ url: "u", newsletter_mentions: ["A@x.com"] }).newsletter_mentions, ["a@x.com"]);
    assert.equal("newsletter_mentions" in toClusterSource({ url: "u" }), false);
  });
});

describe("mergeChunks aplica o bônus de menção em newsletter (#9365)", () => {
  const mk = (url: string, extra: Record<string, unknown> = {}) => ({ url, title: url, category: "noticias", ...extra });
  const CAT: Categorized = {
    lancamento: [],
    radar: [
      mk("plain"),
      mk("one", { newsletter_mentions: ["a@x.com"] }),
      mk("five", { newsletter_mentions: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"] }),
      mk("cluster", {
        newsletter_mentions: ["a@x.com"],
        cluster_sources: [{ url: "other", newsletter_mentions: ["b@x.com"] }],
      }),
    ],
    use_melhor: [],
    video: [],
  };
  const chunks = [
    {
      all_scored: [
        { url: "plain", score: 70 },
        { url: "one", score: 68 },
        { url: "five", score: 50 },
        { url: "cluster", score: 40 },
      ],
    },
  ];

  it("+5 por newsletter, teto +15, união com o cluster; auditável", () => {
    const r = mergeChunks(CAT, chunks, 15);
    const by = new Map(r.all_scored.map((s) => [s.url, s]));
    assert.equal(by.get("plain")?.score, 70);
    assert.equal(by.get("one")?.score, 73);
    assert.equal(by.get("five")?.score, 65, "teto +15 com 5 newsletters");
    // cluster: +5 cobertura (1 fonte extra) + 10 (2 newsletters distintas)
    assert.equal(by.get("cluster")?.score, 55);
    assert.deepEqual(by.get("cluster")?.bonuses_applied, ["coverage:+5", "newsletter:+10"]);
    assert.equal(by.get("one")?.score_base, 68);
    assert.deepEqual(by.get("one")?.bonuses_applied, ["newsletter:+5"]);
    assert.equal(by.get("plain")?.bonuses_applied, undefined);
  });

  it("o bônus muda o ranking: item citado passa o que não foi", () => {
    const r = mergeChunks(CAT, chunks, 1);
    assert.equal(r.finalists[0].url, "one");
    const one = r.finalists[0].article as { score_bonus_newsletter?: number };
    assert.equal(one.score_bonus_newsletter, 5);
  });
});
