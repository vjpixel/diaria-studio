#!/usr/bin/env npx tsx
/**
 * check-develop-label-cleared.ts (#6271)
 *
 * CLI do gate de **saída** do track Develop — ver `scripts/lib/develop-label-gate.ts`
 * para a lógica pura e o racional completo do mecanismo. Este arquivo só busca
 * os dados via `gh` e imprime o veredito, mesmo padrão de
 * `scripts/check-trade-off-label-cleared.ts` (o guard irmão, #5821) e
 * `scripts/check-state-changed-pending.ts`.
 *
 * Roda na **Fase 2** do `/diaria-develop`, junto dos demais gates de
 * encerramento, antes do relatório compilar. Bloqueia (`exit 1`) quando uma
 * issue que ESTA sessão terminou de trabalhar continua classificando como
 * `develop` — ou seja, a razão que a trouxe pro track foi consumida e a label
 * ficou.
 *
 * Por que ele existe: das 6 ocorrências de `route-issue` em
 * `.claude/skills/diaria-develop/SKILL.md`, uma única é de SAÍDA, e cobre
 * apenas `trade-off-real`. Para `windows` e `develop-track` não havia
 * instrução nenhuma — Develop virou um sink, e a fila do painel passou a
 * crescer com trabalho já feito.
 *
 * Uso:
 *   npx tsx scripts/check-develop-label-cleared.ts --plan data/develop/260826d/plan.json
 *   npx tsx scripts/check-develop-label-cleared.ts --edition 260826d
 *
 * `gh` indisponível/sem rede → fail-soft (#738): warning em stderr e `exit 0`.
 * Nunca travar o encerramento da rodada por causa de CLI ausente ou rate
 * limit — mesmo espírito dos gates irmãos. `plan.json` ausente/ilegível é
 * erro DURO (`exit 2`): não envolve rede, então é sinal de sessão malformada.
 *
 * @see scripts/lib/develop-label-gate.ts (lógica pura + racional)
 * @see scripts/check-trade-off-label-cleared.ts (guard irmão, cobre `trade-off-real`)
 * @see scripts/route-issue.ts (o verbo de saída que a sessão roda pra corrigir)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { normalizeIssues, type IssuesBearing } from "./lib/plan-issues-normalize.ts";
import {
  checkDevelopLabelCleared,
  isWorkFinished,
  type DevelopGateIssueState,
  type DevelopGatePlanIssue,
} from "./lib/develop-label-gate.ts";

const LOG_PREFIX = "[check-develop-label-cleared]";
const GH_TIMEOUT_MS = 20_000;

interface FetchedIssue extends DevelopGateIssueState {
  error?: string;
}

/**
 * Busca labels + corpo de uma issue. Fail-soft — nunca lança; qualquer falha
 * volta como `{ error }` pro chamador degradar (#738). O corpo importa porque
 * `classifyExecTrack` também lê o marcador `aguardando-ate:` de lá.
 */
function fetchIssue(issueNumber: number, cwd: string): FetchedIssue {
  const result = spawnSync(
    "gh",
    ["issue", "view", String(issueNumber), "--json", "labels,body"],
    // Sem `shell: true` de propósito: com array de argumentos ele NÃO escapa
    // nada (só concatena — o Node emite `DEP0190` avisando exatamente isso), e
    // é desnecessário: `spawnSync("gh", [...])` resolve `gh.exe` no Windows
    // normalmente (verificado ao vivo nesta máquina).
    { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS },
  );
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr || `exit ${result.status}`).trim();
    return { number: issueNumber, labels: [], error: reason };
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      labels?: Array<{ name?: string } | string>;
      body?: string;
    };
    const labels = (parsed.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l?.name))
      .filter((n): n is string => typeof n === "string" && n !== "");
    return { number: issueNumber, labels, body: parsed.body ?? "" };
  } catch (e) {
    return { number: issueNumber, labels: [], error: `JSON malformado: ${(e as Error).message}` };
  }
}

function resolvePlanPath(values: Record<string, string>, cwd: string): string {
  if (values.plan) return resolve(cwd, values.plan);
  if (values.edition) return resolve(cwd, "data", "develop", values.edition, "plan.json");
  throw new Error("passe --plan <caminho> ou --edition AAMMDD");
}

function main(): void {
  const cwd = process.cwd();
  const { values } = parseArgs(process.argv.slice(2));

  let planPath: string;
  try {
    planPath = resolvePlanPath(values, cwd);
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} ${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  // plan.json não envolve rede — ausente/ilegível é sessão malformada, erro
  // duro (mesma escolha de `check-surfaced-live.ts`, #5919).
  if (!existsSync(planPath)) {
    process.stderr.write(`${LOG_PREFIX} plan.json não encontrado: ${planPath}\n`);
    process.exitCode = 2;
    return;
  }
  let planIssues: DevelopGatePlanIssue[];
  try {
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as IssuesBearing<DevelopGatePlanIssue>;
    // `normalizeIssues` e NÃO leitura direta de `plan.issues` (#4817/#4860):
    // o `plan.json` do `/diaria-develop` foi observado ao vivo no formato
    // DICT chaveado pelo número da issue (`data/develop/260808b/plan.json`),
    // apesar do SKILL.md dizer que "reusa o schema do overnight" (array).
    // `for...of` sobre um dict lança `TypeError: ... is not iterable` — é o
    // crash exato que o #4817 corrigiu em `render-overnight-timeline.ts`, e o
    // #4860 achou o mesmo mismatch em mais 4 consumidores que engoliam o dict
    // como vazio, perdendo o dado em silêncio.
    //
    // Achado do fleet review #6320: este era o ÚNICO dos 11 consumidores de
    // `plan.issues` que lia o campo direto. Pior, uma primeira tentativa de
    // correção minha rejeitava "não-array" com `exit 2` — o que teria feito o
    // gate falhar duro justamente sobre o formato legítimo. O normalizador
    // resolve os dois shapes e é o contrato do repo.
    planIssues = normalizeIssues<DevelopGatePlanIssue>(plan);
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} plan.json ilegível (${(e as Error).message}): ${planPath}\n`);
    process.exitCode = 2;
    return;
  }

  // Só as issues que ESTA sessão terminou entram no veredito — as demais o
  // gate ignora por design. Buscar as outras seria trabalho jogado fora E
  // superfície de falha a mais: cada `gh issue view` é síncrono com timeout de
  // 20s, então um plano de 40 issues levaria até ~13min e cada timeout viraria
  // uma issue "não consultada" (achado do fleet review, #6320). Filtrar aqui
  // colapsa isso pro que de fato importa — num plano de 42 issues com 3
  // mergeadas, são 3 buscas em vez de 42.
  const toFetch = planIssues.filter(isWorkFinished);

  const states: DevelopGateIssueState[] = [];
  const fetchErrors: string[] = [];
  for (const issue of toFetch) {
    const fetched = fetchIssue(issue.number, cwd);
    if (fetched.error) {
      fetchErrors.push(`#${issue.number}: ${fetched.error}`);
      continue;
    }
    states.push(fetched);
  }

  // Toda busca falhou E havia o que buscar → é rede/CLI, não veredito.
  // Degradar em silêncio aqui seria pior: o gate passaria dizendo "ok" sobre
  // dado que não conseguiu ler (a doença que o #6303 corrigiu no guard de
  // merge — estado indeterminado nunca deve virar aprovação implícita).
  // `toFetch`, não `planIssues`: um plano só com issues NÃO terminais não tem
  // nada a consultar, e reportar "o gate não rodou" ali seria alarme falso na
  // direção oposta — o gate rodou e concluiu, corretamente, que não havia o
  // que avaliar.
  if (states.length === 0 && toFetch.length > 0) {
    process.stderr.write(
      `${LOG_PREFIX} nenhuma issue pôde ser consultada via gh (${fetchErrors.length} falha(s)) — ` +
        `fail-soft (#738), exit 0. NÃO é um veredito de "sem resíduo": o gate não rodou.\n` +
        fetchErrors.map((e) => `  ${e}\n`).join(""),
    );
    return;
  }
  if (fetchErrors.length > 0) {
    process.stderr.write(
      `${LOG_PREFIX} ${fetchErrors.length} issue(s) não consultada(s), avaliando as demais:\n` +
        fetchErrors.map((e) => `  ${e}\n`).join(""),
    );
  }

  const result = checkDevelopLabelCleared(planIssues, states);

  for (const j of result.justified) {
    process.stdout.write(
      `${LOG_PREFIX} #${j}: segue em Develop com justificativa explícita (develop_track_justificado) — ok\n`,
    );
  }

  if (result.ok) {
    // A ressalva vai DENTRO da linha de veredito, não só num stderr anterior
    // (achado HIGH do fleet review #6320). Sem isto, uma falha PARCIAL do `gh`
    // produzia "ok — nenhum resíduo" com `exit 0`, e a issue que TINHA resíduo
    // podia ser exatamente a que deu timeout. É literalmente a doença que o
    // #6303 acabou de corrigir no guard de merge — "estado indeterminado nunca
    // vira aprovação implícita" — reintroduzida aqui pelo caminho parcial.
    const ressalva =
      fetchErrors.length > 0
        ? ` — ATENÇÃO: ${fetchErrors.length} issue(s) NÃO consultada(s) (ver stderr acima), FORA deste veredito`
        : "";
    process.stdout.write(
      `${LOG_PREFIX} ok — ${result.cleared.length} issue(s) terminada(s) confirmada(s) sem resíduo${ressalva}.\n`,
    );
    return;
  }

  process.stdout.write(
    `${LOG_PREFIX} ${result.findings.length} issue(s) TERMINADA(S) nesta sessão continuam classificando ` +
      "como Develop:\n",
  );
  for (const f of result.findings) {
    process.stdout.write(
      `  #${f.number} (status: ${f.status}) — label(s) que mantêm em Develop: ${f.developLabels.join(", ") || "(nenhuma; ver corpo)"}\n` +
        `     A razão que a trouxe pro Develop ainda existe? Se NÃO:\n` +
        `       npx tsx scripts/route-issue.ts --issue ${f.number} --track {overnight|bloqueada} --reason "..."\n` +
        `     Se SIM (ex: parte 2 segue exigindo Chrome logado), grave o porquê em\n` +
        `     develop_track_justificado no plan.json desta issue.\n`,
    );
  }
  process.stdout.write(
    `${LOG_PREFIX} Develop é um sink se ninguém rotear PRA FORA (#6271) — a fila do painel passa a\n` +
      "  crescer com trabalho já feito, e o editor perde a distinção que a Triagem existe pra dar.\n",
  );
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main();
}
