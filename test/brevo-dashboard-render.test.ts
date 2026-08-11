/**
 * Regression test for #1141 fix: dashboard worker showed numbers
 * different from Brevo Web UI because it was reading campaignStats[0]
 * (which excludes Apple MPP opens) instead of globalStats (which
 * includes them).
 *
 * Fix: renderDashboardHtml prefers globalStats over campaignStats[0],
 * with campaignStats[0] as fallback when globalStats is missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../workers/brevo-dashboard/src/index.ts";

const baseCampaign = {
  id: 29,
  name: "Test campaign",
  subject: "Test subject",
  status: "sent",
  sentDate: "2026-05-08T22:24:00Z",
  scheduledAt: null,
  createdAt: "2026-05-08T22:24:00Z",
  recipients: { lists: [9] },
  listName: "T1-W1 (top 50)",
  listSize: 50,
};

test("renderDashboardHtml prefers globalStats (with MPP) over campaignStats[0]", () => {
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 50,
        delivered: 48,
        hardBounces: 0,
        softBounces: 2,
        uniqueViews: 26,           // <-- com MPP
        viewed: 34,
        trackableViews: 14,
        uniqueClicks: 0,
        clickers: 0,
        unsubscriptions: 0,
        complaints: 0,
        appleMppOpens: 6,
      },
      campaignStats: [{
        listId: 9,
        sent: 50,
        delivered: 48,
        hardBounces: 0,
        softBounces: 2,
        deferred: 0,
        uniqueViews: 18,           // <-- SEM MPP (número antigo, errado)
        viewed: 19,
        trackableViews: 14,
        uniqueClicks: 0,
        clickers: 0,
        unsubscriptions: 0,
        complaints: 0,
      }],
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // 26 opens com MPP / 48 delivered = 54.2%
  // #3678: célula Opens simplificada — só taxa total + count total, sem o
  // parêntese "(X% sem MPP · Y% trackable)" que existia desde #1153/#3040.

  // Rate com MPP no topo (bold/teal via .metric)
  assert.ok(html.includes("54.2%"), "deveria mostrar open rate com MPP = 54.2% (26/48)");

  // Sem parêntese/span rate-inline na célula Opens (#3678).
  assert.ok(!/54\.2%\s*<span class="rate-inline">/.test(html),
    "célula Opens não deve mais ter parêntese com sem-MPP/trackable (#3678)");

  // Count na linha de baixo: só o total.
  assert.ok(/<small>26<\/small>/.test(html),
    "count de Opens deve mostrar só o total '26', sem breakdown (#3678)");

  // Não deve mostrar formato antigo "X + Y MPP"
  assert.ok(!/\+\s*\d+\s*MPP/.test(html), "não deve usar mais o formato 'N + N MPP'");
});

test("renderDashboardHtml fallback pra campaignStats[0] quando globalStats ausente", () => {
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      // sem globalStats — simula falha do fetch individual
      campaignStats: [{
        listId: 9,
        sent: 50,
        delivered: 48,
        hardBounces: 0,
        softBounces: 2,
        deferred: 0,
        uniqueViews: 18,
        viewed: 19,
        trackableViews: 14,
        uniqueClicks: 0,
        clickers: 0,
        unsubscriptions: 0,
        complaints: 0,
      }],
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // Sem globalStats → cai pro campaignStats. Deve mostrar 18.
  assert.ok(html.includes("18"), "fallback deve mostrar uniqueViews=18 do campaignStats[0]");

  // Open rate 18/48 = 37.5%
  assert.ok(html.includes("37.5%"), "open rate fallback deveria ser 37.5%");

  // Sem MPP no data row no fallback. "· N MPP" só aparece na célula do row.
  // (A palavra "MPP" aparece em texto explicativo do header — não conta.)
  assert.ok(!/\+\s*\d+\s*MPP/.test(html), "fallback não deve ter anotação '+ N MPP' na célula");
});

test("renderDashboardHtml detecta globalStats zeroed e cai pra campaignStats (#1148 defense-in-depth)", () => {
  // Cenário real verificado 2026-05-12: o listing /v3/emailCampaigns
  // retorna `globalStats: { sent: 0, delivered: 0, ... }` (zeroed, não
  // undefined) pra TODAS as campaigns. fetchRecentCampaigns filtra esse
  // caso. Mas se zeroed escapar pro render (regressão futura, race
  // condition, etc), o render trata `sent=0` como "stats indisponível"
  // e cai pro campaignStats[0]. Sem isso, dashboard mostra todos zeros
  // pra campaigns onde o GET individual falhou — exatamente o bug
  // identificado no review do PR.
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 0,
        delivered: 0,
        hardBounces: 0,
        softBounces: 0,
        uniqueViews: 0,
        viewed: 0,
        trackableViews: 0,
        uniqueClicks: 0,
        clickers: 0,
        unsubscriptions: 0,
        complaints: 0,
        appleMppOpens: 0,
      },
      campaignStats: [{
        listId: 9,
        sent: 50,
        delivered: 48,
        hardBounces: 0,
        softBounces: 2,
        deferred: 0,
        uniqueViews: 18,
        viewed: 19,
        trackableViews: 14,
        uniqueClicks: 0,
        clickers: 0,
        unsubscriptions: 0,
        complaints: 0,
      }],
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // Render deve usar campaignStats[0] (18 opens, 37.5%), NÃO o zeroed globalStats.
  assert.ok(html.includes("18"), "deveria mostrar uniqueViews=18 do campaignStats (não zeros do globalStats fake)");
  assert.ok(html.includes("37.5%"), "deveria mostrar open rate 37.5% do campaignStats");

  // Sem anotação MPP — campaignStats não tem o campo, e o gsIsReal detectou
  // que globalStats é fake.
  assert.ok(!/\+\s*\d+\s*MPP/.test(html), "não deve anotar MPP quando o globalStats é fake (sent=0)");
});

test("renderDashboardHtml não mostra 'X subs' na coluna Lista", () => {
  // Pedido editorial: coluna Lista mostra só o nome, sem subscriber count
  // (informação redundante — listSize já implícito no Sent).
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 50, delivered: 48, hardBounces: 0, softBounces: 2,
        uniqueViews: 26, viewed: 34, trackableViews: 14,
        uniqueClicks: 0, clickers: 0, unsubscriptions: 0,
        complaints: 0, appleMppOpens: 6,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);

  assert.ok(!/\d+\s+subs/.test(html), "não deve mostrar 'N subs' em nenhum lugar do HTML");
});

test("#3678: célula Opens é sempre taxa total + count total, independente de MPP/trackable", () => {
  // Antes do #3678 o layout variava conforme presença de MPP/trackableViews
  // (#1153/#3040/#3056/#3084). O editor pediu simplificação — a célula
  // Opens SEMPRE mostra só a taxa total (com MPP, igual UI da Brevo) e o
  // count total, sem parêntese, independente do que os dados de MPP/trackable
  // contenham. Cobrimos os 2 casos que antes divergiam: sem MPP/sem trackable,
  // e com MPP/sem trackable.
  const noMppNoTrackable = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 50, delivered: 48, hardBounces: 0, softBounces: 2,
        uniqueViews: 20, viewed: 22,
        trackableViews: undefined as unknown as number,
        uniqueClicks: 0, clickers: 0, unsubscriptions: 0,
        complaints: 0, appleMppOpens: 0,
      },
    },
  }];

  const html1 = renderDashboardHtml(noMppNoTrackable);
  assert.ok(html1.includes("41.7%"), "deveria mostrar 41.7% (20/48)");
  assert.ok(!/<span class="rate-inline">/.test(html1),
    "célula Opens não deve mais ter span rate-inline (#3678)");
  assert.ok(/<small>20<\/small>/.test(html1), "count deve ser '20' puro, sem parens");
  assert.ok(!/\+\s*\d+\s*MPP/.test(html1), "não deve ter '+ N MPP' quando appleMppOpens=0");

  const mppNoTrackable = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 50, delivered: 48, hardBounces: 0, softBounces: 2,
        uniqueViews: 26, viewed: 34,
        trackableViews: undefined as unknown as number,
        uniqueClicks: 0, clickers: 0, unsubscriptions: 0,
        complaints: 0, appleMppOpens: 6,
      },
    },
  }];

  const html2 = renderDashboardHtml(mppNoTrackable);
  assert.ok(html2.includes("54.2%"), "deveria mostrar 54.2% (26/48), taxa total com MPP");
  assert.ok(!/54\.2%\s*<span class="rate-inline">/.test(html2),
    "célula Opens não deve mostrar parêntese sem-MPP mesmo com MPP presente (#3678)");
  assert.ok(/<small>26<\/small>/.test(html2), "count deve mostrar só o total '26' (#3678)");
});

test("renderDashboardHtml: não renderiza botão de refresh (redundante com F5)", () => {
  // Página tem Cache-Control no-store + F5/Ctrl+R faz o mesmo que
  // o botão fazia. Removido em PR de polimento.
  // Nota: botões de paginação (#2423) são permitidos — o assert abaixo verifica
  // ausência de botão de "Recarregar" / refresh, não de qualquer <button>.
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 50, delivered: 48, hardBounces: 0, softBounces: 2,
        uniqueViews: 26, viewed: 34, trackableViews: 14,
        uniqueClicks: 0, clickers: 0, unsubscriptions: 0,
        complaints: 0, appleMppOpens: 6,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);

  assert.ok(!/Recarregar/.test(html), "não deve ter texto 'Recarregar'");
  assert.ok(!/onclick=/.test(html), "não deve ter inline onclick");
  assert.ok(!/class="actions"/.test(html), "não deve ter div .actions");
  // Botões de paginação são legítimos (#2423); o que não pode existir é botão de refresh.
  assert.ok(!/<button[^>]*>.*[Rr]ecarregar/.test(html), "não deve ter botão de Recarregar");
});

test("renderDashboardHtml: Unsub tem taxa em cima + count embaixo (como as outras métricas)", () => {
  // Per circuit breakers doc: unsub ÷ sent. Valor SEGURO (abaixo do
  // threshold) pra testar layout sem triggerar alerta.
  // sent=1000: unsubs=5 → 0.5% (< 3%)
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 1000, delivered: 990,
        hardBounces: 5, softBounces: 5,       // 1% bounce
        uniqueViews: 200, viewed: 240,        // 20% open
        trackableViews: 150,
        uniqueClicks: 25, clickers: 25,
        unsubscriptions: 5,                   // 0.5% unsub
        complaints: 0,                        // 0% spam (Brevo — não usado mais na coluna Spam, #4970)
        appleMppOpens: 40,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // Unsub: 5/1000 = 0.5% em cima, "5" embaixo
  assert.ok(/<td>0\.5%<br><small>5<\/small><\/td>/.test(html),
    "Unsub deve mostrar '0.5%' em cima e '5' embaixo (sem class alert)");

  // #4970: sem `postmasterSpam` (default null) e `baseCampaign.sentDate` bem
  // no passado, a célula Spam não tem registro por-campanha nem está dentro
  // da janela de "aguardando publicação" — cai no estado "unavailable".
  // `complaints` (0 nesta fixture) NUNCA aparece mais na célula.
  assert.ok(/<td style="[^"]*">Sem dado atribuível<\/td>/.test(html),
    "Spam sem postmasterSpam e campanha antiga deve mostrar 'Sem dado atribuível', nunca um percentual de complaints");
});

test("renderDashboardHtml: alerta visual quando métrica cruza circuit breaker threshold", () => {
  // Cenário crítico: bounce 5%, unsub 4%, open rate 8%. Todos cruzam os
  // thresholds. Cells devem ganhar class="alert". `complaints` (2, 0.2%)
  // segue na fixture só pra provar que NÃO influencia mais a coluna Spam
  // (#4970 — ver teste dedicado abaixo pra cobertura da célula Spam em si).
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 1000, delivered: 950,
        hardBounces: 30, softBounces: 20,    // 5% total bounce
        uniqueViews: 76, viewed: 90,         // 76/950 = 8% open (< 15%)
        trackableViews: 50,
        uniqueClicks: 5, clickers: 5,
        unsubscriptions: 40,                 // 4% unsub
        complaints: 2,                       // 0.2% spam (Brevo — não lido pela coluna Spam desde #4970)
        appleMppOpens: 10,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // Opens com class metric + alert (taxa baixa demais)
  assert.ok(/<td class="metric alert">/.test(html),
    "Opens deve ter class 'metric alert' quando rate < 15%");

  // #3078: bounce alerta quando hard ≥2% OU total ≥5% (não mais um combinado de 3%).
  // Aqui hard=3% e total=5% cruzam os dois breakers.
  assert.ok(/<td class="alert">5\.0%<br><small>50<\/small><\/td>/.test(html),
    "Bounces deve ter class alert quando hard ≥2% ou total ≥5%");
  assert.ok(/<td class="alert">4\.0%<br><small>40<\/small><\/td>/.test(html),
    "Unsub deve ter class alert quando rate ≥ 3%");
  // #4970: sem postmasterSpam e campanha antiga (baseCampaign.sentDate), a
  // célula Spam da tabela ENVIOS (a que segue logo depois de Unsub na mesma
  // linha) não deriva NADA de `complaints` — nem "0.200%" nem alerta. (A
  // aba "Saúde"/Rampa também mostra um "Spam (Brevo)" derivado de
  // `complaints`, fora de escopo do #4970 — por isso o teste escopa a busca
  // à linha da tabela Envios, não à página inteira.)
  assert.ok(
    /<td class="alert">4\.0%<br><small>40<\/small><\/td>\s*<td style="[^"]*">Sem dado atribuível<\/td>/.test(html),
    "célula Spam da linha Envios deve ser 'Sem dado atribuível', nunca um percentual derivado de complaints",
  );
});

test("renderDashboardHtml: alerta no boundary exato dos thresholds (bounce hard 2%/total 5%, unsub 3%)", () => {
  // Cenário: cada métrica EXATAMENTE no threshold do circuit breaker (#3078:
  // bounce usa os 2 breakers reais do doc — hard ≥2%, total ≥5% — não mais um
  // ≥3% combinado inventado). unsub 3.0%, open 15.0%.
  // - bounce hard/total, unsub EXATO no limite → alert ON
  // - open EXATO em 15% → alert OFF (porque < 15, não ≤)
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 1000, delivered: 1000,
        hardBounces: 20, softBounces: 30,    // hard 20/1000=2.0% exato; total 50/1000=5.0% exato
        uniqueViews: 150, viewed: 150,       // 150/1000 = 15.0% exato
        trackableViews: 130,
        uniqueClicks: 5, clickers: 5,
        unsubscriptions: 30,                 // 30/1000 = 3.0% exato
        complaints: 1,                       // 1/1000 = 0.1% (Brevo — não lido pela coluna Spam desde #4970)
        appleMppOpens: 20,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // Bounce, Unsub: EXATO no threshold → alerta ON (≥)
  assert.ok(/<td class="alert">5\.0%<br><small>50<\/small><\/td>/.test(html),
    "Bounce hard 2.0%/total 5.0% (exato nos thresholds) deve acionar alerta");

  // Open: EXATO em 15.0% → alerta OFF (< 15, não ≤)
  // Opens tem .metric sempre + .alert condicional. No boundary, só .metric.
  assert.ok(/<td class="metric">/.test(html),
    "Open 15.0% (exato no threshold) NÃO deve acionar alerta (regra é < 15, não ≤)");
});

test("#3078: bounce hard-alto/total-baixo (hard 2.5%, total 2.8%) alerta na tabela Envios", () => {
  // Regressão: caso citado na issue #3078 — hard bounce isoladamente já
  // estoura o breaker (≥2%) mesmo com o total (hard+soft) ainda longe do
  // breaker de 5%. Threshold combinado antigo (≥3%) NÃO capturava isso.
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 1000, delivered: 990,
        hardBounces: 25, softBounces: 3,     // hard 2.5%, total 2.8%
        uniqueViews: 200, viewed: 220,
        trackableViews: 150,
        uniqueClicks: 20, clickers: 20,
        unsubscriptions: 2,
        complaints: 0,
        appleMppOpens: 15,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);
  assert.ok(/<td class="alert">2\.8%<br><small>28<\/small><\/td>/.test(html),
    "Bounces (hard 2.5%/total 2.8%) deve ter class alert — hard sozinho já estoura o breaker de 2%");
});

test("#3078: bounce total-alto/hard-baixo (hard 1%, total 5.5%) alerta na tabela Envios", () => {
  // Caso espelhado: hard baixo, mas total estoura o breaker de 5%.
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 1000, delivered: 990,
        hardBounces: 10, softBounces: 45,    // hard 1.0%, total 5.5%
        uniqueViews: 200, viewed: 220,
        trackableViews: 150,
        uniqueClicks: 20, clickers: 20,
        unsubscriptions: 2,
        complaints: 0,
        appleMppOpens: 15,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);
  assert.ok(/<td class="alert">5\.5%<br><small>55<\/small><\/td>/.test(html),
    "Bounces (hard 1.0%/total 5.5%) deve ter class alert — total sozinho já estoura o breaker de 5%");
});

test("#3078: bounce ambos baixos (hard 1%, total 1.5%) NÃO alerta na tabela Envios", () => {
  // Sem falso positivo: nem hard nem total cruzam seus breakers.
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 1000, delivered: 990,
        hardBounces: 10, softBounces: 5,     // hard 1.0%, total 1.5%
        uniqueViews: 200, viewed: 220,
        trackableViews: 150,
        uniqueClicks: 20, clickers: 20,
        unsubscriptions: 2,
        complaints: 0,
        appleMppOpens: 15,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);
  assert.ok(!/<td class="alert">1\.5%<br><small>15<\/small><\/td>/.test(html),
    "Bounces (hard 1.0%/total 1.5%, ambos abaixo do threshold) NÃO deve ter class alert");
});

test("renderDashboardHtml: SEM alerta quando métricas saudáveis (todas abaixo do threshold)", () => {
  // Wave 1 real: 54% open, 4% bounce... espera, 4% bounce cruzaria.
  // Vamos usar cenário totalmente limpo: bounce 1%, unsub 0%, spam 0%, open 47%.
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 100, delivered: 99,
        hardBounces: 0, softBounces: 1,      // 1% bounce (< 3%)
        uniqueViews: 47, viewed: 50,         // 47% open (>= 15%)
        trackableViews: 40,
        uniqueClicks: 3, clickers: 3,
        unsubscriptions: 0,                  // 0% unsub
        complaints: 0,                       // 0% spam
        appleMppOpens: 7,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // Nenhum <td> deve ter class alert (em qualquer combinação).
  // NOTA: o footer usa .alert-label num <span> — não conta. Escopo ao <td>.
  assert.ok(!/<td class="alert">/.test(html), "nenhum <td> deve ter class='alert'");
  assert.ok(!/<td class="metric alert">/.test(html),
    "nenhum <td> deve ter class='metric alert'");

  // Opens mantém só metric
  assert.ok(/<td class="metric">/.test(html),
    "Opens deve ter só class metric quando rate saudável");
});

test("renderDashboardHtml: coluna chama-se 'Spam' (não 'Compl.')", () => {
  // A coluna foi renomeada de "Compl." pra "Spam" — mais direto.
  // Se alguém regredir pra abreviação, este teste pega.
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 50, delivered: 48, hardBounces: 0, softBounces: 2,
        uniqueViews: 26, viewed: 34, trackableViews: 14,
        uniqueClicks: 0, clickers: 0, unsubscriptions: 0,
        complaints: 0, appleMppOpens: 6,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // Header da última coluna deve dizer "Spam"
  assert.ok(/>Spam<\/th>/.test(html), "última coluna deve ser 'Spam'");
  // E não pode ter o antigo "Compl."
  assert.ok(!/>Compl\.</.test(html), "não deve ter mais o header antigo 'Compl.'");
});
