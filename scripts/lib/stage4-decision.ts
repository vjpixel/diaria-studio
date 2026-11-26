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

import { createHash } from "node:crypto";
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
  /** #14134: sha256 de cada arquivo de `GATE_CONTENT_FILES` COMO O PAINEL OS
   * MOSTROU ao editor (o `GET .../gate` que carregou a aba devolve estes
   * hashes e o clique em "Aprovar gate" os manda de volta). `null` no valor =
   * o arquivo não existia quando o painel carregou. O consumidor exige que os
   * hashes atuais batam: a mtime sozinha só protege quando escrita e clique
   * acontecem no mesmo host (`data/` sincroniza pelo Drive entre máquinas, e
   * o Studio pode estar servindo a versão anterior). Ausente = decisão
   * gravada antes do #14134, que o consumo trata como `stale` (fail-safe). */
  content_hashes?: GateContentHashes;
}

/** #14134: arquivos cujo conteúdo a aprovação do painel cobre — os mesmos
 * que `orchestrator-stage-4-gate.md` §4d passa em `--content-files`. */
export const GATE_CONTENT_FILES: readonly string[] = ["02-reviewed.md", "03-social.md"];

/** Nome do arquivo (relativo à edição) → sha256 hex, ou `null` se ausente. */
export type GateContentHashes = Record<string, string | null>;

/** Marcador de hash para arquivo que existe mas não pôde ser lido (erro de
 * FS não-ENOENT). Nunca bate com um sha256 real nem com `null`, então a
 * comparação falha pro lado seguro. */
export const UNREADABLE_CONTENT_HASH = "<ilegivel>";

/** sha256 hex do arquivo; `null` se ausente (ENOENT). Qualquer outro erro de
 * FS vira `UNREADABLE_CONTENT_HASH` (logado), nunca `null`: um arquivo que
 * não deu pra ler não pode passar por "não existia". `readFn` é injetável só
 * pra teste. */
export function hashGateContentFile(
  path: string,
  readFn: (p: string) => Buffer = (p) => readFileSync(p),
): string | null {
  try {
    return createHash("sha256").update(readFn(path)).digest("hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.error(
      `stage4-decision: falha ao ler ${path} para o hash do gate: ${(err as Error).message} — tratando como divergente (fail-safe)`,
    );
    return UNREADABLE_CONTENT_HASH;
  }
}

/** Hashes atuais em disco de `files` (default `GATE_CONTENT_FILES`). */
export function computeGateContentHashes(
  editionDir: string,
  files: readonly string[] = GATE_CONTENT_FILES,
): GateContentHashes {
  const out: GateContentHashes = {};
  for (const f of files) out[f] = hashGateContentFile(resolve(editionDir, f));
  return out;
}

/** Valida um `content_hashes` vindo de fora (corpo da request, JSON do
 * sentinel). `null` = ausente ou shape inválido. */
export function parseGateContentHashes(raw: unknown): GateContentHashes | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: GateContentHashes = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v !== null && typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

/** Arquivos de `files` cujo hash em `current` difere do que o painel mostrou
 * (`shown`). Arquivo sem entrada em `shown` conta como mudado (o painel não
 * mostrou essa versão), inclusive o que passou a existir depois. Puro. */
export function changedGateContentFiles(
  shown: GateContentHashes | null,
  current: GateContentHashes,
  files: readonly string[] = GATE_CONTENT_FILES,
): string[] {
  return files.filter((f) => {
    if (!shown || !Object.prototype.hasOwnProperty.call(shown, f)) return true;
    const cur = current[f] ?? null;
    if (cur === UNREADABLE_CONTENT_HASH) return true;
    return shown[f] !== cur;
  });
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
    const state: Stage4DecisionState = { decision: "approved", decided_at: parsed.decided_at, decided_via: "studio" };
    const hashes = parseGateContentHashes(parsed.content_hashes);
    if (hashes) state.content_hashes = hashes;
    return state;
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
  opts: { now?: () => Date; contentHashes?: GateContentHashes } = {},
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
    if (opts.contentHashes) state.content_hashes = { ...opts.contentHashes };
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
  | { kind: "conflict"; existing: Stage4DecisionState }
  | { kind: "content_changed"; files: string[] };

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
  /** #14134: saída de `changedGateContentFiles` — arquivos que mudaram em
   * disco desde que o painel carregou. Não vazio = recusa, mesmo com
   * `force` (o `force` confirma só a re-aprovação, nunca conteúdo que o
   * painel não mostrou). */
  changedFiles: readonly string[] = [],
): GateApproveAction {
  if (changedFiles.length > 0) return { kind: "content_changed", files: [...changedFiles] };
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
  /** #14134: por que a decisão ficou `stale` — `content_hash` (hash atual
   * difere do que o painel mostrou), `no_content_hashes` (decisão sem
   * hashes, gravada antes do #14134 — não dá pra verificar) ou `mtime`. */
  stale_cause?: "content_hash" | "no_content_hashes" | "mtime";
  /** Arquivos com hash divergente (só com `stale_cause: "content_hash"`). */
  changed_files?: string[];
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
  /** #14134: hashes atuais em disco dos content files (`computeGateContentHashes`).
   * Quando passado, é o critério principal: cada arquivo precisa bater com o
   * hash que o painel mostrou (`decision.content_hashes`); decisão sem hashes
   * é `stale`. A mtime continua como sinal adicional. Omitido = só mtime
   * (comportamento anterior ao #14134). */
  currentContentHashes?: GateContentHashes,
): Stage4DecisionConsumption {
  if (!decision) return { usable: false, reason: "absent", decision: null };
  const decidedAtMs = Date.parse(decision.decided_at);
  if (Number.isNaN(decidedAtMs)) return { usable: false, reason: "absent", decision: null };
  if (currentContentHashes) {
    if (!decision.content_hashes) {
      return { usable: false, reason: "stale", stale_cause: "no_content_hashes", decision };
    }
    const changed = changedGateContentFiles(
      decision.content_hashes,
      currentContentHashes,
      Object.keys(currentContentHashes),
    );
    if (changed.length > 0) {
      return { usable: false, reason: "stale", stale_cause: "content_hash", changed_files: changed, decision };
    }
  }
  const stale = contentMtimesMs.some((mtimeMs) => mtimeMs > decidedAtMs);
  if (stale) return { usable: false, reason: "stale", stale_cause: "mtime", decision };
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
//   Leitura com freshness check (uso real em orchestrator-stage-4-gate.md §4d) —
//   imprime {usable, reason?, decision} via resolveStage4DecisionForConsumption,
//   comparando o sha256 atual de cada arquivo em --content-files com o hash
//   que o painel mostrou ao editor (`content_hashes` da decisão, #14134) e
//   decided_at contra a mtime de cada um (lista separada por vírgula, caminhos
//   relativos a --edition-dir; arquivo ausente só é válido se também estava
//   ausente quando o painel carregou — hash `null` dos dois lados):
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
    const contentFiles = contentFilesRaw
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    const mtimesMs = contentFiles.map((f) => resolveContentFileMtimeMs(resolve(editionDir, f)));
    const hashes = computeGateContentHashes(editionDir, contentFiles);
    console.log(JSON.stringify(resolveStage4DecisionForConsumption(decision, mtimesMs, hashes)));
  }
}
