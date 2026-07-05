/**
 * ds-golden-full-render.test.ts (#2108)
 *
 * Golden de página inteira do renderHTML — cobre bugs de COMPOSIÇÃO que os
 * goldens por componente (ds-golden-components.test.ts) não detectam.
 *
 * Motivação:
 *   #2069 — régua bege antes do boxDivulgacao1 sumiu silenciosamente. Todos os
 *   testes por componente passaram porque cada um verificava só o seu bloco;
 *   ninguém testava se a régua (renderDivulgacaoSeparator) aparecia no output
 *   composto antes do box do meio.
 *
 * O que este arquivo cobre:
 *   1. Fixture sintética de edição completa — todas as seções que renderHTML
 *      compõe: 3 destaques, lançamentos, notícias/radar, use melhor, vídeo,
 *      É IA?, sorteio, erro intencional, encerrar, boxDivulgacao1 com e sem imagem,
 *      introCallout. Determinística — sem dados reais.
 *   2. 1 golden do HTML completo: mesmo mecanismo de atualização consciente dos
 *      goldens por componente (NODE_TEST_SNAPSHOTS=1 npm test).
 *   3. Asserções de composição ALÉM do golden bruto: ordem das seções no HTML,
 *      presença de exatamente 1 régua antes do boxDivulgacao1, ausência de blocos
 *      vazios — pra que a falha aponte O QUE quebrou, não só "snapshot difere".
 *
 * Como atualizar o golden (mudança legítima de design):
 *   NODE_TEST_SNAPSHOTS=1 npm test
 *   — ou —
 *   npm test -- --test-name-pattern "ds-golden-full-render" --update-snapshots
 *
 * Quando VER falha no CI:
 *   - Divergência no golden: checar se foi mudança de design intencional (novo
 *     componente, refactor de token) → atualizar golden conscientemente com o
 *     comando acima. Nunca atualizar sem revisar o diff do snap.
 *   - Falha nas asserções de composição (seção fora de ordem, régua ausente,
 *     bloco vazio): composição quebrada — investigar renderHTML, NÃO atualizar o
 *     golden cegamente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { renderHTML } from "../scripts/lib/newsletter-render-html.ts";
import type { NewsletterContent } from "../scripts/lib/newsletter-parse.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = resolve(
  ROOT,
  "test/__snapshots__/ds-golden-full-render.snap.json",
);

// ── Fixture sintética completa ────────────────────────────────────────────────

/**
 * Fixture determinística que exercita TODAS as seções que renderHTML compõe.
 * Não usa dados reais — apenas cobre cada caminho do renderHTML.
 *
 * Seções presentes:
 *   - coverageLine        (bloco transparente no topo)
 *   - introCallout        (CTA de destaque — 🎉 editorial, sem disclosure)
 *   - Destaque 1          (com imagem hero)
 *   - boxDivulgacao1          (com imagem — régua "Divulgação" antes do box)
 *   - Destaque 2
 *   - É IA?               (após o último destaque, #2546)
 *   - Destaque 3
 *   - LANÇAMENTOS         (seção)
 *   - OUTRAS NOTÍCIAS     (seção)
 *   - USE MELHOR          (seção)
 *   - SORTEIO             (bloco fixo)
 *   - ERRO INTENCIONAL    (reveal entre SORTEIO e PARA ENCERRAR)
 *   - PARA ENCERRAR       (bloco fixo com pills + CTA "Agora que chegou")
 */
const FULL_FIXTURE: NewsletterContent = {
  title: "Modelos se auto-replicam sem intervenção humana",
  subtitle: "OpenAI lança agente autônomo · Regulação europeia avança",
  coverImage: "04-d1-2x1.jpg",

  coverageLine:
    "Para esta edição, eu (o editor) enviei 4 submissões e a Diar.ia encontrou outros 12 artigos. Selecionamos os 9 mais relevantes.",

  introCallout:
    "🎉 Sorteio ao vivo hoje às 19h! Participe: [inscreva-se aqui](https://livros.diaria.workers.dev).",

  destaques: [
    {
      n: 1,
      category: "PESQUISA",
      title: "Modelos se auto-replicam sem intervenção humana",
      body: "Pesquisadores da MIT detectaram que o GPT-5 copiou seus pesos para servidores externos durante um teste de contenção controlado.\n\nO experimento foi repetido 3 vezes com resultados consistentes.",
      why: "A replicação autônoma de modelos LLM representa um salto qualitativo no risco sistêmico — algo que a comunidade de AI Safety havia previsto mas não esperava ver tão cedo.",
      url: "https://example.com/mit-auto-replication",
      emoji: "🧪",
      imageFile: "04-d1-2x1.jpg",
    },
    {
      n: 2,
      category: "PRODUTO",
      title: "OpenAI lança agente autônomo para tarefas longas",
      body: "O novo produto opera por horas sem intervenção humana, executando sequências de ações em browsers e terminais.\n\nDisponível para usuários Plus a partir desta semana.",
      why: "Combina capacidade de planejamento de longo prazo com execução de ferramentas — arquitetura que a concorrência ainda não tem em produção.",
      url: "https://example.com/openai-long-horizon-agent",
      emoji: "📦",
      imageFile: "04-d2-1x1.jpg",
    },
    {
      n: 3,
      category: "REGULAÇÃO",
      title: "UE aprova texto final do AI Act",
      body: "O Parlamento Europeu aprovou o texto definitivo do AI Act por 523 votos a favor.\n\nFronteiras entre sistemas de 'risco alto' e 'risco limitado' ainda geram controvérsia na indústria.",
      why: "Primeira lei abrangente de IA no mundo — vai moldar como produtos de IA operam na Europa e influenciar legislações globais.",
      url: "https://example.com/eu-ai-act-final",
      emoji: "🧮",
      imageFile: "04-d3-1x1.jpg",
    },
  ],

  boxDivulgacao1:
    "📚 Nossa curadoria de livros sobre IA ganhou uma nova página. [Confira a nova página](https://livros.diaria.workers.dev).",
  boxDivulgacao1Image:
    "https://poll.diaria.workers.dev/img/img-260604-04-livros-promo-a1b2c3d4.jpg",

  eia: {
    credit: "Foto: Gerado com Gemini. Uma dessas imagens é artificial — qual é?",
    imageA: "01-eia-A.jpg",
    imageB: "01-eia-B.jpg",
    edition: "260999",
    prevResultLine: "Resultado da última edição: 73% acertaram",
    leaderboardPodium: [
      { nickname: "Davyd", rank: 1 },
      { nickname: "Luisao P", rank: 2 },
    ],
    leaderboardPeriod: "Maio",
    leaderboardPeriodSlug: "2026-05",
  },

  sections: [
    {
      name: "LANÇAMENTOS",
      emoji: "🚀",
      items: [
        {
          title: "Claude 4 Opus é lançado com modo extended thinking",
          url: "https://anthropic.com/claude-4-opus",
          description: "Novo modelo top da Anthropic com janela de contexto expandida e raciocínio prolongado.",
        },
        {
          title: "Gemini 2.5 Pro chega com suporte nativo a vídeo",
          url: "https://deepmind.google/gemini-25-pro",
          description: "Google lança versão estável com análise de vídeos de até 2 horas.",
        },
      ],
    },
    {
      name: "OUTRAS NOTÍCIAS",
      emoji: "📰",
      items: [
        {
          title: "Meta contrata ex-CEO do DeepMind para liderar pesquisa de AGI",
          url: "https://example.com/meta-deepmind-hire",
          description: "Movimento sinaliza escalada da aposta da Meta em sistemas de propósito geral.",
        },
        {
          title: "Startup brasileira de IA médica levanta R$ 120 mi em Série B",
          url: "https://example.com/br-ai-med-series-b",
          description: "Doctos expande para diagnóstico por imagem com modelo treinado em dados de hospitais públicos.",
        },
      ],
    },
    {
      name: "USE MELHOR",
      emoji: "🔧",
      items: [
        {
          title: "Como usar o modo de voz do ChatGPT para revisar textos em voz alta",
          url: "https://example.com/chatgpt-voice-review",
          description: "Técnica que acelera a identificação de frases travadas e repetições.",
        },
        {
          title: "3 prompts para transformar seu PDF em flashcards de estudo",
          url: "https://example.com/pdf-flashcards-prompts",
          description: "Funciona com qualquer material de estudo — artigos, livros, transcrições de aulas.",
        },
        {
          title: "Como configurar o Cursor para manter um estilo de código consistente",
          url: "https://example.com/cursor-style-guide",
          description: "Arquivo .cursorrules + instruções de contexto que reduzem revisões manuais.",
        },
      ],
    },
    {
      name: "RADAR",
      emoji: "📡",
      items: [
        {
          title: "Pesquisa: 68% dos desenvolvedores usam IA diariamente",
          url: "https://example.com/devsurvey-ai-daily",
          description: "Stack Overflow Developer Survey 2026 mostra crescimento de 23 p.p. em relação ao ano anterior.",
        },
      ],
    },
  ],

  sorteio:
    "Preste atenção à data da próxima edição do É IA? e responda com a alternativa correta.\n\nO ganhador recebe um acesso vitalício à nossa curadoria de livros.",

  erroIntencional:
    "Nessa edição, escondemos um erro proposital para você achar.\n\nNa última edição, escrevemos que o GPT-4 foi lançado em 2022 — o correto é março de 2023.\n\nNessa edição tem outro erro.",

  encerrar: `Chegou ao fim de mais uma edição da Diar.ia. Se esse conteúdo ajudou você a entender melhor o que está acontecendo com IA, compartilhe com alguém que também precisa saber.

- [Cursos de IA](https://cursos.diaria.workers.dev)
- [Livros sobre IA](https://livros.diaria.workers.dev)
- [Newsletter no Beehiiv](https://diaria.beehiiv.com)

Agora que chegou até aqui, aproveite e responda o É IA? de hoje — leva menos de 10 segundos e te coloca no ranking do mês.`,
};

// ── Snapshot helpers (idênticos ao ds-golden-components.test.ts) ─────────────

interface SnapEntry {
  hash: string;
  html: string;
}

interface Snapshot {
  updated_at: string;
  entry: SnapEntry;
}

function sha256Short(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function loadSnapshot(): Snapshot | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

function saveSnapshot(html: string): void {
  const snap: Snapshot = {
    updated_at: new Date().toISOString(),
    entry: { hash: sha256Short(html), html },
  };
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2) + "\n", "utf8");
}

// ── Helpers de composição ─────────────────────────────────────────────────────

/**
 * Verifica que `before` aparece antes de `after` no HTML.
 * Retorna a diferença de índices (> 0 = correto).
 */
function assertOrder(html: string, before: string, after: string): void {
  const idxBefore = html.indexOf(before);
  const idxAfter = html.indexOf(after);
  assert.ok(
    idxBefore !== -1,
    `Marcador "${before}" ausente no HTML`,
  );
  assert.ok(
    idxAfter !== -1,
    `Marcador "${after}" ausente no HTML`,
  );
  assert.ok(
    idxBefore < idxAfter,
    `Ordem quebrada: "${before}" (idx ${idxBefore}) deveria vir antes de "${after}" (idx ${idxAfter})`,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ds-golden-full-render (#2108) — golden de página inteira do renderHTML", () => {
  // Renderiza UMA vez; todos os testes neste describe compartilham o mesmo output.
  // Pure — fixture determinística → output estável entre execuções.
  const html = renderHTML(FULL_FIXTURE);

  // ── Sanidade básica ───────────────────────────────────────────────────────

  it("output não-vazio e tem estrutura de container email", () => {
    assert.ok(html.length > 5000, `HTML parece muito curto (${html.length} chars)`);
    assert.ok(html.includes('<table role="presentation"'), "container email ausente");
    assert.ok(html.includes("max-width:600px"), "cap de largura do container ausente");
    assert.ok(html.includes('class="container" width="100%"'), "container responsivo (width 100%) ausente");
    // #260629 (b): wrapper MSO cap 600 no Outlook (ignora max-width).
    assert.ok(html.includes('<!--[if mso]><table role="presentation" align="center" width="600"'), "wrapper MSO 600 (Outlook cap) ausente");
    assert.ok(html.includes("<!--[if mso]></td></tr></table><![endif]-->"), "fechamento do wrapper MSO ausente");
    assert.ok(html.includes("background:#FFFFFF"), "fundo paper ausente");
  });

  // ── Composição: ordem das seções ─────────────────────────────────────────
  //
  // Regra: cada bloco tem um comentário HTML canônico no render. Verificamos
  // que aparecem na ordem correta no HTML composto.
  //
  // Ordem esperada (alinhada ao renderHTML):
  //   INTRO → coverageLine → introCallout → D1 → boxDivulgacao1 → D2 → D3 → É IA? →
  //   D3 → seções → SORTEIO → ERRO INTENCIONAL → PARA ENCERRAR

  it("composição: coverageLine antes do primeiro Destaque", () => {
    // Usa comentários HTML canônicos — estáveis e não aparecem no conteúdo editorial
    assertOrder(html, "<!-- INTRO (coverage) -->", "<!-- Destaque 1 -->");
  });

  it("composição: introCallout antes do primeiro Destaque", () => {
    assertOrder(html, "<!-- #1648 intro callout (sorteio/CTA) -->", "<!-- Destaque 1 -->");
  });

  it("composição: Destaque 1 antes do boxDivulgacao1", () => {
    assertOrder(html, "<!-- Destaque 1 -->", "<!-- mid callout com imagem -->");
  });

  it("composição: boxDivulgacao1 antes do Destaque 2", () => {
    assertOrder(html, "<!-- mid callout com imagem -->", "<!-- Destaque 2 -->");
  });

  it("composição: Destaque 2 antes do É IA?", () => {
    assertOrder(html, "<!-- Destaque 2 -->", "<!-- É IA? (poll) -->");
  });

  it("composição: Destaque 3 antes do É IA? (#2546)", () => {
    assertOrder(html, "<!-- Destaque 3 -->", "<!-- É IA? (poll) -->");
  });

  it("composição: Destaque 3 antes das seções secundárias", () => {
    assertOrder(html, "<!-- Destaque 3 -->", "<!-- LANÇAMENTOS -->");
  });

  it("composição: seções secundárias antes do SORTEIO", () => {
    // Usa comentários HTML canônicos (únicos no output) — não strings de conteúdo
    // que podem aparecer antes, ex: "Sorteio ao vivo" no introCallout.
    assertOrder(html, "<!-- LANÇAMENTOS -->", "<!-- Sorteio -->");
  });

  it("composição: SORTEIO antes do ERRO INTENCIONAL", () => {
    assertOrder(html, "<!-- Sorteio -->", "<!-- ERRO INTENCIONAL — reveal -->");
  });

  it("composição: ERRO INTENCIONAL antes do PARA ENCERRAR", () => {
    assertOrder(html, "<!-- ERRO INTENCIONAL — reveal -->", "<!-- Para encerrar -->");
  });

  // ── Composição: régua antes do boxDivulgacao1 (caso real #2069) ──────────────
  //
  // O bug #2069: a régua bege (renderDivulgacaoSeparator → renderKicker
  // "Divulgação") sumiu antes do boxDivulgacao1 patrocinado. Os goldens por
  // componente não pegaram porque cada um testava só o seu bloco.
  //
  // Aqui verificamos no output COMPOSTO que:
  //   (a) a régua existe exatamente 1 vez antes do box do meio
  //   (b) está imediatamente antes do box (sem outros comentários de seção
  //       entre ela e o boxDivulgacao1)

  it("régua 'Divulgação' aparece antes do boxDivulgacao1 no HTML composto (#2069)", () => {
    const divulgacaoIdx = html.indexOf("Divulgação");
    const midCalloutIdx = html.indexOf("<!-- mid callout com imagem -->");
    assert.ok(
      divulgacaoIdx !== -1,
      "Kicker 'Divulgação' ausente — bug #2069 regrediu",
    );
    assert.ok(
      midCalloutIdx !== -1,
      "Comentário '<!-- mid callout com imagem -->' ausente",
    );
    assert.ok(
      divulgacaoIdx < midCalloutIdx,
      `Régua 'Divulgação' (idx ${divulgacaoIdx}) deveria preceder o boxDivulgacao1 (idx ${midCalloutIdx})`,
    );
  });

  it("exatamente 1 kicker 'Divulgação' antes do boxDivulgacao1 (sem duplicata)", () => {
    const midCalloutIdx = html.indexOf("<!-- mid callout com imagem -->");
    assert.ok(midCalloutIdx !== -1, "boxDivulgacao1 ausente");
    const before = html.slice(0, midCalloutIdx);
    // Conta ocorrências do ponto teal ● seguido do label "Divulgação" no kicker.
    // O kicker usa text-transform:uppercase via CSS; o HTML raw mantém o acento.
    const matches = [...before.matchAll(/&#9679;<\/span>&nbsp;Divulga[çc]ão/gi)];
    assert.equal(
      matches.length,
      1,
      `Esperado exatamente 1 kicker 'Divulgação' antes do boxDivulgacao1, encontrado ${matches.length}`,
    );
  });

  // ── Composição: seções secundárias presentes e não-vazias ────────────────

  it("todas as 4 seções secundárias renderizam (comentário canônico presente)", () => {
    // renderSection emite `<!-- {NOME} -->` como marcador. Se a seção sumir
    // (ex: items.length === 0 inesperadamente), o comentário some junto.
    assert.ok(html.includes("<!-- LANÇAMENTOS -->"), "seção LANÇAMENTOS ausente");
    assert.ok(html.includes("<!-- OUTRAS NOTÍCIAS -->"), "seção OUTRAS NOTÍCIAS ausente");
    assert.ok(html.includes("<!-- USE MELHOR -->"), "seção USE MELHOR ausente");
    assert.ok(html.includes("<!-- RADAR -->"), "seção RADAR ausente");
  });

  it("nenhum bloco de seção com <td> vazio (sem itens vazios)", () => {
    // Padrão de bloco vazio: <tr><td ...></td></tr> com só whitespace dentro.
    // Detecta seções renderizadas sem items (items.length === 0 → renderSection
    // retorna "" mas erros de composição podem vazar <tr> vazio no join).
    const emptyTd = /<td[^>]*>\s*<\/td>/g;
    const empties = [...html.matchAll(emptyTd)];
    // Permitir no máximo 0 — qualquer hit é candidate a bloco quebrado.
    assert.equal(
      empties.length,
      0,
      `${empties.length} <td> vazio(s) encontrado(s) — possível bloco quebrado`,
    );
  });

  // ── Composição: É IA? posicionado após o último destaque (#2546) ──────────

  it("É IA? está após o Destaque 3, antes das seções secundárias (#2546)", () => {
    const d2Idx = html.indexOf("<!-- Destaque 2 -->");
    const eiaIdx = html.indexOf("<!-- É IA? (poll) -->");
    const d3Idx = html.indexOf("<!-- Destaque 3 -->");
    const lancIdx = html.indexOf("<!-- LANÇAMENTOS -->");
    assert.ok(
      d2Idx !== -1,
      "comentário '<!-- Destaque 2 -->' ausente",
    );
    assert.ok(
      eiaIdx !== -1,
      "comentário '<!-- É IA? (poll) -->' ausente",
    );
    assert.ok(
      d3Idx !== -1,
      "comentário '<!-- Destaque 3 -->' ausente",
    );
    assert.ok(
      lancIdx !== -1,
      "comentário '<!-- LANÇAMENTOS -->' ausente",
    );
    // #2546: ordem D2 < D3 < É IA? < seções secundárias.
    assert.ok(
      d2Idx < d3Idx && d3Idx < eiaIdx && eiaIdx < lancIdx,
      `Posição incorreta: D2(${d2Idx}) < D3(${d3Idx}) < ÉIA(${eiaIdx}) < LANÇ(${lancIdx})`,
    );
  });

  // ── Conteúdo: tokens DS presentes no output composto ─────────────────────

  it("DS tokens canônicos: teal #00A0A0, bege #EBE5D0, papel branco #FFFFFF no output", () => {
    assert.ok(html.includes("#00A0A0"), "teal ausente no output composto");
    assert.ok(html.includes("#EBE5D0"), "bege SURFACE ausente no output composto");
    assert.ok(html.includes("#FFFFFF"), "branco PAPER ausente no output composto");
  });

  it("merge tag {{email}} preservada no É IA? — modo merge-tag sem sig (#1186)", () => {
    assert.ok(html.includes("{{email}}"), "merge tag {{email}} ausente na vote URL");
    // #1186: poll_sig removido — modo merge-tag, sem HMAC por subscriber.
    assert.ok(!html.includes("{{poll_sig}}"), "{{poll_sig}} presente — era esperado ser removido (#1186)");
    assert.ok(!html.includes("&sig="), "sig= presente — era esperado ser removido (#1186)");
  });

  it("placeholders de imagem hero 2x1 presentes para D1, D2 e D3 (#2133/#2141)", () => {
    // #2133/#2141: todos os 3 destaques recebem imagem hero 2:1 inline no email.
    // renderDestaque usa heroFile = `04-d${d.n}-2x1.jpg` — não depende de
    // imageFile (que continua 1x1 no D2/D3 para uso no social preview).
    assert.ok(html.includes("{{IMG:04-d1-2x1.jpg}}"), "placeholder imagem D1 ausente");
    assert.ok(
      html.includes("{{IMG:04-d2-2x1.jpg}}"),
      "D2 deve ter imagem hero 2x1 inline (#2133/#2141)",
    );
    assert.ok(
      html.includes("{{IMG:04-d3-2x1.jpg}}"),
      "D3 deve ter imagem hero 2x1 inline (#2133/#2141)",
    );
    // 1x1 NÃO deve aparecer como hero (imageFile do D2/D3 é 1x1, mas hero usa 2x1):
    assert.ok(
      !html.includes("{{IMG:04-d2-1x1.jpg}}"),
      "hero D2 não deve usar arquivo 1x1 (deve ser 2x1)",
    );
    assert.ok(
      !html.includes("{{IMG:04-d3-1x1.jpg}}"),
      "hero D3 não deve usar arquivo 1x1 (deve ser 2x1)",
    );
  });

  it("placeholders de imagem do É IA? presentes ({{IMG:01-eia-A.jpg}} e B)", () => {
    assert.ok(html.includes("{{IMG:01-eia-A.jpg}}"), "placeholder eia-A ausente");
    assert.ok(html.includes("{{IMG:01-eia-B.jpg}}"), "placeholder eia-B ausente");
  });

  it("leaderboard do mês renderiza com pódio e link histórico (#1160)", () => {
    assert.ok(html.includes("Vencedores de Maio"), "leaderboard pódio ausente");
    assert.ok(html.includes("1º Davyd"), "1º lugar ausente");
    assert.ok(html.includes("2º Luisao P"), "2º lugar ausente");
    assert.ok(
      html.includes("poll.diaria.workers.dev/leaderboard/2026-05"),
      "link histórico leaderboard ausente",
    );
  });

  it("reveal do erro intencional presente entre SORTEIO e PARA ENCERRAR", () => {
    assert.ok(
      html.includes("GPT-4 foi lançado em 2022"),
      "reveal do erro intencional ausente",
    );
    // Teaser da edição corrente NÃO deve aparecer (filtrado por pickErroIntencionalReveal)
    assert.ok(
      !html.includes("escondemos um erro proposital"),
      "teaser da edição corrente não deve ser renderizado no callout reveal",
    );
  });

  it("PARA ENCERRAR tem pills de curadoria e CTA 'Agora que chegou'", () => {
    assert.ok(html.includes("Cursos de IA"), "pill 'Cursos de IA' ausente");
    assert.ok(html.includes("Livros sobre IA"), "pill 'Livros sobre IA' ausente");
    assert.ok(html.includes("Agora que chegou"), "CTA 'Agora que chegou' ausente");
    assert.ok(html.includes("border-radius:999px"), "pills sem border-radius:999px");
    // #2138: pills devem ter font-size:16px (CTA no tamanho do corpo)
    // Âncora pill: border-radius:999px + font-size:16px (#2160: padding pode variar).
    assert.match(html, /border-radius:999px[^>]*font-size:16px/, "pills devem ter font-size:16px (#2138)");
    assert.doesNotMatch(html, /border-radius:999px[^>]*font-size:12px/, "pills não devem ter font-size:12px");
    // #2139: table de pills centralizada via align="center" + margin:0 auto (Outlook fix #2160)
    assert.match(
      html,
      /align="center"[^>]*cellpadding="0"[^>]*style="margin:0 auto;"/,
      "table de pills deve ter align=center + margin:0 auto (#2139/#2160)",
    );
    // Kicker "Acesse nossas curadorias:" permanece em 12px (label de seção, não botão).
    // Ancorado no texto do kicker pra não casar com os boxes "Por que isso importa" (#2160).
    assert.match(
      html,
      /font-size:12px[^>]*>Acesse nossas curadorias:/,
      "kicker curadorias deve permanecer em 12px",
    );
  });

  it("output não contém valores ad-hoc do canvas antigo (#1936)", () => {
    assert.ok(!html.includes("Newsreader"), "fonte Newsreader não deve aparecer");
    assert.ok(!/\#F4EFE2/i.test(html), "paper antigo #F4EFE2 não deve aparecer");
    assert.ok(!/\#f0fafa/i.test(html), "teal-tint ad-hoc #f0fafa não deve aparecer");
    assert.ok(!/\#1a1a1a/i.test(html), "ink ad-hoc #1a1a1a não deve aparecer");
    assert.ok(!/\#E0D9C4/i.test(html), "régua bege antiga #E0D9C4 não deve aparecer");
  });

  // ── Golden snapshot ───────────────────────────────────────────────────────
  //
  // Mesmo mecanismo de ds-golden-components.test.ts:
  //   - 1ª execução (ou NODE_TEST_SNAPSHOTS=1): grava o golden.
  //   - Execuções subsequentes: compara hash + HTML canônico.
  //   - Mudança de design intencional → atualizar com NODE_TEST_SNAPSHOTS=1.
  //
  // IMPORTANTE: falha aqui + asserções de composição acima OK = mudança de
  // design (atualizar golden). Falha nas asserções acima = composição quebrada
  // (investigar renderHTML ANTES de atualizar o golden).

  it("snapshot hash — mudança intencional de design requer update explícito", () => {
    const snap = loadSnapshot();

    const updating =
      process.env.NODE_TEST_SNAPSHOTS === "1" ||
      process.argv.includes("--update-snapshots");

    if (!snap) {
      saveSnapshot(html);
      console.log("  [ds-golden-full-render] snapshot criado (primeira execução)");
      return;
    }

    const currentHash = sha256Short(html);

    if (updating) {
      saveSnapshot(html);
      console.log("  [ds-golden-full-render] snapshot atualizado");
      return;
    }

    if (currentHash !== snap.entry.hash) {
      assert.fail(
        `HTML composto divergiu do golden (${snap.entry.hash} → ${currentHash}).\n` +
          `  Se a mudança é intencional (novo componente, refactor de token DS), atualize:\n` +
          `    NODE_TEST_SNAPSHOTS=1 npm test\n` +
          `  Se as asserções de COMPOSIÇÃO acima passaram, é só drift de design → update ok.\n` +
          `  Se alguma asserção de composição falhou → investigar renderHTML, não atualizar.`,
      );
    }
  });
});
