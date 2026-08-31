# hermes/ — código do Hermes que opera ESTE repo (fonte canônica)

Skill e scripts do agente Hermes (`helios`) que dirigem a fila técnica da
diária. **Este diretório é a fonte da verdade**; os paths que o Hermes lê
apontam pra cá (decisão do editor, 28/08/2026) — mas de duas formas
DIFERENTES, não confundir uma com a outra:

```
~/.hermes/skills/productivity/hermes-diaria-continuo  ->  hermes/skills/hermes-diaria-continuo   (symlink de verdade)
~/.hermes/scripts/claude-openrouter.sh                 →  hermes/scripts/claude-openrouter.sh    (STUB com exec, NÃO symlink)
~/.hermes/scripts/opus-daily-diff-review.sh            →  hermes/scripts/opus-daily-diff-review.sh   (STUB)
~/.hermes/scripts/continuo-pr-review.sh                →  hermes/scripts/continuo-pr-review.sh       (STUB)
~/.hermes/scripts/hermes-model-cost-report.py          →  hermes/scripts/hermes-model-cost-report.py (STUB)
~/.hermes/scripts/monitor-cron-model-rotation.py       →  hermes/scripts/monitor-cron-model-rotation.py (STUB)
~/.hermes/scripts/pause-cron-on-ratelimit.py           →  hermes/scripts/pause-cron-on-ratelimit.py     (STUB)
```

**Achado ao vivo, #6865 (31/08/2026) — o vínculo em `~/.hermes/scripts/`
NUNCA é `ln -s`.** O guard de traversal do cron do Hermes rejeita symlink
que resolve pra fora de `~/.hermes/scripts/` — um `ln -sfn
.../hermes/scripts/X.sh ~/.hermes/scripts/X.sh` literal faz o job falhar
(silenciosamente, na próxima execução, sem ligar o erro à mudança que o
causou). O padrão certo é um STUB, arquivo real dentro de
`~/.hermes/scripts/` que só reexeca o script daqui:

```bash
#!/usr/bin/env bash
# STUB (nao symlink): o guard de traversal do cron do Hermes rejeita symlink
# que resolve fora de ~/.hermes/scripts. Fonte canonica no repo (hermes/).
exec /home/vjpixel/diaria-studio/hermes/scripts/<script>.sh "$@"
```

Só a SKILL (`hermes-diaria-continuo`, primeira linha da tabela acima) usa
symlink de verdade — o guard de traversal do cron se aplica a `--script`
de job (o que dispara os scripts abaixo), não ao carregamento de skill.

Por quê aqui e não só em `~/.hermes`: fora do git a skill envelhecia sem
review nem teste — foi a raiz do bug das 5-vs-6 categorias do
`classifyExecTrack` (a cópia em prosa não conheceu `epica`/#6201) e do quase-
remoção da infra do kind `continuo` (#6059, ver
`test/continuo-infra-consumidor-externo.test.ts`). Aqui dentro, mudança na
skill é PR revisado — inclusive pelo review Opus diário
(`opus-daily-diff-review.sh`), que ela mesma agenda.

**#6865 (31/08/2026) — dois scripts de review, dois papéis, separados por
decisão do editor (não trocar o modelo de um só), AMBOS ATIVOS:**
`opus-daily-diff-review.sh` (renomeado de `daily-consolidated-review.sh` —
com dois scripts de review no diretório, o nome genérico deixou de
distinguir qual é qual) segue 1x/dia, Opus, varredura do diff ACUMULADO do
dia — cadência e modelo INALTERADOS, só o nome ficou mais específico
(job `645d5debb7f0`, mesmo job de antes, só o `--script` do stub mudou de
alvo). `continuo-pr-review.sh` é NOVO: Sonnet, `every 240m`, review de UMA
PR aberta `continuo/*` por vez (não o diff do dia) — existe pra fechar o
descompasso 12:1 entre o contínuo (`every 120m`) e o revisor antigo
(`0 12 * * *`, ver #6849/#6864/#6865) sem trocar o modelo do review
profundo diário por um mais barato (job `3330b108a5b2`). **NUNCA
mergeia** (só posta comentário de review) — o pickup de PR órfã do
contínuo (`hermes-diaria-continuo/SKILL.md` §3, #6823/#6864) continua
sendo o ÚNICO ponto de merge, evitando a corrida que o guard do #5716
existe pra prevenir (dois processos mergeando a mesma PR). O antigo
`~/.hermes/scripts/daily-consolidated-review.sh` foi aposentado como
`daily-consolidated-review.sh.retired-260831` (não apagado — histórico).

Recriar numa máquina nova (só o `helios` roda o Hermes hoje) — skill via
symlink, scripts via stub:

```bash
ln -sfn /home/vjpixel/diaria-studio/hermes/skills/hermes-diaria-continuo \
  ~/.hermes/skills/productivity/hermes-diaria-continuo

for f in claude-openrouter.sh opus-daily-diff-review.sh continuo-pr-review.sh \
         hermes-model-cost-report.py monitor-cron-model-rotation.py \
         pause-cron-on-ratelimit.py; do
  cat > ~/.hermes/scripts/$f <<STUB
#!/usr/bin/env bash
# STUB (nao symlink): o guard de traversal do cron do Hermes rejeita symlink
# que resolve fora de ~/.hermes/scripts. Fonte canonica no repo (hermes/).
exec /home/vjpixel/diaria-studio/hermes/scripts/$f "\$@"
STUB
  chmod +x ~/.hermes/scripts/$f
done
```

Cuidado: `hermes cron --script`/`monitor_script` referencia o nome do
STUB sob `~/.hermes/scripts/` — não renomear os arquivos (nem o stub, nem
o alvo no repo) sem atualizar os jobs em paralelo
(`opus-daily-diff-review.sh` → job `645d5debb7f0`; `continuo-pr-review.sh`
→ job `3330b108a5b2`; `monitor-cron-model-rotation.py` → jobs
`496cd687d3e0`/`86303d0ed84b`; `pause-cron-on-ratelimit.py` → jobs
`c3ac9f22c347`/`2cb556b0c30d`).
