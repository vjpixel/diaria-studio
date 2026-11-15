/**
 * #13171 — dois fail-open do detector de merge
 * (`.claude/hooks/lib/gh-pr-merge-command.mjs`), achados no review
 * consolidado da rodada 261115d (PR #13159 / #13148).
 *
 * 1. `PUSH_ARGS` barrava só a grafia completa de `--receive-pack`/`--exec`.
 *    O git aceita prefixo único de opção longa: `git push --rece=sh
 *    .git/COMMIT_EDITMSG` executa a mensagem recém-commitada (o corpo do
 *    heredoc que a whitelist pulou). Agora todo argumento `--e…`/`--rec…`
 *    tira o comando da whitelist.
 * 2. Desde o #13148 o corpo de heredoc com delimitador aspado deixou de ser
 *    lido como string entre aspas duplas. Um consumidor que transforma o
 *    texto antes do shell (`sed "s/'//g" <<'D' | sh`, com o merge entre aspas
 *    simples) passava. Agora as duas leituras valem para todo corpo fora da
 *    whitelist de `isHeredocDataCommand`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isGhPrMergeCommand, isHeredocDataCommand } from "../.claude/hooks/lib/gh-pr-merge-command.mjs";

const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  detectMergeForGuard: (command: string, opts?: Record<string, unknown>) => { isMerge: boolean; error: string | null };
};

const noAliases = { aliases: new Map<string, string>() };
const isMerge = (cmd: string) => isGhPrMergeCommand(cmd, noAliases);
const detected = (cmd: string) => guard.detectMergeForGuard(cmd, { detect: (c: string) => isMerge(c) }).isMerge;

const MERGE = ["gh", "pr", "merge"].join(" ");
const commit = (head: string, body: string, tail = "") => `${head}\n${body}\nEOF${tail ? `\n${tail}` : ""}`;

describe("#13171 — push com opção abreviada que executa um comando", () => {
  const abbrevs = ["--rece=sh", "--receiv=sh", "--rec=sh", "--exe=sh", "--ex=sh", "--e=sh", "--exe sh", "--rece sh"];

  for (const opt of abbrevs) {
    it(`linha depois do EOF: git push ${opt} .git/COMMIT_EDITMSG`, () => {
      const cmd = commit(`git add a.ts && git commit -F - <<'EOF'`, `${MERGE} 5`, `git push ${opt} .git/COMMIT_EDITMSG`);
      assert.equal(isHeredocDataCommand(cmd), false);
      assert.equal(isMerge(cmd), true);
      assert.equal(detected(cmd), true);
    });

    it(`mesma linha: && git push ${opt} .git/COMMIT_EDITMSG`, () => {
      const cmd = commit(`git commit -F - <<'EOF' && git push ${opt} .git/COMMIT_EDITMSG`, `${MERGE} 5`);
      assert.equal(isHeredocDataCommand(cmd), false);
      assert.equal(isMerge(cmd), true);
    });

    it(`forma -m "$(cat <<'EOF'": )" && git push ${opt} .`, () => {
      const cmd = commit(`git commit -m "$(cat <<'EOF'`, `${MERGE} 5`, `)" && git push ${opt} .git/COMMIT_EDITMSG`);
      assert.equal(isHeredocDataCommand(cmd), false);
      assert.equal(isMerge(cmd), true);
    });
  }

  it("push comum continua na whitelist (sem falso positivo)", () => {
    for (const tail of ["git push", "git push -u origin overnight/fix-13171-x", "git push --force-with-lease origin x", "git push --repo=origin"]) {
      const cmd = commit(`git add a.ts && git commit -F - <<'EOF'`, `nunca rode \`${MERGE} 5\``, tail);
      assert.equal(isHeredocDataCommand(cmd), true, tail);
      assert.equal(isMerge(cmd), false, tail);
    }
  });
});

describe("#13171 — corpo de heredoc aspado lido também como string", () => {
  it("sed que tira as aspas antes do shell: merge entre aspas simples", () => {
    const cmd = commit(`sed "s/'//g" <<'EOF' | sh`, `echo '$(${MERGE} 5)'`);
    assert.equal(isMerge(cmd), true);
    assert.equal(detected(cmd), true);
  });

  it("crase entre aspas simples com <<\"EOF\" e <<\\EOF", () => {
    assert.equal(isMerge(commit(`tr -d "'" <<"EOF" | bash`, `echo '\`${MERGE} 5\`'`)), true);
    assert.equal(isMerge(commit(`tr -d "'" <<\\EOF | bash`, `echo '\`${MERGE} 5\`'`)), true);
  });

  it("o caso do #13148 continua livre: commit com heredoc aspado e crases na whitelist", () => {
    const cmd = commit(
      `cd /tmp/wt && git add a.ts && git commit -q -F - <<'EOF'`,
      "fix(x): `scan` lê `$(...)` (#13148)\n\n- (#13120) `a` e `b`\n- nunca `" + MERGE + " 5` daqui",
      "git push -u origin overnight/fix-13171-x",
    );
    assert.equal(isHeredocDataCommand(cmd), true);
    assert.equal(isMerge(cmd), false);
    assert.equal(detected(cmd), false);
  });
});
