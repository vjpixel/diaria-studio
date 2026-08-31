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
 * ## Métrica 5 — Custo via OpenRouter `GET /api/v1/activity` (#6755, 31/08/2026)
 *
 * A lacuna documentada abaixo (histórico, mantido pra contexto) foi
 * fechada assim que uma management key passou a existir no `.env`
 * (`OPENROUTER_MANAGEMENT_KEY`, sincronizada via Doppler): a chave de
 * inferência usada por `hermes/scripts/claude-openrouter.sh` sempre
 * respondeu `403` neste endpoint (`is_provisioning_key: false`); a
 * management key responde `200` com custo real por dia/modelo.
 *
 * **Por que o custo cai 100% na trilha `continuo`, sem precisar resolver
 * por PR:** este repo proíbe qualquer sessão de Claude Code (overnight,
 * develop, interativa) de autenticar via API (`CLAUDE.md`, "NUNCA trocar a
 * conta claude.ai pela API", #5608) — a ÚNICA coisa que fatura no
 * OpenRouter é a delegação do contínuo via `claude-openrouter.sh`. Não é
 * uma inferência deste script; é o invariante que o resto do repo já
 * impõe. Por isso a métrica de custo não tem eixo "por trilha" (sempre
 * seria 100% `continuo`, 0% nas demais) — só por modelo, que é o que o
 * endpoint realmente sabe.
 *
 * **Endpoint sem parâmetro de range** — `GET /api/v1/activity` sozinho
 * devolve uma janela retida (medido ao vivo 31/08/2026: ~23 dias, uma
 * linha por dia+modelo); `?date=YYYY-MM-DD` filtra pra UM dia específico
 * (não é um range). Este módulo busca sem parâmetro (a janela inteira
 * retida) e filtra client-side por `sinceDate`, mesmo padrão de
 * `fetchRawInput` pras outras 4 métricas — nunca confia no filtro remoto
 * pra cobrir a janela pedida.
 *
 * **Consolidação (achado da coordenação com a sessão do #6816):** o(s)
 * dia(s) mais recente(s) da resposta pode(m) estar parcialmente
 * consolidado(s) — o valor de `usage` de hoje pode subir em uma consulta
 * futura. Este módulo não tenta compensar isso (não há como saber o
 * quanto falta consolidar); só expõe `max_date` no relatório e um aviso
 * quando `max_date` é a data de HOJE, pra quem ler saber que o total pode
 * estar subestimado.
 *
 * **Fail-soft:** chave ausente, endpoint fora do ar, ou `403` (chave de
 * inferência, não management) degradam a seção pra `available: false` +
 * aviso — nunca lançam, nunca derrubam as outras 4 métricas (mesmo
 * contrato de `fetchRawInput`).
 *
 * **Combinada com a métrica 1:** `continuo_cost_per_nonreworked_issue` —
 * custo total (janela) dividido por quantas issues da trilha `continuo`
 * fecharam SEM precisar de 2ª PR (`issues_total - issues_reworked` da
 * métrica 1). É o número que a discussão do #6816 pediu como critério de
 * aceite pra troca de modelo: "um modelo mais caro que não mexe no
 * retrabalho trocou a fatura sem resolver o problema". `null` quando o
 * custo não está disponível OU o denominador é 0 (nunca uma divisão por
 * zero silenciosa).
 *
 * ### Histórico (lacuna original, 31/08/2026, coordenação com sessão do #6816)
 *
 * "As 4 métricas acima decidem 'qual trilha PRODUZ trabalho que precisa
 * ser refeito' — nenhuma delas mede quanto custou produzir esse trabalho
 * [...] hoje a única chave OpenRouter em uso é de inferência
 * (`is_provisioning_key: false`), e `GET /api/v1/activity` responde `403`
 * — sem quebra de custo por dia/modelo até uma management key existir
 * (bloqueio de credencial, fora do alcance desta sessão)." A fonte mais
 * rica sobre custo POR CHAMADA continua sendo `~/.hermes/logs/agent.log`
 * (modelo, provider, tokens in/out por chamada individual) — fora deste
 * repo, não consumida aqui; o que este módulo adiciona é o agregado por
 * dia/modelo que o próprio OpenRouter já consolida, sem precisar parsear
 * log local.
 *
 * ## Achados do fleet review da PR #6855 (31/08/2026), aplicados neste commit
 *
 * 1. **P1 — `master_red.count`/`finding_density.density` viravam `0`/`0.00`,
 *    não `null`, quando a busca de origem (`git log`/`gh issue list`)
 *    falhava** — indistinguível de "zero incidentes de verdade". As duas
 *    métricas agora seguem o MESMO padrão que 1 e 4 já tinham
 *    (`rate: number | null`): `count`/`density` viram `null` quando a
 *    fonte não pôde ser consultada, nunca um zero fabricado.
 * 2. **P2 — `--limit 500` truncava silenciosamente a janela `--since`
 *    anunciada no uso deste script** (confirmado ao vivo: `--since 14d` e
 *    `--since 30d` produziam saída IDÊNTICA, porque 500 PRs mergeadas já
 *    esgotava ~12 dias de histórico). Teto subido pra 2000 (`gh` pagina
 *    automaticamente, sem custo extra de request) + aviso explícito
 *    quando o resultado bate exatamente no teto (`length === limit`),
 *    sinal de truncamento possível.
 * 3. As 2 buscas idênticas de `[daily-review] in:title` (uma só por
 *    `body,createdAt`, outra só por `number,body`) viraram 1 chamada só
 *    (`number,body,createdAt`) — reduz a superfície de falha parcial que
 *    alimentava o achado 1 pra métrica 3.
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
  /** `null` quando a fonte (`git log`) não pôde ser consultada nesta
   * rodada — NUNCA um `0` fabricado (review da PR #6855, P1). `0` só
   * aparece aqui quando a busca teve sucesso e genuinamente não achou
   * nenhum commit de quebra atribuído a esta trilha. */
  count: number | null;
}

/** Métrica 2 — quantos commits de "quebra de master" cada trilha causou,
 * segundo `resolveMasterRedCommitTrail`. Inclui a categoria "desconhecida"
 * explicitamente (nunca omite o que não pôde ser resolvido — omitir daria
 * a impressão falsa de que toda quebra foi atribuída). `commitsFetchOk:
 * false` (o `git log` da fonte falhou) faz TODAS as trilhas voltarem
 * `count: null` — nunca `0`, que seria indistinguível de "checamos e não
 * tinha nenhuma" (review da PR #6855, P1, confiança alta). */
export function computeMasterRedAttribution(
  commits: { subject: string; body: string }[],
  ctx: MasterRedResolutionContext,
  commitsFetchOk: boolean,
): MasterRedMetric[] {
  if (!commitsFetchOk) {
    return [...TRAILS, "desconhecida" as const].map((trail) => ({ trail, count: null }));
  }
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
  /** `null` quando a fonte (`gh issue list [daily-review]`) não pôde ser
   * consultada — nunca `0` fabricado (review da PR #6855, P1). */
  findings: number | null;
  merged_prs: number;
  density: number | null; // findings / merged_prs; null quando merged_prs === 0 OU findings indisponível
}

/** Métrica 3 — densidade de finding do `daily-review` por trilha
 * (habilitada por #6756). `dailyReviewIssueBodies` é o corpo de TODAS as
 * issues `[daily-review]` na janela (qualquer estado — finding não deixa de
 * ter acontecido por a issue ter sido fechada); `mergedPrsByTrail` conta
 * PRs mergeadas na MESMA janela, pra normalizar (mais PRs mergeadas é
 * esperado gerar mais findings em volume absoluto). `issuesFetchOk: false`
 * (a busca de `[daily-review]` falhou) faz `findings`/`density` voltarem
 * `null` pra toda trilha — mesmo `merged_prs` continuando disponível (é uma
 * fonte independente que pode ter tido sucesso), NUNCA um `density: 0.00`
 * fabricado que passaria por "trilha limpa" (review da PR #6855, P1,
 * confiança alta — esse era o achado mais perigoso: `0.00` numa métrica de
 * QUALIDADE lê como "sem problema", o oposto de "não sei"). */
export function computeFindingDensity(
  dailyReviewIssueBodies: string[],
  mergedPrsByTrail: Record<Trail, number>,
  issuesFetchOk: boolean,
): FindingDensityMetric[] {
  if (!issuesFetchOk) {
    return TRAILS.map((trail) => ({ trail, findings: null, merged_prs: mergedPrsByTrail[trail] ?? 0, density: null }));
  }
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
// Métrica 5 — custo via OpenRouter activity (#6755).
// ---------------------------------------------------------------------------

export interface OpenRouterActivityRow {
  date: string; // "YYYY-MM-DD 00:00:00" (UTC, granularidade diária) — formato do endpoint
  model: string;
  usage: number;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface CostByModelMetric {
  model: string;
  usage_usd: number;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/** Extrai só a parte de data (`YYYY-MM-DD`) do campo `date` do endpoint —
 * pura, não depende de timezone local (a string já vem em UTC). */
function activityRowDateOnly(row: OpenRouterActivityRow): string {
  return row.date.slice(0, 10);
}

/** Pura: agrega linhas diárias (uma por dia+modelo) por MODELO dentro da
 * janela `sinceDate`, ordenado por custo desc (modelo mais caro primeiro —
 * a leitura mais acionável). `sinceDate: null` = sem filtro (toda a janela
 * retida pelo endpoint). Comparação por DIA (não por instante) — `date` do
 * endpoint é sempre meia-noite UTC, então comparar a string já resolvida
 * pra `YYYY-MM-DD` evita off-by-one de timezone. */
export function computeCostByModel(rows: OpenRouterActivityRow[], sinceDate: Date | null): CostByModelMetric[] {
  const sinceDay = sinceDate ? sinceDate.toISOString().slice(0, 10) : null;
  const byModel = new Map<string, CostByModelMetric>();
  for (const row of rows) {
    if (sinceDay && activityRowDateOnly(row) < sinceDay) continue;
    const bucket = byModel.get(row.model) ?? { model: row.model, usage_usd: 0, requests: 0, prompt_tokens: 0, completion_tokens: 0 };
    bucket.usage_usd += row.usage;
    bucket.requests += row.requests;
    bucket.prompt_tokens += row.prompt_tokens;
    bucket.completion_tokens += row.completion_tokens;
    byModel.set(row.model, bucket);
  }
  return [...byModel.values()]
    .map((m) => ({ ...m, usage_usd: round4(m.usage_usd) }))
    .sort((a, b) => b.usage_usd - a.usage_usd);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Pura: soma `usage` bruto (não arredondado por modelo) das linhas dentro
 * da janela `sinceDate`, arredondando só o TOTAL final. Review PR #6878
 * (P3/nitpick, média confiança): somar os `usage_usd` já arredondados de
 * `computeCostByModel` acumularia erro de arredondamento por modelo antes
 * de arredondar de novo — negligível na magnitude de USD deste script
 * (<$10, erro por modelo ~0,00005), mas o padrão do arquivo (ver
 * `round2`/`round4` nas outras 4 métricas) já evita esse tipo de
 * composição, então mantém a mesma disciplina aqui. Mesmo filtro por dia
 * de `computeCostByModel` — nunca diverge sobre o que conta como "dentro
 * da janela". */
export function computeTotalCostUsd(rows: OpenRouterActivityRow[], sinceDate: Date | null): number {
  const sinceDay = sinceDate ? sinceDate.toISOString().slice(0, 10) : null;
  let total = 0;
  for (const row of rows) {
    if (sinceDay && activityRowDateOnly(row) < sinceDay) continue;
    total += row.usage;
  }
  return round4(total);
}

/** Maior `date` (dia, `YYYY-MM-DD`) presente na resposta bruta — usado só
 * pro aviso de consolidação (achado 5). `null` sem linhas. */
export function maxActivityDate(rows: OpenRouterActivityRow[]): string | null {
  if (rows.length === 0) return null;
  return rows.map(activityRowDateOnly).reduce((max, d) => (d > max ? d : max));
}

export interface CostReport {
  available: boolean;
  by_model: CostByModelMetric[];
  total_usd: number | null;
  max_date: string | null;
  /** custo total dividido por quantas issues `continuo` fecharam sem 2ª PR
   *  (métrica 1) — `null` sem custo disponível ou denominador 0. Nunca
   *  divisão por zero silenciosa. */
  continuo_cost_per_nonreworked_issue: number | null;
}

/** Pura: combina o custo total (janela) com a métrica 1 (retrabalho) pra
 * produzir o número que o #6816 pediu como critério de aceite de troca de
 * modelo — "custo por issue `continuo` que não precisou de 2ª PR". */
export function computeCostPerNonReworkedContinuoIssue(
  totalUsd: number | null,
  reworkContinuo: ReworkMetric | undefined,
): number | null {
  if (totalUsd == null || !reworkContinuo) return null;
  const nonReworked = reworkContinuo.issues_total - reworkContinuo.issues_reworked;
  if (nonReworked <= 0) return null;
  return round4(totalUsd / nonReworked);
}

const OPENROUTER_ACTIVITY_TIMEOUT_MS = 15_000;

interface OpenRouterActivityFetchResult {
  rows: OpenRouterActivityRow[];
  ok: boolean;
  warning?: string;
}

/** Único ponto de I/O da métrica 5 — chama `GET /api/v1/activity` com a
 * management key do env (`OPENROUTER_MANAGEMENT_KEY`). Fail-soft: chave
 * ausente, timeout, status != 200 (ex: `403` de uma chave de inferência) ou
 * corpo não-JSON degradam pra `ok: false` com aviso — nunca lançam. */
export async function fetchOpenRouterActivity(
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterActivityFetchResult> {
  if (!apiKey) {
    return { rows: [], ok: false, warning: "OPENROUTER_MANAGEMENT_KEY ausente no env — seção de custo degradada (n/a), nunca 0 fabricado" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_ACTIVITY_TIMEOUT_MS);
  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/activity", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const isForbidden = res.status === 403;
      const hint = isForbidden ? " (403 costuma ser chave de INFERÊNCIA, não management — confira OPENROUTER_MANAGEMENT_KEY)" : "";
      return { rows: [], ok: false, warning: `GET /api/v1/activity respondeu ${res.status}${hint} — seção de custo degradada (n/a)` };
    }
    const body = (await res.json()) as { data?: OpenRouterActivityRow[] };
    if (!Array.isArray(body.data)) {
      return { rows: [], ok: false, warning: "GET /api/v1/activity: corpo sem campo `data` array — seção de custo degradada (n/a)" };
    }
    return { rows: body.data, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rows: [], ok: false, warning: `GET /api/v1/activity falhou: ${msg} — seção de custo degradada (n/a)` };
  } finally {
    clearTimeout(timer);
  }
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
  cost: CostReport;
  warnings: string[];
}

interface RawInput {
  mergedPrs: MergedPrRecord[];
  closedPrs: ClosedPrRecord[];
  dailyReviewIssueBodies: string[];
  /** `false` sse a busca de `[daily-review] in:title` falhou nesta rodada
   * — alimenta o `null` fail-closed da métrica 3 (review PR #6855, P1). */
  dailyReviewIssuesFetchOk: boolean;
  masterRedCommits: { subject: string; body: string }[];
  /** `false` sse o `git log` falhou nesta rodada — alimenta o `null`
   * fail-closed da métrica 2 (review PR #6855, P1). */
  masterRedCommitsFetchOk: boolean;
  masterRedResolutionCtx: MasterRedResolutionContext;
  warnings: string[];
}

// `gh pr list --limit N --json ...` pode devolver MB de JSON (medido: 1,57
// MB pra 500 PRs mergeadas) — bem acima do maxBuffer default de 1 MB do
// `child_process`. `timeout` cobre travamento real (gh sem rede, auth
// expirada); `maxBuffer` generoso cobre volume legítimo. Os dois tetos
// existem pro MESMO motivo do #738 (nunca stall silencioso) — aqui o risco
// não é travar, é confundir "resposta grande" com "processo travado" e
// degradar a seção sem necessidade.
const GH_JSON_TIMEOUT_MS = 30_000;
const GH_JSON_MAX_BUFFER = 20 * 1024 * 1024;
// Review da PR #6855 (P2, confirmado ao vivo): 500 já truncava a janela de
// --since 30d anunciada no próprio uso deste script (500 PRs mergeadas
// esgotava ~12 dias de histórico neste repo). Medido ao vivo de novo depois
// de subir pra 2000: AINDA truncava um --since 30d (volume real do repo é
// maior que isso). 5000 é generoso o bastante pra qualquer janela --since
// realista sem custo extra de request (gh pagina automaticamente por trás
// de --limit) — mas o número em si nunca é a defesa real: é o aviso de
// truncamento abaixo (dispara sempre que o resultado bate exatamente no
// teto, qualquer que seja o teto), que é o que de fato garante que uma
// janela subestimada nunca fica silenciosa.
const GH_LIST_LIMIT = 5000;

interface GhJsonResult<T> {
  items: T[];
  /** `false` = a chamada falhou (status != 0 ou JSON inválido) — `items`
   * é `[]`, mas isso NÃO significa "resultado vazio de verdade". Todo
   * chamador que alimenta uma métrica precisa propagar este flag, nunca
   * tratar `items: []` sozinho como "consultamos e não tinha nada". */
  ok: boolean;
}

function ghJson<T>(args: string[], cwd: string, warnings: string[], label: string): GhJsonResult<T> {
  const result = spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    timeout: GH_JSON_TIMEOUT_MS,
    maxBuffer: GH_JSON_MAX_BUFFER,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().slice(0, 300);
    const spawnErr = result.error ? ` spawn error: ${result.error.message}` : "";
    warnings.push(`${label}: gh saiu com status ${result.status} — seção degradada para vazia. stderr: ${stderr}${spawnErr}`);
    return { items: [], ok: false };
  }
  try {
    const items = JSON.parse(result.stdout) as T[];
    if (Array.isArray(items) && items.length === GH_LIST_LIMIT) {
      warnings.push(`${label}: resultado bateu exatamente no teto de --limit ${GH_LIST_LIMIT} — pode estar truncado, a janela --since pedida pode não ter sido totalmente coberta.`);
    }
    return { items, ok: true };
  } catch {
    warnings.push(`${label}: saída de gh não é JSON válido — seção degradada para vazia`);
    return { items: [], ok: false };
  }
}

/** Coleta os dados brutos via `gh`/`git`. Único ponto de I/O externo deste
 * módulo — cada chamada falha de forma isolada (seção correspondente vira
 * lista vazia + warning), nunca aborta as outras 3 métricas. */
export function fetchRawInput(cwd: string, sinceDate: Date | null): RawInput {
  const warnings: string[] = [];

  const mergedPrsResult = ghJson<{ number: number; headRefName: string; mergedAt: string | null; body: string; mergeCommit: { oid: string } | null }>(
    ["pr", "list", "--state", "merged", "--limit", String(GH_LIST_LIMIT), "--json", "number,headRefName,mergedAt,body,mergeCommit"],
    cwd,
    warnings,
    "merged PRs",
  );
  const mergedPrs: MergedPrRecord[] = mergedPrsResult.items
    .filter((pr) => pr.mergedAt != null)
    .filter((pr) => !sinceDate || new Date(pr.mergedAt as string) >= sinceDate)
    .map((pr) => ({
      number: pr.number,
      headRefName: pr.headRefName,
      mergedAt: pr.mergedAt as string,
      body: pr.body ?? "",
      mergeCommitSha: pr.mergeCommit?.oid,
    }));

  const closedPrsResult = ghJson<{ headRefName: string; closedAt: string | null; mergedAt: string | null }>(
    ["pr", "list", "--state", "closed", "--limit", String(GH_LIST_LIMIT), "--json", "headRefName,closedAt,mergedAt"],
    cwd,
    warnings,
    "closed PRs",
  );
  const closedPrs: ClosedPrRecord[] = closedPrsResult.items
    .filter((pr) => !sinceDate || (pr.closedAt && new Date(pr.closedAt) >= sinceDate))
    .map((pr) => ({ headRefName: pr.headRefName, merged: pr.mergedAt != null }));

  // 1 chamada só (review da PR #6855, P3 — a versão original fazia a MESMA
  // busca "[daily-review] in:title" duas vezes, uma por conjunto de campos,
  // dobrando a superfície de falha parcial para a métrica 3).
  const dailyReviewIssuesResult = ghJson<{ number: number; body: string; createdAt: string }>(
    ["issue", "list", "--state", "all", "--search", "[daily-review] in:title", "--limit", String(GH_LIST_LIMIT), "--json", "number,body,createdAt"],
    cwd,
    warnings,
    "[daily-review] issues",
  );
  const dailyReviewIssueBodies = dailyReviewIssuesResult.items
    .filter((i) => !sinceDate || new Date(i.createdAt) >= sinceDate)
    .map((i) => i.body ?? "");

  const issueOrigemByNumber = new Map<number, OrigemMarker | undefined>();
  for (const issue of dailyReviewIssuesResult.items) {
    issueOrigemByNumber.set(issue.number, parseOrigemMarker(issue.body) ?? undefined);
  }

  const gitLog = spawnSync(
    "git",
    ["log", "origin/master", "--pretty=format:%H%x01%s%x01%b%x02", ...(sinceDate ? [`--since=${sinceDate.toISOString()}`] : [])],
    { cwd, encoding: "utf8", timeout: GH_JSON_TIMEOUT_MS, maxBuffer: GH_JSON_MAX_BUFFER },
  );
  let masterRedCommits: { subject: string; body: string }[] = [];
  const masterRedCommitsFetchOk = gitLog.status === 0;
  if (!masterRedCommitsFetchOk) {
    const spawnErr = gitLog.error ? ` spawn error: ${gitLog.error.message}` : "";
    warnings.push(`git log falhou (status ${gitLog.status}) — métrica de quebra de master degradada para null (não 0). stderr: ${(gitLog.stderr ?? "").trim().slice(0, 300)}${spawnErr}`);
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
    const prsForShaResult = ghJson<{ headRefName: string }>(
      ["pr", "list", "--search", revertedSha, "--state", "all", "--limit", "5", "--json", "headRefName"],
      cwd,
      warnings,
      `resolução de origem do commit revertido ${revertedSha}`,
    );
    if (prsForShaResult.items.length > 0) revertedShaToTrail.set(revertedSha, deriveTrail(prsForShaResult.items[0].headRefName));
  }

  return {
    mergedPrs,
    closedPrs,
    dailyReviewIssueBodies,
    dailyReviewIssuesFetchOk: dailyReviewIssuesResult.ok,
    masterRedCommits,
    masterRedCommitsFetchOk,
    masterRedResolutionCtx: { revertedShaToTrail, issueOrigemByNumber },
    warnings,
  };
}

function mergedPrsByTrailCount(mergedPrs: MergedPrRecord[]): Record<Trail, number> {
  const counts: Record<Trail, number> = { continuo: 0, overnight: 0, develop: 0, other: 0 };
  for (const pr of mergedPrs) counts[deriveTrail(pr.headRefName)] += 1;
  return counts;
}

export function buildTrackQualityReport(
  raw: RawInput,
  since: string | null,
  costFetch: OpenRouterActivityFetchResult,
  sinceDate: Date | null,
): TrackQualityReport {
  const rework = computeReworkRate(raw.mergedPrs);
  // Review PR #6878 (P2, alta confiança): a versão original fazia
  // `costFetch.warning ? [...raw.warnings, w] : raw.warnings` — no ramo
  // `false`, `warnings` era o MESMO array de `raw.warnings` (bind por
  // referência, não cópia), e o `.push()` do aviso de consolidação
  // abaixo mutava o array do CALLER em vez de produzir um novo. Latente
  // hoje (cada chamada de CLI recebe um `raw` fresco), mas quebra a
  // pureza esperada de `buildTrackQualityReport` e já reproduzia de
  // verdade nos testes (3 `it()`s compartilhando o fixture `emptyRaw`).
  // Cópia SEMPRE, nos dois ramos — nunca aliasing do array do caller.
  const warnings = [...raw.warnings];
  if (costFetch.warning) warnings.push(costFetch.warning);

  let cost: CostReport;
  if (!costFetch.ok) {
    cost = { available: false, by_model: [], total_usd: null, max_date: null, continuo_cost_per_nonreworked_issue: null };
  } else {
    const byModel = computeCostByModel(costFetch.rows, sinceDate);
    const totalUsd = computeTotalCostUsd(costFetch.rows, sinceDate);
    const maxDate = maxActivityDate(costFetch.rows);
    const todayDay = new Date().toISOString().slice(0, 10);
    if (maxDate === todayDay) {
      warnings.push(`custo (OpenRouter activity): dado do dia de hoje (${maxDate}) pode estar parcialmente consolidado — total pode subestimar (#6755)`);
    }
    cost = {
      available: true,
      by_model: byModel,
      total_usd: totalUsd,
      max_date: maxDate,
      continuo_cost_per_nonreworked_issue: computeCostPerNonReworkedContinuoIssue(
        totalUsd,
        rework.find((r) => r.trail === "continuo"),
      ),
    };
  }

  return {
    generated_at: new Date().toISOString(),
    since,
    rework,
    master_red: computeMasterRedAttribution(raw.masterRedCommits, raw.masterRedResolutionCtx, raw.masterRedCommitsFetchOk),
    finding_density: computeFindingDensity(raw.dailyReviewIssueBodies, mergedPrsByTrailCount(raw.mergedPrs), raw.dailyReviewIssuesFetchOk),
    closed_without_merge: computeClosedWithoutMerge(raw.closedPrs),
    cost,
    warnings,
  };
}

export async function runTrackQualityReport(cwd: string, since: string | null): Promise<TrackQualityReport> {
  const sinceDate = since ? parseSince(since) : null;
  const raw = fetchRawInput(cwd, sinceDate);
  const costFetch = await fetchOpenRouterActivity(process.env.OPENROUTER_MANAGEMENT_KEY);
  return buildTrackQualityReport(raw, since, costFetch, sinceDate);
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
  for (const r of report.master_red) lines.push(`${r.trail}\t${r.count ?? "n/a"}`);
  lines.push("");
  lines.push("## 3. Densidade de finding do daily-review por trilha (findings / PRs mergeadas)");
  lines.push("trilha\tfindings\tmerged_prs\tdensity");
  for (const r of report.finding_density) lines.push(`${r.trail}\t${r.findings ?? "n/a"}\t${r.merged_prs}\t${r.density ?? "n/a"}`);
  lines.push("");
  lines.push("## 4. PRs fechadas sem merge por trilha");
  lines.push("trilha\tclosed_without_merge\tclosed_total\trate");
  for (const r of report.closed_without_merge) lines.push(`${r.trail}\t${r.closed_without_merge}\t${r.closed_total}\t${r.rate ?? "n/a"}`);
  lines.push("");
  lines.push("## 5. Custo (OpenRouter activity, 100% trilha continuo — ver docstring)");
  if (!report.cost.available) {
    lines.push("indisponível nesta rodada (ver Avisos)");
  } else {
    lines.push("model\tusage_usd\trequests\tprompt_tokens\tcompletion_tokens");
    for (const m of report.cost.by_model) lines.push(`${m.model}\t${m.usage_usd}\t${m.requests}\t${m.prompt_tokens}\t${m.completion_tokens}`);
    lines.push("");
    lines.push(`total_usd\t${report.cost.total_usd}`);
    lines.push(`max_date\t${report.cost.max_date ?? "n/a"}`);
    lines.push(`continuo_cost_per_nonreworked_issue\t${report.cost.continuo_cost_per_nonreworked_issue ?? "n/a"}`);
  }
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

  const main = async () => {
    let report: TrackQualityReport;
    try {
      report = await runTrackQualityReport(cwd, since);
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
  };
  main().catch((err) => {
    // Review PR #6878 (P3): sem isto, um throw fora do try/catch interno
    // (ex: no console.log/JSON.stringify) vira unhandled rejection em vez
    // do caminho limpo de erro — mesmo tratamento do catch interno.
    console.error(`[track-quality-report] ERRO inesperado: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
