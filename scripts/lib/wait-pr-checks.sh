#!/usr/bin/env bash
# scripts/lib/wait-pr-checks.sh (#6921)
#
# Espera os checks de uma PR saírem do estado "pendente", com TETO DE VIDA
# embutido. Existe pra ser o ÚNICO lugar onde alguém precisa lembrar dessa
# disciplina: achado ao vivo no #6921 — 5 laços `while true; do gh pr
# checks ...; sleep 20; done` escritos à mão por sessões de agente ficaram
# órfãos no `300` por até 15h, todos vigiando PRs já mergeadas há horas,
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
#   scripts/lib/wait-pr-checks.sh <PR> [timeout_secs=1800] [poll_secs=20] [queue_ceiling_secs=3600]
#
# Fila de runner (#10578): o tempo em que o gate reporta checks ainda na
# FILA do GitHub (`queued=K` com K>0 na linha `queue:` de
# check-pr-checks-gate.ts — nenhum runner pegou o job) NÃO consome o teto:
# o prazo efetivo é `timeout_secs + tempo_em_fila`, limitado por
# `queue_ceiling_secs` (teto absoluto, nunca um laço sem fim — #6921 segue
# valendo). Achado da rodada 261019d: runs enfileiradas ~35 min fizeram o
# teto de 30 min estourar em 6 PRs que depois ficaram verdes. Check
# RODANDO sem concluir (queued=0) segue com o teto normal — esse é o caso
# "sem progresso".
#
# Exit codes:
#   0 = checks pararam de estar "pending" (chamador decide se PASSOU ou
#       FALHOU rodando `check-pr-checks-gate.ts`/`gh pr checks` de novo —
#       este script só responde "não está mais pendente", nunca "passou")
#   1 = TIMEOUT — teto de vida estourou; mensagem nomeada em stderr, nunca
#       confundida com "ainda rodando silenciosamente"
#   2 = uso inválido (PR ausente)
#   7 = FILA — o teto absoluto (`queue_ceiling_secs`) estourou com checks
#       ainda na fila de runner, sem nenhuma falha (#10578). NÃO é CI
#       vermelho nem `ci_timeout`: o coordenador reaguarda (nova chamada
#       deste helper) em vez de tratar como falha. rc=1 fica reservado pra
#       "rodando sem concluir dentro do prazo".
#   3 = ERRO PERSISTENTE do gate (rc=3/"error" de check-pr-checks-gate.ts
#       repetido `MAX_ERROR_STREAK` vezes seguidas — #6937, achado de
#       review: uma falha TRANSITÓRIA isolada (`gh` com rate-limit, blip de
#       rede) não pode fazer o laço concluir "parou de estar pendente" por
#       engano — rc=3 significa "não sei", nunca "resolveu". Só retentar
#       infinitamente também seria errado (mascara uma falha real e
#       persistente, ex: `gh` desinstalado) — daí o teto PRÓPRIO, distinto
#       do teto de tempo (timeout_secs), pra essa classe de erro.
#   6 = INCOMPATIBILIDADE DE gh (rc=6/"gh_incompatible_flags" de
#       check-pr-checks-gate.ts — #8425). Sai NA 1ª ocorrência, sem
#       retentar e sem esperar `poll_secs`/`max_error_streak`: diferente do
#       rc=3 acima (que PODE ser transitório), uma flag/campo `--json` não
#       suportado pela versão instalada do `gh` é uma condição PERMANENTE —
#       a 2ª, a 10ª e a 100ª tentativa falham exatamente do mesmo jeito.
#       Foi essa distinção que faltou no achado original do #8425: um laço
#       `until gh pr checks {N} --json bucket --jq '...'; do sleep 30;
#       done` escrito à mão (fora deste helper) ficou órfão 5h+ batendo na
#       API do GitHub, porque a condição de saída nunca podia ser
#       satisfeita — nem um teto de tempo o teria corrigido "certo": ele só
#       teria parado de esperar, sem nunca ter lido o estado real do PR.
#       Este helper nunca cai nesse buraco porque delega pra
#       `check-pr-checks-gate.ts` (que usa `gh pr view`, não `gh pr
#       checks --json`) — mas se uma incompatibilidade equivalente aparecer
#       nessa chamada no futuro (ex: um campo `--json` novo não suportado
#       por um `gh` mais antigo), o laço aborta ALTO em vez de mascarar
#       como erro genérico retentável.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# `check_pr_checks_once`: roda o gate uma vez, devolve o exit code dele
# (0=pass, 1=fail, 2=pending, 3=error, 4=blocked_by_conflict,
# 5=claude_binary_error, 6=gh_incompatible_flags — ver
# scripts/check-pr-checks-gate.ts). Função separada (não inline no loop)
# de propósito — o teste de regressão sobrescreve esta função DEPOIS de
# sourcear o arquivo, pra exercitar a lógica do loop (timeout, contagem de
# tempo decorrido) sem depender de rede nem de uma PR real.
#
# Captura stdout+stderr em `LAST_GATE_OUTPUT` (variável global, não local —
# precisa sobreviver ao `return` desta função) pra citar o motivo na
# mensagem de abort do rc=6 (#8425) e pra ler a linha `queue: queued=K` no
# rc=2 (#10578 — fila de runner estende o teto).
check_pr_checks_once() {
  local pr="$1"
  LAST_GATE_OUTPUT=$( cd "$REPO_ROOT" && npx tsx scripts/check-pr-checks-gate.ts --pr "$pr" 2>&1 )
  return $?
}

# `wait_pr_checks`: o laço em si — separado do bloco de entrypoint abaixo
# pelo mesmo motivo (testável isoladamente via source, sem herdar o `exit`
# do script inteiro).
wait_pr_checks() {
  local pr="$1" timeout_secs="${2:-1800}" poll_secs="${3:-20}" queue_ceiling_secs="${4:-3600}"
  local start elapsed rc now deadline
  local error_streak=0
  local max_error_streak=5
  # #10578: segundos acumulados em que o gate viu checks na FILA de runner
  # (queued>0) — somados ao teto. `last_queued` é o queued da última leitura
  # pending (um rc=3 transitório não o zera), usado pra escolher rc=7 (fila)
  # vs rc=1 (sem progresso).
  local queued_secs=0 last_queued=0 last_poll_at queued

  # O teto absoluto nunca fica abaixo do teto normal (chamador que passou
  # timeout > ceiling mantém o comportamento pré-#10578).
  if [ "$queue_ceiling_secs" -lt "$timeout_secs" ]; then
    queue_ceiling_secs="$timeout_secs"
  fi

  start=$(date +%s)
  last_poll_at="$start"
  while true; do
    now=$(date +%s)
    # #10578: o intervalo desde a última leitura conta como fila quando essa
    # leitura viu checks na fila de runner (o job seguia sem runner até aqui).
    if [ "$last_queued" -gt 0 ]; then
      queued_secs=$(( queued_secs + now - last_poll_at ))
    fi
    last_poll_at="$now"
    elapsed=$(( now - start ))
    deadline=$(( timeout_secs + queued_secs ))
    if [ "$deadline" -gt "$queue_ceiling_secs" ]; then
      deadline="$queue_ceiling_secs"
    fi
    if [ "$elapsed" -ge "$deadline" ]; then
      if [ "$last_queued" -gt 0 ]; then
        echo "[wait-pr-checks] FILA: PR #$pr com $last_queued check(s) ainda na fila de runner do GitHub após ${elapsed}s (teto absoluto ${queue_ceiling_secs}s, ${queued_secs}s em fila) — nenhuma falha; NÃO é CI vermelho nem ci_timeout, reaguardar (#10578). Conferir: gh pr checks $pr" >&2
        return 7
      fi
      echo "[wait-pr-checks] TIMEOUT: PR #$pr com checks pendentes após ${elapsed}s — abortando espera (teto de vida, #6921, nunca um laço órfão). Investigar manualmente: gh pr checks $pr" >&2
      return 1
    fi

    LAST_GATE_OUTPUT=""
    check_pr_checks_once "$pr"
    rc=$?

    # #8425: rc=6 (gh_incompatible_flags) é PERMANENTE, nunca transitório —
    # aborta na 1ª ocorrência, sem passar pelo `error_streak` do rc=3 nem
    # esperar `poll_secs`. Checar ANTES do bloco de rc=3 de propósito: as
    # duas classes de erro nunca podem ser confundidas (uma é "talvez
    # resolva sozinho", a outra é "nunca vai resolver sozinho").
    if [ "$rc" -eq 6 ]; then
      echo "[wait-pr-checks] INCOMPATIBILIDADE DE gh: PR #$pr — abortando espera na 1ª ocorrência, nunca retentando um comando que não pode funcionar nesta instalação (#8425). ${LAST_GATE_OUTPUT:-}" >&2
      return 6
    fi

    # #6937 (review da PR #6937): rc=3 ("error" — gh falhou, PR sumiu,
    # JSON malformado) é "não sei", NUNCA "resolveu". Tratar igual a
    # rc=2 (pending) e retentar — mas com teto PRÓPRIO de tentativas
    # consecutivas, pra não mascarar um erro persistente (gh desinstalado,
    # PR de fato inexistente) como espera infinita.
    if [ "$rc" -eq 3 ]; then
      error_streak=$((error_streak + 1))
      if [ "$error_streak" -ge "$max_error_streak" ]; then
        echo "[wait-pr-checks] ERRO PERSISTENTE: PR #$pr — check-pr-checks-gate.ts falhou (rc=3) $error_streak vezes seguidas — abortando espera. Investigar: gh pr view $pr" >&2
        return 3
      fi
      sleep "$poll_secs"
      continue
    fi
    error_streak=0

    if [ "$rc" -ne 2 ]; then
      echo "[wait-pr-checks] PR #$pr: checks não-pendentes após ${elapsed}s (verdict rc=$rc — chamador decide passou/falhou)"
      return 0
    fi

    # #10578: pending — quantos checks seguem na fila de runner? Ausência da
    # linha `queue:` (gate antigo, rollup vazio, janela de corrida) = 0.
    queued=$(printf '%s\n' "${LAST_GATE_OUTPUT:-}" | grep -o 'queue: queued=[0-9][0-9]*' | tail -n 1 | grep -o '[0-9][0-9]*$')
    last_queued="${queued:-0}"

    sleep "$poll_secs"
  done
}

# Guard #2019-style: só roda o entrypoint quando este arquivo é executado
# diretamente, nunca quando `source`ado (mesmo padrão de
# continuo-branch-prefix.sh) — permite ao teste de regressão sourcear e
# sobrescrever `check_pr_checks_once` sem disparar o loop de verdade.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [ -z "${1:-}" ]; then
    echo "[wait-pr-checks] uso: wait-pr-checks.sh <PR> [timeout_secs=1800] [poll_secs=20] [queue_ceiling_secs=3600]" >&2
    exit 2
  fi
  wait_pr_checks "$1" "${2:-1800}" "${3:-20}" "${4:-3600}"
  exit $?
fi
