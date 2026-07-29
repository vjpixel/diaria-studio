/**
 * cursos-teaser-leak.test.ts (#4052)
 *
 * REGRESSÃO CRÍTICA: o HTML teaser (público, estático, `workers/cursos/public/index.html`)
 * NUNCA pode conter NADA de um curso GATED — nem título, nem plataforma, nem
 * summary/url/badges. Esse é o vazamento que anularia todo o gate (o
 * conteúdo "protegido" estaria disponível de graça no asset estático,
 * indexável, sem nenhuma verificação). Cobre a classe de bug do próprio #633
 * (fix sem teste de regressão reaparece semanas depois).
 *
 * O TÍTULO conta como vazamento (decisão do editor em #4052, 260727: "título
 * visível já basta pra pessoa googlar e achar o curso — o título É o produto
 * da curadoria, não o link"). A primeira implementação do gate renderizava um
 * card bloqueado com título+plataforma e este teste TRAVAVA esse
 * comportamento (`assert.ok(html.includes(title))`), contrariando a decisão;
 * as asserções abaixo foram invertidas junto com o fix do render.
 *
 * Verifica tanto contra um render fresco (`renderCursosPage(..., "teaser")`)
 * quanto contra o asset COMMITTED — se alguém regenerar errado ou editar o
 * HTML à mão, este teste pega os dois casos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadCourses,
  openCourseCount,
  renderCursosPage,
  selectOpenCourses,
  TEASER_OPEN_RATIO,
} from "../scripts/build-cursos-page.ts";
import { escHtml } from "../scripts/lib/html-escape.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED = resolve(ROOT, "seed/courses/cursos-ia.json");
const ASSET = resolve(ROOT, "workers/cursos/public/index.html");

describe("cursos teaser: nunca vaza conteúdo gated (#4052)", () => {
  const courses = loadCourses(SEED);
  const open = selectOpenCourses(courses);
  const openIds = new Set(open.map((c) => c.id));
  const gated = courses.filter((c) => !openIds.has(c.id));

  it("sanity: seed tem cursos gated E abertos (senão o teste não cobre nada)", () => {
    assert.ok(gated.length > 0, "precisa de ao menos 1 curso gated");
    assert.ok(open.length > 0, "precisa de ao menos 1 curso aberto");
  });

  it("cota de abertos é 20% do catálogo, calculada dinamicamente (não fixada no seed)", () => {
    assert.equal(open.length, Math.floor(courses.length * TEASER_OPEN_RATIO));
    assert.equal(open.length, openCourseCount(courses.length));
  });

  it("os marcados `teaser: true` no seed ocupam as vagas primeiro", () => {
    const marked = courses.filter((c) => c.teaser);
    for (const c of marked.slice(0, open.length)) {
      assert.ok(openIds.has(c.id), `curso marcado ${c.id} deveria estar entre os abertos`);
    }
  });

  // Um valor que um curso ABERTO também tem não é vazamento — ele está no HTML
  // por direito próprio. Vale pra título ("Introdução à IA generativa" existe
  // em duas plataformas), pra url (os 3 cursos IBM SkillsBuild apontam pro
  // MESMO catálogo) e pra plataforma/tema (compartilhados por construção).
  const openValues = <T>(pick: (c: (typeof courses)[number]) => T | T[]): Set<T> =>
    new Set(open.flatMap((c) => (Array.isArray(pick(c)) ? (pick(c) as T[]) : [pick(c) as T])));

  for (const target of [
    { label: "render fresco", html: renderCursosPage(courses, "teaser") },
    { label: "asset committed", html: readFileSync(ASSET, "utf8") },
  ]) {
    it(`${target.label}: não contém summary de nenhum curso gated`, () => {
      const shared = openValues((c) => c.summary);
      for (const c of gated) {
        if (shared.has(c.summary)) continue;
        assert.ok(!target.html.includes(c.summary), `${target.label} vazou o summary de ${c.id}`);
      }
    });

    it(`${target.label}: não contém url de nenhum curso gated`, () => {
      const shared = openValues((c) => c.url);
      for (const c of gated) {
        if (shared.has(c.url)) continue;
        assert.ok(!target.html.includes(c.url), `${target.label} vazou a url de ${c.id}`);
      }
    });

    it(`${target.label}: não contém o TÍTULO de nenhum curso gated`, () => {
      // Decisão do editor (#4052, 260727): o título é o produto da curadoria —
      // com ele visível a pessoa googla e acha o curso, e o gate vira enfeite.
      const shared = openValues((c) => c.title);
      for (const c of gated) {
        if (shared.has(c.title)) continue;
        assert.ok(!target.html.includes(escHtml(c.title)), `${target.label} vazou o título de ${c.id}`);
      }
    });

    it(`${target.label}: não contém a PLATAFORMA de nenhum curso gated exclusivo dela`, () => {
      const shared = openValues((c) => c.platform);
      for (const c of gated) {
        if (shared.has(c.platform)) continue;
        assert.ok(!target.html.includes(escHtml(c.platform)), `${target.label} vazou a plataforma de ${c.id}`);
      }
    });

    it(`${target.label}: não contém TEMA exclusivo de curso gated (nem no dropdown de filtro)`, () => {
      const shared = openValues((c) => c.themes);
      for (const c of gated) {
        for (const t of c.themes) {
          if (shared.has(t)) continue;
          assert.ok(!target.html.includes(escHtml(t)), `${target.label} vazou o tema "${t}" de ${c.id}`);
        }
      }
    });

    it(`${target.label}: cursos abertos continuam completos (summary+url presentes)`, () => {
      for (const c of open) {
        assert.ok(target.html.includes(c.summary), `${target.label} deveria conter o summary do aberto ${c.id}`);
        assert.ok(target.html.includes(c.url), `${target.label} deveria conter a url do aberto ${c.id}`);
      }
    });

    it(`${target.label}: mostra a chamada agregada "mais N cursos" sem enumerar nada`, () => {
      assert.ok(
        target.html.includes(`Mais ${gated.length} cursos curados`),
        `${target.label} deveria trazer a CTA agregada com a contagem de gated`,
      );
    });
  }
});
