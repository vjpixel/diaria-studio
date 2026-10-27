# Penalidade de estudo genérico: por que o modo sombra não marcou nada em outubro (#11328)

Investigação de 27/10/2026, pedida pela #11328 e ligada à decisão pendente da
#9673 (ligar ou não `selection.generic_study_penalty.enabled`, #9462).

## Pergunta

Os 14 `_internal/01-generic-study-demoted.json` gravados de 261008 a 261028
estão com `demoted: []` e `kept: []`. O replay de 260915 a 261005 tinha dado 8
acertos. Ou o detector regrediu, ou a pauta mudou.

## Resposta: o detector não regrediu. Quem mudou foi o trio que chega até ele.

O classificador (`scripts/lib/generic-study-penalty.ts`) foi rodado, no
código de `master` de 27/10, sobre o `_internal/01-categorized.json` de todas
as edições de 260901 a 261028.

**Setembro: o detector continua marcando.** Os 8 destaques do replay saem
marcados como genéricos e seriam tirados do top-3, os mesmos de 05/10:

| Edição | Destaque (top-3) | Sinais |
|---|---|---|
| 260916 | IA já devolve 5,4 horas por semana ao RH: potencial chega a 31% da jornada; revela estudo | estudo, estatística, case |
| 260917 | Vídeo: Inteligência artificial já decide quais currículos chegam aos recrutadores | case |
| 260921 | 17,8% do mundo já usa IA no trabalho. Entenda onde o Brasil está nesse mapa | estatística, case |
| 260921 | Quase 70% dos médicos já usam IA, aponta estudo da MV | estudo, estatística, case |
| 260925 | Grupo Sabin reduz em 25% o tempo de atendimento com uso de IA | case |
| 260928 | Como as PMEs da América Latina estão acelerando o crescimento com o Gemini Enterprise | case |
| 260929 | Depois do hype, o que sobra? O pragmatismo que está mudando o uso da IA nas empresas | case |
| 260930 | McDonald's adota IA para calcular preço de seus lanches; entenda estratégia | case |

Antes da janela do replay, também marcam 260903, 260909 e 260910. Os 8 títulos
já estão travados como "genérico" em `test/generic-study-penalty-9462.test.ts`
(gabarito do editor), e esse teste segue verde. Uma regressão no classificador
quebraria o CI.

**Outubro: o formato continua no pool, mas não entra no trio.** Contagem de
candidatos que o classificador marca como genéricos em todos os buckets
(`lancamento`, `radar`, `use_melhor`, `video`) e em que rank eles caem nos
`highlights`:

| Período | Edições | Genéricos no pool (média por edição) | Edições com genérico no top-3 |
|---|---|---|---|
| 260901 a 261005 | 23 | ~2,2 | 10 |
| 261006 a 261028 | 16 | ~2,0 | 0 |

Em outubro aparecem genéricos nos `highlights`, mas só no rank 6 (261002,
261008, 261016), e a penalidade só age no top-3. Os poucos títulos de outubro
com sinal de estudo/estatística no trio caem num veto legítimo de fato novo,
por exemplo:

- 261006: "40% das empresas podem desativar agentes de IA até 2027 por falhas de governança, aponta pesquisa" (veto `fato:incidente`, por "falhas").
- 261021: "Modelo de IA da OpenAI rouba criptomoedas e mente para cientistas em relatório" (veto `fato:comportamento-de-ia`).
- 261023: "Com 66% dos médicos já usando IA, nova regra do CFM aumenta pressão por governança…" (veto `fato:decisao`, por "regra").

Os logs vazios, portanto, estão certos: em nenhuma edição de outubro o trio
selecionado tinha um estudo ou case genérico.

## Por que a seleção mudou (hipótese, não medida causal)

O formato saiu do trio sem que a penalidade estivesse ligada. Mudanças no
`scorer-select` e no Stage 1 que entraram no começo de outubro e plausivelmente
explicam isso:

- #9883 (08/10): ordem dos destaques calibrada pelas correções reais do editor,
  com regra explícita de que "levantamento corporativo de percentual não abre a
  edição".
- #9785 (06/10), #10165/#10166 (14/10): teto global por score e peso por
  categoria na ordem do trio.
- O pool cresceu de ~53 para ~88 candidatos por edição. Com mais concorrência,
  o trio fica com mais fato novo.

Não há experimento isolando cada uma dessas causas. O que os dados mostram é
o efeito: o formato visado ainda é coletado e não chega ao top-3.

## Consequência para a #9673

O critério da decisão (≥5 respostas explícitas ao 🔎 do gate 4) não tem como
ser atingido enquanto a seleção continuar assim, porque a pergunta só aparece
quando o trio tem um genérico. Remarcar a data da #9673 não muda nada. Daqui
saem duas leituras, e a escolha fica com o editor (trade-off de seleção):

1. A penalidade virou redundante: a seleção já faz o que ela faria. Encerrar a
   #9673 mantendo a flag desligada e o modo sombra ativo (custa zero e volta a
   perguntar se o formato reaparecer no trio).
2. Ligar a flag como rede de segurança, com base nos 8/8 acertos do replay de
   setembro e no 0/0 de outubro (nenhum falso positivo possível sem casos).

## Como reproduzir

Sobre o checkout com `data/` montado:

```ts
// classifica o top-3 de cada edição
import { demoteGenericStudyHighlights } from "./scripts/lib/generic-study-penalty.ts";
// para cada data/editions/{AAMM}/{AAMMDD}/_internal/01-categorized.json:
//   demoteGenericStudyHighlights(json.highlights).demoted
```

`npx tsx scripts/generic-study-shadow-report.ts` continua sendo o agregador das
respostas do gate 4. Ele lê só o feedback gravado e não reclassifica nada.
