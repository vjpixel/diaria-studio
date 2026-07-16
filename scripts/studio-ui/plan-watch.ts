/**
 * plan-watch.ts (#3555)
 *
 * Observa `data/overnight/{AAMMDD}/plan.json` e `data/develop/{AAMMDD}/plan.json`
 * (a sessão mais recente de cada, via `findLatestPlanPath` de `studio-state.ts`)
 * pra alimentar `GET /api/events` (SSE) com um evento `plan` sempre que o
 * arquivo mudar — cobre "briefing"/rodadas overnight e develop em andamento.
 *
 * Mesma estratégia dupla de `run-log-tail.ts`: `fs.watch` (reação rápida) +
 * polling de baixa frequência (rede de segurança sobre a junction OneDrive
 * de `data/`). `currentPlanSignature` é pura o bastante pra testar sem mock
 * de fs.watch — só olha path + mtime.
 */

import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { findLatestPlanPath } from "./studio-state.ts";

export type PlanKind = "overnight" | "develop";

export interface PlanSignature {
  kind: PlanKind;
  path: string | null; // relativo a rootDir, "/" mesmo no Windows
  mtimeMs: number | null;
}

function toRelative(rootDir: string, absPath: string): string {
  const rel = absPath.startsWith(rootDir) ? absPath.slice(rootDir.length) : absPath;
  return rel.replace(/^[\\/]+/, "").split("\\").join("/");
}

/** Assinatura atual (path + mtime) do plan.json mais recente de `kind`. */
export function currentPlanSignature(rootDir: string, kind: PlanKind): PlanSignature {
  const absPath = findLatestPlanPath(rootDir, kind);
  if (!absPath || !existsSync(absPath)) return { kind, path: null, mtimeMs: null };
  try {
    return { kind, path: toRelative(rootDir, absPath), mtimeMs: statSync(absPath).mtimeMs };
  } catch {
    return { kind, path: null, mtimeMs: null };
  }
}

function sigEqual(a: PlanSignature, b: PlanSignature): boolean {
  return a.path === b.path && a.mtimeMs === b.mtimeMs;
}

export interface PlanWatchHandle {
  close: () => void;
}

const KINDS: PlanKind[] = ["overnight", "develop"];

/**
 * Observa os planos overnight + develop mais recentes; chama `onChange` com
 * a nova assinatura sempre que path OU mtime mudarem (nova sessão OU sessão
 * existente atualizada).
 */
export function watchPlanFiles(
  rootDir: string,
  onChange: (sig: PlanSignature) => void,
  opts: { pollIntervalMs?: number } = {},
): PlanWatchHandle {
  const last: Record<PlanKind, PlanSignature> = {
    overnight: currentPlanSignature(rootDir, "overnight"),
    develop: currentPlanSignature(rootDir, "develop"),
  };

  const poll = () => {
    for (const kind of KINDS) {
      const sig = currentPlanSignature(rootDir, kind);
      if (!sigEqual(sig, last[kind])) {
        last[kind] = sig;
        onChange(sig);
      }
    }
  };

  const watchers: FSWatcher[] = [];
  for (const kind of KINDS) {
    const dir = resolve(rootDir, "data", kind);
    try {
      if (existsSync(dir)) {
        // `recursive: true` cobre a criação/mudança do plan.json dentro do
        // subdiretório {AAMMDD}/ — suportado no Windows (plataforma alvo
        // desta ferramenta local) e macOS; onde não suportado, o try/catch
        // deixa o polling como única cobertura (degrada, não quebra).
        const w = watch(dir, { recursive: true }, () => poll());
        w.on("error", () => {
          // idem run-log-tail.ts: polling continua cobrindo.
        });
        watchers.push(w);
      }
    } catch {
      // plataforma sem suporte a recursive watch — segue só com polling.
    }
  }

  const interval = setInterval(poll, opts.pollIntervalMs ?? 1000);

  return {
    close: () => {
      clearInterval(interval);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // no-op
        }
      }
    },
  };
}
