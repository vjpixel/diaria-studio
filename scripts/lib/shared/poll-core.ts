/**
 * scripts/lib/shared/poll-core.ts — núcleo puro do Worker `poll` que o pipeline
 * também usa (#13994): formato de edição, mês do leaderboard, "hoje" em BRT,
 * o tipo `Brand` e a normalização de apelido.
 *
 * Mora em `shared/` para a fronteira Worker/pipeline ter mão única: o Worker
 * (`workers/poll/src/lib.ts`) importa e reexporta daqui, e `scripts/` importa
 * daqui, nunca de `workers/poll/src/`. Sem I/O, sem runtime do Cloudflare.
 */

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
 * Marcas que têm leaderboard É IA? próprio. `diaria` é o diário (Beehiiv);
 * `clarice` é o digest mensal (Clarice News / Brevo); `web` (#3516, EPIC
 * #3514) é o jogo público standalone em diar.ia.br — visitante anônimo
 * (identidade por token, sem email/assinatura), ranking mensal próprio,
 * mesmos pares de imagem já gerados pela pipeline diária; `mensal-beehiiv`
 * (#4482) é o MESMO digest mensal que `clarice`, mandado por um canal
 * diferente (Beehiiv, pra apoiadores Mantenedor/Patrono que já são
 * assinantes da diária) — precisa de isolamento próprio porque misturar os
 * votos desse envio no leaderboard `clarice` cruzaria 2 audiências
 * distintas (achado do review pré-merge do #4482/#4510: `renderEia`
 * mandava TODO voto do digest, veio ele da Clarice ou do Beehiiv, pro mesmo
 * `brand=clarice`); `mensal-apoiadores-brevo` (#4593) é o SUCESSOR de
 * `mensal-beehiiv` — mesma audiência (apoiadores Mantenedor/Patrono), canal
 * trocado de Beehiiv pra Brevo porque a Beehiiv bloqueia "Include and
 * exclude segments" atrás do plano Scale (#4572); `mensal-apoiadores-kit`
 * (#7633) sucede o Brevo pelo mesmo motivo que o resto do projeto migrou —
 * backend da newsletter em "kit" (#7388), base inteira já lá (#7386).
 * `mensal-beehiiv` nunca chegou a enviar; `mensal-apoiadores-brevo` ENVIOU
 * uma vez (04/08/2026, ciclo 2607-08, 10 entregues — correção do #7655,
 * medida na API da Brevo), então pode ter voto real registrado sob ele e não
 * é um brand vazio. Cada marca
 * tem ranking, gate de edições e apelidos
 * isolados (mecânica #1905 — um brand novo entra de graça na isolação, ver
 * `brandKvPrefix`/`parseBrandParam` abaixo, derivados de
 * `Object.keys(BRAND_INFO)`).
 */
export type Brand =
  | "diaria"
  | "clarice"
  | "web"
  | "mensal-beehiiv"
  | "mensal-apoiadores-brevo"
  | "mensal-apoiadores-kit";

/**
 * #4122 (achado 3, decisão do editor 260727): mapa de confusáveis usado
 * SÓ pra derivar a CHAVE de dedup de apelido (`nickname:{normalizado}` em
 * index.ts) — nunca pra alterar o apelido exibido. `normalizeNickname` já
 * fazia NFD + lowercase, que fecha acentos (á→a), mas não homóglifos entre
 * ALFABETOS: "pаixel" (com а cirílico, U+0430) e "paixel" (latino) são bytes
 * diferentes que renderizam IDÊNTICOS na maioria das fontes — o guard de
 * apelido duplicado (#1758/#3117) não os via como o mesmo apelido.
 *
 * Escopo deliberadamente ENXUTO — cobre os confusáveis minúsculos mais
 * comuns entre Cirílico/Grego e Latino (mesma classe de ataque dos IDN
 * homograph de domínio), sem dependência externa (o worker roda no
 * Cloudflare, sem acesso a um pacote de confusables.txt completo do
 * Unicode). NÃO fecha: outros alfabetos (armênio, copta, etc.), confusáveis
 * que dependem de MAIÚSCULA (irrelevante aqui — a função já lowercase antes),
 * nem combinações multi-caractere (ex: "rn" parecendo "m"). Ampliar esta
 * tabela é seguro e não quebra nada — só reduz falso-negativo do dedup.
 */
const NICKNAME_CONFUSABLES: Record<string, string> = {
  // Cirílico → Latino
  "а": "a", // U+0430 CYRILLIC SMALL LETTER A
  "е": "e", // U+0435 CYRILLIC SMALL LETTER IE
  "о": "o", // U+043E CYRILLIC SMALL LETTER O
  "р": "p", // U+0440 CYRILLIC SMALL LETTER ER
  "с": "c", // U+0441 CYRILLIC SMALL LETTER ES
  "у": "y", // U+0443 CYRILLIC SMALL LETTER U
  "х": "x", // U+0445 CYRILLIC SMALL LETTER HA
  "і": "i", // U+0456 CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  "ј": "j", // U+0458 CYRILLIC SMALL LETTER JE
  "ѕ": "s", // U+0455 CYRILLIC SMALL LETTER DZE
  "һ": "h", // U+04BB CYRILLIC SMALL LETTER SHHA
  "ԁ": "d", // U+0501 CYRILLIC SMALL LETTER KOMI DE
  "ԛ": "q", // U+051B CYRILLIC SMALL LETTER QA
  "ѡ": "w", // U+0461 CYRILLIC SMALL LETTER OMEGA
  // Grego → Latino
  "α": "a", // U+03B1 GREEK SMALL LETTER ALPHA
  "ο": "o", // U+03BF GREEK SMALL LETTER OMICRON
  "ρ": "p", // U+03C1 GREEK SMALL LETTER RHO
  "υ": "u", // U+03C5 GREEK SMALL LETTER UPSILON
  "ι": "i", // U+03B9 GREEK SMALL LETTER IOTA
  "κ": "k", // U+03BA GREEK SMALL LETTER KAPPA
  "ν": "v", // U+03BD GREEK SMALL LETTER NU
  "χ": "x", // U+03C7 GREEK SMALL LETTER CHI
};

/** Regex pré-compilada a partir das chaves de `NICKNAME_CONFUSABLES` (classe de caracteres). */
const NICKNAME_CONFUSABLES_RE = new RegExp(`[${Object.keys(NICKNAME_CONFUSABLES).join("")}]`, "g");

/**
 * Normaliza apelido pra COMPARAÇÃO (dedup): lowercase, remove acentos, colapsa
 * espaços, dobra homóglifos comuns (cirílico/grego → latino, #4122) pro
 * equivalente latino. "Ana B" e "ana  b" colidem; "Ana" e "Ana B" não. Não
 * altera o apelido salvo — só a chave de comparação.
 */
export function normalizeNickname(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .replace(NICKNAME_CONFUSABLES_RE, (ch) => NICKNAME_CONFUSABLES[ch]);
}
