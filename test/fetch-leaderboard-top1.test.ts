/**
 * fetch-leaderboard-top1.test.ts (#1753)
 *
 * Regressão pro bug "Vencedores do mês aparece em toda edição". O bloco só deve
 * aparecer nas 3 primeiras edições do mês (#9236; antes só na 1ª) e anunciar o
 * mês ANTERIOR (que acabou de fechar).
 *
 * Cobre as duas funções puras que sustentam a regra:
 *   - previousMonthSlug: período da edição → mês anterior (com virada de ano).
 *   - isFirstEditionOfMonth: detecta se há edição publicada anterior no mesmo mês.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  previousMonthSlug,
  isFirstEditionOfMonth,
  isWithinFirstEditionsOfMonth,
  CHAMPIONS_EDITIONS_PER_MONTH,
} from "../scripts/fetch-leaderboard-top1.ts";

describe("previousMonthSlug (#1753)", () => {
  it("mês comum → mês anterior do mesmo ano", () => {
    assert.equal(previousMonthSlug("2026-06"), "2026-05");
    assert.equal(previousMonthSlug("2026-12"), "2026-11");
  });

  it("janeiro → dezembro do ano anterior", () => {
    assert.equal(previousMonthSlug("2026-01"), "2025-12");
  });

  it("zero-pad preservado", () => {
    assert.equal(previousMonthSlug("2026-10"), "2026-09");
    assert.equal(previousMonthSlug("2026-03"), "2026-02");
  });

  it("input malformado → retorna o próprio slug (fail-open)", () => {
    assert.equal(previousMonthSlug("nope"), "nope");
    assert.equal(previousMonthSlug(""), "");
  });
});

describe("isFirstEditionOfMonth (#1753)", () => {
  it("1ª do mês quando não há edição anterior no mesmo ano-mês", () => {
    // 260601 com histórico só de maio → é a 1ª de junho.
    assert.equal(
      isFirstEditionOfMonth("260601", [
        "2026-05-30T09:00:00.000Z",
        "2026-05-31T09:00:00.000Z",
      ]),
      true,
    );
  });

  it("NÃO é 1ª quando existe edição publicada anterior no mesmo mês", () => {
    // 260603 com 06-01 e 06-02 publicadas → não é a 1ª de junho. (Caso do bug.)
    assert.equal(
      isFirstEditionOfMonth("260603", [
        "2026-06-01T09:00:00.000Z",
        "2026-06-02T09:00:00.000Z",
      ]),
      false,
    );
  });

  it("a própria edição (mesma data) não conta contra si — comparação estrita", () => {
    // Resume/re-run: 260601 já presente no arquivo não deve suprimir o bloco.
    assert.equal(
      isFirstEditionOfMonth("260601", ["2026-06-01T09:00:00.000Z"]),
      true,
    );
  });

  it("edição posterior no mesmo mês não conta (só anteriores suprimem)", () => {
    // 260601 com uma 06-02 no arquivo (cenário improvável, mas a regra é
    // 'existe anterior?') → ainda é 1ª.
    assert.equal(
      isFirstEditionOfMonth("260601", ["2026-06-02T09:00:00.000Z"]),
      true,
    );
  });

  it("edição de outro mês não interfere", () => {
    assert.equal(
      isFirstEditionOfMonth("260601", [
        "2026-04-15T09:00:00.000Z",
        "2026-05-20T09:00:00.000Z",
      ]),
      true,
    );
  });

  it("virada de ano: 1ª de janeiro ignora dezembro do ano anterior", () => {
    assert.equal(
      isFirstEditionOfMonth("260101", ["2025-12-31T09:00:00.000Z"]),
      true,
    );
  });

  it("lista vazia → 1ª do mês (fail-open: mostra o bloco)", () => {
    assert.equal(isFirstEditionOfMonth("260603", []), true);
  });

  it("entradas inválidas são ignoradas com segurança", () => {
    assert.equal(
      isFirstEditionOfMonth("260603", [
        "" as unknown as string,
        "x",
        "2026-06-01T09:00:00.000Z",
      ]),
      false,
    );
  });

  it("edição malformada → true (fail-open, não suprime)", () => {
    assert.equal(
      isFirstEditionOfMonth("invalid", ["2026-06-01T09:00:00.000Z"]),
      true,
    );
  });
});

/**
 * Integração hermética (#1753): roda o script de verdade num cenário fora da
 * janela de edições do mês (#9236: 4ª edição em diante) e verifica que o payload gravado tem period_slug VAZIO.
 *
 * Isto é o que faltou na 1ª versão do fix e o code-review pegou: o renderer só
 * OMITE o bloco quando period_slug é falsy (`if (!lbUrl) return ""`). Se o script
 * gravar um slug não-vazio com zero líderes, o renderer mostra o convite
 * "Acompanhe o ranking de {mês}" — reintroduzindo o bloco em toda edição.
 *
 * Caminho fora da janela faz short-circuit ANTES de qualquer fetch → offline-safe.
 */
describe("isWithinFirstEditionsOfMonth (#9236 — campeões nas 3 primeiras edições)", () => {
  const JUN = (d: string) => `2026-06-${d}T09:00:00.000Z`;

  it("janela é de 3 edições", () => {
    assert.equal(CHAMPIONS_EDITIONS_PER_MONTH, 3);
  });

  it("1ª, 2ª e 3ª edições publicadas do mês → dentro; 4ª → fora", () => {
    assert.equal(isWithinFirstEditionsOfMonth("260601", [], 3), true);
    assert.equal(isWithinFirstEditionsOfMonth("260602", [JUN("01")], 3), true);
    assert.equal(isWithinFirstEditionsOfMonth("260603", [JUN("01"), JUN("02")], 3), true);
    assert.equal(
      isWithinFirstEditionsOfMonth("260604", [JUN("01"), JUN("02"), JUN("03")], 3),
      false,
    );
  });

  it("conta edição PUBLICADA, não dia de calendário: lacuna de fim de semana não consome a janela", () => {
    // Mês começa numa sexta (05) e só volta na segunda (08): a 3ª edição é 09,
    // não 07 — a janela anda por edição publicada.
    assert.equal(isWithinFirstEditionsOfMonth("260609", [JUN("05"), JUN("08")], 3), true);
    assert.equal(
      isWithinFirstEditionsOfMonth("260610", [JUN("05"), JUN("08"), JUN("09")], 3),
      false,
    );
  });

  it("2 posts na mesma data contam como 1 edição (datas distintas)", () => {
    assert.equal(
      isWithinFirstEditionsOfMonth(
        "260603",
        [JUN("01"), "2026-06-01T15:00:00.000Z", JUN("02")],
        3,
      ),
      true,
    );
  });

  it("edições do mês anterior e a própria data não contam", () => {
    assert.equal(
      isWithinFirstEditionsOfMonth(
        "260602",
        ["2026-05-29T09:00:00.000Z", "2026-05-30T09:00:00.000Z", "2026-05-31T09:00:00.000Z", JUN("01"), JUN("02")],
        3,
      ),
      true,
    );
  });

  it("n=1 equivale a isFirstEditionOfMonth", () => {
    for (const [ed, pub] of [
      ["260601", []],
      ["260602", [JUN("01")]],
      ["260603", [JUN("01"), JUN("02")]],
    ] as [string, string[]][]) {
      assert.equal(isWithinFirstEditionsOfMonth(ed, pub, 1), isFirstEditionOfMonth(ed, pub));
    }
  });

  it("edição malformada → true (fail-open)", () => {
    assert.equal(isWithinFirstEditionsOfMonth("invalid", [JUN("01")], 3), true);
  });
});

describe("main() payload fora da janela (#1753 → #9236 integração)", () => {
  it("4ª edição do mês (fora da janela de 3) → grava top1/podium vazios E period_slug vazio", () => {
    const dir = mkdtempSync(join(tmpdir(), "lb1753-"));
    try {
      const pastEditions = join(dir, "past-editions-raw.json");
      const out = join(dir, "out.json");
      // 06-01, 06-02 e 06-03 publicadas → 260604 é a 4ª de junho, fora da janela.
      writeFileSync(
        pastEditions,
        JSON.stringify([
          { published_at: "2026-06-01T09:00:00.000Z" },
          { published_at: "2026-06-02T09:00:00.000Z" },
          { published_at: "2026-06-03T09:00:00.000Z" },
        ]),
      );
      execFileSync(
        process.execPath,
        [
          "--import", "tsx",
          "scripts/fetch-leaderboard-top1.ts",
          "--edition", "260604",
          "--out", out,
          "--past-editions", pastEditions,
        ],
        { stdio: "pipe" },
      );
      const written = JSON.parse(readFileSync(out, "utf8"));
      assert.deepEqual(written.top1, []);
      assert.deepEqual(written.podium, []);
      // O ponto do regression: slug vazio → renderer omite o bloco.
      assert.equal(written.period_slug, "");
      assert.equal(written.period, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
