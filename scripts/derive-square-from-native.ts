/**
 * derive-square-from-native.ts (#11672)
 *
 * Aplica a sugestão "usar o 4:5 nativo" do revisor de crop: gera o 1:1 de um
 * destaque a partir de `04-{dN}-4x5-nativo.jpg` em vez do hero 2:1. O corte é
 * vertical e mantém a largura inteira do nativo (o crop central do 2:1 corta as
 * laterais, que é o que o revisor costuma acusar).
 *
 * O que faz, nesta ordem:
 *   1. Recorta o nativo em quadrado (800×800, mesmo perfil JPEG do
 *      `image-generate.ts`) e grava em `04-{dN}-1x1.jpg`.
 *   2. Registra a fonte em `_internal/04-square-source.json` (chaveada pelo
 *      md5 do 1:1 gravado), para o revisor comparar o quadrado com o nativo e
 *      não com o 2:1.
 *   3. Remove a chave `d{N}` (1:1) de `06-public-images.json`, se existir.
 *      O hero 2:1, o card 4:5 e o carrossel não mudam e ficam.
 *   4. Imprime os pares para reabrir o revisor de crop só para esse destaque
 *      (`run-image-crop-reviewer.ts --only dN:1x1`). O revisor é um subagente:
 *      quem o despacha é o orchestrator, com os `pairs` impressos aqui, e depois
 *      persiste com o `persist_command`, que troca só a entrada `dN:1x1` do
 *      veredito.
 *
 * Uso:
 *   npx tsx scripts/derive-square-from-native.ts --edition-dir data/editions/AAMMDD/ --destaque d3 \
 *     [--position centre|top|bottom] [--dry-run]
 *
 * Exit codes: 0 sucesso; 1 erro de argumento, nativo ausente ou falha de escrita.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { md5OfFile } from "./lib/shared/file-md5.ts";
import { writeSquareSourceEntry } from "./lib/square-source-marker.ts";
import { planPublicImageKeysInvalidation, squarePublicImageKey } from "./lib/public-images-invalidate.ts";
import { discoverCropPairs, filterPairsByTargets, type DestaqueId } from "./run-image-crop-reviewer.ts";

export const SQUARE_SIZE = 800;
export type SquarePosition = "centre" | "top" | "bottom";

export function parseDestaque(raw: string | undefined): DestaqueId {
  const d = (raw ?? "").trim().toLowerCase();
  if (d !== "d1" && d !== "d2" && d !== "d3") {
    throw new Error(`--destaque deve ser d1, d2 ou d3. Recebido: ${raw ?? "(vazio)"}`);
  }
  return d;
}

export function parsePosition(raw: string | undefined): SquarePosition {
  if (raw === undefined) return "centre";
  const p = raw.trim().toLowerCase();
  if (p === "centre" || p === "center") return "centre";
  if (p === "top" || p === "bottom") return p;
  throw new Error(`--position deve ser centre, top ou bottom. Recebido: ${raw}`);
}

/**
 * Recorta `input` em quadrado de `SQUARE_SIZE`. Num retrato (4:5) o `cover`
 * mantém a largura inteira e corta só em cima/embaixo, conforme `position`.
 */
export async function squareFromNative(input: Buffer, position: SquarePosition = "centre"): Promise<Buffer> {
  return sharp(input)
    .resize(SQUARE_SIZE, SQUARE_SIZE, { fit: "cover", position })
    .jpeg({ quality: 82, mozjpeg: true, progressive: true })
    .toBuffer();
}

export interface DeriveSquareResult {
  destaque: DestaqueId;
  source: string;
  out: string;
  dry_run: boolean;
  removed_public_keys: string[];
  public_images_error?: string;
  review: {
    pairs: ReturnType<typeof discoverCropPairs>;
    discovery_command: string;
    persist_command: string;
  };
}

export async function deriveSquareFromNative(opts: {
  editionDir: string;
  editionArg?: string;
  destaque: DestaqueId;
  position?: SquarePosition;
  dryRun?: boolean;
}): Promise<DeriveSquareResult> {
  const { editionDir, destaque } = opts;
  const sourceName = `04-${destaque}-4x5-nativo.jpg`;
  const sourcePath = join(editionDir, sourceName);
  const outPath = join(editionDir, `04-${destaque}-1x1.jpg`);
  if (!existsSync(sourcePath)) {
    throw new Error(
      `${sourceName} não existe em ${editionDir} — sem arte 4:5 nativa não há de onde derivar o quadrado ` +
        `(gerar com image-generate.ts --ratio 4x5).`,
    );
  }

  const removed: string[] = [];
  let publicImagesError: string | undefined;
  if (!opts.dryRun) {
    const square = await squareFromNative(readFileSync(sourcePath), opts.position ?? "centre");
    writeFileSync(outPath, square);
    writeSquareSourceEntry(editionDir, destaque, {
      source: sourceName,
      image_md5: md5OfFile(outPath),
      derived_at: new Date().toISOString(),
    });
    const plan = planPublicImageKeysInvalidation(editionDir, [squarePublicImageKey(Number(destaque.slice(1)))]);
    if (plan.error) publicImagesError = plan.error;
    if (plan.content !== undefined) {
      writeFileSync(plan.path, plan.content, "utf8");
      removed.push(...plan.removedKeys);
    }
  }

  const editionArg = (opts.editionArg ?? editionDir).replace(/[/\\]+$/, "");
  const only = `${destaque}:1x1`;
  return {
    destaque,
    source: sourcePath,
    out: outPath,
    dry_run: !!opts.dryRun,
    removed_public_keys: removed,
    ...(publicImagesError ? { public_images_error: publicImagesError } : {}),
    review: {
      pairs: filterPairsByTargets(discoverCropPairs(editionDir), [{ destaque, ratio: "1x1" }]),
      discovery_command: `npx tsx scripts/run-image-crop-reviewer.ts --edition-dir ${editionArg}/ --only ${only}`,
      persist_command:
        `npx tsx scripts/run-image-crop-reviewer.ts --edition-dir ${editionArg}/ --only ${only} ` +
        `--input-json <saida-do-image-crop-reviewer.json>`,
    },
  };
}

async function main(): Promise<void> {
  const { values: args, flags } = parseArgs(process.argv.slice(2));
  if (!args["edition-dir"]) {
    console.error(
      "Uso: derive-square-from-native.ts --edition-dir data/editions/AAMMDD/ --destaque dN [--position centre|top|bottom] [--dry-run]",
    );
    process.exit(1);
  }
  let destaque: DestaqueId;
  let position: SquarePosition;
  try {
    destaque = parseDestaque(args.destaque);
    position = parsePosition(args.position);
  } catch (e) {
    console.error(`[derive-square-from-native] ${(e as Error).message}`);
    process.exit(1);
  }
  const result = await deriveSquareFromNative({
    editionDir: resolve(process.cwd(), args["edition-dir"]),
    editionArg: args["edition-dir"],
    destaque,
    position,
    dryRun: flags.has("dry-run"),
  });
  if (result.public_images_error) {
    console.error(
      `[derive-square-from-native] 06-public-images.json ilegível, chave ${destaque} não removida: ${result.public_images_error}`,
    );
  }
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[derive-square-from-native] ERRO:", (e as Error).message ?? e);
    process.exit(1);
  });
}
