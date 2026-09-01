#!/usr/bin/env bash
# scripts/lib/wait-pr-checks.sh (#6921)
#
# Espera os checks de uma PR saírem do estado "pendente", com TETO DE VIDA
# embutido. Existe pra ser o ÚNICO lugar onde alguém precisa lembrar dessa
# disciplina: achado ao vivo no #6921 — 5 laços `while true; do gh pr
# checks ...; sleep 20; done` escritos à mão por sessões de agente ficaram
# órfãos no `helios` por até 15h, todos vigiando PRs já mergeadas há horas,
# batendo na API do GitHub sem parar porque nenhum tinha timeout nem teto
# de iteração — a vida do laço estava atada à intenção de quem o criou, não
# a um dono verificável. O CI deste repo leva ~8min (#6877); nenhuma espera
# legítima precisa de mais que uma pequena margem sobre isso.
#
# Delega a PERGUNTA "os checks ainda estão pendentes?" pra
# `scripts/check-pr-checks-gate.ts` (mesmo gate que overnight/develop/
# continuo já usam pra decidir merge) — não reimplementa parsing de `gh pr
# checks`, que além de tudo não suporta `--json` em toda versão instalada
# (#6225/#6923). Esta função É a única parte que o resto do script chama,
# e é sobrescrevível por quem for TESTAR o loop sem gastar uma chamada de
# rede real por iteração (ver `test/wait-pr-checks-6921.test.ts`).
#
# Uso:
#   scripts/lib/wait-pr-checks.sh <PR> [timeout_secs=1800] [poll_secs=20]
#
# Exit codes:
#   0 = checks pararam de estar "pending" (chamador decide se PASSOU ou
#       FALHOU rodando `check-pr-checks-gate.ts`/`gh pr checks` de novo —
#       este script só responde "não está mais pendente", nunca "passou")
#   1 = TIMEOUT — teto de vida estourou; mensagem nomeada em stderr, nunca
#       confundida com "ainda rodando silenciosamente"
#   2 = uso inválido (PR ausente)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# `check_pr_checks_once`: roda o gate uma vez, devolve o exit code dele
# (0=pass, 1=fail, 2=pending, 3=error, 4=blocked_by_conflict — ver
# scripts/check-pr-checks-gate.ts). Função separada (não inline no loop)
# de propósito — o teste de regressão sobrescreve esta função DEPOIS de
# sourcear o arquivo, pra exercitar a lógica do loop (timeout, contagem de
# tempo decorrido) sem depender de rede nem de uma PR real.
check_pr_checks_once() {
  local pr="$1"
  ( cd "$REPO_ROOT" && npx tsx scripts/check-pr-checks-gate.ts --pr "$pr" ) >/dev/null 2>&1
  return $?
}

# `wait_pr_checks`: o laço em si — separado do bloco de entrypoint abaixo
# pelo mesmo motivo (testável isoladamente via source, sem herdar o `exit`
# do script inteiro).
wait_pr_checks() {
  local pr="$1" timeout_secs="${2:-1800}" poll_secs="${3:-20}"
  local start elapsed rc

  start=$(date +%s)
  while true; do
    elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$timeout_secs" ]; then
      echo "[wait-pr-checks] TIMEOUT: PR #$pr com checks pendentes após ${timeout_secs}s — abortando espera (teto de vida, #6921, nunca um laço órfão). Investigar manualmente: gh pr checks $pr" >&2
      return 1
    fi

    check_pr_checks_once "$pr"
    rc=$?
    if [ "$rc" -ne 2 ]; then
      echo "[wait-pr-checks] PR #$pr: checks não-pendentes após ${elapsed}s (verdict rc=$rc — chamador decide passou/falhou)"
      return 0
    fi

    sleep "$poll_secs"
  done
}

# Guard #2019-style: só roda o entrypoint quando este arquivo é executado
# diretamente, nunca quando `source`ado (mesmo padrão de
# continuo-branch-prefix.sh) — permite ao teste de regressão sourcear e
# sobrescrever `check_pr_checks_once` sem disparar o loop de verdade.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [ -z "${1:-}" ]; then
    echo "[wait-pr-checks] uso: wait-pr-checks.sh <PR> [timeout_secs=1800] [poll_secs=20]" >&2
    exit 2
  fi
  wait_pr_checks "$1" "${2:-1800}" "${3:-20}"
  exit $?
fi
