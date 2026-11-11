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
 * Saída (default): d1/d2/d3 → 04-d{N}-2x1.jpg (1600×800). Imprime o caminho
 *        do JPG em stdout.
 *
 * #12226 (decisão do editor, 05/11/2026): o crop 1:1 derivado do 2:1
 * (`04-d{N}-1x1.jpg`, 800×800) deixou de ser gerado. A newsletter usa o 2:1 e
 * o social usa o card 4:5 + carrossel; nenhuma chave `d{N}_1x1` sobe pro
 * `06-public-images.json`. O Google Ads (SQUARE_MARKETING_IMAGE) recebe o
 * 1:1 recortado à mão. Edições antigas com o 1x1 em disco não são tocadas.
 *
 * `--ratio 2x1|1x1|4x5|master` (#1916): força o formato pra qualquer destaque. A
 * mensal usa `--ratio 2x1` em d1/d2/d3 (todos 2x1). `--ratio 1x1` segue como
 * override MANUAL (square nativo 1024×1024), fora do pipeline diário.
 *
 * #5136: todo JPEG publicado (2x1, e o nativo do branch não-wide) passa por
 * `scripts/compress-jpeg.ts` — JPEG progressivo +
 * mozjpeg @ qualidade 82 — antes de virar o arquivo final. Antes o output cru
 * do gerador (Gemini/ComfyUI) era publicado sem re-encode (renameSync puro),
 * ~1 MB por edição / 45% do peso de fio da página eia/poll.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { CODEX_FALLBACK_SCRIPTS } from "./lib/image-backends.ts"; // #9110 item 5
import { writeImageGeneratorSidecar } from "./lib/shared/image-generator-sidecar.ts"; // #9095
import { logEvent } from "./lib/run-log.ts"; // #9095
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
// #12309: o crop 1:1 saiu do pipeline no #12226; a frase passou a citar o card
// 4:5, que é o recorte que existe hoje (a metade central cabe nos 67% do 4:5).
// #3633: instrução de safe-area VERTICAL — análoga à horizontal do #2657, mas pro
// eixo vertical. Bug 260717: figura robótica angulosa gerada 3× seguidas com a
// CABEÇA cortada no topo do frame 1600×800 (2:1) — e por consequência no crop
// 800×800 (1:1) derivado. O modelo tende a desenhar a figura grande/próxima
// demais verticalmente quando a cena tem um personagem antropomórfico/robótico
// em pé. Fix editorial pontual aplicado no gate (wide shot + headroom explícito)
// promovido pra regra global aqui, pra não precisar de ajuste manual por edição.
// #12422: o sufixo passou a ser POR FORMATO. O texto antigo dizia que uma arte
// única era recortada em 2:1, 4:5 e 9:16, fluxo que não existe mais: o Stage 3
// gera o 2:1 e o 4:5 nativo em chamadas separadas (`stage-3-run.ts`, `--ratio
// 4x5`) e o 9:16 não é gerado. Estilo, superfícies calmas, headroom, faixa do
// título e anti-texto ficam compartilhados; só o trecho de composição muda.
// #12799: o sufixo nunca leva resolução em pixels (regra invariável de
// `context/editorial-rules.md`): número no prompt puxa o modelo a desenhar
// dígitos na arte. A proporção basta; a resolução sai dos parâmetros da chamada.
// Exportados para teste de regressão em test/image-generate-safe-area.test.ts.
const STYLE_SUFFIX_HEAD =
  ", post-impressionist oil painting with thick impasto brushstrokes, directional rhythmic brushwork, bold complementary colors in the style of Vincent van Gogh, painterly, high contrast. " +
  // #10312: "swirling textures" (o termo anterior) era convite direto ao motivo
  // de Noite Estrelada — edição 261016 D2 saiu com redemoinho concêntrico
  // azul/amarelo na TELA de um celular. Reforço em fraseado AFIRMATIVO (#1241,
  // #4201: nomear a obra ou o motivo, mesmo negando, ancora o modelo nele):
  // telas, céus e superfícies lisas viram campos calmos de cor, pincelada reta.
  "Screens, displays, skies, walls and other flat or smooth surfaces are painted as calm, even fields of color built from straight, parallel brushstrokes that follow the shape of the surface. ";

// Trecho de composição de cada formato. O 2:1 é o hero do e-mail e também o
// último fallback do card 4:5 (`gen-social-card-4x5.ts` reenquadra o 2:1 quando
// faltam o nativo e o master), por isso mantém a metade central (#2657, #12309).
const STYLE_SUFFIX_FORMAT: Record<ImageRatio, string> = {
  "2x1":
    "This artwork is a wide 2:1 landscape image. " +
    "All principal subjects must be grouped together in the central half of the horizontal frame so that all of them remain fully visible if the image is reframed as the portrait 4:5 feed card; do not place key subjects near the left or right edges. " +
    "Every essential element must sit well inside the frame and never touch any edge. ",
  "4x5":
    "This artwork is a portrait 4:5 image composed for the vertical frame at its final proportion. " +
    "Group all principal subjects together near the horizontal center of the frame, each one fully visible with clear margin on every side; do not place key subjects near the left or right edges. " +
    "Every essential element must sit well inside the frame and never touch any edge. ",
  "1x1":
    "This artwork is a 1:1 image. " +
    "Group all principal subjects together in the center of the frame, each one fully visible; do not place key subjects near the left or right edges. " +
    "Every essential element must sit well inside the frame and never touch any edge. ",
  master:
    "This artwork is a 6:5 image. " +
    "All principal subjects must be grouped together in the central half of the horizontal frame so that all of them remain fully visible if the image is reframed as the portrait 4:5 feed card; do not place key subjects near the left or right edges. " +
    "Every essential element must sit well inside the frame and never touch any edge. ",
};

const STYLE_SUFFIX_TAIL =
  "When the scene includes a standing or upright figure (human, robot, or humanoid character), frame it as a wide shot: the entire figure, including the head and feet, must fit comfortably within the frame with generous empty margin above the head; never crop or cut off the top of the head. " +
  "Reserve the bottom fifth of the frame as a calm, low-detail area (ground, shadow, plain surface or penumbra) with no faces, hands or key objects, because a headline will later be placed over it; keep that band darker and simpler than the rest of the scene. " +
  "Purely visual scene with absolutely no written characters, no letters, no digits, no symbols on any surface; " +
  "all signage, papers, screens, books and labels rendered as abstract shapes or solid color blocks without any text or numbers.";

/** Sufixo de estilo do formato pedido (#12422). */
export function styleSuffixFor(ratio: ImageRatio): string {
  return STYLE_SUFFIX_HEAD + STYLE_SUFFIX_FORMAT[ratio] + STYLE_SUFFIX_TAIL;
}

/** Sufixo do formato padrão dos destaques (2:1), mantido para os guards existentes. */
export const STYLE_SUFFIX = styleSuffixFor("2x1");

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
  | { kind: "regenerate" };

/**
 * resolveWideImageIntegrity (#4989, simplificado no #12226)
 *
 * Extraído de `main()` (mesmo padrão de `resolveRatio`, #4093) pra ser
 * testável sem tocar disco nem chamar o gerador de imagem real.
 *
 * Caso real (#4989, edição 260811): o editor promove D3 → D1 movendo
 * `04-d3-*.jpg` → `04-d1-*.jpg` no filesystem, FORA do pipeline. O check de
 * idempotência antigo exigia o PAR 2x1+1x1; com só o 2x1 presente ele caía na
 * geração nova, cujo `compressJpeg(out, 2x1)` sobrescrevia em silêncio o 2x1
 * recém-promovido. O fix do #4989 derivava o 1x1 do 2x1 nesse estado.
 *
 * Desde o #12226 o 1x1 não é mais gerado: a idempotência olha só o 2x1.
 *   - 2x1 presente → `skip` (nunca sobrescreve um 2x1 promovido/presente; um
 *     1x1 órfão no disco, de edição antiga, é ignorado).
 *   - 2x1 ausente → `regenerate`: o `compressJpeg` posterior grava um arquivo
 *     novo, sem sobrescrever nada.
 *   - `--force` sempre força `regenerate` (comportamento explícito do editor).
 */
export function resolveWideImageIntegrity(
  wide2x1Exists: boolean,
  force: boolean,
): WideImageIntegrityAction {
  if (force) return { kind: "regenerate" };
  if (wide2x1Exists) return { kind: "skip" };
  return { kind: "regenerate" };
}

/**
 * Paths dos formatos DERIVADOS (4:5 nativo composto à parte, e o master 6:5)
 * que ficam potencialmente STALE sempre que o 2x1 wide é de fato
 * REEGERADO (#6010 — achado ao vivo edição 260824).
 *
 * Causa raiz do #6010: `gen-social-card-4x5.ts`'s `generateCard()` prioriza
 * `04-{d}-4x5-nativo.jpg` sobre `04-{d}-2x1.jpg` na cadeia de fallback (ver
 * docstring de `generateCard`). Quando um destaque é TROCADO no meio do
 * Stage 4 (artigo A → artigo B, mesma posição D{N}), a cascata de título
 * regenera corretamente o 2x1 — mas nunca tocava o nativo/master
 * antigos, que sobreviviam no disco apontando pra arte do artigo ANTIGO.
 * Como o nativo tem prioridade 1 na cadeia, o card social 4:5 continuava
 * mostrando a arte errada indefinidamente, mesmo após múltiplas
 * regenerações "corretas" dos formatos base.
 *
 * Fix (opção 2 da issue — mais simples e à prova de esquecimento, não
 * depende de mais um invariant WARNING que pode ser ignorado): sempre que o
 * 2x1 é efetivamente regenerado (action.kind === "regenerate" — nunca em
 * "skip", onde o 2x1 existente NÃO muda), apagar
 * nativo/master existentes. `gen-social-card-4x5.ts` cai pro fallback 2:1
 * (correto, ainda que subótimo) até alguém rodar
 * `image-generate.ts --ratio 4x5 --force` de novo pra recompor a arte
 * nativa a partir do conteúdo atual.
 */
export function staleDerivedImagePaths(outDir: string, destaque: string): string[] {
  const normalizedOutDir = outDir.endsWith("/") ? outDir : outDir + "/";
  return [
    `${normalizedOutDir}04-${destaque}-4x5-nativo.jpg`,
    `${normalizedOutDir}04-${destaque}-master.jpg`,
  ];
}

/**
 * Decide QUAIS paths derivados purgar dado o resultado de
 * `resolveWideImageIntegrity` — pura, sem tocar disco (mesmo padrão de
 * `resolveWideImageIntegrity`/`resolveRatio`, testável sem I/O). Só
 * "regenerate" invalida os derivados: em "skip" o
 * conteúdo do 2x1 permanece o mesmo de antes (não regenerado), então
 * nativo/master baseados nele continuam válidos.
 */
export function computeStaleDerivedImages(
  action: WideImageIntegrityAction,
  outDir: string,
  destaque: string,
): string[] {
  if (action.kind !== "regenerate") return [];
  return staleDerivedImagePaths(outDir, destaque);
}

/** #9095: AAMMDD da edição a partir do `--out-dir` (`data/editions/260930/`,
 * ou layout aninhado `.../2609/260930/`); `null` fora do layout diário
 * (mensal, ad-hoc) — `logEvent` aceita edição nula. */
export function editionFromOutDir(outDir: string): string | null {
  const last = outDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return /^\d{6}$/.test(last) ? last : null;
}

/** Cena do prompt editorial + sufixo do formato pedido (#12422). */
export function buildPositivePrompt(editorialText: string, ratio: ImageRatio): string {
  // Remove markdown formatting (headings, bold, links) and get clean scene description
  const scene = editorialText
    .replace(/^#+\s*/gm, "")           // remove headings
    .replace(/\*\*([^*]+)\*\*/g, "$1") // remove bold
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // remove links
    .replace(/\n+/g, " ")
    .trim();
  return scene + styleSuffixFor(ratio);
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
      "Uso: image-generate.ts --editorial <prompt.md> --out-dir <dir/> --destaque <d1|d2|d3> [--ratio 2x1|1x1|4x5|master] [--force]"
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
  let ratio: ImageRatio, wide: boolean, portrait45: boolean, master: boolean, sdWidth: number, sdHeight: number;
  try {
    ({ ratio, wide, portrait45, master, width: sdWidth, height: sdHeight } = resolveRatio(rawRatio, destaque));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  // Ler prompt editorial
  const editorialText = readFileSync(editorialPath, "utf8");
  const positivePrompt = buildPositivePrompt(editorialText, ratio);

  // Montar SD prompt JSON.
  // Wide (2x1): 1600×800 (sem crop 1:1 derivado desde o #12226).
  // Square (--ratio 1x1, override manual): 1024×1024.
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
      ? `${normalizedOutDir}04-${destaque}.jpg`  // Wide grava o -2x1 abaixo (temporário cru do gerador)
      : `${normalizedOutDir}04-${destaque}-1x1.jpg`;
  const filenamePrefix = `diaria_${destaque}_`;

  // Idempotence (#4989): pular se imagem final já existe (re-run sem intenção
  // de regenerar) — NUNCA regenerar/sobrescrever um arquivo já presente e
  // correto. Logging explícito de "esperado X, encontrado: sim/não" ANTES de
  // qualquer decisão, pra tornar auditável (nos logs) o que o script viu no
  // disco no momento da checagem — sem isso, um overwrite silencioso (como o
  // bug real do #4989) não deixa nenhum rastro.
  const widePath2x1 = `${normalizedOutDir}04-${destaque}-2x1.jpg`;
  const compressScript = resolve(ROOT, "scripts", "compress-jpeg.ts");

  // #5136: perfil de compressão das imagens PUBLICADAS (destaques d1/d2/d3) —
  // JPEG progressivo + mozjpeg @ qualidade 82, reduz os ~1 MB crus do gerador
  // pra faixa de 250-350 KB sem perda visível (medição no PR). Flags únicas
  // aqui — outros chamadores de crop-resize.ts (benchmark.ts,
  // weekly-instagram-ondemand-card.ts) continuam no default (quality 90, sem
  // mozjpeg/progressive) porque não passam essas flags.
  const compressArgs = ["--quality", "82", "--mozjpeg", "--progressive"];

  // #5136: reencoda um JPEG já nas dimensões finais (sem redimensionar) —
  // usado tanto pro 2x1 wide (em vez do renameSync cru) quanto pro nativo
  // do branch não-wide. sourcePath/destPath podem ser o mesmo path
  // (reencode in-place); compress-jpeg.ts lê o arquivo inteiro antes de
  // escrever de volta, então overwrite in-place é seguro.
  function compressJpeg(sourcePath: string, destPath: string): void {
    execFileSync(
      process.execPath,
      ["--import", "tsx", compressScript, sourcePath, destPath, ...compressArgs],
      { stdio: "inherit", cwd: ROOT },
    );
  }

  if (wide) {
    const wide2x1Exists = existsSync(widePath2x1);
    console.error(
      `image-generate: verificando integridade — ${widePath2x1}: ${wide2x1Exists ? "encontrado" : "ausente"}`,
    );

    const action = resolveWideImageIntegrity(wide2x1Exists, force);

    if (action.kind === "skip") {
      console.error(`Imagem ${widePath2x1} já existe — use --force pra regenerar.`);
      process.stdout.write(widePath2x1 + "\n");
      process.exit(0);
    }
    // action.kind === "regenerate": widePath2x1 está confirmadamente ausente
    // neste ponto (ou --force pedido explicitamente) — segue pro fluxo normal
    // abaixo, sem risco de sobrescrever um 2x1 promovido em silêncio.

    // #6010: o 2x1 vai ser (re)gerado a partir do prompt ATUAL — qualquer
    // 4x5-nativo/master pré-existente foi derivado de um 2x1 anterior
    // (possivelmente de um artigo TROCADO) e fica STALE. Apagar agora, antes
    // da geração, pra `gen-social-card-4x5.ts` nunca escolher a arte errada
    // pela cadeia de prioridade (nativo > master > 2x1).
    for (const staleP of computeStaleDerivedImages(action, normalizedOutDir, destaque)) {
      if (existsSync(staleP)) {
        console.error(
          `image-generate: apagando ${staleP} — formato derivado STALE (base 2x1 sendo regenerada, #6010).`,
        );
        unlinkSync(staleP);
      }
    }
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
  // Suporta "codex" (padrão desde #9088, com `codex.fallback`), "gemini",
  // "cloudflare" (Workers AI free tier), "comfyui" e "openai".
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
    generator === "codex"       ? "codex-image.js" :
    "gemini-image.js";
  const imageScript = resolve(ROOT, "scripts", scriptName);
  // #9095: backend que DE FATO gerou a imagem (muda se o fallback assumir).
  let effectiveGenerator: string = generator;

  try {
    execFileSync(
      process.execPath, // node
      [imageScript, sdPromptPath, outJpgPath, filenamePrefix],
      { stdio: "inherit", cwd: ROOT }
    );
  } catch (e: unknown) {
    const code = (e as { status?: number }).status ?? 1;
    console.error(`${scriptName} falhou com código ${code}`);
    // #9088: fallback opcional do Codex (login expirado, timeout) pra edição não travar.
    const fb = generator === "codex" ? platformCfg.codex?.fallback : undefined;
    if (!fb) process.exit(code);
    const fbScript = CODEX_FALLBACK_SCRIPTS[fb];
    console.error(`image-generate: codex falhou — fallback configurado: ${fb} (${fbScript}).`);
    // #9095: fallback visível no run-log (antes só no stderr).
    logEvent({
      edition: editionFromOutDir(normalizedOutDir),
      stage: 3,
      agent: "image-generate",
      level: "warn",
      message: `codex falhou (exit ${code}) para ${destaque} — fallback para ${fb}`,
      details: { destaque, fallback: fb },
    }, ROOT);
    effectiveGenerator = fb;
    try {
      execFileSync(process.execPath, [resolve(ROOT, "scripts", fbScript), sdPromptPath, outJpgPath, filenamePrefix], { stdio: "inherit", cwd: ROOT });
    } catch (e2: unknown) {
      const code2 = (e2 as { status?: number }).status ?? 1;
      console.error(`${fbScript} (fallback) falhou com código ${code2}`);
      process.exit(code2);
    }
  }

  // Wide: salvar 1600×800 como 04-d{N}-2x1.jpg (sem crop 1:1 desde o #12226)
  if (wide) {
    // #9095: o hero 2x1 é a imagem que carrega legenda na newsletter — grava
    // o backend efetivo pra legenda não nomear o gerador configurado quando
    // o fallback é quem gerou.
    writeImageGeneratorSidecar(normalizedOutDir, destaque, {
      generator: effectiveGenerator,
      configured: generator,
      fallback: effectiveGenerator !== generator,
    });
    const wideJpgPath = widePath2x1;

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

    // #5136: era um renameSync cru (JPEG do gerador publicado sem re-encode,
    // ~1 MB). Agora comprime o output original (1600×800) pro perfil #5136
    // ao gravá-lo como -2x1, e apaga o original sem compressão.
    try {
      compressJpeg(outJpgPath, wideJpgPath);
    } catch (e: unknown) {
      const code = (e as { status?: number }).status ?? 1;
      console.error(`compress-jpeg falhou com código ${code}`);
      process.exit(code);
    }
    unlinkSync(outJpgPath);
    console.error(`${destaque} wide: ${wideJpgPath} (1600×800, comprimido #5136)`);

    process.stdout.write(wideJpgPath + "\n");
  } else {
    // #5136: branch não-wide (--ratio 1x1/4x5/master, uso manual/mensal) —
    // mesmo perfil de compressão in-place, pra nenhuma imagem publicada
    // escapar do re-encode.
    try {
      compressJpeg(outJpgPath, outJpgPath);
    } catch (e: unknown) {
      const code = (e as { status?: number }).status ?? 1;
      console.error(`compress-jpeg falhou com código ${code}`);
      process.exit(code);
    }
    process.stdout.write(outJpgPath + "\n");
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
