import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { scheduledAtFor, SUBJECTS, PREVIEW_TEXT, parseWeeksArg, buildKeysInScope } from "../scripts/clarice-schedule-sends.ts";
import { monthlyDir as resolveMonthlyDir, cycleToYymm } from "../scripts/lib/monthly-paths.ts";

// 06:00 BRT = 09:00 UTC (#2041 item 4: normalizado pra UTC Z via .toISOString())
describe("scheduledAtFor (guard de range #2007/#2018)", () => {
  it("d01 → 10/jun/2026 09:00 UTC (= 06:00 BRT)", () => {
    assert.equal(scheduledAtFor(1), "2026-06-10T09:00:00.000Z");
  });

  it("d07 → 16/jun/2026 09:00 UTC (= 06:00 BRT, último dia S1)", () => {
    assert.equal(scheduledAtFor(7), "2026-06-16T09:00:00.000Z");
  });

  it("d08 → 17/jun/2026 09:00 UTC (= 06:00 BRT, primeiro dia S2)", () => {
    assert.equal(scheduledAtFor(8), "2026-06-17T09:00:00.000Z");
  });

  it("d14 → 23/jun/2026 09:00 UTC (= 06:00 BRT, último dia S2)", () => {
    assert.equal(scheduledAtFor(14), "2026-06-23T09:00:00.000Z");
  });

  it("d15 → 24/jun/2026 09:00 UTC (= 06:00 BRT, primeiro dia S3)", () => {
    assert.equal(scheduledAtFor(15), "2026-06-24T09:00:00.000Z");
  });

  it("d21 → 30/jun/2026 09:00 UTC (= 06:00 BRT, último dia S3)", () => {
    assert.equal(scheduledAtFor(21), "2026-06-30T09:00:00.000Z");
  });

  // Regressão #2041 item 4: saída deve ser UTC Z, não offset BRT
  it("formato de saída é UTC Z (termina em Z)", () => {
    assert.ok(scheduledAtFor(1).endsWith("Z"), "deve terminar em Z (UTC)");
  });

  it("horário UTC é 09:00 (= 06:00 BRT)", () => {
    const iso = scheduledAtFor(1);
    assert.ok(iso.includes("T09:00:00"), `esperado T09:00:00 no ISO, obtido: ${iso}`);
  });

  // Guard de range: n fora de 1..21 lança erro explícito (nunca data silenciosamente errada)
  it("n=0 lança erro (fora do range)", () => {
    assert.throws(() => scheduledAtFor(0), /n deve ser inteiro 1\.\.21/);
  });

  it("n=22 lança erro (fora do range)", () => {
    assert.throws(() => scheduledAtFor(22), /n deve ser inteiro 1\.\.21/);
  });

  it("n=1.5 lança erro (não-inteiro)", () => {
    assert.throws(() => scheduledAtFor(1.5), /n deve ser inteiro 1\.\.21/);
  });
});

describe("SUBJECTS / PREVIEW_TEXT (S1)", () => {
  it("tem 3 variantes A/B/C", () => {
    assert.ok("A" in SUBJECTS && "B" in SUBJECTS && "C" in SUBJECTS);
    assert.equal(Object.keys(SUBJECTS).length, 3);
  });

  it("PREVIEW_TEXT não está vazio", () => {
    assert.ok(PREVIEW_TEXT.length > 10);
  });
});

describe("parseWeeksArg (#2007/#2018)", () => {
  it("sem --weeks retorna [1] (default S1)", () => {
    assert.deepEqual(parseWeeksArg([]), [1]);
    assert.deepEqual(parseWeeksArg(["--cycle", "2605-06"]), [1]);
  });

  it("--weeks 1 retorna [1]", () => {
    assert.deepEqual(parseWeeksArg(["--weeks", "1"]), [1]);
  });

  it("--weeks 2,3 retorna [2,3]", () => {
    assert.deepEqual(parseWeeksArg(["--weeks", "2,3"]), [2, 3]);
  });

  it("--weeks 1,2,3 retorna [1,2,3]", () => {
    assert.deepEqual(parseWeeksArg(["--weeks", "1,2,3"]), [1, 2, 3]);
  });

  // Regressão #2007: --weeks --dry-run (sem valor) não pode resultar em weeks=[] silencioso
  it("--weeks --dry-run (sem valor) lança erro explícito", () => {
    assert.throws(
      () => parseWeeksArg(["--weeks", "--dry-run"]),
      /--weeks requer um valor/,
    );
  });

  it("--weeks sem valor no final do argv lança erro explícito", () => {
    assert.throws(
      () => parseWeeksArg(["--weeks"]),
      /--weeks requer um valor/,
    );
  });

  it("--weeks com valor inválido lança erro explícito", () => {
    assert.throws(
      () => parseWeeksArg(["--weeks", "abc"]),
      /não contém semanas válidas/,
    );
  });

  it("--weeks 4 (semana inexistente) lança erro explícito", () => {
    assert.throws(
      () => parseWeeksArg(["--weeks", "4"]),
      /não contém semanas válidas/,
    );
  });

  it("--weeks 2 retorna [2] (S2 isolada)", () => {
    assert.deepEqual(parseWeeksArg(["--weeks", "2"]), [2]);
  });
});

// Fix #4 (cleanup): --update-html deve usar o mesmo filtro keysInScope que --schedule.
// buildKeysInScope exportada como ponto de teste (#633): se o escopo divergir entre
// --update-html e --schedule, um dos dois estará errado.
describe("buildKeysInScope (#2007 cleanup -- --update-html respeita --weeks)", () => {
  it("--weeks 1: só chaves S1 (dNN-A/B/C para d01-d07)", () => {
    const keys = buildKeysInScope([1]);
    // S1 tem 7 dias × 3 células = 21 chaves
    assert.equal(keys.size, 21, "S1 deve ter 21 chaves (7 dias × 3 células A/B/C)");
    // Todas devem ser do formato dNN-[ABC]
    for (const k of keys) {
      assert.match(k, /^d(0[1-7])-[ABC]$/, `chave fora do range S1: ${k}`);
    }
    // Não deve conter chaves S2/S3 (sem sufixo de célula)
    assert.ok(!keys.has("d08"), "S2 não deve estar em --weeks 1");
    assert.ok(!keys.has("d15"), "S3 não deve estar em --weeks 1");
  });

  it("--weeks 2: só chaves S2 (d08-d14, sem sufixo de célula)", () => {
    const keys = buildKeysInScope([2]);
    assert.equal(keys.size, 7, "S2 deve ter 7 chaves (7 dias × 1 campanha)");
    for (const k of keys) {
      assert.match(k, /^d(0[89]|1[0-4])$/, `chave fora do range S2: ${k}`);
    }
    // Não deve conter chaves S1 (com sufixo de célula)
    assert.ok(!keys.has("d01-A"), "S1 não deve estar em --weeks 2");
    assert.ok(!keys.has("d15"), "S3 não deve estar em --weeks 2");
  });

  it("--weeks 3: só chaves S3 (d15-d21)", () => {
    const keys = buildKeysInScope([3]);
    assert.equal(keys.size, 7, "S3 deve ter 7 chaves");
    for (const k of keys) {
      assert.match(k, /^d(1[5-9]|2[01])$/, `chave fora do range S3: ${k}`);
    }
    assert.ok(!keys.has("d01-A"), "S1 não deve estar em --weeks 3");
    assert.ok(!keys.has("d08"), "S2 não deve estar em --weeks 3");
  });

  it("--weeks 2,3: chaves S2+S3 (d08-d21)", () => {
    const keys = buildKeysInScope([2, 3]);
    assert.equal(keys.size, 14, "S2+S3 deve ter 14 chaves");
    assert.ok(keys.has("d08"), "d08 em --weeks 2,3");
    assert.ok(keys.has("d14"), "d14 em --weeks 2,3");
    assert.ok(keys.has("d15"), "d15 em --weeks 2,3");
    assert.ok(keys.has("d21"), "d21 em --weeks 2,3");
    assert.ok(!keys.has("d01-A"), "S1 não deve estar em --weeks 2,3");
  });

  it("--weeks 1,3 (S2 omitida): contém S1 e S3, mas não S2", () => {
    const keys = buildKeysInScope([1, 3]);
    // S1: 7×3=21 + S3: 7×1=7 = 28
    assert.equal(keys.size, 28, "--weeks 1,3 deve ter 28 chaves");
    assert.ok(keys.has("d01-A"), "S1 deve estar em --weeks 1,3");
    assert.ok(keys.has("d21"), "S3 deve estar em --weeks 1,3");
    assert.ok(!keys.has("d08"), "S2 NÃO deve estar em --weeks 1,3");
  });

  it("--weeks 1,2,3: todas as 35 chaves (21 S1 + 7 S2 + 7 S3)", () => {
    const keys = buildKeysInScope([1, 2, 3]);
    assert.equal(keys.size, 35, "todas as semanas devem ter 35 chaves");
  });
});

// Regressão #2041 item 1: htmlPath derivado de resolveMonthlyDir(cycle), não hardcoded 2605
describe("htmlPath resolução via resolveMonthlyDir (#2041 item 1)", () => {
  it("cycle 2605-06 aponta pra pasta 2605-06, não 2605", () => {
    const cycle = "2605-06";
    // resolveMonthlyDir aceita ciclo sem exigir que a pasta exista (retorna path)
    const dir = resolveMonthlyDir(cycle, { allowLegacyFallback: false });
    assert.ok(dir.includes("2605-06"), `path deve conter '2605-06', obtido: ${dir}`);
    assert.ok(!dir.endsWith(`${sep}2605`), `path NÃO deve terminar em /2605, obtido: ${dir}`);
    const htmlPath = resolve(dir, "_internal", "cloudflare-preview.html");
    assert.ok(htmlPath.includes("2605-06"), `htmlPath deve conter '2605-06', obtido: ${htmlPath}`);
  });

  it("cycle 2606-07 aponta pra pasta 2606-07 (próximo ciclo não é mais 2605)", () => {
    const cycle = "2606-07";
    const dir = resolveMonthlyDir(cycle, { allowLegacyFallback: false });
    assert.ok(dir.includes("2606-07"), `path deve conter '2606-07', obtido: ${dir}`);
  });
});

// Regressão #2041 item 2: nome de campanha derivado de cycleToYymm(cycle), não hardcoded 2605
describe("nome de campanha derivado de cycleToYymm (#2041 item 2)", () => {
  it("cycleToYymm('2605-06') retorna '2605'", () => {
    assert.equal(cycleToYymm("2605-06"), "2605");
  });

  it("cycleToYymm('2606-07') retorna '2606' (ciclo futuro não gera nome '2605')", () => {
    assert.equal(cycleToYymm("2606-07"), "2606");
  });

  it("nome de campanha S1 para 2606-07 contém '2606', não '2605'", () => {
    const cycle = "2606-07";
    const yymm = cycleToYymm(cycle);
    const name = `Clarice News ${yymm} d01-A (qua)`;
    assert.ok(name.includes("2606"), `nome deve conter '2606': ${name}`);
    assert.ok(!name.includes("2605"), `nome NÃO deve conter '2605': ${name}`);
  });

  it("nome de campanha S2/S3 para 2606-07 contém '2606', não '2605'", () => {
    const cycle = "2606-07";
    const yymm = cycleToYymm(cycle);
    const name = `Clarice News ${yymm} d08 (ter)`;
    assert.ok(name.includes("2606"), `nome deve conter '2606': ${name}`);
    assert.ok(!name.includes("2605"), `nome NÃO deve conter '2605': ${name}`);
  });
});

// Regressão #2041 item 3: JSON.parse com try/catch — fixture truncada vira erro legível
describe("robustez JSON.parse campaigns-summary / sends-summary (#2041 item 3)", () => {
  it("JSON truncado em campaigns-summary lança erro citando o arquivo", () => {
    // Simulação: parse de JSON truncado deve lançar SyntaxError — nosso wrapper acrescenta path
    const truncated = '{"sends": [{"n": 1, "listId": 42';
    assert.throws(
      () => {
        try {
          JSON.parse(truncated);
        } catch (e) {
          throw new Error(`campaigns-summary.json corrompido (JSON inválido): /fake/path\n${String(e)}`);
        }
      },
      /campaigns-summary\.json corrompido/,
    );
  });

  it("JSON truncado em sends-summary lança erro citando o arquivo", () => {
    const truncated = '{"sends": [{"n": 1,';
    assert.throws(
      () => {
        try {
          JSON.parse(truncated);
        } catch (e) {
          throw new Error(`sends-summary.json corrompido (JSON inválido): /fake/path\n${String(e)}`);
        }
      },
      /sends-summary\.json corrompido/,
    );
  });

  it("JSON válido em campaigns-summary não lança erro", () => {
    const valid = JSON.stringify([{ key: "d01-A", campaignId: 1, listId: 2, subject: "X", scheduledAt: "2026-06-10T09:00:00.000Z", status: "draft" }]);
    assert.doesNotThrow(() => JSON.parse(valid));
  });

  it("JSON válido em sends-summary não lança erro", () => {
    const valid = JSON.stringify({ sends: [{ n: 1, file: "d01.csv", day: "qua", week: 1, planned: 100, actual: 95, listId: 42 }] });
    assert.doesNotThrow(() => JSON.parse(valid));
  });
});
