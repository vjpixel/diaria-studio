/**
 * audience-survey-questions.ts (#10605)
 *
 * Matchers das perguntas que `scripts/update-audience.ts` agrega em
 * `context/audience-profile.md`, o tipo único das respostas de survey
 * (`data/audience-raw.json`, usado também por `scripts/audience-run.ts`) e a
 * conversão das respostas do formulário do onboarding
 * (`scripts/lib/onboarding-form-contract.ts`) para esse formato.
 *
 * A survey antiga da Beehiiv e o formulário do onboarding entram no MESMO
 * perfil. Os rótulos das 3 perguntas de perfil do formulário são diferentes
 * dos da survey, mas os dois casam com os mesmos matchers abaixo e usam
 * opções compatíveis, então as contagens somam nas mesmas linhas. As
 * perguntas de produto só existem no formulário e têm seção própria no
 * perfil.
 *
 * Puro (sem I/O). `test/onboarding-form-questions-10605.test.ts` trava que
 * toda pergunta do formulário cai em exatamente um matcher e que nenhum
 * prompt da survey antiga cai num matcher de produto.
 */

import { FORM_QUESTIONS, splitMultiAnswer, type FormQuestion, type FormResponse } from "./onboarding-form-contract.ts";

/** Pergunta da survey/formulário → seção do perfil (casamento por texto). */
export const SURVEY_MATCHERS = {
  contentTypes: /se[çc][õo]es|tipos? de conte[úu]do/i,
  sectors: /setor de atua[çc][ãa]o da organiza/i,
  areas: /principal [áa]rea de atua[çc][ãa]o/i,
  aiLevel: /n[íi]vel de conhecimento em ia/i,
  productFormats: /al[ée]m da newsletter/i,
  courseTopics: /tema voc[êe] faria um curso/i,
  coursePrice: /quanto voc[êe] investiria/i,
  openSuggestion: /quer contar mais alguma coisa/i,
} as const;

export type SurveyMatcherKey = keyof typeof SURVEY_MATCHERS;

export interface SurveyAnswerRecord {
  question_id: string;
  question_prompt: string;
  answer: string;
}

/** Uma resposta em `data/audience-raw.json` — survey Beehiiv, Tally ou formulário do onboarding. */
export interface SurveyResponseRecord {
  id: string;
  status?: string;
  answers: SurveyAnswerRecord[];
}

/** Prefixo do `id` das respostas vindas do formulário do onboarding. */
export const ONBOARDING_FORM_RESPONSE_ID_PREFIX = "onboarding-form:";

export function isOnboardingFormResponse(r: { id: string }): boolean {
  return r.id.startsWith(ONBOARDING_FORM_RESPONSE_ID_PREFIX);
}

export interface FormToSurveyResult {
  responses: SurveyResponseRecord[];
  /** Respostas a ids que não estão mais em `questions` (pergunta removida ou renomeada) — descartadas. */
  unknownAnswers: number;
}

/**
 * @pure — respostas do formulário no formato da survey. Uma resposta
 * `checkbox` vira uma entrada por opção marcada (mesma forma da survey
 * Beehiiv de múltipla escolha, que `countAnswers` conta por opção). O `id`
 * não carrega o e-mail: o perfil só precisa de contagens. Sem `status`: o
 * Worker não tem esse conceito, e `update-audience.ts` trata ausente como
 * ativo. Resposta a pergunta que não existe mais em `questions` é descartada
 * e contada em `unknownAnswers`, para o caller avisar.
 */
export function onboardingFormToSurveyResponses(
  responses: readonly FormResponse[],
  questions: readonly FormQuestion[] = FORM_QUESTIONS,
): FormToSurveyResult {
  const known = new Map(questions.map((q) => [q.id, q]));
  let unknownAnswers = 0;
  const out = responses.map((r, i) => {
    const answers: SurveyAnswerRecord[] = [];
    for (const [id, value] of Object.entries(r.answers)) {
      const q = known.get(id);
      if (!q) {
        unknownAnswers++;
        continue;
      }
      if (typeof value !== "string" || value.trim() === "") continue;
      const parts = q.kind === "checkbox" ? splitMultiAnswer(value) : [value.trim()];
      for (const answer of parts) answers.push({ question_id: `form:${q.id}`, question_prompt: q.label, answer });
    }
    return { id: `${ONBOARDING_FORM_RESPONSE_ID_PREFIX}${i + 1}`, answers };
  });
  return { responses: out, unknownAnswers };
}
