/**
 * #9657: o veredito de rodada (#9652) considera a fonte saudável se QUALQUER
 * caminho trouxe artigo — um feed RSS quebrado fica invisível enquanto a busca
 * `site:` (paga, com cota) cobre a fonte. Caso real: VentureBeat (IA), RSS
 * `https://venturebeat.com/category/ai/feed/` em `HTTP 429` (challenge da
 * Vercel) em todas as rodadas de 04/09 a 04/10/2026, busca `site:` ok/empty.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRun,
  buildOutcomeEntry,
  emptyEntry,
  outcomePath,
  outcomePathFromOrigin,
  roundFailureStreak,
  roundFeedFailureStreak,
  type OutcomeLike,
  type RunRecord,
  type SourceEntry,
} from "../scripts/lib/source-runs.ts";
import {
  signalsFromSourceHealth,
  SOURCE_FEED_BROKEN_THRESHOLD_ROUNDS,
} from "../scripts/collect-edition-signals.ts";
import { dedupKey } from "../scripts/lib/auto-reporter-dedup.ts";

const SOURCE = "VentureBeat (IA)";
const FEED_URL = "https://venturebeat.com/category/ai/feed/";
const SITE_QUERY = 'site:venturebeat.com AI OR "inteligência artificial" OR "artificial intelligence"';

/**
 * Linhas reais de data/sources/venturebeat-ia.jsonl (01/10 a 05/10/2026): por
 * rodada, o RSS grava `fail` "HTTP 429" e a busca grava `ok` ou `empty`.
 */
const VENTUREBEAT_RUNS: Array<{ edition: string; ts: string; search: "ok" | "empty" }> = [
  { edition: "261002", ts: "2026-10-01T19:42:25.621Z", search: "ok" },
  { edition: "261005", ts: "2026-10-04T21:24:37.384Z", search: "empty" },
  { edition: "261005b", ts: "2026-10-04T21:39:51.740Z", search: "empty" },
  { edition: "261006", ts: "2026-10-05T20:16:45.195Z", search: "ok" },
];

/** Monta o `SourceEntry` passando cada linha por `applyRun`, como `record-source-runs.ts` faz. */
function ventureBeatEntry(runs = VENTUREBEAT_RUNS, withMethod = true): SourceEntry {
  let entry = { ...emptyEntry(), successes: 50 };
  for (const r of runs) {
    const rss: RunRecord = {
      source: SOURCE,
      edition: r.edition,
      outcome: "fail",
      reason: "HTTP 429",
      query_used: FEED_URL,
      ...(withMethod ? { method: "rss" } : {}),
    };
    const search: RunRecord = {
      source: SOURCE,
      edition: r.edition,
      outcome: r.search,
      query_used: SITE_QUERY,
      ...(withMethod ? { method: "websearch_brave" } : {}),
      articles: r.search === "ok" ? [{ title: "x", url: "https://venturebeat.com/x" }] : [],
    };
    entry = applyRun(entry, rss, r.ts);
    entry = applyRun(entry, search, r.ts);
  }
  return entry;
}

describe("#9657 — origem do caminho gravada em recent_outcomes", () => {
  it("method rss/sitemap → feed; websearch_* → search; outro método → desconhecido", () => {
    assert.equal(outcomePathFromOrigin({ method: "rss" }), "feed");
    assert.equal(outcomePathFromOrigin({ method: "sitemap" }), "feed");
    assert.equal(outcomePathFromOrigin({ method: "websearch_brave" }), "search");
    assert.equal(outcomePathFromOrigin({ method: "agent_fetch" }), undefined);
  });

  it("sem method, query_used decide: site: → search, URL → feed", () => {
    assert.equal(outcomePathFromOrigin({ query_used: SITE_QUERY }), "search");
    assert.equal(outcomePathFromOrigin({ query_used: FEED_URL }), "feed");
    assert.equal(outcomePathFromOrigin(undefined), undefined);
  });

  it("buildOutcomeEntry grava path", () => {
    const e = buildOutcomeEntry("fail", "t", "261006", "HTTP 429", { method: "rss", query_used: FEED_URL });
    assert.equal(e.path, "feed");
  });

  it("histórico sem path: falha `HTTP NNN` é do feed (formato do fetch-rss); motivo da busca não", () => {
    assert.equal(outcomePath({ outcome: "fail", reason: "HTTP 429" }), "feed");
    assert.equal(outcomePath({ outcome: "fail", reason: "HTTP 404" }), "feed");
    assert.equal(outcomePath({ outcome: "fail", reason: "rate_limited: too many" }), undefined);
    assert.equal(outcomePath({ outcome: "ok" }), undefined);
  });
});

describe("#9657 — caso real VentureBeat: RSS 429, busca ok", () => {
  it("o fixture reproduz a invisibilidade: streak de rodadas = 0 (a busca cobre)", () => {
    const entry = ventureBeatEntry();
    assert.equal(roundFailureStreak(entry.recent_outcomes).consecutive_failures, 0);
    const signals = signalsFromSourceHealth({ sources: { [SOURCE]: entry } });
    assert.ok(!signals.some((s) => s.kind === "source_streak" || s.kind === "source_dry"));
  });

  it("roundFeedFailureStreak conta as 4 rodadas com o RSS falhando, todas cobertas pela busca", () => {
    const r = roundFeedFailureStreak(ventureBeatEntry().recent_outcomes);
    assert.equal(r.consecutive_failures, 4);
    assert.equal(r.healthy_rounds, 4);
    assert.equal(r.last_reason, "HTTP 429");
  });

  it("emite source_feed_broken de severidade baixa que sugere consertar o feed, nunca desativar", () => {
    const signals = signalsFromSourceHealth({ sources: { [SOURCE]: ventureBeatEntry() } });
    assert.equal(signals.length, 1);
    const s = signals[0];
    assert.equal(s.kind, "source_feed_broken");
    assert.equal(s.severity, "low");
    assert.equal(s.details.source, SOURCE);
    assert.equal(s.details.feed_failure_rounds, 4);
    assert.equal(s.details.last_feed_reason, "HTTP 429");
    assert.match(s.suggested_action, /NÃO desativar/);
  });

  it("funciona também sem `method` (query_used decide a origem)", () => {
    const signals = signalsFromSourceHealth({ sources: { [SOURCE]: ventureBeatEntry(VENTUREBEAT_RUNS, false) } });
    assert.equal(signals[0]?.kind, "source_feed_broken");
  });

  it("abaixo do limiar de rodadas não emite", () => {
    const short = VENTUREBEAT_RUNS.slice(-(SOURCE_FEED_BROKEN_THRESHOLD_ROUNDS - 1));
    const signals = signalsFromSourceHealth({ sources: { [SOURCE]: ventureBeatEntry(short) } });
    assert.equal(signals.length, 0);
  });

  it("RSS voltando (ok ou empty) na rodada mais recente zera o streak", () => {
    for (const recovered of ["ok", "empty"] as const) {
      const entry = applyRun(
        ventureBeatEntry(),
        { source: SOURCE, edition: "261007", outcome: recovered, method: "rss", query_used: FEED_URL },
        "2026-10-06T20:00:00.000Z",
      );
      const signals = signalsFromSourceHealth({ sources: { [SOURCE]: entry } });
      assert.equal(signals.length, 0, `RSS ${recovered}`);
    }
  });

  it("rodada só com a busca (sem linha de feed) não conta nem zera", () => {
    const entry = applyRun(
      ventureBeatEntry(),
      { source: SOURCE, edition: "261007", outcome: "ok", method: "websearch_brave", query_used: SITE_QUERY },
      "2026-10-06T20:00:00.000Z",
    );
    assert.equal(roundFeedFailureStreak(entry.recent_outcomes).consecutive_failures, 4);
  });

  it("histórico antigo só com outcome+timestamp (sem reason/path) não dispara — não dá pra saber o caminho", () => {
    const recent: OutcomeLike[] = VENTUREBEAT_RUNS.flatMap((r) => [
      { outcome: "fail", timestamp: r.ts },
      { outcome: r.search, timestamp: r.ts },
    ]);
    const entry: SourceEntry = { ...emptyEntry(), successes: 50, recent_outcomes: recent as SourceEntry["recent_outcomes"] };
    assert.equal(signalsFromSourceHealth({ sources: { [SOURCE]: entry } }).length, 0);
  });

  it("fonte inteira fora do ar (RSS e busca falhando) sai como source_streak, não source_feed_broken", () => {
    let entry = { ...emptyEntry(), successes: 50 };
    for (const r of VENTUREBEAT_RUNS) {
      entry = applyRun(entry, { source: SOURCE, edition: r.edition, outcome: "fail", reason: "HTTP 429", method: "rss" }, r.ts);
      entry = applyRun(entry, { source: SOURCE, edition: r.edition, outcome: "fail", reason: "500: boom", method: "websearch_brave" }, r.ts);
    }
    const kinds = signalsFromSourceHealth({ sources: { [SOURCE]: entry } }).map((s) => s.kind);
    assert.deepEqual(kinds, ["source_streak"]);
  });

  it("queries de discovery nunca recebem o sinal (não têm feed)", () => {
    const signals = signalsFromSourceHealth({ sources: { "discovery:x": ventureBeatEntry() } }, 3, 3, undefined, new Date("2026-10-06T00:00:00Z"));
    assert.ok(!signals.some((s) => s.kind === "source_feed_broken"));
  });

  it("auto-reporter consolida o sinal por fonte entre edições", () => {
    const [s] = signalsFromSourceHealth({ sources: { [SOURCE]: ventureBeatEntry() } });
    assert.equal(dedupKey(s as Parameters<typeof dedupKey>[0]), `source_feed_broken:${SOURCE}`);
  });
});
