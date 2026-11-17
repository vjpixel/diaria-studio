# Medições R2 e R3 do vídeo (#13369, #13370)

Recomendações R2 e R3 do levantamento da #13199
(`docs/video-ferramentas-externas-13199.md`), aprovadas pelo editor no
briefing overnight 261117b com a condição de **medir antes de mudar**. Nada
aqui altera o `build`, o `blocks.json` nem o `face_detect.py` padrão: as
ferramentas só produzem números para o editor decidir.

## R2: Silero VAD como 2º voto do detector de fala (#13369)

**O que mede.** Em cada ponta de clipe do XML (entrada e saída) e em cada
pausa interna, o que o Silero VAD teria votado, contra o que o editor fez no
Premiere (o registro do `video-xml-vs-final`, #13196):

| voto do Silero | quando | editor na mesma direção |
|---|---|---|
| `estender` | fala contínua (≥ 64 ms) nos 300 ms fora do clipe, colados à ponta | `estendeu` (headMs/tailMs > +40 ms) |
| `aparar` | nenhuma janela de fala nos 300 ms (entrada) ou 270 ms (saída) dentro do clipe | `aparou` (< −40 ms) |
| `manter` | nenhum dos dois | `manteve` |

Saem a matriz voto × editor, os acertos, os alarmes falsos (voto de mudança
onde o editor manteve o corte) e as pausas internas removidas pelo editor que
o Silero também cortaria. Lógica: `scripts/lib/diaria/video-vad-vote.ts`.

**Dependência:** nenhuma nova. O `silero_vad_v6.onnx` vem no faster-whisper
do venv da montagem, com o `onnxruntime` (conferido no 300 em 17/11/2026).

**Como rodar, por edição** (a edição precisa do registro em
`data/video-xml-vs-final/{AAMMDD}.json` e do `audio.wav` 16 kHz do
`transcribe`, no work dir da montagem):

```
npx tsx scripts/video-xml-vs-final.ts compare AAMMDD      # se o registro ainda não existe
npx tsx scripts/video-medicoes.ts vad AAMMDD --audio {work}/audio.wav --out /tmp/vad-AAMMDD.json
npx tsx scripts/video-medicoes.ts vad-agrega /tmp/vad-261104.json,/tmp/vad-261105.json,...
```

O áudio precisa estar na linha do tempo do bruto (a do `plan.json`): bruto em
vários arquivos usa o áudio concatenado. Clipe além do fim do áudio sai em
`skipped`, com aviso.

**Critério para levar ao `build`:** decisão do editor com os números do
agregado (`precision` = acertos / votos de mudança; `recall` = acertos /
pontas que o editor mexeu). Voto com muitos alarmes falsos pioraria o corte
aprovado.

## R3: MediaPipe contra o Haar cascade (#13370)

**O que mede.** Nos mesmos frames do `face` (25/50/75% de cada item, 720 px,
desespelhados), os dois detectores, cada item comparado com o `framing`
aprovado no `blocks.json`: itens com rosto achado, frames com rosto, erro
mediano de `faceX` e `eyeY`, itens dentro de 1% do aprovado. A referência do
**arquivo** (medida à mão no `frame`) decide; a do item pode ter vindo de um
`face --write` com o Haar e sai separada. Lógica:
`scripts/lib/diaria/video-face-compare.ts`. O MediaPipe devolve os pontos dos
olhos e da boca; os olhos dele vêm desses pontos, não da fração da caixa.

**Roda em CPU/Python? Conferido no 300 (Linux) em 17/11/2026:**

- `mediapipe==0.10.21` + `opencv-python-headless==4.11.0.86`, Python 3.12:
  roda em CPU (`BaseOptions.Delegate.CPU`), modelo
  `blaze_face_short_range.tflite`.
- `mediapipe` 1.2.3 (a última no PyPI na data) **não carrega** no 300:
  `OSError: libGLESv2.so.2` (pede a biblioteca GLES do sistema, que o 300 não
  tem). Fixar a 0.10.x, ou instalar a libGLESv2 do sistema, que é decisão
  fora desta medição.
- **Neo (Windows): não conferido.** Rodar o mesmo `uv pip install` lá antes de
  qualquer troca.

Na fixture real da 261117 (3 frames), o Haar perdeu o rosto no frame dos 90 s
e o MediaPipe achou (score 0,88). Um frame não é medição: são 5 a 10 edições.

**Venv próprio da medição** (o MediaPipe NÃO entra no venv da montagem
enquanto a medição não sustentar a troca):

```
uv venv --python 3.12 ~/.venv-mediapipe-medicao
VIRTUAL_ENV=~/.venv-mediapipe-medicao uv pip install "mediapipe==0.10.21" "opencv-python-headless==4.11.0.86"
curl -L -o ~/.cache/blaze_face_short_range.tflite \
  https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite
# sha256 em 17/11/2026: b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f
```

**Como rodar, por edição** (bruto local e `blocks.json` com `framing`):

```
npx tsx scripts/video-montagem.ts face-compare AAMMDD \
  --mp-python ~/.venv-mediapipe-medicao/bin/python --mp-model ~/.cache/blaze_face_short_range.tflite
# relatório: {work}/face-compare.json (copiar para fora do work dir antes de ele ser podado)
npx tsx scripts/video-medicoes.ts rosto-agrega a.json,b.json,c.json,d.json,e.json
```

O agregado traz uma leitura mecânica (`sustenta-troca` quando o MediaPipe acha
rosto em pelo menos tantos itens quanto o Haar e tem erro mediano menor ou
igual nos dois eixos, em 5 edições ou mais; `insuficiente` abaixo disso). A
troca do detector no `face_detect.py` é decisão do editor com esses números.

## Ligação com a #13414 (boca no centro das verticais)

O `face` grava `mouthY` por item (a 0,775 da altura da caixa do Haar,
calibrada em 2 frames da 261117 com o ponto da boca do MediaPipe). Se a R3
levar à troca, a boca passa a vir do ponto do MediaPipe, sem a fração.
