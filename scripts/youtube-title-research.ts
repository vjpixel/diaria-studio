/**
 * scripts/youtube-title-research.ts (#12552)
 *
 * Pesquisa de vocabulário para o título do D1: busca no YouTube os vídeos de
 * maior audiência dos últimos 4 dias sobre a mesma história e grava
 * `_internal/youtube-title-research.json` (15 a 20 títulos com views, canal,
 * idioma, duração e os termos que mais se repetem no topo). Miolo puro em
 * `scripts/lib/diaria/youtube-title-research.ts`.
 *
 * Onde roda:
 *   - Stage 2, antes do dispatch do `writer-destaque` do D1 (o arquivo vai
 *     como `youtube_title_research_path` ao writer do D1 e ao `title-picker`);
 *   - Stage 4, §4c, com `--gate-block --refresh-if-stale`: imprime o bloco do
 *     gate e refaz a busca quando o D1 mudou desde o Stage 2 (troca/promoção
 *     no gate) ou o arquivo não existe.
 *
 * SÓ VOCABULÁRIO. Nenhum título é alterado aqui; termo de topo que a fonte não
 * sustenta continua fora do título (#4000, #9383).
 *
 * Fail-soft: sem credencial, sem cota, sem rede ou sem resultado, grava o
 * arquivo com `status` `skipped`/`error`/`no_results` + `reason`, avisa no
 * stderr e sai 0. A edição nunca para por causa deste passo.
 *
 * Só LÊ o YouTube (`search.list` 100 unidades/query, teto de 3 queries;
 * `videos.list` 1 unidade). Escopo `youtube.readonly`, que o token do canal já
 * tem. Credenciais: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
 * `YOUTUBE_REFRESH_TOKEN`, com o `.env` do repo vencendo o ambiente (#8237).
 *
 * Uso:
 *   npx tsx scripts/youtube-title-research.ts --edition-dir {EDITION_DIR}/ [--approved PATH]
 *       [--queries "q1|q2"] [--days 4] [--max 20]
 *   npx tsx scripts/youtube-title-research.ts --edition-dir {EDITION_DIR}/ --gate-block [--refresh-if-stale] [--approved PATH]
 *
 * `--approved` padrão: `_internal/01-approved-capped.json`, e
 * `_internal/01-approved.json` quando o capped não existe. D1 = `highlights[0]`.
 *
 * Stdout: modo pesquisa = JSON `{ status, reason, path, videos, top_terms }`;
 * `--gate-block` = o texto do bloco do gate. Exit: 0 sempre que os argumentos
 * são válidos (inclusive falha de API); 2 = uso inválido.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as dotenvParse } from "dotenv";
import { findUnknownFlags, isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { DIARIA_YOUTUBE_CHANNEL_ID, resolveYouTubeReadCredentials, type YouTubeReadCredentials } from "./lib/diaria/youtube-short-related.ts";
import { YOUTUBE_API_BASE, defaultYouTubeUploadDeps, refreshYouTubeAccessToken } from "./lib/diaria/youtube-upload.ts";
import {
  DEFAULT_RESEARCH_DAYS,
  DEFAULT_RESEARCH_MAX_VIDEOS,
  YOUTUBE_TITLE_RESEARCH_FILE,
  emptyResearch,
  formatGateBlock,
  researchMatchesD1,
  runTitleResearch,
  type ResearchD1,
  type ResearchFetch,
  type YouTubeTitleResearch,
} from "./lib/diaria/youtube-title-research.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KNOWN_FLAGS = ["edition-dir", "approved", "queries", "days", "max", "gate-block", "refresh-if-stale", "help"] as const;

/** D1 = `highlights[0]` do approved; título/URL do `article`, com a URL do topo de fallback. */
export function readD1FromApproved(approvedPath: string): ResearchD1 | null {
  const json = JSON.parse(readFileSync(approvedPath, "utf8")) as { highlights?: unknown };
  const h = Array.isArray(json.highlights) ? (json.highlights[0] as Record<string, unknown> | undefined) : undefined;
  if (!h) return null;
  const article = (h.article ?? {}) as Record<string, unknown>;
  const title = typeof article.title === "string" ? article.title.trim() : "";
  const url = typeof article.url === "string" ? article.url : typeof h.url === "string" ? h.url : "";
  return title && url ? { title, url } : null;
}

export function defaultApprovedPath(editionDir: string): string {
  const capped = join(editionDir, "_internal", "01-approved-capped.json");
  return existsSync(capped) ? capped : join(editionDir, "_internal", "01-approved.json");
}

export function readResearch(editionDir: string): YouTubeTitleResearch | null {
  const path = join(editionDir, YOUTUBE_TITLE_RESEARCH_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as YouTubeTitleResearch;
  } catch {
    return null;
  }
}

export interface ResearchDeps {
  fetch: ResearchFetch;
  now: () => Date;
  warn: (msg: string) => void;
  /** `null` = sem credencial (o motivo vai em `missing`). */
  credentials: { credentials: YouTubeReadCredentials | null; missing: string[] };
}

export interface ResearchOptions {
  editionDir: string;
  approvedPath: string;
  queryOverrides?: string[];
  days?: number;
  maxVideos?: number;
}

/** Pesquisa + gravação. Nunca lança por API: falha vira `status` no arquivo. */
export async function researchAndWrite(deps: ResearchDeps, opts: ResearchOptions): Promise<YouTubeTitleResearch> {
  const edition = /^\d{6}$/.test(basename(resolve(opts.editionDir))) ? basename(resolve(opts.editionDir)) : null;
  const now = deps.now();
  let research: YouTubeTitleResearch | undefined;
  let d1: ResearchD1 | null = null;
  try {
    d1 = readD1FromApproved(opts.approvedPath);
  } catch (e) {
    deps.warn(`[aviso] approved ilegível (${opts.approvedPath}): ${(e as Error).message}`);
  }
  if (!d1) {
    research = emptyResearch("skipped", `D1 sem título/URL em ${opts.approvedPath}`, { edition, d1: null, now });
  } else if (!deps.credentials.credentials) {
    research = emptyResearch("skipped", `credenciais do YouTube ausentes: ${deps.credentials.missing.join(", ")}`, { edition, d1, now });
  } else {
    let token: string | null = null;
    try {
      token = await refreshYouTubeAccessToken(
        { ...defaultYouTubeUploadDeps, fetch: deps.fetch },
        { ...deps.credentials.credentials, channelId: DIARIA_YOUTUBE_CHANNEL_ID },
      );
    } catch (e) {
      research = emptyResearch("error", `token: ${(e as Error).message}`, { edition, d1, now });
    }
    if (token) {
      research = await runTitleResearch(deps.fetch, {
        d1,
        edition,
        accessToken: token,
        apiBase: YOUTUBE_API_BASE,
        now,
        days: opts.days,
        maxVideos: opts.maxVideos,
        queryOverrides: opts.queryOverrides,
      });
    }
  }
  research ??= emptyResearch("error", "falha desconhecida", { edition, d1, now });
  for (const w of research.warnings) deps.warn(`[aviso] ${w}`);
  if (research.status !== "ok") deps.warn(`[aviso] pesquisa de títulos no YouTube: ${research.status}${research.reason ? ` — ${research.reason}` : ""}`);

  const out = join(opts.editionDir, YOUTUBE_TITLE_RESEARCH_FILE);
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(research, null, 2) + "\n");
  } catch (e) {
    deps.warn(`[aviso] não gravou ${out}: ${(e as Error).message}`);
  }
  return research;
}

function readRepoEnvFile(): Record<string, string> {
  try {
    return dotenvParse(readFileSync(join(ROOT, ".env"), "utf8"));
  } catch {
    return {};
  }
}

function positiveInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  const args = parseArgs(argv);
  const usage = "uso: youtube-title-research.ts --edition-dir DIR [--approved PATH] [--queries \"q1|q2\"] [--days N] [--max N] | --gate-block [--refresh-if-stale]";
  if (unknown.length || args.flags.has("help") || !args.values["edition-dir"]) {
    if (unknown.length) console.error(`flag(s) desconhecida(s): ${unknown.join(", ")}`);
    console.error(usage);
    return 2;
  }
  const days = positiveInt(args.values.days, DEFAULT_RESEARCH_DAYS);
  const maxVideos = positiveInt(args.values.max, DEFAULT_RESEARCH_MAX_VIDEOS);
  if (days === null || maxVideos === null) {
    console.error(`--days/--max inválido (inteiro positivo)\n${usage}`);
    return 2;
  }
  const editionDir = resolve(args.values["edition-dir"]);
  const approvedPath = args.values.approved ? resolve(args.values.approved) : defaultApprovedPath(editionDir);
  const queryOverrides = (args.values.queries ?? "").split("|").map((q) => q.trim()).filter(Boolean);

  const deps = (): ResearchDeps => {
    loadProjectEnv(ROOT);
    const creds = resolveYouTubeReadCredentials(readRepoEnvFile(), process.env);
    if (creds.overridden.length) console.error(`[premissa] ${creds.overridden.join(", ")} do .env do repo vencem o ambiente (#8237)`);
    return { fetch: defaultYouTubeUploadDeps.fetch, now: () => new Date(), warn: (m) => console.error(m), credentials: creds };
  };
  const opts: ResearchOptions = { editionDir, approvedPath, queryOverrides, days, maxVideos };

  if (args.flags.has("gate-block")) {
    let research = readResearch(editionDir);
    if (args.flags.has("refresh-if-stale")) {
      let d1: ResearchD1 | null = null;
      try {
        d1 = readD1FromApproved(approvedPath);
      } catch {
        d1 = null;
      }
      if (!research || (d1 && !researchMatchesD1(research, d1))) research = await researchAndWrite(deps(), opts);
    }
    console.log(formatGateBlock(research));
    return 0;
  }

  const research = await researchAndWrite(deps(), opts);
  console.log(
    JSON.stringify({
      status: research.status,
      reason: research.reason,
      path: join(editionDir, YOUTUBE_TITLE_RESEARCH_FILE),
      videos: research.videos.length,
      top_terms: research.top_terms,
    }),
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  void runCli(main, { onError: (e) => console.error(`erro: ${(e as Error).message}`) });
}
