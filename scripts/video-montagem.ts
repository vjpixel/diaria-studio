import { readShareCue, shareTimeInPlan, SHARE_FILE } from "./lib/diaria/video-share.ts";
/**
 * scripts/video-montagem.ts (#11208) — montagem do vídeo diário "diar.ia.br:
 * notícias de IA", do bruto no Drive até o ponto de partida no Premiere. Usado pela
 * skill `/diaria-video-montagem`; a lógica fica em
 * `scripts/lib/diaria/video-montage.ts` (pura, testada), este arquivo só roda
 * ffmpeg/ffprobe e o helper Python e lê/grava os arquivos.
 *
 * Flag de todos os subcomandos: `--restore-conflict NOME[,NOME]` (#13404)
 * copia de volta, para cada arquivo NOMEADO e ausente em `_internal/video-montagem/`,
 * a cópia de conflito do sync (`{nome}.conflictN`) que o erro de "ausente"
 * mostrou, com `[premissa]`. Nunca sobrescreve o original nem decide empate
 * de mtime. Sem ela, o erro só aponta a cópia e o comando `cp` (Git Bash).
 *
 * Subcomandos e flags próprias:
 *   transcribe AAMMDD [--source PATH] [--force] [--silence-db DB]
 *       bruto → `source.json`, áudio 16 kHz (Whisper) e banda alta 48 kHz (cortes), `loudness.json`, `silences.json`,
 *       `transcript.json`. Pula o que já existe; `source.json` refeito (--force)
 *       refaz todos os derivados. O limiar do silencedetect é relativo ao
 *       loudness do bruto (#11351, `silenceNoiseDb`, gravado em
 *       `silences.meta.json`); `--silence-db -35` sobrepõe. Limiar diferente do
 *       da última detecção refaz só o `silences.json`. Um `transcript.json` existente
 *       nunca é retranscrito sem --force, nem com `source.json` novo (#11504: avisa e mantém).
 *       (#13508) com GPU (cuda + h264_nvenc no ffmpeg), a mesma leitura grava o proxy
 *       `bruto-proxy-1440p.mp4` (+ `.meta.json`), de onde face/face-compare/gaze tiram os
 *       frames; o XML segue no bruto 4K. Falha = só o áudio, como antes, com [aviso].
 *       `DIARIA_VIDEO_PROXY=0` desliga.
 *       (#13507) o decode do bruto na prévia, nos trechos do XML leve e nos frames vai pela
 *       GPU (`-hwaccel cuda`) quando o ffmpeg lista cuda; falha cai na CPU com [aviso] uma
 *       vez por execução. `DIARIA_VIDEO_HWACCEL=0` desliga. Frames do face/gaze em lote.
 *       (#13506) o Whisper fica residente entre as chamadas (`transcribe_words.py --serve`,
 *       ocioso por 15 min encerra); `DIARIA_WHISPER_RESIDENT=0` volta ao helper avulso.
 *   transcribe AAMMDD --source A,B,C [--ordem gravacao|dada] | --all
 *       (#12559) bruto em vários arquivos: uma linha do tempo na ordem de gravação
 *       (creation_time), `files[]` no `source.json`, áudio por arquivo concatenado em
 *       `bruto-audio-48k.wav`. Só com os arquivos locais (não no modo API).
 *   inventory AAMMDD [--dir PASTA] [--editions A,B] [--listen]
 *       (#12559) os vídeos da pasta na ordem de gravação e o papel proposto de cada um
 *       (mestre horizontal em partes, vertical nativa) e a edição pela fala (--listen).
 *   face AAMMDD [--write] [--all] [--um-frame]  (#12560) rosto (OpenCV) em 3 frames por item -> framing do item
 *       (#13588) incremental: a medida de cada item fica em `face-cache.json` (state dir, chave =
 *       hash do intervalo), e só o item com intervalo novo (tomada trocada) vai ao detector;
 *       --all mede tudo. --um-frame: o frame do meio, com 25/75% só onde ele não achou rosto
 *       (opcional: medido na 261117 e na 261118, 1 frame piorou o acerto; o padrão segue 3, #13588).
 *   face-compare AAMMDD --mp-python PY --mp-model TFLITE [--um-frame]
 *       (#13370) MEDIÇÃO: Haar x MediaPipe nos mesmos frames do `face`, contra o framing
 *       aprovado do blocks.json; grava `face-compare.json` no work dir, não muda nada.
 *       --um-frame (#13588): nos frames do `face --um-frame`, para comparar com os 3 frames.
 *   gaze AAMMDD [--seq K]  (#12560) folha de olhar/expressão por clipe (`gaze-{seq}.jpg`)
 *   verify-xml AAMMDD [--seq K] [--no-transcribe]
 *       (#12561) lê o áudio do PRÓPRIO XML, mede as bordas (SOM CORTADO) e compara a fala
 *       montada com o roteiro; exit 1 com problema. O build já abre a borda com SOM
 *       CORTADO até o silêncio no mesmo critério (#13194); a que sobra é aviso do build.
 *       (#13194) limiar de cada borda: min(fixo do bruto, max(-60, p10 em ±4 s + 3 dB)).
 *       Acima do fixo = SOM CORTADO, como sempre. Entre o relativo e o fixo: SOM CORTADO só
 *       com energia sustentada (60 ms) que o build abriria (mesmos limites dele); senão
 *       [aviso] `curta` (estalo, respiro, ruído) ou `sem-abertura` (provável fala cortada,
 *       com o limite: palavra vizinha, clipe vizinho ou teto), gravado em `softEdges` no
 *       verify-xml.json, para o editor conferir no Premiere junto com a prévia
 *       (#13372) 2º leitor independente: o adapter FCP7 do OpenTimelineIO lê o mesmo XML
 *       e confere clipes de áudio, in/out e duração contra o leitor próprio. Opcional
 *       (scripts/video/otio-requirements.txt, Python em DIARIA_OTIO_PYTHON ou o da
 *       montagem) e não bloqueante: sem OTIO avisa e segue; divergência é [aviso] e vai
 *       em `otio` no verify-xml.json
 *   transcribe AAMMDD --from-audio ARQ [--audio-transcript JSON] [--source VIDEO]
 *       (#11504) o vídeo chegou depois de o áudio separado (o mesmo som, com pausas
 *       cortadas) já estar transcrito: alinha o áudio ao vídeo por correlação do
 *       envelope em janelas (`lib/diaria/video-audio-align.ts`), remapeia as palavras
 *       para o tempo do vídeo e retranscreve no vídeo só os trechos sem par. A
 *       transcrição do áudio fica em `transcript-audio.json` (vem de --audio-transcript,
 *       ou do `transcript.json` quando o `source.json` era o áudio); `audio-align.json`
 *       guarda os deslocamentos e o que foi retranscrito.
 *   decupagem AAMMDD [--pixel-f0 HZ] [--no-retranscribe] [--espelho-ambiguo]
 *                           (#13587) na 1ª passada, cada segmento com tomada colapsada é retranscrito
 *                           (a janela do aviso, todas numa chamada só do Whisper; a já gravada é
 *                           reaproveitada) e, onde a janela separou as tomadas, a listagem traz as
 *                           tomadas como segmentos próprios ("retranscrito: parte k de n"), com a
 *                           borda da palavra retranscrita; onde achou uma tomada só, as subjanelas
 *                           (--sub) dizem o falso começo na linha. A listagem fica congelada em
 *                           `decupagem-segments.json`, que a 2ª passada e o roteiro numeram.
 *                           --no-retranscribe: sem Whisper (só o que já está gravado).
 *                           sem `decupagem-plan.json`: lista numerada dos segmentos + molde do plano
 *                           (a skill classifica); com ele: o Markdown do Doc da decupagem (gate 1, por
 *                           bloco, curado, com "Montagem sugerida") + `blocks.template.json` (sempre refaz).
 *                           A listagem traz a decisão por critério de cada tomada (#11364); o plano que
 *                           põe duas tomadas da mesma frase como "usar", ou "alternativa" onde a direção
 *                           já aprovou uma, é erro. Vertical acima de 3:00 sai como [aviso].
 *                           Com duas vozes (entrevista, #11507), cada segmento sai com a voz
 *                           provável pela F0 (`lib/diaria/video-voice.ts`, `voices.json`): a da
 *                           entrevistadora com "cortar", a ambígua com "ouvir"; --pixel-f0 fixa a
 *                           referência do Pixel (default: a voz com mais tempo de fala). Sem título
 *                           nem resumo "usar", o molde sai com `format: "entrevista"` e as
 *                           sequências abertura → comentário → CTA → fecho.
 *                           #13600: a 2ª passada não é parada obrigatória (o Gate 1 saiu): grava
 *                           `decupagem-gate.json` e imprime o banner das premissas; exit 5 só numa
 *                           exceção (tomada colapsada que o retranscribe não separou numa linha que
 *                           vai ao ar, "usar" contra a direção sem reason, ou --espelho-ambiguo:
 *                           o frame lado a lado não decidiu o espelhamento de um bruto sem metadado).
 *   blocks AAMMDD --from-plan [--force]
 *                           (#13463) grava o `blocks.json` do `blocks.template.json` da decupagem e da
 *                           proposta do roteiro de gravação (`_internal/roteiro-falas.json`, a mesma do
 *                           `video-roteiro-blocos.ts`): bloco, `targets`, `falaId`, sequências e título
 *                           da vertical, pelo `falaId` das linhas "usar" do `decupagem-plan.json`
 *                           (`lib/diaria/video-blocks-from-plan.ts`). Sem o roteiro: exit 3. Com
 *                           `blocks.json` já gravado, recusa sem --force (o anterior vai para
 *                           `blocks.antes-from-plan.json`).
 *   retranscribe AAMMDD --from S --to S
 *                           retranscreve só o trecho (até 60 s; sem VAD, sem condition_on_previous_text)
 *                           antes de declarar dúvida (#11364); não mexe no transcript.json. Com --sub (#11958),
 *                           em subjanelas de 4 s (passo 2 s), para achar falso começo/repetição que a janela
 *                           inteira engole: o roteiro propõe o corte na linha "repetição" (Gate 2)
 *   frame AAMMDD --at S    frame do bruto (desespelhado conforme o `mirrored` efetivo, com grade) e, ao lado,
 *                           `frame-{S}-orientacoes.jpg` com o bruto e o espelhado lado a lado + a premissa do
 *                           espelhamento (#11959: metadado da câmera, publishing.video.mirrored_default ou default)
 *   roteiro AAMMDD [--no-short-word-check]
 *                           resolve o `blocks.json` (tomadas) e escreve o roteiro (gate 2, uma tabela
 *                           por versão; as "alternativa" da decupagem viram opções B/C; sempre refaz).
 *                           #12093: retranscreve a janela de cada item (sem VAD, cache em
 *                           `roteiro-retranscribe.json`) e lista na seção "Palavras curtas" onde
 *                           artigo/preposição do roteiro difere do ouvido, para o editor decidir;
 *                           --no-short-word-check (ou sem `audio.wav`) pula, com aviso no Doc
 *   fact-check-input AAMMDD (#11956)
 *                           os itens da fala que vão ao ar (união das versões, com a fala ouvida
 *                           quando difere), o hash deles e o caminho das fontes do D1 do Stage 4, em
 *                           `fact-check-input.json`: entrada do agent `fact-checker` em `mode: "video"`,
 *                           que grava `fact-check.json`; o `roteiro` põe os achados graves no Doc do
 *                           Gate 2, com o trecho do bruto e a proposta de corte.
 *                           #13597: roda logo depois do blocks.json, em paralelo com face/roteiro; com
 *                           `fact-check.json` anterior, o input traz só os itens com texto/fala novos
 *                           (out `fact-check.delta.json`) e os achados dos que não mudaram em
 *                           `incremental.carried_claims`; nada novo = não despachar. --full refaz tudo
 *   fact-check-merge AAMMDD (#13597)
 *                           junta o `fact-check.delta.json` do agent com os achados mantidos no
 *                           `fact-check.json` (delta de outra versão é recusado)
 *   build AAMMDD [--seq youtube|instagram|outras-redes|{corte}] [--allow-missing] [--no-audio-refine] [--no-audio-gain] [--title-mode png|off] [--no-speech-detect] [--speech-full-db N] [--speech-diff-db N] [--no-speech-voice] [--no-audio-clean] [--xml-leve|--xml-bruto] [--trechos-folga S] [--esperar-nuvem S] [--trecho-fonte "CHAVE=caminho;…"]
 *       (#13437) trecho de outro vídeo (formato react, `trechoInserido` da fala do horizontal):
 *       cortado do EXPORT do horizontal do vídeo de origem (nunca do YouTube), no intervalo do
 *       roteiro, no tamanho/fps da sequência (`{AAMMDD}_trecho_{fala}-{hash}.mov` no out dir,
 *       reaproveitado no rebuild só com os quadros do intervalo conferidos no ffprobe; o truncado
 *       é cortado de novo; corte numa pasta temporária fora do Drive, copiado e conferido de novo;
 *       o verify-xml confere o clipe contra a mídia real, #13500),
 *       numa faixa própria do XML (clipitems trecho-{seq}-v{n}/trecho-{seq}-a{n}, nome "trecho
 *       {fala}", label Mango, marcador cobrindo o clipe), logo depois da fala; o que vem depois
 *       anda a duração do trecho (só no XML: plan.json e prévia seguem sem ele; o verify-xml
 *       desfaz o deslocamento). Fonte: --trecho-fonte (CHAVE = id da fala, id do YouTube ou
 *       AAMMDD; caminho explícito ausente = [aviso] e para ali, sem busca automática) >
 *       video_path do 05-youtube-published.json da edição de origem (o trecho cite youtu.be ou
 *       AAMMDD) > diaria-comentada-{AAMMDD}.mp4 dela > Final/ (ou Editado/) da pasta de vídeo
 *       dela no Drive. Sem fonte: [aviso] com os caminhos procurados, só o marcador, e o build
 *       segue. Texto do trecho contra o SRT do vídeo de origem: divergência, SRT ausente ou sem
 *       legenda legível é [aviso]. A lista dos trechos no roteiro.md é do subcomando `roteiro`.
 *       (#13219) XML LEVE por padrão: os clipes apontam trechos do bruto em H.264 4K + PCM 48 kHz
 *       (`trechos/` na pasta da edição, só o que as sequências usam, folga de 1 s de cada lado,
 *       trechos a menos de 3 s um do outro viram um só; nome = arquivo + quadros de início e fim,
 *       reaproveitado no rebuild só com os quadros do nome conferidos no ffprobe; o truncado é
 *       refeito, #13488; render numa pasta temporária fora do Drive, copiado e conferido de novo;
 *       o verify-xml confere os trechos contra a mídia real), para o Premiere não converter o AAC do bruto inteiro nem tocar
 *       o HEVC pelo Drive. h264_nvenc quando o ffmpeg tem; senão libx264. --xml-bruto aponta o
 *       bruto, como antes; --trechos-folga muda a folga. No modo API (300) sai o XML do bruto, com
 *       [aviso] (os trechos não sobem pelo upload do out dir). Falha do ffmpeg = XML do bruto, com [aviso].
 *       (#13493) o XML leve liga sozinho só acima do limiar `publishing.video.xml_leve` (bruto com mais
 *       de 15 GB ou de 8 arquivos, por padrão); abaixo, XML do bruto com [premissa]. --xml-leve força os
 *       trechos, --xml-bruto força o bruto. Os limites dos trechos ancoram no bloco de silêncio do
 *       silences.json em que o corte cai (um ajuste de borda no mesmo silêncio reaproveita o trecho);
 *       fora de silêncio, o segundo inteiro. No Drive for desktop (I:), o build espera os trechos na
 *       nuvem com o tamanho do disco (sem .part) até --esperar-nuvem S (padrão 600; 0 = uma leitura,
 *       pela API com data/.credentials.json) e termina com `[ok] XML leve pronto` ou `[aviso] XML leve
 *       AINDA NÃO pronto` (sem credenciais ou com --no-drive-api: [aviso] de não conferido).
 *       (#12102) o áudio dos clipes do XML (e da prévia) vem de `{AAMMDD}_audio_tratado-{chave}.wav`
 *       (`cleanAudioFileName`; a chave é o hash dos args do ffmpeg), o áudio do bruto com afftdn +
 *       agate (aproximação do Enhance do Adobe Podcast), ao lado do bruto; ffmpeg falho = áudio
 *       cru com [aviso]; --no-audio-clean tira. No modo API o build baixa o bruto de novo se ele
 *       saiu do cache, antes do render da faixa (#12209).
 *       (#13234) [--audio-denoise ffmpeg|deepfilternet] [--df-atten-db N] (ou DIARIA_VIDEO_AUDIO_DENOISE /
 *       DIARIA_VIDEO_DF_ATTEN_DB no .env; binário em DIARIA_DEEP_FILTER, padrão `deep-filter`): motor
 *       da faixa tratada. Padrão ffmpeg até a escolha de ouvido (A/B: scripts/video-audio-denoise-ab.ts);
 *       deepfilternet ausente ou falho cai no ffmpeg com [aviso]. Motor, versão e teto entram no hash.
 *       (#12101) vinheta do logo (publishing.video.vinheta_logo.path) na faixa do topo, no fim do
 *       título; respiro de 0,7 s depois do título no horizontal.
 *       (#12089) o corte de pausas vem do detector de fala (`SPEECH_DETECT`, bruto a 48 kHz em
 *       quadros de 5 ms: sinal cheio acima de -33 dBFS ou 1ª diferença acima de -46 dBFS; pausa
 *       de 0,32 s ou mais sai com 150 ms antes da fala e 120 ms depois; ilha abaixo de 60 ms é
 *       estalo), não do silencedetect; avisa emenda com pausa acima de 0,45 s, pausa acima de
 *       0,45 s dentro do clipe (261116), clipe abaixo de 0,3 s e borda dentro da fala. --no-speech-detect (ou o bruto ausente) volta ao silences.json.
 *       (#12089, medição da 261105) os limiares são os relativos ao bruto (sinal cheio 24 dB
 *       abaixo do topo da fala, 1ª diferença 10 dB acima do piso; só com 90% de quadros com som
 *       entre o 1º e o último som e topo 20 dB acima do piso, senão o fixo com [aviso]); desde o
 *       #13188 baixam o fixo no bruto baixo (nunca a menos de 10 dB do piso), e a cauda da
 *       palavra acima do piso + 12 dB fica na ilha. Com a voz medida (F0) quadro a mais de 150 ms
 *       antes / 200 ms depois de uma âncora de voz (F0 acima do limiar fixo) não é fala
 *       (respiração e ruído de sala saem; a vogal curta fica; #13194: o começo de palavra pouco
 *       vozeado, contínuo até a voz em até 400 ms e 20 dB acima do piso, também fica; com menos
 *       de 20% dos quadros acima do limiar com voz o filtro desliga);
 *       palavra esticada pelo Whisper com metade ou mais em ilhas, menos de 150 ms na pausa, ou
 *       (261116) o trecho na pausa sem som (60 ms acima do piso local + 12 dB, em ±2 s; piso no
 *       p25 só dos quadros de pausa, limiar nunca acima de 3 dB abaixo dos do detector), não
 *       devolve a pausa ([aviso] por palavra). --speech-full-db/--speech-diff-db sobrepõem os
 *       limiares; --no-speech-voice desliga o filtro pela F0.
 *       (#12263) o começo de cada ilha recua até 120 ms no ataque acima do piso de ruído do bruto
 *       + 12 dB (consoante suave abaixo dos limiares fixos); entrada com som nos 40 ms antes do
 *       corte (piso + 45% da faixa) vira [aviso]; a passada B do refino só tira som na entrada
 *       separado da 1ª palavra por silêncio.
 *       (#11935) grava um XML por sequência ({nome da sequência}.xml); `--seq` grava só uma, e só ela muda no plan.json (#11969)
 *       (#12902) plan.json anterior ilegível: `--seq` recusa antes de gravar; rode build sem --seq
 *       (#12968) entradas mudadas desde o plano anterior: `--seq` grava, e as outras sequências ficam no plan.json
 *       como defasadas (XML e versão intactos), fora de srt/preview/review/verify-xml até um build delas
 *       XML FCP7 (xmeml v4) + `plan.json` (com o hash do blocks.json, do source.json e do silences.json).
 *       Clipes contíguos no bruto viram um só e o zoom alterna só nos cortes (#11503). Os cortes
 *       são refinados pelo áudio do bruto (#11500, `lib/diaria/video-cut-refine.ts`): vale de
 *       energia a ±0,4 s, som fora do roteiro na borda (bordas retranscritas sem VAD, cache em
 *       `edge-retranscribe.json`), corte ainda em plena fala vira [aviso]; cada ajuste sai no
 *       relato e em `plan.json` (`cutAdjustments`, `cutRefine`). A banda alta (>3 kHz, -51 dBFS ou mais com o piso do bruto, #11968) protege fonemas com 30 ms de ar e 80 ms de silêncio (#11940). Sem `audio.wav` nesta máquina,
 *       ou com --no-audio-refine, os cortes ficam como os tempos do Whisper, com [aviso].
 *       (#13194) por último, abre a borda com fala logo fora (40 ms de fora acima do fixo do
 *       bruto, ou acima do relativo, min(fixo, max(-60, p10 em ±4 s + 3 dB)), com energia
 *       sustentada por 60 ms; estalo e respiro curto não abrem) quadro a quadro até o 1º
 *       ponto abaixo do limiar da borda, até 0,6 s, sem passar da palavra vizinha de fora
 *       (folga de 0,15 s para a cauda que o Whisper deu a ela) nem de outro clipe; sem
 *       silêncio antes do limite, [aviso] com o limite. O filler da vinheta só abre acima do fixo.
 *       Bloco faltando ou item/palavra que some no corte = erro, salvo --allow-missing.
 *       (#12711) item com fala demais para o texto (ritmo da gravação) ou frase repetida no
 *       intervalo = [aviso] de tomada repetida (o Whisper colapsa a repetição); o roteiro confere
 *       também a retranscrição da janela de cada item (palavra esticada, fala divergente).
 *       (#12712) sequência de corte sem "hook" nem resumo_curto = [aviso] com a 1ª fala como
 *       sugestão (o mesmo erro do video-extra-verticals.ts); com gancho, [premissa] com ele.
 *       Vertical montada acima de 3:00 (Shorts) sai como [aviso] com quanto passa (#11377); o
 *       corte só na vertical é um item com "skip"/"targets" no blocks.json.
 *       Ganho de áudio (#11755): Audio Levels em cada clipe de áudio, para -14 LUFS com teto
 *       -1 dBTP (`audioGainFor`), medido na faixa tratada quando ela entra no XML (#12209,
 *       `audio-tratado.loudness.json`), senão no `loudness.json` do bruto; --no-audio-gain tira. Título nas verticais
 *       (#11756): faixa V2 no bloco `titulo` (sem ele, no 1º bloco) com o `screenTitle` do
 *       blocks.json ou o título do D1 (`02-reviewed.md`); --title-mode png (padrão desde o #12091:
 *       o PNG com fundo a 70% como clipe na V2, pendente de conferência no 1º import com o PNG
 *       via XML) ou off; o text (gerador de texto do FCP7 sobre fundo Color+Crop)
 *       saiu no #12104 e agora é erro.
 *   srt AAMMDD [--seq instagram|outras-redes|{corte}] [--from-raw] [--force]
 *       legendas das verticais e dos cortes (#13212: o horizontal fica fora; a legenda dele
 *       sai só do export final, com `--seq youtube --from-final`, e `--seq youtube` sem
 *       `--from-final` recusa; --seq escolhe uma).
 *       Retranscreve o áudio montado (cache por trechos + identidade do áudio);
 *       --from-raw remapeia o transcript do bruto. O texto é o do roteiro,
 *       alinhado aos tempos da fala (#11960, `forceAlignToScript`): palavra do
 *       roteiro sem par ganha tempo interpolado, palavra ouvida sem par sai quando
 *       cai antes/depois do roteiro, perto de corte ou em silêncio ([aviso] lista).
 *       (Até o #13212 o do horizontal também saía daqui, como
 *       `diaria-comentada-{AAMMDD}.srt` na pasta da edição; agora só o --from-final
 *       grava esse arquivo, o que o `publish-youtube.ts --upload` envia.)
 *       #13332: a mesma legenda entra no XML de cada vertical (o Premiere não importa
 *       SRT de dentro do xmeml): um PNG por cue no estilo da prévia (PREVIEW_SUBTITLE_STYLE),
 *       em `legendas-vertical/` (corte: `legendas-vertical-{slug}/`, que sobe para a
 *       subpasta de mesmo nome da edição), numa faixa no topo do vídeo da sequência. O XML
 *       com legenda é a versão entregue; um `build` de novo regrava o XML sem a faixa.
 *   srt AAMMDD --seq youtube --from-final PATH [--heard-text] [--force] [--retranscribe]
 *       (#12078) a legenda do horizontal no tempo do EXPORT final do Premiere (respiros, vinheta):
 *       transcreve o export (o mesmo cache do review-final, por identidade do arquivo + modelo e
 *       prompt do Whisper; --retranscribe refaz) e alinha a ele o roteiro do horizontal do
 *       plan.json (`forceAlignToScript`, sem os cortes da montagem; plan.json defasado só avisa,
 *       o export saiu do XML daquele build). Grava `{sequência} - legendas do export.srt` no out
 *       dir e a cópia `diaria-comentada-{AAMMDD}.srt` na pasta da edição pela mesma regra; cópia
 *       editada à mão = exit 1 com [erro] (saída: --force, ou --captions-only --captions com o
 *       arquivo do out dir). No modo API, PATH que não existe no disco é o nome em
 *       Final/ no Drive (baixado só depois de validar --seq e o plano). Bruto só de áudio fica
 *       fora: sem build não há plano do horizontal (o `srt` para antes, exit 3).
 *       Backfill de legenda: este comando + `publish-youtube.ts AAMMDD --captions-only`.
 *       (#12198) Legenda imprópria = exit 1 com [erro], NADA gravado: alguma legenda de até 0,3 s
 *       ou palavras do roteiro interpoladas + ouvidas descartadas acima de 10% do roteiro (export
 *       reeditado depois do build). `--heard-text` faz a legenda pela fala do export (grafia e
 *       pontuação do roteiro onde casa); aí só a legenda vazia recusa.
 *   srt AAMMDD --from-final PATH --no-plan [--force] [--retranscribe]
 *       (#12429) a mesma legenda do export para a edição SEM plan.json (horizontais anteriores à
 *       montagem, 261021–261029): o texto é o ouvido (o --heard-text é implícito), com as regras do
 *       vocabulário do projeto (e do blocks.json, se houver) e a grafia dos nomes próprios do
 *       02-reviewed.md da edição, sem os blocos de template (só maiúscula ou acento não ouvido:
 *       "openai" → "OpenAI"; as trocas saem nas notas). Mesmo cache de transcrição do review-final
 *       (chave youtube), mesma saída e mesma cópia na pasta da edição. Só a legenda vazia recusa.
 *       A cópia sai marcada como não revisada (`origin: "no-plan"` em youtube-srt.json e o arquivo
 *       `diaria-comentada-{AAMMDD}.srt.no-plan.json` ao lado dela): o `--captions-only` recusa
 *       enviá-la sem `--captions-reviewed`, dado depois de conferir nomes e números no SRT. Com um
 *       plan.json que tem o horizontal, --no-plan é recusado (use o --from-final com plano), salvo
 *       --force.
 *   preview AAMMDD [--seq youtube|instagram|outras-redes|{corte}] [--no-subs] [--over-target]   (default a vertical da edição; sempre refaz)
 *       (#12694) vertical (da edição ou corte/Short) com mais de 75 s de fala (card de CTA fora
 *       da conta; `verticalTargetS` da edição só reduz) = exit 1 com `[aviso] GATE BLOQUEADO`,
 *       antes de baixar o bruto: o corte é proposto no `roteiro` e aplicado no blocks.json.
 *       `--over-target` força a prévia (só com o editor pedindo); o review aceita a mesma flag.
 *       (#12579) sem SRT, ou com SRT mais velho que o build da sequência, sai sem legenda com
 *       [aviso] (não recusa): as legendas vêm depois da aprovação das prévias; --no-subs tira a
 *       legenda mesmo com SRT em dia. (#12571) o card de CTA do XML entra no fim da prévia.
 *   review AAMMDD [--seq youtube|instagram|outras-redes|{corte}]    (default a vertical da edição; sempre refaz)
 *       `--seq youtube` (#12096): a prévia do horizontal, 960x540, com o recorte de cada clipe
 *       pelo mesmo `framingFor` do XML (`previewCropFor`), a legenda do horizontal queimada e o
 *       áudio normalizado, em `{AAMMDD} - previa horizontal.mp4`; o review cobre ela também.
 *       `--seq` (#11900): o slug do corte escolhe aquela vertical extra (várias por
 *       plano); o destino escolhe a sequência sem corte dele, ou o único corte dele.
 *       Arquivos de trabalho por sequência: seq-{corte|destino}.wav, previa-…, review-….
 *       (#12711) palavra esticada sobre fala na transcrição da prévia = achado tomada-colapsada
 *       (também no verify-xml e no review-final). (#12712) corte sem gancho = [aviso].
 *   review-final AAMMDD --file PATH [--seq youtube|instagram|outras-redes|{corte}] [--no-text] [--retranscribe]
 *       revisão do EXPORT do Premiere (#11557): formato contra o destino (proporção,
 *       faixa preta, fps, teto do vertical), trecho preto e quadro congelado fora da
 *       vinheta e do card de CTA (#13368), loudness/true peak, estalos e fragmentos
 *       nas emendas e, com `plan.json` válido, o texto contra o roteiro da versão
 *       (transcreve o export, em cache por arquivo + Whisper desde o #12078, o mesmo do
 *       `srt --from-final`; `--retranscribe` refaz; `--no-text` pula). Destino pelo nome do arquivo
 *       (`_Youtube_`/`_Instagram_`/`_Outras redes_`) ou `--seq`. Saída: tabela
 *       (#, tempo no export, tempo no bruto, o que está, correção) no stdout e em
 *       `review-final-{destino ou corte}.md`/`.json` no state dir. Só lê o export.
 *   legendar AAMMDD --video ARQ [--no-burn] [--out-dir DIR]
 *       (#12935) legenda um vídeo AVULSO, que não passou pela montagem: transcreve sem VAD,
 *       aplica o vocabulário e a grafia dos nomes do 02-reviewed.md da edição, grava
 *       `{base}.srt` e queima a legenda (estilo da prévia, vertical ou horizontal pela
 *       orientação) em `{base} - legendado.mp4`, ao lado do vídeo (ou no --out-dir).
 *       Autorrevisão pelo áudio: legenda longa demais e fala sem legenda = [aviso].
 *       Só local (o --video precisa existir nesta máquina). O `transcribe` do bruto
 *       também avisa fala sem palavra no transcript (VAD) com o retranscribe da janela.
 * srt, preview e review recusam um `plan.json` defasado (blocks.json ou
 * source.json mudaram depois do build); preview recusa um SRT mais velho que o
 * plano; review recusa uma prévia mais velha que o plano.
 *
 * Opções comuns:
 *   --drive-root DIR   pasta de vídeo local do Drive (default: env DIARIA_VIDEO_DRIVE_ROOT ou
 *                      "I:/Meu Drive/diaria-studio-video", #12578); a edição é {DIR}/{AAMMDD}/
 *   --premiere-root DIR  (build) a mesma pasta de vídeo como o Mac que abre o XML a vê
 *                      (/Users/{user}/Library/CloudStorage/GoogleDrive-{conta}/Meu Drive/diaria-studio-video):
 *                      todo pathurl (bruto, áudio tratado, PNG do título, vinheta, card de CTA)
 *                      troca a raiz do Neo por ela (#12707). Default: publishing.video.premiere_root
 *                      do config; sem ele, a raiz do Neo (I:). "off" ignora o config (XML para o Premiere do Windows).
 *   --state-dir DIR   onde ficam os JSON (default: data/editions/{AAMM}/{AAMMDD}/_internal/video-montagem)
 *   --work-dir DIR     áudio e clipes temporários (default: {tmp}/diaria-video-montagem/{AAMMDD};
 *                      no modo API, {cache}/work, em disco)
 *   --out-dir DIR      onde saem XML, SRT e prévia (default: a pasta da edição no Drive; no modo
 *                      API, {cache}/out, que sobe para a pasta da edição)
 *   --python EXE       Python com faster-whisper (default: env DIARIA_VIDEO_PYTHON, o venv
 *                      ~/.venv-video-montagem quando existe, ou "python"; #11642)
 *
 * Modo API do Drive (#11639, #11640, #11641), o 300 sem o Drive for desktop:
 * sem a RAIZ {drive-root} no disco (a pasta de vídeo; e sem --drive-root/DIARIA_VIDEO_DRIVE_ROOT
 * explícito), ou com --from-drive, a pasta da edição é lida pela API (OAuth do projeto;
 * pasta de vídeo em publishing.youtube.drive_folder_id, --folder-id sobrepõe). --no-drive-api
 * desliga. O bruto vai para um cache em disco (--cache-dir, DIARIA_VIDEO_CACHE_DIR ou
 * ~/.cache/diaria-video-montagem/{AAMMDD}: bruto/, out/, work/, final/), registrado em
 * bruto.drive.json; build/srt/preview sobem o que gravaram no out dir para a pasta da edição
 * (nunca Final/), em drive-uploads.json; upload que falha depois do comando dar certo sai com
 * exit 4 e fica pendente para a próxima execução. O XML aponta o bruto no Neo
 * (--xml-media-root sobrepõe).
 *   upload AAMMDD --file PATH   sobe um arquivo para a pasta da edição (ex.: o decupagem.md)
 *
 * Modo local com raiz explícita fora do Drive for desktop (#13308, #13334), o 300 com
 * DIARIA_VIDEO_DRIVE_ROOT=/mnt/hd-sata/.../local-root: a vinheta é procurada em
 * {raiz}/_marca/{nome do MOV do config} e, faltando lá e no caminho do config, baixada da
 * _marca/ do Drive para essa pasta. Com data/.credentials.json presente (e sem --no-drive-api),
 * build/srt/preview sobem o que gravaram na pasta da edição (trechos/ na subpasta de mesmo
 * nome) como no modo API, em drive-uploads.json, e `upload` funciona; o build confere no fim
 * se todo arquivo do XML está no Drive e avisa o que falta. A raiz padrão (I:) nunca sobe pela
 * API: o Drive for desktop já sincroniza.
 *
 * Pasta arquivo/ (#13610): depois de build/srt/preview/upload que deram certo, a versão
 * anterior de cada arquivo da raiz de {AAMMDD}/ vai para {AAMMDD}/arquivo/ (move, nunca apaga;
 * no Drive pela API, preservando o id; no Neo pelo disco). Fica o XML de maior _V{n} de cada
 * família, o SRT da versão dele e os assets que os XMLs vigentes referenciam; política em
 * scripts/lib/diaria/video-version-archive.ts. A prévia regravada arquiva a anterior depois de a
 * nova estar gravada/enviada. A
 * numeração do build conta o arquivo/ e o plan.json. Falha ao arquivar é [aviso], nunca muda o
 * exit. --no-archive desliga. Migração das pastas antigas: scripts/archive-video-versions.ts.
 *
 * Cache e HD (#12365): DIARIA_VIDEO_CACHE_DIR aponta para um SUBDIRETÓRIO dentro do ponto de
 * montagem do HD, nunca o ponto em si. No modo API, a variável apontando para um diretório que
 * não existe, ou que está no mesmo disco do home (HD desmontado), para com erro em vez de criar
 * o cache no disco raiz. Retenção: scripts/prune-video-montage-cache.ts (task diária).
 * A variável vale também quando só está no .env do projeto (#13103): a entrada de linha de
 * comando (`cliMain`) carrega o .env antes de resolver o cache.
 *
 * Bruto só de áudio (#11552): sem stream de vídeo (ou, sem vídeo solto na
 * pasta, um .m4a/.mp3/.wav), o `transcribe` grava `source.json` com
 * `audioOnly: true` e segue; decupagem, retranscribe e roteiro funcionam igual.
 * frame, build, srt, preview e review param com exit 3 e o motivo no stdout
 * (`{audio_only: true, stopped: true}`): a montagem é à mão a partir do roteiro.
 *
 * Nada aqui publica: no Neo as saídas vão para a pasta local do Drive for
 * desktop, que sincroniza sozinha; no modo API sobem para a mesma pasta. O
 * upload do vídeo continua no `/diaria-publica-video`.
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { brtStamp, chooseConflictCopy, conflictCopiesOf, missingFileConflictHint, restoreFromConflictCopy, type ConflictCopyFs } from "./lib/sync-conflict-copy.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { editionDir as editionDirFor, editionsRoot as editionsRootDir } from "./lib/edition-paths.ts";
import { parseRoteiroFalas, propostaBlocosDoRoteiro, readRoteiroFalas, readRoteiroCortesReserva, readRoteiroFontes, readRoteiroHorizontal, readRoteiroPecas, readRoteiroTelas, ROTEIRO_FALAS_FILE, VERTICAL2_CORTE_SLUG } from "./lib/diaria/roteiro-videos.ts";
import { blocksFromPlan } from "./lib/diaria/video-blocks-from-plan.ts";
import { clampTelaOverlaps, previewTelaArgs, telaBoxSvgForMarker, telaFileName, type TelaOverlay } from "./lib/diaria/video-tela.ts";
import {
  readTrechosInseridos,
  trechoClipFrames,
  trechoInseridoLine,
  trechoRipple,
  trechoExportSpans,
  wordsSemTrechos,
  intervalsSemTrechos,
  planTimeToExport,
  trechosInseridosSection,
  unrippleXmlClips,
  type TrechoInseridoClip,
  type TrechoInseridoMarker,
  type TrechoInseridoRoteiro,
} from "./lib/diaria/video-trecho-inserido.ts";
import {
  avisosTrechosNaMontagem,
  parseTrechoFonteArg,
  resolverFonteTrecho,
  trechoInseridoEncodeArgs,
  trechoInseridoFileName,
  type FonteTrecho,
} from "./lib/diaria/video-trecho-fonte.ts";
import { rotuloTrecho } from "./lib/diaria/trecho-inserido-formato.ts";
import { cueFrames, parseAssStyle, subtitleBottomY, subtitleCueSvg, subtitleDirName, subtitleFileName, subtitleTrack, withSubtitleTrack, type SubtitleOverlay } from "./lib/diaria/video-legenda-xml.ts";
import { CAPA_INICIO, capaInicioFileName, capaInicioFrames, capaInicioMsOf, capaInicioXmlIssues, previewCapaInicioArgs, resolveCapaInicioText, type CapaInicioAsset } from "./lib/diaria/video-capa-inicio.ts";
import { composeShortCoverOverlay } from "./lib/diaria/youtube-thumb.ts";
import {
  AUDIO_GAIN_TARGET_LUFS,
  AUDIO_GAIN_TP_CEILING_DBTP,
  LOUDNORM_TARGET,
  PREVIEW_LOUDNORM,
  PREVIEW_RAW_NAME,
  loudnormSecondPassFilter,
  parseLoudnormFirstPass,
  previewLoudnormApplyArgs,
  previewLoudnormMeasureArgs,
  PREVIEW_SUBTITLE_STYLE,
  PREVIEW_SUBTITLE_STYLE_HORIZONTAL,
  SILENCE_DETECT,
  SPEECH_DEFAULTS,
  alignHeardTextToScript,
  applyVocabularyToWords,
  horizontalSequenceName,
  sequenceKey,
  assembleClips,
  closeSliverGaps,
  audioGainFor,
  buildSequencePlan,
  buildXmeml,
  telaMarkersFor,
  trechoInseridoAtFrames,
  telaSemMarcador,
  type TelaMarker,
  clockTime,
  collapsedTakeSuspects,
  cueTimings,
  cuesToSrt,
  pathUrl,
  premierePath,
  wrapCueText,
  cutPoints,
  defaultSequences,
  describeCollapsedSuspect,
  effectiveFormat,
  effectiveFraming,
  effectiveSource,
  firstTitledVertical,
  forceAlignToScript,
  forcedAlignmentNotes,
  ganchoWarning,
  parseSequenceIdVersion,
  parseVersionedSequenceId,
  pickXmlVersion,
  sequenceNameVersion,
  versionedSequenceId,
  versionedSequenceName,
  frameCropOverlays,
  frameCropLegend,
  loudnessWarning,
  framingWarningsByFile,
  sequenceAnchor,
  makeMatcher,
  mapWordsToSequence,
  trimWordsToSilences,
  isVerticalSpec,
  isYoutubeSpec,
  CTA_BLOCKS,
  offsetTranscript,
  subWindows,
  parseBlocksFile,
  retranscribeWindow,
  RETRANSCRIBE_MAX_S,
  parseLoudnormJson,
  parseFrameRate,
  parseProbe,
  mirroredDefaultFrom,
  mirroredPremise,
  parseSilenceDetect,
  pickRawSource,
  premiereRootFrom,
  unmappedPremierePaths,
  previewClipArgs,
  previewClipAudioArgs,
  previewCropFor,
  clipFraming,
  previewSize,
  resolveBlocks,
  reviewPreview,
  audioEndFromSilences,
  screenTitleSvg,
  normalizeToken,
  tokenize,
  segmentCues,
  sequenceSourceRanges,
  srtTimestamp,
  silenceNoiseDb,
  transcriptWords,
  reviewTranscriptWords,
  validateVocabRules,
  vocabRuleWarnings,
  audioCleanArgs,
  audioCleanFilter,
  AUDIO_CLEAN,
  audioCleanParams,
  parseVinhetaProbe,
  previewVinhetaFilter,
  vinhetaBreathFor,
  vinhetaBreathBlock,
  openingBlockOf,
  vinhetaConfigFrom,
  vinhetaScalePct,
  vinhetaSpan,
  vinhetaDuckSpan,
  vinhetaSfxConfigCheck,
  vinhetaSfxConfigFrom,
  vinhetaSfxFrames,
  vinhetaUsesMovAudio,
  parseVinhetaSfxProbe,
  VINHETA_DUCK_DB,
  titleBreathS,
  VINHETA_AFTER_SPEECH_S,
  type VinhetaAsset,
  type VinhetaSfx,
  type AudioGain,
  clipGeometry,
  fitWarnings,
  framingOfFile,
  joinWordTexts,
  type BlockKey,
  type ResolvedItem,
  type ReviewFinding,
  type BlocksFile,
  type CutAdjustment,
  type ForcedAlignment,
  type Framing,
  type Interval,
  type PlannedClip,
  type PremierePathMap,
  type RawClip,
  type ScreenTitleXml,
  type Segment,
  type SequencePlan,
  type SequenceKey,
  type SequenceRef,
  type SequenceSpec,
  type SequenceTarget,
  type SourceInfo,
  type Transcript,
  type VocabAlias,
  type VocabRule,
  type TokenMatcher,
  type Word,
} from "./lib/diaria/video-montage.ts";
import {
  combineSourceFiles,
  fileBounds,
  isMultiSource,
  locateTime,
  normalizeSourceFiles,
  clampRawsToFiles,
  probeExtras,
  proposeRoles,
  sourceFiles,
  type FileOrder,
  type InventoryFile,
  type InventoryRow,
} from "./lib/diaria/video-multi-source.ts";
import { decideXmlLeve, esperarTrechosNaNuvem, parseEsperarNuvemArg, parseTrechoFrameProbe, parseTrechoName, parseTrechosFolgaArg, parseXmlLeveChoice, pickTrechoEncoder, planTrechos, silencesPerFile, TRECHOS, trechoEncodeArgs, TRECHO_FRAME_TOL, trechoFrameProbeArgs, trechoFramesOk, trechoNamesInXml, trechosCoverage, xmlLeveLimiarFrom, type TrechoEncoder, type TrechoXml, type XmlLeveChoice } from "./lib/diaria/video-xml-trechos.ts";
import { otioCheckLines, otioCrossCheck, resolveOtioPython } from "./lib/diaria/video-xml-otio.ts";
import { assemblySegments, edgeFindings, edgeLine, localEdgeThreshold, LOCAL_FLOOR_EDGE, longPauses, type EdgeFindingsContext, type TimelineClip, softEdges, softEdgeWarnings, softReasonText, SUSTAINED_EDGE, CUT_EDGE_OPEN, openCutSoundEdges, parseXmlAudio, sequenceCutsS, toTimeline, xmlPlanIssues, xmlStructureIssues } from "./lib/diaria/video-xml-verify.ts";
import { CTA_CARD, ctaCardDurationFrom, ctaCardFileName, ctaCardFrames, ctaCardOrientation, ctaCardPreviewClipArgs, ctaCardRenderArgs, ctaCardSvg, ctaCardXmlIssues, ctaShareLine, type CtaCardAsset } from "./lib/diaria/video-cta-card.ts";
import { applyItemFramings, FACE_SAMPLE_FRACTIONS, gazeMarks, itemFramings, type FrameDetection } from "./lib/diaria/video-face.ts";
import { compareFaceDetectors, FACE_COMPARE_TOL, FACE_DETECTORS, type FaceReference } from "./lib/diaria/video-face-compare.ts";
import {
  alternativesFromDecupagem,
  blocksFromDecupagem,
  buildDecupagemDoc,
  checkDecupagemCriteria,
  decupagemMarkdown,
  decupagemPlanTemplate,
  decupagemOpeningBlock,
  mdCell,
  parseDecupagemPlan,
  proposeGancho,
  roteiroMarkdown,
  segmentListing,
  SHORTS_MAX_S,
  shortsWarning,
  suggestedDurations,
  verticalPreviewGate,
  verticalTargetCheck,
  verticalTargetOverrideWarning,
  verticalTargetWarning,
  type DecupagemPlan,
} from "./lib/diaria/video-montage-docs.ts";
import {
  BLACK_FREEZE_FILTER,
  OPENING_FALLBACK_S,
  blackFreezeWindows,
  checkBlackFreeze,
  parseBlackdetect,
  parseFreezedetect,
  checkFormat,
  checkLoudness,
  checkText,
  dedupeAudioFindings,
  detectClicks,
  detectFragments,
  exportTarget,
  exportTimeToRaw,
  finalReviewTable,
  parseCropdetect,
  parsePeakWindows,
  type FinalReviewFinding,
} from "./lib/diaria/video-final-review.ts";
import { corteSuffixOf, VIDEO_TARGETS, type VideoTarget } from "./lib/diaria/drive-video-source.ts";
import {
  SIBILANTS,
  combinedCutEnvelope,
  highBandSilences,
  highBandThresholdDb,
  intersectSilences,
  intersectionLossWarning,
  preserveSibilants,
  highBandCutWarnings,
  edgeWindowsFor,
  energyEnvelope,
  type Envelope,
  noiseFloorThreshold,
  noPausesWarning,
  maxDbIn,
  parseWavPcm16,
  snapClipEdges,
  speechCutWarnings,
  SPEECH_DETECT,
  SPEECH_DETECT_PLAN,
  protectTranscribedWords,
  frameEnergies,
  speechIslands,
  speechJoinWarnings,
  absorbShortClips,
  speechPauseSilences,
  trimEdgeExtras,
  windowKey,
  extendIslandAttacks,
  entryCutSoundWarnings,
  entrySoundLimitDb,
  speechThresholds,
  voiceAnchorDb,
  voicedFractionAboveThreshold,
  type SpeechThresholds,
  type EdgeWindow,
  type FrameEnergy,
} from "./lib/diaria/video-cut-refine.ts";
import { classifyVoices, segmentF0s, speechSeconds, voicedFrames, type VoiceMark } from "./lib/diaria/video-voice.ts";
import { ALIGN_DEFAULTS, alignEnvelopes, mergeRetranscribed, remapToVideo } from "./lib/diaria/video-audio-align.ts";
import { readWithRetry } from "./lib/diaria/video-xml-vs-final.ts";
import { gFetchRetry } from "./lib/drive-helpers.ts";
import { archiveDriveIds, archiveEditionDrive, archiveEditionLocal, installPreviewFile, rootIdsNamed, xmlNamesWithArchive, type EditionArchiveResult } from "./lib/diaria/video-version-archive-io.ts";
import { isOverwriteArchivedName, versionOfSequenceId, type ArchiveEntry } from "./lib/diaria/video-version-archive.ts";
import { gFetch, googleCredentialsPresent } from "./google-auth.ts";
import {
  DEFAULT_DRIVE_ROOT,
  changedFiles,
  driveCacheDir,
  driveModeFor,
  driveRelativePath,
  ensureCachedFile,
  ensureChildFolder,
  localDriveUploadFor,
  missingInDrive,
  snapshotDirWithSubdirs,
  workDirDefault,
  fetchFileMeta,
  finalFolders,
  findByName,
  findEditionFolder,
  listChildren,
  parseDriveSize,
  pickDriveBruto,
  readSidecar,
  snapshotDir,
  toPosix,
  uploadToFolder,
  xmlMediaPath,
  youtubeFolderIdFrom,
  type BrutoDriveInfo,
  type DriveEntry,
  type MontageDriveDeps,
} from "./lib/diaria/video-montage-drive.ts";
export { driveCacheDir, driveModeFor, workDirDefault };
import { resolveVideoPython } from "./lib/diaria/video-montage-env.ts";
import { audioIdentity, sameAudio, type AudioIdentity } from "./lib/diaria/video-audio-identity.ts";
import { batchFrameArgs, chunkFrameJobs, clipsToRedoOnCpu, createHwDecoder, ffmpegListsCuda, type FrameJob } from "./lib/diaria/video-hwaccel.ts";
import { falasSemTomada, falasSemTomadaAviso, readRoteiroFalasLista, videosForaDoBruto, videosForaDoBrutoAviso } from "./lib/diaria/video-roteiro-cobertura.ts";
import { PROXY, cropOnProxy, proxyOutputArgs, proxySize, proxyUsable, runExtractWithProxy, type ProxyMeta } from "./lib/diaria/video-proxy.ts";
import {
  deepFilterArgs,
  deepFilterBin,
  deepFilterDescriptor,
  deepFilterInputArgs,
  deepFilterOutputPath,
  parseDeepFilterVersion,
  resolveAudioDenoise,
  type AudioDenoiseChoice,
  type AudioDenoiseEngine,
} from "./lib/diaria/audio-denoise.ts";
import { parseDestaques } from "./extract-destaques.ts";
import { buildYouTubeTitle, stripInlineMarkdown } from "./lib/diaria/youtube-video.ts";
import { youtubeCaptionFileName, youtubeCaptionNoPlanMarkerPath, type YoutubeCaptionNoPlanMarker } from "./lib/diaria/youtube-captions.ts";
import { applyProperNounLexicon, properNounLexicon, summarizeLexiconChanges } from "./lib/diaria/video-caption-lexicon.ts";
import {
  checkedSnapshotFrom,
  factCheckFontesSha256,
  factCheckItemHash,
  factCheckItems,
  factCheckItemsSha256,
  factCheckSection,
  mergeVideoFactCheck,
  parseVideoFactCheck,
  planVideoFactCheck,
  type FactCheckItem,
  type VideoFactClaim,
} from "./lib/diaria/video-fact-check.ts";
import { decupagemGate, decupagemGateBanner, decupagemTakeLines } from "./lib/diaria/video-decupagem-gate.ts";
import { decideTakes } from "./lib/diaria/video-montage.ts";
import { SHORT_WORD_WINDOW_PAD_S, shortWordDivergences, shortWordSection, type ShortWordItemCheck } from "./lib/diaria/video-short-words.ts";
import { stretchedWordFindings, takeRepeatItems, takeRepeatLine, takeRepeatWarnings, windowHeardSuspects, type TakeRepeatSuspect } from "./lib/diaria/video-montage-repeat.ts";
import { corteHookLine } from "./lib/diaria/extra-verticals.ts";
import { FACE_CACHE_FILE, emptyFaceCache, parseFaceCache, runFaceMeasurement, type FaceFrameRequest, type FaceItem, type FaceSampling } from "./lib/diaria/video-face-incremental.ts";
import { DECUPAGEM_SEGMENTS_FILE, freezeListing, listingSegments, resolveCollapsedListing, retranscribeKey, subWindowFileName, windowFileName, type ListingOrigin } from "./lib/diaria/video-decupagem-collapsed.ts";
import { captionCoverageFindings, speechWithoutWords, speechWithoutWordsWarnings } from "./lib/diaria/video-caption-coverage.ts";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PY_HELPER = join(ROOT, "scripts", "video", "transcribe_words.py");
/** #13372: 2º leitor do XML no verify-xml (OpenTimelineIO, opcional). */
const OTIO_PY = join(ROOT, "scripts", "video", "otio_read_xml.py");
const VOCAB_FILE = join(ROOT, "context", "video-montagem", "vocabulario.json");
export { DEFAULT_DRIVE_ROOT };

const USAGE = `uso: npx tsx scripts/video-montagem.ts <transcribe|inventory|decupagem|blocks|retranscribe|frame|face|face-compare|gaze|roteiro|fact-check-input|fact-check-merge|build|verify-xml|srt|preview|review|review-final|upload|legendar> AAMMDD [opções]
  ver o cabeçalho de scripts/video-montagem.ts e .claude/skills/diaria-video-montagem/SKILL.md`;

interface Ctx {
  edition: string;
  stateDir: string;
  workDir: string;
  driveDir: string;
  outDir: string;
  python: string;
  force: boolean;
  /** #12078: `--retranscribe` descarta a transcrição em cache do export (`review-final`, `srt --from-final`). */
  retranscribe?: boolean;
  /** #11639: como a pasta da edição é alcançada (Drive for desktop ou API); ver `driveModeFor`. */
  mode: "local" | "api";
  /** #11641: raiz do bruto no XML (`--xml-media-root`); ver `xmlMediaPath`. */
  xmlMediaRoot?: string;
  /** #11653: raiz do Drive no Neo pedida por `--drive-root`/`DIARIA_VIDEO_DRIVE_ROOT` (só no modo local); vai para o XML. */
  driveRoot?: string;
  /** #12707: a raiz do Neo trocada pela do Mac em todo `pathurl` (`--premiere-root`/`publishing.video.premiere_root`); ausente = caminho do Neo. */
  premierePaths?: PremierePathMap;
  /**
   * #13334: sessão OAuth do modo local com raiz explícita fora do Drive for desktop
   * (`localDriveUploadFor`): sobe as saídas de build/srt/preview e busca a vinheta
   * em `_marca/` no Drive. Nunca lê o bruto pela API (isso é só do modo API).
   */
  localDrive?: DriveSession;
  /** #13334: os caminhos do XML (raiz do Neo/explícita, antes da troca pelo Mac) que o último build gravou. */
  buildXmlFiles?: string[];
  /** #13493: os trechos do XML leve que o último build gravou (nome e tamanho no disco), conferidos na nuvem antes do XML ser dado por pronto. */
  buildTrechos?: { name: string; size: number }[];
  /** #13437: `--trecho-fonte` (CHAVE → caminho do export do vídeo de origem de um trecho inserido). */
  trechoFontes?: Record<string, string>;
  /** #13437: a raiz da pasta de vídeo NESTA máquina, onde o export do vídeo de origem é procurado; `null` = sem Drive local (modo API). */
  trechoDriveRoot?: string | null;
  /** #13610: `--no-archive` desliga a ida da versão anterior para `{AAMMDD}/arquivo/`. */
  noArchive?: boolean;
  /** #13610: o que o `upload` acabou de subir (entra na listagem do arquivamento mesmo com a busca do Drive atrasada). */
  freshUploads?: ArchiveEntry[];
}

/** As saídas deste comando sobem para a pasta da edição no Drive (modo API, ou local com `localDrive`, #13334). */
const uploadsToDrive = (ctx: Pick<Ctx, "mode" | "localDrive">) => ctx.mode === "api" || ctx.localDrive !== undefined;

const f = (ctx: Pick<Ctx, "stateDir">, name: string) => join(ctx.stateDir, name);

function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) throw new Error(missingWorkFileMessage(path, what));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** #13404: o `stateDir` da execução em curso; `--restore-conflict NOME` só alcança arquivos dele. */
let activeStateDir: string | undefined;

/** A flag que restauraria `path`, ou nada se ele não está no `stateDir` (a flag não o alcança). */
function restoreFlagFor(path: string, stateDir: string | undefined): string | undefined {
  return stateDir !== undefined && resolve(dirname(path)) === resolve(stateDir) ? `--restore-conflict ${basename(path)}` : undefined;
}

/**
 * #13404: "{what} ausente: {path}" e, se o sync de `data/` deixou cópias de
 * conflito no lugar (`blocks.json.conflictN`), a mais nova e o comando para
 * restaurá-la. Não restaura: a cópia certa é o editor quem confere
 * (`--restore-conflict {nome}` copia a mesma que a mensagem mostra, quando ele pede).
 */
export function missingWorkFileMessage(path: string, what: string, fs?: ConflictCopyFs, stateDir: string | undefined = activeStateDir): string {
  const hint = missingFileConflictHint(path, chooseConflictCopy(path, fs), restoreFlagFor(path, stateDir));
  return [`${what} ausente: ${path}`, ...hint].join("\n  ");
}

/**
 * #13404: arquivo de trabalho OPCIONAL (lido só se existir) que sumiu no sync:
 * o comando segue como se ele não existisse, então avisar em vez de calar.
 */
export function warnConflictOnly(path: string, log: (line: string) => void = (l) => console.error(l), fs?: ConflictCopyFs, stateDir: string | undefined = activeStateDir): void {
  if ((fs?.exists ?? existsSync)(path)) return;
  const hint = missingFileConflictHint(path, chooseConflictCopy(path, fs), restoreFlagFor(path, stateDir));
  if (hint.length) log(`[aviso] ${basename(path)} ausente, seguindo sem ele: ${hint.join("; ")}`);
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(data, null, 2) + "\n");
}

const mtime = (p: string) => statSync(p).mtimeMs;

/** Processo filho síncrono; falha vira erro com o fim do stderr. */
function run(cmd: string, args: string[], opts: SpawnSyncOptions & { inheritStderr?: boolean } = {}): { stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", opts.inheritStderr ? "inherit" : "pipe"],
    ...opts,
  });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  const stderr = String(r.stderr ?? "");
  if (r.status !== 0) throw new Error(`${cmd} saiu ${r.status}: ${stderr.trim().split(/\r?\n/).slice(-8).join(" | ")}`);
  return { stdout: String(r.stdout ?? ""), stderr };
}

/**
 * #13507: decode do bruto pela GPU (`-hwaccel cuda`) com queda para a CPU e
 * `[aviso]` uma vez por execução (`lib/diaria/video-hwaccel.ts`).
 * `DIARIA_VIDEO_HWACCEL=0` desliga.
 */
const hwDecode = createHwDecoder({
  listHwaccels: () => run("ffmpeg", ["-hide_banner", "-hwaccels"]).stdout,
  warn: (line) => console.error(line),
});

/** Um ffmpeg que decodifica o bruto, pela GPU quando der (#13507). */
function runDecode(args: string[], what: string, opts: { all?: boolean } = {}): "cuda" | "cpu" {
  return hwDecode.run(args, (a) => { run("ffmpeg", a); }, what, opts);
}

interface Vocab {
  whisper_prompt?: string;
  rules: VocabRule[];
  aliases: VocabAlias[];
}

export function loadVocab(path = VOCAB_FILE): Vocab {
  const v = readJson<Partial<Vocab>>(path, "vocabulário das legendas");
  const errors = validateVocabRules(v.rules ?? [], "vocabulario.json rules");
  if (v.aliases !== undefined && (!Array.isArray(v.aliases) || v.aliases.some((a) => typeof a?.heard !== "string" || typeof a?.written !== "string"))) {
    errors.push("vocabulario.json aliases: cada item precisa de heard e written");
  }
  if (errors.length) throw new Error(errors.join("; "));
  warnVocabOnce(vocabRuleWarnings(v.rules ?? [], "vocabulario.json rules"));
  return { whisper_prompt: v.whisper_prompt, rules: v.rules ?? [], aliases: v.aliases ?? [] };
}

/** `[aviso]` de vocabulário uma vez por execução (as regras são carregadas várias vezes por comando, #13413). */
const vocabWarned = new Set<string>();
function warnVocabOnce(warnings: string[]): void {
  for (const w of warnings) {
    if (vocabWarned.has(w)) continue;
    vocabWarned.add(w);
    console.error(`[aviso] ${w}`);
  }
}

function transcribeWithPython(ctx: Ctx, audio: string, out: string, opts: { vad: boolean; noCondition?: boolean }): void {
  const vocab = loadVocab();
  console.error(`[video-montagem] transcrevendo ${audio} (faster-whisper large-v3-turbo, GPU com queda para CPU, #13477; leva minutos)…`);
  const args = ["-P", PY_HELPER, audio, out, "--initial-prompt", vocab.whisper_prompt ?? ""];
  if (opts.vad) args.push("--vad");
  if (opts.noCondition) args.push("--no-condition");
  run(ctx.python, args, { env: { ...process.env, HF_HUB_OFFLINE: "1" }, inheritStderr: true });
}

function nonEmptyWords(path: string, what: string): Word[] {
  const words = transcriptWords(readJson<Transcript>(path, what));
  if (words.length === 0) throw new Error(`${what} sem nenhuma palavra (${path}): áudio mudo ou transcrição falhou; refazer com --force`);
  return words;
}

/** O platform.config.json, ou `null` ilegível (com aviso): o `premiere_root` some e o XML sai com a raiz do Neo (#12707). */
function readPlatformConfigSafe(): unknown {
  try {
    return JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  } catch (e) {
    console.error(`[aviso] platform.config.json ilegível (${(e as Error).message}): sem publishing.video.premiere_root, XML com a raiz do Neo (#12707)`);
    return null;
  }
}

/** `publishing.video.mirrored_default` do config (#11959); config ilegível = `null` (vale o default do código, com aviso). */
function configMirroredDefault(): boolean | null {
  try {
    return mirroredDefaultFrom(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")));
  } catch (e) {
    console.error(`[aviso] platform.config.json ilegível (${(e as Error).message}): espelhamento pelo default do código (#11959)`);
    return null;
  }
}

/** `publishing.video.cta_card_s` do config (#13311); config ilegível ou valor inválido = o default do código, com aviso. */
let ctaCardSCache: number | null = null;
function configCtaCardS(): number {
  if (ctaCardSCache !== null) return ctaCardSCache;
  try {
    ctaCardSCache = ctaCardDurationFrom(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")), (m) => console.error(`[aviso] ${m}`));
  } catch (e) {
    console.error(`[aviso] platform.config.json ilegível (${(e as Error).message}): card de CTA com o default de ${CTA_CARD.durationS} s (#13311)`);
    ctaCardSCache = CTA_CARD.durationS;
  }
  return ctaCardSCache;
}

/**
 * A vinheta do logo (#12101): `publishing.video.vinheta_logo.path` do config,
 * medida pelo ffprobe. Nunca barra o build nem a prévia: config sem caminho,
 * arquivo ausente nesta máquina ou probe falho = sem vinheta, com `[aviso]`.
 */
export function loadVinheta(deps: { readConfig?: () => unknown; exists?: (p: string) => boolean; probe?: (p: string) => string; warn?: (m: string) => void } = {}): VinhetaAsset | null {
  const warn = deps.warn ?? ((m: string) => console.error(`[aviso] ${m}`));
  let config: unknown;
  try {
    config = deps.readConfig ? deps.readConfig() : JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  } catch (e) {
    warn(`platform.config.json ilegível (${(e as Error).message}): sem vinheta do logo (#12101)`);
    return null;
  }
  const cfg = vinhetaConfigFrom(config);
  if (!cfg) {
    warn("sem publishing.video.vinheta_logo.path no platform.config.json: XML sem a vinheta do logo, inserir à mão no Premiere (#12101)");
    return null;
  }
  if (!(deps.exists ?? existsSync)(cfg.path)) {
    warn(`vinheta do logo não encontrada em ${cfg.path}: XML sem a vinheta, inserir à mão no Premiere; exporte o MOV (ProRes 4444 com alpha) para esse caminho (#12101)`);
    return null;
  }
  try {
    const probe = deps.probe ?? ((p: string) => run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", p]).stdout);
    return parseVinhetaProbe(probe(cfg.path), cfg.path);
  } catch (e) {
    warn(`vinheta do logo ilegível (${cfg.path}: ${(e as Error).message}): XML sem a vinheta (#12101)`);
    return null;
  }
}

/** Resolve no Drive para medir/renderizar no cache, preservando o caminho do Neo no XML. */
export async function loadVinhetaForDrive(
  drive: DriveSession | null,
  deps: Parameters<typeof loadVinheta>[0] = {},
): Promise<(VinhetaAsset & { localPath?: string }) | null> {
  if (!drive) return loadVinheta(deps);
  const warn = deps.warn ?? ((m: string) => console.error(`[aviso] ${m}`));
  try {
    const config = deps.readConfig ? deps.readConfig() : JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    const cfg = vinhetaConfigFrom(config);
    if (!cfg) return loadVinheta({ ...deps, readConfig: () => config });
    const cachedPath = await fetchMarcaFile(drive, vinhetaFileName(cfg.path), join(drive.cacheDir, "_marca"));
    const asset = loadVinheta({ ...deps, readConfig: () => config, exists: () => true, probe: () => deps.probe ? deps.probe(cachedPath) : run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", cachedPath]).stdout });
    return asset ? { ...asset, localPath: cachedPath } : null;
  } catch (e) {
    warn(`vinheta do logo no Drive: ${(e as Error).message}: XML/prévia sem a vinheta (#12232)`);
    return null;
  }
}

/** O nome do MOV da vinheta, do caminho do config (Windows ou POSIX). */
const vinhetaFileName = (configPath: string) => toPosix(configPath).split("/").pop()!;

/** Baixa `name` da pasta compartilhada `_marca/` do Drive para `destDir` (cache conferido por id/modifiedTime/tamanho). */
async function fetchMarcaFile(drive: DriveSession, name: string, destDir: string): Promise<string> {
  const root = drive.rootFolderId?.();
  if (!root) throw new Error("pasta raiz YouTube indisponível");
  const folders = await listChildren(drive.deps, root, { name: "_marca", foldersOnly: true });
  if (folders.length !== 1) throw new Error(`${folders.length} pastas _marca/ no Drive; esperada exatamente uma`);
  const found = await findByName(drive.deps, folders[0].id, name);
  if (!found.file || found.duplicates) throw new Error(`arquivo ${name} ausente ou duplicado em _marca/`);
  return (await ensureCachedFile(drive.deps, found.file, destDir, log)).localPath;
}

/**
 * #13308: a vinheta no modo local com raiz explícita (`--drive-root`/
 * `DIARIA_VIDEO_DRIVE_ROOT`, o 300 em `/mnt/hd-sata/.../local-root`). O caminho
 * do config é o do Neo (`I:`), que aqui não existe; a vinheta mora em
 * `{raiz}/_marca/{nome}`, como o bruto, o título e o card moram na mesma raiz.
 * Ordem: `{raiz}/_marca/`, o caminho do config, e por fim a `_marca/` do Drive
 * baixada para `{raiz}/_marca/` (com `drive`, a sessão OAuth do modo local).
 * O `path` do asset é o da raiz explícita: o `premiere_root` o troca pelo do Mac
 * no XML, como os demais arquivos da raiz.
 */
export async function loadVinhetaForLocalRoot(
  root: string,
  drive: DriveSession | null,
  deps: Parameters<typeof loadVinheta>[0] = {},
): Promise<VinhetaAsset | null> {
  const warn = deps.warn ?? ((m: string) => console.error(`[aviso] ${m}`));
  const exists = deps.exists ?? existsSync;
  let config: unknown;
  try {
    config = deps.readConfig ? deps.readConfig() : JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  } catch (e) {
    warn(`platform.config.json ilegível (${(e as Error).message}): sem vinheta do logo (#12101)`);
    return null;
  }
  const cfg = vinhetaConfigFrom(config);
  if (!cfg) return loadVinheta({ ...deps, readConfig: () => config });
  const name = vinhetaFileName(cfg.path);
  const marcaDir = `${toPosix(root).replace(/\/+$/, "")}/_marca`;
  const atRoot = `${marcaDir}/${name}`;
  const at = (path: string, extra: Partial<Parameters<typeof loadVinheta>[0]> = {}) =>
    loadVinheta({ ...deps, ...extra, readConfig: () => ({ publishing: { video: { vinheta_logo: { path } } } }) });
  if (exists(atRoot)) return at(atRoot);
  if (exists(cfg.path)) return at(cfg.path);
  if (drive) {
    try {
      log(`[drive] vinheta ${name} ausente em ${marcaDir}/ e em ${cfg.path}: baixando da _marca/ do Drive (#13308)`);
      const got = await fetchMarcaFile(drive, name, marcaDir);
      return at(toPosix(got), { exists: () => true });
    } catch (e) {
      warn(`vinheta do logo no Drive: ${(e as Error).message}: XML/prévia sem a vinheta; copie o MOV para ${atRoot} (#13308)`);
      return null;
    }
  }
  warn(`vinheta do logo não encontrada em ${atRoot} nem em ${cfg.path} (sem credenciais OAuth para baixar da _marca/ do Drive): XML sem a vinheta, inserir à mão no Premiere; copie o MOV para ${atRoot} (#13308)`);
  return null;
}

/** O que falta quando o som da vinheta não entra no `build` (fim do `[aviso]`, #13240). */
export const SFX_BUILD_CONSEQUENCE = "XML sem o som a cada ponto da vinheta, inserir à mão no Premiere";
/** O mesmo na prévia, que só reproduz o que o XML já tem (#13240). */
export const SFX_PREVIEW_CONSEQUENCE = "prévia sem o som (o XML tem)";

/**
 * Dependências dos loaders do som da vinheta (#13240): as da vinheta, mais
 * `probePath` (mede outro arquivo, o cache, e mantém o caminho do config no
 * `path`), `consequence` (o fim do `[aviso]`; default o do `build`) e
 * `onAbsent` (o motivo, sem a consequência, quando o som CONFIGURADO não entra:
 * vai para o `plan.json`).
 */
export type SfxLoadDeps = Parameters<typeof loadVinheta>[0] & {
  probePath?: string;
  consequence?: string;
  onAbsent?: (reason: string) => void;
};

function sfxReporter(deps: SfxLoadDeps) {
  const warn = deps.warn ?? ((m: string) => console.error(`[aviso] ${m}`));
  const consequence = deps.consequence ?? SFX_BUILD_CONSEQUENCE;
  return {
    warn,
    /** Som configurado que não entra: avisa com a consequência e registra o motivo. */
    absent: (reason: string): null => {
      deps.onAbsent?.(reason);
      warn(`${reason}: ${consequence} (#13240)`);
      return null;
    },
  };
}

/**
 * Lê e confere `vinheta_som` (#13240): um `[aviso]` por item de `at_s`
 * descartado; chave ausente = aviso "sem config" (sem `onAbsent`: nada foi
 * configurado); chave presente e inutilizável = aviso que diz isso.
 */
function readSfxConfig(deps: SfxLoadDeps): { path: string; atS: number[] } | null {
  const r = sfxReporter(deps);
  let config: unknown;
  try {
    config = deps.readConfig ? deps.readConfig() : JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  } catch (e) {
    return r.absent(`platform.config.json ilegível (${(e as Error).message})`);
  }
  const check = vinhetaSfxConfigCheck(config);
  for (const p of check.problems) r.warn(p);
  if (!check.present) {
    r.warn(`sem publishing.video.vinheta_som (path e at_s) no platform.config.json: ${deps.consequence ?? SFX_BUILD_CONSEQUENCE} (#13240)`);
    return null;
  }
  return check.cfg ?? r.absent("publishing.video.vinheta_som configurado, mas sem path ou sem instante válido em at_s");
}

/** O config só com o efeito já conferido: os wrappers repassam por aqui, sem repetir os avisos de `at_s`. */
const sfxConfigOf = (path: string, atS: number[]) => ({ publishing: { video: { vinheta_som: { path, at_s: atS } } } });

/**
 * #13240: o efeito sonoro a cada "." do logo (`publishing.video.vinheta_som`),
 * medido pelo ffprobe. Como a vinheta, nunca barra o build nem a prévia: config
 * sem caminho ou sem instante, arquivo ausente ou probe falho = sem o efeito,
 * com `[aviso]`.
 */
export function loadVinhetaSfx(deps: SfxLoadDeps = {}): VinhetaSfx | null {
  const r = sfxReporter(deps);
  const cfg = readSfxConfig(deps);
  if (!cfg) return null;
  const local = deps.probePath ?? cfg.path;
  if (!(deps.exists ?? existsSync)(local)) return r.absent(`som da vinheta não encontrado em ${local}`);
  try {
    const probe = deps.probe ?? ((p: string) => run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", p]).stdout);
    return parseVinhetaSfxProbe(probe(local), cfg.path, cfg.atS);
  } catch (e) {
    return r.absent(`som da vinheta ilegível (${local}: ${(e as Error).message})`);
  }
}

/**
 * #13240: o registro do som ausente numa sequência (`xmlAssets.{seq}.vinhetaSfx`
 * do plan.json): o motivo do build inteiro (arquivo, config, sem vinheta) vence
 * o da sequência (nenhum instante coube). Nenhum motivo = objeto vazio.
 */
export function vinhetaSfxAbsentFor(global: string | null, bySeq: Readonly<Record<string, string>>, key: string): { vinhetaSfx?: { ausente: string } } {
  const why = global ?? bySeq[key];
  return why ? { vinhetaSfx: { ausente: why } } : {};
}

/**
 * #13240: a prévia com a vinheta, primeiro com o som. Se ela falha e há som,
 * tenta sem ele; só se ESSA passar o som leva a culpa (`[aviso]` com o erro
 * da 1ª). Se a 2ª também falhar, o erro dela sobe (o chamador refaz sem a
 * vinheta) e a 1ª mensagem não é registrada como causa.
 */
export function runWithSfxFallback(attempt: (withSfx: boolean) => void, hasSfx: boolean, warn: (m: string) => void): void {
  try {
    attempt(hasSfx);
    return;
  } catch (first) {
    if (!hasSfx) throw first;
    attempt(false);
    warn(`[aviso] misturar o som da vinheta na prévia falhou (${(first as Error).message.split("\n")[0]}): ${SFX_PREVIEW_CONSEQUENCE} (#13240)`);
  }
}

/** Instante relativo à vinheta, como o editor o lê ("+0,100 s"). */
const fmtSfxAt = (t: number) => `+${t.toFixed(3).replace(".", ",")} s`;

/** #13240: o `[aviso]` do `build` quando o som está configurado e a vinheta não entrou (o som sem a vinheta não tem onde ancorar). */
export function vinhetaSfxSemVinhetaAviso(atS: readonly number[]): string {
  return `[aviso] sem a vinheta, o som de tecla (${atS.map(fmtSfxAt).join(" e ")} do início dela) também ficou fora: inserir ${atS.length === 2 ? "os dois" : "a vinheta e o som"} à mão no Premiere (#13240)`;
}

/** #13240: `[aviso]` de uma sequência em que nem todo instante do som entrou (fora da sequência ou no mesmo quadro de outro); null = todos entraram. */
export function vinhetaSfxPlacedAviso(placed: number, configured: number): string | null {
  return placed < configured ? `[aviso] ${configured - placed} de ${configured} instantes do som da vinheta fora da sequência ou no mesmo quadro (#13240)` : null;
}

/**
 * #13240: a `[premissa]` do `build` sobre o som da vinheta, uma vez por build.
 * Desde o PR #13246 ela pedia para conferir se o som a cada ponto tinha
 * SUMIDO; desde 17/11/2026 (#13240) o som é de propósito, e o que falta
 * conferir é se ele toca em cada ponto. Conta os instantes de fato colocados
 * em cada sequência (`vinhetaSfxFrames`); nenhum colocado = null (sem premissa).
 */
export function vinhetaSfxPremissa(placed: ReadonlyArray<{ name: string; n: number }>): string | null {
  const ok = placed.filter((p) => p.n > 0);
  if (!ok.length) return null;
  const counts = [...new Set(ok.map((p) => p.n))];
  const where = counts.length === 1
    ? `nos ${counts[0]} ponto${counts[0] === 1 ? "" : "s"}`
    : `nos pontos colocados (${ok.map((p) => `${p.n} em ${p.name}`).join(", ")})`;
  return `[premissa] o som de tecla em cada ponto da vinheta é intencional (decisão do editor de 17/11/2026, #13240): conferir no 1º import se ele toca ${where}`;
}

/** #13240: o efeito da vinheta resolvido no Drive (cache local para medir e para a prévia), com o caminho do config no XML. */
export async function loadVinhetaSfxForDrive(
  drive: DriveSession | null,
  deps: SfxLoadDeps = {},
): Promise<(VinhetaSfx & { localPath?: string }) | null> {
  if (!drive) return loadVinhetaSfx(deps);
  const r = sfxReporter(deps);
  const cfg = readSfxConfig(deps);
  if (!cfg) return null;
  try {
    const cachedPath = await fetchMarcaFile(drive, vinhetaFileName(cfg.path), join(drive.cacheDir, "_marca"));
    const sfx = loadVinhetaSfx({ ...deps, readConfig: () => sfxConfigOf(cfg.path, cfg.atS), exists: () => true, probePath: cachedPath });
    return sfx ? { ...sfx, localPath: cachedPath } : null;
  } catch (e) {
    return r.absent(`som da vinheta no Drive: ${(e as Error).message}`);
  }
}

/** #13240: o efeito da vinheta no modo local com raiz explícita, na mesma ordem da vinheta (#13308): `{raiz}/_marca/`, o config, a `_marca/` do Drive. */
export async function loadVinhetaSfxForLocalRoot(
  root: string,
  drive: DriveSession | null,
  deps: SfxLoadDeps = {},
): Promise<VinhetaSfx | null> {
  const r = sfxReporter(deps);
  const exists = deps.exists ?? existsSync;
  const cfg = readSfxConfig(deps);
  if (!cfg) return null;
  const name = vinhetaFileName(cfg.path);
  const marcaDir = `${toPosix(root).replace(/\/+$/, "")}/_marca`;
  const atRoot = `${marcaDir}/${name}`;
  const at = (path: string, extra: Partial<SfxLoadDeps> = {}) => loadVinhetaSfx({ ...deps, ...extra, readConfig: () => sfxConfigOf(path, cfg.atS) });
  if (exists(atRoot)) return at(atRoot);
  if (exists(cfg.path)) return at(cfg.path);
  if (drive) {
    try {
      log(`[drive] som da vinheta ${name} ausente em ${marcaDir}/ e em ${cfg.path}: baixando da _marca/ do Drive (#13240)`);
      const got = await fetchMarcaFile(drive, name, marcaDir);
      return at(toPosix(got), { exists: () => true });
    } catch (e) {
      return r.absent(`som da vinheta no Drive: ${(e as Error).message}; copie o arquivo para ${atRoot}`);
    }
  }
  return r.absent(`som da vinheta não encontrado em ${atRoot} nem em ${cfg.path} (sem credenciais OAuth para baixar da _marca/ do Drive); copie o arquivo para ${atRoot}`);
}

/**
 * Chave curta da faixa tratada (#12102): hash dos args do ffmpeg (filtro +
 * formato de saída, sem os caminhos). Vai no nome do arquivo: mudar o
 * tratamento grava um WAV novo em vez de sobrescrever o que um projeto do
 * Premiere aberto pode estar usando. Desde o #13544 o tamanho do áudio de
 * entrada (`srcBytes`) também entra: na 261118 o 2º bruto juntado regravou a
 * faixa com o MESMO nome (992 s para 1186 s), e no Mac a cópia offline velha,
 * mais curta que o in/out dos clipes novos, fez o Premiere não importar nada.
 * Entrada de outro tamanho = WAV novo; o que um XML anterior aponta fica.
 */
export function cleanAudioKey(filter: string, srcBytes?: number): string {
  const args = audioCleanArgs({ src: "<bruto>", out: "<faixa>", filter });
  return createHash("sha256").update(JSON.stringify(srcBytes === undefined ? args : { args, srcBytes })).digest("hex").slice(0, 8);
}

/** Nome da faixa de áudio tratada na pasta da edição (#12102). */
export function cleanAudioFileName(edition: string, key: string): string {
  return `${edition}_audio_tratado-${key}.wav`;
}

/** O caminho da faixa tratada no XML: ao lado do bruto, como o PNG do título (#12102). */
export function cleanAudioXmlPath(mediaPath: string, edition: string, key: string): string {
  const p = mediaPath.replace(/\\/g, "/");
  return `${p.slice(0, p.lastIndexOf("/") + 1)}${cleanAudioFileName(edition, key)}`;
}

export interface TreatedAudio {
  /** Local (a prévia lê daqui). */
  path: string;
  /** No XML (ao lado do bruto no Neo). */
  xmlPath: string;
  /** O `-af` do ffmpeg, ou o descritor do DeepFilterNet (`deepFilterDescriptor`, #13234). */
  filter: string;
  /** Motor que de fato gerou a faixa (#13234); ausente em build anterior = `ffmpeg`. */
  engine?: AudioDenoiseEngine;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Renderiza a faixa de áudio tratada (#12102) em `outDir`, reaproveitando a
 * do build anterior quando o bruto (caminho, tamanho, mtime) e os args do
 * ffmpeg são os mesmos (`audio-tratado.meta.json` no state dir). O ffmpeg
 * grava num `.part` (o snapshot do upload ignora) e renomeia no fim.
 *  - ffmpeg ausente ou falho = `null` com `[aviso]` (o XML segue com o áudio cru), sem `.part` sobrando;
 *  - o rename falha (WAV aberto no Premiere, EPERM/EBUSY): tenta 3 vezes e LANÇA, pedindo para fechar o projeto (o build para; o XML não cai para o cru em silêncio);
 *  - a meta não grava: `[aviso]`, e a faixa vale (só não é reaproveitada no próximo build).
 */
export function renderCleanAudio(
  input: { src: string; outDir: string; stateDir: string; edition: string; mediaPath: string; thresholdDb: number; denoise?: AudioDenoiseChoice },
  deps: {
    ffmpeg?: (args: string[]) => void;
    /** #13234: o `deep-filter` (args de `deepFilterArgs`). */
    deepFilter?: (args: string[]) => void;
    /** #13234: versão do `deep-filter` instalado; `null` = ausente (cai no ffmpeg). */
    deepFilterVersion?: () => string | null;
    rename?: (from: string, to: string) => void;
    writeMeta?: (path: string, text: string) => void;
    warn?: (m: string) => void;
    info?: (m: string) => void;
    debug?: (m: string) => void;
    retryMs?: number;
  } = {},
): (TreatedAudio & { reused: boolean }) | null {
  const warn = deps.warn ?? ((m: string) => console.error(`[aviso] ${m}`));
  const info = deps.info ?? ((m: string) => console.error(m));
  const debug = deps.debug ?? ((m: string) => console.error(`[debug] ${m}`));
  const ffmpeg = deps.ffmpeg ?? ((args: string[]) => run("ffmpeg", args));
  // #13234: DeepFilterNet pedido e instalado = o descritor dele no lugar do -af (entra no hash e na versão do XML).
  let engine: AudioDenoiseEngine = "ffmpeg";
  let filter = audioCleanFilter(audioCleanParams(input.thresholdDb));
  if (input.denoise?.engine === "deepfilternet") {
    const bin = deepFilterBin(process.env.DIARIA_DEEP_FILTER);
    const version = (deps.deepFilterVersion ?? (() => defaultDeepFilterVersion(bin, debug)))();
    if (version) {
      engine = "deepfilternet";
      filter = deepFilterDescriptor(version, input.denoise.attenDb);
    } else {
      warn(`DeepFilterNet (${bin}) não encontrado: a faixa tratada sai no ffmpeg (afftdn + agate); instalar: docs/setup.md, seção "Vídeo: montagem" (#13234)`);
    }
  }
  let st: { size: number; mtimeMs: number } | null = null;
  try {
    st = statSync(input.src);
  } catch (e) {
    debug(`faixa tratada: bruto sem stat (${(e as Error).message}); o render abaixo decide`);
  }
  // #13544: o tamanho da entrada no nome (2º bruto juntado = faixa nova, nunca a velha regravada).
  const key = cleanAudioKey(filter, st?.size);
  const out = join(input.outDir, cleanAudioFileName(input.edition, key));
  const xmlPath = cleanAudioXmlPath(input.mediaPath, input.edition, key);
  const metaPath = join(input.stateDir, "audio-tratado.meta.json");
  const id: { src: string; size: number; mtimeMs: number; out: string; args: string[] } | null = st
    ? { src: input.src, size: st.size, mtimeMs: Math.round(st.mtimeMs), out: basename(out), args: audioCleanArgs({ src: "<bruto>", out: "<faixa>", filter }) }
    : null;
  if (id && existsSync(out) && existsSync(metaPath)) {
    try {
      if (JSON.stringify(JSON.parse(readFileSync(metaPath, "utf8"))) === JSON.stringify(id)) {
        info(`[video-montagem] faixa de áudio tratada reaproveitada: ${out} (#12102)`);
        return { path: out, xmlPath, filter, engine, reused: true };
      }
    } catch (e) {
      debug(`faixa tratada: ${metaPath} ilegível (${(e as Error).message}); renderiza de novo`);
    }
  }
  if (existsSync(out)) info(`[video-montagem] faixa de áudio tratada ${out} sobrescrita (o bruto mudou desde o render anterior, #12102)`);
  const part = `${out}.part`;
  try {
    mkdirSync(input.outDir, { recursive: true });
    if (engine === "deepfilternet") {
      try {
        renderDeepFilter({ src: input.src, part, tmpDir: join(input.stateDir, "deepfilter-tmp"), attenDb: input.denoise?.attenDb ?? null }, { ffmpeg, deepFilter: deps.deepFilter });
      } catch (e) {
        rmSync(part, { force: true });
        // #13234: o modelo falhou; o ffmpeg ainda trata melhor que o áudio cru.
        warn(`DeepFilterNet falhou (${(e as Error).message}): a faixa tratada sai no ffmpeg (afftdn + agate) (#13234)`);
        return renderCleanAudio({ ...input, denoise: undefined }, deps);
      }
    } else {
      ffmpeg(audioCleanArgs({ src: input.src, out: part, filter }));
    }
  } catch (e) {
    rmSync(part, { force: true });
    warn(`faixa de áudio tratada não renderizada (${(e as Error).message}): o XML e a prévia seguem com o áudio cru do bruto; aplicar o Enhance no Premiere (#12102)`);
    return null;
  }
  const rename = deps.rename ?? renameSync;
  for (let attempt = 1; ; attempt++) {
    try {
      rename(part, out);
      break;
    } catch (e) {
      if (attempt >= 3) {
        rmSync(part, { force: true });
        throw new Error(`não consegui gravar ${out} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}): o WAV deve estar aberto no Premiere; feche o projeto e rode build de novo (#12102)`);
      }
      sleepSync(deps.retryMs ?? 500);
    }
  }
  if (id) {
    try {
      mkdirSync(input.stateDir, { recursive: true });
      (deps.writeMeta ?? ((p: string, t: string) => writeFileSync(p, t)))(metaPath, JSON.stringify(id, null, 2) + "\n");
    } catch (e) {
      warn(`${metaPath} não gravado (${(e as Error).message}): a faixa tratada vale, só não será reaproveitada no próximo build (#12102)`);
    }
  }
  return { path: out, xmlPath, filter, engine, reused: false };
}

/** #13234: versão do `deep-filter` (`--version`); ausente ou sem número = `null`. */
function defaultDeepFilterVersion(bin: string, debug: (m: string) => void): string | null {
  try {
    const r = run(bin, ["--version"]);
    return parseDeepFilterVersion(`${r.stdout}\n${r.stderr}`);
  } catch (e) {
    debug(`deep-filter --version: ${(e as Error).message}`);
    return null;
  }
}

/**
 * #13234: a faixa tratada pelo DeepFilterNet, gravada em `part`: o áudio do
 * bruto em WAV mono 48 kHz (`deepFilterInputArgs`), o `deep-filter` com
 * `--compensate-delay` (sem o atraso do STFT e do lookahead do modelo, a faixa
 * fica na mesma linha do tempo do vídeo) e o WAV de saída convertido para o
 * formato da faixa (PCM 16 bits mono 48 kHz, o mesmo do ffmpeg). O temporário
 * fica no state dir (fora do out dir, que o snapshot do upload lê) e sai no
 * fim, com sucesso ou não. Qualquer falha LANÇA; quem chama cai no ffmpeg.
 */
export function renderDeepFilter(
  input: { src: string; part: string; tmpDir: string; attenDb: number | null },
  deps: { ffmpeg: (args: string[]) => void; deepFilter?: (args: string[]) => void },
): void {
  const deepFilter = deps.deepFilter ?? ((args: string[]) => void run(deepFilterBin(process.env.DIARIA_DEEP_FILTER), args));
  rmSync(input.tmpDir, { recursive: true, force: true });
  const outDir = join(input.tmpDir, "out");
  mkdirSync(outDir, { recursive: true });
  try {
    const wav = join(input.tmpDir, "in.wav");
    deps.ffmpeg(deepFilterInputArgs({ src: input.src, out: wav }));
    deepFilter(deepFilterArgs({ wav, outDir, attenDb: input.attenDb }));
    const enhanced = deepFilterOutputPath({ wav, outDir });
    if (!existsSync(enhanced)) throw new Error(`o deep-filter não gravou ${enhanced}`);
    deps.ffmpeg(["-y", "-v", "error", "-i", enhanced, "-ac", "1", "-ar", String(AUDIO_CLEAN.sampleRate), "-c:a", "pcm_s16le", "-f", "wav", input.part]);
  } finally {
    rmSync(input.tmpDir, { recursive: true, force: true });
  }
}

type Loudness = ReturnType<typeof parseLoudnormJson>;

/**
 * #12209: o loudness da faixa tratada, a que os clipes de áudio do XML tocam
 * (o redutor de ruído e o gate mudam o nível, então o do bruto não serve).
 * Cache em `audio-tratado.loudness.json` no state dir pela identidade do WAV
 * (nome, tamanho, mtime): faixa reaproveitada não é medida de novo. Erro do
 * ffmpeg propaga; quem chama decide o fallback (`gainLoudnessSource`).
 */
export function measureTreatedLoudness(
  input: { path: string; stateDir: string },
  deps: { measure?: (path: string) => string } = {},
): Loudness {
  const st = statSync(input.path);
  const id = { file: basename(input.path), size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  const cachePath = join(input.stateDir, "audio-tratado.loudness.json");
  if (existsSync(cachePath)) {
    try {
      const c = JSON.parse(readFileSync(cachePath, "utf8")) as { id?: unknown; loudness?: Loudness };
      if (JSON.stringify(c.id) === JSON.stringify(id) && c.loudness) return c.loudness;
    } catch {
      // cache ilegível: mede de novo
    }
  }
  const measure =
    deps.measure ??
    ((p: string) => run("ffmpeg", ["-hide_banner", "-nostats", "-i", p, "-map", "0:a:0", "-af", `${LOUDNORM_TARGET}:print_format=json`, "-f", "null", "-"]).stderr);
  const loudness = parseLoudnormJson(measure(input.path));
  if (loudness) {
    mkdirSync(input.stateDir, { recursive: true });
    writeFileAtomic(cachePath, JSON.stringify({ id, loudness }, null, 2) + "\n");
  }
  return loudness;
}

/**
 * #12209: de onde sai o loudness do ganho do XML. Com a faixa tratada no XML,
 * dela; se a medição dela falhou, do bruto, com `[aviso]` (o ganho calculado
 * sobre o bruto vai para a faixa tratada). Sem faixa tratada, do bruto.
 */
export function gainLoudnessSource(input: {
  treated: { loudness: Loudness; error?: string } | null;
  bruto: Loudness;
}): { loudness: Loudness; measuredOn: "bruto" | "faixa tratada"; warning?: string } {
  if (!input.treated) return { loudness: input.bruto, measuredOn: "bruto" };
  if (input.treated.loudness && Number.isFinite(input.treated.loudness.inputI)) return { loudness: input.treated.loudness, measuredOn: "faixa tratada" };
  const why = input.treated.error ?? "o loudnorm não imprimiu a medida";
  return {
    loudness: input.bruto,
    measuredOn: "bruto",
    warning: `loudness da faixa tratada não medido (${why}): o ganho do XML sai do loudness do bruto e vai para a faixa tratada (redução de ruído e gate mudam o nível); conferir o nível no 1º import (#12209)`,
  };
}

/**
 * #12209: o `build` com a faixa tratada (padrão, #12102) lê o bruto, que o
 * `transcribe` no modo API (o 300) não garante no cache: com a transcrição
 * pronta ele não baixa nada, e o cache pode ter sido limpo. Sem o bruto, o
 * ffmpeg falha e o XML cai para o áudio cru. No modo API o build garante o
 * bruto antes (`ensureBrutoLocal`); no local (I:) o bruto é o do Drive montado.
 */
export function buildNeedsLocalBruto(o: { apiMode: boolean; audioClean: boolean }): boolean {
  return o.apiMode && o.audioClean;
}

/**
 * Faixa tratada reaproveitada no modo API (#12102): não muda no out dir, então
 * o snapshot do upload não a vê. Se o `drive-uploads.json` não registra o
 * envio dela, entra nos pendentes (sobe no fim deste comando).
 */
export function queueUploadIfMissing(regPath: string, path: string, key = basename(path)): boolean {
  const reg = readRegistry(regPath);
  if (reg.files[key] || reg.pending.includes(path)) return false;
  writeJson(regPath, { ...reg, pending: [...reg.pending, path] });
  return true;
}

/**
 * Frame do bruto nas duas orientações, lado a lado (#11959): esquerda = o
 * bruto como gravado, direita = espelhado. A leitura da caneca e do pôster
 * decide o `mirrored` sem depender do palpite do `source.json` (na 261103 a
 * câmera traseira não espelhava e o frame desespelhado pareceu certo).
 */
function cmdFrameOrientations(ctx: Ctx, at: string | undefined): number {
  const t = Number(at);
  if (at === undefined || !Number.isFinite(t) || t < 0) throw new Error("frame exige --at SEGUNDOS");
  const measured = measuredSource(ctx);
  // Sem o aviso de cópia de conflito aqui: o `frame` roda o cmdFrame antes, que já o deu (#13404).
  const override = existsSync(f(ctx, "blocks.json")) ? loadBlocks(ctx).file.mirrored : undefined;
  const out = f(ctx, `frame-${t.toFixed(1)}-orientacoes.jpg`);
  const vf = "scale=960:-2,split[a][b];[b]hflip[m];[a][m]hstack=inputs=2,drawgrid=w=iw/20:h=ih/10:t=1:c=white@0.4";
  const at0 = frameAt(measured, t);
  runDecode(["-hide_banner", "-v", "error", "-y", "-ss", String(at0.localS), "-i", at0.view.path, "-frames:v", "1", "-filter_complex", vf, out], "frame");
  console.log(out);
  console.error("[video-montagem] lado a lado: esquerda = bruto como gravado, direita = espelhado; o lado em que a caneca e o pôster leem certo é a orientação real (#11959)");
  console.error(`[premissa] ${mirroredPremise(measured, override)} (#11959)`);
  return 0;
}

function measuredSource(ctx: Pick<Ctx, "stateDir">): SourceInfo {
  return checkedSource(readJson<SourceInfo>(f(ctx, "source.json"), "source.json (rode transcribe)"));
}

/** #12559: o `source.json` lido do disco, com os `files` conferidos (ids, offsets, duração); um arquivo só vira bruto único. */
function checkedSource(raw: SourceInfo): SourceInfo {
  const n = normalizeSourceFiles(raw);
  if (n.errors.length) throw new Error(`source.json inválido:\n  - ${n.errors.join("\n  - ")}`);
  return n.source;
}

/**
 * #12559: o arquivo do instante global `t` (bruto único = o próprio bruto em
 * `t`), como uma "vista" com o tamanho e o espelho dele, para frame/face/gaze.
 */
export function frameAt(source: SourceInfo, t: number): { multi: boolean; localS: number; view: { id: string; path: string; width: number; height: number; mirrored: boolean } } {
  if (!isMultiSource(source)) return { multi: false, localS: t, view: { id: sourceFiles(source)[0].id, path: source.path, width: source.width, height: source.height, mirrored: source.mirrored } };
  const loc = locateTime(source, t);
  return { multi: true, localS: loc.localS, view: { id: loc.file.id, path: loc.file.path, width: loc.file.width, height: loc.file.height, mirrored: loc.file.mirrored ?? source.mirrored } };
}

/** #12559: o áudio do bruto em vários arquivos, concatenado na linha do tempo global (48 kHz estéreo). */
export const MULTI_AUDIO_FILE = "bruto-audio-48k.wav";

/**
 * A entrada de áudio para as medições do bruto (detector de fala, banda alta,
 * faixa tratada): o próprio bruto, ou, no bruto em vários arquivos (#12559), o
 * áudio concatenado que o `transcribe` gravou (tempo global = tempo do arquivo).
 */
function audioInputOf(ctx: Pick<Ctx, "workDir">, source: SourceInfo): string {
  return isMultiSource(source) ? join(ctx.workDir, MULTI_AUDIO_FILE) : source.path;
}

/**
 * Argumentos do ffmpeg que extraem o áudio de UM arquivo do bruto em vários
 * arquivos (#12559) com a duração exata dele na linha do tempo (`frames/fps`):
 * `apad` + `-t` para a concatenação nunca escorregar em relação ao vídeo
 * (áudio mais curto que o vídeo deslocaria todas as falas seguintes).
 */
export function multiAudioPartArgs(input: { src: string; frames: number; fps: number; out: string }): string[] {
  return ["-hide_banner", "-v", "error", "-y", "-i", input.src, "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-af", "apad", "-t", (input.frames / input.fps).toFixed(6), "-c:a", "pcm_s16le", input.out];
}

/** Os mesmos argumentos sem o `apad`: a extração crua, cuja duração é conferida antes de completar (#13417). */
export function multiAudioRawPartArgs(input: { src: string; frames: number; fps: number; out: string }): string[] {
  const a = multiAudioPartArgs(input);
  const i = a.indexOf("-af");
  return [...a.slice(0, i), ...a.slice(i + 2)];
}

/** Lista do concat demuxer (caminhos com `'` escapados). */
export function concatListText(paths: readonly string[]): string {
  return paths.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

/**
 * Áudio do bruto em vários arquivos (#12559): um WAV por arquivo
 * (`_work/audio-parts/`, retoma arquivo a arquivo, como no edicao-video) e a
 * concatenação em `bruto-audio-48k.wav`. Devolve o caminho dele.
 */
function ensureMultiAudio(ctx: Ctx, source: SourceInfo, redo: boolean): { path: string; rebuilt: boolean } {
  const dir = join(ctx.workDir, "audio-parts");
  mkdirSync(dir, { recursive: true });
  const out = join(ctx.workDir, MULTI_AUDIO_FILE);
  const parts: string[] = [];
  // Reaproveitar só WAV inteiro (review da PR #12563): um WAV pela metade, de uma rodada interrompida,
  // adiantaria o áudio de todos os arquivos seguintes. Duração medida contra a do arquivo; escrita em .tmp + rename.
  const ok = (p: string, expectS: number) => existsSync(p) && audioDurationMatches(probeDurationS(p), expectS, source.fps);
  let rebuilt = redo || !ok(out, source.durationS);
  for (const [i, file] of sourceFiles(source).entries()) {
    const part = join(dir, `${String(i + 1).padStart(2, "0")}-${file.id}.wav`);
    parts.push(part);
    if (redo || !ok(part, file.frames / source.fps)) {
      console.error(`[video-montagem] áudio ${i + 1}/${sourceFiles(source).length}: ${file.id}…`);
      const tmp = `${part}.tmp`;
      // #13417: extrai sem o apad e confere a duração real antes de completar com silêncio. A leitura que para no
      // meio (Drive for desktop, arquivo de vários GB) sai com exit 0, e o apad escondia o resto como silêncio. Relê
      // uma vez: falta igual nas duas leituras é do arquivo (completa, com aviso); diferente é leitura interrompida.
      const raw = `${part}.raw.tmp`;
      const want = file.frames / source.fps;
      try {
        const { realShortfallS, unchecked } = readWithRetry(
          want,
          () => {
            run("ffmpeg", [...multiAudioRawPartArgs({ src: file.path, frames: file.frames, fps: source.fps, out: raw }).slice(0, -1), "-f", "wav", raw]);
            return probeDurationS(raw);
          },
          file.path,
          { acceptUnreadable: true },
        );
        if (unchecked) console.error(`[aviso] duração do áudio de ${file.id} não conferida (ffprobe sem duração legível); seguindo (#13417)`);
        if (realShortfallS !== null) {
          console.error(`[aviso] áudio de ${file.id} tem ${realShortfallS.toFixed(2)} s a menos que o vídeo nas duas leituras (falta do próprio arquivo)`);
          console.error(`[premissa] ${file.id}: completado com ${realShortfallS.toFixed(2)} s de silêncio no fim, para os arquivos seguintes ficarem no tempo certo (#13417)`);
        }
        run("ffmpeg", [...multiAudioPartArgs({ src: raw, frames: file.frames, fps: source.fps, out: tmp }).slice(0, -1), "-f", "wav", tmp]);
      } finally {
        rmSync(raw, { force: true });
      }
      renameSync(tmp, part);
      rebuilt = true;
    }
  }
  if (rebuilt) {
    const list = join(dir, "list.txt");
    writeFileSync(list, concatListText(parts));
    const tmp = `${out}.tmp`;
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-f", "wav", tmp]);
    renameSync(tmp, out);
    const d = probeDurationS(out);
    if (!audioDurationMatches(d, source.durationS, source.fps)) throw new Error(`áudio concatenado com ${d} s, a linha do tempo tem ${source.durationS} s: os tempos não batem com o vídeo (#12559)`);
  }
  return { path: out, rebuilt };
}

function probeDurationS(path: string): number {
  return Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).stdout.trim());
}

/** O áudio tem a duração esperada, a menos de 1 quadro? (WAV pela metade não passa, #12559.) */
export function audioDurationMatches(actualS: number, expectS: number, fps: number): boolean {
  return Number.isFinite(actualS) && Math.abs(actualS - expectS) <= 1 / fps + 1e-6;
}

/** Passos que precisam de imagem: no modo áudio (#11552) param antes, dizendo o motivo. */
export const VIDEO_ONLY_COMMANDS = ["frame", "face", "face-compare", "gaze", "build", "verify-xml", "srt", "preview", "review"] as const;

/**
 * Modo áudio (#11552): com `source.json` de bruto só de áudio, os passos que
 * precisam de imagem (XML, legendas das verticais montadas, prévia, revisão,
 * frame) não rodam. Imprime o motivo e devolve 3 (precisa do editor); `null`
 * = seguir (bruto de vídeo, ou `source.json` ainda ausente).
 */
export function audioOnlyStop(ctx: Pick<Ctx, "stateDir">, cmd: string): number | null {
  const path = join(ctx.stateDir, "source.json");
  if (!existsSync(path)) return null;
  const source = JSON.parse(readFileSync(path, "utf8")) as Partial<SourceInfo>;
  if (!source.audioOnly) return null;
  const reason =
    `bruto só de áudio (${source.path}): ${cmd} precisa de stream de vídeo. O modo áudio vai até o roteiro ` +
    "(transcribe, decupagem, retranscribe, roteiro); a montagem no Premiere é à mão a partir do roteiro.md";
  console.error(`[modo áudio] ${reason} (#11552)`);
  console.log(JSON.stringify({ audio_only: true, command: cmd, stopped: true, reason }, null, 2));
  return 3;
}

function loadBlocks(ctx: Ctx): { file: BlocksFile; text: string } {
  const path = f(ctx, "blocks.json");
  if (!existsSync(path)) throw new Error(missingWorkFileMessage(path, "blocks.json (gate da decupagem)"));
  const text = readFileSync(path, "utf8");
  const parsed = parseBlocksFile(JSON.parse(text));
  if (!parsed.ok) throw new Error(`blocks.json inválido:\n  - ${parsed.errors.join("\n  - ")}`);
  if (parsed.file.edition !== ctx.edition) throw new Error(`blocks.json é da edição ${parsed.file.edition}, não ${ctx.edition}`);
  warnVocabOnce(vocabRuleWarnings(parsed.file.vocabulary, "blocks.json vocabulary"));
  return { file: parsed.file, text };
}

/** O bruto efetivo (source.json + overrides do blocks.json). Sem blocks.json, o source.json puro. */
function sourceFor(ctx: Ctx, file?: BlocksFile): SourceInfo {
  const { source, errors } = effectiveSource(measuredSource(ctx), file);
  if (errors.length) throw new Error(`source.json × blocks.json:\n  - ${errors.join("\n  - ")}`);
  return source;
}

/**
 * Hash do que o plano depende: blocks.json + source.json + silences.json (#11351:
 * o `transcribe` redetecta os silêncios sozinho quando o limiar muda, e um plano
 * de antes da redetecção tem os cortes velhos) + transcript.json (#11603: as falas
 * se resolvem nas palavras dele). `silences`/`transcript` null = arquivo ausente.
 */
export function planHashOf(blocksText: string, sourceJson: Buffer | string, silences: Buffer | string | null, transcript: Buffer | string | null = null): string {
  const h = createHash("sha256")
    .update(blocksText)
    .update("\0")
    .update(sourceJson)
    .update("\0")
    .update(silences ?? "\0sem-silences");
  // #11603: o plano resolve as falas nas palavras do transcript; transcript novo = plano refeito.
  if (transcript !== null) h.update("\0transcript\0").update(transcript);
  return h.digest("hex").slice(0, 16);
}

/** As opções efetivas do `build` que mudam o XML sem mudar as entradas do `planHashOf` (#12160). */
export interface XmlBuildOptions {
  /** O detector de fala cortou as pausas (false = `--no-speech-detect`, ou o detector falhou). */
  speechDetect: boolean;
  audioRefine: boolean;
  audioGain: boolean;
  titleMode: TitleMode;
  /** #12101: a vinheta que entrou no XML (o asset inteiro: tamanho, som e fps mudam o XML); ausente/null = sem vinheta (o hash fica o de antes). */
  vinheta?: VinhetaAsset | null;
  /** #12102: o filtro da faixa de áudio tratada que o XML aponta; ausente/null = áudio cru (o hash fica o de antes). */
  audioClean?: string | null;
  /** #12163: o caminho do bruto que o XML aponta (`xmlMediaPath`/`--xml-media-root`); ausente = fora do hash. */
  mediaPath?: string;
  /** #12163: o ganho calculado do loudness, em dB (não só o liga/desliga `audioGain`); ausente/null = fora do hash. */
  gainDb?: number | null;
  /** #12163: o título da vertical (do blocks.json ou do D1) e o de cada corte, como o `buildXmeml` recebe. Só entra no hash o título que a sequência de fato leva. */
  screenTitle?: ScreenTitleXml | null;
  screenTitleByCorte?: Readonly<Record<string, ScreenTitleXml | null>>;
  /** #12571: o card de CTA de cada sequência (chave = `sequenceKey`), como o `buildXmeml` recebe; só entra no hash o card que a sequência leva. */
  ctaCard?: Readonly<Record<string, CtaCardAsset>> | null;
  /** #12707: a tradução de raiz dos `pathurl` para o Premiere do Mac; ausente/null = fora do hash (o de antes). */
  premierePaths?: PremierePathMap | null;
  /** #13123: a capa no começo de cada vertical (chave = `sequenceKey`); só entra no hash a capa que a sequência leva (sem ela, o hash de antes). */
  capaInicio?: Readonly<Record<string, CapaInicioAsset>> | null;
  /** #13140: os marcadores de tela de cada sequência (chave = `sequenceKey`); só entram no hash os da sequência (sem eles, o hash de antes). */
  telaMarkers?: Readonly<Record<string, readonly TelaMarker[]>> | null;
  /** #13219: a folga dos trechos do XML leve, em segundos; ausente/null = XML do bruto (o hash fica o de antes). */
  trechosFolgaS?: number | null;
  /** #13204: os boxes de tela (PNG) de cada sequência; só entram no hash os da sequência, sem o caminho local. */
  telaOverlays?: Readonly<Record<string, readonly TelaOverlay[]>> | null;
  /** #13437: os marcadores de trecho inserido de cada sequência; só entram no hash os da sequência (sem eles, o hash de antes). */
  trechoMarkers?: Readonly<Record<string, readonly TrechoInseridoMarker[]>> | null;
  /** #13437 (PR 2): os clipes dos trechos inseridos de cada sequência; só entram no hash os da sequência, sem o caminho local. */
  trechoClips?: Readonly<Record<string, readonly TrechoInseridoClip[]>> | null;
}

/** #12163: o título que `buildXmeml` põe nesta sequência (mesma regra do `titleOf` de lá), ou `null`. */
export function effectiveScreenTitleOf(
  spec: SequenceSpec,
  screenTitle: ScreenTitleXml | null | undefined,
  byCorte: Readonly<Record<string, ScreenTitleXml | null>> | undefined,
): ScreenTitleXml | null {
  if (!isVerticalSpec(spec)) return null;
  const map = byCorte ?? {};
  const t = spec.corte !== undefined && Object.prototype.hasOwnProperty.call(map, spec.corte) ? map[spec.corte] : screenTitle;
  return t && t.text.trim() ? t : null;
}

/**
 * Fingerprint da VERSÃO do XML de uma sequência (#12160): o `planHashOf` (as
 * entradas) + as opções efetivas do build + o plano final da sequência (clipes,
 * escalas, durações, já depois do detector de fala e do refino pelo áudio).
 * Antes a versão usava só o `planHashOf`: `build --no-speech-detect` depois de
 * um `build` mudava os cortes com o mesmo hash, e `pickXmlVersion` reaproveitava
 * o `_V{n}` (mesmo nome e `<sequence id>`), o que faz o Premiere reabrir a
 * sequência antiga (#12111). O nome da sequência fica fora: é o que a versão
 * decide. O check de staleness do plan.json segue no `planHashOf`.
 */
export function xmlVersionHashOf(inputsHash: string, plan: Pick<SequencePlan, "spec" | "clips" | "durationFrames">, opts: XmlBuildOptions): string {
  const { name: _name, ...spec } = plan.spec;
  // #12163: título, caminho do bruto e ganho calculado também mudam o XML. Cada um só entra
  // quando presente, para o hash de quem não os passa ficar o de antes.
  const title = effectiveScreenTitleOf(plan.spec, opts.screenTitle, opts.screenTitleByCorte);
  return createHash("sha256")
    .update(inputsHash)
    .update("\0opts\0")
    .update(
      JSON.stringify({
        speechDetect: opts.speechDetect,
        audioRefine: opts.audioRefine,
        audioGain: opts.audioGain,
        titleMode: opts.titleMode,
        ...(opts.vinheta ? { vinheta: opts.vinheta } : {}),
        ...(opts.audioClean ? { audioClean: opts.audioClean } : {}),
        ...(opts.mediaPath !== undefined ? { mediaPath: opts.mediaPath } : {}),
        ...(typeof opts.gainDb === "number" ? { gainDb: opts.gainDb } : {}),
        ...(title ? { screenTitle: title } : {}),
        ...(opts.ctaCard?.[sequenceKey(plan.spec)] ? { ctaCard: ctaCardHashPart(opts.ctaCard[sequenceKey(plan.spec)]) } : {}),
        ...(opts.premierePaths ? { premierePaths: opts.premierePaths } : {}),
        ...(opts.capaInicio?.[sequenceKey(plan.spec)] ? { capaInicio: capaInicioHashPart(opts.capaInicio[sequenceKey(plan.spec)]) } : {}),
        ...(opts.telaMarkers?.[sequenceKey(plan.spec)]?.length ? { telaMarkers: opts.telaMarkers[sequenceKey(plan.spec)] } : {}),
        // #13493: a regra de limite dos trechos entra junto com a folga — mesma folga e regra nova = trechos com outro nome, versão nova.
        ...(typeof opts.trechosFolgaS === "number" ? { trechosFolgaS: opts.trechosFolgaS, trechosAnchor: TRECHOS.anchorRule } : {}),
        // #13414: a vertical ancorada pela boca muda o Center sem mudar o plano: versão nova, nunca o _V{n} já importado regravado.
        ...(sequenceAnchor(plan.spec).mouthFraction !== undefined ? { anchor: { mouthFraction: sequenceAnchor(plan.spec).mouthFraction } } : {}),
        ...(opts.telaOverlays?.[sequenceKey(plan.spec)]?.length ? { telaOverlays: opts.telaOverlays[sequenceKey(plan.spec)].map(({ path: _p, ...rest }) => rest) } : {}),
        ...(opts.trechoMarkers?.[sequenceKey(plan.spec)]?.length ? { trechoMarkers: opts.trechoMarkers[sequenceKey(plan.spec)] } : {}),
        ...(opts.trechoClips?.[sequenceKey(plan.spec)]?.length ? { trechoClips: opts.trechoClips[sequenceKey(plan.spec)].map(({ path: _p, fonte: _f, ...rest }) => rest) } : {}),
      }),
    )
    .update("\0plan\0")
    .update(JSON.stringify({ spec, clips: plan.clips, durationFrames: plan.durationFrames }))
    .digest("hex")
    .slice(0, 16);
}

/** #12571: o que do card muda o XML (o caminho no XML, o tamanho e os quadros); o caminho local da prévia fica fora. */
function ctaCardHashPart(c: CtaCardAsset): Omit<CtaCardAsset, "path"> {
  const { path: _path, ...rest } = c;
  return rest;
}

/** #13123: o que da capa muda o XML (o caminho no XML, o tamanho e os quadros); o caminho local da prévia fica fora. */
function capaInicioHashPart(c: CapaInicioAsset): Omit<CapaInicioAsset, "path"> {
  const { path: _path, ...rest } = c;
  return rest;
}

function planHash(ctx: Ctx, blocksText: string): string {
  const sil = f(ctx, "silences.json");
  const tr = f(ctx, "transcript.json");
  // #11754: as retranscrições de janela podem trocar a tomada de um trecho colapsado; entram no hash junto do transcript.
  const patches = retranscribedFiles(ctx).map((p) => readFileSync(p));
  const trBuf = existsSync(tr) ? Buffer.concat([readFileSync(tr), ...patches]) : null;
  return planHashOf(blocksText, readFileSync(f(ctx, "source.json")), existsSync(sil) ? readFileSync(sil) : null, trBuf);
}

/** As retranscrições de janela (`retranscribe-{de}-{até}.json`, no tempo do bruto, #11754) e as subjanelas (`retranscribe-sub-…`, #11958), em ordem de nome. */
export const RETRANSCRIBED_FILE = /^retranscribe-(?:sub-)?\d+(?:\.\d+)?-\d+(?:\.\d+)?\.json$/;
function retranscribedFiles(ctx: Pick<Ctx, "stateDir">): string[] {
  if (!existsSync(ctx.stateDir)) return [];
  return readdirSync(ctx.stateDir)
    .filter((n) => RETRANSCRIBED_FILE.test(n))
    .sort()
    .map((n) => f(ctx, n));
}

/** Aviso quando o `silences.json` foi detectado com pausa mínima maior que o corte (#11753): as pausas entre as duas não saem. */
export function silenceDetectStaleWarning(metaMinDurationS: number | undefined, minGapS: number = SPEECH_DEFAULTS.minGapS): string | null {
  if (metaMinDurationS === undefined || metaMinDurationS <= minGapS + 1e-9) return null;
  return `silences.json detectado com pausa mínima de ${metaMinDurationS} s, acima do corte de ${minGapS} s (#11753): pausas entre os dois ficam no XML; rodar transcribe de novo nesta máquina para redetectar os silêncios`;
}

function silences(ctx: Ctx): Interval[] {
  return readJson<Interval[]>(f(ctx, "silences.json"), "silences.json (rode transcribe)");
}

/**
 * As pausas do corte (#12089): com o detector de fala do `build`, as dele (já
 * com a folga descontada, `SPEECH_DETECT_PLAN`); sem ele, o `silences.json` do
 * `transcribe` com o respiro de `SPEECH_DEFAULTS`. Resolver as falas usa
 * sempre o `silences.json` (é o que o transcript e o roteiro viram).
 */
/** #12263: `energy` = os quadros do detector, para a checagem de entrada que corta som. */
type SpeechCut = { silences: Interval[]; islands: Interval[]; energy?: FrameEnergy; detectDb?: { fullDb: number; diffDb: number } };

/** #12089: limiares do detector de fala no `build` (`--speech-full-db`/`--speech-diff-db` sobrepõem os de `speechThresholds`; `--no-speech-voice` desliga o filtro de respiração pela F0). */
export interface SpeechDetectOptions {
  fullDb?: number;
  diffDb?: number;
  voice?: boolean;
}

/**
 * Tomada repetida que o Whisper colapsou (#12711), no `build` e no `roteiro`:
 * item com muito mais fala que o texto pede, ou com a mesma frase mais vezes
 * no intervalo que no texto. Só avisa (o editor confere no áudio).
 */
function printTakeRepeatWarnings(ctx: Ctx, resolved: Partial<Record<BlockKey, ResolvedItem[]>>): void {
  for (const w of takeRepeatWarnings(takeRepeatItems(resolved), silences(ctx), makeMatcher(loadVocab().aliases))) console.error(`[aviso] ${w}`);
}

/** Palavra fora dos clipes, como o `buildSequencePlan` a expõe (`lostWords`). */
type LostWord = NonNullable<SequencePlan["lostWords"]>[number];

/**
 * #12089: a proteção de palavras com as ilhas (`protectTranscribedWords` com
 * `islands`) deixa sem proteção a palavra esticada pelo Whisper por cima da
 * pausa, e o `buildSequencePlan` a aceita como coberta pela pausa. Se mesmo
 * assim alguma palavra ficar fora dos clipes (a que atravessa a emenda entre
 * dois itens, por exemplo), a sequência é refeita com `fallback` (a proteção de
 * antes: toda palavra com o meio na pausa) e fica a que perde MENOS palavras
 * (contadas em `lostWords`, não em linhas do `dropped`). `lost` = as palavras
 * que o primário perderia, sempre as reais; com `fellBack` false e `lost` não
 * vazio, o fallback não melhorou e o `dropped` do primário barra o build.
 */
export function withLostWordFallback<T extends { lostWords?: LostWord[] }>(
  build: (pauses: Interval[]) => T,
  primary: Interval[],
  fallback: Interval[] | null,
): { plan: T; fellBack: boolean; lost: LostWord[] } {
  const p = build(primary);
  const lost = p.lostWords ?? [];
  if (!fallback || lost.length === 0) return { plan: p, fellBack: false, lost };
  const q = build(fallback);
  return (q.lostWords ?? []).length < lost.length ? { plan: q, fellBack: true, lost } : { plan: p, fellBack: false, lost };
}

/** Palavra com tempo no bruto, para os avisos do detector de fala. */
const wordAt = (w: { text: string; start: number }) => `"${w.text}" em ${w.start.toFixed(2)} s`;

function plans(ctx: Ctx, speech?: SpeechCut | null) {
  const { file, text } = loadBlocks(ctx);
  const source = sourceFor(ctx, file);
  const vocab = loadVocab();
  const sil = silences(ctx);
  const metaPath = f(ctx, "silences.meta.json");
  const stale = silenceDetectStaleWarning(existsSync(metaPath) ? readJson<{ minDurationS?: number }>(metaPath, "silences.meta.json").minDurationS : undefined);
  if (stale) console.error(`[aviso] ${stale}`);
  const { blocks, errors, warnings } = resolveBlocks(file, nonEmptyWords(f(ctx, "transcript.json"), "transcript.json (rode transcribe)"), {
    durationS: source.durationS,
    silences: sil,
    rules: vocab.rules,
    aliases: vocab.aliases,
    retranscribed: retranscribedFiles(ctx).map((p) => readJson<Transcript>(p, basename(p))),
    // #12559: bruto em vários arquivos: item com `source` procura a tomada só no arquivo dele.
    ...(isMultiSource(source) ? { files: sourceFiles(source).map((x, i) => ({ id: x.id, ...fileBounds(source)[i] })) } : {}),
  });
  for (const w of warnings) console.error(`[aviso] ${w}`);
  if (errors.length) throw new Error(`blocks.json com problema:\n  - ${errors.join("\n  - ")}`);
  const fmt = effectiveFormat(file);
  if (!file.sequences && fmt.inferred) console.error("[premissa] blocks.json sem título nem resumo: formato entrevista, sequências abertura → comentário → CTA → fecho (#11507); `format`/`sequences` sobrepõem");
  // #12586: sem `titulo` e com `gancho`, a frase falada de abertura (o gancho) abre as duas versões.
  const specs = file.sequences ?? defaultSequences("V1", fmt.format, openingBlockOf(file.blocks));
  // Review da PR #12142: palavra transcrita dita baixo demais para virar ilha não pode cair numa pausa cortada.
  let speechSil = speech?.silences ?? [];
  let fallbackSil: Interval[] | null = null;
  let stretched: Array<{ text: string; start: number; end: number; cutS: number }> = [];
  if (speech) {
    const words = Object.values(blocks).flatMap((items) => (items ?? []).flatMap((it) => it.words));
    // #12089: palavra esticada pelo Whisper por cima da pausa (já dentro de uma ilha) não devolve a pausa.
    // #12089 (261116): com a energia, a palavra esticada sobre trecho da pausa sem som também não a devolve.
    // Review da PR #13450: os limiares do detector seguram o limiar de som (nunca acima do que o detector descartou).
    const guard = protectTranscribedWords(speech.silences, words, { islands: speech.islands, ...(speech.energy ? { energy: speech.energy } : {}), ...(speech.detectDb ? { detectDb: speech.detectDb } : {}) });
    speechSil = guard.silences;
    stretched = guard.stretchedWords;
    // A proteção sem as ilhas (a de antes) é a rede: sequência que perderia palavra com a nova volta para ela.
    fallbackSil = protectTranscribedWords(speech.silences, words).silences;
    if (stretched.length) {
      console.error(`[aviso] detector de fala (#12089): ${stretched.length} palavra(s) esticada(s) pelo Whisper sobre uma pausa perderam a proteção (a pausa sai e corta o trecho dela fora da fala): ${stretched.map((w) => `${wordAt(w)} (${Math.round(w.cutS * 1000)} ms cortados)`).join(", ")}; conferir no Premiere se algo dito baixo sumiu`);
    }
    if (guard.protectedWords.length) {
      console.error(`[aviso] detector de fala (#12089): ${guard.protectedWords.length} palavra(s) do transcript abaixo do limiar ficaram no corte em vez de sair na pausa: ${guard.protectedWords.map((w) => `"${w.text}" em ${w.start.toFixed(2)} s`).join(", ")}; conferir no áudio (se for ruído, --no-speech-detect ou intervalo no blocks.json)`);
    }
  }
  // #13239 item 3: a energia do detector escolhe o silêncio da pausa da vinheta pelo mesmo limite do "corta som" (#12263).
  const quiet = speech?.energy ? entrySoundLimitDb(speech.energy) : null;
  const fillerEnergy = speech?.energy && quiet ? { fillerEnergy: { hopS: speech.energy.hopS, fullDb: speech.energy.fullDb, quietDb: quiet.lim, lookS: SPEECH_DETECT.entryLookS } } : {};
  const ps = specs.map((s) => {
    // #12101: o respiro da vinheta depois do título (todas as sequências desde o #13204).
    if (!speech) return buildSequencePlan(s, blocks, sil, source, { holdBlocks: file.holdBlocks, breathAfter: vinhetaBreathFor(s) });
    const r = withLostWordFallback((pauses) => buildSequencePlan(s, blocks, pauses, source, { holdBlocks: file.holdBlocks, breathAfter: vinhetaBreathFor(s), ...fillerEnergy, ...SPEECH_DETECT_PLAN }), speechSil, fallbackSil);
    if (r.fellBack) {
      // As proteções que a rede trouxe de volta: as palavras esticadas que agora caem dentro dos clipes desta sequência.
      const back = stretched.filter((w) => r.plan.clips.some((c) => Math.min(w.end, c.frameOut / source.fps) - Math.max(w.start, c.frameIn / source.fps) > 1e-6));
      console.error(
        `[aviso] ${s.name}: ${r.lost.length} palavra(s) ficariam fora dos clipes com a pausa cortada (${r.lost.map((w) => `${w.label}: ${wordAt(w)}`).join("; ")}); ` +
          `a sequência volta à proteção de toda palavra com o meio na pausa (#12089), que devolve a pausa de ${back.length} palavra(s): ${back.map(wordAt).join(", ") || "nenhuma das esticadas"}`,
      );
    }
    return r.plan;
  });
  return { file, source, resolved: blocks, plans: ps, hash: planHash(ctx, text) };
}

interface PlanFile {
  edition: string;
  hash: string;
  source: SourceInfo;
  framing: Framing;
  framingAssumed: boolean;
  /** #12559: framing/espelho por arquivo do bruto em vários arquivos (`files` do blocks.json), para a prévia enquadrar igual ao XML. */
  fileOverrides?: BlocksFile["files"];
  plans: SequencePlan[];
  /** O refino dos cortes pelo áudio (#11500); ausente em plano anterior a ele. */
  cutRefine?: CutRefineInfo;
  /**
   * #11969: quando o XML de cada sequência (`sequenceKey`) foi gravado, em ms.
   * Com `--seq`, as outras sequências guardam o instante do build que as
   * gravou: é contra ele (e não o mtime do plan.json) que srt/prévia conferem.
   */
  builtAt?: Record<string, number>;
  /**
   * #12101/#12102: o que entrou no XML de cada sequência (`sequenceKey`),
   * gravado no build dela como o `builtAt`: a faixa de áudio tratada e a
   * vinheta. A prévia lê daqui, para mostrar o que o XML daquela sequência tem.
   */
  xmlAssets?: Record<string, SequenceXmlAssets>;
  /**
   * #12285: o `<sequence id>` versionado do XML de cada sequência (`sequenceKey`)
   * e desde quando ele vale (`since`, ms). Rebuild com o mesmo hash de versão
   * mantém o `_V{n}` e o id, e o `since` fica o do build que abriu a versão:
   * é contra ele (e o id) que a legenda do export confere se o XML mudou, nunca
   * contra o `builtAt`, que avança em todo build.
   */
  xmlVersions?: Record<string, SequenceXmlVersion>;
  /**
   * #12968: sequências (`sequenceKey`) mantidas por um `build --seq` de OUTRA
   * sequência depois de as entradas mudarem: o plano e o XML delas são de um
   * build com o hash de entradas `hash` (diferente do `hash` do plan.json).
   * srt/preview/review/verify-xml as deixam de fora até um build delas.
   */
  stale?: Record<string, PlanStaleMark>;
}

export interface PlanStaleMark {
  /** O `planHashOf` das entradas do build que gravou o XML desta sequência. */
  hash: string;
}

export interface SequenceXmlVersion {
  id: string;
  since: number;
}

export interface SequenceXmlAssets {
  treatedAudio?: TreatedAudio;
  vinheta?: VinhetaAsset;
  /** #13240: o som da vinheta configurado que NÃO entrou no XML desta sequência, e por quê; ausente = entrou (em `vinheta.sfx`) ou não foi configurado. */
  vinhetaSfx?: { ausente: string };
  /** #12571: o card de CTA que o XML desta sequência levou no fim da V1 (a prévia o acrescenta igual). */
  ctaCard?: CtaCardAsset;
  /** #13123: a capa que o XML desta sequência levou nos primeiros quadros (a prévia a sobrepõe igual). */
  capaInicio?: CapaInicioAsset;
  /** #13204: os boxes de tela que o XML desta sequência levou (a prévia os sobrepõe igual). */
  telaOverlays?: TelaOverlay[];
  /**
   * #13437 (PR 2): os trechos de outro vídeo que o XML desta sequência levou,
   * numa faixa própria, com o deslocamento (`trechoRipple`) que o plano não
   * tem. O `verify-xml` desfaz o deslocamento com eles; a prévia não os leva.
   */
  trechosInseridos?: TrechoInseridoClip[];
}

/**
 * O `plan.json` de um build (#11969). Sem `--seq` (`pickedKeys` = todas), é o
 * plano novo inteiro. Com `--seq`, só as sequências reconstruídas entram do
 * plano novo; as outras ficam como o build anterior as gravou (o XML delas no
 * disco é o daquele build). Com blocks.json/source.json/silences.json/
 * transcript.json mudados, o XML antigo delas não corresponde mais às
 * entradas: elas ficam no plan.json marcadas em `stale` (#12968; antes saíam
 * do plano, e o #12902 passou a recusar o `--seq`), com o plano, a versão e o
 * instante do build delas, e srt/prévia as deixam de fora até um build delas.
 * Só sai do plano (`dropped`) a sequência que o plano anterior não tinha.
 */
export function mergeBuildPlan(input: {
  next: Omit<PlanFile, "builtAt" | "xmlVersions">;
  pickedKeys: ReadonlySet<string>;
  prev: PlanFile | null;
  now: number;
  /** #12285: o `<sequence id>` gravado neste build, por sequência reconstruída. */
  xmlIds?: Readonly<Record<string, string>>;
  /**
   * #12285: o `<sequence id>` do XML que estava no disco ANTES deste build o
   * sobrescrever, por sequência. Só serve à transição de um plano anterior ao
   * #12285 (sem `xmlVersions`): mesmo id = o XML não mudou, e o `since` herda o
   * `builtAt` do build anterior em vez de nascer `now`.
   */
  prevXmlIds?: Readonly<Record<string, string>>;
}): { plan: PlanFile; kept: string[]; stale: string[]; dropped: string[] } {
  const { next, pickedKeys, prev, now } = input;
  const xmlVersions: Record<string, SequenceXmlVersion> = {};
  const keyOf = (p: SequencePlan) => sequenceKey(p.spec);
  const prevByKey = new Map((prev && Array.isArray(prev.plans) ? prev.plans : []).map((p) => [keyOf(p), p]));
  const kept: string[] = [];
  const stale: string[] = [];
  const staleMarks: Record<string, PlanStaleMark> = {};
  const dropped: string[] = [];
  const plans: SequencePlan[] = [];
  const builtAt: Record<string, number> = {};
  const highBandWarnings: Record<string, string[]> = {};
  // #12101/#12102: o que entrou no XML, por sequência: das reconstruídas, o deste build; das mantidas, o do build delas.
  const xmlAssets: Record<string, SequenceXmlAssets> = {};
  for (const p of next.plans) {
    const k = keyOf(p);
    if (pickedKeys.has(k)) {
      plans.push(p);
      builtAt[k] = now;
      const w = next.cutRefine?.highBandWarnings?.[k];
      if (w) highBandWarnings[k] = w;
      const a = next.xmlAssets?.[k];
      if (a) xmlAssets[k] = a;
      // #12285: mesmo id = o mesmo XML do build anterior; o `since` não avança (independe do hash das entradas: o id já o carrega).
      const id = input.xmlIds?.[k];
      if (id) {
        const old = prev?.xmlVersions?.[k];
        const legacyBuiltAt = prev?.builtAt?.[k];
        const since =
          old && old.id === id && Number.isFinite(old.since)
            ? old.since
            : // plano anterior ao #12285: sem versão gravada, o XML do disco diz se o id é o mesmo
              !old && input.prevXmlIds?.[k] === id && typeof legacyBuiltAt === "number" && Number.isFinite(legacyBuiltAt) && legacyBuiltAt > 0
              ? legacyBuiltAt
              : now;
        xmlVersions[k] = { id, since };
      }
      continue;
    }
    const old = prevByKey.get(k);
    if (!old || !prev) {
      dropped.push(k);
      continue;
    }
    plans.push(old);
    // #12968: as entradas do XML desta sequência são as do build dela: o hash do plano anterior, ou a marca que ela já levava.
    const builtFrom = staleMarkOf(prev, k)?.hash ?? prev.hash;
    if (builtFrom === next.hash) kept.push(k);
    else {
      stale.push(k);
      staleMarks[k] = { hash: builtFrom };
    }
    builtAt[k] = prev.builtAt?.[k] ?? 0;
    const w = prev?.cutRefine?.highBandWarnings?.[k];
    if (w) highBandWarnings[k] = w;
    const a = prev?.xmlAssets?.[k];
    if (a) xmlAssets[k] = a;
    const v = prev?.xmlVersions?.[k];
    if (v) xmlVersions[k] = v;
  }
  const cutRefine = next.cutRefine ? { ...next.cutRefine, ...(next.cutRefine.highBandWarnings ? { highBandWarnings } : {}) } : undefined;
  const { xmlAssets: _nextAssets, ...rest } = next;
  return {
    plan: {
      ...rest,
      plans,
      ...(cutRefine ? { cutRefine } : {}),
      builtAt,
      ...(Object.keys(xmlAssets).length ? { xmlAssets } : {}),
      ...(Object.keys(xmlVersions).length ? { xmlVersions } : {}),
      ...(stale.length ? { stale: staleMarks } : {}),
    },
    kept,
    stale,
    dropped,
  };
}

/** #12968: a marca de defasada da sequência no plano, ou null (ausente, malformada ou com o mesmo hash do plano). */
export function staleMarkOf(pf: Pick<PlanFile, "hash" | "stale">, key: string): PlanStaleMark | null {
  const m = pf.stale?.[key];
  return m && typeof m.hash === "string" && m.hash && m.hash !== pf.hash ? m : null;
}

/**
 * #12968: as sequências do plano que conferem com as entradas dele (`fresh`)
 * e as defasadas (`stale`, chaves), que srt/preview/review/verify-xml não usam.
 */
export function splitStalePlans(pf: Pick<PlanFile, "hash" | "stale" | "plans">): { fresh: SequencePlan[]; stale: string[] } {
  const fresh: SequencePlan[] = [];
  const stale: string[] = [];
  for (const p of pf.plans) {
    const k = sequenceKey(p.spec);
    if (staleMarkOf(pf, k)) stale.push(k);
    else fresh.push(p);
  }
  return { fresh, stale };
}

/**
 * #12285: a versão do XML da sequência no plano (id + desde quando), ou null
 * em plano anterior a ela. Com o `since` ausente, o `sequenceBuiltAt` faz as
 * vezes (o comportamento do #12209).
 */
export function sequenceXmlVersion(pf: Pick<PlanFile, "xmlVersions">, key: string): SequenceXmlVersion | null {
  const v = pf.xmlVersions?.[key];
  return v && typeof v.id === "string" && v.id && typeof v.since === "number" && Number.isFinite(v.since) ? v : null;
}

/** Instante do build da sequência no plano (#11969); plano antigo sem `builtAt` = o mtime do plan.json. */
export function sequenceBuiltAt(pf: Pick<PlanFile, "builtAt">, key: string, planMtimeMs: number): number {
  const t = pf.builtAt?.[key];
  return typeof t === "number" && t > 0 ? t : planMtimeMs;
}

/**
 * O plano do último build, recusado se o blocks.json ou o source.json mudaram
 * depois dele. As sequências defasadas (#12968) saem da lista, com aviso: o
 * XML delas é de entradas anteriores.
 */
function loadPlan(ctx: Ctx): PlanFile {
  const pf = readJson<PlanFile>(f(ctx, "plan.json"), "plan.json (rode build)");
  const { text } = loadBlocks(ctx);
  if (pf.hash !== planHash(ctx, text)) throw new Error("plan.json defasado: blocks.json, source.json, silences.json ou transcript.json mudaram depois do build; rode build de novo");
  const { fresh, stale } = splitStalePlans(pf);
  if (stale.length) console.error(staleSequencesWarning(stale));
  return { ...pf, plans: fresh };
}

/** #12968: o aviso das sequências defasadas no plan.json (o que rodar para usá-las). */
export function staleSequencesWarning(stale: readonly string[]): string {
  return (
    `[aviso] ${stale.join(", ")}: defasada(s) no plan.json, o XML é de um build com outras entradas (blocks.json, source.json, silences.json ou transcript.json mudaram depois); ` +
    `fora de srt/preview/review/verify-xml até build --seq de cada uma (ou build sem --seq) (#12968)`
  );
}

/**
 * As sequências que o `--seq` escolhe (#11900): pela identidade
 * (`sequenceKey`: o slug do corte, ou o destino da sequência sem corte); sem
 * nenhuma com essa identidade, pelo destino (`--seq instagram` ainda acha o
 * corte de target `instagram` de um `blocks.json` de 1 extra). `single` (prévia,
 * revisão) recusa um destino que casa mais de uma sequência, citando os slugs.
 */
export function pickPlans<P extends { spec: Pick<SequenceSpec, "target" | "corte" | "width" | "height"> }>(
  all: P[],
  seq: string | undefined,
  verticalOnly: boolean,
  single = false,
): P[] {
  const pool = verticalOnly ? all.filter((p) => p.spec.height > p.spec.width) : all;
  if (!seq) return pool;
  const byKey = pool.filter((p) => sequenceKey(p.spec) === seq);
  const hit = byKey.length ? byKey : pool.filter((p) => p.spec.target === seq);
  const kind = verticalOnly ? " vertical" : "";
  if (hit.length === 0) {
    throw new Error(`--seq ${seq}: nenhuma sequência${kind} com esse destino ou corte (há: ${pool.map((p) => sequenceKey(p.spec)).join(", ") || "nenhuma"})`);
  }
  if (single && hit.length > 1) throw new Error(`--seq ${seq}: ${hit.length} sequências${verticalOnly ? " verticais" : ""} com esse destino; escolha pelo corte (${hit.map((p) => sequenceKey(p.spec)).join(", ")})`);
  return hit;
}

// ── Subcomandos ───────────────────────────────────────────────────────────

/** #12089: `--speech-full-db`/`--speech-diff-db` do `build`: número negativo em dBFS. */
export function parseSpeechDbArg(flag: string, raw: string): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n >= 0) throw new Error(`${flag} precisa ser um número negativo em dBFS (ex.: -28), não "${raw}"`);
  return n;
}

/** `--silence-db` (#11351): número negativo em dB; ausente = limiar relativo ao loudness. */
export function parseSilenceDbArg(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n >= 0) throw new Error(`--silence-db precisa ser um número negativo em dB (ex.: -35), não ${raw}`);
  return n;
}

const normPath = (p: string) => resolve(p).replace(/\\/g, "/");

/**
 * O aviso do `transcript.json` mantido (#11504): `source.json` novo não
 * retranscreve por cima. Na 261029 o editor pôs no lugar a transcrição do áudio
 * remapeada à mão, e o `transcribe` com `source.json` novo a sobrescreveu com a
 * do vídeo inteiro. Duração do transcript diferente da do bruto (mais de 2 s)
 * aponta para outro arquivo.
 */
export function keptTranscriptWarning(prev: Pick<Transcript, "duration">, durationS: number): string {
  const other =
    prev.duration !== undefined && Math.abs(prev.duration - durationS) > 2
      ? ` ATENÇÃO: ele tem ${prev.duration.toFixed(1)} s e o bruto ${durationS.toFixed(1)} s; se é a transcrição do áudio separado, use --from-audio ARQ.`
      : "";
  return `transcript.json já existe: mantido, não retranscrevo por cima.${other} Para retranscrever o bruto inteiro: --force (#11504)`;
}

/**
 * A transcrição do áudio separado (#11504), guardada em `transcript-audio.json`
 * (com `transcript-audio.meta.json` dizendo de qual áudio é) antes de o
 * `transcript.json` virar o do vídeo. Vem, nesta ordem: de `--audio-transcript`;
 * do `transcript-audio.json` já guardado (do mesmo áudio); do `transcript.json`
 * atual quando o `source.json` aponta para esse áudio (o editor transcreveu o
 * áudio antes de o vídeo chegar).
 */
function stashAudioTranscript(ctx: Ctx, audioPath: string, explicit: string | undefined): Transcript {
  const trAudio = f(ctx, "transcript-audio.json");
  const metaPath = f(ctx, "transcript-audio.meta.json");
  const keep = (from: string) => {
    const t = readJson<Transcript>(from, "transcrição do áudio");
    if (transcriptWords(t).length === 0) throw new Error(`transcrição do áudio sem nenhuma palavra: ${from}`);
    writeJson(trAudio, t);
    writeJson(metaPath, { audio: audioPath, from: from.replace(/\\/g, "/") });
    return t;
  };
  if (explicit) return keep(resolve(explicit));
  if (existsSync(trAudio)) {
    const meta = existsSync(metaPath) ? readJson<{ audio?: string }>(metaPath, "transcript-audio.meta.json") : {};
    if (meta.audio !== audioPath) throw new Error(`transcript-audio.json é de outro áudio (${meta.audio ?? "sem meta"}), não ${audioPath}; passe --audio-transcript`);
    return readJson<Transcript>(trAudio, "transcript-audio.json");
  }
  const src = f(ctx, "source.json");
  const tr = f(ctx, "transcript.json");
  if (existsSync(src) && existsSync(tr) && readJson<SourceInfo>(src, "source.json").path === audioPath) return keep(tr);
  throw new Error(`--from-audio ${audioPath}: nenhuma transcrição desse áudio (rode transcribe --source "${audioPath}" antes, ou passe --audio-transcript ARQ)`);
}

/**
 * `transcribe --from-audio` (#11504): alinha o áudio separado ao do vídeo,
 * remapeia as palavras dos trechos com par e retranscreve no vídeo só o que
 * ficou sem par (as pausas que o áudio cortou, as bordas de cada corte e o
 * que vem antes/depois do áudio). Grava `transcript.json` (no tempo do vídeo)
 * e `audio-align.json` (deslocamentos, trechos, o que foi retranscrito).
 */
function alignFromAudio(ctx: Ctx, source: SourceInfo, videoWav: string, audioPath: string, audioTr: Transcript, trPath: string): void {
  const fromWav = join(ctx.workDir, "from-audio.wav");
  console.error(`[video-montagem] alinhando o áudio ${audioPath} ao vídeo (correlação do envelope em janelas de ${ALIGN_DEFAULTS.windowS} s, #11504)…`);
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", audioPath, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", fromWav]);
  const va = parseWavPcm16(readFileSync(videoWav));
  const aa = parseWavPcm16(readFileSync(fromWav));
  const ve = energyEnvelope(va.samples, va.sampleRate);
  const ae = energyEnvelope(aa.samples, aa.sampleRate);
  const al = alignEnvelopes(ae.db, ve.db, ve.hopS);
  const audioDurS = aa.samples.length / aa.sampleRate;
  if (al.coverage < ALIGN_DEFAULTS.minCoverage) {
    writeJson(f(ctx, "audio-align.json"), { ok: false, audio: audioPath, video: source.path, ...al });
    throw new Error(
      `o áudio ${audioPath} não casa com o vídeo (${(al.coverage * 100).toFixed(0)}% com par, mínimo ${ALIGN_DEFAULTS.minCoverage * 100}%; detalhe em audio-align.json): ` +
        "não é o mesmo som, ou foi editado demais. Transcrever o vídeo inteiro: transcribe --force",
    );
  }
  const rm = remapToVideo(audioTr, al.runs, source.durationS, { audioDurS });
  for (const r of al.runs) console.error(`[video-montagem]   áudio ${clockTime(r.audioStart)}–${clockTime(r.audioEnd)} → vídeo +${r.offset.toFixed(3)} s`);
  const patches: Transcript[] = [];
  for (const g of rm.uncovered) {
    const a = Math.max(0, g.start - 0.5);
    const b = Math.min(source.durationS, g.end + 0.5);
    const tag = `${a.toFixed(1)}-${b.toFixed(1)}`;
    const wav = join(ctx.workDir, `from-audio-gap-${tag}.wav`);
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", a.toFixed(3), "-to", b.toFixed(3), "-i", videoWav, "-ac", "1", "-ar", "16000", wav]);
    const raw = join(ctx.workDir, `from-audio-gap-${tag}.json`);
    transcribeWithPython(ctx, wav, raw, { vad: false, noCondition: true });
    patches.push(offsetTranscript(readJson<Transcript>(raw, "retranscrição do trecho sem par"), a));
  }
  const merged = mergeRetranscribed(rm.segments, patches, rm.uncovered, source.durationS, audioTr.model);
  const retranscribedS = rm.uncovered.reduce((n, g) => n + g.end - g.start, 0);
  writeJson(trPath, { ...merged, aligned_from_audio: { audio: audioPath, video: source.path, runs: al.runs, retranscribed: rm.uncovered } });
  writeJson(f(ctx, "audio-align.json"), {
    ok: true,
    audio: audioPath,
    video: source.path,
    audioDurS,
    offsets: al.offsets,
    coverage: al.coverage,
    runs: al.runs,
    windows: al.windows,
    uncovered: rm.uncovered,
    remappedWords: rm.words,
    droppedWords: rm.dropped,
  });
  console.error(
    `[video-montagem] transcript.json no tempo do vídeo: ${rm.words} palavra(s) do áudio remapeadas em ${al.runs.length} trecho(s); ` +
      `${rm.dropped} na borda de corte descartada(s); ${rm.uncovered.length} trecho(s) do vídeo sem par retranscrito(s) (${retranscribedS.toFixed(1)} s)`,
  );
}

/**
 * `--from-audio` que falhou depois de trocar o bruto para o vídeo (#11601):
 * volta o `source.json` para o de antes e apaga o áudio, o loudness e os
 * silêncios já extraídos do vídeo. Sem isso, o `transcript.json` (ainda o do
 * áudio, nos tempos do áudio) ficava ao lado de um `source.json` do vídeo, e o
 * `transcribe` seguinte saía 0 sem aviso: `build` cortava o vídeo nos tempos
 * do áudio (~47-57 s fora na 261029). Devolve o trecho para a mensagem de erro.
 */
function rollbackSourceSwitch(ctx: Ctx, prevSourceText: string | null, newPath: string): string {
  let prevPath: string | undefined;
  try {
    prevPath = prevSourceText === null ? undefined : (JSON.parse(prevSourceText) as SourceInfo).path;
  } catch {
    prevPath = undefined;
  }
  if (prevSourceText !== null && prevPath === newPath) return "";
  if (prevSourceText === null) rmSync(f(ctx, "source.json"), { force: true });
  else writeFileAtomic(f(ctx, "source.json"), prevSourceText);
  for (const p of [join(ctx.workDir, "audio.wav"), join(ctx.workDir, "audio-high-48k.wav"), join(ctx.workDir, "audio-high-48k.meta.json"), f(ctx, "loudness.json"), f(ctx, "silences.json"), f(ctx, "silences.meta.json")]) rmSync(p, { force: true });
  return prevSourceText === null
    ? ". source.json removido (o bruto não foi trocado para o vídeo; o transcript.json ficou como estava)"
    : `. source.json voltou para ${prevPath ?? "o anterior"} (o bruto não foi trocado para o vídeo; o transcript.json ficou como estava)`;
}

/** Arquivos que dependem dos números de segmento ou dos tempos do `transcript.json` (#11603). */
export const TRANSCRIPT_DERIVED = ["decupagem-plan.json", "decupagem-plan.template.json", DECUPAGEM_SEGMENTS_FILE, "decupagem.md", "blocks.json", "blocks.template.json", "plan.json"] as const;

/**
 * Quando o `transcript.json` muda (#11603, ex.: `transcribe --from-audio` depois
 * dos gates feitos no modo áudio), a decupagem e o `blocks.json` feitos sobre o
 * anterior passam a apontar para outros segmentos/tempos sem erro nenhum. Põe
 * cada um de lado como `{nome}.defasado.{ext}` (nunca apaga: o texto e as
 * decisões do editor servem para refazer). Transcript novo (sem anterior) ou
 * igual byte a byte não mexe em nada.
 */
export function setAsideOnTranscriptChange(ctx: Pick<Ctx, "stateDir">, before: Buffer | null, after: Buffer | null): Array<{ from: string; to: string }> {
  if (before === null || after === null || before.equals(after)) return [];
  const moved: Array<{ from: string; to: string }> = [];
  for (const name of TRANSCRIPT_DERIVED) {
    const from = join(ctx.stateDir, name);
    if (!existsSync(from)) continue;
    const to = name.replace(/\.(json|md)$/, ".defasado.$1");
    renameSync(from, join(ctx.stateDir, to));
    moved.push({ from: name, to });
  }
  return moved;
}

const sourceConflictMessage = (cachedPath: string, srcPath: string) =>
  `source.json aponta para outro bruto (${cachedPath}); rode com --force para trocar por ${srcPath}`;

/**
 * #11653: o que o `transcribe` faria com o bruto `srcPath`, decidido ANTES de
 * baixá-lo no modo API. `conflict` = o `source.json` aponta para outro bruto e
 * não há --force (a mesma recusa do `cmdTranscribe`, sem os GB do download nem
 * o `bruto.drive.json` regravado com o bruto novo); `ready` = o `source.json` já
 * é este bruto e o áudio, o loudness e a transcrição estão prontos (o
 * `cmdTranscribe` não lê o bruto, então não há o que baixar); senão `fetch`.
 * Com `--from-audio` nunca é `ready` (o alinhamento confere o próprio estado).
 */
export function transcribePrecheck(
  ctx: Pick<Ctx, "stateDir"> & Partial<Pick<Ctx, "workDir" | "force">>,
  srcPath: string,
  audioPath?: string,
): { action: "conflict"; message: string } | { action: "ready" } | { action: "fetch" } {
  const sourcePath = f(ctx, "source.json");
  if (ctx.force || !existsSync(sourcePath)) return { action: "fetch" };
  const cached = readJson<SourceInfo>(sourcePath, "source.json");
  const src = normPath(srcPath);
  if (audioPath !== undefined && cached.path === normPath(audioPath)) return { action: "fetch" };
  if (cached.path !== src) return { action: "conflict", message: sourceConflictMessage(cached.path, src) };
  // Sem work dir conhecido não há como saber se o áudio existe: baixa.
  const done = audioPath === undefined && ctx.workDir !== undefined && [join(ctx.workDir, "audio.wav"), join(ctx.workDir, "audio-high-48k.wav"), join(ctx.workDir, "audio-high-48k.meta.json"), f(ctx, "loudness.json"), f(ctx, "transcript.json")].every((p) => existsSync(p));
  return done ? { action: "ready" } : { action: "fetch" };
}

/** #12268: tamanho não distingue tomadas alternativas de partes da mesma gravação. */
export function assertSingleRawVideo(raw: { candidates: readonly { name: string }[]; audioOnly?: true }): void {
  if (!raw.audioOnly && raw.candidates.length > 1) {
    throw new Error(`${raw.candidates.length} vídeos candidatos a bruto: ${raw.candidates.map((c) => c.name).join(", ")}. ` +
      "A gravação pode estar dividida em partes; transcrição interrompida para não perder o começo. " +
      "Una as partes na ordem correta e passe --source PATH para o bruto unido; se forem tomadas alternativas, selecione a desejada com --source PATH. --force não resolve esta ambiguidade.");
  }
}

/**
 * #12559: os arquivos do `--source a,b,c` (ou `--all`). Cada nome é um caminho
 * (absoluto ou relativo à pasta atual) ou um arquivo da pasta da edição no
 * Drive; os de outra pasta (o lote gravado para duas edições) entram sem
 * mover nem copiar o original.
 */
export function resolveSourceList(list: readonly string[], driveDir: string, exists: (p: string) => boolean = existsSync): string[] {
  return list.map((raw) => {
    const name = raw.trim();
    const direct = resolve(name);
    if (exists(direct)) return direct.replace(/\\/g, "/");
    const inDrive = join(driveDir, name);
    if (exists(inDrive)) return inDrive.replace(/\\/g, "/");
    throw new Error(`--source: arquivo não encontrado: ${name} (procurado em ${direct} e em ${inDrive})`);
  });
}

/** A identidade do bruto no `source.json`: o caminho, ou a lista de caminhos no bruto em vários arquivos (#12559). */
export function sourceIdentity(s: Pick<SourceInfo, "path" | "files">): string {
  return s.files?.length ? s.files.map((x) => x.path).join(" | ") : s.path;
}

/**
 * #12559: mede cada arquivo e monta a linha do tempo (`combineSourceFiles`):
 * ordem de gravação pelo `creation_time` (ou a da lista, com `--ordem dada`).
 */
function probeMultiSource(paths: string[], order: FileOrder): SourceInfo {
  const mirroredDefault = configMirroredDefault();
  const probed = paths.map((p) => {
    const json = run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", p]).stdout;
    const s = parseProbe(json, p.replace(/\\/g, "/"), { mirroredDefault });
    if (s.audioOnly) throw new Error(`${p}: só áudio; o bruto em vários arquivos é de vídeo (#12559)`);
    return { info: s, creationTime: probeExtras(json).creationTime };
  });
  const c = combineSourceFiles(probed.map(({ info, creationTime }) => ({ path: info.path, fps: info.fps, durationS: info.durationS, width: info.width, height: info.height, mirrored: info.mirrored, ...(creationTime ? { creationTime } : {}) })), { order });
  if (!c.ok) throw new Error(`bruto em vários arquivos:\n  - ${c.errors.join("\n  - ")}`);
  for (const w of c.warnings) console.error(`[aviso] ${w}`);
  const first = probed.find((p) => p.info.path === c.source.files[0].path)!.info;
  return { ...c.source, mirrored: first.mirrored, ...(first.mirroredFrom ? { mirroredFrom: first.mirroredFrom } : {}), ...(first.camera ? { camera: first.camera } : {}) };
}

function cmdTranscribe(ctx: Ctx, sourceArg: string | undefined, silenceDb: number | undefined, fromAudio?: { audio: string; transcript?: string }, multi: { all?: boolean; order?: FileOrder } = {}): number {
  mkdirSync(ctx.workDir, { recursive: true });
  mkdirSync(ctx.stateDir, { recursive: true });
  // #12559: vários arquivos (`--source a,b` ou `--all`) viram uma linha do tempo.
  let multiPaths: string[] | null = null;
  const sourceJson = f(ctx, "source.json");
  // Vírgula no nome de UM arquivo ("Gravação, parte 1.mp4"): o caminho inteiro existe = bruto único.
  if (sourceArg?.includes(",") && !existsSync(resolve(sourceArg)) && !existsSync(join(ctx.driveDir, sourceArg))) multiPaths = resolveSourceList(sourceArg.split(",").filter((x) => x.trim()), ctx.driveDir);
  else if (!sourceArg && !multi.all && !fromAudio && !ctx.force && existsSync(sourceJson)) {
    // Rodar de novo sem --source numa edição já em vários arquivos: os mesmos arquivos do source.json (não recai na escolha do bruto único).
    const cachedFiles = checkedSource(readJson<SourceInfo>(sourceJson, "source.json")).files;
    if (cachedFiles?.length) multiPaths = cachedFiles.map((x) => x.path);
  }
  if (!multiPaths && multi.all) {
    if (sourceArg) throw new Error("--all e --source juntos: use um só");
    if (!existsSync(ctx.driveDir)) throw new Error(`pasta da edição no Drive não encontrada: ${ctx.driveDir}`);
    const files = looseFilesIn(ctx.driveDir);
    const raw = pickRawSource(files);
    if (!raw || raw.audioOnly) throw new Error(`--all: nenhum vídeo solto em ${ctx.driveDir}`);
    multiPaths = raw.candidates.map((c) => join(ctx.driveDir, c.name).replace(/\\/g, "/"));
  }
  if (multiPaths && multiPaths.length < 2) multiPaths = null;
  if (multiPaths) {
    if (fromAudio) throw new Error("--from-audio não vale com bruto em vários arquivos (#12559)");
    if (ctx.mode === "api") throw new Error("bruto em vários arquivos exige os arquivos locais (Drive for desktop ou --source com caminhos): o modo API baixa um bruto só (#12559)");
  }
  // #11504: a transcrição do áudio separado é guardada antes de qualquer coisa mexer no transcript.json.
  const audioPath = fromAudio ? normPath(fromAudio.audio) : undefined;
  if (audioPath && !existsSync(audioPath)) throw new Error(`--from-audio: arquivo não encontrado: ${audioPath}`);
  const audioTr = audioPath ? stashAudioTranscript(ctx, audioPath, fromAudio?.transcript) : null;
  let src = multiPaths ? multiPaths[0] : sourceArg ? resolveSourceList([sourceArg], ctx.driveDir)[0] : undefined;
  if (!src) {
    if (!existsSync(ctx.driveDir)) {
      throw new Error(`pasta da edição no Drive não encontrada: ${ctx.driveDir} (Drive for desktop montado? a pasta ${ctx.edition}/ ainda não sincronizou? espere, ou passe --from-drive para baixar pela API, ou --drive-root; desde a #12578 a pasta é a diaria-studio-video da diaria.editor: o bruto pode ter subido para a pasta antiga da vjpixel ou por outra conta)`);
    }
    const files = looseFilesIn(ctx.driveDir);
    const raw = pickRawSource(files);
    if (!raw) throw new Error(`nenhum bruto (.mp4/.mov, ou áudio .m4a/.mp3/.wav) solto em ${ctx.driveDir}; passe --source`);
    assertSingleRawVideo(raw);
    if (raw.audioOnly) console.error(`[premissa] nenhum vídeo solto em ${ctx.driveDir}; usando o áudio ${raw.pick.name} (modo áudio, #11552)`);
    if (raw.candidates.length > 1) {
      console.error(`[aviso] ${raw.candidates.length} ${raw.audioOnly ? "áudios" : "vídeos"} candidatos a bruto; usando o maior (${raw.pick.name}). Outro: --source. Candidatos: ${raw.candidates.map((c) => `${c.name} (${(c.size / 1e9).toFixed(2)} GB)`).join(", ")}`);
    }
    src = join(ctx.driveDir, raw.pick.name);
  }
  const srcPath = src.replace(/\\/g, "/");
  const sourcePath = f(ctx, "source.json");
  const trPath = f(ctx, "transcript.json");
  // #11601: o source.json de antes, para voltar a ele se o --from-audio falhar.
  const prevSourceText = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : null;
  // #11603: o transcript.json de antes, para saber se ele mudou nesta rodada.
  const prevTranscript = existsSync(trPath) ? readFileSync(trPath) : null;
  let wroteSource = false;
  let cached = existsSync(sourcePath) && !ctx.force ? checkedSource(readJson<SourceInfo>(sourcePath, "source.json")) : null;
  if (audioPath && audioPath === srcPath) throw new Error("--from-audio aponta para o próprio bruto; o áudio separado é outro arquivo (o vídeo vai em --source ou solto na pasta)");
  // --from-audio troca o bruto do áudio para o vídeo sem --force: a transcrição do áudio já está guardada.
  if (cached && audioPath && cached.path === audioPath) cached = null;
  // #12559: bruto em vários arquivos compara o CONJUNTO de arquivos (a ordem sai do probe); bruto único, o caminho.
  if (cached) {
    const wanted = multiPaths ? [...multiPaths].sort().join(" | ") : srcPath;
    const have = cached.files?.length ? cached.files.map((x) => x.path).sort().join(" | ") : cached.path;
    if (have !== wanted) throw new Error(sourceConflictMessage(sourceIdentity(cached), multiPaths ? multiPaths.join(" | ") : srcPath));
    // `--ordem dada` com outra ordem que a do source.json gravado: reordenar exige refazer tudo (review da PR #12563).
    if (multiPaths && multi.order === "dada" && cached.files && cached.files.map((x) => x.path).join(" | ") !== multiPaths.join(" | ")) {
      throw new Error(`--ordem dada pede ${multiPaths.join(" | ")}, mas o source.json tem ${sourceIdentity(cached)}: reordenar refaz a transcrição e os tempos; rode com --force (#12559)`);
    }
  }
  let source: SourceInfo;
  // source.json refeito = todos os derivados refeitos (áudio, loudness, silêncios, transcrição).
  let redo = ctx.force;
  if (cached) source = cached;
  else {
    if (multiPaths) source = probeMultiSource(multiPaths, multi.order ?? "gravacao");
    else {
      const probe = run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", src]).stdout;
      source = parseProbe(probe, srcPath, { mirroredDefault: configMirroredDefault() });
    }
    writeJson(sourcePath, source);
    wroteSource = true;
    redo = true;
  }
  if (source.files?.length) {
    console.error(`[video-montagem] bruto em ${source.files.length} arquivos, na ordem de gravação (${source.fps} fps, ${source.durationS.toFixed(1)} s no total, #12559):`);
    for (const [i, x] of source.files.entries()) {
      console.error(`  ${i + 1}. ${x.id}  ${x.width}x${x.height}${x.height > x.width ? " (vertical)" : ""}  ${(x.frames / source.fps).toFixed(1)} s  a partir de ${(x.offsetFrames / source.fps).toFixed(1)} s${x.creationTime ? `  gravado ${x.creationTime}` : ""}  mirrored=${x.mirrored ?? source.mirrored}`);
    }
    console.error("[premissa] a ordem da EDIÇÃO vem do blocks.json (blocos e itens), nunca desta ordem; item de um arquivo só: source = id (#12559)");
  } else if (source.audioOnly) {
    console.error(`[video-montagem] bruto só de áudio: ${source.path} (${source.durationS.toFixed(1)} s) — modo áudio: transcrição, decupagem e roteiro; build/srt/prévia/review param antes (#11552)`);
  } else {
    console.error(`[video-montagem] bruto: ${source.path} (${source.width}x${source.height}, ${source.fps} fps, ${source.durationS.toFixed(1)} s)`);
    console.error(`[premissa] ${mirroredPremise(source)} (#11959)`);
  }

  const audio = join(ctx.workDir, "audio.wav");
  const loudPath = f(ctx, "loudness.json");
  // #12559: no bruto em vários arquivos, o áudio de cada um é extraído e concatenado na linha do tempo global.
  const multiAudio = source.files?.length ? ensureMultiAudio(ctx, source, redo) : null;
  if (multiAudio?.rebuilt) redo = true;
  if (redo || !existsSync(audio) || !existsSync(loudPath)) {
    console.error("[video-montagem] extraindo o áudio (16 kHz mono) e medindo o loudness do bruto…");
    let stderr = "";
    const extractInput = multiAudio ? multiAudio.path : source.path;
    // #13508: a banda alta de 48 kHz (#11940) sai na MESMA leitura do bruto; a meta só é gravada
    // depois que a leitura deu certo (antes dela, a meta velha sai: banda alta sem meta é refeita).
    const highWav = join(ctx.workDir, HIGH_BAND.file);
    const highMeta = join(ctx.workDir, HIGH_BAND.meta);
    rmSync(highMeta, { force: true });
    const baseArgs = transcribeExtractArgs({ input: extractInput, audio, highBand: highWav });
    // #13508: o proxy 1440p na mesma leitura (bruto de um arquivo de vídeo, GPU + NVENC); só na 1ª leitura.
    let proxyPlan = multiAudio || source.audioOnly ? null : transcribeProxyPlan(ctx, source);
    const extract = () => {
      const r = runExtractWithProxy({
        baseArgs,
        proxy: proxyPlan,
        exec: (args) => run("ffmpeg", args).stderr,
        finish: (part) => finishProxy(ctx, source, part),
        discard: (part) => rmSync(part, { force: true }),
        warn: (line) => console.error(line),
      });
      if (r.proxy === "made") console.error(`[video-montagem] proxy ${PROXY.shortSide}p gravado (${join(ctx.workDir, PROXY.file)}): face/gaze leem dele, o XML segue no bruto (#13508)`);
      proxyPlan = null;
      stderr = r.stderr;
      return probeDurationS(audio);
    };
    if (multiAudio) extract();
    else {
      // #13417: bruto de um arquivo só, conferido contra a duração dele; relê uma vez, falta real vira aviso.
      try {
        const { realShortfallS, unchecked } = readWithRetry(source.durationS, extract, source.path, { acceptUnreadable: true });
        if (unchecked) console.error("[aviso] duração do áudio do bruto não conferida (ffprobe sem duração legível, ou duração do bruto indefinida); seguindo (#13417)");
        if (realShortfallS !== null) {
          console.error(`[aviso] o áudio do bruto tem ${realShortfallS.toFixed(2)} s a menos que o vídeo nas duas leituras (falta do próprio arquivo)`);
          console.error(`[premissa] áudio usado como está: os ${realShortfallS.toFixed(2)} s finais do vídeo ficam sem som (#13417)`);
        }
      } catch (e) {
        rmSync(audio, { force: true });
        throw e;
      }
    }
    writeJson(loudPath, parseLoudnormJson(stderr));
    if (existsSync(highWav)) writeFileAtomic(highMeta, highBandKey(extractInput, statSync(extractInput)) + "\n");
    redo = true;
  }
  const loud = readJson<ReturnType<typeof parseLoudnormJson>>(loudPath, "loudness.json");

  // #12903: o piso do bruto também conta; --silence-db continua soberano.
  const baseline = silenceNoiseDb(loud, silenceDb);
  const pcm = parseWavPcm16(readFileSync(audio));
  const measured = noiseFloorThreshold(energyEnvelope(pcm.samples, pcm.sampleRate), baseline.noiseDb, baseline.how === "override");
  const threshold = { noiseDb: measured.thresholdDb, how: measured.how === "floor" ? "floor" : baseline.how };
  const silPath = f(ctx, "silences.json");
  const silMetaPath = f(ctx, "silences.meta.json");
  const silMeta = existsSync(silMetaPath) ? readJson<{ noiseDb?: number; minDurationS?: number; how?: string; highBandVersion?: number }>(silMetaPath, "silences.meta.json") : null;
  // silences.json sem meta (anterior ao #11351) ou com outro limiar é refeito.
  const silStale = !existsSync(join(ctx.workDir, "audio-high-48k.wav")) || !existsSync(join(ctx.workDir, "audio-high-48k.meta.json")) || !silMeta || silMeta.highBandVersion !== 11968 || silMeta.noiseDb !== threshold.noiseDb || silMeta.how !== threshold.how || silMeta.minDurationS !== SILENCE_DETECT.minDurationS;
  if (redo || !existsSync(silPath) || silStale) {
    const { stderr } = run("ffmpeg", [
      "-hide_banner", "-nostats", "-i", audio,
      "-af", `silencedetect=noise=${threshold.noiseDb}dB:d=${SILENCE_DETECT.minDurationS}`, "-f", "null", "-",
    ]);
    const highEnv = highBandEnvelope(ctx, source);
    // #11968: limiar da banda alta relativo ao piso do bruto, nunca o -51 fixo sozinho.
    const highThreshold = highBandThresholdDb(highEnv);
    const low = parseSilenceDetect(stderr, source.durationS);
    const kept = intersectSilences(low, highBandSilences(highEnv, highThreshold.thresholdDb))
      .filter((q) => q.end - q.start >= SILENCE_DETECT.minDurationS);
    writeJson(silPath, kept);
    writeJson(silMetaPath, { noiseDb: threshold.noiseDb, minDurationS: SILENCE_DETECT.minDurationS, how: threshold.how, floorDb: measured.floorDb, highBandVersion: 11968, highBand: highThreshold });
    console.error(`[video-montagem] banda alta a ${highThreshold.thresholdDb} dBFS (${highThreshold.how === "relative" ? "relativo ao piso do bruto" : "piso do #11940"}): ${kept.length} pausa(s) no silences.json`);
    const loss = intersectionLossWarning(low, kept, SILENCE_DETECT.minDurationS, highThreshold);
    if (loss) console.error(`[aviso] ${loss}`);
  }
  console.error(`[video-montagem] silencedetect a ${threshold.noiseDb} dB (${threshold.how === "floor" ? "relativo ao piso de ruído do bruto" : threshold.how === "relative" ? "relativo ao loudness do bruto" : threshold.how === "override" ? "--silence-db" : "padrão, loudness não medido"})`);

  const pauseWarning = noPausesWarning(source.durationS, silences(ctx).length);
  if (pauseWarning) console.error(`[aviso] ${pauseWarning}`);

  if (audioPath && audioTr) {
    if (source.audioOnly) throw new Error("--from-audio precisa de um bruto de VÍDEO (o bruto achado é só de áudio): passe --source VIDEO");
    const prev = existsSync(trPath) ? readJson<{ aligned_from_audio?: { audio?: string; video?: string } }>(trPath, "transcript.json") : null;
    const done = !ctx.force && !redo && prev?.aligned_from_audio?.audio === audioPath && prev.aligned_from_audio.video === source.path;
    if (done) console.error(`[video-montagem] transcript.json já alinhado do áudio ${audioPath}; --force refaz`);
    else {
      try {
        alignFromAudio(ctx, source, audio, audioPath, audioTr, trPath);
      } catch (e) {
        if (!wroteSource) throw e;
        const back = rollbackSourceSwitch(ctx, prevSourceText, source.path);
        throw new Error(`${(e as Error).message}${back}`);
      }
    }
  } else if (ctx.force || !existsSync(trPath)) transcribeWithPython(ctx, audio, trPath, { vad: true });
  else if (redo) {
    // #11504: source.json novo (ou áudio refeito nesta máquina) não retranscreve por cima de um transcript.json existente.
    const prev = readJson<Transcript>(trPath, "transcript.json");
    console.error(`[aviso] ${keptTranscriptWarning(prev, source.durationS)}`);
  }
  // #11603: transcript novo renumera os segmentos e muda os tempos; a decupagem e o blocks.json de antes não valem.
  const aside = setAsideOnTranscriptChange(ctx, prevTranscript, existsSync(trPath) ? readFileSync(trPath) : null);
  if (aside.length) {
    console.error(
      `[aviso] transcript.json mudou: ${aside.map((m) => `${m.from} → ${m.to}`).join(", ")} postos de lado (números de segmento e tempos eram do transcript anterior, #11603). ` +
        "Refazer a decupagem (1ª passada) e o blocks.json; as decisões do editor estão nos arquivos .defasado para reaproveitar o texto.",
    );
  }
  const words = nonEmptyWords(trPath, "transcript.json");
  // #12935 item 2: fala (fora das pausas) sem nenhuma palavra = o VAD pode ter descartado; aponta o retranscribe sem VAD.
  for (const line of speechWithoutWordsWarnings(speechWithoutWords({ words, silences: silences(ctx), durationS: source.durationS }), ctx.edition, RETRANSCRIBE_MAX_S, source.durationS)) {
    console.error(`[aviso] ${line}`);
  }
  const warn = loudnessWarning(loud);
  if (warn) console.error(`[aviso] ${warn}`);
  console.log(
    JSON.stringify({ source: source.path, durationS: source.durationS, words: words.length, silences: silences(ctx).length, silenceDb: threshold.noiseDb, loudness: loud, stateDir: ctx.stateDir }, null, 2),
  );
  return 0;
}

/** O plano da decupagem (classificação da skill), validado contra o transcript; null se ainda não existe. */
function loadDecupagemPlan(ctx: Ctx, segments: Segment[]): DecupagemPlan | null {
  const path = f(ctx, "decupagem-plan.json");
  if (!existsSync(path)) return null;
  const parsed = parseDecupagemPlan(JSON.parse(readFileSync(path, "utf8")), segments.length);
  if (!parsed.ok) throw new Error(`decupagem-plan.json inválido:\n  - ${parsed.errors.join("\n  - ")}`);
  if (parsed.plan.edition !== ctx.edition) throw new Error(`decupagem-plan.json é da edição ${parsed.plan.edition}, não ${ctx.edition}`);
  warnVocabOnce(vocabRuleWarnings(parsed.plan.vocabulary, "decupagem-plan.json vocabulary"));
  return parsed.plan;
}

/**
 * Voz provável por segmento (#11507), pela F0 mediana no `audio.wav` do
 * `transcribe`. Sem o áudio nesta máquina, [aviso] e nada marcado. Grava
 * `voices.json` (a medida, para conferir) e devolve as marcas.
 */
function segmentVoices(ctx: Ctx, segments: Segment[], pixelF0: number | undefined): Array<VoiceMark | null> | undefined {
  const audio = join(ctx.workDir, "audio.wav");
  if (!existsSync(audio)) {
    console.error(`[aviso] áudio do bruto ausente (${audio}): voz dos segmentos não medida (#11507); rode transcribe nesta máquina`);
    return undefined;
  }
  const { sampleRate, samples } = parseWavPcm16(readFileSync(audio));
  const f0s = segmentF0s(samples, sampleRate, segments);
  const speech = segments.map((s) => speechSeconds(s));
  const v = classifyVoices(f0s, speech, { pixelHz: pixelF0 });
  writeJson(f(ctx, "voices.json"), { ...v, segments: segments.map((s, i) => ({ n: i + 1, start: s.start, end: s.end, speech_s: speech[i], f0: f0s[i] })) });
  const hz = (x: number | null) => (x === null ? "?" : `${Math.round(x)} Hz`);
  if (!v.twoVoices) console.error(`[video-montagem] voz: uma só (F0 ~${hz(v.pixelHz)}); nada marcado`);
  else {
    const n = (l: string) => v.marks.filter((m) => m?.label === l).length;
    console.error(
      `[video-montagem] voz: duas (Pixel ~${hz(v.pixelHz)}${v.pixelFrom === "maior-tempo" ? ", a de mais tempo de fala [premissa]" : ", --pixel-f0"}; outra ~${hz(v.otherHz)}): ` +
        `${n("outra")} segmento(s) da entrevistadora, ${n("ouvir")} para ouvir (#11507)`,
    );
  }
  return v.twoVoices ? v.marks : undefined;
}

/** `--pixel-f0` (#11507): F0 de referência do Pixel em Hz; ausente = a voz de mais tempo de fala. */
/** `--ordem gravacao|dada` (#12559): a linha do tempo pelo creation_time (default) ou na ordem do `--source`. */
export function parseFileOrderArg(raw: string | undefined): FileOrder | undefined {
  if (raw === undefined) return undefined;
  if (raw === "gravacao" || raw === "dada") return raw;
  throw new Error(`--ordem precisa ser gravacao ou dada (recebido: ${raw})`);
}

export function parsePixelF0Arg(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 60 || n > 400) throw new Error(`--pixel-f0 precisa ser a F0 em Hz entre 60 e 400 (ex.: 163), não ${raw}`);
  return n;
}

/**
 * #13587: retranscreve as janelas pedidas numa chamada só do Whisper
 * (`--windows`, sem VAD e sem `condition_on_previous_text`; o residente da
 * #13506 atende) e grava cada uma como o `retranscribe` gravaria:
 * `retranscribe-{de}-{até}.json` (janela) ou `retranscribe-sub-{de}-{até}.json`
 * (subjanela, com `sub.window`). Sem o `audio.wav` nesta máquina, false.
 */
function retranscribeWindowsBatch(ctx: Ctx, wins: Array<{ key: string; start: number; end: number }>, kind: "janela" | "sub"): boolean {
  const audio = join(ctx.workDir, "audio.wav");
  if (!existsSync(audio)) return false;
  if (!wins.length) return true;
  mkdirSync(ctx.workDir, { recursive: true });
  const tag = kind === "sub" ? "sub" : "janelas";
  const winFile = join(ctx.workDir, `retranscribe-${tag}-windows.json`);
  const raw = join(ctx.workDir, `retranscribe-${tag}.raw.json`);
  writeFileSync(winFile, JSON.stringify(wins));
  console.error(`[video-montagem] retranscrevendo ${wins.length} ${kind === "sub" ? "subjanela(s)" : "janela(s)"} numa chamada só (sem VAD, ${kind === "sub" ? "#11958" : "#13587"})…`);
  const vocab = loadVocab();
  run(ctx.python, ["-P", PY_HELPER, audio, raw, "--windows", winFile, "--no-condition", "--initial-prompt", vocab.whisper_prompt ?? ""], {
    env: { ...process.env, HF_HUB_OFFLINE: "1" },
    inheritStderr: true,
  });
  const out = readJson<{ windows: Array<{ key: string; start: number; end: number; segments: Segment[] }> }>(raw, kind === "sub" ? "retranscrição das subjanelas" : "retranscrição das janelas");
  for (const w of out.windows) {
    // Prefixo próprio na subjanela: nunca sobrescreve a retranscrição da janela inteira de mesmo intervalo.
    const t: Transcript = kind === "sub" ? { segments: w.segments, sub: { window: { start: w.start, end: w.end } } } : { segments: w.segments };
    writeJson(f(ctx, kind === "sub" ? subWindowFileName(w.key) : windowFileName(w.key)), t);
    if (kind === "sub") console.log(`== ${w.key} s: ${w.segments.map((s) => s.text.trim()).join(" ") || "(nada)"}`);
  }
  return true;
}

/** A retranscrição gravada (`retranscribe-*.json`) daquele nome, ou null. */
function readRetranscribed(ctx: Ctx, name: string): Transcript | null {
  const p = f(ctx, name);
  return existsSync(p) ? readJson<Transcript>(p, name) : null;
}

/**
 * #13587: os segmentos numerados da decupagem. Com `decupagem-segments.json`
 * (a listagem congelada da 1ª passada), eles; sem ele (plano anterior ao
 * #13587), os do transcript.
 */
function decupagemListing(ctx: Ctx, tr: Transcript): { segments: Segment[]; origin: ListingOrigin[] | null } {
  const p = f(ctx, DECUPAGEM_SEGMENTS_FILE);
  return listingSegments(tr.segments, existsSync(p) ? readJson<unknown>(p, DECUPAGEM_SEGMENTS_FILE) : null, ctx.edition);
}

/**
 * `decupagem` 2ª passada com uma exceção do #13600 (tomada colapsada não
 * separada, "usar" contra a direção sem motivo, espelhamento ambíguo que o
 * `frame` não decidiu): os arquivos saem gravados, mas a skill para e resolve
 * com o editor antes do `blocks.json`. Sem exceção, exit 0 e segue.
 */
export const EXIT_DECUPAGEM_PARADA = 5;
/** Decisão do Gate 1 (#13600), no state dir: `{ decision, stops, premissas }`. */
export const DECUPAGEM_GATE_FILE = "decupagem-gate.json";

function cmdDecupagem(ctx: Ctx, pixelF0?: number, retranscribe = true, espelhoAmbiguo = false): number {
  const tr = readJson<Transcript>(f(ctx, "transcript.json"), "transcript.json (rode transcribe)");
  const silPath = f(ctx, "silences.json");
  const sil = existsSync(silPath) ? readJson<Interval[]>(silPath, "silences.json") : [];
  // #13544: outro vídeo solto na pasta além do bruto (o CTA gravado à parte, na 261118): avisar nas duas passadas.
  warnLooseVideos(ctx, measuredSource(ctx));
  const planExists = existsSync(f(ctx, "decupagem-plan.json"));
  if (!planExists) {
    // 1ª passada: a listagem numerada e o molde do plano, para a skill classificar (#11361). #13587: a tomada
    // colapsada já sai resolvida pela retranscrição da janela (numa chamada só), com as tomadas separadas.
    const res = resolveCollapsedListing(tr.segments, sil, tr.duration, {
      readWindow: (k) => readRetranscribed(ctx, windowFileName(k)),
      readSub: (k) => readRetranscribed(ctx, subWindowFileName(k)),
      transcribeWindows: (wins, kind) => retranscribeWindowsBatch(ctx, wins, kind),
    }, { retranscribe });
    if (res.audioMissing) console.error(`[aviso] áudio do bruto ausente (${join(ctx.workDir, "audio.wav")}): tomada colapsada sem retranscrição nesta máquina; rode transcribe aqui ou retranscribe à mão (#13587)`);
    for (const u of res.unresolved) {
      const s = tr.segments[u.job.segment];
      console.error(`[aviso] segmento ${u.job.segment + 1} do transcript (${clockTime(s.start)}–${clockTime(s.end)}): ${res.origin.find((o) => o.original === u.job.segment + 1 && !o.retranscribed)?.note ?? "possível tomada colapsada"}`);
    }
    if (res.jobs.length) console.error(`[video-montagem] decupagem: ${res.jobs.length} segmento(s) com tomada colapsada, ${res.resolved} separado(s) pela retranscrição (${res.transcribed.windows} janela(s) e ${res.transcribed.subs} subjanela(s) retranscritas agora, #13587)`);
    const segments = res.segments;
    writeJson(f(ctx, DECUPAGEM_SEGMENTS_FILE), freezeListing(ctx.edition, tr.segments, res));
    const notes = res.origin.map((o) => o.note);
    const voices = segmentVoices(ctx, segments, pixelF0);
    const tplPath = f(ctx, "decupagem-plan.template.json");
    writeJson(tplPath, decupagemPlanTemplate(ctx.edition, segments, voices, notes));
    process.stdout.write(segmentListing(segments, voices, notes));
    console.error(`[video-montagem] decupagem: classificar os segmentos acima em ${f(ctx, "decupagem-plan.json")} (molde: ${tplPath}) e rodar decupagem de novo`);
    return 0;
  }
  const { segments, origin } = decupagemListing(ctx, tr);
  // Tomada colapsada (#11754): sem a listagem do #13587 (plano anterior), o aviso de antes, com a janela do retranscribe.
  if (!origin) for (const line of collapsedSegmentWarnings(ctx.edition, segments, sil, tr.duration)) console.error(`[aviso] ${line}`);
  const plan = loadDecupagemPlan(ctx, segments)!;
  // Decisão por critério (#11364): uma tomada por frase, a direção decide antes da "alternativa".
  const crit = checkDecupagemCriteria(plan, segments);
  for (const w of crit.warnings) console.error(`[aviso] ${w}`);
  if (crit.errors.length) throw new Error(`decupagem-plan.json não decide por critério:\n  - ${crit.errors.join("\n  - ")}`);
  // #12093: o gancho (1ª frase do resumo) abre o horizontal; o Doc e o molde já o trazem separado.
  const planned = buildDecupagemDoc(plan, segments, loadVocab().rules);
  const proposed = proposeGancho(planned, segments);
  if (proposed.note) console.error(`[premissa] ${proposed.note}`);
  const doc = proposed.doc;
  const source = measuredSource(ctx);
  // Sem título nem resumo "usar", é entrevista (#11507): sequências sem esses blocos.
  const blocks = blocksFromDecupagem(doc);
  const { format } = effectiveFormat({ blocks });
  if (format === "entrevista") console.error("[premissa] nenhum título nem resumo na decupagem: formato entrevista, sequências abertura → comentário → CTA → fecho (#11507); `format`/`sequences` no blocks.json sobrepõem");
  // #12586: a frase falada de abertura no `gancho` (sem `titulo`) abre as duas versões no molde. Só o
  // gancho escrito no plano conta: o proposto da 1ª frase do resumo (#12093) é só do horizontal.
  const opening = decupagemOpeningBlock(planned);
  if (format === "monologo" && opening === "gancho") console.error("[premissa] decupagem sem título falado e com gancho: o gancho abre as duas versões, com o PNG do título, o respiro e a vinheta nele (#12586)");
  const sequences = defaultSequences("V1", format, opening);
  const durations = suggestedDurations(doc, sequences);
  for (const d of durations) {
    if (d.overS > 0) console.error(`[aviso] ${d.spec.name}: ~${d.totalS.toFixed(1)} s na montagem sugerida, ${d.overS.toFixed(1)} s acima do teto do Shorts (${SHORTS_MAX_S} s, antes de tirar os silêncios): propor o corte no Doc`);
  }
  const alts = plan.blocks.reduce((n, b) => n + b.rows.filter((r) => r.suggestion === "alternativa").length, 0);
  if (alts) console.error(`[video-montagem] decupagem: ${alts} linha(s) "alternativa": cada uma é dúvida real, com a justificativa (nenhum critério decidiu)`);
  const md = decupagemMarkdown(ctx.edition, doc, sequences);
  writeFileAtomic(f(ctx, "decupagem.md"), md);
  const tpl = f(ctx, "blocks.template.json");
  const template: BlocksFile = {
    edition: ctx.edition,
    mirrored: source.mirrored,
    ...(plan.vocabulary !== undefined ? { vocabulary: plan.vocabulary } : {}),
    ...(format === "entrevista" ? { format } : {}),
    blocks,
    sequences,
  };
  writeJson(tpl, template);
  process.stdout.write(md);
  console.error(`[video-montagem] decupagem: ${f(ctx, "decupagem.md")}; molde do blocks.json (falas "usar"): ${tpl}`);
  // #13600: o Gate 1 não é mais parada obrigatória; só para numa exceção que o Gate 2 não resolve.
  const loudPath = f(ctx, "loudness.json");
  let loudness: string | null = null;
  if (existsSync(loudPath)) {
    const l = readJson<{ inputI?: number; inputTp?: number } | null>(loudPath, "loudness.json");
    if (l && Number.isFinite(l.inputI)) loudness = `${l.inputI!.toFixed(1)} LUFS integrado${Number.isFinite(l.inputTp) ? `, true peak ${l.inputTp!.toFixed(1)} dBTP` : ""} (a prévia sai normalizada; o build aplica o ganho)`;
  }
  const gate = decupagemGate({
    plan,
    origin,
    legacyCollapsed: origin ? [] : segments.flatMap((s, i) => (collapsedTakeSuspects(s.words ?? [], sil, { durationS: tr.duration }).length ? [i + 1] : [])),
    contraDirecao: crit.contraDirecao,
    mirror: {
      premise: mirroredPremise(source),
      ambiguous: !source.audioOnly && source.mirroredFrom !== "camera-metadata",
      frameUnresolved: espelhoAmbiguo,
    },
    takes: decupagemTakeLines(plan, decideTakes(segments).bySegment),
    durations: durations.map((d) => ({ name: d.spec.name, totalS: d.totalS, overS: d.overS })),
    verticalMaxS: SHORTS_MAX_S,
    loudness,
    alternativas: alts,
  });
  writeJson(f(ctx, DECUPAGEM_GATE_FILE), gate);
  for (const line of decupagemGateBanner(gate, f(ctx, "decupagem.md"))) console.error(line);
  return gate.decision === "para" ? EXIT_DECUPAGEM_PARADA : 0;
}

/** `blocks --from-plan` sem `roteiro-falas.json`: a edição não tem roteiro de gravação (mesmo código do `video-roteiro-blocos.ts`). */
export const EXIT_BLOCKS_SEM_ROTEIRO = 3;

/**
 * `blocks AAMMDD --from-plan [--force] [--falas PATH]` (#13463): o `blocks.json`
 * do molde da decupagem + a proposta do roteiro de gravação, no lugar do script
 * ad-hoc. Valida o resultado inteiro (`parseBlocksFile`) antes de gravar; nunca
 * sobrescreve um `blocks.json` sem `--force` (o anterior fica em
 * `blocks.antes-from-plan.json`).
 */
function cmdBlocks(ctx: Ctx, fromPlan: boolean, force: boolean, falasArg: string | undefined): number {
  if (!fromPlan) throw new Error("blocks exige --from-plan (o blocks.json do molde da decupagem + a proposta do roteiro, #13463)");
  const tplPath = f(ctx, "blocks.template.json");
  const tplParsed = parseBlocksFile(readJson<unknown>(tplPath, "blocks.template.json (rode decupagem com o decupagem-plan.json)"));
  if (!tplParsed.ok) throw new Error(`blocks.template.json inválido:\n  - ${tplParsed.errors.join("\n  - ")}`);
  if (tplParsed.file.edition !== ctx.edition) throw new Error(`blocks.template.json é da edição ${tplParsed.file.edition}, não ${ctx.edition}`);
  const falasPath = falasArg ?? join(editionDirFor(ctx.edition), ROTEIRO_FALAS_FILE);
  if (!existsSync(falasPath)) {
    console.error(`[video-montagem] blocks: sem ${falasPath} (edição sem roteiro pela /diaria-video-roteiro): escrever o blocks.json a partir do molde, como antes (#13463)`);
    return EXIT_BLOCKS_SEM_ROTEIRO;
  }
  const roteiro = parseRoteiroFalas(readJson<unknown>(falasPath, "roteiro-falas.json"));
  if (!roteiro.ok) throw new Error(`${falasPath} inválido:\n  - ${roteiro.problemas.join("\n  - ")}`);
  const proposta = propostaBlocosDoRoteiro(roteiro.roteiro);
  const { file, avisos } = blocksFromPlan(tplParsed.file, proposta);
  for (const a of avisos) console.error(`[aviso] ${a}`);
  const parsed = parseBlocksFile(JSON.parse(JSON.stringify(file)));
  if (!parsed.ok) throw new Error(`o blocks.json montado não passa na validação (nada gravado):\n  - ${parsed.errors.join("\n  - ")}`);
  const path = f(ctx, "blocks.json");
  if (existsSync(path)) {
    if (!force) throw new Error(`${path} já existe: blocks --from-plan não sobrescreve sem --force (o atual vai para blocks.antes-from-plan.json)`);
    copyFileSync(path, f(ctx, "blocks.antes-from-plan.json"));
  }
  writeFileAtomic(path, JSON.stringify(file, null, 2) + "\n");
  const n = Object.values(file.blocks).reduce((s, l) => s + (l?.length ?? 0), 0);
  console.error(`[video-montagem] blocks --from-plan: ${n} item(ns) em ${path}${avisos.length ? `, ${avisos.length} aviso(s) acima` : ""}; conferir o diff antes do face/roteiro (#13463)`);
  return 0;
}

/**
 * Um aviso por segmento com suspeita de tomada colapsada (#11754): o Whisper
 * registrou uma tomada só onde houve várias. Numeração 1-based da listagem.
 */
export function collapsedSegmentWarnings(edition: string, segments: Segment[], silences: Interval[], durationS?: number): string[] {
  const out: string[] = [];
  segments.forEach((s, i) => {
    const sus = collapsedTakeSuspects(s.words ?? [], silences, { durationS });
    if (!sus.length) return;
    const w = sus[0].window;
    out.push(
      `segmento ${i + 1} (${clockTime(s.start)}–${clockTime(s.end)}): possível tomada colapsada, ${describeCollapsedSuspect(sus[0])}: ` +
        `retranscribe ${edition} --from ${w.start.toFixed(1)} --to ${w.end.toFixed(1)} antes de decidir; com as tomadas separadas, a última vale, salvo aprovação da direção (#11754)`,
    );
  });
  return out;
}

/**
 * Retranscreve só um trecho do bruto (#11364), sem VAD e sem
 * `condition_on_previous_text`: comentário da direção e começo de frase depois
 * de pausa saem errados na transcrição longa ("bom" por "primeiro" na 261028).
 * Imprime os segmentos no tempo do bruto; não mexe no `transcript.json`.
 */
function cmdRetranscribe(ctx: Ctx, from: string | undefined, to: string | undefined, sub = false): number {
  const source = measuredSource(ctx);
  const w = retranscribeWindow(from, to, source.durationS);
  if (!w.ok) throw new Error(w.error);
  const audio = join(ctx.workDir, "audio.wav");
  if (!existsSync(audio)) throw new Error(`áudio do bruto ausente (${audio}): rode transcribe de novo nesta máquina`);
  if (sub) return retranscribeSubWindows(ctx, audio, w.window);
  const tag = `${w.window.start.toFixed(1)}-${w.window.end.toFixed(1)}`;
  const wav = join(ctx.workDir, `retranscribe-${tag}.wav`);
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", w.window.start.toFixed(3), "-to", w.window.end.toFixed(3), "-i", audio, "-ac", "1", "-ar", "16000", wav]);
  const raw = join(ctx.workDir, `retranscribe-${tag}.json`);
  transcribeWithPython(ctx, wav, raw, { vad: false, noCondition: true });
  const shifted = offsetTranscript(readJson<Transcript>(raw, "retranscrição"), w.window.start);
  const out = f(ctx, `retranscribe-${tag}.json`);
  writeJson(out, shifted);
  for (const s of shifted.segments) console.log(`[${clockTime(s.start)}–${clockTime(s.end)}] ${s.text.trim()}`);
  console.error(`[video-montagem] retranscrição do trecho: ${out} (o transcript.json fica como está; a correção vai no text do decupagem-plan.json)`);
  console.error("[video-montagem] item do blocks.json com tomada colapsada coberto por esta janela passa a usar a tomada separada aqui (a última, salvo aprovação da direção) no próximo roteiro/build (#11754)");
  return 0;
}

/**
 * `retranscribe --sub` (#11958): a janela em subjanelas curtas (`subWindows`,
 * 4 s com passo de 2 s), numa chamada só do Python, sem VAD e sem
 * `condition_on_previous_text`. Cada subjanela vira um `retranscribe-{de}-{até}.json`
 * como o da janela inteira; o `roteiro`/`build` juntam as que cobrem uma
 * tomada colapsada e procuram o falso começo (`findRepetitionCut`).
 */
function retranscribeSubWindows(ctx: Ctx, audio: string, window: Interval): number {
  const wins = subWindows(window).map((w) => ({ key: retranscribeKey(w), start: w.start, end: w.end }));
  console.error(`[video-montagem] subjanelas de ${window.start.toFixed(1)}–${window.end.toFixed(1)} s (#11958)`);
  if (!retranscribeWindowsBatch(ctx, wins, "sub")) throw new Error(`áudio do bruto ausente (${audio}): rode transcribe de novo nesta máquina`);
  console.error("[video-montagem] subjanelas gravadas como retranscribe-sub-*.json: o roteiro/build procuram o falso começo nelas e propõem o corte na linha repetição (#11958)");
  return 0;
}

function cmdFrame(ctx: Ctx, at: string | undefined): number {
  const t = Number(at);
  if (at === undefined || !Number.isFinite(t) || t < 0) throw new Error("frame exige --at SEGUNDOS");
  // Antes do gate 1 não há blocks.json: vale o mirrored do source.json (e o framing da 261027).
  warnConflictOnly(f(ctx, "blocks.json"));
  const blocks = existsSync(f(ctx, "blocks.json")) ? loadBlocks(ctx).file : null;
  const source = blocks ? sourceFor(ctx, blocks) : sourceFor(ctx);
  const base = effectiveFraming(blocks ?? {}).framing;
  // #12559: bruto em vários arquivos: --at é o tempo global; o frame sai do arquivo daquele instante, com o tamanho e o framing dele.
  const at0 = frameAt(source, t);
  const framing = at0.multi ? framingOfFile(base, blocks ?? {}, at0.view.id) : base;
  if (at0.multi) console.error(`[video-montagem] ${t.toFixed(1)} s = ${at0.view.id} em ${at0.localS.toFixed(2)} s (${at0.view.width}x${at0.view.height}, #12559)`);
  const out = f(ctx, `frame-${t.toFixed(1)}.jpg`);
  // #11939: os recortes de cada escala sobre o bruto desespelhado, antes do scale, em px do bruto.
  const overlays = frameCropOverlays(at0.view, framing);
  const vf = `${at0.view.mirrored ? "hflip," : ""}${overlays.filters.join(",")},scale=960:-2,drawgrid=w=iw/10:h=ih/10:t=1:c=white@0.6`;
  runDecode(["-hide_banner", "-v", "error", "-y", "-ss", String(at0.localS), "-i", at0.view.path, "-frames:v", "1", "-vf", vf, out], "frame");
  console.log(out);
  for (const w of overlays.warnings) console.error(`[aviso] ${w}`);
  for (const w of overlays.premises) console.error(`[premissa] ${w}`);
  console.error(`[video-montagem] mirrored=${source.mirrored}; grade em décimos: centro do rosto (faceX), linha dos olhos (eyeY), linha da boca (mouthY) e caixa da caneca (framing.mug) em fração do quadro, no framing do blocks.json; recortes: ${frameCropLegend()} (#11939, #12565)`);
  return 0;
}

// ── Bruto em vários arquivos: inventário (#12559) ─────────────────────────

/** O texto do D1 de uma edição (título + corpo), para o inventário casar a fala; null sem `02-reviewed.md`. */
function readD1Text(edition: string): string | null {
  const path = join(editionDirFor(edition), "02-reviewed.md");
  if (!existsSync(path)) return null;
  const d1 = parseDestaques(readFileSync(path, "utf8")).find((d) => d.n === 1);
  return d1 ? `${d1.title} ${d1.body} ${d1.why}` : null;
}

/** A edição do dia útil seguinte (seg–sex), para o inventário propor as duas edições de uma sessão de gravação. */
export function nextWeekdayEdition(edition: string): string {
  const d = new Date(Date.UTC(2000 + Number(edition.slice(0, 2)), Number(edition.slice(2, 4)) - 1, Number(edition.slice(4, 6))));
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return `${String(d.getUTCFullYear() % 100).padStart(2, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Segundos ouvidos por arquivo no `inventory --listen` (transcrição leve: o começo de cada arquivo). */
export const INVENTORY_LISTEN_S = 45;

/**
 * `inventory AAMMDD [--dir PASTA] [--editions A,B] [--listen]` (#12559 item 5):
 * lista os vídeos da pasta (default: a da edição), na ordem de gravação, com
 * tamanho e orientação, e PROPÕE o papel de cada um (mestre horizontal em
 * partes, vertical nativa) e a edição pela fala (casada com o D1 das edições
 * candidatas: a do argumento e a do dia útil seguinte). `--listen` transcreve
 * os primeiros 45 s de cada arquivo; sem ele, a fala só entra se o arquivo já
 * está no `source.json` transcrito desta edição. Não move, não copia, não
 * grava nada além do relatório: o editor confirma e roda `transcribe --source`
 * com a lista de cada edição.
 */
function cmdInventory(ctx: Ctx, dirArg: string | undefined, editionsArg: string | undefined, listen: boolean): number {
  const dir = resolve(dirArg ?? ctx.driveDir);
  if (!existsSync(dir)) throw new Error(`inventory: pasta não encontrada: ${dir}`);
  const names = looseFilesIn(dir);
  const raw = pickRawSource(names);
  if (!raw || raw.audioOnly) throw new Error(`inventory: nenhum vídeo solto em ${dir}`);
  const mirroredDefault = configMirroredDefault();
  // A fala já transcrita desta edição, por arquivo (bruto em vários arquivos), quando houver.
  const known = existsSync(f(ctx, "source.json")) && existsSync(f(ctx, "transcript.json")) ? measuredSource(ctx) : null;
  const knownWords = known?.files?.length ? nonEmptyWords(f(ctx, "transcript.json"), "transcript.json") : [];
  const files: InventoryFile[] = raw.candidates.map(({ name }) => {
    const path = join(dir, name).replace(/\\/g, "/");
    const json = run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]).stdout;
    const s = parseProbe(json, path, { mirroredDefault });
    const creationTime = probeExtras(json).creationTime;
    let heard: string | undefined;
    const kf = known?.files?.find((x) => x.path === path);
    if (kf && known) {
      const a = kf.offsetFrames / known.fps;
      const b = (kf.offsetFrames + kf.frames) / known.fps;
      heard = joinWordTexts(knownWords.filter((w) => w.start >= a && w.end <= b).map((w) => w.text));
    } else if (listen) {
      const out = join(ctx.workDir, "inventory");
      mkdirSync(out, { recursive: true });
      const wav = join(out, `${name}.wav`);
      const tj = join(out, `${name}.transcript.json`);
      if (!existsSync(tj)) {
        run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", path, "-map", "0:a:0", "-vn", "-t", String(INVENTORY_LISTEN_S), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
        transcribeWithPython(ctx, wav, tj, { vad: true });
      }
      heard = joinWordTexts(transcriptWords(readJson<Transcript>(tj, "transcrição do inventário")).map((w) => w.text));
    }
    return { name, path, width: s.width, height: s.height, durationS: s.durationS, fps: s.fps, ...(creationTime ? { creationTime } : {}), ...(heard ? { heard } : {}) };
  });
  const editions = (editionsArg ?? `${ctx.edition},${nextWeekdayEdition(ctx.edition)}`).split(",").map((e) => e.trim()).filter(Boolean);
  const badEd = editions.filter((e) => !/^\d{6}$/.test(e));
  if (badEd.length) throw new Error(`--editions: ${badEd.join(", ")} não é AAMMDD`);
  const d1: Record<string, string> = {};
  for (const e of editions) {
    const t = readD1Text(e);
    if (t) d1[e] = t;
    else console.error(`[aviso] inventory: ${e} sem D1 escrito (02-reviewed.md); arquivos dela ficam sem edição proposta`);
  }
  const rows = proposeRoles(files, d1);
  const fpsSet = new Set(rows.map((r) => r.fps));
  console.error(`[video-montagem] ${rows.length} vídeos em ${dir}, na ordem de gravação (#12559):`);
  for (const [i, r] of rows.entries()) {
    const role = r.role === "mestre-horizontal" ? `mestre horizontal${r.part ? ` parte ${r.part}` : ""}` : r.role === "vertical-nativa" ? "vertical nativa" : "papel desconhecido";
    console.error(`  ${i + 1}. ${r.name}  ${r.width}x${r.height}  ${r.durationS.toFixed(1)} s  ${r.creationTime ?? "sem creation_time"}  -> ${role}${r.edition ? `, edição ${r.edition} (${r.editionScore} termos do D1)` : ", edição: confirmar"}`);
    if (r.insertion) console.error(`     entra ${r.insertion}; ${r.note}`);
    if (r.heard) console.error(`     fala: "${r.heard.slice(0, 140)}${r.heard.length > 140 ? "…" : ""}"`);
  }
  if (fpsSet.size > 1) console.error(`[aviso] fps diferentes (${[...fpsSet].join(", ")}): o transcribe recusa misturar; converta antes`);
  // O comando por edição, para o editor confirmar.
  const byEdition = new Map<string, InventoryRow[]>();
  for (const r of rows) if (r.edition) byEdition.set(r.edition, [...(byEdition.get(r.edition) ?? []), r]);
  for (const [e, rs] of byEdition) {
    console.error(`[proposta] ${e}: npx tsx scripts/video-montagem.ts transcribe ${e} --source "${rs.map((r) => r.path).join(",")}"`);
  }
  if (!listen && !knownWords.length) console.error("[premissa] sem --listen: papel só pela orientação e ordem; a edição de cada arquivo sai do D1 com --listen (transcreve 45 s de cada)");
  console.log(JSON.stringify({ dir, editions: Object.keys(d1), files: rows }, null, 2));
  return 0;
}

// ── Verificação independente do XML (#12561) ──────────────────────────────

/**
 * #13424: a envoltória de energia da faixa tratada (a que o XML toca) para medir
 * as bordas do verify-xml, no mesmo eixo de tempo do bruto (a faixa tem a duração
 * dele). Sem faixa tratada registrada (`--no-audio-clean`, build antigo) devolve
 * `env: null` e o chamador mede o bruto como sempre; faixa registrada mas ausente
 * ou ilegível também cai no bruto, com `warning`.
 */
export function treatedEdgeEnvelope(ctx: Ctx, key: string, treatedPath: string | undefined): { env: Envelope | null; warning?: string } {
  if (!treatedPath) return { env: null };
  if (!existsSync(treatedPath)) return { env: null, warning: `faixa tratada ${treatedPath} ausente nesta máquina: bordas medidas no bruto (rode build aqui para medir na tratada, #13424)` };
  try {
    const dir = join(ctx.workDir, `verify-${key}`);
    mkdirSync(dir, { recursive: true });
    const wav = join(dir, "tratada-16k.wav");
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", treatedPath, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    const { samples, sampleRate } = parseWavPcm16(readFileSync(wav));
    return { env: energyEnvelope(samples, sampleRate) };
  } catch (e) {
    return { env: null, warning: `faixa tratada ${treatedPath} ilegível (${(e as Error).message}): bordas medidas no bruto (#13424)` };
  }
}

/**
 * `verify-xml AAMMDD [--seq KEY] [--no-transcribe]` (#12561): para cada XML do
 * build, lê os clipitem de áudio do PRÓPRIO arquivo (como o Premiere), remonta
 * o áudio do bruto só com eles (cortes secos), mede a energia logo fora de
 * cada borda ("SOM CORTADO") e transcreve o áudio montado contra o roteiro
 * aprovado (`fala-faltando`/`fala-extra`). Critério de saída antes da prévia:
 * zero bordas cortadas e transcrição batendo. Funciona com o XML de vários
 * arquivos (`file-{k}` em quadros locais) e com a faixa tratada (`file-audio`).
 */
function cmdVerifyXml(ctx: Ctx, target: string | undefined, transcribe = true): number {
  const pf = loadPlan(ctx);
  const chosen = target ? pickPlans(pf.plans, target, false, true) : pf.plans;
  const audio = join(ctx.workDir, "audio.wav");
  if (!existsSync(audio)) throw new Error(`verify-xml: ${audio} ausente (rode transcribe nesta máquina)`);
  const { samples, sampleRate } = parseWavPcm16(readFileSync(audio));
  const env = energyEnvelope(samples, sampleRate);
  const silenceMeta = f(ctx, "silences.meta.json");
  const edgeThreshold = verifyXmlEdgeThreshold(existsSync(silenceMeta) ? readJson<SilencesMeta>(silenceMeta, "silences.meta.json") : null);
  const thr = edgeThreshold.thresholdDb;
  console.error(`[video-montagem] verify-xml: bordas a ${thr} dBFS (${edgeThreshold.from}, o limiar do refino do build); piso do bruto ${edgeThreshold.floorDb?.toFixed(1) ?? "não medido"} dBFS (#12903, #12969)`);
  console.error(`[video-montagem] verify-xml: cada borda também contra o piso de ruído local + ${LOCAL_FLOOR_EDGE.marginDb} dB (±${LOCAL_FLOOR_EDGE.windowS} s, nunca abaixo de ${LOCAL_FLOOR_EDGE.minThresholdDb} dBFS nem acima de ${thr} dBFS); entre o relativo e o fixo, erro só com energia sustentada por ${Math.round(SUSTAINED_EDGE.minS * 1000)} ms que o build abriria (silêncio antes do limite dele: teto de ${CUT_EDGE_OPEN.maxS} s, palavra vizinha, clipe vizinho), senão [aviso] (#13194)`);
  if (edgeThreshold.warning) console.error(`[aviso] ${edgeThreshold.warning}`);
  const offsets = sourceFiles(pf.source).map((x) => x.offsetFrames);
  // #13194: os limites da abertura do build (palavras vizinhas, roteiro, filler), para erro ser só o que ele abriria.
  const edgeWordsInput = readVerifyEdgeWordsInput(ctx, audio);
  const edgeWarned = new Set<string>();
  let bad = 0;
  let cutTotal = 0;
  let softTotal = 0;
  // #13488: os trechos do XML leve contra a mídia real (o resto confere contra a <duration> do <file>, a do nome).
  const xmlTexts = chosen.map((p) => join(ctx.outDir, xmlFileName(p.spec.name))).filter((p) => existsSync(p)).map((p) => readFileSync(p, "utf8"));
  // #13500: e os trechos inseridos de cada sequência escolhida, contra o arquivo no out dir.
  const inseridosXml = chosen.flatMap((p) => pf.xmlAssets?.[sequenceKey(p.spec)]?.trechosInseridos ?? []);
  const mediaIssues = trechoMediaIssues(xmlTexts, join(ctx.outDir, TRECHOS.dirName), cachedTrechoProbe(trechoFramesCachePath(ctx.workDir)), { dir: ctx.outDir, clips: inseridosXml });
  for (const x of mediaIssues) console.log(`[erro] ${x}`);
  bad += mediaIssues.length;
  const report: Record<string, unknown> = {};
  for (const plan of chosen) {
    const key = sequenceKey(plan.spec);
    const xmlPath = join(ctx.outDir, xmlFileName(plan.spec.name));
    if (!existsSync(xmlPath)) throw new Error(`verify-xml: ${xmlPath} ausente (rode build)`);
    const xmlText = readFileSync(xmlPath, "utf8");
    const parsedXml = parseXmlAudio(xmlText);
    // #13437 (PR 2): o trecho inserido abre espaço só no XML; a conferência contra o plano é sem ele.
    const trechosXml = pf.xmlAssets?.[key]?.trechosInseridos ?? [];
    const trechoTotal = trechoRipple(trechosXml).total;
    const parsed = trechosXml.length ? { ...parsedXml, clips: unrippleXmlClips(parsedXml.clips, trechosXml, plan.clips) } : parsedXml;
    if (trechosXml.length) console.error(`[video-montagem] verify-xml ${key}: ${trechosXml.length} trecho(s) inserido(s) (${(trechoTotal / pf.source.fps).toFixed(1)} s) tirados da conta; a fala deles não é conferida contra o roteiro (#13437)`);
    const { clips, errors } = toTimeline(parsed, offsets);
    // #12571: o card de CTA no fim da V1 (sem áudio): logo depois da fala, com a duração do plano.
    const cardFrames = pf.xmlAssets?.[key]?.ctaCard?.frames ?? null;
    const issues = [...errors, ...xmlStructureIssues(parsed.clips), ...xmlPlanIssues(parsed, { clips: plan.clips.length, durationFrames: plan.durationFrames }), ...ctaCardXmlIssues(xmlText, { durationFrames: plan.durationFrames + trechoTotal, cardFrames }), ...capaInicioXmlIssues(xmlText, capaFramesOf(pf.xmlAssets?.[key]?.capaInicio, plan.durationFrames))];
    if (parsed.timebase !== pf.source.fps || parsed.ntsc) issues.push(`timebase ${parsed.timebase}${parsed.ntsc ? " NTSC" : ""} diferente dos ${pf.source.fps} fps do bruto`);
    const edgeWords = verifyEdgeWords({ ...edgeWordsInput, planClips: plan.clips, durationS: pf.source.durationS });
    const edgeCtx = verifyEdgeContext(plan, clips, { fps: pf.source.fps, rate: parsed.rate, words: edgeWords.words, durationS: pf.source.durationS, bounds: isMultiSource(pf.source) ? fileBounds(pf.source) : undefined });
    for (const w of edgeWords.warnings) if (!edgeWarned.has(w)) (edgeWarned.add(w), console.error(`[aviso] verify-xml: ${w}`));
    for (const w of edgeCtx.warnings) console.error(`[aviso] verify-xml ${key}: ${w}`);
    // #13424: o XML toca a faixa tratada (piso mais baixo que o bruto): com ela no disco, as bordas são medidas nela.
    const treatedEnv = treatedEdgeEnvelope(ctx, key, pf.xmlAssets?.[key]?.treatedAudio?.path);
    const edgeEnv = treatedEnv.env ?? env;
    if (treatedEnv.warning) console.error(`[aviso] verify-xml ${key}: ${treatedEnv.warning}`);
    console.error(`[video-montagem] verify-xml ${key}: bordas medidas ${treatedEnv.env ? "na faixa tratada (a que o XML toca, #13424)" : "no áudio do bruto (sem faixa tratada)"}`);
    // #13194: em cada borda vale o menor entre o fixo e o piso de ruído LOCAL + margem (localEdgeThreshold, o mesmo critério do build).
    const thrAt = localEdgeThreshold(edgeEnv, thr);
    const edges = edgeFindings(clips, parsed.rate, (a, b) => maxDbIn(edgeEnv, a, b), thrAt, edgeCtx.ctx);
    const soft = softEdges(edges);
    const cut = edges.filter((e) => e.cutIn || e.cutOut);
    const durS = (parsed.clips[parsed.clips.length - 1]?.end ?? 0) / parsed.rate;
    console.log(`== ${basename(xmlPath)}: timebase ${parsed.timebase}${parsed.ntsc ? " NTSC" : ""}, ${clips.length} clipes, ${durS.toFixed(2)} s (plano: ${(plan.durationFrames / pf.source.fps).toFixed(2)} s)${cardFrames ? ` + card de CTA ${(cardFrames / pf.source.fps).toFixed(2)} s sem fala` : ""}`);
    for (const x of issues) console.log(`[erro] ${x}`);
    for (const e of edges) console.log(edgeLine(e, clockTime));
    // #13194: acima só do limiar relativo, curta (estalo, respiro, ruído) ou sem abertura pelo build: aviso, nunca erro.
    for (const x of softEdgeWarnings(edges, clockTime)) console.error(`[aviso] verify-xml ${key}: ${x}`);
    let findings: ReviewFinding[] = [];
    if (transcribe && clips.length) {
      // Áudio montado SÓ pelo XML (cortes secos, sem fades): o que o Premiere tocaria.
      const dir = join(ctx.workDir, `verify-${key}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const parts = assemblySegments(clips, parsed.rate).map((s, i) => {
        const p = join(dir, `a${String(i).padStart(3, "0")}.wav`);
        run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", audio, "-ss", s.start.toFixed(4), "-to", s.end.toFixed(4), "-c:a", "pcm_s16le", p]);
        return p;
      });
      const list = join(dir, "list.txt");
      writeFileSync(list, concatListText(parts));
      const wav = join(dir, "xml.wav");
      run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", wav]);
      const tj = join(dir, "xml.transcript.json");
      transcribeWithPython(ctx, wav, tj, { vad: false, noCondition: true });
      const heard = reviewTranscriptWords(readJson<Transcript>(tj, "transcrição do áudio do XML"));
      // #12711: a palavra esticada sobre fala no áudio montado (a 261111 tinha "fazer" por 4,5 s), que o casamento com o roteiro não vê.
      // #12969: o mesmo limiar fixo do review/preview, não o das bordas (adaptativo, #12903).
      const xmlSilences = parseSilenceDetect(run("ffmpeg", ["-hide_banner", "-nostats", "-i", wav, "-vn", "-af", REVIEW_SILENCE_FILTER, "-f", "null", "-"]).stderr, durS);
      findings = [
        ...reviewPreview({ words: heard, script: plan.script, cuts: sequenceCutsS(parsed.clips, parsed.rate), durationS: durS, aliases: loadVocab().aliases })
          .filter((x) => x.kind === "fala-faltando" || x.kind === "fala-extra"),
        ...stretchedWordFindings(heard, xmlSilences),
      ];
      console.log("transcrição do áudio montado pelo XML x roteiro:");
      if (!findings.length) console.log("  sem diferenças");
      for (const x of findings) console.log(`  ${clockTime(x.at)}  ${x.kind}: ${x.detail}`);
    }
    // #13372: 2º leitor independente (adapter FCP7 do OpenTimelineIO) no mesmo XML: clipes, in/out e duração
    // contra o leitor próprio. Opcional e NÃO bloqueante (decisão do editor): nunca soma em `bad`.
    // #13437: o 2º leitor lê o XML como ele é (com o trecho), contra o leitor próprio sem desfazer o deslocamento.
    const otio = otioCrossCheck(parsedXml, xmlPath, {
      python: resolveOtioPython(process.env.DIARIA_OTIO_PYTHON, ctx.python),
      script: OTIO_PY,
      sequenceName: plan.spec.name,
      expectedTotalFrames: plan.durationFrames + trechoTotal + (cardFrames ?? 0),
    });
    for (const x of otioCheckLines(otio)) {
      // "indisponível" é da máquina, não da sequência: uma vez por rodada (o Set de avisos únicos do verify-xml).
      if (otio.status === "indisponivel" && edgeWarned.has(x.text)) continue;
      edgeWarned.add(x.text);
      if (x.level === "aviso") console.error(`[aviso] verify-xml ${key}: ${x.text}`);
      else console.error(`[video-montagem] verify-xml ${key}: ${x.text}`);
    }
    bad += issues.length + cut.length + findings.length;
    cutTotal += cut.length;
    softTotal += soft.length;
    report[key] = { xml: xmlPath, clips: clips.length, issues, cutEdges: cut, softEdges: soft, findings, otio };
  }
  writeJson(f(ctx, "verify-xml.json"), report);
  if (bad) {
    console.error(`[erro] verify-xml: ${bad} problema(s) no XML (borda com SOM CORTADO, estrutura, fala divergente ou tomada colapsada, #12711): corrigir o blocks.json/build antes da prévia (#12561)`);
    // #13194: o build já abre sozinho a borda com SOM CORTADO até o silêncio; a que sobra é a que ele não conseguiu (ou um XML anterior).
    if (cutTotal) console.error(`[erro] verify-xml: ${cutTotal} borda(s) com SOM CORTADO: rode build de novo (ele abre a borda até o silêncio, #13194); a que sobrar depois do build não tem silêncio antes do limite da abertura (aviso do build, com o limite): abrir o item no blocks.json ou conferir no Premiere`);
    if (softTotal) console.error(`[aviso] verify-xml: ${softTotal} borda(s) com [aviso] (verify-xml.json, softEdges): levar ao editor com a prévia, para conferir no Premiere (#13194)`);
    return 1;
  }
  const softNote = softTotal ? `, ${softTotal} borda(s) com [aviso] (verify-xml.json, softEdges: levar ao editor com a prévia, #13194)` : ", 0 borda(s) com [aviso]";
  console.error(`[video-montagem] verify-xml: zero bordas cortadas${softNote}${transcribe ? "; áudio do XML batendo com o roteiro" : "; fala NÃO conferida (--no-transcribe)"} (#12561)`);
  return 0;
}

// ── Rosto automático e folha de olhar (#12560) ────────────────────────────

/** Um frame do bruto (tempo global) em PNG de 720 px de largura, desespelhado. */
function grabFrame(source: SourceInfo, t: number, out: string, proxy: string | null = null): void {
  const job = frameJobOf(source, t, out, proxy);
  rmSync(out, { force: true });
  runDecode(["-hide_banner", "-v", "error", "-y", "-ss", job.atS.toFixed(3), "-i", job.src, "-frames:v", "1", "-vf", `${job.mirrored ? "hflip," : ""}scale=720:-2`, out], "frame");
  // ffmpeg com -ss além do fim sai 0 sem gravar: frame ausente é falha de extração, não "rosto não detectado" (review da PR #12563).
  if (!existsSync(out)) throw new Error(missingFrameMessage(source, t));
}

function missingFrameMessage(source: SourceInfo, t: number): string {
  const at0 = frameAt(source, t);
  return `frame em ${t.toFixed(2)} s (${at0.view.id} em ${at0.localS.toFixed(2)} s) não foi extraído: tempo além do fim do arquivo?`;
}

/** #13508: o frame sai do proxy 1440p quando há um válido (mesmo tempo, mesmo espelhamento); senão do bruto. */
function frameJobOf(source: SourceInfo, t: number, out: string, proxy: string | null): FrameJob {
  const at0 = frameAt(source, t);
  return { src: !at0.multi && proxy ? proxy : at0.view.path, atS: at0.localS, mirrored: at0.view.mirrored, out };
}

/**
 * #13508: o proxy 1440p do bruto (`transcribe`), se a meta bate com o
 * `source.json`; senão `null` (frames do 4K, como antes).
 */
function proxyFor(ctx: Pick<Ctx, "workDir">, source: SourceInfo): string | null {
  const path = join(ctx.workDir, PROXY.file);
  const metaPath = join(ctx.workDir, PROXY.meta);
  if (!existsSync(path) || !existsSync(metaPath)) return null;
  try {
    return proxyUsable(JSON.parse(readFileSync(metaPath, "utf8")), source, statSync(source.path).size) ? path : null;
  } catch {
    return null;
  }
}

/**
 * #13508: a saída do proxy para o ffmpeg do `transcribe`, ou `null` (sem
 * proxy): `DIARIA_VIDEO_PROXY=0` ou `DIARIA_VIDEO_HWACCEL=0`, ffmpeg sem `cuda`
 * em `-hwaccels` ou sem `h264_nvenc`, ou bruto que já cabe em 1440p. O proxy e
 * a meta anteriores saem antes (a leitura nova regrava os dois).
 */
function transcribeProxyPlan(ctx: Pick<Ctx, "workDir">, source: SourceInfo): { args: string[]; part: string } | null {
  if ((process.env.DIARIA_VIDEO_PROXY ?? "").trim() === "0" || (process.env.DIARIA_VIDEO_HWACCEL ?? "").trim() === "0") return null;
  const final = join(ctx.workDir, PROXY.file);
  rmSync(final, { force: true });
  rmSync(join(ctx.workDir, PROXY.meta), { force: true });
  let gpu = false;
  try {
    gpu = ffmpegListsCuda(run("ffmpeg", ["-hide_banner", "-hwaccels"]).stdout) && pickTrechoEncoder(run("ffmpeg", ["-hide_banner", "-encoders"]).stdout) === "h264_nvenc";
  } catch {
    gpu = false;
  }
  if (!gpu) {
    console.error(`[premissa] ffmpeg sem GPU (cuda + h264_nvenc): sem proxy ${PROXY.shortSide}p; face/gaze leem o bruto 4K (#13508)`);
    return null;
  }
  const part = `${final}.part`;
  const args = proxyOutputArgs({ width: source.width, height: source.height, out: part });
  return args ? { args, part } : null;
}

/** Confere a duração do proxy recém-gravado contra o bruto, põe no nome final e grava a meta (#13508). */
function finishProxy(ctx: Pick<Ctx, "workDir">, source: SourceInfo, part: string): void {
  const d = probeDurationS(part);
  if (!Number.isFinite(d) || Math.abs(d - source.durationS) > PROXY.durationTolS) throw new Error(`proxy com ${Number.isFinite(d) ? d.toFixed(2) : "?"} s, o bruto tem ${source.durationS.toFixed(2)} s`);
  renameSync(part, join(ctx.workDir, PROXY.file));
  const meta: ProxyMeta = { version: PROXY.version, src: source.path, size: statSync(source.path).size, durationS: source.durationS, width: source.width, height: source.height };
  writeJson(join(ctx.workDir, PROXY.meta), meta);
}

/**
 * #13544: os vídeos soltos na pasta da edição fora do bruto do `source.json`,
 * com `[aviso]` e o comando do transcribe com todos. Pasta ausente ou ilegível
 * (modo API, outra máquina) = nada a dizer.
 */
function warnLooseVideos(ctx: Pick<Ctx, "driveDir" | "edition">, source: SourceInfo): string[] {
  if (source.audioOnly || !existsSync(ctx.driveDir)) return [];
  let files: Array<{ name: string; size: number }>;
  try {
    files = looseFilesIn(ctx.driveDir);
  } catch (e) {
    console.error(`[debug] ${ctx.driveDir} não listada (${(e as Error).message}): vídeos fora do bruto não conferidos (#13544)`);
    return [];
  }
  const raw = pickRawSource(files);
  if (!raw || raw.audioOnly) return [];
  const extras = videosForaDoBruto(raw.candidates, source);
  const msg = videosForaDoBrutoAviso(ctx.edition, extras, source);
  if (msg) console.error(`[aviso] ${msg}`);
  return extras;
}

/** #13544: no `build`, as falas do roteiro sem item resolvido no blocks.json, por id. */
function warnFalasSemTomada(ctx: Pick<Ctx, "driveDir" | "edition">, source: SourceInfo, resolved: Partial<Record<BlockKey, ResolvedItem[]>>): void {
  const extras = warnLooseVideos(ctx, source);
  const falas = readRoteiroFalasLista(editionDirFor(ctx.edition), (m) => console.error(`[aviso] ${m}`));
  if (!falas.length) return;
  const items = Object.values(resolved).flatMap((xs) => xs ?? []);
  const msg = falasSemTomadaAviso(falasSemTomada(falas, items), extras);
  if (msg) console.error(`[aviso] ${msg}`);
}

/**
 * #13508: o proxy da prévia, com o tamanho dele, ou `null` (prévia do 4K, como
 * antes): bruto em vários arquivos, só áudio, sem proxy válido, ou
 * `DIARIA_VIDEO_PROXY=0`.
 */
function previewProxy(ctx: Pick<Ctx, "workDir">, source: SourceInfo): { path: string; size: { width: number; height: number } } | null {
  if ((process.env.DIARIA_VIDEO_PROXY ?? "").trim() === "0" || isMultiSource(source) || source.audioOnly) return null;
  const path = proxyFor(ctx, source);
  const size = path ? proxySize(source.width, source.height) : null;
  if (!path || !size) return null;
  console.error(`[video-montagem] prévia lida do proxy ${PROXY.shortSide}p (${path}); o XML segue no bruto (#13508)`);
  return { path, size };
}

/** `proxyFor` com a linha do relato dizendo de onde os frames saem (#13508). */
function proxyNotice(ctx: Pick<Ctx, "workDir">, source: SourceInfo): string | null {
  const p = proxyFor(ctx, source);
  if (p) console.error(`[video-montagem] frames do proxy ${PROXY.shortSide}p (${p}); o XML segue no bruto (#13508)`);
  return p;
}

/**
 * #13507: os frames em lote, um processo do ffmpeg por até `FRAME_BATCH_SIZE`
 * frames (GPU quando der). Lote que falha, ou que deixa algum PNG sem gravar,
 * é refeito frame a frame (`grabFrame`), que nomeia o frame problemático.
 */
function grabFrames(source: SourceInfo, list: ReadonlyArray<{ t: number; out: string }>, proxy: string | null = null): void {
  for (const chunk of chunkFrameJobs(list)) {
    for (const x of chunk) rmSync(x.out, { force: true });
    try {
      runDecode(batchFrameArgs(chunk.map((x) => frameJobOf(source, x.t, x.out, proxy)), { width: 720 }), `${chunk.length} frame(s) em lote`, { all: true });
    } catch {
      /* refeito frame a frame abaixo */
    }
    for (const x of chunk) if (!existsSync(x.out)) grabFrame(source, x.t, x.out, proxy);
  }
}

const FACE_PY = join(ROOT, "scripts", "video", "face_detect.py");

/**
 * `face AAMMDD [--write [--overwrite]]` (#12560): mede o rosto em 3 frames de
 * cada item do blocks.json (25/50/75% do trecho resolvido) e propõe o
 * `framing` do item. Com `--write`, grava só nos itens com rosto achado e sem
 * `framing` próprio; o que já estava no item (medido à mão) fica, e sai no
 * relato com a medida nova; `--overwrite` troca também esses. Rodar de novo
 * ao trocar uma tomada (com `--overwrite`, se o `face` já gravou antes).
 */
/** Os frames do `face` (25/50/75% de cada item) em `dir`, com o `in.json` do face_detect.py; devolve as chaves `{bloco}#{i}`. */
function grabItemFaceFrames(source: SourceInfo, resolved: Record<string, ResolvedItem[] | undefined>, dir: string, proxy: string | null = null): { keys: string[]; items: Map<string, ResolvedItem> } {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const jobs: Array<{ key: string; path: string }> = [];
  const frames: Array<{ t: number; out: string }> = [];
  const keys: string[] = [];
  const byKey = new Map<string, ResolvedItem>();
  for (const [block, items] of Object.entries(resolved) as Array<[string, ResolvedItem[]]>) {
    items.forEach((it, i) => {
      const key = `${block}#${i}`;
      keys.push(key);
      byKey.set(key, it);
      FACE_SAMPLE_FRACTIONS.forEach((q, k) => {
        const path = join(dir, `${block}-${i}-${k}.png`);
        frames.push({ t: it.interval.start + (it.interval.end - it.interval.start) * q, out: path });
        jobs.push({ key, path });
      });
    });
  }
  // #13507: frames em lote; #13508: do proxy 1440p quando houver.
  grabFrames(source, frames, proxy);
  writeJson(join(dir, "in.json"), jobs);
  return { keys, items: byKey };
}

/**
 * #13588: tira os frames pedidos (em lote, do proxy quando houver) e roda o
 * `face_detect.py` (Haar, ou o `python`/`extra` do MediaPipe no face-compare);
 * uma detecção por frame, com a `key` do item.
 */
function detectFaceFrames(ctx: Ctx, source: SourceInfo, frames: readonly FaceFrameRequest[], dir: string, tag: string, proxy: string | null, detector: { python?: string; extra?: string[] } = {}): FrameDetection[] {
  mkdirSync(dir, { recursive: true });
  const jobs = frames.map((fr, i) => ({ key: fr.key, path: join(dir, `${tag}-${i}.png`) }));
  grabFrames(source, frames.map((fr, i) => ({ t: fr.t, out: jobs[i].path })), proxy);
  const inJson = join(dir, `${tag}-in.json`);
  const outJson = join(dir, `${tag}-out.json`);
  writeJson(inJson, jobs);
  run(detector.python ?? ctx.python, ["-P", FACE_PY, ...(detector.extra ?? []), inJson, outJson], { inheritStderr: true });
  return readJson<FrameDetection[]>(outJson, "face_detect");
}

/**
 * Os itens resolvidos do blocks.json como entrada do `face` (#13588): chave
 * `{bloco}#{i}`, intervalo, arquivo e o `mirrored` efetivo do arquivo no meio
 * da fala (o mesmo que `frameJobOf` usa para desespelhar; review da PR #13595).
 */
function faceItemsOf(source: SourceInfo, resolved: Record<string, ResolvedItem[] | undefined>): FaceItem[] {
  return (Object.entries(resolved) as Array<[string, ResolvedItem[] | undefined]>).flatMap(([block, items]) =>
    (items ?? []).map((it, i) => ({
      key: `${block}#${i}`,
      interval: { start: it.interval.start, end: it.interval.end },
      ...(it.source !== undefined ? { source: it.source } : {}),
      mirrored: frameAt(source, (it.interval.start + it.interval.end) / 2).view.mirrored,
    })),
  );
}

/** Impressão do `face_detect.py` (parâmetros do Haar): mudar o detector invalida o `face-cache.json` (review da PR #13595). */
function faceDetectorFingerprint(): string {
  return createHash("sha256").update(readFileSync(FACE_PY)).digest("hex").slice(0, 12);
}

function cmdFace(ctx: Ctx, write: boolean, overwrite = false, opts: { all?: boolean; oneFrame?: boolean } = {}): number {
  const { source, resolved } = plans(ctx);
  const dir = join(ctx.workDir, "face-tmp");
  rmSync(dir, { recursive: true, force: true });
  const proxy = proxyNotice(ctx, source);
  // #13588: só o item sem medida no cache (tomada nova ou trocada) vai ao detector; --all mede tudo.
  const cachePath = f(ctx, FACE_CACHE_FILE);
  const cache = parseFaceCache(existsSync(cachePath) ? readJson<unknown>(cachePath, FACE_CACHE_FILE) : null);
  const sampling: FaceSampling = opts.oneFrame ? "um-frame" : "tres-frames";
  let batch = 0;
  const m = runFaceMeasurement(faceItemsOf(source, resolved), cache, { detect: (frames) => detectFaceFrames(ctx, source, frames, dir, `f${batch++}`, proxy) }, { bruto: source.path, sampling, all: opts.all, detector: faceDetectorFingerprint() });
  rmSync(dir, { recursive: true, force: true });
  writeJson(cachePath, m.cache);
  console.error(`[video-montagem] face: ${m.measured.length} item(ns) medido(s) agora (${m.frames} frame(s)${sampling === "um-frame" ? ", 1 por item com 25/75% onde o do meio não achou rosto" : ""}), ${m.fromCache.length} do ${FACE_CACHE_FILE}${opts.all ? " (--all)" : "; --all mede tudo"} (#13588)`);
  const results = m.results;
  const cachedKeys = new Set(m.fromCache);
  for (const r of results) {
    const [block, idx] = r.key.split("#");
    const from = cachedKeys.has(r.key) ? "  (cache)" : "";
    if (!r.framing) console.error(`[aviso] ${block}[${idx}]: rosto não detectado em ${r.total} frame(s); mantém o framing atual${from}`);
    else console.log(`${block}[${idx}]  ${r.found}/${r.total} frames  faceX ${r.framing.faceX}  eyeY ${r.framing.eyeY}  mouthY ${r.framing.mouthY}  rosto ${((r.faceH ?? 0) * 100).toFixed(1)}% da altura${from}`);
  }
  if (!write) {
    console.error("[video-montagem] sem --write: nada gravado (#12560)");
    return 0;
  }
  const path = f(ctx, "blocks.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as { blocks: Record<string, Array<Record<string, unknown>>> };
  const { changed, kept } = applyItemFramings(raw, results, { overwrite });
  if (changed) writeFileAtomic(path, JSON.stringify(raw, null, 2) + "\n");
  for (const k of kept) {
    const [block, idx] = k.key.split("#");
    console.error(`[premissa] ${block}[${idx}]: já tinha framing no blocks.json; mantido (medido agora: ${k.measured.faceX}/${k.measured.eyeY}${k.measured.mouthY !== undefined ? `, boca ${k.measured.mouthY}` : ""}; --overwrite troca)`);
  }
  console.error(`[video-montagem] face --write: framing de ${changed} item(ns) gravado em ${path}${kept.length ? `, ${kept.length} mantido(s)` : ""} (a caneca segue a do framing do arquivo, #12560)`);
  return 0;
}

/**
 * `face-compare AAMMDD --mp-python PY --mp-model TFLITE` (#13370, R3 da
 * #13199): MEDIÇÃO do Haar contra o MediaPipe nos MESMOS frames do `face`, cada
 * item comparado com o framing aprovado no blocks.json (o do item, ou o do
 * arquivo). Não grava framing nenhum: o relatório vai para
 * `{work}/face-compare.json` (agregar várias edições com `video-medicoes.ts
 * rosto-agrega`). O MediaPipe roda com o Python de um venv próprio
 * (`--mp-python`), fora do venv da montagem: dependência só da medição.
 */
function cmdFaceCompare(ctx: Ctx, mpPython: string | undefined, mpModel: string | undefined, oneFrame = false): number {
  if (!mpPython || !mpModel) throw new Error("face-compare exige --mp-python (Python com mediapipe 0.10.x) e --mp-model (blaze_face_short_range.tflite); ver docs/video-medicoes-r2-r3.md (#13370)");
  if (!existsSync(mpModel)) throw new Error(`face-compare: modelo do MediaPipe não encontrado: ${mpModel}`);
  const { file, source, resolved } = plans(ctx);
  const { framing: base, assumed } = effectiveFraming(file);
  const dir = join(ctx.workDir, "face-compare-tmp");
  let keys: string[];
  let items: Map<string, ResolvedItem>;
  if (oneFrame) {
    // #13588: os frames do `face --um-frame` (o do meio; 25/75% onde o Haar não achou rosto nele), os mesmos nos dois detectores.
    rmSync(dir, { recursive: true, force: true });
    const proxy = proxyNotice(ctx, source);
    const fitems = faceItemsOf(source, resolved);
    keys = fitems.map((it) => it.key);
    items = new Map((Object.entries(resolved) as Array<[string, ResolvedItem[] | undefined]>).flatMap(([b, xs]) => (xs ?? []).map((it, i) => [`${b}#${i}`, it] as const)));
    const asked: FaceFrameRequest[] = [];
    const haar: FrameDetection[] = [];
    let batch = 0;
    runFaceMeasurement(fitems, emptyFaceCache(), {
      detect: (frames) => {
        asked.push(...frames);
        const d = detectFaceFrames(ctx, source, frames, dir, `h${batch++}`, proxy);
        haar.push(...d);
        return d;
      },
    }, { bruto: source.path, sampling: "um-frame" });
    writeJson(join(dir, "haar.json"), haar);
    writeJson(join(dir, "mediapipe.json"), detectFaceFrames(ctx, source, asked, dir, "mp", proxy, { python: mpPython, extra: ["--detector", "mediapipe", "--model", mpModel] }));
    console.error(`[video-montagem] face-compare --um-frame: ${asked.length} frame(s) para ${keys.length} item(ns) (#13588)`);
  } else {
    ({ keys, items } = grabItemFaceFrames(source, resolved, dir, proxyNotice(ctx, source)));
    run(ctx.python, ["-P", FACE_PY, join(dir, "in.json"), join(dir, "haar.json")], { inheritStderr: true });
    run(mpPython, ["-P", FACE_PY, "--detector", "mediapipe", "--model", mpModel, join(dir, "in.json"), join(dir, "mediapipe.json")], { inheritStderr: true });
  }
  const refs: FaceReference[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  for (const key of keys) {
    const it = items.get(key)!;
    if (it.framing) refs.push({ key, faceX: it.framing.faceX, eyeY: it.framing.eyeY, fonte: "item" });
    else if (assumed) skipped.push({ key, reason: "blocks.json sem framing (default da 261027): sem referência aprovada" });
    else {
      const fr = isMultiSource(source) ? framingOfFile(base, file, it.source) : base;
      refs.push({ key, faceX: fr.faceX, eyeY: fr.eyeY, fonte: "arquivo" });
    }
  }
  const report = compareFaceDetectors({
    edition: ctx.edition,
    haar: readJson<FrameDetection[]>(join(dir, "haar.json"), "face_detect haar"),
    mediapipe: readJson<FrameDetection[]>(join(dir, "mediapipe.json"), "face_detect mediapipe"),
    refs,
    skipped,
  });
  rmSync(dir, { recursive: true, force: true });
  const out = join(ctx.workDir, "face-compare.json");
  writeJson(out, report);
  for (const fonte of ["arquivo", "item"] as const) {
    for (const det of FACE_DETECTORS) {
      const s = report.summary[fonte][det];
      if (!s.items) continue;
      console.log(`${fonte.padEnd(7)} ${det.padEnd(9)} itens com rosto ${s.itemsWithFace}/${s.items}  frames ${s.frameHits}/${s.frames}  erro mediano faceX ${s.medianErrFaceX ?? "n/d"} eyeY ${s.medianErrEyeY ?? "n/d"}  dentro de ${FACE_COMPARE_TOL}: ${s.withinTol}`);
    }
  }
  if (skipped.length) console.error(`[premissa] ${skipped.length} item(ns) sem referência ficaram de fora (${skipped[0].reason})`);
  console.error(`[video-montagem] face-compare: ${out} (medição da #13370; nada gravado no blocks.json)`);
  return 0;
}

/**
 * `gaze AAMMDD [--seq KEY]` (#12560): folha `gaze-{seq}.jpg` com o rosto em
 * close no início, meio e fim de cada clipe da sequência (e "depois"/"depois+1s"
 * no último, o respiro do fecho). Ler antes de mostrar a prévia: olhar para
 * baixo/fora, olhos fechados ou careta = trocar a tomada; escolher o CTA pela expressão.
 */
function cmdGaze(ctx: Ctx, target: string | undefined): number {
  const pf = loadPlan(ctx);
  const [plan] = pickPlans(pf.plans, target ?? "outras-redes", false, true);
  const fps = pf.source.fps;
  const dir = join(ctx.workDir, "gaze-tmp");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const jobs: Array<{ row: string; label: string; path: string }> = [];
  const frames: Array<{ t: number; out: string }> = [];
  const bounds = fileBounds(pf.source);
  plan.clips.forEach((c, i) => {
    const a = c.frameIn / fps;
    const b = c.frameOut / fps;
    const row = `${i + 1} ${c.block} ${clockTime(a)} ${(c.script ?? "").slice(0, 120)}`;
    const fileEnd = bounds[c.file ?? 0]?.end ?? Number.POSITIVE_INFINITY;
    gazeMarks(a, b, i === plan.clips.length - 1, fileEnd).forEach((m, k) => {
      const path = join(dir, `g${String(i).padStart(3, "0")}-${k}.png`);
      frames.push({ t: m.t, out: path });
      jobs.push({ row, label: m.label, path });
    });
  });
  // #13507: frames em lote; #13508: do proxy 1440p quando houver.
  grabFrames(pf.source, frames, proxyNotice(ctx, pf.source));
  writeJson(join(dir, "in.json"), jobs);
  const out = join(ctx.workDir, `gaze-${sequenceKey(plan.spec)}.jpg`);
  run(ctx.python, ["-P", FACE_PY, "--sheet", join(dir, "in.json"), out], { inheritStderr: true });
  rmSync(dir, { recursive: true, force: true });
  console.log(out);
  console.error(`[video-montagem] folha de olhar de ${plan.spec.name}: ${plan.clips.length} clipe(s); olhar fora, olhos fechados ou careta = trocar a tomada (#12560)`);
  return 0;
}

/**
 * #13404: o `roteiro` que falha não regrava o `roteiro.md`, e o da rodada
 * anterior continua no disco com cara de atual (na 261116 o Doc do Gate 2 saiu
 * defasado sem erro visível). A linha diz que o arquivo NÃO é desta rodada.
 */
export function roteiroNotRewrittenNotice(path: string, mtimeMs: number | null): string {
  if (mtimeMs === null) return `[erro] roteiro falhou: ${path} não foi gravado (#13404)`;
  return `[erro] roteiro falhou: ${path} NÃO foi regravado; o que está no disco é de ${brtStamp(mtimeMs)}, defasado: não usar no Gate 2 até o roteiro rodar sem erro (#13404)`;
}

function cmdRoteiro(ctx: Ctx, shortWordCheck = true): number {
  const { file, source, plans: ps, resolved } = plans(ctx);
  printTakeRepeatWarnings(ctx, resolved);
  // As linhas "alternativa" da decupagem viram as opções B, C… do roteiro (#11361).
  const tr = readJson<Transcript>(f(ctx, "transcript.json"), "transcript.json (rode transcribe)");
  // #13587: os números do plano são os da listagem congelada da decupagem (com as tomadas separadas).
  const dsegs = decupagemListing(ctx, tr).segments;
  const dplan = loadDecupagemPlan(ctx, dsegs);
  const alternatives = dplan ? alternativesFromDecupagem(buildDecupagemDoc(dplan, dsegs, loadVocab().rules)) : undefined;
  const sil = silences(ctx);
  const targetOverride = verticalTargetOverrideWarning(file.verticalTargetS);
  if (targetOverride) console.error(`[aviso] ${targetOverride}`);
  for (const p of ps) {
    const t = verticalTargetCheck(p, resolved, source.fps, { targetS: file.verticalTargetS, silences: sil });
    if (t) console.error(`[aviso] ${verticalTargetWarning(p.spec.name, t)}`);
  }
  // #12571: cada versão fecha com o card de CTA (salvo ctaCard: false), com a linha de compartilhar dela.
  const ctaCardShare = file.ctaCard === false ? undefined : Object.fromEntries(ps.map((p) => [sequenceKey(p.spec), ctaShareLine(p.spec.ctaShare ?? file.ctaShare)]));
  // #12585: o título de cada vídeo, das mesmas funções do build e dos publicadores.
  const videoTitles = videoTitlesFor(ps.map((p) => p.spec), {
    blocksTitle: file.screenTitle,
    d1Title: readD1Title(ctx.edition),
    roteiroTitle: readRoteiroHorizontal(editionDirFor(ctx.edition), (w) => console.error(`[aviso] ${w}`))?.titulo ?? null,
  });
  // #13140: os cortes de reserva do roteiro abrem a sugestão da vertical acima do alvo.
  const cortesReserva = readRoteiroCortesReserva(editionDirFor(ctx.edition), (w) => console.error(`[aviso] ${w}`), { corteSlug: VERTICAL2_CORTE_SLUG });
  const base = roteiroMarkdown(ctx.edition, ps, resolved, source.fps, { falasPlanejadas: readRoteiroFalas(editionDirFor(ctx.edition), (w) => console.error(`[aviso] ${w}`)), alternatives, verticalTargetS: file.verticalTargetS, silences: sil, ctaCardShare, ctaCardS: configCtaCardS(), videoTitles, cortesReserva });
  // #11956: os achados do fact-check da fala entram no Doc do Gate 2.
  const fcPath = f(ctx, VIDEO_FACT_CHECK_FILE);
  let fc: ReturnType<typeof parseVideoFactCheck> | null = null;
  let fcError: string | null = null;
  if (existsSync(fcPath)) {
    try { fc = parseVideoFactCheck(readJson<unknown>(fcPath, VIDEO_FACT_CHECK_FILE)); } catch (e) { fcError = (e as Error).message; }
  }
  // #13132: as fontes do roteiro entram no hash; trocar uma depois do fact-check o torna velho.
  const fontesRoteiro = readRoteiroFontes(editionDirFor(ctx.edition), (m) => console.error(`[aviso] ${m}`)).fontes;
  const section = factCheckSection(fc, factCheckItems(ps, resolved), fontesRoteiro);
  if (fcError) {
    // Ilegível não é "não rodou": o Doc diz o motivo, e o roteiro sai assim mesmo.
    section.lines.splice(2, 1, `**[aviso] fact-check ilegível (${mdCell(fcError)}):** rodar o agent de novo antes de aprovar o Gate 2.`);
    console.error(`[aviso] ${fcPath} ilegível: ${fcError}; rode o agent fact-checker (mode video) de novo (#11956)`);
  } else if (!fc) console.error(`[aviso] sem ${fcPath}: o fact-check da fala (Passo 2b, fact-check-input + agent fact-checker mode video) não rodou ou o agent ainda não voltou; rodar o roteiro de novo com ele antes do Gate 2 (#11956, #13597)`);
  else if (section.stale) console.error("[aviso] o roteiro mudou depois do fact-check: frases novas não foram checadas; rode fact-check-input de novo, que refaz só os itens que mudaram (+ fact-check-merge) (#11956, #13597)");
  if (section.graves) console.error(`[aviso] fact-check: ${section.graves} achado(s) grave(s) em aberto na fala (seção "Fact-check da fala" do roteiro, #11956)`);
  const short = shortWordChecks(ctx, factCheckItems(ps, resolved), shortWordCheck);
  if (short.skipped) console.error(`[aviso] palavras curtas do roteiro não conferidas (${short.skipped}): conferir no áudio os artigos e preposições antes do Gate 2 (#12093)`);
  else {
    const n = short.checks!.reduce((k, c) => k + c.divergences.length, 0);
    if (n) console.error(`[aviso] ${n} palavra(s) curta(s) do roteiro diferente(s) da retranscrição da janela: seção "Palavras curtas" do roteiro, para o editor decidir no Gate 2 (#12093)`);
  }
  // #12711: a retranscrição da janela de cada item (sem o roteiro no prompt) contra a tomada repetida que o Whisper colapsa.
  const repeat = short.heard ? windowRepeatSuspects(factCheckItems(ps, resolved), short.heard, sil, makeMatcher(loadVocab().aliases)) : [];
  for (const x of repeat) console.error(`[aviso] ${takeRepeatLine(x)}`);
  // #13437: os trechos de outro vídeo do horizontal, com a fonte que o build vai cortar (ou onde ela foi procurada).
  const trechosMd = trechosInseridosSection(
    readTrechosInseridos(editionDirFor(ctx.edition), (m) => console.error(`[aviso] ${m}`)).map((t) => {
      const fonte = fonteDoTrecho(ctx, t);
      if (!fonte.fonte) console.error(`[aviso] trecho depois da fala ${t.id}: export do vídeo de origem não achado (procurado: ${fonte.procurado.join("; ")}); o build deixa só o marcador (#13437)`);
      return { id: t.id, trecho: t.trecho, fonte: fonte.fonte, procurado: fonte.procurado };
    }),
  );
  const md = `${base.trimEnd()}\n\n${trechosMd.length ? `${trechosMd.join("\n")}\n\n` : ""}${section.lines.join("\n")}\n\n${shortWordSection(short.checks, short.skipped).join("\n")}\n${takeRepeatSection(repeat)}`;
  writeFileAtomic(f(ctx, "roteiro.md"), md);
  process.stdout.write(md);
  return 0;
}

/** Suspeitas de tomada repetida nas janelas retranscritas do roteiro (#12711): uma lista por item, na ordem de `items`. */
export function windowRepeatSuspects(items: ReadonlyArray<Pick<FactCheckItem, "id" | "text" | "start" | "end">>, heard: ReadonlyArray<readonly Word[]>, sil: Interval[], match: TokenMatcher): TakeRepeatSuspect[] {
  return items.flatMap((it, i) => windowHeardSuspects(it, heard[i] ?? [], sil, match));
}

/** Seção do roteiro com as suspeitas de tomada repetida (#12711); vazia sem suspeita. */
export function takeRepeatSection(repeat: readonly TakeRepeatSuspect[]): string {
  if (!repeat.length) return "";
  return `\n## Tomada repetida? (#12711)\n\nConferir no áudio antes do Gate 2: o Whisper junta a tomada repetida numa só e o casamento com o roteiro não vê.\n\n${repeat.map((x) => `- ${mdCell(takeRepeatLine(x))}`).join("\n")}\n`;
}

/** Cache da retranscrição das janelas dos itens do roteiro (#12093). */
export const SHORT_WORD_CACHE_FILE = "roteiro-retranscribe.json";

/**
 * Palavras curtas do roteiro × retranscrição da janela de cada item (#12093),
 * numa chamada só do Python. Sem `audio.wav`, com `--no-short-word-check` ou
 * com a retranscrição falhando, devolve o motivo em `skipped` (o roteiro sai
 * assim mesmo, com o aviso no Doc).
 */
function shortWordChecks(ctx: Ctx, items: FactCheckItem[], enabled: boolean): { checks: ShortWordItemCheck[] | null; skipped?: string; heard?: Word[][] } {
  if (!enabled) return { checks: null, skipped: "--no-short-word-check" };
  const audio = join(ctx.workDir, "audio.wav");
  if (!existsSync(audio)) return { checks: null, skipped: `áudio do bruto ausente (${audio})` };
  const windows = items.map((it) => {
    const start = Math.max(0, it.start - SHORT_WORD_WINDOW_PAD_S);
    const end = it.end + SHORT_WORD_WINDOW_PAD_S;
    return { key: windowKey(start, end), start, end };
  });
  let heard: Map<string, Word[]>;
  try {
    heard = windowTranscripts(ctx, audio, windows, SHORT_WORD_CACHE_FILE, "palavras curtas do roteiro: retranscrevendo {n} item(ns) (sem VAD, #12093)…");
  } catch (e) {
    return { checks: null, skipped: `retranscrição falhou: ${(e as Error).message}` };
  }
  const aliases = loadVocab().aliases;
  return {
    checks: items.map((it, i) => ({ id: it.id, text: it.text, start: it.start, end: it.end, divergences: shortWordDivergences(heard.get(windows[i].key) ?? [], it.text, aliases) })),
    // #12711: as mesmas janelas servem à conferência de tomada repetida (palavra esticada, fala divergente).
    heard: windows.map((w) => heard.get(w.key) ?? []),
  };
}

/** Saída do agent `fact-checker` em `mode: "video"` (#11956), no state dir. */
export const VIDEO_FACT_CHECK_FILE = "fact-check.json";
/** Entrada do agent (#11956), no state dir. */
export const VIDEO_FACT_CHECK_INPUT_FILE = "fact-check-input.json";

/**
 * `fact-check-input` (#11956): os itens que vão ao ar (a união das versões,
 * com a fala ouvida quando difere do pedido), o hash deles e onde estão as
 * fontes do D1 baixadas no Stage 4 (`_internal/fact-check-sources/`), mais
 * as fontes por fala do roteiro (`roteiro_fontes`, #13132).
 */
function cmdFactCheckInput(ctx: Ctx, full = false): number {
  const { plans: ps, resolved } = plans(ctx);
  const items = factCheckItems(ps, resolved);
  const sourcesDir = join(editionDirFor(ctx.edition), "_internal", "fact-check-sources");
  const manifest = join(sourcesDir, "manifest.json");
  const roteiro = readRoteiroFontes(editionDirFor(ctx.edition), (m) => console.error(`[aviso] ${m}`));
  if (!existsSync(manifest)) console.error(`[aviso] sem ${manifest}: as fontes do D1 não foram baixadas (Stage 4, run-fact-checker.ts); o agent cai no WebFetch da URL do D1 (#11956)`);
  const itemsSha = factCheckItemsSha256(items, roteiro.fontes);
  const path = f(ctx, VIDEO_FACT_CHECK_INPUT_FILE);
  // #13597: com fact-check anterior, só os itens cujo texto/fala mudou vão ao agent.
  const plan = full ? ({ mode: "full", reason: "--full", check: items } as const) : planFactCheckFromDisk(ctx, items, roteiro.fontes);
  if (plan.mode === "em-dia") {
    console.error(`[video-montagem] fact-check-input: fact-check.json já cobre os ${items.length} item(ns) da versão atual; nada a checar, não despachar o agent (#13597)`);
    return 0;
  }
  const allItems = items.map((i) => ({ id: i.id, hash: factCheckItemHash(i) }));
  if (plan.mode === "delta" && plan.check.length === 0) {
    // Só saiu item (ou mudou a numeração): os achados dos que ficaram seguem, sem agent.
    const merged = mergeVideoFactCheck({ mode: "video", edition: ctx.edition, items_sha256: itemsSha, claims: [] }, plan.carried, itemsSha);
    writeJson(f(ctx, VIDEO_FACT_CHECK_FILE), merged);
    writeJson(path, { mode: "video", edition: ctx.edition, items_sha256: itemsSha, all_items: allItems, fontes_sha256: factCheckFontesSha256(roteiro.fontes), items: [], incremental: { reused: plan.reused, carried_claims: plan.carried }, dispatch: false });
    console.error(`[video-montagem] fact-check-input: nenhuma fala nova (${plan.reused} item(ns) já checado(s), ${plan.carried.length} achado(s) mantido(s)); fact-check.json atualizado sem o agent, nada a despachar (#13597)`);
    return 0;
  }
  if (plan.mode === "full" && existsSync(f(ctx, VIDEO_FACT_CHECK_FILE))) console.error(`[video-montagem] fact-check-input: fact-check inteiro (${plan.reason}) (#13597)`);
  const delta = plan.mode === "delta";
  const input = {
    mode: "video" as const,
    edition: ctx.edition,
    items_sha256: itemsSha,
    // #13597: todos os itens da versão (o que o fact-check.json passa a cobrir) e o hash das fontes,
    // para a próxima volta saber o que já foi checado.
    all_items: allItems,
    fontes_sha256: factCheckFontesSha256(roteiro.fontes),
    dispatch: true,
    ...(delta ? { incremental: { reused: plan.reused, carried_claims: plan.carried } } : {}),
    items: plan.check,
    sources_dir: sourcesDir,
    // #13132: fontes de fora do D1 declaradas por fala no roteiro-falas.json
    // (fatos do rascunho do editor checados na web); o agent as usa além do D1.
    // O status separa "sem fonte declarada" de "roteiro com problema".
    roteiro_fontes: roteiro.fontes,
    roteiro_fontes_status: roteiro.status,
    ...(roteiro.problemas.length ? { roteiro_fontes_problemas: roteiro.problemas } : {}),
    approved_json_path: join(editionDirFor(ctx.edition), "_internal", "01-approved.json"),
    // #13597: o delta vai para outro arquivo; o fact-check-merge junta com os achados mantidos.
    out_path: f(ctx, delta ? VIDEO_FACT_CHECK_DELTA_FILE : VIDEO_FACT_CHECK_FILE),
  };
  writeJson(path, input);
  if (delta) rmSync(f(ctx, VIDEO_FACT_CHECK_DELTA_FILE), { force: true });
  console.error(
    delta
      ? `[video-montagem] fact-check-input: ${plan.check.length} item(ns) com fala nova de ${items.length} (${plan.reused} já checado(s), ${plan.carried.length} achado(s) mantido(s)); agent fact-checker com mode "video", input ${path}, out ${input.out_path}; depois, fact-check-merge ${ctx.edition} (#13597)`
      : `[video-montagem] fact-check-input: ${items.length} item(ns) da fala; agent fact-checker com mode "video", input ${path}, out ${input.out_path}`,
  );
  console.log(path);
  return 0;
}

/** Saída do agent no fact-check incremental (#13597): só os itens com fala nova. */
export const VIDEO_FACT_CHECK_DELTA_FILE = "fact-check.delta.json";

/** O plano do fact-check (#13597) a partir do `fact-check.json` e do `fact-check-input.json` em disco. */
function planFactCheckFromDisk(ctx: Ctx, items: FactCheckItem[], fontes: ReadonlyArray<{ fala: string; url: string; sustenta: string }>) {
  const fcPath = f(ctx, VIDEO_FACT_CHECK_FILE);
  if (!existsSync(fcPath)) return planVideoFactCheck(items, fontes, null, null);
  let fc: ReturnType<typeof parseVideoFactCheck>;
  try {
    fc = parseVideoFactCheck(readJson<unknown>(fcPath, VIDEO_FACT_CHECK_FILE));
  } catch (e) {
    console.error(`[aviso] ${fcPath} ilegível (${(e as Error).message}): fact-check inteiro (#13597)`);
    return planVideoFactCheck(items, fontes, null, null);
  }
  const inPath = f(ctx, VIDEO_FACT_CHECK_INPUT_FILE);
  let prev: unknown = null;
  if (existsSync(inPath)) {
    try { prev = readJson<unknown>(inPath, VIDEO_FACT_CHECK_INPUT_FILE); } catch { prev = null; }
  }
  return planVideoFactCheck(items, fontes, fc, checkedSnapshotFrom(prev, fc));
}

/**
 * `fact-check-merge` (#13597): junta o `fact-check.delta.json` do agent com os
 * achados mantidos (`incremental.carried_claims` do `fact-check-input.json`)
 * no `fact-check.json`, que o `roteiro` lê. O delta de outra versão (o editor
 * mudou a fala de novo depois do `fact-check-input`) é recusado.
 */
function cmdFactCheckMerge(ctx: Ctx): number {
  const inPath = f(ctx, VIDEO_FACT_CHECK_INPUT_FILE);
  const input = readJson<{ items_sha256?: string; incremental?: { carried_claims?: VideoFactClaim[] } }>(inPath, "fact-check-input.json (rode fact-check-input)");
  if (!input.incremental) {
    console.error("[video-montagem] fact-check-merge: o fact-check-input atual é inteiro (o agent grava direto o fact-check.json); nada a juntar (#13597)");
    return 0;
  }
  if (typeof input.items_sha256 !== "string") throw new Error(`${inPath}: items_sha256 ausente; rode fact-check-input de novo`);
  const deltaPath = f(ctx, VIDEO_FACT_CHECK_DELTA_FILE);
  const delta = parseVideoFactCheck(readJson<unknown>(deltaPath, `${VIDEO_FACT_CHECK_DELTA_FILE} (rode o agent fact-checker com o fact-check-input.json)`));
  const merged = mergeVideoFactCheck(delta, input.incremental.carried_claims ?? [], input.items_sha256);
  writeJson(f(ctx, VIDEO_FACT_CHECK_FILE), merged);
  console.error(`[video-montagem] fact-check-merge: ${merged.claims.length} achado(s) no fact-check.json (${(input.incremental.carried_claims ?? []).length} mantido(s), ${delta.claims.length} do delta); rodar o roteiro de novo (#13597)`);
  return 0;
}

/** #11935: um XML por sequência, nomeado por ela (`Diaria comentada_Youtube_V1.xml`). */
export function xmlFileName(seqName: string): string {
  return `${seqName.replace(/[\\/:*?"<>|]/g, "-")}.xml`;
}
export function srtFileName(seqName: string): string {
  return `${seqName} - legendas.srt`;
}
/** Formato para as sequências da edição; cortes preservam `previa {slug}` (#13208). */
export function previewFileName(edition: string, label: SequenceTarget | string): string {
  const format = label === "youtube" ? "horizontal" : label === "outras-redes" || label === "instagram" ? "vertical" : label;
  return `${edition} - previa ${format}.mp4`;
}

/** O que o refino por áudio fez neste build (#11500), gravado no `plan.json`. */
export interface CutRefineInfo {
  applied: boolean;
  /** Por que não rodou (ou rodou só a passada A). */
  reason?: string;
  thresholdDb?: number;
  highBandWarnings?: Record<string, string[]>;
  /** Bordas retranscritas (janelas únicas, as verticais dividem as mesmas). */
  edgeWindows?: number;
  edgesRetranscribed?: boolean;
  /** Detector de fala do corte de pausas (#12089): aplicado, ou o motivo de ter ficado o silencedetect. */
  speechDetect?: { applied: true; islands: number } | { applied: false; reason: string };
}

/**
 * O detector de fala do corte de pausas (#12089): o bruto a 48 kHz, mono,
 * banda cheia (cache `audio-48k.wav`, chave = o bruto), quadros de 5 ms
 * (`SPEECH_DETECT`). Bruto ausente nesta máquina = null com o motivo: o build
 * segue com o `silences.json`, com [aviso].
 */
function speechDetection(ctx: Ctx, source: SourceInfo, opts: SpeechDetectOptions = {}): { cut: SpeechCut | null; reason?: string; thresholds?: SpeechThresholds; voice?: SpeechVoiceFilter } {
  const input = audioInputOf(ctx, source);
  if (!existsSync(input)) return { cut: null, reason: `bruto ausente nesta máquina (${input})` };
  const audio = join(ctx.workDir, "audio-48k.wav");
  const meta = join(ctx.workDir, "audio-48k.meta.json");
  const st = statSync(input);
  const key = JSON.stringify({ path: input, size: st.size, mtimeMs: st.mtimeMs, sampleRate: SPEECH_DETECT.sampleRate });
  if (ctx.force || !existsSync(audio) || !existsSync(meta) || readFileSync(meta, "utf8").trim() !== key) {
    mkdirSync(ctx.workDir, { recursive: true });
    rmSync(meta, { force: true });
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", input, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(SPEECH_DETECT.sampleRate), "-c:a", "pcm_s16le", audio]);
    writeFileAtomic(meta, key + "\n");
  }
  const { samples, sampleRate } = parseWavPcm16(readFileSync(audio));
  const energy: FrameEnergy = frameEnergies(samples, sampleRate);
  // #12089: limiar relativo ao bruto (o fixo num bruto baixo), medido uma vez, e, com a voz medida, respiração e ruído fora das ilhas.
  const th = speechThresholds(energy, { fullDb: opts.fullDb, diffDb: opts.diffDb });
  const voice = applyVoiceFilter(energy, th, opts.voice === false ? null : () => {
    const anchor = voiceAnchorDb(th.fullDb);
    return voicedFrames(samples, sampleRate, energy.hopS, energy.fullDb.length, (i) => energy.fullDb[i] > anchor);
  });
  // #12263: o começo de cada ilha recua até o ataque medido contra o piso do bruto, não só o limiar fixo.
  const islands = extendIslandAttacks(energy, speechIslands(energy, { thresholds: th }), { speechFullDb: th.fullDb });
  return { cut: { islands, silences: speechPauseSilences(islands, source.durationS), energy, detectDb: { fullDb: th.fullDb, diffDb: th.diffDb } }, thresholds: th, voice };
}

/** Cache separado do Whisper: nunca reamostrar o WAV de 16 kHz para medir agudos. */
/**
 * A leitura do `transcribe` (#13508): UM ffmpeg sobre o áudio do bruto grava o
 * WAV de 16 kHz (Whisper), a banda alta de 48 kHz (#11940, antes uma 2ª leitura
 * do bruto inteiro no `highBandEnvelope`) e mede o loudness (resumo no stderr).
 * O proxy 1440p, quando há, é pendurado depois (`runExtractWithProxy`).
 */
export function transcribeExtractArgs(input: { input: string; audio: string; highBand: string }): string[] {
  return [
    "-hide_banner", "-nostats", "-y", "-i", input.input,
    "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", input.audio,
    ...highBandOutputArgs(input.highBand),
    "-map", "0:a:0", "-af", `${LOUDNORM_TARGET}:print_format=json`, "-f", "null", "-",
  ];
}

/** O WAV da banda alta (48 kHz, #11940) e a meta que diz de qual entrada ele saiu. */
export const HIGH_BAND = { file: "audio-high-48k.wav", meta: "audio-high-48k.meta.json" } as const;

/**
 * A chave da banda alta (#11940): a entrada (caminho, tamanho, mtime) e os
 * parâmetros que mudam o WAV. Só os campos do #11940 (na mesma ordem): os do
 * limiar relativo (#11968) não mudam o WAV, e entrar na chave obrigaria a
 * reextrair do bruto à toa.
 */
export function highBandKey(input: string, st: { size: number; mtimeMs: number }): string {
  const S = SIBILANTS;
  return JSON.stringify({ path: input, size: st.size, mtimeMs: st.mtimeMs, sampleRate: S.sampleRate, highpassHz: S.highpassHz, thresholdDb: S.thresholdDb, quietS: S.quietS, airS: S.airS, windowS: S.windowS });
}

/** A saída da banda alta para um ffmpeg cuja entrada 0 é o áudio do bruto (#11940; na leitura do `transcribe` desde o #13508). */
export function highBandOutputArgs(out: string): string[] {
  return ["-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(SIBILANTS.sampleRate), "-af", `highpass=f=${SIBILANTS.highpassHz}`, "-c:a", "pcm_s16le", out];
}

function highBandEnvelope(ctx: Ctx, source: SourceInfo) {
  const input = audioInputOf(ctx, source);
  const audio = join(ctx.workDir, HIGH_BAND.file);
  const meta = join(ctx.workDir, HIGH_BAND.meta);
  const key = highBandKey(input, statSync(input));
  // #13508: o `transcribe` já grava a banda alta na mesma leitura do bruto; aqui só quando falta ou mudou.
  if (ctx.force || !existsSync(audio) || !existsSync(meta) || readFileSync(meta, "utf8").trim() !== key) {
    mkdirSync(ctx.workDir, { recursive: true });
    rmSync(meta, { force: true });
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", input, ...highBandOutputArgs(audio)]);
    writeFileAtomic(meta, key + "\n");
  }
  const { samples, sampleRate } = parseWavPcm16(readFileSync(audio));
  if (sampleRate !== SIBILANTS.sampleRate) throw new Error("banda alta deve ser medida a 48 kHz");
  return energyEnvelope(samples, sampleRate);
}

/** O que o `transcribe` grava em `silences.meta.json` (#11351; `floorDb` desde o #12903). */
export interface SilencesMeta {
  noiseDb?: number;
  minDurationS?: number;
  how?: string;
  floorDb?: number | null;
  highBandVersion?: number;
}

/**
 * #12969: o limiar do bruto que o build usa no refino dos cortes e o
 * `verify-xml` usa nas bordas: o `noiseDb` do silences.meta.json (o do último
 * silencedetect, #11351, já com o piso de ruído do #12903), nunca remedido à
 * parte. Remedir no `verify-xml` conferia as bordas num limiar e o build
 * refinava em outro quando o `transcribe` não tinha sido refeito. Sem meta, o
 * padrão (o mesmo do build).
 */
export function verifyXmlEdgeThreshold(meta: SilencesMeta | null): { thresholdDb: number; floorDb: number | null; from: string; warning: string | null } {
  if (typeof meta?.noiseDb !== "number" || !Number.isFinite(meta.noiseDb)) {
    return {
      thresholdDb: SILENCE_DETECT.noiseDb,
      floorDb: null,
      from: "padrão, sem silences.meta.json",
      warning: "sem silences.meta.json: build e verify-xml no limiar padrão; rode transcribe nesta máquina para medir o piso do bruto (#12903)",
    };
  }
  const beforeFloor = meta.how !== "override" && meta.floorDb === undefined;
  return {
    thresholdDb: meta.noiseDb,
    floorDb: typeof meta.floorDb === "number" ? meta.floorDb : null,
    from: "silences.meta.json",
    warning: beforeFloor
      ? "silences.meta.json anterior ao #12903 (sem o piso de ruído medido): build e verify-xml seguem no limiar antigo; rode transcribe e build de novo para o limiar pelo piso do bruto"
      : null,
  };
}

/** Limiar do silêncio do bruto (o do último silencedetect, #11351); sem meta, o padrão. */
function silenceThresholdDb(ctx: Ctx): number {
  const p = f(ctx, "silences.meta.json");
  return verifyXmlEdgeThreshold(existsSync(p) ? readJson<SilencesMeta>(p, "silences.meta.json") : null).thresholdDb;
}

/**
 * Retranscreve as janelas das bordas (#11500) numa chamada só do Python (o
 * modelo carrega uma vez), sem VAD e sem `condition_on_previous_text`. Cache
 * por janela em `edge-retranscribe.json`, válido para o MESMO `audio.wav`
 * (hash do conteúdo, #13505; tamanho + mtime até então): build repetido no loop da
 * autorrevisão não retranscreve, nem depois de uma cópia do work dir.
 */
function edgeTranscripts(ctx: Ctx, audio: string, windows: EdgeWindow[]): Map<string, Word[]> {
  return windowTranscripts(ctx, audio, windows, "edge-retranscribe.json", "refino dos cortes: retranscrevendo {n} borda(s) de clipe (sem VAD)…");
}

/**
 * Retranscrição de janelas do bruto numa chamada só do Python, sem VAD e sem
 * `condition_on_previous_text`, com cache por janela em `cacheName` (válido
 * para o MESMO `audio.wav`). Base das bordas do build (#11500) e das palavras
 * curtas do roteiro (#12093). `{n}` na mensagem = janelas a retranscrever.
 */
function windowTranscripts(ctx: Ctx, audio: string, windows: EdgeWindow[], cacheName: string, message: string): Map<string, Word[]> {
  const cachePath = f(ctx, cacheName);
  // #13505: a chave é o hash do conteúdo do áudio (+ o intervalo, na chave da janela), não tamanho + mtime.
  const id = audioIdentity(audio);
  type Cache = { audio: AudioIdentity; windows: Record<string, Word[]> };
  let cache: Cache = { audio: id, windows: {} };
  let restamp = false;
  if (existsSync(cachePath) && !ctx.force) {
    const c = readJson<Cache>(cachePath, cacheName);
    const m = sameAudio(c.audio, id);
    if (m.same && c.windows && typeof c.windows === "object") {
      cache = { audio: id, windows: c.windows };
      restamp = m.legacy;
    }
  }
  const missing = windows.filter((w) => !(w.key in cache.windows));
  // Cache anterior ao #13505 (tamanho + mtime) que ainda vale: regrava com o hash, para sobreviver à próxima cópia.
  if (!missing.length && restamp) writeJson(cachePath, cache);
  if (missing.length) {
    mkdirSync(ctx.workDir, { recursive: true });
    const stem = cacheName.replace(/\.json$/, "");
    const winFile = join(ctx.workDir, `${stem}.windows.json`);
    const out = join(ctx.workDir, `${stem}.raw.json`);
    writeFileSync(winFile, JSON.stringify(missing));
    console.error(`[video-montagem] ${message.replace("{n}", String(missing.length))}`);
    const vocab = loadVocab();
    run(ctx.python, ["-P", PY_HELPER, audio, out, "--windows", winFile, "--no-condition", "--initial-prompt", vocab.whisper_prompt ?? ""], {
      env: { ...process.env, HF_HUB_OFFLINE: "1" },
      inheritStderr: true,
    });
    const raw = readJson<{ windows: Array<{ key: string; segments: Segment[] }> }>(out, `retranscrição das janelas (${cacheName})`);
    for (const w of raw.windows) cache.windows[w.key] = transcriptWords({ segments: w.segments });
    writeJson(cachePath, cache);
  }
  return new Map(windows.map((w) => [w.key, cache.windows[w.key] ?? []]));
}

/**
 * Refino dos cortes pelo áudio do bruto (#11500), em todas as sequências:
 * vale de energia (A), som fora do roteiro na borda pela retranscrição (B),
 * emenda dos contíguos e zoom alternando só nos cortes (`assembleClips`).
 * Sem `audio.wav` nesta máquina, ou com `--no-audio-refine`, sai como está e
 * avisa; falha da retranscrição deixa só a passada A, também com aviso.
 */
function refineCuts(ctx: Ctx, ps: SequencePlan[], source: SourceInfo, enabled: boolean, speechCut = false): { plans: SequencePlan[]; info: CutRefineInfo; warnings: string[] } {
  if (!enabled) return { plans: ps, info: { applied: false, reason: "--no-audio-refine" }, warnings: ["refino dos cortes por áudio desligado (--no-audio-refine): os cortes seguem os tempos do Whisper"] };
  const audio = join(ctx.workDir, "audio.wav");
  if (!existsSync(audio)) {
    const reason = `áudio do bruto ausente (${audio})`;
    return { plans: ps, info: { applied: false, reason }, warnings: [`${reason}: cortes NÃO refinados pelo áudio; rode transcribe nesta máquina e build de novo`] };
  }
  const { sampleRate, samples } = parseWavPcm16(readFileSync(audio));
  let env = energyEnvelope(samples, sampleRate);
  // #13194: o envelope que o verify-xml mede nas bordas (sem a banda alta), para o build abrir o SOM CORTADO no mesmo critério.
  const verifyEnv = env;
  const thresholdDb = silenceThresholdDb(ctx);
  const words = nonEmptyWords(f(ctx, "transcript.json"), "transcript.json");
  const vocab = loadVocab();
  const rules = [...vocab.rules, ...(loadBlocks(ctx).file.vocabulary ?? [])];
  const match = makeMatcher(vocab.aliases);
  const warnings: string[] = [];
  let highEnv: ReturnType<typeof energyEnvelope> | undefined;
  try { highEnv = highBandEnvelope(ctx, source); }
  catch (e) { warnings.push(`banda alta não conferida: ${(e as Error).message}; disponibilize o bruto e rode build de novo (#11940)`); }
  if (highEnv) env = combinedCutEnvelope(env, highEnv, thresholdDb);
  const highBandWarnings: Record<string, string[]> = {};
  // Passada A em todas as sequências.
  // #12089: com o detector de fala, a borda já está a 150/120 ms da fala; o vale só a afina, sem voltar ao ar de antes.
  const stageA = ps.map((p) => snapClipEdges(p.clips.map(rawOf), env, words, { thresholdDb, durationS: source.durationS, ...(speechCut ? { windowS: SPEECH_CUT_SNAP_WINDOW_S } : {}) }));
  const windows = new Map<string, EdgeWindow>();
  for (const a of stageA) for (const c of a.clips) for (const w of edgeWindowsFor(c, source.durationS)) windows.set(w.key, w);
  let heard: Map<string, Word[]> | null = null;
  try {
    heard = edgeTranscripts(ctx, audio, [...windows.values()]);
  } catch (e) {
    warnings.push(`retranscrição das bordas falhou (${(e as Error).message}): só o vale de energia foi aplicado; som fora do roteiro na borda não conferido`);
  }
  const out = ps.map((p, i) => {
    let clips = stageA[i].clips;
    const adjustments: CutAdjustment[] = [...(p.cutAdjustments ?? []), ...stageA[i].adjustments];
    if (heard) {
      const b = trimEdgeExtras(clips, heard, words, env, { thresholdDb, durationS: source.durationS, match, rules, target: p.spec });
      clips = b.clips;
      adjustments.push(...b.adjustments);
      for (const n of b.notes) warnings.push(`${p.spec.name}: ${n}`);
    }
    if (highEnv) {
      // #11968: as palavras retranscritas das bordas também limitam a expansão,
      // senão ela reabre o som fora do roteiro que a passada B acabou de tirar.
      const heardPerClip = heard ? stageA[i].clips.map((c) => edgeWindowsFor(c, source.durationS).flatMap((w) => heard!.get(w.key) ?? [])) : undefined;
      const protectedEdges = preserveSibilants(clips, highEnv, words, source.durationS, source.fps, heardPerClip);
      clips = protectedEdges.clips;
      adjustments.push(...protectedEdges.adjustments);
    }
    // #12559: o refino mede no áudio global; a borda nunca passa para o arquivo vizinho.
    clips = clampRawsToFiles(clips, source);
    // #13239 item 2: a pausa da vinheta sai do refino com a duração pedida.
    clips = restoreFillerEdges(clips, p.clips);
    let assembled = assembleClips(p.spec, clips, source.fps);
    adjustments.push(...assembled.merges);
    // #13194: borda que o verify-xml acusaria como SOM CORTADO abre até o silêncio aqui, sem esperar o verify.
    const opened = openCutEdgesOfPlan(assembled.clips, verifyEnv, thresholdDb, source, words, heard);
    if (opened.adjustments.length) {
      adjustments.push(...opened.adjustments);
      assembled = assembleClips(p.spec, opened.clips.map(rawOf), source.fps);
      adjustments.push(...assembled.merges);
    }
    for (const n of opened.warnings) warnings.push(`${p.spec.name}: ${n}`);
    // #13460: vão de menos de 0,1 s entre clipes contíguos no bruto (o refino e a abertura acima deixam) fecha.
    const slivers = closeSliverGaps(assembled.clips, edgeNeighborWords(words, heard), source.fps);
    if (slivers.adjustments.length) {
      adjustments.push(...slivers.adjustments);
      assembled = assembleClips(p.spec, slivers.clips.map(rawOf), source.fps);
      adjustments.push(...assembled.merges);
    }
    highBandWarnings[sequenceKey(p.spec)] = highEnv
      ? highBandCutWarnings(assembled.clips.map((c) => ({ ...c, srcIn: c.frameIn / source.fps, srcOut: c.frameOut / source.fps })), highEnv)
      : ["banda alta não conferida: bruto indisponível; possível fonema cortado (#11940)"];
    warnings.push(...highBandWarnings[sequenceKey(p.spec)].map((w) => `${p.spec.name}: ${w}`));
    for (const w of speechCutWarnings(assembled.clips, env, thresholdDb)) warnings.push(`${p.spec.name}: ${w}`);
    return { ...p, clips: assembled.clips, durationFrames: assembled.durationFrames, cutAdjustments: adjustments };
  });
  return { plans: out, info: { applied: true, thresholdDb, edgeWindows: windows.size, edgesRetranscribed: heard !== null, highBandWarnings }, warnings };
}

/**
 * #13194: aplica `openCutSoundEdges` (o critério das bordas do `verify-xml`)
 * aos clipes montados de uma sequência. As palavras vizinhas que limitam a
 * abertura são as do transcript e as da retranscrição das bordas (o som fora
 * do roteiro que a passada B tirou só aparece nelas, #11968). O limiar de cada
 * borda é o menor entre `thresholdDb` (o fixo do bruto, `noiseDb`) e
 * max(-60, piso de ruído local + 3 dB) (`localEdgeThreshold`). Abre a borda
 * `open` do `edgeFindings`: acima do fixo (como antes), ou acima do relativo
 * com energia sustentada (fala; estalo e respiro curto ficam), até o 1º ponto
 * abaixo do limiar. Borda que não achou silêncio antes do limite vira aviso
 * com o limite: SOM CORTADO no `verify-xml` se acima do fixo, senão aviso
 * `sem-abertura`. O `filler` da vinheta só abre acima do fixo.
 */
export function openCutEdgesOfPlan(
  clips: PlannedClip[],
  env: ReturnType<typeof energyEnvelope>,
  thresholdDb: number,
  source: SourceInfo,
  words: Word[],
  heard: Map<string, Word[]> | null,
): { clips: PlannedClip[]; adjustments: CutAdjustment[]; warnings: string[] } {
  const neighbors = edgeNeighborWords(words, heard);
  const r = openCutSoundEdges(clips, source.fps, (a, b) => maxDbIn(env, a, b), localEdgeThreshold(env, thresholdDb), {
    durationS: source.durationS,
    words: neighbors,
    bounds: isMultiSource(source) ? fileBounds(source) : undefined,
    ownWord: (c, edge, w) => isOwnEdgeWord(c.script, edge, w),
  });
  const side = (e: "in" | "out") => (e === "in" ? "entrada" : "saída");
  const limiarNote = (db: number) => (db < thresholdDb - 1e-9 ? `, piso local + ${LOCAL_FLOOR_EDGE.marginDb} dB` : "");
  return {
    clips: r.clips,
    adjustments: r.opened.map((o) => ({
      block: o.block,
      edge: o.edge,
      from: o.from,
      to: Math.round(o.to * 1000) / 1000,
      reason: o.valley
        ? `SOM CORTADO na borda (${Math.round(o.fromDb)} dB fora, limiar ${Math.round(o.thresholdDb)} dB${limiarNote(o.thresholdDb)}) sem silêncio antes do limite: aberto até o vale de energia (${Math.round(o.toDb)} dB fora), não até o silêncio (#13460)`
        : `SOM CORTADO na borda (${Math.round(o.fromDb)} dB fora, limiar ${Math.round(o.thresholdDb)} dB${limiarNote(o.thresholdDb)}): aberto até o silêncio (${Math.round(o.toDb)} dB) (#13194)`,
    })),
    warnings: r.unresolved.map((u) =>
      u.error
        ? `${u.block}: ${side(u.edge)} em ${u.atS.toFixed(2)} s do bruto com SOM CORTADO (${Math.round(u.db)} dB fora, limiar ${Math.round(u.thresholdDb)} dB${limiarNote(u.thresholdDb)}) sem silêncio antes do limite da abertura (${u.limit} em ${u.limitS.toFixed(2)} s): o verify-xml vai acusar; conferir no Premiere (#13194)`
        : `${u.block}: ${side(u.edge)} em ${u.atS.toFixed(2)} s do bruto com ${Math.round(u.db)} dB fora (limiar ${Math.round(u.thresholdDb)} dB${limiarNote(u.thresholdDb)}): ${softReasonText({ reason: "sem-abertura", aboveMs: Math.round(u.aboveS * 1000), thresholdDb: u.thresholdDb, limit: u.limit, limitS: u.limitS }, (x) => `${x.toFixed(2)} s`)}; o verify-xml avisa (#13194)`,
    ),
  };
}

/** As palavras do bruto que limitam a abertura das bordas: o transcript e a retranscrição das bordas, sem as vazias (#13194, #13460). */
export function edgeNeighborWords(words: Word[], heard: Map<string, Word[]> | null): Word[] {
  return [...words, ...(heard ? [...heard.values()].flat() : [])].filter((w) => w.text.trim());
}

/** A palavra de fora colada na borda é a 1ª (entrada) ou a última (saída) do roteiro do próprio clipe (#13194). */
export function isOwnEdgeWord(script: string | undefined, edge: "in" | "out", w: { text?: string }): boolean {
  const toks = tokenize(script ?? "");
  const own = edge === "in" ? toks[0] : toks[toks.length - 1];
  return !!own && !!w.text && normalizeToken(w.text) === own;
}

/**
 * #13194: os limites que o build usa para abrir as bordas, para o `verify-xml`
 * julgar como erro só o que o build abriria: as palavras do bruto
 * (`verifyEdgeWords`), o roteiro de cada clipe do plano (a 1ª/última palavra
 * dele não limita) e os clipes `filler` (pausa da vinheta, só limiar fixo).
 * Roteiro e `filler` valem só no clipe do XML cujas bordas batem com as do
 * plano (±1 quadro): clipe divergente (XML de outro build, editado à mão) vira
 * [aviso] e é julgado sem eles.
 */
export function verifyEdgeContext(
  plan: { clips: ReadonlyArray<{ frameIn: number; frameOut: number; script?: string; filler?: true }> },
  xmlClips: ReadonlyArray<Pick<TimelineClip, "gIn" | "gOut">>,
  opts: { fps: number; rate: number; words: ReadonlyArray<Word>; durationS: number; bounds?: ReadonlyArray<{ start: number; end: number }> },
): { ctx: EdgeFindingsContext; warnings: string[] } {
  const warnings: string[] = [];
  const tol = 1 / opts.fps + 1e-6;
  let aligned: boolean[];
  if (plan.clips.length !== xmlClips.length) {
    aligned = xmlClips.map(() => false);
    warnings.push(`${xmlClips.length} clipes no XML, ${plan.clips.length} no plano: roteiro e filler do plano não aplicados nas bordas (#13194)`);
  } else {
    aligned = xmlClips.map((x, i) => {
      const p = plan.clips[i];
      const ok = Math.abs(p.frameIn / opts.fps - x.gIn / opts.rate) <= tol && Math.abs(p.frameOut / opts.fps - x.gOut / opts.rate) <= tol;
      if (!ok) warnings.push(`clipe ${i + 1}: bordas do XML (${(x.gIn / opts.rate).toFixed(3)}–${(x.gOut / opts.rate).toFixed(3)} s) diferentes das do plano (${(p.frameIn / opts.fps).toFixed(3)}–${(p.frameOut / opts.fps).toFixed(3)} s): roteiro e filler do plano não aplicados nele (#13194)`);
      return ok;
    });
  }
  return {
    ctx: {
      words: opts.words.filter((w) => w.text.trim()),
      ownWord: (i, edge, w) => aligned[i] && isOwnEdgeWord(plan.clips[i]?.script, edge, w),
      fixedOnly: xmlClips.map((_, i) => aligned[i] && !!plan.clips[i]?.filler),
      durationS: opts.durationS,
      ...(opts.bounds ? { bounds: opts.bounds } : {}),
    },
    warnings,
  };
}

/** O que `verifyEdgeWords` lê do disco: o transcript e o cache da retranscrição das bordas, com a identidade do `audio.wav`. */
export interface VerifyEdgeWordsInput {
  /** `null` = transcript.json ausente ou ilegível. */
  transcript: Word[] | null;
  /** `null` = edge-retranscribe.json ausente ou ilegível. */
  cache: { audio?: { size?: number; mtimeMs?: number; sha256?: string }; windows?: Record<string, Word[]> } | null;
  /** Identidade do `audio.wav` desta máquina (tamanho, mtime e, desde o #13505, o hash do conteúdo). */
  audio: AudioIdentity;
}

/**
 * #13194: as palavras do bruto que limitam a abertura no `verify-xml`, como no
 * build: o transcript e as janelas da retranscrição das bordas. Do cache só
 * entram as janelas de `edgeWindowsFor` dos clipes do plano atual, e só se ele
 * é do MESMO `audio.wav` (hash do conteúdo desde o #13505, como `windowTranscripts`). Cache
 * ausente, inválido ou de outro áudio, e transcript ausente ou vazio, viram
 * [aviso] e o verify segue com o que há (nunca aborta).
 */
export function verifyEdgeWords(input: VerifyEdgeWordsInput & { planClips: ReadonlyArray<Pick<RawClip, "srcIn" | "srcOut">>; durationS: number }): { words: Word[]; warnings: string[] } {
  const warnings: string[] = [];
  const words: Word[] = [];
  if (!input.transcript?.length) warnings.push("transcript.json ausente ou sem palavras: limites de palavra do build não aplicados (só teto, arquivo e clipe vizinho) (#13194)");
  else words.push(...input.transcript);
  const c = input.cache;
  if (!c || !c.windows || typeof c.windows !== "object") warnings.push("edge-retranscribe.json ausente ou inválido: palavras da retranscrição das bordas não aplicadas (#13194)");
  else if (!sameAudio(c.audio, input.audio).same) warnings.push("edge-retranscribe.json é de outro audio.wav: palavras da retranscrição das bordas não aplicadas; rode build de novo nesta máquina (#13194)");
  else {
    const keys = new Set(input.planClips.flatMap((x) => edgeWindowsFor(x, input.durationS).map((w) => w.key)));
    for (const [k, ws] of Object.entries(c.windows)) if (keys.has(k) && Array.isArray(ws)) words.push(...ws.filter((w) => typeof w?.start === "number" && typeof w?.end === "number" && typeof w?.text === "string"));
  }
  return { words, warnings };
}

/** Lê o que `verifyEdgeWords` precisa; arquivo ausente ou ilegível vira `null`, nunca erro (#13194). */
function readVerifyEdgeWordsInput(ctx: Ctx, audio: string): VerifyEdgeWordsInput {
  const tryRead = <T,>(path: string, what: string): T | null => {
    if (!existsSync(path)) return null;
    try {
      return readJson<T>(path, what);
    } catch {
      return null;
    }
  };
  const t = tryRead<Transcript>(f(ctx, "transcript.json"), "transcript.json");
  return {
    transcript: t ? transcriptWords(t) : null,
    cache: tryRead<VerifyEdgeWordsInput["cache"] & object>(f(ctx, "edge-retranscribe.json"), "edge-retranscribe.json"),
    audio: audioIdentity(audio),
  };
}

/** Janela do vale de energia quando o corte vem do detector de fala (#12089): afina, não reabre a pausa. */
export const SPEECH_CUT_SNAP_WINDOW_S = 0.05;

const rawOf = (c: PlannedClip): RawClip => ({
  block: c.block,
  srcIn: c.srcIn,
  srcOut: c.srcOut,
  ...(c.script ? { script: c.script } : {}),
  ...(c.parts ? { parts: c.parts } : {}),
  // O corte de pausa curta segue sem troca de zoom depois do refino (#11753).
  ...(c.keepScale ? { keepScale: true as const } : {}),
  ...(c.framing ? { framing: c.framing } : {}),
  // #12559 (review da PR #12563): sem isto o refino (que roda por padrão) jogava todo clipe no 1º arquivo, sem o encaixe.
  ...(c.file !== undefined ? { file: c.file } : {}),
  ...(c.fit !== undefined ? { fit: c.fit } : {}),
  // #13239 item 2: sem isto a pausa da vinheta (#13204) perdia a marca no refino e virava clipe comum.
  ...(c.filler ? { filler: true as const } : {}),
});

/** Exportado para o teste (#12559): o refino preserva arquivo e encaixe do clipe. */
export const rawClipOf = rawOf;

/**
 * #13239 item 2: a pausa da vinheta (`filler`, #13204) é silêncio escolhido de
 * propósito, com a duração que a vinheta pede: o refino das bordas (vale de
 * energia, sibilantes, arquivo) não a encolhe. Os clipes `filler` voltam às
 * bordas de antes do refino, na ordem em que aparecem.
 */
export function restoreFillerEdges<T extends Pick<RawClip, "srcIn" | "srcOut" | "filler">>(refined: readonly T[], before: ReadonlyArray<Pick<RawClip, "srcIn" | "srcOut" | "filler">>): T[] {
  const orig = before.filter((c) => c.filler);
  let k = 0;
  return refined.map((c) => {
    if (!c.filler) return c;
    const o = orig[k++];
    return o ? { ...c, srcIn: o.srcIn, srcOut: o.srcOut } : c;
  });
}

/**
 * #13241: o clipe curto (abaixo de 0,3 s) de cada sequência, no plano final
 * (depois do refino, ou sem ele): funde ao vizinho contíguo no bruto ou sai
 * (`absorbShortClips`), e a sequência é remontada (`assembleClips`: escala e
 * posições). Os ajustes entram no `cutAdjustments` do plano; as notas, no relato do build.
 */
export function absorbShortClipsOfPlans(ps: readonly SequencePlan[], words: ReadonlyArray<Pick<Word, "start" | "end">>, fps: number): { plans: SequencePlan[]; notes: string[] } {
  const notes: string[] = [];
  const plans = ps.map((p) => {
    const r = absorbShortClips(p.clips.map(rawOf), words);
    for (const n of r.notes) notes.push(`${p.spec.name}: ${n}`);
    if (!r.adjustments.length) return p;
    const assembled = assembleClips(p.spec, r.clips, fps);
    return { ...p, clips: assembled.clips, durationFrames: assembled.durationFrames, cutAdjustments: [...(p.cutAdjustments ?? []), ...r.adjustments, ...assembled.merges] };
  });
  return { plans, notes };
}

/**
 * Versão do XML de cada sequência deste build (#12111): o nome passa a
 * `_V{n}`, com `n` de `pickXmlVersion` sobre os XML dessa sequência já no out
 * dir (no modo API, o cache local: versão que só existe no Drive não é vista).
 * Muda o `spec.name` dos planos (o plan.json, o srt e a prévia seguem o nome
 * novo). Devolve o fingerprint de versão de cada sequência (`xmlVersionHashOf`,
 * #12160), que vai também no `<sequence id>`.
 */
export function versionPickedSequences(ctx: Ctx, picked: SequencePlan[], hash: string, opts: XmlBuildOptions): Map<SequencePlan, string> {
  // #13610: o `arquivo/` do out dir também conta (no Neo o out dir é a pasta da edição, e a versão anterior sai da raiz).
  const files = xmlNamesWithArchive(ctx.outDir);
  const planned = plannedXmlVersions(ctx);
  const hashes = new Map<SequencePlan, string>();
  for (const p of picked) {
    const versionHash = xmlVersionHashOf(hash, p, opts);
    hashes.set(p, versionHash);
    const nameVersion = sequenceNameVersion(p.spec.name);
    if (nameVersion === null) {
      console.error(`[aviso] ${p.spec.name}: nome sem _V{n}, o XML sai sem versão e sobrescreve o anterior (#12111)`);
      continue;
    }
    const existing = files.flatMap(({ name: n, path }) => {
      const v = sequenceNameVersion(n.slice(0, -4));
      if (v === null || xmlFileName(versionedSequenceName(p.spec.name, v)) !== n) return [];
      let id: ReturnType<typeof parseSequenceIdVersion> = null;
      try { id = parseSequenceIdVersion(readFileSync(path, "utf8")); } catch { /* ilegível: conta como outro plano */ }
      return [{ version: v, hash: id?.hash ?? null }];
    });
    // #13610: a versão que o plan.json (sincronizado entre as máquinas) registra para esta sequência também conta.
    const fromPlan = planned[sequenceKey(p.spec)];
    if (fromPlan) existing.push(fromPlan);
    const version = pickXmlVersion(existing, versionHash, nameVersion);
    p.spec = { ...p.spec, name: versionedSequenceName(p.spec.name, version) };
  }
  return hashes;
}

/**
 * #13610: a versão de cada sequência no `plan.json` (`xmlVersions`, o
 * `<sequence id>` `seq-{chave}-v{n}-{hash}`): a numeração do build não volta
 * atrás quando o XML foi para o `arquivo/` ou só existe em outra máquina.
 * Ausente/ilegível = nada (a numeração segue pelos arquivos).
 */
export function plannedXmlVersions(ctx: Pick<Ctx, "stateDir">, warn: (m: string) => void = (m) => console.error(`[aviso] ${m}`)): Record<string, { version: number; hash: string }> {
  const out: Record<string, { version: number; hash: string }> = {};
  const path = f(ctx, "plan.json");
  if (!existsSync(path)) return out;
  try {
    const pf = JSON.parse(readFileSync(path, "utf8")) as Pick<PlanFile, "xmlVersions">;
    for (const [k, v] of Object.entries(pf.xmlVersions ?? {})) {
      const parsed = typeof v?.id === "string" ? versionOfSequenceId(v.id) : null;
      if (parsed) out[k] = parsed;
    }
  } catch (e) {
    warn(`plan.json ilegível (${(e as Error).message}): a versão do XML segue só pelos arquivos do out dir e do arquivo/ (#13610)`);
  }
  return out;
}

/**
 * #13610 B: os XMLs que o `plan.json` diz vigentes (o nome versionado de cada
 * sequência do último build). Algum fora da listagem da raiz = nenhum asset sai.
 * Ausente/ilegível = nenhum (o guard de asset mais novo que o XML segue valendo).
 */
export function plannedXmlFileNames(ctx: Pick<Ctx, "stateDir">): string[] {
  const path = f(ctx, "plan.json");
  if (!existsSync(path)) return [];
  try {
    const pf = JSON.parse(readFileSync(path, "utf8")) as Partial<Pick<PlanFile, "plans">>;
    return (pf.plans ?? []).flatMap((p) => (typeof p?.spec?.name === "string" && sequenceNameVersion(p.spec.name) !== null ? [xmlFileName(p.spec.name)] : []));
  } catch {
    return [];
  }
}

/**
 * Os arquivos SOLTOS de uma pasta (nome + tamanho), sem subpastas: é a lista de
 * onde o `transcribe`/`inventory` escolhem o bruto. `arquivo/` (#13610),
 * `Final/`, `Brutos/` e as demais subpastas nunca entram.
 */
export function looseFilesIn(dir: string): Array<{ name: string; size: number }> {
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => ({ name: d.name, size: statSync(join(dir, d.name)).size }));
}

/** Uma linha do relato por ajuste de corte (#11500). */
export function adjustmentLine(a: CutAdjustment): string {
  const edge = a.edge === "in" ? "entrada" : a.edge === "out" ? "saída" : "emenda";
  return `   ajuste ${a.block} ${edge}: ${a.from.toFixed(2)} → ${a.to.toFixed(2)} s (${a.reason})`;
}

/** `--title-mode` do build (#11756): PNG na V2 (padrão desde o #12091) ou sem título. */
export type TitleMode = "png" | "off";

/**
 * #12104: o `text` (gerador "Text" do FCP7 sobre fundo Color+Crop, nunca
 * validado num import) saiu por decisão do editor. Pedir o modo removido é
 * erro explícito, para ninguém achar que o gerador ainda sai.
 */
export function parseTitleModeArg(v: string | undefined): TitleMode {
  if (v === undefined) return "png";
  if (v === "png" || v === "off") return v;
  if (v === "text") {
    throw new Error('--title-mode text foi removido (#12104): o título da vertical sai só em PNG (padrão, "--title-mode png") ou "--title-mode off" para tirar');
  }
  throw new Error(`--title-mode precisa ser png ou off (veio "${v}")`);
}

/** O título que o `build` passa ao XML (#12091): o PNG como clipe na V2. */
export function screenTitleXmlFor(text: string, pngXmlPath: string): ScreenTitleXml {
  return { text, mode: "png", pngPath: pngXmlPath };
}

/**
 * Texto do título da vertical (#11756): o `screenTitle` do blocks.json vence
 * ("" desliga, decisão do editor); sem ele, o título do D1 da edição, sem
 * markdown. Nenhum dos dois = sem título, com aviso no build.
 */
export function resolveScreenTitle(input: { blocksTitle?: string; d1Title?: string | null }): { text: string | null; how: "blocks" | "blocks-off" | "d1" | "missing" } {
  if (input.blocksTitle !== undefined) {
    const t = input.blocksTitle.replace(/\s+/g, " ").trim();
    return t ? { text: t, how: "blocks" } : { text: null, how: "blocks-off" };
  }
  const d1 = input.d1Title ? stripInlineMarkdown(input.d1Title).replace(/\s+/g, " ").trim() : "";
  return d1 ? { text: d1, how: "d1" } : { text: null, how: "missing" };
}

/**
 * O título de cada vídeo para o roteiro (#12585), chave = `sequenceKey`, com a
 * origem entre parênteses. Fonte única com o que vai ao ar:
 * - horizontal: `buildYouTubeTitle` do D1, o mesmo do `publish-youtube.ts`
 *   (sem `--title`);
 * - vertical da edição: `resolveScreenTitle` com o `screenTitle` do
 *   `blocks.json` ou o D1, o mesmo texto do PNG do título do `build`;
 * - corte: o `screenTitle` da sequência (o `--title` do `publish-shorts.ts
 *   --corte`); sem ele, o build usa o título da vertical da edição.
 */
export function videoTitlesFor(
  specs: ReadonlyArray<Pick<SequenceSpec, "target" | "corte" | "screenTitle">>,
  input: { blocksTitle?: string; d1Title?: string | null; roteiroTitle?: string | null },
): Record<string, string> {
  const out: Record<string, string> = {};
  const vertical = resolveScreenTitle(input);
  const verticalText =
    vertical.how === "blocks" ? `${vertical.text} (screenTitle do blocks.json)`
      : vertical.how === "d1" ? `${vertical.text} (título do D1; screenTitle no blocks.json sobrepõe)`
        : vertical.how === "blocks-off" ? "(sem título na tela: screenTitle vazio no blocks.json)"
          : "(sem título: nem screenTitle no blocks.json nem D1 em 02-reviewed.md)";
  for (const s of specs) {
    const key = sequenceKey(s);
    if (s.corte !== undefined) {
      const t = s.screenTitle === undefined ? null : resolveScreenTitle({ blocksTitle: s.screenTitle });
      out[key] = !t ? `${verticalText}, o da vertical da edição: o corte não tem screenTitle na sequência`
        : t.text ? `${t.text} (screenTitle da sequência do corte)` : "(sem título na tela: screenTitle vazio na sequência do corte)";
    } else if (s.target === "youtube") {
      // #12751: o título do horizontal no roteiro do vídeo vence o do D1, como no publish-youtube.ts.
      const doRoteiro = input.roteiroTitle ? buildYouTubeTitle(input.roteiroTitle) : "";
      if (doRoteiro) {
        out[key] = `${doRoteiro} (título do roteiro do vídeo, o do publish-youtube.ts sem --title)`;
        continue;
      }
      const yt = input.d1Title ? buildYouTubeTitle(input.d1Title) : "";
      out[key] = yt ? `${yt} (título do D1, o do publish-youtube.ts sem --title)` : "(sem D1 em 02-reviewed.md: o publish-youtube.ts não acha o título)";
    } else {
      out[key] = verticalText;
    }
  }
  return out;
}

/** PNG do título (fallback do gerador de texto, #11756): sai no out dir, ao lado do XML. */
export function titlePngFileName(edition: string, corte?: string): string {
  return corte ? `${edition}_titulo_vertical-${corte}.png` : `${edition}_titulo_vertical.png`;
}

/** Caminho do PNG no XML: a mesma pasta do bruto no XML (a pasta da edição, para onde o out dir sobe). `corte` = o PNG do título daquele corte (#11900). */
export function titlePngXmlPath(mediaPath: string, edition: string, corte?: string): string {
  const p = mediaPath.replace(/\\/g, "/");
  return `${p.slice(0, p.lastIndexOf("/") + 1)}${titlePngFileName(edition, corte)}`;
}

/** #12255: identidade pelo SVG preserva o PNG que cada XML antigo referencia. */
export async function renderVersionedTitlePng(input: {
  outDir: string; mediaPath: string; edition: string; corte?: string;
  text: string; width: number; height: number;
}): Promise<{ png: string; xmlPath: string }> {
  const svg = screenTitleSvg(input.text, input.width, input.height);
  const hash = createHash("sha256").update(svg).digest("hex").slice(0, 16);
  const name = titlePngFileName(input.edition, input.corte).replace(/\.png$/, `-${hash}.png`);
  const png = join(input.outDir, name);
  await sharp(Buffer.from(svg)).png().toFile(png);
  const xmlPath = titlePngXmlPath(input.mediaPath, input.edition, input.corte).replace(/[^/]+$/, name);
  return { png, xmlPath };
}

/** #13123: quadros da capa no começo de uma sequência (cortados na duração dela); sem capa = null. */
export function capaFramesOf(capa: Pick<CapaInicioAsset, "frames"> | undefined | null, durationFrames: number): number | null {
  return capa ? Math.min(capa.frames, durationFrames) : null;
}

/** Caminho do PNG da capa no XML: a pasta do bruto no XML (a pasta da edição, para onde o out dir sobe). */
export function capaInicioXmlPath(mediaPath: string, name: string): string {
  const p = mediaPath.replace(/\\/g, "/");
  return `${p.slice(0, p.lastIndexOf("/") + 1)}${name}`;
}

/**
 * #13123 (em teste): o PNG da capa (painel + gancho do Short, transparente) de
 * uma vertical, na pasta da edição (out dir). O nome leva o hash do PNG: um
 * XML antigo segue achando o dele.
 */
export async function renderCapaInicio(input: {
  outDir: string; mediaPath: string; edition: string; corte?: string;
  text: string; width: number; height: number; fps: number; ms: number;
  compose?: typeof composeShortCoverOverlay;
}): Promise<{ asset: CapaInicioAsset; warnings: string[] }> {
  const { png, warnings } = await (input.compose ?? composeShortCoverOverlay)({ hook: input.text, width: input.width, height: input.height });
  const hash = createHash("sha256").update(png).digest("hex").slice(0, 16);
  const name = capaInicioFileName(input.edition, input.corte, hash);
  const out = join(input.outDir, name);
  // Gravado em todo build, como o PNG do título: no modo API o snapshot do out dir vê o arquivo e o sobe.
  writeFileSync(`${out}.part`, png);
  renameSync(`${out}.part`, out);
  return {
    asset: { path: out, xmlPath: capaInicioXmlPath(input.mediaPath, name), width: input.width, height: input.height, frames: capaInicioFrames(input.fps, input.ms), ms: input.ms, text: input.text },
    warnings,
  };
}

/**
 * #13123: as capas do começo das verticais deste build. Desligado
 * (`capaInicio` ausente/false no blocks.json) = nenhuma, sem aviso. Ligado:
 * texto pela ordem de `resolveCapaInicioText`; sem texto ou falha no desenho =
 * a vertical sai sem a capa, com aviso.
 */
async function renderCapaInicioAssets(ctx: Ctx, file: BlocksFile, picked: SequencePlan[], fps: number, mediaPath: string): Promise<Record<string, CapaInicioAsset>> {
  const out: Record<string, CapaInicioAsset> = {};
  const ms = capaInicioMsOf(file.capaInicio);
  if (ms === null) return out;
  const verticals = picked.filter((p) => isVerticalSpec(p.spec));
  if (!verticals.length) return out;
  const pecas = readRoteiroPecas(editionDirFor(ctx.edition), (m) => console.error(`[aviso] ${m}`));
  const roteiro = { vertical1: pecas?.vertical1?.capa, vertical2: pecas?.vertical2?.capa };
  for (const p of verticals) {
    const t = resolveCapaInicioText({ spec: p.spec, fileCapa: file.capa, roteiro, corteVertical2: VERTICAL2_CORTE_SLUG });
    if (t.text === null) {
      console.error(`[aviso] ${p.spec.name}: capaInicio ligado, mas sem texto da capa (capa na sequência, capa no blocks.json ou porVideo.*.capa no roteiro-falas.json): sai sem a capa no começo (#13123)`);
      continue;
    }
    try {
      const { asset, warnings } = await renderCapaInicio({ outDir: ctx.outDir, mediaPath, edition: ctx.edition, corte: p.spec.corte, text: t.text, width: p.spec.width, height: p.spec.height, fps, ms });
      for (const w of warnings) console.error(`[aviso] ${p.spec.name}: capa no começo: ${w}`);
      out[sequenceKey(p.spec)] = asset;
      console.error(
        `[premissa] capa no começo de ${p.spec.name} (#13123, em teste): "${t.text}" (${t.how}), ${basename(asset.path)} na faixa de vídeo do topo nos primeiros ${asset.frames} quadros (${ms} ms), ` +
          `sobre a fala de abertura, sem mexer no áudio; conferir no 1º import e, depois de publicar, qual frame cada rede mostrou como capa`,
      );
    } catch (e) {
      console.error(`[aviso] capa no começo de ${p.spec.name} falhou (${(e as Error).message.split("\n")[0]}): XML sem a capa (#13123)`);
    }
  }
  if (Object.keys(out).length && CAPA_INICIO.defaultMs !== ms) console.error(`[premissa] capaInicio de ${ms} ms no blocks.json (default ${CAPA_INICIO.defaultMs} ms) (#13123)`);
  return out;
}

/**
 * #12571: o card de CTA de uma sequência, em MP4 com o fade-in embutido, na
 * pasta da edição (out dir), ao lado do bruto no XML. O nome leva o hash do
 * conteúdo (SVG, fps, duração, fade): o mesmo card é reaproveitado entre
 * builds e um XML antigo segue achando o dele. PNG intermediário no work dir.
 */
export async function renderCtaCard(input: {
  outDir: string; workDir: string; mediaPath: string; edition: string;
  width: number; height: number; fps: number; share?: string | null;
  /** Duração do card (#13311); ausente = o default `CTA_CARD.durationS`. */
  durationS?: number;
  render?: (png: string, out: string) => void;
}): Promise<{ asset: CtaCardAsset; reused: boolean }> {
  const durationS = input.durationS ?? CTA_CARD.durationS;
  const svg = ctaCardSvg({ width: input.width, height: input.height, share: input.share });
  const hash = createHash("sha256").update(svg).update(`\0${input.fps}\0${durationS}\0${CTA_CARD.fadeInS}`).digest("hex").slice(0, 16);
  const name = ctaCardFileName(input.edition, ctaCardOrientation(input.width, input.height), hash);
  const out = join(input.outDir, name);
  const reused = existsSync(out);
  if (!reused) {
    mkdirSync(input.workDir, { recursive: true });
    const png = join(input.workDir, name.replace(/\.mp4$/, ".png"));
    await sharp(Buffer.from(svg)).png().toFile(png);
    // Render no work dir e cópia para .part + rename: um build interrompido nunca deixa MP4 pela metade no out dir.
    const tmp = join(input.workDir, name);
    (input.render ?? ((a, b) => { run("ffmpeg", ctaCardRenderArgs({ png: a, out: b, fps: input.fps, durationS })); }))(png, tmp);
    copyFileSync(tmp, `${out}.part`);
    renameSync(`${out}.part`, out);
  }
  const p = input.mediaPath.replace(/\\/g, "/");
  const xmlPath = `${p.slice(0, p.lastIndexOf("/") + 1)}${name}`;
  return {
    asset: { path: out, xmlPath, width: input.width, height: input.height, fps: input.fps, frames: ctaCardFrames(input.fps, durationS), share: ctaShareLine(input.share) },
    reused,
  };
}

/** #13219: XML leve ou o bruto, e a folga dos trechos. #13493: `auto` = o limiar decide (`publishing.video.xml_leve`); `--xml-leve`/`--xml-bruto` forçam. */
export interface TrechosBuildOption {
  choice: XmlLeveChoice;
  folgaS: number;
}

/** #13488: os quadros de vídeo do trecho no disco (ffprobe contando pacotes); ffprobe que falha ou arquivo ilegível = null. */
export function probeTrechoFrames(path: string): number | null {
  try {
    return parseTrechoFrameProbe(run("ffprobe", trechoFrameProbeArgs(path)).stdout);
  } catch {
    return null;
  }
}

/** #13512: o arquivo do cache da contagem de quadros. */
export const TRECHO_FRAMES_CACHE = "trechos-quadros-cache.json";

/**
 * #13512: onde o cache mora, no work dir da edição (local: `tmp` no Neo, o
 * cache em disco no modo API). Nunca no out dir nem na `trechos/`: a pasta do
 * Drive sincroniza entre máquinas, e o mtime de um arquivo baixado pelo Drive
 * em outra máquina não é o desta, então a chave não valeria lá.
 */
export function trechoFramesCachePath(workDir: string): string {
  return join(workDir, TRECHO_FRAMES_CACHE);
}

/**
 * #13512: `probe` com cache em `cachePath`, chave caminho absoluto do
 * arquivo + tamanho + mtime. O mesmo arquivo, intacto, não é relido a cada
 * rebuild do XML leve (~1,6 GB de trechos); mudou tamanho ou mtime, sonda de
 * novo. Só contagem válida é guardada (null = ilegível, sempre reprobe);
 * entrada de arquivo que não existe mais é podada ao carregar; cache ausente,
 * corrompido ou que não grava vira sonda direta, nunca erro. Não usar para o
 * `.part` temporário do render (`renderFramesConferidos.probePart`).
 */
export function cachedTrechoProbe(cachePath: string, probe: (path: string) => number | null = probeTrechoFrames): (path: string) => number | null {
  type Entry = { size: number; mtimeMs: number; frames: number };
  const cache: Record<string, Entry> = {};
  let pruned = false;
  try {
    const raw: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, Entry>)) {
        if (existsSync(k)) cache[k] = v;
        else pruned = true;
      }
    }
  } catch { /* sem cache */ }
  const save = () => {
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(cache));
    } catch { /* cache é otimização */ }
  };
  if (pruned) save();
  return (path: string) => {
    const key = resolve(path);
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(key);
    } catch {
      return probe(path);
    }
    const hit = cache[key];
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && Number.isInteger(hit.frames)) return hit.frames;
    const frames = probe(path);
    if (frames === null) {
      if (key in cache) {
        delete cache[key];
        save();
      }
      return null;
    }
    cache[key] = { size: st.size, mtimeMs: st.mtimeMs, frames };
    save();
    return frames;
  };
}

/**
 * #13488: os trechos que os XMLs leves apontam, conferidos contra a mídia
 * REAL em `dir` (a `trechos/` do out dir): ausente, ilegível ou com menos (ou
 * mais) quadros que o nome promete é um problema. O resto do `verify-xml`
 * confere in/out contra a `<duration>` do `<file>`, que é a do nome, não a do
 * arquivo; sem isto, o trecho truncado da 261118 passava.
 */
export function trechoMediaIssues(
  xmlTexts: readonly string[],
  dir: string,
  probe: (path: string) => number | null = probeTrechoFrames,
  /** #13500: os trechos inseridos (`xmlAssets[key].trechosInseridos`), conferidos pelo nome do `xmlPath` em `inseridos.dir` (o out dir). */
  inseridos: { dir: string; clips: readonly Pick<TrechoInseridoClip, "id" | "xmlPath" | "frames">[] } | null = null,
): string[] {
  const names = [...new Set(xmlTexts.flatMap((x) => trechoNamesInXml(x)))];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const c of inseridos?.clips ?? []) {
    const name = c.xmlPath.split(/[\\/]/).pop() || c.xmlPath;
    if (seen.has(name)) continue;
    seen.add(name);
    const path = join(inseridos!.dir, name);
    if (!existsSync(path)) {
      issues.push(`trecho inserido ${c.id} (${name}) ausente em ${inseridos!.dir}: o XML aponta um arquivo que não está no disco; rode build (#13500)`);
      continue;
    }
    const got = probe(path);
    if (!trechoFramesOk(c.frames, got)) issues.push(`trecho inserido ${c.id} (${name}) com ${fmtTrechoFrames(got)} no disco, o XML pede ${c.frames}: imagem preta ou congelada no Premiere; rode build (ele corta o trecho de novo, #13500)`);
  }
  for (const name of names) {
    const want = parseTrechoName(name);
    if (!want) continue;
    const path = join(dir, name);
    const expected = want.end - want.start;
    if (!existsSync(path)) {
      issues.push(`trecho ${name} ausente em ${dir}: o XML aponta um arquivo que não está no disco; rode build (#13488)`);
      continue;
    }
    const got = probe(path);
    if (!trechoFramesOk(expected, got)) issues.push(`trecho ${name} com ${got === null ? "quadros ilegíveis (ffprobe sem contagem)" : `${got} quadro(s)`} no disco, o XML pede ${expected}: imagem preta ou congelada no Premiere; rode build (ele refaz o trecho, #13488)`);
  }
  return issues;
}

/** #13488/#13500: quadros para o relato; null = ffprobe que não contou. */
function fmtTrechoFrames(n: number | null): string {
  return n === null ? "ilegível (ffprobe sem contagem)" : `${n} quadro(s)`;
}

/**
 * #13500: os quadros do arquivo batem? Com `min >= max`, é o `trechoFramesOk(max)`
 * (±1 quadro). Com `min < max` (trecho inserido que chega ao fim da fonte), de
 * `min` exato a `max` + `TRECHO_FRAME_TOL`: a folga para menos é só a de `min`
 * (`TRECHO_END_SHORT_TOL_S`), sem quadro extra. null = não.
 */
export function trechoFramesInRange(min: number, max: number, got: number | null): boolean {
  if (got === null || !Number.isFinite(got)) return false;
  return min >= max ? trechoFramesOk(max, got) : got >= min && got <= max + TRECHO_FRAME_TOL;
}

let ffprobeAvailableCache: boolean | null = null;
/**
 * #13500: o ffprobe roda nesta máquina? Conferido uma vez por processo
 * (`ffprobe -version`). Separa "ffprobe ausente" (não dá para contar nada) de
 * "ffprobe roda e não conta o arquivo" (arquivo ilegível, sem `moov`).
 */
export function ffprobeAvailable(): boolean {
  if (ffprobeAvailableCache === null) {
    try {
      ffprobeAvailableCache = spawnSync("ffprobe", ["-version"], { stdio: "ignore", windowsHide: true }).status === 0;
    } catch {
      ffprobeAvailableCache = false;
    }
  }
  return ffprobeAvailableCache;
}

const trechoPartsSwept = new Set<string>();
/**
 * #13500: apaga, uma vez por out dir e processo, os `{AAMMDD}_trecho_*.mov.part`
 * órfãos que o código antigo deixava no out dir (o Drive). Devolve quantos.
 */
export function sweepTrechoInseridoParts(outDir: string, edition: string): number {
  const key = `${resolve(outDir)}|${edition}`;
  if (trechoPartsSwept.has(key)) return 0;
  trechoPartsSwept.add(key);
  const prefix = trechoInseridoFileName(edition, "", "").replace(/-\.mov$/, "");
  let n = 0;
  let names: string[] = [];
  try {
    names = readdirSync(outDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".mov.part")) continue;
    try {
      rmSync(join(outDir, name), { force: true });
      n++;
    } catch { /* fica para o próximo build */ }
  }
  return n;
}

/** #13500: os quadros do render divergem do esperado (o resto do erro do corte é outro: ffmpeg, disco). */
export class TrechoFramesError extends Error {}

/**
 * #13488/#13500: o render de um arquivo cujo número de quadros é sabido
 * (trecho do XML leve, trecho inserido). `render` grava num `.part` da pasta
 * temporária `tmp` (FORA do out dir: o Drive for desktop subia o `.part` e não
 * propagava o rename); os quadros são conferidos ali, o arquivo é copiado para
 * `out` e conferido de novo na cópia. Divergência tenta mais uma vez e depois
 * lança `TrechoFramesError`, sem deixar `out` com o arquivo curto. `render`
 * que lança, lança o erro dele. Devolve os quadros da cópia.
 */
export function renderFramesConferidos(input: {
  out: string;
  expected: number;
  /** #13500: o mínimo aceito (padrão `expected`): o trecho inserido que vai até o fim da fonte pode sair uns quadros mais curto. */
  minExpected?: number;
  tmp: string;
  render: (part: string) => void;
  probeFrames: (path: string) => number | null;
  /** #13512: a sonda do `.part` temporário (padrão `probeFrames`); nunca a com cache, que guardaria um arquivo descartável. */
  probePart?: (path: string) => number | null;
  /** Começo das mensagens (`trecho X.mov`, `trecho inserido H5`). */
  label: string;
  /** O que promete os quadros (`o nome pede`, `o intervalo pede`). */
  pede: string;
  tag: string;
  log: (line: string) => void;
}): number {
  const part = join(input.tmp, `${basename(input.out)}.part`);
  const ok = (got: number | null) => trechoFramesInRange(input.minExpected ?? input.expected, input.expected, got);
  for (let attempt = 1; ; attempt++) {
    rmSync(part, { force: true });
    input.render(part);
    const gotPart = (input.probePart ?? input.probeFrames)(part);
    let bad = ok(gotPart) ? null : `o render saiu com ${fmtTrechoFrames(gotPart)}`;
    let gotOut: number | null = null;
    if (!bad) {
      copyFileSync(part, input.out);
      gotOut = input.probeFrames(input.out);
      if (!ok(gotOut)) {
        rmSync(input.out, { force: true });
        bad = `a cópia em ${input.out} ficou com ${fmtTrechoFrames(gotOut)}`;
      }
    }
    rmSync(part, { force: true });
    if (!bad) return gotOut!;
    if (attempt >= 2) throw new TrechoFramesError(`${input.label}: ${bad}, ${input.pede} ${input.expected} (2 tentativas, ${input.tag})`);
    input.log(`[aviso] ${input.label}: ${bad}, ${input.pede} ${input.expected}; refazendo (${input.tag})`);
  }
}

/**
 * #13219: os trechos do bruto que as sequências usam, em H.264 + PCM, na
 * subpasta `trechos/` do out dir (a pasta da edição). Arquivo já presente é
 * reaproveitado só se tiver os quadros que o nome promete (o nome leva o
 * arquivo e os quadros de início e fim); o que diverge é apagado e refeito,
 * com [aviso] (#13488: na 261118 quatro trechos truncados no Drive foram
 * reaproveitados pelo nome e o XML saiu com 27 s de preto). O render vai para
 * uma pasta temporária FORA do out dir (o Drive for desktop subia o `.part`
 * vazio e não propagava o rename, #13488) e é copiado para o nome final; os
 * quadros são conferidos no temporário e de novo na cópia. Divergência tenta
 * mais uma vez e depois lança (o build volta ao XML do bruto, com [aviso]).
 * NVENC que falha cai para libx264 uma vez, com [aviso]; libx264 que falha
 * lança. `encode`/`listEncoders`/`probeFrames`/`tmpRoot` são injetáveis para o teste.
 */
export function renderTrechos(input: {
  plans: readonly Pick<SequencePlan, "clips">[];
  source: SourceInfo;
  outDir: string;
  /** O caminho do bruto no XML (a pasta da edição, como o Premiere a vê): os trechos ficam em `trechos/` ao lado. */
  mediaPath: string;
  folgaS: number;
  encode?: (args: string[]) => void;
  listEncoders?: () => string;
  /** #13488: os quadros de vídeo do arquivo (null = ilegível); padrão `probeTrechoFrames`. */
  probeFrames?: (path: string) => number | null;
  /** #13512: o cache local da contagem de quadros (`trechoFramesCachePath(workDir)`); ausente = sem cache. */
  framesCachePath?: string | null;
  /** #13488: onde fica a pasta temporária do render (padrão `os.tmpdir()`), fora do out dir sincronizado. */
  tmpRoot?: string;
  /** #13493: os silêncios do `silences.json` (segundos, tempo global): os limites dos trechos ancoram neles; ausente = segundo inteiro. */
  silences?: readonly Interval[];
  log?: (line: string) => void;
}): { trechos: TrechoXml[]; encoder: TrechoEncoder; made: number; reused: number; redone: number } {
  const log = input.log ?? ((m: string) => console.error(m));
  // #13507: o decode do bruto pela GPU quando der (a queda para a CPU fica no runDecode; a do NVENC, abaixo).
  const encode = input.encode ?? ((args: string[]) => runDecode(args, "trecho do XML leve"));
  const files = sourceFiles(input.source);
  const uses = input.plans.flatMap((p) =>
    p.clips.map((c) => {
      const k = c.file ?? 0;
      const off = files[k]?.offsetFrames ?? 0;
      return { fileIndex: k, in: c.frameIn - off, out: c.frameOut - off };
    }),
  );
  const planned = planTrechos(uses, files.map((x) => ({ path: x.path, frames: x.frames })), input.source.fps, {
    folgaS: input.folgaS,
    ...(input.silences ? { silences: silencesPerFile(input.silences, files, input.source.fps) } : {}),
  });
  const dir = join(input.outDir, TRECHOS.dirName);
  mkdirSync(dir, { recursive: true });
  // #13512: arquivo intacto (mesmo tamanho e mtime) não é relido a cada rebuild; o cache fica no
  // work dir (local), nunca no out dir sincronizado. O `.part` do render é sempre sondado sem cache.
  const rawProbe = input.probeFrames ?? probeTrechoFrames;
  const probeFrames = input.framesCachePath ? cachedTrechoProbe(input.framesCachePath, rawProbe) : rawProbe;
  let encoder: TrechoEncoder = pickTrechoEncoder(input.listEncoders ? input.listEncoders() : run("ffmpeg", ["-hide_banner", "-encoders"]).stdout);
  const p = input.mediaPath.replace(/\\/g, "/");
  const xmlDir = `${p.slice(0, p.lastIndexOf("/") + 1)}${TRECHOS.dirName}/`;
  let made = 0;
  let reused = 0;
  let redone = 0;
  let tmp: string | null = null;
  try {
    const trechos = planned.map((t) => {
      const out = join(dir, t.name);
      const expected = t.end - t.start;
      if (existsSync(out)) {
        const got = probeFrames(out);
        if (trechoFramesOk(expected, got)) {
          reused++;
          return { ...t, xmlPath: `${xmlDir}${t.name}`, width: files[t.fileIndex].width, height: files[t.fileIndex].height };
        }
        // #13488: o nome promete os quadros, o arquivo no disco não os tem (encode interrompido, Drive que não gravou tudo).
        log(`[aviso] trecho ${t.name} no disco com ${fmtTrechoFrames(got)}, o nome pede ${expected}: apagado e refeito (#13488)`);
        rmSync(out, { force: true });
        redone++;
      }
      tmp ??= mkdtempSync(join(input.tmpRoot ?? tmpdir(), "diaria-trechos-"));
      // #13488: os quadros no render local e, depois da cópia, no nome final (a pasta do Drive).
      renderFramesConferidos({
        out,
        expected,
        tmp,
        probeFrames,
        probePart: rawProbe,
        label: `trecho ${t.name}`,
        pede: "o nome pede",
        tag: "#13488",
        log,
        render: (part) => {
          const args = (enc: TrechoEncoder) => trechoEncodeArgs({ src: files[t.fileIndex].path, out: part, start: t.start, end: t.end, fps: input.source.fps, encoder: enc });
          try {
            encode(args(encoder));
          } catch (e) {
            if (encoder !== "h264_nvenc") throw e;
            // #13282: o ffmpeg no Windows termina a linha com \r\n; split só por \n deixava o \r no aviso.
            log(`[aviso] h264_nvenc falhou em ${t.name} (${(e as Error).message.split(/\r?\n/)[0]}): os trechos seguem em libx264 (#13219)`);
            encoder = "libx264";
            encode(args(encoder));
          }
        },
      });
      made++;
      return { ...t, xmlPath: `${xmlDir}${t.name}`, width: files[t.fileIndex].width, height: files[t.fileIndex].height };
    });
    return { trechos, encoder, made, reused, redone };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** #13437 (PR 2): a fonte do trecho nesta máquina (ordem em `video-trecho-fonte.ts`). */
export function fonteDoTrecho(ctx: Pick<Ctx, "trechoFontes" | "trechoDriveRoot">, t: Pick<TrechoInseridoRoteiro, "id" | "trecho">): FonteTrecho {
  return resolverFonteTrecho({ id: t.id, trecho: t.trecho, fontes: ctx.trechoFontes ?? {}, editionsRootDir: editionsRootDir(), driveRoot: ctx.trechoDriveRoot ?? null });
}

/**
 * #13500: o quanto um trecho inserido pode passar do fim do vídeo de origem, e
 * sair mais curto que o intervalo, sem ser recusado: o stream de vídeo costuma
 * acabar antes do container (padding do AAC), e um `fim` = fim do vídeo rende
 * de 1 a 3 quadros a menos.
 */
export const TRECHO_END_SHORT_TOL_S = 0.1;

/**
 * #13500: o mínimo de quadros aceito no clipe do trecho inserido. O intervalo
 * inteiro, salvo quando o fim do trecho chega ao fim do vídeo de origem
 * (`durS`, a do stream de vídeo): aí até `TRECHO_END_SHORT_TOL_S` a menos.
 */
export function trechoInseridoMinFrames(frames: number, fimS: number, durS: number | null, fps: number): number {
  if (durS === null || fimS < durS - TRECHO_END_SHORT_TOL_S) return frames;
  return Math.max(1, frames - Math.ceil(TRECHO_END_SHORT_TOL_S * fps));
}

/** #13500: a saída do ffprobe de uma duração (`csv=p=0`) → segundos; vazia, `N/A` ou não positiva = null. */
export function parseProbeDurationS(stdout: string): number | null {
  const d = Number(stdout.trim().split(/\r?\n/)[0]?.replace(/,$/, ""));
  return Number.isFinite(d) && d > 0 ? d : null;
}

/**
 * #13500: a duração do vídeo de origem para conferir o fim do trecho: a do
 * stream de vídeo (`v:0`), que acaba antes do container quando o áudio tem
 * padding; sem ela, a do container (`format`). ffprobe falho = null.
 */
export function probeVideoDurationS(src: string, ffprobe: (args: string[]) => string = (args) => run("ffprobe", args).stdout): number | null {
  for (const args of [
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", src],
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
  ]) {
    try {
      const d = parseProbeDurationS(ffprobe(args));
      if (d !== null) return d;
    } catch { /* tenta o próximo */ }
  }
  return null;
}

/**
 * #13437 (PR 2): o clipe de um trecho inserido, cortado do export do vídeo de
 * origem no intervalo do roteiro, no tamanho e fps da sequência, no out dir
 * (`trechoInseridoFileName`; o hash muda com a fonte e o intervalo). Arquivo já
 * presente é reaproveitado só se tiver os quadros do intervalo; o que diverge é
 * apagado e cortado de novo, com [aviso] (#13500, a mesma disciplina do
 * `renderTrechos`, #13488: o hash não muda com um corte interrompido, e o
 * truncado era reaproveitado em todo rebuild). O corte vai para uma pasta
 * temporária FORA do out dir e é copiado (`renderFramesConferidos`), com os
 * quadros conferidos no temporário e na cópia. Arquivo que o ffprobe roda e não
 * conta (sem `moov`) é ilegível e também é cortado de novo; só com o ffprobe
 * INDISPONÍVEL nesta máquina (`ffprobeAvailable`) o corte existente é
 * reaproveitado sem conferir, com [aviso]. Os `.part` órfãos do código antigo
 * no out dir são varridos uma vez (`sweepTrechoInseridoParts`).
 * Trecho que chega ao fim do vídeo de origem (duração do stream de vídeo) pode
 * sair até `TRECHO_END_SHORT_TOL_S` mais curto: entra com os quadros reais em
 * `frames`, com [premissa]. Sem fonte, intervalo de menos de 1 quadro ou além
 * do fim do vídeo (mais que a folga), fonte ilegível, ffmpeg falho ou clipe
 * com outro número de quadros (2 tentativas; inclui o render que o ffprobe não
 * conta): `null` com `[aviso]` (o trecho fica só no marcador), nunca para o
 * build. ffprobe que falha na duração da fonte é `[aviso]`, sem recusar.
 * `probeDurationS`/`probeFrames`/`tmpRoot` são injetáveis para o teste.
 */
export function cutTrechoInserido(
  ctx: Ctx,
  t: TrechoInseridoRoteiro,
  at: number,
  spec: Pick<SequenceSpec, "width" | "height" | "name">,
  fps: number,
  mediaPath: string,
  deps: {
    encode?: (args: string[]) => void;
    probeDurationS?: (src: string) => number | null;
    listEncoders?: () => string;
    /** #13500: os quadros de vídeo do arquivo (null = ilegível); padrão `probeTrechoFrames`. */
    probeFrames?: (path: string) => number | null;
    /** #13500: onde fica a pasta temporária do corte (padrão `os.tmpdir()`), fora do out dir sincronizado. */
    tmpRoot?: string;
    /** #13500: o ffprobe roda nesta máquina? Padrão `ffprobeAvailable` (uma vez por processo). */
    ffprobeAvailable?: () => boolean;
  } = {},
): TrechoInseridoClip | null {
  const fonte = fonteDoTrecho(ctx, t);
  const where = `${spec.name}: trecho depois da fala ${t.id} (${rotuloTrecho(t.trecho)})`;
  if (!fonte.fonte) {
    const porque = fonte.explicitoAusente
      ? `o --trecho-fonte aponta um arquivo que não existe nesta máquina (${fonte.procurado.join("; ")}); a busca automática não roda com caminho explícito: corrigir o caminho`
      : `o export do vídeo de origem não foi achado (procurado: ${fonte.procurado.join("; ")})`;
    console.error(`[aviso] ${where} NÃO inserido: ${porque}; fica só o marcador "trecho ${t.id}" para inserir à mão, ou passe --trecho-fonte "${t.id}=caminho" (nunca baixar do YouTube) (#13437)`);
    return null;
  }
  if (fonte.premissa) console.error(`[premissa] ${where}: ${fonte.premissa} (#13437)`);
  const frames = trechoClipFrames(t.trecho.inicioS, t.trecho.fimS, fps);
  if (frames < 1) {
    console.error(`[aviso] ${where} NÃO inserido: o intervalo do roteiro (${t.trecho.inicioS.toFixed(2)} a ${t.trecho.fimS.toFixed(2)} s) não chega a 1 quadro a ${fps} fps; conferir o intervalo no roteiro (#13437)`);
    return null;
  }
  const probe = deps.probeDurationS ?? probeVideoDurationS;
  const dur = probe(fonte.fonte);
  if (dur === null) {
    console.error(`[aviso] ${where}: a duração de ${fonte.fonte} não foi medida (ffprobe falhou); o fim do trecho não foi conferido contra o fim do vídeo, e o clipe cortado é conferido depois do corte (#13437)`);
  } else if (t.trecho.fimS > dur + TRECHO_END_SHORT_TOL_S) {
    console.error(`[aviso] ${where} NÃO inserido: o fim do trecho (${t.trecho.fimS.toFixed(2)} s) passa do fim de ${fonte.fonte} (${dur.toFixed(2)} s); conferir o intervalo no roteiro, ou a fonte (#13437)`);
    return null;
  }
  let st: { size: number; mtimeMs: number };
  try {
    st = statSync(fonte.fonte);
  } catch (e) {
    console.error(`[aviso] ${where} NÃO inserido: ${fonte.fonte} não pôde ser lido (${(e as Error).message.split(/\r?\n/)[0]}); fica só o marcador (#13437)`);
    return null;
  }
  const hash = createHash("sha256").update(JSON.stringify({ src: toPosix(fonte.fonte), size: st.size, mtimeMs: st.mtimeMs, i: t.trecho.inicioS, f: t.trecho.fimS, fps, w: spec.width, h: spec.height })).digest("hex").slice(0, 12);
  const name = trechoInseridoFileName(ctx.edition, t.id, hash);
  const out = join(ctx.outDir, name);
  const clip: TrechoInseridoClip = {
    id: t.id,
    at,
    frames,
    path: out,
    xmlPath: capaInicioXmlPath(mediaPath, name),
    width: spec.width,
    height: spec.height,
    video: t.trecho.video,
    inicioS: t.trecho.inicioS,
    fimS: t.trecho.fimS,
    fonte: fonte.fonte,
  };
  const probeFrames = deps.probeFrames ?? probeTrechoFrames;
  // #13500: trecho que vai até o fim do vídeo de origem pode sair até TRECHO_END_SHORT_TOL_S mais curto
  // (o stream de vídeo acaba antes do container); aceito com os quadros reais, nunca recusado por isso.
  const minFrames = trechoInseridoMinFrames(frames, t.trecho.fimS, dur, fps);
  const usarQuadros = (got: number, onde: string) => {
    if (minFrames < frames && got < frames) {
      console.error(`[premissa] ${where}: ${onde} tem ${got} quadro(s), ${frames - got} a menos que o intervalo (a fonte acaba antes do fim do trecho, dentro de ${TRECHO_END_SHORT_TOL_S} s): o XML usa os ${got} (#13500)`);
      clip.frames = got;
    }
  };
  // #13500: os `.part` órfãos que o código antigo deixava no out dir (o Drive), uma vez por out dir.
  const orfaos = sweepTrechoInseridoParts(ctx.outDir, ctx.edition);
  if (orfaos) console.error(`[video-montagem] ${orfaos} .part órfão(s) de trecho inserido apagado(s) de ${ctx.outDir} (#13500)`);
  if (existsSync(out)) {
    const got = probeFrames(out);
    if (got === null && !(deps.ffprobeAvailable ?? ffprobeAvailable)()) {
      // #13500: sem ffprobe nesta máquina não dá para contar nada: o corte existente não é apagado por isso.
      console.error(`[aviso] ${where}: ffprobe indisponível, os quadros de ${name} não foram contados: reaproveitado sem conferir, com a contagem assumida pelo intervalo (${frames} quadros); conferir no 1º import (#13500)`);
      if (uploadsToDrive(ctx)) queueUploadIfMissing(f(ctx, DRIVE_UPLOADS_FILE), out);
      return clip;
    }
    if (got !== null && trechoFramesInRange(minFrames, frames, got)) {
      usarQuadros(got, `o ${name} reaproveitado`);
      if (uploadsToDrive(ctx)) queueUploadIfMissing(f(ctx, DRIVE_UPLOADS_FILE), out);
      return clip;
    }
    // #13500: o hash promete o intervalo, o arquivo no disco não tem os quadros (corte interrompido, Drive que não
    // gravou tudo); o ffprobe roda e não conta (sem `moov`) = ilegível, também cortado de novo.
    console.error(`[aviso] ${where}: ${name} no disco com ${fmtTrechoFrames(got)}, o intervalo pede ${frames}: apagado e cortado de novo (#13500)`);
    rmSync(out, { force: true });
  }
  // #13500: o código antigo cortava para `.part` dentro do out dir (o Drive); o órfão sai antes do corte.
  rmSync(`${out}.part`, { force: true });
  const encode = deps.encode ?? ((args: string[]) => { run("ffmpeg", args); });
  let tmp: string | null = null;
  try {
    let encoder: TrechoEncoder = "libx264";
    try {
      encoder = pickTrechoEncoder(deps.listEncoders ? deps.listEncoders() : run("ffmpeg", ["-hide_banner", "-encoders"]).stdout);
    } catch { /* sem a lista: libx264 */ }
    tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "diaria-trecho-inserido-"));
    // #13500: o clipe tem de ter os quadros do intervalo; menos = a fonte acabou antes, ou o arquivo ficou curto.
    const got = renderFramesConferidos({
      out,
      expected: frames,
      minExpected: minFrames,
      tmp,
      probeFrames,
      label: `trecho inserido ${t.id}`,
      pede: "o intervalo pede",
      tag: "#13500",
      log: (m) => console.error(m),
      render: (part) => {
        const args = (enc: TrechoEncoder) => trechoInseridoEncodeArgs({ src: fonte.fonte!, out: part, inicioS: t.trecho.inicioS, frames, fps, width: spec.width, height: spec.height, encoder: enc });
        try {
          encode(args(encoder));
        } catch (e) {
          if (encoder !== "h264_nvenc") throw e;
          console.error(`[aviso] h264_nvenc falhou no trecho ${t.id} (${(e as Error).message.split(/\r?\n/)[0]}): segue em libx264 (#13437)`);
          encoder = "libx264";
          encode(args(encoder));
        }
      },
    });
    usarQuadros(got, "o clipe cortado");
  } catch (e) {
    // #13500: a dica da fonte curta só quando o que falhou foi a contagem de quadros, não o ffmpeg.
    const dica = e instanceof TrechoFramesError ? "; a fonte acaba antes do fim do trecho?" : "";
    console.error(`[aviso] ${where} NÃO inserido: o corte de ${fonte.fonte} falhou (${(e as Error).message.split(/\r?\n/)[0]}${dica}); fica só o marcador (#13437)`);
    return null;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return clip;
}

/**
 * #13536: o ganho do Audio Levels do clipe de um trecho inserido, pelo loudness
 * medido nele (`audioGainFor`: -14 LUFS, teto de true peak), como o bruto
 * recebe o dele. Falha na medida = sem ganho, com o motivo.
 */
export function measureTrechoGain(path: string, measure: (p: string) => string = (p) => run("ffmpeg", ["-hide_banner", "-nostats", "-i", p, "-vn", "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"]).stderr): { gain: AudioGain | null; detail: string } {
  let m: ReturnType<typeof parseLoudnormJson>;
  try {
    m = parseLoudnormJson(measure(path));
  } catch (e) {
    return { gain: null, detail: `loudness do clipe não medido: ${(e as Error).message.split(/\r?\n/)[0]}` };
  }
  if (!m) return { gain: null, detail: "loudness do clipe ilegível (sem áudio, ou só silêncio)" };
  const g = audioGainFor(m);
  if (!g) return { gain: null, detail: `clipe a ${m.inputI.toFixed(1)} LUFS sem true peak medido: ganho positivo não aplicado` };
  return { gain: g, detail: `clipe a ${m.inputI.toFixed(1)} LUFS, alvo -14` };
}

/** #13493: o tamanho somado dos arquivos do bruto; algum que não dá `stat` = null (o limiar decide só pelo número de arquivos). */
export function brutoTotalBytes(paths: readonly string[], stat: (p: string) => { size: number } = statSync): number | null {
  let total = 0;
  for (const p of paths) {
    try {
      total += stat(p).size;
    } catch {
      return null;
    }
  }
  return total;
}

/**
 * #13219: o XML leve do build, ou `null` para o XML do bruto (`--xml-bruto`,
 * abaixo do limiar #13493, modo API, ou ffmpeg que falhou), sempre dito no relato.
 */
function buildTrechosOrNull(ctx: Ctx, picked: readonly SequencePlan[], source: SourceInfo, mediaPath: string, opt: TrechosBuildOption): TrechoXml[] | null {
  ctx.buildTrechos = undefined;
  // #13493: o limiar (bruto grande ou com muitos arquivos) decide, salvo --xml-leve/--xml-bruto.
  const files = sourceFiles(source);
  const decision = decideXmlLeve({ choice: opt.choice, totalBytes: brutoTotalBytes(files.map((x) => x.path)), files: files.length, limiar: xmlLeveLimiarFrom(readPlatformConfigSafe(), (m) => console.error(`[aviso] ${m}`)) });
  if (!decision.enabled) {
    if (opt.choice === "bruto") console.error(`[aviso] ${decision.reason}: o XML aponta o bruto inteiro; o Premiere converte o AAC de cada arquivo e lê o HEVC pelo Drive (#13219)`);
    else console.error(`[premissa] XML do bruto: ${decision.reason}; deixar a pasta da edição off-line no Mac antes de abrir; --xml-leve força os trechos (#13493)`);
    return null;
  }
  if (ctx.mode === "api") {
    console.error("[aviso] modo API do Drive: XML do bruto, sem trechos (a subpasta trechos/ não sobe pelo upload do out dir); para o XML leve, rode o build no Neo (#13219)");
    return null;
  }
  try {
    // #13493: os limites ancoram nos blocos de silêncio (um ajuste de borda não invalida o trecho); sem silences.json, segundo inteiro.
    const silPath = f(ctx, "silences.json");
    let sil: Interval[] | undefined;
    try {
      sil = existsSync(silPath) ? readJson<Interval[]>(silPath, "silences.json") : undefined;
    } catch (e) {
      console.error(`[aviso] silences.json ilegível (${(e as Error).message.split("\n")[0]}): limites dos trechos no segundo inteiro (#13493)`);
    }
    const r = renderTrechos({ plans: picked, source, outDir: ctx.outDir, mediaPath, folgaS: opt.folgaS, framesCachePath: trechoFramesCachePath(ctx.workDir), ...(sil ? { silences: sil } : {}) });
    const cov = trechosCoverage(r.trechos, files);
    console.error(
      `[premissa] XML leve (${decision.reason}): ${r.trechos.length} trecho(s) em ${join(ctx.outDir, TRECHOS.dirName)} (${(cov.frames / source.fps).toFixed(0)} s de ${(cov.totalFrames / source.fps).toFixed(0)} s do bruto; ${r.made} novo(s), ${r.reused} reaproveitado(s) com os quadros conferidos${r.redone ? `, ${r.redone} refeito(s) por estar(em) truncado(s) no disco, #13488` : ""}), ` +
        `H.264 no tamanho do bruto (${r.encoder}, qualidade ${TRECHOS.quality}, GOP ${TRECHOS.gop}, sem B-frames, ${source.fps} fps CFR, 8 bits) + PCM 48 kHz, folga de ${opt.folgaS} s, ` +
        `limites ${sil ? "no bloco de silêncio do silences.json (#13493)" : "no segundo inteiro (sem silences.json)"}, render fora do Drive e copiado pronto; ` +
        "--xml-bruto aponta o bruto; conferir no Premiere do Mac o playback e a cor (8 bits) (#13219)",
    );
    ctx.buildTrechos = r.trechos.map((t) => ({ name: t.name, size: statSync(join(ctx.outDir, TRECHOS.dirName, t.name)).size }));
    return r.trechos;
  } catch (e) {
    console.error(`[aviso] trechos do XML leve falharam (${(e as Error).message.split("\n")[0]}): XML do bruto, como com --xml-bruto (#13219)`);
    return null;
  }
}

/** #12571: sequência sem card e sem CTA falado (nenhum item de `cta_*` na ordem dela) sai sem CTA nenhum. */
export function sequenceHasSpokenCta(plan: Pick<SequencePlan, "clips">): boolean {
  return plan.clips.some((c) => (CTA_BLOCKS as readonly string[]).includes(c.block));
}

/** Título do D1 em `02-reviewed.md` da edição; ausente ou sem D1 = null. */
function readD1Title(edition: string): string | null {
  const path = join(editionDirFor(edition), "02-reviewed.md");
  if (!existsSync(path)) return null;
  return parseDestaques(readFileSync(path, "utf8")).find((d) => d.n === 1)?.title ?? null;
}

/** Relato da raiz dos `pathurl` do XML (#12707): Neo ou Mac, e o que ficou fora da tradução. */
export function premierePathsLine(map: PremierePathMap | undefined, unmapped: readonly string[]): string {
  if (!map) {
    return "[premissa] pathurl do XML com a raiz do Neo (I:): abre vinculado no Premiere do Windows; para o Mac, publishing.video.premiere_root no config ou --premiere-root /Users/…/diaria-studio-video (#12707)";
  }
  // A conferência do 1º import (#12707) já foi feita: os XMLs da 261112 (raiz do Mac) saíram do Premiere
  // do Mac com título, vinheta e card de CTA no export final (Editado/), então a linha não pede mais conferir.
  const base = `[premissa] pathurl do XML com a raiz ${map.to} no lugar de ${map.from} (bruto, áudio, título, vinheta e card de CTA), para o Premiere do Mac (#12707)`;
  return unmapped.length ? `${base}\n[aviso] fora de ${map.from}, com o caminho de origem no XML (devem chegar offline no Mac): ${unmapped.join(", ")} (#12707)` : base;
}

/** Relato do ganho de áudio do XML (#11755). */
export function audioGainLine(g: AudioGain | null, inputI?: number, inputTp?: number, measuredOn: "bruto" | "faixa tratada" = "bruto"): string {
  if (!g) return `[aviso] sem ganho de áudio no XML: loudness ${measuredOn === "bruto" ? "do bruto" : "da faixa tratada"} não medido (ou sem true peak para um ganho positivo); nível à mão no Premiere`;
  const why = g.limitedBy === "target" ? `alvo ${AUDIO_GAIN_TARGET_LUFS} LUFS` : g.limitedBy === "true-peak" ? `teto de ${AUDIO_GAIN_TP_CEILING_DBTP} dBTP` : "máximo do Audio Levels (+12 dB)";
  const from = inputI !== undefined ? ` (${measuredOn} ${inputI.toFixed(2)} LUFS, TP ${inputTp !== undefined && Number.isFinite(inputTp) ? inputTp.toFixed(2) : "?"} dBTP)` : "";
  return `[premissa] ganho de áudio no XML: ${g.db > 0 ? "+" : ""}${g.db.toFixed(2)} dB em cada clipe (Audio Levels, limitado pelo ${why})${from}; conferir no 1º import se o Premiere aplicou (#11755); --no-audio-gain tira`;
}

/** #12089: estado do filtro de respiração pela F0 no `build`. */
export interface SpeechVoiceFilter {
  /** `off` = `--no-speech-voice`; `sem-voz` = a F0 não achou voz bastante (sanity, `voicedMinFraction`). */
  status: "ligado" | "off" | "sem-voz";
  /** Fração dos quadros acima do limiar com voz; null sem a voz medida. */
  fraction: number | null;
}

/**
 * #12089: mede a voz (`measure`, null = `--no-speech-voice`) e liga o filtro
 * de respiração em `e.voiced` só se a fração dos quadros acima do limiar com
 * voz passar de `voicedMinFraction`; abaixo disso, a F0 não está vendo a fala e
 * o filtro tiraria fala junto com a respiração: fica desligado.
 */
export function applyVoiceFilter(e: FrameEnergy, th: Pick<SpeechThresholds, "fullDb" | "diffDb">, measure: (() => Uint8Array) | null): SpeechVoiceFilter {
  delete e.voiced;
  if (!measure) return { status: "off", fraction: null };
  e.voiced = measure();
  const fraction = voicedFractionAboveThreshold(e, th);
  if (fraction === null || fraction < SPEECH_DETECT.voicedMinFraction) {
    delete e.voiced;
    return { status: "sem-voz", fraction };
  }
  return { status: "ligado", fraction };
}

/** #12089: as linhas do detector de fala no `build`: a `[premissa]` dos limiares e os `[aviso]` das sanidades. */
export function speechThresholdsPremise(th: SpeechThresholds, voice: SpeechVoiceFilter): string[] {
  const src = { fixo: "fixo", relativo: "relativo ao bruto", manual: "--speech-*-db" } as const;
  const pct = (x: number | null) => (x === null ? "sem medida" : `${Math.round(x * 100)}%`);
  const lines = [
    `[premissa] detector de fala (#12089): fala acima de ${th.fullDb.toFixed(1)} dB no sinal cheio (${src[th.source.fullDb]}) ou ${th.diffDb.toFixed(1)} dB na 1ª diferença (${src[th.source.diffDb]}); limiar relativo: ${th.status}; ` +
      (voice.status === "ligado"
        ? `respiração e ruído sem F0 a mais de ${SPEECH_DETECT.voicedLeadS * 1000} ms antes / ${SPEECH_DETECT.voicedTailS * 1000} ms depois da voz (F0 acima de ${voiceAnchorDb(th.fullDb).toFixed(1)} dB) não contam como fala, ${pct(voice.fraction)} dos quadros acima do limiar com voz (--no-speech-voice desliga)`
        : voice.status === "off"
          ? "sem o filtro de respiração pela F0 (--no-speech-voice)"
          : `sem o filtro de respiração pela F0: só ${pct(voice.fraction)} dos quadros acima do limiar com voz`),
    ...th.warnings.map((w) => `[aviso] ${w}`),
  ];
  if (voice.status === "sem-voz") {
    lines.push(`[aviso] detector de fala (#12089): filtro de respiração pela F0 desligado, só ${pct(voice.fraction)} dos quadros acima do limiar têm voz (mínimo ${Math.round(SPEECH_DETECT.voicedMinFraction * 100)}%); respiração e ruído acima do limiar contam como fala, conferir as pausas no Premiere`);
  }
  return lines;
}

async function cmdBuild(ctx: Ctx, allowMissing: boolean, audioRefine = true, audioGain = true, titleMode: TitleMode = "png", seq?: string, speechDetect = true, audioClean = true, drive: DriveSession | null = null, speechOpts: SpeechDetectOptions = {}, denoise: AudioDenoiseChoice = { engine: "ffmpeg", attenDb: null, from: "default" }, trechosOpt: TrechosBuildOption = { choice: "auto", folgaS: TRECHOS.folgaS }): Promise<number> {
  // #12902: recusar antes do detector/refino, assets e XMLs: sem o plano
  // anterior legível, o merge de um build parcial descartaria as outras
  // sequências. Entradas mudadas não recusam mais (#12968): as outras ficam no
  // plano marcadas como defasadas (`mergeBuildPlan`).
  if (seq && existsSync(f(ctx, "plan.json"))) {
    try { readJson<PlanFile>(f(ctx, "plan.json"), "plan.json"); }
    catch { throw new Error("build --seq recusado: plan.json anterior ilegível; rode build sem --seq para reconstruir todas as sequências (#12902)"); }
  }
  // #13404: plan.json que só existe como cópia de conflito do sync é o plano anterior ilegível do #12902:
  // o build --seq gravaria um plano só com a sequência pedida, e as outras sumiriam.
  if (seq && !existsSync(f(ctx, "plan.json")) && conflictCopiesOf(f(ctx, "plan.json")).length) {
    throw new Error(`build --seq recusado: ${missingWorkFileMessage(f(ctx, "plan.json"), "plan.json anterior")}`);
  }
  // #12089: o corte de pausas pelo detector de fala (energia + banda alta), não pelo silencedetect.
  let speech: ReturnType<typeof speechDetection> = { cut: null, reason: "--no-speech-detect" };
  if (speechDetect) {
    try { speech = speechDetection(ctx, sourceFor(ctx, loadBlocks(ctx).file), speechOpts); }
    catch (e) { speech = { cut: null, reason: `detector de fala falhou: ${(e as Error).message}` }; }
  }
  if (speech.cut && speech.thresholds && speech.voice) for (const line of speechThresholdsPremise(speech.thresholds, speech.voice)) console.error(line);
  if (speech.cut) console.error(`[premissa] corte de pausas pelo detector de fala (#12089): ${speech.cut.islands.length} ilhas de fala, pausa de ${SPEECH_DETECT.minGapS} s ou mais sai com ${SPEECH_DETECT.padBeforeS * 1000} ms antes da fala e ${SPEECH_DETECT.padAfterS * 1000} ms depois; o começo da fala recua até ${SPEECH_DETECT.attackMaxS * 1000} ms no ataque acima do piso do bruto + ${SPEECH_DETECT.attackAboveFloorDb} dB (#12263); --no-speech-detect volta ao silences.json`);
  else console.error(`[aviso] corte de pausas pelo silences.json (${speech.reason}): respiração e ruído de sala contam como fala num bruto quente (#12089)`);
  const { file, source, plans: ps0, hash, resolved } = plans(ctx, speech.cut);
  printTakeRepeatWarnings(ctx, resolved);
  const refined = refineCuts(ctx, ps0, source, audioRefine, speech.cut !== null);
  refined.info.speechDetect = speech.cut ? { applied: true, islands: speech.cut.islands.length } : { applied: false, reason: speech.reason ?? "desligado" };
  // #13241: clipe de menos de 0,3 s não sai sozinho no XML (pulo de imagem): funde ao vizinho ou sai.
  const absorbed = absorbShortClipsOfPlans(refined.plans, nonEmptyWords(f(ctx, "transcript.json"), "transcript.json"), source.fps);
  const ps = absorbed.plans;
  for (const w of refined.warnings) console.error(`[aviso] ${w}`);
  for (const n of absorbed.notes) console.error(`[aviso] ${n}`);
  const { framing, assumed } = effectiveFraming(file);
  if (assumed) console.error("[premissa] blocks.json sem framing: usando o da 261027 (rosto em 48% da largura, olhos em 54% da altura)");
  let problems = 0;
  // #11935: --seq grava só o XML daquela sequência e só ela barra o build; #11969: e só ela muda no plan.json.
  const picked = pickPlans(ps, seq, false);
  // #12101: a vinheta do logo depois do título; sem o MOV nesta máquina, o build segue sem ela.
  // #13308: no modo local com raiz explícita, a vinheta mora em {raiz}/_marca/ (o caminho do config é o do Neo).
  const resolvedVinheta: (VinhetaAsset & { localPath?: string }) | null = ctx.mode === "local" && ctx.driveRoot !== undefined
    ? await loadVinhetaForLocalRoot(ctx.driveRoot, ctx.localDrive ?? null)
    : await loadVinhetaForDrive(drive);
  // #13240: o som a cada "." do logo, só com a vinheta (os instantes contam do início dela).
  // O motivo de o som CONFIGURADO não ter entrado vai para o plan.json (xmlAssets.{seq}.vinhetaSfx.ausente).
  let sfxAbsent: string | null = null;
  const sfxDeps: SfxLoadDeps = { onAbsent: (reason) => { sfxAbsent = reason; } };
  const resolvedSfx: (VinhetaSfx & { localPath?: string }) | null = !resolvedVinheta
    ? null
    : ctx.mode === "local" && ctx.driveRoot !== undefined
      ? await loadVinhetaSfxForLocalRoot(ctx.driveRoot, ctx.localDrive ?? null, sfxDeps)
      : await loadVinhetaSfxForDrive(drive, sfxDeps);
  if (!resolvedVinheta) {
    // Sem a vinheta não há onde ancorar o som: o editor insere os dois à mão.
    let cfgSfx: { atS: number[] } | null = null;
    try { cfgSfx = vinhetaSfxConfigFrom(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))); }
    catch { cfgSfx = null; /* config ilegível: o aviso da vinheta já disse */ }
    if (cfgSfx) {
      console.error(vinhetaSfxSemVinhetaAviso(cfgSfx.atS));
      sfxAbsent = "sem a vinheta do logo";
    }
  }
  const vinheta: VinhetaAsset | null = resolvedVinheta
    ? { ...(({ localPath, ...asset }) => asset)(resolvedVinheta), ...(resolvedSfx ? { sfx: (({ localPath, ...s }) => s)(resolvedSfx) } : {}) }
    : null;
  if (vinheta) {
    console.error(
      `[premissa] vinheta do logo ${vinheta.path} (${vinheta.durationS.toFixed(2)} s, ${vinheta.width}x${vinheta.height}${vinheta.fps ? `, ${vinheta.fps} fps` : ""}${vinhetaUsesMovAudio(vinheta) ? ", com som numa faixa de áudio própria" : vinheta.hasAudio ? ", com o som do MOV fora (o efeito de vinheta_som substitui, #13522)" : ", sem som"}) ` +
        `na faixa de vídeo do topo, ${VINHETA_AFTER_SPEECH_S} s depois da última palavra do título (sem título: aos 2 s), cabendo no quadro; conferir alpha e tamanho no 1º import (#12101)`,
    );
    if (vinheta.sfx) {
      console.error(
        `[premissa] som da vinheta ${vinheta.sfx.path} (${vinheta.sfx.durationS.toFixed(2)} s) numa faixa de áudio própria, em ${vinheta.sfx.atS.map((t) => `+${t.toFixed(3)} s`).join(" e ")} do início da vinheta (um por "." do logo, arredondado ao quadro), em toda sequência com vinheta; conferir no 1º import (#13240)`,
      );
    }
  }
  // #12566: no bruto em vários arquivos, caneca e rosto conferidos por arquivo (tamanho e framing de cada um).
  const framingWarn = framingWarningsByFile(picked, source, framing, file.files);
  if (source.files?.length) {
    if (picked.some((p) => p.clips.some((c) => clipGeometry({ source, spec: p.spec, framing, fileOverrides: file.files, clip: c }).fit === "blur-fill"))) {
      console.error("[premissa] blur-fill no XML = faixa V1 com o Gaussian Blur do FCP7 sob o clipe: conferir no 1º import que o Premiere traduz o efeito (senão, aplicar o desfoque à mão) (#12559)");
    }
  }
  // #11939: a caneca é esforço, nunca barra o build; o relato diz onde ela não sai inteira.
  for (const w of framingWarn.mug) console.error(`[aviso] ${w}`);
  // #12093: o rosto centrado nos dois zooms; escala pequena demais bate na borda do bruto.
  for (const w of framingWarn.face) console.error(`[aviso] ${w}`);
  // #13414: as verticais ancoram pela boca; boca fora do centro (clamp na borda) e boca estimada saem no relato.
  for (const w of framingWarn.mouth) console.error(`[aviso] ${w}`);
  for (const w of framingWarn.mouthAssumed) console.error(`[premissa] ${w}`);
  const targetOverride = verticalTargetOverrideWarning(file.verticalTargetS);
  if (targetOverride) console.error(`[aviso] ${targetOverride}`);
  // #13311: a duração do card vem do config (default 2 s).
  const ctaCardS = configCtaCardS();
  // #13240: instantes do som da vinheta colocados por sequência, e o motivo de não ter entrado em alguma.
  const sfxPlaced: Array<{ name: string; n: number }> = [];
  const sfxAbsentBySeq: Record<string, string> = {};
  for (const p of picked) {
    const d = p.durationFrames / source.fps;
    console.error(`== ${p.spec.name}: ${p.clips.length} clipes,${Math.floor(d / 60)}:${(d % 60).toFixed(1).padStart(4, "0")}${file.ctaCard === false ? "" : ` + card de CTA de ${ctaCardS} s (#12571, #13311)`}`);
    const g = ganchoWarning(p);
    if (g) console.error(`[aviso] ${g}`);
    // #12712: o corte sem gancho de publicação avisa já na montagem, com o mesmo erro do video-extra-verticals.ts.
    const hook = corteHookLine(file, p.spec);
    if (hook) console.error(`[${hook.level}] ${p.spec.name}: ${hook.text}`);
    for (const w of p.warnings ?? []) console.error(`[aviso] ${w}`);
    // #13239 item 3: o trecho do bruto que completou a pausa da vinheta, e por quê.
    for (const w of p.premises ?? []) console.error(`[premissa] ${w}`);
    // #12101: o refino dos cortes pode encolher o respiro depois do título; conferir no plano final.
    // #12586: o respiro vem depois do bloco de abertura (o título, ou o gancho falado sem título).
    const breathBlock = vinhetaBreathBlock(p.spec);
    const breath = breathBlock ? vinhetaBreathFor(p.spec)?.[breathBlock] : undefined;
    if (breath) {
      const before = titleBreathS(ps0.find((q) => sequenceKey(q.spec) === sequenceKey(p.spec)) ?? p, source.fps);
      const after = titleBreathS(p, source.fps);
      if (before !== null && after !== null && after < before - 0.05 && after < breath - 0.05) {
        console.error(`[aviso] ${p.spec.name}: o refino dos cortes encolheu o respiro depois do título de ${before.toFixed(2)} s para ${after.toFixed(2)} s (pedido: ${breath} s); a vinheta pode cobrir o começo da abertura (#12101)`);
      }
    }
    if (vinheta) {
      const vs = vinhetaSpan(p, source.fps, vinheta);
      console.error(vs ? `   vinheta do logo em ${(vs.start / source.fps).toFixed(2)}–${(vs.end / source.fps).toFixed(2)} s (${vs.afterTitle ? "depois do título" : "sem título: aos 2 s"})` : "   [aviso] sequência curta demais para a vinheta do logo (#12101)");
      if (vinheta.sfx) {
        // #13240: os instantes de fato colocados nesta sequência (a premissa sai uma vez, depois do laço).
        const at = vs ? vinhetaSfxFrames(vs, source.fps, vinheta.sfx, p.durationFrames) : [];
        sfxPlaced.push({ name: p.spec.name, n: at.length });
        if (at.length) console.error(`   som da vinheta nos quadros ${at.map((f) => `${f.start} (${(f.start / source.fps).toFixed(2)} s)`).join(" e ")} (#13240)`);
        const lost = vinhetaSfxPlacedAviso(at.length, vinheta.sfx.atS.length);
        if (lost) console.error(`   ${lost}`);
        if (!at.length) sfxAbsentBySeq[sequenceKey(p.spec)] = vs ? "nenhum instante do som cabe na sequência" : "sequência curta demais para a vinheta do logo";
      }
      const ds = vinhetaDuckSpan(p, source.fps, vinheta);
      if (ds) console.error(`   [premissa] áudio do bruto ${VINHETA_DUCK_DB} dB sob a vinheta em ${(ds.start / source.fps).toFixed(2)}–${(ds.end / source.fps).toFixed(2)} s (o respiro sem fala; clipe de áudio partido, só o 1º pedaço linkado ao vídeo) (#13240, PR #13246)`);
    }
    // #12101: a pausa longa depois do título no horizontal é o respiro da vinheta, de propósito.
    if (speech.cut) for (const w of speechJoinWarnings(p.clips, speech.cut.islands, source.fps, { longJoinOkAfter: breath && breathBlock ? [breathBlock] : [] })) console.error(`[aviso] ${p.spec.name}: ${w}`);
    // #12263: entrada com som nos 40 ms antes do corte (piso + 45% da faixa), o critério da conferência à mão da 261105.
    if (speech.cut?.energy) for (const w of entryCutSoundWarnings(p.clips, speech.cut.energy, source.fps)) console.error(`[aviso] ${p.spec.name}: ${w}`);
    if (p.missingBlocks.length) console.error(`   faltam no blocks.json: ${p.missingBlocks.join(", ")}`);
    for (const x of p.dropped) console.error(`   ${x}`);
    for (const a of p.cutAdjustments ?? []) console.error(adjustmentLine(a));
    problems += p.missingBlocks.length + p.dropped.length;
    // #12571: o limite de 3:00 do Shorts conta o card de CTA do fim.
    const over = shortsWarning(file.ctaCard === false ? p : { ...p, durationFrames: p.durationFrames + ctaCardFrames(source.fps, ctaCardS) }, source.fps);
    if (over) console.error(`[aviso] ${over}`);
    const target = verticalTargetCheck(p, resolved, source.fps, { targetS: file.verticalTargetS, silences: silences(ctx) });
    if (target) console.error(`[aviso] ${verticalTargetWarning(p.spec.name, target)}`);
  }
  const sfxPremissa = vinhetaSfxPremissa(sfxPlaced);
  if (sfxPremissa) console.error(sfxPremissa);
  if (problems && !allowMissing) {
    console.error(`[erro] ${problems} problema(s) acima: corrigir o blocks.json (outra tomada, intervalo maior) ou rodar com --allow-missing`);
    return 1;
  }
  // #11641: no XML vai o caminho do bruto no Neo, não o do cache local do modo API.
  const media = buildXmlMediaPath(ctx, source);
  const mediaPath = media.path;
  if (media.how === "api-guess") console.error(`[premissa] bruto lido de ${source.path} (fora do cache do Drive): o XML aponta ${mediaPath} no Neo; outro caminho: --xml-media-root (#11641)`);
  else if (mediaPath !== source.path) console.error(`[video-montagem] XML aponta o bruto em ${mediaPath} (lido de ${source.path}, #11641)`);
  // #12559: um caminho por arquivo do bruto em vários arquivos (mesma tradução do Neo).
  const mediaPaths = source.files?.length
    ? source.files.map((x) => xmlMediaPath(x.path, { edition: ctx.edition, drive: null, xmlMediaRoot: ctx.xmlMediaRoot, driveRoot: ctx.driveRoot, apiMode: false }).path)
    : undefined;
  if (source.files?.length) for (const w of fitWarnings(picked, source, file)) console.error(`[aviso] ${w}`);
  // #12102: faixa de áudio tratada (aproximação do Enhance do Adobe Podcast), só depois do gate de problemas; falha do ffmpeg = áudio cru, com aviso.
  const treatedRun = audioClean
    ? renderCleanAudio({ src: audioInputOf(ctx, source), outDir: ctx.outDir, stateDir: ctx.stateDir, edition: ctx.edition, mediaPath, thresholdDb: silenceThresholdDb(ctx), denoise })
    : null;
  const treated: TreatedAudio | null = treatedRun ? { path: treatedRun.path, xmlPath: treatedRun.xmlPath, filter: treatedRun.filter, engine: treatedRun.engine } : null;
  if (!audioClean) console.error("[aviso] --no-audio-clean: o áudio do XML e da prévia é o cru do bruto; aplicar o Enhance no Premiere (#12102)");
  if (treated?.engine === "deepfilternet") {
    console.error(
      `[premissa] áudio do XML e da prévia na faixa tratada ${treated.xmlPath} pelo DeepFilterNet (${treated.filter}; motor via ${denoise.from}), o vídeo segue no bruto; ` +
        `teto da atenuação ${denoise.attenDb === null ? "desligado" : `${denoise.attenDb} dB`}; conferir sibilantes e finais de palavra no 1º import (#13234, #13194)`,
    );
  } else if (treated) {
    console.error(
      `[premissa] áudio do XML e da prévia na faixa tratada ${treated.xmlPath} (${treated.filter}): aproximação do Enhance do Adobe Podcast (Background 0%, Speech 40%), o vídeo segue no bruto; ` +
        `o Enhance pode ir por cima no Premiere; redução de ruído de ${AUDIO_CLEAN.nrDb} dB igual em todo o áudio e gate suave (pausas no máximo ${-AUDIO_CLEAN.rangeDb} dB abaixo, ${AUDIO_CLEAN.attackMs}/${AUDIO_CLEAN.releaseMs} ms), sem zerar o ambiente; conferir uma pausa típica no 1º import e registrar ajuste em AUDIO_CLEAN (#12102, #12262)`,
    );
  }
  // #12102: reaproveitada, a faixa não muda no out dir e o snapshot não a sobe; entra nos pendentes se nunca subiu.
  if (treatedRun?.reused && uploadsToDrive(ctx) && queueUploadIfMissing(f(ctx, DRIVE_UPLOADS_FILE), treatedRun.path)) {
    console.error(`[video-montagem] faixa tratada reaproveitada ainda não está no Drive: entra no upload deste build (#12102)`);
  }
  // #11755: ganho do loudness; #12209: medido na faixa tratada quando é ela que o XML toca, senão o loudness.json do bruto.
  let gain: AudioGain | null = null;
  if (audioGain) {
    const loudPath = f(ctx, "loudness.json");
    const bruto = existsSync(loudPath) ? readJson<Loudness>(loudPath, "loudness.json") : null;
    let treatedLoud: { loudness: Loudness; error?: string } | null = null;
    if (treated) {
      try {
        treatedLoud = { loudness: measureTreatedLoudness({ path: treated.path, stateDir: ctx.stateDir }) };
      } catch (e) {
        treatedLoud = { loudness: null, error: (e as Error).message };
      }
    }
    const src = gainLoudnessSource({ treated: treatedLoud, bruto });
    if (src.warning) console.error(`[aviso] ${src.warning}`);
    gain = audioGainFor(src.loudness);
    console.error(audioGainLine(gain, src.loudness?.inputI, src.loudness?.inputTp, src.measuredOn));
  }
  // #11756: título na V2 das verticais.
  mkdirSync(ctx.outDir, { recursive: true });
  let screenTitle: ScreenTitleXml | null = null;
  const titled = titleMode === "off" ? null : firstTitledVertical(ps);
  if (titled) {
    const t = resolveScreenTitle({ blocksTitle: file.screenTitle, d1Title: readD1Title(ctx.edition) });
    if (t.text) {
      const { png, xmlPath } = await renderVersionedTitlePng({ outDir: ctx.outDir, mediaPath, edition: ctx.edition, text: t.text, width: titled.spec.width, height: titled.spec.height });
      screenTitle = screenTitleXmlFor(t.text, xmlPath);
      console.error(
        `[premissa] título na vertical (${t.how === "blocks" ? "screenTitle do blocks.json" : "título do D1; screenTitle no blocks.json sobrepõe"}): "${t.text}", ` +
          `PNG ${png} na V2 (padrão; pendente de conferência no 1º import com o PNG via XML, #12091)`,
      );
    } else if (t.how === "missing") console.error("[aviso] vertical sem título: sem screenTitle no blocks.json e sem D1 em 02-reviewed.md (#11756)");
  }
  // #11900: o corte (2ª vertical, outro roteiro) leva o título dele, nunca o da notícia.
  const screenTitleByCorte: Record<string, ScreenTitleXml | null> = {};
  if (titleMode !== "off") {
    for (const p of ps) {
      const corte = p.spec.corte;
      if (corte === undefined || !isVerticalSpec(p.spec)) continue;
      if (p.spec.screenTitle === undefined) {
        console.error(`[aviso] corte "${corte}" sem screenTitle na sequência: sai com o título da vertical da edição; informe "screenTitle" na sequência do corte (#11900)`);
        continue;
      }
      const t = resolveScreenTitle({ blocksTitle: p.spec.screenTitle });
      if (!t.text) {
        screenTitleByCorte[corte] = null;
        continue;
      }
      const { png, xmlPath } = await renderVersionedTitlePng({ outDir: ctx.outDir, mediaPath, edition: ctx.edition, corte, text: t.text, width: p.spec.width, height: p.spec.height });
      screenTitleByCorte[corte] = screenTitleXmlFor(t.text, xmlPath);
      console.error(
        `[premissa] título do corte "${corte}" (screenTitle da sequência): "${t.text}", ` +
          `PNG ${png} na V2 (padrão; pendente de conferência no 1º import com o PNG via XML)` +
          " (#11900, #12091)",
      );
    }
  }
  // #12571: o card de CTA no fim de todas as sequências (o CTA padrão); ffmpeg falho = sequência sem card, com aviso.
  const ctaCard: Record<string, CtaCardAsset> = {};
  if (file.ctaCard === false) console.error("[aviso] ctaCard: false no blocks.json: as sequências saem sem o card de CTA no fim (#12571)");
  else {
    for (const p of picked) {
      const share = p.spec.ctaShare ?? file.ctaShare;
      try {
        const { asset, reused } = await renderCtaCard({ outDir: ctx.outDir, workDir: ctx.workDir, mediaPath, edition: ctx.edition, width: p.spec.width, height: p.spec.height, fps: source.fps, share, durationS: ctaCardS });
        ctaCard[sequenceKey(p.spec)] = asset;
        // Reaproveitado, o card não muda no out dir e o snapshot não o sobe; entra nos pendentes se nunca subiu.
        if (reused && uploadsToDrive(ctx)) queueUploadIfMissing(f(ctx, DRIVE_UPLOADS_FILE), asset.path);
        console.error(
          `[premissa] card de CTA no fim de ${p.spec.name}: ${basename(asset.path)}${reused ? " (reaproveitado)" : ""}, ${ctaCardS} s na V1 depois do último clipe, fade-in de ${CTA_CARD.fadeInS} s do preto no próprio MP4, sem áudio; ` +
            `"${asset.share}"${share ? "" : " (default; ctaShare no blocks.json ou na sequência sobrepõe)"}; conferir no 1º import (#12571)`,
        );
      } catch (e) {
        console.error(`[aviso] card de CTA de ${p.spec.name} falhou (${(e as Error).message.split("\n")[0]}): XML sem o card; inserir à mão no Premiere (#12571)`);
      }
    }
  }
  for (const p of picked) {
    if (!ctaCard[sequenceKey(p.spec)] && !sequenceHasSpokenCta(p)) console.error(`[aviso] ${p.spec.name} sai sem CTA nenhum (sem card e sem cta_* falado) (#12571)`);
  }
  // #13123 (em teste): a capa nos primeiros quadros das verticais; falha = sequência sem a capa, com aviso.
  const capaInicio = await renderCapaInicioAssets(ctx, file, picked, source.fps, mediaPath);
  // #13164: o tempo no corte final planejado, nunca o tempo no bruto.
  const horizontalShare = picked.find((p) => sequenceKey(p.spec) === "youtube");
  if (horizontalShare) {
    // Tempo é sugestão: sem casamento único fica `seconds: null` com aviso, nunca para o build (review #13170).
    const avisa = (m: string) => console.error(`[aviso] ${m}`);
    const cue = readShareCue(editionDirFor(ctx.edition), avisa);
    writeJson(f(ctx, SHARE_FILE), cue ? { ...cue, seconds: shareTimeInPlan(cue, horizontalShare, resolved, source.fps, avisa), requiresFinalCheck: true } : null);
  }
  // #13140: o texto de tela de cada fala do roteiro vira marcador da sequência, no tempo da fala.
  // #13186: só no horizontal; os verticais saem sem texto de tela (regra do #13180),
  // exceto a fala que cita a tela (#13333): ali o box vai abaixo da legenda.
  // #13544: fala do roteiro sem tomada (gravada noutro arquivo, ou cortada) e vídeo solto fora do bruto: aviso, nunca para o build.
  warnFalasSemTomada(ctx, source, resolved);
  const telas = readRoteiroTelas(editionDirFor(ctx.edition), (m) => console.error(`[aviso] ${m}`));
  const telaMarkers: Record<string, TelaMarker[]> = {};
  const telaOverlays: Record<string, TelaOverlay[]> = {};
  for (const p of picked) {
    const horizontal = isYoutubeSpec(p.spec);
    if (!horizontal && !isVerticalSpec(p.spec)) continue;
    // #13239 item 1: um box por vez na faixa (o marcador de uma fala não invade o da seguinte).
    const clamped = clampTelaOverlaps(telaMarkersFor(p, resolved, source.fps, telas));
    for (const w of clamped.warnings) console.error(`[aviso] ${p.spec.name}: ${w}`);
    const ms = clamped.items;
    if (ms.length) telaMarkers[sequenceKey(p.spec)] = ms;
    // #13333: no vertical o box começa abaixo da legenda (a do XML e a da prévia usam o mesmo estilo).
    const placement = horizontal ? {} : { topY: subtitleBottomY(p.spec.width, p.spec.height, parseAssStyle(PREVIEW_SUBTITLE_STYLE)) };
    // #13309: fala do horizontal com tela e sem marcador é box sumido (aviso); a de outro vídeo fica na premissa.
    const { semCasamento, foraDaVersao: fora } = horizontal ? telaSemMarcador(telas, ms) : { semCasamento: [] as string[], foraDaVersao: [] as string[] };
    if (semCasamento.length) {
      console.error(
        `[aviso] ${p.spec.name}: ${semCasamento.length} texto(s) de tela de fala do horizontal sem item casado (${semCasamento.join(", ")}): o box sai fora do XML; ` +
          `pôr "falaId"/"fala" com o id no item do blocks.json, ou conferir se o corte tirou a fala (#13309)`,
      );
    }
    if (ms.length) {
      const overlays: TelaOverlay[] = [];
      for (const m of ms) {
        try {
          // #13363: o box recebe o texto com o `**` do título (o marcador segue sem ele, #13180).
          const svg = telaBoxSvgForMarker(m, p.spec.width, p.spec.height, placement);
          const name = telaFileName(ctx.edition, m.id, createHash("sha256").update(svg).digest("hex").slice(0, 12));
          const out = join(ctx.outDir, name);
          // Regravado sempre, como capa e título: no modo API o snapshot do out dir é o que sobe (#13204).
          await sharp(Buffer.from(svg)).png().toFile(`${out}.part`);
          renameSync(`${out}.part`, out);
          overlays.push({ id: m.id, tela: m.tela, path: out, xmlPath: capaInicioXmlPath(mediaPath, name), width: p.spec.width, height: p.spec.height, in: m.in, out: m.out });
        } catch (e) {
          console.error(`[aviso] ${p.spec.name}: box de tela ${m.id} falhou (${(e as Error).message.split("\n")[0]}): fica só o marcador (#13204)`);
        }
      }
      if (overlays.length) {
        telaOverlays[sequenceKey(p.spec)] = overlays;
        console.error(`[premissa] ${p.spec.name}: ${overlays.length} box(es) de tela (PNG) numa faixa acima do bruto, no tempo da fala (${overlays.map((o) => `${o.id} ${(o.in / source.fps).toFixed(1)}–${(o.out / source.fps).toFixed(1)} s`).join(", ")}); conferir no 1º import (#13204)${horizontal ? "" : "; no vertical, só fala que cita a tela, com o box abaixo da legenda (#13333)"}`);
      }
    }
    if (ms.length && !horizontal) console.error(`[premissa] ${p.spec.name}: ${ms.length} fala(s) que citam a tela levam o texto de tela também neste vertical (${ms.map((m) => m.id).join(", ")}), exceção à regra dos verticais sem tela (#13333)`);
    else if (ms.length) console.error(`[premissa] ${p.spec.name}: ${ms.length} texto(s) de tela do roteiro como marcador da sequência no tempo da fala (${ms.map((m) => m.id).join(", ")}); a faixa de texto é do editor no Premiere (#13140); os verticais saem sem texto de tela (#13186), exceto a fala que cita a tela (#13333)${fora.length ? `; fora desta versão: ${fora.join(", ")}` : ""}`);
  }
  // #13437: trecho de outro vídeo (formato react) vira marcador no fim da fala, no horizontal; com a fonte
  // achada (o export do vídeo de origem, nunca o YouTube), o clipe cortado entra numa faixa própria (PR 2).
  const trechosInseridos = readTrechosInseridos(editionDirFor(ctx.edition), (m) => console.error(`[aviso] ${m}`));
  const trechoMarkers: Record<string, TrechoInseridoMarker[]> = {};
  const trechoClips: Record<string, TrechoInseridoClip[]> = {};
  if (trechosInseridos.length && picked.some((p) => isYoutubeSpec(p.spec))) {
    for (const a of avisosTrechosNaMontagem(trechosInseridos, editionsRootDir())) console.error(`[aviso] ${a}`);
  }
  for (const p of picked) {
    if (!trechosInseridos.length || !isYoutubeSpec(p.spec)) continue;
    const pos = trechoInseridoAtFrames(p, resolved, source.fps, trechosInseridos);
    const ms: TrechoInseridoMarker[] = [];
    const clips: TrechoInseridoClip[] = [];
    for (const t of trechosInseridos) {
      const at = pos.get(t.id);
      if (at === undefined) {
        console.error(`[aviso] ${p.spec.name}: trecho inserido depois da fala ${t.id} sem item casado no blocks.json (pôr "fala": "${t.id}" no item): fora do XML (#13437)`);
        continue;
      }
      const m: TrechoInseridoMarker = { id: t.id, trecho: t.trecho, at };
      ms.push(m);
      const clip = cutTrechoInserido(ctx, t, m.at, p.spec, source.fps, mediaPath);
      // #13536: o ganho do trecho, medido no clipe cortado (o do bruto não vale para outro vídeo).
      if (clip && audioGain) {
        const g = measureTrechoGain(clip.path);
        if (g.gain) clip.gain = g.gain;
        console.error(g.gain ? `[premissa] ${p.spec.name}: trecho ${t.id} com ${g.gain.db > 0 ? "+" : ""}${g.gain.db.toFixed(2)} dB (Audio Levels, ${g.detail}) (#13536)` : `[aviso] ${p.spec.name}: trecho ${t.id} sem ganho no XML (${g.detail}): conferir o nível no Premiere (#13536)`);
      }
      if (clip) clips.push(clip);
      const line = trechoInseridoLine(m, source.fps, clip);
      console.error(`[${line.level}] ${p.spec.name}: ${line.text}`);
    }
    if (ms.length) trechoMarkers[sequenceKey(p.spec)] = ms;
    if (clips.length) {
      trechoClips[sequenceKey(p.spec)] = clips;
      const total = trechoRipple(clips).total;
      console.error(`[premissa] ${p.spec.name}: ${clips.length} trecho(s) inserido(s) no XML, ${(total / source.fps).toFixed(1)} s a mais na sequência (${((p.durationFrames + total) / source.fps).toFixed(1)} s no XML, ${(p.durationFrames / source.fps).toFixed(1)} s no plano e na prévia, que saem sem o trecho) (#13437)`);
    }
  }
  // #12707: todo `pathurl` com a mesma raiz; o que ficar fora dela sai com o caminho do Neo, e isso é dito.
  const xmlFilePaths = [
    ...(mediaPaths ?? [mediaPath]),
    ...(treated ? [treated.xmlPath] : []),
    ...(screenTitle ? [screenTitle.pngPath] : []),
    ...Object.values(screenTitleByCorte).flatMap((t) => (t ? [t.pngPath] : [])),
    ...(vinheta ? [vinheta.path] : []),
    ...(vinheta?.sfx ? [vinheta.sfx.path] : []),
    ...Object.values(ctaCard).map((c) => c.xmlPath),
    ...Object.values(capaInicio).map((c) => c.xmlPath),
    // #13334: os boxes de tela também são pathurl do XML (faltaram no Drive na 261117).
    ...Object.values(telaOverlays).flatMap((os) => os.map((o) => o.xmlPath)),
    // #13437: os clipes dos trechos inseridos.
    ...Object.values(trechoClips).flatMap((cs) => cs.map((c) => c.xmlPath)),
  ];
  // #13219: XML leve (trechos em H.264 + PCM) antes da versão, que muda com ele.
  const trechos = buildTrechosOrNull(ctx, picked, source, mediaPath, trechosOpt);
  if (trechos) {
    xmlFilePaths.push(...trechos.map((t) => t.xmlPath));
    // #13334: trecho reaproveitado não muda no out dir e o snapshot não o sobe; entra nos pendentes se nunca subiu.
    if (uploadsToDrive(ctx)) {
      const reg = f(ctx, DRIVE_UPLOADS_FILE);
      const queued = trechos.filter((t) => queueUploadIfMissing(reg, join(ctx.outDir, TRECHOS.dirName, t.name), `${TRECHOS.dirName}/${t.name}`)).length;
      if (queued) console.error(`[video-montagem] ${queued} trecho(s) reaproveitado(s) ainda não estão no Drive: entram no upload deste build (#13334)`);
    }
  }
  ctx.buildXmlFiles = xmlFilePaths;
  console.error(premierePathsLine(ctx.premierePaths, unmappedPremierePaths(xmlFilePaths, ctx.premierePaths)));
  // #12111: cada build com plano novo abre a próxima versão (_V{n} no nome e no <sequence id>).
  // #12160: a versão também muda com as opções do build e com o plano final (detector de fala, refino).
  // #12163: e com o título, o caminho do bruto e o ganho calculado — por isso só aqui, depois de resolvê-los.
  const versionHashes = versionPickedSequences(ctx, picked, hash, {
    speechDetect: speech.cut !== null,
    audioRefine,
    audioGain,
    titleMode,
    vinheta,
    audioClean: treated?.filter ?? null,
    mediaPath,
    gainDb: gain?.db ?? null,
    screenTitle,
    screenTitleByCorte,
    ctaCard,
    premierePaths: ctx.premierePaths ?? null,
    capaInicio,
    telaMarkers,
    trechosFolgaS: trechos ? trechosOpt.folgaS : null,
    telaOverlays,
    trechoMarkers,
    trechoClips,
  });
  // Um XML por sequência: cada um leva a definição completa do <file> (buildXmeml define na 1ª ocorrência).
  const xmlPaths: string[] = [];
  const xmlIds: Record<string, string> = {};
  const prevXmlIds: Record<string, string> = {};
  for (const p of picked) {
    const xmlPath = join(ctx.outDir, xmlFileName(p.spec.name));
    const version = sequenceNameVersion(p.spec.name);
    const sequenceIds = version !== null ? { [sequenceKey(p.spec)]: versionedSequenceId(sequenceKey(p.spec), version, versionHashes.get(p) ?? hash) } : undefined;
    if (sequenceIds) xmlIds[sequenceKey(p.spec)] = sequenceIds[sequenceKey(p.spec)];
    // #12285: o id do XML que este build vai sobrescrever (transição de plano sem xmlVersions)
    if (existsSync(xmlPath)) {
      try {
        const prevId = parseVersionedSequenceId(readFileSync(xmlPath, "utf8"));
        if (prevId) prevXmlIds[sequenceKey(p.spec)] = prevId;
      } catch (e) {
        console.error(`[aviso] XML anterior ilegível (${basename(xmlPath)}: ${(e as Error).message}): a versão dele conta como nova (#12285)`);
      }
    }
    writeFileAtomic(xmlPath, buildXmeml([p], source, framing, { mediaPath, mediaPaths, fileOverrides: file.files, audioGain: gain, screenTitle, screenTitleByCorte, sequenceIds, vinheta, audioPath: treated?.xmlPath ?? null, ctaCard, premierePaths: ctx.premierePaths ?? null, capaInicio, telaMarkers, telaOverlays, trechoMarkers, trechoClips, trechos }));
    xmlPaths.push(xmlPath);
    console.error(`[video-montagem] versão vigente de ${sequenceKey(p.spec)}: ${p.spec.name} (${basename(xmlPath)}, id ${sequenceIds?.[sequenceKey(p.spec)] ?? "sem versão"}; #12111)`);
  }
  // #11969: com --seq, só as sequências reconstruídas (e conferidas acima) mudam no plan.json.
  const planPath = f(ctx, "plan.json");
  let prevPlan: PlanFile | null = null;
  warnConflictOnly(planPath);
  // #12285: sem --seq o plano anterior também é lido, só para a versão do XML de cada sequência (o `since` de um rebuild com o mesmo id).
  if (existsSync(planPath)) {
    try { prevPlan = readJson<PlanFile>(planPath, "plan.json"); } catch (e) { console.error(`[aviso] plan.json anterior ilegível (${(e as Error).message}): ${seq ? "só a sequência do --seq entra no plano novo" : "a versão de cada XML conta como nova"}`); }
  }
  const merged = mergeBuildPlan({
    next: { edition: ctx.edition, hash, source, framing, framingAssumed: assumed, ...(file.files ? { fileOverrides: file.files } : {}), plans: ps, cutRefine: refined.info, xmlAssets: Object.fromEntries(picked.map((p) => [sequenceKey(p.spec), { ...(treated ? { treatedAudio: treated } : {}), ...(vinheta ? { vinheta } : {}), ...(vinhetaSfxAbsentFor(sfxAbsent, sfxAbsentBySeq, sequenceKey(p.spec))), ...(ctaCard[sequenceKey(p.spec)] ? { ctaCard: ctaCard[sequenceKey(p.spec)] } : {}), ...(capaInicio[sequenceKey(p.spec)] ? { capaInicio: capaInicio[sequenceKey(p.spec)] } : {}), ...(telaOverlays[sequenceKey(p.spec)] ? { telaOverlays: telaOverlays[sequenceKey(p.spec)] } : {}), ...(trechoClips[sequenceKey(p.spec)] ? { trechosInseridos: trechoClips[sequenceKey(p.spec)] } : {}) }])) },
    pickedKeys: new Set(picked.map((p) => sequenceKey(p.spec))),
    prev: prevPlan,
    now: Date.now(),
    xmlIds,
    prevXmlIds,
  });
  if (merged.dropped.length) console.error(`[aviso] --seq ${seq}: ${merged.dropped.join(", ")} fora do plan.json (o plano anterior não as tinha, sem XML deste build); rode build sem --seq, ou build --seq de cada uma, antes de srt/preview delas (#11969)`);
  if (merged.stale.length) console.error(`[aviso] --seq ${seq}: ${merged.stale.join(", ")} mantida(s) no plan.json como DEFASADA(S): as entradas mudaram desde o build delas, o XML (e a versão) é o anterior e não foi tocado; srt/preview/review/verify-xml as deixam de fora até build --seq de cada uma, ou build sem --seq (#12968)`);
  if (merged.kept.length) console.error(`[video-montagem] --seq ${seq}: ${merged.kept.join(", ")} mantida(s) no plan.json como o build anterior gravou (#11969)`);
  writeJson(planPath, merged.plan);
  if (source.files?.length) {
    const flip = source.files.filter((x) => x.mirrored);
    if (flip.length) console.error(`[premissa] espelhados: ${flip.map((x) => x.id).join(", ")}: aplicar Horizontal Flip nos clipes DESSES arquivos no Premiere (o Premiere ignora o Flop do XML, #11358, #12559)`);
  } else if (source.mirrored) console.error("[premissa] bruto espelhado: aplicar Horizontal Flip nos clipes no Premiere (o Premiere ignora o Flop do XML, #11358)");
  for (const x of xmlPaths) console.log(x);
  return 0;
}

function seqWords(ctx: Ctx, plan: SequencePlan, source: SourceInfo, fromRaw: boolean): Word[] {
  if (fromRaw) {
    const words = mapWordsToSequence(trimWordsToSilences(nonEmptyWords(f(ctx, "transcript.json"), "transcript.json"), silences(ctx)), plan.clips, source.fps);
    if (words.length === 0) throw new Error(`nenhuma palavra do bruto dentro dos clipes de ${plan.spec.name}`);
    return words;
  }
  const audio = join(ctx.workDir, "audio.wav");
  if (!existsSync(audio)) throw new Error(`áudio do bruto ausente (${audio}): rode transcribe de novo nesta máquina, ou use --from-raw`);
  const ranges = sequenceSourceRanges(plan, source.fps);
  const wav = join(ctx.workDir, `seq-${sequenceKey(plan.spec)}.wav`);
  const out = f(ctx, `seq-${sequenceKey(plan.spec)}.transcript.json`);
  // A transcrição em cache vale só para os MESMOS trechos do MESMO áudio:
  // um build novo (loop da autorrevisão) ou um transcribe refeito a invalidam.
  const st = statSync(audio);
  const keyPath = f(ctx, `seq-${sequenceKey(plan.spec)}.cache-key.json`);
  const key = JSON.stringify({ ranges, audio: { path: audio, size: st.size, mtimeMs: st.mtimeMs }, durationS: source.durationS });
  const fresh = existsSync(keyPath) && readFileSync(keyPath, "utf8").trim() === key;
  if (!existsSync(out) || !fresh || ctx.force) {
    const graph =
      ranges.map((r, i) => `[0:a]atrim=start=${r.start.toFixed(3)}:end=${r.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`).join(";") +
      ";" + ranges.map((_, i) => `[a${i}]`).join("") + `concat=n=${ranges.length}:v=0:a=1[out]`;
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", audio, "-filter_complex", graph, "-map", "[out]", wav]);
    transcribeWithPython(ctx, wav, out, { vad: false });
    writeFileAtomic(keyPath, key + "\n");
  }
  return nonEmptyWords(out, `transcrição da sequência ${plan.spec.name}`);
}

/**
 * A cópia do SRT do horizontal na pasta da edição (`diaria-comentada-{AAMMDD}.srt`,
 * #11957) é a que o `publish-youtube.ts --upload` envia, e a `/diaria-publica-video`
 * corrige à mão ali mesmo. Rodar `srt` de novo só a sobrescreve se ela é a que o
 * `srt` gravou da última vez (o hash em `youtube-srt.json`), ou com `--force`.
 * #12078: a cópia que o `srt --from-final` gravou (registro com `fromExport`)
 * está no tempo do export, o que vai ao ar; um `srt` da montagem (sem origem)
 * não a troca pela do tempo da sequência montada, salvo `--force`.
 * #12209: salvo quando o horizontal foi reconstruído depois do export
 * (`sequenceBuiltAtMs` > `recordedExportAtMs`): o export daquela legenda saiu
 * de um XML anterior, e a cópia é trocada pela da montagem nova
 * ("replace-stale-export", que grava). O certo é rodar `--from-final` no novo export.
 * #12285: "reconstruído" = o XML mudou, não "o build rodou". Com o `<sequence id>`
 * gravado nos dois lados (o do `--from-final` em `youtube-srt.json` e o atual
 * do plan.json), a decisão é pelo id: mesmo id = mesmo XML, a legenda do
 * export fica. Sem um dos dois (registro ou plano anteriores ao #12285), o
 * instante, que deve ser o `since` da versão (`sequenceXmlVersion`), não o
 * `builtAt`, que avança até em rebuild sem mudança.
 */
export function youtubeSrtCopyDecision(input: {
  existing: string | null;
  recordedSha256: string | null;
  force: boolean;
  recordedFromExport?: boolean;
  fromExport?: boolean;
  /** #12209: instante do export que gerou a cópia (mtime do arquivo, ou o `modifiedTime` do Drive). */
  recordedExportAtMs?: number | null;
  /** #12209/#12285: desde quando vale o XML atual do horizontal (o `since` da versão; sem ele, o `builtAt`). */
  sequenceBuiltAtMs?: number;
  /** #12285: `<sequence id>` do horizontal quando o `--from-final` gravou a cópia. */
  recordedSequenceId?: string | null;
  /** #12285: `<sequence id>` do horizontal no plan.json atual. */
  sequenceId?: string | null;
}): "write" | "keep-edited" | "keep-from-export" | "replace-stale-export" {
  if (input.existing === null || input.force) return "write";
  const sha = createHash("sha256").update(input.existing).digest("hex");
  if (sha !== input.recordedSha256) return "keep-edited";
  if (!input.recordedFromExport || input.fromExport) return "write";
  if (input.recordedSequenceId && input.sequenceId) return input.recordedSequenceId === input.sequenceId ? "keep-from-export" : "replace-stale-export";
  const exportAt = input.recordedExportAtMs;
  if (input.sequenceBuiltAtMs !== undefined && typeof exportAt === "number" && Number.isFinite(exportAt) && input.sequenceBuiltAtMs > exportAt) return "replace-stale-export";
  return "keep-from-export";
}

/** Identidade do export que gerou a legenda (#12209), gravada em `youtube-srt.json`. */
export interface ExportOrigin {
  name: string;
  size?: number;
  /** mtime local; no modo API é o do download. */
  mtimeMs?: number;
  /** `modifiedTime` do Drive (sidecar do cache, modo API): o instante real do export. */
  driveModifiedTime?: string | null;
}

interface YoutubeSrtRecord {
  sha256?: string;
  writtenAt?: string;
  fromExport?: string;
  fromExportFile?: { size?: number; mtimeMs?: number; driveModifiedTime?: string | null };
  /** #12285: `<sequence id>` do horizontal no plan.json quando o `--from-final` gravou a cópia. */
  fromExportSequenceId?: string;
  /** #12429: a cópia saiu do `--from-final --no-plan` (texto ouvido, sem roteiro): não revisada. */
  origin?: "no-plan";
}

/**
 * #12209: quando o export da cópia foi feito. Prefere o `modifiedTime` do Drive
 * (o mtime local no modo API é o do download), depois o mtime; registro
 * anterior a este campo cai no `writtenAt` (o export é mais velho que o
 * `--from-final` que o leu, então "build depois do writtenAt" já é defasado).
 */
export function recordedExportAt(record: YoutubeSrtRecord | null): number | null {
  if (!record?.fromExport) return null;
  const drive = record.fromExportFile?.driveModifiedTime ? Date.parse(record.fromExportFile.driveModifiedTime) : NaN;
  if (Number.isFinite(drive)) return drive;
  const m = record.fromExportFile?.mtimeMs;
  if (typeof m === "number" && Number.isFinite(m)) return m;
  const w = record.writtenAt ? Date.parse(record.writtenAt) : NaN;
  return Number.isFinite(w) ? w : null;
}

/**
 * #12078: aplica a decisão acima nos caminhos dados (a cópia na pasta da edição
 * e o registro `youtube-srt.json`); grava no "write" e no "replace-stale-export".
 * `origin` = o export, quando a legenda veio do `--from-final` (string = só o nome).
 */
export function applyYoutubeSrtCopy(input: {
  path: string;
  recordPath: string;
  srt: string;
  force: boolean;
  origin?: string | ExportOrigin;
  sequenceBuiltAtMs?: number;
  /** #12285: `<sequence id>` atual do horizontal (gravado no registro quando a cópia vem do export). */
  sequenceId?: string | null;
  /**
   * #12429: a legenda veio do `--from-final --no-plan`. Grava `origin: "no-plan"` no registro e a
   * marca `youtubeCaptionNoPlanMarkerPath` ao lado da cópia; sem ele, a marca de uma cópia anterior sai.
   */
  noPlan?: boolean;
  now?: Date;
}): ReturnType<typeof youtubeSrtCopyDecision> {
  const record = existsSync(input.recordPath) ? readJson<YoutubeSrtRecord>(input.recordPath, "youtube-srt.json") : null;
  const origin: ExportOrigin | undefined = typeof input.origin === "string" ? { name: input.origin } : input.origin;
  const decision = youtubeSrtCopyDecision({
    existing: existsSync(input.path) ? readFileSync(input.path, "utf8") : null,
    recordedSha256: record?.sha256 ?? null,
    force: input.force,
    recordedFromExport: Boolean(record?.fromExport),
    fromExport: Boolean(origin),
    recordedExportAtMs: recordedExportAt(record),
    sequenceBuiltAtMs: input.sequenceBuiltAtMs,
    recordedSequenceId: record?.fromExportSequenceId ?? null,
    sequenceId: input.sequenceId ?? null,
  });
  if (decision !== "write" && decision !== "replace-stale-export") return decision;
  mkdirSync(dirname(input.path), { recursive: true });
  const markerPath = youtubeCaptionNoPlanMarkerPath(input.path);
  const sha256 = createHash("sha256").update(input.srt).digest("hex");
  const writtenAt = (input.now ?? new Date()).toISOString();
  // A marca sai antes da cópia nova: falha no meio deixa a cópia velha sem marca, nunca a nova sem ela.
  if (!input.noPlan) rmSync(markerPath, { force: true });
  else {
    const marker: YoutubeCaptionNoPlanMarker = { origin: "no-plan", sha256, writtenAt, fromExport: origin?.name ?? "" };
    writeJson(markerPath, marker);
  }
  writeFileAtomic(input.path, input.srt);
  const file = origin ? { size: origin.size, mtimeMs: origin.mtimeMs, driveModifiedTime: origin.driveModifiedTime } : null;
  writeJson(input.recordPath, {
    path: input.path,
    sha256,
    writtenAt,
    ...(origin ? { fromExport: origin.name } : {}),
    ...(file && Object.values(file).some((v) => v !== undefined && v !== null) ? { fromExportFile: file } : {}),
    ...(origin && input.sequenceId ? { fromExportSequenceId: input.sequenceId } : {}),
    ...(input.noPlan ? { origin: "no-plan" } : {}),
  });
  return decision;
}

/** O horizontal (#11957): mora na lib desde o #13186, reexportado para quem já importava daqui. */
export { isYoutubeSpec };

/** #13212: a recusa do `srt --seq youtube` sem `--from-final`, com o comando do export. */
export function srtHorizontalRefusal(edition: string): string {
  return (
    `a legenda do horizontal sai só do export final (#13212): npx tsx scripts/video-montagem.ts srt ${edition} --seq youtube --from-final "{export do horizontal em Final/}" ` +
    `(no modo API, o nome do arquivo em Final/ no Drive)`
  );
}

/**
 * As sequências do `srt` da montagem. #13212 (decisão do editor, 15/11/2026):
 * só as verticais e os cortes; sem `--seq` o horizontal fica fora, e `--seq`
 * que escolhe o horizontal recusa (a legenda dele sai só do export final,
 * `srt --seq youtube --from-final`). Antes (#11957) o horizontal entrava.
 */
export function srtPlans<P extends { spec: Pick<SequenceSpec, "target" | "corte" | "width" | "height"> }>(all: P[], seq: string | undefined, edition = "{AAMMDD}"): P[] {
  const picked = pickPlans(all, seq, false);
  if (seq === undefined) return picked.filter((p) => !isYoutubeSpec(p.spec));
  if (picked.some((p) => isYoutubeSpec(p.spec))) throw new Error(`--seq ${seq} sem --from-final: ${srtHorizontalRefusal(edition)}`);
  return picked;
}

/**
 * #12078: o plano do horizontal para o `srt --from-final`. Só o horizontal
 * (a legenda que o YouTube recebe); `--seq` ausente ou `youtube`.
 */
export function fromFinalPlan<P extends { spec: Pick<SequenceSpec, "target" | "corte" | "width" | "height"> }>(all: P[], seq: string | undefined): P {
  if (seq !== undefined && seq !== "youtube") throw new Error(`--from-final só gera a legenda do horizontal (--seq youtube), veio --seq ${seq}`);
  const hit = all.filter((p) => isYoutubeSpec(p.spec));
  if (hit.length === 0) throw new Error("plan.json sem a sequência youtube (o horizontal): rode build --seq youtube antes do srt --from-final, ou --no-plan para a legenda só pela fala do export (#12429)");
  return hit[0];
}

/**
 * Chave do cache da transcrição de um export (#12078, também no `review-final`):
 * o mesmo arquivo (caminho, tamanho, mtime) reaproveita a transcrição; um
 * export novo no mesmo nome a invalida.
 */
export function exportTranscriptCacheKey(file: { path: string; size: number; mtimeMs: number }, whisper: { model: string; prompt: string } = { model: WHISPER_MODEL, prompt: "" }): string {
  // O modelo e o prompt do Whisper também entram: vocabulário novo ou outro modelo invalidam o cache.
  const prompt = createHash("sha256").update(whisper.prompt).digest("hex").slice(0, 16);
  return JSON.stringify({ export: { path: toPosix(file.path), size: file.size, mtimeMs: file.mtimeMs }, whisper: { model: whisper.model, prompt } });
}

/** O modelo que o `transcribe_words.py` usa por default (o `--model` não é passado daqui). */
export const WHISPER_MODEL = "large-v3-turbo";

/**
 * #12078: reaproveitar ou refazer a transcrição em cache de um export. Só
 * reaproveita com o transcript E a chave gravada iguais à atual; `--retranscribe` sempre refaz.
 */
export function exportTranscriptAction(input: { transcriptExists: boolean; storedKey: string | null; currentKey: string; retranscribe: boolean }): "reuse" | "transcribe" {
  if (input.retranscribe || !input.transcriptExists || input.storedKey === null) return "transcribe";
  return input.storedKey.trim() === input.currentKey ? "reuse" : "transcribe";
}

/**
 * #12198: limites que recusam a legenda do export. Na 261030 o export foi
 * reeditado depois do build (plan.json defasado): o roteiro gravado não casava
 * com a fala, o alinhamento descartou 12 palavras ouvidas e espremeu o trecho
 * do roteiro que não foi falado em 4 legendas de 0 a 0,22 s, e o comando saiu 0.
 * - `minCueS`: legenda com duração até este valor não se lê (o roteiro forçado num trecho sem fala);
 * - `minHeardCueS`: no `--heard-text` (tempos da fala real) só a legenda vazia (duração ~0) recusa;
 * - `maxDivergence`: fração (palavras do roteiro interpoladas + ouvidas descartadas) / palavras do roteiro.
 */
export const EXPORT_SRT_LIMITS = { minCueS: 0.3, minHeardCueS: 0.05, maxDivergence: 0.1 } as const;

/** O texto da legenda do export: o roteiro alinhado à fala (padrão, #11960) ou a fala ouvida (`--heard-text`, #12198). */
export type ExportSrtText = "roteiro" | "ouvido";

/**
 * #12198: por que a legenda do export é imprópria para publicação (lista vazia =
 * ok). Cada item nomeia o trecho: a legenda curta com tempo e texto, ou as
 * palavras interpoladas/descartadas. Puro.
 */
export function exportSrtProblems(input: {
  cues: Array<{ start: number; end: number; text: string }>;
  text: ExportSrtText;
  /** Só no modo roteiro: o resultado do alinhamento e o nº de palavras do roteiro. */
  aligned?: Pick<ForcedAlignment, "dropped" | "interpolated">;
  scriptWords?: number;
  limits?: Partial<Record<keyof typeof EXPORT_SRT_LIMITS, number>>;
}): string[] {
  const lim = { ...EXPORT_SRT_LIMITS, ...input.limits };
  const minCue = input.text === "roteiro" ? lim.minCueS : lim.minHeardCueS;
  const problems: string[] = [];
  // Folga de 1 ms: os tempos do SRT são em ms e 1,3 - 1 não dá 0,3 exato em ponto flutuante.
  const short = input.cues.filter((c) => c.end - c.start <= minCue + 1e-3);
  if (short.length) {
    problems.push(
      `${short.length} legenda(s) com duração de até ${minCue} s (ilegível): ` +
        short.map((c) => `${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)} (${Math.max(0, c.end - c.start).toFixed(2)} s) "${c.text}"`).join("; "),
    );
  }
  if (input.text === "roteiro" && input.aligned && input.scriptWords) {
    const { dropped, interpolated } = input.aligned;
    const frac = (dropped.length + interpolated.length) / input.scriptWords;
    if (frac > lim.maxDivergence) {
      const parts: string[] = [];
      if (interpolated.length) parts.push(`${interpolated.length} palavra(s) do roteiro sem fala no export (tempo interpolado): "${interpolated.join(" ")}"`);
      if (dropped.length) parts.push(`${dropped.length} palavra(s) ouvida(s) fora do roteiro descartada(s) a partir de ${srtTimestamp(Math.min(...dropped.map((d) => d.word.start)))}: "${dropped.map((d) => d.word.text).join(" ")}"`);
      problems.push(`o export diverge do roteiro do plan.json em ${(frac * 100).toFixed(0)}% das palavras (limite ${(lim.maxDivergence * 100).toFixed(0)}%): ${parts.join("; ")}`);
    }
  }
  return problems;
}

/**
 * #12078: a legenda do horizontal no tempo do EXPORT final. O texto é o do
 * roteiro (#11960), alinhado à fala transcrita do export; sem os cortes da
 * montagem (os tempos do export não são os da sequência), o fim é a duração do export.
 * #12198: `text: "ouvido"` faz a legenda da fala do export (grafia e pontuação
 * do roteiro onde casa e nos trechos curtos ancorados, `alignHeardTextToScript`, #13257), para export reeditado
 * depois do build; `problems` não vazio = legenda imprópria, o chamador não grava.
 */
export function srtFromExport(input: {
  heard: Word[];
  plan: Pick<SequencePlan, "script" | "spec">;
  rules: VocabRule[];
  aliases: VocabAlias[];
  durationS: number;
  text?: ExportSrtText;
  warn?: (msg: string) => void;
}): { srt: string; notes: string[]; problems: string[] } {
  const heard = applyVocabularyToWords(input.heard, input.rules, input.plan.spec, input.warn);
  const label = `${input.plan.spec.name} (export)`;
  if (input.text === "ouvido") {
    const inVideo = heard.filter((w) => w.start < input.durationS);
    // #13257: a grafia do roteiro também nos trechos curtos que o Whisper errou, e o ruído do fim sai.
    const { words, fixes, droppedTail } = alignHeardTextToScript(inVideo, input.plan.script, input.aliases);
    const cues = segmentCues(words);
    const notes = [`[premissa] ${label}: legenda com o texto ouvido no export (--heard-text), não o roteiro do plan.json; conferir grafia e números antes de subir (#12198)`];
    for (const fx of fixes) notes.push(`[premissa] ${label}: ouvido "${fx.heard}", legenda com o roteiro "${fx.script}" (${fx.start.toFixed(2)} s, grafia, #13257)`);
    if (droppedTail.length) notes.push(`[aviso] ${label}: ${droppedTail.length} palavra(s) de ruído depois do fim da fala descartada(s): "${joinWordTexts(droppedTail.map((w) => w.text))}" (#13257)`);
    const dropped = heard.length - inVideo.length;
    if (dropped) notes.push(`[aviso] ${label}: ${dropped} palavra(s) ouvida(s) depois do fim do export descartada(s)`);
    return { srt: cuesToSrt(cues), notes, problems: exportSrtProblems({ cues: cueTimings(cues), text: "ouvido" }) };
  }
  const aligned = forceAlignToScript(heard, input.plan.script, { aliases: input.aliases, cuts: [], endS: input.durationS });
  const cues = segmentCues(aligned.words);
  // A mesma contagem do alinhamento (token sem letra/número não conta).
  const scriptWords = input.plan.script.split(/\s+/).filter((t) => normalizeToken(t)).length;
  return {
    srt: cuesToSrt(cues),
    notes: forcedAlignmentNotes(label, aligned),
    // Fala que começa depois do fim do export não está no vídeo: não é divergência do roteiro.
    problems: exportSrtProblems({ cues: cueTimings(cues), text: "roteiro", aligned: { ...aligned, dropped: aligned.dropped.filter((d) => d.word.start < input.durationS) }, scriptWords }),
  };
}

/**
 * #12429: a chave do horizontal no modo sem plano: a do cache da transcrição
 * do export (`transcribeExport`, a mesma do `review-final` e do `--from-final`
 * com plano) e a das notas em `SRT_NOTES_FILE`. Derivada de `sequenceKey`
 * para não divergir dela.
 */
const NO_PLAN_SEQ_REF: SequenceRef = { target: "youtube" };
export const NO_PLAN_SEQ_KEY: SequenceKey = sequenceKey(NO_PLAN_SEQ_REF);

/**
 * #12429: a legenda do horizontal só pela fala do export, SEM `plan.json`
 * (horizontais anteriores à skill de montagem, 261021–261029). O texto é o
 * ouvido pelo Whisper, com as regras do vocabulário do projeto (e do
 * blocks.json, quando existe) e a grafia dos nomes próprios do texto da edição
 * (`properNounLexicon` sobre o `02-reviewed.md`, `reference`). Sem roteiro não
 * há divergência a medir: como no `--heard-text`, só a legenda vazia recusa.
 * Fala depois do fim do export sai. Puro.
 */
export function srtFromExportNoPlan(input: {
  heard: Word[];
  rules: VocabRule[];
  aliases: VocabAlias[];
  /** Texto da edição (`02-reviewed.md`) para a grafia dos nomes; ausente = só o vocabulário. */
  reference?: string | null;
  durationS: number;
  warn?: (msg: string) => void;
}): { srt: string; notes: string[]; problems: string[] } {
  const label = "horizontal (export, sem plan.json)";
  const vocabWords = applyVocabularyToWords(input.heard, input.rules, NO_PLAN_SEQ_REF, input.warn);
  const inVideo = vocabWords.filter((w) => w.start < input.durationS);
  const lexicon = input.reference ? properNounLexicon(input.reference) : new Map<string, string>();
  const { words, changes } = applyProperNounLexicon(inVideo, lexicon, input.aliases);
  const cues = segmentCues(words);
  const notes = [
    `[premissa] ${label}: legenda com o texto ouvido no export (sem roteiro gravado); grafia pelo vocabulário do projeto` +
      `${input.reference ? ` e por ${lexicon.size} nome(s) próprio(s) do 02-reviewed.md` : ""}; conferir nomes e números antes de subir (#12429)`,
  ];
  if (!input.reference) notes.push(`[aviso] ${label}: sem o texto da edição (02-reviewed.md), os nomes próprios ficam com a grafia que o Whisper ouviu`);
  const summary = summarizeLexiconChanges(changes);
  if (summary.length) notes.push(`[premissa] ${label}: grafia corrigida: ${summary.join("; ")}`);
  const dropped = vocabWords.length - inVideo.length;
  if (dropped) notes.push(`[aviso] ${label}: ${dropped} palavra(s) ouvida(s) depois do fim do export descartada(s)`);
  return { srt: cuesToSrt(cues), notes, problems: exportSrtProblems({ cues: cueTimings(cues), text: "ouvido" }) };
}

/** #12198: o que fazer quando a legenda do export é recusada (a linha final do [erro]). */
export function exportSrtRefusalHint(edition: string, exportPath: string, text: ExportSrtText): string {
  const cmd = `npx tsx scripts/video-montagem.ts srt ${edition} --seq youtube --from-final "${exportPath}"`;
  if (text === "ouvido") return `[erro] SRT NÃO gravado (#12198). A fala transcrita do export tem legenda vazia: conferir o export e a transcrição (--retranscribe refaz) ou subir a legenda pelo Studio.`;
  return (
    `[erro] SRT NÃO gravado (#12198): o export foi reeditado depois do build (o roteiro do plan.json não casa com a fala). ` +
    `Saídas: (1) a legenda pela fala do export: ${cmd} --heard-text (conferir grafia e números antes de subir); ` +
    `(2) atualizar o roteiro do horizontal ao que foi ao ar e refazer o build --seq youtube antes deste srt. Não rodar o --captions-only antes disso.`
  );
}

/** Nome do SRT do horizontal tirado do export (#12078), no out dir; não substitui o da montagem (a prévia usa aquele). */
export function srtFromExportFileName(seqName: string): string {
  return `${seqName} - legendas do export.srt`;
}

/**
 * Transcrição de um export do Premiere (#11557 `review-final`, #12078 `srt --from-final`),
 * em cache no state dir por identidade do arquivo e do Whisper (`exportTranscriptCacheKey`);
 * `--retranscribe` refaz (o `--force` só sobrescreve a cópia do SRT).
 */
function transcribeExport(ctx: Ctx, path: string, key: string, forReview = false): Word[] {
  const trPath = f(ctx, `review-final-${key}.transcript.json`);
  const keyPath = f(ctx, `review-final-${key}.cache-key.json`);
  const st = statSync(path);
  const cacheKey = exportTranscriptCacheKey({ path, size: st.size, mtimeMs: st.mtimeMs }, { model: WHISPER_MODEL, prompt: loadVocab().whisper_prompt ?? "" });
  const action = exportTranscriptAction({
    transcriptExists: existsSync(trPath),
    storedKey: existsSync(keyPath) ? readFileSync(keyPath, "utf8") : null,
    currentKey: cacheKey,
    retranscribe: ctx.retranscribe === true,
  });
  if (action === "transcribe") {
    mkdirSync(ctx.workDir, { recursive: true });
    mkdirSync(ctx.stateDir, { recursive: true });
    // A chave sai ANTES: uma falha no meio nunca deixa a chave do export novo sobre o transcript de outro.
    rmSync(keyPath, { force: true });
    const wav = join(ctx.workDir, `review-final-${key}.wav`);
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000", wav]);
    transcribeWithPython(ctx, wav, trPath, { vad: false });
    writeFileAtomic(keyPath, cacheKey + "\n");
  } else console.error(`[video-montagem] transcrição do export em cache (${trPath}); --retranscribe refaz`);
  return forReview ? reviewTranscriptWords(readJson<Transcript>(trPath, "transcrição do export"))
    : nonEmptyWords(trPath, "transcrição do export");
}

/** Grava a cópia do horizontal na pasta da edição (ver `applyYoutubeSrtCopy`); devolve a decisão. */
function writeYoutubeSrtCopy(ctx: Ctx, srt: string, origin?: ExportOrigin, sequenceBuiltAtMs?: number, sequenceId?: string | null, noPlan = false): ReturnType<typeof youtubeSrtCopyDecision> {
  const path = join(editionDirFor(ctx.edition), youtubeCaptionFileName(ctx.edition));
  const decision = applyYoutubeSrtCopy({ path, recordPath: f(ctx, "youtube-srt.json"), srt, force: ctx.force, origin, sequenceBuiltAtMs, sequenceId, noPlan });
  if (decision === "keep-edited") {
    // No --from-final o chamador sai com [erro]; no srt da montagem é só aviso (#11957).
    if (!origin) console.error(`[aviso] ${path} foi editado depois do último srt: mantido (o novo está no out dir; --force sobrescreve, #11957)`);
    return decision;
  }
  if (decision === "keep-from-export") {
    console.error(`[aviso] ${path} foi gravado pelo srt --from-final (tempo do export): mantido, a legenda da montagem não o substitui (o novo está no out dir; --force sobrescreve, #12078)`);
    return decision;
  }
  if (decision === "replace-stale-export") {
    console.error(
      `[aviso] ${path} veio do srt --from-final de um export anterior ao último build do horizontal: trocado pela legenda da montagem nova (o export antigo não casa com o XML novo). ` +
        `Depois de reexportar, rode srt --from-final no export novo antes do --upload (#12209)`,
    );
  }
  if (origin) console.error(`[premissa] legenda do horizontal no tempo do export ${origin.name} (${path}, a que o publish-youtube.ts --upload/--captions-only envia, #12078)`);
  else console.error(`[premissa] legenda do horizontal no tempo da sequência montada (${path}, a que o publish-youtube.ts --upload envia); se a edição fina no Premiere mudou os tempos, conferir contra o export antes de subir, ou gerar do export com srt --from-final (#11957, #12078)`);
  console.log(path);
  return decision;
}

/**
 * `srt --from-final PATH` (#12078): a legenda do horizontal tirada do export
 * final do Premiere, não do áudio montado pelo XML (o editor abre respiros,
 * insere vinheta). O plan.json defasado só avisa: o export saiu do XML daquele
 * build, então o roteiro gravado nele é o que casa com o export.
 */
function loadFromFinalPlan(ctx: Ctx, seq: string | undefined): { plan: SequencePlan; builtAtMs: number; sequenceId: string | null } {
  const planPath = f(ctx, "plan.json");
  if (!existsSync(planPath)) throw new Error(`sem plan.json (${planPath}): rode build --seq youtube; edição anterior à montagem (sem plano), use --no-plan (a legenda só pela fala do export, #12429)`);
  const pf = readJson<PlanFile>(planPath, "plan.json (rode build --seq youtube)");
  if (!Array.isArray(pf.plans)) throw new Error(`plan.json malformado (sem a lista plans): rode build --seq youtube (${f(ctx, "plan.json")})`);
  const plan = fromFinalPlan(pf.plans, seq);
  if (typeof plan.script !== "string") throw new Error(`plan.json malformado (o horizontal sem script): rode build --seq youtube (${f(ctx, "plan.json")})`);
  try {
    if (pf.hash !== planHash(ctx, loadBlocks(ctx).text)) console.error("[aviso] plan.json defasado (entradas mudaram depois do build): usando o roteiro do horizontal gravado nele, o do XML de onde o export saiu (#12078)");
    else if (typeof pf.hash === "string" && staleMarkOf(pf, sequenceKey(plan.spec))) console.error("[aviso] o horizontal está defasado no plan.json (um build --seq de outra sequência depois de as entradas mudarem): usando o roteiro gravado nele, o do XML de onde o export saiu (#12968)");
  } catch (e) {
    console.error(`[aviso] não deu para conferir o plan.json contra as entradas (${(e as Error).message}): usando o roteiro gravado nele`);
  }
  return { plan, ...xmlVersionAt(pf, sequenceKey(plan.spec), mtime(planPath)) };
}

/**
 * #12285: desde quando vale o XML da sequência e o id dele: o `since` da
 * versão, e sem ela (plano anterior ao #12285) o `builtAt` do #12209.
 */
export function xmlVersionAt(pf: Pick<PlanFile, "builtAt" | "xmlVersions">, key: string, planMtimeMs: number): { builtAtMs: number; sequenceId: string | null } {
  const v = sequenceXmlVersion(pf, key);
  return v ? { builtAtMs: v.since, sequenceId: v.id } : { builtAtMs: sequenceBuiltAt(pf, key, planMtimeMs), sequenceId: null };
}

/** #12209: identidade do export do `--from-final` (tamanho, mtime e, no modo API, o `modifiedTime` do Drive do sidecar do cache). */
export function exportOriginOf(path: string): ExportOrigin {
  const st = statSync(path);
  return { name: basename(path), size: st.size, mtimeMs: Math.round(st.mtimeMs), driveModifiedTime: readSidecar(path)?.modifiedTime ?? null };
}

function cmdSrtFromFinal(ctx: Ctx, file: string, loaded: { plan: SequencePlan; builtAtMs: number; sequenceId: string | null }, text: ExportSrtText = "roteiro"): number {
  const { plan, builtAtMs, sequenceId } = loaded;
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`export não encontrado: ${path}`);
  const origin = exportOriginOf(path);
  const exportAt = recordedExportAt({ fromExport: origin.name, fromExportFile: origin });
  if (exportAt !== null && exportAt < builtAtMs) {
    console.error(
      `[aviso] o export ${origin.name} (${new Date(exportAt).toISOString()}) é anterior ao XML vigente do horizontal (${sequenceId ? `${sequenceId}, desde ` : ""}${new Date(builtAtMs).toISOString()}): ` +
        `se ele saiu de um XML anterior, o roteiro do plan.json não casa com ele; reexporte do XML novo (#12209)`,
    );
  }
  const durationS = exportDurationS(path);
  const vocab = loadVocab();
  const heard = transcribeExport(ctx, path, sequenceKey(plan.spec));
  const { srt, notes: seqNotes, problems } = srtFromExport({ heard, plan, rules: [...vocab.rules, ...blockVocabRules(ctx)], aliases: vocab.aliases, durationS, text, warn: (w) => console.error(`[aviso] ${w}`) });
  return finishExportSrt(ctx, { path, origin, srt, seqNotes, problems, seqName: plan.spec.name, key: sequenceKey(plan.spec), sequenceId, refusalHint: exportSrtRefusalHint(ctx.edition, path, text) });
}

/** Duração do export pelo ffprobe (#12078). */
function exportDurationS(path: string): number {
  const durationS = Number(JSON.parse(run("ffprobe", ["-v", "error", "-show_format", "-of", "json", path]).stdout).format?.duration);
  if (!Number.isFinite(durationS) || durationS <= 0) throw new Error(`duração ilegível no ffprobe (${path})`);
  return durationS;
}

/** O vocabulário do blocks.json da edição; sem ele (ou ilegível), só o do projeto. */
function blockVocabRules(ctx: Ctx, quietWhenMissing = false): VocabRule[] {
  if (quietWhenMissing && !existsSync(f(ctx, "blocks.json"))) {
    warnConflictOnly(f(ctx, "blocks.json"));
    return [];
  }
  try {
    return loadBlocks(ctx).file.vocabulary ?? [];
  } catch (e) {
    console.error(`[aviso] blocks.json ilegível (${(e as Error).message}): só o vocabulário do projeto na legenda`);
    return [];
  }
}

/**
 * O fim comum do `srt --from-final` com e sem plano (#12078, #12429): recusa
 * a legenda imprópria sem gravar nada; senão grava no out dir, a cópia na
 * pasta da edição (a que o `--captions-only` envia) e as notas.
 */
function finishExportSrt(
  ctx: Ctx,
  r: { path: string; origin: ExportOrigin; srt: string; seqNotes: string[]; problems: string[]; seqName: string; key: string; sequenceId: string | null; refusalHint: string; noPlan?: boolean },
): number {
  const { path, origin, srt, seqNotes, problems, sequenceId } = r;
  for (const n of seqNotes) console.error(n);
  if (problems.length) {
    // #12198: nada gravado (nem o out dir nem a cópia da pasta da edição): o --captions-only seguinte publicaria isto.
    for (const p of problems) console.error(`[erro] legenda do export ${basename(path)}: ${p}`);
    console.error(r.refusalHint);
    return 1;
  }
  mkdirSync(ctx.outDir, { recursive: true });
  const out = join(ctx.outDir, srtFromExportFileName(r.seqName));
  writeFileAtomic(out, srt);
  // #12429: o arquivo do out dir também leva a marca de não revisado (o --captions-only --captions o enviaria direto).
  const outMarker = youtubeCaptionNoPlanMarkerPath(out);
  if (r.noPlan) writeJson(outMarker, { origin: "no-plan", sha256: createHash("sha256").update(srt).digest("hex"), writtenAt: new Date().toISOString(), fromExport: origin.name } satisfies YoutubeCaptionNoPlanMarker);
  else rmSync(outMarker, { force: true });
  console.log(out);
  const reviewedFlag = r.noPlan ? " --captions-reviewed" : "";
  const decision = writeYoutubeSrtCopy(ctx, srt, origin, undefined, sequenceId, r.noPlan);
  if (decision === "keep-edited") {
    // Sair 0 aqui deixaria o backfill seguir para o --captions-only com a cópia antiga (tempo da montagem).
    const copy = join(editionDirFor(ctx.edition), youtubeCaptionFileName(ctx.edition));
    console.error(
      `[erro] ${copy} foi editado à mão depois do último srt e NÃO foi substituído: a legenda do export está em ${out}. ` +
        `Rode de novo com --force para gravá-la na pasta da edição, ou envie-a direto${r.noPlan ? ", depois de conferi-la" : ""}: npx tsx scripts/publish-youtube.ts ${ctx.edition} --captions-only --captions "${out}"${reviewedFlag} (#12078)`,
    );
    return 1;
  }
  if (r.noPlan) {
    console.error(
      `[premissa] legenda sem plano marcada como não revisada: confira nomes e números no SRT e envie com ` +
        `npx tsx scripts/publish-youtube.ts ${ctx.edition} --captions-only --captions-reviewed (#12429)`,
    );
  }
  const notesPath = f(ctx, SRT_NOTES_FILE);
  const notes: Record<string, string[]> = existsSync(notesPath) ? readJson<Record<string, string[]>>(notesPath, SRT_NOTES_FILE) : {};
  notes[r.key] = seqNotes;
  writeJson(notesPath, notes);
  return 0;
}

/**
 * #12429: `--no-plan` numa edição cujo plan.json TEM o horizontal descartaria o
 * roteiro aprovado (a grafia e a pontuação do `--from-final` com plano): recusa,
 * salvo `--force` (aí só avisa). plan.json ausente ou ilegível não importa aqui:
 * o modo sem plano não o lê.
 */
function checkNoPlanAgainstPlan(ctx: Ctx): void {
  const planPath = f(ctx, "plan.json");
  warnConflictOnly(planPath);
  if (!existsSync(planPath)) return;
  let hasHorizontal = false;
  try {
    const pf = JSON.parse(readFileSync(planPath, "utf8")) as Partial<PlanFile>;
    hasHorizontal = Array.isArray(pf.plans) && pf.plans.some((p) => p?.spec && isYoutubeSpec(p.spec));
  } catch {
    return; // ilegível: o modo sem plano segue sem ele
  }
  if (!hasHorizontal) return;
  const msg = `${planPath} tem o horizontal: o --from-final sem --no-plan alinha a legenda ao roteiro aprovado (#12429)`;
  if (!ctx.force) throw new Error(`--no-plan recusado: ${msg}; --force para usar só a fala do export mesmo assim`);
  console.error(`[aviso] --no-plan com --force: ${msg}`);
}

/**
 * `srt --from-final PATH --no-plan` (#12429): a legenda do horizontal só pela
 * fala do export, para a edição sem `plan.json` (ou sem o horizontal nele).
 * Mesma transcrição em cache do `review-final`/`--from-final` (chave
 * `youtube`), vocabulário do projeto e grafia dos nomes do `02-reviewed.md`.
 */
function cmdSrtFromFinalNoPlan(ctx: Ctx, file: string): number {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`export não encontrado: ${path}`);
  const origin = exportOriginOf(path);
  const durationS = exportDurationS(path);
  const vocab = loadVocab();
  const reviewedPath = join(editionDirFor(ctx.edition), "02-reviewed.md");
  const reference = existsSync(reviewedPath) ? readFileSync(reviewedPath, "utf8") : null;
  const heard = transcribeExport(ctx, path, NO_PLAN_SEQ_KEY);
  const { srt, notes: seqNotes, problems } = srtFromExportNoPlan({
    heard,
    rules: [...vocab.rules, ...blockVocabRules(ctx, true)],
    aliases: vocab.aliases,
    reference,
    durationS,
    warn: (w) => console.error(`[aviso] ${w}`),
  });
  return finishExportSrt(ctx, {
    path, origin, srt, seqNotes, problems,
    seqName: horizontalSequenceName(), key: NO_PLAN_SEQ_KEY, sequenceId: null,
    refusalHint: exportSrtRefusalHint(ctx.edition, path, "ouvido"),
    noPlan: true,
  });
}

/** #11641: o caminho do bruto que o XML grava (o do Neo, não o do cache do modo API); o `build` e a legenda do XML (#13332) usam o mesmo. */
function buildXmlMediaPath(ctx: Ctx, source: Pick<SourceInfo, "path">): ReturnType<typeof xmlMediaPath> {
  return xmlMediaPath(source.path, { edition: ctx.edition, drive: readBrutoDrive(ctx), xmlMediaRoot: ctx.xmlMediaRoot, driveRoot: ctx.driveRoot, apiMode: ctx.mode === "api" });
}

async function cmdSrt(ctx: Ctx, target: string | undefined, fromRaw: boolean): Promise<number> {
  const pf = loadPlan(ctx);
  const { file } = loadBlocks(ctx);
  const vocab = loadVocab();
  const rules = [...vocab.rules, ...(file.vocabulary ?? [])];
  mkdirSync(ctx.outDir, { recursive: true });
  const fps = pf.source.fps;
  // #12093: o que o alinhamento decidiu (ouvido × roteiro) vira item do relatório final, não só stderr.
  const notesPath = f(ctx, SRT_NOTES_FILE);
  const notes: Record<string, string[]> = existsSync(notesPath) ? readJson<Record<string, string[]>>(notesPath, SRT_NOTES_FILE) : {};
  const plans = srtPlans(pf.plans, target, ctx.edition);
  if (target === undefined && pf.plans.some((p) => isYoutubeSpec(p.spec))) {
    console.error(`[premissa] o horizontal fica fora do srt da montagem; ${srtHorizontalRefusal(ctx.edition)}, quando o editor pedir`);
  }
  if (plans.length === 0) console.error("[aviso] nenhuma vertical no plan.json: nenhuma legenda gerada (#13212)");
  for (const plan of plans) {
    const heard = applyVocabularyToWords(seqWords(ctx, plan, pf.source, fromRaw), rules, plan.spec, (w) => console.error(`[aviso] ${w}`));
    // #11960: o texto do roteiro no tempo da fala, não o texto ouvido.
    const aligned = forceAlignToScript(heard, plan.script, { aliases: vocab.aliases, cuts: cutPoints(plan, fps), endS: plan.durationFrames / fps });
    const cues = segmentCues(aligned.words);
    const seqNotes = [...forcedAlignmentNotes(plan.spec.name, aligned), ...montageSrtWarnings(plan.spec.name, plan.script, aligned, cueTimings(cues))];
    for (const n of seqNotes) console.error(n);
    notes[sequenceKey(plan.spec)] = seqNotes;
    const srt = cuesToSrt(cues);
    const path = join(ctx.outDir, srtFileName(plan.spec.name));
    writeFileAtomic(path, srt);
    console.log(path);
    // #13212: o horizontal não passa por aqui (srtPlans), então a cópia da pasta da edição só sai do --from-final.
    // #13332: a mesma legenda dentro do XML da vertical, para o Premiere abrir já legendado.
    const xml = await writeSubtitleXml(ctx, pf, plan, cueTimings(cues));
    if (xml) console.log(xml);
  }
  writeJson(notesPath, notes);
  console.error(`[video-montagem] ouvido × roteiro de cada legenda em ${notesPath}: itens a conferir no relatório final (#12093)`);
  return 0;
}

/**
 * #13332: a legenda da vertical dentro do XML dela. Cada cue (o texto do SRT,
 * já quebrado em linhas) vira um PNG transparente do tamanho da sequência, no
 * estilo da prévia (`PREVIEW_SUBTITLE_STYLE`), em `{subpasta}/` do out dir (que
 * sobe para a subpasta de mesmo nome da edição), numa faixa no topo do vídeo
 * da sequência. Um `srt` de novo troca a faixa; um `build` de novo regrava o
 * XML sem ela (rodar o `srt` depois, como sempre). Falha aqui é aviso: o SRT
 * já foi gravado e o XML fica como estava.
 */
async function writeSubtitleXml(ctx: Ctx, pf: PlanFile, plan: SequencePlan, cues: ReadonlyArray<{ start: number; end: number; text: string }>): Promise<string | null> {
  const xmlPath = join(ctx.outDir, xmlFileName(plan.spec.name));
  if (!existsSync(xmlPath)) {
    console.error(`[aviso] ${plan.spec.name}: ${basename(xmlPath)} ausente no out dir: a legenda fica só no SRT (rode build antes do srt, #13332)`);
    return null;
  }
  try {
    const style = parseAssStyle(PREVIEW_SUBTITLE_STYLE);
    const { width, height } = plan.spec;
    const dirName = subtitleDirName(sequenceKey(plan.spec));
    const dir = join(ctx.outDir, dirName);
    mkdirSync(dir, { recursive: true });
    const media = buildXmlMediaPath(ctx, pf.source).path.replace(/\\/g, "/");
    const xmlDir = `${media.slice(0, media.lastIndexOf("/") + 1)}${dirName}/`;
    const frames = cueFrames(cues, pf.source.fps, plan.durationFrames);
    const overlays: SubtitleOverlay[] = [];
    for (let i = 0; i < cues.length; i++) {
      if (frames[i].out <= frames[i].in) continue;
      const text = wrapCueText(cues[i].text);
      const svg = subtitleCueSvg(text, width, height, style);
      const name = subtitleFileName(ctx.edition, i + 1, createHash("sha256").update(svg).digest("hex").slice(0, 12));
      const out = join(dir, name);
      // Regravado sempre, como os boxes de tela: no modo API o snapshot do out dir é o que sobe (#13204).
      await sharp(Buffer.from(svg)).png().toFile(`${out}.part`);
      renameSync(`${out}.part`, out);
      overlays.push({ index: i + 1, text, path: out, xmlPath: `${xmlDir}${name}`, width, height, in: frames[i].in, out: frames[i].out });
    }
    const rate = `<rate><timebase>${pf.source.fps}</timebase><ntsc>FALSE</ntsc></rate>`;
    const track = subtitleTrack({ overlays, rate, url: (p) => pathUrl(premierePath(p, ctx.premierePaths)) });
    writeFileAtomic(xmlPath, withSubtitleTrack(readFileSync(xmlPath, "utf8"), track));
    console.error(
      `[premissa] ${plan.spec.name}: ${overlays.length} legenda(s) em PNG (estilo da prévia) numa faixa no topo do XML, no tempo das cues do SRT, em ${dirName}/; ` +
        `o XML com legenda é a versão entregue; um build de novo tira a faixa (rodar srt depois); conferir no 1º import (#13332)`,
    );
    return xmlPath;
  } catch (e) {
    console.error(`[aviso] ${plan.spec.name}: legenda no XML falhou (${(e as Error).message.split("\n")[0]}): o XML fica sem ela, o SRT está gravado (#13332)`);
    return null;
  }
}

/** #12237: legenda da montagem com até isto de duração é espremida (o export usa 0,3 s, `EXPORT_SRT_LIMITS`). */
export const MONTAGE_SRT_MIN_CUE_S = 0.15;

/**
 * #12237: o `srt` da montagem usa o mesmo alinhamento do `--from-final` e
 * podia sair com legenda espremida (≤0,3 s) ou roteiro divergente da fala sem
 * nenhum sinal. Aqui os mesmos limites do export (`exportSrtProblems`) viram
 * `[aviso]` nomeando o trecho, no stderr e no `srt-notas.json` (relatório
 * final). Só avisa, não recusa: o plan.json da montagem sai da mesma
 * transcrição, então divergência aqui é exceção a conferir, não export
 * reeditado — e a legenda ainda passa pela prévia e pelo review. Puro.
 */
export function montageSrtWarnings(
  seqName: string,
  script: string,
  aligned: Pick<ForcedAlignment, "dropped" | "interpolated">,
  cues: Array<{ start: number; end: number; text: string }>,
): string[] {
  const scriptWords = script.split(/\s+/).filter((t) => normalizeToken(t)).length;
  // A montagem tira as pausas: uma frase de uma palavra ("Exato.") dá legenda
  // de ~0,3 s legítima. Aqui só avisa a legenda espremida de fato (≤0,15 s).
  return exportSrtProblems({ cues, text: "roteiro", aligned, scriptWords, limits: { minCueS: MONTAGE_SRT_MIN_CUE_S } }).map(
    (p) => `[aviso] ${seqName}: legenda possivelmente imprópria (#12237) — ${p}; conferir na prévia antes de subir`,
  );
}

/** Notas do alinhamento de cada legenda (#12093), por sequência: o relatório final lista para o editor conferir. */
export const SRT_NOTES_FILE = "srt-notas.json";

/**
 * #12579: a legenda da prévia. A ordem do fluxo é prévia sem legenda → review →
 * aprovação das prévias → `srt`, então SRT ausente ou mais velho que o build
 * desta sequência não recusa mais a prévia: ela sai sem legenda, com
 * `[aviso]`. `--no-subs` tira a legenda mesmo com SRT em dia. Puro.
 */
export function previewSubtitleDecision(input: { srtPath: string; exists: boolean; srtMtimeMs?: number; builtAtMs: number; noSubs: boolean; horizontal?: boolean }): { use: boolean; message: string | null } {
  // #13212: a prévia do horizontal sai sempre sem legenda (a legenda dele vem só do export final), mesmo com um SRT antigo no out dir.
  if (input.horizontal) return { use: false, message: "[video-montagem] prévia do horizontal sem legenda: a legenda do horizontal sai só do export final (srt --seq youtube --from-final, #13212)" };
  if (input.noSubs) return { use: false, message: "[video-montagem] prévia sem legenda (--no-subs): as legendas (srt) vêm depois da aprovação das prévias (#12579)" };
  if (!input.exists) return { use: false, message: `[aviso] sem ${input.srtPath}: a prévia sai sem legenda; as legendas (srt) vêm depois da aprovação das prévias (#12579)` };
  if ((input.srtMtimeMs ?? 0) < input.builtAtMs) {
    return { use: false, message: `[aviso] ${input.srtPath} é mais velho que o build desta sequência no plan.json: a prévia sai sem legenda; rode srt depois da aprovação das prévias (e a prévia de novo, se quiser a legenda queimada) (#12579)` };
  }
  return { use: true, message: null };
}

/**
 * O gancho de publicação do corte na prévia e na revisão (#12712), lido do
 * blocks.json atual (o gancho não entra no plan.json). blocks.json ilegível
 * só avisa: a prévia segue.
 */
function printCorteHook(ctx: Ctx, spec: SequenceSpec): void {
  if (spec.corte === undefined) return;
  try {
    const hook = corteHookLine(loadBlocks(ctx).file, spec);
    if (hook) console.error(`[${hook.level}] ${spec.name}: ${hook.text}`);
  } catch (e) {
    console.error(`[aviso] ${spec.name}: gancho do corte não conferido (${(e as Error).message}) (#12712)`);
  }
}

/**
 * O gate de duração da prévia (#12694): vertical (da edição ou corte/Short
 * avulso) acima do alvo não ganha prévia nem review. Imprime o `[aviso] GATE
 * BLOQUEADO` e devolve true para o comando sair com 1, ANTES de baixar o bruto
 * ou renderizar. `overTarget` (`--over-target`) força, com o aviso mesmo assim.
 */
export function verticalDurationGateBlocks(
  plan: Pick<SequencePlan, "spec" | "durationFrames">,
  fps: number,
  targetS: number | undefined,
  overTarget: boolean,
  log: (line: string) => void = (l) => console.error(l),
): boolean {
  const gate = verticalPreviewGate(plan, fps, targetS);
  if (!gate) return false;
  if (overTarget) {
    log(`${gate.replace("GATE BLOQUEADO", "acima do alvo, forçado por --over-target")}`);
    return false;
  }
  log(gate);
  return true;
}

async function cmdPreview(
  ctx: Ctx,
  target: string | undefined,
  drive: DriveSession | null = null,
  noSubs = false,
  opts: { overTarget?: boolean; needLocalBruto?: () => Promise<unknown> } = {},
): Promise<number> {
  const pf = loadPlan(ctx);
  // #12096: `--seq youtube` também (o horizontal, 960x540); sem --seq, a vertical da edição.
  const [plan] = pickPlans(pf.plans, target ?? "outras-redes", false, true);
  // #12694: acima de 75 s de fala, a prévia não sai (nem o bruto é baixado).
  if (verticalDurationGateBlocks(plan, pf.source.fps, loadBlocks(ctx).file.verticalTargetS, opts.overTarget === true)) return 1;
  await opts.needLocalBruto?.();
  printCorteHook(ctx, plan.spec);
  if (pf.framingAssumed) console.error("[premissa] blocks.json sem framing: usando o da 261027 (o mesmo do build)");
  for (const w of framingWarningsByFile([plan], pf.source, pf.framing, pf.fileOverrides).mug) console.error(`[aviso] ${w}`);
  const fps = pf.source.fps;
  const srt = join(ctx.outDir, srtFileName(plan.spec.name));
  const planPath = f(ctx, "plan.json");
  // #11969: contra o build DESTA sequência, não o último build de qualquer uma. #12579: defasado = prévia sem legenda, não recusa.
  const srtExists = existsSync(srt);
  const subs = previewSubtitleDecision({ srtPath: srt, exists: srtExists, srtMtimeMs: srtExists ? mtime(srt) : undefined, builtAtMs: sequenceBuiltAt(pf, sequenceKey(plan.spec), mtime(planPath)), noSubs, horizontal: isYoutubeSpec(plan.spec) });
  if (subs.message) console.error(subs.message);
  const dir = join(ctx.workDir, `previa-${sequenceKey(plan.spec)}`);
  mkdirSync(dir, { recursive: true });
  const list: string[] = [];
  const audioParts: string[] = [];
  const size = previewSize(plan.spec);
  // #12101/#12102: o que o XML DESTA sequência levou (gravado no build dela), não o que o config diz agora.
  const assets = pf.xmlAssets?.[sequenceKey(plan.spec)] ?? {};
  // #13536: a prévia segue o plano, sem os trechos inseridos do XML (formato react): dito aqui, nunca em silêncio.
  const semTrechos = previewTrechosAviso(assets.trechosInseridos ?? [], fps);
  if (semTrechos) console.error(`[aviso] ${semTrechos}`);
  const treated = assets.treatedAudio;
  const audioSrc = treated && existsSync(treated.path) ? treated.path : undefined;
  if (treated && !audioSrc) console.error(`[aviso] faixa de áudio tratada ausente (${treated.path}): prévia com o áudio cru do bruto; rode build nesta máquina (#12102)`);
  else if (!treated) console.error("[aviso] o XML desta sequência saiu sem faixa de áudio tratada (--no-audio-clean, falha no render ou build anterior ao #12102): prévia com o áudio cru");
  // #12559: bruto em vários arquivos: vídeo do arquivo do clipe em tempo local, áudio da faixa global (tratada, ou o concatenado).
  const multi = isMultiSource(pf.source);
  const multiAudio = multi ? (audioSrc ?? audioInputOf(ctx, pf.source)) : undefined;
  // #13530 review: onde cada clipe foi decodificado, para refazer na CPU os da GPU se ela cair no meio.
  const clipJobs: { args: string[]; what: string; device: "cuda" | "cpu" }[] = [];
  const decodeClip = (args: string[], what: string): void => {
    clipJobs.push({ args, what, device: runDecode(args, what) });
  };
  // #13508: o proxy 1440p do transcribe (bruto de um arquivo só; a meta confere caminho, tamanho e duração).
  const proxy = previewProxy(ctx, pf.source);
  plan.clips.forEach((c, i) => {
    const name = `c${String(i).padStart(2, "0")}.mp4`;
    // #13303: o áudio exato do clipe (PCM, amostras por quadro), regravado sobre o concat no fim.
    const wav = `a${String(i).padStart(2, "0")}.wav`;
    run("ffmpeg", previewClipAudioArgs({ audioSrc: (multi ? multiAudio : audioSrc) ?? pf.source.path, start: c.frameIn / fps, frames: c.frameOut - c.frameIn, fps, out: join(dir, wav) }));
    audioParts.push(wav);
    if (multi) {
      // A mesma geometria do XML (arquivo, encaixe, framing do arquivo e do item).
      const g = clipGeometry({ source: pf.source, spec: plan.spec, framing: pf.framing, fileOverrides: pf.fileOverrides, clip: c });
      const off = g.file.offsetFrames;
      decodeClip(previewClipArgs({
        src: g.file.path, start: (c.frameIn - off) / fps, end: (c.frameOut - off) / fps,
        crop: g.main.crop ?? { x: 0, y: 0, w: g.file.width, h: g.file.height }, mirrored: g.mirrored, fps, out: join(dir, name), ...size,
        audioSrc: multiAudio, audioStart: c.frameIn / fps, fit: g.fit, videoOnly: true,
      }), `clipe ${i + 1} da prévia`);
      list.push(`file '${name}'`);
      console.error(`[video-montagem] clipe ${i + 1}/${plan.clips.length} (${c.block}, ${g.file.id}${g.fit !== "fill" ? `, ${g.fit}` : ""})`);
      return;
    }
    // #12096: o recorte do XML (framingFor com a escala e o eyeFraction da sequência).
    const srcCrop = previewCropFor(pf.source, plan.spec, clipFraming(pf.framing, c), c.scale);
    // #13508: com o proxy 1440p válido, a prévia lê dele (o mesmo recorte, em px do proxy); o XML segue no 4K.
    const crop = proxy ? cropOnProxy(srcCrop, pf.source, proxy.size) : srcCrop;
    // #12559: `fit` explícito no bruto único (o default segue fill): o mesmo encaixe do XML.
    const fit = clipGeometry({ source: pf.source, spec: plan.spec, framing: pf.framing, clip: c }).fit;
    // Corte pelos FRAMES do plano, os mesmos do XML.
    decodeClip(previewClipArgs({ src: proxy?.path ?? pf.source.path, start: c.frameIn / fps, end: c.frameOut / fps, crop, mirrored: pf.source.mirrored, fps, out: join(dir, name), ...size, ...(audioSrc ? { audioSrc } : {}), ...(fit !== "fill" ? { fit } : {}), videoOnly: true }), `clipe ${i + 1} da prévia`);
    list.push(`file '${name}'`);
    console.error(`[video-montagem] clipe ${i + 1}/${plan.clips.length} (${c.block})`);
  });
  // #13530 review: GPU caiu no meio da prévia: os clipes já feitos pela GPU podem ter outro pix_fmt e o concat
  // -c copy exige parâmetros iguais; refaz esses na CPU (o decoder já está em "cpu") para a prévia sair uniforme.
  const redo = clipsToRedoOnCpu(clipJobs.map((j) => j.device));
  if (redo.length > 0) {
    console.error(`[aviso] a GPU caiu no meio da prévia: refazendo na CPU ${redo.length} clipe(s) feitos por ela, para o concat sair uniforme (#13530)`);
    for (const k of redo) runDecode(clipJobs[k].args, `${clipJobs[k].what} (refeito na CPU)`);
  }
  // #12571: o card de CTA que o XML desta sequência levou, como último clipe (com áudio em silêncio para o concat).
  const card = assets.ctaCard ?? null;
  let cardS = 0;
  if (card && existsSync(card.path)) {
    const name = `c${String(plan.clips.length).padStart(2, "0")}-cta-card.mp4`;
    try {
      // O mesmo formato de pixel dos clipes do bruto (o concat não recodifica); ffprobe falho = o do card.
      let pixFmt: string | undefined;
      try { pixFmt = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", join(dir, "c00.mp4")]).stdout.trim() || undefined; } catch { pixFmt = undefined; }
      run("ffmpeg", ctaCardPreviewClipArgs({ src: card.path, out: join(dir, name), fps, ...size, durationS: card.frames / fps, pixFmt, videoOnly: true }));
      list.push(`file '${name}'`);
      cardS = card.frames / fps;
      console.error(`[video-montagem] card de CTA no fim da prévia (${cardS.toFixed(2)} s, #12571)`);
    } catch (e) {
      console.error(`[aviso] card de CTA na prévia falhou (${(e as Error).message.split("\n")[0]}): prévia sem o card; o XML o tem (#12571)`);
    }
  } else if (card) console.error(`[aviso] card de CTA do XML não encontrado nesta máquina (${card.path}): prévia sem ele; rode build nesta máquina (#12571)`);
  writeFileSync(join(dir, "list.txt"), list.join("\n") + "\n");
  run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "joined.mp4"], { cwd: dir });
  // #13303: troca a faixa (AAC por clipe, deriva ~21 ms por corte) pela concatenação PCM de amostras exatas; o card segue em silêncio.
  if (cardS > 0) {
    run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", cardS.toFixed(6), "-c:a", "pcm_s16le", "a-card.wav"], { cwd: dir });
    audioParts.push("a-card.wav");
  }
  writeFileSync(join(dir, "alist.txt"), concatListText(audioParts));
  run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "alist.txt", "-c", "copy", "exact.wav"], { cwd: dir });
  run("ffmpeg", ["-y", "-v", "error", "-i", "joined.mp4", "-i", "exact.wav", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "joined-exact.mp4"], { cwd: dir });
  renameSync(join(dir, "joined-exact.mp4"), join(dir, "joined.mp4"));
  // #13123: a capa que o XML desta sequência levou, por cima dos primeiros quadros (antes da legenda e da vinheta).
  const capa = assets.capaInicio ?? null;
  if (capa && existsSync(capa.path)) {
    const frames = capaFramesOf(capa, plan.durationFrames) ?? 0;
    try {
      run("ffmpeg", previewCapaInicioArgs({ input: "joined.mp4", png: capa.path, out: "joined-capa.mp4", frames, ...size }), { cwd: dir });
      renameSync(join(dir, "joined-capa.mp4"), join(dir, "joined.mp4"));
      console.error(`[video-montagem] prévia com a capa nos primeiros ${frames} quadros (${(frames / fps).toFixed(2)} s): "${capa.text}" (#13123)`);
    } catch (e) {
      console.error(`[aviso] capa no começo na prévia falhou (${(e as Error).message.split("\n")[0]}): prévia sem a capa; o XML a tem (#13123)`);
    }
  } else if (capa) console.error(`[aviso] capa no começo do XML não encontrada nesta máquina (${capa.path}): prévia sem ela; rode build nesta máquina (#13123)`);
  // #13204: os boxes de tela do XML, cada um no trecho dele.
  const telas = (assets.telaOverlays ?? []).filter((o) => existsSync(o.path) && o.in < plan.durationFrames);
  if (telas.length) {
    try {
      run("ffmpeg", previewTelaArgs({ input: "joined.mp4", out: "joined-tela.mp4", ...size, overlays: telas.map((o) => ({ png: o.path, in: o.in, out: Math.min(o.out, plan.durationFrames) })) }), { cwd: dir });
      renameSync(join(dir, "joined-tela.mp4"), join(dir, "joined.mp4"));
      console.error(`[video-montagem] prévia com ${telas.length} box(es) de tela (${telas.map((o) => o.id).join(", ")}, #13204)`);
    } catch (e) {
      console.error(`[aviso] boxes de tela na prévia falharam (${(e as Error).message.split("\n")[0]}): prévia sem eles; o XML os tem (#13204)`);
    }
  } else if (assets.telaOverlays?.length) console.error("[aviso] boxes de tela do XML não encontrados nesta máquina: prévia sem eles (#13204)");
  let subtitles: string | undefined;
  if (subs.use) {
    copyFileSync(srt, join(dir, "leg.srt"));
    subtitles = `subtitles=leg.srt:force_style='${isVerticalSpec(plan.spec) ? PREVIEW_SUBTITLE_STYLE : PREVIEW_SUBTITLE_STYLE_HORIZONTAL}'`;
  }
  mkdirSync(ctx.outDir, { recursive: true });
  const out = join(ctx.outDir, previewFileName(ctx.edition, sequenceKey(plan.spec)));
  // #12101: a mesma vinheta do XML desta sequência por cima, no mesmo instante e no mesmo tamanho relativo.
  let vinheta = assets.vinheta ?? null;
  if (vinheta && drive) {
    const local = await loadVinhetaForDrive(drive, { readConfig: () => ({ publishing: { video: { vinheta_logo: { path: vinheta!.path } } } }) });
    vinheta = local ? { ...vinheta, path: local.localPath ?? local.path } : null;
  }
  if (vinheta && !existsSync(vinheta.path)) {
    console.error(`[aviso] vinheta do logo do XML não encontrada nesta máquina (${vinheta.path}): prévia sem ela (#12101)`);
    vinheta = null;
  }
  const vs = vinheta ? vinhetaSpan(plan, fps, vinheta) : null;
  // #13240: o som a cada "." do logo que o XML desta sequência levou, nos mesmos quadros.
  // `sfx.path` fica o do XML; o arquivo que o ffmpeg lê nesta máquina é `sfxLocalPath` (o cache do Drive, ou o próprio caminho).
  const sfx: VinhetaSfx | null = vinheta?.sfx ?? null;
  let sfxLocalPath: string | null = sfx?.path ?? null;
  if (sfx && drive) {
    const local = await loadVinhetaSfxForDrive(drive, { readConfig: () => ({ publishing: { video: { vinheta_som: { path: sfx.path, at_s: sfx.atS } } } }), consequence: SFX_PREVIEW_CONSEQUENCE });
    sfxLocalPath = local ? (local.localPath ?? local.path) : null;
  }
  if (sfxLocalPath && !existsSync(sfxLocalPath)) {
    console.error(`[aviso] som da vinheta do XML não encontrado nesta máquina (${sfxLocalPath}): ${SFX_PREVIEW_CONSEQUENCE} (#13240)`);
    sfxLocalPath = null;
  }
  const sfxAtSeqS = sfx && sfxLocalPath && vs ? vinhetaSfxFrames(vs, fps, sfx, plan.durationFrames).map((x) => x.start / fps) : [];
  // #13371: o render sai com o áudio sem normalizar (PCM); o loudnorm em duas passadas vem depois, em normalizePreviewAudio.
  const plain = [...(subtitles ? ["-vf", subtitles] : []), "-af", "anull"];
  const finalArgs = (filters: string[]) => [
    "-y", "-v", "error", "-i", "joined.mp4", ...filters,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "pcm_s16le", "-ar", "48000", PREVIEW_RAW_NAME,
  ];
  if (vinheta && vs) {
    console.error(`[video-montagem] prévia com a vinheta do logo em ${(vs.start / fps).toFixed(2)} s (#12101)`);
    // #13240: o mesmo abaixamento do áudio sob a vinheta que o XML leva.
    const ds = vinhetaDuckSpan(plan, fps, vinheta);
    const duck = ds ? { startS: ds.start / fps, endS: ds.end / fps, db: VINHETA_DUCK_DB } : null;
    const withVinheta = (withSfx: boolean) => [
      "-i", vinheta!.path,
      ...(withSfx ? ["-i", sfxLocalPath!] : []),
      "-filter_complex", previewVinhetaFilter({ startS: vs.start / fps, scale: (vinhetaScalePct(vinheta!, plan.spec) / 100) * (size.width / plan.spec.width), hasAudio: vinhetaUsesMovAudio(vinheta!), subtitles, loudnorm: "anull", duck, ...(withSfx ? { sfx: { atSeqS: sfxAtSeqS } } : {}) }),
      "-map", "[vout]", "-map", "[aout]",
    ];
    if (sfxAtSeqS.length) console.error(`[video-montagem] prévia com o som da vinheta em ${sfxAtSeqS.map((t) => `${t.toFixed(2)} s`).join(" e ")} (#13240)`);
    try {
      // #13240: o som nunca derruba a vinheta da prévia; só leva a culpa se a prévia sem ele passar.
      runWithSfxFallback((withSfx) => { run("ffmpeg", finalArgs(withVinheta(withSfx)), { cwd: dir }); }, sfxAtSeqS.length > 0, (m) => console.error(m));
    } catch (e) {
      // #12101: o overlay nunca derruba a prévia: refaz sem a vinheta.
      console.error(`[aviso] sobrepor a vinheta na prévia falhou (${(e as Error).message.split("\n")[0]}): prévia sem a vinheta; o XML a tem (#12101)`);
      run("ffmpeg", finalArgs(plain), { cwd: dir });
    }
  } else run("ffmpeg", finalArgs(plain), { cwd: dir });
  normalizePreviewAudio(dir);
  // #13610: com o out dir na pasta da edição (o Neo), a nova vai para `.part`, a anterior para arquivo/, e só então a nova toma o nome.
  installPreviewFile(join(dir, "previa.mp4"), out, { archive: ctx.mode === "local" && !ctx.noArchive && outDirIsEditionFolder(ctx), log, warn: (m) => console.error(`[aviso] ${m}`) });
  // 14 quadros (7x2) espalhados pela prévia inteira, qualquer que seja a duração.
  const dur = Math.max(1, plan.durationFrames / fps + cardS);
  const sheet = f(ctx, `previa-${sequenceKey(plan.spec)}.jpg`);
  run("ffmpeg", ["-y", "-v", "error", "-i", join(dir, "previa.mp4"), "-vf", `fps=${(14 / dur).toFixed(4)},scale=${isVerticalSpec(plan.spec) ? 270 : 480}:-1,tile=7x2`, "-frames:v", "1", sheet]);
  console.log(JSON.stringify({ preview: out, sheet }, null, 2));
  return 0;
}

/**
 * #13536: o aviso da prévia de uma sequência com trecho inserido no XML: a
 * prévia segue o plano (sem o trecho e sem o deslocamento dele), então cada
 * tempo depois do ponto de inserção difere do export. `null` sem trecho.
 */
export function previewTrechosAviso(trechos: readonly Pick<TrechoInseridoClip, "id" | "at" | "frames">[], fps: number): string | null {
  const ts = trechos.filter((t) => t.frames > 0);
  if (!ts.length) return null;
  const total = ts.reduce((k, t) => k + t.frames, 0) / fps;
  const onde = ts.map((t) => `${t.id} em ${(t.at / fps).toFixed(1)} s (${(t.frames / fps).toFixed(1)} s)`).join(", ");
  return `prévia SEM ${ts.length} trecho(s) inserido(s) que o XML tem (${onde}; ${total.toFixed(1)} s no total): depois de cada ponto, o tempo da prévia fica atrás do export; conferir o trecho no Premiere (#13536)`;
}

/**
 * #13371: `loudnorm` em duas passadas no áudio do render da prévia
 * (`PREVIEW_RAW_NAME` → `previa.mp4`), com o alvo do export. Medida ilegível
 * (sem resumo, áudio todo em silêncio) cai na passada única de antes, com aviso.
 */
function normalizePreviewAudio(dir: string): void {
  let measured: ReturnType<typeof parseLoudnormFirstPass> = null;
  let why = "o loudnorm não imprimiu o resumo";
  try {
    measured = parseLoudnormFirstPass(run("ffmpeg", previewLoudnormMeasureArgs(PREVIEW_RAW_NAME), { cwd: dir }).stderr);
  } catch (e) {
    why = (e as Error).message.split("\n")[0];
  }
  if (measured) {
    console.error(`[video-montagem] prévia: ${measured.inputI.toFixed(1)} LUFS medidos, normalizada a ${PREVIEW_LOUDNORM.i} LUFS em duas passadas (#13371)`);
  } else {
    console.error(`[aviso] medida de loudness da prévia falhou (${why}): loudnorm em uma passada, a ${PREVIEW_LOUDNORM.i} LUFS (#13371)`);
  }
  run("ffmpeg", previewLoudnormApplyArgs({ src: PREVIEW_RAW_NAME, out: "previa.mp4", filter: measured ? loudnormSecondPassFilter(measured) : LOUDNORM_TARGET }), { cwd: dir });
}

/**
 * O silencedetect da palavra esticada e da autorrevisão: `review`, `preview`,
 * `review-final` e o `verify-xml` (#12711) leem o áudio montado com o MESMO
 * limiar fixo, para as checagens darem o mesmo veredito (#12969). O limiar
 * adaptativo do #12903 vale para as pausas do bruto e as bordas, não para este.
 */
export const REVIEW_SILENCE_FILTER = "silencedetect=noise=-40dB:d=0.08";

/**
 * #12571: o trecho da prévia que a autorrevisão mede. Com o card de CTA no fim
 * (sem fala), a revisão corta no fim da montagem: palavras e silêncios depois
 * dele saem, e o `final-seco`/ritmo seguem medindo a fala como antes do card.
 * Duas conferências do card: a prévia precisa durar a montagem + o card, e
 * nenhuma palavra pode cair no card (o trecho sem fala). Sem card, tudo igual. Puro.
 */
export function reviewCardScope(input: {
  durationS: number; montageS: number; cardS: number;
  words: Word[]; silences: Interval[];
}): { speechS: number; cardS: number; words: Word[]; silences: Interval[]; warnings: string[] } {
  if (!(input.cardS > 0)) return { speechS: input.durationS, cardS: 0, words: input.words, silences: input.silences, warnings: [] };
  const speechS = Math.min(input.durationS, input.montageS);
  const warnings: string[] = [];
  const missing = input.montageS + input.cardS - input.durationS;
  if (missing > 0.5) warnings.push(`a prévia dura ${input.durationS.toFixed(2)} s, a montagem + o card de CTA ${(input.montageS + input.cardS).toFixed(2)} s: o card não entrou inteiro (rode preview de novo) (#12571)`);
  const onCard = input.words.filter((w) => w.start >= speechS + 0.1);
  if (onCard.length) warnings.push(`fala dentro do card de CTA (${onCard.map((w) => w.text.trim()).join(" ")}), a partir de ${onCard[0].start.toFixed(2)} s: o card é sem áudio; conferir a prévia (#12571)`);
  return {
    speechS,
    cardS: input.cardS,
    words: input.words.filter((w) => w.start < speechS + 0.1),
    silences: input.silences.filter((x) => x.start < speechS).map((x) => ({ start: x.start, end: Math.min(x.end, speechS) })),
    warnings,
  };
}

function cmdReview(ctx: Ctx, target: string | undefined, overTarget = false): number {
  const pf = loadPlan(ctx);
  // #12096: o horizontal também (`--seq youtube`), com a mesma recusa de prévia mais velha que o build.
  const [plan] = pickPlans(pf.plans, target ?? "outras-redes", false, true);
  // #12694: o mesmo gate da prévia (uma prévia velha, de antes do gate, não é revisada).
  if (verticalDurationGateBlocks(plan, pf.source.fps, loadBlocks(ctx).file.verticalTargetS, overTarget)) return 1;
  printCorteHook(ctx, plan.spec);
  const preview = join(ctx.outDir, previewFileName(ctx.edition, sequenceKey(plan.spec)));
  if (!existsSync(preview)) throw new Error(`prévia ausente: ${preview} (rode preview)`);
  if (mtime(preview) < sequenceBuiltAt(pf, sequenceKey(plan.spec), mtime(f(ctx, "plan.json")))) throw new Error(`${preview} é mais velha que o build de ${plan.spec.name} no plan.json: rode preview de novo`);
  mkdirSync(ctx.workDir, { recursive: true });
  const wav = join(ctx.workDir, `review-${sequenceKey(plan.spec)}.wav`);
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", preview, "-ac", "1", "-ar", "16000", wav]);
  const trPath = f(ctx, `review-${sequenceKey(plan.spec)}.transcript.json`);
  transcribeWithPython(ctx, wav, trPath, { vad: false });
  const durationS = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", preview]).stdout.trim());
  if (!Number.isFinite(durationS) || durationS <= 0) throw new Error(`duração da prévia ilegível no ffprobe (${preview})`);
  const allWords = reviewTranscriptWords(readJson<Transcript>(trPath, "transcrição da prévia"));
  const allSilences = parseSilenceDetect(
    run("ffmpeg", ["-hide_banner", "-nostats", "-i", preview, "-vn", "-af", REVIEW_SILENCE_FILTER, "-f", "null", "-"]).stderr,
    durationS,
  );
  // #12571: o card de CTA do fim (sem fala) fica fora da revisão da fala: os achados medem só a montagem.
  const scope = reviewCardScope({ durationS, montageS: plan.durationFrames / pf.source.fps, cardS: (pf.xmlAssets?.[sequenceKey(plan.spec)]?.ctaCard?.frames ?? 0) / pf.source.fps, words: allWords, silences: allSilences });
  for (const w of scope.warnings) console.error(`[aviso] ${w}`);
  const words = scope.words;
  const previewSilences = scope.silences;
  const speechS = scope.speechS;
  const audioEndS = audioEndFromSilences(previewSilences, speechS);
  // #12561: ritmo, portado do review do edicao-video: pausa acima de 0,3 s entre falas = respiro sobrando (apertar o corte).
  const pauses = longPauses(previewSilences, cutPoints(plan, pf.source.fps), speechS);
  console.error(`[video-montagem] ritmo de ${plan.spec.name}: ${pauses.length ? pauses.map((x) => `${clockTime(x.at)} (${x.durationS.toFixed(2)} s, ${x.atCut ? "no corte" : "dentro da fala"})`).join("; ") : "nenhuma pausa acima de 0,3 s"} (#12561)`);
  // Cada achado leva também o tempo no BRUTO (#11500): é lá que o corte se corrige.
  // #12711: palavra esticada sobre fala (tomada repetida que o Whisper colapsou), sem depender do roteiro.
  const reviewed = [...reviewPreview({ words, audioEndS, script: plan.script, cuts: cutPoints(plan, pf.source.fps), durationS: speechS, aliases: loadVocab().aliases }), ...stretchedWordFindings(words, previewSilences)];
  const findings = reviewed.map((x) => ({
    ...x,
    srcAt: exportTimeToRaw(x.at, plan, pf.source.fps),
  }));
  const highBandWarnings = pf.cutRefine?.highBandWarnings?.[sequenceKey(plan.spec)]
    ?? ["build sem verificação de banda alta: rode build com o bruto disponível (#11940)"];
  for (const warning of highBandWarnings) console.error(`[aviso] ${warning}`);
  // #11939: a caneca na folha de frames da prévia; o cálculo diz em que escala ela não sai inteira.
  const framingWarn = framingWarningsByFile([plan], pf.source, pf.framing, pf.fileOverrides);
  const mugWarnings = framingWarn.mug;
  for (const warning of mugWarnings) console.error(`[aviso] ${warning}`);
  // #13414: clipe com a boca a mais de 2% do centro da vertical (e a boca estimada, sem medida do face).
  const mouthWarnings = framingWarn.mouth;
  for (const warning of mouthWarnings) console.error(`[aviso] ${warning}`);
  for (const w of framingWarn.mouthAssumed) console.error(`[premissa] ${w}`);
  const card = scope.cardS > 0 ? { cardS: scope.cardS, warnings: scope.warnings } : undefined;
  writeJson(f(ctx, `review-${sequenceKey(plan.spec)}.json`), { preview, durationS, findings, highBandWarnings, mugWarnings, mouthWarnings, pauses, ...(card ? { ctaCard: card } : {}) });
  console.log(JSON.stringify({ preview, durationS, findings, highBandWarnings, mugWarnings, mouthWarnings, pauses, ...(card ? { ctaCard: card } : {}) }, null, 2));
  return 0;
}

/**
 * Destino do `review-final`: `--seq` explícito ou o sufixo do nome do export.
 * Export de corte (`…_V1-soberana.mp4`) vai para a sequência com esse `corte`
 * no plano; sem ela, erro (nunca a vertical da edição, que tem outro roteiro).
 */
export function reviewFinalTarget(file: string, seq: string | undefined, specs: Array<Pick<SequenceSpec, "target" | "corte">> = []): VideoTarget {
  return reviewFinalSequence(file, seq, specs).target;
}

/**
 * O destino (formato esperado) e a identidade da sequência do export (#11900):
 * a identidade escolhe o plano e nomeia os arquivos (`review-final-{key}.md`),
 * então 2 cortes de mesmo destino não se sobrescrevem. `--seq` aceita o
 * destino ou o slug de um corte do plano.
 */
export function reviewFinalSequence(file: string, seq: string | undefined, specs: Array<Pick<SequenceSpec, "target" | "corte">> = []): { target: VideoTarget; key: SequenceKey } {
  if (seq !== undefined) {
    const byCorte = specs.find((s) => s.corte === seq);
    if (byCorte) return { target: byCorte.target, key: seq };
    const cortes = specs.flatMap((s) => (s.corte ? [s.corte] : []));
    if (!(VIDEO_TARGETS as readonly string[]).includes(seq)) throw new Error(`--seq deve ser ${[...VIDEO_TARGETS, ...cortes].join(", ")} (veio ${seq})`);
    return { target: seq as VideoTarget, key: seq };
  }
  const previewFormat = /^\d{6} - previa (horizontal|vertical)\.mp4$/.exec(basename(file));
  if (previewFormat) {
    const target = previewFormat[1] === "horizontal" ? "youtube" : "outras-redes";
    return { target, key: target };
  }
  const corte = corteSuffixOf(basename(file));
  if (corte) {
    const hit = specs.find((s) => s.corte === corte);
    if (!hit) throw new Error(`${basename(file)} é o corte "${corte}", sem sequência com esse corte no plan.json: rode build ou passe --seq`);
    return { target: hit.target, key: corte };
  }
  const t = exportTarget(basename(file));
  if (!t) throw new Error(`destino não reconhecido no nome ${basename(file)} (horizontal_V{n} ou _Youtube_, _Vertical_, _Instagram_, _Outras redes_): passe --seq`);
  return { target: t, key: t };
}

/**
 * #13536: o `checkText` do `review-final` num export com trecho inserido
 * (formato react). A fala do vídeo citado não é do roteiro: as palavras dentro
 * do trecho saem, e o resto volta ao tempo do plano (sem o deslocamento) antes
 * de comparar; o tempo de cada achado volta ao do export. Sem trecho, o
 * `checkText` de sempre.
 */
export function checkTextWithTrechos(input: Parameters<typeof checkText>[0], trechos: readonly TrechoInseridoClip[]): FinalReviewFinding[] {
  const spans = trechoExportSpans(trechos, input.fps);
  if (!spans.length) return checkText(input);
  const total = spans.reduce((k, s) => k + (s.end - s.start), 0);
  const words = wordsSemTrechos(input.words, spans).words;
  const unripple = (t: number) => {
    const inside = spans.find((s) => t >= s.start && t < s.end);
    const at = inside ? inside.start : t;
    return at - spans.reduce((k, s) => k + (s.end <= at ? s.end - s.start : 0), 0);
  };
  const found = checkText({
    ...input,
    words,
    durationS: Math.max(0, input.durationS - total),
    ...(input.audioEndS !== undefined ? { audioEndS: unripple(input.audioEndS) } : {}),
    ...(input.silences ? { silences: intervalsSemTrechos(input.silences, spans) } : {}),
  });
  return found.map((f) => (f.at === null ? f : { ...f, at: planTimeToExport(f.at, trechos, input.fps) }));
}

function cmdReviewFinal(ctx: Ctx, file: string | undefined, seq: string | undefined, withText: boolean): number {
  if (!file) throw new Error("review-final exige --file PATH (o export do Premiere)");
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`export não encontrado: ${path}`);
  let planSpecs: SequenceSpec[] = [];
  try {
    planSpecs = loadPlan(ctx).plans.map((p) => p.spec);
  } catch {
    // sem plano válido: o aviso sai abaixo, onde o plano é lido de novo
  }
  const { target, key } = reviewFinalSequence(path, seq, planSpecs);
  const findings: FinalReviewFinding[] = [];

  const probeJson = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]).stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>;
    format?: { duration?: string };
  };
  const v = probeJson.streams?.find((s) => s.codec_type === "video");
  if (!v?.width || !v.height || !v.r_frame_rate) throw new Error(`ffprobe sem stream de vídeo em ${path}`);
  const probe = { width: v.width, height: v.height, fps: parseFrameRate(v.r_frame_rate), durationS: Number(probeJson.format?.duration) };
  if (!Number.isFinite(probe.durationS) || probe.durationS <= 0) throw new Error(`duração ilegível no ffprobe (${path})`);

  // Plano da montagem, quando existe e está em dia: fps esperado, roteiro e tempo no bruto.
  let plan: SequencePlan | null = null;
  let planFps: number | null = null;
  // #13536: os trechos inseridos que o XML desta sequência levou (o export os tem; o plano não).
  let trechosXml: TrechoInseridoClip[] = [];
  try {
    const pf = loadPlan(ctx);
    // Pela identidade; sem ela, o único plano do destino (`--seq instagram` num blocks.json de 1 extra).
    const sameTarget = pf.plans.filter((p) => p.spec.target === target);
    plan = pf.plans.find((p) => sequenceKey(p.spec) === key) ?? (sameTarget.length === 1 ? sameTarget[0] : null);
    planFps = pf.source.audioOnly ? null : pf.source.fps;
    if (plan) trechosXml = pf.xmlAssets?.[sequenceKey(plan.spec)]?.trechosInseridos ?? [];
    if (!plan) console.error(`[aviso] plan.json sem a sequência ${key}: texto não comparado com o roteiro`);
  } catch (e) {
    console.error(`[aviso] sem plan.json válido (${(e as Error).message}): texto não comparado, sem tempo no bruto`);
  }

  const crop = parseCropdetect(
    run("ffmpeg", ["-hide_banner", "-nostats", "-i", path, "-vf", "fps=1,cropdetect=limit=24:round=2:reset=0", "-an", "-f", "null", "-"]).stderr,
  );
  findings.push(...checkFormat(probe, target, { crop, expectedFps: planFps }));

  // #13368: trecho preto e quadro congelado, fora da vinheta e do card de CTA.
  const detectLog = run("ffmpeg", ["-hide_banner", "-nostats", "-i", path, "-vf", BLACK_FREEZE_FILTER, "-an", "-f", "null", "-"]).stderr;
  const blackFreeze = {
    black: parseBlackdetect(detectLog),
    freeze: parseFreezedetect(detectLog, probe.durationS),
    windows: blackFreezeWindows({ durationS: probe.durationS, ctaCardS: configCtaCardS(), plan, fps: planFps, vinhetaS: loadVinheta({ warn: () => {} })?.durationS ?? null }),
  };
  if (!plan || !planFps) console.error(`[aviso] sem plano da sequência: preto/congelado nos primeiros ${OPENING_FALLBACK_S} s sai como achado de baixa certeza (pode ser a vinheta) e o card de CTA presumido no fim fica fora (#13368, #13440)`);
  findings.push(...checkBlackFreeze({ black: blackFreeze.black, freeze: blackFreeze.freeze, exclude: blackFreeze.windows, plan, fps: planFps }));

  const loud = parseLoudnormJson(
    run("ffmpeg", ["-hide_banner", "-nostats", "-i", path, "-vn", "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"]).stderr,
  );
  findings.push(...checkLoudness(loud));

  const peaks = parsePeakWindows(
    run("ffmpeg", [
      "-hide_banner", "-nostats", "-v", "error", "-i", path, "-vn", "-ac", "1",
      "-af", "aresample=48000,asetnsamples=n=480:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.Peak_level:file=-",
      "-f", "null", "-",
    ]).stdout,
  );
  const clicks = detectClicks(peaks);

  const sil = parseSilenceDetect(
    run("ffmpeg", ["-hide_banner", "-nostats", "-i", path, "-vn", "-af", REVIEW_SILENCE_FILTER, "-f", "null", "-"]).stderr,
    probe.durationS,
  );
  findings.push(...dedupeAudioFindings(clicks, detectFragments(sil)));

  if (withText && plan) {
    findings.push(...checkTextWithTrechos({ audioEndS: audioEndFromSilences(sil, probe.durationS), words: transcribeExport(ctx, path, key, true), plan, fps: planFps ?? 30, durationS: probe.durationS, aliases: loadVocab().aliases, silences: sil }, trechosXml));
  }

  const table = finalReviewTable(findings);
  mkdirSync(ctx.stateDir, { recursive: true });
  writeFileAtomic(f(ctx, `review-final-${key}.md`), `# Revisão do export: ${basename(path)}\n\n${table}`);
  writeJson(f(ctx, `review-final-${key}.json`), { file: path, target, sequence: key, probe, crop, blackFreeze, loudness: loud, findings });
  process.stdout.write(table);
  console.error(`[video-montagem] review-final: ${findings.length} achado(s) em ${basename(path)} (sequência ${key}, destino ${target}); tabela em ${f(ctx, `review-final-${key}.md`)}`);
  return 0;
}

// ── Vídeo avulso, fora da montagem (#12935) ──────────────────────────────

/**
 * Onde o `legendar` grava (#12935): ao lado do vídeo, ou no `--out-dir`
 * explícito. `{base}.srt` e `{base} - legendado.mp4`; nunca sobrescreve o
 * próprio vídeo. Puro.
 */
export function legendarOutputPaths(videoPath: string, outDir?: string): { srt: string; burned: string } {
  const dir = outDir ? resolve(outDir) : dirname(resolve(videoPath));
  const base = basename(videoPath).replace(/\.[^.]+$/, "");
  return { srt: join(dir, `${base}.srt`), burned: join(dir, `${base} - legendado.mp4`) };
}

/**
 * Orientação do vídeo pelo ffprobe, com a rotação do celular (`rotate` 90/270
 * troca largura e altura): decide o estilo da legenda queimada. Puro.
 */
export function legendarIsVertical(stream: { width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: Array<{ rotation?: number }> }): boolean {
  const w = stream.width ?? 0;
  const h = stream.height ?? 0;
  const rot = Number(stream.side_data_list?.find((x) => typeof x.rotation === "number")?.rotation ?? stream.tags?.rotate ?? 0);
  const quarter = Math.abs(Math.round(rot)) % 180 === 90;
  return quarter ? w > h : h > w;
}

/**
 * `legendar AAMMDD --video ARQ [--no-burn] [--out-dir DIR]` (#12935): legenda
 * um vídeo avulso, que não passou pela montagem (sem `plan.json`, sem
 * roteiro). Transcreve SEM VAD (o VAD da 261112 descartou 6 s de fala real),
 * aplica o vocabulário do projeto e a grafia dos nomes do `02-reviewed.md` da
 * edição (`properNounLexicon`, quando existe), grava o SRT e queima a legenda
 * com o estilo da prévia (vertical ou horizontal pela orientação). Fecha com a
 * autorrevisão pelo áudio (`captionCoverageFindings`): legenda longa demais e
 * fala sem legenda saem como `[aviso]`, para conferir antes de entregar.
 */
function cmdLegendar(ctx: Ctx, video: string, opts: { burn: boolean; outDir?: string }): number {
  const path = resolve(video);
  if (!existsSync(path)) throw new Error(`vídeo não encontrado: ${path}`);
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]).stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: Array<{ rotation?: number }> }>;
    format?: { duration?: string };
  };
  const v = probe.streams?.find((x) => x.codec_type === "video");
  if (!v) throw new Error(`ffprobe sem stream de vídeo em ${path}`);
  const durationS = Number(probe.format?.duration);
  if (!Number.isFinite(durationS) || durationS <= 0) throw new Error(`duração ilegível no ffprobe (${path})`);
  const out = legendarOutputPaths(path, opts.outDir);
  mkdirSync(ctx.workDir, { recursive: true });
  mkdirSync(dirname(out.srt), { recursive: true });
  const tag = basename(path).replace(/[^\w.-]+/g, "_");
  const wav = join(ctx.workDir, `legendar-${tag}.wav`);
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000", wav]);
  const trPath = join(ctx.workDir, `legendar-${tag}.transcript.json`);
  transcribeWithPython(ctx, wav, trPath, { vad: false });
  const heard = nonEmptyWords(trPath, "transcrição do vídeo");
  const vocab = loadVocab();
  const vocabWords = applyVocabularyToWords(heard, vocab.rules, undefined, (w) => console.error(`[aviso] ${w}`));
  const reviewedPath = join(editionDirFor(ctx.edition), "02-reviewed.md");
  const reference = existsSync(reviewedPath) ? readFileSync(reviewedPath, "utf8") : null;
  if (!reference) console.error(`[aviso] sem ${reviewedPath}: os nomes próprios ficam com a grafia que o Whisper ouviu`);
  const { words, changes } = applyProperNounLexicon(vocabWords, reference ? properNounLexicon(reference) : new Map<string, string>(), vocab.aliases);
  const summary = summarizeLexiconChanges(changes);
  if (summary.length) console.error(`[premissa] grafia corrigida: ${summary.join("; ")}`);
  const cues = segmentCues(words);
  const srt = cuesToSrt(cues);
  writeFileAtomic(out.srt, srt);
  console.error(`[video-montagem] legenda (texto ouvido, sem VAD, #12935): ${out.srt}`);

  let burned: string | null = null;
  if (opts.burn) {
    const vertical = legendarIsVertical(v);
    copyFileSync(out.srt, join(ctx.workDir, "legendar-leg.srt"));
    const tmp = join(ctx.workDir, `legendar-${tag}.burned.mp4`);
    run("ffmpeg", [
      "-y", "-v", "error", "-i", path,
      "-vf", `subtitles=legendar-leg.srt:force_style='${vertical ? PREVIEW_SUBTITLE_STYLE : PREVIEW_SUBTITLE_STYLE_HORIZONTAL}'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", tmp,
    ], { cwd: ctx.workDir });
    copyFileSync(tmp, out.burned);
    burned = out.burned;
    console.error(`[video-montagem] legenda queimada (estilo ${vertical ? "vertical" : "horizontal"}): ${burned}`);
  }

  // Autorrevisão pelo áudio: legenda longa demais e fala sem legenda.
  const silencesFound = parseSilenceDetect(run("ffmpeg", ["-hide_banner", "-nostats", "-i", wav, "-af", REVIEW_SILENCE_FILTER, "-f", "null", "-"]).stderr, durationS);
  const findings = captionCoverageFindings({ cues: cueTimings(cues), silences: silencesFound, durationS });
  for (const fnd of findings) console.error(`[aviso] ${fnd.line}: conferir no vídeo (#12935)`);
  if (!findings.length) console.error("[ok] autorrevisão: nenhuma legenda longa demais nem fala sem legenda");
  console.log(JSON.stringify({ video: path, srt: out.srt, burned, cues: cues.length, lexicon: summary, findings: findings.map((x) => x.line) }, null, 2));
  return 0;
}

// ── Drive pela API, fora do Neo (#11639, #11640, #11641) ─────────────────

/** Registro do bruto baixado pela API (no state dir): id, nome no Drive e o caminho do cache. */
export const BRUTO_DRIVE_FILE = "bruto.drive.json";
/** O que já subiu para a pasta da edição (nome → id/link) e o que ficou pendente. */
export const DRIVE_UPLOADS_FILE = "drive-uploads.json";
/** Saída quando o comando deu certo e só o upload para o Drive falhou (as saídas estão no out dir). */
export const EXIT_UPLOAD_FAILED = 4;

export const SUBCOMMANDS = ["transcribe", "inventory", "decupagem", "blocks", "retranscribe", "frame", "face", "face-compare", "gaze", "roteiro", "fact-check-input", "fact-check-merge", "build", "verify-xml", "srt", "preview", "review", "review-final", "upload", "legendar"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];
/** Subcomandos cujas saídas sobem para a pasta da edição no modo API. */
export const DRIVE_UPLOAD_COMMANDS: readonly Subcommand[] = ["build", "srt", "preview"];
/** Subcomandos que podem ir ao Drive no modo API (os outros só leem o state dir e o work dir). */
const DRIVE_COMMANDS: ReadonlySet<Subcommand> = new Set<Subcommand>(["transcribe", "frame", "preview", "review-final", "upload", ...DRIVE_UPLOAD_COMMANDS]);
const isSubcommand = (c: string): c is Subcommand => (SUBCOMMANDS as readonly string[]).includes(c);

export interface DriveSession {
  deps: MontageDriveDeps;
  edition: string;
  cacheDir: string;
  /** Raiz YouTube, também usada pela pasta compartilhada _marca/. */
  rootFolderId?: () => string;
  /** A pasta `{AAMMDD}/` no Drive (resolvida na 1ª chamada). */
  folder(): Promise<DriveEntry>;
}

/** `rootFolderId` é lido só quando algum passo vai mesmo à rede (frame com o bruto em cache não lê o config). */
export function makeDriveSession(edition: string, cacheDir: string, deps: MontageDriveDeps, rootFolderId: () => string): DriveSession {
  let memo: Promise<DriveEntry> | null = null;
  return { deps, edition, cacheDir, rootFolderId, folder: () => (memo ??= Promise.resolve().then(() => findEditionFolder(deps, rootFolderId(), edition))) };
}

function configRootFolderId(flag: string | undefined): () => string {
  return () => {
    if (flag?.trim()) return flag.trim();
    const id = youtubeFolderIdFrom(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")));
    if (!id) throw new Error("modo API do Drive sem pasta de vídeo: preencha publishing.youtube.drive_folder_id no platform.config.json ou passe --folder-id");
    return id;
  };
}

const log = (line: string) => console.error(line);

/**
 * transcribe sem --source no modo API: escolhe o bruto na pasta da edição, baixa para o cache e registra a procedência (#11639).
 * #11653: antes do download, `transcribePrecheck` — conflito com o `source.json` lança sem baixar nem tocar no
 * `bruto.drive.json`; transcrição já pronta para este bruto devolve o caminho do cache sem baixar.
 */
export async function fetchBruto(
  ctx: Pick<Ctx, "stateDir" | "edition"> & Partial<Pick<Ctx, "workDir" | "force">>,
  d: DriveSession,
  opts: { fromAudio?: string } = {},
): Promise<string> {
  const folder = await d.folder();
  const raw = pickDriveBruto(await listChildren(d.deps, folder.id));
  if (!raw) throw new Error(`nenhum bruto (.mp4/.mov, ou áudio .m4a/.mp3/.wav) solto na pasta ${d.edition}/ do Drive (${folder.id}); passe --source`);
  assertSingleRawVideo(raw);
  if (raw.audioOnly) log(`[premissa] nenhum vídeo solto em ${d.edition}/ no Drive; usando o áudio ${raw.pick.name} (modo áudio, #11552)`);
  if (raw.candidates.length > 1) {
    log(`[aviso] ${raw.candidates.length} candidatos a bruto no Drive; usando o maior (${raw.pick.name}, id ${raw.pick.id}). Outro: --source. Candidatos: ${raw.candidates.map((c) => `${c.name} (${((parseDriveSize(c.size) ?? 0) / 1e9).toFixed(2)} GB)`).join(", ")}`);
  }
  if (raw.duplicateNames.length) log(`[aviso] nomes repetidos entre os candidatos no Drive (${raw.duplicateNames.join(", ")}): renomeie para não confundir o cache`);
  const brutoDir = join(d.cacheDir, "bruto");
  // Mesmo caminho que o ensureCachedFile grava: `{cache}/bruto/{nome}`.
  const target = join(brutoDir, raw.pick.name);
  const pre = transcribePrecheck(ctx, target, opts.fromAudio);
  if (pre.action === "conflict") throw new Error(pre.message);
  if (pre.action === "ready") {
    log(`[drive] transcrição de ${raw.pick.name} já pronta (source.json, áudio, loudness e transcript.json): nada a baixar; --force refaz`);
    return target;
  }
  const got = await ensureCachedFile(d.deps, raw.pick, brutoDir, log);
  const info: BrutoDriveInfo = {
    edition: ctx.edition,
    id: raw.pick.id,
    name: raw.pick.name,
    size: parseDriveSize(raw.pick.size) ?? got.bytes,
    modifiedTime: raw.pick.modifiedTime ?? null,
    folderId: folder.id,
    localPath: toPosix(got.localPath),
  };
  writeJson(f(ctx, BRUTO_DRIVE_FILE), info);
  return got.localPath;
}

function readBrutoDrive(ctx: Pick<Ctx, "stateDir" | "edition">): BrutoDriveInfo | null {
  const p = f(ctx, BRUTO_DRIVE_FILE);
  if (!existsSync(p)) return null;
  const info = readJson<BrutoDriveInfo>(p, BRUTO_DRIVE_FILE);
  return info.edition === undefined || info.edition === ctx.edition ? info : null;
}

/** Valida a procedência por segmentos e retorna o destino no host atual. */
export function brutoCacheTarget(cacheDir: string, name: string, localPath: string): string {
  // O nome do Drive é um único segmento, independentemente do host.
  if (!name || name === "." || name === ".." || posix.isAbsolute(name) || win32.isAbsolute(name) || /[\\/:]/.test(name)) {
    throw new Error(`nome de bruto inválido: ${name}`);
  }
  const target = join(cacheDir, "bruto", name);
  const normalized = (p: string) => posix.normalize(toPosix(p));
  if (toPosix(localPath).split("/").includes("..") || normalized(localPath) !== normalized(target)) {
    throw new Error(`bruto registrado no cache ${localPath}, fora do cache desta máquina (${cacheDir}): rode transcribe --force aqui para baixar e transcrever de novo`);
  }
  return target;
}

/**
 * frame/preview no modo API: o bruto do source.json sumiu do cache (limpeza,
 * reboot) → confere no Drive se é o mesmo arquivo do transcribe e baixa de
 * novo. Bruto trocado no Drive desde o transcribe é erro (a transcrição e os
 * cortes seriam de outro vídeo).
 */
export async function ensureBrutoLocal(ctx: Pick<Ctx, "stateDir" | "edition">, d: DriveSession, opts: { audioCleanBuild?: boolean } = {}): Promise<void> {
  const path = f(ctx, "source.json");
  if (!existsSync(path)) return; // o comando dá o erro de sempre ("rode transcribe")
  const source = checkedSource(readJson<SourceInfo>(path, "source.json"));
  if (source.files?.length) {
    const missing = localBrutoMissing(ctx);
    if (missing) throw new Error(missing);
    return;
  }
  if (existsSync(source.path)) return;
  const info = readBrutoDrive(ctx);
  if (!info) {
    log(`[aviso] bruto ${source.path} ausente e sem ${BRUTO_DRIVE_FILE}: não veio do Drive por este script, nada a baixar`);
    return;
  }
  // #12564: os dois lados normalizados: bruto.drive.json com `\` (gravado antes do toPosix, ou à mão) é o mesmo caminho.
  if (toPosix(info.localPath) !== toPosix(source.path)) {
    throw new Error(`source.json aponta ${source.path}, mas ${BRUTO_DRIVE_FILE} registrou ${info.localPath} (o --cache-dir mudou?): rode transcribe de novo`);
  }
  const target = brutoCacheTarget(d.cacheDir, info.name, info.localPath);
  const meta = await fetchFileMeta(d.deps, info.id);
  const metaSize = parseDriveSize(meta.size);
  if ((info.size !== null && metaSize !== null && metaSize !== info.size) || (info.modifiedTime && meta.modifiedTime && meta.modifiedTime !== info.modifiedTime)) {
    throw new Error(`o bruto ${info.name} mudou no Drive desde o transcribe (tamanho/modifiedTime): rode transcribe --force e revise a transcrição e os cortes antes de refazer o build.` +
      (opts.audioCleanBuild ? ` Build interrompido para não tratar áudio de outro bruto. Para gerar sem faixa tratada, use build ${ctx.edition} --no-audio-clean (áudio cru; confira a correspondência do bruto com a transcrição e os cortes no Premiere).` : ""));
  }
  const size = metaSize ?? info.size;
  const estimate = size === null
    ? "tamanho e tempo de download desconhecidos (Drive sem tamanho)"
    : `${(size / 1e9).toFixed(2)} GB (${size} bytes); tempo estimado de download: ~${Math.max(1, Math.ceil(size / 2_000_000 / 60))} min a 2 MB/s (depende da conexão)`;
  log(`[drive] bruto ausente do cache (${source.path}); baixando o arquivo inteiro do Drive: ${estimate}`);
  if (opts.audioCleanBuild) log(`[aviso] o build precisa do bruto inteiro para tratar o áudio; para evitar o download, interrompa e use build ${ctx.edition} --no-audio-clean (XML e prévia com áudio cru; aplicar Enhance no Premiere)`);
  // Pelo nome registrado: um rename no Drive não pode mudar o caminho que o source.json aponta.
  await ensureCachedFile(d.deps, { ...meta, name: info.name }, dirname(target), log);
}

/**
 * Modo local (o Neo) com um source.json gravado pelo modo API de outra máquina
 * (o state dir sincroniza pelo OneDrive): o caminho é o cache do 300. Mensagem
 * clara em vez do erro cru do ffmpeg.
 */
export function localBrutoMissing(ctx: Pick<Ctx, "stateDir" | "edition">): string | null {
  const path = f(ctx, "source.json");
  if (!existsSync(path)) return null;
  const source = checkedSource(readJson<SourceInfo>(path, "source.json"));
  // #12559: bruto em vários arquivos: todos precisam estar nesta máquina (o modo API baixa um bruto só).
  if (source.files?.length) {
    const gone = source.files.filter((x) => !existsSync(x.path)).map((x) => x.path);
    return gone.length ? `arquivo(s) do bruto em vários arquivos ausente(s) nesta máquina: ${gone.join(", ")} (#12559: rode no Neo, com a pasta de vídeo em I:)` : null;
  }
  if (existsSync(source.path)) return null;
  const info = readBrutoDrive(ctx);
  const origin = info && toPosix(info.localPath) === toPosix(source.path) ? ` (o cache do modo API de outra máquina; o bruto no Drive é ${info.name})` : "";
  return `bruto do source.json não existe nesta máquina: ${source.path}${origin}. Rode transcribe --force aqui (com o bruto em I:, ou --from-drive para baixá-lo pela API)`;
}

/** Um arquivo pelo nome na pasta da edição (`--from-audio`) ou em `Final/` (`review-final --file`), baixado para o cache. */
async function fetchNamed(d: DriveSession, given: string, where: "edition" | "final"): Promise<string> {
  const name = basename(toPosix(given));
  log(`[premissa] ${given} não existe nesta máquina; procurando ${name} em ${d.edition}/${where === "final" ? "Final/" : ""} no Drive`);
  const folder = await d.folder();
  const folders = where === "edition" ? [folder] : finalFolders(await listChildren(d.deps, folder.id, { foldersOnly: true }));
  if (folders.length === 0) throw new Error(`pasta Final/ não encontrada em ${d.edition}/ no Drive (procurando ${name})`);
  for (const dir of folders) {
    const found = await findByName(d.deps, dir.id, name);
    if (!found.file) continue;
    if (found.duplicates) log(`[aviso] ${found.duplicates + 1} arquivos "${name}" no Drive: usando o mais recente (${found.file.id})`);
    return (await ensureCachedFile(d.deps, found.file, join(d.cacheDir, where === "edition" ? "bruto" : "final"), log)).localPath;
  }
  throw new Error(`${name} não encontrado em ${d.edition}/${where === "final" ? "Final/" : ""} no Drive`);
}

/** A subpasta direta do out dir onde `path` está (`trechos`), ou `null` (solto no out dir, ou fora dele). */
export function outDirSubfolder(outDir: string | undefined, path: string): string | null {
  if (!outDir) return null;
  const segs = toPosix(relative(outDir, path)).split("/");
  return segs.length === 2 && segs[0] !== ".." && segs[0] !== "" && !isAbsolute(segs[0]) ? segs[0] : null;
}

/** `drive-uploads.json`: o que subiu (por nome) e o que ficou pendente de uma falha anterior. */
export interface DriveUploadRegistry {
  files: Record<string, { id: string; link: string | null; at: string; from: string }>;
  pending: string[];
  previewNamesNoticeShown?: boolean;
}

function readRegistry(path: string): DriveUploadRegistry {
  if (!existsSync(path)) return { files: {}, pending: [] };
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as Partial<DriveUploadRegistry>;
    return { files: r.files ?? {}, pending: Array.isArray(r.pending) ? r.pending : [], previewNamesNoticeShown: r.previewNamesNoticeShown === true };
  } catch (e) {
    log(`[aviso] ${path} ilegível (${(e as Error).message}): recomeçando o registro de uploads`);
    return { files: {}, pending: [] };
  }
}

/**
 * Sobe `paths` mais os pendentes de uma falha anterior (que ainda existam) e
 * registra em `drive-uploads.json`. Para no 1º erro: os que não subiram ficam
 * em `pending`, e a próxima execução de build/srt/preview (ou `upload`) os
 * tenta de novo mesmo sem mudança.
 */
export async function uploadAll(
  ctx: Pick<Ctx, "stateDir" | "edition"> & Partial<Pick<Ctx, "outDir">>,
  d: DriveSession,
  paths: string[],
  opts: { archiveOverwritten?: boolean; now?: () => Date } = {},
): Promise<{ uploaded: string[]; pending: string[]; error: string | null; fresh: ArchiveEntry[] }> {
  const regPath = f(ctx, DRIVE_UPLOADS_FILE);
  // #13334: um arquivo numa subpasta do out dir (`trechos/`) sobe para a subpasta de mesmo nome da edição.
  const subfolders = new Map<string, Promise<DriveEntry>>();
  const targetOf = async (folder: DriveEntry, path: string): Promise<{ folderId: string; prefix: string }> => {
    const sub = outDirSubfolder(ctx.outDir, path);
    if (!sub) return { folderId: folder.id, prefix: "" };
    let p = subfolders.get(sub);
    if (!p) subfolders.set(sub, (p = ensureChildFolder(d.deps, folder.id, sub)));
    return { folderId: (await p).id, prefix: `${sub}/` };
  };
  const reg = readRegistry(regPath);
  const queue = [...new Set([...reg.pending.filter((p) => existsSync(p)), ...paths])];
  const uploaded: string[] = [];
  // #13610: o que subiu para a RAIZ da edição, para o arquivamento não depender da busca do Drive (que atrasa).
  const fresh: ArchiveEntry[] = [];
  if (queue.length === 0) return { uploaded, pending: [], error: null, fresh };
  const save = (pending: string[]) => writeJson(regPath, { ...reg, pending });
  try {
    const folder = await d.folder();
    for (let i = 0; i < queue.length; i++) {
      const target = await targetOf(folder, queue[i]);
      // #13610: a prévia regravada não é atualizada no lugar: a nova é criada e, só depois de subir, a anterior vai para arquivo/.
      const name = basename(queue[i]);
      let previous: string[] = [];
      if (opts.archiveOverwritten && !target.prefix && isOverwriteArchivedName(name)) {
        try {
          previous = await rootIdsNamed(d.deps, target.folderId, name);
        } catch (e) {
          log(`[aviso] ${name}: prévia anterior não listada (${(e as Error).message}); a nova a substitui no lugar (#13610)`);
        }
      }
      const r = await uploadToFolder(d.deps, target.folderId, queue[i], log, { excludeIds: new Set(previous) });
      if (previous.length) {
        try {
          await archiveDriveIds(d.deps, target.folderId, name, previous.filter((id) => id !== r.id), { now: (opts.now ?? (() => new Date()))(), log, warn: (m) => log(`[aviso] ${m} (#13610)`) });
        } catch (e) {
          log(`[aviso] ${name} anterior não foi para arquivo/ (${(e as Error).message}); a nova já está na raiz, com o mesmo nome (#13610)`);
        }
      }
      if (!target.prefix) fresh.push({ name: r.name, id: r.id, modifiedMs: Date.now() });
      reg.files[`${target.prefix}${r.name}`] = { id: r.id, link: r.webViewLink, at: new Date().toISOString(), from: queue[i] };
      uploaded.push(queue[i]);
      if (!reg.previewNamesNoticeShown && [previewFileName(ctx.edition, "youtube"), previewFileName(ctx.edition, "outras-redes")].includes(r.name)) {
        // Preservar possíveis arquivos antigos: podem conter uma revisão do editor.
        log(`[aviso] #13208: prévias agora usam horizontal/vertical. Se existirem no Drive de ${ctx.edition}, as antigas "previa youtube.mp4", "previa outras-redes.mp4" ou "previa instagram.mp4" foram preservadas; use a prévia com o novo nome. Remoção manual após conferir. Aviso único por edição.`);
        reg.previewNamesNoticeShown = true;
      }
      save(queue.slice(i + 1));
      log(`[drive] ${r.updated ? "atualizado" : "enviado"} ${d.edition}/${target.prefix}${r.name}: ${r.webViewLink ?? r.id}`);
    }
    return { uploaded, pending: [], error: null, fresh };
  } catch (e) {
    const pending = queue.slice(uploaded.length);
    save(pending);
    return { uploaded, pending, error: (e as Error).message, fresh };
  }
}

/** Os comandos que gravam uma versão nova na pasta da edição (#13610): depois deles, a anterior vai para `arquivo/`. */
export const ARCHIVE_COMMANDS: readonly Subcommand[] = ["build", "srt", "preview", "upload"];

/** O out dir é a própria pasta da edição (o Neo, ou o modo local com raiz explícita). */
const outDirIsEditionFolder = (ctx: Pick<Ctx, "outDir" | "driveDir">) => resolve(ctx.outDir) === resolve(ctx.driveDir);

/**
 * #13610: depois do comando que deu certo, a versão anterior de cada arquivo da
 * raiz de `{AAMMDD}/` vai para `{AAMMDD}/arquivo/`: no Drive pela API (a sessão
 * de upload) e no disco quando o out dir é a pasta da edição. Fail-soft: falha
 * vira `[aviso]` e nunca muda o exit do comando.
 */
export async function archiveVersionsAfter(
  ctx: Pick<Ctx, "edition" | "outDir" | "driveDir" | "mode" | "noArchive"> & Partial<Pick<Ctx, "stateDir">>,
  up: DriveSession | null,
  fresh: ArchiveEntry[],
  warn: (m: string) => void = (m) => console.error(`[aviso] ${m}`),
): Promise<EditionArchiveResult[]> {
  if (ctx.noArchive) return [];
  const results: EditionArchiveResult[] = [];
  const report = (r: EditionArchiveResult, where: string) => {
    results.push(r);
    if (r.moves.length) console.error(`[arquivo] ${r.moves.length} versão(ões) anterior(es) de ${ctx.edition}/ em ${where}arquivo/ (#13610)`);
    for (const w of r.warnings) warn(`arquivo/: ${w} (#13610)`);
    if (r.error) warn(`arquivo/ de ${ctx.edition}/ parou no meio (${r.error}): ${r.moves.filter((m) => m.done).length} de ${r.moves.length} movido(s); o comando deu certo. Rode: npx tsx scripts/archive-video-versions.ts --edition ${ctx.edition} --apply (#13610)`);
  };
  const expectedXmls = ctx.stateDir ? plannedXmlFileNames({ stateDir: ctx.stateDir }) : [];
  if (up) {
    try {
      report(await archiveEditionDrive(up.deps, await up.folder(), { apply: true, fresh, log, expectedXmls }), "Drive: ");
    } catch (e) {
      warn(`versões anteriores de ${ctx.edition}/ não foram para arquivo/ no Drive (${(e as Error).message}); o comando deu certo. Rode: npx tsx scripts/archive-video-versions.ts --edition ${ctx.edition} --apply (#13610)`);
    }
  }
  if (ctx.mode === "local" && outDirIsEditionFolder(ctx) && existsSync(ctx.driveDir)) {
    try {
      report(archiveEditionLocal(ctx.driveDir, ctx.edition, { apply: true, log, expectedXmls }), "");
    } catch (e) {
      warn(`versões anteriores de ${ctx.driveDir} não foram para arquivo/ (${(e as Error).message}); o comando deu certo (#13610)`);
    }
  }
  return results;
}

async function cmdUpload(ctx: Ctx, d: DriveSession | null, file: string | undefined): Promise<number> {
  if (!file) throw new Error("upload exige --file PATH (ex.: o decupagem.md quando o conector do Docs falhar)");
  if (!d) throw new Error("upload é do modo API do Drive (o 300), ou do modo local com raiz explícita e OAuth (#13334); no Neo, copie o arquivo para a pasta da edição em I:/Meu Drive/diaria-studio-video (nunca na pasta antiga da vjpixel, #12578)");
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`arquivo não encontrado: ${path}`);
  const r = await uploadAll(ctx, d, [path], { archiveOverwritten: !ctx.noArchive });
  if (r.error) {
    console.error(`[erro] upload para o Drive falhou: ${r.error}. Pendentes: ${r.pending.join(", ")}`);
    return EXIT_UPLOAD_FAILED;
  }
  ctx.freshUploads = r.fresh;
  return 0;
}

/**
 * `--restore-conflict NOME[,NOME]` (#13404): só os arquivos nomeados (os que a
 * mensagem de "ausente" cita), nunca uma varredura do `stateDir`, que
 * ressuscitaria cópias velhas de arquivos que o pipeline apagou de propósito.
 * A cópia restaurada é a mesma que a mensagem mostra (`chooseConflictCopy`).
 * Original presente nunca é sobrescrito, empate de mtime não restaura, e as
 * cópias ficam no disco. A escolha é premissa, por isso o log. Nome inválido
 * (caminho, `..`) lança.
 */
export function restoreConflictCopies(stateDir: string, namesArg: string, fs?: ConflictCopyFs, log: (line: string) => void = (l) => console.error(l)): number {
  const names = namesArg.split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error("--restore-conflict exige o nome do arquivo (ex.: --restore-conflict blocks.json), o que a mensagem de ausente cita");
  const bad = names.filter((n) => n !== basename(n) || n.includes("/") || n.includes("\\") || n === "." || n === "..");
  if (bad.length) throw new Error(`--restore-conflict aceita só o nome do arquivo em ${stateDir}, sem caminho: ${bad.join(", ")}`);
  let restored = 0;
  for (const name of names) {
    const target = join(stateDir, name);
    const r = restoreFromConflictCopy(target, fs);
    if (r.status === "restored") {
      restored++;
      log(`[premissa] ${name} restaurado de ${basename(r.from)}, a cópia de conflito mais nova${r.others.length ? ` (ficaram no disco: ${r.others.map((p) => basename(p)).join(", ")})` : ""}; conferir antes de seguir (#13404)`);
    } else if (r.status === "present") log(`[aviso] --restore-conflict: ${name} existe, nada sobrescrito (#13404)`);
    else if (r.status === "no-copy") log(`[aviso] --restore-conflict: ${name} sem cópia de conflito em ${stateDir}, nada restaurado (#13404)`);
    else log(`[aviso] --restore-conflict: ${name} não restaurado: ${r.tied.map((p) => basename(p)).join(", ")} têm o mesmo horário e a escolha seria arbitrária; copiar à mão a certa (#13404)`);
  }
  return restored;
}

export async function main(argv = process.argv.slice(2), deps?: MontageDriveDeps): Promise<number> {
  const { values, flags, positional } = parseArgs(argv);
  const [cmd, edition] = positional;
  if (!cmd || !edition || flags.has("help")) {
    console.error(USAGE);
    return 2;
  }
  if (!/^\d{6}$/.test(edition)) {
    console.error(`video-montagem: AAMMDD inválido: ${edition}`);
    return 2;
  }
  if (!isSubcommand(cmd)) {
    console.error(`video-montagem: subcomando desconhecido: ${cmd}\n${USAGE}`);
    return 2;
  }
  const explicitRoot = values["drive-root"] ?? process.env.DIARIA_VIDEO_DRIVE_ROOT;
  const driveRoot = explicitRoot ?? DEFAULT_DRIVE_ROOT;
  // #12707: a raiz do Premiere (Mac) no lugar da do Neo em todo pathurl do XML.
  let premiere: ReturnType<typeof premiereRootFrom>;
  try {
    premiere = premiereRootFrom(values["premiere-root"], readPlatformConfigSafe());
  } catch (e) {
    console.error(`video-montagem: ${(e as Error).message}`);
    return 2;
  }
  const driveDir = join(driveRoot, edition);
  const mode = driveModeFor({
    driveRootExists: existsSync(driveRoot),
    fromDrive: flags.has("from-drive"),
    noDriveApi: flags.has("no-drive-api"),
    explicitRoot: explicitRoot !== undefined,
  });
  // #12365: só o modo API usa o cache. No Neo, uma DIARIA_VIDEO_CACHE_DIR apontando para diretório
  // inexistente (ou no disco do home) não para nada; no modo API, para aqui, antes de qualquer acesso ao Drive.
  const cacheDir = driveCacheDir(edition, values["cache-dir"], process.env.DIARIA_VIDEO_CACHE_DIR, homedir(), mode === "api" ? undefined : () => "ok");
  const py = resolveVideoPython({ flag: values["python"], env: process.env.DIARIA_VIDEO_PYTHON, platform: process.platform, home: homedir(), exists: existsSync });
  let trechoFontes: Record<string, string>;
  try {
    trechoFontes = parseTrechoFonteArg(values["trecho-fonte"]);
  } catch (e) {
    console.error(`video-montagem: ${(e as Error).message}`);
    return 2;
  }
  const ctx: Ctx = {
    trechoFontes,
    // #13437: o export do vídeo de origem é procurado na pasta de vídeo desta máquina (no modo API ela não existe aqui).
    trechoDriveRoot: existsSync(driveRoot) ? driveRoot : null,
    edition,
    stateDir: resolve(values["state-dir"] ?? join(editionDirFor(edition), "_internal", "video-montagem")),
    workDir: resolve(values["work-dir"] ?? workDirDefault(mode, cacheDir, tmpdir(), edition)),
    driveDir,
    // Modo API: as saídas ficam no cache local e sobem para a pasta da edição (#11640).
    outDir: resolve(values["out-dir"] ?? (mode === "api" ? join(cacheDir, "out") : driveDir)),
    python: py.python,
    force: flags.has("force"),
    retranscribe: flags.has("retranscribe"),
    mode,
    xmlMediaRoot: values["xml-media-root"],
    // A raiz explícita é a do Neo só no modo local; no modo API ela não existe aqui (#11653).
    driveRoot: mode === "local" ? explicitRoot : undefined,
    noArchive: flags.has("no-archive"),
    // A raiz de origem é a do Neo que o XML grava: a explícita do modo local, senão a padrão (a vinheta mora nela).
    ...(premiere.root ? { premierePaths: { from: mode === "local" && explicitRoot ? explicitRoot : DEFAULT_DRIVE_ROOT, to: premiere.root } } : {}),
  };
  // #13404: só com o pedido do editor; sem a flag, a mensagem de "ausente" aponta a cópia e o comando.
  activeStateDir = ctx.stateDir;
  if (flags.has("restore-conflict") || values["restore-conflict"] !== undefined) {
    try {
      restoreConflictCopies(ctx.stateDir, values["restore-conflict"] ?? "");
    } catch (e) {
      console.error(`video-montagem: ${(e as Error).message}`);
      return 2;
    }
  }
  const seq = values["seq"];
  if ((VIDEO_ONLY_COMMANDS as readonly string[]).includes(cmd)) {
    const stop = audioOnlyStop(ctx, cmd);
    if (stop !== null) return stop;
  }
  const driveDeps = (): MontageDriveDeps => deps ?? { driveFetch: (url, init) => gFetchRetry(url, init ?? {}), uploadFetch: (url, init) => gFetch(url, init ?? {}) };
  const d = mode === "api" && DRIVE_COMMANDS.has(cmd)
    ? makeDriveSession(edition, cacheDir, driveDeps(), configRootFolderId(values["folder-id"]))
    : null;
  if (mode === "api") console.error(`[video-montagem] modo API do Drive (${flags.has("from-drive") ? "--from-drive" : `sem ${driveRoot} nesta máquina`}, #11639); cache em ${cacheDir}`);
  // #13334: modo local com raiz explícita fora do Drive for desktop: as saídas sobem pela API (o disco não sincroniza).
  // O cache da sessão é só o da `_marca/` do modo API, que aqui não é usado (a vinheta vai para {raiz}/_marca/, #13308).
  if (mode === "local" && (DRIVE_UPLOAD_COMMANDS.includes(cmd) || cmd === "upload")) {
    const local = localDriveUploadFor({ mode, explicitRoot, noDriveApi: flags.has("no-drive-api"), credentials: googleCredentialsPresent() });
    if (local.enabled) {
      ctx.localDrive = makeDriveSession(edition, cacheDir, driveDeps(), configRootFolderId(values["folder-id"]));
      console.error(`[premissa] modo local com ${local.reason}: as saídas de ${cmd} sobem para a pasta ${edition}/ do Drive pela API, como no modo API; --no-drive-api desliga (#13334)`);
    } else if (explicitRoot !== undefined && DRIVE_UPLOAD_COMMANDS.includes(cmd)) {
      console.error(`[aviso] modo local com raiz explícita, mas as saídas NÃO sobem para o Drive (${local.reason}): suba à mão o que ${cmd} gravar em ${ctx.outDir} (#13334)`);
    }
  }
  const up = d ?? ctx.localDrive ?? null;
  const uploads = up && DRIVE_UPLOAD_COMMANDS.includes(cmd);
  // #13334: `trechos/` (o XML leve do build) sobe para a subpasta de mesmo nome da edição.
  // #13332: e as legendas do XML das verticais, em `legendas-vertical*/`.
  const snap = () => snapshotDirWithSubdirs(ctx.outDir, [TRECHOS.dirName, ...subtitleSubdirsIn(ctx.outDir)], (dir) => readdirSync(dir));
  const before = uploads ? snap() : null;
  // #13493: quanto o build espera os trechos do XML leve chegarem à nuvem (Drive for desktop); inválido para antes do build.
  const esperarNuvemS = cmd === "build" ? parseEsperarNuvemArg(values["esperar-nuvem"] ?? (flags.has("esperar-nuvem") ? "" : undefined), ESPERAR_NUVEM_DEFAULT_S) : 0;
  const code = await runCommand(ctx, cmd, values, flags, seq, d);
  // #13493: no Drive for desktop (sem upload pela API), o XML leve só é dado por pronto com os trechos na nuvem.
  if (cmd === "build" && code === 0 && !uploads && ctx.buildTrechos?.length) {
    const cloud = mode === "local" && !flags.has("no-drive-api") && googleCredentialsPresent()
      ? makeDriveSession(edition, cacheDir, driveDeps(), configRootFolderId(values["folder-id"]))
      : null;
    await reportTrechosNaNuvem(cloud, ctx.buildTrechos, esperarNuvemS, flags.has("no-drive-api") ? "--no-drive-api" : "sem data/.credentials.json (OAuth do projeto)");
  }
  let fresh: ArchiveEntry[] = [];
  if (before && up && code === 0) {
    const changed = changedFiles(before, snap()).map((n) => join(ctx.outDir, n));
    const r = await uploadAll(ctx, up, changed, { archiveOverwritten: !ctx.noArchive });
    fresh = r.fresh;
    if (r.error) {
      console.error(
        `[erro] ${cmd} terminou, mas o upload para o Drive falhou: ${r.error}. Subiram: ${r.uploaded.length ? r.uploaded.map((p) => basename(p)).join(", ") : "nenhum"}; ` +
          `pendentes (tentados de novo na próxima execução, ou: upload ${edition} --file ARQUIVO): ${r.pending.join(", ")}`,
      );
      return EXIT_UPLOAD_FAILED;
    }
    if (cmd === "build" && ctx.buildXmlFiles) await warnXmlFilesMissingInDrive(up, ctx.buildXmlFiles, ctx.mode === "local" ? (ctx.driveRoot ?? DEFAULT_DRIVE_ROOT) : DEFAULT_DRIVE_ROOT);
  }
  // #13610: a versão anterior de cada arquivo vai para {AAMMDD}/arquivo/ (fail-soft, nunca muda o exit).
  if (code === 0 && ARCHIVE_COMMANDS.includes(cmd)) await archiveVersionsAfter(ctx, up && (uploads || cmd === "upload") ? up : null, [...fresh, ...(ctx.freshUploads ?? [])]);
  return code;
}

/** #13332: as subpastas de legenda do XML que já existem no out dir (sobem para a subpasta de mesmo nome da edição). */
export function subtitleSubdirsIn(outDir: string): string[] {
  try {
    return readdirSync(outDir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^legendas-vertical(-|$)/u.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * #13334: no fim do build com upload, todo `pathurl` do XML (antes da troca pela
 * raiz do Mac) tem de existir no Drive, senão o Premiere abre com mídia
 * offline sem aviso (as telas H5/H7/H10b/H13d da 261117). Só avisa; falha da
 * conferência também é aviso, nunca muda o exit.
 */
export async function warnXmlFilesMissingInDrive(d: DriveSession, files: readonly string[], root: string, warn: (m: string) => void = (m) => console.error(`[aviso] ${m}`)): Promise<string[]> {
  const rels: string[] = [];
  const outside: string[] = [];
  for (const p of new Set(files)) {
    const rel = driveRelativePath(p, root);
    if (rel) rels.push(rel);
    else outside.push(p);
  }
  if (outside.length) warn(`${outside.length} caminho(s) do XML fora de ${root}, não conferido(s) no Drive: ${outside.join(", ")} (#13334)`);
  let missing: string[];
  try {
    const rootId = d.rootFolderId?.();
    if (!rootId) throw new Error("pasta raiz YouTube indisponível");
    missing = await missingInDrive(d.deps, rootId, rels);
  } catch (e) {
    warn(`conferência dos arquivos do XML no Drive falhou (${(e as Error).message}): confira à mão se a mídia abre online no Premiere (#13334)`);
    return [];
  }
  if (missing.length) warn(`${missing.length} arquivo(s) do XML ausente(s) no Drive (o Premiere abre com mídia offline): ${missing.join(", ")}; suba com upload ${d.edition} --file ARQUIVO (#13334)`);
  else console.error(`[drive] os ${rels.length} arquivo(s) do XML estão no Drive (#13334)`);
  return missing;
}

/** #13493: quanto o build espera, por padrão, os trechos do XML leve subirem pelo Drive for desktop (`--esperar-nuvem S`). */
export const ESPERAR_NUVEM_DEFAULT_S = 600;
const ESPERAR_NUVEM_POLL_S = 20;

/** #13493: os arquivos da subpasta `trechos/` da edição no Drive (nenhuma = vazio; duas = erro). */
async function listTrechosNaNuvem(d: DriveSession): Promise<DriveEntry[]> {
  const folder = await d.folder();
  const sub = await listChildren(d.deps, folder.id, { name: TRECHOS.dirName, foldersOnly: true });
  if (sub.length > 1) throw new Error(`${sub.length} pastas ${TRECHOS.dirName}/ na edição do Drive: junte ou renomeie`);
  return sub.length ? listChildren(d.deps, sub[0].id) : [];
}

/**
 * #13493: no fim do build com XML leve no Drive for desktop, o XML só é dado
 * por pronto quando cada trecho está na nuvem com o tamanho do disco (sem
 * `.part`): na 261118 o Premiere do Mac importou o XML com trechos ainda em
 * `.mov.part` sem fazer nada e sem erro. Espera até `timeoutS`; sem sessão do
 * Drive (sem credenciais, `--no-drive-api`), não confere e diz isso. Nunca muda
 * o exit: o resultado é a linha `[ok] XML leve pronto` ou o `[aviso] XML leve
 * AINDA NÃO pronto`. Devolve os pendentes (null = não conferido).
 */
export async function reportTrechosNaNuvem(
  d: DriveSession | null,
  trechos: readonly { name: string; size: number }[],
  timeoutS: number,
  noSessionReason: string,
  io: { list?: () => Promise<readonly { name: string; size?: string | number }[]>; sleep?: (ms: number) => Promise<void>; now?: () => number; log?: (line: string) => void } = {},
): Promise<string[] | null> {
  const log = io.log ?? ((m: string) => console.error(m));
  const dir = `${d?.edition ?? ""}${d ? "/" : ""}${TRECHOS.dirName}/`;
  if (!d && !io.list) {
    log(`[aviso] XML leve gravado, mas a subida dos ${trechos.length} trecho(s) para a nuvem NÃO foi conferida (${noSessionReason}): antes de importar no Mac, conferir que ${TRECHOS.dirName}/ tem os ${trechos.length} .mov e nenhum .part, ou o Premiere importa sem fazer nada e sem erro (#13493)`);
    return null;
  }
  const r = await esperarTrechosNaNuvem({ local: trechos, list: io.list ?? (() => listTrechosNaNuvem(d!)), timeoutS, pollS: ESPERAR_NUVEM_POLL_S, ...(io.sleep ? { sleep: io.sleep } : {}), ...(io.now ? { now: io.now } : {}), log });
  if (!r.pending.length && !r.error) {
    log(`[ok] XML leve pronto: os ${trechos.length} trecho(s) estão em ${dir} no Drive com o tamanho do disco; pode importar no Mac (#13493)`);
    return [];
  }
  if (r.error) {
    log(`[aviso] XML leve AINDA NÃO pronto: a conferência dos trechos no Drive falhou (${r.error}) depois de ${r.waitedS} s; antes de importar no Mac, conferir que ${dir} tem os ${trechos.length} .mov e nenhum .part (#13493)`);
    return null;
  }
  const fmt = (why: string, label: string) => {
    const ns = r.pending.filter((p) => p.why === why).map((p) => p.name);
    return ns.length ? `${label}: ${ns.join(", ")}` : null;
  };
  const detail = [fmt("ausente", "ausente(s)"), fmt("part", "só como .part"), fmt("tamanho", "com outro tamanho (subida pela metade)")].filter(Boolean).join("; ");
  log(`[aviso] XML leve AINDA NÃO pronto: ${r.pending.length} de ${trechos.length} trecho(s) não estão em ${dir} no Drive com o tamanho do disco depois de ${r.waitedS} s (${detail}). Não importar no Mac antes do Drive for desktop subir tudo (o Premiere importa sem fazer nada e sem erro); rodar o build de novo confere outra vez (os trechos são reaproveitados), ou --xml-bruto (#13493)`);
  return r.pending.map((p) => p.name);
}

async function runCommand(
  ctx: Ctx,
  cmd: Subcommand,
  values: Record<string, string | undefined>,
  flags: Set<string>,
  seq: string | undefined,
  d: DriveSession | null,
): Promise<number> {
  const needLocalBruto = async () => {
    if (d) return ensureBrutoLocal(ctx, d, { audioCleanBuild: cmd === "build" });
    const missing = localBrutoMissing(ctx);
    if (missing) throw new Error(missing);
  };
  switch (cmd) {
    case "transcribe": {
      if (flags.has("from-audio")) throw new Error('--from-audio exige o caminho do áudio separado (ex.: --from-audio "I:/…/Diaria comentada_Youtube.wav")');
      let audio = values["from-audio"];
      // #11639: no modo API, um --from-audio que não existe no disco é o nome do arquivo na pasta da edição.
      if (d && audio !== undefined && !existsSync(audio)) audio = await fetchNamed(d, audio, "edition");
      const fromAudio = audio !== undefined ? { audio, transcript: values["audio-transcript"] } : undefined;
      if (!fromAudio && values["audio-transcript"] !== undefined) throw new Error("--audio-transcript só vale com --from-audio");
      // #12559: `--source a,b` ou `--all` = bruto em vários arquivos (só com os arquivos locais).
      const all = flags.has("all");
      const order = parseFileOrderArg(values["ordem"]);
      const source = values["source"] ?? (d && !all ? await fetchBruto(ctx, d, { fromAudio: audio }) : undefined);
      return cmdTranscribe(ctx, source, parseSilenceDbArg(values["silence-db"] ?? (flags.has("silence-db") ? "" : undefined)), fromAudio, { all, order });
    }
    case "inventory":
      return cmdInventory(ctx, values["dir"], values["editions"], flags.has("listen"));
    case "verify-xml":
      return cmdVerifyXml(ctx, seq, !flags.has("no-transcribe"));
    case "face":
      await needLocalBruto();
      return cmdFace(ctx, flags.has("write"), flags.has("overwrite"), { all: flags.has("all"), oneFrame: flags.has("um-frame") });
    case "face-compare":
      await needLocalBruto();
      return cmdFaceCompare(ctx, values["mp-python"], values["mp-model"], flags.has("um-frame"));
    case "gaze":
      await needLocalBruto();
      return cmdGaze(ctx, seq);
    case "decupagem":
      return cmdDecupagem(ctx, parsePixelF0Arg(values["pixel-f0"]), !flags.has("no-retranscribe"), flags.has("espelho-ambiguo"));
    case "blocks":
      return cmdBlocks(ctx, flags.has("from-plan"), ctx.force, values["falas"]);
    case "frame": {
      await needLocalBruto();
      const code = cmdFrame(ctx, values["at"]);
      return code === 0 ? cmdFrameOrientations(ctx, values["at"]) : code;
    }
    case "retranscribe":
      return cmdRetranscribe(ctx, values["from"], values["to"], flags.has("sub"));
    case "roteiro": {
      const roteiroPath = f(ctx, "roteiro.md");
      try {
        return cmdRoteiro(ctx, !flags.has("no-short-word-check"));
      } catch (e) {
        // #13404: o roteiro.md anterior fica no disco; sem este aviso ele parece o atual.
        console.error(roteiroNotRewrittenNotice(roteiroPath, existsSync(roteiroPath) ? mtime(roteiroPath) : null));
        throw e;
      }
    }
    case "fact-check-input":
      return cmdFactCheckInput(ctx, flags.has("full"));
    case "fact-check-merge":
      return cmdFactCheckMerge(ctx);
    case "build":
      if (flags.has("xml-flop") || "xml-flop" in values) {
        console.error("[erro] --xml-flop foi removida: o Premiere ignora o filtro Flop no import (#11358). Aplicar Horizontal Flip à mão.");
        return 2;
      }
      {
        // #12104: o modo removido (`text`) falha aqui, antes de baixar o bruto.
        const titleMode = parseTitleModeArg(values["title-mode"] ?? (flags.has("title-mode") ? "" : undefined));
        // #13219/#13493: o limiar decide entre XML leve e o bruto; --xml-leve/--xml-bruto forçam. Folga inválida falha aqui, antes de baixar o bruto.
        const trechosOpt: TrechosBuildOption = { choice: parseXmlLeveChoice({ leve: flags.has("xml-leve"), bruto: flags.has("xml-bruto") }), folgaS: parseTrechosFolgaArg(values["trechos-folga"] ?? (flags.has("trechos-folga") ? "" : undefined)) };
        // #13234: motor da faixa tratada (ffmpeg padrão; deepfilternet até a escolha de ouvido). Inválido para aqui, antes do bruto.
        const denoise = resolveAudioDenoise({
          flag: values["audio-denoise"] ?? (flags.has("audio-denoise") ? "" : undefined),
          env: process.env.DIARIA_VIDEO_AUDIO_DENOISE,
          attenFlag: values["df-atten-db"] ?? (flags.has("df-atten-db") ? "" : undefined),
          attenEnv: process.env.DIARIA_VIDEO_DF_ATTEN_DB,
        });
        // #12209: a faixa tratada lê o bruto; no modo API ele pode ter saído do cache (o transcribe "pronto" não baixa).
        if (buildNeedsLocalBruto({ apiMode: d !== null, audioClean: !flags.has("no-audio-clean") })) await needLocalBruto();
        // #12089: limiares do detector de fala sobrepostos à mão (padrão: relativos ao bruto).
        const speechOpts: SpeechDetectOptions = {
          ...(values["speech-full-db"] !== undefined || flags.has("speech-full-db") ? { fullDb: parseSpeechDbArg("--speech-full-db", values["speech-full-db"] ?? "") } : {}),
          ...(values["speech-diff-db"] !== undefined || flags.has("speech-diff-db") ? { diffDb: parseSpeechDbArg("--speech-diff-db", values["speech-diff-db"] ?? "") } : {}),
          ...(flags.has("no-speech-voice") ? { voice: false } : {}),
        };
        return cmdBuild(ctx, flags.has("allow-missing"), !flags.has("no-audio-refine"), !flags.has("no-audio-gain"), titleMode, seq, !flags.has("no-speech-detect"), !flags.has("no-audio-clean"), d, speechOpts, denoise, trechosOpt);
      }
    case "srt": {
      if (flags.has("from-final")) throw new Error('--from-final exige o caminho do export (ex.: --from-final "I:/…/261103/Final/Diaria comentada_Youtube_261103.mp4")');
      let final = values["from-final"];
      if (final === undefined) {
        if (flags.has("heard-text")) throw new Error("--heard-text só vale com --from-final (a legenda pela fala do export, #12198)");
        if (flags.has("no-plan")) throw new Error("--no-plan só vale com --from-final (a legenda só pela fala do export, sem plan.json, #12429)");
        return cmdSrt(ctx, seq, flags.has("from-raw"));
      }
      if (flags.has("from-raw")) throw new Error("--from-final e --from-raw não se combinam: a legenda do export vem da fala do export");
      if (flags.has("no-plan")) {
        // #12429: horizontal anterior à montagem, sem plan.json; o texto é o ouvido (o --heard-text é implícito).
        if (seq !== undefined && seq !== "youtube") throw new Error(`--from-final só gera a legenda do horizontal (--seq youtube), veio --seq ${seq}`);
        checkNoPlanAgainstPlan(ctx);
        if (d && !existsSync(final)) final = await fetchNamed(d, final, "final");
        return cmdSrtFromFinalNoPlan(ctx, final);
      }
      // --seq e o plano antes do download: um plano sem o horizontal não baixa o export à toa.
      const plan = loadFromFinalPlan(ctx, seq);
      // Como no review-final (#11639): no modo API, o export é procurado pelo nome em Final/ da edição no Drive.
      if (d && !existsSync(final)) final = await fetchNamed(d, final, "final");
      return cmdSrtFromFinal(ctx, final, plan, flags.has("heard-text") ? "ouvido" : "roteiro");
    }
    case "preview":
      // #12694: o gate de duração roda antes de baixar o bruto.
      return cmdPreview(ctx, seq, d, flags.has("no-subs"), { overTarget: flags.has("over-target"), needLocalBruto });
    case "review":
      return cmdReview(ctx, seq, flags.has("over-target"));
    case "review-final": {
      let file = values["file"];
      // #11639: no modo API, o export é procurado pelo nome em Final/ da edição no Drive.
      if (d && file !== undefined && !existsSync(file)) file = await fetchNamed(d, file, "final");
      return cmdReviewFinal(ctx, file, seq, !flags.has("no-text"));
    }
    case "upload":
      return cmdUpload(ctx, d ?? ctx.localDrive ?? null, values["file"]);
    case "legendar": {
      if (flags.has("video")) throw new Error('legendar exige o caminho do vídeo (ex.: --video "I:/…/261112/20261112_200050.mp4")');
      const video = values["video"];
      if (video === undefined) throw new Error("legendar exige --video ARQUIVO (o vídeo avulso a legendar, #12935)");
      return cmdLegendar(ctx, video, { burn: !flags.has("no-burn"), outDir: values["out-dir"] });
    }
  }
}

/**
 * Entrada da linha de comando (#13103): carrega o `.env` do projeto ANTES do
 * `main` resolver qualquer caminho. Sem isso, `DIARIA_VIDEO_CACHE_DIR` (e
 * `DIARIA_VIDEO_DRIVE_ROOT`/`DIARIA_VIDEO_PYTHON`) só valiam quando já estavam
 * no ambiente do processo, e numa sessão comum o cache ia para
 * `~/.cache/diaria-video-montagem`, no disco do sistema. O `.env` nunca
 * sobrescreve o ambiente (`loadProjectEnv`). Os testes chamam `main` direto,
 * sem ler o `.env` da máquina; `envRoot` existe para o teste de regressão.
 */
export async function cliMain(argv = process.argv.slice(2), deps?: MontageDriveDeps, envRoot: string = ROOT): Promise<number> {
  loadProjectEnv(envRoot);
  return main(argv, deps);
}

if (isMainModule(import.meta.url)) {
  runCli(() => cliMain(), { onError: (e) => console.error("video-montagem:", e instanceof Error ? e.message : e) });
}
