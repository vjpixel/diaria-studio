# Texto da capa do vídeo: benchmark e diretriz (#12737)

Vale para o gancho das duas capas do vídeo "diar.ia.br comentada": a horizontal
(`04-youtube-thumb.jpg`, Passo A2 do `/diaria-publica`) e a do Short
(`04-youtube-short-capa.jpg`, #12462). Layout, retrato e fundo ficam fora daqui
(padrão da 261021, #11942: close-up do editor à esquerda, gancho embaixo à
direita).

Ferramenta: `npx tsx scripts/suggest-capa-hooks.ts {AAMMDD} --candidates-file F`
pontua os candidatos contra esta diretriz e imprime o `--hook` pronto de cada
formato (detalhes no fim).

## Por que mudou

O Passo A2 dizia "2 a 4 palavras derivadas do D1, pergunta ou tensão". Na
prática saíam sempre duas palavras e uma interrogação ("IA ladra?", "IA
europeia?", "IA demitiu?"). Em 261111 o editor recusou "IA demitiu?" e aprovou
"Ensinaram a IA e foram demitidos" (6 palavras, 2 linhas). Ele também disse que
não acredita que o formato de duas palavras funcione bem. O "texto já definido"
que ele citou naquele dia foi engano: não existe texto de capa predefinido
(decisão de 10/11/2026 na issue).

## O que o canal mostra (levantamento de 10/11/2026)

Visualizações por gancho publicado, com 54 inscritos e 25 vídeos:

| Gancho | Views |
|---|---|
| IA brasileira? | 201 |
| IA ladra? | 152 |
| Golpe da selfie | 39 |
| IA europeia? | 33 |
| Confiou no chatbot e morreu | 21 |
| R$ 1 milhão por dia | 13 |
| Caso com espiã? | 9 |

Os dois mais vistos têm 2 palavras e pergunta, mas o terceiro com a mesma forma
("IA europeia?") teve 33. A amostra não separa o efeito do texto do efeito do
tema nem do dia; nada aqui é conclusão estatística. Daqui pra frente o gancho
escolhido fica registrado por edição (`--record`) e o `--history` cruza com as
views de `data/youtube-analytics/videos.jsonl`, para o próximo levantamento
não depender de memória.

## Benchmark externo

O que as fontes dizem, com a ressalva de que quase todas são blogs de marketing
e fornecedores de ferramenta, não dados do YouTube:

- **Tamanho.** As faixas vão de 2 a 5 e de 3 a 6 palavras; a mais citada é 3 a
  5. Um levantamento de 93 mil vídeos (FlowHunt, empresa de marketing) diz que
  os grandes criadores usam 1 a 3 palavras, a maioria 2. A miniatura é vista
  com ~240x135 px no celular: texto curto e grande ganha de texto longo e
  pequeno.
- **Complementar o título, nunca repetir.** É o erro mais citado. O texto deve
  acrescentar informação, consequência ou contraste que o título não traz.
- **Lacuna de curiosidade.** O texto aponta para algo que o título deixa em
  aberto. Promessa que o vídeo não cumpre derruba o tempo de exibição, e o
  "Test & compare" do YouTube escolhe a capa vencedora por participação no
  tempo de exibição, não por clique (documentação do YouTube).
- **Pergunta × afirmação, número, nome próprio.** Nenhuma fonte comparou essas
  formas com dados. Canais de tecnologia usam pouco texto; quando usam, é nome
  do produto mais uma palavra de impacto. Número entra quando ele é o fato.
- **Testar.** O "Test & compare" aceita até 3 capas por vídeo (não vale para
  Shorts). É o único caminho para dado próprio sobre o texto.

Fontes:
[YouTube, Test & compare thumbnails](https://support.google.com/youtube/answer/13861714) ·
[YouTube, A/B test titles & thumbnails](https://support.google.com/youtube/answer/16391400) ·
[vidIQ](https://vidiq.com/blog/post/youtube-thumbnail-design-tips/) ·
[Snappa](https://snappa.com/blog/youtube-thumbnail-best-practices/) ·
[thumbnailtest.com](https://thumbnailtest.com/?p=780) ·
[Miraflow](https://miraflow.ai/blog/how-many-words-youtube-thumbnail-2026) ·
[FlowHunt (93 mil vídeos)](https://www.flowhunt.io/pt/blog/how-to-crack-the-youtube-algorithm-data-driven-insights/) ·
[Neil Patel BR](https://neilpatel.com/br/blog/thumbnails/) ·
[Buffer](https://buffer.com/library/youtube-thumbnails/) ·
[Vidpros (MrBeast)](https://vidpros.com/creating-thumbnails-like-mrbeast-tips-and-techniques/).

## Diretriz

1. **Complementa o título.** O título do vídeo (o D1) diz o fato; a capa diz a
   consequência, o contraste ou a pergunta que ele provoca. Trecho literal do
   título é proibido; repetir a maior parte das palavras dele também.
2. **Tamanho: 2 a 6 palavras, alvo 3 a 6.** Moeda + número contam como uma
   palavra ("R$ 1 milhão por dia" = 4). No horizontal, mais de 4 palavras vão em
   2 linhas (`|`, até 4 por linha, #11740). No Short o teto é 5 (#12462). Até
   ~34 caracteres, para ler no celular.
3. **Variar a forma.** Pergunta curta e afirmação concreta são as duas formas
   válidas, e a lista proposta ao editor traz as duas. "IA {palavra}?" de duas
   palavras não é mais o default: só entra se ganhar das alternativas.
4. **Concreto e do cotidiano.** Verbo forte e palavras que o leitor usa
   ("demitidos", "vigia", "golpe", "selfie"). Sem jargão (LLM, agêntico,
   modelo, benchmark, token), sem sigla que o público não lê de relance, sem
   inglês além de nome de marca.
5. **Número, quando ele é o fato.** Algarismos e unidade curta ("40 demitidos",
   "R$ 1 milhão por dia"), sempre um número que está no D1.
6. **Nome próprio, só se reconhecível.** Google, ChatGPT, Meta, Nubank
   funcionam; pesquisador ou startup pequena não. "IA" como sujeito genérico
   serve quando a empresa não ajuda.
7. **Falar com o espectador ajuda** quando cabe ("Google Photos te vigia?").
8. **O vídeo sustenta a promessa.** O gancho tem de ser verdade na fala; capa
   que promete o que o vídeo não entrega perde no tempo de exibição.
9. **Sem seta, emoji, caixa-alta inteira ou reticências.** A capa usa Georgia
   em caixa normal, com o `?` em teal.
10. **O gancho decide a expressão do retrato** (Passo A2, item 3).

## Ferramenta

```bash
# 1. o agente escreve 8 a 10 candidatos pela diretriz, um por linha
#    (pelo menos 3 perguntas e 3 afirmações; linha com # é comentário)
npx tsx scripts/suggest-capa-hooks.ts {AAMMDD} --candidates-file /tmp/capa-{AAMMDD}-$RANDOM.txt
# 2. depois de o editor escolher
npx tsx scripts/suggest-capa-hooks.ts {AAMMDD} --record "Ensinaram a IA|e foram demitidos" --format horizontal
npx tsx scripts/suggest-capa-hooks.ts {AAMMDD} --record "Treinou o|próprio substituto?" --format short
# histórico: gancho × views
npx tsx scripts/suggest-capa-hooks.ts --history
```

O script lê o D1 do `02-reviewed.md`, junta sementes mecânicas (número saliente
do D1, nome reconhecível do título), pontua cada candidato de 0 a 100 e
classifica o potencial (alto, médio, baixo). O topo 3 sempre traz uma pergunta e
uma afirmação quando as duas existem. Para cada candidato imprime o `--hook`
pronto para `gen-youtube-thumb.ts` (horizontal e `--short-cover`) ou o motivo de
não caber. A pontuação é heurística sobre esta diretriz, não previsão de
clique: ela ordena a lista, e quem escolhe é o editor. `--json` devolve a lista
estruturada.
