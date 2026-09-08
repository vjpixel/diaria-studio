/**
 * scripts/lib/shared/retrospectiva-path.ts (#7658)
 *
 * Classifica o path de `retrospectiva.diar.ia.br` nos três formatos de
 * retrospectiva, e é ele quem decide QUAL GATE se aplica:
 *
 *   | path               | conteúdo                        | gate            |
 *   |--------------------|---------------------------------|-----------------|
 *   | `/AAMM`            | Panorama do Mês (recap mensal)  | apoio R$25+     |
 *   | `/AAAA`            | retrospectiva anual (janeiro)   | cadastro grátis |
 *   | `/aniversarioAAAA` | retrospectiva de aniversário    | cadastro grátis |
 *
 * Módulo PURO e compartilhado de propósito: o Worker precisa da classificação
 * para rotear, e os publishers (`build-article-page.ts`,
 * `build-annual-page.ts`) precisam da MESMA regra para derivar a chave do KV.
 * Se as duas divergirem, o publisher grava numa chave que o Worker nunca lê —
 * falha silenciosa, página 404 com o conteúdo publicado do lado.
 *
 * ## A ambiguidade `/AAMM` × `/AAAA`, que é real
 *
 * Os dois são 4 dígitos. `2607` é julho/2026; `2026` é o ano de 2026. Não há
 * como distinguir por forma — só por INTERVALO, e a regra precisa estar num
 * lugar só, testada, em vez de improvisada no roteador:
 *
 *   **os 2 últimos dígitos entre 01 e 12 fazem MÊS; o resto faz ANO.**
 *
 * Consequências que valem saber, em vez de descobrir depois:
 *
 * - `/2601` é lido como **janeiro/2026**, nunca como o ano 2601. É a colisão
 *   que a regra não resolve, e ela é aceitável porque o ano 2601 não é um
 *   intervalo plausível para este produto — mas quem mudar isto precisa saber
 *   que a escolha foi consciente.
 * - Anos terminados em 01–12 (2601, 2602, …) são inalcançáveis como ANO. O
 *   primeiro ano problemático de verdade seria 2601, a 575 anos daqui.
 * - `/2600`, `/2613`..`/2699` são lidos como ANO — nenhum é um mês válido.
 *
 * ## Ano coberto, não ano de publicação
 *
 * Decisão do editor (08/09/2026): a retrospectiva do ano civil de 2026,
 * publicada em janeiro de 2027, mora em `/2026`. "Retrospectiva de 2026" lê-se
 * sozinho; `/2027` exigiria explicar que o número é a data do envio.
 *
 * O repo já seguia essa convenção nos diretórios (`data/annual/2026-janeiro/`
 * é a edição enviada em jan/2027 — ver `annual-window.ts`, "o ano que a
 * retrospectiva fecha, independente de quando ela é enviada"), então
 * `anualPathFromSlug` é IDENTIDADE, não conversão.
 *
 * O aniversário tem prefixo próprio porque não cobre um ano civil: a edição de
 * agosto cobre ago–jul, e o `AAAA` ali é o ano do aniversário (`/aniversario2026`
 * = 1º aniversário, agosto de 2026).
 */

// O gate de cada formato vive como literal na variante correspondente de
// `RetrospectivaPath` abaixo — não há alias `RetrospectivaGate` porque ainda
// não existe consumidor que trate gate genericamente (o Worker que vai fazer
// isso é a próxima fatia da #7658). Exportar o alias antes disso é export
// órfão, e o knip reprova — com razão.

export type RetrospectivaPath =
  | { kind: "mensal"; ano: number; mes: number; slug: string; gate: "apoio-mantenedor" }
  | { kind: "anual"; ano: number; slug: string; gate: "cadastro" }
  | { kind: "aniversario"; ano: number; slug: string; gate: "cadastro" };

/**
 * O ano de 2 dígitos (`AA` de `AAMM`) é sempre 20xx neste produto — a diária
 * começou em 2025 e o formato de ciclo do repo (`YYMM-MM`) já assume isso em
 * `monthly-paths.ts`. Extraído como constante pra que a suposição apareça.
 */
const SECULO = 2000;

/**
 * Classifica o path. `null` para qualquer coisa que não case os três
 * formatos — o caller decide o que fazer (404, form, erro), e nunca deve
 * "chutar" um formato: servir a retrospectiva errada é pior que não servir.
 *
 * Aceita com ou sem barras nas pontas (`/2607`, `2607`, `/2607/`).
 *
 * @pure
 */
export function classifyRetrospectivaPath(pathname: string): RetrospectivaPath | null {
  const slug = pathname.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
  if (!slug) return null;

  const aniversario = /^aniversario(\d{4})$/.exec(slug);
  if (aniversario) {
    const ano = Number(aniversario[1]);
    return { kind: "aniversario", ano, slug, gate: "cadastro" };
  }

  if (!/^\d{4}$/.test(slug)) return null;

  // A desambiguação: 2 últimos dígitos em 01–12 fazem mês. Ver docstring do
  // módulo pro que isso torna inalcançável, e por que é aceito.
  const doisUltimos = Number(slug.slice(2));
  if (doisUltimos >= 1 && doisUltimos <= 12) {
    return { kind: "mensal", ano: SECULO + Number(slug.slice(0, 2)), mes: doisUltimos, slug, gate: "apoio-mantenedor" };
  }

  return { kind: "anual", ano: Number(slug), slug, gate: "cadastro" };
}

/**
 * Path do Panorama do Mês a partir do CICLO do repo (`YYMM-MM`, ex:
 * `2607-08` = conteúdo de julho, envio em agosto).
 *
 * O path leva o mês de CONTEÚDO (`2607`), não o de envio: é o mês sobre o qual
 * a edição fala, e é o que o leitor procura. O mês de envio existe no ciclo
 * porque a produção precisa dos dois, mas não é identidade do conteúdo — e
 * mantê-lo na URL criaria dois identificadores para a mesma edição.
 *
 * @pure
 */
export function mensalPathFromCycle(cycle: string): string | null {
  const m = /^(\d{2})(\d{2})-\d{2}$/.exec(cycle.trim());
  if (!m) return null;
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) return null;
  return `${m[1]}${m[2]}`;
}

/**
 * Path da retrospectiva anual a partir do slug atual do repo
 * (`data/annual/{slug}`, ex: `2026-aniversario`, `2026-janeiro`).
 *
 * Traduz os dois formatos que a `/diaria-anual` produz hoje para o esquema de
 * URL novo — é a peça que permite os redirects 301 de `anual.diar.ia.br/{slug}`
 * sem inventar um mapeamento à mão por edição.
 *
 * @pure
 */
export function anualPathFromSlug(slug: string): string | null {
  const s = slug.trim().toLowerCase();
  const aniversario = /^(\d{4})-anivers[áa]rio$/.exec(s);
  if (aniversario) return `aniversario${aniversario[1]}`;
  const janeiro = /^(\d{4})-janeiro$/.exec(s);
  if (janeiro) {
    // IDENTIDADE, sem offset: o slug do repo JÁ é o ano coberto. A 1ª versão
    // disto subtraía 1, assumindo que o slug carregava o ano de PUBLICAÇÃO —
    // e `annual-window.ts` diz o contrário, na letra: "O ano do diretório/
    // edição é o do último mês da janela — é o ano que a retrospectiva fecha,
    // independente de quando ela é enviada". A edição enviada em jan/2027
    // cobre 2026 e mora em `data/annual/2026-janeiro/`, não `2027-janeiro`.
    //
    // O erro era invisível: devolvia `2025` para `2026-janeiro`, um ano que
    // existe e classifica como anual — redirect pra retrospectiva errada, sem
    // 404 pra denunciar. O teste de round-trip contra `annualSlug` (a fonte
    // real do slug) existe pra que a suposição não volte a divergir.
    return janeiro[1];
  }
  return null;
}
