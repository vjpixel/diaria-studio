#!/usr/bin/env bash
# setup-studio-service-linux.sh (#4808, fatia Linux do epic Studio UI #3554;
# o par Windows setup-studio-service.ps1 foi removido no #5115, cutover final)
#
# Registra (ou remove) um user systemd service "diaria-studio-server" que
# mantém o studio-server (scripts/studio-ui/server.ts, http://127.0.0.1:4174)
# sempre no ar — mesmo papel da task "Diaria-Studio-Server" no Windows,
# adaptado pro padrão systemd --user + loginctl enable-linger (que dispensa
# uma sessão de login ativa, ao contrário do "AtLogOn" do Task Scheduler).
#
# Idempotente: re-rodar sobrescreve a unit existente. --unregister remove o
# service (não mata um `npm run studio` que você tenha aberto à mão).
#
# Pré-requisitos:
#   - `loginctl enable-linger $USER` (1x, sudo) — sem isso o service para
#     quando a última sessão de login encerra.
#   - Node >= 22.5 no PATH (node:sqlite -- ver #4823). Por padrão usa o
#     `node`/`npx` que já resolve no PATH desta shell; passe
#     STUDIO_NODE_BIN=/caminho/pro/node se precisar apontar pra uma
#     instalação alternativa (achado ao vivo em #4808: Node do pacote da
#     distro pode estar abaixo de 22.5).
#
# Uso:
#   ./scripts/studio/setup-studio-service-linux.sh [--port 4174] [--dry-run] [--unregister]
set -euo pipefail

PORT=4174
DRY_RUN=0
UNREGISTER=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --unregister) UNREGISTER=1; shift ;;
    *) echo "Argumento desconhecido: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER_TS="$REPO_ROOT/scripts/studio-ui/server.ts"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/diaria-studio-server.service"
NODE_BIN="${STUDIO_NODE_BIN:-$(command -v node || true)}"

if [ "$UNREGISTER" = "1" ]; then
  systemctl --user stop diaria-studio-server.service 2>/dev/null || true
  systemctl --user disable diaria-studio-server.service 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "Service 'diaria-studio-server' removido."
  echo "Isso NÃO mata um 'npm run studio' aberto à mão num terminal."
  exit 0
fi

if [ ! -f "$SERVER_TS" ]; then
  echo "studio-server não encontrado: $SERVER_TS" >&2
  exit 1
fi

if [ -z "$NODE_BIN" ]; then
  echo "node não encontrado no PATH. Instale Node >=22.5 (ver #4823) ou defina STUDIO_NODE_BIN." >&2
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "AVISO: $NODE_BIN é v$NODE_VERSION — scripts/lib/clarice-db.ts precisa de node:sqlite (Node >=22.5)." >&2
  echo "  O studio-server provavelmente vai crashar com ERR_UNKNOWN_BUILTIN_MODULE nessa versão." >&2
  echo "  Aponte STUDIO_NODE_BIN pra uma instalação >=22.5, ou instale via nvm/binário direto (ver #4823)." >&2
fi
NODE_DIR="$(dirname "$NODE_BIN")"

if [ "$DRY_RUN" = "1" ]; then
  echo "=== [--dry-run] Plano (nada é registrado) ==="
  echo "  Unit    : $UNIT_FILE"
  echo "  Node    : $NODE_BIN (v$NODE_VERSION)"
  echo "  Execute : $NODE_DIR/npx tsx $SERVER_TS --port $PORT"
  echo "  WorkDir : $REPO_ROOT"
  echo "  Restart : always (equivalente ao RestartCount/RestartInterval do Windows)"
  exit 0
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=diar.ia.br Studio server (#3554/#4808)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
Environment=PATH=$NODE_DIR:/usr/bin:/bin
Environment=NODE_ENV=production
ExecStart=$NODE_DIR/npx tsx $SERVER_TS --port $PORT
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable diaria-studio-server.service

echo ""
echo "=== Resumo ==="
echo "  Studio local : http://127.0.0.1:$PORT"
echo "  Unit         : $UNIT_FILE"
echo "  Server       : $SERVER_TS"
echo ""
echo "Iniciar agora:"
echo "  systemctl --user start diaria-studio-server.service"
echo "Parar (sem remover a unit):"
echo "  systemctl --user stop diaria-studio-server.service"
echo "Confirmar que loginctl linger está ligado (senão o service para no logout):"
echo "  loginctl show-user \$USER -p Linger    # deve mostrar Linger=yes"
echo "  sudo loginctl enable-linger \$USER      # se não estiver"
