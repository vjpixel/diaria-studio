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
 * Desde #8989, o mesmo dispatch também cobre um achado INDEPENDENTE do
 * crop: a imagem GERADA (hero e/ou crop final) saindo com um padrão de
 * espiral/redemoinho estilo Noite Estrelada, mesmo quando o TEXTO do prompt
 * não mencionava a obra nem o motivo visual (`lint-image-prompt.ts` só
 * analisa o prompt, nunca a imagem — #4201 cobriu só esse lado; #8989 é o
 * guard do lado da SAÍDA). Esses achados entram em `results` com
 * `categoria: "estilo"` (default `"crop"` quando ausente).
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
 *   # 3. (#10312) Plano de regeneração por Noite Estrelada (categoria "estilo"):
 *   npx tsx scripts/run-image-crop-reviewer.ts --edition-dir data/editions/AAMMDD/ --estilo-regen-plan
 *   # → JSON { regenerate, exhausted, attempts, commands } — o orchestrator roda
 *   #   `commands[dN]` e repete o revisor; teto MAX_ESTILO_AUTO_REGEN por destaque
 *   #   (só gasta quando a imagem mudou; falha do gerador ganha nova chance).
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
import { md5OfFile } from "./lib/shared/file-md5.ts"; // #9598
import { isCropReviewEntryStale } from "./lib/invariant-checks/stage-4.ts"; // #10312

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

/**
 * Categoria do achado (#8989). `"crop"` (default, retrocompatível) é o
 * julgamento original — o corte fonte→formato preservou o sujeito?
 * `"estilo"` é um julgamento INDEPENDENTE do crop: a imagem (hero OU crop,
 * o que estiver disponível) saiu com padrão de espiral/redemoinho estilo
 * Noite Estrelada — proibido pela regra invariável (CLAUDE.md, "Prompt de
 * imagem: ... SEM Noite Estrelada") mesmo quando o TEXTO do prompt não
 * mencionava a obra nem o motivo visual (`lint-image-prompt.ts` só analisa
 * o prompt, nunca a imagem gerada — #4201 cobriu só esse lado). Um mesmo
 * (destaque, ratio) pode ter até 2 entries: uma `"crop"` e uma `"estilo"`.
 */
export type CropReviewCategory = "crop" | "estilo";

export interface CropReviewEntry {
  destaque: DestaqueId;
  ratio: CropReviewRatio;
  status: CropReviewStatus;
  /** Default `"crop"` quando ausente/inválida — retrocompatível com output pré-#8989. */
  categoria?: CropReviewCategory;
  motivo?: string;
  sugestao?: string;
  /**
   * #9598: md5 de `04-{destaque}-{ratio}.jpg` no momento do persist
   * (`stampCropReviewImageHashes`). O invariante `image-crop-warn` descarta a
   * entrada quando o md5 atual diverge — imagem regerada/trocada depois da
   * revisão. Ausente = imagem não existia no persist, ou entrada pré-#9598.
   */
  image_md5?: string;
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
      // categoria ausente/inválida → "crop" (retrocompatível com output pré-#8989).
      categoria: r.categoria === "estilo" ? ("estilo" as const) : ("crop" as const),
      motivo: typeof r.motivo === "string" ? r.motivo : undefined,
      sugestao: typeof r.sugestao === "string" ? r.sugestao : undefined,
      // #10312: preservado pra que o plano de regeneração (que relê o arquivo
      // persistido) consiga descartar entrada desatualizada (#9598).
      ...(typeof r.image_md5 === "string" && /^[0-9a-f]{32}$/.test(r.image_md5)
        ? { image_md5: r.image_md5 }
        : {}),
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
 * #9598: carimba em cada entrada o md5 da imagem que ela revisou
 * (`04-{destaque}-{ratio}.jpg`, o mesmo `crop_path` de `discoverCropPairs`).
 * Sem esse carimbo, uma regeração/troca de imagem depois do Stage 3 deixava o
 * gate citando avisos da imagem antiga. Imagem ausente → entrada sem carimbo
 * (o invariante trata como legado, não como desatualizada).
 */
export function stampCropReviewImageHashes(result: CropReviewResult, editionDir: string): CropReviewResult {
  return {
    ...result,
    results: result.results.map((r) => {
      const imgPath = join(editionDir, `04-${r.destaque}-${r.ratio}.jpg`);
      if (!existsSync(imgPath)) return r;
      return { ...r, image_md5: md5OfFile(imgPath) };
    }),
  };
}

// ---------------------------------------------------------------------------
// #10312: regeneração automática quando o revisor acusa Noite Estrelada
// ---------------------------------------------------------------------------

/**
 * Quantas regenerações automáticas o Stage 3 faz por destaque quando o
 * revisor acusa `categoria: "estilo"`. Esgotado o teto, a imagem segue pro
 * gate, onde o invariante `image-starry-night-detected` (Stage 4) é ERRO.
 * 1 e não mais: cada tentativa custa 2 chamadas ao gerador (2:1 + 4:5) e o
 * prompt é o mesmo — se a 2ª geração repete o motivo, o problema é o prompt,
 * e quem reescreve prompt é o editor.
 */
export const MAX_ESTILO_AUTO_REGEN = 1;

/**
 * Quantas vezes um plano pode re-propor a regeneração de um destaque cuja
 * regeneração anterior NÃO mudou a imagem (gerador fora, cota, comando
 * falhou). Falha passageira ganha nova chance sem gastar a tentativa real;
 * o teto garante que o loop termina mesmo com o gerador fora de vez.
 */
export const MAX_ESTILO_REGEN_FAILED_RUNS = 1;

/** Estado persistido em `_internal/04-estilo-regen.json`. */
export interface EstiloRegenState {
  /** Regenerações que de fato rodaram (imagem mudou) por destaque. */
  attempts?: Partial<Record<DestaqueId, number>>;
  /** Regenerações propostas que não mudaram a imagem, por destaque. */
  failed?: Partial<Record<DestaqueId, number>>;
  /** Proposta em aberto: md5 por ratio de `04-{d}-{ratio}.jpg` no momento do plano. */
  pending?: Partial<Record<DestaqueId, Record<string, string | null>>>;
}

export interface EstiloRegenPlan {
  /** Destaques a regenerar agora (ficam em `state.pending` até o próximo plano). */
  regenerate: DestaqueId[];
  /** Destaques ainda com Noite Estrelada e sem tentativa sobrando — vão pro gate como erro. */
  exhausted: DestaqueId[];
  /** Regenerações efetivas por destaque (só conta a que mudou a imagem). */
  attempts: Partial<Record<DestaqueId, number>>;
  /** Estado a gravar de volta. */
  state: EstiloRegenState;
}

/** md5 atual de `04-{destaque}-{ratio}.jpg`, `null` se ausente. */
export type CurrentImageMd5 = (destaque: DestaqueId, ratio: string) => string | null;

/**
 * Decide quais destaques regenerar a partir do veredito do revisor (#10312).
 * Considera só entradas `status: "warn"` + `categoria: "estilo"` que não
 * estejam desatualizadas (`isStale`, md5 da imagem mudou depois da revisão —
 * #9598). Puro: o chamador grava `state` de volta.
 *
 * A tentativa só é gasta quando a regeneração de fato rodou: o plano anota o
 * md5 das imagens em `pending` e o plano seguinte compara com o md5 atual.
 * Imagem mudou → `attempts` +1. Não mudou (gerador falhou) → `failed` +1, e
 * o destaque ganha nova chance até `MAX_ESTILO_REGEN_FAILED_RUNS`.
 */
export function planEstiloRegeneration(
  result: CropReviewResult,
  previous: EstiloRegenState,
  isStale: (entry: CropReviewEntry) => boolean = () => false,
  currentMd5: CurrentImageMd5 = () => null,
  maxAttempts: number = MAX_ESTILO_AUTO_REGEN,
): EstiloRegenPlan {
  const attempts: Partial<Record<DestaqueId, number>> = { ...(previous.attempts ?? {}) };
  const failed: Partial<Record<DestaqueId, number>> = { ...(previous.failed ?? {}) };
  for (const d of DESTAQUE_IDS) {
    const snap = previous.pending?.[d];
    if (!snap) continue;
    const changed = Object.entries(snap).some(([ratio, md5]) => currentMd5(d, ratio) !== md5);
    if (changed) attempts[d] = (attempts[d] ?? 0) + 1;
    else failed[d] = (failed[d] ?? 0) + 1;
  }

  const flaggedRatios = new Map<DestaqueId, Set<string>>();
  for (const r of result.results) {
    if (r.status === "warn" && r.categoria === "estilo" && !isStale(r)) {
      flaggedRatios.set(r.destaque, (flaggedRatios.get(r.destaque) ?? new Set()).add(r.ratio));
    }
  }
  const pending: Partial<Record<DestaqueId, Record<string, string | null>>> = {};
  const regenerate: DestaqueId[] = [];
  const exhausted: DestaqueId[] = [];
  for (const d of DESTAQUE_IDS) {
    const ratios = flaggedRatios.get(d);
    if (!ratios) continue;
    if ((attempts[d] ?? 0) < maxAttempts && (failed[d] ?? 0) <= MAX_ESTILO_REGEN_FAILED_RUNS) {
      regenerate.push(d);
      pending[d] = Object.fromEntries([...ratios].map((ratio) => [ratio, currentMd5(d, ratio)]));
    } else {
      exhausted.push(d);
    }
  }
  return { regenerate, exhausted, attempts, state: { attempts, failed, pending } };
}

/**
 * Comandos que regeneram um destaque inteiro, NESTA ordem: 2:1 (+ 1:1
 * derivado; o `--force` do 2:1 apaga o 4:5 nativo antigo, #6010), arte 4:5
 * nativa, e o card 4:5 com título (que também é a capa do carrossel). `--force`
 * aqui é a exceção documentada ao #1325 — regeneração pedida pelo revisor,
 * não reentrada.
 */
export function estiloRegenCommands(editionDir: string, destaque: DestaqueId): string[] {
  const dir = editionDir.replace(/[/\\]+$/, "");
  const prompt = `${dir}/_internal/02-${destaque}-prompt.md`;
  return [
    `npx tsx scripts/image-generate.ts --editorial ${prompt} --out-dir ${dir}/ --destaque ${destaque} --force`,
    `npx tsx scripts/image-generate.ts --editorial ${prompt} --out-dir ${dir}/ --destaque ${destaque} --ratio 4x5 --force`,
    `npx tsx scripts/gen-social-card-4x5.ts --edition-dir ${dir}/ --destaque ${destaque}`,
  ];
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
    `  ${summary.warn} de ${summary.total} destaque(s) com aviso — revisar antes de publicar:`,
  );
  lines.push("");
  for (const r of results.filter((r) => r.status === "warn")) {
    // #8989: "estilo" é um achado de PADRÃO VISUAL PROIBIDO (espiral/Noite
    // Estrelada na imagem gerada), distinto de "crop" (sujeito perdido no
    // recorte). Ícone e rótulo diferentes pra o editor não confundir os dois.
    const isEstilo = r.categoria === "estilo";
    const icone = isEstilo ? "🌀" : "⚠️"; // #9041: sem espaço à direita — o template já separa
    const rotulo = isEstilo ? " [estilo — Noite Estrelada]" : "";
    const motivoDefault = isEstilo
      ? "padrão de espiral/redemoinho detectado na imagem gerada, estilo Noite Estrelada"
      : "crop pode ter perdido o sentido da imagem original";
    lines.push(
      `  ${icone} ${r.destaque.toUpperCase()} (${r.ratio})${rotulo} — ${r.motivo ?? motivoDefault}`,
    );
    if (r.sugestao) lines.push(`       Sugestão: ${r.sugestao}`);
  }
  lines.push("");
  if (results.some((r) => r.status === "warn" && r.categoria === "estilo")) {
    // #10312: Noite Estrelada deixou de ser decisão do editor — viola regra
    // invariável. O Stage 3 regenera sozinho; se persistir, é ERRO no gate.
    lines.push(
      "  🌀 Noite Estrelada viola regra invariável: o Stage 3 regenera o destaque sozinho " +
        `(até ${MAX_ESTILO_AUTO_REGEN}x, --estilo-regen-plan); se persistir, vira ERRO no gate (image-starry-night-detected, #10312).`,
    );
  }
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
  const { values: args, flags } = parseArgs(process.argv.slice(2));
  if (!args["edition-dir"]) {
    console.error("Uso: run-image-crop-reviewer.ts --edition-dir data/editions/AAMMDD/ [--input-json <path>]");
    process.exit(1);
  }

  const editionDir = resolve(process.cwd(), args["edition-dir"]);
  const edition = args.edition ?? extractEditionId(editionDir);
  const internalDir = join(editionDir, "_internal");
  const outPath = args.out ? resolve(process.cwd(), args.out) : join(internalDir, "04-crop-review.json");

  mkdirSync(internalDir, { recursive: true });

  // Modo --estilo-regen-plan (#10312): lê o veredito JÁ persistido e decide
  // quais destaques regenerar por Noite Estrelada. Grava
  // `_internal/04-estilo-regen.json` sempre (a presença do arquivo prova que o
  // plano rodou); a tentativa só é gasta quando a imagem de fato mudou.
  if (flags.has("estilo-regen-plan")) {
    if (!existsSync(outPath)) {
      console.error(`[run-image-crop-reviewer] veredito não encontrado: ${outPath} — persistir com --input-json antes.`);
      process.exit(1);
    }
    const persisted = normalizeCropReviewResult(JSON.parse(readFileSync(outPath, "utf8")) as unknown, edition);
    const attemptsPath = join(internalDir, "04-estilo-regen.json");
    let previous: EstiloRegenState = {};
    if (existsSync(attemptsPath)) {
      try {
        previous = JSON.parse(readFileSync(attemptsPath, "utf8")) as EstiloRegenState;
      } catch {
        previous = {};
      }
    }
    const currentMd5: CurrentImageMd5 = (d, ratio) => {
      const p = join(editionDir, `04-${d}-${ratio}.jpg`);
      return existsSync(p) ? md5OfFile(p) : null;
    };
    const plan = planEstiloRegeneration(persisted, previous, (e) => isCropReviewEntryStale(editionDir, e), currentMd5);
    writeFileSync(attemptsPath, JSON.stringify({ ...plan.state, updated_at: new Date().toISOString() }, null, 2), "utf8");
    const editionArg = args["edition-dir"].replace(/[/\\]+$/, "");
    console.log(
      JSON.stringify(
        {
          regenerate: plan.regenerate,
          exhausted: plan.exhausted,
          attempts: plan.attempts,
          commands: Object.fromEntries(plan.regenerate.map((d) => [d, estiloRegenCommands(editionArg, d)])),
        },
        null,
        2,
      ),
    );
    return;
  }

  // Modo --input-json: recebe o veredito do subagente, normaliza, grava e formata.
  if (args["input-json"]) {
    const inputPath = resolve(process.cwd(), args["input-json"]);
    if (!existsSync(inputPath)) {
      console.error(`[run-image-crop-reviewer] --input-json não encontrado: ${inputPath}`);
      process.exit(1);
    }
    const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
    const result = stampCropReviewImageHashes(normalizeCropReviewResult(raw, edition), editionDir);

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
