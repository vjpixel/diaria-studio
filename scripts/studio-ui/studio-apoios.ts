/**
 * studio-apoios.ts (#3602 — Studio UI: CRM simples de apoios apoia.se)
 *
 * Camada de leitura/escrita + cruzamento de status pro painel "Apoios" do
 * Studio: base de contatos própria (a apoia.se não tem endpoint de listagem,
 * só consulta por email conhecido — `scripts/lib/apoia-se.ts::checkBacker`,
 * #3500) + status derivado (apoiando / não apoia / apoiou e parou) + tracking
 * de outreach + visão agregada de campanha.
 *
 * Arquivo PRÓPRIO desta fatia (mesma convenção de `studio-review.ts` #3559 /
 * `studio-issues.ts` #3562): `server.ts` só registra rotas, toda a lógica
 * mora aqui.
 *
 * **Dado pessoal (LGPD):** contatos vivem SÓ em `data/apoia-se/contacts.jsonl`
 * (junction OneDrive local, blanket-gitignored — nunca no repo, nunca em KV).
 * O Studio é loopback-only (127.0.0.1) — PII fica na máquina do editor.
 *
 * **Múltiplos emails por contato** (ressalva da issue): a apoia.se casa por
 * email EXATO — `deriveContactStatus` cruza TODOS os emails do contato contra
 * o cache e considera "apoiando" se QUALQUER um bater.
 *
 * **Status "apoiou e parou"**: `checkBacker` só resolve o MÊS CORRENTE (a doc
 * da apoia.se garante estabilidade intra-mês, ver cabeçalho de `apoia-se.ts`).
 * Histórico entre meses vem dos snapshots `{YYYY-MM}.json` que já existem no
 * cache — `readPastMonthSnapshots` lê os arquivos de meses anteriores
 * diretamente (sem nova consulta à API).
 *
 * **Fail-soft**: sem junction `data/`, sem `.env.local` (credenciais
 * apoia.se ausentes), ou falha de auth na API — o painel nunca crasha, só
 * reporta o erro no campo `error` do payload (mesmo padrão de
 * `studio-issues.ts::fetchTriageData`).
 *
 * **Escopo desta entrega** (ver PR body pro incremento anotado): CRUD básico
 * de contato (criar/editar/adicionar email/notas) + registro de outreach +
 * status cruzado + visão de campanha + lista de follow-ups pendentes. Fora
 * de escopo nesta entrega: edição/remoção de eventos de outreach individuais
 * (só append), busca/filtro server-side (a UI filtra client-side sobre o
 * snapshot, mesmo padrão de `triagem.js`).
 *
 * **Taxa de abertura Beehiiv (#3612):** sinal adicional de engajamento,
 * INDEPENDENTE do status de apoio acima — vem de um cache separado
 * (`data/apoia-se/beehiiv-open-rate.json`) populado manualmente por uma
 * sessão com o MCP `claude_ai_Beehiiv` conectado (`get_subscription` só
 * está disponível na sessão top-level interativa, não em subagente
 * headless — não existe REST fallback hoje porque `BEEHIIV_API_KEY` está
 * vazio em `.env`, mesma lacuna de #3580). O painel LÊ desse cache, nunca
 * chama a API Beehiiv ao vivo. `deriveOpenRate` segue o MESMO padrão de
 * `deriveContactStatus`: cruza TODOS os emails do contato contra o cache;
 * aqui, em vez de "qualquer email que bate", usa o email com MAIS
 * `totalDelivered` quando mais de 1 bate. Cache ausente/corrompido/vazio →
 * `openRate: null` em todos os contatos, nunca quebra o painel.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../lib/atomic-write.ts";
import {
  checkBacker,
  readApoiaSeEnv,
  defaultCacheDir,
  competenceMonth,
  ApoiaSeAuthError,
  type ApoiaSeEnv,
  type BackerStatus,
  type CheckBackerOptions,
} from "../lib/apoia-se.ts";

// ── tipos ────────────────────────────────────────────────────────────────

export interface OutreachEvent {
  /** Data do contato, formato YYYY-MM-DD. */
  date: string;
  /** Canal livre (ex: "email", "whatsapp", "linkedin"). */
  channel: string;
  responded: boolean;
  followupPending: boolean;
  note?: string;
}

export interface ApoioContact {
  id: string;
  name: string;
  /** Múltiplos emails — mitiga a ressalva de match exato da apoia.se. */
  emails: string[];
  /** Origem/círculo livre (ex: "lista VJs", "ex-alunos"). */
  circle: string;
  notes: string;
  outreach: OutreachEvent[];
  createdAt: string;
  updatedAt: string;
}

export type BackerStatusLabel = "apoiando" | "nao_apoia" | "apoiou_e_parou" | "sem_dados";

export interface ContactBackerStatus {
  label: BackerStatusLabel;
  /** Presente só quando `label === "apoiando"`. */
  monthlyValue?: number;
  /** Email do contato que casou com o registro apoia.se. */
  matchedEmail?: string;
  /** Mês (YYYY-MM) do último pagamento encontrado — só quando "apoiou_e_parou". */
  lastPaidMonth?: string;
}

export interface CampaignSummary {
  totalContacts: number;
  /** Contatos com ao menos 1 evento de outreach registrado. */
  totalContacted: number;
  /** Contatos com status "apoiando" no mês corrente. */
  totalConverted: number;
  /** Soma de `monthlyValue` de todos os contatos "apoiando". */
  monthlyValueSum: number;
  pendingFollowupsCount: number;
}

export interface PendingFollowup {
  contactId: string;
  name: string;
  circle: string;
  lastOutreachDate: string;
  lastOutreachChannel: string;
}

/** Taxa de abertura/clique histórica (Beehiiv) casada por email — #3612.
 * `null` quando nenhum email do contato está no cache. */
export interface OpenRateInfo {
  subscriptionId: string;
  totalDelivered: number;
  totalUniqueOpened: number;
  openRatePct: number;
  clickRatePct: number;
  fetchedAt: string;
}

/** Cache lido de `data/apoia-se/beehiiv-open-rate.json` — chaves normalizadas
 * (lowercase/trim), mesmo tratamento de `normalizeEmailList`. */
export type OpenRateCache = Record<string, OpenRateInfo>;

export interface ContactWithStatus extends ApoioContact {
  status: ContactBackerStatus;
  /** `null` sempre que o cache está ausente/corrompido ou nenhum email do
   * contato tem entrada nele — independente do status de apoio (#3612). */
  openRate: OpenRateInfo | null;
}

export interface ApoiosData {
  contacts: ContactWithStatus[];
  campaign: CampaignSummary;
  pendingFollowups: PendingFollowup[];
  /** Mensagem de erro (data/ ausente, credenciais ausentes, 401, falha de
   * rede) — nunca impede a resposta, só documenta o motivo de status
   * incompletos/"sem_dados". `null` quando tudo correu bem. */
  error: string | null;
  generatedAt: string;
}

// ── parsing / serialização (puro) ───────────────────────────────────────

function normalizeEmailList(emails: string[] | undefined | null): string[] {
  if (!Array.isArray(emails)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const e = (raw ?? "").trim().toLowerCase();
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Sanitiza 1 entrada crua de outreach lida do jsonl — mesma validação de
 * forma que `appendOutreachEvent` aplica a eventos criados via API. Entradas
 * malformadas (data fora do formato, sem canal) são DESCARTADAS em vez de
 * propagadas cruas — protege `computePendingFollowups`/a UI de um
 * `contacts.jsonl` editado à mão (arquivo pensado pra edição manual, ver
 * doc-comment do módulo) com uma linha corrompida. */
function sanitizeOutreachEntry(raw: unknown): OutreachEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<OutreachEvent>;
  if (typeof r.date !== "string" || !DATE_RE.test(r.date)) return null;
  const channel = typeof r.channel === "string" ? r.channel.trim() : "";
  if (!channel) return null;
  return {
    date: r.date,
    channel,
    responded: r.responded === true,
    followupPending: r.followupPending === true,
    ...(typeof r.note === "string" && r.note.trim() ? { note: r.note.trim() } : {}),
  };
}

/** Parseia `contacts.jsonl` (1 JSON por linha, linhas vazias ignoradas). */
export function parseContactsJsonl(raw: string): ApoioContact[] {
  const contacts: ApoioContact[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as Partial<ApoioContact>;
    contacts.push({
      id: String(parsed.id ?? randomUUID()),
      name: String(parsed.name ?? ""),
      emails: normalizeEmailList(parsed.emails),
      circle: String(parsed.circle ?? ""),
      notes: String(parsed.notes ?? ""),
      outreach: Array.isArray(parsed.outreach)
        ? parsed.outreach.map(sanitizeOutreachEntry).filter((e): e is OutreachEvent => e !== null)
        : [],
      createdAt: String(parsed.createdAt ?? new Date(0).toISOString()),
      updatedAt: String(parsed.updatedAt ?? new Date(0).toISOString()),
    });
  }
  return contacts;
}

export function serializeContactsJsonl(contacts: ApoioContact[]): string {
  if (contacts.length === 0) return "";
  return contacts.map((c) => JSON.stringify(c)).join("\n") + "\n";
}

// ── CRUD puro ────────────────────────────────────────────────────────────

export interface CreateContactInput {
  name: string;
  emails: string[];
  circle?: string;
  notes?: string;
}

export interface CreateContactOptions {
  /** Injetável pra testes determinísticos (default: `randomUUID()`). */
  id?: string;
  now?: Date;
}

export function createContact(input: CreateContactInput, opts: CreateContactOptions = {}): ApoioContact {
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("apoios: campo 'name' é obrigatório");
  const emails = normalizeEmailList(input.emails);
  if (emails.length === 0) throw new Error("apoios: contato precisa de ao menos 1 email em 'emails'");
  const now = opts.now ?? new Date();
  const iso = now.toISOString();
  return {
    id: opts.id ?? randomUUID(),
    name,
    emails,
    circle: (input.circle ?? "").trim(),
    notes: input.notes ?? "",
    outreach: [],
    createdAt: iso,
    updatedAt: iso,
  };
}

export interface UpdateContactPatch {
  name?: string;
  emails?: string[];
  circle?: string;
  notes?: string;
}

/** Aplica um patch parcial a um contato existente — campos omitidos ficam
 * inalterados. Lança se `emails` for passado e resultar em lista vazia
 * (contato sempre precisa de ao menos 1 email). */
export function applyContactUpdate(
  contact: ApoioContact,
  patch: UpdateContactPatch,
  now: Date = new Date(),
): ApoioContact {
  let emails = contact.emails;
  if (patch.emails !== undefined) {
    emails = normalizeEmailList(patch.emails);
    if (emails.length === 0) throw new Error("apoios: contato precisa de ao menos 1 email em 'emails'");
  }
  const name = patch.name !== undefined ? patch.name.trim() : contact.name;
  if (!name) throw new Error("apoios: campo 'name' não pode ficar vazio");
  return {
    ...contact,
    name,
    emails,
    circle: patch.circle !== undefined ? patch.circle.trim() : contact.circle,
    notes: patch.notes !== undefined ? patch.notes : contact.notes,
    updatedAt: now.toISOString(),
  };
}

export interface OutreachEventInput {
  date: string;
  channel: string;
  responded?: boolean;
  followupPending?: boolean;
  note?: string;
}

/** Adiciona um evento de outreach ao histórico do contato (append-only —
 * eventos existentes nunca são editados/removidos nesta entrega). */
export function appendOutreachEvent(
  contact: ApoioContact,
  event: OutreachEventInput,
  now: Date = new Date(),
): ApoioContact {
  if (!DATE_RE.test(event.date ?? "")) {
    throw new Error("apoios: outreach.date precisa ser YYYY-MM-DD");
  }
  const channel = (event.channel ?? "").trim();
  if (!channel) throw new Error("apoios: outreach.channel é obrigatório");
  const entry: OutreachEvent = {
    date: event.date,
    channel,
    responded: event.responded === true,
    followupPending: event.followupPending === true,
    ...(event.note?.trim() ? { note: event.note.trim() } : {}),
  };
  return { ...contact, outreach: [...contact.outreach, entry], updatedAt: now.toISOString() };
}

export function findContact(contacts: ApoioContact[], id: string): ApoioContact | undefined {
  return contacts.find((c) => c.id === id);
}

/** Substitui (por id) ou adiciona um contato à lista — imutável (nova array). */
export function upsertContact(contacts: ApoioContact[], contact: ApoioContact): ApoioContact[] {
  const idx = contacts.findIndex((c) => c.id === contact.id);
  if (idx === -1) return [...contacts, contact];
  const copy = contacts.slice();
  copy[idx] = contact;
  return copy;
}

// ── status derivado (puro) ──────────────────────────────────────────────

export interface MonthSnapshot {
  /** YYYY-MM */
  month: string;
  statuses: Record<string, BackerStatus>;
}

/**
 * Deriva o status de apoio de um contato cruzando TODOS os seus emails
 * contra (a) o status do mês corrente (já resolvido via `checkBacker`) e
 * (b) snapshots de meses anteriores (lidos direto do cache, sem nova
 * consulta). "Apoiando" se QUALQUER email pagou este mês; senão "apoiou e
 * parou" se ALGUM email pagou em QUALQUER mês passado (o mais recente
 * vence); senão "não apoia".
 */
export function deriveContactStatus(
  emails: string[],
  currentMonthStatuses: Record<string, BackerStatus>,
  pastSnapshotsDesc: MonthSnapshot[],
): ContactBackerStatus {
  const normalized = normalizeEmailList(emails);

  for (const email of normalized) {
    const s = currentMonthStatuses[email];
    if (s?.isPaidThisMonth) {
      return { label: "apoiando", monthlyValue: s.thisMonthPaidValue, matchedEmail: email };
    }
  }

  for (const snap of pastSnapshotsDesc) {
    for (const email of normalized) {
      const s = snap.statuses[email];
      if (s?.isPaidThisMonth) {
        return { label: "apoiou_e_parou", lastPaidMonth: snap.month, matchedEmail: email };
      }
    }
  }

  return { label: "nao_apoia" };
}

/**
 * Deriva a taxa de abertura Beehiiv de um contato cruzando TODOS os seus
 * emails contra o cache (#3612). Mesmo padrão de `deriveContactStatus`
 * (cruza múltiplos emails), mas a regra de desempate é diferente: em vez de
 * "qualquer email que bate" (apoia.se, onde só 1 email de cada vez é
 * ativo), aqui MAIS de 1 email pode legitimamente ter histórico de envio
 * Beehiiv (ex: contato trocou de email de assinatura) — usa o que tem MAIS
 * `totalDelivered` (sinal mais robusto/mais amostras). `null` se nenhum
 * email do contato está no cache.
 */
export function deriveOpenRate(contact: ApoioContact, cache: OpenRateCache): OpenRateInfo | null {
  let best: OpenRateInfo | null = null;
  for (const email of normalizeEmailList(contact.emails)) {
    const info = cache[email];
    if (!info) continue;
    if (!best || info.totalDelivered > best.totalDelivered) {
      best = info;
    }
  }
  return best;
}

// ── agregação de campanha (puro) ────────────────────────────────────────

export function emptyCampaignSummary(): CampaignSummary {
  return { totalContacts: 0, totalContacted: 0, totalConverted: 0, monthlyValueSum: 0, pendingFollowupsCount: 0 };
}

/** Follow-up pendente = ÚLTIMO evento de outreach do contato tem
 * `followupPending === true` (eventos são append-only, cronológicos). */
export function computePendingFollowups(contacts: ApoioContact[]): PendingFollowup[] {
  const result: PendingFollowup[] = [];
  for (const c of contacts) {
    if (c.outreach.length === 0) continue;
    const last = c.outreach[c.outreach.length - 1];
    if (last.followupPending) {
      result.push({
        contactId: c.id,
        name: c.name,
        circle: c.circle,
        lastOutreachDate: last.date,
        lastOutreachChannel: last.channel,
      });
    }
  }
  // Mais antigo primeiro — mais urgente pra reabordar.
  result.sort((a, b) => a.lastOutreachDate.localeCompare(b.lastOutreachDate));
  return result;
}

export function computeCampaignSummary(entries: ContactWithStatus[]): CampaignSummary {
  let totalContacted = 0;
  let totalConverted = 0;
  let monthlyValueSum = 0;
  for (const c of entries) {
    if (c.outreach.length > 0) totalContacted++;
    if (c.status.label === "apoiando") {
      totalConverted++;
      monthlyValueSum += c.status.monthlyValue ?? 0;
    }
  }
  return {
    totalContacts: entries.length,
    totalContacted,
    totalConverted,
    monthlyValueSum,
    pendingFollowupsCount: computePendingFollowups(entries).length,
  };
}

// ── I/O: contacts.jsonl ──────────────────────────────────────────────────

export function contactsFilePath(rootDir: string): string {
  return resolve(rootDir, "data", "apoia-se", "contacts.jsonl");
}

/** `null` quando `data/` (junction OneDrive) está presente; mensagem de erro
 * fail-soft caso contrário — distingue "sem contatos ainda" (arquivo
 * ausente, mas `data/` existe) de "sessão sem junction" (#2643 label
 * `local`). */
export function checkDataDirAvailable(rootDir: string): string | null {
  const dataDir = resolve(rootDir, "data");
  if (!existsSync(dataDir)) {
    return "data/ (junction OneDrive) não encontrado nesta sessão — o CRM de Apoios requer sessão local (ver CLAUDE.md #2b / issue #2643).";
  }
  return null;
}

export function loadContacts(rootDir: string): ApoioContact[] {
  const path = contactsFilePath(rootDir);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(`apoios: falha lendo ${path}: ${(e as Error).message}`);
  }
  try {
    return parseContactsJsonl(raw);
  } catch (e) {
    throw new Error(`apoios: ${path} corrompido (JSON inválido em alguma linha): ${(e as Error).message}`);
  }
}

export function saveContacts(rootDir: string, contacts: ApoioContact[]): void {
  const path = contactsFilePath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, serializeContactsJsonl(contacts));
}

// ── I/O: snapshots mensais do cache apoia-se (histórico, sem nova consulta) ─

const MONTH_FILE_RE = /^(\d{4}-\d{2})\.json$/;

/** Lê todos os arquivos `{YYYY-MM}.json` de `cacheDir` EXCETO o mês corrente
 * — usado só pra detectar "apoiou e parou" (nunca dispara consulta nova).
 * Ordenado desc (mês mais recente primeiro). Arquivo corrompido é ignorado
 * (fail-soft por mês, não derruba os demais). */
export function readPastMonthSnapshots(cacheDir: string, currentMonth: string): MonthSnapshot[] {
  if (!existsSync(cacheDir)) return [];
  let files: string[];
  try {
    files = readdirSync(cacheDir);
  } catch {
    return [];
  }
  const snapshots: MonthSnapshot[] = [];
  for (const file of files) {
    const m = MONTH_FILE_RE.exec(file);
    if (!m) continue;
    const month = m[1];
    if (month === currentMonth) continue;
    try {
      const statuses = JSON.parse(readFileSync(resolve(cacheDir, file), "utf-8")) as Record<string, BackerStatus>;
      snapshots.push({ month, statuses });
    } catch {
      // cache de um mês corrompido — ignora esse mês, mantém os outros.
    }
  }
  snapshots.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  return snapshots;
}

// ── I/O: cache de taxa de abertura Beehiiv (leitura fail-soft, #3612) ───

export function openRateCachePath(rootDir: string): string {
  return resolve(rootDir, "data", "apoia-se", "beehiiv-open-rate.json");
}

/** Valida o shape de 1 entrada crua do cache — descarta silenciosamente
 * entradas malformadas (mesmo espírito de `sanitizeOutreachEntry`: o
 * arquivo é populado por um processo externo/manual, nunca confiar cego). */
function sanitizeOpenRateEntry(raw: unknown): OpenRateInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.subscriptionId !== "string" ||
    typeof r.totalDelivered !== "number" ||
    typeof r.totalUniqueOpened !== "number" ||
    typeof r.openRatePct !== "number" ||
    typeof r.clickRatePct !== "number" ||
    typeof r.fetchedAt !== "string"
  ) {
    return null;
  }
  return {
    subscriptionId: r.subscriptionId,
    totalDelivered: r.totalDelivered,
    totalUniqueOpened: r.totalUniqueOpened,
    openRatePct: r.openRatePct,
    clickRatePct: r.clickRatePct,
    fetchedAt: r.fetchedAt,
  };
}

/**
 * Lê `data/apoia-se/beehiiv-open-rate.json` (#3612) — arquivo LOCAL,
 * gitignored, populado manualmente por uma sessão com MCP Beehiiv conectado
 * (ver doc-comment do módulo). Fail-soft total: arquivo ausente, JSON
 * corrompido, shape inesperado, ou entrada individual malformada → nunca
 * lança, na pior hipótese devolve `{}` (todo contato aparece com
 * `openRate: null`). Chaves normalizadas (lowercase/trim) pra casar direto
 * contra `normalizeEmailList`.
 */
export function loadOpenRateCache(rootDir: string): OpenRateCache {
  const path = openRateCachePath(rootDir);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const cache: OpenRateCache = {};
  for (const [rawEmail, value] of Object.entries(raw as Record<string, unknown>)) {
    const email = rawEmail.trim().toLowerCase();
    if (!email) continue;
    const entry = sanitizeOpenRateEntry(value);
    if (entry) cache[email] = entry;
  }
  return cache;
}

// ── I/O: consulta ao vivo do mês corrente (reusa checkBacker) ───────────

export interface FetchCurrentStatusesResult {
  statuses: Record<string, BackerStatus>;
  /** Preenchido só em falha de AUTH (credenciais erradas) — nesse caso a
   * consulta pára cedo (falharia igual pra todo email restante). Falha de
   * rede/API pontual por email é fail-soft silenciosa (email fica sem
   * entrada em `statuses`, contabilizado como "sem_dados" pelo caller). */
  error: string | null;
}

/**
 * Resolve o status do mês corrente pra uma lista de emails, um de cada vez
 * (sequencial — nunca em paralelo). Sequencial é deliberado: `checkBacker`
 * faz load→fetch→save do MESMO arquivo de cache por chamada sem lock; duas
 * chamadas concorrentes pra emails DIFERENTES arriscam uma sobrescrever o
 * write da outra (load antes do save da irmã completar). O rate limit
 * (5 req/s) já é respeitado internamente pelo `RateLimiter` de `checkBacker`
 * — sequencial aqui só evita a race de cache, não duplica o throttle.
 */
export async function fetchCurrentStatuses(
  emails: string[],
  opts: CheckBackerOptions = {},
): Promise<FetchCurrentStatusesResult> {
  const statuses: Record<string, BackerStatus> = {};
  const unique = normalizeEmailList(emails);
  for (const email of unique) {
    try {
      statuses[email] = await checkBacker(email, opts);
    } catch (e) {
      if (e instanceof ApoiaSeAuthError) {
        return { statuses, error: e.message };
      }
      // Falha pontual (rede, API error não-auth) — pula este email, segue os demais.
    }
  }
  return { statuses, error: null };
}

// ── orquestração: monta o payload completo do painel ────────────────────

export interface BuildApoiosDataOptions {
  now?: Date;
  /** Injetável pra testes — evita I/O de `contacts.jsonl` real. */
  contacts?: ApoioContact[];
  /** Injetável pra testes — evita ler `.env.local` real. */
  env?: ApoiaSeEnv;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  limiter?: CheckBackerOptions["limiter"];
  /** Injetável pra testes — evita I/O de `beehiiv-open-rate.json` real
   * (#3612). Default: `loadOpenRateCache(rootDir)`. */
  openRateCache?: OpenRateCache;
}

function toSemDados(contacts: ApoioContact[], openRateCache: OpenRateCache): ContactWithStatus[] {
  return contacts.map((c) => ({ ...c, status: { label: "sem_dados" as const }, openRate: deriveOpenRate(c, openRateCache) }));
}

/**
 * Monta o snapshot completo pro painel "Apoios": contatos + status cruzado +
 * agregação de campanha + follow-ups pendentes. Fail-soft em 3 camadas
 * (nunca lança): (1) `data/` ausente, (2) credenciais apoia.se ausentes,
 * (3) 401 da API — em qualquer uma, contatos aparecem com status "sem_dados"
 * e o campo `error` documenta o motivo.
 */
export async function buildApoiosData(rootDir: string, opts: BuildApoiosDataOptions = {}): Promise<ApoiosData> {
  const now = opts.now ?? new Date();
  const generatedAt = now.toISOString();

  if (!opts.contacts) {
    const dataDirError = checkDataDirAvailable(rootDir);
    if (dataDirError) {
      return { contacts: [], campaign: emptyCampaignSummary(), pendingFollowups: [], error: dataDirError, generatedAt };
    }
  }

  let contacts: ApoioContact[];
  try {
    contacts = opts.contacts ?? loadContacts(rootDir);
  } catch (e) {
    return { contacts: [], campaign: emptyCampaignSummary(), pendingFollowups: [], error: (e as Error).message, generatedAt };
  }

  // Taxa de abertura Beehiiv (#3612) é um sinal INDEPENDENTE do status de
  // apoio apoia.se — carregado cedo, antes do gate de credenciais abaixo,
  // pra aparecer em TODOS os caminhos de retorno (inclusive quando as
  // credenciais apoia.se estão ausentes).
  const openRateCache = opts.openRateCache ?? loadOpenRateCache(rootDir);

  let env: ApoiaSeEnv;
  try {
    env = opts.env ?? readApoiaSeEnv();
  } catch (e) {
    const withStatus = toSemDados(contacts, openRateCache);
    return {
      contacts: withStatus,
      campaign: computeCampaignSummary(withStatus),
      pendingFollowups: computePendingFollowups(contacts),
      error: (e as Error).message,
      generatedAt,
    };
  }

  const allEmails = contacts.flatMap((c) => c.emails);
  const cacheDir = opts.cacheDir ?? defaultCacheDir(env.campaign);
  const currentMonth = competenceMonth(now);

  const { statuses: currentStatuses, error: fetchError } = await fetchCurrentStatuses(allEmails, {
    env,
    cacheDir,
    now,
    fetchImpl: opts.fetchImpl,
    limiter: opts.limiter,
  });
  const pastSnapshots = readPastMonthSnapshots(cacheDir, currentMonth);

  // Emails que de fato receberam uma resposta definitiva de `checkBacker`
  // (achou pagando OU achou não-pagando/não encontrado — `checkBacker`
  // sempre devolve um `BackerStatus` em caso de sucesso). Um email do
  // contato AUSENTE daqui não foi resolvido — seja por parada antecipada em
  // `ApoiaSeAuthError` (emails após o ponto de falha nunca chegam a ser
  // tentados) seja por uma falha pontual (rede/API) que `fetchCurrentStatuses`
  // engole silenciosamente por email. Usado abaixo pra NUNCA rotular como
  // "não apoia" um contato cujo email do mês corrente ficou genuinamente
  // desconhecido — a alternativa (deixar cair em "nao_apoia") mascararia uma
  // falha de checagem como uma negativa definitiva (mesma armadilha que a
  // regra #573 do CLAUDE.md endereça pra estado externo ambíguo).
  const resolvedEmails = new Set(Object.keys(currentStatuses));

  const withStatus: ContactWithStatus[] = contacts.map((c) => {
    const status = deriveContactStatus(c.emails, currentStatuses, pastSnapshots);
    if (status.label === "nao_apoia") {
      const hasUnresolvedEmail = normalizeEmailList(c.emails).some((e) => !resolvedEmails.has(e));
      if (hasUnresolvedEmail) {
        return { ...c, status: { label: "sem_dados" }, openRate: deriveOpenRate(c, openRateCache) };
      }
    }
    return { ...c, status, openRate: deriveOpenRate(c, openRateCache) };
  });

  return {
    contacts: withStatus,
    campaign: computeCampaignSummary(withStatus),
    pendingFollowups: computePendingFollowups(contacts),
    error: fetchError,
    generatedAt,
  };
}

// ── orquestração: mutações (I/O read-modify-write do jsonl) ─────────────

export type ApoiosMutationResult =
  | { ok: true; contact: ApoioContact }
  | { ok: false; error: string };

export function addContact(rootDir: string, input: CreateContactInput): ApoiosMutationResult {
  try {
    const contacts = loadContacts(rootDir);
    const contact = createContact(input);
    saveContacts(rootDir, upsertContact(contacts, contact));
    return { ok: true, contact };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function updateContactById(rootDir: string, id: string, patch: UpdateContactPatch): ApoiosMutationResult {
  try {
    const contacts = loadContacts(rootDir);
    const existing = findContact(contacts, id);
    if (!existing) return { ok: false, error: `apoios: contato ${id} não encontrado` };
    const updated = applyContactUpdate(existing, patch);
    saveContacts(rootDir, upsertContact(contacts, updated));
    return { ok: true, contact: updated };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function addOutreachToContact(rootDir: string, id: string, event: OutreachEventInput): ApoiosMutationResult {
  try {
    const contacts = loadContacts(rootDir);
    const existing = findContact(contacts, id);
    if (!existing) return { ok: false, error: `apoios: contato ${id} não encontrado` };
    const updated = appendOutreachEvent(existing, event);
    saveContacts(rootDir, upsertContact(contacts, updated));
    return { ok: true, contact: updated };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── parsing de corpo de request (puro, usado pelos handlers em server.ts) ─

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseCreateContactBody(raw: string): ParseResult<CreateContactInput> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "corpo da request precisa ser JSON válido" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || !b.name.trim()) {
    return { ok: false, error: "campo 'name' (string não-vazia) é obrigatório" };
  }
  if (!Array.isArray(b.emails) || b.emails.length === 0 || !b.emails.every((e) => typeof e === "string")) {
    return { ok: false, error: "campo 'emails' (array de strings, ao menos 1) é obrigatório" };
  }
  return {
    ok: true,
    value: {
      name: b.name,
      emails: b.emails as string[],
      circle: typeof b.circle === "string" ? b.circle : undefined,
      notes: typeof b.notes === "string" ? b.notes : undefined,
    },
  };
}

export function parseUpdateContactBody(raw: string): ParseResult<UpdateContactPatch> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "corpo da request precisa ser JSON válido" };
  }
  const b = body as Record<string, unknown>;
  const patch: UpdateContactPatch = {};
  if (b.name !== undefined) {
    if (typeof b.name !== "string") return { ok: false, error: "'name' precisa ser string" };
    patch.name = b.name;
  }
  if (b.emails !== undefined) {
    if (!Array.isArray(b.emails) || !b.emails.every((e) => typeof e === "string")) {
      return { ok: false, error: "'emails' precisa ser array de strings" };
    }
    patch.emails = b.emails as string[];
  }
  if (b.circle !== undefined) {
    if (typeof b.circle !== "string") return { ok: false, error: "'circle' precisa ser string" };
    patch.circle = b.circle;
  }
  if (b.notes !== undefined) {
    if (typeof b.notes !== "string") return { ok: false, error: "'notes' precisa ser string" };
    patch.notes = b.notes;
  }
  return { ok: true, value: patch };
}

export function parseOutreachEventBody(raw: string): ParseResult<OutreachEventInput> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "corpo da request precisa ser JSON válido" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.date !== "string" || !DATE_RE.test(b.date)) {
    return { ok: false, error: "campo 'date' (YYYY-MM-DD) é obrigatório" };
  }
  if (typeof b.channel !== "string" || !b.channel.trim()) {
    return { ok: false, error: "campo 'channel' (string não-vazia) é obrigatório" };
  }
  return {
    ok: true,
    value: {
      date: b.date,
      channel: b.channel,
      responded: b.responded === true,
      followupPending: b.followupPending === true,
      note: typeof b.note === "string" ? b.note : undefined,
    },
  };
}
