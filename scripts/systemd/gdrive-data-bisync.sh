#!/bin/sh
# gdrive-data-bisync.sh (#12478, épica #12353)
#
# Bisync DEDICADO de data/ no `300`: só a pasta do projeto no Google Drive,
# a cada 1 min (unit diaria-gdrive-data-bisync.timer). O bisync do Drive
# inteiro (gdrive-bisync.sh, #12356) leva ~34 min por rodada e deixaria o
# data/ do `300` até ~70 min atrás do Neo depois do cutover (#12359).
#
# Não duplica a lógica: chama o próprio gdrive-bisync.sh (trava de disco
# desmontado, sentinela/--check-access, --max-delete, retry de 401 do
# #12412, filtro instalado só no --resync do #12396, carimbos
# last-run/last-success), trocando por env só o que é desta instância:
#
#   GDRIVE_DATA_REMOTE     remote:pasta       default gdrive-diaria:diaria-studio-data
#   GDRIVE_DATA_LOCAL      pasta local        default /mnt/hd-sata/GoogleDrive-diaria/diaria-studio-data
#   GDRIVE_DATA_MOUNT      ponto de montagem  default /mnt/hd-sata
#   GDRIVE_DATA_FILTERS    filtro do checkout default gdrive-data-bisync-filters.txt (ao lado deste script)
#   GDRIVE_DATA_STATE_DIR  state dir          default ~/.cache/diaria/gdrive-data-bisync
#   GDRIVE_DATA_WORKDIR    workdir do rclone  default {state dir}/rclone-workdir (listagens + lock)
#   GDRIVE_DATA_MAX_DELETE --max-delete (%)   default o do gdrive-bisync.sh (5)
#
# Os defaults são o destino real (conta diaria.editor, remote
# `gdrive-diaria` já criado no `300`, #12575): a pasta local fica FORA do
# espelho do Drive da vjpixel (/mnt/hd-sata/GoogleDrive), que o bisync grande
# sincroniza. Qualquer ajuste vai no arquivo
#
#   ~/.config/diaria/gdrive-data-bisync.env   (ou GDRIVE_DATA_ENV_FILE)
#
# uma linha CHAVE=valor por variável acima, sem aspas; `#` comenta. O arquivo
# é LIDO, nunca executado como shell (`. arquivo`): só as chaves da lista
# valem, as outras viram aviso. A unit e uma rodada manual leem o mesmo
# arquivo, e o alarme (scripts/gdrive-sync-alarm.ts) também, com o mesmo
# parser (scripts/lib/gdrive-data-bisync-config.ts). Variável já presente no
# ambiente vence o arquivo.
#
# Trava de sobreposição (exit 78, EX_CONFIG): se a pasta local configurada
# for a raiz do espelho do Drive inteiro, estiver dentro dela ou a contiver,
# o wrapper aborta antes de chamar o rclone — os dois bisyncs nunca rodam
# sobre a mesma árvore. A comparação é por componente de caminho
# (/mnt/hd-sata/GoogleDrive-diaria NÃO está dentro de /mnt/hd-sata/GoogleDrive).
# Raiz do espelho: /mnt/hd-sata/GoogleDrive (o default do gdrive-bisync.sh,
# que a unit diaria-gdrive-bisync usa sem Environment=), mais o GDRIVE_LOCAL
# que vier no ambiente de uma rodada manual. GDRIVE_DATA_FULL_DRIVE_LOCAL
# troca a raiz fixa (só para teste).
#
# Isolamento do ambiente: TODAS as GDRIVE_* do bisync grande que chegarem
# pelo ambiente são sobrescritas ou removidas aqui — um `GDRIVE_STATE_DIR`,
# `GDRIVE_SENTINEL` ou `GDRIVE_AUTH_RETRY_*` exportado no shell para o bisync
# grande nunca vale para o de data/. A sentinela é sempre
# `.diaria-bisync-sentinel`; retry de 401 e mountpoint só mudam por
# GDRIVE_DATA_AUTH_RETRY_MAX / GDRIVE_DATA_AUTH_RETRY_DELAY /
# GDRIVE_DATA_MOUNTPOINT_CMD (só ambiente, para teste). RCLONE_BIN continua
# herdável: é o mesmo binário nos dois bisyncs (default ~/.local/bin/rclone).
#
# Uso manual (no `300`, timer parado para --resync/--force):
#   sh scripts/systemd/gdrive-data-bisync.sh --resync
#   sh scripts/systemd/gdrive-data-bisync.sh --dry-run

set -u

DIR="$(dirname "$0")"
ENV_FILE="${GDRIVE_DATA_ENV_FILE:-$HOME/.config/diaria/gdrive-data-bisync.env}"

# Lê CHAVE=valor do arquivo de env sem avaliar nada. Só define a variável se
# ela não veio do ambiente (o ambiente vence).
if [ -f "$ENV_FILE" ]; then
  CR="$(printf '\r')"
  while IFS= read -r line || [ -n "$line" ]; do
    # Arquivo salvo com CRLF: o \r iria colado no valor (remote inválido).
    case "$line" in
      *"$CR") line="${line%?}" ;;
    esac
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    if [ "$key" = "$line" ]; then
      echo "gdrive-data-bisync: aviso — linha sem '=' ignorada em $ENV_FILE" >&2
      continue
    fi
    case "$key" in
      GDRIVE_DATA_REMOTE|GDRIVE_DATA_LOCAL|GDRIVE_DATA_MOUNT|GDRIVE_DATA_FILTERS|GDRIVE_DATA_STATE_DIR|GDRIVE_DATA_WORKDIR|GDRIVE_DATA_MAX_DELETE)
        eval "already=\${$key+x}"
        if [ -z "$already" ]; then
          # `export` com o valor numa variável: nunca expande o conteúdo.
          export "$key=$val"
        fi
        ;;
      *)
        echo "gdrive-data-bisync: aviso — chave desconhecida $key ignorada em $ENV_FILE (#12478)" >&2
        ;;
    esac
  done < "$ENV_FILE"
fi

MOUNT_DEFAULT="${GDRIVE_DATA_MOUNT:-/mnt/hd-sata}"
DATA_LOCAL="${GDRIVE_DATA_LOCAL:-$MOUNT_DEFAULT/GoogleDrive-diaria/diaria-studio-data}"
DATA_STATE_DIR="${GDRIVE_DATA_STATE_DIR:-$HOME/.cache/diaria/gdrive-data-bisync}"

DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRY_RUN=1 ;;
  esac
done

# Caminho absoluto canônico, sem barra final (realpath -m resolve `..` e
# symlinks dos componentes existentes; sem ele, só tira a barra final).
canon() {
  c="$(realpath -m -- "$1" 2>/dev/null)" || c="$1"
  [ -n "$c" ] || c="$1"
  while [ "${#c}" -gt 1 ] && [ "${c%/}" != "$c" ]; do c="${c%/}"; done
  printf '%s' "$c"
}

# 0 = $1 e $2 se sobrepõem (iguais, um dentro do outro), por componente.
overlaps() {
  a="$(canon "$1")"
  b="$(canon "$2")"
  [ "$a" = "/" ] || [ "$b" = "/" ] && return 0
  case "$a/" in "$b/"*) return 0 ;; esac
  case "$b/" in "$a/"*) return 0 ;; esac
  return 1
}

FULL_DRIVE_ROOTS="${GDRIVE_DATA_FULL_DRIVE_LOCAL:-/mnt/hd-sata/GoogleDrive}"
for root in "$FULL_DRIVE_ROOTS" "${GDRIVE_LOCAL:-}"; do
  [ -n "$root" ] || continue
  if overlaps "$DATA_LOCAL" "$root"; then
    echo "gdrive-data-bisync: a pasta local de data/ ($DATA_LOCAL) se sobrepõe ao espelho do bisync do Drive inteiro ($root) — os dois sincronizariam a mesma árvore. Ajuste GDRIVE_DATA_LOCAL (em ${ENV_FILE}) para uma pasta fora dele, ex. /mnt/hd-sata/GoogleDrive-diaria/diaria-studio-data. Sync abortado (#12478)" >&2
    if [ "$DRY_RUN" -eq 0 ] && mkdir -p "$DATA_STATE_DIR" 2>/dev/null; then
      printf '{"at":"%s","exit":78}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DATA_STATE_DIR/last-run.json.tmp" &&
        mv "$DATA_STATE_DIR/last-run.json.tmp" "$DATA_STATE_DIR/last-run.json"
    fi
    exit 78
  fi
done

GDRIVE_MOUNT="$MOUNT_DEFAULT"
GDRIVE_REMOTE="${GDRIVE_DATA_REMOTE:-gdrive-diaria:diaria-studio-data}"
GDRIVE_LOCAL="$DATA_LOCAL"
GDRIVE_FILTERS="${GDRIVE_DATA_FILTERS:-$DIR/gdrive-data-bisync-filters.txt}"
GDRIVE_STATE_DIR="$DATA_STATE_DIR"
GDRIVE_WORKDIR="${GDRIVE_DATA_WORKDIR:-$GDRIVE_STATE_DIR/rclone-workdir}"
export GDRIVE_MOUNT GDRIVE_REMOTE GDRIVE_LOCAL GDRIVE_FILTERS GDRIVE_STATE_DIR GDRIVE_WORKDIR

# Variáveis do bisync grande que não se aplicam aqui (ver cabeçalho).
unset GDRIVE_SENTINEL GDRIVE_AUTH_RETRY_MAX GDRIVE_AUTH_RETRY_DELAY GDRIVE_MOUNTPOINT_CMD GDRIVE_MAX_DELETE
if [ -n "${GDRIVE_DATA_MAX_DELETE:-}" ]; then
  GDRIVE_MAX_DELETE="$GDRIVE_DATA_MAX_DELETE"
  export GDRIVE_MAX_DELETE
fi
if [ -n "${GDRIVE_DATA_AUTH_RETRY_MAX:-}" ]; then
  GDRIVE_AUTH_RETRY_MAX="$GDRIVE_DATA_AUTH_RETRY_MAX"
  export GDRIVE_AUTH_RETRY_MAX
fi
if [ -n "${GDRIVE_DATA_AUTH_RETRY_DELAY:-}" ]; then
  GDRIVE_AUTH_RETRY_DELAY="$GDRIVE_DATA_AUTH_RETRY_DELAY"
  export GDRIVE_AUTH_RETRY_DELAY
fi
if [ -n "${GDRIVE_DATA_MOUNTPOINT_CMD:-}" ]; then
  GDRIVE_MOUNTPOINT_CMD="$GDRIVE_DATA_MOUNTPOINT_CMD"
  export GDRIVE_MOUNTPOINT_CMD
fi

# Workdir do rclone criado aqui: não depender de o `rclone bisync` criar um
# `--workdir` que não existe (não conferido contra o v1.75.2 do `300`).
# Falha de mkdir só avisa; o rclone acusa o workdir ausente.
mkdir -p "$GDRIVE_WORKDIR" 2>/dev/null ||
  echo "gdrive-data-bisync: aviso — nao consegui criar $GDRIVE_WORKDIR (#12478)" >&2

exec /bin/sh "$DIR/gdrive-bisync.sh" "$@"
