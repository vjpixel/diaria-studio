/**
 * image-generate.ts
 *
 * Converte um prompt editorial (_internal/02-d1-prompt.md) em prompt SD (positive + negative),
 * grava o JSON de prompt e chama gemini-image.js para gerar a imagem.
 *
 * Uso:
 *   npx tsx scripts/image-generate.ts \
 *     --editorial data/editions/260418/_internal/02-d1-prompt.md \
 *     --out-dir data/editions/260418/ \
 *     --destaque d1
 *
 * Saída (default): D1 → 04-d1-2x1.jpg (1600×800) + 04-d1-1x1.jpg (800×800 center crop)
 *        D2/D3 → 04-d{N}-1x1.jpg (1024×1024 native Gemini)
 *        Imprime o caminho do JPG principal em stdout.
 *
 * `--ratio 2x1|1x1` (#1916): força o formato pra qualquer destaque. A mensal usa
 * `--ratio 2x1` em d1/d2/d3 (todos 2x1). Sem a flag, mantém o default da diária
 * (d1 → 2x1, d2/d3 → 1x1).
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSdPrompt } from "./lib/schemas/image-generate.ts"; // #649
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Estilo fixo Van Gogh impasto — ver context/editorial-rules.md para a regra editorial.
// #1241: instrução anti-texto movida pro positive prompt com fraseado afirmativo.
// Gemini Flash Image respeita melhor instruções positivas que negative prompt
// (que ele interpreta como descrição geral, às vezes induzindo o oposto).
// #2657: instrução de safe-area central — todos os sujeitos principais agrupados
// na metade central do frame, visíveis após o crop 1:1 (800×800 do centro de 1600×800).
// #3633: instrução de safe-area VERTICAL — análoga à horizontal do #2657, mas pro
// eixo vertical. Bug 260717: figura robótica angulosa gerada 3× seguidas com a
// CABEÇA cortada no topo do frame 1600×800 (2:1) — e por consequência no crop
// 800×800 (1:1) derivado. O modelo tende a desenhar a figura grande/próxima
// demais verticalmente quando a cena tem um personagem antropomórfico/robótico
// em pé. Fix editorial pontual aplicado no gate (wide shot + headroom explícito)
// promovido pra regra global aqui, pra não precisar de ajuste manual por edição.
// Exportada para teste de regressão em test/image-generate-safe-area.test.ts.
export const STYLE_SUFFIX =
  ", post-impressionist oil painting with thick impasto brushstrokes, swirling textures, bold complementary colors in the style of Vincent van Gogh, painterly, high contrast. " +
  "All principal subjects must be grouped together in the central half of the horizontal frame so that all of them remain fully visible when the image is cropped to a square (1:1); do not place key subjects near the left or right edges. " +
  "When the scene includes a standing or upright figure (human, robot, or humanoid character), frame it as a wide shot: the entire figure, including the head and feet, must fit comfortably within the frame with generous empty margin above the head; never crop or cut off the top of the head. " +
  "Purely visual scene with absolutely no written characters, no letters, no digits, no symbols on any surface; " +
  "all signage, papers, screens, books and labels rendered as abstract shapes or solid color blocks without any text or numbers.";

// #1241: NEGATIVE_PROMPT enxuto — termos texto-related removidos porque
// Gemini não respeita negative prompts como Stable Diffusion (pode até induzir
// geração quando palavras texto aparecem). Anti-texto agora vive no positive.
// Mantidos: filtros de estilo (photorealistic, blurry), proibições editoriais
// (Starry Night), e objetos visuais não relacionados a texto.
const NEGATIVE_PROMPT =
  "photorealistic, photography, pixel art, blurry, low quality, deformed, ugly, The Starry Night, Starry Night, still life, flowers in vase, fruit bowl, potted plant, self-portrait, portrait of a man, picture frame, gallery wall, museum, painting as object, field of flowers, wheat field, landscape, wall painting";

function buildPositivePrompt(editorialText: string): string {
  // Remove markdown formatting (headings, bold, links) and get clean scene description
  const scene = editorialText
    .replace(/^#+\s*/gm, "")           // remove headings
    .replace(/\*\*([^*]+)\*\*/g, "$1") // remove bold
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // remove links
    .replace(/\n+/g, " ")
    .trim();
  return scene + STYLE_SUFFIX;
}

function main() {
  // #926: usar parser compartilhado. Fix de #924 sai de graça —
  // `--force` no fim do argv agora é registrado em flags (Set), não values.
  const parsed = parseCliArgs(process.argv.slice(2));
  const args = parsed.values;
  const editorialPath = args["editorial"];
  const outDir = args["out-dir"];
  const destaque = args["destaque"]; // d1, d2, d3

  // #924: aceitar `--force` em qualquer posição (último arg, no meio, etc).
  const force = parsed.flags.has("force") || !!args["force"];

  if (!editorialPath || !outDir || !destaque) {
    console.error(
      "Uso: image-generate.ts --editorial <prompt.md> --out-dir <dir/> --destaque <d1|d2|d3> [--ratio 2x1|1x1] [--force]"
    );
    process.exit(1);
  }

  if (!/^d\d+$/.test(destaque)) {
    console.error(`--destaque deve ser d1, d2, d3, etc. Recebido: ${destaque}`);
    process.exit(1);
  }

  // #1916: --ratio força o formato. Sem a flag, default da diária (todos os
  // destaques d1/d2/d3 usam 2x1 como hero inline no email, #2133/#2141).
  const ratio = args["ratio"];
  if (ratio !== undefined && ratio !== "2x1" && ratio !== "1x1") {
    console.error(`--ratio deve ser 2x1 ou 1x1. Recebido: ${ratio}`);
    process.exit(1);
  }
  // Default wide para d1/d2/d3: hero 2:1 inline. --ratio 1x1 ainda funciona
  // como override (ex: mensal que precisasse apenas do square).
  const wide = ratio === "2x1" || (ratio === undefined && /^d[123]$/.test(destaque));

  // Ler prompt editorial
  const editorialText = readFileSync(editorialPath, "utf8");
  const positivePrompt = buildPositivePrompt(editorialText);

  // Montar SD prompt JSON.
  // Wide (2x1): 1600×800, depois crop 1:1 (800×800).
  // Square (1x1): 1024×1024 (forçado explícito pra garantir proporção 1:1).
  const sdPromptRaw: Record<string, unknown> = {
    positive: positivePrompt,
    negative: NEGATIVE_PROMPT,
    ...(wide
      ? { final_width: 1600, final_height: 800 }
      : { final_width: 1024, final_height: 1024 }),
  };
  // #649: validar shape antes de gravar — fail-loud se positive curto, dims fora do range
  const sdPrompt = parseSdPrompt(sdPromptRaw);

  // Gravar JSON de prompt
  const normalizedOutDir = outDir.endsWith("/") ? outDir : outDir + "/";
  const sdPromptPath = `${normalizedOutDir}04-${destaque}-sd-prompt.json`;
  const outJpgPath = wide
    ? `${normalizedOutDir}04-${destaque}.jpg`  // Wide usa nomes próprios (2x1, 1x1) gerados abaixo
    : `${normalizedOutDir}04-${destaque}-1x1.jpg`;
  const filenamePrefix = `diaria_${destaque}_`;

  // Idempotence: pular se imagem final já existe (re-run sem intenção de regenerar).
  // Wide: exige AMBOS 2x1 e 1x1 — se só 2x1 existe (crash antes do crop), não pula.
  const widePath2x1 = `${normalizedOutDir}04-${destaque}-2x1.jpg`;
  const widePath1x1 = `${normalizedOutDir}04-${destaque}-1x1.jpg`;
  const checkExistPath = wide
    ? (existsSync(widePath2x1) && existsSync(widePath1x1) ? widePath2x1 : null)
    : (existsSync(outJpgPath) ? outJpgPath : null);
  if (checkExistPath && !force) {
    console.error(`Imagem ${checkExistPath} já existe — use --force pra regenerar.`);
    process.stdout.write((wide ? widePath2x1 : outJpgPath) + "\n");
    if (wide) process.stdout.write(widePath1x1 + "\n");
    process.exit(0);
  }

  writeFileSync(sdPromptPath, JSON.stringify(sdPrompt, null, 2), "utf8");
  console.error(`Prompt gravado em ${sdPromptPath}`);
  console.error(`Positive: ${positivePrompt.slice(0, 120)}...`);

  // Escolher backend de geração com base em platform.config.json > image_generator.
  // Suporta "gemini" (padrão), "cloudflare" (Workers AI free tier) e "comfyui".
  const platformCfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const generator = (platformCfg.image_generator ?? "gemini") as string;
  const scriptName =
    generator === "comfyui"     ? "comfyui-run.js" :
    generator === "cloudflare"  ? "cloudflare-image.js" :
    generator === "openai"      ? "openai-image.js" :
    "gemini-image.js";
  const imageScript = resolve(ROOT, "scripts", scriptName);

  try {
    execFileSync(
      process.execPath, // node
      [imageScript, sdPromptPath, outJpgPath, filenamePrefix],
      { stdio: "inherit", cwd: ROOT }
    );
  } catch (e: unknown) {
    const code = (e as { status?: number }).status ?? 1;
    console.error(`${scriptName} falhou com código ${code}`);
    process.exit(code);
  }

  // Wide: salvar 1600×800 como 04-d{N}-2x1.jpg, crop centro 800×800 como 04-d{N}-1x1.jpg
  if (wide) {
    const wideJpgPath = `${normalizedOutDir}04-${destaque}-2x1.jpg`;
    const squareJpgPath = `${normalizedOutDir}04-${destaque}-1x1.jpg`;
    const cropScript = resolve(ROOT, "scripts", "crop-resize.ts");

    // Renomear o output original (1600×800) para -2x1
    renameSync(outJpgPath, wideJpgPath);
    console.error(`${destaque} wide: ${wideJpgPath} (1600×800)`);

    // Crop centro para 1:1 (800×800).
    // Usa process.execPath + --import tsx (em vez de npx + shell:true) pra
    // preservar args com espaços e evitar DEP0190 — mesmo pattern do #213.
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", cropScript, wideJpgPath, squareJpgPath, "--width", "800", "--height", "800"],
        { stdio: "inherit", cwd: ROOT }
      );
      console.error(`${destaque} square: ${squareJpgPath} (800×800)`);
    } catch (e: unknown) {
      const code = (e as { status?: number }).status ?? 1;
      console.error(`crop-resize falhou com código ${code}`);
      process.exit(code);
    }

    process.stdout.write(wideJpgPath + "\n");
    process.stdout.write(squareJpgPath + "\n");
  } else {
    process.stdout.write(outJpgPath + "\n");
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
