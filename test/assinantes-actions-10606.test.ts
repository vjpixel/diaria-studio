/**
 * test/assinantes-actions-10606.test.ts
 *
 * #10606, revisão do editor (20/10/2026): "a página está com informações
 * demais. muitas delas, não sei qual ação eu faria com a informação." A
 * página /assinantes passou a mostrar no topo só o que pede ação, com a ação
 * ao lado, e o resto num <details> "Detalhes" recolhido.
 *
 * Cobre:
 * 1. `buildActionItems` (lógica pura de scripts/studio-ui/public/assinantes-actions.js):
 *    cada sinal acionável vira item com ação; sinal sem ação (sequência
 *    `desligado`, tudo em dia) não vira item.
 * 2. Estrutura do HTML: bloco de ação no topo, "Detalhes" recolhido por
 *    padrão, blocos removidos não voltam, e todo id que o JS procura existe
 *    no HTML (guard contra `null.innerHTML` depois de enxugar a página).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildActionItems,
  actionItemsHtml,
  staleDraftRows,
  alertAction,
  BLOCK_ACTIONS,
} from "../scripts/studio-ui/public/assinantes-actions.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = resolve(ROOT, "scripts", "studio-ui", "public");
const html = readFileSync(resolve(PUBLIC, "assinantes.html"), "utf8");
const js = readFileSync(resolve(PUBLIC, "assinantes.js"), "utf8");

function step(stepKey: string, label: string, falhos = 0) {
  return { step: stepKey, label, recebidos: 3, porTransporte: { kit: 2, brevo: 1 }, pulados: {}, pendentes: {}, falhos };
}

function funnel(overrides: Record<string, unknown> = {}) {
  return {
    db: { available: true, corrupted: false },
    summary: { byEmail3Stage: {}, staleDrafts: [] },
    refreshErrors: [],
    followup: {
      alerts: [] as Array<{ etapa: string; mensagem: string }>,
      blocked: { apoio: null, form: null },
      steps: [step("email1", "E-mail 1"), step("email2", "E-mail 2"), step("email3", "E-mail 3 (apoio, D+10)")],
      people: [],
      lastRunAt: "2026-10-20T12:00:00.000Z",
    },
    ...overrides,
  };
}

describe("buildActionItems (#10606)", () => {
  it("tudo em dia: nenhuma ação (a página diz 'nada pedindo ação')", () => {
    assert.deepEqual(buildActionItems(funnel()), []);
  });

  it("sem store: nenhuma ação (o aviso de 'sem dados' é outro elemento, nunca um falso 'tudo certo')", () => {
    assert.deepEqual(buildActionItems(funnel({ db: { available: false, corrupted: false } })), []);
  });

  it("store corrompido: 1 item com o que fazer, e só ele (contagens não valem)", () => {
    const items = buildActionItems(funnel({ db: { available: false, corrupted: true } }));
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "store-corrompido");
    assert.match(items[0].acao, /corrigir o JSON/);
  });

  it("alerta de falha em rodadas seguidas vira ação de investigar, apontando o executor certo", () => {
    const items = buildActionItems(
      funnel({
        followup: {
          ...funnel().followup,
          alerts: [
            { etapa: "E-mails 1/2/3 (transporte Kit)", mensagem: "3 rodadas --send seguidas com falha" },
            { etapa: "E-mail 3 (Brevo)", mensagem: "2 rodadas seguidas com falha" },
            { etapa: "Sequências de apoio/formulário", mensagem: "2 rodadas seguidas com falha" },
            { etapa: "Apoio D+30", mensagem: "lote ap-1: broadcast não agendado e não apagado (Kit 422)" },
          ],
        },
      }),
    );
    assert.equal(items.length, 4);
    assert.match(items[0].acao, /onboarding-kit-transport-run\.ts/);
    assert.match(items[1].acao, /onboarding-welcome-run\.ts/);
    assert.match(items[2].acao, /onboarding-followup-run\.ts/);
    assert.match(items[3].acao, /painel do Kit/);
    for (const it of items.slice(0, 3)) assert.equal(it.link?.href, "/tarefas");
  });

  it("sequência travada por texto pendente: ação de aprovar o texto, link pra Caixas", () => {
    const items = buildActionItems(
      funnel({
        followup: {
          ...funnel().followup,
          blocked: { apoio: { motivo: "texto_pendente", detalhe: "onboarding-apoio-d30.md contém PENDENTE" }, form: null },
        },
      }),
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].titulo, "Apoio D+30/90/180/360 travado");
    assert.equal(items[0].link?.href, "/caixas");
  });

  it("sequência `desligado` não vira ação (é escolha de config, fica só em Detalhes)", () => {
    const items = buildActionItems(
      funnel({
        followup: { ...funnel().followup, blocked: { apoio: { motivo: "desligado", detalhe: "kill switch" }, form: { motivo: "desligado", detalhe: "kill switch" } } },
      }),
    );
    assert.deepEqual(items, []);
    assert.equal("desligado" in BLOCK_ACTIONS, false);
  });

  it("motivo de trava novo, sem ação mapeada, NÃO some do topo: vira item genérico (self-review #10651)", () => {
    const items = buildActionItems(
      funnel({
        followup: { ...funnel().followup, blocked: { apoio: null, form: { motivo: "motivo_que_ainda_nao_existe", detalhe: "algo travou" } } },
      }),
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "travado-form");
    assert.match(items[0].acao, /Investigar por que a sequência travou \(motivo "motivo_que_ainda_nao_existe"\)/);
    assert.equal(items[0].link?.href, "/tarefas");
  });

  it("lote Kit da escada falhando: 1 item por etapa, com a sequência de rodadas citada dentro (self-review #10651)", () => {
    const f = funnel();
    f.followup.alerts = [{ etapa: "E-mails 1/2/3 (transporte Kit)", mensagem: "3 rodadas --send seguidas com falha" }];
    f.followup.steps = [step("email1", "E-mail 1", 5), step("email2", "E-mail 2", 0)];
    const items = buildActionItems(f);
    assert.equal(items.length, 1, JSON.stringify(items.map((i) => i.id)));
    assert.equal(items[0].id, "falhos-email1");
    assert.match(items[0].detalhe, /3 rodadas --send seguidas com falha/);
  });

  it("alerta de rodadas seguidas sem etapa falha continua sozinho no topo", () => {
    const f = funnel();
    f.followup.alerts = [{ etapa: "E-mails 1/2/3 (transporte Kit)", mensagem: "2 rodadas --send seguidas com falha" }];
    const items = buildActionItems(f);
    assert.deepEqual(items.map((i) => i.id), ["alerta-0"]);
  });

  it("lote não agendado é o mais específico: absorve envios falhos e a sequência da mesma etapa", () => {
    const f = funnel();
    f.followup.alerts = [
      { etapa: "Sequências de apoio/formulário", mensagem: "2 rodadas seguidas com falha" },
      { etapa: "Apoio D+30", mensagem: "lote ap-1: broadcast não agendado e não apagado (Kit 422)" },
    ];
    f.followup.steps = [step("apoio_d30", "Apoio D+30", 4)];
    const items = buildActionItems(f);
    assert.equal(items.length, 1, JSON.stringify(items.map((i) => i.id)));
    assert.match(items[0].acao, /painel do Kit/);
    assert.match(items[0].detalhe, /4 envio\(s\) falho\(s\) nesta etapa/);
    assert.match(items[0].detalhe, /2 rodadas seguidas com falha/);
  });

  it("alerta do e-mail 3 via Brevo nunca é absorvido por falha de lote Kit", () => {
    const f = funnel();
    f.followup.alerts = [{ etapa: "E-mail 3 (Brevo)", mensagem: "2 rodadas seguidas com falha" }];
    f.followup.steps = [step("email3", "E-mail 3 (apoio, D+10)", 2)];
    assert.deepEqual(buildActionItems(f).map((i) => i.id), ["alerta-0", "falhos-email3"]);
  });

  it("todo motivo de trava, exceto `desligado`, tem ação mapeada", () => {
    for (const m of ["snippet_ausente", "texto_pendente", "snippet_invalido", "form_nao_configurado", "respostas_indisponiveis", "kit_indisponivel"]) {
      assert.ok(BLOCK_ACTIONS[m as keyof typeof BLOCK_ACTIONS]?.acao, `motivo ${m} sem ação`);
    }
  });

  it("etapa com envios falhos vira ação; etapa sem falha não", () => {
    const f = funnel();
    f.followup.steps = [step("email1", "E-mail 1", 0), step("apoio_d30", "Apoio D+30", 4)];
    const items = buildActionItems(f);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "falhos-apoio_d30");
    assert.match(items[0].titulo, /4 envio\(s\) falho\(s\)/);
  });

  it("falha de consulta à Brevo vira ação com botão de reconsultar", () => {
    const byErrors = buildActionItems(funnel({ refreshErrors: [{ campaignId: 77, message: "HTTP 500" }] }));
    assert.equal(byErrors.length, 1);
    assert.equal(byErrors[0].button, "refresh-brevo");
    assert.match(byErrors[0].detalhe, /campanha 77 \(HTTP 500\)/);

    const byStage = buildActionItems(funnel({ summary: { byEmail3Stage: { falha_consulta: 2 }, staleDrafts: [] } }));
    assert.equal(byStage.length, 1);
    assert.match(byStage[0].detalhe, /2 convite\(s\)/);
  });

  it("estado ambíguo na Brevo vira ação de investigar a campanha", () => {
    const items = buildActionItems(funnel({ summary: { byEmail3Stage: { estado_ambiguo: 1 }, staleDrafts: [] } }));
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "brevo-ambiguo");
  });
});

describe("alertAction / staleDraftRows / actionItemsHtml (#10606)", () => {
  it("alerta de lote vence o de etapa (mesmo com 'Kit' no nome da etapa)", () => {
    assert.match(alertAction({ etapa: "E-mails 1/2/3 (transporte Kit)", mensagem: "lote x: broadcast não agendado" }).acao, /painel do Kit/);
  });

  it("rascunho parado carrega a ação do relatório, com '—' no que falta", () => {
    const rows = staleDraftRows([
      { subscriptionId: "s1", email: "a***@x.com", provider: null, stage: "rascunho_criado", ageDays: null, campaignOrBroadcastId: null, nextAction: "revisar broadcast" },
    ]);
    assert.deepEqual(rows, [{ email: "a***@x.com", provider: "—", idade: "—", campanha: "—", acao: "revisar broadcast" }]);
    assert.deepEqual(staleDraftRows(undefined), []);
  });

  it("HTML escapa texto vindo do store e mostra 'Ação:' em cada item", () => {
    const out = actionItemsHtml([
      { id: "x", titulo: "<b>t</b>", detalhe: "d & e", acao: "faça", link: { href: "/tarefas", label: "Ver log em Tarefas" }, button: "refresh-brevo" },
    ]);
    assert.ok(out.includes("&lt;b&gt;t&lt;/b&gt;"));
    assert.ok(out.includes("d &amp; e"));
    assert.ok(out.includes("<strong>Ação:</strong> faça"));
    assert.ok(out.includes('href="/tarefas"'));
    assert.ok(out.includes('data-action="refresh-brevo"'));
  });
});

describe("assinantes.html enxuto (#10606)", () => {
  it("bloco de ação vem antes de tudo e 'Detalhes' vem recolhido", () => {
    const acoes = html.indexOf('id="acoes-panel"');
    const busca = html.indexOf('id="search-form"');
    const detalhes = html.indexOf('id="detalhes"');
    assert.ok(acoes > 0 && acoes < busca && busca < detalhes, "ordem: ação, busca, detalhes");
    const detailsTags = html.match(/<details\b[^>]*>/g) ?? [];
    assert.ok(detailsTags.length >= 2);
    for (const tag of detailsTags) assert.ok(!/\bopen\b/.test(tag), `details aberto por padrão: ${tag}`);
  });

  it("contagens sem ação ficam dentro de 'Detalhes'", () => {
    const detalhes = html.indexOf('id="detalhes"');
    for (const id of ["onboarding-steps-table", "onboarding-people-table", "onboarding-kit-lots-table", "cohort-by-platform", "cohort-origem-table", "attribute-coverage-table"]) {
      const pos = html.indexOf(`id="${id}"`);
      assert.ok(pos > detalhes, `${id} deveria estar dentro de Detalhes`);
    }
  });

  it("blocos redundantes removidos não voltam", () => {
    for (const id of ["onboarding-stage-counts", "onboarding-provider-counts", "onboarding-alerts", "onboarding-refresh-errors", "onboarding-corrupted"]) {
      assert.ok(!html.includes(`id="${id}"`), `${id} voltou ao HTML`);
    }
  });

  it("código morto `refreshWarning` removido (campo não existe no payload)", () => {
    assert.ok(!js.includes("refreshWarning"));
  });

  it("todo id que assinantes.js procura existe no HTML", () => {
    const ids = [...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(ids.length > 20);
    for (const id of ids) assert.ok(html.includes(`id="${id}"`), `assinantes.js procura #${id}, ausente do HTML`);
  });
});
