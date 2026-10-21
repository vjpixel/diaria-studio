// Tipos de assinantes-actions.js (#10606) — só pro typecheck dos testes
// (tsconfig.test.json); o browser carrega o .js direto, sem build step.

export interface ActionLink {
  href: string;
  label: string;
}

export interface ActionItem {
  id: string;
  titulo: string;
  detalhe: string;
  acao: string;
  link: ActionLink | null;
  button: "refresh-brevo" | null;
}

export interface StaleDraftRow {
  email: string;
  provider: string;
  idade: string;
  campanha: string;
  acao: string;
}

export const BLOCK_ACTIONS: Record<
  "snippet_ausente" | "texto_pendente" | "snippet_invalido" | "form_nao_configurado" | "respostas_indisponiveis" | "kit_indisponivel",
  { acao: string; link: ActionLink | null }
>;

export function escapeHtml(s: unknown): string;
export function streakCovers(alert: { etapa: string; mensagem: string }, stepKey: string): boolean;
export function alertAction(alert: { etapa: string; mensagem: string }): { acao: string; link: ActionLink | null };
// `data` é o JSON de GET /api/onboarding/funnel, lido de forma defensiva.
export function buildActionItems(data: unknown): ActionItem[];
export function staleDraftRows(staleDrafts: unknown): StaleDraftRow[];
export function actionItemsHtml(items: ActionItem[]): string;
