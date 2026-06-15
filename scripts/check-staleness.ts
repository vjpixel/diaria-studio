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

import { existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
// Content-hash helpers for image files (#2287)
// ---------------------------------------------------------------------------

// Extensões de imagem que usam content hash em vez de mtime (#2287).
// Reorder de destaques renomeia os arquivos de imagem sem alterar o conteúdo —
// a data de modificação (mtime) do PROMPT upstream fica mais nova que a imagem,
// gerando falso-positivo de staleness. O hash do conteúdo detecta se a imagem
// REALMENTE mudou.
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

/** Retorna true se o arquivo é uma imagem que deve usar content-hash check. */
export function isImageFile(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  for (const ext of IMAGE_EXTS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/** Calcula SHA-256 do conteúdo de um arquivo (hex). Null se falhar. */
export function computeFileHash(absPath: string): string | null {
  try {
    const buf = readFileSync(absPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Caminho do arquivo sidecar de hash para uma imagem.
 * Ex: `data/editions/260615/04-d1-2x1.jpg` → `…/04-d1-2x1.jpg.sha256`
 *
 * image-generate.ts escreve este sidecar imediatamente após gerar a imagem.
 * check-staleness.ts lê este sidecar para comparar o hash registrado na geração
 * com o hash atual — se iguais, o conteúdo não mudou (rename/reorder) → não stale.
 */
export function hashSidecarPath(imageAbsPath: string): string {
  return imageAbsPath + ".sha256";
}

/**
 * Lê o hash salvo no sidecar de uma imagem. Null se o sidecar não existe.
 * O sidecar contém apenas o hex SHA-256, opcionalmente com newline.
 */
export function readImageHashSidecar(imageAbsPath: string): string | null {
  const sidecarPath = hashSidecarPath(imageAbsPath);
  try {
    return readFileSync(sidecarPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Escreve o hash de conteúdo de uma imagem no sidecar.
 * Chamado por image-generate.ts após gerar cada arquivo de imagem.
 */
export function writeImageHashSidecar(imageAbsPath: string): string | null {
  const hash = computeFileHash(imageAbsPath);
  if (hash == null) return null;
  writeFileSync(hashSidecarPath(imageAbsPath), hash + "\n", "utf8");
  return hash;
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
  /** Modo de comparação usado: "mtime" (texto) ou "content_hash" (imagem, #2287). */
  check_mode: "mtime" | "content_hash";
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
 * Versão pura: recebe getters de mtime e hash sidecar + lista de checks.
 * Retorna stale[]. Permite testar sem fs real.
 *
 * Para arquivos de texto (03-social.md, 02-reviewed.md): usa mtime.
 * Para imagens (*.jpg etc, #2287): usa content hash via sidecar:
 *   - Se sidecar presente: compara hash atual com hash registrado na geração.
 *     Hash igual → conteúdo não mudou (rename/reorder) → NÃO stale.
 *     Hash diferente → imagem realmente regenerada com conteúdo novo → stale.
 *   - Se sidecar ausente: fallback para mtime (comportamento anterior).
 *
 * @param getMtime      Getter de mtime em ms (retorna null se ausente).
 * @param getHashState  Getter de { current, saved } hashes de imagem.
 *                      Se omitido (undefined), imagens usam fallback mtime.
 */
export function evaluateStaleness(
  checks: StageCheck[],
  getMtime: (relPath: string) => number | null,
  toleranceMs = 1000,
  getHashState?: (relPath: string) => { current: string | null; saved: string | null } | null,
): StaleEntry[] {
  const stale: StaleEntry[] = [];
  for (const check of checks) {
    const dMs = getMtime(check.downstream);
    if (dMs === null) continue; // downstream não existe → skip
    for (const up of check.upstreams) {
      const uMs = getMtime(up);
      if (uMs === null) continue; // upstream não existe → skip

      // #2287: para imagens, usar content hash quando getHashState disponível.
      // O reorder de destaques renomeia imagens + prompts — mtime do prompt
      // (upstream) fica mais novo que a imagem (downstream), mas o CONTEÚDO
      // da imagem não muda. Comparar hash atual vs hash registrado na geração
      // elimina esse falso-positivo.
      if (getHashState && isImageFile(check.downstream)) {
        const hashState = getHashState(check.downstream);
        if (hashState !== null) {
          // Sidecar presente: comparar hash atual com hash salvo.
          const { current, saved } = hashState;
          if (current !== null && saved !== null && current === saved) {
            // Conteúdo idêntico ao da geração → não stale (era só rename).
            continue;
          }
          // Hash diferente ou null → conteúdo mudou ou sidecar corrompido → stale.
          if (isStale(dMs, uMs, toleranceMs)) {
            stale.push({
              downstream: check.downstream,
              downstream_mtime: new Date(dMs).toISOString(),
              upstream: up,
              upstream_mtime: new Date(uMs).toISOString(),
              lag_minutes: lagMinutes(dMs, uMs),
              check_mode: "content_hash",
            });
          }
          continue;
        }
        // Sidecar ausente → fallback mtime (imagem gerada antes do #2287).
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

  // #2287: fornecer getHashState para detectar imagens não-stale após reorder.
  const getHashState = (relPath: string): { current: string | null; saved: string | null } | null => {
    const full = resolve(editionDir, relPath);
    const saved = readImageHashSidecar(full);
    if (saved === null) return null; // sidecar ausente → fallback mtime
    const current = computeFileHash(full);
    return { current, saved };
  };

  const stale = evaluateStaleness(checks, getMtime, 1000, getHashState);
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
