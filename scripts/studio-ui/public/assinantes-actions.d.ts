// Tipos de assinantes-actions.js (#10606) — só pro typecheck dos testes
// (tsconfig.test.json); o browser carrega o .js direto, sem build step.
// Os tipos de entrada vêm dos produtores reais (type-only), então uma mudança
// de contrato no servidor quebra o typecheck dos testes deste painel.

import type { OnboardingFunnelData, OnboardingKitLotsView } from "../studio-onboarding.ts";
import type { OnboardingFunnelSummary, OnboardingEmail3Stage } from "../../lib/onboarding-funnel-report.ts";
import type { FollowupPanelView, PanelAlert } from "../../lib/onboarding-followup-panel.ts";
import type { FollowupBlockReason } from "../../lib/onboarding-followup.ts";

export interface ActionLink {
  readonly href: string;
  readonly label: string;
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

/** Payload de GET /api/onboarding/funnel (`OnboardingFunnelData`) ou do POST
 *  de refresh. Só `db` é obrigatório: o módulo lê o resto de forma defensiva. */
export type FunnelPayload = Pick<OnboardingFunnelData, "db"> &
  Partial<Pick<OnboardingFunnelData, "apoiadorDataError">> & {
    followup?: FollowupPanelView | null;
    summary?: Partial<Pick<OnboardingFunnelSummary, "byEmail3Stage" | "staleDrafts">>;
    kitLots?: Partial<Pick<OnboardingKitLotsView, "lastSendRun" | "consecutiveFailedSendRuns">> | null;
    /** POST de refresh sem BREVO_DIARIA_API_KEY (server.ts). */
    refreshWarning?: string;
    /** POST de refresh: campanhas Brevo cuja consulta falhou. */
    refreshErrors?: Array<{ campaignId: number; message: string }>;
  };

export type MappedBlockReason = Exclude<FollowupBlockReason, "desligado">;

export const BLOCK_ACTIONS: Readonly<Record<MappedBlockReason, Readonly<{ acao: string; link: ActionLink | null }>>>;
export const EMAIL3_STAGE_LABELS: Readonly<Record<OnboardingEmail3Stage, string>>;

export interface PanelState {
  items: ActionItem[];
  staleRows: StaleDraftRow[];
  nodataHidden: boolean;
  emptyHidden: boolean;
  loadErrorText: string | null;
}

export function escapeHtml(s: unknown): string;
export function streakCovers(alert: Pick<PanelAlert, "kind">, stepKey: string): boolean;
export function alertAction(alert: Pick<PanelAlert, "kind">): { acao: string; link: ActionLink | null };
export function buildActionItems(data: FunnelPayload | null | undefined): ActionItem[];
export function staleDraftRows(staleDrafts: OnboardingFunnelSummary["staleDrafts"] | null | undefined): StaleDraftRow[];
export function stageBreakdownRows(byEmail3Stage: Partial<Record<OnboardingEmail3Stage, number>> | null | undefined): Array<{ key: OnboardingEmail3Stage; label: string; count: number }>;
export function panelState(input?: { data?: FunnelPayload | null; loadError?: string | null; refreshError?: string | null }): PanelState;
export function actionItemsHtml(items: readonly ActionItem[]): string;
