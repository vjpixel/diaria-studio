# Auditoria das PRs do contínuo — #12907

Investigação em 12/11/2026, por REST (`pulls/N` e todos os comentários de
`issues/N/comments`). A issue #12907 não tinha comentários na releitura.
Escopo: os 20 descartes enumerados nela; não é uma nova contagem de todas
as PRs da janela. Links abaixo são fontes primárias do histórico remoto.

## Conflitos: houve review antes da espera

Todas as 11 PRs receberam marcador independente `verdict=approve` e depois
`continuo-escalate`, antes do fechamento por conflito. A tabela registra a
última aprovação observada e o fechamento, em UTC. Não mede quando o
conflito começou nem prova que o CI estava verde na aprovação.

| PR | Último approve | Fechamento por conflito |
| --- | --- | --- |
| [#12731](https://github.com/vjpixel/diaria-studio/pull/12731) | 10/11 21:48 | 11/11 20:26 |
| [#12705](https://github.com/vjpixel/diaria-studio/pull/12705) | 10/11 19:41 | 11/11 01:55 |
| [#12300](https://github.com/vjpixel/diaria-studio/pull/12300) | 07/11 03:36 | 10/11 15:28 |
| [#12136](https://github.com/vjpixel/diaria-studio/pull/12136) | 04/11 05:09 | 04/11 11:16 |
| [#11992](https://github.com/vjpixel/diaria-studio/pull/11992) | 03/11 06:39 | 03/11 12:44 |
| [#11951](https://github.com/vjpixel/diaria-studio/pull/11951) | 03/11 02:26 | 03/11 08:41 |
| [#11893](https://github.com/vjpixel/diaria-studio/pull/11893) | 02/11 14:03 | 02/11 20:07 |
| [#11773](https://github.com/vjpixel/diaria-studio/pull/11773) | 01/11 23:05 | 02/11 05:17 |
| [#11771](https://github.com/vjpixel/diaria-studio/pull/11771) | 01/11 23:07 | 02/11 05:17 |
| [#11700](https://github.com/vjpixel/diaria-studio/pull/11700) | 31/10 16:21 | 31/10 22:27 |
| [#11697](https://github.com/vjpixel/diaria-studio/pull/11697) | 30/10 21:18 | 31/10 03:24 |

Em #12731, os comentários do overnight explicitam CI verde, review presente
e retenção pelo caminho sensível `scripts/publish-shorts.ts`. #12300 e
#12731 são tentativas sucessivas da #12279: a primeira fechou em 10/11
15:28 e a segunda abriu em 10/11 19:58. Esse par demonstra retrabalho após
descarte, sem demonstrar duas implementações simultâneas.

Os marcadores de escalada desses casos contêm apenas o SHA. Não permitem
atribuir retrospectivamente a cada PR qual portão a reteve. No código atual,
`evaluateContinuoMergeGate` escala por caminho sensível, CI, estado de
merge, tamanho e outras condições. `decideStuckPrAction` fecha conflito
parado há 6h mesmo com `continuo-escalado`. Essa combinação explica uma
trajetória possível de espera e descarte; não demonstra erro de cálculo ou
que todas as 11 teriam autorização de merge.

## Os quatro descartes por duplicação têm causas distintas

- [#12186](https://github.com/vjpixel/diaria-studio/pull/12186): rescue
  automático em draft, fechado porque os dois arquivos eram idênticos aos
  da #12044. Não é evidência de dois claims da mesma issue.
- [#12890](https://github.com/vjpixel/diaria-studio/pull/12890): checklist
  residual da #12074 já coberto pelas mergeadas #12882/#12889. A issue
  continuava aberta pelo trailer pendente. Claim da issue não determina
  sozinho se esse subescopo já foi entregue.
- [#11921](https://github.com/vjpixel/diaria-studio/pull/11921): abriu às
  16:27 de 02/11; a concorrente overnight #11924 abriu às 17:07 e mergeou
  às 17:25 para a mesma #11916.
- [#11661](https://github.com/vjpixel/diaria-studio/pull/11661): abriu às
  03:44 de 30/10, seis minutos depois da overnight #11660, para a mesma
  #11547. #11660 mergeou às 12:48.

Os dois últimos pares comprovam concorrência entre lanes, mas o histórico
de PRs não contém o resultado de cada `claim-issue`, o estado sincronizado
do registry na hora ou uma liberação explícita. Não é possível distinguir
claim omitido, liberado, expirado ou uma divergência de sync somente com
esses dados. Não foi reproduzido um duplo sucesso do CAS.

No código atual, claims usam lock e check-and-set. Para coordenadores,
`claimReleaseMsForKind` retém por 24h, separadamente dos 90min de liveness
(`#7227`). `context/overnight-dispatch-rules.md`, item 28, já exige
`check-issue-open-pr.ts` antes do dispatch, com `cannot-verify` bloqueante;
também permite reavaliar implementação independente sob condições
documentadas. Uma PR aberta e uma claim viva são sinais diferentes.

## Resgates e demais descartes

[ #12274 ](https://github.com/vjpixel/diaria-studio/pull/12274) nasceu em
draft com `bloqueio-execucao`, declarando origem desconhecida. O review
rejeitou a alteração de horários de produção sem decisão rastreável; ela
foi fechada manualmente. O bloqueio evitou o merge observado.
[ #12326 ](https://github.com/vjpixel/diaria-studio/pull/12326) também era
rescue: o review apontou rascunhos temporários e conteúdo já no master;
fechou pelo prazo de escalada #12765. O gerador
`buildRescuePrArgs` exige draft e tenta aplicar a label de bloqueio.
Exigir proveniência antes de abrir qualquer rescue mudaria o desenho
explícito de preservação de trabalho desconhecido para triagem.

[ #12333 ](https://github.com/vjpixel/diaria-studio/pull/12333) e
[ #11882 ](https://github.com/vjpixel/diaria-studio/pull/11882) receberam
`update-branch` antes do fechamento por CI vermelho após tentativa de fix.
Em #11882 há comentário explícito de falta de `editorial-signoff:approved`;
classificar todo CI vermelho como falha técnica corrigível seria incorreto.
[ #12828 ](https://github.com/vjpixel/diaria-studio/pull/12828) foi fechada
por decisão do editor, mantendo a #12748 na #12764.

## Resultado e limite de ação

Não há evidência suficiente nesta amostra para uma correção de comportamento
com teste que falhe antes e passe depois. Não alterar TTL de claim, prazo de
descarte, autorização de merge, política de rescue ou encerramento do tick.
Uma revisão dessas políticas exige decisão explícita; a investigação não
a fornece. A issue permanece aberta para registrar esse limite.

Para atribuir uma próxima duplicação ao registry, preservar os resultados
dos claims de ambas as lanes e seus registros com timestamps na janela do
incidente. Para atribuir a espera a um portão específico, preservar a razão
do gate no momento da escalada. Não é necessário mudar cadência de cron
para reunir essa evidência. Nenhum novo mecanismo ou política é proposto
como correção comprovada por esta auditoria.
