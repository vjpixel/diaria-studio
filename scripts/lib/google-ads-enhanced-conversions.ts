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
 * ## ESTE MÓDULO NÃO RESOLVE A ISSUE INTEIRA (#7770)
 *
 * Três pré-requisitos ficam de fora, de propósito — nenhum é implementável
 * a partir daqui:
 *
 *   1. **Ação do editor no painel do Google Ads**: aceitar os termos de
 *      dados do cliente e habilitar Enhanced Conversions for Leads na
 *      conta. Sem isso a API recusa o upload (a chamada de rede vai falhar
 *      até essa ação acontecer).
 *   2. **Criar a ação de conversão de destino** (`UPLOAD_CLICKS`, categoria
 *      `SIGNUP`) — `7418673798 Assinatura Confirmada` é `WEBPAGE_CODELESS`
 *      e não aceita upload. O id/resource name da ação nova vai em
 *      `--conversion-action-id` (obrigatório, sem default — a issue não
 *      decidiu esse id ainda).
 *   3. **A lista real de e-mails/timestamps de 05-06/09** não é gerada por
 *      este script — ver a docstring do CLI
 *      (`scripts/upload-google-ads-enhanced-conversions.ts`) pra como
 *      derivá-la do Kit.
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
}

export interface ValidatedConversion {
  email: string;
  hashedEmail: string;
  conversionDateTime: string;
  /** `true` quando o timestamp é posterior ao corte E `allowPastCutoff` foi
   *  passado explicitamente — sinal pro CLI destacar mesmo tendo sido
   *  aceito. */
  pastCutoff: boolean;
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
  const candidates: Array<{ row: number; email: string; conversionDateTime: string; ms: number }> = [];

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

    candidates.push({ row, email, conversionDateTime: formatted, ms });
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
  userIdentifiers: Array<{ hashedEmail: string }>;
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
 * Nunca inclui `gclid`/`gbraid`/`wbraid` — é justamente a ausência desses
 * campos, substituídos por `userIdentifiers`, que caracteriza Enhanced
 * Conversions for Leads em vez de Offline Conversion Import clássico.
 *
 * @pure
 */
export function buildUploadClickConversionsPayload(
  conversions: ValidatedConversion[],
  opts: { conversionActionResourceName: string },
): UploadClickConversionsPayload {
  return {
    conversions: conversions.map((c) => ({
      conversionAction: opts.conversionActionResourceName,
      conversionDateTime: c.conversionDateTime,
      userIdentifiers: [{ hashedEmail: c.hashedEmail }],
    })),
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
    return { email, signupTimestamp };
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
