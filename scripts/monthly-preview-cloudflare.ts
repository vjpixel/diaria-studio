/**
 * monthly-preview-cloudflare.ts (#1914)
 *
 * Dá à edição MENSAL um preview público no Cloudflare, como a diária já tem
 * (worker `draft` → `draft.diaria.workers.dev/{key}`). O editor (e a Clarice)
 * revisa o render real no celular antes de publicar no Brevo.
 *
 * Diferença vs a diária:
 * - Design é o da MENSAL — `draftToEmail` (monthly-render), documento HTML
 *   completo (não um fragmento). Por isso o upload usa `wrap: false`.
 * - Imagens do É IA? sobem pro KV do poll (mesma key `img-{edition}-...` do
 *   publish-monthly, via lib compartilhada) e entram no HTML como URL pública.
 * - Key da URL é `m{YYMM}` (ex: `m2605`) pra não colidir com as diárias
 *   (AAMMDD, 6 dígitos).
 *
 * O que NÃO faz: não toca no Brevo, não pré-registra gabarito, não embute a
 * imagem D1 (essa entra manualmente no Brevo, igual ao fluxo atual). É só o
 * preview visual.
 *
 * Uso:
 *   npx tsx scripts/monthly-preview-cloudflare.ts --yymm 2605
 *   npx tsx scripts/monthly-preview-cloudflare.ts --yymm 2605 --dry-run
 *
 * Env:
 *   ADMIN_SECRET / POLL_ADMIN_SECRET — HMAC do PUT no worker draft
 *   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_WORKERS_TOKEN — upload das imagens pro KV
 *
 * Output stdout (JSON): { yymm, url, bytes, ttl_seconds }
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { draftToEmail, eiaEditionFromYymm, parseEiaLegend } from "./lib/monthly-render.ts";
import { uploadMonthlyImage, uploadDestaqueImages } from "./lib/monthly-image-upload.ts";
import { uploadHtml } from "./upload-html-public.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Pure (#1914): key da URL do preview mensal — `m{YYMM}`, distinta da diária. */
export function monthlyPreviewKey(yymm: string): string {
  return `m${yymm}`;
}

/**
 * Sobe as 2 imagens do É IA? mensal pro KV e devolve as URLs públicas, tolerando
 * o naming legado `01-eai-*`. Retorna `{}` se não achar o par (seção sem imagem
 * — não-fatal, igual ao publish-monthly).
 */
async function uploadEiaImages(
  monthlyDir: string,
  eiaEdition: string,
): Promise<{ a?: string; b?: string }> {
  const namePairs = [
    ["01-eia-A.jpg", "01-eia-B.jpg"],
    ["01-eai-A.jpg", "01-eai-B.jpg"], // legacy
  ];
  for (const [nameA, nameB] of namePairs) {
    const pathA = resolve(monthlyDir, nameA);
    const pathB = resolve(monthlyDir, nameB);
    if (existsSync(pathA) && existsSync(pathB)) {
      // Uploads independentes → paralelos (#1915 review).
      const [a, b] = await Promise.all([
        uploadMonthlyImage(pathA, eiaEdition, ROOT),
        uploadMonthlyImage(pathB, eiaEdition, ROOT),
      ]);
      return { a, b };
    }
  }
  return {};
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const yymm = get("--yymm");
  const dryRun = argv.includes("--dry-run");

  if (!yymm || !/^\d{4}$/.test(yymm)) {
    console.error("Uso: monthly-preview-cloudflare.ts --yymm YYMM [--dry-run]");
    process.exit(2);
  }

  const monthlyDir = resolve(ROOT, "data", "monthly", yymm);
  const draftPath = resolve(monthlyDir, "draft.md");
  if (!existsSync(draftPath)) {
    console.error(`draft.md não encontrado: ${draftPath}. Rode a Etapa 2 do /diaria-mensal primeiro.`);
    process.exit(1);
  }

  const secret = process.env.ADMIN_SECRET ?? process.env.POLL_ADMIN_SECRET ?? "";
  if (!secret && !dryRun) {
    console.error("[monthly-preview-cloudflare] ADMIN_SECRET ausente no env — abortando");
    process.exit(1);
  }

  const draft = readFileSync(draftPath, "utf8");
  const chosenSubjectPath = resolve(monthlyDir, "_internal", "02-chosen-subject.txt");
  const chosenSubject = existsSync(chosenSubjectPath)
    ? readFileSync(chosenSubjectPath, "utf8").trim()
    : null;

  // Imagens (É IA? + destaques 2x1) → URLs públicas no KV (pulado em dry-run).
  const eiaEdition = eiaEditionFromYymm(yymm);
  let eia: { a?: string; b?: string } = {};
  let destaqueImages: Record<number, string> = {};
  if (!dryRun) {
    try {
      eia = await uploadEiaImages(monthlyDir, eiaEdition);
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
  }

  // Legenda do É IA? vem do 01-eia.md (o draft só tem o placeholder). #1914
  const eiaMdPath = resolve(monthlyDir, "01-eia.md");
  const eiaCredit = existsSync(eiaMdPath)
    ? parseEiaLegend(readFileSync(eiaMdPath, "utf8"))
    : undefined;

  // Render no design da MENSAL (mesmo HTML que vai pro Brevo).
  const { html } = draftToEmail(draft, chosenSubject, yymm, eia.a, eia.b, eiaCredit, destaqueImages);

  // Persiste o HTML local (artefato + input do uploadHtml, que lê de arquivo).
  const internalDir = resolve(monthlyDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const htmlPath = resolve(internalDir, "cloudflare-preview.html");
  writeFileSync(htmlPath, html);

  const result = await uploadHtml({
    edition: monthlyPreviewKey(yymm),
    htmlPath,
    secret,
    dryRun,
    wrap: false, // HTML mensal já é documento completo
  });

  console.log(JSON.stringify({ yymm, ...result }, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[monthly-preview-cloudflare] ${(e as Error).message}`);
    process.exit(1);
  });
}
