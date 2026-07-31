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
  type Course,
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

  it("os marcados `preferOpen: true` no seed ocupam as vagas primeiro", () => {
    const marked = courses.filter((c) => c.preferOpen);
    for (const c of marked.slice(0, open.length)) {
      assert.ok(openIds.has(c.id), `curso marcado ${c.id} deveria estar entre os abertos`);
    }
  });

  // Adicionados no #4305, mas NÃO são regressão do bug dele: passam igual no
  // código pré-fix (a lógica destas duas funções não mudou). São cobertura
  // nova de comportamento que ninguém tinha olhado — as funções só eram
  // exercitadas contra o seed real, 31 cursos → 6 abertos, longe das pontas.
  describe("openCourseCount / selectOpenCourses nas pontas", () => {
    const fake = (n: number, markedCount = 0): Course[] =>
      Array.from({ length: n }, (_, i) => ({ ...courses[0], id: `fake-${i}`, teaser: i < markedCount }));

    it("catálogo com 4 cursos ou menos abre ZERO — floor(0.2×n) literal", () => {
      // ATENÇÃO: com ≤4 cursos a página pública sai sem nenhum card, só com o
      // banner "Mais N cursos curados". A regra do editor (#4052) é "20%
      // arredondado pra baixo" e é isso que está implementado — nada de piso
      // implícito de 1, porque inventar desvio da decisão registrada foi
      // exatamente o defeito que o #4305 corrigiu. Se a curadoria encolher pra
      // perto disso, é decisão do editor mudar a regra, não do código.
      for (const n of [0, 1, 2, 3, 4]) {
        assert.equal(openCourseCount(n), 0, `n=${n}`);
        assert.equal(selectOpenCourses(fake(n)).length, 0, `n=${n}`);
      }
    });

    it("5 cursos é a primeira vaga aberta", () => {
      assert.equal(openCourseCount(5), 1);
      assert.equal(selectOpenCourses(fake(5)).length, 1);
    });

    it("marcar mais cursos que o teto não abre mais nenhum — o excedente cai", () => {
      const all10Marked = fake(10, 10); // teto = 2
      const result = selectOpenCourses(all10Marked);
      assert.equal(result.length, 2);
      assert.deepEqual(
        result.map((c) => c.id),
        ["fake-0", "fake-1"],
        "corta na ordem do seed, mantendo os primeiros marcados",
      );
    });

    it("marcar menos que o teto não deixa vaga vazia — completa com os não-marcados", () => {
      const ten = fake(10, 1); // teto = 2, só 1 marcado
      const result = selectOpenCourses(ten);
      assert.equal(result.length, 2);
      assert.equal(result[0].id, "fake-0", "o marcado vem primeiro");
    });
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

    // #4305: as asserções por campo acima isentam valor que um curso ABERTO
    // também tem, senão acusam vazamento onde não há. Isso abre um buraco
    // estrutural: se o seed mudar a ponto de um curso gated coincidir em TODO
    // campo com abertos diferentes, um vazamento real do card inteiro passaria
    // com cada campo tendo uma explicação inocente. Esta asserção não depende
    // de coincidência de dados — um card renderizado traz título E url E
    // summary juntos, então os três presentes ao mesmo tempo é vazamento
    // independente de quem mais compartilha cada um.
    it(`${target.label}: nenhum curso gated tem título + url + summary presentes ao mesmo tempo`, () => {
      for (const c of gated) {
        const all3 =
          target.html.includes(escHtml(c.title)) && target.html.includes(c.url) && target.html.includes(c.summary);
        assert.ok(!all3, `${target.label} vazou o card inteiro de ${c.id}`);
      }
    });

    it(`${target.label}: mostra a chamada agregada "mais N cursos" sem enumerar nada`, () => {
      // Plural hardcoded: o render singulariza quando `hiddenCount === 1`, mas
      // hoje são 25 gated. Se a curadoria encolher a ponto de sobrar 1 fechado,
      // é este assert que quebra — e não é bug do render.
      assert.ok(
        target.html.includes(`Mais ${gated.length} cursos curados`),
        `${target.label} deveria trazer a CTA agregada com a contagem de gated`,
      );
    });
  }
});
