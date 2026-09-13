# Template — Edição Anual diar.ia.br

Formato exato da retrospectiva anual (#7569). Sai **duas vezes por ano**: no aniversário da diar.ia.br (agosto, cobrindo ago–jul) e em janeiro (cobrindo o ano civil). Vai para a **base própria** (Kit), como envio extra — a edição diária do dia sai normal.

Cada tema é uma narrativa que atravessa vários meses, não a notícia de um mês. O número de temas é **variável (3 a 7)** — o `analyst-anual` propõe e justifica, o editor confirma no gate da Etapa 4.

**A anual não tem Use Melhor, não tem Radar e não tem "É IA?".** Se alguma dessas seções aparecer no draft, o lint reprova.

**Todo label de seção (linha isolada tipo `ASSUNTO`, `TEMA 1 | X`, `INTRO`) DEVE sair envolto em `**negrito**`** — é o sinal que o render usa para separar as seções. Label em texto plano faz o draft colapsar num bloco só de prosa: zero imagens, zero seções (mesma causa raiz do #2794 no mensal).

```
**ASSUNTO (3 OPÇÕES)**
1. [opção 1 — máx. 70 chars, o eixo do período]
2. [opção 2 — outro ângulo]
3. [opção 3 — terceira via]

**PREVIEW**

[1 linha — síntese do período em até 100 chars]

**INTRO**

[Abre com "Nesta edição de aniversário," (ou, na rodada de janeiro, o
equivalente "Nesta edição de retrospectiva,"/"Neste balanço do ano,") — nunca
com uma frase de bastidor de produção como "Relendo tudo de uma vez para esta
edição" (#8054). 3-4 frases situando o período: o que ele foi, no conjunto.
Diz a janela real ("os doze meses entre agosto de 2025 e agosto de 2026"),
nunca "os últimos 12 meses" genérico — a 1ª rodada cobre 13. Não enumera os
temas; abre cena.]

---

**ANIVERSÁRIO**

> Só na rodada de agosto (`--tipo aniversario`). Na rodada de janeiro, a seção
> inteira não existe — não deixar cabeçalho vazio.

[Parágrafo 1 — os números do período: quantas edições diárias saíram, quantos
digests mensais, quantos artigos especiais. Números vêm do relatório da Etapa 1
(`_internal/01-collect-report.json`) e da contagem de `data/monthly/` e
`data/artigo-especial/` — nunca estimados.]

[Parágrafo 2 — marcos editoriais: as seções que nasceram, o que mudou de
plataforma, os canais que abriram.]

---

**TEMA 1 | [NOME DO TEMA]**

[Título narrativo do tema — máx. 60 chars]

[Parágrafo 1 — abre pelo momento em que o assunto entrou no período; cada fato
com link ancorado na frase: "o [modelo identificou 27 mil falhas](https://fonte.com/artigo)"]

[Parágrafo 2 — o desenvolvimento ao longo dos meses, na ordem em que aconteceu.
É isto que distingue a anual da mensal: o tema tem uma linha do tempo, e ela
aparece no texto ("em novembro…", "quatro meses depois…").]

[Parágrafo 3 — atores, números, o que ficou estabelecido; cada dado ancorado.]

[Parágrafo 4 — onde o assunto estava no fim da janela.]

O fio condutor:
[1 parágrafo — o que este tema revelou sobre o período. Sem URLs inline.]

---

**TEMA 2 | [NOME DO TEMA]**

[mesmo formato]

---

[... até TEMA N, com N entre 3 e 7 ...]

---

**O QUE MUDOU**

[4-6 parágrafos curtos contrastando os dois extremos da janela: o que era
assunto no começo e não é mais, o que não existia e virou rotina, que suposição
do início o fim desmentiu. Cada contraste ancorado numa edição real dos dois
extremos.]

---

**PREVISÕES**

Estas previsões saem da leitura do próprio período — do que a diar.ia.br
publicou entre {janela}. Não são consenso de mercado nem projeção de terceiros;
são a extrapolação de tendências que apareceram aqui, e podem errar.

[O parágrafo acima é obrigatório e abre a seção. Ele é o que marca o bloco como
opinativo — o fact-check da Etapa 4 não verifica esta seção, justamente porque
ela não tem fonte externa a verificar. O horizonte das previsões é sempre "os
próximos meses" — nunca "o próximo ano" nem um número de meses comprometido
(#8054): a janela de retrospectiva já varia entre a rodada de aniversário e a
de janeiro, e o método é extrapolar uma tendência, não prometer um calendário.]

**[Previsão 1 — uma frase afirmativa]**

[2-3 frases: a evidência do período que sustenta, e o que se espera ver.
A evidência cita edições concretas.]

**[Previsão 2 — uma frase afirmativa]**

[...]

[3 a 5 previsões.]

---

**PARA ENCERRAR**

[2-3 frases fechando, em tom exclamativo (#8054). Na rodada de aniversário,
agradece o ano; na de janeiro, abre o ano novo. Nunca inclui um convite
genérico para "responder a este e-mail" — não é o fluxo de e-mail regular da
mensal, é a base própria da anual.]
```

## Limites de tamanho

| Bloco | Teto | Nota |
|---|---|---|
| Cada tema | 1.500 chars | Mesmo teto do D1 da mensal (decisão do editor, 12/09/2026). Era 2.000 na 1ª edição, e 3 dos 6 temas passaram de 1.500 — enxugados sem perder o arco. Conta título + parágrafos + fio condutor, sem URL. |
| O que mudou | 1.800 chars | |
| Previsões | 2.000 chars | incluindo o parágrafo de ressalva |
| Aniversário | 1.500 chars | |

Warnings do `lint-annual-draft.ts`, não bloqueios — exceto o guardrail de render (label não reconhecido, ou tema sem imagem), que bloqueia.

## Imagens

Uma imagem 2:1 por tema (`04-d{N}-2x1.jpg`), no mesmo estilo Van Gogh impasto das demais edições: sem resolução em pixels no prompt, sem Noite Estrelada. O número de imagens acompanha o N de temas — não é fixo em 3.
