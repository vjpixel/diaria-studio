#!/usr/bin/env bash
# Fase 3 — tick stubbado: repo, `gh` e guards REAIS; delegação e escrita falsas.
#
# Mede o LAÇO do coordenador (claim, higiene, relatório persistido), que é
# onde falha de interação entre passos aparece — a Fase 2 não pega isso.
#
# ATENÇÃO, e o motivo de `restore-safe.sh` existir: a 1ª versão trocava
# `~/.hermes/scripts/claude-openrouter.sh` com `cp` e restaurava com `cp`. O
# original era SYMLINK para o repo; o `cp` destruiu o link e deixou arquivo
# comum. O wrapper faz `source ./lib/…` relativo à própria localização, e
# `lib/` só existe no repo — então ele passou a morrer no `source`, em
# PRODUÇÃO, até o tick seguinte contornar sozinho. Restauração de infra
# recria o TIPO, não só o conteúdo.
set -u
HB=/home/vjpixel/hermes-agent/.venv/bin/hermes
REPO=/home/vjpixel/diaria-studio
STUB=/home/vjpixel/model-bench/stub-bin
BK=/home/vjpixel/model-bench/fase3-backup
SAFE="$(dirname "$0")/restore-safe.sh"
REAL=/home/vjpixel/.hermes/scripts/claude-openrouter.sh
export STUB_TICK_LOG=/home/vjpixel/model-bench/fase3-gh.log
: > "$STUB_TICK_LOG"

mkdir -p "$STUB" "$BK"
cp "$(dirname "$0")/gh" "$STUB/gh" && chmod +x "$STUB/gh"
cat > "$STUB/claude-openrouter-stub.sh" <<'STUBEOF'
#!/usr/bin/env bash
cat > /dev/null
echo "Implementei a issue. Branch continuo/fix-STUB-exemplo criada, testes"
echo "rodados, PR aberta referenciando a issue. Não mergeei."
exit 0
STUBEOF
chmod +x "$STUB/claude-openrouter-stub.sh"

restaurar_tudo() {
  bash "$SAFE" restaurar "$REAL" "$BK" || echo "AVISO: wrapper NÃO restaurado" >&2
  git -C "$REPO" checkout -- hermes/scripts/claude-openrouter.sh 2>/dev/null
  "$HB" cron resume 5d791ef6fc2c >/dev/null 2>&1
  "$HB" cron resume 3330b108a5b2 >/dev/null 2>&1
  echo "AMBIENTE RESTAURADO (wrapper com o TIPO original, repo, crons)"
}
trap restaurar_tudo EXIT INT TERM

"$HB" cron pause 5d791ef6fc2c >/dev/null 2>&1
"$HB" cron pause 3330b108a5b2 >/dev/null 2>&1

bash "$SAFE" guardar "$REAL" "$BK"
bash "$SAFE" trocar  "$REAL" "$STUB/claude-openrouter-stub.sh"

echo "=== tick com o modelo LOCAL como coordenador ==="
T0=$(date +%s)
PATH="$STUB:$PATH" timeout 1800 "$HB" -z "Execute um ciclo da skill hermes-diaria-continuo no repositório $REPO. Runtime contínuo ativo: implemente imediatamente todo trabalho elegível, respeitando CLAUDE.md e os guards da skill. Ao final, escreva o relatório do tick." \
  --skills hermes-diaria-continuo -m "${MODELO:-qwen-64k:latest}" --provider "${PROVIDER:-custom}" \
  --in "$REPO" --yolo 2>&1 | tail -40
echo "duracao_s=$(( $(date +%s) - T0 ))"

echo "=== VERIFICACAO DO LACO ==="
echo "relatorio_existe=$([ -f "$REPO/data/continuo/last-tick-report.md" ] && echo SIM || echo NAO)"
echo "escritas_bloqueadas=$(grep -c BLOQUEADO "$STUB_TICK_LOG" 2>/dev/null || echo 0)"
echo "leituras=$(grep -c passou "$STUB_TICK_LOG" 2>/dev/null || echo 0)"
echo "### FIM-FASE3"
