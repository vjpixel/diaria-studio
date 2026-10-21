/**
 * #10240: VentureBeat (IA) teve a coluna RSS esvaziada em `seed/sources.csv`
 * (PR #10222, challenge da Vercel no domínio inteiro). Desde então o Stage 1
 * não busca mais o feed — só a busca `site:` grava linha —, mas as 4 rodadas
 * antigas de `HTTP 429` seguiam em `recent_outcomes`. `roundFeedFailureStreak`
 * pula rodada sem linha de feed, então o streak CONGELAVA em 4 e
 * `source_feed_broken` reabria/comentava a issue toda edição, sem fim.
 *
 * Fix: `signalsFromSourceHealth` recebe o conjunto de fontes com RSS
 * configurado em `context/sources.md` (`loadFeedSourceNames`); fonte fora dele não emite
 * `source_feed_broken`. Fonte com RSS configurado segue sinalizando.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyRun, emptyEntry, outcomePath, type RunRecord, type SourceEntry } from "../scripts/lib/source-runs.ts";
import {
  loadFeedSourceNames,
  signalsFromSourceHealth,
  SOURCE_DRY_THRESHOLD_ROUNDS,
  SOURCE_FEED_BROKEN_THRESHOLD_ROUNDS,
  DISCOVERY_STALE_DAYS,
} from "../scripts/collect-edition-signals.ts";
import {
  describeFeedHttpFailure,
  detectAntiBotChallenge,
} from "../scripts/lib/anti-bot-challenge.ts";
import { fetchRss } from "../scripts/fetch-rss.ts";

const VB = "VentureBeat (IA)";
const OTHER = "Outra Fonte";
const FEED_URL = "https://venturebeat.com/category/ai/feed/";
const SITE_QUERY = "site:venturebeat.com AI";

/**
 * Forma real de data/sources/venturebeat-ia.jsonl: 4 rodadas com RSS 429 +
 * busca ok (até 261014), depois rodadas só com a busca (RSS removido do seed).
 */
function frozenStreakEntry(source: string): SourceEntry {
  let entry: SourceEntry = { ...emptyEntry(), successes: 60 };
  const withFeed = [
    ["261011", "2026-10-10T19:00:00.000Z"],
    ["261012", "2026-10-11T19:00:00.000Z"],
    ["261013", "2026-10-12T19:00:00.000Z"],
    ["261014", "2026-10-13T19:13:57.378Z"],
  ];
  for (const [edition, ts] of withFeed) {
    const rss: RunRecord = { source, edition, outcome: "fail", reason: "HTTP 429", query_used: FEED_URL, method: "rss" };
    const search: RunRecord = {
      source, edition, outcome: "ok", query_used: SITE_QUERY, method: "websearch_brave",
      articles: [{ title: "x", url: "https://venturebeat.com/x" }],
    };
    entry = applyRun(entry, rss, ts);
    entry = applyRun(entry, search, ts);
  }
  const searchOnly = [
    ["261015", "2026-10-14T20:44:19.012Z", "ok"],
    ["261016", "2026-10-15T18:56:51.239Z", "ok"],
    ["261019", "2026-10-18T15:53:10.004Z", "ok"],
    ["261020", "2026-10-19T17:34:54.916Z", "empty"],
    ["261021", "2026-10-20T17:44:27.298Z", "ok"],
  ] as const;
  for (const [edition, ts, outcome] of searchOnly) {
    entry = applyRun(entry, {
      source, edition, outcome, query_used: SITE_QUERY, method: "websearch_brave",
      articles: outcome === "ok" ? [{ title: "x", url: "https://venturebeat.com/y" }] : [],
    }, ts);
  }
  return entry;
}

function signals(feedSources: Set<string> | undefined, source = VB) {
  return signalsFromSourceHealth(
    { sources: { [source]: frozenStreakEntry(source) } },
    3,
    SOURCE_DRY_THRESHOLD_ROUNDS,
    undefined,
    new Date("2026-10-20T18:00:00.000Z"),
    DISCOVERY_STALE_DAYS,
    undefined,
    SOURCE_FEED_BROKEN_THRESHOLD_ROUNDS,
    feedSources,
  );
}

describe("#10240 — feed aposentado no seed não reabre source_feed_broken", () => {
  it("reproduz o bug: sem o conjunto de feeds, o streak congelado ainda sinaliza", () => {
    const s = signals(undefined);
    assert.ok(s.some((x) => x.kind === "source_feed_broken" && x.details.source === VB));
  });

  it("fonte SEM RSS configurado → nenhum source_feed_broken (nem outro sinal)", () => {
    const s = signals(new Set([OTHER]));
    assert.deepEqual(s, []);
  });

  it("fonte COM RSS configurado e falhas de feed → o sinal continua disparando", () => {
    const s = signals(new Set([OTHER]), OTHER);
    const hit = s.find((x) => x.kind === "source_feed_broken");
    assert.ok(hit, "fonte com feed configurado deve seguir sinalizando");
    assert.equal(hit.details.source, OTHER);
    assert.equal(hit.details.feed_failure_rounds, 4);
  });
});

function withSourcesMd(md: string | null, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "feed-src-10240-"));
  try {
    if (md !== null) {
      mkdirSync(join(root, "context"));
      writeFileSync(join(root, "context/sources.md"), md);
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("#10240 — loadFeedSourceNames lê o RSS de context/sources.md (o que o Stage 1 usa)", () => {
  it("só fontes com bullet `- RSS:` não-vazio entram", () => {
    const md = [
      "# Fontes",
      "## Secundária",
      `### ${VB}`,
      "- URL: https://venturebeat.com/category/ai/",
      "- Site query: `site:venturebeat.com`",
      "",
      `### ${OTHER}`,
      "- URL: https://x.example/",
      "- Site query: `site:x.example`",
      "- RSS: https://x.example/feed/",
      "",
    ].join("\n");
    withSourcesMd(md, (root) => {
      assert.deepEqual([...(loadFeedSourceNames(root) ?? [])], [OTHER]);
    });
  });

  it("CSV com RSS mas sources.md sem (sync não rodou) → segue fora: o feed nem é coletado", () => {
    // O loader ignora seed/sources.csv de propósito (review PR #10650).
    withSourcesMd(`### ${VB}
- URL: https://venturebeat.com/

### ${OTHER}
- RSS: https://x.example/feed/
`, (root) => {
      mkdirSync(join(root, "seed"));
      writeFileSync(
        join(root, "seed/sources.csv"),
        `Nome,Tipo,URL,RSS
${VB},Secundária,https://venturebeat.com/,${FEED_URL}
`,
      );
      assert.ok(!loadFeedSourceNames(root)!.has(VB));
    });
  });

  it("nenhuma fonte com RSS (formato renomeado) → undefined, não silencia todo mundo", () => {
    const md = `### ${VB}
- URL: https://venturebeat.com/
- Feed: ${FEED_URL}
`;
    withSourcesMd(md, (root) => assert.equal(loadFeedSourceNames(root), undefined));
  });

  it("sources.md ausente → undefined (comportamento anterior preservado)", () => {
    withSourcesMd(null, (root) => assert.equal(loadFeedSourceNames(root), undefined));
  });

  it("o context/sources.md real é legível e tem fontes com feed", () => {
    const names = loadFeedSourceNames(join(import.meta.dirname, ".."));
    assert.ok(names, "context/sources.md do repo deve ser legível");
    assert.ok(names.size > 0);
  });
});

describe("#10240 — outcomePath reconhece o motivo com sufixo de challenge (histórico sem path)", () => {
  it("`HTTP 429 (challenge anti-bot: vercel)` é feed; outros sufixos seguem fora", () => {
    assert.equal(outcomePath({ outcome: "fail", reason: "HTTP 429 (challenge anti-bot: vercel)" }), "feed");
    assert.equal(outcomePath({ outcome: "fail", reason: "HTTP 403 (challenge anti-bot: cloudflare)" }), "feed");
    assert.equal(outcomePath({ outcome: "fail", reason: "HTTP 429" }), "feed");
    assert.equal(outcomePath({ outcome: "fail", reason: "HTTP 403 Forbidden" }), undefined);
    assert.equal(outcomePath({ outcome: "fail", reason: "HTTP 429 (blocked)" }), undefined);
  });

  it("o motivo gerado por describeFeedHttpFailure casa com o fallback", () => {
    const reason = describeFeedHttpFailure({
      status: 429,
      headers: new Headers({ "x-vercel-mitigated": "challenge" }),
    });
    assert.equal(outcomePath({ outcome: "fail", reason }), "feed");
  });
});

describe("#10240 — challenge anti-bot da plataforma vira motivo explícito", () => {
  it("x-vercel-mitigated / cf-mitigated: challenge são reconhecidos", () => {
    assert.equal(detectAntiBotChallenge(new Headers({ "x-vercel-mitigated": "challenge" })), "vercel");
    assert.equal(detectAntiBotChallenge(new Headers({ "cf-mitigated": "challenge" })), "cloudflare");
    assert.equal(detectAntiBotChallenge(new Headers({ "x-vercel-mitigated": "deny" })), null);
    assert.equal(detectAntiBotChallenge(new Headers()), null);
    assert.equal(detectAntiBotChallenge(undefined), null);
  });

  it("sem challenge o motivo fica no formato histórico `HTTP NNN`", () => {
    assert.equal(describeFeedHttpFailure({ status: 404, headers: new Headers() }), "HTTP 404");
    assert.equal(describeFeedHttpFailure({ status: 500 }), "HTTP 500");
  });

  it("fetchRss anota o challenge da Vercel no erro", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("checkpoint", {
        status: 429,
        headers: { "x-vercel-mitigated": "challenge", server: "Vercel" },
      })) as typeof globalThis.fetch;
    try {
      const r = await fetchRss({ url: FEED_URL, sourceName: VB, days: 3 });
      assert.equal(r.error, "HTTP 429 (challenge anti-bot: vercel)");
      assert.deepEqual(r.articles, []);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
