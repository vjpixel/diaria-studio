#!/usr/bin/env node
/**
 * scripts/render-monthly-beehiiv.ts (#4482)
 *
 * Renderiza a variante BEEHIIV do digest mensal — envio EXTRA pra
 * apoiadores Mantenedor/Patrono (decisão do editor na issue #4482; ver
 * `scripts/lib/mensal/monthly-beehiiv-render.ts` pro rationale completo e as
 * 5 decisões de produto). Reusa o MESMO `draft.md` e as MESMAS imagens já
 * publicadas pro envio Clarice — não faz upload novo, lê os URLs já
 * publicados de `_internal/public-images.json` (escrito pela Etapa 3/4 do
 * `/diaria-mensal`, `monthly-preview-cloudflare.ts`).
 *
 * Diferente de `publish-monthly.ts`/`monthly-preview-cloudflare.ts`, este
 * script NUNCA toca a Brevo (nem qualquer API ao vivo) — produz só o HTML
 * local pra colar manualmente no Beehiiv seguindo
 * `context/publishers/beehiiv-playbook.md` (Worker-hosted paste), o mesmo
 * fluxo semi-manual que `prep-manual-publish.ts` documenta pra diária.
 * Automação completa de agendamento fica pra follow-up (fora do escopo do
 * primeiro envio, #4482).
 *
 * Uso:
 *   npx tsx scripts/render-monthly-beehiiv.ts --cycle 2607-08
 *
 * Pré-requisito: `_internal/public-images.json` do ciclo já existe — rodar
 * a Etapa 3/4 do `/diaria-mensal` (`monthly-preview-cloudflare.ts`) nesse
 * ciclo antes, mesmo que o envio Clarice em si ainda não tenha acontecido
 * (o preview já sobe as imagens pro KV independente do envio).
 *
 * Output: data/monthly/{cycle}/_internal/beehiiv-preview.html
 * Stdout: JSON { cycle, yymm, subject, preview_text, html_path }
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { draftToEmailBeehiiv, BEEHIIV_UTM_PROFILE } from "./lib/mensal/monthly-beehiiv-render.ts";
import { parseEiaLegend, captionForGenerator } from "./lib/mensal/monthly-render.ts";
import { relinkMonthlyEditionHtml } from "./monthly-relink-to-diaria.ts"; // #4048 (mesmo relink do envio Clarice)
import { isMainModule } from "./lib/cli-args.ts";
import { parseMonthlyCycleArg, cycleToYymm, monthlyDir as resolveMonthlyDir } from "./lib/mensal/monthly-paths.ts";
import type { MonthlyPublicImage } from "./monthly-preview-cloudflare.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PublicImagesManifest {
  images?: Record<string, MonthlyPublicImage>;
}

/**
 * Lê `_internal/public-images.json` (escrito por `monthly-preview-cloudflare.ts`,
 * #3392) — fonte das URLs de imagem JÁ publicadas pro Cloudflare KV pra este
 * ciclo. Aborta com instrução clara se ausente: sem ele não há URL pública
 * pra imagem nenhuma (e este script não faz upload — ver docstring do
 * módulo).
 */
export function readPublicImages(monthlyDir: string): Record<string, MonthlyPublicImage> {
  const path = resolve(monthlyDir, "_internal", "public-images.json");
  if (!existsSync(path)) {
    console.error(
      `[render-monthly-beehiiv] ERRO: ${path} não encontrado.\n` +
        "Rode a Etapa 3/4 do /diaria-mensal (monthly-preview-cloudflare.ts) neste ciclo antes " +
        "de renderizar a variante Beehiiv — este script reusa as imagens já publicadas, não faz upload novo.",
    );
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(path, "utf8")) as PublicImagesManifest;
  return manifest.images ?? {};
}

/**
 * #4510 (achado silent-failure-hunter, review pré-merge): chaves de imagem
 * esperadas no manifest — 3 destaques + par A/B do É IA? + capa da
 * curadoria de livros. Extraídas aqui porque `main()` consome exatamente
 * estas 6 chaves (`d1`/`d2`/`d3`/`eia_a`/`eia_b`/`livros_promo`) — ver
 * `missingImageKeys` abaixo.
 */
export const EXPECTED_IMAGE_KEYS = ["d1", "d2", "d3", "eia_a", "eia_b", "livros_promo"] as const;

/**
 * Enumera quais chaves esperadas estão ausentes (sem `url`) no manifest.
 * Pure. Antes deste fix, `main()` simplesmente deixava a variável
 * correspondente `undefined` e seguia — a imagem virava caixa cinza
 * (placeholder) no e-mail final sem sinal nenhum pro operador. Continua
 * fail-soft (o script não aborta: a Etapa 3/4 do fluxo Clarice pode
 * legitimamente ainda não ter gerado alguma imagem), só que agora com
 * warning explícito antes de escrever o HTML — ver call site em `main()`.
 */
export function missingImageKeys(images: Record<string, MonthlyPublicImage>): string[] {
  return EXPECTED_IMAGE_KEYS.filter((k) => !images[k]?.url);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cycle = parseMonthlyCycleArg(argv);
  if (!cycle) {
    console.error("Uso: render-monthly-beehiiv.ts --cycle YYMM-MM");
    process.exit(2);
    return;
  }

  const yymm = cycleToYymm(cycle);
  const monthlyDir = resolveMonthlyDir(cycle);
  const draftPath = resolve(monthlyDir, "draft.md");
  if (!existsSync(draftPath)) {
    console.error(`draft.md não encontrado: ${draftPath}. Rode a Etapa 2 do /diaria-mensal primeiro.`);
    process.exit(1);
    return;
  }
  const draft = readFileSync(draftPath, "utf8");

  const chosenSubjectPath = resolve(monthlyDir, "_internal", "02-chosen-subject.txt");
  const chosenSubject = existsSync(chosenSubjectPath) ? readFileSync(chosenSubjectPath, "utf8").trim() : null;

  const images = readPublicImages(monthlyDir);
  const missingImages = missingImageKeys(images);
  if (missingImages.length) {
    console.error(
      `[render-monthly-beehiiv] aviso: public-images.json sem URL para: ${missingImages.join(", ")} — ` +
        "essa(s) imagem(ns) sai(em) como placeholder cinza no HTML final (#4510).",
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

  let { subject, previewText, html } = draftToEmailBeehiiv(
    draft,
    chosenSubject,
    yymm,
    eiaImageUrlA,
    eiaImageUrlB,
    eiaCredit,
    destaqueImageUrls,
    destaqueImageCaption,
    livrosImageUrl,
    null, // eiaPrevResultLine: opt-in, não plugado nesta variante (#2709 é Clarice-only por ora)
  );

  // #4048: mesmo pós-processo do envio Clarice — reescreve destaques pra
  // apontar pra edição diária de origem em vez do veículo terceiro.
  // #4510: `sourceOverride: BEEHIIV_UTM_PROFILE.source` — sem isto, os links
  // de destaque relinkados saíam com `utm_source=clarice` hardcoded mesmo
  // nesta variante, misatribuindo a maioria dos cliques de saída ao canal
  // Clarice em vez do Beehiiv.
  // Fail-soft: sem raw-destaques.json, HTML original segue intacto.
  try {
    const relinked = relinkMonthlyEditionHtml(html, monthlyDir, ROOT, undefined, BEEHIIV_UTM_PROFILE.source);
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
  const htmlPath = resolve(internalDir, "beehiiv-preview.html");
  writeFileSync(htmlPath, html);

  console.log(JSON.stringify({ cycle, yymm, subject, preview_text: previewText, html_path: htmlPath }, null, 2));

  console.log("\n=== Próximos passos (manual, #4482) ===\n");
  console.log("1. Técnica de paste = §5 de context/publishers/beehiiv-playbook.md (browser + javascript_tool no");
  console.log("   Custom HTML block). Os scripts de staging do playbook (upload-html-public.ts/chunk-html-base64.ts)");
  console.log("   esperam data/editions/{AAMMDD}/_internal/newsletter-final.html — adaptar path/--edition-dir pro");
  console.log("   HTML acima (ou copiar) na hora do envio real; ver SKILL.md diaria-mensal para detalhe.");
  console.log("2. Compose tab → Title + Subject Line (sugestão do draft: ver 'subject' acima).");
  console.log('3. Audience tab → selecionar os segmentos "Apoio — Mantenedor" e "Apoio — Patrono"');
  console.log('   (NUNCA "All subscribers" — este é o envio EXTRA restrito a apoiadores, decisão 2 do #4482).');
  console.log("   Se o seletor de audiência do post não suportar múltiplos segmentos por envio, criar");
  console.log('   manualmente um segmento combinado ("Apoio — Mantenedor ou Patrono") pela UI antes de');
  console.log("   prosseguir — mesmo precedente operacional do #4436 (correção de segmento ao vivo pela UI).");
  console.log("4. Send test email pra confirmar visualmente antes de agendar/publicar.");
  console.log("5. Escolher um dia SEM edição diária pesada (decisão 1 do #4482) antes de agendar/enviar.");
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[render-monthly-beehiiv] ${(e as Error).message}`);
    process.exit(1);
  });
}
