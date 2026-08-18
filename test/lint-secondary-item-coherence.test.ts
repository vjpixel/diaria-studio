/** Regression coverage for issue #5663 secondary-item coherence guards. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkSecondaryItemCoherence } from "../scripts/lib/lint-checks/secondary-item-coherence.ts";

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
