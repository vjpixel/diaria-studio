# hermes/ — código do Hermes que opera ESTE repo (fonte canônica)

Skill e scripts do agente Hermes (`helios`) que dirigem a fila técnica da
diária. **Este diretório é a fonte da verdade**; os paths que o Hermes lê são
symlinks para cá (decisão do editor, 28/08/2026):

```
~/.hermes/skills/productivity/hermes-diaria-continuo  ->  hermes/skills/hermes-diaria-continuo
~/.hermes/scripts/claude-openrouter.sh                ->  hermes/scripts/claude-openrouter.sh
~/.hermes/scripts/daily-consolidated-review.sh        ->  hermes/scripts/daily-consolidated-review.sh
~/.hermes/scripts/hermes-model-cost-report.py         ->  hermes/scripts/hermes-model-cost-report.py
```

Por quê aqui e não só em `~/.hermes`: fora do git a skill envelhecia sem
review nem teste — foi a raiz do bug das 5-vs-6 categorias do
`classifyExecTrack` (a cópia em prosa não conheceu `epica`/#6201) e do quase-
remoção da infra do kind `continuo` (#6059, ver
`test/continuo-infra-consumidor-externo.test.ts`). Aqui dentro, mudança na
skill é PR revisado — inclusive pelo review Opus diário
(`daily-consolidated-review.sh`), que ela mesma agenda.

Recriar os symlinks numa máquina nova (só o `helios` roda o Hermes hoje):

```bash
ln -sfn /home/vjpixel/diaria-studio/hermes/skills/hermes-diaria-continuo \
  ~/.hermes/skills/productivity/hermes-diaria-continuo
for f in claude-openrouter.sh daily-consolidated-review.sh hermes-model-cost-report.py; do
  ln -sf /home/vjpixel/diaria-studio/hermes/scripts/$f ~/.hermes/scripts/$f
done
```

Cuidado: `hermes cron --script` referencia o nome sob `~/.hermes/scripts/` —
os symlinks preservam isso; não renomear os arquivos sem atualizar os jobs
(`daily-consolidated-review.sh` → job `645d5debb7f0`).
