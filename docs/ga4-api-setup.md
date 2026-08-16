# Acesso programático ao GA4 (#5248)

Estado e passo-a-passo do acesso à Google Analytics Data API v1beta para a
propriedade `Diaria`. Fecha a decisão registrada na issue #5248: "GA4 está
coletando → consertar e ingerir via Data API (cota gratuita)".

## Identificadores (confirmados ao vivo, 16/08/2026)

| O quê | Valor |
|---|---|
| Propriedade GA4 | `Diaria` |
| Property ID | `378028168` |
| Measurement ID | `G-SGXBD0R9CD` |
| Stream | Web único, URL `https://diaria.beehiiv.com` |
| ID de fluxo (stream) | `13159305621` |
| Container GTM | `GTM-TC8C65ZN` (confirmado: **não** carrega a tag de config GA4 — a instalação do GA4 não passa pelo GTM, é a integração nativa do stream) |

## Por que Data API, não Universal Analytics/GTM

GA4 já coleta (dado real confirmado: 2,4 mil usuários ativos/ano, 7,2 mil
visualizações — ver issue #5248). O que falta é **ingerir** esse dado no
repo em vez de só olhar o painel manualmente. A Data API (`runReport`) tem
cota gratuita generosa e cobre exatamente o caso de uso: comportamento
pós-clique na home hospedada (`diaria.beehiiv.com`, custom hostname da
Beehiiv, fora da zona Cloudflare que o `ai-referrer-log.ts` cobre).

## Por que OAuth refresh-token, não Service Account/ADC

A Data API aceita os dois métodos de auth. Este projeto escolheu o mesmo
fluxo OAuth refresh-token já em produção para a ingestão de custo do Google
Ads (`scripts/lib/google-ads-ingest.ts`, #5237) — mesmo token endpoint
(`oauth2.googleapis.com/token`), mesma forma de guardar segredo (Doppler),
sem exigir criar uma Service Account nova no GCP Console (passo que ficou
pendente meses para o MCP do Google Ads, ver `docs/google-ads-api-setup.md`).
Não é a única opção — é a que reaproveita infraestrutura já validada.

## Passo a passo para obter as credenciais

1. **Console GCP** (mesmo projeto do Google Ads serve, ou um dedicado —
   qualquer projeto Cloud com OAuth consent screen configurado funciona):
   `console.cloud.google.com` → selecionar/criar projeto.
2. **Habilitar a API**: "APIs e serviços" → "Biblioteca" → buscar
   "Google Analytics Data API" → Ativar.
3. **Credencial OAuth**: "APIs e serviços" → "Credenciais" → "Criar
   credenciais" → "ID do cliente OAuth" → tipo "App para computador"
   (mesmo tipo usado pelo cliente `diaria-relatorio-aquisicao` do Google
   Ads). Isso gera `client_id`/`client_secret` → `GA4_CLIENT_ID`/
   `GA4_CLIENT_SECRET`.
4. **Escopo**: o fluxo de consentimento precisa pedir
   `https://www.googleapis.com/auth/analytics.readonly` — o único escopo
   necessário para `runReport` (leitura, nunca escrita/config).
5. **Refresh token**: rodar o fluxo de consentimento OAuth (autorização
   com a conta que tem acesso de leitura à propriedade `Diaria` no GA4) e
   capturar o `refresh_token` da resposta do token endpoint → grava em
   `GA4_REFRESH_TOKEN`, direto no Doppler (nunca em texto solto).
6. **Property ID**: já conhecido — `378028168` (default em `.env.example`,
   normalmente não precisa mudar).

Todos os quatro (`GA4_PROPERTY_ID`, `GA4_CLIENT_ID`, `GA4_CLIENT_SECRET`,
`GA4_REFRESH_TOKEN`) vão para o Doppler (`diaria-studio` / `dev`), nunca
para o repo — mesma disciplina de `GOOGLE_ADS_*`. Depois de gravar no
Doppler, rodar `npm run sync-env` (CLAUDE.md §1b) para propagar as 4 novas
chaves ao `.env` local — sem isso o script segue fail-soft (aviso, exit 0)
mesmo com o Doppler já atualizado.

**Nenhuma credencial real foi criada ou testada nesta unidade** (#5248) —
o escopo aqui é o código de ingestão fail-soft + testes com mock. Obter as
credenciais reais é ação do editor (console GCP), fora do escopo de uma
sessão sem acesso interativo ao navegador logado.

## `scripts/ga4-ingest.ts` + `scripts/lib/ga4-ingest.ts`

- `scripts/lib/ga4-ingest.ts` — núcleo puro/testável: renova o access
  token via refresh token, chama `properties/{id}:runReport`, parseia a
  resposta (dimension/metric headers posicionais → objetos nomeados).
  Zero I/O de disco. Cobertura em `test/ga4-ingest-5248.test.ts` — usa
  `fetch` mockado, nunca chama a API real.
- `scripts/ga4-ingest.ts` — CLI fino: lê as env vars, roda o relatório
  default (usuários ativos, sessões, pageviews por dia, últimos 30 dias,
  segmentado por canal), salva o snapshot em
  `data/ga4-snapshots/{AAAA-MM-DD}.json`.

  ```bash
  npx tsx scripts/ga4-ingest.ts
  npx tsx scripts/ga4-ingest.ts --days 7
  npx tsx scripts/ga4-ingest.ts --out data/ga4-snapshots
  ```

**Fail-soft por design**: qualquer variável de ambiente ausente, ou
qualquer falha na chamada (rede, auth, quota), vira um aviso no stderr e
sai com exit 0 — nenhum snapshot é escrito, mas nada que chame o script
quebra.

## Integração futura com `cac-report.ts` — deliberadamente fora de escopo

`data/aquisicao/spend.csv` (consumido por `scripts/cac-report.ts` via
`scripts/lib/cac.ts`) modela CUSTO por canal/mês. O snapshot GA4 aqui
modela comportamento pós-clique (sessões/pageviews/usuários) — uma
dimensão diferente, sem schema decidido ainda para cruzar com o CAC
report. Por isso o output é um snapshot solto em `data/ga4-snapshots/`, não
uma escrita direta em `spend.csv` ou em qualquer insumo do CAC report.
Cruzar os dois é trabalho de uma issue futura, não decidido por esta.
