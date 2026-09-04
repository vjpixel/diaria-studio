import { classifyDesbloqueioCandidate, type DesbloqueioIssueInput } from "./scripts/lib/desbloqueia-scan.ts";
import { latestExecutionBlockFor } from "./scripts/lib/issue-decisions.ts";

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

// REAL marker from #6504 comment 14 (pre-#7270: no `condicao` field)
const realBlock = "<!-- bloqueio-execucao: eyJyZWNvcmRlZF9hdCI6IjIwMjYtMDktMDFUMjA6MTY6NDIuNTQxWiIsIm1vdGl2byI6IlVuaWNvIGl0ZW0gcmVzdGFudGUgZSBvIEdvb2dsZSBQb3N0bWFzdGVyIFRvb2xzLCBxdWUgcmVjdXNvdSBhZGljaW9uYXIgbmV3cy5kaWFyLmlhLmJyIGVtIDI4LzA4ICg0IHRlbnRhdGl2YXMpIHBvciB2b2x1bWUgYWN1bXVsYWRvIGluc3VmaWNpZW50ZS4gRGVwZW5kZSBkZSBtYWlzIHNlbWFuYXMgZGUgZW52aW8sIG5hbyBkZSBjb2RpZ28gbmVtIGRlIGRlY2lzYW8uIiwic2Vzc2FvIjoiZGV2ZWxvcCJ9 -->";

const block = latestExecutionBlockFor([realBlock]);
console.log("latestExecutionBlockFor(real marker):", block === null ? "null (MARKER IGNORED)" : JSON.stringify(block));

const r1 = classifyDesbloqueioCandidate(baseInput({ updatedAt: "2026-09-01T12:00:00Z", comments: [realBlock] }));
console.log("exec1 (before Passo-2 comment):", r1?.status);

const reviewComment = "Revisado por /diaria-desbloqueia (01/09/2026) — sem pergunta nova ao editor. IP compartilhado assumido, Postmaster Tools segue por volume insuficiente.";
const r2 = classifyDesbloqueioCandidate(baseInput({
  updatedAt: "2026-09-03T16:00:00Z",
  comments: [realBlock, reviewComment],
}));
console.log("exec2 (after Passo-2 comment):", r2?.status);
