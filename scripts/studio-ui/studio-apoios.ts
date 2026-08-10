/**
 * studio-apoios.ts (#3602 — Studio UI: CRM simples de apoios apoia.se)
 *
 * Camada de leitura/escrita + cruzamento de status pro painel "Apoios" do
 * Studio: base de contatos própria (a apoia.se não tem endpoint de listagem,
 * só consulta por email conhecido — `scripts/lib/apoia-se.ts::checkBacker`,
 * #3500) + status derivado (apoiando / não apoia / apoiou e parou) + visão
 * agregada de campanha.
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
 * **Fail-soft**: sem junction `data/`, sem `.env` (credenciais
 * apoia.se ausentes), ou falha de auth na API — o painel nunca crasha, só
 * reporta o erro no campo `error` do payload (mesmo padrão de
 * `studio-issues.ts::fetchTriageData`).
 *
 * **Follow-up/outreach removido (#3844, decisão do editor 260721):** a
 * maquinaria de acompanhamento de contato (`OutreachEvent`, `PendingFollowup`,
 * `appendOutreachEvent`, `computePendingFollowups`, o campo `outreach[]` do
 * contato) foi retirada — a área refoca em saber quem está em cada grupo
 * (nível de recompensa), não em lembrar de fazer follow-up. Eventos de
 * outreach já gravados em `contacts.jsonl` são dado LEGADO, deixado quieto —
 * mesma disciplina do campo `circle` deprecado (#3611): `parseContactsJsonl`
 * simplesmente não lê o campo, e ele nunca é reintroduzido num roundtrip.
 * **Visão por grupo/nível de recompensa (#3844 PARTE 2, decisão do editor
 * 260722)** — `computeRewardGroup`/`computeRewardGroups` particionam o
 * `monthlyValue` do mês corrente (já resolvido acima, sem chamada nova à
 * API) nas 4 faixas confirmadas ao vivo na página real da campanha
 * (Amigo/Apoiador/Mantenedor/Patrono). `ApoiosData.rewardGroups` reusa o
 * mesmo `ContactWithStatus[]` já montado por `buildApoiosData`/
 * `refreshApoiosData` — nenhuma nova chamada de rede ou store separado.
 *
 * **Escopo atual** (ver PR body pro incremento anotado): editar contato
 * (nome/email/notas) via HTTP + criação SÓ in-process (drain de e-mail
 * #3859 — cadastro manual saiu no #3862) + status cruzado + visão de
 * campanha + visão por grupo/nível de recompensa. Fora de escopo:
 * busca/filtro server-side (a UI filtra client-side sobre o snapshot, mesmo
 * padrão de `triagem.js`).
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
 *
 * **Botão "Atualizar status" — force-refresh (#3859, metade 2):**
 * `refreshApoiosData` é a contraparte de `buildApoiosData` usada pelo botão
 * "Atualizar status" do painel — re-consulta o mês corrente na apoia.se com
 * `forceRefresh` (`apoia-se.ts`), mas SÓ para contatos que uma leitura
 * network-free do cache (`readMonthCache`) já mostra como NÃO confirmados
 * ("apoiando") — contatos já confirmados nunca são re-tocados, protegendo o
 * teto de 5.000 req/mês da apoia.se. Cobre o cenário da issue: apoiador que
 * paga dia 15 continuaria com o `false` gravado no dia 1º até a virada do
 * mês sem esse force-refresh seletivo.
 *
 * **Import automático via e-mail (#3859, metade 1):** o bloqueio original
 * ("studio-server headless sem acesso a Gmail") era falso — o projeto já
 * tem um caminho REST não-MCP pro Gmail (`scripts/google-auth.ts::gFetch` +
 * `data/.credentials.json`), usado por `scripts/inbox-drain.ts` pro inbox
 * editorial. `refreshApoiosData` roda esse drain (`scripts/lib/apoia-se-gmail-drain.ts`)
 * ANTES do force-refresh de pagamento acima: busca notificações "novo apoio"
 * do Gmail pessoal desde o último cursor (`data/apoia-se/gmail-drain-cursor.json`),
 * e para cada `{name, email, value}` novo, cria um contato
 * (`createContact` + `notes: "importado automaticamente via e-mail
 * apoia.se"`) SE nenhum contato existente já tiver aquele email — nunca
 * duplica. Fail-soft: falha do drain (token expirado, rede) não trava o
 * force-refresh de pagamento — só registra em `error` (sem sobrescrever um
 * erro mais crítico de credenciais/auth apoia.se, se houver).
 *
 * **Promessas viram contato PENDENTE (#3912):** a apoia.se manda um e-mail
 * separado quando alguém PROMETE um apoio (ainda sem pagar) e, se essa
 * promessa depois converter em pagamento, **não reenvia** um e-mail de "novo
 * apoio" — o drain acima nunca criaria o contato, e o apoiador ficaria
 * invisível no CRM mesmo pagando (caso comprovado: Ivan, 260722). Fix:
 * `refreshApoiosData` também importa `drainResult.promessas` (mesma busca
 * Gmail do drain acima, template de corpo diferente — ver
 * `parsePromessaEmail`) via `importPendingApoiadoresFromGmail`, criando um
 * contato com `notes` indicando "promessa" + valor + data, SEM assumir
 * pagamento — quem decide se de fato converteu continua sendo `checkBacker`
 * (fase 2 do force-refresh abaixo, que roda logo em seguida e trata esse
 * contato novo como não-confirmado, então já tenta resolvê-lo no mesmo
 * refresh). Dedup idêntico ao de apoio confirmado: contato cujo email já
 * existe (de qualquer origem — cadastro manual, import anterior, ou o import
 * de confirmado que acabou de rodar acima) nunca gera duplicata.
 *
 * **Mensagens não-parseadas nunca somem caladas (#4171):** uma mensagem que
 * casa a query do Gmail mas não bate nenhum dos 2 templates de corpo (ex:
 * template mudou de novo) é contada em `drainResult.unparsed` e seu
 * messageId vai pra `data/apoia-se/unparsed-quarantine.jsonl` — o cursor
 * avança por cima dela do mesmo jeito (não trava o drain), mas o contador
 * aparece em `error` (mesmo canal fail-soft acima) pra o editor perceber que
 * algo chegou e não foi entendido. Mesmo tratamento pra `drainResult.errors`
 * (threads que falharam ao carregar), que antes deste fix também nunca
 * chegava ao payload do refresh.
 *
 * **Grupo "ainda não pagou esse mês" + valor/nível/segmentos no card (#4437):**
 * a Visão por grupo só listava `status.label === "apoiando"` — quem apoia há
 * meses mas ainda não teve a cobrança do mês corrente processada
 * desaparecia da visão (medido em produção 260801, dia 1º: 0 apoiadores).
 * `computeRewardGroups` ganhou um 5º grupo, `nao_pagou_ainda`: contato
 * "apoiou_e_parou" cujo `lastPaidMonth` seja EXATAMENTE o mês anterior ao
 * corrente (carência de 1 mês — reusa `previousMonthKey` de
 * `sync-apoio-nivel-beehiiv.ts`/#4436, sem reimplementar a lógica de
 * virada de ano). `deriveContactStatus` agora propaga `lastPaidValue`/
 * `lastPaidLevel` (valor + nível do último pagamento) pra esse grupo poder
 * mostrar "o nível que a pessoa tinha", sem chamada de rede nova (o valor já
 * está no snapshot lido por `readPastMonthSnapshots`). Cada
 * `ContactWithStatus` também ganhou `rewardLevel` (nível vigente pra badge no
 * card de Contatos, via `computeContactRewardLevel` — mesmo critério do
 * grupo, mas por contato) e `segments` (segmentos Beehiiv `Apoio — *`, lidos
 * fail-soft de `data/apoia-se/beehiiv-segments.json` via `deriveSegments` —
 * MESMO padrão dos outros 2 caches Beehiiv deste módulo, populado por
 * `scripts/sync-apoio-segments-beehiiv.ts`). `segments: null` = "nunca
 * consultado" (cache ausente/sem match), distinto de `{ segments: [], ... }`
 * = "consultado, nenhum segmento" — nunca confundir com "fora da base".
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
  readMonthCache,
  ApoiaSeAuthError,
  type ApoiaSeEnv,
  type BackerStatus,
  type CheckBackerOptions,
} from "../lib/apoia-se.ts";
import { previousMonthKey } from "../lib/apoio-month-key.ts";
import {
  drainApoiaSeNotifications,
  type ApoioNotification,
  type DrainedPromessa,
  type DrainApoiaSeResult,
} from "../lib/apoia-se-gmail-drain.ts";

// ── tipos ────────────────────────────────────────────────────────────────

export interface ApoioContact {
  id: string;
  name: string;
  /** Múltiplos emails — mitiga a ressalva de match exato da apoia.se. */
  emails: string[];
  notes: string;
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
  /** #4437: valor pago em `lastPaidMonth` — só quando "apoiou_e_parou".
   * Alimenta o grupo "ainda não pagou esse mês" (Entrega 1) e o valor
   * mostrado no card de Contatos pra quem está fora do mês corrente
   * (Entrega 2), sem precisar de nova consulta (já vem do snapshot lido por
   * `readPastMonthSnapshots`). */
  lastPaidValue?: number;
  /** #4437: nível de recompensa correspondente a `lastPaidValue`, via
   * `computeRewardGroup` — zero cálculo novo no client. `null`/ausente
   * quando `lastPaidValue` é indefinido ou abaixo do piso de R$5. */
  lastPaidLevel?: RewardGroup | null;
}

export interface CampaignSummary {
  totalContacts: number;
  /** Contatos com status "apoiando" no mês corrente. */
  totalConverted: number;
  /** Soma de `monthlyValue` de todos os contatos "apoiando". */
  monthlyValueSum: number;
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

/** Confirmação de vínculo Beehiiv (#4273 parte 3 — a pessoa é assinante
 * Beehiiv ou não). `status` reflete o `status` da subscription na Beehiiv
 * (`active`/`pending`/etc), `null` quando `hasVinculo: false`. */
export interface VinculoInfo {
  hasVinculo: boolean;
  subscriptionId: string | null;
  status: string | null;
  fetchedAt: string;
}

/** Cache lido de `data/apoia-se/beehiiv-vinculo.json` — chaves normalizadas
 * (lowercase/trim), mesmo tratamento de `normalizeEmailList`. Populado
 * manualmente por uma sessão top-level com MCP Beehiiv conectado (mesmo
 * mecanismo do `OpenRateCache` acima, #3612) — o painel só LÊ, nunca chama a
 * API Beehiiv ao vivo. */
export type VinculoCache = Record<string, VinculoInfo>;

/** Segmentos Beehiiv `Apoio — *` em que um assinante está (#4437 Entrega 2).
 * Derivado do custom field `apoio_nivel` (mesmo campo de
 * `sync-apoio-nivel-beehiiv.ts`) — não há endpoint de membership dedicado,
 * ver `scripts/sync-apoio-segments-beehiiv.ts`, que popula o cache. */
export interface SegmentsInfo {
  /** Nomes dos segmentos `Apoio — *` casados (0 ou mais). Array vazio =
   * "consultado, mas em nenhum segmento" — distinto de `segments: null` no
   * `ContactWithStatus` (que significa "nunca consultado"). */
  segments: string[];
  /** Valor do custom field `apoio_nivel` na Beehiiv no momento da consulta —
   * `""` quando ausente/vazio. Exposto pra o editor comparar contra o nível
   * calculado localmente (apoia.se) e notar divergência (sync #4436 nunca
   * rodou `--push` ao vivo, por exemplo). */
  apoioNivel: string;
  checkedAt: string;
}

/** Cache lido de `data/apoia-se/beehiiv-segments.json` — chaves normalizadas
 * (lowercase/trim), mesmo tratamento de `normalizeEmailList`. Populado por
 * `scripts/sync-apoio-segments-beehiiv.ts` (leitura paginada de
 * `/subscriptions`, nunca escreve na Beehiiv) — o painel só LÊ. */
export type SegmentsCache = Record<string, SegmentsInfo>;

export interface ContactWithStatus extends ApoioContact {
  status: ContactBackerStatus;
  /** `null` sempre que o cache está ausente/corrompido ou nenhum email do
   * contato tem entrada nele — independente do status de apoio (#3612). */
  openRate: OpenRateInfo | null;
  /** Confirmação de vínculo Beehiiv (#4273 parte 3). `null` quando NENHUM
   * email do contato aparece no cache (nunca consultado — não confundir com
   * `{ hasVinculo: false, ... }`, que significa "consultado, sem vínculo"). */
  vinculo: VinculoInfo | null;
  /** #4437 Entrega 2: nível de recompensa pra badge no card de Contatos —
   * `computeContactRewardLevel(status, currentMonth)`, MESMO critério de
   * `computeRewardGroups` (mês corrente pra "apoiando", mês anterior DENTRO
   * DA CARÊNCIA pra "apoiou_e_parou"). `null` quando não há valor aplicável
   * (nao_apoia/sem_dados/apoiou_e_parou fora da carência) — nunca um badge
   * inventado. */
  rewardLevel: RewardGroup | null;
  /** #4437 Entrega 2: segmentos Beehiiv do contato. `null` = "nunca
   * consultado" (cache ausente ou nenhum email do contato no cache) —
   * visualmente distinto de `{ segments: [], ... }` = "consultado, nenhum
   * segmento". Ver `deriveSegments`. */
  segments: SegmentsInfo | null;
}

export interface ApoiosData {
  contacts: ContactWithStatus[];
  campaign: CampaignSummary;
  /** Visão por grupo/nível de recompensa do mês corrente (#3844 parte 2). */
  rewardGroups: RewardGroupsView;
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

/** Parseia `contacts.jsonl` (1 JSON por linha, linhas vazias ignoradas).
 *
 * Compat (#3611): linhas legadas podem trazer um campo `circle` (removido
 * do schema) — `Partial<ApoioContact>` já não o tipa, e como o objeto
 * resultante só copia os campos abaixo, `circle` simplesmente nunca é lido
 * nem propagado. Nunca quebra o parse.
 *
 * Compat (#3844): mesma disciplina pro campo `outreach` (removido do schema
 * junto com toda a maquinaria de follow-up/outreach) — linhas legadas que
 * ainda trazem `outreach[]` no `contacts.jsonl` real não quebram o parse, o
 * campo simplesmente nunca é lido nem propagado num roundtrip. O dado
 * histórico fica quieto no arquivo (nunca apagado por este código). */
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
      notes: String(parsed.notes ?? ""),
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
    notes: input.notes ?? "",
    createdAt: iso,
    updatedAt: iso,
  };
}

export interface UpdateContactPatch {
  name?: string;
  emails?: string[];
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
    notes: patch.notes !== undefined ? patch.notes : contact.notes,
    updatedAt: now.toISOString(),
  };
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

/**
 * Aplica notificações "novo apoio" (já drenadas + parseadas do Gmail, #3859
 * metade 1) sobre a lista de contatos: cria 1 contato novo por notificação
 * cujo email NÃO bate com nenhum email já cadastrado em NENHUM contato —
 * notificações cujo email já existe são ignoradas (nunca duplica, mesmo se
 * a mesma pessoa aparecer 2x na mesma leva de notificações). Pure — sem I/O;
 * o caller decide se/quando persistir com `saveContacts`.
 */
export function importNewApoiadoresFromGmail(
  contacts: ApoioContact[],
  notifications: ApoioNotification[],
): { contacts: ApoioContact[]; mutated: boolean; imported: number } {
  let result = contacts;
  let imported = 0;
  for (const notif of notifications) {
    const email = notif.email.trim().toLowerCase();
    if (!email) continue;
    const alreadyExists = result.some((c) => normalizeEmailList(c.emails).includes(email));
    if (alreadyExists) continue;
    const created = createContact({
      name: notif.name,
      emails: [email],
      notes: "importado automaticamente via e-mail apoia.se",
    });
    result = upsertContact(result, created);
    imported++;
  }
  return { contacts: result, mutated: imported > 0, imported };
}

/** `YYYY-MM-DD...` (ISO 8601 UTC) -> `DD/MM`. Extração direta da string (sem
 * `Date`/timezone) — determinístico e suficiente pro propósito informativo
 * da nota (#3912). Fallback: devolve o ISO cru se o formato for inesperado
 * (nunca lança). */
function formatDDMM(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[2]}/${m[1]}`;
}

/**
 * Aplica notificações de PROMESSA (ainda não pagas, #3912) sobre a lista de
 * contatos: cria 1 contato PENDENTE por promessa cujo email NÃO bate com
 * nenhum email já cadastrado em NENHUM contato — mesma disciplina de dedup
 * de `importNewApoiadoresFromGmail` (nunca duplica, inclusive entre 2
 * promessas do mesmo email na mesma leva). O contato criado NUNCA é marcado
 * como "apoiando" aqui — só `deriveContactStatus` (via `checkBacker`) decide
 * isso, a cada refresh; esta função só garante que o contato EXISTE pra
 * `checkBacker` ter a chance de encontrá-lo. Pure — sem I/O; o caller decide
 * se/quando persistir com `saveContacts`.
 */
export function importPendingApoiadoresFromGmail(
  contacts: ApoioContact[],
  promessas: DrainedPromessa[],
): { contacts: ApoioContact[]; mutated: boolean; imported: number } {
  let result = contacts;
  let imported = 0;
  for (const promessa of promessas) {
    const email = promessa.email.trim().toLowerCase();
    if (!email) continue;
    const alreadyExists = result.some((c) => normalizeEmailList(c.emails).includes(email));
    if (alreadyExists) continue;
    const created = createContact({
      name: promessa.name,
      emails: [email],
      notes: `promessa de R$${promessa.value.toFixed(2).replace(".", ",")} em ${formatDDMM(promessa.receivedAtIso)} — aguardando confirmação de pagamento`,
    });
    result = upsertContact(result, created);
    imported++;
  }
  return { contacts: result, mutated: imported > 0, imported };
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
        // #4437: propaga o valor pago naquele mês + o nível correspondente —
        // alimenta o grupo "ainda não pagou esse mês" (Entrega 1) e o valor/
        // badge do card de Contatos (Entrega 2), sem chamada de rede nova
        // (o valor já está no snapshot lido por `readPastMonthSnapshots`).
        return {
          label: "apoiou_e_parou",
          lastPaidMonth: snap.month,
          matchedEmail: email,
          lastPaidValue: s.thisMonthPaidValue,
          lastPaidLevel: computeRewardGroup(s.thisMonthPaidValue),
        };
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

/**
 * Deriva a confirmação de vínculo Beehiiv de um contato cruzando TODOS os
 * seus emails contra o cache (#4273 parte 3). Diferente de `deriveOpenRate`
 * (que escolhe o email de MAIOR `totalDelivered` em caso de múltiplos hits),
 * aqui basta 1 email do contato ter `hasVinculo: true` no cache — a pessoa
 * pode ter assinado a newsletter com um email diferente do que usa pra pagar
 * o apoio. `null` quando NENHUM email do contato aparece no cache (nunca
 * consultado); `{ hasVinculo: false, ... }` quando algum email foi
 * consultado mas nenhum tem vínculo confirmado.
 */
export function deriveVinculo(contact: ApoioContact, cache: VinculoCache): VinculoInfo | null {
  let fallback: VinculoInfo | null = null;
  for (const email of normalizeEmailList(contact.emails)) {
    const info = cache[email];
    if (!info) continue;
    if (info.hasVinculo) return info;
    if (!fallback) fallback = info;
  }
  return fallback;
}

/**
 * Deriva os segmentos Beehiiv de um contato cruzando TODOS os seus emails
 * contra o cache (#4437 Entrega 2). Mais simples que `deriveVinculo`/
 * `deriveOpenRate` (que têm critério de desempate entre múltiplos hits) — não
 * há um "melhor" match aqui, o primeiro email do contato encontrado no cache
 * decide. `null` quando NENHUM email do contato aparece no cache (nunca
 * consultado — não confundir com `{ segments: [], ... }`, que significa
 * "consultado, nenhum segmento Apoio — * encontrado").
 */
export function deriveSegments(contact: ApoioContact, cache: SegmentsCache): SegmentsInfo | null {
  for (const email of normalizeEmailList(contact.emails)) {
    const info = cache[email];
    if (info) return info;
  }
  return null;
}

// ── agregação de campanha (puro) ────────────────────────────────────────

export function emptyCampaignSummary(): CampaignSummary {
  return { totalContacts: 0, totalConverted: 0, monthlyValueSum: 0 };
}

export function computeCampaignSummary(entries: ContactWithStatus[]): CampaignSummary {
  let totalConverted = 0;
  let monthlyValueSum = 0;
  for (const c of entries) {
    if (c.status.label === "apoiando") {
      totalConverted++;
      monthlyValueSum += c.status.monthlyValue ?? 0;
    }
  }
  return {
    totalContacts: entries.length,
    totalConverted,
    monthlyValueSum,
  };
}

// ── visão por grupo / nível de recompensa (#3844 parte 2) ──────────────

export type RewardGroup = "amigo" | "apoiador" | "mantenedor" | "patrono";

/**
 * Limiares valor (R$) → nível de recompensa — decisão do editor confirmada
 * ao vivo na página real da campanha (https://apoia.se/diaria, 260722, ver
 * corpo do PR/issue #3844 pra tabela completa de benefícios por nível).
 * Regra de atribuição: MAIOR faixa cujo limiar ≤ valor. Patrono é o teto
 * (não há nível acima).
 */
const REWARD_TIER_AMIGO_MIN = 5;
const REWARD_TIER_APOIADOR_MIN = 10;
const REWARD_TIER_MANTENEDOR_MIN = 25;
const REWARD_TIER_PATRONO_MIN = 50;

/**
 * Particiona um valor pago no mês nas faixas de nível de recompensa acima.
 * `undefined`/valor abaixo de `REWARD_TIER_AMIGO_MIN` (inclui negativo,
 * defensivamente) → `null`, sem nenhum grupo pago.
 */
export function computeRewardGroup(thisMonthPaidValue: number | undefined): RewardGroup | null {
  if (typeof thisMonthPaidValue !== "number" || !Number.isFinite(thisMonthPaidValue)) return null;
  if (thisMonthPaidValue < REWARD_TIER_AMIGO_MIN) return null;
  if (thisMonthPaidValue < REWARD_TIER_APOIADOR_MIN) return "amigo";
  if (thisMonthPaidValue < REWARD_TIER_MANTENEDOR_MIN) return "apoiador";
  if (thisMonthPaidValue < REWARD_TIER_PATRONO_MIN) return "mantenedor";
  return "patrono";
}

export interface RewardGroupsView {
  amigo: ContactWithStatus[];
  apoiador: ContactWithStatus[];
  mantenedor: ContactWithStatus[];
  patrono: ContactWithStatus[];
  /** #4437 Entrega 1: "ainda não pagou esse mês" — contato cujo ÚLTIMO
   * pagamento foi o mês IMEDIATAMENTE anterior ao corrente (carência de 1
   * mês, mesmo `previousMonthKey` de `sync-apoio-nivel-beehiiv.ts`/#4436).
   * Distinto de churn real (2+ meses sem pagar, que fica de fora de todo
   * grupo, igual antes desta issue). NÃO é uma faixa de valor — é um estado
   * de cobrança, por isso é um array só (não particionado por nível); o
   * nível que a pessoa tinha vem em `status.lastPaidLevel`/`rewardLevel` de
   * cada contato. Renderizado por último (`REWARD_GROUP_ORDER` no client). */
  nao_pagou_ainda: ContactWithStatus[];
}

export function emptyRewardGroupsView(): RewardGroupsView {
  return { amigo: [], apoiador: [], mantenedor: [], patrono: [], nao_pagou_ainda: [] };
}

/**
 * Pure (#4437 Entrega 2): nível de recompensa "vigente" de um contato pra
 * fins de badge no card de Contatos — MESMO critério usado por
 * `computeRewardGroups` pra decidir em qual grupo/se-entra-em-algum-grupo o
 * contato cai, mas por contato em vez de por bucket (útil pro card
 * individual, que não pertence a um `RewardGroupsView`). `apoiando` usa o
 * valor do mês corrente; `apoiou_e_parou` só conta DENTRO da carência de 1
 * mês (`lastPaidMonth === previousMonthKey(currentMonth)`) — fora da
 * carência é churn real, sem nível vigente. Qualquer outro label
 * (`nao_apoia`/`sem_dados`) nunca tem nível — nunca um badge inventado.
 */
export function computeContactRewardLevel(status: ContactBackerStatus, currentMonth: string): RewardGroup | null {
  if (status.label === "apoiando") return computeRewardGroup(status.monthlyValue);
  if (status.label === "apoiou_e_parou" && status.lastPaidMonth === previousMonthKey(currentMonth)) {
    return computeRewardGroup(status.lastPaidValue);
  }
  return null;
}

/**
 * Agrega contatos por nível de recompensa do mês corrente pra exibição no
 * painel Apoios (#3844 parte 2), mais o grupo "ainda não pagou esse mês"
 * (#4437 Entrega 1). Contatos "apoiando" entram numa das 4 faixas por
 * `computeRewardGroup(monthlyValue)`; contatos "apoiou_e_parou" cujo
 * `lastPaidMonth` seja EXATAMENTE o mês anterior ao corrente entram em
 * `nao_pagou_ainda` (carência de 1 mês — mais antigo que isso é churn real,
 * fica de fora de todo grupo, igual antes desta issue). `sem_dados`/
 * `nao_apoia` nunca entram em grupo algum. Um contato com valor abaixo de
 * R$5 (fora do intervalo hoje, mas defensivo) também fica de fora da faixa
 * paga — reflete `computeRewardGroup` retornando `null`.
 */
export function computeRewardGroups(contacts: ContactWithStatus[], currentMonth: string): RewardGroupsView {
  const view = emptyRewardGroupsView();
  const previousMonth = previousMonthKey(currentMonth);
  for (const c of contacts) {
    if (c.status.label === "apoiando") {
      const group = computeRewardGroup(c.status.monthlyValue);
      if (group) view[group].push(c);
      continue;
    }
    if (c.status.label === "apoiou_e_parou" && c.status.lastPaidMonth === previousMonth) {
      view.nao_pagou_ainda.push(c);
    }
  }
  return view;
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
 * entradas malformadas (o arquivo é populado por um processo externo/manual,
 * nunca confiar cego). */
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

// ── I/O: cache de vínculo Beehiiv (leitura fail-soft, #4273 parte 3) ────

export function vinculoCachePath(rootDir: string): string {
  return resolve(rootDir, "data", "apoia-se", "beehiiv-vinculo.json");
}

/** Valida o shape de 1 entrada crua do cache — descarta silenciosamente
 * entradas malformadas (mesmo tratamento defensivo de `sanitizeOpenRateEntry`,
 * o arquivo é populado por um processo externo/manual). */
function sanitizeVinculoEntry(raw: unknown): VinculoInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.hasVinculo !== "boolean" ||
    (r.subscriptionId !== null && typeof r.subscriptionId !== "string") ||
    (r.status !== null && typeof r.status !== "string") ||
    typeof r.fetchedAt !== "string"
  ) {
    return null;
  }
  return {
    hasVinculo: r.hasVinculo,
    subscriptionId: r.subscriptionId as string | null,
    status: r.status as string | null,
    fetchedAt: r.fetchedAt,
  };
}

/**
 * Lê `data/apoia-se/beehiiv-vinculo.json` (#4273 parte 3) — arquivo LOCAL,
 * gitignored, populado manualmente por uma sessão com MCP Beehiiv conectado
 * (consulta `list_subscriptions` por email, mesmo mecanismo do
 * `beehiiv-open-rate.json`, #3612). Fail-soft total: arquivo ausente, JSON
 * corrompido, shape inesperado, ou entrada individual malformada → nunca
 * lança, na pior hipótese devolve `{}` (todo contato aparece com
 * `vinculo: null`). Chaves normalizadas (lowercase/trim) pra casar direto
 * contra `normalizeEmailList`.
 */
export function loadVinculoCache(rootDir: string): VinculoCache {
  const path = vinculoCachePath(rootDir);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const cache: VinculoCache = {};
  for (const [rawEmail, value] of Object.entries(raw as Record<string, unknown>)) {
    const email = rawEmail.trim().toLowerCase();
    if (!email) continue;
    const entry = sanitizeVinculoEntry(value);
    if (entry) cache[email] = entry;
  }
  return cache;
}

// ── I/O: cache de segmentos Beehiiv (leitura fail-soft, #4437 Entrega 2) ─

export function segmentsCachePath(rootDir: string): string {
  return resolve(rootDir, "data", "apoia-se", "beehiiv-segments.json");
}

/** Valida o shape de 1 entrada crua do cache — descarta silenciosamente
 * entradas malformadas (mesmo tratamento defensivo de `sanitizeVinculoEntry`,
 * o arquivo é populado por um script externo, ver
 * `scripts/sync-apoio-segments-beehiiv.ts`). */
function sanitizeSegmentsEntry(raw: unknown): SegmentsInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    !Array.isArray(r.segments) ||
    !r.segments.every((s) => typeof s === "string") ||
    typeof r.apoioNivel !== "string" ||
    typeof r.checkedAt !== "string"
  ) {
    return null;
  }
  return {
    segments: r.segments as string[],
    apoioNivel: r.apoioNivel,
    checkedAt: r.checkedAt,
  };
}

/**
 * Lê `data/apoia-se/beehiiv-segments.json` (#4437 Entrega 2) — arquivo
 * LOCAL, gitignored, populado por `scripts/sync-apoio-segments-beehiiv.ts`
 * (leitura paginada de `/subscriptions`, deriva a pertinência aos 6
 * segmentos `Apoio — *` a partir do custom field `apoio_nivel` — mesmo
 * mecanismo dos outros 2 caches Beehiiv deste módulo, #3612/#4273 parte 3).
 * Fail-soft total: arquivo ausente, JSON corrompido, shape inesperado, ou
 * entrada individual malformada → nunca lança, na pior hipótese devolve
 * `{}` (todo contato aparece com `segments: null`). Chaves normalizadas
 * (lowercase/trim) pra casar direto contra `normalizeEmailList`.
 */
export function loadSegmentsCache(rootDir: string): SegmentsCache {
  const path = segmentsCachePath(rootDir);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const cache: SegmentsCache = {};
  for (const [rawEmail, value] of Object.entries(raw as Record<string, unknown>)) {
    const email = rawEmail.trim().toLowerCase();
    if (!email) continue;
    const entry = sanitizeSegmentsEntry(value);
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
  /** Injetável pra testes — evita ler `.env` real. */
  env?: ApoiaSeEnv;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  limiter?: CheckBackerOptions["limiter"];
  /** Injetável pra testes — evita I/O de `beehiiv-open-rate.json` real
   * (#3612). Default: `loadOpenRateCache(rootDir)`. */
  openRateCache?: OpenRateCache;
  /** Injetável pra testes — evita I/O de `beehiiv-vinculo.json` real
   * (#4273 parte 3). Default: `loadVinculoCache(rootDir)`. */
  vinculoCache?: VinculoCache;
  /** Injetável pra testes — evita I/O de `beehiiv-segments.json` real
   * (#4437 Entrega 2). Default: `loadSegmentsCache(rootDir)`. */
  segmentsCache?: SegmentsCache;
}

function toSemDados(
  contacts: ApoioContact[],
  openRateCache: OpenRateCache,
  vinculoCache: VinculoCache,
  segmentsCache: SegmentsCache,
): ContactWithStatus[] {
  return contacts.map((c) => ({
    ...c,
    status: { label: "sem_dados" as const },
    openRate: deriveOpenRate(c, openRateCache),
    vinculo: deriveVinculo(c, vinculoCache),
    // status é sempre "sem_dados" aqui -> nunca há nível de recompensa vigente.
    rewardLevel: null,
    segments: deriveSegments(c, segmentsCache),
  }));
}

/**
 * Monta o snapshot completo pro painel "Apoios": contatos + status cruzado +
 * agregação de campanha. Fail-soft em 3 camadas (nunca lança): (1) `data/`
 * ausente, (2) credenciais apoia.se ausentes, (3) 401 da API — em qualquer
 * uma, contatos aparecem com status "sem_dados" e o campo `error` documenta o
 * motivo.
 */
export async function buildApoiosData(rootDir: string, opts: BuildApoiosDataOptions = {}): Promise<ApoiosData> {
  const now = opts.now ?? new Date();
  const generatedAt = now.toISOString();
  // Pura função de `now` (#4437) — computada cedo pra estar disponível em
  // TODO caminho de retorno que chega a montar `ContactWithStatus[]`
  // (`rewardLevel` e o grupo "ainda não pagou esse mês" dependem dela).
  const currentMonth = competenceMonth(now);

  if (!opts.contacts) {
    const dataDirError = checkDataDirAvailable(rootDir);
    if (dataDirError) {
      return { contacts: [], campaign: emptyCampaignSummary(), rewardGroups: emptyRewardGroupsView(), error: dataDirError, generatedAt };
    }
  }

  let contacts: ApoioContact[];
  try {
    contacts = opts.contacts ?? loadContacts(rootDir);
  } catch (e) {
    return { contacts: [], campaign: emptyCampaignSummary(), rewardGroups: emptyRewardGroupsView(), error: (e as Error).message, generatedAt };
  }

  // Taxa de abertura Beehiiv (#3612), confirmação de vínculo Beehiiv (#4273
  // parte 3) e segmentos Beehiiv (#4437 Entrega 2) são sinais INDEPENDENTES
  // do status de apoio apoia.se — carregados cedo, antes do gate de
  // credenciais abaixo, pra aparecerem em TODOS os caminhos de retorno
  // (inclusive quando as credenciais apoia.se estão ausentes).
  const openRateCache = opts.openRateCache ?? loadOpenRateCache(rootDir);
  const vinculoCache = opts.vinculoCache ?? loadVinculoCache(rootDir);
  const segmentsCache = opts.segmentsCache ?? loadSegmentsCache(rootDir);

  let env: ApoiaSeEnv;
  try {
    env = opts.env ?? readApoiaSeEnv();
  } catch (e) {
    const withStatus = toSemDados(contacts, openRateCache, vinculoCache, segmentsCache);
    return {
      contacts: withStatus,
      campaign: computeCampaignSummary(withStatus),
      rewardGroups: computeRewardGroups(withStatus, currentMonth),
      error: (e as Error).message,
      generatedAt,
    };
  }

  const allEmails = contacts.flatMap((c) => c.emails);
  const cacheDir = opts.cacheDir ?? defaultCacheDir(env.campaign);

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
    let status = deriveContactStatus(c.emails, currentStatuses, pastSnapshots);
    if (status.label === "nao_apoia") {
      const hasUnresolvedEmail = normalizeEmailList(c.emails).some((e) => !resolvedEmails.has(e));
      if (hasUnresolvedEmail) status = { label: "sem_dados" };
    }
    return {
      ...c,
      status,
      openRate: deriveOpenRate(c, openRateCache),
      vinculo: deriveVinculo(c, vinculoCache),
      rewardLevel: computeContactRewardLevel(status, currentMonth),
      segments: deriveSegments(c, segmentsCache),
    };
  });

  return {
    contacts: withStatus,
    campaign: computeCampaignSummary(withStatus),
    rewardGroups: computeRewardGroups(withStatus, currentMonth),
    error: fetchError,
    generatedAt,
  };
}

// ── orquestração: force-refresh seletivo (#3859 — botão "Atualizar status") ─

export interface RefreshApoiosDataOptions extends BuildApoiosDataOptions {
  /** Injetável pra testes — evita chamada de rede real ao Gmail (#3859
   * metade 1). Default: `drainApoiaSeNotifications(rootDir)`. */
  gmailDrain?: () => Promise<DrainApoiaSeResult>;
}

/**
 * Contraparte de `buildApoiosData` usada pelo botão "Atualizar status"
 * (#3859 metade 2): força re-consulta do mês corrente na apoia.se, mas SÓ
 * para contatos AINDA NÃO confirmados como "apoiando" — contatos já
 * confirmados reusam o valor já em cache, sem gastar request. Ver o
 * cabeçalho do módulo pro rationale completo.
 *
 * Fail-soft nas mesmas 3 camadas de `buildApoiosData` (data/ ausente,
 * credenciais ausentes, 401 da API) — nunca lança.
 */
export async function refreshApoiosData(rootDir: string, opts: RefreshApoiosDataOptions = {}): Promise<ApoiosData> {
  const now = opts.now ?? new Date();
  const generatedAt = now.toISOString();
  // Pura função de `now` (#4437) — ver rationale em `buildApoiosData`.
  const currentMonth = competenceMonth(now);

  if (!opts.contacts) {
    const dataDirError = checkDataDirAvailable(rootDir);
    if (dataDirError) {
      return { contacts: [], campaign: emptyCampaignSummary(), rewardGroups: emptyRewardGroupsView(), error: dataDirError, generatedAt };
    }
  }

  let contacts: ApoioContact[];
  try {
    contacts = opts.contacts ?? loadContacts(rootDir);
  } catch (e) {
    return { contacts: [], campaign: emptyCampaignSummary(), rewardGroups: emptyRewardGroupsView(), error: (e as Error).message, generatedAt };
  }

  // #3859 metade 1: importar apoiadores novos via e-mail ANTES do
  // force-refresh de pagamento abaixo (metade 2) — ver cabeçalho do módulo.
  // Fail-soft por design: falha do drain (token Gmail expirado, rede) NUNCA
  // trava o force-refresh de pagamento — só fica registrada em
  // `gmailDrainError`, que só aparece no payload final se nenhum erro mais
  // crítico (credenciais/auth apoia.se) tiver ocorrido depois.
  let gmailDrainError: string | null = null;
  try {
    const runGmailDrain = opts.gmailDrain ?? (() => drainApoiaSeNotifications(rootDir));
    const drainResult = await runGmailDrain();
    if (drainResult.skipped) {
      gmailDrainError = `import automático via e-mail apoia.se pulado (${drainResult.reason ?? "erro desconhecido"}) — status de pagamento seguiu normalmente.`;
    } else {
      if (drainResult.notifications.length > 0) {
        const { contacts: updatedContacts, mutated } = importNewApoiadoresFromGmail(
          contacts,
          drainResult.notifications,
        );
        contacts = updatedContacts;
        if (mutated) saveContacts(rootDir, contacts);
      }
      // #3912: promessas viram contato PENDENTE — roda DEPOIS do import de
      // confirmados acima, pra que uma promessa cujo email JÁ foi importado
      // como confirmado nesta mesma leva (evento raro, mas possível se os 2
      // e-mails chegarem juntos) seja corretamente deduplicada contra ele.
      const promessas = drainResult.promessas ?? [];
      if (promessas.length > 0) {
        const { contacts: updatedContacts, mutated } = importPendingApoiadoresFromGmail(
          contacts,
          promessas,
        );
        contacts = updatedContacts;
        if (mutated) saveContacts(rootDir, contacts);
      }
      // #4171: mensagens que casaram a query mas não bateram nenhum template
      // (`unparsed`) e threads que falharam ao carregar (`errors`) nunca
      // chegavam ao editor antes — a mensagem sumia calada e o campo `errors`
      // (que já existia) também não era lido aqui. Trazendo os dois pro mesmo
      // canal de aviso fail-soft (`gmailDrainError`) que os outros casos desta
      // função já usam, pra o editor perceber que algo chegou e não foi
      // entendido (mesmo raciocínio de #573 pra estado externo ambíguo).
      const unparsedCount = drainResult.unparsed ?? 0;
      const threadErrorCount = drainResult.errors ?? 0;
      if (unparsedCount > 0 || threadErrorCount > 0) {
        const parts: string[] = [];
        if (unparsedCount > 0) {
          parts.push(
            `${unparsedCount} mensagem(ns) da apoia.se não reconhecida(s) pelo parser (ver data/apoia-se/unparsed-quarantine.jsonl)`,
          );
        }
        if (threadErrorCount > 0) {
          parts.push(`${threadErrorCount} thread(s) do Gmail falharam ao carregar`);
        }
        gmailDrainError = parts.join(" — ");
      }
    }
  } catch (e) {
    gmailDrainError = `import automático via e-mail apoia.se falhou (${(e as Error).message}) — status de pagamento seguiu normalmente.`;
  }

  const openRateCache = opts.openRateCache ?? loadOpenRateCache(rootDir);
  const vinculoCache = opts.vinculoCache ?? loadVinculoCache(rootDir);
  const segmentsCache = opts.segmentsCache ?? loadSegmentsCache(rootDir);

  let env: ApoiaSeEnv;
  try {
    env = opts.env ?? readApoiaSeEnv();
  } catch (e) {
    const withStatus = toSemDados(contacts, openRateCache, vinculoCache, segmentsCache);
    return {
      contacts: withStatus,
      campaign: computeCampaignSummary(withStatus),
      rewardGroups: computeRewardGroups(withStatus, currentMonth),
      error: (e as Error).message,
      generatedAt,
    };
  }

  const cacheDir = opts.cacheDir ?? defaultCacheDir(env.campaign);
  const pastSnapshots = readPastMonthSnapshots(cacheDir, currentMonth);

  // Fase 1 — SEM rede: lê o cache do mês corrente tal como está (nunca gasta
  // request só pra descobrir quem já está confirmado). `pastSnapshotsDesc: []`
  // é deliberado aqui — só nos interessa o label "apoiando" pra decidir quem
  // pular, e esse label só vem de `currentMonthStatuses` (ver
  // `deriveContactStatus`); passar os snapshots de meses passados não mudaria
  // essa decisão, só adicionaria trabalho.
  const existingStatuses = readMonthCache(cacheDir, currentMonth);

  const confirmedEmails = new Set<string>();
  const unconfirmedEmails = new Set<string>();
  for (const contact of contacts) {
    const preliminary = deriveContactStatus(contact.emails, existingStatuses, []);
    const emails = normalizeEmailList(contact.emails);
    const bucket = preliminary.label === "apoiando" ? confirmedEmails : unconfirmedEmails;
    for (const email of emails) bucket.add(email);
  }
  // Um email nunca deveria pertencer a 2 contatos (a apoia.se casa por email
  // exato), mas por segurança: um email já confirmado nunca entra na lista de
  // force-refresh, mesmo que outro contato o traga como não-confirmado.
  for (const email of confirmedEmails) unconfirmedEmails.delete(email);

  // Fase 2 — rede, só pros não-confirmados. Sequencial (mesmo motivo de
  // `fetchCurrentStatuses`: `checkBacker` faz load→fetch→save do MESMO
  // arquivo de cache sem lock — concorrência arriscaria uma escrita
  // sobrescrever a outra). Fail-fast em erro de auth (pararia igual pra todo
  // email restante); erro pontual (rede/API) é fail-soft, pula o email.
  const refreshed: Record<string, BackerStatus> = {};
  let refreshError: string | null = null;
  for (const email of unconfirmedEmails) {
    try {
      refreshed[email] = await checkBacker(email, {
        env,
        cacheDir,
        now,
        fetchImpl: opts.fetchImpl,
        limiter: opts.limiter,
        forceRefresh: true,
      });
    } catch (e) {
      if (e instanceof ApoiaSeAuthError) {
        refreshError = e.message;
        break;
      }
      // erro pontual — pula este email, segue os demais.
    }
  }

  // Statuses finais: confirmados reusam o valor já em cache (nunca tocado
  // nesta chamada); não-confirmados usam o resultado fresco quando resolvido.
  const currentStatuses: Record<string, BackerStatus> = { ...existingStatuses, ...refreshed };
  const resolvedEmails = new Set(Object.keys(currentStatuses));

  const withStatus: ContactWithStatus[] = contacts.map((c) => {
    let status = deriveContactStatus(c.emails, currentStatuses, pastSnapshots);
    if (status.label === "nao_apoia") {
      const hasUnresolvedEmail = normalizeEmailList(c.emails).some((e) => !resolvedEmails.has(e));
      if (hasUnresolvedEmail) status = { label: "sem_dados" };
    }
    return {
      ...c,
      status,
      openRate: deriveOpenRate(c, openRateCache),
      vinculo: deriveVinculo(c, vinculoCache),
      rewardLevel: computeContactRewardLevel(status, currentMonth),
      segments: deriveSegments(c, segmentsCache),
    };
  });

  return {
    contacts: withStatus,
    campaign: computeCampaignSummary(withStatus),
    rewardGroups: computeRewardGroups(withStatus, currentMonth),
    // refreshError (falha de credenciais/auth apoia.se) é mais crítico —
    // nunca sobrescrito pelo gmailDrainError (fail-soft, #3859 metade 1).
    error: refreshError ?? gmailDrainError,
    generatedAt,
  };
}

// ── orquestração: mutações (I/O read-modify-write do jsonl) ─────────────

export type ApoiosMutationResult =
  | { ok: true; contact: ApoioContact }
  | { ok: false; error: string };

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

// ── parsing de corpo de request (puro, usado pelos handlers em server.ts) ─
// #3862: `parseCreateContactBody` saiu junto com a rota POST /api/apoios/contacts
// que a chamava (cadastro manual removido) — só o parse do PATCH de edição
// segue em uso.

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

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
  if (b.notes !== undefined) {
    if (typeof b.notes !== "string") return { ok: false, error: "'notes' precisa ser string" };
    patch.notes = b.notes;
  }
  return { ok: true, value: patch };
}
