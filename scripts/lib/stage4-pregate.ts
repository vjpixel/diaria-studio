/**
 * stage4-pregate.ts (#14034)
 *
 * Marcador do pré-gate da Etapa 4 rodado headless.
 *
 * **Para que serve.** Desde o #14034 o `/diaria-edicao` roda o pré-gate da
 * Etapa 4 (§4a–§4c de `orchestrator-stage-4.md`: pré-render, lints,
 * fact-check, resumo consolidado) num `claude -p` próprio, como já fazia com
 * as Etapas 1-3 (#5744), e a sessão do editor abre direto no gate (§4d). Na
 * 261126 o pré-gate levou a sessão de 181k para ~340k de contexto antes do
 * gate, e o loop do gate relia esse histórico a cada turno.
 *
 * O spawn headless termina gravando duas coisas em `_internal/`:
 *   - `04-pregate-summary.md`: os blocos do resumo que o §4c produz
 *     (lints, fact-check, boxes, refresh tardio etc.), que o gate lê do disco
 *     em vez de recomputar;
 *   - `.step-4-pregate.json` (este módulo): o marcador.
 *
 * **Snapshot do conteúdo (`snapshot`, depois da última autocorreção do
 * §4c).** O hash do conteúdo é tirado no `snapshot`, rodado logo depois do
 * §4c.6c (fact-check autofix + revalidação estrutural, a última etapa que
 * escreve no texto). O `write` compara com esse snapshot e RECUSA gravar o
 * marcador se algo mudou entre um e outro: mudança depois do snapshot é
 * mudança que o resumo pode não cobrir. Sem snapshot, também recusa.
 *
 * **O que entra no hash (`contentFiles`).** `02-reviewed.md`, `03-social.md`,
 * `01-eia.md`, `_internal/01-approved.json`, as imagens dos destaques e os
 * cards do carrossel (`04-d{N}-*.jpg|png` na raiz da edição) e as do É IA?
 * (`01-eia-*.jpg|png`). Qualquer mudança em um deles depois do pré-gate
 * deixa o marcador `stale`, e a sessão interativa cai no fluxo de antes
 * (§4a–§4c inline), em vez de mostrar ao editor um resumo de outra edição.
 *
 * **`blocking` sai do disco, não do LLM.** O `write` roda sozinho os checks
 * GATE-BLOCKING do pré-gate (`run-fact-checker.ts --check-blocking`,
 * `check-invariants.ts --stage 4`, `lint-newsletter-md.ts --stage 4 --json`
 * e os três `validate-*`) e preenche `blocking` pelo exit code de cada um.
 * O `--blocking` do playbook só soma motivos (ex.: halt banner); nunca é a
 * única fonte. Marcador com `blocking` não vazio não abre o gate direto: a
 * sessão interativa segue o fluxo inline, onde o playbook já trata cada
 * bloqueio com o editor presente.
 *
 * **Nada aqui aprova o gate.** O marcador não é sentinela de stage
 * (`.step-4-done.json` continua sendo escrito só no §4e, depois do `sim` do
 * editor). `pipeline-state.ts` não o conhece, e `find-current-edition.ts`
 * continua vendo a edição como "Stage 4 em curso".
 *
 * CLI:
 *   npx tsx scripts/lib/stage4-pregate.ts snapshot --edition-dir DIR
 *   npx tsx scripts/lib/stage4-pregate.ts write --edition-dir DIR [--blocking "motivo"]...
 *   npx tsx scripts/lib/stage4-pregate.ts check --edition-dir DIR
 *
 * `check` imprime `{ usable, reason, blocking, summary_path }` e sai 0 quando
 * `usable`, 1 quando não (ausente, corrompido, resumo ausente, defasado ou
 * bloqueado). `snapshot`/`write` saem 0 ao gravar e 2 em uso inválido ou
 * recusa (resumo ausente, snapshot ausente, conteúdo mudou desde o snapshot).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./cli-args.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Arquivos fixos de conteúdo cujo hash o marcador guarda. */
export const PREGATE_CONTENT_FILES = [
  "02-reviewed.md",
  "03-social.md",
  "01-eia.md",
  "_internal/01-approved.json",
] as const;

/** Imagens na raiz da edição: destaques + cards do carrossel (`04-d{N}-…`) e É IA? (`01-eia-…`). */
export const PREGATE_IMAGE_RE = /^(04-d\d[^/]*|01-eia-[^/]*)\.(jpe?g|png)$/i;

/** Resumo gravado pelo pré-gate, relativo ao diretório da edição. */
export const PREGATE_SUMMARY_REL = "_internal/04-pregate-summary.md";

/** Marcador, relativo ao diretório da edição. */
export const PREGATE_MARKER_REL = "_internal/.step-4-pregate.json";

/** Snapshot do conteúdo tirado depois da última autocorreção do §4c. */
export const PREGATE_SNAPSHOT_REL = "_internal/.step-4-pregate-snapshot.json";

export interface Stage4PregateMarker {
  version: 1;
  completed_at: string;
  summary_path: string;
  /** sha256 de cada arquivo de `contentFiles`; `null` = ausente. */
  content_hashes: Record<string, string | null>;
  /** Motivos que pedem o editor antes de montar o gate; vazio = sem bloqueio. */
  blocking: string[];
}

export type PregateCheckReason = "ok" | "absent" | "corrupt" | "summary_missing" | "stale" | "blocked";

export interface PregateCheck {
  /** `true` = a sessão interativa pode abrir direto no gate (§4d). */
  usable: boolean;
  reason: PregateCheckReason;
  /** `true` = o pré-gate terminou para o conteúdo atual (usable OU blocked). */
  completed: boolean;
  blocking: string[];
  summary_path: string;
  /** Arquivos cujo hash mudou depois do pré-gate (só com `reason: "stale"`). */
  changed_files?: string[];
}

function hashFile(p: string): string | null {
  if (!existsSync(p)) return null;
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** Lista relativa (ordenada) dos arquivos cobertos pelo hash. */
export function contentFiles(editionDir: string): string[] {
  let images: string[] = [];
  try {
    images = readdirSync(editionDir).filter((f) => PREGATE_IMAGE_RE.test(f));
  } catch {
    images = [];
  }
  return [...PREGATE_CONTENT_FILES, ...images.sort()];
}

export function currentContentHashes(editionDir: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of contentFiles(editionDir)) out[f] = hashFile(resolve(editionDir, f));
  return out;
}

/** Arquivos cujo hash difere entre dois mapas (união das chaves). */
export function changedFiles(a: Record<string, string | null>, b: Record<string, string | null>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => (a[k] ?? null) !== (b[k] ?? null));
}

export function markerPath(editionDir: string): string {
  return resolve(editionDir, PREGATE_MARKER_REL);
}

function writeJsonAtomic(p: string, data: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}

/** Grava o snapshot do conteúdo (rodar logo depois do §4c.6c). */
export function snapshotStage4Pregate(editionDir: string, now: () => Date = () => new Date()): Record<string, string | null> {
  const hashes = currentContentHashes(editionDir);
  writeJsonAtomic(resolve(editionDir, PREGATE_SNAPSHOT_REL), { taken_at: now().toISOString(), content_hashes: hashes });
  return hashes;
}

function readSnapshot(editionDir: string): Record<string, string | null> | null {
  const p = resolve(editionDir, PREGATE_SNAPSHOT_REL);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { content_hashes?: unknown };
    return j.content_hashes && typeof j.content_hashes === "object"
      ? (j.content_hashes as Record<string, string | null>)
      : null;
  } catch {
    return null;
  }
}

/** Resultado de um check determinístico rodado como processo filho. */
export interface CheckRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Roda `scripts/{script}` com os argumentos dados; injetável para teste. */
export type CheckRunner = (script: string, args: string[]) => CheckRun;

export const defaultCheckRunner: CheckRunner = (script, args) => {
  const r = spawnSync(process.execPath, ["--import", "tsx", resolve(REPO_ROOT, "scripts", script), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
};

/**
 * Checks GATE-BLOCKING do pré-gate, rodados pelo próprio `write`. Cada
 * motivo devolvido é um bloqueio; lista vazia = nenhum. Check que não
 * concluiu (crash, saída ilegível) também conta como bloqueio: na dúvida, a
 * sessão interativa refaz o pré-gate inline em vez de abrir o gate às cegas.
 */
export function deterministicBlocking(editionDir: string, run: CheckRunner = defaultCheckRunner): string[] {
  const dirArg = editionDir.endsWith("/") ? editionDir : `${editionDir}/`;
  const reviewed = resolve(editionDir, "02-reviewed.md");
  const out: string[] = [];

  // Fact-check (#4361/#11685): exit 2 = claim NOT_FOUND_IN_SOURCE; exit 1
  // DEFASADO = claim reescrito sem re-checagem. Exit 1 comum (fact-check
  // indisponível) não bloqueia, como no playbook.
  const fc = run("run-fact-checker.ts", [
    "--edition-dir",
    dirArg,
    "--input-json",
    resolve(editionDir, "_internal", "fact-check.json"),
    "--check-blocking",
  ]);
  if (fc.status === 2) out.push("fact-check GATE-BLOCKING: claim NOT_FOUND_IN_SOURCE (run-fact-checker.ts --check-blocking exit 2)");
  else if (fc.status === 1 && /FACT-CHECK DEFASADO/.test(fc.stderr + fc.stdout)) out.push("fact-check DEFASADO (#11685): re-checar antes do gate");
  else if (fc.status !== 0 && fc.status !== 1) out.push(`fact-check não concluiu (exit ${fc.status})`);

  const inv = run("check-invariants.ts", ["--stage", "4", "--edition-dir", dirArg]);
  if (inv.status !== 0) out.push(`check-invariants --stage 4 saiu ${inv.status}`);

  const lint = run("lint-newsletter-md.ts", ["--stage", "4", "--json", "--edition-dir", editionDir]);
  let parsed: { passed?: unknown; checks?: Array<{ id?: unknown; severity?: unknown; ok?: unknown }> } | null = null;
  try {
    parsed = JSON.parse(lint.stdout);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed.passed !== "boolean") {
    out.push(`lint-newsletter-md --stage 4 sem JSON legível (exit ${lint.status})`);
  } else if (parsed.passed === false) {
    const ids = (parsed.checks ?? [])
      .filter((c) => c.ok === false && c.severity === "gate-blocking")
      .map((c) => String(c.id));
    out.push(`lint-newsletter-md GATE-BLOCKING: ${ids.length > 0 ? ids.join(", ") : "passed=false"}`);
  }

  for (const [script, extra] of [
    ["validate-lancamentos.ts", []],
    ["validate-domain-diversity.ts", []],
    ["validate-amazon-affiliate-tags.ts", ["--audience", "diaria"]],
  ] as const) {
    const r = run(script, [reviewed, ...extra]);
    if (r.status !== 0) out.push(`${script} saiu ${r.status}`);
  }
  return out;
}

/**
 * Grava o marcador. Lança (sem gravar) se: o resumo não existe ou está
 * vazio; não há snapshot; o conteúdo mudou desde o snapshot (antes OU durante
 * os checks). `blocking` = checks determinísticos + `opts.blocking`.
 */
export function writeStage4Pregate(
  editionDir: string,
  opts: { blocking?: string[]; now?: () => Date; runCheck?: CheckRunner } = {},
): Stage4PregateMarker {
  const summaryAbs = resolve(editionDir, PREGATE_SUMMARY_REL);
  if (!existsSync(summaryAbs) || readFileSync(summaryAbs, "utf8").trim() === "") {
    throw new Error(`resumo do pré-gate ausente ou vazio: ${summaryAbs}`);
  }
  const snap = readSnapshot(editionDir);
  if (!snap) {
    throw new Error(`snapshot do conteúdo ausente: rode \`stage4-pregate.ts snapshot\` depois da última autocorreção do §4c`);
  }
  const before = currentContentHashes(editionDir);
  const drift = changedFiles(snap, before);
  if (drift.length > 0) {
    throw new Error(`conteúdo mudou depois do snapshot (${drift.join(", ")}): o resumo pode não cobrir essa mudança`);
  }
  const blocking = [
    ...deterministicBlocking(editionDir, opts.runCheck),
    ...(opts.blocking ?? []).map((b) => b.trim()).filter((b) => b !== ""),
  ];
  const after = currentContentHashes(editionDir);
  const driftDuring = changedFiles(before, after);
  if (driftDuring.length > 0) {
    throw new Error(`conteúdo mudou durante os checks (${driftDuring.join(", ")})`);
  }
  const marker: Stage4PregateMarker = {
    version: 1,
    completed_at: (opts.now ?? (() => new Date()))().toISOString(),
    summary_path: PREGATE_SUMMARY_REL,
    content_hashes: after,
    blocking,
  };
  writeJsonAtomic(markerPath(editionDir), marker);
  return marker;
}

function parseMarker(raw: string): Stage4PregateMarker | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const m = j as Partial<Stage4PregateMarker>;
  if (m.version !== 1 || typeof m.completed_at !== "string") return null;
  if (!m.content_hashes || typeof m.content_hashes !== "object") return null;
  if (!Array.isArray(m.blocking) || !m.blocking.every((b) => typeof b === "string")) return null;
  return {
    version: 1,
    completed_at: m.completed_at,
    summary_path: typeof m.summary_path === "string" ? m.summary_path : PREGATE_SUMMARY_REL,
    content_hashes: m.content_hashes as Record<string, string | null>,
    blocking: m.blocking,
  };
}

/**
 * Diz se a sessão interativa pode abrir direto no gate. Nunca lança: erro de
 * leitura vira `corrupt`, e qualquer `usable: false` leva ao fluxo inline.
 */
export function checkStage4Pregate(editionDir: string): PregateCheck {
  const base = { blocking: [] as string[], summary_path: PREGATE_SUMMARY_REL };
  const p = markerPath(editionDir);
  if (!existsSync(p)) return { ...base, usable: false, completed: false, reason: "absent" };
  let marker: Stage4PregateMarker | null;
  try {
    marker = parseMarker(readFileSync(p, "utf8"));
  } catch {
    marker = null;
  }
  if (!marker) return { ...base, usable: false, completed: false, reason: "corrupt" };
  const changed = changedFiles(marker.content_hashes, currentContentHashes(editionDir));
  if (changed.length > 0) {
    return {
      ...base,
      blocking: marker.blocking,
      summary_path: marker.summary_path,
      usable: false,
      completed: false,
      reason: "stale",
      changed_files: changed,
    };
  }
  if (!existsSync(resolve(editionDir, marker.summary_path))) {
    return { ...base, summary_path: marker.summary_path, usable: false, completed: false, reason: "summary_missing" };
  }
  if (marker.blocking.length > 0) {
    return { ...base, blocking: marker.blocking, summary_path: marker.summary_path, usable: false, completed: true, reason: "blocked" };
  }
  return { ...base, summary_path: marker.summary_path, usable: true, completed: true, reason: "ok" };
}

const USAGE =
  "Uso: stage4-pregate.ts snapshot --edition-dir DIR\n" +
  "     stage4-pregate.ts write --edition-dir DIR [--blocking \"motivo\"]...\n" +
  "     stage4-pregate.ts check --edition-dir DIR";

/** CLI. `--blocking` pode repetir; por isso não usa o `parseArgs` comum. */
export function main(
  argv: string[],
  out: (s: string) => void = console.log,
  err: (s: string) => void = console.error,
  runCheck: CheckRunner = defaultCheckRunner,
): number {
  const [sub, ...rest] = argv;
  let editionDir: string | null = null;
  const blocking: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const v = rest[i + 1];
    if ((a === "--edition-dir" || a === "--blocking") && (v === undefined || v.startsWith("--"))) {
      err(`${a} exige valor.\n${USAGE}`);
      return 2;
    }
    if (a === "--edition-dir") {
      editionDir = v;
      i++;
    } else if (a === "--blocking") {
      blocking.push(v);
      i++;
    } else {
      err(`argumento desconhecido: ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (!editionDir || (sub !== "write" && sub !== "check" && sub !== "snapshot")) {
    err(USAGE);
    return 2;
  }
  if (blocking.length > 0 && sub !== "write") {
    err(`--blocking só vale com write.\n${USAGE}`);
    return 2;
  }
  if (sub === "snapshot") {
    const h = snapshotStage4Pregate(editionDir);
    out(JSON.stringify({ written: PREGATE_SNAPSHOT_REL, files: Object.keys(h).length }));
    return 0;
  }
  if (sub === "write") {
    try {
      const m = writeStage4Pregate(editionDir, { blocking, runCheck });
      out(JSON.stringify({ written: PREGATE_MARKER_REL, blocking: m.blocking }));
      return 0;
    } catch (e) {
      err(`[stage4-pregate] ${(e as Error).message}`);
      return 2;
    }
  }
  const c = checkStage4Pregate(editionDir);
  out(JSON.stringify(c));
  return c.usable ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
