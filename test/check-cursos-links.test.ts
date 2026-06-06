/**
 * test/check-cursos-links.test.ts (#1892)
 *
 * Cobre a classificação pura do linkcheck de cursos (ok/redirect/broken) e o
 * helper de host. O fetch real é exercido só no CLI (rede), não no teste.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCourseLink, urlHost, loadCourses } from "../scripts/check-cursos-links.ts";

describe("urlHost (#1892)", () => {
  it("normaliza host (lower, sem www, sem ponto final)", () => {
    assert.equal(urlHost("https://WWW.Coursera.org/learn/x"), "coursera.org");
    assert.equal(urlHost("https://skills.google./paths/2336"), "skills.google");
  });
  it("retorna '' pra URL inválida", () => {
    assert.equal(urlHost("not a url"), "");
  });
});

describe("classifyCourseLink (#1892)", () => {
  const base = { ok: true, status: 200, originalUrl: "https://x.com/a", finalUrl: "https://x.com/a" };
  it("2xx no mesmo host = ok", () => {
    assert.equal(classifyCourseLink(base), "ok");
  });
  it("2xx com mudança só de path (mesmo host) = ok (não é drift)", () => {
    assert.equal(classifyCourseLink({ ...base, finalUrl: "https://x.com/a/" }), "ok");
    assert.equal(classifyCourseLink({ ...base, finalUrl: "https://www.x.com/a-pt" }), "ok");
  });
  it("2xx com mudança de HOST = redirect", () => {
    assert.equal(classifyCourseLink({ ...base, finalUrl: "https://other.com/a" }), "redirect");
  });
  it("4xx/5xx = broken", () => {
    assert.equal(classifyCourseLink({ ...base, ok: false, status: 404 }), "broken");
    assert.equal(classifyCourseLink({ ...base, ok: false, status: 503 }), "broken");
  });
  it("erro de rede/timeout = broken", () => {
    assert.equal(
      classifyCourseLink({ ...base, ok: false, status: 0, error: "timeout" }),
      "broken",
    );
  });
});

describe("loadCourses (#1892)", () => {
  it("lê o seed e cada curso tem id + url http(s)", () => {
    const courses = loadCourses();
    assert.ok(courses.length > 0, "seed não-vazio");
    for (const c of courses) {
      assert.ok(c.id, `curso sem id: ${JSON.stringify(c).slice(0, 80)}`);
      assert.match(c.url, /^https?:\/\//, `url inválida em ${c.id}: ${c.url}`);
    }
  });
});
