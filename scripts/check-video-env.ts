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
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { isBrandSerifAvailable } from "./lib/shared/assert-brand-font.ts";
import {
  assessVideoEnv,
  formatVideoEnvReport,
  rembgVenvPython,
  type ProbeResult,
  type VideoEnvProbes,
  type VideoEnvReport,
} from "./lib/diaria/video-env-check.ts";

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

export async function runVideoEnvCheck(): Promise<VideoEnvReport> {
  const probes: VideoEnvProbes = {
    ffmpeg: probeCommand("ffmpeg", ["-version"]),
    codex: probeCommand("codex", ["--version"]),
    georgia: await probeGeorgia(),
    rembg: probeRembg(),
  };
  return assessVideoEnv(probes, process.platform);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
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
