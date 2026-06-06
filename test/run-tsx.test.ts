/**
 * test/run-tsx.test.ts (#1811)
 *
 * Helper compartilhado de spawn tsx (consolidou eia-compose + preflight) +
 * a validação de calendário do AAMMDD no add-valid-edition.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tsxStdio, runTsx } from "../scripts/lib/run-tsx.ts";
import { run as addValidEdition } from "../scripts/add-valid-edition.ts";

describe("tsxStdio (#1811)", () => {
  it("mapeia modo → stdio (stdin/stderr sempre inherit)", () => {
    assert.deepEqual(tsxStdio("capture"), ["inherit", "pipe", "inherit"]);
    assert.deepEqual(tsxStdio("ignore"), ["inherit", "ignore", "inherit"]);
    assert.deepEqual(tsxStdio("inherit"), ["inherit", "inherit", "inherit"]);
  });
});

describe("runTsx capture (#1811)", () => {
  it("captura o stdout de um script tsx", () => {
    const dir = mkdtempSync(join(tmpdir(), "runtsx-"));
    const script = join(dir, "echo.ts");
    writeFileSync(script, `process.stdout.write("hello-" + (2 + 2));\n`);
    const out = runTsx(script, [], { stdout: "capture" });
    assert.equal(out.trim(), "hello-4");
  });
  it("ignore não retorna stdout", () => {
    const dir = mkdtempSync(join(tmpdir(), "runtsx-"));
    const script = join(dir, "echo2.ts");
    writeFileSync(script, `process.stdout.write("nope");\n`);
    const out = runTsx(script, [], { stdout: "ignore" });
    assert.equal(out, "");
  });
});

describe("add-valid-edition rejeita data inválida (#1811)", () => {
  // A validação roda ANTES do wranglerKvGet (network), então o reject é testável
  // sem wrangler; o happy-path precisa de KV e fica fora do unit.
  it("rejeita mês/dia impossíveis antes de tocar o KV (260631, 261301)", () => {
    assert.throws(() => addValidEdition({ edition: "260631", remove: false }), /válid/);
    assert.throws(() => addValidEdition({ edition: "261301", remove: false }), /válid/);
    assert.throws(() => addValidEdition({ edition: "26051", remove: false }), /válid/);
  });
});
