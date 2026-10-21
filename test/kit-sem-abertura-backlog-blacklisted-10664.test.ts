/**
 * test/kit-sem-abertura-backlog-blacklisted-10664.test.ts (#10664)
 *
 * Regressão: no Passo 3c do Kit→Brevo, o filtro de blacklist (#10536) rodava
 * DEPOIS do corte da onda em `slots`. Quem era pulado por já estar
 * `emailBlacklisted` na Brevo não ficava registrado em lugar nenhum e voltava
 * a ser selecionado na rodada seguinte — com os N mais antigos do backlog
 * blacklisted, eles ocupavam as N vagas todo dia e ninguém mais andava.
 *
 * Trava: o contato pulado na confirmação cede a vaga ao próximo do backlog
 * (mesma ordem, mais antigo primeiro), inclusive em rodadas repetidas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runKitSemAberturaSync,
  type KitSemAberturaDeps,
  type KitSemAberturaPlatformConfig,
} from "../scripts/sync-kit-sem-abertura-to-brevo.ts";
import { planKitSemAberturaWave, type KitSemAberturaSelected } from "../scripts/lib/kit-sem-abertura.ts";
import type { BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** Fila com espaço para exatamente 2 do backlog (sem novos, sem ativos). */
function cfg(cap = 2): KitSemAberturaPlatformConfig {
  return {
    brevo_diaria: { api_key_env: "X", list_id: 7, daily_send_cap: cap, kit_sem_abertura: { enabled: true } },
    kit: { diaria_exclusion_segment: { enabled: true, segment_id: 99 } },
  };
}

/** Backlog de 5, do mais antigo (b0) ao mais novo (b4); todos fora da janela de "novo". */
const BACKLOG = [0, 1, 2, 3, 4].map((i) => ({
  id: 100 + i,
  email: `b${i}@x.com`,
  created_at: new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * DAY).toISOString(),
  tagNames: [] as string[],
}));

function deps(opts: {
  blacklisted: ReadonlySet<string>;
  apoiadores?: ReadonlySet<number>;
  blacklistReadFails?: ReadonlySet<string>;
}) {
  const calls: string[] = [];
  let store: BrevoDiariaStore = { contacts: [] };
  const records = [1, 2, 3, 4, 5, 6].map((i) => ({ broadcastId: i, sentAt: new Date(NOW - (10 - i) * DAY).toISOString(), edition: `e${i}` }));
  const d: KitSemAberturaDeps = {
    nowMs: NOW,
    log: () => {},
    readRegistry: () => records,
    listKitActive: async () => BACKLOG.map((b) => ({ ...b })),
    fetchEngagement: async (id) => ({ broadcastId: id, delivered: BACKLOG.map((b) => b.email), opens: [], clicks: [] }),
    findEnvioBrevoTagId: async () => 555,
    readStore: () => store,
    writeStore: (s) => {
      store = s;
    },
    rolloutPaused: () => false,
    transactionalOnSendDay: async () => 0,
    getApoioNivel: async (id) => (opts.apoiadores?.has(id) ? "amigo" : null),
    isBrevoBlacklisted: async (email) => {
      calls.push(`check:${email}`);
      if (opts.blacklistReadFails?.has(email)) throw new Error("HTTP 500");
      return opts.blacklisted.has(email);
    },
    ingestBrevo: async (email) => {
      calls.push(`brevo:${email}`);
    },
    tagKit: async (tagId, id) => {
      calls.push(`tag:${tagId}:${id}`);
    },
    untagKit: async () => {},
    appendLog: () => {},
  };
  return { d, calls, getStore: () => store };
}

const ingested = (calls: string[]) => calls.filter((c) => c.startsWith("brevo:")).map((c) => c.slice("brevo:".length));

describe("Kit→Brevo: blacklisted na cabeça do backlog não travam a fila (#10664)", () => {
  it("os 2 mais antigos blacklisted e 2 vagas ⇒ os 2 seguintes são movidos", async () => {
    const { d, calls } = deps({ blacklisted: new Set(["b0@x.com", "b1@x.com"]) });
    const r = await runKitSemAberturaSync(cfg(), { push: true }, d);
    assert.equal(r.code, 0);
    assert.equal(r.skippedBlacklisted, 2);
    assert.equal(r.moved, 2, "as vagas cedidas pelos blacklisted vão pros próximos do backlog");
    assert.deepEqual(ingested(calls), ["b2@x.com", "b3@x.com"]);
    assert.equal(r.deferred, 1, "só b4 fica pra depois");
  });

  it("rodadas repetidas: o backlog continua andando apesar dos blacklisted ficarem fora do store", async () => {
    const { d, calls, getStore } = deps({ blacklisted: new Set(["b0@x.com", "b1@x.com"]) });
    await runKitSemAberturaSync(cfg(), { push: true }, d);
    // 2ª rodada: b2/b3 já estão no store (in_brevo) e contam na fila; abre 2 vagas a mais.
    const r2 = await runKitSemAberturaSync(cfg(4), { push: true }, d);
    assert.equal(r2.moved, 1);
    assert.deepEqual(ingested(calls), ["b2@x.com", "b3@x.com", "b4@x.com"]);
    assert.equal(getStore().contacts.length, 3);
    assert.ok(!getStore().contacts.some((c) => c.email === "b0@x.com" || c.email === "b1@x.com"));
  });

  it("todo o backlog blacklisted ⇒ ninguém movido, nenhum erro, nada no Kit", async () => {
    const { d, calls } = deps({ blacklisted: new Set(BACKLOG.map((b) => b.email)) });
    const r = await runKitSemAberturaSync(cfg(), { push: true }, d);
    assert.equal(r.moved, 0);
    assert.equal(r.skippedBlacklisted, 5);
    assert.equal(r.deferred, 0);
    assert.ok(!calls.some((c) => c.startsWith("tag:") || c.startsWith("brevo:")));
  });

  it("apoiador confirmado pelo GET singular também cede a vaga", async () => {
    const { d, calls } = deps({ blacklisted: new Set(), apoiadores: new Set([100]) });
    const r = await runKitSemAberturaSync(cfg(), { push: true }, d);
    assert.equal(r.moved, 2);
    assert.deepEqual(ingested(calls), ["b1@x.com", "b2@x.com"]);
  });

  it("falha de leitura do blacklist adia SEM repor (transitória não queima a fila)", async () => {
    const { d, calls } = deps({ blacklisted: new Set(), blacklistReadFails: new Set(["b0@x.com"]) });
    const r = await runKitSemAberturaSync(cfg(), { push: true }, d);
    assert.equal(r.moved, 1);
    assert.deepEqual(ingested(calls), ["b1@x.com"]);
    assert.ok(!calls.includes("check:b2@x.com"), "nenhum substituto lido");
    assert.equal(r.deferred, 4);
  });

  it("--max-add continua sendo teto da rodada: reposição não passa dele", async () => {
    const { d, calls } = deps({ blacklisted: new Set(["b0@x.com"]) });
    const r = await runKitSemAberturaSync(cfg(5), { push: true, maxAdd: 1 }, d);
    assert.equal(r.moved, 1);
    assert.deepEqual(ingested(calls), ["b1@x.com"]);
  });

  it("dry-run também repõe (a prévia mostra quem de fato seria movido)", async () => {
    const lines: string[] = [];
    const { d } = deps({ blacklisted: new Set(["b0@x.com", "b1@x.com"]) });
    d.log = (m) => lines.push(m);
    const r = await runKitSemAberturaSync(cfg(), { push: false }, d);
    assert.equal(r.dryRun, true);
    assert.ok(lines.some((l) => l.includes("+ b2@x.com")));
    assert.ok(lines.some((l) => l.includes("+ b3@x.com")));
    assert.ok(!lines.some((l) => l.includes("+ b0@x.com")));
  });
});

describe("planKitSemAberturaWave expõe o resto do backlog em ordem (#10664)", () => {
  it("backlogReserve = backlog fora das vagas, mais antigo primeiro", () => {
    const sel: KitSemAberturaSelected[] = [...BACKLOG].reverse().map((b) => ({ ...b, matureSends: 6 }));
    const w = planKitSemAberturaWave({ selected: sel, nowMs: NOW, newSignupWindowDays: 30, backlogSlots: () => 2, rolloutPaused: false });
    assert.deepEqual(w.toMove.map((c) => c.email), ["b0@x.com", "b1@x.com"]);
    assert.deepEqual(w.backlogReserve.map((c) => c.email), ["b2@x.com", "b3@x.com", "b4@x.com"]);
    assert.equal(w.deferred, w.backlogReserve.length);
  });

  it("circuit breaker pausado ⇒ reserva vazia (nada repõe uma rodada zerada)", () => {
    const sel: KitSemAberturaSelected[] = BACKLOG.map((b) => ({ ...b, matureSends: 6 }));
    const w = planKitSemAberturaWave({ selected: sel, nowMs: NOW, newSignupWindowDays: 30, backlogSlots: () => 2, rolloutPaused: true });
    assert.deepEqual(w.backlogReserve, []);
  });
});
