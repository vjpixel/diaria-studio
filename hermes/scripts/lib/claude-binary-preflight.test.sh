#!/usr/bin/env bash
# Teste de regressão pro #6875/#6879/#6891/#7468 — o preflight compartilhado
# precisa: (1) passar direto quando o binário já responde `--version`; (2)
# reparar UMA vez e seguir, avisando no stderr, quando o reparo resolve; (3)
# sair com exit 5 + mensagem nomeada quando o binário está quebrado E o
# reparo não resolve; (4) [#7468] verificar o reparo por CONTEÚDO (não só
# exit code do install.cjs) via `CLAUDE_BINARY_PREFLIGHT_STUB_SIZE`,
# tentando reparo DIRETO (cópia do binário nativo) como última linha, e
# expor a variante FAIL-SOFT (`claude_binary_ensure`) pra uso ENTRE
# tentativas da cadeia de fallback.
#
# Uso: bash hermes/scripts/lib/claude-binary-preflight.test.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./claude-binary-preflight.sh
source "$DIR/claude-binary-preflight.sh"

FAILED=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $desc — esperado [$expected], obtido [$actual]"
    FAILED=1
  else
    echo "ok: $desc"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) echo "ok: $desc" ;;
    *) echo "FAIL: $desc — esperava conter [$needle], obtido [$haystack]"; FAILED=1 ;;
  esac
}

assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) echo "FAIL: $desc — NÃO esperava conter [$needle], obtido [$haystack]"; FAILED=1 ;;
    *) echo "ok: $desc" ;;
  esac
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# Nota sobre STUB_SIZE=0 nos testes 1-6 (legado, pré-#7468): os fakes de
# teste são scripts de poucas dezenas de bytes — bem menores que o default
# de produção (4096). Sem desligar o check de tamanho aqui, TODO fake
# contaria como "stub" e quebraria a semântica antiga (reparo verificado só
# por --version). STUB_SIZE=0 desliga o check (só arquivo vazio conta) —
# os testes dedicados a #7468, mais abaixo, ligam o check de propósito com
# fixtures desenhadas pra isso.

# ── Caminho 1: binário já saudável — reparo nunca é acionado ──────────────

cat > "$WORKDIR/claude-ok" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$WORKDIR/claude-ok"

set +e
STDERR_OK="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-ok"
    # REPAIR_CMD que, se executado, provaria (via marker) que o reparo foi
    # acionado sem necessidade — não deve ser chamado neste caminho.
    CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD="touch $WORKDIR/repair-called-unnecessarily"
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_OK=$?
set -e
assert_eq "binário OK: preflight não sai (exit 0)" "0" "$RC_OK"
assert_eq "binário OK: reparo NUNCA acionado (marker ausente)" "false" "$([ -f "$WORKDIR/repair-called-unnecessarily" ] && echo true || echo false)"
assert_eq "binário OK: nenhum AVISO/ERRO no stderr" "" "$STDERR_OK"

# ── Caminho 2: binário quebrado, reparo RESOLVE (marker-based fake) ───────

# claude-broken-then-fixed simula o binário real: falha até o marker
# aparecer (é o que o "reparo" cria), depois passa a responder OK — mesmo
# comportamento do install.cjs real corrigindo o binário no disco.
cat > "$WORKDIR/claude-broken-then-fixed" <<EOF
#!/usr/bin/env bash
[ -f "$WORKDIR/fixed-marker" ] && exit 0 || exit 1
EOF
chmod +x "$WORKDIR/claude-broken-then-fixed"
rm -f "$WORKDIR/fixed-marker"

set +e
STDERR_REPAIRED="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-broken-then-fixed"
    CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD="touch $WORKDIR/fixed-marker"
    CLAUDE_BINARY_PREFLIGHT_STUB_SIZE=0
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_REPAIRED=$?
set -e
assert_eq "reparo resolve: preflight NÃO sai (exit 0, segue normalmente)" "0" "$RC_REPAIRED"
assert_contains "reparo resolve: AVISO no stderr (#6891 — nunca silencioso)" "$STDERR_REPAIRED" "AVISO: binário Claude Code estava quebrado — reparado automaticamente"

# ── Caminho 3: binário quebrado, reparo NÃO resolve → exit 5 como antes ───

cat > "$WORKDIR/claude-broken" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$WORKDIR/claude-broken"

set +e
STDERR_BROKEN="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-broken"
    CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD="true"  # reparo roda, mas não conserta nada
    CLAUDE_BINARY_PREFLIGHT_STUB_SIZE=0
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_BROKEN=$?
set -e
assert_eq "reparo não resolve: preflight sai com exit 5" "5" "$RC_BROKEN"
assert_contains "reparo não resolve: mensagem nomeada, não enigmática" "$STDERR_BROKEN" "ERRO: binário Claude Code quebrado"
assert_contains "reparo não resolve: mensagem cita que o reparo foi tentado" "$STDERR_BROKEN" "reparo automático não resolveu"

# ── npm root -g falha/vazio: reparo NUNCA é tentado (mensagem distinta) ───
# Achado do review PR #6894 (P3): sem prefixo npm resolvido, "reparo não
# resolveu" seria enganoso — o reparo nem chegou a rodar.

cat > "$WORKDIR/npm-fail" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$WORKDIR/npm-fail"

set +e
STDERR_NO_NPM_ROOT="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-broken"
    CLAUDE_BINARY_PREFLIGHT_NPM_CMD="$WORKDIR/npm-fail"
    CLAUDE_BINARY_PREFLIGHT_STUB_SIZE=0
    unset CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_NO_NPM_ROOT=$?
set -e
assert_eq "npm root -g falha: preflight sai com exit 5" "5" "$RC_NO_NPM_ROOT"
assert_contains "npm root -g falha: mensagem diz que o reparo NÃO foi tentado (nunca 'não resolveu')" "$STDERR_NO_NPM_ROOT" "reparo automático NÃO foi tentado"

# ── Binário ausente (sem override de reparo) — mesmo comportamento de antes ─

set +e
(
  CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-ausente-nao-existe"
  CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD="true"
  CLAUDE_BINARY_PREFLIGHT_STUB_SIZE=0
  claude_binary_preflight
) >/dev/null 2>&1
RC_ABSENT=$?
set -e
assert_eq "binário ausente: preflight sai com exit 5" "5" "$RC_ABSENT"

# ── Derivação do install.cjs a partir do prefixo do npm (não hardcoded) ───
# #6891: o caminho vem de `npm root -g`, config da máquina, não constante.
# Testado com um `npm` FAKE (via CLAUDE_BINARY_PREFLIGHT_NPM_CMD) + um
# install.cjs de verdade (roda com o `node` real) que grava um marker —
# prova a derivação ponta a ponta sem depender do npm/instalação reais.

mkdir -p "$WORKDIR/fakeroot/@anthropic-ai/claude-code"
cat > "$WORKDIR/fakeroot/@anthropic-ai/claude-code/install.cjs" <<EOF
const fs = require("fs");
fs.writeFileSync("$WORKDIR/derived-install-ran", "ok");
EOF

cat > "$WORKDIR/npm-fake" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "root" ] && [ "\$2" = "-g" ]; then
  echo "$WORKDIR/fakeroot"
  exit 0
fi
exit 1
EOF
chmod +x "$WORKDIR/npm-fake"

cat > "$WORKDIR/claude-broken-then-fixed-2" <<EOF
#!/usr/bin/env bash
[ -f "$WORKDIR/derived-install-ran" ] && exit 0 || exit 1
EOF
chmod +x "$WORKDIR/claude-broken-then-fixed-2"
rm -f "$WORKDIR/derived-install-ran"

set +e
STDERR_DERIVED="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-broken-then-fixed-2"
    CLAUDE_BINARY_PREFLIGHT_NPM_CMD="$WORKDIR/npm-fake"
    CLAUDE_BINARY_PREFLIGHT_STUB_SIZE=0
    unset CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_DERIVED=$?
set -e
assert_eq "derivação via npm root -g: preflight resolve (exit 0)" "0" "$RC_DERIVED"
assert_eq "derivação via npm root -g: install.cjs derivado de fato rodou" "true" "$([ -f "$WORKDIR/derived-install-ran" ] && echo true || echo false)"
assert_contains "derivação via npm root -g: AVISO cita o caminho derivado (não hardcoded)" "$STDERR_DERIVED" "$WORKDIR/fakeroot"

# ══════════════════════════════════════════════════════════════════════
# #7468 — verificação por CONTEÚDO (CLAUDE_BINARY_PREFLIGHT_STUB_SIZE) e
# reparo DIRETO como última linha
# ══════════════════════════════════════════════════════════════════════

# ── Caminho 6: install.cjs sai 0 mas o binário CONTINUA respondendo
# quebrado (rc≠0) — reparo DIRETO (copy do pacote de plataforma) É quem
# resolve. Prova que o fallback existe e roda de fato quando o reparo
# "normal" não colou, usando a MESMA derivação de npm_root (sem override de
# REPAIR_CMD, senão o fallback é pulado de propósito — ver nota no
# cabeçalho do .sh).

mkdir -p "$WORKDIR/fakeroot2/@anthropic-ai/claude-code"
cat > "$WORKDIR/fakeroot2/@anthropic-ai/claude-code/install.cjs" <<'EOF'
// #7468: simula o install.cjs que sai 0 SEM consertar nada — é o próprio
// defeito (b) do cabeçalho do .sh: exit code não prova reparo real.
process.exitCode = 0;
EOF

mkdir -p "$WORKDIR/fakeroot2/@anthropic-ai/claude-code-fakeplat"
cat > "$WORKDIR/fakeroot2/@anthropic-ai/claude-code-fakeplat/claude" <<'EOF'
#!/usr/bin/env bash
# "binário nativo" fake — funciona sempre, é o que o reparo direto copia
# por cima do binário quebrado.
exit 0
EOF
chmod +x "$WORKDIR/fakeroot2/@anthropic-ai/claude-code-fakeplat/claude"

cat > "$WORKDIR/npm-fake-2" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "root" ] && [ "\$2" = "-g" ]; then
  echo "$WORKDIR/fakeroot2"
  exit 0
fi
exit 1
EOF
chmod +x "$WORKDIR/npm-fake-2"

# Alvo do reparo direto: um arquivo que SEMPRE falha (o install.cjs fake
# acima não conserta nada) — só o `cp` do reparo direto pode fazê-lo passar
# a responder `--version` OK, porque ele substitui o CONTEÚDO do arquivo.
cat > "$WORKDIR/claude-target-direct-repair" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$WORKDIR/claude-target-direct-repair"

set +e
STDERR_DIRECT="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-target-direct-repair"
    CLAUDE_BINARY_PREFLIGHT_NPM_CMD="$WORKDIR/npm-fake-2"
    # Este caminho testa o MECANISMO de cópia (achou o pacote de plataforma,
    # copiou, deu chmod +x) — não o check de tamanho (caminho 8 cobre isso
    # à parte). O fake de "binário nativo" acima é só um script de poucos
    # bytes, bem menor que o default de produção (4096) — sem desligar o
    # check aqui, a cópia bem-sucedida seria rejeitada por tamanho, o que
    # mediria a fixture de teste, não o reparo.
    CLAUDE_BINARY_PREFLIGHT_STUB_SIZE=0
    unset CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_DIRECT=$?
set -e
assert_eq "reparo direto: preflight resolve (exit 0) quando install.cjs não bastou" "0" "$RC_DIRECT"
assert_contains "reparo direto: AVISO cita CÓPIA DIRETA (#7468)" "$STDERR_DIRECT" "reparado por CÓPIA DIRETA"
assert_eq "reparo direto: o binário-alvo agora responde --version (foi sobrescrito)" "0" "$("$WORKDIR/claude-target-direct-repair" --version >/dev/null 2>&1; echo $?)"

# ── Caminho 7: install.cjs E reparo direto ambos incapazes (sem pacote de
# plataforma no prefixo) — exit 5, mensagem cita as duas tentativas.

mkdir -p "$WORKDIR/fakeroot3/@anthropic-ai/claude-code"
cat > "$WORKDIR/fakeroot3/@anthropic-ai/claude-code/install.cjs" <<'EOF'
process.exitCode = 0;
EOF
# De propósito: SEM diretório claude-code-* em fakeroot3 — reparo direto
# não tem de onde copiar.

cat > "$WORKDIR/npm-fake-3" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "root" ] && [ "\$2" = "-g" ]; then
  echo "$WORKDIR/fakeroot3"
  exit 0
fi
exit 1
EOF
chmod +x "$WORKDIR/npm-fake-3"

cat > "$WORKDIR/claude-irreparavel" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$WORKDIR/claude-irreparavel"

set +e
STDERR_IRREPARAVEL="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-irreparavel"
    CLAUDE_BINARY_PREFLIGHT_NPM_CMD="$WORKDIR/npm-fake-3"
    unset CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_IRREPARAVEL=$?
set -e
assert_eq "sem pacote de plataforma: preflight sai com exit 5" "5" "$RC_IRREPARAVEL"
assert_contains "sem pacote de plataforma: mensagem cita install.cjs + cópia direta" "$STDERR_IRREPARAVEL" "reparo automático não resolveu (install.cjs + cópia direta tentados)"

# ── Caminho 8: verificação por CONTEÚDO — `--version` responde OK, MAS o
# arquivo é stub-sized. Com CLAUDE_BINARY_PREFLIGHT_STUB_SIZE baixo
# (menor que o tamanho real do fake), o reparo é rejeitado como
# insuficiente mesmo `--version` tendo saído 0 — é o "não confiar só no
# exit code" do #7468 (b). Usa CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD (sempre
# hermético, nunca deriva npm/node reais) — então, como o reparo direto é
# pulado nesse caminho (override presente), a rejeição por stub-size cai
# direto em exit 5.

cat > "$WORKDIR/claude-tiny-but-responds" <<EOF
#!/usr/bin/env bash
[ -f "$WORKDIR/tiny-fixed-marker" ] && exit 0 || exit 1
EOF
chmod +x "$WORKDIR/claude-tiny-but-responds"
rm -f "$WORKDIR/tiny-fixed-marker"
TINY_FILE_SIZE=$(wc -c < "$WORKDIR/claude-tiny-but-responds")
TINY_FILE_SIZE="${TINY_FILE_SIZE//[[:space:]]/}"

set +e
STDERR_STUB_REJECTED="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-tiny-but-responds"
    CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD="touch $WORKDIR/tiny-fixed-marker"
    # Limiar ACIMA do tamanho real do fake -> ele conta como stub mesmo
    # respondendo --version 0.
    CLAUDE_BINARY_PREFLIGHT_STUB_SIZE=$((TINY_FILE_SIZE + 1000))
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_STUB_REJECTED=$?
set -e
assert_eq "STUB_SIZE alto: --version OK não basta, arquivo pequeno é rejeitado (exit 5)" "5" "$RC_STUB_REJECTED"
assert_contains "STUB_SIZE alto: mensagem de reparo não resolvido" "$STDERR_STUB_REJECTED" "ERRO: binário Claude Code quebrado"

# Mesmo fixture, mas com STUB_SIZE=0 (desligado) — o MESMO binário
# "pequeno que responde" agora é aceito, prova que é o limiar (não o
# binário) quem decide.
rm -f "$WORKDIR/tiny-fixed-marker"
set +e
STDERR_STUB_ACCEPTED="$(
  (
    CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-tiny-but-responds"
    CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD="touch $WORKDIR/tiny-fixed-marker"
    CLAUDE_BINARY_PREFLIGHT_STUB_SIZE=0
    claude_binary_preflight
  ) 2>&1 1>/dev/null
)"
RC_STUB_ACCEPTED=$?
set -e
assert_eq "STUB_SIZE=0: o MESMO binário pequeno agora é aceito (exit 0)" "0" "$RC_STUB_ACCEPTED"
assert_contains "STUB_SIZE=0: AVISO de reparo normal (não cópia direta)" "$STDERR_STUB_ACCEPTED" "reparado automaticamente"

# ── Caminho 9: claude_binary_ensure é FAIL-SOFT — nunca chama `exit`,
# devolve 1 quando o binário segue quebrado.

set +e
(
  CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-irreparavel"
  CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD="true"
  CLAUDE_BINARY_PREFLIGHT_STUB_SIZE=0
  claude_binary_ensure
) >/dev/null 2>&1
RC_ENSURE_SOFT=$?
set -e
assert_eq "claude_binary_ensure: binário irreparável -> retorna 1 (nunca exit 5)" "1" "$RC_ENSURE_SOFT"

# ── Caminho 10: claude_binary_ensure devolve 0 quando o binário já está
# saudável (fast path idêntico ao preflight) ou quando o reparo resolve.

set +e
(
  CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-ok"
  claude_binary_ensure
) >/dev/null 2>&1
RC_ENSURE_HEALTHY=$?
set -e
assert_eq "claude_binary_ensure: binário já saudável -> retorna 0" "0" "$RC_ENSURE_HEALTHY"

rm -f "$WORKDIR/fixed-marker"
set +e
(
  CLAUDE_BINARY_PREFLIGHT_CMD="$WORKDIR/claude-broken-then-fixed"
  CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD="touch $WORKDIR/fixed-marker"
  CLAUDE_BINARY_PREFLIGHT_STUB_SIZE=0
  claude_binary_ensure
) >/dev/null 2>&1
RC_ENSURE_REPAIRED=$?
set -e
assert_eq "claude_binary_ensure: reparo resolve -> retorna 0" "0" "$RC_ENSURE_REPAIRED"

if [ "$FAILED" -eq 1 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TODOS OS TESTES PASSARAM"
