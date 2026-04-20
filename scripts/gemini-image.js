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

const apiKey = process.env.GEMINI_API_KEY || cfg.gemini?.api_key;
if (!apiKey) {
  console.error('GEMINI_API_KEY não definido. Exporte a variável de ambiente antes de rodar.');
  process.exit(1);
}

const model  = sd.model || cfg.gemini?.model || 'gemini-3.1-flash-image-preview';
const resizeW = sd.final_width  ?? null;
const resizeH = sd.final_height ?? null;

// Gemini não tem prompt negativo nativo — incorporamos como instrução de evitar.
let prompt = sd.positive;
if (sd.negative) {
  prompt += `\n\nNão inclua nenhum dos seguintes elementos na imagem: ${sd.negative}`;
}

(async () => {
  const t0 = Date.now();

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] }
  };

  process.stderr.write(`submitting to ${model}...\n`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`API_FAILED ${res.status}: ${errText}`);
    process.exit(1);
  }

  const data = await res.json();

  // Extrair parte de imagem da resposta
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  if (!imagePart) {
    // Logar texto de erro se vier
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
    // Converter para JPEG independentemente do formato de saída da API
    const jpg = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
    fs.writeFileSync(outPath, jpg);
  }

  console.log(outPath);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
