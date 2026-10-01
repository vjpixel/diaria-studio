import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripEmdashesInFile } from "../scripts/strip-emdashes-reviewed.ts";

describe("strip-emdashes-reviewed (#9379)", () => {
  it("remove travessão reintroduzido pós-humanizador e é idempotente", () => {
    const f = join(mkdtempSync(join(tmpdir(), "emd-")), "02-reviewed.md");
    writeFileSync(f, "setor — times que\nFoo. — Bar\n1989–2002\n", "utf8");
    assert.equal(stripEmdashesInFile(f).count, 2);
    assert.equal(readFileSync(f, "utf8"), "setor, times que\nFoo. Bar\n1989–2002\n");
    assert.deepEqual(stripEmdashesInFile(f), { changed: false, count: 0 });
  });
});
