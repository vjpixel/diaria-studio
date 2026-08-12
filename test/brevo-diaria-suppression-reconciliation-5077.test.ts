/**
 * test/brevo-diaria-suppression-reconciliation-5077.test.ts (#5077)
 *
 * Regressão do bug: `evaluate-brevo-diaria.ts --push` suprime um contato
 * (`status: "suppressed"`, `resolution_reason: "score_threshold"`) e NUNCA
 * mais o reavalia (`runEvaluation` só itera `status === "in_brevo"`). Se a
 * pessoa depois clica num link de reativação de uma campanha ANTIGA ainda
 * parada na caixa de entrada (via `workers/reativar/`, que ativa a
 * subscription Beehiiv diretamente, sem checar este store), a Beehiiv fica
 * corretamente `active` — mas o store local continua contando a história
 * ERRADA ("suprimido por engajamento baixo"), quando na verdade é uma
 * confirmação tardia bem-sucedida.
 *
 * Caso concreto da issue: `felipeaparecida918@gmail.com` — suprimido
 * 2026-08-10 00:18 BRT, clicou 14:15 BRT do MESMO DIA numa campanha enviada
 * 3 dias antes.
 *
 * Cobre: (1) a transição pura no store (`applySuppressionReconciliation`),
 * (2) a seleção de candidatos (`selectSuppressionReconciliationCandidates`)
 * e (3) a orquestração fim-a-fim com fetch mockado
 * (`runSuppressionReconciliation`) — reproduzindo o cenário exato da issue
 * em dry-run E em --push, confirmando que `status` NUNCA reverte.
 *
 * NUNCA chama a API Beehiiv real — `globalThis.fetch`/`fetchImpl` sempre
 * mockado, mesmo padrão de `test/evaluate-brevo-diaria-4266.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applySuppressionReconciliation,
  findContact,
  type BrevoDiariaContact,
  type BrevoDiariaStore,
} from "../scripts/lib/brevo-diaria-store.ts";
import {
  DEFAULT_LOOKBACK_DAYS,
  selectSuppressionReconciliationCandidates,
  runSuppressionReconciliation,
} from "../scripts/reconcile-brevo-diaria-suppressions.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fixture — contato mínimo do store, com overrides pontuais por teste. */
function contact(email: string, overrides: Partial<BrevoDiariaContact> = {}): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: `sub_${email}`,
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: "2026-07-01T00:00:00.000Z",
    last_evaluated_at: null,
    ...overrides,
  };
}

function storeOf(contacts: BrevoDiariaContact[]): BrevoDiariaStore {
  return { contacts };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── applySuppressionReconciliation — transição pura no store ──────────────

describe("applySuppressionReconciliation — corrige resolution_reason SEM reverter status (#5077)", () => {
  it("caso da issue: suppressed/score_threshold + status Beehiiv active → resolution_reason vira self_confirmed_after_suppression, status permanece suppressed", () => {
    const store = storeOf([
      contact("felipeaparecida918@gmail.com", {
        status: "suppressed",
        resolution_reason: "score_threshold",
        suppressed_at: "2026-08-10T03:18:14.000Z", // 00:18 BRT
        last_open_rate: 0.2,
        opens_count: 1,
        sends_count: 5,
      }),
    ]);
    const result = applySuppressionReconciliation(store, "felipeaparecida918@gmail.com", "2026-08-11T12:00:00.000Z");
    const updated = findContact(result, "felipeaparecida918@gmail.com")!;
    assert.equal(updated.status, "suppressed", "NUNCA reverte status — o contato não deve voltar a receber e-mails deste canal");
    assert.equal(updated.resolution_reason, "self_confirmed_after_suppression");
    assert.equal(updated.reconciled_at, "2026-08-11T12:00:00.000Z");
    assert.equal(updated.suppressed_at, "2026-08-10T03:18:14.000Z", "suppressed_at original é preservado — não é a mesma data da correção");
  });

  it("preserva todos os outros campos do contato (contadores, added_at, beehiiv_subscription_id)", () => {
    const store = storeOf([
      contact("x@a.com", {
        status: "suppressed",
        resolution_reason: "score_threshold",
        suppressed_at: "2026-08-10T00:00:00.000Z",
        opens_count: 1,
        sends_count: 5,
        last_open_rate: 0.2,
        beehiiv_subscription_id: "sub_original",
      }),
    ]);
    const updated = findContact(applySuppressionReconciliation(store, "x@a.com"), "x@a.com")!;
    assert.equal(updated.opens_count, 1);
    assert.equal(updated.sends_count, 5);
    assert.equal(updated.last_open_rate, 0.2);
    assert.equal(updated.beehiiv_subscription_id, "sub_original");
  });

  it("contato ainda in_brevo (nunca suprimido) → noop, não transiciona", () => {
    const store = storeOf([contact("keep@a.com", { status: "in_brevo" })]);
    const result = applySuppressionReconciliation(store, "keep@a.com");
    assert.equal(findContact(result, "keep@a.com")!.status, "in_brevo");
    assert.equal(findContact(result, "keep@a.com")!.resolution_reason, undefined);
  });

  it("suprimido por native_unsubscribe (não score_threshold) → noop, guard de motivo é estrito", () => {
    const store = storeOf([
      contact("native@a.com", { status: "unsubscribed", resolution_reason: "native_unsubscribe" }),
    ]);
    const result = applySuppressionReconciliation(store, "native@a.com");
    assert.equal(findContact(result, "native@a.com")!.resolution_reason, "native_unsubscribe", "motivo não relacionado a score_threshold nunca é tocado");
  });

  it("idempotente — chamar 2x no mesmo contato já reconciliado não repete a transição (2ª chamada é noop)", () => {
    const store = storeOf([
      contact("dup@a.com", { status: "suppressed", resolution_reason: "score_threshold", suppressed_at: "2026-08-10T00:00:00.000Z" }),
    ]);
    const once = applySuppressionReconciliation(store, "dup@a.com", "2026-08-11T00:00:00.000Z");
    const twice = applySuppressionReconciliation(once, "dup@a.com", "2026-08-12T00:00:00.000Z");
    const updated = findContact(twice, "dup@a.com")!;
    assert.equal(updated.reconciled_at, "2026-08-11T00:00:00.000Z", "2ª chamada não deveria ter efeito — resolution_reason já não bate mais com score_threshold");
  });

  it("email desconhecido → store inalterado, nenhum crash", () => {
    const store = storeOf([contact("a@x.com", { status: "suppressed", resolution_reason: "score_threshold" })]);
    const result = applySuppressionReconciliation(store, "desconhecido@x.com");
    assert.deepEqual(result, store);
  });
});

// ── selectSuppressionReconciliationCandidates ──────────────────────────────

describe("selectSuppressionReconciliationCandidates — janela de recência + override por e-mail (#5077)", () => {
  const nowMs = Date.parse("2026-08-12T00:00:00.000Z");

  it("suppressed/score_threshold DENTRO da janela padrão → candidato", () => {
    const store = storeOf([
      contact("recent@a.com", { status: "suppressed", resolution_reason: "score_threshold", suppressed_at: "2026-08-10T00:00:00.000Z" }),
    ]);
    const candidates = selectSuppressionReconciliationCandidates(store, { nowMs });
    assert.deepEqual(candidates.map((c) => c.email), ["recent@a.com"]);
  });

  it("suppressed/score_threshold FORA da janela padrão (>30 dias) → excluído", () => {
    const store = storeOf([
      contact("old@a.com", {
        status: "suppressed",
        resolution_reason: "score_threshold",
        suppressed_at: new Date(nowMs - (DEFAULT_LOOKBACK_DAYS + 1) * DAY_MS).toISOString(),
      }),
    ]);
    const candidates = selectSuppressionReconciliationCandidates(store, { nowMs });
    assert.deepEqual(candidates, []);
  });

  it("--days customizado estreita/alarga a janela", () => {
    const store = storeOf([
      contact("mid@a.com", { status: "suppressed", resolution_reason: "score_threshold", suppressed_at: new Date(nowMs - 10 * DAY_MS).toISOString() }),
    ]);
    assert.deepEqual(selectSuppressionReconciliationCandidates(store, { nowMs, lookbackDays: 5 }), [], "5 dias é menor que os 10 dias de idade — excluído");
    assert.equal(selectSuppressionReconciliationCandidates(store, { nowMs, lookbackDays: 15 }).length, 1, "15 dias cobre os 10 dias de idade — incluído");
  });

  it("status != suppressed → nunca candidato, mesmo com resolution_reason score_threshold (defensivo)", () => {
    const store = storeOf([contact("wrong-status@a.com", { status: "in_brevo", resolution_reason: "score_threshold" })]);
    assert.deepEqual(selectSuppressionReconciliationCandidates(store, { nowMs }), []);
  });

  it("resolution_reason != score_threshold → nunca candidato (native_unsubscribe/self_confirmed_beehiiv já são saídas corretas)", () => {
    const store = storeOf([
      contact("native@a.com", { status: "unsubscribed", resolution_reason: "native_unsubscribe" }),
      contact("self-confirmed@a.com", { status: "promoted_beehiiv", resolution_reason: "self_confirmed_beehiiv" }),
    ]);
    assert.deepEqual(selectSuppressionReconciliationCandidates(store, { nowMs }), []);
  });

  it("já reconciliado (self_confirmed_after_suppression) → não é candidato de novo (evita reprocessar o mesmo contato pra sempre)", () => {
    const store = storeOf([
      contact("already@a.com", {
        status: "suppressed",
        resolution_reason: "self_confirmed_after_suppression",
        suppressed_at: "2026-08-10T00:00:00.000Z",
        reconciled_at: "2026-08-11T00:00:00.000Z",
      }),
    ]);
    assert.deepEqual(selectSuppressionReconciliationCandidates(store, { nowMs }), []);
  });

  it("suppressed_at ausente → nunca candidato por recência (fail-safe)", () => {
    const store = storeOf([contact("no-timestamp@a.com", { status: "suppressed", resolution_reason: "score_threshold", suppressed_at: undefined })]);
    assert.deepEqual(selectSuppressionReconciliationCandidates(store, { nowMs }), []);
  });

  it("--email mira exatamente 1 contato IGNORANDO a janela de recência — mesmo suprimido há muito tempo", () => {
    const store = storeOf([
      contact("felipeaparecida918@gmail.com", {
        status: "suppressed",
        resolution_reason: "score_threshold",
        suppressed_at: new Date(nowMs - 400 * DAY_MS).toISOString(), // bem fora da janela padrão
      }),
      contact("other@a.com", { status: "suppressed", resolution_reason: "score_threshold", suppressed_at: "2026-08-10T00:00:00.000Z" }),
    ]);
    const candidates = selectSuppressionReconciliationCandidates(store, { nowMs, email: "felipeaparecida918@gmail.com" });
    assert.deepEqual(candidates.map((c) => c.email), ["felipeaparecida918@gmail.com"], "--email seleciona só o alvo, ignora o outro suprimido dentro da janela");
  });

  it("--email normaliza case/trim antes de comparar", () => {
    const store = storeOf([contact("felipeaparecida918@gmail.com", { status: "suppressed", resolution_reason: "score_threshold" })]);
    const candidates = selectSuppressionReconciliationCandidates(store, { nowMs, email: "  Felipeaparecida918@Gmail.COM  " });
    assert.deepEqual(candidates.map((c) => c.email), ["felipeaparecida918@gmail.com"]);
  });

  it("--email de contato que não é suppressed/score_threshold → nenhum candidato (guard vale mesmo com email explícito)", () => {
    const store = storeOf([contact("active@a.com", { status: "in_brevo" })]);
    assert.deepEqual(selectSuppressionReconciliationCandidates(store, { nowMs, email: "active@a.com" }), []);
  });
});

// ── runSuppressionReconciliation — orquestração fim-a-fim, fetch mockado ──

describe("runSuppressionReconciliation — reproduz o cenário exato da issue #5077", () => {
  it("dry-run: contato suppressed com status Beehiiv agora active → reconciled=1, store retornado NÃO tem a correção aplicada (push=false)", async () => {
    const store = storeOf([
      contact("felipeaparecida918@gmail.com", {
        status: "suppressed",
        resolution_reason: "score_threshold",
        suppressed_at: "2026-08-10T03:18:14.000Z",
      }),
    ]);
    const candidates = selectSuppressionReconciliationCandidates(store, { nowMs: Date.parse("2026-08-12T00:00:00.000Z") });
    const logs: string[] = [];
    const fetchImpl = (async () => jsonRes(200, { data: { status: "active" } })) as typeof fetch;

    const result = await runSuppressionReconciliation({
      contacts: candidates,
      store,
      publicationId: "pub_1",
      beehiivApiKey: "key_1",
      push: false,
      log: (m) => logs.push(m),
      fetchImpl,
    });

    assert.equal(result.checked, 1);
    assert.equal(result.reconciled, 1);
    assert.equal(result.failed, 0);
    assert.equal(
      findContact(result.store, "felipeaparecida918@gmail.com")!.resolution_reason,
      "score_threshold",
      "dry-run nunca muta o store — resolution_reason continua o original até --push",
    );
    assert.ok(logs.some((l) => l.includes("confirmação tardia") && l.includes("SERIA corrigido")));
  });

  it("--push: mesmo cenário → store retornado JÁ tem resolution_reason corrigido, status continua suppressed", async () => {
    const store = storeOf([
      contact("felipeaparecida918@gmail.com", {
        status: "suppressed",
        resolution_reason: "score_threshold",
        suppressed_at: "2026-08-10T03:18:14.000Z",
      }),
    ]);
    const candidates = selectSuppressionReconciliationCandidates(store, { nowMs: Date.parse("2026-08-12T00:00:00.000Z") });
    const fetchImpl = (async () => jsonRes(200, { data: { status: "active" } })) as typeof fetch;

    const result = await runSuppressionReconciliation({
      contacts: candidates,
      store,
      publicationId: "pub_1",
      beehiivApiKey: "key_1",
      push: true,
      log: () => {},
      fetchImpl,
    });

    const updated = findContact(result.store, "felipeaparecida918@gmail.com")!;
    assert.equal(result.reconciled, 1);
    assert.equal(updated.status, "suppressed", "--push NUNCA reverte status — a pessoa não deve voltar a receber e-mails deste canal");
    assert.equal(updated.resolution_reason, "self_confirmed_after_suppression");
    assert.ok(updated.reconciled_at, "reconciled_at deve ser gravado na correção");
  });

  it("status Beehiiv NÃO active (ex: ainda pending) → nada reconciliado, store inalterado", async () => {
    const store = storeOf([contact("still-pending@a.com", { status: "suppressed", resolution_reason: "score_threshold", suppressed_at: "2026-08-10T00:00:00.000Z" })]);
    const candidates = selectSuppressionReconciliationCandidates(store, { nowMs: Date.parse("2026-08-12T00:00:00.000Z") });
    const fetchImpl = (async () => jsonRes(200, { data: { status: "pending" } })) as typeof fetch;

    const result = await runSuppressionReconciliation({
      contacts: candidates,
      store,
      publicationId: "pub_1",
      beehiivApiKey: "key_1",
      push: true,
      log: () => {},
      fetchImpl,
    });

    assert.equal(result.reconciled, 0);
    assert.equal(findContact(result.store, "still-pending@a.com")!.resolution_reason, "score_threshold", "supressão continua consistente — nada a corrigir");
  });

  it("status Beehiiv 404 (nenhum registro) → tratado como não-active, sem reconciliar, sem falha", async () => {
    const store = storeOf([contact("gone@a.com", { status: "suppressed", resolution_reason: "score_threshold", suppressed_at: "2026-08-10T00:00:00.000Z" })]);
    const candidates = selectSuppressionReconciliationCandidates(store, { nowMs: Date.parse("2026-08-12T00:00:00.000Z") });
    const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;

    const result = await runSuppressionReconciliation({
      contacts: candidates,
      store,
      publicationId: "pub_1",
      beehiivApiKey: "key_1",
      push: true,
      log: () => {},
      fetchImpl,
    });

    assert.equal(result.reconciled, 0);
    assert.equal(result.failed, 0);
  });

  it("falha transitória de API (5xx) num contato → conta em failed, NUNCA aborta os demais contatos do lote", async () => {
    const store = storeOf([
      contact("fails@a.com", { status: "suppressed", resolution_reason: "score_threshold", suppressed_at: "2026-08-10T00:00:00.000Z" }),
      contact("ok@a.com", { status: "suppressed", resolution_reason: "score_threshold", suppressed_at: "2026-08-10T00:00:00.000Z" }),
    ]);
    const candidates = selectSuppressionReconciliationCandidates(store, { nowMs: Date.parse("2026-08-12T00:00:00.000Z") });
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes("fails%40a.com")) return new Response("boom", { status: 500 });
      return jsonRes(200, { data: { status: "active" } });
    }) as typeof fetch;

    const result = await runSuppressionReconciliation({
      contacts: candidates,
      store,
      publicationId: "pub_1",
      beehiivApiKey: "key_1",
      push: true,
      log: () => {},
      fetchImpl,
    });

    assert.equal(result.checked, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.reconciled, 1, "o contato que falhou não impede o outro de ser reconciliado normalmente");
    assert.equal(findContact(result.store, "ok@a.com")!.resolution_reason, "self_confirmed_after_suppression");
    assert.equal(findContact(result.store, "fails@a.com")!.resolution_reason, "score_threshold", "contato que falhou fica intocado — retentado numa próxima rodada");
  });

  it("lista de candidatos vazia → checked/reconciled/failed todos 0, store devolvido é o mesmo objeto de entrada", async () => {
    const store = storeOf([]);
    const result = await runSuppressionReconciliation({
      contacts: [],
      store,
      publicationId: "pub_1",
      beehiivApiKey: "key_1",
      push: true,
      log: () => {},
    });
    assert.equal(result.checked, 0);
    assert.equal(result.reconciled, 0);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.store, store);
  });
});
