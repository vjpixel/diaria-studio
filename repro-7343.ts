import { classifyDesbloqueioCandidate, type DesbloqueioIssueInput } from "./scripts/lib/desbloqueia-scan.ts";
import { formatExecutionBlockMarker } from "./scripts/lib/issue-decisions.ts";

function baseInput(overrides: Partial<DesbloqueioIssueInput> = {}): DesbloqueioIssueInput {
  return {
    number: 6504,
    title: "issue de teste",
    labels: ["external-blocker"],
    body: "corpo",
    state: "OPEN",
    updatedAt: "2026-09-01T00:00:00Z",
    comments: [],
    ...overrides,
  };
}

const block = formatExecutionBlockMarker({
  recorded_at: "2026-09-01T12:00:00Z",
  motivo: "Postmaster Tools recusando news.diar.ia.br por volume acumulado insuficiente",
  sessao: "overnight",
  condicao: { tipo: "externo",descricao: "falta melhoria de reputacao de dominio" },
});

const r1 = classifyDesbloqueioCandidate(baseInput({ updatedAt: "2026-09-01T12:05:00Z", comments: [block] }));
console.log("exec1:", r1?.status);

const reviewComment = 'Revisado por /diaria-desbloqueia — bloqueio de execucao de 2026-09-01T12:00:00Z ("Postmaster Tools recusando news.diar.ia.br por volume acumulado insuficiente") segue valendo, nenhuma mudança.';
const r2 = classifyDesbloqueioCandidate(baseInput({
  updatedAt: "2026-09-03T16:00:00Z",
  comments: [block, reviewComment],
}));
console.log("exec2:", r2?.status);
