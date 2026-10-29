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
 * Uso: npx tsx scripts/check-video-env.ts [--json]   (capa; --montagem: ver abaixo)
 * Exit: 0 = a capa sai nesta máquina; 1 = falta algo (o relatório diz o quê).
 *
 * `--montagem [--edition AAMMDD] [--python EXE]` (#11642): o ambiente do
 * `/diaria-video-montagem` (Passo 0 da skill), no lugar da capa: ffmpeg; o
 * Python com faster-whisper (o mesmo que o `video-montagem.ts` usaria,
 * `resolveVideoPython`) decodificando um áudio de teste; o modelo
 * `large-v3-turbo` carregando offline; o acesso à pasta da edição pelo mesmo
 * critério de modo do script (Drive for desktop em `G:` = modo local, com a
 * pasta `{AAMMDD}/` sincronizada; sem `G:` = modo API, com OAuth, a pasta da
 * edição e permissão de escrita nela); e, só no modo API, o espaço no disco do
 * cache (3x o bruto da edição, descontado o bruto já baixado; 25 GB sem bruto
 * conhecido). Só lê: não cria pasta nem baixa nada. Exit 0 = a montagem roda
 * aqui; 1 = falta algo.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
  EditionFolderError,
  findEditionFolder,
  freeBytes,
  listChildren,
  parseDriveSize,
  pickDriveBruto,
  youtubeFolderIdFrom,
  type MontageDriveDeps,
} from "./lib/diaria/video-montage-drive.ts";
import { driveModeFor } from "./video-montagem.ts";
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
 * ffmpeg e decodifica pelo mesmo caminho da transcrição; sem conseguir gerar o
 * áudio de teste, o item falha (decode não testado não é ok).
 */
function probeWhisperDecode(python: string): MontageProbe {
  const dir = mkdtempSync(join(tmpdir(), "vm-env-"));
  try {
    const wav = join(dir, "sine.wav");
    const ff = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=0.5", "-ar", "16000", wav], { encoding: "utf8", timeout: 30_000 });
    if (ff.status !== 0) return { ok: false, detail: `decode não testado: o ffmpeg não gerou o áudio de teste (${firstLine(ff.stderr) ?? ff.error?.message ?? `exit ${ff.status}`})` };
    const code = `import faster_whisper, av; from faster_whisper.audio import decode_audio; n = len(decode_audio(${JSON.stringify(wav)})); print('faster-whisper', faster_whisper.__version__, 'av', av.__version__, 'decode ok' if n > 0 else 'decode vazio')`;
    const r = probePython(python, code, 60_000);
    if (r.ok && /decode vazio/.test(r.detail ?? "")) return { ok: false, detail: r.detail };
    return r.ok ? r : { ok: false, detail: `${r.detail} (pin do lock: scripts/video/montagem-requirements.txt)` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface DriveProbe {
  probe: MontageProbe;
  mode: "local" | "api";
  bruto: { name: string; bytes: number | null } | null;
}

/**
 * Acesso à pasta da edição pelo MESMO critério do `video-montagem.ts`
 * (`driveModeFor`): raiz do Drive for desktop presente (ou explícita) = modo
 * local, e com `--edition` a pasta `{AAMMDD}/` tem de existir nela; raiz padrão
 * ausente = modo API, que precisa do OAuth, da pasta da edição (única) e de
 * permissão de escrita nela (as saídas sobem para lá). Cada falha com a sua
 * correção, nunca a do OAuth para tudo.
 */
async function probeDrive(edition: string | undefined): Promise<DriveProbe> {
  const explicitRoot = process.env.DIARIA_VIDEO_DRIVE_ROOT;
  const root = explicitRoot ?? DEFAULT_DRIVE_ROOT;
  const mode = driveModeFor({ driveRootExists: existsSync(root), fromDrive: false, noDriveApi: false, explicitRoot: explicitRoot !== undefined });
  if (mode === "local") {
    if (!existsSync(root)) return { mode, bruto: null, probe: { ok: false, detail: `DIARIA_VIDEO_DRIVE_ROOT=${root} não existe`, fix: "montar o Drive for desktop nesse caminho ou desfazer DIARIA_VIDEO_DRIVE_ROOT" } };
    if (edition && !existsSync(join(root, edition))) {
      return { mode, bruto: null, probe: { ok: false, detail: `Drive for desktop em ${root}, sem a pasta ${edition}/`, fix: `esperar o Drive for desktop sincronizar ${edition}/ (ou rodar com --from-drive para baixar pela API)` } };
    }
    return { mode, bruto: null, probe: { ok: true, detail: `Drive for desktop em ${root} (modo local)` } };
  }
  let rootId: string | null;
  try {
    rootId = youtubeFolderIdFrom(JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")));
  } catch (e) {
    return { mode, bruto: null, probe: { ok: false, detail: `platform.config.json ilegível: ${(e as Error).message}`, fix: "corrigir o platform.config.json" } };
  }
  if (!rootId) return { mode, bruto: null, probe: { ok: false, detail: "sem G: e sem publishing.youtube.drive_folder_id", fix: "preencher publishing.youtube.drive_folder_id no platform.config.json" } };
  const deps: MontageDriveDeps = { driveFetch: (url, init) => gFetchRetry(url, init ?? {}) };
  try {
    const res = await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(rootId)}?fields=id,name&supportsAllDrives=true`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { mode, bruto: null, probe: { ok: false, detail: `API do Drive: pasta YouTube ${rootId} respondeu ${res.status}` } };
    if (!edition) return { mode, bruto: null, probe: { ok: true, detail: `API do Drive, modo API (pasta YouTube ${rootId})` } };
    const folder = await findEditionFolder(deps, rootId, edition);
    const capRes = await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(folder.id)}?fields=capabilities(canAddChildren,canEdit)&supportsAllDrives=true`, { signal: AbortSignal.timeout(30_000) });
    const caps = capRes.ok ? ((await capRes.json()) as { capabilities?: { canAddChildren?: boolean } }).capabilities : undefined;
    if (caps && caps.canAddChildren === false) {
      return { mode, bruto: null, probe: { ok: false, detail: `a conta OAuth não pode gravar em ${edition}/ (${folder.id})`, fix: "dar permissão de edição na pasta YouTube à conta OAuth do projeto (as saídas sobem para lá)" } };
    }
    const raw = pickDriveBruto(await listChildren(deps, folder.id));
    if (!raw) return { mode, bruto: null, probe: { ok: true, detail: `API do Drive, modo API; ${edition}/ sem bruto ainda` } };
    const bytes = parseDriveSize(raw.pick.size);
    return { mode, bruto: { name: raw.pick.name, bytes }, probe: { ok: true, detail: `API do Drive, modo API; bruto ${raw.pick.name} (${((bytes ?? 0) / 1e9).toFixed(2)} GB)` } };
  } catch (e) {
    if (e instanceof EditionFolderError) return { mode, bruto: null, probe: { ok: false, detail: e.message, fix: `subir o bruto para a pasta ${edition}/ da pasta YouTube no Drive (uma pasta só com esse nome)` } };
    return { mode, bruto: null, probe: { ok: false, detail: `API do Drive: ${(e as Error).message}` } };
  }
}

export async function runMontageEnvCheck(edition?: string, pythonFlag?: string): Promise<MontageEnvReport> {
  const py = resolveVideoPython({ flag: pythonFlag, env: process.env.DIARIA_VIDEO_PYTHON, platform: process.platform, home: homedir(), exists: existsSync });
  const python = probeWhisperDecode(py.python);
  // Carrega o modelo de verdade (offline): download interrompido passa no "existe", não no load.
  const model = python.ok
    ? probePython(py.python, `from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8', local_files_only=True); print('${WHISPER_MODEL} carrega offline')`, 180_000)
    : { ok: false, detail: "sem Python com faster-whisper" };
  const drive = await probeDrive(edition);
  let disk: MontageProbe;
  if (drive.mode === "local") disk = { ok: true, detail: "não se aplica no modo local (o Drive for desktop guarda o bruto; o cache não é usado)" };
  else {
    const cacheRoot = process.env.DIARIA_VIDEO_CACHE_DIR ?? resolve(homedir(), ".cache", "diaria-video-montagem");
    const free = freeBytes(cacheRoot);
    let need = requiredFreeBytes(drive.bruto?.bytes ?? null);
    // Bruto já baixado (Passo 0 refeito na retomada): os bytes dele já saíram do espaço livre.
    if (edition && drive.bruto?.bytes) {
      const cached = join(cacheRoot, edition, "bruto", drive.bruto.name);
      if (existsSync(cached) && statSync(cached).size === drive.bruto.bytes) need -= drive.bruto.bytes;
    }
    disk = free === null
      ? { ok: false, detail: `espaço livre ilegível em ${cacheRoot}` }
      : { ok: free >= need, detail: `${(free / 1e9).toFixed(1)} GB livres no disco de ${cacheRoot}, precisa ${(need / 1e9).toFixed(1)} GB` };
  }
  return assessMontageEnv({ ffmpeg: probeCommand("ffmpeg", ["-version"]), python, model, drive: drive.probe, disk }, process.platform, py);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("montagem")) {
    const r = await runMontageEnvCheck(args.values["edition"], args.values["python"]);
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
