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
 *   - a tabela inteira mora no arquivo de dados, não no de lógica;
 *   - o conjunto de NOMES das tasks bate com o registrado (contagem + sha256
 *     dos nomes ordenados): uma task que some da tabela sem querer quebra
 *     aqui. O drift test do registro só confere tabela -> doc.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
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

  it("todo top-level da tabela é `import type` ou `export const` de dado (sem função, classe nem chamada)", () => {
    const sf = ts.createSourceFile("scheduled-tasks-table.ts", TABLE_SRC, ts.ScriptTarget.Latest, true);
    const bad: string[] = [];
    for (const st of sf.statements) {
      const line = sf.getLineAndCharacterOfPosition(st.getStart()).line + 1;
      if (ts.isImportDeclaration(st)) {
        if (!st.importClause?.isTypeOnly) bad.push(`linha ${line}: import de valor`);
        continue;
      }
      const isExportConst =
        ts.isVariableStatement(st) &&
        (st.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        (ts.getCombinedModifierFlags(st.declarationList.declarations[0]) & ts.ModifierFlags.Export) !== 0;
      if (!isExportConst) {
        bad.push(`linha ${line}: ${ts.SyntaxKind[st.kind]}`);
        continue;
      }
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        const ok =
          !!init &&
          (ts.isArrayLiteralExpression(init) || ts.isStringLiteral(init) || ts.isNumericLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init));
        if (!ok) bad.push(`linha ${line}: ${d.name.getText(sf)} = ${init ? ts.SyntaxKind[init.kind] : "sem valor"}`);
      }
    }
    // E nenhuma função/classe em lugar nenhum do arquivo (nem dentro de uma entrada).
    const visit = (n: ts.Node): void => {
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isClassLike(n)) {
        bad.push(`linha ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${ts.SyntaxKind[n.kind]}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    assert.deepEqual(bad, []);
  });

  it("os nomes das tasks batem com o registrado (task sumida ou nova quebra aqui)", () => {
    // Ao adicionar, renomear ou retirar uma task de propósito, atualize os 2
    // valores abaixo com o que a falha imprime (e a prosa do registro).
    const EXPECTED_COUNT = 133;
    const EXPECTED_SHA256 = "69bf2d88fe8ae0889d2b7b421d515c012a2a03fc60a5f35831ffb37d8c37e9e3";
    const names = table.SCHEDULED_TASKS.map((t) => t.name).sort();
    const sha = createHash("sha256").update(names.join("\n")).digest("hex");
    assert.equal(new Set(names).size, names.length, "nome de task duplicado");
    assert.deepEqual(
      { count: names.length, sha },
      { count: EXPECTED_COUNT, sha: EXPECTED_SHA256 },
      `nomes atuais (ordenados):\n${names.join("\n")}`,
    );
  });

  it("nenhuma entrada de task ficou no arquivo de lógica", () => {
    assert.doesNotMatch(LOGIC_SRC, /export const SCHEDULED_TASKS\b/);
    // DESKTOP_SCHEDULED_TASKS (que fica aqui) usa `taskId`, não `name`.
    assert.doesNotMatch(LOGIC_SRC, /^\s+name: "Diaria-/m);
    assert.match(TABLE_SRC, /^export const SCHEDULED_TASKS: RegisteredScheduledTaskDefinition\[\] = \[$/m);
  });
});
