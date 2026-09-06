#!/usr/bin/env bash
# Fase 2 — bateria sintética em todos os candidatos, EM SÉRIE.
#
# Série e não paralelo de propósito: há uma única GPU. Subagentes
# concorrentes disputariam o mesmo recurso serial e produziriam justamente
# as medições contaminadas que o guard de ociosidade existe para evitar.
#
# ESCADA DE num_ctx, e não um alvo fixo. A 1ª versão fixava 131072 para
# todos e mandava a sonda de janela em cima. Medido: o phi4-mini a 131072
# fica com 20,78 GB residentes e só 24% em VRAM — sondar a janela de um
# modelo 76% na CPU custa horas para descobrir o que a carga já disse. E a
# pergunta que decide não é "cabe 128k?" (quase nunca cabe), é "QUANTA
# janela este modelo entrega dentro de 6 GB?" — que é a forma medível de
# "janela vence parâmetros".
#
# A escada é barata: cria a variante, força o load com 1 token, lê o split
# GPU/CPU em /api/ps, desce um degrau se transbordou. Segundos por degrau,
# contra horas de prefill.
set -u
cd ~/model-bench

# `num_gpu 999` em toda variante: sem ele o Ollama decide o split sozinho e
# retém camadas na CPU por conservadorismo. A 1ª passada da escada mediu
# ONDE O OLLAMA ESCOLHEU alocar tudo, não onde o modelo CABE — e como o
# Modelfile de produção (`qwen-64k`) tem num_gpu 999, os candidatos foram
# comparados em desvantagem contra o baseline. Medido: qwen3.5:4b a 65.536
# fica em 77% da VRAM sem a flag.
#
# `num_batch 512` pelo mesmo motivo: o buffer de computação escala com ele,
# e o Modelfile de produção o fixa. Sem replicar, a variante de bench pesa
# ~0,29 GB a mais que o modelo real na MESMA janela — diferença que decide
# se um degrau cabe ou não.
#
# REGRA GERAL, aprendida em 3 iterações desta escada (alvo fixo -> num_gpu
# -> num_batch): toda comparação contra o baseline tem que replicar TODOS os
# parâmetros de memória do Modelfile de produção, variando só o modelo e o
# num_ctx. Parâmetro não replicado vira desvantagem silenciosa do candidato.

ESCADA=${ESCADA:-"131072 98304 65536 49152 32768 16384"}
CANDIDATOS=${CANDIDATOS:-"phi4-mini:3.8b ministral-3:3b qwen3:4b llama3.2:3b granite4:3b"}

# Split GPU/CPU do modelo carregado: imprime "<pct em vram> <GB residente>".
split_vram() {
  curl -s http://127.0.0.1:11434/api/ps | python3 -c '
import sys, json
ms = json.load(sys.stdin).get("models", [])
if not ms:
    print("0 0"); raise SystemExit
m = ms[0]; tot = m.get("size", 0); vram = m.get("size_vram", 0)
print(f"{100*vram/tot if tot else 0:.0f} {tot/1e9:.2f}")
' 2>/dev/null || echo "0 0"
}

for M in $CANDIDATOS; do
  echo "################ $M ################"
  CABE=""
  for CTX in $ESCADA; do
    TAG="bench-tmp"
    printf 'FROM %s\nPARAMETER num_ctx %s\nPARAMETER num_predict 2048\nPARAMETER temperature 0.3\n' \
      "$M" "$CTX" > /tmp/bench.Modelfile
    ollama create "$TAG" -f /tmp/bench.Modelfile > /dev/null 2>&1
    curl -s http://127.0.0.1:11434/api/generate \
      -d "{\"model\":\"$TAG\",\"prompt\":\"oi\",\"stream\":false,\"options\":{\"num_predict\":1}}" \
      > /dev/null 2>&1
    read -r PCT GB <<< "$(split_vram)"
    printf '  num_ctx %-7s residente %5s GB  em VRAM %3s%%%s\n' \
      "$CTX" "$GB" "$PCT" "$([ "$PCT" -ge 99 ] 2>/dev/null && echo '  <== CABE' || echo '')"
    ollama stop "$TAG" > /dev/null 2>&1
    if [ "${PCT:-0}" -ge 99 ] 2>/dev/null; then CABE="$CTX"; break; fi
  done

  if [ -z "$CABE" ]; then
    echo "  DESCARTADO: nao cabe inteiro na VRAM nem no menor degrau da escada"
    echo; continue
  fi

  # Fixa a variante que coube e mede em cima dela.
  TAG="bench-$(echo "$M" | tr ':/.' '---')"
  printf 'FROM %s\nPARAMETER num_ctx %s\nPARAMETER num_predict 2048\nPARAMETER temperature 0.3\n' \
    "$M" "$CABE" > "/tmp/$TAG.Modelfile"
  ollama create "$TAG" -f "/tmp/$TAG.Modelfile" > /dev/null 2>&1
  echo "  --> maior num_ctx que cabe: $CABE  (variante $TAG)"

  echo "--- janela útil real (sonda, nao confia no num_ctx) ---"
  python3 -u probe.py window --model "$TAG" --max-tokens "$CABE" \
    --min-tokens 12000 --tolerance 8000 2>&1 | tail -3

  # Velocidade na MAIOR janela que o modelo comporta, não num 32k fixo:
  # medir a 32k um modelo que só cabe em 16.384 excede a janela dele e o
  # número deixa de descrever o que se quis medir. Teto de 32k para manter
  # comparabilidade com o baseline do qwen.
  CTX_VEL=$([ "$CABE" -lt 32768 ] && echo "$CABE" || echo 32768)
  echo "--- velocidade a ${CTX_VEL} ---"
  python3 -u probe.py speed --model "$TAG" --ctx "$CTX_VEL" 2>&1 | tail -10

  echo "--- aderência ---"
  python3 -u adherence.py --model "$TAG" --repeats 2 2>&1 | tail -4

  ollama stop "$TAG" > /dev/null 2>&1
  echo
done
echo "################ FASE 2 CONCLUIDA ################"
