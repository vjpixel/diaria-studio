#!/usr/bin/env tsx
/**
 * refresh-destaque-sources.ts (#9102)
 *
 * Re-sincroniza `_internal/fact-check-sources/` (manifest.json + d{N}.txt)
 * com os destaques ATUAIS de `_internal/01-approved.json`, depois de uma
 * troca/promoção de destaque no gate 4 (§4d.1b do orchestrator-stage-4,
 * `promote-to-destaque.ts`).
 *
 * Problema que resolve (edição 260930): ao promover itens do pool a destaque
 * SUBSTITUINDO um existente, nada re-baixava a fonte do artigo novo. Dois
 * efeitos:
 *   1. o `writer-destaque` (só Read/Write, sem WebFetch por design — #4000)
 *      escrevia o destaque novo só com título + summary;
 *   2. o `fact-checker`, redespachado direto (sem passar de novo por
 *      `run-fact-checker.ts`, que é quem invalida o cache — #8782), lia um
 *      `manifest.json`/`d{N}.txt` com o texto do destaque ANTIGO.
 *
 * Mecanismo: reusa `prefetchHighlightSources` (#8595/#8782) — mesma função
 * que o `run-fact-checker.ts` usa. Ela compara as URLs do manifest com as de
 * `highlights[]` por posição; se QUALQUER uma divergir, apaga manifest +
 * d{N}.txt e re-baixa tudo (nunca mistura texto velho com novo). Se tudo
 * bate, reusa o cache sem tocar a rede.
 *
 * Saída (stdout, JSON): `{ stale_before, refetched, sources: [{destaque, url,
 * path?, error?}] }`. Passar `sources[N-1].path` como `source_text_path` ao
 * `writer-destaque` do slot promovido.
 *
 * Uso:
 *   npx tsx scripts/refresh-destaque-sources.ts --edition-dir data/editions/2609/260930/
 *   npx tsx scripts/refresh-destaque-sources.ts --edition-dir ... --check   # só diz se está defasado
 *
 * Exit codes:
 *   0 — cache em dia (após refresh, ou já estava em dia no --check)
 *   1 — erro de args / 01-approved.json ausente ou ilegível
 *   3 — --check: manifest defasado em relação aos destaques atuais
 *
 * Falha de download de um destaque NÃO muda o exit code (fail-soft, mesmo
 * contrato do run-fact-checker): vira `error` na entrada e `status` != ok no
 * manifest — o fact-checker/writer seguem o fallback documentado.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  manifestMatchesCurrentUrls,
  prefetchHighlightSources,
  readExistingManifest,
  type PrefetchedSource,
} from "./run-fact-checker.ts";

export interface RefreshResult {
  /** true se o manifest em disco NÃO correspondia aos destaques atuais. */
  stale_before: boolean;
  /** true se houve re-download (só fora do --check). */
  refetched: boolean;
  sources: PrefetchedSource[];
}

function highlightUrls(approved: unknown): Array<string | undefined> {
  const highlights =
    (approved as { highlights?: Array<{ url?: string }> } | null)?.highlights ?? [];
  return Array.from({ length: Math.min(highlights.length, 3) }, (_, i) => highlights[i]?.url);
}

/**
 * true quando `fact-check-sources/` precisa ser re-baixado: manifest ausente,
 * URL divergente em alguma posição, entrada não-ok, ou `d{N}.txt` sumido.
 * Mesmo critério de reuso de `prefetchHighlightSources`.
 */
export function isSourcesCacheStale(approved: unknown, internalDir: string): boolean {
  const dir = join(internalDir, "fact-check-sources");
  const manifest = readExistingManifest(dir);
  if (!manifestMatchesCurrentUrls(manifest, highlightUrls(approved))) return true;
  return !manifest!.every((e) => existsSync(join(dir, `d${e.destaque}.txt`)));
}

export async function refreshDestaqueSources(
  editionDir: string,
  opts: { check?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<RefreshResult> {
  const internalDir = join(editionDir, "_internal");
  const approvedPath = join(internalDir, "01-approved.json");
  if (!existsSync(approvedPath)) throw new Error(`01-approved.json não encontrado em ${approvedPath}`);
  const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as unknown;
  const stale = isSourcesCacheStale(approved, internalDir);
  if (opts.check) return { stale_before: stale, refetched: false, sources: [] };
  const sources = await prefetchHighlightSources(approved, internalDir, opts.fetchImpl ?? fetch);
  return { stale_before: stale, refetched: stale, sources };
}

async function main(): Promise<void> {
  const { values: args, flags } = parseArgs(process.argv.slice(2));
  if (!args["edition-dir"]) {
    console.error("Uso: refresh-destaque-sources.ts --edition-dir data/editions/AAMM/AAMMDD/ [--check]");
    process.exit(1);
  }
  const check = flags.has("check");
  let result: RefreshResult;
  try {
    result = await refreshDestaqueSources(resolve(process.cwd(), args["edition-dir"]), { check });
  } catch (e) {
    console.error(`refresh-destaque-sources: ${(e as Error).message}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  if (check && result.stale_before) process.exit(3);
}

if (isMainModule(import.meta.url)) void main();
