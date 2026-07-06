/**
 * test/brevo-dashboard-ds-drift.test.ts (#2084, refatorado #2107)
 *
 * Garante que os tokens DS no worker não driftem dos valores canônicos em
 * scripts/lib/shared/design-tokens.ts.
 *
 * Arquitetura pós-#2107: o arquivo `workers/brevo-dashboard/src/ds-tokens.generated.ts`
 * é GERADO por `scripts/generate-worker-tokens.ts` a partir de design-tokens.ts.
 * O Worker importa desse arquivo gerado em vez de duplicar valores manualmente.
 *
 * Este teste valida o arquivo gerado contra a fonte canônica — é a rede de CI
 * que falha se alguém esqueceu de regenerar após atualizar design-tokens.ts.
 * (O `pretest` e o `wrangler.toml [build]` garantem geração automática, mas o
 * teste continua como guard explícito para o caso de regeneração manual esquecida
 * num commit que inclui apenas a mudança de design-tokens.ts sem o generated.)
 *
 * Também testa o formato da coluna "Enviado" com dia da semana (#2085).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COLORS, FONTS } from "../scripts/lib/shared/design-tokens.ts";
import { DS_COLORS, DS_FONTS } from "../workers/brevo-dashboard/src/ds-tokens.generated.ts";
import { DS_TOKENS, DS_FONTS as DS_FONTS_INDEX, renderDashboardHtml } from "../workers/brevo-dashboard/src/index.ts";
import { generateTokensContent } from "../scripts/generate-worker-tokens.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("ds-tokens.generated.ts — paridade com design-tokens.ts (#2084, #2107)", () => {
  test("DS_COLORS.brand espelha COLORS.brand (teal)", () => {
    assert.equal(DS_COLORS.brand, COLORS.brand);
  });

  test("DS_COLORS.ink espelha COLORS.ink", () => {
    assert.equal(DS_COLORS.ink, COLORS.ink);
  });

  test("DS_COLORS.paper espelha COLORS.paper (fundo web)", () => {
    assert.equal(DS_COLORS.paper, COLORS.paper);
  });

  test("DS_COLORS.paperAlt espelha COLORS.paperAlt (bege shell)", () => {
    assert.equal(DS_COLORS.paperAlt, COLORS.paperAlt);
  });

  test("DS_COLORS.rule espelha COLORS.rule (hairline bege)", () => {
    assert.equal(DS_COLORS.rule, COLORS.rule);
  });
});

describe("ds-tokens.generated.ts DS_FONTS — paridade com design-tokens.ts (#2084, #2107)", () => {
  test("DS_FONTS.sans espelha FONTS.sans (Geist → system sans)", () => {
    assert.equal(DS_FONTS.sans, FONTS.sans);
  });
});

describe("index.ts re-exporta tokens gerados sem drift (#2107)", () => {
  test("DS_TOKENS (re-export do index) é idêntico a DS_COLORS do generated", () => {
    assert.deepEqual(DS_TOKENS, DS_COLORS);
  });

  test("DS_FONTS do index é idêntico ao DS_FONTS do generated", () => {
    assert.deepEqual(DS_FONTS_INDEX, DS_FONTS);
  });
});

describe("brevo-dashboard CSS aplica tema visual da dashboard (DASH_THEME, #2991)", () => {
  // #2991: a partir do restyle "Agendamento em todas as abas", o :root da
  // dashboard passou a usar DASH_THEME (workers/brevo-dashboard/src/render-links.ts)
  // — um skin INTENCIONALMENTE separado de DS_COLORS/design-tokens.ts (marca
  // pública teal, usada nos e-mails). Os testes abaixo (que checavam os valores
  // DS canônicos no HTML renderizado) foram atualizados para os novos valores
  // de DASH_THEME; os testes de paridade DS_COLORS×design-tokens.ts acima
  // continuam intactos (essa camada não mudou).
  const baseCampaign = {
    id: 1,
    name: "Test",
    subject: "Subj",
    status: "sent",
    sentDate: "2026-06-11T09:00:00Z",
    scheduledAt: null,
    createdAt: "2026-06-11T09:00:00Z",
    recipients: { lists: [1] },
    listName: "T1-W1",
    listSize: 50,
    statistics: {
      globalStats: {
        sent: 50, delivered: 48, hardBounces: 0, softBounces: 2,
        uniqueViews: 20, viewed: 22, trackableViews: 18,
        uniqueClicks: 2, clickers: 2, unsubscriptions: 0,
        complaints: 0, appleMppOpens: 0,
      },
    },
  };

  const html = renderDashboardHtml([baseCampaign]);

  test("fundo paper (cream) aplicado ao body (#faf8f3)", () => {
    assert.match(html, /background: var\(--paper\)/, "body deve ter background: var(--paper)");
    assert.match(html, /--paper: #faf8f3/, "CSS custom property --paper deve ser #faf8f3 (DASH_THEME)");
  });

  test("--brand verde DASH_THEME aplicado (#1f7a5c)", () => {
    assert.match(html, /--brand: #1f7a5c/, "CSS custom property --brand deve ser #1f7a5c");
  });

  test("--ink DASH_THEME aplicado (#262019)", () => {
    assert.match(html, /--ink: #262019/, "CSS custom property --ink deve ser #262019");
  });

  test("--paper-alt bege DASH_THEME aplicado aos headers (#f0ece1)", () => {
    assert.match(html, /--paper-alt: #f0ece1/, "CSS custom property --paper-alt deve ser #f0ece1");
    assert.match(html, /background: var\(--paper-alt\)/, "th deve usar var(--paper-alt) como fundo");
  });

  test("--rule/--hair DASH_THEME aplicado (#e4ddcf)", () => {
    assert.match(html, /--rule: #e4ddcf/, "CSS custom property --rule deve ser #e4ddcf");
    assert.match(html, /--hair: #e4ddcf/, "CSS custom property --hair deve ser #e4ddcf");
  });

  test("--card branco DASH_THEME aplicado (#ffffff)", () => {
    assert.match(html, /--card: #ffffff/, "CSS custom property --card deve ser #ffffff");
  });

  test("font-family Geist DS aplicada ao body", () => {
    assert.match(html, /'Geist'/, "body deve usar Geist (DS sans)");
  });

  test("valores ad-hoc antigos não aparecem mais no HTML", () => {
    // #FAFAFA era o background dos headers (ad-hoc, não DS)
    assert.doesNotMatch(html, /#FAFAFA/i, "não deve conter #FAFAFA (header bg antigo)");
    // #F5F5F5 era o background do code no footer (ad-hoc)
    assert.doesNotMatch(html, /#F5F5F5/i, "não deve conter #F5F5F5 (code bg antigo)");
    // #1A1A1A era o --text ad-hoc (não DS — ink canônico é #171411)
    assert.doesNotMatch(html, /#1A1A1A/i, "não deve conter #1A1A1A (--text ad-hoc antigo)");
    // #E5E5E5 era o --rule ad-hoc (não DS — rule canônico é #EBE5D0 bege)
    assert.doesNotMatch(html, /#E5E5E5/i, "não deve conter #E5E5E5 (--rule ad-hoc antigo)");
    // #999 era usado como muted inline (não DS)
    assert.doesNotMatch(html, /#999\b/i, "não deve conter #999 inline (muted ad-hoc antigo)");
    // Inter sem Geist = font stack ad-hoc antigo
    assert.doesNotMatch(html, /font-family: -apple-system.*Inter/, "não deve ter stack ad-hoc Inter sem Geist");
  });
});

describe("renderDashboardHtml: coluna Enviado inclui dia da semana (#2085)", () => {
  // 2026-06-11 09:00 UTC = 06:00 BRT (America/Sao_Paulo, UTC-3)
  // Dia da semana: quinta-feira (qua.? — vamos checar: 2026-06-11 é quinta)
  // toLocaleString pt-BR weekday:"short" → "qui."
  const campaign = {
    id: 42,
    name: "Wave test",
    subject: "Subj",
    status: "sent",
    sentDate: "2026-06-11T09:00:00Z", // 06:00 BRT, quinta
    scheduledAt: null,
    createdAt: "2026-06-11T09:00:00Z",
    recipients: { lists: [1] },
    listName: "T1-W1",
    listSize: 50,
    statistics: {
      globalStats: {
        sent: 50, delivered: 48, hardBounces: 0, softBounces: 2,
        uniqueViews: 20, viewed: 22, trackableViews: 18,
        uniqueClicks: 2, clickers: 2, unsubscriptions: 0,
        complaints: 0, appleMppOpens: 0,
      },
    },
  };

  const html = renderDashboardHtml([campaign]);

  test("formato 'dia., DD/MM HH:mm' aparece na célula de data", () => {
    // O formato pt-BR com weekday:short, day, month, hour, minute em
    // America/Sao_Paulo para 2026-06-11T09:00:00Z (= 06:00 BRT, quinta):
    // toLocaleString gera algo como "qui., 11/06 06:00"
    // O separador exato varia por runtime (vírgula + espaço ou só ponto).
    // Testamos a presença de dia-da-semana abreviado + data no formato DD/MM.
    assert.match(
      html,
      /[a-zçã]{3,4}\.,?\s*11\/06/i,
      "célula de data deve conter abreviação do dia da semana + 11/06",
    );
  });

  test("hora BRT (06:00) aparece junto ao dia da semana", () => {
    assert.match(html, /06:00/, "hora BRT deve aparecer na célula de data");
  });

  test("linha 'sem stats' também exibe dia da semana", () => {
    // Campanha sem stats para verificar o path da linha sem stats (~linha 219)
    const noStatsCampaign = {
      id: 99,
      name: "No stats",
      subject: "Subj",
      status: "sent",
      sentDate: "2026-06-11T09:00:00Z",
      scheduledAt: null,
      createdAt: "2026-06-11T09:00:00Z",
      recipients: { lists: [1] },
      listName: "T1-W2",
      listSize: 30,
      statistics: { campaignStats: undefined, globalStats: undefined },
    };

    const noStatsHtml = renderDashboardHtml([noStatsCampaign]);

    // "sem stats" row usa fmtTimeBRT(c.sentDate) — deve ter o weekday também
    assert.match(noStatsHtml, /[a-zçã]{3,4}\.,?\s*11\/06/i,
      "linha 'sem stats' deve exibir dia da semana + data");
    assert.match(noStatsHtml, /sem stats/, "deve ter texto 'sem stats'");
  });
});

// ─── #2125: check de sync gerado×fonte ───────────────────────────────────────
// Garante que os arquivos commitados refletem exatamente o que o gerador
// produziria. Falha se alguém editar o template do gerador sem regenerar,
// ou commitar uma versão editada manualmente do arquivo gerado.

describe("ds-tokens.generated.ts: sync gerado×fonte (#2125)", () => {
  const expectedContent = generateTokensContent(COLORS, FONTS);

  for (const worker of ["brevo-dashboard", "diaria-dashboard"]) {
    test(`workers/${worker}/src/ds-tokens.generated.ts está em sync com generate-worker-tokens.ts`, () => {
      const generatedPath = resolve(__dirname, `../workers/${worker}/src/ds-tokens.generated.ts`);
      const actualContent = readFileSync(generatedPath, "utf8");
      assert.equal(
        actualContent,
        expectedContent,
        `workers/${worker}/src/ds-tokens.generated.ts diverge do que generate-worker-tokens.ts produziria. ` +
        "Rode: npx tsx scripts/generate-worker-tokens.ts",
      );
    });
  }
});
