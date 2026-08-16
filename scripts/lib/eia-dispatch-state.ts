/**
 * eia-dispatch-state.ts (#5414)
 *
 * Persiste o dispatch em background do `eia-compose.ts` (Stage 1, §1a-bis de
 * `orchestrator-stage-1-research.md`) — hoje só existia "em sessão"
 * (`eia_bash_id` + `eia_dispatch_ts`, texto de prosa "armazenar como"),
 * inutilizável pro Stage 3 quando roda como sessão nova (`/diaria-3-imagens`,
 * premissa central do #5414: contexto limpo entre stages).
 *
 * `bashId` é um handle do harness escopado à conversa que disparou o
 * background — não sobrevive a uma sessão nova, então nunca foi (e continua
 * não sendo) a fonte de verdade de conclusão: isso sempre foi, e continua
 * sendo, `{EDITION_DIR}/01-eia.md` existir (file-presence check, já era o
 * design do Stage 3 §3a antes desta issue — "mais robusto que pollar bash
 * status"). Este módulo persiste `dispatchedAt` pra que o timeout de 10min do
 * §3a funcione também numa sessão nova, sem precisar "lembrar" quando o
 * dispatch aconteceu — `bashId` é gravado só como referência informativa/
 * debug para quem está na MESMA sessão que disparou o background.
 *
 * Fail-soft na leitura — arquivo ausente/corrompido/shape inesperado -> os
 * dois campos `null` (equivalente a "nunca dispatchado nesta edição", mesmo
 * efeito que o Stage 3 já trata quando `01-eia.md` está ausente e não há
 * sinal de dispatch em sessão).
 *
 * @see .claude/agents/orchestrator-stage-1-research.md §1a-bis
 * @see .claude/agents/orchestrator-stage-3.md §3a
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule, parseArgs } from "./cli-args.ts";

export interface EiaDispatchState {
  /** Bash ID do `run_in_background=true` que disparou `eia-compose.ts`.
   * Só útil dentro da MESMA sessão que o criou — nunca a fonte de verdade
   * de conclusão (isso é sempre `01-eia.md` existir). */
  bashId: string | null;
  /** ISO — quando o dispatch aconteceu. Usado pelo timeout de 10min do
   * Stage 3 §3a. `null` = nunca dispatchado nesta edição. */
  dispatchedAt: string | null;
}

const DEFAULT_STATE: EiaDispatchState = { bashId: null, dispatchedAt: null };

function statePath(editionDir: string): string {
  return resolve(editionDir, "_internal", "eia-dispatch-state.json");
}

/** Lê o estado do dispatch do É IA?. Fail-soft — arquivo ausente, erro de FS
 * real (EACCES/EPERM/EISDIR/lock do OneDrive — logado, nunca engolido em
 * silêncio) ou JSON corrompido/shape inesperado -> `{bashId: null,
 * dispatchedAt: null}`. */
export function readEiaDispatchState(editionDir: string): EiaDispatchState {
  const p = statePath(editionDir);
  if (!existsSync(p)) return { ...DEFAULT_STATE };
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    console.error(
      `eia-dispatch-state: falha ao ler ${p}: ${(err as Error).message} — tratando como nunca dispatchado`,
    );
    return { ...DEFAULT_STATE };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EiaDispatchState>;
    return {
      bashId: typeof parsed.bashId === "string" ? parsed.bashId : null,
      dispatchedAt: typeof parsed.dispatchedAt === "string" ? parsed.dispatchedAt : null,
    };
  } catch (err) {
    console.error(
      `eia-dispatch-state: JSON inválido em ${p}: ${(err as Error).message} — tratando como nunca dispatchado`,
    );
    return { ...DEFAULT_STATE };
  }
}

/** Grava o dispatch do É IA? (chamado pelo Stage 1 logo após o
 * `Bash(run_in_background=true)`). Sobrescreve o estado anterior por
 * completo — um novo dispatch (ex: retry `--force` do Stage 3 §3a) sempre
 * substitui o anterior, nunca faz merge parcial (diferente do preflight —
 * aqui os 2 campos sempre nascem juntos, do mesmo dispatch). Propaga erro de
 * escrita real — só a LEITURA é fail-soft. */
export function writeEiaDispatchState(
  editionDir: string,
  state: EiaDispatchState,
  _opts: Record<string, never> = {},
): EiaDispatchState {
  const p = statePath(editionDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

// CLI:
//   Escrever:
//     npx tsx scripts/lib/eia-dispatch-state.ts --edition-dir <dir> \
//       --bash-id <id> --dispatched-at <iso>
//   Ler (imprime o JSON completo em stdout):
//     npx tsx scripts/lib/eia-dispatch-state.ts --edition-dir <dir> --read
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const editionDir = parsed.values["edition-dir"];
  if (!editionDir) {
    console.error(
      "uso: eia-dispatch-state.ts --edition-dir <dir> [--read] [--bash-id <id> --dispatched-at <iso>]",
    );
    process.exit(1);
  }
  if (parsed.flags.has("read")) {
    console.log(JSON.stringify(readEiaDispatchState(editionDir)));
  } else {
    const bashId = parsed.values["bash-id"];
    const dispatchedAt = parsed.values["dispatched-at"];
    if (!bashId || !dispatchedAt) {
      console.error("--bash-id e --dispatched-at são obrigatórios pra escrever (ou use --read pra ler)");
      process.exit(1);
    }
    const next = writeEiaDispatchState(editionDir, { bashId, dispatchedAt });
    console.log(JSON.stringify(next));
  }
}
