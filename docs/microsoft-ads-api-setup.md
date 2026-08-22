# Acesso programático ao Microsoft Advertising (#5502)

Molde de `docs/google-ads-api-setup.md` para o 2º canal de ingestão
automática de `data/aquisicao/spend.csv` — Microsoft Advertising (Bing Ads).
Diferente do Google, **nenhuma campanha real roda ainda** (#5493) — este doc
cobre só o CAMINHO PROGRAMÁTICO (código já implementado e testado com
fixture, `scripts/lib/microsoft-ads-ingest.ts` +
`scripts/microsoft-ads-ingest-spend.ts`); credenciar de verdade e disparar
uma campanha é decisão/ação do editor, fora do escopo desta issue.

## O que já existe (código)

- `scripts/lib/microsoft-ads-ingest.ts` — núcleo puro (normalização
  `CampaignPerformanceReport → SpendRow`, testado contra fixture em
  `test/microsoft-ads-ingest-5502.test.ts`) + orquestração fail-soft
  (`runMicrosoftAdsIngest`), adaptador de `scripts/lib/spend-ingest.ts`
  (motor genérico compartilhado com o adaptador Google, #5502 Parte B).
- `scripts/microsoft-ads-ingest-spend.ts` — CLI fino, espelha
  `scripts/google-ads-ingest-spend.ts` linha a linha: sem as env vars
  abaixo (ou com qualquer chamada falhando), sai com **exit 0** e
  `data/aquisicao/spend.csv` intocado — nunca quebra `cac-report.ts`.

## Fluxo de autenticação (Azure AD v2 / OAuth2)

O Microsoft Advertising usa o mesmo padrão OAuth2 "refresh token" do Google
Ads REST (não SOAP legado) — token endpoint da Azure AD:

```
https://login.microsoftonline.com/common/oauth2/v2.0/token
```

com `scope=https://ads.microsoft.com/msads.manage offline_access`. Passos
(via [Microsoft Advertising App Center](https://developers.ads.microsoft.com/AppCenter)):

1. Registrar um app OAuth (App para desktop/nativo, mesmo formato do Google)
   no [Azure App registrations](https://portal.azure.com) — gera
   `MICROSOFT_ADS_CLIENT_ID`/`MICROSOFT_ADS_CLIENT_SECRET`.
2. Consentimento do usuário (fluxo de autorização com o `client_id` acima) →
   troca o `code` por `access_token` + `refresh_token` — `refresh_token` vai
   pro Doppler (`MICROSOFT_ADS_REFRESH_TOKEN`).
3. **Developer token** — pedido pelo [Microsoft Advertising App Center]
   (developers.ads.microsoft.com/AppCenter), análogo ao developer token do
   Google Ads mas sem o degrau "conta de teste vs Basic Access": o token
   emitido já enxerga a conta real desde o início (confirmar contra a doc
   oficial no momento do pedido — políticas de acesso mudam).
4. `MICROSOFT_ADS_CUSTOMER_ID` (a conta gerenciadora) e
   `MICROSOFT_ADS_ACCOUNT_ID` (a conta de anúncios específica) — visíveis no
   painel do Microsoft Advertising, mesmo par conceitual de
   `GOOGLE_ADS_LOGIN_CUSTOMER_ID`/`GOOGLE_ADS_CUSTOMER_ID`.

## Reporting API — fluxo assíncrono de 2 passos (diferença chave vs GAQL)

A GAQL do Google Ads é uma chamada síncrona (`googleAds:search`) que devolve
JSON na hora. A **Reporting API** do Microsoft Advertising não: é um fluxo de
polling —

1. `SubmitGenerateReport` (o `CampaignPerformanceReport` com `Spend` por
   `TimePeriod`) — devolve um `ReportRequestId`.
2. `PollGenerateReport` repetido até o status virar `Success` (ou `Error`) —
   quando pronto, devolve uma URL de download.
3. Baixar o CSV/ZIP da URL e parsear as linhas.

`scripts/lib/microsoft-ads-ingest.ts` modela isso como uma função fail-soft
ÚNICA (`fetchMicrosoftAdsSpendRows`, que recebe um `fetchImpl` e devolve
`{ rows }` ou `{ error }`) — os 3 passos acima (submit→poll→download) ficam
por conta de quem implementar a chamada real (o `reportRequestUrl`
injetável já existe pra isso); o núcleo de normalização
(`aggregateMicrosoftAdsSpendByMonth`) só se importa com a FORMA da linha já
parseada (`TimePeriod` + `Spend`), não com o transporte. **Isso é
deliberado, não um atalho incompleto** — sem credencial real pra validar o
poll de verdade, testar o fluxo assíncrono contra fixture só criaria
confiança falsa; a fronteira (fetch fail-soft → normalização pura) é onde o
teste tem valor real, mesma disciplina de `google-ads-ingest.ts`.

## Formato aceito por `aggregateMicrosoftAdsSpendByMonth`

- `TimePeriod`: `MM/DD/YYYY` (formato default da Reporting API) OU
  `YYYY-MM-DD` — os dois casam; qualquer outro formato faz a linha ser
  IGNORADA (nunca soma como 0).
- `Spend`: decimal com PONTO, string ou number.

## Segredos

Vão para o Doppler (`diaria-studio` / `dev`), nunca para o repo:

- `MICROSOFT_ADS_CLIENT_ID` / `MICROSOFT_ADS_CLIENT_SECRET` — App registration
- `MICROSOFT_ADS_REFRESH_TOKEN` — do fluxo de consentimento
- `MICROSOFT_ADS_DEVELOPER_TOKEN` — Microsoft Advertising App Center
- `MICROSOFT_ADS_CUSTOMER_ID` / `MICROSOFT_ADS_ACCOUNT_ID` — painel do
  Microsoft Advertising

## Canal em `spend.csv`

Usar exatamente `Microsoft Advertising` (não `Microsoft Ads`/`Bing Ads`) —
é o nome canônico reservado em `RESERVED_CHANNEL_NAMES`
(`scripts/lib/cac.ts`, #5493), o único que `mergeSpendRows`/`buildCacReport`
reconhecem no `canal` da linha. `runMicrosoftAdsIngest` já usa esse default.

**Chaves de atribuição por referrer/UTM continuam DELIBERADAMENTE ausentes
de `CHANNEL_KEY_SPECS`** até uma campanha real gerar tráfego observável
(#5493) — rodar `scripts/observe-channel-keys.ts` contra ≥1 dia de campanha
e colar a saída literal no PR que adicionar a spec. Importar o GASTO (este
doc) e mapear os ASSINANTES atribuídos a esse gasto (issue separada, #5493)
são dois passos independentes — o 1º não destrava o 2º sozinho.

## Uso

```bash
npx tsx scripts/microsoft-ads-ingest-spend.ts
npx tsx scripts/microsoft-ads-ingest-spend.ts --spend data/aquisicao/spend.csv
```

Sem as 6 env vars (ou com qualquer chamada falhando): aviso + exit 0, CSV
manual intocado — o mesmo comportamento de
`scripts/google-ads-ingest-spend.ts`.

## Campaign Management API — motivos editoriais (#5878)

A Reporting API (seção acima) serve para **gasto**. A **Campaign Management
API v13** é servida por um endpoint SOAP distinto e capta **motivo textual de
rejeição de assets** — o que a UI mostra por ~14h antes que o estado
`Disapproved` desapareça do painel (problema documentado em #5702 e #5878):

- **Endpoint SOAP**: `https://api.bingads.microsoft.com/Api/Advertiser/CampaignManagement/v13/ApiCampaignManagementService.svc`
- **SOAPAction HTTP header**: `GetAssetGroupsEditorialReasons`
- **SOAP 1.1** (`text/xml; charset=utf-8` — não `application/soap+xml`, que
  devolve HTTP 415).
- **Requisição**: `<GetAssetGroupsEditorialReasonsRequest>` com `AccountId` +
  `AssetGroupId`. A chamada é **síncrona** (não segue o
  submit→poll→download assíncrono da Reporting API).
- **Resposta**: `<EditorialReasonCollection>` contendo `<EditorialReasons>`
  (pode ser array ou elemento único). Cada razão traz `ReasonCode`, `Location`,
  `PublisherCountries`, `Term`, `AppealStatus`.

Implementação:
- `scripts/lib/microsoft-ads-editorial-reasons.ts` — núcleo SOAP (envelope,
  parsing, fail-soft). Reusa `MicrosoftAdsAuthConfig` +
  `refreshMicrosoftAdsAccessToken` de `microsoft-ads-ingest.ts` (mesmo escopo
  OAuth `msads.manage`).
- `scripts/microsoft-ads-editorial-reasons.ts` — CLI fino, fail-soft (exit 0
  sem credencial). Output: `data/microsoft-ads/editorial-reasons-{YYYY-MM-DD}.json`.
- Task agendada `Diaria-Microsoft-Ads-Editorial-Reasons`, diária 10:00 BRT
  (10min depois do `Diaria-Google-Ads-Spend-Ingest`, sem colisão).

Testes: `test/microsoft-ads-editorial-reasons.test.ts` — 18 testes cobrindo
envelope, parsing (1/2/0 razões, XML malformado), extração de SOAP Fault, e
fail-soft end-to-end via `fetch` mockado (nunca toca a API real).

- [x] Núcleo de normalização puro implementado e testado contra fixture
      (`test/microsoft-ads-ingest-5502.test.ts`)
- [x] Adaptador fail-soft (`runMicrosoftAdsIngest`) sobre o motor genérico
      `scripts/lib/spend-ingest.ts`
- [x] CLI fino (`scripts/microsoft-ads-ingest-spend.ts`)
- [ ] App registration no Azure — ação do editor
- [ ] Developer token pedido — ação do editor
- [x] `MICROSOFT_ADS_*` no Doppler (credenciais configuradas 21/08/2026, #5928)
- [ ] Primeira chamada real validada (fluxo de poll da Reporting API não
      testável sem credencial — ver seção acima)
- [ ] Campanha Microsoft Advertising real rodando (pré-requisito pra #5493
      mapear chaves de atribuição, item independente deste doc)
- [x] **#5878 — Campaign Management API: `GetAssetGroupsEditorialReasons`**
      implementado (envelope SOAP 1.1, parsing XML, fail-soft), testado contra
      fixture (18 testes, `test/microsoft-ads-editorial-reasons.test.ts`),
      CLI pronto, task agendada `Diaria-Microsoft-Ads-Editorial-Reasons`
      (10:00 BRT). Reusa credencial `MICROSOFT_ADS_*` já no Doppler.
