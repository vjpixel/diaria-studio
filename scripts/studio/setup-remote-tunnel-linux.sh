#!/usr/bin/env bash
# setup-remote-tunnel-linux.sh (#4808, fatia Linux do epic Studio UI #3554,
# espelha scripts/studio/setup-remote-tunnel.ps1 do Windows)
#
# Ativa o acesso remoto ao studio-server local (http://127.0.0.1:PORT) via
# Cloudflare Tunnel, registrando um user systemd service ("diaria-studio-tunnel")
# que roda `cloudflared tunnel run`, sem abrir porta nenhuma (o tunnel é uma
# conexão de saída do cloudflared pra borda Cloudflare).
#
# Este script NÃO configura o Cloudflare Access (allowlist de e-mail + OTP) —
# isso é feito no painel Cloudflare, fora do repo. Ver docs/studio-ui-remote-setup.md.
#
# Idempotente — pode rodar de novo a qualquer momento pra retomar de onde parou.
# Passos:
#   1. Verifica cloudflared instalado (senão, imprime instruções de instalação
#      sem sudo — binário direto pra ~/.local/bin).
#   2. Verifica login (cert.pem em ~/.cloudflared) — senão, IMPRIME a instrução
#      `cloudflared tunnel login` pro editor rodar manualmente (abre browser,
#      não é automatizável).
#   3. Cria (ou reusa) o tunnel nomeado.
#   4. Gera ~/.cloudflared/config.yml com o ingress.
#   5. Roteia o DNS do hostname (se --hostname foi passado).
#   6. Gera um token de conector (`cloudflared tunnel token`) e grava em
#      ~/.cloudflared/token (chmod 600) -- NUNCA no repo, NUNCA na linha de
#      comando do systemd (achado ao vivo #4808: --token expõe o segredo em
#      `ps`/`systemctl status`; usar sempre --token-file).
#   7. Registra o user systemd service, que roda `cloudflared ... tunnel run
#      --token-file ... <nome>` com Restart=always.
#
# GUARD DE BLAST-RADIUS (#4808): se outro conector do MESMO tunnel já estiver
# ativo (ex: o do Windows, task Diaria-Studio-Tunnel), subir um segundo aqui
# faz o hostname público rotear de forma imprevisível entre as duas máquinas.
# Este script CHECA `cloudflared tunnel info <nome>` antes de iniciar o
# service e recusa prosseguir se já houver um conector de outra origem --
# use --force pra pular o guard (só depois de desarmar manualmente o outro lado).
# Achado ao vivo: o guard só roda quando `diaria-studio-tunnel.service` NÃO
# está ativo nesta máquina -- se já estiver, a checagem é pulada (senão
# re-rodar o script pra mudar --hostname/rotacionar token falso-positivaria
# contra o PRÓPRIO conector, contradizendo a idempotência prometida acima).
#
# Uso:
#   ./scripts/studio/setup-remote-tunnel-linux.sh --hostname studio.diar.ia.br [--port 4174] [--dry-run]
#   ./scripts/studio/setup-remote-tunnel-linux.sh --unregister   # remove o service (não desfaz o tunnel/DNS)
set -euo pipefail

TUNNEL_NAME="diaria-studio"
HOSTNAME_ARG=""
PORT=4174
DRY_RUN=0
UNREGISTER=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --hostname) HOSTNAME_ARG="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --tunnel-name) TUNNEL_NAME="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --unregister) UNREGISTER=1; shift ;;
    --force) FORCE=1; shift ;;
    *) echo "Argumento desconhecido: $1" >&2; exit 1 ;;
  esac
done

CLOUDFLARED_DIR="$HOME/.cloudflared"
CERT_PATH="$CLOUDFLARED_DIR/cert.pem"
CONFIG_PATH="$CLOUDFLARED_DIR/config.yml"
TOKEN_PATH="$CLOUDFLARED_DIR/token"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/diaria-studio-tunnel.service"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")}"

step() { echo ""; echo "=== $1 ==="; }

if [ "$UNREGISTER" = "1" ]; then
  systemctl --user stop diaria-studio-tunnel.service 2>/dev/null || true
  systemctl --user disable diaria-studio-tunnel.service 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "Service 'diaria-studio-tunnel' removido."
  echo "Isso NÃO desfaz o tunnel nem o DNS na Cloudflare. Pra desfazer de vez:"
  echo "  cloudflared tunnel route dns --overwrite-dns $TUNNEL_NAME <old-hostname-se-quiser-liberar>"
  echo "  cloudflared tunnel delete $TUNNEL_NAME"
  echo "  (e remover o Access Application correspondente no painel CF)"
  exit 0
fi

step "1/7 — Verificando cloudflared"
if [ ! -x "$CLOUDFLARED_BIN" ] && ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared não encontrado."
  echo ""
  echo "Instale sem sudo (binário direto pra ~/.local/bin):"
  echo "  mkdir -p ~/.local/bin"
  echo "  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared"
  echo "  chmod +x ~/.local/bin/cloudflared"
  echo ""
  echo "Depois, garanta que ~/.local/bin está no PATH e rode este script de novo."
  exit 1
fi
echo "cloudflared encontrado: $CLOUDFLARED_BIN ($($CLOUDFLARED_BIN --version 2>&1 | head -1))"

step "2/7 — Verificando autenticação com a conta Cloudflare"
if [ ! -f "$CERT_PATH" ]; then
  echo "Nenhuma sessão autenticada encontrada ($CERT_PATH ausente)."
  echo ""
  echo "Rode manualmente (abre um link OAuth pra você autorizar na conta Cloudflare —"
  echo "não é automatizável, nunca autentica em nome do editor):"
  echo ""
  echo "  $CLOUDFLARED_BIN tunnel login"
  echo ""
  echo "Depois de autenticar (a URL fica visível até você abrir e autorizar — o"
  echo "processo precisa ficar rodando até baixar o certificado), rode este script"
  echo "de novo pra continuar do passo 3."
  exit 1
fi
echo "Sessão autenticada encontrada: $CERT_PATH"

if [ "$DRY_RUN" = "1" ]; then
  echo ""
  echo "[--dry-run] Pararia aqui a verificação de pré-requisitos. Próximos passos (não executados):"
  echo "  3. $CLOUDFLARED_BIN tunnel create $TUNNEL_NAME (ou reusar, se já existir)"
  echo "  4. gerar $CONFIG_PATH (ingress -> http://127.0.0.1:$PORT)"
  if [ -n "$HOSTNAME_ARG" ]; then
    echo "  5. $CLOUDFLARED_BIN tunnel route dns $TUNNEL_NAME $HOSTNAME_ARG"
  else
    echo "  5. (pulado — sem --hostname) $CLOUDFLARED_BIN tunnel route dns $TUNNEL_NAME <hostname>"
  fi
  echo "  6. gerar token de conector em $TOKEN_PATH (chmod 600)"
  echo "  7. registrar service '$UNIT_FILE' (systemd --user, Restart=always)"
  exit 0
fi

step "3/7 — Tunnel '$TUNNEL_NAME'"
if "$CLOUDFLARED_BIN" tunnel list 2>&1 | grep -qE "^[0-9a-f-]{36}[[:space:]]+$TUNNEL_NAME[[:space:]]"; then
  TUNNEL_ID="$("$CLOUDFLARED_BIN" tunnel list 2>&1 | grep -E "^[0-9a-f-]{36}[[:space:]]+$TUNNEL_NAME[[:space:]]" | awk '{print $1}')"
  echo "Tunnel '$TUNNEL_NAME' já existe (id: $TUNNEL_ID) — reusando."
else
  echo "Criando tunnel '$TUNNEL_NAME'..."
  "$CLOUDFLARED_BIN" tunnel create "$TUNNEL_NAME"
  TUNNEL_ID="$("$CLOUDFLARED_BIN" tunnel list 2>&1 | grep -E "^[0-9a-f-]{36}[[:space:]]+$TUNNEL_NAME[[:space:]]" | awk '{print $1}')"
fi
if [ -z "${TUNNEL_ID:-}" ]; then
  echo "Não consegui determinar o Tunnel ID de '$TUNNEL_NAME'. Rode '$CLOUDFLARED_BIN tunnel list' manualmente." >&2
  exit 1
fi
echo "Tunnel ID: $TUNNEL_ID"

step "GUARD — checando conectores ativos de outra origem"
if systemctl --user is-active --quiet diaria-studio-tunnel.service 2>/dev/null; then
  echo "'diaria-studio-tunnel.service' já está ativo NESTA máquina — guard pulado."
  echo "(a decisão de segurança já foi tomada quando o service subiu da primeira vez;"
  echo " checar 'tunnel info' agora só falso-positivaria contra o próprio conector,"
  echo " quebrando a idempotência de re-rodar este script pra mudar --hostname/token.)"
else
  ACTIVE="$("$CLOUDFLARED_BIN" tunnel info "$TUNNEL_NAME" 2>&1 || true)"
  if echo "$ACTIVE" | grep -q "CONNECTOR ID" && [ "$FORCE" != "1" ]; then
    echo "$ACTIVE"
    echo ""
    echo "AVISO: já existe conector ativo pra este tunnel (acima). Subir outro aqui" >&2
    echo "  arrisca roteamento imprevisivel do hostname entre as duas maquinas." >&2
    echo "  Desarme o outro lado primeiro (ver #4806/#4808) e rode de novo, ou passe" >&2
    echo "  --force se ja tiver certeza de que o outro conector foi desativado" >&2
    echo "  (a listagem pode ter alguns segundos de delay de propagacao)." >&2
    exit 1
  fi
  echo "Nenhum conector ativo de outra origem (ou --force). Prosseguindo."
fi

step "4/7 — Gerando $CONFIG_PATH"
umask 077
mkdir -p "$CLOUDFLARED_DIR"
INGRESS_LINE="  # (defina --hostname e rode de novo pra preencher a linha de ingress abaixo)
  # - hostname: studio.diar.ia.br
  #   service: http://127.0.0.1:$PORT"
if [ -n "$HOSTNAME_ARG" ]; then
  INGRESS_LINE="  - hostname: $HOSTNAME_ARG
    service: http://127.0.0.1:$PORT"
fi
cat > "$CONFIG_PATH" <<EOF
# Gerado por scripts/studio/setup-remote-tunnel-linux.sh (#4808) -- idempotente,
# seguro sobrescrever. Autenticado via tunnel token (--token-file), não
# credentials-file -- funciona mesmo que o tunnel tenha sido criado noutra
# máquina (ex: Windows, ver setup-remote-tunnel.ps1).
ingress:
$INGRESS_LINE
  - service: http_status:404
EOF
chmod 600 "$CONFIG_PATH"
echo "Escrito: $CONFIG_PATH"

step "5/7 — DNS"
if [ -z "$HOSTNAME_ARG" ]; then
  echo "Nenhum --hostname informado — pulando o roteamento DNS."
  echo "Rode de novo com --hostname studio.diar.ia.br pra completar."
else
  echo "Roteando $HOSTNAME_ARG -> tunnel $TUNNEL_NAME..."
  if ! "$CLOUDFLARED_BIN" tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_ARG" 2>&1; then
    echo "Aviso: 'tunnel route dns' retornou erro (pode já existir um registro — confira no painel CF > DNS)."
  else
    echo "DNS roteado: $HOSTNAME_ARG -> $TUNNEL_NAME"
  fi
fi

step "6/7 — Token do conector"
"$CLOUDFLARED_BIN" tunnel token "$TUNNEL_NAME" > "$TOKEN_PATH"
chmod 600 "$TOKEN_PATH"
echo "Token gravado em $TOKEN_PATH (chmod 600, nunca no repo, nunca em argv)."

step "7/7 — Registrando service '$UNIT_FILE'"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=diar.ia.br Studio -- Cloudflare Tunnel (#3560/#4808)
After=network-online.target diaria-studio-server.service
Wants=network-online.target
Requires=diaria-studio-server.service

[Service]
Type=simple
ExecStart=$CLOUDFLARED_BIN --config $CONFIG_PATH tunnel run --token-file $TOKEN_PATH $TUNNEL_NAME
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable diaria-studio-tunnel.service

echo ""
echo "=== Resumo ==="
echo "  Tunnel      : $TUNNEL_NAME ($TUNNEL_ID)"
echo "  Config      : $CONFIG_PATH"
echo "  Hostname    : ${HOSTNAME_ARG:-'(não configurado — rode de novo com --hostname)'}"
echo "  Studio local: http://127.0.0.1:$PORT"
echo "  Unit        : $UNIT_FILE"
echo ""
echo "Iniciar agora (requer diaria-studio-server.service já ativo -- ver"
echo "setup-studio-service-linux.sh):"
echo "  systemctl --user start diaria-studio-tunnel.service"
echo ""
echo "PRÓXIMO PASSO (fora deste script, no painel Cloudflare):"
echo "  Configurar o Cloudflare Access na frente do hostname -- ver docs/studio-ui-remote-setup.md."
echo "  Sem isso, o hostname fica exposto (mesmo atrás do tunnel) -- Access é o que exige login."
echo ""
echo "Depois de configurar o Access, valide com:"
echo "  npx tsx scripts/studio/verify-remote-tunnel.ts --url https://${HOSTNAME_ARG:-'<hostname>'}"
