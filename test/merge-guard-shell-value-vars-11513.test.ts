/**
 * #11513 / #11516 — dois furos do detector de `gh pr merge` do guard #5716
 * (`.claude/hooks/lib/gh-pr-merge-command.mjs`), achados no review do
 * overnight 261028c sobre a PR #11510:
 *
 * #11513: o VALOR de GIT_EDITOR/GIT_SEQUENCE_EDITOR/EDITOR/VISUAL/GH_EDITOR/
 * GIT_PAGER/GIT_SSH_COMMAND (…) é executado como shell pelo git/gh
 * (`sh -c "$GIT_EDITOR" …`). `GIT_EDITOR='gh pr merge 5 --squash;:' git commit
 * --allow-empty` passava sem ser lido como merge.
 *
 * #11516: a whitelist de heredoc-como-dado (#11501) aceitava atribuição de
 * `BROWSER`/`XDG_*` antes do `cat`, e `--web` no consumidor `gh` — `gh pr
 * create --web` executa `$BROWSER <url>`, isto é, `sh x.md <url>`.
 *
 * O caso legítimo do #11501 (`S=<scratchpad>; cat > $S/x.md <<'EOF'` + `gh
 * issue create --body-file $S/x.md`, citando `gh pr merge` no corpo) segue
 * NÃO sendo merge.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isGhPrMergeCommand, isHeredocDataCommand } from "../.claude/hooks/lib/gh-pr-merge-command.mjs";

const noAliases = { aliases: new Map<string, string>() };
const isMerge = (cmd: string) => isGhPrMergeCommand(cmd, noAliases);
const S = "/tmp/claude-1000/x/scratchpad";

describe("#11513 — valor de variável executada como shell é lido como comando", () => {
  const merges: Record<string, string> = {
    "caso da issue: prefixo GIT_EDITOR + git commit": "GIT_EDITOR='gh pr merge 5 --squash;:' git commit --allow-empty",
    "caso da issue: variante com `; `": "GIT_EDITOR='gh pr merge 5 --squash; :' git commit --allow-empty",
    "atribuição separada por ;": "GIT_EDITOR='gh pr merge 5 --squash;:'; git commit --allow-empty",
    "atribuição separada por &&": "GIT_EDITOR='gh pr merge 5;:' && git commit --allow-empty",
    "export": "export GIT_EDITOR='gh pr merge 5;:'; git commit --allow-empty",
    "declare -x": "declare -x EDITOR='gh pr merge 5;:'; git commit --allow-empty",
    "env wrapper": "env GIT_SEQUENCE_EDITOR='gh pr merge 5;:' git rebase -i HEAD~1",
    "GIT_SEQUENCE_EDITOR": "GIT_SEQUENCE_EDITOR='gh pr merge 5;:' git rebase -i HEAD~1",
    "EDITOR": "EDITOR='gh pr merge 5;:' git commit",
    "VISUAL": "VISUAL='gh pr merge 5;:' git commit",
    "GH_EDITOR + gh pr create --editor": "GH_EDITOR='gh pr merge 5;:' gh pr create --editor",
    "GIT_PAGER": "GIT_PAGER='gh pr merge 5;:' git log",
    "GIT_SSH_COMMAND": "GIT_SSH_COMMAND='gh pr merge 5;:' git push",
    "BROWSER": "BROWSER='gh pr merge 5;:' gh pr view --web",
    "aspas duplas": 'GIT_EDITOR="gh pr merge 5 --squash;:" git commit --allow-empty',
    "dentro de subshell": "(GIT_EDITOR='gh pr merge 5;:' git commit --allow-empty)",
    "dentro de bash -c": `bash -c "GIT_EDITOR='gh pr merge 5;:' git commit --allow-empty"`,
    "gh api de merge no valor": "GIT_EDITOR='gh api -X PUT repos/o/r/pulls/5/merge;:' git commit",
    // Fail-closed: o valor só existe em execução.
    "valor com expansão de variável": 'GIT_EDITOR="$X" git commit --allow-empty',
    "valor com substituição de comando": 'GIT_EDITOR="$(cat x.md)" git commit --allow-empty',
    "export com expansão": 'export GIT_SSH_COMMAND="$CMD"; git push',
  };
  for (const [name, cmd] of Object.entries(merges)) {
    it(`merge: ${name}`, () => {
      assert.equal(isMerge(cmd), true, cmd);
    });
  }

  const notMerges: Record<string, string> = {
    "editor inócuo": "GIT_EDITOR=true git commit --allow-empty",
    "pager inócuo": "GIT_PAGER=cat git log --oneline -5",
    "ssh command inócuo": "GIT_SSH_COMMAND='ssh -o BatchMode=yes' git push",
    "export inócuo": "export EDITOR=vim; git commit",
    "variável fora da lista com merge citado": "MSG='gh pr merge 5'; echo \"$MSG\"",
    "atribuição citada como argumento (não é prefixo)": "echo GIT_EDITOR='gh pr merge 5;:'",
    "git commit -m citando GIT_EDITOR": `git commit -m "GIT_EDITOR='gh pr merge 5;:' era um bypass"`,
  };
  for (const [name, cmd] of Object.entries(notMerges)) {
    it(`não é merge: ${name}`, () => {
      assert.equal(isMerge(cmd), false, cmd);
    });
  }
});

describe("#11516 — BROWSER/XDG_* e --web fora da whitelist de heredoc", () => {
  const BODY = "Mesmo padrão dos guards de `gh pr merge 5 --squash` #5716.";

  const bypasses: Record<string, string> = {
    "caso da issue: BROWSER + gh pr create --web": `BROWSER='sh x.md'; cat > x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh pr create --web --body-file x.md`,
    "BROWSER com &&": `BROWSER='sh x.md' && cat > x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh pr create --body-file x.md`,
    "XDG_CONFIG_HOME": `XDG_CONFIG_HOME=/tmp/evil; cat > x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh issue create --body-file x.md`,
    "XDG_DATA_HOME": `XDG_DATA_HOME=/tmp/evil; cat > x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh issue create --body-file x.md`,
    "PAGER": `PAGER='sh x.md'; cat > x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh issue create --body-file x.md`,
    "--web sem atribuição": `cat > x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh pr create --web --body-file x.md`,
    "--web depois do --body-file": `S=${S}; cat > $S/x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh pr create --body-file $S/x.md --web`,
    "-w": `S=${S}; cat > $S/x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh pr create -w --body-file $S/x.md`,
    "-w entre aspas": `S=${S}; cat > $S/x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh pr create "-w" --body-file $S/x.md`,
    "cluster -dw": `S=${S}; cat > $S/x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh pr create -dw --body-file $S/x.md`,
    "--editor": `S=${S}; cat > $S/x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh pr create --editor --body-file $S/x.md`,
    "-e": `cat > x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh issue comment 1 -e --body-file x.md`,
  };
  for (const [name, cmd] of Object.entries(bypasses)) {
    it(`bypass é merge: ${name}`, () => {
      assert.equal(isHeredocDataCommand(cmd), false, cmd);
      assert.equal(isMerge(cmd), true, cmd);
    });
  }

  const dataCases: Record<string, string> = {
    "caso legítimo do #11501": `S=${S}; cat > $S/marker.md <<'EOF'\n${BODY}\nEOF\ngh issue create --title "Guard de merge (#5716)" --label bug --label P3 --body-file $S/marker.md`,
    "caso legítimo com corpo que é um merge cru": `S=${S}; cat > $S/x.md <<'EOF'\ngh pr merge 5 --squash\nEOF\ngh issue create --title t --body-file $S/x.md`,
    "título com 'web' não é --web": `S=${S}; cat > $S/x.md <<'EOF'\n${BODY}\nEOF\ngh pr create --title "web fix" --base master --body-file $S/x.md`,
    "--webhook não é --web": `cat > x.md <<'EOF'\n${BODY}\nEOF\ngh issue create --label webhook --body-file x.md`,
    "sem atribuição, gh pr comment": `cat > /tmp/c.md <<'EOF'\n${BODY}\nEOF\ngh pr comment 5 --body-file /tmp/c.md`,
  };
  for (const [name, cmd] of Object.entries(dataCases)) {
    it(`continua dado: ${name}`, () => {
      assert.equal(isHeredocDataCommand(cmd), true, cmd);
      assert.equal(isMerge(cmd), false, cmd);
    });
  }
});
