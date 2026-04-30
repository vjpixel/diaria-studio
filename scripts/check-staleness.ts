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
 *         "lag_minutes": 159
 *       }
 *     ]
 *   }
 *
 * Exit codes:
 *   0 = ok (nada stale ou stage não tem checks)
 *   1 = stale detectado (orchestrator decide: re-rodar upstream ou continuar)
 *   2 = erro (edition-dir não existe, args inválidos)
 *
 * Refs #120.
 */

import { existsSync, statSync } from "node:fs";
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
  // Stage 6 (publish social) usa 03-social.md (texto) e 04-d{1,2,3}*.jpg
  // (imagens). Ambos derivam de 02-reviewed.md (corpo da newsletter,
  // contém os highlights que viram posts + prompts de imagem).
  "6": [
    { downstream: "03-social.md", upstreams: ["02-reviewed.md"] },
    { downstream: "04-d1-2x1.jpg", upstreams: ["02-reviewed.md"] },
    { downstream: "04-d1-1x1.jpg", upstreams: ["02-reviewed.md"] },
    { downstream: "04-d2-1x1.jpg", upstreams: ["02-reviewed.md"] },
    { downstream: "04-d3-1x1.jpg", upstreams: ["02-reviewed.md"] },
  ],
  // Stage 4 (imagens) deriva os prompts de 02-reviewed.md (highlights).
  "4": [
    { downstream: "04-d1-2x1.jpg", upstreams: ["02-reviewed.md"] },
    { downstream: "04-d1-1x1.jpg", upstreams: ["02-reviewed.md"] },
    { downstream: "04-d2-1x1.jpg", upstreams: ["02-reviewed.md"] },
    { downstream: "04-d3-1x1.jpg", upstreams: ["02-reviewed.md"] },
  ],
  // Stage 3 (social) deriva de 02-reviewed.md.
  "3": [{ downstream: "03-social.md", upstreams: ["02-reviewed.md"] }],
};

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

export interface StaleEntry {
  downstream: string;
  downstream_mtime: string;
  upstream: string;
  upstream_mtime: string;
  lag_minutes: number;
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
 * Versão pura: recebe um getter de mtime + lista de checks, retorna stale[].
 * Permite testar sem fs real.
 */
export function evaluateStaleness(
  checks: StageCheck[],
  getMtime: (relPath: string) => number | null,
  toleranceMs = 1000,
): StaleEntry[] {
  const stale: StaleEntry[] = [];
  for (const check of checks) {
    const dMs = getMtime(check.downstream);
    if (dMs === null) continue; // downstream não existe → skip
    for (const up of check.upstreams) {
      const uMs = getMtime(up);
      if (uMs === null) continue; // upstream não existe → skip
      if (isStale(dMs, uMs, toleranceMs)) {
        stale.push({
          downstream: check.downstream,
          downstream_mtime: new Date(dMs).toISOString(),
          upstream: up,
          upstream_mtime: new Date(uMs).toISOString(),
          lag_minutes: lagMinutes(dMs, uMs),
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

  const stale = evaluateStaleness(checks, getMtime);
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
