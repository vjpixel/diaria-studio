/**
 * facebook-pages.ts (#10458)
 *
 * Fonte única das páginas do Facebook em que a pipeline publica. Antes deste
 * módulo o sistema só conhecia UMA página (`FACEBOOK_PAGE_ID` +
 * `FACEBOOK_PAGE_ACCESS_TOKEN`, com fallback `data/.fb-credentials.json`),
 * lida direto em ~9 scripts. Agora a lista vive em `platform.config.json` →
 * `publishing.social.facebook.pages`, cada página com:
 *
 *   - `slug`        — identificador estável (`diaria`, `memelab`). Vai no campo
 *                     `page` das entradas de `06-social-published.json`.
 *   - `enabled`     — liga/desliga sem mexer em código. Desligada = pulada sem
 *                     ruído (nem warning).
 *   - `page_id_env` / `token_env` — NOMES das env vars (nunca o valor — repo é
 *                     público). A `diaria` mantém `FACEBOOK_PAGE_ID` /
 *                     `FACEBOOK_PAGE_ACCESS_TOKEN` (sem migração de segredo).
 *   - `utm_content` — tag de atribuição acrescentada aos links do projeto no
 *                     post dessa página. Ausente → `page-{slug}`; `null`
 *                     explícito → nenhuma tag. A `diaria` vem com `null` no
 *                     config pra que o post da página atual saia byte a byte
 *                     igual ao de antes deste módulo (a ausência da tag
 *                     identifica a `diaria`); trocar pra `"page-diaria"` é só
 *                     editar o config.
 *
 * Config sem a chave `pages` → fallback de compat: uma página `diaria`
 * habilitada lendo as env vars de sempre (comportamento pré-#10458).
 *
 * Fallback `data/.fb-credentials.json` (legado) vale SÓ pra página default
 * (`diaria`) — é a credencial antiga dela, nunca de outra página.
 *
 * Entrada de `06-social-published.json` sem `page` é lida como `diaria`
 * (`resolvePostPage`) — edições publicadas antes deste módulo seguem válidas.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { composeUtmContentOnProjectLinks } from "./use-melhor-dispatch.ts";
import { DEFAULT_FACEBOOK_PAGE_SLUG, resolvePostPage } from "./social-published-store.ts";

export { DEFAULT_FACEBOOK_PAGE_SLUG, resolvePostPage };

export const DEFAULT_FACEBOOK_API_VERSION = "v25.0";

/** Formato de uma página em `publishing.social.facebook.pages`. */
export interface FacebookPageConfig {
  slug: string;
  enabled: boolean;
  page_id_env: string;
  token_env: string;
  /** Ausente → `page-{slug}`; `null` → sem tag. */
  utm_content?: string | null;
  note?: string;
}

/** Página resolvida (config + credencial). `missing` lista o que falta. */
export interface ResolvedFacebookPage {
  slug: string;
  enabled: boolean;
  pageId: string;
  token: string;
  /** Nomes das env vars ausentes (vazio = credencial completa). Nunca valores. */
  missing: string[];
  /** Tag `utm_content` efetiva (`null` = nenhuma). */
  utmContent: string | null;
}

export interface FacebookCredentialsFile {
  page_id?: string;
  page_access_token?: string;
  api_version?: string;
}

const LEGACY_DEFAULT_PAGE: FacebookPageConfig = {
  slug: DEFAULT_FACEBOOK_PAGE_SLUG,
  enabled: true,
  page_id_env: "FACEBOOK_PAGE_ID",
  token_env: "FACEBOOK_PAGE_ACCESS_TOKEN",
  utm_content: null,
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Pure: lê e valida `publishing.social.facebook.pages`. Config sem a chave →
 * `[LEGACY_DEFAULT_PAGE]`. Formato inválido (slug duplicado/malformado, env
 * var ausente) LANÇA — config quebrado não pode virar "publica em lugar
 * nenhum" em silêncio.
 */
export function loadFacebookPagesConfig(config: unknown): FacebookPageConfig[] {
  const raw = (config as any)?.publishing?.social?.facebook?.pages;
  if (raw === undefined) return [{ ...LEGACY_DEFAULT_PAGE }];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("[facebook-pages] publishing.social.facebook.pages precisa ser uma lista não vazia (#10458).");
  }
  const seen = new Set<string>();
  return raw.map((p: any, i: number) => {
    const where = `publishing.social.facebook.pages[${i}]`;
    if (typeof p?.slug !== "string" || !SLUG_RE.test(p.slug)) {
      throw new Error(`[facebook-pages] ${where}.slug inválido (${JSON.stringify(p?.slug)}) — use minúsculas, dígitos e hífen.`);
    }
    if (seen.has(p.slug)) throw new Error(`[facebook-pages] slug duplicado: "${p.slug}".`);
    seen.add(p.slug);
    if (typeof p.enabled !== "boolean") throw new Error(`[facebook-pages] ${where}.enabled precisa ser boolean.`);
    for (const k of ["page_id_env", "token_env"] as const) {
      if (typeof p[k] !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(p[k])) {
        throw new Error(`[facebook-pages] ${where}.${k} precisa ser o NOME de uma env var (ex: FACEBOOK_PAGE_ID).`);
      }
    }
    if (p.utm_content !== undefined && p.utm_content !== null && (typeof p.utm_content !== "string" || !p.utm_content.trim())) {
      throw new Error(`[facebook-pages] ${where}.utm_content precisa ser string não vazia ou null.`);
    }
    return {
      slug: p.slug,
      enabled: p.enabled,
      page_id_env: p.page_id_env,
      token_env: p.token_env,
      ...(p.utm_content !== undefined ? { utm_content: p.utm_content } : {}),
    };
  });
}

/** Pure: tag efetiva de uma página (ausente → `page-{slug}`, null → null). */
export function effectiveUtmContent(page: Pick<FacebookPageConfig, "slug" | "utm_content">): string | null {
  if (page.utm_content === undefined) return `page-${page.slug}`;
  return page.utm_content;
}

/**
 * Pure: resolve credencial de cada página (TODAS, habilitadas ou não — o
 * caller filtra). `env` e `fileCreds` injetáveis. O fallback de arquivo vale
 * só pra página default.
 */
export function resolveFacebookPages(
  pages: FacebookPageConfig[],
  env: Record<string, string | undefined>,
  fileCreds: FacebookCredentialsFile = {},
): ResolvedFacebookPage[] {
  return pages.map((p) => {
    const isDefault = p.slug === DEFAULT_FACEBOOK_PAGE_SLUG;
    const pageId = env[p.page_id_env] || (isDefault ? fileCreds.page_id : "") || "";
    const token = env[p.token_env] || (isDefault ? fileCreds.page_access_token : "") || "";
    const missing: string[] = [];
    if (!pageId) missing.push(p.page_id_env);
    if (!token) missing.push(p.token_env);
    return { slug: p.slug, enabled: p.enabled, pageId, token, missing, utmContent: effectiveUtmContent(p) };
  });
}

/** Lê `data/.fb-credentials.json` (legado) best-effort — ausente/corrompido → `{}`. */
export function readFacebookCredentialsFile(root: string): FacebookCredentialsFile {
  try {
    return JSON.parse(readFileSync(resolve(root, "data/.fb-credentials.json"), "utf8")) as FacebookCredentialsFile;
  } catch {
    return {};
  }
}

/** Versão da Graph API: env > arquivo legado > default. */
export function resolveFacebookApiVersion(
  env: Record<string, string | undefined>,
  fileCreds: FacebookCredentialsFile = {},
): string {
  return env.FACEBOOK_API_VERSION || fileCreds.api_version || DEFAULT_FACEBOOK_API_VERSION;
}

/**
 * Conveniência I/O: config + env + arquivo legado → páginas resolvidas.
 * Lança só se o config for inválido (ver `loadFacebookPagesConfig`).
 */
export function loadResolvedFacebookPages(
  root: string,
  config: unknown,
  env: Record<string, string | undefined> = process.env,
): { pages: ResolvedFacebookPage[]; apiVersion: string } {
  const fileCreds = readFacebookCredentialsFile(root);
  return {
    pages: resolveFacebookPages(loadFacebookPagesConfig(config), env, fileCreds),
    apiVersion: resolveFacebookApiVersion(env, fileCreds),
  };
}

/**
 * Resolução da página de uma entrada já gravada em `06-social-published.json`
 * (#10458 follow-up). Usado por quem age sobre um post que JÁ existe
 * (verificar, deletar, reconciliar) — por isso ignora `enabled`: desligar a
 * página no config não faz o post agendado sumir dela, e o token dela ainda é
 * o único que enxerga/deleta esse post.
 */
export type FacebookEntryPageResolution =
  | { ok: true; slug: string; page: ResolvedFacebookPage }
  | { ok: false; slug: string; reason: "unknown_fb_page" }
  | { ok: false; slug: string; reason: "missing_fb_credentials"; missing: string[] };

/** Pure: página (com credencial) de uma entrada — sem `page` = `diaria`. */
export function resolveFacebookPageForEntry(
  entry: { page?: unknown },
  pages: ResolvedFacebookPage[],
): FacebookEntryPageResolution {
  const slug = resolvePostPage(entry);
  const page = pages.find((p) => p.slug === slug);
  if (!page) return { ok: false, slug, reason: "unknown_fb_page" };
  if (page.missing.length > 0) return { ok: false, slug, reason: "missing_fb_credentials", missing: page.missing };
  return { ok: true, slug, page };
}

/**
 * Pure: chave de upsert/idempotência de uma entrada do Facebook —
 * `(platform, destaque, subtype, page)`, a mesma de `appendSocialPosts`.
 * Pra quem precisa casar resultado → entrada (ex: `delete-test-schedules.ts`)
 * sem colapsar as duas páginas na mesma chave.
 */
export function socialEntryKey(entry: { platform: string; destaque: string; subtype?: unknown; page?: unknown }): string {
  const subtype = typeof entry.subtype === "string" && entry.subtype ? entry.subtype : "main";
  return `${entry.platform}|${entry.destaque}|${subtype}|${resolvePostPage(entry)}`;
}

/** Pure: só as páginas habilitadas no config (com ou sem credencial). */
export function enabledFacebookPages(pages: ResolvedFacebookPage[]): ResolvedFacebookPage[] {
  return pages.filter((p) => p.enabled);
}

/**
 * Pure: rótulo de log por página — a default mantém o formato de sempre
 * (`facebook/d1`), as outras ganham o slug (`facebook[memelab]/d1`).
 */
export function facebookPageLabel(slug: string, destaque: string): string {
  return slug === DEFAULT_FACEBOOK_PAGE_SLUG ? `facebook/${destaque}` : `facebook[${slug}]/${destaque}`;
}

/**
 * Pure: acrescenta a tag da página ao `utm_content` dos links do projeto no
 * texto do post, compondo com um `utm_content` já presente (o 4º post USE
 * MELHOR usa `usemelhor` → vira `usemelhor_page-memelab`). Tag `null` → texto
 * intacto.
 */
export function applyFacebookPageUtm(text: string, page: Pick<ResolvedFacebookPage, "utmContent">): string {
  if (!page.utmContent) return text;
  return composeUtmContentOnProjectLinks(text, page.utmContent);
}
