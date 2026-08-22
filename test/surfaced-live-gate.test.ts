/**
 * test/surfaced-live-gate.test.ts (#5919)
 *
 * Cobre `scripts/lib/surfaced-live-gate.ts` — a lógica pura do gate de
 * "surfacing ao vivo de bloqueio tipo-editor" no `/diaria-develop`. O I/O
 * (leitura do plan.json) fica no entrypoint `scripts/check-surfaced-live.ts`.
 * Mesmo padrão de `test/trade-off-label-gate.test.ts` (#5821).
 *
 * Regressão canônica (#5919): a entrada do #5878 em
 * `data/develop/260821c/plan.json` tinha `what_unblocks` preenchido e nenhum
 * registro de surfacing ao vivo — o gate tem que falhar nesse formato exato.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SURFACED_LIVE_AT_FIELD,
  SURFACED_LIVE_FIELD,
  checkSurfacedLive,
  type SurfacedLiveIssueEntry,
} from "../scripts/lib/surfaced-live-gate.ts";

/** Réu fiel da #5919: bloqueio cat. B registrado sem surfaced_live nenhum. */
const REGRESSION_5919: SurfacedLiveIssueEntry = {
  number: 5878,
  status: "pendente",
  block_category: "B",
  block_label: "external-blocker",
  what_unblocks: "editor logar na conta Microsoft Advertising neste Chrome",
  unblock_status: "pendente",
  surfaced_at: "2026-08-21T22:38:00Z",
};

describe("checkSurfacedLive", () => {
  it("#5919 regressão: bloqueio com what_unblocks e SEM surfaced_live => failure missing-field", () => {
    const r = checkSurfacedLive([REGRESSION_5919]);
    assert.equal(r.blockedCount, 1);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0]!.issue, 5878);
    assert.equal(r.failures[0]!.kind, "missing-field");
    assert.match(r.failures[0]!.detail, /ausente/);
  });

  it("surfaced_live=true => ok; timestamp ausente vira warning, não falha", () => {
    const entry: SurfacedLiveIssueEntry = {
      number: 5808,
      what_unblocks: "decisão de ativação na Beehiiv",
      surfaced_live: true,
    };
    const r = checkSurfacedLive([entry]);
    assert.equal(r.blockedCount, 1);
    assert.equal(r.okCount, 1);
    assert.equal(r.failures.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0]!.kind, "missing-timestamp");
    assert.ok(r.warnings[0]!.detail.includes(SURFACED_LIVE_AT_FIELD));
  });

  it("surfaced_live=true com surfaced_live_at => ok limpo, zero warnings", () => {
    const entry: SurfacedLiveIssueEntry = {
      number: 5808,
      what_unblocks: "decisão de ativação na Beehiiv",
      surfaced_live: true,
      surfaced_live_at: "2026-08-22T00:10:00Z",
    };
    const r = checkSurfacedLive([entry]);
    assert.equal(r.okCount, 1);
    assert.equal(r.warnings.length, 0);
    assert.equal(r.failures.length, 0);
  });

  it("surfaced_live=false explícito => WARNING (fallback legítimo), nunca failure", () => {
    const entry: SurfacedLiveIssueEntry = {
      number: 5846,
      status: "pulada",
      what_unblocks: "screenshot no canvas do builder",
      surfaced_live: false,
    };
    const r = checkSurfacedLive([entry]);
    assert.equal(r.falseCount, 1);
    assert.equal(r.failures.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0]!.kind, "not-surfaced");
    assert.match(r.warnings[0]!.detail, /HANDOFF/);
  });

  it("tipo errado (string 'true', null) => failure wrong-type", () => {
    const r = checkSurfacedLive([
      { number: 1, what_unblocks: "a", [SURFACED_LIVE_FIELD]: "true" as unknown as boolean },
      { number: 2, what_unblocks: "b", [SURFACED_LIVE_FIELD]: null },
    ]);
    assert.equal(r.blockedCount, 2);
    assert.equal(r.failures.length, 2);
    for (const f of r.failures) assert.equal(f.kind, "wrong-type");
  });

  it("entrada sem what_unblocks (ou vazia/branca) não é examinada", () => {
    const r = checkSurfacedLive([
      { number: 3, status: "mergeada" },
      { number: 4, what_unblocks: "" },
      { number: 5, what_unblocks: "   " },
      { number: 6, what_unblocks: null },
    ]);
    assert.equal(r.blockedCount, 0);
    assert.equal(r.failures.length, 0);
    assert.equal(r.warnings.length, 0);
  });

  it("mistura realista: 2 ok + 1 false + 1 faltando => 1 failure, 2 warnings", () => {
    const r = checkSurfacedLive([
      REGRESSION_5919,
      { number: 100, what_unblocks: "token Stripe", surfaced_live: true, surfaced_live_at: "2026-08-22T01:00:00Z" },
      { number: 200, what_unblocks: "login Meta Ads", surfaced_live: true },
      { number: 300, status: "pulada", motivo: "nao-destravavel-na-sessao", what_unblocks: "conta APOIA.se inexistente", surfaced_live: false },
    ]);
    assert.equal(r.blockedCount, 4);
    assert.equal(r.okCount, 2);
    assert.equal(r.falseCount, 1);
    assert.deepEqual(r.failures.map((f) => f.issue), [5878]);
    assert.equal(r.warnings.length, 2); // false explícito + true sem timestamp
    const kinds = r.warnings.map((w) => w.kind).sort();
    assert.deepEqual(kinds, ["missing-timestamp", "not-surfaced"]);
  });

  it("lista vazia/null/undefined => zero de tudo (sessões sem bloqueios passam)", () => {
    for (const input of [[], null, undefined]) {
      const r = checkSurfacedLive(input);
      assert.equal(r.blockedCount, 0);
      assert.equal(r.failures.length, 0);
      assert.equal(r.warnings.length, 0);
    }
  });

  it("entrada não-objeto no array é ignorada sem lançar", () => {
    const r = checkSurfacedLive([null, undefined, 42, "x", REGRESSION_5919] as unknown as SurfacedLiveIssueEntry[]);
    assert.equal(r.blockedCount, 1);
    assert.equal(r.failures.length, 1);
  });
});
