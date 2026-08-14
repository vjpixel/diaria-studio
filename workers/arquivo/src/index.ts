/**
 * workers/arquivo — Cloudflare Worker (#4105).
 *
 * Problema: só 10.8% (24/223) das edições diárias publicadas da diar.ia.br
 * estão indexadas pelo Google — o site (hospedado no Beehiiv, domínio
 * canônico diar.ia.br) expõe quase nenhum `<a href>` server-side crawlable
 * pra edições antigas.
 *
 * Decisão do editor (comentário em #4105, opção #1 do research): esta
 * página server-renderiza uma listagem estática de TODAS as edições
 * publicadas, com `<a href>` reais — sem JS client-side, sem paginação —
 * reusando a mesma fonte de dados do sitemap oficial (#761,
 * `scripts/lib/fetch-sitemap.ts`).
 *
 * Deliberadamente simples: sem `[assets]` (o Worker ganhou 1 binding KV no
 * #4902 e a var `INDEXNOW_KEY` no #4909 — não é mais "sem KV, sem secrets"
 * como dizia aqui antes; achado da Fase 1.5 desta rodada) — busca o
 * sitemap a cada request (fetch server-side, sem auth, é público) e
 * renderiza on-the-fly. `Cache-Control: public, max-age=3600` + edge cache
 * do Cloudflare absorvem o resto (o sitemap não muda mais que 1x/dia).
 *
 * Rotas: GET / → HTML completo. GET /sitemap.xml → 1 `<url>` pra esta página
 * (#4546) + 1 `<url>` por hub temático publicado, cada um com `<lastmod>`
 * (#4909 — sem `[assets]` neste Worker, então é a rota que precisa servir o
 * XML, diferente de cursos/livros, que servem via `public/sitemap.xml`
 * estático). GET /robots.txt → mesmo raciocínio, mesmo motivo de não poder
 * ser estático (`scripts/lib/shared/robots-txt.ts`, compartilhado com
 * cursos/livros — ver #4546). GET /{INDEXNOW_KEY}.txt → arquivo de chave do
 * IndexNow (#4909 item 2), só quando a var `INDEXNOW_KEY` está configurada
 * — sem ela, path nenhum casa e o comportamento é idêntico a antes.
 * Qualquer outro path → 404.
 *
 * Falha de fetch/parse do sitemap NUNCA lança sem tratamento (#5134 item 3):
 * a raiz serve a última renderização bem-sucedida guardada em KV como
 * fallback (ver `readRootCache`/`writeRootCache` abaixo) — só cai na página
 * de erro simples (502) quando nenhum fallback existe (1º request desde o
 * deploy, ou KV indisponível). GET/HEAD condicional (`If-None-Match`/
 * `If-Modified-Since`) contra `/temas/{slug}` devolve `304` corpo vazio
 * quando casa com o `ETag`/`Last-Modified` já emitidos (#5134 itens 1-2).
 *
 * Próximo passo (fora de escopo deste Worker): linkar esta página a partir
 * de diar.ia.br (Beehiiv Website Builder — 3rd-party hosted, não é código
 * deste repo) pra que o Googlebot de fato a descubra. Ver PR body de #4105.
 */
import { parseSitemap } from "../../../scripts/lib/fetch-sitemap.ts";
import { renderCuradoriaRobotsTxt } from "../../../scripts/lib/shared/robots-txt.ts";
import { matchAiReferrerHost, logAiReferrerHit } from "../../../scripts/lib/shared/ai-referrer-log.ts"; // #4558 Parte C
import {
  matchAiFetchBot,
  aiFetchBotCounterKey,
  aiFetchReferrerCounterKey,
  incrementAiFetchCounter,
} from "../../../scripts/lib/shared/ai-fetch-counters.ts"; // #4902, F-17 do #4558
import { buildArchiveHtml, PAGE_URL } from "./render-archive.ts";
import { buildArchiveFeedXml, FEED_URL } from "./render-feed.ts"; // #5127: GET /feed.xml
import { HUB_REGISTRY, HUB_LASTMOD } from "./hubs/registry.ts"; // #4558 Parte A: hubs temáticos em /temas/{slug}
import { renderPrivacyPage } from "./render-privacy.ts"; // #5262: /privacidade (pré-requisito da verificação de marca OAuth)
import { resolveWorkersDevRedirect } from "../../../scripts/lib/shared/workers-dev-redirect.ts"; // #5097 item D

/**
 * Env do Worker `arquivo` (#4902) — o Worker nasceu "sem KV, sem secrets,
 * sem [assets]" (ver docstring do topo) e este é o 1º binding que ele
 * ganha: reusa `CURSOS_SUBSCRIBERS` (mesmo namespace de `workers/cursos`,
 * `id` em `wrangler.toml`), com prefixo próprio `counter:ai-fetch:` — sem
 * criar namespace novo (ver `scripts/lib/shared/ai-fetch-counters.ts` pro
 * porquê). `KVNamespace | undefined` (não obrigatório): defensivo contra um
 * binding ainda não propagado num ambiente (`workers_dev` preview, etc.) —
 * `incrementAiFetchCounter` é NO-OP silencioso nesse caso, nunca derruba a
 * resposta.
 */
export interface Env {
  CURSOS_SUBSCRIBERS?: KVNamespace;
  /**
   * Chave IndexNow (#4909 item 2) — string opaca gerada pelo editor em
   * indexnow.org/documentation, provisionada como Worker var (`wrangler
   * secret put INDEXNOW_KEY` ou `[vars]`, fora deste repo). Serve o arquivo
   * de chave em `GET /{INDEXNOW_KEY}.txt` (ver `indexNowKeyResponse`
   * abaixo) — é assim que o Bing confirma que quem pinga
   * `api.indexnow.org` é dono do host. `undefined`/ausente: a rota
   * simplesmente não casa com nenhum path (nenhum comportamento novo),
   * mesma disciplina defensiva de `CURSOS_SUBSCRIBERS` acima — permite o
   * Worker rodar sem a var configurada até o editor provisionar a chave.
   */
  INDEXNOW_KEY?: string;
}

/**
 * `<lastmod>` da raiz do sitemap (#4909): a data mais recente entre os hubs
 * publicados — não `new Date()` (o HTML dos hubs é gerado e COMMITADO, ver
 * nota de `hub-page.ts`; um valor dinâmico aqui declararia a página
 * "mudou hoje" mesmo em deploys que não tocaram conteúdo nenhum, o mesmo
 * problema que motivou `publishedDate`/`updatedDate` serem estáticos, #4911).
 * Comparação lexicográfica
 * funciona porque as datas são sempre `YYYY-MM-DD`. `undefined` só se algum
 * dia não houver hub nenhum publicado (nunca aconteceu — `HUB_REGISTRY`
 * nasceu com o primeiro hub).
 *
 * #5124: cada `HUB_LASTMOD[slug]` (usado aqui) é a data de COBERTURA do
 * hub (edição mais recente citada em `sourceEditions`), não mais
 * `updatedDate` (revisão de prosa) — ver `hubCoverageDate` em `hub-page.ts`.
 */
const ROOT_LASTMOD: string | undefined = Object.values(HUB_LASTMOD).reduce<string | undefined>(
  (max, d) => (max === undefined || d > max ? d : max),
  undefined,
);

/**
 * Sitemap PRÓPRIO desta página (#4546) — `PAGE_URL` + 1 `<url>` por hub
 * temático publicado (#4558 Parte A, `HUB_REGISTRY` — cresce sozinho a
 * cada hub novo, sem editar esta lista). NÃO enumera as ~246 edições
 * individuais (essas já vivem no sitemap do host principal,
 * `https://diar.ia.br/sitemap.xml`, consumido acima via `fetchSitemapXml`)
 * — o objetivo aqui é só dar ao Google um caminho de descoberta pra ESTAS
 * páginas, que por sua vez listam `<a href>` reais pra cada edição.
 * `<lastmod>` por `<url>` (#4909) vem de `HUB_LASTMOD` — mesma data de
 * COBERTURA (#5124, `hubCoverageDate`) que já alimenta `dateModified` no
 * JSON-LD de cada hub, nunca um valor inventado à parte.
 */
const ARQUIVO_SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${PAGE_URL}</loc>${ROOT_LASTMOD ? `\n    <lastmod>${ROOT_LASTMOD}</lastmod>` : ""}
  </url>
${Object.keys(HUB_REGISTRY)
  .map((slug) => {
    const lastmod = HUB_LASTMOD[slug];
    return `  <url>\n    <loc>${PAGE_URL}temas/${slug}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}\n  </url>`;
  })
  .join("\n")}
</urlset>
`;

function sitemapResponse(): Response {
  return new Response(ARQUIVO_SITEMAP_XML, {
    status: 200,
    headers: {
      "Content-Type": "application/xml;charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * `robots.txt` PRÓPRIO (#4546) — mesmo conteúdo/racional de cursos/livros
 * (ver `scripts/lib/shared/robots-txt.ts`), só que servido dinamicamente
 * porque este Worker não tem `[assets]`. `Sitemap:` aponta pro
 * `/sitemap.xml` deste próprio host, não pro do host principal. `Feed:`
 * (#5127 item 4) declara `/feed.xml` — único host do projeto com feed.
 */
const ARQUIVO_ROBOTS_TXT = renderCuradoriaRobotsTxt(`${PAGE_URL}sitemap.xml`, { feedUrl: FEED_URL });

function robotsResponse(): Response {
  return new Response(ARQUIVO_ROBOTS_TXT, {
    status: 200,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * Arquivo de chave do IndexNow (#4909 item 2) — `GET /{env.INDEXNOW_KEY}.txt`
 * devolve a própria chave em texto puro, exatamente como o protocolo exige
 * (indexnow.org/documentation: "the key location... must simply contain the
 * key"). Mesmo padrão dinâmico de `/sitemap.xml`/`/robots.txt` (Worker sem
 * `[assets]`, então qualquer arquivo estático precisa de rota em código).
 * `key` sempre não-vazia aqui (o dispatch já checou `env.INDEXNOW_KEY`
 * truthy antes de chamar isto).
 */
function indexNowKeyResponse(key: string): Response {
  return new Response(key, {
    status: 200,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

const SITEMAP_URL = "https://diar.ia.br/sitemap.xml";
const USER_AGENT = "DiariaBot/1.0 (+https://diar.ia.br)";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Hash não-criptográfico (FNV-1a 32-bit) do corpo, pra `ETag` (#4909). Não
 * precisa ser à prova de colisão adversarial — só precisa mudar quando o
 * conteúdo muda, pra um `If-None-Match` de crawler funcionar. Puramente em
 * JS (sem `crypto.subtle`, que é assíncrono, nem `node:crypto`, que exigiria
 * `nodejs_compat` só pra isto) — mantém `htmlResponse` síncrona.
 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * `If-None-Match` casa contra `etag` (#5134)? Comparação FRACA (RFC 7232
 * §2.3.2 — a única válida pra GET/HEAD condicional): ignora o prefixo `W/`
 * dos dois lados antes de comparar o opaque-tag. `*` casa qualquer ETag
 * (representação existe). Múltiplos valores separados por vírgula — casa se
 * QUALQUER um bater.
 */
function ifNoneMatchMatches(header: string, etag: string): boolean {
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  const stripWeak = (t: string) => t.trim().replace(/^W\//, "");
  const target = stripWeak(etag);
  return trimmed.split(",").some((candidate) => stripWeak(candidate) === target);
}

/**
 * `If-Modified-Since` casa contra `lastModifiedHttpDate` (RFC 7231 §3.3, já
 * em formato HTTP-date — `toHttpDate` acima)? "Não modificado desde" é
 * verdadeiro quando o recurso NÃO mudou depois da data pedida, ou seja
 * `lastModified <= ifModifiedSince`. Datas inválidas em qualquer lado (não
 * deveria acontecer com um crawler bem-comportado, mas headers HTTP são
 * input não confiável) fazem a função devolver `false` — nunca 304
 * indevido por um parse ruim.
 */
function ifModifiedSinceMatches(header: string, lastModifiedHttpDate: string): boolean {
  const ims = Date.parse(header);
  const lm = Date.parse(lastModifiedHttpDate);
  if (Number.isNaN(ims) || Number.isNaN(lm)) return false;
  return lm <= ims;
}

/**
 * Fecha #5134 itens 1-2: devolve uma resposta `304 Not Modified` (corpo
 * vazio) quando a requisição condicional CASA com o `ETag`/`Last-Modified`
 * da resposta 200 já montada — ou `null` quando não casa (caller serve a
 * resposta original tal qual). Nunca chamada sobre respostas != 200 (404,
 * 502 — essas não têm `ETag`/`Last-Modified` pra casar contra nada, ver
 * `htmlResponse`).
 *
 * `If-None-Match` tem PRECEDÊNCIA sobre `If-Modified-Since` quando ambos
 * estão presentes (RFC 7232 §3.3: "a recipient MUST ignore If-Modified-
 * Since if the request contains an If-None-Match header") — por isso o
 * `else if` abaixo só olha `If-Modified-Since` quando não há `If-None-
 * Match` NENHUM na requisição, nunca como fallback de um `If-None-Match`
 * que não casou.
 */
function conditionalNotModified(request: Request, response: Response): Response | null {
  if (response.status !== 200) return null;
  const etag = response.headers.get("ETag");
  const lastModified = response.headers.get("Last-Modified");
  const ifNoneMatch = request.headers.get("If-None-Match");
  let matched: boolean;
  if (ifNoneMatch !== null) {
    matched = etag !== null && ifNoneMatchMatches(ifNoneMatch, etag);
  } else {
    const ifModifiedSince = request.headers.get("If-Modified-Since");
    matched = lastModified !== null && ifModifiedSince !== null && ifModifiedSinceMatches(ifModifiedSince, lastModified);
  }
  if (!matched) return null;
  const headers = new Headers();
  if (etag) headers.set("ETag", etag);
  if (lastModified) headers.set("Last-Modified", lastModified);
  const cacheControl = response.headers.get("Cache-Control");
  if (cacheControl) headers.set("Cache-Control", cacheControl);
  return new Response(null, { status: 304, headers });
}

/** `YYYY-MM-DD` → formato RFC 7231 (`Last-Modified`/`If-Modified-Since`).
 * Meia-noite UTC — mesma disciplina de data ESTÁTICA de `hub-page.ts`: não é
 * hora real de publicação, é o dia da data de cobertura (#5124). */
function toHttpDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toUTCString();
}

interface HtmlResponseOptions {
  /** `YYYY-MM-DD` da data de COBERTURA do hub (#5124, `hubCoverageDate` —
   * era `updatedDate` até o #4911/#4909, corrigido pelo #5124) — vira
   * header `Last-Modified`. */
  lastModified?: string;
  /** `true` pra emitir `ETag` (hash do `body`). */
  etag?: boolean;
  /** Override de `Cache-Control` (#5134 item 3) — usado só pelo fallback de
   * KV da raiz, que quer um TTL de edge mais curto que o 1h normal (uma
   * cópia servida de cache, com o upstream fora do ar, deve ser trocada
   * pela versão fresca assim que o upstream voltar, não travar 1h). Omitido
   * → `"public, max-age=3600"`, comportamento idêntico a antes desta opção
   * existir. */
  cacheControl?: string;
}

/**
 * `ETag` FRACO (`W/"..."`, #5134) — não `"..."` forte. Verificado ao vivo em
 * 12/08/2026 (#5134): o código já montava um `ETag` FORTE corretamente (
 * confirmado por invocação direta do `fetch` handler em isolamento — o
 * header chega intacto na `Response` retornada), mas `curl` contra
 * `arquivo.diar.ia.br` em produção não mostrava NENHUM `ETag`. A causa mais
 * provável — comportamento documentado de CDNs/proxies reversos (Cloudflare
 * incluso) que descartam um ETag FORTE ao aplicar compressão em trânsito
 * (gzip/brotli automáticos), porque um validador forte declara
 * "byte-idêntico" e a compressão muda os bytes — um ETag FRACO sinaliza
 * "semanticamente equivalente" e sobrevive a essa transformação. Trocar
 * pra `W/` é o fix padrão pra essa classe de sintoma e não perde nada aqui:
 * o hash em si (FNV-1a) já não pretendia ser validador forte (não é
 * criptográfico, existe só pra mudar quando o conteúdo muda). Verificação
 * AO VIVO pós-deploy é pendência do editor (`curl -sSI` — ver PR body); a
 * suíte de testes confirma que o header chega intacto na resposta FINAL do
 * `fetch` handler (não só numa variável interna), que é o que dá pra provar
 * a partir deste worktree isolado.
 */
function weakEtag(body: string): string {
  return `W/"${fnv1aHex(body)}"`;
}

function htmlResponse(body: string, status = 200, opts?: HtmlResponseOptions): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/html;charset=utf-8",
  };
  if (status === 200) {
    headers["Cache-Control"] = opts?.cacheControl ?? "public, max-age=3600";
    if (opts?.lastModified) headers["Last-Modified"] = toHttpDate(opts.lastModified);
    if (opts?.etag) headers["ETag"] = weakEtag(body);
  }
  return new Response(body, { status, headers });
}

function errorPage(): Response {
  return htmlResponse(
    `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Arquivo indisponível — diar.ia.br</title>
<meta name="robots" content="noindex">
</head>
<body>
  <main>
    <h1>Arquivo temporariamente indisponível</h1>
    <p>Não foi possível carregar a lista de edições agora. Tente novamente em instantes.</p>
  </main>
</body>
</html>
`,
    502,
  );
}

/** Busca o `sitemap.xml` público e retorna o XML cru. Lança em falha
 * (HTTP não-200, timeout, erro de rede) — o caller (`fetch` handler) trata. */
async function fetchSitemapXml(): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SITEMAP_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/xml, text/xml, */*" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`sitemap fetch HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET /feed.xml` (#5127) — busca o sitemap AO VIVO (mesma fonte da raiz) e
 * monta o RSS via `buildArchiveFeedXml`. Deliberadamente SEM o fallback de
 * KV que a raiz ganhou no #5134: o feed é uma superfície nova, de menor
 * prioridade (P3, "incerto-mas-barato" — ver issue), e um leitor de feed já
 * tolera bem uma falha pontual de fetch (tenta de novo no próximo poll,
 * diferente de um crawler que talvez não re-tente o mesmo path tão cedo).
 * Reavaliar se o feed ganhar tráfego real e falhas viraram problema.
 */
async function feedRoute(): Promise<Response> {
  let xml: string;
  try {
    xml = await fetchSitemapXml();
  } catch (e) {
    console.error("[arquivo] /feed.xml: falha ao buscar sitemap:", e instanceof Error ? e.message : String(e));
    return new Response("Feed temporariamente indisponível.", { status: 502 });
  }
  try {
    const entries = parseSitemap(xml);
    const feedXml = buildArchiveFeedXml(entries);
    return new Response(feedXml, {
      status: 200,
      headers: {
        "Content-Type": "application/rss+xml;charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (e) {
    console.error("[arquivo] /feed.xml: sitemap inválido:", e instanceof Error ? e.message : String(e));
    return new Response("Feed temporariamente indisponível.", { status: 502 });
  }
}

// ── Cache da raiz (#5134 item 3) ────────────────────────────────────────────
/**
 * A raiz (`/`) é a única lista PLANA das ~250 edições — o caminho de crawl
 * que a épica #5116/#5121 inteira depende. Até #5134 ela montava o HTML a
 * partir de um fetch AO VIVO do sitemap da Beehiiv em TODO request, e
 * degradava pra 502 sempre que esse fetch falhava — uma indisponibilidade
 * da Beehiiv derrubava a nossa superfície de recuperação, bem quando ela
 * mais importa.
 *
 * Fix: KV (reusa `CURSOS_SUBSCRIBERS`, mesmo namespace/prefixo-próprio já
 * usado pelos contadores ai-fetch, #4902 — sem criar namespace novo) guarda
 * a ÚLTIMA renderização bem-sucedida. O caminho feliz (fetch OK) não muda:
 * segue montando fresco a cada request (o `Cache-Control: public,
 * max-age=3600` + edge cache da Cloudflare já absorvem a maior parte do
 * tráfego, documentado no topo do arquivo) — o KV só é ESCRITO como
 * subproduto de um sucesso, e só é LIDO quando o fetch ao vivo falha (rede,
 * timeout, HTTP não-200) ou o XML vem malformado. Sem TTL de expiração no
 * `put`: um fallback "de alguns dias atrás" ainda é enormemente melhor que
 * 502 pro crawler, e uma indisponibilidade longa da Beehiiv é exatamente o
 * cenário em que um TTL curto teria apagado o fallback bem na hora que ele
 * mais serviria. `Cache-Control` do fallback é mais curto que o normal
 * (`ROOT_FALLBACK_CACHE_CONTROL`) — uma cópia servida em modo degradado não
 * deve travar a edge da Cloudflare por 1h inteira depois do upstream já ter
 * voltado.
 *
 * Avaliado e descartado por ora: gerar a lista em BUILD (a partir de
 * `data/beehiiv-cache/`) em vez de em request — mudança maior (precisaria de
 * um passo de build/deploy que hoje não existe pra este Worker, e o dado em
 * `data/beehiiv-cache/` não é sincronizado automaticamente pro Worker em
 * produção) pra resolver o mesmo problema que o fallback de KV já resolve
 * com risco bem menor. Registrado aqui pra próxima sessão não reabrir a
 * pergunta sem contexto — não é código morto nem esquecimento, é escopo
 * cortado deliberadamente.
 */
const ROOT_CACHE_KV_KEY = "cache:arquivo-root:html-v1";
const ROOT_FALLBACK_CACHE_CONTROL = "public, max-age=300";

interface RootCacheEntry {
  html: string;
  /** ISO 8601 completo (não `YYYY-MM-DD`) — só pra log/diagnóstico, nunca
   * exposto como `Last-Modified` (a raiz não emite esse header — ver nota
   * de escopo na docstring do módulo, item 3 não pede ETag/304 na raiz). */
  generatedAt: string;
}

/** Lê o último HTML bem-sucedido do KV. `null` em qualquer cenário que não
 * seja "achei uma entrada válida" (sem binding, cache-miss, JSON corrompido,
 * erro de rede do KV) — nunca lança, o caller trata `null` como "sem
 * fallback disponível, segue pro 502 de sempre". */
async function readRootCache(kv: KVNamespace | undefined): Promise<RootCacheEntry | null> {
  if (!kv) return null;
  try {
    const raw = await kv.get(ROOT_CACHE_KV_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RootCacheEntry>;
    if (typeof parsed.html !== "string" || typeof parsed.generatedAt !== "string") return null;
    return { html: parsed.html, generatedAt: parsed.generatedAt };
  } catch {
    return null;
  }
}

/** Grava o HTML recém-montado com sucesso no KV, pra servir de fallback na
 * próxima falha. Fail-soft: uma falha de escrita (KV indisponível, rate
 * limit) NUNCA derruba a resposta 200 que o request atual já tem pronta —
 * só significa que o PRÓXIMO fallback, se precisar, vai usar uma cópia mais
 * velha. */
async function writeRootCache(kv: KVNamespace | undefined, html: string): Promise<void> {
  if (!kv) return;
  try {
    const entry: RootCacheEntry = { html, generatedAt: new Date().toISOString() };
    await kv.put(ROOT_CACHE_KV_KEY, JSON.stringify(entry));
  } catch {
    // fail-soft — ver docstring da função.
  }
}

export default {
  // `env = {}` (default, não obrigatório): `test/arquivo-render.test.ts`
  // chama `worker.fetch(new Request(...))` com 1 argumento só (Env não
  // existia antes do #4902) — default vazio preserva isso sem exigir que
  // cada call site passe um `env` explícito, e casa com o resto do módulo
  // (`incrementAiFetchCounter` já trata KV ausente como no-op).
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    // #5097 item D: fecha o host genérico `arquivo.diaria.workers.dev` —
    // confirmado ao vivo (#5097) servindo 200 com o conteúdo INTEIRO em
    // paralelo ao host canônico. Redirect ANTES de qualquer outra lógica (log
    // de Referer, sitemap, robots, hubs) — nenhuma delas deveria rodar quando
    // a resposta certa é só redirecionar. #5104: método explícito (este
    // Worker só serve `GET`, mas o helper decide 301/308 corretamente pra
    // qualquer método futuro).
    const redirect = resolveWorkersDevRedirect(request.url, new URL(PAGE_URL).host, request.method);
    if (redirect.shouldRedirect) {
      return Response.redirect(redirect.location, redirect.status);
    }

    const url = new URL(request.url);
    // #4558 Parte C: log estruturado (Workers Logs) quando o Referer aponta
    // pra um dos 4 assistentes de IA — complemento barato ao monitor de
    // citação (scripts/geo-citation-monitor.ts), já que boa parte do
    // tráfego vindo de assistente chega SEM Referer e cai como "direct".
    // Nunca bloqueia a resposta (try/catch isolado, fail-soft).
    try {
      const aiHost = matchAiReferrerHost(request.headers.get("Referer"));
      if (aiHost) {
        logAiReferrerHit("arquivo", aiHost, url.pathname);
        // #4902 item 2: persiste o hit que o log acima já detecta mas não
        // retém (console.log nunca é lido depois — wrangler tail só mostra
        // ao vivo).
        const day = new Date().toISOString().slice(0, 10);
        // await (não fire-and-forget): sem `ctx.waitUntil`, uma promise solta
        // pode ser cancelada quando o execution context termina — mesmo
        // padrão (await direto) de `incrementKvCounter` em
        // `workers/cursos/src/index.ts`.
        await incrementAiFetchCounter(env.CURSOS_SUBSCRIBERS, aiFetchReferrerCounterKey(aiHost, day));
      }
    } catch {
      // logging nunca derruba a página — ver mesma disciplina do
      // catch genérico em handleIndex de workers/cursos/src/index.ts.
    }
    // #4902 item 1: contador de FETCH por bot de recuperação nomeado
    // (OAI-SearchBot, ChatGPT-User, Claude-User, Claude-SearchBot,
    // PerplexityBot, Perplexity-User, Googlebot, bingbot) — complementa o
    // log de Referer acima, que só capta a MINORIA do tráfego de assistente
    // que chega com Referer preenchido. Mesmo bloco fail-soft, try/catch
    // isolado — nunca bloqueia a resposta.
    try {
      const bot = matchAiFetchBot(request.headers.get("User-Agent"));
      if (bot) {
        const day = new Date().toISOString().slice(0, 10);
        await incrementAiFetchCounter(env.CURSOS_SUBSCRIBERS, aiFetchBotCounterKey(bot, day));
      }
    } catch {
      // mesma disciplina fail-soft do bloco de Referer acima.
    }
    if (url.pathname === "/sitemap.xml") {
      return sitemapResponse();
    }
    if (url.pathname === "/robots.txt") {
      return robotsResponse();
    }
    if (url.pathname === "/feed.xml") {
      return feedRoute();
    }
    // #5262: Política de Privacidade pública. O Google revalida esta URL
    // periodicamente enquanto a marca estiver verificada — se ela passar a
    // responder 404, a verificação cai. Aceita com e sem barra final porque
    // o valor colado no console é digitado à mão e um 404 por barra sobrando
    // custaria um ciclo inteiro de re-verificação pra diagnosticar.
    if (url.pathname === "/privacidade" || url.pathname === "/privacidade/") {
      return htmlResponse(renderPrivacyPage(), 200, { etag: true });
    }
    // #4909 item 2: arquivo de chave do IndexNow — só casa quando a var
    // está configurada (ver docstring de Env.INDEXNOW_KEY); sem ela, este
    // `if` nunca é verdadeiro e o pathname cai no 404 normal, igual antes.
    if (env.INDEXNOW_KEY && url.pathname === `/${env.INDEXNOW_KEY}.txt`) {
      return indexNowKeyResponse(env.INDEXNOW_KEY);
    }
    // #4558 Parte A: hubs temáticos — HTML já gerado e commitado
    // (`hubs/registry.ts`), servido tal qual, sem fetch/render em runtime.
    // `Object.hasOwn` (não `HUB_REGISTRY[slug]` cru + `!html`) — achado do
    // fleet review da PR: um slug igual a uma propriedade herdada de
    // `Object.prototype` (`constructor`, `toString`, `hasOwnProperty`,
    // `__proto__`) faz o lookup em objeto plano devolver essa função/valor
    // herdado (truthy) em vez de `undefined`, escapando do `if (!html)` e
    // servindo 200 com lixo (`String(Object.prototype.toString)`) em vez do
    // 404 esperado.
    if (url.pathname.startsWith("/temas/")) {
      const slug = url.pathname.slice("/temas/".length).replace(/\/$/, "");
      if (!Object.hasOwn(HUB_REGISTRY, slug)) return new Response("Not found", { status: 404 });
      // #4909/#5124: Last-Modified deriva da data de COBERTURA do hub
      // (hubCoverageDate — edição mais recente citada, nunca um valor
      // separado) + ETag do conteúdo — sinal de rastreio pra crawler/cache,
      // não fator de citação declarado por nenhum fabricante.
      const hubResponse = htmlResponse(HUB_REGISTRY[slug], 200, { lastModified: HUB_LASTMOD[slug], etag: true });
      // #5134 itens 1-2: requisição condicional (If-None-Match/
      // If-Modified-Since) que casa com o ETag/Last-Modified acima vira 304
      // corpo vazio, em vez de sempre re-servir os ~KB inteiros do hub.
      return conditionalNotModified(request, hubResponse) ?? hubResponse;
    }
    if (url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }

    let xml: string;
    try {
      xml = await fetchSitemapXml();
    } catch (e) {
      console.error(
        "[arquivo] falha ao buscar sitemap:",
        e instanceof Error ? e.message : String(e),
      );
      // #5134 item 3: upstream fora do ar não é mais 502 automático — serve
      // a última renderização boa do KV quando existir (ver docstring de
      // readRootCache/writeRootCache acima). Só cai no 502 de sempre quando
      // NUNCA houve um sucesso pra cachear (ex: 1º request de todos, ou KV
      // indisponível).
      const fallback = await readRootCache(env.CURSOS_SUBSCRIBERS);
      if (fallback) return htmlResponse(fallback.html, 200, { cacheControl: ROOT_FALLBACK_CACHE_CONTROL });
      return errorPage();
    }

    try {
      const entries = parseSitemap(xml);
      const html = buildArchiveHtml(entries);
      // Fire-and-await (não fire-and-forget — mesma disciplina do resto do
      // módulo, ver comentário de incrementAiFetchCounter acima): sem
      // `ctx.waitUntil`, uma promise solta pode ser cancelada quando o
      // execution context termina. Fail-soft internamente (writeRootCache
      // nunca lança) — não atrasa nem arrisca a resposta 200 que já está
      // pronta.
      await writeRootCache(env.CURSOS_SUBSCRIBERS, html);
      return htmlResponse(html);
    } catch (e) {
      console.error(
        "[arquivo] sitemap inválido:",
        e instanceof Error ? e.message : String(e),
      );
      const fallback = await readRootCache(env.CURSOS_SUBSCRIBERS);
      if (fallback) return htmlResponse(fallback.html, 200, { cacheControl: ROOT_FALLBACK_CACHE_CONTROL });
      return errorPage();
    }
  },
};
