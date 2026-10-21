/**
 * test/onboarding-followup-checagem-espacada-10676.test.ts (#10676)
 *
 * A checagem singular perto do envio fazia até `max_recipients_per_lot` (300)
 * `GET /subscribers/{id}` em sequência, sem o espaçamento/cooldown do #10616,
 * e um único GET esgotado (`lookups_failed > 0`) marcava a rodada inteira
 * como falha — 2 dias assim abriam a issue P1 `followup-run-failure-streak`
 * sem nenhuma perda de e-mail (quem falhou volta no dia seguinte). Agora:
 * mesmo `refreshKitCandidates` (passada espaçada + retry após cooldown), e só
 * conta como falha o que não dá pra adiar com segurança.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyLookupFailures,
  isFailedFollowupRun,
  parseFollowupSnippet,
  resolveFollowupConfig,
  type FollowupSnippets,
} from "../scripts/lib/onboarding-followup.ts";
import { runFollowupRound, liveCheckDue, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, writeStore } from "../scripts/lib/onboarding-store.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;

function okSnippet(): string {
  return `<!--\nassunto: "Assunto"\npreview_text: "Prev"\n-->\nCorpo`;
}

const snippets: FollowupSnippets = {
  apoio30: parseFollowupSnippet(okSnippet()),
  apoio90: parseFollowupSnippet(okSnippet()),
  apoio180: parseFollowupSnippet(okSnippet()),
  apoio360: parseFollowupSnippet(okSnippet()),
  form: null,
  form_lembrete: null,
};

function tempStore(): string {
  const p = join(mkdtempSync(join(tmpdir(), "followup-10676-")), "store.json");
  writeStore(emptyStore(), p);
  return p;
}

/** Coorte de `n` no mesmo D+30, todos com cadastro em T0 (janela [T0+30d, T0+40d)). */
function cohort(n: number) {
  return Array.from({ length: n }, (_, i) => ({ kit_subscriber_id: i + 1, email: `${i + 1}@x.com`, cadastro_at: new Date(T0 * 1000).toISOString() }));
}

class Http429 extends Error {}

/** Kit fingido: `failFirst` ids tomam 429 na 1ª tentativa (passam no retry);
 *  `alwaysFail` seguem falhando. Registra as esperas pedidas. */
function deps(n: number, opts: { failFirst?: Set<number>; alwaysFail?: Set<number>; nonTransient?: boolean } = {}) {
  const attempts = new Map<number, number>();
  const sleeps: number[] = [];
  const lots: string[][] = [];
  let seq = 0;
  const d: FollowupRoundDeps = {
    async listActiveSubscribers() {
      return cohort(n);
    },
    async getSubscriber(id) {
      const k = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, k);
      if (opts.alwaysFail?.has(id) || (opts.failFirst?.has(id) && k === 1)) {
        throw opts.nonTransient ? new Error("HTTP 401") : new Http429("HTTP 429 Too Many Requests");
      }
      return { state: "active", apoioNivel: "" };
    },
    async listEnvioBrevoEmails() {
      return [];
    },
    async fetchFormResponses() {
      return [];
    },
    async runLot(lot) {
      lots.push([...lot.recipient_subscription_ids]);
      lot.broadcast_id = 9000 + ++seq;
      lot.tag_id = 5;
      lot.status = "scheduled";
      lot.send_at = lot.created_at;
    },
    async sleep(ms) {
      sleeps.push(ms);
    },
    isTransientLookupError: (e) => e instanceof Http429,
  };
  return { d, attempts, sleeps, lots };
}

const cfg = resolveFollowupConfig({ enabled: true });

describe("#10676 checagem singular espaçada, com retry e sem alarme falso", () => {
  it("429 intermitente: espaça as leituras, retenta após cooldown e a rodada sai limpa", async () => {
    const k = deps(10, { failFirst: new Set([3, 7]) });
    const r = await runFollowupRound({ storePath: tempStore(), send: true, cfg, snippets, nowMs: (T0 + 30 * DAY) * 1000 }, k.d);
    assert.equal(r.run.lookups_failed, 0);
    assert.equal(r.run.lookups_deferred, undefined);
    assert.equal(isFailedFollowupRun(r.run), false, "429 que passa no retry não derruba a rodada");
    assert.equal(r.run.counts.apoio30?.enviado, 10);
    assert.equal(k.attempts.get(3), 2);
    assert.equal(k.attempts.get(1), 1, "quem passou de primeira não é relido");
    // 9 espaçamentos de 350ms na 1ª passada, cooldown de 60s, 1 espaçamento na passada de retry.
    assert.equal(k.sleeps.filter((ms) => ms === 350).length, 10);
    assert.equal(k.sleeps.filter((ms) => ms === 60_000).length, 1);
  });

  it("falha isolada que persiste: fica fora do envio de hoje, é adiada e NÃO marca a rodada como falha", async () => {
    const k = deps(10, { alwaysFail: new Set([4]) });
    const r = await runFollowupRound({ storePath: tempStore(), send: true, cfg, snippets, nowMs: (T0 + 30 * DAY) * 1000 }, k.d);
    assert.equal(r.run.counts.apoio30?.consulta_falhou, 1);
    assert.equal(r.run.counts.apoio30?.enviado, 9);
    assert.ok(!k.lots.flat().includes("4"), "leitura falha nunca autoriza envio");
    assert.equal(r.run.lookups_failed, 0);
    assert.equal(r.run.lookups_deferred, 1);
    assert.equal(isFailedFollowupRun(r.run), false);
  });

  it("falha no último dia da janela conta como falha (amanhã a pessoa vira vencida)", async () => {
    const k = deps(10, { alwaysFail: new Set([4]) });
    const lastDay = (T0 + 39 * DAY + 3600) * 1000; // janela [D+30, D+40)
    const r = await runFollowupRound({ storePath: tempStore(), send: true, cfg, snippets, nowMs: lastDay }, k.d);
    assert.equal(r.run.lookups_failed, 1);
    assert.equal(isFailedFollowupRun(r.run), true);
  });

  it("falha sistêmica (metade ou mais das leituras) e erro não transitório contam como falha", async () => {
    const half = deps(4, { alwaysFail: new Set([1, 2]) });
    const r1 = await runFollowupRound({ storePath: tempStore(), send: true, cfg, snippets, nowMs: (T0 + 30 * DAY) * 1000 }, half.d);
    assert.equal(r1.run.lookups_failed, 2);
    assert.equal(isFailedFollowupRun(r1.run), true);

    const auth = deps(10, { alwaysFail: new Set([5]), nonTransient: true });
    const r2 = await runFollowupRound({ storePath: tempStore(), send: true, cfg, snippets, nowMs: (T0 + 30 * DAY) * 1000 }, auth.d);
    assert.equal(auth.attempts.get(5), 1, "401 não é retentado");
    assert.equal(r2.run.lookups_failed, 1);
    assert.equal(isFailedFollowupRun(r2.run), true);
  });

  it("liveCheckDue lê cada pessoa uma vez e guarda o motivo do erro para o log", async () => {
    const k = deps(2, { alwaysFail: new Set([2]) });
    const out = await liveCheckDue(
      [{ kit_subscriber_id: 1, email: "1@x.com", kind: "apoio30" }, { kit_subscriber_id: 1, email: "1@x.com", kind: "form" }, { kit_subscriber_id: 2, email: "2@x.com", kind: "apoio30" }],
      {},
      k.d,
    );
    assert.equal(out.total, 2);
    assert.equal(k.attempts.get(1), 1);
    assert.equal(out.results.get(2), null);
    assert.match(out.failed.get(2)!.error, /429/);
  });

  it("classifyLookupFailures: form_lembrete (sem janela) só falha por erro não transitório ou sistêmico", () => {
    const due = { kit_subscriber_id: 1, email: "1@x.com", kind: "form_lembrete" as const };
    assert.deepEqual(classifyLookupFailures([{ due, transient: true, anchorSec: T0 - 900 * DAY }], 10, T0, cfg), { blocking: 0, deferred: 1 });
    assert.deepEqual(classifyLookupFailures([{ due, transient: false, anchorSec: null }], 10, T0, cfg), { blocking: 1, deferred: 0 });
    assert.deepEqual(classifyLookupFailures([], 0, T0, cfg), { blocking: 0, deferred: 0 });
  });
});
