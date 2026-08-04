#!/usr/bin/env node
/**
 * scripts/render-monthly-apoiadores-brevo.ts (#4593)
 *
 * Renderiza a variante BREVO do envio extra pra apoiadores Mantenedor/
 * Patrono — sucessor de `scripts/render-monthly-beehiiv.ts` (#4482, canal
 * nunca usado ao vivo: a Beehiiv bloqueia "Include and exclude segments" no
 * plano Launch/free, #4572). Reusa o MESMO `draft.md` e as MESMAS imagens já
 * publicadas pro envio Clarice — não faz upload novo, lê os URLs já
 * publicados de `_internal/public-images.json` (mesma fonte que a variante
 * Beehiiv já usava).
 *
 * Diferente de `publish-monthly.ts`/`monthly-preview-cloudflare.ts`, este
 * script NUNCA toca a Brevo (nem qualquer API ao vivo) — produz só o HTML
 * local. A criação de fato da campanha Brevo é
 * `scripts/publish-monthly-apoiadores-brevo.ts` (motor da skill
 * `/diaria-mensal-apoiadores`, Passo 2), que chama `renderMonthlyApoiadoresBrevoEmail`
 * (exportada abaixo) internamente. Este arquivo continua funcionando
 * standalone (só render, sem publicar) pra debug/preview rápido — mesmo
 * padrão de `render-monthly-beehiiv.ts`.
 *
 * Uso:
 *   npx tsx scripts/render-monthly-apoiadores-brevo.ts --cycle 2607-08
 *
 * Pré-requisito: `_internal/public-images.json` do ciclo já existe — rodar
 * a Etapa 3/4 do `/diaria-mensal` (`monthly-preview-cloudflare.ts`) nesse
 * ciclo antes, mesmo que o envio Clarice em si ainda não tenha acontecido.
 *
 * Output: data/monthly/{cycle}/_internal/apoiadores-brevo-preview.html
 * Stdout: JSON { cycle, yymm, subject, preview_text, html_path }
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { draftToEmailApoiadoresBrevo, APOIADORES_BREVO_UTM_PROFILE } from "./lib/mensal/monthly-apoiadores-brevo-render.ts";
import { readPublicImages, missingImageKeys } from "./render-monthly-beehiiv.ts"; // reuso — leitura de imagem é canal-agnóstica
import { parseEiaLegend, captionForGenerator } from "./lib/mensal/monthly-render.ts";
import { relinkMonthlyEditionHtml } from "./monthly-relink-to-diaria.ts"; // #4048 (mesmo relink do envio Clarice/Beehiiv)
import { isMainModule } from "./lib/cli-args.ts";
import { parseMonthlyCycleArg, cycleToYymm, monthlyDir as resolveMonthlyDir } from "./lib/mensal/monthly-paths.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface RenderedMonthlyApoiadoresBrevoEmail {
  cycle: string;
  yymm: string;
  subject: string;
  previewText: string;
  html: string;
  htmlPath: string;
}

/**
 * Núcleo de render, extraído (#4521 padrão análogo) pra ser reusado por
 * `scripts/publish-monthly-apoiadores-brevo.ts` sem duplicar a lógica de
 * montagem/relink/escrita do HTML. Mesmo comportamento de
 * `renderMonthlyBeehiivEmail`: aborta (`process.exit`) se `draft.md` ou
 * `public-images.json` estiverem ausentes.
 */
export function renderMonthlyApoiadoresBrevoEmail(cycle: string): RenderedMonthlyApoiadoresBrevoEmail {
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
      `[render-monthly-apoiadores-brevo] aviso: public-images.json sem URL para: ${missingImages.join(", ")} — ` +
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

  let { subject, previewText, html } = draftToEmailApoiadoresBrevo(
    draft,
    chosenSubject,
    yymm,
    eiaImageUrlA,
    eiaImageUrlB,
    eiaCredit,
    destaqueImageUrls,
    destaqueImageCaption,
    livrosImageUrl,
    null, // eiaPrevResultLine: opt-in, não plugado nesta variante (mesmo estado de monthly-beehiiv-render.ts)
  );

  // #4048/#4510: mesmo pós-processo do envio Clarice/Beehiiv — reescreve
  // destaques pra apontar pra edição diária de origem, com sourceOverride
  // pra não vazar utm_source=clarice hardcoded nesta variante.
  // Fail-soft: sem raw-destaques.json, HTML original segue intacto.
  try {
    const relinked = relinkMonthlyEditionHtml(html, monthlyDir, ROOT, undefined, APOIADORES_BREVO_UTM_PROFILE.source);
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
  const htmlPath = resolve(internalDir, "apoiadores-brevo-preview.html");
  writeFileSync(htmlPath, html);

  return { cycle, yymm, subject, previewText, html, htmlPath };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cycle = parseMonthlyCycleArg(argv);
  if (!cycle) {
    console.error("Uso: render-monthly-apoiadores-brevo.ts --cycle YYMM-MM");
    process.exit(2);
    return;
  }

  const rendered = renderMonthlyApoiadoresBrevoEmail(cycle);
  console.log(
    JSON.stringify(
      { cycle, yymm: rendered.yymm, subject: rendered.subject, preview_text: rendered.previewText, html_path: rendered.htmlPath },
      null,
      2,
    ),
  );
  console.log("\nPróximo passo: npx tsx scripts/publish-monthly-apoiadores-brevo.ts --cycle " + cycle + " --dry-run");
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[render-monthly-apoiadores-brevo] ${(e as Error).message}`);
    process.exit(1);
  });
}
