/**
 * Invariants de Stage 4 — Publicação (#1007 Fase 1).
 *
 * Última barreira antes de invocar publishers. Falha aqui = catastrófica
 * (publicação corrompida, broadcast vazio). Checks aqui devem ser strict.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { InvariantRule, InvariantViolation } from "./types.ts";
import { readMarker } from "../pipeline-state.ts";
import { hashFromApprovedFile } from "../social-source-hash.ts";
import { extractSection, extractDestaqueBlock } from "../extract-section.ts"; // #6064
import {
  CAROUSEL_SLIDE_SLOTS,
  carouselSlideFilename,
  carouselCoverFilename,
  carouselImageKeys,
  hashCarouselSlideTexts,
  readCarouselSourceHashes,
  findOverflowingCarouselSlides, // #6078
  DAILY_CAROUSEL_BODY_SIZE, // #6078
  DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET, // #6078
} from "../daily-carousel-card.ts"; // #6064
import { md5OfFile } from "../shared/file-md5.ts"; // #6068

import { lintIntroCount } from "../newsletter-count.ts";
import {
  extractEiaMirrorBlock,
  parseEiaMirrorBlock,
  parseEIA,
  fallbackEIA,
  extractBoxDivulgacao0,
  extractBoxDivulgacao1,
  extractBoxDivulgacao2,
  extractBoxDivulgacao3,
  readBoxDivulgacao0Image,
  readBoxDivulgacao1Image,
  readBoxDivulgacao2Image,
  readBoxDivulgacao3Image,
  readBoxDivulgacaoAltForSlot,
  readBoxDivulgacaoAltForFile, // #5457
  readBoxDivulgacaoRuntimeExcludedForSlot, // #4504
  pickErroIntencionalReveal, // #6734 — MESMA função que o renderer/check-stage2-invariants usam
} from "../newsletter-parse.ts";
import { checkUseMelhorTempo } from "../lint-checks/use-melhor-tempo.ts";
import {
  checkTitlePublisherSuffix,
  checkTitleTrailingPeriod,
} from "../lint-checks/title-normalization.ts";
import { checkNoTrailingEllipsis } from "../lint-checks/no-trailing-ellipsis.ts";
import { checkTitleMentionsIA } from "../lint-checks/ia-in-title.ts"; // #4825
import { isTruncatedSummary } from "../truncated-summary.ts";
import { sectionHeaderRegex } from "../section-naming.ts";
import {
  INLINE_LINK_ONLY_RE,
  URL_WITH_BALANCED_PARENS_RE_PART,
} from "../lint-checks/section-item-format.ts";
import {
  extractDestaqueUrls,
  extractPromptUrl,
} from "../../match-prompts-to-destaques.ts";
import { urlsMatch } from "../url-utils.ts";
import { readDestaqueCount } from "./stage-3.ts";
import {
  extractCurrentDeclarationFromMd,
  extractRevealFromFrontmatter,
  narrativeIsGenericPlaceholder,
  narrativeIsCatalogShaped,
  SECTION_HEADER,
} from "../../render-erro-intencional.ts";
import {
  loadIntentionalErrorJson,
  intentionalErrorJsonPath,
  scanWrongValueAdoption, // #7324
} from "../intentional-errors.ts";
import { checkHasNegativeImpactHighlight } from "./stage-1.ts"; // #3916, #3918

// #6336: usado só por checkKitFixtureAudit, pra localizar
// scripts/audit-kit-fixtures.ts a partir de scripts/lib/invariant-checks/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface PublicImageEntry {
  url?: string;
  file_id?: string;
  filename?: string;
  /** #1418: md5 dos bytes locais no momento do upload. Ausente em entries pré-#1418. */
  md5?: string;
}

interface PublicImagesJson {
  images?: Record<string, PublicImageEntry | undefined>;
}

/**
 * `06-public-images.json` deve ter URLs públicas pra d1, d2, d3
 * (1x1 cada — formato consumido por LinkedIn + Facebook). Sem isso,
 * publish-linkedin envia image_url=null e Make rejeita (DLQ incident 260508).
 * #2147: desde o fix, URLs d1/d2/d3 são KV Worker (não Drive uc?id).
 *
 * #2133/#2141: também valida d2_2x1/d3_2x1/cover (hero 2:1 consumidos pelo email
 * body via substitute-image-urls). Ausentes aqui = email sai com placeholders crus.
 * Cross-mode blind spot: social mode preenche d2/d3 mas não d2_2x1/d3_2x1; se
 * newsletter mode falhou silenciosamente, esse check pega antes do publish.
 *
 * Shape real (escrito por scripts/upload-images-public.ts):
 *   { images: { d1: { url, file_id, filename, mime_type } } }
 */
function checkPublicImagesPopulated(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "06-public-images.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "public-images-exists",
        message:
          `06-public-images.json ausente — upload-images-public.ts não rodou. ` +
          `Stage 4 LinkedIn vai falhar com image_url=null (DLQ incident #999).`,
        source_issue: "#999",
        severity: "error",
        file: path,
      },
    ];
  }
  let data: PublicImagesJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as PublicImagesJson;
  } catch (e) {
    return [
      {
        rule: "public-images-parseable",
        message: `06-public-images.json não parseável: ${(e as Error).message}`,
        source_issue: "#999",
        severity: "error",
        file: path,
      },
    ];
  }
  const violations: InvariantViolation[] = [];
  const images = data.images ?? {};

  // #2352: d3 URL only required when destaque_count == 3.
  const destaqueCount = readDestaqueCount(editionDir);
  const socialKeys = destaqueCount === 2 ? ["d1", "d2"] : ["d1", "d2", "d3"];

  // Social 1x1 keys — required for LinkedIn/Facebook (DLQ incident #999).
  for (const key of socialKeys) {
    const slot = images[key];
    const url = slot?.url;
    if (!url || typeof url !== "string" || url.trim().length === 0) {
      violations.push({
        rule: "public-images-populated",
        message: `06-public-images.json: images.${key}.url ausente ou vazio`,
        source_issue: "#999",
        severity: "error",
        file: path,
      });
    } else if (!/^https?:\/\//.test(url)) {
      violations.push({
        rule: "public-images-url-shape",
        message: `06-public-images.json: images.${key}.url="${url.slice(0, 50)}" não é URL válida`,
        source_issue: "#999",
        severity: "error",
        file: path,
      });
    }
  }

  // Newsletter hero 2x1 keys — required for email body substitution (#2133/#2141).
  // Absent → substitute-image-urls.ts writes literal {{IMG:04-d{N}-2x1.jpg}} and
  // exits 2. Warning (not error) so social-only runs are not blocked.
  // #2352: d3_2x1 only required when destaque_count == 3.
  const newsletterHeroKeys = destaqueCount === 2 ? ["cover", "d2_2x1"] : ["cover", "d2_2x1", "d3_2x1"];
  for (const key of newsletterHeroKeys) {
    const slot = images[key];
    const url = slot?.url;
    if (!url || typeof url !== "string" || url.trim().length === 0) {
      violations.push({
        rule: "public-images-newsletter-hero",
        message:
          `06-public-images.json: images.${key}.url ausente ou vazio — ` +
          `email body usa {{IMG:}} pra esta chave; ausente causa placeholder cru no HTML.`,
        source_issue: "#2133",
        severity: "warning",
        file: path,
      });
    }
  }

  return violations;
}

/**
 * #1413 (second attempt — hash marker em vez de URL match revert em #1431):
 * compara o hash dos highlights atuais (01-approved.json) contra o hash
 * cached em `_internal/.social-source-hash.json` (escrito por
 * merge-social-md.ts quando social.md foi gerado).
 *
 * Mismatch = highlights mudaram após social.md ser gerado — social ficou
 * stale e precisa re-dispatch do agent `social-writer` (#3991, reverte
 * #3486 — colapsou social-linkedin/social-facebook/social-instagram num
 * único agent) + re-run de merge-social-md.ts. Caso 260520: D1 trocou de
 * Karpathy pra Google I/O pós-Stage 2; social manteve hook Karpathy →
 * contradição cross-channel.
 *
 * Hash ausente = social.md gerado antes desse fix existir, ou merge-social-md
 * não rodou. Warning, não error — pipeline continua mas editor deve verificar.
 */
function checkSocialHashFresh(editionDir: string): InvariantViolation[] {
  const approvedPath = resolve(editionDir, "_internal", "01-approved.json");
  const socialPath = resolve(editionDir, "03-social.md");
  const hashPath = resolve(editionDir, "_internal", ".social-source-hash.json");

  if (!existsSync(approvedPath) || !existsSync(socialPath)) return [];

  if (!existsSync(hashPath)) {
    return [
      {
        rule: "social-hash-fresh",
        message:
          `_internal/.social-source-hash.json ausente — social.md gerado antes do #1413 ` +
          `OU merge-social-md.ts não rodou. Stale detection desabilitada pra essa edição.`,
        source_issue: "#1413",
        severity: "warning",
        file: hashPath,
      },
    ];
  }

  let cachedHash: string;
  try {
    const data = JSON.parse(readFileSync(hashPath, "utf8")) as { hash?: string };
    if (typeof data.hash !== "string") {
      return [
        {
          rule: "social-hash-fresh-parseable",
          message: `social-source-hash sem campo hash string`,
          source_issue: "#1413",
          severity: "error",
          file: hashPath,
        },
      ];
    }
    cachedHash = data.hash;
  } catch (e) {
    return [
      {
        rule: "social-hash-fresh-parseable",
        message: `social-source-hash não parseável: ${(e as Error).message}`,
        source_issue: "#1413",
        severity: "error",
        file: hashPath,
      },
    ];
  }

  let currentHash: string;
  try {
    currentHash = hashFromApprovedFile(approvedPath);
  } catch (e) {
    return [
      {
        rule: "social-hash-fresh",
        message: `falha calculando hash atual: ${(e as Error).message}`,
        source_issue: "#1413",
        severity: "error",
        file: approvedPath,
      },
    ];
  }

  if (cachedHash !== currentHash) {
    return [
      {
        rule: "social-hash-fresh",
        message:
          `Highlights mudaram após social.md ser gerado (hash: ${cachedHash} → ${currentHash}). ` +
          `Editor reestruturou destaques pós-Stage 2. Re-dispatch o agent ` +
          `social-writer (#3991) + re-run merge-social-md.ts E re-push pro Drive ` +
          `(drive-sync --mode push --files 03-social.md) antes de publicar — senão o Drive fica stale (#1828).`,
        source_issue: "#1413",
        severity: "error",
        file: socialPath,
      },
    ];
  }

  return [];
}

/**
 * #3825: o bloco `**É IA?**` em `02-reviewed.md` é só espelho/preview pro
 * editor — `extractContent` (newsletter-parse.ts) SEMPRE lê o crédito real
 * (legenda + "Resultado da última edição") de `01-eia.md`, nunca do mirror.
 * Nada garantia que os dois ficassem sincronizados: o editor corrige a
 * legenda em `02-reviewed.md` (fluxo natural — é a aba que o Studio abre),
 * `01-eia.md` nunca é tocado, e o HTML publicado sai com o crédito ANTIGO
 * sem nenhum aviso (incidente real 260722, erro intencional da legenda da
 * ave corrigido só em 02-reviewed.md — reproduzido em
 * `test/stage-4-eia-credit-synced.test.ts`).
 *
 * Reusa `parseEIA`/`fallbackEIA` (mesmos parsers de `extractContent`) dos
 * dois lados via `parseEiaMirrorBlock`/`extractEiaMirrorBlock` — garante que
 * qualquer divergência reportada é de CONTEÚDO, não de regra de parsing
 * diferente entre os dois lados.
 *
 * Sem bloco mirror em `02-reviewed.md` (edição legada, ou stitch ainda não
 * rodou) → `[]`, nada a comparar.
 *
 * **Severity "warning", não "error" (decisão conservadora, self-review
 * #3825).** A issue original pedia GATE-BLOCKING "ou pelo menos warn-loud —
 * nunca silencioso", deixando a escolha em aberto. `warning` ainda aparece
 * no `{violations_block}` do gate humano do Stage 4 (nunca silencioso —
 * `orchestrator-stage-4.md` linha 471 lista ⚠️ junto com ❌), mas não falha
 * o exit code. Motivo: o mirror em `02-reviewed.md` é inserido verbatim de
 * `01-eia.md` no stitch (Stage 2, `stitch-newsletter.ts::readEiaBlock`), mas
 * DEPOIS passa pelo humanizador + Clarice — ambos operam sobre o
 * `02-normalized.md`/`02-humanized.md` INTEIRO, sem exclusão de seção (ver
 * `orchestrator-stage-2.md` §2b/§2c) — enquanto `01-eia.md` nunca é
 * re-processado por nenhum dos dois. Já existe precedente no repo pra esse
 * risco: `verify-clarice-url-stability` (#873) trata "Clarice alterou texto"
 * como WARNING, não ERROR, porque é comportamento esperado do pipeline, não
 * necessariamente erro editorial. Uma correção de pontuação/grafia do
 * humanizador ou da Clarice na legenda (texto curto, não narrativo — mais
 * provável de sofrer edição mínima que os destaques em si) bastaria pra
 * disparar `error` TODA edição, mesmo sem nenhuma ação do editor — "crying
 * wolf" que treina o editor a ignorar o gate. `error` fica como follow-up se
 * a observação em produção mostrar que o mirror sai idêntico ao 01-eia.md
 * na prática (sem essa erosão), ou com um comparador tolerante a reescrita
 * leve.
 */
function checkEiaCreditSynced(editionDir: string): InvariantViolation[] {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  const eiaPath = resolve(editionDir, "01-eia.md");
  if (!existsSync(reviewedPath)) return [];

  const mirrorBlock = extractEiaMirrorBlock(readFileSync(reviewedPath, "utf8"));
  if (!mirrorBlock) return [];

  const real = existsSync(eiaPath)
    ? parseEIA(readFileSync(eiaPath, "utf8"), editionDir)
    : fallbackEIA(editionDir);
  const mirror = parseEiaMirrorBlock(mirrorBlock, editionDir);

  const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
  const normalizeLine = (s?: string) => (s ? normalize(s) : "");

  const violations: InvariantViolation[] = [];

  if (normalize(real.credit) !== normalize(mirror.credit)) {
    violations.push({
      rule: "eia-credit-synced",
      message:
        `Bloco **É IA?** de 02-reviewed.md diverge do crédito real em 01-eia.md ` +
        `(fonte que extractContent/render-newsletter-html.ts de fato usa — o bloco em ` +
        `02-reviewed.md é só um espelho pro editor, editá-lo NÃO afeta o email publicado). ` +
        `02-reviewed.md (cosmético): "${mirror.credit}". ` +
        `01-eia.md (real, vai pro email): "${real.credit}". ` +
        `Fix: editar 01-eia.md com a legenda correta — editar só 02-reviewed.md não tem ` +
        `efeito no email enviado (incidente 260722, #3825).`,
      source_issue: "#3825",
      severity: "warning",
      file: eiaPath,
    });
  }

  if (normalizeLine(real.prevResultLine) !== normalizeLine(mirror.prevResultLine)) {
    violations.push({
      rule: "eia-prev-result-line-synced",
      message:
        `Linha "Resultado da última edição" do bloco **É IA?** em 02-reviewed.md diverge ` +
        `de 01-eia.md (mesma fonte real do render, ver eia-credit-synced acima). ` +
        `02-reviewed.md: "${mirror.prevResultLine ?? "(ausente)"}". ` +
        `01-eia.md: "${real.prevResultLine ?? "(ausente)"}". ` +
        `Fix: editar 01-eia.md — editar só 02-reviewed.md não tem efeito no email enviado (#3825).`,
      source_issue: "#3825",
      severity: "warning",
      file: eiaPath,
    });
  }

  return violations;
}

/**
 * #1730 (follow-up do #1710): content-check da imagem de destaque vs highlight
 * atual. O #1710 trocou o upstream de staleness das imagens de `02-reviewed.md`
 * → `_internal/02-d{N}-prompt.md` (correto pro mtime), mas isso narrow-ou um
 * gap: se o editor **troca o artigo do D{N}** editando headline+URL direto no
 * `02-reviewed.md` (sem rodar reorder-destaques.ts nem regenerar a imagem), o
 * prompt fica descrevendo a cena antiga, o mtime do prompt não muda → nenhum
 * flag, e a imagem publicada é de outra história.
 *
 * Esta é a versão content-aware (análoga ao social-hash-fresh #1413 que cobre
 * o 03-social.md): pra cada D{N}, compara o `destaque_url:` do frontmatter do
 * prompt (#606) com a URL principal do D{N} atual no `02-reviewed.md`. Se
 * divergem, a imagem foi gerada pra outro artigo.
 *
 * Single-sided: o prompt já carrega `destaque_url` (escrito no Stage 2/3), então
 * não precisa write-side novo. Warning, não error — gap narrowed (só dispara em
 * article-swap manual via edição crua). Edições de wording da MESMA URL são
 * corretamente ignoradas; troca de URL (mesmo da mesma história) gera warning
 * benigno — editor confirma e segue.
 */
export interface ImageContentMismatch {
  slot: "d1" | "d2" | "d3";
  promptUrl: string;
  reviewedUrl: string;
}

/**
 * Pure: compara URLs dos prompts (por slot) com as URLs em ordem do reviewed.
 * `reviewedUrls[0]` = D1, `[1]` = D2, `[2]` = D3. Slot sem URL no reviewed é
 * ignorado (outros checks cobrem reviewed incompleto).
 *
 * Distinção de 3 estados no `promptUrls[slot]` (review #1832):
 *   - `string`    → prompt existe e tem `destaque_url` → compara.
 *   - `null`      → prompt **existe mas sem** `destaque_url` → `missingFrontmatter`.
 *   - `undefined` → prompt file **não existe** → fora de escopo (all-images-exist
 *     cobre); NÃO reportar como frontmatter ausente (era a conflação do #1832).
 *
 * Comparação via `urlsMatch` (canonicalize compartilhado, #523/#626): host
 * case-insensitive + strip de tracking params + trailing slash, mas **path
 * case-sensitive** (RFC 3986) — dois slugs que diferem só no case do path são
 * artigos diferentes e disparam mismatch corretamente.
 *
 * `haveFrontmatter` = quantos slots têm `destaque_url` — o caller usa pra
 * decidir se a edição é de formato atual (≥1) e só então avisar sobre os
 * faltantes (edição legada pré-#606 não spamma warning).
 */
export function findImageContentMismatches(
  promptUrls: { d1?: string | null; d2?: string | null; d3?: string | null },
  reviewedUrls: string[],
): {
  mismatches: ImageContentMismatch[];
  missingFrontmatter: Array<"d1" | "d2" | "d3">;
  haveFrontmatter: number;
} {
  const mismatches: ImageContentMismatch[] = [];
  const missingFrontmatter: Array<"d1" | "d2" | "d3"> = [];
  let haveFrontmatter = 0;
  const slots = ["d1", "d2", "d3"] as const;
  slots.forEach((slot, i) => {
    const reviewedUrl = reviewedUrls[i];
    if (reviewedUrl == null) return; // reviewed não tem esse slot — fora de escopo
    const promptUrl = promptUrls[slot];
    if (promptUrl === undefined) return; // prompt file ausente — all-images-exist cobre
    if (promptUrl === null) {
      missingFrontmatter.push(slot);
      return;
    }
    haveFrontmatter++;
    if (!urlsMatch(promptUrl, reviewedUrl)) {
      mismatches.push({ slot, promptUrl, reviewedUrl });
    }
  });
  return { mismatches, missingFrontmatter, haveFrontmatter };
}

function checkImageContentFresh(editionDir: string): InvariantViolation[] {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(reviewedPath)) return [];
  const reviewedUrls = extractDestaqueUrls(readFileSync(reviewedPath, "utf8"));
  if (reviewedUrls.length === 0) return [];

  const internalDir = resolve(editionDir, "_internal");
  // undefined = file ausente; null = file existe sem frontmatter; string = url.
  const promptUrls: { d1?: string | null; d2?: string | null; d3?: string | null } = {};
  let anyPrompt = false;
  for (const slot of ["d1", "d2", "d3"] as const) {
    const p = resolve(internalDir, `02-${slot}-prompt.md`);
    if (existsSync(p)) {
      anyPrompt = true;
      promptUrls[slot] = extractPromptUrl(readFileSync(p, "utf8"));
    }
  }
  // Nenhum prompt = imagens ainda não geradas (Stage 3 não rodou) — nada a checar.
  if (!anyPrompt) return [];

  const { mismatches, missingFrontmatter, haveFrontmatter } =
    findImageContentMismatches(promptUrls, reviewedUrls);

  const violations: InvariantViolation[] = [];
  for (const m of mismatches) {
    violations.push({
      rule: "image-content-fresh",
      message:
        `Imagem do ${m.slot.toUpperCase()} foi gerada pra outro artigo: prompt ` +
        `destaque_url=${m.promptUrl} ≠ destaque atual ${m.reviewedUrl}. Editor trocou ` +
        `o artigo direto no 02-reviewed.md sem regenerar a imagem. Re-rodar Stage 3 ` +
        `(image-generate) pra esse destaque, ou rodar reorder-destaques.ts se foi reorder.`,
      source_issue: "#1730",
      severity: "warning",
      file: resolve(internalDir, `02-${m.slot}-prompt.md`),
    });
  }
  // Só avisa frontmatter-ausente em edição de formato atual (≥1 prompt JÁ tem
  // destaque_url) — assim os faltantes são anomalia real, não edição legada
  // pré-#606 (que spammaria warning não-acionável em todo reprocessamento).
  if (missingFrontmatter.length > 0 && haveFrontmatter > 0) {
    violations.push({
      rule: "image-content-fresh",
      message:
        `frontmatter destaque_url ausente em ${missingFrontmatter
          .map((s) => `02-${s}-prompt.md`)
          .join(", ")} (outros prompts da edição já têm) — content-check da imagem ` +
        `desabilitado pra esse(s) destaque(s). writer-destaque deveria ter escrito ` +
        `o frontmatter #606; adicionar manualmente ou regenerar Stage 2.`,
      source_issue: "#1730",
      severity: "warning",
      file: resolve(internalDir, `02-${missingFrontmatter[0]}-prompt.md`),
    });
  }
  return violations;
}

/**
 * #1578: garante que intro line "Selecionamos os Z mais relevantes" bate com
 * a contagem real de items visíveis no `02-reviewed.md`. Stage 2 já tem este
 * lint, mas editor pode reorder / editar mid-Stage 4 (Drive pull, manual
 * tweak) e re-introduzir mismatch.
 *
 * Caso 260529: intro saiu "6 mais relevantes" quando real era 11 — bug em
 * countSelectedItems + edição editorial mid-stage. Sem re-check em stage 4,
 * email final foi enviado com mismatch.
 */
function checkIntroCountConsistent(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = lintIntroCount(md);
  if (result.ok) return [];
  return [
    {
      rule: "intro-count-consistent",
      message:
        `intro line declara ${result.claimed} items mas contagem real é ${result.actual}. ` +
        `Fix manual: editar "Selecionamos os ${result.claimed}" → "Selecionamos os ${result.actual}" ` +
        `em ${path}. Re-rodar sync-coverage-line só se quiser também recomputar X/Y ` +
        `(consome tmp-articles-raw.json — pode mudar mais que Z).`,
      source_issue: "#1578",
      severity: "error",
      file: path,
    },
  ];
}

/**
 * #2464 finding 2: rejeita items de USE MELHOR contendo o sentinel
 * `[DESCRIÇÃO PENDENTE]` — injetado pelo stitch quando não há `summary`.
 *
 * O sentinel satisfaz o check de tempo (o stitch já appenda `(5 min)` a ele),
 * então sem este guard poderia chegar ao leitor se o editor não notar.
 *
 * `[DESCRIÇÃO PENDENTE]` é escrito EXCLUSIVAMENTE por `renderUseMelhorSection`
 * (stitch-newsletter.ts) — não aparece em nenhuma outra seção. Portanto a busca
 * simples por substring no documento é suficiente e precisa, sem precisar escopar
 * ao bloco USE MELHOR linha a linha.
 *
 * severity: "error" (gate-blocking) — o editor DEVE preencher a descrição antes
 * da publicação. Um link sem descrição não agrega valor editorial.
 */
function checkUseMelhorSentinel(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  if (!md.includes("[DESCRIÇÃO PENDENTE]")) return [];

  // Contar ocorrências do sentinel para mensagem diagnóstica.
  const matches = md.match(/\[DESCRIÇÃO PENDENTE\]/g);
  const count = matches?.length ?? 1;

  return [
    {
      rule: "use-melhor-sentinel",
      message:
        `${count} item(ns) de USE MELHOR com descrição placeholder "[DESCRIÇÃO PENDENTE]" ` +
        `em ${path}. ` +
        `Fix: substituir "[DESCRIÇÃO PENDENTE]" pela descrição real de cada item antes de publicar ` +
        `(stitch injeta esse placeholder quando approved.json não tem "summary"; ` +
        `preencha o summary no JSON ou edite diretamente no 02-reviewed.md).`,
      source_issue: "#2464",
      severity: "error",
      file: path,
    },
  ];
}

/**
 * #2372/#2415/#2447: cada item de USE MELHOR precisa de estimativa de tempo na
 * descrição (`(15 min)` — formato canônico, ou `— 15 min` como atalho aceito).
 *
 * severity: "error" (gate-blocking, #2447 opção a) — `stitch-newsletter.ts` agora
 * injeta `(X min)` automaticamente (#2447 opção b), então o editor só chega aqui
 * sem tempo se editou a seção no Drive e removeu a estimativa.
 *
 * Roda no Stage 4 (PÓS-gate) onde o 02-reviewed.md já tem a estimativa injetada
 * pelo stitch. PRÉ-gate (Stage 2) o check permanece fora da STAGE_2_RULES porque
 * edições manuais do editor no Drive ou re-stitch podem alterar o conteúdo.
 */
function checkUseMelhorTempoConsistent(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = checkUseMelhorTempo(md);
  if (result.ok) return [];
  const items = result.errors
    .map((e) => `item ${e.item} (linha ${e.titleLine}): "${e.excerpt}"`)
    .join("; ");
  return [
    {
      rule: "use-melhor-tempo",
      message:
        `${result.errors.length} item(ns) de USE MELHOR sem estimativa de tempo: ${items}. ` +
        `Fix: adicionar "(X min)" ao fim de cada descrição em ${path} ` +
        `(stitch injeta automaticamente — pode ter sido removido na edição manual).`,
      source_issue: "#2447",
      severity: "error",
      file: path,
    },
  ];
}

/**
 * #2377/#2411/#2419/#6734 (rewrite): detecta quando a fonte do reveal para a PRÓXIMA
 * edição seria inválida — genérica, catalog-shaped (label interno "DESTAQUE N"), sem
 * o prefixo temporal correto, ou agramatical.
 *
 * Casos detectados:
 *   1. Narrativa "Nessa edição, …" no corpo é placeholder genérico (incidente #2377).
 *   2. (#2419 bug #2 fix) Narrativa no corpo ou no record (`_internal/intentional-error.json`,
 *      #3222) é catalog-shaped ("DESTAQUE N lista o Spotify…") — passa verde hoje, publica
 *      label interno.
 *   3. (#6734) `record.reveal` não é catálogo/genérico mas não começa com "Na última
 *      edição" nem contém palavra-gancho temporal reconhecida pelo renderer — caso real
 *      260828: "Nessa edição, escrevi ChatGTP…" (editor descrevendo a edição ATUAL, não
 *      fraseando pra edição SEGUINTE revelar). `check-stage2-invariants.ts` já bloqueia
 *      isso no dia da declaração (#6139); este é o backstop no Stage 4 pra qualquer edição
 *      manual do JSON feita depois daquele check já ter passado.
 *   4. (#2419) Sem campo `reveal` dedicado E sem fonte válida de narrative →
 *      reveal da próxima edição seria o fallback genérico seguro.
 *
 * severity: "warning" (lints permanecem warning — re-block para error é follow-up).
 *
 * Remediação: preencher `reveal` em `_internal/intentional-error.json` com prosa first-person.
 */
function checkNarrativeNotGenericPlaceholder(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  // (#3222) campos estruturados migraram de frontmatter YAML pra
  // `_internal/intentional-error.json` — não sincroniza mais com o Drive.
  const record = loadIntentionalErrorJson(intentionalErrorJsonPath(editionDir));

  const REMEDIATION =
    `Preencha o campo \`reveal\` em _internal/intentional-error.json com prosa ` +
    `first-person completa para o reveal público da próxima edição. ` +
    `Ex: "Na última edição, escrevi 1990 onde o correto é 1998."`;

  // 1. Verificação via extractCurrentDeclarationFromMd (#3494: SÓ corpo, nunca
  //    `record` — `record.reveal` descreve o erro desta edição fraseado para a
  //    PRÓXIMA edição revelar, não a declaração desta edição sobre si mesma;
  //    misturar os dois mascarava prosa genérica/placeholder no corpo sempre
  //    que `record.reveal` estivesse preenchido, produzindo inclusive a
  //    mensagem corrompida "Nessa edição, Na última edição, …").
  const extracted = extractCurrentDeclarationFromMd(md);
  if (extracted?.narrative) {
    // (self-review #3494) Ambos os checks abaixo (genérico + catalog-shaped)
    // são estruturalmente redundantes agora — extractCurrentDeclarationFromMd
    // já filtra as duas classes antes de retornar não-null, então
    // `extracted.narrative` nunca deveria bater aqui. Mantidos como
    // defense-in-depth intencional (mesma classe de guard que #2438/#633
    // já pratica no resto desta função) em vez de removidos — barato e
    // protege contra o filtro de extractCurrentDeclarationFromMd divergir
    // no futuro sem este check acompanhar.
    if (narrativeIsGenericPlaceholder(extracted.narrative)) {
      return [
        {
          rule: "narrative-not-generic-placeholder",
          message:
            `ERRO INTENCIONAL: a narrativa "Nessa edição, ${extracted.narrative}." ` +
            `é um placeholder genérico (contém frases do bloco de convite ao sorteio: ` +
            `"há um erro proposital", "responda este e-mail", "concorrer ao sorteio"). ` +
            `O reveal da PRÓXIMA edição vai publicar esse texto genérico — incidente #2377. ` +
            REMEDIATION,
          source_issue: "#2377",
          severity: "warning",
          file: path,
        },
      ];
    }
    if (narrativeIsCatalogShaped(extracted.narrative)) {
      return [
        {
          rule: "narrative-not-generic-placeholder",
          message:
            `ERRO INTENCIONAL: a narrativa "${extracted.narrative}" parece texto catálogo ` +
            `de terceira pessoa (label interno "DESTAQUE N"). ` +
            `O reveal da PRÓXIMA edição vai publicar o fallback seguro genérico em vez do erro real. ` +
            REMEDIATION,
          source_issue: "#2419",
          severity: "warning",
          file: path,
        },
      ];
    }
  }

  // 2. Quando extractCurrentDeclarationFromMd retorna null (filtrou texto
  //    genérico/catalog, ou não achou nenhuma linha "Nessa edição, …"),
  //    verificar diretamente o corpo do bloco ERRO INTENCIONAL. Isso cobre:
  //    editor escreveu só o convite genérico OU catalog-shaped no corpo —
  //    INDEPENDENTE de `record.reveal` estar preenchido (#3494): o corpo é
  //    lido pelos assinantes DESTA edição, `record.reveal` é usado pela
  //    PRÓXIMA — um não substitui o outro.
  if (!extracted) {
    const narrativeRe = /Nessa\s+edi[çc][ãa]o,\s+([^\n]+?)\.\s*(?:\n|$)/i;
    let block = md;
    const headerIdx = md.indexOf(SECTION_HEADER);
    if (headerIdx !== -1) {
      const afterHeader = md.slice(headerIdx);
      const nextSepRe = /\n---\s*\n|\n\*\*[🎁🙋📰🚀🔬🇧🇷🛠️📦📈💡🎭⚖️📊💬🏭🔐]/;
      const nextSepMatch = afterHeader.match(nextSepRe);
      block = nextSepMatch !== null && nextSepMatch.index !== undefined
        ? afterHeader.slice(0, nextSepMatch.index)
        : afterHeader;
    }
    const nm = block.match(narrativeRe);
    if (nm) {
      const bodyNarrative = nm[1].trim();
      if (!/^\{PREENCHER/i.test(bodyNarrative)) {
        if (narrativeIsGenericPlaceholder(bodyNarrative)) {
          return [
            {
              rule: "narrative-not-generic-placeholder",
              message:
                `ERRO INTENCIONAL: a linha do corpo "Nessa edição, ${bodyNarrative}." ` +
                `é um placeholder genérico. O reveal da PRÓXIMA edição não terá fonte válida. ` +
                REMEDIATION,
              source_issue: "#2411",
              severity: "warning",
              file: path,
            },
          ];
        }
        // (#2419 bug #2 fix) catalog-shaped no corpo → emitir warning
        if (narrativeIsCatalogShaped(bodyNarrative)) {
          return [
            {
              rule: "narrative-not-generic-placeholder",
              message:
                `ERRO INTENCIONAL: a linha do corpo "Nessa edição, ${bodyNarrative}." ` +
                `é texto catálogo de terceira pessoa (label interno "DESTAQUE N"). ` +
                `O reveal da PRÓXIMA edição usará o fallback seguro genérico. ` +
                REMEDIATION,
              source_issue: "#2419",
              severity: "warning",
              file: path,
            },
          ];
        }
      }
    }
  }

  // F3 (#633): verifica o campo `reveal` do frontmatter quanto a conteúdo catalog-shaped.
  // Se o editor copiar `description` (catálogo, ex: 'DESTAQUE 2 lista...') para dentro de
  // `reveal`, o Stage 4 ficaria silencioso sem esta checagem.
  // severity: warning (decisão editorial 260619 — lints ficam warning).
  //
  // (#3494) `extracted` (corpo) e `reveal` (record) são fontes ORTOGONAIS desde
  // o split de extractCurrentDeclarationFromMd/extractPreviousRevealFromRecord
  // — `extracted` nunca carrega mais um campo `.reveal` derivado do record, então
  // este check roda SEMPRE, independente do corpo já ter (ou não) uma declaração
  // válida. Isso é o que corrige o cegamento original: `record.reveal` catalog/
  // genérico agora é sinalizado mesmo quando o corpo também está com problema
  // (que já terá sido sinalizado antes, no passo 1/2 acima).
  const reveal = extractRevealFromFrontmatter(record);
  if (reveal) {
    if (narrativeIsCatalogShaped(reveal)) {
      return [
        {
          rule: "narrative-not-generic-placeholder",
          message:
            `ERRO INTENCIONAL: o campo \`intentional_error.reveal\` contém texto catálogo ` +
            `de terceira pessoa (label interno "DESTAQUE N" ou similar): "${reveal.slice(0, 80)}". ` +
            `O reveal da PRÓXIMA edição usará o fallback seguro genérico em vez do erro real. ` +
            REMEDIATION,
          source_issue: "#2419",
          severity: "warning",
          file: path,
        },
      ];
    }
    if (narrativeIsGenericPlaceholder(reveal)) {
      return [
        {
          rule: "narrative-not-generic-placeholder",
          message:
            `ERRO INTENCIONAL: o campo \`intentional_error.reveal\` contém texto genérico ` +
            `(placeholder do convite ao sorteio): "${reveal.slice(0, 80)}". ` +
            `O reveal da PRÓXIMA edição usará o fallback seguro genérico em vez do erro real. ` +
            REMEDIATION,
          source_issue: "#2419",
          severity: "warning",
          file: path,
        },
      ];
    }
  }

  // #6734: `reveal` pode passar limpo pelas 2 checagens acima (não é catálogo,
  // não é o placeholder genérico do convite ao sorteio) e AINDA assim não
  // começar com o prefixo temporal correto — caso real 260828:
  // "Nessa edição, escrevi ChatGTP..." (editor pensando na edição ATUAL,
  // não escrevendo pra edição SEGUINTE revelar). `check-stage2-invariants.ts`
  // já valida isso no Stage 2 (mesmo dia da declaração, #6139) — este é o
  // BACKSTOP no Stage 4 (mesma reincidência de #2419/#3494: `record.reveal`
  // pode ser editado depois do Stage 2 já ter passado, sem re-rodar aquele
  // check), pra pegar antes do publish, não só quando a edição SEGUINTE
  // tentar renderizar e o box de reveal sumir silenciosamente.
  if (reveal && pickErroIntencionalReveal(reveal) === null) {
    return [
      {
        rule: "reveal-temporal-prefix",
        message:
          `ERRO INTENCIONAL: o campo \`intentional_error.reveal\` não começa com ` +
          `"Na última edição" nem contém palavra-gancho temporal reconhecida pelo ` +
          `renderer (último/anterior/passado/ontem/edições): "${reveal.slice(0, 80)}". ` +
          `A edição SEGUINTE copia este texto verbatim e o box de reveal do ERRO ` +
          `INTENCIONAL não será renderizado, silenciosamente (#6139/#6734). ` +
          `Reescreva \`reveal\` em _internal/intentional-error.json começando com ` +
          `"Na última edição, ...".`,
        source_issue: "#6734",
        severity: "warning",
        file: path,
      },
    ];
  }

  // (#2438 Item 2 — caso 3) Sem campo `reveal` dedicado E sem fonte válida de narrative
  // (extracted=null) → o reveal da PRÓXIMA edição cairia no fallback seguro genérico.
  // Emitir warning NÃO-BLOCKING quando o MD declara um bloco ERRO INTENCIONAL (o
  // editor está usando o recurso) mas não preencheu nenhuma fonte válida de reveal.
  // severity: warning — nunca blocking (decisão editorial, fora de escopo #2438).
  if (!extracted && !reveal && md.includes(SECTION_HEADER)) {
    return [
      {
        rule: "narrative-not-generic-placeholder",
        message:
          `ERRO INTENCIONAL: sem campo \`reveal\` dedicado E sem fonte válida de narrative ` +
          `no corpo ou frontmatter. O reveal da PRÓXIMA edição usará o fallback seguro genérico ` +
          `("Na última edição, escondemos um erro proposital...") em vez de descrever o erro real. ` +
          REMEDIATION,
        source_issue: "#2438",
        severity: "warning",
        file: path,
      },
    ];
  }

  return [];
}

/**
 * #7243: detecta o item PORTADOR do erro intencional sumindo do texto final —
 * incidente real: edição 260902, item de RADAR com "Anthropik" (erro declarado
 * em `_internal/intentional-error.json`) foi removido pelo editor numa poda
 * NORMAL do RADAR (7 → 3 itens) dentro do gate do Stage 4. Nada acusou —
 * `checkNarrativeNotGenericPlaceholder` acima valida só a PROSA do reveal
 * (`Nessa edição, …`/`reveal`), nunca cruza contra o texto publicado. O reveal
 * da edição SEGUINTE ia afirmar pros assinantes que um erro existia quando não
 * existia mais — desinformação publicada, concurso "ache o erro" quebrado em
 * silêncio, alocação de número de sorteio contaminada (ver corpo da #7243).
 *
 * O que TORNA isso verificável mecanicamente: `wrong_value` (#7243, irmão de
 * `correct_value`) — a grafia/valor ERRADO efetivamente plantado, não o valor
 * corrigido. Buscar por `correct_value` não serve: é justamente o texto que o
 * item CORRIGIDO teria (guard ingênuo que procurasse `correct_value` no MD
 * passaria sempre, como o corpo da issue observa).
 *
 * Duas saídas quando o guard acusa (mensagem de erro nomeia as duas, #7243
 * item 3 — "mensagem acionável"): (a) replantar o erro em outro item do texto
 * atual, ou (b) declarar a edição sem erro (`{"no_error": true}`, suporte já
 * existente desde #2016/#2037 — ver `loadIntentionalErrorJson`).
 *
 * Roda DEPOIS de qualquer edição do editor no gate — é o único ponto onde a
 * verificação vale (a janela entre "erro plantado no Stage 2" e "editor podou
 * o RADAR no Stage 4" não tinha guarda nenhuma). O call site que fecha essa
 * janela de fato — reinvocar só esta regra imediatamente antes de escrever o
 * sentinel de Stage 4, cobrindo o fast-path do painel Studio (#6444) que pula
 * o loop `sim/ajustar` inteiro — vive em `orchestrator-stage-4.md` §4e, não
 * aqui (esta função é só o pure check; o card mecânico completo, incluindo
 * QUANDO ele roda, é responsabilidade do playbook).
 *
 * Severidade dupla, por design:
 *   - `error` (GATE-BLOCKING) quando `wrong_value` está declarado e NÃO
 *     aparece mais em `02-reviewed.md` — o caso real do incidente.
 *   - `warning` quando há erro declarado (não `no_error`) mas `wrong_value`
 *     está ausente/placeholder — não dá pra verificar mecanicamente, mas
 *     bloquear TODA edição anterior ao #7243 (campo novo, opcional por
 *     decisão de escopo — ver PR #7243) seria travar o pipeline por uma
 *     mudança de schema que o editor ainda não adotou o hábito de preencher.
 *
 * Match verbatim (substring simples, case-sensitive, sem trim de acentuação):
 * a essência de um erro ortográfico/factual É a grafia exata plantada —
 * normalizar case ou acentos esconderia justamente o tipo de erro mais comum
 * (ortográfico) que o incidente real envolveu ("Anthropik" ⊄ "anthropik").
 *
 * Falso-negativo conhecido, registrado e não corrigido aqui (#7243 review):
 * `md.includes(wrongValue)` sem escopo pode achar `wrongValue` em outro lugar
 * do texto que não o item declarado — plausível quando `wrong_value` é CURTO
 * ou GENÉRICO o bastante pra ocorrer por acaso (categorias `numeric`,
 * `version_inconsistency`, `data`: ex. `wrong_value: "5"` batendo num número
 * qualquer de outro destaque). O caso concreto do incidente (`"Anthropik"`,
 * categoria `ortografico`) não sofre disso — é específico o bastante pra só
 * bater no item certo. Escopar o match ao item/seção declarada em `location`
 * fecharia o gap, mas exigiria parsear `location` de volta pra uma região do
 * MD (formato livre, "DESTAQUE 2, parágrafo 1") — fora de escopo desta PR.
 */
function checkIntentionalErrorPresentInFinal(
  editionDir: string,
  // #7324: injetável em teste — produção nunca passa (default = pai de
  // editionDir, tipicamente `data/editions/`); testes injetam um diretório
  // isolado pra não contar edições vizinhas de outros testes/processos
  // rodando concorrentemente no mesmo tmpdir do OS.
  editionsRootDir?: string,
): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];

  const jsonPath = intentionalErrorJsonPath(editionDir);
  const record = loadIntentionalErrorJson(jsonPath);
  if (!record) return []; // nada declarado ainda — check-stage2-invariants.ts é dono desse gap

  // #2016/#2037: edição sem erro intencional é um estado legítimo — nada a verificar.
  if (record.no_error === true) return [];

  const md = readFileSync(path, "utf8");
  // Só relevante quando a edição de fato declara um erro no corpo publicado.
  // NÃO é a mesma condição do último branch de checkNarrativeNotGenericPlaceholder
  // (linha ~843 acima, que é `!extracted && !reveal && md.includes(SECTION_HEADER)`
  // — um AND de 3 termos usado pra detectar "sem NENHUMA fonte válida de reveal").
  // Aqui o objetivo é mais amplo — "existe declaração de erro pra verificar,
  // seja qual for a forma" —, então é um OR de 2: presença do header da seção
  // (cobre a edição que zerou a narrativa mas manteve o bloco) OU uma
  // declaração válida extraída do corpo (`extractCurrentDeclarationFromMd`
  // já filtra placeholder/catalog-shaped, então != null implica declaração real).
  const hasDeclaredError = md.includes(SECTION_HEADER) || extractCurrentDeclarationFromMd(md) !== null;
  if (!hasDeclaredError) return [];

  const wrongValue = (record.wrong_value ?? "").trim();
  if (!wrongValue || /^\{PREENCHER/i.test(wrongValue)) {
    // #7324: conta quantas edições (histórico completo em editionsRootDir)
    // declaram erro sem `wrong_value` — a decisão de tornar o campo
    // obrigatório é do editor (fica aberta), mas essa contagem tira o "opcional
    // vira permanente por inércia" da lista de riscos silenciosos: com o
    // número exposto aqui, toda vez que o warning dispara, dá pra ler a
    // adoção sem precisar de auditoria manual.
    const rootDir = editionsRootDir ?? dirname(resolve(editionDir));
    const { totalDeclared, missingWrongValue } = scanWrongValueAdoption(rootDir);
    const adoptionNote =
      totalDeclared > 0
        ? ` [instrumentação #7324: ${missingWrongValue}/${totalDeclared} edição(ões) com erro ` +
          `declarado ainda sem \`wrong_value\` — inclui esta.]`
        : "";
    return [
      {
        rule: "intentional-error-present-in-final",
        message:
          `ERRO INTENCIONAL: campo \`wrong_value\` ausente/placeholder em ${jsonPath} — não é ` +
          `possível verificar mecanicamente se o item que carrega o erro plantado ainda está ` +
          `presente em 02-reviewed.md (uma poda de RADAR no gate pode removê-lo sem nenhum ` +
          `aviso — incidente real: edição 260902, #7243). Preencha \`wrong_value\` com a ` +
          `grafia/valor efetivamente ERRADO plantado no texto (ex: "Anthropik", não "Anthropic" ` +
          `— esse é o \`correct_value\`).${adoptionNote}`,
        source_issue: "#7243",
        severity: "warning",
        file: jsonPath,
      },
    ];
  }

  if (!md.includes(wrongValue)) {
    return [
      {
        rule: "intentional-error-present-in-final",
        message:
          `ERRO INTENCIONAL: o valor plantado "${wrongValue}" (declarado em ${jsonPath}) NÃO ` +
          `aparece mais em 02-reviewed.md — o item que carregava o erro foi removido ou reescrito ` +
          `após a declaração, provavelmente numa poda do gate (incidente real: edição 260902, ` +
          `RADAR podado de 7 pra 3 itens levou junto o item com "Anthropik" — #7243). Publicar ` +
          `assim faz o reveal da PRÓXIMA edição afirmar um erro que não existe mais — desinformação ` +
          `publicada, concurso "ache o erro" quebrado em silêncio. Fix: (a) replantar o erro em ` +
          `outro item do texto atual e atualizar \`wrong_value\`/\`correct_value\`/\`location\` ` +
          `de acordo, OU (b) declarar a edição sem erro — gravar {"no_error": true} em ${jsonPath} ` +
          `(sobrescreve os demais campos). Repetir esta checagem até exit 0 antes de aprovar o gate.`,
        source_issue: "#7243",
        severity: "error",
        file: path,
      },
    ];
  }

  return [];
}

/**
 * #2596: detecta itens de seção secundária (LANÇAMENTOS/RADAR/USE MELHOR)
 * cuja descrição vem truncada de `og:description` — terminando em reticências
 * (…/...) com palavra pendente (conjunção/preposição/artigo) antes delas.
 *
 * Ação: warning (não bloqueante). O editor decide se reescreve a descrição ou
 * aceita o item assim. Alinhado ao padrão "flag não DROP" do repo.
 *
 * Seções É IA? e VÍDEOS são excluídas — formato próprio sem descrição inline.
 */
const TARGET_SECONDARY_SECTION_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?`,
  { capture: "none", flags: "u" },
);
const ANY_SECTION_HEADER_RE_S4 = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|V[ÍI]DEOS?|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?|DESTAQUES?`,
  { capture: "none", flags: "u" },
);
// Formato canônico (link + descrição na mesma linha) com captura da descrição.
// Usa URL_WITH_BALANCED_PARENS_RE_PART (#2413/#2596) pra tolerar URLs Wikipedia
// `/wiki/X_(model)` — `[^\s)]+` simples pararia no 1º `)` e o item escaparia o check.
const INLINE_LINK_WITH_TEXT_RE = new RegExp(
  String.raw`^\s*\*{0,2}\s*\[[^\]]+\]\(${URL_WITH_BALANCED_PARENS_RE_PART}\)\*{0,2}\s+(.+)$`,
  "u",
);

function checkTruncatedSecondaryItemSummary(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  const violations: InvariantViolation[] = [];
  let currentSection: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    if (TARGET_SECONDARY_SECTION_RE.test(t)) {
      currentSection = t.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
      continue;
    }
    if (ANY_SECTION_HEADER_RE_S4.test(t) || /^(?:\*\*)?DESTAQUE\s+\d+/.test(t)) {
      currentSection = null;
      continue;
    }
    if (t === "---") {
      currentSection = null;
      continue;
    }
    if (!currentSection) continue;

    // Formato canônico: link + texto na mesma linha — checar texto inline
    const inlineMatch = raw.match(INLINE_LINK_WITH_TEXT_RE);
    if (inlineMatch) {
      const desc = inlineMatch[1].trim();
      if (isTruncatedSummary(desc)) {
        violations.push({
          rule: "truncated-secondary-item-summary",
          message:
            `Seção ${currentSection} linha ${i + 1}: descrição parece truncada (termina em reticências ` +
            `com palavra pendente): "${desc.slice(-60)}". ` +
            `Origem provável: og:description truncada na fonte. ` +
            `Fix: reescrever a descrição ou aceitar o item com ressalva editorial.`,
          source_issue: "#2596",
          severity: "warning",
          file: path,
          line: i + 1,
        });
      }
      continue;
    }

    // Formato de 2 linhas: link sozinho + próxima linha é a descrição
    if (INLINE_LINK_ONLY_RE.test(raw)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length) {
        const descLine = lines[j].trim();
        // Só checar se a próxima linha é texto simples (não é outro link nem header)
        if (
          descLine &&
          !INLINE_LINK_ONLY_RE.test(lines[j]) &&
          !ANY_SECTION_HEADER_RE_S4.test(descLine) &&
          descLine !== "---"
        ) {
          if (isTruncatedSummary(descLine)) {
            violations.push({
              rule: "truncated-secondary-item-summary",
              message:
                `Seção ${currentSection} linha ${j + 1}: descrição parece truncada (termina em reticências ` +
                `com palavra pendente): "${descLine.slice(-60)}". ` +
                `Origem provável: og:description truncada na fonte. ` +
                `Fix: reescrever a descrição ou aceitar o item com ressalva editorial.`,
              source_issue: "#2596",
              severity: "warning",
              file: path,
              line: j + 1,
            });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * #2693 item 3: registro dos 2 lints de título (#2664 sufixo de veículo,
 * #2672 ponto final) em `invariant-checks/`. Antes rodavam como invocação
 * CLI separada em `orchestrator-stage-4.md` (`lint-newsletter-md.ts --check
 * title-publisher-suffix`/`title-trailing-period`) — funcionais, mas fora do
 * registry, então invisíveis em `docs/editorial-invariants.md`. Severity
 * "warning" preserva o comportamento atual (backstop deliberadamente amplo,
 * WARN-ONLY — ver docstring de `checkTitlePublisherSuffix`/
 * `checkTitleTrailingPeriod` em lint-checks/title-normalization.ts).
 * A invocação CLI direta no orchestrator continua existindo (não removida
 * nesta passada) — este registro é só pra visibilidade/doc-gen.
 *
 * #2715 item 3: até aqui, a invocação CLI (`lint-newsletter-md.ts --check
 * title-publisher-suffix`/`title-trailing-period`) saía com `process.exit(1)`
 * + `❌` em caso de match — inconsistente com a doc WARN-ONLY acima e com a
 * severity "warning" deste registry, podendo levar o orchestrator LLM a
 * bloquear o gate indevidamente ao ver exit não-zero. O CLI foi corrigido pra
 * sempre sair 0 (`⚠️` em vez de `❌`), alinhado a este registry.
 */
function checkTitlePublisherSuffixInvariant(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = checkTitlePublisherSuffix(md);
  if (result.ok) return [];
  return result.errors.map((e) => ({
    rule: "title-publisher-suffix",
    message:
      `Título com sufixo de veículo residual (linha ${e.line}): "${e.title}" ` +
      `(separador ${e.separator}, sufixo "${e.suffix}"). ` +
      `Verificar se é veículo real ou falso-positivo (backstop amplo, sem allowlist) — ` +
      `ver docstring de checkTitlePublisherSuffix.`,
    source_issue: "#2664",
    severity: "warning",
    file: path,
    line: e.line,
  }));
}

function checkTitleTrailingPeriodInvariant(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = checkTitleTrailingPeriod(md);
  if (result.ok) return [];
  return result.errors.map((e) => ({
    rule: "title-trailing-period",
    message:
      `Título termina com ponto final único (linha ${e.line}): "${e.title}". ` +
      `Manchetes não terminam em ponto — remover manualmente se não for reticências.`,
    source_issue: "#2672",
    severity: "warning",
    file: path,
    line: e.line,
  }));
}

/**
 * #4825: título de DESTAQUE menciona "IA"/"AI"/"inteligência artificial".
 * WARN-ONLY por decisão do editor — há exceções legítimas (manchete sobre a
 * categoria em si, ambiguidade real, nome próprio/citação/nome de produto,
 * ver `context/editorial-rules.md` seção 5) frequentes o bastante pra um
 * lint bloqueante virar atrito toda edição. Ver docstring de
 * `checkTitleMentionsIA` em `lint-checks/ia-in-title.ts` pro racional
 * completo e o escopo (só títulos de DESTAQUE, não seções secundárias).
 */
function checkTitleMentionsIaInvariant(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = checkTitleMentionsIA(md);
  if (result.ok) return [];
  return result.errors.map((e) => ({
    rule: "title-mentions-ia",
    message:
      `DESTAQUE ${e.destaque} (${e.category}) linha ${e.line}: título menciona "${e.matched}": "${e.title}". ` +
      `A newsletter é sobre IA — o termo raramente carrega informação nova no título; prefira nomear o agente ` +
      `concreto (empresa, modelo, produto). Exceção legítima? Ver context/editorial-rules.md seção 5.`,
    source_issue: "#4825",
    severity: "warning",
    file: path,
    line: e.line,
  }));
}

/**
 * #2881: backstop pra `sanitizeTrailingEllipsis` (roda em `enrich-inbox-
 * articles.ts`, Stage 1). Diferente de `checkTruncatedSecondaryItemSummary`
 * (#2596, que só flagra quando o texto ANTES da reticência parece ter
 * "palavra pendente" e tem carve-outs para idiomas de suspense/fechamento
 * intencional), este check é deliberadamente MAIS AMPLO: QUALQUER descrição
 * de item secundário terminando em `…`/`...` é flagrada, sem exceção — a
 * regra do #2881 é "nunca publicar descrição terminando em reticência".
 * Ambos os checks podem disparar na mesma linha; isso é esperado (registros
 * independentes, WARN-ONLY).
 */
function checkNoTrailingEllipsisInvariant(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = checkNoTrailingEllipsis(md);
  if (result.ok) return [];
  return result.errors.map((e) => ({
    rule: "no-trailing-ellipsis",
    message:
      `Seção ${e.section} linha ${e.line}: descrição do item "${e.titleExcerpt}" termina em reticências ` +
      `("...${e.descriptionExcerpt}"). Provável causa: a fonte truncou a própria meta-description com "…" ` +
      `e ela vazou verbatim — não é truncamento nosso. Fix: reescrever a descrição em ` +
      `02-reviewed.md antes de aprovar.`,
    source_issue: "#2881",
    severity: "warning",
    file: path,
    line: e.line,
  }));
}

/**
 * #2878: quando `scripts/fetch-newsletter-threads.ts` (Stage 0 passo 0b-bis)
 * falha por auth/rede, `inject-inbox-urls.ts` grava `capture_failed: true`
 * (+ `capture_error`) em `.marker-inject-inbox-urls.json` em vez de deixar
 * `captured_newsletter_count: 0` indistinguível de "editor genuinamente não
 * enviou newsletter nenhuma". `sync-coverage-line.ts` (Stage 2) já troca a
 * linha "Para esta edição..." por um aviso quando vê esse sinal — este check
 * é a segunda barreira, gate-blocking, pra garantir que a edição não segue
 * pro publish com a contagem de submissões subrepresentada e sem que o
 * editor tenha visto o aviso (ex: editor editou 02-reviewed.md no Drive e
 * apagou a linha de aviso sem perceber o que ela significava).
 *
 * Caso real: 260703, 2º dia seguido com `invalid_client` — coverage line
 * saiu "0 submissões" quando a captura simplesmente falhou.
 */
function checkCaptureFailedSubmissionCount(editionDir: string): InvariantViolation[] {
  const marker = readMarker(editionDir, "inject-inbox-urls");
  // #2878 self-review LOW: accept both the nested `details` shape (how
  // `writeMarker` stores it in prod) and a top-level shape, matching
  // `readCaptureFailedFromMarker` (sync-coverage-line, padrão #1476) — the two
  // readers must not diverge on which marker shape they honour.
  const details = (marker?.details ?? marker) as
    | { capture_failed?: boolean; capture_error?: string }
    | undefined;
  if (!details?.capture_failed) return [];
  return [
    {
      rule: "capture-failed-submission-count",
      message:
        `Captura de newsletters (Stage 0 passo 0b-bis) falhou: ${details.capture_error ?? "motivo desconhecido"}. ` +
        `A contagem de submissões da coverage line não é confiável (pode estar subcontada). ` +
        `Reautenticar (ver data/.credentials.json / scripts/oauth-setup.ts) e re-rodar 0b-bis → ` +
        `inject-inbox-urls (Stage 1) → sync-coverage-line (Stage 2) antes de publicar.`,
      source_issue: "#2878",
      severity: "error",
      file: resolve(editionDir, "02-reviewed.md"),
    },
  ];
}

/**
 * #3951: revisor de crop de imagem (`image-crop-reviewer`, Stage 3) sinaliza
 * quando o corte 2:1→1:1 (o que vai pro social) perdeu o sentido da imagem
 * original. Warning-only — mesmo padrão do has-negative-impact-highlight
 * (#3916/#3918): nunca bloqueia o gate, só avisa. Se o arquivo não existe
 * (revisor não rodou nesta edição — ex: retomada de checkpoint pré-#3951),
 * não é violação — o revisor é assistido, não obrigatório.
 */
function checkCropReviewWarnings(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "04-crop-review.json");
  if (!existsSync(path)) return [];
  let data: { results?: Array<{ destaque?: string; status?: string; motivo?: string; sugestao?: string }> };
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const results = Array.isArray(data.results) ? data.results : [];
  return results
    .filter((r) => r && r.status === "warn")
    .map((r) => ({
      rule: "image-crop-warn",
      message:
        `Destaque ${(r.destaque ?? "?").toUpperCase()}: ${r.motivo ?? "crop 1:1 pode ter perdido o sentido da imagem original"}` +
        (r.sugestao ? ` — sugestão: ${r.sugestao}` : ""),
      source_issue: "#3951",
      severity: "warning" as const,
      file: path,
    }));
}

/**
 * #4086 item 2: warn-only guard — quando um slot de box de divulgação
 * (0/1/2/3 — slot 0 desde #4274) tem imagem (explícita via
 * `box_slot{N}_image`, ou `livros_promo` quando o
 * box é de livros — mesmo contrato de `readBoxDivulgacao{N}Image`), mas o
 * snippet atualmente atribuído àquele slot (`boxes_divulgacao.slot{N}` em
 * `platform.config.json`) não declara `alt:` no header, o alt renderizado cai
 * no anchor text do 1º link do box (`renderMidCallout`, #2067) — um rótulo de
 * ação genérico ("Ler o artigo", "Quero apoiar") que não descreve a imagem.
 * Quem usa leitor de tela, ou tem imagens bloqueadas no cliente de e-mail
 * (Outlook desktop bloqueia por padrão), perde a informação que a imagem
 * carrega (caso real 260727: header com o TÍTULO do artigo rasterizado saiu
 * com alt="Ler o artigo" — o título não aparecia em lugar nenhum do e-mail).
 *
 * Warning, não error (decisão explícita da issue): alt fraco (anchor text)
 * não deve bloquear a publicação — deve só ficar visível no gate.
 *
 * **#5457: slot 1/2/3 preferem `_internal/box-selection.json` sobre o config
 * estático.** Desde #4626, o snippet que de fato aparece nos slots de
 * rotação (1/2/3) pode ser escolhido automaticamente por
 * `select-boxes-by-clicks.ts` (`resolveBoxesForEdition`) e diverge de
 * `boxes_divulgacao.slot{N}` no `platform.config.json` — o registro do que
 * foi USADO de fato fica em `box-selection.json`, gravado por
 * `stitch-newsletter.ts` a cada stitch (`SlotSelectionRecord[]`, `file` por
 * slot já é o valor EFETIVO independente do modo — pinado, automático, ou
 * fallback pro config, os três casos já resolvidos por
 * `resolveBoxesForEdition`). Ler esse arquivo evita o gap achado ao vivo na
 * edição 260817: o check apontava pro snippet estático (que sequer usa
 * imagem) enquanto o snippet REALMENTE renderizado em `02-reviewed.md`
 * (fonte de `boxText`/`imageUrl` logo abaixo, já sempre a edição real) era
 * outro, com `alt:` correto. Sem o arquivo (edição pré-#4626, ou falha de
 * escrita fail-soft do stitch), cai pro config estático — comportamento
 * idêntico ao pré-#5457. Slot 0 nunca entra na rotação automática (fora do
 * escopo de `resolveBoxesForEdition`, ver docstring do módulo) — sempre lido
 * do config estático.
 *
 * `rootDir` (default: raiz do repo real, via `readBoxDivulgacaoAltForSlot`/
 * `readBoxDivulgacaoAltForFile`) existe só pra permitir fixture de teste
 * isolada — o call site real (STAGE_4_RULES) nunca passa override.
 */
function checkBoxDivulgacaoAltMissing(
  editionDir: string,
  rootDir?: string,
): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");

  const slots: Array<{
    n: 0 | 1 | 2 | 3;
    extract: (text: string) => string | null;
    readImage: (editionDir: string, boxText?: string | null) => string | null;
  }> = [
    { n: 0, extract: extractBoxDivulgacao0, readImage: readBoxDivulgacao0Image }, // #4274
    { n: 1, extract: extractBoxDivulgacao1, readImage: readBoxDivulgacao1Image },
    { n: 2, extract: extractBoxDivulgacao2, readImage: readBoxDivulgacao2Image },
    { n: 3, extract: extractBoxDivulgacao3, readImage: readBoxDivulgacao3Image },
  ];

  const violations: InvariantViolation[] = [];
  for (const { n, extract, readImage } of slots) {
    const boxText = extract(md);
    if (!boxText) continue; // slot vazio nesta edição — nada a checar
    const imageUrl = readImage(editionDir, boxText);
    if (!imageUrl) continue; // sem imagem — anchor text é o alt de sempre, sem gap

    // #5457: slot 0 nunca tem entry em box-selection.json (fora da rotação
    // automática) — só 1/2/3 consultam o arquivo antes do fallback estático.
    const selectedFile = n === 0 ? undefined : readBoxSelectionFileForSlot(editionDir, n);
    let alt: string | null;
    let usedFile: string | null;
    if (selectedFile) {
      alt = rootDir !== undefined
        ? readBoxDivulgacaoAltForFile(selectedFile, rootDir)
        : readBoxDivulgacaoAltForFile(selectedFile);
      usedFile = selectedFile;
    } else {
      alt = rootDir !== undefined
        ? readBoxDivulgacaoAltForSlot(n, rootDir)
        : readBoxDivulgacaoAltForSlot(n);
      usedFile = null; // desconhecido aqui sem reler o config — mensagem cita o slot, não o nome do arquivo
    }
    if (alt) continue;
    const sourceNote = usedFile
      ? `o snippet \`${usedFile}\` (efetivamente usado neste slot nesta edição, via _internal/box-selection.json)`
      : `o snippet atribuído em boxes_divulgacao.slot${n} (platform.config.json)`;
    violations.push({
      rule: "box-divulgacao-alt-missing",
      message:
        `Slot ${n} de box de divulgação tem imagem, mas ${sourceNote} não declara \`alt:\` no header. ` +
        `O alt renderizado cai no anchor text do 1º link do box (rótulo de ação genérico, ` +
        `ex: "Ler o artigo") — não descreve a imagem pra leitor de tela ou cliente com imagens ` +
        `bloqueadas (Outlook desktop). Fix: adicionar \`alt: {descrição do CONTEÚDO da imagem}\` ` +
        `ao header do snippet (ver context/snippets/README.md).`,
      source_issue: "#4086",
      severity: "warning",
      file: path,
    });
  }
  return violations;
}

/**
 * #5457: lê `_internal/box-selection.json` (grava por `stitch-newsletter.ts`
 * a cada stitch, via `resolveBoxesForEdition`/`SlotSelectionRecord` em
 * `select-boxes-by-clicks.ts` — não importado aqui pra não acoplar este
 * módulo a esse script; contrato de campo replicado localmente) e devolve o
 * snippet EFETIVAMENTE usado no slot informado (1/2/3 — nunca 0, fora do
 * escopo de `box-selection.json`). `null`/`undefined` (arquivo ausente,
 * malformado, ou sem entry pro slot) sinaliza ao caller pra cair no fallback
 * do config estático — mesmo fail-soft do resto do módulo.
 */
function readBoxSelectionFileForSlot(editionDir: string, slot: 1 | 2 | 3): string | null {
  const path = resolve(editionDir, "_internal", "box-selection.json");
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(data)) return null;
    const entry = data.find(
      (r) => r && typeof r === "object" && (r as { slot?: unknown }).slot === slot,
    ) as { file?: unknown } | undefined;
    if (!entry) return null;
    return typeof entry.file === "string" && entry.file ? entry.file : null;
  } catch {
    return null;
  }
}

/**
 * #4504: mirror de `checkBoxDivulgacaoAltMissing`, pro gap identificado no
 * fleet review do #4502 — valida que NENHUM slot de `boxes_divulgacao`
 * (0-3, `platform.config.json`) aponta pra um snippet com `runtime: false`
 * no header (`readBoxDivulgacaoRuntimeExcludedForSlot`, que usa
 * `isRuntimeExcluded` de `shared/snippet-header.ts` — movida de
 * `studio-ui/studio-boxes.ts` nesta mesma issue, item 2, porque este check
 * roda no pipeline core e não pode importar da camada UI).
 *
 * `saveBoxSlots` (Studio UI) já bloqueia essa atribuição no PUT (#4500/
 * #4502), mas config editado manualmente ou não migrado passa por fora
 * dessa checagem — este invariant é a defesa em profundidade no PRÓPRIO
 * pipeline de render, rodando antes do gate humano do Stage 4,
 * independente da via de edição do config.
 *
 * Diferente de `checkBoxDivulgacaoAltMissing` (warning — alt ausente só
 * degrada acessibilidade), esta regra é **error**: o conteúdo ERRADO seria
 * injetado verbatim na newsletter — o mesmo cenário que causou o incidente
 * original do #4500 (`intro-campeoes-sorteio.md` configurado num slot).
 *
 * `rootDir` (default: raiz do repo real, via
 * `readBoxDivulgacaoRuntimeExcludedForSlot`) existe só pra fixture de teste
 * isolada — o call site real (STAGE_4_RULES) nunca passa override.
 * `editionDir` não é lido pelo corpo desta função (a config não é
 * por-edição), mas é mantido na assinatura pra bater o contrato comum de
 * `InvariantRule.run`.
 */
function checkBoxDivulgacaoRuntimeExcluded(
  editionDir: string,
  rootDir?: string,
): InvariantViolation[] {
  void editionDir; // não lido — checagem é sobre platform.config.json, não sobre a edição
  const violations: InvariantViolation[] = [];
  const slots: Array<0 | 1 | 2 | 3> = [0, 1, 2, 3];
  for (const n of slots) {
    const excluded = rootDir !== undefined
      ? readBoxDivulgacaoRuntimeExcludedForSlot(n, rootDir)
      : readBoxDivulgacaoRuntimeExcludedForSlot(n);
    if (!excluded) continue;
    violations.push({
      rule: "box-divulgacao-runtime-excluded",
      message:
        `boxes_divulgacao.slot${n} (platform.config.json) aponta pra um snippet com ` +
        `\`runtime: false\` no header — esse conteúdo é documentação/referência, não ` +
        `deveria aparecer na newsletter, mas seria injetado verbatim (mesmo incidente ` +
        `do #4500). Fix: apontar o slot pra outro snippet, ou remover \`runtime: false\` ` +
        `do header se o conteúdo passou a ser real.`,
      source_issue: "#4504",
      severity: "error",
      file: "platform.config.json",
    });
  }
  return violations;
}

/**
 * #4090 item 4 (decisão do editor, 260727): se a edição gerou o card 4:5
 * (`04-d{N}-4x5.jpg` no disco — mandatório desde a decisão 260728, ver
 * `checkCard4x5Exists` em stage-3.ts) mas o upload (`06-public-images.json`)
 * não tem a entry `d{N}_4x5`, avisar no gate — silêncio aqui publica o post
 * no formato ERRADO (1:1 sem título) sem ninguém perceber, porque os
 * publishers fazem fallback silencioso (`selectSocialCardImageFile`).
 *
 * Severity "warning", não "error": a issue original pede "avisar no gate",
 * não bloquear — `upload-images-public.ts` trata a entry `d{N}_4x5` como
 * `optional: true` (upload de card é adicional ao fluxo newsletter/social
 * que já funciona sem ele), e `checkCard4x5Exists` (Stage 3) já é a barreira
 * dura pra GERAÇÃO. Este check cobre o passo seguinte — UPLOAD — que pode
 * falhar independente da geração ter dado certo (rede, cache stale, etc).
 */
function checkCard4x5UploadMismatch(editionDir: string): InvariantViolation[] {
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
    const cardPath = resolve(editionDir, `04-${d}-4x5.jpg`);
    if (!existsSync(cardPath)) continue; // sem card gerado nesta edição — nada a cruzar
    const url = images?.[`${d}_4x5`]?.url;
    if (!url || typeof url !== "string" || url.trim().length === 0) {
      violations.push({
        rule: "card-4x5-upload-missing",
        message:
          `04-${d}-4x5.jpg existe no disco mas 06-public-images.json não tem ` +
          `images.${d}_4x5.url — upload-images-public.ts não subiu o card 4:5 (ou rodou ` +
          `antes do card existir). Publishers vão cair pro 1:1 EM SILÊNCIO (post sai sem ` +
          `título embutido). Fix: re-rodar "npx tsx scripts/upload-images-public.ts ` +
          `--edition-dir ${editionDir}" antes de publicar.`,
        source_issue: "#4090",
        severity: "warning",
        file: imagesPath,
      });
    }
  }
  return violations;
}

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
function checkCarouselCardsStale(editionDir: string): InvariantViolation[] {
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

  for (const d of slots) {
    if (!slidesOnDiskDe(d)) continue; // destaque sem carrossel — publica single-image, nada a cruzar

    const dText = extractDestaqueBlock(section, d);
    if (!dText) continue; // sem bloco não há o que comparar (o gen já pulou este destaque)

    const atual = hashCarouselSlideTexts(dText.trim());
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
 */
function checkCarouselTextOverflow(editionDir: string): InvariantViolation[] {
  const socialPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialPath)) return [];

  const section = extractSection(readFileSync(socialPath, "utf8"), "Social");
  if (!section) return []; // estrutura quebrada já é coberta por carousel-cards-stale

  const destaqueCount = readDestaqueCount(editionDir);
  const slots = destaqueCount === 2 ? (["d1", "d2"] as const) : (["d1", "d2", "d3"] as const);
  const violations: InvariantViolation[] = [];

  for (const d of slots) {
    const dText = extractDestaqueBlock(section, d);
    if (!dText) continue;

    const overflowing = findOverflowingCarouselSlides(dText.trim());
    if (overflowing.length === 0) continue;

    const detalhe = overflowing.map((o) => `${o.slot} (${o.chars} chars, ${o.excessPx}px além)`).join("; ");
    violations.push({
      rule: "carousel-text-overflow",
      message:
        `'## ${d}' de 03-social.md tem ${overflowing.length} parágrafo(s) que não cabem no card do ` +
        `carrossel em ${DAILY_CAROUSEL_BODY_SIZE}px: ${detalhe}. O tamanho da fonte é fixo de propósito ` +
        `(#6078) — o conserto é REESCREVER o parágrafo pra ~${DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET} ` +
        `caracteres ou menos, aqui no painel Revisão, e depois rodar ` +
        `"npx tsx scripts/gen-carousel-cards.ts --edition-dir ${editionDir}" + ` +
        `"npx tsx scripts/upload-images-public.ts --edition-dir ${editionDir}". ` +
        `Enquanto isto não for feito, a geração dos slides FALHA — e se o gate for ignorado ` +
        `assim mesmo, o destaque publica como post single-image (fallback tudo-ou-nada).`,
      source_issue: "#6078",
      severity: "error",
      file: socialPath,
    });
  }
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
function checkCarouselCardsMissing(editionDir: string): InvariantViolation[] {
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
function checkCarouselUploadIncomplete(editionDir: string): InvariantViolation[] {
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
function checkCarouselUploadStale(editionDir: string): InvariantViolation[] {
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
          `— arquivo travado/removido entre a checagem e a leitura (sync do OneDrive, processo ` +
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

/**
 * #4673: `render-newsletter-html.ts` (via `renderHTML`/`getRenderWarnings`,
 * scripts/lib/newsletter-render-html.ts) emite eventos estruturados quando
 * conteúdo editorial/comercial some silenciosamente do render — caixa de
 * divulgação sem lacuna livre (`divulgacao_box_dropped_no_gap`, #4624),
 * bloco WhatsApp sem D1 (`whatsapp_share_no_d1`), divergência entre os dois
 * sinais que decidem "isto é D1" (`whatsapp_share_d1_mismatch`, desde #5152,
 * nunca deveria disparar, guard defensivo), e — desde #5794/#5817 — o
 * snippet `data/snippets/convite-amigo-whatsapp.md` ausente
 * (`convite_amigo_snippet_missing`, bloco "sempre presente" que sumiria de
 * TODA edição em silêncio sem este sinal). #5999 acrescenta
 * `convite_amigo_orphan_no_encerrar`: a caixa migrou pro TOPO de "Para
 * encerrar", então uma edição sem essa seção não tem onde embuti-la — cai no
 * fallback standalone (posição pré-#5999) em vez de sumir.
 * Antes deste check, ficavam só no `console.error` de qualquer terminal que
 * por acaso estava rodando o render — nunca chegavam no resumo consolidado
 * do gate que o editor de fato revisa antes de publicar. O CLI (§4b step 2
 * do orchestrator) grava esses eventos em `_internal/render-warnings.json` a
 * cada chamada (sempre — mesmo array vazio, pra nunca deixar warning STALE
 * de uma rodada anterior sobreviver). Warning-only, nunca bloqueia (mesmo
 * padrão de `image-crop-warn`/`card-4x5-upload-missing` acima) — a decisão
 * de como corrigir (reduzir caixas configuradas, promover/demover destaque)
 * é editorial, não mecânica.
 *
 * Se o arquivo não existe (edição pré-#4673, ou render ainda não rodou nesta
 * retomada), não é violação — o arquivo é escrito pelo pré-render, que roda
 * ANTES deste invariant no fluxo do Stage 4 (§4b step 2 → §4b step 5).
 */
function checkRenderWarnings(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "render-warnings.json");
  if (!existsSync(path)) return [];
  let data: { warnings?: Array<{ event?: string; edition?: string; slot?: number }> };
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const violations: InvariantViolation[] = [];
  for (const w of warnings) {
    if (w.event === "divulgacao_box_dropped_no_gap") {
      violations.push({
        rule: "divulgacao-box-dropped-no-gap",
        message:
          `Caixa de divulgação do slot ${w.slot ?? "?"} (platform.config.json → ` +
          `boxes_divulgacao) não coube em nenhuma lacuna livre desta edição — conteúdo ` +
          `COMERCIAL configurado não sairá publicado. Fix: reduzir o número de caixas ` +
          `configuradas para o número de lacunas disponíveis (D1/D2, D2/D3 + região ` +
          `pós-último-destaque), ou ajustar quais slots estão engajados.`,
        source_issue: "#4673",
        severity: "warning",
        file: path,
      });
    } else if (w.event === "whatsapp_share_no_d1") {
      violations.push({
        rule: "whatsapp-share-no-d1",
        message:
          `Bloco "Compartilhe no WhatsApp" não foi renderizado — a edição não tem D1 ` +
          `(nunca deveria acontecer dado o invariante de 2-3 destaques, mas o bloco ` +
          `depende de D1 pra existir). Fix: confirmar que 02-reviewed.md tem ao menos 1 ` +
          `destaque antes de publicar.`,
        source_issue: "#4673",
        severity: "warning",
        file: path,
      });
    } else if (w.event === "whatsapp_share_d1_mismatch") {
      violations.push({
        rule: "whatsapp-share-d1-mismatch",
        message:
          `Bloco "Compartilhe no WhatsApp" pode ter sumido do e-mail publicado — o ` +
          `render detectou que o 1º destaque no array (posição usada pra decidir ONDE ` +
          `injetar o bloco) não tem \`n === 1\` (usado pra decidir SE injeta). Os dois ` +
          `sinais deveriam sempre concordar; divergiram, e o bloco não foi incluído no ` +
          `D1. Fix: investigar por que o array de destaques não está na ordem 1, 2, 3 — ` +
          `provável bug no parsing/extração de 02-reviewed.md, não algo pra corrigir manualmente na edição.`,
        source_issue: "#5152",
        severity: "warning",
        file: path,
      });
    } else if (w.event === "convite_amigo_snippet_missing") {
      violations.push({
        rule: "convite-amigo-snippet-missing",
        message:
          `Bloco "Convide um amigo" não foi renderizado — data/snippets/convite-amigo-whatsapp.md ` +
          `ausente ou vazio (edição pós-#5794/#5817, deveria estar sempre presente). Fix: confirmar ` +
          `que o arquivo existe (não foi apagado/renomeado por engano no painel Caixas do Studio) ` +
          `antes de publicar.`,
        source_issue: "#5817",
        severity: "warning",
        file: path,
      });
    } else if (w.event === "convite_amigo_orphan_no_encerrar") {
      violations.push({
        rule: "convite-amigo-orphan-no-encerrar",
        message:
          `Bloco "Convide um amigo" renderizou no formato STANDALONE (posição pré-#5999) em vez ` +
          `de dentro de "Para encerrar" — esta edição não tem bloco "Para encerrar" ` +
          `(02-reviewed.md sem essa seção), então a caixa não tem onde entrar no topo dela ` +
          `(#5999). Fix: confirmar se a ausência de "Para encerrar" é intencional; se não for, ` +
          `adicionar a seção ao 02-reviewed.md.`,
        source_issue: "#5999",
        severity: "warning",
        file: path,
      });
    }
  }
  return violations;
}

/**
 * #5232: `_internal/newsletter-final.html` (o fragmento que vai pro corpo do
 * e-mail — não o post inteiro do Beehiiv, que soma template + CSS por cima)
 * ficou numa faixa estável de ~38-42KB por ~3 semanas (260722-260812) e deu
 * um salto pra 44.384 bytes (260813) e 47.607 bytes (260814) — perto o
 * bastante do limite de clipping do Gmail (~102KB no e-mail INTEIRO, não só
 * neste fragmento) pro Beehiiv já ter emitido o warning "Your post is large
 * and may get clipped by Gmail" no Stage 6 ao agendar a edição 260814.
 *
 * Antes deste check, o único sinal desse crescimento era esse warning manual
 * do Beehiiv — visto tarde (Stage 6, minutos antes do envio) e fácil de
 * ignorar como "não bloqueia mesmo". Este invariant roda no Stage 4 (o
 * fragmento já existe nesse ponto — pré-render já rodou antes dos invariants
 * do gate) e sinaliza ANTES do editor aprovar a revisão, com folga pra
 * investigar/cortar conteúdo se for o caso.
 *
 * `NEWSLETTER_HTML_SIZE_WARN_BYTES` (45.000 bytes) foi escolhido acima da
 * faixa histórica estável (~38-42KB) e abaixo do salto observado (44.384 /
 * 47.607) — pega o regression real sem alarmar a faixa normal. Ajustável
 * livremente; não é um limite físico, só o ponto onde vale a pena o editor
 * olhar.
 *
 * Warning, não error (mesmo padrão de `card-4x5-upload-missing`/
 * `image-crop-warn` acima) — decidir SE/O QUE cortar é editorial (#5232 item
 * 4, fora de escopo deste check), não algo que este invariant deva forçar.
 *
 * Arquivo ausente (pré-render ainda não rodou nesta retomada, ou edição
 * legada pré-#1694) → `[]`, nada a checar — mesmo padrão de
 * `checkRenderWarnings` acima.
 */
export const NEWSLETTER_HTML_SIZE_WARN_BYTES = 45_000;

export function checkNewsletterHtmlSize(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "newsletter-final.html");
  if (!existsSync(path)) return [];
  const bytes = statSync(path).size;
  if (bytes <= NEWSLETTER_HTML_SIZE_WARN_BYTES) return [];
  const kb = (bytes / 1024).toFixed(1);
  const thresholdKb = (NEWSLETTER_HTML_SIZE_WARN_BYTES / 1024).toFixed(1);
  return [
    {
      rule: "newsletter-html-size",
      message:
        `_internal/newsletter-final.html tem ${bytes} bytes (${kb} KB), acima do ` +
        `threshold de ${NEWSLETTER_HTML_SIZE_WARN_BYTES} bytes (${thresholdKb} KB). ` +
        `A faixa histórica estável (260722-260812) era ~38-42KB — acima disso é sinal ` +
        `de crescimento real do conteúdo, não ruído. Perto o bastante do limite de ` +
        `clipping do Gmail (~102KB no e-mail inteiro) pro Beehiiv já ter avisado no ` +
        `Stage 6 em edições anteriores (#5232). Investigar a origem do crescimento ` +
        `(boxes de divulgação extra, conteúdo editorial mais longo) antes de aprovar — ` +
        `cortar conteúdo é decisão editorial, este check só avisa.`,
      source_issue: "#5232",
      severity: "warning",
      file: path,
    },
  ];
}

/**
 * #6506 — o e-mail renderizado pelo Kit passa de 102 KB (limite de clipping
 * do Gmail: acima disso o Gmail corta a mensagem e mostra "[Mensagem
 * cortada]"). O pixel de abertura do Kit fica no FIM do corpo (abaixo do
 * corte), então uma edição que estoure 102 KB tem abertura Gmail
 * SUBCONTADA — o número vira um piso, não a taxa real, e essa taxa alimenta
 * a decisão de rampa (#6505).
 *
 * **Severity CONDICIONAL ao backend ativo (achado do self-review, #6506) —
 * NÃO é `error` incondicional.** `render-kit-html-preview.ts` roda em TODA
 * edição no pré-render do Stage 4, mesmo com `publishing.newsletter.backend`
 * ainda `"beehiiv"` (é assim que este check tem o que medir ANTES do
 * cutover — ver docstring do script). Se a severity fosse `error`
 * incondicional, este invariant travaria o gate da pipeline ATUAL (Beehiiv,
 * já em produção) por causa de um limite de um canal que ainda nem está
 * enviando — dano real e imediato, não é o que a issue pede. Por isso:
 *   - backend `"kit"` (Kit é o canal REAL de envio): `error` — bloqueia o
 *     gate, porque a consequência (abertura subcontada) só aparece semanas
 *     depois numa análise de rampa, não no e-mail em si.
 *   - qualquer outro backend (Beehiiv/Brevo hoje; Kit ainda em migração):
 *     `warning` — visível pro editor (item 1 da issue, "medir e registrar"),
 *     nunca bloqueia uma pipeline que não depende do Kit pra sair no ar.
 *
 * Mede `_internal/newsletter-final-kit.html` — o fragmento REAL que
 * `scripts/render-kit-html-preview.ts` grava (mesmo `buildKitHtml` puro que
 * `publish-newsletter-kit.ts` usaria pra publicar de verdade, sem nenhuma
 * chamada de rede) — e não `newsletter-final.html` (que é o fragmento
 * Beehiiv, calibrado por `BEEHIIV_WRAPPER_OVERHEAD_KB` em
 * `lint-newsletter-html.ts`; os dois canais têm wrappers/overhead
 * DIFERENTES no e-mail entregue, então um limiar único não serve aos dois).
 *
 * **Threshold SEM ajuste de overhead — ao contrário do Beehiiv.** A Beehiiv
 * teve seu overhead medido ao vivo uma vez (#5176, ~44 KB) contra um envio
 * real; o Kit ainda não teve — não existe hoje um e-mail Kit publicado pra
 * medir a diferença fragmento→entregue. Usar o limiar bruto de 102 KB
 * direto sobre o fragmento é a leitura mais próxima do que a issue #6506
 * mediu (a mesma medição de 28/08/2026 que achou os 50,3% de `style=""`
 * rodou sobre este artefato, não sobre um e-mail entregue) — mas é uma
 * leitura OTIMISTA: o Kit injeta baseline inline em todo `<p>` + o próprio
 * rodapé "Built with Kit" por cima disso (ver docstring de `buildKitHtml`),
 * então o e-mail de fato entregue tende a ser MAIOR que este fragmento.
 * Recalibrar (mesmo método do #5176: 1º envio de teste real, medir a
 * diferença) antes de confiar neste threshold como preciso — até lá, ele já
 * é uma barreira real contra o pior caso óbvio (fragmento sozinho já
 * estourado).
 *
 * Arquivo ausente (pré-render Kit ainda não rodou, ou skill não chamou
 * `render-kit-html-preview.ts` nesta retomada) → `[]`, mesmo padrão de
 * `checkNewsletterHtmlSize` acima — nunca bloqueia por AUSÊNCIA do artefato,
 * só pelo TAMANHO quando ele existe.
 *
 * `rootDir` (opcional, 2º parâmetro): override pra fixture de teste isolada
 * de `platform.config.json` — mesmo padrão de `checkBoxDivulgacaoRuntimeExcluded`
 * acima. `STAGE_4_RULES` nunca passa override (usa o `ROOT` real do módulo).
 */
export const KIT_HTML_SIZE_ERROR_BYTES = 102 * 1024;

function readKitBackendActive(rootDir: string): boolean {
  // Ausência é o caso normal (fixture de teste sem platform.config.json,
  // clone fresco) — fail-soft pro lado que NUNCA bloqueia a pipeline atual
  // à toa. Malformado é OUTRA coisa (fleet review, #6506): um
  // platform.config.json corrompido no exato momento em que o backend real
  // é "kit" E o e-mail está grande faria este catch rebaixar `error` →
  // `warning` em silêncio, sem nenhum rastro de por quê — justo no pior
  // momento pra essa checagem falhar sem ruído. JSON malformado agora
  // PROPAGA (nunca vira "kit não ativo" por engano).
  const path = resolve(rootDir, "platform.config.json");
  if (!existsSync(path)) return false;
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    publishing?: { newsletter?: { backend?: string } };
  };
  return raw.publishing?.newsletter?.backend === "kit";
}

export function checkKitHtmlSize(editionDir: string, rootDir: string = ROOT): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "newsletter-final-kit.html");
  if (!existsSync(path)) return [];
  const bytes = statSync(path).size;
  if (bytes <= KIT_HTML_SIZE_ERROR_BYTES) return [];
  const kb = (bytes / 1024).toFixed(1);
  const kitIsActiveBackend = readKitBackendActive(rootDir);
  return [
    {
      rule: "kit-html-too-large",
      message:
        `_internal/newsletter-final-kit.html tem ${bytes} bytes (${kb} KB), acima do ` +
        `limite de clipping do Gmail (102 KB, #6506). O pixel de abertura do Kit fica ` +
        `no FIM do corpo — abaixo do corte — então a abertura Gmail desta edição sairia ` +
        `SUBCONTADA se publicada pelo Kit assim, e essa taxa alimenta a decisão de rampa ` +
        `(#6505). Cortar conteúdo (boxes de divulgação, texto de destaque) é decisão ` +
        `editorial.` +
        (kitIsActiveBackend
          ? ` Backend ativo é "kit" — este check BLOQUEIA o gate até isso acontecer.`
          : ` Backend ativo ainda não é "kit" (publishing.newsletter.backend em ` +
            `platform.config.json) — aviso não-bloqueante enquanto o Kit não for o ` +
            `canal real de envio; vira bloqueante no dia do cutover.`),
      source_issue: "#6506",
      severity: kitIsActiveBackend ? "error" : "warning",
      file: path,
    },
  ];
}

/**
 * #6336: audita a base Kit de produção por assinante ATIVO cujo e-mail bate
 * padrão de fixture de teste (`ana@example.com` e vizinhos — ver docstring
 * de `scripts/lib/kit-fixture-patterns.ts`). Achado ao vivo 26/08/2026: uma
 * verificação manual de funil (poll/cursos/reativar) deixou 13 resíduos
 * desse tipo, 2 deles `active` — receberiam a próxima edição pelo Kit, e
 * `example.com` é domínio reservado (RFC 2606): hard bounce garantido.
 *
 * O trabalho de rede (paginar `/v4/subscribers`, comparar padrões) mora em
 * `scripts/audit-kit-fixtures.ts` — este check só invoca esse script via
 * `spawnSync` (mesmo padrão de `runCheck` em `stage-2.ts`, necessário porque
 * `InvariantRule.run` é síncrono e a chamada à API do Kit é assíncrona) e
 * traduz o exit code em violation:
 *
 *   - `0` → limpo, `[]`.
 *   - `1` → fixture(s) ATIVO(s) na base real — `error` (gate-blocking:
 *     publicar sem agir manda a próxima edição pro fixture, hard bounce
 *     certo).
 *   - `2` (`KIT_API_KEY` ausente, ou API do Kit indisponível) → `warning`,
 *     não `error`. O Kit ainda não é o backend principal de newsletter
 *     (`platform.config.json.newsletter` = `"beehiiv"`) — exigir a
 *     credencial em toda edição bloquearia Stage 4 pra qualquer ambiente
 *     sem Kit configurado (CI, clone fresco, sessão cloud) por causa de uma
 *     verificação sobre um sistema secundário ainda em migração. Mesma
 *     disciplina fail-soft de integração opcional já usada no repo (ex:
 *     `data/` ausente em `studio-boxes.ts`).
 *   - qualquer outro exit code (script crashou) → `error`, mesma severidade
 *     de "achei o problema" — um crash inesperado não deveria degradar pra
 *     silêncio.
 *
 * `env` é explícito no `spawnSync` (mesmo padrão de `checkGeminiModelValid`
 * em `stage-0.ts`) e injetável — default `process.env` em produção. Existe
 * pra permitir que o teste (`test/stage-4-kit-fixture-audit-invariant.test.ts`)
 * force o cenário "sem KIT_API_KEY" de forma hermética: apagar a var só do
 * `process.env` do processo PAI não bastava (achado #6387) porque
 * `audit-kit-fixtures.ts` chama `loadProjectEnv()`, que recarrega `.env` do
 * disco e populava a var de novo no filho a partir da máquina real — o teste
 * ficava fazendo fetch de verdade contra a base Kit de produção sempre que
 * `KIT_API_KEY` estivesse setada no `.env` local. A correção passa um objeto
 * `env` explícito com `KIT_API_KEY: ""` (presente, vazio) — `dotenv`
 * (`override:false`, `hasOwnProperty`) só preenche uma var AUSENTE do
 * target; uma var presente mas vazia não é sobrescrita, então
 * `resolveKitConfig` a trata como ausente (string vazia é falsy) sem o
 * subprocesso jamais reidratar a credencial real.
 */
function checkKitFixtureAudit(
  _editionDir: string,
  env: NodeJS.ProcessEnv = process.env,
): InvariantViolation[] {
  const scriptPath = resolve(ROOT, "scripts", "audit-kit-fixtures.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], { encoding: "utf8", env });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();

  if (result.status === 0) return [];

  if (result.status === 2) {
    return [
      {
        rule: "kit-fixture-audit-unavailable",
        message:
          `audit-kit-fixtures.ts não pôde rodar (KIT_API_KEY ausente ou API do Kit ` +
          `indisponível): ${(stderr || stdout).slice(0, 400)}. Verificação de fixture ` +
          `ativo na base Kit pulada nesta edição — reconfigurar a credencial e rodar ` +
          `manualmente (npx tsx scripts/audit-kit-fixtures.ts) quando possível.`,
        source_issue: "#6336",
        severity: "warning",
        file: scriptPath,
      },
    ];
  }

  return [
    {
      rule: "kit-fixture-audit",
      message:
        `Assinante(s) de fixture de teste ATIVO(s) na base Kit de PRODUÇÃO — ` +
        `receberia(m) a próxima edição real (domínios como example.com são reservados ` +
        `RFC 2606, hard bounce garantido). ${(stdout || stderr).slice(0, 800)} ` +
        `Fix: cancelar o(s) assinante(s) via API/dashboard Kit antes de publicar. ` +
        `Prevenção: verificação ao vivo de funil (poll/cursos/reativar) usa sempre ` +
        `vjpixel+probe-{issue}-{data}@gmail.com, nunca um fixture de test/*.test.ts — ` +
        `e cancelar o probe ao fim da verificação é parte do rollout, não um passo ` +
        `opcional (ver docstring de scripts/audit-kit-fixtures.ts, #6336).`,
      source_issue: "#6336",
      severity: "error",
      file: scriptPath,
    },
  ];
}

export const STAGE_4_RULES: InvariantRule[] = [
  {
    id: "public-images-populated",
    description: "06-public-images.json com URLs d1/d2/d3 (#999)",
    source_issue: "#999",
    stage: 4,
    run: checkPublicImagesPopulated,
  },
  {
    id: "social-hash-fresh",
    description: "social.md hash bate com approved.json highlights (#1413)",
    source_issue: "#1413",
    stage: 4,
    run: checkSocialHashFresh,
  },
  {
    id: "image-content-fresh",
    description: "imagem de destaque bate com highlight D{N} atual (#1730)",
    source_issue: "#1730",
    stage: 4,
    run: checkImageContentFresh,
  },
  {
    id: "eia-credit-synced",
    description: "crédito do bloco É IA? em 02-reviewed.md bate com 01-eia.md, a fonte real do render (#3825)",
    source_issue: "#3825",
    stage: 4,
    run: checkEiaCreditSynced,
  },
  {
    id: "intro-count-consistent",
    description: "intro line Z = contagem real de items visíveis (#1578)",
    source_issue: "#1578",
    stage: 4,
    run: checkIntroCountConsistent,
  },
  {
    id: "use-melhor-sentinel",
    description: "itens USE MELHOR sem descrição real (sentinel [DESCRIÇÃO PENDENTE] presente, #2464)",
    source_issue: "#2464",
    stage: 4,
    run: checkUseMelhorSentinel,
  },
  {
    id: "use-melhor-tempo",
    description: "cada item USE MELHOR tem estimativa de tempo na descrição (#2372)",
    source_issue: "#2372",
    stage: 4,
    run: checkUseMelhorTempoConsistent,
  },
  {
    id: "narrative-not-generic-placeholder",
    description: "narrative ERRO INTENCIONAL é declaração real de primeira pessoa (#2377)",
    source_issue: "#2377",
    stage: 4,
    run: checkNarrativeNotGenericPlaceholder,
  },
  {
    id: "intentional-error-present-in-final",
    description:
      "item que carrega o erro intencional (wrong_value) ainda está em 02-reviewed.md — detecta poda silenciosa no gate (#7243)",
    source_issue: "#7243",
    stage: 4,
    run: checkIntentionalErrorPresentInFinal,
  },
  {
    id: "truncated-secondary-item-summary",
    description: "descrição de item secundário não termina em reticências de truncamento (#2596)",
    source_issue: "#2596",
    stage: 4,
    run: checkTruncatedSecondaryItemSummary,
  },
  {
    id: "title-publisher-suffix",
    description: "título sem sufixo residual de veículo (' | Veículo' / ' - Veículo', #2664)",
    source_issue: "#2664",
    stage: 4,
    run: checkTitlePublisherSuffixInvariant,
  },
  {
    id: "title-trailing-period",
    description: "título de destaque/item sem ponto final único (#2672)",
    source_issue: "#2672",
    stage: 4,
    run: checkTitleTrailingPeriodInvariant,
  },
  {
    id: "no-trailing-ellipsis",
    description: "descrição de item secundário não termina em reticências herdadas da fonte (#2881)",
    source_issue: "#2881",
    stage: 4,
    run: checkNoTrailingEllipsisInvariant,
  },
  {
    id: "title-mentions-ia",
    description: "título de destaque sem menção a 'IA'/'AI'/'inteligência artificial' quando evitável (#4825, warning-only)",
    source_issue: "#4825",
    stage: 4,
    run: checkTitleMentionsIaInvariant,
  },
  {
    id: "capture-failed-submission-count",
    description: "captura de newsletters (0b-bis) falhou — coverage line não pode afirmar '0 submissões' (#2878)",
    source_issue: "#2878",
    stage: 4,
    run: checkCaptureFailedSubmissionCount,
  },
  {
    id: "has-negative-impact-highlight",
    description: "≥1 destaque tagueado negative_impact:true — repetido no gate consolidado (#3916, #3918, warning-only)",
    source_issue: "#3916",
    stage: 4,
    run: checkHasNegativeImpactHighlight,
  },
  {
    id: "image-crop-warn",
    description: "revisor de crop 2:1→1:1 (Stage 3) sinaliza sujeito cortado/composição sem sentido (#3951, warning-only)",
    source_issue: "#3951",
    stage: 4,
    run: checkCropReviewWarnings,
  },
  {
    id: "box-divulgacao-alt-missing",
    description: "slot de box de divulgação com imagem mas sem alt: descritivo no snippet (#4086, warning-only)",
    source_issue: "#4086",
    stage: 4,
    run: checkBoxDivulgacaoAltMissing,
  },
  {
    id: "card-4x5-upload-missing",
    description: "card 4:5 existe no disco mas 06-public-images.json não tem a entry d{N}_4x5 (#4090, warning-only)",
    source_issue: "#4090",
    stage: 4,
    run: checkCard4x5UploadMismatch,
  },
  {
    id: "carousel-cards-missing",
    description: "ausência TOTAL dos slides do carrossel diário (0 dos N×4) pra edição com texto de destaque — gen-carousel-cards.ts provavelmente nunca rodou (#6740)",
    source_issue: "#6740",
    stage: 4,
    run: checkCarouselCardsMissing,
  },
  {
    id: "carousel-cards-stale",
    description: "slides do carrossel diário rasterizados com texto anterior à edição do 03-social.md (#6064)",
    source_issue: "#6064",
    stage: 4,
    run: checkCarouselCardsStale,
  },
  {
    id: "carousel-upload-incomplete",
    description: "slides do carrossel existem no disco mas 06-public-images.json não tem todas as 5 chaves (#6064, warning-only)",
    source_issue: "#6064",
    stage: 4,
    run: checkCarouselUploadIncomplete,
  },
  {
    id: "carousel-upload-stale",
    description: "arte do carrossel no KV está atrás do arquivo local (md5 divergente) — post sairia com a arte velha (#6068)",
    source_issue: "#6068",
    stage: 4,
    run: checkCarouselUploadStale,
  },
  {
    id: "carousel-text-overflow",
    description: "parágrafo do social não cabe no card do carrossel em tamanho fixo — precisa ser reescrito (#6078)",
    source_issue: "#6078",
    stage: 4,
    run: checkCarouselTextOverflow,
  },
  {
    id: "box-divulgacao-runtime-excluded",
    description: "slot de boxes_divulgacao aponta pra snippet runtime:false — injetaria conteúdo de doc/referência verbatim (#4504)",
    source_issue: "#4504",
    stage: 4,
    run: checkBoxDivulgacaoRuntimeExcluded,
  },
  {
    id: "render-warnings-consumed",
    description: "eventos estruturados de render-newsletter-html.ts (divulgacao_box_dropped_no_gap / whatsapp_share_no_d1 / whatsapp_share_d1_mismatch / convite_amigo_snippet_missing) surfaced no gate (#4673, warning-only)",
    source_issue: "#4673",
    stage: 4,
    run: checkRenderWarnings,
  },
  {
    id: "newsletter-html-size",
    description: `_internal/newsletter-final.html acima de ${NEWSLETTER_HTML_SIZE_WARN_BYTES} bytes — sinal de crescimento perto do limite de clipping do Gmail (#5232, warning-only)`,
    source_issue: "#5232",
    stage: 4,
    run: checkNewsletterHtmlSize,
  },
  {
    id: "kit-html-too-large",
    description: `_internal/newsletter-final-kit.html acima de ${KIT_HTML_SIZE_ERROR_BYTES} bytes (102 KB) — limite de clipping do Gmail, pixel de abertura do Kit ficaria abaixo do corte (#6506, error só quando backend ativo é "kit"; warning até lá)`,
    source_issue: "#6506",
    stage: 4,
    run: checkKitHtmlSize,
  },
  {
    id: "kit-fixture-audit",
    description: "assinante de fixture de teste (ex: ana@example.com) ATIVO na base Kit de produção (#6336)",
    source_issue: "#6336",
    stage: 4,
    run: checkKitFixtureAudit,
  },
  // #1694 finding 8: publication env-var checks movidas pra STAGE_5_RULES.
  // Facebook/LinkedIn tokens só são necessários no Stage 5 (Publicação) — não devem
  // bloquear a Revisão (Stage 4) quando tokens expirados ou não configurados.
];

// #2154: checkFbPageIdSet, checkFbTokenSet, checkLinkedinWorkerUrlSet,
// checkCloudflareTokenSet foram movidas para stage-5.ts — pertencem
// logicamente ao Stage 5 (Publicação).
// #2154 pass-2: checkConsentBinding removida deste arquivo — definição canônica
// está em stage-5.ts (onde os dados que ela verifica, 05-published.json e
// 06-social-published.json, são de fato escritos). A cópia aqui era órfã:
// não estava em STAGE_4_RULES, e o teste importava desta cópia em vez da viva.
export {
  checkPublicImagesPopulated,
  checkSocialHashFresh,
  checkImageContentFresh,
  checkEiaCreditSynced,
  checkIntroCountConsistent,
  checkNarrativeNotGenericPlaceholder,
  checkIntentionalErrorPresentInFinal,
  checkTruncatedSecondaryItemSummary,
  checkTitlePublisherSuffixInvariant,
  checkTitleTrailingPeriodInvariant,
  checkNoTrailingEllipsisInvariant,
  checkTitleMentionsIaInvariant,
  checkCaptureFailedSubmissionCount,
  checkCropReviewWarnings,
  checkBoxDivulgacaoAltMissing,
  checkCard4x5UploadMismatch,
  checkCarouselCardsMissing,
  checkCarouselCardsStale,
  checkCarouselUploadIncomplete,
  checkCarouselUploadStale,
  checkCarouselTextOverflow,
  checkBoxDivulgacaoRuntimeExcluded,
  checkRenderWarnings,
  checkKitFixtureAudit,
};
