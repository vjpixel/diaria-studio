/**
 * run-image-crop-reviewer.ts (#3951)
 *
 * Script de orquestração do subagente `image-crop-reviewer` no Stage 3.
 * Descobre os pares hero/crop (1:1 legado — `image-generate.ts` — e 4:5 card
 * de feed — `gen-social-card-4x5.ts`, #4223) gerados para os destaques
 * presentes na edição, prepara os parâmetros de dispatch do subagente, e —
 * depois do subagente rodar — normaliza/grava o veredito em
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
export type CropReviewRatio = "1x1" | "4x5";

/** Par de imagens descoberto no disco para um destaque, para um ratio específico. */
export interface CropPair {
  destaque: DestaqueId;
  /** Qual formato social este par representa (#4223). */
  ratio: CropReviewRatio;
  /**
   * Fonte usada para o crop/card final.
   * `ratio: "1x1"` → hero 2:1 original, `null` quando o destaque só tem 1:1 nativo (sem crop).
   * `ratio: "4x5"` → fonte que `gen-social-card-4x5.ts` de fato usou (nativa 4:5, master 6:5,
   * ou 2:1, nessa ordem de preferência), `null` apenas se nenhuma das 3 existir.
   */
  hero_path: string | null;
  /** Crop/card final — o que de fato vai pro social (Instagram/Facebook). */
  crop_path: string;
}

export interface CropReviewEntry {
  destaque: DestaqueId;
  ratio: CropReviewRatio;
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
 * Descobre os pares hero/crop presentes no disco para uma edição, um item por
 * (destaque, ratio) — até 2 por destaque quando ambos os formatos existem (#4223):
 *
 * - `ratio: "1x1"` (legado): crop = `04-{d}-1x1.jpg` (o que de fato vai pro
 *   social — sem ele não há nada pra revisar). Hero = `04-{d}-2x1.jpg`,
 *   opcional: ausente = destaque nativo 1:1 (gerado com `--ratio 1x1`, sem
 *   crop real) — nesse caso a checagem do subagente vira "está enquadrado e
 *   coerente?" em vez de comparação 2:1↔1:1 (ver `.claude/agents/image-crop-reviewer.md`).
 * - `ratio: "4x5"` (card de feed com título, #4114/#4090): crop = `04-{d}-4x5.jpg`
 *   (card final, já com título e gradiente compostos — o que de fato vai pro
 *   feed). Só emitido se este arquivo existir. Hero = a fonte que
 *   `gen-social-card-4x5.ts` de fato usou, na mesma ordem de fallback do
 *   script: `04-{d}-4x5-nativo.jpg` (arte nativa) → `04-{d}-master.jpg`
 *   (master 6:5) → `04-{d}-2x1.jpg` (legado). `null` só se nenhuma existir
 *   (defensivo — não deveria acontecer, geração do card já é bloqueante no
 *   Stage 3, #4090).
 *
 * Não assume destaque_count fixo — escaneia o disco diretamente (2 ou 3
 * destaques), consistente com o restante do Stage 3 (#2352/#3369).
 */
export function discoverCropPairs(editionDir: string): CropPair[] {
  const pairs: CropPair[] = [];
  for (const destaque of DESTAQUE_IDS) {
    const cropPath1x1 = join(editionDir, `04-${destaque}-1x1.jpg`);
    if (existsSync(cropPath1x1)) {
      const heroPath = join(editionDir, `04-${destaque}-2x1.jpg`);
      pairs.push({
        destaque,
        ratio: "1x1",
        hero_path: existsSync(heroPath) ? heroPath : null,
        crop_path: cropPath1x1,
      });
    }

    const cropPath4x5 = join(editionDir, `04-${destaque}-4x5.jpg`);
    if (existsSync(cropPath4x5)) {
      const heroCandidates4x5 = [
        join(editionDir, `04-${destaque}-4x5-nativo.jpg`),
        join(editionDir, `04-${destaque}-master.jpg`),
        join(editionDir, `04-${destaque}-2x1.jpg`),
      ];
      const heroPath4x5 = heroCandidates4x5.find((p) => existsSync(p)) ?? null;
      pairs.push({
        destaque,
        ratio: "4x5",
        hero_path: heroPath4x5,
        crop_path: cropPath4x5,
      });
    }
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
        ((r as Record<string, unknown>).ratio === "1x1" || (r as Record<string, unknown>).ratio === "4x5") &&
        ((r as Record<string, unknown>).status === "ok" || (r as Record<string, unknown>).status === "warn"),
    )
    .map((r) => ({
      destaque: r.destaque as DestaqueId,
      ratio: r.ratio as CropReviewRatio,
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
    lines.push(`  ✅ ${summary.ok}/${summary.total} destaque(s) — crop preserva o sentido da imagem.`);
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    return lines.join("\n");
  }

  lines.push(
    `  ${summary.warn} de ${summary.total} destaque(s) com aviso de crop — revisar antes de publicar:`,
  );
  lines.push("");
  for (const r of results.filter((r) => r.status === "warn")) {
    lines.push(
      `  ⚠️  ${r.destaque.toUpperCase()} (${r.ratio}) — ${r.motivo ?? "crop pode ter perdido o sentido da imagem original"}`,
    );
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
