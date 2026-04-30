#!/usr/bin/env node
// Usage: node scripts/openai-image.js <promptJson> <outJpg> [filenamePrefix]
// Gera imagem via OpenAI Images API (gpt-image-2 default) e grava como JPEG.
//
// Variáveis de ambiente:
//   OPENAI_API_KEY — chave da API (obrigatório)
//
// O JSON de prompt usa os mesmos campos do sd-prompt:
//   positive    — texto do prompt (obrigatório)
//   negative    — termos a evitar (opcional; incorporado no prompt como instrução)
//   model       — override do modelo (opcional; default: platform.config.json > openai.model)
//   final_width / final_height — redimensionar via sharp (opcional)

import 'dotenv/config';
import fs from 'node:fs';
import sharp from 'sharp';

const [promptPath, outPath] = process.argv.slice(2);

if (!promptPath || !outPath) {
  console.error('Usage: node scripts/openai-image.js <promptJson> <outJpg> [prefix]');
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync('platform.config.json', 'utf8'));
const sd  = JSON.parse(fs.readFileSync(promptPath, 'utf8'));

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY não definida. Configure no .env (veja .env.example).');
  process.exit(1);
}

const model   = sd.model  || cfg.openai?.model   || 'gpt-image-2';
const quality = sd.quality || cfg.openai?.quality || 'auto';
const resizeW = sd.final_width  ?? null;
const resizeH = sd.final_height ?? null;

// OpenAI não tem campo nativo de negative prompt — fold como instrução de avoidance.
let prompt = sd.positive;
if (sd.negative) {
  prompt += `\n\nDo NOT include any of the following in the image: ${sd.negative}`;
}

// Escolher o tamanho suportado mais próximo da relação de aspecto desejada.
// OpenAI suporta: 1024x1024 (1:1), 1536x1024 (~3:2 landscape), 1024x1536 (~2:3 portrait).
// D1 pede 2:1 (1600x800) → usa 1536x1024 e sharp faz resize/crop depois.
function bestSize(w, h) {
  if (!w || !h) return '1024x1024';
  const ratio = w / h;
  if (ratio >= 1.4) return '1536x1024';
  if (ratio <= 0.7) return '1024x1536';
  return '1024x1024';
}

const size = bestSize(resizeW, resizeH);

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

async function callApi() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size,
        quality,
      }),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const t0 = Date.now();
  process.stderr.write(`Gerando via ${model} (${size}, quality=${quality})...\n`);

  let res;
  let attempt = 0;
  while (true) {
    try {
      res = await callApi();
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error(`API_TIMEOUT após ${REQUEST_TIMEOUT_MS / 1000}s`);
        process.exit(1);
      }
      throw err;
    }

    if (res.status !== 429 || attempt >= MAX_RETRIES) break;

    const retryAfter = res.headers.get('retry-after');
    const waitMs = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : 35_000 * Math.pow(2, attempt);
    attempt++;
    process.stderr.write(`Rate limited (tentativa ${attempt}/${MAX_RETRIES}) — aguardando ${waitMs / 1000}s...\n`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  if (!res.ok) {
    const errText = await res.text();
    console.error(`API_FAILED ${res.status}: ${errText}`);
    process.exit(1);
  }

  const data = await res.json();
  const item = data?.data?.[0];

  if (!item) {
    console.error('NO_IMAGE_IN_RESPONSE');
    console.error('raw:', JSON.stringify(data).slice(0, 500));
    process.exit(1);
  }

  process.stderr.write(`Pronto em ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Modelos novos (gpt-image-1/2) retornam URL; modelos legados (dall-e-3) retornam b64_json.
  let buf;
  if (item.b64_json) {
    buf = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    process.stderr.write(`Baixando imagem de URL temporária...\n`);
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) {
      console.error(`Falha ao baixar imagem: ${imgRes.status}`);
      process.exit(1);
    }
    buf = Buffer.from(await imgRes.arrayBuffer());
  } else {
    console.error('NO_IMAGE_IN_RESPONSE: nem b64_json nem url encontrados');
    console.error('raw item:', JSON.stringify(item).slice(0, 300));
    process.exit(1);
  }

  let pipeline = sharp(buf);
  if (resizeW && resizeH) {
    pipeline = pipeline.resize(resizeW, resizeH, { fit: 'cover', position: 'center' });
  }
  await pipeline.jpeg({ quality: 90 }).toFile(outPath);

  console.log(outPath);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
