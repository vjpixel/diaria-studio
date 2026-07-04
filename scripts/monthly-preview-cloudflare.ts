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
import { draftToEmail, eiaEditionFromYymm, parseEiaLegend, captionForGenerator } from "./lib/mensal/monthly-render.ts"; // #2018-fix: captionForGenerator centralizado
import { uploadDestaqueImages, uploadEiaImages, uploadLivrosImage } from "./lib/mensal/monthly-image-upload.ts";
import { fetchMonthlyEiaPrevResultLine } from "./lib/mensal/monthly-eia-prev-result.ts"; // #2948
import { uploadHtml } from "./upload-html-public.ts";
import {
  parseMonthlyCycleArg,
  cycleToYymm,
  monthlyDir as resolveMonthlyDir,
  monthlyWorkerKey,
  monthlyWorkerKeyLegacy,
  isValidMonthlyCycle,
  isValidYymm,
} from "./lib/mensal/monthly-paths.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pure (#1914, #1962, #2046): key da URL do preview mensal.
 *
 * Formato novo: `m{YYMM}-{MM}` (ex: `m2605-06`) — identifica unicamente o
 * ciclo de conteúdo + envio, não colide com diárias (AAMMDD sem prefixo m).
 * Retrocompat de leitura: o Worker implementa fallback novo→legado (#2046):
 *   GET /m2605-06 → tenta key nova; se null, tenta key legada m2605.
 * Sentido único — legado→novo NÃO é tentado (links antigos continuam
 * funcionando; o Worker não incentiva uso da URL velha).
 *
 * Hífens são válidos em keys KV do Cloudflare (qualquer string ≤512 bytes).
 *
 * @param cycle ciclo `{YYMM}-{MM}` (ex: `2605-06`) OU legado `YYMM` (ex: `2605`,
 *              compat — retorna o formato legado `m{YYMM}` com aviso implícito
 *              de que a key nova exige o ciclo completo).
 */
export function monthlyPreviewKey(cycle: string): string {
  // Delegamos para os helpers centralizados em monthly-paths.ts (#1962)
  // para manter a lógica em um único lugar.
  if (isValidMonthlyCycle(cycle)) return monthlyWorkerKey(cycle);
  if (isValidYymm(cycle)) {
    // Compat: yymm legado → key legada m{YYMM} (não deriva — evita silently
    // emitir key nova pra código que ainda não migrou o path de disco).
    return monthlyWorkerKeyLegacy(cycle);
  }
  throw new Error(`ciclo inválido para previewKey: "${cycle}"`);
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

  // Persiste o HTML local (artefato + input do uploadHtml, que lê de arquivo).
  const internalDir = resolve(monthlyDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const htmlPath = resolve(internalDir, "cloudflare-preview.html");
  writeFileSync(htmlPath, html);

  // Key nova: m{YYMM}-{MM} (ex: m2605-06). Retrocompat de leitura implementada
  // no Worker (#2046): GET /m2605-06 → tenta key nova; fallback m{YYMM} se null.
  const result = await uploadHtml({
    edition: monthlyPreviewKey(cycle),
    htmlPath,
    secret,
    dryRun,
    wrap: false, // HTML mensal já é documento completo
  });

  console.log(JSON.stringify({ yymm, cycle, ...result }, null, 2));
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
