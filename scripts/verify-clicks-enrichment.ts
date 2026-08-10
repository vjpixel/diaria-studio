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
 * Não usamos "stats.clicks não-vazio" como sinal SOZINHO — um post
 * genuinamente sem clicks (404 ou zero clicks) aplica `[]` e isso é um
 * resultado LEGÍTIMO (documentado no próprio `beehiiv-clicks-enricher.md`
 * §Robustez), não uma falha. Só o mtime distingue "tentei e apliquei (mesmo
 * que vazio)" de "nunca toquei o arquivo" — por isso o check de mismatch
 * acima permanece mtime-only.
 *
 * INVARIANTE DE CONTEÚDO (#4836): separado do check de mtime, comparamos
 * `stats.email.verified_clicks`/`unique_verified_clicks` (agregado — o
 * mesmo denominador que `scripts/lib/shared/click-cache-completeness.ts`
 * usa) contra `stats.clicks` (per-link) de cada post CLAIMED OK, no estado
 * ATUAL do arquivo em disco: `agregado > 0 ⟹ stats.clicks não-vazio`. Um
 * post com aberturas/cliques verificados no agregado mas sem NENHUMA linha
 * per-link é exatamente a assinatura do incidente #4836 (22 posts,
 * 2026-08-05: `unique_verified_clicks` entre 6 e 28, `stats.clicks: []`) —
 * diferente do "post genuinamente sem clicks" do parágrafo acima, onde o
 * agregado também é zero. Isto é aditivo ao check de mtime, não o substitui:
 * um post pode passar no mtime (arquivo foi tocado nesta run) e ainda assim
 * violar o invariante (o agent aplicou um payload vazio por cima de um
 * agregado positivo — o próprio cenário que `apply-mcp-clicks.ts` agora
 * recusa por padrão via `EmptyReplaceGuardError`, mas que pode ter sido
 * escrito antes desse guard existir, ou via `--allow-empty-replace`
 * incorreto).
 *
 * Uso:
 *   npx tsx scripts/verify-clicks-enrichment.ts \
 *     --manifest <path para JSON com posts_needing_clicks ou array de ids> \
 *     --summary <path para o JSON summary retornado pelo agent> \
 *     --dispatched-at <ISO timestamp capturado antes do Agent(...) dispatch> \
 *     [--posts-dir data/beehiiv-cache/posts]
 *
 * Output (stdout): JSON `{ ok, claimed_ok_count, verified_ok_count, mismatches, invariant_violations }`.
 * Exit code: 0 quando ok (sem divergência de mtime nem violação de invariante),
 * 1 caso contrário — o orchestrator trata como `level: warn` real (nunca
 * `--informational`), NUNCA aborta o pipeline (mesmo padrão fail-soft do
 * resto do bloco 0h).
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
  /** Posts claimed ok cujo agregado de email verificado é > 0 mas `stats.clicks` está vazio (#4836). */
  invariant_violations: string[];
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
 * Estado de conteúdo relevante pro invariante (#4836) — agregado de email
 * verificado do post vs. tamanho do `stats.clicks` per-link. `null` quando o
 * cache não existe ou não pôde ser lido (esses casos já viram mismatch de
 * mtime separadamente — o check de invariante não duplica esse sinal).
 */
export interface ClickInvariantStats {
  /** `stats.email.verified_clicks` preferido, fallback `unique_verified_clicks` — mesmo denominador de `click-cache-completeness.ts`. */
  emailAggregate: number;
  clicksLength: number;
}

/** Injetável pra teste — default lê e faz parse do JSON real via `readFileSync`. */
export type CacheStatsReader = (postId: string) => ClickInvariantStats | null;

export function makeFsCacheStatsReader(postsDir: string): CacheStatsReader {
  return (postId: string) => {
    const path = join(postsDir, `${postId}.json`);
    if (!existsSync(path)) return null;
    try {
      const cache = JSON.parse(readFileSync(path, "utf8")) as {
        stats?: { clicks?: unknown[]; email?: { verified_clicks?: number; unique_verified_clicks?: number } };
      };
      const email = cache.stats?.email ?? {};
      return {
        emailAggregate: email.verified_clicks ?? email.unique_verified_clicks ?? 0,
        clicksLength: Array.isArray(cache.stats?.clicks) ? (cache.stats!.clicks as unknown[]).length : 0,
      };
    } catch {
      // JSON corrompido/ilegível — não é o que este check mede (mtime já cobre "arquivo ausente/intocado").
      return null;
    }
  };
}

/**
 * Pure: cruza posts CLAIMED OK contra o invariante de conteúdo
 * `emailAggregate > 0 ⟹ clicksLength > 0` (#4836). Não distingue "cache
 * ilegível" de "invariante ok" — ambos silenciosos aqui porque o mtime check
 * já cobre ausência/staleness de arquivo separadamente; duplicar o sinal só
 * confundiria qual dos dois checks pegou o quê.
 */
export function findInvariantViolations(claimedOk: string[], readStats: CacheStatsReader): string[] {
  const violations: string[] = [];
  for (const id of claimedOk) {
    const stats = readStats(id);
    if (!stats) continue;
    if (stats.emailAggregate > 0 && stats.clicksLength === 0) {
      violations.push(id);
    }
  }
  return violations;
}

/**
 * Pure: cruza o manifest + summary contra o estado real em disco (via
 * `readCacheMeta`, injetável). Post claimed `ok` (não está em `failedPosts`)
 * cujo cache está ausente OU não foi tocado desde `dispatchedAt` vira
 * mismatch.
 *
 * `readCacheStats` (opcional, #4836) roda o segundo check — invariante de
 * CONTEÚDO (`emailAggregate > 0 ⟹ stats.clicks não-vazio`), independente do
 * mtime. Omitido (chamadas antigas, 2 argumentos) => `invariant_violations`
 * sempre `[]`, comportamento idêntico ao pré-#4836.
 */
export function verifyClicksApplied(
  input: ClicksVerifyInput,
  readCacheMeta: CacheMetaReader,
  readCacheStats?: CacheStatsReader,
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

  const invariantViolations = readCacheStats ? findInvariantViolations(claimedOk, readCacheStats) : [];
  const failing = new Set([...mismatches, ...invariantViolations]);

  return {
    ok: mismatches.length === 0 && invariantViolations.length === 0,
    claimed_ok_count: claimedOk.length,
    verified_ok_count: claimedOk.length - failing.size,
    mismatches,
    invariant_violations: invariantViolations,
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
    makeFsCacheStatsReader(postsDir),
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    if (result.mismatches.length > 0) {
      console.error(
        `[verify-clicks-enrichment] ${result.mismatches.length} post(s) alegado(s) ok pelo agent mas sem escrita real no cache desde o dispatch: ${result.mismatches.join(", ")}`,
      );
    }
    if (result.invariant_violations.length > 0) {
      console.error(
        `[verify-clicks-enrichment] ${result.invariant_violations.length} post(s) com agregado de email verificado > 0 mas stats.clicks vazio (#4836): ${result.invariant_violations.join(", ")}`,
      );
    }
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
