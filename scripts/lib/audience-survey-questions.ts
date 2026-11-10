/**
 * audience-survey-questions.ts (#10605)
 *
 * Matchers das perguntas que `scripts/update-audience.ts` agrega em
 * `context/audience-profile.md`, o tipo único das respostas de survey
 * (`data/audience-raw.json`, usado também por `scripts/audience-run.ts`) e a
 * conversão das respostas do formulário do onboarding
 * (`scripts/lib/onboarding-form-contract.ts`) para esse formato.
 *
 * Desde a decisão 10 do editor (08/11/2026) o perfil sai SÓ do formulário
 * do onboarding: as respostas da survey antiga da Beehiiv (e do Tally) foram
 * descartadas, e `update-audience.ts` ignora qualquer resposta que não venha
 * do formulário (`isOnboardingFormResponse`). Por isso o matcher `sectors`
 * (pergunta que só a survey da Beehiiv tinha) saiu. Na v3 (09/11/2026) os
 * matchers seguem as 15 perguntas novas; nível, seções, inglês, preço e o
 * "mais alguma coisa" saíram (`LEGACY_FORM_ANSWER_IDS`, contados à parte).
 * Texto livre (relato de falha, "Outro/Outra") nunca sai daqui com o texto:
 * a pergunta aberta vira só a marca `OPEN_ANSWER_MARK`, para o perfil contar.
 *
 * Puro (sem I/O). `test/onboarding-form-questions-10605.test.ts` trava que
 * toda pergunta do formulário cai em exatamente um matcher.
 */

import {
  FORM_QUESTIONS,
  LEGACY_FORM_ANSWER_IDS,
  isChoiceQuestion,
  latestFormResponses,
  otherTextFieldId,
  splitMultiAnswer,
  unsentFormDrafts,
  type FormDraft,
  type FormQuestion,
  type FormResponse,
} from "./onboarding-form-contract.ts";

/** Pergunta da survey/formulário → seção do perfil (casamento por texto). */
export const SURVEY_MATCHERS = {
  aiUse: /como voc[êe] usa ia hoje/i,
  situation: /qual [ée] a sua situa[çc][ãa]o hoje/i,
  areas: /em que [áa]rea voc[êe] trabalha/i,
  recentUse: /o que voc[êe] fez com isso/i,
  tools: /quais ferramentas de ia voc[êe] usou/i,
  goals: /o que voc[êe] mais quer conseguir com ia/i,
  obstacles: /o que mais atrapalha voc[êe]/i,
  failureStory: /[úu]ltima vez que voc[êe] tentou usar ia/i,
  productFormats: /al[ée]m da newsletter/i,
  productChoice: /se s[óo] um deles existisse/i,
  courseTopics: /tema voc[êe] gostaria de aprender/i,
  whoPays: /quem paga pelas ferramentas/i,
  monthlySpend: /quanto voc[êe] paga por m[êe]s/i,
  biggestSpend: /material de estudo mais caro/i,
  interview: /toparia uma conversa/i,
} as const;

/** O que entra no lugar do texto de uma pergunta aberta (o texto fica no Worker). */
export const OPEN_ANSWER_MARK = "respondeu";

export type SurveyMatcherKey = keyof typeof SURVEY_MATCHERS;

export interface SurveyAnswerRecord {
  question_id: string;
  question_prompt: string;
  answer: string;
}

/** Uma resposta em `data/audience-raw.json` — desde a decisão 10 do editor, só do formulário do onboarding. */
export interface SurveyResponseRecord {
  id: string;
  status?: string;
  answers: SurveyAnswerRecord[];
  /** #12504: rascunho de quem começou e não enviou (conta por pergunta, como as respostas). */
  draft?: boolean;
}

/** Prefixo do `id` das respostas vindas do formulário do onboarding. */
export const ONBOARDING_FORM_RESPONSE_ID_PREFIX = "onboarding-form:";

export function isOnboardingFormResponse(r: { id: string }): boolean {
  return r.id.startsWith(ONBOARDING_FORM_RESPONSE_ID_PREFIX);
}

export interface FormToSurveyResult {
  responses: SurveyResponseRecord[];
  /** Respostas a ids que não estão em `questions` nem em `LEGACY_FORM_ANSWER_IDS` — descartadas. */
  unknownAnswers: number;
  /** Respostas a perguntas das versões anteriores (v1/v2, `LEGACY_FORM_ANSWER_IDS`) — descartadas. */
  legacyAnswers: number;
  /** Opções marcadas em pergunta que continua (ex.: `area`, `produto_tema`, `produto_formato`) mas
   *  que não existem mais nas opções atuais (v1/v2) — descartadas, nunca misturadas aos blocos v3. */
  legacyOptionAnswers: number;
  /** Respostas sem nenhuma resposta aproveitável (só perguntas desconhecidas ou vazias) — não contam como respondente. */
  emptyResponses: number;
}

/**
 * @pure — respostas do formulário no formato da survey. Uma resposta
 * `checkbox` vira uma entrada por opção marcada (mesma forma da survey
 * Beehiiv de múltipla escolha, que `countAnswers` conta por opção). O `id`
 * não carrega o e-mail: o perfil só precisa de contagens. Sem `status`: o
 * Worker não tem esse conceito, e `update-audience.ts` trata ausente como
 * ativo. Resposta a pergunta que não existe mais em `questions` é descartada
 * e contada em `unknownAnswers`, para o caller avisar. Uma resposta que fica
 * sem nenhuma resposta aproveitável (todas a perguntas desconhecidas, ou em
 * branco) não vira respondente: sai da lista e conta em `emptyResponses`.
 * O texto livre do "Outro/Outra" (`{id}_outro`) é pulado em silêncio: não é
 * pergunta desconhecida, mas também nunca vai para o perfil (que entra em
 * prompts); lá só conta a opção marcada. Pergunta aberta (relato de falha)
 * vira `OPEN_ANSWER_MARK`, sem o texto. Desde a v3 vale só a resposta mais
 * recente de cada e-mail (`latestFormResponses`: o Worker guarda o histórico).
 * Id de versão anterior (`LEGACY_FORM_ANSWER_IDS`) conta em `legacyAnswers`,
 * à parte do desconhecido de verdade.
 */
export function onboardingFormToSurveyResponses(
  responses: readonly FormResponse[],
  questions: readonly FormQuestion[] = FORM_QUESTIONS,
  drafts: readonly FormDraft[] = [],
): FormToSurveyResult {
  const known = new Map(questions.map((q) => [q.id, q]));
  const otherTextIds = new Set(questions.filter((q) => isChoiceQuestion(q) && q.otherOption).map(otherTextFieldId));
  let unknownAnswers = 0;
  let legacyAnswers = 0;
  let legacyOptionAnswers = 0;
  let emptyResponses = 0;
  const legacy = new Set(LEGACY_FORM_ANSWER_IDS);
  const out: SurveyResponseRecord[] = [];
  // #12504 (decisão do editor de 09/11/2026): o rascunho de quem não enviou
  // entra também, por pergunta, com o último estado salvo; cada pessoa uma
  // vez só (a resposta enviada vence o rascunho, `unsentFormDrafts`).
  const people: { answers: Readonly<Record<string, string>>; draft: boolean }[] = [
    ...latestFormResponses(responses).map((r) => ({ answers: r.answers, draft: false })),
    ...unsentFormDrafts(drafts, responses).map((d) => ({ answers: d.answers, draft: true })),
  ];
  for (const r of people) {
    const answers: SurveyAnswerRecord[] = [];
    for (const [id, value] of Object.entries(r.answers)) {
      if (otherTextIds.has(id)) continue;
      const q = known.get(id);
      if (!q) {
        if (legacy.has(id)) legacyAnswers++;
        else unknownAnswers++;
        continue;
      }
      if (typeof value !== "string" || value.trim() === "") continue;
      const parts = q.kind === "checkbox" ? splitMultiAnswer(value) : isChoiceQuestion(q) ? [value.trim()] : [OPEN_ANSWER_MARK];
      for (const answer of parts) {
        // Opção de versão anterior (ex.: "Engenharia/Software/Dados/TI" em `area`): fora dos blocos v3.
        if (isChoiceQuestion(q) && !q.options.includes(answer)) {
          legacyOptionAnswers++;
          continue;
        }
        answers.push({ question_id: `form:${q.id}`, question_prompt: q.label, answer });
      }
    }
    if (answers.length === 0) {
      emptyResponses++;
      continue;
    }
    out.push({ id: `${ONBOARDING_FORM_RESPONSE_ID_PREFIX}${out.length + 1}`, answers, ...(r.draft ? { draft: true } : {}) });
  }
  return { responses: out, unknownAnswers, legacyAnswers, legacyOptionAnswers, emptyResponses };
}
