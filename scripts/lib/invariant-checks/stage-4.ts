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
          `social-linkedin + social-facebook + re-run merge-social-md.ts antes de publicar.`,
        source_issue: "#1413",
        severity: "error",
        file: socialPath,
      },
    ];
  }

  return [];
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
  checkSocialHashFresh,
  checkFbPageIdSet,
  checkFbTokenSet,
  checkLinkedinWorkerUrlSet,
  checkCloudflareTokenSet,
};
