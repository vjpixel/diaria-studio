#!/usr/bin/env node
/**
 * scripts/sync-apoio-nivel-brevo.ts (#4572)
 *
 * Paridade BREVO de `scripts/sync-apoio-nivel-beehiiv.ts` (#4436) — sync
 * simétrico, decisão do editor (comentário 260804 da issue #4572): "mesma
 * lógica/gate humano do script existente, só trocando o alvo". A fonte de
 * verdade sobre QUEM é apoiador Mantenedor/Patrono é IDÊNTICA e não é
 * reimplementada aqui — `computeDesiredApoioLevels`/`DesiredApoioLevel`/
 * `ApoioNivel`/`shouldBlockRemovals` são importados DIRETO de
 * `sync-apoio-nivel-beehiiv.ts` (já exportados de lá): mesma carência de 1
 * mês (#4436), mesmo tratamento fail-closed de contatos "sem_dados", mesmo
 * guard de dados parciais. Nenhuma segunda cópia da regra de negócio "o que
 * é Mantenedor" existe neste arquivo.
 *
 * ## Por que este script existe (#4572)
 *
 * `/diaria-mensal-apoiadores` (#4521) foi implementada assumindo Beehiiv como
 * canal, restringindo audiência via segmentos "Include and exclude" — essa
 * feature está bloqueada atrás do plano Scale da Beehiiv (workspace é
 * Launch/free, confirmado ao vivo 260804). Decisão do editor: trocar o canal
 * pra Brevo, reusando a maquinaria já existente (`publish-daily-brevo.ts` e
 * vizinhos). Este script é a peça que falta: a PONTE entre `apoio_nivel`
 * (fonte apoia.se) e uma audiência de verdade na Brevo — antes deste PR,
 * `grep -ri "apoio.*brevo"` não retornava nada no repo.
 *
 * ## Por que LISTA, não custom field (diferença deliberada do espelho Beehiiv)
 *
 * A Beehiiv resolve audiência por CONDIÇÃO sobre um custom field (segmento
 * dinâmico, `scripts/lib/apoio-segments-canonical.ts`, #4436). A Brevo, pelo
 * mecanismo já usado neste repo pra campanhas (`publish-daily-brevo.ts`,
 * `scripts/lib/brevo-client.ts` — `recipients: {listIds:[...]}`), resolve
 * audiência por LISTA, não por condição de atributo dinâmica no momento do
 * envio. Reproduzir o desenho Beehiiv literalmente (escrever só um atributo
 * `APOIO_NIVEL` e nunca usá-lo pra nada) deixaria a skill `/diaria-mensal-
 * apoiadores` sem audiência de verdade pra apontar. Este script por isso faz
 * DUAS coisas por contato-alvo:
 *
 *   1. Escreve o atributo de contato `APOIO_NIVEL` (paridade de dado com o
 *      custom field Beehiiv — útil pra debug/auditoria e qualquer
 *      segmentação futura por atributo) — mesmo padrão de `POLL_TOKEN` em
 *      `inject-poll-token-brevo.ts`.
 *   2. Mantém a MEMBRESIA da lista `brevo_apoiadores.list_id`
 *      (`platform.config.json`) convergida com `nível ∈ {mantenedor,
 *      patrono}` (`TARGET_LEVELS` abaixo) — esta é a audiência REAL que
 *      `send-monthly-apoiadores.ts`/a campanha Brevo aponta.
 *
 * Consequência: diferente do espelho Beehiiv (que só marca assinantes JÁ
 * EXISTENTES na Beehiiv — nunca cria uma subscription nova), este script PODE
 * criar contatos novos na Brevo (`POST /contacts` com `updateEnabled: true` —
 * mesmo upsert de `ingestContactToBrevo` em `sync-pending-to-brevo.ts`), já
 * que a lista de apoiadores é própria/dedicada deste projeto, não uma base de
 * terceiro que exigiria opt-in prévio.
 *
 * ## Guard de blast radius — reimplementado, não reusado (diferença de tipo)
 *
 * `evaluateBlastRadiusGuard` (sync-apoio-nivel-beehiiv.ts) espera
 * `BeehiivSubscriptionSnapshot[]` (snapshot POR ASSINATURA, com campo
 * `apoioNivel`) — incompatível com o modelo de estado atual daqui (membresia
 * de LISTA; o nível vive num atributo escrito à parte, não no "estado atual"
 * usado pelo denominador do guard). `evaluateBrevoBlastRadiusGuard` abaixo
 * reimplementa o MESMO limiar (30%, decisão do editor #4436) e a MESMA
 * semântica ("estrito — no limiar exato não bloqueia") sobre o denominador
 * equivalente pra este modelo: quantos SÃO membros hoje da lista Brevo.
 * `shouldBlockRemovals` (guard de dados parciais) já É genérico o bastante
 * (`Pick<ApoioTagDiffResult, "skippedUnresolved">`) — reusado sem alteração.
 *
 * ## Dry-run por padrão
 *
 * Só aplica mutação real na Brevo com `--push` explícito. Sem `--push`,
 * imprime o diff calculado (quem entra/sai/muda de nível) e sai — mesmo
 * contrato do espelho Beehiiv.
 *
 * IMPORTANTE (#4572 — escopo desta unidade): `--push` NUNCA foi executado
 * nesta sessão contra a Brevo real (guard de publicação do overnight cobre
 * scripts que tocam Brevo ao vivo) — e nem SERIA possível ainda:
 * `brevo_apoiadores.list_id` em `platform.config.json` está `null` (a lista
 * dedicada ainda não foi criada na conta Brevo do editor) — mesma disciplina
 * de scripts operacionais dos #4320/#4382/#4490/#4534 (worktree isolado, sem
 * credencial Brevo real). Validado só via dry-run (leitura real de apoia.se,
 * zero escrita Brevo) + testes com fetch mockado (nenhuma chamada de rede
 * real nos testes).
 *
 * Uso:
 *   npx tsx scripts/sync-apoio-nivel-brevo.ts [--push] [--allow-partial] [--force-blast-radius]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { readApoiaSeEnv, defaultCacheDir, competenceMonth } from "./lib/apoia-se.ts";
import { runApoioReconciliationCycle } from "./lib/apoio-reconciliation-cycle.ts";
import { brevoGet, brevoPost, brevoPut, ensureBrevoContactAttribute } from "./lib/brevo-client.ts";
import {
  computeDesiredApoioLevels,
  shouldBlockRemovals,
  type DesiredApoioLevel,
  type ApoioNivel,
} from "./sync-apoio-nivel-beehiiv.ts";
import { buildApoiosData, readPastMonthSnapshots, type MonthSnapshot } from "./studio-ui/studio-apoios.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LOG_PREFIX = "[sync-apoio-nivel-brevo]";

/** Mesmo limiar do #4436 — ver rationale no cabeçalho do módulo (guard
 * reimplementado, não reusado, por diferença de tipo do estado atual). */
const BLAST_RADIUS_THRESHOLD = 0.3;

/** Nome do atributo de contato na Brevo — paridade de dado com o custom
 * field `apoio_nivel` da Beehiiv (ver cabeçalho do módulo). Maiúsculo por
 * convenção de atributo Brevo (mesmo padrão de `POLL_TOKEN`,
 * `inject-poll-token-brevo.ts`). */
export const APOIO_NIVEL_ATTR_NAME = "APOIO_NIVEL";

/** Níveis que compõem a audiência real da lista Brevo dedicada — decisão 2
 * do #4482 (reafirmada no #4572): só Mantenedor/Patrono, nunca Amigo/
 * Apoiador, nunca a base inteira. Mesmo conjunto de
 * `APOIADORES_TARGET_SEGMENT_NAMES` em `send-monthly-apoiadores.ts`, só que
 * expresso como nível (não nome de segmento Beehiiv). */
export const TARGET_LEVELS: readonly ApoioNivel[] = ["mantenedor", "patrono"];

const LEVEL_VALUES: readonly ApoioNivel[] = ["amigo", "apoiador", "mantenedor", "patrono"];

function isApoioNivelValue(v: unknown): v is ApoioNivel {
  return typeof v === "string" && (LEVEL_VALUES as readonly string[]).includes(v);
}

/** Pure: `true` se o nível está entre os alvos da lista dedicada
 * (Mantenedor/Patrono) — `null` (sem apoio/carência esgotada) nunca é alvo. */
export function isTargetLevel(level: ApoioNivel | null): boolean {
  return level !== null && (TARGET_LEVELS as readonly string[]).includes(level);
}

// ── config (platform.config.json) ──────────────────────────────────────────

interface BrevoApoiadoresConfig {
  api_key_env: string;
  list_id: number | null;
}
interface PlatformConfig {
  brevo_apoiadores?: BrevoApoiadoresConfig;
}

// ── estado ATUAL (I/O — membresia da lista Brevo dedicada) ─────────────────

export interface BrevoApoiadorMember {
  /** E-mail normalizado (lowercase/trim). */
  email: string;
  /** Valor atual do atributo `APOIO_NIVEL` — `""` quando ausente/vazio/não-string. */
  apoioNivel: string;
}

interface BrevoContactListEntry {
  email?: unknown;
  attributes?: Record<string, unknown>;
}
interface BrevoContactsListPage {
  contacts?: BrevoContactListEntry[];
}

/**
 * Pagina `GET /contacts/lists/{listId}/contacts` (mesmo endpoint de
 * `iterateListContacts` em `inject-poll-token-brevo.ts`, mas lendo TAMBÉM o
 * atributo `APOIO_NIVEL` de cada contato, não só o e-mail). `brevoGet` já
 * falha alto em `429`/`5xx` (retry com backoff) e em qualquer outro erro
 * HTTP — este é o recurso PRINCIPAL do diff (mesma disciplina de
 * `fetchCurrentBeehiivState`: uma leitura truncada geraria remoção fantasma
 * ou adição duplicada). Paginação por tamanho de página (`contacts.length <
 * limit` encerra) — sem o ponto de ambiguidade de `total_results`/`limit`
 * efetivo que motivou a reconciliação extra em `fetchCurrentBeehiivState`
 * (endpoint da Beehiiv), porque aqui `brevoGet` já falha alto em vez de
 * silenciar uma página malformada.
 */
export async function fetchCurrentBrevoApoiadoresState(
  apiKey: string,
  listId: number,
): Promise<BrevoApoiadorMember[]> {
  const out: BrevoApoiadorMember[] = [];
  const limit = 50;
  let offset = 0;
  for (;;) {
    const { status, body } = await brevoGet(apiKey, `/contacts/lists/${listId}/contacts?limit=${limit}&offset=${offset}`);
    if (status !== 200) {
      throw new Error(
        `Brevo API ${status} em /contacts/lists/${listId}/contacts (offset ${offset}) — ` +
          "leitura truncada nunca alimenta o diff (risco de remoção/adição incorreta).",
      );
    }
    const contacts = (body as BrevoContactsListPage).contacts ?? [];
    for (const c of contacts) {
      const email = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";
      if (!email) continue;
      const raw = c.attributes?.[APOIO_NIVEL_ATTR_NAME];
      out.push({ email, apoioNivel: typeof raw === "string" ? raw : "" });
    }
    if (contacts.length < limit) break;
    offset += limit;
  }
  return out;
}

// ── diff (puro — desejado × membresia atual da lista) ──────────────────────

export interface ApoioBrevoDiffEntry {
  contactId: string;
  contactName: string;
  email: string;
  /** Nível atual (atributo `APOIO_NIVEL`), `null` se ausente/inválido. */
  fromLevel: ApoioNivel | null;
  /** Sempre Mantenedor/Patrono — só entradas de `toApply` carregam nível-alvo. */
  toLevel: ApoioNivel;
}

export interface ApoioBrevoRemovalEntry {
  contactId: string;
  contactName: string;
  email: string;
  fromLevel: ApoioNivel | null;
}

export interface ApoioBrevoDiffResult {
  /** Adições (novo membro) + trocas de nível (já membro, atributo desatualizado)
   * — sempre seguro aplicar (nunca gated pelo guard de dados parciais). */
  toApply: ApoioBrevoDiffEntry[];
  /** Remoções (nível caiu abaixo de Mantenedor/Patrono, ou parou de apoiar) —
   * sujeito ao guard fail-closed de dados parciais e ao guard de blast radius. */
  toRemove: ApoioBrevoRemovalEntry[];
  /** Já convergido — membro da lista com o nível correto (idempotência). */
  unchanged: ApoioBrevoDiffEntry[];
  /** Contatos "sem_dados" — nenhuma ação gerada, nível desconhecido. */
  skippedUnresolved: DesiredApoioLevel[];
  /** Membros ATUAIS da lista Brevo sem nenhum contato apoia.se correspondente
   * (por nenhum dos e-mails conhecidos) — não tocados (não sabemos a origem:
   * pode ser adição manual, ou um e-mail do apoia.se desatualizado). Surfaced
   * pro editor investigar, nunca removido automaticamente. */
  untrackedMembers: string[];
}

/**
 * Pure: diffa o estado desejado (por contato apoia.se, já com carência
 * aplicada por `computeDesiredApoioLevels`) contra a membresia atual da lista
 * Brevo dedicada. Para cada contato-alvo (nível Mantenedor/Patrono), aplica a
 * TODOS os e-mails conhecidos do contato (mesma filosofia de "alcançar a
 * pessoa independente de qual e-mail ela usa" do espelho Beehiiv,
 * `diffApoioTags`) — diferente daquele, aqui um e-mail nunca precisa já ser
 * um contato Brevo existente pra receber a ação (ver "Consequência" no
 * cabeçalho do módulo).
 */
export function diffApoioBrevo(
  desired: DesiredApoioLevel[],
  current: BrevoApoiadorMember[],
): ApoioBrevoDiffResult {
  const currentByEmail = new Map<string, BrevoApoiadorMember>();
  for (const m of current) currentByEmail.set(m.email, m);
  const matchedEmails = new Set<string>();

  const toApply: ApoioBrevoDiffEntry[] = [];
  const toRemove: ApoioBrevoRemovalEntry[] = [];
  const unchanged: ApoioBrevoDiffEntry[] = [];
  const skippedUnresolved: DesiredApoioLevel[] = [];

  for (const d of desired) {
    if (d.unresolved) {
      skippedUnresolved.push(d);
      continue;
    }

    const targetLevel = isTargetLevel(d.level) ? (d.level as ApoioNivel) : null;

    for (const email of d.emails) {
      const member = currentByEmail.get(email);
      if (member) matchedEmails.add(email);
      const fromLevel = member && isApoioNivelValue(member.apoioNivel) ? member.apoioNivel : null;

      if (targetLevel !== null) {
        const entry: ApoioBrevoDiffEntry = {
          contactId: d.contactId,
          contactName: d.contactName,
          email,
          fromLevel,
          toLevel: targetLevel,
        };
        if (member && fromLevel === targetLevel) {
          unchanged.push(entry);
        } else {
          toApply.push(entry);
        }
      } else if (member) {
        // Membro atual, mas o nível desejado não é mais Mantenedor/Patrono
        // (caiu de faixa, ou parou de apoiar/carência esgotada) — remover.
        toRemove.push({ contactId: d.contactId, contactName: d.contactName, email, fromLevel });
      }
      // Não-alvo sem membresia prévia: nada a fazer (nunca foi adicionado, correto).
    }
  }

  const untrackedMembers = current.filter((m) => !matchedEmails.has(m.email)).map((m) => m.email);

  return { toApply, toRemove, unchanged, skippedUnresolved, untrackedMembers };
}

// ── guard de blast radius (#4436, reimplementado — ver cabeçalho do módulo) ─

export interface BrevoBlastRadiusGuardResult {
  blocked: boolean;
  removalCount: number;
  currentMemberCount: number;
  ratio: number;
}

/**
 * Pure: recusa o `--push` inteiro quando as remoções calculadas excedem
 * `BLAST_RADIUS_THRESHOLD` (30%) de quem é membro HOJE da lista Brevo
 * dedicada — mesmo racional/limiar de `evaluateBlastRadiusGuard`
 * (sync-apoio-nivel-beehiiv.ts, #4436), denominador adaptado pro modelo de
 * membresia de lista (não há campo `apoioNivel` por membro no estado atual
 * aqui — só o e-mail já implica "é alvo", ver `fetchCurrentBrevoApoiadoresState`).
 * "Passar de" é estrito — exatamente no limiar não bloqueia.
 * `force` (`--force-blast-radius`) é o escape hatch explícito, sempre logado.
 */
export function evaluateBrevoBlastRadiusGuard(
  removalCount: number,
  currentMemberCount: number,
  force: boolean,
): BrevoBlastRadiusGuardResult {
  const ratio = currentMemberCount > 0 ? removalCount / currentMemberCount : 0;
  const blocked = !force && ratio > BLAST_RADIUS_THRESHOLD;
  return { blocked, removalCount, currentMemberCount, ratio };
}

// ── aplicação (I/O — escrita + verificação por releitura) ──────────────────

/**
 * Cria o atributo de contato `APOIO_NIVEL` (categoria "normal", tipo texto)
 * se ainda não existir — thin wrapper sobre `ensureBrevoContactAttribute`
 * (`scripts/lib/brevo-client.ts`, #4634 finding do type-design-analyzer),
 * versão compartilhada do mesmo padrão antes duplicado com
 * `inject-poll-token-brevo.ts::ensureContactAttribute` (~linha 99).
 * Idempotente; confirma a criação por releitura antes de retornar (ver
 * docstring de `ensureBrevoContactAttribute`).
 *
 * Causa raiz do #4634: este script nunca garantia a existência do atributo
 * antes de escrevê-lo via `applyBrevoApoioAddEntry` — diferente de
 * `POLL_TOKEN` (que `inject-poll-token-brevo.ts` sempre garante antes de
 * qualquer PUT), `APOIO_NIVEL` dependia de alguém criar o atributo
 * manualmente na conta Brevo primeiro, o que nunca aconteceu até a sessão
 * 260804 (criado manualmente pra destravar 2 e-mails). Sem o atributo
 * existir, `POST /contacts` com `attributes: {APOIO_NIVEL: ...}` retorna 2xx
 * mas ignora o campo em silêncio — a releitura pós-escrita em
 * `applyBrevoApoioAddEntry` já pega esse caso (lança "NÃO confere"), mas só
 * DEPOIS da tentativa; garantir o atributo antes evita a falha inteira.
 */
export async function ensureContactAttribute(apiKey: string): Promise<void> {
  const created = await ensureBrevoContactAttribute(apiKey, APOIO_NIVEL_ATTR_NAME, "text");
  if (created) {
    process.stderr.write(`${LOG_PREFIX} criado atributo de contato "${APOIO_NIVEL_ATTR_NAME}"\n`);
  }
}

/**
 * Cria/atualiza o contato (`POST /contacts`, upsert — mesmo padrão de
 * `ingestContactToBrevo` em `sync-pending-to-brevo.ts`) com a lista dedicada
 * + o atributo `APOIO_NIVEL`, e verifica por RELEITURA (nunca confiar só no
 * 2xx do POST — mesma disciplina de `applyApoioTagEntry`/`ingestContactToBrevo`,
 * a lição documentada desde #4273: a Beehiiv já aceitou uma escrita
 * silenciosamente ignorada com 200; mais vale reler sempre que escrever).
 */
export async function applyBrevoApoioAddEntry(
  entry: ApoioBrevoDiffEntry,
  listId: number,
  apiKey: string,
): Promise<void> {
  await brevoPost(apiKey, "/contacts", {
    email: entry.email,
    listIds: [listId],
    attributes: { [APOIO_NIVEL_ATTR_NAME]: entry.toLevel },
    updateEnabled: true,
  });

  const check = await brevoGet(apiKey, `/contacts/${encodeURIComponent(entry.email)}`);
  if (check.status !== 200) {
    throw new Error(`releitura pós-escrita falhou pra ${entry.email} (HTTP ${check.status}) — mutação não confirmada.`);
  }
  const listIds: unknown = check.body?.listIds;
  const attrValue: unknown = check.body?.attributes?.[APOIO_NIVEL_ATTR_NAME];
  const inList = Array.isArray(listIds) && listIds.includes(listId);
  if (!inList || attrValue !== entry.toLevel) {
    throw new Error(
      `releitura pós-escrita NÃO confere pra ${entry.email}: listIds=${JSON.stringify(listIds)} ` +
        `(esperado incluir ${listId}), ${APOIO_NIVEL_ATTR_NAME}="${String(attrValue)}" (esperado "${entry.toLevel}") — ` +
        "mesma armadilha do endpoint de tags da Beehiiv (200 mas ignorado em silêncio); mutação NÃO confirmada.",
    );
  }
}

/**
 * Desvincula da lista dedicada (`PUT /contacts/{email}` com
 * `{unlinkListIds: [listId]}` — mesmo endpoint de `unlinkFromBrevoList` em
 * `evaluate-brevo-diaria.ts`) e verifica por releitura que o contato não
 * consta mais em `listIds`. NUNCA deleta o contato nem seta
 * `emailBlacklisted` — só remove da audiência desta lista específica (o
 * contato pode ser membro de outras listas Brevo por outro motivo).
 */
export async function applyBrevoApoioRemoveEntry(
  entry: ApoioBrevoRemovalEntry,
  listId: number,
  apiKey: string,
): Promise<void> {
  await brevoPut(apiKey, `/contacts/${encodeURIComponent(entry.email)}`, { unlinkListIds: [listId] });

  const check = await brevoGet(apiKey, `/contacts/${encodeURIComponent(entry.email)}`);
  if (check.status !== 200) {
    throw new Error(`releitura pós-remoção falhou pra ${entry.email} (HTTP ${check.status}) — mutação não confirmada.`);
  }
  const listIds: unknown = check.body?.listIds;
  if (Array.isArray(listIds) && listIds.includes(listId)) {
    throw new Error(
      `releitura pós-remoção NÃO confere pra ${entry.email}: ainda consta em listIds=${JSON.stringify(listIds)}.`,
    );
  }
}

// ── aplicação do diff (I/O — wiring testável, #4634) ────────────────────────

export interface ApplyBrevoApoioDiffResult {
  applied: number;
  failed: number;
}

/**
 * Aplica o diff calculado na Brevo: garante o atributo `APOIO_NIVEL` (se há
 * algo a aplicar) ANTES de qualquer `applyBrevoApoioAddEntry` — causa raiz do
 * #4634 (ver docstring de `ensureContactAttribute`) — e só então aplica as
 * duas listas de entrada (adições/trocas, depois remoções liberadas).
 *
 * Extraído de `main()` (#4634, achado ALTO do pr-test-analyzer): antes desta
 * extração, os testes de `ensureContactAttribute` só chamavam a função
 * ISOLADA — nenhum teste provava que a ORDEM real dentro do fluxo de
 * `--push` (garantir o atributo ANTES do 1º POST de aplicação) continuava
 * correta. Um refactor futuro que movesse/removesse essas linhas de `main()`
 * passaria verde nos testes antigos e reintroduziria o bug em silêncio — ver
 * `test/sync-apoio-nivel-brevo.test.ts` describe `applyBrevoApoioDiff —
 * wiring`.
 */
export async function applyBrevoApoioDiff(
  toApply: ApoioBrevoDiffEntry[],
  toRemoveNow: ApoioBrevoRemovalEntry[],
  listId: number,
  apiKey: string,
  log: (msg: string) => void,
): Promise<ApplyBrevoApoioDiffResult> {
  if (toApply.length > 0) {
    // #4634: garante que o atributo `APOIO_NIVEL` existe na conta Brevo
    // ANTES de qualquer applyBrevoApoioAddEntry — sem isso, toda escrita de
    // nível falhava em silêncio (POST 2xx, atributo nunca persistido).
    await ensureContactAttribute(apiKey);
  }

  log(`--push: aplicando ${toApply.length} adição(ões)/troca(s) + ${toRemoveNow.length} remoção(ões)…`);

  let applied = 0;
  let failed = 0;
  for (const entry of toApply) {
    try {
      await applyBrevoApoioAddEntry(entry, listId, apiKey);
      applied++;
    } catch (e) {
      failed++;
      log(`FALHA em ${entry.email}: ${(e as Error).message}`);
    }
  }
  for (const entry of toRemoveNow) {
    try {
      await applyBrevoApoioRemoveEntry(entry, listId, apiKey);
      applied++;
    } catch (e) {
      failed++;
      log(`FALHA em ${entry.email}: ${(e as Error).message}`);
    }
  }
  return { applied, failed };
}

// ── logging do diff (dry-run e --push) ──────────────────────────────────

function logDiff(diff: ApoioBrevoDiffResult, removalsBlocked: boolean): void {
  const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);

  log(`${diff.toApply.length} adição(ões)/troca(s) de nível:`);
  for (const e of diff.toApply) {
    log(`  + ${e.email} (${e.contactName}): ${e.fromLevel ?? "(nenhum)"} → ${e.toLevel}`);
  }

  if (removalsBlocked && diff.toRemove.length > 0) {
    log(
      `${diff.toRemove.length} remoção(ões) CALCULADA(S) mas BLOQUEADA(S) (dados parciais — ` +
        "ver aviso acima; use --allow-partial pra forçar):",
    );
  } else {
    log(`${diff.toRemove.length} remoção(ões):`);
  }
  for (const e of diff.toRemove) {
    log(`  - ${e.email} (${e.contactName}): ${e.fromLevel ?? "(nenhum)"} → (fora da lista)`);
  }

  if (diff.skippedUnresolved.length > 0) {
    log(
      `${diff.skippedUnresolved.length} contato(s) "sem_dados" pulado(s) (nível desconhecido, ` +
        `nenhuma ação): ${diff.skippedUnresolved.map((d) => d.contactName || d.emails[0]).join(", ")}`,
    );
  }

  if (diff.untrackedMembers.length > 0) {
    log(
      `${diff.untrackedMembers.length} membro(s) da lista Brevo SEM contato apoia.se correspondente ` +
        `(não tocado(s), investigar manualmente): ${diff.untrackedMembers.join(", ")}`,
    );
  }

  log(`${diff.unchanged.length} já convergido(s) (nenhuma ação).`);
}

function logBlastRadiusGuard(guard: BrevoBlastRadiusGuardResult): void {
  const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
  const pct = (guard.ratio * 100).toFixed(1);
  log(
    `guard de blast radius: ${guard.removalCount} remoção(ões) de ${guard.currentMemberCount} ` +
      `membro(s) hoje (${pct}%, limiar ${(BLAST_RADIUS_THRESHOLD * 100).toFixed(0)}%)` +
      (guard.blocked ? " — EXCEDIDO." : "."),
  );
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  loadProjectEnv(ROOT);
  const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);

  const platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as PlatformConfig;
  const config = platformConfig.brevo_apoiadores;
  if (!config) {
    log("ERRO: brevo_apoiadores não configurado em platform.config.json.");
    process.exit(2);
  }

  const push = hasFlag(argv, "push");
  const apiKey = process.env[config!.api_key_env];
  if (push && config!.list_id == null) {
    log(
      "ERRO: brevo_apoiadores.list_id não definido em platform.config.json — crie a lista dedicada na " +
        "conta Brevo antes do --push (ver nota do campo em platform.config.json).",
    );
    process.exit(2);
  }
  if (push && !apiKey) {
    log(`ERRO: ${config!.api_key_env} não definido no ambiente.`);
    process.exit(2);
  }

  // Mesma sequência de sync-apoio-nivel-beehiiv.ts::main() (extraída pra
  // runApoioReconciliationCycle, também duplicada em apoios-diff-alarm.ts —
  // precedente já estabelecido nesse arquivo pra este exato bloco): drena
  // Gmail (apoia.se) → importa notificações de PAGAMENTO CONFIRMADO como
  // contato → funde + reconcilia promessas pendentes do store → persiste.
  // Fail-soft pra tudo, EXCETO ApoiaSeAuthError — buildApoiosData relê
  // contacts.jsonl do disco a seguir, então qualquer contato
  // importado/promovido aqui já entra no cálculo do diff.
  const cycle = await runApoioReconciliationCycle(ROOT);
  if (cycle.drainSkipped) {
    log(`aviso: drain de promessas (Gmail) pulado (${cycle.drainSkipReason ?? "erro desconhecido"}) — reconciliação segue só com promessas já no store.`);
  }
  if (cycle.promessasDrained > 0) {
    log(`${cycle.promessasDrained} promessa(s) nova(s) drenada(s) do Gmail.`);
  }
  if (cycle.notificationsImported > 0) {
    log(`${cycle.notificationsImported} notificação(ões) de pagamento confirmado importada(s) como contato novo.`);
  }
  if (cycle.promoted.length > 0) {
    log(`${cycle.promoted.length} promessa(s) confirmada(s) como pagamento — promovida(s) a contato: ${cycle.promoted.map((p) => `${p.name} <${p.email}>`).join(", ")}`);
  }
  if (cycle.remainingPending.length > 0) {
    log(`${cycle.remainingPending.length} promessa(s) ainda pendente(s) (sem confirmação de pagamento).`);
  }
  if (cycle.stale.length > 0) {
    log(`aviso: ${cycle.stale.length} promessa(s) pendente(s) há mais de 90 dias sem confirmar — ver avisos acima.`);
  }
  if (cycle.warning) {
    log(`aviso: ${cycle.warning}`);
  }
  if (cycle.authError) {
    log(
      `ERRO FATAL: chave apoia.se rejeitada durante a reconciliação de promessas pendentes (${cycle.authError}) — ` +
        "verifique APOIA_SE_API_KEY/APOIA_SE_API_SECRET. Sync abortado antes de tocar a Brevo.",
    );
    process.exit(1);
  }

  const data = await buildApoiosData(ROOT);
  if (data.error) {
    log(`aviso: buildApoiosData reportou erro (dados podem estar incompletos): ${data.error}`);
  }

  const now = new Date();
  const currentMonth = competenceMonth(now);
  let pastSnapshots: MonthSnapshot[] = [];
  try {
    const env = readApoiaSeEnv();
    pastSnapshots = readPastMonthSnapshots(defaultCacheDir(env.campaign), currentMonth);
  } catch (e) {
    log(`aviso: não foi possível ler snapshots de meses anteriores (carência de 1 mês desativada nesta rodada): ${(e as Error).message}`);
  }

  const desired = computeDesiredApoioLevels(data.contacts, pastSnapshots, currentMonth);

  let current: BrevoApoiadorMember[] = [];
  if (config!.list_id != null && apiKey) {
    log("buscando membresia atual da lista Brevo dedicada…");
    current = await fetchCurrentBrevoApoiadoresState(apiKey, config!.list_id);
    log(`${current.length} contato(s) atualmente na lista Brevo.`);
  } else {
    log(
      "aviso: brevo_apoiadores.list_id e/ou API key ausente(s) — diff calculado assumindo lista vazia " +
        "(nenhum membro atual conhecido; normal antes da lista dedicada existir na Brevo).",
    );
  }

  const diff = diffApoioBrevo(desired, current);
  const allowPartial = hasFlag(argv, "allow-partial");
  const removalsBlockedByPartialData = shouldBlockRemovals(data.error, { skippedUnresolved: diff.skippedUnresolved }, allowPartial);
  const forceBlastRadius = hasFlag(argv, "force-blast-radius");
  const blastGuard = evaluateBrevoBlastRadiusGuard(diff.toRemove.length, current.length, forceBlastRadius);

  logDiff(diff, removalsBlockedByPartialData);
  logBlastRadiusGuard(blastGuard);

  if (!push) {
    log("dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.");
    return;
  }

  if (blastGuard.blocked) {
    log(
      "RECUSANDO o --push inteiro (guard de blast radius acima) — nenhuma mutação foi aplicada, nem " +
        "adições nem remoções. Confira se é uma virada de mês/instabilidade da apoia.se antes de usar " +
        "--force-blast-radius (decisão consciente do editor, sempre logada).",
    );
    process.exit(1);
  }

  if (removalsBlockedByPartialData && diff.toRemove.length > 0) {
    log(
      "RECUSANDO aplicar as remoções acima (dados parciais/sem_dados) — uma falha de rede não pode virar " +
        "remoção em massa de audiência. Re-tente, ou use --allow-partial pra prosseguir mesmo assim " +
        "(decisão consciente do editor, sempre logada).",
    );
  }

  const toRemoveNow = removalsBlockedByPartialData ? [] : diff.toRemove;

  const { applied, failed } = await applyBrevoApoioDiff(
    diff.toApply,
    toRemoveNow,
    config!.list_id as number,
    apiKey!,
    log,
  );

  log(`push concluído: ${applied} aplicada(s), ${failed} falha(s).`);
  if (failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
