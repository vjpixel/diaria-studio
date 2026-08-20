#!/usr/bin/env node
/**
 * stage-0-run.ts (#5415, incremento 1/3 — só Stage 0)
 *
 * Orquestrador DETERMINÍSTICO do Stage 0 (Preflight) do orchestrator
 * diar.ia.br (`.claude/agents/orchestrator-stage-0-preflight.md`) — mesmo
 * padrão de `scripts/clarice-novos-run.ts` (#4941) e `scripts/audience-run.ts`
 * (#5192): a versão em prosa tem o LLM top-level como *glue* puro entre ~24
 * chamadas Bash sem NENHUM julgamento editorial (Stage 0 é setup/checks, zero
 * seleção de conteúdo) — exceto os pings de MCP (Chrome/Gmail/Beehiiv), que
 * só são alcançáveis de dentro de uma sessão de agente com esses conectores,
 * nunca de um processo Node puro.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ESCOPO — o que este script cobre e o que continua exigindo o orchestrator
 * ═══════════════════════════════════════════════════════════════════════
 *
 * COBERTO (determinístico, sem MCP):
 *   0a. Resolver {EDITION_DIR}, edition_iso, anchor_iso, cutoff_iso, mkdir.
 *   0b-bis. Auto-capture de newsletters (Gmail REST via OAuth local — NÃO é
 *           MCP, é a mesma distinção que `scripts/fetch-newsletter-threads.ts`
 *           já faz).
 *   0c. Log de início + preflight-external-locks.ts (OAuth Google + Wrangler
 *       + API keys — os 3 sub-checks que SÃO determinísticos; os conectores
 *       MCP dentro desse mesmo script já voltam "unchecked" por design) +
 *       check-cloudflare-token.ts + clarice-healthcheck.ts (ambos HTTPS ping
 *       direto, não MCP) + init/reconcile/mark-running de stage-status.md.
 *   0d. refresh-dedup.ts.
 *   0d.bis. maintain-valid-editions-window.ts — HALT obrigatório (banner
 *           renderizado) se o script sinalizar `read_failed` ou qualquer
 *           outro erro, idêntico à regra em prosa (nunca bypassa mesmo com
 *           `--auto-approve`).
 *   0e-0h (batch paralelo, igual à prosa "1 mensagem, 4 Bash calls"):
 *     0e. merge-local-pending.ts
 *     0f. sync-eia-used.ts
 *     0g. check-dedup-freshness.ts (staleness vira `pendingHumanDecision`,
 *         nunca aborta sozinho — a confirmação [c/a] é decisão do editor)
 *     0h.1 + 0h.3. beehiiv-sync.ts + build-link-ctr.ts (0h.2, o enrichment
 *         via subagent `beehiiv-clicks-enricher`, é OUT — ver abaixo)
 *   0i. update-audience.ts + snapshot-audience-profile.ts (sequencial, após
 *       o batch).
 *   0j. find-pending-issue-drafts.ts (script). Se vazio, no-op. Se não-vazio,
 *       NUNCA dispara o subagent `auto-reporter` sozinho — isso exige decisão
 *       humana (s/n/d) — vira `pendingHumanDecision`.
 *   0k. Verificação FB + LinkedIn/Instagram/Threads da edição anterior
 *       (find-last-edition-with-fb.ts + verify-facebook-posts.ts +
 *       verify-social-worker-dispatch.ts) — 100% script, sem MCP.
 *   0l. check-prev-social-status.ts (`--json`) — 100% script.
 *   0z. check-invariants.ts --stage 0 (abort duro se exit 1) + mark stage 0
 *       done + capture-stage-usage.ts.
 *
 * NÃO COBERTO — delegado ao orchestrator, NUNCA simulado aqui:
 *   0c (3 pings MCP): `mcp__claude-in-chrome__tabs_context_mcp`,
 *       `mcp__claude_ai_Gmail__list_labels`,
 *       `mcp__claude_ai_Beehiiv__get_current_user`. Só alcançáveis de dentro
 *       de uma sessão com esses conectores — este script não tenta. Ver
 *       "Design de 2 fases" abaixo.
 *   0h.2. Enrichment de clicks via `Agent(subagent_type="beehiiv-clicks-
 *       enricher")` — dispatch de subagente, fora do alcance de um script
 *       Node. Se `beehiiv-sync.ts` (0h.1) devolver `posts_needing_clicks`
 *       não-vazio, o resultado inclui `pendingAgentDispatch` com o manifest
 *       já persistido em disco — o orchestrator faz o dispatch e, se quiser,
 *       roda `verify-clicks-enrichment.ts` por conta própria (#4732) depois.
 *   0j (decisão humana s/n/d) e o dispatch do agent `auto-reporter` em si —
 *       o script só detecta e relata via `pendingHumanDecision`.
 *   0n. Detecção de falhas de CI via Gmail MCP (`search_threads`/
 *       `get_thread`) — 100% MCP, nunca script.
 *   0-replies. Rascunho de respostas a assinantes — MCP (Gmail) + gate
 *       humano (`AskUserQuestion`) + `mcp__claude_ai_Gmail__create_draft` —
 *       lógica fortemente interativa, fora de escopo desta unidade (ver
 *       issue #5415, "onde o playbook tem julgamento ambíguo, preservar o
 *       comportamento mais conservador" → não tentar).
 *   0m. Auto-reporter final — só roda depois do Stage 4 (não é trabalho do
 *       Stage 0 em si, é uma nota de preparação no playbook).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DESIGN DE 2 FASES (por causa dos 3 pings MCP no meio de 0c)
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   `--phase preflight` — roda 0a + os 3 checks HTTPS de 0c (locks, Cloudflare,
 *     Clarice REST) SEM nenhuma escrita em disco (mkdir/log/stage-status/
 *     0b-bis ficam para a fase `continue`) e devolve um JSON pedindo ao
 *     orchestrator para fazer os 3 pings MCP e invocar de novo com os
 *     resultados. Mesmo padrão de `audience-run.ts --resolve-only`.
 *
 *   `--phase continue --mcp-chrome <bool> --mcp-gmail <bool> --mcp-beehiiv <bool>`
 *     — roda a fase A de novo (idempotente — todos HTTPS reads, seguro
 *     repetir), agora COM escrita (mkdir, log-event, stage-status,
 *     0b-bis), persiste `preflight-state.json` com os 5 sinais, e continua
 *     0d → 0z. É a chamada "de verdade": o orchestrator só entra aqui depois
 *     de ter feito os 3 pings MCP.
 *
 * Cada sub-script é invocado por SPAWN (`process.execPath --import tsx`,
 * nunca `npx tsx` — guard #4343), nunca por import — preserva o contrato de
 * exit code + stdout de cada sub-script, sem duplicar guards internos.
 *
 * Exit codes:
 *   0 — sucesso (preflight concluído / continue concluído, mesmo com
 *       `pendingHumanDecision`/`pendingAgentDispatch` pendentes — isso não é
 *       falha, é trabalho que o orchestrator ainda precisa fazer)
 *   1 — erro duro (sub-script obrigatório falhou — refresh-dedup, check-
 *       invariants exit 1, exceção inesperada)
 *   2 — HALT obrigatório (0d.bis sinalizou read_failed ou erro — banner já
 *       renderizado, incluído em `haltRequired` no JSON de saída; nunca
 *       bypassa mesmo com `--auto-approve`, mesma regra do playbook)
 *
 * Uso:
 *   npx tsx scripts/stage-0-run.ts --phase preflight --edition AAMMDD \
 *     [--window-days N] [--auto-approve] [--pre-gate] [--now ISO]
 *
 *   npx tsx scripts/stage-0-run.ts --phase continue --edition AAMMDD \
 *     --mcp-chrome true|false --mcp-gmail true|false --mcp-beehiiv true|false \
 *     [--window-days N] [--auto-approve] [--pre-gate] [--now ISO]
 *
 * @see .claude/agents/orchestrator-stage-0-preflight.md (playbook em prosa —
 *      espelha este script; NÃO editado nesta unidade — o cutover do
 *      orchestrator para chamar este script é decisão separada, feita numa
 *      unidade de acompanhamento depois de validar isto isoladamente)
 * @see scripts/clarice-novos-run.ts (padrão de referência, #4941)
 * @see scripts/audience-run.ts (padrão de 2 fases pra dependência MCP-only, #5192)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";

// Mesma disciplina do #4983 (clarice-novos-run.ts) — carregar .env ANTES de
// qualquer outro código, em module scope.
loadProjectEnv();

// fileURLToPath() em vez de `new URL("..", import.meta.url).pathname` —
// evita a dobra de drive letter no Windows (ver nota em brevo-diaria-run.ts).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Spawn de sub-script — sync (sequencial) e async (batch paralelo 0e-0h).
// Ambos injetáveis pra teste (nenhum spawn real nos testes).
// ---------------------------------------------------------------------------

export interface StepResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (scriptRelPath: string, args: string[]) => StepResult;
export type AsyncExecFn = (scriptRelPath: string, args: string[]) => Promise<StepResult>;

export function realExec(rootDir: string): ExecFn {
  return (scriptRelPath, args) => {
    const abs = resolve(rootDir, ...scriptRelPath.split("/"));
    const result = spawnSync(process.execPath, ["--import", "tsx", abs, ...args], {
      cwd: rootDir,
      encoding: "utf8",
    });
    if (result.error || result.status === null) {
      return {
        code: 1,
        stdout: result.stdout ?? "",
        stderr: (result.stderr ?? "") + `\nERRO: o passo nao executou (falha de spawn): ${result.error?.message ?? "status null"}\n`,
      };
    }
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

/** Versão assíncrona — usada só no batch 0e-0h pra ganhar concorrência real
 * (mesmo ganho de wall-clock que a prosa descreve como "1 mensagem, 4 Bash
 * calls"). `spawnSync` bloqueia o event loop; `spawn` não. */
export function realExecAsync(rootDir: string): AsyncExecFn {
  return (scriptRelPath, args) =>
    new Promise((resolvePromise) => {
      const abs = resolve(rootDir, ...scriptRelPath.split("/"));
      let stdout = "";
      let stderr = "";
      let child;
      try {
        child = spawn(process.execPath, ["--import", "tsx", abs, ...args], { cwd: rootDir });
      } catch (e) {
        resolvePromise({ code: 1, stdout: "", stderr: `ERRO: o passo nao executou (falha de spawn): ${(e as Error).message}\n` });
        return;
      }
      child.stdout?.on("data", (d) => (stdout += String(d)));
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        resolvePromise({ code: 1, stdout, stderr: stderr + `\nERRO: o passo nao executou (falha de spawn): ${err.message}\n` });
      });
      child.on("close", (code) => {
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
    });
}

/** Extrai o primeiro bloco JSON de stdout — mesmo helper de clarice-novos-run.ts. */
export function parseStepJson<T = unknown>(stdout: string): T | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const start = Math.min(...["{", "["].map((c) => trimmed.indexOf(c)).filter((i) => i >= 0));
  if (!Number.isFinite(start)) return undefined;
  try {
    return JSON.parse(trimmed.slice(start)) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Abort tipado.
// ---------------------------------------------------------------------------

/** Sempre `code: 1` — o HALT (código 2, 0d.bis) NUNCA passa por exceção, é
 * um `return` antecipado dentro de `runContinue` (não é um erro de código,
 * é um resultado operacional que precisa do JSON completo — `editionDir`,
 * `haltRequired` etc — no retorno, o que uma exceção capturada no topo não
 * carregaria sem duplicar campos). Mesma lição já documentada em
 * `NovosAbort` (`scripts/clarice-novos-run.ts`, achado do review #4949):
 * um tipo `1 | 2` aqui sugeriria uma uniformidade que não existe no
 * controle de fluxo real. */
export class Stage0Abort extends Error {
  readonly code = 1 as const;
  constructor(message: string) {
    super(message);
    this.name = "Stage0Abort";
  }
}

// ---------------------------------------------------------------------------
// Datas — edition_iso / anchor_iso / cutoff_iso (#560, seção 0a do playbook).
// ---------------------------------------------------------------------------

const AAMMDD_RE = /^\d{6}$/;

export function editionIsoFromAammdd(aammdd: string): string {
  if (!AAMMDD_RE.test(aammdd)) {
    throw new Stage0Abort(`edition inválido — esperado AAMMDD (6 dígitos), recebido: "${aammdd}"`);
  }
  return `20${aammdd.slice(0, 2)}-${aammdd.slice(2, 4)}-${aammdd.slice(4, 6)}`;
}

export function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Subtrai `days` de `anchorIso` (formato YYYY-MM-DD), em UTC — mesma
 * semântica do snippet `node -e` do playbook (`setUTCDate`). */
export function subtractDaysIso(anchorIso: string, days: number): string {
  const d = new Date(`${anchorIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return isoDateOnly(d);
}

/** Default retrocompat quando `window_days` não é recebido do caller (o
 * caminho normal é a skill já ter perguntado/confirmado — isto é só
 * fallback). Segunda/terça = 4, quarta-sexta = 3; fim de semana usa o
 * mesmo default de segunda (4, o mais conservador) — o playbook não cobre
 * esse caso explicitamente, assumido aqui como a leitura mais segura. */
export function defaultWindowDays(now: Date): number {
  const day = now.getUTCDay(); // 0=Dom..6=Sáb
  if (day === 3 || day === 4 || day === 5) return 3; // qua/qui/sex
  return 4; // seg/ter + fim de semana (fallback conservador)
}

// ---------------------------------------------------------------------------
// Opções da CLI
// ---------------------------------------------------------------------------

export interface Stage0RunOptions {
  phase: "preflight" | "continue";
  edition: string;
  windowDays?: number;
  autoApprove: boolean;
  preGate: boolean;
  nowIso?: string;
  mcpChrome?: boolean;
  mcpGmail?: boolean;
  mcpBeehiiv?: boolean;
}

function parseBoolFlag(argv: string[], key: string): boolean | undefined {
  const raw = getStringArg(argv, key, { example: "true" });
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Stage0Abort(`--${key} precisa ser "true" ou "false" — recebido: "${raw}"`);
}

export function parseStage0RunArgs(argv: string[]): Stage0RunOptions {
  const phaseRaw = getStringArg(argv, "phase", { example: "preflight" }) ?? "preflight";
  if (phaseRaw !== "preflight" && phaseRaw !== "continue") {
    throw new Stage0Abort(`--phase precisa ser "preflight" ou "continue" — recebido: "${phaseRaw}"`);
  }
  const edition = getStringArg(argv, "edition", { example: "260423" });
  if (!edition || !AAMMDD_RE.test(edition)) {
    throw new Stage0Abort('--edition AAMMDD é obrigatório (6 dígitos, ex: "260423").');
  }
  const windowDaysRaw = getStringArg(argv, "window-days", { example: "4" });
  const windowDays = windowDaysRaw !== undefined ? Number(windowDaysRaw) : undefined;
  if (windowDays !== undefined && (!Number.isFinite(windowDays) || !Number.isInteger(windowDays) || windowDays <= 0)) {
    throw new Stage0Abort(`--window-days precisa ser um inteiro positivo — recebido: "${windowDaysRaw}"`);
  }

  const opts: Stage0RunOptions = {
    phase: phaseRaw,
    edition,
    windowDays,
    autoApprove: hasFlag(argv, "auto-approve"),
    preGate: hasFlag(argv, "pre-gate"),
    nowIso: getStringArg(argv, "now", { example: "2026-04-23T08:00:00Z" }),
    mcpChrome: parseBoolFlag(argv, "mcp-chrome"),
    mcpGmail: parseBoolFlag(argv, "mcp-gmail"),
    mcpBeehiiv: parseBoolFlag(argv, "mcp-beehiiv"),
  };

  if (opts.phase === "continue") {
    for (const [key, val] of [
      ["mcp-chrome", opts.mcpChrome],
      ["mcp-gmail", opts.mcpGmail],
      ["mcp-beehiiv", opts.mcpBeehiiv],
    ] as const) {
      if (val === undefined) {
        throw new Stage0Abort(
          `--phase continue exige --${key} true|false — rode "--phase preflight" primeiro, faça os 3 pings MCP, e chame de novo com os 3 resultados.`,
        );
      }
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Deps injetáveis.
// ---------------------------------------------------------------------------

export interface Stage0RunDeps {
  rootDir: string;
  now: () => Date;
  exec: ExecFn;
  execAsync: AsyncExecFn;
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string) => void;
  readFile: (p: string) => string;
  writeFile: (path: string, content: string) => void;
}

export function productionDeps(rootDir: string = ROOT): Stage0RunDeps {
  return {
    rootDir,
    now: () => new Date(),
    exec: realExec(rootDir),
    execAsync: realExecAsync(rootDir),
    existsSync: (p) => existsSync(p),
    mkdirSync: (p) => mkdirSync(p, { recursive: true }),
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, c) => writeFileSync(p, c, "utf8"),
  };
}

// ---------------------------------------------------------------------------
// Report / notas — acumula texto humano-legível pra devolver no JSON final.
// ---------------------------------------------------------------------------

class ReportBuilder {
  readonly notes: string[] = [];
  note(line: string): void {
    this.notes.push(line);
    console.error(line);
  }
}

function step(
  deps: Stage0RunDeps,
  report: ReportBuilder,
  label: string,
  scriptRelPath: string,
  args: string[],
  okCodes: number[] = [0],
): { result: StepResult; json: unknown } {
  report.note(`▶ ${label}`);
  const result = deps.exec(scriptRelPath, args);
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (!okCodes.includes(result.code)) {
    const detail = result.stderr.trim().split("\n").slice(-6).join(" | ") || "(sem stderr)";
    throw new Stage0Abort(`❌ ${label} falhou (exit ${result.code}): ${detail}`);
  }
  return { result, json: parseStepJson(result.stdout) };
}

/** Passo "soft" — nunca lança, só registra sucesso/falha (fail-soft, mesmo
 * padrão de quase todo passo 0e-0l do playbook: "não bloqueia — warn e
 * segue"). */
function softStep(
  deps: Stage0RunDeps,
  report: ReportBuilder,
  label: string,
  scriptRelPath: string,
  args: string[],
): { result: StepResult; json: unknown } {
  report.note(`▶ ${label} (fail-soft)`);
  const result = deps.exec(scriptRelPath, args);
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.code !== 0) {
    report.note(`⚠️  ${label} falhou (exit ${result.code}) — fail-soft, não bloqueia Stage 0.`);
  }
  return { result, json: parseStepJson(result.stdout) };
}

function logEvent(
  deps: Stage0RunDeps,
  edition: string,
  level: "info" | "warn" | "error",
  message: string,
  opts: { details?: unknown; informational?: boolean } = {},
): void {
  const args = ["--edition", edition, "--stage", "0", "--agent", "orchestrator", "--level", level, "--message", message];
  if (opts.details !== undefined) args.push("--details", JSON.stringify(opts.details));
  if (opts.informational) args.push("--informational");
  const result = deps.exec("scripts/log-event.ts", args);
  if (result.code !== 0) {
    console.error(`⚠️  log-event.ts falhou (exit ${result.code}) ao registrar: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Fase A — 0a + (0b-bis + 0c com escrita, só quando persist=true).
// Roda igual nas duas fases; a fase `preflight` chama com persist=false
// (reconnaissance, zero escrita em disco), a fase `continue` com
// persist=true (roda "de verdade").
// ---------------------------------------------------------------------------

export interface PhaseAResult {
  editionDir: string;
  editionIso: string;
  anchorIso: string;
  cutoffIso: string;
  windowDays: number;
  clariceRest: boolean;
  cloudflareTokenOk: boolean;
}

async function runPhaseA(deps: Stage0RunDeps, opts: Stage0RunOptions, report: ReportBuilder, persist: boolean): Promise<PhaseAResult> {
  // --- 0a: resolver EDITION_DIR + datas ---
  const resolveStep = step(deps, report, "find-current-edition --resolve", "scripts/lib/find-current-edition.ts", ["--resolve", opts.edition]);
  const editionDir = resolveStep.result.stdout.trim();
  if (!editionDir) throw new Stage0Abort("❌ find-current-edition.ts --resolve não devolveu um path.");

  const editionIso = editionIsoFromAammdd(opts.edition);
  const now = opts.nowIso ? new Date(opts.nowIso) : deps.now();
  if (Number.isNaN(now.getTime())) throw new Stage0Abort(`❌ --now inválido: "${opts.nowIso}"`);
  const anchorIso = isoDateOnly(now);
  const windowDays = opts.windowDays ?? defaultWindowDays(now);
  const cutoffIso = subtractDaysIso(anchorIso, windowDays);

  if (persist) {
    deps.mkdirSync(resolve(deps.rootDir, editionDir, "_internal"));
  }

  // --- 0b-bis: auto-capture de newsletters (Gmail REST, não MCP) ---
  // Só roda com escrita real (persist=true) — evita duplicar a busca Gmail
  // REST/gasto de cursor quando a fase `preflight` (reconnaissance) roda
  // antes da fase `continue` de verdade.
  if (persist) {
    let autoCaptureEnabled = false;
    let senders: string[] = [];
    let sinceHours = 48;
    try {
      const cfg = JSON.parse(deps.readFile(resolve(deps.rootDir, "platform.config.json"))) as {
        newsletter_auto_capture?: { enabled?: boolean; senders?: string[]; since_hours?: number };
      };
      const nac = cfg.newsletter_auto_capture;
      autoCaptureEnabled = nac?.enabled === true;
      senders = Array.isArray(nac?.senders) ? nac.senders : [];
      sinceHours = typeof nac?.since_hours === "number" ? nac.since_hours : 48;
    } catch {
      report.note("⚠️  0b-bis: platform.config.json ilegível — pulando auto-capture de newsletters.");
    }

    if (autoCaptureEnabled && senders.length > 0) {
      const threadsOut = `${editionDir}/_internal/captured-newsletters.json`;
      const fetchResult = softStep(deps, report, "fetch-newsletter-threads (0b-bis)", "scripts/fetch-newsletter-threads.ts", [
        "--senders",
        senders.join(","),
        "--since-hours",
        String(sinceHours),
        "--out",
        threadsOut,
      ]);
      if (fetchResult.result.code === 0) {
        const summary = fetchResult.json as { threads_found?: number; threads_written?: number } | undefined;
        logEvent(deps, opts.edition, "info", "0b-bis: newsletters capturadas", { details: summary });
        // #1756 — guard: threads_found>0 mas o arquivo ficou ausente/vazio.
        const capturedPath = resolve(deps.rootDir, threadsOut);
        const captured = deps.existsSync(capturedPath) ? deps.readFile(capturedPath).trim() : "";
        if ((summary?.threads_found ?? 0) > 0 && (!captured || captured === "[]")) {
          logEvent(deps, opts.edition, "warn", "0b-bis: threads_found > 0 mas captured-newsletters.json ficou vazio/ausente — falha silenciosa do script", {
            details: summary,
          });
        }
        // Passo 5 do 0b-bis: capture-newsletter-urls.ts (não-bloqueante).
        softStep(deps, report, "capture-newsletter-urls (0b-bis)", "scripts/capture-newsletter-urls.ts", [
          "--threads",
          threadsOut,
          "--out",
          `${editionDir}/_internal/captured-newsletter-articles.json`,
          "--cursor",
          "data/newsletter-capture-cursor.json",
        ]);
      } else {
        logEvent(deps, opts.edition, "info", "0b-bis skipped: fetch-newsletter-threads falhou", { informational: true });
      }
    } else {
      report.note("↷ 0b-bis: newsletter_auto_capture desabilitado ou sem senders — skip silencioso.");
    }
  }

  // --- 0c: log de início + checks HTTPS (não-MCP) ---
  if (persist) {
    logEvent(deps, opts.edition, "info", "edition run started");
  }

  // Simplificação deliberada vs. o playbook: a prosa renderiza 1 banner POR
  // dependência bloqueante (`--reason "{dependency} — {state}"` individual).
  // `preflight-external-locks.ts` só expõe isso como texto humano formatado
  // no CLI (não há um modo `--json` na sua saída) — parsear essas linhas por
  // regex seria frágil, e chamar `preflightExternalLocks()` direto via
  // import quebraria a regra "sempre spawn, nunca import" deste arquivo. Como
  // o passo é só um AVISO informativo (nunca bloqueia — #5321), um banner
  // agregado cobre a mesma função sem essa fragilidade; o stdout completo do
  // sub-script (com o detalhe por dependência) ainda vai pro log-event abaixo.
  const locksResult = softStep(deps, report, "preflight-external-locks (0c)", "scripts/lib/preflight-external-locks.ts", []);
  if (locksResult.result.code === 1) {
    // #5321 "Perguntar é exceção": default é seguir com banner, nunca travar.
    step(deps, report, "render-halt-banner (aviso, 0c)", "scripts/render-halt-banner.ts", [
      "--stage",
      "0 — Preflight",
      "--reason",
      "trava(s) externa(s) detectada(s) — ver stdout de preflight-external-locks",
      "--action",
      "reautenticar conforme indicado; pipeline segue sem bloquear (#5321)",
    ]);
    if (persist) logEvent(deps, opts.edition, "warn", "preflight-external-locks: trava(s) bloqueante(s) detectada(s)", { details: locksResult.result.stdout.trim() });
  }

  const cfResult = deps.exec("scripts/check-cloudflare-token.ts", []);
  const cloudflareTokenOk = cfResult.code === 0;
  if (!cloudflareTokenOk && persist) {
    logEvent(deps, opts.edition, "warn", "check-cloudflare-token: token ausente/inválido — maintain-valid-editions pode falhar em 0d.bis");
  }

  const clariceResult = deps.exec("scripts/clarice-healthcheck.ts", []);
  const clariceRest = clariceResult.code === 0;
  if (!clariceRest && persist) {
    logEvent(deps, opts.edition, "warn", "clarice-healthcheck: REST fallback degradado", { details: parseStepJson(clariceResult.stdout) });
  }

  if (persist) {
    // Persistir os 5 sinais de preflight (#5414) — ANTES do init de
    // stage-status.md, mesma ordem do playbook (§0c). `opts.mcp*` já foram
    // validados como não-undefined por `parseStage0RunArgs` quando
    // `opts.phase === "continue"` (única chamada com persist=true).
    step(deps, report, "preflight-state (persist)", "scripts/lib/preflight-state.ts", [
      "--edition-dir",
      editionDir,
      "--chrome-mcp",
      String(opts.mcpChrome),
      "--gmail-mcp",
      String(opts.mcpGmail),
      "--beehiiv-mcp",
      String(opts.mcpBeehiiv),
      "--clarice-rest",
      String(clariceRest),
      "--cloudflare-token-ok",
      String(cloudflareTokenOk),
    ]);

    // Inicialização do stage-status.md (0c) — idempotente em resume.
    step(deps, report, "update-stage-status --init", "scripts/update-stage-status.ts", ["--edition-dir", editionDir, "--init"]);
    step(deps, report, "update-stage-status --reconcile-running", "scripts/update-stage-status.ts", ["--edition-dir", editionDir, "--reconcile-running"]);
    step(deps, report, "update-stage-status --stage 0 --status running", "scripts/update-stage-status.ts", [
      "--edition-dir",
      editionDir,
      "--stage",
      "0",
      "--status",
      "running",
    ]);
  }

  return { editionDir, editionIso, anchorIso, cutoffIso, windowDays, clariceRest, cloudflareTokenOk };
}

// ---------------------------------------------------------------------------
// Fase "continue" — persiste preflight-state e roda 0d → 0z.
// ---------------------------------------------------------------------------

export interface PendingAgentDispatch {
  step: string;
  agent: string;
  detail: string;
  manifestPath?: string;
}

export interface PendingHumanDecision {
  step: string;
  detail: string;
  prompt?: string;
  options?: string[];
}

export interface HaltRequired {
  stage: string;
  reason: string;
  action: string;
}

export interface Stage0RunResult {
  code: 0 | 1 | 2;
  phase: "preflight" | "continue";
  editionDir?: string;
  editionIso?: string;
  anchorIso?: string;
  cutoffIso?: string;
  windowDays?: number;
  clariceRest?: boolean;
  cloudflareTokenOk?: boolean;
  needsMcpProbes?: { chrome: string; gmail: string; beehiiv: string };
  pendingAgentDispatch: PendingAgentDispatch[];
  pendingHumanDecision: PendingHumanDecision[];
  delegatedSteps: string[];
  haltRequired?: HaltRequired;
  notes: string[];
}

const DELEGATED_STEPS = [
  "0n — detecção de falhas de CI via Gmail MCP (search_threads/get_thread) — nunca executado por este script",
  "0-replies — rascunho de respostas via Gmail MCP + gate humano — nunca executado por este script (roda só quando pre_gate=true, decisão do orchestrator)",
];

async function runContinue(deps: Stage0RunDeps, opts: Stage0RunOptions, report: ReportBuilder): Promise<Stage0RunResult> {
  const pendingAgentDispatch: PendingAgentDispatch[] = [];
  const pendingHumanDecision: PendingHumanDecision[] = [];

  const phaseA = await runPhaseA(deps, opts, report, true);
  const { editionDir, editionIso, anchorIso, cutoffIso, windowDays, clariceRest, cloudflareTokenOk } = phaseA;

  // --- 0d: refresh-dedup — falha dura (#895: nunca prosseguir com dedup stale) ---
  const dedup = step(deps, report, "refresh-dedup (0d)", "scripts/refresh-dedup.ts", []);
  const dedupJson = dedup.json as { new_posts?: number; most_recent_date?: string } | undefined;
  report.note(`dedup refresh: +${dedupJson?.new_posts ?? "?"} novo(s) — mais recente: ${dedupJson?.most_recent_date ?? "?"}`);

  // --- 0d.bis: maintain-valid-editions-window — HALT obrigatório (nunca bypassa) ---
  const maintainResult = deps.exec("scripts/maintain-valid-editions-window.ts", ["--current", opts.edition, "--window-days", "7"]);
  if (maintainResult.stderr.trim()) console.error(maintainResult.stderr.trim());
  if (maintainResult.code !== 0) {
    const reason =
      maintainResult.code === 2
        ? "maintain-valid-editions read_failed=true — KV virgem ou wrangler offline"
        : `maintain-valid-editions falhou inesperadamente (exit ${maintainResult.code})`;
    const action = `rode \`npx tsx scripts/add-valid-edition.ts --edition ${opts.edition}\` pra popular o set e retentar`;
    const banner = deps.exec("scripts/render-halt-banner.ts", ["--stage", "0 — Preflight", "--reason", reason, "--action", action]);
    report.note(banner.stdout.trim() || `HALT: ${reason}`);
    if (opts.autoApprove) {
      report.note("⚠️  --auto-approve NÃO bypassa este halt — bug que invalida a feature de É IA? inteira exige intervenção humana.");
    }
    logEvent(deps, opts.edition, "error", "0d.bis HALT: maintain-valid-editions falhou", { details: { code: maintainResult.code, reason } });
    return {
      code: 2,
      phase: "continue",
      editionDir,
      editionIso,
      anchorIso,
      cutoffIso,
      windowDays,
      clariceRest,
      cloudflareTokenOk,
      pendingAgentDispatch,
      pendingHumanDecision,
      delegatedSteps: DELEGATED_STEPS,
      haltRequired: { stage: "0 — Preflight", reason, action },
      notes: report.notes,
    };
  }

  // --- 0e-0h: batch paralelo (fail-soft cada um, exceto onde indicado) ---
  report.note("▶ batch paralelo 0e/0f/0g/0h.1 (concorrente)");
  const [mergeRes, syncEiaRes, freshnessRes, beehiivSyncRes] = await Promise.all([
    deps.execAsync("scripts/merge-local-pending.ts", [
      "--current",
      opts.edition,
      "--anchor-iso",
      anchorIso,
      "--editions-dir",
      "data/editions/",
      "--window-days",
      "5",
      "--past-raw",
      "data/past-editions-raw.json",
    ]),
    deps.execAsync("scripts/sync-eia-used.ts", ["--editions-dir", "data/editions/"]),
    deps.execAsync("scripts/check-dedup-freshness.ts", []),
    deps.execAsync("scripts/beehiiv-sync.ts", []),
  ]);

  // 0e
  if (mergeRes.code === 0) {
    const mergeJson = parseStepJson<{ pending_found?: number; editions?: Array<{ yymmdd: string; days_ago: number; url_count: number }> }>(mergeRes.stdout);
    report.note(`merge-local-pending: ${mergeJson?.pending_found ?? 0} edição(ões) pending encontrada(s).`);
    for (const e of mergeJson?.editions ?? []) {
      if (e.days_ago > 2) {
        report.note(`🟡 Edição ${e.yymmdd} aprovada local há ${e.days_ago} dia(s) mas ainda draft no Beehiiv — URLs bloqueadas no dedup de hoje.`);
      }
    }
  } else {
    logEvent(deps, opts.edition, "warn", "merge-local-pending falhou ou não existe — URLs de edições pendentes podem não ter sido bloqueadas no dedup", { informational: true });
  }

  // 0f
  if (syncEiaRes.code === 0) {
    const eiaJson = parseStepJson<{ added?: number }>(syncEiaRes.stdout);
    if ((eiaJson?.added ?? 0) > 0) report.note(`sync-eia-used: +${eiaJson?.added} novo(s).`);
  } else {
    logEvent(deps, opts.edition, "warn", "sync-eia-used falhou");
  }

  // 0g — staleness vira decisão humana, nunca aborta sozinho aqui.
  const freshnessJson = parseStepJson<{ ok?: boolean; most_recent?: string; age_hours?: number }>(freshnessRes.stdout);
  if (freshnessRes.code === 1) {
    pendingHumanDecision.push({
      step: "0g",
      detail: `dedup freshness fora da janela (most_recent=${freshnessJson?.most_recent ?? "?"}, age_hours=${freshnessJson?.age_hours ?? "?"})`,
      prompt: "continuar mesmo assim (override) ou abortar?",
      options: ["c = continuar (override)", "a = abortar (default)"],
    });
    logEvent(deps, opts.edition, "warn", "dedup freshness stale — decisão do editor pendente", { details: freshnessJson });
  } else if (freshnessRes.code === 0) {
    logEvent(deps, opts.edition, "info", "dedup freshness ok", { details: freshnessJson });
  } else {
    logEvent(deps, opts.edition, "warn", "check-dedup-freshness falhou inesperadamente", { details: { code: freshnessRes.code } });
  }

  // 0h.1 — beehiiv-sync; posts_needing_clicks vira dispatch pendente (0h.2).
  if (beehiivSyncRes.code === 0) {
    const syncJson = parseStepJson<{ posts_needing_clicks?: Array<{ id: string; title: string; email_clicks?: number }> }>(beehiivSyncRes.stdout);
    const manifest = syncJson?.posts_needing_clicks ?? [];
    if (manifest.length > 0) {
      const manifestPath = `${editionDir}/_internal/posts-needing-clicks.json`;
      let manifestWritten = true;
      try {
        deps.writeFile(resolve(deps.rootDir, manifestPath), JSON.stringify(manifest, null, 2) + "\n");
      } catch (err) {
        manifestWritten = false;
        // fail-soft — mesmo padrão do resto do bloco 0h — mas registrado,
        // nunca engolido: um manifest fantasma faria o orchestrator
        // despachar beehiiv-clicks-enricher sem arquivo pra ler.
        logEvent(deps, opts.edition, "warn", "0h.2 — falha ao gravar posts-needing-clicks.json", {
          details: { manifestPath, error: err instanceof Error ? err.message : String(err) },
        });
        report.note(`⚠️  0h.2 — falha ao gravar ${manifestPath}: manifest não persistido (fail-soft, não bloqueia Stage 0).`);
      }
      if (manifestWritten) {
        pendingAgentDispatch.push({
          step: "0h.2",
          agent: "beehiiv-clicks-enricher",
          detail: `${manifest.length} post(s) precisam de enrichment de clicks — dispatch via Agent(subagent_type="beehiiv-clicks-enricher"), 1 item por linha "post_id=<id> title=<title>"; validar depois com verify-clicks-enrichment.ts (#4732)`,
          manifestPath,
        });
      }
    }
  } else {
    logEvent(deps, opts.edition, "warn", "beehiiv-sync falhou — CTR pode ficar desatualizado");
  }

  // 0h.3 — build CTR (sequencial após 0h.1; roda mesmo sem 0h.2, fail-soft).
  softStep(deps, report, "build-link-ctr (0h.3)", "scripts/build-link-ctr.ts", []);

  // --- 0i: audience refresh (sequencial, depende de 0h) ---
  softStep(deps, report, "update-audience (0i)", "scripts/update-audience.ts", []);
  softStep(deps, report, "snapshot-audience-profile (0i)", "scripts/snapshot-audience-profile.ts", ["--edition-dir", editionDir]);

  // --- 0j: pending issue drafts (script detecta; decisão s/n/d é humana) ---
  const draftsResult = deps.exec("scripts/find-pending-issue-drafts.ts", ["--current", opts.edition, "--window", "3"]);
  if (draftsResult.code === 0) {
    const drafts = parseStepJson<Array<{ edition: string; signal_count: number }>>(draftsResult.stdout) ?? [];
    if (drafts.length > 0) {
      pendingHumanDecision.push({
        step: "0j",
        detail: `${drafts.length} edição(ões) anterior(es) com issues-draft não-processados: ${drafts.map((d) => `${d.edition} (${d.signal_count} signal(s))`).join(", ")}`,
        prompt: "processar agora?",
        options: ["s = disparar Agent(auto-reporter) multi-edition", "n = pular, manter drafts", "d = dismiss (marcar processados sem criar issues)"],
      });
    }
  } else {
    logEvent(deps, opts.edition, "warn", "find-pending-issue-drafts falhou");
  }

  // --- 0k: verificação FB + social worker da edição anterior (fail-soft) ---
  const prevFbResult = deps.exec("scripts/find-last-edition-with-fb.ts", ["--current", opts.edition]);
  const prevDir = prevFbResult.code === 0 ? prevFbResult.stdout.trim() : "";
  if (prevDir) {
    if (deps.existsSync(resolve(deps.rootDir, "data", ".fb-credentials.json"))) {
      softStep(deps, report, "verify-facebook-posts (0k)", "scripts/verify-facebook-posts.ts", ["--edition-dir", `${prevDir}/`]);
    }
    softStep(deps, report, "verify-social-worker-dispatch (0k)", "scripts/verify-social-worker-dispatch.ts", ["--edition-dir", `${prevDir}/`]);
  }

  // --- 0l: status determinístico de social da edição anterior ---
  const prevSocialArgs = prevDir ? ["--prev-dir", prevDir, "--prev-edition", prevDir.split(/[\\/]/).pop() ?? ""] : ["--prev-dir", "", "--prev-edition", ""];
  const prevStatusResult = deps.exec("scripts/check-prev-social-status.ts", [...prevSocialArgs, "--json"]);
  if (prevStatusResult.code !== 0) {
    logEvent(deps, opts.edition, "warn", "check-prev-social-status falhou — status social da edição anterior não verificado", {
      details: { code: prevStatusResult.code },
    });
    report.note(`⚠️  0l — check-prev-social-status.ts falhou (exit ${prevStatusResult.code}): status social da edição anterior não verificado, sem alerta possível.`);
  }
  const prevStatusJson = parseStepJson<{ findings?: Array<{ line?: string }>; total?: number }>(prevStatusResult.stdout);
  if (prevStatusJson?.total && prevStatusJson.total > 0) {
    logEvent(deps, opts.edition, "warn", "edição anterior tem posts sociais que exigem atenção", { details: prevStatusJson, informational: true });
    report.note(`⚠️  edição anterior: ${prevStatusJson.total} finding(s) de status social — ver detalhes no run-log.`);
  }

  // --- 0z: invariantes globais + fechar Stage 0 ---
  const invariantsResult = deps.exec("scripts/check-invariants.ts", ["--stage", "0"]);
  if (invariantsResult.stderr.trim()) console.error(invariantsResult.stderr.trim());
  if (invariantsResult.code === 1) {
    const violations = parseStepJson<{ violations?: unknown[] }>(invariantsResult.stdout);
    throw new Stage0Abort(`❌ check-invariants --stage 0 falhou: ${JSON.stringify(violations?.violations ?? [])}`);
  }
  if (invariantsResult.code !== 0) {
    throw new Stage0Abort(`❌ check-invariants --stage 0 erro inesperado (exit ${invariantsResult.code}).`);
  }

  step(deps, report, "update-stage-status --stage 0 --status done", "scripts/update-stage-status.ts", ["--edition-dir", editionDir, "--stage", "0", "--status", "done"]);

  const usageResult = deps.exec("scripts/capture-stage-usage.ts", ["--edition-dir", editionDir, "--stage", "0"]);
  const usageJson = parseStepJson<{ source?: string; reason?: string }>(usageResult.stdout);
  if (usageJson?.source === "unavailable") {
    logEvent(deps, opts.edition, "warn", "stage_usage_capture_unavailable", { details: { reason: usageJson.reason } });
  }

  if (opts.preGate === false) {
    report.note("ℹ️  --pre-gate não foi passado (ou é false) — 0-replies permanece delegado ao orchestrator, mas o playbook o pularia por completo neste modo (headless).");
  }

  return {
    code: 0,
    phase: "continue",
    editionDir,
    editionIso,
    anchorIso,
    cutoffIso,
    windowDays,
    clariceRest,
    cloudflareTokenOk,
    pendingAgentDispatch,
    pendingHumanDecision,
    delegatedSteps: DELEGATED_STEPS,
    notes: report.notes,
  };
}

// ---------------------------------------------------------------------------
// Orquestração principal.
// ---------------------------------------------------------------------------

export async function runStage0(argv: string[], deps: Stage0RunDeps): Promise<Stage0RunResult> {
  const report = new ReportBuilder();
  try {
    const opts = parseStage0RunArgs(argv);

    if (opts.phase === "preflight") {
      const phaseA = await runPhaseA(deps, opts, report, false);
      return {
        code: 0,
        phase: "preflight",
        editionDir: phaseA.editionDir,
        editionIso: phaseA.editionIso,
        anchorIso: phaseA.anchorIso,
        cutoffIso: phaseA.cutoffIso,
        windowDays: phaseA.windowDays,
        clariceRest: phaseA.clariceRest,
        cloudflareTokenOk: phaseA.cloudflareTokenOk,
        needsMcpProbes: {
          chrome: 'mcp__claude-in-chrome__tabs_context_mcp — probe barato, sem side-effect. Resultado vira "--mcp-chrome true|false" na chamada --phase continue.',
          gmail: 'mcp__claude_ai_Gmail__list_labels — probe barato, sem side-effect. Resultado vira "--mcp-gmail true|false".',
          beehiiv: 'mcp__claude_ai_Beehiiv__get_current_user — probe barato, sem side-effect. Resultado vira "--mcp-beehiiv true|false".',
        },
        pendingAgentDispatch: [],
        pendingHumanDecision: [],
        delegatedSteps: DELEGATED_STEPS,
        notes: report.notes,
      };
    }

    return await runContinue(deps, opts, report);
  } catch (e) {
    const abort = e instanceof Stage0Abort ? e : new Stage0Abort(`erro inesperado: ${(e as Error).message}`);
    report.note(`❌ ${abort.message}`);
    return {
      code: abort.code,
      phase: argv.includes("continue") ? "continue" : "preflight",
      pendingAgentDispatch: [],
      pendingHumanDecision: [],
      delegatedSteps: DELEGATED_STEPS,
      notes: report.notes,
    };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const deps = productionDeps(ROOT);
  runStage0(process.argv.slice(2), deps).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    // process.exitCode (não process.exit()) — deixa o event loop drenar
    // sozinho, mesmo padrão de clarice-novos-run.ts/audience-run.ts.
    process.exitCode = r.code;
  });
}
