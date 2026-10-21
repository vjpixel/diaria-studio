// assinantes-actions.js (#10606) — lógica PURA do bloco "Pede ação" do
// painel /assinantes. Revisão do editor (20/10/2026): "a página está com
// informações demais. muitas delas, não sei qual ação eu faria com a
// informação." Daí a regra desta página: o que fica visível tem uma ação
// concreta ao lado; o resto vai pro <details> "Detalhes".
//
// Sem `document`/`fetch` aqui, de propósito: testável com fixtures puras em
// test/assinantes-actions-10606.test.ts (mesmo padrão de rodada-round-age.js).
// Entrada = o JSON de GET /api/onboarding/funnel (studio-onboarding.ts).

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TAREFAS_LINK = { href: "/tarefas", label: "Ver log em Tarefas" };
const CAIXAS_LINK = { href: "/caixas", label: "Abrir Caixas" };

/** Ação por motivo de trava das sequências de apoio/formulário. `desligado`
 *  fica de fora de propósito: é escolha de configuração, não falha — aparece
 *  só em "Detalhes". */
export const BLOCK_ACTIONS = {
  snippet_ausente: { acao: "Escrever o texto do e-mail", link: CAIXAS_LINK },
  texto_pendente: { acao: "Revisar e aprovar o texto do e-mail", link: CAIXAS_LINK },
  snippet_invalido: { acao: "Corrigir o cabeçalho ou o corpo do texto do e-mail", link: CAIXAS_LINK },
  form_nao_configurado: { acao: "Publicar o Worker do formulário e preencher onboarding.followup.form_url (#10605)", link: null },
  respostas_indisponiveis: { acao: "Conferir o Worker do formulário: as respostas não carregaram", link: null },
  kit_indisponivel: { acao: "Investigar o acesso ao Kit na última rodada", link: TAREFAS_LINK },
};

const SEQUENCIA_LABEL = { apoio: "Apoio D+30/90/180/360", form: "Formulário" };

/** Ação de cada alerta de falha em rodadas seguidas (`followup.alerts`). */
export function alertAction(alert) {
  if (/^lote /.test(alert.mensagem)) {
    return { acao: "Agendar ou apagar esse broadcast no painel do Kit", link: null };
  }
  if (alert.etapa.includes("transporte Kit")) {
    return { acao: "Investigar falha de envio: rodar npx tsx scripts/onboarding-kit-transport-run.ts (dry-run) e ler o erro", link: TAREFAS_LINK };
  }
  if (alert.etapa.includes("E-mail 3")) {
    return { acao: "Investigar falha de envio: rodar npx tsx scripts/onboarding-welcome-run.ts (dry-run) e ler o erro", link: TAREFAS_LINK };
  }
  return { acao: "Investigar falha de envio: rodar npx tsx scripts/onboarding-followup-run.ts (dry-run) e ler o erro", link: TAREFAS_LINK };
}

const LADDER_STEPS = new Set(["email1", "email2", "email3"]);

/** O alerta de rodadas seguidas cobre a etapa? Kit da escada cobre e-mails
 *  1/2/3; o das sequências cobre apoio/formulário. O do e-mail 3 via Brevo
 *  não é lote Kit e nunca é absorvido. */
export function streakCovers(alert, stepKey) {
  if (alert.etapa.includes("transporte Kit")) return LADDER_STEPS.has(stepKey);
  if (alert.etapa.startsWith("Sequências de apoio")) return !LADDER_STEPS.has(stepKey);
  return false;
}

/**
 * Lista do que pede ação agora. Cada item: `{ id, titulo, detalhe, acao,
 * link, button }` — `link` é `{ href, label }` ou null; `button` é
 * "refresh-brevo" quando a ação é reconsultar a Brevo pelo próprio painel.
 * Lista vazia = nada a fazer (a página diz isso em vez de esconder o bloco).
 */
export function buildActionItems(data) {
  const items = [];
  if (!data || !data.db) return items;

  if (data.db.corrupted) {
    items.push({
      id: "store-corrompido",
      titulo: "Store do onboarding ilegível",
      detalhe: "data/onboarding/store.json existe mas o JSON está corrompido. As contagens desta página não valem até isso ser resolvido.",
      acao: "Abrir o arquivo e corrigir o JSON (ou restaurar a versão anterior do OneDrive)",
      link: null,
      button: null,
    });
    return items;
  }
  if (!data.db.available) return items;

  const followup = data.followup ?? null;
  const alerts = followup?.alerts ?? [];
  const failingSteps = (followup?.steps ?? []).filter((s) => s.falhos > 0);

  // Dedupe (#10606, self-review da PR #10651): um lote Kit que falha gera
  // até 3 sinais — o item de envios falhos da etapa, o alerta de lote não
  // agendado (mesma etapa) e o alerta de rodadas seguidas com falha. Fica um
  // item por etapa, o mais específico, com os outros sinais citados dentro:
  //   lote não agendado (nomeia o lote, ação no painel do Kit)
  //   > envios falhos da etapa
  //   > alerta de rodadas seguidas (só sobra se nenhuma etapa dele falhou).
  const lotAlertSteps = new Set(alerts.filter((a) => /^lote /.test(a.mensagem)).map((a) => a.etapa));
  const streakFor = (step) => alerts.find((a) => !/^lote /.test(a.mensagem) && streakCovers(a, step.step));
  const absorbedStreaks = new Set(failingSteps.map(streakFor).filter(Boolean));

  for (const [i, alert] of alerts.entries()) {
    if (absorbedStreaks.has(alert)) continue;
    const a = alertAction(alert);
    let detalhe = alert.mensagem;
    if (/^lote /.test(alert.mensagem)) {
      const step = failingSteps.find((s) => s.label === alert.etapa);
      const streak = step ? streakFor(step) : null;
      if (step) detalhe += `. ${step.falhos} envio(s) falho(s) nesta etapa`;
      if (streak) detalhe += `. ${streak.mensagem}`;
    }
    items.push({ id: `alerta-${i}`, titulo: alert.etapa, detalhe, acao: a.acao, link: a.link, button: null });
  }

  for (const key of ["apoio", "form"]) {
    const b = followup?.blocked?.[key];
    if (!b || b.motivo === "desligado") continue; // `desligado` é escolha de config: só em Detalhes
    // Motivo sem ação mapeada (ex.: motivo novo no executor) NUNCA some do
    // topo: trava real escondida é a classe de falha do #10603.
    const a = BLOCK_ACTIONS[b.motivo] ?? { acao: `Investigar por que a sequência travou (motivo "${b.motivo}")`, link: TAREFAS_LINK };
    items.push({ id: `travado-${key}`, titulo: `${SEQUENCIA_LABEL[key]} travado`, detalhe: b.detalhe, acao: a.acao, link: a.link, button: null });
  }

  for (const step of failingSteps) {
    if (lotAlertSteps.has(step.label)) continue; // já citado no item do lote
    const streak = streakFor(step);
    items.push({
      id: `falhos-${step.step}`,
      titulo: `${step.label}: ${step.falhos} envio(s) falho(s)`,
      detalhe: "Destinatários de lote que falhou e ainda não têm envio registrado." + (streak ? ` ${streak.etapa}: ${streak.mensagem}.` : ""),
      acao: "Investigar falha de envio: ler o erro da última rodada do executor",
      link: TAREFAS_LINK,
      button: null,
    });
  }

  const refreshErrors = data.refreshErrors ?? [];
  const falhaConsulta = data.summary?.byEmail3Stage?.falha_consulta ?? 0;
  if (refreshErrors.length > 0 || falhaConsulta > 0) {
    const n = refreshErrors.length > 0 ? `${refreshErrors.length} campanha(s)` : `${falhaConsulta} convite(s)`;
    items.push({
      id: "brevo-consulta",
      titulo: "Consulta à Brevo falhou",
      detalhe: `${n} sem estado confirmado` + (refreshErrors.length > 0 ? `: ${refreshErrors.map((e) => `campanha ${e.campaignId} (${e.message})`).join("; ")}` : "."),
      acao: "Reconsultar a Brevo",
      link: null,
      button: "refresh-brevo",
    });
  }

  const ambiguos = data.summary?.byEmail3Stage?.estado_ambiguo ?? 0;
  if (ambiguos > 0) {
    items.push({
      id: "brevo-ambiguo",
      titulo: `${ambiguos} convite(s) com estado ambíguo na Brevo`,
      detalhe: "A Brevo devolveu suspended/in_review para a campanha do e-mail 3.",
      acao: "Abrir a campanha na Brevo e ver por que foi suspensa antes de agendar",
      link: null,
      button: null,
    });
  }

  return items;
}

/** Linhas da tabela de rascunhos/lotes parados (`summary.staleDrafts`), cada
 *  uma já com a ação do relatório (`nextAction`). */
export function staleDraftRows(staleDrafts) {
  return (staleDrafts ?? []).map((d) => ({
    email: d.email,
    provider: d.provider ?? "—",
    idade: d.ageDays == null ? "—" : String(d.ageDays),
    campanha: d.campaignOrBroadcastId == null ? "—" : String(d.campaignOrBroadcastId),
    acao: d.nextAction,
  }));
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
