# Rate limit real da Brevo (dashboard `clarice-dashboard`)

Issues: [#5215](https://github.com/vjpixel/diaria-studio/issues/5215), [#5219](https://github.com/vjpixel/diaria-studio/issues/5219), [#5218](https://github.com/vjpixel/diaria-studio/issues/5218).

## A premissa errada que este documento corrige

Vários comentários em `workers/brevo-dashboard/src/brevo-api.ts` (desde o
#2144, 2026-06) assumiam que o teto da Brevo era **100 requisições por
MINUTO**. Nunca foi. Fonte oficial:
https://developers.brevo.com/docs/api-limits.

## O limite real

- **Unidade: HORA (RPH — requests per hour), não minuto.**
- **Varia por família de endpoint**, tier "General" (o único que este
  projeto usa — sem SLA pago):
  - `/v3/contacts/*` (inclui `/v3/contacts/lists/{id}`, usado por este
    Worker pra resolver nome de lista): **36.000 RPH**.
  - "Todos os outros endpoints" — inclui `/v3/emailCampaigns*` (listagem +
    GET por campanha) e `/v3/account` (créditos do plano): **100 RPH**.
    Este é o pool que de fato aperta o dashboard.

`BREVO_RATE_LIMIT_GENERAL_RPH`/`BREVO_RATE_LIMIT_CONTACTS_RPH` (exportados de
`workers/brevo-dashboard/src/brevo-api.ts`) são a referência canônica no
código — não hardcodar o número de novo em outro lugar.

## Consumo medido

A task horária `Diaria-Clarice-Dashboard-Precompute` (#5217) gasta ~2
chamadas Brevo por execução morna (créditos do plano + agendadas; o grosso do
payload de campanhas enviadas vem do KV cacheado) — ~44/100 RPH por execução,
folgado mesmo somando visitas humanas no mesmo período. Ver
`docs/clarice-dashboard-precompute-setup.md`.

## `mapLimit(5)` continua certo (reavaliado, não mudado)

`mapLimit(5)` (usado em `fetchRecentCampaigns` pra paralelizar GETs de lista
+ stats por campanha) controla **concorrência** — quantas requests ficam em
voo AO MESMO TEMPO — não **taxa** — quantas por hora. São eixos
independentes: reduzir a concorrência não reduz o total de requests numa
janela de 1h se o número de campanhas novas (não cacheadas) na janela for
grande o bastante.

Quem de fato protege o orçamento HORÁRIO:

1. **Cache KV** — campanhas imutáveis (`sentDate` > 7d) ficam cacheadas sem
   TTL; campanhas recentes ficam cacheadas com `RECENT_STATS_TTL`. A imensa
   maioria dos renders não bate na Brevo pra stats já vistas.
2. **`withRateLimitRetry`** — honra `x-sib-ratelimit-reset` com backoff em
   qualquer 429 real, em vez de martelar a API.

Conclusão: `mapLimit(5)` segue adequado pro que se propõe (não abrir dezenas
de conexões simultâneas por render, reduzindo o risco de saturar o limite de
subrequests concorrentes do Worker) — não foi alterado só porque a unidade
do teto mudou de minuto pra hora.

## `x-sib-ratelimit-remaining` também logado no caminho de sucesso (#5215 item 4)

Antes só era lido no ramo de erro 429 (pro cálculo do backoff). Desde esta
unidade, `brevoFetchWithApiKey` também lê o header em respostas 2xx e loga um
`console.warn` quando o restante fica ≤ 10 (ver `shouldWarnLowRateLimitRemaining`
em `brevo-api.ts`) — visibilidade proativa nos logs do Worker antes de bater
o teto, sem alterar o corpo/status da resposta.

## Decisão fechada: uma 2ª API key NÃO isola quota (#5219)

**Não reabrir esta pergunta sem novo dado da Brevo.** O rate limit é por
**CONTA**, não por credencial — duas API keys da MESMA conta Brevo somam no
MESMO balde de 100/36.000 RPH. Criar uma 2ª key só pro dashboard, na
expectativa de que ela "não competiria" com os scripts de automação
(`clarice-schedule-ramp.ts`, `clarice-envio-run.ts` etc., que também chamam a
API da conta Clarice), não muda nada — ambas as keys decrementariam o mesmo
contador.

**Não confundir com `BREVO_CLARICE_API_KEY` × `BREVO_DIARIA_API_KEY`** — essas
DUAS já existem no projeto e têm quota genuinamente independente, porque são
credenciais de **contas Brevo diferentes** (tenants distintos: a conta
Clarice e a conta pessoal do editor pro canal `brevo_diaria`, #4515) — não
uma 2ª key da mesma conta. O que resolveria a competição por quota entre o
dashboard e os scripts de automação da conta Clarice seria uma conta Brevo
Clarice **inteiramente separada** (custo/complexidade de migração fora de
escopo desta issue, e sem justificativa concreta enquanto o consumo medido
fica bem abaixo do teto — ver seção "Consumo medido" acima).

## Banner de rate-limit com horário de relógio + fila "avisar quando atualizar" (#5218)

`injectStaleBanner`/`rateLimitResponse` mostravam um delta relativo
(`~120s`) — exige que quem lê faça a conta de cabeça a partir do instante em
que abriu a página, que pode já ter passado minutos. Desde esta unidade,
mostram um horário de relógio BRT (`fmtClockBRT`, `render-links.ts`):
"volta a atualizar sozinho às 14:37 BRT".

Quando `retryAfterSecs` é conhecido, o banner de rate-limit ganha uma 2ª CTA
("Avisar quando atualizar") que grava `dash:refresh:pending` no KV
(`writeRefreshPending`/`readRefreshPending`/`clearRefreshPending`,
`brevo-api.ts`) com o horário-alvo já calculado. A rota `/` (`index.ts`)
trata o PRIMEIRO request orgânico igual-ou-depois desse horário como fresh
(bypassa cache) e limpa a flag no mesmo request — sucesso ou falha, nunca se
rearma sozinha. O auto-fresh passa pelo mesmo `coalesceRefresh`/
`tryAcquireRefreshLock` que protege `?fresh=1` contra thundering herd, só que
sem bypassar o LOCK cross-colo (distinção `isFresh` × `bypassLock` em
`buildDashboardResponse`) — evita que vários visitantes concorrentes, todos
vendo a mesma fila madura, disparem o live-fetch pesado em paralelo.

O banner de indisponibilidade genérica (`injectUpstreamErrorBanner`, 403/5xx)
**não** ganhou horário — a Brevo não fornece uma ETA confiável pra esse caso
(diferente do rate-limit, que tem `retryAfterSecs`), então inventar um
horário ali seria enganoso.
