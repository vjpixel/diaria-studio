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
# Filtro INSTALADO (#12396): o bisync roda sempre com a cópia em
# `$STATE_DIR/filters.txt`, nunca com o arquivo do checkout. Ele grava o MD5
# dos filtros em `{arquivo}.md5` ao lado dele e recusa toda rodada cujo filtro
# mudou até alguém rodar `--resync`. Por isso a cópia só é (re)instalada numa
# rodada `--resync` real (ou quando ainda não existe): uma troca de branch no
# checkout compartilhado do `300`, um `--dry-run` manual ou o merge de uma PR
# que mexa em `DATA_LOCAL_ONLY_PATTERNS` não trocam mais o filtro embaixo do
# sync. Fora do `--resync`, filtro do checkout diferente do instalado vira só
# aviso no log, e a rodada segue com o instalado.
STATE_DIR="${GDRIVE_STATE_DIR:-$HOME/.cache/diaria/gdrive-bisync}"
FILTERS="$STATE_DIR/filters.txt"
MAX_DELETE="${GDRIVE_MAX_DELETE:-5}"
RCLONE_BIN="${RCLONE_BIN:-$HOME/.local/bin/rclone}"
MOUNTPOINT_CMD="${GDRIVE_MOUNTPOINT_CMD:-mountpoint -q}"

DRY_RUN=0
RESYNC=0
for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRY_RUN=1 ;;
    --resync|-1|--resync-mode|--resync-mode=*) RESYNC=1 ;;
  esac
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
if ! mkdir -p "$STATE_DIR"; then
  echo "gdrive-bisync: nao consegui criar $STATE_DIR — sync abortado (#12396)" >&2
  finish 75
fi

# Copia o filtro do checkout pra $1, conferindo o retorno: um `cp` que falha
# (disco cheio, permissão) nunca deixa a rodada seguir com outro filtro.
install_filters() {
  if ! cp "$FILTERS_SRC" "$1.tmp" || ! mv "$1.tmp" "$1"; then
    echo "gdrive-bisync: falha ao instalar o filtro em $1 — sync abortado (#12396)" >&2
    finish 75
  fi
}

if [ ! -f "$FILTERS" ]; then
  # 1ª rodada nesta máquina: não há filtro instalado a preservar. Sem
  # `--resync` o bisync recusa mesmo assim (não há listagem nem `.md5`).
  if [ "$DRY_RUN" -eq 1 ]; then
    FILTERS="$STATE_DIR/filters.dry-run.txt"
  fi
  install_filters "$FILTERS"
elif ! cmp -s "$FILTERS_SRC" "$FILTERS"; then
  if [ "$RESYNC" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
    echo "gdrive-bisync: --resync instala o filtro de $FILTERS_SRC (#12396)" >&2
    install_filters "$FILTERS"
  elif [ "$RESYNC" -eq 1 ]; then
    # `--resync --dry-run`: pré-visualiza com o filtro novo numa cópia à
    # parte, sem tocar o instalado (que o timer segue usando).
    FILTERS="$STATE_DIR/filters.dry-run.txt"
    install_filters "$FILTERS"
  else
    echo "gdrive-bisync: aviso — $FILTERS_SRC difere do filtro instalado ($FILTERS); seguindo com o instalado. Pra adotar o novo, rode uma vez com --resync, timer parado (#12396)" >&2
  fi
fi

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
