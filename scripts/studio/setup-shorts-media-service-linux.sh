#!/usr/bin/env bash
# setup-shorts-media-service-linux.sh (#11265)
#
# Registra (ou remove) o user systemd service "diaria-shorts-media", que mantém
# no ar o scripts/shorts-media-server.ts em http://127.0.0.1:4175 — o servidor
# SOMENTE LEITURA do vertical do dia, servido pela internet como
# https://media.diar.ia.br pelo Cloudflare Tunnel do Studio (2º hostname,
# setup-remote-tunnel-linux.sh --media-hostname). É de onde a Graph API (Reels
# agendado), a Buffer (X) e a Threads API baixam o vídeo NO HORÁRIO DO DISPARO:
# com este service parado, os agendados falham. Runbook: docs/shorts-media-tunnel.md.
#
# Também cria a pasta servida (padrão ~/diaria-media/shorts, a mesma de
# publishing.shorts.public_video.tunnel_dir), com permissão 755. Quem grava
# nela é o publish-shorts.ts --publish; o servidor só lê.
#
# Idempotente: re-rodar sobrescreve a unit. --unregister remove o service (não
# apaga a pasta nem os vídeos).
#
# Uso:
#   ./scripts/studio/setup-shorts-media-service-linux.sh [--dir ~/diaria-media/shorts] [--port 4175] [--dry-run] [--unregister]
set -euo pipefail

PORT=4175
MEDIA_DIR="$HOME/diaria-media/shorts"
DRY_RUN=0
UNREGISTER=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --dir) MEDIA_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --unregister) UNREGISTER=1; shift ;;
    *) echo "Argumento desconhecido: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER_TS="$REPO_ROOT/scripts/shorts-media-server.ts"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/diaria-shorts-media.service"
NODE_BIN="${STUDIO_NODE_BIN:-$(command -v node || true)}"

if [ "$UNREGISTER" = "1" ]; then
  systemctl --user stop diaria-shorts-media.service 2>/dev/null || true
  systemctl --user disable diaria-shorts-media.service 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "Service 'diaria-shorts-media' removido (a pasta $MEDIA_DIR fica)."
  echo "Sem ele, media.diar.ia.br responde erro e os Reels/X/Threads agendados não baixam o vertical."
  exit 0
fi

if [ ! -f "$SERVER_TS" ]; then
  echo "shorts-media-server não encontrado: $SERVER_TS" >&2
  exit 1
fi
if [ -z "$NODE_BIN" ]; then
  echo "node não encontrado no PATH. Defina STUDIO_NODE_BIN=/caminho/pro/node." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

if [ "$DRY_RUN" = "1" ]; then
  echo "=== [--dry-run] Plano (nada é registrado) ==="
  echo "  Pasta   : $MEDIA_DIR (criada com 755 se faltar)"
  echo "  Unit    : $UNIT_FILE"
  echo "  Execute : $NODE_DIR/npx tsx $SERVER_TS --dir $MEDIA_DIR --port $PORT"
  echo "  Bind    : 127.0.0.1:$PORT (só o túnel alcança)"
  exit 0
fi

mkdir -p "$MEDIA_DIR"
chmod 755 "$MEDIA_DIR"

mkdir -p "$UNIT_DIR"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=diar.ia.br: vertical do Shorts servido em media.diar.ia.br, somente leitura (#11265)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
Environment=PATH=$NODE_DIR:/usr/bin:/bin
ExecStart=$NODE_DIR/npx tsx $SERVER_TS --dir $MEDIA_DIR --port $PORT
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable diaria-shorts-media.service

echo ""
echo "=== Resumo ==="
echo "  Pasta servida : $MEDIA_DIR"
echo "  Local         : http://127.0.0.1:$PORT/healthz"
echo "  Unit          : $UNIT_FILE"
echo ""
echo "Iniciar agora:"
echo "  systemctl --user start diaria-shorts-media.service"
echo "Depois, o ingress público (2º hostname do túnel):"
echo "  ./scripts/studio/setup-remote-tunnel-linux.sh --hostname studio.diar.ia.br --media-hostname media.diar.ia.br"
