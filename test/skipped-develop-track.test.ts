import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findUnroutedSkips, requiresDevelopRouting } from "../scripts/lib/skipped-develop-track.ts";

const snap = (labels: string[]) => ({ labels, body: "" });

describe("skipped-develop-track (#9463)", () => {
  it("motivo com sufixo após ':' também exige roteamento", () => {
    assert.equal(requiresDevelopRouting({ status: "pulada", motivo: "guard-de-execucao: arquivo sensível" }), true);
    assert.equal(requiresDevelopRouting({ status: "pulada", motivo: "requer-sessao-local" }), true);
    assert.equal(requiresDevelopRouting({ status: "pulada", motivo: "ambigua" }), false);
    assert.equal(requiresDevelopRouting({ status: "mergeada", motivo: "requer-sessao-local" }), false);
  });

  it("flagra pulada por guard sem develop-track (regressão #9379)", () => {
    const issues = [
      { number: 9379, status: "pulada", motivo: "guard-de-execucao: sensível" },
      { number: 9431, status: "pulada", motivo: "requer-sessao-local" },
      { number: 1, status: "pulada", motivo: "ambigua" },
    ];
    const snaps = new Map([
      [9379, snap([])],
      [9431, snap(["develop-track"])],
      [1, snap([])],
    ]);
    assert.deepEqual(findUnroutedSkips(issues, snaps), [9379]);
  });

  it("label windows também conta como Develop; sem snapshot é ignorada", () => {
    const issues = [
      { number: 2, status: "pulada", motivo: "requer-sessao-local" },
      { number: 3, status: "pulada", motivo: "requer-sessao-local" },
    ];
    assert.deepEqual(findUnroutedSkips(issues, new Map([[2, snap(["windows"])]])), []);
  });

  it("#9516: pulada bloqueada/agendada/fechada não é acusada; overnight segue acusada", () => {
    const issues = [4, 5, 6, 7, 8].map((number) => ({ number, status: "pulada", motivo: "guard-de-execucao" }));
    const snaps = new Map([
      [4, snap(["external-blocker"])],
      [5, { labels: [], body: "", state: "closed" }],
      [6, snap(["on-hold"])],
      [7, { labels: [], body: "<!-- aguardando-ate: 2099-01-01 -->" }],
      [8, { labels: [], body: "", state: "open" }],
    ]);
    assert.deepEqual(findUnroutedSkips(issues, snaps), [8]);
  });
});
