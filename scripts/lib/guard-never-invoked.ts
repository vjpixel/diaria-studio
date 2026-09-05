/**
 * scripts/lib/guard-never-invoked.ts (#7137, item 1 bullet 2)
 *
 * Lógica PURA do guard mecânico do próprio guard: detecta scripts
 * `check-*.ts`/`*-alarm.ts`/`*-gate.ts`/`*-drift-check.ts` sem nenhum ponto
 * de invocação nas superfícies verificáveis LOCALMENTE (fora do escopo
 * deste guard: crons/timers do servidor `helios`, que exigem SSH e não são
 * enumeráveis a partir deste repo — ver docstring do CLI,
 * `scripts/check-guard-never-invoked.ts`).
 *
 * **Padrões de nome cobertos (mais amplos que a leitura literal de "*-check.ts"
 * do corpo da #7137):** a maioria dos 16 scripts medidos manualmente na #7137
 * usa o prefixo `check-*.ts` (ex: `check-highlight-themes.ts`,
 * `check-corrupted-names.ts`), não o sufixo `*-check.ts` — só
 * `task-registry-prose-drift-check.ts` usa o sufixo `-drift-check.ts`
 * literal. Cobrir só o sufixo deixaria passar a maior parte da lista que
 * motivou esta issue. Os 4 padrões reais: prefixo `check-*.ts`, sufixo
 * `*-alarm.ts`, sufixo `*-gate.ts`, sufixo `*-drift-check.ts`.
 *
 * **Corpus de busca — EXATAMENTE o mesmo usado na medição manual da #7137**
 * (corpo da issue, 02/09/2026): `.claude/skills/**`, `.claude/agents/**`,
 * `.claude/hooks/**`, `.claude/settings.json`, `hermes/**`,
 * `.github/workflows/*`, `package.json`, `scripts/lib/scheduled-tasks.ts`,
 * `docs/scheduled-tasks-registry.md`, `scripts/overnight/*`. Deliberadamente
 * NÃO inclui `scripts/**` genérico — um script referenciado só na docstring
 * de outro script (prosa que já provou apodrecer, #7137 comentário de
 * 02/09) não conta como ponto de invocação real. Referência é feita por
 * MATCH DE SUBSTRING do basename (sem extensão) no conteúdo bruto dos
 * arquivos do corpus — mesmo grau de precisão da medição manual original.
 *
 * **Exclusão "irmão -gate.ts armado"** (citada no corpo da #7137, ex:
 * `check-decision-label-drift.ts` × `check-decision-label-drift-gate.ts`)
 * **não precisa de lógica dedicada**: a convenção de nome é sempre
 * `<base>-gate.ts`, então o texto que arma o gate no corpus (ex:
 * `"scripts/check-decision-label-drift-gate.ts"`) já contém o basename do
 * check base como substring/prefixo — o match de substring de
 * `hasInvocationPoint` já cobre os dois automaticamente. (Tentei adicionar
 * uma branch explícita pra isso e descobri, via teste, que ela é
 * inalcançável por construção — removida.)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

export interface GuardCandidate {
  /** Basename sem extensão, ex: "check-highlight-themes". */
  name: string;
  /** Path relativo a `scripts/`, ex: "check-highlight-themes.ts". */
  relPath: string;
}

export type GuardFinding = GuardCandidate;

export interface GuardNeverInvokedReport {
  candidates: GuardCandidate[];
  findings: GuardFinding[];
  /** Candidatos excluídos por `KNOWN_INDIRECT_INVOCATIONS` (cadeia de 2+
   * saltos verificada à mão) — registrados pra transparência do relatório. */
  excludedByKnownIndirectInvocation: (GuardCandidate & { reason: string })[];
}

const NAME_PATTERNS: RegExp[] = [
  /^check-.+\.ts$/,
  /-alarm\.ts$/,
  /-gate\.ts$/,
  /-drift-check\.ts$/,
];

/** Arquivos que nunca contam como corpus de invocação mesmo estando sob um
 * diretório coberto (ex: o próprio teste do guard, se algum dia morar ali). */
const EXCLUDED_SCRIPT_SUFFIXES = [".test.ts"];

export function isGuardCandidateName(filename: string): boolean {
  if (!filename.endsWith(".ts")) return false;
  if (EXCLUDED_SCRIPT_SUFFIXES.some((s) => filename.endsWith(s))) return false;
  return NAME_PATTERNS.some((re) => re.test(filename));
}

/** Lista candidatos em `scriptsDir` (não-recursivo — os 16 originais e os
 * 81 medidos vivem todos direto em `scripts/`, nunca em subpastas). */
export function listGuardCandidates(scriptsDir: string): GuardCandidate[] {
  if (!existsSync(scriptsDir)) return [];
  const entries = readdirSync(scriptsDir);
  const candidates: GuardCandidate[] = [];
  for (const entry of entries) {
    const full = join(scriptsDir, entry);
    if (!statSync(full).isFile()) continue;
    if (!isGuardCandidateName(entry)) continue;
    candidates.push({ name: entry.slice(0, -extname(entry).length), relPath: entry });
  }
  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

/** Enumera recursivamente todos os arquivos de texto sob `dir` (segue
 * qualquer profundidade — usado pra `.claude/**`/`hermes/**`). Ignora
 * `node_modules` caso exista aninhado (não deveria, mas defesa barata). */
function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) out.push(full);
    }
  }
  return out;
}

/** Lista não-recursiva de arquivos diretos de `dir` (usado pra
 * `.github/workflows/*` e `scripts/overnight/*` — só o nível 1). */
function listFilesShallow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((e) => join(dir, e))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

/** Lista dos paths absolutos do corpus primário — exatamente as superfícies
 * citadas no corpo da #7137. Exportado separado de `buildLocalCorpusText`
 * pra permitir inspeção/teste da lista de arquivos por si só. */
export function listPrimaryCorpusFiles(repoRoot: string): string[] {
  const files: string[] = [
    ...walkFiles(join(repoRoot, ".claude", "skills")),
    ...walkFiles(join(repoRoot, ".claude", "agents")),
    ...walkFiles(join(repoRoot, ".claude", "hooks")),
    ...walkFiles(join(repoRoot, "hermes")),
    ...listFilesShallow(join(repoRoot, ".github", "workflows")),
    ...listFilesShallow(join(repoRoot, "scripts", "overnight")),
  ];
  const settingsPath = join(repoRoot, ".claude", "settings.json");
  if (existsSync(settingsPath)) files.push(settingsPath);
  const packageJsonPath = join(repoRoot, "package.json");
  if (existsSync(packageJsonPath)) files.push(packageJsonPath);
  const scheduledTasksPath = join(repoRoot, "scripts", "lib", "scheduled-tasks.ts");
  if (existsSync(scheduledTasksPath)) files.push(scheduledTasksPath);
  const registryDocPath = join(repoRoot, "docs", "scheduled-tasks-registry.md");
  if (existsSync(registryDocPath)) files.push(registryDocPath);
  return files;
}

function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Concatena o conteúdo bruto de todo o corpus verificável localmente.
 * `repoRoot` é a raiz do checkout.
 */
export function buildLocalCorpusText(repoRoot: string): string {
  return listPrimaryCorpusFiles(repoRoot)
    .map(readTextSafe)
    .filter((t): t is string => t !== null)
    .join("\n");
}

/** Um candidato tem ponto de invocação se seu basename (sem extensão)
 * aparece em algum lugar do corpus — mesmo grau de precisão (substring) da
 * medição manual da #7137. */
export function hasInvocationPoint(candidateName: string, corpusText: string): boolean {
  return corpusText.includes(candidateName);
}

/**
 * Exceções curadas à mão — dois motivos distintos pra um candidato sem
 * substring direta no corpus não virar finding:
 *
 * 1. **Cadeia de invocação de 2+ SALTOS** que o corpus (substring direto)
 *    não enxerga — ex: um hook chama um `.sh`, que por sua vez chama o
 *    `.ts` candidato. Tentei resolver isso por fecho transitivo automático
 *    (seguir toda referência `scripts/*.ts` encontrada no corpus,
 *    recursivamente) e descartei: `.claude/skills/*.md` menciona
 *    `scripts/lib/issue-decisions.ts` em prosa (sem ele de fato EXECUTAR
 *    nada), e esse arquivo por sua vez cita
 *    `scripts/check-campaign-docs-sync.ts` como exemplo dentro de um
 *    comentário — o fecho automático marcava esse candidato como "armado"
 *    por transitividade de PROSA, não de execução, o mesmíssimo modo de
 *    falha que a #7137 documentou (prosa que apodrece sem ninguém notar).
 *    Prefiro uma lista curta, revisada por humano, a um heurístico que
 *    confunde "é citado" com "é chamado".
 *
 * 2. **Decisão deliberada de NÃO armar ainda**, já documentada na própria
 *    docstring do script — a #7137 é explícita que isso é uma saída válida
 *    ("vira achado, ou nasce com justificativa explícita"), diferente de
 *    "deixar como está" sem registro. A entrada aqui só espelha a
 *    justificativa que já mora no arquivo, pra este guard não repetir o
 *    achado toda vez que rodar.
 *
 * Cada entrada precisa apontar o código/decisão REAL (não só prosa vaga) —
 * ver justificativa inline. Revisar esta lista a cada PR que a toca, do
 * mesmo jeito que `KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES` em
 * `task-never-armed-alarm.ts` já é revisada.
 */
export const KNOWN_INDIRECT_INVOCATIONS: Record<string, string> = {
  "check-glm-lane-gate":
    "[cadeia indireta] scripts/dispatch-glm-lane-unit.sh chama `npx tsx scripts/check-glm-lane-gate.ts` " +
    "antes de cada despacho (código real, não prosa) — dispatch-glm-lane-unit.sh por sua vez tem ponto " +
    "de invocação real via `npm run glm-lane-dispatch` (package.json, #7137).",
  "check-highlight-themes":
    "[cadeia indireta] scripts/stage-1-run.ts chama `scripts/check-highlight-themes.ts` no passo " +
    "§1w-quint-b (código real) — stage-1-run.ts por sua vez é invocado por " +
    ".claude/agents/orchestrator-stage-1-research.md (`npx tsx scripts/stage-1-run.ts ...`, Etapa 1 do " +
    "orchestrator).",
  "ads-kill-switch-alarm":
    "[decisão deliberada] docstring do próprio script (#5239): NÃO wired de propósito até o editor " +
    "decidir armar (bloqueado por marcador `aguardando-ate` na issue de origem, os 3 canais pagos ainda " +
    "assentando) — nunca chama API paga, invocação é manual (`--dry-run` sempre primeiro). Reavaliar " +
    "quando a issue de origem (#5239) desbloquear.",
  "check-campaign-docs-sync":
    "[decisão deliberada] docstring do próprio script (#5559): 'script de bolso' explícito — rodar em " +
    "CI exigiria `gh` autenticado + rede a cada suíte, e a superfície que protege (`data/`, gitignored) " +
    "não existe em clone fresco/sessão cloud. Coordenador ou editor roda manualmente antes de executar " +
    "uma campanha.",
  "check-secondary-themes":
    "[decisão deliberada] a própria docstring de check-highlight-themes.ts (linhas ~885-899) documenta: " +
    "o CLI/`main()` deste arquivo não é chamado por nenhum orchestrator/skill hoje (só " +
    "check-highlight-themes.ts roda em produção) — consolidação deliberadamente fora de escopo do " +
    "#2716 item 1. O ARQUIVO não é órfão (SECONDARY_BUCKETS é importado como biblioteca por " +
    "dedup-intra-edition.ts, review-highlight-official-swap.ts e check-highlight-themes.ts) — só o CLI " +
    "wrapper (`main()`) é código morto de produção, e mesclá-lo trocaria contrato/algoritmo sem " +
    "cobertura de regressão cross-teste (#7137: decisão é deixar como está, não remover o arquivo " +
    "inteiro).",
};

export function evaluateGuardNeverInvoked(
  candidates: GuardCandidate[],
  corpusText: string,
): GuardNeverInvokedReport {
  const findings: GuardFinding[] = [];
  const excludedByKnownIndirectInvocation: (GuardCandidate & { reason: string })[] = [];

  for (const c of candidates) {
    if (hasInvocationPoint(c.name, corpusText)) continue;
    const knownReason = KNOWN_INDIRECT_INVOCATIONS[c.name];
    if (knownReason) {
      excludedByKnownIndirectInvocation.push({ ...c, reason: knownReason });
      continue;
    }
    findings.push(c);
  }

  return { candidates, findings, excludedByKnownIndirectInvocation };
}
