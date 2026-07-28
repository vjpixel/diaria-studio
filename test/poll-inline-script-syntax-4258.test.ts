/**
 * test/poll-inline-script-syntax-4258.test.ts (#4258 item 1)
 *
 * Guard sistêmico contra uma classe de bug que já mordeu duas vezes: um
 * template literal TS mal-escapado corrompe o texto do `<script>` inline
 * emitido ao navegador, sem que NENHUM outro teste perceba (os testes
 * existentes fazem regex sobre substrings, nunca parseiam o JS de verdade).
 *
 *   1. Crase dentro de comentário fecha o template literal TS por acidente
 *      (documentado em vários headers deste worker, ex: goNext em jogar.ts).
 *   2. #4258: `\"` dentro de um template literal TS é uma ESCAPE SEQUENCE
 *      válida da gramática de template literals (mesma regra de string
 *      literals) — o compilador consome o `\` e emite só `"` no texto de
 *      saída. Resultado: a string interna do JS client-side
 *      (`setMsg("...", "info")`) recebe uma aspa dupla crua no meio, o
 *      parser do NAVEGADOR quebra com `SyntaxError: missing ) after
 *      argument list`, o listener de submit nunca é registrado, e o form
 *      cai no submit nativo (GET pra própria URL, campos somem). Bug real,
 *      ao vivo em produção entre `45777f57` e o fix desta issue.
 *
 * Fix mecânico: pra emitir um `\"` de verdade no JS client-side a partir de
 * um template literal TS, o `\` também precisa ser escapado (`\\"`) — ou,
 * mais simples e é o que o fix usou aqui, evitar aspas duplas na frase e
 * usar aspas simples.
 *
 * Este teste NÃO garante que a COPY está certa — só que o `<script>`
 * emitido por CADA página do worker `poll` é JAVASCRIPT VÁLIDO
 * (`new Function(js)` não lança `SyntaxError`). Roda contra os renders MAIS
 * ricos possíveis de cada página (todos os parâmetros opcionais
 * preenchidos), pra maximizar quanto texto/branch do script é exercitado —
 * um `<script>` só aparece na saída quando o bloco condicional que o embute
 * é verdadeiro (ex: nicknameForm/resultImages/eiaMeta em votePageHtml).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { votePageHtml } from "../workers/poll/src/index.ts";
import { renderJogarGatePage } from "../workers/poll/src/web-gate.ts";
import {
  renderJogarPageHtml,
  renderJogarSequencePageHtml,
  renderJogarArchiveHtml,
  renderJogarQuizPageHtml,
} from "../workers/poll/src/jogar.ts";
import { renderSharePageHtml, renderQuizSharePageHtml } from "../workers/poll/src/share.ts";
import { renderEmbedPageHtml } from "../workers/poll/src/embed.ts";
import { renderArchiveListHtml, renderArchiveVoteHtml } from "../workers/poll/src/leaderboard-routes.ts";

/** Extrai todo `<script>...</script>` do HTML e valida cada um com `new
 * Function` — mesmo parser (Acorn/V8) que o navegador real usaria; um erro
 * de sintaxe aqui É o mesmo erro que o navegador veria. */
function assertAllScriptsParse(html: string, label: string, expectAtLeastOne = true): void {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (expectAtLeastOne) {
    assert.ok(scripts.length > 0, `${label}: esperava pelo menos 1 <script>, achou 0 — page shape mudou?`);
  }
  for (const [i, js] of scripts.entries()) {
    assert.doesNotThrow(() => new Function(js), (e) => {
      const err = e as Error;
      throw new Error(`${label} [script ${i}]: ${err.message}\n\n${js}`);
    });
  }
}

describe("#4258 item 1: todo <script> inline emitido pelo worker poll é JS válido", () => {
  it("renderJogarGatePage — sem edição e com edição explícita", () => {
    assertAllScriptsParse(renderJogarGatePage(null), "gate (sem edição)");
    assertAllScriptsParse(renderJogarGatePage("260701"), "gate (com edição)");
  });

  it("renderJogarPageHtml (/jogar?edition=X, par único) — revelado e não revelado", () => {
    assertAllScriptsParse(renderJogarPageHtml({ edition: "260701", revealed: false }), "jogar par único (não revelado)");
    assertAllScriptsParse(renderJogarPageHtml({ edition: "260701", revealed: true }), "jogar par único (revelado)");
  });

  it("renderJogarSequencePageHtml (/jogar default, sequência) — com edições e vazia", () => {
    assertAllScriptsParse(renderJogarSequencePageHtml(["260701", "260702", "260703"]), "jogar sequência");
    assertAllScriptsParse(renderJogarSequencePageHtml([]), "jogar sequência (vazia)");
  });

  it("renderJogarArchiveHtml (/jogar/arquivo)", () => {
    assertAllScriptsParse(renderJogarArchiveHtml(["260601", "260602"], "2026"), "jogar arquivo");
  });

  it("renderJogarQuizPageHtml (/jogar/quiz)", () => {
    assertAllScriptsParse(renderJogarQuizPageHtml(["260601", "260602", "260603"]), "jogar quiz");
  });

  it("votePageHtml (/vote) — combinação mais rica: nicknameForm + resultImages + shareCard + eiaMeta", () => {
    const html = votePageHtml(
      "✅ Acertou!",
      true,
      { email: "leitor@example.com", sig: "abc123" },
      { edition: "260701", aiSide: "A", clickedSide: "A" },
      "2026-07",
      "web",
      "1785200000000",
      { token: "share-token-123", payload: { edition: "260701", correct: true } },
      { description: "Uma paisagem urbana futurista.", credit: "Foto: Jane Doe" },
    );
    assertAllScriptsParse(html, "vote (rico)");
  });

  it("votePageHtml (/vote) — caminho mínimo (sem nicknameForm/images/share/eiaMeta)", () => {
    const html = votePageHtml("Você já votou nesta edição.", false, null, null, null, "diaria");
    assertAllScriptsParse(html, "vote (mínimo)");
  });

  it("renderSharePageHtml (/share/{token})", () => {
    const html = renderSharePageHtml({
      token: "share-token-123",
      payload: { edition: "260701", correct: true },
      utmMedium: "whatsapp",
    });
    assertAllScriptsParse(html, "share", false); // página estática, sem <script> inline
  });

  it("renderQuizSharePageHtml (/quiz-share/{token})", () => {
    const html = renderQuizSharePageHtml({
      token: "quiz-share-token-123",
      payload: { score: 8, total: 10, origin: "sequence" },
      utmMedium: "copy",
    });
    assertAllScriptsParse(html, "quiz-share", false); // página estática, sem <script> inline
  });

  it("renderEmbedPageHtml (/embed, iframe de parceiro)", () => {
    assertAllScriptsParse(
      renderEmbedPageHtml({ edition: "260701", revealed: true, partnerSlug: "parceiro-teste" }),
      "embed",
    );
  });

  it("renderArchiveListHtml (/leaderboard/{ano}/arquivo)", async () => {
    const res = renderArchiveListHtml(["260601", "260602"], "2026", "web");
    assertAllScriptsParse(await res.text(), "archive list", false); // página estática, sem <script> inline
  });

  it("renderArchiveVoteHtml (/leaderboard/{ano}/arquivo/{edição})", async () => {
    const res = renderArchiveVoteHtml("260601", "2026", "web");
    assertAllScriptsParse(await res.text(), "archive vote");
  });
});

describe("#4258 item 1 (regressão pontual): a mensagem de pending do gate parseia", () => {
  it("renderJogarGatePage contém a mensagem 'Quase lá!' sem quebrar o script (aspas simples, não escapadas)", () => {
    const html = renderJogarGatePage(null);
    assert.match(html, /Quase lá!/, "sanity: a mensagem ainda existe no output");
    assertAllScriptsParse(html, "gate");
  });
});
