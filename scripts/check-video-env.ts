#!/usr/bin/env -S npx tsx
/**
 * check-video-env.ts (#11223) — diz se esta máquina produz a capa do vídeo do
 * dia (ffmpeg, Codex CLI, Georgia, venv do rembg) e o que falta, por item.
 *
 * Feito para a viagem do editor: o `/diaria-publica-video` passa a rodar no
 * `300`, comandado do celular, e a capa era o único passo que só saía no Neo.
 * Rodar no Passo 0 da skill: com tudo ok a capa sai aqui; com algo faltando, o
 * resto da skill segue e a capa fica para o Neo (ou sem capa própria).
 *
 * Só sonda, nunca instala: `codex --version`, `ffmpeg -version`, a sonda de
 * raster da Georgia (#4090) e `setup-rembg.py --check` pelo Python do venv
 * (importa o rembg, não baixa modelo). O login do Codex não é conferido aqui
 * (custaria uma chamada à assinatura): `docs/codex-image-setup.md` passo 3.
 *
 * Uso: npx tsx scripts/check-video-env.ts [--json]
 * Exit: 0 = a capa sai nesta máquina; 1 = falta algo (o relatório diz o quê).
 *
 * `--montagem [--edition AAMMDD]` (#11642): o ambiente do `/diaria-video-montagem`
 * (Passo 0 da skill), no lugar da capa: ffmpeg, Python com faster-whisper (o
 * mesmo que o `video-montagem.ts` usaria, `resolveVideoPython`), o modelo
 * `large-v3-turbo` no cache do Hugging Face (a transcrição roda offline), acesso
 * à pasta YouTube (Drive for desktop em `G:` ou a API pelo OAuth do projeto) e
 * espaço no disco do cache (3x o bruto da edição, quando `--edition` acha um;
 * 25 GB sem ele). Exit 0 = a montagem roda aqui; 1 = falta algo.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { isBrandSerifAvailable } from "./lib/shared/assert-brand-font.ts";
import {
  assessVideoEnv,
  codexCandidatePaths,
  formatVideoEnvReport,
  rembgVenvPython,
  type ProbeResult,
  type VideoEnvProbes,
  type VideoEnvReport,
} from "./lib/diaria/video-env-check.ts";
import {
  WHISPER_MODEL,
  assessMontageEnv,
  formatMontageEnvReport,
  requiredFreeBytes,
  resolveVideoPython,
  type MontageEnvReport,
  type MontageProbe,
} from "./lib/diaria/video-montage-env.ts";
import {
  DEFAULT_DRIVE_ROOT,
  findEditionFolder,
  freeBytes,
  listChildren,
  pickDriveBruto,
  youtubeFolderIdFrom,
  type MontageDriveDeps,
} from "./lib/diaria/video-montage-drive.ts";
import { gFetchRetry } from "./lib/drive-helpers.ts";
import { DRIVE_API } from "./lib/drive-constants.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function firstLine(s: string | null | undefined): string | undefined {
  const line = (s ?? "").split(/\r?\n/).find((l) => l.trim());
  return line?.trim().slice(0, 120);
}

function probeCommand(cmd: string, args: string[], timeoutMs = 20_000): ProbeResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, shell: process.platform === "win32" });
  if (r.error) return { ok: false, detail: `${cmd} indisponível: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, detail: `${cmd} exit ${r.status}: ${firstLine(r.stderr) ?? firstLine(r.stdout) ?? "sem saída"}` };
  return { ok: true, detail: firstLine(r.stdout) ?? firstLine(r.stderr) };
}

function probeRembg(): ProbeResult {
  const python = resolve(ROOT, rembgVenvPython(process.platform));
  if (!existsSync(python)) return { ok: false, detail: `venv ausente (${rembgVenvPython(process.platform)})` };
  const r = spawnSync(python, [resolve(ROOT, "scripts/setup-rembg.py"), "--check"], { encoding: "utf8", timeout: 120_000 });
  if (r.error) return { ok: false, detail: `python do venv não roda: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, detail: firstLine(r.stderr) ?? `exit ${r.status}` };
  return { ok: true, detail: "setup-rembg.py --check ok" };
}

async function probeGeorgia(): Promise<ProbeResult> {
  try {
    return (await isBrandSerifAvailable()) ? { ok: true } : { ok: false, detail: "Georgia não resolve no raster (cai no fallback)" };
  } catch (e) {
    return { ok: false, detail: `sonda da fonte falhou: ${(e as Error).message}` };
  }
}

/**
 * #11532: `codex` pelo PATH; se não resolver, os caminhos de instalação
 * conhecidos (`codexCandidatePaths`), que o `codex-image.js` também usa. Achar
 * fora do PATH conta como ok (o outpaint roda) e o detalhe diz onde.
 */
function probeCodex(): ProbeResult {
  const viaPath = probeCommand("codex", ["--version"]);
  if (viaPath.ok) return viaPath;
  for (const p of codexCandidatePaths(process.platform, homedir())) {
    if (!existsSync(p)) continue;
    const r = probeCommand(p, ["--version"]);
    if (r.ok) return { ok: true, detail: `${r.detail ?? "codex"} — fora do PATH, em ${p} (o codex-image.js usa este caminho, #11532)` };
  }
  return viaPath;
}

export async function runVideoEnvCheck(): Promise<VideoEnvReport> {
  const probes: VideoEnvProbes = {
    ffmpeg: probeCommand("ffmpeg", ["-version"]),
    codex: probeCodex(),
    georgia: await probeGeorgia(),
    rembg: probeRembg(),
  };
  return assessVideoEnv(probes, process.platform);
}

function probePython(python: string, code: string, timeoutMs: number): MontageProbe {
  const r = spawnSync(python, ["-P", "-c", code], { encoding: "utf8", timeout: timeoutMs, env: { ...process.env, HF_HUB_OFFLINE: "1" } });
  if (r.error) return { ok: false, detail: `${python} não roda: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, detail: firstLine((r.stderr ?? "").split(/\r?\n/).filter(Boolean).slice(-1)[0]) ?? `exit ${r.status}` };
  return { ok: true, detail: firstLine(r.stdout) };
}

/**
 * Python com faster-whisper que DECODIFICA áudio (#11642): importar não basta.
 * No 300 o PyAV 19 importava normal e quebrava no `decode_audio`
 * (`metadata_errors`), só no meio do `transcribe`. Gera 0,5 s de seno com o
 * ffmpeg e decodifica pelo mesmo caminho da transcrição.
 */
function probeWhisperDecode(python: string): MontageProbe {
  const dir = mkdtempSync(join(tmpdir(), "vm-env-"));
  try {
    const wav = join(dir, "sine.wav");
    const ff = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=0.5", "-ar", "16000", wav], { encoding: "utf8", timeout: 30_000 });
    const code = ff.status === 0
      ? `import faster_whisper, av; from faster_whisper.audio import decode_audio; n = len(decode_audio(${JSON.stringify(wav)})); print('faster-whisper', faster_whisper.__version__, 'av', av.__version__, 'decode ok' if n > 0 else 'decode vazio')`
      : "import faster_whisper; print('faster-whisper', faster_whisper.__version__, '(decode não testado: ffmpeg falhou)')";
    const r = probePython(python, code, 60_000);
    if (r.ok && /decode vazio/.test(r.detail ?? "")) return { ok: false, detail: r.detail };
    return r.ok ? r : { ok: false, detail: `${r.detail} (pin do lock: scripts/video/montagem-requirements.txt)` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Acesso à pasta YouTube: Drive for desktop, ou a API (e o tamanho do bruto da edição, quando pedida). */
async function probeDrive(edition: string | undefined): Promise<{ probe: MontageProbe; brutoBytes: number | null }> {
  const localRoot = process.env.DIARIA_VIDEO_DRIVE_ROOT ?? DEFAULT_DRIVE_ROOT;
  if (existsSync(localRoot)) return { probe: { ok: true, detail: `Drive for desktop em ${localRoot}` }, brutoBytes: null };
  try {
    const rootId = youtubeFolderIdFrom(JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")));
    if (!rootId) return { probe: { ok: false, detail: "sem G: e sem publishing.youtube.drive_folder_id no platform.config.json" }, brutoBytes: null };
    const deps: MontageDriveDeps = { driveFetch: (url, init) => gFetchRetry(url, init ?? {}) };
    const res = await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(rootId)}?fields=id,name&supportsAllDrives=true`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { probe: { ok: false, detail: `API do Drive: pasta YouTube ${rootId} respondeu ${res.status}` }, brutoBytes: null };
    if (!edition) return { probe: { ok: true, detail: `API do Drive (pasta YouTube ${rootId})` }, brutoBytes: null };
    const folder = await findEditionFolder(deps, rootId, edition);
    const raw = pickDriveBruto(await listChildren(deps, folder.id));
    if (!raw) return { probe: { ok: true, detail: `API do Drive; ${edition}/ sem bruto ainda` }, brutoBytes: null };
    const bytes = Number(raw.pick.size ?? 0) || null;
    return { probe: { ok: true, detail: `API do Drive; bruto ${raw.pick.name} (${((bytes ?? 0) / 1e9).toFixed(2)} GB)` }, brutoBytes: bytes };
  } catch (e) {
    return { probe: { ok: false, detail: `API do Drive: ${(e as Error).message}` }, brutoBytes: null };
  }
}

export async function runMontageEnvCheck(edition?: string): Promise<MontageEnvReport> {
  const py = resolveVideoPython({ env: process.env.DIARIA_VIDEO_PYTHON, platform: process.platform, home: homedir(), exists: existsSync });
  const python = probeWhisperDecode(py.python);
  const model = python.ok
    ? probePython(py.python, `from faster_whisper.utils import download_model; print(download_model('${WHISPER_MODEL}', local_files_only=True))`, 60_000)
    : { ok: false, detail: "sem Python com faster-whisper" };
  const drive = await probeDrive(edition);
  const cacheRoot = process.env.DIARIA_VIDEO_CACHE_DIR ?? resolve(homedir(), ".cache", "diaria-video-montagem");
  mkdirSync(cacheRoot, { recursive: true });
  const free = freeBytes(cacheRoot);
  const need = requiredFreeBytes(drive.brutoBytes);
  const disk: MontageProbe =
    free === null
      ? { ok: false, detail: `espaço livre ilegível em ${cacheRoot}` }
      : { ok: free >= need, detail: `${(free / 1e9).toFixed(1)} GB livres em ${cacheRoot}, precisa ${(need / 1e9).toFixed(1)} GB` };
  return assessMontageEnv({ ffmpeg: probeCommand("ffmpeg", ["-version"]), python, model, drive: drive.probe, disk }, process.platform, `${py.python} (${py.from})`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("montagem")) {
    const r = await runMontageEnvCheck(args.values["edition"]);
    console.log(args.flags.has("json") ? JSON.stringify(r, null, 2) : formatMontageEnvReport(r));
    process.exitCode = r.ready ? 0 : 1;
    return;
  }
  const report = await runVideoEnvCheck();
  if (args.flags.has("json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatVideoEnvReport(report));
  process.exitCode = report.coverReady ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`check-video-env: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
