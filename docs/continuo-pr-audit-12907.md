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

## Decisão do editor (13/11/2026) e o que mudou

No briefing do overnight 261113b o editor decidiu: o contínuo atualiza (merge
da base, nunca rebase nem force-push) a branch da PR aprovada e verde parada
há mais de 6h, antes de ela conflitar. Retenção por caminho sensível, draft e
`retido-para-editor` seguem como estão.

Implementado como a ação `refresh_branch` de `decideStuckPrAction`
(`scripts/lib/continuo-stuck-pr.ts`), aplicada por
`scripts/continuo-resolve-stuck-prs.ts` no início de cada tick do
`continuo-pr-review.sh`. Condições, todas obrigatórias e fail-closed: review
independente `verdict=approve` cobrindo o HEAD atual, CI `pass`, sem commit há
6h+, atrás do master, fora de `retido-para-editor`, sem caminho sensível, não
draft e sem `bloqueio-execucao`. O `update-branch` vai com `expected_head_sha`
do HEAD aprovado. O HEAD novo dispara re-review e CI antes do merge, e a
idade da PR zera, então a próxima atualização só cabe 6h depois. PR que já
conflita continua sendo fechada por `close_conflict`.

## 07 a 09/11 sem entrega: o teto de 3 PRs ficou preso (#12908)

Investigação em 13/11/2026. A janela de 07/11 00:31Z a 10/11 09:49Z não teve
nenhuma PR nova do contínuo, com 22 a 23 ticks por dia. A fila não estava
vazia. O que travou foi o teto de 3 PRs `continuo/*` abertas
(`scripts/check-continuo-pr-cap.ts`, #7746): três PRs escaladas ocuparam as
três vagas durante a janela inteira, e o tick com `mayClaim=false` não
reivindica issue nova, só trabalha a própria fila (§3c do SKILL.md do
contínuo).

| PR | Aberta | Escalada (marcador) | Saída |
| --- | --- | --- | --- |
| [#12300](https://github.com/vjpixel/diaria-studio/pull/12300) | 05/11 04:59 | 05/11 06:07; head novo 07/11 03:36 | fechada por conflito, 10/11 15:28 |
| [#12346](https://github.com/vjpixel/diaria-studio/pull/12346) | 06/11 19:23 | 06/11 19:26 | mergeada 10/11 09:21 |
| [#12351](https://github.com/vjpixel/diaria-studio/pull/12351) | 07/11 00:31 | 08/11 14:10 (draft com `bloqueio-execucao`) | mergeada 11/11 14:38 |

Horários em UTC, do `gh pr list --search 'head:continuo/'` e dos comentários
das PRs. As três tinham review `approve`. A primeira PR do contínuo depois da
janela, [#12656](https://github.com/vjpixel/diaria-studio/pull/12656), abriu
às 09:49 de 10/11, 28 minutos depois do merge da #12346 liberar uma vaga.
A [#12445](https://github.com/vjpixel/diaria-studio/pull/12445) (08/11 14:34),
única PR `continuo/*` aberta dentro da janela, saiu de uma sessão interativa
(link de sessão claude.ai no corpo, sem marcador `continuo-owner-session`),
não de um tick.

O teto conta toda PR aberta exceto `continuo/rescue-*`, inclusive escalada e
draft com `bloqueio-execucao`. Enquanto uma PR escalada esperava o editor ou
o pickup do overnight, nada a tirava da contagem. O pickup do overnight só
mergeava PR limpa, então as rodadas de 07, 08 e 09/11 também não drenaram as
três. Os relatórios do cron de 09/11 (`~/.hermes/cron/output/5d791ef6fc2c/`)
registram "cap 3/3" e nomeiam as mesmas PRs. Os de 07 e 08/11 não estão mais
no diretório.

O que já fecha essa trajetória, todos mergeados depois da janela:

- #12765 (PR #12778, 11/11 00:58Z): prazo de 48h para PR escalada do
  contínuo. Passado o prazo sem destino, a PR é fechada e a vaga volta. Esse
  prazo fechou a #12351 às 00:59 de 11/11; ela foi reaberta e mergeada às
  14:38.
- #12684 (PR #12689, 10/11 17:37Z): escalada ganha motivo e dono, e a
  consulta de escaladas há mais de 24h entra no briefing do overnight e do
  develop.
- #12950 (PR #12986 e commit 944b0f5b7, 13/11): o overnight assume PR das lanes autônomas pelo
  `orphanAction` (`merge-via-gate2` para PR verde e sem retenção), e há
  alarme de PR aprovada e verde parada.

Com o prazo de 48h, o pior caso de vaga presa por escalada cai de "sem
limite" para 48h por PR. Não muda a regra de contagem do teto: PR escalada
continua contando enquanto está aberta. Tirá-la da contagem deixaria o
contínuo abrir PRs mais rápido do que o editor consegue triar, e essa é uma
decisão de política que esta investigação não toma.

Para diagnosticar o próximo "ticks sem entrega", a ordem que resolveu este
caso: (1) PRs `continuo/*` criadas por dia, com `gh pr list --state all
--search 'head:continuo/ created:A..B'`, separa "não abriu" de "não
mergeou"; (2) se não abriu, as PRs abertas no período e o `counted` de
`check-continuo-pr-cap.ts` dizem se o teto estava cheio; (3) o marcador
`continuo-escalate` e o comentário de review de cada uma dizem por que não
saíram. Os sidecars de `data/continuo/tick-sidecars` contam ticks, não
entregas, e não respondem a nenhuma das três perguntas.
