# Resolução de tomadas entre o Gate 1 e o Gate 2 (#13463)

Investigação pedida pelo editor na montagem da 261118: a etapa entre a
decupagem aprovada (Gate 1) e o roteiro final (Gate 2) está lenta. O pedido
era investigar, não implementar tudo. Este documento traz o que foi medido, a
avaliação de cada alternativa da issue, a ordem recomendada e as issues-filhas
propostas. Uma alternativa pequena e sem ambiguidade (`blocks --from-plan`) saiu
implementada na mesma PR.

Complementa a #13464 (aceleração de todas as etapas da skill), que mediu a
cadeia inteira no 300 e já virou as #13504 a #13508.

## Método e limites

- Rodado no 300, sem GPU (#13505) e **sem ler o bruto**: só os arquivos de
  `data/editions/2611/{261117,261118}/_internal/video-montagem/`, em leitura
  (`transcript.json`, `silences.json`, `decupagem-plan.json`,
  `blocks.template.json`, `blocks.json` final, `retranscribe-*.json`,
  `roteiro-retranscribe.json`, `roteiro-falas.json`).
- O `blocks.json` final (com os intervalos corrigidos à mão e depois do Gate 2)
  é o gabarito de borda. Ele já passou pelas correções do editor, então mede
  "o que a etapa precisou entregar", não "o que o editor aprovaria de primeira".
- Tempo de CPU vem da #13464 (medido no 300 e no Neo em 18/11/2026). Nada aqui
  roda Whisper, OpenCV ou ffmpeg.
- A 261118 tem bruto em dois arquivos (`source.json` com `files`) e passou por
  um `transcribe` novo às 15:17 de 18/11 (os `*.defasado.*`). O molde
  comparado é o `blocks.template.defasado.json`, do mesmo transcript.
- Os scripts de medição ficaram fora do repositório (leitura de `data/`, sem
  saída versionável); as contas estão descritas em cada linha da tabela para
  serem refeitas.

## Onde o tempo vai hoje

| | 261117 | 261118 |
|---|---|---|
| Bruto | 1 arquivo, 1533 s, -29,7 LUFS | 2 arquivos, 1186 s, -10,6 LUFS (quente) |
| Segmentos / palavras do transcript | 258 / 1708 | 122 / 1064 |
| Retranscrições de janela + subjanelas `--sub` | 14 + 3 | 15 + 31 |
| Linhas "usar" na decupagem / itens no `blocks.json` final | 29 / 38 | 40 / 49 |
| Itens do molde mexidos até o final (borda > 0,3 s ou partidos) | 9 de 29 (5 partidos) | 11 de 40 (8 partidos) |
| Maior deslocamento de borda molde × final | 37,5 s | 37,9 s (H7), 19,2 s (H12), 12,9 s (gancho H1) |
| Relógio entre decupagem e `roteiro.md` (mtime dos arquivos) | ~19 min (15:07 a 15:26 UTC) | ~3 h (23:08 a 02:16 UTC, com espera do editor) |
| `fact-check-input` até `fact-check.json` | 6 min | 2 min |

Custos por chamada medidos na #13464 (300, CPU): retranscrição de 5 s = 16 s,
de 60 s = 33,7 s (quase tudo carga do modelo, que o Whisper residente da #13506
tira); `face` com 114 frames = 178 s; `transcribe` de 1533 s = 494 s de
Whisper (no Neo com GPU, 42 s).

Os três itens que mais se moveram na 261118 são exatamente os da issue (gancho
com 23 s para 9 s de frase, H7 com 48 s, H12 com 30 s): a linha "usar" do
segmento colapsado cobria todas as tomadas, e o molde herdou o intervalo
inteiro.

## Achados medidos

**M1. Rosto.** 261117: 38 itens com `framing`, `faceX` entre 0,46 e 0,51, 30 a
até 0,01 da mediana e 36 a até 0,02. 261118: 42 itens com `framing`, 39 a até
0,01 da mediana (0,485). Os 3 de fora (`faceX` 0,41 a 0,445, `eyeY` 0,436 a
0,44, contra 0,36 dos outros) são H7 (424 s), H12 (863 s) e o gancho H1 (919
s): as tomadas regravadas no fim, com o editor em outra posição. Agrupando os
itens por trecho contínuo (vão > 60 s quebra o trecho), a variação de `faceX`
dentro de um trecho chega a 0,08 na 261118. Medir uma vez por trecho erraria
justo esses três.

**M2. Tomada colapsada.** `collapsedTakeSuspects` sobre o transcript longo:
6 segmentos suspeitos na 261117, 16 na 261118 (27 suspeitas). Nos itens finais,
sobra suspeita em 1 de 20 (261117) e 4 de 49 (261118): o que ficou foi
resolvido à mão, item a item.

**M3. Borda: transcript longo × retranscrição curta.** Início do item final a
até 0,15 s do início de uma palavra: na 261118, 32 de 49 com o transcript
longo; na 261117, 7 de 20. Nos itens "difíceis" (início a mais de 0,3 s de
qualquer palavra do transcript longo: 12 linhas na 261118, 10 na 261117), a
retranscrição curta que o agente rodou põe uma palavra a até 0,3 s da borda
aprovada em 6 de 12 (261118) e 8 de 10 (261117), e a até 0,6 s em 9 de 12 na
261118. É a evidência de que a janela curta sem VAD acha a borda que o
transcript longo perde. As retranscrições ouviram mais palavras que o
transcript longo na mesma janela em 12 de 17 (261117) e 32 de 46 (261118).

**M4. Silêncios como segmentação.** As ilhas de fala do `silences.json`
(complemento dos silêncios, piso de 0,35 s):

| | 261117 | 261118 |
|---|---|---|
| Silêncios / limiar | 436 / -45 dB (relativo) | 51 / -33,4 dB (piso de ruído -39 dB) |
| Ilhas: mediana, p90, máximo | 1,1 s, 3,4 s, 9,8 s | 14,4 s, 49,3 s, 207 s |
| Início do item final a até 0,3 s de início de ilha | 10 de 20 | 4 de 49 |
| Item final dentro de 1 ilha só | 8 de 20 | 42 de 49 |

No bruto quente da 261118 o `silencedetect` quase não acha silêncio: uma ilha
de 207 s engole várias tomadas. Segmentar por esse arquivo não separa tomada.

**M5. Direção.** `directionCues` achou 0 comentário da direção nas duas
edições (gravação sem direção falada); os 214 e 113 grupos de tomadas
repetidas saem todos por "última completa".

**M6. Cache do roteiro.** O `roteiro-retranscribe.json` usa a janela exata do
item (±0,3 s) como chave. Itens finais fora da chave exata, mas dentro de uma
janela já retranscrita: 2 de 20 (261117) e 2 de 49 (261118).

**M7. `blocks --from-plan` (implementado aqui, simulado nos dados reais).** Com
o `falaId` de cada linha "usar" tirado do `reason` que a skill escreveu ("H2,
2ª tomada"), o comando monta o `blocks.json` e ele valida nas duas edições.
Comparando (fala, sequência) contra o `blocks.json` final: 261117, 37 de 37
iguais; 261118, 28 dos 29 pares do final presentes. As diferenças da 261118
são decisões do Gate 2 (H7b fora do horizontal, H13 fora do corte `guia`), o
CTA da vertical 2 gravado em outro arquivo (#13544) e 16 linhas sem id no
`reason` (artefato da simulação: com o campo `falaId` a skill marca todas).

## Alternativas

Para cada uma: viabilidade, custo, riscos e o que dá para medir no 300 sem GPU
e sem o bruto.

### 1. Transcrição única de alta resolução no `transcribe`

Rodar o Whisper em subjanelas de 4 s (passo de 2 s) sobre o bruto inteiro e
reconciliar.

- **Viabilidade:** o helper já faz subjanelas numa chamada só (`--windows`,
  #11958) e o Whisper residente (#13506) tira a carga por chamada. Falta a
  reconciliação das palavras nas janelas sobrepostas, que hoje só existe para
  achar falso começo (`findRepetitionCut`).
- **Custo:** o dobro do áudio passa pelo Whisper. Na 261117, ~1000 s de CPU a
  mais no 300 (494 s por passada), ~85 s na GPU do Neo. Código: reconciliação
  nova e um transcript paralelo para a decupagem.
- **Riscos:** janela de 4 s sem contexto alucina em silêncio e erra começo de
  frase; a reconciliação vira fonte nova de palavra duplicada ou perdida, em
  todo o bruto, para resolver um problema que aparece em 6 a 16 segmentos.
- **Medível aqui:** só o efeito nas janelas que o agente já retranscreveu (M3).
- **Veredito:** no bruto inteiro, não. A versão **dirigida** (só os segmentos
  com suspeita de colapso, M2) dá o mesmo ganho onde ele importa: até 16
  janelas de até 60 s na 261118, ≤ 300 s de CPU no pior caso e bem menos com o
  Whisper residente. É a recomendação 2.

### 2. Alinhamento forçado contra o texto do roteiro

wav2vec2/MMS-FA, aeneas ou `whisperx align` contra o `roteiro-falas.json`.

- **Viabilidade:** MMS-FA cobre português; aeneas depende de espeak e está
  parado; o WhisperX traz torch e não dá tempo a número (levantamento da
  #13199, que já o descartou como substituto).
- **Custo:** dependência pesada nova (torch, alguns GB) no venv das duas
  máquinas; sem GPU no 300, lento.
- **Riscos:** a fala gravada difere do roteiro planejado (o `roteiro.md` mostra
  planejado × gravado desde a #13207); alinhar contra o texto errado puxa a
  borda para o lugar errado. Serve para refinar a borda de uma tomada já
  achada, com o texto gravado, não para achar a tomada.
- **Medível aqui:** nada (precisa do áudio).
- **Veredito:** fora agora. Reavaliar depois da recomendação 2, se a borda das
  palavras retranscritas ainda ficar ruim.

### 3. Segmentação por energia/VAD antes do Whisper

- **Viabilidade:** com o `silences.json`, não serve no bruto quente (M4: 51
  silêncios e uma ilha de 207 s na 261118). O detector de fala do `build`
  (energia + F0) e o Silero VAD, que já vem no faster-whisper (#13199 R2),
  são candidatos melhores, mas ainda não foram medidos para separar tomada.
- **Custo:** baixo em dependência (Silero já instalado); médio em código
  (transcrever por ilha muda o `transcribe`).
- **Riscos:** tomada regravada colada, sem pausa, continua numa ilha só;
  transcrição por ilha perde contexto.
- **Medível aqui:** só a parte do `silences.json` (M4). O Silero precisa do
  `audio.wav` (o `video-medicoes.ts vad` da #13369 já roda no 300 com ele).
- **Veredito:** não como segmentação do bruto inteiro. Usar o Silero, se
  medir bem, como critério de onde partir a janela na recomendação 2.

### 4. A direção como marcador

- **Medido:** 0 comentário da direção nas duas edições (M5).
- **Veredito:** sem ganho enquanto a gravação não tiver direção falada. A
  detecção já existe (`directionCues`) e continua valendo quando houver.

### 5. `blocks.json` gerado sem passo manual: implementado nesta PR

`npx tsx scripts/video-montagem.ts blocks {AAMMDD} --from-plan [--force]`.

- A linha "usar" do `decupagem-plan.json` ganha o campo opcional `falaId` (o id
  da fala no `roteiro-falas.json`), que a decupagem leva ao
  `blocks.template.json`.
- O comando junta o molde (intervalo e texto gravado) com a proposta do
  `video-roteiro-blocos.ts` (bloco, ordem, `targets`, `falaId`, `sequences`,
  `screenTitle`), tira da ordem de cada sequência o bloco sem item (o
  `fecho`/`cta_yt` vazios que a skill tirava à mão nas duas edições) e valida o
  resultado inteiro antes de gravar.
- Avisa e segue: fala do roteiro sem linha com o id (sai com o texto, tomada
  pela última completa), trecho de corte de vertical (#13129, sai com o texto),
  item do molde sem id (fica no bloco, sem `targets`).
- Nunca sobrescreve um `blocks.json` sem `--force`; com ele, guarda o anterior
  em `blocks.antes-from-plan.json`. Sem roteiro de gravação, exit 3.
- Resultado nos dados reais: M7.
- Lógica em `scripts/lib/diaria/video-blocks-from-plan.ts`, teste em
  `test/video-blocks-from-plan-13463.test.ts`.

### 6. `face` mais barato

- **Por trecho contínuo:** descartado pela medição (M1). Os itens que mudam de
  posição são justamente as tomadas regravadas.
- **1 frame por item:** 3 vezes menos decode (178 s viram ~60 s de CPU no 300
  para a 261117, antes do proxy e do lote das #13507/#13508). Risco: piscada
  ou cabeça virada no frame único; com fallback para 25/75% quando o do meio
  não acha rosto, o risco cai para os itens difíceis.
- **Incremental:** hoje o `face --write` mede TODOS os itens e só grava nos
  sem `framing`. Cada volta depois de trocar uma tomada repete as ~40 medições.
  Medir só os itens sem `framing` ou com intervalo diferente do da última
  medição corta a segunda volta para os itens trocados (5 na 261118).
- **Medível aqui:** a variação entre itens (M1). A troca de 3 por 1 frame
  precisa do bruto ou do proxy; o `face-compare` (#13370) já compara contra o
  `framing` aprovado.
- **Veredito:** recomendação 3, incremental primeiro (sem risco), depois 1
  frame com fallback.

### 7. Fact-check em paralelo

- **Viabilidade:** o `fact-checker` (`mode: "video"`) lê o texto das falas; o
  da decupagem aprovada já existe depois do Gate 1. Disparar ali, em paralelo
  com `face`/`roteiro`, e no Gate 2 conferir só o que mudou (o
  `fact-check-input.json` já tem hash dos itens).
- **Custo:** 2 a 6 min de relógio a menos por edição. Mudança quase toda na
  `SKILL.md` (escrita em `.claude/`, trilha Develop pelo item 34 das regras de
  dispatch) e um modo "só o diff" no `fact-check-input`.
- **Riscos:** a fala muda entre Gate 1 e Gate 2 (corte de repetição, tomada
  trocada); sem o diff, o fact-check sairia defasado sem aviso.
- **Medível aqui:** os tempos (tabela acima).
- **Veredito:** recomendação 4.

### 8. Cache entre voltas para intervalo que encolheu

- **Medido:** 2 de 20 e 2 de 49 itens finais caberiam numa janela já
  retranscrita (M6). Com o Whisper residente (#13506), cada janela custa
  segundos.
- **Veredito:** ganho pequeno; não propor agora.

### 9. Fechar a lacuna na origem (claquete, bip, atalho no celular)

- **Viabilidade:** sem código para começar: o editor bate palma (ou fala uma
  palavra fixa) entre tomadas. A detecção depois é simples (pico de energia
  isolado, ou a palavra no transcript).
- **Riscos:** depende de hábito na gravação e muda a rotina do editor; palma
  colada na fala vai para o áudio do clipe se a borda errar.
- **Medível aqui:** nada.
- **Veredito:** é decisão do editor (processo de gravação). Testar em 2 ou 3
  gravações antes de qualquer código.

## Recomendação, em ordem

1. **`blocks --from-plan`** (feito nesta PR). Tira o script ad-hoc e a volta de
   agente que ele custava; o editor revisa o diff do `blocks.json`.
2. **Retranscrição dirigida dos segmentos com tomada colapsada já na
   decupagem** (issue-filha A). Ataca o item 4 da issue, a maior perda de
   tempo e a origem dos deslocamentos de 13 a 38 s.
3. **`face` incremental, depois 1 frame com fallback** (issue-filha B).
4. **Fact-check da fala logo depois do Gate 1, em paralelo, com conferência
   só do diff no Gate 2** (proposta, trilha Develop por mexer na `SKILL.md`).
5. **Medir o Silero VAD como separador de tomada** (proposta de medição,
   estende o `video-medicoes.ts vad` da #13369), antes de qualquer
   segmentação por VAD.
6. **Claquete ou palavra-marcador na gravação** (decisão do editor, sem
   código).

Descartadas por ora: transcrição inteira em subjanelas (o dobro do Whisper para
um problema localizado), alinhamento forçado (dependência pesada e texto
planejado diferente do gravado), direção como marcador (0 comentário nas duas
edições), cache de intervalo encolhido (2 itens por edição).

## Issues-filhas propostas

Não abertas: a decisão é do editor.

### A. video-montagem: resolver tomada colapsada na 1ª passada da decupagem, com retranscrição dirigida (P2)

- **Escopo:** na 1ª passada do `decupagem`, para cada segmento com
  `collapsedTakeSuspects`, retranscrever a janela da suspeita (a mesma do
  `[aviso]` de hoje) numa chamada só do Whisper residente, e o `--sub` onde a
  janela inteira achar uma tomada só. A listagem numerada sai com as tomadas
  separadas (segmentos da retranscrição marcados como tal) e a 2ª passada grava
  no `blocks.template.json` o intervalo da tomada escolhida, com a borda da
  palavra retranscrita, em vez do segmento colapsado inteiro.
- **Aceite:** com o transcript e as retranscrições da 261118 como fixture, o
  molde de H7, H12 e do gancho H1 sai com o início a até 0,6 s do aprovado
  (hoje, 12,9 a 37,9 s). Tempo de CPU da 1ª passada medido no 300 e no Neo.
- **Prioridade:** P2. É a etapa que mais custa (item 4 da issue) e roda todo
  dia útil; tem workaround (o fluxo atual).

### B. video-montagem: `face` incremental e com 1 frame por item (P3)

- **Escopo:** guardar por item o intervalo medido (`face-cache.json` no state
  dir, chave = hash do intervalo) e medir só item novo, sem `framing` ou com
  intervalo diferente; `--all` mede tudo. Depois, 1 frame no meio do item, com
  25/75% só quando o do meio não achar rosto.
- **Aceite:** depois de trocar 5 tomadas, o `face --write` mede 5 itens, não
  40; o `face-compare` (#13370) da 261117 e da 261118 com 1 frame não piora o
  acerto contra o `framing` aprovado.
- **Prioridade:** P3. O proxy e o lote (#13507/#13508) já baixaram o custo; o
  ganho maior é a segunda volta.

### Outras propostas (só título, para o editor decidir se viram issue)

- video-montagem: fact-check da fala depois do Gate 1, em paralelo, com só o
  diff no Gate 2 (P3, `claude-dir`: mexe na `SKILL.md`).
- video-montagem: medir o Silero VAD como separador de tomada nas 261117/261118
  (P3, estende o `video-medicoes.ts vad`).
- video-montagem: teste de claquete ou palavra-marcador entre tomadas na
  gravação (P3, decisão do editor).
- video-roteiro: trecho que sobra de um corte (#13129) começa com a pontuação
  do trecho cortado (". Duas já aconteceram…" na proposta da 261118) (P3,
  achado desta medição: o texto do item da vertical sai com o ponto solto).
