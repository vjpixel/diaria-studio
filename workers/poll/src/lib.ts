/**
 * workers/poll/src/lib.ts — helpers puros do Worker `poll`.
 *
 * Funções aqui não dependem de Cloudflare runtime (KV, env, crypto.subtle,
 * fetch). Extraído de `index.ts` pra permitir testes Node sem mock do
 * Worker runtime (#1083).
 */
// #3113: tokens do DS canônico — mesma fonte usada por leaderboard-routes.ts e
// index.ts (ver nota em #3111 sobre bundle Cloudflare separado).
import { DS_COLORS } from "./ds-tokens.generated";

// ── Trailing slash normalization (#1319) ────────────────────────────────────

/**
 * Retorna o path sem trailing slash se redirect for necessário, ou null se
 * o path original já está canonical. Usado pra emitir 301 → versão sem slash
 * antes do router que faz strict equality match.
 *
 * Regras:
 * - Raiz "/" preservada (não é trailing-slash redundante)
 * - /img/{key} preservado (prefix match, key pode terminar em "/" raro)
 * - Tudo mais com trailing slash redireciona pra versão sem
 */
export function redirectTargetForTrailingSlash(path: string): string | null {
  if (path.length > 1 && path.endsWith("/") && !path.startsWith("/img/")) {
    return path.slice(0, -1);
  }
  return null;
}

// ── Date formatting (#1080) ──────────────────────────────────────────────────

export const MONTH_NAMES_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** AAMMDD → "10 de maio de 2026". Memória `feedback_no_aammdd_for_subscribers.md`.
 * Invalid input (não-AAMMDD, MM/DD fora de range) → retorna input cru (safe). */
export function formatEditionDate(edition: string): string {
  if (!/^\d{6}$/.test(edition)) return edition;
  const yy = parseInt(edition.slice(0, 2), 10);
  const mm = parseInt(edition.slice(2, 4), 10);
  const dd = parseInt(edition.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return edition;
  return `${dd} de ${MONTH_NAMES_PT[mm - 1]} de ${2000 + yy}`;
}

// ── HTML escape (#1083) ──────────────────────────────────────────────────────

/** Escape HTML attribute/text — previne XSS quando valores user-controlled
 * (ex: email do subscriber) são interpolados no votePageHtml form. */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── valid_editions validation (#1086) ────────────────────────────────────────

/** Parseia raw KV value de `valid_editions` retornando set ou null se ausente.
 * Corrupted JSON ou shape inválido → console.error + null (fail-open). */
export function parseValidEditions(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error("[parseValidEditions] not array:", typeof parsed);
      return null;
    }
    return parsed.filter((x): x is string => typeof x === "string");
  } catch (e) {
    console.error("[parseValidEditions] JSON parse failed:", (e as Error).message);
    return null;
  }
}

/**
 * #2262: detecta merge tag NÃO-substituída no campo email. Quando a plataforma
 * de envio não substitui o token (test send, preview, contato sem atributo), o
 * literal entra no `?email=` — ex: Brevo `{{ contact.EMAIL }}` (→ mangled p/
 * `{{+contact.email+}}` pelo replace ` `→`+`), Beehiiv `{{ subscriber.email }}`
 * ou `{{email}}`. `{{`/`}}` é assinatura inequívoca. Usado pra rejeitar o voto
 * (400) antes de escrever no KV, evitando voto-lixo no leaderboard público.
 */
export function isUnsubstitutedMergeTag(email: string): boolean {
  return email.includes("{{") || email.includes("}}");
}

/** True se edition está autorizada a receber votos. null/empty = aceita qualquer (compat). */
export function isValidEdition(set: string[] | null, edition: string): boolean {
  if (!set || set.length === 0) return true;
  return set.includes(edition);
}

// ── Validação de formato/tamanho de email e edition (#3118 item 3) ─────────
//
// `email` e `edition` viram componentes de chave KV (`vote:{edition}:{email}`,
// `score:{email}`, `counted:{edition}:{email}:*`). Sem validação mínima, um
// email malformado (sem "@"/domínio, ou >254 chars) ou um `edition` lixo
// produz uma key KV que pode passar de 512 bytes — Workers KV lança exceção
// nesse caso (500 possivelmente após incrementos parciais já terem rodado).
// Pra `brand=clarice`, `valid_editions` nunca é populado (#2018 — fail-open
// permanente), então sem este gate qualquer `edition` chegava direto no
// schema de chave sem checagem nenhuma.
//
// Deliberadamente permissivo — não é validação RFC 5321 completa (não
// rejeita TLDs inválidos, IPs literais, etc.) — só recusa o que quebraria o
// KV ou claramente não tem a forma de um email.

/** #3118 item 3: forma mínima `local@domínio.tld`, sem espaços, ≤254 chars
 * (limite prático de endereço de email, RFC 3696 errata).
 *
 * #3279 (charset hardening): também rejeita `:` explicitamente em cada
 * segmento — antes `[^\s@]+` permitia qualquer caractere fora de espaço/`@`,
 * então um email como `attacker@evil:x.com` passava. `email`/`edition` viram
 * componentes de uma chave KV (`vote:{edition}:{email}`) sem sanitização
 * adicional; um `:` cru nesses campos pode alterar a estrutura da chave.
 * Defesa em profundidade — a cadeia de exploit confirmada (#3279) usa o `:`
 * em `edition`, não em `email`, mas o mesmo caractere é igualmente perigoso
 * aqui por composição do template de chave. */
export function isValidVoteEmailFormat(email: string): boolean {
  if (email.length === 0 || email.length > 254) return false;
  return /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(email);
}

/**
 * #3118 (item 3) / #3279 (charset hardening): valida a FORMA do componente
 * `edition` da chave KV — não só o comprimento. Aceita só os 2 formatos
 * legítimos usados pelo pipeline: AAMMDD legado (`^\d{6}$`, diária) ou ciclo
 * Clarice `YYMM-MM` (`^\d{4}-\d{2}$`, #2115). Ambos os ramos já são
 * mutuamente exclusivos e bounded em comprimento pelo próprio regex — não
 * precisa de checagem de `.length` separada.
 *
 * Não faz validação SEMÂNTICA de range (mês 00/13, dia inválido etc.) — isso
 * continua responsabilidade de `isValidEdition`/`editionToMonthSlug`
 * downstream. Aqui só garante charset+forma antes de qualquer uso em
 * template de chave KV.
 *
 * Antes desta versão, a checagem era só de COMPRIMENTO (`length > 0 && <=
 * 32`), permitindo qualquer caractere — inclusive `:` — passar. Um `edition`
 * como `"2607-08:evil"` (13 chars, sob o teto de 32) produzia uma chave KV
 * `vote:2607-08:evil:attacker@x.com` que ainda batia no prefixo escaneado
 * por `handleAdminCorrect` (`vote:{edition}:`) — poluindo correções
 * administrativas de score sem autenticação nenhuma (modo merge-tag não
 * exige HMAC). Achado de segurança #3279, cadeia de exploit verificada
 * linha por linha contra `vote.ts`/`index.ts`.
 */
export function isValidVoteEditionFormat(edition: string): boolean {
  return /^\d{6}$/.test(edition) || /^\d{4}-\d{2}$/.test(edition);
}

// ── Máscara de email pra exibição pública (#3118 item 11) ──────────────────

/**
 * Mascara email pra exibição pública (`usuario@***`) — nunca revela o
 * domínio. Consolida 3 implementações quase-idênticas que existiam
 * espalhadas em leaderboard-routes.ts (×2) e index.ts (×1) — risco real de
 * divergirem entre si (uma delas já tinha um fallback pra email sem "@" que
 * as outras duas não tinham).
 *
 * Fallback pra string sem "@" (não deveria ocorrer em produção — email
 * sempre vem de `score:{email}`/voto validado, e desde #3118 item 3 todo
 * novo voto passa por `isValidVoteEmailFormat` — mas defensivo pra dados
 * históricos pré-validação): mascara os 4 primeiros chars + "***" em vez de
 * devolver a string crua sem máscara nenhuma.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at > 0) return `${email.slice(0, at)}@***`;
  return `${email.slice(0, 4)}***`;
}

// ── Per-publication-month leaderboard (#1345) ───────────────────────────────

/**
 * Pure: AAMMDD → "YYYY-MM" (mês de publicação). Usado pra computar a key
 * `score-by-month:{slug}:{email}` no write path (#1345). Assume `20YY`
 * (consistente com formatEditionDate). Retorna null se input mal-formado.
 *
 * #2115: aceita também o formato de ciclo Clarice `YYMM-MM` (ex: `2605-06`),
 * onde YYMM é o mês do CONTEÚDO e MM é o mês do ENVIO. O bucket do leaderboard
 * usa o mês do CONTEÚDO (2026-05), mantendo o mesmo bucket do formato legado
 * 260531 que a AAMMDD-branch usava. Back-compat: 260531 segue funcionando.
 */
export function editionToMonthSlug(edition: string): string | null {
  // #2115: ciclo Clarice YYMM-MM (ex: "2605-06") → slug do mês do CONTEÚDO
  if (/^\d{4}-\d{2}$/.test(edition)) {
    const yy = edition.slice(0, 2);
    const mm = edition.slice(2, 4);
    const mmNum = parseInt(mm, 10);
    if (mmNum < 1 || mmNum > 12) return null;
    return `20${yy}-${mm}`;
  }
  // Formato legado AAMMDD (diária + mensal pre-#2115)
  if (!/^\d{6}$/.test(edition)) return null;
  const yy = edition.slice(0, 2);
  const mm = edition.slice(2, 4);
  const mmNum = parseInt(mm, 10);
  if (mmNum < 1 || mmNum > 12) return null;
  return `20${yy}-${mm}`;
}

/**
 * #3261: dado um ciclo Clarice `YYMM-MM` (ver `editionToMonthSlug`), deriva o
 * identificador AAMMDD LEGADO que a MESMA edição usava ANTES do cutover
 * #2115 (commit 370fba43, 2026-06-11) — YY+MM+últimoDiaDoMês do mês de
 * CONTEÚDO (`YYMM`). Espelha byte-a-byte a fórmula antiga de
 * `eiaEditionFromYymm` (scripts/lib/mensal/monthly-render.ts, pré-#2115):
 *
 *   yr = 2000 + parseInt(yymm.slice(0,2))
 *   mo = parseInt(yymm.slice(2,4))
 *   lastDay = new Date(Date.UTC(yr, mo, 0)).getUTCDate()
 *   → `${yy}${mm}${lastDay}`
 *
 * Ex: "2605-06" (digest de maio, enviado em junho) → "260531".
 *     "2604-05" → "260430". "2603-04" → "260331".
 *
 * Motivação (issue #3261): ciclos enviados ANTES do cutover gravaram seus
 * votos sob a chave AAMMDD legada (era a ÚNICA forma que existia então) — uma
 * consulta `/stats?edition=2605-06` busca só a chave NOVA e nunca encontra
 * esses votos, mesmo eles existindo de fato no KV sob `stats:260531`.
 * `handleStats` (vote.ts) usa este helper para consultar AMBAS as chaves
 * quando o caller pede stats por ciclo, generalizando para qualquer ciclo
 * futuro que tenha essa mesma ambiguidade — não hardcoded pros 3 ciclos
 * específicos da issue.
 *
 * Retorna null se `edition` não é formato de ciclo (`^\d{4}-\d{2}$` — ex:
 * AAMMDD diário não precisa de fallback, nunca teve 2 formatos) ou se o mês
 * de CONTEÚDO (`MM` em `YYMM`) é semanticamente inválido (0 ou >12).
 */
export function legacyMonthlyEditionForCycle(edition: string): string | null {
  const m = edition.match(/^(\d{2})(\d{2})-\d{2}$/);
  if (!m) return null;
  const [, yy, mm] = m;
  const yr = 2000 + parseInt(yy, 10);
  const moNum = parseInt(mm, 10);
  if (moNum < 1 || moNum > 12) return null;
  const lastDay = new Date(Date.UTC(yr, moNum, 0)).getUTCDate();
  return `${yy}${mm}${String(lastDay).padStart(2, "0")}`;
}

/**
 * Pure: parseia slug "YYYY-MM" → {year, month}. Retorna null em formato
 * ou range inválido (mês 0, 13, ano fora 2000-2099).
 */
export function parseMonthSlug(slug: string): { year: number; month: number } | null {
  const m = slug.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  if (year < 2000 || year > 2099) return null;
  return { year, month };
}

/**
 * Pure: slug "YYYY-MM" do mês corrente em BRT. Análogo a
 * `currentPeriodLabelBrt` mas formato slug ao invés de label legível.
 */
export function currentMonthSlugBrt(now: Date): string {
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const year = brt.getUTCFullYear();
  const month = String(brt.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Pure (#3113 item 9): "hoje" em AAMMDD (BRT) — mesmo offset fixo de -3h usado
 * em toda formatação de data deste worker. Usado só pra comparação
 * lexicográfica contra edições AAMMDD (strings zero-padded de mesmo tamanho
 * comparam igual a números).
 *
 * Movido pra cá (era privado em leaderboard-routes.ts) pra ser reusado
 * também por `handleVote` em vote.ts — sem isso, o gate de "edição futura"
 * só existia na LISTAGEM do arquivo (`extractEditionsForYear`) e na página de
 * voto do arquivo (`handleArchiveVotePage`), mas o endpoint `/vote` que de
 * fato REGISTRA o voto continuava aceitando uma edição futura via URL direta
 * (email+edition+choice montados manualmente), já que seu gate original só
 * checava `correctRaw === null` — e `correct:{edition}` já está setado antes
 * do e-mail sair (durante prep de imagens/revisão).
 */
export function todayAammddBrt(now: Date): string {
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const yy = String(brt.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(brt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(brt.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Pure: -1 se a<b, 0 se igual, 1 se a>b. Slugs "YYYY-MM" zero-padded
 * comparam lexicograficamente bem — string compare basta.
 */
export function monthSlugCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ── Period label (#1083) ─────────────────────────────────────────────────────

/**
 * Retorna o nome do mês em pt-BR (capitalizado) baseado em `now` interpretado
 * em BRT (UTC-3). Usado como `periodLabel` no leaderboard.
 *
 * Pure pra testabilidade — caller passa Date determinístico em testes.
 *
 * Exemplo: `currentPeriodLabelBrt(new Date('2026-06-01T02:30:00Z'))` → "Maio"
 * (UTC-3 ainda é 31 de maio às 23:30 BRT).
 */
export function currentPeriodLabelBrt(now: Date): string {
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const monthName = MONTH_NAMES_PT[brt.getUTCMonth()];
  return monthName.charAt(0).toUpperCase() + monthName.slice(1);
}

// ── Reset mensal do leaderboard (#1077) ─────────────────────────────────────

/**
 * Retorna a chave de archive `score-archive:{YYYY-MM}:{email}` pra arquivar
 * o score antes do reset. YYYY-MM é o mês **anterior** (acabou de fechar) em
 * BRT — quando o cron roda no dia 1 às 03:01 UTC (00:01 BRT), o mês a arquivar
 * é o mês prévio.
 *
 * Pure — caller passa `now` determinístico em testes.
 */
export function archiveKeyForReset(email: string, now: Date): string {
  // Subtrair 1 dia pra cair no mês anterior (cron roda no dia 1 do novo mês)
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  brt.setUTCDate(0); // dia 0 do mês atual = último dia do mês anterior
  const year = brt.getUTCFullYear();
  const month = String(brt.getUTCMonth() + 1).padStart(2, "0");
  return `score-archive:${year}-${month}:${email}`;
}

/** Retorna a label do mês que acabou de fechar (usado no reset-log). */
export function previousPeriodLabelBrt(now: Date): string {
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  brt.setUTCDate(0); // dia 0 do mês atual = último dia do mês anterior
  const monthName = MONTH_NAMES_PT[brt.getUTCMonth()];
  return monthName.charAt(0).toUpperCase() + monthName.slice(1);
}

// ── 403 reason classifier (#1468) ───────────────────────────────────────────

export type Vote403Reason = "sig_empty" | "sig_invalid";

/**
 * Classifica a razão de um 403 no /vote pra logging estruturado. Caller já
 * decidiu que hmacVerify falhou; aqui só desambiguamos sig vazio (subscriber
 * sem poll_sig populado — cenário do #1186) vs sig com valor (HMAC mismatch
 * por rotation, tampering, ou edição antiga).
 *
 * `sig === null` não chega aqui — index.ts guarda `if (sig !== null)` antes
 * de chamar hmacVerify, então sig ausente do URL é merge-tag mode (200).
 */
export function classify403Reason(sig: string): Vote403Reason {
  return sig === "" ? "sig_empty" : "sig_invalid";
}

// ── Brand namespacing do leaderboard (#1905) ────────────────────────────────

/**
 * Marcas que têm leaderboard É IA? próprio. `diaria` é o diário (Beehiiv);
 * `clarice` é o digest mensal (Clarice News / Brevo). Cada uma tem ranking,
 * gate de edições e apelidos isolados.
 */
export type Brand = "diaria" | "clarice";

/**
 * #2018: leaderboardPeriod — período canônico do leaderboard por brand.
 * "month" = diária (votos diários, ranking mensal); "year" = clarice (1 voto/mês,
 * ranking anual faz mais sentido). Antes estava espalhado em 5+ pontos do código
 * como `periodKind === "year"` checado ad-hoc. Centralizar aqui garante que
 * adicionar um brand novo só precisa de 1 linha.
 *
 * Consumido em: handleLeaderboardByYear (dispatch pra "year" só pra clarice),
 * leaderboardHref (slug mensal→anual só pra clarice), renderLeaderboardHtml
 * (título/copy por período).
 */
export const BRAND_INFO: Record<Brand, { name: string; siteUrl: string; leaderboardPeriod: "month" | "year"; shortName?: string }> = {
  diaria: { name: "Diar.ia", siteUrl: "https://diar.ia.br", leaderboardPeriod: "month" },
  // #1910: via=diaria é o tracking de afiliado (Rewardful) — todo link da
  // Clarice voltado ao leitor precisa carregar.
  // #2018: leaderboardPeriod: "year" — mensal vota 1×/mês, ranking anual até 12 chances.
  // #3108: shortName — a sub-copy do leaderboard clarice linka só "Clarice" (não
  // "Clarice News" inteiro) na frase "newsletter da Clarice".
  clarice: { name: "Clarice News", siteUrl: "https://clarice.ai/?via=diaria", leaderboardPeriod: "year", shortName: "Clarice" },
};

/**
 * Lê `?brand=` e normaliza. Só `clarice` é não-default; qualquer outro valor
 * (ausente, typo, "diaria") cai em `diaria` — back-compat: as chaves KV legadas
 * (sem prefixo) pertencem ao diário.
 *
 * #3118 (item 12): derivado de `Object.keys(BRAND_INFO)` em vez de comparar
 * contra o literal `"clarice"` hardcoded — um 3º brand adicionado a
 * `BRAND_INFO` fica automaticamente aceito aqui sem editar esta função.
 */
export function parseBrandParam(raw: string | null): Brand {
  const validKeys = Object.keys(BRAND_INFO) as string[];
  return raw !== null && validKeys.includes(raw) ? (raw as Brand) : "diaria";
}

/**
 * Prefixo de KV por brand. Vazio para `diaria` (chaves legadas intactas:
 * `score-by-month:...`, `vote:...`), `clarice:` para a Clarice
 * (`clarice:score-by-month:...`). Isola os dois rankings.
 */
export function brandKvPrefix(brand: Brand): string {
  return brand === "diaria" ? "" : `${brand}:`;
}

/**
 * #3112: variante de `formatEditionDate` ciente de `BRAND_INFO[brand].leaderboardPeriod`.
 *
 * Mesmo racional do #2006 (vote.ts, mensagem "já votou"): pra um brand com
 * leaderboard ANUAL (`"year"` — hoje só `clarice`), a publicação é MENSAL —
 * o "dia" do AAMMDD é só artefato do formato do código da edição, não um
 * dado real (a Clarice News não sai num dia específico do mês). Exibir
 * "31 de maio de 2026" para um digest mensal é enganoso.
 *
 *   - `leaderboardPeriod === "year"` → formata só "Mês de AAAA" (sem dia).
 *   - `leaderboardPeriod === "month"` (diária) → mantém `formatEditionDate`
 *     completo ("DD de mês de AAAA") — comportamento inalterado.
 *
 * #3113 (item 13, self-review pós-#3192): também aceita o ciclo Clarice
 * `YYMM-MM` (ex: `2605-06` — ver `editionToMonthSlug`, #2115). A mensagem
 * "já votou" (vote.ts) passa o `edition` cru da URL de voto pra esta função,
 * e pro brand `clarice` esse `edition` É o ciclo (não AAMMDD) — ver
 * `close-poll.ts --brand clarice --edition 2605-06 --cycle 2605-06` e os
 * links de voto gerados em `monthly-render.ts` (`edition=${edition}` já no
 * formato de ciclo). Sem este ramo, a mensagem "já votou" mostraria o slug
 * interno cru ("2605-06") pro leitor em vez de um mês legível.
 *
 * NÃO altera o código da edição interno usado em hrefs/gabarito/dedup — só a
 * STRING exibida ao leitor. Input malformado → retorna o input cru (mesmo
 * fallback de `formatEditionDate`).
 */
export function formatEditionDateForBrand(edition: string, brand: Brand): string {
  if (BRAND_INFO[brand].leaderboardPeriod !== "year") return formatEditionDate(edition);
  if (/^\d{4}-\d{2}$/.test(edition)) {
    const monthSlug = editionToMonthSlug(edition); // ciclo → "YYYY-MM" do mês de CONTEÚDO
    if (!monthSlug) return edition;
    const [yearStr, mmStr] = monthSlug.split("-");
    const mmNum = parseInt(mmStr, 10);
    return `${MONTH_NAMES_PT[mmNum - 1]} de ${yearStr}`;
  }
  if (!/^\d{6}$/.test(edition)) return edition;
  const yy = parseInt(edition.slice(0, 2), 10);
  const mm = parseInt(edition.slice(2, 4), 10);
  if (mm < 1 || mm > 12) return edition;
  return `${MONTH_NAMES_PT[mm - 1]} de ${2000 + yy}`;
}

/**
 * #3118 (item 2): Cache-Control pra período (mês/ano) de leaderboard já
 * FECHADO (passado). Antes era `"public, max-age=2592000, immutable"` (30d +
 * immutable — premissa "mês fechado nunca muda"), mas o arquivo retroativo
 * (`/leaderboard/{YYYY}/arquivo`, #2867) invalidou essa premissa: um voto
 * numa edição de maio, feito hoje, altera `score-by-month:2026-05` (e o
 * agregado anual) mesmo com maio já "fechado". O snapshot server-side
 * invalida corretamente (getOrComputeSnapshot/invalidateSnapshot), mas
 * browsers/proxies com `immutable` servem o HTML/JSON antigo por até 30 dias
 * sem sequer revalidar. `max-age=3600` (1h) é barato o bastante pra não
 * sobrecarregar o Worker em tráfego normal, mas curto o bastante pra refletir
 * um voto retroativo em menos de um dia (em vez de até 30).
 */
export function closedPeriodCacheControl(): string {
  return "public, max-age=3600";
}

/**
 * Href do leaderboard preservando o brand (`?brand=clarice` só p/ não-default).
 * `slug` opcional → `/leaderboard/{slug}`.
 *
 * #2006: pra `clarice` (mensal — 1 voto/leitor/mês), o ranking é ANUAL: um slug
 * mensal `YYYY-MM` vira o slug do ano `YYYY`. Choke-point único — conserta a
 * página de voto e todo caller sem mexer neles. Diária inalterada.
 */
export function leaderboardHref(brand: Brand, slug?: string | null): string {
  // #2061: usa BRAND_INFO.leaderboardPeriod em vez de brand === "clarice" hardcoded
  // — um 3º brand anual herdaria a conversão mensal→anual sem alterar esta função.
  const effSlug = BRAND_INFO[brand].leaderboardPeriod === "year" && slug && /^\d{4}-\d{2}$/.test(slug)
    ? slug.slice(0, 4)
    : slug;
  const base = effSlug ? `/leaderboard/${effSlug}` : "/leaderboard";
  return withBrandQuery(base, brand);
}

// ── Brand default hardcoded em 5 pontos → 2 helpers (#3118 item 12) ────────
//
// `leaderboardHref` (acima), `archiveHref` (leaderboard-routes.ts) e o hidden
// input `<input type="hidden" name="brand">` de `votePageHtml` (index.ts) e
// `renderArchiveVoteHtml` (leaderboard-routes.ts) repetiam a mesma checagem
// `brand === "diaria" ? "" : ...` — um 3º brand exigiria editar os 5 pontos
// manualmente. Consolidados em 2 helpers puros (2 shapes distintas: query
// string vs. atributo HTML) reusados pelos 4 call-sites restantes.

/** #3118 item 12: anexa `?brand={brand}` a `base` só quando `brand` não é o
 * default ("diaria" — chaves KV legadas sem prefixo). */
export function withBrandQuery(base: string, brand: Brand): string {
  return brand === "diaria" ? base : `${base}?brand=${brand}`;
}

/** #3118 item 12: `<input type="hidden" name="brand">` só quando `brand` não
 * é o default — mesmo racional de `withBrandQuery`, forma HTML em vez de
 * query string. `htmlEscape` por consistência com o resto do arquivo (Brand
 * é um union fechado — nunca precisaria escapar na prática, mas o padrão do
 * arquivo é escapar tudo que é interpolado em atributo). */
export function brandHiddenInput(brand: Brand): string {
  return brand === "diaria" ? "" : `<input type="hidden" name="brand" value="${htmlEscape(brand)}">`;
}

// ── Shell editorial: régua teal + rodapé de marca (#3113) ───────────────────
//
// As páginas leaderboard/arquivo (renderLeaderboardHtml, renderArchiveListHtml)
// e a página de voto do arquivo (renderArchiveVoteHtml) não tinham identidade
// visual nenhuma além do `<title>` + o kicker de texto "É IA?" — sem a régua
// teal (mesmo elemento `<hr class="rule">` de Cursos/Livros) nem rodapé de
// marca. Estes 2 helpers dão o mínimo de shell editorial consistente com as
// outras 2 páginas públicas da Diar.ia.
//
// Duplicado (não importado de scripts/lib/shared/curadoria-page.ts, que tem o
// equivalente pra Cursos/Livros) pelo mesmo motivo já documentado em
// design-tokens.ts/ds-tokens.generated.ts: este worker roda em bundle
// Cloudflare separado dos scripts Node.

/**
 * CSS da régua teal (abaixo do kicker, acima do h1) + rodapé mínimo de marca.
 * margin da régua: 22px, igual à `.rule` de Cursos/Livros (renderCuradoriaHeaderStyles
 * em scripts/lib/shared/curadoria-page.ts) — evitar reintroduzir aqui o mesmo tipo
 * de micro-drift de espaçamento que o #3113 existe pra eliminar.
 */
export function renderBrandShellStyles(): string {
  return `  .rule { height: 2px; background: ${DS_COLORS.brand}; border: 0; margin: 0 0 22px; }
  footer.brand-footer { margin-top: 36px; padding-top: 14px; border-top: 1px solid ${DS_COLORS.rule}; font-size: 0.8rem; }
  footer.brand-footer a { font-weight: 600; }`;
}

/**
 * Rodapé mínimo de marca — link pro site principal do brand (diar.ia.br /
 * clarice.ai). Não é a nav cruzada de 4 links de Cursos/Livros (#3113 Bloco A)
 * — "É IA?" linkando pra si mesmo na própria página não faz sentido; aqui só
 * precisa dar identidade (rodapé não-vazio), não navegação cruzada completa.
 */
export function renderBrandFooter(brand: Brand): string {
  const info = BRAND_INFO[brand];
  const label = info.shortName ?? info.name;
  return `<footer class="brand-footer"><a href="${htmlEscape(info.siteUrl)}">${htmlEscape(label)}</a> — jogo "É IA?"</footer>`;
}

// ── Validação de apelidos do leaderboard (#1758) ────────────────────────────

/**
 * Normaliza apelido pra COMPARAÇÃO (dedup): lowercase, remove acentos, colapsa
 * espaços. "Ana B" e "ana  b" colidem; "Ana" e "Ana B" não. Não altera o
 * apelido salvo — só a chave de comparação.
 */
export function normalizeNickname(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Apelidos proibidos (#1758). Comparados após normalizar e remover tudo que não
 * é alfanumérico — então "Eu", "eu", "diar.ia", "diar ia", "anônimo" caem todos
 * nas entradas "eu" / "diaria" / "anonimo". Caso real jun/2026: leitor setou "Eu".
 */
export const NICKNAME_BLACKLIST = new Set([
  "eu", "you", "voce", "vc", "admin", "administrador", "moderador", "mod",
  "diaria", "diariabr", "bot", "editor", "teste", "test", "anonimo",
  "anonima", "none", "null", "undefined",
]);

/** Chave de blacklist: normaliza + remove não-alfanuméricos. */
function blacklistKey(name: string): string {
  return normalizeNickname(name).replace(/[^a-z0-9]/g, "");
}

/** #1758: true se o apelido está na blacklist (case/acento-insensitive). */
export function isBlacklistedNickname(name: string): boolean {
  return NICKNAME_BLACKLIST.has(blacklistKey(name));
}

/**
 * #1758: true se o apelido tem ao menos 1 caractere alfanumérico (letra/número
 * de qualquer alfabeto). Rejeita emoji-only e pontuação-only.
 */
export function nicknameHasContent(name: string): boolean {
  return /[\p{L}\p{N}]/u.test(name);
}

/**
 * #1758: valida um apelido candidato. Retorna mensagem de erro pt-BR se inválido,
 * ou null se OK (deixando a checagem de DUPLICIDADE — que precisa do KV — pro
 * caller). `cleanName` já deve vir sanitizado (slice 40 + strip de `<>`).
 */
export function validateNickname(cleanName: string): string | null {
  if (!nicknameHasContent(cleanName)) {
    return "Apelido precisa ter ao menos uma letra ou número.";
  }
  if (cleanName.trim().length < 2) {
    return "Apelido muito curto — use ao menos 2 caracteres.";
  }
  if (isBlacklistedNickname(cleanName)) {
    return "Esse apelido não é permitido. Escolha outro.";
  }
  return null;
}

// ── SEO/compartilhamento meta tags (#3106) ──────────────────────────────────
//
// As páginas /leaderboard* (leaderboard mensal/anual + arquivo retroativo)
// não tinham meta description, Open Graph, Twitter card, canonical ou favicon
// — só charset+viewport+title. São páginas 100% distribuídas por link
// compartilhado (newsletter, social); sem essas tags o preview no
// WhatsApp/LinkedIn/Slack sai cru (só a URL crua).
//
// Duplicado (não cross-importado de scripts/lib/shared/seo-meta.ts) de
// propósito — este worker roda em bundle Cloudflare separado e já espelha
// valores de design token inline (ver nota em design-tokens.ts sobre "bundle
// Cloudflare separado") em vez de puxar de scripts/lib/shared.
//
// Sem og:image/twitter:image por decisão de escopo (#3106, ver PR): nenhum
// asset de marca estático versionado existe no repo, e um `data:` URI não é
// buscável via HTTP pelos crawlers de unfurling (WhatsApp/LinkedIn/Facebook
// exigem GET numa URL http/https real) — declarar um og:image que nenhum
// unfurler consegue buscar é pior que omiti-lo. `twitter:card=summary` (sem
// imagem grande) mantém title+description no preview.

const POLL_BASE_URL = "https://poll.diaria.workers.dev";

/** Favicon SVG inline (data-URI) — "D" em tinta (papel) sobre teal (marca),
 * mesma marca usada em cursos/livros. Mantido estável entre redeploys —
 * trocar o favicon faz o browser tratar como página diferente. Cores
 * hardcoded como `%23RRGGBB` (hex URL-encoded) dentro do próprio SVG — não
 * escritas como literal `#RRGGBB` aqui no comentário de propósito, pra não
 * disparar falso-positivo no guard de #3111/#3113 (test/poll-ds-tokens.test.ts),
 * que escaneia o arquivo fonte inteiro (incluindo comentários) por esse padrão. */
export const FAVICON_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2300A0A0'/%3E%3Ctext x='32' y='46' font-family='Georgia, Times, serif' font-size='38' font-weight='700' fill='%23FBFAF6' text-anchor='middle'%3ED%3C/text%3E%3C/svg%3E";

export interface SeoMetaOptions {
  /** Título — reusado em og:title/twitter:title (igual ao conteúdo de <title>, sem o sufixo "| {marca}"). */
  title: string;
  /** Descrição curta — <meta name="description">, og:description, twitter:description. */
  description: string;
  /** Path relativo (começando com "/"), combinado com POLL_BASE_URL para canonical/og:url. */
  path: string;
}

/** Monta o bloco de tags <head> de SEO/compartilhamento. Pure. */
export function renderSeoMeta(opts: SeoMetaOptions): string {
  const url = `${POLL_BASE_URL}${opts.path}`;
  const t = htmlEscape(opts.title);
  const d = htmlEscape(opts.description);
  const u = htmlEscape(url);
  return `<meta name="description" content="${d}">
<link rel="canonical" href="${u}">
<link rel="icon" href="${FAVICON_DATA_URI}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Diar.ia">
<meta property="og:locale" content="pt_BR">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${u}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">`;
}
