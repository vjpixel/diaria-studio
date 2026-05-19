/**
 * Invariants de Stage 4 — Publicação (#1007 Fase 1).
 *
 * Última barreira antes de invocar publishers. Falha aqui = catastrófica
 * (publicação corrompida, broadcast vazio). Checks aqui devem ser strict.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantRule, InvariantViolation } from "./types.ts";

interface PublicImageEntry {
  url?: string;
  file_id?: string;
  filename?: string;
}

interface PublicImagesJson {
  images?: {
    d1?: PublicImageEntry;
    d2?: PublicImageEntry;
    d3?: PublicImageEntry;
  };
}

/**
 * `06-public-images.json` deve ter URLs Drive públicas pra d1, d2, d3
 * (1x1 cada — formato consumido por LinkedIn + Facebook). Sem isso,
 * publish-linkedin envia image_url=null e Make rejeita (DLQ incident 260508).
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
  for (const key of ["d1", "d2", "d3"] as const) {
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
  return violations;
}

/**
 * #1413: valida que as URLs dos highlights em `_internal/01-approved.json`
 * aparecem em `03-social.md`. Cobre o cenário onde editor reestrutura
 * destaques pós-Stage 2 (move D1→D2, troca D1 por novo macro etc) sem
 * re-disparar `social-linkedin` + `social-facebook`. Sem este check,
 * Stage 4 publica posts com hooks de destaques antigos enquanto a
 * newsletter sai com os novos — contradição cross-channel.
 *
 * Detecção determinística: cada highlight.url do approved.json deve
 * aparecer no 03-social.md. URLs não paraphraseiam — se falta, social
 * ficou stale.
 *
 * Caso real 260520: D1 mudou de Karpathy → Google I/O, mas 03-social.md
 * continuou com hook Karpathy. Editor notou manualmente.
 */
export interface ApprovedHighlight {
  title_options?: string[];
  url?: string;
  category?: string;
}

interface ApprovedJson {
  highlights?: ApprovedHighlight[];
}

function checkSocialMatchesApprovedHighlights(editionDir: string): InvariantViolation[] {
  const approvedPath = resolve(editionDir, "_internal", "01-approved.json");
  const socialPath = resolve(editionDir, "03-social.md");

  if (!existsSync(approvedPath)) return []; // Stage 1 incomplete — outro check pega.
  if (!existsSync(socialPath)) return []; // Stage 2 incomplete — outro check pega.

  let approved: ApprovedJson;
  try {
    approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
  } catch (e) {
    return [
      {
        rule: "social-matches-highlights-parseable",
        message: `01-approved.json não parseável: ${(e as Error).message}`,
        source_issue: "#1413",
        severity: "error",
        file: approvedPath,
      },
    ];
  }

  const highlights = Array.isArray(approved.highlights) ? approved.highlights : [];
  if (highlights.length === 0) return [];

  const socialMd = readFileSync(socialPath, "utf8");
  const violations: InvariantViolation[] = [];

  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i];
    const url = h.url?.trim();
    if (!url) continue; // highlight sem URL — não dá pra validar
    if (!socialMd.includes(url)) {
      const titleHint = h.title_options?.[0]?.slice(0, 60) ?? "(sem título)";
      violations.push({
        rule: "social-matches-highlights",
        message:
          `03-social.md não menciona URL do D${i + 1} (${titleHint}...): ${url}. ` +
          `Editor pode ter reestruturado destaques pós-Stage 2 sem re-rodar ` +
          `social-linkedin/social-facebook. Re-dispatch antes de publicar.`,
        source_issue: "#1413",
        severity: "error",
        file: socialPath,
      });
    }
  }

  return violations;
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
    id: "social-matches-highlights",
    description: "03-social.md tem URLs de todos highlights aprovados (#1413)",
    source_issue: "#1413",
    stage: 4,
    run: checkSocialMatchesApprovedHighlights,
  },
  {
    id: "facebook-page-id-set",
    description: "FACEBOOK_PAGE_ID env var presente",
    source_issue: "#facebook",
    stage: 4,
    run: () => checkFbPageIdSet(),
  },
  {
    id: "facebook-token-set",
    description: "FACEBOOK_PAGE_ACCESS_TOKEN env var presente",
    source_issue: "#facebook",
    stage: 4,
    run: () => checkFbTokenSet(),
  },
  {
    id: "linkedin-worker-url-set",
    description: "DIARIA_LINKEDIN_CRON_URL env var presente e HTTPS (#971)",
    source_issue: "#971",
    stage: 4,
    run: () => checkLinkedinWorkerUrlSet(),
  },
  {
    id: "linkedin-worker-token-set",
    description: "DIARIA_LINKEDIN_CRON_TOKEN env var presente (#971)",
    source_issue: "#971",
    stage: 4,
    run: () => checkCloudflareTokenSet(),
  },
];

export {
  checkPublicImagesPopulated,
  checkSocialMatchesApprovedHighlights,
  checkFbPageIdSet,
  checkFbTokenSet,
  checkLinkedinWorkerUrlSet,
  checkCloudflareTokenSet,
};
