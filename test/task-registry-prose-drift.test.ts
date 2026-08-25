import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractProseArmedClaim,
  resolveLineOwnership,
  evaluateProseDrift,
} from "../scripts/lib/task-registry-prose-drift.ts";

const TASKS = ["Diaria-Foo", "Diaria-Bar", "Diaria-Baz"];

describe("task-registry-prose-drift (#6105 item 2)", () => {
  describe("extractProseArmedClaim", () => {
    it("reconhece ARMADA em maiúsculas", () => {
      assert.equal(extractProseArmedClaim("**ARMADA em 17/08/2026** na `helios`"), "armed");
    });
    it("reconhece 'Confirmado ativo'", () => {
      assert.equal(extractProseArmedClaim("Confirmado ativo em `helios` (260812)"), "armed");
    });
    it("reconhece NÃO armada com e sem acento", () => {
      assert.equal(extractProseArmedClaim("DECLARADA — ainda NÃO armada."), "not-armed");
      assert.equal(extractProseArmedClaim("ainda não armada nesta unidade"), "not-armed");
    });
    it("reconhece 'nunca tinha sido armada' (#5399 wording)", () => {
      assert.equal(
        extractProseArmedClaim("existia desde o #5399 mas nunca tinha sido armada"),
        "not-armed",
      );
    });
    it("nota histórica ENTRE ASPAS não conta como afirmação (achado ao vivo #6105)", () => {
      const line =
        "**Task `Diaria-Foo` — ARMADA em `helios`.** ... Esta entrada dizia \"ainda NÃO armada nesta unidade\" até 25/08/2026 — texto corrigido.";
      assert.equal(extractProseArmedClaim(line), "armed");
    });
    it("linha descritiva pura = unknown (nunca alarma)", () => {
      assert.equal(extractProseArmedClaim("roda scripts/foo.ts diariamente às 09:00"), "unknown");
    });
    it("quando ambos aparecem, vence o ÚLTIMO da linha (narativa cronológica)", () => {
      assert.equal(
        extractProseArmedClaim("Antes **NÃO armada**, hoje **ARMADA em 25/08/2026** na helios."),
        "armed",
      );
      assert.equal(
        extractProseArmedClaim("Era **ARMADA em 17/08**, mas desde #5611 está NÃO armada nesta unidade."),
        "not-armed",
      );
    });
  });

  describe("resolveLineOwnership — posse pela PRIMEIRA task mencionada", () => {
    it("dono = primeira task; referência cruzada NÃO recebe a afirmação (bug dos rascunhos 1 e 2)", () => {
      // Estrutura real do registro: entrada própria + citação de vizinhas
      // coladas à afirmação.
      const line =
        "**Task `Diaria-Foo`, diária 09:05 BRT (logo depois de `Diaria-Bar` acima, mesmo guard das tasks-irmãs `Diaria-Foo`/`Diaria-Bar`). **ARMADA em `helios`**.";
      const own = resolveLineOwnership(line, TASKS);
      assert.equal(own.owner, "Diaria-Foo");
      assert.equal(own.claim, "armed");
    });
    it("linha cujo dono é Bar atribui a claim ao Bar, não ao Foo citado", () => {
      const line =
        "**Task `Diaria-Bar`, domingos — enabled: false DE PROPÓSITO, não confundir com ainda NÃO armada por pendência. Depois de `Diaria-Foo` 03:00.**";
      const own = resolveLineOwnership(line, TASKS);
      assert.equal(own.owner, "Diaria-Bar");
      assert.equal(own.claim, "not-armed");
    });
    it("linha sem nenhuma task do registro: owner null", () => {
      assert.deepEqual(resolveLineOwnership("Prsa solta sem task.", TASKS).owner, null);
    });
  });

  describe("evaluateProseDrift", () => {
    it("pega exatamente o drift do achado #6105: prosa diz não-armada, timer ativo", () => {
      const prose = [
        "# Registro",
        "**Task `Diaria-Foo`, diária — ainda NÃO armada nesta unidade.**",
        "Outra entrada: **Task `Diaria-Bar`: **ARMADA em 17/08/2026** na `helios`.",
        "`Diaria-Baz` é citado de passagem por `Diaria-Bar` acima, sem entrada própria com afirmação.",
      ].join("\n");
      const real = new Map<string, import("../scripts/lib/task-registry-prose-drift.ts").RealArmedState>([
        ["Diaria-Foo", "armed"], // ← o drift real
        ["Diaria-Bar", "armed"],
        ["Diaria-Baz", "not-armed"],
      ]);
      const ev = evaluateProseDrift(prose, TASKS, real);
      assert.equal(ev.findings.length, 1);
      assert.equal(ev.findings[0].task, "Diaria-Foo");
      assert.equal(ev.findings[0].claim, "not-armed");
      assert.equal(ev.findings[0].real, "armed");
      assert.equal(ev.checked, 2); // Baz nunca foi dono de linha com afirmação
    });

    it("direção inversa também alarma: prosa diz ARMADA, timer inexistente", () => {
      const prose = "`Diaria-Foo`: **ARMADA em 17/08/2026**.";
      const ev = evaluateProseDrift(prose, ["Diaria-Foo"], new Map([["Diaria-Foo", "not-armed" as const]]));
      assert.equal(ev.findings.length, 1);
      assert.equal(ev.findings[0].claim, "armed");
      assert.equal(ev.findings[0].real, "not-armed");
    });

    it("estado real unknown vai pra unverifiable, nunca pra findings", () => {
      const prose = "`Diaria-Foo`: **ARMADA**.";
      const ev = evaluateProseDrift(prose, ["Diaria-Foo"], new Map([["Diaria-Foo", "unknown" as const]]));
      assert.equal(ev.findings.length, 0);
      assert.deepEqual(ev.unverifiable, ["Diaria-Foo"]);
    });

    it("última afirmação da prosa vence (atualizações cronológicas)", () => {
      const prose = [
        "`Diaria-Foo`: **ARMADA em 10/08**.",
        "Atualização: `Diaria-Foo` desarmada — ainda NÃO armada.",
      ].join("\n");
      const ev = evaluateProseDrift(prose, ["Diaria-Foo"], new Map([["Diaria-Foo", "armed" as const]]));
      assert.equal(ev.findings.length, 1);
      assert.equal(ev.findings[0].claim, "not-armed");
    });
  });
});
