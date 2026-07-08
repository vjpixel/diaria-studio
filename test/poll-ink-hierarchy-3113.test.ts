/**
 * test/poll-ink-hierarchy-3113.test.ts (#3113 item 6)
 *
 * O DS canônico da Diar.ia aboliu cinzas via opacity (`design-tokens.ts`:
 * "não há cinzas na paleta" — texto secundário é sempre ink, hierarquia vem
 * de tamanho/peso). As páginas do jogo "É IA?" (`workers/poll/src`) ainda
 * usavam `rgba(23,20,17,X)` em vários lugares (kicker, sub-copy, th, criteria
 * text, nickname form, label do resultado) — os únicos "cinzas" remanescentes
 * no DS. Fix: todos viram `${DS_COLORS.ink}` sólido.
 *
 * Guarda de regressão: nenhum literal `rgba(23,20,17,` deve sobreviver nos
 * arquivos de origem do worker `poll`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  "workers/poll/src/index.ts",
  "workers/poll/src/leaderboard-routes.ts",
];

describe("#3113 item 6 — sem cinzas via rgba(23,20,17,X) no worker poll", () => {
  for (const rel of FILES) {
    it(`${rel} não contém rgba(23,20,17,...)`, () => {
      const src = readFileSync(resolve(ROOT, rel), "utf8");
      assert.doesNotMatch(src, /rgba\(23,\s*20,\s*17,/, `${rel} ainda usa cinza via opacity`);
    });
  }
});

describe("#3113 item 6 — HTML gerado usa ink sólido em vez de rgba", () => {
  it("renderLeaderboardHtml (via /leaderboard): kicker, sub, th e texto de critérios são ink sólido", async () => {
    const { default: worker } = await import("../workers/poll/src/index.ts");
    const env = {
      POLL: {
        get: async () => null,
        list: async () => ({ keys: [], list_complete: true }),
        put: async () => {},
      } as unknown,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin",
      ALLOWED_ORIGINS: "*",
    };
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard"),
      env as never,
      {} as never,
    );
    const html = await res.text();
    assert.doesNotMatch(html, /rgba\(23,\s*20,\s*17,/);
    assert.match(html, /\.kicker \{[^}]*color:\s*#171411/);
    assert.match(html, /p\.sub \{[^}]*color:\s*#171411/);
  });

  it("renderArchiveVoteHtml: sub-copy é ink sólido", async () => {
    const { renderArchiveVoteHtml } = await import("../workers/poll/src/leaderboard-routes.ts");
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    assert.doesNotMatch(html, /rgba\(23,\s*20,\s*17,/);
    assert.match(html, /p\.sub \{[^}]*color:\s*#171411/);
  });

  it("votePageHtml: label do resultado, nick-explain e nick-note são ink sólido", async () => {
    const { votePageHtml } = await import("../workers/poll/src/index.ts");
    const html = votePageHtml(
      "Acertou!",
      true,
      { email: "a@x.com", sig: "sig123" },
      { edition: "260707", aiSide: "A", clickedSide: "A" },
      null,
      "diaria",
    );
    assert.doesNotMatch(html, /rgba\(23,\s*20,\s*17,/);
    assert.match(html, /\.result-image \.label \{[^}]*color:\s*#171411/);
    assert.match(html, /\.nick-explain \{[^}]*color:\s*#171411/);
    assert.match(html, /\.nick-note \{[^}]*color:\s*#171411/);
  });
});
