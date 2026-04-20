#!/usr/bin/env node
// Usage: node scripts/gemini-image.js <promptJson> <outJpg> [filenamePrefix]
// Gera uma imagem via Gemini API e grava como JPEG.
//
// Variáveis de ambiente:
//   GEMINI_API_KEY  — chave da API (obrigatório)
//
// O JSON de prompt usa os mesmos campos do sd-prompt:
//   positive    — texto do prompt (obrigatório)
//   negative    — termos a evitar (opcional; incorporado no prompt como instrução)
//   model       — override do modelo (opcional; default: platform.config.json > gemini.model)
//   final_width / final_height — redimensionar via sharp (opcional)

import fs from 'fs';
import sharp from 'sharp';

const [promptPath, outPath] = process.argv.slice(2);

if (!promptPath || !outPath) {
  console.error('Usage: node scripts/gemini-image.js <promptJson> <outJpg> [prefix]');
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync('platform.config.json', 'utf8'));
const sd  = JSON.parse(fs.readFileSync(promptPath, 'utf8'));

// API key comes ONLY from env var — never from platform.config.json (which is tracked
// in git; putting a key there leaks it in commit history).
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY not set. Export the env var before running (see .env.example).');
  process.exit(1);
}

const model   = sd.model || cfg.gemini?.model || 'gemini-3.1-flash-image-preview';
const resizeW = sd.final_width  ?? null;
const resizeH = sd.final_height ?? null;

// Gemini has no native negative prompt — fold it in as an avoidance instruction.
let prompt = sd.positive;
if (sd.negative) {
  prompt += `\n\nDo NOT include any of the following in the image: ${sd.negative}`;
}

const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const REQUEST_TIMEOUT_MS = 120_000; // generation can legitimately take 30-60s; 120s is the hard ceiling
const MAX_RETRIES = 2;              // up to 3 total attempts on 429

async function callApi() {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] }
  };

  // AbortController ensures we never hang forever if the API stalls.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      // Use header instead of query param to avoid key appearing in process lists / logs.
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const t0 = Date.now();

  process.stderr.write(`submitting to ${model}...\n`);

  // Retry up to MAX_RETRIES times on 429. Backoff respects Retry-After header;
  // falls back to exponential (35s, 70s, ...) if the header is absent.
  let res;
  let attempt = 0;
  while (true) {
    try {
      res = await callApi();
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error(`API_TIMEOUT after ${REQUEST_TIMEOUT_MS / 1000}s`);
        process.exit(1);
      }
      throw err;
    }

    if (res.status !== 429 || attempt >= MAX_RETRIES) break;

    const retryAfterHeader = res.headers.get('retry-after');
    const baseWait = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 35_000;
    const waitMs = baseWait * Math.pow(2, attempt); // exponential when no Retry-After
    attempt += 1;
    process.stderr.write(`rate limited (attempt ${attempt}/${MAX_RETRIES}) — retrying in ${waitMs / 1000}s...\n`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  if (!res.ok) {
    const errText = await res.text();
    console.error(`API_FAILED ${res.status}: ${errText}`);
    process.exit(1);
  }

  const data = await res.json();

  // Extract image part from response.
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  if (!imagePart) {
    const textPart = parts.find(p => p.text);
    console.error('NO_IMAGE_IN_RESPONSE');
    if (textPart) console.error('model said:', textPart.text);
    else console.error('raw response:', JSON.stringify(data).slice(0, 500));
    process.exit(1);
  }

  process.stderr.write(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s (${imagePart.inlineData.mimeType})\n`);

  const buf = Buffer.from(imagePart.inlineData.data, 'base64');

  if (resizeW && resizeH) {
    const resized = await sharp(buf)
      .resize(resizeW, resizeH, { fit: 'cover' })
      .jpeg({ quality: 90 })
      .toBuffer();
    fs.writeFileSync(outPath, resized);
  } else {
    // Convert to JPEG regardless of API output format.
    const jpg = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
    fs.writeFileSync(outPath, jpg);
  }

  console.log(outPath);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
