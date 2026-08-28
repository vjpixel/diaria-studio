/**
 * stage4-decision.ts (#6447 Fatia 4, achado 7)
 *
 * Persiste a decisão "gate 4 aprovado" quando o editor clica "Aprovar gate"
 * no painel de Revisão do Studio (`rv-gate.js`), sem precisar aprovar pelo
 * terminal. Sentinel: `{editionDir}/_internal/.step-4-decision.json`.
 *
 * ESCOPO ORIGINALMENTE PARCIAL (documentado no PR body da Fatia 4, #6447):
 * este módulo nasceu cobrindo só a ESCRITA — o lado que LÊ este arquivo pra
 * de fato destravar o Stage 4 real é o playbook `orchestrator-stage-4.md`
 * (§4d, prosa lida pelo top-level, fora deste repo de código). Fechado no
 * #6444: `resolveStage4DecisionForConsumption` abaixo + o modo `--read`
 * (com `--content-files` opcional) do CLI no fim deste arquivo dão ao
 * orchestrator um jeito de checar a decisão do painel e, se ela ainda for
 * válida (ver freshness abaixo), pular a apresentação completa do resumo +
 * loop `sim/editar/ajustar/abortar` (§4d de `orchestrator-stage-4.md`) e ir
 * direto pra um único turno confirmando o veredito já dado no painel.
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

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule, parseArgs } from "./cli-args.ts";
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

export interface Stage4DecisionConsumption {
  /** `true` = o orchestrator pode tratar isto como equivalente a uma
   * resposta "sim" já dada pelo editor (via painel) e pular o resumo
   * completo + loop `sim/editar/ajustar/abortar` de §4d. */
  usable: boolean;
  /** Presente só quando `usable: false` — `"absent"` (nunca aprovado pelo
   * painel, ou shape inválido) ou `"stale"` (aprovado, mas o conteúdo
   * revisável mudou DEPOIS da aprovação — ver docstring abaixo). */
  reason?: "absent" | "stale";
  /** A decisão lida, mesmo quando `usable: false` por staleness (o caller
   * pode querer logar `decided_at` da decisão descartada). `null` quando
   * `reason === "absent"`. */
  decision: Stage4DecisionState | null;
}

/**
 * Decide se uma decisão gravada pelo painel (#6447 Fatia 4, achado 7) ainda
 * vale a pena ser consumida pelo gate real de `orchestrator-stage-4.md`
 * §4d — fecha a lacuna documentada no topo deste módulo e no PR #6517
 * (issue #6444, "reduzir o gate a um único turno de decisão").
 *
 * `usable: true` exige DOIS fatos: a decisão existe (`decision: "approved"`
 * com `decided_at` parseável) E foi tomada DEPOIS de toda mtime em
 * `contentMtimesMs` — os arquivos que o editor via no painel ao clicar
 * "Aprovar gate" (`02-reviewed.md`, `03-social.md`). Sem esse 2º check, um
 * cenário real quebraria silenciosamente: editor aprova no painel, o gate
 * cai no branch `editar` (ou é re-rodado do zero) e o conteúdo muda DEPOIS
 * da aprovação registrada — consumir a decisão velha aprovaria conteúdo que
 * o editor nunca viu. `stale` descarta a decisão e o caller cai de volta no
 * fluxo normal (resumo completo + `sim/editar/ajustar/abortar`).
 *
 * Puro/testável sem I/O (o caller resolve as mtimes via `statSync` antes de
 * chamar — ver o modo `--content-files` do CLI abaixo) — mesmo padrão de
 * `decideGateApproveAction` acima e de `resolveWideImageIntegrity`/
 * `resolveRatio` (`scripts/image-generate.ts`).
 */
export function resolveStage4DecisionForConsumption(
  decision: Stage4DecisionState | null,
  contentMtimesMs: number[],
): Stage4DecisionConsumption {
  if (!decision) return { usable: false, reason: "absent", decision: null };
  const decidedAtMs = Date.parse(decision.decided_at);
  if (Number.isNaN(decidedAtMs)) return { usable: false, reason: "absent", decision: null };
  const stale = contentMtimesMs.some((mtimeMs) => mtimeMs > decidedAtMs);
  if (stale) return { usable: false, reason: "stale", decision };
  return { usable: true, decision };
}

/**
 * Resolve a mtime (ms) de um content file pro freshness check acima,
 * distinguindo "arquivo genuinamente ausente" (ENOENT — caso normal, mtime
 * 0, nunca invalida a decisão por si só) de qualquer OUTRO erro de I/O
 * (EACCES, EPERM, EBUSY, lock transitório do Windows/OneDrive durante um
 * `Edit`/`Write` concorrente do orchestrator no mesmo arquivo) — esse
 * segundo caso é uma checagem que FALHOU, não uma confirmação de "arquivo
 * não mudou", e tratar os dois igual (retornando 0) permitiria que um erro
 * de leitura mascarasse silenciosamente um `editar` real que aconteceu
 * depois da aprovação, deixando uma decisão STALE passar como fresca e
 * pulando o gate humano por engano (achado do fleet review, #6444).
 * `Infinity` força `stale` em `resolveStage4DecisionForConsumption` (nunca
 * é `> ` que uma comparação vença — falha sempre pro lado seguro).
 *
 * `statFn` é injetável só pra teste (default = `statSync` real).
 */
export function resolveContentFileMtimeMs(
  path: string,
  statFn: (p: string) => { mtimeMs: number } = statSync,
): number {
  try {
    return statFn(path).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    console.error(
      `stage4-decision: falha ao checar mtime de ${path}: ${(err as Error).message} — tratando como possivelmente mais recente (fail-safe)`,
    );
    return Infinity;
  }
}

// CLI:
//   Leitura crua (imprime o JSON da decisão, ou `null` se ausente):
//     npx tsx scripts/lib/stage4-decision.ts --edition-dir <dir> --read
//   Leitura com freshness check (uso real em orchestrator-stage-4.md §4d) —
//   imprime {usable, reason?, decision} via resolveStage4DecisionForConsumption,
//   comparando decided_at contra a mtime de cada arquivo em --content-files
//   (lista separada por vírgula, caminhos relativos a --edition-dir; arquivo
//   ausente não invalida a decisão por si só — trata como "sem sinal", mtime 0):
//     npx tsx scripts/lib/stage4-decision.ts --edition-dir <dir> --read \
//       --content-files "02-reviewed.md,03-social.md"
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const editionDir = parsed.values["edition-dir"];
  if (!editionDir || !parsed.flags.has("read")) {
    console.error(
      'uso: stage4-decision.ts --edition-dir <dir> --read [--content-files "a.md,b.md"]',
    );
    process.exit(1);
  }
  const decision = readStage4Decision(editionDir);
  const contentFilesRaw = parsed.values["content-files"];
  if (!contentFilesRaw) {
    console.log(JSON.stringify(decision));
  } else {
    const mtimesMs = contentFilesRaw
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      .map((f) => resolveContentFileMtimeMs(resolve(editionDir, f)));
    console.log(JSON.stringify(resolveStage4DecisionForConsumption(decision, mtimesMs)));
  }
}
