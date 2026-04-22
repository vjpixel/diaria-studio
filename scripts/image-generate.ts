/**
 * image-generate.ts
 *
 * Converte um prompt editorial (02-d1-prompt.md) em prompt SD (positive + negative),
 * grava o JSON de prompt e chama gemini-image.js para gerar a imagem.
 *
 * Uso:
 *   npx tsx scripts/image-generate.ts \
 *     --editorial data/editions/260418/02-d1-prompt.md \
 *     --out-dir data/editions/260418/ \
 *     --destaque d1
 *
 * Saída: data/editions/260418/05-d1.jpg (via gemini-image.js)
 *        Imprime o caminho do JPG em stdout.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Estilo fixo Van Gogh impasto — ver context/editorial-rules.md para a regra editorial.
const STYLE_SUFFIX =
  ", post-impressionist oil painting with thick impasto brushstrokes, swirling textures, bold complementary colors in the style of Vincent van Gogh, painterly, high contrast";

const NEGATIVE_PROMPT =
  "photorealistic, photography, pixel art, blurry, text, watermark, signature, low quality, deformed, ugly, The Starry Night, Starry Night, still life, flowers in vase, fruit bowl, potted plant, self-portrait, portrait of a man, picture frame, gallery wall, museum, painting as object, field of flowers, wheat field, landscape, wall painting";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

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
  const args = parseArgs(process.argv.slice(2));
  const editorialPath = args["editorial"];
  const outDir = args["out-dir"];
  const destaque = args["destaque"]; // d1, d2, d3

  if (!editorialPath || !outDir || !destaque) {
    console.error(
      "Uso: image-generate.ts --editorial <prompt.md> --out-dir <dir/> --destaque <d1|d2|d3>"
    );
    process.exit(1);
  }

  if (!/^d\d+$/.test(destaque)) {
    console.error(`--destaque deve ser d1, d2, d3, etc. Recebido: ${destaque}`);
    process.exit(1);
  }

  // Ler prompt editorial
  const editorialText = readFileSync(editorialPath, "utf8");
  const positivePrompt = buildPositivePrompt(editorialText);

  // Montar SD prompt JSON.
  // D1 é gerada em 2000×1000 (2:1) e depois cropada para 1000×1000 (cover da newsletter).
  // D2/D3 são geradas sem dimensões forçadas (Gemini escolhe).
  const isD1 = destaque === "d1";
  const sdPrompt: Record<string, unknown> = {
    positive: positivePrompt,
    negative: NEGATIVE_PROMPT,
    ...(isD1 ? { final_width: 2000, final_height: 1000 } : {}),
  };

  // Gravar JSON de prompt
  const normalizedOutDir = outDir.endsWith("/") ? outDir : outDir + "/";
  const sdPromptPath = `${normalizedOutDir}05-${destaque}-sd-prompt.json`;
  const outJpgPath = `${normalizedOutDir}05-${destaque}.jpg`;
  const filenamePrefix = `diaria_${destaque}_`;

  writeFileSync(sdPromptPath, JSON.stringify(sdPrompt, null, 2), "utf8");
  console.error(`Prompt gravado em ${sdPromptPath}`);
  console.error(`Positive: ${positivePrompt.slice(0, 120)}...`);

  // Escolher backend de geração com base em platform.config.json > image_generator.
  // Suporta "gemini" (padrão) e "comfyui".
  const platformCfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const generator = (platformCfg.image_generator ?? "gemini") as string;
  const scriptName = generator === "comfyui" ? "comfyui-run.js" : "gemini-image.js";
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

  // D1: crop centro de 2000×1000 → 1000×1000 (cover da newsletter)
  if (isD1) {
    const cropScript = resolve(ROOT, "scripts", "crop-resize.ts");
    try {
      execFileSync(
        "npx",
        ["tsx", cropScript, outJpgPath, outJpgPath, "--width", "1000", "--height", "1000"],
        { stdio: "inherit", cwd: ROOT, shell: true }
      );
      console.error(`D1 cropada para 1000×1000`);
    } catch (e: unknown) {
      const code = (e as { status?: number }).status ?? 1;
      console.error(`crop-resize falhou com código ${code}`);
      process.exit(code);
    }
  }

  // Sucesso — imprimir caminho do JPG em stdout (compatível com orchestrator)
  process.stdout.write(outJpgPath + "\n");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
