import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveGroupListId,
  campaignNameFor,
  parseSubjectArg,
  checkListIdMismatch,
  buildInvocationSummary,
  type CampaignEntry,
} from "../scripts/clarice-schedule-group.ts";
import { appendGroupListsRegistry } from "../scripts/clarice-import-waves.ts";
import { checkEiaGuard, isScheduledStatus, applyVerifyResults } from "../scripts/clarice-schedule-sends.ts";

/**
 * #3228 — regressão pro gap descrito na issue: o pipeline canônico de
 * agendamento (clarice-build-edition-sends → clarice-split-cells →
 * clarice-schedule-sends) só sabia casar campanha↔lista via sends-summary.json
 * (dNN do plano de blocos/rampa), sem jeito de criar+agendar campanha em cima
 * de uma lista de GRUPO NOMEADO (engajados/reativacao/ramp-warm,
 * clarice-build-segment.ts + clarice-import-waves.ts --group). O único
 * caminho era publish-monthly.ts (@deprecated #2009).
 *
 * Este arquivo testa os helpers PUROS de clarice-schedule-group.ts (#3228,
 * o script irmão que fecha esse gap) — main() em si não é testado
 * diretamente porque resolve caminhos reais via clariceSegmentsDir/
 * resolveMonthlyDir (mesma limitação de clarice-schedule-sends.test.ts, que
 * também só cobre os helpers exportados, nunca main() e2e). A lógica de
 * transporte Brevo (brevoPost/Put/GetCampaign) e os guards reusados
 * (checkEiaGuard, applyVerifyResults) já têm cobertura própria em
 * clarice-schedule-sends.test.ts — reimportados aqui só pra provar que o
 * script novo de fato REUSA-os (não duplica), fechando o requisito do #633
 * combinado com a lição do #3226 (duplicação de lógica não-testada).
 */

describe("resolveGroupListId (#3228 — resolve listId do registro de --group --execute)", () => {
  it("1 lista registrada → resolve ela", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-group-single-"));
    try {
      appendGroupListsRegistry(dir, "2606-07", "ramp-warm", [
        { listId: 69, listName: "Clarice Ramp Jul/2026 ramp-warm", count: 6403, importedAt: "2026-07-10T12:00:00.000Z" },
      ]);
      const resolved = resolveGroupListId(dir, "ramp-warm");
      assert.deepEqual(resolved, { listId: 69, listName: "Clarice Ramp Jul/2026 ramp-warm" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("múltiplas listas (3 budgets do mesmo grupo, caso real 260710 #69/#70/#71) → default é a ÚLTIMA", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-group-multi-"));
    try {
      appendGroupListsRegistry(dir, "2606-07", "ramp-warm", [
        { listId: 69, listName: "lista 1", count: 6403, importedAt: "2026-07-10T12:00:00.000Z" },
      ]);
      appendGroupListsRegistry(dir, "2606-07", "ramp-warm", [
        { listId: 70, listName: "lista 2", count: 7043, importedAt: "2026-07-10T13:00:00.000Z" },
      ]);
      appendGroupListsRegistry(dir, "2606-07", "ramp-warm", [
        { listId: 71, listName: "lista 3", count: 7748, importedAt: "2026-07-10T14:00:00.000Z" },
      ]);

      assert.deepEqual(resolveGroupListId(dir, "ramp-warm"), { listId: 71, listName: "lista 3" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--list-index explícito escolhe uma entrada específica (não a última)", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-group-index-"));
    try {
      appendGroupListsRegistry(dir, "2606-07", "ramp-warm", [
        { listId: 69, listName: "lista 1", count: 6403, importedAt: "2026-07-10T12:00:00.000Z" },
        { listId: 70, listName: "lista 2", count: 7043, importedAt: "2026-07-10T13:00:00.000Z" },
      ]);
      assert.deepEqual(resolveGroupListId(dir, "ramp-warm", 0), { listId: 69, listName: "lista 1" });
      assert.deepEqual(resolveGroupListId(dir, "ramp-warm", 1), { listId: 70, listName: "lista 2" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("índice fora do range → erro claro com o range válido", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-group-oob-"));
    try {
      appendGroupListsRegistry(dir, "2606-07", "ramp-warm", [
        { listId: 69, listName: "lista 1", count: 6403, importedAt: "2026-07-10T12:00:00.000Z" },
      ]);
      assert.throws(() => resolveGroupListId(dir, "ramp-warm", 5), /--list-index 5 fora do range.*0\.\.0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registro ausente → erro claro apontando pro comando clarice-import-waves.ts --group", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-group-missing-"));
    try {
      assert.throws(
        () => resolveGroupListId(dir, "engajados"),
        /registro de listas do grupo 'engajados' não encontrado/,
      );
      assert.throws(() => resolveGroupListId(dir, "engajados"), /clarice-import-waves\.ts.*--group engajados.*--execute/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registro corrompido (JSON inválido) → erro claro, não crash cryptico", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-group-corrupt-"));
    try {
      writeFileSync(join(dir, "engajados-lists.json"), "{ not json", "utf8");
      assert.throws(() => resolveGroupListId(dir, "engajados"), /corrompido \(JSON inválido\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registro com lista vazia → erro claro", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-group-empty-"));
    try {
      writeFileSync(
        join(dir, "engajados-lists.json"),
        JSON.stringify({ cycle: "2606-07", group: "engajados", lists: [] }),
        "utf8",
      );
      assert.throws(() => resolveGroupListId(dir, "engajados"), /está vazio/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("campaignNameFor (#3228)", () => {
  it("nome determinístico derivado do cycleToYymm + key (não hardcoded, regressão #2041 item 2)", () => {
    assert.equal(campaignNameFor("2606-07", "ramp-warm"), "Clarice 2606 grupo:ramp-warm");
    assert.equal(campaignNameFor("2605-06", "engajados"), "Clarice 2605 grupo:engajados");
  });

  it("ciclos diferentes não colidem no nome", () => {
    const a = campaignNameFor("2605-06", "ramp-warm");
    const b = campaignNameFor("2606-07", "ramp-warm");
    assert.notEqual(a, b);
  });
});

describe("parseSubjectArg (#3228 — mesma forma de clarice-schedule-sends.ts)", () => {
  it("--subject presente → retorna o valor", () => {
    assert.equal(parseSubjectArg(["--subject", "Assunto da campanha"]), "Assunto da campanha");
  });

  it("--subject ausente → undefined", () => {
    assert.equal(parseSubjectArg(["--cycle", "2606-07"]), undefined);
  });

  it("--subject no fim do array (sem valor) → undefined, não engole flag seguinte", () => {
    assert.equal(parseSubjectArg(["--create", "--subject"]), undefined);
  });
});

describe("checkListIdMismatch (#3354 — --create idempotente por key não comparava listId)", () => {
  const baseEntry: CampaignEntry = {
    key: "ramp-warm",
    campaignId: 123,
    listId: 69,
    subject: "Assunto A",
    scheduledAt: "2026-07-15T09:00:00.000Z",
    status: "draft",
  };

  it("existing ausente (1ª criação sob a key) → ok, nada a comparar", () => {
    const result = checkListIdMismatch(undefined, 70);
    assert.deepEqual(result, { ok: true });
  });

  it("caso feliz: mesma key, mesmo listId (re-run legítimo, ex: retry pós-falha de rede) → ok, no-op silencioso", () => {
    const result = checkListIdMismatch(baseEntry, 69);
    assert.deepEqual(result, { ok: true });
  });

  it("regressão #3354: mesma key, listId DIVERGENTE (cenário real 260710 — 2ª --create sob 'ramp-warm' após lista nova #70 sem trocar --key) → sinaliza, não silencia", () => {
    const result = checkListIdMismatch(baseEntry, 70);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable"); // narrow pro TS
    assert.match(result.message, /MISMATCH/);
    assert.match(result.message, /ramp-warm/);
    assert.match(result.message, /#123/);
    assert.match(result.message, /listId=69/);
    assert.match(result.message, /listId=70/);
  });

  it("mensagem de mismatch orienta o operador (--key distinta pra lista separada, sem prometer flag inexistente no branch existing)", () => {
    const result = checkListIdMismatch(baseEntry, 999);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.message, /--key distinta/);
    assert.match(result.message, /ramp-warm-2/);
  });
});

describe("buildInvocationSummary (#4202 — JSON de saída reflete a INVOCAÇÃO, não o acumulado do ciclo)", () => {
  // Cenário real do incidente (envio11/#100 de 260727): o ciclo já tinha uma
  // campanha anterior (envio10/#90, scheduled) quando --create criou a #100 —
  // o JSON antigo ({created: campaigns.length, scheduled: N}) reportava
  // `created: 2` logo após criar 1 campanha, porque contava as DUAS entradas
  // do state file do ciclo inteiro.
  const envio10: CampaignEntry = {
    key: "envio10",
    campaignId: 90,
    listId: 84,
    subject: "Assunto envio10",
    scheduledAt: "2026-07-20T09:00:00.000Z",
    status: "scheduled",
  };

  it("--create: phase='create', campaignId/listId da invocação atual — não 'created: 2' com só 1 campanha nova", () => {
    const envio11Draft: CampaignEntry = {
      key: "envio11",
      campaignId: 100,
      listId: 85,
      subject: "Assunto envio11",
      scheduledAt: "2026-07-27T09:00:00.000Z",
      status: "draft",
    };
    const allCampaigns = [envio10, envio11Draft];
    const summary = buildInvocationSummary(
      "envio11",
      85,
      { create: true, updateHtml: false, sendTest: false, schedule: false },
      envio11Draft,
      allCampaigns,
    );
    assert.equal(summary.key, "envio11");
    assert.equal(summary.campaignId, 100);
    assert.equal(summary.listId, 85);
    assert.equal(summary.phase, "create");
    assert.equal(summary.status, "draft");
    // acumulado do ciclo continua disponível, mas NOMEADO/SEPARADO — nunca
    // confundido com o resultado desta invocação (que criou 1 campanha).
    assert.deepEqual(summary.cycleTotals, { created: 2, scheduled: 1 });
  });

  it("--send-test: phase='send-test', não herda 'created'/'scheduled' de fases anteriores", () => {
    const envio11Draft: CampaignEntry = {
      key: "envio11",
      campaignId: 100,
      listId: 85,
      subject: "Assunto envio11",
      scheduledAt: "2026-07-27T09:00:00.000Z",
      status: "draft",
    };
    const summary = buildInvocationSummary(
      "envio11",
      85,
      { create: false, updateHtml: false, sendTest: true, schedule: false },
      envio11Draft,
      [envio10, envio11Draft],
    );
    assert.equal(summary.phase, "send-test");
    assert.equal(summary.campaignId, 100);
    assert.equal(summary.status, "draft"); // --send-test não muda o status
  });

  it("--schedule: phase='schedule', status reflete 'scheduled' pós-agendamento desta invocação", () => {
    const envio11Scheduled: CampaignEntry = {
      key: "envio11",
      campaignId: 100,
      listId: 85,
      subject: "Assunto envio11",
      scheduledAt: "2026-07-27T09:00:00.000Z",
      status: "scheduled",
    };
    const allCampaigns = [envio10, envio11Scheduled];
    const summary = buildInvocationSummary(
      "envio11",
      85,
      { create: false, updateHtml: false, sendTest: false, schedule: true },
      envio11Scheduled,
      allCampaigns,
    );
    assert.equal(summary.phase, "schedule");
    assert.equal(summary.status, "scheduled");
    // só agora as DUAS campanhas do ciclo estão scheduled — cycleTotals
    // reflete isso, mas continua separado do resultado desta invocação.
    assert.deepEqual(summary.cycleTotals, { created: 2, scheduled: 2 });
  });

  it("nenhuma flag de fase (plan-only) → phase vazio, sem quebrar o shape", () => {
    const summary = buildInvocationSummary(
      "envio12",
      86,
      { create: false, updateHtml: false, sendTest: false, schedule: false },
      undefined,
      [envio10],
    );
    assert.equal(summary.phase, "");
    assert.equal(summary.campaignId, undefined);
    assert.equal(summary.status, undefined);
  });

  it("múltiplas flags na mesma invocação → phase concatena todas as fases executadas", () => {
    const c: CampaignEntry = {
      key: "envio11",
      campaignId: 100,
      listId: 85,
      subject: "X",
      scheduledAt: "2026-07-27T09:00:00.000Z",
      status: "scheduled",
    };
    const summary = buildInvocationSummary(
      "envio11",
      85,
      { create: true, updateHtml: false, sendTest: true, schedule: true },
      c,
      [c],
    );
    assert.equal(summary.phase, "create+send-test+schedule");
  });
});

// Prova que o script novo REUSA (não duplica) os guards do pipeline
// canônico — checkEiaGuard/applyVerifyResults já têm suíte própria em
// clarice-schedule-sends.test.ts; aqui só confirmamos que o import funciona
// e que o shape local CampaignEntry é estruturalmente compatível (TS não
// reclamaria em tempo de compilação se não fosse).
describe("reuso dos guards do pipeline canônico (#3228 — não duplica lógica, ver raiz do #3226)", () => {
  it("checkEiaGuard importado de clarice-schedule-sends.ts funciona igual", () => {
    const result = checkEiaGuard("2606-07", false, "/caminho/inexistente/.close-poll-clarice.json");
    assert.ok(!result.ok);
    assert.ok(result.message.includes("2606-07"));
  });

  it("applyVerifyResults aceita CampaignEntry local (compatibilidade estrutural)", () => {
    const c: CampaignEntry = {
      key: "ramp-warm",
      campaignId: 1,
      listId: 69,
      subject: "X",
      scheduledAt: "2026-07-15T09:00:00.000Z",
      status: "draft",
    };
    const settled: PromiseSettledResult<{ status: string }>[] = [
      { status: "fulfilled", value: { status: "queued" } },
    ];
    const writes: string[] = [];
    applyVerifyResults(settled, [c], [c], "/fake/group-campaigns.json", (_p, content) => writes.push(content), () => {});
    assert.equal(c.status, "scheduled");
    assert.equal(writes.length, 1);
  });

  it("isScheduledStatus segue a mesma semântica (queued/scheduled aceitos, draft/sent não)", () => {
    assert.equal(isScheduledStatus("queued"), true);
    assert.equal(isScheduledStatus("scheduled"), true);
    assert.equal(isScheduledStatus("draft"), false);
    assert.equal(isScheduledStatus("sent"), false);
  });
});
