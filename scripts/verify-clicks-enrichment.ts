#!/usr/bin/env node
/**
 * scripts/verify-clicks-enrichment.ts (#4732)
 *
 * Validador determinístico pós-`beehiiv-clicks-enricher` (Stage 0h.2) — regra
 * #573 do CLAUDE.md ("Validar afirmações de subagent sobre estado externo via
 * TS determinístico antes de relayar pro editor") aplicada a este agent
 * específico, que nunca tinha essa checagem.
 *
 * Problema (#4732): o orchestrator confiava cegamente no JSON summary que o
 * `beehiiv-clicks-enricher` retorna (`{processed, ok, fail,
 * total_clicks_applied, failed_posts}`) sem cruzar contra o estado real em
 * disco. Na edição 260807, o agent alegou sucesso mas
 * `data/beehiiv-cache/posts/*.json` nunca foi tocado (mtime anterior ao
 * dispatch) — 22 posts ficaram sem enrichment de verdade, sem nenhum sinal.
 *
 * Estratégia: comparar, pra cada post_id que o manifest pediu enrichment E
 * que o agent NÃO listou em `failed_posts` (ou seja, alegou sucesso), o mtime
 * de `data/beehiiv-cache/posts/{post_id}.json` contra `dispatchedAt` (o
 * timestamp capturado pelo orchestrator IMEDIATAMENTE ANTES do `Agent(...)`
 * dispatch). `apply-mcp-clicks.ts` sempre escreve via tmp+rename (write
 * atômico) — qualquer aplicação real de clicks atualiza o mtime do arquivo.
 * Um post alegado `ok` cujo cache não mudou desde o dispatch é uma
 * divergência real: o agent disse que aplicou, o disco discorda.
 *
 * Não usamos "stats.clicks não-vazio" como sinal — um post genuinamente sem
 * clicks (404 ou zero clicks) aplica `[]` e isso é um resultado LEGÍTIMO
 * (documentado no próprio `beehiiv-clicks-enricher.md` §Robustez), não uma
 * falha. Só o mtime distingue "tentei e apliquei (mesmo que vazio)" de "nunca
 * toquei o arquivo".
 *
 * Uso:
 *   npx tsx scripts/verify-clicks-enrichment.ts \
 *     --manifest <path para JSON com posts_needing_clicks ou array de ids> \
 *     --summary <path para o JSON summary retornado pelo agent> \
 *     --dispatched-at <ISO timestamp capturado antes do Agent(...) dispatch> \
 *     [--posts-dir data/beehiiv-cache/posts]
 *
 * Output (stdout): JSON `{ ok, claimed_ok_count, verified_ok_count, mismatches }`.
 * Exit code: 0 quando ok (sem divergência), 1 quando há mismatch — o
 * orchestrator trata como `level: warn` real (nunca `--informational`), NUNCA
 * aborta o pipeline (mesmo padrão fail-soft do resto do bloco 0h).
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POSTS_DIR = resolve(ROOT, "data/beehiiv-cache/posts");

export interface ClicksVerifyInput {
  /** Todos os post_ids que o manifest `posts_needing_clicks` pediu enrichment. */
  manifestPostIds: string[];
  /** `failed_posts` do JSON summary retornado pelo agent. */
  failedPosts: string[];
  /** ISO timestamp capturado pelo orchestrator ANTES do `Agent(...)` dispatch. */
  dispatchedAt: string;
}

export interface ClicksVerifyResult {
  ok: boolean;
  claimed_ok_count: number;
  verified_ok_count: number;
  mismatches: string[];
}

/** Injetável pra teste — default lê mtime real via `statSync`. */
export type CacheMetaReader = (postId: string) => { exists: boolean; mtimeMs: number };

export function makeFsCacheMetaReader(postsDir: string): CacheMetaReader {
  return (postId: string) => {
    const path = join(postsDir, `${postId}.json`);
    if (!existsSync(path)) return { exists: false, mtimeMs: 0 };
    return { exists: true, mtimeMs: statSync(path).mtimeMs };
  };
}

/**
 * Pure: cruza o manifest + summary contra o estado real em disco (via
 * `readCacheMeta`, injetável). Post claimed `ok` (não está em `failedPosts`)
 * cujo cache está ausente OU não foi tocado desde `dispatchedAt` vira
 * mismatch.
 */
export function verifyClicksApplied(
  input: ClicksVerifyInput,
  readCacheMeta: CacheMetaReader,
): ClicksVerifyResult {
  const dispatchedAtMs = Date.parse(input.dispatchedAt);
  const failedSet = new Set(input.failedPosts);
  const claimedOk = input.manifestPostIds.filter((id) => !failedSet.has(id));

  const mismatches: string[] = [];
  for (const id of claimedOk) {
    const meta = readCacheMeta(id);
    if (!meta.exists) {
      mismatches.push(id);
      continue;
    }
    // NaN (dispatchedAt inválido) nunca compara true — trata como divergência
    // visível em vez de silenciosamente aceitar tudo.
    if (Number.isNaN(dispatchedAtMs) || meta.mtimeMs <= dispatchedAtMs) {
      mismatches.push(id);
    }
  }

  return {
    ok: mismatches.length === 0,
    claimed_ok_count: claimedOk.length,
    verified_ok_count: claimedOk.length - mismatches.length,
    mismatches,
  };
}

/** Aceita tanto `[{id, ...}]` (shape de `posts_needing_clicks`) quanto `["id1", "id2"]`. */
export function extractManifestPostIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === "string" ? item : (item as { id?: string })?.id))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const manifestPath = get("--manifest");
  const summaryPath = get("--summary");
  const dispatchedAt = get("--dispatched-at");
  const postsDir = get("--posts-dir") ?? DEFAULT_POSTS_DIR;

  if (!manifestPath || !summaryPath || !dispatchedAt) {
    console.error(
      "Uso: verify-clicks-enrichment.ts --manifest <path> --summary <path> --dispatched-at <ISO> [--posts-dir <path>]",
    );
    process.exit(2);
  }

  let manifestPostIds: string[];
  let failedPosts: string[];
  try {
    manifestPostIds = extractManifestPostIds(readJsonFile(manifestPath));
    const summaryRaw = readJsonFile(summaryPath) as { failed_posts?: unknown };
    failedPosts = Array.isArray(summaryRaw.failed_posts)
      ? summaryRaw.failed_posts.filter((x): x is string => typeof x === "string")
      : [];
  } catch (e) {
    console.error(`[verify-clicks-enrichment] falha lendo manifest/summary: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
    return;
  }

  const result = verifyClicksApplied(
    { manifestPostIds, failedPosts, dispatchedAt },
    makeFsCacheMetaReader(postsDir),
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `[verify-clicks-enrichment] ${result.mismatches.length} post(s) alegado(s) ok pelo agent mas sem escrita real no cache desde o dispatch: ${result.mismatches.join(", ")}`,
    );
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
