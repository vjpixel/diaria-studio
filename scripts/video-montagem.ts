/**
 * scripts/video-montagem.ts (#11208) — montagem do vídeo diário "diar.ia.br
 * comentada", do bruto no Drive até o ponto de partida no Premiere. Usado pela
 * skill `/diaria-video-montagem`; a lógica fica em
 * `scripts/lib/diaria/video-montage.ts` (pura, testada), este arquivo só roda
 * ffmpeg/ffprobe e o helper Python e lê/grava os arquivos.
 *
 * Subcomandos e flags próprias:
 *   transcribe AAMMDD [--source PATH] [--force] [--silence-db DB]
 *       bruto → `source.json`, áudio 16 kHz, `loudness.json`, `silences.json`,
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
 *                           antes de declarar dúvida (#11364); não mexe no transcript.json
 *   frame AAMMDD --at S    frame do bruto (desespelhado conforme o `mirrored` efetivo, com grade)
 *   roteiro AAMMDD          resolve o `blocks.json` (tomadas) e escreve o roteiro (gate 2, uma tabela
 *                           por versão; as "alternativa" da decupagem viram opções B/C; sempre refaz)
 *   build AAMMDD [--allow-missing] [--no-audio-refine]
 *       XML FCP7 (xmeml v4) + `plan.json` (com o hash do blocks.json, do source.json e do silences.json).
 *       Clipes contíguos no bruto viram um só e o zoom alterna só nos cortes (#11503). Os cortes
 *       são refinados pelo áudio do bruto (#11500, `lib/diaria/video-cut-refine.ts`): vale de
 *       energia a ±0,4 s, som fora do roteiro na borda (bordas retranscritas sem VAD, cache em
 *       `edge-retranscribe.json`), corte ainda em plena fala vira [aviso]; cada ajuste sai no
 *       relato e em `plan.json` (`cutAdjustments`, `cutRefine`). Sem `audio.wav` nesta máquina,
 *       ou com --no-audio-refine, os cortes ficam como os tempos do Whisper, com [aviso].
 *       Bloco faltando ou item/palavra que some no corte = erro, salvo --allow-missing.
 *       Vertical montada acima de 3:00 (Shorts) sai como [aviso] com quanto passa (#11377); o
 *       corte só na vertical é um item com "skip"/"targets" no blocks.json.
 *   srt AAMMDD [--seq instagram|outras-redes] [--from-raw] [--force]
 *       legendas das verticais. Retranscreve o áudio montado (cache por trechos +
 *       identidade do áudio); --from-raw remapeia o transcript do bruto.
 *   preview AAMMDD [--seq instagram|outras-redes]   (default outras-redes; sempre refaz)
 *   review AAMMDD [--seq instagram|outras-redes]    (default outras-redes; sempre refaz)
 *   review-final AAMMDD --file PATH [--seq youtube|instagram|outras-redes] [--no-text]
 *       revisão do EXPORT do Premiere (#11557): formato contra o destino (proporção,
 *       faixa preta, fps, teto do vertical), loudness/true peak, estalos e fragmentos
 *       nas emendas e, com `plan.json` válido, o texto contra o roteiro da versão
 *       (transcreve o export; `--no-text` pula). Destino pelo nome do arquivo
 *       (`_Youtube_`/`_Instagram_`/`_Outras redes_`) ou `--seq`. Saída: tabela
 *       (#, tempo no export, tempo no bruto, o que está, correção) no stdout e em
 *       `review-final-{destino}.md`/`.json` no state dir. Só lê o export.
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
  LOUDNORM_TARGET,
  PREVIEW_SUBTITLE_STYLE,
  SILENCE_DETECT,
  alignPunctuationToScript,
  applyVocabularyToWords,
  assembleClips,
  buildSequencePlan,
  buildXmeml,
  clockTime,
  cuesToSrt,
  cutPoints,
  defaultSequences,
  effectiveFormat,
  effectiveFraming,
  effectiveSource,
  framingFor,
  loudnessWarning,
  makeMatcher,
  mapWordsToSequence,
  trimWordsToSilences,
  offsetTranscript,
  parseBlocksFile,
  retranscribeWindow,
  parseLoudnormJson,
  parseFrameRate,
  parseProbe,
  parseSilenceDetect,
  pickRawSource,
  previewClipArgs,
  resolveBlocks,
  reviewPreview,
  segmentCues,
  sequenceSourceRanges,
  silenceNoiseDb,
  transcriptWords,
  validateVocabRules,
  type BlocksFile,
  type CutAdjustment,
  type Framing,
  type Interval,
  type PlannedClip,
  type RawClip,
  type Segment,
  type SequencePlan,
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
  parseDecupagemPlan,
  roteiroMarkdown,
  segmentListing,
  SHORTS_MAX_S,
  shortsWarning,
  suggestedDurations,
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
import { VIDEO_TARGETS, type VideoTarget } from "./lib/diaria/drive-video-source.ts";
import {
  edgeWindowsFor,
  energyEnvelope,
  parseWavPcm16,
  snapClipEdges,
  speechCutWarnings,
  trimEdgeExtras,
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PY_HELPER = join(ROOT, "scripts", "video", "transcribe_words.py");
const VOCAB_FILE = join(ROOT, "context", "video-montagem", "vocabulario.json");
export { DEFAULT_DRIVE_ROOT };

const USAGE = `uso: npx tsx scripts/video-montagem.ts <transcribe|decupagem|retranscribe|frame|roteiro|build|srt|preview|review|review-final|upload> AAMMDD [opções]
  ver o cabeçalho de scripts/video-montagem.ts e .claude/skills/diaria-video-montagem/SKILL.md`;

interface Ctx {
  edition: string;
  stateDir: string;
  workDir: string;
  driveDir: string;
  outDir: string;
  python: string;
  force: boolean;
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

function planHash(ctx: Ctx, blocksText: string): string {
  const sil = f(ctx, "silences.json");
  const tr = f(ctx, "transcript.json");
  return planHashOf(blocksText, readFileSync(f(ctx, "source.json")), existsSync(sil) ? readFileSync(sil) : null, existsSync(tr) ? readFileSync(tr) : null);
}

function silences(ctx: Ctx): Interval[] {
  return readJson<Interval[]>(f(ctx, "silences.json"), "silences.json (rode transcribe)");
}

function plans(ctx: Ctx) {
  const { file, text } = loadBlocks(ctx);
  const source = sourceFor(ctx, file);
  const vocab = loadVocab();
  const sil = silences(ctx);
  const { blocks, errors, warnings } = resolveBlocks(file, nonEmptyWords(f(ctx, "transcript.json"), "transcript.json (rode transcribe)"), {
    durationS: source.durationS,
    silences: sil,
    rules: vocab.rules,
    aliases: vocab.aliases,
  });
  for (const w of warnings) console.error(`[aviso] ${w}`);
  if (errors.length) throw new Error(`blocks.json com problema:\n  - ${errors.join("\n  - ")}`);
  const fmt = effectiveFormat(file);
  if (!file.sequences && fmt.inferred) console.error("[premissa] blocks.json sem título nem resumo: formato entrevista, sequências abertura → comentário → CTA → fecho (#11507); `format`/`sequences` sobrepõem");
  const specs = file.sequences ?? defaultSequences("V1", fmt.format);
  const ps = specs.map((s) => buildSequencePlan(s, blocks, sil, source, { holdBlocks: file.holdBlocks }));
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
}

/** O plano do último build, recusado se o blocks.json ou o source.json mudaram depois dele. */
function loadPlan(ctx: Ctx): PlanFile {
  const pf = readJson<PlanFile>(f(ctx, "plan.json"), "plan.json (rode build)");
  const { text } = loadBlocks(ctx);
  if (pf.hash !== planHash(ctx, text)) throw new Error("plan.json defasado: blocks.json, source.json, silences.json ou transcript.json mudaram depois do build; rode build de novo");
  return pf;
}

function pickPlan(all: SequencePlan[], target: string | undefined, verticalOnly: boolean): SequencePlan[] {
  const pool = verticalOnly ? all.filter((p) => p.spec.height > p.spec.width) : all;
  if (!target) return pool;
  const hit = pool.filter((p) => p.spec.target === target);
  if (hit.length === 0) throw new Error(`--seq ${target}: nenhuma sequência${verticalOnly ? " vertical" : ""} com esse destino`);
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
  for (const p of [join(ctx.workDir, "audio.wav"), f(ctx, "loudness.json"), f(ctx, "silences.json"), f(ctx, "silences.meta.json")]) rmSync(p, { force: true });
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
  const done = audioPath === undefined && ctx.workDir !== undefined && [join(ctx.workDir, "audio.wav"), f(ctx, "loudness.json"), f(ctx, "transcript.json")].every((p) => existsSync(p));
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
    source = parseProbe(probe, srcPath);
    writeJson(sourcePath, source);
    wroteSource = true;
    redo = true;
  }
  if (source.audioOnly) {
    console.error(`[video-montagem] bruto só de áudio: ${source.path} (${source.durationS.toFixed(1)} s) — modo áudio: transcrição, decupagem e roteiro; build/srt/prévia/review param antes (#11552)`);
  } else {
    console.error(`[video-montagem] bruto: ${source.path} (${source.width}x${source.height}, ${source.fps} fps, ${source.durationS.toFixed(1)} s)`);
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
  const silMeta = existsSync(silMetaPath) ? readJson<{ noiseDb?: number; minDurationS?: number }>(silMetaPath, "silences.meta.json") : null;
  // silences.json sem meta (anterior ao #11351) ou com outro limiar é refeito.
  const silStale = !silMeta || silMeta.noiseDb !== threshold.noiseDb || silMeta.minDurationS !== SILENCE_DETECT.minDurationS;
  if (redo || !existsSync(silPath) || silStale) {
    const { stderr } = run("ffmpeg", [
      "-hide_banner", "-nostats", "-i", audio,
      "-af", `silencedetect=noise=${threshold.noiseDb}dB:d=${SILENCE_DETECT.minDurationS}`, "-f", "null", "-",
    ]);
    writeJson(silPath, parseSilenceDetect(stderr, source.durationS));
    writeJson(silMetaPath, { noiseDb: threshold.noiseDb, minDurationS: SILENCE_DETECT.minDurationS, how: threshold.how });
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
  const v = classifyVoices(f0s, segments.map(speechSeconds), { pixelHz: pixelF0 });
  writeJson(f(ctx, "voices.json"), { ...v, segments: segments.map((s, i) => ({ n: i + 1, start: s.start, end: s.end, f0: f0s[i] })) });
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
  const doc = buildDecupagemDoc(plan, segments, loadVocab().rules);
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
 * Retranscreve só um trecho do bruto (#11364), sem VAD e sem
 * `condition_on_previous_text`: comentário da direção e começo de frase depois
 * de pausa saem errados na transcrição longa ("bom" por "primeiro" na 261028).
 * Imprime os segmentos no tempo do bruto; não mexe no `transcript.json`.
 */
function cmdRetranscribe(ctx: Ctx, from: string | undefined, to: string | undefined): number {
  const source = measuredSource(ctx);
  const w = retranscribeWindow(from, to, source.durationS);
  if (!w.ok) throw new Error(w.error);
  const audio = join(ctx.workDir, "audio.wav");
  if (!existsSync(audio)) throw new Error(`áudio do bruto ausente (${audio}): rode transcribe de novo nesta máquina`);
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
  return 0;
}

function cmdFrame(ctx: Ctx, at: string | undefined): number {
  const t = Number(at);
  if (at === undefined || !Number.isFinite(t) || t < 0) throw new Error("frame exige --at SEGUNDOS");
  // Antes do gate 1 não há blocks.json: vale o mirrored do source.json.
  const source = existsSync(f(ctx, "blocks.json")) ? sourceFor(ctx, loadBlocks(ctx).file) : sourceFor(ctx);
  const out = f(ctx, `frame-${t.toFixed(1)}.jpg`);
  const vf = `${source.mirrored ? "hflip," : ""}scale=960:-2,drawgrid=w=iw/10:h=ih/10:t=1:c=white@0.6`;
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", String(t), "-i", source.path, "-frames:v", "1", "-vf", vf, out]);
  console.log(out);
  console.error(`[video-montagem] mirrored=${source.mirrored}; grade em décimos: centro do rosto (faceX) e linha dos olhos (eyeY) em fração do quadro, no framing do blocks.json`);
  return 0;
}

function cmdRoteiro(ctx: Ctx): number {
  const { source, plans: ps, resolved } = plans(ctx);
  // As linhas "alternativa" da decupagem viram as opções B, C… do roteiro (#11361).
  const tr = readJson<Transcript>(f(ctx, "transcript.json"), "transcript.json (rode transcribe)");
  const dplan = loadDecupagemPlan(ctx, tr.segments);
  const alternatives = dplan ? alternativesFromDecupagem(buildDecupagemDoc(dplan, tr.segments, loadVocab().rules)) : undefined;
  const md = roteiroMarkdown(ctx.edition, ps, resolved, source.fps, { alternatives });
  writeFileAtomic(f(ctx, "roteiro.md"), md);
  process.stdout.write(md);
  return 0;
}

export function xmlFileName(edition: string): string {
  return `${edition} - montagem (importar no Premiere).xml`;
}
export function srtFileName(seqName: string): string {
  return `${seqName} - legendas.srt`;
}
export function previewFileName(edition: string, target: SequenceTarget): string {
  return `${edition} - previa ${target}.mp4`;
}

/** O que o refino por áudio fez neste build (#11500), gravado no `plan.json`. */
export interface CutRefineInfo {
  applied: boolean;
  /** Por que não rodou (ou rodou só a passada A). */
  reason?: string;
  thresholdDb?: number;
  /** Bordas retranscritas (janelas únicas, as verticais dividem as mesmas). */
  edgeWindows?: number;
  edgesRetranscribed?: boolean;
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
  const cachePath = f(ctx, "edge-retranscribe.json");
  const st = statSync(audio);
  const id = { size: st.size, mtimeMs: st.mtimeMs };
  type Cache = { audio: typeof id; windows: Record<string, Word[]> };
  let cache: Cache = { audio: id, windows: {} };
  if (existsSync(cachePath) && !ctx.force) {
    const c = readJson<Cache>(cachePath, "edge-retranscribe.json");
    if (c.audio?.size === id.size && c.audio?.mtimeMs === id.mtimeMs) cache = c;
  }
  const missing = windows.filter((w) => !(w.key in cache.windows));
  if (missing.length) {
    mkdirSync(ctx.workDir, { recursive: true });
    const winFile = join(ctx.workDir, "edge-windows.json");
    const out = join(ctx.workDir, "edge-retranscribe.raw.json");
    writeFileSync(winFile, JSON.stringify(missing));
    console.error(`[video-montagem] refino dos cortes: retranscrevendo ${missing.length} borda(s) de clipe (sem VAD)…`);
    const vocab = loadVocab();
    run(ctx.python, ["-P", PY_HELPER, audio, out, "--windows", winFile, "--no-condition", "--initial-prompt", vocab.whisper_prompt ?? ""], {
      env: { ...process.env, HF_HUB_OFFLINE: "1" },
      inheritStderr: true,
    });
    const raw = readJson<{ windows: Array<{ key: string; segments: Segment[] }> }>(out, "retranscrição das bordas");
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
function refineCuts(ctx: Ctx, ps: SequencePlan[], source: SourceInfo, enabled: boolean): { plans: SequencePlan[]; info: CutRefineInfo; warnings: string[] } {
  if (!enabled) return { plans: ps, info: { applied: false, reason: "--no-audio-refine" }, warnings: ["refino dos cortes por áudio desligado (--no-audio-refine): os cortes seguem os tempos do Whisper"] };
  const audio = join(ctx.workDir, "audio.wav");
  if (!existsSync(audio)) {
    const reason = `áudio do bruto ausente (${audio})`;
    return { plans: ps, info: { applied: false, reason }, warnings: [`${reason}: cortes NÃO refinados pelo áudio; rode transcribe nesta máquina e build de novo`] };
  }
  const { sampleRate, samples } = parseWavPcm16(readFileSync(audio));
  const env = energyEnvelope(samples, sampleRate);
  const thresholdDb = silenceThresholdDb(ctx);
  const words = nonEmptyWords(f(ctx, "transcript.json"), "transcript.json");
  const match = makeMatcher(loadVocab().aliases);
  const warnings: string[] = [];
  // Passada A em todas as sequências.
  const stageA = ps.map((p) => snapClipEdges(p.clips.map(rawOf), env, words, { thresholdDb, durationS: source.durationS }));
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
    const assembled = assembleClips(p.spec, clips, source.fps);
    adjustments.push(...assembled.merges);
    for (const w of speechCutWarnings(assembled.clips, env, thresholdDb)) warnings.push(`${p.spec.name}: ${w}`);
    return { ...p, clips: assembled.clips, durationFrames: assembled.durationFrames, cutAdjustments: adjustments };
  });
  return { plans: out, info: { applied: true, thresholdDb, edgeWindows: windows.size, edgesRetranscribed: heard !== null }, warnings };
}

const rawOf = (c: PlannedClip): RawClip => ({ block: c.block, srcIn: c.srcIn, srcOut: c.srcOut, ...(c.script ? { script: c.script } : {}), ...(c.parts ? { parts: c.parts } : {}) });

/** Uma linha do relato por ajuste de corte (#11500). */
export function adjustmentLine(a: CutAdjustment): string {
  const edge = a.edge === "in" ? "entrada" : a.edge === "out" ? "saída" : "emenda";
  return `   ajuste ${a.block} ${edge}: ${a.from.toFixed(2)} → ${a.to.toFixed(2)} s (${a.reason})`;
}

function cmdBuild(ctx: Ctx, allowMissing: boolean, audioRefine = true): number {
  const { file, source, plans: ps0, hash } = plans(ctx);
  const refined = refineCuts(ctx, ps0, source, audioRefine);
  const ps = refined.plans;
  for (const w of refined.warnings) console.error(`[aviso] ${w}`);
  const { framing, assumed } = effectiveFraming(file);
  if (assumed) console.error("[premissa] blocks.json sem framing: usando o da 261027 (rosto em 48% da largura, olhos em 54% da altura)");
  let problems = 0;
  for (const p of ps) {
    const d = p.durationFrames / source.fps;
    console.error(`== ${p.spec.name}: ${p.clips.length} clipes, ${Math.floor(d / 60)}:${(d % 60).toFixed(1).padStart(4, "0")}`);
    if (p.missingBlocks.length) console.error(`   faltam no blocks.json: ${p.missingBlocks.join(", ")}`);
    for (const x of p.dropped) console.error(`   ${x}`);
    for (const a of p.cutAdjustments ?? []) console.error(adjustmentLine(a));
    problems += p.missingBlocks.length + p.dropped.length;
    const over = shortsWarning(p, source.fps);
    if (over) console.error(`[aviso] ${over}`);
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
  const xml = buildXmeml(ps, source, framing, { mediaPath });
  mkdirSync(ctx.outDir, { recursive: true });
  const xmlPath = join(ctx.outDir, xmlFileName(ctx.edition));
  writeFileAtomic(xmlPath, xml);
  const pf: PlanFile = { edition: ctx.edition, hash, source, framing, framingAssumed: assumed, plans: ps, cutRefine: refined.info };
  writeJson(f(ctx, "plan.json"), pf);
  if (source.mirrored) console.error("[premissa] bruto espelhado: aplicar Horizontal Flip nos clipes no Premiere (o Premiere ignora o Flop do XML, #11358)");
  console.log(xmlPath);
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
  const wav = join(ctx.workDir, `seq-${plan.spec.target}.wav`);
  const out = f(ctx, `seq-${plan.spec.target}.transcript.json`);
  // A transcrição em cache vale só para os MESMOS trechos do MESMO áudio:
  // um build novo (loop da autorrevisão) ou um transcribe refeito a invalidam.
  const st = statSync(audio);
  const keyPath = f(ctx, `seq-${plan.spec.target}.cache-key.json`);
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

function cmdSrt(ctx: Ctx, target: string | undefined, fromRaw: boolean): number {
  const pf = loadPlan(ctx);
  const { file } = loadBlocks(ctx);
  const vocab = loadVocab();
  const rules = [...vocab.rules, ...(file.vocabulary ?? [])];
  mkdirSync(ctx.outDir, { recursive: true });
  for (const plan of pickPlan(pf.plans, target, true)) {
    const heard = applyVocabularyToWords(seqWords(ctx, plan, pf.source, fromRaw), rules, plan.spec.target, (w) => console.error(`[aviso] ${w}`));
    const words = alignPunctuationToScript(heard, plan.script, vocab.aliases);
    const path = join(ctx.outDir, srtFileName(plan.spec.name));
    writeFileAtomic(path, cuesToSrt(segmentCues(words)));
    console.log(path);
  }
  return 0;
}

function cmdPreview(ctx: Ctx, target: string | undefined): number {
  const pf = loadPlan(ctx);
  const [plan] = pickPlan(pf.plans, target ?? "outras-redes", true);
  if (pf.framingAssumed) console.error("[premissa] blocks.json sem framing: usando o da 261027 (o mesmo do build)");
  const fps = pf.source.fps;
  const srt = join(ctx.outDir, srtFileName(plan.spec.name));
  const planPath = f(ctx, "plan.json");
  if (existsSync(srt) && mtime(srt) < mtime(planPath)) throw new Error(`${srt} é mais velho que o plan.json: rode srt de novo antes da prévia`);
  const dir = join(ctx.workDir, `previa-${plan.spec.target}`);
  mkdirSync(dir, { recursive: true });
  const list: string[] = [];
  plan.clips.forEach((c, i) => {
    const { crop } = framingFor({ srcW: pf.source.width, srcH: pf.source.height, seqW: plan.spec.width, seqH: plan.spec.height, scalePct: c.scale, framing: pf.framing });
    const name = `c${String(i).padStart(2, "0")}.mp4`;
    // Corte pelos FRAMES do plano, os mesmos do XML.
    run("ffmpeg", previewClipArgs({ src: pf.source.path, start: c.frameIn / fps, end: c.frameOut / fps, crop, mirrored: pf.source.mirrored, fps, out: join(dir, name) }));
    list.push(`file '${name}'`);
    console.error(`[video-montagem] clipe ${i + 1}/${plan.clips.length} (${c.block})`);
  });
  writeFileSync(join(dir, "list.txt"), list.join("\n") + "\n");
  run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "joined.mp4"], { cwd: dir });
  const vf: string[] = [];
  if (existsSync(srt)) {
    copyFileSync(srt, join(dir, "leg.srt"));
    vf.push("-vf", `subtitles=leg.srt:force_style='${PREVIEW_SUBTITLE_STYLE}'`);
  } else console.error(`[aviso] sem ${srt}: a prévia sai sem legenda (rode srt antes)`);
  mkdirSync(ctx.outDir, { recursive: true });
  const out = join(ctx.outDir, previewFileName(ctx.edition, plan.spec.target));
  run("ffmpeg", [
    "-y", "-v", "error", "-i", "joined.mp4", ...vf, "-af", LOUDNORM_TARGET,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "previa.mp4",
  ], { cwd: dir });
  copyFileSync(join(dir, "previa.mp4"), out);
  // 14 quadros (7x2) espalhados pela prévia inteira, qualquer que seja a duração.
  const dur = Math.max(1, plan.durationFrames / fps);
  const sheet = f(ctx, `previa-${plan.spec.target}.jpg`);
  run("ffmpeg", ["-y", "-v", "error", "-i", join(dir, "previa.mp4"), "-vf", `fps=${(14 / dur).toFixed(4)},scale=270:-1,tile=7x2`, "-frames:v", "1", sheet]);
  console.log(JSON.stringify({ preview: out, sheet }, null, 2));
  return 0;
}

function cmdReview(ctx: Ctx, target: string | undefined): number {
  const pf = loadPlan(ctx);
  const [plan] = pickPlan(pf.plans, target ?? "outras-redes", true);
  const preview = join(ctx.outDir, previewFileName(ctx.edition, plan.spec.target));
  if (!existsSync(preview)) throw new Error(`prévia ausente: ${preview} (rode preview)`);
  if (mtime(preview) < mtime(f(ctx, "plan.json"))) throw new Error(`${preview} é mais velha que o plan.json: rode preview de novo`);
  mkdirSync(ctx.workDir, { recursive: true });
  const wav = join(ctx.workDir, `review-${plan.spec.target}.wav`);
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", preview, "-ac", "1", "-ar", "16000", wav]);
  const trPath = f(ctx, `review-${plan.spec.target}.transcript.json`);
  transcribeWithPython(ctx, wav, trPath, { vad: false });
  const durationS = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", preview]).stdout.trim());
  if (!Number.isFinite(durationS) || durationS <= 0) throw new Error(`duração da prévia ilegível no ffprobe (${preview})`);
  const words = nonEmptyWords(trPath, "transcrição da prévia");
  // Cada achado leva também o tempo no BRUTO (#11500): é lá que o corte se corrige.
  const findings = reviewPreview({ words, script: plan.script, cuts: cutPoints(plan, pf.source.fps), durationS, aliases: loadVocab().aliases }).map((x) => ({
    ...x,
    srcAt: exportTimeToRaw(x.at, plan, pf.source.fps),
  }));
  writeJson(f(ctx, `review-${plan.spec.target}.json`), { preview, durationS, findings });
  console.log(JSON.stringify({ preview, durationS, findings }, null, 2));
  return 0;
}

/** Destino do `review-final`: `--seq` explícito ou o sufixo do nome do export. */
export function reviewFinalTarget(file: string, seq: string | undefined): VideoTarget {
  if (seq !== undefined) {
    if (!(VIDEO_TARGETS as readonly string[]).includes(seq)) throw new Error(`--seq deve ser ${VIDEO_TARGETS.join(", ")} (veio ${seq})`);
    return seq as VideoTarget;
  }
  const t = exportTarget(basename(file));
  if (!t) throw new Error(`destino não reconhecido no nome ${basename(file)} (_Youtube_, _Instagram_, _Outras redes_): passe --seq`);
  return t;
}

function cmdReviewFinal(ctx: Ctx, file: string | undefined, seq: string | undefined, withText: boolean): number {
  if (!file) throw new Error("review-final exige --file PATH (o export do Premiere)");
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`export não encontrado: ${path}`);
  const target = reviewFinalTarget(path, seq);
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
    plan = pf.plans.find((p) => p.spec.target === target) ?? null;
    planFps = pf.source.audioOnly ? null : pf.source.fps;
    if (!plan) console.error(`[aviso] plan.json sem a sequência ${target}: texto não comparado com o roteiro`);
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
    mkdirSync(ctx.workDir, { recursive: true });
    const wav = join(ctx.workDir, `review-final-${target}.wav`);
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000", wav]);
    const trPath = f(ctx, `review-final-${target}.transcript.json`);
    transcribeWithPython(ctx, wav, trPath, { vad: false });
    findings.push(...checkText({ words: nonEmptyWords(trPath, "transcrição do export"), plan, fps: planFps ?? 30, durationS: probe.durationS, aliases: loadVocab().aliases }));
  }

  const table = finalReviewTable(findings);
  mkdirSync(ctx.stateDir, { recursive: true });
  writeFileAtomic(f(ctx, `review-final-${target}.md`), `# Revisão do export: ${basename(path)}\n\n${table}`);
  writeJson(f(ctx, `review-final-${target}.json`), { file: path, target, probe, crop, loudness: loud, findings });
  process.stdout.write(table);
  console.error(`[video-montagem] review-final: ${findings.length} achado(s) em ${basename(path)} (destino ${target}); tabela em ${f(ctx, `review-final-${target}.md`)}`);
  return 0;
}

// ── Drive pela API, fora do Neo (#11639, #11640, #11641) ─────────────────

/** Registro do bruto baixado pela API (no state dir): id, nome no Drive e o caminho do cache. */
export const BRUTO_DRIVE_FILE = "bruto.drive.json";
/** O que já subiu para a pasta da edição (nome → id/link) e o que ficou pendente. */
export const DRIVE_UPLOADS_FILE = "drive-uploads.json";
/** Saída quando o comando deu certo e só o upload para o Drive falhou (as saídas estão no out dir). */
export const EXIT_UPLOAD_FAILED = 4;

export const SUBCOMMANDS = ["transcribe", "decupagem", "retranscribe", "frame", "roteiro", "build", "srt", "preview", "review", "review-final", "upload"] as const;
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
    case "frame":
      await needLocalBruto();
      return cmdFrame(ctx, values["at"]);
    case "retranscribe":
      return cmdRetranscribe(ctx, values["from"], values["to"]);
    case "roteiro":
      return cmdRoteiro(ctx);
    case "build":
      if (flags.has("xml-flop") || "xml-flop" in values) {
        console.error("[erro] --xml-flop foi removida: o Premiere ignora o filtro Flop no import (#11358). Aplicar Horizontal Flip à mão.");
        return 2;
      }
      return cmdBuild(ctx, flags.has("allow-missing"), !flags.has("no-audio-refine"));
    case "srt":
      return cmdSrt(ctx, seq, flags.has("from-raw"));
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
