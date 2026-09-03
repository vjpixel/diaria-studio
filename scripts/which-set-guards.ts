/**
 * scripts/which-set-guards.ts (#7056)
 *
 * Responde, de forma DETERMINÍSTICA, "dado este diff, quais GUARDS DE
 * CONJUNTO precisam rodar antes do push?" — mapa executável em vez de
 * memória/prosa.
 *
 * ## Por que existe
 *
 * `master` ficou vermelho em `c8fcdc9b` (PR #7038, #7030) com os 8 checks do
 * PR verdes no momento do merge. O PR converteu `workers/artigos` de assets
 * estáticos para scripted worker — isso fez o worker passar a ser MEMBRO de
 * dois guards que varrem `workers/*` inteiro
 * (`test/workers-observability-guard.test.ts`,
 * `test/worker-bundle-node-only-imports.test.ts`), e ele não satisfazia o
 * que os dois exigem. A disciplina local de #2959 ("rode só os arquivos de
 * teste AFETADOS") não pegou isso: nenhum dos dois arquivos de teste foi
 * TOCADO pelo diff — o diff mudou QUEM ENTRA na varredura deles, não o
 * comportamento de um arquivo com teste próprio. Esse buraco só aparece no
 * CI completo, ou seja, depois do merge.
 *
 * Este módulo é a Direção 1 da issue #7056: um script que, dado
 * `git diff --name-only`, aponta os guards de CONJUNTO cujo veredito pode
 * ter mudado — pra rodar ao lado do ratchet de typecheck + testes afetados
 * (`context/overnight-dispatch-rules.md` item 4), sem depender de lembrar a
 * lista.
 *
 * ## O que é um "guard de conjunto"
 *
 * Um teste que itera sobre uma COLEÇÃO inteira (workers, hubs, seeds, tasks
 * agendadas, imports de `scripts/lib/`) e cujo veredito pode mudar quando
 * QUALQUER membro dela muda — mesmo que o arquivo de teste em si nunca seja
 * tocado. Levantamento inicial da issue (#7056), não necessariamente
 * exaustivo — ver `SET_GUARDS` abaixo.
 *
 * ## Contrato
 *
 * `matchingSetGuards` é PURO (recebe os paths, não consulta git nem disco) —
 * testável sem repo. O CLI é quem chama `git diff --name-only`, mesmo padrão
 * de `scripts/lib/sensitive-path-guard.ts` (#6277), de quem este módulo reusa
 * o motor de glob (`matchesGlob`) em vez de duplicá-lo.
 *
 * Uso:
 *   npx tsx scripts/which-set-guards.ts                    # git diff contra origin/master (fallback master)
 *   npx tsx scripts/which-set-guards.ts --base master
 *   npx tsx scripts/which-set-guards.ts --files a.ts,b.ts
 *   npx tsx scripts/which-set-guards.ts --json
 *
 * Sempre exit 0 quando a pergunta pôde ser respondida (a resposta é o texto/
 * JSON, não o exit code — este script é informativo, não um gate que falha o
 * build; quem decide rodar os testes listados é quem o invoca). Exit 1 só
 * quando não deu pra responder (git falhou, argumento inválido) — mesmo
 * padrão de `sensitive-path-guard.ts`.
 */

import { execFileSync } from "node:child_process";
import { matchesGlob } from "./lib/sensitive-path-guard.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { ORCHESTRATOR_FILES } from "./lib/orchestrator-files.ts";

/**
 * Um guard de conjunto: o(s) arquivo(s) de teste que cobrem a varredura, os
 * padrões de path (subconjunto de glob de `matchesGlob` — `*`, `**`, `{a,b}`)
 * que sinalizam "um membro do conjunto pode ter mudado", e a razão pela qual
 * o guard não aparece na disciplina padrão de "só os testes afetados".
 */
export interface SetGuardRule {
  readonly id: string;
  readonly description: string;
  readonly testFiles: readonly string[];
  readonly triggerPatterns: readonly string[];
  readonly reason: string;
}

/**
 * Levantamento inicial (#7056), não exaustivo — ver docstring do módulo.
 * Adicionar aqui quando um guard novo varrer um conjunto (workers, hubs,
 * seeds, tasks, etc.) em vez de cobrir 1 arquivo.
 */
export const SET_GUARDS: readonly SetGuardRule[] = [
  {
    id: "workers-observability-guard",
    description:
      "todo worker com main= + rota pública (custom_domain) precisa de [observability] enabled=true (#5920)",
    testFiles: ["test/workers-observability-guard.test.ts"],
    triggerPatterns: ["workers/*/wrangler.toml"],
    reason:
      "varre TODO workers/*/wrangler.toml pra decidir violação — editar/criar o wrangler.toml de UM worker " +
      "(ex: dar main= a um worker antes static-only) muda o veredito sobre TODOS, mas o teste em si nunca é tocado",
  },
  {
    id: "worker-bundle-node-only-imports",
    description:
      "nenhum worker pode alcançar fileURLToPath(import.meta.url) no bundle — varre a partir do entrypoint " +
      "de cada worker (#4318)",
    testFiles: ["test/worker-bundle-node-only-imports.test.ts"],
    triggerPatterns: ["workers/*/wrangler.toml", "workers/*/src/**"],
    reason:
      "converter um worker de static assets pra scripted (ganhar main=/src/index.ts) muda QUEM entra na " +
      "varredura — o próprio incidente de origem desta issue (#7030/PR #7038). ESCOPO HONESTO: não cobre " +
      "editar um arquivo em scripts/lib/** que já É reachable por um worker EXISTENTE (o incidente original " +
      "do #4318) — isso exigiria conhecer o grafo de imports pra saber quais scripts/lib/** afetam qual " +
      "worker, o que este mapa por PADRÃO DE PATH não calcula; cobrir só quando o CONJUNTO de workers muda " +
      "(entra/converte um worker) é o recorte deliberado desta issue",
  },
  {
    id: "hub-page-drift",
    description:
      "assets committed workers/arquivo/src/hubs/*.generated.ts + índice precisam refletir o conteúdo/meta " +
      "atuais (#4558/#4790/#5256)",
    testFiles: ["test/hub-page-drift.test.ts", "test/hub-index-page-drift.test.ts"],
    triggerPatterns: [
      "scripts/lib/hubs/**",
      "workers/arquivo/src/hubs/**",
      "scripts/build-hub-page.ts",
      "scripts/lib/shared/hub-page.ts",
      "scripts/lib/shared/hub-index-page.ts",
    ],
    reason:
      "editar o conteúdo/meta de um hub sem regenerar o .generated.ts correspondente (npx tsx " +
      "scripts/build-hub-page.ts --all) só aparece no CI completo — nenhum teste de arquivo isolado cobre",
  },
  {
    id: "seed-html-sync",
    description: "seed de cursos/livros mudou sem o HTML gerado correspondente no mesmo diff (#3105)",
    testFiles: ["test/check-seed-html-sync.test.ts"],
    triggerPatterns: ["seed/courses/**", "seed/books/**"],
    reason:
      "o teste cobre a lógica pura do check (findDriftedPairs); o sintoma real (seed sem HTML) só aparece " +
      "comparando os DOIS lados do par no mesmo diff, que é exatamente o que este mapa recalcula",
  },
  {
    id: "scheduled-tasks",
    description:
      "registro declarativo de tasks agendadas — estrutura interna + drift contra " +
      "docs/scheduled-tasks-registry.md (#4805/#5408/#4819)",
    testFiles: [
      "test/scheduled-tasks.test.ts",
      "test/scheduled-tasks-drift.test.ts",
      "test/scheduled-tasks-4819.test.ts",
    ],
    triggerPatterns: ["scripts/lib/scheduled-tasks.ts", "docs/scheduled-tasks-registry.md"],
    reason:
      "adicionar/remover/renomear uma task no registro varre o array SCHEDULED_TASKS inteiro contra o doc — " +
      "nenhum teste de arquivo isolado cobre a task nova",
  },
  {
    id: "lib-boundary",
    description: "fronteira shared/diaria/mensal + lib→studio-ui dentro de scripts/lib (#2747)",
    testFiles: ["test/lib-boundary.test.ts"],
    triggerPatterns: ["scripts/lib/**", "scripts/studio-ui/**"],
    reason:
      "qualquer import novo dentro de scripts/lib/** pode cruzar a fronteira proibida — o teste varre TODOS " +
      "os imports do diretório inteiro a cada rodada, não só o arquivo tocado",
  },
  {
    id: "orchestrator-prompt-snapshot",
    description:
      "hash agregado de .claude/agents/orchestrator*.md contra o snapshot committed (#634 frente C)",
    testFiles: ["test/orchestrator-prompt.test.ts"],
    // Basenames de ORCHESTRATOR_FILES (scripts/lib/orchestrator-files.ts, fonte
    // única compartilhada com o teste — #7277) viram patterns exatos sob
    // .claude/agents/. Path exato, não glob "orchestrator*.md": o array é a
    // lista real que o hash cobre, e um arquivo novo em .claude/agents/ que
    // comece com "orchestrator" mas NÃO esteja no array ainda não entra no
    // hash — apontar o guard pra ele seria um falso positivo.
    triggerPatterns: ORCHESTRATOR_FILES.map((f) => `.claude/agents/${f}`),
    reason:
      "which-set-guards --files .claude/agents/orchestrator-stage-4.md respondia 'nenhum guard afetado' " +
      "(#7277) — o hash agregado do teste muda quando QUALQUER arquivo do conjunto muda, mas nenhum deles " +
      "isoladamente é 'o' arquivo de teste tocado, então a disciplina de #2959 não pegava. Já derrubou master " +
      "1x (PR #7271, #6767). Rodar com NODE_TEST_SNAPSHOTS=1 quando a mudança for intencional (ver docstring " +
      "de test/orchestrator-prompt.test.ts) — formatReport() não passa a env var, só nomeia o teste a rodar.",
  },
];

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Um guard cujo(s) padrão(ões) casaram com >=1 path mudado, e quais. */
export interface SetGuardHit {
  readonly ruleId: string;
  readonly description: string;
  readonly testFiles: readonly string[];
  readonly reason: string;
  readonly matchedPaths: readonly string[];
}

export interface SetGuardReport {
  readonly triggered: boolean;
  readonly hits: readonly SetGuardHit[];
  /** `testFiles` de todos os hits, deduplicado — pronto pra colar num `npx tsx --test`. */
  readonly testFilesToRun: readonly string[];
}

/**
 * Classifica um conjunto de paths alterados contra `SET_GUARDS`. PURO — não
 * consulta git, não lê disco. Paths vazios/whitespace são ignorados (saída
 * comum de `git diff --name-only`).
 */
export function matchingSetGuards(paths: readonly string[]): SetGuardReport {
  const normalized = paths.map(normalizePath).filter(Boolean);
  const hits: SetGuardHit[] = [];
  const testFilesSet = new Set<string>();
  for (const rule of SET_GUARDS) {
    const matchedPaths = normalized.filter((p) =>
      rule.triggerPatterns.some((pattern) => matchesGlob(p, pattern)),
    );
    if (matchedPaths.length === 0) continue;
    hits.push({
      ruleId: rule.id,
      description: rule.description,
      testFiles: rule.testFiles,
      reason: rule.reason,
      matchedPaths,
    });
    for (const f of rule.testFiles) testFilesSet.add(f);
  }
  return { triggered: hits.length > 0, hits, testFilesToRun: [...testFilesSet] };
}

/** Mensagem humana — o comando pronto pra rodar, não só "tem guard afetado". */
export function formatReport(report: SetGuardReport): string {
  if (!report.triggered) {
    return "which-set-guards: nenhum guard de conjunto afetado por este diff.";
  }
  const lines = report.hits.map((hit) => {
    const paths = hit.matchedPaths.map((p) => `      ${p}`).join("\n");
    return (
      `  - ${hit.ruleId}\n` +
      `      ${hit.description}\n` +
      `      por quê: ${hit.reason}\n` +
      `    path(s) que dispararam:\n${paths}`
    );
  });
  return (
    `which-set-guards: ${report.hits.length} guard(s) de conjunto afetado(s):\n${lines.join("\n")}\n\n` +
    `Rode antes do push:\n  npx tsx --test ${report.testFilesToRun.join(" ")}`
  );
}

function changedPathsFromGit(base: string): string[] {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  return out.split("\n");
}

/** `origin/master` preferido, `master` como fallback — mesmo padrão de `resolveBaseRef` em
 * `.claude/hooks/block-pr-create-pii-runtime-artifacts.mjs`. */
function resolveDefaultBase(): string {
  for (const ref of ["origin/master", "master"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", ref], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
      return ref;
    } catch {
      // tenta o próximo
    }
  }
  throw new Error(
    "não achei origin/master nem master via `git rev-parse --verify` — passe --base explicitamente ou --files.",
  );
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  try {
    let paths: string[];
    if (values.files !== undefined) {
      if (values.base !== undefined) {
        throw new Error(
          "--files e --base são mutuamente exclusivos — passar os dois esconde qual venceu. " +
            "Escolha um: --files para uma lista explícita, --base para derivar do git.",
        );
      }
      if (values.files.trim() === "") {
        throw new Error(
          '--files veio vazio. Isso quase sempre é um pipeline que falhou a montante, não "zero arquivos ' +
            'mudaram" — e responder "nenhum guard afetado" sobre um diff não visto é pior que não responder. ' +
            "Se a intenção é mesmo avaliar zero arquivos, não chame o script.",
        );
      }
      paths = values.files.split(",");
    } else {
      paths = changedPathsFromGit(values.base ?? resolveDefaultBase());
    }
    const report = matchingSetGuards(paths);
    if (flags.has("json")) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(formatReport(report) + "\n");
    }
  } catch (e) {
    process.stderr.write(`which-set-guards: erro — ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
