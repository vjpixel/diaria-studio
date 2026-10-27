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
 *       da última detecção refaz só o `silences.json`.
 *   decupagem AAMMDD        sem `decupagem-plan.json`: lista numerada dos segmentos + molde do plano
 *                           (a skill classifica); com ele: o Markdown do Doc da decupagem (gate 1, por
 *                           bloco, curado, com "Montagem sugerida") + `blocks.template.json` (sempre refaz).
 *                           A listagem traz a decisão por critério de cada tomada (#11364); o plano que
 *                           põe duas tomadas da mesma frase como "usar", ou "alternativa" onde a direção
 *                           já aprovou uma, é erro. Vertical acima de 3:00 sai como [aviso].
 *   retranscribe AAMMDD --from S --to S
 *                           retranscreve só o trecho (até 60 s; sem VAD, sem condition_on_previous_text)
 *                           antes de declarar dúvida (#11364); não mexe no transcript.json
 *   frame AAMMDD --at S    frame do bruto (desespelhado conforme o `mirrored` efetivo, com grade)
 *   roteiro AAMMDD          resolve o `blocks.json` (tomadas) e escreve o roteiro (gate 2, uma tabela
 *                           por versão; as "alternativa" da decupagem viram opções B/C; sempre refaz)
 *   build AAMMDD [--allow-missing]
 *       XML FCP7 (xmeml v4) + `plan.json` (com o hash do blocks.json, do source.json e do silences.json).
 *       Bloco faltando ou item/palavra que some no corte = erro, salvo --allow-missing.
 *       Vertical montada acima de 3:00 (Shorts) sai como [aviso] com quanto passa (#11377); o
 *       corte só na vertical é um item com "skip"/"targets" no blocks.json.
 *   srt AAMMDD [--seq instagram|outras-redes] [--from-raw] [--force]
 *       legendas das verticais. Retranscreve o áudio montado (cache por trechos +
 *       identidade do áudio); --from-raw remapeia o transcript do bruto.
 *   preview AAMMDD [--seq instagram|outras-redes]   (default outras-redes; sempre refaz)
 *   review AAMMDD [--seq instagram|outras-redes]    (default outras-redes; sempre refaz)
 * srt, preview e review recusam um `plan.json` defasado (blocks.json ou
 * source.json mudaram depois do build); preview recusa um SRT mais velho que o
 * plano; review recusa uma prévia mais velha que o plano.
 *
 * Opções comuns:
 *   --drive-root DIR   pasta YouTube local do Drive (default: env DIARIA_VIDEO_DRIVE_ROOT ou
 *                      "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube"); a edição é {DIR}/{AAMMDD}/
 *   --state-dir DIR    onde ficam os JSON (default: data/editions/{AAMM}/{AAMMDD}/_internal/video-montagem)
 *   --work-dir DIR     áudio e clipes temporários (default: {tmp}/diaria-video-montagem/{AAMMDD})
 *   --out-dir DIR      onde saem XML, SRT e prévia (default: a pasta da edição no Drive)
 *   --python EXE       Python com faster-whisper (default: env DIARIA_VIDEO_PYTHON ou "python")
 *
 * Nada aqui publica ou sobe arquivo: as saídas vão para a pasta local do Drive
 * for desktop, que sincroniza sozinha. O upload continua no `/diaria-publica-video`.
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  buildSequencePlan,
  buildXmeml,
  clockTime,
  cuesToSrt,
  cutPoints,
  defaultSequences,
  effectiveFraming,
  effectiveSource,
  framingFor,
  loudnessWarning,
  mapWordsToSequence,
  offsetTranscript,
  parseBlocksFile,
  retranscribeWindow,
  parseLoudnormJson,
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
  type Framing,
  type Interval,
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PY_HELPER = join(ROOT, "scripts", "video", "transcribe_words.py");
const VOCAB_FILE = join(ROOT, "context", "video-montagem", "vocabulario.json");
export const DEFAULT_DRIVE_ROOT = "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube";

const USAGE = `uso: npx tsx scripts/video-montagem.ts <transcribe|decupagem|retranscribe|frame|roteiro|build|srt|preview|review> AAMMDD [opções]
  ver o cabeçalho de scripts/video-montagem.ts e .claude/skills/diaria-video-montagem/SKILL.md`;

interface Ctx {
  edition: string;
  stateDir: string;
  workDir: string;
  driveDir: string;
  outDir: string;
  python: string;
  force: boolean;
}

const f = (ctx: Ctx, name: string) => join(ctx.stateDir, name);

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
 * de antes da redetecção tem os cortes velhos). `silences` null = arquivo ausente.
 */
export function planHashOf(blocksText: string, sourceJson: Buffer | string, silences: Buffer | string | null): string {
  return createHash("sha256")
    .update(blocksText)
    .update("\0")
    .update(sourceJson)
    .update("\0")
    .update(silences ?? "\0sem-silences")
    .digest("hex")
    .slice(0, 16);
}

function planHash(ctx: Ctx, blocksText: string): string {
  const sil = f(ctx, "silences.json");
  return planHashOf(blocksText, readFileSync(f(ctx, "source.json")), existsSync(sil) ? readFileSync(sil) : null);
}

function silences(ctx: Ctx): Interval[] {
  return readJson<Interval[]>(f(ctx, "silences.json"), "silences.json (rode transcribe)");
}

function plans(ctx: Ctx) {
  const { file, text } = loadBlocks(ctx);
  const source = sourceFor(ctx, file);
  const vocab = loadVocab();
  const { blocks, errors, warnings } = resolveBlocks(file, nonEmptyWords(f(ctx, "transcript.json"), "transcript.json (rode transcribe)"), {
    durationS: source.durationS,
    rules: vocab.rules,
    aliases: vocab.aliases,
  });
  for (const w of warnings) console.error(`[aviso] ${w}`);
  if (errors.length) throw new Error(`blocks.json com problema:\n  - ${errors.join("\n  - ")}`);
  const sil = silences(ctx);
  const specs = file.sequences ?? defaultSequences();
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
}

/** O plano do último build, recusado se o blocks.json ou o source.json mudaram depois dele. */
function loadPlan(ctx: Ctx): PlanFile {
  const pf = readJson<PlanFile>(f(ctx, "plan.json"), "plan.json (rode build)");
  const { text } = loadBlocks(ctx);
  if (pf.hash !== planHash(ctx, text)) throw new Error("plan.json defasado: blocks.json, source.json ou silences.json mudaram depois do build; rode build de novo");
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

function cmdTranscribe(ctx: Ctx, sourceArg: string | undefined, silenceDb: number | undefined): number {
  mkdirSync(ctx.workDir, { recursive: true });
  mkdirSync(ctx.stateDir, { recursive: true });
  let src = sourceArg ? resolve(sourceArg) : undefined;
  if (!src) {
    if (!existsSync(ctx.driveDir)) throw new Error(`pasta da edição no Drive não encontrada: ${ctx.driveDir} (Drive for desktop montado? --drive-root)`);
    const files = readdirSync(ctx.driveDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => ({ name: d.name, size: statSync(join(ctx.driveDir, d.name)).size }));
    const raw = pickRawSource(files);
    if (!raw) throw new Error(`nenhum bruto (.mp4/.mov) solto em ${ctx.driveDir}; passe --source`);
    if (raw.candidates.length > 1) {
      console.error(`[aviso] ${raw.candidates.length} vídeos candidatos a bruto; usando o maior (${raw.pick.name}). Outro: --source. Candidatos: ${raw.candidates.map((c) => `${c.name} (${(c.size / 1e9).toFixed(2)} GB)`).join(", ")}`);
    }
    src = join(ctx.driveDir, raw.pick.name);
  }
  const srcPath = src.replace(/\\/g, "/");
  const sourcePath = f(ctx, "source.json");
  const cached = existsSync(sourcePath) && !ctx.force ? readJson<SourceInfo>(sourcePath, "source.json") : null;
  if (cached && cached.path !== srcPath) throw new Error(`source.json aponta para outro bruto (${cached.path}); rode com --force para trocar por ${srcPath}`);
  let source: SourceInfo;
  // source.json refeito = todos os derivados refeitos (áudio, loudness, silêncios, transcrição).
  let redo = ctx.force;
  if (cached) source = cached;
  else {
    const probe = run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", src]).stdout;
    source = parseProbe(probe, srcPath);
    writeJson(sourcePath, source);
    redo = true;
  }
  console.error(`[video-montagem] bruto: ${source.path} (${source.width}x${source.height}, ${source.fps} fps, ${source.durationS.toFixed(1)} s)`);

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

  const trPath = f(ctx, "transcript.json");
  if (redo || !existsSync(trPath)) transcribeWithPython(ctx, audio, trPath, { vad: true });
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

function cmdDecupagem(ctx: Ctx): number {
  const tr = readJson<Transcript>(f(ctx, "transcript.json"), "transcript.json (rode transcribe)");
  const segments = tr.segments;
  const plan = loadDecupagemPlan(ctx, segments);
  if (!plan) {
    // 1ª passada: a listagem numerada e o molde do plano, para a skill classificar (#11361).
    const tplPath = f(ctx, "decupagem-plan.template.json");
    writeJson(tplPath, decupagemPlanTemplate(ctx.edition, segments));
    process.stdout.write(segmentListing(segments));
    console.error(`[video-montagem] decupagem: classificar os segmentos acima em ${f(ctx, "decupagem-plan.json")} (molde: ${tplPath}) e rodar decupagem de novo`);
    return 0;
  }
  // Decisão por critério (#11364): uma tomada por frase, a direção decide antes da "alternativa".
  const crit = checkDecupagemCriteria(plan, segments);
  for (const w of crit.warnings) console.error(`[aviso] ${w}`);
  if (crit.errors.length) throw new Error(`decupagem-plan.json não decide por critério:\n  - ${crit.errors.join("\n  - ")}`);
  const doc = buildDecupagemDoc(plan, segments, loadVocab().rules);
  const source = measuredSource(ctx);
  const sequences = defaultSequences();
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
    blocks: blocksFromDecupagem(doc),
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

function cmdBuild(ctx: Ctx, allowMissing: boolean): number {
  const { file, source, plans: ps, hash } = plans(ctx);
  const { framing, assumed } = effectiveFraming(file);
  if (assumed) console.error("[premissa] blocks.json sem framing: usando o da 261027 (rosto em 48% da largura, olhos em 54% da altura)");
  let problems = 0;
  for (const p of ps) {
    const d = p.durationFrames / source.fps;
    console.error(`== ${p.spec.name}: ${p.clips.length} clipes, ${Math.floor(d / 60)}:${(d % 60).toFixed(1).padStart(4, "0")}`);
    if (p.missingBlocks.length) console.error(`   faltam no blocks.json: ${p.missingBlocks.join(", ")}`);
    for (const x of p.dropped) console.error(`   ${x}`);
    problems += p.missingBlocks.length + p.dropped.length;
    const over = shortsWarning(p, source.fps);
    if (over) console.error(`[aviso] ${over}`);
  }
  if (problems && !allowMissing) {
    console.error(`[erro] ${problems} problema(s) acima: corrigir o blocks.json (outra tomada, intervalo maior) ou rodar com --allow-missing`);
    return 1;
  }
  const xml = buildXmeml(ps, source, framing);
  mkdirSync(ctx.outDir, { recursive: true });
  const xmlPath = join(ctx.outDir, xmlFileName(ctx.edition));
  writeFileAtomic(xmlPath, xml);
  const pf: PlanFile = { edition: ctx.edition, hash, source, framing, framingAssumed: assumed, plans: ps };
  writeJson(f(ctx, "plan.json"), pf);
  if (source.mirrored) console.error("[premissa] bruto espelhado: aplicar Horizontal Flip nos clipes no Premiere (o Premiere ignora o Flop do XML, #11358)");
  console.log(xmlPath);
  return 0;
}

function seqWords(ctx: Ctx, plan: SequencePlan, source: SourceInfo, fromRaw: boolean): Word[] {
  if (fromRaw) {
    const words = mapWordsToSequence(nonEmptyWords(f(ctx, "transcript.json"), "transcript.json"), plan.clips, source.fps);
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
  const findings = reviewPreview({ words, script: plan.script, cuts: cutPoints(plan, pf.source.fps), durationS, aliases: loadVocab().aliases });
  writeJson(f(ctx, `review-${plan.spec.target}.json`), { preview, durationS, findings });
  console.log(JSON.stringify({ preview, durationS, findings }, null, 2));
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
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
  const driveRoot = values["drive-root"] ?? process.env.DIARIA_VIDEO_DRIVE_ROOT ?? DEFAULT_DRIVE_ROOT;
  const driveDir = join(driveRoot, edition);
  const ctx: Ctx = {
    edition,
    stateDir: resolve(values["state-dir"] ?? join(editionDirFor(edition), "_internal", "video-montagem")),
    workDir: resolve(values["work-dir"] ?? join(tmpdir(), "diaria-video-montagem", edition)),
    driveDir,
    outDir: resolve(values["out-dir"] ?? driveDir),
    python: values["python"] ?? process.env.DIARIA_VIDEO_PYTHON ?? "python",
    force: flags.has("force"),
  };
  const seq = values["seq"];
  switch (cmd) {
    case "transcribe":
      return cmdTranscribe(ctx, values["source"], parseSilenceDbArg(values["silence-db"] ?? (flags.has("silence-db") ? "" : undefined)));
    case "decupagem":
      return cmdDecupagem(ctx);
    case "frame":
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
      return cmdBuild(ctx, flags.has("allow-missing"));
    case "srt":
      return cmdSrt(ctx, seq, flags.has("from-raw"));
    case "preview":
      return cmdPreview(ctx, seq);
    case "review":
      return cmdReview(ctx, seq);
    default:
      console.error(`video-montagem: subcomando desconhecido: ${cmd}\n${USAGE}`);
      return 2;
  }
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(), { onError: (e) => console.error("video-montagem:", e instanceof Error ? e.message : e) });
}
