import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dedupKey,
  mergeSignals,
  consolidateSignals,
  type Signal,
  type DraftFile,
} from "../scripts/lib/auto-reporter-dedup.ts";

// -----------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------

function sourceStreak(source: string, opts: Partial<Signal> = {}): Signal {
  return {
    kind: "source_streak",
    severity: "medium",
    title: `Source ${source} com falhas`,
    details: { source, consecutive_failures: 3 },
    suggested_action: `Investigar ${source}`,
    ...opts,
  };
}

function unfixedIssue(reason: string, section: string, opts: Partial<Signal> = {}): Signal {
  return {
    kind: "unfixed_issue",
    severity: "high",
    title: `${reason} em ${section}`,
    details: { reason, section },
    ...opts,
  };
}

function chromeDisconnects(count: number, opts: Partial<Signal> = {}): Signal {
  return {
    kind: "chrome_disconnects",
    severity: "high",
    title: `Chrome desconectou ${count}×`,
    details: { count },
    ...opts,
  };
}

function draft(edition: string, signals: Signal[]): DraftFile {
  return {
    edition,
    collected_at: `2026-04-${edition.slice(2)}T23:00:00Z`,
    signals,
  };
}

// -----------------------------------------------------------------------
// dedupKey
// -----------------------------------------------------------------------

describe("dedupKey — chave de agrupamento por kind (#91)", () => {
  it("source_streak: keyed por details.source", () => {
    assert.equal(dedupKey(sourceStreak("Tecnoblog")), "source_streak:Tecnoblog");
  });

  it("source_streak sem details.source: retorna null (não consolida)", () => {
    const sig: Signal = {
      kind: "source_streak",
      severity: "medium",
      title: "x",
      details: {},
    };
    assert.equal(dedupKey(sig), null);
  });

  it("unfixed_issue: keyed por reason + section", () => {
    assert.equal(
      dedupKey(unfixedIssue("unicode_corruption", "subtitle")),
      "unfixed_issue:unicode_corruption:subtitle",
    );
  });

  it("unfixed_issue sem reason: retorna null", () => {
    const sig: Signal = {
      kind: "unfixed_issue",
      severity: "high",
      title: "x",
      details: { section: "title" },
    };
    assert.equal(dedupKey(sig), null);
  });

  it("chrome_disconnects: chave única (sempre consolida)", () => {
    assert.equal(dedupKey(chromeDisconnects(3)), "chrome_disconnects");
    assert.equal(dedupKey(chromeDisconnects(99)), "chrome_disconnects");
  });
});

// -----------------------------------------------------------------------
// mergeSignals
// -----------------------------------------------------------------------

describe("mergeSignals — escalação + acumulação (#91)", () => {
  it("acumula edições em _editions (sorted, deduped)", () => {
    const a: Signal = {
      ...sourceStreak("Tecnoblog"),
      _editions: ["260423", "260421"],
    };
    const b: Signal = { ...sourceStreak("Tecnoblog"), _edition: "260422" };
    const merged = mergeSignals(a, b);
    assert.deepEqual(merged._editions, ["260421", "260422", "260423"]);
    assert.equal(merged._edition, undefined);
  });

  it("dedupa edições repetidas em _editions", () => {
    const a: Signal = {
      ...sourceStreak("Tecnoblog"),
      _editions: ["260421", "260422"],
    };
    const b: Signal = {
      ...sourceStreak("Tecnoblog"),
      _editions: ["260422", "260423"],
    };
    const merged = mergeSignals(a, b);
    assert.deepEqual(merged._editions, ["260421", "260422", "260423"]);
  });

  it("severity escala pra worst observed", () => {
    const lo: Signal = { ...sourceStreak("X"), severity: "low" };
    const hi: Signal = { ...sourceStreak("X"), severity: "high" };
    const merged = mergeSignals(lo, hi);
    assert.equal(merged.severity, "high");
  });

  it("severity preserva quando ambos iguais", () => {
    const a: Signal = { ...sourceStreak("X"), severity: "medium" };
    const b: Signal = { ...sourceStreak("X"), severity: "medium" };
    assert.equal(mergeSignals(a, b).severity, "medium");
  });

  it("chrome_disconnects: count somado em details", () => {
    const a: Signal = { ...chromeDisconnects(3), _edition: "260421" };
    const b: Signal = { ...chromeDisconnects(5), _edition: "260422" };
    const merged = mergeSignals(a, b);
    assert.equal(merged.details.count, 8);
  });

  it("chrome_disconnects sem count válido: não soma (preserva details de a)", () => {
    const a: Signal = chromeDisconnects(0);
    a.details = { reason: "x" }; // sem count
    const b: Signal = chromeDisconnects(0);
    b.details = { reason: "y" };
    const merged = mergeSignals(a, b);
    assert.equal(merged.details.count, undefined);
  });

  it("title/kind/suggested_action de a são preservados", () => {
    const a = sourceStreak("Tecnoblog", {
      title: "Title A",
      suggested_action: "Action A",
    });
    const b = sourceStreak("Tecnoblog", {
      title: "Title B (edição mais nova)",
      suggested_action: "Action B",
    });
    const merged = mergeSignals(a, b);
    assert.equal(merged.title, "Title A");
    assert.equal(merged.suggested_action, "Action A");
  });
});

// -----------------------------------------------------------------------
// consolidateSignals — full pipeline
// -----------------------------------------------------------------------

describe("consolidateSignals — merge cross-edition (#91)", () => {
  it("3 source_streak mesma source → 1 signal com _editions=[d1,d2,d3]", () => {
    const drafts = [
      draft("260421", [sourceStreak("Tecnoblog")]),
      draft("260422", [sourceStreak("Tecnoblog")]),
      draft("260423", [sourceStreak("Tecnoblog")]),
    ];
    const out = consolidateSignals(drafts);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]._editions, ["260421", "260422", "260423"]);
  });

  it("2 source_streak fontes diferentes → 2 signals separados", () => {
    const drafts = [
      draft("260421", [sourceStreak("Tecnoblog")]),
      draft("260422", [sourceStreak("Olhar Digital")]),
    ];
    const out = consolidateSignals(drafts);
    assert.equal(out.length, 2);
    const sources = out.map((s) => s.details.source).sort();
    assert.deepEqual(sources, ["Olhar Digital", "Tecnoblog"]);
  });

  it("chrome_disconnects em 2 edições → 1 signal com count somado", () => {
    const drafts = [
      draft("260421", [chromeDisconnects(2)]),
      draft("260422", [chromeDisconnects(3)]),
    ];
    const out = consolidateSignals(drafts);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "chrome_disconnects");
    assert.equal(out[0].details.count, 5);
    assert.deepEqual(out[0]._editions, ["260421", "260422"]);
  });

  it("unfixed_issue mesmo reason+section em 2 edições → consolida", () => {
    const drafts = [
      draft("260421", [unfixedIssue("unicode_corruption", "subtitle")]),
      draft("260422", [unfixedIssue("unicode_corruption", "subtitle")]),
    ];
    const out = consolidateSignals(drafts);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]._editions, ["260421", "260422"]);
  });

  it("unfixed_issue mesmo reason mas seções diferentes → 2 signals", () => {
    const drafts = [
      draft("260421", [unfixedIssue("unicode_corruption", "subtitle")]),
      draft("260422", [unfixedIssue("unicode_corruption", "title")]),
    ];
    const out = consolidateSignals(drafts);
    assert.equal(out.length, 2);
  });

  it("mistura: 1 consolidado + 1 isolado coexistem", () => {
    const drafts = [
      draft("260421", [sourceStreak("Tecnoblog"), chromeDisconnects(1)]),
      draft("260422", [sourceStreak("Tecnoblog"), unfixedIssue("x", "y")]),
    ];
    const out = consolidateSignals(drafts);
    // Tecnoblog (consolidado) + chrome_disconnects (single) + unfixed (single) = 3
    assert.equal(out.length, 3);
    const tecno = out.find(
      (s) => s.kind === "source_streak" && s.details.source === "Tecnoblog",
    );
    assert.deepEqual(tecno!._editions, ["260421", "260422"]);
  });

  it("single edition: signals ganham _editions de tamanho 1 (shape consistente)", () => {
    const drafts = [
      draft("260421", [sourceStreak("Tecnoblog"), unfixedIssue("x", "y")]),
    ];
    const out = consolidateSignals(drafts);
    assert.equal(out.length, 2);
    for (const s of out) {
      assert.deepEqual(s._editions, ["260421"]);
      assert.equal(s._edition, undefined);
    }
  });

  it("drafts vazio → array vazio", () => {
    assert.deepEqual(consolidateSignals([]), []);
  });

  it("draft com signals vazio → array vazio", () => {
    assert.deepEqual(consolidateSignals([draft("260421", [])]), []);
  });

  it("severity escala quando consolida (low+high → high)", () => {
    const drafts = [
      draft("260421", [sourceStreak("X", { severity: "low" })]),
      draft("260422", [sourceStreak("X", { severity: "high" })]),
    ];
    const out = consolidateSignals(drafts);
    assert.equal(out[0].severity, "high");
  });
});
