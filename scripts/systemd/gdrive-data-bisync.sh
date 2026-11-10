#!/bin/sh
# gdrive-data-bisync.sh (#12478, épica #12353)
#
# Bisync DEDICADO de data/ no `300`: só a pasta do projeto no Google Drive,
# 1 min depois do fim da rodada anterior (unit diaria-gdrive-data-bisync.timer,
# OnUnitInactiveSec=1min). O bisync do Drive inteiro (gdrive-bisync.sh,
# #12356) leva ~34 min por rodada e deixaria o data/ do `300` até ~70 min
# atrás do Neo depois do cutover (#12359). Estado de instalação: ver
# docs/scheduled-tasks-registry.md (`diaria-gdrive-data-bisync`).
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
# Os defaults são o destino real: conta diaria.editor, remote `gdrive-diaria`
# criado no `300` (#12575, feita). A pasta local fica FORA do espelho do
# Drive da vjpixel (/mnt/hd-sata/GoogleDrive), que o bisync grande
# sincroniza. Qualquer ajuste vai SÓ no arquivo
#
#   ~/.config/diaria/gdrive-data-bisync.env   (ou GDRIVE_DATA_ENV_FILE, caminho absoluto)
#
# nunca no .env do projeto nem no Doppler (o .env não chega à unit, e o
# alarme só lê este arquivo). Formato ESTRITO, uma linha CHAVE=valor por
# variável acima, sem aspas, sem espaço em volta do `=`, sem `export`, sem
# BOM; `#` no início comenta; linha vazia é pulada. O arquivo é LIDO, nunca
# executado como shell (`. arquivo`). Linha malformada, chave desconhecida,
# chave repetida, arquivo existente mas ilegível, ou GDRIVE_DATA_ENV_FILE
# explícito apontando para arquivo inexistente: exit 78 — um sync silencioso
# contra o remote errado é pior que um sync parado. Arquivo default ausente
# é normal (valem os defaults). Variável já presente no ambiente vence o
# arquivo. O alarme (scripts/gdrive-sync-alarm.ts) lê o mesmo arquivo com
# as MESMAS regras, reimplementadas em scripts/lib/gdrive-data-bisync-config.ts
# (mudou uma, mude a outra; o teste diferencial
# test/gdrive-data-bisync-12478.test.ts compara as duas).
#
# Exit 78 (EX_CONFIG) — configuração inválida, sempre antes do rclone, com
# `last-run.json` carimbado (exit 78) quando o state dir é utilizável:
#   - arquivo de env inválido (acima);
#   - caminho relativo em LOCAL, MOUNT, FILTERS, STATE_DIR, WORKDIR ou no
#     GDRIVE_DATA_ENV_FILE;
#   - GDRIVE_DATA_REMOTE sem `remote:` ou com o MESMO remote do bisync grande
#     (`${GDRIVE_REMOTE:-gdrive:}`): sobreposição pelo lado da nuvem;
#   - pasta local igual, dentro ou contendo o espelho do Drive inteiro
#     (sobreposição pelo lado do disco). A comparação é por componente de
#     caminho, com `realpath -m` (/mnt/hd-sata/GoogleDrive-diaria NÃO está
#     dentro de /mnt/hd-sata/GoogleDrive); sem `realpath` utilizável, 78.
#     Raízes: /mnt/hd-sata/GoogleDrive (o default do gdrive-bisync.sh, que a
#     unit diaria-gdrive-bisync usa sem Environment=), SEMPRE, mais o
#     GDRIVE_LOCAL que vier no ambiente de uma rodada manual, mais
#     GDRIVE_DATA_FULL_DRIVE_LOCAL (raiz extra, para teste).
#
# Atalho proibido: nunca criar um atalho de `diaria-studio-data` no Meu Drive
# da vjpixel. O rclone segue atalhos, e o bisync grande passaria a tocar a
# mesma árvore por outro caminho, sem que nenhuma das travas acima veja. O
# Neo usa a conta diaria.editor no Drive para Desktop.
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

DIR="$(cd "$(dirname "$0")" && pwd)"
KEYS="GDRIVE_DATA_REMOTE GDRIVE_DATA_LOCAL GDRIVE_DATA_MOUNT GDRIVE_DATA_FILTERS GDRIVE_DATA_STATE_DIR GDRIVE_DATA_WORKDIR GDRIVE_DATA_MAX_DELETE"

DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRY_RUN=1 ;;
  esac
done

# 1º erro de configuração (vazio = nenhum). Os demais são checados mesmo
# assim, mas só o 1º é reportado.
CONFIG_ERROR=""
config_error() {
  [ -n "$CONFIG_ERROR" ] || CONFIG_ERROR="$1"
}

if [ -n "${GDRIVE_DATA_ENV_FILE:-}" ]; then
  ENV_FILE="$GDRIVE_DATA_ENV_FILE"
  ENV_FILE_EXPLICIT=1
else
  ENV_FILE="$HOME/.config/diaria/gdrive-data-bisync.env"
  ENV_FILE_EXPLICIT=0
fi

case "$ENV_FILE" in
  /*) ;;
  *) config_error "GDRIVE_DATA_ENV_FILE precisa ser caminho absoluto ($ENV_FILE)" ;;
esac

# Lê CHAVE=valor do arquivo de env sem avaliar nada. Só define a variável se
# ela não veio do ambiente (o ambiente vence).
if [ -z "$CONFIG_ERROR" ]; then
  if [ -e "$ENV_FILE" ]; then
    if [ ! -f "$ENV_FILE" ] || [ ! -r "$ENV_FILE" ]; then
      config_error "arquivo de env $ENV_FILE existe mas não é um arquivo legível"
    fi
  elif [ "$ENV_FILE_EXPLICIT" -eq 1 ]; then
    config_error "GDRIVE_DATA_ENV_FILE aponta para $ENV_FILE, que não existe"
  fi
fi
if [ -z "$CONFIG_ERROR" ] && [ -f "$ENV_FILE" ]; then
  CR="$(printf '\r')"
  BOM="$(printf '\357\273\277')"
  SEEN=" "
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    # Arquivo salvo com CRLF: o \r iria colado no valor (remote inválido).
    case "$line" in
      *"$CR") line="${line%?}" ;;
    esac
    case "$line" in
      "$BOM"*) config_error "$ENV_FILE linha $n: BOM no início do arquivo (salve como UTF-8 sem BOM)"; continue ;;
    esac
    case "$line" in
      '#'*) continue ;;
    esac
    case "$line" in
      *[!\ \	]*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    if [ "$key" = "$line" ]; then
      config_error "$ENV_FILE linha $n: sem '='"
      continue
    fi
    case "$key" in
      ''|[0-9]*|*[!A-Za-z0-9_]*)
        config_error "$ENV_FILE linha $n: chave malformada '$key' (sem espaço, sem 'export')"
        continue
        ;;
    esac
    case "$val" in
      [\ \	]*) config_error "$ENV_FILE linha $n: espaço depois do '=' em $key"; continue ;;
    esac
    case " $KEYS " in
      *" $key "*) ;;
      *) config_error "$ENV_FILE linha $n: chave desconhecida $key"; continue ;;
    esac
    case "$SEEN" in
      *" $key "*) config_error "$ENV_FILE linha $n: chave $key repetida"; continue ;;
    esac
    SEEN="$SEEN$key "
    # A chave já foi validada contra a lista: o eval só testa se ela está
    # definida, nunca expande o valor.
    eval "already=\${$key+x}"
    if [ -z "$already" ]; then
      # `export` com o valor numa variável: nunca expande o conteúdo.
      export "$key=$val"
    fi
  done < "$ENV_FILE"
fi

MOUNT_DEFAULT="${GDRIVE_DATA_MOUNT:-/mnt/hd-sata}"
DATA_REMOTE="${GDRIVE_DATA_REMOTE:-gdrive-diaria:diaria-studio-data}"
DATA_LOCAL="${GDRIVE_DATA_LOCAL:-$MOUNT_DEFAULT/GoogleDrive-diaria/diaria-studio-data}"
DATA_FILTERS="${GDRIVE_DATA_FILTERS:-$DIR/gdrive-data-bisync-filters.txt}"
DATA_STATE_DIR="${GDRIVE_DATA_STATE_DIR:-$HOME/.cache/diaria/gdrive-data-bisync}"
DATA_WORKDIR="${GDRIVE_DATA_WORKDIR:-$DATA_STATE_DIR/rclone-workdir}"

check_abs() {
  case "$2" in
    /*) ;;
    *) config_error "$1 precisa ser caminho absoluto ($2)" ;;
  esac
}
check_abs GDRIVE_DATA_LOCAL "$DATA_LOCAL"
check_abs GDRIVE_DATA_MOUNT "$MOUNT_DEFAULT"
check_abs GDRIVE_DATA_FILTERS "$DATA_FILTERS"
check_abs GDRIVE_DATA_STATE_DIR "$DATA_STATE_DIR"
check_abs GDRIVE_DATA_WORKDIR "$DATA_WORKDIR"

# Sobreposição pelo lado da nuvem: o mesmo remote do bisync grande.
case "$DATA_REMOTE" in
  ?*:*) ;;
  *) config_error "GDRIVE_DATA_REMOTE precisa ser remote:pasta ($DATA_REMOTE)" ;;
esac
DATA_REMOTE_NAME="${DATA_REMOTE%%:*}"
BIG_REMOTE="${GDRIVE_REMOTE:-gdrive:}"
BIG_REMOTE_NAME="${BIG_REMOTE%%:*}"
if [ -n "$DATA_REMOTE_NAME" ] && [ "$DATA_REMOTE_NAME" = "$BIG_REMOTE_NAME" ]; then
  config_error "GDRIVE_DATA_REMOTE usa o remote $DATA_REMOTE_NAME:, o mesmo do bisync do Drive inteiro — os dois sincronizariam a mesma conta. Use o remote da conta diaria.editor (gdrive-diaria:)"
fi

# Caminho absoluto canônico, sem barra final. `realpath -m` resolve `..` e
# symlinks dos componentes existentes; sem ele não há comparação confiável.
CANON=""
canon() {
  CANON="$(realpath -m -- "$1" 2>/dev/null)" || return 1
  [ -n "$CANON" ] || return 1
  while [ "${#CANON}" -gt 1 ] && [ "${CANON%/}" != "$CANON" ]; do CANON="${CANON%/}"; done
  return 0
}

# 0 = $1 e $2 se sobrepõem (iguais, um dentro do outro), por componente.
# 2 = não deu para canonizar.
overlaps() {
  canon "$1" || return 2
  a="$CANON"
  canon "$2" || return 2
  b="$CANON"
  if [ "$a" = "/" ] || [ "$b" = "/" ]; then return 0; fi
  case "$a/" in "$b/"*) return 0 ;; esac
  case "$b/" in "$a/"*) return 0 ;; esac
  return 1
}

if [ -z "$CONFIG_ERROR" ]; then
  for root in /mnt/hd-sata/GoogleDrive "${GDRIVE_LOCAL:-}" "${GDRIVE_DATA_FULL_DRIVE_LOCAL:-}"; do
    [ -n "$root" ] || continue
    overlaps "$DATA_LOCAL" "$root"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      config_error "a pasta local de data/ ($DATA_LOCAL) se sobrepõe ao espelho do bisync do Drive inteiro ($root) — os dois sincronizariam a mesma árvore. Ajuste GDRIVE_DATA_LOCAL (em $ENV_FILE) para uma pasta fora dele, ex. /mnt/hd-sata/GoogleDrive-diaria/diaria-studio-data"
      break
    elif [ "$rc" -eq 2 ]; then
      config_error "não consegui canonizar $DATA_LOCAL ou $root (realpath -m indisponível?) — sem isso a trava de sobreposição não é confiável"
      break
    fi
  done
fi

if [ -n "$CONFIG_ERROR" ]; then
  echo "gdrive-data-bisync: configuração inválida — $CONFIG_ERROR. Sync abortado, exit 78 (#12478)" >&2
  # Carimbo só com state dir absoluto: o alarme lê exit 78 como configuração
  # inválida. --dry-run não carimba, como no gdrive-bisync.sh.
  case "$DATA_STATE_DIR" in
    /*)
      if [ "$DRY_RUN" -eq 0 ] && mkdir -p "$DATA_STATE_DIR" 2>/dev/null; then
        printf '{"at":"%s","exit":78}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DATA_STATE_DIR/last-run.json.tmp" &&
          mv "$DATA_STATE_DIR/last-run.json.tmp" "$DATA_STATE_DIR/last-run.json"
      fi
      ;;
  esac
  exit 78
fi

GDRIVE_MOUNT="$MOUNT_DEFAULT"
GDRIVE_REMOTE="$DATA_REMOTE"
GDRIVE_LOCAL="$DATA_LOCAL"
GDRIVE_FILTERS="$DATA_FILTERS"
GDRIVE_STATE_DIR="$DATA_STATE_DIR"
GDRIVE_WORKDIR="$DATA_WORKDIR"
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
