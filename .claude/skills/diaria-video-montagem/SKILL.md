---
name: diaria-video-montagem
description: Monta o vídeo "diar.ia.br comentada" do dia a partir do bruto no Drive (`{AAMMDD}/` da pasta YouTube) — transcrição por palavra, decupagem (gate 1), roteiro das 2 versões (gate 2), XML FCP7 (xmeml v4) com as 2 sequências para o Premiere, SRTs das verticais, prévia vertical 720x1280 e autorrevisão da prévia. Roda depois do gate da Etapa 4 (o vídeo é gravado depois dele) e antes do `/diaria-publica-video` (o editor exporta do Premiere para `{AAMMDD}/Final/`), standalone, sem encadear. Roda no Neo (Drive em `G:`) ou no 300 (pasta da edição pela API do Drive, #11643); faster-whisper e ffmpeg nos dois. Uso — `/diaria-video-montagem [AAMMDD]`.
---

# /diaria-video-montagem AAMMDD (#11208)

Leva o bruto que o editor gravou até o ponto de partida no Premiere, o fluxo que em 26/10/2026 (edição 261027) foi feito à mão numa sessão inteira. A skill entrega: o Doc da decupagem, o Doc do roteiro final, o XML com as 2 sequências, as legendas das verticais e uma prévia vertical já revisada. **Dois gates humanos** (decupagem e roteiro final: os dois decidem o que o leitor vê); o resto é automático.

**Fora de escopo:** o upload do vídeo final (é do `/diaria-publica-video`) e a edição fina no Premiere, que continua manual.

**Argumentos:**

- `AAMMDD` — opcional. Sem ele, assumir D+1 com o banner padrão do `CLAUDE.md` (`Data não informada — assumindo {AAMMDD} (D+1). Passe AAMMDD explicitamente para outra edição.`) e seguir; os scripts recebem sempre a data explícita.

**Fluxo do dia (#10943, #11209):** `/diaria-edicao` → (o editor grava, depois do gate 4) → `/diaria-video-montagem` → (Premiere e export para `Final/`) → `/diaria-publica-video` → `/diaria-5-publicacao`. Cada skill numa sessão própria, nenhuma encadeia (#5578): ao terminar, sugerir o próximo comando sem rodá-lo.

**Onde fica cada coisa:** os JSON em `data/editions/{AAMM}/{AAMMDD}/_internal/video-montagem/`; o áudio e os clipes temporários em `{tmp}/diaria-video-montagem/{AAMMDD}/`; XML, SRTs e prévia na pasta da edição no Drive (`G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube/{AAMMDD}/`; `--drive-root` ou `DIARIA_VIDEO_DRIVE_ROOT` para outra). No modo API (o 300, Passo 0) tudo fica num cache em disco (`~/.cache/diaria-video-montagem/{AAMMDD}/`: `bruto/`, `out/`, `work/` no lugar do `{tmp}`, e `final/` para o `review-final`; `--cache-dir` ou `DIARIA_VIDEO_CACHE_DIR`) e as saídas sobem sozinhas para a mesma pasta da edição. Nada vai para `Final/`: essa pasta é só dos exports do editor, e é dela que o `/diaria-publica-video` lê.

**Retomada:** o `transcribe` pula o que já está em disco (`--force` refaz tudo; `source.json` refeito refaz os derivados, menos um `transcript.json` existente, que só `--force` retranscreve, #11504) e o `srt` reaproveita a transcrição da sequência enquanto os trechos e o áudio do bruto forem os mesmos. `decupagem`, `roteiro`, `build`, `preview` e `review` sempre refazem. O `plan.json` guarda o hash do `blocks.json`, do `source.json` e do `silences.json` (redetectado pelo `transcribe` quando o limiar muda, #11351): `srt`, `preview` e `review` recusam um plano defasado (rodar `build` de novo), o `preview` recusa um SRT mais velho que o plano e o `review` uma prévia mais velha que o plano.

## Passo 0 — Máquina

Roda no **Neo** (Drive for desktop em `G:`) ou no **300** (sem `G:`, a pasta da edição pela API do Drive, #11643). Conferir antes, nas duas:

```bash
npx tsx scripts/check-video-env.ts --montagem --edition {AAMMDD}
```

Confere ffmpeg, o Python com faster-whisper (decodificando um áudio de teste), o modelo `large-v3-turbo` carregando offline (a transcrição roda com `HF_HUB_OFFLINE=1`), o acesso à pasta da edição pelo mesmo critério de modo do script (com `G:`, a pasta `{AAMMDD}/` sincronizada; sem `G:`, OAuth, a pasta da edição no Drive e permissão de escrita nela, e o bruto) e, só no modo API, o espaço no disco do cache (3x o bruto). Exit 1 = parar e dizer o que falta (o relatório traz o comando de cada item); nunca instalar no meio da skill. Setup das duas máquinas: `docs/setup.md`, seção "Vídeo: montagem".

O modelo é faster-whisper `large-v3-turbo` na CPU em int8 (a CUDA do Neo não funciona: falta `cublas64_12.dll`). O helper roda com `python -P` (não `-I`, que esconde o site-packages do usuário) e `HF_HUB_OFFLINE=1`; o script passa os dois. O Python vem de `--python`, `DIARIA_VIDEO_PYTHON`, o venv `~/.venv-video-montagem` (quando existe; o do 300) ou `python` do PATH (o Neo), nessa ordem (#11642).

**Modo API do Drive (#11639, #11640, #11641).** Sem a pasta YouTube em `G:` (a RAIZ: no Neo com `{AAMMDD}/` ainda não sincronizada o modo continua local e o `transcribe` para dizendo isso), e sem `--drive-root`/`DIARIA_VIDEO_DRIVE_ROOT` explícito, o script entra sozinho no modo API e diz isso no stderr (`--from-drive` força, `--no-drive-api` desliga). O `transcribe` escolhe o bruto na pasta `{AAMMDD}/` do Drive pela mesma regra do disco e o baixa para o cache (6,9 GB na 261030 em ~3 min; o teto do download cresce com o tamanho; o cache só é reaproveitado se for a mesma versão do Drive: id, `modifiedTime` e tamanho). `frame`/`preview` baixam de novo o bruto que sumiu do cache, e param se ele mudou no Drive desde o `transcribe`. Um `--from-audio` que não existe no disco é procurado pelo nome na pasta da edição; um `review-final --file` que não existe, em `Final/`. `build`, `srt` e `preview` sobem o que gravaram no out dir (XML, SRTs, prévia) para a pasta da edição, atualizando pelo id o arquivo de mesmo nome (sem duplicar); os links saem no stderr (`[drive] enviado …`/`[drive] atualizado …`) e em `drive-uploads.json`. Upload que falha depois do comando ter dado certo sai com exit 4 e a lista do que ficou pendente; a próxima execução (ou `upload`) tenta de novo. O XML grava o caminho do bruto no Neo (`G:/Meu Drive/…/{AAMMDD}/{nome}`), não o do cache, para o Premiere abrir com a mídia online (`--xml-media-root` sobrepõe). Sem o conector do Docs, `upload {AAMMDD} --file …/decupagem.md` põe o Markdown na pasta da edição.

## Passo 1 — Transcrição

```bash
npx tsx scripts/video-montagem.ts transcribe {AAMMDD} [--source PATH] [--force]
```

Acha o bruto (o maior `.mp4`/`.mov` solto na pasta da edição, fora de `Final/`, sem "final" nem "previa" no nome; com mais de um candidato sai `[aviso]` listando todos, e `--source PATH` escolhe outro), lê fps/resolução/duração (`source.json`, a fonte única do bruto), extrai o áudio em 16 kHz mono, mede o loudness (`loudness.json`), detecta os silêncios (`silencedetect`, 0,45 s: `silences.json`) e transcreve com tempo por palavra (`transcript.json`, alguns minutos). O limiar do silêncio é relativo ao loudness do bruto (#11351): o loudness integrado menos 25 dB, entre -45 dB (o piso, que serviu ao bruto baixo da 261027) e -25 dB; o bruto quente da 261028 (-9,9 LUFS) dá -35 dB, onde o -45 fixo achava 1 silêncio em 21 min. `--silence-db -35` sobrepõe; o limiar usado fica em `silences.meta.json` e mudar o limiar refaz só os silêncios. Transcrição sem nenhuma palavra é erro. Bruto abaixo de -24 LUFS sai `[aviso]` (a 261027 chegou a -31, contra -21 a -23 nos finais anteriores), e também bruto acima de -14 LUFS ou com true peak ≥ 0 dBTP (provável clipping, a 261028): relatar no fim, a prévia já sai normalizada.

**Bruto só de áudio (#11552, edição 261029).** Sem stream de vídeo no bruto (ou, sem vídeo solto na pasta, um `.m4a`/`.mp3`/`.wav`, com `[premissa]`), o `transcribe` grava `source.json` com `audioOnly: true` e segue no **modo áudio**: transcrição, decupagem (Gate 1), `retranscribe` e roteiro (Gate 2) funcionam igual. `frame`, `build`, `srt`, `preview` e `review` saem exit 3 com `{"audio_only": true, "stopped": true, "reason": …}` no stdout: parar depois do Gate 2 e dizer ao editor o motivo (sem imagem não há XML nem prévia; a montagem no Premiere é à mão a partir do `roteiro.md`). Fala de outra pessoa (entrevistadora) sai marcada pela voz na decupagem (#11507, Passo 2).

**O vídeo chegou depois do áudio já transcrito (#11504).** Quando o áudio separado (ex.: `Diaria comentada_Youtube.wav`) é o mesmo som do bruto de vídeo, só com pausas cortadas, não retranscrever o vídeo inteiro:

```bash
npx tsx scripts/video-montagem.ts transcribe {AAMMDD} --from-audio "{caminho do .wav}" [--source VIDEO] [--audio-transcript JSON]
```

Guarda a transcrição do áudio em `transcript-audio.json` (do `transcript.json` quando o `source.json` era o áudio, ou de `--audio-transcript`), troca o bruto para o vídeo sem `--force`, alinha os dois por correlação do envelope de energia em janelas de 20 s, acha os trechos de deslocamento constante (o corte entre eles no quadro de 10 ms), remapeia as palavras para o tempo do vídeo e retranscreve no vídeo só o que ficou sem par (as pausas cortadas no áudio, 0,3 s de cada lado de cada corte, o que vem antes/depois do áudio). Os deslocamentos e os trechos retranscritos saem no relato e em `audio-align.json`. Menos de 60% do áudio com par é erro (não é o mesmo som): o `source.json` volta para o de antes e o `transcript.json` fica como estava (#11601); aí `transcribe --force` transcreve o vídeo inteiro. **Gates feitos no modo áudio se refazem depois do `--from-audio` (#11603):** o transcript novo renumera os segmentos e muda os tempos, então o `transcribe` põe de lado `decupagem-plan.json`, `decupagem.md`, `blocks.json` e `plan.json` (como `*.defasado.*`, com as decisões do editor para reaproveitar o texto) e avisa; refazer a decupagem (1ª passada) e o `blocks.json` sobre o transcript do vídeo, e o `build` recusa um `plan.json` de outro transcript. **Um `transcript.json` existente nunca é retranscrito sem `--force`**, nem com `source.json` novo: o `transcribe` avisa e mantém (na 261029 ele sobrescreveu a transcrição remapeada à mão).

## Passo 2 — Decupagem (Gate 1)

```bash
npx tsx scripts/video-montagem.ts decupagem {AAMMDD} [--pixel-f0 HZ]
```

O Doc segue o formato da 261027 (#11361): **uma tabela por bloco do roteiro** (`Tempo | Fala | Sugestão | Decisão`), **curada** (só as tomadas da fala; bastidores e falsos começos agrupados em linhas "cortar (bastidor)"), **sugestão com motivo** ("usar (2ª tomada)", "cortar (título antigo)", "alternativa (…)"), **texto limpo** (vocabulário aplicado), coluna **Decisão em branco** para o editor e, no fim, a **"Montagem sugerida"** de cada versão com os timecodes do bruto. Duas passadas:

- **1ª passada (sem `decupagem-plan.json`):** imprime a lista numerada dos segmentos do transcript (tempo, fala e, em cada tomada repetida, a decisão por critério: "tomada 3 de 4: usar (aprovada pela direção: …)", "tomada 1 de 4: cortar (a direção aprovou a 3ª tomada)", "direção: cortar (bastidor …)") e grava o molde `decupagem-plan.template.json`. Ler a lista e escrever `decupagem-plan.json` em `_internal/video-montagem/`: `blocks` é uma lista `{ key, rows }` na ordem do Doc (a da 261027: abertura, título, resumo, comentário, CTAs, encerramento; chaves do `blocks.json`), cada linha `{ segments: [n, …], suggestion: usar|cortar|alternativa, reason?, text? }`. `reason` é obrigatório em cortar/alternativa ("usar" numa frase repetida já sai com "Nª tomada"). Segmento fora de toda linha é bastidor: não listar a conversa com a direção nem os falsos começos, o script agrupa cada sequência deles numa linha só, no bloco da fala seguinte. `text` corrige o que o Whisper errou e o vocabulário não cobre (a 261028 trazia "PNI", "artificial análise", "notícias de ar"); termo que se repete na edição vai em `vocabulary` (mesmo formato do `blocks.json`).
- **2ª passada (com o plano):** valida (todos os erros de uma vez, inclusive os de critério abaixo) e grava `decupagem.md`, o Markdown do Doc, e o molde `blocks.template.json` já com cada fala "usar" como intervalo no bruto e o texto limpo.

**Entrevista (#11507, edição 261029).** Na 1ª passada, a listagem mede a altura da voz (F0 mediana) de cada segmento no `audio.wav` e, quando há duas vozes separadas (centros a ~3 semitons ou mais), marca cada segmento: `voz: Pixel, 163 Hz`, `voz: entrevistadora, 214 Hz: cortar (fala da entrevistadora)`, `voz: ouvir, 190 Hz` (faixa ambígua entre as duas, ou F0 não medida). O Pixel é a voz com mais tempo de fala (`[premissa]`); `--pixel-f0 HZ` fixa a referência. A medida fica em `voices.json`. Fala da entrevistadora é bastidor (fica fora do plano ou "cortar"); "ouvir" se confere no áudio antes de decidir. Monólogo (uma voz só) não marca nada. Sem nenhum título nem resumo "usar", a 2ª passada sai com `format: "entrevista"` no molde e as sequências abertura → comentário → CTA → fecho nas 2 versões (`[premissa]`); o `build` faz o mesmo com um `blocks.json` sem esses blocos e sem `sequences`. `format` (`monologo`/`entrevista`) ou `sequences` no `blocks.json` sobrepõem.

**Decidir por critério, não repassar a dúvida (#11364).** A decupagem decide cada frase: **uma tomada "usar" por frase, as outras "cortar" com o motivo.** A 261028 saiu com ~13 "alternativa" e o XML com todas as opções em sequência (6:55 no YouTube) porque o que tinha critério na própria gravação foi tratado como dúvida. O critério, nesta ordem:

1. **A tomada aprovada pela direção.** Os comentários da direção estão no transcript ("Beleza, é este take", "Muito bom", "a anterior tava melhor", "foi o primeiro do começo") e a listagem já os lê: o comentário vale para a tomada logo antes dele, o último vence. Contrariar a direção pede motivo no `reason`.
2. **A tomada que emenda com a frase seguinte do roteiro** (a fala continua sem corte para a próxima frase).
3. **A última tomada completa**, fora as que a direção recusou ("de novo", "errei").

`alternativa` só quando **nenhum** critério decide, e então com a justificativa no `reason` (qual critério empatou e por quê). Pedido como "nos takes em que tiver dúvida, deixe todos em sequência" vale só para essa dúvida real, nunca é licença para classificar mais coisa como dúvida. **Antes de declarar dúvida, retranscrever o trecho:**

```bash
npx tsx scripts/video-montagem.ts retranscribe {AAMMDD} --from {S} --to {S}
```

Janela curta (até 60 s), sem VAD e sem `condition_on_previous_text`: comentário da direção e começo de frase depois de pausa saem errados na transcrição longa (na 261028, "foi o bom do começo" era "foi o primeiro do começo", que apontava a tomada; e o "À medida" se perdeu). A correção vai no `text` da linha; o `transcript.json` não muda.

**Bastidor fica fora do plano:** a conversa com a direção e a fala fora do roteiro entre tomadas não entram em linha nenhuma, e o script as agrupa como "cortar (bastidor)". Os erros de critério que a 2ª passada recusa: duas tomadas da mesma frase como "usar" (o XML sai com UMA montagem; opção B é `alternativa`, nunca uma 2ª "usar" em sequência) e "alternativa" numa frase cuja tomada a direção aprovou. Avisos (`[aviso]`, seguem): "usar" contrariando a aprovação da direção e comentário da direção dentro de linha "usar".

**Restrição de duração, resolvida aqui:** a "Montagem sugerida" marca a vertical que passa de 3:00 (Shorts) e o stderr dá `[aviso]` com quanto passa (a soma é dos trechos do bruto, antes de tirar os silêncios: estimativa por cima). Nesse caso a decupagem propõe o corte concreto (o trecho, com os tempos, e quanto ele tira), marcando-o "cortar" com o motivo ou, se for só na vertical, dizendo no resumo do Gate 1 qual linha sai do `resumo_curto`/`comentario` (no `blocks.json`, esse trecho vira item próprio com `"targets": ["youtube"]`). Nunca repassar "passa de 3:00" ao editor sem a proposta.

1. Criar o Google Doc **"Transcrição vídeo {AAMMDD} (decupagem)"** na pasta da edição no Drive a partir do `decupagem.md`, com as tabelas como tabelas (conector do Google Drive/Docs no top-level). Sem o conector, o `decupagem.md` copiado para a pasta da edição serve.
2. Comparação com os vídeos anteriores: duração, estrutura e loudness dos finais das últimas edições (`Final/` das pastas anteriores, `ffprobe -v error -show_entries format=duration -of csv=p=0 ARQUIVO`). Uma linha no resumo do gate.
3. **Enquadramento e espelhamento:** `npx tsx scripts/video-montagem.ts frame {AAMMDD} --at {S}` grava um frame do bruto, desespelhado conforme o `mirrored` em vigor (o `source.json` grava `true`; o `blocks.json` sobrepõe), com grade em décimos. Ler a imagem: se a caneca aparecer invertida mesmo assim, o bruto NÃO está espelhado e o `blocks.json` leva `"mirrored": false` (rodar o `frame` de novo para conferir). O centro do rosto (`faceX`) e a linha dos olhos (`eyeY`) saem em fração do quadro para o `framing`. Sem leitura confiável, fica o default da 261027 (`faceX` 0,482, `eyeY` 0,537), que o `build` e a prévia usam igual, com `[premissa]`.
4. **Gate 1:** mostrar ao editor o link do Doc e o resumo (tomadas por frase, sugestões com o critério que decidiu, quantas "alternativa" e por quê, a duração estimada de cada versão com o corte proposto quando a vertical passa de 3:00, loudness, enquadramento). Ele decide no Doc ou na conversa o que entra e em qual bloco.
5. Com a decisão, escrever `blocks.json` a partir do molde (que já traz as falas "usar"; o que o editor mudou na coluna Decisão entra aqui). Blocos: `titulo`, `abertura` ("Olá, eu sou o Pixel", só no horizontal), `resumo`, `resumo_curto` (verticais), `comentario`, `cta_yt`, `cta_vertical`, `fecho`; chave fora dessa lista é erro. Cada item é **a frase** como deve ficar na legenda (`{"text": "…"}`, a tomada sai sozinha: a última completa, `"take": N` para outra) ou **um intervalo** no bruto (`{"start": s, "end": s}`) quando a frase não serve. Item que entra só em algumas versões leva `"targets": ["youtube"]` ou `"skip": ["instagram", "outras-redes"]` (um ou outro, nunca os dois; #11377): é assim que o corte só na vertical, quando ela passa de 3:00, entra no XML em vez de virar instrução manual no Doc. O `build` e o `roteiro` (Gate 2) dão `[aviso]` com quanto a vertical montada passa de 180 s. Os intervalos nunca são fixos: vêm desta decisão, por edição. O casamento das frases tolera os erros comuns do Whisper (1 palavra trocada, engolida ou a mais; "pra"/"para"; "GPT 5"/"GPT-5"; a última palavra omitida) e já aplica o vocabulário. O vocabulário de sempre (Inteligência Personalizada, Modo IA da Busca, Google Photos, e o alias "diária" ouvido = "diar.ia.br" escrito) vive em `context/video-montagem/vocabulario.json`; termo só desta edição vai em `vocabulary` do `blocks.json` (mesmo formato, `targets` para uma versão só). O `blocks.json` é validado inteiro na carga, com todos os erros de uma vez.

**Nenhuma versão leva "Por que isso importa?"** (decisão do editor, 26/10/2026).

## Passo 3 — Roteiro final (Gate 2)

```bash
npx tsx scripts/video-montagem.ts roteiro {AAMMDD}
```

Resolve as tomadas (erro lista todos os itens com problema de uma vez: frase sem tomada completa, intervalo além do bruto) e grava `roteiro.md` no formato da 261027 (#11361): um parágrafo inicial com o que muda entre as versões e **uma tabela por versão** (`Bloco | Fala | Bruto`), a duração da versão no título da seção, o **texto integral** de cada bloco com a duração e o timecode do bruto (e a tomada). As linhas "alternativa" da decupagem entram no bloco como **"opção A/B"**, cada uma com o timecode, nunca em prosa. Item cuja fala ouvida difere do texto pedido (palavra trocada, engolida ou a mais que o casamento tolerou) sai com a linha **fala difere** e o que foi ouvido abaixo da tabela da versão, e como `[aviso]` no stderr: mostrar ao editor no Gate 2 (#11362). Frase com menos de 8 palavras aceita uma tolerância só, e a palavra trocada só se parecida com a do roteiro ("Fotos"/"Photos"), nunca uma troca de sentido ("médio"/"baixo", 261028) nem de número:

| Versão | Sequência | Ordem |
|---|---|---|
| Horizontal YouTube 1920x1080 | `Diaria comentada_Youtube_V1` | título → abertura → resumo → comentário → CTA YouTube → fecho |
| Vertical 1080x1920 | `Diaria comentada_Vertical_V1` | título → resumo curto → comentário → CTA vertical → fecho |

Criar o Google Doc **"Roteiro final {AAMMDD} (2 versões)"** na pasta da edição a partir do `roteiro.md`, com as tabelas como tabelas. **Gate 2:** o editor revisa; onde ainda não sabe a duração, deixa "XX". As mudanças voltam para o `blocks.json` (texto, tomada, ordem em `sequences`) e o `roteiro` roda de novo até ele aprovar. O texto aprovado é a referência das legendas (grafia e pontuação) e da autorrevisão.

Legado: `cta_ig`/`cta_out` continuam válidos com `sequences` explícitas. Sem elas, migrar o CTA escolhido para `cta_vertical` e remover o outro. O target técnico da vertical segue `outras-redes` para preservar escopos e caches antigos.

## Passo 4 — XML para o Premiere

```bash
npx tsx scripts/video-montagem.ts build {AAMMDD} [--allow-missing] [--no-audio-refine]
```

Grava `{AAMMDD} - montagem (importar no Premiere).xml` na pasta da edição (xmeml v4, um arquivo de mídia, vídeo e áudio linkados) e `plan.json`. Em cada bloco os silêncios de 0,8 s ou mais saem, com 0,2 s de respiro de cada lado; clipes com menos de 0,6 s são descartados; o fecho segura 0,5 s depois da ÚLTIMA PALAVRA, sem passar do começo da palavra seguinte do bruto; cada clipe leva o Center calculado do rosto (olhos a ~40% da altura). O stderr lista clipes e duração por sequência.

**Zoom (punch-in), em todas as versões (decisão do editor, 28/10/2026, #11503):** (1) todo corte muda o zoom: emenda entre itens, silêncio removido dentro de um bloco e troca de tomada; (2) nunca há mudança de zoom sem corte: trechos contíguos no bruto (menos de 1 frame entre o fim de um e o começo do seguinte, ou sobrepostos) viram um clipe só antes de alternar a escala, mesmo quando o roteiro divide a fala em vários itens. A escala alterna exatamente nos cortes (50/62 no horizontal, 115/130 nas verticais; bruto menor que 4K sobe a escala para manter a proporção). Trecho contínuo longo sem corte fica com uma escala só (premissa: não inventar corte no meio da fala). A prévia segue os mesmos clipes.

**Refino dos cortes pelo áudio (#11500), sempre, antes do XML:** cada entrada e saída vai para o vale de energia mais próximo no `audio.wav` do bruto (±0,4 s, sem passar do meio da palavra vizinha; limiar = o do silencedetect, relativo ao loudness); as bordas de cada clipe são retranscritas sem VAD (uma chamada do Python para todas, cache em `_internal/video-montagem/edge-retranscribe.json`), e som fora do roteiro na borda (hesitação, cauda da palavra anterior, sílaba de tomada descartada) sai do clipe; clipes que ficam contíguos ou sobrepostos se emendam. Cada ajuste (tempo original, novo, motivo) sai no relato do `build` (`ajuste {bloco} entrada/saída/emenda`) e em `plan.json` (`cutAdjustments` por sequência, `cutRefine`), e entra no XML. Corte que ainda cai em plena fala (limiar + 15 dB) sai como `[aviso]` com o tempo no bruto: conferir no Premiere. Sem `audio.wav` nesta máquina (ou com `--no-audio-refine`), os cortes ficam como os tempos do Whisper, com `[aviso]`. Com isso a autorrevisão (Passo 7) vira conferência; os achados dela trazem `srcAt`, o tempo no bruto.

Bloco da ordem sem item no `blocks.json`, item que some inteiro no corte ou palavra que fica fora dos clipes é **erro** (palavra que o Whisper esticou por cima da pausa, com o trecho fora dos clipes dentro de um silêncio detectado, não conta, #11351) (exit 1, nada gravado): corrigir o `blocks.json` (outra tomada, intervalo maior). `--allow-missing` grava assim mesmo, só quando a falta é intencional e foi dita ao editor.

## Passo 5 — Legendas das verticais

```bash
npx tsx scripts/video-montagem.ts srt {AAMMDD} [--from-raw] [--force]
```

Sem `--seq`, a vertical única (em planos antigos, todas as verticais) (o `--seq` de `srt`, `preview` e `review` só aceita verticais). Monta o áudio de cada vertical a partir dos clipes e transcreve de novo (tempos confiáveis no tempo da sequência), aplica o vocabulário, troca cada palavra casada com o roteiro pelo texto aprovado (grafia e pontuação dele; palavra sem par fica como ouvida) e quebra as cues (fecha antes de passar de 50 caracteres, em pontuação final, ou em vírgula depois de 30; 2 linhas quebradas perto do meio). Grava `{sequência} - legendas.srt`. `--from-raw` remapeia o transcript do bruto em vez de retranscrever (mais rápido, tempos menos precisos).

## Passo 6 — Prévia vertical

```bash
npx tsx scripts/video-montagem.ts preview {AAMMDD}
```

A única vertical é selecionada automaticamente. Renderiza `{AAMMDD} - previa {destino}.mp4` em 720x1280: flip (pelo `mirrored` em vigor), crop pelo rosto (o mesmo cálculo e o mesmo framing do XML), cortes nos mesmos frames do XML, fades de áudio de 20/30 ms em cada corte, legenda queimada e `loudnorm I=-16`. Grava também uma folha com 14 frames espalhados pela prévia inteira (`_internal/video-montagem/previa-{destino}.jpg`): ler a imagem e conferir enquadramento e legenda.

## Passo 7 — Autorrevisão

```bash
npx tsx scripts/video-montagem.ts review {AAMMDD}
```

A única vertical é selecionada automaticamente. Transcreve a prévia e compara com o roteiro, palavra a palavra. Achados (`review-{destino}.json`):

- `tomada-duplicada` — trecho de 2+ palavras fora do roteiro igual ao trecho ao lado (a tomada falsa da 261027, "Uma atualização de…" duas vezes);
- `silaba-vazada` — 1 palavra fora do roteiro a até 0,4 s de um corte, curta (≤3 letras ou <0,35 s): sílaba de tomada descartada;
- `final-seco` — menos de 0,3 s depois da última palavra;
- `fala-extra` / `fala-faltando` — fora do roteiro, ou roteiro sem fala. Uma `fala-extra` que repete o prompt do Whisper (`whisper_prompt` do vocabulário) num trecho sem fala é alucinação do modelo, não do vídeo: conferir ouvindo antes de mexer no `blocks.json`.

Corrigir no `blocks.json` (outra tomada, intervalo explícito) e repetir os Passos 4 a 7. Isso é automático, sem o editor: **no máximo 3 voltas**; o que sobrar depois disso vai no relato, com o achado e o trecho. Achado que pede decisão editorial (frase que nenhuma tomada cobre) volta para o editor.

## Relato e passagem para o Premiere

Uma mensagem: links dos dois Docs, caminho do XML, dos SRTs e das prévias, a folha de frames, a duração de cada versão, o loudness do bruto e os achados que sobraram da revisão. Depois, o que fica com o editor:

1. Importar o XML no Premiere (File > Import). Aplicar **Horizontal Flip** nos clipes das 2 sequências (se o bruto estiver espelhado).
2. Importar o SRT de cada vertical na sequência dela.
3. Edição fina; logo no início se quiser (a 261023 tinha; não entra na montagem, ver Premissas).
4. Exportar para **`{AAMMDD}/Final/`** com o destino no nome: `Diaria comentada_Youtube_V{n}.mp4`, `Diaria comentada_Vertical_V{n}.mp4`. O Premiere sugere o nome da sequência, que já segue esse padrão (`videoTargetOf` em `scripts/lib/diaria/drive-video-source.ts`; o `blocks.json` recusa sequência cujo nome indique outro destino).
5. Rodar `/diaria-publica-video {AAMMDD}` (sugerir, nunca rodar daqui).

## Revisão do export final (#11557)

Quando o editor pedir "revise o vídeo" sobre um export do Premiere (na 261029 foram 4 pedidos, um por versão), rodar uma vez por arquivo:

```bash
npx tsx scripts/video-montagem.ts review-final {AAMMDD} --file "{caminho do export}"
```

O destino sai do nome (`_Youtube_` = 16:9; `_Instagram_`/`_Outras redes_` = 9:16; `--seq` para outro). Confere formato (proporção, faixa preta pelo `cropdetect`, fps contra o bruto, vertical acima de 3:00), áudio (loudness contra -14 LUFS ±1, true peak acima de -1 dBTP, estalos curtos e isolados, fragmentos de menos de 0,2 s entre silêncios) e, com o `plan.json` em dia, transcreve o export e compara com o roteiro da versão (palavra faltando, hesitação ou falso começo, tomada duplicada), com o tempo no export e o aproximado no bruto (`--no-text` pula a transcrição). Devolve a tabela de correções (#, tempo no export, tempo no bruto, o que está, correção) no stdout e em `review-final-{destino}.md`. Mostrar a tabela ao editor; legenda queimada (OCR) e redundância de conteúdo ainda são leitura à mão.

## Premissas (registradas no PR da #11208)

- **Flip fica no Premiere.** O Premiere ignora o filtro "Flop" do FCP7 no import (conferido pelo editor, #11358), por isso o XML não leva o desespelhamento e a antiga `--xml-flop` foi removida. Detectar o espelhamento sozinho (OCR da caneca) não entrou: o `frame` do Passo 2 resolve com uma olhada.
- **Center do Basic Motion** sai em fração da largura/altura da sequência (positivo = direita/baixo), premissa a conferir no 1º import; se o Premiere posicionar errado, ajustar à mão e registrar na issue.
- **Áudio:** o bruto é estéreo e cada clipe de áudio leva 1 `sourcetrack`; o Premiere importa os dois canais (conferido no import da 261027, #11358).
- **Detecção de rosto:** sem dependência viável e gratuita no Neo nem no 300 (sem OpenCV/MediaPipe); o `framing` vem da leitura do frame com grade (Passo 2) ou do default da 261027.
- **Escalas das verticais** 115/130 (as da prévia aprovada da 261027; o XML dela usou 89/105, "enquadramento pequeno").
- **Fades de 20–30 ms** só na prévia; no XML ficam os cortes secos, para o editor tratar no Premiere.
- **Logo no início** fica de fora da montagem automática: opção do editor no Premiere.
- O bruto precisa de fps inteiro (30 na 261027): o XML usa timebase inteiro com NTSC desligado; fps fracionário aborta com mensagem. Rotação por metadado (vídeo de celular "em pé") não é tratada.
