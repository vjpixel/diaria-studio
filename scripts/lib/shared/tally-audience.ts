/**
 * tally-audience.ts (#466 — migração Beehiiv → Kit, #461)
 *
 * Transforma respostas do form Tally do survey de audiência no MESMO shape
 * que `scripts/audience-run.ts::BeehiivSurveyResponse` já espera — zero
 * mudança no consumidor (`normalizeSurveyResponses`/`update-audience.ts`).
 *
 * ## Por que Tally (achado #466, decisão do editor 24/08/2026)
 *
 * O Kit não tem builder de survey nativo — só Form simples (opt-in) ou
 * embed de terceiro. Alternativas pesquisadas: Google Forms + Apps Script
 * (zero custo, mas sem webhook nativo) e Tally (free tier com webhook
 * nativo, diferente do Typeform que só libera webhook no plano pago).
 * Editor escolheu Tally.
 *
 * ## Sem webhook, pull direto via REST (achado ao vivo #466)
 *
 * `GET /forms/{formId}/submissions` lista TODAS as submissões diretamente
 * — não precisa de Worker/KV/webhook nenhum, ao contrário do desenho
 * original cogitado (Tally → Worker → KV → script). Simplifica pra um pull
 * puro, mesmo padrão do fluxo Beehiiv MCP que este substitui, só que 100%
 * REST (nem MCP precisa aqui — vantagem sobre a Beehiiv, cuja survey só sai
 * por MCP).
 *
 * ## Shape confirmado ao vivo (24/08/2026, contra 1 submissão real)
 *
 * `GET /forms/{formId}/submissions` devolve `{questions: [{id, title,
 * type}], submissions: [{id, isCompleted, responses: [{questionId,
 * answer}]}]}`. **`answer` é SEMPRE um array de string** — inclusive pra
 * perguntas de escolha única (`MULTIPLE_CHOICE`), não só pra `CHECKBOXES`
 * (achado que contradiz a doc pública da Tally, que mostrava `answer`
 * como string solta pra escolha única — não confiar nesse detalhe sem
 * verificar ao vivo, mesma disciplina já aplicada ao Kit no #464/#6047/#6048).
 * O campo `formattedAnswer` que a doc também mostrava **não apareceu** na
 * resposta real.
 *
 * `questionId` referencia `questions[].id` pra resolver `title` (via
 * `buildQuestionTitleMap`) — isso vira `question_prompt`, que é o campo
 * que `scripts/update-audience.ts::countAnswers` casa por REGEX (não por
 * id), então qualquer form Tally com perguntas de texto equivalente
 * funciona sem mudar nenhum regex existente.
 *
 * `status` do `BeehiivSurveyResponse` fica OMITIDO de propósito — Tally
 * não tem conceito de "assinante ativo/bounced" (isso é da plataforma de
 * e-mail, não da survey); `normalizeSurveyResponses`/`update-audience.ts`
 * já tratam `status` ausente como incluído (`!r.status || r.status ===
 * "active"`), então omitir é o valor correto, não um "active" forçado.
 */

export interface TallyQuestion {
  id: string;
  title: string;
  type: string;
}

export interface TallyResponseItem {
  id: string;
  questionId: string;
  /** Sempre array — ver docstring do módulo. */
  answer: string[];
}

export interface TallySubmission {
  id: string;
  isCompleted: boolean;
  responses: TallyResponseItem[];
}

export interface TallySubmissionsListResponse {
  page: number;
  hasMore: boolean;
  questions: TallyQuestion[];
  submissions: TallySubmission[];
}

/** Mesmo shape de `BeehiivSurveyResponse`/`BeehiivSurveyAnswer`
 *  (`scripts/audience-run.ts`) — duplicado aqui de propósito (não
 *  importado) pra este módulo não depender de `audience-run.ts` só por um
 *  tipo; `normalizeSurveyResponses` valida estruturalmente, não por
 *  identidade de tipo. */
export interface SurveyResponseLike {
  id: string;
  status?: string;
  answers: { question_id: string; question_prompt: string; answer: string }[];
}

/** Pura — mapa `questionId -> title`, usado por
 *  `tallySubmissionToSurveyResponse` pra resolver `question_prompt`. */
export function buildQuestionTitleMap(questions: TallyQuestion[]): Map<string, string> {
  return new Map(questions.map((q) => [q.id, q.title]));
}

/**
 * Pura — 1 submissão Tally -> 1 `SurveyResponseLike`. Uma pergunta CHECKBOXES
 * com N respostas selecionadas vira N entradas em `answers` (mesmo padrão
 * que `countAnswers` já espera pra contar frequência de cada opção
 * separadamente — não 1 entrada com todas concatenadas). Uma resposta com
 * `answer: []` (pergunta pulada/não respondida) não gera entrada nenhuma.
 *
 * `questionId` sem entrada em `questionTitleById` (pergunta deletada do
 * form depois da resposta existir, ou mapa incompleto) usa o `questionId`
 * cru como `question_prompt` — nunca lança, só produz um prompt que não
 * vai casar com nenhum regex de `countAnswers` (efeito prático: essa
 * resposta some do agregado, não corrompe as demais).
 */
export function tallySubmissionToSurveyResponse(
  submission: TallySubmission,
  questionTitleById: Map<string, string>,
): SurveyResponseLike {
  const answers: SurveyResponseLike["answers"] = [];
  for (const r of submission.responses) {
    const question_prompt = questionTitleById.get(r.questionId) ?? r.questionId;
    for (const answer of r.answer) {
      if (!answer) continue;
      answers.push({ question_id: r.questionId, question_prompt, answer });
    }
  }
  return { id: submission.id, answers };
}

/** Pura — aplica `tallySubmissionToSurveyResponse` a uma página inteira de
 *  `GET /forms/{formId}/submissions`. Submissões incompletas
 *  (`isCompleted: false` — respondente abandonou o form no meio) são
 *  EXCLUÍDAS: uma resposta parcial mediria sinal de quem nem terminou de
 *  responder, o que enviesaria a agregação sem nenhum ganho (a pessoa pode
 *  voltar e completar depois, gerando a entrada completa então). */
export function tallySubmissionsPageToSurveyResponses(page: TallySubmissionsListResponse): SurveyResponseLike[] {
  const titleMap = buildQuestionTitleMap(page.questions);
  return page.submissions.filter((s) => s.isCompleted).map((s) => tallySubmissionToSurveyResponse(s, titleMap));
}
