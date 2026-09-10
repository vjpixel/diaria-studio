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
#   10. truncagem silenciosa do modelo local (#7528) — media por chamada do
#      state.db vs ceiling do config.yaml. TRUNCANDO -> alarme P1; NA BORDA ->
#      log apenas (aviso). 2+ sessoes no valor suspeito (~32770) ou 1+ colapso
#      produtivo (calls >= 3, avg < 50% do teto) disparam o alarme.
#   11. fabricação de conclusão pelo coordenador do contínuo (#7537) — o
#      modelo relata ter escrito o relatório do tick/classificado N issues
#      sem ter feito nada disso. Compara `data/continuo/last-tick-report.md`
#      (existe + mtime dentro da janela do tick) e alegações de claim/contagem
#      no próprio relatório contra `gh issue list` e `data/sessions/continuo-*.json`.
#   12. aumento de preço em modelo pago já em uso na OpenRouter (#6818 item
#      4) — a checagem 4 acima só pergunta "está na allowlist?"; um modelo
#      que ESTÁ na allowlist nunca é sinalizado, a qualquer preço, e foi
#      assim que o degrau de 09/09 do glm-5.3-flash quase passou batido.
#      `hermes-model-cost-report.py --price-check` compara o catálogo
#      público da OpenRouter contra PAID_PRICE_BASELINE; indeterminado
#      (catálogo inacessível/campo sumiu) NUNCA vira "ok", só alarme ou
#      indeterminado.
#   (item 5 — adoção de prefixo de branch — CORTADO no #6798, 01/09/2026:
#    informational, 0 correções, dedup falhava e produziu issue duplicada 3x
#    antes do fix; sucessor mais preciso é `check-branch-issue-consistency.ts`.)
#   0 (captura, não alarme, #7814): antes de qualquer checagem, extrai
#      sidecars enxuto de `~/.hermes/logs/agent.log*` (chamadas de
#      ferramenta + session_id, nunca o transcript inteiro) pra
#      `data/continuo/tick-sidecars/` via
#      `scripts/continuo-capture-tick-sidecars.ts` — o log de origem
#      rotaciona por tamanho sem política declarada e já perdeu a evidência
#      de uma ocorrência da checagem 11 antes de alguém investigar (#7641).
#      Roda ANTES das checagens (inclusive antes de qualquer `exit`
#      antecipado de infra) pra maximizar a chance de captura mesmo se o
#      resto do script falhar depois.
#   13. registro de sessão do contínuo ausente (#7890) — o passo "session-
#      registry.ts register --kind continuo" do tick (SKILL.md passo 1.3) é
#      hoje PROSA, sem verificação externa de que rodou. Se o tick falhar
#      cedo (ex: falha de credencial), o registro nunca acontece — foi
#      exatamente esse gap que fez o detector de fabricação (checagem 11)
#      correlacionar a sessão ERRADA no #7641. Correlaciona a janela de
#      tempo de cada sidecar de tick recente (checagem 0, #7814) contra as
#      janelas `[startedAt, lastHeartbeat]` de `data/sessions/continuo-*.json`
#      — tick sem NENHUMA sessão continuo cuja janela se sobreponha vira
#      alarme. `scripts/check-continuo-session-registration.ts`.
#
# Fail-soft por checagem: uma checagem quebrada reporta e segue pras demais;
# só o exit final agrega. Sem estado próprio além do GitHub (dedup por título).
set -uo pipefail

REPO="/home/vjpixel/diaria-studio"
cd "$REPO" || { echo "ERRO: repo ausente"; exit 1; }
FAILS=0

# ── 0. Captura de sidecars de tick (#7814) ───────────────────────────────────
# Só LÊ ~/.hermes/logs/, só ESCREVE em data/continuo/tick-sidecars/ (não em
# ~/.hermes/). Roda primeiro e nunca aborta o script — falha aqui é
# indeterminado (perda de evidência potencial), não um alarme por si só;
# quem consome a AUSÊNCIA de sidecar continua sendo um humano investigando a
# checagem 11 abaixo, exatamente como hoje.
if npx tsx scripts/continuo-capture-tick-sidecars.ts --json >/tmp/continuo-sidecar-capture.json 2>/tmp/continuo-sidecar-capture.err; then
  echo "[watch] sidecars de tick: $(cat /tmp/continuo-sidecar-capture.json)"
else
  echo "[watch] sidecars de tick: FALHA na captura ($(tail -1 /tmp/continuo-sidecar-capture.err 2>/dev/null))" >&2
  FAILS=$((FAILS + 1))
fi

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
case "$STREAK" in *__ERR__*) STREAK="__ERR__" ;; esac
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
case "$LEAK" in *__ERR__*) LEAK="__ERR__" ;; esac
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
# #6771 (review do PR #7330): comparação por IGUALDADE não bastava. Com
# `pipefail` e sem `-e`, um `A | B` onde A falha (cost-report ausente)
# reporta o rc de A mesmo com B tendo capturado a exceção e impresso
# `__ERR__` sozinho — então o `|| echo "__ERR__"` externo dispara TAMBÉM e
# `$VAZ` vira "__ERR__\n__ERR__". Isso não casava com a igualdade, caía no
# ramo `-n` e abria uma issue P1 de "cobrança em modelo pago" com corpo
# lixo — alarme FALSO sobre dinheiro, a partir de uma falha de infra.
# Reproduzido ao vivo. `case` com glob cobre as duas formas.
case "$VAZ" in *__ERR__*) VAZ="__ERR__" ;; esac
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

  case "$DEGRADED" in *__ERR__*) DEGRADED="__ERR__" ;; esac

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
# Mesmo normalizador da checagem 4 (ver o porquê lá): sem ele, falha do
# cost-report produzia "__ERR__\n__ERR__", que escapava das duas comparações
# e imprimia uma linha de log com lixo SEM incrementar FAILS — exatamente o
# contrário do que o comentário acima promete.
case "$GASTO" in *__ERR__*) GASTO="__ERR__" ;; esac
if [ "$GASTO" = "__ERR__" ] || [ -z "$GASTO" ]; then
  # Mesma disciplina das checagens 1-7: indeterminado incrementa FAILS em vez
  # de reportar "$0,00", que seria indistinguivel de um dia genuinamente barato.
  echo "[watch] gasto diario: INDETERMINADO (cost-report falhou)" >&2
  FAILS=$((FAILS + 1))
else
  echo "[watch] gasto diario estimado (Hermes inteiro, 24h): \$$GASTO - sem limiar calibrado (#6771), so registro"
fi

# ── 9. fila de PRs abertas sem merge (#7446 item 6) ─────────────────────────
# Medido ao vivo (04-05/09/2026): 8 PRs abertas simultaneamente, 3 delas
# `continuo/rescue-*` verdes/mergeáveis paradas até 21h, e NENHUMA checagem
# 1-8 acima olha pra fila de PRs em si — o observador tinha um ponto cego
# exatamente onde o problema apareceu. Limiar duplo (conta OU idade da mais
# velha) porque os dois modos de falha são distintos: muitas PRs pequenas
# acumulando (merger não dá conta do volume) vs. 1 PR presa há muito tempo
# (merger não decide aquele caso — CI vermelho sem fixer, escalate sem dono).
#
# #7832 (09/09/2026): a issue #7807 confirmou que o alarme acima estava
# certo (9 abertas, mais velha há 9.8h) mas o corpo mandava investigar o
# gate de merge — em 09/09 as 9 estavam vermelhas por 8 causas MECÂNICAS
# independentes (teto de SKILL.md, vitest em 3 PRs, lockfile fora de sync,
# TS2345, removal-declaration faltando, conflito com master), não por falta
# de merger. `pr_first_failed_check` adiciona, por PR, o primeiro check que
# falhou (`gh pr view <N> --json statusCheckRollup`) — separa de imediato PR
# VERDE esperando merger (problema de gate/coordenação) de PR VERMELHA
# (problema de conteúdo, o gate está certo em não decidir). Fail-soft por
# PR: `gh pr view` falhando numa PR vira "(status indisponível)" só naquela
# linha — nunca derruba o alarme inteiro (mesma disciplina do `checked: -1`
# do §3b). Só chamado quando o alarme já vai disparar (dentro do `if` de
# limiar abaixo) — no máximo ~10 chamadas extras por alarme dado o limiar de
# contagem, bem abaixo de qualquer rate limit do `gh`.
pr_first_failed_check() {
  local prnum="$1"
  local json
  json=$(gh pr view "$prnum" --json statusCheckRollup 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$json" ]; then
    echo "#$prnum  (status indisponível)"
    return
  fi
  printf '%s' "$json" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    checks = data.get('statusCheckRollup') or []
    failing = []
    for c in checks:
        state = (c.get('conclusion') if c.get('__typename') == 'CheckRun' else c.get('state')) or ''
        if state.upper() in ('FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'):
            wf = c.get('workflowName') or ''
            name = c.get('name') or c.get('context') or '?'
            failing.append(f'{wf} — {name}' if wf else name)
    if not failing:
        print('#$prnum  (verde, só esperando merger)')
    else:
        extra = f'   [+{len(failing) - 1} outros]' if len(failing) > 1 else ''
        print(f'#$prnum  {failing[0]}{extra}')
except Exception:
    print('#$prnum  (status indisponível)')
"
}
QUEUE_COUNT_THRESHOLD=5
QUEUE_AGE_H_THRESHOLD=12
QUEUE_JSON=$(gh pr list --state open --json number,headRefName,createdAt 2>/dev/null)
QUEUE_GH_RC=$?
if [ "$QUEUE_GH_RC" -ne 0 ] || [ -z "$QUEUE_JSON" ]; then
  echo "[watch] fila de PRs: INDETERMINADO (gh pr list falhou)" >&2
  FAILS=$((FAILS + 1))
else
  QUEUE_SUMMARY=$(printf '%s' "$QUEUE_JSON" | python3 -c "
import sys, json, datetime as dt
try:
    prs = json.load(sys.stdin)
    now = dt.datetime.now(dt.timezone.utc)
    count = len(prs)
    oldest_h = 0.0
    oldest_pr = None
    for pr in prs:
        created = dt.datetime.fromisoformat(pr['createdAt'].replace('Z', '+00:00'))
        age_h = (now - created).total_seconds() / 3600
        if age_h > oldest_h:
            oldest_h = age_h
            oldest_pr = pr
    print(f\"{count}\t{oldest_h:.1f}\t{oldest_pr['number'] if oldest_pr else ''}\t{oldest_pr['headRefName'] if oldest_pr else ''}\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
  case "$QUEUE_SUMMARY" in *__ERR__*) QUEUE_SUMMARY="__ERR__" ;; esac
  if [ "$QUEUE_SUMMARY" = "__ERR__" ] || [ -z "$QUEUE_SUMMARY" ]; then
    echo "[watch] fila de PRs: INDETERMINADO (parse falhou)" >&2
    FAILS=$((FAILS + 1))
  else
    IFS=$'\t' read -r QUEUE_COUNT QUEUE_OLDEST_H QUEUE_OLDEST_PR QUEUE_OLDEST_BRANCH <<< "$QUEUE_SUMMARY"
    QUEUE_OLDEST_H_INT=${QUEUE_OLDEST_H%.*}
    if [ "$QUEUE_COUNT" -ge "$QUEUE_COUNT_THRESHOLD" ] || [ "$QUEUE_OLDEST_H_INT" -ge "$QUEUE_AGE_H_THRESHOLD" ] 2>/dev/null; then
      QUEUE_NUMBERS=$(printf '%s' "$QUEUE_JSON" | python3 -c "
import sys, json
try:
    for pr in json.load(sys.stdin):
        print(pr['number'])
except Exception:
    pass")
      QUEUE_CHECK_LINES=""
      while IFS= read -r QN; do
        [ -z "$QN" ] && continue
        QUEUE_CHECK_LINES="${QUEUE_CHECK_LINES}$(pr_first_failed_check "$QN")"$'\n'
      done <<< "$QUEUE_NUMBERS"
      file_issue "[watch-continuo] fila de PRs sem merge" \
        "[watch-continuo] fila de PRs sem merge: $QUEUE_COUNT abertas, mais velha há ${QUEUE_OLDEST_H}h" \
        "bug,P1" \
        "Detectado por watch-continuo-health.sh via \`gh pr list --state open\` — $QUEUE_COUNT PRs abertas (limiar: $QUEUE_COUNT_THRESHOLD), PR mais velha #$QUEUE_OLDEST_PR (\`$QUEUE_OLDEST_BRANCH\`) parada há ${QUEUE_OLDEST_H}h (limiar: ${QUEUE_AGE_H_THRESHOLD}h).

Primeiro check que falhou por PR (\`gh pr view <N> --json statusCheckRollup\`, #7832):

\`\`\`
${QUEUE_CHECK_LINES}\`\`\`

Mesma classe do incidente 04-05/09/2026 (#7446): 8 PRs abertas, nenhuma avançando sozinha — reject sem estado terminal, escalate sem dono com agendador, CI vermelho em PR \`continuo/*\` sem fixer, branch fora de \`continuo/*\` sem merger. Checar \`gh pr list --state open\` e, por PR, por que o gate não decidiu (\`gh pr view <N> --json comments\` pro histórico de \`continuo-pr-review.sh\`, \`gh pr checks <N>\` pro CI)."
    else
      echo "[watch] fila de PRs ok ($QUEUE_COUNT abertas, mais velha há ${QUEUE_OLDEST_H}h)"
    fi
  fi
fi

# ── 10. truncagem silenciosa do modelo local (#7528) ──────────────────────────
# Ollama trunca silenciosamente (HTTP 200, sem sinal) quando o prompt excede a
# janela real do modelo. O valor truncado fica registrado em
# `session_model_usage.input_tokens` no state.db (~/.hermes/state.db) — mas é
# cumulativo por sessao, entao o detector divide por `api_call_count` para obter
# a media por chamada e compara contra o ceiling do config.yaml
# (model.context_length). Dois patamares:
#   - TRUNCANDO (alarme, P1): media colapsou bem abaixo do teto, ou bate
#     repetidamente no valor suspeito (~32770 = truncagem do Ollama).
#   - NA BORDA (aviso, log apenas): ocupacao >85% da janela sem truncar ainda.
#
# #7528: este check NAO depende de scripts/model-bench/probe.py (PR nao mergeada).
# O ceiling vem do config.yaml (model.context_length, medido por sondagem) com
# fallback no num_ctx do Modelfile via Ollama API.
TRUNC_JSON=$(python3 /home/vjpixel/diaria-studio/hermes/scripts/detect-context-truncation.py --days 1 --json 2>/dev/null)
TRUNC_PARSE=$(printf '%s' "$TRUNC_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['status'])
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
case "$TRUNC_PARSE" in *__ERR__*) TRUNC_PARSE="__ERR__" ;; esac
if [ "$TRUNC_PARSE" = "__ERR__" ]; then
  echo "[watch] truncagem: INDETERMINADO (detect-context-truncation falhou)" >&2
  FAILS=$((FAILS + 1))
elif [ "$TRUNC_PARSE" = "indeterminado" ]; then
  echo "[watch] truncagem: INDETERMINADO (nao foi possivel resolver context_length do config.yaml nem Ollama API — #7528 fail-closed)" >&2
  FAILS=$((FAILS + 1))
elif [ "$TRUNC_PARSE" = "truncating" ]; then
  TRUNC_SESSIONS=$(printf '%s' "$TRUNC_JSON" | python3 -c "
import sys, json, datetime as dt
try:
    d = json.load(sys.stdin)
    now = dt.datetime.now(dt.timezone.utc)
    for s in d.get('truncating_sessions', []):
        first = ''
        if s.get('first_seen'):
            first = dt.datetime.fromtimestamp(s['first_seen'], tz=dt.timezone.utc).strftime('%Y-%m-%d %H:%M')
        print(f\"  sessao={s['session_id'][:35]} avg={s['avg_per_call']} calls={s['api_call_count']} ({s['pct_of_ceiling']}% de {d['ceiling']}) signal={s['signal']} first_seen={first}\")
    print(f\"  ceiling={d['ceiling']} truncation_value={d['truncation_value']} edge_threshold={d['edge_threshold']}\")
    print(f\"  details: {d['details']}\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
  file_issue "[watch-continuo] truncagem silenciosa do modelo local" \
    "[watch-continuo] truncagem silenciosa do modelo local detectada (state.db)" \
    "bug,P1" \
    "Detectado por watch-continuo-health.sh via hermes/scripts/detect-context-truncation.py (#7528) — o Ollama trunca silenciosamente (HTTP 200 sem sinal) quando o prompt excede a janela real do modelo; o valor truncado fica registrado em session_model_usage.input_tokens no state.db, e este detector divide input_tokens por api_call_count para comparar a media por chamada contra o ceiling (config.yaml model.context_length).

\`\`\`
$TRUNC_SESSIONS
\`\`\`

**Acao**: investigar a sessao mais recente (primeiro_seen) — abrir o transcript no helios e conferir se chamadas foram truncadas. O alarme dispara com 2+ sessoes no valor suspeito (~32770 = 2^15) ou 1+ sessao produtiva (calls >= 3) com media < 50% do teto. P1: truncagem em silencio degrade a qualidade da fila continua sem deixar rastro visivel."
else
  echo "[watch] truncagem: $TRUNC_PARSE (janela 24h, sem truncagem ativa; #7528)"
fi

# ── 11. fabricação de conclusão pelo coordenador do contínuo (#7537) ────────
# Reproduzido ao vivo em 06/09/2026: o modelo local (qwen), coordenando um
# tick de hermes-diaria-continuo, RELATOU ter escrito o relatório do tick e
# classificado issues sem ter feito nada disso — o arquivo nunca existiu, e
# a contagem alegada (n=4) não batia com a real (41 issues abertas). Este
# detector NÃO lê a saída conversacional do modelo (não é persistida) —
# compara data/continuo/last-tick-report.md (existe + mtime dentro da
# janela do tick correlacionada via data/sessions/continuo-*.json) e
# alegações de contagem/claim no próprio relatório contra o estado real
# (gh issue list, session-registry). status=fabrication_suspected -> alarme
# P1; indeterminate (1º tick sem sessão pra correlacionar, ou infra
# indisponível) NÃO alarma — mesma disciplina fail-soft das checagens acima.
FAB_JSON=$(python3 /home/vjpixel/diaria-studio/hermes/scripts/detect-tick-claim-fabrication.py --json 2>/dev/null)
FAB_PARSE=$(printf '%s' "$FAB_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['status'])
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
case "$FAB_PARSE" in *__ERR__*) FAB_PARSE="__ERR__" ;; esac
if [ "$FAB_PARSE" = "__ERR__" ]; then
  echo "[watch] fabricacao de tick: INDETERMINADO (detect-tick-claim-fabrication falhou)" >&2
  FAILS=$((FAILS + 1))
elif [ "$FAB_PARSE" = "indeterminate" ]; then
  echo "[watch] fabricacao de tick: indeterminado (sem sessao continuo recente pra correlacionar — ok, nao alarma; #7537)"
elif [ "$FAB_PARSE" = "fabrication_suspected" ]; then
  FAB_DETAILS=$(printf '%s' "$FAB_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(f\"  sessao_correlacionada={d.get('session_correlated')}\")
    for c in d.get('checks', []):
        print(f\"  [{c['status']}] {c['check']}: {c['details']}\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
  file_issue "[watch-continuo] fabricação de conclusão pelo coordenador" \
    "[watch-continuo] fabricação de conclusão pelo coordenador do contínuo detectada" \
    "bug,P1" \
    "Detectado por watch-continuo-health.sh via hermes/scripts/detect-tick-claim-fabrication.py (#7537) — o coordenador (modelo local, qwen) relatou ter concluído passos do tick (relatório escrito, N issues classificadas/reivindicadas) sem ter de fato executado; este detector compara o estado real (data/continuo/last-tick-report.md, gh issue list, data/sessions/continuo-*.json) contra o que o protocolo exige de todo tick.

\`\`\`
$FAB_DETAILS
\`\`\`

**Ação**: investigar a sessão correlacionada no helios (transcript do tick). Reproduzido ao vivo 06/09/2026: modelo alegou relatório escrito em data/continuo/last-tick-report.md (arquivo nunca existiu) e classificação com n=4 issues (existiam 41 abertas). Não promover o modelo local a primário do contínuo enquanto este alarme disparar (docs/goal-modelo-local-continuo.md). P1: relatório fabricado passa pro Telegram como se estivesse tudo bem, e a fila drena sem ninguém perceber."
else
  echo "[watch] fabricacao de tick: ok (sem sinal de fabricacao; #7537)"
fi

# ── 12. aumento de preço em modelo pago já em uso (#6818 item 4) ────────────
# A checagem 4 acima só pergunta "está na allowlist?" — um modelo que ESTÁ
# na allowlist nunca é sinalizado, a qualquer preço. Foi assim que o degrau
# de 09/09 do glm-5.3-flash (promoção de lançamento expira, custo do tick
# dobra — ~$176 -> ~$352/mês — ZERO mudança de config/código/volume) quase
# passou batido: só não custou porque alguém foi olhar à mão (#6818).
# `hermes-model-cost-report.py --price-check` compara o catálogo público da
# OpenRouter (sem auth) contra PAID_PRICE_BASELINE (mantido à mão no
# script, mesmo trade-off já aceito pro PAID_ALLOWLIST). Exit 3 = aumento
# real; exit 1 = indeterminado (catálogo inacessível, ou id/campo do
# baseline sumiu do catálogo) — NUNCA lido como "ok" (mesma disciplina
# fail-closed do #6992/#7776/#7805); exit 0 = preço estável ou só caiu.
PRICE_JSON=$(python3 /home/vjpixel/.hermes/scripts/hermes-model-cost-report.py --price-check --json 2>/dev/null)
PRICE_RC=$?
PRICE_PARSE=$(printf '%s' "$PRICE_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('increases'):
        print('INCREASE')
    elif d.get('unverifiable'):
        print('UNVERIFIABLE')
    else:
        print('OK')
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
case "$PRICE_PARSE" in *__ERR__*) PRICE_PARSE="__ERR__" ;; esac
case "$PRICE_PARSE" in INCREASE|UNVERIFIABLE|OK) : ;; *) PRICE_PARSE="__ERR__" ;; esac
if [ "$PRICE_PARSE" = "__ERR__" ]; then
  echo "[watch] preço OpenRouter: INDETERMINADO (price-check falhou, rc=$PRICE_RC)" >&2
  FAILS=$((FAILS + 1))
elif [ "$PRICE_PARSE" = "UNVERIFIABLE" ]; then
  PRICE_DETAILS=$(printf '%s' "$PRICE_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for f in d.get('unverifiable', []):
        print(f\"  {f.get('modelo')} {f.get('campo', '-')}: {f.get('motivo')}\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
  echo "[watch] preço OpenRouter: INDETERMINADO (catálogo não confirma o baseline; rc=$PRICE_RC)" >&2
  printf '%s\n' "$PRICE_DETAILS" >&2
  FAILS=$((FAILS + 1))
elif [ "$PRICE_PARSE" = "INCREASE" ]; then
  PRICE_DETAILS=$(printf '%s' "$PRICE_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for f in d.get('increases', []):
        fator = f\"{f['fator']:.2f}x\" if f.get('fator') else '?'
        print(f\"  {f['modelo']} {f['campo']}: {f['baseline']:.9f} -> {f['atual']:.9f} ({fator})\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
  file_issue "[watch-continuo] aumento de preço em modelo pago já em uso" \
    "[watch-continuo] aumento de preço em modelo pago já em uso (OpenRouter, #6818)" \
    "bug,P2" \
    "Detectado por watch-continuo-health.sh via hermes-model-cost-report.py --price-check (#6818 item 4) — o catálogo público da OpenRouter mostra preço acima do baseline registrado em \`PAID_PRICE_BASELINE\` (hermes-model-cost-report.py) para pelo menos 1 modelo pago já em uso:

\`\`\`
$PRICE_DETAILS
\`\`\`

Mesma classe da issue #6818: uma promoção de lançamento expira e o custo do tick dobra sem nenhuma mudança de config/código/volume. **Ação**: recalcular o custo-mix real com o preço novo (não pelo preço de prompt isolado — no mix do tick, output é ~9% dos tokens e até 84% da conta), decidir se mantém o modelo ao preço novo ou troca por um candidato mais barato medido contra o workload real (nunca por ficha técnica), e atualizar \`PAID_PRICE_BASELINE\` pra refletir o preço vigente — senão este alarme repete todo dia."
else
  echo "[watch] preço OpenRouter: ok (sem aumento vs baseline; #6818 item 4)"
fi

# ── 13. registro de sessão do contínuo ausente (#7890) ─────────────────────
# Achado durante o #7814: o tick de 08/09 (#7641) nunca gravou
# `data/sessions/continuo-*.json` pra si mesmo (provavelmente por ter
# falhado cedo, antes do passo 1.3) — a checagem 11 acima correlacionou a
# sessão ERRADA (a mais recente de um tick anterior) e produziu uma
# acusação de fabricação que exigiu investigação extra pra descartar como
# falso positivo. `session-registry.ts register --kind continuo` continua
# sendo um passo em PROSA no SKILL.md (#7890 optou por verificação externa
# em vez de mover o registro pro wrapper genérico `claude-delegate.sh` —
# ver justificativa no corpo do PR): esta checagem correlaciona a janela de
# tempo de cada sidecar de tick recente (checagem 0) contra as janelas
# `[startedAt, lastHeartbeat]` das sessões `kind=continuo` já registradas.
# status=alarm -> tick com sidecar mas SEM sessão continuo na janela;
# indeterminate (diretório de sidecars/sessões ausente) NÃO alarma — mesma
# disciplina fail-soft das checagens acima.
REG_JSON=$(npx tsx /home/vjpixel/diaria-studio/scripts/check-continuo-session-registration.ts --json 2>/dev/null)
REG_PARSE=$(printf '%s' "$REG_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['status'])
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
case "$REG_PARSE" in *__ERR__*) REG_PARSE="__ERR__" ;; esac
case "$REG_PARSE" in ok|alarm|indeterminate) : ;; *) REG_PARSE="__ERR__" ;; esac
if [ "$REG_PARSE" = "__ERR__" ]; then
  echo "[watch] registro de sessão continuo: INDETERMINADO (check-continuo-session-registration falhou)" >&2
  FAILS=$((FAILS + 1))
elif [ "$REG_PARSE" = "indeterminate" ]; then
  REG_REASON=$(printf '%s' "$REG_JSON" | python3 -c "
import sys, json
try:
    print(json.load(sys.stdin)['reason'])
except Exception:
    print('(sem motivo legivel)')" 2>/dev/null || echo "(sem motivo legivel)")
  echo "[watch] registro de sessão continuo: indeterminado ($REG_REASON — ok, não alarma; #7890)"
elif [ "$REG_PARSE" = "alarm" ]; then
  REG_DETAILS=$(printf '%s' "$REG_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(f\"  {d['reason']}\")
    for t in d.get('unregisteredTicks', []):
        print(f\"  tick sem sessão: {t['sessionId']} ({t['firstAt']} .. {t['lastAt']})\")
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
  file_issue "[watch-continuo] tick sem registro de sessão" \
    "[watch-continuo] tick sem registro de sessão (session-registry.ts register --kind continuo, #7890)" \
    "bug,P2" \
    "Detectado por watch-continuo-health.sh via scripts/check-continuo-session-registration.ts (#7890) — pelo menos 1 tick recente (com sidecar de ferramentas capturado, #7814) não tem NENHUMA sessão \`kind=continuo\` em \`data/sessions/\` cuja janela \`[startedAt, lastHeartbeat]\` se sobreponha:

\`\`\`
$REG_DETAILS
\`\`\`

**O que isso significa**: o passo \`session-registry.ts register --kind continuo\` (SKILL.md, passo 1.3) não rodou cedo o suficiente nesse tick, provavelmente porque o tick falhou antes de chegar lá (credencial, rede, guard de colisão). **Risco concreto**: sem registro, o detector de fabricação de conclusão (checagem 11, #7537) correlaciona a sessão ERRADA (a mais recente de outro tick) contra o que este tick alega — foi exatamente o que aconteceu no #7641, custando uma investigação extra pra descartar como falso positivo.

**Ação**: conferir o log do tick correlacionado (bracket do sidecar acima) no helios pra entender por que o registro não aconteceu — tipicamente uma falha cedo no passo 1 (ver checagem de parada por auth abaixo). Não é uma correção automática por design — item 1 da proposta original (wrapper no cron do Hermes que registra ANTES de invocar o modelo) foi avaliado e adiado por tocar o contrato do protocolo do tick e o wrapper genérico \`claude-delegate.sh\` (reusado por outras skills do Hermes); reconsiderar se este alarme disparar com frequência."
else
  echo "[watch] registro de sessão continuo: ok (todo tick recente com sessão registrada; #7890)"
fi

# --- Parada dura por AUTH no cron do contínuo (#7647) --------------------
# 08/09/2026: o refresh token do Codex foi reusado por outro cliente, o cron
# passou a falhar com 401/403, e o contínuo parou 7 TICKS em silêncio — o
# `failure_streak` subia dentro do `jobs.json` do Hermes e nada no repo lia.
# Esta checagem é a metade repo-side do #7647: lê o veredito determinístico
# de `scripts/check-continuo-auth-stall.ts` (que não toca credencial, não lê
# auth.json e não mexe no pool — higiene de conta é ação externa do editor) e
# alarma. Mesma disciplina fail-soft das checagens acima: `stalled:false` por
# jobs.json ilegível é INDETERMINADO (conta em FAILS), nunca "está saudável".
AUTH_JSON=$(npx tsx /home/vjpixel/diaria-studio/scripts/check-continuo-auth-stall.ts --json 2>/dev/null)
AUTH_PARSE=$(printf '%s' "$AUTH_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print('STALLED' if d['stalled'] else ('UNKNOWN' if 'ileg' in d['reason'] else 'OK'))
except Exception:
    print('__ERR__')" 2>/dev/null || echo "__ERR__")
case "$AUTH_PARSE" in *__ERR__*) AUTH_PARSE="__ERR__" ;; esac
case "$AUTH_PARSE" in STALLED|UNKNOWN|OK) : ;; *) AUTH_PARSE="__ERR__" ;; esac
AUTH_REASON=$(printf '%s' "$AUTH_JSON" | python3 -c "
import sys, json
try:
    print(json.load(sys.stdin)['reason'])
except Exception:
    print('(sem motivo legivel)')" 2>/dev/null || echo "(sem motivo legivel)")
if [ "$AUTH_PARSE" = "__ERR__" ]; then
  echo "[watch] parada por auth: INDETERMINADO (check-continuo-auth-stall falhou)" >&2
  FAILS=$((FAILS + 1))
elif [ "$AUTH_PARSE" = "UNKNOWN" ]; then
  echo "[watch] parada por auth: INDETERMINADO (jobs.json ilegivel: $AUTH_REASON)" >&2
  FAILS=$((FAILS + 1))
elif [ "$AUTH_PARSE" = "STALLED" ]; then
  file_issue "[watch-continuo] parada dura por auth" \
    "[watch-continuo] parada dura por auth (401/403) no cron do contínuo" \
    "bug,P1" \
    "Detectado por watch-continuo-health.sh via scripts/check-continuo-auth-stall.ts (#7647).

\`\`\`
$AUTH_REASON
\`\`\`

**Ação (externa, decisão do editor — o detector NÃO executa nada disso):** conferir no helios se a credencial do cron do contínuo ainda é válida e se o refresh token não está sendo reusado por outro cliente; renovar/rotacionar a conta do pool se for o caso. O detector é deliberadamente read-only sobre \`jobs.json\` — não lê \`auth.json\`, não invoca \`hermes auth add|remove\`, não toca o pool de credenciais.

P1: o modo de falha é silencioso por construção — em 08/09/2026 custou 7 ticks do contínuo sem que nada no repo notasse, e o único sinal era o \`failure_streak\` subindo dentro do estado do agendador."
else
  echo "[watch] parada por auth: ok ($AUTH_REASON; #7647)"
fi

echo "[watch] varredura concluída (checagens indeterminadas/falhas de infra: $FAILS)"
# Exit honesto (finding P2 do review #6469): FAILS>0 = o observador NÃO pôde
# garantir a varredura — o cron do Hermes registra a falha e o failure_streak
# do próprio job de watch vira o alarme de quem vigia o vigilante.
[ "$FAILS" -eq 0 ] || exit 1
exit 0
