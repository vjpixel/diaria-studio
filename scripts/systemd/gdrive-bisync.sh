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
# Resync automático que falha fica pendente e a próxima rodada do timer o
# retoma, com teto (#12590).
#
# `--force` (o destrave do "too many deletes") roda antes uma pré-checagem
# `--dry-run` e recusa (exit 75, sem carimbo) se for apagar do Drive arquivo
# de outro dono; `--allow-foreign-deletes` libera (#12979).
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
FORCE=0
ALLOW_FOREIGN=0
# `--allow-foreign-deletes` é deste script (#12979), nunca do rclone: sai da
# lista de argumentos antes de qualquer chamada. O resto segue igual.
for a in "$@"; do
  shift
  case "$a" in
    --allow-foreign-deletes) ALLOW_FOREIGN=1; continue ;;
    --dry-run|-n) DRY_RUN=1 ;;
    --resync|-1|--resync-mode|--resync-mode=*) RESYNC=1 ;;
    --force|--force=true) FORCE=1 ;;
  esac
  set -- "$@" "$a"
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
bisync_cmd() {
  "$RCLONE_BIN" bisync "$REMOTE" "$LOCAL" \
    --check-access --check-filename "$SENTINEL" \
    --max-delete "$MAX_DELETE" \
    --filters-file "$FILTERS" --ignore-case \
    --drive-skip-gdocs --drive-skip-dangling-shortcuts \
    --create-empty-src-dirs \
    --resilient --recover --max-lock 15m \
    --conflict-resolve newer --conflict-loser num \
    --log-level NOTICE "$@"
}

run_bisync() {
  rm -f "$RCLONE_RC"
  {
    bisync_cmd "$@" 2>&1
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

# Guard do --force (#12979). O "too many deletes" do `--max-delete` é a
# única barreira contra uma pasta sumida do espelho virar exclusão em massa
# no Drive, e o `--force` é justamente o que a desliga. Na sessão de
# 12/11/2026 a pasta `Work/Mentoria Fluxo／VTSD/YouTube` saiu inteira do
# espelho, e um `--force` teria apagado do Drive 57 arquivos (29 GiB) de
# OUTRA conta, compartilhados com a vjpixel. Por isso, `--force` sem
# `--dry-run` roda antes a mesma rodada com `--dry-run`, lê as exclusões
# planejadas do lado do Drive (Path1: o remote é sempre o 1º argumento do
# bisync) e confere o dono de cada uma (`owner` do `lsjson -M`). A conta do
# remote é a dona da sentinela do Drive (criada por ela com `rclone touch`),
# ou `GDRIVE_ACCOUNT_OWNER` se vier no ambiente. Exclusão de arquivo de
# outro dono, ou de dono que não se lê, recusa a rodada (exit 75, sem
# carimbo: nada rodou) e lista os arquivos; só passa com
# `--allow-foreign-deletes`. Mais de GDRIVE_FORCE_OWNER_CHECK_MAX exclusões
# (default 200) no Drive recusa sem consultar dono por dono. Pré-checagem que
# falha também recusa: sem a lista, nada garante o que o --force apagaria.
ESC=$(printf '\033')
PRECHECK_LOG="$STATE_DIR/force-precheck.log"
DRIVE_DELETES="$STATE_DIR/force-precheck-drive-deletes.txt"
FOREIGN_DELETES="$STATE_DIR/force-precheck-foreign-deletes.txt"
OWNER_CHECK_MAX="${GDRIVE_FORCE_OWNER_CHECK_MAX:-200}"
case "$OWNER_CHECK_MAX" in ''|*[!0-9]*) OWNER_CHECK_MAX=200 ;; esac

# Dono (e-mail, minúsculo) de um caminho do remote; vazio se não se lê.
owner_of() {
  "$RCLONE_BIN" lsjson -M --stat "$1" 2>/dev/null |
    sed -n 's/.*"owner" *: *"\([^"]*\)".*/\1/p' | head -n 1 | tr 'A-Z' 'a-z'
}

refuse_force() {
  echo "gdrive-bisync: --force RECUSADO, nada foi aplicado (#12979): $1" >&2
  echo "gdrive-bisync: confira com --dry-run --force; se a pasta sumiu do espelho por engano, devolva os arquivos ao espelho (rclone copy) antes do --force; se apagar do Drive arquivos de outro dono for intencional, rode de novo com --allow-foreign-deletes" >&2
  exit 75
}

force_guard() {
  rm -f "$PRECHECK_LOG" "$DRIVE_DELETES" "$FOREIGN_DELETES"
  bisync_cmd "$@" --dry-run > "$PRECHECK_LOG" 2>&1
  prc=$?
  if [ "$prc" -ne 0 ]; then
    refuse_force "a pre-checagem (a mesma rodada com --dry-run) saiu $prc. Log: $PRECHECK_LOG"
  fi
  sed "s/${ESC}\[[0-9;]*m//g" "$PRECHECK_LOG" |
    grep -E 'Path1 +Queue delete +- ' |
    sed 's/.*Queue delete *- //' > "$DRIVE_DELETES"
  ndel=$(grep -c . "$DRIVE_DELETES")
  # Formato do log que mudou numa versão nova do rclone não pode virar "zero
  # exclusões" e liberar o --force: o dry-run diz quantas exclusões pulou, e
  # se houve alguma sem nenhuma linha "Queue delete" reconhecida, recusa.
  nskip=$(grep -c 'Skipped delete as --dry-run is set' "$PRECHECK_LOG")
  nqueue=$(sed "s/${ESC}\[[0-9;]*m//g" "$PRECHECK_LOG" | grep -c -E 'Path[12] +Queue delete +- ')
  if [ "$nskip" -gt 0 ] && [ "$nqueue" -eq 0 ]; then
    refuse_force "o dry-run pulou $nskip exclusao(oes), mas nenhuma linha 'Queue delete' foi reconhecida no log (formato do rclone mudou?). Log: $PRECHECK_LOG"
  fi
  if [ "$ndel" -eq 0 ]; then
    echo "gdrive-bisync: pre-checagem do --force: nenhuma exclusao no Drive (#12979)" >&2
    return 0
  fi
  echo "gdrive-bisync: pre-checagem do --force: $ndel exclusao(oes) no Drive planejada(s), lista em $DRIVE_DELETES (#12979)" >&2
  if [ "$ALLOW_FOREIGN" -eq 1 ]; then
    echo "gdrive-bisync: --allow-foreign-deletes: seguindo sem conferir o dono (#12979)" >&2
    return 0
  fi
  if [ "$ndel" -gt "$OWNER_CHECK_MAX" ]; then
    refuse_force "$ndel exclusoes no Drive, acima do teto de $OWNER_CHECK_MAX para conferir o dono uma a uma (GDRIVE_FORCE_OWNER_CHECK_MAX). Lista: $DRIVE_DELETES"
  fi
  account="${GDRIVE_ACCOUNT_OWNER:-}"
  if [ -z "$account" ]; then
    case "$REMOTE" in
      *:|*/) account=$(owner_of "$REMOTE$SENTINEL") ;;
      *) account=$(owner_of "$REMOTE/$SENTINEL") ;;
    esac
  fi
  account=$(printf '%s' "$account" | tr 'A-Z' 'a-z')
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    o=$(owner_of "$p")
    if [ -z "$account" ] || [ "$o" != "$account" ]; then
      printf '%s\t%s\n' "${o:-dono-ilegivel}" "$p" >> "$FOREIGN_DELETES"
    fi
  done < "$DRIVE_DELETES"
  if [ -s "$FOREIGN_DELETES" ]; then
    nfor=$(grep -c . "$FOREIGN_DELETES")
    echo "gdrive-bisync: exclusoes no Drive de arquivo de outro dono (dono, caminho), conta do remote: ${account:-ilegivel}:" >&2
    head -n 20 "$FOREIGN_DELETES" >&2
    [ "$nfor" -le 20 ] || echo "gdrive-bisync: ... e mais $((nfor - 20)); lista completa em $FOREIGN_DELETES" >&2
    refuse_force "$nfor de $ndel exclusoes no Drive sao de arquivo de outro dono ou de dono ilegivel"
  fi
  echo "gdrive-bisync: as $ndel exclusoes no Drive sao de arquivos da conta do remote ($account); seguindo (#12979)" >&2
}

if [ "$FORCE" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
  force_guard "$@"
fi

# Resync automático pendente (#12590). O resync automático do 401 (#12412)
# pode falhar ele mesmo (na rodada de 13/11/2026 a rede caiu no meio dele:
# 1.324 listagens com `dial tcp`). O rclone já descartou as listagens, e
# toda rodada seguinte do timer só reverte ao backup antigo, falha o check
# de sincronia e sai 7, sem nunca se recuperar: ficou ~5h travado até um
# resync manual. Por isso o resync automático que não sai 0 deixa o marcador
# `$STATE_DIR/resync-pending`, e a próxima rodada do timer (sem `--dry-run`,
# `--resync` ou `--force` na linha) roda ela mesma o resync, com as mesmas
# travas do #12412 (`--check-access`, filtro instalado, `--resync-mode
# newer`), até GDRIVE_PENDING_RESYNC_MAX tentativas (default 3; `0` desliga).
# Esgotadas, o marcador fica, a rodada segue normal (e falha) e o alarme
# continua aceso até o resync manual. Qualquer rodada que sai 0 apaga o
# marcador. O mesmo trade-off do #12444 vale aqui: resync une os dois lados
# e pode trazer de volta arquivo apagado.
PENDING_RESYNC="$STATE_DIR/resync-pending"
PENDING_MAX="${GDRIVE_PENDING_RESYNC_MAX:-3}"
case "$PENDING_MAX" in ''|*[!0-9]*) PENDING_MAX=3 ;; esac
PENDING_RUN=0
if [ -f "$PENDING_RESYNC" ] && [ "$DRY_RUN" -eq 0 ] && [ "$RESYNC" -eq 0 ] && [ "$FORCE" -eq 0 ]; then
  pending_n=$(sed -n 's/^attempts=\([0-9][0-9]*\)$/\1/p' "$PENDING_RESYNC" | head -n 1)
  [ -n "$pending_n" ] || pending_n=0
  if [ "$pending_n" -lt "$PENDING_MAX" ]; then
    pending_n=$((pending_n + 1))
    printf 'attempts=%s\n' "$pending_n" > "$PENDING_RESYNC"
    echo "gdrive-bisync: resync automatico pendente de rodada anterior que falhou — tentativa $pending_n/$PENDING_MAX (#12590)" >&2
    PENDING_RUN=1
  else
    echo "gdrive-bisync: resync automatico pendente esgotou $PENDING_MAX tentativas — rode --resync a mao, timer parado (#12590)" >&2
  fi
fi

if [ "$PENDING_RUN" -eq 1 ]; then
  run_bisync "$@" --resync --resync-mode newer
  echo "gdrive-bisync: resync automatico pendente terminou com exit $RC (#12590)" >&2
  echo "gdrive-bisync: aviso — o resync automatico une os dois lados e nao apaga nada: arquivo apagado em um lado durante a rodada pode ter voltado do outro (#12444)" >&2
else
  run_bisync "$@"
fi
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
# Marcador do resync pendente (#12590): some com qualquer rodada que sai 0;
# nasce quando o resync automático do 401 não terminou bem.
if [ "$DRY_RUN" -eq 0 ]; then
  if [ "$RC" -eq 0 ]; then
    rm -f "$PENDING_RESYNC"
  elif [ "$attempt" -gt 0 ] && [ ! -f "$PENDING_RESYNC" ]; then
    if printf 'attempts=0\n' > "$PENDING_RESYNC"; then
      echo "gdrive-bisync: resync automatico nao terminou bem; a proxima rodada do timer tenta de novo (#12590)" >&2
    else
      echo "gdrive-bisync: aviso — nao consegui gravar $PENDING_RESYNC; rode --resync a mao (#12590)" >&2
    fi
  fi
fi
finish "$RC"
