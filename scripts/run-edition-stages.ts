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
 * precisam rodar NA sessão do editor — quem chama passa `--through 3` e segue
 * com o Stage 4 inline. O runner agendado, que roda desassistido, passa
 * `--through 4`.
 *
 * O ganho está no Stage 4: ele era 581M dos 999M de tokens de entrada da
 * edição 260814 justamente porque herdava o contexto dos stages anteriores.
 * Com 1-3 fora da sessão, ele começa quase limpo — 163M na medição do #5738.
 *
 * **O stdout dos stages nunca volta pra sessão.** Este script imprime só um
 * resumo por stage (ver `formatStagesSummary`). Despejar o `--print` inteiro
 * de 3 stages na conversa do editor recriaria exatamente o contexto que o
 * laço existe para evitar — seria possível "implementar" o #5744 e não
 * economizar nada.
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

function main(): number {
  const { values, flags } = parseArgsLib(process.argv.slice(2));
  const aammdd = values["edition"];
  if (!aammdd || !AAMMDD_RE.test(aammdd)) {
    console.error("Uso: npx tsx scripts/run-edition-stages.ts --edition AAMMDD [--through N] [--json]");
    return 2;
  }

  let plan: EditionStage[];
  try {
    plan = planThrough(values["through"] ? parseInt(values["through"], 10) : 4);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const editionDir = resolveEditionDir(join(ROOT, "data", "editions"), aammdd);

  const result = runEditionStages({
    aammdd,
    editionDir,
    repoRootAbs: ROOT,
    resolveClaudeBin,
    env: claudeCliEnv(process.env),
    plan,
    execFn: execFileSync,
    onProgress: (m) => console.error(m), // progresso vai pro stderr; stdout fica só com o resumo
  });

  if (flags.has("json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatStagesSummary(result, aammdd));
  }
  return result.exitCode;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
