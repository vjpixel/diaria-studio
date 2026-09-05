/**
 * apply-mcp-subscriber-engagement.ts (#6465, fatia 1 do epic #6464)
 *
 * Aplica per-subscriber engagement data buscada via MCP
 * `list_post_subscriber_engagement` (e, se o invocador também paginar
 * `list_post_click_subscribers`, essa identidade por clique) num JSONL
 * append-only por post: `data/beehiiv-backup/subscriber-engagement/{post_id}.jsonl`.
 *
 * Por que existe: o cruzamento assinante × edição (quem abriu/clicou em QUAL
 * post, quando) só existe via essas 2 tools MCP — a API REST pública do
 * Beehiiv não expõe isso (mesmo gap documentado em `MCP_ONLY_GAPS` de
 * `scripts/backup-beehiiv.ts`). MCPs só são chamáveis de dentro de uma
 * sessão Claude (top-level ou subagent com a tool no escopo) — nunca de
 * scripts TS standalone. O agent `beehiiv-engagement-backup` (molde:
 * `.claude/agents/beehiiv-clicks-enricher.md`) faz o fetch paginado e pipa
 * o resultado acumulado pra este script, que persiste em disco.
 *
 * Formato do JSONL: 1 linha = 1 registro CRU retornado pela MCP (sem
 * reshape de campos — ao contrário de `apply-mcp-clicks.ts`, que remapeia
 * pro shape legado de `build-link-ctr.ts`, aqui a prioridade é preservar
 * fidelidade do dado antes que o acesso à API acabe; qualquer modelagem
 * fica pro epic #6464, fora de escopo desta fatia).
 *
 * Uso (do agent `beehiiv-engagement-backup`):
 *   echo '{"engagement":[...]}' | npx tsx scripts/apply-mcp-subscriber-engagement.ts \
 *     --post-id post_<uuid> [--title "..."] [--kind engagement|click-subscribers] \
 *     [--pages-fetched 3 --total-pages 3] [--allow-empty-replace] [--confirmed-empty] \
 *     [--out-dir data/beehiiv-backup/subscriber-engagement]
 *
 *   # `list_post_click_subscribers` (identidade de clique) SEMPRE com
 *   # `--kind click-subscribers` (#7460) — grava em
 *   # `data/beehiiv-backup/click-subscribers/{post_id}.jsonl`, nunca no
 *   # mesmo `.jsonl` de engagement:
 *   echo '{"engagement":[...clique...]}' | npx tsx scripts/apply-mcp-subscriber-engagement.ts \
 *     --post-id post_<uuid> --kind click-subscribers --append
 *
 *   # Append vs replace: default é REPLACE (reescreve o `.jsonl` inteiro a
 *   # partir do array completo). Use --append (#6733) pra aplicar página a
 *   # página IMEDIATAMENTE após cada fetch MCP, sem exigir acumular/
 *   # retranscrever manualmente múltiplas páginas antes de aplicar nenhuma —
 *   # esse acúmulo manual já perdeu 1 registro de 100 numa transcrição real:
 *   echo '{"engagement":[page1]}' | npx tsx scripts/apply-mcp-subscriber-engagement.ts --post-id X --pages-fetched 1 --total-pages 3
 *   echo '{"engagement":[page2]}' | npx tsx scripts/apply-mcp-subscriber-engagement.ts --post-id X --pages-fetched 2 --total-pages 3 --append
 *   echo '{"engagement":[page3]}' | npx tsx scripts/apply-mcp-subscriber-engagement.ts --post-id X --pages-fetched 3 --total-pages 3 --append
 *
 * GUARD `ok` + 0 registros (#7197 — auditoria do acervo achou 7 posts assim,
 * herdados do padrão de fabricação que o #6496 já corrigiu no AGENT, mas
 * nunca ganhou um guard MECÂNICO deste script): por padrão, um resultado com
 * 0 registros nunca fecha como `ok` — fecha como `partial` (`error` explica
 * o motivo), forçando o post de volta pra `pendingEntries()` até alguém
 * confirmar de propósito que o 0 é real. Passe `--confirmed-empty` só quando
 * você (o agent) *literalmente acabou de receber*, nesta invocação, uma
 * resposta vazia da MCP pra ESTE post_id — nunca porque "provavelmente é
 * isso" (mesma disciplina de anti-fabricação do agent `beehiiv-engagement-backup`).
 *
 * #7418: `--confirmed-empty` não é só um gate local — grava um flag
 * `confirmed_empty: true` NO MANIFEST (`scripts/lib/beehiiv-engagement-manifest.ts`,
 * campo novo em `EngagementManifestEntry`). O `reconcileManifestWithDisk`
 * (checagem 1) rebaixa todo `ok` com 0 linhas em disco pra `pending` sem
 * distinguir "nunca tentado" de "confirmado vazio de propósito" — os mesmos
 * 6 posts confirmados vazios (post_0dbd15c0, post_a8b8fdd0, post_ae4b42b2,
 * post_56cef195, post_6f15f694, post_815c6e63, medido no #7268) piscavam
 * ok→pending a cada auditoria, forçando reprocessamento (~90-160k tokens por
 * lote de 8). Com o flag, a checagem 1 o respeita: nunca rebaixa uma entry
 * que já foi confirmada vazia de propósito.
 *
 * Stdin JSON (tolerante — mesmo padrão de `apply-mcp-clicks.ts`):
 *   { "engagement": [...] }   — wrapper shape (resposta direta da MCP)
 *   { "data": [...] }         — alternativo
 *   [...]                     — array nu
 *
 * Modo padrão é REPLACE (reescreve o `.jsonl` inteiro a partir do array
 * completo que o invocador passou). `--append` (#6733) mescla o payload
 * novo com o que já está em disco, deduplicando por `subscriber_id`
 * (registro incoming vence em caso de conflito — mesma convenção do dedup
 * por `url` de `apply-mcp-clicks.ts`); registro sem `subscriber_id` nunca é
 * deduplicado contra outro (cada um é tratado como único, via chave
 * sintética) — degrada pra "nunca perde dado", nunca pra "colapsa dado
 * potencialmente distinto". `--append` existe porque, diferente de
 * `list_post_clicks` (que o enricher já pagina e junta em `allClicks` antes
 * de aplicar), a paginação de `list_post_subscriber_engagement` tende a ter
 * mais páginas — forçar o agent a acumular/retranscrever manualmente todas
 * antes do primeiro apply é o que causou a perda de registro que motivou
 * este flag.
 *
 * GUARD (mesmo padrão de #4836 em `apply-mcp-clicks.ts`): em modo REPLACE
 * (sem `--append`), nunca apaga um JSONL não-vazio com um payload vazio sem
 * `--allow-empty-replace` explícito — um MCP que responde vazio por
 * rate-limit/timeout/paginação malformada não pode silenciosamente destruir
 * engagement já confirmado. Em modo `--append`, o guard não se aplica —
 * aplicar uma página vazia nunca apaga o que já está em disco (é sempre uma
 * união, nunca uma substituição), então não há dado pra perder.
 *
 * Efeito colateral (sempre, mesmo em erro): grava/atualiza
 * `{out-dir}/manifest.json` via `scripts/lib/beehiiv-engagement-manifest.ts`
 * — status `ok` (todas as páginas confirmadas E ≥1 registro, ou 0 registros
 * com `--confirmed-empty`, ver guard #7197 acima), `partial` (paginação
 * truncada — `pages_fetched < total_pages` — OU 0 registros sem
 * `--confirmed-empty`), ou `error` (falha antes de escrever, OU guard
 * `schema-fora-do-canonico` abaixo). Isso é o que torna a extração
 * retomável entre invocações do agent: `list-posts-for-engagement-backup.ts`
 * só reoferece posts que não estão `ok`.
 *
 * ## `--kind` (#7460, residual do #7181/#7172) — 2 fontes, 2 destinos
 *
 * `--kind engagement` (default) grava em `subscriber-engagement/{post_id}.jsonl`
 * (per-subscriber engagement, `list_post_subscriber_engagement`). `--kind
 * click-subscribers` grava num diretório IRMÃO,
 * `click-subscribers/{post_id}.jsonl` (identidade de clique,
 * `list_post_click_subscribers`) — próprio `.jsonl`, próprio
 * `manifest.json`, nunca toca o `count`/manifest de engagement. Use `--kind
 * click-subscribers` sempre que aplicar o resultado de
 * `list_post_click_subscribers` — nunca aplique esse payload com o `--kind`
 * default (`engagement`).
 *
 * ## Guard `schema-fora-do-canonico` (#7460) — só em `--kind engagement`
 *
 * O #7181 mediu 1.147/51.620 linhas (2,2%) fora da assinatura canônica no
 * acervo, incluindo 768 stubs sintéticos (`{"subscriber_id":"s1"}`) que
 * passaram por este script sem guard nenhum de conteúdo — só a contagem
 * batia, então `status: "ok"` saía sobre lixo puro. Este guard usa o leitor
 * canônico (`scripts/lib/beehiiv-engagement-read.ts`) pra classificar CADA
 * linha do payload recém-chegado (`incoming`, antes do merge/replace):
 *
 *   - **click-identity** (schema de `list_post_click_subscribers` aplicado
 *     por engano com `--kind engagement`) é ROTEADO automaticamente pro
 *     `click-subscribers/{post_id}.jsonl` irmão — nunca gravado no `.jsonl`
 *     de engagement, mesmo sem o chamador ter passado `--kind` certo.
 *   - **stub / malformado** é REJEITADO — nunca gravado em lugar nenhum,
 *     só contado.
 *   - o resto (canônico, e-mail-em-subscriber_id, sem-e-mail — classes
 *     recuperáveis do #7181) é gravado **verbatim**, sem reshape — a
 *     fidelidade do dado cru continua sendo a prioridade (só o leitor, na
 *     análise, remapeia/filtra; a escrita preserva).
 *
 * Se **≥50%** das linhas do payload forem stub/malformado (não-canônicas E
 * também não são click-identity, que é payload legítimo de outro
 * endpoint) — o lote inteiro é suspeito de fabricação/corrupção — `status`
 * nunca vira `ok`/`partial`: vira **`error`**, motivo
 * `schema-fora-do-canonico`, e o disco **não é tocado** (mesma disciplina
 * do guard de replace-vazio: dispara antes de escrever). O post permanece
 * como estava (`pendingEntries()` continua oferecendo pra retry — `error`
 * conta como pendente, ver `beehiiv-engagement-manifest.ts`).
 *
 * Output (stdout): JSON `{ post_id, before_count, after_count, status }`.
 * Stderr: warnings.
 *
 * Exit codes: 0=sucesso (inclui `status: "error"` do guard de schema — não é
 * falha do SCRIPT, é o resultado reportado), 1=erro IO/parse, 2=args
 * inválidos, 3=guard — replace apagaria JSONL não-vazio sem
 * `--allow-empty-replace`.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import {
  buildInitialManifest,
  upsertEntry,
  type EngagementManifest,
  type EngagementManifestEntry,
} from "./lib/beehiiv-engagement-manifest.ts";
import { classifyEngagementRecords, nonCanonicalFraction } from "./lib/beehiiv-engagement-read.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = resolve(ROOT, "data/beehiiv-backup/subscriber-engagement");
const DEFAULT_CLICK_SUBSCRIBERS_OUT_DIR = resolve(ROOT, "data/beehiiv-backup/click-subscribers");

/** As 2 fontes MCP que este script aceita — ver docstring `--kind` acima. */
export type ApplyEngagementKind = "engagement" | "click-subscribers";

/** Fração mínima de linhas stub/malformadas pra disparar o guard `schema-fora-do-canonico` (#7460). */
export const SCHEMA_GUARD_THRESHOLD = 0.5;

/** Erro do guard `schema-fora-do-canonico` — nunca lançado (o guard fecha via `status: "error"`
 *  no resultado, não via exceção); exportado só pro motivo estável usado em teste/manifest. */
export const SCHEMA_GUARD_REASON_PREFIX = "guard schema-fora-do-canonico (#7460)";

/** Flag de override do guard de replace-vazio — mesma convenção de `apply-mcp-clicks.ts`. */
export const ALLOW_EMPTY_REPLACE_FLAG = "--allow-empty-replace";

/** Erro do guard REPLACE-vazio — distinto de erro de IO/parse pra permitir exit code próprio (3). */
export class EmptyReplaceGuardError extends Error {
  constructor(postId: string, lostCount: number) {
    super(
      `guard: REPLACE apagaria ${lostCount} registro(s) existente(s) de ${postId} ` +
        `(JSONL não-vazio → payload vazio). Se isso é esperado (ex: MCP confirmou ` +
        `0 assinantes engajados de verdade pro post), rode de novo com ${ALLOW_EMPTY_REPLACE_FLAG}.`,
    );
    this.name = "EmptyReplaceGuardError";
  }
}

/** Extrai array de registros de qualquer formato suportado de input (mesma tolerância de `apply-mcp-clicks.ts`). */
export function extractEngagementArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.engagement)) return obj.engagement;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
}

/** Lê o nº de linhas não-vazias de um JSONL existente — 0 se o arquivo não existe. */
export function countExistingLines(path: string): number {
  if (!existsSync(path)) return 0;
  const content = readFileSync(path, "utf8");
  return content.split("\n").filter((line) => line.trim().length > 0).length;
}

/** Lê e faz parse das linhas não-vazias de um JSONL existente — [] se o arquivo não existe. */
export function readExistingRecords(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * Mescla `existing` (já em disco) com `incoming` (payload desta chamada),
 * deduplicando por `subscriber_id` — incoming vence em caso de conflito
 * (mesma convenção do dedup por `url` em `apply-mcp-clicks.ts`). Registro
 * sem `subscriber_id` string nunca é deduplicado contra outro: cada um
 * recebe uma chave sintética própria (índice na lista concatenada), então
 * nunca colide com um registro de outra página que também careça do campo.
 */
export function mergeEngagementRecords(existing: unknown[], incoming: unknown[]): unknown[] {
  const merged = new Map<string, unknown>();
  let syntheticIdx = 0;
  const put = (record: unknown) => {
    const subscriberId =
      record && typeof record === "object" && typeof (record as { subscriber_id?: unknown }).subscriber_id === "string"
        ? (record as { subscriber_id: string }).subscriber_id
        : undefined;
    const key = subscriberId ?? `__no_id_${syntheticIdx++}`;
    merged.set(key, record);
  };
  for (const r of existing) put(r);
  for (const r of incoming) put(r); // incoming wins se mesmo subscriber_id
  return [...merged.values()];
}

export interface ApplyEngagementOpts {
  postId: string;
  title?: string;
  /** `"engagement"` (default) ou `"click-subscribers"` — ver docstring `--kind` no topo do arquivo. */
  kind?: ApplyEngagementKind;
  pagesFetched?: number;
  totalPages?: number;
  /**
   * Âncora externa da completude (#7197) — apesar do nome do flag, o valor
   * certo pra passar é `stats.email.delivered`, não `stats.email.recipients`
   * (achado #7268/#7394): a MCP só devolve eventos de mensagem ENTREGUE, e
   * `recipients` inclui bounces que nunca geram registro nenhum, tornando o
   * guard abaixo inatingível pra todo post com ≥1 bounce se ancorado nele.
   */
  recipients?: number;
  allowEmptyReplace?: boolean;
  outDir?: string;
  /** Mescla com o JSONL existente (dedup por `subscriber_id`) em vez de sobrescrever (#6733). */
  append?: boolean;
  /**
   * Confirma explicitamente que 0 registros é o resultado REAL de uma
   * resposta MCP recebida nesta invocação (#7197) — sem isso, um resultado
   * final com 0 registros nunca fecha como `ok` (vira `partial`, ver guard
   * no topo do arquivo).
   */
  confirmedEmpty?: boolean;
}

export interface ApplyEngagementResult {
  post_id: string;
  before_count: number;
  after_count: number;
  status: "ok" | "partial" | "error";
  /** Nº de linhas classe B (click-identity) roteadas automaticamente pro
   *  `click-subscribers/{post_id}.jsonl` irmão nesta invocação — só presente
   *  quando `kind === "engagement"` (default) e ≥1 linha foi roteada. */
  routed_click_count?: number;
  /** Nº de linhas stub/malformadas rejeitadas (nunca gravadas) nesta
   *  invocação — só presente quando `kind === "engagement"` (default) e ≥1
   *  linha foi rejeitada, mesmo quando o guard de 50% não disparou. */
  discarded_count?: number;
}

/** Escreve `records` (JSON.stringify por linha) atomicamente via tmp+rename. */
function writeJsonlAtomic(path: string, records: unknown[]): void {
  const tmp = `${path}.tmp`;
  const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

function loadManifest(manifestPath: string): EngagementManifest {
  if (!existsSync(manifestPath)) return buildInitialManifest([], new Date().toISOString());
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as EngagementManifest;
  } catch {
    return buildInitialManifest([], new Date().toISOString());
  }
}

function saveManifestAtomic(manifestPath: string, manifest: EngagementManifest): void {
  const tmp = `${manifestPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(tmp, manifestPath);
}

/**
 * Roteia linhas classe B (click-identity) pro `click-subscribers/{post_id}.jsonl`
 * IRMÃO do outDir de engagement — sempre `--append` (nunca REPLACE: não temos
 * como saber se este payload é a extração completa do endpoint de clique,
 * então mesclar é a única opção que nunca perde dado já roteado antes).
 * Dedup ingênuo por igualdade de JSON — registros de clique não têm uma
 * chave natural única acordada aqui (podem faltar `subscription_id`), então
 * evitar duplicata exata é suficiente; nunca colapsa 2 registros distintos.
 */
export function routeClickIdentityRecords(engagementOutDir: string, postId: string, clickRecords: unknown[]): void {
  if (clickRecords.length === 0) return;
  const clickOutDir = resolve(engagementOutDir, "..", "click-subscribers");
  mkdirSync(clickOutDir, { recursive: true });
  const jsonlPath = resolve(clickOutDir, `${postId}.jsonl`);
  const existing = readExistingRecords(jsonlPath);
  const seen = new Set(existing.map((r) => JSON.stringify(r)));
  const merged = [...existing];
  for (const r of clickRecords) {
    const key = JSON.stringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(r);
  }
  writeJsonlAtomic(jsonlPath, merged);
}

/**
 * Aplica o payload de engagement de 1 post. Lança em erro de IO/parse ou no
 * guard de replace-vazio; caller (main) traduz pra exit code apropriado.
 * Nunca lança pelo guard `schema-fora-do-canonico` (#7460) — esse guard
 * fecha via `status: "error"` no resultado normal, ver docstring do módulo.
 */
export function applyEngagement(stdinJson: string, opts: ApplyEngagementOpts): ApplyEngagementResult {
  const kind: ApplyEngagementKind = opts.kind ?? "engagement";
  const outDir = opts.outDir ?? (kind === "click-subscribers" ? DEFAULT_CLICK_SUBSCRIBERS_OUT_DIR : DEFAULT_OUT_DIR);
  mkdirSync(outDir, { recursive: true });
  const jsonlPath = resolve(outDir, `${opts.postId}.jsonl`);
  const manifestPath = resolve(outDir, "manifest.json");

  const beforeCount = countExistingLines(jsonlPath);
  const raw = JSON.parse(stdinJson) as unknown;
  let incoming = extractEngagementArray(raw);

  let routedClickCount = 0;
  let discardedCount = 0;

  if (kind === "engagement" && incoming.length > 0) {
    // Guard `schema-fora-do-canonico` (#7460) — classifica ANTES de tocar
    // disco/manifest, mesma ordem do guard de replace-vazio abaixo.
    if (nonCanonicalFraction(incoming) >= SCHEMA_GUARD_THRESHOLD) {
      const garbageCount = classifyEngagementRecords(incoming).filter(
        (c) => c.class === "stub" || c.class === "malformed",
      ).length;
      const reason =
        `${SCHEMA_GUARD_REASON_PREFIX}: ${garbageCount}/${incoming.length} linhas stub/malformadas ` +
        `(fora do canônico e também fora do schema de click-identity) — lote rejeitado, disco não tocado`;
      const manifest = loadManifest(manifestPath);
      const entry: EngagementManifestEntry = {
        post_id: opts.postId,
        title: opts.title,
        status: "error",
        count: beforeCount,
        pages_fetched: opts.pagesFetched,
        total_pages: opts.totalPages,
        fetched_at: new Date().toISOString(),
        error: reason,
      };
      saveManifestAtomic(manifestPath, upsertEntry(manifest, entry));
      return { post_id: opts.postId, before_count: beforeCount, after_count: beforeCount, status: "error" };
    }

    // Abaixo do threshold: roteia classe B (click-identity) pro arquivo
    // irmão e rejeita stub/malformado — nunca gravados no `.jsonl` de
    // engagement, mesmo sem o chamador ter passado `--kind` certo. Classes
    // recuperáveis do #7181 (e-mail-em-subscriber_id, sem-e-mail) e
    // canônica seguem verbatim, sem reshape.
    const classified = classifyEngagementRecords(incoming);
    const clickRecords: unknown[] = [];
    const keep: unknown[] = [];
    for (let i = 0; i < classified.length; i++) {
      const c = classified[i];
      if (c.class === "click-identity") clickRecords.push(incoming[i]);
      else if (c.class === "stub" || c.class === "malformed") discardedCount++;
      else keep.push(incoming[i]);
    }
    routedClickCount = clickRecords.length;
    routeClickIdentityRecords(outDir, opts.postId, clickRecords);
    incoming = keep;
  }

  let records: unknown[];
  if (opts.append) {
    // Append (#6733): mescla com o que já está em disco — nunca apaga nada,
    // então o guard de replace-vazio abaixo não se aplica a este ramo.
    const existing = readExistingRecords(jsonlPath);
    records = mergeEngagementRecords(existing, incoming);
  } else {
    if (beforeCount > 0 && incoming.length === 0 && !opts.allowEmptyReplace) {
      // Guard dispara ANTES de tocar manifest ou disco — mesma ordem de
      // `apply-mcp-clicks.ts` (nunca grava estado parcial num caminho de erro).
      throw new EmptyReplaceGuardError(opts.postId, beforeCount);
    }
    records = incoming;
  }

  writeJsonlAtomic(jsonlPath, records);

  const pagesFetched = opts.pagesFetched;
  const totalPages = opts.totalPages;
  let status: "ok" | "partial" =
    pagesFetched != null && totalPages != null && pagesFetched < totalPages ? "partial" : "ok";

  // GUARD (#7197): 0 registros nunca fecha `ok` sem confirmação explícita —
  // ver docstring do arquivo. `records.length` aqui já é o resultado FINAL
  // (pós-merge se `--append`), então cobre tanto REPLACE quanto o caso em
  // que todas as páginas acumuladas via `--append` somaram zero.
  let guardError: string | undefined;
  if (status === "ok" && records.length === 0 && !opts.confirmedEmpty) {
    status = "partial";
    guardError =
      "guard #7197: 0 registros sem --confirmed-empty explícito — nunca ok sem confirmação de que a MCP respondeu vazio de verdade nesta invocação";
  }

  // GUARD (#7197, âncora externa): a MCP NÃO devolve `total_pages` — só
  // `{page, per_page, count}`. O guard de páginas acima, portanto, quase nunca
  // dispara: sem `--total-pages`, `status` já nasce `ok`, e o par
  // `pages_fetched == total_pages` que o manifest registra é auto-satisfeito.
  // Foi assim que 191 de 255 posts fecharam `ok` com uma página só drenada.
  // `--recipients` é a única âncora que vive FORA da drenagem (`stats.email.recipients`
  // do próprio post), então é ela que sabe dizer que faltou gente.
  if (status === "ok" && opts.recipients != null && records.length < opts.recipients) {
    status = "partial";
    guardError = `guard #7197: ${records.length} registros pra um post que alcançou ${opts.recipients} — drenagem truncada; continue paginando (a MCP não informa total_pages)`;
  }

  const manifest = loadManifest(manifestPath);
  // #7418: `confirmed_empty` é um flag NO MANIFEST, não só um gate local de
  // `ok` — `reconcileManifestWithDisk` (checagem 1) rebaixa todo `ok` com 0
  // linhas em disco pra `pending` sem distinguir "nunca tentado" de
  // "confirmado vazio de propósito". Sem gravá-lo, os mesmos posts
  // confirmados vazios piscavam ok→pending a cada auditoria, forçando
  // reprocessamento desnecessário (~90-160k tokens por lote de 8, #7268).
  // Só vale quando o status efetivamente fechou `ok` com 0 registros — um
  // `partial` (paginação truncada) não tem 0 confirmado, tem dado faltando.
  const entry: EngagementManifestEntry = {
    post_id: opts.postId,
    title: opts.title,
    status,
    count: records.length,
    pages_fetched: pagesFetched,
    total_pages: totalPages,
    fetched_at: new Date().toISOString(),
    ...(status === "ok" && records.length === 0 && opts.confirmedEmpty ? { confirmed_empty: true } : {}),
    ...(guardError ? { error: guardError } : {}),
  };
  saveManifestAtomic(manifestPath, upsertEntry(manifest, entry));

  return {
    post_id: opts.postId,
    before_count: beforeCount,
    after_count: records.length,
    status,
    ...(routedClickCount > 0 ? { routed_click_count: routedClickCount } : {}),
    ...(discardedCount > 0 ? { discarded_count: discardedCount } : {}),
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolveP(data));
    process.stdin.on("error", rejectP);
  });
}

function parseIntArg(argv: string[], flag: string): number | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || !argv[idx + 1]) return undefined;
  const n = parseInt(argv[idx + 1], 10);
  return Number.isInteger(n) ? n : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const postIdIdx = argv.indexOf("--post-id");
  if (postIdIdx === -1 || !argv[postIdIdx + 1]) {
    console.error(
      "uso: apply-mcp-subscriber-engagement.ts --post-id post_<uuid> [--title T] " +
        "[--kind engagement|click-subscribers] " +
        "[--pages-fetched N --total-pages M] [--recipients R] [--append] [--allow-empty-replace] [--confirmed-empty] [--out-dir DIR]  (JSON via stdin)",
    );
    process.exit(2);
  }
  const titleIdx = argv.indexOf("--title");
  const outDirIdx = argv.indexOf("--out-dir");
  const kindIdx = argv.indexOf("--kind");
  const kindArg = kindIdx !== -1 ? argv[kindIdx + 1] : undefined;
  if (kindArg !== undefined && kindArg !== "engagement" && kindArg !== "click-subscribers") {
    console.error(`--kind inválido: ${JSON.stringify(kindArg)} — esperado "engagement" ou "click-subscribers"`);
    process.exit(2);
  }

  const opts: ApplyEngagementOpts = {
    postId: argv[postIdIdx + 1],
    title: titleIdx !== -1 ? argv[titleIdx + 1] : undefined,
    kind: kindArg as ApplyEngagementKind | undefined,
    pagesFetched: parseIntArg(argv, "--pages-fetched"),
    totalPages: parseIntArg(argv, "--total-pages"),
    recipients: parseIntArg(argv, "--recipients"),
    allowEmptyReplace: argv.includes(ALLOW_EMPTY_REPLACE_FLAG),
    outDir: outDirIdx !== -1 ? resolve(argv[outDirIdx + 1]) : undefined,
    append: argv.includes("--append"),
    confirmedEmpty: argv.includes("--confirmed-empty"),
  };

  const stdinJson = await readStdin();
  if (!stdinJson.trim()) {
    console.error("stdin vazio — espera JSON da MCP list_post_subscriber_engagement");
    process.exit(2);
  }

  try {
    const result = applyEngagement(stdinJson, opts);
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(e instanceof EmptyReplaceGuardError ? 3 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
