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
 *   build AAMMDD [--seq youtube|instagram|outras-redes|{corte}] [--allow-missing] [--no-audio-refine] [--no-audio-gain] [--title-mode png|text|off] [--no-speech-detect] [--no-audio-clean]
 *       (#12102) o áudio dos clipes do XML (e da prévia) vem de `{AAMMDD}_audio_tratado.wav`, o áudio
 *       do bruto com afftdn + agate (aproximação do Enhance do Adobe Podcast), ao lado do bruto;
 *       ffmpeg falho = áudio cru com [aviso]; --no-audio-clean tira.
 *       (#12101) vinheta do logo (publishing.video.vinheta_logo.path) na faixa do topo, no fim do
 *       título; respiro de 0,7 s depois do título no horizontal.
 *       (#12089) o corte de pausas vem do detector de fala (`SPEECH_DETECT`, bruto a 48 kHz em
 *       quadros de 5 ms: sinal cheio acima de -33 dBFS ou 1ª diferença acima de -46 dBFS; pausa
 *       de 0,32 s ou mais sai com 150 ms antes da fala e 120 ms depois; ilha abaixo de 60 ms é
 *       estalo), não do silencedetect; avisa emenda com pausa acima de 0,45 s, clipe abaixo de
 *       0,3 s e borda dentro da fala. --no-speech-detect (ou o bruto ausente) volta ao silences.json.
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
 *       Ganho de áudio (#11755): Audio Levels em cada clipe de áudio, do `loudness.json`, para
 *       -14 LUFS com teto -1 dBTP (`audioGainFor`); --no-audio-gain tira. Título nas verticais
 *       (#11756): faixa V2 no bloco `titulo` (sem ele, no 1º bloco) com o `screenTitle` do
 *       blocks.json ou o título do D1 (`02-reviewed.md`); --title-mode png (padrão desde o #12091:
 *       o PNG com fundo a 70% como clipe na V2, pendente de conferência no 1º import com o PNG
 *       via XML), text (gerador de
 *       texto do FCP7 sobre fundo Color+Crop, só por flag, ainda não validado) ou off.
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
 *   preview AAMMDD [--seq youtube|instagram|outras-redes|{corte}]   (default a vertical da edição; sempre refaz)
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
  faceCenterWarnings,
  forceAlignToScript,
  forcedAlignmentNotes,
  ganchoWarning,
  parseSequenceIdVersion,
  pickXmlVersion,
  sequenceNameVersion,
  versionedSequenceId,
  versionedSequenceName,
  frameCropOverlays,
  loudnessWarning,
  mugFramingWarnings,
  makeMatcher,
  mapWordsToSequence,
  trimWordsToSilences,
  isVerticalSpec,
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
  previewSize,
  resolveBlocks,
  reviewPreview,
  screenTitleSvg,
  normalizeToken,
  segmentCues,
  sequenceSourceRanges,
  srtTimestamp,
  silenceNoiseDb,
  transcriptWords,
  validateVocabRules,
  audioCleanArgs,
  audioCleanFilter,
  audioCleanParams,
  parseVinhetaProbe,
  previewVinhetaFilter,
  vinhetaBreathFor,
  vinhetaConfigFrom,
  vinhetaScalePct,
  vinhetaSpan,
  titleBreathS,
  VINHETA_AFTER_SPEECH_S,
  type VinhetaAsset,
  type AudioGain,
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
  type EdgeWindow,
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
import { stripInlineMarkdown } from "./lib/diaria/youtube-video.ts";
import { youtubeCaptionFileName } from "./lib/diaria/youtube-captions.ts";
import { factCheckItems, factCheckItemsSha256, factCheckSection, parseVideoFactCheck, type FactCheckItem } from "./lib/diaria/video-fact-check.ts";
import { SHORT_WORD_WINDOW_PAD_S, shortWordDivergences, shortWordSection, type ShortWordItemCheck } from "./lib/diaria/video-short-words.ts";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PY_HELPER = join(ROOT, "scripts", "video", "transcribe_words.py");
const VOCAB_FILE = join(ROOT, "context", "video-montagem", "vocabulario.json");
export { DEFAULT_DRIVE_ROOT };

const USAGE = `uso: npx tsx scripts/video-montagem.ts <transcribe|decupagem|retranscribe|frame|roteiro|fact-check-input|build|srt|preview|review|review-final|upload> AAMMDD [opções]
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
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", String(t), "-i", measured.path, "-frames:v", "1", "-filter_complex", vf, out]);
  console.log(out);
  console.error("[video-montagem] lado a lado: esquerda = bruto como gravado, direita = espelhado; o lado em que a caneca e o pôster leem certo é a orientação real (#11959)");
  console.error(`[premissa] ${mirroredPremise(measured, override)} (#11959)`);
  return 0;
}

function measuredSource(ctx: Ctx): SourceInfo {
  return readJson<SourceInfo>(f(ctx, "source.json"), "source.json (rode transcribe)");
}

/** Passos que precisam de imagem: no modo áudio (#11552) param antes, dizendo o motivo. */
export const VIDEO_ONLY_COMMANDS = ["frame", "build", "srt", "preview", "review"] as const;

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
  return createHash("sha256")
    .update(inputsHash)
    .update("\0opts\0")
    .update(JSON.stringify({ speechDetect: opts.speechDetect, audioRefine: opts.audioRefine, audioGain: opts.audioGain, titleMode: opts.titleMode, ...(opts.vinheta ? { vinheta: opts.vinheta } : {}), ...(opts.audioClean ? { audioClean: opts.audioClean } : {}) }))
    .update("\0plan\0")
    .update(JSON.stringify({ spec, clips: plan.clips, durationFrames: plan.durationFrames }))
    .digest("hex")
    .slice(0, 16);
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
type SpeechCut = { silences: Interval[]; islands: Interval[] };

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
  });
  for (const w of warnings) console.error(`[aviso] ${w}`);
  if (errors.length) throw new Error(`blocks.json com problema:\n  - ${errors.join("\n  - ")}`);
  const fmt = effectiveFormat(file);
  if (!file.sequences && fmt.inferred) console.error("[premissa] blocks.json sem título nem resumo: formato entrevista, sequências abertura → comentário → CTA → fecho (#11507); `format`/`sequences` sobrepõem");
  const specs = file.sequences ?? defaultSequences("V1", fmt.format);
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
}

export interface SequenceXmlAssets {
  treatedAudio?: TreatedAudio;
  vinheta?: VinhetaAsset;
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
  next: Omit<PlanFile, "builtAt">;
  pickedKeys: ReadonlySet<string>;
  prev: PlanFile | null;
  now: number;
}): { plan: PlanFile; kept: string[]; dropped: string[] } {
  const { next, pickedKeys, prev, now } = input;
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
  }
  const cutRefine = next.cutRefine ? { ...next.cutRefine, ...(next.cutRefine.highBandWarnings ? { highBandWarnings } : {}) } : undefined;
  const { xmlAssets: _nextAssets, ...rest } = next;
  return { plan: { ...rest, plans, ...(cutRefine ? { cutRefine } : {}), builtAt, ...(Object.keys(xmlAssets).length ? { xmlAssets } : {}) }, kept, dropped };
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

function cmdTranscribe(ctx: Ctx, sourceArg: string | undefined, silenceDb: number | undefined, fromAudio?: { audio: string; transcript?: string }): number {
  mkdirSync(ctx.workDir, { recursive: true });
  mkdirSync(ctx.stateDir, { recursive: true });
  // #11504: a transcrição do áudio separado é guardada antes de qualquer coisa mexer no transcript.json.
  const audioPath = fromAudio ? normPath(fromAudio.audio) : undefined;
  if (audioPath && !existsSync(audioPath)) throw new Error(`--from-audio: arquivo não encontrado: ${audioPath}`);
  const audioTr = audioPath ? stashAudioTranscript(ctx, audioPath, fromAudio?.transcript) : null;
  let src = sourceArg ? resolve(sourceArg) : undefined;
  if (!src) {
    if (!existsSync(ctx.driveDir)) {
      throw new Error(`pasta da edição no Drive não encontrada: ${ctx.driveDir} (Drive for desktop montado? a pasta ${ctx.edition}/ ainda não sincronizou? espere, ou passe --from-drive para baixar pela API, ou --drive-root)`);
    }
    const files = readdirSync(ctx.driveDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => ({ name: d.name, size: statSync(join(ctx.driveDir, d.name)).size }));
    const raw = pickRawSource(files);
    if (!raw) throw new Error(`nenhum bruto (.mp4/.mov, ou áudio .m4a/.mp3/.wav) solto em ${ctx.driveDir}; passe --source`);
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
  let cached = existsSync(sourcePath) && !ctx.force ? readJson<SourceInfo>(sourcePath, "source.json") : null;
  if (audioPath && audioPath === srcPath) throw new Error("--from-audio aponta para o próprio bruto; o áudio separado é outro arquivo (o vídeo vai em --source ou solto na pasta)");
  // --from-audio troca o bruto do áudio para o vídeo sem --force: a transcrição do áudio já está guardada.
  if (cached && audioPath && cached.path === audioPath) cached = null;
  if (cached && cached.path !== srcPath) throw new Error(sourceConflictMessage(cached.path, srcPath));
  let source: SourceInfo;
  // source.json refeito = todos os derivados refeitos (áudio, loudness, silêncios, transcrição).
  let redo = ctx.force;
  if (cached) source = cached;
  else {
    const probe = run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", src]).stdout;
    source = parseProbe(probe, srcPath, { mirroredDefault: configMirroredDefault() });
    writeJson(sourcePath, source);
    wroteSource = true;
    redo = true;
  }
  if (source.audioOnly) {
    console.error(`[video-montagem] bruto só de áudio: ${source.path} (${source.durationS.toFixed(1)} s) — modo áudio: transcrição, decupagem e roteiro; build/srt/prévia/review param antes (#11552)`);
  } else {
    console.error(`[video-montagem] bruto: ${source.path} (${source.width}x${source.height}, ${source.fps} fps, ${source.durationS.toFixed(1)} s)`);
    console.error(`[premissa] ${mirroredPremise(source)} (#11959)`);
  }

  const audio = join(ctx.workDir, "audio.wav");
  const loudPath = f(ctx, "loudness.json");
  if (redo || !existsSync(audio) || !existsSync(loudPath)) {
    console.error("[video-montagem] extraindo o áudio (16 kHz mono) e medindo o loudness do bruto…");
    const { stderr } = run("ffmpeg", [
      "-hide_banner", "-nostats", "-y", "-i", source.path,
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
  const sequences = defaultSequences("V1", format);
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
  const { framing } = effectiveFraming(blocks ?? {});
  const out = f(ctx, `frame-${t.toFixed(1)}.jpg`);
  // #11939: os recortes de cada escala sobre o bruto desespelhado, antes do scale, em px do bruto.
  const overlays = frameCropOverlays(source, framing);
  const vf = `${source.mirrored ? "hflip," : ""}${overlays.filters.join(",")},scale=960:-2,drawgrid=w=iw/10:h=ih/10:t=1:c=white@0.6`;
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", String(t), "-i", source.path, "-frames:v", "1", "-vf", vf, out]);
  console.log(out);
  for (const w of overlays.warnings) console.error(`[aviso] ${w}`);
  console.error(`[video-montagem] mirrored=${source.mirrored}; grade em décimos: centro do rosto (faceX), linha dos olhos (eyeY) e caixa da caneca (framing.mug) em fração do quadro, no framing do blocks.json; recortes: amarelo = horizontal 50/62%, ciano = verticais 115/130%, magenta = caneca (#11939)`);
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
  const base = roteiroMarkdown(ctx.edition, ps, resolved, source.fps, { alternatives, verticalTargetS: file.verticalTargetS, silences: sil });
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
  if (!existsSync(source.path)) return { cut: null, reason: `bruto ausente nesta máquina (${source.path})` };
  const audio = join(ctx.workDir, "audio-48k.wav");
  const meta = join(ctx.workDir, "audio-48k.meta.json");
  const st = statSync(source.path);
  const key = JSON.stringify({ path: source.path, size: st.size, mtimeMs: st.mtimeMs, sampleRate: SPEECH_DETECT.sampleRate });
  if (ctx.force || !existsSync(audio) || !existsSync(meta) || readFileSync(meta, "utf8").trim() !== key) {
    mkdirSync(ctx.workDir, { recursive: true });
    rmSync(meta, { force: true });
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", source.path, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(SPEECH_DETECT.sampleRate), "-c:a", "pcm_s16le", audio]);
    writeFileAtomic(meta, key + "\n");
  }
  const { samples, sampleRate } = parseWavPcm16(readFileSync(audio));
  const islands = speechIslands(frameEnergies(samples, sampleRate));
  return { cut: { islands, silences: speechPauseSilences(islands, source.durationS) } };
}

/** Cache separado do Whisper: nunca reamostrar o WAV de 16 kHz para medir agudos. */
function highBandEnvelope(ctx: Ctx, source: SourceInfo) {
  const audio = join(ctx.workDir, "audio-high-48k.wav");
  const meta = join(ctx.workDir, "audio-high-48k.meta.json");
  const st = statSync(source.path);
  // Só os campos do #11940 (na mesma ordem): os do limiar relativo (#11968) não
  // mudam o WAV, e entrar na chave obrigaria a reextrair do bruto à toa.
  const S = SIBILANTS;
  const key = JSON.stringify({ path: source.path, size: st.size, mtimeMs: st.mtimeMs, sampleRate: S.sampleRate, highpassHz: S.highpassHz, thresholdDb: S.thresholdDb, quietS: S.quietS, airS: S.airS, windowS: S.windowS });
  if (ctx.force || !existsSync(audio) || !existsSync(meta) || readFileSync(meta, "utf8").trim() !== key) {
    mkdirSync(ctx.workDir, { recursive: true });
    rmSync(meta, { force: true });
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", source.path, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(SIBILANTS.sampleRate), "-af", `highpass=f=${SIBILANTS.highpassHz}`, "-c:a", "pcm_s16le", audio]);
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
});

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

/** `--title-mode` do build (#11756): PNG na V2 (padrão desde o #12091), gerador de texto (só por flag), ou sem título. */
export type TitleMode = "text" | "png" | "off";

export function parseTitleModeArg(v: string | undefined): TitleMode {
  if (v === undefined) return "png";
  if (v === "text" || v === "png" || v === "off") return v;
  throw new Error(`--title-mode precisa ser text, png ou off (veio "${v}")`);
}

/**
 * O título que o `build` passa ao XML para um modo (#12091): `png` = o PNG
 * como clipe (padrão), `text` = o gerador "Text" (só por flag).
 */
export function screenTitleXmlFor(mode: Exclude<TitleMode, "off">, text: string, pngXmlPath: string): ScreenTitleXml {
  return mode === "png" ? { text, mode: "png", pngPath: pngXmlPath } : { text, mode: "text" };
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

/** PNG do título (fallback do gerador de texto, #11756): sai no out dir, ao lado do XML. */
export function titlePngFileName(edition: string, corte?: string): string {
  return corte ? `${edition}_titulo_vertical-${corte}.png` : `${edition}_titulo_vertical.png`;
}

/** Caminho do PNG no XML: a mesma pasta do bruto no XML (a pasta da edição, para onde o out dir sobe). `corte` = o PNG do título daquele corte (#11900). */
export function titlePngXmlPath(mediaPath: string, edition: string, corte?: string): string {
  const p = mediaPath.replace(/\\/g, "/");
  return `${p.slice(0, p.lastIndexOf("/") + 1)}${titlePngFileName(edition, corte)}`;
}

/** Título do D1 em `02-reviewed.md` da edição; ausente ou sem D1 = null. */
function readD1Title(edition: string): string | null {
  const path = join(editionDirFor(edition), "02-reviewed.md");
  if (!existsSync(path)) return null;
  return parseDestaques(readFileSync(path, "utf8")).find((d) => d.n === 1)?.title ?? null;
}

/** Relato do ganho de áudio do XML (#11755). */
export function audioGainLine(g: AudioGain | null, inputI?: number, inputTp?: number): string {
  if (!g) return "[aviso] sem ganho de áudio no XML: loudness do bruto não medido (ou sem true peak para um ganho positivo); nível à mão no Premiere";
  const why = g.limitedBy === "target" ? `alvo ${AUDIO_GAIN_TARGET_LUFS} LUFS` : g.limitedBy === "true-peak" ? `teto de ${AUDIO_GAIN_TP_CEILING_DBTP} dBTP` : "máximo do Audio Levels (+12 dB)";
  const from = inputI !== undefined ? ` (bruto ${inputI.toFixed(2)} LUFS, TP ${inputTp !== undefined && Number.isFinite(inputTp) ? inputTp.toFixed(2) : "?"} dBTP)` : "";
  return `[premissa] ganho de áudio no XML: ${g.db > 0 ? "+" : ""}${g.db.toFixed(2)} dB em cada clipe (Audio Levels, limitado pelo ${why})${from}; conferir no 1º import se o Premiere aplicou (#11755); --no-audio-gain tira`;
}

async function cmdBuild(ctx: Ctx, allowMissing: boolean, audioRefine = true, audioGain = true, titleMode: TitleMode = "png", seq?: string, speechDetect = true, audioClean = true): Promise<number> {
  // #12089: o corte de pausas pelo detector de fala (energia + banda alta), não pelo silencedetect.
  let speech: { cut: SpeechCut | null; reason?: string } = { cut: null, reason: "--no-speech-detect" };
  if (speechDetect) {
    try { speech = speechDetection(ctx, sourceFor(ctx, loadBlocks(ctx).file)); }
    catch (e) { speech = { cut: null, reason: `detector de fala falhou: ${(e as Error).message}` }; }
  }
  if (speech.cut) console.error(`[premissa] corte de pausas pelo detector de fala (#12089): ${speech.cut.islands.length} ilhas de fala, pausa de ${SPEECH_DETECT.minGapS} s ou mais sai com ${SPEECH_DETECT.padBeforeS * 1000} ms antes da fala e ${SPEECH_DETECT.padAfterS * 1000} ms depois; --no-speech-detect volta ao silences.json`);
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
  const vinheta = loadVinheta();
  if (vinheta) {
    console.error(
      `[premissa] vinheta do logo ${vinheta.path} (${vinheta.durationS.toFixed(2)} s, ${vinheta.width}x${vinheta.height}${vinheta.fps ? `, ${vinheta.fps} fps` : ""}${vinheta.hasAudio ? ", com som numa faixa de áudio própria" : ", sem som"}) ` +
        `na faixa de vídeo do topo, ${VINHETA_AFTER_SPEECH_S} s depois da última palavra do título (sem título: aos 2 s), cabendo no quadro; conferir alpha e tamanho no 1º import (#12101)`,
    );
  }
  // #11939: a caneca é esforço, nunca barra o build; o relato diz onde ela não sai inteira.
  for (const w of mugFramingWarnings(picked, source, framing)) console.error(`[aviso] ${w}`);
  // #12093: o rosto centrado nos dois zooms; escala pequena demais bate na borda do bruto.
  for (const w of faceCenterWarnings(picked, source, framing)) console.error(`[aviso] ${w}`);
  for (const p of picked) {
    const d = p.durationFrames / source.fps;
    console.error(`== ${p.spec.name}: ${p.clips.length} clipes, ${Math.floor(d / 60)}:${(d % 60).toFixed(1).padStart(4, "0")}`);
    const g = ganchoWarning(p);
    if (g) console.error(`[aviso] ${g}`);
    for (const w of p.warnings ?? []) console.error(`[aviso] ${w}`);
    // #12101: o refino dos cortes pode encolher o respiro depois do título; conferir no plano final.
    const breath = vinhetaBreathFor(p.spec)?.titulo;
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
    if (speech.cut) for (const w of speechJoinWarnings(p.clips, speech.cut.islands, source.fps, { longJoinOkAfter: breath ? ["titulo"] : [] })) console.error(`[aviso] ${p.spec.name}: ${w}`);
    if (p.missingBlocks.length) console.error(`   faltam no blocks.json: ${p.missingBlocks.join(", ")}`);
    for (const x of p.dropped) console.error(`   ${x}`);
    for (const a of p.cutAdjustments ?? []) console.error(adjustmentLine(a));
    problems += p.missingBlocks.length + p.dropped.length;
    const over = shortsWarning(p, source.fps);
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
  // #12102: faixa de áudio tratada (aproximação do Enhance do Adobe Podcast), só depois do gate de problemas; falha do ffmpeg = áudio cru, com aviso.
  const treatedRun = audioClean
    ? renderCleanAudio({ src: source.path, outDir: ctx.outDir, stateDir: ctx.stateDir, edition: ctx.edition, mediaPath, thresholdDb: silenceThresholdDb(ctx) })
    : null;
  const treated: TreatedAudio | null = treatedRun ? { path: treatedRun.path, xmlPath: treatedRun.xmlPath, filter: treatedRun.filter } : null;
  if (!audioClean) console.error("[aviso] --no-audio-clean: o áudio do XML e da prévia é o cru do bruto; aplicar o Enhance no Premiere (#12102)");
  if (treated) {
    console.error(
      `[premissa] áudio do XML e da prévia na faixa tratada ${treated.xmlPath} (${treated.filter}): aproximação do Enhance do Adobe Podcast (Background 0%, Speech 40%), o vídeo segue no bruto; ` +
        "o Enhance pode ir por cima no Premiere; conferir as pausas no 1º import (#12102)",
    );
  }
  // #12102: reaproveitada, a faixa não muda no out dir e o snapshot não a sobe; entra nos pendentes se nunca subiu.
  if (treatedRun?.reused && ctx.mode === "api" && queueUploadIfMissing(f(ctx, DRIVE_UPLOADS_FILE), treatedRun.path)) {
    console.error(`[video-montagem] faixa tratada reaproveitada ainda não está no Drive: entra no upload deste build (#12102)`);
  }
  // #12111: cada build com plano novo abre a próxima versão (_V{n} no nome e no <sequence id>).
  // #12160: a versão também muda com as opções do build e com o plano final (detector de fala, refino).
  const versionHashes = versionPickedSequences(ctx, picked, hash, { speechDetect: speech.cut !== null, audioRefine, audioGain, titleMode, vinheta, audioClean: treated?.filter ?? null });
  // #11755: ganho do loudness.json (o mesmo que o transcribe mediu).
  let gain: AudioGain | null = null;
  if (audioGain) {
    const loudPath = f(ctx, "loudness.json");
    const loud = existsSync(loudPath) ? readJson<ReturnType<typeof parseLoudnormJson>>(loudPath, "loudness.json") : null;
    gain = audioGainFor(loud);
    console.error(audioGainLine(gain, loud?.inputI, loud?.inputTp));
  }
  // #11756: título na V2 das verticais.
  mkdirSync(ctx.outDir, { recursive: true });
  let screenTitle: ScreenTitleXml | null = null;
  const titled = titleMode === "off" ? null : firstTitledVertical(ps);
  if (titled) {
    const t = resolveScreenTitle({ blocksTitle: file.screenTitle, d1Title: readD1Title(ctx.edition) });
    if (t.text) {
      const png = join(ctx.outDir, titlePngFileName(ctx.edition));
      await sharp(Buffer.from(screenTitleSvg(t.text, titled.spec.width, titled.spec.height))).png().toFile(png);
      screenTitle = screenTitleXmlFor(titleMode === "text" ? "text" : "png", t.text, titlePngXmlPath(mediaPath, ctx.edition));
      console.error(
        `[premissa] título na vertical (${t.how === "blocks" ? "screenTitle do blocks.json" : "título do D1; screenTitle no blocks.json sobrepõe"}): "${t.text}", ` +
          (titleMode === "png"
            ? `PNG ${png} na V2 (padrão; pendente de conferência no 1º import com o PNG via XML, #12091)`
            : `gerador de texto do FCP7 na V3 sobre fundo Color+Crop 70% na V2 (--title-mode text, NÃO validado: na 261104 saiu com &#10; na tela e o fundo como bloco preto; PNG de reserva: ${png}); conferir no import (#12091)`),
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
      const png = join(ctx.outDir, titlePngFileName(ctx.edition, corte));
      await sharp(Buffer.from(screenTitleSvg(t.text, p.spec.width, p.spec.height))).png().toFile(png);
      screenTitleByCorte[corte] = screenTitleXmlFor(titleMode === "text" ? "text" : "png", t.text, titlePngXmlPath(mediaPath, ctx.edition, corte));
      console.error(
        `[premissa] título do corte "${corte}" (screenTitle da sequência): "${t.text}", ` +
          (titleMode === "text"
            ? `gerador de texto do FCP7 na V3 sobre fundo Color+Crop 70% na V2 (--title-mode text, NÃO validado; PNG de reserva: ${png})`
            : `PNG ${png} na V2 (padrão; pendente de conferência no 1º import com o PNG via XML)`) +
          " (#11900, #12091)",
      );
    }
  }
  // Um XML por sequência: cada um leva a definição completa do <file> (buildXmeml define na 1ª ocorrência).
  const xmlPaths: string[] = [];
  for (const p of picked) {
    const xmlPath = join(ctx.outDir, xmlFileName(p.spec.name));
    const version = sequenceNameVersion(p.spec.name);
    const sequenceIds = version !== null ? { [sequenceKey(p.spec)]: versionedSequenceId(sequenceKey(p.spec), version, versionHashes.get(p) ?? hash) } : undefined;
    writeFileAtomic(xmlPath, buildXmeml([p], source, framing, { mediaPath, audioGain: gain, screenTitle, screenTitleByCorte, sequenceIds, vinheta, audioPath: treated?.xmlPath ?? null }));
    xmlPaths.push(xmlPath);
    console.error(`[video-montagem] versão vigente de ${sequenceKey(p.spec)}: ${p.spec.name} (${basename(xmlPath)}, id ${sequenceIds?.[sequenceKey(p.spec)] ?? "sem versão"}; #12111)`);
  }
  // #11969: com --seq, só as sequências reconstruídas (e conferidas acima) mudam no plan.json.
  const planPath = f(ctx, "plan.json");
  let prevPlan: PlanFile | null = null;
  if (seq && existsSync(planPath)) {
    try { prevPlan = readJson<PlanFile>(planPath, "plan.json"); } catch (e) { console.error(`[aviso] plan.json anterior ilegível (${(e as Error).message}): só a sequência do --seq entra no plano novo`); }
  }
  const merged = mergeBuildPlan({
    next: { edition: ctx.edition, hash, source, framing, framingAssumed: assumed, plans: ps, cutRefine: refined.info, xmlAssets: Object.fromEntries(picked.map((p) => [sequenceKey(p.spec), { ...(treated ? { treatedAudio: treated } : {}), ...(vinheta ? { vinheta } : {}) }])) },
    pickedKeys: new Set(picked.map((p) => sequenceKey(p.spec))),
    prev: prevPlan,
    now: Date.now(),
  });
  if (merged.dropped.length) console.error(`[aviso] --seq ${seq}: ${merged.dropped.join(", ")} fora do plan.json (entradas mudaram desde o build delas, e o XML delas é o antigo); rode build sem --seq, ou com --seq de cada uma, antes de srt/preview delas (#11969)`);
  if (merged.kept.length) console.error(`[video-montagem] --seq ${seq}: ${merged.kept.join(", ")} mantida(s) no plan.json como o build anterior gravou (#11969)`);
  writeJson(planPath, merged.plan);
  if (source.mirrored) console.error("[premissa] bruto espelhado: aplicar Horizontal Flip nos clipes no Premiere (o Premiere ignora o Flop do XML, #11358)");
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
 */
export function youtubeSrtCopyDecision(input: {
  existing: string | null;
  recordedSha256: string | null;
  force: boolean;
  recordedFromExport?: boolean;
  fromExport?: boolean;
}): "write" | "keep-edited" | "keep-from-export" {
  if (input.existing === null || input.force) return "write";
  const sha = createHash("sha256").update(input.existing).digest("hex");
  if (sha !== input.recordedSha256) return "keep-edited";
  return input.recordedFromExport && !input.fromExport ? "keep-from-export" : "write";
}

/**
 * #12078: aplica a decisão acima nos caminhos dados (a cópia na pasta da edição
 * e o registro `youtube-srt.json`); grava só no "write". `origin` = nome do
 * export, quando a legenda veio do `--from-final`.
 */
export function applyYoutubeSrtCopy(input: { path: string; recordPath: string; srt: string; force: boolean; origin?: string; now?: Date }): ReturnType<typeof youtubeSrtCopyDecision> {
  const record = existsSync(input.recordPath) ? readJson<{ sha256?: string; fromExport?: string }>(input.recordPath, "youtube-srt.json") : null;
  const decision = youtubeSrtCopyDecision({
    existing: existsSync(input.path) ? readFileSync(input.path, "utf8") : null,
    recordedSha256: record?.sha256 ?? null,
    force: input.force,
    recordedFromExport: Boolean(record?.fromExport),
    fromExport: Boolean(input.origin),
  });
  if (decision !== "write") return decision;
  mkdirSync(dirname(input.path), { recursive: true });
  writeFileAtomic(input.path, input.srt);
  writeJson(input.recordPath, {
    path: input.path,
    sha256: createHash("sha256").update(input.srt).digest("hex"),
    writtenAt: (input.now ?? new Date()).toISOString(),
    ...(input.origin ? { fromExport: input.origin } : {}),
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
  limits?: Partial<typeof EXPORT_SRT_LIMITS>;
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
function transcribeExport(ctx: Ctx, path: string, key: string): Word[] {
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
  return nonEmptyWords(trPath, "transcrição do export");
}

/** Grava a cópia do horizontal na pasta da edição (ver `applyYoutubeSrtCopy`); devolve a decisão. */
function writeYoutubeSrtCopy(ctx: Ctx, srt: string, origin?: string): ReturnType<typeof youtubeSrtCopyDecision> {
  const path = join(editionDirFor(ctx.edition), youtubeCaptionFileName(ctx.edition));
  const decision = applyYoutubeSrtCopy({ path, recordPath: f(ctx, "youtube-srt.json"), srt, force: ctx.force, origin });
  if (decision === "keep-edited") {
    // No --from-final o chamador sai com [erro]; no srt da montagem é só aviso (#11957).
    if (!origin) console.error(`[aviso] ${path} foi editado depois do último srt: mantido (o novo está no out dir; --force sobrescreve, #11957)`);
    return decision;
  }
  if (decision === "keep-from-export") {
    console.error(`[aviso] ${path} foi gravado pelo srt --from-final (tempo do export): mantido, a legenda da montagem não o substitui (o novo está no out dir; --force sobrescreve, #12078)`);
    return decision;
  }
  if (origin) console.error(`[premissa] legenda do horizontal no tempo do export ${origin} (${path}, a que o publish-youtube.ts --upload/--captions-only envia, #12078)`);
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
function loadFromFinalPlan(ctx: Ctx, seq: string | undefined): SequencePlan {
  const pf = readJson<PlanFile>(f(ctx, "plan.json"), "plan.json (rode build --seq youtube)");
  if (!Array.isArray(pf.plans)) throw new Error(`plan.json malformado (sem a lista plans): rode build --seq youtube (${f(ctx, "plan.json")})`);
  const plan = fromFinalPlan(pf.plans, seq);
  if (typeof plan.script !== "string") throw new Error(`plan.json malformado (o horizontal sem script): rode build --seq youtube (${f(ctx, "plan.json")})`);
  try {
    if (pf.hash !== planHash(ctx, loadBlocks(ctx).text)) console.error("[aviso] plan.json defasado (entradas mudaram depois do build): usando o roteiro do horizontal gravado nele, o do XML de onde o export saiu (#12078)");
  } catch (e) {
    console.error(`[aviso] não deu para conferir o plan.json contra as entradas (${(e as Error).message}): usando o roteiro gravado nele`);
  }
  return plan;
}

function cmdSrtFromFinal(ctx: Ctx, file: string, plan: SequencePlan, text: ExportSrtText = "roteiro"): number {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`export não encontrado: ${path}`);
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
  const decision = writeYoutubeSrtCopy(ctx, srt, basename(path));
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
    const seqNotes = forcedAlignmentNotes(plan.spec.name, aligned);
    for (const n of seqNotes) console.error(n);
    notes[sequenceKey(plan.spec)] = seqNotes;
    const srt = cuesToSrt(segmentCues(aligned.words));
    const path = join(ctx.outDir, srtFileName(plan.spec.name));
    writeFileAtomic(path, srt);
    console.log(path);
    if (isYoutubeSpec(plan.spec)) writeYoutubeSrtCopy(ctx, srt);
  }
  writeJson(notesPath, notes);
  console.error(`[video-montagem] ouvido × roteiro de cada legenda em ${notesPath}: itens a conferir no relatório final (#12093)`);
  return 0;
}

/** Notas do alinhamento de cada legenda (#12093), por sequência: o relatório final lista para o editor conferir. */
export const SRT_NOTES_FILE = "srt-notas.json";

function cmdPreview(ctx: Ctx, target: string | undefined): number {
  const pf = loadPlan(ctx);
  // #12096: `--seq youtube` também (o horizontal, 960x540); sem --seq, a vertical da edição.
  const [plan] = pickPlans(pf.plans, target ?? "outras-redes", false, true);
  if (pf.framingAssumed) console.error("[premissa] blocks.json sem framing: usando o da 261027 (o mesmo do build)");
  for (const w of mugFramingWarnings([plan], pf.source, pf.framing)) console.error(`[aviso] ${w}`);
  const fps = pf.source.fps;
  const srt = join(ctx.outDir, srtFileName(plan.spec.name));
  const planPath = f(ctx, "plan.json");
  // #11969: contra o build DESTA sequência, não o último build de qualquer uma.
  if (existsSync(srt) && mtime(srt) < sequenceBuiltAt(pf, sequenceKey(plan.spec), mtime(planPath))) throw new Error(`${srt} é mais velho que o build de ${plan.spec.name} no plan.json: rode srt de novo antes da prévia`);
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
  plan.clips.forEach((c, i) => {
    // #12096: o recorte do XML (framingFor com a escala e o eyeFraction da sequência).
    const crop = previewCropFor(pf.source, plan.spec, pf.framing, c.scale);
    const name = `c${String(i).padStart(2, "0")}.mp4`;
    // Corte pelos FRAMES do plano, os mesmos do XML.
    run("ffmpeg", previewClipArgs({ src: pf.source.path, start: c.frameIn / fps, end: c.frameOut / fps, crop, mirrored: pf.source.mirrored, fps, out: join(dir, name), ...size, ...(audioSrc ? { audioSrc } : {}) }));
    list.push(`file '${name}'`);
    console.error(`[video-montagem] clipe ${i + 1}/${plan.clips.length} (${c.block})`);
  });
  writeFileSync(join(dir, "list.txt"), list.join("\n") + "\n");
  run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "joined.mp4"], { cwd: dir });
  let subtitles: string | undefined;
  if (existsSync(srt)) {
    copyFileSync(srt, join(dir, "leg.srt"));
    subtitles = `subtitles=leg.srt:force_style='${isVerticalSpec(plan.spec) ? PREVIEW_SUBTITLE_STYLE : PREVIEW_SUBTITLE_STYLE_HORIZONTAL}'`;
  } else console.error(`[aviso] sem ${srt}: a prévia sai sem legenda (rode srt antes)`);
  mkdirSync(ctx.outDir, { recursive: true });
  const out = join(ctx.outDir, previewFileName(ctx.edition, sequenceKey(plan.spec)));
  // #12101: a mesma vinheta do XML desta sequência por cima, no mesmo instante e no mesmo tamanho relativo.
  let vinheta = assets.vinheta ?? null;
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
  const dur = Math.max(1, plan.durationFrames / fps);
  const sheet = f(ctx, `previa-${sequenceKey(plan.spec)}.jpg`);
  run("ffmpeg", ["-y", "-v", "error", "-i", join(dir, "previa.mp4"), "-vf", `fps=${(14 / dur).toFixed(4)},scale=${isVerticalSpec(plan.spec) ? 270 : 480}:-1,tile=7x2`, "-frames:v", "1", sheet]);
  console.log(JSON.stringify({ preview: out, sheet }, null, 2));
  return 0;
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
  const words = nonEmptyWords(trPath, "transcrição da prévia");
  // Cada achado leva também o tempo no BRUTO (#11500): é lá que o corte se corrige.
  const findings = reviewPreview({ words, script: plan.script, cuts: cutPoints(plan, pf.source.fps), durationS, aliases: loadVocab().aliases }).map((x) => ({
    ...x,
    srcAt: exportTimeToRaw(x.at, plan, pf.source.fps),
  }));
  const highBandWarnings = pf.cutRefine?.highBandWarnings?.[sequenceKey(plan.spec)]
    ?? ["build sem verificação de banda alta: rode build com o bruto disponível (#11940)"];
  for (const warning of highBandWarnings) console.error(`[aviso] ${warning}`);
  // #11939: a caneca na folha de frames da prévia; o cálculo diz em que escala ela não sai inteira.
  const mugWarnings = mugFramingWarnings([plan], pf.source, pf.framing);
  for (const warning of mugWarnings) console.error(`[aviso] ${warning}`);
  writeJson(f(ctx, `review-${sequenceKey(plan.spec)}.json`), { preview, durationS, findings, highBandWarnings, mugWarnings });
  console.log(JSON.stringify({ preview, durationS, findings, highBandWarnings, mugWarnings }, null, 2));
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
  if (!t) throw new Error(`destino não reconhecido no nome ${basename(file)} (_Youtube_, _Instagram_, _Outras redes_): passe --seq`);
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
    run("ffmpeg", ["-hide_banner", "-nostats", "-i", path, "-vn", "-af", "silencedetect=noise=-40dB:d=0.08", "-f", "null", "-"]).stderr,
    probe.durationS,
  );
  findings.push(...dedupeAudioFindings(clicks, detectFragments(sil)));

  if (withText && plan) {
    findings.push(...checkText({ words: transcribeExport(ctx, path, key), plan, fps: planFps ?? 30, durationS: probe.durationS, aliases: loadVocab().aliases }));
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

export const SUBCOMMANDS = ["transcribe", "decupagem", "retranscribe", "frame", "roteiro", "fact-check-input", "build", "srt", "preview", "review", "review-final", "upload"] as const;
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
  /** A pasta `{AAMMDD}/` no Drive (resolvida na 1ª chamada; o config só é lido aí). */
  folder(): Promise<DriveEntry>;
}

/** `rootFolderId` é lido só quando algum passo vai mesmo à rede (frame com o bruto em cache não lê o config). */
export function makeDriveSession(edition: string, cacheDir: string, deps: MontageDriveDeps, rootFolderId: () => string): DriveSession {
  let memo: Promise<DriveEntry> | null = null;
  return { deps, edition, cacheDir, folder: () => (memo ??= Promise.resolve().then(() => findEditionFolder(deps, rootFolderId(), edition))) };
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
export async function ensureBrutoLocal(ctx: Pick<Ctx, "stateDir" | "edition">, d: DriveSession): Promise<void> {
  const path = f(ctx, "source.json");
  if (!existsSync(path)) return; // o comando dá o erro de sempre ("rode transcribe")
  const source = readJson<SourceInfo>(path, "source.json");
  if (existsSync(source.path)) return;
  const info = readBrutoDrive(ctx);
  if (!info) {
    log(`[aviso] bruto ${source.path} ausente e sem ${BRUTO_DRIVE_FILE}: não veio do Drive por este script, nada a baixar`);
    return;
  }
  if (info.localPath !== toPosix(source.path)) {
    throw new Error(`source.json aponta ${source.path}, mas ${BRUTO_DRIVE_FILE} registrou ${info.localPath} (o --cache-dir mudou?): rode transcribe de novo`);
  }
  const meta = await fetchFileMeta(d.deps, info.id);
  const metaSize = parseDriveSize(meta.size);
  if ((info.size !== null && metaSize !== null && metaSize !== info.size) || (info.modifiedTime && meta.modifiedTime && meta.modifiedTime !== info.modifiedTime)) {
    throw new Error(`o bruto ${info.name} mudou no Drive desde o transcribe (tamanho/modifiedTime): rode transcribe --force`);
  }
  // O cache gravado é de outra máquina (o state dir sincroniza): baixar lá não serve aqui.
  if (!toPosix(info.localPath).startsWith(toPosix(d.cacheDir) + "/")) {
    throw new Error(`bruto registrado no cache ${info.localPath}, fora do cache desta máquina (${d.cacheDir}): rode transcribe --force aqui para baixar e transcrever de novo`);
  }
  log(`[drive] bruto ausente do cache (${source.path}); baixando de novo do Drive`);
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
  const source = readJson<SourceInfo>(path, "source.json");
  if (existsSync(source.path)) return null;
  const info = readBrutoDrive(ctx);
  const origin = info && info.localPath === toPosix(source.path) ? ` (o cache do modo API de outra máquina; o bruto no Drive é ${info.name})` : "";
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
  const cacheDir = driveCacheDir(edition, values["cache-dir"], process.env.DIARIA_VIDEO_CACHE_DIR, homedir());
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
    if (d) return ensureBrutoLocal(ctx, d);
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
      const source = values["source"] ?? (d ? await fetchBruto(ctx, d, { fromAudio: audio }) : undefined);
      return cmdTranscribe(ctx, source, parseSilenceDbArg(values["silence-db"] ?? (flags.has("silence-db") ? "" : undefined)), fromAudio);
    }
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
      return cmdBuild(ctx, flags.has("allow-missing"), !flags.has("no-audio-refine"), !flags.has("no-audio-gain"), parseTitleModeArg(values["title-mode"] ?? (flags.has("title-mode") ? "" : undefined)), seq, !flags.has("no-speech-detect"), !flags.has("no-audio-clean"));
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
      return cmdPreview(ctx, seq);
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
