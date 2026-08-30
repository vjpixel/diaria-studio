#!/usr/bin/env npx tsx
/**
 * stitch-newsletter.ts (#1463)
 *
 * Une os 3 destaque drafts (`_internal/02-d{1,2,3}-draft.md` — output do
 * `writer-destaque` em paralelo) em `_internal/02-draft.md` final, injetando
 * seções secundárias (LANÇAMENTOS/PESQUISAS/OUTRAS NOTÍCIAS) do
 * `01-approved-capped.json`, o bloco É IA? do `01-eia.md`, blocos fixos
 * (ERRO INTENCIONAL + SORTEIO + PARA ENCERRAR) do template, e — dentro de
 * PARA ENCERRAR, dinâmico por edição — o grupo "Mais sobre {tema}"
 * (#5122/#5181, `scripts/lib/related-editions.ts`).
 *
 * Substitui a responsabilidade que estava na orchestrator inline.
 * Determinístico — sem LLM call.
 *
 * Uso:
 *   npx tsx scripts/stitch-newsletter.ts --edition-dir data/editions/AAMMDD/
 *
 * Exit codes:
 *   0 — stitch ok
 *   1 — input faltando (algum destaque draft, approved-capped JSON)
 *   2 — uso inválido (args)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomicIfChanged } from "./lib/atomic-write.ts";
import { cleanSummary } from "./lib/clean-summary.ts";
import { looksEnglish } from "./lib/lang-detect.ts"; // #1790 (era inline divergente)
import {
  estimateUseMelhorTempo,
  normalizeDashToParens,
} from "./lib/use-melhor-curation.ts"; // #2447/#2450
import { USE_MELHOR_TEMPO_RE } from "./lib/lint-checks/use-melhor-tempo.ts"; // #2464 finding 5 — evitar cópia de regex
import {
  renderEncerramentoSocialApoio,
  ENCERRAMENTO_OPENING_DAILY,
  SOCIAL_INVITE,
  CURADORIA_PILLS,
} from "./lib/shared/encerramento-snippet.ts"; // #3219 fonte única (apoio Apoia.se + ferramentas), compartilhada com o mensal; renderEncerramentoSocialApoio #3382 fix (fallback de conteúdo real quando o slot A não tem override); SOCIAL_INVITE/CURADORIA_PILLS #4413/#4411 (blocos fixos, não mais lidos de config/snippet por edição)
import { readSnippetFile } from "./lib/shared/snippet-loader.ts"; // #3219 leitura crua compartilhada com loadEncerramentoSocialApoioTemplate
import { extractBoxDivulgacao0, extractBoxDivulgacao1, BOX0_SENTINEL } from "./lib/newsletter-parse.ts"; // #3232 idempotência marcador-agnóstica (ver boxAlreadyPresentInGap); extractBoxDivulgacao0 #4274; BOX0_SENTINEL #4338; extractBoxDivulgacao3 removido do stitch pelo #6748 (slot 3 eliminado) — a função continua existindo em newsletter-parse.ts pros lints que ainda leem edições antigas
import {
  resolveUsedSnippets,
  isAgradecimentoSnippetUsed,
  buildSnippetBodyHashManifest,
  writeSnippetBodyHashManifest,
} from "./lib/lint-checks/snippet-staleness.ts"; // #4150: grava hash do corpo pós-cabeçalho dos snippets usados, pro guard de staleness distinguir edição de metadado de edição de conteúdo
import { resolveBoxesForEdition } from "./select-boxes-by-clicks.ts"; // #4626: seleção automática de boxes 1/2/3 por cliques+tendência+anti-repetição — só afeta main() (CLI), stitchNewsletter() em si permanece pura/sem I/O de auto-seleção
import { matchEditionHub, extractBoldLinkTitles } from "./lib/hub-match.ts"; // #4907: link contextual pro hub temático quando as manchetes do dia casam HUB_KEYWORD_PATTERNS
import { selectRelatedEditions, renderRelatedEditionsMarkdown, loadRecentRelatedEditionUrls } from "./lib/related-editions.ts"; // #5122/#5181: aresta edição->edição no fim do corpo — independente do #4907 acima (não exige match único edição-wide), exclusão mútua aplicada abaixo
import { resolveHubDivulgacaoBoxSource, renderGeneratedSnippet } from "./build-hub-divulgacao-box.ts"; // #5263: regen do box rotativo de hubs — wiring que faltava, ver regenerateHubDivulgacaoBoxForEdition() abaixo
import { buildHubDivulgacaoBoxMarkdown } from "./lib/shared/hub-divulgacao-box.ts"; // #5263

interface ArticleLike {
  url?: string;
  title?: string;
  summary?: string;
  summary_lang?: string;
}

// #1790: looksEnglish unificado no lib canônico (./lib/lang-detect.ts, importado
// no topo) — usado abaixo só pra marcar [TRADUZIR] na DESCRIÇÃO de itens EN
// (o título sai sempre verbatim, #1634).

interface ApprovedJsonShape {
  coverage?: { line?: string };
  highlights?: Array<{ article: ArticleLike }>;
  lancamento?: ArticleLike[];
  // #1629: buckets renomeados
  radar?: ArticleLike[];
  use_melhor?: ArticleLike[];
  video?: ArticleLike[];
}

const FIXED_BLOCKS = {
  sorteio: `**🎁 SORTEIO**

Você presta atenção ao conteúdo gerado por IA que consome? Para ajudar nesse exercício, há pelo menos um pequeno erro em cada edição.

**Responda indicando qual é o erro, ou se não há nenhum, e receba um número para concorrer a uma caneca da diar.ia.br, a ser sorteada mês que vem.** Sua resposta deve chegar até mim antes do envio da edição seguinte.`,

  // #3219: cabeçalho da seção — fixo, sem parametrização, sempre o primeiro
  // elemento do bloco PARA ENCERRAR (#3368: o parágrafo de apoio entra
  // DEPOIS do cabeçalho, não antes — só a ordem dos parágrafos internos
  // mudou, o cabeçalho continua abrindo a seção).
  para_encerrar_header: `**🙋🏼‍♀️ PARA ENCERRAR**`,

  // #3219: parágrafo de ferramentas — FALLBACK apenas (achado ao vivo,
  // ciclo 2607-08: o parágrafo de créditos passou a viver como o 2º
  // parágrafo de data/snippets/encerramento-social-apoio.md, mesma fonte
  // única usada pelo mensal — ver computeParaEncerrarDefaults abaixo, que
  // extrai esse parágrafo do split quando o arquivo tem os 3 parágrafos).
  // Esta constante só é usada quando o split falha (arquivo ausente/vazio,
  // ou com forma inesperada — casos 2/3 de computeParaEncerrarDefaults), sem
  // conteúdo real de onde extrair o parágrafo de ferramentas. #4357: a lista
  // de pills "Acesse nossas curadorias" que ANTES terminava este bloco foi
  // extraída pra `para_encerrar_curadorias` (abaixo) — ela é navegação
  // estrutural PERMANENTE, não copy editorial do slot A, e morar aqui a
  // deixava vulnerável a sumir por inteiro sempre que o editor sobrescrevia
  // `para_encerrar.slot_a` pelo painel Caixas (override é all-or-nothing por
  // slot — ver `buildParaEncerrar`).
  para_encerrar_tools: `Nesta edição da **diar.ia.br**, usei Claude Code para automatizar parte da pesquisa e criar resumos, Gemini para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz ([ganhe um mês do plano Pro](https://wisprflow.ai/r?ANGELO492=)). A revisão foi feita pelo MCP da Clarice ([ganhe descontos com os cupons NEWS25 e NEWS50](https://clarice.ai/precos-planos?via=diaria)), dei o toque final e enviei via Beehiiv ([ganhe um mês grátis e 20% de desconto por 3 meses](https://www.beehiiv.com?via=Diaria)).`,

  // #4357: lista de pills "Acesse nossas curadorias" — navegação estrutural
  // PERMANENTE (não copy editorial), concatenada por `buildParaEncerrar`
  // DEPOIS do slot A e ANTES do convite social, fora do alcance de qualquer
  // override de slot. Sobrevive incondicionalmente a qualquer edição do
  // parágrafo de apoio/ferramentas pelo painel Caixas. #4356: 3º pill
  // "Equipamentos" (vitrine própria do editor na Amazon, link direto —
  // decisão do editor, sem camada de redirect via Worker) somado às 2
  // curadorias originais. #4411: labels curtos (Cursos/Livros, não mais
  // "Cursos de IA"/"Livros sobre IA") + constante compartilhada
  // `CURADORIA_PILLS` (mesmo texto usado pelo mensal — single source, #4411).
  para_encerrar_curadorias: CURADORIA_PILLS,

  erro_intencional_placeholder: `**ERRO INTENCIONAL**

{placeholder, script render-erro-intencional.ts substitui pós-Clarice}

Esta edição tem um erro proposital. Responda este e-mail com a correção para concorrer ao sorteio mensal.`,
};

/**
 * #4274 (reescopo #4413, 260801): shape da config `para_encerrar` de
 * `platform.config.json` — o único bloco de conteúdo ainda editável pelo
 * painel Caixas como texto direto (sem pool de snippets, diferente dos
 * slots 0-3 de `boxes_divulgacao`, que são opcionais e sorteiam entre
 * candidatos).
 *
 *   - `slotA`: parágrafo de apoio (Apoia.se) + bloco de ferramentas — um
 *     único bloco de texto. #4357: NÃO inclui a lista de pills "Acesse
 *     nossas curadorias" — essa lista é navegação estrutural permanente
 *     (`FIXED_BLOCKS.para_encerrar_curadorias`), concatenada por
 *     `buildParaEncerrar` DEPOIS do slot A (antes, sobrescrever slotA
 *     apagava as pills junto — override é all-or-nothing por slot).
 *
 * #4413 (decisão do editor, 260801): o antigo `slotB` (convite social) SAIU
 * deste tipo — o convite social virou bloco FIXO (`SOCIAL_INVITE`, ver
 * `lib/shared/encerramento-snippet.ts`), nunca mais editável por edição. Um
 * eventual `para_encerrar.slot_b` ainda presente em `platform.config.json`
 * (config legado, ou escrito pelo painel Caixas do Studio antes deste PR
 * remover o campo da UI) é simplesmente IGNORADO por `loadParaEncerrarConfig`
 * — nunca lido, nunca propagado ao output.
 *
 * `null` = sem override, cai no default (`computeParaEncerrarSlotADefault`) —
 * mesmo contrato de `BoxesDivulgacaoConfig` (ausência/vazio nunca quebra,
 * comportamento idêntico ao pré-#4274).
 */
export interface ParaEncerrarConfig {
  slotA: string | null;
}

/**
 * #4274/#4413: lê `platform.config.json.para_encerrar.slot_a`. Chave
 * ausente, config corrompido, ou valor vazio/não-string -> `null` (fallback
 * pro default em `buildParaEncerrar`, ver `computeParaEncerrarSlotADefault`).
 * Nunca lança. `slot_b` (se presente no arquivo) é ignorado — #4413.
 */
export function loadParaEncerrarConfig(): ParaEncerrarConfig {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const p = join(root, "platform.config.json");
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (raw.para_encerrar && typeof raw.para_encerrar === "object") {
      const rawA = raw.para_encerrar.slot_a;
      const slotA = typeof rawA === "string" && rawA.trim() ? rawA.trim() : null;
      return { slotA };
    }
  } catch {
    // graceful — config ausente/corrompido cai no default abaixo
  }
  return { slotA: null };
}

/**
 * #4413 (simplificado — antes do #4413 esta função precisava separar
 * apoio/ferramentas/convite social do mesmo arquivo via
 * `splitEncerramentoSocialApoio`, porque o convite social também vinha dele;
 * agora que o convite social é `SOCIAL_INVITE`, um bloco fixo à parte, o
 * arquivo inteiro — qualquer que seja sua forma, 1 parágrafo ou mais — é
 * usado verbatim como slot A): valor DEFAULT do slot A quando
 * `platform.config.json` não tem override (config ausente, campo vazio, ou
 * edição anterior ao #4274). Cai no fallback hardcoded
 * `FIXED_BLOCKS.para_encerrar_tools` só quando o próprio arquivo de snippet
 * está ausente/vazio (nunca houve conteúdo real pra perder). `rootDir`
 * (opcional) — override de teste, ver `loadDivulgacaoSnippet`.
 */
function computeParaEncerrarSlotADefault(rootDir?: string): string {
  return renderEncerramentoSocialApoio(ENCERRAMENTO_OPENING_DAILY, rootDir) ?? FIXED_BLOCKS.para_encerrar_tools;
}

/**
 * #3219/#3368/#4274/#4357/#4413/#5122: monta o bloco PARA ENCERRAR completo —
 * cabeçalho (fixo, `FIXED_BLOCKS.para_encerrar_header`) + slot A (apoio +
 * ferramentas, editável) + pills de curadoria (fixo, `CURADORIA_PILLS`) +
 * grupo "Mais sobre {tema}" (dinâmico por edição, #5122/#5181 — OMITIDO
 * quando `relatedEditionsMarkdown` é `null`/ausente) + convite social (fixo,
 * `SOCIAL_INVITE`), nessa ordem (invariante do #3219/#3368 preservada — o
 * convite social é sempre o ÚLTIMO parágrafo). #4413: o convite social NÃO É
 * MAIS um slot editável — é sempre `SOCIAL_INVITE`, verbatim, independente
 * de qualquer config (decisão do editor: o texto precisa ser invariante, e o
 * override por edição era justamente o mecanismo que produzia divergência
 * entre diário e mensal).
 *
 * `override` — pula a leitura de `platform.config.json` e usa esta config
 * diretamente pro slot A (mesmo contrato de `input.boxesDivulgacao` em
 * `StitchInput`). Produção nunca passa este parâmetro (sempre lê do disco
 * via `loadParaEncerrarConfig`).
 *
 * `relatedEditionsMarkdown` (#5122) — parâmetro SEPARADO de `override`
 * (não faz parte de `ParaEncerrarConfig`) porque não vem de
 * `platform.config.json`/editor: é computado por edição a partir das
 * manchetes de hoje (`selectRelatedEditions`/`renderRelatedEditionsMarkdown`
 * em `scripts/lib/related-editions.ts`). `undefined`/`null` (default) — sem
 * grupo, comportamento idêntico a antes do #5122.
 *
 * `rootDir` (opcional, #5227) — override de teste repassado pro fallback de
 * default do slot A (`computeParaEncerrarSlotADefault`, lê
 * `data/snippets/encerramento-social-apoio.md`); produção nunca passa.
 */
export function buildParaEncerrar(
  override?: ParaEncerrarConfig,
  relatedEditionsMarkdown?: string | null,
  rootDir?: string,
): string {
  const cfg = override ?? loadParaEncerrarConfig();
  const slotA = cfg.slotA ?? computeParaEncerrarSlotADefault(rootDir);
  const relatedBlock = relatedEditionsMarkdown ? `\n\n${relatedEditionsMarkdown}` : "";
  return `${FIXED_BLOCKS.para_encerrar_header}\n\n${slotA}\n\n${FIXED_BLOCKS.para_encerrar_curadorias}${relatedBlock}\n\n${SOCIAL_INVITE}`;
}

/**
 * #2978: carrega um bloco de divulgação de `data/snippets/{file}` (migrado
 * de `context/snippets/` em #5227), format-agnóstico — aceita o formato
 * bold-line (`**📚/📣/🎉 …**`), o formato carrinho (`🛒 …`, multi-parágrafo
 * com CTA, sem bold-wrap), OU (#3306, caso real: `recomendacao-leitura.md`/
 * #3212) qualquer outro conteúdo multi-parágrafo sem bold-wrap total —
 * devolvido cru, deixando `renderBoxDivulgacao` (marcador-agnóstico desde
 * #3204) decidir o formato de render pela ESTRUTURA, não pelo marcador.
 * Antes desse 3º fallback, um snippet como `📖 Recomendação de leitura\n\n
 * [**Livro**](url), de Autor.\n\nComentário.` retornava `null` (não batia
 * bold-line nem carrinho) e a edição saía sem o box — mesmo com
 * `platform.config.json` apontando pra ele.
 *
 * Strip do comentário HTML de header; retorna o bloco trimado.
 *
 * **`file` ausente/vazio (slot não configurado) → `null`, graceful** — sem
 * box nesse slot é um estado editorial legítimo (#4274: 5 slots preenchidos
 * seria demais numa edição de 5 minutos).
 *
 * **`file` presente mas o snippet NÃO existe em disco → LANÇA (#5227)**,
 * nunca `null`. Antes da migração pra `data/snippets/` (gitignored), esse
 * caso era pego em CI por `test/stitch-newsletter.test.ts` ("os slots
 * configurados apontam pra snippets que existem", lendo `context/snippets/`
 * git-tracked) — sem essa rede de segurança em CI (o conteúdo real não está
 * mais no git), uma edição com `boxes_divulgacao.slotN` apontando pra um
 * arquivo que ainda não sincronizou via OneDrive (ou foi arquivado sem
 * atualizar o slot) SAÍA SEM O BOX, EM SILÊNCIO — a mesma classe de bug que
 * o #2978 original documenta acima (linha "retornava null... e a edição
 * saía sem o box"), só que agora por arquivo ausente em vez de formato não
 * reconhecido. O invariante migrou de CI-time pra runtime: falha alto,
 * aborta o Stage 2 (`main()` abaixo já converte qualquer exceção em
 * `process.exit(1)` com a mensagem), em vez de publicar uma edição faltando
 * um box que o editor pensava estar configurado.
 *
 * Leitura crua (resolve root + readFileSync + strip comentário HTML + trim)
 * delegada a `readSnippetFile` (#3219 — extraído pra parar de duplicar essa
 * lógica em paralelo com `loadEncerramentoSocialApoioTemplate`); esta função
 * mantém só o pós-processamento específico de formato (marker bold-line vs
 * carrinho vs genérico) por cima da leitura compartilhada + o guard de erro
 * duro acima.
 *
 * `rootDir` (opcional) — override de teste repassado pra `readSnippetFile`
 * (#5227); produção nunca passa (sempre resolve a raiz real do repo).
 */
export function loadDivulgacaoSnippet(file: string | null | undefined, rootDir?: string): string | null {
  if (!file) return null;
  const raw = readSnippetFile(file, rootDir);
  if (!raw) {
    throw new Error(
      `loadDivulgacaoSnippet: slot configurado aponta para "data/snippets/${file}", mas o arquivo não existe (ou ficou vazio após remover o header) — verifique se a caixa foi arquivada sem atualizar o slot em platform.config.json, ou se o OneDrive ainda não sincronizou este arquivo nesta máquina.`,
    );
  }
  // Formato carrinho (🛒): texto cru, sem bold-wrap — igual ao que
  // BOX_DIVULGACAO_CART_RE (newsletter-parse.ts) espera no reviewed.md.
  if (raw.startsWith("🛒")) return raw;
  // Formato bold-line: bloco `**📚/📣/🎉 …**` (mesmo que extractBoxDivulgacao1/2 casa).
  const m = raw.match(/\*\*\s*(?:📚|📣|🎉)[\s\S]+?\*\*/);
  if (m) return m[0].trim();
  // #3306: fallback genérico — nenhum marcador legado bateu, mas o conteúdo
  // ainda é um box válido (ex: 📖 recomendação de leitura, multi-parágrafo,
  // 1 link). `renderBoxDivulgacao`/`shouldForceCtaPill` já processam
  // qualquer estrutura; devolver cru em vez de `null`.
  return raw;
}

/**
 * Caixa de AGRADECIMENTO a novos apoiadores (Apoia.se), da região de intro —
 * entra imediatamente APÓS a coverage line (que termina na frase-CTA "considere
 * apoiar o projeto") e ANTES do `---` que abre o DESTAQUE 1. O parser aceita
 * parágrafos extras nessa região desde #3477.
 *
 * Fonte: `data/snippets/agradecimento-apoiadores.md`. O nome de cada apoiador
 * é preenchido no lugar do placeholder `{apoiadores}` a cada edição.
 *
 * Graceful/no-op — retorna `null` (bloco OMITIDO, sem frase sem nome) quando:
 *   - o snippet não existe / ficou vazio após strip do comentário;
 *   - o placeholder `{apoiadores}` ainda não foi substituído (edição sem
 *     apoiador novo, que é o caso comum).
 */
export function loadAgradecimentoSnippet(
  file: string | null | undefined = "agradecimento-apoiadores.md",
  rootDir?: string,
): string | null {
  if (!file) return null;
  const raw = readSnippetFile(file, rootDir);
  if (!raw) return null;
  if (raw.includes("{apoiadores}")) return null;
  return raw;
}

/**
 * #2527: carrega o box de divulgação DIÁRIO default (slot 1, D1/D2) — bloco de
 * curadoria de LIVROS (`**📚 …**`) de `data/snippets/livros-divulgacao.md`.
 * Substituiu o bloco 📣 Clarice como padrão (decisão editorial). #5227: o
 * arquivo é passado explicitamente (não um slot opcional) — snippet ausente
 * agora LANÇA (ver docstring de `loadDivulgacaoSnippet`), não retorna null.
 * `rootDir` (opcional) — override de teste, ver `loadDivulgacaoSnippet`.
 */
export function loadDailyCallout(rootDir?: string): string | null {
  return loadDivulgacaoSnippet("livros-divulgacao.md", rootDir);
}

/**
 * #1938: bloco canônico de divulgação CLARICE (`**📣 …**`) — mantido para reuso
 * (mensal, ou troca pontual do callout diário). Não é mais o default diário (#2527).
 * `rootDir` (opcional) — override de teste, ver `loadDivulgacaoSnippet`.
 */
export function loadClariceCallout(rootDir?: string): string | null {
  return loadDivulgacaoSnippet("clarice-divulgacao.md", rootDir);
}

/**
 * #2978: shape da config `boxes_divulgacao` de `platform.config.json` — nome
 * do snippet (`data/snippets/{file}`) por slot, ou `null` pra slot vazio.
 */
export interface BoxesDivulgacaoConfig {
  slot1: string | null;
  slot2: string | null;
  /** #3476: 3º box — posicionado SEMPRE após o ÚLTIMO destaque (D3 se
   * existir, senão D2), antes de USE MELHOR/É IA?. Existe em QUALQUER
   * contagem de destaques (diferente do slot2, que só existe com D3).
   * Opcional (não `null`-obrigatório) por back-compat: overrides de teste
   * escritos antes do #3476 que só passam slot1/slot2 continuam válidos —
   * ausência é tratada como `null` (sem slot3) nos call-sites. */
  slot3?: string | null;
  /** #4274: box 0 — posicionado na região de introdução, entre a linha/bloco
   * de cobertura e `**DESTAQUE 1`. Opcional por back-compat (mesma razão do
   * slot3); ausência tratada como `null` (sem slot0) nos call-sites. Default
   * editorial é `null` (5 slots preenchidos seria demais numa edição de
   * leitura de 5 minutos, #4274) — diferente do slot1, que tem fallback
   * legado não-null. */
  slot0?: string | null;
}

/**
 * #2978: lê `platform.config.json.boxes_divulgacao` — mapeia cada slot (1 =
 * gap D1/D2, 2 = gap D2/D3) pro nome do snippet a injetar. Back-compat: se a
 * chave `boxes_divulgacao` estiver AUSENTE do config inteiro, cai no
 * comportamento legado pré-#2978 (livros no slot 1, nada no slot 2) — edições
 * que nunca tocaram nesse config continuam funcionando sem mudança. Se a
 * chave existe mas um slot individual está ausente, esse slot é `null` (sem
 * cascata pro default legado — a presença da chave é um opt-in explícito pra
 * configuração granular).
 */
export function loadBoxesDivulgacaoConfig(): BoxesDivulgacaoConfig {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const p = join(root, "platform.config.json");
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (raw.boxes_divulgacao && typeof raw.boxes_divulgacao === "object") {
      return {
        slot1: raw.boxes_divulgacao.slot1 ?? null,
        slot2: raw.boxes_divulgacao.slot2 ?? null,
        slot3: raw.boxes_divulgacao.slot3 ?? null,
        slot0: raw.boxes_divulgacao.slot0 ?? null,
      };
    }
  } catch {
    // graceful — config ausente/corrompido cai no default legado abaixo
  }
  return { slot1: "livros-divulgacao.md", slot2: null, slot3: null, slot0: null };
}

/**
 * Renderiza uma section secundária (USE MELHOR/LANÇAMENTOS/RADAR/VÍDEOS)
 * com emoji prefix + items em formato canonical `[**title**](url)` + summary.
 *
 * Singular vs plural conforme `count` (#1324).
 *
 * #1855: USE MELHOR deixou de ser PT-only (revert do #1632). Tutoriais EN agora
 * aparecem como em qualquer outra seção secundária — título verbatim + [TRADUZIR]
 * na descrição EN. A grande maioria de cookbooks de qualidade é em inglês;
 * descartá-los esvaziava a seção recorrentemente (#1851).
 */
export function renderSection(
  emoji: string,
  nameSingular: string,
  namePlural: string,
  items: ArticleLike[],
): string {
  if (items.length === 0) return "";
  const header = items.length === 1
    ? `**${emoji} ${nameSingular}**`
    : `**${emoji} ${namePlural}**`;
  const lines: string[] = [header, ""];
  for (const a of items) {
    if (!a.url || !a.title) continue;
    // #1697/#1634: o TÍTULO de item de seção secundária sai SEMPRE no idioma
    // original — nunca prefixar [TRADUZIR] no título. O prefixo no título induzia
    // o orchestrator a traduzir o título no pre-gate, violando #1634 (preservar o
    // nome original do recurso). O título do recurso fica verbatim.
    lines.push(`**[${a.title}](${a.url})**  `);
    if (a.summary) {
      // #1697: a DESCRIÇÃO pode ser PT (#1634). Se o summary está em EN, marcar
      // [TRADUZIR] só na descrição — o writer/editor traduz a descrição e remove
      // o prefixo, mantendo o título original. Detecção pelo summary (não pelo
      // título): um recurso de título EN com descrição PT não deve ser marcado.
      // #1790: minWords:4 preserva o bar baixo da impl antiga do stitch — sem
      // isso, summary EN curto (4-9 palavras) deixava de ganhar [TRADUZIR].
      const summaryIsEn = a.summary_lang === "en" || looksEnglish(a.summary, { minWords: 4 });
      const descPrefix = summaryIsEn ? "[TRADUZIR] " : "";
      lines.push(descPrefix + cleanSummary(a.summary, a.title));
    }
    lines.push("");
  }
  // Remove trailing blank
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * #2447/#2450: Renderiza a seção USE MELHOR com injeção automática de estimativa
 * de tempo `(X min)` quando a descrição ainda não tem tempo.
 *
 * Diferenças em relação a `renderSection` genérico:
 *   1. Detecta se a descrição já contém tempo → não injeta duplicata.
 *   2. Se não tem tempo → appenda `estimateUseMelhorTempo(title, url)` ao fim.
 *   3. Normaliza `— X min` → `(X min)` (formato canônico, #2450).
 *
 * O editor pode ajustar a estimativa no gate Stage 2 → Stage 4. O lint
 * `use-melhor-tempo` (Stage 4, error) garante que nenhum item chegue sem tempo.
 *
 * Finding 3 (#2464): retorna "" quando TODOS os items são inválidos (sem url/title).
 * Sem esse guard, o header "🛠️ USE MELHOR" seria emitido órfão sem itens.
 */
export function renderUseMelhorSection(items: ArticleLike[]): string {
  if (items.length === 0) return "";
  const header = `**🛠️ USE MELHOR**`;
  const lines: string[] = [header, ""];
  let validCount = 0;
  for (const a of items) {
    if (!a.url || !a.title) continue;
    validCount++;
    lines.push(`**[${a.title}](${a.url})**  `);
    if (a.summary) {
      const summaryIsEn = a.summary_lang === "en" || looksEnglish(a.summary, { minWords: 4 });
      const descPrefix = summaryIsEn ? "[TRADUZIR] " : "";
      // #2464 finding 4: cleanSummary pode retornar "" — evitar espaço à esquerda.
      const cleanedSummary = cleanSummary(a.summary, a.title);
      let desc = cleanedSummary ? descPrefix + cleanedSummary : "";

      // #2450: normalizar `— X min` → `(X min)` primeiro (atalho editorial)
      desc = normalizeDashToParens(desc);

      // #2447: injetar estimativa auto se não tiver nenhuma.
      // USE_MELHOR_TEMPO_RE importado do lint (finding 5 #2464 — sem cópia duplicada).
      if (!USE_MELHOR_TEMPO_RE.test(desc)) {
        const estimate = estimateUseMelhorTempo(a.title, a.url);
        desc = desc ? `${desc.trimEnd()} ${estimate}` : estimate;
      }

      lines.push(desc);
    } else {
      // Sem summary: injetar placeholder de tempo mínimo para o lint não bloquear.
      // O editor vai preencher a descrição + ajustar o tempo no gate.
      const estimate = estimateUseMelhorTempo(a.title, a.url);
      lines.push(`[DESCRIÇÃO PENDENTE] ${estimate}`);
    }
    lines.push("");
  }
  // Finding 3 (#2464): se todos os items eram inválidos (sem url/title), retornar
  // string vazia em vez de emitir o header órfão "**🛠️ USE MELHOR**".
  if (validCount === 0) return "";
  // Remove trailing blank
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * Lê o bloco É IA? do `01-eia.md`. Se ausente, retorna placeholder simples.
 * Format do 01-eia.md:
 *   "É IA?\n\n{description}\n\n> Gabarito: **{A|B} é a IA**"
 */
function readEiaBlock(editionDir: string): string {
  const path = join(editionDir, "01-eia.md");
  if (!existsSync(path)) {
    return "É IA?\n\n[É IA? ainda processando — bloco será inserido na Etapa 3]";
  }
  let content = readFileSync(path, "utf8");
  // Strip YAML frontmatter (writer single faz o mesmo — eia_answer fica
  // sidecar, NÃO entra no MD final). Sem isso, 02-draft.md sai com
  // `eia_answer:` raw entre D2 e D3. Review fix #1463.
  const fmMatch = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/);
  if (fmMatch) {
    content = content.slice(fmMatch[0].length);
  }
  return content.trim();
}

interface StitchInput {
  d1Path: string;
  d2Path: string;
  /** #2343: D3 é opcional. Ausente quando destaque_count == 2 (2-destaque edition). */
  d3Path?: string | null;
  approvedCappedPath: string;
  editionDir: string;
  /** #1938/#2978: injeta os boxes de divulgação configurados (`boxes_divulgacao`
   * de `platform.config.json`) nos slots 1 (D1/D2) e 2 (D2/D3). Default `true`
   * (todo daily — decisão editorial). Kill-switch: `false` / `--no-sponsor` —
   * suprime a injeção em AMBOS os slots. */
  sponsor?: boolean;
  /** Override de teste: pula a leitura de `platform.config.json` e usa esta
   * config diretamente. Produção nunca passa este campo (sempre lê do disco). */
  boxesDivulgacao?: BoxesDivulgacaoConfig;
  /** #4274/#4413: override de teste pro conteúdo do slot A do PARA ENCERRAR —
   * mesmo contrato de `boxesDivulgacao` acima. Produção nunca passa este
   * campo (sempre lê `platform.config.json.para_encerrar` via
   * `loadParaEncerrarConfig`). */
  paraEncerrar?: ParaEncerrarConfig;
  /** Override de teste (#5227): raiz alternativa pra resolução de
   * `data/snippets/{file}` (repassada a `loadDivulgacaoSnippet`/
   * `loadAgradecimentoSnippet`/`buildParaEncerrar` internamente) — permite um
   * teste apontar pra um diretório de fixture temporário (`{root}/data/
   * snippets/`) em vez da raiz real do repo, sem tocar `data/snippets/` de
   * verdade (junction OneDrive, `.gitignore` blanket — nunca escrever nela
   * a partir de um teste). Produção nunca passa este campo. */
  snippetsRootDir?: string;
}

export function stitchNewsletter(input: StitchInput): string {
  // #2343: D3 is optional for 2-destaque editions. Required paths = d1, d2, approvedCapped.
  const requiredReads = [input.d1Path, input.d2Path, input.approvedCappedPath];
  for (const p of requiredReads) {
    if (!existsSync(p)) {
      throw new Error(`stitch: input ausente: ${p}`);
    }
  }
  const d1 = readFileSync(input.d1Path, "utf8").trim();
  const d2 = readFileSync(input.d2Path, "utf8").trim();
  // #2343: D3 is present only for 3-destaque editions.
  const d3: string | null = (input.d3Path != null && existsSync(input.d3Path))
    ? readFileSync(input.d3Path, "utf8").trim()
    : null;
  // If d3Path is provided but missing, crash loudly (caller passed wrong path).
  if (input.d3Path != null && d3 === null) {
    throw new Error(`stitch: input ausente: ${input.d3Path}`);
  }
  // #2355 fix 1: required draft files must not be empty/whitespace-only —
  // an empty destaque block produces a bare `---` in the output (silently corrupt edition).
  // D1 and D2 are always required; D3 only when d3Path is provided.
  if (!d1) throw new Error(`stitch: 02-d1-draft.md vazio: ${input.d1Path}`);
  if (!d2) throw new Error(`stitch: 02-d2-draft.md vazio: ${input.d2Path}`);
  if (input.d3Path != null && d3 === "") {
    throw new Error(`stitch: 02-d3-draft.md vazio (esperado para edição de 3 destaques): ${input.d3Path}`);
  }
  // #2355 fix 2: wrap parse to give a diagnostic when the capped JSON is corrupt.
  let approved: ApprovedJsonShape;
  try {
    approved = JSON.parse(readFileSync(input.approvedCappedPath, "utf8")) as ApprovedJsonShape;
  } catch (parseErr) {
    throw new Error(`stitch: approved-capped.json corrompido (parse falhou): ${input.approvedCappedPath} — ${(parseErr as Error).message}`);
  }

  const coverageLine = approved.coverage?.line ??
    "Para esta edição, eu (o editor) enviei N submissões e a diar.ia.br encontrou outros M artigos. Selecionamos os Z mais relevantes para as pessoas que assinam a newsletter.";

  const eiaBlock = readEiaBlock(input.editionDir);

  // #1752: USE MELHOR (bucket use_melhor) era tipado mas NUNCA renderizado —
  // a seção sumia da newsletter mesmo com conteúdo selecionado pelo scorer.
  // Ordem: USE MELHOR vem ANTES de LANÇAMENTOS (decisão editorial 260603).
  // #1855: tutoriais EN agora aparecem (revert do PT-only #1632) — mesma regra
  // [TRADUZIR]-na-descrição das demais seções. O mínimo de 2 itens é garantido
  // upstream pelo promoteUseMelhorToMinimum em apply-stage2-caps.
  // #2447/#2450: USE MELHOR recebe tratamento especial — injetar estimativa de
  // tempo auto-gerada `(X min)` quando a descrição ainda não tem tempo, e
  // normalizar `— X min` → `(X min)` para garantir formato canônico de parênteses.
  const useMelhor = renderUseMelhorSection(approved.use_melhor ?? []);
  const lancamentos = renderSection("🚀", "LANÇAMENTO", "LANÇAMENTOS", approved.lancamento ?? []);
  // #1569 / #1629: RADAR é bucket único (Pesquisas + Outras Notícias fundidos
  // no categorize.ts). Editor pode re-ordenar no gate Stage 2.
  const radar = renderSection("📡", "RADAR", "RADAR", approved.radar ?? []);
  const videos = renderSection("📺", "VÍDEO", "VÍDEOS", approved.video ?? []);

  // #1938/#2527/#2978: boxes de divulgação nos slots 1 (D1/D2) e 2 (D2/D3),
  // isolados entre dois `---` (posição que extractBoxDivulgacao1/2 procura;
  // #1972 garante de-dup no render). Config-driven via `boxes_divulgacao` de
  // `platform.config.json` — default legado = livros (📚) no slot 1, nada no
  // slot 2 (#2527: livros substituiu o 📣 Clarice como padrão do slot 1).
  // Idempotente: pula um slot se a região correspondente já traz um box
  // (editor já colou à mão, ou re-run). Kill-switch: sponsor=false suprime
  // AMBOS os slots. Graceful: snippet ausente/config sem slot → sem box
  // nesse slot.
  const wantSponsor = input.sponsor !== false;
  const boxesCfg = input.boxesDivulgacao ?? loadBoxesDivulgacaoConfig();
  // #3232: `boxAlreadyPresentInGap` substitui o antigo `calloutRe` (allowlist
  // de marcadores 📣/📚/🎉 bold-line) por detecção marcador-agnóstica — mesma
  // técnica de #3204 (`locateBoxInGap`, por POSIÇÃO+ESTRUTURA). `a`/`b` são os
  // drafts brutos dos 2 destaques que cercam o slot (ex: d1/d2 pro slot 1); um
  // box já injetado aparece GLUADO ao final de `a` (sem `---`, caso real
  // 260609) OU PREPENDED ao início de `b` (antes do próprio header
  // `**DESTAQUE N |`). Sondamos essa mesma forma unindo os 2 textos com um
  // `---` artificial e reusando `extractBoxDivulgacao1` (gapIndex 0 nesse
  // probe de 2 marcadores) — cobre tanto o caminho "bloco isolado" quanto o
  // fallback "bloco colado" (bold-wrap + link) do #3204, sem precisar saber
  // qual emoji abre o bloco.
  //
  // O marcador 🛒 (carrinho) segue verificado explicitamente: não é um emoji
  // de CATEGORIA de conteúdo (como 📣/📚/🎉, que o #3204 já tratou como não-
  // essenciais pra detecção), e sim um sinal ESTRUTURAL de FORMATO — mesmo
  // tratamento que `shouldForceCtaPill` (newsletter-render-html.ts) preserva
  // deliberadamente pós-#3204 ("legado... comportamento pré-#3204
  // preservado"). Um box carrinho colado (sem `---`) não é bold-wrap, então
  // `locateGluedBoxInBlock` não o pegaria — por isso o teste dedicado.
  const CART_MARKER_RE = /(?:^|\n)\s*🛒/u;
  function boxAlreadyPresentInGap(a: string, b: string): boolean {
    if (CART_MARKER_RE.test(a) || CART_MARKER_RE.test(b)) return true;
    return extractBoxDivulgacao1(`${a}\n\n---\n\n${b}`) !== null;
  }
  const slot1AlreadyPresent = boxAlreadyPresentInGap(d1, d2);
  const slot1Box = wantSponsor && !slot1AlreadyPresent
    ? loadDivulgacaoSnippet(boxesCfg.slot1, input.snippetsRootDir)
    : null;
  // Slot 2 só existe em edições de 3 destaques (sem gap D2/D3 em edições de 2).
  const slot2AlreadyPresent = d3 !== null && boxAlreadyPresentInGap(d2, d3);
  const slot2Box = wantSponsor && d3 !== null && !slot2AlreadyPresent
    ? loadDivulgacaoSnippet(boxesCfg.slot2, input.snippetsRootDir)
    : null;
  // #6748: slot 3 ELIMINADO — a edição sai com no máximo 2 caixas de
  // divulgação (slot1 + slot2), revertendo a decisão do #3476 que tornou
  // permanente um 3º slot sempre após o último destaque. `boxesCfg.slot3`
  // continua existindo no SCHEMA (`BoxesDivulgacaoConfig`/`platform.config.json`)
  // por back-compat/reversibilidade — decisão documentada no PR #6748 (opção
  // "deixar presente mas nunca selecionado", em vez de remover o campo) — mas
  // deliberadamente NUNCA é lido aqui: `slot3Box` é sempre `null`,
  // independente do que estiver configurado.
  const slot3Box: string | null = null;

  // Caixa de agradecimento a novos apoiadores: entra logo após a coverage line
  // (que termina na frase-CTA de apoio), ainda dentro da região de intro.
  const agradecimentoBox = loadAgradecimentoSnippet(undefined, input.snippetsRootDir);

  // #4274: box de divulgação slot 0 (introdução) — SEMPRE o ÚLTIMO bloco
  // `---`-isolado antes de `**DESTAQUE 1` (depois de qualquer agradecimento
  // a apoiadores já presente) — mesma posição que `locateBoxAtIntro`
  // (newsletter-parse.ts) varre de trás pra frente. Idempotência: sonda a
  // MESMA forma final (coverage line + agradecimento, se houver, + D1) via
  // `extractBoxDivulgacao0` — mesma técnica de `boxAlreadyPresentInGap`/
  // `boxAlreadyPresentAfterLastDestaque` acima.
  function boxAlreadyPresentAtIntro(
    cov: string,
    agr: string | null,
    firstDestaqueText: string,
  ): boolean {
    const probeParts = [cov, "", "---", ""];
    if (agr) probeParts.push(agr, "", "---", "");
    probeParts.push(firstDestaqueText);
    return extractBoxDivulgacao0(probeParts.join("\n")) !== null;
  }
  const slot0AlreadyPresent = boxAlreadyPresentAtIntro(coverageLine, agradecimentoBox, d1);
  const slot0Box = wantSponsor && !slot0AlreadyPresent
    ? loadDivulgacaoSnippet(boxesCfg.slot0, input.snippetsRootDir)
    : null;

  // #4907: link contextual pro hub temático — calculado a partir das opções
  // de título dos destaques ORIGINAIS (d1/d2/d3, pré-injeção), depois de toda
  // a detecção de box de divulgação acima (que já rodou sobre esses mesmos
  // d1/d2/d3 e não deve enxergar o link injetado). Aplicado só na montagem
  // final de `parts` abaixo, via d1Final/d2Final/d3Final — ver
  // `scripts/lib/hub-match.ts` pra regra de match/ambiguidade.
  const destaqueHeadlineOptions = (d3 !== null ? [d1, d2, d3] : [d1, d2]).map(extractBoldLinkTitles);
  const hubMatch = matchEditionHub(destaqueHeadlineOptions);

  // #5122/#5181: grupo "Mais sobre {tema}" no PARA ENCERRAR — aresta
  // edição->edição independente de `hubMatch` acima (não exige match único
  // edição-wide, ver docstring de `scripts/lib/related-editions.ts`). 1 hub
  // (o mais específico entre os casados) + até 2 edições daquele MESMO hub.
  // `excludeUrls` (#5181 item 4) vem das últimas ~10 edições irmãs de
  // `input.editionDir` — evita recomendar a mesma edição-filha
  // indefinidamente enquanto o pool do hub não regenera.
  // `null` (nenhum hub casou em nenhum destaque) omite o grupo inteiro.
  const relatedEditionsGroup = selectRelatedEditions(destaqueHeadlineOptions, {
    excludeUrls: loadRecentRelatedEditionUrls(input.editionDir),
  });
  // #5181 item 3: exclusão mútua com "Saiba mais:" (#4907) — quando o hub
  // que `matchEditionHub` já linkou em algum destaque é o MESMO hub
  // escolhido aqui, omite a linha do hub (preserva rótulo + edições) pra
  // não duplicar o MESMO <a href> duas vezes na mesma edição.
  const omitHubLinkInRelatedGroup =
    hubMatch !== null && relatedEditionsGroup !== null && hubMatch.slug === relatedEditionsGroup.hubSlug;
  const relatedEditionsMarkdown = renderRelatedEditionsMarkdown(relatedEditionsGroup, {
    omitHubLink: omitHubLinkInRelatedGroup,
  });
  function withHubLink(draft: string, idx: number): string {
    if (!hubMatch || hubMatch.destaqueIndex !== idx) return draft;
    return `${draft}\n\nSaiba mais:\n\n[${hubMatch.label}](${hubMatch.url})`;
  }
  const d1Final = withHubLink(d1, 0);
  const d2Final = withHubLink(d2, 1);
  const d3Final = d3 !== null ? withHubLink(d3, 2) : null;

  const parts: string[] = [
    coverageLine,
    "",
  ];
  // A caixa precisa ficar ISOLADA por `---` (seção própria) pra `extractIntroCallout`
  // detectá-la e renderizar com fundo. Colada logo após a coverage line, ela é
  // absorvida pela captura da coverage (#3477) e sai como parágrafo plano.
  if (agradecimentoBox) {
    parts.push("---", "", agradecimentoBox, "");
  }
  // #4274: slot0 vai por ÚLTIMO na região de intro — logo antes do `---` que
  // abre D1 (mesma posição que `locateBoxAtIntro` espera). #4338: prefixado
  // pelo marcador sentinel `BOX0_SENTINEL` — é o ÚNICO sinal que
  // `locateBoxAtIntro` aceita pra reconhecer um box0 real (nunca mais infere
  // por posição, o que causava duplicação do parágrafo de intro quando não
  // havia box0 real configurado, ver docstring de `locateBoxAtIntro`).
  if (slot0Box) {
    parts.push("---", "", BOX0_SENTINEL, slot0Box, "");
  }
  parts.push(
    "---",
    "",
    d1Final,
    "",
    "---",
    "",
  );
  if (slot1Box) {
    parts.push(slot1Box, "", "---", "");
  }
  parts.push(
    d2Final,
    "",
    "---",
    "",
  );
  if (slot2Box) {
    parts.push(slot2Box, "", "---", "");
  }
  // #2343: D3 is optional. For 2-destaque editions, omit the D3 block entirely.
  if (d3Final !== null) {
    parts.push(
      d3Final,
      "",
      "---",
      "",
    );
  }
  // #3476: box de divulgação slot 3 — SEMPRE após o ÚLTIMO destaque (D3 se
  // existir, senão D2), antes de USE MELHOR/É IA?.
  if (slot3Box) {
    parts.push(slot3Box, "", "---", "");
  }
  // #6323: USE MELHOR vem ANTES de LANÇAMENTOS, que vem ANTES de É IA?
  // (decisão do editor 260827, tornado permanente — substitui a ordem
  // USE MELHOR → É IA? → LANÇAMENTOS do #3476/260716). Racional: LANÇAMENTOS
  // é curto hoje e ficava espremido entre dois blocos de "pausa" (USE MELHOR
  // e É IA?); mover É IA? pra depois de LANÇAMENTOS o aproxima do RADAR (a
  // seção mais densa), funcionando como intervalo antes da leitura mais
  // longa. Ordem editorial de USE MELHOR-antes-de-LANÇAMENTOS (#1752, 260603)
  // preservada.
  if (useMelhor) {
    parts.push(useMelhor);
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  if (lancamentos) {
    parts.push(lancamentos);
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  parts.push(
    eiaBlock,
    "",
    "---",
    "",
  );

  // #3820: posição de VÍDEOS relativa a É IA?/RADAR não foi revista pelo
  // #6323 — segue logo após É IA?, antes de RADAR (decisão editorial
  // 260722; histórico: #3100 já tinha movido VÍDEOS pra antes de RADAR).
  if (videos) {
    parts.push(videos);
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  // #1569: PESQUISAS + OUTRAS NOTÍCIAS combinadas em RADAR.
  if (radar) {
    parts.push(radar);
    parts.push("");
    parts.push("---");
    parts.push("");
  }

  parts.push(FIXED_BLOCKS.erro_intencional_placeholder);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push(FIXED_BLOCKS.sorteio);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push(buildParaEncerrar(input.paraEncerrar, relatedEditionsMarkdown, input.snippetsRootDir));
  parts.push("");

  return parts.join("\n");
}

export interface HubDivulgacaoBoxRegenResult {
  readonly ok: boolean;
  readonly path: string;
  readonly slug?: string;
  readonly error?: string;
}

/**
 * #5263: regenera `data/snippets/hub-divulgacao-rotativo.md` pra `editionDate`
 * ANTES de `resolveBoxesForEdition()` rodar a seleção automática de boxes —
 * sem isso o candidato do box rotativo de hubs nunca tinha dado fresco pra
 * competir no ranking (o arquivo em disco ficava preso na última edição em
 * que alguém rodou `build-hub-divulgacao-box.ts` manualmente, se é que
 * rodou — achado do #5263, o mecanismo do PR #5277 nunca foi chamado por
 * lugar nenhum do pipeline).
 *
 * Reusa a MESMA lógica pura do CLI (`resolveHubDivulgacaoBoxSource` +
 * `buildHubDivulgacaoBoxMarkdown` + `renderGeneratedSnippet`, de
 * `build-hub-divulgacao-box.ts`/`lib/shared/hub-divulgacao-box.ts`) — import
 * direto de função em vez de invocar o CLI como subprocess (mais barato,
 * mais testável, sem custo extra de `npx tsx` por edição).
 *
 * **Fail-soft por design** (mesmo princípio de `Diaria-Entity-Pages-Regen`/
 * `Diaria-Hub-Drift-Check`, CLAUDE.md): este box é OPCIONAL — qualquer falha
 * na regeneração (hub sem dataset, I/O, `data/` ausente em clone
 * fresco/sessão cloud) nunca deve abortar o Stage 2. `main()` trata o
 * resultado só como log de warning e segue com o `hub-divulgacao-rotativo.md`
 * que já estiver em disco (ou sem candidato nenhum, se nunca foi gerado —
 * degradação aceitável: `resolveBoxesForEdition()`/`loadSnippets()` a jusante
 * simplesmente não veem esse box entrar no ranking).
 *
 * **Idempotente/no-op quando nada mudou**: usa `writeFileAtomicIfChanged` —
 * regenerar a mesma edição 2x (resume, retry) não re-escreve o arquivo nem
 * bumpa o mtime se o conteúdo byte-a-byte for igual (mesmo hub em rotação,
 * mesmo dataset).
 */
export function regenerateHubDivulgacaoBoxForEdition(
  editionDate: string,
  snippetsDir: string,
): HubDivulgacaoBoxRegenResult {
  const path = join(snippetsDir, "hub-divulgacao-rotativo.md");
  try {
    const source = resolveHubDivulgacaoBoxSource(editionDate);
    const markdown = buildHubDivulgacaoBoxMarkdown(source);
    const content = renderGeneratedSnippet(editionDate, markdown);
    mkdirSync(snippetsDir, { recursive: true });
    writeFileAtomicIfChanged(path, content);
    return { ok: true, path, slug: source.slug };
  } catch (err) {
    return { ok: false, path, error: (err as Error).message };
  }
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) {
    console.error("Uso: stitch-newsletter.ts --edition-dir data/editions/AAMMDD/");
    process.exit(2);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  if (!existsSync(editionDir)) {
    console.error(`[stitch-newsletter] dir não existe: ${editionDir}`);
    process.exit(1);
  }
  try {
    // #2343: detect destaque_count from approved-capped.json to determine if D3 exists.
    // #2355 fix 2: report missing/corrupt capped JSON explicitly — don't mask it as a
    // missing D3 draft. Previously: absent → destaqueCount=3 → d3Path set → stitch
    // throws "input ausente: 02-d3-draft.md" (wrong diagnosis). Now: absent/corrupt
    // throws immediately with the real cause.
    const approvedCappedPath = join(editionDir, "_internal", "01-approved-capped.json");
    if (!existsSync(approvedCappedPath)) {
      throw new Error(`stitch: approved-capped.json ausente — execute o Stage 1 antes: ${approvedCappedPath}`);
    }
    let destaqueCount = 3; // default when highlights field is absent (valid)
    try {
      const approved = JSON.parse(readFileSync(approvedCappedPath, "utf8")) as { highlights?: unknown[] };
      if (Array.isArray(approved.highlights)) {
        destaqueCount = approved.highlights.length;
      }
    } catch (parseErr) {
      // #2355 fix 2: parse failure → fail loud with the capped JSON as the cause.
      throw new Error(`stitch: approved-capped.json corrompido (parse falhou): ${approvedCappedPath} — ${(parseErr as Error).message}`);
    }
    // #2343: D3 existe SOMENTE em edições de exatamente 3 destaques. `=== 3`
    // (não `>= 3`): um count corrompido de 4+ que escape do invariant Stage-1
    // não deve silenciosamente virar edição de 3 destaques — fica null e o
    // stitch falha alto no check de arquivo requerido, em vez de dropar o 4º.
    const d3Path = destaqueCount === 3
      ? join(editionDir, "_internal", "02-d3-draft.md")
      : null;

    // #4626: resolve o mapeamento EFETIVO slot1/2/3 (pin manual vence, senão
    // seleção automática por cliques+tendência+anti-repetição, senão cede
    // pro valor já configurado — ver docstring de `resolveBoxesForEdition`).
    // Roda ANTES de `stitchNewsletter()` pra poder passar o resultado como
    // override explícito (`boxesDivulgacao`) — `stitchNewsletter()` em si
    // continua pura, sem saber que a auto-seleção existe. Nunca escreve em
    // `platform.config.json`: a mudança vale só pra esta stitch.
    const editionAammdd = editionDirArg.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

    // #5263: regenera o box rotativo de hubs pra ESTA edição antes da
    // seleção automática de boxes rodar — sem isso o candidato nunca tem
    // dado fresco pra competir no ranking (ver docstring de
    // `regenerateHubDivulgacaoBoxForEdition`). Fail-soft: warning, nunca
    // aborta o stitch — este box é opcional.
    const hubBoxRegen = regenerateHubDivulgacaoBoxForEdition(editionAammdd, join(ROOT, "data", "snippets"));
    if (hubBoxRegen.ok) {
      process.stderr.write(`[stitch-newsletter] hub-divulgacao-rotativo.md regenerado pra ${editionAammdd} (hub "${hubBoxRegen.slug}")\n`);
    } else {
      console.error(`[stitch-newsletter] warn — falha regenerando hub-divulgacao-rotativo.md (#5263, seguindo com o arquivo existente em disco, se houver): ${hubBoxRegen.error}`);
    }

    const boxesCfgLoaded = loadBoxesDivulgacaoConfig();
    const { effective: effectiveBoxes, selection: boxSelection } = resolveBoxesForEdition({
      aammdd: editionAammdd,
      boxesCfg: boxesCfgLoaded,
    });

    const out = stitchNewsletter({
      d1Path: join(editionDir, "_internal", "02-d1-draft.md"),
      d2Path: join(editionDir, "_internal", "02-d2-draft.md"),
      d3Path,
      approvedCappedPath,
      editionDir,
      // #1938: kill-switch — `--no-sponsor` pula o midCallout da Clarice.
      sponsor: values["no-sponsor"] ? false : true,
      boxesDivulgacao: {
        slot0: effectiveBoxes.slot0,
        slot1: effectiveBoxes.slot1,
        slot2: effectiveBoxes.slot2,
        slot3: effectiveBoxes.slot3,
      },
    });
    const outPath = join(editionDir, "_internal", "02-draft.md");
    writeFileSync(outPath, out);

    // #4626: registro da seleção (pinado/automático/fallback por slot, com
    // score+tendência quando automático) — consumido pelo resumo do Stage 4
    // (§4c.7 de orchestrator-stage-4.md) pra mostrar ao editor QUAL box
    // entrou em cada slot e POR QUÊ, sem exigir ação (decisão do editor
    // #4626: visibilidade sem fricção, nenhum gate novo). Fail-soft: nunca
    // derruba o stitch por falha de escrita deste arquivo informativo.
    try {
      writeFileSync(
        join(editionDir, "_internal", "box-selection.json"),
        JSON.stringify(boxSelection, null, 2),
      );
    } catch (selectionErr) {
      console.error(
        `[stitch-newsletter] warn — falha gravando box-selection.json: ${(selectionErr as Error).message}`,
      );
    }

    // #4150: grava hash do corpo pós-cabeçalho de cada snippet USADO nesta
    // edição (mesmo `used` que o guard de staleness recalcula depois) — o
    // guard compara esse hash contra o recomputado no gate, silenciando
    // warning quando só o cabeçalho de comentário (nome/categoria/alt) mudou
    // pós-stitch. Fail-soft: nunca derruba o stitch, só degrada o guard de
    // volta pro mtime-puro (mesmo padrão de `.social-source-hash.json`/#1413).
    try {
      const snippetsDir = join(ROOT, "data", "snippets");
      // #4626: usa o mapeamento EFETIVO (pós auto-seleção), não uma releitura
      // crua de `platform.config.json` — antes do #4626 os dois eram sempre
      // idênticos (main() nunca passava `boxesDivulgacao` pra stitchNewsletter,
      // então recarregar era equivalente); agora que `stitchNewsletter()` pode
      // ter recebido um slot AUTO-selecionado diferente do que está gravado no
      // disco, hashear a config crua hashearia o snippet ERRADO (o pinado/
      // fallback, não o que de fato foi injetado em `out`).
      const boxesCfgForHash = {
        slot1: effectiveBoxes.slot1,
        slot2: effectiveBoxes.slot2,
        slot3: effectiveBoxes.slot3,
        slot0: effectiveBoxes.slot0,
      };
      const used = resolveUsedSnippets(
        out,
        boxesCfgForHash,
        isAgradecimentoSnippetUsed(snippetsDir),
      );
      const hashes = buildSnippetBodyHashManifest(used, snippetsDir);
      writeSnippetBodyHashManifest(editionDir, hashes);
    } catch (hashErr) {
      console.error(
        `[stitch-newsletter] warn — falha gravando snippet-body-hashes: ${(hashErr as Error).message}`,
      );
    }

    console.log(JSON.stringify({ out_path: outPath, bytes: out.length, destaque_count: destaqueCount }, null, 2));
  } catch (e) {
    console.error(`[stitch-newsletter] erro: ${(e as Error).message}`);
    process.exit(1);
  }
}

const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) main();
