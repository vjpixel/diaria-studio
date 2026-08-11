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
import { parsePlatformConfig } from "./lib/schemas/platform-config.ts"; // #4625 item 4

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
  "Compose for later reframing: this single artwork is cropped into a wide format (2:1, which keeps the full width and trims top and bottom) and into portrait formats (4:5 and 9:16, which keep the full height and trim left and right). Every essential element must therefore sit inside the central 67% of the width and the central 59% of the height — the rectangle common to both crops — and never touch any edge. " +
  "Reserve the bottom fifth of the frame as a calm, low-detail area (ground, shadow, plain surface or penumbra) with no faces, hands or key objects, because a headline will later be placed over it; keep that band darker and simpler than the rest of the scene. " +
  "Purely visual scene with absolutely no written characters, no letters, no digits, no symbols on any surface; " +
  "all signage, papers, screens, books and labels rendered as abstract shapes or solid color blocks without any text or numbers.";

// #1241: NEGATIVE_PROMPT enxuto — termos texto-related removidos porque
// Gemini não respeita negative prompts como Stable Diffusion (pode até induzir
// geração quando palavras texto aparecem). Anti-texto agora vive no positive.
// Mantidos: filtros de estilo (photorealistic, blurry), proibições editoriais
// (Starry Night), e objetos visuais não relacionados a texto.
const NEGATIVE_PROMPT =
  "photorealistic, photography, pixel art, blurry, low quality, deformed, ugly, The Starry Night, Starry Night, still life, flowers in vase, fruit bowl, potted plant, self-portrait, portrait of a man, picture frame, gallery wall, museum, painting as object, field of flowers, wheat field, landscape, wall painting";

export type ImageRatio = "2x1" | "1x1" | "4x5" | "master";

export interface RatioResolution {
  ratio: ImageRatio;
  wide: boolean;
  portrait45: boolean;
  master: boolean;
  width: number;
  height: number;
}

/**
 * Resolve a proporção efetiva (explícita via `--ratio`, ou default por
 * destaque quando omitida) e as dimensões finais de saída.
 *
 * Extraído de `main()` (#4093) pra ser testável sem invocar o gerador de
 * imagem real (execFileSync → gemini-image.js custaria dinheiro por teste).
 * `--ratio 4x5` e `--ratio master` ganharam a flag no #4114 sem cobertura
 * própria das dimensões — só STYLE_SUFFIX tinha teste (test/image-generate-safe-area.test.ts).
 */
export function resolveRatio(rawRatio: string | undefined, destaque: string): RatioResolution {
  if (rawRatio !== undefined && rawRatio !== "2x1" && rawRatio !== "1x1" && rawRatio !== "4x5" && rawRatio !== "master") {
    throw new Error(`--ratio deve ser 2x1, 1x1, 4x5 ou master. Recebido: ${rawRatio}`);
  }
  // Default wide para d1/d2/d3: hero 2:1 inline. --ratio 1x1 ainda funciona
  // como override (ex: mensal que precisasse apenas do square).
  const wide = rawRatio === "2x1" || (rawRatio === undefined && /^d[123]$/.test(destaque));
  // 4:5 NATIVO (1080×1350): card de feed gerado na proporção final, sem crop.
  const portrait45 = rawRatio === "4x5";
  // MASTER (1600×1350, ~6:5): proporção-envelope que CONTÉM 2:1 e 4:5 (rejeitada
  // como default em favor de geração dedicada por formato, ver #4093, mas a
  // flag continua funcional pra edições antigas / uso manual).
  const master = rawRatio === "master";
  const { width, height } = master
    ? { width: 1600, height: 1350 }
    : portrait45
      ? { width: 1080, height: 1350 }
      : wide
        ? { width: 1600, height: 800 }
        : { width: 1024, height: 1024 };
  const ratio: ImageRatio = master ? "master" : portrait45 ? "4x5" : wide ? "2x1" : "1x1";
  return { ratio, wide, portrait45, master, width, height };
}

export type WideImageIntegrityAction =
  | { kind: "skip" }
  | { kind: "derive-1x1-from-2x1" }
  | { kind: "regenerate" };

/**
 * resolveWideImageIntegrity (#4989)
 *
 * Extraído de `main()` (mesmo padrão de `resolveRatio`, #4093) pra ser
 * testável sem tocar disco nem chamar o gerador de imagem real.
 *
 * Caso real (#4989, edição 260811): o editor promove D3 → D1 movendo
 * `04-d3-*.jpg` → `04-d1-*.jpg` no filesystem, FORA do pipeline (não via
 * `swap-destaque.ts`, que já teria apagado as imagens antigas de propósito
 * pra forçar Stage 3 a rodar de novo). Se esse `mv` manual mover só um dos
 * dois arquivos do par wide (ex: `-2x1.jpg` mas não `-1x1.jpg`, ou
 * vice-versa — um `mv 04-d3-*.jpg 04-d1-*.jpg` com glob parcial, erro de
 * digitação, ou apenas o editor não sabendo que o par É atômico), o check
 * de idempotência ANTERIOR (`existsSync(2x1) && existsSync(1x1)`) tratava
 * "só um dos dois presente" exatamente igual a "nenhum presente": caía pro
 * fluxo de geração NOVA via IA (Gemini/ComfyUI), que ao final faz
 * `renameSync(outJpgPath, wideJpgPath)` — e `renameSync` SOBRESCREVE o
 * destino em silêncio se ele já existir. Resultado: o `04-d1-2x1.jpg`
 * recém-promovido pelo editor era APAGADO por uma imagem nova gerada do
 * zero, sem NENHUM erro ou aviso nos logs — exatamente o sintoma relatado
 * ("os arquivos desaparecem... sem erro nos logs").
 *
 * Fix: distinguir os 3 estados possíveis do par.
 *   - Ambos presentes → `skip` (idempotência, comportamento pré-#4989 preservado).
 *   - Só o 2x1 presente → `derive-1x1-from-2x1`: o 1x1 é sempre um crop
 *     determinístico do 2x1 (ver o resto de `main()`), então ele pode ser
 *     RE-DERIVADO sem chamar o gerador de imagem — zero custo, zero risco
 *     de sobrescrever o 2x1 promovido (nunca é tocado nesse caminho).
 *   - Só o 1x1 presente, ou nenhum presente → `regenerate`: não existe forma
 *     de derivar um 2x1 a partir de um 1x1 (perderia informação), então a
 *     geração nova é genuinamente necessária. Nesse caminho `wideJpgPath`
 *     (o 2x1) está confirmadamente AUSENTE, então o `renameSync` posterior
 *     não sobrescreve nada — o overwrite silencioso só acontecia na lacuna
 *     do estado "só o 2x1 existe", agora coberta pelo branch anterior.
 *   - `--force` sempre força `regenerate` (comportamento explícito do editor,
 *     inalterado).
 */
export function resolveWideImageIntegrity(
  wide2x1Exists: boolean,
  wide1x1Exists: boolean,
  force: boolean,
): WideImageIntegrityAction {
  if (force) return { kind: "regenerate" };
  if (wide2x1Exists && wide1x1Exists) return { kind: "skip" };
  if (wide2x1Exists && !wide1x1Exists) return { kind: "derive-1x1-from-2x1" };
  return { kind: "regenerate" };
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
  // #4093: resolução extraída para resolveRatio() — testável sem gerar imagem.
  const rawRatio = args["ratio"];
  let wide: boolean, portrait45: boolean, master: boolean, sdWidth: number, sdHeight: number;
  try {
    ({ wide, portrait45, master, width: sdWidth, height: sdHeight } = resolveRatio(rawRatio, destaque));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  // Ler prompt editorial
  const editorialText = readFileSync(editorialPath, "utf8");
  const positivePrompt = buildPositivePrompt(editorialText);

  // Montar SD prompt JSON.
  // Wide (2x1): 1600×800, depois crop 1:1 (800×800).
  // Square (1x1): 1024×1024 (forçado explícito pra garantir proporção 1:1).
  const sdPromptRaw: Record<string, unknown> = {
    positive: positivePrompt,
    negative: NEGATIVE_PROMPT,
    final_width: sdWidth,
    final_height: sdHeight,
  };
  // #649: validar shape antes de gravar — fail-loud se positive curto, dims fora do range
  const sdPrompt = parseSdPrompt(sdPromptRaw);

  // Gravar JSON de prompt
  const normalizedOutDir = outDir.endsWith("/") ? outDir : outDir + "/";
  const sdPromptPath = `${normalizedOutDir}04-${destaque}-sd-prompt.json`;
  const outJpgPath = master
    ? `${normalizedOutDir}04-${destaque}-master.jpg`
    : portrait45
    ? `${normalizedOutDir}04-${destaque}-4x5-nativo.jpg`
    : wide
      ? `${normalizedOutDir}04-${destaque}.jpg`  // Wide usa nomes próprios (2x1, 1x1) gerados abaixo
      : `${normalizedOutDir}04-${destaque}-1x1.jpg`;
  const filenamePrefix = `diaria_${destaque}_`;

  // Idempotence (#4989): pular se imagem final já existe (re-run sem intenção
  // de regenerar) — NUNCA regenerar/sobrescrever um arquivo já presente e
  // correto. Logging explícito de "esperado X, encontrado: sim/não" ANTES de
  // qualquer decisão, pra tornar auditável (nos logs) o que o script viu no
  // disco no momento da checagem — sem isso, um overwrite silencioso (como o
  // bug real do #4989) não deixa nenhum rastro.
  const widePath2x1 = `${normalizedOutDir}04-${destaque}-2x1.jpg`;
  const widePath1x1 = `${normalizedOutDir}04-${destaque}-1x1.jpg`;
  const cropScript = resolve(ROOT, "scripts", "crop-resize.ts");

  function cropToSquare(sourcePath: string, destPath: string): void {
    execFileSync(
      process.execPath,
      ["--import", "tsx", cropScript, sourcePath, destPath, "--width", "800", "--height", "800"],
      { stdio: "inherit", cwd: ROOT },
    );
  }

  if (wide) {
    const wide2x1Exists = existsSync(widePath2x1);
    const wide1x1Exists = existsSync(widePath1x1);
    console.error(
      `image-generate: verificando integridade — ${widePath2x1}: ${wide2x1Exists ? "encontrado" : "ausente"}`,
    );
    console.error(
      `image-generate: verificando integridade — ${widePath1x1}: ${wide1x1Exists ? "encontrado" : "ausente"}`,
    );

    const action = resolveWideImageIntegrity(wide2x1Exists, wide1x1Exists, force);

    if (action.kind === "skip") {
      console.error(`Imagem ${widePath2x1} já existe — use --force pra regenerar.`);
      process.stdout.write(widePath2x1 + "\n");
      process.stdout.write(widePath1x1 + "\n");
      process.exit(0);
    }

    if (action.kind === "derive-1x1-from-2x1") {
      console.error(
        `image-generate: ${widePath2x1} já existe mas ${widePath1x1} está ausente — ` +
          `derivando via crop a partir do 2x1 existente, SEM chamar o gerador de imagem ` +
          `(#4989 — nunca sobrescrever um arquivo já promovido/presente).`,
      );
      try {
        cropToSquare(widePath2x1, widePath1x1);
      } catch (e: unknown) {
        const code = (e as { status?: number }).status ?? 1;
        console.error(`crop-resize falhou com código ${code}`);
        process.exit(code);
      }
      console.error(`${destaque} square derivado: ${widePath1x1} (800×800)`);
      process.stdout.write(widePath2x1 + "\n");
      process.stdout.write(widePath1x1 + "\n");
      process.exit(0);
    }
    // action.kind === "regenerate": widePath2x1 está confirmadamente ausente
    // neste ponto (ou --force pedido explicitamente) — segue pro fluxo normal
    // abaixo, sem risco de sobrescrever um 2x1 promovido em silêncio.
  } else {
    const outExists = existsSync(outJpgPath);
    console.error(
      `image-generate: verificando integridade — ${outJpgPath}: ${outExists ? "encontrado" : "ausente"}`,
    );
    if (outExists && !force) {
      console.error(`Imagem ${outJpgPath} já existe — use --force pra regenerar.`);
      process.stdout.write(outJpgPath + "\n");
      process.exit(0);
    }
  }

  writeFileSync(sdPromptPath, JSON.stringify(sdPrompt, null, 2), "utf8");
  console.error(`Prompt gravado em ${sdPromptPath}`);
  console.error(`Positive: ${positivePrompt.slice(0, 120)}...`);

  // Escolher backend de geração com base em platform.config.json > image_generator.
  // Suporta "gemini" (padrão), "cloudflare" (Workers AI free tier), "comfyui" e "openai".
  // #4625 item 4: valida via parsePlatformConfig (schema Zod) em vez de um
  // cast cru — mesmo fix aplicado em scripts/eia-compose.ts.
  const platformCfg = parsePlatformConfig(
    JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")),
  );
  const generator = platformCfg.image_generator;
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
    const wideJpgPath = widePath2x1;
    const squareJpgPath = widePath1x1;

    // #4989: essa rename SÓ é alcançada quando resolveWideImageIntegrity()
    // decidiu "regenerate" — ou seja, widePath2x1 estava confirmadamente
    // ausente (ou --force pedido explicitamente). Log explícito aqui deixa
    // rastreável, em qualquer investigação futura, que o script SABIA se ia
    // sobrescrever um arquivo pré-existente ou não — nunca mais um overwrite
    // silencioso sem nenhuma linha no log apontando pra ele.
    const willOverwrite = existsSync(wideJpgPath);
    console.error(
      `image-generate: gravando ${wideJpgPath} — ${willOverwrite ? "SOBRESCREVENDO arquivo existente (--force)" : "arquivo novo"}.`,
    );

    // Renomear o output original (1600×800) para -2x1
    renameSync(outJpgPath, wideJpgPath);
    console.error(`${destaque} wide: ${wideJpgPath} (1600×800)`);

    // Crop centro para 1:1 (800×800).
    try {
      cropToSquare(wideJpgPath, squareJpgPath);
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
