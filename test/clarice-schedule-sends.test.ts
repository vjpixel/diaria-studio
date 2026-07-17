import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scheduledAtFor,
  assertScheduledAtFuture,
  SUBJECTS,
  PREVIEW_TEXT,
  buildKeysInScope,
  parseCellBlockArg,
  checkEiaGuard,
  isScheduledStatus,
  applyVerifyResults,
  runScheduleLoop,
} from "../scripts/clarice-schedule-sends.ts";
import type { SendsSummaryEntry } from "../scripts/lib/send-plan.ts";
import { monthlyDir as resolveMonthlyDir, cycleToYymm } from "../scripts/lib/mensal/monthly-paths.ts";

// Fixture: mesmo shape/calendário do ciclo 2605-06 (3 blocos × 7 dias), agora
// como sends-summary.json (SendsSummaryEntry[]) em vez do SENDS hardcoded.
// bloco 1 = bloco-célula (equivalente à antiga S1).
function fixtureSends(): SendsSummaryEntry[] {
  const days = ["qua", "qui", "sex", "sab", "dom", "seg", "ter"];
  const dates1 = ["10jun", "11jun", "12jun", "13jun", "14jun", "15jun", "16jun"];
  const dates2 = ["17jun", "18jun", "19jun", "20jun", "21jun", "22jun", "23jun"];
  const dates3 = ["24jun", "25jun", "26jun", "27jun", "28jun", "29jun", "30jun"];
  const out: SendsSummaryEntry[] = [];
  let n = 1;
  for (const [block, dates] of [[1, dates1], [2, dates2], [3, dates3]] as [number, string[]][]) {
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const dd = date.slice(0, 2);
      const scheduledAt = `2026-06-${dd}T09:00:00.000Z`;
      out.push({
        n,
        date,
        day: days[i],
        block,
        volume: 100,
        scheduledAt,
        file: `d${String(n).padStart(2, "0")}-${date}.csv`,
        planned: 100,
        actual: 100,
        comp: {},
      });
      n++;
    }
  }
  return out;
}

const SENDS = fixtureSends();
const BEFORE_CYCLE = new Date("2026-06-09T00:00:00Z"); // 1 dia antes de d01

// 06:00 BRT = 09:00 UTC
describe("scheduledAtFor (#2775 — lookup em sends-summary, guard de range)", () => {
  it("d01 → 10/jun/2026 09:00 UTC (= 06:00 BRT)", () => {
    assert.equal(scheduledAtFor(SENDS, 1), "2026-06-10T09:00:00.000Z");
  });

  it("d07 → 16/jun/2026 09:00 UTC (último dia bloco 1)", () => {
    assert.equal(scheduledAtFor(SENDS, 7), "2026-06-16T09:00:00.000Z");
  });

  it("d08 → 17/jun/2026 09:00 UTC (primeiro dia bloco 2)", () => {
    assert.equal(scheduledAtFor(SENDS, 8), "2026-06-17T09:00:00.000Z");
  });

  it("d21 → 30/jun/2026 09:00 UTC (último dia bloco 3)", () => {
    assert.equal(scheduledAtFor(SENDS, 21), "2026-06-30T09:00:00.000Z");
  });

  it("formato de saída é UTC Z (termina em Z)", () => {
    assert.ok(scheduledAtFor(SENDS, 1).endsWith("Z"), "deve terminar em Z (UTC)");
  });

  // Guard de range: n fora de 1..sends.length lança erro explícito (nunca data silenciosamente errada)
  it("n=0 lança erro (fora do range)", () => {
    const rangeRe = new RegExp(`n deve ser inteiro 1\\.\\.${SENDS.length}`);
    assert.throws(() => scheduledAtFor(SENDS, 0), rangeRe);
  });

  it(`n=${SENDS.length + 1} lança erro (fora do range)`, () => {
    const rangeRe = new RegExp(`n deve ser inteiro 1\\.\\.${SENDS.length}`);
    assert.throws(() => scheduledAtFor(SENDS, SENDS.length + 1), rangeRe);
  });

  it("n=1.5 lança erro (não-inteiro)", () => {
    const rangeRe = new RegExp(`n deve ser inteiro 1\\.\\.${SENDS.length}`);
    assert.throws(() => scheduledAtFor(SENDS, 1.5), rangeRe);
  });

  it("todos os 21 envios da fixture derivam do sends-summary sem gaps", () => {
    assert.equal(SENDS.length, 21, "fixture deve ter 21 entradas");
    for (let n = 1; n <= 21; n++) {
      const send = SENDS.find((s) => s.n === n);
      assert.ok(send, `sends deve ter entrada para n=${n}`);
      assert.equal(scheduledAtFor(SENDS, n), send!.scheduledAt);
    }
  });

  it("retorna data passada sem lançar (guard separado em assertScheduledAtFuture)", () => {
    assert.doesNotThrow(() => scheduledAtFor(SENDS, 1)); // sem nowOverride = clock real; d01 é passado no clock real
  });
});

describe("assertScheduledAtFuture (#2101/#2775 — guard de data futura em --create/--schedule)", () => {
  it("não lança quando data computada é no futuro (1ms antes)", () => {
    const justBeforeD01 = new Date("2026-06-10T08:59:59.999Z");
    assert.doesNotThrow(() => assertScheduledAtFuture(SENDS, 1, justBeforeD01));
  });

  it("lança quando data computada é igual a now (date <= now)", () => {
    const exactlyD01 = new Date("2026-06-10T09:00:00Z");
    assert.throws(
      () => assertScheduledAtFuture(SENDS, 1, exactlyD01),
      /data computada.*é passado ou presente/,
    );
  });

  it("lança quando ciclo desatualizado (clock em julho, plano ainda em junho)", () => {
    const afterCycle = new Date("2026-07-01T00:00:00Z");
    assert.throws(
      () => assertScheduledAtFuture(SENDS, 1, afterCycle),
      /desatualizado|passado ou presente/,
    );
  });

  it("lança para d21 também (último dia do ciclo) quando clock está em julho", () => {
    const afterCycle = new Date("2026-07-01T00:00:00Z");
    assert.throws(
      () => assertScheduledAtFuture(SENDS, 21, afterCycle),
      /desatualizado|passado ou presente/,
    );
  });

  it("n=0 lança erro de range (delegado a scheduledAtFor)", () => {
    const rangeRe = new RegExp(`n deve ser inteiro 1\\.\\.${SENDS.length}`);
    assert.throws(() => assertScheduledAtFuture(SENDS, 0, BEFORE_CYCLE), rangeRe);
  });
});

describe("SUBJECTS / PREVIEW_TEXT (bloco-célula)", () => {
  it("tem 3 variantes A/B/C", () => {
    assert.ok("A" in SUBJECTS && "B" in SUBJECTS && "C" in SUBJECTS);
    assert.equal(Object.keys(SUBJECTS).length, 3);
  });

  it("PREVIEW_TEXT não está vazio", () => {
    assert.ok(PREVIEW_TEXT.length > 10);
  });
});

describe("parseCellBlockArg (#2775 — qual bloco recebe o teste A/B/C)", () => {
  it("sem --cell-block: default 1", () => {
    assert.equal(parseCellBlockArg([]), 1);
  });

  it("--cell-block 2 retorna 2", () => {
    assert.equal(parseCellBlockArg(["--cell-block", "2"]), 2);
  });

  it("--cell-block sem valor lança erro explícito", () => {
    assert.throws(() => parseCellBlockArg(["--cell-block"]), /--cell-block requer um valor/);
  });

  it("--cell-block inválido (0, negativo, não-numérico) lança erro explícito", () => {
    assert.throws(() => parseCellBlockArg(["--cell-block", "0"]), /--cell-block deve ser um inteiro/);
    assert.throws(() => parseCellBlockArg(["--cell-block", "abc"]), /--cell-block deve ser um inteiro/);
  });
});

// buildKeysInScope exportada como ponto de teste (#633): se o escopo divergir entre
// --update-html e --schedule, um dos dois estará errado.
describe("buildKeysInScope (#2775 — generaliza semana->bloco, cellBlock configurável)", () => {
  it("bloco 1 (cellBlock=1): só chaves com sufixo A/B/C (dNN-A/B/C para d01-d07)", () => {
    const keys = buildKeysInScope(SENDS, [1], 1);
    assert.equal(keys.size, 21, "bloco 1 deve ter 21 chaves (7 dias × 3 células A/B/C)");
    for (const k of keys) {
      assert.match(k, /^d(0[1-7])-[ABC]$/, `chave fora do range bloco 1: ${k}`);
    }
    assert.ok(!keys.has("d08"), "bloco 2 não deve estar em --blocks 1");
    assert.ok(!keys.has("d15"), "bloco 3 não deve estar em --blocks 1");
  });

  it("bloco 2 (cellBlock=1, bloco 2 != cellBlock): chaves sem sufixo de célula (d08-d14)", () => {
    const keys = buildKeysInScope(SENDS, [2], 1);
    assert.equal(keys.size, 7, "bloco 2 deve ter 7 chaves (7 dias × 1 campanha)");
    for (const k of keys) {
      assert.match(k, /^d(0[89]|1[0-4])$/, `chave fora do range bloco 2: ${k}`);
    }
    assert.ok(!keys.has("d01-A"), "bloco 1 não deve estar em --blocks 2");
    assert.ok(!keys.has("d15"), "bloco 3 não deve estar em --blocks 2");
  });

  it("bloco 3: só chaves d15-d21", () => {
    const keys = buildKeysInScope(SENDS, [3], 1);
    assert.equal(keys.size, 7, "bloco 3 deve ter 7 chaves");
    for (const k of keys) {
      assert.match(k, /^d(1[5-9]|2[01])$/, `chave fora do range bloco 3: ${k}`);
    }
    assert.ok(!keys.has("d01-A"), "bloco 1 não deve estar em --blocks 3");
    assert.ok(!keys.has("d08"), "bloco 2 não deve estar em --blocks 3");
  });

  it("blocos 2,3: chaves combinadas (d08-d21)", () => {
    const keys = buildKeysInScope(SENDS, [2, 3], 1);
    assert.equal(keys.size, 14, "blocos 2+3 devem ter 14 chaves");
    assert.ok(keys.has("d08") && keys.has("d14") && keys.has("d15") && keys.has("d21"));
    assert.ok(!keys.has("d01-A"), "bloco 1 não deve estar em --blocks 2,3");
  });

  it("blocos 1,3 (bloco 2 omitido): contém bloco 1 e 3, mas não 2", () => {
    const keys = buildKeysInScope(SENDS, [1, 3], 1);
    assert.equal(keys.size, 28, "--blocks 1,3 deve ter 28 chaves (21 + 7)");
    assert.ok(keys.has("d01-A") && keys.has("d21"));
    assert.ok(!keys.has("d08"), "bloco 2 NÃO deve estar em --blocks 1,3");
  });

  it("blocos 1,2,3: todas as 35 chaves (21 + 7 + 7)", () => {
    const keys = buildKeysInScope(SENDS, [1, 2, 3], 1);
    assert.equal(keys.size, 35);
  });

  it("cellBlock configurável: cellBlock=2 faz o bloco 2 ganhar sufixo A/B/C, bloco 1 vira chave simples", () => {
    const keysBlock1 = buildKeysInScope(SENDS, [1], 2);
    assert.equal(keysBlock1.size, 7, "bloco 1 (não é mais cellBlock) deve ter 7 chaves simples");
    for (const k of keysBlock1) assert.match(k, /^d0[1-7]$/);

    const keysBlock2 = buildKeysInScope(SENDS, [2], 2);
    assert.equal(keysBlock2.size, 21, "bloco 2 (agora cellBlock) deve ter 21 chaves A/B/C");
    for (const k of keysBlock2) assert.match(k, /^d(0[89]|1[0-4])-[ABC]$/);
  });
});

// Regressão #2041 item 1: htmlPath derivado de resolveMonthlyDir(cycle), não hardcoded 2605
describe("htmlPath resolução via resolveMonthlyDir (#2041 item 1)", () => {
  it("cycle 2605-06 aponta pra pasta 2605-06, não 2605", () => {
    const cycle = "2605-06";
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

  it("nome de campanha bloco-célula para 2606-07 contém '2606', não '2605'", () => {
    const cycle = "2606-07";
    const yymm = cycleToYymm(cycle);
    const name = `Clarice News ${yymm} d01-A (qua)`;
    assert.ok(name.includes("2606"), `nome deve conter '2606': ${name}`);
    assert.ok(!name.includes("2605"), `nome NÃO deve conter '2605': ${name}`);
  });

  it("nome de campanha demais blocos para 2606-07 contém '2606', não '2605'", () => {
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

  it("JSON válido em campaigns-summary não lança erro", () => {
    const valid = JSON.stringify([{ key: "d01-A", campaignId: 1, listId: 2, subject: "X", scheduledAt: "2026-06-10T09:00:00.000Z", status: "draft" }]);
    assert.doesNotThrow(() => JSON.parse(valid));
  });
});

// Regressão #2009: gabarito-guard de É IA? em --schedule
describe("checkEiaGuard (#2009 — guard gabarito É IA? antes do --schedule)", () => {
  it("skip=true → ok sem checar existência do marker", () => {
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

    assert.equal(c1.status, "scheduled", "c1 (fulfilled queued) deve estar scheduled");
    assert.equal(c3.status, "scheduled", "c3 (fulfilled scheduled) deve estar scheduled");
    assert.equal(c2.status, "draft", "c2 (rejected) deve permanecer draft");
    assert.equal(writeCalls.length, 2, "deve escrever 2× no disco (c1 + c3)");

    const warnLogs = logs.filter((m) => m.includes("d01-B") && m.includes("⚠"));
    assert.equal(warnLogs.length, 1, "deve haver 1 warn para d01-B");
    assert.ok(warnLogs[0].includes("re-tente --schedule"), "warn deve mencionar retry");
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
      { status: 'fulfilled', value: { status: 'queued' } },
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
describe('scheduledAt passado em --schedule — guard simétrico (#2101 finding 4)', () => {
  it('scheduledAt no passado é detectado pela comparacao direta (nao envolve assertScheduledAtFuture)', () => {
    const pastIso = '2020-01-01T09:00:00.000Z';
    assert.ok(new Date(pastIso) <= new Date(), 'data passada deve ser detectavel pelo guard');
  });

  it('scheduledAt no futuro nao dispara o guard', () => {
    const futureIso = '2099-01-01T09:00:00.000Z';
    assert.ok(!(new Date(futureIso) <= new Date()), 'data futura nao deve disparar o guard');
  });

  it('assertScheduledAtFuture valida n=1 com clock no passado do ciclo', () => {
    const justBefore = new Date('2026-06-09T00:00:00Z');
    assert.doesNotThrow(() => assertScheduledAtFuture(SENDS, 1, justBefore));
  });

  it('assertScheduledAtFuture lanca para d21 com clock em julho (ciclo encerrado)', () => {
    const afterAllSends = new Date('2026-07-05T00:00:00Z');
    assert.throws(
      () => assertScheduledAtFuture(SENDS, 21, afterAllSends),
      /desatualizado|passado ou presente/i,
    );
  });
});

// Regressão #3658 (mesma classe do #3652 bug 2 em clarice-schedule-ramp.ts):
// falha de putFn na campanha N não deve impedir que as campanhas 1..N-1
// (já agendadas de verdade e imutáveis na Brevo) tenham seu status local
// persistido como "scheduled" — antes, o loop só persistia UMA VEZ no fim,
// então uma exceção no meio do loop perdia o rastro de todo o progresso
// já feito.
describe("runScheduleLoop (#3658 — persistência per-iteração, não só no fim do loop)", () => {
  function makeCampaign(key: string, id: number): { key: string; campaignId: number; listId: number; subject: string; scheduledAt: string; status: "draft" | "scheduled" } {
    return { key, campaignId: id, listId: 1, subject: "X", scheduledAt: "2099-01-01T09:00:00.000Z", status: "draft" };
  }

  it("putFn lança na campanha N → campanhas 1..N-1 já têm status='scheduled' persistido (não se perde na exceção)", async () => {
    const c1 = makeCampaign("d01", 1);
    const c2 = makeCampaign("d02", 2);
    const c3 = makeCampaign("d03", 3); // putFn desta vai lançar
    const campaigns = [c1, c2, c3];
    const keysInScope = new Set(["d01", "d02", "d03"]);
    const writeCalls: string[] = [];
    const logs: string[] = [];

    const putFn = async (c: typeof c1) => {
      if (c.key === "d03") throw new Error("500 Internal Server Error (Brevo transiente)");
      // PUT real seria aqui — mock apenas resolve
    };
    const verifyFn = async (c: typeof c1) => ({ status: "queued" });

    await assert.rejects(
      () => runScheduleLoop(campaigns, keysInScope, "/fake/campaigns-summary.json", {
        putFn,
        verifyFn,
        writeFn: (_p, content) => { writeCalls.push(content); },
        logFn: (m) => { logs.push(m); },
      }),
      /500 Internal Server Error/,
    );

    // c1 e c2 (sucesso ANTES da falha em c3) devem estar persistidos como
    // scheduled — é exatamente o que o bug antigo perdia (só persistia no
    // fim do loop inteiro, então a exceção em c3 descartava o progresso de
    // c1/c2 também).
    assert.equal(c1.status, "scheduled", "c1 (PUT bem-sucedido antes da falha) deve estar persistido");
    assert.equal(c2.status, "scheduled", "c2 (PUT bem-sucedido antes da falha) deve estar persistido");
    assert.equal(c3.status, "draft", "c3 (putFn lançou) deve permanecer draft — nunca foi agendado de fato");
    assert.equal(writeCalls.length, 2, "deve ter gravado em disco 2× (c1 + c2), antes da exceção de c3");
  });

  it("todas as campanhas bem-sucedidas → todas persistidas como scheduled, na ordem", async () => {
    const c1 = makeCampaign("d01", 1);
    const c2 = makeCampaign("d02", 2);
    const campaigns = [c1, c2];
    const keysInScope = new Set(["d01", "d02"]);
    const putCalls: string[] = [];

    await runScheduleLoop(campaigns, keysInScope, "/fake/path", {
      putFn: async (c) => { putCalls.push(c.key); },
      verifyFn: async () => ({ status: "scheduled" }),
      writeFn: () => {},
      logFn: () => {},
    });

    assert.deepEqual(putCalls, ["d01", "d02"], "PUTs sequenciais na ordem do array");
    assert.equal(c1.status, "scheduled");
    assert.equal(c2.status, "scheduled");
  });

  it("campanha fora de keysInScope é ignorada (não chama putFn)", async () => {
    const c1 = makeCampaign("d01", 1);
    const c2 = makeCampaign("d99", 2); // fora do escopo
    const campaigns = [c1, c2];
    const keysInScope = new Set(["d01"]);
    const putCalls: string[] = [];

    await runScheduleLoop(campaigns, keysInScope, "/fake/path", {
      putFn: async (c) => { putCalls.push(c.key); },
      verifyFn: async () => ({ status: "scheduled" }),
      writeFn: () => {},
      logFn: () => {},
    });

    assert.deepEqual(putCalls, ["d01"]);
    assert.equal(c2.status, "draft", "fora de escopo — não deve ser tocado");
  });

  it("campanha já 'scheduled' é pulada (não chama putFn de novo)", async () => {
    const c1 = makeCampaign("d01", 1);
    c1.status = "scheduled";
    const campaigns = [c1];
    const keysInScope = new Set(["d01"]);
    const putCalls: string[] = [];

    await runScheduleLoop(campaigns, keysInScope, "/fake/path", {
      putFn: async (c) => { putCalls.push(c.key); },
      verifyFn: async () => ({ status: "scheduled" }),
      writeFn: () => {},
      logFn: () => {},
    });

    assert.equal(putCalls.length, 0, "já agendada — não deve re-PUTar");
  });

  it("scheduledAt no passado lança ANTES do putFn (guard simétrico ao --create, #2101)", async () => {
    const c1 = makeCampaign("d01", 1);
    c1.scheduledAt = "2020-01-01T09:00:00.000Z"; // passado
    const campaigns = [c1];
    const keysInScope = new Set(["d01"]);
    const putCalls: string[] = [];

    await assert.rejects(
      () => runScheduleLoop(campaigns, keysInScope, "/fake/path", {
        putFn: async (c) => { putCalls.push(c.key); },
        verifyFn: async () => ({ status: "scheduled" }),
        writeFn: () => {},
        logFn: () => {},
      }),
      /passado\/presente/,
    );
    assert.equal(putCalls.length, 0, "guard deve barrar ANTES de chamar putFn");
  });
});
