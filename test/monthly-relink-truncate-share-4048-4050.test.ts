/**
 * test/monthly-relink-truncate-share-4048-4050.test.ts (#4048, #4050)
 *
 * #4048: só o wiring do relink pra edição diária (`relinkMonthlyEditionHtml`)
 * — link reescrito quando há mapeamento, preservado (não quebra) quando não
 * há. O truncamento dos destaques (`renderDestaqueTeaser`) foi revertido a
 * pedido do editor (260727, sessão pós-preview) — destaques voltam a
 * renderizar o corpo INTEIRO, sem "Leia mais". Cobrimos isso abaixo como
 * regressão negativa.
 *
 * #4050: os blocos de compartilhamento WhatsApp (`renderEncerramento` item 1,
 * `renderEia` item 2) foram removidos, mesmo pedido do editor. Cobrimos como
 * regressão negativa — nenhuma das duas funções deve emitir `wa.me`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderDestaque,
  renderEncerramento,
  renderEia,
  draftToEmail,
} from "../scripts/lib/mensal/monthly-render.ts";
import { relinkMonthlyEditionHtml } from "../scripts/monthly-relink-to-diaria.ts";

// ─── #4048: relink pós-processo (mantido) ───────────────────────────────────

describe("relinkMonthlyEditionHtml (#4048) — relink dos destaques pra edição diária", () => {
  function makeMonthlyDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "monthly-relink-test-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    return dir;
  }
  function makeRoot(postsIndex: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "monthly-relink-root-"));
    mkdirSync(join(root, "data/beehiiv-cache/posts"), { recursive: true });
    writeFileSync(join(root, "data/beehiiv-cache/posts/index.json"), JSON.stringify(postsIndex));
    return root;
  }

  it("reescreve o link do destaque pra edição diária quando há mapeamento", () => {
    const monthlyDir = makeMonthlyDir();
    writeFileSync(
      join(monthlyDir, "_internal/raw-destaques.json"),
      JSON.stringify({
        destaques: [
          { url: "https://exemplo.com/noticia-completa", edition: "260601", beehiiv_post_id: "abc12345" },
        ],
      }),
    );
    const root = makeRoot([{ id: "abc12345", web_url: "https://diar.ia.br/p/edicao-260601" }]);

    const html = `<p><a href="https://exemplo.com/noticia-completa">Leia mais →</a></p>`;
    const r = relinkMonthlyEditionHtml(html, monthlyDir, root);
    assert.equal(r.relinked, 1);
    assert.match(r.html, /href="https:\/\/diar\.ia\.br\/p\/edicao-260601\?utm_source=clarice/);
    assert.doesNotMatch(r.html, /exemplo\.com/);
  });

  it("fallback gracioso: link SEM mapeamento é preservado (não quebra, não descarta)", () => {
    const monthlyDir = makeMonthlyDir();
    writeFileSync(
      join(monthlyDir, "_internal/raw-destaques.json"),
      JSON.stringify({ destaques: [] }), // nenhum destaque conhecido
    );
    const root = makeRoot([]);
    const html = `<p><a href="https://exemplo.com/outra-noticia">Leia mais →</a></p>`;
    const r = relinkMonthlyEditionHtml(html, monthlyDir, root);
    assert.equal(r.relinked, 0);
    assert.equal(r.naoMapeado, 1);
    assert.match(r.html, /href="https:\/\/exemplo\.com\/outra-noticia"/); // preservado, não quebrado
  });

  it("sem raw-destaques.json, lança — caller (monthly-preview-cloudflare.ts) trata fail-soft", () => {
    const monthlyDir = makeMonthlyDir(); // sem escrever raw-destaques.json
    const root = makeRoot([]);
    assert.throws(() => relinkMonthlyEditionHtml("<p>x</p>", monthlyDir, root));
  });
});

// ─── Regressão: truncamento revertido (260727) ──────────────────────────────

describe("renderDestaque — SEM truncamento (revertido, 260727)", () => {
  it("corpo longo renderiza por INTEIRO — sem 'Leia mais', sem corte", () => {
    const longSentence = "Esta é uma frase bem longa sobre a rodada de investimento, com bastante contexto sobre valuation, investidores e planos futuros da empresa, repetida propositalmente. ";
    const chunk = [
      "DESTAQUE 1 | ANTHROPIC",
      "Anthropic capta bilhões em nova rodada",
      "",
      longSentence.repeat(3) + "[Fonte original](https://anthropic.com/news/exemplo) tem mais detalhes.",
      "",
      "O fio condutor: essa rodada consolida a Anthropic como líder do setor.",
    ].join("\n");
    const html = renderDestaque(chunk);
    assert.doesNotMatch(html, /Leia mais/);
    // corpo completo presente, não truncado — a última frase do parágrafo original aparece inteira.
    assert.match(html, /tem mais detalhes/);
    assert.match(html, /O fio condutor/);
  });
});

// ─── Regressão: compartilhamento WhatsApp removido (260727) ────────────────

describe("renderEncerramento / renderEia — SEM bloco de WhatsApp (removido, 260727)", () => {
  it("renderEncerramento nunca emite wa.me, com ou sem ciclo setado", () => {
    const html1 = renderEncerramento("Obrigado por ler.\n\nAté a próxima edição!");
    assert.doesNotMatch(html1, /wa\.me/);

    const draft = [
      "ASSUNTO",
      "1. Assunto de teste",
      "",
      "PREVIEW",
      "preview",
      "",
      "INTRO",
      "intro",
      "",
      "PARA ENCERRAR",
      "Obrigado por ler.",
      "",
      "Até a próxima edição!",
    ].join("\n");
    const { html: html2 } = draftToEmail(draft, null, "2606");
    assert.doesNotMatch(html2, /wa\.me/);
  });

  it("renderEia nunca emite wa.me", () => {
    const chunk = "É IA?\nLegenda de teste.";
    const html = renderEia(chunk, "2606", "https://img/a.jpg", "https://img/b.jpg");
    assert.match(html, /Ver ranking/);
    assert.doesNotMatch(html, /wa\.me/);
  });
});
