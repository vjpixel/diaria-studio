/**
 * test/edition-utils-4308.test.ts (#4308, regressão #633)
 *
 * `scripts/lib/edition-utils.ts` computava `ROOT`/`EDITIONS_DIR` no TOP LEVEL
 * do módulo (eager), via `fileURLToPath(import.meta.url)`. O módulo é
 * importado TRANSITIVAMENTE por `isValidEditionDir` — reexportado por
 * `dedup.ts` (via `past-editions-extract.ts`), importado por
 * `canonical-urls.ts`, importado por `curadoria-page.ts` (#4265 item 9) —
 * cadeia que, desde #4299, passou a ser puxada pelo worker `arquivo`
 * (`render-archive.ts`). O bundle do Wrangler executa o top level do módulo
 * dentro do runtime de Workers, onde `import.meta.url` não resolve como no
 * Node; `fileURLToPath(undefined)` derrubou o deploy do worker `arquivo`
 * (`gh run 30468902827`) mesmo o worker nunca chamando
 * `listEditions`/`getPreviousEditionDate` (só a função pura
 * `isValidEditionDir`, que não depende de ROOT).
 *
 * Esse crash NÃO reproduz em `node:test` (o Node sempre resolve
 * `import.meta.url` pra uma string válida — só o bundle de Workers expõe o
 * bug), então a regressão real é travada por um teste ESTRUTURAL: garante
 * que `fileURLToPath` nunca é chamado no TOP LEVEL do módulo (só dentro de
 * uma função, invocada sob demanda) — a causa raiz exata do #4308.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { isValidEditionDir, listEditions, getPreviousEditionDate } from "../scripts/lib/edition-utils.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(HERE, "..", "scripts", "lib", "edition-utils.ts");

describe("edition-utils.ts (#4308) — ROOT/EDITIONS_DIR não são eager no top level", () => {
  it("fileURLToPath(import.meta.url) não aparece numa declaração de TOP LEVEL (coluna 0)", () => {
    const src = readFileSync(SOURCE_PATH, "utf8");
    // Regressão exata do #4308: `const ROOT = resolve(dirname(fileURLToPath(...)))`
    // solto no top level do módulo, executado no import — nunca deve reaparecer
    // fora de uma função.
    const eagerTopLevel = /^const\s+\w+\s*=[^\n]*fileURLToPath/m.test(src);
    assert.equal(
      eagerTopLevel,
      false,
      "fileURLToPath(import.meta.url) voltou a aparecer numa const de top level — " +
        "isso quebra qualquer bundle (Workers) que importe este módulo transitivamente " +
        "só por uma função pura (#4308)",
    );
  });

  it("o path default é computado por uma função lazy (chamada sob demanda, não no import)", () => {
    const src = readFileSync(SOURCE_PATH, "utf8");
    assert.match(
      src,
      /function\s+defaultEditionsDir\s*\(\)/,
      "esperava um helper lazy (`defaultEditionsDir()`) computando o path sob demanda",
    );
  });

  it("isValidEditionDir (função pura, a única que o worker `arquivo` de fato usa) não depende de ROOT", () => {
    // Sanity check comportamental: continua funcionando após o refactor.
    assert.equal(isValidEditionDir("260427"), true);
    assert.equal(isValidEditionDir("260999"), false); // dia 99 inválido
    assert.equal(isValidEditionDir("abc"), false);
  });

  it("listEditions()/getPreviousEditionDate() sem editionsDir explícito continuam funcionando (lazy default)", () => {
    // Sem argumento — exercita o branch `defaultEditionsDir()` de verdade.
    // Não assume nada sobre o conteúdo de data/editions/ (pode nem existir
    // num clone sem o junction, #2643) — só que a chamada não lança.
    assert.doesNotThrow(() => listEditions());
    assert.throws(() => getPreviousEditionDate("invalid"), /AAMMDD inválido/);
  });
});
