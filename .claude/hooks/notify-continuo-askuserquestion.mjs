// PreToolUse hook — notifica por e-mail quando um `AskUserQuestion` pendente
// pertence a uma sessão `/diaria-continuo` ativa (#5293, fecha a lacuna
// registrada em ".claude/skills/diaria-continuo/SKILL.md" §"Risco aceito").
//
// Contexto: `/diaria-continuo` roda `AskUserQuestion` BLOQUEANTE (decisão do
// briefing 14/08/2026) numa sessão que fica viva o tempo todo — diferente do
// overnight (Regra 1: zero perguntas pós-briefing), aqui perguntar faz parte
// do desenho. O risco aceito de propósito é o mesmo do incidente 260706/07
// (#3037/#3038: um AskUserQuestion travou uma rodada ~8h com o editor
// dormindo) — tolerável só SE o editor souber que há uma pergunta pendente
// sem precisar estar olhando o terminal. Este hook fecha especificamente
// esse buraco: dispara uma notificação sempre que o `AskUserQuestion`
// pendente vem de uma sessão com `kind: "continuo"` registrada em
// `session-registry.ts`.
//
// #5341 (15/08/2026, decisão do editor): canal padronizado em e-mail via
// Gmail API, em vez de exigir a instalação de um app de mensagens novo — o
// canal anterior era um no-op silencioso sem credenciais configuradas. Reusa
// a MESMA credencial OAuth (`data/.credentials.json`) que `google-auth.ts`
// (Drive/inbox-drain/imagens sociais) e `scripts/lib/gmail-send.ts` (17
// alarmes agendados) já usam — mas **reimplementada aqui**, não importada
// (ver racional "Self-contained" abaixo): um refresh OAuth + envio via Gmail
// API é ~40 linhas de `fetch` cru, do mesmo porte que o POST direto na Bot
// API que este hook já reimplementava antes (#5341).
//
// Mecanismo: lê `session_id` do payload do hook (mesmo campo que
// `block-askuserquestion-overnight-autonomous.mjs` já usa), varre
// `data/sessions/` por um arquivo `continuo-*-{session_id}.json`
// (`scripts/lib/session-registry.ts` — `sessionFilePath`) com heartbeat
// dentro da janela de staleness (mesma `MAX_SESSION_AGE_MS` de 24h que o
// registry usa). Se encontrar, envia 1 e-mail pro editor
// (`resolveEditorEmail`-equivalente: lê `platform.config.json` diretamente,
// ou usa o default `vjpixel@gmail.com`).
//
// **NUNCA bloqueia.** Ao contrário do hook irmão
// (`block-askuserquestion-overnight-autonomous.mjs`), este hook é OBSERVAÇÃO
// pura — não emite `permissionDecision` em nenhum caminho, então o
// `AskUserQuestion` sempre segue pro fluxo normal de permissão
// independente do resultado da notificação. Falha de rede, credenciais
// ausentes/expiradas, sessão não encontrada, JSON malformado: tudo cai no
// mesmo caminho silencioso (exit 0, sem stdout/stderr no caminho feliz) —
// notificação é observabilidade extra, nunca crítica (mesmo princípio de
// `sendPushNotification`, `scripts/lib/push-notify.ts`).
//
// Self-contained (nenhum import de `scripts/*.ts`): mesma razão documentada
// em `pr-create-review.mjs`/`block-askuserquestion-overnight-autonomous.mjs`
// — um import estático de `.ts` executa antes de qualquer try/catch deste
// arquivo e pode derrubar o hook inteiro (silenciosamente) num Node sem
// type-stripping nativo. A leitura de `session-registry.ts`/OAuth/Gmail API
// são DUPLICADAS aqui (não importadas) pelo mesmo motivo — cobertas por
// `test/notify-continuo-askuserquestion.test.ts`, que não tem por objetivo
// re-testar `session-registry.ts`/`google-auth.ts`/`gmail-send.ts` em si (já
// cobertos nos próprios testes), só a integração específica deste hook.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/** Mesma janela de `session-registry.ts` (`MAX_SESSION_AGE_MS`) — sessão sem heartbeat há mais que isso é tratada como abandonada, não notifica. */
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Timeout de CADA chamada de rede (refresh OAuth, envio Gmail). Deliberadamente
 * menor que o `PUSH_IO_TIMEOUT_MS` (10s) de `scripts/lib/push-notify.ts` —
 * `.claude/settings.json` dá só 10s de orçamento TOTAL pra este hook rodar
 * (stdin + `git rev-parse` + `readdir`/`readFile` de `data/sessions/` + até
 * 2 fetches sequenciais aqui: refresh do access_token quando expirado, e o
 * envio em si). 4s por chamada, no pior caso (refresh + envio) soma 8s,
 * deixando ~2s de folga pro resto do hook antes do timeout externo do
 * harness matar o processo (#5293 fleet review, achado 5, mesmo raciocínio
 * do valor anterior de 6s pro caminho de 1 fetch só, antes de #5341).
 */
const GMAIL_IO_TIMEOUT_MS = 4_000;

/** Mesmo nome de env var de `scripts/google-auth.ts`
 * (`CREDENTIALS_PATH_TEST_OVERRIDE_ENV`) — permite que
 * `test/notify-continuo-askuserquestion.test.ts` force um path de
 * credenciais FAKE sem depender de `data/.credentials.json` real (que pode
 * existir de verdade na máquina que roda a suíte, junction OneDrive). Nunca
 * setar fora de testes. */
const CREDENTIALS_PATH_TEST_OVERRIDE_ENV = "DIARIA_TEST_CREDENTIALS_PATH";

const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const DEFAULT_EDITOR_EMAIL = "vjpixel@gmail.com";

/** Ver racional completo no hook irmão (`block-askuserquestion-overnight-autonomous.mjs`). */
export function resolveMainRepoRoot(execFn = execFileSync) {
  try {
    const gitDir = execFn("git", ["rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    return dirname(resolvePath(gitDir));
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  }
}

/**
 * Varre `data/sessions/` por um registro `continuo-*-{sessionId}.json` com
 * heartbeat dentro da janela de staleness. Retorna o registro parseado, ou
 * `null` (ausente, stale, corrompido, `data/sessions/` inexistente — mesmo
 * tratamento fail-soft de `listActiveSessions`, `session-registry.ts`).
 */
export function findActiveContinuoSession(repoRoot, sessionId, nowMs = Date.now()) {
  if (!sessionId) return null;
  const dir = join(repoRoot, "data", "sessions");
  if (!existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const suffix = `-${sessionId}.json`;
  for (const name of entries) {
    if (!name.startsWith("continuo-") || !name.endsWith(suffix)) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (record.sessionId !== sessionId) continue;
      const heartbeatIso = record.lastHeartbeat ?? record.startedAt;
      const heartbeatMs = Date.parse(heartbeatIso ?? "");
      if (!Number.isFinite(heartbeatMs)) continue;
      const ageMs = nowMs - heartbeatMs;
      if (ageMs < 0 || ageMs > MAX_SESSION_AGE_MS) continue;
      return record;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Extrai um resumo curto da pergunta pendente do `tool_input` de
 * `AskUserQuestion` — melhor esforço, nunca lança. `tool_input.questions` é
 * um array (schema real da tool); pega só a primeira pergunta e o header,
 * trunca pra não deixar o corpo do e-mail gigante.
 */
export function summarizePendingQuestion(toolInput) {
  try {
    const first = toolInput?.questions?.[0];
    if (!first?.question) return null;
    const header = first.header ? `[${first.header}] ` : "";
    const text = `${header}${first.question}`;
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return null;
  }
}

/** Resolve o e-mail do editor lendo `platform.config.json` diretamente
 * (equivalente self-contained de `resolveEditorEmail`,
 * `scripts/lib/inbox-stats.ts`) — fail-soft, nunca lança; ausente/corrompido
 * cai no default `vjpixel@gmail.com`. */
export function resolveEditorEmailInline(repoRoot) {
  try {
    const path = join(repoRoot, "platform.config.json");
    if (!existsSync(path)) return DEFAULT_EDITOR_EMAIL;
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    return cfg?.inbox?.editor_personal_email ?? DEFAULT_EDITOR_EMAIL;
  } catch {
    return DEFAULT_EDITOR_EMAIL;
  }
}

export function buildNotifyMessage(sessionId, questionSummary) {
  const lines = [`Sessão ${sessionId} (/diaria-continuo) está esperando resposta no terminal.`];
  if (questionSummary) lines.push(`Pergunta: ${questionSummary}`);
  return { subject: `[diar.ia.br continuo] AskUserQuestion pendente — sessão ${sessionId}`, body: lines.join("\n") };
}

/** Base64url (RFC 4648 §5) — formato exigido pelo campo `raw` da Gmail API.
 * Duplicado de `base64UrlEncode`, `scripts/lib/gmail-send.ts` (ver racional
 * "Self-contained" no topo do arquivo). */
function base64UrlEncode(input) {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** MIME mínimo (texto puro, UTF-8) — duplicado de `buildMimeMessage`,
 * `scripts/lib/gmail-send.ts`. */
function buildMimeMessage(to, subject, bodyText) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
  return [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    bodyText,
  ].join("\r\n");
}

function loadCredentials(repoRoot) {
  const path = process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] || join(repoRoot, "data", ".credentials.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Garante um `access_token` válido — reusa o já salvo se não estiver perto
 * de expirar (mesmo threshold de 90s de `google-auth.ts`), só faz o fetch de
 * refresh quando necessário (menos I/O no orçamento apertado deste hook).
 * Retorna `null` em qualquer falha (nunca lança).
 */
export async function ensureAccessToken(creds, fetchFn = fetch, nowMs = Date.now()) {
  if (nowMs <= (creds.expiry_ms ?? 0) - 90_000) return creds.access_token;
  try {
    const res = await fetchFn(GMAIL_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: creds.refresh_token,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(GMAIL_IO_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Fail-soft TOTAL (nunca lança, nunca afeta o `AskUserQuestion`) — mas
 * fail-soft ≠ silencioso: qualquer falha (credenciais ausentes, refresh
 * falho, resposta HTTP não-2xx do envio, exceção de rede) é logada em
 * stderr antes de retornar, mesma disciplina que o hook já tinha no canal
 * anterior (#5293 fleet review, achado 4) — sem isso, uma credencial que
 * para de funcionar degrada o hook pra um no-op indistinguível de
 * "funcionando", exatamente o "risco aceito" que este hook existe pra
 * mitigar.
 */
export async function sendNotification(message, repoRoot, fetchFn = fetch) {
  const creds = loadCredentials(repoRoot);
  if (!creds) return; // sem credenciais configuradas — no-op silencioso
  const accessToken = await ensureAccessToken(creds, fetchFn);
  if (!accessToken) {
    process.stderr.write("notify-continuo-askuserquestion: refresh do access_token falhou.\n");
    return;
  }
  const to = resolveEditorEmailInline(repoRoot);
  const raw = base64UrlEncode(buildMimeMessage(to, message.subject, message.body));
  try {
    const resp = await fetchFn(GMAIL_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(GMAIL_IO_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      process.stderr.write(
        `notify-continuo-askuserquestion: Gmail API respondeu ${resp.status}: ${body.slice(0, 200)}\n`,
      );
    }
  } catch (e) {
    process.stderr.write(`notify-continuo-askuserquestion: falha ao enviar e-mail: ${String(e)}\n`);
  }
}

// #2019-style CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por test/notify-continuo-askuserquestion.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", async () => {
    try {
      const payload = JSON.parse(data || "{}");
      if (payload.tool_name && payload.tool_name !== "AskUserQuestion") return;
      const repoRoot = resolveMainRepoRoot();
      const session = findActiveContinuoSession(repoRoot, payload.session_id);
      if (!session) return; // não é uma sessão continuo ativa — nada a notificar
      const questionSummary = summarizePendingQuestion(payload.tool_input);
      await sendNotification(buildNotifyMessage(payload.session_id, questionSummary), repoRoot);
    } catch {
      // Fail-soft total — nunca deve afetar o fluxo normal do AskUserQuestion
      // (este hook nunca emite hookSpecificOutput, em nenhum caminho).
    }
  });
}
