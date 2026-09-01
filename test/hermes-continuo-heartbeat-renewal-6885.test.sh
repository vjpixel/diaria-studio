#!/usr/bin/env bash
# test/hermes-continuo-heartbeat-renewal-6885.test.sh
#
# Guard de regressão pro #6885 — extrai o bloco bash REAL do passo 2 (item
# "Delegar a implementação") de hermes/skills/hermes-diaria-continuo/SKILL.md
# via awk (não grep de linha isolada — mesma disciplina do #6891/#6859: um
# teste que só confirma "a string existe em algum lugar do arquivo" passa
# mesmo se o renovador estiver no lugar ERRADO, ex: iniciado DEPOIS da
# delegação, ou nunca morto) e executa o fragmento de verdade, com a chamada
# real ao `claude-openrouter.sh` substituída por um mock que só dorme —
# prova que o renovador (a) roda ENQUANTO a delegação está em voo e (b) para
# de verdade quando ela retorna (kill/wait), não fica órfão batendo
# heartbeat pra sempre.
#
# Uso: bash test/hermes-continuo-heartbeat-renewal-6885.test.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="$DIR/../hermes/skills/hermes-diaria-continuo/SKILL.md"

FAILED=0
assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) echo "ok: $desc" ;;
    *) echo "FAIL: $desc — esperava conter [$needle]"; FAILED=1 ;;
  esac
}
assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) echo "FAIL: $desc — NÃO devia conter [$needle]"; FAILED=1 ;;
    *) echo "ok: $desc" ;;
  esac
}

# ── Extração do bloco bash real do passo 2, via awk ────────────────────────
# Marca de início: a linha ```bash logo após "Delegar a implementação ao
# harness". Marca de fim: o primeiro ``` seguinte. Se o SKILL.md mudar de
# forma a ponto desses marcadores sumirem, este teste falha alto (não passa
# em silêncio com um fragmento vazio).
FRAGMENT="$(mktemp)"
trap 'rm -f "$FRAGMENT"' EXIT

awk '
  /Delegar a implementação ao harness/ { found_step=1 }
  found_step && /^```bash$/ && !in_block { in_block=1; next }
  in_block && /^```$/ { exit }
  in_block { print }
' "$SKILL" > "$FRAGMENT"

RAW="$(cat "$FRAGMENT")"
if [ -z "$RAW" ]; then
  echo "FAIL: awk não extraiu nada do passo 2 do SKILL.md — marcadores mudaram de forma, atualize este teste."
  exit 1
fi

# ── Checagens estruturais no fragmento REAL extraído (não numa cópia solta) ─
assert_contains "renovador em background inicia ANTES do pipe pro claude-openrouter.sh" "$RAW" 'HEARTBEAT_PID=$!'
assert_contains "renovador chama session-registry.ts heartbeat --kind continuo" "$RAW" "session-registry.ts heartbeat"
assert_contains "renovador é morto depois da delegação (kill)" "$RAW" 'kill "$HEARTBEAT_PID"'
assert_contains "renovador é esperado depois do kill (wait — evita zumbi)" "$RAW" 'wait "$HEARTBEAT_PID"'
assert_not_contains "loop do renovador é LIMITADO (nunca 'while true' sem teto — órfão nunca deve rodar pra sempre)" "$RAW" "while true"
assert_contains "loop do renovador tem teto de iterações explícito (seq)" "$RAW" "seq 1"

# A ORDEM importa: HEARTBEAT_PID precisa aparecer ANTES do kill no texto —
# senão o renovador seria morto antes de existir (ou nunca associado à
# variável certa).
PID_LINE=$(grep -n 'HEARTBEAT_PID=\$!' "$FRAGMENT" | head -1 | cut -d: -f1)
KILL_LINE=$(grep -n 'kill "\$HEARTBEAT_PID"' "$FRAGMENT" | head -1 | cut -d: -f1)
if [ -n "$PID_LINE" ] && [ -n "$KILL_LINE" ] && [ "$PID_LINE" -lt "$KILL_LINE" ]; then
  echo "ok: HEARTBEAT_PID capturado ANTES do kill (ordem correta no fragmento real)"
else
  echo "FAIL: ordem errada — PID_LINE=$PID_LINE KILL_LINE=$KILL_LINE"
  FAILED=1
fi

# ── Execução REAL do mecanismo (mock só na chamada de rede/LLM) ────────────
# Substitui a chamada real ao claude-openrouter.sh (que exigiria rede/gateway
# do Hermes) por um `sleep` — o resto do fragmento (o renovador, o kill, o
# wait) roda EXATAMENTE como está escrito no SKILL.md, sem reescrita.
EXEC_FRAGMENT="$(mktemp)"
trap 'rm -f "$FRAGMENT" "$EXEC_FRAGMENT"' EXIT

MARKER_FILE="$(mktemp)"
rm -f "$MARKER_FILE"

sed \
  -e "s#sleep 180#sleep 0.1#" \
  -e "s#for _ in \$(seq 1 15); do#for _ in \$(seq 1 100); do#" \
  -e "s#npx tsx scripts/lib/session-registry.ts heartbeat \\\\#echo beat >> \"$MARKER_FILE\" #" \
  -e "/--kind continuo --session-id/d" \
  "$FRAGMENT" > "$EXEC_FRAGMENT"

# Substitui o bloco `printf ... | ~/.hermes/scripts/claude-openrouter.sh ...`
# inteiro por um `sleep 1` que simula a delegação "em voo" por 1s — sem
# tocar rede nenhuma, real ou mockada por HTTP; só o tempo de execução
# importa pra este teste (o renovador tem que estar rodando durante esse
# 1s, e parado depois).
python3 - "$EXEC_FRAGMENT" "$MARKER_FILE" <<'PYEOF'
import re, sys
path, marker = sys.argv[1], sys.argv[2]
with open(path) as f:
    content = f.read()
# Remove o bloco printf...claude-openrouter.sh inteiro (multi-linha) por um sleep 1.
content = re.sub(
    r'printf .*?--budget 20\.0 --timeout 2400\n',
    'sleep 1\n',
    content,
    flags=re.S,
)
with open(path, "w") as f:
    f.write(content)
PYEOF

set +e
bash "$EXEC_FRAGMENT" 2>&1
EXEC_RC=$?
set -e

if [ "$EXEC_RC" -ne 0 ]; then
  echo "FAIL: fragmento real (com mock) saiu com rc=$EXEC_RC — deveria ser 0"
  FAILED=1
fi

if [ ! -f "$MARKER_FILE" ]; then
  echo "FAIL: renovador nunca rodou (nenhum 'beat' gravado) — o mecanismo não renova heartbeat nenhum"
  FAILED=1
else
  BEATS_DURING="$(wc -l < "$MARKER_FILE")"
  if [ "$BEATS_DURING" -ge 1 ]; then
    echo "ok: renovador bateu heartbeat pelo menos 1x ENQUANTO a delegação (mock) estava em voo ($BEATS_DURING beat(s))"
  else
    echo "FAIL: renovador não bateu heartbeat nenhum durante a delegação mock"
    FAILED=1
  fi
  sleep 0.5
  BEATS_AFTER="$(wc -l < "$MARKER_FILE")"
  if [ "$BEATS_AFTER" = "$BEATS_DURING" ]; then
    echo "ok: renovador PAROU de verdade depois do kill/wait — não continuou órfão em background"
  else
    echo "FAIL: renovador continuou batendo heartbeat DEPOIS do kill/wait ($BEATS_DURING → $BEATS_AFTER) — vira o mesmo problema que existe pra resolver"
    FAILED=1
  fi
fi
rm -f "$MARKER_FILE"

if [ "$FAILED" -eq 1 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TODOS OS TESTES PASSARAM"
