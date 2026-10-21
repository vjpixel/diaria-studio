#!/usr/bin/env node
/**
 * scripts/robots-txt-drift-check.ts (#4910 item 3)
 *
 * Smoke-test agendado: pra cada Worker de curadoria com host público
 * (descoberto via `discoverWorkerPublicHosts`, sem lista hardcoded — mesma
 * fonte de `test/worker-robots-txt-guard-4777.test.ts`), bate
 * `GET https://{host}/robots.txt` e verifica se o arquivo SERVIDO ainda
 * carrega o bloco gerenciado da Cloudflare e/ou bloqueia algum bot fora do
 * esperado. Se algum host tiver drift, alarma o editor por e-mail —
 * nomeando o(s) host(s) e o(s) motivo(s) exato(s).
 *
 * Molde: `scripts/hub-drift-check.ts` (#4750) — decisão pura testável em
 * `scripts/lib/robots-txt-drift-check.ts`, CLI fino aqui fazendo só I/O
 * (fetch + estado + e-mail), fail-soft por host (`Promise.all` sobre
 * `checkRobotsTxt`, que nunca lança), alarme por e-mail só em drift NOVO
 * (idempotência por fingerprint).
 *
 * **Por que `diar.ia.br` (Beehiiv) nunca entra na lista de hosts**:
 * `discoverWorkerPublicHosts` varre `workers/*​/wrangler.toml` — Beehiiv não
 * é um Worker deste repo, então não aparece nunca, sem precisar de
 * exclusão explícita. O `robots.txt` dele é outro fabricante inteiro (abre
 * com `# beehiiv default robots.txt`) e não tem o bloco gerenciado da
 * Cloudflare — fora de escopo deste smoke-test por natureza, não por filtro.
 *
 * **UA realista** (`DiariaBot/1.0 (+https://diar.ia.br)`, mesmo UA já usado
 * por `hub-drift-check.ts`/`seo-index-check.ts`): um `curl` com UA cru
 * (vazio/genérico) contra hosts próprios (`arquivo.diar.ia.br` etc.) já
 * responde 200 hoje, mas usar um UA identificável evita depender disso
 * continuar valendo se a Cloudflare endurecer challenge por UA no futuro.
 *
 * **Crawler de IA barrado na borda (#10508)**: o texto do `robots.txt`
 * pode estar certo e a zona ainda devolver 403 ao bot (regra gerenciada
 * "Block AI bots" isenta o próprio `/robots.txt`). Por isso o script também
 * (1) sonda `GET https://{host}/` com UA de GPTBot e ClaudeBot nos 6 hosts
 * de `AI_CRAWLER_PROBE_HOSTS` (apex incluído) e (2) soma os 403 reais de
 * `verifiedBotCategory = "AI Crawler"` das últimas 24h via GraphQL
 * (`CLOUDFLARE_API_TOKEN`; zona por `CLOUDFLARE_ZONE_ID` ou o id fixo de
 * `lib/apex-cutover.ts`), fora Amazonbot. Os dois sinais são fail-soft —
 * lógica em `scripts/lib/ai-crawler-access-check.ts`.
 *
 * Uso:
 *   npx tsx scripts/robots-txt-drift-check.ts               # avalia + persiste + alarma se NOVO drift
 *   npx tsx scripts/robots-txt-drift-check.ts --dry-run      # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/robots-txt-drift-check.ts --to email@x   # override do destinatário do alarme
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário
 * quando há drift pra de fato enviar o e-mail; a checagem HTTP em si é um
 * GET público sem credencial nenhuma. Não precisa do junction `data/` pra
 * descobrir hosts (lê `workers/*​/wrangler.toml`, local ao checkout) — só
 * pra persistir o estado de idempotência
 * (`data/robots-txt-drift-check/state.json`).
 *
 * Como os outros alarmes locais deste repo, o registro da task no Task
 * Scheduler/systemd e a 1ª execução ao vivo nunca rodaram nesta unidade
 * (worktree isolado, sem `data/.credentials.json` real nem chamada de rede
 * contra hosts de produção) — validado só via testes com a lógica pura +
 * fetch mockado (sem rede real), mesma disciplina do #4750/#4723/etc.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { notifyEditorForOutcomes } from "./lib/editor-notify.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { discoverWorkerPublicHosts } from "./lib/worker-public-hosts.ts";
import {
  evaluateAllRobotsDrift,
  hasPendingRobotsDrift,
  computeRobotsDriftFingerprint,
  advanceRobotsDriftState,
  emptyRobotsDriftAlarmState,
  buildRobotsDriftAlarmEmail,
  robotsDriftFindingKey,
  type RobotsCheckInput,
  type RobotsDriftResult,
  type RobotsDriftAlarmState,
} from "./lib/robots-txt-drift-check.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  listFrozenUnmeasuredKeys,
  emptyAlarmIssuesState,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  saveState,
  type AlarmFinding,
  type AlarmFindingOutcome,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";
import {
  probeAllAiCrawlerAccess,
  fetchAiCrawler403Rows,
  summarizeAiCrawler403,
  blockedProbesByHost,
  hasPendingAiCrawlerFindings,
  aiCrawlerProbeFindingKey,
  aiCrawler403ContentSignature,
  buildAiCrawlerProbeIssueBody,
  buildAiCrawler403IssueBody,
  buildAiCrawlerAlarmEmailLines,
  AI_CRAWLER_403_ZONE_FINGERPRINT,
  type AiCrawlerProbeResult,
  type AiCrawler403Summary,
} from "./lib/ai-crawler-access-check.ts";
import { ZONE_ID as DIARIA_ZONE_ID } from "./lib/apex-cutover.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "robots-txt-drift-check", "state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "robots-txt-drift-check", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const WORKERS_DIR = resolve(ROOT, "workers");
const LOG_PREFIX = "[robots-txt-drift-check]";
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "DiariaBot/1.0 (+https://diar.ia.br)";
/** #5339: task roda diária (10:15) — 2 execuções limpas consecutivas = 48h
 * sem o achado antes de fechar a issue automaticamente, mesmo valor de
 * `hub-drift-check.ts`/`home-meta-check.ts` pra cadência diária. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Estado (idempotência) — mesmo padrão I/O de hub-drift-check.ts ───────

export function loadState(statePath: string = STATE_PATH): RobotsDriftAlarmState {
  if (!existsSync(statePath)) return emptyRobotsDriftAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<RobotsDriftAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fingerprint ?? null, lastCheckedAt: checkedAt ?? null };
  } catch {
    return emptyRobotsDriftAlarmState();
  }
}

// saveState/loadAlarmIssuesState/saveAlarmIssuesState: consolidados em
// scripts/lib/alarm-issues.ts (#7124) — importados acima. Arquivo separado
// de STATE_PATH de propósito: idempotência do E-MAIL (acima) e tracking de
// ISSUE por achado são preocupações independentes.
export { saveState };

/** Converte um `RobotsDriftResult` com drift pendente ("drift"/"error") no
 * `AlarmFinding` genérico que `scripts/lib/alarm-issues.ts` consome (#5339).
 * `check` = host (cada host é seu próprio eixo). `fingerprint` usa
 * `robotsDriftFindingKey`, a MESMA fórmula usada por
 * `computeRobotsDriftFingerprint` e repassada a `buildRobotsDriftAlarmEmail`.
 * Todo achado nasce `P2` — mesmo racional de risco/gravidade dos outros
 * alarmes de drift deste lote (correção manual, sem impacto de produção
 * imediato). */
export function toAlarmFinding(r: RobotsDriftResult): AlarmFinding {
  return {
    check: r.host,
    fingerprint: robotsDriftFindingKey(r),
    // #5553 — condição RE-CHECÁVEL (robots.txt servido); resolve sozinho
    // quando o arquivo voltar a bater com o esperado.
    family: "estado",
    title: `[diar.ia.br] drift no robots.txt de ${r.host}`,
    body: [
      "Achado automático do alarme `Diaria-Robots-Txt-Drift-Check`",
      "(`scripts/robots-txt-drift-check.ts`).",
      "",
      `Host: \`${r.host}\``,
      `Detalhe: ${r.message}`,
      `URL: ${r.url}`,
      "",
      "Contexto (#4910): todo Worker num domínio proxiado pela Cloudflare",
      "nasce servindo um robots.txt gerenciado DEFAULT que é ANEXADO ao",
      "bloco próprio do Worker — se a plataforma mudar esse bloco, é preciso",
      "conferir a config de robots.txt gerenciado na zona Cloudflare.",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5339) e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

/** #10508 — achados de crawler de IA barrado na borda, no mesmo formato
 * `AlarmFinding`. Um por host bloqueado na sonda por UA + um agregado da
 * zona para os 403 reais do dia (fingerprint FIXO; a mudança do conjunto
 * host × bot vai como `contentSignature`, então vira comentário na issue
 * aberta em vez de issue nova a cada dia). */
export function toAiCrawlerAlarmFindings(
  probes: readonly AiCrawlerProbeResult[],
  summary: AiCrawler403Summary | null,
): AlarmFinding[] {
  const findings: AlarmFinding[] = blockedProbesByHost(probes).map(({ host, bots }) => ({
    check: `ai-crawler-probe:${host}`,
    fingerprint: aiCrawlerProbeFindingKey(host, bots),
    family: "estado",
    title: `[diar.ia.br] Cloudflare barra ${bots.join("/")} com 403 em ${host}`,
    body: buildAiCrawlerProbeIssueBody(host, bots),
    labels: ["bug"],
    priority: "P2",
  }));
  if (summary !== null && summary.total > 0) {
    findings.push({
      check: "ai-crawler-403-zona",
      fingerprint: AI_CRAWLER_403_ZONE_FINGERPRINT,
      family: "estado",
      title: "[diar.ia.br] zona Cloudflare devolve 403 a crawlers de IA verificados",
      body: buildAiCrawler403IssueBody(summary),
      labels: ["bug"],
      priority: "P2",
      contentSignature: aiCrawler403ContentSignature(summary),
    });
  }
  return findings;
}

/** #10520 — chaves `ai-crawler-*` cujo sinal NÃO foi medido nesta execução:
 * a zona inteira quando a GraphQL não voltou `ok` (erro/token ausente), e a
 * chave de sonda cujo conjunto de bots guardado inclui algum bot que saiu
 * `inconclusive` NAQUELE host (#10522: granularidade host × bot — antes era
 * o host inteiro, e um bot inconclusivo alheio à issue congelava uma issue
 * cujo bot foi medido `allowed`). Ausência de achado nessas chaves não prova
 * resolução — `planAlarmReconciliation` preserva a issue aberta em vez de
 * comentar/fechar por streak. Chave de sonda que não dá pra parsear cai no
 * critério antigo (host inteiro): na dúvida, congela em vez de fechar. */
export function aiCrawlerUnmeasuredKeys(
  probes: readonly AiCrawlerProbeResult[],
  fetched403Status: "ok" | "skipped" | "error",
): (key: string) => boolean {
  const unmeasured = new Map<string, Set<string>>();
  for (const p of probes) {
    if (p.status !== "inconclusive") continue;
    if (!unmeasured.has(p.host)) unmeasured.set(p.host, new Set());
    unmeasured.get(p.host)!.add(p.bot);
  }
  return (key) => {
    if (fetched403Status !== "ok" && key.startsWith("ai-crawler-403-zona:")) return true;
    for (const [host, bots] of unmeasured) {
      const prefix = `ai-crawler-probe:${host}:`;
      if (!key.startsWith(prefix)) continue;
      const keyBots = parseAiCrawlerProbeKeyBots(key.slice(prefix.length), host);
      if (keyBots === null) return true;
      return keyBots.some((b) => bots.has(b));
    }
    return false;
  };
}

/** Lê o conjunto de bots do fingerprint `ai-crawler-probe|{host}|{bots}|403`
 * (`aiCrawlerProbeFindingKey`). `null` quando o formato não bate. */
export function parseAiCrawlerProbeKeyBots(fingerprint: string, host: string): string[] | null {
  const parts = fingerprint.split("|");
  if (parts.length !== 4 || parts[0] !== "ai-crawler-probe" || parts[1] !== host || parts[3] !== "403") return null;
  const bots = parts[2].split(",").filter((b) => b.length > 0);
  return bots.length > 0 ? bots : null;
}

/** #10522 — evita a issue DUPLICADA quando parte dos bots de uma issue aberta
 * sai `inconclusive`. Sem isto: issue aberta para {ClaudeBot, GPTBot}, rodada
 * com GPTBot `blocked` e ClaudeBot `inconclusive` → fingerprint novo {GPTBot}
 * abre 2ª issue enquanto a antiga fica congelada. Aqui, um par (host, bot)
 * `inconclusive` que pertence a uma issue de sonda ABERTA herda o último
 * estado medido (`blocked`) — o fingerprint fica igual ao da issue aberta.
 * O carry-forward só vale quando o conjunto resultante do host é EXATAMENTE o
 * de uma issue aberta: com {ClaudeBot, GPTBot} aberta, GPTBot medido
 * `allowed` e ClaudeBot `inconclusive`, herdar daria {ClaudeBot} — outra
 * issue nova, sem medição. Nesse caso o host fica só com o medido e a issue
 * antiga segue congelada por `aiCrawlerUnmeasuredKeys`.
 * #10596: exige ao menos uma sonda medida no próprio host nesta rodada.
 * Sem nenhuma medição, não herda: a issue fica congelada e aparece no log
 * de sinais não medidos, sem zerar seu missingStreak.
 * Só serve para montar os achados; log e e-mail continuam com a sonda real. */
export function carryForwardInconclusiveProbes(
  probes: readonly AiCrawlerProbeResult[],
  state: AlarmIssuesState,
): AiCrawlerProbeResult[] {
  const openSets = new Map<string, string[]>(); // host → conjuntos abertos, serializados
  const openBots = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(state)) {
    if (entry.closedAt) continue;
    const m = /^ai-crawler-probe:([^:]+):(.+)$/.exec(key);
    if (!m) continue;
    const bots = parseAiCrawlerProbeKeyBots(m[2], m[1]);
    if (!bots) continue;
    if (!openBots.has(m[1])) openBots.set(m[1], new Set());
    for (const b of bots) openBots.get(m[1])!.add(b);
    openSets.set(m[1], [...(openSets.get(m[1]) ?? []), [...bots].sort().join(",")]);
  }
  const carried = probes.map((p) =>
    p.status === "inconclusive" && openBots.get(p.host)?.has(p.bot) ? { ...p, status: "blocked" as const } : p,
  );
  const measuredHosts = new Set(probes.filter((p) => p.status !== "inconclusive").map((p) => p.host));
  const acceptedHosts = new Set(
    blockedProbesByHost(carried)
      .filter(({ host, bots }) => measuredHosts.has(host) && openSets.get(host)?.includes(bots.join(",")))
      .map(({ host }) => host),
  );
  return probes.map((p, i) => (acceptedHosts.has(p.host) ? carried[i] : p));
}

// ─── #10545 — sinal 2 cego (GraphQL não medido N rodadas seguidas) ─────────

const ZONE_403_MEASUREMENT_PATH = resolve(ROOT, "data", "robots-txt-drift-check", "zone-403-measurement.json");
/** Task diária: 3 rodadas seguidas sem medir = 3 dias cego. Abaixo disso é
 * soluço de API, e o #10520 já preserva a issue aberta sem fechar. */
export const ZONE_403_BLIND_AFTER_RUNS = 3;
export const AI_CRAWLER_403_BLIND_CHECK = "ai-crawler-403-zona-sem-medicao";

export interface Zone403MeasurementState {
  /** Rodadas seguidas em que a consulta GraphQL não voltou `ok`. */
  consecutiveUnmeasured: number;
  /** ISO da 1ª rodada da sequência atual sem medição (null se medida). */
  unmeasuredSince: string | null;
  lastStatus: "ok" | "skipped" | "error" | null;
  lastDetail: string | null;
}

export function emptyZone403MeasurementState(): Zone403MeasurementState {
  return { consecutiveUnmeasured: 0, unmeasuredSince: null, lastStatus: null, lastDetail: null };
}

export function loadZone403MeasurementState(path: string = ZONE_403_MEASUREMENT_PATH): Zone403MeasurementState {
  if (!existsSync(path)) return emptyZone403MeasurementState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Zone403MeasurementState>;
    const n = typeof raw.consecutiveUnmeasured === "number" && raw.consecutiveUnmeasured >= 0 ? raw.consecutiveUnmeasured : 0;
    return {
      consecutiveUnmeasured: n,
      unmeasuredSince: typeof raw.unmeasuredSince === "string" ? raw.unmeasuredSince : null,
      lastStatus: raw.lastStatus === "ok" || raw.lastStatus === "skipped" || raw.lastStatus === "error" ? raw.lastStatus : null,
      lastDetail: typeof raw.lastDetail === "string" ? raw.lastDetail : null,
    };
  } catch {
    return emptyZone403MeasurementState();
  }
}

/** Avança o contador: `ok` zera; `skipped`/`error` soma 1. */
export function advanceZone403MeasurementState(
  prev: Zone403MeasurementState,
  status: "ok" | "skipped" | "error",
  detail: string | null,
  now: Date,
): Zone403MeasurementState {
  if (status === "ok") return { consecutiveUnmeasured: 0, unmeasuredSince: null, lastStatus: "ok", lastDetail: null };
  return {
    consecutiveUnmeasured: prev.consecutiveUnmeasured + 1,
    unmeasuredSince: prev.consecutiveUnmeasured > 0 && prev.unmeasuredSince ? prev.unmeasuredSince : now.toISOString(),
    lastStatus: status,
    lastDetail: detail,
  };
}

/** Achado próprio para o sensor cego: sem isto, a issue `ai-crawler-403-zona`
 * aberta fica congelada pelo #10520 (nem comenta, nem fecha) e ninguém
 * percebe que a medição parou. Fingerprint fixo; o detalhe muda via
 * `contentSignature` (status), então troca de `skipped` → `error` comenta.
 * `estado`: fecha sozinho quando a consulta volta `ok` por
 * `CLOSE_ALARM_ISSUE_AFTER_RUNS` rodadas — e nessas rodadas o sinal FOI
 * medido, então a ausência é prova. */
export function toZone403BlindFinding(
  state: Zone403MeasurementState,
  threshold: number = ZONE_403_BLIND_AFTER_RUNS,
): AlarmFinding | null {
  if (state.consecutiveUnmeasured < threshold) return null;
  return {
    check: AI_CRAWLER_403_BLIND_CHECK,
    fingerprint: `${AI_CRAWLER_403_BLIND_CHECK}:graphql`,
    family: "estado",
    title: "[diar.ia.br] 403 de crawlers de IA na zona sem medição (sensor cego)",
    body: [
      "Achado automático do alarme `Diaria-Robots-Txt-Drift-Check`",
      "(`scripts/robots-txt-drift-check.ts`, #10545).",
      "",
      `A consulta GraphQL dos 403 de \`AI Crawler\` (sinal 2, #10508) não voltou \`ok\` em ${state.consecutiveUnmeasured} execuções seguidas` +
        (state.unmeasuredSince ? ` (desde ${state.unmeasuredSince}).` : "."),
      `Último status: \`${state.lastStatus ?? "?"}\` — ${state.lastDetail ?? "sem detalhe"}`,
      "",
      "Consequência: enquanto o sinal não é medido, uma issue `ai-crawler-403-zona` aberta fica",
      "congelada (#10520) — não recebe comentário nem fecha. Ela NÃO indica que os 403 persistem.",
      "",
      "Causas prováveis: `CLOUDFLARE_API_TOKEN` ausente (`skipped`) ou sem permissão de",
      "Analytics na zona (`error`/authz). Conferir o token no Doppler/`.env` do servidor.",
      "",
      "Fecha sozinha quando a consulta voltar a medir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas.`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
    contentSignature: state.lastStatus ?? "",
  };
}

/** E-mail combinado: seção do robots.txt (quando há drift) + seção dos
 * crawlers de IA (quando há bloqueio). Assunto reflete o que está pendente. */
export function buildCombinedAlarmEmail(
  results: readonly RobotsDriftResult[],
  probes: readonly AiCrawlerProbeResult[],
  summary: AiCrawler403Summary | null,
  now: Date,
  issueRefs?: ReadonlyMap<string, { issueNumber: number | null; url: string | null; action: string; error?: string }>,
): { subject: string; body: string } {
  const aiLines = buildAiCrawlerAlarmEmailLines(probes, summary);
  if (!hasPendingRobotsDrift(results)) {
    return {
      subject: "[diar.ia.br] Cloudflare barra crawlers de IA na borda",
      body: [...aiLines, "", `(alarme automático — checagem rodou em ${now.toISOString()})`].join("\n"),
    };
  }
  const robots = buildRobotsDriftAlarmEmail(results, now, issueRefs);
  if (aiLines.length === 0) return robots;
  return {
    subject: `${robots.subject} + crawlers de IA barrados`,
    body: `${robots.body}\n\n${aiLines.join("\n")}`,
  };
}

// ─── Checagem HTTP por host (I/O, fail-soft) ───────────────────────────────

/**
 * Bate `GET {url}/robots.txt` e resolve pra `{httpStatus, robotsTxt,
 * fetchError}` — NUNCA lança: uma falha de rede (timeout, DNS, conexão
 * recusada) vira `fetchError` preenchido em vez de propagar, pra não
 * derrubar a checagem dos outros hosts (mesmo contrato de `checkHub` em
 * `hub-drift-check.ts`).
 */
export async function checkRobotsTxt(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ httpStatus: number | null; robotsTxt: string | null; fetchError: string | null; finalUrl: string | null }> {
  try {
    // `redirect: "manual"` (#8899 achado ao vivo): o default do fetch nativo
    // é `"follow"`, que SEGUE o 301 dos hosts legados (anual/artigo →
    // retrospectiva) até o destino final antes de expor `res.status` — a
    // checagem nunca via o 301 em si, só o status final da raiz do host
    // canônico (400, por `classifyRetrospectivaPath` rejeitar `/`). O
    // tratamento especial de `httpStatus === 301` em
    // `lib/robots-txt-drift-check.ts` (#7793/#7658) é código morto sem isto —
    // `res.status` do fetch em modo `follow` nunca é 301 para um redirect
    // bem-sucedido. Em modo `manual`, `res.url` permanece a URL requisitada
    // (não a de destino) — por isso `finalUrl` é lido do header `Location`.
    const res = await fetchFn(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get("location");
    const finalUrl = isRedirect && location ? new URL(location, url).toString() : typeof res.url === "string" && res.url ? res.url : null;
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { httpStatus: res.status, robotsTxt: null, fetchError: null, finalUrl };
    }
    const body = await res.text();
    return { httpStatus: res.status, robotsTxt: body, fetchError: null, finalUrl };
  } catch (e) {
    return { httpStatus: null, robotsTxt: null, fetchError: (e as Error).message, finalUrl: null };
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getStringArg(argv, "to");

  const discovered = discoverWorkerPublicHosts(WORKERS_DIR);
  if (discovered.length === 0) {
    // #10508: não retorna mais aqui — a sonda de crawler de IA usa lista
    // própria de hosts e roda mesmo sem Worker descoberto.
    console.log(`${LOG_PREFIX} nenhum host público descoberto sob workers/ — robots.txt não checado.`);
  }

  // Um mesmo host pode aparecer mais de uma vez (não acontece hoje — 1
  // wrangler.toml por Worker — mas dedup defensivo evita checar 2x/alarmar
  // 2x se algum wrangler.toml futuro declarar mais de uma rota pro mesmo
  // host).
  const hosts = [...new Set(discovered.map((d) => d.host))];

  console.log(`${LOG_PREFIX} ${hosts.length} host(s) público(s) descoberto(s): ${hosts.join(", ")}`);

  const inputs: RobotsCheckInput[] = await Promise.all(
    hosts.map(async (host) => {
      const url = `https://${host}/robots.txt`;
      const { httpStatus, robotsTxt, fetchError, finalUrl } = await checkRobotsTxt(url);
      return { host, url, robotsTxt, httpStatus, fetchError, finalUrl };
    }),
  );

  const results: RobotsDriftResult[] = evaluateAllRobotsDrift(inputs);

  for (const r of results) {
    console.log(`${LOG_PREFIX} ${r.host}: ${r.status} — ${r.message}`);
  }

  // #10508 — sinal 1: a borda deixa GPTBot/ClaudeBot entrar? (fail-soft por par)
  const probes = await probeAllAiCrawlerAccess();
  for (const p of probes) {
    const detail = p.fetchError ? `erro: ${p.fetchError}` : `HTTP ${p.httpStatus}`;
    console.log(`${LOG_PREFIX} sonda ${p.bot} → ${p.host}: ${p.status} (${detail})`);
  }

  // #10508 — sinal 2: 403 reais de "AI Crawler" nas últimas 24h (GraphQL).
  // Token ausente/erro de API = log, nunca alarme nem exceção.
  const zoneId = process.env.CLOUDFLARE_ZONE_ID || DIARIA_ZONE_ID;
  const fetched403 = await fetchAiCrawler403Rows(zoneId, process.env.CLOUDFLARE_API_TOKEN);
  let summary403: AiCrawler403Summary | null = null;
  if (fetched403.status === "ok") {
    summary403 = summarizeAiCrawler403(fetched403.rows);
    console.log(
      `${LOG_PREFIX} 403 de AI Crawler (${fetched403.since} → ${fetched403.until}): ` +
        `${summary403.total}${summary403.truncated ? "+" : ""} fora Amazonbot ` +
        `(Amazonbot, bloqueado de propósito: ${summary403.intentionallyBlocked}).`,
    );
  } else {
    console.warn(`${LOG_PREFIX} 403 de AI Crawler não consultado (${fetched403.status}): ${fetched403.detail}`);
  }

  const state = loadState();
  const robotsPending = hasPendingRobotsDrift(results);
  const pending = robotsPending || hasPendingAiCrawlerFindings(probes, summary403);
  console.log(
    `${LOG_PREFIX} ${pending ? "drift pendente" : "nenhum drift pendente"} ` +
      `(última checagem: ${state.lastCheckedAt ?? "nunca"}).`,
  );

  // #5339 — reconcilia issue por host com drift ANTES de montar o e-mail (o
  // e-mail cita a issue de cada achado pendente), mesmo padrão de
  // hub-drift-check.ts/home-meta-check.ts. Roda toda execução
  // não-dry-run, independente de um e-mail novo disparar nesta rodada.
  const driftedResults = results.filter((r) => r.status === "drift" || r.status === "error");
  // #10545: sinal 2 não medido N rodadas seguidas vira achado próprio.
  const zone403Measurement = advanceZone403MeasurementState(
    loadZone403MeasurementState(),
    fetched403.status,
    fetched403.status === "ok" ? null : fetched403.detail,
    new Date(),
  );
  const blindFinding = toZone403BlindFinding(zone403Measurement);
  if (blindFinding) {
    console.error(
      `${LOG_PREFIX} sinal 2 (403 da zona) sem medição há ${zone403Measurement.consecutiveUnmeasured} execução(ões) seguidas — alarme de sensor cego.`,
    );
  }
  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);
  // #10522: bot inconclusivo de uma issue de sonda aberta herda o último
  // estado medido, senão o conjunto de bots muda e nasce issue duplicada.
  const findingProbes = carryForwardInconclusiveProbes(probes, alarmState);
  const alarmFindings = [
    ...driftedResults.map(toAlarmFinding),
    ...toAiCrawlerAlarmFindings(findingProbes, summary403),
    ...(blindFinding ? [blindFinding] : []),
  ];
  const isAbsenceUnmeasured = aiCrawlerUnmeasuredKeys(probes, fetched403.status);
  // #10522: o congelamento é silencioso e pode durar indefinidamente —
  // registrar no log cada issue mantida aberta sem medição nesta rodada.
  for (const { key, issueNumber } of listFrozenUnmeasuredKeys(alarmFindings, alarmState, isAbsenceUnmeasured)) {
    console.warn(`${LOG_PREFIX} issue #${issueNumber} mantida aberta: sinal não medido nesta execução (${key}).`);
  }
  let issueRefs: Map<string, { issueNumber: number | null; url: string | null; action: string; error?: string }> | undefined;
  let allFindingOutcomes: AlarmFindingOutcome[] = [];

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS, [], isAbsenceUnmeasured);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
  } else {
    const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
      isAbsenceUnmeasured,
    });
    saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
    saveState(zone403Measurement, ZONE_403_MEASUREMENT_PATH); // #10545
    allFindingOutcomes = findingOutcomes;
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

  if (isDryRun) {
    if (pending) {
      const { subject, body } = buildCombinedAlarmEmail(results, probes, summary403, new Date(), issueRefs);
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH)}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      console.log(`${LOG_PREFIX} nenhum e-mail necessário (sem drift pendente).`);
    }
  } else if (pending) {
    // #7960: `shouldAlarmRobotsDrift(state, results)` gateava por
    // `computeRobotsDriftFingerprint(results) !== state.lastAlarmedFingerprint`
    // (fingerprint AGREGADO) — `"dedupe-new-occurrences-only"` sobre TODOS os
    // outcomes reproduz a idempotência: só reenvia quando ao menos 1 host é
    // genuinamente NOVO (issue `created`/`reopened`).
    const result = await notifyEditorForOutcomes(
      allFindingOutcomes,
      "acao",
      () => buildCombinedAlarmEmail(results, probes, summary403, new Date(), issueRefs),
      { cwd: ROOT, platformConfigPath: PLATFORM_CONFIG_PATH, emailTo: toOverride, legacyResendIntent: "dedupe-new-occurrences-only" },
    );
    if (result.qualifying.length === 0) {
      console.log(`${LOG_PREFIX} política '${result.emailPolicy}': nenhum e-mail necessário (drift já alarmado antes).`);
    } else if (result.emailSent) {
      console.log(`${LOG_PREFIX} e-mail de alarme enviado.`);
    } else {
      console.error(`${LOG_PREFIX} falha ao enviar e-mail: ${result.emailError}`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (sem drift pendente).`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: cursor NÃO avançado.`);
    return;
  }

  // #10508: o fingerprint do estado agrega robots.txt + crawler de IA.
  const aiKeys = toAiCrawlerAlarmFindings(findingProbes, summary403).map((f) => f.fingerprint);
  const nextFingerprint = pending ? [computeRobotsDriftFingerprint(results), ...aiKeys].join("||") : null;
  saveState(advanceRobotsDriftState(nextFingerprint, new Date()), STATE_PATH);
}

if (isMainModule(import.meta.url)) {
  // process.exitCode em vez de process.exit() — este catch roda DEPOIS de
  // awaits de rede (checkRobotsTxt/sendGmailMessage), mesmo cenário
  // UV_HANDLE_CLOSING documentado em worker-drift-check.ts/hub-drift-check.ts.
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
