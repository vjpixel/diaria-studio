/**
 * test/onboarding-kit-robustez-10616-10620-10610.test.ts
 *
 * Regressões do lote `onboarding-kit-robustez`:
 *
 * - #10616: o refresh diário de ~390 cadastros que nunca confirmaram gerava
 *   429 no Kit, e 5 refreshes falhos marcaram a 1ª rodada real como FALHA no
 *   alarme. Agora (a) quem aguarda confirmação há > 30 dias é consultado 1×
 *   por semana, não todo dia; (b) erro transitório (429/5xx/rede) ganha uma
 *   passada de retry na rodada antes de contar em `refresh_failed`.
 * - #10620: stats de abertura não LIDOS (refresh falho, 429 na leitura de
 *   stats) viravam `stats_ausentes` → `skipped_sem_dados` terminal depois da
 *   janela de tolerância. Agora ficam pendentes (retentáveis).
 * - #10610: rascunho órfão de lote `schedule_failed` (DELETE retentado,
 *   conta como falha enquanto existir); lote `created` em rascunho marcado
 *   `schedule_failed` no `--reconcile` só-leitura (rollback); cohort de
 *   e-mail 3 nunca mistura donos; excluída do lote de e-mail 3 por status
 *   lido ≠ active vira `skipped_inactive`; entrada nascida no Kit não é
 *   excluída como `sem_kit_subscriber_id`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRunPlan,
  selectCandidatesNeedingRefresh,
  isStaleUnconfirmed,
  isWeeklyRefreshSlot,
  parseOnboardingSnippet,
} from "../scripts/lib/onboarding-state.ts";
import {
  refreshKitCandidates,
  isFailedKitSendRun,
  selectEligibleKitRecipients,
  selectEmail3InactiveExclusions,
  countKitContentSkips,
  LOT_STALE_AFTER_MS,
  type KitRefreshDiag,
  type KitRefreshOutcome,
  type KitSendRunRecord,
  type OnboardingKitLot,
} from "../scripts/lib/onboarding-kit-transport.ts";
import { reconcileOpenLots, shouldMarkStaleDraftScheduleFailed } from "../scripts/onboarding-kit-transport-run.ts";
import { fetchSubscriptionByIdKit, isKitTransientError } from "../scripts/onboarding-welcome-run.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";
import { kitIdForEntry } from "../scripts/lib/onboarding-followup.ts";
import type { OnboardingEntry, OnboardingStore } from "../scripts/lib/onboarding-store.ts";

const DAY = 86_400;
const T0 = 1_760_000_000;

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function entry(over: Partial<OnboardingEntry> = {}): OnboardingEntry {
  return {
    subscription_id: "1001",
    email: "a@example.com",
    status_detectado: "inactive",
    created_at: T0,
    detected_at: iso(T0),
    email1_sent_at: null,
    email1_brevo_id: null,
    email2_sent_at: null,
    email2_brevo_id: null,
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
    ...over,
  };
}

const noSleep = async () => {};

// ---------------------------------------------------------------------------
// #10616 — refresh espaçado das entradas paradas
// ---------------------------------------------------------------------------

describe("#10616 — inativa que nunca confirmou há > 30 dias sai do refresh diário", () => {
  it("> 30 dias: só entra no refresh no dia da semana dela (1 de 7 dias)", () => {
    const e = entry({ subscription_id: "77", detected_at: iso(T0) });
    const days: number[] = [];
    for (let d = 40; d < 47; d++) {
      const now = T0 + d * DAY;
      if (selectCandidatesNeedingRefresh([e], now, 3, 10).length === 1) days.push(d);
    }
    assert.equal(days.length, 1, `esperado 1 dia por semana, veio ${days.join(",")}`);
    assert.ok(isWeeklyRefreshSlot("77", T0 + days[0] * DAY));
  });

  it("<= 30 dias: refresh diário mantido (a pessoa ainda pode estar confirmando)", () => {
    const e = entry({ detected_at: iso(T0) });
    for (let d = 0; d <= 30; d++) {
      assert.equal(selectCandidatesNeedingRefresh([e], T0 + d * DAY, 3, 10).length, 1, `dia ${d}`);
    }
  });

  it("entrada parada fora do slot NÃO entra (é o cenário da issue: 192 de 387 candidatos)", () => {
    const e = entry({ subscription_id: "88", detected_at: iso(T0) });
    let now = T0 + 40 * DAY;
    while (isWeeklyRefreshSlot("88", now)) now += DAY;
    assert.equal(selectCandidatesNeedingRefresh([e], now, 3, 10).length, 0);
  });

  it("o espaçamento não toca quem já confirmou (e-mail 2/3 devidos seguem diários)", () => {
    const e = entry({ status_detectado: "active", detected_at: iso(T0), email1_sent_at: iso(T0) });
    let now = T0 + 40 * DAY;
    while (isWeeklyRefreshSlot(e.subscription_id, now)) now += DAY;
    assert.equal(selectCandidatesNeedingRefresh([e], now, 3, 10).length, 1);
  });

  it("detected_at ilegível → não é 'parada' (fail-safe: segue diário)", () => {
    assert.equal(isStaleUnconfirmed(entry({ detected_at: "lixo" }), T0 + 400 * DAY), false);
  });

  it("os slots se espalham pela semana (não concentram o volume num dia só)", () => {
    const slots = new Set<number>();
    for (let i = 0; i < 200; i++) {
      for (let d = 0; d < 7; d++) {
        if (isWeeklyRefreshSlot(String(100000 + i), T0 + d * DAY)) slots.add(d);
      }
    }
    assert.equal(slots.size, 7);
  });
});

// ---------------------------------------------------------------------------
// #10616 — retry da rodada antes de contar refresh_failed
// ---------------------------------------------------------------------------

describe("#10616 — refreshKitCandidates: retry na rodada", () => {
  const ok: KitRefreshOutcome = { status: "active", stats: { total_unique_opened: 2 } };

  it("429 transitório na 1ª passada que passa no retry NÃO conta como falha", async () => {
    const calls = new Map<string, number>();
    const sleeps: number[] = [];
    const res = await refreshKitCandidates(
      [{ subscription_id: "a" }, { subscription_id: "b" }],
      async (e, diag: KitRefreshDiag) => {
        const n = (calls.get(e.subscription_id) ?? 0) + 1;
        calls.set(e.subscription_id, n);
        if (e.subscription_id === "b" && n === 1) {
          diag.transportError = true;
          diag.transient = true;
          return null;
        }
        return ok;
      },
      { sleep: async (ms) => void sleeps.push(ms), spacingMs: 5, retryDelayMs: 1000 },
    );
    assert.equal(res.transportFailed, 0);
    assert.equal(res.failed.size, 0);
    assert.equal(res.retried, 1);
    assert.equal(calls.get("b"), 2);
    assert.ok(sleeps.includes(1000), "cooldown antes do retry");
    // E a rodada NÃO entra como falha no alarme.
    const run: KitSendRunRecord = {
      at: iso(T0), lots_created: 0, lots_failed: 0, lots_unverified: 0, blocked_concurrent: 0,
      refresh_candidates: 2, refresh_failed: res.transportFailed, content_skipped: 0,
    };
    assert.equal(isFailedKitSendRun(run), false);
  });

  it("429 persistente depois do retry conta (e entra em statsUnavailable)", async () => {
    const res = await refreshKitCandidates(
      [{ subscription_id: "a" }],
      async (_e, diag) => {
        diag.transportError = true;
        diag.transient = true;
        return null;
      },
      { sleep: noSleep, retryPasses: 2 },
    );
    assert.equal(res.transportFailed, 1);
    assert.ok(res.failed.has("a"));
    assert.ok(res.statsUnavailable.has("a"));
  });

  it("401 (não transitório) não é retentado — conta na hora, sem cooldown", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const res = await refreshKitCandidates(
      [{ subscription_id: "a" }],
      async (_e, diag) => {
        n++;
        diag.transportError = true;
        diag.transient = false;
        return null;
      },
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    assert.equal(n, 1);
    assert.equal(sleeps.length, 0);
    assert.equal(res.transportFailed, 1);
  });

  it("404 (ausência real) não é retentado nem conta como transporte", async () => {
    const res = await refreshKitCandidates([{ subscription_id: "a" }], async () => null, { sleep: noSleep });
    assert.equal(res.transportFailed, 0);
    assert.ok(res.failed.has("a"));
    assert.equal(res.statsUnavailable.has("a"), false);
  });

  it("status ok + stats com 429 persistente → status usado, stats marcados indisponíveis", async () => {
    const res = await refreshKitCandidates(
      [{ subscription_id: "a" }],
      async (_e, diag) => {
        diag.statsTransportError = true;
        diag.transient = true;
        return { status: "active", stats: null };
      },
      { sleep: noSleep },
    );
    assert.equal(res.fresh.get("a")?.status, "active");
    assert.ok(res.statsUnavailable.has("a"));
    assert.equal(res.failed.has("a"), false);
  });

  it("espaça a 1ª passada (spacingMs entre consultas)", async () => {
    const sleeps: number[] = [];
    await refreshKitCandidates(
      [{ subscription_id: "a" }, { subscription_id: "b" }, { subscription_id: "c" }],
      async () => ok,
      { sleep: async (ms) => void sleeps.push(ms), spacingMs: 350 },
    );
    assert.deepEqual(sleeps, [350, 350]);
  });

  it("isKitTransientError: 429/5xx/rede sim; 401/403/404/422 não", () => {
    assert.equal(isKitTransientError(new KitApiError("/x", 429, "")), true);
    assert.equal(isKitTransientError(new KitApiError("/x", 503, "")), true);
    assert.equal(isKitTransientError(new Error("fetch failed")), true);
    assert.equal(isKitTransientError(new KitApiError("/x", 401, "")), false);
    assert.equal(isKitTransientError(new KitApiError("/x", 403, "")), false);
    assert.equal(isKitTransientError(new KitApiError("/x", 404, "")), false);
    assert.equal(isKitTransientError(new KitApiError("/x", 422, "")), false);
  });
});

// ---------------------------------------------------------------------------
// #10620 — stats não lidos nunca viram skipped_sem_dados
// ---------------------------------------------------------------------------

function snippet(n: number) {
  return parseOnboardingSnippet(`<!-- assunto: "assunto ${n}" preview_text: "preview ${n}" -->\nCorpo ${n}.\n`, n);
}

describe("#10620 — skipped_sem_dados só com leitura bem-sucedida", () => {
  const confirmedAt = T0;
  const pastGrace = confirmedAt + 25 * DAY; // D+10 + 10 de tolerância já passou

  function plan(statsUnavailable?: (e: OnboardingEntry) => boolean) {
    const e = entry({ status_detectado: "active", email1_sent_at: iso(confirmedAt), email2_sent_at: iso(confirmedAt + 3 * DAY) });
    const r = buildRunPlan({
      entries: [e],
      statsById: {},
      nowSec: pastGrace,
      email2Days: 3,
      email3Days: 10,
      email3GraceDays: 10,
      snippets: { 1: snippet(1), 2: snippet(2), 3: snippet(3) },
      ...(statsUnavailable ? { statsUnavailable } : {}),
    });
    return { e, r };
  }

  it("refresh/stats falhou nesta rodada → fica pending, com skip explícito (retentável)", () => {
    const { e, r } = plan(() => true);
    assert.equal(e.email3_state, "pending");
    assert.equal(e.email3_decided_at, null);
    assert.ok(r.skips.some((s) => s.etapa === "email3" && s.motivo === "stats_ausentes"));
  });

  it("leitura ok mas assinante sem dado, passada a tolerância → skipped_sem_dados (comportamento mantido)", () => {
    const { e } = plan(() => false);
    assert.equal(e.email3_state, "skipped_sem_dados");
  });

  it("sem o predicado (compat) → comportamento anterior", () => {
    const { e } = plan();
    assert.equal(e.email3_state, "skipped_sem_dados");
  });

  it("fetchSubscriptionByIdKit sinaliza statsTransportError quando só a leitura de stats falha", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/stats")) return new Response(JSON.stringify({ errors: ["x"] }), { status: 401 });
      return new Response(JSON.stringify({ subscriber: { id: 1001, state: "active", email_address: "a@example.com" } }), { status: 200 });
    }) as typeof fetch;
    try {
      const diag = { transportError: false, statsTransportError: false, transient: true };
      const res = await fetchSubscriptionByIdKit({ apiKey: "k" }, "1001", "a@example.com", diag);
      assert.equal(res?.status, "active");
      assert.equal(res?.stats, null);
      assert.equal(diag.statsTransportError, true);
      assert.equal(diag.transient, false, "401 não é transitório");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// #10610 — follow-ups do fleet review
// ---------------------------------------------------------------------------

function lot(over: Partial<OnboardingKitLot> = {}): OnboardingKitLot {
  return {
    lot_id: "email3-2026-10-01-01",
    kind: "email3",
    tag_name: "onboarding-email3-2026-10-01-01",
    tag_id: 1,
    broadcast_id: 555,
    recipient_subscription_ids: ["1001"],
    recipient_emails: ["a@example.com"],
    status: "created",
    created_at: iso(T0),
    send_at: null,
    last_reconciled_at: null,
    last_error: null,
    ...over,
  };
}

function storeWith(l: OnboardingKitLot, entries: Record<string, OnboardingEntry> = {}): OnboardingStore {
  return { entries, kit_transport: { lots: { [l.lot_id]: l } } } as unknown as OnboardingStore;
}

describe("#10610 item 1 — rascunho órfão de lote schedule_failed", () => {
  it("DELETE retentado com sucesso → lote cancelado, não conta como órfão", async () => {
    const l = lot({ schedule_failed: true, last_error: "DELETE falhou" });
    const store = storeWith(l);
    let deleted = 0;
    const r = await reconcileOpenLots(
      { storePath: "/nao-usado", store, persist: false, nowMs: T0 * 1000 + DAY * 1000 },
      { getBroadcast: async () => ({ status: "draft", send_at: null }), deleteBroadcast: async () => void deleted++ },
    );
    assert.equal(deleted, 1);
    assert.equal(r.orphanDrafts, 0);
    assert.equal(store.kit_transport!.lots[l.lot_id].status, "cancelled");
  });

  it("DELETE falha de novo → segue schedule_failed e CONTA como falha da rodada", async () => {
    const l = lot({ schedule_failed: true });
    const store = storeWith(l);
    const r = await reconcileOpenLots(
      { storePath: "/nao-usado", store, persist: false, nowMs: T0 * 1000 + DAY * 1000 },
      {
        getBroadcast: async () => ({ status: "draft", send_at: null }),
        deleteBroadcast: async () => {
          throw new Error("boom");
        },
      },
    );
    assert.equal(r.orphanDrafts, 1);
    assert.equal(store.kit_transport!.lots[l.lot_id].schedule_failed, true);
    const run: KitSendRunRecord = {
      at: iso(T0), lots_created: 0, lots_failed: 0, lots_unverified: 0, blocked_concurrent: 0,
      refresh_candidates: 0, refresh_failed: 0, content_skipped: 0, lots_orphan_draft: r.orphanDrafts,
    };
    assert.equal(isFailedKitSendRun(run), true);
  });

  it("sem deleteBroadcast (--reconcile só leitura) → nunca apaga nada", async () => {
    const l = lot({ schedule_failed: true });
    const store = storeWith(l);
    const r = await reconcileOpenLots(
      { storePath: "/nao-usado", store, persist: false, nowMs: T0 * 1000 + DAY * 1000 },
      { getBroadcast: async () => ({ status: "draft", send_at: null }) },
    );
    assert.equal(r.orphanDrafts, 0);
    assert.equal(store.kit_transport!.lots[l.lot_id].status, "created");
  });
});

describe("#10610 item 2 — rollback com lote ainda `created`", () => {
  it("--reconcile só-leitura: rascunho velho vira schedule_failed e a entrada volta a pending", async () => {
    const l = lot();
    const e = entry({ status_detectado: "active", email1_sent_at: iso(T0), email3_state: "campaign_created", email3_kit_lot_id: l.lot_id, email3_decided_at: iso(T0) });
    const store = storeWith(l, { "1001": e });
    await reconcileOpenLots(
      { storePath: "/nao-usado", store, persist: false, nowMs: T0 * 1000 + LOT_STALE_AFTER_MS + 60_000 },
      { getBroadcast: async () => ({ status: "draft", send_at: null }) },
    );
    assert.equal(store.kit_transport!.lots[l.lot_id].schedule_failed, true);
    assert.equal(store.entries["1001"].email3_state, "pending");
  });

  it("rascunho recente (< 15 min — --send concorrente pode estar agendando) NÃO é marcado", () => {
    assert.equal(shouldMarkStaleDraftScheduleFailed(lot(), "draft", T0 * 1000 + 60_000), false);
  });

  it("status remoto desconhecido/agendado NÃO marca", () => {
    const later = T0 * 1000 + LOT_STALE_AFTER_MS + 60_000;
    assert.equal(shouldMarkStaleDraftScheduleFailed(lot(), "scheduled", later), false);
    assert.equal(shouldMarkStaleDraftScheduleFailed(lot(), undefined, later), false);
    assert.equal(shouldMarkStaleDraftScheduleFailed(lot({ created_at: "lixo" }), "draft", later), false);
  });
});

describe("#10610 item 3 — cohort de e-mail 3 nunca mistura donos", () => {
  it("com ownsEmail3, o skip de conteúdo do cohort só carrega entrada do dono", () => {
    const kitE = entry({ subscription_id: "1", status_detectado: "active", email1_sent_at: iso(T0), email2_sent_at: iso(T0 + 3 * DAY), email1_transport: "kit" });
    const brevoE = entry({ subscription_id: "2", status_detectado: "active", email1_sent_at: iso(T0), email2_sent_at: iso(T0 + 3 * DAY), email1_transport: "brevo" });
    const r = buildRunPlan({
      entries: [brevoE, kitE],
      statsById: { "1": { total_unique_opened: 1 }, "2": { total_unique_opened: 1 } },
      nowSec: T0 + 12 * DAY,
      email2Days: 3,
      email3Days: 10,
      email3GraceDays: 10,
      snippets: { 1: snippet(1), 2: snippet(2), 3: null },
      ownsEmail3: (e) => e.email1_transport === "kit",
    });
    const s3 = r.skips.filter((s) => s.etapa === "email3");
    assert.equal(s3.length, 1);
    assert.equal(s3[0].entry.subscription_id, "1");
    assert.equal(brevoE.email3_state, "pending", "a entrada da Brevo não é decidida pelo executor Kit");
    assert.equal(countKitContentSkips(r.skips, () => true), 1);
  });
});

describe("#10610 item 4 — excluídas do lote de e-mail 3 contam em algum lugar", () => {
  it("status lido ≠ active → decisão terminal; consulta falha (null) → não (retenta)", () => {
    const { excluded } = selectEligibleKitRecipients([
      { subscription_id: "1", email: "a@x", kit_subscriber_id: 1, kit_state: "cancelled" },
      { subscription_id: "2", email: "b@x", kit_subscriber_id: 2, kit_state: null },
      { subscription_id: "3", email: "c@x", kit_subscriber_id: 3, kit_state: "active" },
      { subscription_id: "4", email: "d@x", kit_subscriber_id: 4, kit_state: "bounced", seeded_by: "#7665" },
    ]);
    assert.deepEqual(selectEmail3InactiveExclusions(excluded).map((c) => c.subscription_id), ["1"]);
  });

  it("entrada nascida no Kit (id numérico em subscription_id) tem id Kit — não cai em sem_kit_subscriber_id", () => {
    const e = entry({ subscription_id: "4242" });
    assert.equal(e.kit_subscriber_id, undefined);
    const { eligible, excluded } = selectEligibleKitRecipients([
      { subscription_id: e.subscription_id, email: e.email, kit_subscriber_id: kitIdForEntry(e), kit_state: "active" },
    ]);
    assert.equal(excluded.length, 0);
    assert.equal(eligible.length, 1);
  });

  it("fetchSubscriptionByIdKit devolve resolvedKitId também no caminho numérico", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/stats")) return new Response(JSON.stringify({ subscriber: { id: 4242, stats: { opened: 1 } } }), { status: 200 });
      return new Response(JSON.stringify({ subscriber: { id: 4242, state: "active", email_address: "a@example.com" } }), { status: 200 });
    }) as typeof fetch;
    try {
      const res = await fetchSubscriptionByIdKit({ apiKey: "k" }, "4242", "a@example.com");
      assert.equal(res?.resolvedKitId, 4242);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
