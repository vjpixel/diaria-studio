/**
 * scripts/lib/ads-spend-ingest-alarm.ts (#5597, reescrito no #7518)
 *
 * Lógica PURA do alarme que interpreta o CONTEÚDO dos logs de
 * `scripts/google-ads-ingest-spend.ts` e `scripts/microsoft-ads-ingest-spend.ts`
 * — não só o exit code. Decisão deliberada do #5237/#5502: os dois scripts
 * mantêm exit code 0 em toda classe de falha (`defect`, query malformada,
 * versão de API descontinuada incluída) — a task agendada roda cada
 * plataforma como task INDEPENDENTE (ver docstring abaixo), e sair
 * não-zero calaria a ingestão da plataforma vizinha se algum dia elas
 * voltarem a ser encadeadas. A distinção fica só no BANNER
 * (`console.error`/`console.warn` de "✖ DEFEITO"/"fallback pro CSV
 * manual"), o que significa que nenhum alarme baseado em `systemctl
 * --state=failed` (#5563) consegue enxergar um defeito real — a unit
 * sempre sai "sucesso".
 *
 * ## Correção de causa raiz (#7518, 09/09/2026)
 *
 * A versão original desta unidade (#5597) foi escrita ANTES de qualquer
 * task real de ingestão existir, e assumiu uma convenção de log que nunca
 * se concretizou: uma ÚNICA task `Diaria-Ads-Spend-Ingest` rodando as duas
 * plataformas como 2 steps do MESMO log (`data/aquisicao/.ads-spend-ingest.log`).
 * O que de fato nasceu depois (#5704, #7544) foram DUAS tasks
 * independentes, cada uma com seu próprio log:
 *
 *   - `Diaria-Google-Ads-Spend-Ingest`    → `data/aquisicao/.google-ads-ingest.log`
 *   - `Diaria-Microsoft-Ads-Spend-Ingest` → `data/aquisicao/.microsoft-ads-ingest.log`
 *
 * O path do alarme nunca foi atualizado para acompanhar essa divergência —
 * o comentário que dizia "a task ainda não existe" foi corrigido no #7137,
 * mas o `DEFAULT_LOG_PATH` (em `scripts/ads-spend-ingest-alarm.ts`)
 * continuou apontando pro arquivo unificado que nunca existiu. Resultado:
 * o alarme nunca leu log nenhum, sempre reportou `alarm-no-run` (pelo
 * motivo ERRADO — "achei o arquivo mas não tem run de hoje" nunca foi
 * verdade; o arquivo nunca existiu) e nunca detectou um defeito real —
 * inclusive o defeito de fato reproduzido em produção (renovação de access
 * token do Google respondendo HTTP 502 não-JSON, ver `classifyRunText`
 * abaixo).
 *
 * Este módulo passa a ler os DOIS logs reais (`evaluateSinglePlatformLog`
 * por plataforma) e compor um veredito único (`evaluateAdsSpendIngestAlarm`)
 * — nunca lê mais um path que nenhuma task grava.
 *
 * ## Tri-state honesto por plataforma (mesma disciplina do #7776/#6818/#7733)
 *
 * Log AUSENTE (arquivo não existe) e "log presente sem run de hoje" são
 * estados DISTINTOS com ações distintas — o primeiro é "o alarme está mal
 * configurado, ou a task nunca foi armada" (exatamente o bug desta issue);
 * o segundo é "a task existe e está armada, mas não disparou hoje". Cada
 * plataforma resolve para um de 4 veredictos (`SinglePlatformVerdict`):
 * `ok` | `defect` | `no-run` | `cannot-verify` — nunca reporta `ok` por não
 * ter conseguido olhar, nunca reporta `no-run` quando o que houve foi "não
 * achei onde olhar".
 *
 * ## Composição do veredito combinado — DECISÃO EXPLÍCITA (#7518)
 *
 * Prioridade determinística, defeito confirmado sempre vence estado
 * desconhecido, que sempre vence "sem run":
 *
 *   1. Qualquer plataforma `defect` → combinado `alarm-defect` (ALARMA).
 *      Um defeito confirmado numa plataforma nunca fica escondido atrás do
 *      estado desconhecido/saudável da outra — é justamente o caso que
 *      motivou a #5597 inteira.
 *   2. Nenhum defeito, mas alguma plataforma `cannot-verify` → combinado
 *      `cannot-verify` (NÃO alarma — ver racional abaixo, mesmo padrão de
 *      `onboarding-continuity-alarm.ts`/`meta-capi-staleness.ts`). Nunca
 *      reportado como `ok` nem como `alarm-no-run`.
 *   3. Nenhum defeito nem cannot-verify, mas alguma plataforma `no-run` →
 *      combinado `alarm-no-run` (ALARMA).
 *   4. As duas `ok` → combinado `ok`.
 *
 * **Por que `cannot-verify` NÃO auto-alarma (email/issue), diferente de
 * `alarm-defect`/`alarm-no-run`:** consistente com os dois alarmes tri-state
 * mais recentes deste repo (`onboarding-continuity-alarm.ts`:
 * "`data/onboarding/store.json` ausente ... `verdict === 'cannot-verify'`,
 * sai limpo, NUNCA alarma a partir de uma leitura que não aconteceu";
 * `meta-capi-staleness.ts`: mesmo padrão para token/rede indisponível). Log
 * ausente pode significar "task ainda não armada NESTA máquina" — estado
 * legítimo numa máquina onde o editor ainda não rodou
 * `setup-systemd-timers.ts`, e alarmar por isso a cada execução até alguém
 * armar reproduziria o ruído que os dois precedentes decidiram evitar.
 *
 * ATENÇÃO ao alcance dessa justificativa (corrigido pelo coordenador da
 * rodada 260909, #7518): a 1ª versão desta docstring afirmava que as duas
 * tasks de ingestão estavam "DECLARADA, NÃO ARMADA" no registro. É FALSO —
 * `Diaria-Google-Ads-Spend-Ingest` e `Diaria-Microsoft-Ads-Spend-Ingest`
 * não carregam esse marcador, e no helios (onde este alarme roda) os dois
 * timers respondem `enabled`, com runs diários no journal. Ou seja: NESTA
 * máquina, log ausente NÃO é "task não armada" — seria anomalia de fato.
 * A decisão de não auto-alarmar se sustenta pelo resto do argumento
 * (consistência com os precedentes + o guard estático abaixo), não por
 * essa premissa. Se um dia o custo aparecer, é aqui que se mexe. Escrever
 * uma premissa falsa numa docstring é o defeito que esta própria PR
 * conserta em outro lugar (a "prosa vencida" do #7137).
 *
 * O que MUDOU aqui, e é o que fecha a classe
 * de bug desta issue, é a diferença entre "cannot-verify silencioso" e "bug
 * anterior": o veredito nunca mais se disfarça de `ok`/`alarm-no-run` — ele
 * aparece honesto no log/console (`console.log` do CLI, nunca omitido) e é
 * gravado como tal em qualquer chamador que inspecione o resultado. O guard
 * estático (`test/ads-spend-ingest-alarm-log-path-guard.test.ts`) é quem
 * impede a classe de bug REAL desta issue (path apontando pra log que
 * nenhuma task grava) de voltar — não um alarme em runtime.
 */

/** Verdict por PLATAFORMA (Google ou Microsoft), lido do log real dela. */
export type SinglePlatformVerdict = "ok" | "defect" | "no-run" | "cannot-verify";

export type AdsSpendPlatform = "google" | "microsoft";

/** Motivo de `cannot-verify` — usado só pra mensagem, não muda a composição. */
export type CannotVerifyReason = "log_missing" | "log_unparseable";

export interface SinglePlatformEvaluation {
  platform: AdsSpendPlatform;
  logPath: string;
  verdict: SinglePlatformVerdict;
  /** Texto do run mais recente reconhecível — `null` quando `cannot-verify`
   *  ou `no-run` sem nenhum run em todo o log. */
  latestRun: string | null;
  /** Timestamp ISO do run mais recente — `null` junto com `latestRun`. */
  latestRunAt: string | null;
  /** Só presente quando `verdict === "cannot-verify"`. */
  cannotVerifyReason?: CannotVerifyReason;
}

/** Veredito COMBINADO das duas plataformas — ver docstring do módulo pra
 *  a tabela de precedência completa. */
export type AdsSpendIngestAlarmVerdict = "ok" | "alarm-defect" | "alarm-no-run" | "cannot-verify";

export interface AdsSpendIngestAlarmEvaluation {
  verdict: AdsSpendIngestAlarmVerdict;
  /** Sempre as 2 plataformas, nesta ordem — nunca omitido, mesmo quando
   *  `verdict` só reflete uma delas (a que "venceu" a precedência). */
  platforms: SinglePlatformEvaluation[];
  /** Texto do run que motivou o veredito combinado (a 1ª plataforma que bate
   *  a regra vencedora) — `null` em `ok`/`cannot-verify`. */
  latestRun: string | null;
  latestRunAt: string | null;
}

/** Banner exclusivo de defeito confirmado (`failureClass: "defect"` do
 *  Google, ver `google-ads-ingest-spend.ts`) — nunca aparece em estado
 *  esperado, sempre conta como `defect`. */
const DEFECT_BANNER_MARKER = "✖ DEFEITO";

/** Marcador GENÉRICO de fallback — `google-ads-ingest-spend.ts` E
 *  `microsoft-ads-ingest-spend.ts` emitem "fallback pro CSV manual —
 *  {reason}" em TODA classe de falha que não tem banner próprio (`defect`
 *  usa `DEFECT_BANNER_MARKER` acima; `empty` do Google usa `✔`). Achado ao
 *  vivo desta issue (09/09/2026): o run real do dia continha "fallback pro
 *  CSV manual — renovação do access token respondeu não-JSON (HTTP 502)"
 *  sem `DEFECT_BANNER_MARKER` (a falha classificou como `transient` em
 *  `classifyGoogleAdsFailure`, não `defect`) — e o alarme antigo, mesmo se
 *  estivesse lendo o path certo, teria reportado `ok` pra esse run.
 *
 *  **Este marcador sozinho NÃO basta** (achado do self-review da #7518,
 *  09/09/2026) — ele também aparece em 2 estados esperados, não-defeito:
 *  1. Google `auth-pending` (Basic Access na fila, #5262) —
 *     `reportFallback` cai no ramo `auth-pending` (avisa, sem `return`) e
 *     ENTÃO chama `fallback(reason)`, carregando o mesmo texto genérico.
 *  2. Microsoft zero-spend — `microsoft-ads-ingest-spend.ts` não separa
 *     `empty`/`defect`/`transient` como o Google faz; TODO fallback
 *     (inclusive "sem gasto no período", legitimamente `fail-soft (não
 *     erro)` por decisão de `runSpendIngest`) passa pelo mesmo
 *     `fallback()` genérico.
 *  Ver `BENIGN_FALLBACK_REASON_MARKERS` abaixo pra como esses 2 casos são
 *  excluídos. */
const GENERIC_FALLBACK_MARKER = "fallback pro CSV manual";

/** Textos de `reason` que, mesmo carregando `GENERIC_FALLBACK_MARKER`, são
 *  estado ESPERADO documentado — nunca contam como defeito:
 *  - "acesso ainda não liberado (Basic Access na fila" — literal do ramo
 *    `auth-pending` de `reportFallback` (`google-ads-ingest-spend.ts`).
 *  - "fetch não devolveu nenhuma linha com custo" — literal do fallback de
 *    `runSpendIngest` (`scripts/lib/spend-ingest.ts`) quando o fetch não
 *    devolveu NENHUMA linha — "sem gasto no período" pro Microsoft (que,
 *    ao contrário do Google, não separa isso num banner `✔` próprio). */
const BENIGN_FALLBACK_REASON_MARKERS = [
  "acesso ainda não liberado (Basic Access na fila",
  "fetch não devolveu nenhuma linha com custo",
];

/**
 * Classifica o texto do run mais recente em `ok`/`defect`. `DEFECT_BANNER_MARKER`
 * sempre conta. `GENERIC_FALLBACK_MARKER` conta SÓ quando nenhum
 * `BENIGN_FALLBACK_REASON_MARKERS` também aparece no mesmo texto — evita
 * alarmar em auth-pending/zero-spend, que passam pelo mesmo `fallback()`
 * genérico dos 2 scripts mas são estado normal, não defeito.
 *
 * @pure
 */
function classifyRunText(text: string): "ok" | "defect" {
  if (text.includes(DEFECT_BANNER_MARKER)) return "defect";
  if (text.includes(GENERIC_FALLBACK_MARKER)) {
    const isBenign = BENIGN_FALLBACK_REASON_MARKERS.some((m) => text.includes(m));
    return isBenign ? "ok" : "defect";
  }
  return "ok";
}

/** Regex do cabeçalho de bloco escrito por `runScheduledTask` —
 *  `===== 2026-08-17T18:20:00.000Z - descrição qualquer =====`. Captura o
 *  timestamp ISO em group 1. Âncora de início de linha (`m` flag) — o
 *  bloco pode conter qualquer texto arbitrário no meio (stdout/stderr de
 *  script), inclusive linhas que comecem com `=====` por acidente; a
 *  distinção real é feita por SPLIT em todos os cabeçalhos válidos e pegar
 *  o último segmento, não por um regex "greedy até o próximo =====". */
const RUN_HEADER_RE = /^===== (\S+) - .*=====$/gm;

/**
 * Extrai o texto do bloco de execução mais recente de um log acumulado
 * (múltiplos runs concatenados via `appendFileSync`, mais antigo primeiro).
 * `null` se `logContent` for `null`/vazio ou não tiver nenhum cabeçalho de
 * run reconhecível (log corrompido/formato inesperado — tratado como "não
 * dá pra confirmar que rodou").
 *
 * @pure
 */
export function parseLatestLogRun(logContent: string | null): { text: string; startedAt: string } | null {
  if (!logContent) return null;

  const headers: Array<{ index: number; startedAt: string }> = [];
  for (const m of logContent.matchAll(RUN_HEADER_RE)) {
    headers.push({ index: m.index, startedAt: m[1] });
  }
  if (headers.length === 0) return null;

  const last = headers[headers.length - 1];
  const text = logContent.slice(last.index).trim();
  return { text, startedAt: last.startedAt };
}

/**
 * `true` quando `startedAt` (ISO) cai no MESMO dia-calendário UTC que
 * `now` — usado pra decidir "a task rodou hoje" sem reconsultar systemd.
 * Comparação em UTC (não BRT) de propósito: o objetivo é só "existe
 * atividade recente", não uma fronteira de dia editorial precisa.
 *
 * @pure
 */
export function isRunFromToday(startedAt: string, now: Date): boolean {
  const started = new Date(startedAt);
  if (isNaN(started.getTime())) return false;
  return started.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

/**
 * Avalia o log de UMA plataforma. `logExists` distingue "arquivo ausente"
 * (config errada/task nunca armada — `cannot-verify`, reason
 * `log_missing`) de "arquivo presente mas sem run reconhecível" (vazio,
 * corrompido, ou só ruído sem cabeçalho `=====` — também `cannot-verify`,
 * reason `log_unparseable`: existir sem conteúdo legível não é prova de
 * "não rodou", é prova de "não dá pra confirmar"). `logContent` é
 * ignorado quando `logExists` é `false` (nunca confunde os dois sinais).
 *
 * @pure
 */
export function evaluateSinglePlatformLog(
  platform: AdsSpendPlatform,
  logPath: string,
  logExists: boolean,
  logContent: string | null,
  now: Date,
): SinglePlatformEvaluation {
  if (!logExists) {
    return { platform, logPath, verdict: "cannot-verify", latestRun: null, latestRunAt: null, cannotVerifyReason: "log_missing" };
  }
  const latest = parseLatestLogRun(logContent);
  if (!latest) {
    return { platform, logPath, verdict: "cannot-verify", latestRun: null, latestRunAt: null, cannotVerifyReason: "log_unparseable" };
  }
  if (!isRunFromToday(latest.startedAt, now)) {
    return { platform, logPath, verdict: "no-run", latestRun: latest.text, latestRunAt: latest.startedAt };
  }
  const verdict: SinglePlatformVerdict = classifyRunText(latest.text);
  return { platform, logPath, verdict, latestRun: latest.text, latestRunAt: latest.startedAt };
}

/** Entrada de leitura por plataforma — I/O já resolvido pelo chamador
 *  (`scripts/ads-spend-ingest-alarm.ts`), mantendo esta função pura. */
export interface PlatformLogInput {
  logPath: string;
  exists: boolean;
  content: string | null;
}

/**
 * Avalia as DUAS plataformas e compõe o veredito combinado — ver docstring
 * do módulo pra a tabela de precedência (`defect` > `cannot-verify` >
 * `no-run` > `ok`).
 *
 * @pure
 */
export function evaluateAdsSpendIngestAlarm(
  google: PlatformLogInput,
  microsoft: PlatformLogInput,
  now: Date,
): AdsSpendIngestAlarmEvaluation {
  const platforms: SinglePlatformEvaluation[] = [
    evaluateSinglePlatformLog("google", google.logPath, google.exists, google.content, now),
    evaluateSinglePlatformLog("microsoft", microsoft.logPath, microsoft.exists, microsoft.content, now),
  ];

  const defectPlatform = platforms.find((p) => p.verdict === "defect");
  if (defectPlatform) {
    return { verdict: "alarm-defect", platforms, latestRun: defectPlatform.latestRun, latestRunAt: defectPlatform.latestRunAt };
  }

  const cannotVerifyPlatform = platforms.find((p) => p.verdict === "cannot-verify");
  if (cannotVerifyPlatform) {
    return { verdict: "cannot-verify", platforms, latestRun: null, latestRunAt: null };
  }

  const noRunPlatform = platforms.find((p) => p.verdict === "no-run");
  if (noRunPlatform) {
    return { verdict: "alarm-no-run", platforms, latestRun: noRunPlatform.latestRun, latestRunAt: noRunPlatform.latestRunAt };
  }

  return { verdict: "ok", platforms, latestRun: null, latestRunAt: null };
}

/** Só `alarm-defect`/`alarm-no-run` disparam email+issue — `cannot-verify`
 *  fica de fora de propósito (ver docstring do módulo, mesmo padrão de
 *  `onboarding-continuity-alarm.ts`/`meta-capi-staleness.ts`). */
export function isAlarmingVerdict(verdict: AdsSpendIngestAlarmVerdict): boolean {
  return verdict === "alarm-defect" || verdict === "alarm-no-run";
}

// ---------------------------------------------------------------------------
// Idempotência — 1 alarme por dia-calendário UTC (`YYYY-MM-DD` do
// `latestRunAt`, ou da própria checagem quando não há run — "sem run hoje"
// também merece 1 alarme por dia, não repetido a cada invocação da task de
// alarme).
// ---------------------------------------------------------------------------

export interface AdsSpendIngestAlarmState {
  lastAlarmedDay: string | null;
}

export function emptyAdsSpendIngestAlarmState(): AdsSpendIngestAlarmState {
  return { lastAlarmedDay: null };
}

export function shouldSendAdsSpendIngestAlarm(
  evaluation: AdsSpendIngestAlarmEvaluation,
  state: AdsSpendIngestAlarmState,
  now: Date,
): boolean {
  if (!isAlarmingVerdict(evaluation.verdict)) return false;
  const today = now.toISOString().slice(0, 10);
  return state.lastAlarmedDay !== today;
}

export function markAdsSpendIngestAlarmed(now: Date): AdsSpendIngestAlarmState {
  return { lastAlarmedDay: now.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

/** Label legível pra 1 plataforma — usado tanto no e-mail (`describePlatform`
 *  abaixo) quanto em `toAlarmFinding` (`scripts/ads-spend-ingest-alarm.ts`),
 *  fonte única em vez de duplicar o ternário nos 2 arquivos (achado do
 *  self-review da #7518). */
export function platformLabel(platform: AdsSpendPlatform): string {
  return platform === "google" ? "Google Ads" : "Microsoft Ads";
}

/** Descreve o estado de UMA plataforma numa linha, pro corpo do e-mail —
 *  usado tanto pra listar a plataforma "vencedora" quanto, quando as duas
 *  discordam, a outra pra contexto. */
function describePlatform(p: SinglePlatformEvaluation): string {
  const label = platformLabel(p.platform);
  if (p.verdict === "ok") return `${label}: ok (run ${p.latestRunAt}, ${p.logPath}).`;
  if (p.verdict === "defect") return `${label}: DEFEITO no run de ${p.latestRunAt} (${p.logPath}).`;
  if (p.verdict === "no-run") return `${label}: log presente (${p.logPath}) mas sem run de hoje — último run: ${p.latestRunAt ?? "nenhum encontrado"}.`;
  const reason = p.cannotVerifyReason === "log_missing" ? "arquivo ausente" : "arquivo presente mas sem run reconhecível";
  return `${label}: não dá pra verificar (${reason}, ${p.logPath}).`;
}

export function buildAdsSpendIngestAlarmEmail(
  evaluation: AdsSpendIngestAlarmEvaluation,
  issueLines: string,
): { subject: string; body: string } {
  const platformLines = evaluation.platforms.map(describePlatform).join("\n");

  if (evaluation.verdict === "alarm-defect") {
    return {
      subject: "⚠️ Diaria-Ads-Spend-Ingest: DEFEITO real detectado no log (exit code não avisa)",
      body:
        `Uma das ingestões de gasto (Google Ads / Microsoft Ads) contém sinal de defeito no run mais recente ` +
        `(${evaluation.latestRunAt}) — "✖ DEFEITO" ou fallback pro CSV manual sem ser o caso normal de gasto ` +
        `zero. Por decisão do #5237/#5502, os scripts saem com exit 0 mesmo neste caso (pra não calar a ` +
        `ingestão da plataforma vizinha) — este alarme existe justamente pra tornar visível o que o exit code ` +
        `esconde.\n\n` +
        `Estado por plataforma:\n${platformLines}\n\n` +
        `Trecho do run:\n\n${evaluation.latestRun}\n\n` +
        `Corrigir em scripts/lib/google-ads-ingest.ts / scripts/lib/microsoft-ads-ingest.ts (query/token/versão de ` +
        `API) — esperar não resolve.` +
        issueLines,
    };
  }
  if (evaluation.verdict === "alarm-no-run") {
    return {
      subject: "⚠️ Diaria-Ads-Spend-Ingest: nenhuma execução encontrada hoje",
      body:
        `Pelo menos um log de ingestão existe mas não tem run de hoje — a task pode não ter disparado ` +
        `(systemd não armado/desabilitado, máquina desligada na janela).\n\n` +
        `Estado por plataforma:\n${platformLines}\n\n` +
        `Verifique: systemctl --user list-timers | grep ads-spend, e journalctl --user -u ` +
        `diaria-google-ads-spend-ingest.service / diaria-microsoft-ads-spend-ingest.service -n 50 se a unit existir.` +
        issueLines,
    };
  }
  // "ok"/"cannot-verify" não chamam esta função no fluxo normal (só
  // `isAlarmingVerdict` decide se um e-mail sai) — mantido exaustivo por
  // segurança de tipo, nunca deveria ser alcançado em produção.
  return {
    subject: "Diaria-Ads-Spend-Ingest: nenhum alarme necessário",
    body: `Estado por plataforma:\n${platformLines}` + issueLines,
  };
}
