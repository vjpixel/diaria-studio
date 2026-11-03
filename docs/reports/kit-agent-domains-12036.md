# Monitoramento de domínios de agentes — itens 2 e 3 da #12036

Consulta somente de leitura em 03/11/2026, 18:39 UTC. Issue e comentários relidos
pela API REST GitHub; consideradas apenas associações OWNER/MEMBER/COLLABORATOR.
Nenhuma decisão sobre o item 1, alteração de cadastro, cancelamento ou envio.

## Check reproduzível

`npx tsx scripts/report-kit-agent-domains.ts`

Usa a configuração Kit já existente no ambiente/`.env`, pagina a base inteira
com `status=all` e `include[]=attribution`, consulta estatísticas somente dos
matches e o vínculo ao formulário DOI configurado em `platform.config.json`.
Todas as chamadas são GET. Não exige serviço pago adicional.

A lista explícita inicial contém apenas `mail.grokbot.com`, domínio observado na
issue. Acrescentar domínios exige evidência e alteração da constante
`KNOWN_AGENT_DOMAINS`; não há descoberta heurística, correspondência por sufixo
ou classificação automática de pessoas como agentes. A lista não é exaustiva.

Saída JSON com uma linha por cadastro correspondente, sem e-mail, nome, ID,
data de cadastro, URL completa ou conteúdo livre de atribuição. Linhas não têm
identificador persistente. Contagens ausentes/leituras de stats malsucedidas são
`null`, nunca zero. Falha na leitura de vínculo do form também resulta em
`null`, sem bloquear o monitoramento. A contagem de ativos é derivada do estado;
não se altera nenhuma métrica de aquisição existente.

## Resultado observado

Base integral: 1.629 cadastros. Matches: 4 (aproximadamente 0,25%), todos ativos.

| Domínio | Cadastros | Ativos | Envios | Aberturas | Cliques |
| --- | ---: | ---: | ---: | ---: | ---: |
| mail.grokbot.com | 4 | 4 | 15 | 0 | 0 |

Distribuição dos envios por cadastro: 7, 4, 2 e 2. As estatísticas são os
agregados `sent`, `opened`, `clicked` do Kit, não uma medição independente de
leitura humana ou de consumo por agente.

## Atribuição dos quatro cadastros

- 4/4 têm atribuição nativa de criação por API (`api_subscription`,
  `direct_api_call`), sem nome de fonte preenchido.
- 4/4 constam no formulário DOI configurado, confirmado por paginação de
  `GET /forms/{form_id}/subscribers?status=all`, sem inferência a partir de tags.
- 4/4 têm domínio de referrer nativo `diar.ia.br` e campos UTM armazenados.
  Valores livres de UTM não são publicados para evitar PII.
- 1/4 tem domínio de origem `www.google.com` em `origem_referrer`; os outros
  3/4 não têm domínio HTTP(S) recuperável nesse campo. Nenhum tem domínio
  recuperável em `referring_site`.

A configuração local identifica esse form como confirmação DOI. Em
`workers/poll/src/subscribe.ts`, `subscribeToKit` cria via API e, ao vincular o
cadastro ao DOI, monta um referrer em `https://diar.ia.br/` com os UTMs.
Portanto, o referrer nativo é compatível com o caminho do Worker e pode ser
sintético; não prova qual página ou formulário visual originou a inscrição.
O vínculo DOI prova participação na confirmação, não o ponto de aquisição.
O domínio de origem registrado em 1/4 também não prova identidade humana,
agente, busca específica ou autoria da inscrição.

Limitação: a API/configuração consultadas não permitem reconstruir a página
exata dos outros três nem identificar o formulário visual original. Não foram
buscados segredos adicionais, APIs pagas ou chamadas que enviem mensagens.
A investigação termina nessa evidência, sem bloquear o item 2.

## Validação

Testes afetados: correspondência exata do domínio, estatísticas desconhecidas
versus zero e minimização de atribuição/PII. Typecheck e seleção de guards de
conjunto executados; este diff não aciona guards de conjunto.
