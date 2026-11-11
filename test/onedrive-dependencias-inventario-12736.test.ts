/**
 * test/onedrive-dependencias-inventario-12736.test.ts (#12736)
 *
 * O apêndice A de `docs/onedrive-dependencias-cloudflare.md` lista cada task
 * agendada com os grupos de dependência do `data/` sincronizado (seção 4 do
 * mesmo documento). O mapa é a base para decidir o que migra para a
 * Cloudflare; uma task que entra no registro sem linha ali fica fora da
 * decisão sem ninguém notar (foi o caso de `Diaria-Agendamentos-Tick`, #12774,
 * registrada um dia depois da medição).
 *
 * Este teste trava o apêndice contra `SCHEDULED_TASKS` e
 * `DESKTOP_SCHEDULED_TASKS`: toda task tem exatamente uma linha, nenhuma
 * linha sobra de task que saiu do registro, e a coluna de grupos cita só
 * grupos que têm seção `### Gn.` no documento.
 *
 * As funções de checagem são puras e testadas com fixture; o caso real lê o
 * documento e o registro do repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_SCHEDULED_TASKS, SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH = resolve(ROOT, "docs/onedrive-dependencias-cloudflare.md");
const APPENDIX_HEADING = "## Apêndice A.";

export interface AppendixRow {
  readonly task: string;
  readonly groups: readonly string[];
}

/** Trecho do documento a partir do cabeçalho do apêndice A (até o próximo `## `). */
export function appendixSection(doc: string): string {
  const start = doc.indexOf(APPENDIX_HEADING);
  if (start === -1) throw new Error(`cabeçalho "${APPENDIX_HEADING}" não encontrado`);
  const rest = doc.slice(start + APPENDIX_HEADING.length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Linhas da tabela do apêndice: 1ª coluna = nome da task, última = grupos. */
export function parseAppendixRows(section: string): AppendixRow[] {
  const rows: AppendixRow[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const task = cells[0];
    if (!task || task === "Task" || /^-+$/.test(task)) continue;
    const groups = [...(cells[cells.length - 1] ?? "").matchAll(/\bG(\d+)\b/g)].map((m) => `G${m[1]}`);
    rows.push({ task, groups });
  }
  return rows;
}

/** Grupos com seção própria (`### Gn.`) no documento. */
export function definedGroups(doc: string): Set<string> {
  return new Set([...doc.matchAll(/^### (G\d+)\./gm)].map((m) => m[1]));
}

export interface InventoryProblems {
  readonly missing: string[];
  readonly stale: string[];
  readonly duplicated: string[];
  readonly withoutGroups: string[];
  readonly unknownGroups: string[];
}

export function findInventoryProblems(
  rows: readonly AppendixRow[],
  taskNames: readonly string[],
  groups: ReadonlySet<string>,
): InventoryProblems {
  const listed = rows.map((r) => r.task);
  const registered = new Set(taskNames);
  return {
    missing: taskNames.filter((n) => !listed.includes(n)),
    stale: listed.filter((n) => !registered.has(n)),
    duplicated: [...new Set(listed.filter((n, i) => listed.indexOf(n) !== i))],
    withoutGroups: rows.filter((r) => r.groups.length === 0).map((r) => r.task),
    unknownGroups: rows.flatMap((r) => r.groups.filter((g) => !groups.has(g)).map((g) => `${r.task}: ${g}`)),
  };
}

const FIXTURE = [
  "### G1. Um",
  "### G2. Dois",
  "## Apêndice A. Tasks",
  "",
  "Task fora do systemd: `tarefa-desktop` (Neo), grupos G2.",
  "",
  "| Task | Agenda | Grupos |",
  "|---|---|---|",
  "| Diaria-A | daily | G1, G2 |",
  "| Diaria-B | daily | G2 (nota com G1 no texto) |",
  "",
  "## Outra seção",
  "| Diaria-Fora | daily | G1 |",
].join("\n");

describe("#12736 — inventário do apêndice A (funções puras)", () => {
  it("lê só a tabela do apêndice, com nome e grupos", () => {
    const rows = parseAppendixRows(appendixSection(FIXTURE));
    assert.deepEqual(rows, [
      { task: "Diaria-A", groups: ["G1", "G2"] },
      { task: "Diaria-B", groups: ["G2", "G1"] },
    ]);
  });

  it("aponta task faltando, linha sobrando, duplicada, sem grupo e grupo inexistente", () => {
    const rows: AppendixRow[] = [
      { task: "Diaria-A", groups: ["G1"] },
      { task: "Diaria-A", groups: ["G1"] },
      { task: "Diaria-Velha", groups: ["G2"] },
      { task: "Diaria-C", groups: [] },
      { task: "Diaria-D", groups: ["G9"] },
    ];
    const problems = findInventoryProblems(rows, ["Diaria-A", "Diaria-C", "Diaria-D", "Diaria-Nova"], new Set(["G1", "G2"]));
    assert.deepEqual(problems, {
      missing: ["Diaria-Nova"],
      stale: ["Diaria-Velha"],
      duplicated: ["Diaria-A"],
      withoutGroups: ["Diaria-C"],
      unknownGroups: ["Diaria-D: G9"],
    });
  });

  it("documento sem apêndice falha alto", () => {
    assert.throws(() => appendixSection("# nada aqui"), /Apêndice A/);
  });
});

describe("#12736 — docs/onedrive-dependencias-cloudflare.md ↔ registro de tasks", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  const section = appendixSection(doc);

  it("toda task de SCHEDULED_TASKS tem uma linha com grupos válidos no apêndice A", () => {
    const problems = findInventoryProblems(
      parseAppendixRows(section),
      SCHEDULED_TASKS.map((t) => t.name),
      definedGroups(doc),
    );
    assert.deepEqual(
      problems,
      { missing: [], stale: [], duplicated: [], withoutGroups: [], unknownGroups: [] },
      "Apêndice A de docs/onedrive-dependencias-cloudflare.md fora do registro. " +
        "Task nova: acrescente uma linha na tabela com os grupos da seção 4 (grupo novo ganha seção `### Gn.`). " +
        "Task removida: tire a linha.",
    );
  });

  it("toda task do app desktop é citada no apêndice A", () => {
    const missing = DESKTOP_SCHEDULED_TASKS.map((t) => t.taskId).filter((id) => !section.includes(`\`${id}\``));
    assert.deepEqual(missing, [], "task do app desktop sem menção no apêndice A (linha 'Task fora do systemd')");
  });
});
