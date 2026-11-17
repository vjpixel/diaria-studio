/**
 * scripts/video-medicoes.ts (#13369, #13370; R2 e R3 da #13199)
 *
 * MEDIÇÕES do vídeo antes de mexer no corte ou no detector de rosto. Nenhum
 * subcomando muda `build`, `blocks.json` ou `data/`: o relatório sai no
 * stdout (e em `--out`, quando dado).
 *
 * Uso:
 *   vad AAMMDD --audio AUDIO.wav [--record REGISTRO.json] [--python PY] [--out SAIDA.json]
 *       R2 (#13369): o voto do Silero VAD em cada ponta de clipe e pausa interna,
 *       contra o que o editor fez no Premiere (registro do video-xml-vs-final:
 *       default `data/video-xml-vs-final/{AAMMDD}.json`, só leitura). AUDIO = o
 *       `audio.wav` 16 kHz do `transcribe` (work dir da montagem), na linha do
 *       tempo do bruto. PY = Python com faster-whisper (default: o venv da
 *       montagem, mesma resolução do video-montagem.ts).
 *   vad-agrega A.json,B.json,...
 *       soma as edições medidas: precisão e cobertura do voto.
 *   rosto-agrega A.json,B.json,...
 *       R3 (#13370): agrega os `face-compare.json` do `video-montagem.ts
 *       face-compare` de 5 a 10 edições; leitura mecânica, a troca do detector
 *       é decisão do editor.
 *
 * Exit: 0 ok; 1 erro (arquivo ausente, Python falhou); 2 uso.
 * Procedimento completo: docs/video-medicoes-r2-r3.md.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { aggregateFaceCompare, type FaceCompareReport } from "./lib/diaria/video-face-compare.ts";
import { resolveVideoPython } from "./lib/diaria/video-montage-env.ts";
import { aggregateVadVote, measureVadVote, type VadProbs, type VadVoteReport } from "./lib/diaria/video-vad-vote.ts";
import type { EditionRecord } from "./lib/diaria/video-xml-vs-final.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VAD_PY = join(ROOT, "scripts", "video", "vad_probs.py");

const USAGE = `uso: npx tsx scripts/video-medicoes.ts <vad AAMMDD --audio WAV [--record JSON] [--python PY] [--out JSON] | vad-agrega A.json,B.json | rosto-agrega A.json,B.json>
  ver o cabeçalho de scripts/video-medicoes.ts e docs/video-medicoes-r2-r3.md`;

function readJsonFile<T>(path: string, what: string): T {
  if (!existsSync(path)) throw new Error(`${what} não encontrado: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`${what} ilegível (${path}): ${(e as Error).message}`);
  }
}

function emit(obj: unknown, out: string | undefined): void {
  const text = JSON.stringify(obj, null, 2) + "\n";
  if (out) writeFileSync(out, text);
  process.stdout.write(text);
}

/** Lista separada por vírgula, sem item vazio. */
export function splitList(arg: string | undefined): string[] {
  return (arg ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function cmdVad(edition: string, values: Record<string, string>): number {
  const audio = values["audio"];
  if (!audio) throw new Error("vad exige --audio (o audio.wav 16 kHz do transcribe, no work dir da montagem)");
  if (!existsSync(audio)) throw new Error(`áudio não encontrado: ${audio}`);
  const recordPath = values["record"] ?? join(ROOT, "data", "video-xml-vs-final", `${edition}.json`);
  const record = readJsonFile<EditionRecord>(recordPath, "registro do video-xml-vs-final (rode video-xml-vs-final.ts compare antes)");
  if (record.edition !== edition) throw new Error(`o registro ${recordPath} é da edição ${record.edition}, não ${edition}`);
  const python = resolveVideoPython({ flag: values["python"], env: process.env.DIARIA_VIDEO_PYTHON, platform: process.platform, home: homedir(), exists: existsSync }).python;
  const dir = mkdtempSync(join(tmpdir(), "diaria-vad-"));
  try {
    const probsPath = join(dir, "vad.json");
    const r = spawnSync(python, ["-P", VAD_PY, audio, probsPath], { stdio: ["ignore", "inherit", "inherit"] });
    if (r.error) throw new Error(`vad_probs.py não rodou com ${python}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`vad_probs.py saiu ${r.status} (${python})`);
    const vad = readJsonFile<VadProbs>(probsPath, "saída do vad_probs.py");
    const report = measureVadVote({ record, vad });
    emit(report, values["out"]);
    const s = report.summary;
    console.error(`[video-medicoes] vad ${edition}: ${s.edges} ponta(s), editor mexeu em ${s.editorTouched}; voto pede mudança em ${s.voteChanges} (${s.hits} na direção do editor, ${s.falseAlarms} onde ele manteve, ${s.opposite} ao contrário); ${s.pausesVadCuts}/${s.pausesRemoved} pausa(s) removida(s) pelo editor o Silero também cortaria (#13369)`);
    for (const k of report.skipped) console.error(`[aviso] ${k.seq}: ${k.reason}`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2)): number {
  const { values, positional } = parseArgs(argv);
  const [cmd, arg] = positional;
  try {
    switch (cmd) {
      case "vad":
        if (!arg || !/^\d{6}$/.test(arg)) break;
        return cmdVad(arg, values);
      case "vad-agrega": {
        const files = splitList(arg);
        if (!files.length) break;
        emit(aggregateVadVote(files.map((p) => readJsonFile<VadVoteReport>(p, "relatório do vad"))), values["out"]);
        return 0;
      }
      case "rosto-agrega": {
        const files = splitList(arg);
        if (!files.length) break;
        emit(aggregateFaceCompare(files.map((p) => readJsonFile<FaceCompareReport>(p, "face-compare.json"))), values["out"]);
        return 0;
      }
    }
  } catch (e) {
    console.error(`video-medicoes: ${(e as Error).message}`);
    return 1;
  }
  console.error(USAGE);
  return 2;
}

if (isMainModule(import.meta.url)) process.exitCode = main();
