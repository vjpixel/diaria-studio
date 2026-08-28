/**
 * stage4-decision.ts (#6447 Fatia 4, achado 7)
 *
 * Persiste a decisão "gate 4 aprovado" quando o editor clica "Aprovar gate"
 * no painel de Revisão do Studio (`rv-gate.js`), sem precisar aprovar pelo
 * terminal. Sentinel: `{editionDir}/_internal/.step-4-decision.json`.
 *
 * ESCOPO INTENCIONALMENTE PARCIAL (documentado no PR body da Fatia 4, não
 * esquecimento): este módulo cobre só a ESCRITA. O lado que LERIA este
 * arquivo pra de fato destravar o Stage 4 real é o playbook
 * `orchestrator-stage-4.md` (§4d, prosa lida pelo top-level, fora deste
 * repo de código) — mudar esse consumo está fora do escopo desta fatia, que
 * é só o painel do Studio. Até esse consumo existir, clicar "Aprovar gate"
 * grava um REGISTRO da decisão (auditável, sobrevive a reload da página),
 * mas a sessão de terminal que está rodando `/diaria-4-revisao` ainda
 * precisa ver o resultado e prosseguir manualmente — não é um "auto-approve"
 * de ponta a ponta.
 *
 * Formato do sentinel — `{decision, decided_at, decided_via}` — não é o
 * mesmo shape de `pipeline-state.ts` (`StepSentinel: {step, completed_at,
 * outputs}`), de propósito: `.step-4-decision.json` registra uma DECISÃO
 * humana (o quê foi decidido, quando, por qual canal), não a conclusão
 * mecânica de um stage (que outputs existem). Reusa, sim, a mesma disciplina
 * de escrita atômica (lock + tmp + rename) de `stage4-capture-state.ts`
 * (#5414) — dois arquivos irmãos do mesmo `_internal/`, mesmo risco de
 * escrita concorrente (editor clica 2× rápido, ou um retry de rede).
 *
 * Fail-soft na leitura — mesmo padrão de `stage4-capture-state.ts`/
 * `studio-gate.ts`: arquivo ausente é o caso normal (gate ainda não
 * aprovado pelo painel), erro de FS real ou JSON corrompido são logados e
 * tratados como "ausente" (nunca lança).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { acquireLock, releaseLock } from "./file-lock.ts";

export type Stage4Decision = "approved";

export interface Stage4DecisionState {
  decision: Stage4Decision;
  /** ISO — quando o editor clicou "Aprovar gate". */
  decided_at: string;
  /** Canal que gravou a decisão — hoje só "studio" existe (único caller). */
  decided_via: "studio";
}

function decisionPath(editionDir: string): string {
  return resolve(editionDir, "_internal", ".step-4-decision.json");
}

/** `null` = ausente (nunca aprovado pelo painel ainda) ou shape inesperado —
 * nunca lança. */
export function readStage4Decision(editionDir: string): Stage4DecisionState | null {
  const p = decisionPath(editionDir);
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    console.error(`stage4-decision: falha ao ler ${p}: ${(err as Error).message} — tratando como ausente`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Stage4DecisionState>;
    if (parsed.decision !== "approved" || typeof parsed.decided_at !== "string") {
      console.error(`stage4-decision: shape inesperado em ${p} — tratando como ausente`);
      return null;
    }
    return { decision: "approved", decided_at: parsed.decided_at, decided_via: "studio" };
  } catch (err) {
    console.error(`stage4-decision: JSON inválido em ${p}: ${(err as Error).message} — tratando como ausente`);
    return null;
  }
}

/**
 * Grava a decisão "approved" — sempre sobrescreve (o guard de "já aprovado,
 * confirmar antes de sobrescrever" é responsabilidade do CALLER via
 * `decideGateApproveAction` abaixo, não desta função de escrita em si, mesmo
 * split de responsabilidade entre "decidir a ação" (pura, testável sem I/O)
 * e "executar a ação" que `resolveWideImageIntegrity`/`resolveRatio`
 * (image-generate.ts) já usam neste repo).
 */
export function writeStage4ApprovedDecision(
  editionDir: string,
  opts: { now?: () => Date } = {},
): Stage4DecisionState {
  const now = opts.now ?? (() => new Date());
  const p = decisionPath(editionDir);
  mkdirSync(dirname(p), { recursive: true });
  const lockPath = p + ".lock";
  acquireLock(lockPath);
  try {
    const state: Stage4DecisionState = {
      decision: "approved",
      decided_at: now().toISOString(),
      decided_via: "studio",
    };
    const tmpPath = p + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
    renameSync(tmpPath, p);
    return state;
  } finally {
    releaseLock(lockPath);
  }
}

export type GateApproveAction =
  | { kind: "write" }
  | { kind: "conflict"; existing: Stage4DecisionState };

/**
 * Decide se um clique em "Aprovar gate" deve gravar direto ou parar num
 * conflito (já aprovado antes, sem `force`) — extraído pra ser testável sem
 * tocar disco, mesmo padrão de `resolveWideImageIntegrity`/`resolveRatio`
 * (`scripts/image-generate.ts`). `force: true` sempre escreve (o editor já
 * confirmou o dialog no client — mesmo contrato de `force` em
 * `saveReviewFile`/`applyHighlightBlockEdit`, #3729).
 */
export function decideGateApproveAction(
  existing: Stage4DecisionState | null,
  force: boolean,
): GateApproveAction {
  if (existing && existing.decision === "approved" && !force) {
    return { kind: "conflict", existing };
  }
  return { kind: "write" };
}
