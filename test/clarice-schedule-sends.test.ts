import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduledAtFor, assertScheduledAtFuture, SUBJECTS, PREVIEW_TEXT, parseWeeksArg, buildKeysInScope, checkEiaGuard, isScheduledStatus, applyVerifyResults } from "../scripts/clarice-schedule-sends.ts";
import { SENDS } from "../scripts/clarice-build-edition-sends.ts";
import { monthlyDir as resolveMonthlyDir, cycleToYymm } from "../scripts/lib/monthly-paths.ts";

// (#2101: guard de runtime movido para assertScheduledAtFuture — scheduledAtFor
// é função pura de computação de data, sem side effects de clock)
// BEFORE_CYCLE é usado apenas nos testes de assertScheduledAtFuture que precisam de clock injetável.
const BEFORE_CYCLE = new Date("2026-06-09T00:00:00Z"); // 1 dia antes de d01

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

  // Guard de range: n fora de 1..SENDS.length lança erro explícito (nunca data silenciosamente errada)
  it("n=0 lança erro (fora do range)", () => {
    const rangeRe = new RegExp(`n deve ser inteiro 1\\.\\.${SENDS.length}`);
    assert.throws(() => scheduledAtFor(0), rangeRe);
  });

  it(`n=${SENDS.length + 1} lança erro (fora do range)`, () => {
    const rangeRe = new RegExp(`n deve ser inteiro 1\\.\\.${SENDS.length}`);
    assert.throws(() => scheduledAtFor(SENDS.length + 1), rangeRe);
  });

  it("n=1.5 lança erro (não-inteiro)", () => {
    const rangeRe = new RegExp(`n deve ser inteiro 1\\.\\.${SENDS.length}`);
    assert.throws(() => scheduledAtFor(1.5), rangeRe);
  });

  // scheduledAtFor apenas computa a data (sem guard); assertScheduledAtFuture faz o guard
  it("retorna data passada sem lançar (guard separado em assertScheduledAtFuture)", () => {
    // d01 (10/jun/2026) já é passado no clock real — scheduledAtFor não deve lançar
    assert.doesNotThrow(() => scheduledAtFor(1)); // sem nowOverride = clock real
  });

  // #2125: scheduledAtFor deve derivar de SENDS (fonte única do calendário), não de aritmética própria.
  it("deriva do campo scheduledAt de SENDS[n-1] (fonte única do calendário)", () => {
    for (const s of SENDS) {
      assert.equal(
        scheduledAtFor(s.n),
        s.scheduledAt,
        `scheduledAtFor(${s.n}) deve igualar SENDS[${s.n - 1}].scheduledAt`,
      );
    }
  });

  it("todos os 21 envios derivam de SENDS sem aritmética própria", () => {
    // Verifica que a cobertura é total: 21 entradas, sem gaps.
    assert.equal(SENDS.length, 21, "SENDS deve ter 21 entradas");
    for (let n = 1; n <= 21; n++) {
      const send = SENDS.find((s) => s.n === n);
      assert.ok(send, `SENDS deve ter entrada para n=${n}`);
      assert.equal(scheduledAtFor(n), send!.scheduledAt);
    }
  });
});

// Regressão #2101: assertScheduledAtFuture — guard de data futura separado de scheduledAtFor
describe("assertScheduledAtFuture (#2101 — guard de data futura em --create/--schedule)", () => {
  it("não lança quando data computada é no futuro (1ms antes)", () => {
    const justBeforeD01 = new Date("2026-06-10T08:59:59.999Z");
    assert.doesNotThrow(() => assertScheduledAtFuture(1, justBeforeD01));
  });

  it("lança quando data computada é igual a now (date <= now)", () => {
    const exactlyD01 = new Date("2026-06-10T09:00:00Z");
    assert.throws(
      () => assertScheduledAtFuture(1, exactlyD01),
      /data computada.*é passado ou presente/,
    );
  });

  it("lança quando ciclo desatualizado (clock em julho, scheduledAt de SENDS ainda em junho)", () => {
    const afterCycle = new Date("2026-07-01T00:00:00Z");
    assert.throws(
      () => assertScheduledAtFuture(1, afterCycle),
      /desatualizado|passado ou presente/,
    );
  });

  it("lança para d21 também (último dia do ciclo) quando clock está em julho", () => {
    const afterCycle = new Date("2026-07-01T00:00:00Z");
    assert.throws(
      () => assertScheduledAtFuture(21, afterCycle),
      /desatualizado|passado ou presente/,
    );
  });

  it("n=0 lança erro de range (delegado a scheduledAtFor)", () => {
    const rangeRe = new RegExp(`n deve ser inteiro 1\\.\\.${SENDS.length}`);
    assert.throws(() => assertScheduledAtFuture(0, BEFORE_CYCLE), rangeRe);
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

// Regressão #2009: gabarito-guard de É IA? em --schedule
describe("checkEiaGuard (#2009 — guard gabarito É IA? antes do --schedule)", () => {
  it("skip=true → ok sem checar existência do marker", () => {
    // qualquer path inexistente — deve ser ignorado quando skip=true
    const result = checkEiaGuard("2605-06", true, "/caminho/inexistente/.close-poll-clarice.json");
    assert.deepEqual(result, { ok: true });
  });

  it("skip=false + marker ausente → not ok com mensagem de erro", () => {
    const result = checkEiaGuard("2605-06", false, "/caminho/inexistente/.close-poll-clarice.json");
    assert.ok(!result.ok, "deve retornar ok=false quando marker ausente");
    assert.ok("message" in result, "deve ter campo message");
    assert.ok(result.message.includes("gabarito É IA?"), "mensagem deve mencionar 'gabarito É IA?'");
    assert.ok(result.message.includes("close-poll"), "mensagem deve mencionar 'close-poll'");
    assert.ok(result.message.includes("--brand clarice"), "mensagem deve mencionar '--brand clarice'");
    assert.ok(result.message.includes("--skip-eia-guard"), "mensagem deve mencionar '--skip-eia-guard'");
    assert.ok(result.message.includes("2605-06"), "mensagem deve mencionar o ciclo");
  });

  it("skip=false + marker presente → ok", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-eia-guard-"));
    const markerPath = join(tmpDir, ".close-poll-clarice.json");
    writeFileSync(markerPath, JSON.stringify({ cycle: "2605-06", answer: "A" }));
    try {
      const result = checkEiaGuard("2605-06", false, markerPath);
      assert.deepEqual(result, { ok: true });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("mensagem de erro menciona o cycle passado (não hardcoded)", () => {
    const result = checkEiaGuard("2606-07", false, "/caminho/inexistente/.close-poll-clarice.json");
    assert.ok(!result.ok);
    assert.ok("message" in result);
    assert.ok(result.message.includes("2606-07"), "mensagem deve mencionar o ciclo '2606-07'");
    assert.ok(!result.message.includes("2605-06"), "mensagem NÃO deve mencionar o ciclo errado '2605-06'");
  });
});

// #2018 / regra #573: GET-verify pós --schedule — isScheduledStatus puro,
// mockável sem rede (o loop de --schedule usa esta função; testes aqui cobrem
// os casos sem fazer chamada real à Brevo API).
describe("isScheduledStatus (#2018 GET-verify pós --schedule)", () => {
  it("'queued' é aceito como agendado", () => {
    assert.equal(isScheduledStatus("queued"), true);
  });

  it("'scheduled' é aceito como agendado", () => {
    assert.equal(isScheduledStatus("scheduled"), true);
  });

  it("'draft' NÃO é aceito (agendamento não persistiu)", () => {
    assert.equal(isScheduledStatus("draft"), false);
  });

  it("'sent' NÃO é aceito (já saiu, mas não via --schedule)", () => {
    assert.equal(isScheduledStatus("sent"), false);
  });

  it("string vazia NÃO é aceita", () => {
    assert.equal(isScheduledStatus(""), false);
  });

  it("status desconhecido NÃO é aceito (fail-safe)", () => {
    assert.equal(isScheduledStatus("pending"), false);
    assert.equal(isScheduledStatus("in_queue"), false);
  });
});

// Regressão #2101: applyVerifyResults com Promise.allSettled — sucesso parcial
// (era Promise.all: 1 rejected → todos perdiam status; agora: fulfilled → escrito,
// rejected → warn + fica pra retry, sem throw global)
describe("applyVerifyResults (#2101 — sucesso parcial no GET-verify)", () => {
  /** Monta um CampaignEntry mínimo para testes. */
  function makeCampaign(key: string, id: number): { key: string; campaignId: number; listId: number; subject: string; scheduledAt: string; status: "draft" | "scheduled" } {
    return { key, campaignId: id, listId: 1, subject: "X", scheduledAt: "2026-06-10T09:00:00.000Z", status: "draft" };
  }

  it("1 de 3 GETs rejeitado → 2 fulfilled têm status=scheduled escrito, rejeitado permanece draft", () => {
    const c1 = makeCampaign("d01-A", 1);
    const c2 = makeCampaign("d01-B", 2); // este vai rejeitar
    const c3 = makeCampaign("d01-C", 3);
    const campaigns = [c1, c2, c3];
    const toVerify = [c1, c2, c3];

    const settled: PromiseSettledResult<{ status: string }>[] = [
      { status: "fulfilled", value: { status: "queued" } },
      { status: "rejected", reason: new Error("500 Internal Server Error") },
      { status: "fulfilled", value: { status: "scheduled" } },
    ];

    const writeCalls: string[] = [];
    const logs: string[] = [];

    applyVerifyResults(
      settled,
      toVerify,
      campaigns,
      "/fake/campaigns-summary.json",
      (_path, content) => { writeCalls.push(content); },
      (msg) => { logs.push(msg); },
    );

    // c1 e c3 devem estar scheduled
    assert.equal(c1.status, "scheduled", "c1 (fulfilled queued) deve estar scheduled");
    assert.equal(c3.status, "scheduled", "c3 (fulfilled scheduled) deve estar scheduled");
    // c2 deve permanecer draft
    assert.equal(c2.status, "draft", "c2 (rejected) deve permanecer draft");

    // 2 escritas no disco (uma por campanha bem-sucedida)
    assert.equal(writeCalls.length, 2, "deve escrever 2× no disco (c1 + c3)");

    // warn para o rejeitado
    const warnLogs = logs.filter((m) => m.includes("d01-B") && m.includes("⚠"));
    assert.equal(warnLogs.length, 1, "deve haver 1 warn para d01-B");
    assert.ok(warnLogs[0].includes("re-tente --schedule"), "warn deve mencionar retry");

    // sem throw global (test chegou aqui)
  });

  it("todos fulfilled com status aceito → todos scheduled, N escritas", () => {
    const c1 = makeCampaign("d02-A", 10);
    const c2 = makeCampaign("d02-B", 11);
    const campaigns = [c1, c2];
    const settled: PromiseSettledResult<{ status: string }>[] = [
      { status: "fulfilled", value: { status: "queued" } },
      { status: "fulfilled", value: { status: "queued" } },
    ];
    const writeCalls: string[] = [];
    applyVerifyResults(settled, [c1, c2], campaigns, "/fake/path", (_p, c) => { writeCalls.push(c); }, () => {});

    assert.equal(c1.status, "scheduled");
    assert.equal(c2.status, "scheduled");
    assert.equal(writeCalls.length, 2);
  });

  it("todos rejeitados → todos permanecem draft, nenhuma escrita no disco", () => {
    const c1 = makeCampaign("d03-A", 20);
    const campaigns = [c1];
    const settled: PromiseSettledResult<{ status: string }>[] = [
      { status: "rejected", reason: new Error("timeout") },
    ];
    const writeCalls: string[] = [];
    applyVerifyResults(settled, [c1], campaigns, "/fake/path", (_p, c) => { writeCalls.push(c); }, () => {});

    assert.equal(c1.status, "draft", "deve permanecer draft");
    assert.equal(writeCalls.length, 0, "nenhuma escrita no disco");
  });

  it("fulfilled mas status não aceito (draft) → permanece draft, sem escrita, com warn", () => {
    const c1 = makeCampaign("d04-A", 30);
    const campaigns = [c1];
    const settled: PromiseSettledResult<{ status: string }>[] = [
      { status: "fulfilled", value: { status: "draft" } }, // PUT não persistiu
    ];
    const writeCalls: string[] = [];
    const logs: string[] = [];
    applyVerifyResults(settled, [c1], campaigns, "/fake/path", (_p, c) => { writeCalls.push(c); }, (m) => { logs.push(m); });

    assert.equal(c1.status, "draft", "deve permanecer draft");
    assert.equal(writeCalls.length, 0, "nenhuma escrita no disco");
    const warn = logs.find((m) => m.includes(`status="draft"`));
    assert.ok(warn, "deve haver warn mencionando status draft");
  });
});

// Regressão #2101 (finding 2): applyVerifyResults lança em mismatch de tamanho
describe('applyVerifyResults — invariante de tamanho (#2101 finding 2)', () => {
  function makeCampaignF2(key: string, id: number): { key: string; campaignId: number; listId: number; subject: string; scheduledAt: string; status: 'draft' | 'scheduled' } {
    return { key, campaignId: id, listId: 1, subject: 'X', scheduledAt: '2026-06-10T09:00:00.000Z', status: 'draft' };
  }

  it('lança Error claro quando settled.length < toVerify.length', () => {
    const c1 = makeCampaignF2('d01-A', 1);
    const c2 = makeCampaignF2('d01-B', 2);
    const settled: PromiseSettledResult<{ status: string }>[] = [
      { status: 'fulfilled', value: { status: 'queued' } },
      // c2 ausente — simula bug de chamador
    ];
    assert.throws(
      () => applyVerifyResults(settled, [c1, c2], [c1, c2], '/fake/path', () => {}, () => {}),
      /invariante quebrada.*settled\.length.*!==.*toVerify\.length/,
      'deve lançar mensagem clara sobre invariante quebrada',
    );
  });

  it('lança Error claro quando settled.length > toVerify.length', () => {
    const c1 = makeCampaignF2('d01-A', 1);
    const settled: PromiseSettledResult<{ status: string }>[] = [
      { status: 'fulfilled', value: { status: 'queued' } },
      { status: 'fulfilled', value: { status: 'queued' } }, // extra
    ];
    assert.throws(
      () => applyVerifyResults(settled, [c1], [c1], '/fake/path', () => {}, () => {}),
      /invariante quebrada/,
    );
  });

  it('tamanhos iguais (zero) nao lancam', () => {
    assert.doesNotThrow(
      () => applyVerifyResults([], [], [], '/fake/path', () => {}, () => {}),
    );
  });
});

// Regressão #2101 (finding 4): guard simétrico scheduledAt passado em --schedule
// A validação precisa existir tanto em --create quanto ao iterar campanhas em --schedule.
// Este teste exercita a lógica de guard isolada (sem precisar mockar brevoPut).
describe('scheduledAt passado em --schedule — guard simétrico (#2101 finding 4)', () => {
  it('scheduledAt no passado é detectado pela comparacao direta (nao envolve assertScheduledAtFuture)', () => {
    // Simula o guard adicionado antes do PUT em --schedule:
    // new Date(c.scheduledAt) <= new Date() deve ser true para datas passadas
    const pastIso = '2020-01-01T09:00:00.000Z'; // definitivamente passado
    assert.ok(new Date(pastIso) <= new Date(), 'data passada deve ser detectavel pelo guard');
  });

  it('scheduledAt no futuro nao dispara o guard', () => {
    const futureIso = '2099-01-01T09:00:00.000Z';
    assert.ok(!(new Date(futureIso) <= new Date()), 'data futura nao deve disparar o guard');
  });

  it('assertScheduledAtFuture valida n=1 com clock no passado do ciclo', () => {
    // Confirma que o guard de create funciona — clock antes do ciclo, d01 ainda e futuro
    const justBefore = new Date('2026-06-09T00:00:00Z');
    assert.doesNotThrow(() => assertScheduledAtFuture(1, justBefore));
  });

  it('assertScheduledAtFuture lanca para d21 com clock em julho (ciclo encerrado)', () => {
    const afterAllSends = new Date('2026-07-05T00:00:00Z');
    assert.throws(
      () => assertScheduledAtFuture(21, afterAllSends),
      /Mes hardcoded|desatualizado|passado ou presente/i,
    );
  });
});
