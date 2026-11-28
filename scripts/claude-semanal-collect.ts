#!/usr/bin/env node
/**
 * scripts/claude-semanal-collect.ts (#14329)
 *
 * Coleta da semana do e-mail "Claude na semana" (`/diaria-claude-semanal`,
 * Passo 1). Lê as fontes `rss` de `platform.config.json` →
 * `kit_claude_semanal.sources` (via `fetch-rss.ts`), filtra pela janela, por
 * fonte oficial e pelo dedup contra os envios anteriores deste canal, e grava
 * `data/claude-semanal/{AAMMDD}/_internal/01-candidates.json`.
 *
 * Janela: do último envio `sent` anterior, ou de envio − 14 dias, o que for
 * mais cedo, até o dia do envio (`resolveClaudeSemanalWeek`). Semana anterior
 * sem `sent` sai num banner.
 *
 * Fontes `page` (páginas sem feed: Anthropic News, release notes dos apps,
 * Academy…) não são raspadas aqui: saem em `pages_to_fetch`, a skill as lê
 * por WebFetch, data cada item e os mescla com `--merge arquivo.json` (lista
 * de `{ url, title, published_at, summary, source, section_hint? }`), que
 * passa pelos MESMOS filtros. Feed que não alcança o início da janela (ou foi
 * cortado pelo teto de itens) entra em `feed_errors` e a página de cobertura
 * dele (`coverage_page`) vai para `pages_to_fetch`. Sem raspagem frágil de
 * HTML de terceiro.
 *
 * `--merge` soma à coleta já gravada. Sem `01-candidates.json` legível, busca
 * os feeds de novo antes de mesclar: nunca grava só as páginas como se fosse
 * a coleta completa.
 *
 * Não fala com o Kit e não envia nada. A única rede é a leitura dos feeds
 * oficiais.
 *
 * Uso:
 *   npx tsx scripts/claude-semanal-collect.ts [--week AAMMDD]
 *   npx tsx scripts/claude-semanal-collect.ts --week 261129 --merge {scratchpad}/paginas-14329-{aleatório}.json
 *   npx tsx scripts/claude-semanal-collect.ts --resolve-week     (só imprime a semana default)
 *   (opcional: --data-root <dir>)
 *
 * Exit codes: 0 ok · 1 erro · 2 guard (config/semana/arquivo inválidos).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { fetchRss, type FetchResult } from "./fetch-rss.ts";
import {
  CLAUDE_SEMANAL_FEED_LOOKBACK_EXTRA_DAYS,
  ClaudeSemanalGuardError,
  claudeSemanalWindowBanner,
  defaultClaudeSemanalWeek,
  evaluateClaudeSemanalVolume,
  feedCoverageGap,
  resolveClaudeSemanalWeek,
  selectWeekCandidates,
  type CandidateSelection,
  type ClaudeSemanalCandidate,
  type ClaudeSemanalConfig,
  type ClaudeSemanalVolume,
  type RawCandidate,
} from "./lib/claude-semanal.ts";
import {
  claudeSemanalPaths,
  loadClaudeSemanalConfig,
  loadClaudeSemanalSent,
  logClaudeSemanalDedupGaps,
} from "./lib/claude-semanal-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[claude-semanal-collect]";

export interface CandidatesFile {
  week: string;
  window: { start: string; end: string; firstDay: string; lastDay: string; lastSentWeek: string | null; previousWeekSent: boolean };
  collectedAt: string;
  candidates: ClaudeSemanalCandidate[];
  pages_to_fetch: { name: string; url: string; section_hint?: string }[];
  feed_errors: { source: string; error: string }[];
  already_sent: CandidateSelection["alreadySent"];
  rejected: CandidateSelection["rejected"];
  /** Itens fora da janela só entram nesta contagem (não são listados). */
  out_of_window_count: number;
  volume: ClaudeSemanalVolume;
  banner: string | null;
}

export interface CollectDeps {
  fetchFeed: (opts: { url: string; sourceName: string; days: number; now: Date }) => Promise<FetchResult>;
  writeFile: (path: string, contents: string) => void;
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
}

const defaultDeps: CollectDeps = {
  fetchFeed: (o) => fetchRss(o),
  // 1ª coleta da semana: `data/claude-semanal/{AAMMDD}/_internal/` ainda não existe.
  writeFile: (p, c) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileAtomic(p, c);
  },
  readFile: (p) => readFileSync(p, "utf8"),
  exists: existsSync,
};

export interface CollectOptions {
  rootDir: string;
  dataRoot: string;
  week: string;
  mergePath?: string;
  log: (msg: string) => void;
  now?: () => Date;
  deps?: Partial<CollectDeps>;
  /** Injetável nos testes; default lê `platform.config.json`. */
  config?: ClaudeSemanalConfig;
}

/** Lê o `--merge`: lista de candidatos (ou `{ candidates: [...] }`). */
function readMergeFile(path: string, deps: CollectDeps): RawCandidate[] {
  if (!deps.exists(path)) throw new ClaudeSemanalGuardError(`--merge: ${path} não existe.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.readFile(path));
  } catch (e) {
    throw new ClaudeSemanalGuardError(`--merge: ${path} não é JSON válido (${(e as Error).message}).`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list)) throw new ClaudeSemanalGuardError(`--merge: ${path} não traz uma lista de candidatos.`);
  return list as RawCandidate[];
}

/** Lê a coleta anterior da semana; null se ausente ou ilegível (com aviso). */
function readPrevious(path: string, deps: CollectDeps, log: (m: string) => void): CandidatesFile | null {
  if (!deps.exists(path)) return null;
  try {
    const p = JSON.parse(deps.readFile(path)) as CandidatesFile;
    if (!p || !Array.isArray(p.candidates)) throw new Error("sem lista de candidatos");
    return p;
  } catch (e) {
    log(`AVISO: ${path} ilegível (${(e as Error).message}).`);
    return null;
  }
}

export async function runClaudeSemanalCollect(options: CollectOptions): Promise<CandidatesFile> {
  const deps: CollectDeps = { ...defaultDeps, ...options.deps };
  const now = options.now ?? (() => new Date());
  const log = options.log;
  const config = options.config ?? loadClaudeSemanalConfig(options.rootDir).config;
  const dedup = loadClaudeSemanalSent(options.dataRoot, options.week);
  logClaudeSemanalDedupGaps(dedup, log);
  const week = resolveClaudeSemanalWeek(options.week, config.sendWeekday, dedup.sentWeeks);
  const banner = claudeSemanalWindowBanner(week);
  if (banner) log(`AVISO: ${banner}`);
  const paths = claudeSemanalPaths(options.dataRoot, week.week);

  const previous = readPrevious(paths.candidatesPath, deps, log);
  const raw: RawCandidate[] = [];
  let feedErrors: { source: string; error: string }[] = [];

  // Mesclados ANTES de tudo: na mesma URL vence o do merge (ex.: o release do
  // Claude Code relido com o texto completo, que o feed trunca).
  if (options.mergePath) raw.push(...readMergeFile(options.mergePath, deps));

  // A coleta anterior entra inteira (recoleta sem --merge não apaga as
  // páginas já mescladas). Num --merge sem coleta anterior legível, os feeds
  // são buscados de novo: nunca gravar só as páginas como coleta completa.
  if (previous) raw.push(...previous.candidates);
  const fetchFeeds = !options.mergePath || previous === null;
  if (options.mergePath && previous === null) {
    log("AVISO: --merge sem 01-candidates.json legível — buscando os feeds de novo antes de mesclar.");
  }

  if (fetchFeeds) {
    const days =
      Math.ceil((now().getTime() - Date.parse(week.windowStart)) / 86_400_000) + 1 + CLAUDE_SEMANAL_FEED_LOOKBACK_EXTRA_DAYS;
    for (const src of config.sources.filter((s) => s.kind === "rss")) {
      const res = await deps.fetchFeed({ url: src.url, sourceName: src.name, days, now: now() });
      if (res.error) {
        feedErrors.push({ source: src.name, error: res.error });
        log(`AVISO: feed "${src.name}" falhou (${res.error}) — a skill lê a página da fonte no lugar.`);
      } else {
        const gap = feedCoverageGap(res.articles, res.truncated_by_cap ?? 0, week.windowStart);
        if (gap) {
          feedErrors.push({ source: src.name, error: `cobertura incompleta: ${gap}` });
          log(`AVISO: feed "${src.name}": ${gap} — a skill lê ${src.coverage_page ?? src.url} para cobrir o resto.`);
        }
      }
      for (const a of res.articles) {
        raw.push({ ...a, source: src.name, ...(src.section_hint ? { section_hint: src.section_hint } : {}) });
      }
    }
  } else {
    // --merge sobre coleta legível: os erros de feed gravados continuam valendo.
    feedErrors = previous?.feed_errors ?? [];
  }

  const sel = selectWeekCandidates(raw, week, dedup.sent);
  const volume = evaluateClaudeSemanalVolume(sel.candidates.length, config.minItems, config.maxItems);
  const failed = new Set(feedErrors.map((f) => f.source));

  const out: CandidatesFile = {
    week: week.week,
    window: {
      start: week.windowStart,
      end: week.windowEnd,
      firstDay: week.firstDay,
      lastDay: week.lastDay,
      lastSentWeek: week.lastSentWeek,
      previousWeekSent: week.previousWeekSent,
    },
    collectedAt: now().toISOString(),
    candidates: sel.candidates,
    // Sai do MESMO feed_errors gravado: o que falhou (ou não cobre a janela)
    // tem a página de cobertura lida pela skill.
    pages_to_fetch: config.sources
      .filter((s) => s.kind === "page" || failed.has(s.name))
      .map((s) => ({
        name: s.name,
        url: s.kind === "rss" ? (s.coverage_page ?? s.url) : s.url,
        ...(s.section_hint ? { section_hint: s.section_hint } : {}),
      })),
    feed_errors: feedErrors,
    already_sent: sel.alreadySent,
    rejected: sel.rejected,
    out_of_window_count: sel.outOfWindow.length,
    volume,
    banner,
  };
  deps.writeFile(paths.candidatesPath, JSON.stringify(out, null, 2) + "\n");
  log(
    `semana ${week.week} (janela ${week.firstDay} a ${week.lastDay}): ${sel.candidates.length} candidato(s), ` +
      `${sel.alreadySent.length} já enviado(s), ${sel.rejected.length} rejeitado(s), ${sel.outOfWindow.length} fora da janela. ` +
      `Gravado em ${paths.candidatesPath}.`,
  );
  if (volume.kind === "abaixo") log(`volume: ${volume.instrucao}`);
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
  try {
    const { config } = loadClaudeSemanalConfig(ROOT);
    const explicit = getStringArg(argv, "week");
    const week = explicit ?? defaultClaudeSemanalWeek(new Date(), config.sendWeekday);
    if (hasFlag(argv, "resolve-week")) {
      console.log(JSON.stringify({ week, assumed: !explicit }));
      return;
    }
    if (!explicit) log(`Data não informada — assumindo ${week} (próximo dia de envio). Passe --week AAMMDD para outra semana.`);
    const res = await runClaudeSemanalCollect({
      rootDir: ROOT,
      dataRoot: resolve(getStringArg(argv, "data-root") ?? ROOT),
      week,
      mergePath: getStringArg(argv, "merge") ?? undefined,
      log,
      config,
    });
    console.log(
      JSON.stringify({
        week: res.week,
        window: res.window,
        banner: res.banner,
        candidates: res.candidates.length,
        volume: res.volume,
        feed_errors: res.feed_errors,
        pages_to_fetch: res.pages_to_fetch,
      }),
    );
  } catch (e) {
    log((e as Error).message);
    process.exit(e instanceof ClaudeSemanalGuardError ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
