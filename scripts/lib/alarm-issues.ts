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
 * mesmo padrão de `scripts/lib/shared/gh-run.ts`) e devolve o próximo estado
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
 *
 * ─── Allowlist de achados aceitos como limitação permanente (#5364) ────────
 *
 * Alguns achados nunca vão parar de reproduzir por design — não são bug,
 * são limitação de PLATAFORMA sem alavanca do lado do código (ex: #5364 —
 * merge tag nativo da Beehiiv que não localiza, sem fix possível no plano
 * Launch/free). O mecanismo de auto-close (`missingStreak`/
 * `CLOSE_ALARM_ISSUE_AFTER_RUNS` acima) só cobre o caso OPOSTO — achado que
 * PARA de reproduzir — então um achado permanente nunca fecha sozinho, e
 * fechar a issue manualmente sem mais nada faz o achado seguinte recriá-la
 * (mesmo fingerprint, sem issue aberta -> `ensureAlarmIssue` cria de novo).
 *
 * `AlarmAllowlist` resolve isso: uma lista, declarada em código pelo script
 * chamador (`check`/`fingerprint`/`reason`/`accepted_at`/`ref_issue` — nunca
 * um array de strings sem contexto, cf. requisito de auditabilidade), que
 * `planAlarmReconciliation` consulta pra pular TODA ação (`ensure`,
 * `comment_resolved`, `advance_streak`, `close`) sobre um fingerprint
 * aceito — tanto do lado `pending` (nunca cria/reabre) quanto do lado
 * `state` (uma entry de issue já existente pra esse fingerprint fica
 * congelada, sem mais comentário/fechamento automático). Isso já cobre
 * "reabrir issue fechada manualmente" sem lógica extra: o achado nunca
 * tenta criar/reabrir issue pra um fingerprint aceito, então fechar a
 * issue manualmente (ou via `Closes #NNNN` no PR que adiciona a entry) é
 * definitivo.
 *
 * Match é sempre EXATO (`check` + `fingerprint` iguais, nunca prefixo/regex)
 * — fail-safe: se o texto do achado mudar (o `message` que compõe o
 * fingerprint em checks como `beehiiv-home-meta-check.ts` muda), o
 * fingerprint muda, e a entry da allowlist para de casar automaticamente.
 * Silenciar por acidente um achado NOVO/diferente por causa de um match
 * frouxo seria pior que o problema que este mecanismo resolve.
 *
 * ─── Família ESTADO × EVENTO (#5553) ────────────────────────────────────────
 *
 * `AlarmFinding.family` (obrigatório, ver docstring do tipo) resolve um
 * problema estruturalmente igual ao da allowlist acima, mas na direção
 * OPOSTA: um achado de `family: "evento"` (ex: `campaign-{id}` em
 * `clarice-guardrail-alarm.ts`) desaparece de `pending` assim que o script
 * PARA de reavaliar aquele ID específico — não porque alguém consertou nada.
 * Sem tratamento, isso aciona o MESMO streak de ausência que fecha achados
 * `"estado"` de verdade resolvidos, fechando a issue sozinha com o problema
 * intocado (#5525). `planAlarmReconciliation` trata uma entry `"evento"`
 * exatamente como uma allowlisted: congelada, sem `comment_resolved`/
 * `advance_streak`/`close` — só um humano fecha. Isso também resolve de
 * graça a preocupação de "reabrir depois de fechado": como a entry nunca
 * ganha `closedAt` setado por este módulo (só um `gh issue close` manual do
 * lado de fora), e `ensureAlarmIssue` sempre confere o cache/marcador ANTES
 * de criar, o pior caso de um achado de evento reaparecer em `pending` é
 * `action: "reused"` apontando pra uma issue que já pode estar fechada — o
 * mesmo comportamento (documentado acima) que já existe pro caso "issue
 * fechada manualmente + fingerprint ainda casa" da allowlist, nunca uma
 * issue nova duplicada. `classifyExecTrack` (`scripts/lib/issue-exec-track.ts`)
 * usa a label companheira `ALARM_EVENT_LABEL` pra rotear esses achados pro
 * `overnight` (revisão humana) em vez de `fora-de-rodada`.
 */
import { spawnGhSync, type GhSpawnResult } from "./shared/gh-run.ts";

/** Label que este módulo aplica a toda issue de alarme (#5338: precisa
 * existir no repo — nunca existiu antes desta unidade, então `gh issue
 * create` falhava em TODA execução com "'alarm' not found" e zero achado
 * virava issue desde o #5112). Usada tanto pelo self-heal em
 * `ensureLabelExists` (chamado ao detectar o erro "not found" pra essa
 * label especificamente) quanto pelo setup manual documentado. */
export const ALARM_LABEL = "alarm";
const ALARM_LABEL_COLOR = "5319e7";
const ALARM_LABEL_DESCRIPTION = "Achado de alarme agendado criou/reusa esta issue automaticamente (#5112)";

/**
 * #5553 — label aplicada SÓ a achados de família `"evento"` (ver `AlarmFamily`
 * abaixo), além de `ALARM_LABEL`. Existe pra `classifyExecTrack`
 * (`scripts/lib/issue-exec-track.ts`) distinguir os dois: `alarm` sozinho
 * classifica `fora-de-rodada` (o achado se auto-resolve); `alarm` +
 * `alarm-evento` classifica `overnight` (precisa de revisão humana — o achado
 * NUNCA se auto-resolve, só sai da janela de observação do alarme com o
 * tempo). Nunca aplicada sozinha — sempre junto de `ALARM_LABEL`, pra
 * convivência com `gh issue list --label alarm`/dashboards existentes que já
 * filtram por ela.
 */
export const ALARM_EVENT_LABEL = "alarm-evento";
const ALARM_EVENT_LABEL_COLOR = "b60205";
const ALARM_EVENT_LABEL_DESCRIPTION =
  // GitHub label description tem teto de 100 chars — validado ao vivo
  // (#5553): a 1ª tentativa (104 chars) deu HTTP 422 "description is too
  // long" tanto no self-heal quanto na criação manual do label real.
  "Alarme de EVENTO PASSADO (#5553) — não se auto-resolve, precisa de revisão humana";

/** Metadados de toda label que este módulo sabe AUTO-CRIAR via self-heal
 * (#5338, generalizado no #5553) — usado tanto por `ensureLabelExists` quanto
 * pelo setup manual documentado. Adicionar uma label nova ao mecanismo de
 * self-heal é só adicionar uma entry aqui. */
const SELF_HEALABLE_LABELS: Record<string, { color: string; description: string }> = {
  [ALARM_LABEL]: { color: ALARM_LABEL_COLOR, description: ALARM_LABEL_DESCRIPTION },
  [ALARM_EVENT_LABEL]: { color: ALARM_EVENT_LABEL_COLOR, description: ALARM_EVENT_LABEL_DESCRIPTION },
};

export type AlarmPriority = "P0" | "P1" | "P2" | "P3";

/**
 * Família do achado (#5553) — decide se o alarme SE AUTO-RESOLVE ou não.
 *
 *   - `"estado"`: condição RE-CHECÁVEL a cada execução (arquivo existe?
 *     drift sumiu? painel voltou a registrar?) — quando a condição observada
 *     muda pra "ok", o achado simplesmente para de aparecer em `pending` e o
 *     mecanismo de streak comenta/fecha a issue sozinho. Comportamento
 *     pré-#5553, inalterado.
 *   - `"evento"`: achado ancorado a um ID IMUTÁVEL (campanha, envio, post)
 *     que descreve um FATO já ocorrido — nunca "para de reproduzir" por
 *     alguém ter consertado algo; a checagem seguinte simplesmente para de
 *     reavaliar aquele ID específico (ex: `markEvaluated` em
 *     `clarice-guardrail-alarm.ts`) e o achado desaparece de `pending` sem
 *     que nada tenha sido resolvido. Sem tratamento especial, isso dispara o
 *     MESMO mecanismo de streak e fecha a issue sozinha com o achado real
 *     intocado (#5525) — daí `planAlarmReconciliation` abaixo nunca gerar
 *     `comment_resolved`/`advance_streak`/`close` pra uma entry `"evento"`.
 *
 * Explícito e OBRIGATÓRIO por decisão do #5553, não derivado do
 * `fingerprint`: a correlação "fingerprint embute um ID imutável → evento"
 * NÃO se sustenta em todos os alarmes já existentes —
 * `linkedin-weekly-staleness-alarm.ts` embute o CICLO (`26w33`, um ID) no
 * fingerprint e ainda assim é `"estado"` (a condição observada é "o artefato
 * existe pra ESTE ciclo?", re-checada toda semana; #5497 é o caso confirmado
 * de auto-close correto). Só quem EMITE o achado sabe se a condição pode
 * voltar a ficar "ok", então a declaração é do script chamador — errar aqui
 * devolve o problema original em silêncio (issue nasce invisível pro
 * classificador E se auto-fecha sozinha).
 */
export type AlarmFamily = "estado" | "evento";

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
  /** #5553 — `"estado"` (auto-resolve) ou `"evento"` (fato histórico, nunca
   * auto-resolve) — ver `AlarmFamily` acima. Obrigatório: toda issue de
   * alarme precisa desta declaração explícita do script emissor. */
  family: AlarmFamily;
  /** Labels extras além de "alarm" (+ "alarm-evento" se `family === "evento"`)
   * e a prioridade resolvida — tipicamente o tipo (`bug`/`enhancement`). */
  labels?: string[];
  /** Default `"P2"` (CLAUDE.md: toda issue nasce com label de prioridade). */
  priority?: AlarmPriority;
}

export interface AlarmIssueResult {
  issueNumber: number | null;
  url: string | null;
  /** #5978 — `"reopened"` é distinto de `"reused"`: a issue localizada
   * (por cache OU marcador) estava `CLOSED` no GitHub e este módulo a
   * reabriu porque o achado é família `"estado"` reproduzindo depois de
   * fechado (ver `ensureAlarmIssue`). `"reused"` continua significando
   * "issue existente adotada sem mudança de estado" — inclui o caso
   * `family: "evento"` fechado manualmente (nunca reaberto por este
   * módulo, comportamento intocado). */
  action: "created" | "reused" | "reopened" | "failed";
  error?: string;
}

// ─── Allowlist de achados aceitos como limitação permanente (#5364) ────────
// Ver docstring do módulo, seção "Allowlist de achados aceitos" — mecanismo
// genérico, entries declaradas por script chamador.

export interface AlarmAllowlistEntry {
  /** Eixo/categoria do achado — mesmo valor de `AlarmFinding.check`. */
  check: string;
  /** Fingerprint EXATO aceito — mesmo valor de `AlarmFinding.fingerprint`.
   * Match nunca é prefixo/regex (fail-safe: ver docstring do módulo). */
  fingerprint: string;
  /** Motivo da aceitação (texto livre, obrigatório) — por que este achado é
   * uma limitação permanente/sem-fix, não um bug a corrigir. */
  reason: string;
  /** Data (ISO `YYYY-MM-DD`) em que a decisão de aceitar foi tomada. */
  accepted_at: string;
  /** Issue de referência onde a investigação/decisão está documentada
   * (ex: `"#5364"`). */
  ref_issue: string;
}

export type AlarmAllowlist = readonly AlarmAllowlistEntry[];

/** Pura — `true` se `check`+`fingerprint` casa EXATAMENTE (nunca por
 * prefixo/regex) com alguma entry da allowlist. */
export function isAllowlisted(check: string, fingerprint: string, allowlist: AlarmAllowlist): boolean {
  return allowlist.some((e) => e.check === check && e.fingerprint === fingerprint);
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
  /** #5553 — família do achado no momento do último `ensure` (ver
   * `AlarmFamily`). `undefined` em entries persistidas ANTES do #5553 —
   * tratado como `"estado"` em `planAlarmReconciliation` (comportamento
   * pré-existente preservado pro `state.json` já em disco; só entries criadas
   * a partir desta mudança carregam o valor de verdade). */
  family?: AlarmFamily;
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

// ─── `gh` CLI (I/O, injetável — reusa scripts/lib/shared/gh-run.ts) ─────

export type GhRunFn = (args: string[], cwd: string) => GhSpawnResult;

/** Produção: `gh` de verdade, com o mesmo teto de tempo de
 * `scripts/lib/shared/gh-run.ts` (nunca trava o event loop indefinidamente
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
): { issueNumber: number; url: string; state: "OPEN" | "CLOSED" } | null {
  const marker = alarmFindingMarker(check, fingerprint);
  const res = run(
    [
      "issue",
      "list",
      "--search",
      `${check} ${fingerprint}`,
      "--state",
      "all",
      "--json",
      "number,url,body,state",
      "--limit",
      "30",
    ],
    cwd,
  );
  if (res.status !== 0) return null;
  let issues: { number: number; url: string; body: string; state: "OPEN" | "CLOSED" }[];
  try {
    issues = JSON.parse(res.stdout) as { number: number; url: string; body: string; state: "OPEN" | "CLOSED" }[];
  } catch {
    return null;
  }
  const match = issues.find((i) => (i.body ?? "").includes(marker));
  return match ? { issueNumber: match.number, url: match.url, state: match.state } : null;
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

/** Self-heal (#5338 item 1, generalizado no #5553) — best-effort, nunca
 * lança: tenta criar `labelName` no repo (`--force` o torna idempotente caso
 * já exista com cor/descrição diferentes de uma criação manual). `false` sem
 * tocar `gh` se `labelName` não é uma das `SELF_HEALABLE_LABELS` conhecidas —
 * só `alarm`/`alarm-evento` são auto-criáveis por este módulo. Chamada só no
 * caminho de retry (vale a pena tentar 1x quando `gh issue create` já falhou
 * por essa label especificamente) — não em toda execução, pra não gastar uma
 * chamada `gh` extra quando a label já existe (caso comum após a 1ª
 * auto-criação). */
function ensureLabelExists(labelName: string, cwd: string, run: GhRunFn): boolean {
  const meta = SELF_HEALABLE_LABELS[labelName];
  if (!meta) return false;
  const res = run(["label", "create", labelName, "--color", meta.color, "--description", meta.description, "--force"], cwd);
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
 * quando a falha é EXATAMENTE "label não encontrada": tenta self-heal de
 * toda label ausente que este módulo sabe auto-criar (`ensureLabelExists`,
 * generalizado no #5553 — hoje `alarm`/`alarm-evento`) e retenta mantendo
 * cada uma que curou com sucesso, ou sem ela (e sem qualquer outra label que o
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

  const healed = missing.filter((l) => ensureLabelExists(l, cwd, run));
  const stillMissing = missing.filter((l) => !healed.includes(l));
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
 * (fast path, ainda assim confirma estado real no GitHub pra família
 * "estado" — ver nota #5978 abaixo, NÃO é mais "sem tocar rede" nesse caso)
 * OU via busca por marcador (`findExistingAlarmIssue`, fallback quando o
 * cache não tem a entry) OU cria uma nova (com retry fail-soft de label
 * ausente — ver `createAlarmIssueWithLabelRetry`). Pode devolver
 * `action: "reopened"` (ver docstring do tipo `AlarmIssueResult`).
 * **NUNCA** fabrica `issueNumber`/`url` — se toda tentativa de `gh issue
 * create` falhar, devolve `action: "failed"` com `error` populado.
 */
export function ensureAlarmIssue(
  finding: AlarmFinding,
  cachedEntry: { issueNumber: number; url: string; closedAt?: string | null } | undefined,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): AlarmIssueResult {
  // #5978 — família "estado" reproduzindo com a issue já FECHADA no GitHub:
  // reabrir em vez de silenciosamente "reusar" uma issue que ninguém está
  // olhando. Nunca dispara pra `family: "evento"` (só um humano fecha, e a
  // decisão de reabrir também é dele, ver docstring de `AlarmFamily`).
  //
  // **Achado crítico do fleet review pré-merge (2ª rodada, mesmo #5978):**
  // a 1ª versão deste fix confiava só em `cachedEntry.closedAt` — mas esse
  // campo só é setado pelo AUTO-close deste próprio módulo (streak de
  // ausência). As 3 issues reais que motivaram a #5978 (#5942/#5826/#5653)
  // foram fechadas via PR merge ("Closes #N"), não pelo auto-close — então
  // `closedAt` local ficou `null` pra todas, e o fast path original nunca
  // as reabriria: reproduziria o bug original bit a bit na próxima
  // recorrência. Por isso, pra família "estado", SEMPRE confirma o estado
  // REAL via `gh issue view --json state` antes de decidir — `closedAt`
  // local não é mais usado pra decidir reopen, só seria informativo (mas
  // nem isso: a fonte de verdade agora é sempre o GitHub).
  if (cachedEntry) {
    if (finding.family === "estado") {
      const realState = fetchAlarmIssueState(cachedEntry.issueNumber, cwd, run);
      if (realState === "CLOSED") {
        if (reopenAlarmIssue(cachedEntry.issueNumber, cwd, run)) {
          return { issueNumber: cachedEntry.issueNumber, url: cachedEntry.url, action: "reopened" };
        }
        // Reopen falhou (gh indisponível, rate limit) — fail-soft: a issue
        // ainda existe, só não conseguimos reabrir agora. Mesmo
        // comportamento do estado pré-#5978 (nunca pior), próxima
        // execução tenta de novo.
      }
      // realState === "OPEN", ou null (gh indisponível — "não sei", nunca
      // assume fechado sem confirmação) -> reused normal, abaixo.
    }
    return { issueNumber: cachedEntry.issueNumber, url: cachedEntry.url, action: "reused" };
  }

  const existing = findExistingAlarmIssue(finding.check, finding.fingerprint, cwd, run);
  if (existing) {
    // #5978 — mesma lógica do cache fast path acima, mas pro fallback via
    // marcador (cache local ausente/perdido — ex: 1ª execução após clone
    // fresco, ou `state.json` apagado): `findExistingAlarmIssue` já retorna
    // o `state` real do GitHub (`--json ...,state`), então a decisão usa
    // esse valor direto, sem chamada extra.
    if (existing.state === "CLOSED" && finding.family === "estado") {
      if (reopenAlarmIssue(existing.issueNumber, cwd, run)) {
        return { issueNumber: existing.issueNumber, url: existing.url, action: "reopened" };
      }
    }
    return { issueNumber: existing.issueNumber, url: existing.url, action: "reused" };
  }

  const priority = finding.priority ?? "P2";
  // #5553 — `ALARM_EVENT_LABEL` ANEXADA (nunca substitui `ALARM_LABEL`): a
  // issue de evento continua achável por `gh issue list --label alarm`, e
  // `classifyExecTrack` checa `alarm-evento` ANTES de tratar `alarm` como
  // "se auto-resolve" (ver docstring de `RESOLVED_BY_PROSE_LABELS` lá).
  const familyLabels = finding.family === "evento" ? [ALARM_EVENT_LABEL] : [];
  const labels = [...new Set([...(finding.labels ?? []), ALARM_LABEL, ...familyLabels, priority])];
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

/**
 * #5978 (achado crítico do fleet review, 2ª rodada) — consulta o estado
 * REAL (`OPEN`/`CLOSED`) de uma issue via `gh issue view --json state`.
 * Existe porque `cachedEntry.closedAt` só reflete fechamento feito pelo
 * AUTO-close deste módulo (`closeAlarmIssue`) — uma issue fechada por PR
 * merge ou manualmente nunca seta esse campo, então confiar só nele deixa
 * exatamente o caso que motivou a #5978 sem cobertura. `null` se a chamada
 * falhar (gh indisponível, rate limit) — caller trata como "não sei",
 * nunca assume um lado (equivalente a "ainda aberta" na prática, já que o
 * caller só age em cima de `"CLOSED"` explícito).
 */
function fetchAlarmIssueState(issueNumber: number, cwd: string, run: GhRunFn): "OPEN" | "CLOSED" | null {
  const res = run(["issue", "view", String(issueNumber), "--json", "state"], cwd);
  if (res.status !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { state?: string };
    return parsed.state === "OPEN" || parsed.state === "CLOSED" ? parsed.state : null;
  } catch {
    return null;
  }
}

/**
 * #5978 — reabre uma issue de alarme com um comentário explicando o motivo
 * automático (o achado voltou a reproduzir depois de ter sido fechado —
 * nunca chamada pra `family: "evento"`, ver `ensureAlarmIssue`). `true` em
 * sucesso, `false` se `gh` falhar (fail-soft: caller decide o fallback —
 * hoje, tratar como `"reused"` mesmo com a issue ainda fechada no GitHub,
 * mesmo comportamento do estado pré-#5978, nunca pior).
 */
export function reopenAlarmIssue(
  issueNumber: number,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): boolean {
  const comment = "Reaberta automaticamente: o achado reproduziu de novo depois do fechamento automático (#5978).";
  const res = run(["issue", "reopen", String(issueNumber), "--comment", comment], cwd);
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
 *
 * `allowlist` (#5364, default `[]`) remove TODA ação sobre um fingerprint
 * aceito como limitação permanente — nem `ensure` do lado `pending` (nunca
 * cria/reabre issue pra ele), nem `comment_resolved`/`advance_streak`/
 * `close` do lado `state` (uma entry já existente pra esse fingerprint fica
 * congelada, tratada como fora do escopo de reconciliação a partir daqui).
 *
 * **#5553 — achado de família `"evento"` nunca entra no ramo `state` acima.**
 * Pra um achado `"estado"`, sumir de `pending` significa "a condição voltou
 * a ficar ok" — o streak de ausência é o sinal CORRETO de resolução. Pra
 * `"evento"`, sumir de `pending` só significa "o script parou de reavaliar
 * este ID específico" (ex: `markEvaluated` em `clarice-guardrail-alarm.ts`
 * nunca reavalia a MESMA campanha) — não que alguém tenha corrigido nada.
 * Sem esta exceção, o mesmo mecanismo de streak comenta "não reproduz mais"
 * e fecha a issue automaticamente com o achado real intocado (#5525: o
 * guardrail furado da campanha 146 nunca teve fix nem investigação — só
 * "parou de aparecer" porque a campanha já foi avaliada). Uma entry
 * `"evento"` fica CONGELADA (mesmo tratamento da allowlist acima) até um
 * humano fechar a issue manualmente — nunca por streak.
 */
export function planAlarmReconciliation(
  pending: readonly AlarmFinding[],
  state: AlarmIssuesState,
  closeAfterRuns: number,
  allowlist: AlarmAllowlist = [],
): AlarmReconcileAction[] {
  const actions: AlarmReconcileAction[] = [];
  const activePending = pending.filter((f) => !isAllowlisted(f.check, f.fingerprint, allowlist));
  const pendingKeys = new Set(activePending.map((f) => alarmIssueStateKey(f.check, f.fingerprint)));
  const allowlistedKeys = new Set(allowlist.map((e) => alarmIssueStateKey(e.check, e.fingerprint)));

  for (const finding of activePending) {
    actions.push({ kind: "ensure", finding });
  }

  for (const [key, entry] of Object.entries(state)) {
    if (allowlistedKeys.has(key)) continue;
    if (pendingKeys.has(key)) continue;
    if (entry.closedAt) continue;
    // #5553 — entries sem `family` persistida (state.json pré-#5553) tratam
    // como "estado", preservando o comportamento de auto-close de antes.
    if ((entry.family ?? "estado") === "evento") continue;
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
  /** #5364 — achados aceitos como limitação permanente; default `[]`
   * (comportamento inalterado quando o caller não passa nada). */
  allowlist?: AlarmAllowlist;
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
  const allowlist = opts.allowlist ?? [];
  const nextState: AlarmIssuesState = { ...state };
  const findingOutcomes: AlarmFindingOutcome[] = [];

  const actions = planAlarmReconciliation(pending, state, opts.closeAfterRuns, allowlist);

  for (const action of actions) {
    if (action.kind === "ensure") {
      const key = alarmIssueStateKey(action.finding.check, action.finding.fingerprint);
      const cachedEntry = state[key];
      const result = ensureAlarmIssue(
        action.finding,
        // #5978 — repassa `closedAt` pro `ensureAlarmIssue` decidir se
        // precisa reabrir (só entries "estado" chegam aqui com `closedAt`
        // setado — `close` nunca roda pra "evento", ver `planAlarmReconciliation`).
        cachedEntry
          ? { issueNumber: cachedEntry.issueNumber, url: cachedEntry.url, closedAt: cachedEntry.closedAt }
          : undefined,
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
        // pendente do ponto de vista do tracking local. #5978: pra família
        // "estado" isto AGORA também reabre a issue no GitHub de verdade
        // (`ensureAlarmIssue` acima, `action: "reopened"`) — antes disso a
        // issue ficava fechada no GitHub enquanto o tracking local achava
        // que estava "reaberta", e o achado silenciava numa issue que
        // ninguém olhava (#5978). Família "evento" nunca chega aqui com
        // `closedAt` setado (só um humano fecha essas, ver
        // `planAlarmReconciliation`), então continua sem reabrir sozinha.
        closedAt: null,
        // #5553 — sempre estampa a família ATUAL do finding, mesmo em
        // reused/cache-hit: se o script chamador algum dia reclassificar o
        // achado, o `state.json` se auto-corrige no próximo `ensure`.
        family: action.finding.family,
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
