/**
 * #11522 — limites do detector de `gh pr merge` do guard #5716
 * (`.claude/hooks/lib/gh-pr-merge-command.mjs`) achados no self-review da PR
 * #11518 (#11513, #11516):
 *
 * 1. Falso positivo: `GIT_SSH_COMMAND="ssh -i $KEY" git push` era merge opaco
 *    (`shell-var`) — toda expansão no valor era fail-closed. Agora só conta
 *    quando a expansão ocupa a posição de COMANDO (ou é argumento de shell/
 *    eval/wrapper).
 * 2. Não coberto: comando de shell vindo de config do git no próprio comando
 *    (`git -c core.editor=…`, `alias.x=!…`, `core.pager`, `core.sshCommand`,
 *    `git config CHAVE VALOR`) e `gh config set editor|pager|browser`.
 * 3. Duas listas de variáveis divergiam: `SSH_ASKPASS` estava em
 *    `SHELL_VALUE_VARS` e não na denylist da whitelist de heredoc.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findGhPrMergeInvocations,
  isGhPrMergeCommand,
  isHeredocDataCommand,
  SHELL_VALUE_VARS,
  UNSAFE_ASSIGN_NAMES,
} from "../.claude/hooks/lib/gh-pr-merge-command.mjs";

const noAliases = { aliases: new Map<string, string>() };
const isMerge = (cmd: string) => isGhPrMergeCommand(cmd, noAliases);
const reasons = (cmd: string) =>
  (findGhPrMergeInvocations(cmd, noAliases) as Array<{ via: string; reason?: string }>).map((i) => i.reason ?? i.via);

describe("#11522 item 1 — expansão em argumento de comando literal não é merge", () => {
  const notMerges: Record<string, string> = {
    "caso da issue: GIT_SSH_COMMAND com $KEY": 'GIT_SSH_COMMAND="ssh -i $KEY" git push',
    "GIT_SSH_COMMAND com ${HOME}": 'GIT_SSH_COMMAND="ssh -i ${HOME}/.ssh/id_ed25519 -o IdentitiesOnly=yes" git fetch',
    "export GIT_SSH_COMMAND com expansão": 'export GIT_SSH_COMMAND="ssh -i $KEY"; git push',
    "env GIT_SSH_COMMAND com expansão": 'env GIT_SSH_COMMAND="ssh -i $KEY" git push',
    "GIT_EDITOR com arquivo expandido": 'GIT_EDITOR="code --wait $DIR" git commit',
    "substituição só no argumento": 'GIT_SSH_COMMAND="ssh -i $(cat keypath.txt)" git push',
    "git -c core.sshCommand com expansão": 'git -c core.sshCommand="ssh -i $KEY" push',
  };
  for (const [name, cmd] of Object.entries(notMerges)) {
    it(`não é merge: ${name}`, () => {
      assert.equal(isMerge(cmd), false, cmd);
    });
  }

  const merges: Record<string, string> = {
    "valor é a própria expansão": 'GIT_EDITOR="$X" git commit --allow-empty',
    "expansão na posição de comando com args": 'GIT_SSH_COMMAND="$CMD -i key" git push',
    "substituição na posição de comando": 'GIT_EDITOR="$(cat x.md)" git commit',
    "sh -c com expansão": 'GIT_EDITOR="sh -c $X" git commit',
    "eval com expansão": 'GIT_EDITOR="eval $X" git commit',
    "env wrapper com expansão": 'GIT_SSH_COMMAND="env $X" git push',
    "segundo comando opaco": 'GIT_SSH_COMMAND="ssh -i $KEY; $X" git push',
    "merge literal com argumento expandido": 'GIT_EDITOR="gh pr merge $N;:" git commit',
    "substituição com merge dentro": 'GIT_SSH_COMMAND="ssh -i $(gh pr merge 5)" git push',
  };
  for (const [name, cmd] of Object.entries(merges)) {
    it(`merge: ${name}`, () => {
      assert.equal(isMerge(cmd), true, cmd);
    });
  }

  it("valor opaco sai com reason shell-var", () => {
    assert.deepEqual(reasons('GIT_EDITOR="$X" git commit'), ["shell-var"]);
  });
});

describe("#11522 item 2 — config do git/gh que vira comando de shell", () => {
  const merges: Record<string, string> = {
    "git -c core.editor": "git -c core.editor='gh pr merge 5;:' commit --allow-empty",
    "git -c core.editor com caixa mista": "git -c Core.Editor='gh pr merge 5;:' commit",
    "git -c core.pager": "git -c core.pager='gh pr merge 5;:' log",
    "git -c core.sshCommand": "git -c core.sshCommand='gh pr merge 5;:' push",
    "git -c sequence.editor": "git -c sequence.editor='gh pr merge 5;:' rebase -i HEAD~1",
    "git -c pager.log": "git -c pager.log='gh pr merge 5;:' log",
    "git -c alias com !": "git -c alias.x='!gh pr merge 5' x",
    "git -c credential.helper com !": "git -c credential.helper='!gh pr merge 5;:' push",
    "git -c diff.external": "git -c diff.external='gh pr merge 5;:' diff",
    "git -C antes do -c": "git -C /tmp/x -c core.editor='gh pr merge 5;:' commit",
    "git -c via wrapper env": "env FOO=1 git -c core.editor='gh pr merge 5;:' commit",
    "git -c com valor opaco": 'git -c core.editor="$X" commit',
    "git -c com chave opaca": 'git -c "$K=gh pr merge 5" commit',
    "git --config-env de chave de shell": "git --config-env=core.editor=EVIL commit",
    "git --config-env separado": "git --config-env core.pager=EVIL log",
    "git config grava editor": "git config core.editor 'gh pr merge 5;:'",
    "git config --global grava pager": "git config --global core.pager 'gh pr merge 5;:'",
    "git config --file grava alias": "git config --file .git/config alias.m '!gh pr merge 5'",
    "git config set (forma nova)": "git config set core.sshCommand 'gh pr merge 5;:'",
    "gh config set editor": "gh config set editor 'gh pr merge 5;:'",
    "gh config set -h host pager": "gh config set -h github.com pager 'gh pr merge 5;:'",
    "gh config set browser": "gh config set browser 'gh pr merge 5;:'",
  };
  for (const [name, cmd] of Object.entries(merges)) {
    it(`merge: ${name}`, () => {
      assert.equal(isMerge(cmd), true, cmd);
    });
  }

  const notMerges: Record<string, string> = {
    "git -c editor inócuo": "git -c core.editor=vim commit",
    "git -c chave que não executa": "git -c user.name='gh pr merge 5' commit",
    "git -c alias sem !": "git -c alias.m='merge --no-ff' m main",
    "git -c credential.helper nomeado": "git -c credential.helper=store push",
    "git config lê valor": "git config --get core.editor",
    "git config get (forma nova)": "git config get core.editor",
    "git config de chave inócua": "git config user.email 'gh pr merge 5'",
    "git config --unset": "git config --unset core.editor",
    "git config -l": "git config -l",
    "git commit -c (reusa mensagem) não é config": "git commit -c HEAD --allow-empty",
    "gh config get editor": "gh config get editor",
    "gh config set de chave inócua": "gh config set git_protocol ssh",
    "gh config set editor inócuo": "gh config set editor vim",
    "git push comum": "git push -u origin overnight/fix-11522-x",
  };
  for (const [name, cmd] of Object.entries(notMerges)) {
    it(`não é merge: ${name}`, () => {
      assert.equal(isMerge(cmd), false, cmd);
    });
  }

  it("valor opaco de git -c sai com reason git-config", () => {
    assert.deepEqual(reasons('git -c core.editor="$X" commit'), ["git-config"]);
  });
});

describe("#11522 item 3 — lista única de variáveis", () => {
  it("toda SHELL_VALUE_VARS está em UNSAFE_ASSIGN_NAMES", () => {
    for (const v of SHELL_VALUE_VARS) assert.ok(UNSAFE_ASSIGN_NAMES.has(v), v);
  });

  it("toda SHELL_VALUE_VARS tira a atribuição da whitelist de heredoc", () => {
    for (const v of SHELL_VALUE_VARS) {
      const cmd = `${v}=/tmp/x; cat > x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh issue create --body-file x.md`;
      assert.equal(isHeredocDataCommand(cmd), false, v);
      assert.equal(isMerge(cmd), true, v);
    }
  });

  it("caso da issue: SSH_ASKPASS antes do cat não passa mais pela whitelist", () => {
    const cmd = `SSH_ASKPASS='sh x.md'; cat > x.md <<'EOF'\ngh pr merge 123 --squash\nEOF\ngh pr create --body-file x.md`;
    assert.equal(isHeredocDataCommand(cmd), false);
    assert.equal(isMerge(cmd), true);
  });

  it("caso legítimo do #11501 segue liberado", () => {
    const cmd = `S=/tmp/claude-1000/x/scratchpad; cat > $S/x.md <<'EOF'\nCitando \`gh pr merge 5\` no corpo.\nEOF\ngh issue create --title t --body-file $S/x.md`;
    assert.equal(isHeredocDataCommand(cmd), true);
    assert.equal(isMerge(cmd), false);
  });
});
