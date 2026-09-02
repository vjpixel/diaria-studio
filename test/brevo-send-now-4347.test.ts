/**
 * test/brevo-send-now-4347.test.ts (#4347 Etapa 3b — G7/D7)
 *
 * Envio imediato: `brevoSendNow` (scripts/lib/brevo-client.ts) + verificação
 * pós-disparo em `clarice-schedule-group.ts` (`applySendNowVerifyResults`,
 * `resolveScheduleAtArg`). Cobre exatamente os casos da lista de regressão da
 * issue: `--create` sem `--schedule-at` cria rascunho sem data; `--create`
 * com `--schedule-at` no passado continua abortando (guard preservado);
 * `sendNow` que recebe 2xx mas cujo GET não mostra status terminal falha em
 * vez de declarar sucesso.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { brevoSendNow, isTerminalSendStatus, describeUncertainSendStatus } from "../scripts/lib/brevo-client.ts";
import {
  applySendNowVerifyResults,
  resolveScheduleAtArg,
  resolveContentCycle,
  type CampaignEntry,
} from "../scripts/clarice-schedule-group.ts";

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: { cancel: async () => {} },
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// isTerminalSendStatus
// ---------------------------------------------------------------------------

test("isTerminalSendStatus: 'sent' e 'inProcess' são terminais; 'draft'/'queued'/'scheduled' não são", () => {
  assert.equal(isTerminalSendStatus("sent"), true);
  assert.equal(isTerminalSendStatus("inProcess"), true);
  assert.equal(isTerminalSendStatus("draft"), false);
  assert.equal(isTerminalSendStatus("queued"), false);
  assert.equal(isTerminalSendStatus("scheduled"), false);
});

test("REGRESSÃO (#5050): isTerminalSendStatus('in_process') [snake_case] também é terminal — valor real observado ao vivo da Brevo pra campanha CONFIRMADAMENTE enviada (#132, 260811)", () => {
  assert.equal(isTerminalSendStatus("in_process"), true);
});

// ---------------------------------------------------------------------------
// describeUncertainSendStatus (#4364) — mensagem específica pra 'in_review'
// ---------------------------------------------------------------------------

test("REGRESSÃO (#4364): describeUncertainSendStatus('in_review') nomeia o estado real, não o genérico", () => {
  const msg = describeUncertainSendStatus("in_review");
  assert.match(msg, /revisão da própria Brevo/);
  assert.match(msg, /app\.brevo\.com/);
  assert.doesNotMatch(msg, /reconsulte a Brevo manualmente/);
});

test("describeUncertainSendStatus: status desconhecido cai no genérico (não confunde com in_review nem queued)", () => {
  const msg = describeUncertainSendStatus("expired");
  assert.match(msg, /reconsulte a Brevo manualmente/);
  assert.doesNotMatch(msg, /revisão da própria Brevo/);
});

test("REGRESSÃO (#4718 item 3): describeUncertainSendStatus('queued') orienta reconsultar, NÃO re-disparar", () => {
  const msg = describeUncertainSendStatus("queued");
  assert.match(msg, /ACEITOU o disparo/);
  assert.match(msg, /NÃO re-dispare/);
  assert.doesNotMatch(msg, /reconsulte a Brevo manualmente\./);
});

// ---------------------------------------------------------------------------
// brevoSendNow — POST /emailCampaigns/{id}/sendNow
// ---------------------------------------------------------------------------

test("brevoSendNow: POST na URL certa com método correto; 2xx resolve sem lançar", async () => {
  const orig = globalThis.fetch;
  let calledUrl = "";
  let calledMethod = "";
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calledUrl = String(url);
    calledMethod = init?.method ?? "";
    return jsonRes(204, {});
  }) as typeof fetch;
  try {
    await brevoSendNow("sk_test", 42);
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(calledUrl, "https://api.brevo.com/v3/emailCampaigns/42/sendNow");
  assert.equal(calledMethod, "POST");
});

test("brevoSendNow: status não-2xx lança erro descritivo", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => jsonRes(404, { message: "not found" })) as typeof fetch;
  try {
    await assert.rejects(() => brevoSendNow("sk_test", 999), /sendNow falhou \(404\)/);
  } finally {
    globalThis.fetch = orig;
  }
});

// ---------------------------------------------------------------------------
// applySendNowVerifyResults — NUNCA confia só no 2xx do POST
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<CampaignEntry> = {}): CampaignEntry {
  return { key: "novos-260730", campaignId: 1, listId: 10, subject: "Assunto", status: "draft", ...overrides };
}

test("applySendNowVerifyResults: GET confirma status terminal ('sent') → marca sucesso e persiste", () => {
  const c = makeEntry();
  const campaigns = [c];
  let written: string | undefined;
  const logs: string[] = [];
  applySendNowVerifyResults(
    [{ status: "fulfilled", value: { status: "sent" } }],
    [c],
    campaigns,
    "/fake/path.json",
    (_p, content) => { written = content; },
    (m) => logs.push(m),
  );
  assert.equal(c.status, "sent");
  assert.ok(written && JSON.parse(written)[0].status === "sent");
  assert.ok(logs.some((l) => /disparada AGORA/.test(l)));
});

test("REGRESSÃO (#4347): 2xx do POST mas GET NÃO mostra status terminal — falha (status NÃO muda, nada é persistido)", () => {
  const c = makeEntry();
  const campaigns = [c];
  let writeCalled = false;
  const logs: string[] = [];
  applySendNowVerifyResults(
    [{ status: "fulfilled", value: { status: "draft" } }], // POST foi 2xx, mas GET ainda mostra draft
    [c],
    campaigns,
    "/fake/path.json",
    () => { writeCalled = true; },
    (m) => logs.push(m),
  );
  assert.equal(c.status, "draft", "status NÃO deve ser marcado como sucesso");
  assert.equal(writeCalled, false, "nada deve ser persistido quando o GET não confirma status terminal");
  assert.ok(logs.some((l) => /não é suficiente/.test(l)));
});

test("REGRESSÃO (#4364): GET-verify retorna 'in_review' — log nomeia o status real da Brevo, não só o genérico", () => {
  const c = makeEntry();
  const campaigns = [c];
  const logs: string[] = [];
  applySendNowVerifyResults(
    [{ status: "fulfilled", value: { status: "in_review" } }],
    [c],
    campaigns,
    "/fake/path.json",
    () => {},
    (m) => logs.push(m),
  );
  assert.equal(c.status, "draft", "status NÃO deve ser marcado como sucesso pra in_review");
  assert.ok(logs.some((l) => /revisão da própria Brevo/.test(l)));
  assert.ok(logs.some((l) => /não é suficiente/.test(l)));
});

test("applySendNowVerifyResults: GET rejeitado (falha de rede) — status NÃO muda, nada persistido, aviso claro", () => {
  const c = makeEntry();
  const campaigns = [c];
  let writeCalled = false;
  const logs: string[] = [];
  applySendNowVerifyResults(
    [{ status: "rejected", reason: new Error("timeout") }],
    [c],
    campaigns,
    "/fake/path.json",
    () => { writeCalled = true; },
    (m) => logs.push(m),
  );
  assert.equal(c.status, "draft");
  assert.equal(writeCalled, false);
  assert.ok(logs.some((l) => /falhou/.test(l)));
});

test("applySendNowVerifyResults: invariante settled.length !== toVerify.length lança", () => {
  assert.throws(() =>
    applySendNowVerifyResults([], [makeEntry()], [makeEntry()], "/fake/path.json", () => {}, () => {}),
  );
});

// ---------------------------------------------------------------------------
// resolveScheduleAtArg — --create sem --schedule-at / com data passada
// ---------------------------------------------------------------------------

test("resolveScheduleAtArg: ausente → { scheduledAt: undefined } (rascunho SEM data, destinado a --send-now)", () => {
  const result = resolveScheduleAtArg(undefined);
  assert.deepEqual(result, { scheduledAt: undefined });
});

test("resolveScheduleAtArg: data no FUTURO → ISO normalizado", () => {
  // #7042: offset > SCHEDULE_AT_MIN_LEAD_MS (2h) — 1h já não basta mais
  // desde a antecedência mínima; este teste cobre só a normalização ISO.
  const future = new Date(Date.now() + 3 * 3600_000).toISOString();
  const result = resolveScheduleAtArg(future) as { scheduledAt: string };
  assert.equal(result.scheduledAt, new Date(future).toISOString());
});

test("REGRESSÃO (#4347): data no PASSADO continua abortando — guard não regride", () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  const result = resolveScheduleAtArg(past);
  assert.ok("error" in result, "deve retornar erro pra data no passado");
  assert.match((result as { error: string }).error, /deve estar no futuro/);
});

test("resolveScheduleAtArg: ISO inválido → erro claro", () => {
  const result = resolveScheduleAtArg("não-é-uma-data");
  assert.ok("error" in result);
  assert.match((result as { error: string }).error, /não é ISO 8601 válido/);
});

// ---------------------------------------------------------------------------
// resolveContentCycle (#4347 review) — --cycle (segments/campanha) pode
// divergir de --content-cycle (HTML/gabarito É IA?) quando a skill
// /diaria-clarice-novos cai (D3) num ciclo mensal ANTERIOR ao ciclo Clarice
// corrente de contatos.
// ---------------------------------------------------------------------------

test("resolveContentCycle: sem --content-cycle -> usa o --cycle de segments (comportamento original, todo caller pré-#4347)", () => {
  assert.equal(resolveContentCycle([], "2606-07"), "2606-07");
  assert.equal(resolveContentCycle(["--cycle", "2606-07"], "2606-07"), "2606-07");
});

test("REGRESSÃO (#4347): --content-cycle explícito DIVERGE de --cycle — vence pro HTML/gabarito É IA?", () => {
  assert.equal(
    resolveContentCycle(["--cycle", "2607-08", "--content-cycle", "2605-06"], "2607-08"),
    "2605-06",
  );
});
