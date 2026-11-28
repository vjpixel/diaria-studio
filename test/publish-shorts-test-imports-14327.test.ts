/**
 * #14327 item 5 (passo 2 da #14204): os testes importam o publisher dos
 * verticais dos módulos de `scripts/publish-shorts/`, nunca da entrada
 * `scripts/publish-shorts.ts`. A entrada carrega o `.env` ao ser importada
 * (`loadProjectEnv()`) e só reexporta para os outros scripts; teste que volta a
 * importar dela puxa o `.env` da máquina e esconde de que módulo vem o código.
 *
 * Menções à entrada que não são import (caminho no `spawnSync`, `readFileSync`
 * do texto, `isSensitivePath`) seguem livres.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(ROOT, "test");

/** Import estático ou dinâmico da entrada a partir de `test/` (aspas simples ou duplas). */
const ENTRY_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*)(["'])\.\.\/scripts\/publish-shorts\.ts\1/;

describe("#14327: testes importam dos módulos de scripts/publish-shorts/", () => {
  it("o padrão reconhece o import da entrada e ignora os módulos e as menções sem import", () => {
    assert.match('import { a } from "../scripts/publish-shorts.ts";', ENTRY_IMPORT_RE);
    assert.match("} from '../scripts/publish-shorts.ts';", ENTRY_IMPORT_RE);
    assert.match('const m = await import("../scripts/publish-shorts.ts");', ENTRY_IMPORT_RE);
    assert.doesNotMatch('import { a } from "../scripts/publish-shorts/plan.ts";', ENTRY_IMPORT_RE);
    assert.doesNotMatch('spawnSync(node, [join(ROOT, "scripts", "publish-shorts.ts")]);', ENTRY_IMPORT_RE);
    assert.doesNotMatch('if (args[0] === "scripts/publish-shorts.ts") return x;', ENTRY_IMPORT_RE);
  });

  it("nenhum arquivo de test/ importa ../scripts/publish-shorts.ts", () => {
    const offenders = readdirSync(TEST_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "publish-shorts-test-imports-14327.test.ts") // este cita o padrão nos exemplos
      .filter((f) => ENTRY_IMPORT_RE.test(readFileSync(join(TEST_DIR, f), "utf8")));
    assert.deepEqual(offenders, [], "importe do módulo em scripts/publish-shorts/ (o reexport da entrada diz qual)");
  });
});
