/**
 * test/agent-issue-validator.test.ts (#1421, #2013)
 *
 * Cobre o filter determinístico de issues do review-test-email contra
 * falso-positivos de encoding, truncamento, e FPs de design system.
 * Casos derivados literal do caso 260520 (#1421) e 260610 (#2013).
 *
 * Regra de ouro: testes NUNCA fazem fetch real — fetchFn é sempre mockado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractQuotedTerms,
  isEncodingDropFalsePositive,
  isPollSigMissingFalsePositive,
  isVoteEditionMalformedFalsePositive,
  isBoldMissingFalsePositive,
  isItalicMissingFalsePositive,
  isMergeTagUnexpandedFalsePositive,
  isEncodingDropSectionEmojiByDesign,
  isEncodingDropCalloutMarkerByDesign,
  isSectionMissingFalsePositive,
  isLinkDeadFalsePositive,
  extractLinkDeadUrl,
  filterAgentIssues,
  type FetchFn,
} from "../scripts/lib/agent-issue-validator.ts";

describe("extractQuotedTerms (#1421)", () => {
  it("extrai múltiplos termos entre aspas simples", () => {
    const issue = "email:encoding_drop: 'é' em 'pré-treino' / 'pré-treinamento' pode estar corrompido";
    assert.deepEqual(extractQuotedTerms(issue), ["é", "pré-treino", "pré-treinamento"]);
  });

  it("retorna [] quando não há aspas", () => {
    assert.deepEqual(extractQuotedTerms("email:encoding_drop: corrupted body"), []);
  });
});

describe("isEncodingDropFalsePositive (#1421)", () => {
  it("#1421: caso 260520 — termos presentes no HTML local com acentos OK", () => {
    const html = "<p>Karpathy entra no time de pré-treino da Anthropic</p>";
    const issue = "email:encoding_drop: 'pré-treino' pode estar corrompido";
    const r = isEncodingDropFalsePositive(issue, html);
    assert.equal(r.falsePositive, true);
    if (r.falsePositive) {
      assert.match(r.reason, /pré-treino/);
    }
  });

  it("não-falso-positivo quando termo de fato falta no HTML", () => {
    const html = "<p>Karpathy entra no time da Anthropic</p>";
    const issue = "email:encoding_drop: 'pré-treino' pode estar corrompido";
    const r = isEncodingDropFalsePositive(issue, html);
    assert.equal(r.falsePositive, false);
  });

  it("issue sem termos entre aspas → não dá pra validar (mantém)", () => {
    const r = isEncodingDropFalsePositive("email:encoding_drop: corruption", "<p>anything</p>");
    assert.equal(r.falsePositive, false);
  });

  it("múltiplos termos: 1 ausente → não é falso-positivo (mantém issue)", () => {
    const html = "<p>pré-treino sim, funcionários NÃO</p>";
    // O HTML acima tem 'pré-treino' e 'funcionários'. Vamos forçar caso onde 1 falta:
    const html2 = "<p>pré-treino sim</p>";
    const issue = "email:encoding_drop: 'pré-treino' e 'funcionários' corrompidos";
    const r = isEncodingDropFalsePositive(issue, html2);
    assert.equal(r.falsePositive, false);
  });
});

describe("isPollSigMissingFalsePositive (#1421)", () => {
  it("#1421: caso 260520 — {{poll_sig}} merge tag presente no HTML local", () => {
    const html = '<a href="https://poll.diaria.workers.dev/vote?sig={{poll_sig}}">vote</a>';
    const r = isPollSigMissingFalsePositive(html);
    assert.equal(r.falsePositive, true);
  });

  it("sig= como URL param já resolvido também conta", () => {
    const html = '<a href="https://poll.diaria.workers.dev/vote?sig=abc123">vote</a>';
    const r = isPollSigMissingFalsePositive(html);
    assert.equal(r.falsePositive, true);
  });

  it("HTML realmente sem merge tag nem sig → não-falso-positivo (válido)", () => {
    const html = "<p>just body, no vote link</p>";
    const r = isPollSigMissingFalsePositive(html);
    assert.equal(r.falsePositive, false);
  });
});

describe("isVoteEditionMalformedFalsePositive (#1421)", () => {
  it("#1421: caso 260520 — edition=260520 presente no HTML mas agent leu como &edition&0520", () => {
    const html = '<a href="...&amp;edition=260520&amp;choice=A">vote</a>';
    const r = isVoteEditionMalformedFalsePositive(html, "260520");
    assert.equal(r.falsePositive, true);
  });

  it("não-falso-positivo quando edition= de fato malformed", () => {
    const html = '<a href="...&amp;edition&amp;0520">vote</a>';
    const r = isVoteEditionMalformedFalsePositive(html, "260520");
    assert.equal(r.falsePositive, false);
  });
});

describe("#1949 — FPs do novo DS + merge tags", () => {
  it("isBoldMissingFalsePositive: 'título sem negrito' é FP (DS serif sem bold)", () => {
    assert.equal(isBoldMissingFalsePositive("email:formatting: D2 título sem negrito").falsePositive, true);
    assert.equal(isBoldMissingFalsePositive("email:formatting: link sem diferenciação").falsePositive, false);
  });

  it("isItalicMissingFalsePositive: 'não está em itálico' é FP (DS sans sem itálico)", () => {
    assert.equal(
      isItalicMissingFalsePositive("email:formatting: seção É IA? crédito não está em itálico").falsePositive,
      true,
    );
    // italic_literal (`*texto*` não convertido) é bug REAL — NÃO é FP
    assert.equal(
      isItalicMissingFalsePositive("email:italic_literal: '*Canis aureus*' literal").falsePositive,
      false,
    );
  });

  it("isMergeTagUnexpandedFalsePositive: SÓ conjunto fechado {{email}}/{{poll_sig}} em link/formatting", () => {
    assert.equal(
      isMergeTagUnexpandedFalsePositive("email:link_broken: href tem {{email}} não expandido").falsePositive,
      true,
    );
    assert.equal(
      isMergeTagUnexpandedFalsePositive("email:formatting: {{poll_sig}} aparece literal = blocker").falsePositive,
      true,
    );
    assert.equal(isMergeTagUnexpandedFalsePositive("email:link_dead: https://x.com 404").falsePositive, false);
  });

  it("code-review: NÃO over-dropa bugs reais que co-mencionam negrito/itálico/{{...}}", () => {
    // F1: subject_mismatch é SEMPRE blocker (#1645) — nunca dropar, mesmo com {{...}}.
    assert.equal(
      isMergeTagUnexpandedFalsePositive("email:subject_mismatch: subject é '{{title}}' literal").falsePositive,
      false,
    );
    // F2: {{unknown_field}}/{{utm_campaign}} num link É bug real (var vazada) — não é o conjunto fechado.
    assert.equal(
      isMergeTagUnexpandedFalsePositive("email:link_wrong: D1 aponta pra https://x.com/{{utm_campaign}}").falsePositive,
      false,
    );
    // F3: defeito INVERSO (título em negrito demais) NÃO é "sem negrito" → mantém.
    assert.equal(
      isBoldMissingFalsePositive("email:formatting: título do D2 em NEGRITO além do tamanho, peso duplicado").falsePositive,
      false,
    );
    // F3b: link_missing cujo TÍTULO cita "negrito" não é formatting → mantém.
    assert.equal(
      isBoldMissingFalsePositive("email:link_missing: URL do título 'Texto em negrito no Notion' ausente").falsePositive,
      false,
    );
    // F4: hierarquia de título que co-menciona "sem itálico" (sem contexto de caption) → mantém.
    assert.equal(
      isItalicMissingFalsePositive("email:formatting: D3 título sem itálico E sem tamanho diferenciado").falsePositive,
      false,
    );
  });

  it("code-review: filterAgentIssues NÃO dropa subject_mismatch com {{...}} (never-FP #1645)", async () => {
    const issues = [
      "email:subject_mismatch: subject é '{{subject}}' literal não expandido",
      "email:formatting: D1 título sem negrito", // FP → dropa
    ];
    const r = await filterAgentIssues(issues, "<p>x</p>", "260608");
    assert.ok(r.kept.some((i) => /subject_mismatch/.test(i)), "subject_mismatch mantido apesar do {{...}}");
    assert.equal(r.kept.length, 1);
  });

  it("filterAgentIssues: dropa as 4 classes de FP do 260608, mantém bug real", async () => {
    // Caso 260608 (#1949): ~6 issues, todos FP exceto um defeito real plantado.
    const issues = [
      "email:formatting: {{email}} não expandido = blocker crítico", // FP merge tag
      "email:link_dead: https://diaria.beehiiv.com/cursos → HTTP 403", // sem fetchFn → passa pra kept
      "email:formatting: D1 título sem negrito", // FP DS
      "email:formatting: caption não está em itálico", // FP DS
      "email:subject_mismatch: subject é placeholder 'New post'", // REAL — mantém
    ];
    // Sem fetchFn, link_dead não é re-verificado → fica em kept (comportamento conservador)
    const r = await filterAgentIssues(issues, "<p>x</p>", "260608");
    assert.ok(r.kept.some((i) => /subject_mismatch/.test(i)), "bug real (subject) mantido");
    assert.ok(!r.kept.some((i) => /sem negrito|não está em itálico|\{\{/.test(i)), "FPs dropados");
  });
});

describe("filterAgentIssues — orchestrator integration (#1421)", () => {
  it("#1421/#1949: drop 2 encoding_drops + 1 itálico-FP, mantém 1 real", async () => {
    const html = "<p>pré-treino e funcionários estão corretos</p>";
    const issues = [
      "email:encoding_drop: 'pré-treino' pode estar corrompido",  // falso-pos
      "email:encoding_drop: 'funcionários' pode estar corrompido",  // falso-pos
      "email:unexpected_content: Seção 'Liderança de Maio' presente",  // mantém (não validável)
      "email:formatting: caption não está em itálico",  // #1949: agora DROPADO (DS sans sem itálico)
    ];
    const r = await filterAgentIssues(issues, html, "260520");
    assert.equal(r.kept.length, 1);
    assert.equal(r.dropped.length, 3);
    assert.match(r.kept[0], /unexpected_content/);
  });

  it("issues 100% validáveis → kept vazio, dropped completo", async () => {
    const html = '<p>pré-treino</p><a href="?sig={{poll_sig}}&edition=260520">x</a>';
    const issues = [
      "email:encoding_drop: 'pré-treino' corrompido",
      "email:poll_sig_missing: stripped",
      "email:vote_edition_malformed: &edition& errado",
    ];
    const r = await filterAgentIssues(issues, html, "260520");
    assert.equal(r.kept.length, 0);
    assert.equal(r.dropped.length, 3);
  });

  it("issues que não dá pra validar passam intactas (kind desconhecido)", async () => {
    const issues = [
      "email:something_else: weird",
      "email:another_type: stuff",
    ];
    const r = await filterAgentIssues(issues, "anything", "260520");
    assert.equal(r.kept.length, 2);
    assert.equal(r.dropped.length, 0);
  });

  it("input vazio → output vazio (no-op safe)", async () => {
    const r = await filterAgentIssues([], "anything", "260520");
    assert.deepEqual(r, { kept: [], dropped: [] });
  });
});

// ---------------------------------------------------------------------------
// #2013 — 3 classes novas de FP
// ---------------------------------------------------------------------------

describe("#2066 — isEncodingDropCalloutMarkerByDesign", () => {
  it("FP: marcador 📚 do box de livros — stripCalloutMarker remove por design", () => {
    const issue = "email:encoding_drop: '📚' ausente no email (U+1F4DA presente no source)";
    const r = isEncodingDropCalloutMarkerByDesign(issue);
    assert.equal(r.falsePositive, true);
    if (r.falsePositive) assert.match(r.reason, /stripCalloutMarker|by-design/i);
  });

  it("FP: marcador 📣 do callout patrocinado", () => {
    const issue = "email:encoding_drop: '📣' não aparece no email";
    const r = isEncodingDropCalloutMarkerByDesign(issue);
    assert.equal(r.falsePositive, true);
  });

  it("FP: marcador 🎉 de CTA editorial", () => {
    const issue = "email:encoding_drop: '🎉' ausente no email de teste";
    const r = isEncodingDropCalloutMarkerByDesign(issue);
    assert.equal(r.falsePositive, true);
  });

  it("NÃO é FP: múltiplos termos citados (pode haver texto real corrompido junto)", () => {
    const issue = "email:encoding_drop: '📚' e 'pré-treino' corrompidos";
    const r = isEncodingDropCalloutMarkerByDesign(issue);
    assert.equal(r.falsePositive, false);
  });

  it("NÃO é FP: emoji que não é marcador de callout", () => {
    const issue = "email:encoding_drop: '🚀' ausente no email";
    const r = isEncodingDropCalloutMarkerByDesign(issue);
    assert.equal(r.falsePositive, false);
  });

  it("filterAgentIssues dropa o encoding_drop do 📚 mesmo sem o emoji no HTML local", async () => {
    const html = "<html><body><p>Curadoria de livros.</p></body></html>";
    const { kept, dropped } = await filterAgentIssues(
      ["email:encoding_drop: '📚' ausente no email"],
      html,
      "260611",
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0].reason, /stripCalloutMarker/);
  });
});

describe("#2013 — isEncodingDropSectionEmojiByDesign", () => {
  it("FP: emoji 🚀 de LANÇAMENTOS em header — DS remove por design", () => {
    const issue = "email:encoding_drop: '🚀' ausente no header da seção LANÇAMENTOS";
    const r = isEncodingDropSectionEmojiByDesign(issue);
    assert.equal(r.falsePositive, true);
    if (r.falsePositive) {
      assert.match(r.reason, /stripKickerEmoji|by-design/i);
    }
  });

  it("FP: emoji 🎁 de SORTEIO em header", () => {
    const issue = "email:encoding_drop: '🎁' não aparece no header da seção sorteio";
    const r = isEncodingDropSectionEmojiByDesign(issue);
    assert.equal(r.falsePositive, true);
  });

  it("FP: emoji 🛠️ de USE MELHOR em header (com variation selector)", () => {
    const issue = "email:encoding_drop: '🛠️' ausente no kicker USE MELHOR";
    const r = isEncodingDropSectionEmojiByDesign(issue);
    assert.equal(r.falsePositive, true);
  });

  it("FP: emoji 🚀 ausente no 'título da seção'", () => {
    // Gate de header com frase 'título da seção' → FP
    const issue = "email:encoding_drop: '🚀' não aparece no título da seção LANÇAMENTOS";
    const r = isEncodingDropSectionEmojiByDesign(issue);
    assert.equal(r.falsePositive, true);
  });

  it("NÃO é FP: emoji ausente em CORPO do email (não em header)", () => {
    // Contexto sem menção de header/seção → mantém (pode ser emoji real em corpo)
    const issue = "email:encoding_drop: '🚀' ausente no parágrafo de abertura";
    const r = isEncodingDropSectionEmojiByDesign(issue);
    assert.equal(r.falsePositive, false);
  });

  it("#2047 — NÃO é FP: emoji 💼 em link inline (só menciona nome da seção, não header)", () => {
    // 💼 é emoji multi-propósito — aparece em links inline, não só em headers.
    // Se a issue menciona o nome da seção mas NÃO menciona header/kicker/seção/título da seção,
    // não é by-design (pode ser emoji real quebrado num link).
    const issue = "email:encoding_drop: '💼' ausente no link do destaque USE MELHOR";
    const r = isEncodingDropSectionEmojiByDesign(issue);
    assert.equal(r.falsePositive, false,
      "💼 em link inline não deve ser dropado mesmo mencionando USE MELHOR sem contexto de header");
  });

  it("#2047 — NÃO é FP: emoji 🌐 em link inline (só menciona nome da seção)", () => {
    const issue = "email:encoding_drop: '🌐' ausente no link de notícia RADAR";
    const r = isEncodingDropSectionEmojiByDesign(issue);
    assert.equal(r.falsePositive, false,
      "🌐 em link inline (sem header/kicker/seção) não deve ser dropado");
  });

  it("#2047 — NÃO é FP: emoji 📺 ausente sem contexto de header", () => {
    const issue = "email:encoding_drop: '📺' ausente no parágrafo VÍDEOS";
    const r = isEncodingDropSectionEmojiByDesign(issue);
    assert.equal(r.falsePositive, false);
  });

  it("NÃO é FP: múltiplos termos (texto real + emoji juntos) → não dropa por emoji sozinho", () => {
    // 2 termos: emoji + texto — cai na verificação normal de isEncodingDropFalsePositive
    const issue = "email:encoding_drop: '🚀' e 'lançamento' corrompidos no header seção LANÇAMENTOS";
    const r = isEncodingDropSectionEmojiByDesign(issue);
    assert.equal(r.falsePositive, false);
  });

  it("NÃO é FP: prefixo errado (não é encoding_drop)", () => {
    const issue = "email:section_missing: '🚀' seção LANÇAMENTOS ausente";
    const r = isEncodingDropSectionEmojiByDesign(issue);
    assert.equal(r.falsePositive, false);
  });
});

describe("#2013 — isSectionMissingFalsePositive", () => {
  const htmlWithSections = `
    <table>
      <td style="text-transform:uppercase">&#9679;&nbsp;LANÇAMENTOS</td>
      <td style="text-transform:uppercase">&#9679;&nbsp;RADAR</td>
      <td style="text-transform:uppercase">&#9679;&nbsp;Sorteio</td>
      <td style="text-transform:uppercase">&#9679;&nbsp;Para encerrar</td>
    </table>
  `;

  it("FP: LANÇAMENTOS presente no HTML (agent leu email truncado)", () => {
    const issue = "email:section_missing: 'LANÇAMENTOS' presente no source mas ausente no email";
    const r = isSectionMissingFalsePositive(issue, htmlWithSections);
    assert.equal(r.falsePositive, true);
    if (r.falsePositive) {
      assert.match(r.reason, /LANÇAMENTOS|truncado/i);
    }
  });

  it("FP: SORTEIO presente no HTML (case-insensitive match)", () => {
    const issue = "email:section_missing: seção 'Sorteio' não encontrada";
    const r = isSectionMissingFalsePositive(issue, htmlWithSections);
    assert.equal(r.falsePositive, true);
  });

  it("FP: RADAR presente no HTML via fallback (sem aspas na issue)", () => {
    const issue = "email:section_missing: RADAR ausente do email";
    const r = isSectionMissingFalsePositive(issue, htmlWithSections);
    assert.equal(r.falsePositive, true);
  });

  it("FP: emoji no candidate strip antes de comparar ('🚀 LANÇAMENTOS' → 'LANÇAMENTOS')", () => {
    const issue = "email:section_missing: '🚀 LANÇAMENTOS' ausente";
    const r = isSectionMissingFalsePositive(issue, htmlWithSections);
    assert.equal(r.falsePositive, true);
  });

  it("NÃO é FP: seção de fato ausente do HTML", () => {
    const htmlWithoutLancamentos = "<td>&#9679;&nbsp;RADAR</td><td>&#9679;&nbsp;Sorteio</td>";
    const issue = "email:section_missing: 'LANÇAMENTOS' ausente do email";
    const r = isSectionMissingFalsePositive(issue, htmlWithoutLancamentos);
    assert.equal(r.falsePositive, false);
  });

  it("NÃO é FP: prefixo errado (não é section_missing)", () => {
    const issue = "email:encoding_drop: 'LANÇAMENTOS' corrompido";
    const r = isSectionMissingFalsePositive(issue, htmlWithSections);
    assert.equal(r.falsePositive, false);
  });

  it("NÃO é FP: issue sem nome de seção identificável", () => {
    const issue = "email:section_missing:";
    const r = isSectionMissingFalsePositive(issue, htmlWithSections);
    assert.equal(r.falsePositive, false);
  });
});

describe("#2013 — extractLinkDeadUrl", () => {
  it("extrai URL do padrão padrão do agent", () => {
    const issue = "email:link_dead: https://example.com/page → HTTP 404";
    assert.equal(extractLinkDeadUrl(issue), "https://example.com/page");
  });

  it("extrai URL com path complexo", () => {
    const issue = "email:link_dead: https://diaria.beehiiv.com/cursos-gratuitos-de-ia → HTTP 403";
    assert.equal(extractLinkDeadUrl(issue), "https://diaria.beehiiv.com/cursos-gratuitos-de-ia");
  });

  it("retorna null quando não há URL", () => {
    assert.equal(extractLinkDeadUrl("email:link_dead: link morto sem URL"), null);
  });
});

describe("#2013 — isLinkDeadFalsePositive", () => {
  /** Mock de fetch que retorna status fixo sem fazer rede real. */
  function mockFetch(status: number, headStatus?: number): FetchFn {
    return async (_url, init) => {
      const method = (init as RequestInit & { method?: string })?.method ?? "GET";
      const s = method === "HEAD" && headStatus !== undefined ? headStatus : status;
      return { status: s, headers: new Headers() } as Response;
    };
  }

  it("FP: link retorna 200 na re-verificação", async () => {
    const issue = "email:link_dead: https://example.com/page → HTTP 404";
    const r = await isLinkDeadFalsePositive(issue, mockFetch(200));
    assert.equal(r.falsePositive, true);
    if (r.falsePositive) assert.match(r.reason, /200|re-verificação/i);
  });

  it("FP: link retorna 301 na re-verificação (redirect = vivo)", async () => {
    const issue = "email:link_dead: https://example.com/old → HTTP 404";
    const r = await isLinkDeadFalsePositive(issue, mockFetch(301));
    assert.equal(r.falsePositive, true);
  });

  it("FP: domínio beehiiv.com com 403 (bot-protection conhecida)", async () => {
    const issue = "email:link_dead: https://diaria.beehiiv.com/cursos-gratuitos-de-ia → HTTP 403";
    const r = await isLinkDeadFalsePositive(issue, mockFetch(403));
    assert.equal(r.falsePositive, true);
    if (r.falsePositive) assert.match(r.reason, /beehiiv\.com|bot.?protection/i);
  });

  it("FP: subdomínio beehiiv.com com 403", async () => {
    const issue = "email:link_dead: https://link.diaria.beehiiv.com/s/abc → HTTP 403";
    const r = await isLinkDeadFalsePositive(issue, mockFetch(403));
    assert.equal(r.falsePositive, true);
  });

  it("NÃO é FP: link realmente 404 em domínio não-beehiiv", async () => {
    const issue = "email:link_dead: https://example.com/dead-page → HTTP 404";
    const r = await isLinkDeadFalsePositive(issue, mockFetch(404));
    assert.equal(r.falsePositive, false);
  });

  it("NÃO é FP: link retorna 500 (erro de servidor) mesmo em beehiiv", async () => {
    const issue = "email:link_dead: https://diaria.beehiiv.com/broken → HTTP 500";
    const r = await isLinkDeadFalsePositive(issue, mockFetch(500));
    assert.equal(r.falsePositive, false);
  });

  it("NÃO é FP: 403 em domínio externo (não é beehiiv, pode ser real)", async () => {
    const issue = "email:link_dead: https://external-site.com/page → HTTP 403";
    // 403 externo não é na lista de bot-block beehiiv — mas é >= 400, então não é 2xx/3xx
    const r = await isLinkDeadFalsePositive(issue, mockFetch(403));
    assert.equal(r.falsePositive, false);
  });

  it("NÃO é FP: timeout na re-verificação (fetch retorna null = não conclui)", async () => {
    const issue = "email:link_dead: https://example.com/timeout → HTTP 404";
    // Simula timeout: fetch joga AbortError
    const timeoutFetch: FetchFn = async () => {
      const err = new Error("AbortError");
      err.name = "AbortError";
      throw err;
    };
    const r = await isLinkDeadFalsePositive(issue, timeoutFetch);
    assert.equal(r.falsePositive, false);
  });

  it("NÃO é FP: prefixo errado (não é link_dead)", async () => {
    const issue = "email:link_timeout: https://example.com (>5s)";
    const r = await isLinkDeadFalsePositive(issue, mockFetch(200));
    assert.equal(r.falsePositive, false);
  });

  it("HEAD 405 → fallback GET usado", async () => {
    const issue = "email:link_dead: https://example.com/no-head → HTTP 404";
    // HEAD retorna 405, GET retorna 200 → FP
    const r = await isLinkDeadFalsePositive(issue, mockFetch(200, 405));
    assert.equal(r.falsePositive, true);
  });
});

describe("#2013 — filterAgentIssues integração completa (caso 260610)", () => {
  /** Mock fetch pra re-verificação de links. */
  function mockFetch(statusByUrl: Record<string, number>): FetchFn {
    return async (url, _init) => {
      const s = statusByUrl[url] ?? 200;
      return { status: s, headers: new Headers() } as Response;
    };
  }

  const htmlWith260610 = `
    <table>
      <td>&#9679;&nbsp;LANÇAMENTOS</td>
      <td>&#9679;&nbsp;RADAR</td>
      <td>&#9679;&nbsp;Sorteio</td>
      <td>&#9679;&nbsp;Para encerrar</td>
    </table>
    <a href="https://diaria.workers.dev/img/260610/d1.jpg">imagem</a>
    <a href="https://diaria.workers.dev/leaderboard">leaderboard</a>
  `;

  it("260610 edição: dropa os 3 tipos de FP do caso real", async () => {
    const issues = [
      // 1. link_dead falso: Worker KV retorna 200 na re-verificação
      "email:link_dead: https://diaria.workers.dev/img/260610/d1.jpg → HTTP 404",
      // 1b. link_dead falso: beehiiv 403 bot-protection
      "email:link_dead: https://diaria.beehiiv.com/cursos-gratuitos-de-ia → HTTP 403",
      // 2. section_missing por truncamento: seções presentes no HTML local
      "email:section_missing: 'LANÇAMENTOS' presente no source com 3 itens, ausente no email",
      "email:section_missing: 'Sorteio' não encontrada no email",
      // 3. encoding_drop de emoji de seção (by-design DS #1936)
      "email:encoding_drop: '🚀' ausente no header da seção LANÇAMENTOS",
      "email:encoding_drop: '🎁' ausente no kicker sorteio",
      // Bug real que deve ser mantido
      "email:subject_mismatch: subject 'New post' ≠ esperado 'IA em 10 dias'",
    ];

    const fetchMock = mockFetch({
      "https://diaria.workers.dev/img/260610/d1.jpg": 200,
      "https://diaria.beehiiv.com/cursos-gratuitos-de-ia": 403,
    });

    const r = await filterAgentIssues(issues, htmlWith260610, "260610", fetchMock);

    // Deve manter só o subject_mismatch real
    assert.equal(r.kept.length, 1, `kept deveria ser 1, got: ${JSON.stringify(r.kept)}`);
    assert.match(r.kept[0], /subject_mismatch/);

    // Deve dropar todos os FPs
    assert.equal(r.dropped.length, 6, `dropped deveria ser 6, got: ${JSON.stringify(r.dropped.map((d) => d.issue))}`);
  });

  it("sem fetchFn: link_dead não re-verificado → conservador (mantém)", async () => {
    const issues = [
      "email:link_dead: https://example.com/maybe-dead → HTTP 404",
      "email:section_missing: 'LANÇAMENTOS' ausente", // FP → dropa
    ];
    // Sem fetchFn — link_dead fica em kept, section_missing é dropado
    const r = await filterAgentIssues(issues, htmlWith260610, "260610");
    assert.ok(r.kept.some((i) => /link_dead/.test(i)), "link_dead conservado sem fetchFn");
    assert.ok(r.dropped.some((d) => /section_missing/.test(d.issue)), "section_missing dropado");
  });

  it("#2082 regressão: link_dead com {{poll_sig}} na URL sem fetchFn NÃO é dropado como merge-tag FP", async () => {
    // Bug: antes do fix, a condição `else if (link_dead) && fetchFn` falhava sem fetchFn,
    // caindo nos genéricos de DS onde isMergeTagUnexpandedFalsePositive casava o
    // prefixo `link_` + `{{poll_sig}}` e dropava o issue silenciosamente.
    // Após o fix: link_dead sai sempre pelo branch específico (com ou sem fetchFn) → kept.
    const issue = "email:link_dead: https://poll.diaria.workers.dev/vote?sig={{poll_sig}}&edition=260611 → HTTP 404";
    const r = await filterAgentIssues([issue], "<p>html qualquer</p>", "260611");
    assert.equal(r.kept.length, 1, "link_dead com {{poll_sig}} deve ser mantido (não dropado como merge-tag FP)");
    assert.equal(r.dropped.length, 0, `não deve dropar: got ${JSON.stringify(r.dropped)}`);
    assert.match(r.kept[0], /link_dead/, "issue mantido deve ser o link_dead");
  });
});

// ---------------------------------------------------------------------------
// #2047 — paralelismo, cache, ordem preservada
// ---------------------------------------------------------------------------

describe("#2047 — filterAgentIssues: paralelismo de link_dead", () => {
  /**
   * Mock de fetch com delay configurável — verifica que os fetches de múltiplos
   * link_dead correm em paralelo. Com N fetches de delay D ms cada:
   * - Sequencial: tempo total ≈ N × D
   * - Paralelo:   tempo total ≈ D  (independentemente de N)
   */
  function delayedFetch(statusByUrl: Record<string, number>, delayMs: number): FetchFn {
    return async (url) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const s = statusByUrl[url as string] ?? 200;
      return { status: s, headers: new Headers() } as Response;
    };
  }

  it("N fetches paralelos: tempo total ≈ 1 fetch (não N fetches sequenciais)", async () => {
    const DELAY = 50; // ms por fetch
    const N = 5;      // 5 URLs distintas
    const statusMap: Record<string, number> = {};
    const issues: string[] = [];
    for (let i = 1; i <= N; i++) {
      const url = `https://example.com/link-${i}`;
      statusMap[url] = 404; // todos mortos → mantém
      issues.push(`email:link_dead: ${url} → HTTP 404`);
    }
    const fetchFn = delayedFetch(statusMap, DELAY);

    const start = Date.now();
    await filterAgentIssues(issues, "<p>x</p>", "260611", fetchFn);
    const elapsed = Date.now() - start;

    // Paralelo: deve terminar bem abaixo de N×DELAY (sequencial).
    // Threshold: N×DELAY×0.8 = 200ms (sequencial seria 250ms, paralelo ideal ~50ms).
    // Usando 0.8× do sequencial como threshold: CI com spikes de 100-150ms ainda passa.
    const sequentialMs = N * DELAY;   // 250ms se fosse sequencial
    const threshold = Math.floor(sequentialMs * 0.8);  // 200ms — claramente abaixo do sequencial
    assert.ok(
      elapsed < threshold,
      `fetches devem ser paralelos: elapsed ${elapsed}ms, esperado < ${threshold}ms (sequencial seria ${sequentialMs}ms)`,
    );
  });

  it("N fetches paralelos: contagem de chamadas ao fetchFn = N (sem cache)", async () => {
    let callCount = 0;
    const urls = [
      "https://example.com/a → HTTP 404",
      "https://example.com/b → HTTP 404",
      "https://example.com/c → HTTP 404",
    ];
    const issues = urls.map((u) => `email:link_dead: ${u}`);
    const fetchFn: FetchFn = async () => {
      callCount++;
      return { status: 404, headers: new Headers() } as Response;
    };
    await filterAgentIssues(issues, "<p>x</p>", "260611", fetchFn);
    // Sem cache: cada URL chama fetchFn 1x (HEAD) — nenhum repetido
    assert.equal(callCount, urls.length, `fetchFn deve ser chamado ${urls.length}×, foi ${callCount}×`);
  });
});

describe("#2047 — filterAgentIssues: cache por URL entre iterações", () => {
  it("2ª chamada com mesmo URL não re-fetcha (cache hit)", async () => {
    let fetchCallCount = 0;
    const url = "https://example.com/always-dead";
    const issue = `email:link_dead: ${url} → HTTP 404`;
    const fetchFn: FetchFn = async () => {
      fetchCallCount++;
      return { status: 404, headers: new Headers() } as Response;
    };

    const cache = new Map<string, boolean>(); // #2061: boolean (não boolean|null) após narrowing
    const html = "<p>x</p>";

    // 1ª iteração: fetch acontece, cache é populado com false (link morto)
    await filterAgentIssues([issue], html, "260611", fetchFn, cache);
    assert.equal(fetchCallCount, 1, "1ª chamada deve fazer 1 fetch");
    assert.equal(cache.get(url), false, "cache deve ser false (link morto)");

    // 2ª iteração: cache hit — fetchFn NÃO é chamado novamente
    await filterAgentIssues([issue], html, "260611", fetchFn, cache);
    assert.equal(fetchCallCount, 1, "2ª chamada NÃO deve re-fetchar (cache hit)");
  });

  it("cache hit positivo (link vivo): 2ª chamada dropa sem re-fetch", async () => {
    let fetchCallCount = 0;
    const url = "https://example.com/alive";
    const issue = `email:link_dead: ${url} → HTTP 404`;
    const fetchFn: FetchFn = async () => {
      fetchCallCount++;
      return { status: 200, headers: new Headers() } as Response;
    };

    const cache = new Map<string, boolean>(); // #2061: boolean (não boolean|null) após narrowing
    const html = "<p>x</p>";

    // 1ª iteração: fetch → vivo (FP) → dropa, cache = true
    const r1 = await filterAgentIssues([issue], html, "260611", fetchFn, cache);
    assert.equal(r1.dropped.length, 1, "1ª iteração: link vivo → dropa");
    assert.equal(fetchCallCount, 1);
    assert.equal(cache.get(url), true, "cache deve ser true (link vivo)");

    // 2ª iteração: cache hit (true) → dropa SEM fetch
    const r2 = await filterAgentIssues([issue], html, "260611", fetchFn, cache);
    assert.equal(r2.dropped.length, 1, "2ª iteração: cache hit → dropa");
    assert.equal(fetchCallCount, 1, "fetchFn não deve ser chamado na 2ª iteração");
  });

  it("sem cache passado: URLs distintas em 2 chamadas são re-fetchadas normalmente", async () => {
    let fetchCallCount = 0;
    const url = "https://example.com/no-cache";
    const issue = `email:link_dead: ${url} → HTTP 404`;
    const fetchFn: FetchFn = async () => {
      fetchCallCount++;
      return { status: 404, headers: new Headers() } as Response;
    };

    const html = "<p>x</p>";
    await filterAgentIssues([issue], html, "260611", fetchFn);
    await filterAgentIssues([issue], html, "260611", fetchFn);
    // Sem cache compartilhado, cada chamada fetcha independentemente
    assert.equal(fetchCallCount, 2, "sem cache: cada chamada re-fetcha");
  });
});

describe("#2047 — filterAgentIssues: ordem preservada", () => {
  it("ordem de kept preservada independente de fetches", async () => {
    // Mix de issues: link_dead (async), sync FP e keep — ordem original deve ser mantida
    const fetchFn: FetchFn = async (url) => {
      // Link A é vivo (→ FP → dropa), Link B é morto (→ mantém)
      const s = (url as string).includes("/a") ? 200 : 404;
      return { status: s, headers: new Headers() } as Response;
    };

    const issues = [
      "email:encoding_drop: 'pré-treino' corrompido",                  // 0: sync drop (FP)
      "email:link_dead: https://example.com/a → HTTP 404",              // 1: async drop (vivo)
      "email:unexpected_content: seção extra",                           // 2: sync keep
      "email:link_dead: https://example.com/b → HTTP 404",              // 3: async keep (morto)
      "email:formatting: D1 título sem negrito",                         // 4: sync drop (DS FP)
      "email:subject_mismatch: subject errado",                          // 5: sync keep
    ];

    const html = "<p>pré-treino</p>"; // pré-treino presente → issue[0] é FP
    const r = await filterAgentIssues(issues, html, "260611", fetchFn);

    // kept deve ter, em ordem: unexpected_content, link_dead/b, subject_mismatch
    assert.equal(r.kept.length, 3, `kept deve ter 3: ${JSON.stringify(r.kept)}`);
    assert.match(r.kept[0], /unexpected_content/, "kept[0] deve ser unexpected_content");
    assert.match(r.kept[1], /example\.com\/b/, "kept[1] deve ser link_dead/b (morto)");
    assert.match(r.kept[2], /subject_mismatch/, "kept[2] deve ser subject_mismatch");

    // dropped deve ter, em ordem: encoding_drop, link_dead/a, formatting
    assert.equal(r.dropped.length, 3, `dropped deve ter 3: ${JSON.stringify(r.dropped.map((d) => d.issue))}`);
    assert.match(r.dropped[0].issue, /encoding_drop/, "dropped[0] deve ser encoding_drop");
    assert.match(r.dropped[1].issue, /example\.com\/a/, "dropped[1] deve ser link_dead/a (vivo → FP)");
    assert.match(r.dropped[2].issue, /sem negrito/, "dropped[2] deve ser formatting/bold");
  });
});

// ---------------------------------------------------------------------------
// #2059 — dispatch exclusivo no filterAgentIssues (anti-fall-through)
// ---------------------------------------------------------------------------

describe("#2059 — filterAgentIssues: dispatch exclusivo por tipo (sem fall-through)", () => {
  /**
   * Cenário concreto da issue: `email:encoding_drop` citando uma merge tag
   * `{{subscriber.first_name}}` que NÃO está no HTML local (corruption real).
   *
   * Bug pré-fix: o checker de encoding retornava falsePositive=false (correto)
   * e o código caía no `isMergeTagUnexpandedFalsePositive` que casava o padrão
   * `{{...}}` e dropava — silenciando um erro real de merge tag.
   *
   * Fix: quando o checker específico de encoding_drop se declara competente e
   * diz "não é FP", o issue é `kept` SEM passar pelos genéricos de DS.
   */
  it("encoding_drop com {{subscriber.first_name}} ausente no HTML → KEPT (erro real, não FP)", async () => {
    // HTML sem a merge tag — a tag não foi expandida nem está presente
    const html = "<p>Olá, bem-vindo à newsletter!</p>";
    const issue = "email:encoding_drop: merge tag '{{subscriber.first_name}}' aparece não-expandida no email";

    const r = await filterAgentIssues([issue], html, "260611");

    // Deve ser mantido (erro real) — NÃO dropado por isMergeTagUnexpandedFalsePositive
    assert.equal(r.kept.length, 1, `issue deve ser mantida como erro real: ${JSON.stringify(r.kept)}`);
    assert.equal(r.dropped.length, 0, `issue não deve ser dropada: ${JSON.stringify(r.dropped)}`);
    assert.match(r.kept[0], /subscriber\.first_name/, "a issue de encoding_drop deve estar em kept");
  });

  it("encoding_drop com {{email}} ausente no HTML → KEPT (tag faltando de verdade)", async () => {
    // {{email}} presente no HTML → seria FP de isEncodingDropFalsePositive normalmente,
    // mas aqui está AUSENTE → encoding_drop checker diz "não é FP" → kept SEM checar merge-tag generic
    const html = "<p>Conteúdo sem link de unsubscribe.</p>";
    const issue = "email:encoding_drop: '{{email}}' não encontrado no email renderizado";

    const r = await filterAgentIssues([issue], html, "260611");

    // Ausente no HTML → erro real → kept
    assert.equal(r.kept.length, 1, "encoding_drop com {{email}} ausente deve ser mantido");
    assert.equal(r.dropped.length, 0, "encoding_drop com {{email}} ausente NÃO deve ser dropado pelo genérico de merge-tag");
  });

  it("encoding_drop com {{email}} PRESENTE no HTML → DROPPED (FP de encoding, não de merge-tag)", async () => {
    // {{email}} presente no HTML → isEncodingDropFalsePositive → FP → dropa pelo checker específico
    const html = '<a href="https://unsub.example.com?email={{email}}">unsub</a>';
    const issue = "email:encoding_drop: '{{email}}' corrompido no email";

    const r = await filterAgentIssues([issue], html, "260611");

    // Presente no HTML → FP de encoding (DS by-design: merge tag inline) → dropa
    assert.equal(r.dropped.length, 1, "encoding_drop com {{email}} presente deve ser dropado como FP");
    assert.match(r.dropped[0].reason, /encoding_drop falso-positivo/, "motivo deve ser do checker de encoding_drop");
  });

  it("email:poll_sig_missing sem sig no HTML → KEPT (não cai em genérico de merge-tag)", async () => {
    // poll_sig_missing checker diz "não é FP" (sig ausente) → kept SEM genéricos
    const html = "<p>Corpo sem nenhum link de votação.</p>";
    const issue = "email:poll_sig_missing: link de votação não contém sig=";

    const r = await filterAgentIssues([issue], html, "260611");
    assert.equal(r.kept.length, 1, "poll_sig_missing real deve ser mantido");
    assert.equal(r.dropped.length, 0);
  });
});

// ---------------------------------------------------------------------------
// #2105 — tabela declarativa: exclusividade estrutural
// ---------------------------------------------------------------------------

describe("#2105 — filterAgentIssues: exclusividade estrutural via tabela de handlers", () => {
  /**
   * Garante duas propriedades invariáveis introduzidas pela tabela #2105:
   *
   * 1. Tipo NÃO coberto por nenhum handler → elegível para genéricos de DS.
   *    Ex: `email:link_x` tem prefixo `link_` que isMergeTagUnexpandedFalsePositive
   *    casaria — mas sem handler na tabela, o issue chega nos genéricos e pode
   *    ser dropado se satisfaz a condição do genérico.
   *
   * 2. Tipo COBERTO por handler → NUNCA alcança os genéricos, mesmo quando o
   *    handler retorna `{ kind: "keep" }` (not-FP). Isso é a exclusividade
   *    estrutural: basta estar na tabela para ser isolado dos genéricos.
   */

  it("tipo hipotético email:link_x NÃO coberto por handler → vai pros genéricos (pode ser dropado por DS)", async () => {
    // email:link_x não está na tabela de handlers.
    // isMergeTagUnexpandedFalsePositive casa `email:link_` + `{{poll_sig}}` → FP → dropa.
    // Isso demonstra que tipos fora da tabela chegam nos genéricos.
    const issue = "email:link_x: href contém {{poll_sig}} não expandido";
    const r = await filterAgentIssues([issue], "<p>qualquer</p>", "260611");

    // Deve ser DROPADO pelos genéricos de DS (isMergeTagUnexpandedFalsePositive)
    assert.equal(r.dropped.length, 1, "email:link_x com {{poll_sig}} deve ser dropado pelos genéricos de DS");
    assert.equal(r.kept.length, 0, "não deve ser mantido");
    assert.match(
      r.dropped[0].reason,
      /merge tags inline|poll_sig|expandem no envio/i,
      "motivo deve vir do genérico isMergeTagUnexpandedFalsePositive",
    );
  });

  it("tipo COBERTO (email:link_dead) → NUNCA alcança os genéricos, mesmo retornando not-FP", async () => {
    // email:link_dead está na tabela. Sem fetchFn, o handler retorna { kind: "keep" }
    // (not-FP conservador). Apesar de conter {{poll_sig}} na URL — que o genérico
    // isMergeTagUnexpandedFalsePositive casaria — o issue é mantido porque o handler
    // já interceptou o dispatch antes dos genéricos.
    // Este é o invariante estrutural: handler registrado = imune aos genéricos.
    const issue = "email:link_dead: https://poll.example.com/vote?sig={{poll_sig}}&edition=260611 → HTTP 404";
    // Sem fetchFn → handler retorna keep conservador (sem re-verificar link)
    const r = await filterAgentIssues([issue], "<p>qualquer</p>", "260611");

    assert.equal(r.kept.length, 1, "link_dead coberto pelo handler deve ser mantido (kept), NÃO dropado pelo genérico");
    assert.equal(r.dropped.length, 0, "link_dead NÃO deve ser dropado por isMergeTagUnexpandedFalsePositive");
    assert.match(r.kept[0], /link_dead/, "o issue mantido deve ser o link_dead");
  });
});
