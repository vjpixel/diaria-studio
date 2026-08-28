/**
 * workers/arquivo/src/hubs/meta.ts (#4558 Parte A)
 *
 * Rótulo humano de cada hub temático publicado, para a navegação "Por tema"
 * da página de arquivo (`render-archive.ts`).
 *
 * **Por que é um módulo separado de `registry.ts`.** O `HUB_REGISTRY` mapeia
 * slug → HTML COMPLETO da página do hub (cada valor vem de um
 * `*.generated.ts` com dezenas de KB inlinados). `render-archive.ts` precisa
 * só de slug + rótulo pra montar um `<a href>`; importar o registry inteiro
 * arrastaria todo o HTML gerado pra dentro do módulo de render — e pra dentro
 * de `test/arquivo-render.test.ts` — sem nenhum uso. Mesma fronteira que já
 * separa `HUB_LOADERS` (builder, Node-side) de `HUB_REGISTRY` (Worker): cada
 * consumidor importa só o que consome.
 *
 * **O rótulo é escrito à mão de propósito.** Não dá pra derivar do slug sem
 * errar: `anthropic-claude` → "Anthropic e Claude" tem uma conjunção que o
 * slug não carrega. Extrair do `<title>` do HTML gerado exigiria parse em
 * runtime e reintroduziria exatamente a dependência que este módulo evita.
 *
 * **A ordem do array é a ordem de exibição** — curadoria editorial, não
 * alfabética: o tema com mais lastro no acervo vem primeiro.
 *
 * Ao publicar um hub novo, são 3 lugares (todos travados por
 * `test/hub-registry-completeness.test.ts`, que falha se algum ficar pra trás):
 * `HUB_LOADERS` (scripts/build-hub-page.ts), `HUB_REGISTRY` (./registry.ts) e
 * `HUB_META` (aqui).
 *
 * **O "4º passo" (#5257) deixou de existir em 28/08/2026 (#6411).** Ele
 * pedia adicionar à mão o link do hub novo ao bloco "Temas" da HOME pública,
 * e era AÇÃO DE PAINEL do editor no Website Builder da Beehiiv — a auditoria
 * "Raio-X de /temas/" (14/08/2026) achou que 4 dos 5 hubs então publicados
 * nunca foram rastreados pelo Google justamente por faltar esse link. Duas
 * coisas mudaram: o apex saiu da Beehiiv (hoje é `workers/site`, código
 * deste repo) e o bloco "Por tema" da home passou a ser DERIVADO deste
 * array (`renderTopicLinks` em `scripts/lib/site-home-page.ts`). Hub que
 * entra aqui ganha link na home na próxima regeneração — nada a fazer à mão.
 *
 * O eixo `hub-link-missing` de `scripts/lib/home-meta-check.ts`
 * (task `Diaria-Home-Meta-Check`, diária) continua vigiando, agora
 * como guard de regressão do gerador em vez de cobrança de passo manual:
 * `test/site-home-hub-links-6411.test.ts` roda o mesmo detector em CI, então
 * o alarme só volta a disparar se a home for ao ar sem regenerar.
 */

export interface HubMeta {
  /** Slug servido em `GET /temas/{slug}`. Igual à chave em `HUB_REGISTRY`. */
  readonly slug: string;
  /** Texto do link na navegação "Por tema" do arquivo. */
  readonly label: string;
}

export const HUB_META: readonly HubMeta[] = [
  { slug: "anthropic-claude", label: "Anthropic e Claude" },
  { slug: "openai-chatgpt", label: "OpenAI e ChatGPT" },
  { slug: "google-gemini", label: "Google e Gemini" },
  { slug: "meta-ai", label: "Meta e Meta AI" },
  { slug: "brasil-regulacao", label: "Regulação de IA no Brasil" },
  { slug: "mercado-trabalho", label: "Mercado de trabalho e IA" },
  { slug: "medicina-saude", label: "Medicina e saúde" },
];
