#!/usr/bin/env tsx
/**
 * list-invariants.ts (#1580)
 *
 * Documentation generator: varre o registry de invariants (ALL_INVARIANT_RULES
 * em scripts/lib/invariant-checks/index.ts + STATIC_RULES em
 * scripts/check-invariants.ts) e emite tabela markdown agrupada por stage.
 *
 * Resolve o gap apontado em #1580: editor / contribuidor não tinha lista
 * única "que regras o sistema enforça?". Os arquivos individuais
 * (stage-N.ts) continuam sendo a source of truth — este script é só
 * presentation.
 *
 * Uso:
 *   # stdout:
 *   npx tsx scripts/list-invariants.ts
 *
 *   # gravar em docs/editorial-invariants.md:
 *   npx tsx scripts/list-invariants.ts --out docs/editorial-invariants.md
 *
 *   # CI gate (#1580): falha se o arquivo gerado divergiu do conteúdo
 *   # commitado (sinaliza que alguém adicionou invariant sem regenerar).
 *   npx tsx scripts/list-invariants.ts --check docs/editorial-invariants.md
 *
 * Exit codes:
 *   0 — ok
 *   1 — --check detectou drift
 *   2 — argumento inválido
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_INVARIANT_RULES, type InvariantRule } from "./lib/invariant-checks/index.ts";
import { STATIC_RULES } from "./check-invariants.ts";
import { parseArgs } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface StageGroup {
  stage: number | "static";
  label: string;
  rules: Array<{
    id: string;
    description: string;
    source_issue: string;
  }>;
}

const STAGE_LABELS: Record<number, string> = {
  0: "Stage 0 — Setup + dedup",
  1: "Stage 1 — Pesquisa",
  2: "Stage 2 — Escrita",
  3: "Stage 3 — Imagens",
  4: "Stage 4 — Publicação (pré-dispatch)",
  5: "Stage 5 — Publicação (pós-dispatch)",
  6: "Stage 6 — Agendamento",
};

function groupRules(): StageGroup[] {
  const byStage = new Map<number, InvariantRule[]>();
  for (const r of ALL_INVARIANT_RULES) {
    const arr = byStage.get(r.stage) ?? [];
    arr.push(r);
    byStage.set(r.stage, arr);
  }
  const groups: StageGroup[] = [];
  // Static rules first (cross-cutting, structural).
  groups.push({
    stage: "static",
    label: "Static (estrutura do repo)",
    rules: STATIC_RULES.map((r) => ({
      id: r.id,
      description: r.description,
      source_issue: extractSourceIssue(r.description),
    })),
  });
  for (const stage of [0, 1, 2, 3, 4, 5, 6] as const) {
    const rules = byStage.get(stage) ?? [];
    if (rules.length === 0) continue;
    groups.push({
      stage,
      label: STAGE_LABELS[stage] ?? `Stage ${stage}`,
      rules: rules.map((r) => ({
        id: r.id,
        description: r.description,
        source_issue: r.source_issue,
      })),
    });
  }
  return groups;
}

/** Heurística: extrai `#NNNN` da string de descrição (STATIC_RULES não tem campo). */
function extractSourceIssue(desc: string): string {
  const m = desc.match(/#(\d+)/);
  return m ? `#${m[1]}` : "—";
}

function renderMarkdown(groups: StageGroup[]): string {
  const lines: string[] = [];
  lines.push("# Editorial invariants (auto-generated)");
  lines.push("");
  lines.push(
    "Gerado por `npx tsx scripts/list-invariants.ts` a partir de " +
      "`scripts/lib/invariant-checks/stage-*.ts` + `STATIC_RULES` em " +
      "`scripts/check-invariants.ts`. **NÃO editar à mão** — re-rodar o " +
      "script regenera.",
  );
  lines.push("");
  lines.push(
    "Cada regra é verificada por `check-invariants.ts` antes do gate " +
      "humano de cada stage. Violations com `severity: error` bloqueiam " +
      "transição; `warning` só registra.",
  );
  lines.push("");
  lines.push(`**Total**: ${groups.reduce((acc, g) => acc + g.rules.length, 0)} invariants.`);
  lines.push("");
  for (const g of groups) {
    lines.push(`## ${g.label}`);
    lines.push("");
    if (g.rules.length === 0) {
      lines.push("_Nenhuma invariant cadastrada._");
      lines.push("");
      continue;
    }
    lines.push("| id | descrição | issue |");
    lines.push("|---|---|---|");
    for (const r of g.rules.slice().sort((a, b) => a.id.localeCompare(b.id))) {
      const desc = r.description.replace(/\|/g, "\\|");
      lines.push(`| \`${r.id}\` | ${desc} | ${r.source_issue} |`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(
    "_Para adicionar nova invariant_: criar função `(editionDir) => " +
      "InvariantViolation[]` em `scripts/lib/invariant-checks/stage-{N}.ts`, " +
      "registrar em `STAGE_N_RULES`, e re-rodar este script.",
  );
  lines.push("");
  return lines.join("\n");
}

export function generateInvariantsMarkdown(): string {
  const groups = groupRules();
  return renderMarkdown(groups);
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const md = generateInvariantsMarkdown();
  if (values.check) {
    const expectedPath = resolve(ROOT, values.check);
    if (!existsSync(expectedPath)) {
      console.error(
        `--check: arquivo ${expectedPath} não existe. Rodar primeiro: ` +
          `npx tsx scripts/list-invariants.ts --out ${values.check}`,
      );
      process.exit(1);
    }
    const existing = readFileSync(expectedPath, "utf8");
    if (existing.trim() !== md.trim()) {
      console.error(
        `--check: ${expectedPath} divergiu do registry. ` +
          `Rodar: npx tsx scripts/list-invariants.ts --out ${values.check}`,
      );
      process.exit(1);
    }
    console.log(`[list-invariants] ${values.check} bate com registry — ok.`);
    return;
  }
  if (values.out) {
    const absOut = resolve(ROOT, values.out);
    mkdirSync(dirname(absOut), { recursive: true });
    writeFileSync(absOut, md, "utf8");
    console.log(`[list-invariants] gravado em ${absOut}`);
    return;
  }
  process.stdout.write(md);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  try {
    main();
  } catch (e) {
    console.error("Fatal:", e);
    process.exit(2);
  }
}
