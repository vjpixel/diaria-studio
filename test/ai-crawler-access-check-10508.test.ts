/**
 * test/ai-crawler-access-check-10508.test.ts (#10508 Parte B)
 *
 * Regressão do achado: a zona devolvia 403 a GPTBot/ClaudeBot com o
 * `robots.txt` correto, e o drift check (só texto) não via. Aqui: a sonda por
 * UA acusa o 403, a consulta GraphQL soma os 403 reais fora Amazonbot, e os
 * dois viram achados de alarme. Fetch sempre mockado — nunca rede real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AI_CRAWLER_PROBE_HOSTS,
  AI_CRAWLER_PROBE_UAS,
  aiBotLabelFromUserAgent,
  classifyProbeStatus,
  probeAiCrawlerAccess,
  probeAllAiCrawlerAccess,
  blockedProbesByHost,
  buildAiCrawler403Query,
  fetchAiCrawler403Rows,
  summarizeAiCrawler403,
  hasPendingAiCrawlerFindings,
  aiCrawler403ContentSignature,
  buildAiCrawlerAlarmEmailLines,
  type AiCrawlerProbeResult,
} from "../scripts/lib/ai-crawler-access-check.ts";
import { toAiCrawlerAlarmFindings, buildCombinedAlarmEmail } from "../scripts/robots-txt-drift-check.ts";
import { analyzeRobotsTxt } from "../scripts/lib/robots-txt-drift-check.ts";

const CF_BLOCK_BODY = "Your request was blocked.";

/** Mock da zona do incidente: 403 para UA de GPTBot/ClaudeBot em `/`, 200
 * no `/robots.txt` (isento pela regra gerenciada). */
function incidentZoneFetch(): { fetchFn: typeof fetch; seen: { url: string; ua: string }[] } {
  const seen: { url: string; ua: string }[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const ua = String((init?.headers as Record<string, string>)?.["User-Agent"] ?? "");
    seen.push({ url, ua });
    if (url.endsWith("/robots.txt")) {
      return new Response("Content-Signal: search=yes,ai-train=yes,use=reference\nUser-agent: *\nAllow: /\n", { status: 200 });
    }
    if (/GPTBot|ClaudeBot/.test(ua)) return new Response(CF_BLOCK_BODY, { status: 403 });
    return new Response("<html></html>", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

describe("#10508 — cenário real: robots.txt certo, borda barra o bot", () => {
  it("o texto do robots.txt NÃO acusa nada (o buraco que a issue descreve)", () => {
    const a = analyzeRobotsTxt("Content-Signal: search=yes,ai-train=yes,use=reference\nUser-agent: *\nAllow: /\n");
    assert.equal(a.hasCloudflareManagedBlock, false);
    assert.deepEqual(a.unexpectedBlockedBots, []);
  });

  it("a sonda por UA acusa o 403 em todos os 6 hosts, para GPTBot e ClaudeBot", async () => {
    const { fetchFn, seen } = incidentZoneFetch();
    const probes = await probeAllAiCrawlerAccess(AI_CRAWLER_PROBE_HOSTS, Object.keys(AI_CRAWLER_PROBE_UAS), fetchFn);
    assert.equal(probes.length, 12);
    assert.ok(probes.every((p) => p.status === "blocked" && p.httpStatus === 403));
    const blocked = blockedProbesByHost(probes);
    assert.equal(blocked.length, 6);
    assert.ok(blocked.every((b) => b.bots.join(",") === "ClaudeBot,GPTBot"));
    assert.ok(seen.some((s) => s.url === "https://diar.ia.br/"), "apex entra na sonda");
    assert.ok(seen.every((s) => /GPTBot|ClaudeBot/.test(s.ua)));
    assert.equal(hasPendingAiCrawlerFindings(probes, null), true);
    const findings = toAiCrawlerAlarmFindings(probes, null);
    assert.equal(findings.length, 6);
    assert.ok(findings.every((f) => f.family === "estado" && f.priority === "P2"));
  });

  it("depois da Parte A (200 pros bots) nada fica pendente", async () => {
    const fetchFn = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const probes = await probeAllAiCrawlerAccess(AI_CRAWLER_PROBE_HOSTS, Object.keys(AI_CRAWLER_PROBE_UAS), fetchFn);
    assert.ok(probes.every((p) => p.status === "allowed"));
    assert.equal(hasPendingAiCrawlerFindings(probes, summarizeAiCrawler403([])), false);
    assert.deepEqual(toAiCrawlerAlarmFindings(probes, summarizeAiCrawler403([])), []);
    assert.deepEqual(buildAiCrawlerAlarmEmailLines(probes, summarizeAiCrawler403([])), []);
  });
});

describe("classifyProbeStatus / probeAiCrawlerAccess — fail-soft", () => {
  it("403 bloqueado; 2xx/3xx liberado; 5xx/null inconclusivo", () => {
    assert.equal(classifyProbeStatus(403), "blocked");
    assert.equal(classifyProbeStatus(200), "allowed");
    assert.equal(classifyProbeStatus(301), "allowed");
    assert.equal(classifyProbeStatus(503), "inconclusive");
    assert.equal(classifyProbeStatus(404), "inconclusive");
    assert.equal(classifyProbeStatus(null), "inconclusive");
  });

  it("erro de rede vira inconclusive, nunca lança nem alarma", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await probeAiCrawlerAccess("diar.ia.br", "GPTBot", fetchFn);
    assert.equal(r.status, "inconclusive");
    assert.match(r.fetchError ?? "", /ECONNREFUSED/);
    assert.equal(hasPendingAiCrawlerFindings([r], null), false);
  });

  it("não segue redirect (redirect: manual)", async () => {
    let redirectOpt: RequestRedirect | undefined;
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      redirectOpt = init?.redirect;
      return new Response(null, { status: 301, headers: { location: "https://x/" } });
    }) as unknown as typeof fetch;
    const r = await probeAiCrawlerAccess("livros.diar.ia.br", "ClaudeBot", fetchFn);
    assert.equal(redirectOpt, "manual");
    assert.equal(r.status, "allowed");
  });
});

describe("aiBotLabelFromUserAgent", () => {
  it("reconhece os tokens do incidente e distingue Applebot-Extended de Applebot", () => {
    assert.equal(aiBotLabelFromUserAgent(AI_CRAWLER_PROBE_UAS.GPTBot), "GPTBot");
    assert.equal(aiBotLabelFromUserAgent(AI_CRAWLER_PROBE_UAS.ClaudeBot), "ClaudeBot");
    assert.equal(aiBotLabelFromUserAgent("meta-externalagent/1.1"), "meta-externalagent");
    assert.equal(aiBotLabelFromUserAgent("Mozilla/5.0 (compatible; Amazonbot/0.1)"), "Amazonbot");
    assert.equal(aiBotLabelFromUserAgent("Applebot-Extended/0.1"), "Applebot-Extended");
    assert.equal(aiBotLabelFromUserAgent("Claude-SearchBot/1.0"), "Claude-SearchBot");
    assert.equal(aiBotLabelFromUserAgent("algo"), "outro");
  });
});

function gqlResponse(groups: { count: number; host: string; ua: string }[], extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      data: {
        viewer: {
          zones: [
            {
              httpRequestsAdaptiveGroups: groups.map((g) => ({
                count: g.count,
                dimensions: { clientRequestHTTPHost: g.host, userAgent: g.ua },
              })),
            },
          ],
        },
      },
      ...extra,
    }),
    { status: 200 },
  );
}

describe("403 reais via GraphQL", () => {
  it("query filtra 403 + verifiedBotCategory AI Crawler, janela de 24h", () => {
    const { query, variables } = buildAiCrawler403Query("zone", "2026-10-18T00:00:00.000Z", "2026-10-19T00:00:00.000Z");
    assert.match(query, /edgeResponseStatus: 403/);
    assert.match(query, /verifiedBotCategory: "AI Crawler"/);
    assert.match(query, /httpRequestsAdaptiveGroups/);
    assert.equal(variables.zoneTag, "zone");
  });

  it("soma os 403 fora Amazonbot e alarma (cenário do incidente)", async () => {
    let body: string | undefined;
    let auth: string | undefined;
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      body = String(init?.body);
      auth = (init?.headers as Record<string, string>).Authorization;
      return gqlResponse([
        { count: 4, host: "diar.ia.br", ua: AI_CRAWLER_PROBE_UAS.GPTBot },
        { count: 2, host: "cursos.diar.ia.br", ua: AI_CRAWLER_PROBE_UAS.GPTBot },
        { count: 3, host: "diar.ia.br", ua: "meta-externalagent/1.1" },
        { count: 50, host: "diar.ia.br", ua: "Mozilla/5.0 (compatible; Amazonbot/0.1)" },
      ]);
    }) as unknown as typeof fetch;
    const now = new Date("2026-10-19T13:15:00Z");
    const r = await fetchAiCrawler403Rows("zone-x", "tok", fetchFn, now);
    assert.equal(r.status, "ok");
    assert.equal(auth, "Bearer tok");
    const vars = JSON.parse(body!).variables;
    assert.equal(vars.until, now.toISOString());
    assert.equal(vars.since, "2026-10-18T13:15:00.000Z");
    if (r.status !== "ok") return;
    const s = summarizeAiCrawler403(r.rows);
    assert.equal(s.total, 9);
    assert.equal(s.intentionallyBlocked, 50);
    assert.equal(s.truncated, false);
    assert.deepEqual(s.byHostBot[0], { host: "diar.ia.br", bot: "GPTBot", count: 4 });
    assert.equal(hasPendingAiCrawlerFindings([], s), true);
    const findings = toAiCrawlerAlarmFindings([], s);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fingerprint, "ai-crawler-403-zona");
    assert.equal(findings[0].contentSignature, "cursos.diar.ia.br:GPTBot,diar.ia.br:GPTBot,diar.ia.br:meta-externalagent");
  });

  it("só Amazonbot com 403 NÃO alarma (bloqueio intencional)", () => {
    const s = summarizeAiCrawler403([{ count: 80, host: "diar.ia.br", userAgent: "Amazonbot/0.1" }]);
    assert.equal(s.total, 0);
    assert.equal(hasPendingAiCrawlerFindings([], s), false);
  });

  it("fingerprint da zona é fixo e a assinatura ignora contagem (sem issue nova por dia)", () => {
    const a = summarizeAiCrawler403([{ count: 6, host: "diar.ia.br", userAgent: "GPTBot/1.1" }]);
    const b = summarizeAiCrawler403([{ count: 11, host: "diar.ia.br", userAgent: "GPTBot/1.1" }]);
    assert.equal(aiCrawler403ContentSignature(a), aiCrawler403ContentSignature(b));
  });

  it("resposta com o teto de linhas marca truncated", () => {
    const rows = Array.from({ length: 3 }, () => ({ count: 1, host: "h", userAgent: "GPTBot" }));
    assert.equal(summarizeAiCrawler403(rows, 3).truncated, true);
  });

  it("token ausente = skipped, sem chamada de rede", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const r = await fetchAiCrawler403Rows("zone", undefined, fetchFn);
    assert.equal(r.status, "skipped");
    assert.equal(called, false);
  });

  it("authz por campo (HTTP 200 com errors[]) = error, nunca 'zero 403'", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ data: null, errors: [{ message: "does not have access to the field", extensions: { code: "authz" } }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const r = await fetchAiCrawler403Rows("zone", "tok", fetchFn);
    assert.equal(r.status, "error");
  });

  it("HTTP 403 da API, rede e JSON inválido = error, nunca lança", async () => {
    const f403 = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    assert.equal((await fetchAiCrawler403Rows("z", "t", f403)).status, "error");
    const fNet = (async () => {
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;
    assert.equal((await fetchAiCrawler403Rows("z", "t", fNet)).status, "error");
    const fBad = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    assert.equal((await fetchAiCrawler403Rows("z", "t", fBad)).status, "error");
  });
});

describe("e-mail combinado", () => {
  const blockedProbe: AiCrawlerProbeResult = {
    host: "diar.ia.br",
    bot: "GPTBot",
    url: "https://diar.ia.br/",
    status: "blocked",
    httpStatus: 403,
    fetchError: null,
  };

  it("só crawler de IA pendente: assunto e corpo próprios, com a correção da Parte A", () => {
    const { subject, body } = buildCombinedAlarmEmail([], [blockedProbe], null, new Date("2026-10-19T00:00:00Z"));
    assert.match(subject, /crawlers de IA/);
    assert.match(body, /diar\.ia\.br: GPTBot/);
    assert.match(body, /Amazonbot/);
  });

  it("drift de robots.txt + crawler de IA: as duas seções", () => {
    const drift = {
      host: "arquivo.diar.ia.br",
      url: "https://arquivo.diar.ia.br/robots.txt",
      status: "drift" as const,
      httpStatus: 200,
      fetchError: null,
      reasons: ["bloco gerenciado"],
      message: "drift",
    };
    const { subject, body } = buildCombinedAlarmEmail([drift], [blockedProbe], null, new Date());
    assert.match(subject, /robots\.txt.*crawlers de IA/);
    assert.match(body, /arquivo\.diar\.ia\.br/);
    assert.match(body, /Sonda por UA/);
  });
});
