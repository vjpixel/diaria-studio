/**
 * #13185 — fila de escaladas:
 *   1. detecção de PR de bot única (`isBotPr`): `prLane` e o teto de PRs
 *      abertos (`computeOpenPrSlots`) respondem igual;
 *   2. `--all-open` não roda o merge gate em PR que será descartada (`aberta`
 *      ou não-autônoma com menos de 6h).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBotPr } from "../scripts/lib/bot-pr.ts";
import { computeOpenPrSlots } from "../scripts/lib/open-pr-cap.ts";
import {
  prLane,
  runEscalationQueue,
  type GateOutput,
  type OpenEscalatedPr,
  type QueueDeps,
} from "../scripts/list-continuo-escalation-queue.ts";

const HOUR = 60 * 60 * 1000;

describe("#13185 item 1: detecção de bot única", () => {
  const cases: Array<{ name: string; pr: { headRefName: string; author?: { login?: string; is_bot?: boolean } | null }; bot: boolean }> = [
    { name: "renovate/ de autor humano", pr: { headRefName: "renovate/foo", author: { login: "vjpixel", is_bot: false } }, bot: true },
    { name: "bot/ do heatmap (app/github-actions)", pr: { headRefName: "bot/heatmap-weekly-regen", author: { login: "app/github-actions", is_bot: true } }, bot: true },
    { name: "bot/ sem autor", pr: { headRefName: "bot/heatmap-weekly-regen" }, bot: true },
    { name: "dependabot por login", pr: { headRefName: "x", author: { login: "dependabot[bot]" } }, bot: true },
    { name: "app/ qualquer", pr: { headRefName: "feat/x", author: { login: "app/renovate" } }, bot: true },
    { name: "is_bot do GitHub", pr: { headRefName: "feat/x", author: { login: "alguem", is_bot: true } }, bot: true },
    { name: "overnight", pr: { headRefName: "overnight/fix-1-x", author: { login: "vjpixel", is_bot: false } }, bot: false },
    { name: "branch manual", pr: { headRefName: "feat/minha", author: { login: "vjpixel" } }, bot: false },
    { name: "botão/ não é bot/", pr: { headRefName: "botao/x" }, bot: false },
  ];

  for (const c of cases) {
    it(`${c.name}: fila e teto concordam (${c.bot ? "bot" : "não-bot"})`, () => {
      assert.equal(isBotPr(c.pr), c.bot);
      assert.equal(prLane(c.pr) === "bot", c.bot, "prLane");
      const counted = computeOpenPrSlots([{ number: 1, ...c.pr }]).counted;
      assert.deepEqual(counted, c.bot ? [] : [1], "teto de PRs abertos");
    });
  }
});

describe("#13185 item 2: --all-open não roda o gate em PR descartada", () => {
  const NOW = Date.parse("2026-11-16T12:00:00Z");
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const pr = (n: number, over: Partial<OpenEscalatedPr> = {}): OpenEscalatedPr => ({
    number: n, url: `u/${n}`, title: `t${n}`, body: null, headRefName: `overnight/fix-${n}-x`, isDraft: false,
    mergeStateStatus: "CLEAN", labels: [], createdAt: iso(30 * HOUR), author: { login: "vjpixel", is_bot: false }, ...over,
  });
  const failGate: GateOutput = { action: "escalate", reason: "r", details: { checksVerdict: "fail", mergeable: "MERGEABLE", retidoParaEditor: { retido: false }, sessionClaims: { ok: true } } };
  const run = (prs: OpenEscalatedPr[], events: QueueDeps["events"] = () => [], allOpen = true) => {
    const gated: number[] = [];
    const deps: QueueDeps = {
      listPrs: () => prs,
      events,
      lastCommitAt: () => null,
      issueClaimed: () => ({ status: "free" }),
      gate: (n) => {
        gated.push(n);
        return failGate;
      },
      redundant: () => false,
      issueState: () => ({ state: "OPEN" }),
      reopenIssue: () => {},
      commentIssue: () => {},
      closePr: () => {},
      now: () => NOW,
    };
    return { r: runEscalationQueue(deps, false, { allOpen }), gated };
  };

  it("PR aberta com menos de 6h: sem gate, fora da fila (mesmo com CI vermelho)", () => {
    const { r, gated } = run([pr(1, { createdAt: iso(2 * HOUR) }), pr(2, { headRefName: "feat/x", createdAt: iso(3 * HOUR) })]);
    assert.deepEqual(gated, []);
    assert.deepEqual(r.queue, []);
    assert.deepEqual(r.failures, []);
  });

  it("PR aberta passadas 6h segue com gate e entra na fila", () => {
    const { r, gated } = run([pr(3, { createdAt: iso(7 * HOUR) })]);
    assert.deepEqual(gated, [3]);
    assert.equal(r.queue[0].destination, "fixer");
  });

  it("escalada manual com menos de 6h: sem gate", () => {
    const events = () => [{ event: "labeled", label: { name: "continuo-escalado" }, created_at: iso(1 * HOUR) }];
    const { r, gated } = run([pr(4, { headRefName: "feat/y", labels: [{ name: "continuo-escalado" }] })], events, false);
    assert.deepEqual(gated, []);
    assert.deepEqual(r.queue, []);
  });

  it("escalada autônoma com menos de 6h ainda passa pelo gate: o atalho mecânico do #12950 vale", () => {
    const events = () => [{ event: "labeled", label: { name: "continuo-escalado" }, created_at: iso(1 * HOUR) }];
    const { r, gated } = run([pr(5, { labels: [{ name: "continuo-escalado" }] })], events, false);
    assert.deepEqual(gated, [5]);
    assert.equal(r.queue[0].destination, "fixer");
  });
});
