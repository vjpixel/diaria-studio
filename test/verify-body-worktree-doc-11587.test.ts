/**
 * #11587 — toda instrução de `gh-pr-safe-edit.ts --verify-body` nos agents
 * dev-* e nas skills de rodada autônoma passa `--worktree`.
 *
 * Desde o #11566 o `--verify-body` também confere o `headRefOid` da PR contra
 * o HEAD do checkout em `--worktree` (default cwd). Na PR do design o helper
 * roda do checkout do studio, então sem a flag a conferência olha o checkout
 * errado e só avisa — a PR fica sem a proteção contra branch sobrada de PR
 * mergeada. Este teste trava que as menções do comando citem a flag.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const FILES = [
  ".claude/agents/dev-implementador.md",
  ".claude/skills/diaria-overnight/SKILL.md",
  ".claude/skills/diaria-develop/SKILL.md",
  ".claude/skills/diaria-continuo/SKILL.md",
  "context/overnight-dispatch-rules.md",
];

/** Trechos de código inline (`...`) que mandam rodar `--verify-body`. */
function verifyBodyInvocations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`]*--verify-body[^`]*)`/g)) {
    const snippet = m[1];
    // Menção solta da flag (ex.: "`--verify-body` também confere...") não é invocação.
    if (!/gh-pr-safe-edit|--pr\b/.test(snippet)) continue;
    out.push(snippet);
  }
  return out;
}

describe("#11587 — --verify-body cita --worktree", () => {
  for (const rel of FILES) {
    it(`${rel}: toda invocação de --verify-body passa --worktree`, () => {
      const text = readFileSync(join(ROOT, rel), "utf8");
      const calls = verifyBodyInvocations(text);
      assert.ok(calls.length > 0, `${rel} não cita nenhuma invocação de --verify-body`);
      const missing = calls.filter((c) => !c.includes("--worktree"));
      if (rel === "context/overnight-dispatch-rules.md") {
        // Em PR do studio o helper roda no próprio worktree (cwd = default);
        // a chamada do design (item 32) é a que precisa da flag.
        assert.ok(
          calls.some((c) => c.includes("--repo") && c.includes("--worktree")),
          "item 32 deve citar --worktree na conferência da PR do design",
        );
        return;
      }
      assert.deepEqual(missing, [], `${rel}: invocação sem --worktree`);
    });
  }
});
