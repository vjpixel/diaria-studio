/**
 * scripts/lib/brevo-unrecognised-ip-alarm.ts (#6137)
 *
 * Companion module de `brevo-client.ts` — que se declara PROPOSITALMENTE
 * "sem estado" na própria docstring — pra detectar o 401 "unrecognised IP"
 * da Brevo (bloqueio de allowlist de IP por CONTA) e emitir um achado
 * estruturado via `alarm-issues.ts` (mesmo padrão do #5339,
 * `clarice-guardrail-alarm.ts`).
 *
 * Origem: incidente #6124/#6132 (24-25/08/2026) — a Brevo passou a rejeitar
 * o IP do `helios` na conta Clarice, e ninguém percebeu por ~26h porque o
 * sinal (401 com mensagem autoexplicativa, incluindo o próprio IP bloqueado
 * e a URL da allowlist) nunca virou um achado nomeado — só 4 units systemd
 * falhando em silêncio, e `Diaria-Systemd-Failed-Units-Alarm` reportando a
 * causa de uma falha ANTERIOR já superada (estado observado na criação da
 * issue, nunca recapturado — #6034).
 *
 * ─── Ponto de instrumentação ────────────────────────────────────────────────
 *
 * `brevo-client.ts` tem DOIS caminhos de `fetch` reais: `brevoRawFetch`
 * (usado por `brevoPost`/`brevoPut`/`brevoGetCampaign`/`brevoGetList`/
 * `brevoListAllLists`/`brevoListAllFolders`/`brevoSendNow`) e `brevoGet`
 * (usado por `fetchCampaignsByStatus`/`fetchDraftCampaigns`/
 * `fetchQueuedCampaignListIds`/`fetchSentCampaignListIds` — E diretamente
 * por `clarice-guardrail-alarm.ts`, um dos 4 units afetados pelo incidente
 * de origem). A issue #6137 nomeia só `brevoRawFetch` como ponto único, mas
 * isso deixaria `brevoGet` — e o próprio guardrail-alarm — fora de
 * cobertura; os dois pontos chamam `maybeReportUnrecognisedIp` abaixo.
 *
 * ─── Dedup (#6137 "não alarma em loop") ─────────────────────────────────────
 *
 *  - EM PROCESSO: `reportedInProcess` (Set module-level) evita re-acionar a
 *    reconciliação (que spawna `gh`, um processo real) mais de 1x por
 *    fingerprint (conta+IP) na mesma execução — sem isto, um script que
 *    repete N chamadas Brevo até esgotar retries dispararia N round-trips a
 *    `gh` pro MESMO achado.
 *  - ENTRE EXECUÇÕES: `alarm-issues.ts` já garante 1 issue por fingerprint
 *    (reusa via cache local + marcador no corpo, nunca duplica — ver
 *    docstring de `ensureAlarmIssue` lá).
 *
 * `family: "estado"` (não "evento"): a condição É re-checável — quando o
 * editor autoriza o IP na Brevo, o 401 para de reproduzir e o mecanismo de
 * streak de `alarm-issues.ts` fecha a issue sozinho (diferente de um
 * achado ancorado a um ID imutável que nunca é reavaliado, como campanha
 * enviada em `clarice-guardrail-alarm.ts`).
 *
 * ─── Seam de teste ───────────────────────────────────────────────────────
 *
 * `brevoRawFetch`/`brevoGet` chamam `maybeReportUnrecognisedIp` sem thread
 * de opções (mantendo `brevo-client.ts` "sem estado" — a config de I/O vive
 * só aqui). Um teste que exercite o caminho via `brevoPost`/`brevoGet`
 * precisa: (a) nunca deixar `gh` real ser spawnado, (b) nunca deixar
 * `resolveHostOutboundIps` bater na rede real (ipify) durante `npm test`.
 * `__setUnrecognisedIpAlarmTestOverrides`/`__resetUnrecognisedIpAlarmTestOverrides`
 * resolvem os dois — NUNCA usados em produção (sem override, os defaults
 * reais valem sempre).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.ts";
import {
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
  type GhRunFn,
} from "./alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** `data/` é gitignored (junction OneDrive) — mesma convenção do resto do
 * projeto (ex: `clarice-guardrail-alarm-issues.json`). */
export const DEFAULT_ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data/brevo-unrecognised-ip-alarm-issues.json");

/** URL citada na mensagem da issue — "prontos pra colar" (critério da #6137). */
export const AUTHORISED_IPS_URL = "https://app.brevo.com/security/authorised_ips";

export const CHECK = "brevo-unrecognised-ip";

/** Igual ao usado por `clarice-guardrail-alarm.ts` — 2 execuções consecutivas
 * sem o achado fecha a issue sozinha. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Detecção (pura) ────────────────────────────────────────────────────────

/** Formato observado ao vivo (#6124): "...using an unrecognised IP address
 * 2804:1b3:a941:cb3a:9a28:a6ff:fe0c:1af7. If you performed..." — casa IPv4 e
 * IPv6 (dígitos hex + ':' + '.'). */
const UNRECOGNISED_IP_RE = /unrecognised IP address\s+([0-9a-fA-F:.]+)/i;

/** Pura — extrai o IP citado no corpo do 401, `null` se o corpo não for
 * dessa classe de erro (qualquer outro 401 — key inválida/revogada — não
 * deve virar este achado). */
export function parseUnrecognisedIpBody(bodyText: string | null | undefined): string | null {
  if (!bodyText) return null;
  const match = bodyText.match(UNRECOGNISED_IP_RE);
  if (!match) return null;
  // A classe de caracteres do regex inclui '.' (necessário pra IPv4) e por
  // isso também casa o ponto final da frase da Brevo ("...1af7. If you
  // performed...") quando o IP é o último token antes da pontuação — um
  // IPv4/IPv6 nunca termina com '.', então remover 1 trailing '.' é sempre
  // seguro (nunca corta um octeto de verdade).
  return match[1].replace(/\.$/, "");
}

/** Pura — resolve qual conta Brevo (`clarice`/`diaria`) corresponde à
 * `apiKey` usada na chamada, comparando contra as duas envs conhecidas do
 * projeto. `"desconhecida"` se nenhuma bater (key custom/futura conta) —
 * nunca lança, o achado ainda é útil sem o rótulo de conta certeiro. */
export function resolveBrevoAccountLabel(
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (apiKey && env.BREVO_CLARICE_API_KEY && apiKey === env.BREVO_CLARICE_API_KEY) return "clarice";
  if (apiKey && env.BREVO_DIARIA_API_KEY && apiKey === env.BREVO_DIARIA_API_KEY) return "diaria";
  return "desconhecida";
}

export interface UnrecognisedIpFindingParams {
  account: string;
  ip: string;
  endpoint: string;
  timestamp: Date;
  hostIPv4: string | null;
  hostIPv6: string | null;
}

/** Pura — monta o `AlarmFinding` completo. `fingerprint` é `conta:ip`
 * (critério explícito da #6137: "dedup por fingerprint (conta + IP)") —
 * então um MESMO IP bloqueado gera 1 issue só, não importa quantas chamadas
 * falharam nem de qual script/unit vieram. */
export function buildUnrecognisedIpFinding(params: UnrecognisedIpFindingParams): AlarmFinding {
  const { account, ip, endpoint, timestamp, hostIPv4, hostIPv6 } = params;
  const fingerprint = `${account}:${ip}`;
  const tsIso = timestamp.toISOString();
  const body = [
    "Achado automático de `scripts/lib/brevo-client.ts` (#6137) — 401 da Brevo",
    'com corpo "unrecognised IP" (bloqueio de allowlist de IP por CONTA).',
    "",
    `Conta Brevo: ${account}`,
    `IP citado pela própria resposta: ${ip}`,
    `Endpoint: ${endpoint}`,
    `Timestamp: ${tsIso}`,
    "",
    "IPs de saída do host que gerou este achado (IPv4 e IPv6), prontos pra",
    `colar em ${AUTHORISED_IPS_URL}:`,
    "",
    `  IPv4  ${hostIPv4 ?? "não resolvido (rede indisponível/timeout — ver o IP citado acima)"}`,
    `  IPv6  ${hostIPv6 ?? "não resolvido (rede indisponível/timeout — ver o IP citado acima)"}`,
    "",
    "Ação (só o editor pode — exige navegador logado na conta Brevo correta,",
    "não há endpoint de API pra gerenciar a allowlist):",
    "",
    `  1. Abrir ${AUTHORISED_IPS_URL} logado na conta ${account}.`,
    "  2. Autorizar os DOIS IPs acima — mesmo que só um deles apareça no erro,",
    "     uma chamada seguinte pode sair pelo outro protocolo.",
    "  3. Confirmar com uma leitura real antes de fechar:",
    "     `npx tsx -e 'const r=await fetch(\"https://api.brevo.com/v3/account\"," +
      "{headers:{\"api-key\":process.env.BREVO_" + account.toUpperCase() + "_API_KEY!}}); console.log(r.status)'`",
    "",
    "Esta issue é criada automaticamente pelo alarme #6137 — achado de ESTADO",
    "(re-checável, #5553): quando o IP for autorizado, o 401 para de reproduzir",
    "e a issue se auto-fecha sozinha em execuções consecutivas sem o achado.",
  ].join("\n");
  return {
    check: CHECK,
    fingerprint,
    family: "estado",
    title: `[diar.ia.br] Brevo bloqueou IP ${ip} da conta ${account} (401 unrecognised IP)`,
    body,
    labels: ["bug"],
    // #6124 (causa original) foi P1 — bloqueio de allowlist paralisa TODA
    // chamada de API da conta afetada, não é degradação parcial.
    priority: "P1",
  };
}

// ─── Resolução dos IPs de saída do host (best-effort, fail-soft) ───────────

/**
 * Consulta ipify (free tier, sem key — zero custo recorrente) pra descobrir
 * os IPs de saída do host — IPv4 via `api.ipify.org`, IPv6 via
 * `api6.ipify.org` (só responde se o host tiver rota IPv6 de fato; sem ela,
 * timeout/erro -> `null`, nunca lançado). As duas chamadas rodam em
 * paralelo com timeout curto (`timeoutMs`, default 5s) — este é um extra
 * best-effort pro corpo da issue, nunca deve atrasar a chamada Brevo real
 * que originou a detecção por mais que o necessário.
 */
export async function resolveHostOutboundIps(
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<{ ipv4: string | null; ipv6: string | null }> {
  const fetchOne = async (url: string): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { signal: controller.signal });
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const [ipv4, ipv6] = await Promise.all([
    fetchOne("https://api.ipify.org"),
    fetchOne("https://api6.ipify.org"),
  ]);
  return { ipv4, ipv6 };
}

// ─── Estado local (cache do mecanismo genérico de alarm-issues.ts) ─────────

export function loadUnrecognisedIpAlarmState(
  path: string = DEFAULT_ALARM_ISSUES_STATE_PATH,
): AlarmIssuesState {
  if (!existsSync(path)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch {
    return emptyAlarmIssuesState();
  }
}

export function saveUnrecognisedIpAlarmState(
  state: AlarmIssuesState,
  path: string = DEFAULT_ALARM_ISSUES_STATE_PATH,
): void {
  writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
}

export interface ReportUnrecognisedIpOptions {
  cwd?: string;
  run?: GhRunFn;
  statePath?: string;
  closeAfterRuns?: number;
}

/**
 * Reconcilia `finding` contra o estado local (cria/reusa issue via
 * `alarm-issues.ts`) e persiste o próximo estado. Fail-soft (mesma
 * disciplina do resto deste módulo e de `brevo-rate-state.ts`): qualquer
 * erro (disco cheio, `data/` ausente numa sessão cloud, `gh` indisponível) é
 * engolido e logado — nunca deve propagar pra quem chamou (a chamada Brevo
 * real que originou a detecção já aconteceu e não deve ser afetada por uma
 * falha no rastreio do achado).
 */
export function reportUnrecognisedIpFinding(
  finding: AlarmFinding,
  opts: ReportUnrecognisedIpOptions = {},
): void {
  const cwd = opts.cwd ?? testOverrides.cwd ?? ROOT;
  const run = opts.run ?? testOverrides.run;
  const statePath = opts.statePath ?? testOverrides.statePath ?? DEFAULT_ALARM_ISSUES_STATE_PATH;
  const closeAfterRuns = opts.closeAfterRuns ?? CLOSE_ALARM_ISSUE_AFTER_RUNS;
  try {
    const state = loadUnrecognisedIpAlarmState(statePath);
    const { nextState, findingOutcomes } = applyAlarmReconciliation([finding], state, {
      cwd,
      closeAfterRuns,
      run,
    });
    saveUnrecognisedIpAlarmState(nextState, statePath);
    for (const outcome of findingOutcomes) {
      if (outcome.action === "failed") {
        console.error(
          `[brevo-unrecognised-ip-alarm] issue não criada/reusada (${outcome.fingerprint}): ${outcome.error}`,
        );
      } else {
        console.error(
          `[brevo-unrecognised-ip-alarm] issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`,
        );
      }
    }
  } catch (e) {
    console.error("[brevo-unrecognised-ip-alarm] reconciliação falhou (fail-soft):", e);
  }
}

/**
 * #6137 (auto-close) — chamada pra QUALQUER resposta da `conta` que NÃO seja
 * o 401 "unrecognised IP" (`brevo-client.ts` chama isto no ramo contrário do
 * `maybeReportUnrecognisedIp`). Sem periodicidade própria (este alarme não
 * roda via systemd timer, ao contrário dos outros 9 alarmes do projeto — a
 * detecção é embutida na chamada real), o mecanismo de streak de
 * `alarm-issues.ts` só reconcilia quando ALGUÉM chama `applyAlarmReconciliation`
 * de novo com o achado ausente de `pending` — sem este complemento, uma
 * issue criada por um bloqueio já corrigido nunca se fecharia sozinha
 * (nenhuma chamada volta a produzir um `AlarmFinding` pra essa conta depois
 * do IP autorizado). Esta função é esse "tick": toda resposta que NÃO é
 * 401-unrecognised-IP prova que a conta+IP atual passaram a allowlist —
 * reconcilia (`pending: []`) só as entries JÁ rastreadas desta `account`
 * (nunca toca entries de outra conta, mesmo que compartilhem o mesmo
 * `check`), avançando o streak/fechando quando aplicável.
 *
 * Fast path sem I/O: se não há entry aberta pra esta conta no estado local,
 * retorna sem tocar disco/gh — o caso comum (99%+ das chamadas, quando nunca
 * houve bloqueio ou ele já foi fechado). Fail-soft, mesma disciplina do
 * resto do módulo.
 */
export function maybeReconcileResolvedFindings(
  account: string,
  opts: ReportUnrecognisedIpOptions = {},
): void {
  const cwd = opts.cwd ?? testOverrides.cwd ?? ROOT;
  const run = opts.run ?? testOverrides.run;
  const statePath = opts.statePath ?? testOverrides.statePath ?? DEFAULT_ALARM_ISSUES_STATE_PATH;
  const closeAfterRuns = opts.closeAfterRuns ?? CLOSE_ALARM_ISSUE_AFTER_RUNS;
  try {
    const state = loadUnrecognisedIpAlarmState(statePath);
    const prefix = `${CHECK}:${account}:`;
    const scopedEntries = Object.entries(state).filter(([key, entry]) => key.startsWith(prefix) && !entry.closedAt);
    if (scopedEntries.length === 0) return; // fast path — nada rastreado pra esta conta, sem I/O extra

    const scopedState: AlarmIssuesState = Object.fromEntries(scopedEntries);
    const { nextState: scopedNext } = applyAlarmReconciliation([], scopedState, { cwd, closeAfterRuns, run });
    saveUnrecognisedIpAlarmState({ ...state, ...scopedNext }, statePath);
  } catch (e) {
    console.error("[brevo-unrecognised-ip-alarm] reconciliação de sucesso falhou (fail-soft):", e);
  }
}

// ─── Glue chamado por brevo-client.ts (brevoRawFetch e brevoGet) ──────────

/** Dedup EM PROCESSO — ver docstring do módulo. Resetável só via
 * `__resetUnrecognisedIpAlarmTestOverrides` (teste). */
const reportedInProcess = new Set<string>();

/**
 * Chamada por `brevoRawFetch`/`brevoGet` em TODA resposta 401 (o caller
 * decide se o status é 401 antes de chamar — esta função não re-checa).
 * `res` deve ser um `res.clone()` — lê o body via `.text()`, o que consome o
 * stream; o caller precisa do body original intacto pra sua própria
 * mensagem de erro. Nunca lança — qualquer falha (parse, rede do ipify,
 * `gh`) é fail-soft, só loga.
 */
export async function maybeReportUnrecognisedIp(
  url: string,
  apiKey: string,
  res: Response,
): Promise<void> {
  try {
    if (res.status !== 401) return;
    const bodyText = await res.text();
    const ip = parseUnrecognisedIpBody(bodyText);
    if (!ip) return; // 401 de outra causa (key inválida/revogada) — fora de escopo

    const account = resolveBrevoAccountLabel(apiKey);
    const fingerprint = `${account}:${ip}`;
    if (reportedInProcess.has(fingerprint)) return;
    reportedInProcess.add(fingerprint);

    const hostIps = testOverrides.hostIps ?? (await resolveHostOutboundIps());
    const finding = buildUnrecognisedIpFinding({
      account,
      ip,
      endpoint: url,
      timestamp: new Date(),
      hostIPv4: hostIps.ipv4,
      hostIPv6: hostIps.ipv6,
    });
    reportUnrecognisedIpFinding(finding);
  } catch (e) {
    console.error(
      "[brevo-unrecognised-ip-alarm] detecção/relato falhou (fail-soft, chamada Brevo real não afetada):",
      e,
    );
  }
}

// ─── Seam de teste (NUNCA usado em produção) ───────────────────────────────

interface UnrecognisedIpAlarmTestOverrides {
  run?: GhRunFn;
  statePath?: string;
  cwd?: string;
  hostIps?: { ipv4: string | null; ipv6: string | null };
}

let testOverrides: UnrecognisedIpAlarmTestOverrides = {};

/** Só pra teste — injeta `GhRunFn`/statePath/cwd/IPs fixos pra que
 * `maybeReportUnrecognisedIp` (chamado internamente por `brevoRawFetch`/
 * `brevoGet`, sem thread de opções) nunca bata em `gh`/rede reais durante
 * `npm test`. */
export function __setUnrecognisedIpAlarmTestOverrides(overrides: UnrecognisedIpAlarmTestOverrides): void {
  testOverrides = overrides;
}

/** Limpa os overrides de teste E o dedup em-processo (senão um teste
 * seguinte que reuse o mesmo fingerprint veria a chamada pulada por engano). */
export function __resetUnrecognisedIpAlarmTestOverrides(): void {
  testOverrides = {};
  reportedInProcess.clear();
}
