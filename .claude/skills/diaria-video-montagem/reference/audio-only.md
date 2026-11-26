# Bruto só de áudio e áudio que chegou antes do vídeo

Referência de `/diaria-video-montagem`, lida sob demanda (#14040). Gatilho: o `transcribe` gravou `source.json` com `audioOnly: true` (bruto sem stream de vídeo, ou só `.m4a`/`.mp3`/`.wav` na pasta), um subcomando saiu exit 3 com `audio_only: true`, ou o vídeo chegou depois de um áudio já transcrito. Citado no Passo 1 do SKILL.md.

## Bruto só de áudio (#11552, edição 261029)

**Bruto só de áudio (#11552, edição 261029).** Sem stream de vídeo no bruto (ou, sem vídeo solto na pasta, um `.m4a`/`.mp3`/`.wav`, com `[premissa]`), o `transcribe` grava `source.json` com `audioOnly: true` e segue no **modo áudio**: transcrição, decupagem, `retranscribe` e roteiro (Gate 2) funcionam igual. `frame`, `build`, `srt`, `preview` e `review` saem exit 3 com `{"audio_only": true, "stopped": true, "reason": …}` no stdout: parar depois do Gate 2 e dizer ao editor o motivo (sem imagem não há XML nem prévia; a montagem no Premiere é à mão a partir do `roteiro.md`). Fala de outra pessoa (entrevistadora) sai marcada pela voz na decupagem (#11507, Passo 2).

## O vídeo chegou depois do áudio já transcrito (#11504)


**O vídeo chegou depois do áudio já transcrito (#11504).** Quando o áudio separado (ex.: `Diaria comentada_Youtube.wav`) é o mesmo som do bruto de vídeo, só com pausas cortadas, não retranscrever o vídeo inteiro:

```bash
npx tsx scripts/video-montagem.ts transcribe {AAMMDD} --from-audio "{caminho do .wav}" [--source VIDEO] [--audio-transcript JSON]
```

Guarda a transcrição do áudio em `transcript-audio.json` (do `transcript.json` quando o `source.json` era o áudio, ou de `--audio-transcript`), troca o bruto para o vídeo sem `--force`, alinha os dois por correlação do envelope de energia em janelas de 20 s, acha os trechos de deslocamento constante (o corte entre eles no quadro de 10 ms), remapeia as palavras para o tempo do vídeo e retranscreve no vídeo só o que ficou sem par (as pausas cortadas no áudio, 0,3 s de cada lado de cada corte, o que vem antes/depois do áudio). Os deslocamentos e os trechos retranscritos saem no relato e em `audio-align.json`. Menos de 60% do áudio com par é erro (não é o mesmo som): o `source.json` volta para o de antes e o `transcript.json` fica como estava (#11601); aí `transcribe --force` transcreve o vídeo inteiro. **Gates feitos no modo áudio se refazem depois do `--from-audio` (#11603):** o transcript novo renumera os segmentos e muda os tempos, então o `transcribe` põe de lado `decupagem-plan.json`, `decupagem.md`, `blocks.json` e `plan.json` (como `*.defasado.*`, com as decisões do editor para reaproveitar o texto) e avisa; refazer a decupagem (1ª passada) e o `blocks.json` sobre o transcript do vídeo, e o `build` recusa um `plan.json` de outro transcript. **Um `transcript.json` existente nunca é retranscrito sem `--force`**, nem com `source.json` novo: o `transcribe` avisa e mantém (na 261029 ele sobrescreveu a transcrição remapeada à mão).
