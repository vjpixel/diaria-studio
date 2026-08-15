/**
 * scripts/lib/alarm-issues.ts (#5112)
 *
 * Helper COMPARTILHADO que fecha o loop "achado de alarme agendado vira
 * issue automaticamente, e o e-mail linka a issue" — hoje todo alarme deste
 * repo (#4320/#4382/#4485/#4557/#4750/#4910/etc.) é sensor puro: detecta
 * drift, manda e-mail, avança o cursor de idempotência e para aí. Nenhum
 * cria issue, nenhum comenta em nada — o achado morre na caixa de entrada
 * do editor e, se ele não agir na hora, o guard de idempotência garante que
 * NUNCA MAIS chega outro e-mail sobre o MESMO drift.
 *
 * Escopo desta unidade: implementar só pra `beehiiv-home-meta-check.ts`
 * (ver wiring em `scripts/beehiiv-home-meta-check.ts`). Os outros 8 alarmes
 * do projeto (`hub-drift-check.ts`, `robots-txt-drift-check.ts`,
 * `worker-drift-check.ts`, `apoios-diff-alarm.ts`, `clarice-envio-alarm.ts`,
 * `clarice-guardrail-alarm.ts`, `clarice-opens-catchup-alarm.ts`,
 * `cursos-error-alarm.ts`, `geo-citation-staleness-alarm.ts`) ficam de fora
 * — follow-up futuro — mas a API nasce genérica de propósito (recebe
 * `{check, fingerprint, title, body, labels}`, devolve `{issueNumber, url,
 * action}`) pra não precisar de reescrita quando algum desses migrar.
 *
 * ─── Design: pure decision + I/O injetável (mesmo padrão do resto do repo) ──
 *
 * `planAlarmReconciliation` é PURA — decide o que fazer (ensure/comment/
 * close) só olhando pending findings + estado local, sem tocar rede.
 * `applyAlarmReconciliation` faz o I/O (chama `gh` via `GhRunFn` injetável,
 * mesmo padrão de `scripts/studio-ui/gh-run.ts`) e devolve o próximo estado
 * + o outcome por achado (pro e-mail citar a issue).
 *
 * ─── Dedup em 2 camadas (#5112 item 2) ──────────────────────────────────────
 *
 *   1. MAPA LOCAL (`AlarmIssuesState`, `data/{check}/alarm-issues.json` —
 *      path decidido pelo script chamador): fingerprint -> {issueNumber,
 *      url, missingStreak, closedAt}. Cache RÁPIDO — na maioria das
 *      execuções, um achado já rastreado nunca precisa de round-trip pro
 *      GitHub, só reusa a entry.
 *   2. MARCADOR no corpo da issue (`<!-- alarm-finding: {check}:{fingerprint} -->`,
 *      `alarmFindingMarker`), buscado via `gh issue list --search` — usado
 *      SÓ quando o cache local não tem a entry (cache perdido/apagado,
 *      1ª execução depois de um `git clone` fresco, etc.). É a fonte de
 *      verdade que sobrevive à perda do cache: `data/` é local/gitignored,
 *      o marcador vive no GitHub.
 *
 * ─── Fail-soft (#5112 item 6) ───────────────────────────────────────────────
 *
 * Se `gh issue create` falhar (sem `gh` autenticado, rate limit, offline),
 * `ensureAlarmIssue` retorna `action: "failed"` com `error` — NUNCA fabrica
 * issueNumber/url. `applyAlarmReconciliation` deixa o estado daquele achado
 * INALTERADO nesse caso (não avança como se tivesse sido tratado — próxima
 * execução tenta de novo). O caller (script) é responsável por incluir o
 * motivo no e-mail mesmo assim — o e-mail NUNCA é suprimido por falha de
 * criação de issue, só perde a citação da issue pra aquele achado.
 */
import { spawnGhSync, type GhSpawnResult } from "../studio-ui/gh-run.ts";

/** Label que este módulo aplica a toda issue de alarme (#5338: precisa
 * existir no repo — nunca existiu antes desta unidade, então `gh issue
 * create` falhava em TODA execução com "'alarm' not found" e zero achado
 * virava issue desde o #5112). Usada tanto pelo self-heal em
 * `ensureAlarmLabelExists` (chamado ao detectar o erro "not found" pra essa
 * label especificamente) quanto pelo setup manual documentado. */
export const ALARM_LABEL = "alarm";
const ALARM_LABEL_COLOR = "5319e7";
const ALARM_LABEL_DESCRIPTION = "Achado de alarme agendado criou/reusa esta issue automaticamente (#5112)";

export type AlarmPriority = "P0" | "P1" | "P2" | "P3";

export interface AlarmFinding {
  /** Eixo/categoria do achado (ex: "english-labels", "port-in-url") — o
   * mesmo `check` de uma execução pode ter no máximo 1 finding pendente por
   * fingerprint distinto. */
  check: string;
  /** Identificador estável do achado especifico (independente de quando
   * ele foi detectado) — normalmente `${check}:${detalhe}`. Usado tanto pro
   * marcador quanto pra chave do estado local. */
  fingerprint: string;
  /** Título da issue, usado só quando `action: "created"`. */
  title: string;
  /** Corpo markdown da issue (o marcador de dedup é ANEXADO automaticamente
   * por `ensureAlarmIssue` — não incluir aqui). */
  body: string;
  /** Labels extras além de "alarm" + a prioridade resolvida — tipicamente
   * o tipo (`bug`/`enhancement`). */
  labels?: string[];
  /** Default `"P2"` (CLAUDE.md: toda issue nasce com label de prioridade). */
  priority?: AlarmPriority;
}

export interface AlarmIssueResult {
  issueNumber: number | null;
  url: string | null;
  action: "created" | "reused" | "failed";
  error?: string;
}

// ─── Marcador de dedup (puro) ───────────────────────────────────────────────

/** Pura — marcador de dedup embutido no corpo da issue (#5112 item 2). */
export function alarmFindingMarker(check: string, fingerprint: string): string {
  return `<!-- alarm-finding: ${check}:${fingerprint} -->`;
}

// ─── Estado local (cache, NÃO autoritativo — #5112 item 2) ─────────────────

export interface AlarmIssueStateEntry {
  issueNumber: number;
  url: string;
  /** Execuções CONSECUTIVAS em que o achado esteve ausente do conjunto
   * pendente — reseta pra 0 sempre que o achado reaparece. */
  missingStreak: number;
  /** `null` enquanto a issue segue tratada como aberta pelo tracking local;
   * ISO timestamp de quando `closeAlarmIssue` teve sucesso. */
  closedAt: string | null;
}

/** Chave do mapa de estado — `check:fingerprint` (fingerprint já inclui o
 * check normalmente, mas a chave explícita evita colisão entre eixos
 * diferentes que por acaso gerem o mesmo fingerprint). */
export type AlarmIssuesState = Record<string, AlarmIssueStateEntry>;

export function emptyAlarmIssuesState(): AlarmIssuesState {
  return {};
}

export function alarmIssueStateKey(check: string, fingerprint: string): string {
  return `${check}:${fingerprint}`;
}

// ─── `gh` CLI (I/O, injetável — reusa scripts/studio-ui/gh-run.ts) ─────────

export type GhRunFn = (args: string[], cwd: string) => GhSpawnResult;

/** Produção: `gh` de verdade, com o mesmo teto de tempo de
 * `scripts/studio-ui/gh-run.ts` (nunca trava o event loop indefinidamente
 * se `gh auth` expirou ou a API do GitHub degradou). */
export function defaultAlarmGhRun(args: string[], cwd: string): GhSpawnResult {
  return spawnGhSync(args, cwd);
}

/**
 * Busca (fallback do cache local, #5112 item 2) uma issue — aberta OU
 * fechada, `--state all` — que já carregue o marcador exato deste
 * check+fingerprint. A query de busca do GitHub é best-effort (full-text
 * search pode não indexar bem pontuação de comentário HTML) — o filtro
 * EXATO acontece client-side via `body.includes(marker)`, então um miss no
 * server-side search no pior caso custa uma issue nova (não uma adoção
 * errada). `run.status !== 0` (gh indisponível/erro) vira "não encontrado"
 * — o caller decide se cria (fail-soft já cobre falha de criação
 * separadamente).
 */
export function findExistingAlarmIssue(
  check: string,
  fingerprint: string,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): { issueNumber: number; url: string } | null {
  const marker = alarmFindingMarker(check, fingerprint);
  const res = run(
    ["issue", "list", "--search", `${check} ${fingerprint}`, "--state", "all", "--json", "number,url,body", "--limit", "30"],
    cwd,
  );
  if (res.status !== 0) return null;
  let issues: { number: number; url: string; body: string }[];
  try {
    issues = JSON.parse(res.stdout) as { number: number; url: string; body: string }[];
  } catch {
    return null;
  }
  const match = issues.find((i) => (i.body ?? "").includes(marker));
  return match ? { issueNumber: match.number, url: match.url } : null;
}

/** Erro de `gh issue create`/`gh label create` quando uma label passada em
 * `--label` não existe no repo — formato observado ao vivo (#5338):
 * `could not add label: 'alarm' not found`. Captura o nome entre aspas
 * simples; `g` pra achar todas as ocorrências se `gh` reportar mais de uma
 * label ausente na mesma mensagem. */
const LABEL_NOT_FOUND_PATTERN = /could not add label: '([^']+)' not found/gi;

/** Nomes de label extraídos de uma mensagem de erro "not found" do `gh` —
 * lista vazia se o erro não é dessa classe (caller distingue "falha por
 * label ausente, retentável" de qualquer outra falha, que não deve mascarar
 * o motivo real). */
function extractMissingLabels(stderr: string): string[] {
  const names: string[] = [];
  const re = new RegExp(LABEL_NOT_FOUND_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderr)) !== null) names.push(match[1]);
  return names;
}

/** Self-heal (#5338 item 1) — best-effort, nunca lança: tenta criar a label
 * `alarm` no repo (`--force` a torna idempotente caso já exista com
 * cor/descrição diferentes de uma criação manual). Chamada só no caminho de
 * retry (vale a pena tentar 1x quando `gh issue create` já falhou por essa
 * label especificamente) — não em toda execução, pra não gastar uma chamada
 * `gh` extra quando a label já existe (caso comum após a 1ª auto-criação). */
function ensureAlarmLabelExists(cwd: string, run: GhRunFn): boolean {
  const res = run(
    ["label", "create", ALARM_LABEL, "--color", ALARM_LABEL_COLOR, "--description", ALARM_LABEL_DESCRIPTION, "--force"],
    cwd,
  );
  return res.status === 0;
}

function parseIssueCreateUrl(res: GhSpawnResult): { issueNumber: number; url: string } | { error: string } {
  const url = res.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const numMatch = url.match(/\/issues\/(\d+)\s*$/);
  if (!numMatch) {
    return {
      error: `não foi possível extrair o número da issue da URL retornada por 'gh issue create': "${url}"`,
    };
  }
  return { issueNumber: Number(numMatch[1]), url };
}

/**
 * Cria a issue via `gh issue create` — com retry não-fatal (#5338 item 2)
 * quando a falha é EXATAMENTE "label não encontrada": tenta self-heal da
 * label `alarm` (`ensureAlarmLabelExists`) e retenta mantendo `alarm` na
 * lista se a criação deu certo, ou sem ela (e sem qualquer outra label que o
 * `gh` também tenha acusado como ausente) caso contrário. Perder um rótulo é
 * aceitável; perder o rastreio do achado inteiro não é — nunca deixa uma
 * falha de label genuína, sem retry, virar o único motivo de a issue nunca
 * existir. Qualquer outra classe de falha (rate limit, offline, `gh` não
 * autenticado) passa direto pro fail-soft de sempre, sem retry.
 */
function createAlarmIssueWithLabelRetry(
  title: string,
  body: string,
  labels: string[],
  cwd: string,
  run: GhRunFn,
): AlarmIssueResult {
  const attempt = (attemptLabels: string[]) =>
    run(
      attemptLabels.length > 0
        ? ["issue", "create", "--title", title, "--body", body, "--label", attemptLabels.join(",")]
        : ["issue", "create", "--title", title, "--body", body],
      cwd,
    );

  const res = attempt(labels);
  if (res.status === 0) {
    const parsed = parseIssueCreateUrl(res);
    if ("error" in parsed) return { issueNumber: null, url: null, action: "failed", error: parsed.error };
    return { issueNumber: parsed.issueNumber, url: parsed.url, action: "created" };
  }

  const missing = extractMissingLabels(res.stderr);
  if (missing.length === 0) {
    // Falha que não é (só) de label ausente — nunca mascarar com retry.
    return {
      issueNumber: null,
      url: null,
      action: "failed",
      error: res.stderr.trim() || `gh issue create falhou (status ${res.status})`,
    };
  }

  const alarmLabelHealed = missing.includes(ALARM_LABEL) && ensureAlarmLabelExists(cwd, run);
  const stillMissing = alarmLabelHealed ? missing.filter((l) => l !== ALARM_LABEL) : missing;
  const retryLabels = labels.filter((l) => !stillMissing.includes(l));

  const retryRes = attempt(retryLabels);
  if (retryRes.status !== 0) {
    return {
      issueNumber: null,
      url: null,
      action: "failed",
      error: `label(s) ausente(s) no repo (${missing.join(", ")}) — retry sem ela(s) também falhou: ${retryRes.stderr.trim() || `status ${retryRes.status}`}`,
    };
  }
  const parsed = parseIssueCreateUrl(retryRes);
  if ("error" in parsed) return { issueNumber: null, url: null, action: "failed", error: parsed.error };
  return { issueNumber: parsed.issueNumber, url: parsed.url, action: "created" };
}

/**
 * Garante que existe uma issue pro achado `finding` — reusa via `cachedEntry`
 * (fast path, sem tocar rede) OU via busca por marcador (`findExistingAlarmIssue`,
 * fallback quando o cache não tem a entry) OU cria uma nova (com retry
 * fail-soft de label ausente — ver `createAlarmIssueWithLabelRetry`).
 * **NUNCA** fabrica `issueNumber`/`url` — se toda tentativa de `gh issue
 * create` falhar, devolve `action: "failed"` com `error` populado.
 */
export function ensureAlarmIssue(
  finding: AlarmFinding,
  cachedEntry: { issueNumber: number; url: string } | undefined,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): AlarmIssueResult {
  if (cachedEntry) {
    return { issueNumber: cachedEntry.issueNumber, url: cachedEntry.url, action: "reused" };
  }

  const existing = findExistingAlarmIssue(finding.check, finding.fingerprint, cwd, run);
  if (existing) {
    return { issueNumber: existing.issueNumber, url: existing.url, action: "reused" };
  }

  const priority = finding.priority ?? "P2";
  const labels = [...new Set([...(finding.labels ?? []), ALARM_LABEL, priority])];
  const marker = alarmFindingMarker(finding.check, finding.fingerprint);
  const body = `${finding.body}\n\n${marker}\n`;

  return createAlarmIssueWithLabelRetry(finding.title, body, labels, cwd, run);
}

/** Comenta "não reproduz mais" numa issue — `true` em sucesso, `false` se
 * `gh` falhar (caller não avança o streak nesse caso, fail-soft). */
export function commentAlarmIssueResolved(
  issueNumber: number,
  resolvedAt: Date,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): boolean {
  const body = `Não reproduz mais desde ${resolvedAt.toISOString()}.`;
  const res = run(["issue", "comment", String(issueNumber), "--body", body], cwd);
  return res.status === 0;
}

/** Fecha a issue com um comentário explicando o motivo automático — `true`
 * em sucesso, `false` se `gh` falhar. */
export function closeAlarmIssue(
  issueNumber: number,
  closeAfterRuns: number,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): boolean {
  const comment = `Fechada automaticamente: achado não reproduz há ${closeAfterRuns} execuções consecutivas.`;
  const res = run(["issue", "close", String(issueNumber), "--comment", comment], cwd);
  return res.status === 0;
}

// ─── Reconciliação (plan = puro, apply = I/O) ───────────────────────────────

export type AlarmReconcileAction =
  | { kind: "ensure"; finding: AlarmFinding }
  | { kind: "comment_resolved"; key: string; issueNumber: number }
  | { kind: "advance_streak"; key: string }
  | { kind: "close"; key: string; issueNumber: number };

/**
 * Pura — decide as ações necessárias pra reconciliar `pending` (achados
 * DESTA execução) contra `state` (achados rastreados de execuções
 * anteriores):
 *
 *   - todo achado em `pending` ganha uma ação `ensure` (cria ou reusa).
 *   - todo achado em `state` que NÃO está em `pending` e ainda não foi
 *     fechado (`closedAt === null`) teve o streak de ausência incrementado
 *     hipoteticamente: na 1ª ausência (streak chega a 1) vira
 *     `comment_resolved`; ao atingir `closeAfterRuns` vira `close`; entre os
 *     dois (streak > 1 e < closeAfterRuns) vira `advance_streak` — sem I/O,
 *     só avança o contador em `state`, senão `missingStreak` nunca passaria
 *     de 1 e `closeAfterRuns > 2` nunca fecharia nada (#5172: `apply` só
 *     escrevia `missingStreak` dentro dos ramos `comment_resolved`/`close`,
 *     então o meio da faixa ficava sem NENHUMA ação e o streak persistido
 *     travava pra sempre em 1, fazendo `nextStreak` recalcular 2 do zero a
 *     cada execução seguinte).
 */
export function planAlarmReconciliation(
  pending: readonly AlarmFinding[],
  state: AlarmIssuesState,
  closeAfterRuns: number,
): AlarmReconcileAction[] {
  const actions: AlarmReconcileAction[] = [];
  const pendingKeys = new Set(pending.map((f) => alarmIssueStateKey(f.check, f.fingerprint)));

  for (const finding of pending) {
    actions.push({ kind: "ensure", finding });
  }

  for (const [key, entry] of Object.entries(state)) {
    if (pendingKeys.has(key)) continue;
    if (entry.closedAt) continue;
    const nextStreak = entry.missingStreak + 1;
    if (nextStreak >= closeAfterRuns) {
      actions.push({ kind: "close", key, issueNumber: entry.issueNumber });
    } else if (nextStreak === 1) {
      actions.push({ kind: "comment_resolved", key, issueNumber: entry.issueNumber });
    } else {
      actions.push({ kind: "advance_streak", key });
    }
  }

  return actions;
}

export interface AlarmFindingOutcome extends AlarmIssueResult {
  check: string;
  fingerprint: string;
}

export interface ApplyAlarmReconciliationOptions {
  cwd: string;
  closeAfterRuns: number;
  run?: GhRunFn;
  now?: Date;
}

export interface ApplyAlarmReconciliationResult {
  nextState: AlarmIssuesState;
  /** Um outcome por achado PENDENTE desta execução (pra o e-mail citar a
   * issue) — resolved/closed não entram aqui (não são achados pendentes). */
  findingOutcomes: AlarmFindingOutcome[];
}

/**
 * Aplica `planAlarmReconciliation` — faz o I/O (via `run`) e devolve o
 * próximo estado + outcome por achado pendente. Fail-soft (#5112 item 6):
 * uma falha de `ensure` deixa a entry de estado daquele achado como estava
 * (sem entry nenhuma se nunca existiu) — nunca avança como se tivesse sido
 * tratado. Falha de `comment`/`close` também não avança o streak daquele
 * achado (retry na próxima execução).
 */
export function applyAlarmReconciliation(
  pending: readonly AlarmFinding[],
  state: AlarmIssuesState,
  opts: ApplyAlarmReconciliationOptions,
): ApplyAlarmReconciliationResult {
  const run = opts.run ?? defaultAlarmGhRun;
  const now = opts.now ?? new Date();
  const nextState: AlarmIssuesState = { ...state };
  const findingOutcomes: AlarmFindingOutcome[] = [];

  const actions = planAlarmReconciliation(pending, state, opts.closeAfterRuns);

  for (const action of actions) {
    if (action.kind === "ensure") {
      const key = alarmIssueStateKey(action.finding.check, action.finding.fingerprint);
      const cachedEntry = state[key];
      const result = ensureAlarmIssue(
        action.finding,
        cachedEntry ? { issueNumber: cachedEntry.issueNumber, url: cachedEntry.url } : undefined,
        opts.cwd,
        run,
      );
      findingOutcomes.push({ check: action.finding.check, fingerprint: action.finding.fingerprint, ...result });

      if (result.action === "failed") {
        // Fail-soft: NÃO avança o estado (cursor não marca como tratado).
        continue;
      }
      nextState[key] = {
        issueNumber: result.issueNumber!,
        url: result.url!,
        missingStreak: 0,
        // Reativa o tracking (closedAt: null) mesmo se a entry anterior
        // estava fechada — o achado reapareceu, então voltou a ser
        // pendente do ponto de vista do tracking local. Isso NÃO reabre a
        // issue no GitHub automaticamente (fora de escopo, #5112) — se
        // `action === "reused"` apontando pra uma issue já fechada lá, o
        // e-mail cita a issue mesmo assim; reabrir é decisão do editor.
        closedAt: null,
      };
    } else if (action.kind === "comment_resolved") {
      const ok = commentAlarmIssueResolved(action.issueNumber, now, opts.cwd, run);
      if (ok) {
        const entry = nextState[action.key]!;
        nextState[action.key] = { ...entry, missingStreak: entry.missingStreak + 1 };
      }
    } else if (action.kind === "advance_streak") {
      // Sem I/O — só avança o contador local (#5172). Nada pra falhar aqui,
      // então sempre aplica (diferente de comment/close, que só avançam o
      // streak se o `gh` correspondente teve sucesso).
      const entry = nextState[action.key]!;
      nextState[action.key] = { ...entry, missingStreak: entry.missingStreak + 1 };
    } else if (action.kind === "close") {
      const ok = closeAlarmIssue(action.issueNumber, opts.closeAfterRuns, opts.cwd, run);
      if (ok) {
        const entry = nextState[action.key]!;
        nextState[action.key] = { ...entry, missingStreak: entry.missingStreak + 1, closedAt: now.toISOString() };
      }
    }
  }

  return { nextState, findingOutcomes };
}
