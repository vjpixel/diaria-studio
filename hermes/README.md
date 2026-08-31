# hermes/ — código do Hermes que opera ESTE repo (fonte canônica)

Skill e scripts do agente Hermes (`helios`) que dirigem a fila técnica da
diária. **Este diretório é a fonte da verdade**; os paths que o Hermes lê são
symlinks para cá (decisão do editor, 28/08/2026):

```
~/.hermes/skills/productivity/hermes-diaria-continuo  ->  hermes/skills/hermes-diaria-continuo
~/.hermes/scripts/claude-openrouter.sh                ->  hermes/scripts/claude-openrouter.sh
~/.hermes/scripts/opus-daily-diff-review.sh           ->  hermes/scripts/opus-daily-diff-review.sh
~/.hermes/scripts/continuo-pr-review.sh               ->  hermes/scripts/continuo-pr-review.sh
~/.hermes/scripts/hermes-model-cost-report.py         ->  hermes/scripts/hermes-model-cost-report.py
~/.hermes/scripts/monitor-cron-model-rotation.py      ->  hermes/scripts/monitor-cron-model-rotation.py
~/.hermes/scripts/pause-cron-on-ratelimit.py          ->  hermes/scripts/pause-cron-on-ratelimit.py
```

Por quê aqui e não só em `~/.hermes`: fora do git a skill envelhecia sem
review nem teste — foi a raiz do bug das 5-vs-6 categorias do
`classifyExecTrack` (a cópia em prosa não conheceu `epica`/#6201) e do quase-
remoção da infra do kind `continuo` (#6059, ver
`test/continuo-infra-consumidor-externo.test.ts`). Aqui dentro, mudança na
skill é PR revisado — inclusive pelo review Opus diário
(`opus-daily-diff-review.sh`), que ela mesma agenda.

**#6865 (31/08/2026) — dois scripts de review, dois papéis, separados por
decisão do editor (não trocar o modelo de um só):** `opus-daily-diff-
review.sh` (renomeado de `daily-consolidated-review.sh` — com dois scripts
de review no diretório, o nome genérico deixou de distinguir qual é qual)
segue 1x/dia, Opus, varredura do diff ACUMULADO do dia — cadência e modelo
INALTERADOS, só o nome ficou mais específico. `continuo-pr-review.sh` é
NOVO: Sonnet, ~4h, review de UMA PR aberta `continuo/*` por vez (não o
diff do dia) — existe pra fechar o descompasso 12:1 entre o contínuo
(`every 120m`) e o revisor antigo (`0 12 * * *`, ver #6849/#6864/#6865)
sem trocar o modelo do review profundo diário por um mais barato. **NUNCA
mergeia** (só posta comentário de review) — o pickup de PR órfã do
contínuo (`hermes-diaria-continuo/SKILL.md` §3 passo 3, #6823) continua
sendo o ÚNICO ponto de merge, evitando a corrida que o guard do #5716
existe pra prevenir (dois processos mergeando a mesma PR).

**Passo manual pendente, fora do escopo desta PR** (toca `~/.hermes`, fora
do repo): recriar o symlink de `opus-daily-diff-review.sh` (o antigo
`~/.hermes/scripts/daily-consolidated-review.sh` aponta pra um arquivo que
não existe mais neste repo até esse passo rodar), criar o symlink novo de
`continuo-pr-review.sh`, `hermes cron edit 645d5debb7f0 --script
opus-daily-diff-review.sh`, e `hermes cron create` pro job novo do
`continuo-pr-review.sh` (~4h). Ver comentário no topo de cada script pro
mesmo aviso.

Recriar os symlinks numa máquina nova (só o `helios` roda o Hermes hoje):

```bash
ln -sfn /home/vjpixel/diaria-studio/hermes/skills/hermes-diaria-continuo \
  ~/.hermes/skills/productivity/hermes-diaria-continuo
for f in claude-openrouter.sh opus-daily-diff-review.sh continuo-pr-review.sh \
         hermes-model-cost-report.py monitor-cron-model-rotation.py \
         pause-cron-on-ratelimit.py; do
  ln -sf /home/vjpixel/diaria-studio/hermes/scripts/$f ~/.hermes/scripts/$f
done
```

Cuidado: `hermes cron --script`/`monitor_script` referencia o nome sob
`~/.hermes/scripts/` — os symlinks preservam isso; não renomear os arquivos
sem atualizar os jobs (`opus-daily-diff-review.sh`, ex-`daily-consolidated-
review.sh` → job `645d5debb7f0`; `continuo-pr-review.sh` → job novo, sem ID
até criado via `hermes cron create`; `monitor-cron-model-rotation.py` →
jobs `496cd687d3e0`/`86303d0ed84b`; `pause-cron-on-ratelimit.py` → jobs
`c3ac9f22c347`/`2cb556b0c30d`).
