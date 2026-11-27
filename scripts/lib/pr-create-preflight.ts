/**
 * scripts/lib/pr-create-preflight.ts (#14216)
 *
 * Decisão pura do guard de `gh pr create` que confere, ANTES de a PR existir,
 * as duas regras que a medição da #14120 achou ignoradas em 5 ciclos de
 * `dev-fixer`:
 *
 * - `docs/editorial-invariants.md` em dia com o registry de invariantes
 *   (item 13 de `context/overnight-dispatch-rules.md`, travado em CI por
 *   `test/list-invariants.test.ts`);
 * - `removal-declaration:` no corpo quando o diff passa do limiar de adições
 *   (item 29, gate `check-pr-removal-declaration.ts` no CI, #7115).
 *
 * O hook `.claude/hooks/block-pr-create-preflight.mjs` lê o comando e o corpo;
 * o CLI `scripts/check-pr-create-preflight.ts` mede o diff, gera o markdown
 * das invariantes e chama `decidePrCreatePreflight`. Este módulo não faz I/O.
 *
 * Direção de falha: só nega o que o CI reprovaria com certeza (documento
 * divergente; corpo LIDO sem a declaração com o diff acima do limiar). O que
 * não dá para conferir daqui (corpo montado por expansão de shell, `--fill`,
 * diff não medido, registry que não carregou) vira aviso, nunca recusa.
 */
import type { DiffLineStats } from "./diff-line-stats.ts";
import {
  REMOVAL_DECLARATION_ADDED_LINES_THRESHOLD,
  evaluateRemovalDeclaration,
  missingRemovalDeclarationMessage,
  needsRemovalDeclaration,
  type RemovalDeclarationEvaluation,
} from "./pr-removal-declaration.ts";

export const INVARIANTS_DOC_PATH = "docs/editorial-invariants.md";
export const REGENERATE_INVARIANTS_COMMAND = `npx tsx scripts/list-invariants.ts --out ${INVARIANTS_DOC_PATH}`;

export type InvariantsDocStatus =
  | { status: "ok" }
  | { status: "stale" }
  | { status: "missing" }
  | { status: "unavailable"; detail: string };

/** Pura: compara o markdown gerado com o commitado (mesma regra do `--check`: aparado). */
export function compareInvariantsDoc(generated: string, committed: string | null): InvariantsDocStatus {
  if (committed === null) return { status: "missing" };
  return committed.trim() === generated.trim() ? { status: "ok" } : { status: "stale" };
}

export interface PrCreatePreflightInput {
  invariants: InvariantsDocStatus;
  /** Diff da branch contra o merge-base; `null` = não medido (`statsError` diz por quê). */
  stats: DiffLineStats | null;
  statsError?: string | null;
  /** Corpo da PR; `null` = não determinável antes de rodar (`bodyUnknownReason`). */
  body: string | null;
  bodyUnknownReason?: string | null;
  threshold?: number;
}

export interface PrCreatePreflightResult {
  deny: string[];
  warn: string[];
  removal: RemovalDeclarationEvaluation | null;
}

/** Pura: o que negar e o que só avisar no `gh pr create`. */
export function decidePrCreatePreflight(input: PrCreatePreflightInput): PrCreatePreflightResult {
  const deny: string[] = [];
  const warn: string[] = [];
  const threshold = input.threshold ?? REMOVAL_DECLARATION_ADDED_LINES_THRESHOLD;

  const inv = input.invariants;
  if (inv.status === "stale" || inv.status === "missing") {
    deny.push(
      `[#4877] ${INVARIANTS_DOC_PATH} ${inv.status === "stale" ? "divergiu do registry de invariantes" : "não existe"} ` +
        `(o CI reprova em test/list-invariants.test.ts). Regenere e commite antes de abrir a PR:\n  ${REGENERATE_INVARIANTS_COMMAND}`,
    );
  } else if (inv.status === "unavailable") {
    warn.push(`[#14216] ${INVARIANTS_DOC_PATH} não conferido (${inv.detail}): rode ${REGENERATE_INVARIANTS_COMMAND.replace("--out", "--check")} antes do push`);
  }

  let removal: RemovalDeclarationEvaluation | null = null;
  if (!input.stats) {
    warn.push(`[#14216] diff não medido (${input.statsError ?? "motivo desconhecido"}): confira à mão se a PR passa de ${threshold} adições e precisa de removal-declaration:`);
  } else if (input.body === null) {
    if (needsRemovalDeclaration(input.stats.added, threshold)) {
      warn.push(
        `[#7115] a PR adiciona ${input.stats.added} linhas (limiar: ${threshold}) e o corpo não pôde ser lido antes de rodar ` +
          `(${input.bodyUnknownReason ?? "corpo não determinável"}). Se ele não tiver a linha removal-declaration:, o CI reprova; ` +
          "use --body-file com um arquivo, ou --body-file - com heredoc, para o guard conferir",
      );
    }
  } else {
    removal = evaluateRemovalDeclaration(input.stats, input.body, threshold);
    if (removal.status === "missing") deny.push(missingRemovalDeclarationMessage(removal));
  }
  return { deny, warn, removal };
}
