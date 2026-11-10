/**
 * scripts/video-montagem.ts (#11208) — montagem do vídeo diário "diar.ia.br
 * comentada", do bruto no Drive até o ponto de partida no Premiere. Usado pela
 * skill `/diaria-video-montagem`; a lógica fica em
 * `scripts/lib/diaria/video-montage.ts` (pura, testada), este arquivo só roda
 * ffmpeg/ffprobe e o helper Python e lê/grava os arquivos.
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
 *   transcribe AAMMDD --source A,B,C [--ordem gravacao|dada] | --all
 *       (#12559) bruto em vários arquivos: uma linha do tempo na ordem de gravação
 *       (creation_time), `files[]` no `source.json`, áudio por arquivo concatenado em
 *       `bruto-audio-48k.wav`. Só com os arquivos locais (não no modo API).
 *   inventory AAMMDD [--dir PASTA] [--editions A,B] [--listen]
 *       (#12559) os vídeos da pasta na ordem de gravação e o papel proposto de cada um
 *       (mestre horizontal em partes, vertical nativa) e a edição pela fala (--listen).
 *   face AAMMDD [--write]  (#12560) rosto (OpenCV) em 3 frames por item -> framing do item
 *   gaze AAMMDD [--seq K]  (#12560) folha de olhar/expressão por clipe (`gaze-{seq}.jpg`)
 *   verify-xml AAMMDD [--seq K] [--no-transcribe]
 *       (#12561) lê o áudio do PRÓPRIO XML, mede as bordas (SOM CORTADO) e compara a fala
 *       montada com o roteiro; exit 1 com problema
 *   transcribe AAMMDD --from-audio ARQ [--audio-transcript JSON] [--source VIDEO]
 *       (#11504) o vídeo chegou depois de o áudio separado (o mesmo som, com pausas
 *       cortadas) já estar transcrito: alinha o áudio ao vídeo por correlação do
 *       envelope em janelas (`lib/diaria/video-audio-align.ts`), remapeia as palavras
 *       para o tempo do vídeo e retranscreve no vídeo só os trechos sem par. A
 *       transcrição do áudio fica em `transcript-audio.json` (vem de --audio-transcript,
 *       ou do `transcript.json` quando o `source.json` era o áudio); `audio-align.json`
 *       guarda os deslocamentos e o que foi retranscrito.
 *   decupagem AAMMDD [--pixel-f0 HZ]
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
 *                           Gate 2, com o trecho do bruto e a proposta de corte
 *   build AAMMDD [--seq youtube|instagram|outras-redes|{corte}] [--allow-missing] [--no-audio-refine] [--no-audio-gain] [--title-mode png|off] [--no-speech-detect] [--no-audio-clean]
 *       (#12102) o áudio dos clipes do XML (e da prévia) vem de `{AAMMDD}_audio_tratado-{chave}.wav`
 *       (`cleanAudioFileName`; a chave é o hash dos args do ffmpeg), o áudio do bruto com afftdn +
 *       agate (aproximação do Enhance do Adobe Podcast), ao lado do bruto; ffmpeg falho = áudio
 *       cru com [aviso]; --no-audio-clean tira. No modo API o build baixa o bruto de novo se ele
 *       saiu do cache, antes do render da faixa (#12209).
 *       (#12101) vinheta do logo (publishing.video.vinheta_logo.path) na faixa do topo, no fim do
 *       título; respiro de 0,7 s depois do título no horizontal.
 *       (#12089) o corte de pausas vem do detector de fala (`SPEECH_DETECT`, bruto a 48 kHz em
 *       quadros de 5 ms: sinal cheio acima de -33 dBFS ou 1ª diferença acima de -46 dBFS; pausa
 *       de 0,32 s ou mais sai com 150 ms antes da fala e 120 ms depois; ilha abaixo de 60 ms é
 *       estalo), não do silencedetect; avisa emenda com pausa acima de 0,45 s, clipe abaixo de
 *       0,3 s e borda dentro da fala. --no-speech-detect (ou o bruto ausente) volta ao silences.json.
 *       (#12263) o começo de cada ilha recua até 120 ms no ataque acima do piso de ruído do bruto
 *       + 12 dB (consoante suave abaixo dos limiares fixos); entrada com som nos 40 ms antes do
 *       corte (piso + 45% da faixa) vira [aviso]; a passada B do refino só tira som na entrada
 *       separado da 1ª palavra por silêncio.
 *       (#11935) grava um XML por sequência ({nome da sequência}.xml); `--seq` grava só uma, e só ela muda no plan.json (#11969)
 *       XML FCP7 (xmeml v4) + `plan.json` (com o hash do blocks.json, do source.json e do silences.json).
 *       Clipes contíguos no bruto viram um só e o zoom alterna só nos cortes (#11503). Os cortes
 *       são refinados pelo áudio do bruto (#11500, `lib/diaria/video-cut-refine.ts`): vale de
 *       energia a ±0,4 s, som fora do roteiro na borda (bordas retranscritas sem VAD, cache em
 *       `edge-retranscribe.json`), corte ainda em plena fala vira [aviso]; cada ajuste sai no
 *       relato e em `plan.json` (`cutAdjustments`, `cutRefine`). A banda alta (>3 kHz, -51 dBFS ou mais com o piso do bruto, #11968) protege fonemas com 30 ms de ar e 80 ms de silêncio (#11940). Sem `audio.wav` nesta máquina,
 *       ou com --no-audio-refine, os cortes ficam como os tempos do Whisper, com [aviso].
 *       Bloco faltando ou item/palavra que some no corte = erro, salvo --allow-missing.
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
 *   srt AAMMDD [--seq youtube|instagram|outras-redes|{corte}] [--from-raw] [--force]
 *       legendas de todas as sequências (#11957: o horizontal também; --seq escolhe uma).
 *       Retranscreve o áudio montado (cache por trechos + identidade do áudio);
 *       --from-raw remapeia o transcript do bruto. O texto é o do roteiro,
 *       alinhado aos tempos da fala (#11960, `forceAlignToScript`): palavra do
 *       roteiro sem par ganha tempo interpolado, palavra ouvida sem par sai quando
 *       cai antes/depois do roteiro, perto de corte ou em silêncio ([aviso] lista).
 *       O do horizontal sai também como `diaria-comentada-{AAMMDD}.srt` na pasta
 *       da edição (data/editions), o que o `publish-youtube.ts --upload` envia;
 *       cópia editada à mão depois do último srt fica, salvo --force.
 *   srt AAMMDD --seq youtube --from-final PATH [--heard-text] [--force] [--retranscribe]
 *       (#12078) a legenda do horizontal no tempo do EXPORT final do Premiere (respiros, vinheta):
 *       transcreve o export (o mesmo cache do review-final, por identidade do arquivo + modelo e
 *       prompt do Whisper; --retranscribe refaz) e alinha a ele o roteiro do horizontal do
 *       plan.json (`forceAlignToScript`, sem os cortes da montagem; plan.json defasado só avisa,
 *       o export saiu do XML daquele build). Grava `{sequência} - legendas do export.srt` no out
 *       dir e a cópia `diaria-comentada-{AAMMDD}.srt` na pasta da edição pela mesma regra; cópia
 *       editada à mão = exit 1 com [erro] (saída: --force, ou --captions-only --captions com o
 *       arquivo do out dir). Uma cópia gravada pelo --from-final não é trocada por um `srt` da
 *       montagem depois, salvo --force. No modo API, PATH que não existe no disco é o nome em
 *       Final/ no Drive (baixado só depois de validar --seq e o plano). Bruto só de áudio fica
 *       fora: sem build não há plano do horizontal (o `srt` para antes, exit 3).
 *       Backfill de legenda: este comando + `publish-youtube.ts AAMMDD --captions-only`.
 *       (#12198) Legenda imprópria = exit 1 com [erro], NADA gravado: alguma legenda de até 0,3 s
 *       ou palavras do roteiro interpoladas + ouvidas descartadas acima de 10% do roteiro (export
 *       reeditado depois do build). `--heard-text` faz a legenda pela fala do export (grafia e
 *       pontuação do roteiro onde casa); aí só a legenda vazia recusa.
 *   preview AAMMDD [--seq youtube|instagram|outras-redes|{corte}] [--no-subs]   (default a vertical da edição; sempre refaz)
 *       (#12579) sem SRT, ou com SRT mais velho que o build da sequência, sai sem legenda com
 *       [aviso] (não recusa): as legendas vêm depois da aprovação das prévias; --no-subs tira a
 *       legenda mesmo com SRT em dia. (#12571) o card de CTA do XML entra no fim da prévia.
 *   review AAMMDD [--seq youtube|instagram|outras-redes|{corte}]    (default a vertical da edição; sempre refaz)
 *       `--seq youtube` (#12096): a prévia do horizontal, 960x540, com o recorte de cada clipe
 *       pelo mesmo `framingFor` do XML (`previewCropFor`), a legenda do horizontal queimada e o
 *       áudio normalizado, em `{AAMMDD} - previa youtube.mp4`; o review cobre ela também.
 *       `--seq` (#11900): o slug do corte escolhe aquela vertical extra (várias por
 *       plano); o destino escolhe a sequência sem corte dele, ou o único corte dele.
 *       Arquivos de trabalho por sequência: seq-{corte|destino}.wav, previa-…, review-….
 *   review-final AAMMDD --file PATH [--seq youtube|instagram|outras-redes|{corte}] [--no-text] [--retranscribe]
 *       revisão do EXPORT do Premiere (#11557): formato contra o destino (proporção,
 *       faixa preta, fps, teto do vertical), loudness/true peak, estalos e fragmentos
 *       nas emendas e, com `plan.json` válido, o texto contra o roteiro da versão
 *       (transcreve o export, em cache por arquivo + Whisper desde o #12078, o mesmo do
 *       `srt --from-final`; `--retranscribe` refaz; `--no-text` pula). Destino pelo nome do arquivo
 *       (`_Youtube_`/`_Instagram_`/`_Outras redes_`) ou `--seq`. Saída: tabela
 *       (#, tempo no export, tempo no bruto, o que está, correção) no stdout e em
 *       `review-final-{destino ou corte}.md`/`.json` no state dir. Só lê o export.
 * srt, preview e review recusam um `plan.json` defasado (blocks.json ou
 * source.json mudaram depois do build); preview recusa um SRT mais velho que o
 * plano; review recusa uma prévia mais velha que o plano.
 *
 * Opções comuns:
 *   --drive-root DIR   pasta YouTube local do Drive (default: env DIARIA_VIDEO_DRIVE_ROOT ou
 *                      "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube"); a edição é {DIR}/{AAMMDD}/
 *   --state-dir DIR    onde ficam os JSON (default: data/editions/{AAMM}/{AAMMDD}/_internal/video-montagem)
 *   --work-dir DIR     áudio e clipes temporários (default: {tmp}/diaria-video-montagem/{AAMMDD};
 *                      no modo API, {cache}/work, em disco)
 *   --out-dir DIR      onde saem XML, SRT e prévia (default: a pasta da edição no Drive; no modo
 *                      API, {cache}/out, que sobe para a pasta da edição)
 *   --python EXE       Python com faster-whisper (default: env DIARIA_VIDEO_PYTHON, o venv
 *                      ~/.venv-video-montagem quando existe, ou "python"; #11642)
 *
 * Modo API do Drive (#11639, #11640, #11641), o 300 sem o Drive for desktop:
 * sem a RAIZ {drive-root} no disco (a pasta YouTube; e sem --drive-root/DIARIA_VIDEO_DRIVE_ROOT
 * explícito), ou com --from-drive, a pasta da edição é lida pela API (OAuth do projeto;
 * pasta YouTube em publishing.youtube.drive_folder_id, --folder-id sobrepõe). --no-drive-api
 * desliga. O bruto vai para um cache em disco (--cache-dir, DIARIA_VIDEO_CACHE_DIR ou
 * ~/.cache/diaria-video-montagem/{AAMMDD}: bruto/, out/, work/, final/), registrado em
 * bruto.drive.json; build/srt/preview sobem o que gravaram no out dir para a pasta da edição
 * (nunca Final/), em drive-uploads.json; upload que falha depois do comando dar certo sai com
 * exit 4 e fica pendente para a próxima execução. O XML aponta o bruto no Neo
 * (--xml-media-root sobrepõe).
 *   upload AAMMDD --file PATH   sobe um arquivo para a pasta da edição (ex.: o decupagem.md)
 *
 * Cache e HD (#12365): DIARIA_VIDEO_CACHE_DIR aponta para um SUBDIRETÓRIO dentro do ponto de
 * montagem do HD, nunca o ponto em si. No modo API, a variável apontando para um diretório que
 * não existe, ou que está no mesmo disco do home (HD desmontado), para com erro em vez de criar
 * o cache no disco raiz. Retenção: scripts/prune-video-montage-cache.ts (task diária).
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import {
  AUDIO_GAIN_TARGET_LUFS,
  AUDIO_GAIN_TP_CEILING_DBTP,
  LOUDNORM_TARGET,
  PREVIEW_SUBTITLE_STYLE,
  PREVIEW_SUBTITLE_STYLE_HORIZONTAL,
  SILENCE_DETECT,
  SPEECH_DEFAULTS,
  alignPunctuationToScript,
  applyVocabularyToWords,
  sequenceKey,
  assembleClips,
  audioGainFor,
  buildSequencePlan,
  buildXmeml,
  clockTime,
  collapsedTakeSuspects,
  cueTimings,
  cuesToSrt,
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
  makeMatcher,
  mapWordsToSequence,
  trimWordsToSilences,
  isVerticalSpec,
  CTA_BLOCKS,
  offsetTranscript,
  subWindows,
  parseBlocksFile,
  retranscribeWindow,
  parseLoudnormJson,
  parseFrameRate,
  parseProbe,
  mirroredDefaultFrom,
  mirroredPremise,
  parseSilenceDetect,
  pickRawSource,
  previewClipArgs,
  previewCropFor,
  clipFraming,
  previewSize,
  resolveBlocks,
  reviewPreview,
  audioEndFromSilences,
  screenTitleSvg,
  normalizeToken,
  segmentCues,
  sequenceSourceRanges,
  srtTimestamp,
  silenceNoiseDb,
  transcriptWords,
  reviewTranscriptWords,
  validateVocabRules,
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
  titleBreathS,
  VINHETA_AFTER_SPEECH_S,
  type VinhetaAsset,
  type AudioGain,
  clipGeometry,
  fitWarnings,
  framingOfFile,
  joinWordTexts,
  type ResolvedItem,
  type ReviewFinding,
  type BlocksFile,
  type CutAdjustment,
  type ForcedAlignment,
  type Framing,
  type Interval,
  type PlannedClip,
  type RawClip,
  type ScreenTitleXml,
  type Segment,
  type SequencePlan,
  type SequenceKey,
  type SequenceSpec,
  type SequenceTarget,
  type SourceInfo,
  type Transcript,
  type VocabAlias,
  type VocabRule,
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
import { assemblySegments, edgeFindings, edgeLine, longPauses, parseXmlAudio, sequenceCutsS, toTimeline, xmlPlanIssues, xmlStructureIssues } from "./lib/diaria/video-xml-verify.ts";
import { CTA_CARD, ctaCardFileName, ctaCardFrames, ctaCardOrientation, ctaCardPreviewClipArgs, ctaCardRenderArgs, ctaCardSvg, ctaCardXmlIssues, ctaShareLine, type CtaCardAsset } from "./lib/diaria/video-cta-card.ts";
import { applyItemFramings, FACE_SAMPLE_FRACTIONS, gazeMarks, itemFramings, type FrameDetection } from "./lib/diaria/video-face.ts";
import {
  alternativesFromDecupagem,
  blocksFromDecupagem,
  buildDecupagemDoc,
  checkDecupagemCriteria,
  decupagemMarkdown,
  decupagemPlanTemplate,
  mdCell,
  parseDecupagemPlan,
  proposeGancho,
  roteiroMarkdown,
  segmentListing,
  SHORTS_MAX_S,
  shortsWarning,
  suggestedDurations,
  verticalTargetCheck,
  verticalTargetWarning,
  type DecupagemPlan,
} from "./lib/diaria/video-montage-docs.ts";
import {
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
  speechPauseSilences,
  trimEdgeExtras,
  windowKey,
  extendIslandAttacks,
  entryCutSoundWarnings,
  type EdgeWindow,
  type FrameEnergy,
} from "./lib/diaria/video-cut-refine.ts";
import { classifyVoices, segmentF0s, speechSeconds, type VoiceMark } from "./lib/diaria/video-voice.ts";
import { ALIGN_DEFAULTS, alignEnvelopes, mergeRetranscribed, remapToVideo } from "./lib/diaria/video-audio-align.ts";
import { gFetchRetry } from "./lib/drive-helpers.ts";
import { gFetch } from "./google-auth.ts";
import {
  DEFAULT_DRIVE_ROOT,
  changedFiles,
  driveCacheDir,
  driveModeFor,
  ensureCachedFile,
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
import { parseDestaques } from "./extract-destaques.ts";
import { buildYouTubeTitle, stripInlineMarkdown } from "./lib/diaria/youtube-video.ts";
import { youtubeCaptionFileName } from "./lib/diaria/youtube-captions.ts";
import { factCheckItems, factCheckItemsSha256, factCheckSection, parseVideoFactCheck, type FactCheckItem } from "./lib/diaria/video-fact-check.ts";
import { SHORT_WORD_WINDOW_PAD_S, shortWordDivergences, shortWordSection, type ShortWordItemCheck } from "./lib/diaria/video-short-words.ts";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PY_HELPER = join(ROOT, "scripts", "video", "transcribe_words.py");
const VOCAB_FILE = join(ROOT, "context", "video-montagem", "vocabulario.json");
export { DEFAULT_DRIVE_ROOT };

const USAGE = `uso: npx tsx scripts/video-montagem.ts <transcribe|inventory|decupagem|retranscribe|frame|face|gaze|roteiro|fact-check-input|build|verify-xml|srt|preview|review|review-final|upload> AAMMDD [opções]
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
}

const f = (ctx: Pick<Ctx, "stateDir">, name: string) => join(ctx.stateDir, name);

function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) throw new Error(`${what} ausente: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
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
  return { whisper_prompt: v.whisper_prompt, rules: v.rules ?? [], aliases: v.aliases ?? [] };
}

function transcribeWithPython(ctx: Ctx, audio: string, out: string, opts: { vad: boolean; noCondition?: boolean }): void {
  const vocab = loadVocab();
  console.error(`[video-montagem] transcrevendo ${audio} (faster-whisper large-v3-turbo, CPU int8; leva minutos)…`);
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

/** `publishing.video.mirrored_default` do config (#11959); config ilegível = `null` (vale o default do código, com aviso). */
function configMirroredDefault(): boolean | null {
  try {
    return mirroredDefaultFrom(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")));
  } catch (e) {
    console.error(`[aviso] platform.config.json ilegível (${(e as Error).message}): espelhamento pelo default do código (#11959)`);
    return null;
  }
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
    const root = drive.rootFolderId?.();
    if (!root) throw new Error("pasta raiz YouTube indisponível");
    const folders = await listChildren(drive.deps, root, { name: "_marca", foldersOnly: true });
    if (folders.length !== 1) throw new Error(`${folders.length} pastas _marca/ no Drive; esperada exatamente uma`);
    const name = cfg.path.replace(/\\/g, "/").split("/").pop()!;
    const found = await findByName(drive.deps, folders[0].id, name);
    if (!found.file || found.duplicates) throw new Error(`vinheta ${name} ausente ou duplicada em _marca/`);
    const cached = await ensureCachedFile(drive.deps, found.file, join(drive.cacheDir, "_marca"), log);
    const asset = loadVinheta({ ...deps, readConfig: () => config, exists: () => true, probe: () => deps.probe ? deps.probe(cached.localPath) : run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", cached.localPath]).stdout });
    return asset ? { ...asset, localPath: cached.localPath } : null;
  } catch (e) {
    warn(`vinheta do logo no Drive: ${(e as Error).message}: XML/prévia sem a vinheta (#12232)`);
    return null;
  }
}

/**
 * Chave curta da faixa tratada (#12102): hash dos args do ffmpeg (filtro +
 * formato de saída, sem os caminhos). Vai no nome do arquivo: mudar o
 * tratamento grava um WAV novo em vez de sobrescrever o que um projeto do
 * Premiere aberto pode estar usando.
 */
export function cleanAudioKey(filter: string): string {
  return createHash("sha256").update(JSON.stringify(audioCleanArgs({ src: "<bruto>", out: "<faixa>", filter }))).digest("hex").slice(0, 8);
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
  filter: string;
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
  input: { src: string; outDir: string; stateDir: string; edition: string; mediaPath: string; thresholdDb: number },
  deps: {
    ffmpeg?: (args: string[]) => void;
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
  const filter = audioCleanFilter(audioCleanParams(input.thresholdDb));
  const key = cleanAudioKey(filter);
  const out = join(input.outDir, cleanAudioFileName(input.edition, key));
  const xmlPath = cleanAudioXmlPath(input.mediaPath, input.edition, key);
  const metaPath = join(input.stateDir, "audio-tratado.meta.json");
  let id: { src: string; size: number; mtimeMs: number; out: string; args: string[] } | null = null;
  try {
    const st = statSync(input.src);
    id = { src: input.src, size: st.size, mtimeMs: Math.round(st.mtimeMs), out: basename(out), args: audioCleanArgs({ src: "<bruto>", out: "<faixa>", filter }) };
  } catch (e) {
    debug(`faixa tratada: bruto sem stat (${(e as Error).message}); o render abaixo decide`);
  }
  if (id && existsSync(out) && existsSync(metaPath)) {
    try {
      if (JSON.stringify(JSON.parse(readFileSync(metaPath, "utf8"))) === JSON.stringify(id)) {
        info(`[video-montagem] faixa de áudio tratada reaproveitada: ${out} (#12102)`);
        return { path: out, xmlPath, filter, reused: true };
      }
    } catch (e) {
      debug(`faixa tratada: ${metaPath} ilegível (${(e as Error).message}); renderiza de novo`);
    }
  }
  if (existsSync(out)) info(`[video-montagem] faixa de áudio tratada ${out} sobrescrita (o bruto mudou desde o render anterior, #12102)`);
  const part = `${out}.part`;
  try {
    mkdirSync(input.outDir, { recursive: true });
    (deps.ffmpeg ?? ((args: string[]) => run("ffmpeg", args)))(audioCleanArgs({ src: input.src, out: part, filter }));
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
  return { path: out, xmlPath, filter, reused: false };
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
 * bruto antes (`ensureBrutoLocal`); no local (G:) o bruto é o do Drive montado.
 */
export function buildNeedsLocalBruto(o: { apiMode: boolean; audioClean: boolean }): boolean {
  return o.apiMode && o.audioClean;
}

/**
 * Faixa tratada reaproveitada no modo API (#12102): não muda no out dir, então
 * o snapshot do upload não a vê. Se o `drive-uploads.json` não registra o
 * envio dela, entra nos pendentes (sobe no fim deste comando).
 */
export function queueUploadIfMissing(regPath: string, path: string): boolean {
  const reg = readRegistry(regPath);
  if (reg.files[basename(path)] || reg.pending.includes(path)) return false;
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
  const override = existsSync(f(ctx, "blocks.json")) ? loadBlocks(ctx).file.mirrored : undefined;
  const out = f(ctx, `frame-${t.toFixed(1)}-orientacoes.jpg`);
  const vf = "scale=960:-2,split[a][b];[b]hflip[m];[a][m]hstack=inputs=2,drawgrid=w=iw/20:h=ih/10:t=1:c=white@0.4";
  const at0 = frameAt(measured, t);
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", String(at0.localS), "-i", at0.view.path, "-frames:v", "1", "-filter_complex", vf, out]);
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
      run("ffmpeg", [...multiAudioPartArgs({ src: file.path, frames: file.frames, fps: source.fps, out: tmp }).slice(0, -1), "-f", "wav", tmp]);
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
export const VIDEO_ONLY_COMMANDS = ["frame", "face", "gaze", "build", "verify-xml", "srt", "preview", "review"] as const;

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
  if (!existsSync(path)) throw new Error(`blocks.json (gate da decupagem) ausente: ${path}`);
  const text = readFileSync(path, "utf8");
  const parsed = parseBlocksFile(JSON.parse(text));
  if (!parsed.ok) throw new Error(`blocks.json inválido:\n  - ${parsed.errors.join("\n  - ")}`);
  if (parsed.file.edition !== ctx.edition) throw new Error(`blocks.json é da edição ${parsed.file.edition}, não ${ctx.edition}`);
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
type SpeechCut = { silences: Interval[]; islands: Interval[]; energy?: FrameEnergy };

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
  if (speech) {
    const words = Object.values(blocks).flatMap((items) => (items ?? []).flatMap((it) => it.words));
    const guard = protectTranscribedWords(speech.silences, words);
    speechSil = guard.silences;
    if (guard.protectedWords.length) {
      console.error(`[aviso] detector de fala (#12089): ${guard.protectedWords.length} palavra(s) do transcript abaixo do limiar ficaram no corte em vez de sair na pausa: ${guard.protectedWords.map((w) => `"${w.text}" em ${w.start.toFixed(2)} s`).join(", ")}; conferir no áudio (se for ruído, --no-speech-detect ou intervalo no blocks.json)`);
    }
  }
  const ps = specs.map((s) =>
    // #12101: o respiro da vinheta depois do título, só no horizontal.
    speech
      ? buildSequencePlan(s, blocks, speechSil, source, { holdBlocks: file.holdBlocks, breathAfter: vinhetaBreathFor(s), ...SPEECH_DETECT_PLAN })
      : buildSequencePlan(s, blocks, sil, source, { holdBlocks: file.holdBlocks, breathAfter: vinhetaBreathFor(s) }),
  );
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
}

export interface SequenceXmlVersion {
  id: string;
  since: number;
}

export interface SequenceXmlAssets {
  treatedAudio?: TreatedAudio;
  vinheta?: VinhetaAsset;
  /** #12571: o card de CTA que o XML desta sequência levou no fim da V1 (a prévia o acrescenta igual). */
  ctaCard?: CtaCardAsset;
}

/**
 * O `plan.json` de um build (#11969). Sem `--seq` (`pickedKeys` = todas), é o
 * plano novo inteiro. Com `--seq`, só as sequências reconstruídas entram do
 * plano novo; as outras ficam como o build anterior as gravou (o XML delas no
 * disco é o daquele build), e só se o plano anterior tiver o MESMO hash: com
 * blocks.json/source.json/silences.json/transcript.json mudados, o XML antigo
 * delas não corresponde mais às entradas, então elas SAEM do plan.json (srt e
 * prévia recusam até um build delas) em vez de entrar sem conferência.
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
}): { plan: PlanFile; kept: string[]; dropped: string[] } {
  const { next, pickedKeys, prev, now } = input;
  const xmlVersions: Record<string, SequenceXmlVersion> = {};
  const keyOf = (p: SequencePlan) => sequenceKey(p.spec);
  const sameInputs = prev !== null && prev.hash === next.hash;
  const prevByKey = new Map((sameInputs ? prev.plans : []).map((p) => [keyOf(p), p]));
  const kept: string[] = [];
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
    if (!old) {
      dropped.push(k);
      continue;
    }
    plans.push(old);
    kept.push(k);
    builtAt[k] = prev?.builtAt?.[k] ?? 0;
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
    },
    kept,
    dropped,
  };
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

/** O plano do último build, recusado se o blocks.json ou o source.json mudaram depois dele. */
function loadPlan(ctx: Ctx): PlanFile {
  const pf = readJson<PlanFile>(f(ctx, "plan.json"), "plan.json (rode build)");
  const { text } = loadBlocks(ctx);
  if (pf.hash !== planHash(ctx, text)) throw new Error("plan.json defasado: blocks.json, source.json, silences.json ou transcript.json mudaram depois do build; rode build de novo");
  return pf;
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
export const TRANSCRIPT_DERIVED = ["decupagem-plan.json", "decupagem-plan.template.json", "decupagem.md", "blocks.json", "blocks.template.json", "plan.json"] as const;

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
    throw new Error(`--source: arquivo não encontrado: ${name} (nem em ${driveDir})`);
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
    const files = readdirSync(ctx.driveDir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => ({ name: d.name, size: statSync(join(ctx.driveDir, d.name)).size }));
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
  let src = multiPaths ? multiPaths[0] : sourceArg ? resolve(sourceArg) : undefined;
  if (!src) {
    if (!existsSync(ctx.driveDir)) {
      throw new Error(`pasta da edição no Drive não encontrada: ${ctx.driveDir} (Drive for desktop montado? a pasta ${ctx.edition}/ ainda não sincronizou? espere, ou passe --from-drive para baixar pela API, ou --drive-root)`);
    }
    const files = readdirSync(ctx.driveDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => ({ name: d.name, size: statSync(join(ctx.driveDir, d.name)).size }));
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
    const { stderr } = run("ffmpeg", [
      "-hide_banner", "-nostats", "-y", "-i", multiAudio ? multiAudio.path : source.path,
      "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audio,
      "-map", "0:a:0", "-af", `${LOUDNORM_TARGET}:print_format=json`, "-f", "null", "-",
    ]);
    writeJson(loudPath, parseLoudnormJson(stderr));
    redo = true;
  }
  const loud = readJson<ReturnType<typeof parseLoudnormJson>>(loudPath, "loudness.json");

  // Limiar relativo ao loudness do bruto (#11351); --silence-db sobrepõe.
  const threshold = silenceNoiseDb(loud, silenceDb);
  const silPath = f(ctx, "silences.json");
  const silMetaPath = f(ctx, "silences.meta.json");
  const silMeta = existsSync(silMetaPath) ? readJson<{ noiseDb?: number; minDurationS?: number; highBandVersion?: number }>(silMetaPath, "silences.meta.json") : null;
  // silences.json sem meta (anterior ao #11351) ou com outro limiar é refeito.
  const silStale = !existsSync(join(ctx.workDir, "audio-high-48k.wav")) || !existsSync(join(ctx.workDir, "audio-high-48k.meta.json")) || !silMeta || silMeta.highBandVersion !== 11968 || silMeta.noiseDb !== threshold.noiseDb || silMeta.minDurationS !== SILENCE_DETECT.minDurationS;
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
    writeJson(silMetaPath, { noiseDb: threshold.noiseDb, minDurationS: SILENCE_DETECT.minDurationS, how: threshold.how, highBandVersion: 11968, highBand: highThreshold });
    console.error(`[video-montagem] banda alta a ${highThreshold.thresholdDb} dBFS (${highThreshold.how === "relative" ? "relativo ao piso do bruto" : "piso do #11940"}): ${kept.length} pausa(s) no silences.json`);
    const loss = intersectionLossWarning(low, kept, SILENCE_DETECT.minDurationS, highThreshold);
    if (loss) console.error(`[aviso] ${loss}`);
  }
  console.error(`[video-montagem] silencedetect a ${threshold.noiseDb} dB (${threshold.how === "relative" ? "relativo ao loudness do bruto" : threshold.how === "override" ? "--silence-db" : "padrão, loudness não medido"})`);

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

function cmdDecupagem(ctx: Ctx, pixelF0?: number): number {
  const tr = readJson<Transcript>(f(ctx, "transcript.json"), "transcript.json (rode transcribe)");
  const segments = tr.segments;
  // Tomada colapsada (#11754): avisar antes de decidir, com a janela do retranscribe.
  const silPath = f(ctx, "silences.json");
  for (const line of collapsedSegmentWarnings(ctx.edition, segments, existsSync(silPath) ? readJson<Interval[]>(silPath, "silences.json") : [], tr.duration)) console.error(`[aviso] ${line}`);
  const plan = loadDecupagemPlan(ctx, segments);
  if (!plan) {
    // 1ª passada: a listagem numerada e o molde do plano, para a skill classificar (#11361).
    const voices = segmentVoices(ctx, segments, pixelF0);
    const tplPath = f(ctx, "decupagem-plan.template.json");
    writeJson(tplPath, decupagemPlanTemplate(ctx.edition, segments, voices));
    process.stdout.write(segmentListing(segments, voices));
    console.error(`[video-montagem] decupagem: classificar os segmentos acima em ${f(ctx, "decupagem-plan.json")} (molde: ${tplPath}) e rodar decupagem de novo`);
    return 0;
  }
  // Decisão por critério (#11364): uma tomada por frase, a direção decide antes da "alternativa".
  const crit = checkDecupagemCriteria(plan, segments);
  for (const w of crit.warnings) console.error(`[aviso] ${w}`);
  if (crit.errors.length) throw new Error(`decupagem-plan.json não decide por critério:\n  - ${crit.errors.join("\n  - ")}`);
  // #12093: o gancho (1ª frase do resumo) abre o horizontal; o Doc e o molde já o trazem separado.
  const proposed = proposeGancho(buildDecupagemDoc(plan, segments, loadVocab().rules), segments);
  if (proposed.note) console.error(`[premissa] ${proposed.note}`);
  const doc = proposed.doc;
  const source = measuredSource(ctx);
  // Sem título nem resumo "usar", é entrevista (#11507): sequências sem esses blocos.
  const blocks = blocksFromDecupagem(doc);
  const { format } = effectiveFormat({ blocks });
  if (format === "entrevista") console.error("[premissa] nenhum título nem resumo na decupagem: formato entrevista, sequências abertura → comentário → CTA → fecho (#11507); `format`/`sequences` no blocks.json sobrepõem");
  // #12586: a frase falada de abertura no `gancho` (sem `titulo`) abre as duas versões no molde.
  const opening = openingBlockOf(blocks);
  if (format === "monologo" && opening === "gancho") console.error("[premissa] decupagem sem título falado e com gancho: o gancho abre as duas versões, com o PNG do título, o respiro e a vinheta nele (#12586)");
  const sequences = defaultSequences("V1", format, opening);
  for (const d of suggestedDurations(doc, sequences)) {
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
    ...(format === "entrevista" ? { format } : {}),
    blocks,
    sequences,
  };
  writeJson(tpl, template);
  process.stdout.write(md);
  console.error(`[video-montagem] decupagem: ${f(ctx, "decupagem.md")}; molde do blocks.json (falas "usar"): ${tpl}`);
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
  const wins = subWindows(window).map((w) => ({ key: `${w.start.toFixed(1)}-${w.end.toFixed(1)}`, start: w.start, end: w.end }));
  mkdirSync(ctx.workDir, { recursive: true });
  const winFile = join(ctx.workDir, "retranscribe-sub-windows.json");
  const raw = join(ctx.workDir, "retranscribe-sub.raw.json");
  writeFileSync(winFile, JSON.stringify(wins));
  console.error(`[video-montagem] retranscrevendo ${wins.length} subjanela(s) de ${window.start.toFixed(1)}–${window.end.toFixed(1)} s (sem VAD, #11958)…`);
  const vocab = loadVocab();
  run(ctx.python, ["-P", PY_HELPER, audio, raw, "--windows", winFile, "--no-condition", "--initial-prompt", vocab.whisper_prompt ?? ""], {
    env: { ...process.env, HF_HUB_OFFLINE: "1" },
    inheritStderr: true,
  });
  const out = readJson<{ windows: Array<{ key: string; start: number; end: number; segments: Segment[] }> }>(raw, "retranscrição das subjanelas");
  for (const w of out.windows) {
    // Prefixo próprio: nunca sobrescreve a retranscrição da janela inteira de mesmo intervalo.
    const path = f(ctx, `retranscribe-sub-${w.key}.json`);
    const t: Transcript = { segments: w.segments, sub: { window: { start: w.start, end: w.end } } };
    writeJson(path, t);
    console.log(`== ${w.key} s: ${w.segments.map((s) => s.text.trim()).join(" ") || "(nada)"}`);
  }
  console.error("[video-montagem] subjanelas gravadas como retranscribe-sub-*.json: o roteiro/build procuram o falso começo nelas e propõem o corte na linha repetição (#11958)");
  return 0;
}

function cmdFrame(ctx: Ctx, at: string | undefined): number {
  const t = Number(at);
  if (at === undefined || !Number.isFinite(t) || t < 0) throw new Error("frame exige --at SEGUNDOS");
  // Antes do gate 1 não há blocks.json: vale o mirrored do source.json (e o framing da 261027).
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
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", String(at0.localS), "-i", at0.view.path, "-frames:v", "1", "-vf", vf, out]);
  console.log(out);
  for (const w of overlays.warnings) console.error(`[aviso] ${w}`);
  console.error(`[video-montagem] mirrored=${source.mirrored}; grade em décimos: centro do rosto (faceX), linha dos olhos (eyeY) e caixa da caneca (framing.mug) em fração do quadro, no framing do blocks.json; recortes: ${frameCropLegend()} (#11939, #12565)`);
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
  const names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => ({ name: d.name, size: statSync(join(dir, d.name)).size }));
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
  const thr = silenceThresholdDb(ctx);
  const offsets = sourceFiles(pf.source).map((x) => x.offsetFrames);
  let bad = 0;
  const report: Record<string, unknown> = {};
  for (const plan of chosen) {
    const key = sequenceKey(plan.spec);
    const xmlPath = join(ctx.outDir, xmlFileName(plan.spec.name));
    if (!existsSync(xmlPath)) throw new Error(`verify-xml: ${xmlPath} ausente (rode build)`);
    const xmlText = readFileSync(xmlPath, "utf8");
    const parsed = parseXmlAudio(xmlText);
    const { clips, errors } = toTimeline(parsed, offsets);
    // #12571: o card de CTA no fim da V1 (sem áudio): logo depois da fala, com a duração do plano.
    const cardFrames = pf.xmlAssets?.[key]?.ctaCard?.frames ?? null;
    const issues = [...errors, ...xmlStructureIssues(parsed.clips), ...xmlPlanIssues(parsed, { clips: plan.clips.length, durationFrames: plan.durationFrames }), ...ctaCardXmlIssues(xmlText, { durationFrames: plan.durationFrames, cardFrames })];
    if (parsed.timebase !== pf.source.fps || parsed.ntsc) issues.push(`timebase ${parsed.timebase}${parsed.ntsc ? " NTSC" : ""} diferente dos ${pf.source.fps} fps do bruto`);
    const edges = edgeFindings(clips, parsed.rate, (a, b) => maxDbIn(env, a, b), thr, undefined, isMultiSource(pf.source) ? fileBounds(pf.source) : undefined);
    const cut = edges.filter((e) => e.cutIn || e.cutOut);
    const durS = (parsed.clips[parsed.clips.length - 1]?.end ?? 0) / parsed.rate;
    console.log(`== ${basename(xmlPath)}: timebase ${parsed.timebase}${parsed.ntsc ? " NTSC" : ""}, ${clips.length} clipes, ${durS.toFixed(2)} s (plano: ${(plan.durationFrames / pf.source.fps).toFixed(2)} s)${cardFrames ? ` + card de CTA ${(cardFrames / pf.source.fps).toFixed(2)} s sem fala` : ""}`);
    for (const x of issues) console.log(`[erro] ${x}`);
    for (const e of edges) console.log(edgeLine(e, clockTime));
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
      findings = reviewPreview({ words: heard, script: plan.script, cuts: sequenceCutsS(parsed.clips, parsed.rate), durationS: durS, aliases: loadVocab().aliases })
        .filter((x) => x.kind === "fala-faltando" || x.kind === "fala-extra");
      console.log("transcrição do áudio montado pelo XML x roteiro:");
      if (!findings.length) console.log("  sem diferenças");
      for (const x of findings) console.log(`  ${clockTime(x.at)}  ${x.kind}: ${x.detail}`);
    }
    bad += issues.length + cut.length + findings.length;
    report[key] = { xml: xmlPath, clips: clips.length, issues, cutEdges: cut, findings };
  }
  writeJson(f(ctx, "verify-xml.json"), report);
  if (bad) {
    console.error(`[erro] verify-xml: ${bad} problema(s) no XML (borda com SOM CORTADO, estrutura ou fala divergente): corrigir o blocks.json/build antes da prévia (#12561)`);
    return 1;
  }
  console.error(`[video-montagem] verify-xml: zero bordas cortadas${transcribe ? " e áudio do XML batendo com o roteiro" : "; fala NÃO conferida (--no-transcribe)"} (#12561)`);
  return 0;
}

// ── Rosto automático e folha de olhar (#12560) ────────────────────────────

/** Um frame do bruto (tempo global) em PNG de 720 px de largura, desespelhado. */
function grabFrame(source: SourceInfo, t: number, out: string): void {
  const at0 = frameAt(source, t);
  rmSync(out, { force: true });
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", at0.localS.toFixed(3), "-i", at0.view.path, "-frames:v", "1", "-vf", `${at0.view.mirrored ? "hflip," : ""}scale=720:-2`, out]);
  // ffmpeg com -ss além do fim sai 0 sem gravar: frame ausente é falha de extração, não "rosto não detectado" (review da PR #12563).
  if (!existsSync(out)) throw new Error(`frame em ${t.toFixed(2)} s (${at0.view.id} em ${at0.localS.toFixed(2)} s) não foi extraído: tempo além do fim do arquivo?`);
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
function cmdFace(ctx: Ctx, write: boolean, overwrite = false): number {
  const { source, resolved } = plans(ctx);
  const dir = join(ctx.workDir, "face-tmp");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const jobs: Array<{ key: string; path: string }> = [];
  const keys: string[] = [];
  for (const [block, items] of Object.entries(resolved) as Array<[string, ResolvedItem[]]>) {
    items.forEach((it, i) => {
      const key = `${block}#${i}`;
      keys.push(key);
      FACE_SAMPLE_FRACTIONS.forEach((q, k) => {
        const path = join(dir, `${block}-${i}-${k}.png`);
        grabFrame(source, it.interval.start + (it.interval.end - it.interval.start) * q, path);
        jobs.push({ key, path });
      });
    });
  }
  writeJson(join(dir, "in.json"), jobs);
  run(ctx.python, ["-P", FACE_PY, join(dir, "in.json"), join(dir, "out.json")], { inheritStderr: true });
  const results = itemFramings(readJson<FrameDetection[]>(join(dir, "out.json"), "face_detect"), keys);
  for (const r of results) {
    const [block, idx] = r.key.split("#");
    if (!r.framing) console.error(`[aviso] ${block}[${idx}]: rosto não detectado em ${r.total} frame(s); mantém o framing atual`);
    else console.log(`${block}[${idx}]  ${r.found}/${r.total} frames  faceX ${r.framing.faceX}  eyeY ${r.framing.eyeY}  rosto ${((r.faceH ?? 0) * 100).toFixed(1)}% da altura`);
  }
  rmSync(dir, { recursive: true, force: true });
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
    console.error(`[premissa] ${block}[${idx}]: já tinha framing no blocks.json; mantido (medido agora: ${k.measured.faceX}/${k.measured.eyeY}; --overwrite troca)`);
  }
  console.error(`[video-montagem] face --write: framing de ${changed} item(ns) gravado em ${path}${kept.length ? `, ${kept.length} mantido(s)` : ""} (a caneca segue a do framing do arquivo, #12560)`);
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
  const bounds = fileBounds(pf.source);
  plan.clips.forEach((c, i) => {
    const a = c.frameIn / fps;
    const b = c.frameOut / fps;
    const row = `${i + 1} ${c.block} ${clockTime(a)} ${(c.script ?? "").slice(0, 120)}`;
    const fileEnd = bounds[c.file ?? 0]?.end ?? Number.POSITIVE_INFINITY;
    gazeMarks(a, b, i === plan.clips.length - 1, fileEnd).forEach((m, k) => {
      const path = join(dir, `g${String(i).padStart(3, "0")}-${k}.png`);
      grabFrame(pf.source, m.t, path);
      jobs.push({ row, label: m.label, path });
    });
  });
  writeJson(join(dir, "in.json"), jobs);
  const out = join(ctx.workDir, `gaze-${sequenceKey(plan.spec)}.jpg`);
  run(ctx.python, ["-P", FACE_PY, "--sheet", join(dir, "in.json"), out], { inheritStderr: true });
  rmSync(dir, { recursive: true, force: true });
  console.log(out);
  console.error(`[video-montagem] folha de olhar de ${plan.spec.name}: ${plan.clips.length} clipe(s); olhar fora, olhos fechados ou careta = trocar a tomada (#12560)`);
  return 0;
}

function cmdRoteiro(ctx: Ctx, shortWordCheck = true): number {
  const { file, source, plans: ps, resolved } = plans(ctx);
  // As linhas "alternativa" da decupagem viram as opções B, C… do roteiro (#11361).
  const tr = readJson<Transcript>(f(ctx, "transcript.json"), "transcript.json (rode transcribe)");
  const dplan = loadDecupagemPlan(ctx, tr.segments);
  const alternatives = dplan ? alternativesFromDecupagem(buildDecupagemDoc(dplan, tr.segments, loadVocab().rules)) : undefined;
  const sil = silences(ctx);
  for (const p of ps) {
    const t = verticalTargetCheck(p, resolved, source.fps, { targetS: file.verticalTargetS, silences: sil });
    if (t) console.error(`[aviso] ${verticalTargetWarning(p.spec.name, t)}`);
  }
  // #12571: cada versão fecha com o card de CTA (salvo ctaCard: false), com a linha de compartilhar dela.
  const ctaCardShare = file.ctaCard === false ? undefined : Object.fromEntries(ps.map((p) => [sequenceKey(p.spec), ctaShareLine(p.spec.ctaShare ?? file.ctaShare)]));
  // #12585: o título de cada vídeo, das mesmas funções do build e dos publicadores.
  const videoTitles = videoTitlesFor(ps.map((p) => p.spec), { blocksTitle: file.screenTitle, d1Title: readD1Title(ctx.edition) });
  const base = roteiroMarkdown(ctx.edition, ps, resolved, source.fps, { alternatives, verticalTargetS: file.verticalTargetS, silences: sil, ctaCardShare, videoTitles });
  // #11956: os achados do fact-check da fala entram no Doc do Gate 2.
  const fcPath = f(ctx, VIDEO_FACT_CHECK_FILE);
  let fc: ReturnType<typeof parseVideoFactCheck> | null = null;
  let fcError: string | null = null;
  if (existsSync(fcPath)) {
    try { fc = parseVideoFactCheck(readJson<unknown>(fcPath, VIDEO_FACT_CHECK_FILE)); } catch (e) { fcError = (e as Error).message; }
  }
  const section = factCheckSection(fc, factCheckItems(ps, resolved));
  if (fcError) {
    // Ilegível não é "não rodou": o Doc diz o motivo, e o roteiro sai assim mesmo.
    section.lines.splice(2, 1, `**[aviso] fact-check ilegível (${mdCell(fcError)}):** rodar o agent de novo antes de aprovar o Gate 2.`);
    console.error(`[aviso] ${fcPath} ilegível: ${fcError}; rode o agent fact-checker (mode video) de novo (#11956)`);
  } else if (!fc) console.error(`[aviso] sem ${fcPath}: rode o fact-check da fala (Passo 3a, fact-check-input + agent fact-checker mode video) antes do Gate 2 (#11956)`);
  else if (section.stale) console.error("[aviso] o roteiro mudou depois do fact-check: frases novas não foram checadas; rode o Passo 3a de novo (#11956)");
  if (section.graves) console.error(`[aviso] fact-check: ${section.graves} achado(s) grave(s) em aberto na fala (seção "Fact-check da fala" do roteiro, #11956)`);
  const short = shortWordChecks(ctx, factCheckItems(ps, resolved), shortWordCheck);
  if (short.skipped) console.error(`[aviso] palavras curtas do roteiro não conferidas (${short.skipped}): conferir no áudio os artigos e preposições antes do Gate 2 (#12093)`);
  else {
    const n = short.checks!.reduce((k, c) => k + c.divergences.length, 0);
    if (n) console.error(`[aviso] ${n} palavra(s) curta(s) do roteiro diferente(s) da retranscrição da janela: seção "Palavras curtas" do roteiro, para o editor decidir no Gate 2 (#12093)`);
  }
  const md = `${base.trimEnd()}\n\n${section.lines.join("\n")}\n\n${shortWordSection(short.checks, short.skipped).join("\n")}\n`;
  writeFileAtomic(f(ctx, "roteiro.md"), md);
  process.stdout.write(md);
  return 0;
}

/** Cache da retranscrição das janelas dos itens do roteiro (#12093). */
export const SHORT_WORD_CACHE_FILE = "roteiro-retranscribe.json";

/**
 * Palavras curtas do roteiro × retranscrição da janela de cada item (#12093),
 * numa chamada só do Python. Sem `audio.wav`, com `--no-short-word-check` ou
 * com a retranscrição falhando, devolve o motivo em `skipped` (o roteiro sai
 * assim mesmo, com o aviso no Doc).
 */
function shortWordChecks(ctx: Ctx, items: FactCheckItem[], enabled: boolean): { checks: ShortWordItemCheck[] | null; skipped?: string } {
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
  };
}

/** Saída do agent `fact-checker` em `mode: "video"` (#11956), no state dir. */
export const VIDEO_FACT_CHECK_FILE = "fact-check.json";
/** Entrada do agent (#11956), no state dir. */
export const VIDEO_FACT_CHECK_INPUT_FILE = "fact-check-input.json";

/**
 * `fact-check-input` (#11956): os itens que vão ao ar (a união das versões,
 * com a fala ouvida quando difere do pedido), o hash deles e onde estão as
 * fontes do D1 baixadas no Stage 4 (`_internal/fact-check-sources/`).
 */
function cmdFactCheckInput(ctx: Ctx): number {
  const { plans: ps, resolved } = plans(ctx);
  const items = factCheckItems(ps, resolved);
  const sourcesDir = join(editionDirFor(ctx.edition), "_internal", "fact-check-sources");
  const manifest = join(sourcesDir, "manifest.json");
  if (!existsSync(manifest)) console.error(`[aviso] sem ${manifest}: as fontes do D1 não foram baixadas (Stage 4, run-fact-checker.ts); o agent cai no WebFetch da URL do D1 (#11956)`);
  const input = {
    mode: "video" as const,
    edition: ctx.edition,
    items_sha256: factCheckItemsSha256(items),
    items,
    sources_dir: sourcesDir,
    approved_json_path: join(editionDirFor(ctx.edition), "_internal", "01-approved.json"),
    out_path: f(ctx, VIDEO_FACT_CHECK_FILE),
  };
  const path = f(ctx, VIDEO_FACT_CHECK_INPUT_FILE);
  writeJson(path, input);
  console.error(`[video-montagem] fact-check-input: ${items.length} item(ns) da fala; agent fact-checker com mode "video", input ${path}, out ${input.out_path}`);
  console.log(path);
  return 0;
}

/** #11935: um XML por sequência, nomeado por ela (`Diaria comentada_Youtube_V1.xml`). */
export function xmlFileName(seqName: string): string {
  return `${seqName.replace(/[\\/:*?"<>|]/g, "-")}.xml`;
}
export function srtFileName(seqName: string): string {
  return `${seqName} - legendas.srt`;
}
/** `label` = o destino, ou o slug do corte (`previa soberana`, não `previa instagram`). */
export function previewFileName(edition: string, label: SequenceTarget | string): string {
  return `${edition} - previa ${label}.mp4`;
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
function speechDetection(ctx: Ctx, source: SourceInfo): { cut: SpeechCut | null; reason?: string } {
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
  const energy = frameEnergies(samples, sampleRate);
  // #12263: o começo de cada ilha recua até o ataque medido contra o piso do bruto, não só o limiar fixo.
  const islands = extendIslandAttacks(energy, speechIslands(energy));
  return { cut: { islands, silences: speechPauseSilences(islands, source.durationS), energy } };
}

/** Cache separado do Whisper: nunca reamostrar o WAV de 16 kHz para medir agudos. */
function highBandEnvelope(ctx: Ctx, source: SourceInfo) {
  const input = audioInputOf(ctx, source);
  const audio = join(ctx.workDir, "audio-high-48k.wav");
  const meta = join(ctx.workDir, "audio-high-48k.meta.json");
  const st = statSync(input);
  // Só os campos do #11940 (na mesma ordem): os do limiar relativo (#11968) não
  // mudam o WAV, e entrar na chave obrigaria a reextrair do bruto à toa.
  const S = SIBILANTS;
  const key = JSON.stringify({ path: input, size: st.size, mtimeMs: st.mtimeMs, sampleRate: S.sampleRate, highpassHz: S.highpassHz, thresholdDb: S.thresholdDb, quietS: S.quietS, airS: S.airS, windowS: S.windowS });
  if (ctx.force || !existsSync(audio) || !existsSync(meta) || readFileSync(meta, "utf8").trim() !== key) {
    mkdirSync(ctx.workDir, { recursive: true });
    rmSync(meta, { force: true });
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", input, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(SIBILANTS.sampleRate), "-af", `highpass=f=${SIBILANTS.highpassHz}`, "-c:a", "pcm_s16le", audio]);
    writeFileAtomic(meta, key + "\n");
  }
  const { samples, sampleRate } = parseWavPcm16(readFileSync(audio));
  if (sampleRate !== SIBILANTS.sampleRate) throw new Error("banda alta deve ser medida a 48 kHz");
  return energyEnvelope(samples, sampleRate);
}

/** Limiar do silêncio do bruto (o do último silencedetect, #11351); sem meta, o padrão. */
function silenceThresholdDb(ctx: Ctx): number {
  const p = f(ctx, "silences.meta.json");
  const meta = existsSync(p) ? readJson<{ noiseDb?: number }>(p, "silences.meta.json") : null;
  return typeof meta?.noiseDb === "number" ? meta.noiseDb : SILENCE_DETECT.noiseDb;
}

/**
 * Retranscreve as janelas das bordas (#11500) numa chamada só do Python (o
 * modelo carrega uma vez), sem VAD e sem `condition_on_previous_text`. Cache
 * por janela em `edge-retranscribe.json`, válido para o MESMO `audio.wav`
 * (tamanho + mtime): build repetido no loop da autorrevisão não retranscreve.
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
  const st = statSync(audio);
  const id = { size: st.size, mtimeMs: st.mtimeMs };
  type Cache = { audio: typeof id; windows: Record<string, Word[]> };
  let cache: Cache = { audio: id, windows: {} };
  if (existsSync(cachePath) && !ctx.force) {
    const c = readJson<Cache>(cachePath, cacheName);
    if (c.audio?.size === id.size && c.audio?.mtimeMs === id.mtimeMs) cache = c;
  }
  const missing = windows.filter((w) => !(w.key in cache.windows));
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
  const thresholdDb = silenceThresholdDb(ctx);
  const words = nonEmptyWords(f(ctx, "transcript.json"), "transcript.json");
  const match = makeMatcher(loadVocab().aliases);
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
      const b = trimEdgeExtras(clips, heard, words, env, { thresholdDb, durationS: source.durationS, match });
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
    const assembled = assembleClips(p.spec, clips, source.fps);
    adjustments.push(...assembled.merges);
    highBandWarnings[sequenceKey(p.spec)] = highEnv
      ? highBandCutWarnings(assembled.clips.map((c) => ({ ...c, srcIn: c.frameIn / source.fps, srcOut: c.frameOut / source.fps })), highEnv)
      : ["banda alta não conferida: bruto indisponível; possível fonema cortado (#11940)"];
    warnings.push(...highBandWarnings[sequenceKey(p.spec)].map((w) => `${p.spec.name}: ${w}`));
    for (const w of speechCutWarnings(assembled.clips, env, thresholdDb)) warnings.push(`${p.spec.name}: ${w}`);
    return { ...p, clips: assembled.clips, durationFrames: assembled.durationFrames, cutAdjustments: adjustments };
  });
  return { plans: out, info: { applied: true, thresholdDb, edgeWindows: windows.size, edgesRetranscribed: heard !== null, highBandWarnings }, warnings };
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
});

/** Exportado para o teste (#12559): o refino preserva arquivo e encaixe do clipe. */
export const rawClipOf = rawOf;

/**
 * Versão do XML de cada sequência deste build (#12111): o nome passa a
 * `_V{n}`, com `n` de `pickXmlVersion` sobre os XML dessa sequência já no out
 * dir (no modo API, o cache local: versão que só existe no Drive não é vista).
 * Muda o `spec.name` dos planos (o plan.json, o srt e a prévia seguem o nome
 * novo). Devolve o fingerprint de versão de cada sequência (`xmlVersionHashOf`,
 * #12160), que vai também no `<sequence id>`.
 */
function versionPickedSequences(ctx: Ctx, picked: SequencePlan[], hash: string, opts: XmlBuildOptions): Map<SequencePlan, string> {
  const files = existsSync(ctx.outDir) ? readdirSync(ctx.outDir).filter((n) => n.endsWith(".xml")) : [];
  const hashes = new Map<SequencePlan, string>();
  for (const p of picked) {
    const versionHash = xmlVersionHashOf(hash, p, opts);
    hashes.set(p, versionHash);
    const nameVersion = sequenceNameVersion(p.spec.name);
    if (nameVersion === null) {
      console.error(`[aviso] ${p.spec.name}: nome sem _V{n}, o XML sai sem versão e sobrescreve o anterior (#12111)`);
      continue;
    }
    const existing = files.flatMap((n) => {
      const v = sequenceNameVersion(n.slice(0, -4));
      if (v === null || xmlFileName(versionedSequenceName(p.spec.name, v)) !== n) return [];
      let id: ReturnType<typeof parseSequenceIdVersion> = null;
      try { id = parseSequenceIdVersion(readFileSync(join(ctx.outDir, n), "utf8")); } catch { /* ilegível: conta como outro plano */ }
      return [{ version: v, hash: id?.hash ?? null }];
    });
    const version = pickXmlVersion(existing, versionHash, nameVersion);
    p.spec = { ...p.spec, name: versionedSequenceName(p.spec.name, version) };
  }
  return hashes;
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
  input: { blocksTitle?: string; d1Title?: string | null },
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

/**
 * #12571: o card de CTA de uma sequência, em MP4 com o fade-in embutido, na
 * pasta da edição (out dir), ao lado do bruto no XML. O nome leva o hash do
 * conteúdo (SVG, fps, duração, fade): o mesmo card é reaproveitado entre
 * builds e um XML antigo segue achando o dele. PNG intermediário no work dir.
 */
export async function renderCtaCard(input: {
  outDir: string; workDir: string; mediaPath: string; edition: string;
  width: number; height: number; fps: number; share?: string | null;
  render?: (png: string, out: string) => void;
}): Promise<{ asset: CtaCardAsset; reused: boolean }> {
  const svg = ctaCardSvg({ width: input.width, height: input.height, share: input.share });
  const hash = createHash("sha256").update(svg).update(`\0${input.fps}\0${CTA_CARD.durationS}\0${CTA_CARD.fadeInS}`).digest("hex").slice(0, 16);
  const name = ctaCardFileName(input.edition, ctaCardOrientation(input.width, input.height), hash);
  const out = join(input.outDir, name);
  const reused = existsSync(out);
  if (!reused) {
    mkdirSync(input.workDir, { recursive: true });
    const png = join(input.workDir, name.replace(/\.mp4$/, ".png"));
    await sharp(Buffer.from(svg)).png().toFile(png);
    // Render no work dir e cópia para .part + rename: um build interrompido nunca deixa MP4 pela metade no out dir.
    const tmp = join(input.workDir, name);
    (input.render ?? ((a, b) => { run("ffmpeg", ctaCardRenderArgs({ png: a, out: b, fps: input.fps })); }))(png, tmp);
    copyFileSync(tmp, `${out}.part`);
    renameSync(`${out}.part`, out);
  }
  const p = input.mediaPath.replace(/\\/g, "/");
  const xmlPath = `${p.slice(0, p.lastIndexOf("/") + 1)}${name}`;
  return {
    asset: { path: out, xmlPath, width: input.width, height: input.height, fps: input.fps, frames: ctaCardFrames(input.fps), share: ctaShareLine(input.share) },
    reused,
  };
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

/** Relato do ganho de áudio do XML (#11755). */
export function audioGainLine(g: AudioGain | null, inputI?: number, inputTp?: number, measuredOn: "bruto" | "faixa tratada" = "bruto"): string {
  if (!g) return `[aviso] sem ganho de áudio no XML: loudness ${measuredOn === "bruto" ? "do bruto" : "da faixa tratada"} não medido (ou sem true peak para um ganho positivo); nível à mão no Premiere`;
  const why = g.limitedBy === "target" ? `alvo ${AUDIO_GAIN_TARGET_LUFS} LUFS` : g.limitedBy === "true-peak" ? `teto de ${AUDIO_GAIN_TP_CEILING_DBTP} dBTP` : "máximo do Audio Levels (+12 dB)";
  const from = inputI !== undefined ? ` (${measuredOn} ${inputI.toFixed(2)} LUFS, TP ${inputTp !== undefined && Number.isFinite(inputTp) ? inputTp.toFixed(2) : "?"} dBTP)` : "";
  return `[premissa] ganho de áudio no XML: ${g.db > 0 ? "+" : ""}${g.db.toFixed(2)} dB em cada clipe (Audio Levels, limitado pelo ${why})${from}; conferir no 1º import se o Premiere aplicou (#11755); --no-audio-gain tira`;
}

async function cmdBuild(ctx: Ctx, allowMissing: boolean, audioRefine = true, audioGain = true, titleMode: TitleMode = "png", seq?: string, speechDetect = true, audioClean = true, drive: DriveSession | null = null): Promise<number> {
  // #12089: o corte de pausas pelo detector de fala (energia + banda alta), não pelo silencedetect.
  let speech: { cut: SpeechCut | null; reason?: string } = { cut: null, reason: "--no-speech-detect" };
  if (speechDetect) {
    try { speech = speechDetection(ctx, sourceFor(ctx, loadBlocks(ctx).file)); }
    catch (e) { speech = { cut: null, reason: `detector de fala falhou: ${(e as Error).message}` }; }
  }
  if (speech.cut) console.error(`[premissa] corte de pausas pelo detector de fala (#12089): ${speech.cut.islands.length} ilhas de fala, pausa de ${SPEECH_DETECT.minGapS} s ou mais sai com ${SPEECH_DETECT.padBeforeS * 1000} ms antes da fala e ${SPEECH_DETECT.padAfterS * 1000} ms depois; o começo da fala recua até ${SPEECH_DETECT.attackMaxS * 1000} ms no ataque acima do piso do bruto + ${SPEECH_DETECT.attackAboveFloorDb} dB (#12263); --no-speech-detect volta ao silences.json`);
  else console.error(`[aviso] corte de pausas pelo silences.json (${speech.reason}): respiração e ruído de sala contam como fala num bruto quente (#12089)`);
  const { file, source, plans: ps0, hash, resolved } = plans(ctx, speech.cut);
  const refined = refineCuts(ctx, ps0, source, audioRefine, speech.cut !== null);
  refined.info.speechDetect = speech.cut ? { applied: true, islands: speech.cut.islands.length } : { applied: false, reason: speech.reason ?? "desligado" };
  const ps = refined.plans;
  for (const w of refined.warnings) console.error(`[aviso] ${w}`);
  const { framing, assumed } = effectiveFraming(file);
  if (assumed) console.error("[premissa] blocks.json sem framing: usando o da 261027 (rosto em 48% da largura, olhos em 54% da altura)");
  let problems = 0;
  // #11935: --seq grava só o XML daquela sequência e só ela barra o build; #11969: e só ela muda no plan.json.
  const picked = pickPlans(ps, seq, false);
  // #12101: a vinheta do logo depois do título; sem o MOV nesta máquina, o build segue sem ela.
  const resolvedVinheta = await loadVinhetaForDrive(drive);
  const vinheta = resolvedVinheta ? (({ localPath, ...asset }) => asset)(resolvedVinheta) : null;
  if (vinheta) {
    console.error(
      `[premissa] vinheta do logo ${vinheta.path} (${vinheta.durationS.toFixed(2)} s, ${vinheta.width}x${vinheta.height}${vinheta.fps ? `, ${vinheta.fps} fps` : ""}${vinheta.hasAudio ? ", com som numa faixa de áudio própria" : ", sem som"}) ` +
        `na faixa de vídeo do topo, ${VINHETA_AFTER_SPEECH_S} s depois da última palavra do título (sem título: aos 2 s), cabendo no quadro; conferir alpha e tamanho no 1º import (#12101)`,
    );
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
  for (const p of picked) {
    const d = p.durationFrames / source.fps;
    console.error(`== ${p.spec.name}: ${p.clips.length} clipes, ${Math.floor(d / 60)}:${(d % 60).toFixed(1).padStart(4, "0")}${file.ctaCard === false ? "" : ` + card de CTA de ${CTA_CARD.durationS} s (#12571)`}`);
    const g = ganchoWarning(p);
    if (g) console.error(`[aviso] ${g}`);
    for (const w of p.warnings ?? []) console.error(`[aviso] ${w}`);
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
    const over = shortsWarning(file.ctaCard === false ? p : { ...p, durationFrames: p.durationFrames + ctaCardFrames(source.fps) }, source.fps);
    if (over) console.error(`[aviso] ${over}`);
    const target = verticalTargetCheck(p, resolved, source.fps, { targetS: file.verticalTargetS, silences: silences(ctx) });
    if (target) console.error(`[aviso] ${verticalTargetWarning(p.spec.name, target)}`);
  }
  if (problems && !allowMissing) {
    console.error(`[erro] ${problems} problema(s) acima: corrigir o blocks.json (outra tomada, intervalo maior) ou rodar com --allow-missing`);
    return 1;
  }
  // #11641: no XML vai o caminho do bruto no Neo, não o do cache local do modo API.
  const media = xmlMediaPath(source.path, { edition: ctx.edition, drive: readBrutoDrive(ctx), xmlMediaRoot: ctx.xmlMediaRoot, driveRoot: ctx.driveRoot, apiMode: ctx.mode === "api" });
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
    ? renderCleanAudio({ src: audioInputOf(ctx, source), outDir: ctx.outDir, stateDir: ctx.stateDir, edition: ctx.edition, mediaPath, thresholdDb: silenceThresholdDb(ctx) })
    : null;
  const treated: TreatedAudio | null = treatedRun ? { path: treatedRun.path, xmlPath: treatedRun.xmlPath, filter: treatedRun.filter } : null;
  if (!audioClean) console.error("[aviso] --no-audio-clean: o áudio do XML e da prévia é o cru do bruto; aplicar o Enhance no Premiere (#12102)");
  if (treated) {
    console.error(
      `[premissa] áudio do XML e da prévia na faixa tratada ${treated.xmlPath} (${treated.filter}): aproximação do Enhance do Adobe Podcast (Background 0%, Speech 40%), o vídeo segue no bruto; ` +
        `o Enhance pode ir por cima no Premiere; redução de ruído de ${AUDIO_CLEAN.nrDb} dB igual em todo o áudio e gate suave (pausas no máximo ${-AUDIO_CLEAN.rangeDb} dB abaixo, ${AUDIO_CLEAN.attackMs}/${AUDIO_CLEAN.releaseMs} ms), sem zerar o ambiente; conferir uma pausa típica no 1º import e registrar ajuste em AUDIO_CLEAN (#12102, #12262)`,
    );
  }
  // #12102: reaproveitada, a faixa não muda no out dir e o snapshot não a sobe; entra nos pendentes se nunca subiu.
  if (treatedRun?.reused && ctx.mode === "api" && queueUploadIfMissing(f(ctx, DRIVE_UPLOADS_FILE), treatedRun.path)) {
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
        const { asset, reused } = await renderCtaCard({ outDir: ctx.outDir, workDir: ctx.workDir, mediaPath, edition: ctx.edition, width: p.spec.width, height: p.spec.height, fps: source.fps, share });
        ctaCard[sequenceKey(p.spec)] = asset;
        // Reaproveitado, o card não muda no out dir e o snapshot não o sobe; entra nos pendentes se nunca subiu.
        if (reused && ctx.mode === "api") queueUploadIfMissing(f(ctx, DRIVE_UPLOADS_FILE), asset.path);
        console.error(
          `[premissa] card de CTA no fim de ${p.spec.name}: ${basename(asset.path)}${reused ? " (reaproveitado)" : ""}, ${CTA_CARD.durationS} s na V1 depois do último clipe, fade-in de ${CTA_CARD.fadeInS} s do preto no próprio MP4, sem áudio; ` +
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
    writeFileAtomic(xmlPath, buildXmeml([p], source, framing, { mediaPath, mediaPaths, fileOverrides: file.files, audioGain: gain, screenTitle, screenTitleByCorte, sequenceIds, vinheta, audioPath: treated?.xmlPath ?? null, ctaCard }));
    xmlPaths.push(xmlPath);
    console.error(`[video-montagem] versão vigente de ${sequenceKey(p.spec)}: ${p.spec.name} (${basename(xmlPath)}, id ${sequenceIds?.[sequenceKey(p.spec)] ?? "sem versão"}; #12111)`);
  }
  // #11969: com --seq, só as sequências reconstruídas (e conferidas acima) mudam no plan.json.
  const planPath = f(ctx, "plan.json");
  let prevPlan: PlanFile | null = null;
  // #12285: sem --seq o plano anterior também é lido, só para a versão do XML de cada sequência (o `since` de um rebuild com o mesmo id).
  if (existsSync(planPath)) {
    try { prevPlan = readJson<PlanFile>(planPath, "plan.json"); } catch (e) { console.error(`[aviso] plan.json anterior ilegível (${(e as Error).message}): ${seq ? "só a sequência do --seq entra no plano novo" : "a versão de cada XML conta como nova"}`); }
  }
  const merged = mergeBuildPlan({
    next: { edition: ctx.edition, hash, source, framing, framingAssumed: assumed, ...(file.files ? { fileOverrides: file.files } : {}), plans: ps, cutRefine: refined.info, xmlAssets: Object.fromEntries(picked.map((p) => [sequenceKey(p.spec), { ...(treated ? { treatedAudio: treated } : {}), ...(vinheta ? { vinheta } : {}), ...(ctaCard[sequenceKey(p.spec)] ? { ctaCard: ctaCard[sequenceKey(p.spec)] } : {}) }])) },
    pickedKeys: new Set(picked.map((p) => sequenceKey(p.spec))),
    prev: prevPlan,
    now: Date.now(),
    xmlIds,
    prevXmlIds,
  });
  if (merged.dropped.length) console.error(`[aviso] --seq ${seq}: ${merged.dropped.join(", ")} fora do plan.json (entradas mudaram desde o build delas, e o XML delas é o antigo); rode build sem --seq, ou com --seq de cada uma, antes de srt/preview delas (#11969)`);
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
  writeFileAtomic(input.path, input.srt);
  const file = origin ? { size: origin.size, mtimeMs: origin.mtimeMs, driveModifiedTime: origin.driveModifiedTime } : null;
  writeJson(input.recordPath, {
    path: input.path,
    sha256: createHash("sha256").update(input.srt).digest("hex"),
    writtenAt: (input.now ?? new Date()).toISOString(),
    ...(origin ? { fromExport: origin.name } : {}),
    ...(file && Object.values(file).some((v) => v !== undefined && v !== null) ? { fromExportFile: file } : {}),
    ...(origin && input.sequenceId ? { fromExportSequenceId: input.sequenceId } : {}),
  });
  return decision;
}

/** O horizontal: a única sequência cujo SRT vai para o upload do YouTube (#11957). */
export const isYoutubeSpec = (s: Pick<SequenceSpec, "target" | "corte" | "width" | "height">) => s.target === "youtube" && s.corte === undefined && !isVerticalSpec(s);

/** As sequências do `srt` (#11957): sem `--seq`, todas, o horizontal também; com ele, a escolhida (`youtube` inclusive). */
export function srtPlans<P extends { spec: Pick<SequenceSpec, "target" | "corte" | "width" | "height"> }>(all: P[], seq: string | undefined): P[] {
  return pickPlans(all, seq, false);
}

/**
 * #12078: o plano do horizontal para o `srt --from-final`. Só o horizontal
 * (a legenda que o YouTube recebe); `--seq` ausente ou `youtube`.
 */
export function fromFinalPlan<P extends { spec: Pick<SequenceSpec, "target" | "corte" | "width" | "height"> }>(all: P[], seq: string | undefined): P {
  if (seq !== undefined && seq !== "youtube") throw new Error(`--from-final só gera a legenda do horizontal (--seq youtube), veio --seq ${seq}`);
  const hit = all.filter((p) => isYoutubeSpec(p.spec));
  if (hit.length === 0) throw new Error("plan.json sem a sequência youtube (o horizontal): rode build --seq youtube antes do srt --from-final");
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
 * do roteiro onde casa, `alignPunctuationToScript`), para export reeditado
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
    const words = alignPunctuationToScript(inVideo, input.plan.script, input.aliases);
    const cues = segmentCues(words);
    const notes = [`[premissa] ${label}: legenda com o texto ouvido no export (--heard-text), não o roteiro do plan.json; conferir grafia e números antes de subir (#12198)`];
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
function writeYoutubeSrtCopy(ctx: Ctx, srt: string, origin?: ExportOrigin, sequenceBuiltAtMs?: number, sequenceId?: string | null): ReturnType<typeof youtubeSrtCopyDecision> {
  const path = join(editionDirFor(ctx.edition), youtubeCaptionFileName(ctx.edition));
  const decision = applyYoutubeSrtCopy({ path, recordPath: f(ctx, "youtube-srt.json"), srt, force: ctx.force, origin, sequenceBuiltAtMs, sequenceId });
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
  const pf = readJson<PlanFile>(planPath, "plan.json (rode build --seq youtube)");
  if (!Array.isArray(pf.plans)) throw new Error(`plan.json malformado (sem a lista plans): rode build --seq youtube (${f(ctx, "plan.json")})`);
  const plan = fromFinalPlan(pf.plans, seq);
  if (typeof plan.script !== "string") throw new Error(`plan.json malformado (o horizontal sem script): rode build --seq youtube (${f(ctx, "plan.json")})`);
  try {
    if (pf.hash !== planHash(ctx, loadBlocks(ctx).text)) console.error("[aviso] plan.json defasado (entradas mudaram depois do build): usando o roteiro do horizontal gravado nele, o do XML de onde o export saiu (#12078)");
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
  const durationS = Number(JSON.parse(run("ffprobe", ["-v", "error", "-show_format", "-of", "json", path]).stdout).format?.duration);
  if (!Number.isFinite(durationS) || durationS <= 0) throw new Error(`duração ilegível no ffprobe (${path})`);
  const vocab = loadVocab();
  let blockRules: VocabRule[] = [];
  try {
    blockRules = loadBlocks(ctx).file.vocabulary ?? [];
  } catch (e) {
    console.error(`[aviso] blocks.json ilegível (${(e as Error).message}): só o vocabulário do projeto na legenda`);
  }
  const heard = transcribeExport(ctx, path, sequenceKey(plan.spec));
  const { srt, notes: seqNotes, problems } = srtFromExport({ heard, plan, rules: [...vocab.rules, ...blockRules], aliases: vocab.aliases, durationS, text, warn: (w) => console.error(`[aviso] ${w}`) });
  for (const n of seqNotes) console.error(n);
  if (problems.length) {
    // #12198: nada gravado (nem o out dir nem a cópia da pasta da edição): o --captions-only seguinte publicaria isto.
    for (const p of problems) console.error(`[erro] legenda do export ${basename(path)}: ${p}`);
    console.error(exportSrtRefusalHint(ctx.edition, path, text));
    return 1;
  }
  mkdirSync(ctx.outDir, { recursive: true });
  const out = join(ctx.outDir, srtFromExportFileName(plan.spec.name));
  writeFileAtomic(out, srt);
  console.log(out);
  const decision = writeYoutubeSrtCopy(ctx, srt, origin, undefined, sequenceId);
  if (decision === "keep-edited") {
    // Sair 0 aqui deixaria o backfill seguir para o --captions-only com a cópia antiga (tempo da montagem).
    const copy = join(editionDirFor(ctx.edition), youtubeCaptionFileName(ctx.edition));
    console.error(
      `[erro] ${copy} foi editado à mão depois do último srt e NÃO foi substituído: a legenda do export está em ${out}. ` +
        `Rode de novo com --force para gravá-la na pasta da edição, ou envie-a direto: npx tsx scripts/publish-youtube.ts ${ctx.edition} --captions-only --captions "${out}" (#12078)`,
    );
    return 1;
  }
  const notesPath = f(ctx, SRT_NOTES_FILE);
  const notes: Record<string, string[]> = existsSync(notesPath) ? readJson<Record<string, string[]>>(notesPath, SRT_NOTES_FILE) : {};
  notes[sequenceKey(plan.spec)] = seqNotes;
  writeJson(notesPath, notes);
  return 0;
}

function cmdSrt(ctx: Ctx, target: string | undefined, fromRaw: boolean): number {
  const pf = loadPlan(ctx);
  const { file } = loadBlocks(ctx);
  const vocab = loadVocab();
  const rules = [...vocab.rules, ...(file.vocabulary ?? [])];
  mkdirSync(ctx.outDir, { recursive: true });
  const fps = pf.source.fps;
  // #12093: o que o alinhamento decidiu (ouvido × roteiro) vira item do relatório final, não só stderr.
  const notesPath = f(ctx, SRT_NOTES_FILE);
  const notes: Record<string, string[]> = existsSync(notesPath) ? readJson<Record<string, string[]>>(notesPath, SRT_NOTES_FILE) : {};
  for (const plan of srtPlans(pf.plans, target)) {
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
    if (isYoutubeSpec(plan.spec)) {
      // #12285: a versão do XML (id + since), não o builtAt de todo build, decide se o export da legenda ficou velho.
      const v = xmlVersionAt(pf, sequenceKey(plan.spec), mtime(f(ctx, "plan.json")));
      writeYoutubeSrtCopy(ctx, srt, undefined, v.builtAtMs, v.sequenceId);
    }
  }
  writeJson(notesPath, notes);
  console.error(`[video-montagem] ouvido × roteiro de cada legenda em ${notesPath}: itens a conferir no relatório final (#12093)`);
  return 0;
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
export function previewSubtitleDecision(input: { srtPath: string; exists: boolean; srtMtimeMs?: number; builtAtMs: number; noSubs: boolean }): { use: boolean; message: string | null } {
  if (input.noSubs) return { use: false, message: "[video-montagem] prévia sem legenda (--no-subs): as legendas (srt) vêm depois da aprovação das prévias (#12579)" };
  if (!input.exists) return { use: false, message: `[aviso] sem ${input.srtPath}: a prévia sai sem legenda; as legendas (srt) vêm depois da aprovação das prévias (#12579)` };
  if ((input.srtMtimeMs ?? 0) < input.builtAtMs) {
    return { use: false, message: `[aviso] ${input.srtPath} é mais velho que o build desta sequência no plan.json: a prévia sai sem legenda; rode srt depois da aprovação das prévias (e a prévia de novo, se quiser a legenda queimada) (#12579)` };
  }
  return { use: true, message: null };
}

async function cmdPreview(ctx: Ctx, target: string | undefined, drive: DriveSession | null = null, noSubs = false): Promise<number> {
  const pf = loadPlan(ctx);
  // #12096: `--seq youtube` também (o horizontal, 960x540); sem --seq, a vertical da edição.
  const [plan] = pickPlans(pf.plans, target ?? "outras-redes", false, true);
  if (pf.framingAssumed) console.error("[premissa] blocks.json sem framing: usando o da 261027 (o mesmo do build)");
  for (const w of framingWarningsByFile([plan], pf.source, pf.framing, pf.fileOverrides).mug) console.error(`[aviso] ${w}`);
  const fps = pf.source.fps;
  const srt = join(ctx.outDir, srtFileName(plan.spec.name));
  const planPath = f(ctx, "plan.json");
  // #11969: contra o build DESTA sequência, não o último build de qualquer uma. #12579: defasado = prévia sem legenda, não recusa.
  const srtExists = existsSync(srt);
  const subs = previewSubtitleDecision({ srtPath: srt, exists: srtExists, srtMtimeMs: srtExists ? mtime(srt) : undefined, builtAtMs: sequenceBuiltAt(pf, sequenceKey(plan.spec), mtime(planPath)), noSubs });
  if (subs.message) console.error(subs.message);
  const dir = join(ctx.workDir, `previa-${sequenceKey(plan.spec)}`);
  mkdirSync(dir, { recursive: true });
  const list: string[] = [];
  const size = previewSize(plan.spec);
  // #12101/#12102: o que o XML DESTA sequência levou (gravado no build dela), não o que o config diz agora.
  const assets = pf.xmlAssets?.[sequenceKey(plan.spec)] ?? {};
  const treated = assets.treatedAudio;
  const audioSrc = treated && existsSync(treated.path) ? treated.path : undefined;
  if (treated && !audioSrc) console.error(`[aviso] faixa de áudio tratada ausente (${treated.path}): prévia com o áudio cru do bruto; rode build nesta máquina (#12102)`);
  else if (!treated) console.error("[aviso] o XML desta sequência saiu sem faixa de áudio tratada (--no-audio-clean, falha no render ou build anterior ao #12102): prévia com o áudio cru");
  // #12559: bruto em vários arquivos: vídeo do arquivo do clipe em tempo local, áudio da faixa global (tratada, ou o concatenado).
  const multi = isMultiSource(pf.source);
  const multiAudio = multi ? (audioSrc ?? audioInputOf(ctx, pf.source)) : undefined;
  plan.clips.forEach((c, i) => {
    const name = `c${String(i).padStart(2, "0")}.mp4`;
    if (multi) {
      // A mesma geometria do XML (arquivo, encaixe, framing do arquivo e do item).
      const g = clipGeometry({ source: pf.source, spec: plan.spec, framing: pf.framing, fileOverrides: pf.fileOverrides, clip: c });
      const off = g.file.offsetFrames;
      run("ffmpeg", previewClipArgs({
        src: g.file.path, start: (c.frameIn - off) / fps, end: (c.frameOut - off) / fps,
        crop: g.main.crop ?? { x: 0, y: 0, w: g.file.width, h: g.file.height }, mirrored: g.mirrored, fps, out: join(dir, name), ...size,
        audioSrc: multiAudio, audioStart: c.frameIn / fps, fit: g.fit,
      }));
      list.push(`file '${name}'`);
      console.error(`[video-montagem] clipe ${i + 1}/${plan.clips.length} (${c.block}, ${g.file.id}${g.fit !== "fill" ? `, ${g.fit}` : ""})`);
      return;
    }
    // #12096: o recorte do XML (framingFor com a escala e o eyeFraction da sequência).
    const crop = previewCropFor(pf.source, plan.spec, clipFraming(pf.framing, c), c.scale);
    // #12559: `fit` explícito no bruto único (o default segue fill): o mesmo encaixe do XML.
    const fit = clipGeometry({ source: pf.source, spec: plan.spec, framing: pf.framing, clip: c }).fit;
    // Corte pelos FRAMES do plano, os mesmos do XML.
    run("ffmpeg", previewClipArgs({ src: pf.source.path, start: c.frameIn / fps, end: c.frameOut / fps, crop, mirrored: pf.source.mirrored, fps, out: join(dir, name), ...size, ...(audioSrc ? { audioSrc } : {}), ...(fit !== "fill" ? { fit } : {}) }));
    list.push(`file '${name}'`);
    console.error(`[video-montagem] clipe ${i + 1}/${plan.clips.length} (${c.block})`);
  });
  // #12571: o card de CTA que o XML desta sequência levou, como último clipe (com áudio em silêncio para o concat).
  const card = assets.ctaCard ?? null;
  let cardS = 0;
  if (card && existsSync(card.path)) {
    const name = `c${String(plan.clips.length).padStart(2, "0")}-cta-card.mp4`;
    try {
      // O mesmo formato de pixel dos clipes do bruto (o concat não recodifica); ffprobe falho = o do card.
      let pixFmt: string | undefined;
      try { pixFmt = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", join(dir, "c00.mp4")]).stdout.trim() || undefined; } catch { pixFmt = undefined; }
      run("ffmpeg", ctaCardPreviewClipArgs({ src: card.path, out: join(dir, name), fps, ...size, durationS: card.frames / fps, pixFmt }));
      list.push(`file '${name}'`);
      cardS = card.frames / fps;
      console.error(`[video-montagem] card de CTA no fim da prévia (${cardS.toFixed(2)} s, #12571)`);
    } catch (e) {
      console.error(`[aviso] card de CTA na prévia falhou (${(e as Error).message.split("\n")[0]}): prévia sem o card; o XML o tem (#12571)`);
    }
  } else if (card) console.error(`[aviso] card de CTA do XML não encontrado nesta máquina (${card.path}): prévia sem ele; rode build nesta máquina (#12571)`);
  writeFileSync(join(dir, "list.txt"), list.join("\n") + "\n");
  run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "joined.mp4"], { cwd: dir });
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
  const plain = [...(subtitles ? ["-vf", subtitles] : []), "-af", LOUDNORM_TARGET];
  const finalArgs = (filters: string[]) => [
    "-y", "-v", "error", "-i", "joined.mp4", ...filters,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "previa.mp4",
  ];
  if (vinheta && vs) {
    console.error(`[video-montagem] prévia com a vinheta do logo em ${(vs.start / fps).toFixed(2)} s (#12101)`);
    const withVinheta = ["-i", vinheta.path, "-filter_complex", previewVinhetaFilter({ startS: vs.start / fps, scale: (vinhetaScalePct(vinheta, plan.spec) / 100) * (size.width / plan.spec.width), hasAudio: vinheta.hasAudio, subtitles, loudnorm: LOUDNORM_TARGET }), "-map", "[vout]", "-map", "[aout]"];
    try {
      run("ffmpeg", finalArgs(withVinheta), { cwd: dir });
    } catch (e) {
      // #12101: o overlay nunca derruba a prévia: refaz sem a vinheta.
      console.error(`[aviso] sobrepor a vinheta na prévia falhou (${(e as Error).message.split("\n")[0]}): prévia sem a vinheta; o XML a tem (#12101)`);
      run("ffmpeg", finalArgs(plain), { cwd: dir });
    }
  } else run("ffmpeg", finalArgs(plain), { cwd: dir });
  copyFileSync(join(dir, "previa.mp4"), out);
  // 14 quadros (7x2) espalhados pela prévia inteira, qualquer que seja a duração.
  const dur = Math.max(1, plan.durationFrames / fps + cardS);
  const sheet = f(ctx, `previa-${sequenceKey(plan.spec)}.jpg`);
  run("ffmpeg", ["-y", "-v", "error", "-i", join(dir, "previa.mp4"), "-vf", `fps=${(14 / dur).toFixed(4)},scale=${isVerticalSpec(plan.spec) ? 270 : 480}:-1,tile=7x2`, "-frames:v", "1", sheet]);
  console.log(JSON.stringify({ preview: out, sheet }, null, 2));
  return 0;
}

const REVIEW_SILENCE_FILTER = "silencedetect=noise=-40dB:d=0.08";

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

function cmdReview(ctx: Ctx, target: string | undefined): number {
  const pf = loadPlan(ctx);
  // #12096: o horizontal também (`--seq youtube`), com a mesma recusa de prévia mais velha que o build.
  const [plan] = pickPlans(pf.plans, target ?? "outras-redes", false, true);
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
  const findings = reviewPreview({ words, audioEndS, script: plan.script, cuts: cutPoints(plan, pf.source.fps), durationS: speechS, aliases: loadVocab().aliases }).map((x) => ({
    ...x,
    srcAt: exportTimeToRaw(x.at, plan, pf.source.fps),
  }));
  const highBandWarnings = pf.cutRefine?.highBandWarnings?.[sequenceKey(plan.spec)]
    ?? ["build sem verificação de banda alta: rode build com o bruto disponível (#11940)"];
  for (const warning of highBandWarnings) console.error(`[aviso] ${warning}`);
  // #11939: a caneca na folha de frames da prévia; o cálculo diz em que escala ela não sai inteira.
  const mugWarnings = framingWarningsByFile([plan], pf.source, pf.framing, pf.fileOverrides).mug;
  for (const warning of mugWarnings) console.error(`[aviso] ${warning}`);
  const card = scope.cardS > 0 ? { cardS: scope.cardS, warnings: scope.warnings } : undefined;
  writeJson(f(ctx, `review-${sequenceKey(plan.spec)}.json`), { preview, durationS, findings, highBandWarnings, mugWarnings, pauses, ...(card ? { ctaCard: card } : {}) });
  console.log(JSON.stringify({ preview, durationS, findings, highBandWarnings, mugWarnings, pauses, ...(card ? { ctaCard: card } : {}) }, null, 2));
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
  try {
    const pf = loadPlan(ctx);
    // Pela identidade; sem ela, o único plano do destino (`--seq instagram` num blocks.json de 1 extra).
    const sameTarget = pf.plans.filter((p) => p.spec.target === target);
    plan = pf.plans.find((p) => sequenceKey(p.spec) === key) ?? (sameTarget.length === 1 ? sameTarget[0] : null);
    planFps = pf.source.audioOnly ? null : pf.source.fps;
    if (!plan) console.error(`[aviso] plan.json sem a sequência ${key}: texto não comparado com o roteiro`);
  } catch (e) {
    console.error(`[aviso] sem plan.json válido (${(e as Error).message}): texto não comparado, sem tempo no bruto`);
  }

  const crop = parseCropdetect(
    run("ffmpeg", ["-hide_banner", "-nostats", "-i", path, "-vf", "fps=1,cropdetect=limit=24:round=2:reset=0", "-an", "-f", "null", "-"]).stderr,
  );
  findings.push(...checkFormat(probe, target, { crop, expectedFps: planFps }));

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
    findings.push(...checkText({ audioEndS: audioEndFromSilences(sil, probe.durationS), words: transcribeExport(ctx, path, key, true), plan, fps: planFps ?? 30, durationS: probe.durationS, aliases: loadVocab().aliases }));
  }

  const table = finalReviewTable(findings);
  mkdirSync(ctx.stateDir, { recursive: true });
  writeFileAtomic(f(ctx, `review-final-${key}.md`), `# Revisão do export: ${basename(path)}\n\n${table}`);
  writeJson(f(ctx, `review-final-${key}.json`), { file: path, target, sequence: key, probe, crop, loudness: loud, findings });
  process.stdout.write(table);
  console.error(`[video-montagem] review-final: ${findings.length} achado(s) em ${basename(path)} (sequência ${key}, destino ${target}); tabela em ${f(ctx, `review-final-${key}.md`)}`);
  return 0;
}

// ── Drive pela API, fora do Neo (#11639, #11640, #11641) ─────────────────

/** Registro do bruto baixado pela API (no state dir): id, nome no Drive e o caminho do cache. */
export const BRUTO_DRIVE_FILE = "bruto.drive.json";
/** O que já subiu para a pasta da edição (nome → id/link) e o que ficou pendente. */
export const DRIVE_UPLOADS_FILE = "drive-uploads.json";
/** Saída quando o comando deu certo e só o upload para o Drive falhou (as saídas estão no out dir). */
export const EXIT_UPLOAD_FAILED = 4;

export const SUBCOMMANDS = ["transcribe", "inventory", "decupagem", "retranscribe", "frame", "face", "gaze", "roteiro", "fact-check-input", "build", "verify-xml", "srt", "preview", "review", "review-final", "upload"] as const;
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
    if (!id) throw new Error("modo API do Drive sem pasta YouTube: preencha publishing.youtube.drive_folder_id no platform.config.json ou passe --folder-id");
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
  const meta = await fetchFileMeta(d.deps, info.id);
  const metaSize = parseDriveSize(meta.size);
  if ((info.size !== null && metaSize !== null && metaSize !== info.size) || (info.modifiedTime && meta.modifiedTime && meta.modifiedTime !== info.modifiedTime)) {
    throw new Error(`o bruto ${info.name} mudou no Drive desde o transcribe (tamanho/modifiedTime): rode transcribe --force e revise a transcrição e os cortes antes de refazer o build.` +
      (opts.audioCleanBuild ? ` Build interrompido para não tratar áudio de outro bruto. Para gerar sem faixa tratada, use build ${ctx.edition} --no-audio-clean (áudio cru; confira a correspondência do bruto com a transcrição e os cortes no Premiere).` : ""));
  }
  // O cache gravado é de outra máquina (o state dir sincroniza): baixar lá não serve aqui.
  if (!toPosix(info.localPath).startsWith(toPosix(d.cacheDir) + "/")) {
    throw new Error(`bruto registrado no cache ${info.localPath}, fora do cache desta máquina (${d.cacheDir}): rode transcribe --force aqui para baixar e transcrever de novo`);
  }
  const size = metaSize ?? info.size;
  const estimate = size === null
    ? "tamanho e tempo de download desconhecidos (Drive sem tamanho)"
    : `${(size / 1e9).toFixed(2)} GB (${size} bytes); tempo estimado de download: ~${Math.max(1, Math.ceil(size / 2_000_000 / 60))} min a 2 MB/s (depende da conexão)`;
  log(`[drive] bruto ausente do cache (${source.path}); baixando o arquivo inteiro do Drive: ${estimate}`);
  if (opts.audioCleanBuild) log(`[aviso] o build precisa do bruto inteiro para tratar o áudio; para evitar o download, interrompa e use build ${ctx.edition} --no-audio-clean (XML e prévia com áudio cru; aplicar Enhance no Premiere)`);
  // Pelo nome registrado: um rename no Drive não pode mudar o caminho que o source.json aponta.
  await ensureCachedFile(d.deps, { ...meta, name: info.name }, dirname(info.localPath), log);
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
    return gone.length ? `arquivo(s) do bruto em vários arquivos ausente(s) nesta máquina: ${gone.join(", ")} (#12559: rode no Neo, com o Drive em G:)` : null;
  }
  if (existsSync(source.path)) return null;
  const info = readBrutoDrive(ctx);
  const origin = info && toPosix(info.localPath) === toPosix(source.path) ? ` (o cache do modo API de outra máquina; o bruto no Drive é ${info.name})` : "";
  return `bruto do source.json não existe nesta máquina: ${source.path}${origin}. Rode transcribe --force aqui (com o bruto em G:, ou --from-drive para baixá-lo pela API)`;
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

/** `drive-uploads.json`: o que subiu (por nome) e o que ficou pendente de uma falha anterior. */
export interface DriveUploadRegistry {
  files: Record<string, { id: string; link: string | null; at: string; from: string }>;
  pending: string[];
}

function readRegistry(path: string): DriveUploadRegistry {
  if (!existsSync(path)) return { files: {}, pending: [] };
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as Partial<DriveUploadRegistry>;
    return { files: r.files ?? {}, pending: Array.isArray(r.pending) ? r.pending : [] };
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
export async function uploadAll(ctx: Pick<Ctx, "stateDir" | "edition">, d: DriveSession, paths: string[]): Promise<{ uploaded: string[]; pending: string[]; error: string | null }> {
  const regPath = f(ctx, DRIVE_UPLOADS_FILE);
  const reg = readRegistry(regPath);
  const queue = [...new Set([...reg.pending.filter((p) => existsSync(p)), ...paths])];
  const uploaded: string[] = [];
  if (queue.length === 0) return { uploaded, pending: [], error: null };
  const save = (pending: string[]) => writeJson(regPath, { ...reg, pending });
  try {
    const folder = await d.folder();
    for (let i = 0; i < queue.length; i++) {
      const r = await uploadToFolder(d.deps, folder.id, queue[i], log);
      reg.files[r.name] = { id: r.id, link: r.webViewLink, at: new Date().toISOString(), from: queue[i] };
      uploaded.push(queue[i]);
      save(queue.slice(i + 1));
      log(`[drive] ${r.updated ? "atualizado" : "enviado"} ${d.edition}/${r.name}: ${r.webViewLink ?? r.id}`);
    }
    return { uploaded, pending: [], error: null };
  } catch (e) {
    const pending = queue.slice(uploaded.length);
    save(pending);
    return { uploaded, pending, error: (e as Error).message };
  }
}

async function cmdUpload(ctx: Ctx, d: DriveSession | null, file: string | undefined): Promise<number> {
  if (!file) throw new Error("upload exige --file PATH (ex.: o decupagem.md quando o conector do Docs falhar)");
  if (!d) throw new Error("upload é do modo API do Drive (o 300); no Neo, copie o arquivo para a pasta da edição em G:");
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`arquivo não encontrado: ${path}`);
  const r = await uploadAll(ctx, d, [path]);
  if (r.error) {
    console.error(`[erro] upload para o Drive falhou: ${r.error}. Pendentes: ${r.pending.join(", ")}`);
    return EXIT_UPLOAD_FAILED;
  }
  return 0;
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
  const ctx: Ctx = {
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
  };
  const seq = values["seq"];
  if ((VIDEO_ONLY_COMMANDS as readonly string[]).includes(cmd)) {
    const stop = audioOnlyStop(ctx, cmd);
    if (stop !== null) return stop;
  }
  const d = mode === "api" && DRIVE_COMMANDS.has(cmd)
    ? makeDriveSession(edition, cacheDir, deps ?? { driveFetch: (url, init) => gFetchRetry(url, init ?? {}), uploadFetch: (url, init) => gFetch(url, init ?? {}) }, configRootFolderId(values["folder-id"]))
    : null;
  if (mode === "api") console.error(`[video-montagem] modo API do Drive (${flags.has("from-drive") ? "--from-drive" : `sem ${driveRoot} nesta máquina`}, #11639); cache em ${cacheDir}`);
  const uploads = d && DRIVE_UPLOAD_COMMANDS.includes(cmd);
  const before = uploads ? snapshotDir(ctx.outDir, (dir) => readdirSync(dir)) : null;
  const code = await runCommand(ctx, cmd, values, flags, seq, d);
  if (before && d && code === 0) {
    const changed = changedFiles(before, snapshotDir(ctx.outDir, (dir) => readdirSync(dir))).map((n) => join(ctx.outDir, n));
    const r = await uploadAll(ctx, d, changed);
    if (r.error) {
      console.error(
        `[erro] ${cmd} terminou, mas o upload para o Drive falhou: ${r.error}. Subiram: ${r.uploaded.length ? r.uploaded.map((p) => basename(p)).join(", ") : "nenhum"}; ` +
          `pendentes (tentados de novo na próxima execução, ou: upload ${edition} --file ARQUIVO): ${r.pending.join(", ")}`,
      );
      return EXIT_UPLOAD_FAILED;
    }
  }
  return code;
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
      if (flags.has("from-audio")) throw new Error('--from-audio exige o caminho do áudio separado (ex.: --from-audio "G:/…/Diaria comentada_Youtube.wav")');
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
      return cmdFace(ctx, flags.has("write"), flags.has("overwrite"));
    case "gaze":
      await needLocalBruto();
      return cmdGaze(ctx, seq);
    case "decupagem":
      return cmdDecupagem(ctx, parsePixelF0Arg(values["pixel-f0"]));
    case "frame": {
      await needLocalBruto();
      const code = cmdFrame(ctx, values["at"]);
      return code === 0 ? cmdFrameOrientations(ctx, values["at"]) : code;
    }
    case "retranscribe":
      return cmdRetranscribe(ctx, values["from"], values["to"], flags.has("sub"));
    case "roteiro":
      return cmdRoteiro(ctx, !flags.has("no-short-word-check"));
    case "fact-check-input":
      return cmdFactCheckInput(ctx);
    case "build":
      if (flags.has("xml-flop") || "xml-flop" in values) {
        console.error("[erro] --xml-flop foi removida: o Premiere ignora o filtro Flop no import (#11358). Aplicar Horizontal Flip à mão.");
        return 2;
      }
      {
        // #12104: o modo removido (`text`) falha aqui, antes de baixar o bruto.
        const titleMode = parseTitleModeArg(values["title-mode"] ?? (flags.has("title-mode") ? "" : undefined));
        // #12209: a faixa tratada lê o bruto; no modo API ele pode ter saído do cache (o transcribe "pronto" não baixa).
        if (buildNeedsLocalBruto({ apiMode: d !== null, audioClean: !flags.has("no-audio-clean") })) await needLocalBruto();
        return cmdBuild(ctx, flags.has("allow-missing"), !flags.has("no-audio-refine"), !flags.has("no-audio-gain"), titleMode, seq, !flags.has("no-speech-detect"), !flags.has("no-audio-clean"), d);
      }
    case "srt": {
      if (flags.has("from-final")) throw new Error('--from-final exige o caminho do export (ex.: --from-final "G:/…/261103/Final/Diaria comentada_Youtube_261103.mp4")');
      let final = values["from-final"];
      if (final === undefined) {
        if (flags.has("heard-text")) throw new Error("--heard-text só vale com --from-final (a legenda pela fala do export, #12198)");
        return cmdSrt(ctx, seq, flags.has("from-raw"));
      }
      if (flags.has("from-raw")) throw new Error("--from-final e --from-raw não se combinam: a legenda do export vem da fala do export");
      // --seq e o plano antes do download: um plano sem o horizontal não baixa o export à toa.
      const plan = loadFromFinalPlan(ctx, seq);
      // Como no review-final (#11639): no modo API, o export é procurado pelo nome em Final/ da edição no Drive.
      if (d && !existsSync(final)) final = await fetchNamed(d, final, "final");
      return cmdSrtFromFinal(ctx, final, plan, flags.has("heard-text") ? "ouvido" : "roteiro");
    }
    case "preview":
      await needLocalBruto();
      return cmdPreview(ctx, seq, d, flags.has("no-subs"));
    case "review":
      return cmdReview(ctx, seq);
    case "review-final": {
      let file = values["file"];
      // #11639: no modo API, o export é procurado pelo nome em Final/ da edição no Drive.
      if (d && file !== undefined && !existsSync(file)) file = await fetchNamed(d, file, "final");
      return cmdReviewFinal(ctx, file, seq, !flags.has("no-text"));
    }
    case "upload":
      return cmdUpload(ctx, d, values["file"]);
  }
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(), { onError: (e) => console.error("video-montagem:", e instanceof Error ? e.message : e) });
}
