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
import {
  extractDestaqueUrls,
  extractPromptUrl,
} from "../../match-prompts-to-destaques.ts";
import { urlsMatch } from "../url-utils.ts";

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

  // Social 1x1 keys — required for LinkedIn/Facebook (DLQ incident #999).
  for (const key of ["d1", "d2", "d3"]) {
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
  for (const key of ["cover", "d2_2x1", "d3_2x1"]) {
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
/**
 * #1575: garante que canais com consent=auto realmente dispatcharam (não
 * foram silenciosamente skipados pra manual paste). Caso 260529: editor
 * respondeu "Tudo automático" no consent gate, mas orchestrator bypassou
 * Chrome MCP do Beehiiv e apresentou instruções de paste manual.
 *
 * Roda apenas se 05-publish-consent.json existe. Compara cada canal
 * (newsletter, linkedin, facebook) contra evidência de dispatch:
 *   - newsletter consent=auto → 05-published.json deve ter draft_url ou
 *     post_id (status != pending_manual)
 *   - linkedin consent=auto → 06-social-published.json deve ter posts[]
 *     da plataforma linkedin com url ou status != pending_manual
 *   - facebook consent=auto → idem para facebook
 */
function checkConsentBinding(editionDir: string): InvariantViolation[] {
  const consentPath = resolve(editionDir, "_internal", "05-publish-consent.json");
  if (!existsSync(consentPath)) return [];
  let consent: { newsletter?: string; linkedin?: string; facebook?: string };
  try {
    consent = JSON.parse(readFileSync(consentPath, "utf8"));
  } catch (e) {
    return [
      {
        rule: "consent-binding-parseable",
        message: `05-publish-consent.json não parseável: ${(e as Error).message}`,
        source_issue: "#1575",
        severity: "error",
        file: consentPath,
      },
    ];
  }
  const violations: InvariantViolation[] = [];

  // Newsletter check
  if (consent.newsletter === "auto") {
    const publishedPath = resolve(editionDir, "_internal", "05-published.json");
    if (!existsSync(publishedPath)) {
      violations.push({
        rule: "consent-binding-newsletter",
        message:
          `consent.newsletter="auto" mas 05-published.json ausente — dispatch ` +
          `Beehiiv (Chrome MCP) não rodou. Editor escolheu auto; bypass pra manual paste viola contrato.`,
        source_issue: "#1575",
        severity: "error",
        file: publishedPath,
      });
    } else {
      try {
        const pub = JSON.parse(readFileSync(publishedPath, "utf8")) as {
          status?: string;
          draft_url?: string;
          post_id?: string;
        };
        if (pub.status === "pending_manual" || (!pub.draft_url && !pub.post_id)) {
          violations.push({
            rule: "consent-binding-newsletter",
            message:
              `consent.newsletter="auto" mas 05-published.json tem status="${pub.status ?? "?"}" ` +
              `sem draft_url/post_id — dispatch automático não aconteceu.`,
            source_issue: "#1575",
            severity: "error",
            file: publishedPath,
          });
        }
      } catch (e) {
        violations.push({
          rule: "consent-binding-newsletter",
          message: `05-published.json não parseável: ${(e as Error).message}`,
          source_issue: "#1575",
          severity: "error",
          file: publishedPath,
        });
      }
    }
  }

  // Social check (linkedin + facebook)
  const socialPath = resolve(editionDir, "_internal", "06-social-published.json");
  if (consent.linkedin === "auto" || consent.facebook === "auto") {
    if (!existsSync(socialPath)) {
      const channels = [
        consent.linkedin === "auto" ? "linkedin" : null,
        consent.facebook === "auto" ? "facebook" : null,
      ].filter(Boolean);
      violations.push({
        rule: "consent-binding-social",
        message:
          `consent.{${channels.join(",")}}=auto mas 06-social-published.json ausente — dispatch social não rodou.`,
        source_issue: "#1575",
        severity: "error",
        file: socialPath,
      });
    } else {
      try {
        const social = JSON.parse(readFileSync(socialPath, "utf8")) as {
          posts?: Array<{ platform?: string; status?: string; url?: string }>;
        };
        const posts = social.posts ?? [];
        for (const platform of ["linkedin", "facebook"] as const) {
          if (consent[platform] !== "auto") continue;
          const platformPosts = posts.filter(
            (p) => p.platform === platform,
          );
          if (platformPosts.length === 0) {
            violations.push({
              rule: `consent-binding-${platform}`,
              message:
                `consent.${platform}="auto" mas posts[platform="${platform}"] ` +
                `vazio em 06-social-published.json.`,
              source_issue: "#1575",
              severity: "error",
              file: socialPath,
            });
            continue;
          }
          // #1664/#1682: existir não basta — dispatch real exige um status de
          // dispatch RECONHECIDO. NÃO usar url como sinal: o LinkedIn auto-dispatch
          // (route worker_queue) grava url=null no write — a URL só existe depois
          // que o Worker dispara o agendado, então !url dava false-positive em
          // TODA edição real (260525-260601).
          //
          // #1682: ALLOWLIST (não blacklist). O blacklist anterior
          // (`every(p => !p.status || p.status === "pending_manual")`) tinha 2
          // frestas: (a) bypass PARCIAL passava — dispatcha 1 de 3 e deixa 2
          // pending_manual → `.every` false → nenhuma violation (o exato
          // silent-bypass que o #1575 pega); (b) status off-enum ("skipped") é
          // truthy != pending_manual → tratado como dispatched. Agora: viola se
          // QUALQUER post não tem status de dispatch reconhecido. `failed` fica no
          // allowlist (foi tentado; o sibling social-published-no-failed em stage-5
          // cobre a falha).
          const DISPATCH_STATUSES = new Set(["scheduled", "draft", "published", "failed"]);
          const notFullyDispatched = !platformPosts.every(
            (p) => p.status != null && DISPATCH_STATUSES.has(p.status),
          );
          if (notFullyDispatched) {
            violations.push({
              rule: `consent-binding-${platform}`,
              message:
                `consent.${platform}="auto" mas nem todos os posts[platform="${platform}"] ` +
                `têm status de dispatch (scheduled/draft/published/failed) — ` +
                `dispatch automático parcial ou ausente (status: ${platformPosts.map((p) => p.status ?? "ausente").join(", ")}).`,
              source_issue: "#1575",
              severity: "error",
              file: socialPath,
            });
          }
        }
      } catch (e) {
        violations.push({
          rule: "consent-binding-social",
          message: `06-social-published.json não parseável: ${(e as Error).message}`,
          source_issue: "#1575",
          severity: "error",
          file: socialPath,
        });
      }
    }
  }
  return violations;
}

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
 * `FACEBOOK_PAGE_ID` env var deve estar setada — publish-facebook usa pra postar
 * via Graph API. Nome confirmado em scripts/publish-facebook.ts:376.
 */
function checkFbPageIdSet(): InvariantViolation[] {
  if (!process.env.FACEBOOK_PAGE_ID || process.env.FACEBOOK_PAGE_ID.trim().length === 0) {
    return [
      {
        rule: "facebook-page-id-set",
        message:
          "FACEBOOK_PAGE_ID env var ausente — publish-facebook vai falhar. " +
          "Configure em .env.local.",
        source_issue: "#facebook",
        severity: "error",
      },
    ];
  }
  return [];
}

/**
 * `FACEBOOK_PAGE_ACCESS_TOKEN` deve estar setado. Nome confirmado em
 * scripts/publish-facebook.ts:377.
 */
function checkFbTokenSet(): InvariantViolation[] {
  if (
    !process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN.trim().length === 0
  ) {
    return [
      {
        rule: "facebook-token-set",
        message: "FACEBOOK_PAGE_ACCESS_TOKEN ausente — Facebook publishing vai falhar",
        source_issue: "#facebook",
        severity: "error",
      },
    ];
  }
  return [];
}

/**
 * `DIARIA_LINKEDIN_CRON_URL` deve estar setado — publish-linkedin envia
 * agendamento pro Cloudflare Worker. Sem ele, fallback é Make webhook
 * (#971 com graceful degrade). Nome confirmado em
 * scripts/publish-linkedin.ts:305.
 */
function checkLinkedinWorkerUrlSet(): InvariantViolation[] {
  const url = process.env.DIARIA_LINKEDIN_CRON_URL;
  if (!url || url.trim().length === 0) {
    return [
      {
        rule: "linkedin-worker-url-set",
        message:
          "DIARIA_LINKEDIN_CRON_URL env var ausente — publish-linkedin cai pra Make webhook " +
          "(post imediato, sem agendamento). Configure em .env.local pra evitar.",
        source_issue: "#971",
        severity: "warning",
      },
    ];
  }
  if (!/^https:\/\//.test(url)) {
    return [
      {
        rule: "linkedin-worker-url-https",
        message: `DIARIA_LINKEDIN_CRON_URL deve ser HTTPS, recebido: "${url.slice(0, 50)}"`,
        source_issue: "#971",
        severity: "error",
      },
    ];
  }
  return [];
}

/**
 * `DIARIA_LINKEDIN_CRON_TOKEN` deve estar setado — autoriza POST pro worker.
 * Nome confirmado em scripts/publish-linkedin.ts:308.
 */
function checkCloudflareTokenSet(): InvariantViolation[] {
  if (
    !process.env.DIARIA_LINKEDIN_CRON_TOKEN ||
    process.env.DIARIA_LINKEDIN_CRON_TOKEN.trim().length === 0
  ) {
    return [
      {
        rule: "linkedin-worker-token-set",
        message:
          "DIARIA_LINKEDIN_CRON_TOKEN ausente — publish-linkedin não consegue autenticar no worker " +
          "(cai pra Make webhook).",
        source_issue: "#971",
        severity: "warning",
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
  // #1694 finding 8: publication env-var checks movidas pra STAGE_5_RULES.
  // Facebook/LinkedIn tokens só são necessários no Stage 5 (Publicação) — não devem
  // bloquear a Revisão (Stage 4) quando tokens expirados ou não configurados.
];

export {
  checkPublicImagesPopulated,
  checkSocialHashFresh,
  checkImageContentFresh,
  checkIntroCountConsistent,
  checkConsentBinding,
  checkFbPageIdSet,
  checkFbTokenSet,
  checkLinkedinWorkerUrlSet,
  checkCloudflareTokenSet,
};
