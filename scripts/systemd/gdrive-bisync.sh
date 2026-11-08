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
# Três camadas no script, cada uma suficiente sozinha (o RequiresMountsFor=
# da unit de USUÁRIO só ordena, não impede — o user manager não vê a mount
# unit do fstab):
#   1. `mountpoint -q` no ponto de montagem;
#   2. arquivo-sentinela dos dois lados (`--check-access`), que o rclone
#      exige antes de qualquer mudança;
#   3. `--max-delete` baixo (percentual), que aborta deleção em massa.
#
# Exit 75 (EX_TEMPFAIL) = pré-condição ausente (HD/sentinela/filtros): a unit
# fica `failed` e o Diaria-Systemd-Failed-Units-Alarm acusa — nunca sai 0
# calado.
#
# Carimbos pro alarme (#12357, `scripts/gdrive-sync-alarm.ts`): toda rodada
# grava `$STATE_DIR/last-run.json` (`{"at": ISO, "exit": N}`), e a rodada que
# sai 0 grava também `$STATE_DIR/last-success.json`. Rodada com `--dry-run`
# não carimba NADA, nem `last-run.json`: um teste manual não é a rodada do
# timer, e um dry-run que saísse 75 ou de erro deixaria o alarme achando que
# o sync está travado/falhando. O exit code do rclone é o do script, sem
# mudança.
#
# Testável sem tocar produção: GDRIVE_* e RCLONE_BIN sobrescrevíveis por env.

set -u

MOUNT="${GDRIVE_MOUNT:-/mnt/hd-sata}"
LOCAL="${GDRIVE_LOCAL:-$MOUNT/GoogleDrive}"
REMOTE="${GDRIVE_REMOTE:-gdrive:}"
SENTINEL="${GDRIVE_SENTINEL:-.diaria-bisync-sentinel}"
FILTERS_SRC="${GDRIVE_FILTERS:-$(dirname "$0")/gdrive-bisync-filters.txt}"
# O bisync grava o MD5 dos filtros em `{arquivo}.md5` ao lado dele. Copiar
# pra fora do checkout compartilhado evita o `.md5` untracked no repo e que
# um checkout de outra branch troque os filtros embaixo do sync.
STATE_DIR="${GDRIVE_STATE_DIR:-$HOME/.cache/diaria/gdrive-bisync}"
FILTERS="$STATE_DIR/filters.txt"
MAX_DELETE="${GDRIVE_MAX_DELETE:-5}"
RCLONE_BIN="${RCLONE_BIN:-$HOME/.local/bin/rclone}"
MOUNTPOINT_CMD="${GDRIVE_MOUNTPOINT_CMD:-mountpoint -q}"

DRY_RUN=0
for a in "$@"; do
  case "$a" in --dry-run|-n) DRY_RUN=1 ;; esac
done

# Grava um carimbo de forma atômica (tmp + mv). Falha de escrita só avisa:
# o carimbo é sinal pro alarme, nunca motivo pra mudar o exit do sync.
stamp() {
  if mkdir -p "$STATE_DIR" 2>/dev/null &&
    printf '{"at":"%s","exit":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" > "$STATE_DIR/$1.tmp" &&
    mv "$STATE_DIR/$1.tmp" "$STATE_DIR/$1"; then
    :
  else
    echo "gdrive-bisync: aviso — nao consegui gravar $STATE_DIR/$1" >&2
  fi
}

# Encerra carimbando a rodada (e o sucesso, se for o caso). `--dry-run`
# nunca carimba.
finish() {
  if [ "$DRY_RUN" -eq 0 ]; then
    stamp last-run.json "$1"
    if [ "$1" -eq 0 ]; then stamp last-success.json 0; fi
  fi
  exit "$1"
}

if ! $MOUNTPOINT_CMD "$MOUNT"; then
  echo "gdrive-bisync: $MOUNT nao esta montado — sync abortado (#12356)" >&2
  finish 75
fi
if [ ! -f "$LOCAL/$SENTINEL" ]; then
  echo "gdrive-bisync: sentinela $LOCAL/$SENTINEL ausente — sync abortado (#12356)" >&2
  finish 75
fi
if [ ! -f "$FILTERS_SRC" ]; then
  echo "gdrive-bisync: arquivo de filtros $FILTERS_SRC ausente" >&2
  finish 75
fi
mkdir -p "$STATE_DIR"
if ! cmp -s "$FILTERS_SRC" "$FILTERS"; then cp "$FILTERS_SRC" "$FILTERS"; fi

"$RCLONE_BIN" bisync "$REMOTE" "$LOCAL" \
  --check-access --check-filename "$SENTINEL" \
  --max-delete "$MAX_DELETE" \
  --filters-file "$FILTERS" --ignore-case \
  --drive-skip-gdocs --drive-skip-dangling-shortcuts \
  --create-empty-src-dirs \
  --resilient --recover --max-lock 15m \
  --conflict-resolve newer --conflict-loser num \
  --log-level NOTICE "$@"
finish $?
