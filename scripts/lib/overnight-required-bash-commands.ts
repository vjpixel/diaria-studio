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
 * item 10), `git reset --hard`/`rm -rf` (o deny de `rm -rf *` continua),
 * `git worktree remove` (item 22; a limpeza de worktree mergeado é do
 * `cleanup-merged-worktrees.ts`) e `gh api` cru (só pelos helpers
 * `scripts/resolve-review-threads.ts` e `scripts/gh-pr-review-api.ts`).
 *
 * O allow list protege contra deriva acidental, não é fronteira de segurança:
 * regras anteriores (`node -e *`, `npx tsx scripts/*.ts *`) já executam código
 * arbitrário.
 *
 * `bashRuleMatches` imita a semântica documentada, mas não é o matcher real do
 * Claude Code. Por isso, onde o fluxo roda o comando puro (`git pull`,
 * `npm ci`, `git worktree prune`/`list`, `gh auth status`), o allow list tem
 * também a regra exata sem argumentos, que não depende de "` *` final casa o
 * comando puro". A prova real é a 1ª rodada agendada depois do merge: o
 * `report.md` dela não pode listar negação de permissão.
 */

export type RequiredCommandSource =
  | ".claude/skills/diaria-overnight/SKILL.md"
  | "context/overnight-dispatch-rules.md"
  | ".claude/agents/dev-fixer.md"
  | ".claude/skills/diaria-develop/SKILL.md";

export interface RequiredBashCommand {
  /** Exemplo concreto do comando, na forma que o fluxo documenta. */
  command: string;
  /** Documento onde o fluxo pede esse comando. */
  source: RequiredCommandSource;
  /** Trecho que precisa continuar aparecendo em `source` (espaço em branco normalizado). */
  mention: string;
}

/** Colapsa qualquer sequência de espaço em branco num espaço só. */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ");
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
  { command: "git add scripts/lib/foo.ts test/foo.test.ts", source: "context/overnight-dispatch-rules.md", mention: "`git add <arquivos>` (lista explícita, nunca `-A`)" },
  { command: "git commit -F /tmp/commit-msg-1.txt", source: "context/overnight-dispatch-rules.md", mention: "`git commit -F <arquivo-de-mensagem>`" },
  { command: "git commit --no-verify -m wip", source: "context/overnight-dispatch-rules.md", mention: "`git commit --no-verify -m wip`" },
  { command: "git reset --soft HEAD~1", source: "context/overnight-dispatch-rules.md", mention: "`git reset --soft HEAD~1`" },
  { command: "git push -u origin overnight/fix-1-x", source: "context/overnight-dispatch-rules.md", mention: "`git push -u origin <branch>`" },
  { command: "git push origin develop/fix-1-x", source: ".claude/agents/dev-fixer.md", mention: "`git push origin <branch>`" },
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
  { command: "git worktree list", source: "context/overnight-dispatch-rules.md", mention: "git worktree list" },
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
  { command: "npx tsx scripts/check-pr-checks-gate.ts --pr 1", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "npx tsx scripts/check-pr-checks-gate.ts --pr {N} [--issue {ref}]" },
  { command: "gh pr checks 1 --watch", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "gh pr checks {N} --watch" },
  { command: "gh run view 123 --log-failed", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "gh run view --log-failed" },
  { command: "gh run list --branch master --limit 1", source: ".claude/skills/diaria-overnight/SKILL.md", mention: "gh run list --branch master --limit 1" },
  { command: "gh run rerun 123", source: "context/overnight-dispatch-rules.md", mention: "gh run rerun" },
  // `gh api` só via helpers de escopo fixo (#11235, review da PR #11250): uma
  // regra `Bash(gh api ...*)` deixaria o `*` atravessar espaço e casar
  // `-X DELETE`/mutation arbitrária. Os helpers caem em `npx tsx scripts/*.ts *`.
  {
    command: "npx tsx scripts/gh-pr-review-api.ts ref-sha --branch master",
    source: ".claude/skills/diaria-overnight/SKILL.md",
    mention: "npx tsx scripts/gh-pr-review-api.ts ref-sha --branch {base} [--repo {repo}]",
  },
  {
    command: "npx tsx scripts/resolve-review-threads.ts --pr 1 --list",
    source: "context/overnight-dispatch-rules.md",
    mention: "npx tsx scripts/resolve-review-threads.ts --pr N [--repo owner/name] --list",
  },
  {
    command: "npx tsx scripts/resolve-review-threads.ts --pr 1 --repo vjpixel/diaria-design",
    source: ".claude/skills/diaria-overnight/SKILL.md",
    mention: "npx tsx scripts/resolve-review-threads.ts --pr {N} [--repo {repo}]",
  },
  {
    command: "npx tsx scripts/resolve-review-threads.ts --pr 1 --check",
    source: ".claude/skills/diaria-overnight/SKILL.md",
    mention: "npx tsx scripts/resolve-review-threads.ts --pr {N} [--repo {repo}] --check",
  },
  {
    command: "npx tsx scripts/resolve-review-threads.ts --pr 1 --repo vjpixel/diaria-design --check",
    source: ".claude/skills/diaria-develop/SKILL.md",
    mention: "npx tsx scripts/resolve-review-threads.ts --pr {N} [--repo {repo}] --check",
  },
  {
    command: "npx tsx scripts/gh-pr-review-api.ts comment --pr 1 --path a.ts --line 3 --body-file /tmp/c.md",
    source: "context/overnight-dispatch-rules.md",
    mention: "npx tsx scripts/gh-pr-review-api.ts comment --pr N --path P --line L --body-file F",
  },
  {
    command: "npx tsx scripts/gh-pr-review-api.ts list-comments --pr 1",
    source: ".claude/agents/dev-fixer.md",
    mention: "npx tsx scripts/gh-pr-review-api.ts list-comments --pr N",
  },
  {
    command: "npx tsx scripts/gh-pr-review-api.ts reply --pr 1 --comment-id 9 --body-file /tmp/r.md",
    source: ".claude/agents/dev-fixer.md",
    mention: "npx tsx scripts/gh-pr-review-api.ts reply --pr N --comment-id ID --body-file F",
  },
];

/**
 * Comandos que o allow list NÃO pode liberar (#11235, review da PR #11250).
 * O teste exige que nenhuma regra de `allow` case cada um. `knownMatchBy`
 * registra o caso em que uma regra ANTERIOR ao #11235 já casa (limitação
 * conhecida, fora do escopo desta issue).
 */
export const OVERNIGHT_FORBIDDEN_BASH_PROBES: readonly { command: string; knownMatchBy?: string }[] = [
  { command: "git reset --hard HEAD~1" },
  { command: "git stash" },
  { command: "git clean -fd" },
  { command: "git worktree remove --force .claude/worktrees/x" },
  { command: "git -C ../outro-repo commit -m x" },
  { command: "gh api repos/vjpixel/x/branches/master/protection -X DELETE -H 'X: /pulls/1'" },
  { command: "gh api repos/vjpixel/diaria-studio/pulls/1 -X PATCH -f base=main" },
  { command: "gh api repos/vjpixel/diaria-studio/git/ref/heads/master -X DELETE" },
  { command: "gh api graphql -f query='mutation{deleteRef(input:{refId:\"x\"}){clientMutationId}}'" },
  { command: "rm -rf node_modules" },
  { command: "npm test" },
  // Sondas de `Bash(git *)`: nenhum subcomando git fora dos liberados pode passar.
  { command: "git rebase -i master" },
  { command: "git branch -D master" },
  { command: "git config core.hooksPath /tmp/x" },
  { command: "git reset --soft HEAD~5" },
  { command: "git checkout -- scripts" , knownMatchBy: "Bash(git checkout *)" },
  // Limitações conhecidas de regras anteriores ao #11235 (não alteradas aqui).
  { command: "git push --force origin master", knownMatchBy: "Bash(git push *)" },
  { command: "npx tsx --test test/", knownMatchBy: "Bash(npx tsx --test *)" },
  { command: "npm run test", knownMatchBy: "Bash(npm run *)" },
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
