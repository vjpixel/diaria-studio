/**
 * scripts/lib/robots-txt-drift-check.ts (#4910 item 3)
 *
 * Lógica PURA (sem I/O) do smoke-test agendado que audita o `robots.txt`
 * SERVIDO por cada host de curadoria — não o que `renderCuradoriaRobotsTxt`
 * produz (isso já é coberto test-time por `test/curadoria-sitemap-robots.test.ts`
 * e afins), mas o arquivo que de fato chega no crawler depois de passar
 * pela injeção da plataforma. Mesmo molde de `scripts/lib/hub-drift-check.ts`
 * (#4750): uma função de decisão testável que recebe o resultado do fetch já
 * resolvido (nunca faz a chamada de rede em si), mais fingerprint + estado
 * de idempotência pro alarme por e-mail. O script `scripts/robots-txt-drift-check.ts`
 * é quem faz o I/O (descobre hosts via `discoverWorkerPublicHosts`, bate o
 * GET) e usa este módulo pra decidir SE/O-QUE alarmar.
 *
 * ─── Contexto (#4910) ───────────────────────────────────────────────────
 *
 * `scripts/lib/shared/robots-txt.ts` produz um `robots.txt` PRÓPRIO por
 * Worker de curadoria, mas todo Worker num domínio proxiado pela Cloudflare
 * nasce com um robots.txt gerenciado DEFAULT que a plataforma ANEXA antes
 * do bloco do Worker — nunca substituído por servir um arquivo próprio.
 * Como um grupo `User-agent:` nomeado vence o curinga `*` por especificidade
 * (RFC 9309), os 7 crawlers de assistente/treino que o #4546 quis liberar
 * (GPTBot, ClaudeBot, CCBot, Google-Extended, Bytespider, meta-externalagent,
 * Applebot-Extended) continuam bloqueados pelo bloco da Cloudflare
 * independente do que o Worker declara — confirmado ao vivo em 10/08/2026
 * nos 6 Workers de host público: 11 `Disallow: /` no total, 9 do bloco
 * gerenciado (primeiro, delimitado por `# BEGIN Cloudflare Managed
 * content`) + 2 do bloco do Worker (`CURADORIA_BLOCKED_BOTS` — Amazonbot,
 * CloudflareBrowserRenderingCrawler, os únicos que o #4546 quis manter
 * bloqueados). Nenhum guard existente olha o que está SERVIDO — todos são
 * test-time contra `renderCuradoriaRobotsTxt`. Este módulo fecha esse gap.
 *
 * ─── O que conta como drift ─────────────────────────────────────────────
 *
 * 1. `hasCloudflareManagedBlock` — o delimitador `# BEGIN Cloudflare
 *    Managed content` aparece no arquivo servido. Não é, por si só, prova
 *    de bot bloqueado (o bloco pode existir sem bloquear nada, em teoria),
 *    mas é o sinal mais direto e barato de "a injeção da plataforma ainda
 *    está lá" — o motivo de existir #4910 desde o início.
 * 2. Um bot NOMEADO fora de `CURADORIA_BLOCKED_BOTS` tem um grupo
 *    `User-agent:` próprio com `Disallow: /` geral (não um path específico,
 *    ex: `/vote`) — decisão explícita do #4546 sendo revertida por injeção
 *    de plataforma sem ninguém escolher.
 * 3. Um bot de RECUPERAÇÃO/citação (OAI-SearchBot, Claude-SearchBot,
 *    PerplexityBot, Googlebot, Bingbot) tem um grupo nomeado bloqueante —
 *    isto SIM destravaria o objetivo de citação do #4546/#4558, então é o
 *    caso mais grave (hoje nenhum dos dois blocos bloqueia esses bots, ver
 *    docstring de `robots-txt.ts`, mas a plataforma pode mudar sem aviso).
 * 4. `hasSitemapDeclared` ausente — nenhuma linha `Sitemap:` no arquivo
 *    SERVIDO (#5126/#5135). O CLAUDE.md registra a regra ("ao subir Worker
 *    novo, conferir o robots.txt e servir um próprio, com `Sitemap:`
 *    declarado") mas nada garantia isso além de revisão manual — `eia.` e
 *    `especial.` ficaram sem declarar por meses sem nenhum guard acusar.
 *    Blanket em TODOS os hosts descobertos: a partir de #5126/#5135 os 6
 *    hosts de curadoria (`arquivo`, `cursos`, `livros`, `artigo-mensal`,
 *    `poll`/eia, `artigos`/especial) declaram `Sitemap:` — não há mais
 *    exceção legítima "host sem sitemap próprio" no conjunto atual.
 *
 * ─── Por que "broken"/"error" segue o mesmo shape de hub-drift-check ───
 *
 * Cada host é um GET independente — um erro de rede/timeout NUM host
 * específico já é, por si só, informação equivalente a "não consegui
 * confirmar que este host está limpo", tratado como pendência igual a
 * drift de conteúdo (mesmo racional do #4750).
 *
 * ─── Idempotência: RE-ARMA quando o drift muda de shape ou desaparece ──
 *
 * Mesmo padrão de `hub-drift-check.ts`/`apoios-diff-alarm.ts`/
 * `worker-drift-check.ts`: o fingerprint inclui host + status + motivo(s)
 * de cada host problemático — o MESMO drift persistindo não re-alarma; um
 * host adicional ou um motivo novo muda o fingerprint e alarma de novo; o
 * drift sendo resolvido re-arma o cursor (`null`).
 */

import { CURADORIA_BLOCKED_BOTS } from "./shared/robots-txt.ts";

/** Bots que governam recuperação/citação por assistente — se QUALQUER um
 * destes ganhar um grupo nomeado bloqueante, o objetivo de citação do
 * #4546/#4558 está comprometido (ver docstring do módulo, caso 3). */
export const RECOVERY_BOTS = [
  "OAI-SearchBot",
  "Claude-SearchBot",
  "PerplexityBot",
  "Googlebot",
  "Bingbot",
] as const;

const CLOUDFLARE_MANAGED_MARKER = "# BEGIN Cloudflare Managed content";

// ─── Parsing mínimo de robots.txt (pura) ───────────────────────────────────

interface RobotsBlock {
  /** Nomes de User-agent que compartilham as diretivas abaixo (spec:
   * linhas `User-agent:` consecutivas, sem diretiva entre elas, formam UM
   * grupo). Preserva o valor cru (case original) — comparação é
   * case-insensitive nos callers. */
  agents: string[];
  /** Linhas de diretiva (`Disallow: ...`, `Allow: ...`, etc.) — cru, sem
   * parse além de trim + remoção de comentário inline. */
  directives: string[];
}

/**
 * Pura — parseia um `robots.txt` em blocos `{agents, directives}`, seguindo
 * a regra do RFC 9309 de que `User-agent:` consecutivas (sem diretiva entre
 * elas) formam um único grupo compartilhando as diretivas que vêm depois.
 * Comentários (`#...`) são descartados; linhas em branco são só separador
 * visual (não fecham grupo — um grupo só "fecha" quando aparece uma nova
 * sequência de `User-agent:` depois de já ter recebido alguma diretiva).
 */
export function parseRobotsBlocks(text: string): RobotsBlock[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);

  const blocks: RobotsBlock[] = [];
  let current: RobotsBlock | null = null;

  for (const line of lines) {
    const m = line.match(/^User-agent:\s*(.+)$/i);
    if (m) {
      if (!current || current.directives.length > 0) {
        current = { agents: [], directives: [] };
        blocks.push(current);
      }
      current.agents.push(m[1].trim());
      continue;
    }
    if (current) current.directives.push(line);
  }

  return blocks;
}

/** Pura — `true` se algum grupo NOMEADO (agent !== "*") cujo nome bate
 * `bot` (case-insensitive) tem uma diretiva `Disallow: /` GERAL (path
 * exatamente "/", não um sub-path como "/vote" — mesma distinção que
 * `robotsTxtAllowsGeneralCrawling` já faz em `robots-txt.ts`). Um bot sem
 * grupo nomeado nenhum cai no curinga `*` — não conta como "bloqueado por
 * grupo nomeado" pra fins deste módulo (o curinga pode ou não bloquear
 * geral; isso é responsabilidade de outro guard, não deste). */
export function isBotBlockedByNamedGroup(blocks: readonly RobotsBlock[], bot: string): boolean {
  const target = bot.toLowerCase();
  const matching = blocks.filter(
    (b) => b.agents.some((a) => a.toLowerCase() === target) && !b.agents.some((a) => a === "*"),
  );
  return matching.some((b) => b.directives.some((d) => /^Disallow:\s*\/\s*$/i.test(d)));
}

export interface RobotsTxtAnalysis {
  hasCloudflareManagedBlock: boolean;
  /** Bots nomeados fora de `CURADORIA_BLOCKED_BOTS` com Disallow: / geral. */
  unexpectedBlockedBots: string[];
  /** Subconjunto de `RECOVERY_BOTS` com Disallow: / geral — o caso mais
   * grave (ver docstring do módulo). */
  blockedRecoveryBots: string[];
  /** `true` se o arquivo tem pelo menos uma linha `Sitemap: <url>` (#5126/
   * #5135, ver caso 4 da docstring do módulo). */
  hasSitemapDeclared: boolean;
}

/**
 * Pura — analisa o TEXTO de um `robots.txt` já obtido (nenhuma chamada de
 * rede aqui) e devolve os 3 sinais que compõem drift (ver docstring do
 * módulo). Case do nome do bot é preservado exatamente como apareceu no
 * arquivo (útil pro texto do e-mail de alarme).
 */
export function analyzeRobotsTxt(robotsTxt: string): RobotsTxtAnalysis {
  const hasCloudflareManagedBlock = robotsTxt.includes(CLOUDFLARE_MANAGED_MARKER);
  const blocks = parseRobotsBlocks(robotsTxt);

  const allowlist = new Set(CURADORIA_BLOCKED_BOTS.map((b) => b.toLowerCase()));
  const namedAgents = new Map<string, string>(); // lowercase -> case original (1ª ocorrência)
  for (const b of blocks) {
    for (const a of b.agents) {
      if (a === "*") continue;
      const key = a.toLowerCase();
      if (!namedAgents.has(key)) namedAgents.set(key, a);
    }
  }

  const unexpectedBlockedBots = [...namedAgents.entries()]
    .filter(([key]) => !allowlist.has(key))
    .filter(([, original]) => isBotBlockedByNamedGroup(blocks, original))
    .map(([, original]) => original);

  const blockedRecoveryBots = RECOVERY_BOTS.filter((bot) => isBotBlockedByNamedGroup(blocks, bot));

  // #5126/#5135: `Sitemap:` é uma diretiva de nível de ARQUIVO (não presa a
  // um grupo `User-agent:` — spec RFC 9309 §2.3), então checa a linha crua,
  // não os blocos parseados acima. Case-insensitive no nome da diretiva
  // (mesma tolerância que o resto deste parser já aplica a `User-agent:`).
  const hasSitemapDeclared = /^Sitemap:\s*\S+/im.test(robotsTxt);

  return { hasCloudflareManagedBlock, unexpectedBlockedBots, blockedRecoveryBots, hasSitemapDeclared };
}

// ─── Avaliação de drift por host (pura) ────────────────────────────────────

export type RobotsDriftStatus =
  /** GET 200 + análise sem nenhum dos 3 sinais de drift. */
  | "ok"
  /** GET 200, corpo obtido, mas com pelo menos 1 sinal de drift. */
  | "drift"
  /** Falha de rede OU resposta HTTP != 200 — não deu pra confirmar que o
   * host está limpo (tratado como pendência, mesmo racional de
   * hub-drift-check.ts pra "error"). */
  | "error";

export interface RobotsCheckInput {
  /** Host checado (ex: "arquivo.diar.ia.br") — SEM protocolo. */
  host: string;
  /** URL completa batida (`https://{host}/robots.txt`). */
  url: string;
  /** Corpo da resposta, ou `null` se a chamada falhou / não veio 200. */
  robotsTxt: string | null;
  httpStatus: number | null;
  fetchError: string | null;
}

export interface RobotsDriftResult {
  host: string;
  url: string;
  status: RobotsDriftStatus;
  httpStatus: number | null;
  fetchError: string | null;
  /** Motivos de drift (vazio se status !== "drift"). */
  reasons: string[];
  message: string;
}

/** Pura — decide o status de drift de UM host, a partir do resultado do
 * fetch já resolvido (nenhuma chamada de rede aqui). */
export function evaluateRobotsDrift(input: RobotsCheckInput): RobotsDriftResult {
  const { host, url, robotsTxt, httpStatus, fetchError } = input;

  if (fetchError) {
    return {
      host,
      url,
      status: "error",
      httpStatus: null,
      fetchError,
      reasons: [],
      message: `falha ao consultar ${url}: ${fetchError}`,
    };
  }

  if (httpStatus !== 200 || robotsTxt === null) {
    return {
      host,
      url,
      status: "error",
      httpStatus,
      fetchError: null,
      reasons: [],
      message: `${url} respondeu ${httpStatus ?? "?"} (esperava 200 com corpo)`,
    };
  }

  const { hasCloudflareManagedBlock, unexpectedBlockedBots, blockedRecoveryBots, hasSitemapDeclared } =
    analyzeRobotsTxt(robotsTxt);
  const reasons: string[] = [];
  if (hasCloudflareManagedBlock) {
    reasons.push(`robots.txt gerenciado da Cloudflare ainda presente (${CLOUDFLARE_MANAGED_MARKER})`);
  }
  if (unexpectedBlockedBots.length > 0) {
    reasons.push(`bot(s) fora da allowlist bloqueado(s) por grupo nomeado: ${unexpectedBlockedBots.join(", ")}`);
  }
  if (blockedRecoveryBots.length > 0) {
    reasons.push(`bot(s) DE RECUPERAÇÃO/citação bloqueado(s): ${blockedRecoveryBots.join(", ")}`);
  }
  if (!hasSitemapDeclared) {
    reasons.push("sem linha Sitemap: declarada (CLAUDE.md exige um sitemap próprio declarado por Worker de curadoria)");
  }

  if (reasons.length === 0) {
    return {
      host,
      url,
      status: "ok",
      httpStatus,
      fetchError: null,
      reasons: [],
      message: `${url}: robots.txt ok (sem bloco gerenciado, allowlist respeitada, bots de recuperação livres, Sitemap: declarada)`,
    };
  }

  return {
    host,
    url,
    status: "drift",
    httpStatus,
    fetchError: null,
    reasons,
    message: `${url}: ${reasons.join("; ")}`,
  };
}

/** Pura — mapeia `evaluateRobotsDrift` sobre uma lista de hosts. */
export function evaluateAllRobotsDrift(inputs: readonly RobotsCheckInput[]): RobotsDriftResult[] {
  return inputs.map(evaluateRobotsDrift);
}

// ─── Idempotência do alarme (fingerprint + estado) ─────────────────────────

/** Pura — "drift"/"error" contam como pendência que justifica e-mail. */
export function hasPendingRobotsDrift(results: readonly RobotsDriftResult[]): boolean {
  return results.some((r) => r.status === "drift" || r.status === "error");
}

/** Pura — fingerprint estável (determinístico, independente de ordem de
 * chegada) do conjunto de hosts com drift pendente. Inclui host + status +
 * detalhe (reasons ordenados, ou fetchError/httpStatus) — qualquer mudança
 * de shape re-alarma. */
export function computeRobotsDriftFingerprint(results: readonly RobotsDriftResult[]): string {
  const pending = results.filter((r) => r.status === "drift" || r.status === "error");
  const keys = pending.map((r) => robotsDriftFindingKey(r)).sort();
  return keys.join("|");
}

/** Pura — fingerprint estável de UM host (#5339: chave usada tanto pelo
 * `AlarmFinding.fingerprint` quanto pelo `Map` de `issueRefs` repassado a
 * `buildRobotsDriftAlarmEmail` — mesmo padrão de `hubDriftFindingKey`/
 * `workerDriftFindingKey`). Fórmula idêntica à usada por-item dentro de
 * `computeRobotsDriftFingerprint`, extraída pra função nomeada em vez de
 * duplicar a string. */
export function robotsDriftFindingKey(
  r: Pick<RobotsDriftResult, "host" | "status" | "reasons" | "httpStatus" | "fetchError">,
): string {
  const detail = r.status === "drift" ? [...r.reasons].sort().join(",") : `${r.httpStatus ?? "-"}:${r.fetchError ?? "-"}`;
  return `${r.host}:${r.status}:${detail}`;
}

export interface RobotsDriftAlarmState {
  lastAlarmedFingerprint: string | null;
  lastCheckedAt: string | null;
}

export function emptyRobotsDriftAlarmState(): RobotsDriftAlarmState {
  return { lastAlarmedFingerprint: null, lastCheckedAt: null };
}

/** Pura — avança o cursor. `fingerprint: null` quando não há drift
 * pendente nesta checagem (re-arma pra próxima ocorrência). */
export function advanceRobotsDriftState(fingerprint: string | null, now: Date): RobotsDriftAlarmState {
  return { lastAlarmedFingerprint: fingerprint, lastCheckedAt: now.toISOString() };
}

/** Pura — `true` quando há drift pendente E o fingerprint é diferente do
 * último já alarmado. */
export function shouldAlarmRobotsDrift(state: RobotsDriftAlarmState, results: readonly RobotsDriftResult[]): boolean {
  if (!hasPendingRobotsDrift(results)) return false;
  return computeRobotsDriftFingerprint(results) !== state.lastAlarmedFingerprint;
}

// ─── Corpo do e-mail de alarme (puro) ──────────────────────────────────────

/** Pura — monta assunto + corpo do e-mail de alarme (texto puro, mesmo
 * padrão de `hub-drift-check.ts`). Lista só hosts com status "drift"/"error".
 * `issueRefs` (#5339, opcional) — mapa `robotsDriftFindingKey -> {issueNumber,
 * url, action, error}` de `scripts/lib/alarm-issues.ts`, usado pra citar a
 * issue de cada host com drift. `undefined` (dry-run, ou wiring ainda não
 * chamado) omite a citação sem quebrar nada — mesmo fallback de
 * `buildHubDriftAlarmEmail`. */
export function buildRobotsDriftAlarmEmail(
  results: readonly RobotsDriftResult[],
  now: Date = new Date(),
  issueRefs?: ReadonlyMap<string, { issueNumber: number | null; url: string | null; action: string; error?: string }>,
): { subject: string; body: string } {
  const pending = results.filter((r) => r.status === "drift" || r.status === "error");

  const subject = `[diar.ia.br] ${pending.length} host(s) com drift no robots.txt servido`;

  const lines: string[] = [
    "O smoke-test agendado do robots.txt SERVIDO (não o que renderCuradoriaRobotsTxt",
    "produz — o que de fato chega no crawler, depois de qualquer injeção da",
    "plataforma) encontrou host(s) com drift pendente.",
    "",
    `Host(s) com problema (${pending.length}):`,
  ];

  for (const r of pending) {
    if (r.status === "error") {
      const detail = r.fetchError ? `erro de rede: ${r.fetchError}` : `HTTP ${r.httpStatus} (esperava 200)`;
      lines.push(`  - ${r.host}: ${detail}`);
    } else {
      lines.push(`  - ${r.host}:`);
      for (const reason of r.reasons) lines.push(`      · ${reason}`);
    }
    lines.push(`    URL: ${r.url}`);
    const ref = issueRefs?.get(robotsDriftFindingKey(r));
    if (ref) {
      lines.push(ref.action === "failed" ? `    Issue: falha ao criar/reusar (${ref.error})` : `    Issue: #${ref.issueNumber} (${ref.url})`);
    }
  }

  lines.push(
    "",
    "Contexto (#4910): todo Worker num domínio proxiado pela Cloudflare nasce",
    "servindo um robots.txt gerenciado DEFAULT que é ANEXADO ao bloco próprio do",
    "Worker (nunca substituído) — se a plataforma mudar esse bloco (ex: bloquear",
    "um bot de recuperação/citação que hoje não bloqueia), ninguém percebe sem",
    "este alarme. Ver docstring de scripts/lib/shared/robots-txt.ts pro",
    "comportamento completo.",
    "",
    `(alarme automático — checagem rodou em ${now.toISOString()})`,
  );

  return { subject, body: lines.join("\n") };
}
