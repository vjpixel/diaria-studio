/**
 * preflight-state.ts (#5414)
 *
 * Persiste os 5 sinais de saúde de dependência externa que o Stage 0
 * ("Preflight") do orchestrator apura uma vez por edição — CHROME_MCP,
 * GMAIL_MCP, BEEHIIV_MCP, CLARICE_REST, CLOUDFLARE_TOKEN_OK — hoje só
 * guardados "em sessão" (na conversa do orchestrator, `orchestrator-stage-0-
 * preflight.md` §0c). Isso quebra a premissa de rodar a pipeline stage-a-
 * stage com contexto limpo entre etapas (#5414, corte de ~49% de custo
 * medido na auditoria de 260816): um Stage 2 ou Stage 5 disparado como
 * sessão nova (`/diaria-2-escrita`, `/diaria-5-publicacao`) nunca viu o
 * Stage 0 rodar nesta conversa — CLARICE_REST/CHROME_MCP simplesmente não
 * existem em memória pra ele. A única forma confiável de saber é reler do
 * disco.
 *
 * Escrito no Stage 0, um `writePreflightState` por sinal apurado (§0c roda
 * os 5 checks em sequência — cada write faz upsert sobre o que já foi
 * gravado antes na mesma execução, nunca apaga os outros campos). Lido no
 * início de qualquer stage que precisar do sinal — hoje Stage 2 §3b consulta
 * `clariceRest`, Stage 5 consulta `chromeMcp`. `gmailMcp`/`beehiivMcp`/
 * `cloudflareTokenOk` só são consumidos dentro do próprio Stage 0 hoje, mas
 * são persistidos igual — robustez contra o Stage 0 em si rodar por partes
 * (compaction no meio, resume) e uniformidade dos 5 sinais.
 *
 * `null` = "nunca verificado nesta edição" (arquivo ausente, ou o campo
 * específico nunca escrito) — tratado pelos callers como "tenta mesmo
 * assim", a mesma semântica permissiva que já valia quando o valor só
 * existia em memória de sessão e a sessão nova simplesmente não tinha
 * rodado o preflight.
 *
 * Fail-soft total na leitura (arquivo ausente, JSON corrompido, shape
 * inesperado) -> todos os campos `null` — nunca lança, nunca bloqueia um
 * stage por falta do arquivo (ex: edição criada antes desta issue).
 *
 * @see CLAUDE.md, context/overnight-dispatch-rules.md
 * @see .claude/agents/orchestrator-stage-0-preflight.md §0c
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule, parseArgs } from "./cli-args.ts";

export interface PreflightState {
  /** Claude in Chrome MCP (`mcp__claude-in-chrome__tabs_context_mcp`).
   * Consumido no Stage 5 (skip fail-soft se `false`). */
  chromeMcp: boolean | null;
  /** Gmail MCP (`mcp__claude_ai_Gmail__list_labels`). Consumido dentro do
   * próprio Stage 0 (§0n CI-failures, §0-replies). */
  gmailMcp: boolean | null;
  /** Beehiiv MCP (`mcp__claude_ai_Beehiiv__get_current_user`). Consumido
   * dentro do próprio Stage 0 (§0h.2 clicks enricher, §0-replies fallback). */
  beehiivMcp: boolean | null;
  /** Clarice REST fallback (`cortex.clarice.ai/api-correction`). Consumido
   * pelo Stage 2 §3b antes de tentar o fallback quando o MCP falha. */
  clariceRest: boolean | null;
  /** Token Cloudflare/wrangler (`CLOUDFLARE_API_TOKEN`). Consumido dentro do
   * próprio Stage 0 (§0d.bis maintain-valid-editions). */
  cloudflareTokenOk: boolean | null;
  /** ISO — quando o preflight escreveu por último. `null` = nunca escrito. */
  capturedAt: string | null;
}

const DEFAULT_STATE: PreflightState = {
  chromeMcp: null,
  gmailMcp: null,
  beehiivMcp: null,
  clariceRest: null,
  cloudflareTokenOk: null,
  capturedAt: null,
};

function statePath(editionDir: string): string {
  return resolve(editionDir, "_internal", "preflight-state.json");
}

/** Lê o estado do preflight. Fail-soft — arquivo ausente/corrompido/shape
 * inesperado -> todos os campos `null` (equivalente a "nunca verificado"). */
export function readPreflightState(editionDir: string): PreflightState {
  const p = statePath(editionDir);
  if (!existsSync(p)) return { ...DEFAULT_STATE };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<PreflightState>;
    const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
    return {
      chromeMcp: boolOrNull(raw.chromeMcp),
      gmailMcp: boolOrNull(raw.gmailMcp),
      beehiivMcp: boolOrNull(raw.beehiivMcp),
      clariceRest: boolOrNull(raw.clariceRest),
      cloudflareTokenOk: boolOrNull(raw.cloudflareTokenOk),
      capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Grava um patch parcial por cima do estado já existente (upsert) — o
 * Stage 0 apura os 5 sinais em passos separados (§0c), cada write só toca o
 * próprio campo sem apagar os que já foram gravados antes na mesma execução.
 * Sempre atualiza `capturedAt`. Propaga erro de escrita real (disco cheio,
 * permissão) — só a LEITURA é fail-soft. */
export function writePreflightState(
  editionDir: string,
  patch: Partial<Omit<PreflightState, "capturedAt">>,
  opts: { now?: () => Date } = {},
): PreflightState {
  const now = opts.now ?? (() => new Date());
  const p = statePath(editionDir);
  const current = readPreflightState(editionDir);
  const next: PreflightState = { ...current, ...patch, capturedAt: now().toISOString() };
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

const FIELD_BY_FLAG: Record<string, keyof Omit<PreflightState, "capturedAt">> = {
  "chrome-mcp": "chromeMcp",
  "gmail-mcp": "gmailMcp",
  "beehiiv-mcp": "beehiivMcp",
  "clarice-rest": "clariceRest",
  "cloudflare-token-ok": "cloudflareTokenOk",
};

function parseBoolFlag(raw: string, flag: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`--${flag} deve ser "true" ou "false", recebido "${raw}"`);
}

// CLI:
//   Escrever (1+ flags, qualquer combinação — upsert sobre o que já existe):
//     npx tsx scripts/lib/preflight-state.ts --edition-dir <dir> \
//       --chrome-mcp true --gmail-mcp false --clarice-rest true
//   Ler (imprime o JSON completo em stdout):
//     npx tsx scripts/lib/preflight-state.ts --edition-dir <dir> --read
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const editionDir = parsed.values["edition-dir"];
  if (!editionDir) {
    console.error(
      "uso: preflight-state.ts --edition-dir <dir> [--read] [--chrome-mcp true|false] " +
        "[--gmail-mcp true|false] [--beehiiv-mcp true|false] [--clarice-rest true|false] " +
        "[--cloudflare-token-ok true|false]",
    );
    process.exit(1);
  }
  if (parsed.flags.has("read")) {
    console.log(JSON.stringify(readPreflightState(editionDir)));
  } else {
    const patch: Partial<Omit<PreflightState, "capturedAt">> = {};
    for (const [flag, field] of Object.entries(FIELD_BY_FLAG)) {
      const raw = parsed.values[flag];
      if (raw !== undefined) patch[field] = parseBoolFlag(raw, flag);
    }
    if (Object.keys(patch).length === 0) {
      console.error(
        "nada para escrever — passe ao menos 1 flag (--chrome-mcp, --gmail-mcp, --beehiiv-mcp, " +
          "--clarice-rest, --cloudflare-token-ok) ou --read",
      );
      process.exit(1);
    }
    const next = writePreflightState(editionDir, patch);
    console.log(JSON.stringify(next));
  }
}
