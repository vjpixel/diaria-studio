// PreToolUse hook — notifica Telegram quando um `AskUserQuestion` pendente
// pertence a uma sessão `/diaria-continuo` ativa (#5293, fecha a lacuna
// registrada em ".claude/skills/diaria-continuo/SKILL.md" §"Risco aceito").
//
// Contexto: `/diaria-continuo` roda `AskUserQuestion` BLOQUEANTE (decisão do
// briefing 14/08/2026) numa sessão que fica viva o tempo todo — diferente do
// overnight (Regra 1: zero perguntas pós-briefing), aqui perguntar faz parte
// do desenho. O risco aceito de propósito é o mesmo do incidente 260706/07
// (#3037/#3038: um AskUserQuestion travou uma rodada ~8h com o editor
// dormindo) — tolerável só SE o editor souber que há uma pergunta pendente
// sem precisar estar olhando o terminal. A issue de origem já cita
// `scripts/lib/telegram-notify.ts` e o `gate-chat-bridge.js` do Studio como
// mitigação — mas ambos só cobrem sessões abertas PELO chat drawer do
// Studio, não uma sessão `/diaria-continuo` rodando num terminal comum (a
// forma decidida no briefing). Este hook fecha especificamente esse buraco:
// dispara Telegram sempre que o `AskUserQuestion` pendente vem de uma sessão
// com `kind: "continuo"` registrada em `session-registry.ts`.
//
// Mecanismo: lê `session_id` do payload do hook (mesmo campo que
// `block-askuserquestion-overnight-autonomous.mjs` já usa), varre
// `data/sessions/` por um arquivo `continuo-*-{session_id}.json`
// (`scripts/lib/session-registry.ts` — `sessionFilePath`) com heartbeat
// dentro da janela de staleness (mesma `MAX_SESSION_AGE_MS` de 24h que o
// registry usa). Se encontrar, dispara um POST direto na Telegram Bot API
// (mesma credencial `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` de
// `scripts/lib/telegram-notify.ts` — reimplementada aqui, não importada, ver
// racional abaixo).
//
// **NUNCA bloqueia.** Ao contrário do hook irmão
// (`block-askuserquestion-overnight-autonomous.mjs`), este hook é OBSERVAÇÃO
// pura — não emite `permissionDecision` em nenhum caminho, então o
// `AskUserQuestion` sempre segue pro fluxo normal de permissão
// independente do resultado da notificação. Falha de rede, credencial
// ausente, sessão não encontrada, JSON malformado: tudo cai no mesmo
// caminho silencioso (exit 0, sem stdout/stderr) — notificação é
// observabilidade extra, nunca crítica (mesmo princípio de
// `sendTelegramNotification`, `scripts/lib/telegram-notify.ts`).
//
// Self-contained (nenhum import de `scripts/*.ts`): mesma razão documentada
// em `pr-create-review.mjs`/`block-askuserquestion-overnight-autonomous.mjs`
// — um import estático de `.ts` executa antes de qualquer try/catch deste
// arquivo e pode derrubar o hook inteiro (silenciosamente) num Node sem
// type-stripping nativo. A leitura de `session-registry.ts` e o POST de
// `telegram-notify.ts` são DUPLICADOS aqui (não importados) pelo mesmo
// motivo — cobertos por `test/notify-continuo-askuserquestion.test.ts`, que
// não tem por objetivo re-testar `session-registry.ts`/`telegram-notify.ts`
// em si (já cobertos nos próprios testes), só a integração específica deste
// hook.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/** Mesma janela de `session-registry.ts` (`MAX_SESSION_AGE_MS`) — sessão sem heartbeat há mais que isso é tratada como abandonada, não notifica. */
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/** Mesmo timeout de `scripts/lib/telegram-notify.ts` (`TELEGRAM_IO_TIMEOUT_MS`) — nenhuma chamada de rede deste projeto fica sem limite. */
const TELEGRAM_IO_TIMEOUT_MS = 10_000;

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
 * trunca pra não estourar o limite de mensagem do Telegram.
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

/** Mesmo formato de `buildTelegramSendMessageRequest`, `scripts/lib/telegram-notify.ts` — duplicado, ver docblock do topo. */
export function buildNotifyRequest(token, chatId, text) {
  return {
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(TELEGRAM_IO_TIMEOUT_MS),
    },
  };
}

export function buildNotifyMessage(sessionId, questionSummary) {
  const lines = [
    "*[diar.ia.br continuo] AskUserQuestion pendente*",
    `Sessão \`${sessionId}\` está esperando resposta no terminal.`,
  ];
  if (questionSummary) lines.push(`Pergunta: ${questionSummary}`);
  return lines.join("\n");
}

async function sendNotification(text, fetchFn = fetch) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_WATCHDOG_CHAT_ID;
  if (!token || !chatId) return; // sem credenciais configuradas — no-op silencioso
  try {
    const { url, options } = buildNotifyRequest(token, chatId, text);
    await fetchFn(url, options);
  } catch {
    // Fail-soft total — ver docblock do topo.
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
      await sendNotification(buildNotifyMessage(payload.session_id, questionSummary));
    } catch {
      // Fail-soft total — nunca deve afetar o fluxo normal do AskUserQuestion
      // (este hook nunca emite hookSpecificOutput, em nenhum caminho).
    }
  });
}
