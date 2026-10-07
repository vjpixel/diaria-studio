# Calibração do bônus "viral" contra clique real (#8672)

**Decisão: o bônus de viralização foi descartado em 07/10/2026 por decisão
do editor, com base nesta calibração.** O POC (`scripts/lib/viral-score.ts`,
`scripts/apply-viral-poc.ts`, PR #8673) saiu do repo. Ficam o script de
calibração e os sinais crus em `scripts/lib/viral-signals.ts`, para que um
sinal novo passe pela mesma régua antes de qualquer nova proposta de bônus.

Rodada de 07/10/2026, sessão `/diaria-develop 261007`. O script é reprodutível:
`npx tsx scripts/calibrate-viral-score.ts --bootstrap 1000 --out report.json`
(read-only; lê `data/` e não escreve nada lá).

## Conclusão

**Os sinais "viral" não preveem clique melhor que os bônus atuais.**

- Nenhum dos 7 sinais tem efeito positivo com IC 95% acima de zero. Seis dos
  sete coeficientes são negativos. O único positivo, `newsletter_mentions`, tem
  IC que cruza zero com folga (−0,13 a +0,26).
- O bônus do POC, com os pesos e tetos do POC (reproduzido por uma réplica
  congelada, `pocBonusPoints`), tem efeito **negativo** e robusto: −0,34 por 10
  pontos de bônus (IC 95% −0,61 a −0,07), em log-CTR. Na mesma edição, seção e
  posição, e com o mesmo score atual, cada 10 pontos de "viral" correspondem a
  cerca de 29% **menos** CTR.
- No holdout, o modelo B (score atual + sinais viral) fica 0,46 p.p. abaixo do
  modelo que usa só a posição (C0). O ganho de B sobre A (+1,8 p.p.) e o de P
  sobre A (+3,7 p.p.) vêm dos coeficientes negativos que o ajuste aprende, não
  de um sinal que premie o artigo. Ligar o bônus com o sinal positivo do POC
  pioraria a ordenação.

Ressalva sobre poder estatístico: o holdout tem 218 pares comparáveis, o que dá
um erro-padrão de uns 3,4 p.p. na concordância. A amostra não descarta um
efeito positivo pequeno: em `people_gov`, o limite superior do IC (+0,16)
equivale a uns 17% a mais de CTR. O que ela mostra é que não há evidência
positiva, e que a direção observada é a contrária à do bônus.

## Amostra

| | |
|---|---|
| Edições | 92 (260514 a 261002; as edições dos últimos 3 dias ficam de fora porque o CTR ainda está imaturo) |
| Edições com inbox capturado (`captured-newsletters.json`) | 85 |
| Links de artigo publicados, com cliques casados | 999 (de 1.044 manchetes; 43 sem artigo correspondente em `01-approved.json` e 2 ocorrências de URL repetida na mesma edição) |
| Entregues por edição | 271 a 1.153 (mediana 544), Beehiiv e Kit somados |
| Holdout cronológico | 28 edições mais recentes (260825 a 261002), 254 links |

Os sinais foram recalculados retroativamente em todo o histórico
(`extractViralSignals`), não só depois do POC: só uma edição (260922) teve o
bônus aplicado de verdade. Prevalência na amostra, já com as guardas:
`recent_36h` 432, `big_company` 339, `conflict_harm` 63, `policy_geo` 57,
`people_gov` 47, `newsletter_mentions` 34, `money_scale` 24.

Fontes:

- `02-reviewed.md`: o texto que foi ao leitor, com a seção de cada link e uma
  manchete por bloco DESTAQUE.
- `_internal/01-approved.json`: título, resumo, data, score e bônus que o
  scorer viu.
- `data/beehiiv-cache/posts` e `data/kit-cache/broadcasts`: cliques únicos por
  link e entregues.

Ficam de fora: envio com menos de 50 destinatários (teste), envio não
publicado, envio sem cliques buscados ou com zero clique em todos os links (é
enriquecimento que falhou, como na 260820, com 641 entregues e `clicks: []`, e
não leitor que não clicou), e URL publicada duas vezes na mesma edição (o
clique vem agregado por URL e não dá pra atribuí-lo a uma posição).

## Método

- **Desfecho:** CTR sobre **entregues**, ou seja, cliques únicos do link
  (Beehiiv + Kit) divididos pelos entregues (Beehiiv `delivered` + Kit
  `recipients`). Nunca o `click_rate` da Beehiiv, que é click-to-open. A
  regressão usa `log(CTR + 0,5/entregues)`.
- **Confusão de posição:** a posição domina o clique (CTR médio de 0,49% em
  Use Melhor, 0,31% no destaque e 0,18% no Radar). Por isso todo modelo é
  estimado **dentro da célula edição × seção**, com efeito fixo (y e features
  centrados na célula), e ainda controla `log(posição na seção)`. Como o
  denominador é o mesmo para todos os links de uma edição, o efeito fixo também
  torna o resultado insensível à escolha entre entregues e aberturas.
- **Validação:** holdout cronológico com os 30% de edições mais recentes, que
  nunca entram no ajuste. A métrica é a concordância par a par dentro da célula:
  a fração dos pares com CTR diferente que o modelo ordena certo (0,5 equivale a
  cara ou coroa). Os ICs vêm de bootstrap de edições (1.000 sorteios, seed 8672)
  sobre a amostra inteira. Uma feature sem variância dentro da célula sai
  marcada como `inestimable`, e não como efeito zero. Nesta rodada, nenhuma saiu
  assim.
- **Regra de decisão, fixada antes de olhar o resultado:** "viral prevê" se B
  ganhar pelo menos 1 p.p. de concordância no holdout sobre A **e** pelo menos um
  sinal viral tiver coeficiente positivo com IC 95% inteiro acima de zero.
- **Premissa de recência:** o "agora" da recência é D 00:00 UTC (D-1 às 21h
  BRT, perto da hora em que a pesquisa roda). A hora real de cada execução não
  fica gravada de forma uniforme no histórico. O desvio só afeta `recent_36h`
  perto do limite de 36h, e esse sinal sai negativo de qualquer forma.

Por que não usar `calibrate-scoring-weights.ts` (#7990) direto: o rótulo dele
é a decisão do editor no gate (`kept`, `lib/calibration-labels.ts`), não o
clique do leitor, que é o que a #8672 pede. O script novo segue as mesmas
disciplinas (holdout nunca usado no treino, read-only, regra explícita de
rejeição), mas com desfecho de leitor.

## Coeficientes (amostra inteira, IC 95% por bootstrap)

Escala log-CTR: +0,10 equivale a uns 10,5% a mais de CTR.

| Modelo | Concordância holdout | Coeficientes |
|---|---|---|
| C0 só posição | 0,5826 | log_position −0,225 (−0,295 a −0,153) |
| A score atual | 0,5596 | score_current/10 +0,032 (−0,004 a +0,064) |
| A' bônus atuais decompostos | 0,5183 | score_base/10 +0,032; impact_routine −0,067; impact_routine_br +0,085 (todos com IC cruzando zero) |
| V só sinais viral | 0,5826 | ver B |
| **B score atual + sinais viral** | **0,5780** | score_current/10 +0,039 (+0,001 a +0,074) |
| | | people_gov −0,113 (−0,379 a +0,163) |
| | | big_company −0,057 (−0,159 a +0,057) |
| | | conflict_harm −0,028 (−0,218 a +0,161) |
| | | money_scale −0,147 (−0,304 a +0,038) |
| | | policy_geo −0,115 (−0,356 a +0,111) |
| | | newsletter_mentions +0,049 (−0,133 a +0,264) |
| | | recent_36h −0,120 (−0,230 a −0,010) |
| P score atual + bônus do POC | 0,5963 | viral_poc_points/10 **−0,340 (−0,613 a −0,070)** |

Sensibilidade com holdout de 50% (antes dos ajustes finais de amostra): a
direção é a mesma, nenhum sinal sai com IC positivo, e B fica +1,4 p.p. acima de
C0, dentro do erro-padrão de uns 2,6 p.p.

Achado lateral, registrado aqui e não transformado em mudança: dentro da
célula, o próprio score atual quase não prevê clique (+3,9% de CTR por 10
pontos, com IC raspando zero), e ordenar o holdout por ele sai pior do que
ordenar só por posição. Isso não justifica premiar "viral", que vai na direção
contrária, mas indica que o rubrico atual também tem pouco poder sobre o clique
depois que a posição é controlada.

## O que ficou no repo

- `scripts/calibrate-viral-score.ts`: dataset, os 6 modelos, a regra de
  decisão e `pocBonusPoints`, uma réplica congelada do bônus descartado, só para
  o modelo P continuar reproduzível.
- `scripts/lib/viral-signals.ts`: os sinais crus (`extractViralSignals`) e as
  guardas que uma produção teria (`viralGuard`: rede social, `paywall` e
  `anti_bot`, tutorial e vídeo, base abaixo de 40). Inclui as correções P3 do
  review da #8673: menção de URL não casa mais por prefixo, a newsletter de
  origem não conta como menção, e "meta", "processo" e "lei" genéricos deixaram
  de dar falso positivo em PT.

## Fora do escopo (encerrado com o descarte)

- Item 2 (sinais melhores que regex: cobertura por cluster, atenção externa,
  `actor_p` do Jev) e item 4 (braço do A/B do Jev). Uma proposta nova parte de
  uma issue nova, e o sinal passa primeiro por esta calibração.
