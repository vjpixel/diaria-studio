/**
 * test/poll-shell-footer-mobile-3113.test.ts (#3113)
 *
 * Regressão para 3 achados do lote de cleanup/P3 (issue #3113) no Worker
 * `poll` (jogo "É IA?"):
 *
 *   Item 5 — Shell editorial ausente (régua teal + rodapé de marca) no
 *   leaderboard (`renderLeaderboardHtml`) e no arquivo (`renderArchiveListHtml`)
 *   — antes, só o `<title>` carregava identidade. Fix: `<hr class="rule">`
 *   entre o kicker e o `<h1>`, e `<footer>` com link pro site do brand antes
 *   do `</body>`.
 *
 *   Item 8 — Mobile do pré-voto do arquivo (`renderArchiveVoteHtml`): o layout
 *   ANTERIOR empilhava as 2 escolhas em largura total abaixo de 600px
 *   (`.choice { flex-basis: 100%; }`), permitindo votar em A sem nunca rolar
 *   até ver a imagem B. Fix: mantém as 2 escolhas lado a lado (menores) no
 *   mobile em vez de empilhar — ambas ficam visíveis sem scroll.
 *
 *   Item 11 — Rodapé de marca ausente na página de voto do arquivo
 *   (`renderArchiveVoteHtml`) — igual ao item 5, mas só o rodapé (a página de
 *   voto não ganha kicker/régua — fora do escopo pedido pela issue).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderArchiveListHtml,
  renderArchiveVoteHtml,
} from "../workers/poll/src/leaderboard-routes.ts";
import { renderRuleStyles, renderFooterStyles, renderBrandFooter } from "../workers/poll/src/lib.ts";

async function fetchHtml(path: string): Promise<string> {
  const { default: worker } = await import("../workers/poll/src/index.ts");
  const env = {
    POLL: {
      get: async () => null,
      list: async () => ({ keys: [], list_complete: true }),
    } as unknown,
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
  const res = await worker.fetch(
    new Request(`https://poll.diaria.workers.dev${path}`),
    env as never,
    {} as never,
  );
  return res.text();
}

describe("lib.ts — helpers de shell (#3113)", () => {
  it("renderRuleStyles produz a régua teal", () => {
    assert.match(renderRuleStyles(), /\.rule\s*\{[^}]*background:\s*#00A0A0/);
  });

  it("renderFooterStyles produz border-top + font-size do rodapé", () => {
    const css = renderFooterStyles();
    assert.match(css, /footer\s*\{[^}]*border-top:/);
  });

  it("renderBrandFooter(diaria) linka pro diar.ia.br", () => {
    const html = renderBrandFooter("diaria");
    assert.match(html, /<footer>.*<a href="https:\/\/diar\.ia\.br">Diar\.ia<\/a>.*<\/footer>/);
  });

  it("renderBrandFooter(clarice) linka pro clarice.ai (usa shortName, não 'Clarice News' inteiro)", () => {
    const html = renderBrandFooter("clarice");
    assert.match(html, /<a href="https:\/\/clarice\.ai\/\?via=diaria">Clarice<\/a>/);
  });
});

describe("#3113 item 5 — régua + rodapé no leaderboard e no arquivo (lista)", () => {
  it("GET /leaderboard: régua entre kicker e h1, rodapé antes de </body>", async () => {
    const html = await fetchHtml("/leaderboard");
    const kickerIdx = html.indexOf('<p class="kicker">');
    const ruleIdx = html.indexOf('<hr class="rule">');
    const h1Idx = html.indexOf("<h1>");
    const footerIdx = html.indexOf("<footer>");
    const bodyCloseIdx = html.indexOf("</body>");
    assert.ok(kickerIdx >= 0 && ruleIdx >= 0 && h1Idx >= 0, "kicker, régua e h1 devem existir");
    assert.ok(kickerIdx < ruleIdx && ruleIdx < h1Idx, "ordem deve ser kicker -> régua -> h1");
    assert.ok(footerIdx >= 0 && footerIdx < bodyCloseIdx, "footer deve existir antes de </body>");
    assert.match(html, /<a href="https:\/\/diar\.ia\.br">Diar\.ia<\/a>/);
  });

  it("GET /leaderboard/2026/arquivo: régua entre kicker e h1, rodapé antes de </body>", async () => {
    const html = await fetchHtml("/leaderboard/2026/arquivo");
    const kickerIdx = html.indexOf('<p class="kicker">');
    const ruleIdx = html.indexOf('<hr class="rule">');
    const h1Idx = html.indexOf("<h1>");
    const footerIdx = html.indexOf("<footer>");
    assert.ok(kickerIdx >= 0 && ruleIdx >= 0 && h1Idx >= 0);
    assert.ok(kickerIdx < ruleIdx && ruleIdx < h1Idx, "ordem deve ser kicker -> régua -> h1");
    assert.ok(footerIdx >= 0, "footer deve existir no arquivo (lista)");
  });
});

describe("#3113 item 11 — rodapé de marca na página de voto do arquivo", () => {
  it("renderArchiveVoteHtml inclui footer com link pro brand antes de </body>", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    const footerIdx = html.indexOf("<footer>");
    const bodyCloseIdx = html.indexOf("</body>");
    assert.ok(footerIdx >= 0 && footerIdx < bodyCloseIdx, "footer deve existir antes de </body>");
    assert.match(html, /<a href="https:\/\/diar\.ia\.br">Diar\.ia<\/a>/);
  });

  it("brand clarice: footer linka pro clarice.ai", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "clarice");
    const html = await res.text();
    assert.match(html, /<a href="https:\/\/clarice\.ai\/\?via=diaria">Clarice<\/a>/);
  });
});

describe("#3113 item 8 — mobile do pré-voto mantém as 2 escolhas visíveis (sem empilhar)", () => {
  it("CSS mobile NÃO faz .choice virar largura total (regressão do bug: votar em A sem ver B)", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    assert.doesNotMatch(
      html,
      /@media \(max-width: 600px\)\s*\{[^}]*\.choice\s*\{[^}]*flex-basis:\s*100%/s,
      "mobile não deve mais forçar .choice a 100% de largura (isso escondia a imagem B sem scroll)",
    );
  });

  it("CSS mobile mantém .choices lado a lado (flex, sem wrap forçado pra coluna única)", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    // Isola só o bloco @media (a regex de rules internas usa [^}]*, que não
    // atravessa a chave de fechamento de .choices {} aninhada dentro dela).
    const mediaBlock = html.slice(html.indexOf("@media (max-width: 600px)"), html.indexOf("</style>"));
    assert.match(
      mediaBlock,
      /\.choice\s*\{\s*flex:\s*1 1 0;\s*max-width:\s*none;\s*\}/,
      "mobile deve dividir o espaço disponível entre as 2 escolhas (lado a lado, ambas visíveis sem scroll)",
    );
  });

  it("desktop (fora da media query) continua com o layout original (240-260px por escolha)", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    assert.match(html, /\.choice\s*\{\s*flex:\s*1 1 240px;\s*max-width:\s*260px;\s*\}/);
  });
});
