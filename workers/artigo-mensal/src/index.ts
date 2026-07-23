/**
 * workers/artigo-mensal/src/index.ts (#3940)
 *
 * Serve o artigo mensal público com paywall dinâmico de apoiador (R$10+/mês,
 * mês vigente) — Opção B da issue #3940 (allowlist de e-mails em KV + login
 * por e-mail, decisão do editor, não reaberta aqui).
 *
 * O HTML do artigo é PRÉ-RENDERIZADO no Node-side (`scripts/build-article-page.ts`,
 * reusa `draftToEmail` de `scripts/lib/mensal/monthly-render.ts` — o mesmo
 * pipeline testado do envio Brevo mensal) e vive no KV `ARTICLES` sob a
 * chave `article:{cycle}`. Este Worker NUNCA faz parsing de markdown — só:
 *
 *   1. resolve a allowlist do KV `ALLOWLIST` (chave `emails`, JSON array de
 *      e-mails normalizados — escrita por `scripts/build-apoiador-allowlist.ts`)
 *   2. decide o gate (`src/gate.ts`, puro — `decideGate`)
 *   3. serve: artigo completo (KV `ARTICLES`) | form de e-mail | paywall | 404
 *
 * Rotas:
 *   GET /{cycle}            → sem `?email=` (ou vazio): form de e-mail
 *   GET /{cycle}?email=...  → e-mail na allowlist: artigo completo
 *                              e-mail FORA da allowlist: paywall
 *   GET /                   → 400 (ciclo obrigatório)
 *   * outros métodos        → 405
 *
 * Fail-closed (#3940, invariante central): qualquer falha ao ler o KV
 * `ALLOWLIST` (exception, JSON malformado, shape inesperado) é tratada IGUAL
 * a "allowlist ausente" (`null`, ver `parseAllowlist`) — nunca serve o
 * artigo por erro. Erro ao ler `ARTICLES` (worker/namespace fora do ar)
 * também nunca vaza o e-mail-form/paywall — vira 404 dedicado, distinto do
 * paywall (o leitor já provou ser apoiador; o problema é o conteúdo, não o
 * acesso).
 */

import { normalizeEmail, parseAllowlist, decideGate } from "./gate.ts";
import {
  renderEmailForm,
  renderPaywall,
  renderCycleNotFound,
  renderMissingCycle,
} from "./render.ts";

export interface Env {
  ARTICLES: KVNamespace;
  ALLOWLIST: KVNamespace;
}

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" } as const;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML_HEADERS });
}

/** Lê + parseia a allowlist do KV. Qualquer falha (exception incluída) → `null` (fail-closed). */
export async function loadAllowlist(env: Env): Promise<string[] | null> {
  try {
    const raw = await env.ALLOWLIST.get("emails");
    return parseAllowlist(raw);
  } catch {
    return null;
  }
}

/** Lê o HTML pré-renderizado do artigo pro ciclo. `null` se ausente ou erro de leitura. */
export async function loadArticle(env: Env, cycle: string): Promise<string | null> {
  try {
    return await env.ARTICLES.get(`article:${cycle}`);
  } catch {
    return null;
  }
}

/** Extrai o ciclo do path (`/2607-08` → `"2607-08"`). `""` se path vazio (`/`). */
export function extractCycle(pathname: string): string {
  return decodeURIComponent(pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
}

export async function handleGet(url: URL, env: Env): Promise<Response> {
  const cycle = extractCycle(url.pathname);
  if (!cycle) {
    return htmlResponse(renderMissingCycle(), 400);
  }

  const emailParam = url.searchParams.get("email");
  const allowlist = await loadAllowlist(env);
  const gate = decideGate(emailParam, allowlist);

  if (gate.state === "no_email") {
    return htmlResponse(renderEmailForm(cycle));
  }

  if (gate.state === "not_backer") {
    return htmlResponse(renderPaywall());
  }

  // gate.state === "allowed" — o e-mail provou ser apoiador R$10+. O artigo
  // ainda assim pode não existir pra esse ciclo (ciclo errado, ou ainda não
  // publicado) — 404 dedicado, NÃO paywall (o problema aqui é o conteúdo).
  const article = await loadArticle(env, cycle);
  if (!article) {
    return htmlResponse(renderCycleNotFound(cycle), 404);
  }
  return htmlResponse(article);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") {
      return new Response(
        JSON.stringify({ error: "method not allowed", allowed: ["GET"] }),
        { status: 405, headers: { "Content-Type": "application/json" } },
      );
    }
    const url = new URL(request.url);
    return handleGet(url, env);
  },
};

// Re-exportado só pra conveniência de teste direto (evita reimplementar
// normalização em test doubles).
export { normalizeEmail };
