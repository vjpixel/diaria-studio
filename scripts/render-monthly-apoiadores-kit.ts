#!/usr/bin/env node
/**
 * scripts/render-monthly-apoiadores-kit.ts (#7633)
 *
 * Renderiza a variante KIT do envio extra pra apoiadores Mantenedor/Patrono —
 * sucessor de `scripts/render-monthly-apoiadores-brevo.ts` (#4593), que por
 * sua vez sucedeu o render Beehiiv (#4482, removido em #7121). Reusa o MESMO
 * `draft.md` e as MESMAS imagens já publicadas pro envio Clarice: não faz
 * upload novo, lê os URLs de `_internal/public-images.json`.
 *
 * ## O que é importado do render Brevo, e por quê
 *
 * `readPublicImages`/`EXPECTED_IMAGE_KEYS`/`missingImageKeys` são
 * canal-agnósticas (leem o manifest de imagens do ciclo, que é o mesmo pros
 * três canais) e já viveram em 2 arquivos diferentes conforme o canal mudava
 * — mover de novo só trocaria o nome do import por outro igualmente
 * transitório. Ficam onde estão até o canal Brevo ser aposentado de vez
 * (depois do 1º envio Kit real, #7633), quando as três descem pra um módulo
 * de ciclo sem nome de ESP. Mesma decisão do #7121: não renomear enquanto o
 * predecessor ainda existe no repo.
 *
 * O que NÃO é reusado é o perfil de UTM: `APOIADORES_KIT_UTM_PROFILE`
 * (`lib/mensal/monthly-apoiadores-kit-render.ts`) troca merge tag do voto,
 * `utm_source` e `pollBrand` — ver a docstring de lá.
 *
 * Este script NUNCA chama a API do Kit — produz só o HTML local. Quem cria o
 * broadcast é `scripts/publish-monthly-apoiadores-kit.ts` (Passo 2 da skill
 * `/diaria-mensal-apoiadores`), que chama `renderMonthlyApoiadoresKitEmail`
 * internamente.
 *
 * Uso:
 *   npx tsx scripts/render-monthly-apoiadores-kit.ts --cycle 2607-08
 *
 * Pré-requisito: `_internal/public-images.json` do ciclo já existe — rodar a
 * Etapa 3/4 do `/diaria-mensal` (`monthly-preview-cloudflare.ts`) nesse ciclo
 * antes, mesmo que o envio Clarice ainda não tenha acontecido.
 *
 * Output: data/monthly/{cycle}/_internal/apoiadores-kit-preview.html
 * Stdout: JSON { cycle, yymm, subject, preview_text, html_path }
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { draftToEmailApoiadoresKit, APOIADORES_KIT_UTM_PROFILE } from "./lib/mensal/monthly-apoiadores-kit-render.ts";
import { parseEiaLegend, captionForGenerator } from "./lib/mensal/monthly-render.ts";
import { relinkMonthlyEditionHtml } from "./monthly-relink-to-diaria.ts"; // #4048 (mesmo relink dos demais canais)
import { isMainModule } from "./lib/cli-args.ts";
import { parseMonthlyCycleArg, cycleToYymm, monthlyDir as resolveMonthlyDir } from "./lib/mensal/monthly-paths.ts";
import { readPublicImages, missingImageKeys } from "./render-monthly-apoiadores-brevo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface RenderedMonthlyApoiadoresKitEmail {
  cycle: string;
  yymm: string;
  subject: string;
  previewText: string;
  html: string;
  htmlPath: string;
}

/**
 * Núcleo de render, reusado por `scripts/publish-monthly-apoiadores-kit.ts`
 * sem duplicar montagem/relink/escrita. Aborta (`process.exit`) se `draft.md`
 * ou `public-images.json` estiverem ausentes — mesmo contrato do render
 * Brevo.
 */
export function renderMonthlyApoiadoresKitEmail(cycle: string): RenderedMonthlyApoiadoresKitEmail {
  const yymm = cycleToYymm(cycle);
  const monthlyDir = resolveMonthlyDir(cycle);
  const draftPath = resolve(monthlyDir, "draft.md");
  if (!existsSync(draftPath)) {
    console.error(`draft.md não encontrado: ${draftPath}. Rode a Etapa 2 do /diaria-mensal primeiro.`);
    process.exit(1);
  }
  const draft = readFileSync(draftPath, "utf8");

  const chosenSubjectPath = resolve(monthlyDir, "_internal", "02-chosen-subject.txt");
  const chosenSubject = existsSync(chosenSubjectPath) ? readFileSync(chosenSubjectPath, "utf8").trim() : null;

  const images = readPublicImages(monthlyDir);
  const missingImages = missingImageKeys(images);
  if (missingImages.length) {
    console.error(
      `[render-monthly-apoiadores-kit] aviso: public-images.json sem URL para: ${missingImages.join(", ")} — ` +
        "essa(s) imagem(ns) sai(em) como placeholder cinza no HTML final.",
    );
  }
  const destaqueImageUrls: Record<number, string> = {};
  for (const n of [1, 2, 3]) {
    const img = images[`d${n}`];
    if (img?.url) destaqueImageUrls[n] = img.url;
  }
  const eiaImageUrlA = images.eia_a?.url;
  const eiaImageUrlB = images.eia_b?.url;
  const livrosImageUrl = images.livros_promo?.url;

  const eiaMdPath = resolve(monthlyDir, "01-eia.md");
  const eiaCredit = existsSync(eiaMdPath) ? parseEiaLegend(readFileSync(eiaMdPath, "utf8")) : undefined;

  const platformConfigPath = resolve(ROOT, "platform.config.json");
  const imageGenerator: string = existsSync(platformConfigPath)
    ? ((JSON.parse(readFileSync(platformConfigPath, "utf8")) as { image_generator?: string }).image_generator ?? "gemini")
    : "gemini";
  const destaqueImageCaption = captionForGenerator(imageGenerator);

  let { subject, previewText, html } = draftToEmailApoiadoresKit(
    draft,
    chosenSubject,
    yymm,
    eiaImageUrlA,
    eiaImageUrlB,
    eiaCredit,
    destaqueImageUrls,
    destaqueImageCaption,
    livrosImageUrl,
    null, // eiaPrevResultLine: opt-in, não plugado nesta variante (mesmo estado do render Brevo)
  );

  // #4048: mesmo pós-processo dos demais canais — reescreve destaques pra
  // apontar pra edição diária de origem, com sourceOverride pra não vazar
  // utm_source=clarice nesta variante. Fail-soft: sem raw-destaques.json, o
  // HTML original segue intacto.
  try {
    const relinked = relinkMonthlyEditionHtml(html, monthlyDir, ROOT, undefined, APOIADORES_KIT_UTM_PROFILE.source);
    html = relinked.html;
    console.error(
      `Relink pra edição diária (#4048): ${relinked.relinked} reescritos, ${relinked.servico} mantidos (serviço), ${relinked.naoMapeado} sem mapeamento`,
    );
    if (relinked.ambiguous.length) {
      console.error(
        `aviso: ${relinked.ambiguous.length} URL(s) de destaque aparecem em MAIS DE UMA edição — o relink usou a primeira; confira se é a citada no texto:`,
      );
      for (const a of relinked.ambiguous) {
        console.error(`  ${a.url.slice(0, 80)}  → edições ${a.editions.join(", ")} (usada: ${a.editions[0]})`);
      }
    }
  } catch (e) {
    console.error(`warn: relink pra edição diária (#4048) falhou — ${(e as Error).message}`);
  }

  const internalDir = resolve(monthlyDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const htmlPath = resolve(internalDir, "apoiadores-kit-preview.html");
  writeFileSync(htmlPath, html);

  return { cycle, yymm, subject, previewText, html, htmlPath };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cycle = parseMonthlyCycleArg(argv);
  if (!cycle) {
    console.error("Uso: render-monthly-apoiadores-kit.ts --cycle YYMM-MM");
    process.exit(2);
    return;
  }

  const rendered = renderMonthlyApoiadoresKitEmail(cycle);
  console.log(
    JSON.stringify(
      { cycle, yymm: rendered.yymm, subject: rendered.subject, preview_text: rendered.previewText, html_path: rendered.htmlPath },
      null,
      2,
    ),
  );
  console.log("\nPróximo passo: npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle " + cycle + " --dry-run");
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[render-monthly-apoiadores-kit] ${(e as Error).message}`);
    process.exit(1);
  });
}
