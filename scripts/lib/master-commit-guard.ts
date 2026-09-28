/**
 * scripts/lib/master-commit-guard.ts (#8878)
 *
 * Lógica pura do guard git `pre-commit` que bloqueia commit direto em
 * master/main NESTE checkout — independente de QUEM chamou `git commit`
 * (humano no terminal, sessão do Claude Code, ou o agente nativo do
 * gateway Hermes/Telegram — perfil default, `gpt-6-luna`/`gpt-5.6-luna`
 * conforme `~/.hermes/config.yaml`).
 *
 * Por que isto e não só `.claude/hooks/block-continuo-master-commit.mjs`
 * (#8588): aquele hook é um `PreToolUse` do HARNESS do Claude Code — só
 * dispara quando o `Bash` que roda `git commit` é invocado DENTRO de uma
 * sessão do Claude Code (interativa, ou via `claude -p` disparado por
 * `hermes/scripts/claude-delegate.sh`, que exporta `DIARIA_SESSION_KIND=
 * continuo`). O incidente do #8878 não passou por nenhum dos dois: o
 * agente do gateway Hermes que respondeu no Telegram usa o PRÓPRIO tool de
 * terminal nativo do Hermes (fora do Claude Code inteiramente) — nenhum
 * hook de `.claude/hooks/` roda nesse caminho, porque não existe sessão do
 * Claude Code ali.
 *
 * Um git hook de verdade (`$GIT_DIR/hooks/pre-commit`) não tem esse ponto
 * cego: ele dispara pra QUALQUER `git commit` neste checkout, seja o
 * invocador um terminal humano, o Hermes nativo, ou o Claude Code — porque
 * é o próprio `git` quem o chama, não um harness específico. Instalado via
 * `npm run setup-hooks` (documentado em `docs/setup.md`, passo 2a).
 *
 * Hooks git são COMPARTILHADOS entre o checkout principal e todos os
 * worktrees (confirmado: `git rev-parse --git-path hooks` devolve o MESMO
 * path absoluto em qualquer worktree deste repo) — instalar uma vez no
 * checkout compartilhado do `300` cobre commits feitos a partir de
 * qualquer worktree também, sem reinstalar por worktree.
 *
 * Override explícito: `DIARIA_ALLOW_MASTER_COMMIT=1`. Pensado pro editor
 * humano, num caso legítimo e raro de commit direto (ex: fix trivial de
 * docs fora do fluxo de PR). Nunca deve ser exportado de forma persistente
 * por um processo automatizado — mesma disciplina do #5608/#6714 (bypass é
 * ação humana deliberada no momento do commit, não ambiente herdado).
 *
 * Limitação honesta (documentada, não escondida): isto NÃO é um guard
 * versionado que se auto-instala — `$GIT_DIR/hooks/` nunca é rastreado
 * pelo git. Quem roda `npm ci`/`npm install` num checkout novo (incluindo
 * o checkout compartilhado do `300`, se ele for recriado) precisa rodar
 * `npm run setup-hooks` de novo. Ver `scripts/hooks/pre-commit`.
 */

export function isProtectedBranch(branch: string | null | undefined): boolean {
  return branch === "master" || branch === "main";
}

/** `true` sse o commit em `branch` deve ser bloqueado dado `env`. */
export function shouldBlockCommit(
  branch: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!isProtectedBranch(branch)) return false;
  return env.DIARIA_ALLOW_MASTER_COMMIT !== "1";
}

export function blockMessage(branch: string): string {
  return [
    `BLOQUEADO (#8878): commit direto em "${branch}" neste checkout.`,
    'Fluxo do projeto é sempre branch + PR + merge (CLAUDE.md, "1 PR aberto por vez").',
    "Crie uma branch (git checkout -b <slug>) ou um worktree antes de commitar.",
    "Se isto é intencional e humano (raro), rode com DIARIA_ALLOW_MASTER_COMMIT=1 git commit ...",
  ].join("\n");
}
