# Revisão do export final (#11557)

Referência de `/diaria-video-montagem`, lida sob demanda (#14040). Gatilho: o editor pede "revise o vídeo" sobre um export do Premiere. Citado em "Revisão do export final" do SKILL.md.

Quando o editor pedir "revise o vídeo" sobre um export do Premiere (na 261029 foram 4 pedidos, um por versão), rodar uma vez por arquivo:

```bash
npx tsx scripts/video-montagem.ts review-final {AAMMDD} --file "{caminho do export}"
```

O destino sai do nome (`horizontal_V{n}` ou o antigo `_Youtube_` = 16:9; `_Vertical_`/ `_Instagram_`/`_Outras redes_` = 9:16; `--seq` para outro). Confere formato (proporção, faixa preta pelo `cropdetect`, fps contra o bruto, vertical acima de 3:00), imagem (trecho preto de 0,5 s ou mais pelo `blackdetect`, de mídia offline ou clipe que não renderizou, e quadro congelado de 2 s ou mais pelo `freezedetect`, #13368; a vinheta e o card de CTA ficam fora, com 0,5 s de folga, e sem `plan.json` fica fora o card presumido no fim, e preto ou congelado nos primeiros 6 s sai como achado de baixa certeza, porque pode ser a vinheta ou mídia offline no 1º clipe, #13440), áudio (loudness contra -14 LUFS ±1, true peak acima de -1 dBTP, estalos curtos e isolados, fragmentos de menos de 0,2 s entre silêncios) e, com o `plan.json` em dia, transcreve o export e compara com o roteiro da versão (palavra faltando, hesitação ou falso começo, tomada duplicada), com o tempo no export e o aproximado no bruto (`--no-text` pula a transcrição). A transcrição fica em cache no state dir (`review-final-{destino ou corte}.transcript.json` + `.cache-key.json`, #12078) pelo arquivo (caminho, tamanho, mtime) e pelo modelo e prompt do Whisper: rodar de novo sobre o mesmo export não retranscreve, um export novo no mesmo nome sim, e `--retranscribe` força. O `srt --from-final` do horizontal usa o mesmo cache. Devolve a tabela de correções (#, tempo no export, tempo no bruto, o que está, correção) no stdout e em `review-final-{destino}.md` (num corte, `review-final-{slug}.md`). Mostrar a tabela ao editor; legenda queimada (OCR) e redundância de conteúdo ainda são leitura à mão.
