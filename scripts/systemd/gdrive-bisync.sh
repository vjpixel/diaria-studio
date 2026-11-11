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
# Exit 7 por 401/authError (token OAuth vencendo no meio de uma listagem
# longa) ganha um resync automático (#12412), que pode ressuscitar arquivo
# apagado durante a rodada (#12444) — ver o bloco antes da chamada do rclone.
#
# O bisync DEDICADO de data/ (#12478) roda este mesmo script pelo wrapper
# `gdrive-data-bisync.sh`, que troca remote, pasta local, filtro, state dir e
# workdir do rclone por env. Sem esse env (a unit diaria-gdrive-bisync), a
# invocação do rclone é a mesma de antes da #12478: o `--workdir` só entra
# na linha de comando quando GDRIVE_WORKDIR vem preenchido
# (test/gdrive-data-bisync-12478.test.ts trava a linha inteira).
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
# Workdir do rclone bisync (listagens + lock), opcional (#12478). Vazio = o
# default do rclone (~/.cache/rclone/bisync), sem `--workdir` na linha.
WORKDIR="${GDRIVE_WORKDIR:-}"

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

# Retry em erro de autenticação (#12412). Quando a listagem do Drive passa
# de 1h, o access token OAuth vence no meio dela e algumas listagens
# concorrentes levam `Error 401: Invalid Credentials, authError` antes de o
# rclone renovar o token. O bisync aborta com exit 7 ("Must run --resync to
# recover") e, sem isto, o sync ficava parado até alguém rodar o resync à mão.
# Regra: SÓ exit 7 com `Error 401`/`authError` no log da tentativa dispara um
# resync automático, até GDRIVE_AUTH_RETRY_MAX vezes (default 1), depois de
# GDRIVE_AUTH_RETRY_DELAY segundos (default 60). Qualquer outro exit, ou exit 7
# sem erro de autenticação (too many deletes, filtro mudado, sentinela), segue
# como antes: sai com o exit do rclone, sem retry. O resync automático mantém
# o `--check-access` e usa o filtro INSTALADO (nunca adota o do checkout,
# #12396), com `--resync-mode newer` para não sobrescrever um arquivo local
# mais novo com a versão do Drive. O `--max-delete` segue na linha de comando,
# mas não protege nada aqui: resync não apaga, só une os dois lados (#12444).
# O risco do resync é o inverso: ele descarta as listagens anteriores, e um
# arquivo apagado de um lado durante a rodada longa volta copiado do outro,
# com exit 0 (o `--resync-mode newer` só decide arquivo presente nos dois
# lados). Por isso cada resync automático termina com um aviso no stderr.
# `--dry-run` nunca retenta.
AUTH_RETRY_MAX="${GDRIVE_AUTH_RETRY_MAX:-1}"
AUTH_RETRY_DELAY="${GDRIVE_AUTH_RETRY_DELAY:-60}"
# Valor não numérico no env cai no default: um `[ -ge ]` com lixo daria erro
# (falso) e o teto deixaria de valer.
case "$AUTH_RETRY_MAX" in ''|*[!0-9]*) AUTH_RETRY_MAX=1 ;; esac
case "$AUTH_RETRY_DELAY" in ''|*[!0-9]*) AUTH_RETRY_DELAY=60 ;; esac
RCLONE_LOG="$STATE_DIR/last-rclone.log"
RCLONE_RC="$STATE_DIR/last-rclone.rc"

# Roda o bisync com as travas fixas + "$@", espelhando a saída no journal e
# em $RCLONE_LOG (lido pelo detector de 401). O exit do rclone volta em
# $RC; sem arquivo de exit legível, RC=1 (nunca 0 por falha de leitura).
run_bisync() {
  rm -f "$RCLONE_RC"
  {
    "$RCLONE_BIN" bisync "$REMOTE" "$LOCAL" \
      --check-access --check-filename "$SENTINEL" \
      --max-delete "$MAX_DELETE" \
      --filters-file "$FILTERS" --ignore-case \
      --drive-skip-gdocs --drive-skip-dangling-shortcuts \
      --create-empty-src-dirs \
      --resilient --recover --max-lock 15m \
      --conflict-resolve newer --conflict-loser num \
      --log-level NOTICE "$@" 2>&1
    echo $? > "$RCLONE_RC"
  } | tee "$RCLONE_LOG"
  RC=$(cat "$RCLONE_RC" 2>/dev/null)
  case "$RC" in
    ''|*[!0-9]*) RC=1 ;;
  esac
}

auth_error_in_log() {
  grep -E -q 'Error 401|authError' "$RCLONE_LOG" 2>/dev/null
}

# `--workdir` entra antes dos argumentos do chamador, e o retry de 401
# abaixo o herda pelo "$@".
if [ -n "$WORKDIR" ]; then
  set -- --workdir "$WORKDIR" "$@"
fi

run_bisync "$@"
attempt=0
while [ "$RC" -eq 7 ] && [ "$DRY_RUN" -eq 0 ] && auth_error_in_log; do
  if [ "$attempt" -ge "$AUTH_RETRY_MAX" ]; then
    echo "gdrive-bisync: rclone saiu 7 com erro de autenticacao (401/authError) e os $AUTH_RETRY_MAX resync(s) automatico(s) se esgotaram — rode --resync a mao (#12412)" >&2
    break
  fi
  attempt=$((attempt + 1))
  echo "gdrive-bisync: rclone saiu 7 com erro de autenticacao (401/authError) no log — resync automatico $attempt/$AUTH_RETRY_MAX em ${AUTH_RETRY_DELAY}s (#12412)" >&2
  sleep "$AUTH_RETRY_DELAY"
  if [ "$RESYNC" -eq 1 ]; then
    run_bisync "$@"
  else
    run_bisync "$@" --resync --resync-mode newer
  fi
  echo "gdrive-bisync: resync automatico $attempt/$AUTH_RETRY_MAX terminou com exit $RC (#12412)" >&2
  echo "gdrive-bisync: aviso — o resync automatico une os dois lados e nao apaga nada: arquivo apagado em um lado durante a rodada pode ter voltado do outro (#12444)" >&2
done
finish "$RC"
