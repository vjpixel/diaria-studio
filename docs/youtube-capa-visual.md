# Capa do vídeo: benchmark visual em canais de IA (#13217)

Complementa `docs/youtube-capa-texto.md`, que trata só do texto da capa. Aqui
fica o visual: rosto, tamanho e fonte do texto, fundo, logo, elemento de
alerta. O objetivo é dar à #13192 (taxa de cliques dos horizontais em 2,2%)
um repertório de capas para testar. **Nada aqui muda o padrão do pipeline**
(261021, #11942); isso só acontece se um teste da #13192 mostrar ganho.

Coleta reproduzível: `npx tsx scripts/youtube-capa-benchmark.ts` (só leitura
da YouTube Data API oficial, até 7 unidades de cota por canal, ~84 no total).
Grava o JSON e, dos canais ok, as miniaturas dos dois grupos e uma folha de
contato em `data/youtube-capa-benchmark/{data UTC}/`.

## Método

- **12 canais** de notícia e análise de IA, 7 em inglês (AI Explained, Matt
  Wolfe, Wes Roth, TheAIGRID, Matthew Berman, Two Minute Papers, Fireship) e
  5 em PT-BR (Filipe Deschamps, Código Fonte TV, Lucas Montano, Sandeco,
  Olhar Digital), de 87 mil a 4,3 milhões de inscritos. Critério de escolha
  em `BENCHMARK_CHANNELS` (`scripts/lib/diaria/youtube-capa-benchmark.ts`).
  TecMundo e Asimov Academy foram descartados na 1ª rodada (motivo no código).
- Por canal: até 30 vídeos longos mais recentes (acima de 3 min, com 7+ dias;
  canal com menos de 10 fica de fora). Na rodada de 16/11 todos tiveram 30.
- **Acima da média** (rótulo; o cálculo é sobre a mediana) = views ≥ 2x a
  mediana da amostra do canal. **Típico** = os 3 mais perto da mediana. A taxa
  de cliques de outro canal não é pública; comparar com a mediana do próprio
  canal normaliza o tamanho dele (não a pauta).
- Rodada de 16/11/2026: 12 canais, 360 vídeos, 66 acima da média.

**Ressalva que vale para tudo abaixo:** views acima da média medem pauta,
título e capa juntos (#13195). Dentro de um mesmo canal o estilo da capa quase
não muda; o que separa o vídeo acima da média do típico é, na maioria dos
casos, a pauta (lançamento grande, declaração alarmante). O benchmark mostra o
que todos esses canais fazem e o que a nossa capa não faz. Se isso converte
mais, só o teste da #13192 diz.

## O que se repete nos 12 canais

1. **Texto enorme, curto e em fonte pesada.** 1 a 3 palavras, sem serifa,
   condensada, quase sempre em caixa alta, ocupando de 30% a 50% da altura.
   Uma palavra ganha destaque com tarja de cor (vermelha ou amarela) ou cor
   diferente: "Your **ALL** Wrong!", "Biggest **LEAP** Yet", "IA VIROU RISCO".
   Nenhuma das 44 capas acima da média examinadas (até 4 por canal) usa fonte
   serifada.
2. **Quem é o assunto, reconhecível a 240 px.** Logo grande do protagonista
   (OpenAI, Google, Nvidia, a baleia da DeepSeek) ou foto do personagem da
   notícia (Sam Altman, Yann LeCun, Jensen Huang). O leitor sabe sobre quem é
   o vídeo antes de ler o título.
3. **Rosto em close com expressão forte.** Nos canais com apresentador, o
   rosto ocupa de 40% a 60% da altura, com olhos arregalados, mão na cabeça,
   sobrancelha erguida. Plano médio (do peito para cima com sobra de cenário)
   aparece pouco, e nunca entre os maiores ratios.
4. **Fundo escuro e limpo, com um objeto em destaque.** Preto ou azul-escuro,
   um único elemento com brilho ou cor saturada. O contraste entre texto,
   rosto e fundo é alto.
5. **Citação entre aspas como gancho** (TheAIGRID, Filipe Deschamps):
   personagem da notícia + frase dele entre aspas, com a palavra-chave em
   tarja. "We CAN'T Fix This" (4,0x), "Pessoas vão se queimar..." (4,1x).
6. **Sinal de alerta explícito** nas pautas de risco: placa de perigo,
   palavra ALERTA. "ALERTA" do Filipe Deschamps (7,2x, a mais alta do canal
   junto com outra) e "Alerta sobre IA!" do Olhar Digital (5,9x).
7. **Rosto não é obrigatório.** Two Minute Papers e Olhar Digital vão bem sem
   apresentador: texto enorme + logo ou imagem forte do assunto.

## Onde a nossa capa difere

Comparando as 13 capas horizontais publicadas (snapshot de 15/11/2026):

| Ponto | Canais de IA | diar.ia.br |
|---|---|---|
| Fonte do texto | sem serifa, pesada, caixa alta | Georgia serifada, caixa mista |
| Tamanho do texto | 30% a 50% da altura | ~10% a 20% da altura |
| Destaque | tarja de cor numa palavra | só o "?" em teal |
| Fundo | escuro, liso, 1 objeto com brilho | pintura Van Gogh com textura e várias figuras |
| Protagonista | logo ou rosto do personagem | ausente: a cena é ilustração genérica |
| Rosto do apresentador | close, expressão forte | close só em parte das capas; várias em plano médio |
| Alerta | placa/ícone de perigo | nunca |

O fundo pintado é a identidade da marca (regra da imagem de destaque), mas na
miniatura do celular a textura vira ruído e a cena não diz sobre quem é o
vídeo. As duas capas com mais views (IA brasileira, 208; IA ladra, 148) são
também as de pauta mais forte; "IA ladra" é a única com rosto grande e texto
grande ao mesmo tempo.

## Capas para testar na #13192

Cada variação muda **uma coisa** em relação à capa atual, para que o
resultado diga o que funcionou. O "Testar e comparar" do Studio aceita até 3
capas por vídeo: atual + 2 variações.

| # | Variação | O que muda | Referência no benchmark | Melhor para |
|---|---|---|---|---|
| A | **Texto grande** | Mesmo retrato e fundo; texto vira 1 a 3 palavras sem serifa (Geist Black ou similar), caixa alta, ~40% da altura, palavra-chave em tarja teal #00A0A0 | Wes Roth, Matt Wolfe, Código Fonte TV | qualquer pauta; é a mudança mais barata |
| B | **Logo do protagonista** | Cena pintada sai; entra o logo/produto do assunto (Claude, Mistral, Nvidia) grande, com brilho, em fundo escuro liso; retrato e texto ficam | Two Minute Papers, Matt Wolfe | lançamento e empresa conhecida |
| C | **Close + fundo limpo** | Retrato vira close (rosto em ~50% da altura) com expressão forte; fundo escurecido e simplificado, um único objeto da cena | Lucas Montano, Wes Roth | pautas de opinião e reação |
| D | **Alerta** | Acrescenta placa de perigo ou a palavra ALERTA em tarja vermelha | Filipe Deschamps, Olhar Digital | golpe, vazamento, segurança |
| E | **Personagem + citação** | Rosto do personagem da notícia com a frase dele entre aspas | TheAIGRID, Filipe Deschamps | declarações (CEO, governo) |

**Sobre a E:** foto de imprensa tem direito autoral e um retrato gerado por IA
de pessoa real é deepfake, o que a marca não deveria publicar. Só entra no
teste com foto de licença livre (Wikimedia Commons, por exemplo) ou foto
oficial de divulgação, e decisão do editor.

Sugestão de pareamento com os vídeos da #13192 (taxa de cliques entre
parênteses):

- **Claude Code pode ter vazado suas senhas no GitHub:** A e D.
- **Só o Claude Opus 5.5 supera a IA aberta da Mistral (0,8%):** A e B.
- **Nvidia: CEO admite caso com suposta espiã (0,6%):** A e C (ou E, com foto
  liberada).
- **Lula promete uma IA brasileira** e **Você já viu IA mentir:** A sozinho,
  porque já são as capas que mais rendem; serve para medir se texto grande
  ainda soma quando a pauta já é forte.

A variação A aparece em todos os vídeos de propósito: se ela ganhar de forma
consistente, é a mudança de padrão mais simples de adotar, porque não mexe no
retrato nem no fundo. Mexe no gancho em `scripts/lib/diaria/youtube-thumb.ts`:
hoje ele é Georgia (`FONTS.serif`, com guard de fonte da marca), de 2 a 4
palavras (`HOOK_MIN_WORDS`/`HOOK_MAX_WORDS`) e de 64 a 130 px
(`HOOK_MIN_FONT`/`HOOK_MAX_FONT`, até ~18% da altura). Para o teste, as capas
A podem ser montadas à parte, sem mudar esse módulo.

As capas são geradas como hoje (`gen-youtube-thumb.ts`) e trocadas com
`publish-youtube.ts --thumbnail-only` (#12134) quando o teste for antes e
depois em vez do "Testar e comparar".

## Refazer o levantamento

Rodar de novo o script daqui a alguns meses e comparar. Os canais estão no
código, então a lista muda por PR, com o motivo registrado.
