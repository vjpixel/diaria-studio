#!/usr/bin/env bash
# hermes/scripts/lib/codex-lane.sh (#10560) — elo `codex exec` da cadeia de
# implementação do contínuo (sourced por `claude-delegate.sh`).
#
# Decisão do editor (briefing overnight 261019e): caminho 2 — Sol 6.1 com
# esforço leve pelo plano OpenAI (OAuth da Codex CLI, o mesmo que o Hermes
# usa), como elo ANTERIOR aos `:free`, com fallback na cadeia atual. Nunca
# pelo OpenRouter (pago por token, #10387) nem por ANTHROPIC_BASE_URL.
#
# DESLIGADO POR PADRÃO. Liga com `CLAUDE_DELEGATE_CODEX_LANE=1` no ambiente
# do call site. Motivo: a issue manda medir o consumo da cota (compartilhada
# com o orquestrador `gpt-6-luna` do tick) antes de pôr o elo em primeiro, e
# o comportamento real do `codex exec` no `300` (sandbox, auth do plano) não é
# exercitável em CI — os testes usam um `codex` falso.
#
# O que se perde ao sair do Claude Code: os hooks de `.claude/hooks/` não
# rodam dentro do `codex exec`. Os 3 que a issue nomeia viram guard AQUI,
# escopados ao processo filho (nunca ao shell global nem ao checkout):
#
#   1. block-continuo-master-commit.mjs (#8588) → `core.hooksPath` por
#      VARIÁVEL DE AMBIENTE (GIT_CONFIG_COUNT/KEY/VALUE, nunca `git config`
#      gravado no repo) apontando pra `codex-lane/hooks/`. O hook
#      `reference-transaction` recusa QUALQUER atualização de
#      refs/heads/master|main — cobre commit, merge, cherry-pick, revert, am,
#      update-ref, reset e pull (mais que o hook do Claude Code, que só via o
#      texto do comando) e não é contornável por `--no-verify`. Os demais
#      nomes de hook encadeiam pro diretório de hooks original do repo
#      (`.git/hooks`, ex.: o pre-commit do #8878), então nada que já roda
#      deixa de rodar.
#   2. inject-session-id.mjs (#5751) → `DIARIA_INJECTED_SESSION_ID` (id do
#      TICK) no ambiente do `codex`; `session-registry.ts` usa esse valor
#      quando `--session-id` falta, só em claim/lease
#      (`resolveEnvInjectedSessionId`, scripts/lib/session-id-required-
#      subcommands.ts). Sem session-id do tick legível, o elo NÃO liga.
#   3. pr-create-review.mjs → `gh` shim em `codex-lane/bin/gh` na frente do
#      PATH: recusa `gh pr merge` (e merge via `gh api`), recusa `gh pr
#      create` fora de branch `continuo/*`, roda o guard de PII/artefato de
#      runtime (`block-pr-create-pii-runtime-artifacts.mjs`) antes de criar, e
#      registra a PR criada. O review em si é o `continuo-pr-review.sh` (cron,
#      revisa TODA PR aberta e é o único merger) — o mesmo gate que já vale
#      pras PRs do elo `claude -p`.
#
# Preflight fail-closed: se qualquer guard não puder ser armado, o elo é
# PULADO (a cadeia segue nos `:free` → assinatura); nunca roda sem guard.

CODEX_LANE_SENTINEL="codex:gpt-6.1-sol"
# ID e esforço confirmados ao vivo no `300` (comentário do editor na #10560,
# `codex debug models`, codex-cli 0.159.1) — não derivar de memória nem do
# `~/.codex/models_cache.json` (parado em 29/09, sem a família Sol).
CODEX_LANE_MODEL="gpt-6.1-sol"
# Fixado explicitamente, nunca herdado do default do CLI (#8941). O `--effort`
# do call site do claude-delegate.sh NÃO se aplica a este elo: a decisão do
# editor é Sol 6.1 em esforço leve.
CODEX_LANE_EFFORT="low"
# Paridade com o elo `claude -p`, que já roda com Bash irrestrito no checkout.
# `workspace-write` é mais estrito mas bloqueia rede (gh) e escrita fora do
# cwd (~/.npm do npx) por padrão — validar no `300` antes de trocar.
CODEX_LANE_SANDBOX_DEFAULT="danger-full-access"
# Backoff depois de sinal de cota/usage-limit do plano: o elo é pulado nas
# invocações seguintes até expirar, pra não disputar a cota com o
# orquestrador do tick (risco nomeado na issue). O reset real do plano não é
# exposto pela CLI — 6h é conservador; ajustável por env.
CODEX_LANE_QUOTA_BACKOFF_S_DEFAULT=21600

# Vars que NUNCA chegam ao `codex`: chave de API OpenAI faria a CLI cobrar
# por token em vez de usar o plano (mesma classe do #5608 pra Anthropic), e
# as ANTHROPIC_* não têm o que fazer lá.
CODEX_LANE_STRIPPED_ENV_VARS=(OPENAI_API_KEY OPENAI_BASE_URL OPENAI_ORG_ID OPENAI_PROJECT_ID CODEX_API_KEY \
  ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL)

codex_lane_dir() {
  local here
  here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
  echo "$(dirname "$here")/codex-lane"
}

is_codex_lane_model() {
  [ "${1:-}" = "$CODEX_LANE_SENTINEL" ]
}

codex_lane_enabled() {
  [ "${CLAUDE_DELEGATE_CODEX_LANE:-0}" = "1" ]
}

codex_lane_quota_marker() {
  echo "${TMPDIR:-/tmp}/codex-lane-quota-exhausted-until"
}

codex_lane_resolve_bin() {
  if [ -n "${CODEX_BIN:-}" ]; then
    echo "$CODEX_BIN"
    return 0
  fi
  local found
  if found=$(command -v codex 2>/dev/null) && [ -n "$found" ]; then
    echo "$found"
    return 0
  fi
  # O binário do `300` fica fora do PATH de ssh não-interativo (#10560).
  if [ -x "${HOME:-}/.npm-global/bin/codex" ]; then
    echo "${HOME}/.npm-global/bin/codex"
    return 0
  fi
  return 1
}

codex_lane_resolve_session_id() {
  if [ -n "${DIARIA_CONTINUO_SESSION_ID:-}" ]; then
    echo "$DIARIA_CONTINUO_SESSION_ID"
    return 0
  fi
  local f="${TMPDIR:-/tmp}/hermes-continuo-current-session-id"
  local sid=""
  [ -r "$f" ] && sid=$(tr -d '[:space:]' < "$f" 2>/dev/null || true)
  [ -n "$sid" ] || return 1
  echo "$sid"
}

# Preflight: imprime o motivo em stdout e devolve 1 quando o elo não pode
# rodar com os guards armados. Devolve 0 e exporta CODEX_LANE_BIN,
# CODEX_LANE_SESSION_ID e CODEX_LANE_SANDBOX quando pode.
codex_lane_preflight() {
  local cwd="$1"
  local dir
  dir="$(codex_lane_dir)"
  if ! CODEX_LANE_BIN=$(codex_lane_resolve_bin); then
    echo "binário codex não encontrado (CODEX_BIN, PATH, ~/.npm-global/bin/codex)"
    return 1
  fi
  if [ ! -x "$CODEX_LANE_BIN" ]; then
    echo "binário codex '$CODEX_LANE_BIN' não é executável"
    return 1
  fi
  if [ ! -x "$dir/hooks/reference-transaction" ]; then
    echo "guard de master (#8588) ausente: $dir/hooks/reference-transaction não é executável"
    return 1
  fi
  if [ ! -x "$dir/bin/gh" ]; then
    echo "gh shim (merge/pr-create) ausente: $dir/bin/gh não é executável"
    return 1
  fi
  if [ -n "${GIT_CONFIG_COUNT:-}" ]; then
    echo "GIT_CONFIG_COUNT já definido no ambiente ($GIT_CONFIG_COUNT) — não dá pra armar core.hooksPath por env sem sobrescrever config alheia"
    return 1
  fi
  local repo_hooks_path
  repo_hooks_path=$(git -C "$cwd" config --get core.hooksPath 2>/dev/null || true)
  if [ -n "$repo_hooks_path" ]; then
    echo "o repo já define core.hooksPath ('$repo_hooks_path') — o encadeamento pros hooks originais assume .git/hooks"
    return 1
  fi
  if ! CODEX_LANE_SESSION_ID=$(codex_lane_resolve_session_id); then
    echo "session-id do tick ausente (DIARIA_CONTINUO_SESSION_ID ou \${TMPDIR}/hermes-continuo-current-session-id) — sem ele a injeção de --session-id (#5751) não tem valor"
    return 1
  fi
  CODEX_LANE_SANDBOX="${CODEX_LANE_SANDBOX:-$CODEX_LANE_SANDBOX_DEFAULT}"
  case "$CODEX_LANE_SANDBOX" in
    read-only|workspace-write|danger-full-access) ;;
    *) echo "CODEX_LANE_SANDBOX inválido: '$CODEX_LANE_SANDBOX'"; return 1 ;;
  esac
  local marker now until_epoch
  marker="$(codex_lane_quota_marker)"
  if [ -f "$marker" ]; then
    now=$(date -u +%s)
    until_epoch=$(tr -d '[:space:]' < "$marker" 2>/dev/null || echo "")
    case "$until_epoch" in
      ''|*[!0-9]*) ;;
      *)
        if [ "$now" -lt "$until_epoch" ]; then
          echo "cota do plano marcada como esgotada até $(date -u -d "@$until_epoch" -Iseconds 2>/dev/null || echo "$until_epoch") — elo pulado pra não disputar com o orquestrador"
          return 1
        fi
        ;;
    esac
  fi
  export CODEX_LANE_BIN CODEX_LANE_SESSION_ID CODEX_LANE_SANDBOX
  return 0
}

# Arma o elo no shell CORRENTE (nunca via `$(...)`, que perderia os exports
# do preflight). 0 = armado; 1 = não armado, motivo em
# CODEX_LANE_PREFLIGHT_REASON.
codex_lane_try_arm() {
  local out
  out=$(mktemp "${TMPDIR:-/tmp}/codex-lane-preflight.XXXXXX") || {
    CODEX_LANE_PREFLIGHT_REASON="mktemp falhou"
    return 1
  }
  if codex_lane_preflight "$1" > "$out"; then
    rm -f "$out"
    CODEX_LANE_PREFLIGHT_REASON=""
    return 0
  fi
  CODEX_LANE_PREFLIGHT_REASON=$(cat "$out" 2>/dev/null || true)
  rm -f "$out"
  return 1
}

codex_lane_mark_quota_exhausted() {
  local backoff="${CODEX_LANE_QUOTA_BACKOFF_S:-$CODEX_LANE_QUOTA_BACKOFF_S_DEFAULT}"
  case "$backoff" in ''|*[!0-9]*) backoff="$CODEX_LANE_QUOTA_BACKOFF_S_DEFAULT" ;; esac
  echo $(( $(date -u +%s) + backoff )) > "$(codex_lane_quota_marker)" 2>/dev/null || true
}

codex_lane_pr_log() {
  echo "${TMPDIR:-/tmp}/codex-lane-pr-created.log"
}

# Foto do estado que um `codex exec` deixa pra trás quando trabalha: linhas do
# log de PRs criadas pelo gh shim, branches `continuo/*` (nome + sha) e
# worktrees do repo de $1. Comparada antes/depois da tentativa por
# `codex_lane_partial_work` (review da PR #10583, P2): se o codex criou
# branch, commitou, abriu worktree ou PR e depois saiu com rc≠0 (timeout,
# usage limit no meio), passar o MESMO prompt pro próximo elo reimplementaria
# e podia abrir uma 2ª PR. Mudança feita por OUTRA sessão no mesmo intervalo
# também conta — falso positivo aqui só aborta a cadeia (lado seguro), nunca
# duplica trabalho.
codex_lane_snapshot_state() {
  local cwd="$1" log n=0
  log="$(codex_lane_pr_log)"
  [ -f "$log" ] && n=$(wc -l < "$log" 2>/dev/null | tr -d '[:space:]')
  printf 'prlog-lines %s\n' "${n:-0}"
  git -C "$cwd" for-each-ref --format='branch %(refname:short) %(objectname)' 'refs/heads/continuo/' 2>/dev/null || true
  git -C "$cwd" worktree list --porcelain 2>/dev/null | command grep '^worktree ' || true
}

# 0 = houve trabalho parcial desde o snapshot $2 (descrição em stdout);
# 1 = estado idêntico.
codex_lane_partial_work() {
  local cwd="$1" before="$2" after
  after=$(codex_lane_snapshot_state "$cwd")
  [ "$before" = "$after" ] && return 1
  # Só as linhas novas/alteradas (`comm` exige entrada ordenada).
  comm -13 <(printf '%s\n' "$before" | sort) <(printf '%s\n' "$after" | sort) | tr '\n' ';' | sed 's/;$//'
  echo
  return 0
}

codex_lane_preamble() {
  cat <<'EOF'
[Elo codex exec do contínuo — #10560]
Você está rodando pela Codex CLI, NÃO pelo Claude Code: os hooks de
.claude/hooks/ não rodam neste processo. Antes de qualquer coisa, leia o
CLAUDE.md da raiz do repositório — ele é a instrução do projeto e vale
inteiro aqui. Guards ativos neste processo (não tente contorná-los):
- O git recusa qualquer atualização de refs/heads/master ou refs/heads/main
  (commit, merge, reset, update-ref, pull). Crie a branch continuo/fix-<issue>-<slug>
  (ou um worktree em .claude/worktrees/) ANTES do 1º commit.
- `gh pr merge` (e merge via `gh api`) é recusado: você nunca mergeia.
  `gh pr create` só é aceito a partir de branch continuo/*.
- `npx tsx scripts/lib/session-registry.ts claim-issue|unclaim-issue|is-claimed|heartbeat|conflicts`
  recebem o session-id do tick automaticamente. Não invente --session-id.
- O review da PR é feito depois pelo continuo-pr-review.sh; não espere CI nem review.

EOF
}

# Roda o `codex exec` com os guards armados. Prompt do caller no stdin;
# stdout = resposta final; stderr vai pro arquivo $3. Exit 97 = guard de
# ambiente fail-closed (var proibida sobreviveu ao unset) — o caller aborta a
# cadeia inteira, mesma semântica do elo de assinatura (#7649).
codex_lane_run() {
  local timeout_s="$1" cwd="$2" attempt_log="$3"
  local dir
  dir="$(codex_lane_dir)"
  { codex_lane_preamble; cat; } | (
    unset "${CODEX_LANE_STRIPPED_ENV_VARS[@]}"
    for _codex_guard_var in "${CODEX_LANE_STRIPPED_ENV_VARS[@]}"; do
      if [ -n "${!_codex_guard_var:-}" ]; then
        echo "FATAL (#10560): $_codex_guard_var sobreviveu ao unset explícito no elo codex — abortando ANTES de invocar codex (chave de API cobraria por token em vez do plano)." >&2
        exit 97
      fi
    done
    export PATH="$dir/bin:$PATH"
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0="core.hooksPath"
    export GIT_CONFIG_VALUE_0="$dir/hooks"
    export DIARIA_INJECTED_SESSION_ID="$CODEX_LANE_SESSION_ID"
    export DIARIA_SESSION_KIND=continuo
    export DIARIA_CODEX_LANE=1
    timeout "$timeout_s" "$CODEX_LANE_BIN" exec \
      -m "$CODEX_LANE_MODEL" \
      -c "model_reasoning_effort=\"$CODEX_LANE_EFFORT\"" \
      --sandbox "$CODEX_LANE_SANDBOX" \
      -C "$cwd" \
      - 2> "$attempt_log"
  )
}
