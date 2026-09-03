#!/usr/bin/env bash
# watch-continuo-health.sh — observador DETERMINÍSTICO (zero LLM) da saúde da
# arquitetura contínuo v0.5.0 + review Opus diário. Roda 1x/dia via cron do
# Hermes (--no-agent). Cada checagem que degrada vira ISSUE no GitHub com
# P-label (regra do CLAUDE.md: nunca perguntar, criar com prioridade), com
# dedup contra issue aberta equivalente.
#
# Por que existe (28/08/2026, pedido do editor: "eu não vou lembrar de
# observar nada"): a v0.5.0 saiu com pendências de observação que dependiam
# de alguém olhar log — este script é o alguém. Checa:
#   1. review Opus diário rodou nas últimas 26h (marco fresco);
#   2. cron do contínuo sem failure_streak >= 2;
#   3. claims não voltaram a vazar (sessão continuo com claims e heartbeat
#      parado > 45min — tick é de 30min, higiene deveria limpar);
#   4. vazamento pago (hermes-model-cost-report --json, campo vazamento_pago);
#   8. gasto diario estimado (#6771) - REPORTA, nao alarma: a checagem 4 cobre
#      LEAK (modelo pago fora da allowlist), nunca VOLUME dentro dela;
#   (item 5 — adoção de prefixo de branch — CORTADO no #6798, 01/09/2026:
#    informational, 0 correções, dedup falhava e produziu issue duplicada 3x
#    antes do fix; sucessor mais preciso é `check-branch-issue-consistency.ts`.)
#
# Fail-soft por checagem: uma checagem quebrada reporta e segue pras demais;
# só o exit final agrega. Sem estado próprio além do GitHub (dedup por título).
set -uo pipefail

REPO="/home/vjpixel/diaria-studio"
cd "$REPO" || { echo "ERRO: repo ausente"; exit 1; }
FAILS=0

# Dedup: existe issue ABERTA cujo título CONTÉM o marcador?
# Filtro LOCAL de propósito (bug achado no teste ao vivo do PR #6469: a busca
# do GitHub tokeniza/ignora colchetes, então `"[watch-continuo] ..." in:title`
# retornava 0 SEMPRE e o dedup nunca deduplicou — 2 issues idênticas em 10min).
# Falha do gh aqui retorna 2 (indeterminado): quem chama trata como "não sei"
# e NÃO cria (na dúvida, não spammar; a próxima rodada tenta de novo).
have_issue() {
  local marker="$1"
  local titles
  titles=$(gh issue list --state open --limit 100 --json title --jq '.[].title' 2>/dev/null) || return 2
  # #6987/#6989 (01/09/2026): `command grep` — sem isso, um `grep` quebrado
  # (neste ambiente é função de shell que shella pro binário `claude`) sai
  # não-zero, INDISTINGUÍVEL de "marcador não encontrado" (rc=1 normal desta
  # chamada) — colapsaria "ferramenta quebrada" em "issue não existe ainda",
  # levando `file_issue` a criar uma possível duplicata por uma causa que não
  # tem nada a ver com o GitHub. `command grep` bypassa a função e vai direto
  # ao binário do sistema.
  printf '%s' "$titles" | command grep -qF "$marker"
}

file_issue() {
  local marker="$1" title="$2" label="$3" body="$4"
  have_issue "$marker"
  local rc=$?
  if [ $rc -eq 0 ]; then
    echo "[watch] $marker: issue aberta já existe — sem duplicar"
    return 0
  elif [ $rc -eq 2 ]; then
    echo "[watch] $marker: dedup INDETERMINADO (gh falhou) — não criando pra não duplicar" >&2
    FAILS=$((FAILS + 1))
    return 0
  fi
  if gh issue create --title "$title" --label "$label" --body "$body" >/dev/null 2>&1; then
    echo "[watch] $marker: ISSUE CRIADA"
  else
    echo "[watch] $marker: FALHA ao criar issue (gh indisponível?)" >&2
    FAILS=$((FAILS + 1))
  fi
}

# ── 1. Review Opus diário rodou? ─────────────────────────────────────────────
MARCO="$REPO/data/continuo/last-daily-review-sha"
if [ -f "$MARCO" ]; then
  MTIME=$(stat -c %Y "$MARCO" 2>/dev/null || echo "")
  if [ -z "$MTIME" ]; then
    # arquivo sumiu entre o -f e o stat (sync OneDrive) — indeterminado, nunca "ok"
    echo "[watch] review diário: INDETERMINADO (stat falhou)" >&2; FAILS=$((FAILS+1)); MTIME=0
  fi
  AGE_H=$(( ( $(date +%s) - MTIME ) / 3600 ))
  if [ "$MTIME" -eq 0 ]; then AGE_H=-1; fi
  if [ "$AGE_H" -ge 0 ] && [ "$AGE_H" -gt 26 ]; then
    file_issue "[watch-continuo] review Opus diário não roda" \
      "[watch-continuo] review Opus diário não roda há ${AGE_H}h — marco estagnado" \
      "bug,P2" \
      "Detectado por hermes/scripts/watch-continuo-health.sh: \`data/continuo/last-daily-review-sha\` sem escrita há ${AGE_H}h (esperado: avanço diário ~12:00 UTC, cron 645d5debb7f0). Checar: \`hermes cron list\`, transcript em \`data/continuo/last-daily-review-output.txt\`, e se o gate RESUMO-DAILY-REVIEW segurou o marco de propósito (nesse caso o problema é o review incompleto, não o cron). P2: a auditoria Opus é a rede de qualidade dos merges autônomos."
  else
    echo "[watch] review diário ok (${AGE_H}h)"
  fi
else
  echo "[watch] marco do review ainda não existe (1ª execução pendente) — sem issue"
fi

# ── 2. failure_streak do contínuo ────────────────────────────────────────────
# Sentinela __ERR__ (finding P1 do review #6469): "não consegui checar" tem
# de ser distinguível de "ok" — a versão anterior colapsava os dois em string
# vazia e um jobs.json corrompido viraria "streak ok" pra sempre.
STREAK=$(python3 -c "
try:
    import json
    found='__ERR__'
    for x in json.load(open('/home/vjpixel/.hermes/cron/jobs.json'))['jobs']:
        if x['id']=='5d791ef6fc2c': found=x.get('failure_streak',0); break
    print(found)
except Exception: print('__ERR__')" 2>/dev/null || echo "__ERR__")
if [ "$STREAK" = "__ERR__" ] || [ -z "$STREAK" ]; then
  echo "[watch] streak: INDETERMINADO (jobs.json ilegível ou job ausente)" >&2; FAILS=$((FAILS+1))
elif [ "$STREAK" -ge 2 ] 2>/dev/null; then
  file_issue "[watch-continuo] Diária Contínuo com failure_streak" \
    "[watch-continuo] Diária Contínuo com failure_streak=$STREAK" \
    "bug,P1" \
    "Detectado por watch-continuo-health.sh: job 5d791ef6fc2c com failure_streak=$STREAK. Ver \`~/.hermes/logs/agent.log\` e \`last_error\` no jobs.json. P1: fila de produção parada sem workaround automático (o watchdog de rotação só troca o modelo do ORQUESTRADOR)."
else
  echo "[watch] streak do continuo ok (${STREAK:-indisponível})"
fi

# ── 3. claims vazando de novo? ───────────────────────────────────────────────
LEAK=$(npx tsx scripts/lib/session-registry.ts active-of-kind --kind continuo 2>/dev/null | python3 -c "
import sys, json, datetime as dt
try:
    d = json.load(sys.stdin)
    now = dt.datetime.now(dt.timezone.utc)
    for s in d.get('sessions', []):
        claims = s.get('claimed_issues') or []
        hb = s.get('lastHeartbeat')
        if not claims or not hb: continue
        age_min = (now - dt.datetime.fromisoformat(hb.replace('Z', '+00:00'))).total_seconds() / 60
        if age_min > 45:
            print(f\"{s['sessionId']}: claims={claims} heartbeat parado há {age_min:.0f}min\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
if [ "$LEAK" = "__ERR__" ]; then
  echo "[watch] claims: INDETERMINADO (registry/parse falhou)" >&2; FAILS=$((FAILS+1)); LEAK=""
fi
if [ -n "$LEAK" ]; then
  file_issue "[watch-continuo] claims do contínuo presos" \
    "[watch-continuo] claims do contínuo presos de novo (higiene de fim de tick falhou)" \
    "bug,P2" \
    "Detectado por watch-continuo-health.sh — sessão continuo com claims e heartbeat parado > 45min (tick é de 30min; a higiene da SKILL.md v0.5.0 deveria limpar):

\`\`\`
$LEAK
\`\`\`

Mesma classe do incidente 28/08 (7 issues presas invisíveis pro develop). Workaround: \`session-registry.ts end --kind continuo --session-id <id>\`. Fix estrutural pendente: #6443 (TTL mecânico de claim)."
else
  echo "[watch] claims ok"
fi

# ── 4. vazamento pago ────────────────────────────────────────────────────────
VAZ=$(python3 /home/vjpixel/.hermes/scripts/hermes-model-cost-report.py --days 1 --json 2>/dev/null | python3 -c "
import sys, json
try:
    rows = json.load(sys.stdin)
    for r in rows:
        if isinstance(r, dict) and r.get('vazamento_pago'):
            # #6880: 'pedido' foi removido (artefato de JOIN com
            # sessions.model, fabricava substituicoes que nunca
            # aconteceram — foi isso que abriu o #6708 como falso P1).
            print(f\"{r['dia']} {r['modelo']} est=\${r['custo_estimado']}\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
if [ "$VAZ" = "__ERR__" ]; then
  echo "[watch] custo: INDETERMINADO (cost-report falhou)" >&2; FAILS=$((FAILS+1)); VAZ=""
fi
if [ -n "$VAZ" ]; then
  file_issue "[watch-continuo] cobrança em modelo pago" \
    "[watch-continuo] cobrança em modelo pago fora da allowlist nas últimas 24h" \
    "bug,P1" \
    "Detectado por watch-continuo-health.sh via hermes-model-cost-report.py:

\`\`\`
$VAZ
\`\`\`

Mesma classe do incidente 27/08 (USD 0,459 em z-ai/glm-5.2 sem :free via substituição de modelo). Checar overrides de sessão persistidos (\`~/.hermes/sessions/sessions.json\`) e a cadeia em config.yaml. P1: dinheiro saindo em silêncio — o teto diário da chave limita, mas não zera."
else
  echo "[watch] custo ok (sem vazamento pago em 24h)"
fi

# ── item 5 REMOVIDO (#6798, 01/09/2026) ─────────────────────────────────────
# "adoção da convenção de branch" (`[watch-continuo] PRs sem prefixo de
# trilha`) cortado pela auditoria da camada de alarmes: informational por
# desenho, 0 correções, e o dedup falhava — a MESMA condição virou 3 issues
# distintas (#6468, #6470, #6709) antes do fix de dedup do #6771 já ter
# saído, e mesmo depois do fix o check nunca gerou uma correção real. O
# sucessor mais preciso já existe e cobre o caso que importava (branch↔commit
# desalinhados, não só prefixo ausente): `check-branch-issue-consistency.ts`
# (#6804, `scripts/lib/branch-issue-consistency.ts`), rodado por PR, não por
# varredura diária pós-fato. `hermes/scripts/lib/continuo-branch-prefix.sh`
# (único consumidor deste check) foi removido junto.

# ── 6. composição de modelo por tick (degradação silenciosa, #6912) ─────────
# Diferente das checagens 1-5 (que só criam issue se degradar), esta SEMPRE
# ecoa a composição no resumo diário — a issue #6912 pede explicitamente
# uma linha de base ANTES de calibrar qualquer limiar de alarme (por isso
# nenhum threshold de "% aceitável de fallback" existe ainda; a mera
# PRESENÇA de uma chamada no fallback local já prova que o primário falhou
# naquele tick, então o gate de issue não precisa de limiar pra ser real).
TICKCOMP=$(python3 /home/vjpixel/.hermes/scripts/hermes-model-cost-report.py --tick-composition --days 1 --json 2>/dev/null)
if [ -z "$TICKCOMP" ]; then
  echo "[watch] composição de tick: INDETERMINADO (cost-report --tick-composition falhou)" >&2
  FAILS=$((FAILS + 1))
else
  echo "[watch] composição de tick (últimas 24h):"
  echo "$TICKCOMP" | python3 -c "
import sys, json
try:
    ticks = json.load(sys.stdin)
    if not ticks:
        print('  nenhum tick do continuo nas últimas 24h')
    for t in ticks:
        flag = '  <-- DEGRADADO' if t.get('degraded') else ''
        print(f\"  {t['dia']} {t['session_id']}  primario={t['primary_pct']}%  local={t['local_fallback_pct']}%  pago={t['paid_fallback_pct']}%{flag}\")
except Exception:
    print('  __ERR__ (json malformado)')
"
  DEGRADED=$(printf '%s' "$TICKCOMP" | python3 -c "
import sys, json
try:
    ticks = json.load(sys.stdin)
    bad = [t for t in ticks if t.get('degraded')]
    for t in bad:
        print(f\"{t['dia']} {t['session_id']} local={t['local_fallback_pct']}%\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
  # #6963: janela com ZERO ticks NUNCA pode ser lida como "ok". Antes deste
  # guard, lista vazia por detector quebrado e lista vazia por "tudo
  # saudável" produziam a MESMA linha verde — e foi exatamente assim que o
  # detector do #6912 passou meses sem poder disparar (o `LIKE` casava zero
  # linhas) enquanto o relatório diário afirmava "sem degradação". Um
  # detector de falha silenciosa que falha em silêncio é pior que não ter
  # detector: ele consome a atenção que existiria pra vigiar de outro jeito.
  #
  # Zero ticks é INDETERMINADO, não saudável: pode ser job pausado de
  # propósito (legítimo, e aí a linha indeterminada é ruído aceitável de 1
  # linha/dia) ou o contínuo morto/o detector cego (o caso que importa). As
  # duas coisas precisam de olho humano; nenhuma delas é "ok".
  TICKCOUNT=$(printf '%s' "$TICKCOMP" | python3 -c "
import sys, json
try:
    print(len(json.load(sys.stdin)))
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")

  if [ "$DEGRADED" = "__ERR__" ]; then
    echo "[watch] composição de tick: parse do resultado falhou" >&2; FAILS=$((FAILS + 1))
  elif [ "$TICKCOUNT" = "0" ]; then
    echo "[watch] composição de tick: INDETERMINADO — ZERO ticks do contínuo na janela (#6963). Não é 'ok': ou o job está pausado de propósito, ou o contínuo parou, ou o detector voltou a ficar cego. Conferir com 'hermes cron list --all' e com o formato de session_id em session_model_usage." >&2
    FAILS=$((FAILS + 1))
  elif [ -n "$DEGRADED" ]; then
    file_issue "[watch-continuo] degradação de modelo por tick" \
      "[watch-continuo] degradação de modelo por tick — caiu no fallback local nas últimas 24h" \
      "bug,P2" \
      "Detectado por watch-continuo-health.sh via hermes-model-cost-report.py --tick-composition — tick(s) com chamadas no fallback local (qwen), sinal de que o modelo primário (CONTINUO_PRIMARY_MODEL_IDS, hardcoded em hermes-model-cost-report.py) falhou naquele tick:

\`\`\`
$DEGRADED
\`\`\`

Sem limiar de alarme calibrado ainda (#6912 pede baseline medida antes de decidir o que é aceitável) — esta issue É a coleta da baseline. P2: sintoma 'agente burro hoje' sem custo pago associado (diferente da checagem 4, que é vazamento pago)."
  else
    echo "[watch] composição de tick ok (sem degradação nas últimas 24h)"
  fi
fi

# ── 7. laços de espera de CI órfãos (#6921) ─────────────────────────────────
# Achado ao vivo: 5 laços `while true; do gh pr checks ...; sleep N; done`
# escritos à mão por sessões de agente ficaram rodando por até 15h depois
# da sessão que os criou já ter ido embora, todos vigiando PRs já
# mergeadas. Observa e reporta, NUNCA mata (mesmo princípio do #6771) —
# o fix estrutural é `scripts/lib/wait-pr-checks.sh` (teto de vida
# embutido); esta checagem é a rede de segurança pro que ainda for escrito
# à mão sem usar o helper.
ORPHANS=$(pgrep -af 'gh pr checks' 2>/dev/null)
PGREP_RC=$?
# #6937 (review): pgrep exit 1 = "nenhum processo casou" (esperado, não é
# falha); exit 2/3+ = erro genuíno (padrão inválido, /proc ilegível) —
# mesma disciplina de "indeterminado incrementa FAILS" que as checagens
# 1-6 deste arquivo já seguem. Sem essa distinção, um pgrep quebrado
# reportaria "nenhum órfão" em vez de "não consegui checar".
if [ "$PGREP_RC" -eq 1 ]; then
  echo "[watch] laços de espera de CI: nenhum encontrado (pgrep sem match — ok)"
  ORPHANS=""
elif [ "$PGREP_RC" -ne 0 ]; then
  echo "[watch] laços de espera de CI: INDETERMINADO (pgrep saiu com rc=$PGREP_RC)" >&2
  FAILS=$((FAILS + 1))
  ORPHANS=""
fi
OLD_ORPHANS=""
if [ -n "$ORPHANS" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    PID=$(echo "$line" | awk '{print $1}')
    ETIME=$(ps -o etimes= -p "$PID" 2>/dev/null | tr -d ' ')
    if [ -n "$ETIME" ] && [ "$ETIME" -gt 3600 ] 2>/dev/null; then
      OLD_ORPHANS="${OLD_ORPHANS}pid=$PID idade=$((ETIME / 60))min: $line"$'\n'
    fi
  done <<< "$ORPHANS"
fi
if [ -n "$OLD_ORPHANS" ]; then
  file_issue "[watch-continuo] laço de espera de CI órfão" \
    "[watch-continuo] laço de espera de CI órfão — rodando há mais de 1h" \
    "bug,P2" \
    "Detectado por watch-continuo-health.sh via \`pgrep -af 'gh pr checks'\` + idade (\`ps -o etimes=\`) — processo(s) com mais de 1h vigiando checks de PR:

\`\`\`
$OLD_ORPHANS
\`\`\`

Confirmar se a(s) PR(s) já foram mergeadas/fechadas (nesse caso, seguro matar o PID) antes de agir — este watchdog NUNCA mata sozinho, só observa e reporta (#6771). Fix estrutural: usar \`scripts/lib/wait-pr-checks.sh\` (teto de vida embutido, #6921) em vez de um laço escrito à mão."
else
  echo "[watch] laços de espera de CI: nenhum com mais de 1h"
fi

# ── 8. gasto diário estimado (#6771 ação 4) ─────────────────────────────────
# A morte do job `95f1990895ab` (monitor de preços/gastos OpenRouter, morto
# desde 24/08 e sem sucessor) deixou GASTO sem nenhuma vigilância. A checagem
# 4 acima NÃO cobre isso: ela lê `vazamento_pago`, um booleano de LEAK (modelo
# pago fora da allowlist) — um dia inteiramente dentro da allowlist e 10x mais
# caro que o normal passa por ela como saudável.
#
# **Sem limiar, de propósito (instrução explícita do #6771).** Esta checagem
# REPORTA o número e nunca alarma; a issue pede baseline medida antes de
# calibrar, mesma disciplina do #6755. Baseline coletada em 03/09/2026 (7 dias,
# custo estimado/dia, Hermes inteiro): 27/08 $0,00 - 28/08 $1,55 - 29/08 $0,32
# - 30/08 a 03/09 $0,00. O pico de 28/08 e o pior caso conhecido (pago como
# primario + ticks de 30min, ambos ja revertidos); os zeros recentes sao
# coerentes com o job do continuo pausado desde 03/09 04:33 BRT.
#
# Duas ressalvas medidas, ambas refletidas no texto impresso:
#   - `custo_real` vem 0 em TODAS as linhas do relatorio (confirmado nos 7 dias
#     acima) - o que existe e `custo_estimado`. Nunca afirmar faturamento.
#   - O relatorio agrega o **Hermes inteiro**, nao so o continuo: sessao
#     interativa do editor entra no mesmo numero. Declarado em vez de filtrado
#     (filtrar exigiria distinguir sessao de cron, que o relatorio nao expoe).
#
# NAO usa `file_issue` justamente por nao ter limiar: sem criterio de alarme
# calibrado, abrir issue seria ruido diario. Vira linha de log, que e o que a
# issue pede pra coletar a serie.
GASTO=$(python3 /home/vjpixel/.hermes/scripts/hermes-model-cost-report.py --days 1 --json 2>/dev/null | python3 -c "
import sys, json
try:
    rows = json.load(sys.stdin)
    print(f\"{sum(float(r.get('custo_estimado') or 0) for r in rows if isinstance(r, dict)):.4f}\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
if [ "$GASTO" = "__ERR__" ] || [ -z "$GASTO" ]; then
  # Mesma disciplina das checagens 1-7: indeterminado incrementa FAILS em vez
  # de reportar "$0,00", que seria indistinguivel de um dia genuinamente barato.
  echo "[watch] gasto diario: INDETERMINADO (cost-report falhou)" >&2
  FAILS=$((FAILS + 1))
else
  echo "[watch] gasto diario estimado (Hermes inteiro, 24h): \$$GASTO - sem limiar calibrado (#6771), so registro"
fi

echo "[watch] varredura concluída (checagens indeterminadas/falhas de infra: $FAILS)"
# Exit honesto (finding P2 do review #6469): FAILS>0 = o observador NÃO pôde
# garantir a varredura — o cron do Hermes registra a falha e o failure_streak
# do próprio job de watch vira o alarme de quem vigia o vigilante.
[ "$FAILS" -eq 0 ] || exit 1
exit 0
