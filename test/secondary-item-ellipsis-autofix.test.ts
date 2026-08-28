/** Regression coverage for issue #6441 — mechanical fabricated-ellipsis autofix. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planEllipsisRestore,
  applySecondaryItemEllipsisAutofix,
} from "../scripts/lib/lint-checks/secondary-item-ellipsis-autofix.ts";

function radar(description: string, url = "https://example.com/reduzindo"): string {
  return `**📡 RADAR**\n\n**[Item](${url})**\n${description}\n`;
}

describe("planEllipsisRestore (#6441)", () => {
  it("(a) restores the missing tail when the summary is intact and shares the description's prefix — the exact #6441 example", () => {
    const plan = planEllipsisRestore(
      "A ferramenta promete reduzindo…",
      "A ferramenta promete reduzindo semanas de integração para horas.",
    );
    assert.ok("fixedDescription" in plan);
    if ("fixedDescription" in plan) {
      assert.equal(
        plan.fixedDescription,
        "A ferramenta promete reduzindo semanas de integração para horas.",
      );
      // Self-review guard: never worse than the original — never empty,
      // never still ending in the fabricated ellipsis.
      assert.ok(plan.fixedDescription.length > 0);
      assert.ok(!/(?:\.{2,}|…)\s*$/u.test(plan.fixedDescription));
    }
  });

  it("(b) refuses to restore when the summary is ALSO truncated (saudedigitalnews RSS-garbage shape) — nothing to paste", () => {
    const plan = planEllipsisRestore(
      "...e o post Título apareceu…",
      "...e&#8230; O post Título apareceu primeiro em Fonte...",
    );
    assert.deepEqual(plan, { unresolved: "summary_truncated" });
  });

  it("refuses to guess when the description's pre-ellipsis text doesn't match a prefix of the summary", () => {
    const plan = planEllipsisRestore(
      "Um resumo completamente diferente…",
      "A ferramenta promete reduzindo semanas de integração para horas.",
    );
    assert.deepEqual(plan, { unresolved: "no_prefix_match" });
  });
});

describe("applySecondaryItemEllipsisAutofix (#6441)", () => {
  it("(a) applies the fix in place and the result no longer ends in ellipsis", () => {
    const approved = {
      radar: [
        {
          url: "https://example.com/reduzindo",
          article: {
            summary: "A ferramenta promete reduzindo semanas de integração para horas.",
          },
        },
      ],
    };
    const md = radar("A ferramenta promete reduzindo…");
    const result = applySecondaryItemEllipsisAutofix(md, approved);

    assert.equal(result.changed, true);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].status, "applied");
    assert.ok(
      result.content.includes(
        "A ferramenta promete reduzindo semanas de integração para horas.",
      ),
    );
    assert.ok(!result.content.includes("reduzindo…"));
  });

  it("(b) leaves the RSS-garbage case untouched — still ends in ellipsis, gate-blocking stays meaningful at Stage 4", () => {
    const approved = {
      radar: [
        {
          url: "https://example.com/saudedigitalnews",
          article: {
            summary: "...e&#8230; O post Título apareceu primeiro em Fonte...",
          },
        },
      ],
    };
    const md = radar(
      "...e o post apareceu…",
      "https://example.com/saudedigitalnews",
    );
    const result = applySecondaryItemEllipsisAutofix(md, approved);

    assert.equal(result.changed, false);
    assert.equal(result.content, md);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].status, "unresolved_summary_truncated");
    // Never produces something worse than the original — original text
    // (still truncated, still visibly needing manual rewrite) is preserved
    // verbatim rather than being silently "fixed" with garbage.
    assert.ok(result.content.includes("...e o post apareceu…"));
  });

  it("skips items whose approved summary is unavailable, without touching the file", () => {
    const md = radar("Texto sem summary…", "https://example.com/missing");
    const result = applySecondaryItemEllipsisAutofix(md, {});
    assert.equal(result.changed, false);
    assert.equal(result.entries[0].status, "skipped_summary_unavailable");
  });

  it("does nothing when no description ends in ellipsis", () => {
    const md = radar("Descrição completa, sem truncamento.");
    const result = applySecondaryItemEllipsisAutofix(md, {});
    assert.equal(result.changed, false);
    assert.equal(result.entries.length, 0);
  });
});
