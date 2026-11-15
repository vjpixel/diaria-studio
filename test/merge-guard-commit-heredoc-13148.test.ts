/**
 * #13148 — o guard do #5716 (`block-gh-pr-merge-subagent.mjs`, detector em
 * `.claude/hooks/lib/gh-pr-merge-command.mjs`) barrou como merge um commit
 * com mensagem longa por heredoc (`git commit -F - <<'EOF'`), sem `gh` nem
 * `merge` no texto (sessão develop 261115, commit do PR #13141).
 *
 * Causa medida: a forma padrão dos implementadores tem `cd X && git add … &&`
 * antes do `git commit` e `git push` na linha depois do `EOF` — fora da
 * whitelist de `isHeredocDataCommand`, que aceitava só `cd X && git commit`.
 * Fora dela o corpo é lido como COMANDOS de shell (fail-closed: alguém pode
 * estar alimentando um shell com ele), e o markdown da mensagem — `(` seguido
 * de `#13120`, que o shell lê como comentário e engole o `)` — aninha
 * subshells até passar de `MAX_DEPTH` e vira merge opaco ("depth").
 *
 * Correção: (1) a whitelist aceita `cd X`/`git add <args simples>` antes do
 * `git commit` e uma linha de `git push` depois do delimitador; (2) com o
 * delimitador aspado o corpo deixa de ser lido como string entre aspas
 * duplas (`$(...)`/crase), que o bash não expande ali. A leitura como
 * comandos fora da whitelist continua igual, nos dois tipos de delimitador.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  findGhPrMergeInvocations,
  isGhPrMergeCommand,
  isHeredocDataCommand,
} from "../.claude/hooks/lib/gh-pr-merge-command.mjs";

const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  detectMergeForGuard: (command: string, opts?: Record<string, unknown>) => { isMerge: boolean; error: string | null };
};

const noAliases = { aliases: new Map<string, string>() };
const isMerge = (cmd: string) => isGhPrMergeCommand(cmd, noAliases);
const detected = (cmd: string) => guard.detectMergeForGuard(cmd, { detect: (c: string) => isMerge(c) }).isMerge;

const REAL = readFileSync(new URL("./fixtures/merge-guard-13148/commit-heredoc.sh.txt", import.meta.url), "utf8").trimEnd();
const MERGE = ["gh", "pr", "merge"].join(" ");
const WT = "/home/vjpixel/diaria-studio/.claude/worktrees/agent-x";
const lines = REAL.split("\n");
const HEADER = lines[0];
const close = lines.indexOf("EOF");
const BODY = lines.slice(1, close).join("\n");
const PUSH = lines.slice(close + 1).join("\n");
/** Corpo sem nenhum `gh`/`merge`, mas com o markdown que estourava a profundidade. */
const commit = (head: string, body = BODY, tail = "") => `${head}\n${body}\nEOF${tail ? `\n${tail}` : ""}`;

describe("#13148 — commit com heredoc longo não é merge", () => {
  it("a fixture é a do incidente (sanidade)", () => {
    assert.ok(close > 30, "corpo de ~40 linhas");
    assert.ok((BODY.match(/`/g) ?? []).length >= 20, "cheio de crases");
    assert.doesNotMatch(BODY, /\bgh\b|merge/i);
    assert.match(HEADER, / && git add .* && git commit -q -F - <<'EOF'$/);
    assert.match(PUSH, /^git push /);
  });

  it("antes da correção: o corpo lido como comandos estourava MAX_DEPTH", () => {
    // Mesma leitura, sem a whitelist (o `| sh` tira o comando dela): segue fail-closed.
    const piped = commit(`${HEADER} | sh`, BODY);
    assert.deepEqual(findGhPrMergeInvocations(piped, noAliases), [{ via: "opaque", reason: "depth", args: [] }]);
  });

  it("o comando real não é merge (detector e guard)", () => {
    assert.equal(isHeredocDataCommand(REAL), true);
    assert.deepEqual(findGhPrMergeInvocations(REAL, noAliases), []);
    assert.equal(isMerge(REAL), false);
    assert.equal(detected(REAL), false);
  });

  it("variações da mesma forma também passam", () => {
    for (const cmd of [
      commit(`cd ${WT} && git add a.ts b.ts && git commit -F - <<'EOF'`),
      commit(`cd ${WT}; git add a.ts; git commit -F - <<'EOF'`),
      commit(`git add -A && git commit -F - <<'EOF'`, BODY, "git push -u origin overnight/fix-13148-x"),
      commit(`git add a.ts && git commit -F - <<'EOF' && git push`),
      commit(`git add a.ts && git commit -m "$(cat <<'EOF'`, BODY, ')"'),
      // A mensagem pode CITAR o merge: com a whitelist o corpo é dado.
      commit(`git add a.ts && git commit -F - <<'EOF'`, `${BODY}\nnunca rode \`${MERGE} 5\` daqui`),
    ]) {
      assert.equal(isMerge(cmd), false, cmd.split("\n")[0]);
    }
  });
});

describe("#13148 — o que continua sendo merge", () => {
  const merges: Array<[string, string]> = [
    ["merge no prefixo", commit(`git add a.ts && ${MERGE} 5 && git commit -F - <<'EOF'`)],
    ["merge depois do git commit na mesma linha", commit(`git add a.ts && git commit -F - <<'EOF' && ${MERGE} 5`)],
    ["merge na linha depois do EOF", commit(`git add a.ts && git commit -F - <<'EOF'`, BODY, `${MERGE} 5`)],
    ["merge depois do push", commit(`git add a.ts && git commit -F - <<'EOF'`, BODY, `git push && ${MERGE} 5`)],
    ["duas linhas depois do EOF", commit(`git add a.ts && git commit -F - <<'EOF'`, BODY, `git push\n${MERGE} 5`)],
    ["push com pipe para um shell", commit(`git add a.ts && git commit -F - <<'EOF'`, BODY, "git push 2>&1 | sh")],
    ["substituição no git add", commit(`git add $(${MERGE} 5) && git commit -F - <<'EOF'`)],
    ["git -c antes do commit", commit(`git add a.ts && git -c core.hooksPath=h commit -F - <<'EOF'`, `${MERGE} 5`)],
    ["comando qualquer no prefixo", commit(`chmod +x x.sh && git add a.ts && git commit -F - <<'EOF'`, `${MERGE} 5`)],
    ["corpo alimentando um shell", commit(`git add a.ts && git commit -F - <<'EOF' | sh`, `${MERGE} 5`)],
    ["bash com heredoc aspado", commit(`git add a.ts && bash <<'EOF'`, `${MERGE} 5`)],
    ["delimitador sem aspas, substituição no corpo", commit(`git add a.ts && git commit -F - <<EOF`, `msg $(${MERGE} 5)`)],
    ["delimitador sem aspas, crase no corpo", commit(`git add a.ts && git commit -F - <<EOF`, `msg \`${MERGE} 5\``)],
    ["cat sem aspas no delimitador", commit(`cat <<EOF > nota.md`, `$(${MERGE} 5)`)],
  ];
  for (const [name, cmd] of merges) {
    it(name, () => {
      assert.equal(isMerge(cmd), true);
      assert.equal(detected(cmd), true);
    });
  }

  it("heredoc aspado lido como comandos (fora da whitelist) ainda acha o merge", () => {
    assert.equal(isMerge(commit(`tee nota.md <<'EOF' | sh`, `echo oi\n${MERGE} 5`)), true);
    assert.equal(isMerge(commit(`bash -c "$(cat <<'EOF'`, `${MERGE} 5`, ')"')), true);
  });
});
