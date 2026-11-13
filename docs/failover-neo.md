# Contingência do 300 no Neo (#12982)

O `300` roda todas as tasks agendadas `Diaria-*` (systemd). Desde o #5074,
nenhuma delas roda no Windows. Este runbook descreve a **exceção temporária e
explícita** a essa política: enquanto o `300` estiver fora do ar, o Neo
assume só o essencial e devolve tudo quando ele voltar. No regime normal, nada
aqui está armado.

## O que o Neo assume

Só as tasks do registro (`scripts/lib/scheduled-tasks.ts`) com
`failover: "critical"`: horário público ou envio a terceiros, com perda visível
ao leitor.

| Task | Por que é `critical` |
| --- | --- |
| `Diaria-Shorts-Instagram` (+ `-Catchup`) | publica o Reels do vertical no horário |
| `Diaria-Shorts-LinkedIn-Profile` (+ `-Catchup`) | publica o vertical no LinkedIn pessoal |
| `Diaria-Shorts-Threads-Profile` (+ `-Catchup`) | publica o vertical no Threads pessoal |
| `Diaria-Shorts-Cortes` | publica os cortes avulsos que a API não agenda |
| `Diaria-Video-D1-Link-Watch` | põe o link do vídeo no D1 e nos posts do D1 até 10:00 |
| `Diaria-Clarice-Novos` / `-Tarde` | envio aos cadastros novos da Clarice |
| `Diaria-Clarice-Envio` | agenda a onda Clarice do dia seguinte |
| `Diaria-Clarice-Envio-Guard` | freio de risco antes do disparo da onda (acompanha o Envio) |
| `Diaria-Circle-Stack-Weekly-Publish` | envio semanal da Stack, segunda 06:00 |
| `Diaria-Onboarding-Welcome-Run` | e-mails de boas-vindas |
| `Diaria-Onboarding-Watch-Returning` | impede boas-vindas repetidas a quem volta (acompanha o Welcome-Run) |

O resto fica parado:

- `catchup` (syncs, snapshots, ingests, uploads de conversão): recuperam o
  atraso sozinhos quando o `300` volta.
- `skip` (alarmes, drift, staleness, higiene, e o overnight
  `Diaria-Nightly-Chain`): nada a recuperar.
- Fora do registro e também parados: Hermes (`hermes-diaria-continuo`) e o
  túnel do Studio. O editor usa o Studio local no Neo; o backlog de issues
  espera.

## Pré-requisitos no Neo

- Checkout principal do repo (nunca um worktree `.claude/worktrees/...`; o
  `--arm` recusa) em `master` e em dia com `origin/master`. As tarefas do Neo
  **não** fazem o sync de código que o runner faz no `300` (o checkout é o de
  trabalho do editor); atualize à mão (`git pull --ff-only`) antes de armar.
- **Enquanto armado, o checkout principal fica em `master`.** As tarefas rodam
  o código que estiver nele: trabalho em branch vai para um worktree, nunca
  para um `git checkout` no principal.
- `npm ci` feito, `data/` acessível (Drive da diaria.editor) e o `.env` com
  `CLOUDFLARE_ACCOUNT_ID` e `CLOUDFLARE_WORKERS_TOKEN` (KV `diaria-ops-state`),
  além das credenciais de cada canal. As tarefas do Neo passam o `.env` aos
  passos (no Task Scheduler não há `EnvironmentFile`). Prontidão completa:
  ver § Prontidão abaixo (#12983).
- Fuso: o registro está em horário de Brasília. Se o Neo estiver em outro fuso,
  o `--arm` converte pelo offset do momento e avisa; mudou o fuso, arme de novo.
- O Neo precisa ficar ligado e **com o editor logado**: as tarefas rodam como
  o usuário logado (sem sessão aberta, nada roda). Com `StartWhenAvailable`,
  uma execução perdida durante a suspensão roda ao acordar.

## Prontidão (#12983)

`scripts/failover/neo-readiness.ts` diz, para cada task `critical`, se ela
rodaria no Neo agora: uma linha `pronto` / `falta X`. Sem `--record` não
escreve nada. `--record` só grava rodando no Neo (fora dele sai 2, salvo
`--force`): o alarme lê o registro como o estado do Neo.

```
npx tsx scripts/failover/neo-readiness.ts            # tabela; exit 1 se falta algo
npx tsx scripts/failover/neo-readiness.ts --json     # relatório completo
npx tsx scripts/failover/neo-readiness.ts --record   # também grava no KV
```

O que confere (cada checagem isolada; a que falha não derruba as outras, e a
que lança vira falta, nunca "não verificado"):

- os scripts dos passos existem e o arquivo do `guard` da task existe em `data/`;
- os segredos de cada script estão no `.env` do checkout. Só o `.env` conta:
  é o que as tarefas do Neo recebem (o ambiente da sessão, onde o app injeta
  variáveis como `GOOGLE_*`, não chega a elas); presente só no ambiente é
  falta, com aviso. Contra o Doppler, só presença: ele é consultado com
  `--only-names`, nenhum valor é lido do vault nem impresso. Presente só no
  Doppler é falta (`.env` atrasado: `npm run sync-env`); presente só no `.env`
  é ok, com aviso (o próximo `sync-env` aborta por chave só-local, #5155). A lista por script fica em
  `CRITICAL_SCRIPT_REQUIREMENTS` (`scripts/lib/failover/neo-readiness.ts`),
  feita à mão a partir do que cada script lê, mais as credenciais do KV do
  lease para todas;
- `data/` acessível (senão, falta) e recebendo o sync: mtime dos logs das
  tasks `failover: "skip"`, que só o `300` escreve. O mtime de `data/`
  inteiro não serve, porque a própria sessão do Neo escreve ali (o
  `run-log.jsonl` do Passo 0). Sem log achado, ou sem log novo há 72 h, sai
  "não verificado": com o `300` fora o sinal envelhece por definição;
- Node contra o `.nvmrc` e `node_modules` contra o `package-lock.json`;
- `gh auth status`;
- checkout principal em `master` e não atrás do `origin/master` (do último
  fetch; o script não busca);
- tokens em modo leitura: LinkedIn pessoal (`GET /v2/userinfo`) e Threads
  pessoal (lista os posts da última hora). O Instagram sai "não verificado":
  não há helper de leitura exportado para ele, e o check não inventa chamada.
  "Não verificado" só sai por desenho (sem helper, `--offline`, Doppler
  fora, `data/` sem sinal de sync, prazo do Passo 0) e não impede `pronto`.
  Falha do próprio coletor (checagem esperada que não veio, script sem mapa
  de segredos, exceção) é falta.

**Quando roda:** no Passo 0 de `/diaria-edicao`, se a sessão é no Neo
(hostname, `isNeoMachine`), com `--if-neo --record`: grava no KV
`diaria-ops-state`, chave `infra:neo-readiness`, imprime uma linha de resumo e
sai sempre 0. Nesse modo os tetos são curtos (spawn 12 s, fetch 8 s) e há um
prazo global de 30 s: as checagens que sobrarem saem "não verificado"
("pulada por prazo"). Sem task no Windows: nenhuma 2ª exceção ao #5074. Rode também à
mão antes do `--arm`.

**Alarme:** `Diaria-Neo-Readiness-Alarm` (diária, 11:42, no `300`,
`scripts/neo-readiness-alarm.ts`) lê a chave e abre issue (P2, família
`estado`: fecha sozinha quando a condição some) se o último check tiver mais
de 7 dias, nunca tiver sido gravado, não vier do Neo, estiver vermelho (falhas
comuns listadas uma vez; comenta só quando muda o conjunto de task + checagem
em falta) ou trouxer o mesmo item "não verificado" transitório em 4 checks
seguidos (Doppler deslogado, token sem resposta por rede/5xx, prazo, `data/`
sem sync). Limite permanente do check (Instagram sem helper, `--offline`) não
conta: abriria uma issue que nunca fecha. Falha ao ler o KV
sai 1 sem mexer em nada; registro corrompido conta como ausente e abre a
issue.

## 1. Confirmar a queda

- `ping` / `ssh` no `300` por IP sem resposta.
- Sinal da #12981 (`infra:300:down-since` no KV): ainda não existe, então na
  prática só o `--arm --force` faz o Neo assumir. Quando existir,
  `npx tsx scripts/failover/neo-takeover.ts --status` mostra.

## 2. Armar

```
npx tsx scripts/failover/neo-takeover.ts --arm --dry-run   # confere o plano (avisa se o arm real exigiria --force)
npx tsx scripts/failover/neo-takeover.ts --arm --force     # queda confirmada à mão (o caso de hoje)
npx tsx scripts/failover/neo-takeover.ts --arm             # com o sinal da #12981, quando existir
```

O `--arm` para e remove as `Diaria-Failover-*` antigas, registra as atuais e
então grava o lease `infra:scheduler-owner` para o Neo (6 h, renovado pelas
próprias tarefas). Lease que não confirma desfaz o registro das tarefas (e
apaga o lease, salvo se a releitura mostrar o do `300`).

## 3. Conferir

```
npx tsx scripts/failover/neo-takeover.ts --status
```

Mostra as tarefas armadas, o dono do lease e o sinal de queda. Execução que
roda loga no `data/` da task, como no `300`. A decisão do gate
(`[failover neo] ...`) sai só no stdout/stderr do processo, antes do log da
task, e **o Task Scheduler descarta stdout/stderr**: uma run que cedeu não
deixa rastro no `data/`.

Última execução com resultado `0x1` no Task Scheduler: pode ser o gate
(KV ilegível, lease ausente sem sinal, task fora do tier) ou a própria task.
Para ver a mensagem, rode à mão na raiz do repo, igual à tarefa:

```
node --import tsx scripts\run-task.ts --task Diaria-Shorts-Instagram --failover-standby
```

Neo suspenso por mais de 6 h: o lease do Neo expira, e a primeira tarefa ao
acordar retoma o próprio lease expirado. Se o `--status` mostrar o lease
ausente ou do `300` com o `300` ainda fora, rode `--arm --force` de novo.

## 4. Antes de desarmar

Com o `300` de volta e **antes** do `--disarm`, confirmar que o `data/` do
`300` já recebeu o que o Neo gravou (stores de Shorts, Clarice, onboarding):
o `data/` replicado pode chegar atrasado, e o `300` age pelo que vê no
`data/` dele. Só então desarmar.

## 5. Desarmar

```
npx tsx scripts/failover/neo-takeover.ts --disarm
```

Para as `Diaria-Failover-*` em execução (espera até 60 s), remove as tarefas
e libera o lease (só se for do Neo). As tasks do `300` retomam na próxima
execução. Remoção que falha não libera o lease; KV ilegível sai 1 e diz até
quando o lease vale. Se o Neo morreu armado e não dá para rodar o `--disarm`
nele, o mesmo comando em outra máquina com o `.env` libera só o lease; sem
isso, o `300` retoma quando o lease expira (até 6 h).

O `300` de pé cedendo ao lease do Neo aparece no journal como WARN. Se o lease
do Neo for renovado com o `300` no ar (o Neo seguiu armado), as tasks
`critical` do `300` saem 1 com "300 de pé cedendo para o Neo: rode
`neo-takeover.ts --disarm`", e o `Diaria-Systemd-Failed-Units-Alarm` avisa.

## 6. Depois

- Conferir os logs das tasks `catchup` do `300` na primeira rodada após a
  volta (Clarice-Sync, Kit-Roster-Ingest, GA4, ingests de ads, snapshots).
  `Meta-Capi-Confirmations-Send` recupera 7 dias; uma queda maior perde
  confirmação.

## Como o lease evita a duplicação

`scripts/lib/failover/scheduler-lease.ts`. O gate fica no ponto de entrada
comum (`scripts/run-task.ts`), não em cada script:

- Lease ativo de outra máquina: a task cede (exit 0, nada roda; no `300`, WARN
  no stderr).
- Lease ausente ou expirado: o `300` assume. O Neo retoma o próprio lease
  expirado; lease ausente ou do `300` expirado, só com o sinal de queda
  presente (sem ele, sai 1: o Neo está armado sem posse).
- Falha do KV: o `300` age (fail-open, ele é o dono padrão e o regime normal
  não pode depender do KV), salvo se o último lease que ele leu (memória
  local, `~/.diaria/failover-last-lease.json`) era do Neo: aí fica parado até
  ler o KV. O Neo não age (fail-closed, exit 1). Falha só na renovação de um
  lease próprio ativo é aviso: a task roda.
- Task `critical` no Windows sem `--failover-standby` é recusada.
- Kill switch, só no `300`: `DIARIA_FAILOVER_LEASE=off`.

O KV não tem escrita condicional; depois de gravar, a task relê e só age se o
lease relido é o dela. A idempotência de cada canal (store de publicação,
dedup) segue como segunda camada.

## Ensaio (critério de pronto da #12982)

**Tem efeito real:** as tarefas do Neo publicam e enviam de verdade. Escolha
uma hora sem Short nem corte pendente e fora das janelas da Clarice
(Novos 09:00/18:00, Envio) e do onboarding, e mantenha o ensaio abaixo de 3 h
(depois disso o Neo renova o lease e o `300` passa a sair 1, ver §5).

Com o `300` de pé: `--arm --force` no Neo; na hora seguinte, o log de uma
task `critical` horária no `300` (ex.: `Diaria-Shorts-Instagram-Catchup`,
`journalctl --user -u diaria-shorts-instagram-catchup.service`) mostra
`[failover 300] ... lease ativo do neo ...; 300 cede`, e a mesma tarefa no Neo
roda. `--disarm` devolve: a próxima execução no `300` volta a agir.
