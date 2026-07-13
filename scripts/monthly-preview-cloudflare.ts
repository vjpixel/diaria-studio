/**
 * monthly-preview-cloudflare.ts (#1914, migrado de Cloudflare draft worker
 * para Claude Artifacts em #3214)
 *
 * Renderiza a edição MENSAL no design real de email (mesmo `draftToEmail`
 * usado pelo Brevo) e grava o HTML localmente em `_internal/cloudflare-preview.html`
 * pro editor (e a Clarice) revisar antes de publicar. O nome do arquivo/script
 * ficou por compat — a parte que hospedava o HTML no worker Cloudflare `draft`
 * (`draft.diaria.workers.dev/m{key}`) foi removida em #3214: quem publica o
 * preview agora é o top-level Claude Code, via `Artifact` direto sobre esse
 * arquivo (só o tool top-level pode chamar `Artifact` — este script não tenta).
 * Ver `.claude/skills/diaria-mensal/SKILL.md` §3c/§4b para o fluxo completo.
 *
 * O que ESTE script ainda faz sozinho (produção real, fora do escopo do #3214):
 * - Upload das imagens (É IA? A/B, destaques D1-D3, livros) pro Cloudflare
 *   Worker KV do poll (`poll.diaria.workers.dev`, mesma key `img-{edition}-...`
 *   usada por `publish-monthly.ts`) — essas imagens VÃO pro email real, não são
 *   preview-only, então continuam em Cloudflare (fora do escopo de #3214).
 * - Grava `_internal/public-images.json` (url pública → filename local por
 *   imagem, #3392) — manifest consumido por `scripts/embed-images-base64.ts`
 *   pra gerar a variante `cloudflare-preview-embedded.html` publicada via
 *   `Artifact` (mesmo padrão do diário #3214/#3370: Artifacts rodam sob CSP
 *   estrita que bloqueia `<img src="https://...">` remoto, só `data:` URI —
 *   sem essa variante o preview mensal reproduziria a mesma regressão do
 *   diário, imagem quebrada dentro do Artifact).
 *
 * O que NÃO faz: não toca no Brevo, não pré-registra gabarito, não embute a
 * imagem D1 (essa entra manualmente no Brevo, igual ao fluxo atual). É só o
 * preview visual + upload de imagens de produção.
 *
 * Uso:
 *   npx tsx scripts/monthly-preview-cloudflare.ts --cycle 2605-06
 *   npx tsx scripts/monthly-preview-cloudflare.ts --cycle 2605-06 --dry-run
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_WORKERS_TOKEN — upload das imagens pro KV
 *
 * Output stdout (JSON): { yymm, cycle, html_path, public_images_path }
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { draftToEmail, eiaEditionFromYymm, parseEiaLegend, captionForGenerator } from "./lib/mensal/monthly-render.ts"; // #2018-fix: captionForGenerator centralizado
import { uploadDestaqueImages, uploadEiaImages, uploadLivrosImage, LIVROS_PROMO_FILENAME } from "./lib/mensal/monthly-image-upload.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { fetchMonthlyEiaPrevResultLine } from "./lib/mensal/monthly-eia-prev-result.ts"; // #2948
import {
  parseMonthlyCycleArg,
  cycleToYymm,
  monthlyDir as resolveMonthlyDir,
} from "./lib/mensal/monthly-paths.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface MonthlyPublicImage {
  url: string;
  filename: string;
  mime_type: string;
}

/**
 * Pure (#3392): monta o manifest `{ images: { slot: { url, filename, mime_type } } }`
 * consumido por `scripts/embed-images-base64.ts` — mesmo shape de
 * `06-public-images.json` do diário (sem `file_id`, que o embed não lê).
 * `filename` é sempre relativo à raiz da edição mensal (`monthlyDir`), igual
 * à convenção de `--edition-dir` do embed script.
 */
export function buildPublicImagesManifest(
  eia: { a?: string; b?: string; aFilename?: string; bFilename?: string },
  destaqueImages: Record<number, string>,
  livrosImageUrl: string | undefined,
): Record<string, MonthlyPublicImage> {
  const images: Record<string, MonthlyPublicImage> = {};
  if (eia.a && eia.aFilename) {
    images.eia_a = { url: eia.a, filename: eia.aFilename, mime_type: "image/jpeg" };
  }
  if (eia.b && eia.bFilename) {
    images.eia_b = { url: eia.b, filename: eia.bFilename, mime_type: "image/jpeg" };
  }
  for (const [n, url] of Object.entries(destaqueImages)) {
    images[`d${n}`] = { url, filename: `04-d${n}-2x1.jpg`, mime_type: "image/jpeg" };
  }
  if (livrosImageUrl) {
    images.livros_promo = { url: livrosImageUrl, filename: LIVROS_PROMO_FILENAME, mime_type: "image/jpeg" };
  }
  return images;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");

  // Aceita --cycle 2605-06 (novo) ou --yymm 2605 (legado compat).
  // --yymm é convertido para ciclo via parseMonthlyCycleArg (que trata
  // argumento posicional e --cycle; para --yymm, injetamos como posicional).
  let cycle = parseMonthlyCycleArg(argv);
  if (!cycle) {
    // Fallback: --yymm para compat com callers antigos
    const get = (flag: string): string | undefined => {
      const i = argv.indexOf(flag);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    const yymm = get("--yymm");
    if (yymm) {
      cycle = parseMonthlyCycleArg([yymm]); // trata como posicional legado
    }
  }
  if (!cycle) {
    console.error(
      "Uso: monthly-preview-cloudflare.ts --cycle YYMM-MM [--dry-run]\n" +
      "Compat: monthly-preview-cloudflare.ts --yymm YYMM [--dry-run]",
    );
    process.exit(2);
  }

  const yymm = cycleToYymm(cycle);
  const monthlyDir = resolveMonthlyDir(cycle);
  const draftPath = resolve(monthlyDir, "draft.md");
  if (!existsSync(draftPath)) {
    console.error(`draft.md não encontrado: ${draftPath}. Rode a Etapa 2 do /diaria-mensal primeiro.`);
    process.exit(1);
  }

  const draft = readFileSync(draftPath, "utf8");
  const chosenSubjectPath = resolve(monthlyDir, "_internal", "02-chosen-subject.txt");
  const chosenSubject = existsSync(chosenSubjectPath)
    ? readFileSync(chosenSubjectPath, "utf8").trim()
    : null;

  // Imagens (É IA? + destaques 2x1) → URLs públicas no KV (pulado em dry-run).
  const eiaEdition = eiaEditionFromYymm(yymm);
  let eia: { a?: string; b?: string; aFilename?: string; bFilename?: string } = {};
  let destaqueImages: Record<number, string> = {};
  let livrosImageUrl: string | undefined;
  if (!dryRun) {
    try {
      eia = await uploadEiaImages(monthlyDir, eiaEdition, ROOT);
      if (eia.a) {
        console.error(`Imagens É IA? enviadas:\n  A: ${eia.a}\n  B: ${eia.b}`);
      } else {
        console.error("warn: imagens É IA? não encontradas — preview sem elas");
      }
    } catch (e) {
      console.error(`warn: upload de imagens É IA? falhou — ${(e as Error).message}`);
    }
    try {
      destaqueImages = await uploadDestaqueImages(monthlyDir, eiaEdition, ROOT); // #1916
      const ns = Object.keys(destaqueImages);
      console.error(ns.length ? `Imagens de destaque enviadas: D${ns.join(", D")}` : "warn: sem imagens de destaque (04-d{N}-2x1.jpg)");
    } catch (e) {
      console.error(`warn: upload de imagens de destaque falhou — ${(e as Error).message}`);
    }
    // #editor: imagem do box de curadoria de livros (04-livros-promo.jpg), igual à diária.
    // #2802: upload extraído pra lib/mensal/monthly-image-upload.ts (compartilhado com publish-monthly).
    try {
      livrosImageUrl = await uploadLivrosImage(monthlyDir, eiaEdition, ROOT);
      if (livrosImageUrl) {
        console.error(`Imagem de livros enviada: ${livrosImageUrl}`);
      } else {
        console.error("warn: 04-livros-promo.jpg ausente — box de livros sem imagem");
      }
    } catch (e) {
      console.error(`warn: upload da imagem de livros falhou — ${(e as Error).message}`);
    }
  }

  // Legenda do É IA? vem do 01-eia.md (o draft só tem o placeholder). #1914
  const eiaMdPath = resolve(monthlyDir, "01-eia.md");
  const eiaCredit = existsSync(eiaMdPath)
    ? parseEiaLegend(readFileSync(eiaMdPath, "utf8"))
    : undefined;

  // #2018-fix: legenda via helper centralizado (evita duplicação com publish-monthly).
  const platformConfigPath = resolve(ROOT, "platform.config.json");
  const imageGenerator: string = existsSync(platformConfigPath)
    ? (JSON.parse(readFileSync(platformConfigPath, "utf8")) as { image_generator?: string }).image_generator ?? "gemini"
    : "gemini";
  const destaqueImageCaption = captionForGenerator(imageGenerator);

  // #2948: "% acertaram" do É IA? mensal do ciclo anterior (brand=clarice) —
  // mesmo fetch usado por publish-monthly.ts, mantém preview e email real em
  // paridade. Fail-soft: sem ciclo anterior elegível → null, linha omitida.
  let eiaPrevResultLine: string | null = null;
  if (!dryRun) {
    try {
      eiaPrevResultLine = await fetchMonthlyEiaPrevResultLine(yymm);
    } catch (e) {
      console.error(`warn: fetch de "% acertaram" (edição anterior) falhou — ${(e as Error).message}`);
    }
  }

  // Render no design da MENSAL (mesmo HTML que vai pro Brevo).
  const { html } = draftToEmail(draft, chosenSubject, yymm, eia.a, eia.b, eiaCredit, destaqueImages, destaqueImageCaption, livrosImageUrl, eiaPrevResultLine);

  // Persiste o HTML local — desde #3214, este é o artefato final do script.
  // Quem publica pro editor é o top-level Claude Code via `Artifact` direto
  // sobre este arquivo (ver SKILL.md §3c/§4b) — este script só grava em disco.
  const internalDir = resolve(monthlyDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const htmlPath = resolve(internalDir, "cloudflare-preview.html");
  writeFileSync(htmlPath, html);

  // #3392: manifest url pública → filename local, consumido por
  // `scripts/embed-images-base64.ts` (SKILL.md §3c/§4b) pra gerar a variante
  // `cloudflare-preview-embedded.html` publicada via `Artifact` — sem isso o
  // Artifact bloqueia as imagens remotas por CSP (mesma regressão do diário
  // #3214/#3370). Grava mesmo em dry-run/sem upload (fica `{ images: {} }`,
  // inofensivo — o embed simplesmente não encontra nada pra substituir).
  const publicImages = buildPublicImagesManifest(eia, destaqueImages, livrosImageUrl);
  const publicImagesPath = resolve(internalDir, "public-images.json");
  writeFileSync(publicImagesPath, JSON.stringify({ images: publicImages }, null, 2) + "\n");

  console.log(JSON.stringify({ yymm, cycle, html_path: htmlPath, public_images_path: publicImagesPath, dry_run: dryRun }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[monthly-preview-cloudflare] ${(e as Error).message}`);
    process.exit(1);
  });
}
