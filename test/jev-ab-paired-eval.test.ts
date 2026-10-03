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
  renderPairedReport,
  scoreAgainstTruth,
  tokensToUsd,
  urlsInMarkdown,
  verdictsFromRecordedArtifact,
  windowForEdition,
  type Arm,
  type EditionEval,
  type DedupDivergence,
} from "../scripts/lib/jev-ab-paired-eval.ts";
import { pairKey, type GrayZoneVerdict } from "../scripts/lib/dedup-grayzone-jev.ts";

const art = (title: string, url = `https://x.com/${encodeURIComponent(title)}`) => ({ url, title, summary: "", source: "s" });
const none = { published: new Set<string>(), approved: new Set<string>() };

test("normalizeUrlForMatch ignora www, barra final, utm/ref/fbclid e hash; fallback em URL inválida", () => {
  assert.equal(
    normalizeUrlForMatch("https://www.Ex.com/a/b/?utm_source=x&id=2&fbclid=z#top"),
    normalizeUrlForMatch("https://ex.com/a/b?id=2"),
  );
  assert.equal(normalizeUrlForMatch(" not a url/ "), "not a url");
});

test("flattenResearcherPool achata, deduplica por URL e tolera entrada inválida", () => {
  const pool = flattenResearcherPool([
    { source: "A", articles: [{ url: "https://a.com/1", title: "T1" }, { url: "https://a.com/1/", title: "T1 dup" }] },
    { source: "B", articles: [{ url: "https://b.com/2", title: "T2", summary: "s" }, { url: "", title: "sem url" }, { url: "https://c.com", title: "" }] },
  ]);
  assert.deepEqual(pool.map((p) => p.title), ["T1", "T2"]);
  assert.equal(pool[1].source, "B");
  assert.deepEqual(flattenResearcherPool({ not: "array" }), []);
});

test("pastWindow: só edições ANTERIORES, sem a própria, dedup e janela maior que o disponível", () => {
  assert.deepEqual(pastWindow(["260901", "260902", "260903", "260905", "260908"], "260903", 3), ["260902", "260901"]);
  assert.deepEqual(pastWindow(["260901", "260901", "260902"], "260910", 5), ["260902", "260901"]);
});

test("windowForEdition espelha defaultWindowDays no dia da pesquisa (D-1), inclusive virada de mês", () => {
  assert.equal(windowForEdition("260910"), 3); // qui → pesquisa qua
  assert.equal(windowForEdition("260911"), 3); // sex → pesquisa qui
  assert.equal(windowForEdition("260912"), 3); // sáb → pesquisa sex
  assert.equal(windowForEdition("260914"), 4); // seg → pesquisa dom
  assert.equal(windowForEdition("260913"), 4); // dom → pesquisa sáb
  assert.equal(windowForEdition("260901"), 4); // ter 01/09 → pesquisa seg 31/08
});

test("approvedItems: aninhado/plano, legado, 1º bucket vence, category e brazil_p gravados", () => {
  const items = approvedItems({
    highlights: [{ article: { url: "https://a.com/h", title: "H", category: "BRASIL", brazil_p: 0.9 } }],
    radar: [{ url: "https://a.com/r", title: "R" }, { url: "https://a.com/h/", title: "dup" }],
    noticias: [{ url: "https://a.com/n", title: "N" }],
  });
  assert.deepEqual(items.map((i) => [i.title, i.bucket]), [["H", "highlights"], ["R", "radar"], ["N", "noticias"]]);
  assert.equal(items[0].category, "BRASIL");
  assert.equal(items[0].brazilP, 0.9);
  assert.equal(items[1].brazilP, undefined);
});

test("urlsInMarkdown extrai links do 02-reviewed", () => {
  const s = urlsInMarkdown("**[x](https://www.a.com/p/)** e https://b.com/q?utm_x=1");
  assert.ok(s.has("a.com/p"));
  assert.ok(s.has("b.com/q"));
});

test("verdictsFromRecordedArtifact lê os records gravados ao vivo e ignora malformados", () => {
  const m = verdictsFromRecordedArtifact({
    records: [
      { candidate: "A", past: "B", jevSame: true, probability: 0.8, confidence: 1 },
      { candidate: "C", past: "D", jevSame: "sim", probability: 0.8, confidence: 1 },
      { candidate: "E", past: "F", jevSame: false, probability: Number.NaN, confidence: 1 },
    ],
  });
  assert.equal(m.size, 1);
  assert.deepEqual(m.get(pairKey("A", "B")), { sameStory: true, probability: 0.8, confidence: 1 });
  assert.equal(verdictsFromRecordedArtifact(undefined).size, 0);
});

// Par na zona cinzenta, abaixo do limiar da heurística (Jaccard ~0.43 < 0.55/0.6).
const pastLow = "OpenAI lança GPT-6 Astra modelo crítico";
const candLow = art("Exame: OpenAI lança GPT-6 Astra hoje");
// Par na zona cinzenta, ACIMA do limiar da heurística (baseline descarta).
const pastHigh = "Google lança Gemini 4 com agentes";
const candHigh = art("Google lança Gemini 4 com agentes hoje");

const v = (sameStory: boolean, confidence = 1): GrayZoneVerdict => ({ sameStory, probability: sameStory ? 0.9 : 0.1, confidence });

test("grayZonePairs reusa o coletor de produção (com contagem de truncados)", () => {
  const { pairs, truncated } = grayZonePairs([candLow], [pastLow]);
  assert.equal(pairs.length, 1);
  assert.equal(truncated, 0);
});

test("dedup: Jev confiante 'mesma história' derruba o que a heurística manteria", () => {
  const ev = evaluateDedupArticle(candLow, [pastLow], new Map([[pairKey(candLow.title, pastLow), v(true)]]));
  assert.equal(ev.baselineDrops, false);
  assert.equal(ev.jevDrops, true);
});

test("dedup: Jev confiante 'histórias distintas' mantém o que a heurística derrubaria", () => {
  const ev = evaluateDedupArticle(candHigh, [pastHigh], new Map([[pairKey(candHigh.title, pastHigh), v(false)]]));
  assert.equal(ev.baselineDrops, true);
  assert.equal(ev.jevDrops, false);
  const d = labelDedupDivergence(candHigh, ev, { published: new Set([normalizeUrlForMatch(candHigh.url)]), approved: new Set() })!;
  assert.equal(d.truth, "publicado");
  assert.equal(d.jevCorrect, true);
  assert.equal(d.baselineCorrect, false);
  assert.equal(d.jevGrave, false);
});

test("dedup: confiança abaixo do mínimo → heurística decide, sem divergência", () => {
  const ev = evaluateDedupArticle(candLow, [pastLow], new Map([[pairKey(candLow.title, pastLow), v(true, 0.5)]]));
  assert.equal(ev.baselineDrops, false);
  assert.equal(ev.jevDrops, false);
  assert.equal(labelDedupDivergence(candLow, ev, none), null);
});

test("dedup: veredito Jev fora da zona cinzenta é ignorado", () => {
  const far = "Receita de bolo de cenoura";
  const ev = evaluateDedupArticle(candLow, [far], new Map([[pairKey(candLow.title, far), v(true)]]));
  assert.equal(ev.jevDrops, false);
  assert.equal(ev.pairs.length, 0);
});

test("gabarito: publicado > aprovado > sem_gabarito; Jev derrubando item mantido é grave", () => {
  const ev = evaluateDedupArticle(candLow, [pastLow], new Map([[pairKey(candLow.title, pastLow), v(true)]]));
  const key = normalizeUrlForMatch(candLow.url);
  const both = labelDedupDivergence(candLow, ev, { published: new Set([key]), approved: new Set([key]) })!;
  assert.equal(both.truth, "publicado");
  assert.equal(both.jevGrave, true);
  assert.equal(both.baselineCorrect, true);
  const ap = labelDedupDivergence(candLow, ev, { published: new Set(), approved: new Set([key]) })!;
  assert.equal(ap.truth, "aprovado");
  assert.equal(ap.jevGrave, true);
  const no = labelDedupDivergence(candLow, ev, none)!;
  assert.equal(no.truth, "sem_gabarito");
  assert.equal(no.jevCorrect, null);
  assert.equal(no.jevGrave, false);
});

test("scoreAgainstTruth é a fonte única dos campos derivados", () => {
  assert.deepEqual(scoreAgainstTruth("sem_gabarito", true, false), { baselineCorrect: null, jevCorrect: null, jevGrave: false });
  assert.deepEqual(scoreAgainstTruth("aprovado", false, true), { baselineCorrect: true, jevCorrect: false, jevGrave: true });
});

test("brazilDivergence: só com brazil_p e lados discordando; limiar é inclusivo", () => {
  assert.equal(brazilDivergence({ url: "u", title: "t" }, true, undefined, 0.5), null);
  assert.equal(brazilDivergence({ url: "u", title: "t" }, true, 0.9, 0.5), null);
  assert.equal(brazilDivergence({ url: "u", title: "t" }, false, 0.9, 0.5)?.jev, true);
  assert.equal(brazilDivergence({ url: "u", title: "t" }, false, 0.5, 0.5)?.jev, true);
});

// Divergências geradas pela lógica real (não montadas à mão).
function realDiv(kind: "jevDrops" | "jevKeeps", truth: "publicado" | "aprovado" | "none"): DedupDivergence {
  const [cand, past, verdict] = kind === "jevDrops" ? [candLow, pastLow, v(true)] : [candHigh, pastHigh, v(false)];
  const key = normalizeUrlForMatch(cand.url);
  const kept = {
    published: new Set(truth === "publicado" ? [key] : []),
    approved: new Set(truth === "aprovado" ? [key] : []),
  };
  return labelDedupDivergence(cand, evaluateDedupArticle(cand, [past], new Map([[pairKey(cand.title, past), verdict]])), kept)!;
}

function ev(arm: Arm, dedup: DedupDivergence[], o: Partial<EditionEval> = {}): EditionEval {
  return {
    edition: "260901", arm, poolSize: 1, grayPairs: 1, grayPairsTruncated: 0, jevVerdicts: 1, jevVerdictsRecorded: 0,
    dedup, brazilItems: 0, brazilAnnotated: 0, brazil: [], jevCalls: 1, estTokens: 1, estUsd: 0.001, jevWallMs: null, notes: [], ...o,
  };
}

test("decide: sem edições lança (nunca 'indiferente' sem dados)", () => {
  assert.throws(() => decide([]), /nenhuma edição/);
});

test("decide: exatamente 1 divergência/edição → indiferente, mas avisa erro grave", () => {
  const out = decide([ev("A", [realDiv("jevDrops", "publicado")])]);
  assert.equal(out.outcome, "indiferente");
  assert.ok(out.reasons.some((r) => r.includes("erro(s) grave(s)")));
});

test("decide: 1 erro grave reprova (b) → nao_adotar; leitura estrita descarta só-aprovado", () => {
  const out = decide([ev("A", [realDiv("jevDrops", "aprovado"), realDiv("jevDrops", "none"), realDiv("jevKeeps", "none")])]);
  assert.equal(out.outcome, "nao_adotar");
  assert.equal(out.criteria.b, false);
  assert.equal(out.criteria.c, true);
  assert.equal(out.byArm.A.jevGrave, 1);
  const strict = decide([ev("A", [realDiv("jevDrops", "aprovado"), realDiv("jevDrops", "none"), realDiv("jevKeeps", "none")])], { strict: true });
  assert.equal(strict.jevGrave, 0);
  assert.equal(strict.labeled, 0);
  assert.equal(strict.outcome, "inconclusivo");
});

test("decide: (b) e (c) ok nunca vira 'adotar' retroativamente — (a) não demonstrável sem viés", () => {
  const out = decide([ev("B", [realDiv("jevKeeps", "publicado"), realDiv("jevKeeps", "publicado"), realDiv("jevKeeps", "publicado")])]);
  assert.equal(out.outcome, "inconclusivo");
  assert.equal(out.criteria.a, null);
  assert.equal(out.byArm.B.jevHits, 3);
});

test("decide: custo acima de US$1 reprova (c)", () => {
  const out = decide([ev("A", [realDiv("jevKeeps", "none"), realDiv("jevKeeps", "none")], { estUsd: 2 })]);
  assert.equal(out.criteria.c, false);
  assert.equal(out.outcome, "nao_adotar");
});

test("decide: cobertura Jev baixa → inconclusivo (falha silenciosa não vira 'sem divergência')", () => {
  const out = decide([ev("A", [], { grayPairs: 10, jevVerdicts: 2 })]);
  assert.equal(out.outcome, "inconclusivo");
  assert.ok(out.reasons[0].includes("cobertura"));
});

test("renderPairedReport: renderiza grave, sem veredito, robustez e puladas sem lançar", () => {
  const d = realDiv("jevDrops", "publicado");
  const noVerdict = { ...realDiv("jevKeeps", "none"), decisivePair: { ...realDiv("jevKeeps", "none").decisivePair, verdict: undefined } };
  const evals = [ev("A", [d, noVerdict, d], { jevWallMs: 1500 }), ev("B", [])];
  const md = renderPairedReport(evals, decide(evals), decide(evals, { strict: true }), [{ edition: "260999", reason: "sem pool" }]);
  assert.match(md, /ERRO GRAVE/);
  assert.match(md, /sem veredito/);
  assert.match(md, /Robustez/);
  assert.match(md, /260999: PULADA — sem pool/);
  assert.match(md, /1\.5s/);
});

test("tokensToUsd usa o preço público do Jev", () => {
  assert.equal(tokensToUsd(1_000_000), 0.042);
});
