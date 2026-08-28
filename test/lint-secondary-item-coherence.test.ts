/** Regression coverage for issue #5663 secondary-item coherence guards. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkSecondaryItemCoherence,
  secondaryItemCoherenceSeverity, // #6441
  isFabricatedEllipsisRecoverable, // #6441
  type SecondaryItemCoherenceReport,
} from "../scripts/lib/lint-checks/secondary-item-coherence.ts";

const approved = {
  radar: [
    {
      url: "https://example.com/quote",
      article: {
        title: "Golpe usa nome da Defensoria",
        summary:
          '“Não são super tecnologias. Inteligência artificial e modelos que são utilizados no dia a dia, que podem ser acessados de forma barata”, explica Borges.',
      },
    },
    {
      url: "https://example.com/ellipsis",
      article: {
        title: "Uso excessivo de IA",
        summary: "O uso excessivo pode comprometer a reputação profissional.",
      },
    },
  ],
};

function radar(description: string, url = "https://example.com/quote"): string {
  return `**📡 RADAR**\n\n**[Item](${url})**\n${description}\n`;
}

describe("checkSecondaryItemCoherence (#5663)", () => {
  it("flags an unclosed quoted fragment", () => {
    const result = checkSecondaryItemCoherence(
      radar('"Não são super tecnologias.'),
      approved,
    );
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].kind, "unbalanced-quote");
  });

  it("flags an ellipsis absent from the raw summary", () => {
    const result = checkSecondaryItemCoherence(
      radar('O uso pode comprometer a reputação…', "https://example.com/ellipsis"),
      approved,
    );
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].kind, "fabricated-ellipsis");
  });

  it("accepts a complete quote and source ellipsis", () => {
    const withSourceEllipsis = {
      radar: [{
        url: "https://example.com/quote",
        article: { summary: 'A fonte diz “algo”…' },
      }],
    };
    assert.equal(
      checkSecondaryItemCoherence(radar('A fonte diz “algo”…'), withSourceEllipsis).ok,
      true,
    );
    assert.equal(
      checkSecondaryItemCoherence(
        radar('“Não são super tecnologias”, explica Borges.'),
        approved,
      ).ok,
      true,
    );
  });

  it("ignores items whose approved summary is unavailable", () => {
    assert.equal(
      checkSecondaryItemCoherence(
        radar('Texto “curto”…', "https://example.com/missing"),
        approved,
      ).ok,
      true,
    );
  });
});

describe("secondaryItemCoherenceSeverity (#6441)", () => {
  it("marks a fabricated-ellipsis error as recoverable (summary intact — the only shape this check raises today)", () => {
    const result = checkSecondaryItemCoherence(
      radar('O uso pode comprometer a reputação…', "https://example.com/ellipsis"),
      approved,
    );
    assert.equal(result.errors[0].kind, "fabricated-ellipsis");
    assert.equal(result.errors[0].recoverable, true);
    // (a) autofix already had a chance to fix this at Stage 2 — Stage 4
    // downgrades to warn-only instead of blocking the gate.
    assert.equal(secondaryItemCoherenceSeverity(result), "warn-only");
  });

  it("keeps unbalanced-quote gate-blocking regardless of recoverability", () => {
    const result = checkSecondaryItemCoherence(
      radar('"Não são super tecnologias.'),
      approved,
    );
    assert.equal(result.errors[0].kind, "unbalanced-quote");
    assert.equal(secondaryItemCoherenceSeverity(result), "gate-blocking");
  });

  it("returns gate-blocking for a synthetic irrecoverable fabricated-ellipsis (summary also truncated — the saudedigitalnews RSS-garbage shape from #6441)", () => {
    // (b) checkSecondaryItemCoherence itself never raises this exact
    // combination — a summary that ALSO ends in ellipsis satisfies
    // `!ELLIPSIS_RE.test(summary) === false`, so no error fires at all
    // (correctly: this check can't tell a legit source ellipsis from RSS
    // garbage, see the module docstring). That's why this is a synthetic
    // report: it exercises the SEVERITY resolver directly, which is the
    // new logic added by #6441 and the piece responsible for "gate-blocking
    // maintained" once an irrecoverable case IS present in a report.
    assert.equal(
      isFabricatedEllipsisRecoverable("...e… O post Título apareceu primeiro em Fonte..."),
      false,
    );
    const syntheticReport: SecondaryItemCoherenceReport = {
      ok: false,
      skipped: 0,
      errors: [
        {
          kind: "fabricated-ellipsis",
          recoverable: false,
          section: "RADAR",
          line: 3,
          titleExcerpt: "saudedigitalnews",
          descriptionExcerpt: "...e… O post Título apareceu primeiro em Fonte...",
          url: "https://example.com/saudedigitalnews",
        },
      ],
    };
    assert.equal(secondaryItemCoherenceSeverity(syntheticReport), "gate-blocking");
  });
});
