/**
 * scripts/video-montagem.ts (#11208) — montagem do vídeo diário "diar.ia.br
 * comentada", do bruto no Drive até o ponto de partida no Premiere. Usado pela
 * skill `/diaria-video-montagem`; a lógica fica em
 * `scripts/lib/diaria/video-montage.ts` (pura, testada), este arquivo só roda
 * ffmpeg/ffprobe e o helper Python e lê/grava os arquivos.
 *
 * Subcomandos (cada um retomável pelos arquivos em disco; `--force` refaz):
 *   transcribe AAMMDD   bruto → áudio 16 kHz, loudness, silêncios, transcrição por palavra
 *   decupagem AAMMDD    tabela da decupagem (gate 1) + `blocks.template.json`
 *   frame AAMMDD --at S frame do bruto (desespelhado, com grade) para o enquadramento
 *   roteiro AAMMDD      resolve o `blocks.json` (tomadas) e escreve o roteiro das 3 versões (gate 2)
 *   build AAMMDD        XML FCP7 (xmeml v4) com as 3 sequências + `plan.json`
 *   srt AAMMDD          legendas das verticais (retranscreve o áudio montado; `--from-raw` remapeia o bruto)
 *   preview AAMMDD      prévia vertical 720x1280 (flip, crop pelo rosto, fades, legenda queimada, loudnorm)
 *   review AAMMDD       transcreve a prévia e compara com o roteiro (tomada duplicada, sílaba vazada, final seco)
 *
 * Opções comuns:
 *   --drive-root DIR   pasta YouTube local do Drive (default: env DIARIA_VIDEO_DRIVE_ROOT ou
 *                      "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube"); a edição é {DIR}/{AAMMDD}/
 *   --state-dir DIR    onde ficam os JSON (default: data/editions/{AAMM}/{AAMMDD}/_internal/video-montagem)
 *   --work-dir DIR     áudio e clipes temporários (default: {tmp}/diaria-video-montagem/{AAMMDD})
 *   --out-dir DIR      onde saem XML, SRT e prévia (default: a pasta da edição no Drive)
 *   --python EXE       Python com faster-whisper (default: env DIARIA_VIDEO_PYTHON ou "python")
 *   --seq TARGET       youtube | instagram | outras-redes (srt/preview/review)
 *
 * Nada aqui publica ou sobe arquivo: as saídas vão para a pasta local do Drive
 * for desktop, que sincroniza sozinha. O upload continua no `/diaria-publica-video`.
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import {
  FRAMING_261027,
  LOUDNORM_TARGET,
  PREVIEW_SUBTITLE_STYLE,
  SILENCE_DETECT,
  alignPunctuationToScript,
  applyVocabularyToWords,
  buildSequencePlan,
  buildXmeml,
  BLOCK_KEYS,
  cuesToSrt,
  cutPoints,
  decupagemMarkdown,
  defaultSequences,
  framingFor,
  groupTakes,
  loudnessWarning,
  mapWordsToSequence,
  parseLoudnormJson,
  parseProbe,
  parseSilenceDetect,
  pickRawSource,
  previewClipArgs,
  resolveBlocks,
  reviewPreview,
  roteiroMarkdown,
  segmentCues,
  sequenceSourceRanges,
  transcriptWords,
  type BlocksFile,
  type Interval,
  type SequencePlan,
  type SequenceTarget,
  type SourceInfo,
  type Transcript,
  type VocabRule,
  type Word,
} from "./lib/diaria/video-montage.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PY_HELPER = join(ROOT, "scripts", "video", "transcribe_words.py");
const VOCAB_FILE = join(ROOT, "context", "video-montagem", "vocabulario.json");
export const DEFAULT_DRIVE_ROOT = "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube";

const USAGE = `uso: npx tsx scripts/video-montagem.ts <transcribe|decupagem|frame|roteiro|build|srt|preview|review> AAMMDD [opções]
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

function transcribeWithPython(ctx: Ctx, audio: string, out: string, opts: { vad: boolean }): void {
  const vocab = loadVocab();
  console.error(`[video-montagem] transcrevendo ${audio} (faster-whisper large-v3-turbo, CPU int8; leva minutos)…`);
  const args = ["-P", PY_HELPER, audio, out, "--initial-prompt", vocab.whisper_prompt ?? ""];
  if (opts.vad) args.push("--vad");
  run(ctx.python, args, { env: { ...process.env, HF_HUB_OFFLINE: "1" }, inheritStderr: true });
}

function loadVocab(): { whisper_prompt?: string; rules: VocabRule[] } {
  return readJson(VOCAB_FILE, "vocabulário das legendas");
}

function loadBlocks(ctx: Ctx): BlocksFile {
  const b = readJson<BlocksFile>(f(ctx, "blocks.json"), "blocks.json (gate da decupagem)");
  if (b.edition !== ctx.edition) throw new Error(`blocks.json é da edição ${b.edition}, não ${ctx.edition}`);
  return b;
}

function rawWords(ctx: Ctx): Word[] {
  return transcriptWords(readJson<Transcript>(f(ctx, "transcript.json"), "transcript.json (rode transcribe)"));
}

function silences(ctx: Ctx): Interval[] {
  return readJson<Interval[]>(f(ctx, "silences.json"), "silences.json (rode transcribe)");
}

function plans(ctx: Ctx): { file: BlocksFile; plans: SequencePlan[]; resolved: ReturnType<typeof resolveBlocks>["blocks"] } {
  const file = loadBlocks(ctx);
  const { blocks, errors } = resolveBlocks(file, rawWords(ctx));
  if (errors.length) throw new Error(`blocks.json com problema:\n  - ${errors.join("\n  - ")}`);
  const sil = silences(ctx);
  const specs = file.sequences ?? defaultSequences();
  return { file, resolved: blocks, plans: specs.map((s) => buildSequencePlan(s, blocks, sil, file.source, { holdBlocks: file.holdBlocks })) };
}

function pickPlan(all: SequencePlan[], target: string | undefined, verticalOnly: boolean): SequencePlan[] {
  const pool = verticalOnly ? all.filter((p) => p.spec.height > p.spec.width) : all;
  if (!target) return pool;
  const hit = pool.filter((p) => p.spec.target === target);
  if (hit.length === 0) throw new Error(`--seq ${target}: nenhuma sequência${verticalOnly ? " vertical" : ""} com esse destino`);
  return hit;
}

// ── Subcomandos ───────────────────────────────────────────────────────────

function cmdTranscribe(ctx: Ctx, sourceArg: string | undefined): number {
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
    src = join(ctx.driveDir, raw.name);
  }
  const sourcePath = f(ctx, "source.json");
  let source: SourceInfo;
  const cached = existsSync(sourcePath) && !ctx.force ? readJson<SourceInfo>(sourcePath, "source.json") : null;
  if (cached && cached.path !== src.replace(/\\/g, "/")) {
    throw new Error(`source.json aponta para outro bruto (${cached.path}); rode com --force para trocar por ${src}`);
  }
  if (cached) source = cached;
  else {
    const probe = run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", src]).stdout;
    source = parseProbe(probe, src.replace(/\\/g, "/"));
    writeJson(sourcePath, source);
  }
  console.error(`[video-montagem] bruto: ${source.path} (${source.width}x${source.height}, ${source.fps} fps, ${source.durationS.toFixed(1)} s)`);

  const audio = join(ctx.workDir, "audio.wav");
  const loudPath = f(ctx, "loudness.json");
  if (!existsSync(audio) || !existsSync(loudPath) || ctx.force) {
    console.error("[video-montagem] extraindo o áudio (16 kHz mono) e medindo o loudness do bruto…");
    const { stderr } = run("ffmpeg", [
      "-hide_banner", "-nostats", "-y", "-i", source.path,
      "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audio,
      "-map", "0:a:0", "-af", `${LOUDNORM_TARGET}:print_format=json`, "-f", "null", "-",
    ]);
    writeJson(loudPath, parseLoudnormJson(stderr));
  }
  const loud = readJson<ReturnType<typeof parseLoudnormJson>>(loudPath, "loudness.json");

  const silPath = f(ctx, "silences.json");
  if (!existsSync(silPath) || ctx.force) {
    const { stderr } = run("ffmpeg", [
      "-hide_banner", "-nostats", "-i", audio,
      "-af", `silencedetect=noise=${SILENCE_DETECT.noiseDb}dB:d=${SILENCE_DETECT.minDurationS}`, "-f", "null", "-",
    ]);
    writeJson(silPath, parseSilenceDetect(stderr, source.durationS));
  }

  const trPath = f(ctx, "transcript.json");
  if (!existsSync(trPath) || ctx.force) transcribeWithPython(ctx, audio, trPath, { vad: true });
  const words = rawWords(ctx);
  const warn = loudnessWarning(loud);
  if (warn) console.error(`[aviso] ${warn}`);
  console.log(JSON.stringify({ source: source.path, durationS: source.durationS, words: words.length, silences: silences(ctx).length, loudness: loud, stateDir: ctx.stateDir }, null, 2));
  return 0;
}

function cmdDecupagem(ctx: Ctx): number {
  const tr = readJson<Transcript>(f(ctx, "transcript.json"), "transcript.json (rode transcribe)");
  const md = decupagemMarkdown(ctx.edition, tr.segments, groupTakes(tr.segments));
  writeFileAtomic(f(ctx, "decupagem.md"), md);
  const tpl = f(ctx, "blocks.template.json");
  const source = readJson<SourceInfo>(f(ctx, "source.json"), "source.json (rode transcribe)");
  const template: BlocksFile = {
    edition: ctx.edition,
    source,
    framing: FRAMING_261027,
    blocks: Object.fromEntries(BLOCK_KEYS.map((k) => [k, []])),
    sequences: defaultSequences(),
  };
  writeJson(tpl, template);
  process.stdout.write(md);
  console.error(`[video-montagem] decupagem: ${f(ctx, "decupagem.md")}; molde do blocks.json: ${tpl}`);
  return 0;
}

function cmdFrame(ctx: Ctx, at: string | undefined): number {
  const t = Number(at);
  if (at === undefined || !Number.isFinite(t) || t < 0) throw new Error("frame exige --at SEGUNDOS");
  const source = readJson<SourceInfo>(f(ctx, "source.json"), "source.json (rode transcribe)");
  const out = f(ctx, `frame-${t.toFixed(1)}.jpg`);
  const vf = `${source.mirrored === false ? "" : "hflip,"}scale=960:-2,drawgrid=w=iw/10:h=ih/10:t=1:c=white@0.6`;
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", String(t), "-i", source.path, "-frames:v", "1", "-vf", vf, out]);
  console.log(out);
  console.error("[video-montagem] grade em décimos: centro do rosto (faceX) e linha dos olhos (eyeY) em fração do quadro, no framing do blocks.json");
  return 0;
}

function cmdRoteiro(ctx: Ctx): number {
  const { file, plans: ps, resolved } = plans(ctx);
  const md = roteiroMarkdown(ctx.edition, ps, resolved, file.source.fps);
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

function cmdBuild(ctx: Ctx, flop: boolean): number {
  const { file, plans: ps } = plans(ctx);
  const xml = buildXmeml(ps, file.source, file.framing, { flopFilter: flop });
  mkdirSync(ctx.outDir, { recursive: true });
  const xmlPath = join(ctx.outDir, xmlFileName(ctx.edition));
  writeFileAtomic(xmlPath, xml);
  writeJson(f(ctx, "plan.json"), { edition: ctx.edition, source: file.source, framing: file.framing ?? null, plans: ps });
  for (const p of ps) {
    const d = p.durationFrames / file.source.fps;
    console.error(`== ${p.spec.name}: ${p.clips.length} clipes, ${Math.floor(d / 60)}:${(d % 60).toFixed(1).padStart(4, "0")}${p.missingBlocks.length ? ` (faltam: ${p.missingBlocks.join(", ")})` : ""}`);
  }
  if (file.source.mirrored !== false && !flop) console.error("[premissa] bruto espelhado: aplicar Horizontal Flip nos clipes no Premiere (o XML não leva o flip sem --xml-flop)");
  console.log(xmlPath);
  return 0;
}

interface PlanFile {
  edition: string;
  source: SourceInfo;
  framing: BlocksFile["framing"] | null;
  plans: SequencePlan[];
}

function seqWords(ctx: Ctx, plan: SequencePlan, source: SourceInfo, fromRaw: boolean): Word[] {
  if (fromRaw) return mapWordsToSequence(rawWords(ctx), plan.clips, source.fps);
  const audio = join(ctx.workDir, "audio.wav");
  if (!existsSync(audio)) throw new Error(`áudio do bruto ausente (${audio}): rode transcribe de novo nesta máquina, ou use --from-raw`);
  const ranges = sequenceSourceRanges(plan, source.fps);
  const wav = join(ctx.workDir, `seq-${plan.spec.target}.wav`);
  const out = f(ctx, `seq-${plan.spec.target}.transcript.json`);
  // A transcrição em cache vale só para os MESMOS trechos: depois de um
  // `build` novo (loop da autorrevisão) ela é refeita sozinha.
  const rangesPath = f(ctx, `seq-${plan.spec.target}.ranges.json`);
  const rangesKey = JSON.stringify(ranges);
  const sameRanges = existsSync(rangesPath) && readFileSync(rangesPath, "utf8").trim() === rangesKey;
  if (!existsSync(out) || !sameRanges || ctx.force) {
    const graph =
      ranges.map((r, i) => `[0:a]atrim=start=${r.start.toFixed(3)}:end=${r.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`).join(";") +
      ";" + ranges.map((_, i) => `[a${i}]`).join("") + `concat=n=${ranges.length}:v=0:a=1[out]`;
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", audio, "-filter_complex", graph, "-map", "[out]", wav]);
    transcribeWithPython(ctx, wav, out, { vad: false });
    writeFileAtomic(rangesPath, rangesKey + "\n");
  }
  return transcriptWords(readJson<Transcript>(out, "transcrição da sequência"));
}

function cmdSrt(ctx: Ctx, target: string | undefined, fromRaw: boolean): number {
  const pf = readJson<PlanFile>(f(ctx, "plan.json"), "plan.json (rode build)");
  const blocks = loadBlocks(ctx);
  const rules = [...loadVocab().rules, ...(blocks.vocabulary ?? [])];
  mkdirSync(ctx.outDir, { recursive: true });
  for (const plan of pickPlan(pf.plans, target, true)) {
    const words = alignPunctuationToScript(applyVocabularyToWords(seqWords(ctx, plan, pf.source, fromRaw), rules, plan.spec.target), plan.script);
    const srt = cuesToSrt(segmentCues(words));
    const path = join(ctx.outDir, srtFileName(plan.spec.name));
    writeFileAtomic(path, srt);
    console.log(path);
  }
  return 0;
}

function cmdPreview(ctx: Ctx, target: string | undefined): number {
  const pf = readJson<PlanFile>(f(ctx, "plan.json"), "plan.json (rode build)");
  const [plan] = pickPlan(pf.plans, target ?? "outras-redes", true);
  const framing = pf.framing ?? FRAMING_261027;
  if (!pf.framing) console.error("[premissa] blocks.json sem framing: usando o da 261027 (rosto em 48% da largura, olhos em 54% da altura)");
  const dir = join(ctx.workDir, `previa-${plan.spec.target}`);
  mkdirSync(dir, { recursive: true });
  const list: string[] = [];
  plan.clips.forEach((c, i) => {
    const { crop } = framingFor({ srcW: pf.source.width, srcH: pf.source.height, seqW: plan.spec.width, seqH: plan.spec.height, scalePct: c.scale, framing });
    const name = `c${String(i).padStart(2, "0")}.mp4`;
    run("ffmpeg", previewClipArgs({ src: pf.source.path, start: c.srcIn, end: c.srcOut, crop, mirrored: pf.source.mirrored !== false, fps: pf.source.fps, out: join(dir, name) }));
    list.push(`file '${name}'`);
    console.error(`[video-montagem] clipe ${i + 1}/${plan.clips.length} (${c.block})`);
  });
  writeFileSync(join(dir, "list.txt"), list.join("\n") + "\n");
  run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "joined.mp4"], { cwd: dir });
  const srt = join(ctx.outDir, srtFileName(plan.spec.name));
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
  const sheet = f(ctx, `previa-${plan.spec.target}.jpg`);
  run("ffmpeg", ["-y", "-v", "error", "-i", join(dir, "previa.mp4"), "-vf", "fps=1/4,scale=270:-1,tile=7x2", "-frames:v", "1", sheet]);
  console.log(JSON.stringify({ preview: out, sheet }, null, 2));
  return 0;
}

function cmdReview(ctx: Ctx, target: string | undefined): number {
  const pf = readJson<PlanFile>(f(ctx, "plan.json"), "plan.json (rode build)");
  const [plan] = pickPlan(pf.plans, target ?? "outras-redes", true);
  const preview = join(ctx.outDir, previewFileName(ctx.edition, plan.spec.target));
  if (!existsSync(preview)) throw new Error(`prévia ausente: ${preview} (rode preview)`);
  mkdirSync(ctx.workDir, { recursive: true });
  const wav = join(ctx.workDir, `review-${plan.spec.target}.wav`);
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", preview, "-ac", "1", "-ar", "16000", wav]);
  const trPath = f(ctx, `review-${plan.spec.target}.transcript.json`);
  transcribeWithPython(ctx, wav, trPath, { vad: false });
  const durationS = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", preview]).stdout.trim());
  const words = transcriptWords(readJson<Transcript>(trPath, "transcrição da prévia"));
  const findings = reviewPreview({ words, script: plan.script, cuts: cutPoints(plan, pf.source.fps), durationS });
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
      return cmdTranscribe(ctx, values["source"]);
    case "decupagem":
      return cmdDecupagem(ctx);
    case "frame":
      return cmdFrame(ctx, values["at"]);
    case "roteiro":
      return cmdRoteiro(ctx);
    case "build":
      return cmdBuild(ctx, flags.has("xml-flop"));
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
