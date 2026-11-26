# Motor de montagem de vídeo: o diaria-studio é a fonte canônica (#13999)

Decisão do editor de 25/11/2026 (briefing overnight 261125c e sessão da
revisão de arquitetura #13984): **o diaria-studio é a fonte canônica do motor
de montagem de vídeo**. O repo irmão privado `vjpixel/edicao-video` segue vivo
como **consumidor**. Daqui em diante os portes vão **do diaria-studio para o
edicao-video**, nunca no sentido contrário.

## O que é o motor

No diaria-studio:

- `scripts/video-montagem.ts` (CLI da `/diaria-video-montagem`);
- `scripts/video/*.py` (`face_detect.py`, `transcribe_words.py`,
  `vad_probs.py`, `otio_read_xml.py`) e os `*-requirements.txt` do venv;
- os módulos `scripts/lib/diaria/video-*.ts`.

No edicao-video, o equivalente é `scripts/montagem.ts`, `scripts/lib/core.ts`,
`scripts/face_detect.py` e `scripts/transcribe_words.py` (as animações
`id_anim*.py` e as skills `/trechos`, `/bruto-limpo` e `/montagem` são do
edicao-video e ficam fora desta regra).

## Como os dois repos chegaram aqui

Os portes já correram nos dois sentidos, sem regra escrita:

1. A montagem nasceu no diaria-studio (#11208, 27/10/2026). O
   `transcribe_words.py` do edicao-video diz no cabeçalho que foi copiado de lá.
2. O edicao-video evoluiu sozinho e três recursos voltaram para cá em
   09/11/2026: bruto em vários arquivos (#12559, `video-multi-source.ts`),
   rosto automático (#12560, `video-face.ts` + `scripts/video/face_detect.py`)
   e `verify-xml` (#12561, `video-xml-verify.ts`). Os cabeçalhos desses
   arquivos dizem "portado de `vjpixel/edicao-video`": é o histórico, não o
   sentido atual.
3. Desde então o diaria-studio seguiu com cadência quase diária (179 commits
   no motor entre 27/10 e 26/11/2026) e o edicao-video parou: o motor de lá
   (`montagem.ts`, `core.ts` e os dois `.py`) não muda desde 08/11/2026, e o
   último push do repo foi em 18/11/2026, fora do motor.

Os comentários "portado de" ficam como estão: registram de onde veio cada
peça. O sentido dos próximos portes é o desta página.

## Divergências conhecidas (medidas em 26/11/2026)

| Peça | diaria-studio | edicao-video | Observação para o porte |
|---|---|---|---|
| CLI da montagem | `scripts/video-montagem.ts`, 8.269 linhas | `scripts/montagem.ts`, 1.382 | O edicao-video é genérico (projeto + preset); o studio é preso à edição AAMMDD. Portar por recurso, nunca o arquivo inteiro |
| Núcleo | 56 módulos `scripts/lib/diaria/video-*.ts` | `scripts/lib/core.ts`, 803 linhas | Mesmas funções de base (`sourceFiles`, `fileIndexAtFrame`, `fileBounds`, revisão contra o roteiro) com nomes próximos |
| `face_detect.py` | `scripts/video/face_detect.py`, 243 linhas | `scripts/face_detect.py`, 140 | **Contrato de saída diferente:** aqui o Python devolve `faces: [...]` e a escolha do rosto (o maior nos 2/3 de cima) fica em `pickFace` no `video-face.ts`; lá o Python já escolhe e devolve `face: {...} \| null`, e o `montagem.ts` lê `r.face`. Copiar só o `.py` quebra o `face` e o `gaze` do edicao-video. O studio também ganhou leitura de imagem com caminho acentuado no Windows (`imdecode`), erro explícito sem OpenCV ou sem cascade, e o detector `--detector mediapipe` da medição #13370 |
| `transcribe_words.py` | `scripts/video/transcribe_words.py`, 978 linhas | `scripts/transcribe_words.py`, 117 | Cópia antiga do studio (#11208); o de cá ganhou muito desde então |
| VAD | `scripts/video/vad_probs.py` (Silero, #13598) | não tem | Recurso só do studio |
| 2º leitor do XML | `scripts/video/otio_read_xml.py` (OpenTimelineIO, R5 da #13199) | não tem | Recurso só do studio |

Números de linha medidos com `wc -l` nos dois repos em 26/11/2026; vão
envelhecer. Para remedir, clonar o edicao-video (`gh repo clone
vjpixel/edicao-video`) e comparar com `wc -l` e `diff`.

## Como portar (studio para edicao-video)

1. **Unidade de porte é o recurso, não o arquivo.** Escolher a mudança
   (PR do studio) que se quer levar e identificar as funções tocadas.
2. **Conferir o contrato entre TS e Python antes de copiar um `.py`.** O caso
   do `face_detect.py` mostra que os dois lados dividem a responsabilidade de
   jeitos diferentes; levar o `.py` sem o lado TS quebra o comando.
3. **Adaptar o que é da diar.ia.br.** Caminho por AAMMDD, pasta do Drive,
   `blocks.json` da edição, canais de publicação e o `review-final` do export
   são do fluxo diário; no edicao-video o equivalente é o projeto em
   `projetos/{slug}/` com preset.
4. **Abrir a PR no edicao-video citando a PR e a issue de origem do studio**
   (ex.: "portado de vjpixel/diaria-studio#NNNN"), no cabeçalho do arquivo e
   no corpo da PR, como os cabeçalhos de cá fazem no sentido contrário.
5. **Melhoria que nascer no edicao-video** (um projeto que pediu algo novo)
   vem primeiro para o diaria-studio, numa issue daqui, e só depois volta para
   lá como porte. Assim o studio continua sendo a fonte.

Portar não é obrigatório a cada mudança: o edicao-video é consumidor e porta
quando um projeto dele precisa do recurso.

## O que ficou de fora

O passo 3 da #13999 (mover o motor para `scripts/lib/video/` com regra no
`lib-boundary`, como preparo de uma extração) não foi pedido e segue como
avaliação posterior. O README do edicao-video, que deve registrar a mesma
decisão do lado de lá, é outro repositório e fica pendente (texto proposto na
PR desta issue).
