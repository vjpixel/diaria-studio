/**
 * onboarding-form-contract.ts (#10605)
 *
 * CONTRATO do formulário de perfil/interesses do onboarding — decisão do
 * editor (briefing do overnight 261020): formulário PRÓPRIO num Worker nosso
 * (custo zero, dados nossos, `?email=` pré-preenchido pela merge tag do Kit).
 * Puro e sem dependência de Node: importado tanto pelo Worker
 * (`workers/onboarding-form/src/index.ts`) quanto pelo executor das
 * sequências (`scripts/onboarding-followup-run.ts`), pra os dois lados nunca
 * divergirem sobre o formato.
 *
 * ## Endpoints do Worker
 *
 *  - `GET  /?email={e-mail}` — página do formulário, com o e-mail
 *    pré-preenchido (editável).
 *  - `POST /enviar` (form-urlencoded) — valida com `parseFormSubmission` e
 *    grava a resposta (KV, chave `resp:{email normalizado}`; a última
 *    resposta vence).
 *  - `GET  /api/respostas` com `Authorization: Bearer {token}` — lista as
 *    respostas no formato `FormResponsesPayload`. É o que o executor lê a
 *    cada rodada para marcar "preencheu" no store e parar os lembretes.
 *
 * ## Perguntas
 *
 * As perguntas dependem do editor (#10605, "Depende do editor"). Até ele
 * definir, `FORM_QUESTIONS` fica vazio e o Worker só confirma o e-mail —
 * o envio dos e-mails do formulário segue travado pelo texto pendente
 * (`formContentGate`), então nenhum leitor chega a ver o formulário vazio.
 */

export interface FormQuestion {
  /** Chave da resposta (`answers[id]`) — estável, sem espaço. */
  id: string;
  label: string;
  kind: "text" | "textarea" | "select";
  options?: string[];
  required?: boolean;
}

/** Perguntas do formulário — PENDENTES do editor (#10605). */
export const FORM_QUESTIONS: readonly FormQuestion[] = [];

export const FORM_ANSWER_MAX_LEN = 2000;

export interface FormSubmission {
  email: string;
  answers: Record<string, string>;
}

export interface FormResponse extends FormSubmission {
  submitted_at: string;
}

export interface FormResponsesPayload {
  responses: FormResponse[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeFormEmail(raw: string): string {
  return String(raw ?? "").trim().toLowerCase();
}

/**
 * @pure — valida a submissão: e-mail válido, só respostas de perguntas
 * conhecidas (campo desconhecido é descartado, nunca gravado), obrigatórias
 * presentes, texto truncado em `FORM_ANSWER_MAX_LEN`, `select` só aceita uma
 * das opções.
 */
export function parseFormSubmission(
  fields: Readonly<Record<string, string | undefined>>,
  questions: readonly FormQuestion[] = FORM_QUESTIONS,
): { ok: true; submission: FormSubmission } | { ok: false; error: string } {
  const email = normalizeFormEmail(fields.email ?? "");
  if (!EMAIL_RE.test(email)) return { ok: false, error: "e-mail inválido" };
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const v = (fields[q.id] ?? "").trim();
    if (v === "") {
      if (q.required) return { ok: false, error: `resposta obrigatória ausente: ${q.label}` };
      continue;
    }
    if (q.kind === "select" && !(q.options ?? []).includes(v)) return { ok: false, error: `opção inválida em: ${q.label}` };
    answers[q.id] = v.slice(0, FORM_ANSWER_MAX_LEN);
  }
  return { ok: true, submission: { email, answers } };
}

/**
 * @pure — valida o payload de `GET /api/respostas` (lado do executor).
 * Qualquer forma inesperada LANÇA: resposta malformada nunca vira "ninguém
 * preencheu" (o que reenviaria lembretes a quem já respondeu).
 */
export function parseFormResponsesPayload(data: unknown): FormResponse[] {
  if (data == null || typeof data !== "object" || !Array.isArray((data as { responses?: unknown }).responses)) {
    throw new Error("[onboarding-form] payload de respostas sem o array `responses`");
  }
  const out: FormResponse[] = [];
  for (const r of (data as FormResponsesPayload).responses) {
    if (r == null || typeof r !== "object") throw new Error("[onboarding-form] resposta malformada no payload");
    const email = normalizeFormEmail((r as FormResponse).email);
    const at = (r as FormResponse).submitted_at;
    if (!EMAIL_RE.test(email) || typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
      throw new Error("[onboarding-form] resposta sem e-mail/submitted_at válidos no payload");
    }
    const answersRaw = (r as FormResponse).answers;
    const answers: Record<string, string> = {};
    if (answersRaw && typeof answersRaw === "object") {
      for (const [k, v] of Object.entries(answersRaw)) if (typeof v === "string") answers[k] = v;
    }
    out.push({ email, submitted_at: at, answers });
  }
  return out;
}

/** Chave KV de uma resposta (1 por e-mail; a última vence). */
export function formResponseKey(email: string): string {
  return `resp:${normalizeFormEmail(email)}`;
}

/** @pure — compara o token do header `Authorization` em tempo constante. */
export function isAuthorizedResponsesRequest(authHeader: string | null, token: string | undefined): boolean {
  if (!token) return false;
  const expected = `Bearer ${token}`;
  const got = authHeader ?? "";
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
