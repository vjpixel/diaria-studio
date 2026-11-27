#!/usr/bin/env node
/**
 * scripts/claude-semanal-collect.ts (#14329)
 *
 * Coleta da semana do e-mail "Claude na semana" (`/diaria-claude-semanal`,
 * Passo 1). Lê as fontes `rss` de `platform.config.json` →
 * `kit_claude_semanal.sources` (via `fetch-rss.ts`), filtra pela janela da
 * semana, por fonte oficial e pelo dedup contra os envios anteriores deste
 * canal, e grava `data/claude-semanal/{AAMMDD}/_internal/01-candidates.json`.
 *
 * Fontes `page` (páginas sem feed: Anthropic News, release notes dos apps,
 * Academy…) não são raspadas aqui: saem em `pages_to_fetch`, a skill as lê
 * por WebFetch, data cada item e os mescla com `--merge arquivo.json` (lista
 * de `{ url, title, published_at, summary, source, section_hint? }`), que
 * passa pelos MESMOS filtros. Sem raspagem frágil de HTML de terceiro.
 *
 * Não fala com o Kit e não envia nada. A única rede é a leitura dos feeds
 * oficiais.
 *
 * Uso:
 *   npx tsx scripts/claude-semanal-collect.ts [--week AAMMDD]
 *   npx tsx scripts/claude-semanal-collect.ts --week 261129 --merge /tmp/paginas-14329.json
 *   npx tsx scripts/claude-semanal-collect.ts --resolve-week     (só imprime a semana default)
 *   (opcional: --data-root <dir>)
 *
 * Exit codes: 0 ok · 1 erro · 2 guard (config/semana/arquivo inválidos).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { fetchRss, type FetchResult } from "./fetch-rss.ts";
import {
  ClaudeSemanalGuardError,
  defaultClaudeSemanalWeek,
  evaluateClaudeSemanalVolume,
  resolveClaudeSemanalWeek,
  selectWeekCandidates,
  type CandidateSelection,
  type ClaudeSemanalCandidate,
  type ClaudeSemanalConfig,
  type ClaudeSemanalVolume,
  type RawCandidate,
} from "./lib/claude-semanal.ts";
import { claudeSemanalPaths, loadClaudeSemanalConfig, loadClaudeSemanalSent } from "./lib/claude-semanal-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[claude-semanal-collect]";

export interface CandidatesFile {
  week: string;
  window: { start: string; end: string; firstDay: string; lastDay: string };
  collectedAt: string;
  candidates: ClaudeSemanalCandidate[];
  pages_to_fetch: { name: string; url: string; section_hint?: string }[];
  feed_errors: { source: string; error: string }[];
  already_sent: CandidateSelection["alreadySent"];
  rejected: CandidateSelection["rejected"];
  out_of_window_count: number;
  volume: ClaudeSemanalVolume;
}

export interface CollectDeps {
  fetchFeed: (opts: { url: string; sourceName: string; days: number; now: Date }) => Promise<FetchResult>;
  writeFile: (path: string, contents: string) => void;
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
}

const defaultDeps: CollectDeps = {
  fetchFeed: (o) => fetchRss(o),
  writeFile: (p, c) => writeFileAtomic(p, c),
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

export async function runClaudeSemanalCollect(options: CollectOptions): Promise<CandidatesFile> {
  const deps: CollectDeps = { ...defaultDeps, ...options.deps };
  const now = options.now ?? (() => new Date());
  const config = options.config ?? loadClaudeSemanalConfig(options.rootDir).config;
  const week = resolveClaudeSemanalWeek(options.week, config.sendWeekday);
  const paths = claudeSemanalPaths(options.dataRoot, week.week);

  // Rodada anterior da mesma semana: o `--merge` soma ao que já foi coletado.
  let previous: CandidatesFile | null = null;
  if (deps.exists(paths.candidatesPath)) {
    try {
      previous = JSON.parse(deps.readFile(paths.candidatesPath)) as CandidatesFile;
    } catch {
      options.log(`AVISO: ${paths.candidatesPath} ilegível — recoletando do zero.`);
    }
  }

  const raw: RawCandidate[] = [];
  const feedErrors: { source: string; error: string }[] = [];
  if (options.mergePath) {
    raw.push(...(previous?.candidates ?? []), ...readMergeFile(options.mergePath, deps));
  } else {
    // Janela de 8 dias + folga: o filtro fino é o da janela.
    const days = Math.ceil((now().getTime() - Date.parse(week.windowStart)) / 86_400_000) + 1;
    for (const src of config.sources.filter((s) => s.kind === "rss")) {
      const res = await deps.fetchFeed({ url: src.url, sourceName: src.name, days: Math.max(days, 9), now: now() });
      if (res.error) {
        feedErrors.push({ source: src.name, error: res.error });
        options.log(`AVISO: feed "${src.name}" falhou (${res.error}) — a skill lê a página da fonte no lugar.`);
      }
      for (const a of res.articles) {
        raw.push({ ...a, source: src.name, ...(src.section_hint ? { section_hint: src.section_hint } : {}) });
      }
    }
  }

  const { sent, unreadable } = loadClaudeSemanalSent(options.dataRoot, week.week);
  if (unreadable.length > 0) options.log(`AVISO: registro de envio ilegível nas semanas ${unreadable.join(", ")} — o dedup não os considera.`);
  const sel = selectWeekCandidates(raw, week, sent);
  const volume = evaluateClaudeSemanalVolume(sel.candidates.length, config.minItems, config.maxItems);

  const out: CandidatesFile = {
    week: week.week,
    window: { start: week.windowStart, end: week.windowEnd, firstDay: week.firstDay, lastDay: week.lastDay },
    collectedAt: now().toISOString(),
    candidates: sel.candidates,
    pages_to_fetch: config.sources
      .filter((s) => s.kind === "page" || feedErrors.some((f) => f.source === s.name))
      .map((s) => ({ name: s.name, url: s.url, ...(s.section_hint ? { section_hint: s.section_hint } : {}) })),
    feed_errors: options.mergePath ? (previous?.feed_errors ?? []) : feedErrors,
    already_sent: sel.alreadySent,
    rejected: sel.rejected,
    out_of_window_count: sel.outOfWindow.length,
    volume,
  };
  deps.writeFile(paths.candidatesPath, JSON.stringify(out, null, 2) + "\n");
  options.log(
    `semana ${week.week} (${week.firstDay} a ${week.lastDay}): ${sel.candidates.length} candidato(s), ` +
      `${sel.alreadySent.length} já enviado(s), ${sel.rejected.length} rejeitado(s), ${sel.outOfWindow.length} fora da janela. ` +
      `Gravado em ${paths.candidatesPath}.`,
  );
  if (volume.kind === "abaixo") options.log(`volume: ${volume.instrucao}`);
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
    console.log(JSON.stringify({ week: res.week, candidates: res.candidates.length, volume: res.volume, pages_to_fetch: res.pages_to_fetch }));
  } catch (e) {
    log((e as Error).message);
    process.exit(e instanceof ClaudeSemanalGuardError ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
