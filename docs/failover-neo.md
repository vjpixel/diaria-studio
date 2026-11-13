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
- `skip` (alarmes, drift, staleness, higiene): nada a recuperar.
- Fora do registro e também parados: overnight (`Diaria-Nightly-Chain`),
  Hermes (`hermes-diaria-continuo`) e o túnel do Studio. O editor usa o
  Studio local no Neo; o backlog de issues espera.

## Pré-requisitos no Neo

- Checkout principal do repo (nunca um worktree `.claude/worktrees/...`; o
  `--arm` recusa) em dia com `origin/master`. As tarefas do Neo **não** fazem o
  sync de código que o runner faz no `300` (o checkout é o de trabalho do
  editor); atualize à mão (`git pull --ff-only`) antes de armar.
- `npm ci` feito, `data/` acessível (Drive da diaria.editor) e o `.env` com
  `CLOUDFLARE_ACCOUNT_ID` e `CLOUDFLARE_WORKERS_TOKEN` (KV `diaria-ops-state`),
  além das credenciais de cada canal. Prontidão completa: #12983.
- Fuso: o registro está em horário de Brasília. Se o Neo estiver em outro fuso,
  o `--arm` converte pelo offset do momento e avisa; mudou o fuso, arme de novo.
- O Neo precisa ficar ligado e com sessão aberta (as tarefas rodam como o
  usuário logado). Com `StartWhenAvailable`, uma execução perdida durante a
  suspensão roda ao acordar.

## 1. Confirmar a queda

- `ping` / `ssh` no `300` por IP sem resposta.
- Sinal da #12981 (`infra:300:down-since` no KV), quando existir:
  `npx tsx scripts/failover/neo-takeover.ts --status` mostra.

## 2. Armar

```
npx tsx scripts/failover/neo-takeover.ts --arm --dry-run   # confere o plano
npx tsx scripts/failover/neo-takeover.ts --arm             # com o sinal da #12981
npx tsx scripts/failover/neo-takeover.ts --arm --force     # sem o sinal (queda confirmada à mão)
```

O `--arm` remove as `Diaria-Failover-*` antigas, registra as atuais e então
grava o lease `infra:scheduler-owner` para o Neo (6 h, renovado pelas próprias
tarefas). Lease que não confirma desfaz o registro das tarefas.

## 3. Conferir

```
npx tsx scripts/failover/neo-takeover.ts --status
```

Mostra as tarefas armadas, o dono do lease e o sinal de queda. Execução que
roda loga no `data/` da task, como no `300`. A decisão do gate
(`[failover neo] ...`) sai só no stdout/stderr do processo, antes do log da
task: uma run que cedeu não escreve nada no `data/`. No Task Scheduler, a
última execução com resultado `0x1` é fail-closed (KV indisponível) ou task
fora do tier.

## 4. Desarmar quando o 300 voltar

```
npx tsx scripts/failover/neo-takeover.ts --disarm
```

Remove as `Diaria-Failover-*` e libera o lease (só se for do Neo). As tasks
do `300` retomam na próxima execução. Se o Neo morreu armado e não dá para
rodar o `--disarm` nele, o mesmo comando em outra máquina com o `.env` libera
só o lease; sem isso, o `300` retoma quando o lease expira (até 6 h).

## 5. Depois

- Conferir os logs das tasks `catchup` do `300` na primeira rodada após a
  volta (Clarice-Sync, Kit-Roster-Ingest, GA4, ingests de ads, snapshots).
  `Meta-Capi-Confirmations-Send` recupera 7 dias; uma queda maior perde
  confirmação.
- Conferir o que o Neo publicou contra os stores de cada canal (Shorts,
  Clarice, onboarding) antes de o `300` voltar a agir: o `data/` replicado pode
  chegar atrasado ao `300`.

## Como o lease evita a duplicação

`scripts/lib/failover/scheduler-lease.ts`. O gate fica no ponto de entrada
comum (`scripts/run-task.ts`), não em cada script:

- Lease ativo de outra máquina: a task cede (exit 0, nada roda).
- Lease ausente ou expirado: o `300` assume; o Neo só assume com o sinal de
  queda presente (sem ele, só pelo `--arm`).
- Falha do KV: o `300` age (fail-open, ele é o dono padrão e o regime normal
  não pode depender do KV); o Neo não age (fail-closed, exit 1).
- Kill switch, só no `300`: `DIARIA_FAILOVER_LEASE=off`.

O KV não tem escrita condicional; depois de gravar, a task relê e só age se o
lease relido é o dela. A idempotência de cada canal (store de publicação,
dedup) segue como segunda camada.

## Ensaio (critério de pronto da #12982)

Com o `300` de pé: `--arm --force` no Neo; na hora seguinte, o log de uma
task `critical` horária no `300` (ex.: `Diaria-Shorts-Instagram-Catchup`,
`journalctl --user -u diaria-shorts-instagram-catchup.service`) mostra `[failover 300] ... lease ativo do neo ...; 300 cede`, e a mesma
tarefa no Neo roda. `--disarm` devolve: a próxima execução no `300` volta a
agir.
