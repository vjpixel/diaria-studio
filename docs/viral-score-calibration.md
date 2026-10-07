# Calibração do bônus "viral" contra clique real (#8672)

Rodada de 07/10/2026, sessão `/diaria-develop 261007`. Script reprodutível:
`npx tsx scripts/calibrate-viral-score.ts --bootstrap 1000 --out report.json`
(read-only; lê `data/`, não escreve nada lá).

## Conclusão

**Os sinais "viral" não preveem clique melhor que os bônus atuais. Proposta:
descartar o bônus e não levá-lo para produção.**

- Nenhum dos 7 sinais tem efeito positivo com IC 95% acima de zero.
- Seis dos sete coeficientes saem negativos. O único positivo,
  `newsletter_mentions`, tem IC que cruza zero com folga (−0,13 a +0,27).
- O bônus do POC do jeito que foi especificado, com pesos e tetos, tem efeito
  **negativo** e robusto: −0,32 por 10 pontos de bônus (IC 95% −0,59 a −0,06),
  na escala log-CTR. Na mesma edição, seção e posição, e com o mesmo score
  atual, cada 10 pontos de "viral" vêm com cerca de 28% **menos** CTR.
- No holdout, o modelo B (score atual + sinais viral) empata com o modelo de
  só posição (C0: 0,5826 × 0,5826). O ganho de B sobre A (+2,3 p.p.) vem dos
  coeficientes negativos que o ajuste aprende, e não de um sinal que premie
  o artigo. Ligar o bônus com o sinal positivo do POC piora a ordenação.

Ressalva sobre poder estatístico: o holdout tem 218 pares comparáveis, o que dá
um erro-padrão de cerca de 3,4 p.p. na concordância. A amostra não descarta um
efeito positivo pequeno. Pegando `people_gov`, o limite superior do IC (+0,17)
equivale a uns 18% a mais de CTR. O que a amostra descarta é o seguinte: não há
evidência positiva, e a direção observada é contrária à do bônus.

## Amostra

| | |
|---|---|
| Edições | 92 (260514 a 261002; as edições dos últimos 3 dias ficam de fora, CTR imaturo) |
| Edições com inbox capturado (`captured-newsletters.json`) | 85 |
| Links de artigo publicados com cliques casados | 1.000 (de 1.049 manchetes; 49 sem artigo correspondente em `01-approved.json`) |
| Cliques únicos somados | 1.985 |
| Entregues por edição | 271 a 1.153 (mediana 544), Beehiiv e Kit somados |
| Holdout cronológico | 28 edições mais recentes (260825 a 261002), 254 links |

Os sinais foram recalculados retroativamente em todo o histórico com
`extractViralSignals`, e não só nas edições depois do POC: só uma edição
(260922) teve o bônus aplicado de verdade. Prevalência na amostra, já com as
guardas: `recent_36h` 432, `big_company` 340, `conflict_harm` 63,
`policy_geo` 57, `people_gov` 47, `newsletter_mentions` 34, `money_scale` 24.

Fontes: `02-reviewed.md` (o texto que chegou ao leitor, com a seção de cada
link), `_internal/01-approved.json` (título, resumo, data, score e bônus que o
scorer viu), `data/beehiiv-cache/posts` + `data/kit-cache/broadcasts`
(cliques únicos por link e entregues). Ficam fora: envio com menos de 50
destinatários (teste), envio não publicado e envio sem cliques buscados ou com
zero clique em todos os links. Esse último é enriquecimento que falhou (por
exemplo, 260820: 641 entregues e `clicks: []`), e não leitor que deixou de clicar.

## Método

- **Desfecho:** CTR sobre **entregues**, ou seja, cliques únicos do link
  (Beehiiv + Kit) / entregues (Beehiiv `delivered` + Kit `recipients`). Nunca
  `click_rate` da Beehiiv, que é click-to-open. A regressão usa
  `log(CTR + 0,5/entregues)`.
- **Confusão de posição:** a posição domina o clique (CTR médio de Use Melhor
  0,49%, destaque 0,31%, Radar 0,18%). Por isso todo modelo é estimado
  **dentro da célula edição × seção** (efeito fixo: y e features centrados na
  célula) e ainda controla `log(posição na seção)`. Como o denominador é o
  mesmo para todos os links de uma edição, o efeito fixo também deixa o
  resultado igual com entregues ou com aberturas.
- **Validação:** holdout cronológico (30% das edições mais recentes) que nunca
  entra no ajuste. A métrica é a concordância par a par dentro da célula
  (fração dos pares com CTR diferente que o modelo ordena certo; 0,5 é o mesmo
  que tirar no cara ou coroa). Os ICs saem de bootstrap de edições (1.000
  sorteios, seed 8672) sobre a amostra inteira.
- **Regra de decisão, fixada antes de olhar o resultado:** "viral prevê" se o
  modelo B ganha pelo menos 1 p.p. de concordância no holdout sobre A **e** pelo
  menos um sinal viral tem coeficiente positivo com IC 95% inteiro acima de zero.

Por que não usar `calibrate-scoring-weights.ts` (#7990) direto: o rótulo dele
é a decisão do editor no gate (`kept`, `lib/calibration-labels.ts`), não o
clique do leitor, que é o que a #8672 pede. O script novo segue as mesmas
disciplinas (holdout cronológico nunca usado no treino, read-only, regra
explícita de rejeição) com o desfecho de leitor.

## Coeficientes (amostra inteira, IC 95% por bootstrap)

Escala: log-CTR. Um coeficiente de +0,10 equivale a uns 10,5% a mais de CTR.

| Modelo | Concordância holdout | Coeficientes |
|---|---|---|
| C0 só posição | 0,5826 | log_position −0,223 (−0,294 a −0,151) |
| A score atual | 0,5596 | score_current/10 +0,032 (−0,004 a +0,064) |
| A' bônus atuais decompostos | 0,5183 | score_base/10 +0,032; impact_routine −0,065; impact_routine_br +0,085 (todos com IC cruzando zero) |
| V só sinais viral | 0,5826 | ver B |
| **B score atual + sinais viral** | **0,5826** | score_current/10 +0,039 (+0,001 a +0,075) |
| | | people_gov −0,103 (−0,369 a +0,170) |
| | | big_company −0,062 (−0,164 a +0,048) |
| | | conflict_harm −0,021 (−0,204 a +0,170) |
| | | money_scale −0,145 (−0,303 a +0,036) |
| | | policy_geo −0,113 (−0,354 a +0,114) |
| | | newsletter_mentions +0,051 (−0,130 a +0,267) |
| | | recent_36h −0,116 (−0,226 a −0,008) |
| P score atual + bônus do POC | 0,5872 | viral_poc_points/10 **−0,323 (−0,592 a −0,057)** |

Sensibilidade com holdout de 50%: a direção é a mesma. Nenhum sinal sai com IC
positivo, e B fica a +1,4 p.p. de C0, abaixo do erro-padrão de ~2,6 p.p.

Um achado à parte, que fica registrado aqui e não vira mudança: dentro da
célula, o próprio score atual prevê clique só de leve (+3,9% de CTR por 10
pontos, IC raspando zero), e ordenar o holdout por ele sai pior que ordenar só
por posição. Isso não é motivo para premiar "viral" (que vai na direção
contrária), mas deixa claro que o rubrico atual também tem pouco poder sobre o
clique depois que a posição é controlada.

## O que mudou no código (não ligado em produção)

- `scripts/lib/viral-score.ts`: `extractViralSignals` (sinais crus, insumo da
  calibração) separado de `computeViralBonus`. As guardas do item 3 entram no
  módulo para o modo de auditoria e para a calibração medir o que a produção
  mediria: sem bônus para rede social (o falso positivo do tweet em 260922),
  `verify_verdict` `paywall`/`anti_bot`, tutorial/vídeo e base abaixo de 40.
  O gancho de dano não conta quando o artigo já é `negative_impact`, porque o
  requisito de impacto negativo é garantido por backstop e é
  `NON_CALIBRATABLE_FEATURES`. O teto de +15 continua, agora com clamp do score
  em 100 e sinais que fecham com o bônus gravado (`cap:-N`). Também foram
  resolvidas as pendências P3 do review da #8673: menção de URL não casa mais
  por prefixo, a newsletter de origem não conta como menção e
  "meta"/"processo"/"lei" genéricos deixaram de ser falso positivo em PT.
- `scripts/apply-viral-poc.ts`: a auditoria (`viral-poc-audit.json`) passa a
  registrar `selection_changes`, isto é, quem entrou ou saiu do top-N de
  finalistas (`--top`, padrão 15, o mesmo do `merge-scored-chunks.ts`) por
  causa do bônus (item 5).

## Pendências

- **Decisão de descarte (editor):** com este resultado, o próximo passo natural
  é remover `viral-score.ts`/`apply-viral-poc.ts`. O script de calibração
  continua útil para testar sinais novos.
- Item 2 (sinais melhores que regex: cobertura por história/cluster, atenção
  externa, `actor_p` do Jev) e item 4 (braço do A/B do Jev) não foram feitos.
  Com sinal negativo nos sinais lexicais, um braço de A/B só se justifica se
  um sinal do item 2 passar primeiro por esta mesma calibração.
