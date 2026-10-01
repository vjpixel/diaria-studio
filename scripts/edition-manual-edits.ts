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
 * | `stage1` | `01-categorized.json` × `01-approved.json` | destaque trocado/promovido/cortado, item de pool cortado/adicionado/movido |
 * | `newsletter` | baseline (snapshot `stage2-post-gate` ou reconstruído) × `02-reviewed.md` | qualquer linha de texto adicionada/removida, por seção |
 * | `titles` | `02-title-picks.json` (escolha do `title-picker`) × título final | título final ≠ o escolhido pela pipeline, ou poda manual (sem pick) |
 * | `social` | snapshot `stage2-post-gate/03-social.md` × `03-social.md` | qualquer linha de texto |
 * | `images` | mtime das artes × `completed_at` do sentinel do Stage 3 | arte/recorte regerado depois do Stage 3 |
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
 * Somente leitura: nunca escreve em `data/`.
 *
 * Uso:
 *   npx tsx scripts/edition-manual-edits.ts                     # todas as edições com Stage 4 concluído
 *   npx tsx scripts/edition-manual-edits.ts --edition 260930
 *   npx tsx scripts/edition-manual-edits.ts --from 260914 --to 261001 --json
 *   [--editions-dir data/editions]
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  countTitleOptions,
  diffBySection,
  extractDestaqueTitles,
  normalizeNewsletterForComparison,
  normalizeSelfUrls,
} from "./lib/manual-edit-diff.ts";
import {
  buildReconstructedNewsletterBaseline,
  classifyApprovedDiff,
  classifyPoolDiff,
  classifyStage1DestaqueDiff,
  findPipelineNewsletterOutput,
  readAppliedAutofixes,
  readIntentionalError,
  readTitlePicks,
} from "./derive-editor-requests.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Margem entre o sentinel do Stage 3 e o mtime de uma arte "da própria pipeline". */
const IMAGE_MTIME_TOLERANCE_MS = 2 * 60 * 1000;

export interface ManualChange {
  kind: string;
  detail: string;
}

export interface GateResult {
  status: "measured" | "unmeasured";
  /** De onde veio a referência (quando medido). */
  baseline?: "snapshot" | "reconstructed" | "categorized" | "title-picks" | "stage3-sentinel";
  changes: ManualChange[];
  note?: string;
}

export type GateName = "stage1" | "newsletter" | "titles" | "social" | "images";

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

function stage1Gate(editionDir: string, health: BaselineHealth, snapshotApproved: string | undefined): GateResult {
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
  const toChanges = (entries: Array<{ request_type: string; description: string }>) =>
    entries.map((e) => ({ kind: e.request_type, detail: e.description }));

  if (health.status === "ok" && snapshotApproved !== undefined) {
    // Gate humano do Stage 1: categorizado × aprovado no fim do Stage 2.
    if (humanGate) {
      let atStage2: any = null;
      try {
        atStage2 = JSON.parse(snapshotApproved);
      } catch {
        /* cai no aprovado final abaixo */
      }
      const ref = atStage2 ?? approved;
      changes.push(...toChanges(classifyStage1DestaqueDiff(categorized, ref)), ...toChanges(classifyPoolDiff(categorized, ref)));
    }
    // Mudanças de seleção depois do Stage 2 (troca de destaque/bucket no Stage 4).
    changes.push(...toChanges(classifyApprovedDiff(snapshotApproved, approvedRaw)));
    return { status: "measured", baseline: "snapshot", changes };
  }

  // Sem baseline confiável: categorizado × aprovado FINAL. Sob auto-aprovação
  // o recorte top-3 do `apply-gate-edits` não conta (mesma regra de
  // `classifyStage1DestaqueDiff`); o que sobrar é troca feita depois.
  changes.push(...toChanges(classifyStage1DestaqueDiff(categorized, approved)));
  if (humanGate) changes.push(...toChanges(classifyPoolDiff(categorized, approved)));
  return {
    status: "measured",
    baseline: "categorized",
    changes,
    note: humanGate ? undefined : "auto-aprovado sem baseline: pool não comparado (recorte/cap da pipeline indistinguível de corte manual)",
  };
}

function newsletterGate(editionDir: string, health: BaselineHealth, snapshotMd: string | undefined, finalMd: string): GateResult {
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
  if (baseline === null) return unmeasured("sem snapshot confiável nem arquivo da pipeline (02-humanized/02-clarice-corrected)");
  const changes = diffBySection(baseline, normalizeNewsletterForComparison(finalMd)).map((c) => ({
    kind: "text-edit",
    detail: `${c.section}: +${c.added}/-${c.removed}${c.sample_added[0] ? ` (ex.: "${c.sample_added[0]}")` : ""}`,
  }));
  return { status: "measured", baseline: source, changes };
}

function titlesGate(editionDir: string, finalMd: string): GateResult {
  const picks = readTitlePicks(editionDir);
  const finalTitles = extractDestaqueTitles(finalMd);
  const pipelinePath = findPipelineNewsletterOutput(editionDir);
  // Quantas opções de título cada destaque tinha na saída da pipeline.
  const optionCounts = pipelinePath ? countTitleOptions(readFileSync(pipelinePath, "utf8")) : new Map<number, number>();
  if (finalTitles.size === 0) return unmeasured("nenhum destaque encontrado em 02-reviewed.md");
  const changes: ManualChange[] = [];
  for (const [n, title] of finalTitles) {
    const pick = picks.find((p) => p.destaque === n);
    if (pick) {
      if (pick.chosen.trim() !== title.trim()) {
        changes.push({ kind: "title-choice", detail: `D${n}: pipeline escolheu "${pick.chosen}", saiu "${title}"` });
      }
    } else if ((optionCounts.get(n) ?? 0) > 1) {
      changes.push({ kind: "title-choice", detail: `D${n}: título escolhido à mão (sem pick do title-picker)` });
    }
  }
  return { status: "measured", baseline: "title-picks", changes };
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

function imagesGate(editionDir: string): GateResult {
  const step3 = readJson(join(editionDir, "_internal", ".step-3-done.json"));
  const completedMs = typeof step3?.completed_at === "string" ? Date.parse(step3.completed_at) : NaN;
  if (Number.isNaN(completedMs)) return unmeasured("sentinel do Stage 3 ausente");
  const changes: ManualChange[] = [];
  for (const n of [1, 2, 3]) {
    const regenerated = ["2x1", "1x1", "4x5-nativo"].filter((ratio) => {
      const p = join(editionDir, `04-d${n}-${ratio}.jpg`);
      return existsSync(p) && statSync(p).mtimeMs > completedMs + IMAGE_MTIME_TOLERANCE_MS;
    });
    if (regenerated.length > 0) {
      changes.push({ kind: "image-redo", detail: `D${n}: ${regenerated.join(", ")} regerado(s) depois do Stage 3` });
    }
  }
  return { status: "measured", baseline: "stage3-sentinel", changes };
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

/** Mede uma edição. Somente leitura. */
export function computeEditionManualEdits(editionDir: string, edition: string): EditionManualEdits {
  const health = assessStage2BaselineOnDisk(editionDir);
  const snapshots = readSnapshots(editionDir, STAGE2_BASELINE_LABEL, STAGE2_SNAPSHOT_FILES);
  const finalPath = join(editionDir, "02-reviewed.md");
  const finalMd = existsSync(finalPath) ? readFileSync(finalPath, "utf8") : null;

  const gates: Record<GateName, GateResult> = {
    stage1: stage1Gate(editionDir, health, snapshots.get("_internal/01-approved.json")),
    newsletter: finalMd === null ? unmeasured("02-reviewed.md ausente") : newsletterGate(editionDir, health, snapshots.get("02-reviewed.md"), finalMd),
    titles: finalMd === null ? unmeasured("02-reviewed.md ausente") : titlesGate(editionDir, finalMd),
    social: socialGate(editionDir, health, snapshots.get("03-social.md")),
    images: imagesGate(editionDir),
  };
  const manual_edit_count = Object.values(gates).reduce((a, g) => a + g.changes.length, 0);
  return { edition, arm: armFromProfile(readJevProfile(editionDir)), baseline_status: health.status, gates, manual_edit_count, zero_manual_edits: decideZeroManualEdits(gates) };
}

export interface SeriesSummary {
  editions: number;
  zero: number;
  with_edits: number;
  unknown: number;
  /** Edições consecutivas sem modificação, contando da mais recente pra trás. */
  consecutive_zero: number;
  /** #9374: mesma contagem estratificada pelo braço do A/B do Jev. */
  by_arm: Record<Arm, { editions: number; zero: number; with_edits: number; unknown: number }>;
}

/** Agrega a série (entrada em qualquer ordem). Pura. */
export function summarizeSeries(results: readonly EditionManualEdits[]): SeriesSummary {
  const sorted = [...results].sort((a, b) => a.edition.localeCompare(b.edition));
  let streak = 0;
  for (let i = sorted.length - 1; i >= 0 && sorted[i].zero_manual_edits === true; i--) streak++;
  return {
    editions: sorted.length,
    zero: sorted.filter((r) => r.zero_manual_edits === true).length,
    with_edits: sorted.filter((r) => r.zero_manual_edits === false).length,
    unknown: sorted.filter((r) => r.zero_manual_edits === null).length,
    consecutive_zero: streak,
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

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionsRoot = values["editions-dir"] ? resolve(values["editions-dir"]) : resolve(ROOT, "data", "editions");
  const all = enumerateEditionDirs(editionsRoot);
  let editions = [...all.keys()].sort();
  if (values.edition) editions = editions.filter((e) => e === values.edition);
  if (values.from) editions = editions.filter((e) => e >= values.from);
  if (values.to) editions = editions.filter((e) => e <= values.to);
  // Só edições que passaram pelo gate do Stage 4 (o "final" existe).
  editions = editions.filter((e) => existsSync(join(all.get(e)!, "_internal", ".step-4-done.json")));
  if (editions.length === 0) {
    console.error("[edition-manual-edits] nenhuma edição com Stage 4 concluído no filtro.");
    process.exit(1);
  }
  const results = editions.map((e) => computeEditionManualEdits(all.get(e)!, e));
  const summary = summarizeSeries(results);
  if (flags.has("json")) {
    console.log(JSON.stringify({ summary, editions: results }, null, 2));
    return;
  }
  for (const r of results) {
    const parts = (Object.entries(r.gates) as Array<[GateName, GateResult]>).map(([name, g]) =>
      g.status === "unmeasured" ? `${name}=?` : `${name}=${g.changes.length}`,
    );
    console.log(`${r.edition}  braço=${r.arm.padEnd(7)} ${verdict(r.zero_manual_edits).padEnd(16)} baseline=${r.baseline_status.padEnd(7)} ${parts.join(" ")}`);
  }
  console.log(
    `\n${summary.editions} edições: ${summary.zero} sem modificação, ${summary.with_edits} modificadas, ${summary.unknown} indeterminadas. ` +
      `Consecutivas sem modificação (mais recentes): ${summary.consecutive_zero} — meta da #7972: 3.`,
  );
  for (const [arm, c] of Object.entries(summary.by_arm)) {
    if (c.editions === 0) continue;
    console.log(`  braço ${arm}: ${c.editions} edições — ${c.zero} sem modificação, ${c.with_edits} modificadas, ${c.unknown} indeterminadas.`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
