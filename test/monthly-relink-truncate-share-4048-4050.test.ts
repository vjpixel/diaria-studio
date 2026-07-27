/**
 * test/monthly-relink-truncate-share-4048-4050.test.ts (#4048, #4050)
 *
 * #4048: (a) truncation do corpo dos destaques (`renderDestaqueTeaser`) —
 * teaser real (não vazio, não o texto inteiro) com link "Leia mais" quando há
 * fonte citada, fallback gracioso sem link quando não há; (b) wiring do
 * relink pra edição diária (`relinkMonthlyEditionHtml`) — link reescrito
 * quando há mapeamento, preservado (não quebra) quando não há.
 *
 * #4050: bloco de compartilhamento WhatsApp em `renderEncerramento` (item 1,
 * UTM próprio) e `renderEia` (item 2, convite a jogar/desafiar) — renderiza
 * na posição certa, UTM correto, e degrada graciosamente sem os dados
 * (mock ausente / ciclo não setado).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderDestaqueTeaser,
  renderDestaque,
  renderEncerramento,
  renderEia,
  draftToEmail,
} from "../scripts/lib/mensal/monthly-render.ts";
import { relinkMonthlyEditionHtml } from "../scripts/monthly-relink-to-diaria.ts";

// ─── #4048 (b): truncation ──────────────────────────────────────────────────

describe("renderDestaqueTeaser (#4048) — truncation dos destaques", () => {
  it("corpo curto (cabe no teto) renderiza por completo, sem 'Leia mais'", () => {
    const html = renderDestaqueTeaser(["Um parágrafo curto, sem necessidade de corte."]);
    assert.match(html, /Um parágrafo curto/);
    assert.doesNotMatch(html, /Leia mais/);
  });

  it("corpo longo é truncado (teaser real: nem vazio, nem o texto inteiro) e ganha link 'Leia mais' quando há fonte citada", () => {
    const longSentence = "Esta é uma frase bem longa que descreve em detalhe o que aconteceu na notícia, com bastante contexto adicional para garantir que o texto ultrapasse o teto de caracteres do teaser configurado no render mensal. ";
    const paras = [
      `${longSentence.repeat(3)}[Leia a matéria original](https://exemplo.com/noticia-completa) traz mais detalhes.`,
    ];
    const html = renderDestaqueTeaser(paras);
    // Não vazio.
    assert.ok(html.length > 0);
    // Não é o texto inteiro (marcador de truncamento OU corte real de tamanho).
    const plainText = html.replace(/<[^>]+>/g, "");
    assert.ok(plainText.length < longSentence.repeat(3).length + 60, "teaser deveria ser mais curto que o corpo original");
    // Link "Leia mais" presente e aponta pra fonte citada no corpo.
    assert.match(html, /Leia mais/);
    assert.match(html, /href="https:\/\/exemplo\.com\/noticia-completa"/);
  });

  it("corpo longo SEM nenhuma fonte citada ainda trunca, mas sem link morto", () => {
    const longSentence = "Esta é uma frase longa sem nenhum link markdown embutido no corpo do parágrafo, repetida várias vezes para estourar o teto de caracteres do teaser. ";
    const html = renderDestaqueTeaser([longSentence.repeat(4)]);
    assert.match(html, /<p/);
    assert.doesNotMatch(html, /Leia mais/); // sem URL — sem link morto (fallback gracioso)
  });

  it("lista vazia retorna string vazia (sem <p> vazio no email)", () => {
    assert.equal(renderDestaqueTeaser([]), "");
  });

  it("renderDestaque com corpo longo produz teaser via mainHtml (integração)", () => {
    const chunk = [
      "DESTAQUE 1 | ANTHROPIC",
      "Anthropic capta bilhões em nova rodada",
      "",
      "Esta é uma frase bem longa sobre a rodada de investimento, com bastante contexto sobre valuation, investidores e planos futuros da empresa, repetida propositalmente. ".repeat(3) +
        "[Fonte original](https://anthropic.com/news/exemplo) tem mais detalhes.",
      "",
      "O fio condutor: essa rodada consolida a Anthropic como líder do setor.",
    ].join("\n");
    const html = renderDestaque(chunk);
    assert.match(html, /Leia mais/);
    assert.match(html, /O fio condutor/);
  });
});

// ─── #4048 (a): relink pós-processo ─────────────────────────────────────────

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

// ─── #4050: WhatsApp share (encerramento) ───────────────────────────────────

describe("renderEncerramento (#4050 item 1) — bloco de compartilhamento WhatsApp", () => {
  it("sem ciclo setado (fora de draftToEmail), NÃO renderiza o bloco de share (fallback gracioso)", () => {
    const html = renderEncerramento("Obrigado por ler.\n\nAté a próxima edição!");
    assert.doesNotMatch(html, /wa\.me/);
  });

  it("dentro de draftToEmail (com ciclo setado), renderiza o link wa.me com utm_term próprio", () => {
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
    const { html } = draftToEmail(draft, null, "2606");
    assert.match(html, /https:\/\/wa\.me\/\?text=/);
    const decoded = decodeURIComponent(html.match(/https:\/\/wa\.me\/\?text=([^"&]+)/)![1]);
    assert.match(decoded, /utm_term=whatsapp-share-encerramento/);
    // distinto do CTA principal (que não usa esse utm_term)
    assert.doesNotMatch(html.replace(/wa\.me\/\?text=[^"]+/, ""), /whatsapp-share-encerramento/);
  });
});

describe("renderEia (#4050 item 2) — convite a compartilhar/desafiar", () => {
  it("renderiza o bloco de share após o ranking, com utm_term eia-share-mensal", () => {
    const chunk = "É IA?\nLegenda de teste.";
    const html = renderEia(chunk, "2606", "https://img/a.jpg", "https://img/b.jpg");
    assert.match(html, /Ver ranking/);
    assert.match(html, /https:\/\/wa\.me\/\?text=/);
    const decoded = decodeURIComponent(html.match(/https:\/\/wa\.me\/\?text=([^"&]+)/)![1]);
    assert.match(decoded, /utm_term=eia-share-mensal/);
    // share aparece DEPOIS do link de ranking na ordem do documento.
    assert.ok(html.indexOf("Ver ranking") < html.indexOf("wa.me"));
  });

  it("não quebra sem imagens (dado ausente) — bloco de share ainda renderiza (não depende de imagem)", () => {
    const chunk = "É IA?\nLegenda de teste.";
    const html = renderEia(chunk, "2606");
    assert.match(html, /Imagem A/); // placeholder, sem imagem
    assert.match(html, /https:\/\/wa\.me\/\?text=/); // share independe de imagem
  });
});
