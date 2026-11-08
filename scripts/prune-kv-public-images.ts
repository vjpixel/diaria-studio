/**
 * prune-kv-public-images.ts (#11412, fatia 4: poda gradual do KV)
 *
 * Remove do KV `POLL` as imagens públicas (`img-*`) que já têm cópia
 * conferida no R2, para tirar do namespace do jogo o peso das imagens
 * antigas. `/img/{key}` continua servindo a key pelo fallback R2 dos Workers
 * `poll` e `site`. Lógica e salvaguardas em
 * `scripts/lib/public-images-archive.ts` (`pruneKvImages`):
 *
 *   - só keys `img-*` da allowlist do #4112 (as do jogo são descartadas
 *     antes de qualquer leitura de valor);
 *   - só com cópia no R2 que bate com os bytes do KV AGORA (tamanho + MD5),
 *     relidos de novo logo antes do DELETE;
 *   - só com data de referência derivável e mais velha que `--min-age-days`;
 *   - imagens do É IA? ficam, a menos de `--include-eia`;
 *   - antes de remover, os Workers têm que servir do R2 (`X-Image-Source: r2`)
 *     os dois objetos-canário (gravados por `archive-kv-public-images.ts --apply`);
 *   - depois de cada remoção, `/img/{key}` é pedido aos Workers; no fim da
 *     rodada, passados ≥ 70 s (cache de borda do KV), é pedido de novo e tem
 *     que vir do R2. Qualquer falha devolve a key ao KV, relê para conferir e
 *     para a rodada.
 *
 *   npx tsx scripts/prune-kv-public-images.ts                     # dry-run (padrão): leitura do KV + HEAD no R2 + GET dos canários
 *   npx tsx scripts/prune-kv-public-images.ts --apply [--limit 50] [--min-age-days 90] [--include-eia]
 *
 * `--limit N` confere no máximo N keys por rodada (`deleted ≤ N`). `--out
 * arquivo.json` grava o relatório completo. Sai 1 se o canário falhar, se a
 * rodada for interrompida ou se alguma key der erro.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { DIARIA_EIA_URL } from "./lib/canonical-urls.ts";
import { loadR2UploadConfig } from "./lib/r2-object-upload.ts";
import { PUBLIC_IMAGE_SITE_ORIGIN } from "./lib/public-images-r2.ts";
import {
  DEFAULT_PRUNE_LIMIT,
  DEFAULT_PRUNE_MIN_AGE_DAYS,
  makeCloudflareKvImageSource,
  makeR2ArchiveStore,
  makeServedFetch,
  pruneKvImages,
  type PruneReport,
} from "./lib/public-images-archive.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface PruneCliArgs {
  apply: boolean;
  limit: number;
  minAgeDays: number;
  includeEia: boolean;
  out?: string;
}

function positiveInt(flag: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) throw new Error(`prune-kv-public-images: ${flag} precisa de inteiro positivo (veio "${raw ?? ""}")`);
  return n;
}

export function parsePruneArgs(argv: readonly string[]): PruneCliArgs {
  const args: PruneCliArgs = { apply: false, limit: DEFAULT_PRUNE_LIMIT, minAgeDays: DEFAULT_PRUNE_MIN_AGE_DAYS, includeEia: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--include-eia") args.includeEia = true;
    else if (a === "--limit") args.limit = positiveInt(a, argv[++i]);
    else if (a === "--min-age-days") args.minAgeDays = positiveInt(a, argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else throw new Error(`prune-kv-public-images: argumento desconhecido "${a}"`);
  }
  return args;
}

/** Origens que servem `/img/`: o Worker `poll` (da config) e o apex `site`, sem repetir. */
export function pruneWorkerOrigins(pollWorkerUrl: string | undefined): string[] {
  const poll = (pollWorkerUrl ?? DIARIA_EIA_URL).replace(/\/+$/, "");
  return [...new Set([poll, PUBLIC_IMAGE_SITE_ORIGIN])];
}

export function pruneExitCode(report: PruneReport): number {
  if (report.aborted) return 1;
  if (!report.canary.every((c) => c.ok)) return 1;
  return (report.totals.error ?? 0) > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const args = parsePruneArgs(process.argv.slice(2));
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const kvNamespaceId: string | undefined = cfg?.poll?.kv_namespace_id;
  if (!kvNamespaceId) throw new Error("platform.config.json → poll.kv_namespace_id não configurado");
  const r2 = loadR2UploadConfig(process.env);
  if (!r2.ready) {
    console.error(`prune-kv-public-images: env do R2 incompleto (${r2.missing.join(", ")}) — sem R2 não há como conferir a cópia, nada é podado`);
    return 1;
  }
  const report = await pruneKvImages(
    makeCloudflareKvImageSource({ kvNamespaceId }),
    makeR2ArchiveStore({ fetch: (u, i) => fetch(u, i), now: () => new Date() }, r2.config),
    makeServedFetch(),
    {
      apply: args.apply,
      now: new Date(),
      workerOrigins: pruneWorkerOrigins(cfg?.poll?.worker_url),
      minAgeDays: args.minAgeDays,
      limit: args.limit,
      includeEia: args.includeEia,
    },
  );
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n", "utf8");
  const notable = report.entries.filter((e) => e.outcome !== "kept-too-recent");
  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        listed: report.listed,
        totals: report.totals,
        bytes_freed: report.bytesFreed,
        canary: report.canary,
        aborted: report.aborted,
        entries: notable.slice(0, 80),
        entries_truncated: notable.length > 80 ? notable.length - 80 : 0,
      },
      null,
      2,
    ),
  );
  return pruneExitCode(report);
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("prune-kv-public-images:", e) });
}
