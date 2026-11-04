#!/usr/bin/env node
/**
 * scripts/monthly-video-do-mes.ts (#12081)
 *
 * "O vídeo do mês" no encerramento da mensal: mede na YouTube Data API as
 * views dos horizontais do D1 das edições do mês de conteúdo do ciclo, grava
 * o mais visto em `data/monthly/{ciclo}/_internal/video-do-mes.json` e põe a
 * linha no início do `**PARA ENCERRAR**` do `draft.md` (miolo em
 * `lib/mensal/monthly-video-do-mes.ts`).
 *
 * Uso:
 *   npx tsx scripts/monthly-video-do-mes.ts --cycle 2610-11 [--dry-run] [--monthly-dir DIR] [--editions-root DIR]
 *
 * `--dry-run`: mede e imprime, sem gravar nada.
 *
 * Fail-soft (exit 0): sem credencial do YouTube, sem vídeo no mês ou com erro
 * da API, grava `null` e o draft fica sem a linha — a mensal sai igual. Só
 * argumento inválido sai 2.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { cycleToYymm, isValidMonthlyCycle, monthlyDir } from "./lib/mensal/monthly-paths.ts";
import { insertVideoDoMesLine, type VideoDoMes } from "./lib/mensal/monthly-video-do-mes.ts";
import { resolveTopEditionVideo, type TopEditionVideo } from "./lib/top-edition-video.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface VideoDoMesRecord extends VideoDoMes {
  edition: string;
  views: number;
  measured_at: string;
}

/** Pure: registro do vídeo do mês, com o título do D1 como reserva do título. */
export function videoDoMesRecord(top: TopEditionVideo | null, d1TitleFor: (aammdd: string) => string | null, now: Date): VideoDoMesRecord | null {
  if (!top) return null;
  const title = (top.title ?? "").trim() || (d1TitleFor(top.aammdd) ?? "").trim();
  if (!title) return null;
  return { title, url: top.videoUrl, edition: top.aammdd, views: top.views, measured_at: now.toISOString() };
}

function d1TitleFromReviewed(editionDir: string): string | null {
  const p = join(editionDir, "02-reviewed.md");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/^\*\*\[([^\]]+)\]\(/m);
  return m ? m[1].trim() : null;
}

export interface RunVideoDoMesOptions {
  cycle: string;
  monthlyDir: string;
  editionsRoot: string;
  dryRun: boolean;
  env: Record<string, string | undefined>;
  topVideo?: (days: readonly string[], dirFor: (d: string) => string) => Promise<TopEditionVideo | null>;
  now?: () => Date;
  log?: (m: string) => void;
}

export async function runVideoDoMes(o: RunVideoDoMesOptions): Promise<VideoDoMesRecord | null> {
  const log = o.log ?? ((m: string) => console.log(m));
  const yymm = cycleToYymm(o.cycle);
  const dirs = enumerateEditionDirs(o.editionsRoot);
  const days = [...dirs.keys()].filter((d) => d.startsWith(yymm)).sort();
  const dirFor = (d: string) => dirs.get(d) ?? join(o.editionsRoot, d.slice(0, 4), d);
  const top = await (o.topVideo ?? ((ds, df) => resolveTopEditionVideo({ aammdds: ds, dirFor: df, env: o.env, log })))(days, dirFor);
  const record = videoDoMesRecord(top, (d) => d1TitleFromReviewed(dirFor(d)), (o.now ?? (() => new Date()))());
  log(
    record
      ? `[video-do-mes] ${o.cycle}: ${record.title} (${record.views} views, edição ${record.edition})`
      : `[video-do-mes] ${o.cycle}: sem vídeo do mês (${days.length} edições no mês ${yymm})`,
  );
  if (o.dryRun) return record;

  const internal = join(o.monthlyDir, "_internal");
  mkdirSync(internal, { recursive: true });
  writeFileSync(join(internal, "video-do-mes.json"), JSON.stringify(record, null, 2) + "\n", "utf8");

  const draftPath = join(o.monthlyDir, "draft.md");
  if (record && existsSync(draftPath)) {
    const res = insertVideoDoMesLine(readFileSync(draftPath, "utf8"), record);
    if (res.changed) {
      writeFileSync(draftPath, res.draft, "utf8");
      log(`[video-do-mes] draft.md: linha ${res.action === "inserted" ? "inserida" : "trocada"} no PARA ENCERRAR`);
    } else {
      log(`[video-do-mes] draft.md sem mudança: ${res.reason}`);
    }
  }
  return record;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cycle = getArg(argv, "cycle");
  if (!isValidMonthlyCycle(cycle)) {
    console.error("uso: monthly-video-do-mes.ts --cycle YYMM-MM [--dry-run] [--monthly-dir DIR] [--editions-root DIR]");
    process.exitCode = 2;
    return;
  }
  loadProjectEnv(ROOT);
  const monthly = getArg(argv, "monthly-dir");
  const editions = getArg(argv, "editions-root");
  await runVideoDoMes({
    cycle,
    monthlyDir: resolve(monthly || monthlyDir(cycle)),
    editionsRoot: resolve(editions || join(ROOT, "data", "editions")),
    dryRun: hasFlag(argv, "dry-run"),
    env: process.env,
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    // Fail-soft: o vídeo do mês é acessório; a mensal segue sem a linha.
    console.error(`[video-do-mes] aviso: ${(e as Error).message} — mensal sem a linha do vídeo`);
  });
}
