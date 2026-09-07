/**
 * scripts/lib/acervo-staleness.ts (#7591)
 *
 * Miolo puro do alarme de defasagem do acervo: compara a edição mais recente
 * que EXISTE com a mais recente que o LEITOR vê.
 *
 * ## Por que precisa existir, mesmo depois do #7578
 *
 * O #7578 fechou a lacuna **por edição**: o invariante `site-page-published`
 * virou `error` e trava o gate 6, e `site-sitemap-no-orphans` acusa página
 * órfã. Isso pega o problema *na próxima edição que rodar*.
 *
 * O que nenhum dos dois cobre é o caso que de fato aconteceu: **nenhuma edição
 * rodar por dias.** Entre 27/08 e 07/09/2026 o acervo ficou parado 12 dias, e
 * o `Diaria-Edicao-Diaria-Staleness-Alarm` (#5563) esteve correto e mudo o
 * tempo todo — ele checa se a edição foi PRODUZIDA, e as de setembro existiam
 * em disco. Ninguém comparava produção com publicação.
 *
 * ## Três sinais, todos opcionais
 *
 * Cada fonte pode faltar, e faltar significa coisas diferentes:
 *
 *   - `data/editions/` — é gitignored (junction do OneDrive). Ausente em CI e
 *     em clone fresco; presente na máquina do editor e no servidor.
 *   - `sitemap.xml` do repo — sempre presente num checkout normal.
 *   - `arquivo.diar.ia.br` ao vivo — depende de rede.
 *
 * Comparar só o que dá, e DIZER o que não deu, é melhor que exigir as três e
 * não rodar. Um alarme que não roda é pior que um alarme parcial.
 *
 * ## O sinal que mais importa é o do LEITOR
 *
 * `sitemap.xml` do repo pode estar em dia e o leitor ainda ver conteúdo velho,
 * porque o deploy só acontece quando o PR de publicação é mergeado
 * (`publish-edition-site-page.ts` abre PR e NUNCA mergeia, #6598). Por isso a
 * comparação com o host ao vivo não é redundante com a local — é a única que
 * mede o que a pessoa do outro lado realmente recebe.
 */

/** Dia civil `YYYY-MM-DD`. */
export type DateOnly = string;

/** Limiar de defasagem, em dias ÚTEIS. Acima disto, alarma. */
export const ACERVO_STALENESS_MAX_BUSINESS_DAYS = 2;

/**
 * Dias ÚTEIS entre duas datas (exclusivo na primeira, inclusivo na segunda).
 *
 * Úteis, e não corridos, porque a diária não sai em fim de semana: contar
 * corridos faria toda segunda-feira parecer defasagem de 3 dias e o alarme
 * viraria ruído semanal — o jeito mais rápido de ninguém mais olhar para ele.
 *
 * Feriado não é considerado: acrescentaria um calendário para manter em troca
 * de reduzir um falso positivo por semestre. O limiar de 2 dias já absorve.
 */
export function businessDaysBetween(from: DateOnly, to: DateOnly): number {
  const inicio = Date.parse(`${from}T00:00:00Z`);
  const fim = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(inicio) || !Number.isFinite(fim) || fim <= inicio) return 0;
  let dias = 0;
  for (let t = inicio + 86_400_000; t <= fim; t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) dias += 1;
  }
  return dias;
}

export interface AcervoSnapshot {
  /** Edição mais recente PRODUZIDA (`data/editions/`). `null` se `data/` ausente. */
  produzida: DateOnly | null;
  /** `lastmod` mais recente no `sitemap.xml` do REPO. `null` se ilegível. */
  sitemapLocal: DateOnly | null;
  /** Edição mais recente que o leitor vê em `arquivo.diar.ia.br`. `null` se a rede falhou. */
  aoVivo: DateOnly | null;
  /** Hoje, para medir a defasagem. */
  hoje: DateOnly;
}

export type AcervoVerdict = "ok" | "defasado" | "sem-dado";

export interface AcervoStalenessResult {
  verdict: AcervoVerdict;
  /** Defasagem em dias úteis do sinal mais grave. `null` quando não deu para medir. */
  diasUteis: number | null;
  /** Frase única, pronta para o corpo do alarme. */
  resumo: string;
  /** Comparações que não puderam ser feitas, e por quê. */
  lacunas: string[];
}

/**
 * Avalia a defasagem.
 *
 * A comparação decisiva é **produzida × ao vivo**: é a distância entre o que
 * existe e o que a pessoa lê. As outras duas entram como diagnóstico, para o
 * alarme dizer ONDE parou:
 *
 *   - produzida > sitemap local → a publicação não rodou (ou o PR não mergeou);
 *   - sitemap local > ao vivo   → mergeou e não deployou.
 */
export function evaluateAcervoStaleness(
  snap: AcervoSnapshot,
  maxBusinessDays = ACERVO_STALENESS_MAX_BUSINESS_DAYS,
): AcervoStalenessResult {
  const lacunas: string[] = [];
  if (!snap.produzida) lacunas.push("data/editions/ ausente — não dá para saber qual é a edição mais recente");
  if (!snap.sitemapLocal) lacunas.push("sitemap.xml do repo ilegível");
  if (!snap.aoVivo) lacunas.push("arquivo.diar.ia.br não respondeu — a comparação que mede o leitor não foi feita");

  // Referência: o que existe. Sem `data/`, o sitemap local serve de proxy —
  // pior, mas ainda pega o caso "mergeou e não deployou".
  const referencia = snap.produzida ?? snap.sitemapLocal;
  if (!referencia || !snap.aoVivo) {
    return {
      verdict: "sem-dado",
      diasUteis: null,
      resumo: `não foi possível comparar acervo produzido com o publicado (${lacunas.join("; ")})`,
      lacunas,
    };
  }

  const dias = businessDaysBetween(snap.aoVivo, referencia);
  if (dias <= maxBusinessDays) {
    return {
      verdict: "ok",
      diasUteis: dias,
      resumo:
        dias === 0
          ? `acervo em dia — o leitor vê a edição de ${snap.aoVivo}, a mais recente que existe`
          : `acervo com ${dias} dia(s) útil(eis) de defasagem, dentro do limiar de ${maxBusinessDays}`,
      lacunas,
    };
  }

  // Onde parou: os dois elos têm remédios diferentes, e dizer qual é economiza
  // a investigação inteira.
  const onde =
    snap.sitemapLocal && businessDaysBetween(snap.sitemapLocal, referencia) > 0
      ? "a página não foi publicada no repo (publish-edition-site-page não rodou, ou o PR não foi mergeado)"
      : "o repo está em dia mas o host não — falta deploy do worker `diaria-site`";

  return {
    verdict: "defasado",
    diasUteis: dias,
    resumo:
      `o leitor vê a edição de ${snap.aoVivo}, mas a mais recente é de ${referencia} — ` +
      `${dias} dias úteis de defasagem (limiar: ${maxBusinessDays}). Provável causa: ${onde}`,
    lacunas,
  };
}

/** `AAMMDD` → `YYYY-MM-DD`. `null` se não for uma data válida. */
export function editionIdToDate(id: string): DateOnly | null {
  if (!/^\d{6}$/.test(id)) return null;
  const iso = `20${id.slice(0, 2)}-${id.slice(2, 4)}-${id.slice(4, 6)}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

/** `lastmod` mais recente de um `sitemap.xml`. `null` se não houver nenhum. */
export function latestLastmod(xml: string): DateOnly | null {
  const datas = [...xml.matchAll(/<lastmod>\s*(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]).sort();
  return datas.at(-1) ?? null;
}

/**
 * Data mais recente listada no HTML de `arquivo.diar.ia.br`.
 *
 * O acervo lá é DERIVADO do sitemap do apex em request-time, então basta ler as
 * datas que ele renderiza — não é preciso um endpoint próprio.
 */
export function latestDateInArchiveHtml(html: string): DateOnly | null {
  const datas = [...html.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)].map((m) => m[0]).sort();
  return datas.at(-1) ?? null;
}
