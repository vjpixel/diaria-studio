#!/usr/bin/env node
/**
 * scripts/measure-top-youtube-video.ts (#12542)
 *
 * Mede, pela YouTube Data API, o horizontal mais assistido do canal desde o
 * início (todas as edições com vídeo no disco, mesmo helper da mensal e da
 * Stack: `resolveTopEditionVideo`) e grava em `data/youtube/top-video.json`.
 * O e-mail 2 do onboarding lê esse registro para resolver o placeholder
 * `{{VIDEO_MAIS_ASSISTIDO}}` (`scripts/lib/onboarding-top-video.ts`).
 *
 * Uso:
 *   npx tsx scripts/measure-top-youtube-video.ts [--dry-run] [--editions-root DIR] [--out FILE]
 *
 * Só leitura no YouTube. Fail-soft (exit 0): sem credencial, sem rede, sem
 * vídeo ou sem título, o registro existente fica intacto (o envio segue com o
 * último valor medido). Flag desconhecida, argumento solto ou flag de valor
 * sem valor sai 1 sem rodar nada (`applyCliAction`, #12503); `--help` sai 0.
 *
 * Task: `Diaria-Top-YouTube-Video-Measure` (semanal, `scripts/lib/scheduled-tasks.ts`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCliAction, getArg, hasFlag, isMainModule, type CliSpec } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { buildTopVideoRecord, TOP_VIDEO_RECORD_RELPATH, type TopVideoRecord } from "./lib/onboarding-top-video.ts";
import { resolveTopEditionVideo, type TopEditionVideo } from "./lib/top-edition-video.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface MeasureTopVideoOptions {
  editionsRoot: string;
  outPath: string;
  dryRun: boolean;
  env: Record<string, string | undefined>;
  topVideo?: (days: readonly string[], dirFor: (d: string) => string) => Promise<TopEditionVideo | null>;
  now?: () => Date;
  log?: (m: string) => void;
}

export interface MeasureTopVideoResult {
  record: TopVideoRecord | null;
  written: boolean;
}

export async function measureTopVideo(o: MeasureTopVideoOptions): Promise<MeasureTopVideoResult> {
  const log = o.log ?? ((m: string) => console.log(m));
  const dirs = enumerateEditionDirs(o.editionsRoot);
  const days = [...dirs.keys()].sort();
  const dirFor = (d: string) => dirs.get(d) ?? join(o.editionsRoot, d.slice(0, 4), d);
  const top = await (o.topVideo ?? ((ds, df) => resolveTopEditionVideo({ aammdds: ds, dirFor: df, env: o.env, log })))(days, dirFor);
  const record = buildTopVideoRecord(top, (o.now ?? (() => new Date()))());
  if (!record) {
    log(
      `[top-youtube-video] sem medição utilizável (${days.length} edições lidas) — registro existente mantido`,
    );
    return { record: null, written: false };
  }
  log(`[top-youtube-video] ${record.title} (${record.views} views, edição ${record.edition})`);
  if (o.dryRun) return { record, written: false };
  mkdirSync(dirname(o.outPath), { recursive: true });
  writeFileSync(o.outPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  return { record, written: true };
}

/** Flags aceitas; o resto sai 1 antes de qualquer I/O (#12503). */
export const CLI_SPEC: CliSpec = {
  script: "scripts/measure-top-youtube-video.ts",
  booleans: ["dry-run"],
  values: ["editions-root", "out"],
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cliExit = applyCliAction(argv, CLI_SPEC);
  if (cliExit !== null) {
    process.exitCode = cliExit;
    return;
  }
  loadProjectEnv(ROOT);
  const editions = getArg(argv, "editions-root");
  const out = getArg(argv, "out");
  await measureTopVideo({
    editionsRoot: resolve(editions || join(ROOT, "data", "editions")),
    outPath: resolve(out || join(ROOT, TOP_VIDEO_RECORD_RELPATH)),
    dryRun: hasFlag(argv, "dry-run"),
    env: process.env,
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    // Fail-soft: o registro anterior continua valendo para o onboarding.
    console.error(`[top-youtube-video] aviso: ${(e as Error).message} — registro existente mantido`);
  });
}
