/**
 * build-cursos-page.test.ts (#1745)
 *
 * Cobre o builder da página "Cursos sobre IA": validação de schema, helpers
 * puros (esc/isSafeUrl/slugify/durationBin/fmtDuration), temas/plataformas
 * dinâmicos e o render (cards com data-* + filtros condicionais ≥2 valores).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
});
