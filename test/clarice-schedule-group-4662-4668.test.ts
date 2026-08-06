import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveScheduleAtArg,
  checkRescheduleAllowed,
  isSameInstant,
  applyRescheduleVerifyResults,
  type CampaignEntry,
} from "../scripts/clarice-schedule-group.ts";
import { scheduledAtForDate } from "../scripts/lib/clarice-wave-plan.ts";

/**
 * test/clarice-schedule-group-4662-4668.test.ts
 *
 * #4662 — `--schedule-at` só-data ("YYYY-MM-DD") era interpretado pelo
 * `Date` do JS como MEIA-NOITE UTC (21:00 BRT do dia anterior) — incidente
 * real: campanha #119 ficou agendada 9h adiantada (05/08/2026). Fix: recusar
 * data sem hora explícita com erro claro sugerindo o horário canônico
 * (derivado de `scheduledAtForDate`, fonte única — nunca duplicar "09:00Z").
 *
 * #4668 — não existia caminho suportado pra REAGENDAR uma campanha já
 * `scheduled` (`--schedule` pula silenciosamente); a única saída era PUT
 * manual, que não grava `group-campaigns.json` nem confere o resultado.
 * Fix: `--reschedule`, com guards de status terminal (local + AO VIVO na
 * Brevo) e GET-verify comparando por INSTANTE (nunca string — a Brevo
 * devolve `scheduledAt` com offset, não "Z").
 */

// ---------------------------------------------------------------------------
// #4662 — resolveScheduleAtArg: só-data recusada, data-hora preservada,
// calendário inválido recusado, paridade com scheduledAtForDate
// ---------------------------------------------------------------------------

describe("resolveScheduleAtArg (#4662 — incidente campanha #119, meia-noite UTC em silêncio)", () => {
  it("REGRESSÃO: só-data (YYYY-MM-DD) NUNCA resolve pra meia-noite — aborta com erro claro", () => {
    const result = resolveScheduleAtArg("2026-08-06");
    assert.ok("error" in result, "esperava { error }, não { scheduledAt }");
    if (!("error" in result)) throw new Error("unreachable");
    assert.match(result.error, /não tem hora/);
    assert.match(result.error, /meia-noite UTC/);
    assert.match(result.error, /#4662/);
    // a sugestão no erro é literalmente o horário canônico (09:00 UTC) —
    // nunca "00:00:00.000Z", que foi o valor real do incidente.
    assert.match(result.error, /2026-08-06T09:00:00\.000Z/);
    assert.doesNotMatch(result.error, /2026-08-06T00:00:00/);
  });

  it("teste de paridade (#4662, cobertura pedida na issue): a sugestão do erro é EXATAMENTE scheduledAtForDate(raw) — fonte única, não duplicada", () => {
    for (const date of ["2026-08-06", "2026-01-01", "2026-12-31"]) {
      const result = resolveScheduleAtArg(date);
      assert.ok("error" in result);
      if (!("error" in result)) throw new Error("unreachable");
      assert.ok(result.error.includes(scheduledAtForDate(date)), `sugestão do erro deveria conter ${scheduledAtForDate(date)}: ${result.error}`);
    }
  });

  it("data-hora explícita (com hora) continua preservada — comportamento pré-existente não regride", () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = resolveScheduleAtArg(future) as { scheduledAt: string };
    assert.equal(result.scheduledAt, new Date(future).toISOString());
  });

  it("data-hora explícita com offset (não-Z) também é aceita (comportamento pré-existente)", () => {
    const future = new Date(Date.now() + 3600_000);
    const y = future.getUTCFullYear();
    const raw = `${y + 1}-08-06T06:00:00-03:00`; // ano seguro no futuro
    const result = resolveScheduleAtArg(raw) as { scheduledAt: string };
    assert.equal(result.scheduledAt, new Date(raw).toISOString());
  });

  it("REGRESSÃO (#4680, achado 2): data inexistente no calendário COM OFFSET explícito (2026-02-31-03:00) → aborta — antes só o sufixo 'Z' era validado", () => {
    const result = resolveScheduleAtArg("2026-02-31T09:00:00-03:00");
    assert.ok("error" in result);
    if (!("error" in result)) throw new Error("unreachable");
    assert.match(result.error, /inexistente no calendário/);
  });

  it("(#4680) ano bissexto válido COM OFFSET (2028-02-29) → aceito", () => {
    const result = resolveScheduleAtArg("2028-02-29T09:00:00-03:00");
    assert.ok("scheduledAt" in result, `esperava sucesso, recebeu erro: ${"error" in result ? result.error : ""}`);
  });

  it("(#4680) ano NÃO-bissexto COM OFFSET (2026-02-29) → recusado, dia inexistente", () => {
    const result = resolveScheduleAtArg("2026-02-29T09:00:00-03:00");
    assert.ok("error" in result);
    if (!("error" in result)) throw new Error("unreachable");
    assert.match(result.error, /inexistente no calendário/);
  });

  it("REGRESSÃO: data no PASSADO continua abortando — guard pré-existente não regride", () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const result = resolveScheduleAtArg(past);
    assert.ok("error" in result);
    if (!("error" in result)) throw new Error("unreachable");
    assert.match(result.error, /deve estar no futuro/);
  });

  it("ISO inválido (não-data) → erro claro (comportamento pré-existente)", () => {
    const result = resolveScheduleAtArg("não-é-uma-data");
    assert.ok("error" in result);
    if (!("error" in result)) throw new Error("unreachable");
    assert.match(result.error, /não é ISO 8601 válido/);
  });

  it("REGRESSÃO (#4662): data inexistente no calendário, Z-sufixada com hora explícita (2026-02-31) → aborta, não vira 2026-03-03 em silêncio", () => {
    const result = resolveScheduleAtArg("2026-02-31T09:00:00Z");
    assert.ok("error" in result);
    if (!("error" in result)) throw new Error("unreachable");
    assert.match(result.error, /inexistente no calendário/);
  });

  it("REGRESSÃO (#4662): só-data com calendário inexistente (2026-02-31) → erro nomeia o calendário, via scheduledAtForDate", () => {
    const result = resolveScheduleAtArg("2026-02-31");
    assert.ok("error" in result);
    if (!("error" in result)) throw new Error("unreachable");
    assert.match(result.error, /inexistente no calendário/);
  });

  it("ausente → { scheduledAt: undefined } (rascunho SEM data, comportamento pré-existente #4347 G7/D7)", () => {
    assert.deepEqual(resolveScheduleAtArg(undefined), { scheduledAt: undefined });
  });
});

// ---------------------------------------------------------------------------
// #4668 — checkRescheduleAllowed: status terminal recusado (local E ao vivo)
// ---------------------------------------------------------------------------

describe("checkRescheduleAllowed (#4668 — reagendar campanha já scheduled)", () => {
  it("REGRESSÃO: status LOCAL 'sent' → recusa (status terminal, não reagenda)", () => {
    const result = checkRescheduleAllowed("sent", "sent");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /já foi DISPARADA/);
  });

  it("status LOCAL 'draft' (nunca agendada) → recusa, aponta pro --schedule", () => {
    const result = checkRescheduleAllowed("draft", "draft");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /--schedule/);
  });

  it("REGRESSÃO: local 'scheduled' mas AO VIVO 'in_review' → recusa (o local pode estar defasado; #4364)", () => {
    const result = checkRescheduleAllowed("scheduled", "in_review");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /in_review/);
    assert.match(result.reason, /terminal AO VIVO/);
  });

  it("REGRESSÃO: local 'scheduled' mas AO VIVO 'sent' (disparou entre invocações) → recusa", () => {
    const result = checkRescheduleAllowed("scheduled", "sent");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /terminal AO VIVO/);
  });

  it("local 'scheduled' e ao vivo 'queued' → permite (queued é aceito por isScheduledStatus)", () => {
    assert.deepEqual(checkRescheduleAllowed("scheduled", "queued"), { ok: true });
  });

  it("local 'scheduled' e ao vivo 'scheduled' → permite (caso normal)", () => {
    assert.deepEqual(checkRescheduleAllowed("scheduled", "scheduled"), { ok: true });
  });
});

// ---------------------------------------------------------------------------
// #4668 — isSameInstant: comparação por INSTANTE, nunca por string
// ---------------------------------------------------------------------------

describe("isSameInstant (#4668 — offset vs Z: a Brevo devolve scheduledAt com offset, não 'Z')", () => {
  it("REGRESSÃO: mesmo instante em formatos DIFERENTES (Z vs offset -03:00) → true (comparação por string daria falso negativo)", () => {
    assert.equal(isSameInstant("2026-08-06T09:00:00.000Z", "2026-08-06T06:00:00.000-03:00"), true);
  });

  it("mesmo instante, mesma string → true (caso trivial)", () => {
    assert.equal(isSameInstant("2026-08-06T09:00:00.000Z", "2026-08-06T09:00:00.000Z"), true);
  });

  it("instantes DIFERENTES → false", () => {
    assert.equal(isSameInstant("2026-08-06T09:00:00.000Z", "2026-08-06T10:00:00.000Z"), false);
  });

  it("null/undefined em qualquer lado → false (nunca lança)", () => {
    assert.equal(isSameInstant(null, "2026-08-06T09:00:00.000Z"), false);
    assert.equal(isSameInstant("2026-08-06T09:00:00.000Z", undefined), false);
    assert.equal(isSameInstant(undefined, null), false);
  });

  it("string não-parseável → false, não lança", () => {
    assert.equal(isSameInstant("não é data", "2026-08-06T09:00:00.000Z"), false);
  });
});

// ---------------------------------------------------------------------------
// #4668 — applyRescheduleVerifyResults: só persiste DEPOIS do verify por
// instante confirmar; nunca grava estado "meio aplicado"
// ---------------------------------------------------------------------------

describe("applyRescheduleVerifyResults (#4668 — grava group-campaigns.json só após GET-verify confirmar por instante)", () => {
  function makeEntry(overrides: Partial<CampaignEntry> = {}): CampaignEntry {
    return {
      key: "d6-qui06",
      campaignId: 119,
      listId: 42,
      subject: "Assunto",
      scheduledAt: "2026-08-06T00:00:00.000Z", // o valor errado do incidente
      status: "scheduled",
      ...overrides,
    };
  }

  it("REGRESSÃO: GET confirma status scheduled + scheduledAt bate por INSTANTE (offset ≠ Z) → grava novo horário, loga anterior→novo", () => {
    const c = makeEntry();
    const campaigns = [c];
    const target = "2026-08-06T09:00:00.000Z";
    let written: string | undefined;
    const logs: string[] = [];
    applyRescheduleVerifyResults(
      // Brevo devolve com OFFSET, não Z — mesmo instante que `target`.
      [{ status: "fulfilled", value: { status: "scheduled", scheduledAt: "2026-08-06T06:00:00.000-03:00" } }],
      [c],
      [target],
      campaigns,
      "/fake/group-campaigns.json",
      (_p, content) => { written = content; },
      (m) => logs.push(m),
    );
    assert.equal(c.scheduledAt, target);
    assert.equal(c.status, "scheduled");
    assert.ok(written && JSON.parse(written)[0].scheduledAt === target);
    assert.ok(logs.some((l) => /REAGENDADA/.test(l) && l.includes("2026-08-06T00:00:00.000Z") && l.includes(target)));
  });

  it("REGRESSÃO: GET confirma status mas scheduledAt devolvido NÃO bate com o alvo → NÃO persiste, avisa comparação por instante", () => {
    const c = makeEntry();
    const campaigns = [c];
    const original = c.scheduledAt;
    let writeCalled = false;
    const logs: string[] = [];
    applyRescheduleVerifyResults(
      [{ status: "fulfilled", value: { status: "scheduled", scheduledAt: "2026-08-06T12:00:00.000Z" } }], // valor DIFERENTE do alvo
      [c],
      ["2026-08-06T09:00:00.000Z"],
      campaigns,
      "/fake/group-campaigns.json",
      () => { writeCalled = true; },
      (m) => logs.push(m),
    );
    assert.equal(c.scheduledAt, original, "nada deve mudar quando o instante não confere");
    assert.equal(writeCalled, false);
    assert.ok(logs.some((l) => /NÃO confere/.test(l) && /INSTANTE/.test(l)));
    // #4680 (achado 1): mesmo guard aplicado em main() após esta chamada —
    // c.scheduledAt não bate com o alvo, então o caller deve setar
    // process.exitCode = 2 em vez de sair com 0 silenciosamente.
    assert.equal(isSameInstant(c.scheduledAt, "2026-08-06T09:00:00.000Z"), false);
  });

  it("GET não mostra status scheduled/queued (ex: draft, PUT não pegou) → NÃO persiste", () => {
    const c = makeEntry();
    const campaigns = [c];
    let writeCalled = false;
    const logs: string[] = [];
    applyRescheduleVerifyResults(
      [{ status: "fulfilled", value: { status: "draft", scheduledAt: null } }],
      [c],
      ["2026-08-06T09:00:00.000Z"],
      campaigns,
      "/fake/group-campaigns.json",
      () => { writeCalled = true; },
      (m) => logs.push(m),
    );
    assert.equal(writeCalled, false);
    assert.ok(logs.some((l) => /status="draft"/.test(l)));
    // #4680 (achado 1): status errado → scheduledAt local nunca foi tocado,
    // guard de main() deve sinalizar exit 2.
    assert.equal(isSameInstant(c.scheduledAt, "2026-08-06T09:00:00.000Z"), false);
  });

  it("GET rejeitado (falha de rede) → NÃO persiste, avisa pra re-tentar", () => {
    const c = makeEntry();
    const campaigns = [c];
    let writeCalled = false;
    const logs: string[] = [];
    applyRescheduleVerifyResults(
      [{ status: "rejected", reason: new Error("timeout") }],
      [c],
      ["2026-08-06T09:00:00.000Z"],
      campaigns,
      "/fake/group-campaigns.json",
      () => { writeCalled = true; },
      (m) => logs.push(m),
    );
    assert.equal(writeCalled, false);
    assert.ok(logs.some((l) => /falhou/.test(l) && /re-tente --reschedule/.test(l)));
    // #4680 (achado 1): GET rejeitado → scheduledAt local nunca foi tocado,
    // guard de main() deve sinalizar exit 2.
    assert.equal(isSameInstant(c.scheduledAt, "2026-08-06T09:00:00.000Z"), false);
  });

  it("invariante settled.length/toVerify.length/newScheduledAts.length divergentes → lança", () => {
    assert.throws(() =>
      applyRescheduleVerifyResults([], [makeEntry()], ["2026-08-06T09:00:00.000Z"], [], "/fake/path.json", () => {}, () => {}),
    );
  });
});
