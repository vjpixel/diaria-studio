# Acesso programático ao Google Ads (#5262)

Estado e passo-a-passo do acesso à Google Ads API. Destrava #5237 (MCP oficial
read-only), #5236 (relatório de custo por leitor) e, mais adiante, o Offline
Conversion Import — o único caminho que amarra `gclid` a assinante de verdade.

## Identificadores

| O quê | Valor |
|---|---|
| Conta de anunciante | `236-921-9639` ("Diar.ia") |
| Conta gerenciadora (MCC) | `623-609-4249` ("diar.ia.br") |
| Projeto Google Cloud | `diaria-google-ads` / `velvety-tube-505505-d1` |
| Número do projeto | `486421567894` |
| Página de privacidade | https://arquivo.diar.ia.br/privacidade |

**A MCC é obrigatória.** O API Center não existe em conta de anunciante — abrir
`ads.google.com/aw/apicenter` na `236-921-9639` devolve *"A Central de API está
disponível apenas para contas de administrador"*. O developer token pertence à
MCC, e é o CID dela que vai em `login-customer-id` nas chamadas.

## Verificação ao vivo (19/08/2026) — Basic Access aprovado, ingestão real rodou

Basic Access aprovado por e-mail do Google (19/08/2026, 02:16 UTC). Validado
ao vivo na mesma data, contra a API real, v25:

| Chamada | Resposta |
|---|---|
| `customers:listAccessibleCustomers` | 200 (inalterado desde 17/08) |
| `googleAds:search`, `login-customer-id` = MCC (`GOOGLE_ADS_LOGIN_CUSTOMER_ID`) | **403 `USER_PERMISSION_DENIED`** |
| `googleAds:search`, `login-customer-id` = a própria conta (`GOOGLE_ADS_CUSTOMER_ID`) | **200** — zero linhas (conta pausada desde fevereiro) |
| `googleAds:search`, sem `login-customer-id` | **200** — idêntico ao anterior |

`DEVELOPER_TOKEN_NOT_APPROVED` sumiu por completo — o token não é mais de
teste. O 403 que sobrou é outra coisa: o usuário OAuth tem acesso **direto**
à conta de anunciante, mas não **através da hierarquia da MCC** configurada
em `GOOGLE_ADS_LOGIN_CUSTOMER_ID` — sintoma de vínculo MCC↔conta incompleto
no lado do Google Ads (convite de gerenciamento pendente de aceite), não de
credencial errada nem de fila. `fetchGoogleAdsSpendRows` (`scripts/lib/
google-ads-ingest.ts`) agora retenta automaticamente com `login-customer-id`
= a própria conta quando o corpo bate `USER_PERMISSION_DENIED` e o login
configurado difere da conta-alvo — corrigido e testado
(`test/google-ads-ingest-5237.test.ts`). Com o fix, `google-ads-ingest-spend.ts`
roda limpo e classifica `empty` (chamada OK, gasto zero — legítimo, conta
pausada).

**Resolver o vínculo MCC↔conta continua valendo a pena** mesmo com o
workaround no código — sem ele, qualquer chamada que dependa de acessar a
conta *pela* MCC (ex: outras contas futuras sob a mesma MCC) esbarra no
mesmo 403. Ação de plataforma, não de código: no Google Ads UI, verificar se
o convite/vínculo de gerenciamento entre `623-609-4249` (MCC) e
`236-921-9639` (conta de anúncio) está aceito dos dois lados.

## Verificação ao vivo (17/08/2026) — o que a API responde HOJE

Rodada contra a API real (`googleAds:search`, v22 e v25, resultados idênticos).
Registrado aqui porque duas conclusões erradas já foram tiradas de evidência
parcial, e a distinção entre elas é sutil:

| Chamada | Resposta |
|---|---|
| `customers:listAccessibleCustomers` | **200** — `customers/2369219639`, `customers/6236094249` |
| `googleAds:search` com `login-customer-id` | 403 `USER_PERMISSION_DENIED` |
| `googleAds:search` sem `login-customer-id` | 403 `DEVELOPER_TOKEN_NOT_APPROVED` |

**`listAccessibleCustomers` responder 200 NÃO significa que o Basic Access
saiu.** Esse endpoint lista contas do usuário OAuth e passa com token de
teste; só uma query GAQL contra a conta de produção distingue os dois
estados. Uma leitura anterior tomou o 200 como prova de aprovação — não é.
O estado real continua sendo **Basic Access na fila**.

O `USER_PERMISSION_DENIED` (em vez de `DEVELOPER_TOKEN_NOT_APPROVED`) quando
`login-customer-id` está presente também **não** indica header errado: o
header está correto, é o mesmo token de teste sendo recusado por outro
caminho. Confirmado variando o header e o customer alvo — todas as
combinações falham, nenhuma por configuração.

### Bug encontrado e corrigido na mesma rodada

`DURING LAST_90_DAYS` — usado na query padrão desde o PR #5380 — **não é um
literal GAQL válido**:

```
"queryError": "INVALID_VALUE_WITH_DURING_OPERATOR"
"Invalid date literal supplied for DURING operator: LAST_90_DAYS."
```

O GAQL valida a query **antes** da autorização, então esse 400 vinha mesmo
com o token de teste — e o fail-soft o registrava como "API indisponível",
idêntico ao caso esperado. A ingestão nunca teria funcionado, nem depois da
aprovação, e nada no log diria isso. Agravantes: a mensagem de erro era
truncada em 300 chars, o que **cortava exatamente o `errorCode`**; e o CLI
exigia `GOOGLE_PROJECT_ID` (que o caminho REST não usa), abortando antes
mesmo de tentar.

Corrigido: query montada com `BETWEEN` e datas explícitas
(`buildDefaultGaqlQuery`), truncagem em 600, `GOOGLE_PROJECT_ID` fora dos
requisitos do REST, e classificação de falha
(`auth-pending`/`defect`/`transient`/`empty`) para que defeito nosso e
indisponibilidade externa parem de sair com a mesma cara. Travado por
`test/google-ads-ingest-5237.test.ts` com os corpos de erro reais desta
verificação como fixture.

## Estado (14/08/2026)

- [x] MCC criada e conta de anunciante sob ela
- [x] Developer token criado — **nível "Conta de teste"**, que só enxerga contas
      de teste. Inútil para ler a conta real; por isso o pedido de Basic.
- [x] Pedido de **Basic Access** enviado (formulário do suporte de políticas)
- [x] Projeto Cloud criado, Google Ads API ativada
- [x] Tela de consentimento OAuth: tipo **Externo**, status **Em produção**
      (exigência explícita da doc de brand verification, que se sobrepõe à
      orientação em contrário do resto do console)
- [x] Política de privacidade pública no ar
- [x] Domínio `diar.ia.br` — já estava verificado no Search Console
      (`sc-domain:diar.ia.br`), nenhum TXT precisou ser criado; registrado como
      domínio autorizado
- [x] Página `/app` descrevendo a finalidade do app (a 1ª verificação reprovou
      porque a "página inicial" apontava pra home da newsletter)
- [x] **Verificação de marca concluída e PUBLICADA**
- [x] Cliente OAuth `diaria-relatorio-aquisicao` (App para computador)
- [x] Credenciais no Doppler
- [ ] Token associado ao projeto (`scripts/google-ads-associate-token.ts`)
- [x] Basic Access sair da fila — aprovado 19/08/2026, validado ao vivo (ver seção acima)

## Verificação de marca

O Google usa o status de brand verification do projeto Cloud para **acelerar** a
análise do Basic Access. Duas armadilhas custaram tempo aqui:

1. **O botão "Verificar marca" nasce desabilitado**, com o tooltip *"Verifique se
   o nome do app, a página inicial e o link da Política de Privacidade estão
   configurados"*. Não é bug — é a lista de pré-requisitos.
2. **O apex `diar.ia.br` não aceita Worker Route** (custom hostname da Beehiiv),
   mas a **zona DNS `diar.ia.br` está ativa na nossa conta Cloudflare**. As duas
   coisas convivem: dá para criar o TXT de verificação do Search Console no apex
   mesmo sem servir conteúdo nele. A política de privacidade mora num subdomínio
   nosso (`arquivo.diar.ia.br`); o domínio autorizado registrado é `diar.ia.br`,
   que cobre os subdomínios.

3. **A 1ª verificação reprovou por conteúdo, não por configuração:** *"A página
   inicial não explica a finalidade do app"*. O campo apontava para
   `https://diar.ia.br`, a home da newsletter — que não menciona a ferramenta
   que pede o acesso. A correção foi `/app` (`render-app.ts`), e é ELA que vai
   no campo "Página inicial do aplicativo", não a home.
4. **Armadilha de UI que apaga trabalho:** na tela de branding, "Salvar" fica
   **inativo** enquanto o domínio autorizado estiver faltando, e o botão
   destacado ao lado é **"Descartar alterações"**. Clicar nele limpa tudo sem
   aviso, e a tela fica parecida com "salvo". Preencher o domínio primeiro.
5. **A marca verificada expira em 7 dias se não for publicada** — depois de
   verificar, clicar em "Publicar branding".

## Pré-requisito escondido: associar o token ao projeto

Antes de a verificação valer para o Basic Access, o developer token precisa estar
**associado** ao projeto Cloud. Isso só acontece quando uma chamada à API é feita
com o token + uma credencial OAuth *deste* projeto. Segundo a própria doc:
tanto faz se a chamada sucede ou falha, se é conta de teste ou de produção, e
qual o nível do token. Uma chamada qualquer basta.

Isso significa que **o token de nível "Conta de teste" que já temos serve** —
não é preciso esperar o Basic para fechar este passo.

```bash
# 1x: consentimento OAuth. Grava o refresh token direto no Doppler,
#     sem imprimir o valor em lugar nenhum.
doppler run -- npx tsx scripts/google-ads-associate-token.ts --auth

# associa: faz UMA chamada e classifica o resultado.
doppler run -- npx tsx scripts/google-ads-associate-token.ts
```

O resultado **esperado e bem-sucedido** é `DEVELOPER_TOKEN_NOT_APPROVED` — o
token de teste não lê a conta de produção, mas a requisição foi processada, que
é tudo que a associação exige. `scripts/lib/google-ads-associate.ts` trata esse
código (e vizinhos como `USER_PERMISSION_DENIED`) como sucesso, e trata
`INVALID_DEVELOPER_TOKEN`/`OAUTH_TOKEN_INVALID`/`SERVICE_DISABLED` como falha
real. Travado por `test/google-ads-associate-5262.test.ts`.

## Segredos

Vão para o Doppler (`diaria-studio` / `dev`), nunca para o repo:

- `GOOGLE_ADS_DEVELOPER_TOKEN` — API Center → "Ver token"
- `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` — cliente OAuth do projeto
- `GOOGLE_ADS_REFRESH_TOKEN` — do fluxo de consentimento
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID` — `6236094249` (a MCC, **sem** hífens)
- `GOOGLE_ADS_CUSTOMER_ID` — `2369219639` (a conta que tem os dados)
- `GOOGLE_PROJECT_ID` — o "ID do projeto" (`velvety-tube-505505-d1`, tabela de
  identificadores acima), não o nome nem o número. Adicionado em #5237.
  **Correção (#6450, 27/08/2026): não é lido em lugar nenhum do código** —
  nem pelo caminho REST (confirmado 17/08), nem pelo servidor MCP oficial
  (confirmado lendo o fonte do `google-ads-mcp`, `ads_mcp/utils.py`). Removido
  de `.mcp.json`; mantido só como anotação de qual projeto é.
- `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` — JSON bruto (1 linha) da chave da Service
  Account (#6450), única credencial que o servidor MCP oficial de fato lê
  (via `GOOGLE_APPLICATION_CREDENTIALS`, materializado em arquivo por
  `scripts/materialize-google-ads-credentials.ts` — ver seção abaixo).

## MCP oficial e ingestão automática (#5237, corrigido no #6450)

- **`.mcp.json` → `google-ads`**: entrada `stdio` (`pipx run --spec
  git+https://github.com/googleads/google-ads-mcp.git google-ads-mcp`),
  servidor oficial do time do Google Ads (link no topo do arquivo, ver
  também a issue #5237). Diferente do `clarice` (HTTP + header-auth), esse
  MCP é um processo local que lê as credenciais do próprio ambiente (`env`
  no bloco da entrada). **Requer `pipx` instalado** (Python ≥3.10) nas 3
  máquinas — `pip install --user pipx && pipx ensurepath`, reabrir o
  terminal — sem ele o processo do MCP nem sobe (achado do #6450).

  **Contrato de auth do servidor MCP em si é DIFERENTE do fluxo REST usado
  por `google-ads-ingest-spend.ts`/`google-ads-associate-token.ts` (achado
  do fleet review do PR #5380, 15/08/2026).** A 1ª versão desta entrada
  declarava `GOOGLE_ADS_CLIENT_ID`/`GOOGLE_ADS_CLIENT_SECRET`/
  `GOOGLE_ADS_REFRESH_TOKEN` — vars do fluxo OAuth REST, que o servidor MCP
  não lê (confirmado contra o README oficial de `googleads/google-ads-mcp`).
  **Correção do #6450 (27/08/2026), lendo o fonte do server
  (`ads_mcp/utils.py`, `_create_credentials()`) em vez do README**: o
  servidor só reconhece **ADC** — nunca `GOOGLE_PROJECT_ID` (removido da
  entrada, não lido em lugar nenhum) nem o proxy OAuth do FastMCP citado
  antes aqui (não implementado nesta versão do server). ADC lê
  `GOOGLE_APPLICATION_CREDENTIALS` (path de um JSON de Service Account) +
  `GOOGLE_ADS_DEVELOPER_TOKEN` + `GOOGLE_ADS_LOGIN_CUSTOMER_ID`/
  `GOOGLE_ADS_CUSTOMER_ID`.

  **Decisão do editor (#6450): Service Account + Doppler**, não `gcloud auth
  application-default login` interativo por máquina — permite as 3 máquinas
  puxarem a mesma credencial via `npm run sync-env`. Passos manuais
  (bloqueio externo, GCP Console + Google Ads, fora do escopo de código):
  1. Criar a Service Account no GCP Console (IAM → Service Accounts →
     Create, projeto `velvety-tube-505505-d1`), confirmar que a Google Ads
     API está habilitada.
  2. Gerar e baixar a chave JSON.
  3. No Google Ads (MCC `623-609-4249`): Tools & Settings → Access and
     security → Users → convidar `google-ads-mcp@{project}.iam.gserviceaccount.com`
     com acesso Read only.
  4. Subir o conteúdo da JSON no Doppler como `GOOGLE_ADS_SERVICE_ACCOUNT_JSON`.

  Depois de `npm run sync-env`, rodar `npx tsx
  scripts/materialize-google-ads-credentials.ts` — materializa a credencial
  num arquivo local (`~/.config/diaria/google-ads-sa.json`) e atualiza
  `GOOGLE_APPLICATION_CREDENTIALS` em `.env` automaticamente (fail-soft:
  sem a var no Doppler ainda, só avisa e sai 0 — nada quebra). Validar com
  `/mcp` depois de reabrir o Claude Code. **Não testado ao vivo** — os 4
  passos manuais acima ainda não rodaram (nenhuma escrita real no GCP/Google
  Ads Console nesta rodada). O script de ingestão REST
  (`google-ads-ingest-spend.ts`) é um caminho INDEPENDENTE — usa
  `CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`, já fail-soft, não depende de nada
  desta seção.
- **`scripts/google-ads-ingest-spend.ts`** (+ núcleo puro
  `scripts/lib/google-ads-ingest.ts`): traduz GAQL (`segments.date` +
  `metrics.cost_micros`, agregado por mês) pro formato de
  `data/aquisicao/spend.csv` (#5236), fazendo merge idempotente por
  (`canal`, `mes`) — nunca duplica nem apaga linhas de outros canais/meses.
  **Fail-soft por design**: qualquer variável de ambiente ausente, ou
  qualquer falha na chamada (rede, auth, `DEVELOPER_TOKEN_NOT_APPROVED`),
  vira um aviso no stderr e `spend.csv` fica como estava — nunca quebra
  `cac-report.ts`, que segue lendo o CSV mantido manualmente. Cobertura em
  `test/google-ads-ingest-5237.test.ts` usa fixtures GAQL sintéticas — não
  chama a API real.

  **Fail-soft ≠ silêncio (corrigido 17/08/2026).** A falha é classificada
  antes de virar log, porque absorver tudo na mesma mensagem foi o que
  escondeu o bug do `LAST_90_DAYS` por dois dias:

  | Classe | Significado | Saída |
  |---|---|---|
  | `auth-pending` | Basic Access ainda na fila (#5262) | aviso normal, degrada pro CSV |
  | `defect` | query malformada / versão da API morta | **banner DEFEITO** — esperar não resolve |
  | `empty` | chamada OK, gasto zero (conta pausada) | linha de sucesso, não é falha |
  | `transient` | rede, 5xx, quota | aviso normal, degrada pro CSV |

  **O exit code continua 0 em todas as classes, inclusive `defect`** — a
  task agendada encadeia com `&&` o ingest da Microsoft
  (`docs/scheduled-tasks-registry.md`), e sair não-zero calaria o outro
  canal. O que separa defeito de indisponibilidade é o banner, não o exit
  code.

  A janela consultada são 90 dias via `BETWEEN` com datas calculadas
  (`buildDefaultGaqlQuery`, relógio injetável). **Não trocar por `DURING`** —
  ver a seção de verificação ao vivo no topo; nenhum literal `DURING` cobre
  90 dias (eles param em `LAST_30_DAYS`).

## Caminho manual — export CSV do painel (#5503)

Enquanto o Basic Access não sai da fila (caminho GAQL acima indisponível), o
painel do Google Ads (`ads.google.com`) permite exportar relatórios como CSV
à mão — **é o único caminho que funciona hoje**, mas o formato é bem
diferente do GAQL: preâmbulo de linhas livres (`Relatório de campanha` /
`Todo o período`), colunas em pt-BR, número com vírgula decimal/ponto de
milhar, linhas `Total:` e células ` --`. `scripts/lib/google-ads-csv.ts` +
`scripts/google-ads-import-csv.ts` cobrem esse formato (núcleo puro testado
contra fixture em `test/google-ads-csv-import.test.ts` — nunca lê
`data/aquisicao/google-ads/*.csv` real em teste, `data/` é gitignored).

1. No painel: Campanhas → exportar relatório de **campanhas** (e,
   opcionalmente, **anúncios**/**palavras-chave**/**termos de pesquisa**)
   como CSV, salvar em `data/aquisicao/google-ads/{tipo}-{AAMMDD}.csv`
   (convenção de nome usada pelo `listFilesByPrefix` do CLI: prefixo
   `campanhas-`/`palavras-chave-`/`termos-de-pesquisa-`).
2. Importar gasto por campanha, separado por sub-canal PMax/Search (reusa
   `SpendRow.subcanal`, #5496 — nunca um mecanismo novo):
   ```bash
   npx tsx scripts/google-ads-import-csv.ts --mes 2026-02
   ```
   **`--mes` é obrigatório** — os exports vêm em "Todo o período", sem
   coluna de data; o script nunca adivinha o mês (ver docstring do CLI). A
   única forma de ter `mes` derivado automaticamente é re-exportar do painel
   com segmentação por Data/Mês — ação futura do editor, o parser já aceita
   o formato de hoje sem mudança quando isso acontecer.
3. Ver keywords com zero impressão e termos com custo > 0 sem tocar
   `spend.csv` (requer `palavras-chave-*.csv`/`termos-de-pesquisa-*.csv` no
   mesmo diretório):
   ```bash
   npx tsx scripts/google-ads-import-csv.ts --report
   ```

## Manutenção

`https://arquivo.diar.ia.br/privacidade` é revalidada pelo Google enquanto a
marca estiver verificada — se responder 404, a verificação cai. A rota é travada
por `test/arquivo-privacidade-5262.test.ts`. Ao ligar ou desligar um canal que
toque dado de leitor, atualizar a lista de terceiros em
`workers/arquivo/src/render-privacy.ts`.

Pendência conhecida: a política **não declara a pessoa jurídica** (CNPJ). Foi
omitido de propósito — publicar um identificador legal errado é pior que omitir.
Confirmar qual entidade responde pelo projeto e incluir.
