#!/usr/bin/env node
/**
 * scripts/run-edition-stages.ts (#5744)
 *
 * CLI do laço "uma sessão `claude` por stage" (`scripts/lib/edition-stage-runner.ts`).
 *
 * **Para que serve, e por que não é o runner agendado.** O #5738 pôs esse
 * laço no caminho AGENDADO. Este CLI existe para o caminho INTERATIVO: a
 * sessão do editor roda `/diaria-edicao`, e o Passo 2 da skill chama este
 * script via `Bash` em vez de executar os Stages 1-3 inline. Cada stage roda
 * num processo `claude` próprio — contexto limpo por construção, que é o
 * efeito de um `/clear` entre stages que a própria sessão não consegue
 * produzir em si mesma.
 *
 * **Por que só até o Stage 3 no uso interativo.** Os Stages 1-3 já eram
 * auto-aprovados em `/diaria-edicao` (`auto_approve = true`, pre-gate mode
 * #1523), então spawná-los headless não custa nenhum gate. O Stage 4
 * (revisão) e o Stage 6 (agendamento) são os dois gates humanos de projeto e
 * precisam rodar NA sessão do editor — a skill passa `--through 3` e segue com
 * o Stage 4 inline.
 *
 * **O runner agendado NÃO passa por aqui.** Ele chama `runEditionStages()`
 * direto da lib, com o `STAGE_PLAN` completo. Este CLI existe só para quem
 * precisa invocar o laço a partir de um shell — hoje, a skill interativa.
 *
 * O ganho está no Stage 4: ele era 581M dos 999M de tokens de entrada da
 * edição 260814 justamente porque herdava o contexto dos stages anteriores.
 * Com 1-3 fora da sessão, ele começa quase limpo — 163M na medição do #5738.
 *
 * **O stdout dos stages nunca volta pra sessão.** Quem garante isso é o
 * descarte do stdout do processo `claude` filho dentro de `runEditionStages`
 * — não o split stderr/stdout daqui, que serve para o `--json` sair
 * parseável (o Bash tool entrega os dois fluxos ao agente de qualquer jeito).
 * Este script imprime só um resumo por stage. Despejar o `--print` inteiro de
 * 3 stages na conversa do editor recriaria exatamente o contexto que o laço
 * existe para evitar — seria possível "implementar" o #5744 e não economizar
 * nada.
 *
 * Uso:
 *   npx tsx scripts/run-edition-stages.ts --edition AAMMDD [--through N] [--json]
 *
 * Exit codes: 0 = todos os stages do plano ok/pulados; != 0 = exit code do
 * stage que falhou (o laço para no primeiro erro).
 */

import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts";
import { resolveClaudeBin } from "./lib/resolve-claude-bin.ts";
import { claudeCliEnv } from "./overnight/run-scheduled-edicao.ts";
import {
  STAGE_PLAN,
  runEditionStages,
  formatStagesSummary,
  type EditionStage,
} from "./lib/edition-stage-runner.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AAMMDD_RE = /^\d{6}$/;

/**
 * Stage até onde o CLI vai quando `--through` é omitido.
 *
 * **3, não 4.** O Stage 4 (revisão) carrega um dos dois gates humanos de
 * projeto, e todo stage spawnado por aqui recebe `--no-gates` — o default
 * antigo (4) transformava um comando incompleto num auto-aprovar silencioso
 * do gate de revisão. Quem quer o Stage 4 headless (só o caminho agendado
 * desassistido) passa `--through 4` por escrito.
 */
export const DEFAULT_THROUGH = 3;

/**
 * Corta `STAGE_PLAN` no stage pedido.
 *
 * Um `--through` fora de faixa é ERRO, nunca um corte silencioso: `--through 5`
 * digitado por engano num uso interativo significaria spawnar o Stage 5 com
 * `--no-gates`, e o default do Stage 5 sem `--skip` é dispatchar todos os
 * canais (#1326). `assertNoPublishStage` também barra isso mais adentro —
 * este é o guard que dá a mensagem legível.
 */
export function planThrough(through: number, plan: ReadonlyArray<EditionStage> = STAGE_PLAN): EditionStage[] {
  const max = Math.max(...plan.map((p) => p.stage));
  const min = Math.min(...plan.map((p) => p.stage));
  if (!Number.isInteger(through) || through < min || through > max) {
    throw new Error(
      `--through inválido: ${through}. Aceita ${min}..${max} — os Stages 5 (publicação) e 6 (agendamento) ` +
        `nunca rodam por aqui, exigem ação explícita do editor.`,
    );
  }
  return plan.filter((p) => p.stage <= through);
}

/** Dependências injetáveis — existem só para `main` ser testável sem tocar
 * o `claude` real nem o disco. Mesmo padrão de `run-scheduled-edicao.ts`. */
export interface MainDeps {
  execFn: typeof execFileSync;
  resolveClaudeBinFn: () => string;
  sentinelExistsFn?: (editionDir: string, step: number) => boolean;
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  repoRootAbs: string;
}

export function main(
  argv: string[] = process.argv.slice(2),
  deps: Partial<MainDeps> = {},
): number {
  const {
    execFn = execFileSync,
    resolveClaudeBinFn = resolveClaudeBin,
    sentinelExistsFn,
    env = claudeCliEnv(process.env),
    stdout = (l: string) => console.log(l),
    stderr = (l: string) => console.error(l),
    repoRootAbs = ROOT,
  } = deps;

  const { values, flags } = parseArgsLib(argv);
  const aammdd = values["edition"];
  if (!aammdd || !AAMMDD_RE.test(aammdd)) {
    stderr("Uso: npx tsx scripts/run-edition-stages.ts --edition AAMMDD [--through N] [--json]");
    return 2;
  }

  let plan: EditionStage[];
  try {
    // Default 3, NÃO 4 (achado do review da PR #5753). Rodar este CLI sem
    // `--through` — debug, uso ad hoc — spawnaria o Stage 4 headless com
    // `--no-gates`, auto-aprovando em silêncio o gate humano de revisão, que é
    // um dos dois gates de projeto. O único consumidor real já passa `--through 3`
    // explicitamente; quem quiser o Stage 4 headless pede por escrito.
    plan = planThrough(values["through"] ? parseInt(values["through"], 10) : DEFAULT_THROUGH);
  } catch (e) {
    stderr((e as Error).message);
    return 2;
  }

  const editionDir = resolveEditionDir(join(repoRootAbs, "data", "editions"), aammdd);

  const result = runEditionStages({
    aammdd,
    editionDir,
    repoRootAbs,
    resolveClaudeBin: resolveClaudeBinFn,
    env,
    plan,
    execFn,
    ...(sentinelExistsFn ? { sentinelExistsFn } : {}),
    // Progresso no stderr deixa o stdout parseável quando `--json` é usado.
    // NÃO é o que protege o contexto da sessão — o Bash tool entrega os dois
    // fluxos ao agente de qualquer forma. A proteção real é o descarte do
    // stdout do processo `claude` filho dentro de `runEditionStages`.
    onProgress: stderr,
  });

  if (flags.has("json")) {
    stdout(JSON.stringify(result, null, 2));
  } else {
    stdout(formatStagesSummary(result, aammdd));
  }
  return result.exitCode;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
