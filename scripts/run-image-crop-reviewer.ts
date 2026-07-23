/**
 * run-image-crop-reviewer.ts (#3951)
 *
 * Script de orquestração do subagente `image-crop-reviewer` no Stage 3.
 * Descobre os pares hero(2:1)/crop(1:1) gerados por `image-generate.ts` para
 * os destaques presentes na edição, prepara os parâmetros de dispatch do
 * subagente, e — depois do subagente rodar — normaliza/grava o veredito em
 * `_internal/04-crop-review.json`.
 *
 * O revisor em si é um subagente vision/multimodal (não unit-testável
 * diretamente aqui — precisa do Agent tool, que este script não invoca).
 * O que É testável e vive aqui:
 *   (a) discoverCropPairs: descoberta determinística dos pares de imagem no disco.
 *   (b) normalizeCropReviewResult: validação/normalização do output do subagente.
 *   (c) formatGateSummary: formatação da seção pro gate (warning-only).
 *
 * Uso:
 *   # 1. Descobrir pares e obter parâmetros de dispatch:
 *   npx tsx scripts/run-image-crop-reviewer.ts --edition-dir data/editions/AAMMDD/
 *
 *   # 2. Depois do subagente gravar o resultado, persistir + formatar o gate:
 *   npx tsx scripts/run-image-crop-reviewer.ts --edition-dir data/editions/AAMMDD/ \
 *     --input-json <path-para-output-do-subagente>
 *
 * Output: data/editions/AAMMDD/_internal/04-crop-review.json
 *   + stdout: parâmetros de dispatch (modo descoberta) ou seção formatada (modo --input-json)
 *
 * Exit codes:
 *   0 — sucesso (modo --input-json sempre sai 0 — warning-only, nunca bloqueia, #3951)
 *   1 — erro de args, ou (modo descoberta) nenhum par de imagem encontrado
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

// ---------------------------------------------------------------------------
// Types — exportados para teste
// ---------------------------------------------------------------------------

export type DestaqueId = "d1" | "d2" | "d3";
export type CropReviewStatus = "ok" | "warn";

/** Par de imagens descoberto no disco para um destaque. */
export interface CropPair {
  destaque: DestaqueId;
  /** Hero 2:1 original. `null` quando o destaque só tem 1:1 nativo (sem crop). */
  hero_path: string | null;
  /** Crop 1:1 — o que de fato vai pro social (Instagram/Facebook). */
  crop_path: string;
}

export interface CropReviewEntry {
  destaque: DestaqueId;
  status: CropReviewStatus;
  motivo?: string;
  sugestao?: string;
}

export interface CropReviewSummary {
  total: number;
  ok: number;
  warn: number;
}

export interface CropReviewResult {
  edition: string;
  checked_at: string;
  results: CropReviewEntry[];
  summary: CropReviewSummary;
}

const DESTAQUE_IDS: DestaqueId[] = ["d1", "d2", "d3"];

// ---------------------------------------------------------------------------
// Pure helpers — exportados para teste
// ---------------------------------------------------------------------------

/**
 * Descobre os pares hero(2:1)/crop(1:1) presentes no disco para uma edição.
 * Um destaque só entra na lista se o crop 1:1 existir (é o que de fato vai
 * pro social — sem ele não há nada pra revisar). O hero 2:1 é opcional:
 * ausente = destaque nativo 1:1 (gerado com `--ratio 1x1`, sem crop real) —
 * nesse caso a checagem do subagente vira "está enquadrado e coerente?"
 * em vez de comparação 2:1↔1:1 (ver `.claude/agents/image-crop-reviewer.md`).
 *
 * Não assume destaque_count fixo — escaneia o disco diretamente (2 ou 3
 * destaques), consistente com o restante do Stage 3 (#2352/#3369).
 */
export function discoverCropPairs(editionDir: string): CropPair[] {
  const pairs: CropPair[] = [];
  for (const destaque of DESTAQUE_IDS) {
    const cropPath = join(editionDir, `04-${destaque}-1x1.jpg`);
    if (!existsSync(cropPath)) continue;
    const heroPath = join(editionDir, `04-${destaque}-2x1.jpg`);
    pairs.push({
      destaque,
      hero_path: existsSync(heroPath) ? heroPath : null,
      crop_path: cropPath,
    });
  }
  return pairs;
}

/**
 * Valida e normaliza o output do subagente image-crop-reviewer.
 * Garante que o JSON tem o schema esperado antes de gravar.
 */
export function normalizeCropReviewResult(raw: unknown, edition: string): CropReviewResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("image-crop-reviewer output não é um objeto JSON");
  }
  const obj = raw as Record<string, unknown>;

  const rawResults = Array.isArray(obj.results) ? obj.results : [];
  const results: CropReviewEntry[] = rawResults
    .filter(
      (r): r is Record<string, unknown> =>
        !!r &&
        typeof r === "object" &&
        DESTAQUE_IDS.includes((r as Record<string, unknown>).destaque as DestaqueId) &&
        ((r as Record<string, unknown>).status === "ok" || (r as Record<string, unknown>).status === "warn"),
    )
    .map((r) => ({
      destaque: r.destaque as DestaqueId,
      status: r.status as CropReviewStatus,
      motivo: typeof r.motivo === "string" ? r.motivo : undefined,
      sugestao: typeof r.sugestao === "string" ? r.sugestao : undefined,
    }));

  const summary: CropReviewSummary = {
    total: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    warn: results.filter((r) => r.status === "warn").length,
  };

  return {
    edition,
    checked_at: typeof obj.checked_at === "string" ? obj.checked_at : new Date().toISOString(),
    results,
    summary,
  };
}

/**
 * Formata a seção do revisor de crop pro gate do Stage 4.
 * Warning-only: nunca inclui linguagem de bloqueio, sempre fecha com a nota
 * de que a decisão final é do editor (#3951).
 */
export function formatGateSummary(result: CropReviewResult): string {
  const { results, summary } = result;
  const lines: string[] = [];

  lines.push("━━━ REVISOR DE CROP (#3951) ━━━━━━━━━━━━━");

  if (summary.total === 0) {
    lines.push("  ℹ️  Nenhum destaque revisado (nenhuma imagem encontrada).");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    return lines.join("\n");
  }

  if (summary.warn === 0) {
    lines.push(`  ✅ ${summary.ok}/${summary.total} destaque(s) — crop 1:1 preserva o sentido da imagem.`);
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    return lines.join("\n");
  }

  lines.push(
    `  ${summary.warn} de ${summary.total} destaque(s) com aviso de crop — revisar antes de publicar:`,
  );
  lines.push("");
  for (const r of results.filter((r) => r.status === "warn")) {
    lines.push(`  ⚠️  ${r.destaque.toUpperCase()} — ${r.motivo ?? "crop 1:1 pode ter perdido o sentido da imagem original"}`);
    if (r.sugestao) lines.push(`       Sugestão: ${r.sugestao}`);
  }
  lines.push("");
  lines.push("  Decisão final é do editor. Aprovação no gate confirma revisão dos itens acima.");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function extractEditionId(editionDir: string): string {
  const parts = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "unknown";
}

async function main(): Promise<void> {
  const { values: args } = parseArgs(process.argv.slice(2));
  if (!args["edition-dir"]) {
    console.error("Uso: run-image-crop-reviewer.ts --edition-dir data/editions/AAMMDD/ [--input-json <path>]");
    process.exit(1);
  }

  const editionDir = resolve(process.cwd(), args["edition-dir"]);
  const edition = args.edition ?? extractEditionId(editionDir);
  const internalDir = join(editionDir, "_internal");
  const outPath = args.out ? resolve(process.cwd(), args.out) : join(internalDir, "04-crop-review.json");

  mkdirSync(internalDir, { recursive: true });

  // Modo --input-json: recebe o veredito do subagente, normaliza, grava e formata.
  if (args["input-json"]) {
    const inputPath = resolve(process.cwd(), args["input-json"]);
    if (!existsSync(inputPath)) {
      console.error(`[run-image-crop-reviewer] --input-json não encontrado: ${inputPath}`);
      process.exit(1);
    }
    const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
    const result = normalizeCropReviewResult(raw, edition);

    writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
    console.log(formatGateSummary(result));

    // Exit 0 sempre neste modo — warning-only (#3951, mesmo racional do
    // fact-checker #2468 finding 4): um exit != 0 aqui seria lido pelo
    // orchestrator como "revisor indisponível", escondendo os warnings do
    // editor em vez de mostrá-los no gate.
    return;
  }

  // Modo descoberta (default): escaneia o disco e imprime os pares encontrados
  // pro orchestrator montar a chamada Agent("image-crop-reviewer", {...}).
  const pairs = discoverCropPairs(editionDir);

  if (pairs.length === 0) {
    console.error(
      `[run-image-crop-reviewer] Nenhum par de imagem encontrado em ${editionDir} ` +
        `(esperava ao menos 04-d1-1x1.jpg). Rodar image-generate.ts antes.`,
    );
    process.exit(1);
  }

  console.log(JSON.stringify({ edition, pairs, out_path: outPath }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[run-image-crop-reviewer] ERRO:", e);
    process.exit(1);
  });
}
