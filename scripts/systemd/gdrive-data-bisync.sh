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
#   GDRIVE_DATA_REMOTE     remote:pasta       default gdrive:diaria-studio-data
#   GDRIVE_DATA_LOCAL      pasta local        default /mnt/hd-sata/GoogleDrive/diaria-studio-data
#   GDRIVE_DATA_MOUNT      ponto de montagem  default /mnt/hd-sata
#   GDRIVE_DATA_FILTERS    filtro do checkout default gdrive-data-bisync-filters.txt (ao lado deste script)
#   GDRIVE_DATA_STATE_DIR  state dir          default ~/.cache/diaria/gdrive-data-bisync
#   GDRIVE_DATA_WORKDIR    workdir do rclone  default {state dir}/rclone-workdir (listagens + lock)
#   GDRIVE_DATA_MAX_DELETE --max-delete (%)   default o do gdrive-bisync.sh (5)
#
# O destino previsto é `gdrive-diaria:diaria-studio-data` ↔
# `/mnt/hd-sata/GoogleDrive-diaria/diaria-studio-data` (conta diaria.editor,
# #12575/#12576), FORA do espelho do Drive da vjpixel: com os defaults acima a
# pasta local fica dentro de /mnt/hd-sata/GoogleDrive, que o bisync grande
# também sincroniza. A troca é feita na instalação, no arquivo
#
#   ~/.config/diaria/gdrive-data-bisync.env   (ou GDRIVE_DATA_ENV_FILE)
#
# uma linha CHAVE=valor por variável acima, sem aspas; `#` comenta. O arquivo
# é LIDO, nunca executado como shell (`. arquivo`): só as chaves da lista
# valem, as outras viram aviso. A unit e uma rodada manual leem o mesmo
# arquivo. Variável já presente no ambiente vence o arquivo.
#
# As variáveis GDRIVE_* do bisync grande que chegarem pelo ambiente são
# sobrescritas aqui: um `GDRIVE_STATE_DIR` exportado no shell nunca faz esta
# instância usar o estado (ou o filtro instalado) do Drive inteiro.
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
GDRIVE_MOUNT="$MOUNT_DEFAULT"
GDRIVE_REMOTE="${GDRIVE_DATA_REMOTE:-gdrive:diaria-studio-data}"
GDRIVE_LOCAL="${GDRIVE_DATA_LOCAL:-$MOUNT_DEFAULT/GoogleDrive/diaria-studio-data}"
GDRIVE_FILTERS="${GDRIVE_DATA_FILTERS:-$DIR/gdrive-data-bisync-filters.txt}"
GDRIVE_STATE_DIR="${GDRIVE_DATA_STATE_DIR:-$HOME/.cache/diaria/gdrive-data-bisync}"
GDRIVE_WORKDIR="${GDRIVE_DATA_WORKDIR:-$GDRIVE_STATE_DIR/rclone-workdir}"
export GDRIVE_MOUNT GDRIVE_REMOTE GDRIVE_LOCAL GDRIVE_FILTERS GDRIVE_STATE_DIR GDRIVE_WORKDIR
if [ -n "${GDRIVE_DATA_MAX_DELETE:-}" ]; then
  GDRIVE_MAX_DELETE="$GDRIVE_DATA_MAX_DELETE"
  export GDRIVE_MAX_DELETE
else
  unset GDRIVE_MAX_DELETE
fi

exec /bin/sh "$DIR/gdrive-bisync.sh" "$@"
