/**
 * test/poll-embed-3521.test.ts (#3521)
 *
 * Widget embutível (iframe) do "É IA?" standalone pra sites parceiros —
 * sub-issue [S] do EPIC #3514, construído sobre a fundação #3516 (`/jogar`,
 * identidade anônima) + #3517 (share card) + #3518 (CTA de assinatura).
 * Cobre:
 *   - parseEmbedAllowedOrigins / buildFrameAncestorsCsp (pure) — allowlist
 *     de embutimento fail-closed (vazio → 'none')
 *   - resolveEmbedPartnerSlug / buildEmbedSubscribeUrl / buildEmbedJogarUrl
 *     (pure) — UTM do funil embed, `?partner=` nunca usado pra autorização
 *   - renderEmbedPageHtml (pure) — anti-spoiler, layout compacto, DS tokens,
 *     noindex, target=_blank em todo link/form que sai do widget
 *   - GET /embed — CSP frame-ancestors correto (allowlist configurada vs
 *     vazia), edição resolvida (hoje default, ?edition= override), SEM
 *     X-Frame-Options
 *   - applyFrameDenyHeaders (pure) + regressão: toda rota QUE NÃO seja
 *     /embed recebe X-Frame-Options: DENY + CSP frame-ancestors 'none'
 *     (hardening que fecha o gap de clickjacking pré-existente no resto do
 *     worker, achado de self-review #2038 corrigido junto desta issue)
 *   - endpoints 404 listam /embed
 *   - regressão: fluxo de voto (/vote) e demais rotas (/jogar, /leaderboard)
 *     continuam funcionando sem alteração de comportamento
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEmbedJogarUrl,
  buildEmbedSubscribeUrl,
  buildFrameAncestorsCsp,
  EMBED_DEFAULT_PARTNER,
  EMBED_UTM_MEDIUM,
  EMBED_UTM_SOURCE,
  handleEmbedPage,
  parseEmbedAllowedOrigins,
  renderEmbedPageHtml,
  resolveEmbedPartnerSlug,
} from "../workers/poll/src/embed.ts";
import worker, { applyFrameDenyHeaders, type Env } from "../workers/poll/src/index.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async getWithMetadata(key: string) {
      const v = m.get(key);
      return { value: v ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _map: m,
  };
}

const makeEnv = (seed: Record<string, string> = {}, embedAllowedOrigins?: string): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
  POLL: makeMapKV(seed),
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
  EMBED_ALLOWED_ORIGINS: embedAllowedOrigins,
});

// ── parseEmbedAllowedOrigins / buildFrameAncestorsCsp (pure) ────────────────

describe("parseEmbedAllowedOrigins (#3521)", () => {
  it("undefined/null/vazio → lista vazia", () => {
    assert.deepEqual(parseEmbedAllowedOrigins(undefined), []);
    assert.deepEqual(parseEmbedAllowedOrigins(null), []);
    assert.deepEqual(parseEmbedAllowedOrigins(""), []);
  });

  it("1 origem", () => {
    assert.deepEqual(parseEmbedAllowedOrigins("https://clarice.ai"), ["https://clarice.ai"]);
  });

  it("múltiplas origens CSV, com espaços tolerados", () => {
    assert.deepEqual(
      parseEmbedAllowedOrigins("https://clarice.ai, https://parceiro2.com "),
      ["https://clarice.ai", "https://parceiro2.com"],
    );
  });

  it("entradas vazias entre vírgulas são descartadas", () => {
    assert.deepEqual(parseEmbedAllowedOrigins("https://clarice.ai,,"), ["https://clarice.ai"]);
  });
});

describe("buildFrameAncestorsCsp (#3521) — fail-closed", () => {
  it("config ausente/vazia → 'none' (ninguém pode embutir)", () => {
    assert.equal(buildFrameAncestorsCsp(undefined), "frame-ancestors 'none'");
    assert.equal(buildFrameAncestorsCsp(null), "frame-ancestors 'none'");
    assert.equal(buildFrameAncestorsCsp(""), "frame-ancestors 'none'");
  });

  it("1 origem configurada → diretiva com essa origem", () => {
    assert.equal(buildFrameAncestorsCsp("https://clarice.ai"), "frame-ancestors https://clarice.ai");
  });

  it("múltiplas origens → espaço-separadas na diretiva (não vírgula — sintaxe CSP)", () => {
    assert.equal(
      buildFrameAncestorsCsp("https://clarice.ai,https://parceiro2.com"),
      "frame-ancestors https://clarice.ai https://parceiro2.com",
    );
  });
});

// ── resolveEmbedPartnerSlug / URLs de UTM (pure) ─────────────────────────────

describe("resolveEmbedPartnerSlug (#3521)", () => {
  it("ausente → default", () => {
    assert.equal(resolveEmbedPartnerSlug(null), EMBED_DEFAULT_PARTNER);
  });

  it("sanitiza pra minúsculo/[a-z0-9_-] e trunca em 40 chars", () => {
    assert.equal(resolveEmbedPartnerSlug("Clarice.AI!!"), "clariceai");
    assert.equal(resolveEmbedPartnerSlug("a".repeat(60)), "a".repeat(40));
  });

  it("só caracteres inválidos → cai no default (nunca string vazia)", () => {
    assert.equal(resolveEmbedPartnerSlug("!!!"), EMBED_DEFAULT_PARTNER);
  });

  it("nunca lança pra input adversarial", () => {
    assert.doesNotThrow(() => resolveEmbedPartnerSlug("<script>alert(1)</script>"));
  });
});

describe("buildEmbedSubscribeUrl / buildEmbedJogarUrl (#3521) — UTM do funil embed", () => {
  it("subscribe URL usa diaria.beehiiv.com DIRETO (#2613, mesma convenção do #3518)", () => {
    const url = buildEmbedSubscribeUrl("clarice");
    assert.match(url, /^https:\/\/diaria\.beehiiv\.com\/\?/);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("utm_source"), EMBED_UTM_SOURCE);
    assert.equal(parsed.searchParams.get("utm_medium"), EMBED_UTM_MEDIUM);
    assert.equal(parsed.searchParams.get("utm_campaign"), "clarice");
  });

  it("jogar URL é absoluta no domínio de marca do jogo (#3701 — eia.diar.ia.br, não o apex diar.ia.br que faz redirect e dropava query-string, #2613)", () => {
    const url = buildEmbedJogarUrl("clarice");
    assert.match(url, /^https:\/\/eia\.diar\.ia\.br\/jogar\?/);
  });

  it("utm_campaign reflete o partnerSlug (mensurável por parceiro, count-subscriptions-by-utm.ts)", () => {
    const url1 = buildEmbedSubscribeUrl("parceiro1");
    const url2 = buildEmbedSubscribeUrl("parceiro2");
    assert.notEqual(url1, url2);
  });
});

// ── renderEmbedPageHtml (pure) ───────────────────────────────────────────────

describe("renderEmbedPageHtml (#3521)", () => {
  const html = renderEmbedPageHtml({ edition: "260101", revealed: false, partnerSlug: "clarice" });

  it("anti-spoiler: não rotula qual imagem é IA antes do voto (mesma disciplina de /jogar)", () => {
    assert.doesNotMatch(html, /Gerada por IA/);
    assert.doesNotMatch(html, /Foto real/);
  });

  it("noindex — widget não deve ser indexado como página própria", () => {
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  });

  it("form de voto: brand=web fixo, action=/vote, target=_blank (fallback nativo nunca navega o iframe)", () => {
    assert.match(html, /action="\/vote"/);
    assert.match(html, /name="brand" value="web"/);
    assert.match(html, /<form id="embed-form" action="\/vote" method="GET" target="_blank">/);
  });

  it("CTA de assinatura + link 'jogar mais' usam target=_blank + rel=noopener (nunca navegam o iframe embutido)", () => {
    const subscribeBtn = /<a class="subscribe-btn"[^>]*target="_blank"[^>]*rel="noopener"/;
    const jogarLink = /<a href="[^"]*"[^>]*target="_blank"[^>]*rel="noopener">Jogar mais/;
    assert.match(html, subscribeBtn);
    assert.match(html, jogarLink);
  });

  it("CTA de assinatura carrega a URL com UTM do parceiro passado", () => {
    assert.match(html, /utm_campaign=clarice/);
  });

  it("script JS nunca faz window.location.href = voteUrl (só window.open/link — nunca navega o próprio iframe)", () => {
    assert.doesNotMatch(html, /window\.location\.href\s*=\s*voteUrl/);
  });

  it("script reusa o mesmo mecanismo fetch+DOMParser de /jogar (extrai .msg e #jogar-share-card)", () => {
    assert.match(html, /querySelector\(".msg"\)/);
    assert.match(html, /querySelector\("#jogar-share-card"\)/);
  });

  it("token de identidade: SEM cookie (só localStorage, diferente de /jogar) — decisão deliberada (item 5 do header)", () => {
    assert.doesNotMatch(html, /document\.cookie/);
  });

  it("imagens A/B da edição correta, sem rótulo/alt revelador antes do voto", () => {
    assert.match(html, /\/img\/img-260101-01-eia-A\.jpg/);
    assert.match(html, /\/img\/img-260101-01-eia-B\.jpg/);
  });

  it("copy de apoio muda com `revealed`, sem alterar o form nem revelar a resposta", () => {
    const revealedHtml = renderEmbedPageHtml({ edition: "260101", revealed: true, partnerSlug: "clarice" });
    assert.match(html, /o resultado sai assim que o poll de hoje fechar/i);
    assert.match(revealedHtml, /Vote e veja na hora se acertou/i);
  });
});

// ── GET /embed ────────────────────────────────────────────────────────────

describe("GET /embed (#3521)", () => {
  it("sem EMBED_ALLOWED_ORIGINS configurada → CSP frame-ancestors 'none' (bloqueado em qualquer lugar)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/embed"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
  });

  it("com EMBED_ALLOWED_ORIGINS configurada → CSP reflete a allowlist (embutível nela)", async () => {
    const env = makeEnv({}, "https://clarice.ai");
    const res = await worker.fetch(new Request("https://poll.test/embed"), env);
    assert.equal(res.headers.get("Content-Security-Policy"), "frame-ancestors https://clarice.ai");
  });

  it("NÃO emite X-Frame-Options (só suporta 1 domínio — deixaria a rota menos embutível que a CSP permite)", async () => {
    const env = makeEnv({}, "https://clarice.ai");
    const res = await worker.fetch(new Request("https://poll.test/embed"), env);
    assert.equal(res.headers.get("X-Frame-Options"), null);
  });

  it("edição default = hoje (BRT); ?edition= explícito (AAMMDD válido) sobrepõe", async () => {
    const env = makeEnv({ "correct:200101": "A" });
    const res = await worker.fetch(new Request("https://poll.test/embed?edition=200101"), env);
    const html = await res.text();
    assert.match(html, /img-200101-01-eia-A\.jpg/);
  });

  it("?partner= propaga pro utm_campaign da CTA/link de conversão", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/embed?partner=clarice"), env);
    const html = await res.text();
    assert.match(html, /utm_campaign=clarice/);
  });

  it("Content-Type text/html, cacheável (mesmo padrão de /jogar)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/embed"), env);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/html/);
    assert.match(res.headers.get("Cache-Control") ?? "", /public/);
  });

  it("endpoints 404 listam /embed", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/rota-inexistente"), env);
    const body = (await res.json()) as { endpoints: string[] };
    assert.ok(body.endpoints.includes("/embed"));
  });
});

// ── applyFrameDenyHeaders + hardening do resto do worker (#3521 achado de self-review) ──

describe("applyFrameDenyHeaders (#3521) — pure", () => {
  it("seta X-Frame-Options: DENY e CSP frame-ancestors 'none'", () => {
    const res = applyFrameDenyHeaders(new Response("ok", { status: 200 }));
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
  });

  it("preserva headers/status/body pré-existentes da resposta", () => {
    const original = new Response("corpo", { status: 201, headers: { "X-Custom": "1" } });
    const res = applyFrameDenyHeaders(original);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("X-Custom"), "1");
  });
});

describe("hardening: toda rota EXCETO /embed recebe framing negado (#3521, gap pré-existente fechado)", () => {
  it("GET /vote (rota mais sensível — escreve a partir de 1 clique) recebe X-Frame-Options: DENY + CSP frame-ancestors 'none'", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/vote?edition=260101&brand=web&email=a@web.eia.diaria.local&choice=A"), env);
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
  });

  it("GET /jogar recebe os mesmos headers de negação", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar"), env);
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
  });

  it("GET /leaderboard recebe os mesmos headers de negação", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/leaderboard"), env);
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
  });

  it("404 fallback também recebe os headers de negação", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/rota-inexistente"), env);
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
  });

  it("/embed é a ÚNICA exceção — nunca recebe X-Frame-Options: DENY", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/embed"), env);
    assert.notEqual(res.headers.get("X-Frame-Options"), "DENY");
  });
});

// ── Regressão: voto/leaderboard/jogar continuam funcionando ────────────────

describe("regressão: /vote, /jogar e /leaderboard continuam funcionando sem alteração de comportamento (#3521)", () => {
  it("voto pelo brand=web (mesmo mecanismo que /jogar/embed reusam) grava normalmente e responde 200", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/vote?edition=260101&brand=web&email=t1@web.eia.diaria.local&choice=A"),
      env,
    );
    assert.equal(res.status, 200);
    assert.ok(await env.POLL._map.get("web:vote:260101:t1@web.eia.diaria.local"));
  });

  it("/jogar continua respondendo 200 normalmente", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar"), env);
    assert.equal(res.status, 200);
  });
});
