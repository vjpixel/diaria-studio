#!/usr/bin/env node
// Usage: node scripts/codex-image.js <promptJson> <outJpg> [filenamePrefix]
// Gera imagem pelo Codex CLI (assinatura ChatGPT — sem custo por uso, #9088) e grava JPEG.
//
// O Codex não expõe a escolha do modelo de imagem (a ferramenta image_generation é
// interna); só o modelo "orquestrador" (-m). A conta ChatGPT recusa o default do
// ~/.codex/config.toml (gpt-6-sol), então o modelo é SEMPRE explícito:
// platform.config.json > codex.model (default gpt-5.6-luna).
//
// GUARD: nunca cair em API key pay-per-token — OPENAI_API_KEY/CODEX_API_KEY são
// removidas do ambiente do subprocesso (mesma lógica do #5608 pro Claude).
//
// Falha barulhenta: exit ≠ 0 se o Codex não gravar o arquivo. Nunca sucesso sem imagem.

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildResizeOptions } from './gemini-image.js';

export const DEFAULTS = { model: 'gpt-5.6-luna', reasoning_effort: 'low', timeout_seconds: 300 };
export const STRIPPED_ENV_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'];
export const MAX_ASPECT_MISMATCH = 1.5; // razão fonte/alvo (ou inversa) acima disso = proporção errada
const OUT_NAME = 'image.png';

export function sanitizedEnv(env) {
  const out = { ...env };
  for (const k of STRIPPED_ENV_VARS) delete out[k];
  return out;
}

export function targetAspectText(w, h) {
  if (!w || !h) return 'square (1:1)';
  const r = w / h;
  if (r >= 1.8) return 'wide landscape 2:1 (1536x768 or the closest supported wide size)';
  if (r <= 0.85) return 'portrait 4:5 (1080x1350 or the closest supported portrait size)';
  if (r >= 1.3) return 'landscape 16:9 (1536x864 or the closest supported landscape size)';
  return 'square (1:1)';
}

export function buildCodexPrompt(sd) {
  let p = `Use the built-in image generation tool to create ONE image and save it as ${OUT_NAME} in the current working directory.\n`;
  p += `Format: ${targetAspectText(sd.final_width, sd.final_height)}. The image must fill the entire canvas edge to edge, with no frame, border or visible canvas.\n\n`;
  p += `Image description:\n${sd.positive}\n`;
  if (sd.negative) p += `\nDo NOT include any of the following: ${sd.negative}\n`;
  p += `
Leave generous empty headroom above any head or main subject; never crop the top of a subject.
`;
  p += `\nDo not write any code and do not ask questions. When the file ${OUT_NAME} exists, reply with just "done".`;
  return p;
}

export function buildCodexArgs(cfg) {
  return [
    'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write',
    '-c', 'forced_login_method="chatgpt"', // recusa API key guardada em ~/.codex/auth.json (pay-per-token)
    '-m', cfg.model, '-c', `model_reasoning_effort=${cfg.reasoning_effort}`, '-',
  ];
}

export function checkAspect(srcW, srcH, dstW, dstH) {
  if (!dstW || !dstH) return null;
  const ratio = (srcW / srcH) / (dstW / dstH);
  const off = ratio >= 1 ? ratio : 1 / ratio;
  return off > MAX_ASPECT_MISMATCH
    ? `proporção errada: Codex gerou ${srcW}x${srcH}, alvo ${dstW}x${dstH}`
    : null;
}

function defaultRun(args, prompt, cwd, timeoutMs) {
  const opts = {
    cwd, input: prompt, encoding: 'utf8', timeout: timeoutMs,
    env: sanitizedEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  };
  const r = spawnSync('codex', args, opts); // .exe nativo / binário Linux
  // Windows com instalação npm expõe só codex.cmd (exige shell; args são todos literais seguros).
  if (r.error && r.error.code === 'ENOENT' && process.platform === 'win32') {
    return spawnSync('codex.cmd', args, { ...opts, shell: true });
  }
  return r;
}

/** Gera a imagem; lança Error em qualquer falha. `run` injetável para teste. */
export async function generateWithCodex(sd, outPath, userCfg = {}, run = defaultRun) {
  const cfg = { ...DEFAULTS, ...userCfg };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-img-'));
  try {
    const r = run(buildCodexArgs(cfg), buildCodexPrompt(sd), tmp, cfg.timeout_seconds * 1000);
    if (r.error && r.error.code === 'ETIMEDOUT') throw new Error(`CODEX_TIMEOUT após ${cfg.timeout_seconds}s`);
    if (r.error) throw new Error(`CODEX_SPAWN_FAILED: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`CODEX_FAILED exit=${r.status}: ${String(r.stderr || r.stdout).slice(-500)}`);
    const png = path.join(tmp, OUT_NAME);
    if (!fs.existsSync(png)) throw new Error(`NO_IMAGE_FILE: Codex terminou sem gravar ${OUT_NAME}`);
    const meta = await sharp(png).metadata();
    const bad = checkAspect(meta.width, meta.height, sd.final_width, sd.final_height);
    if (bad) throw new Error(bad);
    let pipeline = sharp(png);
    if (sd.final_width && sd.final_height) {
      pipeline = pipeline.resize(sd.final_width, sd.final_height, buildResizeOptions());
    }
    await pipeline.jpeg({ quality: 90 }).toFile(outPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const [promptPath, outPath] = process.argv.slice(2);
  if (!promptPath || !outPath) {
    console.error('Usage: node scripts/codex-image.js <promptJson> <outJpg> [prefix]');
    process.exit(2);
  }
  const appCfg = JSON.parse(fs.readFileSync('platform.config.json', 'utf8'));
  const sd = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
  const t0 = Date.now();
  generateWithCodex(sd, outPath, appCfg.codex ?? {})
    .then(() => {
      process.stderr.write(`Codex pronto em ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
      console.log(outPath);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
