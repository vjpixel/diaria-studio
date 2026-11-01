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
 *   #   (só gasta quando a imagem mudou; falha do gerador ganha nova chance;
 *   #   a contagem zera quando a imagem atual é outra, ex: swap de destaque, #10327).
 *
 *   # 3b. (#10335) Arte trocada à mão (sem swap/reorder/promote, que já cuidam
 *   #     disso): zera o estado do plano da posição antes de re-revisar:
 *   npx tsx scripts/run-image-crop-reviewer.ts --edition-dir data/editions/AAMMDD/ --estilo-regen-reset d1[,d2]
 *
 *   # 4. (#10328) Falso positivo de Noite Estrelada — marca a imagem ATUAL do
 *   #    destaque (todos os ratios acusados, ou só `dN:4x5`), fora do veredito:
 *   npx tsx scripts/run-image-crop-reviewer.ts --edition-dir data/editions/AAMMDD/ --mark-false-positive d1[,d2:4x5]
 *
 *   # 5. (#11672) Re-revisão parcial — só os pares de dN (ou dN:1x1); o persist
 *   #    troca só as entradas desses alvos e mantém o resto do veredito:
 *   npx tsx scripts/run-image-crop-reviewer.ts --edition-dir data/editions/AAMMDD/ --only d3:1x1
 *   npx tsx scripts/run-image-crop-reviewer.ts --edition-dir data/editions/AAMMDD/ --only d3:1x1 --input-json <path>
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
import {
  isCropReviewEntryStale, // #10312
  isCropReviewImageVariant, // #10325
  CROP_REVIEW_IMAGE_VARIANTS, // #10333: ordem nativo → master → 2x1, fonte única
  type CropReviewImageVariant,
} from "./lib/invariant-checks/stage-4.ts";
import {
  addEstiloFalsePositives, // #10328
  readEstiloFalsePositiveMd5s,
  isEstiloFalsePositive,
} from "./lib/estilo-false-positives.ts";
import {
  ESTILO_REGEN_PER_DESTAQUE_KEYS, // #10335
  clearEstiloRegenDestaques,
  updateEstiloRegenStateFile,
} from "./lib/estilo-regen-state.ts";
import { resolveSquareSource } from "./lib/square-source-marker.ts"; // #11672

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
  /**
   * #10325: quando presente, `image_md5` é de `04-{destaque}-{image_variant}.jpg`
   * em vez de `04-{destaque}-{ratio}.jpg`. Usado no achado de estilo do 4:5,
   * que julga a arte de fundo — o card com título é recomposto sem arte nova.
   */
  image_variant?: CropReviewImageVariant;
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
      // #11672: 1:1 derivado do 4:5 nativo (`derive-square-from-native.ts`)
      // tem como fonte o nativo, não o 2:1 — o registro só vale enquanto o
      // md5 do 1:1 for o que a derivação gravou.
      const heroPath = resolveSquareSource(editionDir, destaque) ?? join(editionDir, `04-${destaque}-2x1.jpg`);
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
      ...(isCropReviewImageVariant(r.image_variant) ? { image_variant: r.image_variant } : {}),
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
      // Recarimbo: descarta carimbo/variante herdados do input antes de decidir de novo.
      const { image_md5: _md5, image_variant: _variant, ...base } = r;
      const variant = cropReviewStampVariant(editionDir, r.destaque, r.ratio, r.categoria);
      const imgPath = join(editionDir, `04-${r.destaque}-${variant ?? r.ratio}.jpg`);
      if (!existsSync(imgPath)) return base;
      return { ...base, image_md5: md5OfFile(imgPath), ...(variant ? { image_variant: variant } : {}) };
    }),
  };
}

/**
 * #10325: qual arquivo carimbar. O achado de estilo (Noite Estrelada) no 4:5
 * julga a ARTE de fundo: carimbar o card com título (`04-{d}-4x5.jpg`) fazia a
 * entrada virar "desatualizada" quando o editor mudava o título e o card era
 * recomposto sem arte nova — o erro `image-starry-night-detected` sumia e a
 * mesma Noite Estrelada ia pra capa do carrossel. Mesma ordem de fonte que o
 * `gen-social-card-4x5.ts` usa (`discoverCropPairs`): nativa → master → 2:1.
 * `null` = carimbar `04-{d}-{ratio}.jpg` (achado de crop, e o 1:1, cujo crop
 * é derivado determinístico do 2:1).
 */
export function cropReviewStampVariant(
  editionDir: string,
  destaque: DestaqueId,
  ratio: CropReviewRatio,
  categoria: CropReviewCategory | undefined,
): CropReviewImageVariant | null {
  if (categoria !== "estilo" || ratio !== "4x5") return null;
  return CROP_REVIEW_IMAGE_VARIANTS.find((v) => existsSync(join(editionDir, `04-${destaque}-${v}.jpg`))) ?? null;
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

/** Ratios revisados por destaque — os que `images` guarda após uma proposta (#10332). */
const ESTILO_REGEN_RATIOS: readonly CropReviewRatio[] = ["1x1", "4x5"];

/**
 * #10342: chave da base 2:1 para `CurrentImageMd5` — não é um ratio revisado,
 * mas `04-{d}-2x1.jpg` é o arquivo que o 1º comando de `estiloRegenCommands`
 * reescreve quando o gerador funciona.
 */
const BASE_RATIO = "2x1";

/** Estado persistido em `_internal/04-estilo-regen.json`. */
export interface EstiloRegenState {
  /** Regenerações que de fato rodaram (imagem mudou) por destaque. */
  attempts?: Partial<Record<DestaqueId, number>>;
  /** Regenerações propostas que não mudaram a imagem, por destaque. */
  failed?: Partial<Record<DestaqueId, number>>;
  /** Proposta em aberto: md5 por ratio da imagem julgada no momento do plano. */
  pending?: Partial<Record<DestaqueId, Record<string, string | null>>>;
  /**
   * #10342: md5 do 2:1 (`04-{d}-2x1.jpg`) no momento da proposta — a base que
   * o gerador reescreve. Decide "a regeneração rodou?" no plano seguinte. O
   * md5 por ratio de `pending` não serve sozinho: o 1º comando com `--force`
   * apaga o 4:5 nativo e o master ANTES de chamar o gerador (#6010), então com
   * o gerador fora o md5 do 4:5 muda só porque a variante resolvida passou de
   * `4x5-nativo` para `2x1` — sem imagem nova nenhuma.
   */
  pendingBase?: Partial<Record<DestaqueId, string | null>>;
  /**
   * #10335: md5 de TODOS os ratios revisados (`ESTILO_REGEN_RATIOS`) no momento
   * da proposta, não só dos acusados (`pending`). No plano seguinte, o md5
   * atual de um ratio só entra em `images` se for coerente com o desfecho:
   * regeneração rodou E aquele ratio mudou. Gerador falhou → nada novo é da
   * regeneração, e um arquivo diferente do snapshot foi trocado por outra
   * pessoa (não pode herdar a contagem).
   */
  pendingAll?: Partial<Record<DestaqueId, Record<string, string | null>>>;
  /**
   * #10327: md5s das imagens a que `attempts`/`failed` se referem (a anterior
   * e a regenerada). A contagem é por POSIÇÃO; quando a imagem atual do
   * destaque não é nenhuma destas (swap/promote no Stage 4), a contagem zera
   * em vez de declarar "esgotou" sobre uma imagem nunca regenerada.
   */
  images?: Partial<Record<DestaqueId, string[]>>;
}

/**
 * #10375: o que o orchestrator CONFIRMOU ter rodado com exit 0, por destaque.
 * `2x1` = 1º comando de `estiloRegenCommands` (reescreve o 2:1 e deriva o
 * 1:1); `4x5` = o 2º (`--ratio 4x5`, cria a arte `4x5-nativo`). O md5 só não
 * distingue "o gerador criou o 4x5-nativo" de "o editor trocou a arte" — este
 * registro por comando distingue.
 */
export type EstiloRegenRan = Partial<Record<DestaqueId, ReadonlySet<string> | readonly string[]>>;

/** Ratios revisados cujo md5 novo o comando `ran` explica. */
const RAN_COVERS: Record<string, readonly string[]> = { "2x1": ["1x1"], "4x5": ["4x5"] };

/** `"d1:2x1,d1:4x5"` → `EstiloRegenRan` (`--estilo-regen-ran`, #10375). Lança em entrada inválida. */
export function parseEstiloRegenRan(raw: string): EstiloRegenRan {
  const out: Partial<Record<DestaqueId, string[]>> = {};
  for (const tok of raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    const m = /^(d[123]):(2x1|4x5)$/.exec(tok);
    if (!m) throw new Error(`--estilo-regen-ran: token inválido "${tok}" (esperado d1:2x1, d2:4x5, ...)`);
    const d = m[1] as DestaqueId;
    out[d] = [...(out[d] ?? []), m[2]!];
  }
  return out;
}

/** `"d1,d3"` → destaques do `--estilo-regen-reset` (#10335). Lança em entrada inválida. */
export function parseEstiloRegenResetTargets(raw: string): DestaqueId[] {
  const out: DestaqueId[] = [];
  for (const tok of raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    if (!/^d[123]$/.test(tok)) throw new Error(`--estilo-regen-reset: destaque inválido "${tok}" (esperado d1, d2, d3)`);
    if (!out.includes(tok as DestaqueId)) out.push(tok as DestaqueId);
  }
  if (out.length === 0) throw new Error("--estilo-regen-reset: nenhum destaque");
  return out;
}

// #10335: todo campo por destaque do estado precisa estar na lista que o
// swap/reorder/promote/--estilo-regen-reset limpam ou remapeiam.
type _EstiloRegenKeysCovered =
  Exclude<keyof EstiloRegenState, (typeof ESTILO_REGEN_PER_DESTAQUE_KEYS)[number]> extends never ? true : never;
const _estiloRegenKeysCovered: _EstiloRegenKeysCovered = true;
void _estiloRegenKeysCovered;

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
 * o destaque ganha nova chance até `MAX_ESTILO_REGEN_FAILED_RUNS`. "Mudou" é
 * medido no 2:1 (`pendingBase`, #10342) quando ele existia no plano anterior.
 */
export function planEstiloRegeneration(
  result: CropReviewResult,
  previous: EstiloRegenState,
  isStale: (entry: CropReviewEntry) => boolean = () => false,
  currentMd5: CurrentImageMd5 = () => null,
  maxAttempts: number = MAX_ESTILO_AUTO_REGEN,
  ran: EstiloRegenRan = {},
): EstiloRegenPlan {
  const attempts: Partial<Record<DestaqueId, number>> = { ...(previous.attempts ?? {}) };
  const failed: Partial<Record<DestaqueId, number>> = { ...(previous.failed ?? {}) };
  const images: Partial<Record<DestaqueId, string[]>> = {};
  for (const d of DESTAQUE_IDS) {
    const prev = previous.images?.[d];
    if (Array.isArray(prev)) images[d] = prev.filter((m): m is string => typeof m === "string");
  }
  const remember = (d: DestaqueId, md5: string | null) => {
    if (md5 && !(images[d] ?? []).includes(md5)) images[d] = [...(images[d] ?? []), md5];
  };
  for (const d of DESTAQUE_IDS) {
    const snap = previous.pending?.[d];
    if (!snap) continue;
    for (const md5 of Object.values(snap)) remember(d, md5);
    // #10342: com o md5 do 2:1 gravado, só ele decide — 2:1 novo = o gerador
    // rodou. Sem ele (estado legado, ou 2:1 ausente no plano) cai na
    // comparação por ratio de antes.
    const base = previous.pendingBase?.[d];
    const changed =
      typeof base === "string"
        ? (() => {
            const now = currentMd5(d, BASE_RATIO);
            return now !== null && now !== base;
          })()
        : Object.entries(snap).some(([ratio, md5]) => currentMd5(d, ratio) !== md5);
    if (changed) attempts[d] = (attempts[d] ?? 0) + 1;
    else failed[d] = (failed[d] ?? 0) + 1;
    // #10332: guarda o md5 atual de TODOS os ratios, não só dos que estavam no
    // `pending`. A regeneração reescreve o destaque inteiro (2:1 → 1:1 e o 4:5
    // nativo), e o revisor pode acusar no plano seguinte um ratio diferente do
    // que estava pendente. Sem isso o reset do #10327 abaixo trata a própria
    // imagem regenerada como "outra imagem na mesma posição" e zera
    // `attempts`/`failed` — o teto some sempre que o ratio acusado alterna.
    const all = previous.pendingAll?.[d];
    if (all && typeof all === "object") {
      // #10335: com o snapshot de todos os ratios, só entra o md5 atual que a
      // regeneração explica — ela rodou (`changed`) e o ratio mudou. Com o
      // gerador fora, um ratio diferente do snapshot foi trocado por outra
      // pessoa (ex.: arte 4:5 nativa nova) e não herda a contagem. O 2:1 da
      // proposta também conta como imagem conhecida: com o 4:5 nativo apagado
      // pelo `--force` (#10342), o 4:5 resolve para esse mesmo 2:1.
      if (typeof base === "string") remember(d, base);
      for (const ratio of ESTILO_REGEN_RATIOS) {
        const before = typeof all[ratio] === "string" ? all[ratio] : null;
        remember(d, before);
        const now = currentMd5(d, ratio);
        // #10375: 2:1 falho + `--ratio 4x5` ok deixa `changed=false` com um
        // 4x5-nativo novo do gerador; o comando confirmado (`ran`) é o sinal
        // que o md5 sozinho não dá (arte trocada pelo editor não tem `ran`).
        const ranCovers = [...(ran[d] ?? [])].some((cmd) => RAN_COVERS[cmd]?.includes(ratio));
        if ((changed || ranCovers) && now !== before) remember(d, now);
      }
    } else {
      // Estado anterior ao #10335 (sem `pendingAll`): comportamento do #10332.
      for (const ratio of ESTILO_REGEN_RATIOS) remember(d, currentMd5(d, ratio));
    }
  }

  const flaggedRatios = new Map<DestaqueId, Set<string>>();
  for (const r of result.results) {
    if (r.status === "warn" && r.categoria === "estilo" && !isStale(r)) {
      flaggedRatios.set(r.destaque, (flaggedRatios.get(r.destaque) ?? new Set()).add(r.ratio));
    }
  }
  const pending: Partial<Record<DestaqueId, Record<string, string | null>>> = {};
  const pendingBase: Partial<Record<DestaqueId, string | null>> = {};
  const pendingAll: Partial<Record<DestaqueId, Record<string, string | null>>> = {};
  const regenerate: DestaqueId[] = [];
  const exhausted: DestaqueId[] = [];
  for (const d of DESTAQUE_IDS) {
    const ratios = flaggedRatios.get(d);
    if (!ratios) continue;
    // #10327: a imagem atual não é nem a anterior nem a regenerada → é outra
    // imagem na mesma posição, e a contagem antiga não vale pra ela. Estado
    // legado (sem `images`) mantém a contagem — sem como saber a que imagem
    // ela se referia.
    const known = images[d];
    const current = [...ratios].map((ratio) => currentMd5(d, ratio)).filter((m): m is string => !!m);
    if (known && known.length > 0 && current.length > 0 && !current.some((m) => known.includes(m))) {
      delete attempts[d];
      delete failed[d];
      delete images[d];
    }
    if ((attempts[d] ?? 0) < maxAttempts && (failed[d] ?? 0) <= MAX_ESTILO_REGEN_FAILED_RUNS) {
      regenerate.push(d);
      pending[d] = Object.fromEntries([...ratios].map((ratio) => [ratio, currentMd5(d, ratio)]));
      pendingBase[d] = currentMd5(d, BASE_RATIO);
      pendingAll[d] = Object.fromEntries(ESTILO_REGEN_RATIOS.map((ratio) => [ratio, currentMd5(d, ratio)]));
    } else {
      exhausted.push(d);
    }
  }
  return { regenerate, exhausted, attempts, state: { attempts, failed, pending, pendingBase, pendingAll, images } };
}

/**
 * Plano de regeneração por Noite Estrelada calculado sobre o estado em DISCO
 * (veredito persistido + `_internal/04-estilo-regen.json` + md5 das imagens
 * atuais), SEM gravar nada (#10346). É a mesma decisão do `--estilo-regen-plan`
 * — o CLI grava `plan.state` em seguida; o invariante
 * `image-starry-night-detected` (Stage 4) só lê, pra distinguir "esgotou de
 * fato" de "o plano nunca rodou para a imagem atual" (swap/promote no Stage 4,
 * #10327). `null` quando não há veredito persistido.
 */
export function planEstiloRegenerationForEdition(
  editionDir: string,
  opts: { verdictPath?: string; edition?: string; ran?: EstiloRegenRan } = {},
): EstiloRegenPlan | null {
  const verdictPath = opts.verdictPath ?? join(editionDir, "_internal", "04-crop-review.json");
  if (!existsSync(verdictPath)) return null;
  const persisted = normalizeCropReviewResult(
    JSON.parse(readFileSync(verdictPath, "utf8")) as unknown,
    opts.edition ?? extractEditionId(editionDir),
  );
  const attemptsPath = join(editionDir, "_internal", "04-estilo-regen.json");
  let previous: EstiloRegenState = {};
  if (existsSync(attemptsPath)) {
    try {
      previous = JSON.parse(readFileSync(attemptsPath, "utf8")) as EstiloRegenState;
    } catch {
      previous = {};
    }
  }
  // #10325: a mesma imagem que o persist carimba no achado de estilo (arte
  // nativa no 4:5) — `pending`/`images` e `image_md5` falam do mesmo arquivo.
  const currentMd5: CurrentImageMd5 = (d, ratio) => {
    const variant = cropReviewStampVariant(editionDir, d, ratio as CropReviewRatio, "estilo");
    const p = join(editionDir, `04-${d}-${variant ?? ratio}.jpg`);
    return existsSync(p) ? md5OfFile(p) : null;
  };
  // #10328: falso positivo marcado pelo editor não dispara regeneração.
  const falsePositives = readEstiloFalsePositiveMd5s(editionDir);
  return planEstiloRegeneration(
    persisted,
    previous,
    (e) => isEstiloFalsePositive(e, falsePositives) || isCropReviewEntryStale(editionDir, e),
    currentMd5,
    MAX_ESTILO_AUTO_REGEN,
    opts.ran,
  );
}

export interface FalsePositiveTarget {
  destaque: DestaqueId;
  /** `null` = todos os ratios acusados do destaque. */
  ratio: CropReviewRatio | null;
}

/** `"d1,d2:4x5"` → alvos do `--mark-false-positive` (#10328). Lança em entrada inválida. */
export function parseFalsePositiveTargets(raw: string): FalsePositiveTarget[] {
  const out: FalsePositiveTarget[] = [];
  for (const tok of raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    const m = /^(d[123])(?::(1x1|4x5))?$/.exec(tok);
    if (!m) throw new Error(`--mark-false-positive: alvo inválido "${tok}" (esperado d1, d2:4x5, ...)`);
    out.push({ destaque: m[1] as DestaqueId, ratio: (m[2] as CropReviewRatio | undefined) ?? null });
  }
  if (out.length === 0) throw new Error("--mark-false-positive: nenhum alvo");
  return out;
}

/**
 * Entradas de estilo ATUAIS (warn, carimbadas, não desatualizadas) que casam
 * com os alvos — o que `--mark-false-positive` grava (#10328).
 */
export function selectFalsePositiveMarks(
  result: CropReviewResult,
  targets: FalsePositiveTarget[],
  isStale: (entry: CropReviewEntry) => boolean,
): Array<{ image_md5: string; destaque: DestaqueId; ratio: CropReviewRatio }> {
  return result.results
    .filter(
      (r) =>
        r.status === "warn" &&
        r.categoria === "estilo" &&
        typeof r.image_md5 === "string" &&
        !isStale(r) &&
        targets.some((t) => t.destaque === r.destaque && (t.ratio === null || t.ratio === r.ratio)),
    )
    .map((r) => ({ image_md5: r.image_md5!, destaque: r.destaque, ratio: r.ratio }));
}

// ---------------------------------------------------------------------------
// #11672: re-revisão parcial (`--only dN[:ratio]`)
// ---------------------------------------------------------------------------

/** Alvo de `--only` — mesmo formato do `--mark-false-positive`. */
export type CropReviewTarget = FalsePositiveTarget;

/** `"d3:1x1,d1"` → alvos do `--only` (#11672). Lança em entrada inválida. */
export function parseOnlyTargets(raw: string): CropReviewTarget[] {
  const out: CropReviewTarget[] = [];
  for (const tok of raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    const m = /^(d[123])(?::(1x1|4x5))?$/.exec(tok);
    if (!m) throw new Error(`--only: alvo inválido "${tok}" (esperado d1, d3:1x1, ...)`);
    out.push({ destaque: m[1] as DestaqueId, ratio: (m[2] as CropReviewRatio | undefined) ?? null });
  }
  if (out.length === 0) throw new Error("--only: nenhum alvo");
  return out;
}

function matchesTargets(entry: { destaque: DestaqueId; ratio: CropReviewRatio }, targets: CropReviewTarget[]): boolean {
  return targets.some((t) => t.destaque === entry.destaque && (t.ratio === null || t.ratio === entry.ratio));
}

/** Pares da descoberta restritos aos alvos do `--only`. */
export function filterPairsByTargets(pairs: CropPair[], targets: CropReviewTarget[]): CropPair[] {
  return pairs.filter((p) => matchesTargets(p, targets));
}

/**
 * Junta o veredito novo de uma re-revisão parcial ao veredito persistido
 * (#11672): as entradas dos alvos são trocadas pelas novas, as demais ficam
 * como estavam, com o carimbo de md5 original. Recarimbar as antigas faria um
 * aviso de imagem já trocada parecer atual (#9598). Entradas novas fora dos
 * alvos são descartadas: só os alvos foram revisados de propósito. Pure.
 */
export function mergeCropReviewResults(
  existing: CropReviewResult | null,
  incoming: CropReviewResult,
  targets: CropReviewTarget[],
): CropReviewResult {
  const kept = (existing?.results ?? []).filter((r) => !matchesTargets(r, targets));
  const fresh = incoming.results.filter((r) => matchesTargets(r, targets));
  const results = [...kept, ...fresh];
  return {
    edition: incoming.edition,
    checked_at: incoming.checked_at,
    results,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.status === "ok").length,
      warn: results.filter((r) => r.status === "warn").length,
    },
  };
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

  // #11672: `--only dN[:ratio]` restringe a descoberta aos alvos e faz o
  // persist (--input-json) trocar só as entradas deles no veredito.
  let onlyTargets: CropReviewTarget[] | null = null;
  if (args.only) {
    try {
      onlyTargets = parseOnlyTargets(args.only);
    } catch (e) {
      console.error(`[run-image-crop-reviewer] ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // Modo --estilo-regen-plan (#10312): lê o veredito JÁ persistido e decide
  // quais destaques regenerar por Noite Estrelada. Grava
  // `_internal/04-estilo-regen.json` sempre (a presença do arquivo prova que o
  // plano rodou); a tentativa só é gasta quando a imagem de fato mudou.
  // Modo --estilo-regen-reset (#10335): o editor trocou a arte de um destaque
  // à mão (arquivo novo, sem swap/reorder/promote). Zera o estado do plano
  // daquela posição — o `pending` da arte antiga julgaria a nova como regerada.
  if (args["estilo-regen-reset"]) {
    let targets: DestaqueId[];
    try {
      targets = parseEstiloRegenResetTargets(args["estilo-regen-reset"]);
    } catch (e) {
      console.error(`[run-image-crop-reviewer] ${(e as Error).message}`);
      process.exit(1);
    }
    const r = updateEstiloRegenStateFile(internalDir, (d) => clearEstiloRegenDestaques(d, targets));
    if (r.warning) {
      console.error(`[run-image-crop-reviewer] ${r.warning}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ reset: targets, rewritten: r.rewritten }, null, 2));
    return;
  }

  if (flags.has("estilo-regen-plan")) {
    let ran: EstiloRegenRan = {};
    if (args["estilo-regen-ran"]) {
      try {
        ran = parseEstiloRegenRan(args["estilo-regen-ran"]);
      } catch (e) {
        console.error(`[run-image-crop-reviewer] ${(e as Error).message}`);
        process.exit(1);
      }
    }
    const plan = planEstiloRegenerationForEdition(editionDir, { verdictPath: outPath, edition, ran });
    if (!plan) {
      console.error(`[run-image-crop-reviewer] veredito não encontrado: ${outPath} — persistir com --input-json antes.`);
      process.exit(1);
    }
    const attemptsPath = join(internalDir, "04-estilo-regen.json");
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

  // Modo --mark-false-positive (#10328): grava a marcação fora do veredito,
  // chaveada pelo md5 da imagem julgada — o persist do revisor reescreve
  // `04-crop-review.json` inteiro, então um `status: "ok"` manual ali se perdia.
  if (args["mark-false-positive"]) {
    if (!existsSync(outPath)) {
      console.error(`[run-image-crop-reviewer] veredito não encontrado: ${outPath}`);
      process.exit(1);
    }
    const persisted = normalizeCropReviewResult(JSON.parse(readFileSync(outPath, "utf8")) as unknown, edition);
    let targets: FalsePositiveTarget[];
    try {
      targets = parseFalsePositiveTargets(args["mark-false-positive"]);
    } catch (e) {
      console.error(`[run-image-crop-reviewer] ${(e as Error).message}`);
      process.exit(1);
    }
    const marks = selectFalsePositiveMarks(persisted, targets, (e) => isCropReviewEntryStale(editionDir, e));
    if (marks.length === 0) {
      console.error(
        `[run-image-crop-reviewer] nenhum achado de Noite Estrelada ATUAL (warn + estilo, carimbado com a imagem em disco) ` +
          `para "${args["mark-false-positive"]}" em ${outPath} — nada a marcar.`,
      );
      process.exit(1);
    }
    const added = addEstiloFalsePositives(editionDir, marks);
    console.log(JSON.stringify({ marked: marks, added }, null, 2));
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
    const stamped = stampCropReviewImageHashes(normalizeCropReviewResult(raw, edition), editionDir);
    let result = stamped;
    if (onlyTargets) {
      // Veredito persistido ilegível não pode ser apagado em silêncio por um
      // persist parcial: sai 1 e o orchestrator refaz a revisão completa.
      let existing: CropReviewResult | null = null;
      if (existsSync(outPath)) {
        try {
          existing = normalizeCropReviewResult(JSON.parse(readFileSync(outPath, "utf8")) as unknown, edition);
        } catch (e) {
          console.error(
            `[run-image-crop-reviewer] --only: veredito persistido ilegível (${outPath}): ${(e as Error).message} — ` +
              `rodar a revisão completa (sem --only).`,
          );
          process.exit(1);
        }
      }
      result = mergeCropReviewResults(existing, stamped, onlyTargets);
    }

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
  const allPairs = discoverCropPairs(editionDir);
  const pairs = onlyTargets ? filterPairsByTargets(allPairs, onlyTargets) : allPairs;

  if (pairs.length === 0) {
    console.error(
      onlyTargets
        ? `[run-image-crop-reviewer] Nenhum par de imagem para --only ${args.only} em ${editionDir}.`
        : `[run-image-crop-reviewer] Nenhum par de imagem encontrado em ${editionDir} ` +
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
