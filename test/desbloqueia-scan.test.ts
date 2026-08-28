/**
 * test/desbloqueia-scan.test.ts (#6628)
 *
 * Regressão pura pra `scripts/lib/desbloqueia-scan.ts` — nenhuma chamada
 * `gh` real (as funções recebem body/labels/comentários já buscados).
 * Cobre a lista pedida pelo critério de aceite da issue:
 *
 *   - issue com decisão registrada em comentário posterior ao `updatedAt`
 *     → `ja-destravada`, ZERO pergunta necessária (o teste central do
 *     requisito "ler a thread antes de perguntar")
 *   - issue com bloqueio de execução registrado e recente → `bloqueio-confirmado`
 *   - issue sem nenhum marcador recente → `precisa-pergunta`
 *   - decisão MAIS ANTIGA que `updatedAt` (issue mudou depois da decisão)
 *     → não conta como resolvida, volta a `precisa-pergunta`
 *   - issue fora do escopo (`elegível`, `agendada`, `epica`, `fora-de-rodada`)
 *     → `null` / entra em `foraDoEscopo`, nunca nos 3 grupos de ação
 *   - `commentsRead` reflete o número real de comentários passados (prova
 *     de leitura completa, não amostra)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDesbloqueioCandidate,
  scanDesbloqueioCandidates,
  type DesbloqueioIssueInput,
} from "../scripts/lib/desbloqueia-scan.ts";
import { formatDecisionMarker, formatExecutionBlockMarker } from "../scripts/lib/issue-decisions.ts";

function baseInput(overrides: Partial<DesbloqueioIssueInput> = {}): DesbloqueioIssueInput {
  return {
    number: 1234,
    title: "issue de teste",
    labels: ["external-blocker"],
    body: "corpo qualquer",
    state: "OPEN",
    updatedAt: "2026-08-01T00:00:00Z",
    comments: [],
    ...overrides,
  };
}

describe("classifyDesbloqueioCandidate", () => {
  it("decisão registrada DEPOIS de updatedAt → ja-destravada, sem pergunta", () => {
    const marker = formatDecisionMarker({
      decided_at: "2026-08-15T00:00:00Z",
      pergunta: "Trocar X por Y?",
      resposta: "Trocar por Y",
      sessao: "develop",
    });
    const input = baseInput({
      updatedAt: "2026-08-01T00:00:00Z",
      comments: [`Decisão do editor: trocar por Y.\n\n${marker}`],
    });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "ja-destravada");
    assert.equal(result?.decision?.resposta, "Trocar por Y");
    assert.equal(result?.commentsRead, 1);
  });

  it("decisão registrada ANTES de updatedAt (issue mudou depois) → precisa-pergunta", () => {
    const marker = formatDecisionMarker({
      decided_at: "2026-07-01T00:00:00Z",
      pergunta: "Trocar X por Y?",
      resposta: "Trocar por Y",
      sessao: "develop",
    });
    const input = baseInput({
      updatedAt: "2026-08-01T00:00:00Z",
      comments: [marker],
    });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "precisa-pergunta");
  });

  it("bloqueio de execução recente sem decisão nova → bloqueio-confirmado", () => {
    const marker = formatExecutionBlockMarker({
      recorded_at: "2026-08-20T00:00:00Z",
      motivo: "falta acesso à conta X",
      sessao: "overnight",
    });
    const input = baseInput({
      updatedAt: "2026-08-01T00:00:00Z",
      comments: [marker],
    });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "bloqueio-confirmado");
    assert.equal(result?.executionBlock?.motivo, "falta acesso à conta X");
  });

  it("sem marcador nenhum → precisa-pergunta", () => {
    const input = baseInput({ comments: ["comentário qualquer sem marcador"] });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "precisa-pergunta");
  });

  it("issue elegível (sem label de bloqueio) → fora do escopo, devolve null", () => {
    const input = baseInput({ labels: [] });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result, null);
  });

  it("issue on-hold (fora-de-rodada) → fora do escopo, devolve null", () => {
    const input = baseInput({ labels: ["on-hold"] });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result, null);
  });

  it("commentsRead reflete o total de comentários passados, não uma amostra", () => {
    const input = baseInput({ comments: ["a", "b", "c", "d", "e"] });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.commentsRead, 5);
  });
});

describe("scanDesbloqueioCandidates", () => {
  it("agrupa múltiplas issues nos 3 destinos + fora do escopo", () => {
    const decided = formatDecisionMarker({
      decided_at: "2026-08-15T00:00:00Z",
      pergunta: "?",
      resposta: "sim",
      sessao: "develop",
    });
    const blocked = formatExecutionBlockMarker({
      recorded_at: "2026-08-20T00:00:00Z",
      motivo: "falta token",
      sessao: "overnight",
    });
    const report = scanDesbloqueioCandidates([
      baseInput({ number: 1, updatedAt: "2026-08-01T00:00:00Z", comments: [decided] }),
      baseInput({ number: 2, updatedAt: "2026-08-01T00:00:00Z", comments: [blocked] }),
      baseInput({ number: 3, comments: [] }),
      baseInput({ number: 4, labels: [] }),
    ]);
    assert.deepEqual(
      report.jaDestravadas.map((c) => c.number),
      [1],
    );
    assert.deepEqual(
      report.bloqueioConfirmado.map((c) => c.number),
      [2],
    );
    assert.deepEqual(
      report.precisaPergunta.map((c) => c.number),
      [3],
    );
    assert.deepEqual(report.foraDoEscopo, [4]);
  });

  it("lista vazia devolve os 4 grupos vazios", () => {
    const report = scanDesbloqueioCandidates([]);
    assert.deepEqual(report, {
      jaDestravadas: [],
      bloqueioConfirmado: [],
      precisaPergunta: [],
      foraDoEscopo: [],
    });
  });
});
