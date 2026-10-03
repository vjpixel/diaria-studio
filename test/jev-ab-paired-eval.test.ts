import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvedItems,
  brazilDivergence,
  decide,
  evaluateDedupArticle,
  flattenResearcherPool,
  grayZonePairs,
  labelDedupDivergence,
  normalizeUrlForMatch,
  pastWindow,
  tokensToUsd,
  urlsInMarkdown,
  windowForEdition,
  type EditionEval,
  type DedupDivergence,
} from "../scripts/lib/jev-ab-paired-eval.ts";
import { pairKey } from "../scripts/lib/dedup-grayzone-jev.ts";

const art = (title: string, url = `https://x.com/${encodeURIComponent(title)}`) => ({ url, title, summary: "", source: "s" });

test("normalizeUrlForMatch ignora www, barra final, utm e hash", () => {
  assert.equal(
    normalizeUrlForMatch("https://www.Ex.com/a/b/?utm_source=x&id=2#top"),
    normalizeUrlForMatch("https://ex.com/a/b?id=2"),
  );
});

test("flattenResearcherPool achata e deduplica por URL", () => {
  const pool = flattenResearcherPool([
    { source: "A", articles: [{ url: "https://a.com/1", title: "T1" }, { url: "https://a.com/1/", title: "T1 dup" }] },
    { source: "B", articles: [{ url: "https://b.com/2", title: "T2", summary: "s" }, { url: "", title: "sem url" }] },
  ]);
  assert.deepEqual(pool.map((p) => p.title), ["T1", "T2"]);
  assert.equal(pool[1].source, "B");
});

test("pastWindow só olha edições ANTERIORES (nunca futuras)", () => {
  assert.deepEqual(pastWindow(["260901", "260902", "260903", "260905", "260908"], "260903", 3), ["260902", "260901"]);
});

test("windowForEdition espelha defaultWindowDays no dia da pesquisa (D-1)", () => {
  // 260910 = qui → pesquisa na qua → 3
  assert.equal(windowForEdition("260910"), 3);
  // 260914 = seg → pesquisa no dom → 4
  assert.equal(windowForEdition("260914"), 4);
});

test("approvedItems lê highlights aninhados e buckets planos", () => {
  const items = approvedItems({
    highlights: [{ article: { url: "https://a.com/h", title: "H" } }],
    radar: [{ url: "https://a.com/r", title: "R" }],
  });
  assert.deepEqual(items.map((i) => [i.title, i.bucket]), [["H", "highlights"], ["R", "radar"]]);
});

test("urlsInMarkdown extrai links do 02-reviewed", () => {
  const s = urlsInMarkdown("**[x](https://www.a.com/p/)** e https://b.com/q?utm_x=1");
  assert.ok(s.has("a.com/p"));
  assert.ok(s.has("b.com/q"));
});

const past = "OpenAI lança GPT-6 Astra modelo crítico";
const cand = art("Exame: OpenAI lança GPT-6 Astra hoje");

test("dedup: Jev confiante 'mesma história' na zona derruba o que a heurística manteria", () => {
  const pairs = grayZonePairs([cand], [past]);
  assert.equal(pairs.length, 1);
  const verdicts = new Map([[pairKey(cand.title, past), { sameStory: true, probability: 0.9, confidence: 1 }]]);
  const ev = evaluateDedupArticle(cand, [past], verdicts);
  assert.equal(ev.baselineDrops, false);
  assert.equal(ev.jevDrops, true);
});

test("dedup: confiança abaixo do mínimo → heurística decide, sem divergência", () => {
  const verdicts = new Map([[pairKey(cand.title, past), { sameStory: true, probability: 0.9, confidence: 0.5 }]]);
  const ev = evaluateDedupArticle(cand, [past], verdicts);
  assert.equal(ev.baselineDrops, ev.jevDrops);
  assert.equal(labelDedupDivergence(cand, ev, { published: new Set(), approved: new Set() }), null);
});

test("gabarito: Jev derruba item PUBLICADO → erro grave; fora do approved/reviewed → sem_gabarito", () => {
  const verdicts = new Map([[pairKey(cand.title, past), { sameStory: true, probability: 0.9, confidence: 1 }]]);
  const ev = evaluateDedupArticle(cand, [past], verdicts);
  const key = normalizeUrlForMatch(cand.url);
  const pub = labelDedupDivergence(cand, ev, { published: new Set([key]), approved: new Set() })!;
  assert.equal(pub.truth, "publicado");
  assert.equal(pub.jevGrave, true);
  assert.equal(pub.baselineCorrect, true);
  const none = labelDedupDivergence(cand, ev, { published: new Set(), approved: new Set() })!;
  assert.equal(none.truth, "sem_gabarito");
  assert.equal(none.jevCorrect, null);
  assert.equal(none.jevGrave, false);
});

test("brazilDivergence só reporta quando há brazil_p e os lados discordam", () => {
  assert.equal(brazilDivergence({ url: "u", title: "t" }, true, undefined, 0.5), null);
  assert.equal(brazilDivergence({ url: "u", title: "t" }, true, 0.9, 0.5), null);
  assert.equal(brazilDivergence({ url: "u", title: "t" }, false, 0.9, 0.5)?.jev, true);
});

function ev(dedup: Partial<DedupDivergence>[], usd = 0.001): EditionEval {
  return {
    edition: "260901", arm: "A", poolSize: 1, grayPairs: 1, jevVerdicts: 1,
    dedup: dedup.map((d) => ({
      url: "u", title: "t", baselineDrops: false, jevDrops: true,
      decisivePair: { past: "p", jaccard: 0.4, threshold: 0.6, heuristicSame: false, jevSame: true },
      truth: "sem_gabarito", baselineCorrect: null, jevCorrect: null, jevGrave: false, ...d,
    })),
    brazilItems: 0, brazilAnnotated: 0, brazil: [], jevCalls: 1, estTokens: 1, estUsd: usd, jevWallMs: null, notes: [],
  };
}

test("decide: divergências raras (≤1/edição) → indiferente", () => {
  assert.equal(decide([ev([{}]), ev([])]).outcome, "indiferente");
});

test("decide: 1 erro grave já reprova (b), mesmo com custo ok", () => {
  const grave = { truth: "aprovado" as const, jevCorrect: false, baselineCorrect: true, jevGrave: true };
  const v = decide([ev([grave, {}, {}])]);
  assert.equal(v.outcome, "nao_adotar");
  assert.equal(v.criteria.b, false);
  assert.equal(v.criteria.c, true);
  // Leitura estrita: "aprovado" deixa de contar como gabarito.
  const s = decide([ev([grave, {}, {}])], { strict: true });
  assert.equal(s.jevGrave, 0);
  assert.equal(s.labeled, 0);
});

test("decide: Jev acerta mais, sem grave, custo < US$1 → adotar", () => {
  const ok = { truth: "publicado" as const, jevDrops: false, baselineDrops: true, jevCorrect: true, baselineCorrect: false };
  assert.equal(decide([ev([ok, ok, ok])]).outcome, "adotar");
  assert.equal(decide([ev([ok, ok, ok], 2)]).criteria.c, false);
});

test("tokensToUsd usa o preço público do Jev", () => {
  assert.equal(tokensToUsd(1_000_000), 0.042);
});
