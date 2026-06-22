/**
 * Invariants de Stage 4 — Publicação (#1007 Fase 1).
 *
 * Última barreira antes de invocar publishers. Falha aqui = catastrófica
 * (publicação corrompida, broadcast vazio). Checks aqui devem ser strict.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantRule, InvariantViolation } from "./types.ts";
import { hashFromApprovedFile } from "../social-source-hash.ts";
import { lintIntroCount } from "../newsletter-count.ts";
import { checkUseMelhorTempo } from "../lint-checks/use-melhor-tempo.ts";
import {
  extractDestaqueUrls,
  extractPromptUrl,
} from "../../match-prompts-to-destaques.ts";
import { urlsMatch } from "../url-utils.ts";
import { readDestaqueCount } from "./stage-3.ts";
import {
  extractIntentionalErrorFromMd,
  extractRevealFromFrontmatter,
  narrativeIsGenericPlaceholder,
  narrativeIsCatalogShaped,
  SECTION_HEADER,
} from "../../render-erro-intencional.ts";

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
 * + re-run de merge-social-md.ts. Caso 260520: D1 trocou de Karpathy pra
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
          `social-linkedin + social-facebook + re-run merge-social-md.ts E re-push pro Drive ` +
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
 *   2. (#2419 bug #2 fix) Narrativa no corpo ou frontmatter é catalog-shaped
 *      ("DESTAQUE N lista o Spotify…") — passa verde hoje, publica label interno.
 *   3. (#2419) Sem campo `reveal` dedicado E sem fonte válida de narrative →
 *      reveal da próxima edição seria o fallback genérico seguro.
 *
 * severity: "warning" (lints permanecem warning — re-block para error é follow-up).
 *
 * Remediação: preencher `intentional_error.reveal` no frontmatter com prosa first-person.
 * Campo `narrative` (legado) também aceito para back-compat.
 */
function checkNarrativeNotGenericPlaceholder(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");

  const REMEDIATION =
    `Preencha o campo \`intentional_error.reveal\` no frontmatter do MD com prosa ` +
    `first-person completa para o reveal público da próxima edição. ` +
    `Ex: "Na última edição, escrevi 1990 onde o correto é 1998."`;

  // 1. Verificação via extractIntentionalErrorFromMd (casos: narrative real mas genérico
  //    ou catalog-shaped que ainda escapou do filtro na extração do corpo).
  const extracted = extractIntentionalErrorFromMd(md);
  if (extracted?.narrative) {
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
    // (#2419 bug #2 fix) catalog-shaped escape — extractIntentionalErrorFromMd filtra corpo
    // catalog-shaped mas narrative pode vir do frontmatter `narrative` legado (bug #2).
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

  // 2. Quando extractIntentionalErrorFromMd retorna null (filtrou texto genérico/catalog),
  //    verificar diretamente o corpo do bloco ERRO INTENCIONAL.
  //    Isso cobre: editor escreveu só o convite genérico OU catalog-shaped no corpo,
  //    sem frontmatter `reveal`/`narrative` preenchido.
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
  // (#2438 DRY) Quando extracted é não-nulo, reutiliza extracted.reveal (já computado
  // por extractIntentionalErrorFromMd internamente via extractRevealFromFrontmatter)
  // em vez de chamar extractRevealFromFrontmatter de novo — o `??` dispara tanto quando
  // extracted é null quanto quando extracted.reveal é undefined (edições narrative-only
  // sem campo reveal), causando double-parse residual. Usar condicional explícita:
  // só parse o frontmatter quando extracted é null (o campo reveal pode ter valor
  // catalog/genérico que precisamos checar mesmo sem narrative válida).
  const reveal = extracted !== null ? extracted.reveal : extractRevealFromFrontmatter(md);
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
    id: "intro-count-consistent",
    description: "intro line Z = contagem real de items visíveis (#1578)",
    source_issue: "#1578",
    stage: 4,
    run: checkIntroCountConsistent,
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
  checkIntroCountConsistent,
  checkNarrativeNotGenericPlaceholder,
};
