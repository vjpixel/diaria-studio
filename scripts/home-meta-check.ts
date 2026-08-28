#!/usr/bin/env node
/**
 * scripts/home-meta-check.ts (#4557, #5099, #5106, #5112)
 *
 * **Nome do arquivo/task é herdado da era em que a home era um tema Beehiiv
 * — desatualizado desde o cutover do apex (#467, confirmado ao vivo em
 * 28/08/2026): `https://diar.ia.br/` hoje é servida por
 * `workers/site/public/index.html`, código deste repo, não pela Beehiiv.
 * Renomear arquivo(s) + task agendada tem blast radius próprio (a task roda
 * no `helios` via systemd) e fica pra decisão futura — rastreado em #6498,
 * que também decide o destino do eixo `english-labels` (só faz sentido
 * numa home-tema-Beehiiv; numa home HTML nossa não detecta mais o que foi
 * criado pra detectar — ver nota de escopo no topo de
 * `scripts/lib/home-meta-check.ts`). Os demais eixos continuam
 * válidos: `port-in-url` avalia a página de edição (`/p/{slug}`, ainda
 * render Beehiiv em cache); `og-title-brand`/`http-self-link`/
 * `legacy-host-link` são checáveis em qualquer home; `hub-link-missing`
 * virou guard de regressão do gerador (#6411).**
 *
 * Smoke-test de runtime: bate `GET https://diar.ia.br/` (home pública — GET
 * simples, sem autenticação, sem API do Beehiiv, sem MCP — qualquer visitante
 * vê o mesmo HTML, isso NÃO é uma ação de publish/schedule/send) e verifica
 * os eixos de drift documentados em `scripts/lib/home-meta-check.ts`:
 * `og:title` sem a marca oficial (ou com a grafia legada "Diar.ia"),
 * self-links `href="http://diar.ia.br..."` (deveria ser https), rótulos
 * residuais em inglês na UI do tema Beehiiv ("Sign Up", "Login", "N min
 * read" — eixo `english-labels`, ver nota de escopo acima), links pra host
 * legado (#5099), e — desde #5106 — porta explícita numa URL reader-facing,
 * checado contra a página da edição mais recente (não a home; ver
 * `findLatestPostUrl`/`evaluatePostPageDrift`). Se algum eixo der drift,
 * alarma o editor por e-mail — e, desde #5112, garante uma issue GitHub por
 * achado (criada ou reusada) e comenta/fecha issues cujo achado deixou de
 * reproduzir.
 *
 * Contexto: a issue #4557 original pede 3 mudanças de PAINEL Beehiiv e diz
 * explicitamente que não é código — é ação manual do editor no painel. O
 * único pedaço que ela autoriza em código é "um teste/guard que detecte
 * regressão de og:title" (generalizado aqui pros eixos igualmente checáveis
 * a partir do HTML público). Sem este guard, uma regressão nesses eixos (ex:
 * o tema Beehiiv resetar config num update, ou o editor mudar algo sem
 * perceber o efeito colateral) fica invisível — ninguém olha a home pública
 * todo dia.
 *
 * Ver `scripts/lib/home-meta-check.ts` pra decisão pura
 * (`evaluateHomeMetaDrift`/`evaluatePostPageDrift`) + extração de metadata +
 * fingerprint/idempotência do alarme, e `scripts/lib/alarm-issues.ts` (#5112)
 * pro helper genérico de criação/dedup/reconciliação de issue por achado.
 *
 * Uso:
 *   npx tsx scripts/home-meta-check.ts               # avalia + persiste + alarma se NOVO drift + reconcilia issues
 *   npx tsx scripts/home-meta-check.ts --dry-run      # avalia + imprime, NÃO persiste/alarma/toca gh
 *   npx tsx scripts/home-meta-check.ts --to email@x   # override do destinatário do alarme
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais deste repo) — só necessário quando há drift pra
 * de fato enviar o e-mail; a checagem HTTP em si não precisa de credencial
 * nenhuma (GET público, sem auth). `gh` CLI autenticado — só necessário pra
 * criar/comentar/fechar issue (#5112); sem ele, `ensureAlarmIssue` falha
 * fail-soft (o e-mail sai assim mesmo, com o motivo — nunca perde o alarme
 * por falta de `gh`). Não precisa do junction `data/` pra rodar a checagem
 * em si — só pra persistir o estado de idempotência
 * (`data/home-meta-check/state.json` + `alarm-issues.json`).
 *
 * Como os outros alarmes locais deste repo (#4320/#4382/#4490/#4534/#4723/
 * #4740/#4750), o registro da task no Task Scheduler e a 1ª execução ao vivo
 * nunca rodaram nesta unidade (worktree isolado, sem `data/.credentials.json`
 * real; e a regra de dispatch overnight #738/#3453 proíbe qualquer chamada de
 * rede real nesta sessão, mesmo sendo GET público de leitura — ver PR body) —
 * validado só via testes com a lógica pura + fetch/gh mockados (sem rede
 * real).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { BEEHIIV_BASE_URL } from "./lib/edition-url.ts";
import {
  extractHomeMeta,
  evaluateHomeMetaDrift,
  evaluatePostPageDrift,
  findLatestPostUrl,
  hasHomeMetaDrift,
  computeHomeMetaFingerprint,
  shouldAlarmHomeMetaDrift,
  advanceHomeMetaAlarmState,
  emptyHomeMetaAlarmState,
  buildHomeMetaDriftAlarmEmail,
  homeMetaFindingIssueKey,
  type HomeMetaAlarmState,
  type HomeMetaDriftFinding,
  type HomeMetaFindingIssueRef,
} from "./lib/home-meta-check.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  aggregateFindingsOnDebut,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
  type AlarmPriority,
  type AlarmAllowlist,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "home-meta-check", "state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "home-meta-check", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[home-meta-check]";
const FETCH_TIMEOUT_MS = 15_000;
const HOME_URL = `${BEEHIIV_BASE_URL}/`;
/** #5112/#5113: a task virou diária (#5113) — 2 execuções consecutivas sem
 * o achado = 48h antes de fechar automaticamente (não mais 12h, que era
 * baseado na cadência antiga de 6h). Ver interação documentada na issue
 * #5113 ("se a #5112 for implementada antes desta, atualizar o comentário
 * lá pra dizer 48h" — já nasce correto aqui porque implementamos as duas
 * juntas). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/** #6572 — grupo declarado em cada finding pra `aggregateFindingsOnDebut`
 * (`alarm-issues.ts`), 3º consumidor do mecanismo genérico (junto de
 * `session-registry-safebackup`, #6562/#6564, e `systemd-unit-rate`,
 * também #6572). Este check tem só 6 eixos possíveis — o volume nunca
 * chega perto do que motivou os outros dois consumidores — mas o opt-in é
 * de graça (findings sem `group` nunca agregam, e abaixo do teto o
 * comportamento é idêntico ao pré-#6572: 1 issue por eixo). */
const HOME_META_GROUP = "home-meta-check";
/** Teto (exclusivo) — na prática nunca deve disparar (só 6 eixos possíveis
 * no total), mas mantém o check simetricamente pronto se um eixo novo
 * passar a emitir múltiplos findings por execução. */
const HOME_META_ESTREIA_AGGREGATE_THRESHOLD = 4;
const HOME_META_ESTREIA_AGGREGATE_FINGERPRINT = "estreia-aggregate";

// ─── Estado (idempotência do E-MAIL) — mesmo padrão I/O de hub-drift-check.ts ─

export function loadState(statePath: string = STATE_PATH): HomeMetaAlarmState {
  if (!existsSync(statePath)) return emptyHomeMetaAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<HomeMetaAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fingerprint ?? null, lastCheckedAt: checkedAt ?? null };
  } catch {
    return emptyHomeMetaAlarmState();
  }
}

export function saveState(state: HomeMetaAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ─── Estado (dedup/reconciliação de ISSUE por achado, #5112) ──────────────
// Arquivo separado de STATE_PATH de propósito: idempotência do E-MAIL
// (acima) e tracking de ISSUE por achado são preocupações independentes —
// um achado pode continuar tendo o MESMO e-mail suprimido (fingerprint já
// alarmado) enquanto sua issue segue sendo reconciliada normalmente.

export function loadAlarmIssuesState(statePath: string = ALARM_ISSUES_STATE_PATH): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch {
    return emptyAlarmIssuesState();
  }
}

export function saveAlarmIssuesState(state: AlarmIssuesState, statePath: string = ALARM_ISSUES_STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/** Prioridade por eixo (#5112 item 4 — "o check sabe a gravidade dele").
 * Todos os eixos deste check são `P2` hoje: nenhum é fire (produção
 * corrompida/leak, que seria P0) nem tem impacto sem workaround (P1) — são
 * achados reader-facing com correção manual simples no painel/template.
 * Mapa nasce vazio de propósito (fallback pro default abaixo) — existe pra
 * já ter o formato certo no dia que um eixo precisar de prioridade
 * diferente dos outros. */
const PRIORITY_BY_CHECK: Partial<Record<HomeMetaDriftFinding["check"], AlarmPriority>> = {};

function priorityForCheck(check: HomeMetaDriftFinding["check"]): AlarmPriority {
  return PRIORITY_BY_CHECK[check] ?? "P2";
}

/** Achados deste check aceitos como limitação PERMANENTE de plataforma —
 * ver docstring de `scripts/lib/alarm-issues.ts` seção "Allowlist de
 * achados aceitos" (#5364). Cada entry pula toda ação de issue
 * (criar/reabrir/comentar/fechar) pro fingerprint EXATO listado — o
 * smoke-test continua rodando e reportando o drift normalmente (o achado
 * segue aparecendo em `findings`/no e-mail), só a issue automática do
 * GitHub para de ser tocada.
 *
 * `english-labels:"N min read"`: investigado ao vivo em 3 sessões
 * `/diaria-develop` de 260816 (260816, 260816b, 260816c) — o rótulo "N min
 * read" vem do merge tag nativo "Read time" do tema Beehiiv, que não tem
 * opção de localização pt-BR, e o workspace está no plano Launch/free (sem
 * acesso a customização de tema que permitiria substituir o merge tag por
 * um equivalente traduzido). Nenhuma das 3 investigações achou alavanca do
 * lado do código deste repo — é puramente uma limitação da plataforma
 * hospedante. Ref: #5364. O fingerprint é exato pro texto atual da
 * mensagem (`homeMetaFindingIssueKey` — `${check}:${message}`); se o texto
 * do achado mudar (ex: outro rótulo em inglês aparecer junto de "N min
 * read"), o fingerprint muda e este item PARA de casar — não silencia um
 * achado novo por acidente.
 *
 * **Nota #6498 (28/08/2026):** esta entry nasceu quando `english-labels`
 * era o guard do TEMA Beehiiv da home. Desde o cutover do apex (#467) a
 * home é `workers/site/public/index.html` (HTML nosso) e o eixo virou guard
 * genérico (ver nota no topo de `scripts/lib/home-meta-check.ts`) — o merge
 * tag "Read time" do tema Beehiiv não existe mais na home, então este
 * fingerprint exato provavelmente nunca mais casa. Mantido como registro
 * histórico da limitação de plataforma (não fazia mal remover, mas também
 * não é preciso — o item só passa a operar de novo se o texto exato
 * reaparecer, o que exigiria a home voltar a ser um tema Beehiiv). */
export const ALARM_ALLOWLIST: AlarmAllowlist = [
  {
    check: "english-labels",
    fingerprint: 'english-labels:rótulo(s) em inglês residual(is) encontrado(s): "N min read"',
    reason:
      "limitação de plataforma Beehiiv, merge tag 'Read time' nativo não localiza, sem alavanca no plano " +
      "Launch/free — investigado em 3 sessões develop de 260816, sem workaround encontrado",
    accepted_at: "2026-08-16",
    ref_issue: "#5364",
  },
];

/** Converte um achado de drift no `AlarmFinding` genérico que
 * `scripts/lib/alarm-issues.ts` consome. O `fingerprint` usa a MESMA
 * fórmula de `homeMetaFindingIssueKey`/`computeHomeMetaFingerprint` por
 * item (`${check}:${message}`) — é isso que deixa o e-mail casar
 * `findingOutcomes` de volta contra cada `HomeMetaDriftFinding` sem
 * precisar de um id separado. */
export function toAlarmFinding(f: HomeMetaDriftFinding): AlarmFinding {
  return {
    check: f.check,
    fingerprint: homeMetaFindingIssueKey(f),
    // #5553 — os 6 eixos deste check são todos condição RE-CHECÁVEL do HTML
    // publicado (marca no og:title, links http, rótulos em inglês, etc.);
    // resolvem sozinhos quando a página corrige.
    family: "estado",
    title: `[diar.ia.br] drift na home: ${f.check}`,
    body: [
      "Achado automático do smoke-test `Diaria-Home-Meta-Check`",
      "(`scripts/home-meta-check.ts`).",
      "",
      `Eixo: \`${f.check}\``,
      `Detalhe: ${f.message}`,
      "",
      `Home: ${HOME_URL}`,
      "",
      "Refs #4557/#5099/#5106 — a correção é ação manual do editor no",
      "painel/template Beehiiv, não código deste repo. Esta issue é criada",
      "automaticamente pelo alarme (#5112) e será comentada/fechada sozinha",
      "quando o achado deixar de reproduzir por 2 execuções consecutivas.",
    ].join("\n"),
    labels: ["bug"],
    priority: priorityForCheck(f.check),
    group: HOME_META_GROUP,
  };
}

/**
 * #6572 — achado agregado da estreia (`aggregateFindingsOnDebut`
 * `buildAggregate`, injetado). Mesmo formato dos outros 2 consumidores
 * (`session-registry-safebackup`/`systemd-unit-rate`): lista cada eixo
 * individual (fingerprint + título já formatado) em vez do
 * `HomeMetaDriftFinding` original, que não chega até aqui.
 */
export function buildAggregatedHomeMetaFinding(findings: readonly AlarmFinding[]): AlarmFinding {
  const sorted = [...findings].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  return {
    check: "home-meta-check",
    fingerprint: HOME_META_ESTREIA_AGGREGATE_FINGERPRINT,
    title: `[diar.ia.br] ${sorted.length} eixos de drift na home na estreia do alarme`,
    body: [
      "Achado automático do smoke-test `Diaria-Home-Meta-Check`",
      "(`scripts/home-meta-check.ts`), agregado por ser a 1ª execução (modo de estreia, #6572).",
      "",
      `${sorted.length} eixos com drift encontrados na 1ª execução deste alarme nesta máquina/checkout — acima do ` +
        `teto de ${HOME_META_ESTREIA_AGGREGATE_THRESHOLD}, agregados nesta issue única em vez de 1 issue por eixo:`,
      "",
      ...sorted.map((f) => `- \`${f.check}\`: ${f.body.split("\n").find((l) => l.startsWith("Detalhe:")) ?? f.title}`),
      "",
      `Home: ${HOME_URL}`,
      "",
      "Refs #4557/#5099/#5106 — a correção é ação manual do editor no",
      "painel/template Beehiiv, não código deste repo. Esta issue agregada é exclusiva da 1ª execução do alarme — a " +
        "partir da execução seguinte o alarme volta ao modo normal (1 issue por eixo) e esta issue se fecha sozinha, " +
        "independente de os eixos ainda derivarem ou não.",
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
    family: "estado",
  };
}

// ─── Checagem HTTP (I/O, fail-soft) ────────────────────────────────────────

/**
 * Bate `GET url` e resolve pra `{ html, fetchError }` — NUNCA lança: uma
 * falha de rede (timeout, DNS, conexão recusada) ou HTTP não-2xx vira
 * `fetchError` preenchido em vez de propagar.
 */
export async function fetchHomeHtml(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ html: string | null; fetchError: string | null }> {
  try {
    const res = await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { html: null, fetchError: `HTTP ${res.status}` };
    return { html: await res.text(), fetchError: null };
  } catch (e) {
    return { html: null, fetchError: (e as Error).message };
  }
}

/**
 * #5106 — busca a página da edição mais recente (achada via
 * `findLatestPostUrl` sobre o HTML da home já buscado) e avalia o 5º eixo
 * (`port-in-url`) contra ela. Fail-soft em toda borda: sem link `/p/` na
 * home, ou falha ao buscar a página do post, retorna `findings: []` com o
 * motivo logado — nunca bloqueia a checagem da home, que é o núcleo deste
 * script desde #4557.
 */
export async function checkLatestPostPage(
  homeHtml: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ findings: HomeMetaDriftFinding[]; postUrl: string | null }> {
  const postUrl = findLatestPostUrl(homeHtml, BEEHIIV_BASE_URL);
  if (!postUrl) {
    console.log(`${LOG_PREFIX} nenhum link /p/ encontrado na home — eixo port-in-url pulado nesta execução.`);
    return { findings: [], postUrl: null };
  }
  console.log(`${LOG_PREFIX} checando página da edição mais recente: ${postUrl}`);
  const { html, fetchError } = await fetchHomeHtml(postUrl, fetchFn);
  if (fetchError || html === null) {
    console.error(`${LOG_PREFIX} falha ao buscar ${postUrl}: ${fetchError} — eixo port-in-url pulado nesta execução.`);
    return { findings: [], postUrl };
  }
  return { findings: evaluatePostPageDrift(html), postUrl };
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  console.log(`${LOG_PREFIX} checando ${HOME_URL}`);

  const { html, fetchError } = await fetchHomeHtml(HOME_URL);
  if (fetchError || html === null) {
    // Fail-soft: falha de rede na checagem em si não é o drift que este
    // script existe pra detectar (é infra, não conteúdo) — loga e sai com
    // erro sem persistir/alarmar, mesma disciplina do restante do repo pra
    // falha de checagem inteira (ver docstring de hub-drift-check.ts §"por
    // que broken inclui tanto HTTP não-200 quanto erro de fetch" pro porquê
    // de NÃO tratar isso como "drift" propriamente dito).
    console.error(`${LOG_PREFIX} falha ao buscar ${HOME_URL}: ${fetchError}`);
    process.exitCode = 1;
    return;
  }

  const extract = extractHomeMeta(html);
  const homeFindings = evaluateHomeMetaDrift(html, extract);
  const { findings: postFindings } = await checkLatestPostPage(html);
  const findings = [...homeFindings, ...postFindings];

  if (findings.length === 0) {
    console.log(`${LOG_PREFIX} nenhum drift — todos os eixos monitorados estão limpos.`);
  } else {
    for (const f of findings) {
      console.log(`${LOG_PREFIX} [${f.check}] ${f.message}`);
    }
  }

  // #5112 — reconcilia issue por achado ANTES de montar o e-mail (o e-mail
  // cita a issue de cada achado pendente). Roda TODA execução não-dry-run,
  // independente de um e-mail novo disparar ou não nesta rodada — é o que
  // permite detectar "achado sumiu" prontamente (comment) e fechar depois
  // de CLOSE_ALARM_ISSUE_AFTER_RUNS execuções limpas consecutivas, mesmo
  // quando o drift ainda pendente é o MESMO já alarmado antes (sem e-mail
  // novo). Em --dry-run, só PLANEJA (puro, sem tocar `gh`) e imprime.
  const alarmState = loadAlarmIssuesState();
  const stateIsEmpty = Object.keys(alarmState).length === 0;
  // #6572 — modo de estreia: vários eixos com drift na 1ª execução (state
  // vazio) agregam numa issue só acima do teto, mesmo mecanismo genérico
  // usado por `session-registry-safebackup-alarm.ts` (#6562/#6564) e
  // `systemd-unit-rate-alarm.ts` (#6572). Na prática nunca dispara (só 6
  // eixos possíveis), mas o check já opta pelo mesmo mecanismo.
  const alarmFindings = aggregateFindingsOnDebut(findings.map(toAlarmFinding), {
    threshold: HOME_META_ESTREIA_AGGREGATE_THRESHOLD,
    stateIsEmpty,
    buildAggregate: (_group, groupFindings) => buildAggregatedHomeMetaFinding(groupFindings),
  });
  let issueRefs: Map<string, HomeMetaFindingIssueRef> | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS, ALARM_ALLOWLIST);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
  } else {
    const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
      allowlist: ALARM_ALLOWLIST,
    });
    saveAlarmIssuesState(nextState);
    issueRefs = new Map(
      findingOutcomes.map((o) => [
        o.fingerprint,
        { issueNumber: o.issueNumber, url: o.url, action: o.action, error: o.error },
      ]),
    );
    for (const o of findingOutcomes) {
      if (o.action === "failed") {
        console.error(`${LOG_PREFIX} [${o.check}] issue não criada/reusada: ${o.error}`);
      } else {
        console.log(`${LOG_PREFIX} [${o.check}] issue #${o.issueNumber} (${o.action}): ${o.url}`);
      }
    }
  }

  const state = loadState();
  const pending = hasHomeMetaDrift(findings);
  console.log(
    `${LOG_PREFIX} ${pending ? "drift pendente" : "nenhum drift pendente"} ` +
      `(última checagem: ${state.lastCheckedAt ?? "nunca"}).`,
  );

  if (shouldAlarmHomeMetaDrift(state, findings)) {
    const { subject, body } = buildHomeMetaDriftAlarmEmail(findings, extract, HOME_URL, issueRefs);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // Mesmo racional de hub-drift-check.ts/worker-drift-check.ts: sem
      // try/catch — se o envio falhar, o cursor abaixo não avança (aborta
      // antes do saveState), então a próxima execução tenta alarmar de novo
      // em vez de marcar este drift como "já avisado" sem o editor ter
      // recebido nada.
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (sem drift pendente, ou o mesmo drift já foi alarmado antes).`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: cursor NÃO avançado.`);
    return;
  }

  const nextFingerprint = pending ? computeHomeMetaFingerprint(findings) : null;
  saveState(advanceHomeMetaAlarmState(nextFingerprint, new Date()));
}

if (isMainModule(import.meta.url)) {
  // #4745: process.exitCode em vez de process.exit() — este catch roda DEPOIS
  // de awaits de rede (fetchHomeHtml/sendGmailMessage), mesmo cenário
  // UV_HANDLE_CLOSING no Windows documentado em worker-drift-check.ts.
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
