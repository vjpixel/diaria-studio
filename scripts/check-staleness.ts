/**
 * check-staleness.ts
 *
 * Detecta quando um output downstream está mais antigo que seu input
 * upstream — sinal de que o upstream foi editado depois do downstream
 * ser gerado, e o downstream precisa regenerar antes de prosseguir.
 *
 * Caso real (#120): editor atualizou `02-reviewed.md` no Drive depois do
 * Stage 3 já ter gerado `03-social.md`. Stage 6 publicou os posts com texto
 * antigo porque ninguém re-rodou Stage 3.
 *
 * Uso pelo orchestrator no início do Stage 6:
 *
 *   npx tsx scripts/check-staleness.ts \
 *     --edition-dir data/editions/260425/ --stage 6
 *
 * Output (stdout, JSON):
 *   {
 *     "ok": false,
 *     "stage": 6,
 *     "stale": [
 *       {
 *         "downstream": "03-social.md",
 *         "downstream_mtime": "2026-04-24T19:33:34Z",
 *         "upstream": "02-reviewed.md",
 *         "upstream_mtime": "2026-04-24T22:13:13Z",
 *         "lag_minutes": 159,
 *         "check_mode": "mtime"
 *       }
 *     ]
 *   }
 *
 * Exit codes:
 *   0 = ok (nada stale ou stage não tem checks)
 *   1 = stale detectado (orchestrator decide: re-rodar upstream ou continuar)
 *   2 = erro (edition-dir não existe, args inválidos)
 *
 * Refs #120, #1710, #2287.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "./lib/url-utils.ts";
import {
  extractDestaqueUrls,
  extractPromptUrl,
} from "./match-prompts-to-destaques.ts";

// ---------------------------------------------------------------------------
// Config: por stage, quais downstream → upstream(s) checar
// ---------------------------------------------------------------------------

interface StageCheck {
  downstream: string;
  upstreams: string[];
}

export const STAGE_CHECKS: Record<string, StageCheck[]> = {
  // Stage 6 (publish social): 03-social.md (texto, deriva do corpo 02-reviewed.md)
  // + 04-d{1,2,3}*.jpg (imagens). #1710: as imagens derivam do PROMPT editorial
  // (_internal/02-d{N}-prompt.md), que é o que image-generate.ts lê — NÃO do
  // 02-reviewed.md. Comparar vs reviewed dava falso-positivo toda vez que o
  // editor ajustava texto pós-imagem (ou o sync pull tocava o mtime do MD).
  "6": [
    { downstream: "03-social.md", upstreams: ["02-reviewed.md"] },
    { downstream: "04-d1-2x1.jpg", upstreams: ["_internal/02-d1-prompt.md"] },
    { downstream: "04-d1-1x1.jpg", upstreams: ["_internal/02-d1-prompt.md"] },
    { downstream: "04-d2-1x1.jpg", upstreams: ["_internal/02-d2-prompt.md"] },
    { downstream: "04-d3-1x1.jpg", upstreams: ["_internal/02-d3-prompt.md"] },
  ],
  // Stage 4 (publicação): imagens + social. #1710: imagens vs seu prompt
  // (_internal/02-d{N}-prompt.md), não 02-reviewed.md. #1413: 03-social.md
  // vs 02-reviewed.md (catch editor reestruturando destaques pós-Stage 2).
  "4": [
    { downstream: "04-d1-2x1.jpg", upstreams: ["_internal/02-d1-prompt.md"] },
    { downstream: "04-d1-1x1.jpg", upstreams: ["_internal/02-d1-prompt.md"] },
    { downstream: "04-d2-1x1.jpg", upstreams: ["_internal/02-d2-prompt.md"] },
    { downstream: "04-d3-1x1.jpg", upstreams: ["_internal/02-d3-prompt.md"] },
    { downstream: "03-social.md", upstreams: ["02-reviewed.md"] },
  ],
  // Stage 3 (social) deriva de 02-reviewed.md.
  "3": [{ downstream: "03-social.md", upstreams: ["02-reviewed.md"] }],
};

// ---------------------------------------------------------------------------
// image-content-fresh helpers (#2287)
// ---------------------------------------------------------------------------

/**
 * Extrai URLs dos destaques D1/D2/D3 do 02-reviewed.md.
 * Delega para extractDestaqueUrls de match-prompts-to-destaques.ts (#2308).
 * A implementação local foi removida por duplicar lógica divergente
 * (regex parava em `)`, truncando URLs Wikipedia com parênteses balanceados).
 */
export function extractReviewedUrls(reviewedMd: string): string[] {
  return extractDestaqueUrls(reviewedMd);
}

/**
 * Extrai destaque_url do frontmatter de um arquivo de prompt.
 * Delega para extractPromptUrl de match-prompts-to-destaques.ts (#2308).
 * A implementação local era divergente: não tinha o fallback de body-field
 * (`destaque_url:` fora do frontmatter — prompts antigos pré-#606).
 */
export function extractPromptUrlLocal(promptMd: string): string | null {
  return extractPromptUrl(promptMd);
}

/** True se as duas URLs são equivalentes após canonicalização (#2308).
 * Usa canonicalize() de lib/url-utils.ts em vez de normalizeUrl() local
 * (que perdia fragment e ref_src stripping). */
export function imageUrlsMatch(a: string, b: string): boolean {
  return canonicalize(a) === canonicalize(b);
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

export interface StaleEntry {
  downstream: string;
  downstream_mtime: string;
  upstream: string;
  upstream_mtime: string;
  lag_minutes: number;
  /** Modo de comparação usado: "mtime" (único modo suportado). */
  check_mode: "mtime";
}

export interface StalenessResult {
  ok: boolean;
  stage: string;
  stale: StaleEntry[];
}

/**
 * Compara timestamps. Pure — não toca o filesystem.
 *
 * Tolerância: 1 segundo. Diferenças menores costumam ser ruído (clock skew,
 * chamadas paralelas dentro do mesmo stage). 60s é demais — pull do Drive
 * pode levar segundos e já indica que o conteúdo mudou.
 */
export function isStale(
  downstreamMs: number,
  upstreamMs: number,
  toleranceMs = 1000,
): boolean {
  return upstreamMs - downstreamMs > toleranceMs;
}

export function lagMinutes(downstreamMs: number, upstreamMs: number): number {
  return Math.round((upstreamMs - downstreamMs) / 1000 / 60);
}

/**
 * Versão pura: recebe getters de mtime e image-content-fresh + lista de checks.
 * Retorna stale[]. Permite testar sem fs real.
 *
 * Para arquivos de texto (03-social.md, 02-reviewed.md): usa mtime.
 * Para imagens (*.jpg etc, #2287): usa mtime MAS suprime o falso-positivo de
 * reorder via `getImageFresh`:
 *   - Se `getImageFresh(relPath)` retorna `true`, a imagem está fresca
 *     (prompt URL bate com o artigo atual em 02-reviewed.md) → NÃO stale.
 *     Isso cobre o FP pós-reorder: apenas os PROMPTS são renomeados no
 *     reorder (não as imagens); o mtime novo do prompt (upstream) causava
 *     falso-positivo de staleness, mesmo que a imagem servisse o artigo certo.
 *   - Se retorna `false` ou não é fornecido, usa mtime normalmente.
 *     Isso garante que uma imagem genuinamente stale (editor trocou artigo
 *     sem regenerar imagem — image-content-fresh falha) ainda seja detectada.
 *
 * A verificação image-content-fresh (#1730) em Stage 4 já cobre article-swap;
 * esta supressão só evita que reorders reportem FP de mtime em check-staleness.
 *
 * @param getMtime       Getter de mtime em ms (retorna null se ausente).
 * @param getImageFresh  Getter de freshness de imagem. Retorna true se a
 *                       imagem serve o artigo atual (URL match via prompt
 *                       frontmatter) → suprimir falso-positivo de mtime.
 *                       Omitido = nunca suprimir (comportamento pré-#2287).
 */
export function evaluateStaleness(
  checks: StageCheck[],
  getMtime: (relPath: string) => number | null,
  toleranceMs = 1000,
  getImageFresh?: (relPath: string) => boolean,
): StaleEntry[] {
  const stale: StaleEntry[] = [];
  for (const check of checks) {
    const dMs = getMtime(check.downstream);
    if (dMs === null) continue; // downstream não existe → skip
    for (const up of check.upstreams) {
      const uMs = getMtime(up);
      if (uMs === null) continue; // upstream não existe → skip

      // #2287: para imagens, suprimir FP de mtime quando image-content-fresh
      // passa (URL do prompt bate com artigo atual em 02-reviewed.md).
      if (getImageFresh && isImagePath(check.downstream)) {
        if (getImageFresh(check.downstream)) {
          continue; // imagem fresca — FP de mtime suprimido
        }
      }

      if (isStale(dMs, uMs, toleranceMs)) {
        stale.push({
          downstream: check.downstream,
          downstream_mtime: new Date(dMs).toISOString(),
          upstream: up,
          upstream_mtime: new Date(uMs).toISOString(),
          lag_minutes: lagMinutes(dMs, uMs),
          check_mode: "mtime",
        });
      }
    }
  }
  return stale;
}

/**
 * Retorna true se o caminho relativo aponta para um arquivo de imagem.
 * Não exportado — só usado internamente em evaluateStaleness e main().
 */
function isImagePath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".gif")
  );
}

/**
 * Constrói um `getImageFresh` a partir do editionDir.
 * Lê 02-reviewed.md + prompts de _internal/ para mapear slot → fresh.
 * Retorna undefined se reviewed.md ausente (Stage 3 não rodou ainda).
 */
export function buildGetImageFresh(
  editionDir: string,
): ((relPath: string) => boolean) | undefined {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(reviewedPath)) return undefined;

  let reviewedUrls: string[];
  try {
    reviewedUrls = extractReviewedUrls(readFileSync(reviewedPath, "utf8"));
  } catch {
    return undefined; // reviewed ilegível → degradation
  }
  if (reviewedUrls.length === 0) return undefined;

  const internalDir = resolve(editionDir, "_internal");
  const slots = ["d1", "d2", "d3"] as const;

  // freshMap: relative image path → boolean (true = URL matches)
  const freshMap: Record<string, boolean> = {};
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const reviewedUrl = reviewedUrls[i];
    if (!reviewedUrl) continue;

    const promptPath = resolve(internalDir, `02-${slot}-prompt.md`);
    if (!existsSync(promptPath)) continue;

    let promptUrl: string | null;
    try {
      promptUrl = extractPromptUrlLocal(readFileSync(promptPath, "utf8"));
    } catch {
      continue; // prompt ilegível → não suprimir
    }

    const isFresh = promptUrl !== null && imageUrlsMatch(promptUrl, reviewedUrl);
    // Map all image variants for this slot
    freshMap[`04-${slot}-2x1.jpg`] = isFresh;
    freshMap[`04-${slot}-1x1.jpg`] = isFresh;
  }

  return (relPath: string) => freshMap[relPath] ?? false;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliFlags {
  editionDir: string;
  stage: string;
}

function parseArgs(argv: string[]): CliFlags | { error: string } {
  const flags: { editionDir?: string; stage?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--edition-dir" && argv[i + 1]) {
      flags.editionDir = argv[i + 1];
      i++;
    } else if (a === "--stage" && argv[i + 1]) {
      flags.stage = argv[i + 1];
      i++;
    }
  }
  if (!flags.editionDir || !flags.stage) {
    return { error: "Usage: check-staleness.ts --edition-dir <path> --stage <N>" };
  }
  return { editionDir: flags.editionDir, stage: flags.stage };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(2);
  }

  const editionDir = resolve(ROOT, parsed.editionDir);
  if (!existsSync(editionDir)) {
    console.error(`edition-dir não existe: ${editionDir}`);
    process.exit(2);
  }

  const checks = STAGE_CHECKS[parsed.stage] ?? [];
  const getMtime = (relPath: string): number | null => {
    const full = resolve(editionDir, relPath);
    if (!existsSync(full)) return null;
    return statSync(full).mtimeMs;
  };

  // #2287: suprimir FP de mtime para imagens cuja URL de prompt bate com o artigo
  // atual no 02-reviewed.md (image-content-fresh). Se reviewed.md ausente ou prompts
  // sem destaque_url → getImageFresh = undefined → fallback para mtime puro.
  const getImageFresh = buildGetImageFresh(editionDir);

  const stale = evaluateStaleness(checks, getMtime, 1000, getImageFresh);
  const result: StalenessResult = {
    ok: stale.length === 0,
    stage: parsed.stage,
    stale,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
