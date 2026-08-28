/**
 * test/home-meta-check.test.ts (#4557, #5099, #5257)
 *
 * Regressão pura pra `scripts/lib/home-meta-check.ts` — extração de
 * og:title/og:description/meta description + os 3 eixos de drift da issue
 * #4557 (og:title sem a marca oficial / grafia legada, self-links
 * `http://diar.ia.br`, rótulos residuais em inglês) + o 4º eixo do #5099
 * (link reader-facing pra `*.workers.dev`/`diaria.beehiiv.com`) + o 6º eixo
 * do #5257 (hub temático publicado sem link `/temas/{slug}` na home),
 * fingerprint + idempotência do alarme, e o texto do e-mail. Nenhum teste
 * bate em rede/home publicada real — todo HTML é fixture local inline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractHomeMeta,
  evaluateHomeMetaDrift,
  evaluatePostPageDrift,
  hasHomeMetaDrift,
  countHttpSelfLinks,
  extractVisibleText,
  detectEnglishLabels,
  detectLegacyHostLinks,
  detectMissingHubLinks,
  detectPortInUrlLinks,
  findLatestPostUrl,
  computeHomeMetaFingerprint,
  emptyHomeMetaAlarmState,
  advanceHomeMetaAlarmState,
  shouldAlarmHomeMetaDrift,
  buildHomeMetaDriftAlarmEmail,
  type HomeMetaDriftFinding,
} from "../scripts/lib/home-meta-check.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Bloco "Temas" reproduzindo o item C do #5097/#5257 (ação de painel do
 * editor, ainda pendente) — construído a partir do `HUB_META` real, então
 * segue completo automaticamente se um hub novo entrar no registry (nenhum
 * slug hardcoded aqui pra não divergir por conta própria). */
const HUB_LINKS_HTML = HUB_META.map(
  (h) => `      <a href="https://arquivo.diar.ia.br/temas/${h.slug}">${h.label}</a>`,
).join("\n");

/** (e) Fixture limpa em todos os eixos: og:title com a marca oficial, sem
 * self-link http://, sem rótulo em inglês, todos os hubs de `HUB_META`
 * linkados no bloco "Temas" (#5257). */
const CLEAN_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
  <title>diar.ia.br — curadoria diária sobre IA</title>
  <meta property="og:title" content="diar.ia.br — curadoria diária sobre IA">
  <meta property="og:description" content="A newsletter diária que resume o que importa em IA.">
  <meta name="description" content="Resumo diário de IA, curado por humano.">
</head>
<body>
  <nav>
    <a href="https://diar.ia.br/arquivo">Arquivo</a>
    <a href="https://diar.ia.br/inscrever">Inscrever-se</a>
    <a href="https://diar.ia.br/entrar">Entrar</a>
  </nav>
  <main>
    <article>
      <h1>Edição de hoje</h1>
      <p>Tempo de leitura: 5 min</p>
    </article>
  </main>
  <footer>
    <nav aria-label="Temas">
${HUB_LINKS_HTML}
    </nav>
  </footer>
</body>
</html>`;

/** Variante de `CLEAN_HTML` SEM o bloco "Temas" — reproduz o estado real de
 * produção hoje (item C do #5097 ainda não implementado pelo editor). Base
 * pros testes do 6º eixo (`hub-link-missing`, #5257) e pras fixtures
 * derivadas que precisam de um HTML sem nenhum hub linkado. */
const NO_HUB_LINKS_HTML = CLEAN_HTML.replace(
  /\s*<footer>[\s\S]*?<\/footer>\n/,
  "\n",
);

/** (b) og:title com a grafia legada "Diar.ia" (drift esperado no eixo og-title-brand). */
const LEGACY_BRAND_HTML = CLEAN_HTML.replace(
  /<title>[^<]*<\/title>/,
  "<title>Diar.ia</title>",
).replace(
  /<meta property="og:title" content="[^"]*">/,
  '<meta property="og:title" content="Diar.ia">',
);

/** (c) self-link inseguro `href="http://diar.ia.br..."` (drift esperado no eixo http-self-link). */
const HTTP_SELF_LINK_HTML = CLEAN_HTML.replace(
  '<a href="https://diar.ia.br/arquivo">Arquivo</a>',
  '<a href="http://diar.ia.br/arquivo">Arquivo</a>',
);

/** (d) rótulos residuais em inglês (drift esperado no eixo english-labels). */
const ENGLISH_LABELS_HTML = CLEAN_HTML.replace(
  '<a href="https://diar.ia.br/inscrever">Inscrever-se</a>\n    <a href="https://diar.ia.br/entrar">Entrar</a>',
  '<a href="https://diar.ia.br/inscrever">Sign Up</a>\n    <a href="https://diar.ia.br/entrar">Login</a>',
).replace("Tempo de leitura: 5 min", "5 min read");

/** (f) link(s) reader-facing pra host legado (drift esperado no eixo
 * legacy-host-link, #5099) — reproduz o vazamento real achado na auditoria:
 * livros/cursos em `.workers.dev` + o arquivo antigo em `diaria.beehiiv.com`. */
const LEGACY_HOST_LINKS_HTML = CLEAN_HTML.replace(
  "</nav>",
  '  <a href="https://livros.diaria.workers.dev/">Livros</a>\n' +
    '  <a href="https://cursos.diaria.workers.dev/">Cursos</a>\n' +
    '  <a href="https://diaria.beehiiv.com/archive">Arquivo</a>\n' +
    "</nav>",
);

/** Fixture com os hosts explicitamente FORA de escopo (#5099) — badge da
 * plataforma + CDN de imagem — não deveriam nunca virar achado. */
const ALLOWED_PLATFORM_HOSTS_HTML = CLEAN_HTML.replace(
  "</nav>",
  '  <a href="https://www.beehiiv.com/?utm_source=diar.ia.br">Powered by beehiiv</a>\n' +
    '  <a href="https://media.beehiiv.com/uploads/x.jpg">imagem</a>\n' +
    "</nav>",
);

/** (g) fixture do payload real do #5137: "Sign Up" existe SÓ como dado de
 * configuração dentro de um `<script>` (payload JSON da navbar do builder
 * Beehiiv) — nunca como texto renderizado. "Assinar" é o texto que o leitor
 * de fato vê (a Beehiiv ignora o `label` do JSON em botão de ação padrão e
 * renderiza traduzido). "4 min read" é achado LEGÍTIMO — texto de verdade. */
const JSON_CONFIG_SIGN_UP_HTML = CLEAN_HTML.replace(
  "</head>",
  '  <script type="application/json">' +
    '{"type":"navbar_item","attrs":{"id":"0ac46cf0","type":"button","color":"#ffffff",' +
    '"label":"Sign Up","action":"sign_up"}}' +
    "</script>\n</head>",
).replace(
  '<a href="https://diar.ia.br/inscrever">Inscrever-se</a>',
  '<a href="https://diar.ia.br/inscrever">Assinar</a>',
).replace("Tempo de leitura: 5 min", '<span class="_11r14xt1">4 min read</span>');

/** (h) caso inverso do #5137 — "Sign Up" como texto RENDERIZADO (nó de texto
 * de verdade, não dado de config) continua tendo que alarmar. */
const RENDERED_SIGN_UP_HTML = CLEAN_HTML.replace(
  '<a href="https://diar.ia.br/inscrever">Inscrever-se</a>',
  '<a href="https://diar.ia.br/inscrever">Sign Up</a>',
);

// ─── extractHomeMeta ────────────────────────────────────────────────────────

describe("extractHomeMeta (#4557)", () => {
  it("extrai og:title, og:description e meta description independentemente", () => {
    const meta = extractHomeMeta(CLEAN_HTML);
    assert.equal(meta.ogTitle, "diar.ia.br — curadoria diária sobre IA");
    assert.equal(meta.ogDescription, "A newsletter diária que resume o que importa em IA.");
    assert.equal(meta.metaDescription, "Resumo diário de IA, curado por humano.");
  });

  it("campos ausentes viram null, nunca lança", () => {
    const meta = extractHomeMeta("<html><head></head><body>sem meta nenhuma</body></html>");
    assert.equal(meta.ogTitle, null);
    assert.equal(meta.ogDescription, null);
    assert.equal(meta.metaDescription, null);
  });

  it("decodifica HTML entities no content", () => {
    const html = `<meta property="og:title" content="diar.ia.br &mdash; Inteligência Artificial &amp; voc&ecirc;">`;
    // &ecirc; não está na lista de entities decodificadas (só as comuns) —
    // sanity: as que ESTÃO na lista decodificam corretamente.
    const meta = extractHomeMeta(html);
    assert.match(meta.ogTitle ?? "", /diar\.ia\.br — Inteligência Artificial &/);
  });

  it("tolera ordem inversa de atributos (content antes de property/name)", () => {
    const html = `<meta content="diar.ia.br home" property="og:title">`;
    const meta = extractHomeMeta(html);
    assert.equal(meta.ogTitle, "diar.ia.br home");
  });
});

// ─── countHttpSelfLinks / detectEnglishLabels ──────────────────────────────

describe("countHttpSelfLinks (#4557)", () => {
  it("0 no HTML limpo", () => {
    assert.equal(countHttpSelfLinks(CLEAN_HTML), 0);
  });

  it("conta 1 ocorrência", () => {
    assert.equal(countHttpSelfLinks(HTTP_SELF_LINK_HTML), 1);
  });

  it("conta múltiplas ocorrências", () => {
    const html = `<a href="http://diar.ia.br/a">a</a> <a href="http://diar.ia.br/b">b</a>`;
    assert.equal(countHttpSelfLinks(html), 2);
  });

  it("não conta self-links https:// (seguros)", () => {
    const html = `<a href="https://diar.ia.br/arquivo">Arquivo</a>`;
    assert.equal(countHttpSelfLinks(html), 0);
  });
});

describe("detectEnglishLabels (#4557, #5137)", () => {
  it("vazio no HTML limpo", () => {
    assert.deepEqual(detectEnglishLabels(CLEAN_HTML), []);
  });

  it("detecta 'Sign Up', 'Login' e 'N min read' juntos", () => {
    const found = detectEnglishLabels(ENGLISH_LABELS_HTML);
    assert.deepEqual(found.sort(), ['"Sign Up"', '"N min read"', '"Login"/"Log in"'].sort());
  });

  it("#6498: eixo virou guard genérico — detecta rótulos de UI em inglês além dos 3 originais do tema Beehiiv", () => {
    assert.deepEqual(detectEnglishLabels("<button>Subscribe</button>"), ['"Subscribe"']);
    assert.deepEqual(detectEnglishLabels("<a>Read more</a>"), ['"Read more"']);
    assert.deepEqual(detectEnglishLabels("<a>Learn more</a>"), ['"Learn more"']);
    assert.deepEqual(detectEnglishLabels("<a>Click here</a>"), ['"Click here"']);
    assert.deepEqual(detectEnglishLabels("<p>Loading...</p>"), ['"Loading..."']);
    assert.deepEqual(detectEnglishLabels("<h1>Page not found</h1>"), ['"Page not found"']);
    assert.deepEqual(detectEnglishLabels("<a>Privacy Policy</a>"), ['"Privacy Policy"']);
    assert.deepEqual(detectEnglishLabels("<a>Terms of Service</a>"), ['"Terms of Service"']);
    assert.deepEqual(detectEnglishLabels("<a>Sign in</a>"), ['"Sign in"']);
    assert.deepEqual(detectEnglishLabels("<a>Log in</a>"), ['"Login"/"Log in"']);
  });

  it("#6672 (fleet review, pr-test-analyzer): 'Login'/'Log in' é case-sensitive — não casa a variante minúscula usada em prosa", () => {
    // "login" minúsculo é empréstimo lexical corrente em PT-BR (prosa), não
    // rótulo de UI — casar aqui geraria falso-positivo real (verificado ao
    // vivo pelo review: workers/site/public/p/50-dos-empregos-mudam-em-3-
    // anos-diz-estudo/index.html tem a frase "Exige login com conta Meta").
    assert.deepEqual(detectEnglishLabels("<p>Exige login com conta Meta.</p>"), []);
    // capitalizado continua casando — é o padrão de rótulo de UI que o eixo existe pra pegar.
    assert.deepEqual(detectEnglishLabels("<a>Login</a>"), ['"Login"/"Log in"']);
  });

  it("#6672 (fleet review, pr-test-analyzer): 'Get Started' REMOVIDO da lista — casava prosa citando UI de outro produto", () => {
    // workers/site/public/p/estudos-revelam-influe-ncia-de-ia-na-poli-tica/index.html
    // tem "Clique em Get Started" citando a UI de outro produto — não é
    // vazamento nosso. Diferente do Login acima, o falso-positivo real já
    // vinha capitalizado (não tinha correção de case que resolvesse), então
    // o padrão foi removido em vez de restrito.
    assert.deepEqual(detectEnglishLabels("<p>Clique em Get Started.</p>"), []);
    assert.deepEqual(detectEnglishLabels("<button>Get Started</button>"), []);
  });

  it("'N min read' casa qualquer inteiro, case-insensitive", () => {
    assert.deepEqual(detectEnglishLabels("<p>12 Min Read</p>"), ['"N min read"']);
  });

  it("#5137: 'Sign Up' só no JSON de config (dentro de <script>) não conta — só o achado legítimo ('4 min read') sobra", () => {
    assert.deepEqual(detectEnglishLabels(JSON_CONFIG_SIGN_UP_HTML), ['"N min read"']);
  });

  it("#5137: 'Sign Up' como texto renderizado (não em <script>/atributo) continua alarmando", () => {
    assert.deepEqual(detectEnglishLabels(RENDERED_SIGN_UP_HTML), ['"Sign Up"']);
  });
});

describe("extractVisibleText (#5137)", () => {
  it("remove <script> e <style> inteiros, inclusive o conteúdo", () => {
    const html = "<html><head><script>var x = 'Sign Up';</script><style>.a{color:red}</style></head><body>oi</body></html>";
    const text = extractVisibleText(html);
    assert.doesNotMatch(text, /Sign Up/);
    assert.doesNotMatch(text, /color:red/);
    assert.match(text, /oi/);
  });

  it("remove tags mas preserva o texto entre elas", () => {
    const text = extractVisibleText("<p>Tempo de <b>leitura</b>: 5 min</p>");
    assert.match(text, /Tempo de\s+leitura\s*: 5 min/);
  });

  it("descarta conteúdo de atributo (a tag inteira vira espaço, inclusive os atributos)", () => {
    const text = extractVisibleText('<a href="https://x" data-config=\'{"label":"Sign Up"}\'>Assinar</a>');
    assert.doesNotMatch(text, /Sign Up/);
    assert.match(text, /Assinar/);
  });
});

describe("detectLegacyHostLinks (#5099)", () => {
  it("vazio no HTML limpo", () => {
    assert.deepEqual(detectLegacyHostLinks(CLEAN_HTML), []);
  });

  it("detecta os 3 hosts legados do vazamento real (livros/cursos .workers.dev + diaria.beehiiv.com)", () => {
    const found = detectLegacyHostLinks(LEGACY_HOST_LINKS_HTML);
    assert.deepEqual(found, ["cursos.diaria.workers.dev", "diaria.beehiiv.com", "livros.diaria.workers.dev"]);
  });

  it("deduplica hosts repetidos", () => {
    const html = `<a href="https://poll.diaria.workers.dev/a">a</a> <a href="https://poll.diaria.workers.dev/b">b</a>`;
    assert.deepEqual(detectLegacyHostLinks(html), ["poll.diaria.workers.dev"]);
  });

  it("NUNCA reporta www.beehiiv.com (badge) nem media.beehiiv.com (CDN) — fora de escopo #5099", () => {
    assert.deepEqual(detectLegacyHostLinks(ALLOWED_PLATFORM_HOSTS_HTML), []);
  });

  it("qualquer subdomínio .workers.dev conta (não hardcoded pro trio conhecido)", () => {
    const html = `<a href="https://algum-worker-novo.diaria.workers.dev/">x</a>`;
    assert.deepEqual(detectLegacyHostLinks(html), ["algum-worker-novo.diaria.workers.dev"]);
  });

  it("host de marca diar.ia.br nunca casa (substring solta não é o suficiente)", () => {
    const html = `<a href="https://arquivo.diar.ia.br/">Arquivo</a>`;
    assert.deepEqual(detectLegacyHostLinks(html), []);
  });
});

describe("detectMissingHubLinks (#5257)", () => {
  it("vazio quando todos os hubs de HUB_META estão linkados (fixture limpa)", () => {
    assert.deepEqual(detectMissingHubLinks(CLEAN_HTML), []);
  });

  it("reprodução do estado real de produção (14/08/2026): nenhum hub linkado -> todos os slugs de HUB_META reportados, na ordem do registry", () => {
    assert.deepEqual(
      detectMissingHubLinks(NO_HUB_LINKS_HTML),
      HUB_META.map((h) => h.slug),
    );
  });

  it("casa link relativo (/temas/{slug}) e absoluto (https://host/temas/{slug}) igualmente", () => {
    const hubs = [{ slug: "anthropic-claude", label: "Anthropic e Claude" }] as const;
    assert.deepEqual(detectMissingHubLinks('<a href="/temas/anthropic-claude">x</a>', hubs), []);
    assert.deepEqual(
      detectMissingHubLinks('<a href="https://arquivo.diar.ia.br/temas/anthropic-claude">x</a>', hubs),
      [],
    );
  });

  it("reporta só os hubs SEM link — parcial, não tudo-ou-nada", () => {
    const hubs = [
      { slug: "anthropic-claude", label: "Anthropic e Claude" },
      { slug: "openai-chatgpt", label: "OpenAI e ChatGPT" },
    ] as const;
    const html = '<a href="/temas/anthropic-claude">Anthropic e Claude</a>';
    assert.deepEqual(detectMissingHubLinks(html, hubs), ["openai-chatgpt"]);
  });

  it("slug que é prefixo de outro não dá falso negativo (delimitador de path exigido)", () => {
    const hubs = [{ slug: "openai", label: "OpenAI" }] as const;
    // "/temas/openai-chatgpt" NÃO deveria satisfazer o hub "openai" sozinho —
    // o link teria que ser exatamente "/temas/openai".
    const html = '<a href="/temas/openai-chatgpt">OpenAI e ChatGPT</a>';
    assert.deepEqual(detectMissingHubLinks(html, hubs), ["openai"]);
  });

  it("nunca lança em HTML vazio/malformado", () => {
    assert.deepEqual(detectMissingHubLinks(""), HUB_META.map((h) => h.slug));
    assert.deepEqual(detectMissingHubLinks("<<<not html"), HUB_META.map((h) => h.slug));
  });
});

describe("detectPortInUrlLinks (#5106)", () => {
  it("vazio no HTML limpo", () => {
    assert.deepEqual(detectPortInUrlLinks(CLEAN_HTML), []);
  });

  it("detecta href com porta explícita (reprodução real: diar.ia.br:3002/archive)", () => {
    const html = `<a href="https://diar.ia.br:3002/archive">View more</a>`;
    assert.deepEqual(detectPortInUrlLinks(html), ["https://diar.ia.br:3002/archive"]);
  });

  it("não conta href sem porta explícita", () => {
    const html = `<a href="https://diar.ia.br/archive">Arquivo</a>`;
    assert.deepEqual(detectPortInUrlLinks(html), []);
  });

  it("deduplica e ordena múltiplos hrefs com porta", () => {
    const html =
      `<a href="https://x.com:8080/b">b</a><a href="https://x.com:8080/b">b de novo</a>` +
      `<a href="https://a.com:3000/a">a</a>`;
    assert.deepEqual(detectPortInUrlLinks(html), ["https://a.com:3000/a", "https://x.com:8080/b"]);
  });
});

describe("findLatestPostUrl (#5106)", () => {
  const baseUrl = "https://diar.ia.br";

  it("retorna null quando não há nenhum link /p/ na home", () => {
    assert.equal(findLatestPostUrl(CLEAN_HTML, baseUrl), null);
  });

  it("extrai o PRIMEIRO link /p/ em ordem de documento (mais recente primeiro na home)", () => {
    const html =
      `<a href="https://diar.ia.br/p/edicao-mais-recente">Edição de hoje</a>` +
      `<a href="https://diar.ia.br/p/edicao-anterior">Edição de ontem</a>`;
    assert.equal(findLatestPostUrl(html, baseUrl), "https://diar.ia.br/p/edicao-mais-recente");
  });

  it("nunca lança em HTML vazio/malformado", () => {
    assert.equal(findLatestPostUrl("", baseUrl), null);
    assert.equal(findLatestPostUrl("<<<not html", baseUrl), null);
  });
});

describe("evaluatePostPageDrift (#5106)", () => {
  it("sem porta na URL -> nenhum achado", () => {
    const html = `<a href="https://diar.ia.br/archive">View more</a>`;
    assert.deepEqual(evaluatePostPageDrift(html), []);
  });

  it("reprodução real (#5106): botão 'View more' com porta -> achado port-in-url", () => {
    const html = `<a href="https://diar.ia.br:3002/archive">View more</a>`;
    const findings = evaluatePostPageDrift(html);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, "port-in-url");
    assert.match(findings[0].message, /diar\.ia\.br:3002\/archive/);
    assert.match(findings[0].message, /#5106/);
  });
});

// ─── evaluateHomeMetaDrift ──────────────────────────────────────────────────

describe("evaluateHomeMetaDrift (#4557)", () => {
  it("(a) fixture com og:title correto -> sem drift reportado no eixo de marca", () => {
    const findings = evaluateHomeMetaDrift(CLEAN_HTML);
    assert.ok(
      !findings.some((f) => f.check === "og-title-brand"),
      `não esperava achado og-title-brand: ${JSON.stringify(findings)}`,
    );
  });

  it("(b) fixture com 'Diar.ia' no título -> drift reportado (og-title-brand)", () => {
    const findings = evaluateHomeMetaDrift(LEGACY_BRAND_HTML);
    const finding = findings.find((f) => f.check === "og-title-brand");
    assert.ok(finding, `esperava achado og-title-brand: ${JSON.stringify(findings)}`);
    assert.match(finding!.message, /Diar\.ia/);
  });

  it("(c) fixture com self-link http://diar.ia.br -> reportado (http-self-link)", () => {
    const findings = evaluateHomeMetaDrift(HTTP_SELF_LINK_HTML);
    const finding = findings.find((f) => f.check === "http-self-link");
    assert.ok(finding, `esperava achado http-self-link: ${JSON.stringify(findings)}`);
    assert.match(finding!.message, /1 ocorrência/);
  });

  it("(d) fixture com 'Sign Up'/'Login'/'N min read' -> reportado (english-labels)", () => {
    const findings = evaluateHomeMetaDrift(ENGLISH_LABELS_HTML);
    const finding = findings.find((f) => f.check === "english-labels");
    assert.ok(finding, `esperava achado english-labels: ${JSON.stringify(findings)}`);
    assert.match(finding!.message, /Sign Up/);
    assert.match(finding!.message, /Login/);
    assert.match(finding!.message, /min read/);
  });

  it("(e) fixture limpa nos 5 eixos -> nenhum drift", () => {
    const findings = evaluateHomeMetaDrift(CLEAN_HTML);
    assert.deepEqual(findings, []);
    assert.equal(hasHomeMetaDrift(findings), false);
  });

  it("(f) fixture com link pra host legado -> reportado (legacy-host-link, #5099)", () => {
    const findings = evaluateHomeMetaDrift(LEGACY_HOST_LINKS_HTML);
    const finding = findings.find((f) => f.check === "legacy-host-link");
    assert.ok(finding, `esperava achado legacy-host-link: ${JSON.stringify(findings)}`);
    assert.match(finding!.message, /livros\.diaria\.workers\.dev/);
    assert.match(finding!.message, /cursos\.diaria\.workers\.dev/);
    assert.match(finding!.message, /diaria\.beehiiv\.com/);
  });

  it("(g) fixture sem o bloco Temas -> reportado (hub-link-missing) com todos os slugs", () => {
    const findings = evaluateHomeMetaDrift(NO_HUB_LINKS_HTML);
    const finding = findings.find((f) => f.check === "hub-link-missing");
    assert.ok(finding, `esperava achado hub-link-missing: ${JSON.stringify(findings)}`);
    for (const h of HUB_META) {
      assert.match(finding!.message, new RegExp(h.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    // #6411 — a instrução mudou junto com o mecanismo: o bloco passou a ser
    // gerado de HUB_META, então o achado pede REGENERAR a home, não editar o
    // link à mão (que era o passo de painel Beehiiv do #5257).
    assert.match(finding!.message, /#6411/);
    assert.match(finding!.message, /gen-home-page/);
  });

  it("hosts de plataforma Beehiiv fora de escopo (badge + CDN) -> sem drift nenhum", () => {
    const findings = evaluateHomeMetaDrift(ALLOWED_PLATFORM_HOSTS_HTML);
    assert.deepEqual(findings, []);
  });

  it("og:title ausente também conta como drift (sem a marca oficial)", () => {
    const html = `<html><head></head><body>${CLEAN_HTML}</body></html>`.replace(
      /<meta property="og:title"[^>]*>/,
      "",
    );
    const findings = evaluateHomeMetaDrift(html);
    const finding = findings.find((f) => f.check === "og-title-brand");
    assert.ok(finding, "og:title ausente deveria disparar og-title-brand");
    assert.match(finding!.message, /ausente/);
  });

  it("acumula múltiplos achados simultâneos (não é exclusivo)", () => {
    // combina os 4 eixos quebrados no mesmo HTML (hub links intactos —
    // hub-link-missing fica de fora deste caso de propósito)
    const brokenAll = LEGACY_BRAND_HTML.replace(
      '<a href="https://diar.ia.br/arquivo">Arquivo</a>',
      '<a href="http://diar.ia.br/arquivo">Arquivo</a>',
    )
      .replace("Tempo de leitura: 5 min", "5 min read")
      .replace("</nav>", '  <a href="https://cursos.diaria.workers.dev/">Cursos</a>\n</nav>');
    const findings = evaluateHomeMetaDrift(brokenAll);
    const checks = findings.map((f) => f.check).sort();
    assert.deepEqual(checks, ["english-labels", "http-self-link", "legacy-host-link", "og-title-brand"]);
  });

  it("acumula hub-link-missing junto com os outros eixos (5 eixos quebrados ao mesmo tempo)", () => {
    const brokenAllPlusHubs = NO_HUB_LINKS_HTML.replace(
      /<title>[^<]*<\/title>/,
      "<title>Diar.ia</title>",
    ).replace(
      /<meta property="og:title" content="[^"]*">/,
      '<meta property="og:title" content="Diar.ia">',
    );
    const findings = evaluateHomeMetaDrift(brokenAllPlusHubs);
    const checks = findings.map((f) => f.check).sort();
    assert.deepEqual(checks, ["hub-link-missing", "og-title-brand"]);
  });
});

// ─── Idempotência do alarme ─────────────────────────────────────────────────

describe("computeHomeMetaFingerprint / shouldAlarmHomeMetaDrift (#4557)", () => {
  const FINDINGS: HomeMetaDriftFinding[] = [
    { check: "og-title-brand", message: 'og:title não usa a marca oficial: "Diar.ia"' },
  ];

  it("fingerprint é determinístico e independente de ordem de entrada", () => {
    const a = computeHomeMetaFingerprint([
      { check: "http-self-link", message: "x" },
      { check: "og-title-brand", message: "y" },
    ]);
    const b = computeHomeMetaFingerprint([
      { check: "og-title-brand", message: "y" },
      { check: "http-self-link", message: "x" },
    ]);
    assert.equal(a, b);
  });

  it("sem drift -> nunca alarma", () => {
    const state = emptyHomeMetaAlarmState();
    assert.equal(shouldAlarmHomeMetaDrift(state, []), false);
  });

  it("drift novo (estado vazio) -> alarma", () => {
    const state = emptyHomeMetaAlarmState();
    assert.equal(shouldAlarmHomeMetaDrift(state, FINDINGS), true);
  });

  it("mesmo drift já alarmado -> não alarma de novo", () => {
    const fp = computeHomeMetaFingerprint(FINDINGS);
    const state = advanceHomeMetaAlarmState(fp, new Date("2026-08-11T00:00:00Z"));
    assert.equal(shouldAlarmHomeMetaDrift(state, FINDINGS), false);
  });

  it("drift resolvido re-arma o cursor (fingerprint null)", () => {
    const fp = computeHomeMetaFingerprint(FINDINGS);
    const resolvedState = advanceHomeMetaAlarmState(null, new Date("2026-08-11T00:00:00Z"));
    assert.equal(resolvedState.lastAlarmedFingerprint, null);
    // o mesmo drift reaparecendo depois de resolvido alarma de novo
    assert.equal(shouldAlarmHomeMetaDrift(resolvedState, FINDINGS), true);
    void fp;
  });

  it("drift mudando de shape (novo eixo quebrado) re-alarma", () => {
    const fp1 = computeHomeMetaFingerprint(FINDINGS);
    const state = advanceHomeMetaAlarmState(fp1, new Date("2026-08-11T00:00:00Z"));
    const findings2: HomeMetaDriftFinding[] = [
      ...FINDINGS,
      { check: "http-self-link", message: "1 ocorrência de href=http://" },
    ];
    assert.equal(shouldAlarmHomeMetaDrift(state, findings2), true);
  });
});

// ─── E-mail de alarme ───────────────────────────────────────────────────────

describe("buildHomeMetaDriftAlarmEmail (#4557)", () => {
  it("assunto reflete a contagem de achados", () => {
    const findings = evaluateHomeMetaDrift(LEGACY_BRAND_HTML);
    const extract = extractHomeMeta(LEGACY_BRAND_HTML);
    const { subject } = buildHomeMetaDriftAlarmEmail(findings, extract, "https://diar.ia.br/");
    assert.match(subject, new RegExp(`${findings.length} achado`));
  });

  it("corpo lista cada achado e a metadata extraída", () => {
    const findings = evaluateHomeMetaDrift(ENGLISH_LABELS_HTML);
    const extract = extractHomeMeta(ENGLISH_LABELS_HTML);
    const { body } = buildHomeMetaDriftAlarmEmail(findings, extract, "https://diar.ia.br/");
    for (const f of findings) {
      assert.ok(body.includes(f.message), `corpo deveria conter: ${f.message}`);
    }
    assert.match(body, /og:title: /);
    assert.match(body, /#4557/);
  });

  // #5104 (fleet review): a moldura introdutória do e-mail não pode enumerar
  // um número fixo de eixos ("3 correções") — quando o alarme dispara
  // especificamente por `legacy-host-link` (4º eixo, #5099), o corpo precisa
  // carregar esse contexto, não só uma lista genérica desatualizada no topo.
  it("quando só legacy-host-link dispara, o corpo menciona esse contexto (não fica preso a '3 correções')", () => {
    const findings = evaluateHomeMetaDrift(LEGACY_HOST_LINKS_HTML);
    assert.deepEqual(
      findings.map((f) => f.check),
      ["legacy-host-link"],
      "fixture deveria disparar SÓ o eixo legacy-host-link",
    );
    const extract = extractHomeMeta(LEGACY_HOST_LINKS_HTML);
    const { body } = buildHomeMetaDriftAlarmEmail(findings, extract, "https://diar.ia.br/");
    assert.match(body, /legacy-host-link/);
    assert.match(body, /#5099/);
    assert.doesNotMatch(
      body,
      /\(3 correç/i,
      "a moldura introdutória não deveria enumerar um número fixo de eixos",
    );
  });

  // #5112: cada achado passa a citar a issue GitHub associada, quando o
  // caller passa `issueRefs`. Sem `issueRefs`, comportamento idêntico a
  // antes (back-compat).
  describe("#5112 — issueRefs (citação de issue por achado)", () => {
    it("sem issueRefs, corpo não muda (back-compat)", () => {
      const findings = evaluateHomeMetaDrift(ENGLISH_LABELS_HTML);
      const extract = extractHomeMeta(ENGLISH_LABELS_HTML);
      const { body } = buildHomeMetaDriftAlarmEmail(findings, extract, "https://diar.ia.br/");
      assert.doesNotMatch(body, /→ #/);
    });

    it("achado criado -> linha cita '#NNNN (criada)' + a URL completa da issue", () => {
      const findings = evaluateHomeMetaDrift(ENGLISH_LABELS_HTML);
      const extract = extractHomeMeta(ENGLISH_LABELS_HTML);
      const finding = findings.find((f) => f.check === "english-labels")!;
      const key = `${finding.check}:${finding.message}`;
      const issueRefs = new Map([
        [key, { issueNumber: 5101, url: "https://github.com/vjpixel/diaria-studio/issues/5101", action: "created" as const }],
      ]);
      const { body } = buildHomeMetaDriftAlarmEmail(findings, extract, "https://diar.ia.br/", issueRefs);
      assert.match(body, /→ #5101 \(criada\)/);
      assert.match(body, /https:\/\/github\.com\/vjpixel\/diaria-studio\/issues\/5101/);
    });

    it("achado reusado -> linha cita '#NNNN (existente)' + a URL", () => {
      const findings = evaluateHomeMetaDrift(LEGACY_HOST_LINKS_HTML);
      const extract = extractHomeMeta(LEGACY_HOST_LINKS_HTML);
      const finding = findings.find((f) => f.check === "legacy-host-link")!;
      const key = `${finding.check}:${finding.message}`;
      const issueRefs = new Map([
        [key, { issueNumber: 5099, url: "https://github.com/vjpixel/diaria-studio/issues/5099", action: "reused" as const }],
      ]);
      const { body } = buildHomeMetaDriftAlarmEmail(findings, extract, "https://diar.ia.br/", issueRefs);
      assert.match(body, /→ #5099 \(existente\)/);
      assert.match(body, /issues\/5099/);
    });

    it("falha na criação -> linha cita 'issue não criada: {motivo}', sem número de issue", () => {
      const findings = evaluateHomeMetaDrift(ENGLISH_LABELS_HTML);
      const extract = extractHomeMeta(ENGLISH_LABELS_HTML);
      const finding = findings.find((f) => f.check === "english-labels")!;
      const key = `${finding.check}:${finding.message}`;
      const issueRefs = new Map([
        [key, { issueNumber: null, url: null, action: "failed" as const, error: "gh não autenticado" }],
      ]);
      const { body } = buildHomeMetaDriftAlarmEmail(findings, extract, "https://diar.ia.br/", issueRefs);
      assert.match(body, /issue não criada: gh não autenticado/);
    });
  });
});
