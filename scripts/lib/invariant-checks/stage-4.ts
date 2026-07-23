/**
 * Invariants de Stage 4 — Publicação (#1007 Fase 1).
 *
 * Última barreira antes de invocar publishers. Falha aqui = catastrófica
 * (publicação corrompida, broadcast vazio). Checks aqui devem ser strict.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantRule, InvariantViolation } from "./types.ts";
import { readMarker } from "../pipeline-state.ts";
import { hashFromApprovedFile } from "../social-source-hash.ts";
import { lintIntroCount } from "../newsletter-count.ts";
import {
  extractEiaMirrorBlock,
  parseEiaMirrorBlock,
  parseEIA,
  fallbackEIA,
} from "../newsletter-parse.ts";
import { checkUseMelhorTempo } from "../lint-checks/use-melhor-tempo.ts";
import {
  checkTitlePublisherSuffix,
  checkTitleTrailingPeriod,
} from "../lint-checks/title-normalization.ts";
import { checkNoTrailingEllipsis } from "../lint-checks/no-trailing-ellipsis.ts";
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
import { loadIntentionalErrorJson, intentionalErrorJsonPath } from "../intentional-errors.ts";
import { checkHasNegativeImpactHighlight } from "./stage-1.ts"; // #3916, #3918

interface PublicImageEntry {
  url?: string;
  file_id?: string;
  filename?: string;
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
 * stale e precisa re-dispatch dos agents `social-linkedin` + `social-facebook`
 * + `social-instagram` (#3486) + re-run de merge-social-md.ts. Caso 260520: D1 trocou de Karpathy pra
 * Google I/O pós-Stage 2; social manteve hook Karpathy → contradição
 * cross-channel.
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
          `Editor reestruturou destaques pós-Stage 2. Re-dispatch agents ` +
          `social-linkedin + social-facebook + social-instagram (#3486) + re-run merge-social-md.ts E re-push pro Drive ` +
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
 * #2377/#2411/#2419 (rewrite): detecta quando a fonte do reveal para a PRÓXIMA edição
 * seria inválida — genérica, catalog-shaped (label interno "DESTAQUE N"), ou agramatical.
 *
 * Casos detectados:
 *   1. Narrativa "Nessa edição, …" no corpo é placeholder genérico (incidente #2377).
 *   2. (#2419 bug #2 fix) Narrativa no corpo ou no record (`_internal/intentional-error.json`,
 *      #3222) é catalog-shaped ("DESTAQUE N lista o Spotify…") — passa verde hoje, publica
 *      label interno.
 *   3. (#2419) Sem campo `reveal` dedicado E sem fonte válida de narrative →
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
  checkTruncatedSecondaryItemSummary,
  checkTitlePublisherSuffixInvariant,
  checkTitleTrailingPeriodInvariant,
  checkNoTrailingEllipsisInvariant,
  checkCaptureFailedSubmissionCount,
  checkCropReviewWarnings,
};
