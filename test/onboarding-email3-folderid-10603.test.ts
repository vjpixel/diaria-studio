/**
 * test/onboarding-email3-folderid-10603.test.ts (#10603)
 *
 * Regressão: `ensureD10List` criava a lista do cohort D+10 com
 * `POST /contacts/lists {name}` sem `folderId`; a Brevo recusa
 * ("Folder id is missing") e o e-mail 3 nunca saiu (72 falhas, 15/09–20/10/2026).
 * Cobre: payload com folderId (config e resolução), backlog pós-janela descartado
 * (nunca enviado), streak/alarme de falha do e-mail 3 e o achado do alarme de continuidade.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureD10List } from "../scripts/onboarding-welcome-run.ts";
import {
  buildRunPlan,
  updateEmail3FailureStreak,
  email3FailureAlarm,
  EMAIL3_FAILURE_ALARM_THRESHOLD_RUNS,
  type OpenStats,
} from "../scripts/lib/onboarding-state.ts";
import type { OnboardingEntry } from "../scripts/lib/onboarding-store.ts";
import { evaluateContinuityRound, EMAIL3_CHECK } from "../scripts/onboarding-continuity-alarm.ts";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

function mockBrevo(calls: Call[], opts: { folders?: { id: number; name: string }[] } = {}) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    if (method === "GET" && url.includes("/contacts/lists")) return json(200, { lists: [] });
    if (method === "GET" && url.includes("/contacts/folders")) return json(200, { folders: opts.folders ?? [] });
    if (method === "POST" && url.endsWith("/contacts/folders")) return json(201, { id: 77 });
    if (method === "POST" && url.endsWith("/contacts/lists")) {
      return body?.folderId == null
        ? json(400, { code: "missing_parameter", message: "Folder id is missing" })
        : json(201, { id: 555 });
    }
    return json(404, {});
  }) as typeof fetch;
}

describe("ensureD10List — folderId obrigatório na criação da lista (#10603)", () => {
  it("usa d10_folder_id da config no payload", async () => {
    const calls: Call[] = [];
    mockBrevo(calls);
    const id = await ensureD10List({ apiKey: "k", listName: "Onboarding D10", folderId: 9 });
    assert.equal(id, 555);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/contacts/lists"));
    assert.deepEqual(post?.body, { name: "Onboarding D10", folderId: 9 });
  });

  it("sem config, resolve a pasta existente por nome", async () => {
    const calls: Call[] = [];
    mockBrevo(calls, { folders: [{ id: 31, name: "Onboarding" }] });
    await ensureD10List({ apiKey: "k", listName: "Onboarding D10" });
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/contacts/lists"));
    assert.equal(post?.body?.folderId, 31);
  });

  it("sem config e sem pasta, cria a pasta e usa o id devolvido", async () => {
    const calls: Call[] = [];
    mockBrevo(calls);
    await ensureD10List({ apiKey: "k", listName: "Onboarding D10" });
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/contacts/lists"));
    assert.equal(post?.body?.folderId, 77);
  });

  it("lista já existente é reusada sem criar nada", async () => {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input), body: null });
      return json(200, { lists: [{ id: 12, name: "Onboarding D10" }] });
    }) as typeof fetch;
    assert.equal(await ensureD10List({ apiKey: "k", listName: "Onboarding D10" }), 12);
    assert.ok(calls.every((c) => c.method === "GET"));
  });
});

const DAY = 86_400;
const T0 = 1_755_000_000;
const snippet = (n: 1 | 2 | 3) => ({ numero: n, assunto: "a", previewText: null, body: "<p>x</p>", hasPendingMarker: false });
const SNIPS = { 1: snippet(1), 2: snippet(2), 3: snippet(3) };
function entry(id: string, ageDays: number): OnboardingEntry {
  const sent = new Date((T0 - ageDays * DAY) * 1000).toISOString();
  return {
    subscription_id: id,
    email: `${id}@example.com`,
    status_detectado: "active",
    created_at: T0 - ageDays * DAY,
    detected_at: sent,
    email1_sent_at: sent,
    email1_brevo_id: null,
    email2_sent_at: sent,
    email2_brevo_id: null,
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
  };
}

describe("buildRunPlan — backlog pós-janela é descartado, nunca enviado (#10603)", () => {
  it("elegível dentro da janela entra no cohort; fora da janela vira skipped_backlog_descartado", () => {
    const dentro = entry("dentro", 11);
    const backlog = entry("backlog", 40);
    const stats: Record<string, OpenStats> = {
      dentro: { total_unique_opened: 2 } as OpenStats,
      backlog: { total_unique_opened: 5 } as OpenStats,
    };
    const plan = buildRunPlan({
      entries: [dentro, backlog],
      statsById: stats,
      nowSec: T0,
      email2Days: 3,
      email3Days: 10,
      email3GraceDays: 10,
      snippets: SNIPS,
    });
    const camp = plan.actions.find((a) => a.kind === "email3_campaign");
    assert.deepEqual(
      camp && camp.kind === "email3_campaign" ? camp.entries.map((e) => e.subscription_id) : [],
      ["dentro"],
    );
    assert.equal(backlog.email3_state, "skipped_backlog_descartado");
    assert.ok(backlog.email3_decided_at);
  });
});

describe("alarme de falha do e-mail 3 (#10603)", () => {
  it("streak incrementa na falha e zera no sucesso", () => {
    assert.equal(updateEmail3FailureStreak(0, true), 1);
    assert.equal(updateEmail3FailureStreak(4, true), 5);
    assert.equal(updateEmail3FailureStreak(4, false), 0);
  });

  it("alarme só no limiar e cita o último erro", () => {
    assert.equal(email3FailureAlarm(EMAIL3_FAILURE_ALARM_THRESHOLD_RUNS - 1, "x"), null);
    const msg = email3FailureAlarm(EMAIL3_FAILURE_ALARM_THRESHOLD_RUNS, "Folder id is missing");
    assert.match(msg ?? "", /Folder id is missing/);
  });

  it("alarme de continuidade emite achado do e-mail 3 com store lido; sem store lido não avalia", () => {
    const base = {
      consecutive_zero_detections: 0,
      last_zero_detection_run_at: new Date().toISOString(),
      kit_transport: { lots: {} },
      consecutive_email3_failures: 5,
      last_email3_error: "Folder id is missing",
    };
    const ruim = evaluateContinuityRound({ storeExists: true, corrupted: false, store: base, cfgRead: { enabled: false, error: null } });
    assert.ok(ruim.findings.some((f) => f.check === EMAIL3_CHECK));
    const ok = evaluateContinuityRound({
      storeExists: true,
      corrupted: false,
      store: { ...base, consecutive_email3_failures: 0 },
      cfgRead: { enabled: false, error: null },
    });
    assert.ok(!ok.findings.some((f) => f.check === EMAIL3_CHECK));
    assert.ok(ok.evaluatedChecks.has(EMAIL3_CHECK));
    const semStore = evaluateContinuityRound({ storeExists: false, corrupted: false, store: base, cfgRead: { enabled: false, error: null } });
    assert.ok(!semStore.evaluatedChecks.has(EMAIL3_CHECK));
  });
});
