/**
 * #5995 (achado 260903, review PR #7331): `parseArgsSimple` tratava TODO
 * `--flag` como `--flag valor` — `--rules --editions-dir X` fazia
 * `values["rules"] = "--editions-dir"` e `X` nunca era lido como
 * editions-dir (caía no default `data/editions`, inexistente em worktree de
 * subagente — "diretório não encontrado" mesmo com o path certo passado).
 * `analyze-bucket-overrides.ts` trocou pra `parseArgs` (flags/values
 * separados) e extraiu `resolveCliOptions()` como função pura testável.
 * Este teste trava que a ordem dos argumentos deixa de importar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { resolveCliOptions } from "../scripts/analyze-bucket-overrides.ts";

const ROOT = "/repo";

describe("resolveCliOptions (#5995, review PR #7331) — ordem de argumentos não deve importar", () => {
  it("--rules --editions-dir X lê X corretamente (ordem que quebrava com parseArgsSimple)", () => {
    const opts = resolveCliOptions(["--rules", "--editions-dir", "/custom/editions"], ROOT);
    assert.equal(opts.editionsDir, "/custom/editions");
    assert.equal(opts.rulesMode, true);
  });

  it("--editions-dir X --rules lê X corretamente (ordem inversa, já funcionava antes)", () => {
    const opts = resolveCliOptions(["--editions-dir", "/custom/editions", "--rules"], ROOT);
    assert.equal(opts.editionsDir, "/custom/editions");
    assert.equal(opts.rulesMode, true);
  });

  it("as duas ordens resolvem exatamente o mesmo editionsDir", () => {
    const a = resolveCliOptions(["--rules", "--editions-dir", "/custom/editions"], ROOT);
    const b = resolveCliOptions(["--editions-dir", "/custom/editions", "--rules"], ROOT);
    assert.equal(a.editionsDir, b.editionsDir);
    assert.equal(a.rulesMode, b.rulesMode);
  });

  it("--json --rules --editions-dir X (3 flags, 2 booleanas antes do value) lê X corretamente", () => {
    const opts = resolveCliOptions(["--json", "--rules", "--editions-dir", "/custom/editions"], ROOT);
    assert.equal(opts.editionsDir, "/custom/editions");
    assert.equal(opts.asJson, true);
    assert.equal(opts.rulesMode, true);
  });

  it("sem --editions-dir cai no default 'data/editions' resolvido contra root", () => {
    const opts = resolveCliOptions(["--rules"], ROOT);
    assert.equal(opts.editionsDir, resolve(ROOT, "data/editions"));
  });

  it("--window e --examples continuam lidos independente da posição de --rules/--json", () => {
    const opts = resolveCliOptions(["--rules", "--window", "10", "--examples", "3"], ROOT);
    assert.equal(opts.window, 10);
    assert.equal(opts.examplesPerDirection, 3);
  });

  it("sem --rules, rulesMode é false (modo diff padrão)", () => {
    const opts = resolveCliOptions(["--editions-dir", "/custom/editions"], ROOT);
    assert.equal(opts.rulesMode, false);
    assert.equal(opts.asJson, false);
  });
});
