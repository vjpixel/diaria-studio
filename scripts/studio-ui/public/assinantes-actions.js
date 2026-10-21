// assinantes-actions.js (#10606) — lógica PURA do bloco "o que pede ação" do
// painel /assinantes. Revisão do editor (20/10/2026): "a página está com
// informações demais. muitas delas, não sei qual ação eu faria com a
// informação." Daí a regra do TOPO da página: o que aparece ali tem uma ação
// concreta ao lado; contexto sem ação vai pro <details> "Detalhes".
//
// Sem `document`/`fetch` aqui, de propósito: testável com fixtures puras em
// test/assinantes-actions-10606.test.ts (mesmo padrão de rodada-round-age.js).
// Entrada = o JSON de GET /api/onboarding/funnel (`OnboardingFunnelData`,
// studio-onboarding.ts) ou do POST de refresh, que acrescenta
// `refreshErrors`/`refreshWarning`. Tipos em assinantes-actions.d.ts.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TAREFAS_LINK = Object.freeze({ href: "/tarefas", label: "Ver log em Tarefas" });
const CAIXAS_LINK = Object.freeze({ href: "/caixas", label: "Abrir Caixas" });

/** Ação por motivo de trava das sequências de apoio/formulário
 *  (`FollowupBlockReason` de scripts/lib/onboarding-followup.ts). `desligado`
 *  fica de fora de propósito: é escolha de configuração, não falha — aparece
 *  só em "Detalhes". Motivo que não esteja aqui cai num item genérico (ver
 *  `buildActionItems`), nunca some do topo. */
export const BLOCK_ACTIONS = Object.freeze({
  snippet_ausente: Object.freeze({ acao: "Escrever o texto do e-mail", link: CAIXAS_LINK }),
  texto_pendente: Object.freeze({ acao: "Revisar e aprovar o texto do e-mail", link: CAIXAS_LINK }),
  snippet_invalido: Object.freeze({ acao: "Corrigir o cabeçalho ou o corpo do texto do e-mail", link: CAIXAS_LINK }),
  form_nao_configurado: Object.freeze({
    acao: "Publicar o Worker do formulário e preencher onboarding.followup.form_url e form_responses_url (#10605)",
    link: null,
  }),
  respostas_indisponiveis: Object.freeze({ acao: "Conferir o Worker do formulário: as respostas não carregaram", link: null }),
  kit_indisponivel: Object.freeze({ acao: "Investigar o acesso ao Kit na última rodada", link: TAREFAS_LINK }),
});

const SEQUENCIA_LABEL = { apoio: "Apoio D+30/90/180/360", form: "Formulário" };
const LADDER_STEPS = new Set(["email1", "email2", "email3"]);

/** Rótulos dos estágios do e-mail 3 (`OnboardingEmail3Stage`), usados no
 *  detalhamento por estágio em "Detalhes". */
export const EMAIL3_STAGE_LABELS = Object.freeze({
  aguardando_confirmacao: "Aguardando confirmação",
  not_due: "D+10 não venceu",
  aguardando_dados: "Aguardando dados de abertura",
  rascunho_criado: "Rascunho criado",
  agendado: "Agendado",
  enviado: "Enviado",
  cancelado: "Cancelado",
  skipped_no_open: "Sem abertura (terminal)",
  skipped_inactive: "Inativo na decisão",
  skipped_sem_dados: "Sem dados (terminal)",
  skipped_backlog_descartado: "Backlog descartado (terminal)",
  falha_consulta: "Falha de consulta",
  estado_ambiguo: "Estado ambíguo (Brevo)",
});

/**
 * Ação de um alerta (`PanelAlert` de scripts/lib/onboarding-followup-panel.ts),
 * roteada pelo discriminante `kind` — nunca pelo texto de `etapa`, que é
 * rótulo de exibição e pode mudar.
 */
export function alertAction(alert) {
  switch (alert.kind) {
    case "lot_schedule_failed":
      return { acao: "Agendar ou apagar esse broadcast no painel do Kit", link: null };
    case "kit_streak":
      return { acao: "Investigar falha de envio: rodar npx tsx scripts/onboarding-kit-transport-run.ts (dry-run) e ler o erro", link: TAREFAS_LINK };
    case "email3_brevo_streak":
      return { acao: "Investigar falha de envio: rodar npx tsx scripts/onboarding-welcome-run.ts (dry-run) e ler o erro", link: TAREFAS_LINK };
    case "followup_streak":
      return { acao: "Investigar falha de envio: rodar npx tsx scripts/onboarding-followup-run.ts (dry-run) e ler o erro", link: TAREFAS_LINK };
    case "cap_window_overflow":
      return { acao: "Subir onboarding.followup.max_recipients_per_lot ou grace_days em platform.config.json (#10652)", link: null };
    default:
      return { acao: "Investigar o alerta: ler o erro da última rodada do executor", link: TAREFAS_LINK };
  }
}

/** O alerta de rodadas seguidas cobre a etapa? `kit_streak` cobre os e-mails
 *  1/2/3; `followup_streak`, apoio e formulário. `email3_brevo_streak` não é
 *  lote Kit e nunca é absorvido. */
export function streakCovers(alert, stepKey) {
  if (alert.kind === "kit_streak") return LADDER_STEPS.has(stepKey);
  if (alert.kind === "followup_streak") return !LADDER_STEPS.has(stepKey);
  return false;
}

function item(id, titulo, detalhe, acao, link = null, button = null) {
  return { id, titulo, detalhe, acao, link, button };
}

/**
 * Lista do que pede ação agora. Cada item: `{ id, titulo, detalhe, acao,
 * link, button }` — `link` é `{ href, label }` ou null; `button` é
 * "refresh-brevo" quando a ação é reconsultar a Brevo pelo próprio painel.
 *
 * Dedupe de lote Kit falho (fleet review da PR #10651): um lote que falha
 * pode gerar o item de envios falhos da etapa, o alerta de lote não agendado
 * e o alerta de rodadas seguidas. Fica um item por etapa, o mais específico,
 * com os outros sinais citados dentro:
 *   lote não agendado (nomeia o lote) > envios falhos da etapa
 *   > última rodada do executor Kit com falha > alerta de rodadas seguidas.
 */
export function buildActionItems(data) {
  const items = [];
  if (!data || !data.db) return items;

  if (data.db.corrupted) {
    items.push(
      item(
        "store-corrompido",
        "Store do onboarding ilegível",
        "data/onboarding/store.json existe mas o JSON está corrompido. As contagens desta página não valem até isso ser resolvido.",
        "Abrir o arquivo e corrigir o JSON (ou restaurar a versão anterior do OneDrive)",
      ),
    );
    return items;
  }
  if (!data.db.available) return items;

  // POST de refresh sem BREVO_DIARIA_API_KEY: o snapshot é local, o botão
  // "Reconsultar a Brevo" não faz nada até a chave existir.
  if (data.refreshWarning) {
    items.push(item("brevo-chave", "Reconsulta à Brevo indisponível", data.refreshWarning, "Configurar BREVO_DIARIA_API_KEY nesta sessão do Studio e reconsultar"));
  }

  const followup = data.followup ?? null;
  const alerts = followup?.alerts ?? [];
  const failingSteps = (followup?.steps ?? []).filter((s) => s.falhos > 0);
  const lotAlertSteps = new Set(alerts.filter((a) => a.kind === "lot_schedule_failed" && a.step).map((a) => a.step));
  const streakFor = (stepKey) => alerts.find((a) => streakCovers(a, stepKey));
  const absorbed = new Set();
  for (const s of failingSteps) {
    const st = streakFor(s.step);
    if (st) absorbed.add(st);
  }

  // Última rodada --send do executor Kit: abortada, refresh falho, rascunho
  // órfão ou lote falho que nenhuma etapa contou como "falhos".
  const run = data.kitLots?.lastSendRun ?? null;
  const ladderFailing = failingSteps.some((s) => LADDER_STEPS.has(s.step)) || [...lotAlertSteps].some((k) => LADDER_STEPS.has(k));
  if (run) {
    const problemas = [];
    if (run.aborted === true) problemas.push(`rodada abortada (${run.error ?? "sem motivo registrado"})`);
    if ((run.refresh_failed ?? 0) > 0) problemas.push(`refresh falhou em ${run.refresh_failed} de ${run.refresh_candidates ?? "?"} candidato(s)`);
    if ((run.lots_orphan_draft ?? 0) > 0) problemas.push(`${run.lots_orphan_draft} rascunho(s) órfão(s) no Kit (enviar pela UI mandaria o e-mail em dobro)`);
    if ((run.lots_unverified ?? 0) > 0) problemas.push(`${run.lots_unverified} lote(s) sem confirmação na releitura do Kit`);
    if ((run.lots_failed ?? 0) > 0 && !ladderFailing) problemas.push(`${run.lots_failed} lote(s) com falha`);
    if (problemas.length > 0) {
      const streak = alerts.find((a) => a.kind === "kit_streak" && !absorbed.has(a));
      if (streak) absorbed.add(streak);
      const n = data.kitLots?.consecutiveFailedSendRuns ?? 0;
      const sufixo = streak ? ` ${streak.mensagem}.` : n > 0 ? ` ${n} rodada(s) seguida(s) com falha.` : "";
      items.push(
        item(
          "kit-rodada",
          "Última rodada do executor Kit com falha",
          `${run.at}: ${problemas.join("; ")}.${sufixo}`,
          alertAction({ kind: "kit_streak" }).acao + ((run.lots_orphan_draft ?? 0) > 0 ? "; apagar o rascunho órfão no painel do Kit" : ""),
          TAREFAS_LINK,
        ),
      );
    }
    if ((run.content_skipped ?? 0) > 0) {
      items.push(
        item(
          "kit-conteudo",
          `${run.content_skipped} envio(s) do Kit barrado(s) por texto`,
          "O texto do e-mail está ausente, pendente de aprovação ou inválido em data/snippets/.",
          "Escrever ou aprovar o texto do e-mail",
          CAIXAS_LINK,
        ),
      );
    }
  }

  // A sequência citada dentro de um item de lote não agendado não vira item
  // próprio também (achado da verificação do fleet, PR #10651): marcar antes
  // do laço, porque os alertas de sequência vêm antes dos de lote no array.
  for (const alert of alerts) {
    if (alert.kind !== "lot_schedule_failed" || !alert.step) continue;
    const streak = streakFor(alert.step);
    if (streak) absorbed.add(streak);
  }

  const falhosCitados = new Set();
  for (const [i, alert] of alerts.entries()) {
    if (absorbed.has(alert)) continue;
    const a = alertAction(alert);
    let detalhe = alert.mensagem;
    if (alert.kind === "lot_schedule_failed" && alert.step && !falhosCitados.has(alert.step)) {
      falhosCitados.add(alert.step);
      const step = failingSteps.find((s) => s.step === alert.step);
      const streak = streakFor(alert.step);
      if (step) detalhe += `. ${step.falhos} envio(s) falho(s) nesta etapa`;
      if (streak) detalhe += `. ${streak.mensagem}`;
    }
    items.push(item(`alerta-${i}`, alert.etapa, detalhe, a.acao, a.link));
  }

  for (const key of ["apoio", "form"]) {
    const b = followup?.blocked?.[key];
    if (!b || b.motivo === "desligado") continue; // escolha de config: só em Detalhes
    // Motivo sem ação mapeada (ex.: motivo novo no executor) NUNCA some do
    // topo: trava real escondida é a classe de falha do #10603.
    const a = BLOCK_ACTIONS[b.motivo] ?? { acao: `Investigar por que a sequência travou (motivo "${b.motivo}")`, link: TAREFAS_LINK };
    items.push(item(`travado-${key}`, `${SEQUENCIA_LABEL[key]} travado`, b.detalhe, a.acao, a.link));
  }

  for (const step of failingSteps) {
    if (lotAlertSteps.has(step.step)) continue; // já citado no item do lote
    const streak = streakFor(step.step);
    items.push(
      item(
        `falhos-${step.step}`,
        `${step.label}: ${step.falhos} envio(s) falho(s)`,
        "Destinatários de lote que falhou e ainda não têm envio registrado." + (streak ? ` ${streak.etapa}: ${streak.mensagem}.` : ""),
        "Investigar falha de envio: ler o erro da última rodada do executor",
        TAREFAS_LINK,
      ),
    );
  }

  // Refresh só consulta campanhas BREVO do e-mail 3 (lotes Kit não passam
  // por aqui).
  const refreshErrors = data.refreshErrors ?? [];
  const falhaConsulta = data.summary?.byEmail3Stage?.falha_consulta ?? 0;
  if (refreshErrors.length > 0 || falhaConsulta > 0) {
    const partes = [];
    if (falhaConsulta > 0) partes.push(`${falhaConsulta} convite(s) sem estado confirmado`);
    if (refreshErrors.length > 0) partes.push(refreshErrors.map((e) => `campanha ${e.campaignId} (${e.message})`).join("; "));
    items.push(item("brevo-consulta", "Consulta à Brevo falhou", partes.join(": ") + ".", "Reconsultar a Brevo", null, "refresh-brevo"));
  }

  const ambiguos = data.summary?.byEmail3Stage?.estado_ambiguo ?? 0;
  if (ambiguos > 0) {
    items.push(
      item(
        "brevo-ambiguo",
        `${ambiguos} convite(s) com estado ambíguo na Brevo`,
        "A Brevo devolveu suspended/in_review para a campanha do e-mail 3.",
        "Abrir a campanha na Brevo e ver por que foi suspensa antes de agendar",
      ),
    );
  }

  if (data.apoiadorDataError) {
    items.push(
      item(
        "apoiadores",
        "Vínculo com apoiadores indisponível",
        `${data.apoiadorDataError}. Sem ele, "apoia" e "1º apoio confirmado" ficam sem dado.`,
        "Conferir o export de apoiadores",
      ),
    );
  }

  return items;
}

/** Linhas da tabela de rascunhos/lotes parados (`summary.staleDrafts`), cada
 *  uma com a ação do relatório (`nextAction`). Linha cuja ação é "nenhuma…"
 *  sai: o topo só mostra o que pede ação. */
export function staleDraftRows(staleDrafts) {
  return (staleDrafts ?? [])
    .filter((d) => !/^nenhuma\b/i.test(String(d.nextAction ?? "").trim()))
    .map((d) => ({
      email: d.email ?? "—",
      provider: d.provider ?? "—",
      idade: d.ageDays == null ? "—" : String(d.ageDays),
      campanha: d.campaignOrBroadcastId == null ? "—" : String(d.campaignOrBroadcastId),
      acao: d.nextAction ?? "—",
    }));
}

/** Estágios do e-mail 3 com contagem > 0, para o detalhamento em "Detalhes". */
export function stageBreakdownRows(byEmail3Stage) {
  return Object.entries(EMAIL3_STAGE_LABELS)
    .map(([key, label]) => ({ key, label, count: byEmail3Stage?.[key] ?? 0 }))
    .filter((r) => r.count > 0);
}

/**
 * Estado do topo da página a partir do payload (ou da falha de carga).
 * `refreshError` = o POST de refresh falhou; `data` continua sendo o último
 * payload bom (a lista anterior segue válida na tela).
 * "Nada pedindo ação" só aparece quando há dado para afirmar isso: nunca
 * sem store, com store corrompido, com falha de carga/refresh, nem com
 * rascunho parado na tabela.
 */
export function panelState({ data = null, loadError = null, refreshError = null } = {}) {
  if (loadError != null || !data || !data.db) {
    return {
      items: [],
      staleRows: [],
      nodataHidden: true,
      emptyHidden: true,
      loadErrorText:
        loadError == null && refreshError != null
          ? refreshErrorText(refreshError)
          : `Falha ao carregar o onboarding: ${loadError ?? "resposta sem dados"}. Recarregue a página; se persistir, confira o log do Studio.`,
    };
  }
  const items = buildActionItems(data);
  const usable = data.db.available === true && data.db.corrupted !== true;
  const staleRows = usable ? staleDraftRows(data.summary?.staleDrafts) : [];
  const pending = items.length > 0 || staleRows.length > 0;
  return {
    items,
    staleRows,
    nodataHidden: !(data.db.available !== true && data.db.corrupted !== true),
    emptyHidden: pending || !usable || refreshError != null,
    loadErrorText: refreshError != null ? refreshErrorText(refreshError) : null,
  };
}

function refreshErrorText(msg) {
  return `Falha ao reconsultar a Brevo: ${msg}. Tente de novo em alguns minutos (cota de 100 consultas/hora).`;
}

function linkHtml(link) {
  return link ? ` <a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>` : "";
}

function buttonHtml(button) {
  return button === "refresh-brevo" ? ` <button type="button" class="assinantes-action-btn" data-action="refresh-brevo">Reconsultar a Brevo</button>` : "";
}

export function actionItemsHtml(items) {
  return items
    .map(
      (it) => `
    <div class="assinantes-action-item" data-id="${escapeHtml(it.id)}">
      <div class="assinantes-action-title">${escapeHtml(it.titulo)}</div>
      <div class="assinantes-action-detail">${escapeHtml(it.detalhe)}</div>
      <div class="assinantes-action-do"><strong>Ação:</strong> ${escapeHtml(it.acao)}${linkHtml(it.link)}${buttonHtml(it.button)}</div>
    </div>`,
    )
    .join("");
}
