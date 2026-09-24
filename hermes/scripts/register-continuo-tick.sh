#!/usr/bin/env bash
# register-continuo-tick.sh (#8740, 24/09/2026)
#
# Fecha o gap medido pelo #7890/#8740: `session-registry.ts register --kind
# continuo` (SKILL.md `hermes-diaria-continuo`, passo 1.3) vivia DENTRO do
# tick — se o tick falhasse cedo (rate limit, credencial, path de skill
# errado — foi exatamente o que aconteceu no tick correlacionado
# `cron_5d791ef6fc2c_20260923_004012`, ver #8740), o registro nunca
# acontecia e o alarme `check-continuo-session-registration.ts` disparava.
# Decisão do editor (#8740, 24/09/2026, briefing overnight 260924): wrapper
# no cron registra a sessão DETERMINISTICAMENTE, ANTES de invocar o modelo,
# em vez de depender do modelo lembrar de um passo no meio de uma skill
# longa.
#
# O que este script FAZ e NÃO FAZ:
#   - FAZ: gera o SESSION_ID no mesmo formato que o tick já usa
#     (`hermes-cron-<job>-<ts>`, ver SKILL.md passo 1.3/#6443) e chama
#     `session-registry.ts register --kind continuo` antes de qualquer
#     invocação de modelo.
#   - FAZ: grava o SESSION_ID recém-registrado num path ESTÁVEL
#     ($SESSION_ID_FILE, default `${TMPDIR:-/tmp}/hermes-continuo-current-
#     session-id`) — o tick lê esse arquivo (SKILL.md passo 1.3 atualizado)
#     em vez de gerar/registrar de novo, fechando a duplicação (#8740 pede
#     "atualizar a skill para não duplicar o registro").
#   - NÃO invoca `claude-delegate.sh`/o modelo — de propósito. A proposta
#     original (item 1 do #7890/#8740) foi adiada uma vez por tocar o
#     contrato de `claude-delegate.sh`, que é reusado por OUTRAS skills do
#     Hermes (#8740, comentário do auto-reporter). Este script fica
#     dedicado ao contínuo — mexe só no que é específico dele — em vez de
#     generalizar o wrapper genérico. Ligar isto ao cron (fazer o job
#     `5d791ef6fc2c` rodar este script antes de despachar o agente) é ação
#     manual FORA deste repo, mesma disciplina de deploy dos stubs
#     documentada em `hermes/README.md`.
#
# Fail-soft (#8740, pedido explícito): falha no registro LOGA e NÃO impede
# o tick — o objetivo é reduzir a taxa de ticks sem registro, não introduzir
# um novo ponto único de falha que trava o contínuo inteiro. Por isso este
# script NUNCA propaga `set -e` pro comando de registro em si: captura rc,
# loga em caso de erro, e sempre sai 0 (a chamada em si não deve derrubar o
# cron nem o tick que vem depois).
#
# Uso:
#   hermes/scripts/register-continuo-tick.sh [JOB_ID]
#   (JOB_ID default: 5d791ef6fc2c — o job de cron do tick do contínuo, ver
#   hermes/README.md. Pode ser sobreposto por HERMES_CONTINUO_JOB_ID.)
#
# Variáveis de ambiente pra teste/override (nunca usadas em produção):
#   REPO_ROOT_OVERRIDE       — cwd usado pra `npx tsx` (default: checkout real)
#   SESSION_ID_FILE_OVERRIDE — path do arquivo estável (default: /tmp/...)
#   SESSION_TS_OVERRIDE      — timestamp determinístico (testes)
set -uo pipefail

JOB_ID="${1:-${HERMES_CONTINUO_JOB_ID:-5d791ef6fc2c}}"
REPO_ROOT="${REPO_ROOT_OVERRIDE:-/home/vjpixel/diaria-studio}"
SESSION_ID_FILE="${SESSION_ID_FILE_OVERRIDE:-${TMPDIR:-/tmp}/hermes-continuo-current-session-id}"
TS="${SESSION_TS_OVERRIDE:-$(date -u +%Y%m%dT%H%M%SZ)}"

SESSION_ID="hermes-cron-${JOB_ID}-${TS}"

if ! cd "$REPO_ROOT" 2>/dev/null; then
  echo "[register-continuo-tick] AVISO: não consegui entrar em $REPO_ROOT — registro pulado (fail-soft), tick segue" >&2
  echo "$SESSION_ID"
  exit 0
fi

if OUT=$(npx tsx scripts/lib/session-registry.ts register --kind continuo --session-id "$SESSION_ID" 2>&1); then
  echo "[register-continuo-tick] $OUT" >&2
  # Path estável: sobrescrito a cada tick de propósito (o tick seguinte só
  # precisa do MAIS RECENTE) — mesmo raciocínio de
  # `claude-openrouter-last-failure.log` (#6666 item 1) citado em
  # `claude-delegate.sh`.
  if ! echo "$SESSION_ID" > "$SESSION_ID_FILE" 2>/dev/null; then
    echo "[register-continuo-tick] AVISO: registro OK mas não consegui gravar $SESSION_ID_FILE — o tick vai precisar regenerar o SESSION_ID (fallback do passo 1.3)" >&2
  fi
else
  echo "[register-continuo-tick] AVISO: session-registry.ts register falhou (fail-soft, tick segue): $OUT" >&2
fi

# Sempre imprime o SESSION_ID em stdout (registrado ou não) — quem invoca
# este script (cron/operador) pode capturar e propagar pro tick mesmo
# quando a escrita do arquivo falhou.
echo "$SESSION_ID"
exit 0
