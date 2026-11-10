// Tipos de formulario-parcial.js (#12583) — só pro typecheck dos testes
// (tsconfig.test.json); o browser carrega o .js direto, sem build step. A
// entrada vem do produtor real (type-only): mudar o contrato do servidor
// quebra o typecheck do teste deste painel.

import type { FormResultsView } from "../studio-onboarding-form.ts";
import type { FormChoiceTally, FormOpenAnswersBlock, FormPartialResults } from "../../lib/onboarding-form-partial-results.ts";

type Available = Extract<FormResultsView, { available: true }>;

export function formSummaryHtml(data: Available): string;
export function formQuestionsHtml(perguntas: readonly FormChoiceTally[]): string;
export function formOpenAnswersHtml(abertas: readonly FormOpenAnswersBlock[]): string;
export function conversaHtml(conversa: FormPartialResults["conversa"]): string;
export function formUnavailableText(data: Partial<Extract<FormResultsView, { available: false }>> | null): string;
