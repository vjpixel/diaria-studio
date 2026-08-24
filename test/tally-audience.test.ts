/**
 * test/tally-audience.test.ts (#466)
 *
 * Cobre `scripts/lib/shared/tally-audience.ts` contra o shape REAL
 * confirmado ao vivo em 24/08/2026 (1 submissão real do form de produção,
 * `GET /forms/xX5JJy/submissions`) — `answer` é sempre array de string,
 * mesmo pra MULTIPLE_CHOICE de escolha única (achado que contradiz a doc
 * pública da Tally).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQuestionTitleMap,
  tallySubmissionToSurveyResponse,
  tallySubmissionsPageToSurveyResponses,
  type TallyQuestion,
  type TallySubmission,
  type TallySubmissionsListResponse,
} from "../scripts/lib/shared/tally-audience.ts";

const QUESTIONS: TallyQuestion[] = [
  { id: "MJRLOp", title: "Como você classificaria seu nível de conhecimento em IA?", type: "MULTIPLE_CHOICE" },
  { id: "JJzLR4", title: "Quais seções ou tipos de conteúdo mais te interessam?", type: "CHECKBOXES" },
];

describe("buildQuestionTitleMap", () => {
  it("mapeia id -> title", () => {
    const map = buildQuestionTitleMap(QUESTIONS);
    assert.equal(map.get("MJRLOp"), "Como você classificaria seu nível de conhecimento em IA?");
    assert.equal(map.get("JJzLR4"), "Quais seções ou tipos de conteúdo mais te interessam?");
    assert.equal(map.get("ausente"), undefined);
  });
});

describe("tallySubmissionToSurveyResponse", () => {
  it("escolha única (MULTIPLE_CHOICE): answer array de 1 item vira 1 entrada em answers", () => {
    const titleMap = buildQuestionTitleMap(QUESTIONS);
    const submission: TallySubmission = {
      id: "VpD7XRl",
      isCompleted: true,
      responses: [
        { id: "r1", questionId: "MJRLOp", answer: ["Entusiasta (sei diferenciar IA, Machine Learning e Deep Learning)"] },
      ],
    };
    const result = tallySubmissionToSurveyResponse(submission, titleMap);
    assert.equal(result.id, "VpD7XRl");
    assert.equal(result.status, undefined, "status omitido de propósito — Tally não tem conceito de assinante ativo");
    assert.deepEqual(result.answers, [
      {
        question_id: "MJRLOp",
        question_prompt: "Como você classificaria seu nível de conhecimento em IA?",
        answer: "Entusiasta (sei diferenciar IA, Machine Learning e Deep Learning)",
      },
    ]);
  });

  it("múltipla escolha (CHECKBOXES): array com N itens vira N entradas separadas em answers", () => {
    const titleMap = buildQuestionTitleMap(QUESTIONS);
    const submission: TallySubmission = {
      id: "sub1",
      isCompleted: true,
      responses: [{ id: "r1", questionId: "JJzLR4", answer: ["Notícias do mundo de IA", "Tutoriais práticos"] }],
    };
    const result = tallySubmissionToSurveyResponse(submission, titleMap);
    assert.equal(result.answers.length, 2);
    assert.equal(result.answers[0].answer, "Notícias do mundo de IA");
    assert.equal(result.answers[1].answer, "Tutoriais práticos");
    assert.equal(result.answers[0].question_prompt, result.answers[1].question_prompt);
  });

  it("answer: [] (pergunta não respondida) não gera nenhuma entrada", () => {
    const titleMap = buildQuestionTitleMap(QUESTIONS);
    const submission: TallySubmission = {
      id: "sub1",
      isCompleted: true,
      responses: [{ id: "r1", questionId: "JJzLR4", answer: [] }],
    };
    const result = tallySubmissionToSurveyResponse(submission, titleMap);
    assert.deepEqual(result.answers, []);
  });

  it("questionId sem título no mapa: usa o questionId cru como prompt, nunca lança", () => {
    const titleMap = buildQuestionTitleMap(QUESTIONS);
    const submission: TallySubmission = {
      id: "sub1",
      isCompleted: true,
      responses: [{ id: "r1", questionId: "questaoDeletada", answer: ["resposta"] }],
    };
    const result = tallySubmissionToSurveyResponse(submission, titleMap);
    assert.equal(result.answers[0].question_prompt, "questaoDeletada");
  });

  it("string vazia dentro do array de answer é descartada", () => {
    const titleMap = buildQuestionTitleMap(QUESTIONS);
    const submission: TallySubmission = {
      id: "sub1",
      isCompleted: true,
      responses: [{ id: "r1", questionId: "JJzLR4", answer: ["Notícias do mundo de IA", ""] }],
    };
    const result = tallySubmissionToSurveyResponse(submission, titleMap);
    assert.equal(result.answers.length, 1);
  });
});

describe("tallySubmissionsPageToSurveyResponses", () => {
  it("shape real confirmado ao vivo (24/08/2026, 1 submissão real do form de produção)", () => {
    const realPage: TallySubmissionsListResponse = {
      page: 1,
      hasMore: false,
      questions: [
        { id: "MJRLOp", title: "Como você classificaria seu nível de conhecimento em IA?", type: "MULTIPLE_CHOICE" },
        { id: "JJzLR4", title: "Quais seções ou tipos de conteúdo mais te interessam?", type: "CHECKBOXES" },
        { id: "g7GLAl", title: "Qual o setor de atuação da organização onde você trabalha?", type: "CHECKBOXES" },
        { id: "yEYxyB", title: "Qual é a sua principal área de atuação?", type: "MULTIPLE_CHOICE" },
      ],
      submissions: [
        {
          id: "VpD7XRl",
          isCompleted: true,
          responses: [
            { id: "p5bDAdV", questionId: "MJRLOp", answer: ["Entusiasta (sei diferenciar IA, Machine Learning e Deep Learning)"] },
            { id: "1OA9KkM", questionId: "JJzLR4", answer: ["Notícias do mundo de IA", "Tutoriais práticos"] },
            { id: "MPeEODY", questionId: "g7GLAl", answer: ["Tecnologia"] },
            { id: "JG9ORdJ", questionId: "yEYxyB", answer: ["Engenharia/Software/Dados/TI"] },
          ],
        },
      ],
    };
    const result = tallySubmissionsPageToSurveyResponses(realPage);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "VpD7XRl");
    assert.equal(result[0].answers.length, 5, "4 perguntas, 1 delas (checkboxes) com 2 respostas = 5 entradas");
  });

  it("submissão incompleta (isCompleted:false) é excluída", () => {
    const page: TallySubmissionsListResponse = {
      page: 1,
      hasMore: false,
      questions: QUESTIONS,
      submissions: [
        { id: "completa", isCompleted: true, responses: [{ id: "r1", questionId: "MJRLOp", answer: ["x"] }] },
        { id: "incompleta", isCompleted: false, responses: [{ id: "r2", questionId: "MJRLOp", answer: ["y"] }] },
      ],
    };
    const result = tallySubmissionsPageToSurveyResponses(page);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "completa");
  });
});
