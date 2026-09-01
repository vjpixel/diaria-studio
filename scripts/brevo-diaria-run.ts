#!/usr/bin/env node
/**
 * brevo-diaria-run.ts (#5192, escopo 1/3 da issue — brevo-diaria)
 *
 * Orquestrador DETERMINÍSTICO dos Passos 1-4 de `/diaria-brevo-diaria`
 * (`.claude/skills/diaria-brevo-diaria/SKILL.md`) — atualização de contatos
 * (evaluate-brevo-diaria.ts) + refresh do pool Pending
 * (refresh-pending-pool.ts + score-pending-origin.ts +
 * verify-pending-emails-mv.ts) + proposta/aplicação de rampa
 * (sync-pending-to-brevo.ts). Mesmo padrão de `scripts/clarice-novos-run.ts`
 * (#4941): hoje o LLM é o *glue* entre 5 sub-scripts — lê stderr de cada um,
 * decide a sequência, aplica a ordem certa na hora da mutação real. A ordem
 * em si é FIXA e já documentada em prosa no Passo 4 do SKILL.md — não há
 * julgamento editorial nela, só risco de um humano/LLM esquecer um passo ou
 * inverter a ordem numa sequência que muta contatos Beehiiv/Brevo de
 * verdade (#573 — só código determinístico devia estar no caminho de uma
 * mutação real e correr o risco de virar task agendada).
 *
 * ESCOPO DELIBERADAMENTE PARCIAL (#5192, passo de scoping obrigatório da
 * issue) — só os Passos 1-4 (contatos + rampa) viraram código aqui. Os
 * Passos 5-8 (preview de campanha, gate de copy, criação, agendamento) NÃO:
 * cada um já é uma ÚNICA invocação de `publish-daily-brevo.ts` cercada por
 * um gate humano real (Passo 6: revisão de copy; Passo 8: confirmação de
 * `scheduledAt`), sem encadeamento de JSON entre múltiplos scripts pra
 * determinizar — escrever um wrapper ali não removeria julgamento nenhum,
 * só indireção sobre um comando que já é de 1 linha. Ver comentário de
 * scoping no PR desta unidade.
 *
 * Dois modos, nunca misturados na mesma invocação:
 *
 *  `--preflight` (default) — roda os 3 dry-runs dos Passos 1-3 em sequência
 *    fixa e devolve o stderr combinado de cada um, SEM mutar nada. É o
 *    material bruto pro gate humano do Passo 4 — apresentar ao editor,
 *    nunca decidir `--max-add` por conta própria.
 *
 *  `--apply --max-add N [--confirm-mv]` — roda a sequência de MUTAÇÃO REAL
 *    na ordem fixa do Passo 4: evaluate --push, refresh-pending-pool --push,
 *    score-pending-origin, verify-pending-emails-mv, sync-pending-to-brevo
 *    --push --max-add N. Só deve ser invocado DEPOIS que o editor confirmou
 *    o gate humano do Passo 4 (o próprio script não pergunta nada — a
 *    confirmação é responsabilidade de quem o invoca, a skill/agente
 *    top-level, exatamente como `clarice-novos-run.ts` nunca pergunta e
 *    depende do kill switch/flags de quem o dispara).
 *    `--max-add 0` é a forma explícita de "nenhum contato novo" (mesma
 *    semântica do `sync-pending-to-brevo.ts` original) — sempre roda os
 *    Passos 1-2 (evaluate + refresh do pool) mesmo com `--max-add 0`, só
 *    não ingere ninguém no Passo 3.
 *    `--confirm-mv` repassa `--confirm` pro `verify-pending-emails-mv.ts`
 *    (guard de custo real, `MV_COST_GUARD_THRESHOLD=500` — criterio 3 de
 *    "Perguntar é exceção" no CLAUDE.md, gasto real acima do trivial).
 *    Default OFF: se o guard disparar, `apply` aborta reportando o motivo
 *    em vez de gastar crédito MV sem confirmação explícita de quem chamou.
 *    `--i-know-this-skips-mv` repassa a mesma flag pro
 *    `sync-pending-to-brevo.ts` (`assertMvGuardAcknowledged` — cobertura
 *    MillionVerifier incompleta no pool ANTIGO, distinto do guard de custo
 *    acima). Default OFF pela mesma razão: ingerir contato sem cobertura MV
 *    completa é uma decisão de risco, não um default silencioso.
 *
 * Cada sub-script é invocado por SPAWN (`process.execPath --import tsx`,
 * mesmo guard #4343 de `scripts/lib/task-runner.ts`/`clarice-novos-run.ts`),
 * nunca por import — spawn preserva stdout/stderr/exit code como contrato
 * único de verdade, sem duplicar guards internos de cada sub-script num
 * segundo lugar.
 *
 * Exit codes:
 *   0 — sucesso (preflight concluído sem mutação / apply concluído sem falhas)
 *   1 — erro duro (sub-script falhou em qualquer ponto da sequência, args
 *       inválidos, exceção inesperada) — a sequência de `apply` PARA no
 *       primeiro passo que falhar, nunca continua pros passos seguintes
 *       (mutação parcial é pior que mutação nenhuma).
 *
 * Uso:
 *   npx tsx scripts/brevo-diaria-run.ts --preflight
 *   npx tsx scripts/brevo-diaria-run.ts --apply --max-add N [--confirm-mv] [--i-know-this-skips-mv]
 *
 * @see .claude/skills/diaria-brevo-diaria/SKILL.md (Passos 1-4 em prosa —
 *      espelha este script; a skill passa a delegar pra cá em vez de
 *      reimplementar os 5 sub-scripts em prosa a cada invocação manual)
 * @see scripts/clarice-novos-run.ts (padrão de referência, #4941)
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";

// Mesma disciplina do #4983 (clarice-novos-run.ts) — carregar .env ANTES de
// qualquer outro código, em module scope, pra process.env já estar populado
// quando os sub-scripts spawnados herdarem o ambiente do processo pai.
loadProjectEnv();

// `new URL("..", import.meta.url).pathname` quebra no Windows — URL pathname
// de um path com drive letter vem com barra inicial ("/C:/Users/..."), e
// path.resolve() nesse formato prefixa o drive atual em vez de descartar a
// barra, produzindo "C:\C:\Users\..." (path inexistente, derruba todo
// spawnSync que usa ROOT como cwd com ENOENT — achado ao vivo rodando
// /diaria-brevo-diaria nesta máquina). fileURLToPath() lida com o drive
// letter corretamente em toda plataforma; ver test/root-path-windows.test.ts
// para a regressão (roda em qualquer SO via `path.win32`, sem precisar de
// máquina Windows no CI).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Spawn de sub-script — injetável pra teste (nenhum spawn real nos testes).
// ---------------------------------------------------------------------------

export interface StepResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (scriptRelPath: string, args: string[]) => StepResult;

/** Default de produção — mesmo padrão de `realExec` em clarice-novos-run.ts:
 * `process.execPath` absoluto, nunca `npx`/PATH-resolved (guard #4343). */
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
        stderr:
          (result.stderr ?? "") +
          `\nERRO: o passo nao executou (falha de spawn): ${result.error?.message ?? "status null"}\n`,
      };
    }
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

// ---------------------------------------------------------------------------
// Abort tipado — sempre code 1, carrega o motivo até o resultado final.
// ---------------------------------------------------------------------------

export class BrevoDiariaAbort extends Error {
  readonly code = 1 as const;
  constructor(reason: string) {
    super(reason);
    this.name = "BrevoDiariaAbort";
  }
}

// ---------------------------------------------------------------------------
// Opções da CLI
// ---------------------------------------------------------------------------

export interface BrevoDiariaRunOptions {
  mode: "preflight" | "apply";
  maxAdd?: number;
  confirmMv: boolean;
  iKnowThisSkipsMv: boolean;
}

/** Pura — lança `BrevoDiariaAbort` em vez de `process.exit` direto, pra ser
 * testável sem matar o processo de teste (mesmo padrão de
 * `parseNovosRunArgs`, só que este parser pode falhar por args inválidos —
 * `clarice-novos-run.ts` nunca precisou disso porque todas as flags dele
 * têm default seguro). */
export function parseBrevoDiariaRunArgs(argv: string[]): BrevoDiariaRunOptions {
  const apply = hasFlag(argv, "apply");
  const preflight = hasFlag(argv, "preflight");
  if (apply && preflight) {
    throw new BrevoDiariaAbort("❌ --apply e --preflight são mutuamente exclusivos — escolha um modo.");
  }
  const confirmMv = hasFlag(argv, "confirm-mv");
  const iKnowThisSkipsMv = hasFlag(argv, "i-know-this-skips-mv");

  if (!apply) {
    // Preflight é o default (nenhuma flag de modo == preflight, mesma
    // convenção "dry-run é o default" do resto do repo) — --max-add não se
    // aplica aqui, é ignorado silenciosamente se passado por engano.
    return { mode: "preflight", confirmMv, iKnowThisSkipsMv };
  }

  const maxAddRaw = getArg(argv, "max-add");
  // #6895 (01/09/2026): `--max-add` virou OPCIONAL em `--apply`, espelhando a
  // semântica que `sync-pending-to-brevo.ts` já tem desde o #6793 Faixa A
  // item 6 (`maxAdd === undefined` → sem teto, `applyMaxAddGate`). Antes
  // desta correção, a flag era exigida incondicionalmente — regressão
  // introduzida pelo próprio #6793 Faixa A item 7, que fez
  // `brevo-diaria-stage5-dispatch.ts` parar de passar `--max-add` (freio de
  // volume removido do dispatch automático) sem atualizar este parser pra
  // aceitar a ausência da flag. Resultado: `--apply` sempre abortava no
  // dispatch automático (bloqueava o canal Brevo diária em toda edição desde
  // o merge do #6793 Faixa A). `--max-add 0` continua a forma explícita de
  // "nenhum contato novo" — ausência da flag agora é "sem teto", nunca 0
  // implícito (`getArg` devolve `""`, nunca `undefined`, quando a flag está
  // ausente — mesma armadilha documentada em verify-pending-emails-mv.ts
  // #4494 — daí a checagem explícita de string vazia abaixo).
  if (maxAddRaw === "") {
    return { mode: "apply", maxAdd: undefined, confirmMv, iKnowThisSkipsMv };
  }
  const maxAdd = Number(maxAddRaw);
  if (!Number.isFinite(maxAdd) || !Number.isInteger(maxAdd) || maxAdd < 0) {
    throw new BrevoDiariaAbort(`❌ --max-add precisa ser um inteiro ≥0 — recebido: "${maxAddRaw}".`);
  }
  return { mode: "apply", maxAdd, confirmMv, iKnowThisSkipsMv };
}

// ---------------------------------------------------------------------------
// Deps injetáveis — produção usa o spawn real; testes injetam um fake.
// ---------------------------------------------------------------------------

export interface BrevoDiariaRunDeps {
  rootDir: string;
  exec: ExecFn;
}

export function productionDeps(rootDir: string = ROOT): BrevoDiariaRunDeps {
  return { rootDir, exec: realExec(rootDir) };
}

// ---------------------------------------------------------------------------
// Passo runner — spawna, loga em stderr do processo pai, registra no
// histórico de passos, e lança BrevoDiariaAbort se o exit code não for 0.
// ---------------------------------------------------------------------------

export interface StepLog {
  label: string;
  script: string;
  args: string[];
  code: number;
  stderrTail: string;
}

function step(
  deps: BrevoDiariaRunDeps,
  log: StepLog[],
  label: string,
  scriptRelPath: string,
  args: string[],
): StepResult {
  process.stderr.write(`▶ ${label}\n`);
  const result = deps.exec(scriptRelPath, args);
  if (result.stderr.trim()) process.stderr.write(result.stderr.trim() + "\n");
  const stderrTail = result.stderr.trim().split("\n").slice(-8).join("\n");
  log.push({ label, script: scriptRelPath, args, code: result.code, stderrTail });
  if (result.code !== 0) {
    throw new BrevoDiariaAbort(
      `❌ ${label} falhou (exit ${result.code}): ${stderrTail.split("\n").slice(-4).join(" | ") || "(sem stderr)"}`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Orquestração principal — pura o suficiente pra ser testada com `exec`
// injetado, sem spawn real nem rede.
// ---------------------------------------------------------------------------

export interface BrevoDiariaRunResult {
  code: 0 | 1;
  mode: "preflight" | "apply";
  steps: StepLog[];
  summary: string;
}

export function runBrevoDiaria(argv: string[], deps: BrevoDiariaRunDeps): BrevoDiariaRunResult {
  const steps: StepLog[] = [];
  try {
    const opts = parseBrevoDiariaRunArgs(argv);

    if (opts.mode === "preflight") {
      step(deps, steps, "Passo 1 — evaluate-brevo-diaria (dry-run)", "scripts/evaluate-brevo-diaria.ts", []);
      step(deps, steps, "Passo 2 — refresh-pending-pool (dry-run)", "scripts/refresh-pending-pool.ts", []);
      step(deps, steps, "Passo 3 — sync-pending-to-brevo (dry-run)", "scripts/sync-pending-to-brevo.ts", []);
      return {
        code: 0,
        mode: "preflight",
        steps,
        summary:
          "preflight concluído — nenhuma mutação aplicada. Apresente o stderr dos 3 passos ao editor no gate " +
          "(Passo 4 do SKILL.md) antes de rodar `--apply --max-add N`.",
      };
    }

    // --- apply: ordem FIXA do Passo 4, mutação real ---
    step(deps, steps, "Passo 1 — evaluate-brevo-diaria --push", "scripts/evaluate-brevo-diaria.ts", ["--push"]);
    step(deps, steps, "Passo 2 — refresh-pending-pool --push", "scripts/refresh-pending-pool.ts", ["--push"]);
    step(deps, steps, "Passo 2 — score-pending-origin", "scripts/score-pending-origin.ts", []);
    step(
      deps,
      steps,
      "Passo 2 — verify-pending-emails-mv",
      "scripts/verify-pending-emails-mv.ts",
      opts.confirmMv ? ["--confirm"] : [],
    );
    // #6895: --max-add só é repassado quando explicitamente informado —
    // omissão (opts.maxAdd === undefined) propaga como AUSÊNCIA da flag pro
    // sync-pending-to-brevo.ts, que já trata isso como "sem teto"
    // (applyMaxAddGate, #6793 Faixa A item 6). Nunca inventar um valor aqui.
    const maxAddArgs = opts.maxAdd !== undefined ? ["--max-add", String(opts.maxAdd)] : [];
    const maxAddLabel = opts.maxAdd !== undefined ? ` --max-add ${opts.maxAdd}` : " (sem --max-add, sem teto)";
    step(
      deps,
      steps,
      `Passo 3 — sync-pending-to-brevo --push${maxAddLabel}`,
      "scripts/sync-pending-to-brevo.ts",
      ["--push", ...maxAddArgs, ...(opts.iKnowThisSkipsMv ? ["--i-know-this-skips-mv"] : [])],
    );

    return {
      code: 0,
      mode: "apply",
      steps,
      summary: `apply concluído — 5 passo(s) aplicado(s) na ordem fixa do Passo 4${maxAddLabel}.`,
    };
  } catch (e) {
    const abort = e instanceof BrevoDiariaAbort ? e : new BrevoDiariaAbort(`❌ erro inesperado: ${(e as Error).message}`);
    process.stderr.write(abort.message + "\n");
    // `steps` já reflete quantos passos rodaram até o abort — deduzimos o
    // modo real (não o nominal do argv) a partir de haver algum passo com
    // `--push`/mutação registrado, pra o resultado nunca afirmar "preflight"
    // sobre uma sequência que já mutou dado.
    const mutated = steps.some((s) => s.args.includes("--push"));
    return { code: abort.code, mode: mutated ? "apply" : "preflight", steps, summary: abort.message };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const deps = productionDeps(ROOT);
  const result = runBrevoDiaria(process.argv.slice(2), deps);
  console.log(
    JSON.stringify({
      code: result.code,
      mode: result.mode,
      summary: result.summary,
      steps: result.steps.map((s) => ({ label: s.label, code: s.code })),
    }),
  );
  process.exitCode = result.code;
}
