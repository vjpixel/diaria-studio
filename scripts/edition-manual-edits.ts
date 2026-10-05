#!/usr/bin/env tsx
/**
 * edition-manual-edits.ts (#9357)
 *
 * Métrica determinística da definição de feito da épica #7972: **edições
 * sem nenhuma modificação manual do editor**. Pra cada edição, compara o
 * que a pipeline entregou com o que saiu, por gate, descontando as
 * mutações da própria pipeline (tabela em `lib/manual-edit-diff.ts`), e
 * devolve `zero_manual_edits` + a lista do que mudou.
 *
 * | Gate | Comparação | Conta como modificação |
 * |---|---|---|
 * | `stage1` | `01-categorized.json` × `01-approved.json` | no gate humano do Stage 1: destaque trocado/promovido/cortado e pool; depois do Stage 2: item de pool cortado/adicionado/movido |
 * | `destaques` | destaques da saída da pipeline (baseline da newsletter, ou `02-draft.md`) × `02-reviewed.md`, POR URL | `destaque-swap`/`-cut`/`-promote`, e `destaque-reorder` (ordem relativa dos mantidos mudou) |
 * | `newsletter` | baseline (snapshot `stage2-post-gate` ou reconstruído) × `02-reviewed.md` | qualquer linha de texto adicionada/removida, por seção |
 * | `titles` | `02-title-picks.json` (escolha do `title-picker`, ligada ao destaque pela URL) × título final | destaque MANTIDO com título ≠ o escolhido pela pipeline, ou poda manual (sem pick) |
 * | `social` | snapshot `stage2-post-gate/03-social.md` × `03-social.md` | qualquer linha de texto |
 * | `images` | mtime das artes × `completed_at` do sentinel do Stage 3 | arte/recorte regerado depois do Stage 3 de destaque mantido na mesma posição |
 *
 * **Destaques por URL (#9647).** Até aqui destaque, título e arte eram
 * comparados POR POSIÇÃO (D1 com D1): reordenar virava "título" e "imagem",
 * e a troca era lida de `01-approved.json`, que nem sempre é regravado no
 * Stage 4 (260917, 260918) e carrega o recorte da própria pipeline
 * (`apply-gate-edits`, `itens_movidos > 0` sob auto-aprovação — 260916,
 * 260929). Agora a referência é o texto que a pipeline entregou (já depois
 * do recorte), casado por URL (URL corrigida da mesma página — mesmo host e
 * slug — é o mesmo destaque). Título e arte de destaque trocado ou mudado de
 * posição são CASCATA: vão pra `cascades` do gate, fora da contagem.
 *
 * `zero_manual_edits`:
 * - `false` — algum gate medido tem mudança;
 * - `true` — todos os gates medidos e nenhum com mudança;
 * - `null` — nenhuma mudança achada, mas algum gate não pôde ser medido
 *   (ex.: social de edição sem baseline confiável — a saída da pipeline pro
 *   social não fica em arquivo nenhum antes do #9356). `null` interrompe a
 *   contagem de "edições consecutivas sem modificação": não dá pra afirmar.
 *
 * **Baseline (#9356).** Edição com snapshot carimbado (`.capture.json`,
 * gravado pelo sentinel do Stage 2) usa o snapshot. Edição anterior a isso
 * usa o baseline RECONSTRUÍDO a partir de `02-humanized.md`/
 * `02-clarice-corrected.md` — aproximação, rotulada `baseline:
 * "reconstructed"` na saída, e o social fica `unmeasured`.
 *
 * **Cortes não contam, por padrão (#9641).** Decisão do editor de
 * 01/10/2026 na #7972 (comentário "Meta de 10 itens"): enquanto a pipeline
 * entrega mais de 10 itens DE PROPÓSITO, cortar até 10 não é modificação
 * manual. Corte = item do pool presente na saída da pipeline cuja URL não
 * aparece no final (`findCutItems` em `lib/manual-edit-diff.ts`). Ele sai de
 * `manual_edit_count`/`zero_manual_edits` nos dois gates que o enxergam:
 * `stage1` (`pool-cut`) e `newsletter` (o bloco do item sai do baseline antes
 * do `diffBySection`, senão a seção apareceria como `+0/-N`). Os cortes vão
 * pra `cuts`, à parte. Item que MUDA de seção (ou vira destaque) não é corte e
 * segue contando. `--count-cuts` (`countCuts` em
 * `computeEditionManualEdits`) religa a contagem — é a definição de feito
 * FINAL da #7972, pra quando a pipeline passar a entregar exatamente 10.
 *
 * **Inclusões (#9641).** Item do final (por URL) que não estava na saída da
 * pipeline vai pra `inclusions` — meta intermediária da #7972: zero
 * inclusões de forma sustentada. Inclusão continua contando como modificação
 * (aparece no diff de texto); a lista é o contador. Troca de URL da mesma
 * história conta como inclusão (premissa: a URL é a identidade do item).
 * Sumário: sequência atual sem modificação, sequência atual sem inclusão e
 * média de inclusões nas últimas 10 edições.
 *
 * Somente leitura: nunca escreve em `data/`.
 *
 * Uso:
 *   npx tsx scripts/edition-manual-edits.ts                     # todas as edições com Stage 4 concluído
 *   npx tsx scripts/edition-manual-edits.ts --edition 260930
 *   npx tsx scripts/edition-manual-edits.ts --from 260914 --to 261001 --json
 *   [--editions-dir data/editions] [--count-cuts]
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { armFromProfile, type Arm, type Tri } from "./lib/jev-ab-report.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import {
  STAGE2_BASELINE_LABEL,
  STAGE2_SNAPSHOT_FILES,
  assessStage2BaselineOnDisk,
  readSnapshots,
  type BaselineHealth,
} from "./lib/editor-request-snapshots.ts";
import {
  applyAutofixReplacements,
  applyIntentionalError,
  diffBySection,
  extractDestaques,
  extractNewsletterItems,
  findCutItems,
  findIncludedItems,
  destaqueUrlKey,
  matchDestaquesByUrl,
  normalizeItemUrl,
  normalizeNewsletterForComparison,
  normalizeSelfUrls,
  removeCutItemBlocks,
  sectionNames,
  type DestaqueEntry,
  type DestaqueMatch,
} from "./lib/manual-edit-diff.ts";
import {
  buildReconstructedNewsletterBaseline,
  classifyPoolDiff,
  classifyStage1DestaqueDiff,
  findPipelineNewsletterOutput,
  readAppliedAutofixes,
  readIntentionalError,
  readTitlePicks,
} from "./derive-editor-requests.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** #9641: janela da média de inclusões. */
export const INCLUSIONS_WINDOW = 10;

/** #9641: meta da #7972 — edições consecutivas sem modificação. */
export const STREAK_GOAL = 3;

/** Margem entre o sentinel do Stage 3 e o mtime de uma arte "da própria pipeline". */
const IMAGE_MTIME_TOLERANCE_MS = 2 * 60 * 1000;

export interface ManualChange {
  kind: string;
  detail: string;
  /** URL do item, quando a mudança é sobre um item (ex.: `pool-cut`). */
  url?: string;
}

export interface GateResult {
  status: "measured" | "unmeasured";
  /** De onde veio a referência (quando medido). */
  baseline?: "snapshot" | "reconstructed" | "draft" | "categorized" | "title-picks" | "stage3-sentinel";
  changes: ManualChange[];
  /**
   * #9647: mudança que é consequência de outra já contada (título/arte de
   * destaque trocado ou mudado de posição). Fica fora de `changes`.
   */
  cascades?: ManualChange[];
  /** #9641: cortes vistos por este gate e tirados de `changes` (só sem `countCuts`). */
  cuts?: ManualChange[];
  note?: string;
}

/** Item da newsletter identificado por URL (#9641). */
export interface EditionItem {
  url: string;
  title: string;
  section: string;
}

export interface ManualEditsOptions {
  /**
   * #9641: `true` volta a contar cortes como modificação (definição de feito
   * FINAL da #7972). Default `false` — decisão do editor de 01/10/2026 na
   * #7972: enquanto a pipeline entrega >10 itens de propósito, cortar até 10
   * não conta.
   */
  countCuts?: boolean;
}

export type GateName = "stage1" | "destaques" | "newsletter" | "titles" | "social" | "images";

export interface EditionManualEdits {
  edition: string;
  /**
   * #9374: braço do A/B do Jev (`A` = `/diaria-edicao`, `B` =
   * `/diaria-edicao-jev`, `unknown` = marcador ilegível) — mesmo critério do
   * `jev-ab-report.ts`. Sem estratificar, a série mistura dois comportamentos
   * de seleção.
   */
  arm: Arm;
  baseline_status: BaselineHealth["status"];
  gates: Record<GateName, GateResult>;
  manual_edit_count: number;
  zero_manual_edits: boolean | null;
  /** #9641: se os cortes entraram na contagem (`--count-cuts`). */
  cuts_counted: boolean;
  /** #9641: itens do pool cortados (por URL), fora da contagem por padrão. */
  cuts: EditionItem[];
  /**
   * #9641: itens do final (por URL) ausentes da saída da pipeline. `null` =
   * newsletter não medida (sem baseline) — interrompe a sequência de zero
   * inclusões, como `null` em `zero_manual_edits`.
   */
  inclusions: EditionItem[] | null;
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function unmeasured(note: string): GateResult {
  return { status: "unmeasured", changes: [], note };
}

/** `zero_manual_edits` a partir dos gates. Pura. */
export function decideZeroManualEdits(gates: Record<GateName, GateResult>): boolean | null {
  const all = Object.values(gates);
  if (all.some((g) => g.status === "measured" && g.changes.length > 0)) return false;
  if (all.some((g) => g.status === "unmeasured")) return null;
  return true;
}

/**
 * #9641: sem `countCuts`, os `pool-cut` saem de `changes` e vão pra `cuts`.
 * `pool-cut` já exclui item que virou destaque e troca de link da mesma
 * história (`classifyPoolDiff`), então só sobra corte de fato.
 */
function splitCuts(gate: GateResult, countCuts: boolean): GateResult {
  if (countCuts || gate.status !== "measured") return gate;
  const cuts = gate.changes.filter((c) => c.kind === "pool-cut");
  if (cuts.length === 0) return gate;
  return { ...gate, changes: gate.changes.filter((c) => c.kind !== "pool-cut"), cuts };
}

function stage1Gate(
  editionDir: string,
  health: BaselineHealth,
  snapshotApproved: string | undefined,
  pipelineDestaques: readonly DestaqueEntry[] | null,
  countCuts: boolean,
): GateResult {
  return splitCuts(stage1GateRaw(editionDir, health, snapshotApproved, pipelineDestaques), countCuts);
}

/**
 * Gate do Stage 1: só o que o EDITOR decidiu na seleção — destaques e pool no
 * gate humano do Stage 1, e movimentações do pool depois do Stage 2.
 *
 * #9647: troca de destaque depois do Stage 2 NÃO é medida aqui — sai do gate
 * `destaques` (saída da pipeline × final, por URL). `01-approved.json` nem
 * sempre é regravado numa troca do Stage 4 (260917, 260918), e o recorte da
 * pipeline (`apply-gate-edits`, `itens_movidos > 0` sob auto-aprovação,
 * #4943) apareceria como troca (260916, 260929).
 */
function stage1GateRaw(
  editionDir: string,
  health: BaselineHealth,
  snapshotApproved: string | undefined,
  pipelineDestaques: readonly DestaqueEntry[] | null,
): GateResult {
  const categorized = readJson(join(editionDir, "_internal", "01-categorized.json"));
  const approvedRaw = existsSync(join(editionDir, "_internal", "01-approved.json"))
    ? readFileSync(join(editionDir, "_internal", "01-approved.json"), "utf8")
    : null;
  if (!categorized || approvedRaw === null) return unmeasured("01-categorized.json ou 01-approved.json ausente");
  let approved: any;
  try {
    approved = JSON.parse(approvedRaw);
  } catch {
    return unmeasured("01-approved.json malformado");
  }
  const gate = readJson(join(editionDir, "_internal", ".step-1-gate.json"));
  const humanGate = gate?.auto_approved === false;
  const changes: ManualChange[] = [];
  const toChanges = (entries: Array<{ request_type: string; description: string; context?: Record<string, unknown> }>): ManualChange[] =>
    entries.map((e) => {
      const url = e.context?.url;
      return typeof url === "string" ? { kind: e.request_type, detail: e.description, url } : { kind: e.request_type, detail: e.description };
    });

  if (health.status === "ok" && snapshotApproved !== undefined) {
    let atStage2: any = null;
    try {
      atStage2 = JSON.parse(snapshotApproved);
    } catch {
      /* cai no aprovado final abaixo */
    }
    // Gate humano do Stage 1: categorizado × aprovado no fim do Stage 2.
    if (humanGate) {
      const ref = atStage2 ?? approved;
      changes.push(...toChanges(classifyStage1DestaqueDiff(categorized, ref)), ...toChanges(classifyPoolDiff(categorized, ref)));
    }
    // Movimentações do POOL depois do Stage 2 (destaques: gate `destaques`).
    if (atStage2) changes.push(...toChanges(classifyPoolDiff(atStage2, approved)));
    return { status: "measured", baseline: "snapshot", changes };
  }

  // Sem baseline confiável. Sob auto-aprovação não há decisão do editor no
  // Stage 1; o recorte top-3 do `apply-gate-edits` é da pipeline e as trocas
  // posteriores saem do gate `destaques`. Gate humano: os destaques que
  // chegaram ao texto do Stage 2 são a escolha do editor (o aprovado FINAL
  // misturaria as trocas do Stage 4, contadas de novo em `destaques`).
  // Sem texto da pipeline, o gate `destaques` cai no categorizado × aprovado
  // final (`destaquesFallback`) e já cobre os destaques.
  if (humanGate) {
    if (pipelineDestaques) {
      const ref = { highlights: pipelineDestaques.map((d) => ({ url: d.url, title: d.title })) };
      changes.push(...toChanges(classifyStage1DestaqueDiff(categorized, ref)));
    }
    changes.push(...toChanges(classifyPoolDiff(categorized, approved)));
  }
  return {
    status: "measured",
    baseline: "categorized",
    changes,
    note: humanGate ? undefined : "auto-aprovado sem baseline: nada do editor no Stage 1 (trocas de destaque: gate destaques)",
  };
}

/**
 * #9647: destaques da saída da pipeline × final, POR URL. Troca, corte,
 * promoção e reordenação (`destaque-reorder`: ordem relativa dos mantidos).
 */
function destaquesGate(
  editionDir: string,
  pipeline: { destaques: readonly DestaqueEntry[]; source: "snapshot" | "reconstructed" | "draft" } | null,
  finalDestaques: readonly DestaqueEntry[],
  match: DestaqueMatch | null,
): GateResult {
  if (pipeline === null || match === null) return destaquesFallback(editionDir);
  if (finalDestaques.length === 0) return unmeasured("nenhum destaque encontrado em 02-reviewed.md");
  const changes: ManualChange[] = [
    ...match.swaps.map((s) => ({
      kind: "destaque-swap",
      detail: `D${s.out.position} "${s.out.title}" → D${s.in.position} "${s.in.title}"`,
      url: s.in.url,
    })),
    ...match.cuts.map((d) => ({ kind: "destaque-cut", detail: `D${d.position} removido: "${d.title}"`, url: d.url })),
    ...match.promotes.map((d) => ({ kind: "destaque-promote", detail: `D${d.position} promovido: "${d.title}"`, url: d.url })),
    ...match.reorders.map((r) => ({ kind: "destaque-reorder", detail: `"${r.entry.title}" D${r.from} → D${r.to}`, url: r.entry.url })),
  ];
  return { status: "measured", baseline: pipeline.source, changes };
}

/**
 * Edição sem texto da pipeline legível (formato antigo, sem `**DESTAQUE N**`):
 * categorizado × aprovado final, como antes do #9647 — inclui o recorte da
 * pipeline e perde troca sem `01-approved.json` regravado, por isso rotulado
 * `categorized`. Sem os dois JSONs, não medido.
 */
function destaquesFallback(editionDir: string): GateResult {
  const categorized = readJson(join(editionDir, "_internal", "01-categorized.json"));
  const approved = readJson(join(editionDir, "_internal", "01-approved.json"));
  if (!categorized || !approved) return unmeasured("sem saída da pipeline da newsletter nem 01-categorized/01-approved");
  return {
    status: "measured",
    baseline: "categorized",
    changes: classifyStage1DestaqueDiff(categorized, approved).map((e) => ({ kind: e.request_type, detail: e.description })),
    note: "sem texto da pipeline: categorizado × aprovado final (aproximação anterior ao #9647)",
  };
}

interface NewsletterMeasurement {
  gate: GateResult;
  cuts: EditionItem[];
  inclusions: EditionItem[] | null;
}

/**
 * Newsletter + itens por URL (#9641). Cortes saem do baseline antes do diff
 * (sem `countCuts`); inclusões = itens do final fora de `pipelineUrls` (os
 * itens do baseline, menos o que o editor incluiu num gate humano do Stage 1).
 */
function newsletterGate(
  raw: { baseline: string; source: "snapshot" | "reconstructed" } | null,
  finalMd: string,
  opts: { countCuts: boolean; stage1EditorAddedUrls: ReadonlySet<string> },
): NewsletterMeasurement {
  if (raw === null) {
    return { gate: unmeasured("sem snapshot confiável nem arquivo da pipeline (02-humanized/02-clarice-corrected)"), cuts: [], inclusions: null };
  }
  const final = normalizeNewsletterForComparison(finalMd);
  const cutItems = findCutItems(raw.baseline, final);
  const pipelineUrls = new Set(
    extractNewsletterItems(raw.baseline)
      .map((it) => normalizeItemUrl(it.url))
      .filter((u) => !opts.stage1EditorAddedUrls.has(u)),
  );
  const inclusions = findIncludedItems(final, pipelineUrls);
  const baseline = opts.countCuts
    ? raw.baseline
    : removeCutItemBlocks(raw.baseline, new Set(cutItems.map((c) => c.url)), sectionNames(final));
  const changes = diffBySection(baseline, final).map((c) => ({
    kind: "text-edit",
    detail: `${c.section}: +${c.added}/-${c.removed}${c.sample_added[0] ? ` (ex.: "${c.sample_added[0]}")` : ""}`,
  }));
  const cutChanges = cutItems.map((c) => ({ kind: "item-cut", detail: `${c.section}: ${c.title}`, url: c.url }));
  return {
    gate: {
      status: "measured",
      baseline: raw.source,
      changes,
      ...(opts.countCuts || cutChanges.length === 0 ? {} : { cuts: cutChanges }),
    },
    cuts: cutItems,
    inclusions,
  };
}

/** Baseline NORMALIZADO da newsletter (snapshot ou reconstruído), ou `null`. */
function newsletterBaseline(
  editionDir: string,
  health: BaselineHealth,
  snapshotMd: string | undefined,
  finalMd: string,
): { baseline: string; source: "snapshot" | "reconstructed" } | null {
  let baseline: string | null;
  let source: "snapshot" | "reconstructed";
  if (health.status === "ok" && snapshotMd !== undefined) {
    source = "snapshot";
    const withPipelineMutations = applyIntentionalError(
      applyAutofixReplacements(snapshotMd, readAppliedAutofixes(editionDir), "newsletter"),
      finalMd,
      readIntentionalError(editionDir),
    );
    baseline = normalizeNewsletterForComparison(withPipelineMutations);
  } else {
    source = "reconstructed";
    baseline = buildReconstructedNewsletterBaseline(editionDir, finalMd);
  }
  return baseline === null ? null : { baseline, source };
}

/** Pick do title-picker com a URL do destaque a que ele se refere (#9647). */
interface ResolvedPick {
  destaque: number;
  chosen: string;
  /** URL do destaque da pipeline cujas opções contêm `chosen` (ou o da mesma posição); `null` sem saída da pipeline. */
  url: string | null;
}

/**
 * Liga cada pick do `title-picker` à URL do destaque: o destaque da saída da
 * pipeline cujas opções de título contêm o escolhido; sem casamento, o da
 * mesma posição na saída da pipeline. Pura.
 */
export function resolvePickUrls(
  picks: ReadonlyArray<{ destaque: number; chosen: string }>,
  pipelineOptions: readonly DestaqueEntry[],
  pipelineDestaques: readonly DestaqueEntry[],
): ResolvedPick[] {
  return picks.map((p) => {
    const byTitle = pipelineOptions.find((d) => d.titleOptions.some((t) => t.trim() === p.chosen.trim()));
    const byPosition = pipelineOptions.find((d) => d.position === p.destaque) ?? pipelineDestaques.find((d) => d.position === p.destaque);
    return { destaque: p.destaque, chosen: p.chosen, url: (byTitle ?? byPosition)?.url ?? null };
  });
}

/** Saída do writer com as 3 opções de título (pra casar os picks e contar opções). */
function readPipelineTitleOptions(editionDir: string): DestaqueEntry[] {
  const candidates = [findPipelineNewsletterOutput(editionDir), join(editionDir, "_internal", "02-draft.md")];
  for (const p of candidates) {
    if (p && existsSync(p)) {
      const ds = extractDestaques(readFileSync(p, "utf8"));
      if (ds.length > 0) return ds;
    }
  }
  return [];
}

/**
 * Títulos (#9647): só destaque MANTIDO (mesma URL da saída da pipeline) conta,
 * e o pick comparado é o daquele destaque, não o da posição. Destaque novo
 * (troca) tem título novo por construção — vai pra `cascades`.
 */
function titlesGate(
  editionDir: string,
  finalDestaques: readonly DestaqueEntry[],
  pipelineDestaques: readonly DestaqueEntry[] | null,
  match: DestaqueMatch | null,
): GateResult {
  if (finalDestaques.length === 0) return unmeasured("nenhum destaque encontrado em 02-reviewed.md");
  const options = readPipelineTitleOptions(editionDir);
  const picks = resolvePickUrls(readTitlePicks(editionDir), options, pipelineDestaques ?? []);
  const changes: ManualChange[] = [];
  const cascades: ManualChange[] = [];
  for (const d of finalDestaques) {
    const n = d.position;
    if (match?.statusByFinalPosition.get(n) === "new") {
      cascades.push({ kind: "title-choice", detail: `D${n}: título de destaque trocado "${d.title}" (cascata de destaque-swap)`, url: d.url });
      continue;
    }
    // Sem saída da pipeline (`match` nulo): casa o pick pela posição, como antes do #9647.
    const pipelineEntry = match?.pipelineEntryOf.get(n);
    const key = destaqueUrlKey(pipelineEntry?.url ?? d.url);
    const pick = match ? picks.find((p) => p.url !== null && destaqueUrlKey(p.url) === key) : picks.find((p) => p.destaque === n);
    const from = pipelineEntry?.position;
    const where = from !== undefined && from !== n ? `D${n} (era D${from})` : `D${n}`;
    if (pick) {
      if (pick.chosen.trim() !== d.title.trim()) {
        changes.push({ kind: "title-choice", detail: `${where}: pipeline escolheu "${pick.chosen}", saiu "${d.title}"`, url: d.url });
      }
      continue;
    }
    const optionCount = (match ? options.find((o) => destaqueUrlKey(o.url) === key) : options.find((o) => o.position === n))?.titleOptions.length ?? 0;
    if (optionCount > 1) {
      changes.push({ kind: "title-choice", detail: `${where}: título escolhido à mão (sem pick do title-picker)`, url: d.url });
    }
  }
  return { status: "measured", baseline: "title-picks", changes, ...(cascades.length > 0 ? { cascades } : {}) };
}

function splitSocialLines(md: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = "_topo";
  sections.set(current, []);
  for (const line of normalizeSelfUrls(md).split("\n")) {
    const h = line.match(/^#{1,2}\s+(.+)$/);
    if (h) {
      current = h[1].trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (line.trim() !== "") sections.get(current)!.push(line.trim());
  }
  return sections;
}

function socialGate(editionDir: string, health: BaselineHealth, snapshotSocial: string | undefined): GateResult {
  const finalPath = join(editionDir, "03-social.md");
  if (!existsSync(finalPath)) return unmeasured("03-social.md ausente");
  if (health.status !== "ok" || snapshotSocial === undefined) {
    return unmeasured("sem baseline confiável — a saída da pipeline pro social só é preservada desde o #9356");
  }
  const baseline = applyAutofixReplacements(snapshotSocial, readAppliedAutofixes(editionDir), "social");
  const a = splitSocialLines(baseline);
  const b = splitSocialLines(readFileSync(finalPath, "utf8"));
  const changes: ManualChange[] = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(name) ?? [];
    const after = b.get(name) ?? [];
    const removed = before.filter((l) => !after.includes(l)).length;
    const added = after.filter((l) => !before.includes(l)).length;
    if (removed || added) changes.push({ kind: "text-edit", detail: `${name}: +${added}/-${removed}` });
  }
  return { status: "measured", baseline: "snapshot", changes };
}

/**
 * Imagens (#9647): a arte `04-dN-*` é do destaque que está em `DESTAQUE N` no
 * final. Refação de destaque trocado ou mudado de posição é cascata (vai pra
 * `cascades`); só conta a refação de destaque mantido na mesma posição.
 * Limite: arte movida com `mv` preserva o mtime e não aparece (261005 D1) — o
 * reposicionamento em si já conta em `destaques`.
 */
function imagesGate(editionDir: string, finalDestaques: readonly DestaqueEntry[], match: DestaqueMatch | null): GateResult {
  const step3 = readJson(join(editionDir, "_internal", ".step-3-done.json"));
  const completedMs = typeof step3?.completed_at === "string" ? Date.parse(step3.completed_at) : NaN;
  if (Number.isNaN(completedMs)) return unmeasured("sentinel do Stage 3 ausente");
  const changes: ManualChange[] = [];
  const cascades: ManualChange[] = [];
  for (const n of [1, 2, 3]) {
    const regenerated = ["2x1", "1x1", "4x5-nativo"].filter((ratio) => {
      const p = join(editionDir, `04-d${n}-${ratio}.jpg`);
      return existsSync(p) && statSync(p).mtimeMs > completedMs + IMAGE_MTIME_TOLERANCE_MS;
    });
    if (regenerated.length === 0) continue;
    const detail = `D${n}: ${regenerated.join(", ")} regerado(s) depois do Stage 3`;
    const d = finalDestaques.find((x) => x.position === n);
    const status = match?.statusByFinalPosition.get(n);
    if (status === "new") {
      cascades.push({ kind: "image-redo", detail: `${detail} (cascata de destaque-swap)`, url: d?.url });
    } else if (status === "moved") {
      cascades.push({ kind: "image-redo", detail: `${detail} (cascata: destaque era D${match!.pipelineEntryOf.get(n)?.position})`, url: d?.url });
    } else {
      changes.push(d ? { kind: "image-redo", detail, url: d.url } : { kind: "image-redo", detail });
    }
  }
  return { status: "measured", baseline: "stage3-sentinel", changes, ...(cascades.length > 0 ? { cascades } : {}) };
}

/** Lê `_internal/.jev-profile.json` como Tri (ausente/corrompido/ok). */
export function readJevProfile(editionDir: string): Tri<unknown> {
  const p = join(editionDir, "_internal", ".jev-profile.json");
  if (!existsSync(p)) return { state: "absent" };
  try {
    return { state: "ok", value: JSON.parse(readFileSync(p, "utf8")) as unknown };
  } catch {
    return { state: "corrupt" };
  }
}

/** URLs dos itens (destaques + buckets do pool) de um `01-*.json`. */
function selectionUrls(json: any): Set<string> {
  const urls = new Set<string>();
  for (const key of ["highlights", "lancamento", "radar", "use_melhor", "video"]) {
    for (const it of Array.isArray(json?.[key]) ? json[key] : []) {
      const url = it?.url ?? it?.article?.url;
      if (typeof url === "string" && url !== "") urls.add(url);
    }
  }
  return urls;
}

/**
 * URLs que o EDITOR pôs na seleção num gate humano do Stage 1 (aprovado ×
 * categorizado). Já estão no baseline da newsletter, mas não são saída da
 * pipeline — contam como inclusão (#9641). Gate auto-aprovado → vazio.
 * As URLs saem NORMALIZADAS (`normalizeItemUrl`, a mesma normalização do
 * baseline da newsletter), pra casar com as URLs extraídas do markdown.
 */
export function stage1EditorAddedUrls(editionDir: string, snapshotApproved: string | undefined): Set<string> {
  const gate = readJson(join(editionDir, "_internal", ".step-1-gate.json"));
  if (gate?.auto_approved !== false) return new Set();
  const categorized = readJson(join(editionDir, "_internal", "01-categorized.json"));
  if (!categorized) return new Set();
  let approved: any = null;
  try {
    approved = snapshotApproved !== undefined ? JSON.parse(snapshotApproved) : null;
  } catch {
    /* cai no aprovado final */
  }
  approved ??= readJson(join(editionDir, "_internal", "01-approved.json"));
  const pipeline = new Set([...selectionUrls(categorized)].map(normalizeItemUrl));
  return new Set([...selectionUrls(approved)].map(normalizeItemUrl).filter((u) => !pipeline.has(u)));
}

/** Destaques da saída da pipeline: baseline da newsletter, ou `02-draft.md`; `null` sem nenhum. */
function pipelineDestaques(
  editionDir: string,
  raw: { baseline: string; source: "snapshot" | "reconstructed" } | null,
): { destaques: DestaqueEntry[]; source: "snapshot" | "reconstructed" | "draft" } | null {
  if (raw !== null) {
    const ds = extractDestaques(raw.baseline);
    if (ds.length > 0) return { destaques: ds, source: raw.source };
  }
  const draft = join(editionDir, "_internal", "02-draft.md");
  if (!existsSync(draft)) return null;
  const ds = extractDestaques(normalizeNewsletterForComparison(readFileSync(draft, "utf8")));
  return ds.length > 0 ? { destaques: ds, source: "draft" } : null;
}

/** Mede uma edição. Somente leitura. */
export function computeEditionManualEdits(editionDir: string, edition: string, opts: ManualEditsOptions = {}): EditionManualEdits {
  const countCuts = opts.countCuts === true;
  const health = assessStage2BaselineOnDisk(editionDir);
  const snapshots = readSnapshots(editionDir, STAGE2_BASELINE_LABEL, STAGE2_SNAPSHOT_FILES);
  const finalPath = join(editionDir, "02-reviewed.md");
  const finalMd = existsSync(finalPath) ? readFileSync(finalPath, "utf8") : null;
  const snapshotApproved = snapshots.get("_internal/01-approved.json");

  const rawBaseline = finalMd === null ? null : newsletterBaseline(editionDir, health, snapshots.get("02-reviewed.md"), finalMd);
  const newsletter: NewsletterMeasurement =
    finalMd === null
      ? { gate: unmeasured("02-reviewed.md ausente"), cuts: [], inclusions: null }
      : newsletterGate(rawBaseline, finalMd, {
          countCuts,
          stage1EditorAddedUrls: stage1EditorAddedUrls(editionDir, snapshotApproved),
        });
  // #9647: destaques da saída da pipeline (o mesmo baseline da newsletter; sem
  // ele, o `02-draft.md` do writer) × final, casados por URL.
  const pipeline = pipelineDestaques(editionDir, rawBaseline);
  const finalDestaques = finalMd === null ? [] : extractDestaques(finalMd);
  const match = pipeline === null || finalMd === null ? null : matchDestaquesByUrl(pipeline.destaques, finalDestaques);
  const gates: Record<GateName, GateResult> = {
    stage1: stage1Gate(editionDir, health, snapshotApproved, pipeline?.destaques ?? null, countCuts),
    destaques: finalMd === null ? unmeasured("02-reviewed.md ausente") : destaquesGate(editionDir, pipeline, finalDestaques, match),
    newsletter: newsletter.gate,
    titles: finalMd === null ? unmeasured("02-reviewed.md ausente") : titlesGate(editionDir, finalDestaques, pipeline?.destaques ?? null, match),
    social: socialGate(editionDir, health, snapshots.get("03-social.md")),
    images: imagesGate(editionDir, finalDestaques, match),
  };
  // Cortes: os da newsletter (por URL) + `pool-cut` do Stage 1 que o texto não
  // mostrou (ex.: cortado no gate 1, nunca chegou ao baseline do Stage 2).
  const cuts: EditionItem[] = [...newsletter.cuts];
  const seen = new Set(cuts.map((c) => c.url));
  const stage1Cuts = countCuts ? gates.stage1.changes.filter((c) => c.kind === "pool-cut") : (gates.stage1.cuts ?? []);
  for (const c of stage1Cuts) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    cuts.push({ url: c.url, title: c.detail, section: "stage1" });
  }
  const manual_edit_count = Object.values(gates).reduce((a, g) => a + g.changes.length, 0);
  return {
    edition,
    arm: armFromProfile(readJevProfile(editionDir)),
    baseline_status: health.status,
    gates,
    manual_edit_count,
    zero_manual_edits: decideZeroManualEdits(gates),
    cuts_counted: countCuts,
    cuts,
    inclusions: newsletter.inclusions,
  };
}

export interface SeriesSummary {
  editions: number;
  zero: number;
  with_edits: number;
  unknown: number;
  /** Edições consecutivas sem modificação, contando da mais recente pra trás. */
  consecutive_zero: number;
  /** #9641: edições consecutivas sem inclusão (mais recente pra trás; `null` interrompe). */
  consecutive_zero_inclusions: number;
  /** #9641: média de inclusões por edição nas últimas 10 edições (só as medidas entram); `null` se nenhuma. */
  avg_inclusions_last_10: number | null;
  /** #9641: quantas edições entraram na média acima (≤ 10). */
  inclusions_window_editions: number;
  /** #9641: total de cortes na série (fora da contagem, salvo `--count-cuts`). */
  cuts_total: number;
  /** #9374: mesma contagem estratificada pelo braço do A/B do Jev. */
  by_arm: Record<Arm, { editions: number; zero: number; with_edits: number; unknown: number }>;
}

/** Agrega a série (entrada em qualquer ordem). Pura. */
export function summarizeSeries(results: readonly EditionManualEdits[]): SeriesSummary {
  const sorted = [...results].sort((a, b) => a.edition.localeCompare(b.edition));
  let streak = 0;
  for (let i = sorted.length - 1; i >= 0 && sorted[i].zero_manual_edits === true; i--) streak++;
  // `?? null`: resultados sem o campo (gerados antes do #9641) contam como não medidos.
  const inclusionsOf = (r: EditionManualEdits) => r.inclusions ?? null;
  let inclusionStreak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const inc = inclusionsOf(sorted[i]);
    if (inc === null || inc.length > 0) break;
    inclusionStreak++;
  }
  // Últimas 10 edições da série; as sem medição ficam fora da média.
  const window = sorted
    .slice(-INCLUSIONS_WINDOW)
    .map(inclusionsOf)
    .filter((inc): inc is EditionItem[] => inc !== null);
  return {
    editions: sorted.length,
    zero: sorted.filter((r) => r.zero_manual_edits === true).length,
    with_edits: sorted.filter((r) => r.zero_manual_edits === false).length,
    unknown: sorted.filter((r) => r.zero_manual_edits === null).length,
    consecutive_zero: streak,
    consecutive_zero_inclusions: inclusionStreak,
    avg_inclusions_last_10: window.length === 0 ? null : window.reduce((a, inc) => a + inc.length, 0) / window.length,
    inclusions_window_editions: window.length,
    cuts_total: sorted.reduce((a, r) => a + (r.cuts?.length ?? 0), 0),
    by_arm: Object.fromEntries(
      (["A", "B", "unknown"] as const).map((arm) => {
        const rs = sorted.filter((r) => r.arm === arm);
        return [
          arm,
          {
            editions: rs.length,
            zero: rs.filter((r) => r.zero_manual_edits === true).length,
            with_edits: rs.filter((r) => r.zero_manual_edits === false).length,
            unknown: rs.filter((r) => r.zero_manual_edits === null).length,
          },
        ];
      }),
    ) as SeriesSummary["by_arm"],
  };
}

function verdict(v: boolean | null): string {
  return v === true ? "SEM modificação" : v === false ? "modificada" : "indeterminado";
}

/** Edições (AAMMDD → dir) que passaram pelo gate do Stage 4 (o "final" existe). */
export function listMeasurableEditions(editionsRoot: string): Map<string, string> {
  const all = enumerateEditionDirs(editionsRoot);
  return new Map(
    [...all.entries()]
      .filter(([, dir]) => existsSync(join(dir, "_internal", ".step-4-done.json")))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Raiz de `data/editions` a partir do dir de uma edição — layout NESTED
 * (`editions/AAMM/AAMMDD`) ou FLAT (`editions/AAMMDD`).
 */
export function editionsRootOf(editionDir: string): string {
  const parent = dirname(resolve(editionDir));
  return /^\d{4}$/.test(basename(parent)) ? dirname(parent) : parent;
}

/**
 * #9641: série até `edition` (inclusive) pro relatório da edição — o
 * suficiente pra sequência sem modificação/sem inclusão e a média das
 * últimas 10, sem medir o histórico inteiro. `current` é o resultado já
 * medido da própria edição (entra mesmo sem `.step-4-done.json`).
 */
export function trailingSeriesSummary(
  editionsRoot: string,
  current: EditionManualEdits,
  opts: ManualEditsOptions = {},
): SeriesSummary {
  const prior = [...listMeasurableEditions(editionsRoot).entries()].filter(([e]) => e < current.edition).reverse();
  const results: EditionManualEdits[] = [current];
  let zeroStreakOpen = current.zero_manual_edits === true;
  let inclusionStreakOpen = current.inclusions !== null && current.inclusions.length === 0;
  for (const [e, dir] of prior) {
    if (results.length >= INCLUSIONS_WINDOW && !zeroStreakOpen && !inclusionStreakOpen) break;
    const r = computeEditionManualEdits(dir, e, opts);
    results.push(r);
    zeroStreakOpen &&= r.zero_manual_edits === true;
    inclusionStreakOpen &&= r.inclusions !== null && r.inclusions.length === 0;
  }
  return summarizeSeries(results);
}

function formatAvg(v: number | null): string {
  return v === null ? "n/d" : v.toFixed(1).replace(".", ",");
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionsRoot = values["editions-dir"] ? resolve(values["editions-dir"]) : resolve(ROOT, "data", "editions");
  const opts: ManualEditsOptions = { countCuts: flags.has("count-cuts") };
  const all = listMeasurableEditions(editionsRoot);
  let editions = [...all.keys()];
  if (values.edition) editions = editions.filter((e) => e === values.edition);
  if (values.from) editions = editions.filter((e) => e >= values.from);
  if (values.to) editions = editions.filter((e) => e <= values.to);
  if (editions.length === 0) {
    console.error("[edition-manual-edits] nenhuma edição com Stage 4 concluído no filtro.");
    process.exit(1);
  }
  const results = editions.map((e) => computeEditionManualEdits(all.get(e)!, e, opts));
  const summary = summarizeSeries(results);
  if (flags.has("json")) {
    console.log(JSON.stringify({ summary, cuts_counted: opts.countCuts === true, editions: results }, null, 2));
    return;
  }
  for (const r of results) {
    const parts = (Object.entries(r.gates) as Array<[GateName, GateResult]>).map(([name, g]) =>
      g.status === "unmeasured" ? `${name}=?` : `${name}=${g.changes.length}`,
    );
    const inc = r.inclusions === null ? "?" : String(r.inclusions.length);
    console.log(
      `${r.edition}  braço=${r.arm.padEnd(7)} ${verdict(r.zero_manual_edits).padEnd(16)} baseline=${r.baseline_status.padEnd(7)} ${parts.join(" ")}  cortes=${r.cuts.length} inclusões=${inc}`,
    );
  }
  console.log(
    `\n${summary.editions} edições: ${summary.zero} sem modificação, ${summary.with_edits} modificadas, ${summary.unknown} indeterminadas. ` +
      `Consecutivas sem modificação (mais recentes): ${summary.consecutive_zero} — meta da #7972: ${STREAK_GOAL}.`,
  );
  console.log(
    `Cortes ${opts.countCuts ? "CONTAM como modificação (--count-cuts)" : "fora da contagem (decisão do editor de 01/10/2026, #7972; --count-cuts religa)"}: ${summary.cuts_total} na série.`,
  );
  console.log(
    `Inclusões: consecutivas sem inclusão ${summary.consecutive_zero_inclusions}; média nas últimas ${INCLUSIONS_WINDOW} edições (${summary.inclusions_window_editions} medidas): ${formatAvg(summary.avg_inclusions_last_10)}.`,
  );
  for (const [arm, c] of Object.entries(summary.by_arm)) {
    if (c.editions === 0) continue;
    console.log(`  braço ${arm}: ${c.editions} edições — ${c.zero} sem modificação, ${c.with_edits} modificadas, ${c.unknown} indeterminadas.`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
