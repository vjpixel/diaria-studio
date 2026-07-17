/**
 * test/chat-hydration.test.ts (#3617) — cobertura da lógica PURA de
 * hidratação do chat drawer (`scripts/studio-ui/public/chat-hydration.js`):
 * validação/normalização do corpo de `GET /api/chat/pending` e o dedupe
 * contra cards já renderizados. Extraída de `chat-drawer.js` justamente
 * porque aquele arquivo toca `document` no top-level (constrói o painel
 * assim que importado) e não pode ser importado num teste Node puro sem um
 * DOM real — este módulo não tem NENHUM side-effect de top-level, então é
 * testável com fixtures como qualquer função pura server-side (mesmo padrão
 * de `sdkMessageToChatEvents`/`parseChatRequestBody` em `studio-chat.ts`).
 *
 * Regressão do #3617 (bug "gate pendente inalcançável"): antes deste fix,
 * não existia NENHUM mecanismo de reidratação — o card só existia como
 * parte do stream SSE ao vivo. Este arquivo cobre a metade "parse do
 * servidor -> payload pronto pra renderizar" do mecanismo; a metade
 * "servidor devolve o payload completo" é coberta por
 * `test/studio-chat.test.ts` (`listPendingPermissionRequestsFull`) e
 * `test/studio-server.test.ts` (`GET /api/chat/pending`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePendingChatResponse,
  planHydrationCards,
  isSensitiveQuestion,
} from "../scripts/studio-ui/public/chat-hydration.js";

const VALID_QUESTIONS = [
  {
    question: "Qual abordagem?",
    header: "Abordagem",
    multiSelect: false,
    options: [
      { label: "A", description: "opção A" },
      { label: "B", description: "opção B" },
    ],
  },
];

describe("parsePendingChatResponse (#3617)", () => {
  it("normaliza um payload válido com 1 pendente", () => {
    const result = parsePendingChatResponse({
      pending: [{ toolUseId: "tu-1", toolName: "AskUserQuestion", askedAt: 12345, questions: VALID_QUESTIONS }],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].toolUseId, "tu-1");
    assert.equal(result[0].toolName, "AskUserQuestion");
    assert.equal(result[0].askedAt, 12345);
    assert.deepEqual(result[0].questions, VALID_QUESTIONS);
  });

  it("normaliza múltiplos pendentes, preservando a ordem recebida", () => {
    const result = parsePendingChatResponse({
      pending: [
        { toolUseId: "tu-1", questions: VALID_QUESTIONS, askedAt: 1 },
        { toolUseId: "tu-2", questions: VALID_QUESTIONS, askedAt: 2 },
      ],
    });
    assert.deepEqual(result.map((p) => p.toolUseId), ["tu-1", "tu-2"]);
  });

  it("payload sem 'pending' (ou não-array) vira lista vazia, sem lançar", () => {
    assert.deepEqual(parsePendingChatResponse({}), []);
    assert.deepEqual(parsePendingChatResponse({ pending: "não é array" }), []);
    assert.deepEqual(parsePendingChatResponse(null), []);
    assert.deepEqual(parsePendingChatResponse(undefined), []);
  });

  it("descarta entradas sem 'toolUseId' válido, mantendo as demais", () => {
    const result = parsePendingChatResponse({
      pending: [
        { toolUseId: "", questions: VALID_QUESTIONS },
        { questions: VALID_QUESTIONS },
        { toolUseId: "tu-ok", questions: VALID_QUESTIONS, askedAt: 5 },
      ],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].toolUseId, "tu-ok");
  });

  it("descarta entradas com 'questions' ausente/vazio/tipo errado", () => {
    const result = parsePendingChatResponse({
      pending: [
        { toolUseId: "tu-1" },
        { toolUseId: "tu-2", questions: [] },
        { toolUseId: "tu-3", questions: "não é array" },
      ],
    });
    assert.equal(result.length, 0);
  });

  it("preenche 'toolName'/'askedAt' com defaults quando ausentes/tipo errado", () => {
    const result = parsePendingChatResponse({
      pending: [{ toolUseId: "tu-1", questions: VALID_QUESTIONS }],
    });
    assert.equal(result[0].toolName, "AskUserQuestion");
    assert.equal(typeof result[0].askedAt, "number");
  });
});

describe("planHydrationCards (#3617)", () => {
  const pending = [
    { toolUseId: "tu-1", toolName: "AskUserQuestion", askedAt: 1, questions: VALID_QUESTIONS },
    { toolUseId: "tu-2", toolName: "AskUserQuestion", askedAt: 2, questions: VALID_QUESTIONS },
  ];

  it("devolve tudo quando nenhum id já foi renderizado", () => {
    const result = planHydrationCards(pending, new Set());
    assert.equal(result.length, 2);
  });

  it("filtra os que já têm card renderizado — dedupe hidratação vs. SSE ao vivo", () => {
    const result = planHydrationCards(pending, new Set(["tu-1"]));
    assert.deepEqual(result.map((p) => p.toolUseId), ["tu-2"]);
  });

  it("aceita qualquer iterável de ids renderizados (ex: Map.keys()), não só Set", () => {
    const rendered = new Map([["tu-2", {}]]);
    const result = planHydrationCards(pending, rendered.keys());
    assert.deepEqual(result.map((p) => p.toolUseId), ["tu-1"]);
  });

  it("lista vazia de pendentes -> lista vazia, sem lançar", () => {
    assert.deepEqual(planHydrationCards([], new Set()), []);
  });
});

/**
 * #3561 (Studio UI fatia 7) — regressão #633: sem `isSensitiveQuestion`, o
 * campo "Other" do card de AskUserQuestion (chat-drawer.js) renderizava
 * `type="text"` pra QUALQUER pergunta, inclusive quando a sessão (rodando
 * `/diaria-develop`, Gate 1 cat. A) pede o editor colar um token/credencial
 * — o valor ficava em texto plano na tela, inclusive depois de enviado (o
 * input desabilitado mantinha o `.value`). Esta função é o sinal que
 * `chat-drawer.js` usa pra (a) montar o input como `type="password"` e (b)
 * limpar o valor da tela ao enviar — ver uso em `onPermissionRequest`.
 */
describe("isSensitiveQuestion (#3561)", () => {
  it("detecta 'token' no header", () => {
    assert.equal(isSensitiveQuestion({ header: "Token Instagram", question: "Cole aqui" }), true);
  });

  it("detecta 'credencial' na pergunta", () => {
    assert.equal(
      isSensitiveQuestion({ header: "Cat. A", question: "Qual é a credencial de acesso à API?" }),
      true,
    );
  });

  it("detecta variações — senha, API key, chave de API, secret (case-insensitive)", () => {
    assert.equal(isSensitiveQuestion({ header: "SENHA", question: "" }), true);
    assert.equal(isSensitiveQuestion({ header: "", question: "cole a API key" }), true);
    assert.equal(isSensitiveQuestion({ header: "", question: "informe a chave de API" }), true);
    assert.equal(isSensitiveQuestion({ header: "Secret", question: "" }), true);
    assert.equal(isSensitiveQuestion({ header: "api-key", question: "" }), true);
  });

  it("pergunta comum (sem termo sensível) -> false", () => {
    assert.equal(
      isSensitiveQuestion({ header: "Abordagem", question: "Formato A ou B de log?" }),
      false,
    );
  });

  it("word-boundary evita falso-positivo em palavra composta ('tokenização' não bate 'token')", () => {
    // \btoken\b não casa dentro de "tokenização" (sem boundary entre "token"
    // e "ização", ambos \w) — evita mascarar campos de perguntas legítimas
    // só porque mencionam o tema sem pedir um valor.
    assert.equal(isSensitiveQuestion({ header: "", question: "estratégia de tokenização" }), false);
  });

  it("input malformado (null/undefined/tipo errado) -> false, nunca lança", () => {
    assert.equal(isSensitiveQuestion(null), false);
    assert.equal(isSensitiveQuestion(undefined), false);
    assert.equal(isSensitiveQuestion("string"), false);
    assert.equal(isSensitiveQuestion({}), false);
    assert.equal(isSensitiveQuestion({ header: 123, question: null }), false);
  });
});
