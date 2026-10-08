#!/usr/bin/env npx tsx
/**
 * fetch-test-email.ts (#9886)
 *
 * Busca o e-mail de teste ENTREGUE (Kit ou Beehiiv) direto pela Gmail REST
 * API, grava o corpo HTML em `_internal/.email-body.tmp` e roda o lint de
 * tamanho entregue (`lint-test-email-size`) — tudo dentro do processo. Quem
 * chama (o top-level do Stage 5, §5f passo 0) recebe só um resumo JSON de
 * poucas linhas no stdout; o corpo de ~100 KB nunca passa pelo contexto.
 *
 * Por que existe: o `review-test-email` só enxerga o prefixo
 * `mcp__claude_ai_Gmail__*`, e o conector costuma estar sob prefixo UUID —
 * então o §5f passo 0 (#9000) mandava o top-level chamar `get_thread`
 * (FULL_CONTENT) e gravar o corpo com Write. Na prática isso carregava ~100 KB
 * de HTML no contexto do top-level, ficou caro e foi pulado na 261008 (review
 * inconclusivo). Mesmo padrão do `fetch-newsletter-threads.ts` (#2452) e do
 * `inbox-drain.ts`: Gmail REST com `data/.credentials.json` (scope
 * `gmail.readonly`, `scripts/oauth-setup.ts`), sem MCP.
 *
 * Bônus: a Gmail REST devolve a parte `text/html` em base64url — decodificada
 * aqui uma única vez, sem a dupla decodificação quoted-printable suspeita no
 * caminho MCP (ver `review-test-email.md`, achado 260806) — e expõe o tamanho
 * real da parte HTML (`--html-bytes` do lint de tamanho, veredito definitivo
 * em vez do teto `sizeEstimate`).
 *
 * Uso:
 *   npx tsx scripts/fetch-test-email.ts --edition-dir data/editions/2610/261008 \
 *     --platform kit --title "{edition_title}" \
 *     [--wait-seconds 20] [--timeout-seconds 30] [--sent-after 2026-10-08T22:00:00Z]
 *
 * `--sent-after` (#9901): horário do envio do teste atual. Sem ele, uma
 * reexecução no mesmo dia pode ler o teste ANTERIOR quando o novo demora.
 * Só o Kit passa a âncora (#9905): no Beehiiv, `test_email_sent_at` de
 * `05-published.json` é gravado DEPOIS do clique em Send test e, como corte,
 * descartaria o próprio teste atual — o Stage 5 omite a flag nesse backend.
 *
 * Grava (só em sucesso):
 *   {edition_dir}/_internal/.email-body.tmp           corpo HTML (ou text/plain se não houver HTML)
 *   {edition_dir}/_internal/lint-size-{AAMMDD}.json   resultado do lint de tamanho entregue
 * Sempre grava `{edition_dir}/_internal/test-email-fetch.json` (o mesmo resumo do stdout).
 *
 * Exit:
 *   0 = encontrado (passar `email_file`/`email_subject` ao review-test-email)
 *   2 = uso (args inválidos, edition-dir sem `_internal/`)
 *   3 = não encontrado no prazo → §5f trata como `inconclusive`, reason `not_found_timeout`
 *   4 = Gmail REST indisponível (credencial ausente/expirada, erro de API) →
 *       §5f cai pro caminho MCP do passo 0 (prefixo resolvido por
 *       `resolve-mcp-connector.ts`)
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { isMainModule, parseArgsSimple } from "./lib/cli-args.ts";
import type { GmailMessagePart } from "./lib/schemas/gmail.ts";
import { parseGmailThread, type GmailThread } from "./lib/schemas/gmail.ts";
import { evaluateDeliveredSize, type DeliveredSizeResult } from "./lint-test-email-size.ts";

const GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me";

export type TestEmailPlatform = "kit" | "beehiiv";

/** Prefixo de assunto e remetente do test-send por ESP (mesmas queries do §5f / review-test-email). */
const PLATFORM_QUERY: Record<TestEmailPlatform, { prefix: string; from: string; waitSeconds: number }> = {
  kit: { prefix: "[teste] ", from: "news.diar.ia.br", waitSeconds: 20 },
  beehiiv: { prefix: "[TEST] ", from: "beehiiv.com", waitSeconds: 15 },
};

/** HTML local que o ESP recebeu — só pra contextualizar o lint de tamanho. */
const LOCAL_HTML: Record<TestEmailPlatform, string> = {
  kit: "newsletter-final-kit.html",
  beehiiv: "newsletter-final.html",
};

export const EMAIL_BODY_FILENAME = ".email-body.tmp";
export const FETCH_SUMMARY_FILENAME = "test-email-fetch.json";

/**
 * Queries em ordem de tentativa: com o prefixo do test-send e, de fallback,
 * sem ele (o ESP já mudou o prefixo antes). Aspas do título viram espaço —
 * dentro de `subject:"..."` elas fechariam a frase.
 *
 * @pure
 */
export function buildTestEmailQueries(platform: TestEmailPlatform, title: string): string[] {
  const { prefix, from } = PLATFORM_QUERY[platform];
  const safe = title.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  return [
    `subject:"${prefix}${safe}" from:${from} newer_than:1d`,
    `subject:"${safe}" from:${from} newer_than:1d`,
  ];
}

export interface LocatedPart {
  mimeType: "text/html" | "text/plain";
  /** base64url inline (`body.data`) — ausente quando o Gmail mandou a parte como anexo. */
  data?: string;
  attachmentId?: string;
  /** Tamanho decodificado declarado pelo Gmail (`body.size`). */
  size?: number;
}

/**
 * Acha a parte `text/html` (preferida) ou `text/plain` numa árvore MIME.
 * Ignora partes com `filename` (anexo de verdade, não corpo).
 *
 * @pure
 */
export function findBodyPart(part: GmailMessagePart): LocatedPart | null {
  const walk = (p: GmailMessagePart, mime: "text/html" | "text/plain"): LocatedPart | null => {
    if (p.mimeType === mime && !p.filename && (p.body?.data || p.body?.attachmentId)) {
      return { mimeType: mime, data: p.body.data, attachmentId: p.body.attachmentId, size: p.body.size };
    }
    for (const c of p.parts ?? []) {
      const hit = walk(c, mime);
      if (hit) return hit;
    }
    return null;
  };
  return walk(part, "text/html") ?? walk(part, "text/plain");
}

export function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export type FetchStatus = "found" | "not_found_timeout" | "gmail_api_unavailable";

export interface TestEmailFetchSummary {
  status: FetchStatus;
  platform: TestEmailPlatform;
  /** Query que achou a thread (ou a última tentada). */
  query: string | null;
  email_file: string | null;
  email_subject: string | null;
  message_id: string | null;
  received_at: string | null;
  body_mime: "text/html" | "text/plain" | null;
  body_bytes: number | null;
  size_estimate: number | null;
  lint_size_file: string | null;
  /** Resumo do lint de tamanho entregue — os achados completos ficam em `lint_size_file`. */
  lint_size: Pick<DeliveredSizeResult, "delivered_bytes" | "delivered_source" | "over_limit" | "may_clip" | "near_clip"> & {
    issues: string[];
  } | null;
  error: string | null;
}

/** Fronteira de I/O — injetável nos testes. */
export interface FetchDeps {
  /** GET em `${GMAIL_API}/${path}`; devolve o JSON já parseado ou lança. */
  gmailGet: (path: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

async function defaultGmailGet(path: string): Promise<unknown> {
  // Import tardio: sem credencial o módulo de auth só falha quando chamado,
  // e os testes nunca o carregam.
  const { gFetch } = await import("./google-auth.ts");
  const res = await gFetch(`${GMAIL_API}/${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API ${res.status} em /${path.split("?")[0]}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

const defaultDeps: FetchDeps = {
  gmailGet: defaultGmailGet,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

function header(msg: GmailThread["messages"][number], name: string): string | null {
  const h = msg.payload.headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

export interface FetchTestEmailOptions {
  editionDir: string;
  platform: TestEmailPlatform;
  title: string;
  waitSeconds?: number;
  timeoutSeconds?: number;
  pollSeconds?: number;
  /**
   * (#9901) Epoch ms do envio do teste ATUAL (`--sent-after <ISO>`). Mensagem
   * com `internalDate` anterior (menos `SENT_AFTER_SKEW_MS`) é ignorada e o
   * polling continua até o prazo. Ausente = comportamento antigo (mensagem
   * mais recente da 1ª thread), que numa reexecução no mesmo dia pode ler o
   * teste anterior.
   */
  sentAfterMs?: number;
}

/** (#9901) Folga pra relógio local vs. `internalDate` do Gmail. */
export const SENT_AFTER_SKEW_MS = 5_000;

/**
 * Mensagem mais recente da thread com `internalDate >= cutoff` (`cutoff`
 * null = sem filtro).
 *
 * @pure
 */
export function pickLatestMessage<M extends { internalDate: string }>(
  messages: readonly M[],
  cutoff: number | null,
): M | null {
  const sorted = [...messages].sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
  const hit = cutoff === null ? sorted[0] : sorted.find((m) => Number(m.internalDate) >= cutoff);
  return hit ?? null;
}

/**
 * Espera o test-send chegar, busca, materializa o corpo e roda o lint de
 * tamanho. Nunca lança por falha de Gmail — devolve `gmail_api_unavailable`
 * com a mensagem em `error`, pra o playbook escolher o fallback.
 */
export async function fetchTestEmail(
  opts: FetchTestEmailOptions,
  deps: FetchDeps = defaultDeps,
): Promise<TestEmailFetchSummary> {
  const internalDir = resolve(opts.editionDir, "_internal");
  const edition = basename(resolve(opts.editionDir));
  const queries = buildTestEmailQueries(opts.platform, opts.title);
  const base: TestEmailFetchSummary = {
    status: "not_found_timeout",
    platform: opts.platform,
    query: null,
    email_file: null,
    email_subject: null,
    message_id: null,
    received_at: null,
    body_mime: null,
    body_bytes: null,
    size_estimate: null,
    lint_size_file: null,
    lint_size: null,
    error: null,
  };

  const wait = opts.waitSeconds ?? PLATFORM_QUERY[opts.platform].waitSeconds;
  if (wait > 0) await deps.sleep(wait * 1000);

  const deadline = deps.now() + (opts.timeoutSeconds ?? 30) * 1000;
  const poll = (opts.pollSeconds ?? 5) * 1000;
  // #9901: com `sentAfterMs`, mensagem recebida antes do envio do teste atual
  // (teste anterior do mesmo dia, mesma thread ou outra) nunca é escolhida.
  const cutoff = opts.sentAfterMs === undefined ? null : opts.sentAfterMs - SENT_AFTER_SKEW_MS;
  let msg: GmailThread["messages"][number] | null = null;
  try {
    for (;;) {
      for (const q of queries) {
        base.query = q;
        const params = new URLSearchParams({ q, maxResults: "5" });
        const list = (await deps.gmailGet(`threads?${params}`)) as { threads?: Array<{ id: string }> };
        // A lista vem do mais recente pro mais antigo: um reenvio do teste fica no topo.
        for (const t of list.threads ?? []) {
          const thread = parseGmailThread(await deps.gmailGet(`threads/${t.id}?format=full`));
          msg = pickLatestMessage(thread.messages, cutoff);
          // Sem âncora: a 1ª thread decide, como antes (#9886).
          if (msg || cutoff === null) break;
        }
        if (msg) break;
      }
      if (msg || deps.now() >= deadline) break;
      await deps.sleep(poll);
    }
    if (!msg) return base;
    const part = findBodyPart(msg.payload as GmailMessagePart);
    if (!part) {
      return { ...base, status: "gmail_api_unavailable", error: `mensagem ${msg.id} sem parte text/html nem text/plain` };
    }
    let data = part.data;
    if (!data && part.attachmentId) {
      const att = (await deps.gmailGet(`messages/${msg.id}/attachments/${part.attachmentId}`)) as { data?: string };
      data = att.data;
    }
    if (!data) {
      return { ...base, status: "gmail_api_unavailable", error: `parte ${part.mimeType} da mensagem ${msg.id} veio vazia` };
    }
    const body = decodeBase64Url(data);
    const bodyBytes = Buffer.byteLength(body, "utf8");

    const emailFile = resolve(internalDir, EMAIL_BODY_FILENAME);
    writeFileSync(emailFile, body);

    const localHtml = resolve(internalDir, LOCAL_HTML[opts.platform]);
    const size = evaluateDeliveredSize({
      // Só a parte HTML mede o que o Gmail corta; text/plain cai pro sizeEstimate.
      htmlPartBytes: part.mimeType === "text/html" ? bodyBytes : null,
      sizeEstimate: msg.sizeEstimate ?? null,
      emailFileBytes: bodyBytes,
      localHtmlBytes: existsSync(localHtml) ? statSync(localHtml).size : null,
    });
    const lintFile = resolve(internalDir, `lint-size-${edition}.json`);
    writeFileSync(lintFile, JSON.stringify(size, null, 2) + "\n");

    return {
      ...base,
      status: "found",
      email_file: emailFile,
      email_subject: header(msg, "Subject"),
      message_id: msg.id,
      received_at: new Date(Number(msg.internalDate)).toISOString(),
      body_mime: part.mimeType,
      body_bytes: bodyBytes,
      size_estimate: msg.sizeEstimate ?? null,
      lint_size_file: lintFile,
      lint_size: {
        delivered_bytes: size.delivered_bytes,
        delivered_source: size.delivered_source,
        over_limit: size.over_limit,
        may_clip: size.may_clip,
        near_clip: size.near_clip,
        issues: size.issues.map((i) => `${i.type}: ${i.category}`),
      },
    };
  } catch (e) {
    return { ...base, status: "gmail_api_unavailable", error: (e as Error).message };
  }
}

export const EXIT_BY_STATUS: Record<FetchStatus, number> = {
  found: 0,
  not_found_timeout: 3,
  gmail_api_unavailable: 4,
};

function nonNegative(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${flag} inválido: ${raw}`);
  return n;
}

/** (#9901) `--sent-after <ISO>` → epoch ms; ausente → undefined; inválido lança. */
export function parseSentAfter(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(`--sent-after inválido (esperado ISO 8601): ${raw}`);
  return ms;
}

if (isMainModule(import.meta.url)) {
  const args = parseArgsSimple(process.argv.slice(2));
  const usage =
    "uso: fetch-test-email.ts --edition-dir <dir> --platform kit|beehiiv --title <edition_title> " +
    "[--wait-seconds N] [--timeout-seconds N] [--sent-after <ISO>]";
  const platform = args.platform;
  if (!args["edition-dir"] || !args.title || (platform !== "kit" && platform !== "beehiiv")) {
    console.error(usage);
    process.exit(2);
  }
  const internalDir = resolve(args["edition-dir"], "_internal");
  if (!existsSync(internalDir)) {
    console.error(`fetch-test-email: _internal/ ausente em ${args["edition-dir"]}`);
    process.exit(2);
  }
  let waitSeconds: number | undefined;
  let timeoutSeconds: number | undefined;
  let sentAfterMs: number | undefined;
  try {
    waitSeconds = nonNegative(args["wait-seconds"], "wait-seconds");
    timeoutSeconds = nonNegative(args["timeout-seconds"], "timeout-seconds");
    sentAfterMs = parseSentAfter(args["sent-after"]);
  } catch (e) {
    console.error(`fetch-test-email: ${(e as Error).message}`);
    process.exit(2);
  }
  const summary = await fetchTestEmail({
    editionDir: args["edition-dir"],
    platform,
    title: args.title,
    waitSeconds,
    timeoutSeconds,
    sentAfterMs,
  });
  const json = JSON.stringify(summary, null, 2);
  writeFileSync(resolve(internalDir, FETCH_SUMMARY_FILENAME), json + "\n");
  console.log(json);
  process.exitCode = EXIT_BY_STATUS[summary.status];
}
