# Calibração do bônus "viral" contra clique real (#8672)

**Decisão: o bônus de viralização foi descartado em 07/10/2026 por decisão
do editor, com base nesta calibração.** O POC (`scripts/lib/viral-score.ts`,
`scripts/apply-viral-poc.ts`, PR #8673) saiu do repo. Ficaram o script de
calibração e os sinais crus em `scripts/lib/viral-signals.ts`, para que um
sinal novo passe pela mesma régua antes de qualquer proposta futura de bônus.

Rodada de 07/10/2026, sessão `/diaria-develop 261007`, refeita depois do
review da PR #9840 (atribuição envio→edição e dado ausente × zero). Para
reproduzir:
`npx tsx scripts/calibrate-viral-score.ts --bootstrap 1000 --out report.json`
(read-only: lê `data/`, não escreve nada lá). Para a sensibilidade estrita,
acrescentar `--absent-is-missing`.

## Conclusão

**Os sinais "viral" não preveem clique melhor que os bônus atuais.** Isso
vale na análise principal e nas duas sensibilidades.

- Nenhum dos 7 sinais tem efeito positivo com IC 95% acima de zero. Na análise
  principal, seis dos sete saem negativos. Dois saem negativos com IC
  inteiramente abaixo de zero: `money_scale` −0,20 (IC −0,36 a −0,04) e
  `recent_36h` −0,13 (IC −0,21 a −0,03). O único positivo, `newsletter_mentions`
  (+0,04), tem IC de −0,15 a +0,25.
- Os **pesos do POC aplicados aos sinais corrigidos** (modelo P, ver "Modelos")
  dão −0,36 por 10 pontos de bônus (IC 95% −0,59 a −0,12), em log-CTR. Na mesma
  edição, seção e posição, e com o mesmo score atual, cada 10 pontos de "viral"
  correspondem a uns 30% **menos** CTR.
- No holdout, B (score atual + sinais) ordena pior que A (−1,9 p.p.) e pior
  que só a posição, C0 (−3,3 p.p.). O ganho de P sobre A (+1,4 p.p.) só deixa P
  empatado com C0, e vem do coeficiente negativo.

Ressalva de poder estatístico: o holdout tem 215 pares comparáveis, o que dá
erro-padrão de **pelo menos** 3,4 p.p. na concordância. É um limite inferior,
porque os pares compartilham links e não são independentes. A amostra não
descarta um efeito positivo pequeno: o limite superior do IC de `people_gov`
(+0,19) equivale a uns 21% a mais de CTR. O que ela mostra é que não há
evidência positiva e que a direção observada é contrária à do bônus.

## Amostra (análise principal)

| | |
|---|---|
| Edições | 102 (260508 a 261002) |
| Edições com inbox capturado (`captured-newsletters.json`) | 88 |
| Linhas (links com dado de clique e score) | 1.078; **N efetivo 1.017** (em células com ≥ 2 links, as que de fato entram no ajuste) |
| Manchetes lidas | 1.193: 70 sem artigo em `01-approved.json`, 2 de URL repetida na edição, 43 sem `score` nem `score_base`, 0 sem dado de clique |
| Cliques únicos | 1.872 |
| Holdout cronológico | 31 edições (260819 a 261002), 259 linhas |

Edições puladas, por motivo:

| Motivo | Edições |
|---|---|
| `no_approved` | 260417, 260419, 260420 |
| `no_reviewed_md` | 260418, 260422, 260426 |
| `no_headlines` (formato sem manchete reconhecível) | 260423, 260424, 260427, 260428, 260429, 260430, 260504, 260505, 260506, 260507, 260509 |
| `no_send` (nenhum envio casou) | 260510, 260516, 260517, 260817, 260818, 260820 |
| `too_recent` (CTR imaturo) | 261005, 261006, 261007 |

Envios: 107 atribuídos (70 pelo `edition=` do poll e 37 por overlap de
URLs). Ficaram 154 sem atribuição, entre envios de edições sem
`01-approved.json`, envios de outro conteúdo e o cache poluído por fixture
(`example0.com…`). Nenhum ficou ambíguo. Foram descartados 71 envios
pequenos (menos de 50 entregues: teste ou variante como `-patronos`), 8 não
publicados e 4 com zero clique em todos os links (enriquecimento que falhou).

CTR médio por seção (calculado sobre as linhas do ajuste; o detalhe está em
`sample.section_stats` do relatório JSON): Use Melhor 0,48%, destaque 0,30%,
Lançamentos 0,22%, Radar 0,18%.

Prevalência dos sinais, já com as guardas: `recent_36h` 508, `big_company`
366, `policy_geo` 64, `conflict_harm` 63, `people_gov` 50, `money_scale` 28,
`newsletter_mentions` 26.

## Método

- **Unidade:** manchete de `02-reviewed.md` (os formatos `**[t](u)**` e
  `[**t**](u)`, 1 por bloco DESTAQUE) casada por URL canônica com um artigo de
  `_internal/01-approved.json`. Título, resumo, data, score e bônus vêm de lá.
  Os sinais foram recalculados retroativamente em todo o histórico; só a 260922
  teve o bônus aplicado de verdade.
- **Envio → edição:** cada post da Beehiiv e cada broadcast do Kit é atribuído
  pelo `edition=AAMMDD` do link de poll, quando houver, e senão pelo maior
  overlap entre a lista de cliques e as manchetes (mínimo de 2). Nunca só pela
  data do `publish_date`. Empate de overlap desempata pela data BRT; se ainda
  houver empate, o envio fica ambíguo e sai.
- **Ausente na lista × zero medido:** o significado depende da origem.
  Medido em 07/10/2026 sobre o cache real:
  - **Kit** lista todo link do broadcast, inclusive os sem clique (1.702 de
    2.695 entradas zeradas). Link ausente = **sem dado**: sai do ajuste e entra
    em `links_without_click_data`.
  - **Beehiiv** (`list_post_clicks`) só lista links que tiveram algum clique.
    Das 444 entradas com `email.unique_clicks = 0`, 443 têm clique WEB (é por
    isso que estão na lista) e só 1 é zero em tudo. Link ausente = **zero
    medido**. Tratar esse ausente como "sem dado" descartaria justamente os
    links sem clique e truncaria o desfecho por baixo.

  Com Beehiiv + Kit na mesma edição, o link só tem dado se tiver dado nos dois.
  Uma edição com cobertura (links com dado / links casados) abaixo de 50% sai
  inteira (`low_click_coverage`). Na análise principal nenhuma caiu nisso.
- **Desfecho:** CTR sobre **entregues**, isto é, cliques únicos somados nos
  envios divididos pela soma de entregues (Beehiiv `delivered`, Kit
  `recipients`). Nunca `click_rate`. A regressão usa `log(CTR + 0,5/entregues)`.
- **Posição:** todo modelo é estimado dentro da célula edição × seção (efeito
  fixo) e controla `log(posição na seção)`. Como o denominador é o mesmo dentro
  da edição, o resultado não depende de usar entregues ou aberturas.
- **Validação:** holdout cronológico com os 30% de edições mais recentes, que
  nunca entram no ajuste. A métrica é a concordância par a par dentro da célula
  (0,5 = cara ou coroa). Os coeficientes e o IC 95% vêm da amostra inteira, com
  bootstrap de edições (1.000 sorteios, seed 8672). Feature sem variância
  dentro da célula sai como `inestimable`, com coeficiente e IC `null`; nesta
  rodada, nenhuma.
- **Regra de decisão (fixada antes de ver o resultado):** "viral prevê" se
  B ganhar pelo menos 1 p.p. de concordância no holdout sobre A **e** pelo menos
  um sinal tiver coeficiente positivo com IC 95% inteiro acima de zero.
- **Premissa de recência:** "agora" = D 00:00 UTC (D-1 21h BRT, perto da hora
  em que a pesquisa roda). A hora real de cada execução não está gravada de
  forma uniforme no histórico.
- **Sinais × guardas:** guardas de tipo de link (rede social,
  `paywall`/`anti_bot`, tutorial/vídeo) zeram o sinal, porque esse link nunca
  teria bônus. O piso de score 40 **não** zera: ele existe para não resgatar
  artigo fraco, mas o artigo foi publicado e o clique mede o sinal do mesmo
  jeito. `viralGuard` checa o piso por último, então um link guardado por tipo
  nunca sai rotulado só como `below_min_base`.

`calibrate-scoring-weights.ts` (#7990) não foi usado diretamente porque o
rótulo dele é a decisão do editor no gate (`kept`), e não o clique do leitor.

### Modelos

- **C0:** só posição.
- **A:** posição + score atual (sem o `viral:` do POC).
- **A':** posição + score de base + bônus atuais decompostos (com suporte ≥ 15).
- **V:** posição + os 7 sinais.
- **B:** posição + score atual + os 7 sinais.
- **P:** posição + score atual + `pocBonusPoints`. **Não é o POC exato que
  rodou na 260922**: são os pesos e tetos do POC aplicados aos sinais
  corrigidos desta calibração (casamento de URL sem prefixo, newsletter de
  origem descontada, regex de PT corrigidas), com as guardas do item 3. Mede "o
  bônus como foi desenhado", e não "o bônus como rodou".

## Coeficientes (análise principal, IC 95% por bootstrap)

Escala log-CTR: +0,10 equivale a uns 10,5% a mais de CTR.

| Modelo | Concordância holdout | Coeficientes |
|---|---|---|
| C0 só posição | 0,5767 | log_position −0,243 (−0,309 a −0,175) |
| A score atual | 0,5628 | score_current/10 +0,059 (+0,001 a +0,115) |
| A' bônus atuais decompostos | 0,4930 | score_base/10 +0,060 (−0,003 a +0,122); impact_routine −0,059; impact_routine_br +0,094 (IC cruzam zero) |
| V só sinais viral | 0,5535 | people_gov −0,100 (−0,366 a +0,193); big_company −0,069 (−0,175 a +0,031); conflict_harm −0,046 (−0,247 a +0,141); money_scale −0,203 (−0,361 a −0,030); policy_geo −0,069 (−0,296 a +0,145); newsletter_mentions +0,035 (−0,148 a +0,261); recent_36h −0,109 (−0,194 a −0,013) |
| **B score atual + sinais viral** | **0,5442** | score_current/10 +0,070 (+0,014 a +0,124) |
| | | people_gov −0,094 (−0,350 a +0,196) |
| | | big_company −0,070 (−0,175 a +0,029) |
| | | conflict_harm −0,049 (−0,253 a +0,138) |
| | | money_scale −0,204 (−0,359 a −0,042) |
| | | policy_geo −0,072 (−0,305 a +0,146) |
| | | newsletter_mentions +0,039 (−0,145 a +0,249) |
| | | recent_36h −0,129 (−0,213 a −0,032) |
| P score atual + pesos do POC | 0,5767 | viral_poc_points/10 **−0,357 (−0,590 a −0,120)** |

## Sensibilidades

| Variante | Amostra | Algum sinal com IC > 0? | Pesos do POC (P) | B − A no holdout |
|---|---|---|---|---|
| Principal | 102 edições, 1.078 linhas | não | −0,36 (−0,59 a −0,12) | −1,9 p.p. |
| Holdout 50% (mesma amostra) | 51 edições no holdout, 362 pares | não | igual (o coeficiente é da amostra inteira) | +1,1 p.p.; B − C0 também +1,1 p.p., dentro do erro-padrão |
| Estrita (`--absent-is-missing`: ausente da Beehiiv = sem dado) | 52 edições, 380 linhas; 50 edições abaixo de 50% de cobertura; 130 links sem dado | não (people_gov −0,29, IC −0,62 a +0,04) | −0,25 (−0,53 a −0,001) | −12,0 p.p. |

A variante estrita é a leitura conservadora pedida no review. Ela descarta
quase todos os zeros: só 4 das 380 linhas têm zero clique, contra 491 das 1.078
na principal. Isso trunca o desfecho, e por isso ela não é a análise principal.
Mesmo assim, a conclusão não muda.

Achado lateral (registrado aqui, sem virar mudança): dentro da célula, o score
atual prevê clique só de leve (+6% de CTR por 10 pontos), e ordenar o holdout
por ele sai pior do que ordenar só por posição.

## O que ficou no repo

- `scripts/calibrate-viral-score.ts`: dataset, atribuição de envios, os 6
  modelos e a regra de decisão.
- `scripts/lib/viral-signals.ts`: os sinais crus (`extractViralSignals`) e as
  guardas (`viralGuard`, união literal de motivos). Inclui as correções P3 do
  review da #8673: menção de URL sem casamento por prefixo, newsletter de origem
  descontada, e "meta", "processo" e "lei" genéricos sem falso positivo em PT.

## Fora do escopo (encerrado com o descarte)

- Item 2 (sinais melhores que regex: cobertura por cluster, atenção externa,
  `actor_p` do Jev) e item 4 (braço do A/B do Jev). Uma proposta nova começa
  com uma issue nova, e o sinal passa antes por esta calibração.
