#!/usr/bin/env bash
# claude-openrouter.sh — roda `claude -p` (harness do Claude Code) com modelo
# do OpenRouter, SEM tocar a cota da assinatura claude.ai.
#
# Por que existe (28/08/2026): o hermes-diaria-continuo parafraseava as regras
# do repo (classifyExecTrack etc.) em prosa que envelhecia em silêncio — 5
# categorias na cópia vs 6 no código real. Este wrapper troca paráfrase por
# execução: o modelo roda DENTRO do checkout, com CLAUDE.md carregado e os
# scripts reais.
#
# Mecanismo: o OpenRouter fala a Messages API da Anthropic nativamente
# (validado ao vivo em /api/v1/messages, 28/08). ANTHROPIC_BASE_URL +
# ANTHROPIC_AUTH_TOKEN apontam o CLI pra lá; --model aceita slug do OpenRouter
# (com aviso de "modelo desconhecido", inofensivo).
#
# REGRAS INEGOCIÁVEIS (#5608 do diaria-studio):
#   - As env vars ANTHROPIC_* vivem SÓ no processo filho (export num
#     subshell que envolve o `claude`; #6718 — nunca como argumento de `env`,
#     que fica world-readable no /proc/<pid>/cmdline).
#     NUNCA exportar no ambiente global — sequestram sessões da assinatura
#     e desligam os conectores claude.ai (Beehiiv/Gmail) do pipeline.
#   - Este wrapper é pra fila de issues/código. NÃO usar pra nada que precise
#     dos conectores claude.ai.
#
# Gotchas embutidos:
#   - Prompt via STDIN (--allowedTools é variádico e engole prompt posicional).
#   - Fallback de modelo: free primeiro; se free falhar (balde diário esgota —
#     compartilhado por CONTA entre todos os :free), cai pro glm-5.3-flash
#     pago (~USD 0,075/M in; teto diário da chave limita o estrago).
#   - Exit codes na falha total da cadeia (#6617, 28/08/2026): 1 = falha
#     transitória (quota/rate-limit/timeout — "volta sozinho" é uma leitura
#     válida); 4 = pelo menos um modelo da cadeia falhou com sinal de CONFIG
#     INVÁLIDA (model id que o provedor não reconhece) e nenhum sinal de
#     quota apareceu — "volta sozinho" é falso aqui, precisa correção manual
#     do MODELS_DEFAULT/--model. Motivado por incidente real: o watchdog de
#     rate-limit do Hermes lia rc≠0 como sinônimo de quota-exhaustion e
#     pausava o job dizendo "reset natural resolve", mas `z-ai/glm-5.2:free`
#     ESTAVA AUSENTE do catálogo do OpenRouter na medição de 28/08
#     (/api/v1/models) — naquele momento a cadeia não ia se recuperar sozinha.
#
#     ATENÇÃO (medido 30/08/2026, mesmo endpoint): `z-ai/glm-5.2:free` ESTÁ
#     no catálogo hoje. A ausência de 28/08 foi uma janela, não uma remoção
#     permanente — o texto anterior aqui dizia "tinha saído do catálogo" e
#     isso virou mentira em 2 dias. Consequência prática pro exit 4: os sinais
#     que o disparam (`no endpoints found` e vizinhos, regex do SAW_CONFIG_
#     ERROR_SIGNAL abaixo — NÃO `unrecognized_model`, que é ruído filtrado)
#     não distinguem id INVÁLIDO de id válido temporariamente sem endpoint.
#     Nesse 2º caso o exit 4 pede correção manual de uma config que está
#     certa. Antes de editar MODELS_DEFAULT por causa de um exit 4, conferir
#     o catálogo: `curl -s https://openrouter.ai/api/v1/models` (sem auth) e
#     procurar o id. Tratamento dos 3 casos: issue #6803.
#
# Uso:
#   echo "<tarefa>" | claude-openrouter.sh [--tools "Read,Bash(npx tsx:*)"] \
#     [--cwd DIR] [--budget USD] [--timeout SECS] [--model SLUG] [--effort LEVEL]
set -euo pipefail

TOOLS="Read,Grep,Glob,Bash"
CWD="/home/vjpixel/diaria-studio"
BUDGET="20.0"
TIMEOUT="1800"
# --effort (#6816): passthrough opcional pro --effort nativo do `claude -p`
# (low|medium|high|xhigh|max, confirmado via `claude -p --help`). Vazio por
# default = comportamento de hoje, sem override (o CLI decide sozinho). Existe
# pra permitir A/B de esforço por camada sem editar este script a cada teste —
# quem decide o valor é o call site (SKILL.md/cron), nunca um default aqui.
# Não confundir com `agent.reasoning_overrides` do Hermes nativo (~/.hermes) —
# aquele é outro mecanismo, fora deste repo, e não alcança quem passa por este
# wrapper (o wrapper nunca lê ~/.hermes/config.yaml).
EFFORT=""
# #6712: BUDGET de $2.0 → $20.0. O #6666 tinha subido de $0.25 → $2.0
# tratando o SINTOMA; a causa é outra e o valor certo é ordens de grandeza
# maior. O CLI NÃO reconhece o slug do gateway
# ("[claude-code:unrecognized_model] {\"model\":\"z-ai/glm-5.3-flash\"}" em
# todo /tmp/claude-openrouter-stderr.*.log) e contabiliza contra
# --max-budget-usd usando o preço DEFAULT da Anthropic (~$3/M in, $15/M out,
# $0.30/M cache read) em vez do preço real do modelo. Erro de ~14-18x
# (18.1x / 14.1x / 16.6x nos 3 pontos medidos abaixo — média 16.3x; o valor
# varia com a proporção in/out/cache de cada delegação, não é uma constante).
#
# Medido no tick de 29/08/2026 19:52-20:32Z, 3 delegações reais:
#   1.86M tokens -> custo real $0.067  |  CLI estimou $1.21
#   3.80M tokens -> custo real $0.137  |  CLI estimou $1.93
#   4.39M tokens -> custo real $0.159  |  CLI estimou $2.64
# (preço real medido do glm-5.3-flash: $0.0361/M, derivado do billing.)
# As 3 estouraram budget de $1.0/$1.5/$2.0 gastando centavos, e o tick de
# 40min produziu ZERO PRs — trabalho interrompido no meio, reportado como
# "falha de infra".
#
# O --max-budget-usd NÃO é o controle de custo desta pipeline: quem limita
# gasto de verdade é o teto diário da key na OpenRouter, aplicado pelo
# PROVEDOR e imune a erro de estimativa. (O valor do teto vive no dashboard
# da OpenRouter, não neste repo — em 29/08/2026 era $3/dia, com intenção
# declarada do editor de baixar para $1; conferir lá, nunca assumir daqui.)
# Aqui o budget fica só como rede contra runaway catastrófico. Não voltar a
# calibrá-lo pelo custo esperado de uma delegação — a régua está errada,
# então qualquer valor "justo" calculado nela volta a cortar trabalho
# legítimo.
#
# DOIS PRESSUPOSTOS que este valor carrega, e que morrem em silêncio se a
# cadeia mudar (achados do review da PR #6722):
#
#   (a) O fator de erro foi medido SÓ para z-ai/glm-5.3-flash. Um modelo
#       cujo preço real se aproxime do default da Anthropic torna $20 um teto
#       de gasto REAL de $20, não de ~$1. Ao mexer em MODELS_DEFAULT ou passar
#       --model novo, remedir antes de confiar neste número.
#   (b) "A key limita" vale para o elo PAGO. Os dois elos `:free` da cadeia
#       são protegidos por o custo real ser zero, não pelo teto da key — se um
#       `:free` virar pago (mudança do lado da OpenRouter, sem aviso), essa
#       proteção some sem nada falhar.
#
# (O erro "Exceeded USD budget" vai pro STDOUT, não stderr — por isso o
# capture de stdout no RC≠0 introduzido pelo #6666 continua necessário.)
#
# Os 3 tetos distintos citados acima ($1.0/$1.5/$2.0) não vêm daqui: este é
# só o DEFAULT. Um `--budget` explícito no call site o sobrepõe, e em
# 29/08/2026 o tick reagiu ao abort tentando valores cada vez MENORES. Por
# isso test/hermes-budget-guard.test.ts trava o call site da SKILL.md junto
# com este default — subir um sem o outro não conserta o caminho que roda.
# Decisivo é o contexto — dots-3 tem 512k na variante :free vs 262k do
# laguna, e este wrapper roda `claude -p` DENTRO do checkout com CLAUDE.md
# inteiro carregado, então contexto maior importa mais que o resto do
# benchmark (dots-3 também vence Terminal-Bench 2.1, o mais próximo deste
# caso de uso — números vêm de fontes diferentes, Poolside vs BenchLM:
# sinal, não prova). laguna segue em segundo — não por id morto: o #6617
# tinha diagnosticado z-ai/glm-5.2:free como fora do catálogo, mas a
# "Correção de premissa" do #6663 mediu ao vivo em 28/08/2026 que o id
# continua resolvendo (endpoint ativo, ctx 256k) — a troca de posição do
# laguna é só sobre contexto menor, não sobre um id inválido. glm-5.3-flash
# (pago) continua por último, é o fallback.
MODELS_DEFAULT=("dots-studio/dots-3-note-preview:free" "poolside/laguna-s-2.1:free" "z-ai/glm-5.3-flash")
MODEL_FORCED=""

while [ $# -gt 0 ]; do
  case "$1" in
    --tools)   TOOLS="$2"; shift 2 ;;
    --cwd)     CWD="$2"; shift 2 ;;
    --budget)  BUDGET="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --model)   MODEL_FORCED="$2"; shift 2 ;;
    --effort)  EFFORT="$2"; shift 2 ;;
    *) echo "arg desconhecido: $1" >&2; exit 2 ;;
  esac
done

# Mesma disciplina do --timeout/--budget acima: validar ANTES do loop de
# tentativas, não deixar o CLI rejeitar no meio da cadeia.
case "$EFFORT" in
  ''|low|medium|high|xhigh|max) ;;
  *) echo "ERRO: --effort deve ser low|medium|high|xhigh|max, veio '$EFFORT'" >&2; exit 2 ;;
esac

# Validar numéricos ANTES do loop (finding do review #6446: valor malformado
# faria TODOS os modelos falharem identicamente, mascarado como "cadeia caiu").
case "$TIMEOUT" in (*[!0-9]*|'') echo "ERRO: --timeout deve ser inteiro em segundos, veio '$TIMEOUT'" >&2; exit 2 ;; esac
case "$BUDGET" in (*[!0-9.]*|''|.|*.*.*) echo "ERRO: --budget deve ser numérico em USD, veio '$BUDGET'" >&2; exit 2 ;; esac

# Mesma fonte de chave que o próprio Hermes usa (credential_pool.openrouter).
# try/except (finding do review #6446): auth.json ausente/corrompido imprimia
# traceback cru e matava o script via set -e ANTES do guard de mensagem abaixo.
KEY=$(python3 - <<'PY'
import json
try:
    a = json.load(open('/home/vjpixel/.hermes/auth.json'))
except Exception:
    raise SystemExit(0)  # stdout vazio -> guard do shell dá a mensagem
for c in a.get('credential_pool', {}).get('openrouter', []):
    t = c.get('access_token', '')
    if t.startswith('sk-or-'):
        print(t)
        break
PY
)
[ -n "$KEY" ] || { echo "ERRO: nenhuma chave OpenRouter legível em ~/.hermes/auth.json (arquivo ausente, JSON inválido, ou sem token sk-or-*)" >&2; exit 3; }

PROMPT=$(cat)
[ -n "$PROMPT" ] || { echo "ERRO: prompt vazio no stdin" >&2; exit 2; }

if [ -n "$MODEL_FORCED" ]; then
  MODELS=("$MODEL_FORCED")
else
  MODELS=("${MODELS_DEFAULT[@]}")
fi

# Sem --bare de propósito: --bare desliga o auto-discovery do CLAUDE.md, que é
# metade do valor deste wrapper. A troca de auth é garantida pelo env mesmo
# assim — ANTHROPIC_AUTH_TOKEN tem precedência sobre o OAuth da assinatura
# (o CLI avisa "connectors are disabled ... takes precedence", validado 28/08).
cd "$CWD"
# stderr CRU sempre preservado em arquivo (finding do review #6446: o filtro
# de ruído era a ÚNICA cópia — linha real que contivesse um dos padrões era
# perdida pra sempre). O terminal segue filtrado; o arquivo tem tudo.
STDERR_LOG="${TMPDIR:-/tmp}/claude-openrouter-stderr.$$.log"
# Sinais agregados pra decidir o exit code final (#6617): "unrecognized_model"
# sozinho é ruído esperado de QUALQUER modelo de terceiro (o CLI não conhece
# nenhum slug do OpenRouter) — não distingue modelo válido de inválido. O que
# distingue é o PROVEDOR recusar o modelo (rc≠0 + saída vazia + nenhum sinal
# de quota/rate-limit no mesmo stderr) vs. a conta ficar sem cota (429/rate
# limit explícito, ou timeout — esses SIM se resolvem sozinhos no reset).
SAW_QUOTA_SIGNAL=0
SAW_CONFIG_ERROR_SIGNAL=0

# #6803: "model not found"/"invalid model" no stderr pode ser ausência
# TRANSITÓRIA do catálogo (indisponibilidade momentânea), não config
# permanente — medido ao vivo em 30/08/2026: `z-ai/glm-5.2:free` disparou
# esse sinal em 28/08 (exit 4, "config inválida, não volta sozinha") e
# estava de volta no catálogo 2 dias depois. Antes de marcar
# SAW_CONFIG_ERROR_SIGNAL=1 (que produz exit 4, para o job pedindo correção
# manual de MODELS_DEFAULT), reconsulta `GET /api/v1/models` — endpoint
# público, sem auth, barato — e confirma se o id realmente sumiu. Se o
# curl falhar (rede indisponível, timeout) o resultado é "não confirmado":
# mantém o comportamento ANTERIOR (exit 4) por segurança — não dá pra provar
# que o id existe, então não dá pra baixar a severidade.
model_in_openrouter_catalog() {
  local model="$1"
  local catalog
  if ! catalog=$(curl -sf --max-time 10 "https://openrouter.ai/api/v1/models" 2>/dev/null); then
    return 2
  fi
  if printf '%s' "$catalog" | grep -qF "\"id\":\"$model\""; then
    return 0
  fi
  return 1
}

for MODEL in "${MODELS[@]}"; do
  echo "[claude-openrouter] tentando model=$MODEL" >&2
  ATTEMPT_LOG="${TMPDIR:-/tmp}/claude-openrouter-attempt.$$.log"
  : > "$ATTEMPT_LOG"
  set +e
  # #6617 review finding 1: redirecionar direto pro arquivo (síncrono) em vez
  # de passar por `tee` dentro de process substitution — `OUT=$(...)` só
  # espera o pipeline de STDOUT fechar, nunca o job assíncrono do `>(...)`
  # terminar de escrever, então o `grep` de classificação logo abaixo podia
  # ler um $ATTEMPT_LOG parcialmente flushado e perder o próprio sinal que
  # decide entre exit 1 e exit 4. Filtro de ruído pro terminal roda DEPOIS,
  # já sobre o arquivo completo.
  # ANTHROPIC_DEFAULT_HAIKU_MODEL fixa o modelo das chamadas de BACKGROUND do
  # CLI no mesmo slug barato da tentativa atual (#6716). Sem isto, `--model` só
  # governa a conversa: as chamadas auxiliares usam o default do CLI e saíram
  # como Claude Sonnet 5 a preço cheio no billing do OpenRouter — medido em
  # 29/08/2026 nas sessões 76433685 ($0.38) e 1520faa3 ($0.417), ~75% do custo
  # de cada delegação, contra ~$0.09 se tudo tivesse rodado no slug pedido.
  #
  # CAUSA IDENTIFICADA (31/08/2026, docs oficiais do Claude Code). A hipótese
  # anterior registrada aqui — auto-compact como candidato provável — está
  # DESCARTADA: a doc de prompt-caching diz que a chamada de compactação usa o
  # MESMO modelo da conversa, e a sumarização de `--resume` já está atrelada ao
  # ANTHROPIC_DEFAULT_HAIKU_MODEL. Nenhuma das duas explicaria cobrança em
  # Sonnet.
  #
  # O que explica: ANTHROPIC_DEFAULT_HAIKU_MODEL cobre APENAS o alias `haiku` e
  # as funcionalidades de background. Caminho interno que peça modelo pela
  # FAMÍLIA `sonnet`/`opus` resolve pelo ID default embutido no binário do CLI —
  # uma string real da Anthropic — que o gateway fatura a preço cheio. Daí os
  # dois exports abaixo, irmãos do de haiku.
  #
  # TRADE-OFF ACEITO (review da PR #6717): quando o elo corrente é `:free`, o
  # background passa a puxar do MESMO balde `free-models-per-day` (por CONTA)
  # que o primário — 2 saques por delegação em vez de 1, então o balde seca mais
  # cedo e a cadeia cai no pago antes. Antes do fix essas chamadas iam pro Sonnet
  # pago e não tocavam o balde. O custo em DINHEIRO cai de qualquer forma; o que
  # piora é a cota free, que já é o gargalo do #6712 (17h/dia de pausa). Se isso
  # incomodar, a alternativa é fixar o background sempre no elo PAGO barato
  # (glm-5.3-flash) em vez de "$MODEL" — não feito aqui pra manter a propriedade
  # "background nunca custa mais que o primário" e evitar um slug hardcoded.
  #
  # O que torna isso traiçoeiro: essas chamadas NÃO aparecem no transcript
  # .jsonl da sessão (as duas acima registram só glm-5.3-flash), então
  # auditoria por transcript nunca as vê — a fonte é o billing do gateway.
  #
  # Usa "$MODEL" (o elo corrente da cadeia) em vez de um slug fixo pra valer
  # em qualquer posição: o background herda o mesmo custo do primário, nunca
  # um modelo mais caro que o que se pediu.
  #
  # A doc do Claude Code confirma que esta var cobre "background functionality"
  # (`ANTHROPIC_SMALL_FAST_MODEL` é o nome legado, deprecado). O fallback
  # pra Sonnet quando ela NÃO está setada só é documentado pra Bedrock — que
  # valha igual num gateway genérico é inferência do padrão observado aqui,
  # não fato documentado. Se o billing seguir mostrando um supporting model
  # depois desta linha, a causa é outra: reabrir #6716 em vez de trocar o slug.
  # #6718: as vars ANTHROPIC_* entram por `export` num subshell, não por
  # `env VAR=valor` — argumentos de processo são world-readable em
  # /proc/<pid>/cmdline (0444; um `ps -eo args` trivial imprimia a chave
  # inteira durante TODA a delegação, até 40 min por tick), enquanto
  # /proc/<pid>/environ é 0400 (só o dono lê). O subshell preserva o escopo
  # que o `env` garantia: as vars morrem com ele e NUNCA escapam pro shell
  # que chamou o wrapper (regra #5608 — sequestrariam sessões da assinatura).
  # #6666 item 1 ("capturar o erro real"): registrar quanto tempo o processo
  # viveu junto do exit code — os 3 stderr logs inspecionados no incidente
  # (#6666) só tinham avisos de ruído, sem timing; um processo que morre em
  # <1s (crash imediato) vs um que roda até o TIMEOUT completo são causas
  # bem diferentes, e nenhuma das duas era distinguível antes disto.
  ATTEMPT_START_TS=$(date +%s)
  OUT=$(printf '%s' "$PROMPT" | (
    export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
    export ANTHROPIC_AUTH_TOKEN="$KEY"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL"
    export CLAUDE_CODE_MAX_CONTEXT_TOKENS=200000
    timeout "$TIMEOUT" \
    claude -p \
      --model "$MODEL" \
      --allowedTools "$TOOLS" \
      --max-budget-usd "$BUDGET" \
      ${EFFORT:+--effort "$EFFORT"} 2> "$ATTEMPT_LOG"
  ))
  RC=$?
  ATTEMPT_DURATION_S=$(( $(date +%s) - ATTEMPT_START_TS ))
    set -e
    # #6696 finding 2: snapshot do stderr PURO antes do stdout entrar no
    # mesmo arquivo. Este wrapper roda DENTRO deste checkout, onde as
    # próprias tarefas falam de "model not found"/"rate limit" (assunto
    # das issues #6617/#6666) — se o texto GERADO pelo modelo for
    # misturado ao stderr antes de classificar, uma resposta que discuta
    # o próprio bug e morra com rc≠0 pode disparar um exit 4 espúrio
    # (rotação de um modelo que estava são). Os greps de config-inválida e
    # rate-limit abaixo classificam só contra este snapshot; só o grep de
    # budget-exceeded (que precisa ver o STDOUT, ver #6666) usa o log
    # combinado, montado depois deste ponto.
    STDERR_ONLY_LOG="${TMPDIR:-/tmp}/claude-openrouter-attempt-stderr.$$.log"
    cp "$ATTEMPT_LOG" "$STDERR_ONLY_LOG"
    # #6666: capturar stdout também no RC≠0 — "Exceeded USD budget" é erro do CLI
    # que vai pro STDOUT (não stderr), então o classify-grep de stderr nunca o via.
    # Sem isso, a cadeia falha silenciosamente com rc=1 e stderr vazio.
    echo "$OUT" >> "$ATTEMPT_LOG"
    cat "$ATTEMPT_LOG" >> "$STDERR_LOG"
    if [ $RC -eq 0 ] && [ -n "$OUT" ]; then
      printf '%s\n' "$OUT"
      echo "[claude-openrouter] ok model=$MODEL" >&2
      rm -f "$STDERR_LOG" "$ATTEMPT_LOG" "$STDERR_ONLY_LOG"
      exit 0
    fi
    # #6696 finding 3: filtro de ruído só no caminho de FALHA. Antes disto
    # rodava incondicionalmente ANTES do check de sucesso acima — mesmo um
    # run bem-sucedido tinha a resposta inteira do modelo impressa também
    # em stderr (o ATTEMPT_LOG já continha $OUT quando o grep rodava),
    # duplicando log e inflando a chance de falso-positivo por substring
    # nos watchdogs que varrem esse output.
    grep -vE "not a model this version|unrecognized_model|connectors are disabled" "$ATTEMPT_LOG" >&2 || true
    # #6666 item 1: registrar rc + duração de vida do processo — nenhum dos
    # 3 stderr logs inspecionados no incidente tinha isso, só ruído de
    # conector/unrecognized_model, então não dava pra distinguir "processo
    # morreu na hora" de "rodou até o TIMEOUT e não terminou a tempo".
    echo "[claude-openrouter] diagnóstico model=$MODEL rc=$RC duracao_s=$ATTEMPT_DURATION_S timeout_s=$TIMEOUT" >&2
    echo "[claude-openrouter] diagnóstico model=$MODEL rc=$RC duracao_s=$ATTEMPT_DURATION_S timeout_s=$TIMEOUT" >> "$STDERR_LOG"
    # #6666 item 1: cópia num path ESTÁVEL (não $$-escopado) da última
    # falha — o path com PID some junto com o processo e, sem nada
    # arquivando-o, o log fica irrecuperável assim que o PID é reciclado ou
    # /tmp é limpo. Sobrescrita a cada falha nova (best-effort — investigar
    # "a falha mais recente" é o caso de uso; falhas concorrentes de ticks
    # paralelos ainda têm o path $$-escopado como fonte completa).
    # Review #6808 (P2, confiança alta): a linha de diagnóstico (rc+duração)
    # só ia pro STDERR_LOG ($$-escopado, some com o processo) — o
    # last-failure.log ESTÁVEL era uma cópia do ATTEMPT_LOG de ANTES da
    # linha de diagnóstico ser escrita, então o arquivo que devia sobreviver
    # não continha o próprio dado que o #6666 item 1 existe pra preservar.
    # Fix: apendar a linha de diagnóstico ao ATTEMPT_LOG antes da cópia.
    echo "[claude-openrouter] diagnóstico model=$MODEL rc=$RC duracao_s=$ATTEMPT_DURATION_S timeout_s=$TIMEOUT" >> "$ATTEMPT_LOG"
    cp -f "$ATTEMPT_LOG" "${TMPDIR:-/tmp}/claude-openrouter-last-failure.log" 2>/dev/null || true
    # Classificar o motivo desta tentativa (finding do review #6446 cobria só
    # rc=0/saída-vazia vs timeout vs rc≠0 genérico; #6617 acrescenta a
    # distinção quota-transitória vs config-permanente dentro do rc≠0/vazio).
    if [ $RC -eq 124 ]; then
      SAW_QUOTA_SIGNAL=1
      echo "[claude-openrouter] falhou model=$MODEL: TIMEOUT (${TIMEOUT}s) — próximo da cadeia; stderr cru em $STDERR_LOG" >&2
    elif grep -qiE "model not found|invalid model|not a valid model|no endpoints found|no allowed providers" "$STDERR_ONLY_LOG"; then
      # #6617 review finding 3: checar config-inválida ANTES de rate-limit —
      # "not a valid model" também casaria com um grep solto por "valid model"
      # numa mensagem de quota, então a ordem evita falso-negativo cruzado.
      #
      # #6803: antes de marcar como config PERMANENTE (exit 4), reconsulta o
      # catálogo — o provedor pode ter recusado o modelo por indisponibilidade
      # TRANSITÓRIA, não porque o id deixou de existir.
      if model_in_openrouter_catalog "$MODEL"; then
        SAW_QUOTA_SIGNAL=1
        echo "[claude-openrouter] falhou model=$MODEL rc=$RC: PROVEDOR REJEITOU, mas o id CONTINUA no catálogo agora (/api/v1/models) — provável indisponibilidade TRANSITÓRIA (#6803), tratando como rate-limit/quota, NÃO como config permanente; próximo da cadeia; stderr cru em $STDERR_LOG" >&2
      else
        SAW_CONFIG_ERROR_SIGNAL=1
        echo "[claude-openrouter] falhou model=$MODEL rc=$RC: MODELO INEXISTENTE/INVÁLIDO no provedor — confirmado ausente do catálogo agora (ou catálogo inacessível) (#6803); config permanente, NÃO é rate-limit; próximo da cadeia; stderr cru em $STDERR_LOG" >&2
      fi
    elif grep -qiE "rate.?limit|too many requests|quota exceeded|http.{0,10}429|status.{0,10}429|429.{0,10}(too many|rate)|\\(429\\)" "$STDERR_ONLY_LOG"; then
      # #6617 review finding 4: "429" sozinho podia casar com ruído não
      # relacionado (contagem de bytes, linha) — agora exige contexto de
      # rate-limit textual OU o número junto de "http"/"status".
      SAW_QUOTA_SIGNAL=1
      echo "[claude-openrouter] falhou model=$MODEL rc=$RC: RATE-LIMIT/QUOTA (sinal no stderr) — transitório, próximo da cadeia; stderr cru em $STDERR_LOG" >&2
    elif grep -qE "Exceeded USD budget" "$ATTEMPT_LOG"; then
      # #6696 finding 1: budget-exceeded é DETERMINÍSTICO pro mesmo valor de
      # BUDGET — o mesmo prompt estoura em TODO run até alguém mexer no
      # valor, então não é "transitório, reset resolve" (SAW_QUOTA_SIGNAL);
      # é config permanente (SAW_CONFIG_ERROR_SIGNAL), a mesma classe que o
      # #6617 criou o exit 4 pra sinalizar. Classificar como quota mascarava
      # de volta o exato incidente que o #6617 corrigiu: CLAUDE.md crescendo
      # além do que o BUDGET comporta faria todo tick estourar e o
      # watchdog/consumidor leria "reset natural resolve" — nunca a correção
      # manual necessária (subir BUDGET ou cortar contexto).
      #
      # #6796: este é o ÚNICO classificador que ainda vê texto GERADO pelo
      # modelo (ATTEMPT_LOG = STDERR_ONLY_LOG + $OUT, e $OUT é a resposta do
      # modelo) — não dá pra migrar pro snapshot stderr-only como os outros
      # 2 (finding 2 do #6696), porque "Exceeded USD budget" é erro do CLI
      # que vai pro STDOUT (#6666), nunca pro stderr. O padrão anterior
      # ("exceeded.*budget|budget.*exceeded|too expensive|cost.*exceed") era
      # frouxo o bastante pra casar PROSA — este checkout roda tarefas que
      # discutem justamente orçamento/custo (#6712, #6716, #6791), então um
      # tick em que o modelo escreve "o job excedeu o budget" e morre com
      # rc≠0 disparava SAW_CONFIG_ERROR_SIGNAL espúrio (exit 4, pede correção
      # manual sobre modelos que estavam sãos). O CLI emite o texto literal
      # "Exceeded USD budget" (capitalização exata, confirmada nos comentários
      # acima e em #6666/#6712/test/hermes-budget-guard.test.ts) — casar só
      # essa string reduz a superfície a "o modelo reproduziu literalmente a
      # frase do CLI em inglês", muito mais raro que prosa PT-BR sobre custo.
      SAW_CONFIG_ERROR_SIGNAL=1
      echo "[claude-openrouter] falhou model=$MODEL rc=$RC: ORÇAMENTO EXCEDIDO (stdout: BUDGET=$BUDGET insuficiente para o contexto carregado) — permanente até o valor mudar, NÃO é rate-limit; próximo da cadeia; stderr cru em $STDERR_LOG" >&2
    elif [ $RC -eq 0 ]; then
      echo "[claude-openrouter] falhou model=$MODEL: saída VAZIA com rc=0 (sessão terminou sem texto final) — próximo da cadeia; stderr cru em $STDERR_LOG" >&2
    else
      echo "[claude-openrouter] falhou model=$MODEL rc=$RC — sem sinal claro de quota nem de modelo inválido; próximo da cadeia; stderr cru em $STDERR_LOG" >&2
    fi
  rm -f "$ATTEMPT_LOG" "$STDERR_ONLY_LOG"
done

# #6617 review finding 2: qualquer sinal de config inválida em QUALQUER
# modelo da cadeia já é acionável — não esperar que NENHUM modelo tenha
# mostrado sinal de quota. MODELS_DEFAULT mistura :free com pago; é bem
# possível que o modelo pago bata rate-limit real enquanto um :free tem id
# morto no mesmo run, e nesse caso misturar os dois sob exit 1 mascararia de
# novo o exato incidente que esta issue corrige.
if [ "$SAW_CONFIG_ERROR_SIGNAL" -eq 1 ]; then
  if [ "$SAW_QUOTA_SIGNAL" -eq 1 ]; then
    echo "ERRO: todos os modelos da cadeia falharam — sinais MISTOS (config inválida em pelo menos 1 modelo, quota/rate-limit em outro). Tratando como config inválida: não assumir que o reset de cota resolve sozinho." >&2
  else
    echo "ERRO: todos os modelos da cadeia falharam — sinal de CONFIG INVÁLIDA (model id que o provedor não reconhece), NÃO de rate-limit. Não vai se resolver sozinho no reset de cota; corrigir MODELS_DEFAULT/--model." >&2
  fi
  exit 4
fi
echo "ERRO: todos os modelos da cadeia falharam" >&2
exit 1
