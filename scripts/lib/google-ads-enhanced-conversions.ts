/**
 * scripts/lib/google-ads-enhanced-conversions.ts (#7770)
 *
 * Núcleo do upload de Enhanced Conversions for Leads pro Google Ads —
 * recupera cadastros reais que chegaram durante a janela quebrada de
 * 05-06/09/2026 (rótulo de conversão morto, ver #7523) e que o Google nunca
 * viu. Sem `gclid` (decisão #5499 item 7), o único caminho é casar por
 * e-mail hasheado (SHA-256) via `ConversionUploadService.
 * uploadClickConversions` com `user_identifiers` em vez de `gclid`.
 *
 * ESCOPO DESTE MÓDULO: normalização/hash de e-mail, filtro de e-mails de
 * teste, validação do corte de segurança, montagem do payload REST, e o
 * POST em si (injetável, mesma disciplina de `fetchGoogleAdsSpendRows` em
 * `google-ads-ingest.ts`). A renovação de access token é REUSADA de lá
 * (`refreshGoogleAdsAccessToken`) — não duplicada aqui.
 *
 * ## ESTE MÓDULO NÃO RESOLVE A ISSUE INTEIRA (#7770, #8023)
 *
 * Pré-requisitos que ficam de fora, de propósito — nenhum é implementável a
 * partir daqui:
 *
 *   1. **Ação do editor no painel do Google Ads**: aceitar os termos de
 *      dados do cliente e habilitar Enhanced Conversions for Leads na
 *      conta. Sem isso a API recusa o upload (a chamada de rede vai falhar
 *      até essa ação acontecer).
 *   2. **A ação de conversão de destino já existe** — `Cadastro newsletter
 *      (recuperação #7770)` (`7758161410`, `UPLOAD_CLICKS`) já recebeu o
 *      upload original por click-id (21 gclid + 2 wbraid, ver #8023). O id
 *      vai em `--conversion-action-id`, sem default.
 *   3. **A lista real de e-mails/timestamps/click-ids** não é gerada por
 *      este script — ver a docstring do CLI
 *      (`scripts/upload-google-ads-enhanced-conversions.ts`) pra como
 *      derivá-la do Kit.
 *   4. **Reautorização OAuth com escopo `datamanager`** (#8023, decisão do
 *      editor) — ação manual do editor via
 *      `doppler run -- npx tsx scripts/google-ads-associate-token.ts --auth`.
 *      Este módulo já sobe o hash de e-mail via `uploadClickConversions`
 *      (Google Ads API padrão, escopo `adwords` — não exige `datamanager`
 *      hoje), mas o escopo é pré-requisito de conta pro Google habilitar
 *      Enhanced Conversions for Leads e pra uso futuro da Data Manager API
 *      propriamente dita.
 *
 * ## #8023 — hash de e-mail como PARÂMETRO ADICIONAL, não substituto do click-id
 *
 * Antes do #8023, `SignupRecordInput`/`ValidatedConversion` só carregavam
 * e-mail — o upload original de #7770 (21 gclid + 2 wbraid) foi feito por
 * fora deste módulo, direto na UI/Data Manager do Google Ads, sem hash de
 * e-mail. `gclid`/`wbraid`/`gbraid` agora são campos opcionais nos dois
 * tipos e em `ClickConversionPayload` — quando presentes, sobem JUNTO com
 * `userIdentifiers.hashedEmail` na MESMA entrada de `conversions[]`, sem
 * quebrar o caso já coberto (só e-mail, sem click-id) nem duplicar o evento
 * original.
 *
 * ## Por que o corte de 2026-09-06T12:27:00-03:00 é OBRIGATÓRIO, não best-effort
 *
 * A partir desse instante (publicação da v17 do container GTM, #7523) a tag
 * de conversão já registra ao vivo — subir de novo um cadastro posterior
 * duplicaria a contagem no histórico da conta. `validateSignupRecords`
 * recusa o LOTE INTEIRO (nenhuma linha é enviada, nem as anteriores ao
 * corte) quando encontra qualquer timestamp posterior, a menos que
 * `--allow-past-cutoff` seja passado explicitamente — decisão deliberada de
 * "tudo ou nada com gate": um lote com 1 linha pós-corte provavelmente tem
 * o range errado inteiro (export malfeito, fuso trocado), e enviar as
 * demais silenciosamente mascararia esse erro maior.
 *
 * ## E-mails de teste do editor
 *
 * Qualquer plus-address sob o Gmail pessoal do editor (`vjpixel+<tag>`,
 * mesmo domínio Gmail — ver `EDITOR_TEST_EMAIL_PATTERN` abaixo pro padrão
 * exato) nunca é audiência real — mesmo espírito de `TEST_ACCOUNT_PATTERNS`
 * em `scripts/lib/cohorts.ts`, mas deliberadamente MAIS AMPLO aqui: o
 * padrão de `cohorts.ts` (`/^vjpixel\+test/i`) não cobre o exemplo citado na
 * própria issue #7770 (`vjpixel+gtm-teste1`, mesmo domínio — o plus-tag
 * começa com "gtm-", não com "test"). Um upload de conversão tem blast radius
 * diferente de um envio de e-mail (contamina o MODELO de lance do Google,
 * não só a caixa de um assinante) — o filtro aqui erra para o lado de
 * excluir mais, não menos.
 */

import { createHash } from "node:crypto";
import type { GoogleAdsAuthConfig } from "./google-ads-ingest.ts";

// ---------------------------------------------------------------------------
// Normalização + hash de e-mail (Enhanced Conversions exige SHA-256 do
// e-mail normalizado — lowercase, trim; formato exigido por
// `UserIdentifier.hashed_email` do Google Ads API)
// ---------------------------------------------------------------------------

/** @pure */
export function normalizeEmailForHashing(email: string): string {
  return email.trim().toLowerCase();
}

/** SHA-256 hex do e-mail normalizado (lowercase, trim). @pure */
export function hashEmailForEnhancedConversions(email: string): string {
  return createHash("sha256").update(normalizeEmailForHashing(email), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// E-mails de teste do editor — nunca sobem como conversão
// ---------------------------------------------------------------------------

/** Qualquer plus-address sob o Gmail pessoal do editor (`vjpixel+<tag>`,
 *  mesmo domínio Gmail) — deliberadamente mais amplo que
 *  `TEST_ACCOUNT_PATTERNS` de `scripts/lib/cohorts.ts` (ver docstring do
 *  módulo acima). */
export const EDITOR_TEST_EMAIL_PATTERN = /^vjpixel\+.+@gmail\.com$/i;

/** @pure */
export function isEditorTestEmail(email: string): boolean {
  return EDITOR_TEST_EMAIL_PATTERN.test(email.trim());
}

// ---------------------------------------------------------------------------
// Corte de segurança (#7770) — nunca subir cadastro pós-fix
// ---------------------------------------------------------------------------

/** Instante em que a v17 do container GTM (#7523) começou a registrar
 *  conversões ao vivo — subir cadastro com timestamp posterior a este
 *  duplicaria a contagem no histórico da conta. */
export const ENHANCED_CONVERSIONS_CUTOFF_ISO = "2026-09-06T12:27:00-03:00";
export const ENHANCED_CONVERSIONS_CUTOFF_MS = Date.parse(ENHANCED_CONVERSIONS_CUTOFF_ISO);

// ---------------------------------------------------------------------------
// Formato de conversion_date_time exigido pela API
// (`"YYYY-MM-DD HH:MM:SS+TZ"`, ex: "2026-09-05 14:30:00-03:00")
// ---------------------------------------------------------------------------

const ISO_WITH_OFFSET = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Converte um timestamp ISO 8601 COM offset explícito (`...T...±HH:MM` ou
 * `...Z`) para o formato que `ConversionUploadService.uploadClickConversions`
 * exige — espaço em vez de `T`, offset PRESERVADO (nunca normalizado pra
 * UTC: a API quer a hora LOCAL do cadastro + o offset dela, não um instante
 * UTC reformatado). `Z` vira `+00:00` explícito. Retorna `null` (nunca
 * lança) pra qualquer entrada que não bata o formato — quem chama decide se
 * isso é erro fatal ou linha descartada.
 *
 * @pure
 */
export function formatConversionDateTime(iso: string): string | null {
  const m = ISO_WITH_OFFSET.exec(iso.trim());
  if (!m) return null;
  const [, date, time, offsetRaw] = m;
  const offset = offsetRaw === "Z" ? "+00:00" : offsetRaw;
  return `${date} ${time}${offset}`;
}

// ---------------------------------------------------------------------------
// Validação + montagem do lote
// ---------------------------------------------------------------------------

export interface SignupRecordInput {
  email: string;
  /** Timestamp ISO 8601 COM offset explícito do cadastro real (ex:
   *  "2026-09-05T14:30:00-03:00"). */
  signupTimestamp: string;
  /**
   * Click id opcional (#8023) — quando presente, sobe JUNTO com o hash do
   * e-mail no mesmo evento de conversão, em vez de o e-mail ser o único
   * identificador. Mantém o fluxo que já usa só click-id funcionando: um
   * registro pode ter `gclid`/`wbraid`/`gbraid` e nenhum `userIdentifiers`
   * extra se o e-mail vier vazio — mas `email` continua obrigatório neste
   * módulo (ver `validateSignupRecords`), então "só click-id" aqui quer
   * dizer "o e-mail é o hash ADICIONAL ao lado do click-id", não "sem
   * e-mail". Um lote genuinamente sem e-mail nenhum é o caminho antigo
   * (import manual pela UI do Google Ads), fora do escopo deste módulo.
   */
  gclid?: string;
  wbraid?: string;
  gbraid?: string;
}

export interface ValidatedConversion {
  email: string;
  hashedEmail: string;
  conversionDateTime: string;
  /** `true` quando o timestamp é posterior ao corte E `allowPastCutoff` foi
   *  passado explicitamente — sinal pro CLI destacar mesmo tendo sido
   *  aceito. */
  pastCutoff: boolean;
  /** Click id opcional (#8023) — repassado de `SignupRecordInput`, ver ali. */
  gclid?: string;
  wbraid?: string;
  gbraid?: string;
}

export interface SkippedRecord {
  row: number;
  email: string;
  reason: string;
}

export type ValidateSignupRecordsResult =
  | {
      ok: true;
      conversions: ValidatedConversion[];
      skippedTestEmails: SkippedRecord[];
      skippedMalformed: SkippedRecord[];
      pastCutoffCount: number;
    }
  | {
      ok: false;
      reason: string;
      violatingRows: SkippedRecord[];
    };

export interface ValidateSignupRecordsOptions {
  /** Default `false` — presença de QUALQUER timestamp pós-corte recusa o
   *  lote INTEIRO (nenhuma linha enviada). */
  allowPastCutoff?: boolean;
  /** Injetável pra teste; default `ENHANCED_CONVERSIONS_CUTOFF_MS`. */
  cutoffMs?: number;
}

/**
 * Valida e normaliza um lote de cadastros pra upload — 3 filtros, NESTA
 * ordem: (1) e-mail vazio/de teste do editor → descartado silenciosamente
 * do lote, nunca aborta o resto; (2) timestamp malformado → descartado,
 * nunca aborta o resto; (3) timestamp pós-corte → aborta o LOTE INTEIRO
 * (nenhuma conversão sai) a menos que `allowPastCutoff: true`.
 *
 * A ordem importa: um e-mail de teste com timestamp pós-corte não deveria
 * disparar o abort do lote inteiro por causa de uma linha que já ia ser
 * descartada de qualquer forma — por isso o filtro de teste roda ANTES da
 * checagem de corte.
 *
 * @pure
 */
export function validateSignupRecords(
  records: SignupRecordInput[],
  opts: ValidateSignupRecordsOptions = {},
): ValidateSignupRecordsResult {
  const cutoffMs = opts.cutoffMs ?? ENHANCED_CONVERSIONS_CUTOFF_MS;
  const allowPastCutoff = opts.allowPastCutoff ?? false;

  const skippedTestEmails: SkippedRecord[] = [];
  const skippedMalformed: SkippedRecord[] = [];
  const candidates: Array<{
    row: number;
    email: string;
    conversionDateTime: string;
    ms: number;
    gclid?: string;
    wbraid?: string;
    gbraid?: string;
  }> = [];

  records.forEach((record, idx) => {
    const row = idx + 1;
    const email = (record.email ?? "").trim();

    if (!email) {
      skippedMalformed.push({ row, email, reason: "e-mail vazio/ausente" });
      return;
    }
    if (isEditorTestEmail(email)) {
      skippedTestEmails.push({ row, email, reason: "e-mail de teste do editor (vjpixel+ plus-address no Gmail pessoal)" });
      return;
    }

    const formatted = formatConversionDateTime(record.signupTimestamp ?? "");
    const ms = Date.parse(record.signupTimestamp ?? "");
    if (!formatted || !Number.isFinite(ms)) {
      skippedMalformed.push({
        row,
        email,
        reason: `signupTimestamp inválido (esperado ISO 8601 com offset explícito, ex: "2026-09-05T14:30:00-03:00"): "${record.signupTimestamp}"`,
      });
      return;
    }

    candidates.push({
      row,
      email,
      conversionDateTime: formatted,
      ms,
      gclid: record.gclid?.trim() || undefined,
      wbraid: record.wbraid?.trim() || undefined,
      gbraid: record.gbraid?.trim() || undefined,
    });
  });

  const violatingRows: SkippedRecord[] = candidates
    .filter((c) => c.ms > cutoffMs)
    .map((c) => ({
      row: c.row,
      email: c.email,
      reason: `conversion_date_time (${c.conversionDateTime}) é posterior ao corte de segurança (${ENHANCED_CONVERSIONS_CUTOFF_ISO})`,
    }));

  if (violatingRows.length > 0 && !allowPastCutoff) {
    return {
      ok: false,
      reason:
        `${violatingRows.length} cadastro(s) com timestamp posterior ao corte de segurança ` +
        `${ENHANCED_CONVERSIONS_CUTOFF_ISO} (a partir dali a tag do GTM já registra ao vivo — subir de ` +
        `novo duplicaria a contagem no histórico da conta). Nenhuma conversão foi enviada. Passe ` +
        `--allow-past-cutoff só se tiver certeza de que esses cadastros específicos ainda não foram ` +
        `contados pela tag ao vivo.`,
      violatingRows,
    };
  }

  const conversions: ValidatedConversion[] = candidates.map((c) => ({
    email: c.email,
    hashedEmail: hashEmailForEnhancedConversions(c.email),
    conversionDateTime: c.conversionDateTime,
    pastCutoff: c.ms > cutoffMs,
    gclid: c.gclid,
    wbraid: c.wbraid,
    gbraid: c.gbraid,
  }));

  return {
    ok: true,
    conversions,
    skippedTestEmails,
    skippedMalformed,
    pastCutoffCount: conversions.filter((c) => c.pastCutoff).length,
  };
}

// ---------------------------------------------------------------------------
// Payload REST — ConversionUploadService.uploadClickConversions
// ---------------------------------------------------------------------------

export interface ClickConversionPayload {
  conversionAction: string;
  conversionDateTime: string;
  /**
   * Omitido quando o registro não carrega e-mail (nunca acontece hoje — ver
   * nota em `SignupRecordInput` — mas o tipo permanece opcional pra não
   * forçar a chave a existir em todo payload, mesmo comportamento observável
   * de antes do #8023: `"userIdentifiers" in payload` só é `true` quando há
   * pelo menos um identificador de usuário).
   */
  userIdentifiers?: Array<{ hashedEmail: string }>;
  /** Click id (#8023) — presente só quando o registro de entrada trouxe um.
   *  Nunca os três ao mesmo tempo na prática (gclid XOR wbraid/gbraid), mas
   *  o tipo não impõe isso — a API do Google Ads que valida. */
  gclid?: string;
  wbraid?: string;
  gbraid?: string;
}

export interface UploadClickConversionsPayload {
  conversions: ClickConversionPayload[];
  partialFailure: true;
  /** Sempre `false` neste caminho — o modo dry-run do CLI nunca chega a
   *  montar/enviar uma chamada de rede (ver docstring do CLI), então não há
   *  uso pra `validateOnly: true` aqui. Campo mantido explícito no payload
   *  porque é assim que a API real distingue os dois modos, caso um
   *  chamador futuro precise ligar essa opção. */
  validateOnly: false;
}

/**
 * Resolve o resource name da ação de conversão — aceita tanto o id numérico
 * cru (`--conversion-action-id 7418673800`) quanto o resource name completo
 * já montado (`customers/236.../conversionActions/741...`), pra não forçar
 * quem chama a montar a string à mão.
 *
 * @pure
 */
export function resolveConversionActionResourceName(
  customerId: string,
  conversionActionIdOrResourceName: string,
): string {
  const raw = conversionActionIdOrResourceName.trim();
  if (raw.startsWith("customers/")) return raw;
  const cleanCustomerId = customerId.replace(/[^0-9]/g, "");
  return `customers/${cleanCustomerId}/conversionActions/${raw}`;
}

/**
 * Monta o corpo de `POST /v{N}/customers/{id}:uploadClickConversions`.
 *
 * Até #8023, este builder SEMPRE incluía `userIdentifiers` e NUNCA
 * `gclid`/`gbraid`/`wbraid` — a ausência desses campos era o que
 * caracterizava Enhanced Conversions for Leads em vez de Offline Conversion
 * Import clássico. #8023 (decisão do editor) muda isso: o hash de e-mail
 * passa a ser um PARÂMETRO ADICIONAL no mesmo evento, não um substituto —
 * quando o registro validado carrega `gclid`/`wbraid`/`gbraid` (#8023,
 * `SignupRecordInput`), o click id vai JUNTO com `userIdentifiers` na mesma
 * entrada de `conversions[]`, em vez dos dois caminhos serem mutuamente
 * exclusivos. Isso é exatamente o que a ação de recuperação #7770 pedia: o
 * evento `Cadastro newsletter (recuperação #7770)` já sobe por click-id
 * (21 gclid + 2 wbraid, ver #8023) — este builder deixa de forçar a
 * reescrever esse lote do zero, só adiciona o sinal que faltava.
 *
 * `userIdentifiers` só aparece na entrada quando há hash de e-mail (sempre
 * o caso hoje, `email` é obrigatório em `SignupRecordInput` — ver ali) — a
 * chave nunca aparece vazia/undefined explícita no objeto.
 *
 * @pure
 */
export function buildUploadClickConversionsPayload(
  conversions: ValidatedConversion[],
  opts: { conversionActionResourceName: string },
): UploadClickConversionsPayload {
  return {
    conversions: conversions.map((c) => {
      const entry: ClickConversionPayload = {
        conversionAction: opts.conversionActionResourceName,
        conversionDateTime: c.conversionDateTime,
      };
      if (c.hashedEmail) entry.userIdentifiers = [{ hashedEmail: c.hashedEmail }];
      if (c.gclid) entry.gclid = c.gclid;
      if (c.wbraid) entry.wbraid = c.wbraid;
      if (c.gbraid) entry.gbraid = c.gbraid;
      return entry;
    }),
    partialFailure: true,
    validateOnly: false,
  };
}

// ---------------------------------------------------------------------------
// Parsing de input (CSV/JSON) — puro, recebe o conteúdo já lido do disco
// ---------------------------------------------------------------------------

export interface ParseSignupInputResult {
  records: SignupRecordInput[];
  parseErrors: string[];
}

/** Aceita cabeçalhos `email`/`Email` e `signup_timestamp`/`signupTimestamp`/
 *  `timestamp` (case-sensitive nas 3 variantes, mas cobre os nomes mais
 *  prováveis de um export manual do Kit). @pure — recebe o conteúdo já lido,
 *  não abre arquivo. */
export function parseSignupCsv(content: string, parseCsvFn: (content: string) => { data: unknown[]; errors: Array<{ row?: number; message: string }> }): ParseSignupInputResult {
  const result = parseCsvFn(content);
  const parseErrors = result.errors.map(
    (e) => `linha ${typeof e.row === "number" ? e.row + 2 : "?"}: ${e.message}`,
  );
  const records: SignupRecordInput[] = (result.data as Array<Record<string, string>>).map((row) => ({
    email: (row.email ?? row.Email ?? "").trim(),
    signupTimestamp: (row.signup_timestamp ?? row.signupTimestamp ?? row.timestamp ?? "").trim(),
    // #8023 — click id opcional, colunas adicionais que o CSV de recuperação
    // do #7770 já carrega (21 gclid + 2 wbraid); ausentes em qualquer linha
    // que não tenha click id, sem quebrar o parser de e-mail-só existente.
    gclid: (row.gclid ?? row.Gclid ?? "").trim() || undefined,
    wbraid: (row.wbraid ?? row.Wbraid ?? "").trim() || undefined,
    gbraid: (row.gbraid ?? row.Gbraid ?? "").trim() || undefined,
  }));
  return { records, parseErrors };
}

/** @pure — recebe o conteúdo já lido, não abre arquivo. Lança em JSON
 *  malformado/formato inesperado (não há "linha parcial" sensata pra
 *  recuperar de um JSON quebrado, diferente do CSV linha-a-linha acima). */
export function parseSignupJson(content: string): SignupRecordInput[] {
  const parsed: unknown = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error("JSON de entrada deve ser um array de objetos {email, signupTimestamp}.");
  }
  return parsed.map((row, idx) => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`item ${idx + 1} do JSON de entrada não é um objeto.`);
    }
    const r = row as Record<string, unknown>;
    const email = String(r.email ?? "").trim();
    const signupTimestamp = String(r.signupTimestamp ?? r.signup_timestamp ?? "").trim();
    // #8023 — click id opcional, mesma lógica do parser de CSV acima.
    const gclid = r.gclid !== undefined ? String(r.gclid).trim() || undefined : undefined;
    const wbraid = r.wbraid !== undefined ? String(r.wbraid).trim() || undefined : undefined;
    const gbraid = r.gbraid !== undefined ? String(r.gbraid).trim() || undefined : undefined;
    return { email, signupTimestamp, gclid, wbraid, gbraid };
  });
}

// ---------------------------------------------------------------------------
// Upload real (injetável — mesma disciplina de `fetchGoogleAdsSpendRows` em
// google-ads-ingest.ts: nunca lança, todo estado vira retorno)
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Mesmo default de `google-ads-ingest.ts` (`DEFAULT_API_VERSION`, não
 *  exportado de lá) — duplicado aqui de propósito em vez de importado,
 *  porque essa constante não é exportada pelo módulo original; mudar a
 *  versão em produção exige atualizar as duas ocorrências. */
const DEFAULT_API_VERSION = "v25";

export type UploadClickConversionsResult =
  | { ok: true; response: unknown }
  | { ok: false; error: string };

/**
 * POST `customers/{id}:uploadClickConversions`. Nunca lança — falha de
 * rede, HTTP não-2xx ou corpo não-JSON viram `{ ok: false, error }`.
 */
export async function uploadClickConversions(
  fetchImpl: FetchLike,
  auth: GoogleAdsAuthConfig,
  accessToken: string,
  payload: UploadClickConversionsPayload,
): Promise<UploadClickConversionsResult> {
  const apiVersion = auth.apiVersion ?? DEFAULT_API_VERSION;
  const customerId = auth.customerId.replace(/[^0-9]/g, "");
  const url = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}:uploadClickConversions`;

  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": auth.developerToken,
        "login-customer-id": auth.loginCustomerId.replace(/[^0-9]/g, ""),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, error: `falha de rede em uploadClickConversions: ${e instanceof Error ? e.message : e}` };
  }

  if (!res.ok) {
    return { ok: false, error: `uploadClickConversions respondeu HTTP ${res.status}: ${text.slice(0, 800)}` };
  }

  try {
    return { ok: true, response: JSON.parse(text) };
  } catch {
    return { ok: false, error: `uploadClickConversions respondeu corpo não-JSON (HTTP ${res.status}): ${text.slice(0, 200)}` };
  }
}
