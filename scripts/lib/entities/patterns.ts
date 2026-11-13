/**
 * patterns.ts (#5125 — condição do editor 14/08/2026: regeneração automática)
 *
 * Registro de palavra-chave por página de entidade — mesmo papel que
 * `HUB_KEYWORD_PATTERNS` (`scripts/generate-hub-sources.ts`) cumpre pros
 * hubs, aplicado às páginas de `scripts/lib/entities/*.ts`/`ENTITY_LOADERS`
 * (`scripts/build-entity-page.ts`). Único consumidor até aqui:
 * `scripts/lib/entity-staleness-check.ts`, que audita o corpus contra o
 * `mentions` já commitado de cada entidade e alarma quando uma edição nova
 * bate o padrão e ainda não foi incorporada — ver docstring daquele módulo
 * para o mecanismo completo.
 *
 * Para as 8 entidades internacionais, cada regex reproduz EXATAMENTE o padrão
 * já documentado em prosa no docstring da entidade correspondente
 * (verificado ao vivo em 15/08/2026, contagem de matches contra o corpus real
 * batendo com o número de edições citado em cada arquivo — ver
 * `test/entity-staleness-check.test.ts`). O lote brasileiro do #8350 é
 * EXCEÇÃO, documentada no bloco dele abaixo: a contagem do docstring foi
 * feita no texto completo das edições, e o alarme não bate com ela.
 * Nunca duplicar a lógica de match aqui — só o padrão; a leitura do corpus
 * (`collectHubSources`/`loadPosts`) é reusada de `generate-hub-sources.ts`.
 */

/** slug (chave de `ENTITY_LOADERS`) -> regex de match contra
 * título+subtítulo, mesma convenção de `HUB_KEYWORD_PATTERNS`. */
export const ENTITY_KEYWORD_PATTERNS: Record<string, RegExp> = {
  perplexity: /\bperplexity\b/i,
  xai: /\bxai\b|\bgrok\b/i,
  amazon: /\bamazon\b|\baws\b|jeff bezos|andy jassy/i,
  samsung: /\bsamsung\b/i,
  apple: /\bapple\b|\bsiri\b|tim cook/i,
  deepseek: /\bdeepseek\b/i,
  oracle: /\boracle\b/i,
  alibaba: /\balibaba\b/i,
  // #8350 (1º lote brasileiro). Sem acento de propósito: `collectHubSources`
  // compara contra o texto sem acento (`stripAccents`). `sabia` sozinho
  // casaria o verbo ("não sabia que..."), por isso só com versão/diminutivo.
  //
  // EXCEÇÃO ao "reproduz exatamente" do topo do arquivo, nas 4 entradas:
  //   - a contagem dos docstrings (`tse.ts`, `pl-2338.ts`, `nubank.ts`,
  //     `maritaca-ai.ts`) foi feita no TEXTO COMPLETO das edições; este
  //     alarme por título+subtítulo do cache vê menos (10 das 33 menções
  //     publicadas casam por título); a menção nova só no corpo é coberta
  //     pelo scanner de texto completo do #12958 (`entity-fulltext-scan.ts`,
  //     slugs e data de corte em `ENTITY_FULLTEXT_SCAN_SINCE` abaixo), e o
  //     `regenerate-entity-pages.ts` imprime a cobertura das duas leituras;
  //   - Maritaca acrescenta `sabiazinho`, que a regex de contagem não tinha
  //     (ver docstring de `maritaca-ai.ts`);
  //   - PL 2338 monitora só a família ESTREITA (número do PL e "marco legal
  //     da IA"), não a regex ampla do docstring (`2\.?338|Aguinaldo
  //     Ribeiro|PL da IA`), que casaria notícia de outro assunto. Aceita as
  //     grafias "PL 2338", "PL 2.338", "PL nº 2338", "PL n. 2.338" e
  //     "Projeto de Lei 2338" (já sem acento, "nº" vira "no"/"n"+"º").
  tse: /\btse\b|tribunal superior eleitoral/i,
  "pl-2338":
    /\bpl\s*(n[o.º°]?\.?\s*)?2\.?338\b|\bprojeto de lei\s*(n[o.º°]?\.?\s*)?2\.?338\b|marco legal da (ia|inteligencia artificial)\b/i,
  nubank: /\bnubank\b/i,
  "maritaca-ai": /\bmaritaca\b|\bsabia[- ]?\d|\bsabiazinho\b/i,
};

/**
 * #12958: entidades cujo alarme também lê o TEXTO COMPLETO das edições do
 * site (`scripts/lib/entity-fulltext-scan.ts`), e a data (`YYYY-MM-DD`, pela
 * `article:published_time` da página) a partir da qual o scanner vale.
 *
 * O corte existe porque o histórico anterior foi lido à mão na contagem do
 * #8350 (306 edições, até 11/11/2026): acertos que a leitura descartou de
 * propósito (Nubank como cliente numa lista, 29/09/2025; "Marco Legal da IA
 * tramitando" de passagem, 14/05/2026) virariam alarme falso permanente.
 * Medido em 13/11/2026 sobre as 307 páginas do site: sem corte, o scanner
 * devolve só essas 2 edições fora do `mentions`, então o corte não esconde
 * nenhuma menção posterior a 14/05/2026. Entidade nova que entrar aqui leva a
 * data em que a contagem dela foi feita.
 */
export const ENTITY_FULLTEXT_SCAN_SINCE: Readonly<Record<string, string>> = {
  tse: "2026-11-12",
  "pl-2338": "2026-11-12",
  nubank: "2026-11-12",
  "maritaca-ai": "2026-11-12",
};

/**
 * slug -> lista de `editionSlug` que casam `ENTITY_KEYWORD_PATTERNS[slug]`
 * mas foram EXCLUÍDOS de propósito de `mentions` por decisão editorial já
 * registrada (falso-positivo, redundância, ou item sem desenvolvimento
 * próprio no corpo — ver critério anti-thin-content em `entity-page.ts`).
 * Sem esta lista, `entity-staleness-check.ts` alarmaria pra sempre sobre
 * uma edição que já foi lida e conscientemente deixada de fora — o
 * equivalente, no domínio de entidade, do "descarte documentado" que
 * `docs/entity-page-candidates.md` já pratica no nível de CANDIDATA
 * (Microsoft/Nvidia por volume alto demais, DeepSeek por falso-positivo).
 *
 * Slug ausente daqui = nenhuma exclusão conhecida (staleness check trata
 * qualquer match fora de `mentions` como pendência real).
 */
export const ENTITY_EXCLUDED_EDITIONS: Record<string, readonly string[]> = {
  // 3 dos 10 matches por regex de `apple` (ver docstring de `apple.ts`) não
  // entraram em `mentions` — lidos e descartados na auditoria de 15/08/2026:
  apple: [
    // "Siri agora terá Gemini" (slug: siri-agora-tera-gemini, publicado
    // 2025-11-06) — desenvolvimento genuíno (acordo bilionário
    // Apple-Google), mas redundante com o mesmo arco de "busca com IA no
    // Siri" já coberto pela menção de openai-anuncia-controles-parentais
    // (2025-09-04, "World Knowledge Answers"); manter as duas duplicaria o
    // mesmo tema em 2 entradas da timeline sem agregar leitura nova.
    "siri-agora-tera-gemini",
    // 2026-03-25, "Siri vs Claude vs ChatGPT no iOS" — cobertura sobre a
    // ESCOLHA do usuário entre assistentes concorrentes, não um
    // desenvolvimento de PRODUTO da Apple em si (mesmo racional de excluir
    // rodapé de autopromoção do docstring de `entity-page.ts`: o corpo é
    // sobre a Siri como jogador cada vez mais fraco no mercado, não sobre
    // um recurso/decisão que a Apple tomou).
    "claude-agora-controla-seu-computador",
    // 2026-02-02, "Apple aposta em IA silenciosa para comandos" (aquisição
    // da Q.ai) — desenvolvimento real, mas redundante em tema com as demais
    // menções de "mais um recurso de IA embarcado" (aqui: sensores para
    // fala silenciosa) sem abrir um fio narrativo distinto o bastante pra
    // justificar uma 8ª entrada além do piso já superado (7 > 5).
    "google-nvidia-e-bezos-investem-na-humans",
  ],
  // 2 exclusões pra `deepseek` (ver docstring de `deepseek.ts`, auditoria
  // de 15/08/2026):
  deepseek: [
    // 2026-04-06, "Irã mira o maior datacenter de IA fora dos EUA" — a
    // menção casa via subtítulo ("A aposta do Google contra Meta e
    // DeepSeek"), mas o parágrafo do corpo nunca cita a DeepSeek
    // especificamente — só Moonshot, Alibaba e Z.AI como concorrentes
    // chineses de pressão, mais o Llama da Meta. Título mencionando a
    // entidade sem o corpo sustentar (mesmo padrão de "scaled content
    // abuse" descrito no docstring de `entity-page.ts`).
    "ir-mira-o-maior-datacenter-de-ia-do-mundo",
    // 2026-07-08, "DeepSeek planeja chip próprio de IA, diz Reuters" —
    // MESMO desenvolvimento da menção mantida de 2026-07-09 ("Chip
    // próprio: DeepSeek reduz dependência dos EUA", fonte CNN), noticiado
    // 1 dia antes por outra agência de imprensa. Sem fato novo entre uma
    // versão e outra — manter as duas duplicaria a mesma notícia na
    // timeline sem agregar leitura.
    "claude-cowork-chega-ao-celular-e-a-web",
  ],
  "pl-2338": [
    // 2026-05-22, "Senado aprova marco legal da IA no Brasil" — a edição
    // tratou como notícia do mês uma aprovação que, pela tramitação oficial
    // (senado.leg.br, matéria 157233), ocorreu em 10/12/2024. Mesma correção
    // já documentada no hub `brasil-regulacao` (#5060); a metodologia de
    // `pl-2338.ts` explica a ausência ao leitor (#8350).
    "soberania-ia-pu-blica-nacional",
  ],
};
