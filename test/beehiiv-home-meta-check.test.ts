/**
 * test/beehiiv-home-meta-check.test.ts (#4557, #5099)
 *
 * Regressão pura pra `scripts/lib/beehiiv-home-meta-check.ts` — extração de
 * og:title/og:description/meta description + os 3 eixos de drift da issue
 * #4557 (og:title sem a marca oficial / grafia legada, self-links
 * `http://diar.ia.br`, rótulos residuais em inglês) + o 4º eixo do #5099
 * (link reader-facing pra `*.workers.dev`/`diaria.beehiiv.com`), fingerprint
 * + idempotência do alarme, e o texto do e-mail. Nenhum teste bate em
 * rede/home publicada real — todo HTML é fixture local inline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractHomeMeta,
  evaluateHomeMetaDrift,
  hasHomeMetaDrift,
  countHttpSelfLinks,
  detectEnglishLabels,
  detectLegacyHostLinks,
  computeHomeMetaFingerprint,
  emptyHomeMetaAlarmState,
  advanceHomeMetaAlarmState,
  shouldAlarmHomeMetaDrift,
  buildHomeMetaDriftAlarmEmail,
  type HomeMetaDriftFinding,
} from "../scripts/lib/beehiiv-home-meta-check.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** (e) Fixture limpa nos 3 eixos: og:title com a marca oficial, sem
 * self-link http://, sem rótulo em inglês. */
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
</body>
</html>`;

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

describe("detectEnglishLabels (#4557)", () => {
  it("vazio no HTML limpo", () => {
    assert.deepEqual(detectEnglishLabels(CLEAN_HTML), []);
  });

  it("detecta 'Sign Up', '>Login<' e 'N min read' juntos", () => {
    const found = detectEnglishLabels(ENGLISH_LABELS_HTML);
    assert.deepEqual(found.sort(), ['"Sign Up"', '"N min read"', '">Login<"'].sort());
  });

  it("'N min read' casa qualquer inteiro, case-insensitive", () => {
    assert.deepEqual(detectEnglishLabels("<p>12 Min Read</p>"), ['"N min read"']);
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

  it("(e) fixture limpa nos 4 eixos -> nenhum drift", () => {
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
    // combina os 4 eixos quebrados no mesmo HTML
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
});
