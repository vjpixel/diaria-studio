# hermes/ — código do Hermes que opera ESTE repo (fonte canônica)

Skill e scripts do agente Hermes (`300`) que dirigem a fila técnica da
diária. **Este diretório é a fonte da verdade**; os paths que o Hermes lê
apontam pra cá (decisão do editor, 28/08/2026) — mas de duas formas
DIFERENTES, não confundir uma com a outra:

```
~/.hermes/skills/productivity/hermes-diaria-continuo  ->  hermes/skills/hermes-diaria-continuo   (symlink de verdade)
~/.hermes/scripts/claude-delegate.sh                   →  hermes/scripts/claude-delegate.sh    (STUB com exec, NÃO symlink)
~/.hermes/scripts/opus-daily-diff-review.sh            →  hermes/scripts/opus-daily-diff-review.sh   (STUB)
~/.hermes/scripts/continuo-pr-review.sh                →  hermes/scripts/continuo-pr-review.sh       (STUB)
~/.hermes/scripts/hermes-model-cost-report.py          →  hermes/scripts/hermes-model-cost-report.py (STUB)
~/.hermes/scripts/monitor-cron-model-rotation.py       →  hermes/scripts/monitor-cron-model-rotation.py (STUB)
~/.hermes/scripts/pause-cron-on-ratelimit.py           →  hermes/scripts/pause-cron-on-ratelimit.py     (STUB)
~/.hermes/scripts/detect-context-truncation.py          →  hermes/scripts/detect-context-truncation.py  (STUB, #7528)
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

## Como estes scripts falam com o editor (`no_agent=True`)

**Os 3 jobs de cron que rodam scripts daqui têm `no_agent: true` — o campo
`prompt` do job NÃO é lido por ninguém.** É o erro mais fácil de cometer
aqui: o job `3330b108a5b2` carregava um prompt dizendo "entregue um resumo
de NO MÁXIMO 2 linhas" e mesmo assim despejava o progresso inteiro no
Telegram todo tick, porque nesse modo não existe agente pra ler prompt
nenhum. Pedir brevidade no prompt de um job `no_agent` não tem efeito.

O contrato real, implementado em `cron/scheduler.py` do Hermes:

| canal do script | o que acontece |
| --- | --- |
| **stdout** | entregue **verbatim** no Telegram |
| **stdout vazio** | tick **silencioso** — nenhuma mensagem |
| **stderr** | descartado, **exceto** quando o script sai não-zero (aí vai junto no alerta de erro) |
| **exit ≠ 0** | alerta "watchdog quebrou", com stdout + stderr anexados |

Daí a política dos 3 scripts (editor, 19/09/2026 — *"só receber mensagem se
algum problema estiver acontecendo"*): **rodada saudável escreve nada em
stdout.** Progresso e linhas "ok" vão pro log (stderr, ou um arquivo em
`data/` no caso do `watch-continuo-health.sh`, cujo stderr fica reservado
pras anomalias que acompanham o exit 1). Quem quiser mudar o que é
entregue mexe no **fim do script**, nunca no prompt do job. Travado por
`test/hermes-cron-entrega-so-com-problema.test.sh`.

**Drift confirmado ao vivo, #6943 (01/09/2026): `~/.hermes/scripts/
claude-delegate.sh` era um SYMLINK de verdade no `300`, não o STUB
que esta tabela documenta.** Achado via transcript do tick das 12:06
(`preflight missing`, erro apontando pra `~/.hermes/scripts/lib/...`, um
caminho que só existe se `${BASH_SOURCE[0]}` resolveu pro symlink em vez
do arquivo real — exatamente o padrão de falha de um `source` relativo
através de symlink). O guard de traversal do cron não pegou porque ele
audita o path do `--script` do JOB (que aponta pra dentro de
`~/.hermes/scripts/`, válido), não se ESSE arquivo em si é um symlink pra
fora — os dois são checagens diferentes. Consequência: 8 de 11 ticks do
contínuo perdidos no dia (#6922). Tentativa de trocar o symlink por stub
foi bloqueada pelo classificador de permissão da sessão que investigou;
não insistiu, ficou pro editor decidir. O fix do lado do REPO (#6943 —
`readlink -f` antes do `dirname` nos `source` afetados) faz a resolução
funcionar pros DOIS formatos, então este drift específico deixou de
quebrar o pipeline — mas o deploy real de `claude-delegate.sh` ainda
não foi convertido pra stub; esta tabela descreve o estado PRETENDIDO,
não confirmado como o atual pra esta linha.

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
alvo). `continuo-pr-review.sh` é NOVO: Sonnet, cron próprio (job
`3330b108a5b2`; cadência: derivar com `hermes cron list --all`, nunca esta
prosa — esta entrada registrava "every 240m" e um descompasso "12:1"
derivados de cadências erradas, corrigidos no #6928), review de UMA
PR aberta `continuo/*` por vez (não o diff do dia) — existe pra dar ao
contínuo um revisor externo separado do tick (ver #6849/#6864/#6865)
sem trocar o modelo do review
profundo diário por um mais barato. **NUNCA
mergeia** (só posta comentário de review) — o pickup de PR órfã do
contínuo (`hermes-diaria-continuo/SKILL.md` §3, #6823/#6864) continua
sendo o ÚNICO ponto de merge, evitando a corrida que o guard do #5716
existe pra prevenir (dois processos mergeando a mesma PR). O antigo
`~/.hermes/scripts/daily-consolidated-review.sh` foi aposentado como
`daily-consolidated-review.sh.retired-260831` (não apagado — histórico).

Recriar numa máquina nova (só o `300` roda o Hermes hoje) — skill via
symlink, scripts via stub:

```bash
ln -sfn /home/vjpixel/diaria-studio/hermes/skills/hermes-diaria-continuo \
  ~/.hermes/skills/productivity/hermes-diaria-continuo

for f in claude-delegate.sh opus-daily-diff-review.sh continuo-pr-review.sh \
         hermes-model-cost-report.py monitor-cron-model-rotation.py \
         pause-cron-on-ratelimit.py detect-context-truncation.py; do
  cat > ~/.hermes/scripts/$f <<STUB
#!/usr/bin/env bash
# STUB (nao symlink): o guard de traversal do cron do Hermes rejeita symlink
# que resolve fora de ~/.hermes/scripts. Fonte canonica no repo (hermes/).
exec /home/vjpixel/diaria-studio/hermes/scripts/$f "\$@"
STUB
  chmod +x ~/.hermes/scripts/$f
done
```

## Registro de sessão do tick, deterministicamente (#8740, 24/09/2026)

`hermes/scripts/register-continuo-tick.sh` — script NOVO, ainda **sem**
deploy no `300` — registra `session-registry.ts register --kind continuo`
ANTES do tick do job `5d791ef6fc2c` (agente), em vez de depender do passo
1.3 da skill (que só roda se o tick sobreviver até lá — não rodou no tick
`cron_5d791ef6fc2c_20260923_004012`, que bateu rate-limit antes, #8740).
Diferente dos scripts `no_agent: true` da tabela acima, `5d791ef6fc2c` **é**
um job de agente (carrega a skill via prompt) — este script não substitui
o job, é um passo a rodar ANTES dele; como amarrar isso na config do cron
do Hermes (`jobs.json`, `pre_hook`/job irmão dedicado, ou o mecanismo que
`hermes cron` de fato suportar) é ação manual fora deste repo, pendente.
Até lá, o passo 1.3 da skill segue com o fallback de sempre (gerar e
registrar o `SESSION_ID` na hora) — ver `SKILL.md` §1.3 e a docstring do
script.

Cuidado: `hermes cron --script`/`monitor_script` referencia o nome do
STUB sob `~/.hermes/scripts/` — não renomear os arquivos (nem o stub, nem
o alvo no repo) sem atualizar os jobs em paralelo
(`opus-daily-diff-review.sh` → job `645d5debb7f0`; `continuo-pr-review.sh`
→ job `3330b108a5b2`; `monitor-cron-model-rotation.py` → jobs
`496cd687d3e0`/`86303d0ed84b`; `pause-cron-on-ratelimit.py` → jobs
`c3ac9f22c347`/`2cb556b0c30d`).

## Modelo do tick agendado: o job ignora `model.default` (#6908)

O job do cron carrega `model` e `provider` **nos próprios campos** de
`~/.hermes/cron/jobs.json` — e esses vencem o `model.default` de
`~/.hermes/config.yaml`. Medido ao vivo no bench do #7602 (08/09/2026):
trocar só o `model.default` mudou o smoke por CLI, mas o
`cron run 5d791ef6fc2c` continuou disparando o modelo antigo. (O mesmo job
também carrega `reasoning_effort` — lido no `jobs.json` vivo em 10/09/2026:
`high` —, então esforço também não se ajusta pelo `config.yaml`.)

Consequência: **avaliar ou promover modelo mexendo só no `config.yaml` não
afeta o tick agendado** — que é justamente o workload que se quer medir.
Pra trocar o modelo do contínuo, alterar o job em `jobs.json` **só via
`npx tsx scripts/write-hermes-config.ts`** — o único verbo autorizado a
escrever config viva do Hermes, com backup/validação/revert (nunca
`Edit`/`Write` direto; ver `scripts/lib/hermes-runtime-sensitive-paths.ts`)
— e conferir depois pelo `billing_provider` de
`session_model_usage`, nunca pelo `hermes auth status` (que reporta estado
nominal, #7647). Estado vivo nunca se cita daqui: ler com
`hermes cron list --all` ou direto do `jobs.json`.
