import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveReadPath,
  resolveWritePath,
  existsInEditionDir,
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
