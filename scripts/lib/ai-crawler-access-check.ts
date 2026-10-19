/**
 * scripts/lib/ai-crawler-access-check.ts (#10508 Parte B)
 *
 * Miolo testável da extensão de `scripts/robots-txt-drift-check.ts` que
 * deixou de olhar só o TEXTO do `robots.txt` e passou a olhar se a borda da
 * Cloudflare de fato DEIXA o crawler de IA entrar.
 *
 * ## Por que existe
 *
 * Em outubro/2026 (#10508) a zona `diar.ia.br` devolvia 403 na borda
 * ("Your request was blocked.", 25 bytes) para GPTBot, ClaudeBot, CCBot,
 * Bytespider e meta-externalagent nos 6 hosts onde esses bots aparecem —
 * contra a política de 03/08/2026 (`docs/ai-crawlers-policy.md`). O
 * `robots.txt` servido estava correto o tempo todo (`Allow: /`,
 * `Content-Signal: ... ai-train=yes`), então o drift check textual nunca
 * acusou nada: o bloqueio era uma regra gerenciada da zona ("Block AI bots"
 * / AI Crawl Control), que isenta o próprio `/robots.txt`. Ficou pelo menos
 * 4 semanas sem ninguém ver.
 *
 * ## Os dois sinais (independentes, cada um fail-soft)
 *
 * 1. **Sonda ativa por UA** (`probeAiCrawlerAccess`): `GET https://{host}/`
 *    com o User-Agent de GPTBot e de ClaudeBot. 403 = bloqueado. É o mesmo
 *    teste que o editor usa pra confirmar a Parte A (`curl -A '...GPTBot/1.1'
 *    https://diar.ia.br/` → 200). Ressalva: a sonda sai do NOSSO IP, então
 *    para a Cloudflare é um bot NÃO verificado com UA de bot verificado — se
 *    um dia a zona ligar uma regra que barra "UA de bot verificado vindo de
 *    IP não verificado", a sonda acusa 403 sem que o GPTBot real seja
 *    barrado. Por isso existe o sinal 2, que é a verdade de campo.
 * 2. **403 reais do dia via GraphQL** (`fetchAiCrawler403Rows` +
 *    `summarizeAiCrawler403`): soma, nas últimas 24h, as respostas 403 da
 *    zona para requisições com `verifiedBotCategory = "AI Crawler"`
 *    (dataset `httpRequestsAdaptiveGroups`, dimensões confirmadas liberadas
 *    no plano Free em 22/08/2026 — ver `scripts/probe-cf-zone-analytics.ts`).
 *    Amazonbot fica de fora: é bloqueado DE PROPÓSITO (política seletiva).
 *
 * Só 403 alarma na sonda. Outro status de erro (5xx, rede, timeout) vira
 * `inconclusive` — log, nunca alarme: alcançabilidade do host já é coberta
 * pelo próprio drift check do `robots.txt` (que alarma host fora do ar), e
 * duplicar esse alarme aqui só geraria ruído. Na consulta GraphQL, token
 * ausente vira `skipped` e erro de API/autorização vira `error` — os dois
 * logados, nenhum derruba a execução nem alarma (o mesmo `CLOUDFLARE_API_TOKEN`
 * já devolveu `authz` em campos específicos; um alarme por isso seria sobre o
 * token, não sobre os crawlers).
 */

/** Hosts onde os crawlers de IA aparecem (medição do #10508). Lista fixa, e
 * não `discoverWorkerPublicHosts`: o apex não é descoberto por aquela
 * varredura, e a pergunta aqui é "a zona deixa o bot entrar onde ele de fato
 * vai", não "todo Worker tem robots.txt". */
export const AI_CRAWLER_PROBE_HOSTS: readonly string[] = [
  "diar.ia.br",
  "cursos.diar.ia.br",
  "livros.diar.ia.br",
  "arquivo.diar.ia.br",
  "especial.diar.ia.br",
  "eia.diar.ia.br",
];

/** UAs publicados pelos operadores (OpenAI / Anthropic). */
export const AI_CRAWLER_PROBE_UAS: Readonly<Record<string, string>> = {
  GPTBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)",
  ClaudeBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
};

/** Bots bloqueados DE PROPÓSITO (`docs/ai-crawlers-policy.md`) — 403 deles
 * não é drift. */
export const INTENTIONALLY_BLOCKED_AI_BOTS: readonly string[] = ["Amazonbot"];

/** Tokens de UA conhecidos. Primeiro que casa vence, então o token mais
 * específico vem antes do que é substring dele (`Applebot-Extended` antes
 * de `Applebot`). */
const KNOWN_AI_BOT_TOKENS: readonly string[] = [
  "Amazonbot",
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "CCBot",
  "Bytespider",
  "meta-externalagent",
  "meta-externalfetcher",
  "Applebot-Extended",
  "Applebot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Google-CloudVertexBot",
  "MistralAI-User",
  "cohere-ai",
  "DuckAssistBot",
];

/** Rótulo do bot a partir do UA cru (case-insensitive). `"outro"` quando
 * nenhum token conhecido casa — o UA cru continua no resumo pra triagem. */
export function aiBotLabelFromUserAgent(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  for (const token of KNOWN_AI_BOT_TOKENS) {
    if (ua.includes(token.toLowerCase())) return token;
  }
  return "outro";
}

// ─── Sinal 1: sonda ativa por UA ──────────────────────────────────────────

export type AiCrawlerProbeStatus = "allowed" | "blocked" | "inconclusive";

export interface AiCrawlerProbeResult {
  host: string;
  bot: string;
  url: string;
  status: AiCrawlerProbeStatus;
  httpStatus: number | null;
  fetchError: string | null;
}

/** Classificação pura do status HTTP da sonda. 2xx/3xx = a borda deixou
 * passar (redirect é resposta do Worker, não bloqueio); 403 = bloqueado;
 * resto = inconclusivo. */
export function classifyProbeStatus(httpStatus: number | null): AiCrawlerProbeStatus {
  if (httpStatus === 403) return "blocked";
  if (httpStatus !== null && httpStatus >= 200 && httpStatus < 400) return "allowed";
  return "inconclusive";
}

/** `GET https://{host}/` com o UA do bot. NUNCA lança — erro de rede vira
 * `inconclusive` com `fetchError`. */
export async function probeAiCrawlerAccess(
  host: string,
  bot: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<AiCrawlerProbeResult> {
  const url = `https://${host}/`;
  const ua = AI_CRAWLER_PROBE_UAS[bot];
  if (!ua) {
    return { host, bot, url, status: "inconclusive", httpStatus: null, fetchError: `UA desconhecido pro bot ${bot}` };
  }
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { "User-Agent": ua },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    return { host, bot, url, status: classifyProbeStatus(res.status), httpStatus: res.status, fetchError: null };
  } catch (e) {
    return { host, bot, url, status: "inconclusive", httpStatus: null, fetchError: (e as Error).message };
  }
}

/** Sonda todos os pares host × bot em paralelo (cada par fail-soft). */
export async function probeAllAiCrawlerAccess(
  hosts: readonly string[] = AI_CRAWLER_PROBE_HOSTS,
  bots: readonly string[] = Object.keys(AI_CRAWLER_PROBE_UAS),
  fetchFn: typeof fetch = fetch,
): Promise<AiCrawlerProbeResult[]> {
  const pairs = hosts.flatMap((host) => bots.map((bot) => ({ host, bot })));
  return Promise.all(pairs.map(({ host, bot }) => probeAiCrawlerAccess(host, bot, fetchFn)));
}

/** Agrupa os bloqueios por host — `[{host, bots}]`, só hosts com ≥1 bot
 * bloqueado, bots em ordem alfabética (fingerprint estável). */
export function blockedProbesByHost(results: readonly AiCrawlerProbeResult[]): { host: string; bots: string[] }[] {
  const map = new Map<string, Set<string>>();
  for (const r of results) {
    if (r.status !== "blocked") continue;
    if (!map.has(r.host)) map.set(r.host, new Set());
    map.get(r.host)!.add(r.bot);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, bots]) => ({ host, bots: [...bots].sort() }));
}

// ─── Sinal 2: 403 reais do dia via GraphQL ────────────────────────────────

export const CF_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
/** Teto de linhas por consulta. Se a resposta vier com exatamente isso, o
 * resumo marca `truncated` — o total é um PISO, não o valor exato. */
export const AI_CRAWLER_403_QUERY_LIMIT = 1000;

export interface AiCrawler403Row {
  count: number;
  host: string;
  userAgent: string;
}

export function buildAiCrawler403Query(
  zoneTag: string,
  sinceISO: string,
  untilISO: string,
  limit: number = AI_CRAWLER_403_QUERY_LIMIT,
): { query: string; variables: Record<string, unknown> } {
  return {
    query: `
      query AiCrawler403($zoneTag: String!, $since: Time!, $until: Time!, $limit: Int!) {
        viewer {
          zones(filter: { zoneTag: $zoneTag }) {
            httpRequestsAdaptiveGroups(
              limit: $limit,
              filter: {
                datetime_geq: $since,
                datetime_lt: $until,
                edgeResponseStatus: 403,
                verifiedBotCategory: "AI Crawler"
              }
            ) {
              count
              dimensions { clientRequestHTTPHost userAgent }
            }
          }
        }
      }
    `,
    variables: { zoneTag, since: sinceISO, until: untilISO, limit },
  };
}

export type AiCrawler403FetchResult =
  | { status: "ok"; rows: AiCrawler403Row[]; since: string; until: string }
  | { status: "skipped"; detail: string }
  | { status: "error"; httpStatus: number | null; detail: string };

/** Extrai as linhas do payload GraphQL. `null` se o formato não bate. */
export function parseAiCrawler403Payload(json: unknown): AiCrawler403Row[] | null {
  const zones = (json as { data?: { viewer?: { zones?: unknown } } })?.data?.viewer?.zones;
  if (!Array.isArray(zones)) return null;
  const rows: AiCrawler403Row[] = [];
  for (const z of zones) {
    const groups = (z as { httpRequestsAdaptiveGroups?: unknown })?.httpRequestsAdaptiveGroups;
    if (!Array.isArray(groups)) return null;
    for (const g of groups) {
      const count = (g as { count?: unknown })?.count;
      const dims = (g as { dimensions?: { clientRequestHTTPHost?: unknown; userAgent?: unknown } })?.dimensions;
      if (typeof count !== "number") continue;
      rows.push({
        count,
        host: typeof dims?.clientRequestHTTPHost === "string" ? dims.clientRequestHTTPHost : "(desconhecido)",
        userAgent: typeof dims?.userAgent === "string" ? dims.userAgent : "",
      });
    }
  }
  return rows;
}

/** Consulta os 403 de "AI Crawler" das últimas 24h. NUNCA lança. Note que a
 * negativa de autorização POR CAMPO chega como HTTP 200 com `errors[]`
 * (medido em 22/08/2026, ver `probe-cf-zone-analytics.ts`) — tratada como
 * `error`, não como "zero 403". */
export async function fetchAiCrawler403Rows(
  zoneTag: string,
  token: string | undefined,
  fetchFn: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<AiCrawler403FetchResult> {
  if (!token) {
    return { status: "skipped", detail: "CLOUDFLARE_API_TOKEN ausente — consulta dos 403 de AI Crawler não rodou." };
  }
  const until = now.toISOString();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { query, variables } = buildAiCrawler403Query(zoneTag, since, until);
  let res: Response;
  let bodyText: string;
  try {
    res = await fetchFn(CF_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    bodyText = await res.text();
  } catch (e) {
    return { status: "error", httpStatus: null, detail: `rede/timeout na GraphQL: ${(e as Error).message}` };
  }
  if (!res.ok) {
    return { status: "error", httpStatus: res.status, detail: `HTTP ${res.status}: ${bodyText.slice(0, 300)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return { status: "error", httpStatus: res.status, detail: `resposta não-JSON: ${bodyText.slice(0, 200)}` };
  }
  const errors = (json as { errors?: unknown[] })?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return { status: "error", httpStatus: res.status, detail: `errors no payload GraphQL: ${JSON.stringify(errors).slice(0, 500)}` };
  }
  const rows = parseAiCrawler403Payload(json);
  if (rows === null) {
    return { status: "error", httpStatus: res.status, detail: `payload sem viewer.zones[].httpRequestsAdaptiveGroups: ${bodyText.slice(0, 300)}` };
  }
  return { status: "ok", rows, since, until };
}

export interface AiCrawler403Summary {
  /** Soma dos 403, EXCLUINDO os bots bloqueados de propósito. */
  total: number;
  /** 403 de bots bloqueados de propósito (Amazonbot) — só informativo. */
  intentionallyBlocked: number;
  /** Quebra por host × bot, ordenada por contagem desc. */
  byHostBot: { host: string; bot: string; count: number }[];
  /** A consulta voltou com o teto de linhas — `total` é piso. */
  truncated: boolean;
}

export function summarizeAiCrawler403(
  rows: readonly AiCrawler403Row[],
  limit: number = AI_CRAWLER_403_QUERY_LIMIT,
): AiCrawler403Summary {
  const intentional = new Set(INTENTIONALLY_BLOCKED_AI_BOTS.map((b) => b.toLowerCase()));
  const agg = new Map<string, { host: string; bot: string; count: number }>();
  let total = 0;
  let intentionallyBlocked = 0;
  for (const r of rows) {
    const bot = aiBotLabelFromUserAgent(r.userAgent);
    if (intentional.has(bot.toLowerCase())) {
      intentionallyBlocked += r.count;
      continue;
    }
    total += r.count;
    const key = `${r.host}\u0000${bot}`;
    const cur = agg.get(key) ?? { host: r.host, bot, count: 0 };
    cur.count += r.count;
    agg.set(key, cur);
  }
  const byHostBot = [...agg.values()].sort(
    (a, b) => b.count - a.count || a.host.localeCompare(b.host) || a.bot.localeCompare(b.bot),
  );
  return { total, intentionallyBlocked, byHostBot, truncated: rows.length >= limit };
}

// ─── Alarme ────────────────────────────────────────────────────────────────

/** Chave estável do achado da sonda (por host). Muda só se o CONJUNTO de
 * bots bloqueados mudar. */
export function aiCrawlerProbeFindingKey(host: string, bots: readonly string[]): string {
  return `ai-crawler-probe|${host}|${[...bots].sort().join(",")}|403`;
}

/** Fingerprint FIXO do achado agregado da zona — a contagem varia todo dia
 * e não pode virar issue nova por isso; a mudança de conteúdo vai por
 * `aiCrawler403ContentSignature` (comentário na issue existente, #6798). */
export const AI_CRAWLER_403_ZONE_FINGERPRINT = "ai-crawler-403-zona";

/** Assinatura de conteúdo: o conjunto host × bot (sem contagem). */
export function aiCrawler403ContentSignature(summary: AiCrawler403Summary): string {
  return [...new Set(summary.byHostBot.map((e) => `${e.host}:${e.bot}`))].sort().join(",");
}

export function hasPendingAiCrawlerFindings(
  probes: readonly AiCrawlerProbeResult[],
  summary: AiCrawler403Summary | null,
): boolean {
  return blockedProbesByHost(probes).length > 0 || (summary !== null && summary.total > 0);
}

const PARTE_A_HINT = [
  "Correção (painel da zona Cloudflare, não código): Security → Bots → desligar",
  '"Block AI bots", ou em AI Crawl Control liberar GPTBot, ClaudeBot, CCBot,',
  "Google-Extended, Bytespider, meta-externalagent e Applebot-Extended, MANTENDO",
  "Amazonbot bloqueado (política seletiva, docs/ai-crawlers-policy.md, #10508).",
];

/** Corpo da issue do achado da sonda. */
export function buildAiCrawlerProbeIssueBody(host: string, bots: readonly string[]): string {
  return [
    "Achado automático do alarme `Diaria-Robots-Txt-Drift-Check`",
    "(`scripts/robots-txt-drift-check.ts`, sonda de crawler de IA, #10508).",
    "",
    `Host: \`${host}\``,
    `Bloqueado com 403 na borda para o UA de: ${bots.join(", ")}`,
    `Reproduzir: \`curl -s -o /dev/null -w '%{http_code}' -A '${AI_CRAWLER_PROBE_UAS[bots[0]] ?? bots[0]}' https://${host}/\``,
    "",
    "A política de 03/08/2026 manda liberar os crawlers de IA (docs/ai-crawlers-policy.md).",
    ...PARTE_A_HINT,
  ].join("\n");
}

/** Corpo da issue do achado agregado da zona. */
export function buildAiCrawler403IssueBody(summary: AiCrawler403Summary): string {
  const lines = [
    "Achado automático do alarme `Diaria-Robots-Txt-Drift-Check`",
    "(`scripts/robots-txt-drift-check.ts`, 403 reais de AI Crawler, #10508).",
    "",
    `Nas últimas 24h a zona devolveu ${summary.total}${summary.truncated ? "+" : ""} resposta(s) 403 a bots`,
    'verificados da categoria "AI Crawler" (fora Amazonbot, que é bloqueado de propósito):',
    "",
  ];
  for (const e of summary.byHostBot.slice(0, 20)) lines.push(`- ${e.host} · ${e.bot}: ${e.count}`);
  if (summary.byHostBot.length > 20) lines.push(`- (+${summary.byHostBot.length - 20} combinações)`);
  lines.push("", ...PARTE_A_HINT);
  return lines.join("\n");
}

/** Seção do e-mail de alarme. Vazia (`[]`) quando não há nada pendente. */
export function buildAiCrawlerAlarmEmailLines(
  probes: readonly AiCrawlerProbeResult[],
  summary: AiCrawler403Summary | null,
): string[] {
  const blocked = blockedProbesByHost(probes);
  const zonePending = summary !== null && summary.total > 0;
  if (blocked.length === 0 && !zonePending) return [];
  const lines: string[] = ["Crawlers de IA barrados na borda da Cloudflare (#10508):"];
  if (blocked.length > 0) {
    lines.push("  Sonda por UA (GET / com UA de bot, 403 = bloqueado):");
    for (const b of blocked) lines.push(`    - ${b.host}: ${b.bots.join(", ")}`);
  }
  if (zonePending) {
    lines.push(
      `  403 reais nas últimas 24h (verifiedBotCategory = "AI Crawler", fora Amazonbot): ${summary!.total}${summary!.truncated ? "+" : ""}`,
    );
    for (const e of summary!.byHostBot.slice(0, 10)) lines.push(`    - ${e.host} · ${e.bot}: ${e.count}`);
  }
  lines.push("", ...PARTE_A_HINT.map((l) => `  ${l}`));
  return lines;
}
