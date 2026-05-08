/**
 * Invariants de Stage 4 — Publicação (#1007 Fase 1).
 *
 * Última barreira antes de invocar publishers. Falha aqui = catastrófica
 * (publicação corrompida, broadcast vazio). Checks aqui devem ser strict.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantRule, InvariantViolation } from "./types.ts";

interface PublicImagesJson {
  d1?: { square_url?: string; rectangle_url?: string };
  d2?: { square_url?: string };
  d3?: { square_url?: string };
}

/**
 * `06-public-images.json` deve ter URLs Drive públicas pra d1 (2x1 + 1x1),
 * d2 (1x1) e d3 (1x1). Sem isso, publish-linkedin envia image_url=null
 * e Make rejeita (DLQ incident 260508).
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
  const required: Array<{ key: keyof PublicImagesJson; field: string }> = [
    { key: "d1", field: "rectangle_url" },
    { key: "d1", field: "square_url" },
    { key: "d2", field: "square_url" },
    { key: "d3", field: "square_url" },
  ];
  for (const { key, field } of required) {
    const slot = data[key] as Record<string, string | undefined> | undefined;
    const url = slot?.[field];
    if (!url || typeof url !== "string" || url.trim().length === 0) {
      violations.push({
        rule: "public-images-populated",
        message: `06-public-images.json: ${key}.${field} ausente ou vazio`,
        source_issue: "#999",
        severity: "error",
        file: path,
      });
    } else if (!/^https?:\/\//.test(url)) {
      violations.push({
        rule: "public-images-url-shape",
        message: `06-public-images.json: ${key}.${field}="${url.slice(0, 50)}" não é URL válida`,
        source_issue: "#999",
        severity: "error",
        file: path,
      });
    }
  }
  return violations;
}

/**
 * `FB_PAGE_ID` env var deve estar setada — publish-facebook usa pra postar
 * via Graph API.
 */
function checkFbPageIdSet(): InvariantViolation[] {
  if (!process.env.FB_PAGE_ID || process.env.FB_PAGE_ID.trim().length === 0) {
    return [
      {
        rule: "fb-page-id-set",
        message:
          "FB_PAGE_ID env var ausente — publish-facebook vai falhar. " +
          "Configure em .env.local.",
        source_issue: "#facebook",
        severity: "error",
      },
    ];
  }
  return [];
}

/**
 * `FB_PAGE_ACCESS_TOKEN` deve estar setado.
 */
function checkFbTokenSet(): InvariantViolation[] {
  if (
    !process.env.FB_PAGE_ACCESS_TOKEN ||
    process.env.FB_PAGE_ACCESS_TOKEN.trim().length === 0
  ) {
    return [
      {
        rule: "fb-token-set",
        message: "FB_PAGE_ACCESS_TOKEN ausente — Facebook publishing vai falhar",
        source_issue: "#facebook",
        severity: "error",
      },
    ];
  }
  return [];
}

/**
 * `LINKEDIN_WORKER_URL` deve estar setado — publish-linkedin envia agendamento
 * pro Cloudflare Worker via HTTPS POST. Sem ele, fallback é Make webhook (já
 * deprecated #971) ou erro hard.
 */
function checkLinkedinWorkerUrlSet(): InvariantViolation[] {
  const url = process.env.LINKEDIN_WORKER_URL;
  if (!url || url.trim().length === 0) {
    return [
      {
        rule: "linkedin-worker-url-set",
        message:
          "LINKEDIN_WORKER_URL env var ausente — publish-linkedin não consegue enfileirar. " +
          "Configure em .env.local (URL do worker diar-ia-linkedin-fire).",
        source_issue: "#971",
        severity: "error",
      },
    ];
  }
  if (!/^https:\/\//.test(url)) {
    return [
      {
        rule: "linkedin-worker-url-https",
        message: `LINKEDIN_WORKER_URL deve ser HTTPS, recebido: "${url.slice(0, 50)}"`,
        source_issue: "#971",
        severity: "error",
      },
    ];
  }
  return [];
}

/**
 * `CLOUDFLARE_WORKERS_TOKEN` deve estar setado — autoriza POST pro worker.
 */
function checkCloudflareTokenSet(): InvariantViolation[] {
  if (
    !process.env.CLOUDFLARE_WORKERS_TOKEN ||
    process.env.CLOUDFLARE_WORKERS_TOKEN.trim().length === 0
  ) {
    return [
      {
        rule: "cloudflare-workers-token-set",
        message:
          "CLOUDFLARE_WORKERS_TOKEN ausente — publish-linkedin não consegue autenticar no worker.",
        source_issue: "#971",
        severity: "error",
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
    id: "fb-page-id-set",
    description: "FB_PAGE_ID env var presente",
    source_issue: "#facebook",
    stage: 4,
    run: () => checkFbPageIdSet(),
  },
  {
    id: "fb-token-set",
    description: "FB_PAGE_ACCESS_TOKEN env var presente",
    source_issue: "#facebook",
    stage: 4,
    run: () => checkFbTokenSet(),
  },
  {
    id: "linkedin-worker-url-set",
    description: "LINKEDIN_WORKER_URL env var presente e HTTPS (#971)",
    source_issue: "#971",
    stage: 4,
    run: () => checkLinkedinWorkerUrlSet(),
  },
  {
    id: "cloudflare-workers-token-set",
    description: "CLOUDFLARE_WORKERS_TOKEN env var presente (#971)",
    source_issue: "#971",
    stage: 4,
    run: () => checkCloudflareTokenSet(),
  },
];

export {
  checkPublicImagesPopulated,
  checkFbPageIdSet,
  checkFbTokenSet,
  checkLinkedinWorkerUrlSet,
  checkCloudflareTokenSet,
};
