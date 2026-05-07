/**
 * test/image-generate-parse-args.test.ts (#924)
 *
 * Cobre o parser custom de scripts/image-generate.ts. Antes do fix,
 * `--force` no fim da linha era silenciosamente ignorado (parser exigia
 * value pra cada flag). Agora trata flags sem value como boolean true.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../scripts/image-generate.ts";

describe("image-generate parseArgs (#924)", () => {
  it("trata --force no fim da linha como true (regressão do bug)", () => {
    const r = parseArgs([
      "--editorial",
      "prompt.md",
      "--out-dir",
      "data/",
      "--destaque",
      "d1",
      "--force",
    ]);
    assert.equal(r["force"], true);
    assert.equal(r["editorial"], "prompt.md");
    assert.equal(r["out-dir"], "data/");
    assert.equal(r["destaque"], "d1");
  });

  it("trata --force seguido por outro flag como true (boolean entre value flags)", () => {
    const r = parseArgs([
      "--force",
      "--editorial",
      "prompt.md",
      "--destaque",
      "d2",
    ]);
    assert.equal(r["force"], true);
    assert.equal(r["editorial"], "prompt.md");
    assert.equal(r["destaque"], "d2");
  });

  it("dois booleans seguidos: ambos detectados", () => {
    const r = parseArgs(["--force", "--verbose"]);
    assert.equal(r["force"], true);
    assert.equal(r["verbose"], true);
  });

  it("flag com value no meio + boolean no final", () => {
    const r = parseArgs([
      "--out-dir",
      "data/x/",
      "--force",
    ]);
    assert.equal(r["out-dir"], "data/x/");
    assert.equal(r["force"], true);
  });

  it("regression: --force seguido por value não-flag (legacy `--force 1`)", () => {
    // Pré-fix, editor passava `--force 1` pra workaround.
    // Pós-fix, `1` vira value de --force (string "1"), continua truthy
    // pelo `!!args["force"]` no main.
    const r = parseArgs(["--force", "1", "--destaque", "d1"]);
    assert.equal(r["force"], "1");
    assert.equal(!!r["force"], true);
    assert.equal(r["destaque"], "d1");
  });

  it("flags vanilla com values continuam funcionando (regression)", () => {
    const r = parseArgs([
      "--editorial",
      "data/editions/260507/_internal/02-d1-prompt.md",
      "--out-dir",
      "data/editions/260507",
      "--destaque",
      "d1",
    ]);
    assert.equal(r["editorial"], "data/editions/260507/_internal/02-d1-prompt.md");
    assert.equal(r["out-dir"], "data/editions/260507");
    assert.equal(r["destaque"], "d1");
    assert.equal(r["force"], undefined);
  });

  it("argv vazio retorna objeto vazio", () => {
    assert.deepEqual(parseArgs([]), {});
  });
});
