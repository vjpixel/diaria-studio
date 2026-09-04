import { classifyDesbloqueioCandidate, type DesbloqueioIssueInput } from "./scripts/lib/desbloqueia-scan.ts";
import { formatExecutionBlockMarker } from "./scripts/lib/issue-decisions.ts";

function baseInput(overrides: Partial<DesbloqueioIssueInput> = {}): DesbloqueioIssueInput {
  return { number: 6504, title: "t", labels: ["external-blocker"], body: "corpo", state: "OPEN", updatedAt: "2026-09-01T00:00:00Z", comments: [], ...overrides };
}

// Post-#7270 marker (has `condicao`) — the format route-issue.ts actually emits today
const block = formatExecutionBlockMarker({
  recorded_at: "2026-09-01T20:16:42.541Z",
  motivo: "Postmaster Tools recusou news.diar.ia.br por volume acumulado insuficiente",
  sessao: "develop",
  condicao: { tipo: "externo", descricao: "aguardar mais semanas de envio" },
});

const r1 = classifyDesbloqueioCandidate(baseInput({ updatedAt: "2026-09-01T20:20:00Z", comments: [block] }));
console.log("exec1 (antes do comentario do Passo 2):", r1?.status);

const review = "Revisado por /diaria-desbloqueia — bloqueio de execucao de 2026-09-01T20:16:42Z (Postmaster Tools, volume acumulado insuficiente) segue valendo, nenhuma mudança.";
const r2 = classifyDesbloqueioCandidate(baseInput({ updatedAt: "2026-09-03T16:00:00Z", comments: [block, review] }));
console.log("exec2 (depois do comentario do Passo 2):", r2?.status);

// And: a NEW execution block posted after the review comment (state really changed) must still win
const newBlock = formatExecutionBlockMarker({
  recorded_at: "2026-09-04T00:00:00Z",
  motivo: "editor confirmou que o dominio foi aceito no Postmaster Tools",
  sessao: "develop",
  condicao: { tipo: "externo", descricao: "dominio aceito" },
});
const r3 = classifyDesbloqueioCandidate(baseInput({ updatedAt: "2026-09-04T00:01:00Z", comments: [block, review, newBlock] }));
console.log("exec3 (bloqueio REALMENTE renovado depois):", r3?.status);
