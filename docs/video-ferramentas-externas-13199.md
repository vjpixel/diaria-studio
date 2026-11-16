# Ferramentas externas de edição de vídeo × fluxo de vídeo da diar.ia.br (#13199)

Levantamento feito em 16/11/2026 (rodada overnight 261116b). Escopo decidido pelo
editor no briefing: **só o levantamento** (itens 1 e 2 do entregável da issue),
sem mexer em skill nem em código do fluxo de vídeo. As melhorias do fim deste
documento são **recomendações**: cada uma só vira issue de implementação depois
de aprovada pelo editor, uma a uma (regra de aprovação da #13199).

Critérios aplicados a cada item (princípios do `CLAUDE.md`):

- **Custo:** zero custo recorrente; free tier oficial antes de assinatura.
- **ToS:** nada de automação de site de terceiro por browser ou endpoint não oficial.
- **Auth:** nenhuma sessão de Claude Code autenticando pela API paga por token
  (nem por gateway). Ferramenta que exige key de LLM/serviço pago fica fora.

Licença, preço e recursos vêm das páginas citadas, lidas nesta data. Onde a
página não confirmava algo, está escrito "não confirmado".

## O que o fluxo já faz hoje (base da comparação)

- `/diaria-video-roteiro`: roteiro de fala (1 horizontal + 2 verticais) a partir
  do D1, revisado pelo agent `revisor-roteiro-video` (#13131), e conferência da
  gravação contra o roteiro.
- `/diaria-video-montagem` (`scripts/video-montagem.ts`): transcrição por
  palavra com faster-whisper `large-v3-turbo` local (CPU, int8); decupagem com
  critério de tomada (direção, emenda, última completa) e Gate 1; detector de
  fala próprio (energia + 1ª diferença + F0) para cortar pausas; refino de
  bordas pelo áudio com retranscrição; XML FCP7 (xmeml v4) por sequência, com
  zoom alternado, rosto por OpenCV Haar (`scripts/video/face_detect.py`),
  título PNG, vinheta, card de CTA, áudio tratado por `afftdn` + `agate`;
  `verify-xml` independente; prévia com `loudnorm`; `review` (tomada duplicada,
  sílaba vazada, ritmo); SRT alinhado ao roteiro; `review-final` do export
  (loudness, true peak, `cropdetect`, fala × roteiro).
- `/diaria-publica`: YouTube pela Data API (upload + legenda), verticais em
  Shorts, Reels, Instagram, Threads, LinkedIn, X e TikTok (TikTok via Buffer).
- Em curso, fora desta issue: A/B cego do DeepFilterNet contra o `afftdn`
  (#13234, `scripts/video-audio-denoise-ab.ts`).
- Repo irmão privado `vjpixel/edicao-video` (fork evoluído da montagem), de onde
  já vieram `verify-xml`, multi-bruto e o `face` (#12559, #12560, #12561).

## 1. Levantamento

### 1a. Skills de Claude Code / Agent Skills publicadas

| Nome | Link | O que faz | Licença / custo | Princípios |
|---|---|---|---|---|
| `video-editing` (affaan-m/ECC, "everything-claude-code") | [skillselion](https://skillselion.com/skills/affaan-m/everything-claude-code/video-editing), repo [affaan-m/ECC](https://github.com/affaan-m/ECC) | Guia em camadas: transcrever, montar EDL, cortes em FFmpeg, composição em Remotion, assets gerados (ElevenLabs, fal.ai), polimento em Descript/CapCut | Licença não confirmada na página. Camadas 4-6 dependem de serviços pagos | Parcial: o miolo FFmpeg é livre; ElevenLabs/fal.ai/Descript são pagos |
| `claude-code-video-toolkit` (digitalsamba) | [github](https://github.com/digitalsamba/claude-code-video-toolkit) | 13 skills para vídeo explicativo: remotion, ffmpeg, moviepy, elevenlabs, geração de imagem/vídeo, GPU em nuvem | MIT. Remotion e GPU em nuvem (Modal/RunPod) têm custo por uso | Parcial: foco em vídeo gerado, não em bruto gravado |
| `video-edit` (heygen-com/skills) | [claudemarketplaces](https://claudemarketplaces.com/skills/heygen-com/skills/video-edit), repo [heygen-com/skills](https://github.com/heygen-com/skills) | Receitas de `ffmpeg`/`ffprobe` locais (trim, extrair áudio, converter, probe) | Licença não confirmada na página; só exige ffmpeg | Sim |
| `claude-video-edit` (agricidaniel/claude-video) | [skillselion](https://skillselion.com/skills/agricidaniel/claude-video/claude-video-edit) | Trim, concat, crop, cor; trim sem recodificar alinhado a keyframe | Não confirmada | Sim (local) |
| `ffmpeg-video-editor` (sundial-org/awesome-openclaw-skills) | [claudemarketplaces](https://claudemarketplaces.com/skills/sundial-org/awesome-openclaw-skills/ffmpeg-video-editor) | Pedido em linguagem natural vira comando FFmpeg | Não confirmada | Sim (local) |
| OpenMontage | [github](https://github.com/calesthio/OpenMontage) | Pipeline agêntico de produção (pesquisa, roteiro, assets, edição, render) com aprovação humana por etapa | AGPL-3.0. Roda sem key (Piper TTS, acervos livres); provedores pagos opcionais | Sim no modo sem key, mas AGPL e foco em vídeo gerado |

Listagens agregadas: [tessl](https://tessl.io/registry/skills/github/ysyecust/everything-claude-code/video-editing), [smithery](https://smithery.ai/skills/openclaw/ffmpeg-video-editor), [vibeindex](https://www.vibeindex.ai/skills/digitalsamba/claude-code-video-toolkit/ffmpeg).

### 1b. MCPs de vídeo

| Nome | Link | O que faz | Licença / custo | Princípios |
|---|---|---|---|---|
| DaVinci Resolve MCP (samuelgursky) | [github](https://github.com/samuelgursky/davinci-resolve-mcp) | Controla o Resolve pela Scripting API (timeline, render, marcadores, legendas) | MIT. Scripting externo só no Resolve **Studio** (pago, licença perpétua); no gratuito há uma ponte que o próprio README diz que pode fechar (Resolve 21.1 passou o Python para o Studio) | Custo único se adotado; o editor usa Premiere |
| Adobe Premiere Pro MCP (hetpatel-11) | [github](https://github.com/hetpatel-11/Adobe_Premiere_Pro_MCP) | Painel CEP dentro do Premiere ligado a um servidor MCP; UXP experimental | Licença não confirmada; Premiere já é do editor | Sim (app local). Comunidade, sem suporte da Adobe |
| Outros pontes Premiere | [morim3/mcp_adobe_premiere](https://github.com/morim3/mcp_adobe_premiere), [mikechambers/adb-mcp](https://awesome.ecosyste.ms/projects/github.com%2Fmikechambers%2Fadb-mcp), [ayushozha/AdobePremiereProMCP](https://github.com/ayushozha/AdobePremiereProMCP) | Mesma ideia via UXP; morim3 exige Premiere Beta 25.3+ | Não confirmadas | Idem, mais experimentais |
| Kinocut (ex-`mcp-video`) | [github](https://github.com/KyaniteLabs/kinocut), [pypi mcp-video](https://pypi.org/project/mcp-video/) | MCP local sobre FFmpeg: trim, merge, overlay, legendas queimadas, transcrição opcional, gates de qualidade (quadro preto, silêncio, loudness) | Apache-2.0; tudo local | Sim |

Panoramas consultados: [tella](https://www.tella.com/blog/best-mcp-servers-for-video-editing), [chatcut](https://chatcut.io/blog/best-video-editing-mcp-servers), [motionbox](https://motionbox.io/blog/best-mcp-server-for-video-editing-tools-in-2026).

### 1c. Ferramentas open source usadas por agentes

| Nome | Link | O que faz | Licença / custo | Princípios |
|---|---|---|---|---|
| auto-editor | [github](https://github.com/WyattBlue/auto-editor) | Corta silêncio (loudness) ou parado (movimento), com margem; exporta Premiere XML, Resolve, FCP, EDL | Unlicense (domínio público) | Sim. Discussão aberta sobre XML do Premiere cortando fala: [#404](https://www.github.com/WyattBlue/auto-editor/discussions/404) |
| WhisperX | [github](https://github.com/m-bain/whisperX) | Whisper (faster-whisper) + alinhamento forçado wav2vec2 por palavra + diarização pyannote | BSD-2-Clause. Diarização pede token gratuito do Hugging Face e aceite do modelo. Número e moeda ("2014.", "£13.60") ficam sem tempo | Sim |
| stable-ts | [github](https://github.com/jianfch/stable-ts) | Estabiliza timestamps e alinha **texto conhecido** ao áudio (`align()`), com backend faster-whisper | MIT; repositório **arquivado** (desenvolvimento pausado) | Sim, mas sem manutenção |
| Silero VAD | [github](https://github.com/snakers4/silero-vad), [LICENSE](https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE) | Detector de voz, <1 ms por janela de 30 ms numa thread de CPU, 8/16 kHz | MIT. **Já vem dentro do faster-whisper** (`faster_whisper/assets/silero_vad_v6.onnx`, conferido no venv do 300) | Sim, sem dependência nova |
| DeepFilterNet | [github](https://github.com/Rikorose/DeepFilterNet) | Supressão de ruído neural, 48 kHz, binário `deep-filter` sem Python | MIT ou Apache-2.0 | Sim. Já em avaliação na #13234 |
| pyannote-audio | [github](https://github.com/pyannote/pyannote-audio) | Diarização (quem fala quando) | MIT; modelo `community-1` local com token HF gratuito; `precision-2` é serviço pago (pyannoteAI) | Sim só no modelo local |
| MediaPipe | [github](https://github.com/google-ai-edge/mediapipe) | Detecção de rosto e landmarks | Apache-2.0. A página do repo não confirma o detector de rosto em Python/CPU no Linux/Windows; conferir no guia de Tasks | Sim |
| OpenTimelineIO | [github](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) | Modelo de timeline e conversão entre FCP7 XML, AAF, EDL e outros (adapters em `OpenTimelineIO-Plugins`) | Apache-2.0 | Sim |
| ffmpeg-normalize | [github](https://github.com/slhck/ffmpeg-normalize), [LICENSE](https://raw.githubusercontent.com/slhck/ffmpeg-normalize/master/LICENSE.md) | `loudnorm` EBU R128 em duas passadas (mede, depois corrige) | MIT | Sim |
| LosslessCut | [github](https://github.com/mifi/lossless-cut) | GUI/CLI/HTTP API sobre FFmpeg para corte sem recodificar; detecção de silêncio, cena e quadro preto | GPL-2.0 | Sim |
| Remotion | [licença](https://www.remotion.dev/docs/license/pricing) | Vídeo programático em React | Grátis para empresa de até 3 pessoas; acima disso, a partir de US$ 25/assento/mês | Sim hoje (projeto pequeno), com risco de custo se a equipe crescer |

### 1d. Serviços pagos (citados só para registrar por que ficam fora)

| Nome | Link | O que faz | Por que fica fora |
|---|---|---|---|
| Gling | [gling.ai](https://gling.ai/silence-remover) | Corta silêncio, vícios e tomadas ruins para YouTubers; exporta XML para Premiere/Resolve | Assinatura (preços divergem entre fontes: US$ 10 a 50/mês, [creati.ai](https://creati.ai/ai-tools/gling-ai)); free com marca d'água. Fere o zero custo recorrente e o fluxo já faz o mesmo |
| Descript, CapCut (camada 6 do ECC) | ver ECC acima | Polimento, legendas, cor | Assinatura; o Premiere já cumpre o papel |

### 1e. APIs de publicação

| Canal | Link | Situação | Comparação |
|---|---|---|---|
| YouTube Data API | [quota](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits) | Padrão: 100 `videos.insert`/dia + 10.000 unidades nas demais; mais que isso pede auditoria | Uso atual (2 a 4 uploads por dia útil) cabe com folga |
| TikTok Content Posting API | [get started](https://developers.tiktok.com/doc/content-posting-api-get-started) | Post direto exige auditoria do app; sem auditoria, só privado | O caminho via Buffer (#11515) evita a auditoria; sem motivo para trocar |

## 2. Comparação com o fluxo atual

| Área | Ferramenta externa | Veredito | Por quê |
|---|---|---|---|
| Skills genéricas de vídeo (ECC, digitalsamba, heygen, OpenMontage) | 1a | **Irrelevante** | São receitas de FFmpeg ou pipelines de vídeo gerado. A montagem já tem decupagem por critério de tomada, gates editoriais, verify-xml e review, coisa que nenhuma delas traz |
| Corte de silêncio | auto-editor, LosslessCut, Gling | **Nosso é melhor** | O detector de fala com F0, limiar relativo ao bruto e refino por retranscrição foi calibrado em edições reais (#12089, #12263); o auto-editor corta só por loudness e tem relato de XML do Premiere cortando fala (#404). Serve no máximo como referência de comparação |
| VAD | Silero VAD | **Externa complementa** | O detector atual é heurística de energia e F0; o Silero é um modelo treinado, já instalado (vem no faster-whisper), e pode dar um 2º voto em pausa ambígua (respiração, ruído de sala) |
| Transcrição por palavra | WhisperX, stable-ts | **Igual / parcial** | faster-whisper `large-v3-turbo` com `word_timestamps` já atende. O alinhamento wav2vec2 do WhisperX tende a ser mais preciso na borda da palavra, mas não dá tempo para número, frequente na fala da diar.ia.br. stable-ts está arquivado |
| Legenda alinhada ao roteiro | stable-ts `align()` | **Igual** | O `srt` já alinha o texto aprovado aos tempos (`forceAlignToScript`, #11960); trocar por biblioteca arquivada não ganha nada |
| Diarização | pyannote, WhisperX | **Irrelevante hoje** | Entrevista é exceção (#11507) e a F0 2-means resolve; pyannote traz torch pesado e token HF para um caso raro |
| Redução de ruído | DeepFilterNet | **Externa melhor (provável), já em teste** | É a #13234; nada a propor aqui além de acompanhar o A/B |
| Rosto | MediaPipe | **Externa provavelmente melhor** | Haar cascade erra com rosto de lado, óculos e luz baixa (o filtro "2/3 de cima" existe por causa de falso positivo no microfone, #12560). Precisa medição antes |
| XML para o Premiere | OpenTimelineIO, auto-editor | **Nosso é melhor para gerar; OTIO útil para conferir** | O xmeml próprio leva zoom, Audio Levels, título, vinheta, card e marcadores, que o OTIO não modela. O adapter FCP7 do OTIO pode servir de 2º leitor independente do XML |
| Automação do Premiere | MCPs de Premiere (CEP/UXP) | **Externa cobre o que hoje é manual, com risco** | Import do XML, Horizontal Flip, import do SRT e export para `Final/` são passos à mão (Relato do Passo 7). Os MCPs são comunitários, o UXP não edita timeline de forma confiável e a Adobe vem deprecando APIs de script |
| Automação do Resolve | DaVinci Resolve MCP | **Irrelevante** | O editor usa Premiere; scripting externo só no Studio pago |
| Loudness | ffmpeg-normalize | **Ganho pequeno** | A prévia usa `loudnorm I=-16` em uma passada e o `review-final` mira -14 LUFS; duas passadas dão o alvo exato. Não precisa da biblioteca: o próprio `loudnorm` faz as duas passadas |
| Gates de qualidade do export | Kinocut, LosslessCut | **Externa traz 1 check que falta** | O `review-final` mede loudness, true peak, `cropdetect`, estalos e fala; não procura quadro preto nem congelado no meio do export (`blackdetect`/`freezedetect` do próprio ffmpeg) |
| Composição/gráficos | Remotion | **Irrelevante** | Card, título e tela já saem como PNG/MP4 por ffmpeg; Remotion só traria custo de licença futuro |
| Publicação | YouTube API, TikTok API | **Igual** | Quota do YouTube sobra; TikTok direto exigiria auditoria, Buffer resolve |
| Corte automático com IA paga | Gling, Descript | **Irrelevante** | Custo recorrente e o fluxo já cobre |

## 3. Recomendações (cada uma depende de aprovação do editor)

Nenhuma destas foi implementada nem virou issue de implementação. Ordem: maior
ganho por esforço primeiro.

### R1. `blackdetect` e `freezedetect` no `review-final`

- **Problema:** um export com trecho preto (mídia offline no Premiere, clipe que
  não renderizou) ou quadro congelado passa pelo `review-final` sem acusação; hoje
  só o `cropdetect` olha a imagem.
- **Ganho:** pega antes do upload um defeito que o leitor veria; custo zero
  (filtros nativos do ffmpeg, que já é dependência).
- **Esforço:** pequeno (2 filtros a mais na passada de análise + parse do log +
  teste com fixture).
- **Risco:** baixo; falso positivo no card de CTA (fundo #111111 com fade a
  partir do preto) e na vinheta, que precisam ficar fora da janela.
- **Fonte da ideia:** gates do [Kinocut](https://github.com/KyaniteLabs/kinocut)
  e detecção de quadro preto do [LosslessCut](https://github.com/mifi/lossless-cut).

### R2. Silero VAD como 2º voto no detector de fala

- **Problema:** as pausas ambíguas (respiração, ruído de sala, cauda de "s") são
  decididas só por energia e F0, com uma pilha de limiares calibrada à mão
  (#12089, #12263, #13239).
- **Ganho:** menos sílaba cortada e menos respiração sobrando, sem dependência
  nova (o ONNX já vem no faster-whisper; `onnxruntime` também).
- **Esforço:** médio. Primeiro uma **medição** (ligar o voto em edições já
  montadas e comparar com o corte que o editor aprovou), só depois mexer no
  `build`.
- **Risco:** médio; mexe no corte de toda edição. Por isso começa como medição,
  na linha do que o editor pediu para o Jev (medir antes de implementar).
- **Fonte:** [Silero VAD](https://github.com/snakers4/silero-vad).

### R3. MediaPipe no lugar do Haar cascade, depois de medir

- **Problema:** o Haar erra rosto fora de frente e confunde o botão do microfone
  com rosto (#12560); o enquadramento das verticais depende disso.
- **Ganho:** `faceX`/`eyeY` mais confiáveis, menos `framing` medido à mão.
- **Esforço:** médio (trocar o detector no `face_detect.py`, manter a escolha no
  TypeScript). Antes, medir os dois detectores nos frames de 5 a 10 edições
  contra o `framing` já aprovado.
- **Risco:** baixo a médio; nova dependência no venv do Neo e do 300; confirmar
  antes que o detector roda em Python/CPU nos dois sistemas.
- **Fonte:** [MediaPipe](https://github.com/google-ai-edge/mediapipe).

### R4. `loudnorm` em duas passadas na prévia, com o alvo do export

- **Problema:** a prévia normaliza a -16 LUFS em uma passada; o `review-final`
  cobra -14. O editor ouve a prévia num nível e o export é medido em outro.
- **Ganho:** prévia com o nível que vai ao ar.
- **Esforço:** pequeno (medir, depois aplicar com os valores medidos).
- **Risco:** baixo; o render da prévia fica um pouco mais lento.
- **Fonte:** [ffmpeg-normalize](https://github.com/slhck/ffmpeg-normalize)
  (a técnica, sem adotar a biblioteca).
- **Pergunta embutida para o editor:** o -16 da prévia é escolha deliberada?
  Se for, R4 se reduz a trocar para duas passadas.

### R5. OpenTimelineIO como 2º leitor do XML (opcional)

- **Problema:** o `verify-xml` é código nosso lendo XML nosso; um erro de
  interpretação comum aos dois passa.
- **Ganho:** leitura independente da estrutura (clipes, in/out, duração) por uma
  biblioteca de referência da indústria.
- **Esforço:** pequeno a médio (dependência Python nova + comparação de
  contagem e duração no `verify-xml`).
- **Risco:** baixo; o adapter FCP7 pode não entender extensões que usamos
  (filtros, marcadores) e acusar falso problema.
- **Fonte:** [OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO).

### R6. Spike de automação do Premiere via MCP (só investigação)

- **Problema:** depois do XML, o editor ainda importa, aplica Horizontal Flip,
  importa SRTs e exporta para `Final/` à mão.
- **Ganho potencial:** minutos por edição, e menos esquecimento de passo
  (Flip, SRT).
- **Esforço:** alto e incerto; roda no Mac do editor, exige instalar painel CEP.
- **Risco:** alto: projetos comunitários sem suporte da Adobe, API de script em
  depreciação, roda numa máquina com o projeto aberto do editor. Proposta é só
  um spike de 1 sessão interativa (label `windows`/develop) para ver se o
  import + Flip funcionam, sem tocar no fluxo.
- **Fonte:** [Adobe_Premiere_Pro_MCP](https://github.com/hetpatel-11/Adobe_Premiere_Pro_MCP).

### Descartadas (não recomendo propor)

- Substituir o corte de silêncio por auto-editor: o nosso é mais fino e o XML do
  auto-editor tem relato de corte em fala.
- WhisperX / stable-ts no lugar do faster-whisper: ganho incerto, número sem
  tempo no WhisperX, stable-ts arquivado.
- pyannote para entrevista: caso raro, dependência pesada.
- Resolve MCP, Remotion, Gling, Descript: fora do fluxo (Premiere) ou custo
  recorrente.
- TikTok Content Posting API direta: exige auditoria; Buffer atende.

## Como aprovar

Responder na #13199 (ou no `/diaria-desbloqueia`) com o número da recomendação
aprovada. Cada aprovada vira uma issue própria com prioridade; R2 e R3 começam
como issue de medição.
