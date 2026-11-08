/**
 * archive-kv-public-images.ts (#11412, fatia 3: arquivo durável)
 *
 * Copia para o R2 as imagens públicas que só existem no KV `POLL` (keys
 * `img-*`: e-mails antigos, cards e PDF do carrossel semanal, Retrospectiva),
 * em `img/{AAMMDD}/…` ou `img/kv/{key}`, e confere cada cópia (tamanho + ETag
 * MD5). Nunca escreve nem remove nada no KV (o adaptador só tem leitura); as
 * chaves do jogo são descartadas antes de qualquer leitura de valor. Lógica
 * em `scripts/lib/public-images-archive.ts`.
 *
 *   npx tsx scripts/archive-kv-public-images.ts                 # dry-run (padrão), só leitura
 *   npx tsx scripts/archive-kv-public-images.ts --measure       # dry-run baixando do KV para somar os bytes
 *   npx tsx scripts/archive-kv-public-images.ts --apply [--max-mb 1024] [--limit N] [--verify]
 *
 * Opções: `--out arquivo.json` grava o relatório completo (uma linha por key).
 * `--verify` baixa e compara também as keys com hash já presentes no R2.
 * `--apply` também grava os dois objetos-canário (`img/kv/img-kv-archive-canary.txt`
 * e `img/260101/kv-archive-canary.txt`), que a poda (`prune-kv-public-images.ts`)
 * exige ver servidos do R2 pelos Workers. Idempotente: rodar de novo só copia
 * o que faltou ou mudou. O dry-run lê o KV e faz HEAD no R2; nada mais.
 *
 * Env: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_WORKERS_TOKEN` (KV) e as `R2_*`
 * (ou `SHORTS_R2_*`) do upload da fatia 1. Sai 1 se alguma key deu erro, se
 * algum objeto não cabe no teto da rodada (`too-large`) ou se o canário falhou.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadR2UploadConfig } from "./lib/r2-object-upload.ts";
import {
  DEFAULT_ARCHIVE_MAX_BYTES,
  archiveKvImages,
  makeCloudflareKvReader,
  makeR2ArchiveStore,
  type ArchiveReport,
} from "./lib/public-images-archive.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ArchiveCliArgs {
  apply: boolean;
  measure: boolean;
  verify: boolean;
  maxBytes: number;
  limit?: number;
  out?: string;
}

function positiveNumber(flag: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) throw new Error(`archive-kv-public-images: ${flag} precisa de número positivo (veio "${raw ?? ""}")`);
  return n;
}

export function parseArchiveArgs(argv: readonly string[]): ArchiveCliArgs {
  const args: ArchiveCliArgs = { apply: false, measure: false, verify: false, maxBytes: DEFAULT_ARCHIVE_MAX_BYTES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--measure") args.measure = true;
    else if (a === "--verify") args.verify = true;
    else if (a === "--max-mb") args.maxBytes = Math.floor(positiveNumber(a, argv[++i]) * 1024 * 1024);
    else if (a === "--limit") args.limit = Math.floor(positiveNumber(a, argv[++i]));
    else if (a === "--out") args.out = argv[++i];
    else throw new Error(`archive-kv-public-images: argumento desconhecido "${a}"`);
  }
  return args;
}

/** Resumo para o terminal: totais + as keys que não estão `already`. */
export function summarizeArchiveReport(report: ArchiveReport): Record<string, unknown> {
  const pending = report.entries.filter((e) => e.outcome !== "already");
  return {
    mode: report.mode,
    listed: report.listed,
    totals: report.totals,
    bytes_copied: report.bytesCopied,
    bytes_planned: report.bytesPlanned,
    canary: report.canary,
    canary_error: report.canaryError,
    not_already: pending.slice(0, 50),
    not_already_truncated: pending.length > 50 ? pending.length - 50 : 0,
  };
}

/** 1 se alguma key deu erro, se algum objeto nunca caberia numa rodada ou se o canário falhou. */
export function archiveExitCode(report: ArchiveReport): number {
  if ((report.totals.error ?? 0) > 0) return 1;
  if ((report.totals["too-large"] ?? 0) > 0) return 1;
  return report.canary === "error" ? 1 : 0;
}

async function main(): Promise<number> {
  const args = parseArchiveArgs(process.argv.slice(2));
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const kvNamespaceId: string | undefined = cfg?.poll?.kv_namespace_id;
  if (!kvNamespaceId) throw new Error("platform.config.json → poll.kv_namespace_id não configurado");
  const r2 = loadR2UploadConfig(process.env);
  if (!r2.ready) {
    console.error(`archive-kv-public-images: env do R2 incompleto (${r2.missing.join(", ")})`);
    return 1;
  }
  const report = await archiveKvImages(
    makeCloudflareKvReader({ kvNamespaceId }),
    makeR2ArchiveStore({ fetch: (u, i) => fetch(u, i), now: () => new Date() }, r2.config),
    { apply: args.apply, measure: args.measure, verify: args.verify, maxBytes: args.maxBytes, limit: args.limit },
  );
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(summarizeArchiveReport(report), null, 2));
  return archiveExitCode(report);
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("archive-kv-public-images:", e) });
}
