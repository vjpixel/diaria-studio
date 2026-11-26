# Premissas (registradas no PR da #11208)

Referência de `/diaria-video-montagem`, lida sob demanda (#14040). Gatilho: antes de mudar qualquer premissa do XML, ou quando o editor pergunta por que o XML não faz algo (Flip, Center, escalas, fades, logo, fps). Citado no relato do SKILL.md ("ver Premissas").

- **Flip fica no Premiere.** O Premiere ignora o filtro "Flop" do FCP7 no import (conferido pelo editor, #11358), por isso o XML não leva o desespelhamento e a antiga `--xml-flop` foi removida. Detectar o espelhamento sozinho (OCR da caneca) não entrou: o `frame` do Passo 2 resolve com uma olhada.
- **Center do Basic Motion** sai como o deslocamento em px da sequência dividido pela largura/altura do **bruto** (positivo = direita/baixo). Medido no import da 261104 (#12091): `0.1225` num bruto 3840x2160 virou 470,4 px de Position (= 0,1225 × 3840), então o Premiere lê a fração da mídia original, sem escala (unidade validada na 261104; o valor corrigido está pendente de re-import). Até o #12091 o divisor era a sequência e o rosto saía à direita na vertical (e no horizontal, corrigido à mão naquela edição).
- **Áudio:** o bruto é estéreo e cada clipe de áudio leva 1 `sourcetrack`; o Premiere importa os dois canais (conferido no import da 261027, #11358).
- **Detecção de rosto:** sem dependência viável e gratuita no Neo nem no 300 (sem OpenCV/MediaPipe); o `framing` vem da leitura do frame com grade (Passo 2) ou do default da 261027.
- **Escalas das verticais** 115/130 (as da prévia aprovada da 261027; o XML dela usou 89/105, "enquadramento pequeno").
- **Fades de 20–30 ms** só na prévia; no XML ficam os cortes secos, para o editor tratar no Premiere.
- **Logo no início** fica de fora da montagem automática: opção do editor no Premiere.
- O bruto precisa de fps inteiro (30 na 261027): o XML usa timebase inteiro com NTSC desligado; fps fracionário aborta com mensagem. Rotação por metadado (vídeo de celular "em pé") não é tratada.
