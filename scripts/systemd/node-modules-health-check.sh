#!/bin/sh
# node-modules-health-check.sh (#6030)
#
# Watchdog em SHELL PURO (sem node/tsx) para o modo de falha do incidente
# 260824: node_modules esvaziado → toda task systemd do checkout falha com
# ERR_MODULE_NOT_FOUND → e os PRÓPRIOS alarmes (todos tsx no mesmo checkout)
# morrem junto, ninguém é avisado.
#
# Este script não depende de nada dentro de node_modules:
#   - sh + coreutils + gh (CLI GitHub, pré-autenticado nesta máquina).
#   - Notificação = issue no GitHub (mesmo canal da rede de alarmes tsx,
#     mas por caminho independente).
#
# Checks:
#   1. node_modules/.bin/tsx existe no checkout.
#   2. Units diaria-*.service --user em estado failed (sweep barato, redundância
#      com Diaria-Systemd-Failed-Units-Alarm — que é tsx e morre na mesma causa).
#
# Dedupe/cooldown: arquivo de estado com timestamp do último alerta; sem alerta
# repetido antes de ALERT_COOLDOWN_SECS (default 4h). Se o gh falhar (rede),
# escreve fallback em ALERT_FALLBACK_FILE e sai 1 — tentará de novo no próximo
# tick do timer.
#
# Testável sem tocar produção: PATH_CHECK_DIR e FAILED_UNITS_CMD são
# sobrescrevíveis por env (usados nos testes ao vivo do próprio fix).

set -u

CHECKOUT="${DIARIA_CHECKOUT:-/home/vjpixel/diaria-studio}"
PATH_CHECK_DIR="${DIARIA_NODE_MODULES:-$CHECKOUT/node_modules}"
TSX_BIN="$PATH_CHECK_DIR/.bin/tsx"
FAILED_UNITS_CMD="${DIARIA_FAILED_UNITS_CMD:-systemctl --user list-units 'diaria-*.service' --state=failed --plain --no-legend}"
STATE_FILE="${DIARIA_HEALTH_STATE:-$HOME/.cache/diaria/node-modules-health.state}"
FALLBACK_FILE="${DIARIA_HEALTH_FALLBACK:-$HOME/.cache/diaria/node-modules-health.ALERT}"
ALERT_COOLDOWN_SECS="${DIARIA_ALERT_COOLDOWN_SECS:-14400}"
ALERT_LABELS="bug,P1,alarm"

mkdir -p "$(dirname "$STATE_FILE")"

problems=""

# --- Check 1: tsx presente -------------------------------------------------
if [ ! -x "$TSX_BIN" ]; then
    problems="$problems
- \`$TSX_BIN\` ausente ou não-executável — tasks systemd do checkout falham com ERR_MODULE_NOT_FOUND (modo do incidente #6030)."
fi

# --- Check 2: units diaria-* failed ----------------------------------------
failed_units=$(eval "$FAILED_UNITS_CMD" 2>/dev/null | tr -d '●' | awk '{for(i=1;i<=NF;i++) if ($i ~ /\.service$/) print $i}' | sort -u)
if [ -n "$failed_units" ]; then
    indented=$(echo "$failed_units" | sed 's/^/- `/; s/$/`/')
    problems="$problems
Units diaria-*.service --user em estado failed:
$indented"
fi

if [ -z "$problems" ]; then
    # Saudável: limpa estado de alerta anterior e fallback pendente.
    rm -f "$STATE_FILE" "$FALLBACK_FILE"
    exit 0
fi

# --- Debounce ----------------------------------------------------------------
now=$(date +%s)
last=0
[ -f "$STATE_FILE" ] && last=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
delta=$((now - last))
if [ "$last" != "0" ] && [ "$delta" -lt "$ALERT_COOLDOWN_SECS" ]; then
    # Em cooldown e ainda doente: mantém fallback em disco como evidência.
    exit 0
fi

host=$(hostname)
date_str=$(date -u +"%Y-%m-%d %H:%M UTC")
body="# ⚠️ node-modules health-check (shell puro, #6030)

**Host:** $host
**Quando:** $date_str

Detecções:$problems

_Alarme gerado por \`scripts/systemd/node-modules-health-check.sh\` — caminho INDEPENDENTE de node/tsx (a rede tsx de alarmes morre junto com o checkout, achado estrutural do #6030). Cooldown ${ALERT_COOLDOWN_SECS}s; reabre/recomenta se persistir._"

title="[diar.ia.br] node-modules health-check: checkout não-executável ou units failed"
marker="node-modules health-check"

# Dedupe: se já existe issue aberta deste alarme, comenta nela em vez de criar outra.
existing=$(gh issue list --state open --search "$marker in:title" --json number --jq '.[0].number' 2>/dev/null)

if [ -n "$existing" ] && [ "$existing" != "null" ]; then
    if printf '%s\n' "$body" | gh issue comment "$existing" --body-file - >/dev/null 2>&1; then
        echo "$now" > "$STATE_FILE"
        rm -f "$FALLBACK_FILE"
        exit 0
    fi
else
    created=$(printf '%s\n' "$body" | gh issue create --title "$title" --body-file - --label "$ALERT_LABELS" 2>/dev/null)
    if [ -n "$created" ]; then
        echo "$now" > "$STATE_FILE"
        rm -f "$FALLBACK_FILE"
        logger -t diaria-health-check "alerta entregue: $created"
        exit 0
    fi
fi

# gh falhou (rede/auth?): registra fallback em disco e sinaliza erro.
printf '%s\n' "$body" > "$FALLBACK_FILE"
logger -t diaria-health-check "ERRO: problema detectado mas entrega via gh falhou; evidência em $FALLBACK_FILE"
exit 1
