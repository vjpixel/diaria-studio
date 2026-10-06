/**
 * scripts/lib/orchestrator-snapshot.ts (#9709)
 *
 * Formato e comparação do snapshot de `test/orchestrator-prompt.test.ts`
 * (#634 frente C), guardado em `test/__snapshots__/orchestrator-prompt.snap.json`.
 *
 * Até o #9709 o snapshot guardava UM hash agregado de todos os playbooks
 * (+ `file_sizes` + `updated_at`). Toda PR que mexia em qualquer
 * `orchestrator-stage-*.md` reescrevia as mesmas linhas, e PRs concorrentes
 * (overnight/develop em onda) conflitavam no `.snap.json` mesmo tocando
 * playbooks diferentes — cada conflito custava juntar master, regenerar e
 * mais um ciclo de CI (2× na PR #9684).
 *
 * Formato v2: uma entrada por playbook, numa linha só, separada das vizinhas
 * por uma linha em branco. O `git merge` só conflita quando as mudanças se
 * sobrepõem ou ficam em linhas ADJACENTES; com a linha em branco no meio, PRs
 * que mudam playbooks diferentes mexem em linhas não adjacentes e o merge sai
 * limpo. Toda entrada termina com vírgula porque há uma chave de rodapé fixa
 * (`_regenerar`) depois da última — então acrescentar ou mudar a última entrada
 * nunca muda a pontuação da entrada anterior. Sem `updated_at`: um carimbo de
 * tempo global mudaria em toda regeneração e devolveria o conflito.
 *
 * Puro (sem I/O): o teste lê os arquivos e grava o snapshot.
 */

import { createHash } from "node:crypto";

/** Comando único de regeneração, citado na mensagem de erro e no rodapé do arquivo. */
export const SNAPSHOT_UPDATE_COMMAND =
  "NODE_TEST_SNAPSHOTS=1 npx tsx --test test/orchestrator-prompt.test.ts";

export const SNAPSHOT_FORMAT = "orchestrator-prompt-snapshot/v2";

export interface SnapshotEntry {
  /** sha256 (16 hex) do conteúdo do playbook, CRLF normalizado pra LF. */
  hash: string;
  /** `content.split("\n").length`, mesma contagem do orçamento de linhas. */
  lines: number;
}

export type OrchestratorSnapshot = Record<string, SnapshotEntry>;

/** Normaliza CRLF → LF antes de hashear: Windows grava CRLF, CI usa LF. */
function normalize(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/** Entrada de UM playbook: depende só do conteúdo dele (nunca dos outros). */
export function computeFileEntry(content: string): SnapshotEntry {
  const normalized = normalize(content);
  return {
    hash: createHash("sha256").update(normalized).digest("hex").slice(0, 16),
    lines: normalized.split("\n").length,
  };
}

/** Snapshot completo, na ordem de `files`. */
export function buildSnapshot(
  files: readonly string[],
  contents: Record<string, string>,
): OrchestratorSnapshot {
  const snap: OrchestratorSnapshot = {};
  for (const file of files) snap[file] = computeFileEntry(contents[file]);
  return snap;
}

/**
 * Serializa no formato v2 (ver docblock). JSON válido: linhas em branco são
 * whitespace pro `JSON.parse`.
 */
export function serializeSnapshot(files: readonly string[], snap: OrchestratorSnapshot): string {
  const lines: string[] = ["{"];
  lines.push(`  "_formato": ${JSON.stringify(`${SNAPSHOT_FORMAT} (#9709): uma entrada por playbook, separadas por linha em branco para PRs em playbooks diferentes não conflitarem`)},`);
  for (const file of files) {
    const entry = snap[file];
    lines.push("");
    lines.push(`  ${JSON.stringify(file)}: { "hash": ${JSON.stringify(entry.hash)}, "lines": ${entry.lines} },`);
  }
  lines.push("");
  lines.push(`  "_regenerar": ${JSON.stringify(SNAPSHOT_UPDATE_COMMAND)}`);
  lines.push("}");
  return lines.join("\n") + "\n";
}

/**
 * Lê o snapshot. Formato legado (hash agregado, pré-#9709) ou JSON inválido
 * devolvem `{}` — toda entrada aparece como faltante e o teste pede a
 * regeneração, em vez de quebrar com erro de parse.
 */
export function parseSnapshot(raw: string): OrchestratorSnapshot {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
  const snap: OrchestratorSnapshot = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key.startsWith("_")) continue;
    if (value === null || typeof value !== "object") continue;
    const { hash, lines } = value as Record<string, unknown>;
    if (typeof hash === "string" && typeof lines === "number") snap[key] = { hash, lines };
  }
  return snap;
}

export interface SnapshotDiff {
  /** Playbooks cujo hash mudou. */
  changed: Array<{ file: string; from: string; to: string }>;
  /** Playbooks sem entrada no snapshot (arquivo novo ou snapshot legado). */
  missing: string[];
  /** Entradas no snapshot sem playbook correspondente em `files`. */
  extra: string[];
}

export function diffSnapshot(
  files: readonly string[],
  expected: OrchestratorSnapshot,
  actual: OrchestratorSnapshot,
): SnapshotDiff {
  const changed: SnapshotDiff["changed"] = [];
  const missing: string[] = [];
  for (const file of files) {
    const prev = expected[file];
    if (!prev) missing.push(file);
    else if (prev.hash !== actual[file].hash) changed.push({ file, from: prev.hash, to: actual[file].hash });
  }
  const known = new Set(files);
  const extra = Object.keys(expected).filter((k) => !known.has(k));
  return { changed, missing, extra };
}

export function isCleanDiff(diff: SnapshotDiff): boolean {
  return diff.changed.length === 0 && diff.missing.length === 0 && diff.extra.length === 0;
}

/** Mensagem de falha: diz QUAIS playbooks divergem e o comando exato pra regenerar. */
export function formatSnapshotFailure(diff: SnapshotDiff): string {
  const out: string[] = ["Snapshot do orchestrator desatualizado (test/__snapshots__/orchestrator-prompt.snap.json):"];
  for (const c of diff.changed) out.push(`  - ${c.file}: hash mudou (${c.from} → ${c.to})`);
  for (const f of diff.missing) out.push(`  - ${f}: sem entrada no snapshot`);
  for (const f of diff.extra) out.push(`  - ${f}: entrada no snapshot sem playbook correspondente`);
  out.push("");
  out.push("Se a mudança é intencional, regenere o snapshot e commite o .snap.json:");
  out.push(`  ${SNAPSHOT_UPDATE_COMMAND}`);
  out.push("(Conflito de merge no .snap.json: aceite qualquer lado e rode o mesmo comando.)");
  return out.join("\n");
}
