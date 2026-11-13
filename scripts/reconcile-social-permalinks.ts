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
 *     `status: "send_unknown"` (nunca `failed`, que uma retomada repostaria) com `failure_reason: "absent_from_feed: ..."` e uma
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
 * Registros extras (#13009, resíduo da PR #13016), mesmo formato `{ posts }`:
 * carrossel semanal (`data/weekly/{AAMMDD}/06-weekly-published.json`), divulgação da
 * Retrospectiva (`data/monthly/{ciclo}/_internal/divulgacao-social-d*-published.json`)
 * e posts da anual. `--file` aponta um ou mais à mão; `--extra-stores` acha os
 * que têm post pendente agendado nos últimos `--extra-window-days` dias
 * (default 4, `lib/social-reconcile-targets.ts`). Sem `03-social.md`, casam só
 * por horário, e um item do feed já gravado como link de outro post (em
 * qualquer arquivo da rodada) nunca casa de novo.
 *
 * Uso:
 *   npx tsx scripts/reconcile-social-permalinks.ts --edition-dir data/editions/2611/261111/ \
 *     [--lookback-days N] [--file a.json,b.json] [--extra-stores [--extra-window-days N]] \
 *     [--dry-run] [--json] [--grace-hours N]
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
  claimedFeedKeys,
  earliestPendingSchedule,
  formatAbsentAlarm,
  needsFeedReconcile,
  reconcilePostsAgainstFeeds,
  type FeedPlatform,
  type FeedRead,
  type FeedReconcileSummary,
} from "./lib/social-feed-reconcile.ts";
import { fetchInstagramFeed, fetchLinkedInPageFeed, fetchThreadsFeed } from "./lib/social-feed-fetch.ts";
import { discoverExtraSocialStores, lookbackEditions } from "./lib/social-reconcile-targets.ts";

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
 * AAMMDD da edição e das `n - 1` anteriores (movida para
 * `lib/social-reconcile-targets.ts`, #13009; reexportada por compat). O Stage 0
 * roda no dia da edição anterior, quando os posts das 15:00/19:00 dela ainda
 * não venceram; olhar para trás garante que esses posts sejam conferidos nas
 * rodadas seguintes.
 */
export { lookbackEditions };

interface RunOptions {
  dryRun: boolean;
  json: boolean;
  opts: typeof DEFAULT_FEED_RECONCILE_OPTIONS;
}

/** Um arquivo de registro a reconciliar (#13009: edição diária ou registro extra). */
export interface ReconcileTarget {
  /** Rótulo dos logs (diretório da edição ou caminho do arquivo). */
  label: string;
  path: string;
  textFor: (entry: PostEntry) => string | null;
}

/** Janela default dos registros extras no Stage 0: 4 rodadas diárias depois do horário. */
export const DEFAULT_EXTRA_WINDOW_DAYS = 4;

function editionTarget(editionDir: string): ReconcileTarget | null {
  const publishedPath = resolvePublishedPath(editionDir);
  if (!publishedPath) {
    console.log(`[reconcile-social-permalinks] nenhum 06-social-published.json em ${editionDir} — skip.`);
    return null;
  }
  const socialMdPath = join(resolve(ROOT, editionDir), "03-social.md");
  return {
    label: editionDir,
    path: publishedPath,
    textFor: makeTextResolver(existsSync(socialMdPath) ? readFileSync(socialMdPath, "utf8") : null),
  };
}

/**
 * Registro extra (semanal, divulgação mensal, anual): não há `03-social.md`,
 * então o casamento é só por horário, na janela curta e com a recusa de
 * ambiguidade de `decideFeedReconcile`.
 */
function fileTarget(path: string): ReconcileTarget {
  return { label: path, path: resolve(ROOT, path), textFor: () => null };
}

/**
 * Reconcilia um arquivo. `claimed` acumula, entre os arquivos da rodada, os
 * itens do feed já atribuídos (#13009): o post semanal casado só por horário
 * nunca herda o link do destaque diário do mesmo horário.
 */
async function reconcileTarget(target: ReconcileTarget, run: RunOptions, claimed: Set<string>): Promise<void> {
  const { label, path: publishedPath, textFor } = target;
  if (!existsSync(publishedPath)) {
    console.log(`[reconcile-social-permalinks] ${label}: arquivo ausente — skip.`);
    return;
  }
  const feeds = await readPendingFeeds(readSocialPublished(publishedPath).posts);
  for (const [platform, feed] of Object.entries(feeds)) {
    if (feed?.error) console.warn(`[reconcile-social-permalinks] ${label} ${platform}: feed não lido (${feed.error}) — canal fica sem conclusão.`);
  }

  const now = new Date();
  let r = reconcilePostsAgainstFeeds(readSocialPublished(publishedPath).posts, feeds, textFor, now, run.opts, claimed);
  let summary: FeedReconcileSummary = r.summary;
  // Sem mudança, não reescreve: o arquivo vive no `data/` sincronizado.
  if (!run.dryRun && summary.matched + summary.absent.length > 0) {
    // Reaplica sob o lock do store: um publisher concorrente não perde a escrita dele.
    rewriteSocialPosts(publishedPath, (posts) => {
      r = reconcilePostsAgainstFeeds(posts, feeds, textFor, now, run.opts, claimed);
      summary = r.summary;
      return r.posts;
    });
  }
  for (const k of claimedFeedKeys(r.posts)) claimed.add(k);

  const alarm = formatAbsentAlarm(summary);
  if (alarm) console.error(`[reconcile-social-permalinks] ${label}: ${alarm}`);
  if (run.json) {
    console.log(JSON.stringify({ file: publishedPath, dry_run: run.dryRun, ...summary }));
  } else {
    console.log(
      `[reconcile-social-permalinks] ${label}: ${summary.matched} com link do feed, ${summary.absent.length} ausente(s) do feed, ` +
        `${summary.undecided} sem conclusão${run.dryRun ? " (dry-run, nada gravado)" : ""}.`,
    );
  }
}

/** Links já gravados em todos os arquivos da rodada, antes de qualquer casamento. */
function seedClaimed(targets: ReconcileTarget[]): Set<string> {
  const out = new Set<string>();
  for (const t of targets) {
    try {
      for (const k of claimedFeedKeys(readSocialPublished(t.path).posts ?? [])) out.add(k);
    } catch {
      // arquivo ilegível: o reconcileTarget dele vai acusar; aqui só não semeia.
    }
  }
  return out;
}

const USAGE =
  "Uso: reconcile-social-permalinks.ts [--edition-dir <dir> [--lookback-days N]] [--file a.json,b.json] " +
  "[--extra-stores [--extra-window-days N]] [--dry-run] [--json] [--grace-hours N]";

async function main(): Promise<number> {
  loadProjectEnv();
  const { values, flags } = parseArgsLib(process.argv.slice(2));
  const editionDir = values["edition-dir"];
  const files = (values["file"] ?? "").split(",").map((f) => f.trim()).filter(Boolean);
  const extraStores = flags.has("extra-stores");
  if (!editionDir && files.length === 0 && !extraStores) {
    console.error(USAGE);
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

  const targets: ReconcileTarget[] = [];
  if (editionDir) {
    const lookbackRaw = Number(values["lookback-days"]);
    const lookback = Number.isInteger(lookbackRaw) && lookbackRaw > 1 ? lookbackRaw : 1;
    const aammdd = basename(editionDir.replace(/[\\/]+$/, ""));
    const dirs =
      lookback > 1 && /^\d{6}$/.test(aammdd)
        ? [editionDir, ...lookbackEditions(aammdd, lookback).slice(1).map((d) => editionDirPath(d))]
        : [editionDir];
    for (const dir of dirs) {
      const t = editionTarget(dir);
      if (t) targets.push(t);
    }
  }
  // Edições primeiro: elas têm o texto do post e casam com confiança antes
  // que um registro só-horário tente o mesmo item do feed.
  for (const f of files) targets.push(fileTarget(f));
  if (extraStores) {
    const windowRaw = Number(values["extra-window-days"]);
    const windowDays = Number.isFinite(windowRaw) && windowRaw > 0 ? windowRaw : DEFAULT_EXTRA_WINDOW_DAYS;
    const found = discoverExtraSocialStores(resolve(ROOT, "data"), needsFeedReconcile, new Date(), windowDays);
    console.log(`[reconcile-social-permalinks] registros extras com post pendente nos últimos ${windowDays} dia(s): ${found.length}.`);
    for (const f of found) if (!targets.some((t) => resolve(t.path) === resolve(f))) targets.push(fileTarget(f));
  }

  const claimed = seedClaimed(targets);
  for (const t of targets) await reconcileTarget(t, run, claimed);
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error(e) });
}
