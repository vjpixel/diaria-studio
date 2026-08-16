/**
 * test/scheduled-tasks-drift.test.ts (#5408)
 *
 * Teste de drift doc↔código: assertar que `docs/scheduled-tasks-registry.md`
 * menciona TODO `SCHEDULED_TASKS[].name` do registro declarativo
 * (`scripts/lib/scheduled-tasks.ts`). Sem isto, o doc de prosa podia ficar
 * pra trás silenciosamente (achado ao vivo #5408: 4 tasks — `Diaria-Clarice-Cohorts-Crawl`,
 * `Diaria-SEO-Weekly`, `Diaria-Acquisition-Health-Alarm`,
 * `Diaria-Bing-Seo-Monthly-Pull` — nunca tinham entrada no doc; corrigido
 * na mesma unidade que este teste).
 *
 * A checagem em si (`findMissingTaskNames`) é uma função pura testável com
 * fixtures — não mexe em `SCHEDULED_TASKS` real (é `const` exportado,
 * mutá-lo afetaria outros arquivos de teste rodando no mesmo processo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_DOC_PATH = resolve(ROOT, "docs/scheduled-tasks-registry.md");

/** Nomes de `taskNames` que NÃO aparecem (substring literal) em `docContent`
 * — vazio significa "nenhum drift". Substring simples (não regex, não
 * word-boundary) é suficiente aqui: os nomes são identificadores únicos
 * tipo `Diaria-Foo-Bar`, sem risco real de match parcial indesejado dentro
 * de um doc de prosa que os cita entre crases. */
export function findMissingTaskNames(taskNames: string[], docContent: string): string[] {
  return taskNames.filter((name) => !docContent.includes(name));
}

describe("#5408 — drift doc↔código: docs/scheduled-tasks-registry.md ↔ SCHEDULED_TASKS", () => {
  it("todo SCHEDULED_TASKS[].name aparece em docs/scheduled-tasks-registry.md", () => {
    const doc = readFileSync(REGISTRY_DOC_PATH, "utf8");
    const missing = findMissingTaskNames(
      SCHEDULED_TASKS.map((t) => t.name),
      doc,
    );
    assert.deepEqual(
      missing,
      [],
      `task(s) do registro sem menção em docs/scheduled-tasks-registry.md: ${missing.join(", ")} — adicionar um parágrafo lá (mesmo estilo das entradas existentes) antes de mergear`,
    );
  });

  // --- Cobertura do helper em si, via fixture (não mexe no registro real) ---

  it("findMissingTaskNames: doc completo → nenhum nome faltando", () => {
    const names = ["Diaria-Fixture-A", "Diaria-Fixture-B"];
    const doc = "Task `Diaria-Fixture-A` roda diária. Task `Diaria-Fixture-B` roda semanal.";
    assert.deepEqual(findMissingTaskNames(names, doc), []);
  });

  it("findMissingTaskNames: task existente no array mas ausente do doc → falha detectada (regressão exigida pelo #5408)", () => {
    const names = ["Diaria-Fixture-A", "Diaria-Fixture-B"];
    // Doc só menciona a 1ª — simula exatamente o drift real que motivou a
    // issue (task nova no .ts, esquecida no .md).
    const doc = "Task `Diaria-Fixture-A` roda diária.";
    assert.deepEqual(findMissingTaskNames(names, doc), ["Diaria-Fixture-B"]);
  });

  it("findMissingTaskNames: array vazio → nenhum nome faltando, mesmo com doc vazio", () => {
    assert.deepEqual(findMissingTaskNames([], ""), []);
  });
});
