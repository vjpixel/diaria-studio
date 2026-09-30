/**
 * test/hook-tokenizer-herestring-escape-9197.test.ts (#9197)
 *
 * Três falsos negativos (fail-open) nos hooks PreToolUse:
 *
 * 1. `stripHeredocSpans` tratava here-string (`<<<`) como heredoc: no 2º `<`,
 *    `<<palavra` casava e o "corpo" engolia o resto do comando.
 * 2. `stripQuotedSpans` não pulava `\x` fora de aspas: `don\'t` abria um span
 *    que engolia o resto do comando.
 * 3. Entry guard `import.meta.url === \`file://${argv1}\``: com espaço ou
 *    caractere não-ASCII no path, `import.meta.url` vem percent-encoded, a
 *    comparação falha e o hook não faz nada, sem erro.
 *
 * A paridade entre as cópias segue travada em
 * `test/hook-command-tokenizer-parity-7896.test.ts` (casos novos adicionados lá)
 * — é por ela que a cópia de `block-unsafe-shared-checkout-ops.mjs` (sem
 * `.d.mts`) fica coberta: os casos abaixo afirmam o valor exato da cópia B e a
 * paridade afirma A === B.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stripQuotedSpans as stripQuotedB,
  stripHeredocSpans as stripHeredocB,
  commandHasBareGitPush,
} from "../.claude/hooks/block-worktree-bare-push.mjs";
import {
  stripQuotedSpans as stripQuotedC,
  stripHeredocSpans as stripHeredocC,
  commandHasHandwrittenPrChecksLoop,
} from "../.claude/hooks/block-handwritten-pr-checks-loop.mjs";
import { stripHeredocSpans as stripHeredocD } from "../.claude/hooks/block-npm-install-node-modules-symlink.mjs";

const HOOKS_DIR = join(import.meta.dirname, "..", ".claude", "hooks");

const HEREDOC_IMPLS = [
  ["block-worktree-bare-push", stripHeredocB],
  ["block-handwritten-pr-checks-loop", stripHeredocC],
  ["block-npm-install-node-modules-symlink", stripHeredocD],
] as const;

const QUOTED_IMPLS = [
  ["block-worktree-bare-push", stripQuotedB],
  ["block-handwritten-pr-checks-loop", stripQuotedC],
] as const;

describe("stripHeredocSpans: here-string não é heredoc (#9197 item 1)", () => {
  for (const [name, strip] of HEREDOC_IMPLS) {
    it(`${name}: \`<<<\` preserva o comando seguinte`, () => {
      const cmd = "cat <<< foo\ngit push\nfoo";
      assert.equal(strip(cmd), cmd);
    });
    it(`${name}: \`<<<palavra\` sem espaço também`, () => {
      const cmd = "cat <<<EOF\ngit push\nEOF";
      assert.equal(strip(cmd), cmd);
    });
    it(`${name}: heredoc legítimo continua sendo removido`, () => {
      assert.equal(strip("cat <<EOF\ngit push\nEOF\necho ok"), "cat <<EOF\n\necho ok");
    });
  }

  it("fim a fim: laço de gh pr checks depois de here-string é bloqueado", () => {
    assert.equal(
      commandHasHandwrittenPrChecksLoop("cat <<< foo\nuntil gh pr checks 1; do sleep 5; done\nfoo"),
      true,
    );
  });

  it("fim a fim: git push depois de here-string é visto", () => {
    assert.equal(commandHasBareGitPush("cat <<< foo\ngit push\nfoo"), true);
  });
});

describe("stripQuotedSpans: aspa escapada fora de aspas (#9197 item 2)", () => {
  for (const [name, strip] of QUOTED_IMPLS) {
    it(`${name}: \`don\\'t\` não abre span`, () => {
      assert.equal(strip("echo don\\'t; git push"), "echo don\\'t; git push");
    });
    it(`${name}: \`\\"\` fora de aspas não abre span`, () => {
      assert.equal(strip('echo \\" ; git push'), 'echo \\" ; git push');
    });
    it(`${name}: aspas reais continuam sendo removidas`, () => {
      assert.equal(strip("echo 'a && b' ; git push"), "echo  ; git push");
    });
  }

  it("fim a fim: git push depois de aspa escapada é visto", () => {
    assert.equal(commandHasBareGitPush("echo don\\'t; git push"), true);
  });
});

describe("entry guard com path percent-encoded (#9197 item 3)", () => {
  it("hook copiado pra dir com espaço e não-ASCII ainda roda", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-9197-"));
    try {
      const dir = join(root, "dir com espaço ção");
      mkdirSync(dir);
      const hook = join(dir, "block-handwritten-pr-checks-loop.mjs");
      copyFileSync(join(HOOKS_DIR, "block-handwritten-pr-checks-loop.mjs"), hook);
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "until gh pr checks 1; do sleep 5; done" },
      });
      const r = spawnSync(process.execPath, [hook], { input: payload, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /"permissionDecision":"deny"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Hooks fora do escopo desta PR (outra sessão cuida deles): follow-up em #9214.
  const KNOWN_EXCEPTIONS = new Set(["session-beacon.mjs", "consume-merge-grant-on-merge.mjs"]);

  it("todo hook com o guard `file://${_argv1}` também compara via pathToFileURL", () => {
    const missing: string[] = [];
    for (const f of readdirSync(HOOKS_DIR)) {
      if (!f.endsWith(".mjs") || KNOWN_EXCEPTIONS.has(f)) continue;
      const src = readFileSync(join(HOOKS_DIR, f), "utf8");
      if (!src.includes("import.meta.url === `file://${_argv1}`")) continue;
      if (!src.includes("import.meta.url === pathToFileURL(process.argv[1]).href")) missing.push(f);
    }
    assert.deepEqual(missing, []);
  });
});
