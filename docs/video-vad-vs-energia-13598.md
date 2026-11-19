# Silero VAD contra o detector de energia (#13598, filha da #13463)

Só medição: o detector do `build` (`speechIslands` + F0, #12089) não muda.

## Como reproduzir

```
python -P scripts/video/vad_probs.py {bruto-multi-16k.wav} probs.json     # medir user+sys com `time`
npx tsx scripts/video-vad-vs-energia.ts AAMMDD --audio {bruto-multi-16k.wav} \
  --vad-probs probs.json --silero-cpu-s {user+sys} --record data/video-xml-vs-final/AAMMDD.json --out cmp.json
```

Lógica pura: `scripts/lib/diaria/video-vad-vs-energy.ts` (teste `test/video-vad-vs-energy-13598.test.ts`).
As ilhas do Silero usam limiar 0,5 e a mesma união (0,32 s) e ilha mínima (0,06 s) do detector de energia.
Referência do editor (registro do #13196): fala = clipes mantidos com as pontas ajustadas, menos as pausas
internas que ele pulou; pausa cortada = essas pausas internas; ambas encolhidas 120 ms por ponta.

## Dados usados (18/11/2026)

| Edição | Bruto | Registro do editor | Duração do bruto |
|---|---|---|---|
| 261116 | `bruto-multi-16k.wav` (cache do #12089) | `261116.json`, `youtube` + `outras-redes` | 1730,3 s |
| 261117 | idem | `261117.json`, `youtube` + `outras-redes` (`guia` sem final) | 1533,4 s |
| 261118 | sem bruto em cache, sem registro | não medida | |

O bruto roda a 16 kHz aqui; o `build` usa 48 kHz (`SPEECH_DETECT.sampleRate`), então o detector de energia
medido é uma aproximação do de produção.

## Resultado

Cobertura da fala que o editor manteve (`speechRecall`, maior = menos fala cortada):

| Edição | Sequência | Energia + F0 | Silero |
|---|---|---|---|
| 261116 | youtube | 0,899 | 0,822 |
| 261116 | outras-redes | 0,852 | 0,766 |
| 261117 | youtube | 0,948 | 0,869 |
| 261117 | outras-redes | 0,954 | 0,894 |

CPU (user+sys, bruto de ~25 a 29 min): energia + F0 5,16 s (261116) e 3,86 s (261117); Silero 5,09 s e 4,47 s
(`silero_vad_v6.onnx` em CPU, carregamento do modelo incluído). Equivalentes.

O Silero cobre 5 a 8 pontos percentuais MENOS da fala que o editor manteve, nas 4 sequências, e gera menos
tempo de ilha (548 s contra 703 s, 513 s contra 649 s): é mais restritivo.

## O que NÃO foi medido: falso positivo de respiração

A referência de pausa (pausas internas que o editor pulou à mão) tem 0,97 a 4,2 s por sequência em 261116 e
0 a 0,1 s em 261117: de 0 a 4 pausas. Isso não sustenta nenhuma taxa de falso positivo (os 1,0 / 0,63 que o
relatório imprime para 261116 saem de 2 pausas, e `pausesWithIsland` vale 2 de 2 para os dois detectores).
Medir respiração exige rótulo de respiração, que o registro do editor não traz (ele cortou o que ouviu como
pausa, não marcou o que era respiração). Sem esse rótulo, a diferença entre os detectores nas pausas seria
interpretação minha, não dado.

## Conclusão

Sem base para trocar o detector: em fala mantida o Silero cobre menos, no mesmo custo de CPU, e a vantagem
esperada (respiração) não é mensurável com este registro. Para fechar a pergunta falta um conjunto rotulado
(trechos de respiração marcados a mão em 2 a 3 edições) ou mais pausas puladas pelo editor.
