#!/usr/bin/env bash
# Teste de regressão #8740 — register-continuo-tick.sh precisa:
#   1. Gerar o SESSION_ID no formato hermes-cron-<job>-<ts> e IMPRIMIR em
#      stdout mesmo quando o registro falha (o chamador precisa do id de
#      qualquer forma, fail-soft).
#   2. Ao registrar com sucesso, chamar `npx tsx scripts/lib/session-
#      registry.ts register --kind continuo --session-id <id>` (nunca
#      `overnight`/`develop` — mesma classe de erro do #6483) e gravar o
#      SESSION_ID no path estável ($SESSION_ID_FILE_OVERRIDE).
#   3. Ao falhar (rc != 0 do `npx` fake, ou `cd` pro repo falhando), NUNCA
#      abortar (`set -e` não propaga pro chamador) — sempre sair 0, sempre
#      imprimir o SESSION_ID, e nunca sobrescrever o arquivo estável com
#      lixo.
#
# Usa um `npx` FAKE no PATH — nunca chama o `session-registry.ts` real
# (evitaria escrever em `data/sessions/` de verdade, que é o junction
# OneDrive compartilhado entre máquinas — #7699/#5227 já ensinaram o preço
# de tocar esse diretório por engano num teste).
#
# Uso: bash hermes/scripts/register-continuo-tick.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$DIR/register-continuo-tick.sh"
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
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "ok: $desc"
  else
    echo "FAIL: $desc — esperava conter [$needle], obtido [$haystack]"
    FAILED=1
  fi
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

mkdir -p "$WORKDIR/bin" "$WORKDIR/repo"
NPX_CALL_LOG="$WORKDIR/npx-calls.log"
NPX_RC_FILE="$WORKDIR/npx-rc"
echo 0 > "$NPX_RC_FILE"

cat > "$WORKDIR/bin/npx" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$NPX_CALL_LOG"
rc=\$(cat "$NPX_RC_FILE")
if [ "\$rc" = "0" ]; then
  echo "session-registry: registered data/sessions/continuo-fake-\$4.json"
else
  echo "boom: registro falhou de propósito" >&2
fi
exit "\$rc"
EOF
chmod +x "$WORKDIR/bin/npx"

run_script() {
  local session_id_file="$1"
  PATH="$WORKDIR/bin:$PATH" \
    REPO_ROOT_OVERRIDE="$WORKDIR/repo" \
    SESSION_ID_FILE_OVERRIDE="$session_id_file" \
    SESSION_TS_OVERRIDE="20260924T120000Z" \
    "$SCRIPT" "test-job-id"
}

# ── Caso 1: registro com sucesso ──
: > "$NPX_RC_FILE"; echo 0 > "$NPX_RC_FILE"
: > "$NPX_CALL_LOG"
SID_FILE_1="$WORKDIR/session-id-1"
OUT1=$(run_script "$SID_FILE_1")
RC1=$?

assert_eq "sucesso — exit code é 0" "0" "$RC1"
assert_eq "sucesso — SESSION_ID impresso em stdout" "hermes-cron-test-job-id-20260924T120000Z" "$OUT1"
if [ -f "$SID_FILE_1" ]; then
  assert_eq "sucesso — SESSION_ID gravado no arquivo estável" "hermes-cron-test-job-id-20260924T120000Z" "$(cat "$SID_FILE_1")"
else
  echo "FAIL: sucesso — arquivo estável não foi criado"
  FAILED=1
fi
CALL1="$(cat "$NPX_CALL_LOG")"
assert_contains "sucesso — chamou tsx session-registry.ts" "$CALL1" "scripts/lib/session-registry.ts"
assert_contains "sucesso — subcomando register" "$CALL1" "register"
assert_contains "sucesso — kind continuo (nunca overnight/develop, #6483)" "$CALL1" "--kind continuo"
assert_contains "sucesso — session-id propagado" "$CALL1" "--session-id hermes-cron-test-job-id-20260924T120000Z"

# ── Caso 2: registro falha (rc != 0) — fail-soft ──
echo 1 > "$NPX_RC_FILE"
: > "$NPX_CALL_LOG"
SID_FILE_2="$WORKDIR/session-id-2"
OUT2=$(run_script "$SID_FILE_2")
RC2=$?

assert_eq "falha do register — exit code do wrapper continua 0 (fail-soft)" "0" "$RC2"
assert_eq "falha do register — SESSION_ID ainda é impresso em stdout" "hermes-cron-test-job-id-20260924T120000Z" "$OUT2"
if [ -f "$SID_FILE_2" ]; then
  echo "FAIL: falha do register — arquivo estável não deveria ser criado quando o registro falhou"
  FAILED=1
else
  echo "ok: falha do register — arquivo estável não foi criado (nada pra reusar)"
fi

# ── Caso 3: cd pro repo falha (path inexistente) — ainda fail-soft ──
: > "$NPX_CALL_LOG"
SID_FILE_3="$WORKDIR/session-id-3"
OUT3=$(PATH="$WORKDIR/bin:$PATH" \
  REPO_ROOT_OVERRIDE="$WORKDIR/nao-existe" \
  SESSION_ID_FILE_OVERRIDE="$SID_FILE_3" \
  SESSION_TS_OVERRIDE="20260924T130000Z" \
  "$SCRIPT" "outro-job")
RC3=$?

assert_eq "cd falha — exit code continua 0" "0" "$RC3"
assert_eq "cd falha — SESSION_ID ainda impresso" "hermes-cron-outro-job-20260924T130000Z" "$OUT3"
if [ -s "$NPX_CALL_LOG" ]; then
  echo "FAIL: cd falha — não devia ter chamado npx (repo inacessível)"
  FAILED=1
else
  echo "ok: cd falha — npx nunca foi chamado"
fi

# ── Caso 3b (#8740 review): arquivo já tem SESSION_ID de um tick ANTERIOR
#    e ESTE tick falha (register ou cd) — o arquivo velho não pode
#    sobreviver disfarçado de atual (reintroduziria o bug do #6443 por
#    falha silenciosa do wrapper, não por reuso de id fixo) ──
SID_FILE_3B="$WORKDIR/session-id-3b"
echo "hermes-cron-test-job-id-TICK-ANTIGO" > "$SID_FILE_3B"

echo 1 > "$NPX_RC_FILE"
: > "$NPX_CALL_LOG"
OUT3B=$(PATH="$WORKDIR/bin:$PATH" \
  REPO_ROOT_OVERRIDE="$WORKDIR/repo" \
  SESSION_ID_FILE_OVERRIDE="$SID_FILE_3B" \
  SESSION_TS_OVERRIDE="20260924T150000Z" \
  "$SCRIPT" "test-job-id")
RC3B=$?

assert_eq "arquivo com id antigo, tick atual falha — exit code continua 0" "0" "$RC3B"
assert_eq "arquivo com id antigo, tick atual falha — SESSION_ID NOVO impresso" "hermes-cron-test-job-id-20260924T150000Z" "$OUT3B"
if [ -f "$SID_FILE_3B" ]; then
  echo "FAIL: arquivo com id antigo, tick atual falha — o SESSION_ID do tick anterior deveria ter sido limpo (não sobrar disfarçado de atual)"
  FAILED=1
else
  echo "ok: arquivo com id antigo, tick atual falha — arquivo foi limpo, nada sobrevive disfarçado de atual"
fi

# ── Caso 4: default de JOB_ID (sem argumento nem env) ──
: > "$NPX_RC_FILE"; echo 0 > "$NPX_RC_FILE"
: > "$NPX_CALL_LOG"
SID_FILE_4="$WORKDIR/session-id-4"
OUT4=$(PATH="$WORKDIR/bin:$PATH" \
  REPO_ROOT_OVERRIDE="$WORKDIR/repo" \
  SESSION_ID_FILE_OVERRIDE="$SID_FILE_4" \
  SESSION_TS_OVERRIDE="20260924T140000Z" \
  "$SCRIPT")
assert_eq "default de JOB_ID — usa o job real do tick (5d791ef6fc2c)" "hermes-cron-5d791ef6fc2c-20260924T140000Z" "$OUT4"

if [ "$FAILED" -eq 1 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TODOS OS TESTES PASSARAM"
