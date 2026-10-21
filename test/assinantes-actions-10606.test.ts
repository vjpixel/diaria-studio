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
 *    cada sinal acionável vira item com ação; sinal sem ação não vira item;
 *    dedupe de lote Kit falho; roteamento por `PanelAlert.kind`.
 * 2. Contrato: a visão do produtor REAL (`buildFollowupPanel`) alimenta o
 *    bloco de ação (fixtures tipadas contra `FunnelPayload`/`FollowupPanelView`).
 * 3. `panelState`: "nada pedindo ação" nunca aparece com rascunho parado,
 *    store corrompido, sem store ou falha de carga/refresh.
 * 4. Estrutura do HTML: bloco de ação no topo, "Detalhes" recolhido, blocos
 *    removidos não voltam, todo id que o JS procura existe no HTML.
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
  stageBreakdownRows,
  panelState,
  alertAction,
  BLOCK_ACTIONS,
  EMAIL3_STAGE_LABELS,
  type FunnelPayload,
} from "../scripts/studio-ui/public/assinantes-actions.js";
import {
  buildFollowupPanel,
  STEP_LABELS,
  type EmailStepCount,
  type FollowupPanelView,
  type OnboardingEmailStep,
  type PanelAlert,
} from "../scripts/lib/onboarding-followup-panel.ts";
import type { OnboardingEmail3Stage, OnboardingFunnelSummary } from "../scripts/lib/onboarding-funnel-report.ts";
import type { FollowupBlockReason } from "../scripts/lib/onboarding-followup.ts";
import type { KitSendRunRecord, OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";
import type { OnboardingFunnelDbLayer } from "../scripts/studio-ui/studio-onboarding.ts";
import { emptyStore, type OnboardingEntry } from "../scripts/lib/onboarding-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = resolve(ROOT, "scripts", "studio-ui", "public");
const html = readFileSync(resolve(PUBLIC, "assinantes.html"), "utf8");
const js = readFileSync(resolve(PUBLIC, "assinantes.js"), "utf8");

// ─── fixtures tipadas contra os produtores reais ─────────────────────────

function db(over: Partial<OnboardingFunnelDbLayer> = {}): OnboardingFunnelDbLayer {
  return { storePath: "data/onboarding/store.json", hasDataDir: true, available: true, corrupted: false, ...over };
}

function step(key: OnboardingEmailStep, falhos = 0): EmailStepCount {
  return { step: key, label: STEP_LABELS[key], recebidos: 3, porTransporte: { kit: 2, brevo: 1 }, pulados: {}, pendentes: {}, falhos, daUltimaRodada: false };
}

function stages(over: Partial<Record<OnboardingEmail3Stage, number>> = {}): Record<OnboardingEmail3Stage, number> {
  const zero = Object.fromEntries(Object.keys(EMAIL3_STAGE_LABELS).map((k) => [k, 0])) as Record<OnboardingEmail3Stage, number>;
  return { ...zero, ...over };
}

function followup(over: Partial<FollowupPanelView> = {}): FollowupPanelView {
  return {
    steps: [step("email1"), step("email2"), step("email3")],
    people: [],
    alerts: [],
    blocked: { apoio: null, form: null },
    lastRunAt: "2026-10-20T12:00:00.000Z",
    ...over,
  };
}

function run(over: Partial<KitSendRunRecord> = {}): KitSendRunRecord {
  return {
    at: "2026-10-20T12:00:00Z",
    lots_created: 1,
    lots_failed: 0,
    lots_unverified: 0,
    blocked_concurrent: 0,
    refresh_candidates: 5,
    refresh_failed: 0,
    content_skipped: 0,
    ...over,
  };
}

type StaleDraft = OnboardingFunnelSummary["staleDrafts"][number];
function stale(over: Partial<StaleDraft> = {}): StaleDraft {
  return {
    subscriptionId: "s1",
    email: "a***@x.com",
    provider: "brevo",
    stage: "rascunho_criado",
    ageDays: 4,
    campaignOrBroadcastId: 77,
    nextAction: "rascunho parado há 4 dia(s) — agendar ou cancelar a campanha 77",
    ...over,
  };
}

function funnel(over: Partial<FunnelPayload> = {}): FunnelPayload {
  return { db: db(), summary: { byEmail3Stage: stages(), staleDrafts: [] }, refreshErrors: [], followup: followup(), ...over };
}

const ids = (p: FunnelPayload) => buildActionItems(p).map((i) => i.id);

// ─── buildActionItems ─────────────────────────────────────────────────────

describe("buildActionItems (#10606)", () => {
  it("tudo em dia: nenhuma ação", () => {
    assert.deepEqual(buildActionItems(funnel()), []);
  });

  it("sem store: nenhuma ação (o aviso de 'sem dados' é outro elemento)", () => {
    assert.deepEqual(buildActionItems(funnel({ db: db({ available: false }) })), []);
  });

  it("db disponível com followup null e summary ausente: não quebra", () => {
    assert.deepEqual(buildActionItems({ db: db(), followup: null }), []);
  });

  it("store corrompido: 1 item com o que fazer, e só ele (contagens não valem)", () => {
    const items = buildActionItems(funnel({ db: db({ available: false, corrupted: true }), refreshWarning: "x" }));
    assert.deepEqual(items.map((i) => i.id), ["store-corrompido"]);
    assert.match(items[0].acao, /corrigir o JSON/);
  });

  it("alertas roteados por `kind`, nunca pelo texto de `etapa`", () => {
    const a = (kind: PanelAlert["kind"]): PanelAlert => ({ kind, etapa: "rótulo qualquer", mensagem: "2 rodadas seguidas com falha" });
    const items = buildActionItems(
      funnel({ followup: followup({ alerts: [a("kit_streak"), a("email3_brevo_streak"), a("followup_streak"), { ...a("lot_schedule_failed"), mensagem: "lote ap-1: x" }] }) }),
      // lote sem `step` (kind fora de STEP_LABELS): não absorve nenhuma sequência,
      // então as 4 rotas aparecem; a absorção tem teste próprio abaixo.
    );
    assert.equal(items.length, 4);
    assert.match(items[0].acao, /onboarding-kit-transport-run\.ts/);
    assert.match(items[1].acao, /onboarding-welcome-run\.ts/);
    assert.match(items[2].acao, /onboarding-followup-run\.ts/);
    assert.match(items[3].acao, /painel do Kit/);
    for (const it of items.slice(0, 3)) assert.equal(it.link?.href, "/tarefas");
  });

  it("excedente do teto fora da janela (#10652) vira ação de config, já na 1ª rodada", () => {
    const items = buildActionItems(
      funnel({ followup: followup({ alerts: [{ kind: "cap_window_overflow", etapa: "Sequências de apoio/formulário", mensagem: "excedente do teto" }] }) }),
    );
    assert.equal(items.length, 1);
    assert.match(items[0].acao, /max_recipients_per_lot ou grace_days/);
  });

  it("sequência travada por texto pendente: ação de aprovar o texto, link pra Caixas", () => {
    const items = buildActionItems(funnel({ followup: followup({ blocked: { apoio: { motivo: "texto_pendente", detalhe: "PENDENTE" }, form: null } }) }));
    assert.deepEqual(items.map((i) => i.titulo), ["Apoio D+30/90/180/360 travado"]);
    assert.equal(items[0].link?.href, "/caixas");
  });

  it("sequência `desligado` não vira ação (escolha de config, só em Detalhes)", () => {
    const off = { motivo: "desligado" as const, detalhe: "kill switch" };
    assert.deepEqual(buildActionItems(funnel({ followup: followup({ blocked: { apoio: off, form: off } }) })), []);
  });

  it("motivo de trava sem ação mapeada NÃO some do topo: vira item genérico", () => {
    const blocked = { apoio: null, form: { motivo: "motivo_novo" as unknown as FollowupBlockReason, detalhe: "algo travou" } };
    const items = buildActionItems(funnel({ followup: followup({ blocked }) }));
    assert.deepEqual(items.map((i) => i.id), ["travado-form"]);
    assert.match(items[0].acao, /Investigar por que a sequência travou \(motivo "motivo_novo"\)/);
    assert.equal(items[0].link?.href, "/tarefas");
  });

  it("todo motivo de trava do executor, exceto `desligado`, tem ação mapeada", () => {
    // Exaustivo por tipo: um motivo novo em FollowupBlockReason quebra o typecheck aqui.
    const all: Record<FollowupBlockReason, true> = {
      snippet_ausente: true,
      texto_pendente: true,
      snippet_invalido: true,
      form_nao_configurado: true,
      respostas_indisponiveis: true,
      kit_indisponivel: true,
      desligado: true,
    };
    for (const m of Object.keys(all) as FollowupBlockReason[]) {
      if (m === "desligado") continue;
      assert.ok(BLOCK_ACTIONS[m]?.acao, `motivo ${m} sem ação`);
    }
    assert.match(BLOCK_ACTIONS.form_nao_configurado.acao, /form_url e form_responses_url/);
    assert.ok(Object.isFrozen(BLOCK_ACTIONS) && Object.isFrozen(BLOCK_ACTIONS.snippet_ausente.link));
  });

  it("etapa com envios falhos vira ação; etapa sem falha não", () => {
    const items = buildActionItems(funnel({ followup: followup({ steps: [step("email1"), step("apoio30", 4)] }) }));
    assert.deepEqual(items.map((i) => i.id), ["falhos-apoio30"]);
    assert.match(items[0].titulo, /^Apoio D\+30: 4 envio\(s\) falho\(s\)$/);
  });

  it("lote Kit da escada falhando: 1 item por etapa, com a sequência citada dentro", () => {
    const alerts: PanelAlert[] = [{ kind: "kit_streak", etapa: "E-mails 1/2/3 (transporte Kit)", mensagem: "3 rodadas --send seguidas com falha" }];
    const items = buildActionItems(funnel({ followup: followup({ alerts, steps: [step("email1", 5), step("email2")] }) }));
    assert.deepEqual(items.map((i) => i.id), ["falhos-email1"]);
    assert.match(items[0].detalhe, /3 rodadas --send seguidas com falha/);
  });

  it("alerta de rodadas seguidas sem etapa falha continua sozinho no topo", () => {
    const alerts: PanelAlert[] = [{ kind: "kit_streak", etapa: "x", mensagem: "2 rodadas --send seguidas com falha" }];
    assert.deepEqual(ids(funnel({ followup: followup({ alerts }) })), ["alerta-0"]);
  });

  it("lote não agendado é o mais específico: absorve envios falhos e a sequência da mesma etapa (join por `step`)", () => {
    const alerts: PanelAlert[] = [
      { kind: "followup_streak", etapa: "Sequências de apoio/formulário", mensagem: "2 rodadas seguidas com falha" },
      { kind: "lot_schedule_failed", step: "apoio30", etapa: "rótulo que não bate com o da etapa", mensagem: "lote ap-1: broadcast não agendado (Kit 422)" },
    ];
    const items = buildActionItems(funnel({ followup: followup({ alerts, steps: [step("apoio30", 4)] }) }));
    assert.equal(items.length, 1, JSON.stringify(items.map((i) => i.id)));
    assert.match(items[0].acao, /painel do Kit/);
    assert.match(items[0].detalhe, /4 envio\(s\) falho\(s\) nesta etapa/);
    assert.match(items[0].detalhe, /2 rodadas seguidas com falha/);
  });

  it("dois lotes não agendados na mesma etapa: 2 itens, envios falhos citados só uma vez", () => {
    const alerts: PanelAlert[] = [
      { kind: "lot_schedule_failed", step: "apoio30", etapa: STEP_LABELS.apoio30, mensagem: "lote ap-1: x" },
      { kind: "lot_schedule_failed", step: "apoio30", etapa: STEP_LABELS.apoio30, mensagem: "lote ap-2: y" },
    ];
    const items = buildActionItems(funnel({ followup: followup({ alerts, steps: [step("apoio30", 4)] }) }));
    assert.deepEqual(items.map((i) => i.id), ["alerta-0", "alerta-1"]);
    assert.equal(items.filter((i) => /envio\(s\) falho\(s\)/.test(i.detalhe)).length, 1);
  });

  it("lote não agendado em etapa SEM falhos: a sequência citada nele não vira item próprio", () => {
    const alerts: PanelAlert[] = [
      { kind: "followup_streak", etapa: "Sequências de apoio/formulário", mensagem: "2 rodadas seguidas com falha" },
      { kind: "lot_schedule_failed", step: "apoio30", etapa: STEP_LABELS.apoio30, mensagem: "lote ap-1: x" },
    ];
    const items = buildActionItems(funnel({ followup: followup({ alerts, steps: [step("apoio30", 0)] }) }));
    assert.deepEqual(items.map((i) => i.id), ["alerta-1"]);
    assert.match(items[0].detalhe, /2 rodadas seguidas com falha/);
  });

  it("rodada Kit só com lote sem confirmação na releitura (lots_unverified) aparece no topo", () => {
    const items = buildActionItems(funnel({ kitLots: { lastSendRun: run({ lots_unverified: 2 }), consecutiveFailedSendRuns: 1 } }));
    assert.deepEqual(items.map((i) => i.id), ["kit-rodada"]);
    assert.match(items[0].detalhe, /2 lote\(s\) sem confirmação/);
  });

  it("alerta do e-mail 3 via Brevo nunca é absorvido por falha de lote Kit", () => {
    const alerts: PanelAlert[] = [{ kind: "email3_brevo_streak", etapa: "E-mail 3 (Brevo)", mensagem: "2 rodadas seguidas com falha" }];
    assert.deepEqual(ids(funnel({ followup: followup({ alerts, steps: [step("email3", 2)] }) })), ["alerta-0", "falhos-email3"]);
  });

  it("rodada Kit abortada com 1 falha seguida (abaixo do limiar do alerta) aparece no topo", () => {
    const items = buildActionItems(funnel({ kitLots: { lastSendRun: run({ aborted: true, error: "Kit 500" }), consecutiveFailedSendRuns: 1 } }));
    assert.deepEqual(items.map((i) => i.id), ["kit-rodada"]);
    assert.match(items[0].detalhe, /rodada abortada \(Kit 500\)/);
    assert.match(items[0].detalhe, /1 rodada\(s\) seguida\(s\) com falha/);
  });

  it("rodada Kit: refresh falho, rascunho órfão e lote falho sem 'falhos' contado viram 1 item; streak absorvida", () => {
    const alerts: PanelAlert[] = [{ kind: "kit_streak", etapa: "x", mensagem: "2 rodadas --send seguidas com falha" }];
    const items = buildActionItems(
      funnel({
        followup: followup({ alerts }),
        kitLots: { lastSendRun: run({ refresh_failed: 2, lots_orphan_draft: 1, lots_failed: 1 }), consecutiveFailedSendRuns: 2 },
      }),
    );
    assert.deepEqual(items.map((i) => i.id), ["kit-rodada"]);
    assert.match(items[0].detalhe, /refresh falhou em 2 de 5/);
    assert.match(items[0].detalhe, /rascunho\(s\) órfão\(s\)/);
    assert.match(items[0].detalhe, /1 lote\(s\) com falha/);
    assert.match(items[0].detalhe, /2 rodadas --send seguidas/);
    assert.match(items[0].acao, /apagar o rascunho órfão/);
  });

  it("rodada Kit: lote falho já contado como 'falhos' na escada não duplica", () => {
    const items = buildActionItems(funnel({ followup: followup({ steps: [step("email1", 3)] }), kitLots: { lastSendRun: run({ lots_failed: 1 }), consecutiveFailedSendRuns: 1 } }));
    assert.deepEqual(items.map((i) => i.id), ["falhos-email1"]);
  });

  it("rodada Kit com envio barrado por texto: ação Abrir Caixas", () => {
    const items = buildActionItems(funnel({ kitLots: { lastSendRun: run({ content_skipped: 2 }), consecutiveFailedSendRuns: 0 } }));
    assert.deepEqual(items.map((i) => i.id), ["kit-conteudo"]);
    assert.equal(items[0].link?.href, "/caixas");
  });

  it("refreshWarning (sem BREVO_DIARIA_API_KEY) vira item no topo", () => {
    const items = buildActionItems(funnel({ refreshWarning: "BREVO_DIARIA_API_KEY ausente nesta sessão" }));
    assert.deepEqual(items.map((i) => i.id), ["brevo-chave"]);
    assert.match(items[0].acao, /Configurar BREVO_DIARIA_API_KEY nesta sessão/);
  });

  it("apoiadorDataError vira item 'Conferir o export de apoiadores'", () => {
    const items = buildActionItems(funnel({ apoiadorDataError: "contacts.jsonl ausente" }));
    assert.deepEqual(items.map((i) => i.id), ["apoiadores"]);
    assert.equal(items[0].acao, "Conferir o export de apoiadores");
  });

  it("falha de consulta à Brevo: 1 item com botão, juntando contagem e erros do refresh", () => {
    const items = buildActionItems(funnel({ refreshErrors: [{ campaignId: 77, message: "HTTP 500" }], summary: { byEmail3Stage: stages({ falha_consulta: 2 }), staleDrafts: [] } }));
    assert.deepEqual(items.map((i) => i.id), ["brevo-consulta"]);
    assert.equal(items[0].button, "refresh-brevo");
    assert.match(items[0].detalhe, /2 convite\(s\) sem estado confirmado/);
    assert.match(items[0].detalhe, /campanha 77 \(HTTP 500\)/);
  });

  it("estado ambíguo na Brevo vira ação de investigar a campanha", () => {
    assert.deepEqual(ids(funnel({ summary: { byEmail3Stage: stages({ estado_ambiguo: 1 }), staleDrafts: [] } })), ["brevo-ambiguo"]);
  });
});

// ─── contrato com o produtor real ─────────────────────────────────────────

describe("contrato: visão do buildFollowupPanel real alimenta o bloco de ação (#10606)", () => {
  function entry(over: Partial<OnboardingEntry>): OnboardingEntry {
    return {
      subscription_id: "1", email: "a@x.com", status_detectado: "active", created_at: 1_760_000_000,
      detected_at: "2025-10-09T00:00:00Z", email1_sent_at: null, email1_brevo_id: null, email2_sent_at: null, email2_brevo_id: null,
      email3_state: "pending", email3_campaign_id: null, email3_decided_at: null, ...over,
    };
  }
  function kitLot(over: Partial<OnboardingKitLot>): OnboardingKitLot {
    return {
      lot_id: "email1-2026-10-01-01", kind: "email1", tag_name: "onboarding-email1-2026-10-01-01", tag_id: 1, broadcast_id: 10,
      recipient_subscription_ids: ["1"], recipient_emails: ["a@x.com"], status: "created", created_at: "2026-10-01T12:00:00Z",
      send_at: null, last_reconciled_at: null, last_error: "Kit 422", ...over,
    };
  }

  it("lote falho + schedule_failed + streak Kit: 1 item (o do lote), roteado pelo kind do produtor", () => {
    const store = emptyStore();
    store.entries = { "1": entry({}) };
    store.kit_transport = { lots: { l1: kitLot({ schedule_failed: true }) }, consecutive_failed_send_runs: 3 };
    const view = buildFollowupPanel(store);
    assert.ok(view.alerts.some((a) => a.kind === "lot_schedule_failed" && a.step === "email1"));
    assert.ok(view.alerts.some((a) => a.kind === "kit_streak"));
    assert.equal(view.steps.find((s) => s.step === "email1")?.falhos, 1);

    const items = buildActionItems(funnel({ followup: view }));
    assert.equal(items.length, 1, JSON.stringify(items.map((i) => [i.id, i.titulo])));
    assert.equal(items[0].titulo, STEP_LABELS.email1);
    assert.match(items[0].acao, /painel do Kit/);
    assert.match(items[0].detalhe, /1 envio\(s\) falho\(s\) nesta etapa/);
    assert.match(items[0].detalhe, /3 rodadas --send seguidas com falha/);
  });

  it("trava real do produtor (texto pendente do formulário) chega ao topo", () => {
    const store = emptyStore();
    store.followup = {
      people: {},
      lots: {},
      last_run: {
        at: "2026-10-20T12:10:00Z", apoio_blocked: null, form_blocked: { motivo: "texto_pendente", detalhe: "formulario-lembrete.md pendente" },
        lots_created: 0, lots_failed: 0, over_cap: 0, lookups_failed: 0, counts: {},
      },
      consecutive_failed_runs: 0,
    };
    assert.deepEqual(ids(funnel({ followup: buildFollowupPanel(store) })), ["travado-form"]);
  });
});

// ─── panelState / staleDraftRows / stageBreakdownRows / HTML ─────────────

describe("panelState (#10606)", () => {
  it("tudo em dia: mostra 'nada pedindo ação'", () => {
    const s = panelState({ data: funnel() });
    assert.equal(s.emptyHidden, false);
    assert.equal(s.nodataHidden, true);
    assert.equal(s.loadErrorText, null);
  });

  it("rascunho parado acionável esconde 'nada pedindo ação' mesmo sem itens", () => {
    const s = panelState({ data: funnel({ summary: { byEmail3Stage: stages(), staleDrafts: [stale()] } }) });
    assert.equal(s.items.length, 0);
    assert.equal(s.staleRows.length, 1);
    assert.equal(s.emptyHidden, true);
  });

  it("rascunho parado com ação 'nenhuma…' não conta como pendência", () => {
    const s = panelState({ data: funnel({ summary: { byEmail3Stage: stages(), staleDrafts: [stale({ nextAction: "nenhuma — agendado no Kit, aguardando disparo" })] } }) });
    assert.equal(s.staleRows.length, 0);
    assert.equal(s.emptyHidden, false);
  });

  it("store corrompido: sem 'nada pedindo ação' e sem 'sem dados'", () => {
    const s = panelState({ data: funnel({ db: db({ available: false, corrupted: true }) }) });
    assert.equal(s.emptyHidden, true);
    assert.equal(s.nodataHidden, true);
    assert.deepEqual(s.items.map((i) => i.id), ["store-corrompido"]);
  });

  it("sem store: mostra 'sem dados', nunca 'nada pedindo ação'", () => {
    const s = panelState({ data: funnel({ db: db({ available: false }) }) });
    assert.equal(s.nodataHidden, false);
    assert.equal(s.emptyHidden, true);
  });

  it("falha de carga: erro no topo, lista vazia, sem 'nada pedindo ação'", () => {
    const s = panelState({ loadError: "HTTP 500" });
    assert.match(s.loadErrorText ?? "", /Falha ao carregar o onboarding: HTTP 500/);
    assert.equal(s.emptyHidden, true);
    assert.deepEqual(s.items, []);
  });

  it("falha de refresh: mantém a lista anterior, mostra o erro e esconde 'nada pedindo ação'", () => {
    const s = panelState({ data: funnel({ refreshErrors: [] }), refreshError: "HTTP 503" });
    assert.match(s.loadErrorText ?? "", /Falha ao reconsultar a Brevo: HTTP 503/);
    assert.equal(s.emptyHidden, true);
    const prev = panelState({ data: funnel({ summary: { byEmail3Stage: stages({ estado_ambiguo: 1 }), staleDrafts: [] } }), refreshError: "x" });
    assert.deepEqual(prev.items.map((i) => i.id), ["brevo-ambiguo"]);
  });

  it("falha de refresh antes de qualquer carga boa: texto de refresh, não de carga", () => {
    assert.match(panelState({ data: null, refreshError: "x" }).loadErrorText ?? "", /reconsultar a Brevo/);
  });
});

describe("staleDraftRows / stageBreakdownRows / alertAction / actionItemsHtml (#10606)", () => {
  it("rascunho parado carrega a ação do relatório, com '—' no que falta", () => {
    const rows = staleDraftRows([stale({ provider: null, ageDays: null, campaignOrBroadcastId: null, nextAction: "revisar broadcast" })]);
    assert.deepEqual(rows, [{ email: "a***@x.com", provider: "—", idade: "—", campanha: "—", acao: "revisar broadcast" }]);
    assert.deepEqual(staleDraftRows(undefined), []);
  });

  it("detalhamento por estágio só lista estágios > 0 (ex.: aguardando dados, sem dados)", () => {
    const rows = stageBreakdownRows(stages({ aguardando_dados: 7, skipped_sem_dados: 2 }));
    assert.deepEqual(rows.map((r) => [r.key, r.count]), [["aguardando_dados", 7], ["skipped_sem_dados", 2]]);
    assert.deepEqual(stageBreakdownRows(null), []);
  });

  it("alertAction com kind desconhecido cai numa ação genérica, nunca lança", () => {
    assert.match(alertAction({ kind: "novo" as unknown as PanelAlert["kind"] }).acao, /Investigar o alerta/);
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

  it("contagens sem ação ficam dentro de 'Detalhes', com um 2º ponto de 'Reconsultar a Brevo'", () => {
    const detalhes = html.indexOf('id="detalhes"');
    for (const id of [
      "onboarding-steps-table",
      "onboarding-stage-table",
      "refresh-onboarding-details-btn",
      "onboarding-people-table",
      "onboarding-kit-lots-table",
      "cohort-by-platform",
      "cohort-origem-table",
      "attribute-coverage-table",
    ]) {
      const pos = html.indexOf(`id="${id}"`);
      assert.ok(pos > detalhes, `${id} deveria estar dentro de Detalhes`);
    }
  });

  it("blocos redundantes removidos não voltam", () => {
    for (const id of ["onboarding-stage-counts", "onboarding-provider-counts", "onboarding-alerts", "onboarding-refresh-errors", "onboarding-corrupted", "onboarding-apoiador-error"]) {
      assert.ok(!html.includes(`id="${id}"`), `${id} voltou ao HTML`);
    }
  });

  it("todo id que assinantes.js procura existe no HTML", () => {
    const found = [...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(found.length > 20);
    for (const id of found) assert.ok(html.includes(`id="${id}"`), `assinantes.js procura #${id}, ausente do HTML`);
  });
});
