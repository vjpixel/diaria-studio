/**
 * #9379 — o playbook do Stage 2 precisa mandar rodar strip-emdashes-reviewed.ts
 * após a Clarice e ANTES do sync do bloco É IA? (senão o travessão removido só
 * no mirror volta, achado 260817).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const md = readFileSync(".claude/agents/orchestrator-stage-2.md", "utf8");

describe("orchestrator-stage-2.md: strip de travessão (#9379)", () => {
  it("referencia o script e ele existe", () => {
    assert.match(md, /scripts\/strip-emdashes-reviewed\.ts --edition-dir \{EDITION_DIR\}/);
    assert.ok(existsSync("scripts/strip-emdashes-reviewed.ts"));
  });

  it("strip vem antes do sync-eia-block", () => {
    const strip = md.indexOf("strip-emdashes-reviewed.ts --edition-dir");
    const sync = md.indexOf("sync-eia-block.ts --edition-dir");
    assert.ok(strip >= 0 && sync >= 0, "ambos os comandos devem estar no playbook");
    assert.ok(strip < sync, "strip deve preceder o sync do bloco É IA?");
  });
});
