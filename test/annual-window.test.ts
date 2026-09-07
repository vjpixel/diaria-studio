/**
 * test/annual-window.test.ts (#7569)
 *
 * A janela da anual é a peça que mais convida a hardcodar "12 meses" — e a
 * 1ª rodada real tem 13. Estes testes travam as duas janelas default, os
 * overrides e a exceção da 1ª rodada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAnnualWindow,
  defaultWindowFor,
  defaultTipoFor,
  monthsBetween,
  yymmToIndex,
  indexToYymm,
  yymmLabel,
} from "../scripts/lib/anual/annual-window.ts";

describe("aritmética de meses", () => {
  it("YYMM ↔ índice é ida e volta", () => {
    for (const yymm of ["2508", "2601", "2612", "2707"]) {
      assert.equal(indexToYymm(yymmToIndex(yymm)), yymm);
    }
  });

  it("monthsBetween atravessa a virada de ano", () => {
    assert.deepEqual(monthsBetween("2511", "2602"), ["2511", "2512", "2601", "2602"]);
  });

  it("monthsBetween é inclusivo nos dois extremos", () => {
    assert.deepEqual(monthsBetween("2608", "2608"), ["2608"]);
  });

  it("janela invertida falha alto, não devolve lista vazia", () => {
    assert.throws(() => monthsBetween("2608", "2601"), /janela invertida/);
  });

  it("mês fora de 01-12 é rejeitado", () => {
    assert.throws(() => yymmToIndex("2613"), /entre 01 e 12/);
    assert.throws(() => yymmToIndex("260"), /esperado YYMM/);
  });

  it("rótulo humano usa o mês por extenso", () => {
    assert.equal(yymmLabel("2508"), "agosto/2025");
    assert.equal(yymmLabel("2603"), "março/2026");
  });
});

describe("janelas default por tipo", () => {
  it("aniversário cobre ago-jul (fecha no aniversário da diar.ia.br)", () => {
    assert.deepEqual(defaultWindowFor("aniversario", 2027), { desde: "2608", ate: "2707" });
  });

  it("janeiro cobre o ano civil que acabou", () => {
    assert.deepEqual(defaultWindowFor("janeiro", 2027), { desde: "2601", ate: "2612" });
  });

  it("as duas janelas do mesmo ano se sobrepõem em ago-dez (intencional)", () => {
    const aniv = monthsBetween(...(Object.values(defaultWindowFor("aniversario", 2027)) as [string, string]));
    const jan = monthsBetween(...(Object.values(defaultWindowFor("janeiro", 2027)) as [string, string]));
    const overlap = aniv.filter((m) => jan.includes(m));
    assert.deepEqual(overlap, ["2608", "2609", "2610", "2611", "2612"]);
  });
});

describe("tipo default a partir do mês corrente", () => {
  it("agosto e janeiro são os meses de rodada — sem aviso", () => {
    assert.deepEqual(defaultTipoFor(8), { tipo: "aniversario", assumed: false });
    assert.deepEqual(defaultTipoFor(1), { tipo: "janeiro", assumed: false });
  });

  it("fora deles, assume a rodada mais recente e sinaliza", () => {
    // setembro: a última rodada foi a de agosto.
    assert.deepEqual(defaultTipoFor(9), { tipo: "aniversario", assumed: true });
    // maio: a última foi a de janeiro.
    assert.deepEqual(defaultTipoFor(5), { tipo: "janeiro", assumed: true });
  });
});

describe("resolveAnnualWindow", () => {
  it("1ª rodada real: 13 meses, marcada como exceção", () => {
    const w = resolveAnnualWindow({ tipo: "aniversario", desde: "2508", ate: "2608" });
    assert.equal(w.months.length, 13, "ago/2025 a ago/2026 são 13 meses, não 12");
    assert.equal(w.months[0], "2508");
    assert.equal(w.months.at(-1), "2608");
    assert.equal(w.isException, true);
    assert.equal(w.year, 2026);
    assert.equal(w.label, "agosto/2025 a agosto/2026");
    assert.ok(
      w.warnings.some((x) => x.includes("13 meses")),
      "o banner precisa dizer o tamanho real da janela",
    );
  });

  it("rodada de aniversário no default não é exceção", () => {
    const w = resolveAnnualWindow({ tipo: "aniversario", today: new Date("2027-08-10T12:00:00Z") });
    assert.deepEqual([w.desde, w.ate], ["2608", "2707"]);
    assert.equal(w.months.length, 12);
    assert.equal(w.isException, false);
    assert.deepEqual(w.warnings, []);
  });

  it("rodada de janeiro no default cobre o ano civil anterior", () => {
    const w = resolveAnnualWindow({ tipo: "janeiro", today: new Date("2027-01-05T12:00:00Z") });
    assert.deepEqual([w.desde, w.ate], ["2601", "2612"]);
    assert.equal(w.year, 2026, "o diretório é o do ano que a retrospectiva fecha, não o do envio");
    assert.equal(w.isException, false);
  });

  it("--ate sozinho mantém o desde do default", () => {
    const w = resolveAnnualWindow({ tipo: "aniversario", ate: "2608" });
    assert.equal(w.desde, "2508");
    assert.equal(w.isException, true, "ate fora do default já torna a janela excepcional");
  });

  it("mês sem rodada assume tipo e avisa, sem parar", () => {
    const w = resolveAnnualWindow({ today: new Date("2026-09-07T12:00:00Z") });
    assert.equal(w.tipo, "aniversario");
    assert.ok(w.warnings.some((x) => x.includes("Tipo não informado")));
  });

  it("--tipo inválido falha alto", () => {
    assert.throws(() => resolveAnnualWindow({ tipo: "anual" }), /--tipo inválido/);
  });

  it("o ano do diretório vem do fim da janela, não do envio", () => {
    // Mesma edição resolvida em setembro/2026 e em janeiro/2027 tem que cair
    // no MESMO diretório — senão um resume abriria uma edição nova.
    const a = resolveAnnualWindow({ tipo: "aniversario", desde: "2508", ate: "2608", today: new Date("2026-09-07") });
    const b = resolveAnnualWindow({ tipo: "aniversario", desde: "2508", ate: "2608", today: new Date("2027-01-20") });
    assert.equal(a.year, b.year);
  });
});
