/**
 * clarice-envio-engajados-enabled.ts (#6945)
 *
 * Kill switch da automação diária do grupo `engajados` — mesmo molde de
 * `clarice-novos-enabled.ts` (#4941), inclusive no default.
 *
 * `enabled: false` é o default de ARQUIVO AUSENTE, deliberadamente — esta é
 * uma automação NOVA (nunca rodou desassistida antes desta issue) que
 * dispara e-mail real e irreversível pra até `ENGAJADOS_MAX_DAILY_VOLUME`
 * contatos por dia (`clarice-envio-engajados-policy.ts`), sem gate humano no
 * caminho normal. Armar a task systemd nunca liga a automação sozinho — o
 * editor precisa escrever `{"enabled": true}` explicitamente (via este CLI)
 * depois de revisar a 1ª rodada manual/dry-run. Mesmo racional do
 * `clarice-novos-enabled.ts` (ver docstring lá pro porquê da inversão em
 * relação a `studio-chat-enabled.ts`, onde o pior caso de "ligado sem
 * querer" era só UX incômoda).
 *
 * Estado persistido em `data/clarice-engajados-enabled.json` — arquivo NOVO
 * e dedicado, nunca reaproveita `clarice-envio-enabled.json`/
 * `clarice-novos-enabled.json` (automações distintas).
 *
 * Uso CLI (mesmo padrão de `clarice-envio-enabled.ts`/`clarice-novos-enabled.ts`):
 *   npx tsx scripts/lib/clarice-envio-engajados-enabled.ts
 *   npx tsx scripts/lib/clarice-envio-engajados-enabled.ts --set enabled
 *   npx tsx scripts/lib/clarice-envio-engajados-enabled.ts --set disabled
 *
 * @see scripts/lib/clarice-novos-enabled.ts (#4941 — molde direto)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getArg, isMainModule } from "./cli-args.ts";

export interface ClariceEngajadosEnabledState {
  /** `false` = default de arquivo ausente (lado seguro). `true` = o editor liberou o disparo automático. */
  enabled: boolean;
  /** ISO — última alteração via `setClariceEngajadosEnabled`. `null` = nunca escrito. */
  updatedAt: string | null;
}

const DEFAULT_STATE: ClariceEngajadosEnabledState = { enabled: false, updatedAt: null };

function statePath(rootDir: string): string {
  return resolve(rootDir, "data", "clarice-engajados-enabled.json");
}

/** Lê o estado do toggle. Fail-soft total -> `{enabled:false, updatedAt:null}` (lado seguro), nunca lança. */
export function readClariceEngajadosEnabledState(rootDir: string): ClariceEngajadosEnabledState {
  const p = statePath(rootDir);
  if (!existsSync(p)) return { ...DEFAULT_STATE };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ClariceEngajadosEnabledState>;
    if (typeof raw.enabled !== "boolean") return { ...DEFAULT_STATE };
    return {
      enabled: raw.enabled,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Atalho booleano — o que `clarice-envio-engajados-run.ts` consulta no Passo 0. */
export function isClariceEngajadosEnabled(rootDir: string): boolean {
  return readClariceEngajadosEnabledState(rootDir).enabled;
}

/** Escreve o novo estado — não é fail-soft (mesma disciplina de `setClariceNovosEnabled`). */
export function setClariceEngajadosEnabled(
  rootDir: string,
  enabled: boolean,
  opts: { now?: () => Date } = {},
): ClariceEngajadosEnabledState {
  const now = opts.now ?? (() => new Date());
  const p = statePath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  const state: ClariceEngajadosEnabledState = { enabled, updatedAt: now().toISOString() };
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

// CLI guard: só executa como main module, importável sem efeito colateral (mesmo padrão de clarice-novos-enabled.ts).
if (isMainModule(import.meta.url)) {
  const setArg = getArg(process.argv.slice(2), "set");
  if (setArg === "enabled" || setArg === "disabled") {
    const state = setClariceEngajadosEnabled(process.cwd(), setArg === "enabled");
    console.log(state.enabled ? "enabled" : "disabled");
  } else {
    console.log(isClariceEngajadosEnabled(process.cwd()) ? "enabled" : "disabled");
  }
}
