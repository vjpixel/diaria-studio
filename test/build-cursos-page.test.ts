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
    // Referência: newsletter-render-html.ts midCallout CTA — font-size:16px, font-weight:bold, sem uppercase.
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
    // Reutiliza o seed já lido e renderCursosPage importado no topo do módulo.
    const html = renderCursosPage(seed.courses as unknown as import("../scripts/build-cursos-page.ts").Course[]);
    assert.ok(html.includes("Anthropic Academy"), "Anthropic Academy deve aparecer no HTML");
    assert.ok(html.includes("OpenAI Academy"), "OpenAI Academy deve aparecer no HTML");
  });
});
