/**
 * test/scheduled-tasks-table-split-14121.test.ts (#14121)
 *
 * A tabela `SCHEDULED_TASKS` saiu de `scripts/lib/scheduled-tasks.ts` para
 * `scripts/lib/scheduled-tasks-table.ts` (só dados). O conteúdo exportado não
 * mudou: na PR do #14121 a lista agregada e as demais exportações foram
 * comparadas por deep-equal com um snapshot tirado no master antes da
 * mudança (133 tasks, 16 exportações). O que fica travado aqui é a forma do
 * split, que é o que poderia regredir depois:
 *   - `scheduled-tasks.ts` re-exporta o MESMO array e as mesmas constantes;
 *   - o arquivo da tabela não tem lógica nem import de valor de
 *     `scheduled-tasks.ts` (ciclo de módulos com TDZ);
 *   - a tabela inteira mora no arquivo de dados, não no de lógica.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as logic from "../scripts/lib/scheduled-tasks.ts";
import * as table from "../scripts/lib/scheduled-tasks-table.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOGIC_SRC = readFileSync(join(ROOT, "scripts", "lib", "scheduled-tasks.ts"), "utf8");
const TABLE_SRC = readFileSync(join(ROOT, "scripts", "lib", "scheduled-tasks-table.ts"), "utf8");

describe("#14121 — split de SCHEDULED_TASKS", () => {
  it("scheduled-tasks.ts re-exporta, por identidade, tudo o que a tabela exporta", () => {
    const tableKeys = Object.keys(table).sort();
    assert.deepEqual(tableKeys, [
      "GOOGLE_ADS_CONFIRMATION_ACTION_ID",
      "GOOGLE_ADS_CONFIRMATION_CUSTOMER_ID",
      "GSC_URL_INSPECTION_DAILY_QUOTA",
      "SCHEDULED_TASKS",
    ]);
    for (const k of tableKeys) {
      assert.equal((logic as Record<string, unknown>)[k], (table as Record<string, unknown>)[k], k);
    }
  });

  it("os helpers do módulo de lógica leem a tabela do arquivo de dados", () => {
    assert.equal(logic.listScheduledTaskNames().length, table.SCHEDULED_TASKS.length);
    const first = table.SCHEDULED_TASKS[0];
    assert.equal(logic.getScheduledTaskByName(first.name), first);
  });

  it("o arquivo da tabela só importa TIPOS de scheduled-tasks.ts e não tem função", () => {
    const imports = [...TABLE_SRC.matchAll(/^import\s.*$/gm)].map((m) => m[0]);
    assert.deepEqual(imports, ['import type { RegisteredScheduledTaskDefinition } from "./scheduled-tasks.ts";']);
    assert.doesNotMatch(TABLE_SRC, /^export (async )?function /m);
    assert.doesNotMatch(TABLE_SRC, /isMainModule|process\.argv/);
  });

  it("nenhuma entrada de task ficou no arquivo de lógica", () => {
    assert.doesNotMatch(LOGIC_SRC, /export const SCHEDULED_TASKS\b/);
    // DESKTOP_SCHEDULED_TASKS (que fica aqui) usa `taskId`, não `name`.
    assert.doesNotMatch(LOGIC_SRC, /^\s+name: "Diaria-/m);
    assert.match(TABLE_SRC, /^export const SCHEDULED_TASKS: RegisteredScheduledTaskDefinition\[\] = \[$/m);
  });
});
