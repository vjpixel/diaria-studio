/**
 * test/write-files-verified.test.ts (#9173)
 *
 * Regressão: swap-destaque(s).ts gravavam 01-approved*.json e 02-reviewed.md
 * com writeFileSync cru — sem verificação pós-escrita nem rollback — numa
 * pasta sincronizada pelo OneDrive. Agora passam por writeFilesVerified.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeFilesVerified,
  type WriteFilesVerifiedDeps,
} from "../scripts/lib/write-files-verified.ts";

/** fs em memória com hook para simular o sync revertendo/descartando escritas. */
function memFs(initial: Record<string, string>, onWrite?: (path: string, n: number, fs: Map<string, Buffer>) => void) {
  const files = new Map<string, Buffer>(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  let n = 0;
  const deps: WriteFilesVerifiedDeps = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      const b = files.get(p);
      if (!b) throw new Error(`ENOENT ${p}`);
      return Buffer.from(b);
    },
    writeFileSync: (p, d) => {
      files.set(p, Buffer.from(d));
      n++;
      onWrite?.(p, n, files);
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
  };
  return { files, deps };
}

describe("writeFilesVerified (#9173)", () => {
  it("grava o lote no disco real", () => {
    const dir = mkdtempSync(join(tmpdir(), "wfv-"));
    try {
      const a = join(dir, "a.json");
      const b = join(dir, "b.md");
      writeFileSync(a, "old");
      writeFilesVerified(
        [
          { path: a, content: '{"x":1}\n' },
          { path: b, content: "# md ção\n" },
        ],
        "test",
      );
      assert.equal(readFileSync(a, "utf8"), '{"x":1}\n');
      assert.equal(readFileSync(b, "utf8"), "# md ção\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lote vazio é no-op", () => {
    writeFilesVerified([], "test");
  });

  it("escrita descartada logo após (arquivo some) → lança e reverte o lote", () => {
    const { files, deps } = memFs({ "/e/a.json": "A0", "/e/b.md": "B0" }, (p, _n, fs) => {
      if (p === "/e/b.md" && fs.get(p)?.toString() === "B1") fs.delete(p);
    });
    assert.throws(
      () =>
        writeFilesVerified(
          [
            { path: "/e/a.json", content: "A1" },
            { path: "/e/b.md", content: "B1" },
          ],
          "swap-destaques",
          deps,
        ),
      /swap-destaques: escrita de b\.md .*não existe/,
    );
    assert.equal(files.get("/e/a.json")?.toString(), "A0");
    assert.equal(files.get("/e/b.md")?.toString(), "B0");
  });

  it("reversão pós-hoc (a volta ao antigo enquanto b é gravado) → verificação final pega e reverte", () => {
    const { files, deps } = memFs({ "/e/a.json": "A0", "/e/b.md": "B0" }, (p, _n, fs) => {
      // Enquanto b é escrito, o "sync" restaura a versão antiga de a.
      if (p === "/e/b.md" && fs.get(p)?.toString() === "B1") fs.set("/e/a.json", Buffer.from("A0"));
    });
    assert.throws(
      () =>
        writeFilesVerified(
          [
            { path: "/e/a.json", content: "A1" },
            { path: "/e/b.md", content: "B1" },
          ],
          "swap-destaque",
          deps,
        ),
      /a\.json não bate com o conteúdo esperado/,
    );
    assert.equal(files.get("/e/a.json")?.toString(), "A0");
    assert.equal(files.get("/e/b.md")?.toString(), "B0");
  });

  it("rollback remove arquivo que não existia antes do lote", () => {
    const { files, deps } = memFs({ "/e/a.json": "A0" }, (p, _n, fs) => {
      if (p === "/e/a.json" && fs.get(p)?.toString() === "A1") fs.delete(p);
    });
    assert.throws(() =>
      writeFilesVerified(
        [
          { path: "/e/new.md", content: "N1" },
          { path: "/e/a.json", content: "A1" },
        ],
        "t",
        deps,
      ),
    );
    assert.equal(files.has("/e/new.md"), false);
    assert.equal(files.get("/e/a.json")?.toString(), "A0");
  });
});

describe("swap-destaque(s).ts usam escrita verificada (#9173)", () => {
  for (const script of ["scripts/swap-destaques.ts", "scripts/swap-destaque.ts"]) {
    it(`${script} não grava conteúdo com writeFileSync cru`, () => {
      const src = readFileSync(join(import.meta.dirname, "..", script), "utf8");
      assert.match(src, /writeFilesVerified\(/);
      assert.doesNotMatch(src, /\bwriteFileSync\b/);
    });
  }
});
