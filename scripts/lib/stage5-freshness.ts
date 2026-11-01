/**
 * stage5-freshness.ts (#11698) — o conteúdo da edição neste host é o que o
 * gate 4 aprovou? Somente leitura, fail-closed.
 *
 * `data/` sincroniza por OneDrive entre máquinas e o sentinel do Stage 4
 * (`.step-4-done.json`) pode chegar a outro host antes da versão nova de
 * `02-reviewed.md`/`03-social.md`. Esses arquivos existem em todo host desde
 * a Etapa 2, então presença e mtime não distinguem a versão aprovada de uma
 * cópia pré-gate (review da PR #11700). O sentinel grava `output_hashes`
 * (sha256 de cada output, `scripts/lib/pipeline-state.ts`) e aqui o conteúdo
 * local é comparado com ele.
 *
 * `03-social.md`: o próprio Stage 5 (§5c-2, `resolve-edition-url.ts
 * --validate-social`) troca `{edition_url}` pela URL resolvida depois do
 * sentinel. Na retomada, a URL EXATA gravada em `_internal/05-edition-url.txt`
 * volta ao placeholder antes de comparar. Sem regex de domínio: só a URL que o
 * Stage 5 escreveu é revertida, então trocar outro link próprio continua
 * aparecendo como divergência.
 *
 * Sentinel gravado antes do #11698 (sem `output_hashes`): não há como
 * conferir o conteúdo; sai com aviso, sem bloquear (transição).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./pipeline-state.ts";

/** Sempre conferidos, mesmo com `outputs` do sentinel vazio ou inválido. */
export const STAGE5_ALWAYS_WATCHED = ["02-reviewed.md", "03-social.md"] as const;

export interface Stage5FreshnessResult {
  ok: boolean;
  /** Cada item bloqueia. */
  problems: string[];
  /** Não bloqueiam (sentinel legado sem hashes). */
  warnings: string[];
}

/** Arquivo que o §5c-2 reescreve com a URL resolvida. */
const URL_REWRITTEN = "03-social.md";

function readEditionUrl(editionDir: string): string | null {
  const p = join(editionDir, "_internal", "05-edition-url.txt");
  if (!existsSync(p)) return null;
  const url = readFileSync(p, "utf8").trim();
  return url.startsWith("https://") ? url : null;
}

/**
 * O conteúdo local bate com o hash aprovado? Em `03-social.md`, aceita também
 * a versão com a URL resolvida pelo Stage 5 revertida ao placeholder.
 */
export function matchesApprovedHash(
  rel: string,
  content: Buffer,
  expected: string,
  editionUrl: string | null,
): boolean {
  if (sha256Hex(content) === expected) return true;
  if (rel !== URL_REWRITTEN || !editionUrl) return false;
  const reverted = content.toString("utf8").replaceAll(editionUrl, "{edition_url}");
  return sha256Hex(reverted) === expected;
}

export function checkStage5Freshness(editionDir: string): Stage5FreshnessResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const sentinelPath = join(editionDir, "_internal", ".step-4-done.json");
  if (!existsSync(sentinelPath)) {
    return { ok: false, problems: ["sentinel do Stage 4 ausente (ainda sincronizando?)"], warnings };
  }
  let sentinel: { outputs?: unknown; output_hashes?: unknown };
  try {
    sentinel = JSON.parse(readFileSync(sentinelPath, "utf8"));
    if (!sentinel || typeof sentinel !== "object") throw new Error("não é objeto");
  } catch {
    return { ok: false, problems: ["sentinel do Stage 4 ilegível (sync em trânsito?)"], warnings };
  }

  const outputs: string[] = [];
  if (Array.isArray(sentinel.outputs) && sentinel.outputs.every((x) => typeof x === "string")) {
    outputs.push(...(sentinel.outputs as string[]));
  } else {
    problems.push("sentinel do Stage 4 com `outputs` inválido");
  }

  const rawHashes = sentinel.output_hashes;
  const hasHashes = rawHashes !== undefined;
  let hashes: Record<string, unknown> = {};
  if (hasHashes) {
    if (rawHashes && typeof rawHashes === "object" && !Array.isArray(rawHashes)) {
      hashes = rawHashes as Record<string, unknown>;
    } else {
      problems.push("sentinel do Stage 4 com `output_hashes` inválido");
    }
  } else {
    warnings.push(
      "sentinel do Stage 4 sem output_hashes (gravado antes do #11698): o conteúdo de 02-reviewed.md/03-social.md não pôde ser conferido contra o aprovado",
    );
  }

  const editionUrl = readEditionUrl(editionDir);
  const watched = [...new Set<string>([...STAGE5_ALWAYS_WATCHED, ...outputs])];
  for (const rel of watched) {
    const p = join(editionDir, rel);
    if (!existsSync(p)) {
      problems.push(`${rel}: ausente`);
      continue;
    }
    const content = readFileSync(p);
    if (content.length === 0) {
      problems.push(`${rel}: vazio`);
      continue;
    }
    if (!hasHashes) continue;
    const expected = hashes[rel];
    if (typeof expected !== "string") {
      problems.push(`${rel}: sem hash no sentinel do Stage 4 (não dá para conferir a versão)`);
      continue;
    }
    if (!matchesApprovedHash(rel, content, expected, editionUrl)) {
      problems.push(`${rel}: conteúdo difere do aprovado no gate 4 (sha256): versão anterior ainda sincronizando, ou editado depois do gate`);
    }
  }
  return { ok: problems.length === 0, problems, warnings };
}

