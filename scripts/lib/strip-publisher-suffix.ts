/**
 * strip-publisher-suffix.ts (#2140, extended in #2664 + #2672)
 *
 * Remove o sufixo de veículo que sites de imprensa embutem no título da página,
 * e remove ponto final residual de títulos de artigos.
 *
 * ## Sufixo de veículo (#2140, #2664)
 *
 * Separador ` | ` (pipe com espaços):
 *   "Especialistas criticam IA no Brasil | G1"
 *     → "Especialistas criticam IA no Brasil"
 *   "Gigantes da IA terão IPOs | Blogs | CNN Brasil"
 *     → "Gigantes da IA terão IPOs"
 *
 *   Regra: remover da 1ª ocorrência de " | " em diante. Anti-falso-positivo:
 *   se o prefixo antes do " | " tiver < MIN_PREFIX_LEN chars, manter original.
 *   Pipes sem espaços não são tocados.
 *
 * Separador ` - ` / ` — ` (traço / travessão) (#2664):
 *   "ChatGPT consegue fazer check-up do seu PC; veja como - Canaltech"
 *     → "ChatGPT consegue fazer check-up do seu PC; veja como"
 *
 *   Anti-falso-positivo: SOMENTE strip se o sufixo bate com KNOWN_DASH_PUBLISHERS.
 *   Títulos como "OpenAI lança GPT-5 - o maior modelo" NÃO são tocados porque
 *   "o maior modelo" não está na lista de veículos conhecidos.
 *   Verifica a ÚLTIMA ocorrência do separador (handle: "título - subtítulo - Veículo").
 *
 * ## Ponto final (#2672)
 *
 *   "OpenAI reports median Codex output tokens grew 56x since November 2025."
 *     → "OpenAI reports median Codex output tokens grew 56x since November 2025"
 *
 *   Preserva: `?`, `!`, `…`, `...` (reticências — intencionais).
 *   Strip: ponto único no fim (residual do og:title da fonte).
 *   Não aplica MIN_PREFIX_LEN guard — ponto em título curto também deve ser removido.
 *
 * ## Ordem das normalizações em normalizeItemTitle()
 *
 *   1. stripPublisherSuffix → remove sufixo de veículo
 *   2. stripTrailingPeriod  → remove ponto residual (ex: "...2025. - Canaltech"
 *      → strip Canaltech → "...2025." → strip ponto → "...2025")
 *
 * ## Funções exportadas
 *   - `stripPublisherSuffix(title)` — sufixo ` | ` + ` - ` / ` — ` (lista)
 *   - `stripTrailingPeriod(title)` — ponto final único
 *   - `normalizeItemTitle(title)` — sufixo + ponto, na ordem correta
 *   - `KNOWN_DASH_PUBLISHERS` — set de veículos (lowercase) para traço/travessão
 *   - `MIN_PREFIX_LEN` — constante de boundary para testes
 */

/**
 * Comprimento mínimo (em chars) do que sobra antes do separador para aceitar
 * o strip. Exportado para que os testes de boundary possam importar a
 * constante — qualquer ajuste futuro fica sincronizado automaticamente.
 */
export const MIN_PREFIX_LEN = 15;

/**
 * Veículos conhecidos (lowercase) para strip de traço/travessão (#2664).
 *
 * Pipe ` | ` usa heurística de comprimento (quase sempre é sufixo de veículo).
 * Traço/travessão ` - ` / ` — ` aparecem tanto em sufixo de veículo QUANTO
 * em conteúdo legítimo do título ("GPT-5 - o maior modelo"), então exigem
 * match contra esta lista para evitar falsos positivos.
 *
 * Match case-insensitive: sufixo é lowercased antes da busca no set.
 * Exportado para que testes possam verificar cobertura sem hardcodar nomes.
 */
export const KNOWN_DASH_PUBLISHERS = new Set([
  // Brasil
  "canaltech",
  "techtudo",
  "olhar digital",
  "exame",
  "g1",
  "infomoney",
  "gizmodo brasil",
  "cnn brasil",
  "uol",
  "folha de s.paulo",
  "folha de são paulo",
  "o globo",
  "agência brasil",
  "agencia brasil",
  "tecmundo",
  "metrópoles",
  "metropoles",
  "tabnews",
  "startups",
  "computerworld",
  "terra",
  "r7",
  "correio braziliense",
  "valor econômico",
  "valor economico",
  "estadão",
  "estadao",
  "band",
  "sbt news",
  "record",
  "meio&mensagem",
  "meio e mensagem",
  "mobile time",
  // Internacional
  "techcrunch",
  "the verge",
  "wired",
  "ars technica",
  "mit technology review",
  "mit tech review",
  "the new york times",
  "new york times",
  "nyt",
  "bloomberg",
  "reuters",
  "bbc",
  "bbc news",
  "bbc brasil",
  "financial times",
  "ft",
  "forbes",
  "fortune",
  "business insider",
  "engadget",
  "venturebeat",
  "9to5mac",
  "9to5google",
  "macrumors",
  "the guardian",
  "guardian",
  "washington post",
  "the washington post",
  "axios",
  "politico",
  "nature",
  "science",
  "ieee spectrum",
  "zdnet",
  "cnet",
  "pcmag",
  "tomshardware",
  "anandtech",
  "the information",
  "semafor",
]);

/**
 * Strip sufixo via ` | ` (pipe separador — #2140).
 * Strip da 1ª ocorrência em diante. Anti-FP: prefixo < MIN_PREFIX_LEN → manter.
 */
function stripPipeSuffix(title: string): string {
  const trimmed = title.trim();
  const idx = trimmed.indexOf(" | ");
  if (idx === -1) {
    // Nenhum " | " no título — retornar intacto (sem alterar whitespace do chamador).
    return title;
  }
  const prefix = trimmed.slice(0, idx).trim();
  if (prefix.length < MIN_PREFIX_LEN) {
    // Anti-falso-positivo: prefixo muito curto — manter original.
    // Retorna `title` (não `trimmed`) para preservar espaços do chamador.
    return title;
  }
  return prefix;
}

/**
 * Strip sufixo via ` - ` ou ` — ` (traço/travessão — #2664).
 * SOMENTE strip se o sufixo bate com KNOWN_DASH_PUBLISHERS (case-insensitive).
 * Verifica a ÚLTIMA ocorrência do separador para handle de "título - sub - Veículo".
 * Anti-FP: prefixo < MIN_PREFIX_LEN → manter.
 */
function stripDashSuffix(title: string): string {
  const trimmed = title.trim();

  const dashIdx = trimmed.lastIndexOf(" - ");   // espaço-hífen-espaço
  const emDashIdx = trimmed.lastIndexOf(" — "); // espaço-travessão-espaço

  // Escolhe o separador mais à direita
  let sepStart = -1;
  let sepLen = 0;
  if (dashIdx >= 0 && dashIdx > emDashIdx) {
    sepStart = dashIdx;
    sepLen = 3; // " - ".length
  } else if (emDashIdx >= 0) {
    sepStart = emDashIdx;
    sepLen = 3; // " — ".length (espaço U+0020 + travessão U+2014 + espaço U+0020)
  }

  if (sepStart === -1) return title;

  const suffix = trimmed.slice(sepStart + sepLen).trim().toLowerCase();

  // Anti-falso-positivo principal: só strip se o sufixo é veículo conhecido
  if (!KNOWN_DASH_PUBLISHERS.has(suffix)) return title;

  const prefix = trimmed.slice(0, sepStart).trim();
  if (prefix.length < MIN_PREFIX_LEN) return title;

  return prefix;
}

/**
 * Remove o sufixo de atribuição de veículo de um título de artigo.
 * Handles: ` | ` (pipe) + ` - ` / ` — ` (traço/travessão).
 *
 * @param title - Título bruto (ex: vindo de og:title / <title>).
 * @returns Título limpo, ou o original se o strip produziria prefixo muito curto
 *          ou o sufixo de traço/travessão não for veículo conhecido.
 *
 * @pure
 */
export function stripPublisherSuffix(title: string): string {
  // Pipe primeiro (strip mais amplo — strip tudo após o 1º " | ")
  const afterPipe = stripPipeSuffix(title);
  // Depois traço/travessão (só se sufixo é veículo conhecido)
  return stripDashSuffix(afterPipe);
}

/**
 * Remove ponto final único de um título de artigo (#2672).
 *
 * Manchetes NÃO terminam com ponto — mas og:title de muitos artigos
 * inclui ponto final (ex: feed RSS, sites internacionais).
 *
 * Preserva:
 *   - `?` e `!` — pontuação intencional
 *   - `…` (U+2026, reticências unicode)
 *   - `...` (3+ pontos consecutivos — reticências ascii)
 *
 * Não aplica MIN_PREFIX_LEN guard — título curto com ponto final também
 * deve ter o ponto removido (ex: "IA." → "IA").
 *
 * @param title - Título (pode já ter passado por stripPublisherSuffix).
 * @returns Título sem ponto final, ou original se o ponto é parte de reticências.
 *
 * @pure
 */
export function stripTrailingPeriod(title: string): string {
  const trimmed = title.trim();
  // Reticências: 2+ pontos consecutivos no fim → preservar
  if (/\.{2,}$/.test(trimmed)) return title;
  // Reticências unicode → preservar
  if (trimmed.endsWith("…")) return title;
  // Ponto único no fim → strip
  if (trimmed.endsWith(".")) {
    return trimmed.slice(0, -1).trimEnd();
  }
  return title;
}

/**
 * Normalização completa de título de item (#2664 + #2672).
 *
 * Ordem: sufixo de veículo PRIMEIRO, ponto final DEPOIS.
 * Razão: um título como "Evento ocorreu. - Canaltech" passa pelo strip de
 * veículo → "Evento ocorreu." e depois o ponto é removido → "Evento ocorreu".
 * Inverter a ordem deixaria o sufixo de veículo intacto nesses casos.
 *
 * @param title - Título bruto (de og:title / <title> / pipeline).
 * @returns Título normalizado.
 *
 * @pure
 */
export function normalizeItemTitle(title: string): string {
  return stripTrailingPeriod(stripPublisherSuffix(title));
}
