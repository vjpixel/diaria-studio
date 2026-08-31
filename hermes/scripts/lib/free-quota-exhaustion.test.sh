#!/usr/bin/env bash
# Teste de regressão pro #6712 — miolo puro do marcador de exaustão da cota
# free-models-per-day.
#
# Uso: bash hermes/scripts/lib/free-quota-exhaustion.test.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./free-quota-exhaustion.sh
source "$DIR/free-quota-exhaustion.sh"

FAILED=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $desc — esperado [$expected], obtido [$actual]"
    FAILED=1
  else
    echo "ok: $desc"
  fi
}

# ── next_utc_midnight_epoch ──────────────────────────────────────────────

# 2026-08-29T06:48:00Z = 1787119680 (medido no corpo da issue #6712, o 429
# real aconteceu por volta desse horário). Próximo 00:00 UTC é
# 2026-08-30T00:00:00Z = 1787097600 + 86400... calculado abaixo via date,
# não hardcoded, pra não depender de aritmética manual de epoch errada.
EPOCH_2026_08_29_0648=$(date -u -d '2026-08-29T06:48:00Z' +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' '2026-08-29T06:48:00Z' +%s)
EPOCH_2026_08_30_MIDNIGHT=$(date -u -d '2026-08-30T00:00:00Z' +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' '2026-08-30T00:00:00Z' +%s)
assert_eq "next_utc_midnight_epoch de 06:48 UTC é meia-noite UTC do dia seguinte" \
  "$EPOCH_2026_08_30_MIDNIGHT" "$(next_utc_midnight_epoch "$EPOCH_2026_08_29_0648")"

# Exatamente à meia-noite: o "próximo" reset é a meia-noite SEGUINTE (24h à
# frente), não a mesma — "next" é estritamente no futuro.
EPOCH_2026_08_31_MIDNIGHT=$(date -u -d '2026-08-31T00:00:00Z' +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' '2026-08-31T00:00:00Z' +%s)
assert_eq "next_utc_midnight_epoch exatamente à meia-noite avança pro dia seguinte" \
  "$EPOCH_2026_08_31_MIDNIGHT" "$(next_utc_midnight_epoch "$EPOCH_2026_08_30_MIDNIGHT")"

# 1 segundo antes da meia-noite: o próximo reset é a meia-noite IMEDIATA.
EPOCH_1S_BEFORE=$((EPOCH_2026_08_30_MIDNIGHT - 1))
assert_eq "next_utc_midnight_epoch a 1s da meia-noite ainda aponta pra ela" \
  "$EPOCH_2026_08_30_MIDNIGHT" "$(next_utc_midnight_epoch "$EPOCH_1S_BEFORE")"

# ── is_exhaustion_marker_valid ───────────────────────────────────────────

assert_eq "marcador com reset no FUTURO é válido (ainda protege)" \
  "true" "$(is_exhaustion_marker_valid "$EPOCH_2026_08_30_MIDNIGHT" "$EPOCH_2026_08_29_0648")"

assert_eq "marcador com reset no PASSADO é inválido (já resetou, não protege mais)" \
  "false" "$(is_exhaustion_marker_valid "$EPOCH_2026_08_29_0648" "$EPOCH_2026_08_30_MIDNIGHT")"

assert_eq "marcador com reset EXATAMENTE agora é inválido (fronteira: now < marker, não <=)" \
  "false" "$(is_exhaustion_marker_valid "$EPOCH_2026_08_30_MIDNIGHT" "$EPOCH_2026_08_30_MIDNIGHT")"

# ── filter_out_free_models ───────────────────────────────────────────────

FILTERED=$(filter_out_free_models "dots-studio/dots-3-note-preview:free" "poolside/laguna-s-2.1:free" "z-ai/glm-5.3-flash")
assert_eq "filter_out_free_models remove os 2 elos :free, mantém só o pago" \
  "z-ai/glm-5.3-flash" "$FILTERED"

FILTERED_MULTI_PAID=$(filter_out_free_models "a:free" "b-pago" "c:free" "d-pago")
EXPECTED_MULTI_PAID=$'b-pago\nd-pago'
assert_eq "filter_out_free_models preserva ORDEM e mantém múltiplos elos pagos" \
  "$EXPECTED_MULTI_PAID" "$FILTERED_MULTI_PAID"

FILTERED_ALL_FREE=$(filter_out_free_models "a:free" "b:free")
assert_eq "filter_out_free_models com TODOS os elos :free produz saída vazia (caller decide o fallback)" \
  "" "$FILTERED_ALL_FREE"

FILTERED_NONE_FREE=$(filter_out_free_models "a-pago" "b-pago")
EXPECTED_NONE_FREE=$'a-pago\nb-pago'
assert_eq "filter_out_free_models sem nenhum elo :free preserva a lista inteira" \
  "$EXPECTED_NONE_FREE" "$FILTERED_NONE_FREE"

if [ "$FAILED" -ne 0 ]; then
  echo "FALHOU"
  exit 1
fi
echo "OK — todos os asserts passaram"
