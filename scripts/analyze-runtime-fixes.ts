#!/usr/bin/env npx tsx
/**
 * analyze-runtime-fixes.ts (#1210, item 5 — "dimensão regressão-prevention")
 *
 * Varre `_internal/runtime-fixes.jsonl` de TODAS as edições no disco (via
 * `enumerateEditionDirs`, cobre os dois layouts flat/nested) e agrega por
 * `component` — detectando fix recorrente (mesmo componente reaparecendo em
 * N edições distintas) pra sinalizar candidato a fix PERMANENTE, em vez de
 * remediar o mesmo bug in-flight edição após edição sem nunca fechar o loop.
 *
 * Diferente de `collect-edition-signals.ts` (que roda sobre 1 edição, com
 * fins de auto-reporter): este script é cross-edição e não produz signals —
 * só um relatório pro editor consultar sob demanda. Não é chamado
 * automaticamente por nenhum stage do pipeline.
 *
 * Uso:
 *   npx tsx scripts/analyze-runtime-fixes.ts
 *   npx tsx scripts/analyze-runtime-fixes.ts --min-editions 2 --json
 *   npx tsx scripts/analyze-runtime-fixes.ts --editions-dir <path>  # isolamento de teste
 *
 * Output: tabela markdown em stdout (ou JSON com `--json`), ordenada por
 * `edition_count` desc. Sem `--json`, também imprime uma seção com o total
 * de fixes por severity, pra visão geral rápida.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { editionsRoot } from "./lib/edition-paths.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Mirrors o shape gravado por `appendRuntimeFix` (log-runtime-fix.ts) —
 *  type-only re-declarado aqui de propósito, mesmo padrão de
 *  `RuntimeFixEntry` em collect-edition-signals.ts: este módulo só depende
 *  do formato de linha gravado, não do CLI de log-runtime-fix.ts. */
export interface RuntimeFixEntry {
  timestamp: string;
  edition: string;
  stage: number;
  fix_type: string;
  component: string;
  description: string;
  severity: "P0" | "P1" | "P2" | "P3";
  context?: Record<string, unknown>;
}

export interface ComponentAggregate {
  component: string;
  edition_count: number;
  editions: string[];
  fix_count: number;
  fix_types: string[];
  worst_severity: "P0" | "P1" | "P2" | "P3";
  sample_descriptions: string[];
}

/**
 * Lê `_internal/runtime-fixes.jsonl` de cada edição no índice enumerado.
 * Linhas malformadas são ignoradas (mesmo padrão tolerante do resto do
 * pipeline de signals). Retorna só edições com ≥1 entrada válida.
 */
export function readRuntimeFixesForEditions(
  editionDirsByAammdd: Map<string, string>,
): Record<string, RuntimeFixEntry[]> {
  const out: Record<string, RuntimeFixEntry[]> = {};
  for (const [edition, dir] of editionDirsByAammdd) {
    const path = resolve(dir, "_internal/runtime-fixes.jsonl");
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const entries: RuntimeFixEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // ignore malformed line
      }
    }
    if (entries.length > 0) out[edition] = entries;
  }
  return out;
}

const SEVERITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * Agrega entries de TODAS as edições por `component`. Pura — não faz IO.
 */
export function aggregateByComponent(
  entriesByEdition: Record<string, RuntimeFixEntry[]>,
): ComponentAggregate[] {
  const byComponent = new Map<string, RuntimeFixEntry[]>();
  for (const entries of Object.values(entriesByEdition)) {
    for (const e of entries) {
      const arr = byComponent.get(e.component) ?? [];
      arr.push(e);
      byComponent.set(e.component, arr);
    }
  }

  const out: ComponentAggregate[] = [];
  for (const [component, entries] of byComponent) {
    const editions = [...new Set(entries.map((e) => e.edition))].sort();
    const worst = entries.reduce((acc, e) => {
      const rank = SEVERITY_RANK[e.severity] ?? 9;
      return rank < (SEVERITY_RANK[acc] ?? 9) ? e.severity : acc;
    }, entries[0].severity);
    out.push({
      component,
      edition_count: editions.length,
      editions,
      fix_count: entries.length,
      fix_types: [...new Set(entries.map((e) => e.fix_type))].sort(),
      worst_severity: worst,
      sample_descriptions: entries.slice(0, 3).map((e) => e.description),
    });
  }
  return out.sort(
    (a, b) => b.edition_count - a.edition_count || b.fix_count - a.fix_count,
  );
}

/**
 * Filtra os aggregates que são "recorrentes" (aparecem em ≥ minEditions
 * edições DISTINTAS) — candidatos a fix permanente.
 */
export function detectRecurringComponents(
  aggregates: ComponentAggregate[],
  minEditions = 3,
): ComponentAggregate[] {
  return aggregates.filter((a) => a.edition_count >= minEditions);
}

function renderMarkdown(
  all: ComponentAggregate[],
  recurring: ComponentAggregate[],
  minEditions: number,
): string {
  const lines: string[] = [];
  lines.push("# Runtime fixes — análise cross-edição (#1210)\n");
  lines.push(
    `${all.length} componente(s) com runtime fix registrado, ${recurring.length} recorrente(s) (≥${minEditions} edições distintas).\n`,
  );

  if (recurring.length > 0) {
    lines.push("## Candidatos a fix permanente\n");
    lines.push("| Componente | Edições | Fixes | Tipos | Pior severity |");
    lines.push("|---|---|---|---|---|");
    for (const a of recurring) {
      lines.push(
        `| ${a.component} | ${a.edition_count} (${a.editions.join(", ")}) | ${a.fix_count} | ${a.fix_types.join(", ")} | ${a.worst_severity} |`,
      );
    }
    lines.push("");
  } else {
    lines.push(
      "Nenhum componente recorrente ainda — pode ser cedo demais no histórico (poucas edições rodaram com o mecanismo #1210 ativo), ou os fixes têm sido genuinamente pontuais.\n",
    );
  }

  if (all.length > recurring.length) {
    lines.push("## Demais componentes (abaixo do threshold)\n");
    lines.push("| Componente | Edições | Fixes | Pior severity |");
    lines.push("|---|---|---|---|");
    for (const a of all) {
      if (a.edition_count >= minEditions) continue;
      lines.push(`| ${a.component} | ${a.edition_count} | ${a.fix_count} | ${a.worst_severity} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const editionsDir = values["editions-dir"]
    ? resolve(values["editions-dir"])
    : resolve(ROOT, editionsRoot());
  const minEditions = values["min-editions"] ? parseInt(values["min-editions"], 10) : 3;
  const asJson = process.argv.includes("--json");

  const editionDirsByAammdd = enumerateEditionDirs(editionsDir);
  const entriesByEdition = readRuntimeFixesForEditions(editionDirsByAammdd);
  const aggregates = aggregateByComponent(entriesByEdition);
  const recurring = detectRecurringComponents(aggregates, minEditions);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          editions_scanned: editionDirsByAammdd.size,
          editions_with_fixes: Object.keys(entriesByEdition).length,
          min_editions_threshold: minEditions,
          components: aggregates,
          recurring_components: recurring,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(renderMarkdown(aggregates, recurring, minEditions));
}

if (isMainModule(import.meta.url)) {
  main();
}
