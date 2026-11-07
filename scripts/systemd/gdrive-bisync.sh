#!/bin/sh
# gdrive-bisync.sh (#12356, épica #12353)
#
# Sincroniza o Google Drive inteiro (remote rclone `gdrive:`) com
# /mnt/hd-sata/GoogleDrive no `300`, por `rclone bisync` (decisão do editor
# em #12354). Roda a cada 2 min pela unit diaria-gdrive-bisync.timer.
#
# Trava contra pasta vazia (o risco nº 1 da épica): se o HD estiver
# desmontado, o diretório local some ou fica vazio, e um sync ingênuo lê
# "tudo apagado" e propaga a deleção pra nuvem e pras outras máquinas.
# Três camadas, cada uma suficiente sozinha:
#   1. `mountpoint -q` no ponto de montagem (e RequiresMountsFor= na unit);
#   2. arquivo-sentinela dos dois lados (`--check-access`), que o rclone
#      exige antes de qualquer mudança;
#   3. `--max-delete` baixo (percentual), que aborta deleção em massa.
#
# Exit 75 (EX_TEMPFAIL) = pré-condição ausente (HD/sentinela): a unit fica
# `failed` e o Diaria-Systemd-Failed-Units-Alarm acusa — nunca sai 0 calado.
#
# Testável sem tocar produção: GDRIVE_* e RCLONE_BIN sobrescrevíveis por env.

set -u

MOUNT="${GDRIVE_MOUNT:-/mnt/hd-sata}"
LOCAL="${GDRIVE_LOCAL:-$MOUNT/GoogleDrive}"
REMOTE="${GDRIVE_REMOTE:-gdrive:}"
SENTINEL="${GDRIVE_SENTINEL:-.diaria-bisync-sentinel}"
FILTERS="${GDRIVE_FILTERS:-$(dirname "$0")/gdrive-bisync-filters.txt}"
MAX_DELETE="${GDRIVE_MAX_DELETE:-5}"
RCLONE_BIN="${RCLONE_BIN:-$HOME/.local/bin/rclone}"
MOUNTPOINT_CMD="${GDRIVE_MOUNTPOINT_CMD:-mountpoint -q}"

if ! $MOUNTPOINT_CMD "$MOUNT"; then
  echo "gdrive-bisync: $MOUNT nao esta montado — sync abortado (#12356)" >&2
  exit 75
fi
if [ ! -f "$LOCAL/$SENTINEL" ]; then
  echo "gdrive-bisync: sentinela $LOCAL/$SENTINEL ausente — sync abortado (#12356)" >&2
  exit 75
fi
if [ ! -f "$FILTERS" ]; then
  echo "gdrive-bisync: arquivo de filtros $FILTERS ausente" >&2
  exit 75
fi

exec "$RCLONE_BIN" bisync "$REMOTE" "$LOCAL" \
  --check-access --check-filename "$SENTINEL" \
  --max-delete "$MAX_DELETE" \
  --filters-file "$FILTERS" \
  --drive-skip-gdocs --drive-skip-dangling-shortcuts \
  --create-empty-src-dirs \
  --resilient --recover --max-lock 15m \
  --conflict-resolve newer --conflict-loser num \
  --log-level NOTICE "$@"
