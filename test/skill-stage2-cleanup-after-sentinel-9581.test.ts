/**
 * #9581 (regressão #633): a Etapa 2 só pode apagar snapshots lidos pelos
 * invariantes do sentinel (02-pre-clarice, 02-normalized, 02-humanized)
 * DEPOIS do `pipeline-sentinel.ts write --step 2`, e deve produzir
 * 02-normalized/02-humanized.
 *
 * #14113: a receita saiu da skill `/diaria-2-escrita`. Quem limpa é o
 * `--phase post-gate` do runner (`STAGE2_SNAPSHOTS`) e, no fallback, o §2d de
 * `orchestrator-stage-2-fallback.md`. O guard cobre os dois.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STAGE2_SNAPSHOTS } from "../scripts/stage-2-run.ts";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const fallback = readFileSync(join(ROOT, ".claude", "agents", "orchestrator-stage-2-fallback.md"), "utf8");
const runner = readFileSync(join(ROOT, "scripts", "stage-2-run.ts"), "utf8");
const SNAPS = ["02-pre-clarice.md", "02-normalized.md", "02-humanized.md", "03-social-pre-humanizador.md"];

describe("#9581 — cleanup de snapshots do Stage 2 vem depois do sentinel", () => {
  it("fallback: nenhum `rm` de snapshot de invariante antes do sentinel write, e a limpeza existe depois", () => {
    const sentinelIdx = fallback.indexOf("npx tsx scripts/pipeline-sentinel.ts write");
    assert.ok(sentinelIdx > 0);
    const before = fallback.slice(0, sentinelIdx);
    const after = fallback.slice(sentinelIdx);
    for (const s of SNAPS) {
      assert.doesNotMatch(before, new RegExp(`rm [^\\n]*${s.replace(".", "\\.")}`), s);
      assert.doesNotMatch(before, new RegExp(`\\{EDITION_DIR\\}/_internal/${s.replace(".", "\\.")}; do`), s);
      assert.ok(after.includes(`{EDITION_DIR}/_internal/${s}`), s);
    }
    assert.match(after, /\[ -f "\$f" \] && rm "\$f"/);
  });

  it("runner: a lista apagada cobre os snapshots e o rm vem depois do sentinel no post-gate", () => {
    for (const s of SNAPS) assert.ok(STAGE2_SNAPSHOTS.includes(`_internal/${s}`), s);
    const post = runner.slice(runner.indexOf("function phasePostGate"));
    const sentinel = post.indexOf("pipeline-sentinel write --step 2");
    const cleanup = post.indexOf("for (const rel of STAGE2_SNAPSHOTS)");
    assert.ok(sentinel > 0 && cleanup > sentinel, "limpeza depois do sentinel");
  });

  it("fallback produz 02-normalized.md e 02-humanized.md", () => {
    assert.match(fallback, /--out \{EDITION_DIR\}\/_internal\/02-normalized\.md/);
    assert.match(fallback, /salve o resultado em \{EDITION_DIR\}\/_internal\/02-humanized\.md/);
  });
});
