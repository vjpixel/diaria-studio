import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveScheduleAtArg,
  checkRescheduleAllowed,
  isSameInstant,
  applyRescheduleVerifyResults,
  surfaceScheduleWarning,
  SCHEDULE_AT_MIN_LEAD_MS,
  SCHEDULE_AT_WARNING_PREFIX,
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
    // #7042: offset > SCHEDULE_AT_MIN_LEAD_MS (2h) — 1h já não basta mais
    // desde a antecedência mínima; este teste cobre só a preservação do ISO.
    const future = new Date(Date.now() + 3 * 3600_000).toISOString();
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
// #7042 — resolveScheduleAtArg: antecedência mínima (SCHEDULE_AT_MIN_LEAD_MS)
// + aviso de horário fora do canônico. 3ª ocorrência da mesma classe de bug
// que o #4662 (#4662, #5939) — "no futuro" sozinho aceitava 30s à frente, e
// em 01/09/2026 isso fez 3 campanhas Clarice (#208/209/210) destinadas ao
// dia SEGUINTE saírem no MESMO dia às 14:00 BRT, pra dezenas de milhares de
// contatos. `now` sempre INJETADO com data fixa — nunca `new Date()` real.
// ---------------------------------------------------------------------------

describe("resolveScheduleAtArg (#7042 — antecedência mínima, incidente 01/09/2026 campanhas #208/209/210)", () => {
  const NOW = new Date("2026-09-01T14:00:00.000Z");

  it("REGRESSÃO: 30s no futuro (o caso EXATO do incidente) → erro", () => {
    const raw = new Date(NOW.getTime() + 30_000).toISOString();
    const result = resolveScheduleAtArg(raw, NOW);
    assert.ok("error" in result, "esperava { error }, não { scheduledAt }");
    if (!("error" in result)) throw new Error("unreachable");
    // quanto falta de fato, legível
    assert.match(result.error, /30s/);
    // antecedência mínima exigida
    assert.match(result.error, /antecedência mínima/i);
    assert.match(result.error, /2h/);
    // sugestão do horário canônico do PRÓXIMO dia, via scheduledAtForDate — nunca montada à mão
    assert.match(result.error, /2026-09-02T09:00:00\.000Z/);
    assert.equal(result.error.includes(scheduledAtForDate("2026-09-02")), true);
    // --send-now é o caminho nomeado pra disparo imediato de propósito
    assert.match(result.error, /--send-now/);
    // escape nomeado
    assert.match(result.error, /--allow-imminent/);
    // referência ao histórico de incidentes da mesma classe
    assert.match(result.error, /#4662/);
    assert.match(result.error, /#5939/);
  });

  it("5 min no futuro → erro (mesma antecedência mínima)", () => {
    const raw = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    const result = resolveScheduleAtArg(raw, NOW);
    assert.ok("error" in result);
    if (!("error" in result)) throw new Error("unreachable");
    assert.match(result.error, /5 min/);
    assert.match(result.error, /antecedência mínima/i);
  });

  it("BORDA: exatamente no limite (now + SCHEDULE_AT_MIN_LEAD_MS) → SUCESSO — o limite é inclusivo (comportamento travado aqui)", () => {
    const raw = new Date(NOW.getTime() + SCHEDULE_AT_MIN_LEAD_MS).toISOString();
    const result = resolveScheduleAtArg(raw, NOW);
    assert.ok("scheduledAt" in result, `esperava sucesso, recebeu erro: ${"error" in result ? result.error : ""}`);
  });

  it("BORDA: 1ms ANTES do limite → erro — confirma que o corte é estrito (< min lead, não <=)", () => {
    const raw = new Date(NOW.getTime() + SCHEDULE_AT_MIN_LEAD_MS - 1).toISOString();
    const result = resolveScheduleAtArg(raw, NOW);
    assert.ok("error" in result, "1ms antes do limite deveria abortar");
  });

  it("dia seguinte às 09:00 UTC (horário canônico exato) → sucesso, SEM warning", () => {
    const raw = "2026-09-02T09:00:00.000Z";
    const result = resolveScheduleAtArg(raw, NOW);
    assert.ok("scheduledAt" in result, `esperava sucesso, recebeu erro: ${"error" in result ? result.error : ""}`);
    if (!("scheduledAt" in result)) throw new Error("unreachable");
    assert.equal(result.scheduledAt, raw);
    assert.equal(result.warning, undefined, "horário canônico não deveria gerar warning");
  });

  it("futuro suficiente mas horário NÃO-canônico (dia seguinte 17:00 UTC) → sucesso, COM warning nomeado — não bloqueia (#5140 teste A/B pode reabrir isto)", () => {
    const raw = "2026-09-02T17:00:00.000Z";
    const result = resolveScheduleAtArg(raw, NOW);
    assert.ok("scheduledAt" in result, `esperava sucesso, recebeu erro: ${"error" in result ? result.error : ""}`);
    if (!("scheduledAt" in result)) throw new Error("unreachable");
    assert.equal(result.scheduledAt, raw);
    assert.ok(result.warning, "esperava um warning nomeado pro horário fora do canônico");
    assert.match(result.warning as string, /fora do horário canônico/i);
    assert.match(result.warning as string, /09:00 UTC/);
    assert.match(result.warning as string, /06:00 BRT/);
  });

  describe("allowImminent=true (escape hatch nomeado)", () => {
    it("30s no futuro COM allowImminent=true → sucesso — o escape funciona", () => {
      const raw = new Date(NOW.getTime() + 30_000).toISOString();
      const result = resolveScheduleAtArg(raw, NOW, true);
      assert.ok("scheduledAt" in result, `esperava sucesso, recebeu erro: ${"error" in result ? result.error : ""}`);
    });

    it("allowImminent=true NÃO desliga o guard de data-sem-hora (YYYY-MM-DD)", () => {
      const result = resolveScheduleAtArg("2026-09-02", NOW, true);
      assert.ok("error" in result);
      if (!("error" in result)) throw new Error("unreachable");
      assert.match(result.error, /não tem hora/);
    });

    it("allowImminent=true NÃO desliga o guard de calendário inválido (2026-02-31)", () => {
      const result = resolveScheduleAtArg("2026-02-31T09:00:00Z", NOW, true);
      assert.ok("error" in result);
      if (!("error" in result)) throw new Error("unreachable");
      assert.match(result.error, /inexistente no calendário/);
    });

    it("allowImminent=true NÃO desliga o guard de data no PASSADO", () => {
      const raw = new Date(NOW.getTime() - 3600_000).toISOString();
      const result = resolveScheduleAtArg(raw, NOW, true);
      assert.ok("error" in result);
      if (!("error" in result)) throw new Error("unreachable");
      assert.match(result.error, /deve estar no futuro/);
    });
  });

  // -------------------------------------------------------------------------
  // Achado 6a (fleet review): formatLeadTime não é exportado — coberto
  // indiretamente via a mensagem de erro do guard de antecedência mínima
  // (mesmo padrão já usado pelos testes "30s"/"5 min" acima). Faltava o
  // caso "horas com minutos residuais" (ex: 90min → "1h30min").
  // -------------------------------------------------------------------------
  it("90 min no futuro → erro cita '1h30min' (formatLeadTime: horas com minutos residuais, nunca testado antes)", () => {
    const raw = new Date(NOW.getTime() + 90 * 60_000).toISOString();
    const result = resolveScheduleAtArg(raw, NOW);
    assert.ok("error" in result);
    if (!("error" in result)) throw new Error("unreachable");
    assert.match(result.error, /1h30min/);
  });

  // -------------------------------------------------------------------------
  // Achado 6b (fleet review): isCanonicalHour é um AND de 4 termos (hora,
  // minuto, segundo, milissegundo) — só a HORA diferente (17:00 vs 09:00)
  // era exercitada. Cobre os 3 termos restantes isoladamente: hora CERTA,
  // mas minuto/segundo/milissegundo não-zero também deve gerar o warning.
  // -------------------------------------------------------------------------
  it("hora canônica (09) mas MINUTO não-zero (09:05:00.000Z) → warning (isCanonicalHour: termo minuto)", () => {
    const raw = "2026-09-02T09:05:00.000Z";
    const result = resolveScheduleAtArg(raw, NOW);
    assert.ok("scheduledAt" in result, `esperava sucesso, recebeu erro: ${"error" in result ? result.error : ""}`);
    if (!("scheduledAt" in result)) throw new Error("unreachable");
    // `assert.equal` (== `strictEqual`, `asserts actual is T`) estreita
    // `result` pro membro `{ scheduledAt: string; warning?: string }` antes
    // de acessar `.warning` — sem isto, `result` ainda inclui o membro
    // `{ scheduledAt: undefined }` (sem `warning`) e TS2339 barra o acesso.
    assert.equal(result.scheduledAt, raw);
    assert.ok(result.warning, "esperava warning — 09:05 não é o horário canônico exato");
    assert.match(result.warning as string, /fora do horário canônico/i);
  });

  it("hora canônica (09) mas SEGUNDO não-zero (09:00:05.000Z) → warning (isCanonicalHour: termo segundo)", () => {
    const raw = "2026-09-02T09:00:05.000Z";
    const result = resolveScheduleAtArg(raw, NOW);
    assert.ok("scheduledAt" in result, `esperava sucesso, recebeu erro: ${"error" in result ? result.error : ""}`);
    if (!("scheduledAt" in result)) throw new Error("unreachable");
    assert.equal(result.scheduledAt, raw);
    assert.ok(result.warning, "esperava warning — 09:00:05 não é o horário canônico exato");
    assert.match(result.warning as string, /fora do horário canônico/i);
  });

  it("hora canônica (09:00:00) mas MILISSEGUNDO não-zero (09:00:00.500Z) → warning (isCanonicalHour: termo milissegundo)", () => {
    const raw = "2026-09-02T09:00:00.500Z";
    const result = resolveScheduleAtArg(raw, NOW);
    assert.ok("scheduledAt" in result, `esperava sucesso, recebeu erro: ${"error" in result ? result.error : ""}`);
    if (!("scheduledAt" in result)) throw new Error("unreachable");
    assert.equal(result.scheduledAt, raw);
    assert.ok(result.warning, "esperava warning — 09:00:00.500 não é o horário canônico exato");
    assert.match(result.warning as string, /fora do horário canônico/i);
  });
});

// ---------------------------------------------------------------------------
// #7042 (fleet review, achado P2) — surfaceScheduleWarning: os 2 call sites
// de main() (--create/--reschedule) compartilham este helper mínimo pra
// surfacear `warning`. main() não é testável direto (padrão pré-existente
// deste arquivo — nenhum teste chama main()), então o helper que os 2 call
// sites de fato usam é testado aqui: se um call site parar de chamá-lo (ou
// um 3º nascer sem chamá-lo), o comportamento de logging correto ainda
// precisa passar por ESTE ponto único testado.
// ---------------------------------------------------------------------------

describe("surfaceScheduleWarning (#7042 — ponto único que os 2 call sites de main() compartilham)", () => {
  it("branch de sucesso COM warning → logFn chamado com o texto exato do warning", () => {
    const calls: string[] = [];
    surfaceScheduleWarning({ scheduledAt: "2026-09-02T17:00:00.000Z", warning: `${SCHEDULE_AT_WARNING_PREFIX} fora do canônico` }, (m) => calls.push(m));
    assert.deepEqual(calls, [`${SCHEDULE_AT_WARNING_PREFIX} fora do canônico`]);
  });

  it("branch de sucesso SEM warning (horário canônico) → logFn NUNCA chamado", () => {
    const calls: string[] = [];
    surfaceScheduleWarning({ scheduledAt: "2026-09-02T09:00:00.000Z" }, (m) => calls.push(m));
    assert.deepEqual(calls, []);
  });

  it("branch 'ausente' ({ scheduledAt: undefined }) → logFn NUNCA chamado", () => {
    const calls: string[] = [];
    surfaceScheduleWarning({ scheduledAt: undefined }, (m) => calls.push(m));
    assert.deepEqual(calls, []);
  });

  it("default logFn é console.error (smoke test — não lança sem 2º argumento)", () => {
    assert.doesNotThrow(() => surfaceScheduleWarning({ scheduledAt: undefined }));
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
