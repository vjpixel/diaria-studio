/**
 * test/kit-sem-abertura-replacement-cap-10701.test.ts (#10701)
 *
 * Follow-ups do #10664/#10666:
 * - item 2: o teto de reposições do backlog não tinha teste do caso
 *   atingido. Atingido, a rodada deixa vagas vazias, avisa no log e marca
 *   `backlogReplacementCapHit` no resultado.
 * - item 3: cadastro NOVO pulado na confirmação (blacklisted na Brevo) não
 *   cedia a vaga. Com `--max-add` cortando o backlog, a rodada ficava abaixo
 *   do teto pedido pelo operador.
 * - item 1: precedência `native_complaint` sobre hard bounce, documentada em
 *   `nativeBounceReason`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runKitSemAberturaSync,
  type KitSemAberturaDeps,
  type KitSemAberturaPlatformConfig,
} from "../scripts/sync-kit-sem-abertura-to-brevo.ts";
import { nativeBlacklistExitReason, nativeBounceReason } from "../scripts/evaluate-brevo-diaria.ts";
import type { BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function cfg(cap: number): KitSemAberturaPlatformConfig {
  return {
    brevo_diaria: { api_key_env: "X", list_id: 7, daily_send_cap: cap, kit_sem_abertura: { enabled: true } },
    kit: { diaria_exclusion_segment: { enabled: true, segment_id: 99 } },
  };
}

/** Backlog b0 (mais antigo) .. b4, fora da janela de "novo". */
const BACKLOG = [0, 1, 2, 3, 4].map((i) => ({
  id: 100 + i,
  email: `b${i}@x.com`,
  created_at: new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * DAY).toISOString(),
  tagNames: [] as string[],
}));

/** Cadastro novo (dentro da janela default de 30 dias). */
const NOVO = { id: 900, email: "n0@x.com", created_at: new Date(NOW - 3 * DAY).toISOString(), tagNames: [] as string[] };

function deps(opts: {
  blacklisted: ReadonlySet<string>;
  withNovo?: boolean;
  maxBacklogReplacements?: number;
  initialStore?: BrevoDiariaStore;
}) {
  const calls: string[] = [];
  const lines: string[] = [];
  let store: BrevoDiariaStore = opts.initialStore ?? { contacts: [] };
  const people = opts.withNovo ? [NOVO, ...BACKLOG] : BACKLOG;
  const records = [1, 2, 3, 4, 5, 6].map((i) => ({ broadcastId: i, sentAt: new Date(NOW - (10 - i) * DAY).toISOString(), edition: `e${i}` }));
  const d: KitSemAberturaDeps = {
    nowMs: NOW,
    log: (m) => lines.push(m),
    readRegistry: () => records,
    listKitActive: async () => people.map((p) => ({ ...p })),
    fetchEngagement: async (id) => ({ broadcastId: id, delivered: people.map((p) => p.email), opens: ["leitor-fora-da-base@x.com"], clicks: [] }),
    findEnvioBrevoTagId: async () => 555,
    readStore: () => store,
    writeStore: (s) => {
      store = s;
    },
    rolloutPaused: () => false,
    transactionalOnSendDay: async () => 0,
    getApoioNivel: async () => null,
    isBrevoBlacklisted: async (email) => {
      calls.push(`check:${email}`);
      return opts.blacklisted.has(email);
    },
    ingestBrevo: async (email) => {
      calls.push(`brevo:${email}`);
    },
    tagKit: async () => {},
    untagKit: async () => {},
    appendLog: () => {},
    ...(opts.maxBacklogReplacements !== undefined ? { maxBacklogReplacements: opts.maxBacklogReplacements } : {}),
  };
  return { d, calls, lines };
}

const ingested = (calls: string[]) => calls.filter((c) => c.startsWith("brevo:")).map((c) => c.slice("brevo:".length));

describe("Kit→Brevo: teto de reposições do backlog atingido (#10701 item 2)", () => {
  it("teto 1 com 3 blacklisted na cabeça ⇒ 1 reposição, vaga vazia, aviso e flag no resultado", async () => {
    const { d, calls, lines } = deps({ blacklisted: new Set(["b0@x.com", "b1@x.com", "b2@x.com"]), maxBacklogReplacements: 1 });
    const r = await runKitSemAberturaSync(cfg(2), { push: true }, d);
    assert.equal(r.code, 0);
    assert.equal(r.moved, 0, "b0/b1 pulados, b2 (a única reposição) também blacklisted");
    assert.equal(r.skippedBlacklisted, 3);
    assert.equal(r.backlogReplacementCapHit, true);
    assert.ok(!calls.includes("check:b3@x.com"), "depois do teto, ninguém mais é lido");
    assert.equal(ingested(calls).length, 0);
    assert.ok(lines.some((l) => l.includes("AVISO: teto de 1 reposições do backlog atingido")));
    assert.equal(r.deferred, 2, "b3/b4 seguem na fila");
  });

  it("teto não atingido ⇒ sem flag no resultado e sem aviso", async () => {
    const { d, lines } = deps({ blacklisted: new Set(["b0@x.com"]), maxBacklogReplacements: 1 });
    const r = await runKitSemAberturaSync(cfg(2), { push: true }, d);
    assert.equal(r.moved, 2);
    assert.equal(r.backlogReplacementCapHit, undefined);
    assert.ok(!lines.some((l) => l.includes("AVISO: teto")));
  });

  it("dry-run também reporta o teto atingido", async () => {
    const { d } = deps({ blacklisted: new Set(["b0@x.com", "b1@x.com", "b2@x.com"]), maxBacklogReplacements: 1 });
    const r = await runKitSemAberturaSync(cfg(2), { push: false }, d);
    assert.equal(r.dryRun, true);
    assert.equal(r.backlogReplacementCapHit, true);
  });
});

describe("Kit→Brevo: cadastro novo pulado cede a vaga (#10701 item 3)", () => {
  it("--max-add 2 cortou o backlog e o novo é blacklisted ⇒ o próximo do backlog entra", async () => {
    const { d, calls } = deps({ blacklisted: new Set(["n0@x.com"]), withNovo: true });
    const r = await runKitSemAberturaSync(cfg(50), { push: true, maxAdd: 2 }, d);
    assert.equal(r.skippedBlacklisted, 1);
    assert.equal(r.moved, 2, "a rodada chega ao teto do --max-add");
    assert.deepEqual(ingested(calls), ["b0@x.com", "b1@x.com"]);
  });

  it("sem --max-add: o novo ocupava vaga da fila e, pulado, a devolve ao backlog", async () => {
    const { d, calls } = deps({ blacklisted: new Set(["n0@x.com"]), withNovo: true });
    const r = await runKitSemAberturaSync(cfg(2), { push: true }, d);
    assert.equal(r.moved, 2);
    assert.deepEqual(ingested(calls), ["b0@x.com", "b1@x.com"]);
    assert.equal(r.deferred, 3);
  });

  it("fila já cheia: o novo entrou sem o teto da fila e, pulado, NÃO abre vaga pro backlog", async () => {
    // 1 contato já in_brevo e daily_send_cap 1: o backlog não tem vaga com ou
    // sem o novo, então trocar o novo pulado por um do backlog estouraria a fila.
    const initialStore: BrevoDiariaStore = {
      contacts: [
        {
          email: "ja@x.com",
          beehiiv_subscription_id: "kit-sem-abertura:1",
          status: "in_brevo",
          opens_count: 0,
          sends_count: 0,
          last_open_rate: null,
          added_at: "2026-10-01T00:00:00.000Z",
          last_evaluated_at: null,
        },
      ],
    };
    const { d, calls } = deps({ blacklisted: new Set(["n0@x.com"]), withNovo: true, initialStore });
    const r = await runKitSemAberturaSync(cfg(1), { push: true }, d);
    assert.equal(r.skippedBlacklisted, 1);
    assert.equal(r.moved, 0);
    assert.deepEqual(ingested(calls), []);
    assert.ok(!calls.includes("check:b0@x.com"), "nenhum substituto lido");
  });

  it("novo não blacklisted continua entrando antes do backlog (sem reposição)", async () => {
    const { d, calls } = deps({ blacklisted: new Set(), withNovo: true });
    const r = await runKitSemAberturaSync(cfg(50), { push: true, maxAdd: 2 }, d);
    assert.equal(r.moved, 2);
    assert.deepEqual(ingested(calls), ["n0@x.com", "b0@x.com"]);
  });
});

describe("precedência do motivo de saída na Brevo (#10701 item 1)", () => {
  it("reclamação vence hard bounce; clique de descadastro vence os dois", () => {
    assert.equal(nativeBounceReason({ hardBounced: true, spamComplained: true }), "native_complaint");
    assert.equal(nativeBlacklistExitReason({ userUnsubscribed: false, hardBounced: true, spamComplained: true }), "native_complaint");
    assert.equal(nativeBlacklistExitReason({ userUnsubscribed: true, hardBounced: true, spamComplained: true }), "native_unsubscribe");
  });

  it("estado anterior ao #10666 (sem spamComplained) com hard bounce segue native_bounce", () => {
    assert.equal(nativeBounceReason({ hardBounced: true }), "native_bounce");
  });
});
