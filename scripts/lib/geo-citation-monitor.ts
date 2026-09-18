/**
 * lib/geo-citation-monitor.ts (#4558 Parte C)
 *
 * Núcleo puro/testável do "monitor de citação, feito em casa" pedido pela
 * issue: consulta um conjunto FIXO de perguntas em pt-BR relevantes ao
 * posicionamento da diar.ia.br (newsletter diária de IA, cursos, livros,
 * jogo "É IA?") via API OFICIAL de 3 assistentes — Claude (Anthropic),
 * ChatGPT (OpenAI) e Gemini (Google) — checando se `diar.ia.br` aparece na
 * resposta. NUNCA via scraping da interface de chat (proibido pelo
 * princípio operacional "Nunca correr risco de ToS" do CLAUDE.md).
 *
 * **Perplexity fica de fora do monitor de propósito** — não tem API de chat
 * oficial de baixo custo equivalente (Sonar API é paga por token, sem free
 * tier, e a issue já cita "poucos dólares por mês" como orçamento-alvo;
 * ver #4466 pro teto de CAC). O log de Referer (`ai-referrer-log.ts`) SIM
 * cobre Perplexity — captura tráfego mesmo sem depender da API deles.
 *
 * **Não executado ao vivo nesta sessão** — sem `ANTHROPIC_API_KEY`/
 * `OPENAI_API_KEY`/`GEMINI_API_KEY` reais no worktree isolado (mesma
 * disciplina de scripts operacionais dos #4320/#4382/#4490/#4534). O
 * mecanismo está pronto e testável via injeção de dependência
 * (`fetchImpl`), mesmo padrão de `scripts/gsc-submit-sitemaps.ts`
 * (`fetchImpl: FetchLike = gFetch`). Rodar 1x com credenciais reais é ação
 * pendente do editor.
 *
 * **Shapes de request/response são best-effort** — a API da Anthropic foi
 * verificada contra a skill `claude-api` desta sessão (web_search_20260209,
 * `web_search_tool_result`); as da OpenAI/Google são escritas do
 * conhecimento geral do modelo e PRECISAM ser conferidas contra a
 * documentação oficial atual antes da 1ª execução ao vivo — os testes deste
 * módulo cobrem o CONTRATO interno (parsing determinístico de uma resposta
 * fixture), não a forma exata da API real.
 *
 * **`ANTHROPIC_API_KEY` roda quando está no `.env` da máquina que dispara
 * a rodada — não é um fato fixo por data (#5316).** O editor criou a org
 * no Console (`console.anthropic.com`), comprou US$5 de crédito e gerou a
 * key em 11/ago/2026 (#4904), depois de um período em que a Anthropic
 * ficou deliberadamente fora (custo/setup de uma key de Console
 * pay-as-you-go, sistema de billing separado da assinatura do Claude Code)
 * — mas "a key existe" e "a key está no `.env` da máquina que roda a task
 * `Diaria-Geo-Citation-Monitor`" são fatos DIFERENTES: a Anthropic ficou
 * muda em `300` (a máquina do timer) porque a key nunca foi reposta
 * lá depois do #5155, mesmo já existindo no Doppler. Os 3 providers
 * (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`) rodam de
 * verdade SÓ nas máquinas cujo `.env` tem a key — confira com
 * `--dry-run` (não gasta chamada de rede) ou `npm run sync-env` se a key
 * estiver no Doppler mas faltando localmente. **Achado ao vivo que ainda
 * importa:** a Anthropic tem latência
 * MUITO mais variável que OpenAI/Google — mesma pergunta isolada deu 25s,
 * 60s (timeout), 25s, e depois 180s (timeout, mesmo com `max_uses`
 * reduzido) em tentativas separadas fora do código shipado (um script de
 * teste avulso, timeout maior que o valor que foi pro código de produção —
 * o `timeoutMs` da Anthropic (270s desde #5950, era 120s) aborta antes dos
 * 180s dessa tentativa específica só na configuração antiga; não
 * reproduzível pelo caminho real de qualquer forma).
 * `GeoProviderDef.timeoutMs` (270s desde #5950) e `max_uses: 2` (redução de custo, não
 * de latência — ver as duas docstrings) são a resposta pragmática: falhas
 * ocasionais da Anthropic
 * são esperadas e tratadas fail-soft, não um bug a perseguir. Ver
 * `docs/geo-citation-monitor-setup.md` § "Captura de usage e teto de
 * custo" pro raciocínio completo e `GEO_NON_ANTHROPIC_TOKEN_PRICING`
 * (abaixo) pro custo real medido em OpenAI/Google.
 *
 * **Resiliência (#4616, fleet review da PR #4616 que introduziu este
 * módulo):** `queryProvider` tem timeout explícito (`GEO_PROVIDER_TIMEOUT_MS`,
 * 25s — mesma referência de `DEFAULT_FETCH_TIMEOUT_MS` do fetch in-page do
 * Beehiiv), separa o catch de rede do catch de parse/extração, e devolve
 * `errorKind`/`httpStatus` pra tornar a ORIGEM do erro auditável (rede vs.
 * HTTP vs. parse vs. regressão de `extractText`) em vez de um `error: string`
 * solto e indistinguível. `runGeoCitationMonitor` faz 1 retry com backoff
 * curto (`GEO_RATE_LIMIT_RETRY_DELAY_MS`).
 *
 * **Retry generalizado pra `network`/5xx, não só 429 (#8341).** A auditoria
 * de 18/09/2026 mediu 29% de erro em `history.jsonl` (493 registros), com o
 * maior balde sendo 56 timeouts de rede da Anthropic (quase metade do erro
 * total) que não tinham retry nenhum antes desta mudança — só 429 tinha.
 * `isRetryableGeoError` decide: `"network"` (timeout incluso) e HTTP 5xx
 * entram no mesmo retry único de 429 (mesmo `sleepFn`/delay, `queryProvider`
 * chamado de novo com o `timeoutMs` do provider); `"quota"` (#8061) NUNCA é
 * retentado — é falha PERMANENTE (crédito zerado), reter só queima mais uma
 * chamada cobrada sem chance de suceder; `"parse"`/`"extract"`/`"provider"`
 * também não — repetir a MESMA chamada tende a repetir o MESMO resultado
 * (não são falhas de transporte), e mais retries alongaria as ~24 chamadas
 * seriais de uma rodada completa sem ganho.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appendFileWithRetry } from "./source-runs.ts";
import { estimateCallCostUsd } from "./pricing.ts";

/** Perguntas fixas, pt-BR, relevantes ao posicionamento da diar.ia.br —
 * newsletter diária de IA, cursos, livros, jogo "É IA?". Fixo de propósito
 * (não gerado dinamicamente): o objetivo é medir a MESMA pergunta ao longo
 * do tempo, não amostrar perguntas diferentes a cada rodada. */
export const GEO_QUESTIONS: readonly string[] = [
  "Qual a melhor newsletter diária sobre inteligência artificial em português?",
  "Existe alguma newsletter brasileira que resume as notícias de IA todo dia?",
  "Onde encontro cursos gratuitos de inteligência artificial em português?",
  "Quais livros sobre inteligência artificial você recomenda em português?",
  "Como faço pra me manter atualizado sobre inteligência artificial gastando pouco tempo?",
  "Quais newsletters de IA em português vale a pena assinar?",
  "Existe algum jogo ou teste pra saber se uma imagem foi feita por IA?",
  "Quais são as melhores fontes de curadoria de notícias de inteligência artificial no Brasil?",
] as const;

/** Painel de perguntas — `"geral"` são as 8 originais acima (posicionamento
 * da diar.ia.br); `"hubs"` é o painel temático (#4900 item a), derivado das
 * perguntas frequentes que as páginas `arquivo.diar.ia.br/temas/{slug}` já
 * respondem (`scripts/lib/hubs/*.ts`); `"acervo"` (#8334) é o painel de
 * cauda longa sobre o conteúdo real das edições publicadas em `/p/{slug}`
 * — ver `GEO_ACERVO_QUESTIONS`; `"entidades"` (#8344) cobre as 8 páginas
 * `especial.diar.ia.br/entidades/{slug}/` — ver `GEO_ENTITY_QUESTIONS`. Um
 * registro sem `panel` (escrito antes de `"hubs"` existir) é lido como
 * `"geral"` por default — ver `panel` em `GeoCitationRecord` e
 * `summarizeGeoCitationRecords`. */
export type GeoQuestionPanel = "geral" | "hubs" | "acervo" | "entidades";

/**
 * Perguntas fixas, pt-BR, do painel TEMÁTICO (#4900 item a) — cobrem
 * exatamente o que as 3 páginas de hub existentes (`scripts/lib/hubs/anthropic-claude.ts`,
 * `openai-chatgpt.ts`, `google-gemini.ts`) respondem: cronologia recente de
 * cada empresa. Deliberadamente um painel SEPARADO de `GEO_QUESTIONS`, não
 * uma adição a ele — trocar o instrumento original depois de já ter visto o
 * resultado da série (24 registros de `GEO_QUESTIONS`, baseline desde 07/ago)
 * invalidaria essa série (achado #4900, citando o comentário de 07/ago na
 * #4558 que já tinha amarrado as 8 perguntas originais à decisão antes do
 * resultado). Baseline/data de início própria deste painel: ver comentário
 * do F-17 (#4558) — registrado lá antes da 1ª rodada real.
 *
 * **Ativo no cron desde 10/08/2026** (#4900). A ativação estava condicionada
 * a fechar o duplo escritor primeiro (item c / épica #4798), senão cada
 * painel novo multiplicaria registro perdido a cada rodada. Condição
 * cumprida: #4806 desarmou as tasks do Windows e #4807 armou as do Linux, e
 * a investigação do item c mostrou que o arquivo de conflito era subconjunto
 * estrito do bom (nenhuma medição perdida) — os dois arquivos de conflito
 * foram removidos.
 *
 * **A lista é escrita à mão de propósito, e NÃO deve ser derivada de
 * `HUB_META`/`HUB_LOADERS`.** É contraintuitivo — o contrato de prosa do
 * #4899 fez exatamente o contrário, iterando o registry pra que hub futuro
 * nascesse coberto —, mas aqui o efeito seria o oposto do desejado:
 * publicar um hub novo passaria a MUTAR o instrumento de medição no meio da
 * série, que é precisamente o que a regra de parada de outubro proíbe
 * (comentário de 07/08 na #4558: trocar as perguntas depois de ver o
 * resultado invalida a comparação). Um lint que ADICIONA pergunta sozinho
 * contamina a série; um que AVISA que falta pergunta, não. Por isso a
 * cobertura é garantida por guard, não por derivação — ver
 * `test/geo-hub-questions-cobrem-hubs-4900.test.ts`, que reprova quando
 * `HUB_META` tem hub sem pergunta correspondente. Quando esse teste
 * quebrar, a decisão é do editor: acrescentar as perguntas e RESETAR o
 * baseline, ou registrar que o hub novo fica fora da série corrente. */
export const GEO_HUB_QUESTIONS: readonly string[] = [
  "O que aconteceu com a Anthropic em 2026?",
  "Quando saiu o Claude Opus 5?",
  "O que aconteceu com a OpenAI e o ChatGPT em 2026?",
  "Quanto vale a OpenAI hoje?",
  "O que aconteceu com o Google Gemini em 2026?",
  "O Gemini já superou o ChatGPT em algum ranking?",
  // #4900: o hub Meta/Meta AI foi publicado em 10/08 (#4926) e o painel
  // ficou sem pergunta pra ele — acrescentadas ANTES da 1ª rodada real, que
  // é a única janela em que dá pra mexer sem invalidar a série.
  "O que aconteceu com a Meta e a IA em 2026?",
  "Por que a Meta abandonou o open source do Llama?",
  "Como está a disputa entre OpenAI, Google e Anthropic em 2026?",
  "Qual foi o maior investimento em infraestrutura de IA anunciado em 2026?",
  // #4558 (5º hub, brasil-regulacao, sessão develop 260811) —
  // acrescentadas por `test/geo-hub-questions-cobrem-hubs-4900.test.ts`
  // (guard que exige 1+ pergunta por hub publicado). DIFERENTE do caso do
  // Meta/Meta AI acima: aquele hub entrou ANTES da 1ª rodada real do
  // monitor, a única janela em que o próprio teste documenta como segura
  // pra mexer sem invalidar a série. `Diaria-Geo-Citation-Monitor` já roda
  // semanalmente desde o baseline de 07/08/2026 (#4901/#4905) — esta adição
  // é, portanto, MID-SÉRIE. Corrigir o CI (o guard bloqueia merge sem
  // pergunta pro hub novo) sem decidir sozinho se o baseline precisa
  // resetar: essa parte fica para o editor/coordenador, com acesso a
  // `data/geo-citations/` (fora deste worktree isolado) — ver a decisão
  // #4901 ("acompanhamento contínuo, sem gate binário de data") sobre como
  // ler a série depois de uma mudança de instrumento no meio dela.
  "Como funciona a regulação de IA no Brasil?",
  "O que é o Marco Legal da IA (PL 2338/23)?",
  // #4558 (6º hub, mercado-trabalho, sessão develop 260812) — acrescentadas
  // por `test/geo-hub-questions-cobrem-hubs-4900.test.ts` (guard que exige
  // 1+ pergunta por hub publicado), MID-SÉRIE como a adição do
  // brasil-regulacao acima: `Diaria-Geo-Citation-Monitor` já roda
  // semanalmente desde 07/08/2026. Mesma decisão de não resetar o baseline
  // sozinho — fica para o editor/coordenador, ver a nota completa na adição
  // do brasil-regulacao.
  "Como a IA está mudando o mercado de trabalho?",
  "Quantas empresas já demitiram citando a IA como motivo?",
  // #5741 (7º hub, medicina-saude, sessão overnight) — acrescentadas por
  // `test/geo-hub-questions-cobrem-hubs-4900.test.ts` (guard que exige 1+
  // pergunta por hub publicado), MID-SÉRIE como as adições de
  // brasil-regulacao/mercado-trabalho acima: `Diaria-Geo-Citation-Monitor`
  // já roda semanalmente desde 07/08/2026. Mesma decisão de não resetar o
  // baseline sozinho — fica para o editor/coordenador, ver a nota completa
  // na adição do brasil-regulacao.
  "O que a IA já mudou na medicina e na saúde?",
  "O CFM já regulamentou o uso de IA por médicos no Brasil?",
] as const;

/**
 * Perguntas fixas, pt-BR, do painel de ACERVO (#8334) — cauda longa
 * derivada de conteúdo REAL publicado nas edições diárias (`/p/{slug}`),
 * não pergunta genérica de posicionamento (`GEO_QUESTIONS`) nem cronologia
 * de empresa (`GEO_HUB_QUESTIONS`). Motivação da issue: o acervo de 270
 * edições é a superfície que mais recebe fetch de bot (73-122/dia contra
 * 11-17 dos hubs, medido ao vivo em `get_crawler_analytics`/logs de
 * referrer) e nenhum dos 2 painéis anteriores testava especificamente essa
 * superfície.
 *
 * **Janela de derivação (decisão de desenho desta PR — #8334 pedia pra
 * decidir e registrar, não perguntar):** conjunto FIXO e pequeno, não
 * gerado por rodada — simplicidade e comparabilidade > cobertura total,
 * dado que o objetivo inicial é só detectar SE alguma citação de acervo já
 * existe (mesmo raciocínio de `GEO_HUB_QUESTIONS` acima: trocar o
 * instrumento depois de ver resultado invalida a série). 6 perguntas — a
 * issue recomendava começar pequeno (4-6/rodada) dado o custo incremental
 * (~US$0,007/pergunta Anthropic + ~US$0,002/pergunta Google) numa
 * superfície nova ainda sem baseline. Ancoradas em 6 edições REAIS,
 * publicadas entre 21/08/2026 e 18/09/2026 (as mais recentes disponíveis
 * no acervo committed no momento desta PR — `workers/site/public/p/*`,
 * ordenadas por `<lastmod>` do `sitemap.xml`), uma por edição, sempre
 * sobre o D1 (destaque principal) — não uma leitura direta de
 * `data/editions/{AAMMDD}/01-approved.json` (que a issue citava como
 * fonte): esse diretório é gitignored e não existe num worktree isolado
 * (mesma classe de ausência que `data/snippets/`/`data/beehiiv-cache/`
 * documentam em CLAUDE.md), então esta PR ancorou nas 270 páginas do
 * acervo JÁ COMMITTED em `workers/site/public/p/` — a MESMA fonte
 * editorial de conteúdo (título/D1 de cada edição, ambos derivados do
 * mesmo `post_*.json`/`01-approved.json` no pipeline), só lida via o
 * artefato publicado em vez do intermediário de pipeline.
 *
 * **A lista é escrita à mão, como `GEO_HUB_QUESTIONS` — não regenerar
 * automaticamente a cada rodada** (mesmo racional: cauda longa comparável
 * ao longo do tempo > cobertura ampla que muda toda semana). Quando o
 * editor quiser expandir a janela (mais edições, cadência de rotação), é
 * decisão consciente de reset de baseline — mesmo tratamento que
 * `GEO_HUB_QUESTIONS` já documenta pra hub novo.
 */
export const GEO_ACERVO_QUESTIONS: readonly string[] = [
  // "OpenAI cria regra para revelar erros da própria IA" (18/09/2026)
  "A OpenAI criou uma regra pra IA revelar os próprios erros? O que ela exige?",
  // "DeepSeek quase iguala GPT-6 Astra por 1,4% do custo" (16/09/2026)
  "É verdade que o DeepSeek chegou perto do desempenho do GPT-6 Astra gastando só uma fração do custo?",
  // "10 mil agentes da OpenAI resolvem enigma de 90 anos" (11/09/2026)
  "10 mil agentes de IA da OpenAI resolveram um enigma matemático de 90 anos — isso aconteceu de verdade?",
  // "Pesquisador da Anthropic teme fim da humanidade" (10/09/2026)
  "Por que um pesquisador da Anthropic disse temer o fim da humanidade por causa da IA?",
  // "Nvidia diz que a AGI chegou, cientistas duvidam" (08/09/2026)
  "A Nvidia afirmou que a AGI já chegou — outros cientistas concordam com isso?",
  // "Tem 22 a 25 anos? A IA já pode afetar seu emprego" (28/08/2026)
  "Pessoas de 22 a 25 anos já estão perdendo emprego por causa da IA?",
] as const;

/**
 * Perguntas fixas, pt-BR, do painel de ENTIDADES (#8344) — cobrem as 8
 * páginas `especial.diar.ia.br/entidades/{slug}/` (alibaba, amazon, apple,
 * deepseek, oracle, perplexity, samsung, xai), que serve `Article` +
 * `FAQPage` + `ItemList` + `Organization` + `Person` em JSON-LD, estão no
 * sitemap de `especial` e têm regeneração + alarme de defasagem diários
 * próprios (`Diaria-Entity-Pages-Regen`, #5125) — a 2ª maior aposta de
 * conteúdo GEO do projeto depois dos hubs, e até esta issue a única sem
 * medição de citação nenhuma (conferido contra as 30 questões de `GEO_QUESTIONS`
 * (8) + `GEO_HUB_QUESTIONS` (16) + `GEO_ACERVO_QUESTIONS` (6), nenhuma delas
 * cobria essas 8 páginas).
 *
 * **Forma da pergunta é mais perto de `GEO_HUB_QUESTIONS` que de
 * `GEO_ACERVO_QUESTIONS`** (decisão de desenho da issue, não uma escolha
 * livre desta PR): cada página de entidade responde "o que a empresa X fez
 * em IA?", não cauda longa sobre 1 edição específica — por isso as 2
 * perguntas por entidade seguem o mesmo molde do painel `hubs` (1 genérica
 * de "o que aconteceu" + 1 específica ancorada num fato real da própria
 * página), nunca misturadas no MESMO painel que `acervo` (a issue #8344 é
 * explícita: misturar estragaria a leitura de ambos, mesmo motivo que
 * separou `geral`/`hubs` desde o #4900).
 *
 * **2 perguntas × 8 entidades = 16, ancoradas no `<meta name="description">`
 * real de cada página (`workers/artigos/public/entidades/{slug}/index.html`,
 * conferido ao vivo nesta PR) — não geradas, mesmo racional de
 * `GEO_HUB_QUESTIONS`/`GEO_ACERVO_QUESTIONS`: instrumento FIXO, cauda longa
 * comparável ao longo do tempo > cobertura ampla que muda toda rodada.**
 * Custo: ~US$ 0,11/rodada nos preços de `GEO_NON_ANTHROPIC_TOKEN_PRICING`
 * abaixo (16 consultas × ~US$0,007 Anthropic / ~US$0,002 Google, conforme a
 * issue) — cabe folgado no teto `--max-monthly-usd 8` já configurado pros
 * outros 3 painéis (`scripts/lib/scheduled-tasks.ts`).
 *
 * **Ordem de ativação (nota da issue #8344, não decisão desta PR): esperar
 * a #8335 (checagem de indexação estendida a `especial`) antes de LIGAR
 * este painel no cron** — sem saber se as 8 páginas estão indexadas, um
 * zero aqui teria a mesma ambiguidade que o 0/177 dos hubs teve até 06/09
 * (`docs/geo-hub-experiment.md`, que documenta o mesmo precedente sendo
 * ativado a 2/8 indexado, com a ambiguidade registrada e não bloqueante —
 * não "zero indexação bloqueia ativação"). A #8335 já fechou (#8343,
 * 18/09/2026, 4 hosts novos em `Diaria-SEO-Weekly` incluindo `especial`) —
 * a checagem real de indexação das 8 URLs específicas de `/entidades/`
 * depende da API do Search Console (fora do alcance de um worktree
 * isolado, sem credencial/rede real) e não foi reconfirmada AO VIVO nesta
 * sessão. Registrado como passo ATIVO (`monitor-entidades`) seguindo o
 * mesmo precedente do painel `hubs` — a 1ª rodada real do painel, quando
 * rodar, é o próprio sinal de indexação (0 citações em página não-indexada
 * é esperado e não é falha; ver `docs/geo-hub-experiment.md` item 5).
 *
 * **A lista é escrita à mão, como `GEO_HUB_QUESTIONS`/`GEO_ACERVO_QUESTIONS`
 * — não regenerar automaticamente por entidade nova.** Entidade nova (9ª
 * página publicada) é decisão consciente de reset de baseline, mesmo
 * tratamento documentado pra hub novo em `GEO_HUB_QUESTIONS`.
 */
export const GEO_ENTITY_QUESTIONS: readonly string[] = [
  // alibaba
  "O que a Alibaba fez em inteligência artificial em 2026?",
  "A Alibaba acusou o Claude, da Anthropic, de usar 25 mil contas falsas? O que aconteceu?",
  // amazon
  "O que aconteceu com a Amazon no mercado de inteligência artificial em 2026?",
  "Como está a disputa entre a Amazon e a Perplexity por causa de IA?",
  // apple
  "O que a Apple fez em inteligência artificial em 2026?",
  "A Apple foi processada pela X e pela xAI? Por quê?",
  // deepseek
  "O que a DeepSeek fez em 2026 que chamou atenção no mercado de inteligência artificial?",
  "É verdade que a DeepSeek cortou 75% no preço da própria API?",
  // oracle
  "O que aconteceu com a Oracle no mercado de inteligência artificial em 2026?",
  "O contrato da Oracle com a OpenAI é mesmo de US$ 300 bilhões?",
  // perplexity
  "O que aconteceu com a Perplexity em 2026?",
  "A Perplexity deixou de ser só um buscador de IA e virou um agente autônomo?",
  // samsung
  "O que a Samsung fez em inteligência artificial em 2026?",
  "A Samsung teve prejuízo na área de celulares por causa do boom de IA?",
  // xai
  "O que aconteceu com a xAI e o Grok em 2026?",
  "A xAI teve um escândalo envolvendo imagens geradas pelo Grok? O que aconteceu?",
] as const;

/** Domínio checado nas respostas (sem protocolo/path — substring match). */
export const GEO_TARGET_DOMAIN = "diar.ia.br";

export type GeoProviderId = "anthropic" | "openai" | "google";

/**
 * Usage bruto de UMA chamada, extraído da resposta (#4904). Todos os campos
 * opcionais — cada provider expõe um subconjunto diferente (só a Anthropic
 * foi verificada contra doc oficial ao vivo, ver docstring do módulo).
 * `cacheCreationInputTokens`/`cacheReadInputTokens` existem só pra permitir
 * repassar o usage da Anthropic pra `estimateCallCostUsd` (`pricing.ts`,
 * que já aplica os multiplicadores de cache) sem perder precisão — OpenAI/
 * Google nunca os populam (não têm o conceito de prompt caching na mesma
 * forma), e ficam sempre `undefined` nesses dois.
 */
export interface GeoProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Contagem de buscas server-side executadas nesta chamada, quando o
   * provider expõe (ex: Anthropic `usage.server_tool_use.web_search_requests`
   * — cada chamada habilita até `max_uses: 2`, #4904 — reduzido de 5 por
   * custo, não por latência (ver docstring de `GeoProviderDef.timeoutMs`
   * pra por que reduzir não resolveu os timeouts). Cada busca é cobrada
   * à parte do token (US$10/1000 na Anthropic) — `estimateCallCostUsd`
   * (`pricing.ts`) NÃO inclui esse custo, só token; ver `estimatedCostUsd`
   * em `GeoCitationRecord` pro aviso de que o valor é um PISO. */
  searchCount?: number;
}

export interface GeoProviderDef {
  id: GeoProviderId;
  label: string;
  /** Nome da env var com a API key. */
  envKey: string;
  /** Model ID default — sobrescrevível via env var `{ENVKEY}_MODEL` no CLI (ver main()). */
  defaultModel: string;
  /** Monta a URL + `RequestInit` pra este provider. Pure. */
  buildRequest(question: string, apiKey: string, model: string): { url: string; init: RequestInit };
  /** Extrai o texto concatenado de uma resposta JSON já parseada. Pure,
   * defensivo — nunca lança, retorna string vazia se a forma não bater. */
  extractText(json: unknown): string;
  /** Extrai o usage bruto (#4904) — MESMO contrato de `extractText`: pure,
   * defensivo, nunca lança; retorna `undefined` (não um objeto zerado) se a
   * forma não bater ou nenhum campo estiver presente, pra distinguir "não
   * consegui ler usage desta resposta" de "usage leu como zero". Opcional —
   * um provider sem `extractUsage` simplesmente não tem usage capturado
   * (`queryProvider` trata a ausência como `undefined`, nunca lança). */
  extractUsage?(json: unknown): GeoProviderUsage | undefined;
  /** Detecta se a resposta indica falha do PROVIDER que precisa virar erro,
   * nunca "não citado" (#5305, generalizado pros 3 providers em #5310) —
   * MESMO contrato de `extractText`: pure, defensivo, nunca lança; retorna
   * `undefined` quando a resposta está OK pra seguir o caminho normal de
   * `extractText`. Cada provider tem seu próprio conceito de early-stop:
   * Anthropic (`anthropicCheckProviderError`) — `stop_reason: "max_tokens"`
   * (thinking consumindo o mesmo teto do texto de resposta) ou `"refusal"`;
   * OpenAI (`openaiCheckProviderError`) — `status: "incomplete"`, `status:
   * "failed"` (geração falhou no servidor, resposta síncrona HTTP-200 com
   * `output`/`output_text` vazio e um `error` no nível raiz — #5320 finding),
   * ou bloco `type: "refusal"` em `output[]`; Google (`googleCheckProviderError`) —
   * `candidates[0].finishReason` diferente de `"STOP"` ou
   * `promptFeedback.blockReason`. Opcional: um provider sem esse método
   * simplesmente não tem essa checagem (`queryProvider` segue direto pra
   * `extractText`). O caso "terminou normalmente, mas texto vazio" (ex:
   * `stop_reason: "end_turn"` na Anthropic, `finishReason: "STOP"` no
   * Google) NÃO passa por aqui como erro — continua "não citado" legítimo. */
  checkProviderError?(json: unknown): string | undefined;
  /** Override de timeout por provider (#4904 item 4, achado ao vivo
   * 11/ago/2026) — `undefined` usa `GEO_PROVIDER_TIMEOUT_MS`. Existe porque
   * a Anthropic estourou os 25s padrão em 8/8 chamadas de uma rodada real:
   * `web_search` pode encadear buscas server-side antes de responder,
   * sequência bem mais lenta e mais VARIÁVEL que a busca single-shot da
   * OpenAI/Google.
   *
   * **A variância é real e não é explicada só por `max_uses`** — medido ao
   * vivo (11/ago/2026), várias chamadas isoladas com a MESMA pergunta, via
   * script de teste avulso com timeout configurável (não o código de
   * produção): 25s (sucesso), 60s (timeout), 25s (sucesso, `max_uses:5`),
   * e depois de reduzir pra `max_uses:2` (esperando latência mais
   * previsível), o script de teste rodando com um timeout de 180s (maior
   * que o valor que foi pro código de produção) ainda deu timeout. Reduzir
   * `max_uses` cortou o teto de buscas sequenciais mas NÃO eliminou os
   * timeouts — a causa provável é variância do lado do servidor (fila,
   * carga, ou fator da conta nova), não proporcional ao número de buscas.
   * **Não há timeout que elimine essa falha com certeza** — a skill
   * `claude-api` documenta o timeout DEFAULT do próprio SDK como 10min
   * exatamente por causa desse padrão em chamadas com tool server-side, e
   * mesmo esse valor é só uma margem, não uma garantia.
   *
   * **Atualizado no #5950 (23/08/2026): 120s era curto demais, e não só
   * "falha rápida" — media 0 citações numa rodada que tinha pelo menos 1
   * citação real (recuperada só ao reprocessar com timeout maior).**
   * Latências de sucesso medidas ao vivo: 19,9s a 173,8s; falhas
   * concentradas nos limites EXATOS de 120,0s/240,0s (sinal de timeout hard
   * do cliente, não de instabilidade do provider). O valor atual é 270s —
   * ver comentário no literal de `GEO_PROVIDERS` abaixo pro racional
   * completo da escolha entre 240-300s.
   *
   * 120s era a escolha pragmática original (#4904): succeeds na maioria das
   * chamadas observadas NAQUELA medição (25-90s), falha rápido o bastante
   * pra não travar a rodada inteira numa única chamada pendurada (roda em
   * background semanal, sem usuário esperando), e o teto de US$10/mês
   * configurado na ORG do
   * Console (console.anthropic.com → Billing → Spend limits — mecanismo
   * separado, não o `--max-monthly-usd` deste script, que hoje não é
   * passado pela task agendada — ver `SCHEDULED_TASKS` em
   * `scripts/lib/scheduled-tasks.ts`) limita o custo de falhas repetidas
   * como último recurso. **Falhas ocasionais são esperadas e tratadas
   * como fail-soft** (viram `errorKind: "network"` no registro, nunca
   * derrubam a rodada) — não é bug a corrigir, é a natureza da chamada.
   *
   * **O abort do `AbortController` é só do lado do CLIENTE** — o servidor
   * já processou (e cobrou) o que rodou até o corte: só a rodada de 8/8
   * timeouts em 25s gastou US$0,36 em créditos reais sem produzir UM
   * registro de citação sequer, confirmado no dashboard de billing do
   * Console. Timeout curto demais pra esta chamada não é só "falha rápida
   * e barata" como é pra rede/HTTP comuns — é dinheiro queimado por nada.
   *
   * **Obrigatório de propósito (não `?:`)** — achado do type-design review
   * desta PR (#4904): opcional deixava um 4º provider futuro herdar os 25s
   * default em silêncio, exatamente o jeito de errar que motivou este
   * campo. Provider sem tool server-side (a maioria) só copia
   * `GEO_PROVIDER_TIMEOUT_MS` explicitamente — sem custo de runtime, o
   * TypeScript força quem adicionar um provider novo a decidir o valor. */
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Anthropic — Messages API + web_search_20260209 (verificado contra a skill
// claude-api desta sessão: shared/tool-use-concepts.md § Server-Side Tools,
// e o Quick Reference "Server Tools" do SKILL.md).
// ---------------------------------------------------------------------------

/**
 * Budget de thinking pra Haiku 4.5 (#5951) — modelo "antigo" no sentido da
 * API de thinking: não suporta `thinking: {type: "adaptive"}` (só Opus/Sonnet
 * 4.6+) nem `output_config.effort` (a skill `claude-api` desta sessão lista
 * Haiku 4.5 na linha "Older" da tabela de Thinking & Effort — `effort` erra
 * nele, igual em Sonnet 4.5). O único jeito de pedir "reasoning baixo" é
 * `thinking: {type: "enabled", budget_tokens: N}` com N pequeno — usamos o
 * MÍNIMO aceito pela API (1024) como "effort baixo". NUNCA omitir/desligar
 * thinking por completo (mesmo raciocínio do #5305 pro Sonnet 5, sem
 * verificação equivalente ao vivo pro Haiku — mas a hipótese de que thinking
 * ligado favorece tool use é a mais conservadora, e a chamada depende do
 * `web_search` abaixo pra funcionar).
 */
const ANTHROPIC_HAIKU_THINKING_BUDGET_TOKENS = 1024;

/**
 * Detecta modelos Haiku (qualquer variante) pelo model ID — o único sinal
 * disponível aqui; `buildRequest` não tem acesso a um enum de família de
 * modelo. Usado tanto pro campo `thinking` (#5951) quanto pra variante do
 * tool `web_search` (self-review do #5954, finding P1): a skill `claude-api`
 * (Server Tools Quick Reference) diz que a variante `_20260209` (dynamic
 * filtering) exige Opus 5/4.8/4.7/4.6, Sonnet 5, ou Sonnet 4.6 — Haiku 4.5
 * NÃO está na lista, só a variante básica `_20250305` (modelos "older").
 */
function isAnthropicHaikuModel(model: string): boolean {
  return model.includes("haiku");
}

function anthropicRequest(question: string, apiKey: string, model: string) {
  // Haiku 4.5 (#5951) não aceita thinking:"adaptive" — só a família
  // Opus/Sonnet 4.6+ tem esse modo.
  const isHaiku = isAnthropicHaikuModel(model);
  const thinking = isHaiku
    ? { type: "enabled" as const, budget_tokens: ANTHROPIC_HAIKU_THINKING_BUDGET_TOKENS }
    : { type: "adaptive" as const };
  // Variante do tool web_search: `_20260209` (dynamic filtering) não é
  // suportada por Haiku — usa a básica `_20250305` pra esse modelo (sem
  // `max_uses`, que é específico da variante dynamic-filtering; a básica só
  // aceita `type`/`name`, ver Server Tools Quick Reference da skill
  // claude-api). Pra família Opus/Sonnet 4.6+, mantém `_20260209` +
  // `max_uses: 2` (ver comentário no literal `tools` abaixo pro racional de
  // custo).
  const webSearchTool = isHaiku
    ? { type: "web_search_20250305" as const, name: "web_search" as const }
    : { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 2 };
  return {
    url: "https://api.anthropic.com/v1/messages",
    init: {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        // 4096, não 1024 (#5305) — no Sonnet 5, max_tokens é teto de
        // THINKING + texto de resposta somados, e omitir/declarar `thinking`
        // como adaptativo (campo abaixo) consome parte desse teto antes de
        // qualquer texto sair. 1024 era curto demais: quando estourava,
        // `stop_reason` virava "max_tokens" com possivelmente ZERO blocos de
        // texto — `anthropicExtractText` devolvia "" e o monitor registrava
        // "não citado" (falso negativo indistinguível do caso legítimo). Ver
        // `anthropicCheckProviderError` abaixo, que agora intercepta esse
        // caso antes de virar uma citação ausente. No Haiku 4.5 (#5951), o
        // budget de thinking (1024) já cabe dentro desse teto com ~3072
        // tokens sobrando pro texto — não recalibrado porque a issue não
        // reportou truncamento nesse modelo; revisar se `max_tokens`
        // aparecer no log de erro depois da troca.
        max_tokens: 4096,
        // Sonnet 5 (e Opus/Sonnet 4.6+ em geral): adaptativo, EXPLICITAMENTE
        // declarado (#5305) — omitir `thinking` já liga adaptativo por
        // padrão nesses modelos, mas declarar aqui imuniza a chamada contra
        // a PRÓXIMA mudança de default. Haiku 4.5 (#5951): budget baixo fixo
        // (ver `ANTHROPIC_HAIKU_THINKING_BUDGET_TOKENS` acima) — é o
        // equivalente de "effort baixo" disponível pra esse modelo. Em
        // NENHUM dos dois casos thinking fica `{type: "disabled"}`: desligar
        // thinking reduz a propensão do modelo a acionar tool use, e esta
        // chamada depende do `web_search` abaixo pra funcionar.
        thinking,
        messages: [{ role: "user", content: question }],
        // max_uses: 2, não 5 — ver docstring de GeoProviderDef.timeoutMs pro
        // histórico completo. Uma rodada real com max_uses:5 (11/ago/2026)
        // gastou até 121k tokens de INPUT numa única chamada (conteúdo de
        // busca). Reduzir pra 2 NÃO eliminou os timeouts (testado ao vivo,
        // ainda falhou) — mas limita o teto de custo por chamada bem-sucedida
        // (menos conteúdo de busca acumulado), sem comprometer o propósito da
        // medição (checar citação, não pesquisa profunda). Mantido como
        // redução de custo, não como fix de latência.
        tools: [webSearchTool],
      }),
    } satisfies RequestInit,
  };
}

/** Content block da Messages API — só os campos que interessam aqui. */
interface AnthropicContentBlock {
  type?: string;
  text?: string;
  citations?: Array<{ url?: string }>;
}

function anthropicExtractText(json: unknown): string {
  const content = (json as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  const blocks = content as AnthropicContentBlock[];
  // Junta o texto visível E as URLs de citação (#4558: um assistente pode
  // linkar diar.ia.br via citação sem soletrar o domínio na prosa).
  const textParts = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  const citationUrls = blocks.flatMap((b) => (Array.isArray(b.citations) ? b.citations.map((c) => c.url ?? "") : []));
  return [...textParts, ...citationUrls].join("\n");
}

/**
 * Extrai `usage` da Messages API (#4904). `usage.server_tool_use.web_search_requests`
 * é a contagem de buscas server-side desta chamada — verificado contra a
 * skill `claude-api` (Server Tools). Único provider com pricing de TOKEN
 * verificado (`scripts/lib/pricing.ts`) — a busca em si (US$10/1000) não
 * entra na estimativa de custo, ver docstring de `GeoProviderUsage.searchCount`.
 */
function anthropicExtractUsage(json: unknown): GeoProviderUsage | undefined {
  const usage = (json as { usage?: unknown })?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
  const outputTokens = typeof u.output_tokens === "number" ? u.output_tokens : undefined;
  const cacheCreationInputTokens = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined;
  const cacheReadInputTokens = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined;
  const serverToolUse = u.server_tool_use;
  const searchCount =
    serverToolUse && typeof serverToolUse === "object" && typeof (serverToolUse as Record<string, unknown>).web_search_requests === "number"
      ? ((serverToolUse as Record<string, unknown>).web_search_requests as number)
      : undefined;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    cacheReadInputTokens === undefined &&
    searchCount === undefined
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens, searchCount };
}

/**
 * Detecta `stop_reason` de falha na Messages API (#5305). `"max_tokens"` —
 * a resposta estourou o teto de `max_tokens` (thinking + texto somados no
 * Sonnet 5) antes de terminar; `content` pode não ter NENHUM bloco `text`,
 * o que faria `anthropicExtractText` devolver `""` e o monitor registrar
 * "não citado" por engano. `"refusal"` — as salvaguardas de cyber do
 * Sonnet 5 recusaram a pergunta com HTTP 200 e `content` vazio; mesmo
 * caminho de leitura, mesmo falso negativo. Os demais `stop_reason`
 * (`"end_turn"`, `"tool_use"`, `"stop_sequence"`, `"pause_turn"`, ausente)
 * são tratados como OK — inclusive `"end_turn"` com texto vazio, que
 * continua "não citado" legítimo (o assistente respondeu e simplesmente
 * não citou o domínio).
 */
function anthropicCheckProviderError(json: unknown): string | undefined {
  const stopReason = (json as { stop_reason?: unknown })?.stop_reason;
  if (stopReason === "max_tokens") {
    return "stop_reason: max_tokens (resposta truncada — thinking + texto estouraram max_tokens; pode não haver bloco de texto)";
  }
  if (stopReason === "refusal") {
    return "stop_reason: refusal (salvaguardas do provider recusaram a pergunta — HTTP 200 com content vazio)";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// OpenAI — Responses API + web_search tool. Shape best-effort (ver docstring
// do módulo) — extractText é defensivo o bastante pra tolerar variação.
// ---------------------------------------------------------------------------

/**
 * Modelos de raciocínio da OpenAI (família GPT-5, série o) — aceitam o
 * parâmetro `reasoning`; os não-raciocínio (ex: gpt-4.1, variantes `-chat`
 * da GPT-5) rejeitam, então só mandamos quando o model casa (#8064).
 */
export function isOpenAiReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model) && !model.includes("-chat");
}

function openaiRequest(question: string, apiKey: string, model: string) {
  // #8064: effort "low" (não "minimal" — a doc oficial do web_search diz
  // "Web search does not support gpt-5 with minimal reasoning", conferido
  // em 12/09/2026).
  // O raciocínio é cobrado como token de saída; low é o bastante pra
  // decidir buscar e resumir, e mantém custo/latência perto do gpt-4.1.
  const reasoning = isOpenAiReasoningModel(model) ? { reasoning: { effort: "low" } } : {};
  return {
    url: "https://api.openai.com/v1/responses",
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: question,
        tools: [{ type: "web_search" }],
        ...reasoning,
      }),
    } satisfies RequestInit,
  };
}

/**
 * Detecta early-stop de falha na Responses API (#5310, mesma classe do
 * #5305 na Anthropic). `status: "incomplete"` — a resposta parou antes de
 * terminar; `incomplete_details.reason` distingue `"max_output_tokens"`
 * (estourou o teto de saída) de `"content_filter"` (moderação bloqueou);
 * em qualquer um dos dois, `output[]` pode não ter bloco `output_text` —
 * `openaiExtractText` devolveria `""` e o monitor registraria "não citado"
 * por engano. Também cobre um bloco de output do tipo `"refusal"`
 * (distinto de `"output_text"`) presente em QUALQUER item de `output[]` —
 * a Responses API sinaliza recusa por bloco, não só por `status` no nível
 * raiz. `status` diferente de `"incomplete"` (`"completed"`, ausente, etc.)
 * e ausência de bloco `refusal` são tratados como OK — texto vazio nesse
 * caminho continua "não citado" legítimo.
 */
function openaiCheckProviderError(json: unknown): string | undefined {
  const obj = json as { status?: unknown; incomplete_details?: unknown; output?: unknown; error?: unknown };
  if (obj.status === "incomplete") {
    const details = obj.incomplete_details;
    const reason =
      details && typeof details === "object" && typeof (details as Record<string, unknown>).reason === "string"
        ? ((details as Record<string, unknown>).reason as string)
        : undefined;
    return `status: incomplete${reason ? ` (incomplete_details.reason: ${reason})` : ""} (resposta interrompida antes de terminar — pode não haver bloco output_text)`;
  }
  if (obj.status === "failed") {
    const err = obj.error;
    const errMsg =
      err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string"
        ? ((err as Record<string, unknown>).message as string)
        : err !== undefined
          ? JSON.stringify(err)
          : undefined;
    return `status: failed${errMsg ? ` (error: ${errMsg})` : ""} (geração falhou no servidor — resposta síncrona HTTP-200 sem output válido)`;
  }
  if (Array.isArray(obj.output)) {
    for (const item of obj.output as unknown[]) {
      const content = (item as { content?: unknown })?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as unknown[]) {
        if ((block as { type?: string })?.type === "refusal") {
          return "output contém bloco type:'refusal' (provider recusou a pergunta)";
        }
      }
    }
  }
  return undefined;
}

function openaiExtractText(json: unknown): string {
  const obj = json as { output_text?: unknown; output?: unknown };
  // A Responses API expõe uma conveniência `output_text` (string) em
  // versões recentes do SDK/API — usa se presente.
  if (typeof obj.output_text === "string") return obj.output_text;
  // Fallback defensivo: percorre `output[].content[]` procurando blocos de
  // texto (`type: "output_text"` ou `type: "text"`), sem assumir a forma
  // exata (não verificada ao vivo — ver docstring do módulo).
  if (!Array.isArray(obj.output)) return "";
  const parts: string[] = [];
  for (const item of obj.output as unknown[]) {
    const content = (item as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as unknown[]) {
      const b = block as { type?: string; text?: string };
      if (typeof b?.text === "string" && (b.type === "output_text" || b.type === "text")) {
        parts.push(b.text);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Extrai `usage.{input_tokens,output_tokens}` da Responses API (#4904).
 * Shape best-effort — não verificada ao vivo (ver docstring do módulo). Sem
 * `searchCount`: não há campo conhecido/verificado que conte buscas
 * server-side nesta API; melhor ficar `undefined` (honesto) do que inventar
 * um caminho de leitura não confirmado.
 */
function openaiExtractUsage(json: unknown): GeoProviderUsage | undefined {
  const usage = (json as { usage?: unknown })?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
  const outputTokens = typeof u.output_tokens === "number" ? u.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Google — Gemini generateContent + google_search tool (grounding). Shape
// best-effort (ver docstring do módulo).
// ---------------------------------------------------------------------------

function googleRequest(question: string, apiKey: string, model: string) {
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: question }] }],
        tools: [{ google_search: {} }],
      }),
    } satisfies RequestInit,
  };
}

/**
 * Detecta early-stop de falha no `generateContent` (#5310, mesma classe do
 * #5305 na Anthropic). `candidates[0].finishReason` diferente de `"STOP"`
 * (o caso normal, resposta terminou de forma esperada) — `"MAX_TOKENS"`
 * (estourou o teto de saída), `"SAFETY"`/`"RECITATION"`/`"BLOCKLIST"`/
 * `"PROHIBITED_CONTENT"`/`"SPII"` (moderação bloqueou), `"OTHER"`, etc. —
 * indica que o candidate pode vir com `parts` vazio ou ausente, o que faria
 * `googleExtractText` devolver `""` e o monitor registrar "não citado" por
 * engano. `finishReason` ausente ou `"STOP"` é tratado como OK — texto
 * vazio nesse caminho continua "não citado" legítimo. Também cobre
 * `promptFeedback.blockReason` (a pergunta em si foi bloqueada ANTES de
 * gerar qualquer candidate — `candidates[]` pode nem existir nesse caso).
 */
function googleCheckProviderError(json: unknown): string | undefined {
  const obj = json as { candidates?: unknown; promptFeedback?: unknown };
  const promptFeedback = obj.promptFeedback;
  if (promptFeedback && typeof promptFeedback === "object") {
    const blockReason = (promptFeedback as Record<string, unknown>).blockReason;
    if (typeof blockReason === "string" && blockReason.length > 0) {
      return `promptFeedback.blockReason: ${blockReason} (pergunta bloqueada antes de gerar candidate)`;
    }
  }
  if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
    const finishReason = (obj.candidates[0] as { finishReason?: unknown })?.finishReason;
    if (typeof finishReason === "string" && finishReason !== "STOP") {
      return `candidates[0].finishReason: ${finishReason} (candidate bloqueado/truncado — pode não haver parts de texto)`;
    }
  }
  return undefined;
}

function googleExtractText(json: unknown): string {
  const candidates = (json as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const parts = (candidates[0] as { content?: { parts?: unknown } })?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return (parts as Array<{ text?: string }>)
    .filter((p) => typeof p?.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

/**
 * Extrai `usageMetadata.{promptTokenCount,candidatesTokenCount}` do
 * `generateContent` (#4904). Shape best-effort — não verificada ao vivo.
 * Sem `searchCount`: `groundingMetadata.webSearchQueries` (quando existe)
 * fica DENTRO de cada `candidates[]`, não em `usageMetadata` — misturar os
 * dois exigiria assumir mais forma não confirmada; melhor deixar
 * `searchCount` `undefined` aqui também (mesmo raciocínio de `openaiExtractUsage`).
 */
function googleExtractUsage(json: unknown): GeoProviderUsage | undefined {
  const usageMetadata = (json as { usageMetadata?: unknown })?.usageMetadata;
  if (!usageMetadata || typeof usageMetadata !== "object") return undefined;
  const u = usageMetadata as Record<string, unknown>;
  const inputTokens = typeof u.promptTokenCount === "number" ? u.promptTokenCount : undefined;
  const outputTokens = typeof u.candidatesTokenCount === "number" ? u.candidatesTokenCount : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------

/** Timeout DEFAULT por chamada de provider (usado pelo Google; OpenAI tem
 * `OPENAI_GEO_TIMEOUT_MS` próprio desde #8064) —
 * mesma referência de 25s já usada pro fetch in-page do Beehiiv
 * (`DEFAULT_FETCH_TIMEOUT_MS`, `scripts/lib/beehiiv-insert-text.ts`,
 * documentado em `context/publishers/beehiiv-playbook.md` §Fase 3). Sem
 * isso, até 24 chamadas seriais (3 providers × 8 perguntas) podiam travar
 * o processo inteiro numa conexão pendurada (achado #4616 do fleet
 * review). **Anthropic usa um valor maior** (`GeoProviderDef.timeoutMs`,
 * `GEO_PROVIDERS` logo abaixo) — 25s estourava em 8/8 chamadas reais, ver
 * docstring do campo. Declarada ANTES de `GEO_PROVIDERS` de propósito —
 * OpenAI/Google referenciam esta constante diretamente no literal do
 * array (timeoutMs agora é campo obrigatório, #4904), então a ordem
 * importa: TDZ de `const` quebraria se ficasse depois. */
export const GEO_PROVIDER_TIMEOUT_MS = 25_000;

/** #8064: timeout do provider OpenAI com gpt-5-mini (raciocínio + busca). */
export const OPENAI_GEO_TIMEOUT_MS = 90_000;

export const GEO_PROVIDERS: readonly GeoProviderDef[] = [
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    envKey: "ANTHROPIC_API_KEY",
    // Haiku 4.5, não Sonnet 5 (#5951, decisão do editor 23/08/2026) — pinned
    // (`claude-haiku-4-5-20251001`), mesma convenção do agent
    // `research-reviewer` (ver CLAUDE.md, seção "Model mix"). Corta o custo
    // por chamada de ~US$0,15 pra ~US$0,06 — ver docstring da issue #5951
    // pra decomposição do preço e o trade-off aceito (Haiku não é o modelo
    // que o leitor real encontra no Claude do dia a dia).
    defaultModel: "claude-haiku-4-5-20251001",
    buildRequest: anthropicRequest,
    extractText: anthropicExtractText,
    extractUsage: anthropicExtractUsage,
    // #5305 — stop_reason estourando max_tokens/refusal indistinguível de
    // "não citado" (ver #5310 pro equivalente OpenAI/Google abaixo).
    checkProviderError: anthropicCheckProviderError,
    // 270s, não 120s (#5950) — medição ao vivo em 23/08/2026 mostrou latências
    // de sucesso de 19,9s a 173,8s e falhas exatas nos 120,0s/240,0s (sinal de
    // timeout hard do CLIENTE, não instabilidade do provider — 0 citações
    // registradas numa rodada que tinha pelo menos 1 citação real, recuperada
    // só ao reprocessar com timeout maior). 270s fica acima dos 240s que ainda
    // viu timeout na medição, sem ir ao extremo de 300s — balanceando contra o
    // custo de uma chamada presa mais tempo numa rodada com várias perguntas
    // seriais. Ver docstring de GeoProviderDef.timeoutMs pro histórico
    // completo (inclusive o efeito parcialmente sobreposto da troca pra Haiku
    // no #5951 — Haiku tende a ser mais rápido, mas isso não foi medido, então
    // o timeout segue calibrado pela medição conservadora feita com Sonnet).
    timeoutMs: 270_000,
  },
  {
    id: "openai",
    label: "ChatGPT (OpenAI)",
    envKey: "OPENAI_API_KEY",
    // #8064 (decisão do editor, 12/09/2026): gpt-5-mini em vez de gpt-4.1 —
    // ~1/3 do custo semanal (o gpt-4.1 paga o conteúdo da busca a US$ 2/1M
    // de input) e mesma família dos modelos que o ChatGPT de consumo usa.
    defaultModel: "gpt-5-mini",
    buildRequest: openaiRequest,
    extractText: openaiExtractText,
    extractUsage: openaiExtractUsage,
    // #5310 — mesma classe do #5305: status:"incomplete" (max_output_tokens
    // ou content_filter) ou bloco type:"refusal" podem deixar output[] sem
    // texto extraível.
    checkProviderError: openaiCheckProviderError,
    // #8064: timeout próprio desde a troca pra gpt-5-mini — modelo de
    // raciocínio + web_search soma latência que o gpt-4.1 não tinha, e o
    // default de 25s não foi medido contra isso. Timeout ainda é cobrado
    // (mesmo achado da Anthropic), então errar pra cima é o lado barato.
    timeoutMs: OPENAI_GEO_TIMEOUT_MS,
  },
  {
    id: "google",
    label: "Gemini (Google)",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    buildRequest: googleRequest,
    extractText: googleExtractText,
    extractUsage: googleExtractUsage,
    // #5310 — mesma classe do #5305: finishReason diferente de "STOP"
    // (MAX_TOKENS/SAFETY/RECITATION/etc.) ou promptFeedback.blockReason
    // podem deixar parts vazio/ausente.
    checkProviderError: googleCheckProviderError,
    // Mesmo raciocínio do OpenAI acima.
    timeoutMs: GEO_PROVIDER_TIMEOUT_MS,
  },
];

/**
 * Tabela de pricing de TOKEN pra OpenAI/Google (#4904 item 4). Nasceu como
 * caminho alternativo enquanto a Anthropic ficou de fora do monitor por
 * decisão do editor (revertida no mesmo dia, 11/ago/2026 — ver docstring
 * do módulo) — mantida mesmo com a Anthropic de volta, porque a tabela de
 * pricing do Claude (`pricing.ts`) é Claude-only por design, e OpenAI/
 * Google continuam sem tabela nenhuma sem isto aqui.
 *
 * Separada de `scripts/lib/pricing.ts` de propósito: aquele módulo é
 * SÓ Claude, compartilhado com `capture-stage-usage.ts`/`aggregate-costs.ts`
 * (custo do próprio Claude Code, assunto diferente de custo de provider
 * terceiro consultado por este monitor) — misturar as duas tabelas ali
 * seria conflation, não reuso.
 *
 * Preços por 1M tokens, verificados AO VIVO em 11/ago/2026 (nunca de
 * memória — disciplina #1172):
 * - `developers.openai.com/api/docs/pricing`: gpt-4.1 = $2.00 input /
 *   $8.00 output. Existe também uma taxa fixa de $10.00/1000 chamadas pro
 *   tool `web_search` (cobrada além do token) — **não incluída aqui**, pelo
 *   MESMO motivo que a busca da Anthropic não entra na conta dela: o campo
 *   é um PISO de token, documentado como tal (ver `estimatedCostUsd`).
 * - `ai.google.dev/gemini-api/docs/pricing`: gemini-2.5-flash = $0.30
 *   input (texto) / $2.50 output. Grounding (`google_search`) é gratuito
 *   até 500 (tier free) ou 1.500 (tier pago) requisições/dia, depois
 *   $35.00/1000 — o volume desta rodada (8-16 chamadas/semana) fica bem
 *   abaixo de qualquer um dos dois limiares, então a omissão do custo de
 *   grounding aqui tende a ser exata, não só um piso, mas TRATADA como
 *   piso mesmo assim (mesma disciplina — nunca assumir tier/cota de quem
 *   vai rodar o script).
 *
 * - `gpt-5-mini` (#8064, verificado ao vivo em 12/09/2026, mesma página):
 *   $0.25 input / $2.00 output. Modelo de raciocínio — os tokens de
 *   raciocínio vêm dentro de `usage.output_tokens` e são cobrados como
 *   saída, então o cálculo abaixo já os inclui. `gpt-4.1` fica na tabela
 *   pra override via env e pra leitura do histórico.
 *
 * Só os models listados — um override
 * via `{ENVKEY}_MODEL` (ver `main()`) pra um model fora desta tabela cai em
 * `undefined`, nunca um preço inventado por aproximação de nome.
 */
const GEO_NON_ANTHROPIC_TOKEN_PRICING: Readonly<Record<string, { inputPer1M: number; outputPer1M: number }>> = {
  "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "gpt-5-mini": { inputPer1M: 0.25, outputPer1M: 2.0 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
};

/** Pure. `undefined` quando o model não está na tabela — nunca um preço
 * aproximado por prefixo/substring (diferente de `resolvePricing` do
 * `pricing.ts`, que casa por tier Claude porque tier Claude É uma família;
 * aqui cada model tem preço próprio, sem família a generalizar). */
function estimateNonAnthropicCostUsd(model: string, inputTokens: number | undefined, outputTokens: number | undefined): number | undefined {
  const pricing = GEO_NON_ANTHROPIC_TOKEN_PRICING[model];
  if (!pricing) return undefined;
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  return (input / 1_000_000) * pricing.inputPer1M + (output / 1_000_000) * pricing.outputPer1M;
}

export interface CitationDetection {
  cited: boolean;
  /** ~160 chars ao redor da 1ª ocorrência do domínio, ou `null` se não citado. */
  snippet: string | null;
}

/** Detecta se `domain` aparece no texto (case-insensitive, substring) e
 * extrai um snippet de contexto. Pure. */
export function detectCitation(text: string, domain: string = GEO_TARGET_DOMAIN): CitationDetection {
  const idx = text.toLowerCase().indexOf(domain.toLowerCase());
  if (idx < 0) return { cited: false, snippet: null };
  const start = Math.max(0, idx - 80);
  const end = Math.min(text.length, idx + domain.length + 80);
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  return { cited: true, snippet };
}

export interface GeoCitationRecord {
  /** `YYYY-MM-DD`. */
  date: string;
  /** ISO 8601 completo. */
  ts: string;
  provider: GeoProviderId;
  model: string;
  question: string;
  cited: boolean;
  domain: string;
  snippet: string | null;
  /** Presente só quando a chamada falhou (rede/HTTP/parse) — `cited` fica
   * `false` nesse caso, nunca indeterminado. */
  error?: string;
  /** Status HTTP da resposta, quando o erro veio de um HTTP não-2xx.
   * Ausente pra erro de rede/timeout (fetch nunca completou) ou de parse/
   * extração (completou com 2xx, quebrou depois) — ver `errorKind`. */
  httpStatus?: number;
  /** Discrimina a ORIGEM do erro (achado #4616 do fleet review): sem isso,
   * um bug de regressão em `extractText` (documentado como "nunca lança")
   * fica indistinguível de uma falha de rede transitória — ambos viravam o
   * mesmo `error: string` solto. `"http"` = status não-2xx; `"network"` =
   * fetch rejeitou (timeout incluso, `AbortError`); `"parse"` = `res.json()`
   * lançou (corpo não é JSON válido); `"extract"` = `provider.extractText`
   * lançou (regressão de contrato — a função é documentada como pura e
   * defensiva, nunca deveria lançar); `"provider"` (#5305) = HTTP 2xx com
   * `stop_reason` indicando falha do provider (`max_tokens` estourado ou
   * `refusal`) — sem isso, esses dois casos viravam "não citado" silencioso,
   * indistinguível do caso legítimo (texto vazio + `end_turn`); `"quota"`
   * (#8061) = HTTP 429 cujo corpo indica cota/crédito ESGOTADO (falha
   * PERMANENTE — só volta com ação do editor), não rate-limit transitório
   * (que resolveria sozinho e continua `"http"`+`httpStatus:429`). Ver
   * `classifyHttp429ErrorKind` pro critério de classificação por provider. */
  errorKind?: "http" | "network" | "parse" | "extract" | "provider" | "quota";
  /** Painel de origem da pergunta (#4900 item a) — `"geral"` (`GEO_QUESTIONS`),
   * `"hubs"` (`GEO_HUB_QUESTIONS`), `"acervo"` (`GEO_ACERVO_QUESTIONS`,
   * #8334) ou `"entidades"` (`GEO_ENTITY_QUESTIONS`, #8344). **Opcional de propósito**: registros
   * escritos antes desta mudança não têm o campo — leitores tratam ausência
   * como `"geral"` (ver `summarizeGeoCitationRecords`), nunca migram o
   * arquivo. Registros novos sempre vêm com o campo populado
   * (`runGeoCitationMonitor` estampa em todo record que produz). */
  panel?: GeoQuestionPanel;
  /** Usage bruto (#4904) — **opcional de propósito**, mesma disciplina de
   * `panel`: os 40 registros escritos antes desta mudança não têm nenhum
   * destes campos, e leitores (`summarizeGeoCitationRecords`, o alarme de
   * staleness) continuam funcionando sem eles — nunca migram o arquivo.
   * Populados só quando `provider.extractUsage` existir E a resposta bater
   * a forma esperada (ver `GeoProviderUsage`). */
  inputTokens?: number;
  outputTokens?: number;
  /** Contagem de buscas server-side desta chamada, quando o provider expõe
   * (hoje só a Anthropic). */
  searchCount?: number;
  /** Custo estimado em USD desta chamada — token-only, pros 3 providers
   * (#4904 item 4): Anthropic via `estimateCallCostUsd`
   * (`scripts/lib/pricing.ts`), OpenAI/Google via
   * `estimateNonAnthropicCostUsd`/`GEO_NON_ANTHROPIC_TOKEN_PRICING` (acima
   * neste arquivo — módulo separado de `pricing.ts` de propósito, ver
   * docstring da tabela). Model fora de qualquer tabela → `undefined`,
   * nunca um número inventado. **É um PISO, não o custo total**: nenhuma
   * das duas tabelas precifica a busca server-side em si — só o token. Na
   * Anthropic isso é US$10/1000 buscas; na OpenAI, US$10/1000 chamadas de
   * `web_search`; no Google, grátis até 500-1.500 requisições/dia e depois
   * US$35/1000 (ver a tabela pra data de verificação). **A Anthropic roda
   * de verdade quando `ANTHROPIC_API_KEY` está no `.env` da máquina que
   * disparou a rodada — não garantido por data** (#5316, ver docstring no
   * topo do arquivo) — mas com latência bem mais variável que OpenAI/Google (ver docstring de
   * `GeoProviderDef.timeoutMs`), então uma fração das chamadas termina em
   * timeout e não gera este campo (fail-soft, não é bug). Ver
   * `docs/geo-citation-monitor-setup.md` § "Captura de usage e teto de
   * custo" pro raciocínio completo. */
  estimatedCostUsd?: number;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type QueryProviderResult =
  | { ok: true; text: string; usage?: GeoProviderUsage }
  | { ok: false; error: string; errorKind: "http" | "network" | "parse" | "extract" | "provider" | "quota"; httpStatus?: number };

/**
 * Distingue 429 de RATE-LIMIT transitório (resolve sozinho, o retry de
 * `runGeoCitationMonitor` costuma bastar) de 429 de COTA/CRÉDITO ESGOTADO
 * (falha PERMANENTE — só volta com ação do editor, ex: recarregar crédito)
 * — #8061. Achado ao vivo: o provider OpenAI ficou 2 SEMANAS emitindo
 * `HTTP 429: You have no credits remaining` e a exceção do #4754 ("100% de
 * 429 é rate-limit de free tier, não é quebra") tratou isso como saudável.
 *
 * Critério por provider (baseado no formato real de erro documentado de
 * cada API, não numa regex genérica sobre "quota"):
 *   - **OpenAI**: corpo JSON com `error.code === "insufficient_quota"`, OU
 *     a mensagem citando "no credits" (o texto exato visto ao vivo, "You
 *     have no credits remaining") — os dois sinais de cota oficialmente
 *     documentados pela OpenAI para 429 de billing, distintos do 429 de
 *     `rate_limit_exceeded`.
 *   - **Google/Gemini**: corpo JSON com `error.status === "RESOURCE_EXHAUSTED"`
 *     E indício de quota DIÁRIA no `quotaId`/mensagem da violação
 *     (`PerDay`, case-insensitive) — a Gemini usa o MESMO status
 *     `RESOURCE_EXHAUSTED` tanto pra rate-limit por MINUTO (transitório)
 *     quanto pra quota DIÁRIA (obriga esperar até a virada do dia UTC);
 *     sem o indício de `PerDay`, um `RESOURCE_EXHAUSTED` genérico cai como
 *     rate-limit (mesmo comportamento de antes do #8061 — nunca reprova o
 *     que já era só aviso).
 *   - Qualquer outro provider (Anthropic não expõe uma distinção
 *     equivalente no corpo do 429 hoje) cai em `"http"` — fail-direction
 *     benigna preservada.
 *
 * Pure, nunca lança — `bodyText` pode vir truncado (`queryProvider` já
 * corta em 300 chars antes de logar, mas a classificação roda sobre o
 * corpo INTEIRO, ANTES do corte) ou não ser JSON válido; nesses casos cai
 * no fallback textual (regex sobre o texto cru) antes de desistir e
 * devolver `"http"`.
 */
export function classifyHttp429ErrorKind(bodyText: string): "http" | "quota" {
  let parsed: { error?: { code?: unknown; status?: unknown; message?: unknown } } | undefined;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  const code = typeof parsed?.error?.code === "string" ? parsed.error.code : undefined;
  const status = typeof parsed?.error?.status === "string" ? parsed.error.status : undefined;
  const message = typeof parsed?.error?.message === "string" ? parsed.error.message : bodyText;

  // OpenAI: insufficient_quota (código oficial) ou a mensagem de "sem
  // crédito" vista ao vivo — cobre o payload real mesmo que a mensagem
  // exata mude de fraseado (checa a substring estável "no credits").
  if (code === "insufficient_quota" || /no credits/i.test(message)) {
    return "quota";
  }
  // Gemini: RESOURCE_EXHAUSTED é ambíguo sozinho (serve rate-limit por
  // minuto E quota diária) — só conta como "quota" com o indício de "por
  // dia" no corpo (quotaId costuma citar "PerDay" nas violações da API).
  if (status === "RESOURCE_EXHAUSTED" && /perday/i.test(bodyText.replace(/[\s_-]+/g, ""))) {
    return "quota";
  }
  return "http";
}

/** Consulta 1 provider com 1 pergunta e devolve o texto extraído (ou erro).
 * Nunca lança — falha de rede/HTTP/parse/extração/provider vira `{ok:false,
 * error, errorKind}`. O catch de rede (`fetchImpl`) é separado do catch de
 * parse/extração (achado #4616): assim uma regressão em `extractText` nunca
 * se disfarça de falha de rede transitória. Timeout explícito via
 * `AbortController` (`GEO_PROVIDER_TIMEOUT_MS`) quando `fetchImpl` não
 * suporta `signal` nativamente do lado do caller — o timeout é aplicado
 * aqui, não deixado a cargo de cada `buildRequest`. `checkProviderError`
 * (#5305) roda ANTES de `extractText`, com prioridade: um HTTP 2xx cujo
 * `stop_reason` indica falha do provider (`max_tokens`/`refusal`) vira
 * `errorKind: "provider"` mesmo quando `extractText` teria devolvido texto
 * vazio — sem essa checagem, esse texto vazio virava "não citado" indistinguível
 * do caso legítimo (`end_turn` sem menção ao domínio). */
export async function queryProvider(
  provider: GeoProviderDef,
  question: string,
  apiKey: string,
  model: string,
  fetchImpl: FetchLike,
  timeoutMs: number = GEO_PROVIDER_TIMEOUT_MS,
): Promise<QueryProviderResult> {
  const { url, init } = provider.buildRequest(question, apiKey, model);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), errorKind: "network" };
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // #8061: 429 tem 2 causas bem distintas (rate-limit transitório vs.
    // cota/crédito esgotado permanente) — classifica ANTES de truncar o
    // corpo pro log, pra não perder o `error.code`/`quotaId` que a
    // classificação depende de ver inteiro.
    const kind: "http" | "quota" = res.status === 429 ? classifyHttp429ErrorKind(body) : "http";
    return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}`, errorKind: kind, httpStatus: res.status };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), errorKind: "parse" };
  }
  // #5305 — checa ANTES de extractText, com prioridade sobre o texto que
  // extractText devolveria. Catch próprio pelo mesmo motivo do catch de
  // extractUsage abaixo: checkProviderError é documentado "nunca lança",
  // mas uma regressão aqui não pode se disfarçar de erro de outra origem
  // nem derrubar o caminho de sucesso.
  let providerError: string | undefined;
  try {
    providerError = provider.checkProviderError?.(json);
  } catch {
    providerError = undefined;
  }
  if (providerError) {
    return { ok: false, error: providerError, errorKind: "provider" };
  }
  // Separado do catch de parse de propósito (achado #4616): extractText é
  // documentado como pura/defensiva/nunca-lança — se algum dia regredir,
  // errorKind:"extract" torna essa regressão de código visível em vez de
  // se disfarçar de falha de rede/parse transitória.
  try {
    const text = provider.extractText(json);
    // #4904: extractUsage é instrumentação, não o dado principal desta
    // função (a citação em `text`) — um catch PRÓPRIO, separado do catch de
    // extractText acima, garante que uma regressão em extractUsage nunca
    // derruba a medição de citação que já teve sucesso (mesmo raciocínio de
    // separar rede/parse/extract, achado #4616, aplicado a um 3º extrator
    // opcional).
    let usage: GeoProviderUsage | undefined;
    try {
      usage = provider.extractUsage?.(json);
    } catch {
      usage = undefined;
    }
    return { ok: true, text, usage };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), errorKind: "extract" };
  }
}

/**
 * Pure: converte `GeoProviderUsage` (extraído por `provider.extractUsage`)
 * nos campos de usage de `GeoCitationRecord` (#4904) — `inputTokens`/
 * `outputTokens`/`searchCount` sempre que presentes, e `estimatedCostUsd`
 * pros 3 providers, cada um com sua tabela: Anthropic via
 * `estimateCallCostUsd` (`pricing.ts`, cobre cache read/write), OpenAI e
 * Google via `estimateNonAnthropicCostUsd` (`GEO_NON_ANTHROPIC_TOKEN_PRICING`
 * acima, #4904 item 4 — tabela própria porque `pricing.ts` é Claude-only).
 * Model fora de qualquer tabela → campo fica `undefined`, nunca um preço
 * inventado.
 * `usage === undefined` (provider sem `extractUsage`, ou a resposta não
 * bateu a forma esperada) devolve `{}` — nenhum campo populado, nunca um
 * objeto com zeros inventados.
 *
 * `tsForCost` (ISO 8601) resolve o pricing intro-vs-standard da Anthropic
 * por data (`estimateCallCostUsd` → `resolvePricing`) — mesma data do
 * record (`ts`), nunca `Date.now()` no momento da LEITURA. OpenAI/Google
 * não têm pricing sensível a data nesta tabela, então `tsForCost` não afeta
 * o cálculo deles.
 */
export function buildUsageRecordFields(
  providerId: GeoProviderId,
  usage: GeoProviderUsage | undefined,
  model: string,
  tsForCost: string,
): Pick<GeoCitationRecord, "inputTokens" | "outputTokens" | "searchCount" | "estimatedCostUsd"> {
  if (!usage) return {};
  const out: Pick<GeoCitationRecord, "inputTokens" | "outputTokens" | "searchCount" | "estimatedCostUsd"> = {};
  if (usage.inputTokens !== undefined) out.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) out.outputTokens = usage.outputTokens;
  if (usage.searchCount !== undefined) out.searchCount = usage.searchCount;
  if (providerId === "anthropic") {
    const dateMs = Date.parse(tsForCost);
    const cost = estimateCallCostUsd(
      {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_creation_input_tokens: usage.cacheCreationInputTokens,
        cache_read_input_tokens: usage.cacheReadInputTokens,
      },
      model,
      Number.isFinite(dateMs) ? dateMs : null,
    );
    if (cost !== null) out.estimatedCostUsd = cost;
  } else {
    const cost = estimateNonAnthropicCostUsd(model, usage.inputTokens, usage.outputTokens);
    if (cost !== undefined) out.estimatedCostUsd = cost;
  }
  return out;
}

/** Delay do único retry (item 4 do achado #4616; generalizado além de 429
 * no #8341 — ver `isRetryableGeoError`) — curto de propósito, só o bastante
 * pra dar uma segunda chance a um erro transitório sem alongar
 * sensivelmente as ~24 chamadas seriais de uma rodada completa. */
export const GEO_RATE_LIMIT_RETRY_DELAY_MS = 1_500;

/**
 * Pure: decide se um resultado de erro de `queryProvider` merece o retry
 * único de `runGeoCitationMonitor` (#8341 — generaliza o retry que antes só
 * cobria HTTP 429, ver docstring do módulo). Retryable: `"network"`
 * (inclui timeout — o maior balde de erro medido na auditoria de
 * 18/09/2026, 56 dos 143 erros) e HTTP 5xx (erro do lado do servidor,
 * tende a ser transitório) — mesmo `errorKind` `"http"` que já cobria 429.
 * **NUNCA retryable:** `"quota"` (#8061, falha PERMANENTE — crédito/cota
 * esgotados; repetir a chamada só queima outra cobrança sem chance de
 * suceder, e só volta com ação do editor) nem `"parse"`/`"extract"`/
 * `"provider"` (não são falhas de TRANSPORTE — a resposta chegou e o
 * problema está no conteúdo/parsing dela; repetir a MESMA chamada tende a
 * repetir o MESMO resultado, sem ganho).
 */
export function isRetryableGeoError(result: Extract<QueryProviderResult, { ok: false }>): boolean {
  if (result.errorKind === "network") return true;
  if (result.errorKind === "http") {
    if (result.httpStatus === 429) return true;
    if (result.httpStatus !== undefined && result.httpStatus >= 500) return true;
  }
  return false;
}

/**
 * Roda TODAS as combinações provider×pergunta pros providers cuja API key
 * está presente em `env` (providers sem key são pulados — fail-soft, nunca
 * erro). Retorna 1 `GeoCitationRecord` por combinação executada.
 *
 * **Retry transitório (#4616 achado 4, generalizado no #8341):** um erro
 * `isRetryableGeoError` (429, HTTP 5xx, ou `"network"`/timeout) recebe
 * exatamente 1 retry, após `GEO_RATE_LIMIT_RETRY_DELAY_MS` — o suficiente
 * pra não perder uma combinação inteira por uma falha transitória de 1
 * chamada, sem virar um backoff geral (`"quota"`/`"parse"`/`"extract"`/
 * `"provider"` NUNCA são retentados; ver docstring do módulo e de
 * `isRetryableGeoError` pro rationale de escopo). `sleepFn` é injetável em
 * teste pra não esperar o delay real.
 *
 * `panel` (#4900 item a, default `"geral"`) é estampado em TODO record
 * produzido — não inferido do conteúdo da pergunta, porque `questions` já
 * determina o painel no caller (`GEO_QUESTIONS` vs `GEO_HUB_QUESTIONS`).
 * Parâmetro novo no FIM da lista de propósito, pra não quebrar chamadas
 * posicionais existentes que já passam `undefined` pra pular `now`/`providers`.
 */
export async function runGeoCitationMonitor(
  env: Record<string, string | undefined>,
  questions: readonly string[] = GEO_QUESTIONS,
  fetchImpl: FetchLike = fetch,
  now: () => Date = () => new Date(),
  providers: readonly GeoProviderDef[] = GEO_PROVIDERS,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  panel: GeoQuestionPanel = "geral",
): Promise<GeoCitationRecord[]> {
  const records: GeoCitationRecord[] = [];
  for (const provider of providers) {
    const apiKey = env[provider.envKey];
    if (!apiKey) continue; // sem key → pula esse provider, fail-soft
    const model = env[`${provider.envKey}_MODEL`] || provider.defaultModel;
    for (const question of questions) {
      let result = await queryProvider(provider, question, apiKey, model, fetchImpl, provider.timeoutMs);
      if (!result.ok && isRetryableGeoError(result)) {
        await sleepFn(GEO_RATE_LIMIT_RETRY_DELAY_MS);
        result = await queryProvider(provider, question, apiKey, model, fetchImpl, provider.timeoutMs);
      }
      const ts = now().toISOString();
      const date = ts.slice(0, 10);
      if (!result.ok) {
        records.push({
          date,
          ts,
          provider: provider.id,
          model,
          question,
          cited: false,
          domain: GEO_TARGET_DOMAIN,
          snippet: null,
          error: result.error,
          errorKind: result.errorKind,
          panel,
          ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
        });
        continue;
      }
      const detection = detectCitation(result.text);
      records.push({
        date,
        ts,
        provider: provider.id,
        model,
        question,
        cited: detection.cited,
        domain: GEO_TARGET_DOMAIN,
        snippet: detection.snippet,
        panel,
        ...buildUsageRecordFields(provider.id, result.usage, model, ts),
      });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Persistência — JSONL append-only, mesma disciplina de
// `scripts/lib/source-runs.ts::appendSourceLog` (retry-with-backoff cobre a
// race de OneDrive Files On-Demand no `data/` junction, ver `appendFileWithRetry`).
// ---------------------------------------------------------------------------

/** Path default do log — 1 arquivo único, append-only, cresce ao longo do
 * tempo (mesmo padrão de `data/run-log.jsonl`, não 1 arquivo por dia/ciclo —
 * o volume aqui é baixo: no máximo `providers × questions` linhas por rodada). */
export const DEFAULT_GEO_CITATIONS_LOG_PATH = "data/geo-citations/history.jsonl";

/**
 * Anexa os records ao log JSONL. `logPath`/`appendFn` injetáveis em teste —
 * mesmo padrão de `appendSourceLog`. Cria o diretório se não existir.
 */
export function appendGeoCitationLog(
  records: GeoCitationRecord[],
  logPath: string = DEFAULT_GEO_CITATIONS_LOG_PATH,
  ioFns: {
    mkdirSync: (path: string, opts: { recursive: true }) => void;
    appendFileSync: (path: string, data: string) => void;
  } = {
    mkdirSync: (p, o) => mkdirSync(p, o),
    appendFileSync: (p, d) => appendFileWithRetry(p, d),
  },
): void {
  if (records.length === 0) return;
  ioFns.mkdirSync(dirname(logPath), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r) + "\n").join("");
  ioFns.appendFileSync(logPath, lines);
}

export interface GeoCitationSummary {
  total: number;
  cited: number;
  errors: number;
  /** `errors` por provider (#4904, achado do silent-failure-hunter desta
   * PR): antes só existia o agregado dos 3 providers — um provider
   * permanentemente quebrado (key revogada, org errada, rate-limit
   * persistente) ficava indistinguível de "rodou certinho, nunca foi
   * citado" no log e no exit code, já que `--strict` só falha quando
   * TODOS os providers configurados erram 100% (`resolveStrictOutcome`),
   * e OpenAI/Google seguem estáveis o bastante pra nunca cruzar esse
   * limiar sozinhos. Ver `detectProviderTotalFailure` pro alarme que usa
   * este campo. */
  byProvider: Record<string, { total: number; cited: number; errors: number }>;
  /** Quebra por painel (#4900 item a) — chave `"geral"` inclui registros sem
   * `panel` (legado, lido como `"geral"` por default). */
  byPanel: Record<string, { total: number; cited: number }>;
}

/** Resume um lote de records — usado pro print de fim de execução. Pure. */
export function summarizeGeoCitationRecords(records: GeoCitationRecord[]): GeoCitationSummary {
  const byProvider: Record<string, { total: number; cited: number; errors: number }> = {};
  const byPanel: Record<string, { total: number; cited: number }> = {};
  let cited = 0;
  let errors = 0;
  for (const r of records) {
    if (!byProvider[r.provider]) byProvider[r.provider] = { total: 0, cited: 0, errors: 0 };
    byProvider[r.provider].total += 1;
    const panel = r.panel ?? "geral";
    if (!byPanel[panel]) byPanel[panel] = { total: 0, cited: 0 };
    byPanel[panel].total += 1;
    if (r.cited) {
      byProvider[r.provider].cited += 1;
      byPanel[panel].cited += 1;
      cited += 1;
    }
    if (r.error) {
      byProvider[r.provider].errors += 1;
      errors += 1;
    }
  }
  return { total: records.length, cited, errors, byProvider, byPanel };
}

/**
 * Pure: lista providers cujas TODAS as consultas desta rodada erraram
 * (#4904, achado do silent-failure-hunter — ver docstring de
 * `GeoCitationSummary.byProvider`). Diferente de `resolveStrictOutcome`
 * (que olha o agregado dos 3 providers) — isto pega o caso onde 1 provider
 * está sistemicamente quebrado mas os outros 2 continuam saudáveis o
 * bastante pra manter o exit code verde. Não decide exit code sozinho —
 * o caller decide se isso vira WARN (comportamento atual, mesmo nível de
 * `detectProviderDrop`) ou algo mais forte; a função só detecta. */
export function detectProviderTotalFailure(
  byProvider: Record<string, { total: number; cited: number; errors: number }>,
): string[] {
  return Object.entries(byProvider)
    .filter(([, s]) => s.total > 0 && s.errors === s.total)
    .map(([providerId]) => providerId);
}

// ---------------------------------------------------------------------------
// #4900 — provedor que some da rodada não alarma em silêncio (item b) +
// detecção (não-resolução) de conflito de escrita OneDrive (item c).
// ---------------------------------------------------------------------------

/**
 * Agrupa os providers que produziram >=1 registro por `date` (`YYYY-MM-DD`)
 * — reconstrói quais providers RODARAM em cada rodada sem precisar de um
 * arquivo de manifest separado: um provider sem key configurada não produz
 * NENHUM record naquela data (`runGeoCitationMonitor` pula em silêncio,
 * fail-soft), então "provider ausente do dia" já É o sinal de "rodou sem
 * essa key" — faltava uma função que lesse isso de forma automática em vez
 * de contar linha por linha (achado #4900: "24 openai + 16 google + 0
 * anthropic", contado a mão). Pure. */
export function providersByRoundDate(
  records: readonly Pick<GeoCitationRecord, "date" | "provider">[],
): Map<string, Set<GeoProviderId>> {
  const byDate = new Map<string, Set<GeoProviderId>>();
  for (const r of records) {
    if (!byDate.has(r.date)) byDate.set(r.date, new Set());
    byDate.get(r.date)!.add(r.provider);
  }
  return byDate;
}

export interface LatestRoundProviders {
  date: string;
  providers: GeoProviderId[];
}

/** Pure: a partir de um array de records (ordem qualquer), devolve a data
 * mais recente presente e o conjunto de providers que produziram registro
 * nela — a "rodada mais recente conhecida". `null` quando `records` está
 * vazio (nunca mediu nada). Datas `YYYY-MM-DD` ordenam lexicograficamente,
 * então um sort simples basta. */
export function latestRoundProviders(
  records: readonly Pick<GeoCitationRecord, "date" | "provider">[],
): LatestRoundProviders | null {
  if (records.length === 0) return null;
  const byDate = providersByRoundDate(records);
  const dates = [...byDate.keys()].sort();
  const date = dates[dates.length - 1];
  return { date, providers: [...(byDate.get(date) ?? new Set())] };
}

export interface ProviderDropCheck {
  /** `true` quando `currentProviders` é um subconjunto PRÓPRIO de
   * `previousProviders` — a rodada atual rodou com menos providers que a
   * anterior. */
  dropped: boolean;
  /** Providers presentes na rodada anterior e ausentes na atual. */
  droppedProviders: GeoProviderId[];
}

/**
 * Pure: detecta queda de provedor entre duas rodadas (#4900 item b, "o
 * sub-item mais barato e mais valioso" da issue). Não confundir com
 * staleness (`geo-citation-staleness-alarm.ts`, #4755): staleness mede
 * silêncio TOTAL (nenhum registro novo há N dias); isto mede uma rodada que
 * ACONTECEU mas encolheu — o sintoma observado ao vivo em 10/ago (rodada
 * anterior `{openai, google}`, rodada atual `{openai}` porque `GEMINI_API_KEY`
 * ficou vazia numa das duas máquinas) passava em silêncio antes deste guard.
 */
export function detectProviderDrop(
  previousProviders: readonly GeoProviderId[],
  currentProviders: readonly GeoProviderId[],
): ProviderDropCheck {
  const currentSet = new Set(currentProviders);
  const droppedProviders = previousProviders.filter((p) => !currentSet.has(p));
  return { dropped: droppedProviders.length > 0, droppedProviders };
}

/**
 * Pure: filtra nomes de arquivo que batem o padrão de conflito de escrita
 * do cliente OneDrive Linux (abraunegg, `-safeBackup-`) — sinal de que 2+
 * máquinas escreveram o mesmo log JSONL na mesma janela e o OneDrive
 * resolveu RENOMEANDO em vez de mesclar ou avisar (#4900 item c, achado ao
 * vivo, ANTERIOR ao rename da máquina #7682 — o arquivo real leva o nome
 * antigo: `history-helios-safeBackup-0001.jsonl` com 8 registros órfãos que
 * só existem nesse arquivo). Esta função só DETECTA — reconciliar os dados
 * é operação manual sobre dado real de produção, deliberadamente fora de
 * escopo de qualquer PR de código (ver docstring de `listSafeBackupConflictFiles`
 * em `scripts/geo-citation-monitor.ts` pro wrapper de I/O). */
export function detectSafeBackupConflictFiles(filenames: readonly string[]): string[] {
  return filenames.filter((f) => f.includes("-safeBackup-"));
}

// ---------------------------------------------------------------------------
// #8341 — taxa de erro sobre o denominador correto (nunca a fração crua
// sobre o total), alarme de taxa de erro por rodada, e reclassificação de
// errorKind histórico feita só na LEITURA (nunca reescrevendo history.jsonl).
// ---------------------------------------------------------------------------

/** Pure: taxa de erro em %, 1 casa decimal — `0` quando `total` é 0 (nunca
 * `NaN`/`Infinity`). Usada tanto no print de fim de rodada quanto no alarme
 * de taxa de erro abaixo. */
export function errorRatePct(total: number, errors: number): number {
  if (total <= 0) return 0;
  return Math.round((errors / total) * 1000) / 10;
}

export interface HighErrorRateProvider {
  provider: string;
  total: number;
  errors: number;
  errorRatePct: number;
}

/** Limiar default do alarme de taxa de erro por rodada (#8341, item 4 da
 * issue) — 25%: acima da taxa "saudável" de rate-limit isolado (0-15% na
 * série medida em 18/09/2026 pro Google) e abaixo da taxa que já indicava
 * problema real (40% Anthropic, 28% OpenAI, ambos causados por falha
 * sistêmica — timeout sem retry e cota esgotada, respectivamente). */
export const GEO_ERROR_RATE_ALARM_THRESHOLD_PCT = 25;

/**
 * Pure: providers cuja taxa de erro NESTA RODADA cruza `thresholdPct` (#8341,
 * item 4 da issue — "alarme quando a taxa de erro de um provider passar de
 * um limiar por rodada"). Foi a ausência disto que deixou 2 semanas de
 * crédito OpenAI zerado passarem como rate-limit saudável (#8061). Não
 * decide o que fazer com o resultado (WARN/exit code) — quem decide é o
 * caller, mesmo padrão de `detectProviderTotalFailure` acima (que cobre só
 * o caso extremo de 100%; isto cobre qualquer taxa acima do limiar).
 * `total === 0` nunca entra (sem consulta, sem taxa a medir).
 */
export function detectHighErrorRateProviders(
  byProvider: Record<string, { total: number; cited: number; errors: number }>,
  thresholdPct: number = GEO_ERROR_RATE_ALARM_THRESHOLD_PCT,
): HighErrorRateProvider[] {
  const out: HighErrorRateProvider[] = [];
  for (const [provider, s] of Object.entries(byProvider)) {
    if (s.total === 0) continue;
    const pct = errorRatePct(s.total, s.errors);
    if (pct >= thresholdPct) out.push({ provider, total: s.total, errors: s.errors, errorRatePct: pct });
  }
  return out.sort((a, b) => b.errorRatePct - a.errorRatePct);
}

/**
 * Pure: deriva o `errorKind` EFETIVO de um registro histórico, reclassificando
 * 429 pré-#8061 que ficaram gravados como `"http"` mas cujo corpo (`error`,
 * formato `"HTTP 429: <body>"` — ver `queryProvider`) já indicava cota/
 * crédito esgotado (#8341, item 1 da issue: "os 48 erros da OpenAI são todos
 * crédito zerado, não recusa... os registros históricos são anteriores ao
 * fix e ficaram como errorKind: 'http'"). **NUNCA reescreve `history.jsonl`**
 * — é série temporal de produção; a reclassificação acontece só quando um
 * leitor (ex: `summarizeHistoryByProviderReclassified` abaixo) escolhe
 * aplicá-la. Registros já escritos com `errorKind: "quota"` (pós-#8061) e
 * qualquer erro que não seja HTTP 429 passam intactos —
 * `classifyHttp429ErrorKind` já é pure/nunca lança e tolera corpo truncado
 * ou não-JSON (fallback textual), então chamá-la de novo sobre um `error`
 * já classificado como `"http"` é seguro e idempotente.
 */
export function deriveEffectiveErrorKind(
  record: Pick<GeoCitationRecord, "errorKind" | "httpStatus" | "error">,
): GeoCitationRecord["errorKind"] {
  if (record.errorKind === "http" && record.httpStatus === 429 && typeof record.error === "string") {
    // `record.error` tem o formato "HTTP 429: <body>" (ver `queryProvider`)
    // — passar a string INTEIRA pra `classifyHttp429ErrorKind` faz o
    // `JSON.parse` interno falhar sempre (o prefixo "HTTP 429: " não é JSON
    // válido), o que quebraria silenciosamente os 2 caminhos de
    // classificação por `code`/`status` (OpenAI `insufficient_quota`,
    // Google `RESOURCE_EXHAUSTED`+`PerDay`) e deixaria só o fallback
    // textual "no credits" funcionando por acidente — achado de self-review
    // desta PR, confirmado ao vivo (`JSON.parse('HTTP 429: {...}')` lança).
    // Remove o prefixo ANTES de classificar, igual ao `body` que
    // `queryProvider` já passa pra `classifyHttp429ErrorKind` no caminho de
    // escrita (nunca com o prefixo).
    const body = record.error.replace(/^HTTP \d+:\s?/, "");
    return classifyHttp429ErrorKind(body);
  }
  return record.errorKind;
}

export interface ProviderHistoryReportRow {
  provider: string;
  /** Total de consultas (válidas + erro) deste provider no recorte lido. */
  total: number;
  /** Quantas citaram `diar.ia.br` — só entre as VÁLIDAS (uma consulta com
   * erro nunca tem `cited: true`, ver `runGeoCitationMonitor`). */
  cited: number;
  /** `total - errors` — o denominador correto pra ler "quantas vezes o
   * provider foi de fato perguntado e respondeu" (#8341, item 3: "nunca a
   * fração crua sobre o total"). */
  valid: number;
  /** Erros após reclassificação (`deriveEffectiveErrorKind`). */
  errors: number;
  /** Subconjunto de `errors` que é cota/crédito esgotado (permanente). */
  quotaErrors: number;
  errorRatePct: number;
  /** `cited / valid * 100`, 1 casa — `0` quando `valid` é 0 (nenhuma
   * consulta válida, taxa indefinida tratada como 0, nunca `NaN`). */
  validCitationRatePct: number;
}

/**
 * Pure: agrega registros históricos por provider, reportando SEMPRE sobre o
 * denominador de consultas VÁLIDAS (#8341, item 3 da issue) e reclassificando
 * `errorKind` na leitura (`deriveEffectiveErrorKind`) — nunca sobre a fração
 * crua "citou/total", que mistura "nunca citou" com "nunca chegou a ser
 * perguntado de verdade" no mesmo número. Usado pelo `--history-report` do
 * CLI (`scripts/geo-citation-monitor.ts`) para ler `data/geo-citations/history.jsonl`
 * sem gastar nenhuma chamada de rede nova.
 */
export function summarizeHistoryByProviderReclassified(
  records: readonly Pick<GeoCitationRecord, "provider" | "cited" | "errorKind" | "httpStatus" | "error">[],
): ProviderHistoryReportRow[] {
  const byProvider = new Map<string, { total: number; cited: number; errors: number; quotaErrors: number }>();
  for (const r of records) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, { total: 0, cited: 0, errors: 0, quotaErrors: 0 });
    const s = byProvider.get(r.provider)!;
    s.total += 1;
    if (r.cited) s.cited += 1;
    const effectiveKind = deriveEffectiveErrorKind(r);
    if (effectiveKind !== undefined) {
      s.errors += 1;
      if (effectiveKind === "quota") s.quotaErrors += 1;
    }
  }
  const rows: ProviderHistoryReportRow[] = [];
  for (const [provider, s] of byProvider.entries()) {
    const valid = s.total - s.errors;
    rows.push({
      provider,
      total: s.total,
      cited: s.cited,
      valid,
      errors: s.errors,
      quotaErrors: s.quotaErrors,
      errorRatePct: errorRatePct(s.total, s.errors),
      validCitationRatePct: valid > 0 ? Math.round((s.cited / valid) * 1000) / 10 : 0,
    });
  }
  return rows.sort((a, b) => a.provider.localeCompare(b.provider));
}
