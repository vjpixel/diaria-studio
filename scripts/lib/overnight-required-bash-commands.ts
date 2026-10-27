/**
 * scripts/lib/overnight-required-bash-commands.ts
 *
 * Comandos Bash que o fluxo documentado do `/diaria-overnight` (coordenador +
 * subagentes `dev-implementador`/`dev-fixer`) precisa rodar, e o matcher que
 * confere se cada um casa com uma regra `Bash(...)` de `.claude/settings.json`
 * (#11235).
 *
 * Por que existe: o overnight agendado roda `claude --print --permission-mode
 * acceptEdits` (`scripts/overnight/run-nightly-chain.ts`). Nesse modo só edição
 * de arquivo e os comandos read-only embutidos do Claude Code passam sozinhos;
 * todo outro comando Bash precisa casar com `permissions.allow`, senão vira
 * negação (não há quem aprove). Nas rodadas 261026 e 261027 `git add`,
 * `git commit`, `git fetch`/`git pull`, `npm ci` e `npx tsc` foram negados e as
 * duas noites terminaram com 0 PRs.
 *
 * Cada entrada traz `source` + `mention`: o teste confere que a menção ainda
 * aparece no documento citado, pra lista não descolar do fluxo que ela
 * representa. Comandos que rodam DENTRO de um script (`git worktree remove` do
 * `cleanup-merged-worktrees.ts`, o `gh api` do `gh-pr-safe-edit.ts`) não entram:
 * filho de processo não passa pelo sistema de permissões, só o comando que o
 * agente digita no Bash.
 *
 * Fora daqui de propósito: `npm test` completo (proibido pelo item 4 das regras
 * de dispatch), `gh pr merge` (já coberto por `gh pr *`), `git stash` (proibido,
 * item 10), `git reset --hard`/`rm -rf` (o deny de `rm -rf *` continua).
 */

export type RequiredCommandSource =
  | ".claude/skills/diaria-overnight/SKILL.md"
  | "context/overnight-dispatch-rules.md"
  | ".claude/agents/dev-fixer.md";

export interface RequiredBashCommand {
  /** Exemplo concreto do comando, na forma que o fluxo documenta. */
  command: string;
  /** Documento onde o fluxo pede esse comando. */
  source: RequiredCommandSource;
  /** Trecho literal que precisa continuar aparecendo em `source`. */
  mention: string;
}

export const OVERNIGHT_REQUIRED_BASH_COMMANDS: readonly RequiredBashCommand[] = [
  // Bootstrap e testes dos subagentes (itens 3 e 4 das regras de dispatch).
  { command: "npm ci", source: "context/overnight-dispatch-rules.md", mention: "**`npm ci`**" },
  { command: "npm ci --prefer-offline", source: "context/overnight-dispatch-rules.md", mention: "npm ci --prefer-offline" },
  { command: "npx tsc --noEmit", source: "context/overnight-dispatch-rules.md", mention: "npx tsc --noEmit" },
  { command: "npx tsc -p tsconfig.test.json --noEmit", source: "context/overnight-dispatch-rules.md", mention: "npx tsc -p tsconfig.test.json --noEmit" },
  {
    command: "npx tsx --test test/foo.test.ts test/lib-boundary.test.ts",
    source: "context/overnight-dispatch-rules.md",
    mention: "npx tsx --test test/<arquivo-tocado>.test.ts test/lib-boundary.test.ts",
  },
  {
    command: "NODE_TEST_SNAPSHOTS=1 npx tsx --test test/orchestrator-prompt.test.ts",
    source: "context/overnight-dispatch-rules.md",
    mention: "NODE_TEST_SNAPSHOTS=1 npx tsx --test test/orchestrator-prompt.test.ts",
  },

  // Commit/push da unidade (subagente) e do fixer.
  { command: "git add scripts/lib/foo.ts test/foo.test.ts", source: ".claude/agents/dev-fixer.md", mention: "commitar e dar\npush no mesmo branch" },
  { command: "git commit -m 'fix(#1): x'", source: ".claude/agents/dev-fixer.md", mention: "commitar e dar\npush no mesmo branch" },
  { command: "git commit -F /tmp/commit-msg-1.txt", source: ".claude/agents/dev-fixer.md", mention: "commitar e dar\npush no mesmo branch" },
  { command: "git push -u origin overnight/fix-1-x", source: ".claude/agents/dev-fixer.md", mention: "commitar e dar\npush no mesmo branch" },
  { command: "gh pr create --title t --body-file /tmp/pr-body-1-123.md", source: "context/overnight-dispatch-rules.md", mention: "gh pr create" },

  // Coordenador: sync de master e worktrees.
  { command: "git checkout master", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "git checkout master && git pull" },
  { command: "git pull", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "git checkout master && git pull" },
  { command: "git fetch origin master", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "git fetch origin master" },
  {
    command: "git worktree add -b overnight/fix-1-x .claude/worktrees/x origin/master",
    source: "context/overnight-dispatch-rules.md",
    mention: "git worktree add -b <branch> .claude/worktrees/<nome> origin/master",
  },
  { command: "git worktree prune", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "git worktree prune" },
  { command: "git push origin --delete overnight/fix-1-x", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "git push origin --delete overnight/fix-NNNN" },
  { command: "git -C ../diaria-design fetch origin", source: "context/overnight-dispatch-rules.md", mention: "git -C ../diaria-design fetch origin" },
  {
    command: "git -C ../diaria-design worktree add -b overnight/fix-2-x .claude/worktrees/x origin/main",
    source: "context/overnight-dispatch-rules.md",
    mention: "git -C ../diaria-design worktree add -b {branch} .claude/worktrees/{nome}",
  },
  { command: "gh repo clone vjpixel/diaria-design ../diaria-design", source: "context/overnight-dispatch-rules.md", mention: "gh repo clone vjpixel/diaria-design ../diaria-design" },

  // Coordenador: triagem e registro nas issues.
  { command: "gh auth status", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "gh auth status" },
  {
    command: "gh issue list --state open --limit 200 --json number,title,labels,state,createdAt",
    source: ".claude/skills/diaria-overnight/SKILL.md",
    mention: "gh issue list --state open --limit 200 --json number,title,labels,state,createdAt",
  },
  { command: "gh issue view 1 --json comments", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "gh issue view N --json comments" },
  { command: "gh issue edit 1 --add-label external-blocker", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "gh issue edit N --add-label external-blocker" },
  { command: "gh issue comment 1 --body-file /tmp/c.md", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "gh issue comment" },
  { command: "gh issue create --title t --label bug,P2 --body-file /tmp/i.md", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "só vira issue" },
  { command: "gh search issues 'x' --repo vjpixel/diaria-studio", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "gh search issues" },

  // Coordenador: CI, merge gate e review threads.
  { command: "bash scripts/lib/wait-pr-checks.sh 1", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "scripts/lib/wait-pr-checks.sh {N}" },
  { command: "scripts/lib/wait-pr-checks.sh 1", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "scripts/lib/wait-pr-checks.sh {N}" },
  { command: "gh pr checks 1 --json bucket --jq '.'", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "gh pr checks {N} --json bucket" },
  { command: "gh run view 123 --log-failed", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "gh run view --log-failed" },
  { command: "gh run list --branch master --limit 1", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "gh run list --branch master --limit 1" },
  { command: "gh run rerun 123", source: "context/overnight-dispatch-rules.md", mention: "gh run rerun" },
  {
    command: "gh api repos/vjpixel/diaria-studio/git/ref/heads/master --jq .object.sha",
    source: ".claude/skills/diaria-overnight/SKILL.md",
    mention: "gh api repos/{owner}/{repo}/git/ref/heads/{base} --jq .object.sha",
  },
  {
    command: "gh api graphql -f owner=vjpixel -f name=diaria-studio -F pr=1 -f query='query { viewer { login } }'",
    source: "context/overnight-dispatch-rules.md",
    mention: "gh api graphql -f owner=vjpixel -f name=diaria-studio -F pr=N",
  },
  {
    command: "gh api repos/vjpixel/diaria-studio/pulls/1/comments -f body=x -f commit_id=abc -f path=a.ts -F line=1",
    source: ".claude/skills/diaria-overnight/SKILL.md",
    mention: "comentários inline no PR",
  },
];

/** Prefixo `Bash(` ... `)` de uma regra de permissão; `null` se a regra não é de Bash. */
function bashRuleBody(rule: string): string | null {
  const m = /^Bash\((.*)\)$/s.exec(rule);
  return m ? m[1] : null;
}

/**
 * Imita a semântica documentada das regras `Bash(...)` do Claude Code
 * (https://code.claude.com/docs/en/permissions, "Wildcard patterns"):
 * - `*` casa qualquer texto, inclusive espaço e `/`;
 * - regra sem `*` casa só o comando exato;
 * - `:*` no fim equivale a ` *`;
 * - ` *` no fim, quando é o único curinga, também casa o comando sem argumentos
 *   (`Bash(ls *)` casa `ls`, não casa `lsof`).
 *
 * Não modela separação de comando composto (`&&`, `|`) nem o strip de wrappers
 * (`timeout`) e de env vars "seguras": os comandos canônicos são simples e o
 * único prefixo de env (`NODE_TEST_SNAPSHOTS=1`) tem regra literal própria.
 */
export function bashRuleMatches(rule: string, command: string): boolean {
  let body = bashRuleBody(rule);
  if (body === null) return false;
  if (body.endsWith(":*")) body = body.slice(0, -2) + " *";
  const cmd = command.trim();
  const starCount = (body.match(/\*/g) ?? []).length;
  if (starCount === 0) return body === cmd;
  if (starCount === 1 && body.endsWith(" *") && cmd === body.slice(0, -2)) return true;
  const re = new RegExp(
    "^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*") + "$",
  );
  return re.test(cmd);
}

/** Primeira regra de `rules` que casa `command`, ou `null`. */
export function findMatchingBashRule(rules: readonly string[], command: string): string | null {
  for (const r of rules) if (bashRuleMatches(r, command)) return r;
  return null;
}
