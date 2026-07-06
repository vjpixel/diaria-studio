import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveReadPath,
  resolveWritePath,
  existsInEditionDir,
  editionsRoot,
  editionDir,
} from "../scripts/lib/edition-paths.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setup(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "edition-paths-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("resolveReadPath", () => {
  it("prefere _internal/ quando arquivo existe lá", () => {
    const { dir, cleanup } = setup();
    try {
      writeFileSync(join(dir, "_internal", "05-published.json"), "{}");
      const r = resolveReadPath(dir, "05-published.json");
      assert.equal(r, join(dir, "_internal", "05-published.json"));
    } finally {
      cleanup();
    }
  });

  it("fallback pra raiz quando _internal/ não tem", () => {
    const { dir, cleanup } = setup();
    try {
      writeFileSync(join(dir, "05-published.json"), "{}");
      const r = resolveReadPath(dir, "05-published.json");
      assert.equal(r, join(dir, "05-published.json"));
    } finally {
      cleanup();
    }
  });

  it("retorna path da raiz mesmo se nem um nem outro existir (caller checa)", () => {
    const { dir, cleanup } = setup();
    try {
      const r = resolveReadPath(dir, "05-published.json");
      // Quando nenhum existe, retorna raiz (consistente com fallback)
      assert.equal(r, join(dir, "05-published.json"));
    } finally {
      cleanup();
    }
  });
});

describe("resolveWritePath", () => {
  it("sempre _internal/", () => {
    const { dir, cleanup } = setup();
    try {
      const r = resolveWritePath(dir, "06-social-published.json");
      assert.equal(r, join(dir, "_internal", "06-social-published.json"));
    } finally {
      cleanup();
    }
  });
});

describe("existsInEditionDir", () => {
  it("true quando em _internal/", () => {
    const { dir, cleanup } = setup();
    try {
      writeFileSync(join(dir, "_internal", "05-published.json"), "{}");
      assert.equal(existsInEditionDir(dir, "05-published.json"), true);
    } finally {
      cleanup();
    }
  });

  it("true quando na raiz", () => {
    const { dir, cleanup } = setup();
    try {
      writeFileSync(join(dir, "05-published.json"), "{}");
      assert.equal(existsInEditionDir(dir, "05-published.json"), true);
    } finally {
      cleanup();
    }
  });

  it("false quando nenhum dos 2 existe", () => {
    const { dir, cleanup } = setup();
    try {
      assert.equal(existsInEditionDir(dir, "05-published.json"), false);
    } finally {
      cleanup();
    }
  });
});

describe("editionsRoot / editionDir (#2463 — centralização do path da edição)", () => {
  it("editionsRoot retorna data/editions (relativo)", () => {
    assert.equal(editionsRoot(), join("data", "editions"));
  });

  it("editionDir retorna o path NESTED data/editions/{AAMM}/{AAMMDD} (#2463)", () => {
    assert.equal(editionDir("260627"), join("data", "editions", "2606", "260627"));
    assert.equal(editionDir("260101"), join("data", "editions", "2601", "260101"));
    assert.equal(editionDir("260706"), join("data", "editions", "2607", "260706"));
  });

  it("editionDir valida AAMMDD (exatamente 6 dígitos) — rejeita inválidos", () => {
    assert.throws(() => editionDir("2606"), /AAMMDD inválido/);
    assert.throws(() => editionDir("26062"), /AAMMDD inválido/);
    assert.throws(() => editionDir("2606277"), /AAMMDD inválido/);
    assert.throws(() => editionDir("26june"), /AAMMDD inválido/);
    assert.throws(() => editionDir(""), /AAMMDD inválido/);
  });

  it("layout é nested — subfolder AAMM presente (#2463)", () => {
    assert.ok(editionDir("260627").includes(join("2606", "260627")), "nested por mês");
  });
});
