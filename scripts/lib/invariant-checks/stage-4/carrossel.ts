/**
 * Invariantes do Stage 4 — carrossel diário (cards, overflow, upload) (#14057).
 *
 * Família extraída de `../stage-4.ts` (divisão sem mudança de lógica). O
 * registro `STAGE_4_RULES` e o reexport público continuam em `../stage-4.ts`:
 * importe sempre de lá.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantViolation } from "../types.ts";
import { extractSection, extractDestaqueBlock, extractCarouselCardsBlock } from "../../extract-section.ts"; // #6064, #12094
import {
  CAROUSEL_SLIDE_SLOTS,
  carouselSlideFilename,
  carouselSlidesOnDisk, // #11210
  carouselCoverFilename,
  carouselImageKeys,
  hashCarouselSlideTexts,
  readCarouselSourceHashes,
  findOverflowingCarouselSlides, // #6078
  carouselCardsParagraphCountProblem, // #14019
  readCarouselCardParagraphs, // #11211
  resolveCarouselCardText, // #11211
  DAILY_CAROUSEL_BODY_SIZE, // #6078
  DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET, // #6078
} from "../../daily-carousel-card.ts"; // #6064
import { md5OfFile } from "../../shared/file-md5.ts"; // #6068
import { type UseMelhorPostConfigState } from "../../use-melhor-post.ts"; // #9568
import {
  readInstagramTestOverride,
  instagramTestOverridePath,
  type CarouselCtaOverride,
} from "../../instagram-test-override.ts"; // #8681
import {
  readCarouselKeepArtSafe,
  carouselKeepArtPath,
  CAROUSEL_KEEP_ART_FILENAME,
} from "../../carousel-keep-art.ts"; // #11210
import { readDestaqueCount } from "../stage-3.ts";
import { type PublicImageEntry, type PublicImagesJson } from "./_shared.ts";
import { checkUseMelhorCarouselOverflow } from "./use-melhor.ts";

/**
 * (#6064 item 1) O carrossel diário do Instagram (#6005 Parte B) rasteriza o
 * texto do `## d{N}` de `03-social.md` em 4 cards, no Stage 3 — e o editor
 * edita esse MESMO arquivo depois, no painel Revisão do Stage 4. Sem este
 * check, a legenda sai com o texto novo e a arte com o texto velho, sem
 * nenhum sinal: o post é publicado assim.
 *
 * Severity "error" NO CASO DE DIVERGÊNCIA, diferente do
 * `card-4x5-upload-missing` (warning) logo acima: aqui não é formato
 * degradado, é CONTEÚDO divergente do que o editor aprovou — mesma classe do
 * `social-hash-fresh` (#1413), que também bloqueia. O conserto é mecânico e
 * está na mensagem (regerar + re-subir). A mesma regra também emite
 * "warning" no caso sem carimbo (logo abaixo), então NÃO é uma regra que
 * bloqueia sempre — `check-invariants.ts` agrega por severidade da violação,
 * não por id de regra.
 *
 * Sem entrada no carimbo (edição anterior ao #6064, ou carimbo apagado) não
 * dá pra afirmar divergência — vira warning, nunca erro: bloquear o gate por
 * "não sei" seria pior que avisar.
 */
/**
 * #8681: override de teste do slide CTA (`_internal/instagram-test.json`),
 * lido sem lançar — o invariant reporta o arquivo malformado em vez de
 * derrubar o `check-invariants` inteiro. O override entra no carimbo
 * (`hashCarouselSlideTexts`) igual ao `gen-carousel-cards.ts`, senão toda
 * edição com override acusaria arte "stale" à toa.
 */
function readCtaOverrideSafe(editionDir: string): { ctaOverride: CarouselCtaOverride | null; error: string | null } {
  try {
    return { ctaOverride: readInstagramTestOverride(editionDir)?.cta_slide ?? null, error: null };
  } catch (e) {
    return { ctaOverride: null, error: (e as Error).message };
  }
}

export function checkCarouselCardsStale(editionDir: string): InvariantViolation[] {
  const socialPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialPath)) return [];

  const destaqueCount = readDestaqueCount(editionDir);
  const slots = destaqueCount === 2 ? (["d1", "d2"] as const) : (["d1", "d2", "d3"] as const);
  const slidesOnDiskDe = (d: string): boolean =>
    CAROUSEL_SLIDE_SLOTS.every((slot) => existsSync(resolve(editionDir, carouselSlideFilename(d, slot))));

  const section = extractSection(readFileSync(socialPath, "utf8"), "Social");
  if (!section) {
    // #6068: sem `# Social` não há texto pra comparar — mas sair calado com
    // slides no disco esconderia exatamente o caso "03-social.md perdeu a
    // estrutura e a arte pode estar velha". Avisa uma vez, não por destaque.
    const comSlides = slots.filter(slidesOnDiskDe);
    return comSlides.length > 0
      ? [
          {
            rule: "carousel-cards-stale",
            message:
              `03-social.md não tem a seção '# Social' — os slides do carrossel de ` +
              `${comSlides.join(", ")} existem no disco mas ` +
              `não há texto pra cruzar com o carimbo. Conferir a estrutura do arquivo antes de publicar; ` +
              `se ele foi editado à mão, re-rodar "npx tsx scripts/gen-carousel-cards.ts --edition-dir ${editionDir}".`,
            source_issue: "#6068",
            severity: "warning",
            file: socialPath,
          },
        ]
      : [];
  }

  const stored = readCarouselSourceHashes(editionDir);
  const violations: InvariantViolation[] = [];
  // #8681: JSON malformado é reportado por `carousel-text-overflow` (que roda
  // nos Stages 2 E 4 — pega mais cedo); aqui só se usa o override válido.
  const { ctaOverride } = readCtaOverrideSafe(editionDir);
  // #11210: exceção do editor (arte mantida). JSON malformado é reportado por
  // `carousel-text-overflow`; aqui, com erro, nenhuma exceção vale (`{}`).
  const { keepArt } = readCarouselKeepArtSafe(editionDir);
  // #11211: legenda só reparagrafada (mesmas palavras) segue a divisão em
  // cards gravada no render — a arte não está velha, só a quebra do post mudou.
  const storedParagraphs = readCarouselCardParagraphs(editionDir);

  for (const d of slots) {
    if (!slidesOnDiskDe(d)) continue; // destaque sem carrossel — publica single-image, nada a cruzar

    // #12094: mesmo texto que o gen rasteriza — `## d{N}-cards`, com fallback pra legenda.
    const dText = extractCarouselCardsBlock(section, d)?.text;
    if (!dText) continue; // sem bloco não há o que comparar (o gen já pulou este destaque)

    const atual = hashCarouselSlideTexts(resolveCarouselCardText(dText.trim(), storedParagraphs), ctaOverride);
    const carimbo = stored[d];

    if (!carimbo) {
      violations.push({
        rule: "carousel-cards-stale",
        message:
          `04-${d}-carousel-*.jpg existe mas _internal/.carousel-source-hash.json não tem entrada ` +
          `pra ${d} — não dá pra verificar se a arte do carrossel reflete o texto ATUAL de ` +
          `03-social.md. Se o social foi editado depois do Stage 3, o post sai com a arte velha. ` +
          `Fix: "npx tsx scripts/gen-carousel-cards.ts --edition-dir ${editionDir}" (regera só o que mudou).`,
        source_issue: "#6064",
        severity: "warning",
        file: socialPath,
      });
      continue;
    }

    if (carimbo !== atual) {
      const motivo = keepArt[d];
      if (motivo) {
        // #11210: o editor decidiu manter a arte antiga — avisa, nunca silencia.
        violations.push({
          rule: "carousel-cards-stale",
          message:
            `os slides de ${d} não refletem o texto atual de 03-social.md (carimbo ${carimbo}, atual ${atual}), ` +
            `mas a arte foi MANTIDA pelo editor em _internal/${CAROUSEL_KEEP_ART_FILENAME}: "${motivo}". ` +
            `O post sai com o texto novo na legenda e a arte existente no carrossel. Para voltar a regerar, ` +
            `remover '${d}' de _internal/${CAROUSEL_KEEP_ART_FILENAME}.`,
          source_issue: "#11210",
          severity: "warning",
          file: carouselKeepArtPath(editionDir),
        });
        continue;
      }
      violations.push({
        rule: "carousel-cards-stale",
        message:
          `os slides de ${d} não refletem o estado atual (carimbo ${carimbo}, atual ${atual}) — ` +
          `ou o 03-social.md mudou depois da geração, ou o FORMATO do card mudou (o carimbo cobre ` +
          `texto E layout desde o #6078, então uma edição rasterizada antes daquela mudança também ` +
          `cai aqui). Nos dois casos a arte publicada fica defasada, porque o texto está rasterizado ` +
          `na imagem. Fix (o mesmo para ambos): ` +
          `"npx tsx scripts/gen-carousel-cards.ts --edition-dir ${editionDir}" e depois ` +
          `"npx tsx scripts/upload-images-public.ts --edition-dir ${editionDir}" (o KV precisa da arte nova).`,
        source_issue: "#6064",
        severity: "error",
        file: socialPath,
      });
    }
  }
  return violations;
}

/**
 * (#6078 item 2) O corpo dos slides do carrossel diário tem tamanho FIXO
 * desde a decisão do editor de 24/08/2026 — o texto não encolhe mais pra
 * caber, e parágrafo que passa do limite é REESCRITO.
 *
 * `gen-carousel-cards.ts` já bloqueia isso no Stage 3. Este check existe pro
 * caminho que o Stage 3 não vê: o editor edita `03-social.md` no painel
 * Revisão DEPOIS da geração, e o gen não roda de novo sozinho. Nesse caso
 * `carousel-cards-stale` acusa a divergência e manda regerar — e a regeração
 * é que vai falhar, no meio do gate. Melhor dizer aqui, com o texto ainda na
 * mão do editor, exatamente qual parágrafo encurtar.
 *
 * Severity "error", mesma classe do `carousel-cards-stale` em divergência:
 * não é formato degradado, é conteúdo que não pode ser rasterizado como está.
 *
 * #11210: destaque listado em `_internal/carousel-keep-art.json` (arte mantida
 * pelo editor) E com os slides no disco vira "warning" citando o motivo — o
 * texto não vai ser rasterizado. O mesmo vale pra divergência em
 * `carousel-cards-stale`. Sem arte no disco a exceção não vale (nada a manter).
 */
export function checkCarouselTextOverflow(
  editionDir: string,
  /** #9568: injetável pra teste; default = `platform.config.json` do repo. */
  useMelhorConfig?: UseMelhorPostConfigState,
): InvariantViolation[] {
  const socialPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialPath)) return [];

  const section = extractSection(readFileSync(socialPath, "utf8"), "Social");
  if (!section) return []; // estrutura quebrada já é coberta por carousel-cards-stale

  const destaqueCount = readDestaqueCount(editionDir);
  const slots = destaqueCount === 2 ? (["d1", "d2"] as const) : (["d1", "d2", "d3"] as const);
  const violations: InvariantViolation[] = [];
  // #8681: lido 1x; malformado vira violação AQUI (este check roda nos
  // Stages 2 e 4 — o `instagram-test.json` quebrado é pego no Stage 2, não
  // só no gate). Nunca ignorado em silêncio.
  const { ctaOverride, error: overrideError } = readCtaOverrideSafe(editionDir);
  if (overrideError) {
    violations.push({
      rule: "carousel-text-overflow",
      message: `${overrideError} — corrigir ou remover o arquivo antes de gerar/publicar o carrossel.`,
      source_issue: "#8681",
      severity: "error",
      file: instagramTestOverridePath(editionDir),
    });
  }
  // #11210: exceção do editor (arte mantida) — malformada é reportada aqui
  // (Stages 2 e 4), nunca ignorada; com erro, nenhuma exceção é aplicada.
  const { keepArt, error: keepArtError } = readCarouselKeepArtSafe(editionDir);
  if (keepArtError) {
    violations.push({
      rule: "carousel-text-overflow",
      message: `${keepArtError} — corrigir ou remover o arquivo; enquanto isso nenhuma exceção de arte mantida vale.`,
      source_issue: "#11210",
      severity: "error",
      file: carouselKeepArtPath(editionDir),
    });
  }
  // #11211: o que se mede é o texto DOS CARDS — se a legenda só foi
  // reparagrafada, a divisão gravada no render, não a quebra nova do post.
  const storedParagraphs = readCarouselCardParagraphs(editionDir);
  for (const d of slots) {
    // #12094: mede o texto DOS CARDS (`## d{N}-cards`); edição anterior cai na legenda `## d{N}`.
    const cardsSrc = extractCarouselCardsBlock(section, d);
    if (!cardsSrc) continue;
    const dText = cardsSrc.text;
    const sectionId = cardsSrc.sectionId;
    const cardText = resolveCarouselCardText(dText.trim(), storedParagraphs);

    // #14019: `## d{N}-cards` com outra contagem que não 3 parágrafos. O gen
    // aborta nesse caso; aqui o editor fica sabendo antes do gate, com o texto
    // na mão. Arte mantida pelo editor (#11210, com slides no disco) não é
    // rasterizada de novo, então o aviso desce para warning.
    if (cardsSrc.source === "cards") {
      const problema = carouselCardsParagraphCountProblem(d, sectionId, cardText);
      if (problema) {
        const mantida = keepArt[d] && carouselSlidesOnDisk(editionDir, d);
        violations.push({
          rule: "carousel-text-overflow",
          message: mantida
            ? `${problema} A arte foi MANTIDA pelo editor em _internal/${CAROUSEL_KEEP_ART_FILENAME}: "${keepArt[d]}"; o carrossel publica com a arte existente.`
            : `${problema} Enquanto isso, "npx tsx scripts/gen-carousel-cards.ts --edition-dir ${editionDir}" FALHA.`,
          source_issue: "#14019",
          severity: mantida ? "warning" : "error",
          file: mantida ? carouselKeepArtPath(editionDir) : socialPath,
        });
        continue; // overflow mediria cards que o gen não vai montar
      }
    }

    const overflowing = findOverflowingCarouselSlides(cardText, ctaOverride);
    if (overflowing.length === 0) continue;

    const detalhe = overflowing.map((o) => `${o.slot} (${o.chars} chars, ${o.excessPx}px além)`).join("; ");
    const motivo = keepArt[d];
    if (motivo && carouselSlidesOnDisk(editionDir, d)) {
      // #11210: arte mantida pelo editor — o texto não vai ser rasterizado,
      // então não precisa caber no card. Avisa, nunca silencia.
      violations.push({
        rule: "carousel-text-overflow",
        message:
          `'## ${sectionId}' de 03-social.md tem ${overflowing.length} parágrafo(s) que não caberiam no card do carrossel ` +
          `(${detalhe}), mas a arte foi MANTIDA pelo editor em _internal/${CAROUSEL_KEEP_ART_FILENAME}: "${motivo}". ` +
          `O carrossel publica com a arte existente; o texto só vai na legenda.`,
        source_issue: "#11210",
        severity: "warning",
        file: carouselKeepArtPath(editionDir),
      });
      continue;
    }
    const semArte = motivo
      ? ` A exceção de _internal/${CAROUSEL_KEEP_ART_FILENAME} para ${d} não vale: a arte do carrossel no disco está incompleta ou ausente, então não há o que manter (e o gen-carousel-cards.ts vai tentar regerar e falhar).`
      : "";
    violations.push({
      rule: "carousel-text-overflow",
      message:
        `'## ${sectionId}' de 03-social.md tem ${overflowing.length} parágrafo(s) que não cabem no card do ` +
        `carrossel em ${DAILY_CAROUSEL_BODY_SIZE}px: ${detalhe}. O tamanho da fonte é fixo de propósito ` +
        `(#6078) — o conserto é REESCREVER o parágrafo pra ~${DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET} ` +
        `caracteres ou menos, aqui no painel Revisão, e depois rodar ` +
        `"npx tsx scripts/gen-carousel-cards.ts --edition-dir ${editionDir}" + ` +
        `"npx tsx scripts/upload-images-public.ts --edition-dir ${editionDir}". ` +
        `Enquanto isto não for feito, a geração dos slides FALHA — e se o gate for ignorado ` +
        `assim mesmo, o destaque publica como post single-image (fallback tudo-ou-nada).` +
        semArte,
      source_issue: "#6078",
      severity: "error",
      file: socialPath,
    });
  }
  violations.push(...checkUseMelhorCarouselOverflow(editionDir, section, socialPath, useMelhorConfig, ctaOverride));
  return violations;
}

/**
 * (#6740) Contraparte de `carousel-cards-stale`/`carousel-upload-incomplete`/
 * `carousel-upload-stale` pro caso que nenhum dos três cobre: os três só
 * comparam DIVERGÊNCIA entre estados que já existem (`if (!slidesOnDiskDe(d))
 * continue` — saída legítima quando SÓ aquele destaque não tem carrossel,
 * texto estourou o limite do #6078), então AUSÊNCIA TOTAL (0 dos N×4 arquivos
 * pra edição inteira) passa pelos três em silêncio, achando que "nada a
 * comparar" é o mesmo que "está tudo certo".
 *
 * Achado ao vivo #6740, edição 260830: `/diaria-3-imagens --no-gates`
 * (headless) nunca invocou `gen-carousel-cards.ts` — 0 dos 12 slides
 * existiam, `06-public-images.json` não tinha as entries, e
 * `check-invariants --stage 4` não acusou NADA porque os três checks de
 * carrossel viram "nenhum slide, nada a cruzar" pra cada destaque
 * isoladamente. Este check olha a edição INTEIRA: se `03-social.md` tem
 * texto de destaque (`## d{N}`) mas NENHUM dos destaques configurados tem os
 * 4 slides no disco, é sinal de que `gen-carousel-cards.ts` nunca rodou —
 * error, porque o carrossel de 5 slides é o formato OBRIGATÓRIO do Instagram
 * pra D1/D2/D3 (#6005 Parte B/#6078), não um extra opcional que pode faltar
 * em silêncio.
 *
 * Escopo deliberadamente estreito: só ausência TOTAL. Um destaque isolado sem
 * carrossel (os outros 1-2 têm) continua legítimo — best-effort por destaque,
 * já coberto pelo fallback single-image do publish — e não é assunto deste
 * check.
 */
export function checkCarouselCardsMissing(editionDir: string): InvariantViolation[] {
  const socialPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialPath)) return []; // Stage 2 nem rodou — não é assunto deste check

  const section = extractSection(readFileSync(socialPath, "utf8"), "Social");
  if (!section) return []; // estrutura quebrada já é coberta por carousel-cards-stale (warning)

  const destaqueCount = readDestaqueCount(editionDir);
  const slots = destaqueCount === 2 ? (["d1", "d2"] as const) : (["d1", "d2", "d3"] as const);

  const comTexto = slots.filter((d) => {
    const dText = extractDestaqueBlock(section, d);
    return dText !== null && dText.trim().length > 0;
  });
  if (comTexto.length === 0) return []; // nenhum destaque com texto — nada que devesse ter sido rasterizado

  const slidesOnDiskDe = (d: string): boolean =>
    CAROUSEL_SLIDE_SLOTS.every((slot) => existsSync(resolve(editionDir, carouselSlideFilename(d, slot))));

  if (comTexto.some(slidesOnDiskDe)) return []; // ao menos 1 destaque tem carrossel — não é ausência TOTAL

  return [
    {
      rule: "carousel-cards-missing",
      message:
        `NENHUM dos ${comTexto.length * CAROUSEL_SLIDE_SLOTS.length} slides do carrossel diário existe, ` +
        `pra NENHUM dos destaques com texto em 03-social.md (${comTexto.join(", ")}) — sinal de que ` +
        `"npx tsx scripts/gen-carousel-cards.ts --edition-dir ${editionDir}" nunca rodou nesta edição ` +
        `(ausência TOTAL, diferente de staleness/incompletude parcial — que carousel-cards-stale/ ` +
        `carousel-upload-incomplete/carousel-upload-stale já cobrem). Sem isto, os ${comTexto.length} ` +
        `destaque(s) publicariam no Instagram como post single-image, contrariando o formato de carrossel ` +
        `obrigatório (#6005 Parte B/#6078). Fix: rodar "npx tsx scripts/gen-carousel-cards.ts --edition-dir ` +
        `${editionDir}" e depois "npx tsx scripts/upload-images-public.ts --edition-dir ${editionDir}" antes do gate.`,
      source_issue: "#6740",
      severity: "error",
      file: socialPath,
    },
  ];
}

/**
 * (#6064 item 2) Contraparte do `card-4x5-upload-missing` pro carrossel: os 4
 * slides existem no disco mas alguma das 5 chaves do carrossel não está em
 * `06-public-images.json`. `resolveCarouselImageUrls` é tudo-ou-nada por
 * desenho — a falta de UMA URL derruba o post inteiro pro formato
 * single-image, em silêncio, e pode repetir por edições seguidas sem ninguém
 * notar (as specs de upload são `optional: true`).
 *
 * Warning-only, mesmo padrão do 4:5: o fallback é seguro, publica conteúdo
 * certo em formato antigo. O que não pode é ser invisível.
 */
export function checkCarouselUploadIncomplete(editionDir: string): InvariantViolation[] {
  const imagesPath = resolve(editionDir, "06-public-images.json");
  const destaqueCount = readDestaqueCount(editionDir);
  const slots = destaqueCount === 2 ? (["d1", "d2"] as const) : (["d1", "d2", "d3"] as const);

  let images: PublicImagesJson["images"] = {};
  if (existsSync(imagesPath)) {
    try {
      images = (JSON.parse(readFileSync(imagesPath, "utf8")) as PublicImagesJson).images ?? {};
    } catch {
      images = {}; // JSON inválido já é coberto por public-images-parseable
    }
  }

  const violations: InvariantViolation[] = [];
  for (const d of slots) {
    const slidesOnDisk = CAROUSEL_SLIDE_SLOTS.every((slot) =>
      existsSync(resolve(editionDir, carouselSlideFilename(d, slot))),
    );
    if (!slidesOnDisk) continue;

    const { cover, slides } = carouselImageKeys(d);
    const faltando = [cover, ...CAROUSEL_SLIDE_SLOTS.map((slot) => slides[slot])].filter(
      (key) => !hasUsableUrl(images?.[key]),
    );
    if (faltando.length === 0) continue;

    // A CAPA não é gerada por `gen-carousel-cards.ts` e não entra em
    // `slidesOnDisk` — se ela nem existe localmente, mandar re-rodar o upload
    // não conserta nada (achado do review do #6068: a mensagem afirmava "os 5
    // slides existem no disco" checando só 4, e apontava pro script errado).
    // A capa só entra na remediação quando é ELA que está faltando: mandar
    // gerar card 4:5 porque o arquivo local sumiu, enquanto o que falta é a
    // URL de um slide de parágrafo, aponta pro script errado (#6068).
    const capaFaltando = faltando.includes(cover);
    const coverOnDisk = existsSync(resolve(editionDir, carouselCoverFilename(d)));
    const fix =
      capaFaltando && !coverOnDisk
        ? `${carouselCoverFilename(d)} (a capa, slide 1) não existe no disco — gerar com ` +
          `"npx tsx scripts/gen-social-card-4x5.ts --edition-dir ${editionDir}" ANTES de re-rodar o upload`
        : `re-rodar "npx tsx scripts/upload-images-public.ts --edition-dir ${editionDir}" antes de publicar`;

    violations.push({
      rule: "carousel-upload-incomplete",
      message:
        `os 4 slides sem foto do carrossel de ${d} existem no disco mas 06-public-images.json ` +
        `não tem ${faltando.join(", ")} — publish-instagram.ts vai cair pro post single-image ` +
        `EM SILÊNCIO (carga tudo-ou-nada, resolveCarouselImageUrls). Fix: ${fix}.`,
      source_issue: "#6064",
      severity: "warning",
      file: imagesPath,
    });
  }
  return violations;
}

/**
 * (#6068) Critério único de "esta entry tem URL utilizável".
 * `carousel-upload-incomplete` e `carousel-upload-stale` cruzam exatamente as
 * MESMAS 5 chaves — com dois filtros diferentes, uma entry `{url: "   "}`
 * escapava dos dois (não é falsy pro segundo, é vazia pro primeiro).
 */
function hasUsableUrl(entry: PublicImageEntry | undefined): boolean {
  const url = entry?.url;
  return typeof url === "string" && url.trim().length > 0;
}

/**
 * (#6068, achado do review do #6064) `carousel-cards-stale` cobre a arte LOCAL
 * e `carousel-upload-incomplete` cobre a PRESENÇA da entry — nenhum dos dois
 * pega a arte JÁ SUBIDA estar velha.
 *
 * Sequência real: editor edita `03-social.md` no Stage 4 → `carousel-cards-stale`
 * acusa → editor roda SÓ o `gen-carousel-cards.ts` da mensagem e esquece o
 * `upload-images-public.ts`. Agora o carimbo local bate (stale limpo) e as 5
 * chaves seguem presentes (incomplete limpo) — mas apontam pras URLs
 * md5-versionadas do render ANTERIOR. Os dois gates passam verdes e o
 * Instagram recebe a legenda nova com a arte velha, que é exatamente o defeito
 * que o #6064 existe pra fechar.
 *
 * Cruza o `md5` que `upload-images-public.ts` grava por entry (#1418) contra o
 * md5 dos bytes locais AGORA — mesma função (`md5OfFile`) que o próprio
 * uploader usa pra decidir re-upload, então os dois lados nunca divergem de
 * critério. Entry sem `md5` (pré-#1418) vira warning: não dá pra verificar.
 */
export function checkCarouselUploadStale(editionDir: string): InvariantViolation[] {
  const imagesPath = resolve(editionDir, "06-public-images.json");
  if (!existsSync(imagesPath)) return []; // upload nunca rodou — é o `incomplete` que fala

  const destaqueCount = readDestaqueCount(editionDir);
  const slots = destaqueCount === 2 ? (["d1", "d2"] as const) : (["d1", "d2", "d3"] as const);

  let images: PublicImagesJson["images"] = {};
  try {
    images = (JSON.parse(readFileSync(imagesPath, "utf8")) as PublicImagesJson).images ?? {};
  } catch {
    return []; // JSON inválido já é coberto por public-images-parseable
  }

  const violations: InvariantViolation[] = [];
  for (const d of slots) {
    const slidesOnDisk = CAROUSEL_SLIDE_SLOTS.every((slot) =>
      existsSync(resolve(editionDir, carouselSlideFilename(d, slot))),
    );
    if (!slidesOnDisk) continue;

    const { cover, slides } = carouselImageKeys(d);
    const paresChave: Array<{ key: string; file: string }> = [
      { key: cover, file: carouselCoverFilename(d) },
      ...CAROUSEL_SLIDE_SLOTS.map((slot) => ({ key: slides[slot], file: carouselSlideFilename(d, slot) })),
    ];

    const desatualizados: string[] = [];
    const semMd5: string[] = [];
    const semArquivoLocal: string[] = [];
    const ilegiveis: string[] = [];
    for (const { key, file } of paresChave) {
      const entry = images?.[key];
      if (!hasUsableUrl(entry)) continue; // ausência é assunto do `carousel-upload-incomplete`
      const localPath = resolve(editionDir, file);
      if (!existsSync(localPath)) {
        // Só alcançável pra CAPA (os 4 slides passaram por `slidesOnDisk`).
        // URL publicada + arquivo local sumido não é coberto por NENHUM outro
        // check (`carousel-upload-incomplete` só olha URL ausente,
        // `card-4x5-upload-missing` desiste quando o arquivo não existe), então
        // sem isto a sumiço da única fonte de verdade local fica invisível.
        semArquivoLocal.push(key);
        continue;
      }
      if (!entry!.md5) {
        semMd5.push(key);
        continue;
      }
      // `check-invariants.ts` não tem try/catch POR REGRA: uma exceção aqui
      // derrubaria as ~30 outras regras do Stage 4 junto. Arquivo pode sumir
      // ou ficar preso entre o existsSync e a leitura (OneDrive, Studio
      // limpando temporário) — degradar pra "não deu pra verificar" é sempre
      // melhor que matar o gate inteiro.
      let localMd5: string;
      try {
        localMd5 = md5OfFile(localPath);
      } catch {
        ilegiveis.push(key);
        continue;
      }
      if (entry!.md5 !== localMd5) desatualizados.push(key);
    }

    if (desatualizados.length > 0) {
      violations.push({
        rule: "carousel-upload-stale",
        message:
          `a arte local de ${d} mudou depois do último upload — ${desatualizados.join(", ")} em ` +
          `06-public-images.json ainda aponta pra versão ANTERIOR (md5 diferente do arquivo em disco). ` +
          `O carrossel publicado sairia com a arte velha mesmo com os slides certos no disco. Fix: ` +
          `"npx tsx scripts/upload-images-public.ts --edition-dir ${editionDir}" (re-sobe só o que mudou).`,
        source_issue: "#6068",
        severity: "error",
        file: imagesPath,
      });
    }
    if (semArquivoLocal.length > 0) {
      violations.push({
        rule: "carousel-upload-stale",
        message:
          `${semArquivoLocal.join(", ")} tem URL publicada em 06-public-images.json mas o arquivo ` +
          `local correspondente de ${d} não existe mais — sem ele não dá pra verificar se o KV tem a ` +
          `arte atual (nenhum outro check cobre esta combinação). Conferir se o arquivo foi apagado ` +
          `por engano; se foi, regerar com "npx tsx scripts/gen-social-card-4x5.ts --edition-dir ${editionDir}" ` +
          `e re-subir antes de publicar.`,
        source_issue: "#6068",
        severity: "warning",
        file: imagesPath,
      });
    }
    if (ilegiveis.length > 0) {
      violations.push({
        rule: "carousel-upload-stale",
        message:
          `não foi possível LER o arquivo local de ${ilegiveis.join(", ")} (${d}) pra comparar o md5 ` +
          `— arquivo travado/removido entre a checagem e a leitura (sync do Drive, processo ` +
          `concorrente). Re-rodar "npx tsx scripts/check-invariants.ts --stage 4 --edition-dir ${editionDir}" ` +
          `depois que o sync assentar; persistindo, conferir o arquivo à mão.`,
        source_issue: "#6068",
        severity: "warning",
        file: imagesPath,
      });
    }
    if (semMd5.length > 0) {
      violations.push({
        rule: "carousel-upload-stale",
        message:
          `${semMd5.join(", ")} não tem campo md5 em 06-public-images.json (entry anterior ao #1418) — ` +
          `não dá pra verificar se o KV tem a arte ATUAL de ${d}. Se os slides foram regerados nesta ` +
          `edição, re-rodar "npx tsx scripts/upload-images-public.ts --edition-dir ${editionDir}".`,
        source_issue: "#6068",
        severity: "warning",
        file: imagesPath,
      });
    }
  }
  return violations;
}
