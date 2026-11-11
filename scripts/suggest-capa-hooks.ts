/**
 * scripts/suggest-capa-hooks.ts (#12737)
 *
 * Sugere e ordena textos de capa (o "gancho") do vídeo do dia a partir do D1,
 * pela diretriz de `docs/youtube-capa-texto.md` (Passo A2 do `/diaria-publica`).
 * Miolo puro em `scripts/lib/diaria/youtube-capa-hooks.ts`.
 *
 * O agente escreve os candidatos seguindo a diretriz (um por linha num
 * arquivo, ou `--candidate` repetível); o script acrescenta sementes do D1,
 * pontua cada um, aponta o que quebra a diretriz e imprime o `--hook` pronto
 * de cada formato. O editor escolhe ANTES de a capa ser composta.
 *
 * Uso:
 *   npx tsx scripts/suggest-capa-hooks.ts {AAMMDD} [--candidates-file F] [--candidate "texto"]... [--json] [--limit 10]
 *   npx tsx scripts/suggest-capa-hooks.ts {AAMMDD} --record "Ensinaram a IA|e foram demitidos" --format horizontal|short
 *   npx tsx scripts/suggest-capa-hooks.ts --history [--json]
 *
 * `--edition-dir` substitui a pasta da edição. D1 = `## DESTAQUE 1` do
 * `02-reviewed.md`. `--record` grava o gancho escolhido em
 * `_internal/youtube-capa-hooks.json` (um por formato), para o `--history`
 * cruzar depois com as views de `data/youtube-analytics/videos.jsonl`.
 *
 * Só lê arquivos locais; nada é publicado. Exit: 0 ok; 1 sem D1 legível;
 * 2 uso inválido.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDestaques } from "./extract-destaques.ts";
import { findUnknownFlags, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor, editionsRoot } from "./lib/edition-paths.ts";
import {
  CAPA_HOOKS_RECORD_FILE,
  formatCapaSuggestions,
  joinHookHistory,
  rankCapaHooks,
  scoreCapaHook,
  seedCapaHooks,
  upsertCapaHookRecord,
  type CapaD1,
  type CapaFormat,
  type CapaHookRecord,
  type HookHistoryVideoLine,
} from "./lib/diaria/youtube-capa-hooks.ts";
import { YOUTUBE_ANALYTICS_DIR, YOUTUBE_ANALYTICS_FILES } from "./lib/diaria/youtube-analytics.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KNOWN_FLAGS = ["edition-dir", "candidates-file", "candidate", "json", "limit", "record", "format", "history", "help"] as const;
const VALUE_FLAGS = new Set(["edition-dir", "candidates-file", "candidate", "limit", "record", "format"]);

interface Args {
  positional: string[];
  values: Record<string, string>;
  candidates: string[];
  flags: Set<string>;
}

/** Parser próprio: `--candidate` é repetível e o valor pode conter `|` (quebra de linha do gancho). */
export function parseSuggestArgs(argv: string[]): Args {
  const out: Args = { positional: [], values: {}, candidates: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out.positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (VALUE_FLAGS.has(key)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new Error(`--${key} precisa de valor`);
      if (key === "candidate") out.candidates.push(v);
      else out.values[key] = v;
    } else {
      out.flags.add(key);
    }
  }
  return out;
}

export function readD1FromReviewed(reviewedPath: string): CapaD1 | null {
  const d1 = parseDestaques(readFileSync(reviewedPath, "utf8")).find((d) => d.n === 1);
  return d1 ? { title: d1.title, body: d1.body } : null;
}

/** Candidatos do arquivo: um por linha; linha vazia e linha começando com `#` são ignoradas. */
export function parseCandidatesFile(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function readJsonl(path: string): HookHistoryVideoLine[] {
  if (!existsSync(path)) return [];
  const out: HookHistoryVideoLine[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HookHistoryVideoLine);
    } catch {
      // linha corrompida (cópia do OneDrive no meio da escrita) não derruba o histórico
    }
  }
  return out;
}

function collectRecords(): CapaHookRecord[] {
  const root = resolve(ROOT, editionsRoot());
  if (!existsSync(root)) return [];
  const out: CapaHookRecord[] = [];
  for (const month of readdirSync(root)) {
    if (!/^\d{4}$/.test(month)) continue;
    for (const ed of readdirSync(join(root, month))) {
      const p = join(root, month, ed, CAPA_HOOKS_RECORD_FILE);
      if (!existsSync(p)) continue;
      try {
        out.push(JSON.parse(readFileSync(p, "utf8")) as CapaHookRecord);
      } catch (err) {
        console.error(`[aviso] ${p} ilegível: ${(err as Error).message}`);
      }
    }
  }
  return out;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let args: Args;
  try {
    args = parseSuggestArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const unknown = findUnknownFlags(argv.filter((a) => a.startsWith("--")), KNOWN_FLAGS);
  if (unknown.length > 0) {
    console.error(`flag(s) desconhecida(s): ${unknown.join(", ")}`);
    return 2;
  }
  if (args.flags.has("help")) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    return 0;
  }

  if (args.flags.has("history")) {
    const videos = readJsonl(join(ROOT, "data", YOUTUBE_ANALYTICS_DIR, YOUTUBE_ANALYTICS_FILES.videos));
    const rows = joinHookHistory(collectRecords(), videos);
    if (args.flags.has("json")) console.log(JSON.stringify(rows, null, 2));
    else if (rows.length === 0) console.log("Nenhum gancho registrado ainda (use --record depois de o editor escolher).");
    else for (const r of rows) console.log(`${r.edition} ${r.format.padEnd(10)} ${String(r.views ?? "—").padStart(5)}  "${r.hook}"`);
    return 0;
  }

  const aammdd = args.positional[0];
  if (!args.values["edition-dir"] && !/^\d{6}$/.test(aammdd ?? "")) {
    console.error("uso: suggest-capa-hooks.ts {AAMMDD} [--candidates-file F] [--candidate \"texto\"]... | --record \"gancho\" --format horizontal|short | --history");
    return 2;
  }
  const dir = resolve(args.values["edition-dir"] ?? editionDirFor(aammdd));
  const reviewed = join(dir, "02-reviewed.md");
  if (!existsSync(reviewed)) {
    console.error(`sem ${reviewed}: o D1 sai do 02-reviewed.md aprovado no gate 4`);
    return 1;
  }
  const d1 = readD1FromReviewed(reviewed);
  if (!d1) {
    console.error(`DESTAQUE 1 não encontrado em ${reviewed}`);
    return 1;
  }

  if (args.values.record !== undefined) {
    const format = args.values.format as CapaFormat | undefined;
    if (format !== "horizontal" && format !== "short") {
      console.error("--record exige --format horizontal ou --format short");
      return 2;
    }
    const path = join(dir, CAPA_HOOKS_RECORD_FILE);
    let prev: CapaHookRecord | null = null;
    if (existsSync(path)) {
      try {
        prev = JSON.parse(readFileSync(path, "utf8")) as CapaHookRecord;
      } catch (err) {
        console.error(`[aviso] ${path} ilegível, recriado: ${(err as Error).message}`);
      }
    }
    const edition = aammdd && /^\d{6}$/.test(aammdd) ? aammdd : (dir.match(/(\d{6})\/?$/)?.[1] ?? "");
    const next = upsertCapaHookRecord(prev, { edition, d1Title: d1.title, format, hook: args.values.record, now: new Date() });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    console.log(JSON.stringify({ path, entries: next.entries }));
    return 0;
  }

  const agentCandidates = [...args.candidates];
  if (args.values["candidates-file"]) {
    agentCandidates.push(...parseCandidatesFile(readFileSync(resolve(args.values["candidates-file"]), "utf8")));
  }
  const scores = [
    ...agentCandidates.map((c) => scoreCapaHook(c, d1, "agente")),
    ...seedCapaHooks(d1).map((c) => scoreCapaHook(c, d1, "semente")),
  ];
  const ranked = rankCapaHooks(scores);
  if (agentCandidates.length === 0) {
    console.error("[aviso] sem candidatos do agente: só as sementes do D1. Escreva 8 a 10 pela diretriz e passe com --candidates-file.");
  }
  const limit = Number.parseInt(args.values.limit ?? "10", 10);
  if (args.flags.has("json")) console.log(JSON.stringify({ d1, suggestions: ranked.slice(0, limit) }, null, 2));
  else console.log(formatCapaSuggestions(ranked, d1, Number.isFinite(limit) && limit > 0 ? limit : 10));
  return 0;
}

if (isMainModule(import.meta.url)) void runCli(main);
