/**
 * scripts/track-quality-report.ts (#6755)
 *
 * Métrica de QUALIDADE CONTÍNUA por trilha de execução (`continuo` /
 * `overnight` / `develop` / `other`, derivada do prefixo de `headRefName`
 * — mesma convenção de branch de `context/overnight-dispatch-rules.md`
 * item 2), determinística, zero LLM. Fecha o gap descrito em #6752/#6755:
 * a auditoria de 29/08/2026 que comparou qualidade `continuo` × assinatura
 * Anthropic (retrabalho 23,3% vs 9,8%, 3 de 4 incidentes de master vermelho
 * vindos de `continuo`) custou uma sessão interativa inteira cruzando
 * `gh pr list` à mão — nada daquilo era reprodutível. Este script torna
 * reprodutível.
 *
 * **Escopo desta fatia (decisão do editor, 30/08/2026, comentário #6755):**
 * só o script determinístico com `--json`/`--table`/`--since`. SEM
 * superfície de UI/relatório — o adiamento anterior (`not-this-week` +
 * dependência da #6756) caducou porque a #6756 fechou `COMPLETED`, mas isso
 * só desbloqueou a MÉTRICA, não uma decisão sobre onde exibi-la. Mesmo
 * padrão do #3714: registry/script primeiro, superfície depois de alguém
 * ter visto o número.
 *
 * ## As 4 métricas
 *
 * 1. **Retrabalho** — issue cuja 1ª PR mergeada foi da trilha X e que
 *    precisou de ≥2ª PR mergeada depois (mesmo issue referenciado por
 *    "Closes #N"/"REFS #N" em mais de uma PR mergeada). Atribuída à
 *    trilha da 1ª PR.
 * 2. **Atribuição de quebra de master** — commits em `master` cujo
 *    assunto casa `revert|hotfix|master vermelho` (case-insensitive),
 *    resolvidos até a trilha que introduziu o defeito. Dois caminhos de
 *    resolução, ambos determinísticos e ambos com limite conhecido (ver
 *    `resolveMasterRedCommitTrail`): (a) `git revert` de verdade — o
 *    trailer padrão do Git "This reverts commit <sha>." aponta pro commit
 *    revertido, que é resolvido até a PR/trilha via `gh pr list --search`;
 *    (b) hotfix de uma issue `[daily-review]` que já carrega o marcador
 *    `<!-- origem: pr=N trilha=X commit=SHA -->` (#6756) — a issue
 *    referenciada no assunto do commit de hotfix já teve a trilha causadora
 *    resolvida por aquele mecanismo. Fora desses dois casos, a trilha fica
 *    `desconhecida` — nunca adivinhada.
 * 3. **Densidade de finding do `daily-review` por trilha** (habilitado por
 *    #6756) — conta issues `[daily-review]` por trilha (via o mesmo
 *    marcador `<!-- origem: -->`) e normaliza pelo nº de PRs mergeadas
 *    daquela trilha na mesma janela.
 * 4. **PRs fechadas sem merge por trilha** — trabalho descartado.
 *
 * ## Desenho: pure functions + orquestração fail-soft
 *
 * Mesmo padrão de `scripts/check-continuo-token-instrumentation.ts`: toda a
 * lógica de agregação é pura (`compute*`), testável com fixtures sem tocar
 * `gh`/`git`. `fetchRawInput()` é a única função que chama processos
 * externos (via `spawnSync` direto, não `scripts/lib/shared/gh-run.ts` —
 * `spawnGhSync` usa o `maxBuffer` default de `child_process` (1 MB), que
 * `gh pr list --limit 500 --json ...body...` estoura tranquilamente em
 * repos com centenas de PRs mergeadas: medido ao vivo, 1,57 MB de stdout
 * pra 500 PRs, e o estouro derruba `spawnSync` com `status: null` — o MESMO
 * shape de falha de um timeout, então sem maxBuffer maior aqui toda chamada
 * pesada degradaria silenciosamente pra "seção vazia" mesmo com `gh`
 * saudável) — falha de qualquer chamada individual (rate limit, `gh`
 * indisponível, buffer estourado) degrada aquela seção para lista vazia com
 * um aviso em stderr, nunca lança e nunca derruba as outras 3 métricas.
 *
 * ## `--since`
 *
 * Aceita `Nd` (ex: `30d` = últimos 30 dias) ou uma data ISO (`2026-08-01`).
 * Filtra por `mergedAt`/`closedAt`/`createdAt`/data do commit conforme a
 * métrica. Omitido = sem filtro (todo o histórico visível via `gh`/`git`,
 * sujeito ao teto de paginação de `fetchRawInput`).
 *
 * Uso: `npx tsx scripts/track-quality-report.ts --table [--since 30d]`
 *      `npx tsx scripts/track-quality-report.ts --json [--since 2026-08-01]`
 *
 * ## Escopo explícito: NÃO tem eixo de custo (#6755, comentário 30/08/2026)
 *
 * As 4 métricas acima decidem "qual trilha PRODUZ trabalho que precisa ser
 * refeito" — nenhuma delas mede quanto custou produzir esse trabalho. A
 * discussão que motivou a troca de modelo do contínuo (#6816) combina
 * retrabalho (métrica 1 daqui) com custo por chamada — mas o custo em si
 * fica de fora deste script de propósito: hoje a única chave OpenRouter em
 * uso é de inferência (`is_provisioning_key: false`), e `GET
 * /api/v1/activity` responde `403` — sem quebra de custo por dia/modelo
 * até uma management key existir (bloqueio de credencial, fora do alcance
 * desta sessão). A fonte mais rica que já existe hoje sobre custo é
 * `~/.hermes/logs/agent.log` (por chamada: modelo, provider, tokens
 * in/out) — fora deste repo, não consumida aqui. Quem for calcular "custo
 * por PR mergeada sem retrabalho" precisa cruzar a métrica 1 daqui com uma
 * fonte de custo externa; este módulo não tenta adivinhar esse número.
 */
import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

export type Trail = "continuo" | "overnight" | "develop" | "other";
export const TRAILS: Trail[] = ["continuo", "overnight", "develop", "other"];

// ---------------------------------------------------------------------------
// Parsing puro — sem I/O, todo testável com fixtures.
// ---------------------------------------------------------------------------

/** Deriva a trilha a partir do prefixo de `headRefName`, mesma convenção de
 * `context/overnight-dispatch-rules.md` item 2 e `deriveTrackFromBranch`
 * (Triagem do Studio). Qualquer prefixo fora dos 3 conhecidos → "other". */
export function deriveTrail(headRefName: string | null | undefined): Trail {
  const ref = headRefName ?? "";
  if (ref.startsWith("continuo/")) return "continuo";
  if (ref.startsWith("overnight/")) return "overnight";
  if (ref.startsWith("develop/")) return "develop";
  return "other";
}

/** Extrai números de issue referenciados como "Closes #N" / "closes #N" /
 * "Fixes #N" / "Resolves #N" no corpo de uma PR — convenção do CLAUDE.md
 * ("PR abre com `Closes #NNNN`"). Não casa "REFS #N, NÃO CLOSES" de
 * propósito — issue referenciada mas explicitamente NÃO fechada não conta
 * pra retrabalho (a PR nunca alegou resolver aquela issue por completo). */
export function extractClosesIssueRefs(body: string | null | undefined): number[] {
  if (!body) return [];
  const matches = body.matchAll(/\b(?:closes?|fix(?:es|ed)?|resolves?)\s*:?\s*#(\d+)/gi);
  const nums = new Set<number>();
  for (const m of matches) nums.add(Number(m[1]));
  return [...nums];
}

export interface OrigemMarker {
  pr: number | null;
  trilha: Trail | "desconhecida";
  commit: string | null;
}

/** Parseia o marcador `<!-- origem: pr=N trilha=X commit=SHA -->` que
 * `daily-consolidated-review.sh` grava no corpo das issues `[daily-review]`
 * desde o #6756. `pr`/`trilha` podem vir literalmente "desconhecida" (o
 * próprio review já não sabia resolver) — tratado igual a marcador ausente
 * pros fins desta métrica. Retorna `null` se o marcador não existir. */
export function parseOrigemMarker(body: string | null | undefined): OrigemMarker | null {
  if (!body) return null;
  const m = body.match(/<!--\s*origem:\s*pr=(\S+)\s+trilha=(\S+)\s+commit=(\S+)\s*-->/);
  if (!m) return null;
  const [, prRaw, trilhaRaw, commitRaw] = m;
  const pr = /^\d+$/.test(prRaw) ? Number(prRaw) : null;
  const trilha: Trail | "desconhecida" = (TRAILS as string[]).includes(trilhaRaw)
    ? (trilhaRaw as Trail)
    : "desconhecida";
  const commit = commitRaw === "desconhecida" ? null : commitRaw;
  return { pr, trilha, commit };
}

/** Extrai o sha revertido do trailer padrão do Git ("This reverts commit
 * <sha>.", gerado automaticamente por `git revert`) — só reconhece o
 * formato literal do Git, nunca adivinha a partir de prosa livre. */
export function extractRevertedSha(commitBody: string | null | undefined): string | null {
  if (!commitBody) return null;
  const m = commitBody.match(/This reverts commit ([0-9a-f]{7,40})\./i);
  return m ? m[1] : null;
}

/** Primeiro número de issue/PR referenciado no assunto de um commit
 * ("fix(#6255): ..." → 6255). Usado só como candidato pra resolução via
 * marcador de origem de uma issue `[daily-review]` — nunca sozinho como
 * prova de causa. */
export function extractFirstIssueRef(subject: string | null | undefined): number | null {
  if (!subject) return null;
  const m = subject.match(/#(\d+)/);
  return m ? Number(m[1]) : null;
}

const MASTER_RED_PATTERN = /revert|hotfix|master\s+vermelho/i;

/** Um commit em `master` "conta" como incidente de quebra se o assunto casa
 * o padrão — mesmo critério em prosa que a auditoria de 29/08/2026 usou
 * ("commits cujo título casa `master vermelho|hotfix|revert`", #6755). */
export function isMasterRedCommit(subject: string): boolean {
  return MASTER_RED_PATTERN.test(subject);
}

export interface MasterRedResolutionContext {
  /** sha (curto ou completo) do commit revertido -> trilha da PR que o
   * introduziu, quando resolvível via `gh pr list --search`. */
  revertedShaToTrail: Map<string, Trail>;
  /** nº de issue -> marcador de origem já resolvido (ou `undefined` se a
   * issue não tiver marcador / não existir na amostra coletada). */
  issueOrigemByNumber: Map<number, OrigemMarker | undefined>;
}

/** Resolve a trilha causadora de UM commit de quebra de master, pura
 * (recebe os mapas já resolvidos por `fetchRawInput`, nunca chama
 * `gh`/`git` diretamente — só assim é testável sem depender de rede).
 * Ordem de tentativa: (a) trailer de revert real; (b) issue referenciada no
 * assunto que já carrega marcador de origem (#6756). Nenhum dos dois →
 * "desconhecida", nunca um palpite. */
export function resolveMasterRedCommitTrail(
  commit: { subject: string; body: string },
  ctx: MasterRedResolutionContext,
): Trail | "desconhecida" {
  const revertedSha = extractRevertedSha(commit.body);
  if (revertedSha) {
    const trail = ctx.revertedShaToTrail.get(revertedSha);
    if (trail) return trail;
  }
  const issueNum = extractFirstIssueRef(commit.subject);
  if (issueNum != null) {
    const origem = ctx.issueOrigemByNumber.get(issueNum);
    if (origem && origem.trilha !== "desconhecida") return origem.trilha;
  }
  return "desconhecida";
}

// ---------------------------------------------------------------------------
// Métricas puras — recebem dados já coletados, nunca tocam gh/git.
// ---------------------------------------------------------------------------

export interface MergedPrRecord {
  number: number;
  headRefName: string;
  mergedAt: string; // ISO
  body: string;
  mergeCommitSha?: string;
}

export interface ReworkMetric {
  trail: Trail;
  issues_total: number;
  issues_reworked: number;
  rate: number | null; // null quando issues_total === 0 (sem base pra taxa)
}

/** Métrica 1 — retrabalho por trilha. Agrupa PRs mergeadas por issue
 * referenciada (via `extractClosesIssueRefs`); ordena o grupo por
 * `mergedAt`; a trilha da 1ª PR do grupo "possui" a issue; `>=2` PRs no
 * grupo = retrabalho atribuído a essa trilha. PR que não referencia
 * nenhuma issue via Closes/Fixes/Resolves não entra na base (não há como
 * agrupar retrabalho sem saber a qual issue ela pertence). */
export function computeReworkRate(mergedPrs: MergedPrRecord[]): ReworkMetric[] {
  const byIssue = new Map<number, MergedPrRecord[]>();
  for (const pr of mergedPrs) {
    for (const issueNum of extractClosesIssueRefs(pr.body)) {
      const arr = byIssue.get(issueNum) ?? [];
      arr.push(pr);
      byIssue.set(issueNum, arr);
    }
  }
  const totals = new Map<Trail, { total: number; reworked: number }>();
  for (const trail of TRAILS) totals.set(trail, { total: 0, reworked: 0 });

  for (const prs of byIssue.values()) {
    const sorted = [...prs].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
    const ownerTrail = deriveTrail(sorted[0].headRefName);
    const bucket = totals.get(ownerTrail)!;
    bucket.total += 1;
    if (sorted.length >= 2) bucket.reworked += 1;
  }

  return TRAILS.map((trail) => {
    const { total, reworked } = totals.get(trail)!;
    return {
      trail,
      issues_total: total,
      issues_reworked: reworked,
      rate: total > 0 ? round2(reworked / total) : null,
    };
  });
}

export interface MasterRedMetric {
  trail: Trail | "desconhecida";
  count: number;
}

/** Métrica 2 — quantos commits de "quebra de master" cada trilha causou,
 * segundo `resolveMasterRedCommitTrail`. Inclui a categoria "desconhecida"
 * explicitamente (nunca omite o que não pôde ser resolvido — omitir daria
 * a impressão falsa de que toda quebra foi atribuída). */
export function computeMasterRedAttribution(
  commits: { subject: string; body: string }[],
  ctx: MasterRedResolutionContext,
): MasterRedMetric[] {
  const counts = new Map<Trail | "desconhecida", number>();
  for (const t of [...TRAILS, "desconhecida" as const]) counts.set(t, 0);
  for (const commit of commits) {
    if (!isMasterRedCommit(commit.subject)) continue;
    const trail = resolveMasterRedCommitTrail(commit, ctx);
    counts.set(trail, (counts.get(trail) ?? 0) + 1);
  }
  return [...TRAILS, "desconhecida" as const].map((trail) => ({ trail, count: counts.get(trail) ?? 0 }));
}

export interface FindingDensityMetric {
  trail: Trail;
  findings: number;
  merged_prs: number;
  density: number | null; // findings / merged_prs; null quando merged_prs === 0
}

/** Métrica 3 — densidade de finding do `daily-review` por trilha
 * (habilitada por #6756). `dailyReviewIssueBodies` é o corpo de TODAS as
 * issues `[daily-review]` na janela (qualquer estado — finding não deixa de
 * ter acontecido por a issue ter sido fechada); `mergedPrsByTrail` conta
 * PRs mergeadas na MESMA janela, pra normalizar (mais PRs mergeadas é
 * esperado gerar mais findings em volume absoluto). */
export function computeFindingDensity(
  dailyReviewIssueBodies: string[],
  mergedPrsByTrail: Record<Trail, number>,
): FindingDensityMetric[] {
  const findingCounts = new Map<Trail, number>();
  for (const trail of TRAILS) findingCounts.set(trail, 0);
  for (const body of dailyReviewIssueBodies) {
    const marker = parseOrigemMarker(body);
    if (!marker || marker.trilha === "desconhecida") continue;
    findingCounts.set(marker.trilha, (findingCounts.get(marker.trilha) ?? 0) + 1);
  }
  return TRAILS.map((trail) => {
    const findings = findingCounts.get(trail) ?? 0;
    const mergedCount = mergedPrsByTrail[trail] ?? 0;
    return {
      trail,
      findings,
      merged_prs: mergedCount,
      density: mergedCount > 0 ? round2(findings / mergedCount) : null,
    };
  });
}

export interface ClosedWithoutMergeMetric {
  trail: Trail;
  closed_without_merge: number;
  closed_total: number;
  rate: number | null;
}

export interface ClosedPrRecord {
  headRefName: string;
  merged: boolean;
}

/** Métrica 4 — trabalho descartado: PRs fechadas sem merge, por trilha. */
export function computeClosedWithoutMerge(closedPrs: ClosedPrRecord[]): ClosedWithoutMergeMetric[] {
  const totals = new Map<Trail, { total: number; unmerged: number }>();
  for (const trail of TRAILS) totals.set(trail, { total: 0, unmerged: 0 });
  for (const pr of closedPrs) {
    const trail = deriveTrail(pr.headRefName);
    const bucket = totals.get(trail)!;
    bucket.total += 1;
    if (!pr.merged) bucket.unmerged += 1;
  }
  return TRAILS.map((trail) => {
    const { total, unmerged } = totals.get(trail)!;
    return {
      trail,
      closed_without_merge: unmerged,
      closed_total: total,
      rate: total > 0 ? round2(unmerged / total) : null,
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// --since
// ---------------------------------------------------------------------------

/** Aceita `Nd` (dias relativos a agora) ou uma data ISO absoluta. Lança
 * `Error` (não falha silenciosa) se o formato não for reconhecido — um
 * `--since` malformado nunca deve virar "sem filtro" em silêncio. */
export function parseSince(since: string, now: Date = new Date()): Date {
  const relMatch = since.match(/^(\d+)d$/);
  if (relMatch) {
    const days = Number(relMatch[1]);
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  }
  const parsed = new Date(since);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`--since inválido: "${since}" — use "Nd" (ex: 30d) ou uma data ISO (ex: 2026-08-01)`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Orquestração (I/O) — fail-soft por seção, nunca lança pra fora.
// ---------------------------------------------------------------------------

export interface TrackQualityReport {
  generated_at: string;
  since: string | null;
  rework: ReworkMetric[];
  master_red: MasterRedMetric[];
  finding_density: FindingDensityMetric[];
  closed_without_merge: ClosedWithoutMergeMetric[];
  warnings: string[];
}

interface RawInput {
  mergedPrs: MergedPrRecord[];
  closedPrs: ClosedPrRecord[];
  dailyReviewIssueBodies: string[];
  masterRedCommits: { subject: string; body: string }[];
  masterRedResolutionCtx: MasterRedResolutionContext;
  warnings: string[];
}

// `gh pr list --limit 500 --json ...` pode devolver MB de JSON (medido: 1,57
// MB pra 500 PRs mergeadas) — bem acima do maxBuffer default de 1 MB do
// `child_process`. `timeout` cobre travamento real (gh sem rede, auth
// expirada); `maxBuffer` generoso cobre volume legítimo. Os dois tetos
// existem pro MESMO motivo do #738 (nunca stall silencioso) — aqui o risco
// não é travar, é confundir "resposta grande" com "processo travado" e
// degradar a seção sem necessidade.
const GH_JSON_TIMEOUT_MS = 30_000;
const GH_JSON_MAX_BUFFER = 20 * 1024 * 1024;

function ghJson<T>(args: string[], cwd: string, warnings: string[], label: string): T[] {
  const result = spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    timeout: GH_JSON_TIMEOUT_MS,
    maxBuffer: GH_JSON_MAX_BUFFER,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().slice(0, 300);
    warnings.push(`${label}: gh saiu com status ${result.status} — seção degradada para vazia. stderr: ${stderr}`);
    return [];
  }
  try {
    return JSON.parse(result.stdout) as T[];
  } catch {
    warnings.push(`${label}: saída de gh não é JSON válido — seção degradada para vazia`);
    return [];
  }
}

/** Coleta os dados brutos via `gh`/`git`. Único ponto de I/O externo deste
 * módulo — cada chamada falha de forma isolada (seção correspondente vira
 * lista vazia + warning), nunca aborta as outras 3 métricas. */
export function fetchRawInput(cwd: string, sinceDate: Date | null): RawInput {
  const warnings: string[] = [];

  const mergedPrsRaw = ghJson<{ number: number; headRefName: string; mergedAt: string | null; body: string; mergeCommit: { oid: string } | null }>(
    ["pr", "list", "--state", "merged", "--limit", "500", "--json", "number,headRefName,mergedAt,body,mergeCommit"],
    cwd,
    warnings,
    "merged PRs",
  );
  const mergedPrs: MergedPrRecord[] = mergedPrsRaw
    .filter((pr) => pr.mergedAt != null)
    .filter((pr) => !sinceDate || new Date(pr.mergedAt as string) >= sinceDate)
    .map((pr) => ({
      number: pr.number,
      headRefName: pr.headRefName,
      mergedAt: pr.mergedAt as string,
      body: pr.body ?? "",
      mergeCommitSha: pr.mergeCommit?.oid,
    }));

  const closedPrsRaw = ghJson<{ headRefName: string; closedAt: string | null; mergedAt: string | null }>(
    ["pr", "list", "--state", "closed", "--limit", "500", "--json", "headRefName,closedAt,mergedAt"],
    cwd,
    warnings,
    "closed PRs",
  );
  const closedPrs: ClosedPrRecord[] = closedPrsRaw
    .filter((pr) => !sinceDate || (pr.closedAt && new Date(pr.closedAt) >= sinceDate))
    .map((pr) => ({ headRefName: pr.headRefName, merged: pr.mergedAt != null }));

  const dailyReviewIssuesRaw = ghJson<{ body: string; createdAt: string }>(
    ["issue", "list", "--state", "all", "--search", "[daily-review] in:title", "--limit", "300", "--json", "body,createdAt"],
    cwd,
    warnings,
    "[daily-review] issues",
  );
  const dailyReviewIssueBodies = dailyReviewIssuesRaw
    .filter((i) => !sinceDate || new Date(i.createdAt) >= sinceDate)
    .map((i) => i.body ?? "");

  const issueOrigemByNumber = new Map<number, OrigemMarker | undefined>();
  const issuesWithNumberRaw = ghJson<{ number: number; body: string }>(
    ["issue", "list", "--state", "all", "--search", "[daily-review] in:title", "--limit", "300", "--json", "number,body"],
    cwd,
    warnings,
    "[daily-review] issues (para resolução de commit hotfix)",
  );
  for (const issue of issuesWithNumberRaw) {
    issueOrigemByNumber.set(issue.number, parseOrigemMarker(issue.body) ?? undefined);
  }

  const gitLog = spawnSync(
    "git",
    ["log", "origin/master", "--pretty=format:%H%x01%s%x01%b%x02", ...(sinceDate ? [`--since=${sinceDate.toISOString()}`] : [])],
    { cwd, encoding: "utf8", timeout: GH_JSON_TIMEOUT_MS, maxBuffer: GH_JSON_MAX_BUFFER },
  );
  let masterRedCommits: { subject: string; body: string }[] = [];
  if (gitLog.status !== 0) {
    warnings.push(`git log falhou (status ${gitLog.status}) — métrica de quebra de master degradada para vazia. stderr: ${(gitLog.stderr ?? "").trim().slice(0, 300)}`);
  } else {
    const entries = gitLog.stdout.split("\x02").map((e) => e.trim()).filter(Boolean);
    masterRedCommits = entries
      .map((e) => {
        const [sha, subject, body] = e.split("\x01");
        return { sha, subject: subject ?? "", body: body ?? "" };
      })
      .filter((c) => isMasterRedCommit(c.subject));
  }

  // Resolve, só pros commits de revert real dentre os de quebra, a trilha
  // do sha revertido via `gh pr list --search <sha>` — um lookup por commit,
  // e só quando o trailer de revert existir (nunca busca especulativa).
  const revertedShaToTrail = new Map<string, Trail>();
  for (const commit of masterRedCommits) {
    const revertedSha = extractRevertedSha(commit.body);
    if (!revertedSha || revertedShaToTrail.has(revertedSha)) continue;
    const prsForSha = ghJson<{ headRefName: string }>(
      ["pr", "list", "--search", revertedSha, "--state", "all", "--limit", "5", "--json", "headRefName"],
      cwd,
      warnings,
      `resolução de origem do commit revertido ${revertedSha}`,
    );
    if (prsForSha.length > 0) revertedShaToTrail.set(revertedSha, deriveTrail(prsForSha[0].headRefName));
  }

  return {
    mergedPrs,
    closedPrs,
    dailyReviewIssueBodies,
    masterRedCommits,
    masterRedResolutionCtx: { revertedShaToTrail, issueOrigemByNumber },
    warnings,
  };
}

function mergedPrsByTrailCount(mergedPrs: MergedPrRecord[]): Record<Trail, number> {
  const counts: Record<Trail, number> = { continuo: 0, overnight: 0, develop: 0, other: 0 };
  for (const pr of mergedPrs) counts[deriveTrail(pr.headRefName)] += 1;
  return counts;
}

export function buildTrackQualityReport(raw: RawInput, since: string | null): TrackQualityReport {
  return {
    generated_at: new Date().toISOString(),
    since,
    rework: computeReworkRate(raw.mergedPrs),
    master_red: computeMasterRedAttribution(raw.masterRedCommits, raw.masterRedResolutionCtx),
    finding_density: computeFindingDensity(raw.dailyReviewIssueBodies, mergedPrsByTrailCount(raw.mergedPrs)),
    closed_without_merge: computeClosedWithoutMerge(raw.closedPrs),
    warnings: raw.warnings,
  };
}

export function runTrackQualityReport(cwd: string, since: string | null): TrackQualityReport {
  const sinceDate = since ? parseSince(since) : null;
  const raw = fetchRawInput(cwd, sinceDate);
  return buildTrackQualityReport(raw, since);
}

// ---------------------------------------------------------------------------
// Formatação --table
// ---------------------------------------------------------------------------

export function renderTrackQualityTable(report: TrackQualityReport): string {
  const lines: string[] = [];
  lines.push(`# track-quality-report — gerado ${report.generated_at}${report.since ? ` (since=${report.since})` : ""}`);
  lines.push("");
  lines.push("## 1. Retrabalho (issue com ≥2 PRs mergeadas, atribuído à trilha da 1ª)");
  lines.push("trilha\tissues_total\tissues_reworked\trate");
  for (const r of report.rework) lines.push(`${r.trail}\t${r.issues_total}\t${r.issues_reworked}\t${r.rate ?? "n/a"}`);
  lines.push("");
  lines.push("## 2. Quebra de master atribuída por trilha");
  lines.push("trilha\tcount");
  for (const r of report.master_red) lines.push(`${r.trail}\t${r.count}`);
  lines.push("");
  lines.push("## 3. Densidade de finding do daily-review por trilha (findings / PRs mergeadas)");
  lines.push("trilha\tfindings\tmerged_prs\tdensity");
  for (const r of report.finding_density) lines.push(`${r.trail}\t${r.findings}\t${r.merged_prs}\t${r.density ?? "n/a"}`);
  lines.push("");
  lines.push("## 4. PRs fechadas sem merge por trilha");
  lines.push("trilha\tclosed_without_merge\tclosed_total\trate");
  for (const r of report.closed_without_merge) lines.push(`${r.trail}\t${r.closed_without_merge}\t${r.closed_total}\t${r.rate ?? "n/a"}`);
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("## Avisos (seções degradadas)");
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const since = values["since"] ?? null;
  const cwd = process.cwd();

  let report: TrackQualityReport;
  try {
    report = runTrackQualityReport(cwd, since);
  } catch (err) {
    console.error(`[track-quality-report] ERRO: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  if (flags.has("json")) {
    console.log(JSON.stringify(report, null, 2));
  } else if (flags.has("table")) {
    console.log(renderTrackQualityTable(report));
  } else {
    console.log("Uso: npx tsx scripts/track-quality-report.ts --table|--json [--since 30d|2026-08-01]");
  }
}
