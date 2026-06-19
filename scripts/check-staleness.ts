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
import { urlsMatch } from "./lib/url-utils.ts";
import {
  extractDestaqueUrls,
  extractPromptUrl,
} from "./match-prompts-to-destaques.ts";
import {
  readDestaqueCount,
  REQUIRED_IMAGES_BASE,
  REQUIRED_IMAGES_D3,
} from "./lib/invariant-checks/stage-3.ts";

// ---------------------------------------------------------------------------
// Params de tracking que a versão local (normalizeUrl pré-#2308) stripava
// e que canonicalize() de url-utils.ts não cobre (source, medium, campaign
// são ambíguos para dedup, mas localmente são sempre tracking de RSS/feeds).
// #2308-finding-2: stripping local em vez de alterar canonicalize globalmente
// (dedup e outros callers podem precisar de `source` como param semântico).
// ---------------------------------------------------------------------------
const LOCAL_TRACKING_PARAMS = new Set(["source", "medium", "campaign"]);

// ---------------------------------------------------------------------------
// Config: por stage, quais downstream → upstream(s) checar
// ---------------------------------------------------------------------------

interface StageCheck {
  downstream: string;
  upstreams: string[];
}

/**
 * Mapeia um filename de imagem de destaque (ex: `04-d2-2x1.jpg`) para o
 * caminho do prompt que a gerou (ex: `_internal/02-d2-prompt.md`).
 * Extrai o slot (d1/d2/d3) via regex — invariante: imagens de destaque
 * seguem o padrão `04-d{N}-*.jpg` definido em stage-3.ts.
 */
function imageToPromptPath(filename: string): string | null {
  const m = filename.match(/^04-(d\d+)-/);
  if (!m) return null;
  return `_internal/02-${m[1]}-prompt.md`;
}

/**
 * Deriva as entradas de check de imagem de destaque da fonte canônica
 * (REQUIRED_IMAGES_BASE / REQUIRED_IMAGES_D3 de stage-3.ts), filtrando
 * para apenas imagens `04-*`. Analogia direta com o que #2366 fez no
 * validate-stage-3-completeness.ts — evita divergência quando REQUIRED_IMAGES_*
 * ganhar novos heroes (como 04-d2-2x1.jpg em #2133/#2141, 04-d3-2x1.jpg).
 * #2400: corrige omissão de 04-d2-2x1.jpg / 04-d3-2x1.jpg nos STAGE_CHECKS.
 */
function deriveImageChecks(images: string[]): StageCheck[] {
  const checks: StageCheck[] = [];
  for (const img of images) {
    if (!img.startsWith("04-")) continue; // skip eia-* images
    const promptPath = imageToPromptPath(img);
    if (!promptPath) continue;
    checks.push({ downstream: img, upstreams: [promptPath] });
  }
  return checks;
}

// Imagens de destaque base (d1 + d2 — todas as edições) e d3 (só 3-destaque).
// Deriva de REQUIRED_IMAGES_BASE/D3 (stage-3.ts) para manter sincronismo.
// #2400: inclui 04-d2-2x1.jpg e 04-d3-2x1.jpg que faltavam nos STAGE_CHECKS.
const IMAGE_CHECKS_BASE: StageCheck[] = deriveImageChecks(REQUIRED_IMAGES_BASE);
const IMAGE_CHECKS_D3: StageCheck[] = deriveImageChecks(REQUIRED_IMAGES_D3);

export const STAGE_CHECKS: Record<string, StageCheck[]> = {
  // Stage 6 (publish social): 03-social.md (texto, deriva do corpo 02-reviewed.md)
  // + 04-d{1,2,3}*.jpg (imagens). #1710: as imagens derivam do PROMPT editorial
  // (_internal/02-d{N}-prompt.md), que é o que image-generate.ts lê — NÃO do
  // 02-reviewed.md. Comparar vs reviewed dava falso-positivo toda vez que o
  // editor ajustava texto pós-imagem (ou o sync pull tocava o mtime do MD).
  // #2400: IMAGE_CHECKS_BASE/D3 derivados de stage-3.ts para incluir todos os
  // heroes (04-d2-2x1.jpg + 04-d3-2x1.jpg) sem re-listar inline.
  "6": [
    { downstream: "03-social.md", upstreams: ["02-reviewed.md"] },
    ...IMAGE_CHECKS_BASE,
    ...IMAGE_CHECKS_D3,
  ],
  // Stage 4 (publicação): imagens + social. #1710: imagens vs seu prompt
  // (_internal/02-d{N}-prompt.md), não 02-reviewed.md. #1413: 03-social.md
  // vs 02-reviewed.md (catch editor reestruturando destaques pós-Stage 2).
  // #2400: IMAGE_CHECKS_BASE/D3 derivados de stage-3.ts para incluir todos os
  // heroes (04-d2-2x1.jpg + 04-d3-2x1.jpg) sem re-listar inline.
  "4": [
    ...IMAGE_CHECKS_BASE,
    ...IMAGE_CHECKS_D3,
    { downstream: "03-social.md", upstreams: ["02-reviewed.md"] },
  ],
  // Stage 3 (social) deriva de 02-reviewed.md.
  "3": [{ downstream: "03-social.md", upstreams: ["02-reviewed.md"] }],
};

/**
 * #2366: retorna os STAGE_CHECKS filtrados pelo destaque_count da edição.
 * Em edições 2-destaque, remove entradas que referenciam d3 (04-d3-*.jpg,
 * _internal/02-d3-prompt.md) — sem isso, um arquivo d3 residual de run
 * 3-destaque anterior pode disparar falso-positivo de staleness.
 *
 * Os STAGE_CHECKS estáticos são preservados para compatibilidade com testes.
 * Esta função é usada pelo CLI em vez de STAGE_CHECKS[stage] diretamente.
 */
export function getStageChecksForEdition(
  stage: string,
  editionDir: string,
): StageCheck[] {
  const checks = STAGE_CHECKS[stage] ?? [];
  const destaqueCount = readDestaqueCount(editionDir);
  // 3-destaque: nada a filtrar — retorna uma cópia (não a referência viva de
  // STAGE_CHECKS) para que um caller que mute o array não corrompa a constante
  // compartilhada. Espelha a postura defensiva do branch 2-destaque (.filter()).
  if (destaqueCount === 3) return [...checks];
  // 2-destaque: remover entradas cujo downstream ou upstream referenciam o slot d3.
  // Match por segmento (`-d3-`, `02-d3-`, etc) via isD3Path, não substring solto,
  // para não filtrar por engano um caminho futuro com "d3" fora de um slot.
  return checks.filter(
    (c) => !isD3Path(c.downstream) && !c.upstreams.some(isD3Path),
  );
}

/**
 * True se o caminho referencia o slot de destaque d3 — match por segmento
 * (`d3` delimitado por início/fim, `/`, `_`, `-`, `.`), não substring solto.
 * Evita falso-positivo com caminhos hipotéticos como `02-d30-...` ou `index3d`.
 */
function isD3Path(relPath: string): boolean {
  return /(^|[/_-])d3([-.]|$)/.test(relPath);
}

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

/**
 * Stripa params de tracking RSS (source, medium, campaign) de uma URL.
 * Retorna a URL original se inválida (sem lançar exceção).
 * Usado localmente antes de delegar a urlsMatch (#2308-finding-2).
 */
function stripLocalTrackingParams(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (LOCAL_TRACKING_PARAMS.has(key.toLowerCase())) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** True se as duas URLs são equivalentes após canonicalização (#2308).
 * Delega para urlsMatch() de lib/url-utils.ts (finding-1: evita reimplementação)
 * com pré-stripping de source/medium/campaign (finding-2: params RSS que
 * canonicalize() não remove mas normalizeUrl() local removia — sem isso
 * imageUrlsMatch("url?source=rss", "url") retornaria false, regressão). */
export function imageUrlsMatch(a: string, b: string): boolean {
  return urlsMatch(stripLocalTrackingParams(a), stripLocalTrackingParams(b));
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

  // #2366: use edition-aware checks (d3 entries filtered for 2-destaque editions)
  const checks = getStageChecksForEdition(parsed.stage, editionDir);
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
