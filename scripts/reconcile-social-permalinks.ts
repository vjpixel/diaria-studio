/**
 * reconcile-social-permalinks.ts (#13009, #13008)
 *
 * Reconciliação pós-disparo dos posts de Instagram, Threads e LinkedIn da
 * edição contra o FEED da própria conta (APIs oficiais, só leitura). Roda no
 * check 0k do Stage 0 (`stage-0-run.ts`), logo depois do
 * `verify-social-worker-dispatch.ts`, sobre a edição anterior (D+1).
 *
 * Para cada entrada sem link (`scheduled` vencido, ou `published` sem `url`):
 *   - achou no feed → grava `url` (permalink), `published_at` real e
 *     `status: "published"`;
 *   - horário passou há mais de 6h, feed cobre a janela e nada corresponde →
 *     `status: "failed"` com `failure_reason: "absent_from_feed: ..."` e uma
 *     linha `ALARME (#13008)` no stderr. O check 0l (`check-prev-social-status.ts`)
 *     passa a listar o post na nota do Stage 0.
 *
 * Regras de casamento e de ausência: `scripts/lib/social-feed-reconcile.ts`.
 * Leitura dos feeds: `scripts/lib/social-feed-fetch.ts`. O texto do post vem
 * de `03-social.md` da edição (`# Social` para IG/LinkedIn, `# Curto` para
 * Threads); sem ele, o casamento é só por horário numa janela curta.
 *
 * Fail-soft: credencial ausente ou API fora do ar deixa o canal sem conclusão
 * (nunca "ausente") e o script sai 0. Nunca publica nada.
 *
 * Uso:
 *   npx tsx scripts/reconcile-social-permalinks.ts --edition-dir data/editions/2611/261111/ \
 *     [--lookback-days N] [--dry-run] [--json] [--grace-hours N]
 *
 * `--lookback-days 3` confere também as 2 edições anteriores (o Stage 0 usa 3:
 * os posts das 15:00/19:00 da edição anterior ainda não venceram quando ele roda).
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectEnv } from "./lib/env-loader.ts";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { readSocialPublished, rewriteSocialPosts, type PostEntry } from "./lib/social-published-store.ts";
import { extractDestaqueBlock, extractSection } from "./lib/extract-section.ts";
import { editionDir as editionDirPath } from "./lib/edition-paths.ts";
import {
  DEFAULT_FEED_RECONCILE_OPTIONS,
  FEED_RECONCILABLE_PLATFORMS,
  earliestPendingSchedule,
  formatAbsentAlarm,
  reconcilePostsAgainstFeeds,
  type FeedPlatform,
  type FeedRead,
  type FeedReconcileSummary,
} from "./lib/social-feed-reconcile.ts";
import { fetchInstagramFeed, fetchLinkedInPageFeed, fetchThreadsFeed } from "./lib/social-feed-fetch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Mesmo fallback `_internal/` > raiz de `verify-social-worker-dispatch.ts`. */
function resolvePublishedPath(editionDir: string): string | null {
  const internal = resolve(ROOT, editionDir, "_internal", "06-social-published.json");
  if (existsSync(internal)) return internal;
  const legacy = resolve(ROOT, editionDir, "06-social-published.json");
  return existsSync(legacy) ? legacy : null;
}

/** Texto do post a partir de `03-social.md`: `# Curto` no Threads, `# Social` no resto. @pure */
export function makeTextResolver(socialMd: string | null): (entry: PostEntry) => string | null {
  if (!socialMd) return () => null;
  const social = extractSection(socialMd, "Social");
  const curto = extractSection(socialMd, "Curto");
  return (entry) => {
    const section = entry.platform === "threads" ? curto : social;
    if (!section || !entry.destaque) return null;
    return extractDestaqueBlock(section, entry.destaque)?.trim() || null;
  };
}

export type FeedFetchers = Record<FeedPlatform, (sinceIso: string) => Promise<FeedRead>>;

const DEFAULT_FETCHERS: FeedFetchers = {
  instagram: (since) => fetchInstagramFeed(since),
  threads: (since) => fetchThreadsFeed(since),
  linkedin: (since) => fetchLinkedInPageFeed(since),
};

/** Lê só os feeds dos canais com entrada pendente, desde 1h antes da mais antiga. */
export async function readPendingFeeds(
  posts: PostEntry[],
  fetchers: FeedFetchers = DEFAULT_FETCHERS,
): Promise<Partial<Record<FeedPlatform, FeedRead>>> {
  const out: Partial<Record<FeedPlatform, FeedRead>> = {};
  await Promise.all(
    FEED_RECONCILABLE_PLATFORMS.map(async (platform) => {
      const earliest = earliestPendingSchedule(posts, platform);
      if (!earliest) return;
      const since = new Date(Date.parse(earliest) - 3_600_000).toISOString();
      try {
        out[platform] = await fetchers[platform](since);
      } catch (e) {
        out[platform] = { items: [], coveredSince: null, error: (e as Error).message };
      }
    }),
  );
  return out;
}

/**
 * AAMMDD da edição e das `n - 1` anteriores, do mais recente ao mais antigo.
 * O Stage 0 roda no dia da edição anterior, quando os posts das 15:00/19:00
 * dela ainda não venceram; olhar para trás garante que esses posts sejam
 * conferidos nas rodadas seguintes. @pure
 */
export function lookbackEditions(aammdd: string, n: number): string[] {
  if (!/^\d{6}$/.test(aammdd)) return [];
  const base = Date.UTC(2000 + Number(aammdd.slice(0, 2)), Number(aammdd.slice(2, 4)) - 1, Number(aammdd.slice(4, 6)));
  const out: string[] = [];
  for (let i = 0; i < Math.max(1, n); i++) {
    const d = new Date(base - i * 86_400_000);
    out.push(`${String(d.getUTCFullYear() % 100).padStart(2, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`);
  }
  return out;
}

interface RunOptions {
  dryRun: boolean;
  json: boolean;
  opts: typeof DEFAULT_FEED_RECONCILE_OPTIONS;
}

async function reconcileEdition(editionDir: string, run: RunOptions): Promise<void> {
  const publishedPath = resolvePublishedPath(editionDir);
  if (!publishedPath) {
    console.log(`[reconcile-social-permalinks] nenhum 06-social-published.json em ${editionDir} — skip.`);
    return;
  }
  const socialMdPath = join(resolve(ROOT, editionDir), "03-social.md");
  const textFor = makeTextResolver(existsSync(socialMdPath) ? readFileSync(socialMdPath, "utf8") : null);

  const feeds = await readPendingFeeds(readSocialPublished(publishedPath).posts);
  for (const [platform, feed] of Object.entries(feeds)) {
    if (feed?.error) console.warn(`[reconcile-social-permalinks] ${editionDir} ${platform}: feed não lido (${feed.error}) — canal fica sem conclusão.`);
  }

  const now = new Date();
  let summary: FeedReconcileSummary = { matched: 0, absent: [], undecided: 0 };
  summary = reconcilePostsAgainstFeeds(readSocialPublished(publishedPath).posts, feeds, textFor, now, run.opts).summary;
  // Sem mudança, não reescreve: o arquivo vive no `data/` sincronizado.
  if (!run.dryRun && summary.matched + summary.absent.length > 0) {
    // Reaplica sob o lock do store: um publisher concorrente não perde a escrita dele.
    rewriteSocialPosts(publishedPath, (posts) => {
      const r = reconcilePostsAgainstFeeds(posts, feeds, textFor, now, run.opts);
      summary = r.summary;
      return r.posts;
    });
  }

  const alarm = formatAbsentAlarm(summary);
  if (alarm) console.error(`[reconcile-social-permalinks] ${editionDir}: ${alarm}`);
  if (run.json) {
    console.log(JSON.stringify({ file: publishedPath, dry_run: run.dryRun, ...summary }));
  } else {
    console.log(
      `[reconcile-social-permalinks] ${editionDir}: ${summary.matched} com link do feed, ${summary.absent.length} ausente(s) do feed, ` +
        `${summary.undecided} sem conclusão${run.dryRun ? " (dry-run, nada gravado)" : ""}.`,
    );
  }
}

async function main(): Promise<number> {
  loadProjectEnv();
  const { values, flags } = parseArgsLib(process.argv.slice(2));
  const editionDir = values["edition-dir"];
  if (!editionDir) {
    console.error(
      "Uso: reconcile-social-permalinks.ts --edition-dir <dir> [--lookback-days N] [--dry-run] [--json] [--grace-hours N]",
    );
    return 2;
  }
  const graceRaw = Number(values["grace-hours"]);
  const run: RunOptions = {
    dryRun: flags.has("dry-run"),
    json: flags.has("json"),
    opts: {
      ...DEFAULT_FEED_RECONCILE_OPTIONS,
      ...(Number.isFinite(graceRaw) && graceRaw > 0 ? { graceHours: graceRaw } : {}),
    },
  };
  const lookbackRaw = Number(values["lookback-days"]);
  const lookback = Number.isInteger(lookbackRaw) && lookbackRaw > 1 ? lookbackRaw : 1;
  const aammdd = basename(editionDir.replace(/[\\/]+$/, ""));
  const dirs =
    lookback > 1 && /^\d{6}$/.test(aammdd)
      ? [editionDir, ...lookbackEditions(aammdd, lookback).slice(1).map((d) => editionDirPath(d))]
      : [editionDir];
  for (const dir of dirs) await reconcileEdition(dir, run);
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error(e) });
}
