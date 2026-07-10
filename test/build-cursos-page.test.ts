/**
 * build-cursos-page.test.ts (#1745)
 *
 * Cobre o builder da página "Cursos sobre IA": validação de schema, helpers
 * puros (esc/isSafeUrl/slugify/durationBin/fmtDuration), temas/plataformas
 * dinâmicos e o render (cards com data-* + filtros condicionais ≥2 valores).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateCourses,
  loadCourses,
  renderCursosPage,
  esc,
  isSafeUrl,
  slugify,
  durationBin,
  fmtDuration,
  availableThemes,
  distinctThemes,
  distinctPlatforms,
  type Course,
} from "../scripts/build-cursos-page.ts";

function course(over: Partial<Course> = {}): Course {
  return {
    id: "c1",
    title: "Curso Teste",
    platform: "Coursera",
    url: "https://www.coursera.org/learn/x",
    language: "pt-br",
    level: "iniciante",
    format: "video",
    duration_hours: 3,
    cost: "free",
    certificate: true,
    themes: ["Fundamentos"],
    summary: "Resumo.",
    ...over,
  };
}

describe("validateCourses (#1745)", () => {
  it("aceita um curso completo", () => {
    const v = validateCourses([course()]);
    assert.equal(v.ok, true);
    assert.equal(v.errors.length, 0);
  });

  it("erro em campos obrigatórios ausentes (title/url/summary/platform)", () => {
    const v = validateCourses([course({ title: "", url: "", summary: "", platform: "" })]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /title ausente/.test(e)));
    assert.ok(v.errors.some((e) => /url ausente/.test(e)));
    assert.ok(v.errors.some((e) => /summary ausente/.test(e)));
    assert.ok(v.errors.some((e) => /platform ausente/.test(e)));
  });

  it("erro em id duplicado", () => {
    const v = validateCourses([course({ id: "dup" }), course({ id: "dup", title: "Outro" })]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /id duplicado/.test(e)));
  });

  it("erro em enums inválidos (language/level/cost/format)", () => {
    const v = validateCourses([
      course({ language: "fr" as never, level: "deus" as never, cost: "barato" as never, format: "audio" as never }),
    ]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /language inválida/.test(e)));
    assert.ok(v.errors.some((e) => /level inválido/.test(e)));
    assert.ok(v.errors.some((e) => /cost inválido/.test(e)));
    assert.ok(v.errors.some((e) => /format inválido/.test(e)));
  });

  it("certificate não-boolean é erro", () => {
    const v = validateCourses([course({ certificate: "sim" as never })]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /certificate deve ser boolean/.test(e)));
  });

  it("url não-http e duração ≤0 são warning, não erro", () => {
    const v = validateCourses([course({ url: "javascript:alert(1)", duration_hours: 0 })]);
    assert.equal(v.ok, true);
    assert.ok(v.warnings.some((w) => /url com esquema inválido/.test(w)));
    assert.ok(v.warnings.some((w) => /duration_hours/.test(w)));
  });
});

describe("helpers puros (#1745)", () => {
  it("esc escapa metacaracteres HTML", () => {
    assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
  it("isSafeUrl: http(s) sim, resto não", () => {
    assert.equal(isSafeUrl("https://x.com"), true);
    assert.equal(isSafeUrl("javascript:alert(1)"), false);
    assert.equal(isSafeUrl(undefined), false);
  });
  it("slugify normaliza acento + espaço", () => {
    assert.equal(slugify("DeepLearning.AI / Coursera"), "deeplearning-ai-coursera");
    assert.equal(slugify("Visão Computacional"), "visao-computacional");
  });
  it("durationBin: curto <5, médio 5-20, longo >20", () => {
    assert.equal(durationBin(1), "curto");
    assert.equal(durationBin(4.99), "curto");
    assert.equal(durationBin(5), "medio");
    assert.equal(durationBin(20), "medio");
    assert.equal(durationBin(20.1), "longo");
    assert.equal(durationBin(120), "longo");
  });
  it("fmtDuration: horas+min, prefixo ~ quando estimado", () => {
    assert.equal(fmtDuration(1.25), "1h 15m");
    assert.equal(fmtDuration(2), "2h");
    assert.equal(fmtDuration(30, true), "~30h");
  });

  it("fmtDuration: carrega minutos quando o arredondamento bate 60 (#3118 item 5)", () => {
    // Bug: h=5.995 → whole=5, mins=Math.round(0.995*60)=60 → "5h 60m" (60min não
    // é uma duração válida). Fix: carrega pra hora seguinte.
    assert.equal(fmtDuration(5.995), "6h", "5.995h deve virar 6h, não '5h 60m'");
    assert.equal(fmtDuration(1.9999), "2h", "quase 2h arredonda pra 2h, não '1h 60m'");
    assert.equal(fmtDuration(5.995, true), "~6h", "carry preserva o prefixo ~ de estimado");
  });

  it("fmtDuration: duration_hours não-finito (NaN) → string vazia, não 'NaNh' (#3118 item 5, relacionado)", () => {
    assert.equal(fmtDuration(NaN), "");
    assert.equal(fmtDuration(Infinity), "");
    // Runtime real: seed com duration_hours ausente entra como undefined (JSON
    // solto, sem checagem de tipo em runtime) apesar do tipo TS declarar `number`.
    assert.equal(fmtDuration(undefined as unknown as number), "");
  });
});

describe("temas/plataformas (#1745)", () => {
  const sample = [
    course({ id: "a", language: "pt-br", level: "iniciante", themes: ["Fundamentos"], platform: "IBM SkillsBuild" }),
    course({ id: "b", language: "en", level: "avancado", themes: ["Deep Learning"], platform: "Coursera" }),
    course({ id: "c", language: "pt-br", level: "intermediario", themes: ["NLP"], platform: "USP / Coursera" }),
  ];
  it("distinctThemes coleta todos ordenados", () => {
    assert.deepEqual(distinctThemes(sample), ["Deep Learning", "Fundamentos", "NLP"]);
  });
  it("availableThemes filtra por idioma (en → só Deep Learning)", () => {
    assert.deepEqual(availableThemes(sample, "en"), ["Deep Learning"]);
  });
  it("distinctPlatforms ordenado", () => {
    assert.deepEqual(distinctPlatforms(sample), ["Coursera", "IBM SkillsBuild", "USP / Coursera"]);
  });
});

describe("renderCursosPage (#1745)", () => {
  const html = renderCursosPage([
    course({ id: "a", title: "Curso A", language: "pt-br", level: "iniciante", duration_hours: 2, certificate: true, themes: ["Fundamentos"], platform: "IBM SkillsBuild" }),
    course({ id: "b", title: "Curso B", language: "en", level: "avancado", duration_hours: 40, duration_estimated: true, certificate: false, cost: "free", format: "hands-on", themes: ["Deep Learning"], platform: "Coursera" }),
  ]);

  it("cards com data-* pros filtros + título linkado", () => {
    assert.ok(html.includes('data-lang="pt-br"'));
    assert.ok(html.includes('data-duration="curto"')); // 2h
    assert.ok(html.includes('data-duration="longo"')); // 40h
    assert.ok(html.includes('data-cert="sim"'));
    assert.ok(html.includes('data-cert="nao"'));
    assert.ok(html.includes('data-platform="ibm-skillsbuild"'));
    assert.ok(html.includes('href="https://www.coursera.org/learn/x"'));
  });

  it("duração estimada mostra prefixo ~", () => {
    assert.ok(html.includes("~40h"));
  });

  it("renderiza os filtros com ≥2 valores (idioma, nível, formato, duração, plataforma, certificado, tema)", () => {
    for (const id of ["f-lang", "f-level", "f-format", "f-duration", "f-platform", "f-cert", "f-theme"]) {
      assert.ok(html.includes(`id="${id}"`), `filtro ${id} deve aparecer`);
    }
  });

  it("OMITE o filtro de custo quando todos os cursos têm o mesmo custo (≥2 distinct)", () => {
    // Ambos os cursos são cost:free → 1 valor distinto → dropdown inútil, omitido.
    assert.ok(!html.includes('id="f-cost"'), "custo com 1 valor não deve render dropdown");
  });

  it("card não mostra 'NaNh' quando duration_hours é inválida/ausente (#3118 item 5, relacionado)", () => {
    const withBadDuration = renderCursosPage([course({ duration_hours: undefined as unknown as number })]);
    assert.doesNotMatch(withBadDuration, /NaNh/);
  });

  it("badge de certificado grátis só no curso que tem", () => {
    assert.equal((html.match(/Certificado grátis/g) ?? []).length, 1);
  });

  it("review #1891: embute THEME_LABELS completo (slug→label) pra rebuild não perder o label", () => {
    // Bug: rebuildThemes lia o label das <option> atuais (que encolhem) → um
    // narrow-then-widen mostrava o slug cru. Fix: mapa completo embutido.
    assert.match(html, /var THEME_LABELS = \{/);
    // Ambos os temas do recorte (pt-br + en) presentes no mapa, com label acentuado.
    assert.ok(html.includes('"fundamentos":"Fundamentos"'), "tema pt-br no mapa");
    assert.ok(html.includes('"deep-learning":"Deep Learning"'), "tema en no mapa");
  });

  it("badge de idioma SEM teal (#1994 followup — pedido do editor 2026-06-09)", () => {
    // O editor pediu pra remover o teal do badge de idioma: ele volta ao estilo
    // padrão .badge (texto ink + borda bege). A classe `badge--lang` segue
    // emitida no HTML (hook semântico), mas sem override de cor teal.
    assert.doesNotMatch(html, /\.badge--lang\s*\{[^}]*var\(--teal\)/, "badge--lang não pode reintroduzir o override teal");
    assert.match(html, /class="badge badge--lang"/, "a classe badge--lang segue no HTML (hook)");
  });

  it("CTA segue DS: 16px, Geist, sem uppercase nem letter-spacing (#2079)", () => {
    // DS: CTAs são corpo (16px sans bold), não labels uppercase (12px).
    // Referência: newsletter-render-html.ts boxDivulgacao1 CTA — font-size:16px, font-weight:bold, sem uppercase.
    assert.match(html, /\.cta\s*\{[^}]*font-size:\s*16px/, "CTA deve ser 16px");
    assert.doesNotMatch(html, /\.cta\s*\{[^}]*font-size:\s*12px/, "CTA não pode ser 12px");
    assert.doesNotMatch(html, /\.cta\s*\{[^}]*text-transform:\s*uppercase/, "CTA não pode ser uppercase");
    assert.doesNotMatch(html, /\.cta\s*\{[^}]*letter-spacing:\s*0\.12em/, "CTA não pode ter letter-spacing 0.12em");
  });

  it("papéis de fonte do DS: CORPO em Geist sans, TÍTULOS em Georgia serif", () => {
    // DS canônico (#1936): serif (Georgia) SÓ em manchetes/títulos; corpo + UI =
    // sans (Geist). Pedido do editor 2026-06-09: o body herdava Georgia (serif),
    // deixando descrições (.lede/.summary) em serif — corrigido pra sans.
    assert.match(html, /body\s*\{\s*font-family:\s*'Geist'/, "corpo (body) deve ser Geist sans");
    assert.match(html, /\bh1\s*\{\s*font-family:\s*Georgia/, "h1 (título) deve ser Georgia serif");
    assert.match(html, /\.title-row h2\s*\{\s*font-family:\s*Georgia/, "h2 do card (título) deve ser Georgia serif");
    assert.match(html, /\.filters select\s*\{\s*font-family:\s*'Geist'/, "dropdown (UI) deve ser Geist sans");
    // o body NÃO pode voltar a ser serif (regressão do pedido do editor).
    assert.doesNotMatch(html, /body\s*\{\s*font-family:\s*Georgia/, "body não pode ser serif");
  });
});

describe("filtros colapsam em mobile (#3107)", () => {
  const courses = [
    course({ id: "a", title: "Curso A", language: "pt-br", level: "iniciante", duration_hours: 2, certificate: true, themes: ["Fundamentos"], platform: "IBM SkillsBuild" }),
    course({ id: "b", title: "Curso B", language: "en", level: "avancado", duration_hours: 40, duration_estimated: true, certificate: false, cost: "free", format: "hands-on", themes: ["Deep Learning"], platform: "Coursera" }),
  ];
  const html = renderCursosPage(courses);

  it("filtros ficam dentro de um <details> com botão (summary) sticky de 1 linha", () => {
    assert.match(html, /<details class="filters-details" id="filters-details">/);
    assert.match(html, /<summary class="filters-summary">/);
    // .filters (o wrapper sticky) não muda — segue sticky pro botão colapsado herdar o comportamento.
    assert.match(html, /\.filters\s*\{[^}]*position:\s*sticky/);
  });

  it('botão mostra "Filtrar (N cursos)" com a contagem TOTAL no primeiro paint (SSR, sem JS)', () => {
    assert.ok(
      html.includes(`Filtrar (${courses.length} cursos)`),
      "label inicial deve refletir o total de cursos renderizados",
    );
  });

  it("singular correto quando só 1 curso (\"Filtrar (1 curso)\", sem 's')", () => {
    const single = renderCursosPage([course({ id: "solo" })]);
    assert.ok(single.includes("Filtrar (1 curso)"));
    assert.ok(!single.includes("Filtrar (1 cursos)"));
  });

  it("abaixo de 700px o corpo dos filtros fica oculto por padrão e só abre com [open]", () => {
    assert.match(html, /@media \(max-width:\s*700px\)/);
    // dentro da media query mobile: corpo escondido por padrão, mostrado só quando o <details> está aberto.
    const mobileBlockMatch = html.match(/@media \(max-width: 700px\) \{([\s\S]*?)\n  \}/);
    assert.ok(mobileBlockMatch, "deve haver um bloco de media query mobile");
    const mobileBlock = mobileBlockMatch![1];
    assert.match(mobileBlock, /\.filters-body\s*\{[^}]*display:\s*none/, "corpo dos filtros começa oculto no mobile");
    assert.match(
      mobileBlock,
      /\.filters-details\[open\]\s*\.filters-body\s*\{[^}]*display:\s*flex/,
      "abre ao tocar (details[open])",
    );
  });

  it("acima de 700px (desktop) o corpo dos filtros permanece SEMPRE visível — sem regra que o esconda fora da media query mobile", () => {
    // Fora do bloco @media (max-width:700px), .filters-body deve ficar display:flex incondicionalmente —
    // ou seja, o desktop não depende do atributo [open] do <details> (comportamento atual preservado).
    const beforeMobileQuery = html.slice(0, html.indexOf("@media (max-width: 700px)"));
    assert.match(beforeMobileQuery, /\.filters-body\s*\{[^}]*display:\s*flex/, "regra base (desktop) mantém display:flex sem depender de [open]");
  });

  it("summary/botão fica escondido no desktop (display:none fora da media query mobile)", () => {
    const beforeMobileQuery = html.slice(0, html.indexOf("@media (max-width: 700px)"));
    assert.match(beforeMobileQuery, /\.filters-summary\s*\{\s*display:\s*none/, "botão só aparece em mobile");
  });

  it("JS: apply() atualiza o label do botão mobile com a contagem FILTRADA (dinâmica), reusando a mesma variável 'visible' do #count", () => {
    assert.match(html, /var summaryLabelEl = document\.getElementById\('filters-summary-label'\);/);
    assert.match(
      html,
      /if \(summaryLabelEl\) summaryLabelEl\.textContent = 'Filtrar \(' \+ visible \+ \(visible === 1 \? ' curso\)' : ' cursos\)'\);/,
    );
  });

  it("count (#count) some no mobile — a contagem já está no botão \"Filtrar (N cursos)\"", () => {
    const mobileBlockMatch = html.match(/@media \(max-width: 700px\) \{([\s\S]*?)\n  \}/);
    assert.match(mobileBlockMatch![1], /\.filters-body \.count\s*\{[^}]*display:\s*none/);
  });

});

describe("SEO/compartilhamento — meta tags (#3106)", () => {
  const html = renderCursosPage([course()]);

  it("tem meta description não-vazia", () => {
    const m = html.match(/<meta name="description" content="([^"]+)">/);
    assert.ok(m, "deve ter <meta name=\"description\">");
    assert.ok(m![1].length > 20, "description não pode ser curta demais/vazia");
  });

  it("og:title, og:description e og:url presentes", () => {
    assert.match(html, /<meta property="og:title" content="Cursos sobre IA · Diar\.ia">/);
    assert.match(html, /<meta property="og:description" content="[^"]+">/);
    assert.match(html, /<meta property="og:url" content="https:\/\/cursos\.diaria\.workers\.dev\/">/);
    assert.match(html, /<meta property="og:type" content="website">/);
  });

  it("canonical aponta pro domínio certo (cursos.diaria.workers.dev)", () => {
    assert.match(html, /<link rel="canonical" href="https:\/\/cursos\.diaria\.workers\.dev\/">/);
  });

  it("twitter card presente (summary, sem imagem grande)", () => {
    assert.match(html, /<meta name="twitter:card" content="summary">/);
    assert.match(html, /<meta name="twitter:title" content="[^"]+">/);
    assert.match(html, /<meta name="twitter:description" content="[^"]+">/);
  });

  it("favicon presente (SVG data-URI inline — sem asset externo)", () => {
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  });

  it("og:image/twitter:image OMITIDOS de propósito (data-URI não é buscável por crawlers de unfurling)", () => {
    assert.doesNotMatch(html, /property="og:image"/);
    assert.doesNotMatch(html, /name="twitter:image"/);
  });

  it("bloco de SEO vem depois do <title> e antes do <style> (head bem-formado)", () => {
    const titleIdx = html.indexOf("<title>");
    const descIdx = html.indexOf('<meta name="description"');
    const styleIdx = html.indexOf("<style>");
    assert.ok(titleIdx >= 0 && descIdx > titleIdx && styleIdx > descIdx);
  });
});

describe("seed cursos — títulos sem sufixo de idioma/código (#1994 followup)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const seed = JSON.parse(readFileSync(resolve(ROOT, "seed/courses/cursos-ia.json"), "utf8")) as {
    courses: Array<{ id: string; title: string }>;
  };
  const byId = Object.fromEntries(seed.courses.map((c) => [c.id, c.title]));

  it("o título do curso PT-BR não traz mais o sufixo '(PT-BR)' (idioma vai no badge/filtro)", () => {
    assert.equal(byId["deeplearning-introducao-genai-ptbr"], "Introdução à IA generativa");
  });
  it("o título do MIT não traz mais o código '(6.036)'", () => {
    assert.equal(byId["mit-ocw-machine-learning"], "Introduction to Machine Learning");
  });
});

describe("seed cursos — cursos oficiais Anthropic e OpenAI (#2451)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const seed = JSON.parse(readFileSync(resolve(ROOT, "seed/courses/cursos-ia.json"), "utf8")) as {
    courses: Array<{ id: string; title: string; platform: string; url: string; cost: string; certificate: boolean; language: string; level: string }>;
  };
  const byId = Object.fromEntries(seed.courses.map((c) => [c.id, c]));

  it("curso oficial da Anthropic presente no seed", () => {
    const c = byId["anthropic-ai-fluency-framework-foundations"];
    assert.ok(c, "anthropic-ai-fluency-framework-foundations deve existir no seed");
    assert.equal(c.platform, "Anthropic Academy");
    assert.equal(c.cost, "free");
    assert.equal(c.certificate, true);
    assert.equal(c.language, "en");
    assert.ok(c.url.startsWith("https://"), "URL deve ser https");
  });

  it("curso oficial da OpenAI presente no seed", () => {
    const c = byId["openai-academy-ai-foundations"];
    assert.ok(c, "openai-academy-ai-foundations deve existir no seed");
    assert.equal(c.platform, "OpenAI Academy");
    assert.equal(c.cost, "free");
    assert.equal(c.certificate, true);
    assert.equal(c.language, "en");
    assert.ok(c.url.startsWith("https://"), "URL deve ser https");
  });

  it("HTML renderizado inclui Anthropic Academy e OpenAI Academy nas plataformas", () => {
    // Carrega via loadCourses() (tipado + validado) em vez de cast — self-review #2451.
    const html = renderCursosPage(loadCourses());
    assert.ok(html.includes("Anthropic Academy"), "Anthropic Academy deve aparecer no HTML");
    assert.ok(html.includes("OpenAI Academy"), "OpenAI Academy deve aparecer no HTML");
  });
});
