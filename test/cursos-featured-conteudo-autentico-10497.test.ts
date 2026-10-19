/**
 * cursos-featured-conteudo-autentico-10497.test.ts (#10497)
 *
 * Trava as decisões do editor da #10497:
 * - a aula Conteúdo Autêntico com IA é um item do seed (`cost: "paid"`,
 *   `featured: true`), sempre o 1º card da grade, no teaser e no full;
 * - fica aberta no teaser FORA da cota de 20% (os curados abertos não mudam);
 * - card sem preço, link com o UTM do registry (`CURSOS_FEATURED_CARD_UTM`);
 * - intro, FAQ e JSON-LD sem a afirmação agregada de gratuidade/certificado
 *   ("acesso gratuito ou auditoria livre" / "certificado sem custo ao concluir"),
 *   tanto no render fresco quanto nos artefatos committed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Course,
  buildCursosFaq,
  featuredCourseUrl,
  loadCourses,
  orderForRender,
  renderCursosPage,
  selectOpenCourses,
  validateCourses,
} from "../scripts/build-cursos-page.ts";
import { CURSOS_FEATURED_CARD_UTM, findUtmEmitter } from "../scripts/lib/shared/utm-registry.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET = resolve(ROOT, "workers/cursos/public/index.html");
const GEN_FULL = resolve(ROOT, "workers/cursos/src/courses-full.generated.ts");

const BANNED = [/acesso gratuito ou auditoria livre/i, /certificado sem custo ao concluir/i];

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

/** ids dos cards na ordem do DOM. */
function cardOrder(html: string): string[] {
  return [...html.matchAll(/<article class="card[^"]*"[\s\S]*?<h2><a href="([^"]+)"/g)].map((m) => m[1]);
}

describe("#10497 — seed real: aula em destaque", () => {
  const courses = loadCourses();
  const aula = courses.find((c) => c.id === "diaria-conteudo-autentico");

  it("existe no seed, paga, featured, sem certificado, link pra página de vendas", () => {
    assert.ok(aula, "diaria-conteudo-autentico deveria existir no seed");
    assert.equal(aula!.featured, true);
    assert.equal(aula!.cost, "paid");
    assert.equal(aula!.certificate, false);
    assert.equal(aula!.platform, "diar.ia.br");
    assert.equal(aula!.url, "https://diar.ia.br/produto/conteudo-autentico");
    assert.ok(!/utm_/.test(aula!.url), "UTM nunca hardcoded no seed — vem do registry no render");
  });

  it("é o único `featured` (o destaque é um card só)", () => {
    assert.deepEqual(
      courses.filter((c) => c.featured).map((c) => c.id),
      ["diaria-conteudo-autentico"],
    );
  });

  for (const mode of ["teaser", "full"] as const) {
    it(`${mode}: é o 1º card, com classe de destaque, UTM do registry e sem preço`, () => {
      const html = renderCursosPage(courses, mode);
      const first = /<article class="card([^"]*)"[\s\S]*?<\/article>/.exec(html);
      assert.ok(first, "deveria haver ao menos 1 card");
      assert.match(first![1], /card--featured/);
      assert.match(first![0], /Conteúdo Autêntico com IA/);
      assert.match(first![0], /Curso em destaque/);
      assert.ok(first![0].includes(`utm_source=${CURSOS_FEATURED_CARD_UTM.source}`));
      assert.ok(first![0].includes(`utm_medium=${CURSOS_FEATURED_CARD_UTM.medium}`));
      assert.ok(first![0].includes(`utm_campaign=${CURSOS_FEATURED_CARD_UTM.campaign}`));
      assert.ok(!/R\$/.test(first![0]), "card não mostra preço (decisão do editor)");
      assert.equal((html.match(/card--featured"/g) ?? []).length, 1, "só 1 card em destaque");
    });

    it(`${mode}: intro/FAQ/JSON-LD sem afirmação agregada de gratuidade/certificado`, () => {
      const html = renderCursosPage(courses, mode);
      for (const re of BANNED) assert.ok(!re.test(html), `${mode} ainda contém ${re}`);
    });
  }

  it("artefatos committed (teaser + full gerado) também não têm a afirmação e trazem a aula em 1º", () => {
    for (const [label, text] of [
      ["asset teaser", readFileSync(ASSET, "utf8")],
      ["full gerado", readFileSync(GEN_FULL, "utf8")],
    ] as const) {
      for (const re of BANNED) assert.ok(!re.test(text), `${label} ainda contém ${re}`);
      assert.ok(text.includes("card--featured"), `${label} deveria ter o card em destaque`);
    }
  });

  it("filtro Custo aparece com a opção Pago, e a intro cita o filtro de custo", () => {
    const html = renderCursosPage(courses, "teaser");
    assert.match(html, /<select id="f-cost">[\s\S]*?<option value="paid">Pago<\/option>/);
    assert.match(html, /<p class="geo-intro">[^<]*Filtre por [^<]*custo/);
  });

  it("banner 'mais N cursos' conta só os gated — a aula aberta não entra na conta", () => {
    const html = renderCursosPage(courses, "teaser");
    const hidden = courses.length - selectOpenCourses(courses).length;
    assert.ok(html.includes(`Mais ${hidden} cursos curados`));
  });
});

describe("#10497 — mecânica do `featured` (fixtures)", () => {
  const curated = Array.from({ length: 10 }, (_, i) =>
    course({ id: `c${i}`, url: `https://example.com/c${i}`, teaser: i < 2 }),
  );
  const featured = course({
    id: "destaque",
    url: "https://diar.ia.br/produto/x",
    cost: "paid",
    certificate: false,
    featured: true,
  });

  it("featured no FIM do seed ainda sai como 1º card nos dois modos", () => {
    const list = [...curated, featured];
    for (const mode of ["teaser", "full"] as const) {
      const order = cardOrder(renderCursosPage(list, mode));
      assert.ok(order[0].startsWith("https://diar.ia.br/produto/x?"), `${mode}: 1º card deveria ser o featured, veio ${order[0]}`);
    }
    assert.equal(orderForRender(list)[0].id, "destaque");
  });

  it("featured fica fora da cota: os mesmos curados abertos com e sem ele", () => {
    const without = selectOpenCourses(curated).map((c) => c.id);
    const withIt = selectOpenCourses([featured, ...curated]).map((c) => c.id);
    assert.deepEqual(withIt, ["destaque", ...without]);
  });

  it("filtro client-side nunca reordena cards (só alterna display) — featured segue 1º com filtro aplicado", () => {
    const html = renderCursosPage([featured, ...curated], "full");
    // Só o script de filtros (o último <script> da página) — o <head> tem o
    // snippet do GTM, que usa insertBefore legitimamente.
    const start = html.indexOf("var THEME_LABELS");
    assert.ok(start > 0, "sanity: script de filtros presente");
    const script = html.slice(start, html.indexOf("</script>", start));
    assert.ok(!/appendChild|insertBefore|replaceChildren|cards\.sort/.test(script), "script não deveria mover cards no DOM");
    assert.match(script, /c\.style\.display = ok \? '' : 'none'/);
  });

  it("featuredCourseUrl usa o triplo do registry e preserva path", () => {
    const u = new URL(featuredCourseUrl("https://diar.ia.br/produto/x"));
    assert.equal(u.pathname, "/produto/x");
    assert.equal(u.searchParams.get("utm_source"), CURSOS_FEATURED_CARD_UTM.source);
    assert.equal(u.searchParams.get("utm_medium"), CURSOS_FEATURED_CARD_UTM.medium);
    assert.equal(u.searchParams.get("utm_campaign"), CURSOS_FEATURED_CARD_UTM.campaign);
    assert.equal(featuredCourseUrl("não é url"), "não é url");
  });

  it("emissor registrado no inventário de UTM com o mesmo triplo", () => {
    const e = findUtmEmitter("cursos-featured-card");
    assert.ok(e);
    assert.equal(e!.source, CURSOS_FEATURED_CARD_UTM.source);
    assert.equal(e!.medium, CURSOS_FEATURED_CARD_UTM.medium);
    assert.equal(e!.campaignPattern, CURSOS_FEATURED_CARD_UTM.campaign);
    assert.equal(e!.originFile, "scripts/build-cursos-page.ts");
  });

  it("validateCourses rejeita featured não-booleano", () => {
    const v = validateCourses([course({ featured: "sim" as never })]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((x) => /featured deve ser boolean/.test(x)));
  });

  it("FAQ (perguntas iguais, respostas sem a contagem de gratuitos/certificado sem custo)", () => {
    const faq = buildCursosFaq([featured, ...curated]);
    assert.equal(faq[0].question, "Quais são os melhores cursos gratuitos de inteligência artificial?");
    assert.equal(faq[3].question, "Tem curso de IA gratuito com certificado?");
    for (const f of faq) for (const re of BANNED) assert.ok(!re.test(f.answer), `resposta "${f.question}" contém ${re}`);
    assert.match(faq[0].answer, /\b11 cursos\b/);
    assert.match(faq[0].answer, /\b3 ficam abertos\b/, "abertos = 1 em destaque + floor(0,2 × 10)");
  });
});
