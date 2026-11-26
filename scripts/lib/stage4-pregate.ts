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
 *   - `.step-4-pregate.json` (este módulo): o marcador, com o hash de
 *     `02-reviewed.md` e `03-social.md` no momento em que o resumo foi escrito.
 *
 * **Por que hash.** O resumo descreve um conteúdo. Se o editor (ou outra
 * sessão) mexer em `02-reviewed.md`/`03-social.md` depois do pré-gate, os
 * lints e o fact-check do resumo deixam de valer para o texto atual. Nesse
 * caso o marcador é `stale` e a sessão interativa cai no fluxo de antes
 * (§4a–§4c inline), em vez de apresentar ao editor um resumo de outro texto.
 *
 * **`blocking`.** Quando o pré-gate esbarra numa condição que pede o editor
 * (fact-check exit 2 que não se resolveu, invariante que manda pausar), ele
 * grava o motivo e para. Remetente novo a aprovar não entra aqui: a pergunta
 * fica para o gate. O marcador com `blocking` não vazio também não abre o gate
 * direto: a sessão interativa segue o fluxo inline, onde o playbook já sabe
 * tratar cada bloqueio com o editor presente.
 *
 * **Nada aqui aprova o gate.** O marcador não é sentinela de stage
 * (`.step-4-done.json` continua sendo escrito só no §4e, depois do `sim` do
 * editor). `pipeline-state.ts` não o conhece, e `find-current-edition.ts`
 * continua vendo a edição como "Stage 4 em curso".
 *
 * CLI:
 *   npx tsx scripts/lib/stage4-pregate.ts write --edition-dir DIR [--blocking "motivo"]...
 *   npx tsx scripts/lib/stage4-pregate.ts check --edition-dir DIR
 *
 * `check` imprime `{ usable, reason, blocking, summary_path }` e sai 0 quando
 * `usable`, 1 quando não (ausente, corrompido, resumo ausente, defasado ou
 * bloqueado). `write` sai 0 ao gravar, 2 em uso inválido/resumo ausente.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule } from "./cli-args.ts";

/** Arquivos de conteúdo cujo hash o marcador guarda. */
export const PREGATE_CONTENT_FILES = ["02-reviewed.md", "03-social.md"] as const;

/** Resumo gravado pelo pré-gate, relativo ao diretório da edição. */
export const PREGATE_SUMMARY_REL = "_internal/04-pregate-summary.md";

/** Marcador, relativo ao diretório da edição. */
export const PREGATE_MARKER_REL = "_internal/.step-4-pregate.json";

export interface Stage4PregateMarker {
  version: 1;
  completed_at: string;
  summary_path: string;
  /** sha256 de cada arquivo de `PREGATE_CONTENT_FILES`; `null` = ausente. */
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

export function currentContentHashes(editionDir: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of PREGATE_CONTENT_FILES) out[f] = hashFile(resolve(editionDir, f));
  return out;
}

export function markerPath(editionDir: string): string {
  return resolve(editionDir, PREGATE_MARKER_REL);
}

/**
 * Grava o marcador. Lança se o resumo não existe ou está vazio: um marcador
 * sem resumo faria a sessão interativa abrir num gate sem lints nem
 * fact-check, que é pior que o fluxo inline.
 */
export function writeStage4Pregate(
  editionDir: string,
  opts: { blocking?: string[]; now?: () => Date } = {},
): Stage4PregateMarker {
  const summaryAbs = resolve(editionDir, PREGATE_SUMMARY_REL);
  if (!existsSync(summaryAbs) || readFileSync(summaryAbs, "utf8").trim() === "") {
    throw new Error(`resumo do pré-gate ausente ou vazio: ${summaryAbs}`);
  }
  const marker: Stage4PregateMarker = {
    version: 1,
    completed_at: (opts.now ?? (() => new Date()))().toISOString(),
    summary_path: PREGATE_SUMMARY_REL,
    content_hashes: currentContentHashes(editionDir),
    blocking: (opts.blocking ?? []).map((b) => b.trim()).filter((b) => b !== ""),
  };
  const p = markerPath(editionDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
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
  const now = currentContentHashes(editionDir);
  const changed = PREGATE_CONTENT_FILES.filter((f) => (marker.content_hashes[f] ?? null) !== now[f]);
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
  "Uso: stage4-pregate.ts write --edition-dir DIR [--blocking \"motivo\"]...\n" +
  "     stage4-pregate.ts check --edition-dir DIR";

/** CLI. `--blocking` pode repetir; por isso não usa o `parseArgs` comum. */
export function main(argv: string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
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
  if (!editionDir || (sub !== "write" && sub !== "check")) {
    err(USAGE);
    return 2;
  }
  if (sub === "write") {
    try {
      const m = writeStage4Pregate(editionDir, { blocking });
      out(JSON.stringify({ written: PREGATE_MARKER_REL, blocking: m.blocking }));
      return 0;
    } catch (e) {
      err(`[stage4-pregate] ${(e as Error).message}`);
      return 2;
    }
  }
  if (blocking.length > 0) {
    err(`--blocking só vale com write.\n${USAGE}`);
    return 2;
  }
  const c = checkStage4Pregate(editionDir);
  out(JSON.stringify(c));
  return c.usable ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
