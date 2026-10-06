#!/usr/bin/env tsx
/**
 * measure-gate4-highlight-changes.ts (#9693)
 *
 * Mede, por edição, o que o editor mudou nos DESTAQUES no gate 4,
 * separando troca de item, reordenação, reescrita de título e troca de
 * categoria — casando por URL, nunca por posição. Somente leitura de
 * `data/editions/`; nada ao vivo.
 *
 * Fontes (as mesmas da métrica `edition-manual-edits.ts`, #9357/#9647):
 * - **Entregue ao gate 4**: snapshot `stage2-post-gate/02-reviewed.md`
 *   (com as mutações da própria pipeline aplicadas — fact-check autofix,
 *   erro intencional) ou, sem snapshot confiável, o baseline reconstruído.
 *   `newsletterBaseline` de `edition-manual-edits.ts`.
 * - **Aprovado pelo editor**: `02-reviewed.md` atual.
 * - **3 opções de título**: texto do writer com as 3 opções
 *   (`readPipelineTitleOptions`) + `chosen`/`alternatives` de
 *   `_internal/02-title-picks.json`.
 * - **Sinal do auto-reporter**: eventos `title-choice` em
 *   `_internal/editor-requests.jsonl` (o que alimentou a #9693),
 *   reclassificados um a um pela comparação por URL.
 *
 * @one-off-validity: expira=2027-01-06 pergunta="o sinal title-choice do auto-reporter no gate 4 é troca de título real ou troca/reordenação de item, e isso justifica mudar o title-picker/scorer-select? (#9693)"
 *
 * Uso:
 *   npx tsx scripts/measure-gate4-highlight-changes.ts --from 260928 --to 261006
 *   npx tsx scripts/measure-gate4-highlight-changes.ts --editions-root /caminho/data/editions --json
 *
 * Sem `--from`/`--to`, mede todas as edições com `02-reviewed.md`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { assessStage2BaselineOnDisk, readSnapshots, STAGE2_BASELINE_LABEL, STAGE2_SNAPSHOT_FILES } from "./lib/editor-request-snapshots.ts";
import { normalizeNewsletterForComparison } from "./lib/manual-edit-diff.ts";
import { newsletterBaseline, readPipelineTitleOptions } from "./edition-manual-edits.ts";
import {
  compareHighlights,
  describeHighlight,
  primaryClass,
  reconcileEvent,
  type HighlightComparison,
  type ReconciledEvent,
  type ReporterEvent,
  type TitlePickLike,
} from "./lib/gate4-highlight-changes.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface EditionMeasurement {
  edition: string;
  status: "measured" | "unmeasured";
  reason?: string;
  baseline_source?: "snapshot" | "reconstructed";
  /** Saúde do snapshot `stage2-post-gate` (por que caiu no reconstruído). */
  baseline_health?: string;
  comparison?: HighlightComparison;
  events: ReconciledEvent[];
}

function readPicks(editionDir: string): TitlePickLike[] {
  const p = join(editionDir, "_internal", "02-title-picks.json");
  if (!existsSync(p)) return [];
  try {
    const json = JSON.parse(readFileSync(p, "utf8"));
    return (Array.isArray(json?.picks) ? json.picks : [])
      .filter((x: any) => typeof x?.chosen === "string")
      .map((x: any) => ({ chosen: x.chosen, alternatives: Array.isArray(x.alternatives) ? x.alternatives.filter((a: unknown) => typeof a === "string") : [] }));
  } catch {
    return [];
  }
}

/** Todo campo `url` (string) de um JSON, em qualquer profundidade. Pura. */
export function collectUrls(json: unknown, out: string[] = []): string[] {
  if (Array.isArray(json)) for (const x of json) collectUrls(x, out);
  else if (json && typeof json === "object") {
    for (const [k, v] of Object.entries(json)) {
      if (k === "url" && typeof v === "string" && /^https?:\/\//.test(v)) out.push(v);
      else collectUrls(v, out);
    }
  }
  return out;
}

/** URLs dos candidatos pontuados no Stage 1 (sem os arquivos, lista vazia). */
function readCandidateUrls(editionDir: string): string[] {
  const out: string[] = [];
  for (const f of ["01-categorized.json", "tmp-allscored.json"]) {
    const p = join(editionDir, "_internal", f);
    if (!existsSync(p)) continue;
    try {
      collectUrls(JSON.parse(readFileSync(p, "utf8")), out);
    } catch {
      /* arquivo ilegível: ignora, a origem cai em fora-da-saida */
    }
  }
  return out;
}

/** Eventos `title-choice` do Stage 4 (os que o auto-reporter contou), sem duplicata por alvo. */
export function readReporterEvents(editionDir: string, edition: string): ReporterEvent[] {
  const p = join(editionDir, "_internal", "editor-requests.jsonl");
  if (!existsSync(p)) return [];
  const seen = new Set<string>();
  const out: ReporterEvent[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.request_type !== "title-choice" || r?.stage !== 4 || typeof r?.target !== "string") continue;
    if (seen.has(r.target)) continue;
    seen.add(r.target);
    out.push({ edition, target: r.target });
  }
  return out;
}

/** Mede uma edição. Somente leitura. */
export function measureEdition(editionDir: string, edition: string): EditionMeasurement {
  const events = readReporterEvents(editionDir, edition);
  const finalPath = join(editionDir, "02-reviewed.md");
  if (!existsSync(finalPath)) return { edition, status: "unmeasured", reason: "02-reviewed.md ausente", events: [] };
  const finalRaw = readFileSync(finalPath, "utf8");
  const health = assessStage2BaselineOnDisk(editionDir);
  const snap = readSnapshots(editionDir, STAGE2_BASELINE_LABEL, STAGE2_SNAPSHOT_FILES).get("02-reviewed.md");
  const raw = newsletterBaseline(editionDir, health, snap, finalRaw);
  if (raw === null) {
    return { edition, status: "unmeasured", reason: "sem snapshot stage2-post-gate confiável nem arquivo da pipeline pra reconstruir", events: [] };
  }
  const finalMd = normalizeNewsletterForComparison(finalRaw);
  const comparison = compareHighlights(
    raw.baseline,
    finalMd,
    readPipelineTitleOptions(editionDir),
    readPicks(editionDir),
    readCandidateUrls(editionDir),
  );
  const baseline_health = health.status === "late" ? `late — ${health.reason}` : health.status;
  if (comparison.highlights.length === 0) {
    return { edition, status: "unmeasured", reason: "nenhum destaque legível no aprovado", baseline_source: raw.source, baseline_health, events: [] };
  }
  return {
    edition,
    status: "measured",
    baseline_source: raw.source,
    baseline_health,
    comparison,
    events: events.map((e) => reconcileEvent(e, comparison, raw.baseline, finalMd)),
  };
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

const yes = (b: boolean) => (b ? "sim" : "—");

export function renderMarkdown(results: readonly EditionMeasurement[]): string {
  const out: string[] = [];
  out.push("## Destaques: entregue ao gate 4 × aprovado (casado por URL)", "");
  out.push("| Edição | Pos. | Classe | Item trocado | Reordenado | Título | Categoria | Detalhe |", "|---|---|---|---|---|---|---|---|");
  const totals = { highlights: 0, "item-trocado": 0, reordenado: 0, titulo: 0, categoria: 0, mantido: 0 } as Record<string, number>;
  const dims = { item: 0, posicao: 0, titulo: 0, titulo_opcao: 0, titulo_reescrito: 0, categoria: 0 };
  for (const r of results) {
    if (r.status !== "measured") continue;
    for (const h of r.comparison!.highlights) {
      totals.highlights++;
      totals[primaryClass(h)]++;
      if (h.item_swapped) dims.item++;
      if (h.reordered) dims.posicao++;
      if (h.title_change) dims.titulo++;
      if (h.title_change === "outra-opcao") dims.titulo_opcao++;
      if (h.title_change === "reescrito") dims.titulo_reescrito++;
      if (h.category_change) dims.categoria++;
      out.push(
        `| ${r.edition} | D${h.position} | ${primaryClass(h)} | ${yes(h.item_swapped)} | ${h.reordered ? `D${h.pipeline!.position}→D${h.position}` : "—"} | ${h.title_change ?? "—"} | ${h.category_change ? `${h.category_change.from}→${h.category_change.to}` : "—"} | ${describeHighlight(h).replace(/\|/g, "/")} |`,
      );
    }
  }
  out.push("");
  out.push(
    `Totais (${totals.highlights} destaques aprovados): item trocado ${dims.item}, reordenado ${dims.posicao}, título ${dims.titulo} (outra opção ${dims.titulo_opcao}, reescrito ${dims.titulo_reescrito}), categoria ${dims.categoria}. Classe primária — item-trocado ${totals["item-trocado"]}, reordenado ${totals.reordenado}, título ${totals.titulo}, categoria ${totals.categoria}, mantido ${totals.mantido}.`,
    "",
  );

  const dropped = results.flatMap((r) => (r.status === "measured" ? r.comparison!.dropped.map((d) => ({ edition: r.edition, d })) : []));
  if (dropped.length) {
    out.push("### Destaques da pipeline que saíram", "", "| Edição | Era | Título | Destino |", "|---|---|---|---|");
    for (const { edition, d } of dropped) {
      const fate = d.fate.kind === "rebaixado" ? `rebaixado para ${d.fate.section}` : d.fate.kind === "mesma-pauta" ? `mesma pauta em D${d.fate.to_position}, outra URL` : "cortado";
      out.push(`| ${edition} | D${d.position} | ${d.title.replace(/\|/g, "/")} | ${fate} |`);
    }
    out.push("");
  }

  const events = results.flatMap((r) => r.events);
  out.push(`## Reclassificação dos ${events.length} eventos \`title-choice\` do auto-reporter`, "");
  out.push("| Edição | Alvo | Classe (por URL) | Dimensões | Detalhe |", "|---|---|---|---|---|");
  const byClass = new Map<string, number>();
  const byDim = new Map<string, number>();
  for (const e of events) {
    byClass.set(e.class, (byClass.get(e.class) ?? 0) + 1);
    for (const d of e.dimensions) byDim.set(d, (byDim.get(d) ?? 0) + 1);
    out.push(`| ${e.edition} | ${e.target} | ${e.class} | ${e.dimensions.join(", ") || "—"} | ${e.detail.replace(/\|/g, "/")} |`);
  }
  out.push("");
  const pct = (n: number) => (events.length ? `${Math.round((100 * n) / events.length)}%` : "n/d");
  out.push(
    `Classe primária: ${[...byClass.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v} (${pct(v)})`).join(", ") || "—"}.`,
    `Dimensões (um evento pode ter várias): ${[...byDim.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v} (${pct(v)})`).join(", ") || "—"}.`,
    "",
  );

  const unmeasured = results.filter((r) => r.status !== "measured");
  if (unmeasured.length) {
    out.push("### Edições não medidas", "");
    for (const r of unmeasured) out.push(`- ${r.edition}: ${r.reason}`);
    out.push("");
  }
  const reconstructed = results.filter((r) => r.baseline_source === "reconstructed");
  if (reconstructed.length) {
    out.push("### Baseline reconstruído (aproximação — snapshot `stage2-post-gate` não confiável)", "");
    for (const r of reconstructed) out.push(`- ${r.edition}: snapshot ${r.baseline_health}; baseline = saída do writer (02-humanized/02-clarice-corrected)`);
    out.push("");
  }
  return out.join("\n");
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const root = values["editions-root"] ? resolve(values["editions-root"]) : join(ROOT, "data", "editions");
  const from = values["from"] ?? "000000";
  const to = values["to"] ?? "999999";
  const editions = [...enumerateEditionDirs(root).entries()]
    .filter(([e]) => /^\d{6}$/.test(e) && e >= from && e <= to)
    .sort(([a], [b]) => a.localeCompare(b));
  if (editions.length === 0) {
    console.error(`Nenhuma edição em ${root} no intervalo ${from}..${to}.`);
    process.exit(1);
  }
  const results = editions.map(([e, dir]) => measureEdition(dir, e));
  if (flags.has("json")) console.log(JSON.stringify(results, null, 2));
  else console.log(renderMarkdown(results));
}

if (isMainModule(import.meta.url)) main();
