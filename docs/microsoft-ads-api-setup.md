# Acesso programático ao Microsoft Advertising (#5502, #5928)

Molde de `docs/google-ads-api-setup.md` para o 2º canal de ingestão
automática de `data/aquisicao/spend.csv` — Microsoft Advertising (Bing Ads).

**Estado em 22/08/2026 (#5928): ponta a ponta funcionando.** A conta em uso
(`CustomerId` 255014657, `vjpixel@gmail.com`) foi criada via "Sign in with
Google" e rejeita autenticação Azure AD — o caminho que FUNCIONA pra ela é
Google OAuth como `IdentityProvider` (seção dedicada abaixo). Validado ao
vivo rodando `npx tsx scripts/microsoft-ads-ingest-spend.ts` contra a API
real: `submit → poll → (download quando há dado)` completa sem erro. A
conta não tem nenhum gasto histórico até esta data (confirmado consultando
desde 2023), então o resultado real hoje é fail-soft "sem gasto no
período" — `spend.csv` só ganha a linha `Microsoft Advertising` quando o
teste pago (#5524) realmente gastar.

## O que já existe (código)

- `scripts/lib/microsoft-ads-ingest.ts` — núcleo puro (normalização
  `CampaignPerformanceReport → SpendRow`, testado contra fixture em
  `test/microsoft-ads-ingest-5502.test.ts`) + transporte SOAP real
  (submit→poll→download→unzip→parse) + orquestração fail-soft
  (`runMicrosoftAdsIngest`), adaptador de `scripts/lib/spend-ingest.ts`
  (motor genérico compartilhado com o adaptador Google, #5502 Parte B).
- `scripts/microsoft-ads-ingest-spend.ts` — CLI fino, espelha
  `scripts/google-ads-ingest-spend.ts` na estrutura: sem as env vars
  abaixo (ou com qualquer chamada falhando), sai com **exit 0** e
  `data/aquisicao/spend.csv` intocado — nunca quebra `cac-report.ts`.

## Dois caminhos de identidade — Google (o que funciona hoje) e Azure AD (default histórico)

A Microsoft Advertising API aceita 2 provedores de identidade OAuth,
alternativos entre si (não é upgrade/downgrade, são 2 formas igualmente
válidas — qual usar depende de como a conta específica foi criada):
https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth#authentication-with-google-oauth.
`refreshMicrosoftAdsAccessToken` escolhe automaticamente: usa Google quando
`MicrosoftAdsAuthConfig.googleRefreshToken` está presente, cai pro Azure AD
caso contrário — mesmo critério que `scripts/microsoft-ads-ingest-spend.ts`
usa pra resolver a config a partir do ambiente.

### Google OAuth (#5928) — o caminho que a conta em uso EXIGE

Descoberto ao vivo em 22/08/2026: a conta foi criada via **"Sign in with
Google"**, e a API rejeita qualquer chamada autenticada por token Azure AD
pra ela especificamente —

```json
{"Errors":[{"Code":126,"Message":"You must use a different identity type to
sign in to Bing Ads with the same email.","Detail":"GoogleAccountIsRequired",
"ErrorCode":"IdentityTypeMismatch"}]}
```

**Setup, mais simples do que parece — não precisou de nenhum recurso novo
no Google Cloud Console:**

1. **Reusa o client OAuth "Desktop app" já existente do repo**
   (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, o mesmo que
   `scripts/oauth-setup.ts` usa pra Drive/Gmail/GSC/Postmaster/GA4) — o
   scope que a Microsoft pede (`profile email`) é não-sensível, não exige
   nenhuma API habilitada nem consent screen dedicado. Nenhuma ação no
   Google Cloud Console foi necessária.
2. Fluxo de autorização padrão do Google
   (`https://accounts.google.com/o/oauth2/v2/auth`, `scope=profile+email`,
   `access_type=offline`, `prompt=consent`) — consentimento feito ao vivo
   como `vjpixel@gmail.com` (a MESMA identidade da conta Ads).
3. Troca do `code` pelo `access_token`/`refresh_token` no token endpoint do
   **Google** (`oauth2.googleapis.com/token`, não Azure AD) —
   `refresh_token` foi pro Doppler (`MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN`).
4. Toda chamada SOAP à Microsoft Advertising leva o header extra
   `<IdentityProvider>Google</IdentityProvider>` no SOAP Header, com
   `AuthenticationToken` sendo o access token do GOOGLE — implementado em
   `buildSoapEnvelope` (`scripts/lib/microsoft-ads-ingest.ts`), condicional
   a `auth.googleRefreshToken` estar presente.

Validado ao vivo, nesta ordem: `CustomerManagementService.GetUser` (REST,
diagnóstico) devolveu 200 com os dados da conta; depois
`SubmitGenerateReport`/`PollGenerateReport` (SOAP, o fluxo real) completaram
sem erro de identidade.

### Azure AD v2 / OAuth2 — default histórico (#5502), vale pra outra conta

Continua implementado e testado — é o caminho certo pra qualquer conta
Microsoft Advertising que NÃO tenha sido criada via "Sign in with Google".
Token endpoint:

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
   existe no Doppler mas NÃO é enviado na renovação do token** — o app
   registration é *public client* (fluxo desktop/nativo) e a Azure AD
   rejeita a requisição inteira (`AADSTS90023: Public clients can't send a
   client secret`) se o secret vier junto, mesmo sendo válido.
3. **Developer token** — pedido pelo [Microsoft Advertising App Center]
   (developers.ads.microsoft.com/AppCenter). Este é o MESMO developer token
   usado no caminho Google acima — o token não depende do identity
   provider, só de `DeveloperToken` no header, sempre presente.
4. `MICROSOFT_ADS_CUSTOMER_ID` (a conta gerenciadora) e
   `MICROSOFT_ADS_ACCOUNT_ID` (a conta de anúncios específica) — visíveis no
   painel do Microsoft Advertising, mesmo par conceitual de
   `GOOGLE_ADS_LOGIN_CUSTOMER_ID`/`GOOGLE_ADS_CUSTOMER_ID`. Também
   compartilhados entre os 2 caminhos de identidade — são propriedades da
   CONTA, não do provedor de autenticação.

## Reporting API — fluxo assíncrono de 3 passos (diferença chave vs GAQL), implementado #5928

A GAQL do Google Ads é uma chamada síncrona (`googleAds:search`) que devolve
JSON na hora. A **Reporting API** do Microsoft Advertising não: é SOAP (não
REST) e um fluxo de polling —

1. `SubmitGenerateReport` (o `CampaignPerformanceReportRequest` com só as
   colunas `TimePeriod`+`Spend` — excluir `CampaignId`/`CampaignName` faz a
   API agregar automaticamente entre campanhas) — devolve um
   `ReportRequestId`.
2. `PollGenerateReport` repetido até o status virar `Success` (ou erro) —
   quando pronto E há dado, devolve um `ReportDownloadUrl`.
3. Baixar o **ZIP** da URL, descompactar (`unzipFirstEntry`, Local File
   Header lido na mão via `node:zlib` — sem lib de ZIP no repo) e parsear o
   CSV (`papaparse`, já dependência do repo).

`scripts/lib/microsoft-ads-ingest.ts` implementa os 3 passos de verdade em
`fetchMicrosoftAdsSpendRows` (`fetchImpl` injetável, sempre fail-soft —
`{ rows }` ou `{ error }`), testado com um router de mock que simula
submit→poll (incluindo `Pending` repetido)→download de um ZIP real
(`test/microsoft-ads-ingest-5502.test.ts`). **4 detalhes de transporte só
descobertos ao vivo (22/08/2026), não documentados com clareza pela doc
oficial:**

- `Content-Type: text/xml; charset=utf-8` + header HTTP `SOAPAction: {op}`
  — `application/soap+xml` (SOAP 1.2) devolve HTTP 415 puro. A doc oficial
  mostra um template que parece SOAP 1.2 (`<Action>` dentro do SOAP
  Header), mas o transporte real exige SOAP 1.1.
- Endpoint único `https://reporting.api.bingads.microsoft.com/Api/Advertiser/Reporting/v13/ReportingService.svc`
  pras 2 operações — a operação vai no `<Action>` do SOAP Header, não na URL.
- **`Time.CustomDateRangeEnd` deve vir ANTES de `Time.CustomDateRangeStart`
  no XML** — é a ordem que o XSD do `ReportTime` declara
  (https://learn.microsoft.com/en-us/advertising/reporting-service/reporttime).
  WCF é estrito com ordem de elemento: invertida (o que uma 1ª versão deste
  código chegou a mergear), TODA submissão falha com
  `InvalidCustomDateRangeEnd` — mesmo com datas válidas e coerentes entre
  si. `test/microsoft-ads-ingest-5502.test.ts` trava essa ordem como
  regressão.
- **`Status: Success` com `ReportDownloadUrl` nil é uma resposta VÁLIDA,
  não um erro** — significa "relatório processado, zero linhas" (a API não
  gera arquivo pra baixar quando não há nada pra reportar). Confirmado
  consultando desde 2023 na conta em uso (sem nenhum gasto histórico):
  sempre `Success` + URL nil. `fetchMicrosoftAdsSpendRows` trata isso como
  `{ rows: [] }` — vazio legítimo, mesma disciplina de "zero não é falha de
  ingestão" que já rege `google-ads-ingest.ts`.

## Formato aceito por `aggregateMicrosoftAdsSpendByMonth`

- `TimePeriod`: `MM/DD/YYYY` (formato default da Reporting API) OU
  `YYYY-MM-DD` — os dois casam; qualquer outro formato faz a linha ser
  IGNORADA (nunca soma como 0).
- `Spend`: decimal com PONTO, string ou number.

## Segredos

Vão para o Doppler (`diaria-studio` / `dev`), nunca para o repo:

- `MICROSOFT_ADS_DEVELOPER_TOKEN` / `MICROSOFT_ADS_CUSTOMER_ID` /
  `MICROSOFT_ADS_ACCOUNT_ID` — sempre exigidas, independem do identity
  provider.
- **Caminho Google (#5928, o que funciona pra conta em uso):**
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (já existiam — reusa o client
  Drive/Gmail) + `MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN` (novo, específico
  deste uso).
- **Caminho Azure AD (default histórico, vale pra outra conta):**
  `MICROSOFT_ADS_CLIENT_ID` / `MICROSOFT_ADS_CLIENT_SECRET` (não enviado,
  ver seção acima) / `MICROSOFT_ADS_REFRESH_TOKEN`.

`scripts/microsoft-ads-ingest-spend.ts` prioriza Google quando as 3
variáveis desse caminho estão presentes — mesmo critério de
`refreshMicrosoftAdsAccessToken`.

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

Sem as env vars do caminho ativo (Google OU Azure AD, ver "Segredos"), ou
com qualquer chamada falhando: aviso + exit 0, CSV manual intocado — o
mesmo comportamento de `scripts/google-ads-ingest-spend.ts`. Zero gasto no
período consultado também é fail-soft (não erro): é o estado real da conta
até 22/08/2026.

<<<<<<< HEAD
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
=======
## Estado (22/08/2026, #5928)
>>>>>>> master

- [x] Núcleo de normalização puro implementado e testado contra fixture
      (`test/microsoft-ads-ingest-5502.test.ts`)
- [x] Adaptador fail-soft (`runMicrosoftAdsIngest`) sobre o motor genérico
      `scripts/lib/spend-ingest.ts`
- [x] CLI fino (`scripts/microsoft-ads-ingest-spend.ts`)
<<<<<<< HEAD
- [ ] App registration no Azure — ação do editor
- [ ] Developer token pedido — ação do editor
- [x] `MICROSOFT_ADS_*` no Doppler (credenciais configuradas 21/08/2026, #5928)
- [ ] Primeira chamada real validada (fluxo de poll da Reporting API não
      testável sem credencial — ver seção acima)
=======
- [x] App registration no Azure — feito, app `diaria-studio-microsoft-ads`
- [x] Developer token pedido — feito (`MICROSOFT_ADS_DEVELOPER_TOKEN`)
- [x] `MICROSOFT_ADS_*` no Doppler (Azure AD + Google)
- [x] Transporte real da Reporting API implementado e testado (submit→poll→
      download→unzip→parse, SOAP 1.1)
- [x] **Identidade Google implementada e validada ao vivo** — a conta em
      uso exige isto; `refreshMicrosoftAdsAccessToken` escolhe
      automaticamente entre Google e Azure AD
- [x] **Primeira chamada real validada** — `SubmitGenerateReport`→
      `PollGenerateReport` completam sem erro contra a API real
      (`npx tsx scripts/microsoft-ads-ingest-spend.ts`, 22/08/2026)
- [ ] `spend.csv` com uma linha `Microsoft Advertising` de verdade —
      bloqueado só pela conta não ter gasto histórico ainda (#5524); a
      ingestão automática já está pronta pra capturar assim que o teste
      pago começar a gastar
- [ ] Task agendada (própria ou compartilhada com o Google Ads, #5493) —
      decisão adiada até a conta ter gasto real pra validar contra
>>>>>>> master
- [ ] Campanha Microsoft Advertising real rodando (pré-requisito pra #5493
      mapear chaves de atribuição, item independente deste doc)
- [x] **#5878 — Campaign Management API: `GetAssetGroupsEditorialReasons`**
      implementado (envelope SOAP 1.1, parsing XML, fail-soft), testado contra
      fixture (18 testes, `test/microsoft-ads-editorial-reasons.test.ts`),
      CLI pronto, task agendada `Diaria-Microsoft-Ads-Editorial-Reasons`
      (10:00 BRT). Reusa credencial `MICROSOFT_ADS_*` já no Doppler.
