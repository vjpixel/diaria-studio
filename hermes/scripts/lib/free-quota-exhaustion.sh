#!/usr/bin/env bash
# free-quota-exhaustion.sh (#6712)
#
# Miolo PURO (sem I/O real, `source`ável de teste) do marcador de exaustão
# da cota `free-models-per-day` do OpenRouter, usado por
# `claude-openrouter.sh`.
#
# ## O problema que isto fecha (#6712, achado ao vivo 29/08/2026)
#
# O limite `free-models-per-day` é POR CONTA, não por modelo — quando estoura,
# TODOS os elos `:free` da cadeia (`MODELS_DEFAULT`) falham igualmente, e o
# wrapper hoje tenta os 2 elos free em TODA invocação antes de cair no pago,
# mesmo sabendo (de uma invocação anterior, minutos atrás, no MESMO
# processo cron) que o pool está seco. Medido: ~70 invocações/tick × 2
# tentativas free desperdiçadas = ~140 requisições jogadas fora POR TICK,
# depois do 1º 429 do dia — nada além de reconfirmar o óbvio.
#
# ## O mecanismo
#
# Na 1ª vez que uma invocação detecta `SAW_QUOTA_SIGNAL=1` num elo `:free`,
# grava um marcador com o timestamp do PRÓXIMO reset diário (00:00 UTC,
# mesmo horário que `~/.hermes` usa pra `last_error_reset_at`, confirmado no
# corpo da issue #6712). Invocações SEGUINTES, antes de montar a cadeia,
# checam o marcador: se ainda válido (reset no futuro), FILTRAM os elos
# `:free` de `MODELS_DEFAULT` e vão direto pro(s) elo(s) pago(s) — sem gastar
# nenhuma requisição free sabendo que vai falhar.
#
# Fail-soft por design: marcador ausente, corrompido, ou no passado ⇒ chain
# INTEIRA (comportamento de hoje) — nunca fica preso "achando" que a cota
# está exaurida pra sempre por erro de leitura. Só o CAMINHO POSITIVO
# (marcador presente E válido) muda o comportamento.
set -euo pipefail

# next_utc_midnight_epoch NOW_EPOCH
#
# Epoch (segundos) do PRÓXIMO 00:00 UTC estritamente depois de NOW_EPOCH.
# Pura — só aritmética sobre o epoch recebido, nunca lê o relógio real
# (chamador passa `$(date -u +%s)`; testável sem depender de `date` real).
next_utc_midnight_epoch() {
  local now_epoch="$1"
  local secs_into_day=$((now_epoch % 86400))
  echo $((now_epoch - secs_into_day + 86400))
}

# is_exhaustion_marker_valid MARKER_EPOCH NOW_EPOCH
#
# "true"/"false" (stdout) — o marcador (que guarda o epoch do reset previsto)
# ainda protege contra tentar free? Válido enquanto NOW < MARKER_EPOCH.
# Pura.
is_exhaustion_marker_valid() {
  local marker_epoch="$1"
  local now_epoch="$2"
  if [ "$now_epoch" -lt "$marker_epoch" ]; then
    echo "true"
  else
    echo "false"
  fi
}

# filter_out_free_models MODEL...
#
# Imprime (1 por linha) os elementos de MODELS que NÃO terminam em `:free`.
# Pura. Se TODOS os elos forem `:free` (cadeia mal configurada, sem elo
# pago), a lista de saída fica vazia — o caller trata isso como "não filtrar
# nada" (fail-soft: preferir tentar o free mesmo achando que está exausto a
# ficar sem NENHUM modelo pra tentar).
filter_out_free_models() {
  local out=()
  for m in "$@"; do
    case "$m" in
      *:free) continue ;;
      *) out+=("$m") ;;
    esac
  done
  # #6712 review (P2): `printf '%s\n' "${out[@]}"` sobre um array VAZIO
  # imprime uma linha vazia, não zero linhas — `mapfile -t` do caller lia
  # isso como `PAID_ONLY=("")` (count 1, não 0), contornando o fallback
  # fail-soft documentado acima e corrompendo MODELS pra um elo vazio.
  # Guard explícito: array vazio não passa pelo printf.
  if [ "${#out[@]}" -gt 0 ]; then
    printf '%s\n' "${out[@]}"
  fi
}
