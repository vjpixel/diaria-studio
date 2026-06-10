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

  it("NÃO é FP: emoji ausente em CORPO do email (não em header)", () => {
    // Contexto sem menção de header/seção → mantém (pode ser emoji real em corpo)
    const issue = "email:encoding_drop: '🚀' ausente no parágrafo de abertura";
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
});
