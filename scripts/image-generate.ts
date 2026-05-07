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
 * Saída: D1 → 04-d1-2x1.jpg (1600×800) + 04-d1-1x1.jpg (800×800 center crop)
 *        D2/D3 → 04-d{N}-1x1.jpg (1024×1024 native Gemini)
 *        Imprime o caminho do JPG principal em stdout.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSdPrompt } from "./lib/schemas/image-generate.ts"; // #649

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Estilo fixo Van Gogh impasto — ver context/editorial-rules.md para a regra editorial.
const STYLE_SUFFIX =
  ", post-impressionist oil painting with thick impasto brushstrokes, swirling textures, bold complementary colors in the style of Vincent van Gogh, painterly, high contrast";

const NEGATIVE_PROMPT =
  "photorealistic, photography, pixel art, blurry, text, watermark, signature, low quality, deformed, ugly, The Starry Night, Starry Night, still life, flowers in vase, fruit bowl, potted plant, self-portrait, portrait of a man, picture frame, gallery wall, museum, painting as object, field of flowers, wheat field, landscape, wall painting, letters, words, writing, signs, labels, captions, banners, posters, billboards, readable text, typography, font, digits, numbers on screen";

/**
 * Parser que suporta boolean flags (#924). Quando `--force` é o último arg
 * (ou seguido por outro `--<flag>`), trata como boolean true. Antes, parser
 * exigia value pra cada flag, então `--force` no fim era silenciosamente
 * ignorado e a regen pulada com mensagem confusa "use --force".
 */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
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
  // String args podem ser `true` se passados sem value (mal-uso) — coerce
  // pra undefined nesse caso pra manter validação consistente.
  const asStr = (v: string | boolean | undefined): string | undefined =>
    typeof v === "string" ? v : undefined;
  const editorialPath = asStr(args["editorial"]);
  const outDir = asStr(args["out-dir"]);
  const destaque = asStr(args["destaque"]); // d1, d2, d3

  const force = !!args["force"];

  if (!editorialPath || !outDir || !destaque) {
    console.error(
      "Uso: image-generate.ts --editorial <prompt.md> --out-dir <dir/> --destaque <d1|d2|d3> [--force]"
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
  // D1 é gerada em 1600×800 (2:1). Depois gera crop 1:1 (800×800).
  // D2/D3 são geradas em 1024×1024 (forçado explícito pra garantir proporção 1:1).
  const isD1 = destaque === "d1";
  const sdPromptRaw: Record<string, unknown> = {
    positive: positivePrompt,
    negative: NEGATIVE_PROMPT,
    ...(isD1
      ? { final_width: 1600, final_height: 800 }
      : { final_width: 1024, final_height: 1024 }),
  };
  // #649: validar shape antes de gravar — fail-loud se positive curto, dims fora do range
  const sdPrompt = parseSdPrompt(sdPromptRaw);

  // Gravar JSON de prompt
  const normalizedOutDir = outDir.endsWith("/") ? outDir : outDir + "/";
  const sdPromptPath = `${normalizedOutDir}04-${destaque}-sd-prompt.json`;
  const outJpgPath = isD1
    ? `${normalizedOutDir}04-${destaque}.jpg`  // D1 usa nomes próprios (2x1, 1x1) gerados abaixo
    : `${normalizedOutDir}04-${destaque}-1x1.jpg`;
  const filenamePrefix = `diaria_${destaque}_`;

  // Idempotence: pular se imagem final já existe (re-run sem intenção de regenerar).
  // D1: exige AMBOS 2x1 e 1x1 — se só 2x1 existe (crash antes do crop), não pula.
  const d1Path2x1 = `${normalizedOutDir}04-${destaque}-2x1.jpg`;
  const d1Path1x1 = `${normalizedOutDir}04-${destaque}-1x1.jpg`;
  const checkExistPath = isD1
    ? (existsSync(d1Path2x1) && existsSync(d1Path1x1) ? d1Path2x1 : null)
    : (existsSync(outJpgPath) ? outJpgPath : null);
  if (checkExistPath && !force) {
    console.error(`Imagem ${checkExistPath} já existe — use --force pra regenerar.`);
    process.stdout.write((isD1 ? d1Path2x1 : outJpgPath) + "\n");
    if (isD1) process.stdout.write(d1Path1x1 + "\n");
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

  // D1: salvar 1600×800 como 04-d1-2x1.jpg, crop centro para 800×800 como 04-d1-1x1.jpg
  if (isD1) {
    const wideJpgPath = `${normalizedOutDir}04-${destaque}-2x1.jpg`;
    const squareJpgPath = `${normalizedOutDir}04-${destaque}-1x1.jpg`;
    const cropScript = resolve(ROOT, "scripts", "crop-resize.ts");

    // Renomear o output original (1600×800) para -2x1
    renameSync(outJpgPath, wideJpgPath);
    console.error(`D1 wide: ${wideJpgPath} (1600×800)`);

    // Crop centro para 1:1 (800×800).
    // Usa process.execPath + --import tsx (em vez de npx + shell:true) pra
    // preservar args com espaços e evitar DEP0190 — mesmo pattern do #213.
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", cropScript, wideJpgPath, squareJpgPath, "--width", "800", "--height", "800"],
        { stdio: "inherit", cwd: ROOT }
      );
      console.error(`D1 square: ${squareJpgPath} (800×800)`);
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

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
