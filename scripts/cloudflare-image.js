#!/usr/bin/env node
// Usage: node scripts/cloudflare-image.js <promptJson> <outJpg> [filenamePrefix]
// Gera uma imagem via Cloudflare Workers AI (FLUX-1-schnell default) e grava como JPEG.
//
// Variáveis de ambiente:
//   CLOUDFLARE_ACCOUNT_ID — ID da conta CF (obrigatório)
//   CLOUDFLARE_API_TOKEN — token com scope "Workers AI" (obrigatório)
//
// O JSON de prompt usa os mesmos campos do sd-prompt (compat com Gemini):
//   positive    — texto do prompt (obrigatório)
//   negative    — termos a evitar (opcional; fold in como anti-terms em alguns modelos)
//   model       — override do modelo (opcional; default: platform.config.json > cloudflare.model)
//   final_width / final_height — redimensionar via sharp (opcional)
//
// Modelos suportados:
//   @cf/black-forest-labs/flux-1-schnell (default, rápido, qualidade alta)
//   @cf/stabilityai/stable-diffusion-xl-base-1.0 (suporte a negative_prompt + width/height)
//
// Response handling:
//   FLUX retorna { result: { image: base64 }, success: true }
//   SDXL retorna binário PNG direto no body

import fs from "node:fs";
import sharp from "sharp";

const [promptPath, outPath] = process.argv.slice(2);

if (!promptPath || !outPath) {
  console.error("Usage: node scripts/cloudflare-image.js <promptJson> <outJpg> [prefix]");
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync("platform.config.json", "utf8"));
const sd = JSON.parse(fs.readFileSync(promptPath, "utf8"));

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken) {
  console.error(
    "CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_API_TOKEN precisam estar exportados como env vars. Veja .env.example.",
  );
  process.exit(1);
}

const model = sd.model || cfg.cloudflare?.model || "@cf/black-forest-labs/flux-1-schnell";
const steps = sd.num_steps ?? cfg.cloudflare?.steps ?? 4;
const guidance = sd.guidance ?? cfg.cloudflare?.guidance ?? 7.5;
const resizeW = sd.final_width ?? null;
const resizeH = sd.final_height ?? null;

const isFlux = model.includes("flux");
const isSdxl = model.includes("stable-diffusion");

// FLUX não suporta negative_prompt nativo — fold como instruction (menos eficaz que SDXL).
const prompt = isFlux && sd.negative
  ? `${sd.positive} (avoid: ${sd.negative})`
  : sd.positive;

// SDXL exige width/height múltiplos de 8 — a API rejeita com erro genérico
// "Invalid input" quando recebe valores fora dessa grade. Fazer snap automático
// + warning audível pra editor não perder tempo debugando (#92).
function snapTo8(n) {
  return Math.round(n / 8) * 8;
}

let body;
if (isSdxl) {
  const w = resizeW ?? 1024;
  const h = resizeH ?? 1024;
  const wSnap = snapTo8(w);
  const hSnap = snapTo8(h);
  if (wSnap !== w || hSnap !== h) {
    console.error(
      `⚠️ SDXL exige dimensões múltiplas de 8. Ajustando ${w}x${h} → ${wSnap}x${hSnap}.`,
    );
  }
  body = {
    prompt: sd.positive,
    negative_prompt: sd.negative || undefined,
    width: wSnap,
    height: hSnap,
    num_steps: steps,
    guidance,
  };
} else {
  body = {
    prompt,
    num_steps: Math.min(steps, 8), // schnell: 1-8 max
  };
}

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

console.error(`Cloudflare Workers AI: ${model}`);
console.error(`Prompt: ${prompt.slice(0, 120)}...`);

// Timeout de 90s — evita pipeline travar se CF hangar.
const TIMEOUT_MS = 90_000;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

let res;
try {
  res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
} catch (e) {
  clearTimeout(timer);
  if (e.name === "AbortError") {
    console.error(`Cloudflare API timeout após ${TIMEOUT_MS / 1000}s.`);
    process.exit(1);
  }
  console.error(`Cloudflare fetch error: ${e.message ?? e}`);
  process.exit(1);
}
clearTimeout(timer);

if (!res.ok) {
  const errText = await res.text();
  console.error(`Cloudflare API error ${res.status}: ${errText}`);
  process.exit(1);
}

// Parse response — duas formas dependendo do modelo
let imageBuffer;
const contentType = res.headers.get("content-type") || "";

if (contentType.includes("application/json")) {
  // FLUX: { result: { image: base64 }, success: true }
  const data = await res.json();
  if (!data.success) {
    console.error(`Cloudflare API returned error: ${JSON.stringify(data.errors || data)}`);
    process.exit(1);
  }
  const base64 = data.result?.image;
  if (!base64) {
    console.error(`Unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`);
    process.exit(1);
  }
  imageBuffer = Buffer.from(base64, "base64");
} else {
  // SDXL retorna binário PNG direto
  imageBuffer = Buffer.from(await res.arrayBuffer());
}

// Resize + converter pra JPEG via sharp
let pipeline = sharp(imageBuffer);
if (resizeW && resizeH) {
  pipeline = pipeline.resize(resizeW, resizeH, { fit: "cover", position: "center" });
}
await pipeline.jpeg({ quality: 90 }).toFile(outPath);

console.error(`Imagem gerada: ${outPath}`);
process.stdout.write(outPath);
