#!/usr/bin/env node
/**
 * scripts/weekly-feed-post-review.ts (#12794)
 *
 * Guard do post de feed do `/diaria-linkedin-semanal` (Passo 8d → Passo 9).
 * Lógica em `scripts/lib/weekly-feed-post-review.ts`.
 *
 * --mark: grava `data/weekly/{cycle}/_internal/ln-feed-post-review.json` com
 *   o hash do texto atual de `_internal/ln-feed-post.txt`. Rodar DEPOIS do
 *   humanizador e da Clarice (sugestões filtradas por `clarice-filter.ts`)
 *   terem sido aplicados e o resultado gravado no arquivo. Não roda nenhuma
 *   das duas passadas: só registra e confere.
 * --check: confere o texto contra o marcador e, se passar, imprime o texto
 *   no stdout. É esse texto, e só ele, que vai pro editor no Passo 9.
 *
 * Uso:
 *   npx tsx scripts/weekly-feed-post-review.ts --cycle 26w45 --mark --humanizador --clarice-filtered S-filtrado.json [--allow-unapplied "motivo"]
 *   npx tsx scripts/weekly-feed-post-review.ts --cycle 26w45 --check
 *
 * Exit: 0 ok · 1 argumento inválido · 2 guard recusou (texto sem revisão,
 * revisão velha, travessão, sugestão da Clarice não aplicada).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { parseClariceSuggestions, type ClariceSuggestion } from "./lib/schemas/clarice-suggestions.ts";
import { isValidWeeklyCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import {
  buildFeedPostReviewMarker,
  checkFeedPostReview,
  feedPostPath,
  feedPostReviewPath,
} from "./lib/weekly-feed-post-review.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[weekly-feed-post-review]";

export class FeedPostGuardError extends Error {}

export interface RunOptions {
  cycleDir: string;
  mode: "mark" | "check";
  humanizador: boolean;
  clariceFilteredPath?: string;
  allowUnapplied?: string;
  now: Date;
  log: (msg: string) => void;
}

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function readMarker(path: string): unknown {
  const raw = readOptional(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { invalido: raw.slice(0, 80) };
  }
}

/** Executa o modo pedido. Devolve o texto conferido (check) ou gravado (mark). */
export function runFeedPostReview(options: RunOptions): string {
  const { cycleDir, mode, now, log } = options;
  const textPath = feedPostPath(cycleDir);
  const markerPath = feedPostReviewPath(cycleDir);
  const text = readOptional(textPath);

  if (mode === "check") {
    const r = checkFeedPostReview(text, readMarker(markerPath));
    if (!r.ok) throw new FeedPostGuardError(r.reason);
    log(`post de feed revisado em ${r.marker.em} (hash confere, ${r.marker.clarice_sugestoes} sugestão(ões) da Clarice).`);
    return text as string;
  }

  if (text === null) throw new FeedPostGuardError(`${textPath} ausente — grave o texto final do post antes de marcar.`);
  let clariceFiltered: ClariceSuggestion[] | null = null;
  if (options.clariceFilteredPath) {
    if (!existsSync(options.clariceFilteredPath)) {
      throw new FeedPostGuardError(`--clarice-filtered ${options.clariceFilteredPath} não existe.`);
    }
    try {
      clariceFiltered = parseClariceSuggestions(JSON.parse(readFileSync(options.clariceFilteredPath, "utf8")));
    } catch (e) {
      throw new FeedPostGuardError(
        `--clarice-filtered não é um array de sugestões {from,to} válido: ${(e as Error).message.split("\n")[0]}`,
      );
    }
  }
  const built = buildFeedPostReviewMarker({
    text,
    humanizador: options.humanizador,
    clariceFiltered,
    allowUnapplied: options.allowUnapplied,
    now,
  });
  if (!built.ok) throw new FeedPostGuardError(built.reason);
  writeFileAtomic(markerPath, JSON.stringify(built.marker, null, 2) + "\n");
  log(`marcador gravado (em ${built.marker.em}, hash ${built.marker.hash.slice(0, 12)}…).`);
  return text;
}

function main(): void {
  const argv = process.argv.slice(2);
  let cycle: string | undefined;
  try {
    cycle = getStringArg(argv, "cycle", { example: "26w45" });
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} ${(e as Error).message}\n`);
    process.exit(1);
  }
  const mark = hasFlag(argv, "mark");
  const check = hasFlag(argv, "check");
  if (!cycle || !isValidWeeklyCycle(cycle) || mark === check) {
    process.stderr.write(
      "Uso: npx tsx scripts/weekly-feed-post-review.ts --cycle {YY}w{WW} " +
        "(--mark --humanizador --clarice-filtered F [--allow-unapplied MOTIVO] | --check)\n",
    );
    process.exit(1);
  }
  try {
    const text = runFeedPostReview({
      cycleDir: resolve(ROOT, weeklyLinkedinRelDir(cycle)),
      mode: mark ? "mark" : "check",
      humanizador: hasFlag(argv, "humanizador"),
      clariceFilteredPath: getStringArg(argv, "clarice-filtered") || undefined,
      allowUnapplied: getStringArg(argv, "allow-unapplied") || undefined,
      now: new Date(),
      log: (msg) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`),
    });
    if (check) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} ${(e as Error).message}\n`);
    process.exit(e instanceof FeedPostGuardError ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
