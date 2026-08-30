#!/usr/bin/env tsx
/**
 * lint-test-email-link-tracking.ts (#1248, follow-up de #1212)
 *
 * Verifica se todos os URLs no email respondem 200. Decoda redirects
 * de Gmail Image Proxy (`google.com/url?q=...`) e Beehiiv tracking
 * (`link.diaria.beehiiv.com/...`) antes do HEAD.
 *
 * Estratégia:
 * 1. Extrai URLs de hrefs no HTML do email.
 * 2. Para cada URL única, resolve até 3 redirects + HEAD.
 * 3. Reporta:
 *    - `link_dead` (blocker): HEAD final retorna 4xx/5xx (exceto 401/403) OU
 *      (#4604) o redirect final aterrissa em `/jogar?...&from=post-web` — ver
 *      rationale completo no header de `isPostWebRedirectTarget` abaixo.
 *      **#6819:** quando o HEAD retorna 4xx (exceto 401/403 — `bot_blocked`,
 *      e 429 — `rate_limited`, que já são skipados), o checker cai pra GET
 *      (mesmo padrão de `verify-accessibility.ts` #899). O Worker
 *      `eia.diar.ia.br/jogar` só tem handler pra GET — HEAD cai num 404 do
 *      router. Sem o fallback, o link do rodapé virava falso blocker toda
 *      edition. GET 200 → `passed`; GET também 4xx → `link_dead` de fato.
 *    - `link_timeout` (warning, #1949): HEAD demora >5s — transiente, NÃO blocker
 *    - `link_redirect_chain_long` (blocker): >3 hops até 200
 *
 * Skips (não viram issue, #1949):
 *    - `auth_required`: linkedin/facebook/x — exigem login
 *    - `bot_blocked`: 401/403 — página existe pra humanos, bloqueia HEAD de bot
 *      (diaria.beehiiv.com/cursos|livros, tecnoblog)
 *    - `rate_limited`: 429, QUALQUER domínio (#3941, mesmo princípio de #696 em
 *      verify-accessibility.ts) — rate limiting de crawler/anti-bot, não link
 *      morto. Caso confirmado: VentureBeat retorna 429 pra HEAD de bot desde
 *      sempre; página existe normalmente pra humanos. Post-mortem 260723
 *      (#3941): reportado como "link quebrado" quando na verdade era esse
 *      429 conhecido — falso-positivo confirmado.
 *    - `merge_tag`: URL com QUALQUER merge tag `{{...}}` (ex: `{{poll_token}}`,
 *      #4487 — era `{{email}}`/`{{poll_sig}}`) — Beehiiv expande no envio.
 *      `categorizeUrl` casa o padrão genericamente (não um nome de campo
 *      específico), então segue funcionando pra qualquer merge tag futura
 *      sem precisar editar este arquivo. **#4512: só skipado em
 *      `stage: "draft"`** (HTML de pré-render, onde a tag ainda não foi
 *      expandida por design). O caller real (`mainCli`, único hoje) sempre
 *      passa `stage: "delivered"` (e-mail JÁ ENTREGUE) — nesse estágio uma
 *      tag ainda literal é o DEFEITO que este linter existe pra pegar, não
 *      skipada: segue pro HEAD normal. **#4604:** o guard `isUnsubstitutedMergeTag`
 *      (workers/poll/src/vote.ts) deixou de retornar 4xx incondicionalmente a
 *      partir do #4578 — quando `edition` tem formato válido, ele agora
 *      responde 302 pro jogo anônimo (`/jogar?edition=...&from=post-web`) em
 *      vez do dead-end 400. Um HEAD que segue esse redirect vê status final
 *      200 (a página `/jogar` existe e funciona) — sem tratamento extra, o
 *      link apareceria como `passed`, mascarando a merge tag travada. Ver
 *      `isPostWebRedirectTarget` abaixo pro detector desse sinal indireto.
 *    - `non_http`/`tel_mailto`: protocolos não-http
 *    - Artefatos conhecidos de test-send (#3480/#3481/#3482, post-mortem 260716)
 *      — classificados via `classifyKnownArtifact`, sempre `skipped[]` (nunca
 *      `issues[]`), com `note` explicando o motivo:
 *      - `amazon_bot_block` (#3480): domínios Amazon retornam 404 (não
 *        401/403) pra HEAD de user-agent não-navegador — página existe pra
 *        humanos, não é link morto.
 *      - `font_degradation` (#3482): fonts.gstatic.com/fonts.googleapis.com
 *        podem retornar 404 em contexto de test send — degrada pra fallback
 *        de fonte do sistema, cosmético, não bloqueante.
 *      - `beehiiv_footer_artifact` (#3481): link de preferences/unsubscribe
 *        no rodapé Beehiiv (boilerplate injetado, fora do htmlSnippet, #1944)
 *        — carrega token de assinante que não resolve em test send (sem
 *        subscription real).
 *      A allowlist é por domínio/padrão específico — links REALMENTE
 *      quebrados fora dessas classes continuam `link_dead` blocker.
 *    - `generic_send_merge_tag` (#6608): merge tag `{{...}}`/sinal indireto
 *      (`isPostWebRedirectTarget`) ainda no e-mail ENTREGUE, mas só quando
 *      `--send-mode generic` foi passado explicitamente — ver header de
 *      `LinkTrackingSendMode` abaixo. Default (`simulate-as`) preserva 100%
 *      o comportamento anterior (blocker).
 *
 * Uso:
 *   npx tsx scripts/lint-test-email-link-tracking.ts \
 *     --email-file /tmp/email-260514.txt \
 *     --out /tmp/lint-link-tracking.json \
 *     [--send-mode generic|simulate-as]   # default simulate-as, ver #6608
 *
 * Exit codes:
 *   0 = nenhum BLOCKER (link_timeout/bot_blocked/auth_required não contam)
 *   1 = pelo menos 1 blocker (link_dead OU link_redirect_chain_long)
 *   2 = erro de uso
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

export interface LinkIssue {
  type: "link_dead" | "link_timeout" | "link_redirect_chain_long";
  /** #1949: blocker (link_dead/redirect) vs warning (link_timeout — transiente,
   * nunca derruba o gate). O exit code só considera blockers. */
  severity: "blocker" | "warning";
  url: string;
  /** URL final após redirects (se aplicável). */
  final_url?: string;
  /** Status HTTP final (null se timeout). */
  status: number | null;
  /** Quantos hops de redirect. */
  hops: number;
  details: string;
}

export interface LinkSkip {
  /** #1949: `merge_tag` = URL com `{{email}}` (vote URL, #1186 modo merge-tag) —
   * Beehiiv expande no envio, não dá pra HEAD; `bot_blocked` = 401/403 (página
   * existe pra humanos, bloqueia bot — ex: diaria.beehiiv.com/cursos, tecnoblog).
   * #3480/#3481/#3482: `amazon_bot_block`/`font_degradation`/
   * `beehiiv_footer_artifact` são artefatos conhecidos de test-send —
   * classificados via `classifyKnownArtifact` ANTES de tentar HEAD. */
  url: string;
  reason:
    | "auth_required"
    | "non_http"
    | "tel_mailto"
    | "merge_tag"
    | "bot_blocked"
    | "rate_limited"
    | "amazon_bot_block"
    | "font_degradation"
    | "beehiiv_footer_artifact"
    | "generic_send_merge_tag";
  domain?: string;
  /** Status HTTP quando bot_blocked. */
  status?: number;
  /** Explicação do porquê é um artefato conhecido (#3480/#3481/#3482). */
  note?: string;
}

export interface LinkTrackingResult {
  total_urls_extracted: number;
  total_urls_checked: number;
  issues: LinkIssue[];
  skipped: LinkSkip[];
  passed: number;
}

const AUTH_REQUIRED_DOMAINS = new Set([
  "linkedin.com",
  "www.linkedin.com",
  "facebook.com",
  "www.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "twitter.com",
  "x.com",
]);

// Override via env pra ajuste sem rebuild. Defaults conservadores.
const MAX_REDIRECTS = parseIntEnv("LINK_TRACKING_MAX_REDIRECTS", 3);
const HEAD_TIMEOUT_MS = parseIntEnv("LINK_TRACKING_TIMEOUT_MS", 5000);
const DEFAULT_CONCURRENCY = parseIntEnv("LINK_TRACKING_CONCURRENCY", 5);

function parseIntEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) || n < 1 ? fallback : n;
}

/**
 * Extrai todos URLs de hrefs no HTML/text do email.
 */
export function extractEmailUrls(content: string): string[] {
  const urls = new Set<string>();
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(content)) !== null) {
    urls.add(m[1]);
  }
  // Também captura URLs nuas no texto (plain emails)
  const bareRe = /https?:\/\/[^\s"'<>)]+/gi;
  while ((m = bareRe.exec(content)) !== null) {
    urls.add(m[0]);
  }
  return [...urls];
}

/**
 * Decoda redirect wrappers conhecidos:
 * - Gmail Image Proxy: `https://www.google.com/url?q={encoded}&sa=U...`
 * - Beehiiv tracking: `https://link.diaria.beehiiv.com/.../?l={encoded}` ou
 *   versão proprietária (não decodificável sem fetch).
 *
 * Retorna a URL "limpa" pra HEAD. Se não reconhece wrapper, retorna tal qual.
 */
export function decodeRedirectWrapper(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "www.google.com" && u.pathname === "/url") {
      const q = u.searchParams.get("q");
      if (q) return q;
    }
    // Beehiiv não expõe target em query — fica como está (HEAD do tracking).
    return url;
  } catch {
    return url;
  }
}

/**
 * Estágio do conteúdo sendo checado — determina se um merge tag `{{...}}`
 * ainda literal na URL é esperado (draft) ou é o próprio defeito (delivered).
 * Ver rationale completo no header de `categorizeUrl` abaixo (#4512).
 */
export type LinkTrackingStage = "draft" | "delivered";

/**
 * #6608: modo de envio do test email — determina se uma merge tag ainda
 * literal no e-mail ENTREGUE (`stage: "delivered"`) é o defeito real
 * (custom field não populado, comportamento default pré-#6608) ou um
 * artefato CONHECIDO E ACEITO do modo de envio genérico da Beehiiv.
 *
 * `"simulate-as"` (default — preserva 100% o comportamento pré-#6608): o
 * test email foi enviado via "Simulate as → Search for a specific
 * subscriber" (`beehiiv-playbook.md` §7, #6011), que resolve merge tags com
 * contexto de assinante real. Tag ainda literal aqui é blocker de verdade.
 *
 * `"generic"`: o test email foi enviado via "Send test email" genérico
 * (checkbox de destinatário, sem contexto de assinante) — modo que a
 * Beehiiv **nunca** resolve merge tags de sistema nele, mesmo com o draft
 * 100% correto (#6011). **#6608 (260828, causa raiz resolvida):** o picker
 * de busca de assinante do "Simulate as" não estava quebrado — o debounce
 * é só mais longo do que as tentativas originais esperaram (ver
 * `beehiiv-playbook.md` §7 pro procedimento de espera correto). Este modo
 * `"generic"` continua existindo como fallback pra quando não há Chrome
 * disponível na sessão que envia o test email (ex: este próprio agente),
 * não porque o picker esteja quebrado. Tratar `{{email}}`/`{{poll_token}}`
 * literal como `link_dead` nesse cenário é falso-positivo mecânico, não
 * defeito de conteúdo — vira `skipped[]` com reason
 * `generic_send_merge_tag`, nunca `issues[]`.
 */
export type LinkTrackingSendMode = "generic" | "simulate-as";

/**
 * Categoriza URL pra decisão de skip:
 * - non_http: protocolos não-http (mailto, tel, javascript) — skip silencioso
 * - auth_required: domínios que exigem login (skip + info)
 * - null: deve fazer HEAD
 *
 * #4512 (achado silent-failure-hunter, follow-up do #4487): `stage` distingue
 * DUAS situações que pareciam a mesma coisa mas não são. `stage: "draft"`
 * (default, preserva comportamento pré-#4512) — HTML de pré-render/worker
 * ainda NÃO passou pelo envio da Beehiiv, então um merge tag `{{poll_token}}`/
 * `{{email}}` literal é esperado; um HEAD na URL literal retornaria 4xx
 * (falso link_dead). Skip determinístico via reason `merge_tag`.
 * `stage: "delivered"` — conteúdo já FOI entregue (fetchado via Gmail MCP,
 * `mainCli()`/`review-test-email.md` passo 17); a Beehiiv JÁ deveria ter
 * substituído todo merge tag no envio real. Uma tag ainda literal aqui É o
 * defeito que este linter existe pra pegar (ex: custom field `poll_token`
 * não populado pro assinante de teste antes do 1º envio — ver
 * `scripts/inject-poll-token.ts`). Por isso NÃO skipa neste estágio: retorna
 * `null` (URL segue pro HEAD normal).
 *
 * **#4604 (correção do rationale acima, achado de self-review do #4603):** o
 * guard `isUnsubstitutedMergeTag` (`workers/poll/src/vote.ts`) NÃO retorna
 * mais 4xx incondicionalmente desde o #4578 — com `edition` em formato
 * válido, ele responde 302 pro jogo anônimo (`/jogar?edition=...&from=post-web`)
 * em vez do 400 de antes. Um HEAD que segue esse redirect até `/jogar` vê
 * status final 200 (a página existe e funciona). A detecção deixou de
 * depender só do status HTTP — `checkLinkTracking` agora também confere se o
 * destino final do redirect bate a assinatura `isPostWebRedirectTarget`
 * (pathname `/jogar` + `from=post-web`), classificando como `link_dead`
 * mesmo com HTTP final 200. Ver header de `isPostWebRedirectTarget` abaixo.
 */
export function categorizeUrl(
  url: string,
  stage: LinkTrackingStage = "draft",
  sendMode: LinkTrackingSendMode = "simulate-as",
): "non_http" | "auth_required" | "merge_tag" | "generic_send_merge_tag" | null {
  // #1949: URL com merge tag Beehiiv (`{{email}}`) — a vote URL do É IA? é
  // `?email={{email}}&...`. Beehiiv expande no ENVIO; um HEAD na URL literal
  // retornaria 4xx (falso link_dead) — SÓ vale em stage="draft" (ver header
  // desta função pro rationale completo do #4512).
  // #1186: `{{poll_sig}}` removido — modo merge-tag sem sig HMAC.
  if (stage === "draft" && /\{\{[^}]+\}\}/.test(url)) return "merge_tag";
  // #6608: e-mail JÁ ENTREGUE, mas enviado via "Send test email" genérico —
  // esse modo é conhecido por não resolver merge tags de sistema mesmo com
  // draft correto (ver header de `LinkTrackingSendMode`). Tag ainda literal
  // aqui é limitação aceita do modo de envio, não defeito — skip, não HEAD.
  if (stage === "delivered" && sendMode === "generic" && /\{\{[^}]+\}\}/.test(url)) {
    return "generic_send_merge_tag";
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "non_http";
  }
  if (!/^https?:$/.test(parsed.protocol)) return "non_http";
  if (AUTH_REQUIRED_DOMAINS.has(parsed.hostname.toLowerCase())) {
    return "auth_required";
  }
  return null;
}

// #3480: hostnames onde Amazon retorna 404 (não 401/403) pra HEAD de bot —
// bot-block "silencioso", a página existe normalmente pra humanos.
// #5840: `link.amazon` (encurtador SiteStripe, usado nos boxes de livro em
// data/snippets/) e `amzlinks.in` (hop intermediário do redirect do
// SiteStripe) sofrem o MESMO bot-block — verificado ao vivo (`curl -L
// --compressed` com UA de navegador segue os 2 hops até a página real, 200).
const AMAZON_DOMAINS = new Set([
  "amazon.com",
  "www.amazon.com",
  "amazon.com.br",
  "www.amazon.com.br",
  "amzn.to",
  "www.amzn.to",
  "link.amazon",
  "www.link.amazon",
  "amzlinks.in",
  "www.amzlinks.in",
]);

// #3482: hosts de Google Fonts — 404 em test send degrada pra fallback
// gracioso de fonte do sistema, cosmético, não bloqueante.
const FONT_DOMAINS = new Set(["fonts.gstatic.com", "fonts.googleapis.com"]);

export interface KnownArtifact {
  reason: "amazon_bot_block" | "font_degradation" | "beehiiv_footer_artifact";
  note: string;
}

/**
 * Classifica artefatos conhecidos de test-send (#3480/#3481/#3482,
 * post-mortem edição 260716) — ANTES de tentar HEAD, pra não gastar rede
 * numa checagem que sabidamente não é confiável pra essas classes de URL.
 *
 * Roda em duas fases:
 * 1. Pattern na URL CRUA (pré-parse) — cobre #3481, onde a URL do
 *    footer/preferences do Beehiiv pode vir malformada (token de assinante
 *    não resolve em test send) e `new URL()` lançaria antes de chegar em
 *    qualquer checagem por hostname.
 * 2. Domínio (pós-parse) — cobre #3480 (Amazon) e #3482 (Google Fonts).
 *
 * Links REALMENTE quebrados fora dessas classes (domínio/padrão específico)
 * NÃO são afetados — continuam indo pro HEAD normal e viram `link_dead` se
 * de fato retornarem 4xx/5xx.
 */
export function classifyKnownArtifact(rawUrl: string): KnownArtifact | null {
  const lower = rawUrl.toLowerCase();

  // #3481 — link de preferences/unsubscribe no rodapé Beehiiv (boilerplate
  // injetado, fora do htmlSnippet, #1944). Em test send não há subscription
  // real, então o token do link não resolve — href malformado é esperado,
  // não um link quebrado de fato.
  if (lower.includes("beehiiv") && /unsubscribe|preferences?/.test(lower)) {
    return {
      reason: "beehiiv_footer_artifact",
      note: "link de preferences/unsubscribe do rodapé Beehiiv não resolve em test send (sem subscription real) — artefato esperado, ver #3481",
    };
  }

  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (AMAZON_DOMAINS.has(hostname) || hostname.endsWith(".amazon.com") || hostname.endsWith(".amazon.com.br")) {
    return {
      reason: "amazon_bot_block",
      note: "Amazon bloqueia HEAD de user-agent não-navegador com 404 — página existe normalmente pra humanos, ver #3480",
    };
  }

  if (FONT_DOMAINS.has(hostname)) {
    return {
      reason: "font_degradation",
      note: "Google Fonts pode retornar 404 em test send — degrada pra fallback de fonte do sistema, cosmético, ver #3482",
    };
  }

  return null;
}

interface HeadResult {
  status: number | null;
  hops: number;
  final_url: string;
  timed_out: boolean;
  /** #6819: true quando o status final veio de um GET de fallback (o Worker
   *  não implementa HEAD em /jogar — cai num 404 do router). */
  via_get: boolean;
}

/**
 * Faz HEAD com follow-redirect manual (até MAX_REDIRECTS).
 * Retorna status final, hops, URL final.
 *
 * #6819: quando o HEAD retorna 4xx (exceto 401/403 — `bot_blocked`, e 429 —
 * `rate_limited`, que já são skipados em `checkLinkTracking` antes de chegar
 * aqui), cai pra GET no MESMO url — mesmo padrão de `verify-accessibility.ts`
 * (#899, linha ~439). O Worker `eia.diar.ia.br/jogar` só tem handler pra GET:
 * HEAD cai num 404 default do router, GET retorna 200 com o HTML do jogo.
 * Sem o fallback, o link do rodapé virava falso blocker toda edition.
 *
 * O GET de fallback NÃO herda redirect:'manual' — se o GET der redirect,
 * segue com follow (fetch default) e o status é o final. Se GET também
 * retornar 4xx, o status é esse 4xx e o caller classifica como `link_dead`
 * de fato (não há 2ª tentativa — 1 fallback, como o verify-accessibility).
 */
async function headWithRedirects(url: string, fetchImpl: typeof fetch): Promise<HeadResult> {
  let current = url;
  let hops = 0;
  let lastStatus: number | null = null;

  async function fetchOnce(method: "HEAD" | "GET", signal: AbortSignal): Promise<Response> {
    return fetchImpl(current, {
      method,
      redirect: method === "HEAD" ? "manual" : "follow",
      signal,
    });
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const method = attempt === 0 ? "HEAD" : "GET";
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
    try {
      const res = await fetchOnce(method, controller.signal);
      lastStatus = res.status;
      if (res.status >= 300 && res.status < 400 && method === "HEAD") {
        const loc = res.headers.get("location");
        if (!loc) {
          return { status: res.status, hops, final_url: current, timed_out: false, via_get: false };
        }
        // Resolve relative location
        try {
          current = new URL(loc, current).toString();
        } catch {
          current = loc;
        }
        hops++;
        continue;
      }
      // #6819: HEAD 4xx (exceto 401/403/429, já skipados pelo caller) → GET.
      // GET não faz redirect manual (ver follow acima) — status é o final.
      if (method === "HEAD" && res.status >= 400 && res.status !== 401 && res.status !== 403 && res.status !== 429) {
        continue;
      }
      return { status: res.status, hops, final_url: current, timed_out: false, via_get: method === "GET" };
    } catch (e) {
      const isAbort = (e as Error).name === "AbortError";
      // #6819: qualquer falha em HEAD (timeout, DNS, conexão recusada) não é
      // fatal — tenta GET uma única vez antes de reportar. Links que só
      // respondem em GET (ex: worker pesado, ou .invalid quefalha em HEAD
      // mas poderia responder em GET) seriam falso link_timeout sem isso.
      if (method === "HEAD") {
        continue;
      }
      return { status: lastStatus, hops, final_url: current, timed_out: isAbort, via_get: method === "GET" };
    } finally {
      clearTimeout(t);
    }
  }
  // Excedeu as 2 tentativas (HEAD 4xx + GET) sem status < 400
  return { status: lastStatus, hops, final_url: current, timed_out: false, via_get: true };
}

/**
 * #4604: detecta o destino do redirect que `handleVote` (workers/poll/src/
 * vote.ts, guard `isUnsubstitutedMergeTag`, #4578) emite quando a merge tag
 * de identidade do voto (`{{email}}`/`{{poll_token}}`) chega ainda literal —
 * `302` pro jogo anônimo `/jogar?edition=...&from=post-web` em vez do 400
 * incondicional de antes do #4578. Esse destino é um sinal INDIRETO de merge
 * tag travada: o HEAD final costuma retornar 200 (a página `/jogar` existe e
 * funciona), então sem este check o link apareceria como saudável
 * (`passed`), mascarando o defeito real no envio.
 *
 * A checagem exige AMBOS pathname `/jogar` E query `from=post-web` — não só
 * pathname. `/jogar` sozinho tem produtor legítimo e comum: o embed do jogo
 * (`workers/poll/src/embed.ts::buildEmbedJogarUrl`) monta
 * `/jogar?{params}` SEM o parâmetro `from`, e não deve ser confundido com o
 * sinal de merge tag travada. `from=post-web` é setado EXCLUSIVAMENTE pelo
 * guard de `handleVote` (nenhum outro call site do repo produz esse valor —
 * ver `workers/poll/src/vote.ts`), tornando a combinação um sinal específico
 * o suficiente pra não gerar falso-positivo em um link `/jogar` legítimo.
 */
export function isPostWebRedirectTarget(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname === "/jogar" && u.searchParams.get("from") === "post-web";
  } catch {
    return false;
  }
}

export async function checkLinkTracking(
  emailContent: string,
  fetchImpl: typeof fetch = fetch,
  concurrency = DEFAULT_CONCURRENCY,
  // #4512: default "draft" preserva 100% do comportamento pré-existente
  // (chamador real hoje, mainCli(), passa "delivered" explicitamente — ver
  // header de categorizeUrl acima pro rationale completo).
  stage: LinkTrackingStage = "draft",
  // #6608: default "simulate-as" preserva 100% do comportamento pré-#6608 —
  // ver header de `LinkTrackingSendMode` pro rationale completo.
  sendMode: LinkTrackingSendMode = "simulate-as",
): Promise<LinkTrackingResult> {
  const rawUrls = extractEmailUrls(emailContent);
  const issues: LinkIssue[] = [];
  const skipped: LinkSkip[] = [];
  let passed = 0;

  // Decoda redirect wrappers + dedup
  const queue: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawUrls) {
    const decoded = decodeRedirectWrapper(raw);
    if (seen.has(decoded)) continue;
    seen.add(decoded);

    // #3480/#3481/#3482: checa artefatos conhecidos de test-send ANTES do
    // HEAD — tanto na URL crua (pega #3481, que pode nem parsear) quanto na
    // decodada (pega #3480/#3482 atrás de wrappers de tracking/proxy).
    const artifact = classifyKnownArtifact(raw) ?? classifyKnownArtifact(decoded);
    if (artifact) {
      skipped.push({ url: decoded, reason: artifact.reason, note: artifact.note });
      continue;
    }

    const cat = categorizeUrl(decoded, stage, sendMode);
    if (cat === "non_http") {
      skipped.push({ url: decoded, reason: decoded.startsWith("mailto:") ? "tel_mailto" : "non_http" });
      continue;
    }
    if (cat === "merge_tag") {
      // #1949: vote URL com {{email}} — expande no envio (#1186: sem poll_sig).
      skipped.push({ url: decoded, reason: "merge_tag" });
      continue;
    }
    if (cat === "generic_send_merge_tag") {
      // #6608: e-mail entregue via "Send test email" genérico — modo
      // conhecido por não resolver merge tags de sistema (#6011). Não é o
      // defeito que este linter existe pra pegar nesse cenário — skip.
      skipped.push({
        url: decoded,
        reason: "generic_send_merge_tag",
        note: "Merge tag literal em test email enviado via modo genérico (não Simulate as) — limitação aceita do modo de envio, ver #6608.",
      });
      continue;
    }
    if (cat === "auth_required") {
      const host = (() => { try { return new URL(decoded).hostname; } catch { return ""; } })();
      skipped.push({ url: decoded, reason: "auth_required", domain: host });
      continue;
    }
    queue.push(decoded);
  }

  // Processa em batches de `concurrency` pra não saturar rede
  for (let i = 0; i < queue.length; i += concurrency) {
    const batch = queue.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((u) => headWithRedirects(u, fetchImpl).then((r) => ({ url: u, r }))));
    for (const { url, r } of results) {
      if (r.timed_out) {
        // #1949: timeout é WARNING, não blocker — transiente (rede/host lento,
        // ex: anthropic.com >5s pontual), não link morto. Não derruba o gate.
        issues.push({
          type: "link_timeout",
          severity: "warning",
          url,
          status: null,
          hops: r.hops,
          details: `HEAD timeout após ${HEAD_TIMEOUT_MS}ms (transiente — warning, não blocker).`,
        });
      } else if (r.hops > 0 && isPostWebRedirectTarget(r.final_url)) {
        // #4604: destino final do redirect é `/jogar?...&from=post-web` — sinal
        // indireto de merge tag de identidade do voto ainda literal no /vote
        // (guard isUnsubstitutedMergeTag, workers/poll/src/vote.ts, #4578).
        // Checado ANTES dos ramos por status abaixo de propósito: o HEAD final
        // aqui tipicamente é 200 (a página /jogar existe e funciona), então sem
        // esta checagem cairia no `else { passed++ }` — mascarando o defeito.
        //
        // #6608: mesmo sinal indireto pode vir de um envio via modo genérico
        // (nunca resolve merge tag, #6011) em vez de custom field ausente —
        // sendMode "generic" trata como limitação aceita (skip), não blocker.
        if (sendMode === "generic") {
          skipped.push({
            url,
            reason: "generic_send_merge_tag",
            note: `Redirect final aponta pra /jogar com from=post-web (HTTP ${r.status} em ${r.final_url}) — sinal de merge tag ainda literal, mas test email enviado via modo genérico (não Simulate as); limitação aceita do modo de envio, ver #6608.`,
          });
        } else {
          issues.push({
            type: "link_dead",
            severity: "blocker",
            url,
            final_url: r.final_url,
            status: r.status,
            hops: r.hops,
            details: `Redirect final aponta pra /jogar com from=post-web (HTTP ${r.status} em ${r.final_url}) — merge tag de identidade do voto ainda literal no /vote (guard isUnsubstitutedMergeTag, workers/poll/src/vote.ts, #4578/#4604).`,
          });
        }
      } else if (r.hops > MAX_REDIRECTS) {
        issues.push({
          type: "link_redirect_chain_long",
          severity: "blocker",
          url,
          final_url: r.final_url,
          status: r.status,
          hops: r.hops,
          details: `${r.hops} redirects (limite ${MAX_REDIRECTS}). Final URL: ${r.final_url}`,
        });
      } else if (r.status === 401 || r.status === 403) {
        // #1949: bot-block (página existe pra humanos, bloqueia HEAD de bot —
        // diaria.beehiiv.com/cursos|livros, tecnoblog). NÃO é link morto.
        skipped.push({ url, reason: "bot_blocked", status: r.status });
      } else if (r.status === 429) {
        // #3941 (post-mortem 260723): 429 = rate limiting de crawler/anti-bot,
        // QUALQUER domínio (mesmo princípio de #696 em verify-accessibility.ts).
        // Caso confirmado: VentureBeat retorna 429 pra HEAD de bot; página
        // existe normalmente pra humanos. Antes desta correção, 429 caía no
        // ramo genérico >=400 abaixo e virava `link_dead` — falso-positivo.
        skipped.push({ url, reason: "rate_limited", status: r.status });
      } else if (r.status !== null && r.status >= 400) {
        // #6819: se o GET de fallback também falhou, é link morto de fato —
        // um GET 4xx não é falso-positivo de HEAD (o GET é o que humanos
        // usam). Quando r.via_get é true, o status veio do GET, não do HEAD.
        issues.push({
          type: "link_dead",
          severity: "blocker",
          url,
          final_url: r.final_url !== url ? r.final_url : undefined,
          status: r.status,
          hops: r.hops,
          details: r.via_get
            ? `HEAD 4xx + GET ${r.status} em ${r.final_url} — link morto de fato (GET é o que humanos usam)`
            : `HEAD retornou ${r.status} em ${r.final_url}`,
        });
      } else {
        passed++;
      }
    }
  }

  return {
    total_urls_extracted: rawUrls.length,
    total_urls_checked: queue.length,
    issues,
    skipped,
    passed,
  };
}

async function mainCli(): Promise<number> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has("help") || !values["email-file"]) {
    console.error(
      "Uso: lint-test-email-link-tracking.ts --email-file <file> [--out <json>] [--send-mode generic|simulate-as]",
    );
    return 2;
  }
  const emailFile = values["email-file"];
  if (!existsSync(emailFile)) {
    console.error(`email-file não existe: ${emailFile}`);
    return 2;
  }
  const content = readFileSync(emailFile, "utf8");
  // #4512: único caller documentado (`review-test-email.md` passo 17) sempre
  // aponta pro e-mail JÁ ENTREGUE (`_internal/test-email-{AAMMDD}.txt`,
  // fetchado via Gmail MCP) — nunca pro HTML de draft/pré-render. Default
  // "delivered" (override via --stage draft, se algum caller futuro precisar
  // checar HTML de pré-render onde merge tag não-expandida é esperada).
  const stage: LinkTrackingStage = values.stage === "draft" ? "draft" : "delivered";
  // #6608: default "simulate-as" preserva o comportamento pré-#6608 — o
  // caller (`review-test-email.md` passo 17) passa `--send-mode generic`
  // explicitamente só quando confirmou que o test email saiu via "Send test
  // email" genérico (não "Simulate as"), ver header de `LinkTrackingSendMode`.
  const sendMode: LinkTrackingSendMode = values["send-mode"] === "generic" ? "generic" : "simulate-as";
  const result = await checkLinkTracking(content, fetch, DEFAULT_CONCURRENCY, stage, sendMode);
  if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));

  if (result.issues.length > 0) {
    console.error(`[lint-test-email-link-tracking] ${result.issues.length} issue(s):`);
    for (const i of result.issues) {
      console.error(`  - [${i.severity}:${i.type}] ${i.url} → ${i.details}`);
    }
  }
  // #1949: só blockers (link_dead/redirect) derrubam o exit. link_timeout é
  // warning (transiente) — fica no JSON pro agent, mas não bloqueia o gate.
  const blockers = result.issues.filter((i) => i.severity === "blocker");
  return blockers.length > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  mainCli().then((code) => process.exit(code));
}
