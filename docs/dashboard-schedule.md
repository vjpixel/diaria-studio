# Agendamento do push do diaria-dashboard (#2471)

A seção **Timeline overnight** (e as demais seções) do clarice-dashboard é um
snapshot pré-computado: o Worker só lê o KV; quem popula é
`scripts/build-diaria-dashboard-data.ts` (agrega `data/overnight/`, fontes de
saúde e CTR, então faz PUT no KV `dashboard`). Sem rodar o script com `--push`,
o KV fica stale e a seção Timeline permanent mostra os dados da última vez que o
push foi feito manualmente.

Decisão (2026-06-22): rodar **diariamente às 21:30 BRT** (logo após o crawl de
coortes das 21:00) via **agendador local do Windows** — o push depende das secrets
do `.env` desta máquina (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_TOKEN`),
que uma rotina em nuvem não teria. Requer a máquina ligada às 21h.

## Wrapper

`scripts/run-diaria-dashboard-push.cmd` — genérico (acha a raiz do repo via
`%~dp0`), preferindo `C:\Program Files\nodejs\node.exe` com fallback pro `node`
do PATH (Task Scheduler às vezes tem PATH reduzido). Cria `data/dashboard-push/`
se preciso e acrescenta stdout/stderr a `data/dashboard-push/task.log`.

**#3042: dois passos, não um.** Antes do push pro KV, o wrapper roda
`scripts/build-link-ctr.ts` (regenera `data/link-ctr-table.csv` a partir do
cache local de posts Beehiiv, modo incremental) — sem isso o CSV nunca era
reconstruído por nenhuma task agendada e ficava stale indefinidamente,
degradando silenciosamente o join de CTR em várias seções do dashboard (Use
Melhor, top-links, audience). Esse passo é **fail-soft**: `build-link-ctr.ts`
escreve o CSV com um único `writeFileSync` no final, então uma falha no meio
não corrompe o arquivo existente — só o deixa tão fresco quanto estava antes.
O wrapper loga o exit code mas não aborta o push por causa dele.

**#3060: `--full` é sempre manual, nunca agendado.** A task diária SEMPRE roda
`build-link-ctr.ts` em modo incremental (sem `--full`) — de propósito, reprocessar
os 200+ posts cacheados toda noite seria caro/lento à toa. Isso significa que
**qualquer mudança futura na lógica de extração de `build-link-ctr.ts`** (ex: como
o #3043 corrigiu a extração de `section_title`) só se aplica a posts NOVOS
processados depois do deploy — os já cacheados ficam com o dado extraído pela
lógica ANTIGA até alguém rodar o backfill manual:
```
npx tsx scripts/build-link-ctr.ts --full
npx tsx scripts/build-diaria-dashboard-data.ts --push --kv-namespace-id 4610c3016818483cab141f459a963de3
```
Sem esse passo manual pós-deploy, o fix "existe no código" mas não se reflete nos
dados históricos — foi exatamente o que aconteceu no #3037/#3043 (backfill de
0→60 rows Use Melhor feito manualmente na noite do deploy). Registrar aqui pra
não repetir o mesmo esquecimento na próxima correção de extração.

O namespace ID do KV (`4610c3016818483cab141f459a963de3`) é o de produção do
Worker `diaria-dashboard`; está embutido no `.cmd` para não precisar de env var
adicional (o mesmo valor que o operator usa com `--kv-namespace-id`).

## Registrar a Task (1× por máquina)

```powershell
$action  = New-ScheduledTaskAction  -Execute 'C:\Users\pixel\Projects\diaria-studio\scripts\run-diaria-dashboard-push.cmd'
$trigger = New-ScheduledTaskTrigger -Daily -At 9:30pm
Register-ScheduledTask -TaskName 'DiariaDashboardPush' -Action $action -Trigger $trigger `
  -Description 'Push diário dos dados do diaria-dashboard pro KV Cloudflare (#2471)' -Force
```

Ajustar o path do `-Execute` ao clone local. O `-At 9:30pm` é horário local da
máquina (timezone BRT = "E. South America Standard Time").

> **Nota:** rodar após o crawl de coortes (21:00) para que o KV inclua a rodada
> overnight mais recente, se houver.

## Operação

- **Disparar manualmente:** `Start-ScheduledTask -TaskName 'DiariaDashboardPush'`
  (ou rodar o script direto: `npx tsx scripts/build-diaria-dashboard-data.ts --push --kv-namespace-id 4610c3016818483cab141f459a963de3`).
- **Dry-run (sem tocar o KV):** `npx tsx scripts/build-diaria-dashboard-data.ts --dry-run`
  (default quando `--push` não está presente) — útil para validar a agregação antes do push.
- **Próxima execução:** `Get-ScheduledTask DiariaDashboardPush | Get-ScheduledTaskInfo`.
- **Logs:** `data/dashboard-push/task.log` (stdout+stderr do wrapper + exit code por rodada).

## Variáveis de ambiente necessárias

As credenciais precisam estar no `.env` do repo (ou como variáveis de usuário):

| Variável | Finalidade |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | ID da conta Cloudflare (para o PUT no KV) |
| `CLOUDFLARE_WORKERS_TOKEN` | Token da API Cloudflare com permissão de KV write |

O namespace ID do KV está embutido no `.cmd` (`--kv-namespace-id 4610c3016818483cab141f459a963de3`).
Alternativa (env-var): o script faz `--kv-namespace-id ?? process.env.DASHBOARD_KV_NAMESPACE_ID`,
então o **flag tem precedência**. Para usar o env var é preciso **primeiro remover o
`--kv-namespace-id` do `.cmd`** (senão o valor do env é silenciosamente ignorado) e
então setar `DASHBOARD_KV_NAMESPACE_ID` no `.env`.

## Estado (data/ é gitignored)

`data/dashboard-push/` guarda `task.log` (log append-only do wrapper).
Mora no OneDrive junto com o resto de `data/`.

## Modo local (#3563, endereça #3550) — sem KV/push, dado sempre fresco

Além do Worker remoto (snapshot do último push, acima), o **studio-server**
(`npx tsx scripts/studio-ui/server.ts` / `npm run studio`) serve o MESMO
dashboard como painel local em `GET /painel/diaria` — zero fork de template:
reusa `renderDashboardHtml` do próprio Worker (`workers/diaria-dashboard/src/index.ts`)
e `buildDashboardData()` (`scripts/build-diaria-dashboard-data.ts`), mas
re-agrega `data/` a cada request em vez de ler de um snapshot KV. Não precisa
de `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_WORKERS_TOKEN` — só `data/` local
(junction OneDrive, label `local` #2643). Sem `data/`, o painel ainda
carrega, com todas as seções em estado "sem dados" (graceful).

A aba **"É IA?"** (poll) já vem embutida no mesmo documento a partir de
`data/poll-eia-summary.json` — não há painel separado para o poll.

Implementação: `scripts/studio-ui/dashboard-diaria.ts`. Teste:
`test/studio-dashboard-panels.test.ts`.

### Painel Clarice/mensal local (#3563, endereça #3553-A)

`GET /painel/clarice` — modo local do dashboard Clarice/mensal
(`workers/brevo-dashboard`): busca campanhas/agendadas/créditos direto na
Brevo API (`BREVO_CLARICE_API_KEY`, ver `.env.example`) e lê o sumário de
contatos direto do store SQLite local (`scripts/lib/clarice-db.ts`) — mais
fresco que o snapshot KV do push diário das 03:40 (#2932). Cache de página
de 5min (mesmo TTL do edge cache do Worker) protege contra o limite horário
da Brevo em reloads repetidos do editor. Sem `BREVO_CLARICE_API_KEY`
configurada, nenhuma chamada de rede é feita.

Gap deliberado: coortes de engajamento, status MillionVerifier, cupons
Stripe e engajamento "É IA?" (por edição, aba Clarice) não são
recomputáveis barato on-demand — são pré-computados por scripts caros
(ex: `clarice-engagement-cohorts.ts`, ~40k GETs) só empurrados pro KV.
Essas 4 abas degradam pra "sem dados" no painel local (mesmo
comportamento gracioso do cold-start do Worker). `#3553` parte B (remover
o Cron Trigger do Worker remoto) é um follow-up separado — muda o
`wrangler.toml`/deploy do Worker, fora do escopo do embed local.

Implementação: `scripts/studio-ui/dashboard-clarice.ts`.
