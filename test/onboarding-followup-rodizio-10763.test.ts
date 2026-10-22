/**
 * test/onboarding-followup-rodizio-10763.test.ts (#10763)
 *
 * `consulta_falhou` recorrente de quem está à frente da fila ocupava o teto
 * (cap) todo dia e adiava os saudáveis. Agora a falha grava uma marca
 * TRANSITÓRIA que só rebaixa a pessoa na ordem do teto: sem GET extra, sem
 * pulo terminal, e a marca some no 1º sucesso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFollowupSnippet, resolveFollowupConfig, splitDueByCap, type FollowupSnippets } from "../scripts/lib/onboarding-followup.ts";
import { runFollowupRound, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, readStore, writeStore } from "../scripts/lib/onboarding-store.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;
const snip = parseFollowupSnippet(`<!--\nassunto: "A"\npreview_text: "P"\n-->\nCorpo`);
const snippets: FollowupSnippets = { apoio30: snip, apoio90: snip, apoio180: snip, apoio360: snip, form: null, form_lembrete: null };
const cfg = resolveFollowupConfig({ enabled: true, max_recipients_per_lot: 1 });

function setup(failing: Set<number>) {
  const storePath = join(mkdtempSync(join(tmpdir(), "followup-10763-")), "store.json");
  writeStore(emptyStore(), storePath);
  const gets: number[] = [];
  const lots: string[][] = [];
  let seq = 0;
  const d: FollowupRoundDeps = {
    // pessoa 1 é a mais antiga (primeira da fila), pessoa 2 depois
    async listActiveSubscribers() {
      return [
        { kit_subscriber_id: 1, email: "1@x.com", cadastro_at: new Date(T0 * 1000).toISOString() },
        { kit_subscriber_id: 2, email: "2@x.com", cadastro_at: new Date((T0 + 60) * 1000).toISOString() },
      ];
    },
    async getSubscriber(id) {
      gets.push(id);
      if (failing.has(id)) throw new Error("HTTP 500");
      return { state: "active", apoioNivel: "" };
    },
    async listEnvioBrevoEmails() { return []; },
    async fetchFormResponses() { return []; },
    async runLot(lot) {
      lots.push([...lot.recipient_subscription_ids]);
      lot.broadcast_id = 9000 + ++seq;
      lot.tag_id = 5;
      lot.status = "scheduled";
      lot.send_at = lot.created_at;
    },
    async sleep() {},
    isTransientLookupError: () => true,
  };
  return { storePath, d, gets, lots };
}

describe("#10763 rodízio da fila com consulta_falhou recorrente", () => {
  it("splitDueByCap: demoted vai depois, sem mudar o tamanho do lote", () => {
    const due = [1, 2, 3].map((id) => ({ kit_subscriber_id: id, email: `${id}@x.com`, kind: "apoio30" as const }));
    const r = splitDueByCap(due, 1, (d) => d.kit_subscriber_id, (d) => d.kit_subscriber_id === 1);
    assert.deepEqual(r.within.map((d) => d.kit_subscriber_id), [2]);
    assert.equal(r.deferred[0]!.deferred, 2);
  });

  it("rodadas sucessivas: a saudável avança, GETs ficam em cap por rodada e a falha não vira pulo", async () => {
    const k = setup(new Set([1]));
    const nowMs = (T0 + 31 * DAY) * 1000;
    const r1 = await runFollowupRound({ storePath: k.storePath, send: true, cfg, snippets, nowMs }, k.d);
    assert.deepEqual([...new Set(k.gets)], [1], "rodada 1: só a pessoa 1 entra no lote limitado (o 2º GET é o retry pós-cooldown)");
    assert.equal(r1.run.counts.apoio30?.consulta_falhou, 1);
    assert.equal(k.lots.length, 0);

    k.gets.length = 0;
    await runFollowupRound({ storePath: k.storePath, send: true, cfg, snippets, nowMs: nowMs + DAY * 1000 }, k.d);
    assert.deepEqual(k.gets, [2], "rodada 2: a saudável passa à frente");
    assert.deepEqual(k.lots.flat(), ["2"]);

    const p1 = readStore(k.storePath).store.followup!.people["1"]!;
    assert.equal(p1.skips, undefined, "falha transitória nunca vira pulo terminal");
    assert.equal(p1.live_failures?.[0]?.n, 1);

    // pessoa 1 se recupera: volta a ser lida e a marca some
    k.gets.length = 0;
    const healed = { ...k.d, getSubscriber: async (id: number) => { k.gets.push(id); return { state: "active", apoioNivel: "" }; } };
    await runFollowupRound({ storePath: k.storePath, send: true, cfg, snippets, nowMs: nowMs + 2 * DAY * 1000 }, healed);
    assert.deepEqual(k.gets, [1]);
    assert.equal(readStore(k.storePath).store.followup!.people["1"]!.live_failures, undefined);
  });
});
