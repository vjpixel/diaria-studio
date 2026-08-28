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
//
// Nota: platform.config.json é lido com path relativo — executar a partir da raiz do projeto.
//
// `buildPrompt`/`buildResizeOptions` (abaixo) são exportados para teste
// unitário (`test/gemini-image.test.ts`) sem precisar chamar a API real —
// a execução de CLI (bloco `if (isMainModule)` no fim do arquivo) é a única
// parte que efetivamente gasta crédito.

import 'dotenv/config';
import fs from 'fs';
import sharp from 'sharp';

/**
 * Monta o prompt final enviado ao Gemini a partir do JSON de prompt (`sd`).
 * Puro — sem I/O, sem rede — para poder ser testado com um snapshot de texto.
 */
export function buildPrompt(sd) {
  // Gemini has no native negative prompt — fold it in as an avoidance instruction.
  let prompt = sd.positive;
  // Force "fill the entire canvas" instruction to prevent Gemini from rendering
  // the painting as a 3D object on a background (canvas frame effect).
  prompt += '\n\nCRITICAL: The painting must fill the ENTIRE image edge to edge. No visible canvas edges, no frame, no shadow, no border, no background behind the painting. The painted content must extend to all four edges of the image with no gaps or margins.';
  // #6459: when the subject is a head/face/animal, Gemini tends to compose it
  // filling the frame top-to-bottom (matching the "fill entire canvas" instruction
  // above too literally), leaving no margin above the head — and the deterministic
  // cover-crop below then has nothing to spare when it trims to the target aspect
  // ratio, cutting the top of the subject. Ask for headroom explicitly so the
  // generated composition itself leaves margin, independent of the crop step.
  prompt += '\n\nIMPORTANT: Leave clear headroom above the main subject — if the subject is a person, animal, or head, position it so the top of its head sits in the middle third of the frame vertically, never touching or almost touching the top edge. This margin is required even while still following the "fill entire canvas" instruction above (the margin is part of the painted scene, not empty canvas).';
  if (sd.negative) {
    prompt += `\n\nDo NOT include any of the following in the image: ${sd.negative}, canvas edge, canvas border, canvas frame, mounted canvas, 3D canvas, shadow behind painting, grey background, white background, wall behind painting`;
  }
  return prompt;
}

/**
 * Opções de resize pro path "final_width/final_height explícitos" (EIA 800x450,
 * mas também D1/D2/D3 2:1 — ver `scripts/image-generate.ts`). Extraído pra função
 * pura só pra travar a escolha de `position` em teste sem rodar sharp de verdade.
 *
 * #6459: 'attention' (saliency detection) substitui o default 'centre' — crop
 * uniforme em todos os lados cortava a cabeça do sujeito quando a composição
 * gerada já estava próxima do topo do frame (2 gerações consecutivas reproduziram
 * o corte na edição 260828). 'attention' segue o sujeito onde ele estiver; no
 * caso comum (sujeito centralizado) a região de maior saliência já cai perto do
 * centro, então o comportamento não muda.
 */
export function buildResizeOptions() {
  return { fit: 'cover', position: sharp.strategy.attention };
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}

async function main() {
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

  const prompt = buildPrompt(sd);

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
    const retryNum = attempt + 1;
    attempt += 1;
    process.stderr.write(`rate limited (retry ${retryNum}/${MAX_RETRIES}) — retrying in ${waitMs / 1000}s...\n`);
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

  // Trim any uniform borders (black, white, grey) Gemini adds as letterbox/frame.
  // threshold 80 covers black bars, light grey canvas edges, and gradient borders.
  const trimmed = await sharp(buf).trim({ threshold: 80 }).toBuffer();

  if (resizeW && resizeH) {
    // #6459: EIA path (800x450) had the subject's head cropped off the top —
    // fit:'cover' with the default 'centre' position crops evenly on all
    // sides, which cuts the head when the generated composition sits close
    // to the top of the frame (2 consecutive reproductions with the same
    // prompt, edition 260828). buildResizeOptions() picks the crop window
    // via saliency detection instead of a fixed anchor, so it follows
    // wherever the actual subject is — a deterministic safety net
    // independent of the prompt-side headroom instruction above (which only
    // influences what Gemini generates, not how the crop is applied
    // afterwards).
    const resized = await sharp(trimmed)
      .resize(resizeW, resizeH, buildResizeOptions())
      .jpeg({ quality: 90 })
      .toBuffer();
    fs.writeFileSync(outPath, resized);
  } else {
    // D2/D3: force square crop after trim to eliminate gradient borders.
    // Gemini generates slightly non-square with "painting on canvas" effect.
    const meta = await sharp(trimmed).metadata();
    const side = Math.min(meta.width, meta.height);
    const jpg = await sharp(trimmed)
      .resize(side, side, { fit: 'cover' })
      .jpeg({ quality: 90 })
      .toBuffer();
    fs.writeFileSync(outPath, jpg);
  }

  console.log(outPath);
}
