/**
 * #9581 (regressão #633): diaria-2-escrita só pode apagar snapshots lidos pelos
 * invariantes do sentinel (02-pre-clarice, 02-normalized, 02-humanized) DEPOIS
 * do `pipeline-sentinel.ts write --step 2`, e deve produzir 02-normalized/02-humanized.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const md = readFileSync(join(ROOT, ".claude", "skills", "diaria-2-escrita", "SKILL.md"), "utf8");
const SNAPS = ["02-pre-clarice.md", "02-normalized.md", "02-humanized.md", "03-social-pre-humanizador.md"];

describe("#9581 — cleanup de snapshots do Stage 2 vem depois do sentinel", () => {
  const sentinelIdx = md.indexOf("pipeline-sentinel.ts write");
  assert.ok(sentinelIdx > 0);

  it("nenhum `rm` de snapshot de invariante antes do sentinel write", () => {
    const before = md.slice(0, sentinelIdx);
    for (const s of SNAPS) {
      assert.doesNotMatch(before, new RegExp(`rm [^\\n]*${s.replace(".", "\\.")}`), s);
      assert.doesNotMatch(before, new RegExp(`\\{EDIR\\}/_internal/${s.replace(".", "\\.")}; do`), s);
    }
    assert.doesNotMatch(before, /for f in \\\n\s+\{EDIR\}\/_internal\/02-pre-clarice/);
  });

  it("limpeza existe após o sentinel", () => {
    const after = md.slice(sentinelIdx);
    for (const s of SNAPS) assert.ok(after.includes(`_internal/${s}`), s);
  });

  it("skill produz 02-normalized.md e 02-humanized.md", () => {
    assert.match(md, /cp \{EDIR\}\/_internal\/02-draft\.md \{EDIR\}\/_internal\/02-normalized\.md/);
    assert.match(md, /cp \{EDIR\}\/_internal\/02-draft\.md \{EDIR\}\/_internal\/02-humanized\.md/);
  });
});
