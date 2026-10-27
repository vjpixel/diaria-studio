---
name: diaria-video-montagem
description: Monta o vídeo "diar.ia.br comentada" do dia a partir do bruto no Drive (`{AAMMDD}/` da pasta YouTube) — transcrição por palavra, decupagem (gate 1), roteiro das 3 versões (gate 2), XML FCP7 (xmeml v4) com as 3 sequências para o Premiere, SRTs das verticais, prévia vertical 720x1280 e autorrevisão da prévia. Roda depois do gate da Etapa 4 e antes do `/diaria-publica-video` (o editor exporta do Premiere para `{AAMMDD}/Final/`), standalone, sem encadear. Só na máquina Windows do editor (Drive em `G:`, faster-whisper, ffmpeg). Uso — `/diaria-video-montagem AAMMDD [--xml-flop]`.
---

# /diaria-video-montagem AAMMDD (#11208)

Leva o bruto que o editor gravou até o ponto de partida no Premiere, o fluxo que em 26/10/2026 (edição 261027) foi feito à mão numa sessão inteira. A skill entrega: o Doc da decupagem, o Doc do roteiro final, o XML com as 3 sequências, as legendas das verticais e uma prévia vertical já revisada. **Dois gates humanos** (decupagem e roteiro final: os dois decidem o que o leitor vê); o resto é automático.

**Fora de escopo:** o upload (é do `/diaria-publica-video`) e a edição fina no Premiere, que continua manual.

**Argumentos:**

- `AAMMDD` — obrigatório. Sem ele, assumir D+1 com o banner padrão do `CLAUDE.md` (`Data não informada — assumindo {AAMMDD} (D+1). Passe AAMMDD explicitamente para outra edição.`) e seguir.
- `--xml-flop` — leva o desespelhamento no XML (filtro "Flop" do FCP7). Ainda não conferido no Premiere: sem a flag, o editor aplica Horizontal Flip à mão, como na 261027 (ver Premissas).

**Fluxo do dia (#10943, #11209):** `/diaria-edicao` → (o editor grava) → `/diaria-video-montagem` → (Premiere e export para `Final/`) → `/diaria-publica-video` → `/diaria-5-publicacao`. Cada skill numa sessão própria, nenhuma encadeia (#5578): ao terminar, sugerir o próximo comando sem rodá-lo.

**Retomada:** cada subcomando do `scripts/video-montagem.ts` pula o que já está em disco (`--force` refaz). Os JSON ficam em `data/editions/{AAMM}/{AAMMDD}/_internal/video-montagem/`; o áudio e os clipes temporários em `{tmp}/diaria-video-montagem/{AAMMDD}/`; XML, SRTs e prévia na pasta da edição no Drive (`G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube/{AAMMDD}/`, `--drive-root` ou `DIARIA_VIDEO_DRIVE_ROOT` para outra). Nada vai para `Final/`: essa pasta é só dos exports do editor, e é dela que o `/diaria-publica-video` lê.

## Passo 0 — Máquina

Só no Neo (label `windows` da #11208): o bruto está no Drive for desktop (`G:`), a transcrição roda local. Conferir antes:

```bash
ffmpeg -version
python -P -c "import faster_whisper; print(faster_whisper.__version__)"
```

O modelo é faster-whisper `large-v3-turbo` na CPU em int8 (a CUDA do Neo não funciona: falta `cublas64_12.dll`). O helper roda com `python -P` (não `-I`, que esconde o site-packages do usuário) e `HF_HUB_OFFLINE=1`; o script passa os dois. Outro Python: `--python` ou `DIARIA_VIDEO_PYTHON`. Faltando ffmpeg ou faster-whisper, parar e dizer o que falta; nunca instalar no meio da skill.

## Passo 1 — Transcrição

```bash
npx tsx scripts/video-montagem.ts transcribe {AAMMDD}
```

Acha o bruto (o maior `.mp4`/`.mov` solto na pasta da edição, fora de `Final/`, sem "final" nem "previa" no nome; `--source PATH` para outro), lê fps/resolução/duração (`source.json`), extrai o áudio em 16 kHz mono, mede o loudness (`loudness.json`), detecta os silêncios (`silencedetect` -45 dB, 0,45 s: `silences.json`) e transcreve com tempo por palavra (`transcript.json`, alguns minutos). Bruto abaixo de -24 LUFS sai `[aviso]` (a 261027 chegou a -31, contra -21 a -23 nos finais anteriores): relatar no fim, a prévia já sai normalizada.

## Passo 2 — Decupagem (Gate 1)

```bash
npx tsx scripts/video-montagem.ts decupagem {AAMMDD}
```

Imprime a tabela (tempo, fala, sugestão, decisão em branco) e grava `decupagem.md` e o molde `blocks.template.json`. As tomadas repetidas da mesma frase ficam lado a lado, com a sugestão na **última completa**.

1. Criar o Google Doc **"Transcrição vídeo {AAMMDD} (decupagem)"** na pasta da edição no Drive, com a tabela (conector do Google Drive/Docs no top-level). Sem o conector, o `decupagem.md` copiado para a pasta da edição serve.
2. Comparação com os vídeos anteriores: duração, estrutura e loudness dos finais das últimas edições (`Final/` das pastas anteriores, `ffprobe -v error -show_entries format=duration -of csv=p=0 ARQUIVO`). Uma linha no resumo do gate.
3. **Enquadramento e espelhamento:** `npx tsx scripts/video-montagem.ts frame {AAMMDD} --at {S}` grava um frame do bruto já desespelhado, com grade em décimos. Ler a imagem: a caneca deve aparecer legível (senão o bruto não está espelhado: `"mirrored": false` em `source`), e o centro do rosto (`faceX`) e a linha dos olhos (`eyeY`) saem em fração do quadro para o `framing`. Sem leitura confiável, fica o default da 261027 (`faceX` 0,482, `eyeY` 0,537) como premissa registrada.
4. **Gate 1:** mostrar ao editor o link do Doc e o resumo (tomadas por frase, sugestões, loudness, enquadramento). Ele decide no Doc ou na conversa o que entra e em qual bloco.
5. Com a decisão, escrever `blocks.json` a partir do molde. Blocos: `titulo`, `abertura` ("Olá, eu sou o Pixel", só no horizontal), `resumo`, `resumo_curto` (verticais), `comentario`, `cta_yt`, `cta_ig`, `cta_out`, `fecho`. Cada item é **a frase** como deve ficar na legenda (`{"text": "…"}`, a tomada sai sozinha: a última completa, `"take": N` para outra) ou **um intervalo** no bruto (`{"start": s, "end": s}`) quando a frase não serve. Os intervalos nunca são fixos: vêm desta decisão, por edição. Termos só desta edição para as legendas vão em `vocabulary` (mesmo formato de `context/video-montagem/vocabulario.json`, com `targets` para uma versão só).

**Nenhuma versão leva "Por que isso importa?"** (decisão do editor, 26/10/2026).

## Passo 3 — Roteiro final (Gate 2)

```bash
npx tsx scripts/video-montagem.ts roteiro {AAMMDD}
```

Resolve as tomadas (erro lista todos os itens com problema de uma vez: frase sem tomada completa, intervalo inválido) e imprime o roteiro das 3 versões com a duração de cada bloco e a tomada usada:

| Versão | Sequência | Ordem |
|---|---|---|
| Horizontal YouTube 1920x1080 | `Diaria comentada_Youtube_V1` | título → abertura → resumo → comentário → CTA YouTube → fecho |
| Vertical Instagram 1080x1920 | `Diaria comentada_Instagram_V1` | título → resumo curto → comentário → CTA Instagram → fecho |
| Vertical outras redes 1080x1920 | `Diaria comentada_Outras redes_V1` | título → resumo curto → comentário → CTA outras redes → fecho |

Criar o Google Doc **"Roteiro final {AAMMDD} (3 versões)"** na pasta da edição. **Gate 2:** o editor revisa; onde ainda não sabe a duração, deixa "XX". As mudanças voltam para o `blocks.json` (texto, tomada, ordem em `sequences`) e o `roteiro` roda de novo até ele aprovar. O texto aprovado é a referência das legendas (pontuação) e da autorrevisão.

## Passo 4 — XML para o Premiere

```bash
npx tsx scripts/video-montagem.ts build {AAMMDD} [--xml-flop]
```

Grava `{AAMMDD} - montagem (importar no Premiere).xml` na pasta da edição (xmeml v4, um arquivo de mídia, vídeo e áudio linkados) e `plan.json`. Em cada bloco os silêncios de 0,8 s ou mais saem, com 0,2 s de respiro de cada lado; clipes com menos de 0,6 s são descartados; o fecho segura 0,5 s depois da última palavra; a escala alterna clipe a clipe (punch-in: 50/62 no horizontal, 115/130 nas verticais); cada clipe leva o Center calculado do rosto (olhos a ~40% da altura). O stderr lista clipes e duração por sequência.

## Passo 5 — Legendas das verticais

```bash
npx tsx scripts/video-montagem.ts srt {AAMMDD}
```

Monta o áudio de cada vertical a partir dos clipes e transcreve de novo (tempos confiáveis no tempo da sequência), aplica o vocabulário (`context/video-montagem/vocabulario.json` + o `vocabulary` da edição: diar.ia.br, Inteligência Personalizada, Modo IA da Busca, Google Photos), alinha a pontuação ao roteiro e quebra as cues (acima de 50 caracteres, em pontuação final, ou em vírgula depois de 30; 2 linhas quebradas perto do meio). Grava `{sequência} - legendas.srt`. `--from-raw` remapeia o transcript do bruto em vez de retranscrever (mais rápido, tempos menos precisos).

## Passo 6 — Prévia vertical

```bash
npx tsx scripts/video-montagem.ts preview {AAMMDD} [--seq outras-redes|instagram]
```

Renderiza `{AAMMDD} - previa {destino}.mp4` em 720x1280: flip, crop pelo rosto (o mesmo cálculo do Center do XML), fades de áudio de 20/30 ms em cada corte, legenda queimada e `loudnorm I=-16`. Grava também uma folha de frames (`_internal/video-montagem/previa-{destino}.jpg`): ler a imagem e conferir enquadramento e legenda.

## Passo 7 — Autorrevisão

```bash
npx tsx scripts/video-montagem.ts review {AAMMDD} [--seq outras-redes]
```

Transcreve a prévia e compara com o roteiro, palavra a palavra. Achados (`review-{destino}.json`):

- `tomada-duplicada` — trecho repetido ao lado (a tomada falsa da 261027, "Uma atualização de…" duas vezes);
- `silaba-vazada` — palavra curta fora do roteiro perto de um corte (sílaba de tomada descartada);
- `final-seco` — menos de 0,3 s depois da última palavra;
- `fala-extra` / `fala-faltando` — fora do roteiro, ou roteiro sem fala. Uma `fala-extra` que repete o prompt do Whisper (`whisper_prompt` do vocabulário) num trecho sem fala é alucinação do modelo, não do vídeo: conferir ouvindo antes de mexer no `blocks.json`.

Corrigir no `blocks.json` (outra tomada, intervalo explícito) e repetir os Passos 4 a 7 até a revisão sair limpa. Isso é automático: não precisa do editor, só relatar o que mudou. Achado que pede decisão editorial (frase que nenhuma tomada cobre) volta para o editor.

## Relato e passagem para o Premiere

Uma mensagem: links dos dois Docs, caminho do XML, dos SRTs e da prévia, a folha de frames, a duração de cada versão, o loudness do bruto e os achados que sobraram da revisão. Depois, o que fica com o editor:

1. Importar o XML no Premiere (File > Import). Sem `--xml-flop`, aplicar **Horizontal Flip** nos clipes das 3 sequências.
2. Importar o SRT de cada vertical na sequência dela.
3. Edição fina; logo no início se quiser (a 261023 tinha; não entra na montagem, ver Premissas).
4. Exportar para **`{AAMMDD}/Final/`** com o destino no nome: `Diaria comentada_Youtube_V{n}.mp4`, `Diaria comentada_Instagram_V{n}.mp4`, `Diaria comentada_Outras redes_V{n}.mp4`. O Premiere sugere o nome da sequência, que já segue esse padrão (`videoTargetOf` em `scripts/lib/diaria/drive-video-source.ts`).
5. Rodar `/diaria-publica-video {AAMMDD}` (sugerir, nunca rodar daqui).

## Premissas (registradas no PR da #11208)

- **Flip no XML não conferido.** O FCP7 tem o filtro "Flop"; não há registro de que o Premiere o importe. Por isso `--xml-flop` é opt-in: no 1º uso, conferir se o clipe chega desespelhado; se chegar, a flag pode virar default. Detectar o espelhamento sozinho (OCR da caneca) não entrou: o `frame` do Passo 2 resolve com uma olhada.
- **Center do Basic Motion** sai em fração da largura/altura da sequência (positivo = direita/baixo), premissa a conferir no 1º import; se o Premiere posicionar errado, ajustar à mão e registrar na issue.
- **Detecção de rosto:** sem dependência viável e gratuita no Neo (sem OpenCV/MediaPipe); o `framing` vem da leitura do frame com grade (Passo 2) ou do default da 261027.
- **Escalas das verticais** 115/130 (as da prévia aprovada da 261027; o XML dela usou 89/105, "enquadramento pequeno").
- **Fades de 20–30 ms** só na prévia; no XML ficam os cortes secos, para o editor tratar no Premiere.
- **Logo no início** fica de fora da montagem automática: opção do editor no Premiere.
- O bruto precisa de fps inteiro (30 na 261027): o XML usa timebase inteiro com NTSC desligado; fps fracionário aborta com mensagem.
