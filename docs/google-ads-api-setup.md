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
- [ ] Domínio `diar.ia.br` verificado no Search Console e registrado como
      domínio autorizado
- [ ] Cliente OAuth criado; token associado ao projeto (ver abaixo)
- [ ] Verificação de marca concluída
- [ ] Credenciais no Doppler

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

## Pré-requisito escondido: associar o token ao projeto

Antes de a verificação valer para o Basic Access, o developer token precisa estar
**associado** ao projeto Cloud. Isso só acontece quando uma chamada à API é feita
com o token + uma credencial OAuth *deste* projeto. Segundo a própria doc:
tanto faz se a chamada sucede ou falha, se é conta de teste ou de produção, e
qual o nível do token. Uma chamada qualquer basta.

## Segredos

Vão para o Doppler (`diaria-studio` / `dev`), nunca para o repo:

- `GOOGLE_ADS_DEVELOPER_TOKEN` — API Center → "Ver token"
- `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` — cliente OAuth do projeto
- `GOOGLE_ADS_REFRESH_TOKEN` — do fluxo de consentimento
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID` — `6236094249` (a MCC, **sem** hífens)
- `GOOGLE_ADS_CUSTOMER_ID` — `2369219639` (a conta que tem os dados)

## Manutenção

`https://arquivo.diar.ia.br/privacidade` é revalidada pelo Google enquanto a
marca estiver verificada — se responder 404, a verificação cai. A rota é travada
por `test/arquivo-privacidade-5262.test.ts`. Ao ligar ou desligar um canal que
toque dado de leitor, atualizar a lista de terceiros em
`workers/arquivo/src/render-privacy.ts`.

Pendência conhecida: a política **não declara a pessoa jurídica** (CNPJ). Foi
omitido de propósito — publicar um identificador legal errado é pior que omitir.
Confirmar qual entidade responde pelo projeto e incluir.
