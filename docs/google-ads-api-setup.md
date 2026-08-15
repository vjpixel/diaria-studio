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
- [ ] Basic Access sair da fila

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
  identificadores acima), não o nome nem o número. Adicionado em #5237,
  **ainda pendente de sync no Doppler** — só `.env.example` tem o placeholder
  até alguém com acesso ao vault rodar `npm run sync-env` ou
  `doppler secrets set GOOGLE_PROJECT_ID` manualmente.

## MCP oficial e ingestão automática (#5237)

Escopo desta issue, feito **exceto o item que depende do editor** (pedir o
developer token real — item 1 do checklist, ver issue):

- **`.mcp.json` → `google-ads`**: entrada `stdio` (`pipx run --spec
  git+https://github.com/googleads/google-ads-mcp.git google-ads-mcp`),
  servidor oficial do time do Google Ads (link no topo do arquivo, ver
  também a issue #5237). Diferente do `clarice` (HTTP + header-auth), esse
  MCP é um processo local que lê as credenciais do próprio ambiente (`env`
  no bloco da entrada).

  **Contrato de auth do servidor MCP em si é DIFERENTE do fluxo REST usado
  por `google-ads-ingest-spend.ts`/`google-ads-associate-token.ts` (achado
  do fleet review do PR #5380, 15/08/2026).** A 1ª versão desta entrada
  declarava `GOOGLE_ADS_CLIENT_ID`/`GOOGLE_ADS_CLIENT_SECRET`/
  `GOOGLE_ADS_REFRESH_TOKEN` — vars do fluxo OAuth REST, que o servidor MCP
  não lê (confirmado contra o README oficial de `googleads/google-ads-mcp`).
  O servidor MCP só reconhece 2 métodos de auth: **ADC** (`GOOGLE_APPLICATION_CREDENTIALS`
  apontando pro JSON de uma Service Account + `GOOGLE_PROJECT_ID` +
  `GOOGLE_ADS_DEVELOPER_TOKEN`) ou **proxy OAuth do FastMCP**
  (`GOOGLE_ADS_MCP_OAUTH_CLIENT_ID`/`_SECRET` + `GOOGLE_ADS_MCP_BASE_URL`).
  A entrada em `.mcp.json` foi corrigida pro caminho ADC (`GOOGLE_PROJECT_ID`
  + `GOOGLE_ADS_DEVELOPER_TOKEN` + `GOOGLE_ADS_CUSTOMER_ID` + `GOOGLE_APPLICATION_CREDENTIALS`)
  — mas **`GOOGLE_APPLICATION_CREDENTIALS` ainda não existe**: requer criar
  uma Service Account no GCP Console (IAM → Service Accounts → Create) e
  baixar a chave JSON, ação do editor fora do escopo do #5237/#5380 (ver
  `.env.example`). **Não testado ao vivo** por dois motivos empilhados —
  Basic Access ainda na fila (`DEVELOPER_TOKEN_NOT_APPROVED`) E a Service
  Account ainda não existe. Confirmar a entrada quando os dois saírem da
  fila. O script de ingestão REST (`google-ads-ingest-spend.ts`) é um
  caminho INDEPENDENTE — usa `CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`, já
  fail-soft, não depende de nada desta seção.
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

## Manutenção

`https://arquivo.diar.ia.br/privacidade` é revalidada pelo Google enquanto a
marca estiver verificada — se responder 404, a verificação cai. A rota é travada
por `test/arquivo-privacidade-5262.test.ts`. Ao ligar ou desligar um canal que
toque dado de leitor, atualizar a lista de terceiros em
`workers/arquivo/src/render-privacy.ts`.

Pendência conhecida: a política **não declara a pessoa jurídica** (CNPJ). Foi
omitido de propósito — publicar um identificador legal errado é pior que omitir.
Confirmar qual entidade responde pelo projeto e incluir.
