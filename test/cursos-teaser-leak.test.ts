/**
 * cursos-teaser-leak.test.ts (#4052)
 *
 * REGRESSÃO CRÍTICA: o HTML teaser (público, estático, `workers/cursos/public/index.html`)
 * NUNCA pode conter o summary/url/badges completos de um curso GATED
 * (`teaser !== true`) — esse é o vazamento que anularia todo o gate (o
 * conteúdo "protegido" estaria disponível de graça no asset estático,
 * indexável, sem nenhuma verificação). Cobre a classe de bug do próprio #633
 * (fix sem teste de regressão reaparece semanas depois).
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

import { loadCourses, renderCursosPage } from "../scripts/build-cursos-page.ts";
import { escHtml } from "../scripts/lib/html-escape.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED = resolve(ROOT, "seed/courses/cursos-ia.json");
const ASSET = resolve(ROOT, "workers/cursos/public/index.html");

describe("cursos teaser: nunca vaza conteúdo gated (#4052)", () => {
  const courses = loadCourses(SEED);
  const gated = courses.filter((c) => !c.teaser);
  const teaser = courses.filter((c) => c.teaser);

  it("sanity: seed tem cursos gated E teaser (senão o teste não cobre nada)", () => {
    assert.ok(gated.length > 0, "precisa de ao menos 1 curso gated");
    assert.ok(teaser.length > 0, "precisa de ao menos 1 curso teaser (aberto)");
  });

  for (const target of [
    { label: "render fresco", html: renderCursosPage(courses, "teaser") },
    { label: "asset committed", html: readFileSync(ASSET, "utf8") },
  ]) {
    it(`${target.label}: não contém summary de nenhum curso gated`, () => {
      for (const c of gated) {
        assert.ok(!target.html.includes(c.summary), `${target.label} vazou o summary de ${c.id}`);
      }
    });

    it(`${target.label}: não contém url de nenhum curso gated`, () => {
      for (const c of gated) {
        assert.ok(!target.html.includes(c.url), `${target.label} vazou a url de ${c.id}`);
      }
    });

    it(`${target.label}: título do curso gated aparece, mas sem link para a plataforma`, () => {
      for (const c of gated) {
        assert.ok(target.html.includes(escHtml(c.title)), `${target.label} deveria mostrar o título de ${c.id}`);
      }
    });

    it(`${target.label}: cursos teaser (abertos) continuam completos (summary+url presentes)`, () => {
      for (const c of teaser) {
        assert.ok(target.html.includes(c.summary), `${target.label} deveria conter o summary do teaser ${c.id}`);
        assert.ok(target.html.includes(c.url), `${target.label} deveria conter a url do teaser ${c.id}`);
      }
    });
  }
});
