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

// #3297: formatos AAMMDD/ciclo içados pra constantes exportadas — antes cada
// call site (aqui + editionToMonthSlug/formatEditionDateForBrand/
// isValidVoteEditionFormat neste mesmo arquivo, mais cópias inline em
// vote.ts/leaderboard-routes.ts, e uma cópia DIVERGENTE em
// scripts/rebuild-stats.ts que aceitava só AAMMDD e rejeitava silenciosamente
// edições de ciclo Clarice válidas) tinha sua PRÓPRIA cópia inline do regex.
// Deliberadamente NÃO substitui os usos abaixo por uma chamada a
// `isValidVoteEditionFormat`: as funções de formatação fazem validação
// SEMÂNTICA adicional (mês 1-12) que `isValidVoteEditionFormat` pula de
// propósito (só forma/charset) — reusar as constantes evita duplicar o
// regex sem acoplar as duas responsabilidades.

/** #3297: formato AAMMDD legado (diária) — só forma/charset, sem validação semântica de range. */
export const AAMMDD_RE = /^\d{6}$/;

/** #3297: formato de ciclo Clarice `YYMM-MM` (#2115) — só forma/charset. */
export const CYCLE_EDITION_RE = /^\d{4}-\d{2}$/;

/** AAMMDD → "10 de maio de 2026". Memória `feedback_no_aammdd_for_subscribers.md`.
 * Invalid input (não-AAMMDD, MM/DD fora de range) → retorna input cru (safe). */
export function formatEditionDate(edition: string): string {
  if (!AAMMDD_RE.test(edition)) return edition;
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

// ── Parse seguro de JSON vindo do KV (#3298) ────────────────────────────────

/**
 * #3298: parse seguro de um blob JSON lido do KV. `raw` vindo de
 * `env.POLL.get(...)` é `string | null`; `JSON.parse` lança em blob
 * corrompido — sem guard, essa exceção propaga não-capturada pelo caller
 * (na maioria dos casos `handleVote`), derrubando o request inteiro com 500
 * por causa de UM registro malformado.
 *
 * Mesma classe de bug já corrigida individualmente em
 * `buildAlreadyVotedResponse` (#3118 item 4 / #3278) — o #3298 achou mais 9
 * ocorrências desguardadas espalhadas por `vote.ts`/`index.ts`. Este helper
 * único evita duplicar o mesmo try/catch+log 9x e facilita manter a
 * disciplina em pontos futuros.
 *
 * `raw === null` (chave ausente no KV — caso normal, não um erro) retorna
 * `null` silenciosamente, sem log. Só o `JSON.parse` malformado loga (via
 * `console.error` estruturado, mesmo padrão dos outros guards deste worker)
 * e retorna `null` — caller decide o fallback apropriado (objeto default,
 * skip, ou early-return).
 *
 * `event`/`context` só alimentam o log estruturado — nunca afetam o valor
 * retornado. `context` costuma ser o `edition` (maioria dos call sites) ou o
 * `email`/`keyName` (sites sem edition disponível, ex: `handleSetName`).
 */
export function safeParseKv<T>(raw: string | null, event: string, context: string): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    console.error(JSON.stringify({ event, context, error: String(e) }));
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

/** #3118 item 3: forma mínima `local@domínio.tld`, sem espaços, ≤254 bytes
 * UTF-8 (limite prático de endereço de email, RFC 3696 errata).
 *
 * #3279 (charset hardening): também rejeita `:` explicitamente em cada
 * segmento — antes `[^\s@]+` permitia qualquer caractere fora de espaço/`@`,
 * então um email como `attacker@evil:x.com` passava. `email`/`edition` viram
 * componentes de uma chave KV (`vote:{edition}:{email}`) sem sanitização
 * adicional; um `:` cru nesses campos pode alterar a estrutura da chave.
 * Defesa em profundidade — a cadeia de exploit confirmada (#3279) usa o `:`
 * em `edition`, não em `email`, mas o mesmo caractere é igualmente perigoso
 * aqui por composição do template de chave.
 *
 * #3296 (gap 2 — explorável): o teto de 254 media `email.length` (unidades
 * UTF-16), não bytes UTF-8. `'あ'.repeat(200) + '@x.com'` tem `.length` 206
 * (passa o teto antigo) mas 606 bytes UTF-8 — a chave KV
 * `vote:{edition}:{email}` estoura os 512 bytes do Workers KV, lançando
 * exceção DEPOIS que o DO de dedup já autorizou o voto e incrementos
 * guard-key já rodaram (mesmo cenário de incremento parcial que o teto de
 * 254 existe pra prevenir). Fix: `new TextEncoder().encode(email).length`
 * mede bytes UTF-8 de fato (disponível no runtime do Workers) — resolve o
 * gap sem trocar a denylist por allowlist ASCII (que arriscaria rejeitar
 * emails PT-BR reais com acento no local-part; decisão conservadora — ver
 * issue #3296, sem como verificar dados reais de assinantes neste contexto).
 *
 * #3296 (gap 1 — defesa em profundidade, não explorável hoje): confusáveis
 * Unicode / caracteres invisíveis não eram bloqueados pela denylist anterior
 * (ex: `：` fullwidth U+FF1A, zero-width space U+200B passavam). `\p{Cf}`
 * (format — inclui zero-width space/joiner/non-joiner e BOM) e `\p{Cc}`
 * (control) cobrem a classe geral de invisíveis; `：` (":" fullwidth) é
 * listado explicitamente por não cair em nenhuma das duas categorias Unicode
 * mas ser visualmente/semanticamente um ":" — o mesmo caractere que #3279 já
 * bloqueia na forma ASCII. Nenhum dos dois afeta acentos PT-BR normais (á, ç,
 * ã são categoria Ll/Lu — letra, não format/control). */
const FORBIDDEN_EMAIL_CHARS_RE = /[\p{Cf}\p{Cc}：]/u;

export function isValidVoteEmailFormat(email: string): boolean {
  if (email.length === 0) return false;
  if (new TextEncoder().encode(email).length > 254) return false; // #3296 gap 2: bytes UTF-8, não UTF-16
  if (FORBIDDEN_EMAIL_CHARS_RE.test(email)) return false; // #3296 gap 1: confusáveis/invisíveis
  return /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(email);
}

/**
 * #3118 (item 3) / #3279 (charset hardening): valida a FORMA do componente
 * `edition` da chave KV — não só o comprimento. Aceita só os 2 formatos
 * legítimos usados pelo pipeline: AAMMDD legado (`AAMMDD_RE`, diária) ou ciclo
 * Clarice `YYMM-MM` (`CYCLE_EDITION_RE`, #2115). Ambos os ramos já são
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
  return AAMMDD_RE.test(edition) || CYCLE_EDITION_RE.test(edition);
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
  if (CYCLE_EDITION_RE.test(edition)) {
    const yy = edition.slice(0, 2);
    const mm = edition.slice(2, 4);
    const mmNum = parseInt(mm, 10);
    if (mmNum < 1 || mmNum > 12) return null;
    return `20${yy}-${mm}`;
  }
  // Formato legado AAMMDD (diária + mensal pre-#2115)
  if (!AAMMDD_RE.test(edition)) return null;
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
 * #3464: mês/ano de ENVIO dado mês/ano de CONTEÚDO — wrap dezembro(12)→
 * janeiro(1) do ano SEGUINTE. Extrai a fórmula que já existia inline em
 * `cycleForLegacyMonthlyEdition` (`envioMoNum = moNum === 12 ? 1 : moNum + 1`)
 * pra um helper puro reusável — issue #3464 precisa do mesmo mapeamento
 * conteúdo→envio em `formatEditionDateForBrand`/`groupEditionsByMonth`
 * (leaderboard-routes.ts) sem duplicar a fórmula um 3º lugar.
 */
export function envioMonthYear(contentYear: number, contentMonth: number): { year: number; month: number } {
  return contentMonth === 12
    ? { year: contentYear + 1, month: 1 }
    : { year: contentYear, month: contentMonth + 1 };
}

/**
 * #3350: direção INVERSA de `legacyMonthlyEditionForCycle` — dado um
 * identificador AAMMDD que pode ser um marcador LEGADO de ciclo mensal
 * (pré-#2115), reconstrói o slug de ciclo `YYMM-MM` correspondente.
 *
 * Motivação (issue #3350): `handleEditions` (vote.ts) enumera edições via
 * scan bruto das chaves KV `stats:` e devolvia o sufixo literal armazenado —
 * uma chave AAMMDD legada nunca era normalizada de volta pro slug de ciclo.
 * `fetchClariceEditions` (workers/brevo-dashboard/src/eia-refresh.ts) filtra
 * essa lista só pro formato de ciclo (`/^\d{4}-\d{2}$/`), descartando
 * silenciosamente qualquer entrada em formato legado — um ciclo com votos
 * reais só sob a chave AAMMDD (ex: `2605-06` sob `260531`, ver #3261)
 * desaparecia da aba Engajamento assim que o botão "Atualizar" rodava.
 *
 * Reconstrução: o AAMMDD legado codifica `YY`+`MM`(mês de CONTEÚDO)+
 * últimoDiaDoMês — o mês de ENVIO nunca é codificado nele (é sempre
 * mês-de-conteúdo + 1, invariante validado em `--cycle` nos scripts). Então:
 *   yy/mm = os 2 primeiros pares de dígitos do AAMMDD (ano/mês de conteúdo)
 *   envioMM = mm + 1 (wrap 12 → 01, mesmo mês-mesmo-ano do slug — o ano do
 *             envio não é representado no slug `YYMM-MM`, só o mês)
 *
 * Guard de forma: só reconstrói quando o `DD` do AAMMDD bate exatamente com
 * o último dia do mês `MM` — é assim que `legacyMonthlyEditionForCycle`
 * SEMPRE constrói a chave legada (nunca um dia arbitrário). Isso evita
 * reinterpretar uma edição AAMMDD que por coincidência caiu no último dia do
 * mês (ex: uma edição DIÁRIA real publicada em 31/05) como se fosse um
 * marcador de ciclo — mas o call site em `handleEditions` só aplica esta
 * função para brands com `leaderboardPeriod === "year"` (hoje só `clarice`,
 * que não tem conceito de "edição diária" — toda chave AAMMDD dela É um
 * marcador legado por construção), então a ambiguidade teórica não ocorre
 * na prática; o guard aqui é defesa em profundidade caso a função seja
 * reusada em outro contexto no futuro.
 *
 * Retorna `null` se `edition` não é AAMMDD válido, mês de conteúdo fora de
 * range (0/>12), ou `DD` não bate com o último dia do mês (não é um
 * marcador legado reconstruível).
 *
 * Round-trips com `legacyMonthlyEditionForCycle`:
 *   `legacyMonthlyEditionForCycle("2605-06")` → `"260531"`
 *   `cycleForLegacyMonthlyEdition("260531")` → `"2605-06"`
 */
export function cycleForLegacyMonthlyEdition(edition: string): string | null {
  if (!AAMMDD_RE.test(edition)) return null;
  const yy = edition.slice(0, 2);
  const mm = edition.slice(2, 4);
  const dd = edition.slice(4, 6);
  const yr = 2000 + parseInt(yy, 10);
  const moNum = parseInt(mm, 10);
  if (moNum < 1 || moNum > 12) return null;
  const lastDay = new Date(Date.UTC(yr, moNum, 0)).getUTCDate();
  if (parseInt(dd, 10) !== lastDay) return null;
  const { month: envioMoNum } = envioMonthYear(yr, moNum); // #3464: reusa o wrap dez→jan em vez de duplicar
  return `${yy}${mm}-${String(envioMoNum).padStart(2, "0")}`;
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
 * `clarice` é o digest mensal (Clarice News / Brevo); `web` (#3516, EPIC
 * #3514) é o jogo público standalone em diar.ia.br — visitante anônimo
 * (identidade por token, sem email/assinatura), ranking mensal próprio,
 * mesmos pares de imagem já gerados pela pipeline diária. Cada marca tem
 * ranking, gate de edições e apelidos isolados (mecânica #1905 — um brand
 * novo entra de graça na isolação, ver `brandKvPrefix`/`parseBrandParam`
 * abaixo, derivados de `Object.keys(BRAND_INFO)`).
 */
export type Brand = "diaria" | "clarice" | "web";

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
  // #3516: leaderboardPeriod "month" com reset natural por mês de publicação
  // (mesma mecânica score-by-month da diária, #1345) — sugestão #2 do EPIC
  // #3514 ("mensal com reset+archive, consistente com diaria"). siteUrl
  // aponta pro site principal (o jogo É a isca de divulgação pra diar.ia.br,
  // não um produto à parte com marca própria) — decisão de design
  // conservadora documentada no PR do #3516.
  web: { name: "Diar.ia", siteUrl: "https://diar.ia.br", leaderboardPeriod: "month" },
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
 * #3464: pra `leaderboardPeriod === "year"` (só `clarice` hoje), o mês
 * exibido é o mês de ENVIO, não o de CONTEÚDO — a edição de conteúdo de
 * maio é ENVIADA em junho (invariante `{envio} = {conteúdo} + 1`, ver
 * `legacyMonthlyEditionForCycle`/`cycleForLegacyMonthlyEdition`); pro
 * leitor que recebeu o e-mail em junho, "maio de 2026" é confuso. Ambos os
 * ramos (ciclo `YYMM-MM` e AAMMDD legado) convertem CONTEÚDO→ENVIO via
 * `envioMonthYear` (wrap dezembro→janeiro do ano seguinte) antes de formatar
 * — reusa o mesmo mapeamento de `cycleForLegacyMonthlyEdition`, não duplica.
 *
 * NÃO altera o código da edição interno usado em hrefs/gabarito/dedup — só a
 * STRING exibida ao leitor. Input malformado → retorna o input cru (mesmo
 * fallback de `formatEditionDate`).
 */
export function formatEditionDateForBrand(edition: string, brand: Brand): string {
  if (BRAND_INFO[brand].leaderboardPeriod !== "year") return formatEditionDate(edition);
  if (CYCLE_EDITION_RE.test(edition)) {
    const monthSlug = editionToMonthSlug(edition); // ciclo → "YYYY-MM" do mês de CONTEÚDO
    if (!monthSlug) return edition;
    const [yearStr, mmStr] = monthSlug.split("-");
    const { year, month } = envioMonthYear(parseInt(yearStr, 10), parseInt(mmStr, 10)); // #3464: conteúdo → envio
    return `${MONTH_NAMES_PT[month - 1]} de ${year}`;
  }
  if (!AAMMDD_RE.test(edition)) return edition;
  const yy = parseInt(edition.slice(0, 2), 10);
  const mm = parseInt(edition.slice(2, 4), 10);
  if (mm < 1 || mm > 12) return edition;
  const { year, month } = envioMonthYear(2000 + yy, mm); // #3464: conteúdo → envio
  return `${MONTH_NAMES_PT[month - 1]} de ${year}`;
}

// ── Streak: continuidade de período de votação (#3522) ─────────────────────
//
// `score:{email}.streak` (dias/meses CONSECUTIVOS acertando) existe desde
// #2832, mas só resetava em ERRO (`correct === false`) — nunca em AUSÊNCIA
// de voto. Um jogador que pulasse dias/meses mantinha o streak intacto até a
// próxima resposta errada, quando deveria já ter zerado no primeiro período
// pulado. `isConsecutiveVotingPeriod` fecha essa brecha: em `updateScore`
// (vote.ts), o streak só continua se a edição do voto atual é o PRÓXIMO
// período de votação esperado após `score.last_edition`.
//
// Brand-aware porque a CADÊNCIA de votação difere por `leaderboardPeriod`
// (BRAND_INFO acima):
//   - "month" (diaria, web): 1 edição por DIA ÚTIL — a newsletter nunca
//     publica sáb/dom (context/editorial-rules.md, a janela de publicação
//     das edições de segunda/terça cobre explicitamente o fim de semana). O
//     "próximo período esperado" é o próximo dia útil (seg-sex) após
//     `prevEdition` — `nextWeekdayAammdd`.
//   - "year" (clarice): 1 edição por MÊS — o "próximo período esperado" é o
//     mês de CONTEÚDO seguinte (`editionToMonthSlug`), independente do "dia"
//     codificado no AAMMDD/ciclo (que não representa uma data real pra este
//     brand — mesmo racional de `formatEditionDateForBrand` acima) —
//     `nextContentMonthSlug`.

/**
 * Pure (#3522): próximo dia ÚTIL (seg-sex) em AAMMDD após `edition`. `null`
 * se `edition` não é AAMMDD válido (forma ou range de mês/dia). Usado só
 * pela cadência "month" (diaria/web) — clarice usa `nextContentMonthSlug`.
 */
export function nextWeekdayAammdd(edition: string): string | null {
  if (!AAMMDD_RE.test(edition)) return null;
  const yy = parseInt(edition.slice(0, 2), 10);
  const mm = parseInt(edition.slice(2, 4), 10);
  const dd = parseInt(edition.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  if (Number.isNaN(d.getTime())) return null;
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6); // pula dom(0)/sáb(6)
  const y2 = String(d.getUTCFullYear() % 100).padStart(2, "0");
  const m2 = String(d.getUTCMonth() + 1).padStart(2, "0");
  const d2 = String(d.getUTCDate()).padStart(2, "0");
  return `${y2}${m2}${d2}`;
}

/**
 * Pure (#3522): mês de CONTEÚDO seguinte (slug "YYYY-MM") após `edition` —
 * usado só pela cadência "year" (clarice). `null` se `edition` não resolve
 * via `editionToMonthSlug` (nem AAMMDD nem ciclo `YYMM-MM` válidos).
 */
export function nextContentMonthSlug(edition: string): string | null {
  const slug = editionToMonthSlug(edition);
  if (!slug) return null;
  const parsed = parseMonthSlug(slug);
  if (!parsed) return null;
  const { year, month } = parsed;
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * Pure (#3522): `newEdition` continua um streak iniciado em `prevEdition`?
 *
 *   - `prevEdition === null` (sem voto anterior com correctness resolvida —
 *     1º voto "confirmado" do jogador) → `true`: nada a quebrar;
 *     `updateScore` semeia o streak em 1 naturalmente, nunca comparando
 *     continuidade contra um histórico vazio.
 *   - Forma inválida de qualquer um dos dois lados → `false` (fail-safe:
 *     nunca concede continuidade pra dado que não conseguimos interpretar —
 *     mesmo viés conservador dos outros guards `?? 0`/`safeParseKv` deste
 *     módulo).
 *   - Caso contrário, delega pra `nextWeekdayAammdd` ("month") ou
 *     `nextContentMonthSlug` ("year") conforme `BRAND_INFO[brand].leaderboardPeriod`.
 *
 * Limitação conhecida e aceita (decisão conservadora, #3522): não conhece
 * feriados/interrupções editoriais fora do padrão seg-sex — um hiato
 * excepcional (feriado prolongado, pane) quebraria o streak mesmo sem o
 * jogador ter "pulado" um dia de publicação real. Resolver isso exigiria
 * consultar o calendário real de edições publicadas (scan de KV a cada
 * voto) — sobre-engenharia pra um streak de retenção P3; mesmo trade-off já
 * aceito em outras decisões de escopo do EPIC #3514 (ver jogar.ts).
 */
export function isConsecutiveVotingPeriod(prevEdition: string | null, newEdition: string, brand: Brand): boolean {
  if (prevEdition === null) return true;
  if (BRAND_INFO[brand].leaderboardPeriod === "year") {
    const expected = nextContentMonthSlug(prevEdition);
    const actual = editionToMonthSlug(newEdition);
    return expected !== null && actual !== null && expected === actual;
  }
  const expected = nextWeekdayAammdd(prevEdition);
  return expected !== null && expected === newEdition;
}

/**
 * Pure (#3522): sufixo de streak pra mensagem pós-voto (ex: " 🔥 5 dias
 * seguidos acertando!"). `null`/`< 2` → "" (1 acerto isolado não é
 * "sequência" — mesmo limiar usado por produtos de retenção comparáveis,
 * Duolingo/Wordle só destacam o contador a partir de 2). Unidade
 * ("dias"/"meses") deriva de `BRAND_INFO[brand].leaderboardPeriod`, mesmo
 * padrão de `formatEditionDateForBrand`/`leaderboardPeriodWord` (index.ts) —
 * clarice (cadência mensal) nunca deveria dizer "dias seguidos". Espaço
 * inicial deliberado — caller concatena direto ao fim da frase da mensagem
 * de resultado, sem espaço próprio (ver `handleVote`, vote.ts).
 */
export function renderStreakSuffix(streak: number | null, brand: Brand): string {
  if (streak === null || streak < 2) return "";
  const unit = BRAND_INFO[brand].leaderboardPeriod === "year" ? "meses seguidos" : "dias seguidos";
  return ` 🔥 ${streak} ${unit} acertando!`;
}

// ── Stats pós-voto (#3523) ───────────────────────────────────────────────────

/**
 * #3523: nº mínimo de votos agregados na edição antes de exibir "X%
 * acertaram este par" pós-voto — protege contra expor uma amostra minúscula
 * (ex: o 1º votante de uma edição recém-publicada veria "100%" ou "0%",
 * estatisticamente sem sentido e potencialmente enganoso/spoiler-adjacent).
 * Valor sugerido pelo próprio editor na seção "Aceite" da issue #3523.
 */
export const MIN_VOTES_FOR_STATS_DISPLAY = 20;

/**
 * Pure (#3523): sufixo "X% acertaram este par" pra mensagem pós-voto — mesmo
 * padrão de `renderStreakSuffix` acima (espaço inicial deliberado, caller
 * concatena direto ao fim da frase de resultado, sem espaço próprio, ver
 * `handleVote`/vote.ts).
 *
 * `stats` aceita um shape estrutural mínimo (`{ total, correct_count }`) em
 * vez de importar `StatsCounterData` de stats-counter.ts — mantém este
 * arquivo (lib.ts, #1083: "sem dependência de Cloudflare runtime") livre de
 * qualquer acoplamento a outro módulo do worker, mesmo que hoje não haja
 * ciclo real (stats-counter.ts não importa nada).
 *
 * Anti-sample-size: `stats === null` (fetch falhou — fail-soft, nunca
 * bloqueia o voto) OU `total < minVotes` → "" (sem sufixo). O gate
 * anti-spoiler em si (não revelar % ANTES do voto) é responsabilidade do
 * caller — `handleVote` só chama esta função quando `correct !== null`
 * (gabarito já revelado), o mesmo gate que `showImages`/`resultImages` já
 * usam (ver vote.ts).
 *
 * Percentual arredondado com o mesmo critério de `correct_pct` em
 * `handleStats` (vote.ts) — consistência entre o que `/stats` reporta
 * publicamente e o que a mensagem pós-voto mostra pro mesmo par.
 */
export function renderStatsSuffix(
  stats: { total: number; correct_count: number } | null,
  minVotes: number = MIN_VOTES_FOR_STATS_DISPLAY,
): string {
  if (!stats || stats.total < minVotes) return "";
  const pct = Math.round((stats.correct_count / stats.total) * 100);
  return ` ${pct}% dos jogadores acertaram este par.`;
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
  const effSlug = BRAND_INFO[brand].leaderboardPeriod === "year" && slug && CYCLE_EDITION_RE.test(slug)
    ? slug.slice(0, 4)
    : slug;
  const base = effSlug ? `/leaderboard/${effSlug}` : "/leaderboard";
  return withBrandQuery(base, brand);
}

// ── #3524: ponte cross-canal email → arquivo do site (última sub-issue do
// EPIC #3514) ─────────────────────────────────────────────────────────────
//
// UTM fixo do funil "página pós-voto (email) → arquivo jogável" — mesma
// disciplina de 3 parâmetros já usada pelo funil site→email (`SUBSCRIBE_UTM_*`,
// jogar.ts #3518) e embed→email (`EMBED_UTM_*`, embed.ts #3521).
// `utm_source=newsletter` é o mesmo valor usado no bloco É IA? da newsletter
// (scripts/lib/newsletter-render-html.ts, `EIA_ARCHIVE_UTM_SOURCE` — duplicado
// ali por rodar em bundle Node separado, mesmo racional de DS_COLORS/
// DS_FONTS/ds-tokens.generated.ts) — o leitor de email que chega em `/vote`
// clicando no botão do e-mail e o leitor que chega pelo link do corpo do
// e-mail contam pro MESMO utm_source no funil, coerência exigida pelo item
// de aceite #3524 ("UTMs distintos por origem... funil distingue newsletter
// vs share vs embed").
export const EMAIL_ARCHIVE_UTM_SOURCE = "newsletter";
export const EMAIL_ARCHIVE_UTM_MEDIUM = "email";
export const EMAIL_ARCHIVE_UTM_CAMPAIGN = "eia-arquivo";

/**
 * Href relativo do arquivo jogável (`/jogar/arquivo`, #3519) com o UTM do
 * funil "página pós-voto → site". Path relativo (não `POLL_BASE_URL` absoluto)
 * — mesmo padrão de `leaderboardHref`/`archiveHref` acima: o link vive na
 * MESMA origem do Worker (`/vote` e `/jogar/arquivo` são handlers do mesmo
 * worker `poll`), sem necessidade de URL absoluta.
 */
export function jogarArchiveHref(): string {
  const params = new URLSearchParams({
    utm_source: EMAIL_ARCHIVE_UTM_SOURCE,
    utm_medium: EMAIL_ARCHIVE_UTM_MEDIUM,
    utm_campaign: EMAIL_ARCHIVE_UTM_CAMPAIGN,
  });
  return `/jogar/arquivo?${params.toString()}`;
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
// Sem og:image/twitter:image por decisão de escopo original (#3106): nenhum
// asset de marca estático versionado existia no repo, e um `data:` URI não é
// buscável via HTTP pelos crawlers de unfurling (WhatsApp/LinkedIn/Facebook
// exigem GET numa URL http/https real) — declarar um og:image que nenhum
// unfurler consegue buscar é pior que omiti-lo. `twitter:card=summary` (sem
// imagem grande) mantém title+description no preview.
//
// #3517: a lacuna acima é resolvida (não removida) para o card de
// compartilhamento do "É IA?" standalone — `/og/{token}` (share.ts) agora
// gera uma imagem SVG determinística e BUSCÁVEL via HTTP GET a partir de um
// payload assinado, satisfazendo a exigência dos unfurlers. `imageUrl` abaixo
// é opcional: omitido (todo call-site pré-#3517, ex: leaderboard/arquivo)
// preserva o comportamento antigo (sem tag de imagem, twitter:card=summary);
// só `renderSharePageHtml` (share.ts) passa `imageUrl`.

/**
 * #3701: hostname genérico `workers.dev` original do worker `poll`. Preservado
 * como constante documentada (não referenciada em código — só em comentários)
 * porque `workers_dev = true` segue ativo em `workers/poll/wrangler.toml`: os
 * links de VOTO/imagem já embutidos em edições enviadas ANTES do #3904
 * apontam pra este hostname e precisam continuar vivos (não reescrever,
 * ~300 referências históricas). Nenhum HTML renderizado por este worker
 * constrói mais URLs a partir desta constante (ver `PUBLIC_GAME_BASE_URL`
 * abaixo e #3904).
 */
export const POLL_BASE_URL = "https://poll.diaria.workers.dev";

/**
 * #3701: domínio de marca do jogo público "É IA?" — `eia.diar.ia.br`, um
 * Workers Custom Domain apontando pro mesmo worker `poll` (ver
 * `workers/poll/wrangler.toml`).
 *
 * #3701 introduziu isto só pro brand `web` (canonical/og:url/share/embed do
 * jogo público standalone), mantendo `POLL_BASE_URL` pros brands
 * `diaria`/`clarice`. #3904 estendeu o uso: `renderSeoMeta` (abaixo) agora usa
 * este domínio para TODO brand — o worker é o mesmo por trás de ambos os
 * hostnames, então canonical/og:url ganham consistência sem quebrar nada
 * (SEO/compartilhamento não é um link já "embutido" em e-mail enviado, ao
 * contrário do link de voto). `POLL_BASE_URL` segue existindo só pela razão
 * documentada no seu próprio comentário acima — links de AÇÃO de edições já
 * enviadas antes deste PR.
 */
export const PUBLIC_GAME_BASE_URL = "https://eia.diar.ia.br";

/**
 * #3717: forma "curta" (sem protocolo) de `PUBLIC_GAME_BASE_URL`, pra copy de
 * watermark/share text que mostra um domínio "digitável" (ex: watermark do
 * SVG do share-card, texto de `buildShareText`/`buildQuizShareText` em
 * share.ts) — nunca um link clicável de verdade nesses contextos. Derivado de
 * `PUBLIC_GAME_BASE_URL` (não redeclarado) pra não ter 2 fontes de verdade do
 * mesmo domínio de marca.
 */
export const PUBLIC_GAME_DISPLAY_HOST = PUBLIC_GAME_BASE_URL.replace(/^https?:\/\//, "");

/** Favicon SVG inline (data-URI) — marca "d.." em branco num CÍRCULO teal,
 * transparente fora (teal aparece em qualquer tab). Composição canônica do
 * avatar (ver diaria-design guidelines/avatar-proportion.md): "d" como <path>
 * outlined do Georgia (font-independent), haste centrada, 2 pontos REDONDOS
 * equidistantes, proporção 1.2×. Trocar o favicon faz o browser tratar como
 * página diferente — mudança intencional (proporção 1.2×). Cores hardcoded como
 * `%23RRGGBB` (hex URL-encoded) dentro do próprio SVG — não escritas como
 * literal `#RRGGBB` aqui no comentário de propósito, pra não disparar
 * falso-positivo no guard de #3111/#3113 (test/poll-ds-tokens.test.ts), que
 * escaneia o arquivo fonte inteiro (incluindo comentários) por esse padrão. */
export const FAVICON_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1080 1080'%3E%3Ccircle cx='540' cy='540' r='540' fill='%2300A0A0'/%3E%3Cg transform='translate(540 540) scale(1.2000) translate(-540 -540)'%3E%3Cpath transform='translate(310 700) scale(0.229492 -0.229492)' d='M1351 21 858 -8 843 6V98L836 100Q787 47 703.5 7.5Q620 -32 535 -32Q333 -32 202.0 118.0Q71 268 71 506Q71 717 217.5 868.0Q364 1019 572 1019Q654 1019 726.0 1000.5Q798 982 841 957V1284Q841 1321 826.0 1353.5Q811 1386 786 1404Q755 1426 708.5 1435.5Q662 1445 615 1449V1522L1155 1548L1170 1532V221Q1170 183 1182.5 157.0Q1195 131 1223 116Q1244 105 1284.5 100.0Q1325 95 1351 94ZM841 199V764Q834 787 821.5 815.0Q809 843 787 868Q767 889 733.5 905.0Q700 921 658 921Q558 921 494.0 808.0Q430 695 430 489Q430 408 441.5 343.5Q453 279 482 226Q511 173 556.5 143.0Q602 113 666 113Q727 113 767.0 136.5Q807 160 841 199Z' fill='%23FFFFFF'/%3E%3Ccircle cx='699' cy='662' r='45' fill='%23FFFFFF'/%3E%3Ccircle cx='824' cy='662' r='45' fill='%23FFFFFF'/%3E%3C/g%3E%3C/svg%3E";

export interface SeoMetaOptions {
  /** Título — reusado em og:title/twitter:title (igual ao conteúdo de <title>, sem o sufixo "| {marca}"). */
  title: string;
  /** Descrição curta — <meta name="description">, og:description, twitter:description. */
  description: string;
  /** Path relativo (começando com "/"), combinado com `PUBLIC_GAME_BASE_URL`
   * para canonical/og:url (#3904 — todo brand, não só `"web"`). */
  path: string;
  /** #3517: URL absoluta (http/https, buscável via GET) pra og:image/twitter:image.
   * Omitido → comportamento pré-#3517 inalterado (sem tag de imagem,
   * twitter:card=summary — ver rationale #3106 acima). Presente → tags de
   * imagem entram e twitter:card vira summary_large_image (preview rico). */
  imageUrl?: string;
  /** #3701: introduziu `PUBLIC_GAME_BASE_URL` (`eia.diar.ia.br`) só pro brand
   * `"web"`, mantendo `POLL_BASE_URL` (`poll.diaria.workers.dev`) pros demais.
   * #3904: canonical/og:url do worker inteiro migram pro domínio de marca,
   * independente do brand — mesmo worker por trás de ambos os hostnames, e
   * `POLL_BASE_URL` segue existindo só pros endpoints de AÇÃO (voto/img/stats)
   * de edições já enviadas, nunca pra SEO. Campo mantido (não usado mais
   * dentro desta função) por back-compat de assinatura dos callers. */
  brand?: Brand;
}

/** Monta o bloco de tags <head> de SEO/compartilhamento. Pure. */
export function renderSeoMeta(opts: SeoMetaOptions): string {
  const base = PUBLIC_GAME_BASE_URL; // #3904: canonical/og:url sempre no domínio de marca
  const url = `${base}${opts.path}`;
  const t = htmlEscape(opts.title);
  const d = htmlEscape(opts.description);
  const u = htmlEscape(url);
  const imageTags = opts.imageUrl
    ? `\n<meta property="og:image" content="${htmlEscape(opts.imageUrl)}">\n<meta name="twitter:image" content="${htmlEscape(opts.imageUrl)}">`
    : "";
  const twitterCard = opts.imageUrl ? "summary_large_image" : "summary";
  return `<meta name="description" content="${d}">
<link rel="canonical" href="${u}">
<link rel="icon" href="${FAVICON_DATA_URI}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Diar.ia">
<meta property="og:locale" content="pt_BR">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${u}">${imageTags}
<meta name="twitter:card" content="${twitterCard}">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">`;
}
