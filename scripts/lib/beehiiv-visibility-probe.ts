/**
 * beehiiv-visibility-probe.ts (#3450)
 *
 * Decisão determinística e pura do "preflight de visibilidade da aba" do
 * playbook Beehiiv (`context/publishers/beehiiv-playbook.md`, seção
 * "Preflight de visibilidade da aba", #2015/#2075). Antes desta extração a
 * lógica vivia inteiramente em prosa dentro do playbook — reimplementada
 * mentalmente pelo agent a cada invocação, sem cobertura de teste.
 *
 * Contexto do bug (#3450, edição 260714): o dispatch automático de
 * `/diaria-5-publicacao` foi bloqueado por timeout de screenshot CDP logo
 * após o paste do corpo HTML + título/subtítulo (conteúdo crítico já
 * confirmado persistido via a varredura `doc.descendants` do §5.3 do
 * playbook). O halt banner interrompeu o dispatch inteiro nesse ponto —
 * mesmo com o paste (a parte cara/arriscada) já verificado — obrigando o
 * editor a assumir manualmente daí em diante.
 *
 * Duas mudanças de robustez (#3450, direção da issue):
 *   (c) timeout do screenshot-probe alargado de 10s pra 20s — 10s podia ser
 *       insuficiente em contexto lento (página pesada mesmo com
 *       img/iframe/video ocultados antes do screenshot).
 *   (a) quando o conteúdo crítico já foi verificado como persistido
 *       (`contentAlreadyPasted: true` — ex: paste já passou pela varredura
 *       de merge-tags do §5.3), um screenshot-probe que falha não deve mais
 *       abortar o dispatch inteiro (`halt`) — o screenshot é diagnóstico
 *       (confirma que a aba está responsiva pra cliques SEGUINTES, como Send
 *       test email), não crítico ao trabalho já feito. Rebaixa pra
 *       `warn_and_proceed`: o orchestrator continua tentando o próximo
 *       passo, mas registra o aviso pro editor revisar se algo não
 *       completar (em vez de travar tudo esperando "retry").
 *
 * Quando `contentAlreadyPasted` for `false`/omitido (ex: preflight ANTES de
 * qualquer paste, como abrir o post ou clicar "New post"), o comportamento
 * de halt em frozen real é preservado — não há conteúdo já persistido pra
 * proteger, então travar e pedir intervenção humana continua sendo a opção
 * mais segura.
 */

export const DEFAULT_SCREENSHOT_TIMEOUT_MS = 20_000; // #3450: 10s → 20s

export interface VisibilityProbeInput {
  /** `document.visibilityState` lido via javascript_tool. */
  visibilityState: "visible" | "hidden" | string;
  /** Screenshot (`computer` action screenshot) retornou com sucesso dentro do timeout? */
  screenshotOk: boolean;
  /** Tempo decorrido do screenshot em ms; `null` se erro/timeout sem duração conhecida. */
  screenshotElapsedMs: number | null;
  /** Threshold de timeout — default `DEFAULT_SCREENSHOT_TIMEOUT_MS` (#3450). */
  timeoutMs?: number;
  /**
   * #3450: conteúdo crítico (paste do corpo) já foi verificado como
   * persistido (ex: varredura doc.descendants do §5.3 confirmou merge tags +
   * docSize) ANTES deste probe. Se `true`, um probe "frozen" não bloqueia o
   * dispatch inteiro — rebaixa pra warning.
   */
  contentAlreadyPasted?: boolean;
}

export type VisibilityProbeAction = "proceed" | "warn_and_proceed" | "halt";

export interface VisibilityProbeDecision {
  action: VisibilityProbeAction;
  reason:
    | "visible"
    | "stale_hidden"
    | "frozen_but_content_verified"
    | "frozen";
  /** Mensagem pronta pra log/relato ao editor. */
  message: string;
}

/**
 * Classifica o resultado do preflight de visibilidade + screenshot-probe.
 * Pure — sem I/O, sem chamadas MCP. O caller (orchestrator/playbook) faz as
 * chamadas reais (`javascript_tool`, `computer` screenshot) e passa os
 * resultados aqui pra decidir a ação.
 */
export function classifyVisibilityProbe(
  input: VisibilityProbeInput,
): VisibilityProbeDecision {
  const timeoutMs = input.timeoutMs ?? DEFAULT_SCREENSHOT_TIMEOUT_MS;

  if (input.visibilityState === "visible") {
    return {
      action: "proceed",
      reason: "visible",
      message: "aba visível — prosseguir diretamente.",
    };
  }

  // visibilityState === "hidden" (ou valor inesperado — tratado como hidden,
  // fail-safe: exige o screenshot-probe pra confirmar).
  const withinTimeout =
    input.screenshotOk &&
    input.screenshotElapsedMs !== null &&
    input.screenshotElapsedMs <= timeoutMs;

  if (withinTimeout) {
    return {
      action: "proceed",
      reason: "stale_hidden",
      message:
        `visibilityState=hidden mas screenshot OK em ${input.screenshotElapsedMs}ms ` +
        `(≤ ${timeoutMs}ms) — stale; prosseguir sem haltar.`,
    };
  }

  // Screenshot falhou/timeout — "frozen real" candidato.
  if (input.contentAlreadyPasted) {
    return {
      action: "warn_and_proceed",
      reason: "frozen_but_content_verified",
      message:
        "⚠️ aba possivelmente oculta/minimizada (screenshot timeout/falha) " +
        "mas o conteúdo crítico (paste) já foi verificado como persistido — " +
        "screenshot é diagnóstico, não crítico ao paste (#3450). Prosseguindo " +
        "sem halt; registrar em unfixed_issues[] pra revisão do editor se o " +
        "próximo passo (ex: Send test email) não completar.",
    };
  }

  return {
    action: "halt",
    reason: "frozen",
    message:
      "aba Beehiiv oculta/minimizada (visibilityState=hidden + screenshot " +
      "timeout/falha) e nenhum conteúdo crítico foi verificado ainda — " +
      "halt banner necessário.",
  };
}
