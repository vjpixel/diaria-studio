#!/usr/bin/env npx tsx
/**
 * inject-poll-token-brevo.ts (#4517)
 *
 * Paridade Brevo do #4487/#4512 (`inject-poll-token.ts`, Beehiiv): popula o
 * MESMO token opaco por assinante (`computePollToken`, `lib/shared/poll-token.ts`
 * — ESP-agnóstico, HMAC do e-mail normalizado) num atributo de contato Brevo
 * `POLL_TOKEN` (equivalente ao custom field `poll_token` da Beehiiv), e grava
 * a MESMA entrada reversa `polltoken:{token} -> email` no KV do Worker `poll`
 * — `handleVote` (workers/poll/src/vote.ts) resolve token→email de forma
 * IDÊNTICA pras duas origens (a resolução não sabe nem precisa saber qual ESP
 * enviou o e-mail; só o domínio reservado `vote.eia.diaria.local` importa).
 *
 * Achado #4517 (fleet review pré-merge do #4512): `esp="brevo"` continuava
 * com `{{ contact.EMAIL }}` cru na URL de voto — o mesmo vetor de vazamento
 * que o #4487 existe pra fechar ("vota no lugar dele" quando a edição é
 * encaminhada), reaberto no único canal de produção real desse ESP
 * (`publish-daily-brevo.ts`, segmento Pending, já enviando ao vivo desde
 * 260803).
 *
 * Diferença de design vs. `inject-poll-token.ts` (Beehiiv): lá o escopo é a
 * base INTEIRA (milhares de assinantes), então faz sentido rodar como task
 * agendada separada, incremental via `--since-hours`. Aqui o escopo é SEMPRE
 * 1 lista Brevo específica (`brevo_diaria.list_id`), capada em
 * `brevo_diaria.daily_send_cap` (config — hoje bem abaixo do fallback de
 * código de 300, #4266) — barato o bastante pra `publish-daily-brevo.ts`
 * chamar `run()` INLINE antes de criar cada campanha, garantindo token
 * fresco pra quem vai receber o envio sem depender de nenhuma task agendada
 * (nunca esquecida, nunca defasada).
 *
 * Uso standalone (debug/backfill manual):
 *   npx tsx scripts/inject-poll-token-brevo.ts --list-id 7
 *   npx tsx scripts/inject-poll-token-brevo.ts --list-id 7 --dry-run
 *   npx tsx scripts/inject-poll-token-brevo.ts --list-id 7 --force   # rotação de POLL_SECRET
 *
 * Env:
 *   BREVO_DIARIA_API_KEY     - acesso à API Brevo (required; mesma env que
 *                               `publish-daily-brevo.ts` usa via
 *                               `platform.config.json > brevo_diaria.api_key_env`)
 *   POLL_SECRET              - HMAC key, mesma usada pelo Worker (required)
 *   CLOUDFLARE_ACCOUNT_ID    - conta Cloudflare (required fora de --dry-run)
 *   CLOUDFLARE_WORKERS_TOKEN - token com permissão Workers KV (required fora de --dry-run)
 *   POLL_KV_NAMESPACE_ID     - opcional, default = mesmo namespace físico do
 *                               Worker `poll` (`workers/poll/wrangler.toml`)
 *
 * Não executado ao vivo neste PR (worktree isolado, sem credenciais Brevo/
 * Cloudflare reais) — mesmo padrão já documentado pro #4320/#4382/#4487 em
 * CLAUDE.md. Wiring inline em `publish-daily-brevo.ts` (não-dry-run) fecha o
 * gap ANTES do próximo envio real; execução standalone fica disponível pra
 * backfill manual/debug.
 */

import { parseArgs } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { computePollToken, pollTokenKvKey, type PollToken } from "./lib/shared/poll-token.ts";
import { putTextToWorkerKV, type CloudflareKVConfig } from "./lib/cloudflare-kv-upload.ts";
import { brevoGet, brevoPost, brevoPut } from "./lib/brevo-client.ts";

loadProjectEnv(); // #1219 — carrega .env/.env.local antes de ler process.env.

const ATTR_NAME = "POLL_TOKEN";
const CONCURRENCY = 3;
// #1233/#1237: mesmo namespace físico que `inject-poll-token.ts` (Beehiiv) e
// `scripts/lib/poll-kv.ts` usam por default — o literal em si é DUPLICADO
// desses 2 arquivos (transportes HTTP diferentes, nenhum export público
// deles vale o acoplamento), mas o `export` AQUI existe pra `publish-daily-brevo.ts`
// (#4517) usar o MESMO valor sem re-duplicar um 4º literal — os dois arquivos
// já são diretamente acoplados por design (chamada inline). O Worker `poll`
// resolve o token de volta pro e-mail via ESTE namespace independente de
// qual ESP (Beehiiv ou Brevo) gravou a entrada — é o MESMO KV físico
// (`workers/poll/wrangler.toml` [[kv_namespaces]] id).
export const DEFAULT_POLL_KV_NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6";

interface BrevoContactAttribute {
  name: string;
  category: string;
  type: string;
}

interface BrevoContact {
  email: string;
  id?: number;
  attributes?: Record<string, unknown>;
}

interface BrevoContactsPage {
  contacts?: BrevoContact[];
  count?: number;
}

interface ApiOpts {
  apiKey: string;
  listId: number;
}

/** Cria o atributo de contato `POLL_TOKEN` (categoria "normal", tipo texto)
 * se ainda não existir. Idempotente — mesmo padrão de `ensureCustomField` em
 * `inject-poll-token.ts`. */
async function ensureContactAttribute(apiKey: string): Promise<void> {
  const { body } = await brevoGet(apiKey, "/contacts/attributes");
  const existing = new Set<string>(
    ((body as { attributes?: BrevoContactAttribute[] })?.attributes ?? []).map((a) => a.name),
  );
  if (existing.has(ATTR_NAME)) return;
  await brevoPost(apiKey, `/contacts/attributes/normal/${ATTR_NAME}`, { type: "text" });
  console.error(`[inject-poll-token-brevo] criado atributo de contato "${ATTR_NAME}"`);
}

/**
 * Contatos da lista, paginados — `GET /v3/contacts/lists/{listId}/contacts`.
 *
 * `limit=50` (não os 500 usados em `clarice-cta-ab-setup.ts`/
 * `clarice-engagement-cohorts.ts` pro mesmo endpoint) é intencional aqui:
 * esta lista é sempre pequena (capada em `brevo_diaria.daily_send_cap`, hoje
 * bem abaixo do fallback de 300 — ver cabeçalho do módulo), então o número
 * de páginas nunca é o gargalo; manter 50 evita re-tocar os testes de
 * paginação já escritos contra esse valor (#4517) sem nenhum ganho real de
 * latência nesta escala.
 *
 * #4532 (achado HIGH do silent-failure-hunter, fleet review pré-merge do
 * #4532): `brevoGet` trata QUALQUER 404 como resultado vazio não-fatal
 * (`{status:404, body:{}}`) — desenhado pra lookup de contato ÚNICO, onde
 * "sumiu entre listar e buscar" é esperado (ex:
 * `clarice-engagement-cohorts.ts::fetchListMembers`, que trata 404 nesse
 * MESMO endpoint como "lista apagada — pula", uma decisão de negócio
 * deliberada pra um job que itera VÁRIAS listas). Aqui o endpoint é a
 * listagem em MASSA da ÚNICA lista de produção deste canal
 * (`brevo_diaria.list_id`) — se ela responder 404 (list_id mudou, permissão
 * revogada, outage transitório da Brevo), NÃO significa "lista vazia":
 * significa que algo está errado, e silenciar isso faria `run()` devolver
 * `total_contacts: 0, failed: 0` — um falso-sucesso que passa o gate
 * `injectionResult.failed > 0` em `publish-daily-brevo.ts` e cria uma
 * campanha real sem NENHUM contato com `POLL_TOKEN` populado (o mesmo
 * vazamento que #4487/#4517 existem pra fechar). Mesmo padrão de
 * `clarice-cta-ab-setup.ts::fetchListEmails`, que já falha alto pro mesmo
 * endpoint em vez de reusar `brevoGet` como se fosse lookup single-contato.
 */
async function* iterateListContacts(opts: ApiOpts): AsyncGenerator<BrevoContact[]> {
  const limit = 50;
  let offset = 0;
  for (;;) {
    const { status, body } = await brevoGet(
      opts.apiKey,
      `/contacts/lists/${opts.listId}/contacts?limit=${limit}&offset=${offset}`,
    );
    if (status !== 200) {
      throw new Error(
        `GET /contacts/lists/${opts.listId}/contacts (offset=${offset}) retornou status ${status} — ` +
          "abortando enumeração (nunca trata resposta não-200 como lista vazia neste endpoint, #4532).",
      );
    }
    const contacts = (body as BrevoContactsPage).contacts ?? [];
    yield contacts;
    if (contacts.length < limit) break;
    offset += limit;
  }
}

/** `PUT /v3/contacts/{identifier}` — identifier = e-mail (URL-encoded, `@`→`%40`). */
async function patchContactToken(email: string, token: PollToken, apiKey: string): Promise<void> {
  await brevoPut(apiKey, `/contacts/${encodeURIComponent(email)}`, {
    attributes: { [ATTR_NAME]: token },
  });
}

async function processBatch<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<{ ok: number; failed: Array<{ item: T; error: string }> }> {
  let ok = 0;
  const failed: Array<{ item: T; error: string }> = [];
  let idx = 0;
  async function next(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      try {
        await worker(items[i]);
        ok++;
      } catch (e) {
        failed.push({ item: items[i], error: (e as Error).message });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return { ok, failed };
}

export interface RunResult {
  total_contacts: number;
  patched: number;
  skipped_already_correct: number;
  skipped_no_email: number;
  failed: number;
  /**
   * #4532 (achado type-design, fleet review pré-merge do #4532):
   * `processBatch` sabe QUAL contato falhou e por quê (`{item, error}`) mas
   * isso era colapsado num `failed: number` antes de sair de `run()` — quem
   * chama (ex: `publish-daily-brevo.ts` no abort de exit(5)) só conseguia
   * dizer "N contatos falharam", obrigando o operador a garimpar stderr
   * manualmente pra saber QUAIS. Exposto aqui pra a mensagem de abort citar
   * os e-mails diretamente.
   */
  failedContacts: Array<{ email: string; error: string }>;
  dry_run: boolean;
}

export async function run(args: {
  dryRun: boolean;
  force: boolean;
  apiOpts: ApiOpts;
  secret: string;
  kvConfig: CloudflareKVConfig;
  /** Injetável — mesmo padrão de `inject-poll-token.ts` (mock em teste sem
   * precisar de um 2º MockAgent/host pro Cloudflare). */
  putKv?: typeof putTextToWorkerKV;
}): Promise<RunResult> {
  const { dryRun, force, apiOpts, secret, kvConfig } = args;
  const putKv = args.putKv ?? putTextToWorkerKV;

  if (!dryRun) {
    await ensureContactAttribute(apiOpts.apiKey);
  }

  let total = 0;
  let patched = 0;
  let skippedAlready = 0;
  let skippedNoEmail = 0;
  let failedTotal = 0;
  const failedContacts: Array<{ email: string; error: string }> = [];

  for await (const page of iterateListContacts(apiOpts)) {
    total += page.length;
    const needsPatch: Array<{ email: string; token: PollToken }> = [];

    for (const contact of page) {
      if (!contact.email || !contact.email.trim()) {
        skippedNoEmail++;
        continue;
      }
      const expectedToken = await computePollToken(secret, contact.email);
      if (!force) {
        const current = contact.attributes?.[ATTR_NAME];
        if (current === expectedToken) {
          skippedAlready++;
          continue;
        }
      }
      needsPatch.push({ email: contact.email, token: expectedToken });
    }

    if (dryRun) {
      console.error(
        `[inject-poll-token-brevo] ${needsPatch.length} need patch, ${skippedAlready} already correct (running)`,
      );
      continue;
    }

    const result = await processBatch(needsPatch, CONCURRENCY, async (item) => {
      // Grava a entrada reversa PRIMEIRO — mesma garantia de segurança de
      // `inject-poll-token.ts`: se o PUT da Brevo falhar depois, o pior caso
      // é uma entrada KV órfã (sem custo real), nunca um atributo publicado
      // sem a entrada reversa correspondente (que faria o link 400 pro leitor).
      await putKv(pollTokenKvKey(item.token), item.email, kvConfig);
      await patchContactToken(item.email, item.token, apiOpts.apiKey);
    });
    patched += result.ok;
    failedTotal += result.failed.length;
    for (const f of result.failed) {
      failedContacts.push({ email: f.item.email, error: f.error });
      console.error(`[inject-poll-token-brevo] FAIL ${f.item.email}: ${f.error.slice(0, 200)}`);
    }
  }

  return {
    total_contacts: total,
    patched,
    skipped_already_correct: skippedAlready,
    skipped_no_email: skippedNoEmail,
    failed: failedTotal,
    failedContacts,
    dry_run: dryRun,
  };
}

async function main(): Promise<void> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has("dry-run");
  const force = flags.has("force");
  const listIdRaw = values["list-id"];
  const listId = listIdRaw ? Number(listIdRaw) : NaN;
  if (!listIdRaw || !Number.isFinite(listId)) {
    console.error(
      "[inject-poll-token-brevo] uso: npx tsx scripts/inject-poll-token-brevo.ts --list-id N [--dry-run] [--force]",
    );
    // Guard pré-await (nenhum fetch rodou ainda) — process.exit() continua
    // seguro aqui, mesmo padrão de publish-daily-brevo.ts (#4651). Só o
    // catch handler abaixo (pós-`await run()`) precisa de process.exitCode.
    process.exit(1);
  }

  const apiKey = process.env.BREVO_DIARIA_API_KEY;
  const secret = process.env.POLL_SECRET;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const workersToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
  const missing: string[] = [];
  if (!apiKey) missing.push("BREVO_DIARIA_API_KEY");
  if (!secret) missing.push("POLL_SECRET");
  if (!dryRun && !accountId) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (!dryRun && !workersToken) missing.push("CLOUDFLARE_WORKERS_TOKEN");
  if (missing.length > 0) {
    console.error(`[inject-poll-token-brevo] envs ausentes: ${missing.join(", ")} — abortando`);
    // Guard pré-await — ver comentário acima.
    process.exit(1);
  }

  const result = await run({
    dryRun,
    force,
    apiOpts: { apiKey: apiKey!, listId },
    secret: secret!,
    kvConfig: {
      accountId,
      token: workersToken,
      kvNamespaceId: process.env.POLL_KV_NAMESPACE_ID ?? DEFAULT_POLL_KV_NAMESPACE_ID,
    },
  });
  console.log(JSON.stringify(result, null, 2));
  // Mesmo racional de inject-poll-token.ts (#4512, achado silent-failure-hunter):
  // exit code coerente com falhas reportadas no resumo, nunca 0 silencioso.
  process.exitCode = result.failed > 0 ? 1 : 0;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  // #4653: process.exitCode em vez de process.exit() — este catch roda DEPOIS
  // de `await run(...)` (chamadas fetch pra Brevo/Cloudflare KV), o cenário
  // exato da classe de bug UV_HANDLE_CLOSING no Windows (#1401/#4638/#4651):
  // process.exit() força o shutdown do libuv antes dos sockets keep-alive do
  // fetch fecharem. process.exitCode deixa o event loop drenar sozinho.
  main().catch((e) => {
    console.error(`[inject-poll-token-brevo] ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
