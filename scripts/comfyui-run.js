#!/usr/bin/env node
// Usage: node scripts/comfyui-run.js <sdPromptJson> <outJpg> <filenamePrefix>
// Submete workflow ao ComfyUI, aguarda conclusão, baixa a imagem. Uma única execução.

import fs from 'fs';
import sharp from 'sharp';

const [sdPromptPath, outPath, filenamePrefix] = process.argv.slice(2);

if (!sdPromptPath || !outPath || !filenamePrefix) {
  console.error('Usage: node scripts/comfyui-run.js <sdPromptJson> <outJpg> <filenamePrefix>');
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync('platform.config.json', 'utf8')).comfyui;
const sd = JSON.parse(fs.readFileSync(sdPromptPath, 'utf8'));
const host = cfg.host || 'http://127.0.0.1:8188';
const seed = Math.floor(Math.random() * 1e15);

const baseW = sd.base_width ?? cfg.base_width;
const baseH = sd.base_height ?? cfg.base_height;
const finalW = sd.width ?? cfg.width;
const finalH = sd.height ?? cfg.height;
const checkpoint = sd.checkpoint ?? cfg.checkpoint;
const skipHires = sd.skip_hires === true || (finalW === baseW && finalH === baseH);
const resizeW = sd.final_width ?? null;
const resizeH = sd.final_height ?? null;

const useLora = !!cfg.lora && ((cfg.lora_strength_model ?? 0) > 0 || (cfg.lora_strength_clip ?? 0) > 0);
const modelRef = useLora ? ["2", 0] : ["1", 0];
const clipRef  = useLora ? ["2", 1] : ["1", 1];

const nodes = {
  "1":  { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
  "3":  { class_type: "CLIPTextEncode", inputs: { text: sd.positive, clip: clipRef } },
  "4":  { class_type: "CLIPTextEncode", inputs: { text: sd.negative, clip: clipRef } },
  "5":  { class_type: "EmptyLatentImage", inputs: { width: baseW, height: baseH, batch_size: 1 } },
  "6":  { class_type: "KSampler", inputs: { model: modelRef, positive: ["3",0], negative: ["4",0], latent_image: ["5",0], seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: "karras", denoise: 1.0 } },
  "9":  { class_type: "VAEDecode", inputs: { samples: skipHires ? ["6",0] : ["8",0], vae: ["1",2] } },
  "10": { class_type: "SaveImage", inputs: { images: ["9",0], filename_prefix: filenamePrefix } }
};
if (!skipHires) {
  nodes["7"] = { class_type: "LatentUpscale", inputs: { samples: ["6",0], upscale_method: cfg.hires_upscale_method, width: finalW, height: finalH, crop: "disabled" } };
  nodes["8"] = { class_type: "KSampler", inputs: { model: modelRef, positive: ["3",0], negative: ["4",0], latent_image: ["7",0], seed: seed + 1, steps: cfg.hires_steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: "karras", denoise: cfg.hires_denoise } };
}
if (useLora) {
  nodes["2"] = { class_type: "LoraLoader", inputs: { model: ["1",0], clip: ["1",1], lora_name: cfg.lora, strength_model: cfg.lora_strength_model, strength_clip: cfg.lora_strength_clip } };
}
const workflow = { prompt: nodes };

(async () => {
  const t0 = Date.now();

  // Validar que o checkpoint está disponível antes de submeter (evita timeout
  // obscuro de 300s — ComfyUI aceita o workflow mas falha em execução se o
  // modelo não existir localmente, e o polling nunca detecta "completed").
  try {
    const objInfo = await fetch(`${host}/object_info/CheckpointLoaderSimple`).then(r => r.json());
    const available = objInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    if (Array.isArray(available) && available.length > 0 && !available.includes(checkpoint)) {
      console.error(`Checkpoint "${checkpoint}" não está disponível no ComfyUI.`);
      console.error(`Disponíveis: ${available.join(', ')}`);
      console.error(`Ajustar platform.config.json > comfyui.checkpoint ou baixar o modelo.`);
      process.exit(2);
    }
  } catch {
    // Se /object_info falhar (ComfyUI offline, versão sem endpoint), continuar
    // — o erro real surgirá no submit ou polling com mensagem adequada.
  }

  // Submit
  const submitRes = await fetch(`${host}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workflow)
  });
  if (!submitRes.ok) {
    console.error(`SUBMIT_FAILED ${submitRes.status} ${await submitRes.text()}`);
    process.exit(1);
  }
  const { prompt_id } = await submitRes.json();
  if (!prompt_id) { console.error('NO_PROMPT_ID'); process.exit(1); }

  process.stderr.write(`submitted ${prompt_id}\n`);

  // Poll every 1s, up to 5 min (300 tries)
  let filename = null;
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const histRes = await fetch(`${host}/history/${prompt_id}`);
    if (!histRes.ok) continue;
    const hist = await histRes.json();
    const entry = hist[prompt_id];
    if (!entry || !entry.status) continue;
    // Detectar node_errors antes de aguardar completed (que nunca vem se workflow errou)
    const nodeErrors = entry.status?.exec_info?.node_errors;
    if (nodeErrors && Object.keys(nodeErrors).length > 0) {
      console.error('ComfyUI node_errors:', JSON.stringify(nodeErrors, null, 2));
      process.exit(1);
    }
    if (!entry.status.completed) continue;
    const imgs = Object.values(entry.outputs || {}).flatMap(o => o.images || []);
    if (imgs.length) { filename = imgs[0].filename; break; }
  }
  if (!filename) { console.error('TIMEOUT'); process.exit(1); }

  process.stderr.write(`ready ${filename} in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  // Download
  const imgRes = await fetch(`${host}/view?filename=${encodeURIComponent(filename)}&type=output`);
  if (!imgRes.ok) { console.error(`DOWNLOAD_FAILED ${imgRes.status}`); process.exit(1); }
  const buf = Buffer.from(await imgRes.arrayBuffer());

  if (resizeW && resizeH) {
    const resized = await sharp(buf).resize(resizeW, resizeH, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
    fs.writeFileSync(outPath, resized);
  } else {
    fs.writeFileSync(outPath, buf);
  }

  console.log(outPath);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
