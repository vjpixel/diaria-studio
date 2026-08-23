# Acesso programático ao Microsoft Advertising (#5502, #5928)

Molde de `docs/google-ads-api-setup.md` para o 2º canal de ingestão
automática de `data/aquisicao/spend.csv` — Microsoft Advertising (Bing Ads).

**Estado em 22/08/2026 (#5928):** a credencial Azure AD saiu (App Access
Key aprovada, #5502/#5878) e o transporte real da Reporting API está
implementado e testado (submit→poll→download→unzip→parse, SOAP 1.1) — mas a
primeira chamada real esbarrou num bloqueio novo, descoberto ao vivo: **a
conta Microsoft Advertising existente foi criada via "Sign in with Google"**
e exige autenticação por Google OAuth, não pela credencial Azure AD que já
está no Doppler. Ver seção "Achado ao vivo 22/08/2026" abaixo — é o item
que falta pra `data/aquisicao/spend.csv` ganhar a 1ª linha `Microsoft
Advertising` de verdade.

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
   pro Doppler (`MICROSOFT_ADS_REFRESH_TOKEN`). **`MICROSOFT_ADS_CLIENT_SECRET`
   existe no Doppler mas NÃO é enviado na renovação do token (#5928, validado
   ao vivo)** — o app registration é *public client* (fluxo desktop/nativo) e
   a Azure AD rejeita a requisição inteira (`AADSTS90023: Public clients
   can't send a client secret`) se o secret vier junto, mesmo sendo válido.
3. **Developer token** — pedido pelo [Microsoft Advertising App Center]
   (developers.ads.microsoft.com/AppCenter), análogo ao developer token do
   Google Ads mas sem o degrau "conta de teste vs Basic Access": o token
   emitido já enxerga a conta real desde o início (confirmar contra a doc
   oficial no momento do pedido — políticas de acesso mudam).
4. `MICROSOFT_ADS_CUSTOMER_ID` (a conta gerenciadora) e
   `MICROSOFT_ADS_ACCOUNT_ID` (a conta de anúncios específica) — visíveis no
   painel do Microsoft Advertising, mesmo par conceitual de
   `GOOGLE_ADS_LOGIN_CUSTOMER_ID`/`GOOGLE_ADS_CUSTOMER_ID`.

## Reporting API — fluxo assíncrono de 3 passos (diferença chave vs GAQL), implementado #5928

A GAQL do Google Ads é uma chamada síncrona (`googleAds:search`) que devolve
JSON na hora. A **Reporting API** do Microsoft Advertising não: é SOAP (não
REST) e um fluxo de polling —

1. `SubmitGenerateReport` (o `CampaignPerformanceReportRequest` com só as
   colunas `TimePeriod`+`Spend` — excluir `CampaignId`/`CampaignName` faz a
   API agregar automaticamente entre campanhas) — devolve um
   `ReportRequestId`.
2. `PollGenerateReport` repetido até o status virar `Success` (ou erro) —
   quando pronto, devolve um `ReportDownloadUrl`.
3. Baixar o **ZIP** da URL, descompactar (`unzipFirstEntry`, Local File
   Header lido na mão via `node:zlib` — sem lib de ZIP no repo) e parsear o
   CSV (`papaparse`, já dependência do repo).

`scripts/lib/microsoft-ads-ingest.ts` implementa os 3 passos de verdade em
`fetchMicrosoftAdsSpendRows` (`fetchImpl` injetável, sempre fail-soft —
`{ rows }` ou `{ error }`), testado com um router de mock que simula
submit→poll (incluindo `Pending` repetido)→download de um ZIP real
(`test/microsoft-ads-ingest-5502.test.ts`). **2 detalhes de transporte só
descobertos ao vivo (22/08/2026), não documentados com clareza pela doc
oficial** (que mostra um template SOAP 1.2-ish mas o transporte real exige
1.1):

- `Content-Type: text/xml; charset=utf-8` + header HTTP `SOAPAction: {op}`
  — `application/soap+xml` (SOAP 1.2) devolve HTTP 415 puro.
- Endpoint único `https://reporting.api.bingads.microsoft.com/Api/Advertiser/Reporting/v13/ReportingService.svc`
  pras 2 operações — a operação vai no `<Action>` do SOAP Header, não na URL.

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

## Achado ao vivo 22/08/2026: esta conta Ads exige Google OAuth, não Azure AD (#5928)

Com o transporte SOAP implementado e as 6 credenciais Azure AD já no
Doppler, a 1ª chamada real (`CustomerManagementService.GetUser` via REST,
usada só como diagnóstico) devolveu:

```json
{"Errors":[{"Code":126,"Message":"You must use a different identity type to
sign in to Bing Ads with the same email.","Detail":"GoogleAccountIsRequired",
"ErrorCode":"IdentityTypeMismatch"}]}
```

A renovação do token Azure AD (`/common/oauth2/v2.0/token`) FUNCIONA —
devolve um `access_token` válido — mas a conta Microsoft Advertising
(`CustomerId` 255014657, `vjpixel@gmail.com`) foi criada/vinculada via
**"Sign in with Google"**, e a API rejeita qualquer chamada autenticada por
um token Azure AD para essa conta especificamente.

A Microsoft Advertising API suporta **Google OAuth 2.0 como provedor
alternativo** (não substituto) de identidade —
https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth#authentication-with-google-oauth
— mas isso exige uma credencial e um fluxo **inteiramente diferentes** dos
já implementados aqui:

1. Um client OAuth do **Google Cloud Console** (`client_id`/`client_secret`
   do Google — não reaproveita `MICROSOFT_ADS_CLIENT_*`), scope `profile
   email`.
2. Consentimento via `accounts.google.com/o/oauth2/v2/auth` (fluxo padrão
   Google, `access_type=offline`+`prompt=consent` pro refresh token) —
   https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-consent#request-user-consent-with-google-oauth.
3. Trocar o `code` pelo `access_token`/`refresh_token` no token endpoint do
   **Google** (`oauth2.googleapis.com/token`), não da Azure AD.
4. Toda chamada SOAP à Microsoft Advertising passa a levar o header extra
   `<IdentityProvider>Google</IdentityProvider>`, com o `AuthenticationToken`
   sendo o access token do GOOGLE.

**Isso é ação nova do editor** (registrar ou reaproveitar um client OAuth no
Google Cloud Console + consentir) — `scripts/lib/microsoft-ads-ingest.ts`
**não** implementa o refresh via Google nem o header `IdentityProvider` de
propósito: sem a credencial real pra validar, escrever esse caminho agora só
criaria confiança falsa (mesma disciplina que já regeu o resto deste
módulo). Alternativa não investigada: pode existir uma opção no painel do
Microsoft Advertising pra trocar o tipo de identidade da conta de volta pra
Microsoft/work — se existir, pode ser mais simples que credenciar Google do
zero; não confirmado.

## Uso

```bash
npx tsx scripts/microsoft-ads-ingest-spend.ts
npx tsx scripts/microsoft-ads-ingest-spend.ts --spend data/aquisicao/spend.csv
```

Sem as 6 env vars (ou com qualquer chamada falhando): aviso + exit 0, CSV
manual intocado — o mesmo comportamento de
`scripts/google-ads-ingest-spend.ts`.

## Estado (22/08/2026, #5928)

- [x] Núcleo de normalização puro implementado e testado contra fixture
      (`test/microsoft-ads-ingest-5502.test.ts`)
- [x] Adaptador fail-soft (`runMicrosoftAdsIngest`) sobre o motor genérico
      `scripts/lib/spend-ingest.ts`
- [x] CLI fino (`scripts/microsoft-ads-ingest-spend.ts`)
- [x] App registration no Azure — feito (#5928, sessão `/diaria-develop`
      260822b), app `diaria-studio-microsoft-ads`
- [x] Developer token pedido — feito (`MICROSOFT_ADS_DEVELOPER_TOKEN`,
      aprovado 22/08/2026)
- [x] `MICROSOFT_ADS_*` no Doppler (as 6 variáveis)
- [x] Transporte real da Reporting API implementado (submit→poll→
      download→unzip→parse, SOAP 1.1) — testado com mocks completos, não só
      fixture de normalização
- [ ] Primeira chamada real validada — **bloqueada, não por falta de
      implementação**: a conta Ads existente exige Google OAuth (ver seção
      "Achado ao vivo 22/08/2026" acima), arquitetura de auth diferente da
      já implementada. Ação do editor: credenciar Google OAuth ou trocar o
      tipo de identidade da conta.
- [ ] Task agendada (própria ou compartilhada com o Google Ads, #5493) —
      decisão adiada até a 1ª chamada real funcionar
- [ ] Campanha Microsoft Advertising real rodando (pré-requisito pra #5493
      mapear chaves de atribuição, item independente deste doc)
