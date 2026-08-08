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
 *   GET /sitemap.xml        → sitemap vazio válido (#4546 achado lateral —
 *                              antes disto, o catch-all tratava "sitemap.xml"
 *                              como se fosse um {cycle} e servia o form de
 *                              e-mail com 200, confundindo crawler. Todo o
 *                              conteúdo deste Worker é gated por allowlist
 *                              de apoiador — não há URL pública indexável
 *                              pra declarar, então vazio é o valor correto,
 *                              não um erro de implementação)
 *   GET /robots.txt         → robots.txt PRÓPRIO (#4777) — substitui o
 *                              default gerenciado pela Cloudflare, que
 *                              bloqueava os 7 crawlers de assistente/treino
 *                              contra a decisão do editor de 03/ago
 *                              (CLAUDE.md). `Sitemap:` aponta pro
 *                              `/sitemap.xml` (vazio) acima — mesmo host,
 *                              mesma semântica "sem URL indexável hoje".
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
import { renderCuradoriaRobotsTxt } from "../../../scripts/lib/shared/robots-txt.ts"; // #4777

/** Host público deste Worker — usado só pra montar a `Sitemap:` do robots.txt. */
const ARTIGO_MENSAL_HOST = "https://artigo.diar.ia.br";

export interface Env {
  ARTICLES: KVNamespace;
  ALLOWLIST: KVNamespace;
}

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" } as const;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML_HEADERS });
}

/**
 * Sitemap vazio válido (#4546 achado lateral). Este Worker não tem NENHUMA
 * URL pública indexável — todo `/{cycle}` é gated por allowlist de
 * apoiador — então um `<urlset>` sem `<url>` é o dado correto, não um erro:
 * distinto tanto de um 404 quanto de servir o form de e-mail como se fosse
 * conteúdo de sitemap.
 */
const EMPTY_SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>
`;

function sitemapResponse(): Response {
  return new Response(EMPTY_SITEMAP_XML, {
    status: 200,
    headers: { "Content-Type": "application/xml;charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

/**
 * `robots.txt` PRÓPRIO (#4777) — mesmo mecanismo/racional de
 * `workers/arquivo` (`renderCuradoriaRobotsTxt`, `scripts/lib/shared/robots-txt.ts`,
 * #4546). `Sitemap:` aponta pro `/sitemap.xml` deste próprio host (vazio,
 * ver `EMPTY_SITEMAP_XML` acima) — declará-lo não muda a semântica "nenhuma
 * URL indexável hoje", só evita que o crawler descubra o robots.txt e ache
 * que não há sitemap nenhum.
 */
const ARTIGO_MENSAL_ROBOTS_TXT = renderCuradoriaRobotsTxt(`${ARTIGO_MENSAL_HOST}/sitemap.xml`);

function robotsResponse(): Response {
  return new Response(ARTIGO_MENSAL_ROBOTS_TXT, {
    status: 200,
    headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
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
    if (url.pathname === "/sitemap.xml") {
      return sitemapResponse();
    }
    if (url.pathname === "/robots.txt") {
      return robotsResponse();
    }
    return handleGet(url, env);
  },
};

// Re-exportado só pra conveniência de teste direto (evita reimplementar
// normalização em test doubles).
export { normalizeEmail };
