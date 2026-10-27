/**
 * gen-carousel-cards.ts (#6005 Parte B)
 *
 * Gera os 4 slides SEM foto (3 parágrafos + CTA) do carrossel diário do
 * Instagram pra cada destaque presente em `03-social.md` — a capa (slide 1)
 * é o `04-{destaque}-4x5.jpg` que `gen-social-card-4x5.ts` já gera, não
 * regenerado aqui. Ver `scripts/lib/daily-carousel-card.ts` (miolo pure) pro
 * design completo.
 *
 * Roda no Stage 3 (`stage-3-run.ts`), DEPOIS de `gen-social-card-4x5.ts` —
 * depende só de `03-social.md` (Stage 2) já existir, não da geração de
 * imagem em si.
 *
 * Uso:
 *   npx tsx scripts/gen-carousel-cards.ts --edition-dir data/editions/260824/ [--force]
 *
 * Saída local (raiz da edição): `04-{destaque}-carousel-{p1,p2,p3,cta}-4x5.jpg`.
 * `--force` regenera mesmo se nada mudou, mas preserva exceções do editor
 * em carousel-keep-art.json com aviso explícito. Sem ele a idempotência é POR
 * CONTEÚDO (#6064 item 1): pula quando os 4 arquivos existem E o texto do
 * `## d{N}` ainda rasteriza no mesmo carimbo gravado em
 * `_internal/.carousel-source-hash.json`; se o editor editou o social depois
 * (painel Revisão do Stage 4), o destaque é REGERADO em vez de pulado. Antes
 * disso a idempotência era por existência de arquivo, e a arte publicada
 * ficava com o texto pré-edição em silêncio.
 *
 * Best-effort por destaque: falha ao extrair o texto de UM destaque não
 * aborta os demais (o carrossel daquele destaque cai pro fallback de post
 * single-image em `publish-instagram.ts` — ver `resolveCarouselImageUrls`);
 * falha do RENDER (fonte de marca ausente, sharp) é bloqueante — mesma
 * severidade de `gen-social-card-4x5.ts` (#4090), porque nesse caso NENHUM
 * card sem foto vai sair certo, não só o de um destaque.
 *
 * TEXTO QUE NÃO CABE também é bloqueante (#6078 item 2): desde que o corpo
 * passou a ter tamanho FIXO (`DAILY_CAROUSEL_BODY_SIZE`), o texto não encolhe
 * mais sozinho, e a política do editor é reescrever o parágrafo. O erro nomeia
 * destaque, slide e quanto passou — renderizar transbordado seria degradar a
 * arte em silêncio, a mesma classe de falha que o #6064 consertou.
 *
 * EXCEÇÃO DO EDITOR (#11210): destaque listado em
 * `_internal/carousel-keep-art.json` não entra na pré-passada de overflow nem
 * no render — a arte existente fica como está, sem carimbo novo, e o destaque
 * sai em `skipped`. Os demais destaques e o 4º post geram normalmente. A
 * exceção só vale com os 4 slides no disco; sem eles o destaque gera como
 * qualquer outro (e o overflow volta a abortar), porque não há arte a manter.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  USE_MELHOR_POST_ID,
  loadUseMelhorPostConfigState,
  readApprovedForUseMelhor,
  readUseMelhorPostState,
  resolveUseMelhorCoverTitle,
  type UseMelhorPostConfigState,
} from "./lib/use-melhor-post.ts"; // #9568
import {
  buildUseMelhorSlides,
  findOverflowingUseMelhorSlides,
  hashUseMelhorSlides,
  isUseMelhorCarouselStale, // #10834
  readUseMelhorCarouselStamp,
  removeStaleUseMelhorSlides,
  renderUseMelhorSlides,
  useMelhorSlideFilename,
  writeUseMelhorCarouselStamp,
} from "./lib/use-melhor-carousel.ts"; // #9568
import { pruneStaleUseMelhorPublicImages } from "./lib/use-melhor-slide-files.ts"; // #9795
import { readUseMelhorBlock } from "./lib/use-melhor-status.ts"; // #10834
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { assertBrandSerifAvailable } from "./lib/shared/assert-brand-font.ts";
import { readDestaqueCount } from "./lib/invariant-checks/stage-3.ts";
import { extractSection, extractDestaqueBlock } from "./lib/extract-section.ts";
import { readCoverOverride } from "./gen-social-card-4x5.ts";
import { readInstagramTestOverride, type CarouselCtaOverride } from "./lib/instagram-test-override.ts"; // #8681
import { readCarouselKeepArt, CAROUSEL_KEEP_ART_FILENAME } from "./lib/carousel-keep-art.ts"; // #11210
import {
  CAROUSEL_SLIDE_SLOTS,
  carouselSlideFilename,
  carouselSlidesOnDisk, // #11210
  renderCarouselSlides,
  hashCarouselSlideTexts,
  shouldRenderCarouselSlides,
  readCarouselSourceHashes,
  writeCarouselSourceHashes,
  findOverflowingCarouselSlides,
  readCarouselCardParagraphs, // #11211
  writeCarouselCardParagraphs, // #11211
  resolveCarouselCardText, // #11211
  carouselCardParagraphs, // #11211
  DAILY_CAROUSEL_BODY_SIZE,
  DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET,
  type CarouselSourceHashes,
  type CarouselCardParagraphs, // #11211
} from "./lib/daily-carousel-card.ts";

export interface GenCarouselCardsResult {
  generated: string[];
  skipped: { destaque: string; reason: string }[];
  /** Destaques regerados porque o texto do social mudou desde o carimbo (#6064). */
  refreshed: string[];
  /**
   * (#9568) Carrossel tipográfico do 4º post (USE MELHOR). AUSENTE enquanto
   * `publishing.social.use_melhor_time` não estiver definido — com a feature
   * desligada o resultado é idêntico ao de antes.
   */
  use_melhor?: UseMelhorCarouselOutcome;
}

export interface UseMelhorCarouselOutcome {
  status: "generated" | "unchanged" | "skipped";
  slots?: string[];
  files?: string[];
  reason?: string;
  /** #9795: chaves `um_carousel_*` removidas de `06-public-images.json` (slides que não existem mais). */
  pruned_image_keys?: string[];
}

export type RenderUseMelhorSlidesFn = typeof renderUseMelhorSlides;

const REPO_ROOT = resolve(import.meta.dirname, "..");

/**
 * Seam de render (#6068, review de cobertura): `renderCarouselSlides` chama
 * `sharp` + fonte de marca, então o caminho de REGERAÇÃO — o que esta issue
 * existe pra consertar — não era testável sem depender do ambiente gráfico.
 * Injetável exatamente como `RenameFileDeps` em `reorder-destaques.ts`.
 */
export type RenderCarouselSlidesFn = typeof renderCarouselSlides;

export async function genCarouselCards(
  editionDir: string,
  opts: {
    force?: boolean;
    render?: RenderCarouselSlidesFn;
    /** #9568: estado do config do 4º post (default: lido de `platform.config.json`). */
    useMelhorConfig?: UseMelhorPostConfigState;
    renderUseMelhor?: RenderUseMelhorSlidesFn;
  } = {},
): Promise<GenCarouselCardsResult> {
  const render = opts.render ?? renderCarouselSlides;
  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    throw new Error(`03-social.md ausente em ${editionDir} — rode a Etapa 2 primeiro`);
  }
  const socialMd = readFileSync(socialMdPath, "utf8");
  const section = extractSection(socialMd, "Social");
  const destaqueCount = readDestaqueCount(editionDir);
  const destaques = destaqueCount === 3 ? (["d1", "d2", "d3"] as const) : (["d1", "d2"] as const);

  const generated: string[] = [];
  const skipped: { destaque: string; reason: string }[] = [];
  const refreshed: string[] = [];
  const storedHashes = readCarouselSourceHashes(editionDir);
  // #8681: override de teste do slide CTA (lança se o JSON estiver malformado).
  const ctaOverride = readInstagramTestOverride(editionDir)?.cta_slide ?? null;
  const hashes: CarouselSourceHashes = {};
  // #11211: divisão em cards gravada no último render. Se o `## d{N}` só foi
  // reparagrafado (mesmas palavras), os cards seguem essa divisão — a arte não
  // muda e o 3º card não engole os parágrafos extras da legenda.
  const storedParagraphs = readCarouselCardParagraphs(editionDir);
  const cardParagraphs: CarouselCardParagraphs = {};
  const cardTextOf = (d: (typeof destaques)[number]): string | null => {
    const dText = slideSourceText(editionDir, d, section ? extractDestaqueBlock(section, d) : null);
    return dText ? resolveCarouselCardText(dText.trim(), storedParagraphs) : dText;
  };
  // #11210: destaques cuja arte o editor decidiu MANTER ficam fora da pré-passada
  // de overflow e do render — senão o texto reparagrafado deles abortava a
  // geração de TODOS (inclusive o 4º post). Lança se o JSON estiver malformado.
  // Só vale com os 4 slides no disco: sem arte não há o que manter (ex.: o
  // swap-destaque apagou o carrossel), e o destaque gera normalmente.
  const keepArtRaw = readCarouselKeepArt(editionDir);
  const keepArt = new Set<string>(destaques.filter((d) => keepArtRaw[d] && carouselSlidesOnDisk(editionDir, d)));
  const inactiveKeys = Object.keys(keepArtRaw).filter((d) => !destaques.some((active) => active === d));
  if (inactiveKeys.length > 0) {
    console.error(
      `[gen-carousel-cards] ${CAROUSEL_KEEP_ART_FILENAME}: ${inactiveKeys.join(", ")} não pertence à edição ` +
        `de ${destaqueCount} destaques; exceção ignorada. Remova a chave sem destaque correspondente (#11214).`,
    );
  }
  if (opts.force && keepArt.size > 0) {
    console.error(
      `[gen-carousel-cards] --force não sobrepõe a decisão editorial em ${CAROUSEL_KEEP_ART_FILENAME}: ` +
        `arte mantida para ${[...keepArt].join(", ")}. Para regenerar, remova a chave correspondente do arquivo ` +
        `e rode novamente; o texto será validado antes do render (#11214).`,
    );
  }
  const keepArtSemArte = destaques.filter((d) => keepArtRaw[d] && !keepArt.has(d));
  if (keepArtSemArte.length > 0) {
    console.error(
      `[gen-carousel-cards] exceção de ${CAROUSEL_KEEP_ART_FILENAME} ignorada para ${keepArtSemArte.join(", ")}: ` +
        `arte do carrossel incompleta ou ausente no disco — gerando normalmente (#11210).`,
    );
  }

  // #6078 item 2 — PRÉ-PASSADA de overflow, antes de renderizar qualquer
  // destaque. Com tamanho FIXO o texto não encolhe mais pra caber, e a política
  // do editor é REESCREVER o parágrafo; renderizar transbordado seria a mesma
  // falha silenciosa que o #6064 consertou, na direção oposta.
  //
  // A checagem é de TODOS os destaques de uma vez, e não dentro do loop de
  // render (review do #6085): abortar no primeiro transbordante escondia os
  // demais, e o editor descobria um por vez, em ciclos separados de
  // corrigir+re-rodar. Aqui ele recebe a lista inteira do que reescrever —
  // mesmo comportamento do invariante irmão `carousel-text-overflow` no Stage 4.
  const transbordam: { destaque: string; slides: ReturnType<typeof findOverflowingCarouselSlides> }[] = [];
  for (const d of destaques) {
    if (keepArt.has(d)) continue; // #11210: arte mantida — reportado como `skipped` abaixo
    const dText = cardTextOf(d);
    if (!dText) continue; // reportado como `skipped` no loop principal abaixo
    const slides = findOverflowingCarouselSlides(dText, ctaOverride);
    if (slides.length > 0) transbordam.push({ destaque: d, slides });
  }
  if (transbordam.length > 0) {
    const detalhe = transbordam
      .map(
        ({ destaque, slides }) =>
          `  ${destaque}:\n` +
          slides.map((o) => `    · ${o.slot}: ${o.chars} chars → ${o.lines} linhas, ${o.excessPx}px além do card`).join("\n"),
      )
      .join("\n");
    const total = transbordam.reduce((n, t) => n + t.slides.length, 0);
    throw new Error(
      `${total} slide(s) do carrossel não cabem no card em ${DAILY_CAROUSEL_BODY_SIZE}px ` +
        `(${transbordam.length} destaque(s) afetado(s)):\n${detalhe}\n\n` +
        `Fix: REESCREVER os parágrafos correspondentes em 03-social.md pra ` +
        `~${DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET} caracteres ou menos, e rodar de novo. ` +
        `O tamanho da fonte é fixo de propósito (#6078): encolher só o slide que estourou traria ` +
        `de volta a variação de métrica entre os cards do mesmo carrossel, e cortar o texto ` +
        `sumiria com conteúdo. Nenhum slide foi gerado nesta invocação.`,
    );
  }

  for (const d of destaques) {
    if (keepArt.has(d)) {
      // #11210: não regera nem grava carimbo; os slides existentes seguem
      // valendo pro upload/publish (que já monta o carrossel com o que há no disco).
      skipped.push({ destaque: d, reason: `arte mantida pelo editor (${CAROUSEL_KEEP_ART_FILENAME})` });
      generated.push(...CAROUSEL_SLIDE_SLOTS.map((slot) => resolve(editionDir, carouselSlideFilename(d, slot))));
      continue;
    }
    const dText = cardTextOf(d);
    if (!dText) {
      skipped.push({ destaque: d, reason: `bloco '## ${d}' não encontrado em '# Social' de 03-social.md` });
      continue;
    }

    const outPaths = Object.fromEntries(
      CAROUSEL_SLIDE_SLOTS.map((slot) => [slot, resolve(editionDir, carouselSlideFilename(d, slot))]),
    ) as Record<(typeof CAROUSEL_SLIDE_SLOTS)[number], string>;

    // #6064 item 1: idempotência por CONTEÚDO, não por existência de arquivo.
    // Texto igual ao do carimbo → pula; texto editado depois (Studio, Stage 4)
    // → regera, senão a arte publicada fica com o texto pré-edição.
    const hash = hashCarouselSlideTexts(dText, ctaOverride);
    hashes[d] = hash;
    cardParagraphs[d] = carouselCardParagraphs(dText);
    const allSlidesExist = CAROUSEL_SLIDE_SLOTS.every((slot) => existsSync(outPaths[slot]));
    if (!shouldRenderCarouselSlides({ allSlidesExist, storedHash: storedHashes[d], currentHash: hash, force: opts.force })) {
      generated.push(...CAROUSEL_SLIDE_SLOTS.map((slot) => outPaths[slot]));
      continue;
    }
    if (allSlidesExist && storedHashes[d] !== hash) refreshed.push(d);

    const rendered = await render(dText, outPaths, ctaOverride);
    generated.push(...CAROUSEL_SLIDE_SLOTS.map((slot) => rendered[slot]));
    // #6068: carimbo gravado LOGO APÓS cada render bem-sucedido, não num
    // único write no fim. `renderCarouselSlides` escreve os 4 slots em
    // sequência e falha de render é bloqueante — com o write no fim, um throw
    // no destaque 2 descartava também o carimbo do destaque 1 que já tinha
    // renderizado certo, deixando um ERROR falso de `carousel-cards-stale`
    // até alguém re-rodar. O merge de `writeCarouselSourceHashes` torna a
    // escrita incremental barata e idempotente.
    writeCarouselSourceHashes(editionDir, { [d]: hash });
    writeCarouselCardParagraphs(editionDir, { [d]: cardParagraphs[d] }); // #11211
  }

  // Destaques PULADOS (carimbo já batia) também precisam constar — cobre a
  // edição pré-#6064 cujo carimbo nasce agora, sem re-render.
  if (Object.keys(hashes).length > 0) writeCarouselSourceHashes(editionDir, hashes);
  // #11211: idem para a divisão em cards — destaque pulado cuja arte já batia
  // passa a ter a divisão gravada (edição anterior ao #11211).
  if (Object.keys(cardParagraphs).length > 0) writeCarouselCardParagraphs(editionDir, cardParagraphs);

  const result: GenCarouselCardsResult = { generated, skipped, refreshed };
  // #9568: 4º post — só quando o slot está definido. Desligado → nenhum campo
  // novo, nenhum arquivo novo (D1/D2/D3 seguem exatamente como antes).
  const umConfig = opts.useMelhorConfig ?? loadUseMelhorPostConfigState(REPO_ROOT);
  if (umConfig.enabled) {
    result.use_melhor = await genUseMelhorCarousel(editionDir, socialMd, {
      force: opts.force,
      ctaOverride,
      render: opts.renderUseMelhor ?? renderUseMelhorSlides,
    });
    if (result.use_melhor.files) generated.push(...result.use_melhor.files);
  }
  return result;
}

/**
 * (#9568) Carrossel do 4º post. FAIL-SOFT de ponta a ponta: sem item
 * selecionado, sem `## um`, ou texto que não cabe → `skipped` com motivo
 * (o publisher cai pro post de imagem única / pula), nunca lança — o 4º post
 * não pode bloquear a edição. Falha do RENDER em si (sharp/fonte) continua
 * propagando, mesma severidade dos destaques: se a fonte de marca falta,
 * nenhum card sai certo.
 */
async function genUseMelhorCarousel(
  editionDir: string,
  socialMd: string,
  opts: { force?: boolean; ctaOverride?: CarouselCtaOverride | null; render: RenderUseMelhorSlidesFn },
): Promise<UseMelhorCarouselOutcome> {
  const state = readUseMelhorPostState(editionDir);
  if (!state?.item) {
    return { status: "skipped", reason: state?.reason ?? "_internal/use-melhor-post.json ausente — Stage 2 não selecionou o item" };
  }
  const section = extractSection(socialMd, "Social");
  const umText = section ? extractDestaqueBlock(section, USE_MELHOR_POST_ID) : null;
  if (!umText || !umText.trim()) {
    return { status: "skipped", reason: `bloco '## ${USE_MELHOR_POST_ID}' não encontrado em '# Social' de 03-social.md` };
  }
  // #9600: capa com o título da EDIÇÃO (cover_title manual > título editado >
  // título do item em 02-reviewed.md > título da fonte), não o da fonte cru.
  const coverTitle = resolveUseMelhorCoverTitle(state.item, {
    reviewedMd: existsSync(resolve(editionDir, "02-reviewed.md"))
      ? readFileSync(resolve(editionDir, "02-reviewed.md"), "utf8")
      : null,
    approved: readApprovedForUseMelhor(editionDir),
  });
  const slides = buildUseMelhorSlides(umText.trim(), coverTitle, opts.ctaOverride);
  if (slides.length === 0) {
    return { status: "skipped", reason: `'## ${USE_MELHOR_POST_ID}' sem corpo` };
  }
  const overflow = findOverflowingUseMelhorSlides(umText.trim(), coverTitle, opts.ctaOverride);
  if (overflow.length > 0) {
    return {
      status: "skipped",
      reason:
        `slide(s) do 4º post não cabem no card: ` +
        overflow.map((o) => `${o.slot} (${o.chars} chars, ${o.excessPx}px além)`).join("; ") +
        ` — reescrever '## ${USE_MELHOR_POST_ID}' em 03-social.md`,
    };
  }
  const slots = slides.map((s) => s.slot);
  const files = slots.map((slot) => resolve(editionDir, useMelhorSlideFilename(slot)));
  const hash = hashUseMelhorSlides(slides);
  const stamp = readUseMelhorCarouselStamp(editionDir);
  const allExist = files.every((f) => existsSync(f));
  if (!opts.force && allExist && stamp?.hash === hash) {
    // #9630: carimbo anterior ao campo — mesmo hash implica mesmo título, então
    // só completa o `cover_title` sem re-renderizar.
    if (stamp.cover_title !== coverTitle) writeUseMelhorCarouselStamp(editionDir, { hash, slots, cover_title: coverTitle });
    removeStaleUseMelhorSlides(editionDir, slots);
    const prunedKeys = pruneStaleUseMelhorPublicImages(editionDir, slots); // #9795
    return { status: "unchanged", slots, files, ...(prunedKeys.length > 0 && { pruned_image_keys: prunedKeys }) };
  }
  await opts.render(editionDir, slides);
  // #9630: grava o título da capa — a conferência pós-gate compara contra ele.
  writeUseMelhorCarouselStamp(editionDir, { hash, slots, cover_title: coverTitle });
  // Self-review #9572 (findings 2/3): `## um` com menos parágrafos que o render
  // anterior deixaria `p{k}` antigos no disco — apaga a sobra.
  removeStaleUseMelhorSlides(editionDir, slots);
  // #9795: e as chaves desses slides antigos em `06-public-images.json` — sem
  // isso o upload/preview seguiam listando `um_carousel_p{k}` de slide apagado.
  const prunedKeys = pruneStaleUseMelhorPublicImages(editionDir, slots);
  return { status: "generated", slots, files, ...(prunedKeys.length > 0 && { pruned_image_keys: prunedKeys }) };
}

export interface UseMelhorCarouselRefresh {
  /**
   * - `noop`: nada a conferir (feature desligada, sem carimbo, sem item, sem `## um`);
   * - `fresh`: carimbo em dia com o `## um` atual;
   * - `regenerated`: estava defasado e foi regerado agora;
   * - `skipped`: estava defasado e o regerar foi pulado (ex.: `## um` novo não cabe no card);
   * - `failed`: estava defasado e o regerar falhou (fonte de marca ausente, sharp).
   */
  status: "noop" | "fresh" | "regenerated" | "skipped" | "failed";
  reason?: string;
  slots?: string[];
  /**
   * (#10879) Só com `status: "failed"`: `"font_missing"` quando a falha foi a
   * fonte de marca (Georgia) ausente nesta máquina — o caso do servidor 300.
   * Separado dos demais `failed` porque o conserto é outro (regerar numa
   * máquina com Georgia), e quem consome precisa dizer isso em voz alta.
   */
  cause?: "font_missing";
}

/**
 * (#10834) Regera SÓ o carrossel do 4º post quando o carimbo do Stage 3 está
 * defasado em relação ao `## um` atual — caso real 261022: o `## um` foi
 * editado depois do Stage 3, o carimbo ficou para trás e os publicadores
 * pularam o 4º post no LinkedIn, Facebook e Instagram (X saiu só com texto).
 * Chamado por `upload-images-public.ts` (modo social/all) ANTES de decidir
 * quais slides subir, então vale no pré-render do Stage 4 e no Stage 5.
 *
 * Nunca lança: o 4º post é fail-soft e o upload de D1/D2/D3 não pode cair por
 * causa dele. Sem carimbo (carrossel nunca gerado) é `noop` de propósito: isso
 * é falta do Stage 3, já avisada no gate 4, não defasagem.
 */
export async function refreshStaleUseMelhorCarousel(
  editionDir: string,
  opts: {
    useMelhorConfig?: UseMelhorPostConfigState;
    render?: RenderUseMelhorSlidesFn;
    assertFont?: (scriptName: string) => Promise<void>;
  } = {},
): Promise<UseMelhorCarouselRefresh> {
  try {
    const stamp = readUseMelhorCarouselStamp(editionDir);
    if (!stamp) return { status: "noop", reason: "carrossel do 4º post sem carimbo" };
    const umConfig = opts.useMelhorConfig ?? loadUseMelhorPostConfigState(REPO_ROOT);
    if (!umConfig.enabled) return { status: "noop", reason: umConfig.reason ?? "4º post desligado" };
    const socialMdPath = resolve(editionDir, "03-social.md");
    if (!existsSync(socialMdPath)) return { status: "noop", reason: "03-social.md ausente" };
    const socialMd = readFileSync(socialMdPath, "utf8");
    const state = readUseMelhorPostState(editionDir);
    const socialUm = readUseMelhorBlock(socialMd, "Social");
    if (!state?.item || !socialUm) return { status: "noop", reason: "sem item ou sem '## um'" };
    const reviewedPath = resolve(editionDir, "02-reviewed.md");
    const coverTitle = resolveUseMelhorCoverTitle(state.item, {
      reviewedMd: existsSync(reviewedPath) ? readFileSync(reviewedPath, "utf8") : null,
      approved: readApprovedForUseMelhor(editionDir),
    });
    let ctaOverride: CarouselCtaOverride | null = null;
    try {
      ctaOverride = readInstagramTestOverride(editionDir)?.cta_slide ?? null;
    } catch {
      ctaOverride = null;
    }
    if (!isUseMelhorCarouselStale(stamp, socialUm, coverTitle, ctaOverride)) {
      return { status: "fresh", slots: stamp.slots };
    }
    // Mesmo guard do `main()` — sem a fonte de marca a arte sairia fora da marca em silêncio.
    // #10879: a falha de fonte sai marcada (`cause`), pra o upload avisar com o conserto certo.
    try {
      await (opts.assertFont ?? assertBrandSerifAvailable)("gen-carousel-cards (4º post, #10834)");
    } catch (e) {
      return { status: "failed", cause: "font_missing", reason: (e as Error).message };
    }
    const outcome = await genUseMelhorCarousel(editionDir, socialMd, {
      ctaOverride,
      render: opts.render ?? renderUseMelhorSlides,
    });
    if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
    return { status: outcome.status === "generated" ? "regenerated" : "fresh", slots: outcome.slots };
  } catch (e) {
    return { status: "failed", reason: (e as Error).message };
  }
}

/**
 * Texto que vai para os slides de parágrafo. Na capa de série (Etapa 6 da
 * anual), `_internal/social-cover.json` pode trazer `slide_prefix` — a frase
 * de abertura que marca o post como parte da série na LEGENDA, mas que no
 * slide repetiria o que a capa já diz (decisão do editor, 12/09/2026). Ela é
 * tirada só do slide; a legenda continua com ela. Sem o arquivo (diária),
 * devolve o texto intacto.
 */
export function slideSourceText(editionDir: string, destaque: string, text: string | null): string | null {
  if (!text) return text;
  const cover = readCoverOverride(editionDir, destaque);
  // `slide_text` explícito (seção `# Slides` do 03-social.md da anual) vence:
  // o carrossel usa esse texto e ignora a legenda.
  if (cover?.slideText) return cover.slideText;
  const prefix = cover?.slidePrefix;
  if (!prefix) return text;
  const t = text.trimStart();
  if (!t.startsWith(prefix)) {
    throw new Error(`slide_prefix de ${destaque} não abre o texto do post — 03-social.md mudou depois do prep-annual-social?`);
  }
  return t.slice(prefix.length).trimStart();
}

async function main(): Promise<void> {
  // Mesmo guard de gen-social-card-4x5.ts (#4090) — sem isso os cards saem
  // com fallback de fonte, fora da marca, em silêncio.
  await assertBrandSerifAvailable("gen-carousel-cards");
  const args = parseCliArgs(process.argv.slice(2));
  const editionDir = args.values["edition-dir"] ?? "";
  if (!editionDir) {
    console.error("uso: gen-carousel-cards.ts --edition-dir <dir> [--force]");
    process.exit(1);
  }
  const force = args.flags.has("force");

  const result = await genCarouselCards(editionDir, { force });
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
