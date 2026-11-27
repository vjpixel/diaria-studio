/**
 * upload-images-public.ts
 *
 * Faz upload das imagens da edição (destaques, capa, É IA?, slides) pro
 * Cloudflare KV servido pelo Worker (`/img/{key}`), retornando URLs públicas.
 * Único destino desde #11414 — o ramo Google Drive (`uc?id=`) foi removido;
 * o default já era KV para todos os modos desde #2147.
 *
 * Usado pelo Stage 4 (pré-render) e pelo Stage 5 (publishers sociais leem
 * `06-public-images.json` e passam a URL como `image_url`).
 *
 * Uso:
 *   npx tsx scripts/upload-images-public.ts --edition-dir data/editions/260424/
 *
 * Output (stdout JSON):
 *   {
 *     "out_path": "data/editions/260424/06-public-images.json",
 *     "images": {
 *       "d1_4x5": { "file_id": "img-260424-04-d1-4x5-HASH.jpg", "url": "https://eia.diar.ia.br/img/..." },
 *       "d2_4x5": { ... },
 *       "d3_4x5": { ... }
 *     }
 *   }
 *
 * Cache: escreve em `{edition_dir}/06-public-images.json`. Re-execuções
 * reusam file_ids existentes (skip re-upload).
 *
 * Credenciais: CLOUDFLARE_* do .env + `platform.config.json` → poll.kv_namespace_id.
 *
 * #11412 (fatia 1): com `platform.config.json → public_images_r2.enabled`, as
 * imagens content-addressed sobem pro R2 (`img/{AAMMDD}/…`, env `R2_*`) em vez
 * do KV, com a MESMA forma de URL (`/img/img-{AAMMDD}-…`). Flag desligada (o
 * default) = só KV, como antes. Detalhes e ordem de ativação:
 * `scripts/lib/public-images-r2.ts`.
 *
 * #14001: a lógica inteira (tipos, specs, cache, chave KV, decisão R2, a
 * checagem de completude e a orquestração `uploadPublicImages`) mora em
 * `scripts/lib/public-images-upload.ts`, reexportada abaixo. Aqui ficam o
 * `loadProjectEnv()` de topo (#1157) e o `main()`.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv(); // #1157 — carrega .env antes de process.env access (CLOUDFLARE_*)

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDestaqueCount } from "./lib/invariant-checks/stage-3.ts"; // #2352
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts"; // #2834
import {
  assertCacheCompleteness,
  uploadPublicImages,
  type UploadMode,
  type UploadTarget,
} from "./lib/public-images-upload.ts";

export * from "./lib/public-images-upload.ts";

async function main(): Promise<void> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const argv = process.argv.slice(2);
  // #2834: migrado pra lib/cli-args.ts. O parser local tinha 3 flags booleanas
  // INCONDICIONAIS (checadas antes do loop genérico, nunca consomem o próximo
  // token) — via argv.includes. #1275: --no-require-keys opt-out de validação.
  // #1418: --force-reupload ignora cache md5/target e força upload de novo.
  // O restante (--edition-dir, --mode, --target) consumia o PRÓXIMO token
  // INCONDICIONALMENTE (mesmo que comece com "--") — equivalente a
  // parseArgsSimple, não parseArgs. Filtramos os bool flags do argv antes de
  // rodar parseArgsSimple pra eles não serem "engolidos" como valor de um
  // --key anterior (no parser local eles também nunca eram consumidos como
  // valor — o branch booleano rodava primeiro pra esses tokens).
  const BOOL_FLAG_TOKENS = new Set(["--no-cache", "--no-require-keys", "--force-reupload"]);
  const noCache = argv.includes("--no-cache");
  const noRequireKeys = argv.includes("--no-require-keys");
  const forceReupload = argv.includes("--force-reupload");
  const args = parseArgsSimple(argv.filter((a) => !BOOL_FLAG_TOKENS.has(a)));
  const editionDirArg = args["edition-dir"];
  if (typeof editionDirArg !== "string") {
    console.error(
      "Uso: upload-images-public.ts --edition-dir <path> [--mode social|newsletter|all] [--target cloudflare] [--no-cache] [--force-reupload]\n" +
        "\n" +
        "Target: sempre 'cloudflare' (KV). O ramo Drive foi removido no #11414.\n" +
        "--force-reupload: ignora cache md5/target e força re-upload (recovery após bytes locais mudarem).",
    );
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const skipExisting = !noCache;
  const modeArg = args.mode;
  const mode: UploadMode =
    modeArg === "newsletter" || modeArg === "all" || modeArg === "social"
      ? modeArg
      : "social";

  const targetArg = args.target;
  if (targetArg !== undefined && targetArg !== "cloudflare") {
    // #11414: `--target drive` deixou de existir — falhar alto em vez de cair
    // em silêncio no KV, pra quem ainda tem o escape hatch antigo em script/doc.
    console.error(
      `upload-images-public: --target ${String(targetArg)} não é suportado — o único destino é 'cloudflare' (ramo Drive removido no #11414).`,
    );
    process.exit(1);
  }
  const target: UploadTarget | undefined = targetArg === "cloudflare" ? targetArg : undefined;

  const result = await uploadPublicImages({ editionDir, mode, skipExisting, target, forceReupload });
  console.log(JSON.stringify(result, null, 2));

  // #1275: validate cache completeness por default. Opt-out via --no-require-keys
  // pra casos onde caller sabe que cache final é parcial (raro).
  // #2352: pass destaque_count so d3 is not required for 2-destaque editions.
  const requireKeys = !noRequireKeys;
  if (requireKeys) {
    const dc = readDestaqueCount(editionDir);
    try {
      assertCacheCompleteness(result.images, mode, dc);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
