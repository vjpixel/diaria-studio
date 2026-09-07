/**
 * annual-collect.ts (#7569)
 *
 * Miolo puro da Etapa 1 da `/diaria-anual`: recorte da janela, agrupamento
 * por mês e pré-filtro top-K. Sem I/O — `scripts/collect-annual.ts` é quem
 * lê disco e chama isto.
 *
 * ## Por que existe um pré-filtro
 *
 * A janela da 1ª rodada tem ~265 edições diárias e rende ~660 destaques —
 * ordem de grandeza que não cabe num prompt de analista (e que CRESCE, porque
 * o cache de edições continua recebendo arquivos; trate como grandeza, não
 * como valor esperado). E o
 * volume por mês é desigual por construção: agosto/2025 tem 3 edições (o
 * projeto nasceu dia 27), março/2026 tem 15, julho/2026 tem 24. Jogar tudo
 * junto e cortar por score global faria os meses gordos abafarem os magros —
 * a retrospectiva perderia justamente o começo da história.
 *
 * Por isso o corte é **por mês** (top-K de cada um), não global: todo mês
 * chega ao analista com o mesmo peso máximo, e um mês com menos material
 * entra inteiro em vez de sumir. Mesmo padrão do scorer chunked da diária
 * (#1611): pontuar em paralelo por chunk, selecionar depois.
 */

import { editorialDate, type UnifiedCachedPost } from "../shared/edition-cache-reader.ts";

/**
 * Marcas combinantes (U+0300–U+036F), para tirar acento depois de `NFD`.
 * Construída por `String.fromCodePoint` em vez de literal — mesma disciplina
 * de `collect-monthly.ts`: caractere não-imprimível dentro de uma regex
 * literal some em copy/paste e troca de encoding, e a regex passa a não casar
 * nada em silêncio.
 */
const COMBINING_MARKS_RE = new RegExp(
  `[${String.fromCodePoint(0x0300)}-${String.fromCodePoint(0x036f)}]`,
  "gu",
);

/** Um destaque coletado, no shape que o `analyst-anual` recebe. */
export interface AnnualDestaque {
  /** AAMMDD da edição diária de origem. */
  edition: string;
  /** YYMM do mês da edição — chave do agrupamento. */
  month: string;
  position: number;
  category: string;
  title: string;
  url: string;
  body: string;
  why: string;
  is_brazil: boolean;
  /**
   * Preenchido pelo `scorer-monthly` na Etapa 1; ausente antes disso.
   * Opcional e NÃO nullable de propósito: `undefined` e `null` significariam
   * a mesma coisa ("ainda não pontuado") e todo consumidor os fundia com
   * `??` — as duas formas para o mesmo estado só convidam a checagem
   * assimétrica.
   */
  score?: number;
}

/** De onde os destaques de um mês vieram — vai pro relatório do gate. */
export type AnnualMonthSource = "edicoes-locais" | "cache-html" | "cache-html-legado" | "vazio";

export interface AnnualMonthReport {
  month: string;
  source: AnnualMonthSource;
  editions_found: number;
  destaques_found: number;
  destaques_selected: number;
  warnings: string[];
}

/**
 * Unix seconds → AAMMDD, em **UTC**.
 *
 * A premissa: a diar.ia.br publica de manhã no horário de Brasília (UTC-3),
 * então a data UTC e a local coincidem para toda edição real — nenhuma sai
 * depois das 21h BRT, que é onde a virada de dia em UTC começaria a mover a
 * edição para o dia seguinte. Diferente de `collect-monthly.ts`, que lê o
 * AAMMDD do nome do arquivo e não precisa converter nada, aqui a data vem de
 * um timestamp e a conversão é inevitável. Se algum dia uma edição sair à
 * noite, é este ponto que a dataria um dia à frente.
 */
export function unixToEdition(seconds: number): string {
  const d = new Date(seconds * 1000);
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** AAMMDD → YYMM. */
export function editionMonth(edition: string): string {
  return edition.slice(0, 4);
}

/**
 * Data editorial de uma edição do cache, como AAMMDD — `undefined` quando o
 * post não tem data nenhuma (rascunho). Usa `editorialDate`, **nunca**
 * `publish_date` cru: as edições importadas de agosto/2025 carregam a data
 * da importação ali e cairiam em setembro.
 */
export function postEdition(post: UnifiedCachedPost): string | undefined {
  const secs = editorialDate(post);
  return secs === undefined || secs === null ? undefined : unixToEdition(secs);
}

/**
 * Chave de deduplicação: data editorial + título normalizado.
 *
 * A mesma edição pode existir nos DOIS caches — a leitura vem de Beehiiv e de
 * Kit ao mesmo tempo, e o cutover de plataforma (04/09/2026) não apagou nada
 * do lado antigo. Deduplicar por URL não resolve: publicada nas duas
 * plataformas, a edição tem duas URLs diferentes. O que não muda é o dia e o
 * título.
 *
 * Dias com DUAS edições distintas existem de verdade (14 na janela do 1º ano)
 * — por isso a data sozinha nunca é a chave.
 */
export function dedupKey(post: UnifiedCachedPost): string | null {
  const edition = postEdition(post);
  if (!edition) return null;
  const title = (post.title ?? post.subject ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS_RE, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  // Sem título não dá pra afirmar que dois posts do mesmo dia são a mesma
  // edição — e dias com duas edições distintas existem. Devolver a data
  // sozinha como chave descartaria uma edição real.
  if (!title) return null;
  return `${edition}::${title}`;
}

/**
 * Filtra o cache unificado pela janela: só edições publicadas
 * (`status === "confirmed"`, o vocabulário normalizado do reader) cujo mês
 * editorial está na lista, **sem duplicata entre os dois caches** (ver
 * `dedupKey`). Devolve um mapa YYMM → posts, com **todo mês da janela
 * presente**, inclusive os vazios — um mês sem edição é um fato a reportar no
 * gate, não uma chave ausente que some do relatório.
 *
 * Em caso de duplicata, o primeiro post vence. A lista chega ordenada por
 * `mergeEditionsByDate`, que desempata por origem — então a escolha é
 * determinística, não "o que o `readdir` devolveu primeiro".
 */
export function groupPostsByMonth(
  posts: readonly UnifiedCachedPost[],
  months: readonly string[],
): Map<string, UnifiedCachedPost[]> {
  const wanted = new Set(months);
  const out = new Map<string, UnifiedCachedPost[]>();
  for (const m of months) out.set(m, []);
  const seen = new Set<string>();

  for (const post of posts) {
    if (post.status !== "confirmed") continue;
    const edition = postEdition(post);
    if (!edition) continue;
    const month = editionMonth(edition);
    if (!wanted.has(month)) continue;
    const key = dedupKey(post);
    // Post sem título não tem como ser deduplicado com segurança — entra, e o
    // pior caso é uma duplicata a mais, não uma edição real descartada.
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.get(month)!.push(post);
  }

  for (const list of out.values()) {
    list.sort((a, b) => (editorialDate(a) ?? 0) - (editorialDate(b) ?? 0));
  }
  return out;
}

/**
 * Top-K por mês, por score decrescente. Mês com menos de K destaques entra
 * inteiro (nunca é preenchido com material de outro mês — o objetivo é teto
 * igual, não cota igual).
 *
 * Desempate determinístico: score desc → edição asc → posição asc. Sem isso
 * a saída variaria entre execuções com a mesma entrada, e o diff de
 * `raw-destaques.json` viraria ruído.
 *
 * Destaque sem score (`undefined`/`null`) vale -1: fica atrás de qualquer
 * pontuado, mas ainda entra se sobrar espaço. Rodar isto ANTES do scorer é
 * um erro de ordem, não um caminho suportado — quem chama garante o score.
 */
export function topKPerMonth(destaques: readonly AnnualDestaque[], k: number): AnnualDestaque[] {
  if (k <= 0) throw new Error(`top-K inválido: ${k} — precisa ser >= 1`);

  const byMonth = new Map<string, AnnualDestaque[]>();
  for (const d of destaques) {
    const list = byMonth.get(d.month);
    if (list) list.push(d);
    else byMonth.set(d.month, [d]);
  }

  const out: AnnualDestaque[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    const list = byMonth.get(month)!.slice().sort((a, b) => {
      const sa = a.score ?? -1;
      const sb = b.score ?? -1;
      if (sa !== sb) return sb - sa;
      if (a.edition !== b.edition) return a.edition < b.edition ? -1 : 1;
      return a.position - b.position;
    });
    out.push(...list.slice(0, k));
  }
  return out;
}

/** Quantos destaques faltam pontuar — o gate da Etapa 1 checa isto. */
export function unscoredCount(destaques: readonly AnnualDestaque[]): number {
  return destaques.filter((d) => d.score === undefined || d.score === null).length;
}
