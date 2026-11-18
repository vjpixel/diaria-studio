# Texto da capa: benchmark em canais de IA (#13253)

Complementa `docs/youtube-capa-texto.md` (diretriz do texto, #12737) e
`docs/youtube-capa-visual.md` (benchmark visual, #13217). Aqui o objeto é só o
**texto** escrito na capa: que modelos de texto se repetem nas capas que
renderam acima da média do próprio canal, e se isso apoia a hipótese do editor
na 261116 de que precisamos de um texto mais óbvio. **Nada aqui muda a
diretriz nem o `suggest-capa-hooks.ts`**: a proposta do fim fica para decisão
do editor.

## Método

- **Coleta:** `npx tsx scripts/youtube-capa-benchmark.ts` (a mesma do
  benchmark visual: 12 canais, YouTube Data API oficial, só leitura), rodada em
  17/11/2026. 360 vídeos longos, **65 capas acima da média** (views ≥ 2x a
  mediana do canal) e **36 típicas** (as 3 mais perto da mediana de cada canal).
- **Transcrição:** o texto de cada uma das 101 capas foi lido na miniatura e
  gravado em `docs/measurements/youtube-capa-texto-benchmark-2026-11-17.json`,
  com o modelo, se o texto diz o assunto sozinho e o que a imagem mostra (logo,
  personagem da notícia). Modelo e "diz o assunto" são julgamento de quem
  transcreveu; o resto é calculado.
- **Tabelas:** `npx tsx scripts/youtube-capa-texto-benchmark.ts` imprime as
  tabelas abaixo a partir do arquivo de medição (`--json` para o dado
  estruturado). A lógica fica em `scripts/lib/diaria/youtube-capa-texto-benchmark.ts`.
- **Modelos:**
  - `protagonista`: nomeia empresa, produto ou pessoa, com ou sem o fato
    ("GOOGLE IS BACK.", "GPT-6", "MUSK QUER FAZER HISTÓRIA!");
  - `assunto-literal`: diz o assunto sem nome próprio ("ATAQUES HACKERS COM
    IA", "SATÉLITE BRASILEIRO", "CEO SAIU");
  - `pergunta`;
  - `citacao`: frase entre aspas, quase sempre com o rosto de quem falou;
  - `alerta`: "ALERTA", "CRITICAL";
  - `numero`: o número é o gancho;
  - `veredito`: juízo sem o assunto ("BIGGEST LEAP YET.", "FLAWLESS");
  - `enigma`: lacuna que só fecha com o título ou a imagem ("WHAT THEY SAW",
    "IT FOUND IT", "ACONTECEU...");
  - `rotulo`: o formato do vídeo ("AI NEWS", "AULA COMPLETA");
  - `sem-texto`.
- **Repete ou complementa o título:** pelas palavras de conteúdo da capa que
  aparecem no título. Nenhuma em comum = complementa; metade ou mais = repete.

**Ressalva que vale para tudo abaixo (#13195):** views acima da mediana somam
pauta, título e capa. 65 capas em 12 canais, com 3 típicas por canal, é amostra
pequena: as diferenças abaixo são de poucos pontos e não passam em nenhum
teste estatístico. Servem para apontar o que se repete e o que testar. No
Olhar Digital, 5 das 9 capas acima da média são de pauta espacial (Starship,
minilua, satélite, sondas, New Glenn), não de IA; ficam na conta porque o
canal entrou no benchmark visual com a mesma regra.

## Resultado

| Modelo | Acima da média | Típicas |
|---|---:|---:|
| protagonista | 25 (38%) | 10 (28%) |
| assunto-literal | 9 (14%) | 6 (17%) |
| pergunta | 7 (11%) | 5 (14%) |
| citacao | 6 (9%) | 3 (8%) |
| alerta | 2 (3%) | 1 (3%) |
| numero | 0 | 1 (3%) |
| veredito | 4 (6%) | 2 (6%) |
| enigma | 8 (12%) | 4 (11%) |
| rotulo | 2 (3%) | 3 (8%) |
| sem-texto | 2 (3%) | 1 (3%) |

| Atributo | Acima da média | Típicas |
|---|---:|---:|
| Texto diz o assunto sozinho | 65% | 56% |
| Texto nomeia empresa, produto ou pessoa | 42% | 33% |
| Assunto identificável pelo texto ou pela imagem | 89% | 86% |
| Repete o título | 45% | 39% |
| Repete em parte | 11% | 11% |
| Complementa (nenhuma palavra do título) | 42% | 47% |
| Palavras (mediana) | 3 | 3 |

Dentro de cada canal (fração nas capas acima da média menos a fração nas
típicas do mesmo canal, média dos 12 canais):

| Atributo | Diferença média | Canais a favor | Canais contra |
|---|---:|---:|---:|
| protagonista | +7 pontos | 8 | 3 |
| texto diz o assunto | +6 pontos | 7 | 3 |
| repete o título | +6 pontos | 6 | 4 |
| nomeia empresa, produto ou pessoa | +5 pontos | 6 | 5 |
| enigma | +4 pontos | 5 | 2 |
| veredito | +4 pontos | 2 | 1 |
| citacao | 0 | 2 | 2 |
| assunto-literal | -1 ponto | 2 | 4 |
| complementa o título | -3 pontos | 6 | 5 |
| pergunta | -6 pontos | 2 | 4 |

Por língua: nos 5 canais em português o texto diz o assunto em 74% das capas
acima da média (67% nas típicas) e nomeia o protagonista em 42% (27%). Nos 7
em inglês a diferença quase some (52% contra 48%; 41% contra 38%): ali o
enigma e o veredito ("ALIEN MATH", "FLAWLESS") aparecem mais, em canais cujo
rosto e marca o público já conhece.

### Os modelos que se repetem nas capas bem-sucedidas

1. **Protagonista + fato ou veredito curto.** É o modelo mais comum acima da
   média (38%) e o que mais sobe dentro do canal (8 de 12 canais). Quatro das
   cinco capas de maior ratio são assim: "MUSK QUER FAZER HISTÓRIA!" (9,2x),
   "ANTHROPIC FABLE 5.2 BREAKTHROUGH" (8,7x), "GPT-6" (8,0x), "SPACEXAI
   INTRODUCING GROK 5" (7,9x); a quinta é "ATAQUES HACKERS COM IA" (8,4x),
   assunto literal. O "GOOGLE IS BACK." do Matt Wolfe (2,0x) e o "GEMINI 4 DE
   GRAÇA" da nossa 261116 são este modelo.
2. **O texto repete o nome do título.** Quase metade das capas acima da média
   tem metade ou mais das palavras de conteúdo no título, e na maioria dessas
   o que se repete é o nome do protagonista ("OPENAI BREAKTHROUGH" com o
   título "OpenAI's New AI Is Doing Things We Barely Understand"). A frase do
   título inteira quase nunca vai para a capa; vai o nome e mais uma ou duas
   palavras que o título não diz.
3. **Citação com o rosto de quem falou** (TheAIGRID, Filipe Deschamps,
   Código Fonte TV) aparece igual nos dois grupos: funciona como formato do
   canal, não como diferencial.
4. **Alerta** é raro (3 capas), mas uma delas é a maior do Filipe Deschamps
   ("ALERTA", 7,2x, pauta de golpe no Gmail).
5. **Pergunta** é o modelo que mais cai acima da média (-6 pontos, 2 canais a
   favor e 4 contra). Quando funciona, a pergunta diz o assunto ("SEGUNDA
   LUA?", 4,8x; "COMO QUE GOLPISTAS SABEM QUEM SÃO SEUS PARENTES???", 3,7x).
6. **Enigma** não separa os grupos (12% contra 11%). Aparece entre os maiores
   ratios ("ALIEN MATH", 5,8x; "ACONTECEU...", 4,8x), sempre em canal grande,
   com rosto conhecido e pauta que o título já entrega.

Dentro do grupo acima da média, o texto que diz o assunto não rende mais que
o que não diz (ratio mediano 2,9x contra 3,2x): o sinal é de frequência (quem
rende mais costuma dizer o assunto), não de intensidade.

## Nosso canal (#12737, `--history`)

O `suggest-capa-hooks.ts --history` ainda só tem o gancho da 261116 registrado
(sem views na data). As 13 capas horizontais anteriores foram lidas das cópias
locais (`04-youtube-thumb.jpg`; a publicada pode ter sido trocada depois) e
cruzadas com as views do snapshot de 17/11/2026 (`data/youtube-analytics/videos.jsonl`):

| Capa | Views | Modelo | Diz o assunto |
|---|---:|---|---|
| IA brasileira? | 209 | pergunta | sim |
| IA ladra? | 148 | pergunta | sim |
| Senha vazada? | 136 | pergunta | sim |
| Internet em risco? | 70 | pergunta | sim |
| Ensinaram a IA e foram demitidos | 69 | assunto-literal | sim |
| Golpe da selfie | 63 | assunto-literal | sim |
| IA europeia? | 38 | pergunta | não |
| GPT-6.1 Terra | 35 | protagonista | sim |
| IA antiveneno? | 27 | pergunta | sim |
| Confiou no chatbot e morreu | 23 | assunto-literal | sim |
| R$ 1 milhão por dia | 21 | numero | não |
| Caso com espiã? | 19 | pergunta | não |
| Google Photos te vigia? | 9 | pergunta | sim |

As 10 capas que dizem o assunto têm mediana de 66 views; as 3 que não dizem
("IA europeia?", "R$ 1 milhão por dia", "Caso com espiã?"), 21. Vai na direção
da hipótese do editor, com 13 vídeos e a pauta misturada. Duas correções ao
texto da issue: "Ensinaram a IA e foram demitidos" está hoje com 69 views (não
entre 18 e 29) e diz o assunto; quem fica embaixo são as capas sem sujeito
("Caso com espiã?" sem a Nvidia, "IA europeia?" sem a Mistral nem o Claude).
As duas capas que nomeiam empresa ("GPT-6.1 Terra", "Google Photos te vigia?")
ficaram com 35 e 9 views: nome sozinho não salvou pauta fraca.

O contraste com o benchmark: 8 das 13 capas são pergunta, o modelo que menos
rende nos 12 canais; só uma (GPT-6.1 Terra) é protagonista, o que mais rende.

## Proposta de revisão da diretriz (para decisão do editor)

O benchmark não sustenta a regra "complementar o título, nunca repetir" na
forma atual, e sustenta, com amostra pequena, a hipótese do texto óbvio.
Propostas, item por item da diretriz de `docs/youtube-capa-texto.md`:

1. **Item 1 (complementa o título).** Trocar por: "a capa diz de quem é a
   notícia e o que aconteceu, em poucas palavras. Pode repetir o nome do
   protagonista do título; não copia a frase do título." No
   `suggest-capa-hooks.ts`, o limite de sobreposição (`TITLE_OVERLAP_LIMIT`)
   deixaria de contar os nomes de `CAPA_KNOWN_NAMES`.
2. **Item 3 (variar a forma).** Default passa a ser afirmação com
   protagonista ou assunto literal ("GEMINI 4 DE GRAÇA", "GOLPE DA SELFIE").
   Pergunta só quando a dúvida é a notícia, e sempre com o assunto dentro
   ("IA brasileira?" sim; "Caso com espiã?" não). A lista do script deixaria
   de exigir 3 perguntas.
3. **Item 6 (nome próprio).** Mantém "só se reconhecível", mas o nome
   reconhecível ganha preferência sobre "IA" genérica quando a pauta é de uma
   empresa ou produto conhecido (no benchmark, 42% das capas acima da média
   nomeiam).
4. **Item 2 (tamanho).** A mediana do benchmark é 3 palavras nos dois grupos.
   Reduzir o alvo de 3 a 6 para 2 a 4 combina com a variação A (texto grande)
   do benchmark visual. Fica junto com a decisão do visual, porque mexe no
   `youtube-thumb.ts`.
5. **Sem mudança:** o vídeo sustenta a promessa (item 8), sem jargão (item 4),
   número só quando é o fato (item 5). Enigma e citação continuam fora do
   default: no benchmark eles dependem de rosto conhecido ou de foto do
   personagem, que a nossa capa não tem (#13217, variação E).

**Como testar antes de mudar:** nos testes da #13192, pôr ao lado da capa
atual uma capa "protagonista + fato" com o mesmo visual. Se ela ganhar em pelo
menos 2 de 3 vídeos no "Testar e comparar", a revisão acima vira regra; se
empatar, a pauta explica mais que o texto e a diretriz fica como está.

## Refazer o levantamento

1. `npx tsx scripts/youtube-capa-benchmark.ts` (grava a coleta e as miniaturas
   em `data/youtube-capa-benchmark/{data}/`).
2. `npx tsx scripts/youtube-capa-texto-benchmark.ts --benchmark
   data/youtube-capa-benchmark/{data}/benchmark.json --esqueleto
   docs/measurements/youtube-capa-texto-benchmark-{data}.json` e preencher
   texto, modelo, diz_assunto e visual lendo `thumbs/{id}.jpg`.
3. `npx tsx scripts/youtube-capa-texto-benchmark.ts --benchmark ...` confere
   que nenhuma capa da coleta ficou sem transcrição e imprime as tabelas (sem
   `--medicao`, usa a medição mais recente).
