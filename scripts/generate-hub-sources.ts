/**
 * generate-hub-sources.ts (#4558 Parte A)
 *
 * Gera `scripts/lib/hubs/{slug}-sources.generated.json` — a lista de edições
 * confirmadas da diar.ia.br cujo título ou subtítulo casa a palavra-chave de
 * um hub temático, a partir de `data/beehiiv-cache/posts/*.json` (mesma
 * fonte de `generate-arquivo-titles.ts`). Cada entrada carrega
 * `{date, editionSlug, url, matchedHeadlines}` — `url` já no domínio de
 * marca (`diar.ia.br/p/{editionSlug}`, #4059), `matchedHeadlines` são só os
 * destaques que bateram a palavra-chave (não os 3 da edição inteira).
 *
 * O JSON gerado é COMMITADO — `scripts/lib/hubs/{slug}.ts` importa
 * estaticamente pra computar os números do FAQ (`buildXxxFaq`) e a lista de
 * "edições citadas". Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *
 *   npx tsx scripts/generate-hub-sources.ts --hub anthropic-claude
 *
 * **`--all` (#5125) — todos os hubs numa invocação**, carregando o corpus uma
 * vez só (`loadPosts` lê ~250 JSONs do junction `data/`; 7 invocações
 * separadas pagavam essa leitura 7×):
 *
 *   npx tsx scripts/generate-hub-sources.ts --all
 *
 * **Por que a defasagem acontece (medido em 26/08/2026, #5125).**
 * `build-hub-page.ts` NÃO regenera as fontes — ele lê os
 * `{slug}-sources.generated.json` já commitados, via
 * `scripts/lib/hubs/{slug}.ts` (import estático). Nenhuma task agendada
 * chama ESTE script, então os JSONs só saem da defasagem quando alguém
 * lembra do comando: em 26/08 os 7 paravam entre 11/08 e 18/08, e 13
 * edições com match óbvio contra hub JÁ EXISTENTE (Claude, OpenAI, Gemini,
 * TSE) apareciam como "sem tema" no relatório de cobertura do #5125. Não é
 * a primeira vez — o commit `03066efd` (#5632) foi exatamente um regen
 * manual da mesma defasagem.
 *
 * **`--all` NÃO foi ligado à task semanal `Diaria-Hub-Pages-Build` (#5754),
 * de propósito.** Um passo de regen desassistido ANTES do build faria o
 * build falhar toda semana: `UPDATED_DATE` é escrito à mão em cada
 * `scripts/lib/hubs/{slug}.ts` e `validateHubContent` exige
 * `updatedDate >= sourceEditions[0].date` (guard do #5124, correto — é o
 * que impede um hub de declarar frescor que não tem). Fonte regenerada
 * sempre avança à frente de uma data hand-written, então a automação
 * precisaria ou derivar `UPDATED_DATE` das fontes, ou aceitar que cada
 * regen exige revisão editorial da prosa (`sections`/FAQ) pra decidir se as
 * edições novas abrem seção nova — julgamento, não mecânica. Enquanto isso
 * não for resolvido, este script é de invocação MANUAL, e quem o roda
 * assume o passo seguinte. Ver #6267.
 *
 * **`--dry-run` (#5203) — preview sem gravar.** Roda a coleta normal (ainda
 * precisa do junction `data/`, ver `loadPosts` abaixo) e imprime no stderr um
 * resumo do diff contra o JSON já commitado (quantas entradas seriam
 * adicionadas/alteradas/removidas, e a lista de `editionSlug` que sairiam)
 * — `writeFileAtomic` NUNCA roda nesse modo, o arquivo em disco fica
 * intocado. Combina com `--backfill-titles`. Existe porque a versão
 * SEM `--dry-run` sobrescreve o JSON inteiro sem merge (ver comentário no
 * pattern `brasil-regulacao` abaixo) — antes desta flag existir de fato, um
 * comentário promissor dela já vivia no arquivo (#5124), o que por si só
 * era o risco: rodar `--dry-run` "pra só ver" na verdade gravava:
 *
 *   npx tsx scripts/generate-hub-sources.ts --hub anthropic-claude --dry-run
 *
 * **`--backfill-titles` (#4918 Conserto 2) — preenche `editionTitle` sem
 * precisar do junction `data/`.** Modo separado que lê o JSON JÁ commitado
 * e casa `editionSlug` contra `workers/arquivo/src/titles-cache.json`
 * (também commitado) — roda em sessão cloud:
 *
 *   npx tsx scripts/generate-hub-sources.ts --hub anthropic-claude --backfill-titles
 *
 * **Normalização de acento (NFD, strip de combining marks) — defensiva, não
 * corrige um bug já observado neste pattern.** `HUB_KEYWORD_PATTERNS` de
 * hoje (`anthropic-claude`) não tem nenhum caractere acentuado, então
 * `stripAccents()` é um no-op pra ele — o achado ao vivo desta feature
 * (regex acentuado batendo 0 contra texto NFD real do cache) foi em
 * `countMatching()`, `scripts/lib/hubs/anthropic-claude.ts` (normaliza pra
 * NFC, direção OPOSTA — porque lá os patterns TÊM acento: "lanç", "análise
 * psicológica"). `stripAccents()` aqui existe pra um hub FUTURO cujo
 * `HUB_KEYWORD_PATTERNS` venha a ter acento — sem ela, esse hub futuro
 * repetiria o mesmo bug. Não é a mesma corrupção documentada em
 * `generate-arquivo-titles.ts` (aquela é o Beehiiv REMOVENDO acento ao
 * gerar o slug da URL, afetando só o fallback `displayTextFromLoc` — nunca
 * `post.title`/`post.subtitle`, que é o que este arquivo lê); a daqui é o
 * cache armazenando `title`/`subtitle` em NFD (combining mark separado, ex:
 * "ç" = "c" + U+0327) em vez de NFC.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import {
  loadPublishDateOverrides,
  resolvePublishDate,
  type PublishDateOverridesResult,
} from "./lib/beehiiv-publish-date.ts";
import { findPrimarySourceUrl, stripTrackingParams } from "./lib/hub-primary-source.ts";
import { isSafeUrlScheme } from "./lib/shared/markdown-links.ts";
import type { RawCachedPost } from "./generate-arquivo-titles.ts";
import { loadUnifiedEditionCache } from "./lib/shared/edition-cache-reader.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HUBS_DIR = resolve(ROOT, "scripts/lib/hubs");

export interface HubSourceEntry {
  /** `YYYY-MM-DD`, BRT — via `resolvePublishDate` (`lib/beehiiv-publish-date.ts`,
   * #4796): override por slug primeiro, senão `publish_date` bruto. */
  date: string;
  /** Slug da EDIÇÃO no Beehiiv — nome deliberadamente distinto de
   * `HubContent.slug` (o slug do HUB, em `hub-page.ts`) pra não confundir
   * os dois na leitura de `scripts/lib/hubs/{slug}.ts` (achado do fleet
   * review). */
  editionSlug: string;
  /** Domínio de marca — `https://diar.ia.br/p/{editionSlug}` (#4059). */
  url: string;
  /** Só os destaques (título e/ou trechos do subtítulo) que bateram a palavra-chave. */
  matchedHeadlines: string[];
  /** URL de fonte primária de cada manchete em `matchedHeadlines`, ALINHADA
   * POR ÍNDICE (`primarySourceUrls[i]` corresponde a `matchedHeadlines[i]`)
   * — #4919. Array paralelo em vez de virar `matchedHeadlines` numa lista
   * de objetos `{headline, primarySourceUrl}`: ~15 call sites já leem
   * `matchedHeadlines` como `string[]` puro (`hub-page.ts::hubTotals`/
   * `hubMentionCadenceDays`/`countMatching`, `hub-staleness-check.ts`, os 4
   * módulos de conteúdo `scripts/lib/hubs/*.ts`, testes) — trocar o tipo
   * quebraria todos eles pra um campo que a Fase A desta issue nem consome
   * ainda (consumo em prosa é item 8, fase B). Decisão de formato
   * registrada no PR.
   *
   * `null` (não `undefined`) na posição em que a Regra A/B de
   * `findPrimarySourceUrl` não achou âncora — nunca por fallback
   * posicional (issue #4919: "melhor a entrada sair sem `primarySourceUrl`
   * do que com atribuição suspeita"). `null` em vez de `undefined` porque é
   * assim que o elemento sobrevive ao round-trip por `JSON.stringify`
   * (array com posição `undefined` vira `null` na serialização; declarar
   * o tipo como `null` evita a discrepância entre o objeto em memória e o
   * que o arquivo `.generated.json` de fato contém depois de escrito+lido).
   * Campo OMITIDO (não um array de só `null`) quando o post não tem
   * `content.free.web` no cache, ou quando NENHUMA manchete da linha achou
   * âncora — no primeiro caso não há dado pra tentar; no segundo o array
   * não carregaria informação nova. */
  primarySourceUrls?: (string | null)[];
  /** Título real da edição (`post.title`, ou fallback via `titles-cache.json`
   * — ver `backfillEditionTitles`). Opcional: hub renderer cai no rótulo
   * antigo (só a manchete casada) quando ausente (#4918 Conserto 2, "o item
   * não diz de qual edição veio"). */
  editionTitle?: string;
  /** Entrada CURADA À MÃO, preservada entre regens (#5125, 26/08/2026).
   *
   * `collectHubSources` só acha o que `HUB_KEYWORD_PATTERNS` casa contra
   * `[title, ...subtitle]` — o texto de RADAR nunca entra nessa checagem.
   * Edição cujo lastro no tema está só no RADAR precisa ser adicionada à
   * mão, e até aqui `runGenerate` a APAGAVA em silêncio no regen seguinte
   * (sobrescreve o JSON inteiro, sem merge). O comentário do pattern
   * `brasil-regulacao` avisava disso e listava 2 entradas; a medição de
   * 26/08 achou **3** — a 3ª (`hacker-chines-usa-deepseek-em-ataques-autonomos`,
   * introduzida pelo próprio commit de regen do #5632) nunca chegou a ser
   * documentada, que é precisamente o modo de falha de um aviso em prosa.
   *
   * Marcar `manual: true` faz `runGenerate` reinjetar a entrada depois da
   * coleta quando o pattern não a redescobre. Sem isso, armar a task semanal
   * `Diaria-Hub-Pages-Build` (#5754) apagaria as entradas curadas todo
   * domingo, sem ninguém ver. NUNCA gravado por `collectHubSources` — é
   * exclusivamente sinal humano no JSON commitado. */
  manual?: true;
}

/** Registro de palavra-chave por hub — espelha os padrões usados na proposta
 * de temas (#4558, artefato da sessão 260804). 3 hubs implementados até
 * aqui: `anthropic-claude` (#4558 original), `openai-chatgpt` e
 * `google-gemini` (mesma issue, rodada seguinte). Adicionar um hub novo é
 * uma entrada aqui + seu `scripts/lib/hubs/{slug}.ts` — este comentário não
 * precisa de update a cada hub adicionado. */
export const HUB_KEYWORD_PATTERNS: Record<string, RegExp> = {
  "anthropic-claude": /anthropic|\bclaude\b|\bopus\b|\bsonnet\b|\bmythos\b|\bfable\b/i,
  "openai-chatgpt": /openai|\bchatgpt\b|\bgpt-?\d|\bsora\b|sam altman/i,
  "google-gemini": /\bgoogle\b|\bgemini\b|deepmind|\bveo\b|\bnano banana\b|sundar pichai/i,
  // #4558 (develop 260810, 4º hub, leva de empresa). `\bmeta\b` sozinho
  // arrisca casar o substantivo comum ("atinge a meta de", "metas
  // ambiciosas") — verificado ao vivo contra as 242 edições confirmadas do
  // cache real (`data/beehiiv-cache/posts`) no momento em que este pattern
  // foi escrito: nenhum destaque real usa "meta" como substantivo comum
  // isolado (todo destaque que bate começa com "Meta" maiúsculo, nome da
  // empresa) — é uma aposta textual verificada contra o dado de hoje, não
  // uma garantia estrutural; se uma edição futura usar "bateu a meta
  // trimestral" como destaque, ela entraria aqui por engano.
  // `\bllama\b`/`zuckerberg` são defensivos (nenhum destaque real depende
  // deles hoje — ver docstring de `scripts/lib/hubs/meta-ai.ts`).
  "meta-ai": /\bmeta\b|\bllama\b|zuckerberg/i,
  // #4558 (5º hub, 1º TEMÁTICO transversal — os 4 anteriores são hubs de
  // EMPRESA). Tema é regulação/política pública de IA NO BRASIL — não
  // "Brasil" genérico. Uma sonda inicial contra `\bbrasil\b` sozinho
  // estourou muito além do lastro real do tema (casava estatística de
  // adoção de mercado, "Brasil pretende investir R$ 23 bi", cobertura de
  // produto chegando ao país — nada disso é REGULAÇÃO), então este pattern
  // é deliberadamente estreito: nomeia órgão/mecanismo regulatório
  // brasileiro específico, não o substantivo "Brasil"/"brasileiro" isolado.
  // Verificado ao vivo contra os 243 posts confirmados de
  // `data/beehiiv-cache/posts` (11/08/2026) — 13 manchetes em 11 edições,
  // cada uma lida no corpo completo do post (não só o título) antes de
  // entrar aqui:
  //   - "Congresso debate IA generativa e direitos autorais" e "Senado
  //     debate plano nacional de IA" não citam "Brasil"/"Nacional" no
  //     título, mas o corpo confirma Câmara dos Deputados (PL 2338/23) e
  //     Senado Federal — por isso os pares `(?=.*\bcongresso\b)(?=.*\bia\b)`/
  //     `(?=.*\bsenado\b)(?=.*\bia\b)`/`(?=.*\bcamara\b)(?=.*\bia\b)` (co-
  //     ocorrência via lookahead, não substring solta — "congresso"/
  //     "senado"/"câmara" sozinhos arriscam colidir com evento científico ou
  //     órgão de outro país; exigir "ia" na MESMA manchete restringe ao caso
  //     real). Auditado: nenhuma outra manchete do corpus usa essas 3
  //     palavras fora dos casos aqui listados (nenhum falso positivo hoje).
  //     **Risco latente pra REGENERAÇÕES futuras (achado no fleet review do
  //     #5056, não afeta o corpus atual):** `\bia\b` com `/i` casa tanto o
  //     acrônimo "IA" quanto o verbo minúsculo "ia" (pretérito imperfeito de
  //     "ir" — ex: "Senado ia aprovar reforma tributária"), então os 3 pares
  //     de co-ocorrência acima podem virar falso positivo numa manchete
  //     futura que use "ia" como verbo perto de Congresso/Senado/Câmara. Sem
  //     fix aplicado aqui de propósito — JS não tem modificador de case
  //     inline por trecho da regex, e reescrever o padrão inteiro sem `/i`
  //     pra distinguir "IA" maiúsculo quebraria as outras alternativas deste
  //     mesmo pattern (`marco legal`, `anpd`, etc., que aparecem em
  //     capitalização mista no corpo). Mitigação real continua sendo a
  //     verificação manual manchete-a-manchete já praticada aqui — se uma
  //     regeneração futura trouxer um hit desses 3 pares, conferir o corpo
  //     antes de aceitar. Mesmo racional pro `\bpl[ -]?\d{3,4}\b` isolado
  //     (casa qualquer PL de 3-4 dígitos, não só o 2338 do Marco Legal) —
  //     hoje só casa manchetes que já falam de IA no mesmo contexto (nenhum
  //     PL não-relacionado no corpus atual), mas não é garantia estrutural.
  //   - "classifica sistemas de ia por risco" e "manipular ia do tribunal"
  //     são âncoras literais de 2 manchetes específicas verificadas — o
  //     corpo confirma "lei brasileira de regulação de sistemas
  //     automatizados" e "Judiciário brasileiro"/"advogado na Paraíba", mas
  //     nenhuma das duas manchetes cita um órgão nomeado nem "Brasil" no
  //     título, então não há keyword genérica que as capture sem
  //     sobre-casar (mesmo racional do anchor `/^Meta compra/i` em
  //     `meta-ai.ts`).
  //   - `\bCFM\b`/`\bAnatel\b`/`\bTSE\b` ficam sem exigir co-ocorrência com
  //     "ia" porque as 4 manchetes reais que os citam ("CFM normatiza o uso
  //     da IA na medicina", "Anatel adota nuvem soberana para IA", "TSE
  //     avalia força-tarefa para coibir deepfakes", "Governo pede ao TSE
  //     endurecer remoção de perfis") já vêm com contexto de IA/deepfake na
  //     mesma manchete, e os 3 acrônimos não colidem com nenhum substantivo
  //     comum em português.
  // Não incluídos de propósito, por serem tema DIFERENTE (política
  // industrial/soberania de IA, não regulação): "Governo lança modelo de
  // linguagem 100% nacional", "SoberanIA no ar: Brasil tem modelo de IA
  // próprio" — candidatos a um hub futuro de soberania/infra, não este.
  //
  // **#5124 (260813) — 2 entradas do JSON commitado NÃO são reproduzíveis
  // rodando este arquivo.** A defasagem de 48 dias apontada pela issue foi
  // investigada com busca manual mais ampla que o corpus title/subtitle de
  // sempre — leitura de CORPO INTEIRO das 36 edições entre 25/06 e 13/08,
  // seção RADAR incluída (`collectHubSources` só testa `post.title`/
  // `post.subtitle`, ver função abaixo — RADAR nunca entra no scan
  // automático, é sub-headline dentro do corpo do e-mail). Achado: 2 itens
  // de RADAR genuinamente sobre regulação de IA no Brasil, verificados
  // contra fonte primária (camara.leg.br, gov.br) antes de entrar —
  // "Usar óculos com IA ao volante pode pesar no bolso" (30/06, PL 19/2026,
  // CVT da Câmara) e "Gestão lança Matriz de Competências em Inteligência
  // Artificial" (03/07, MGI/SGD, ligada ao PBIA já citado no FAQ do hub —
  // NÃO confundir com a Portaria MGI nº 3.485/2026, ato distinto e anterior
  // que institui só a política de governança de IA interna do ministério,
  // ver a ressalva no próprio FAQ) — adicionados A MÃO em
  // `scripts/lib/hubs/brasil-regulacao-sources.generated.json` (entradas
  // `como-ter-acesso-alexa` e `governo-dos-eua-pode-virar-socio-da-openai`).
  // Nenhum termo novo generalizado pro regex abaixo: como o gatilho é
  // RADAR (não destaque), ampliar o pattern não teria efeito — a checagem
  // acontece contra `destaques = [title, ...subtitle]`, que nunca inclui
  // texto de RADAR.
  //
  // **#5125 (260826) — o apagamento silencioso deixou de ser possível, e a
  // 3ª entrada apareceu.** Até aqui este comentário avisava que rodar o
  // script sem `--dry-run` sobrescrevia o JSON e apagava as entradas acima
  // sem aviso, pedindo re-adição manual. Duas coisas mudaram:
  //   1. As entradas curadas agora carregam `"manual": true` e
  //      `runGenerate` as reinjeta depois da coleta (ver
  //      `mergeManualHubSources`). O regen virou seguro — pré-requisito de
  //      qualquer automação futura deste script, e já hoje evita que um
  //      regen manual destrua curadoria por descuido.
  //   2. O dry-run de 26/08 mostrou **3** entradas a remover, não 2 — a
  //      terceira (`hacker-chines-usa-deepseek-em-ataques-autonomos`,
  //      governança de IA na medicina) entrou pelo commit `03066efd`/#5632 e
  //      nunca foi documentada aqui. É o modo de falha de um aviso em prosa:
  //      quem adicionou a 3ª não atualizou a lista. A marcação no dado
  //      (`manual: true`) não tem esse problema — não depende de ninguém
  //      lembrar de editar um comentário.
  // Continua valendo como trabalho futuro possível estender
  // `collectHubSources` pra varrer RADAR (mudança maior, cross-cutting nos 7
  // hubs) — aí estas entradas passariam a ser derivadas em vez de curadas.
  "brasil-regulacao":
    /\banpd\b|marco legal( da| de)? (ia\b|inteligencia artificial)|\bmarco de ia\b|\bpl[ -]?\d{3,4}\b|projeto de lei|\bstf\b|congresso nacional|\bcfm\b|\banatel\b|\btse\b|hugo motta|brasil regula|classifica sistemas de ia por risco|manipular ia do tribunal|(?=.*\bcongresso\b)(?=.*\bia\b)|(?=.*\bsenado\b)(?=.*\bia\b)|(?=.*\bcamara\b)(?=.*\bia\b)/i,
  // #4558 (6º hub, 2º TEMÁTICO transversal — brasil-regulacao foi o 1º).
  // Tema é o impacto da IA no mercado de trabalho: demissão/corte atribuído
  // a IA, estudo de exposição de emprego a automação, mudança de critério de
  // contratação, requalificação de equipe — não "trabalho"/"carreira" como
  // rótulo de seção genérico de produtividade pessoal (esse já é o assunto
  // de boa parte de "USE MELHOR", fora do escopo deste hub). Verificado ao
  // vivo contra os 248 posts confirmados de `data/beehiiv-cache/posts`
  // (12/08/2026) — 48 edições, 49 manchetes, cada uma lida no CORPO completo
  // do post (não só o título) antes de entrar aqui:
  //   - `\bemprego(s)?\b`/`\bdesemprego\b`/`demiss`/`demit` cobrem a maioria
  //     das manchetes reais ("Estudo de Harvard estima: 92 mi de empregos
  //     estão em risco", "Meta demite 8 mil para dobrar em IA", "Amodei:
  //     desemprego pode ser permanente"). `demit`/`demiss` são raiz solta
  //     (sem `\b` nas duas pontas) de propósito — cobrem "demitir"/
  //     "demitiu"/"demitido(s)"/"demissão"/"demissões" com uma entrada só;
  //     nenhuma palavra do corpus real contém essas raízes fora do sentido
  //     de corte de emprego (auditado).
  //   - `\btrabalho(s)?\b`/`\btrabalhador(es)?\b` são intencionalmente SEM
  //     as formas verbais ("trabalhar"/"trabalha"/"trabalhando") — a sonda
  //     inicial com raiz `trabalh` solta casou "Agora, o Comet consegue
  //     TRABALHAR em diversas abas" (recurso de navegador, nada a ver com
  //     mercado de trabalho); restringir ao substantivo elimina esse falso
  //     positivo sem perder nenhuma manchete real (todas as 13 do corpus que
  //     usam a raiz `trabalh` num sentido de mercado de trabalho usam a
  //     forma substantiva: "carga de trabalho", "colega de trabalho",
  //     "trabalhador demitido", "trabalho analítico", "impacto da IA no
  //     mercado de trabalho").
  //   - `\bcort(ar|am|e|es|ando)\b` (corte de vaga/equipe) é deliberadamente
  //     SEM a forma `corta` (3ª pessoa do singular) — incluir `\bcorta\b`
  //     casava "DeepSeek CORTA 75% do preço da API" (corte de preço, não de
  //     emprego). O único caso real que precisa da 3ª pessoa do singular é
  //     "Atlassian corta 10% da equipe para financiar IA", coberto pela
  //     âncora literal `corta 10% da equipe` abaixo em vez de generalizar a
  //     forma verbal e reabrir o falso positivo do preço.
  //   - `\bcontratacao\b`/`para contratar`/`recontrat` cobrem contratação
  //     como TEMA (mudança de critério de seleção, RH, recontratação após
  //     falha de automação) sem casar "OpenAI CONTRATA criador do OpenClaw"
  //     (uma contratação pontual de indivíduo, história de empresa, não de
  //     mercado de trabalho) — a forma nua `\bcontrata\b`/`\bcontratar\b`
  //     foi descartada de propósito por causa desse caso real; a forma "para
  //     contratar" (não "contrata" sozinho) é o que aparece nas 2 manchetes
  //     reais que precisam dela ("Nubank exige... PARA CONTRATAR", "RH usa
  //     automação PARA CONTRATAR e demitir" — esta already casa via `demit`,
  //     mas a âncora cobre o caso em que só "contratar" apareceria sozinho).
  //   - `\bvagas?\b`/`\bcarreira\b`/`mercado de trabalho` são substantivo
  //     solto sem falso positivo detectado no corpus atual (auditado: toda
  //     ocorrência de "vaga(s)"/"carreira" nas 248 edições é sobre emprego).
  //   - As 7 âncoras literais finais (`brasil emprega mais`, `rh
  //     algoritmico`, `entrevistas tecnicas`, `certificados contra o
  //     apagao`, `aeroportos automatizam tarifas`, `horas por semana
  //     corrigindo erros`, `candidatos burlam triagem`, `vies ao contratar`)
  //     são manchetes específicas cujo corpo confirma impacto de mercado de
  //     trabalho mas cujo TÍTULO não usa nenhum substantivo genérico da
  //     lista acima — mesmo racional do anchor `/^Meta compra/i` em
  //     `meta-ai.ts` e das âncoras literais de `brasil-regulacao.ts`:
  //     "Brasil emprega mais... em cargos que somem" (jovens brasileiros
  //     admitidos majoritariamente em funções expostas à automação),
  //     "47,7% de adesão: o RH algorítmico da Serasa" (RH orientado por
  //     modelo), "Google libera IA em entrevistas técnicas" (mudança de
  //     critério de seleção técnica), "Tigre e os 200 mil certificados
  //     contra o apagão" (requalificação de força de trabalho — "apagão de
  //     competências", no vocabulário da própria matéria), "Aeroportos
  //     automatizam tarifas com câmeras com IA" (automação elimina função
  //     administrativa — o corpo cita explicitamente "IA e emprego"), "6
  //     horas por semana corrigindo erros de ferramentas" (carga de trabalho
  //     extra que a automação impõe, medida pela Glean), "RH: candidatos
  //     burlam triagem com prompts" (seção "MERCADO DE TRABALHO" na própria
  //     edição), "Modelos superam humanos em viés ao contratar" (seção
  //     "MERCADO" — viés algorítmico de seleção).
  //   - Overlap deliberado com hubs de EMPRESA já publicados (ex: "Meta
  //     demite 8 mil para dobrar em IA" casa `meta-ai` E `mercado-trabalho`)
  //     — legítimo por design (issue #4558: "um hub pode aparecer em mais de
  //     um painel temático"), não um bug de sobre-casamento.
  //   - Não incluído de propósito, por ser sobre CAPACIDADE de produto, não
  //     sobre impacto no mercado de trabalho: "Claude Code supera equipe de
  //     engenheiros da Google" (claim de desempenho/benchmark, não notícia
  //     de mercado de trabalho) e "1.134 funcionários da IA pedem freio ao
  //     setor" (segurança de IA, não emprego) — ambos só apareceriam se a
  //     raiz solta `equipe`/`funcionari` tivesse entrado no pattern; não
  //     entrou por causa desses 2 falsos positivos. "Codex vai além do
  //     código e mira trabalho analítico" ENTROU (via `trabalho`) porque o
  //     corpo descreve deslocamento real de função ("disputa... para ocupar
  //     o centro do trabalho intelectual", analistas/consultores como
  //     público-alvo direto do produto) — mesmo padrão dos demais itens.
  "mercado-trabalho":
    /\bemprego(s)?\b|\bdesemprego\b|demiss|demit|\bvagas?\b|mercado de trabalho|\btrabalho(s)?\b|\btrabalhador(es)?\b|\bcarreira\b|\bcontratacao\b|para contratar|vies ao contratar|recontrat|\bcort(ar|am|e|es|ando)\b|corta 10% da equipe|brasil emprega mais|rh algoritmico|entrevistas tecnicas|certificados contra o apagao|aeroportos automatizam tarifas|horas por semana corrigindo erros|candidatos burlam triagem/i,
  // #5741 (7º hub, 3º TEMÁTICO transversal — setor de aplicação, não ator
  // nem eixo regulatório). Tema é IA aplicada a medicina/saúde: diagnóstico
  // assistido por modelo, normatização profissional (CFM), adoção
  // hospitalar/SUS, pesquisa clínica (câncer, doenças genéticas), e o risco
  // de segurança do paciente que o uso não-supervisionado carrega — não
  // "saúde" como bem-estar genérico de produtividade pessoal (esse já é
  // território de USE MELHOR). Verificado ao vivo contra os 249 posts
  // confirmados de `data/beehiiv-cache/posts` (20/08/2026) — 21 edições, cada
  // uma lida no CORPO completo do post (não só o título) antes de entrar
  // aqui:
  //   - `\bmedicin[a-z]*\b`/`\bmedico(s)?\b`/`\bhospital(es)?\b`/
  //     `\bpaciente(s)?\b`/`diagnostic`/`\bcfm\b`/`clinic`/`cirurgi`/
  //     `\banvisa\b`/`\bsus\b`/`enfermeir`/`radiologia`/`\blaudo(s)?\b`/
  //     `\bexame(s)?\b`/`oncolog`/`\bfda\b`/`farmac` cobrem o núcleo
  //     profissional/regulatório do tema (ex: "CFM normatiza o uso da IA na
  //     medicina", "IA do Google detecta câncer raro no SUS", "Sistema do
  //     Google iguala médicos em teste").
  //   - `\bsaude\b` é substantivo isolado, sem forma verbal — sonda inicial
  //     confirmou que toda ocorrência real no corpus é sobre saúde (bem-
  //     estar/sistema de saúde), sem falso positivo detectado (ex: "ChatGPT
  //     aplica medidas para cuidado com saúde mental").
  //   - `cancer`/`doenc`/`vacina`/`prontuari`/`terapi` são raízes soltas
  //     adicionadas depois da sonda inicial (achado: "câncer"/"doenças"/
  //     "vacina"/"prontuário"/"terapia" concentram 8 das 21 manchetes reais
  //     e nenhuma delas usa o núcleo profissional acima) — auditado contra
  //     o corpus atual, sem colisão com termo de outro tema (ex: "terapia"
  //     aqui é sempre terapia em saúde mental, não "terapia de choque"
  //     econômica ou análogo).
  //   - Overlap deliberado com hubs já publicados é esperado por design
  //     (issue #4558: "um hub pode aparecer em mais de um painel temático"),
  //     mas não há colisão real hoje — nenhuma das 21 manchetes bate
  //     `mercado-trabalho`/`brasil-regulacao`/hub de empresa.
  //
  // **Candidato irmão `direito-juridico` NÃO tem lastro comparável e não
  // foi publicado (#5741).** Sonda equivalente contra o mesmo corpus, com
  // pattern generoso (`juridic|direito|advogad|tribunal|juiz|justica|oab|
  // stf|stj|processo judicial|peticion|sentenca|julgament|penal|criminal|
  // magistrad|supremo|condenad|absolvid|indeniza|direitos autorais|plagio`),
  // achou só 6 edições — mesmo incluindo "golpe"/"fraude" com deepfake
  // (crime financeiro, não conteúdo de direito/jurídico como profissão),
  // o total sobe pra 7. Muito abaixo do hub mais magro já publicado
  // (`brasil-regulacao`, 14 edições) — decisão de não publicar documentada
  // no PR/comentário da issue, contrato do #4899 ("hub com poucas fontes é
  // pior que hub nenhum").
  "medicina-saude":
    /\bmedicin[a-z]*\b|\bsaude\b|\bhospital(es)?\b|\bmedico(s)?\b|diagnostic|\bpaciente(s)?\b|\bcfm\b|clinic|cirurgi|\banvisa\b|\bsus\b|enfermeir|radiologia|\blaudo(s)?\b|\bexame(s)?\b|oncolog|\bfda\b|farmac|cancer|doenc|vacina|prontuari|terapi/i,
};

/** Exportado (#4907) — `scripts/lib/hub-match.ts` reusa esta mesma
 * normalização pra decidir, na hora da escrita da edição, se as manchetes
 * do dia casam `HUB_KEYWORD_PATTERNS` de algum hub existente. Nunca duplicar
 * a lógica de strip de acento num 2º lugar. */
export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Resolve `primarySourceUrls` (#4919) pra um post já casado: pra cada
 * manchete em `matched`, tenta `findPrimarySourceUrl` contra
 * `content.free.web` (Regra A: âncora de texto idêntico; Regra B: rótulo
 * "Aprofunde"/"Saiba mais" limitado à janela até a próxima manchete —
 * NUNCA fallback posicional, ver docstring de `hub-primary-source.ts`).
 * URL achada passa por `stripTrackingParams` (remove `utm_*`, inclusive de
 * terceiro) e pelo guard de esquema `isSafeUrlScheme` (só `https:`) antes
 * de entrar no array — falha em qualquer um dos dois vira `null` na
 * posição, nunca lança e nunca é substituída por outra âncora.
 *
 * Retorna `undefined` (campo OMITIDO na entrada) quando o post não tem
 * `content.free.web` no cache, ou quando toda posição do array resultante
 * ficaria `null` (nenhuma manchete achou fonte — array de só `null` não
 * carrega informação nova).
 */
function computePrimarySourceUrls(
  post: RawCachedPost,
  matched: readonly string[],
  allHeadlines: readonly string[],
): (string | null)[] | undefined {
  const html = post.content?.free?.web;
  if (!html) return undefined;
  const urls = matched.map((headline) => {
    const raw = findPrimarySourceUrl(html, headline, allHeadlines);
    if (!raw) return null;
    const normalized = stripTrackingParams(raw);
    return isSafeUrlScheme(normalized) ? normalized : null;
  });
  return urls.some((u) => u !== null) ? urls : undefined;
}

export interface CollectHubSourcesResult {
  rows: HubSourceEntry[];
  /** Posts confirmados que bateram a palavra-chave mas foram PULADOS por
   * falta de `slug`/`publish_date` resolvível — mesmo espírito de
   * `buildTitlesCache` (generate-arquivo-titles.ts): nunca descartar dado
   * em silêncio, sempre reportar o motivo. */
  warnings: string[];
}

/**
 * Pure: varre os posts confirmados e devolve as entradas que casam
 * `pattern`, mais os warnings de qualquer post pulado. Ordenado por data
 * crescente.
 *
 * @param overridesResult   Injetável pra testes (confirma que a função
 *                           propaga um override presente/erro/descarte real
 *                           — #4803); default é `loadPublishDateOverrides()`,
 *                           o arquivo committado.
 */
export function collectHubSources(
  posts: RawCachedPost[],
  pattern: RegExp,
  overridesResult: PublishDateOverridesResult = loadPublishDateOverrides(),
): CollectHubSourcesResult {
  const rows: HubSourceEntry[] = [];
  const warnings: string[] = [];

  // #4803: mesmo racional de generate-arquivo-titles.ts::buildTitlesCache —
  // falha de override não pode ficar só em stderr.
  if (overridesResult.error) {
    warnings.push(
      `beehiiv-publish-date-overrides.json malformado (${overridesResult.error}) — seguindo SEM nenhum override; slugs afetados voltam pro publish_date bruto (comportamento pré-#4796)`,
    );
  }
  for (const w of overridesResult.discarded) warnings.push(`beehiiv-publish-date-overrides.json: ${w}`);

  for (const post of posts) {
    if (post.status !== "confirmed") continue;
    const destaques = [post.title, ...(post.subtitle ? post.subtitle.split("|").map((s) => s.trim()) : [])].filter(
      (s): s is string => Boolean(s),
    );
    const matched = destaques.filter((d) => pattern.test(stripAccents(d)));
    if (matched.length === 0) continue;
    // A partir daqui o post BATEU a palavra-chave — pular por dado ausente
    // sempre com warning (achado do fleet review: antes o drop era mudo).
    const where = post.slug ?? post.title ?? "(post sem slug nem title)";
    if (!post.slug) {
      warnings.push(`post confirmado e casado, mas sem slug resolvível: "${where}"`);
      continue;
    }
    // #4796: override por slug primeiro, cai no publish_date bruto pra todo o resto.
    const date = resolvePublishDate(post.slug, post.publish_date, overridesResult.overrides);
    if (!date) {
      warnings.push(`slug "${post.slug}" confirmado e casado, mas sem publish_date — pulado`);
      continue;
    }
    // #4919: alinhado por índice com `matched` — ver docstring do campo.
    // Spread condicional (não `primarySourceUrls: undefined`): o campo
    // precisa ficar de fato AUSENTE do objeto (não presente com valor
    // undefined) — `JSON.stringify` trataria os dois casos igual na
    // serialização, mas testes com `assert.deepStrictEqual` sobre o objeto
    // em memória, não.
    const primarySourceUrls = computePrimarySourceUrls(post, matched, destaques);
    rows.push({
      date,
      editionSlug: post.slug,
      url: `https://diar.ia.br/p/${post.slug}`,
      matchedHeadlines: matched,
      ...(primarySourceUrls ? { primarySourceUrls } : {}),
      // #4918 Conserto 2, "caminho ideal": `post.title` já está em escopo
      // (usado acima pra montar `destaques`) — guardar aqui em vez de
      // descartar depois de casar o pattern.
      editionTitle: post.title || undefined,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows, warnings };
}

/**
 * Lê a camada de leitura unificada Beehiiv + Kit (#6187/#6184 —
 * `scripts/lib/shared/edition-cache-reader.ts`), ordenada por data. Antes
 * lia só `data/beehiiv-cache/posts/*.json` diretamente; migrado pra
 * `loadUnifiedEditionCache` pra que todo consumidor pendurado nisto
 * (`scripts/lib/hub-staleness-check.ts`, `corpus-index-coverage-report.ts`,
 * `regenerate-entity-pages.ts` e, transitivamente, `lib/entities/*.ts` +
 * `lib/shared/entity-page.ts`) passe a ver edições publicadas no Kit
 * automaticamente, sem precisar de mudança própria em nenhum deles — é
 * exatamente o ponto da camada unificada (achado central do #6187: o cache
 * é híbrido permanente, não uma migração transitória).
 *
 * `UnifiedCachedPost` é estruturalmente compatível com `RawCachedPost`
 * (mesmos nomes de campo) — o cast é seguro, não um `as unknown as`.
 *
 * Continua lançando se `data/beehiiv-cache/posts/` (fonte primária hoje)
 * estiver ausente — mesmo comportamento de antes; um cache Kit ainda
 * ausente (`data/kit-cache/broadcasts/`, nenhum `kit-sync.ts` escreve nele
 * ainda) nunca lança, só contribui 0 edições.
 */
export function loadPosts(): RawCachedPost[] {
  return loadUnifiedEditionCache() as RawCachedPost[];
}

const TITLES_CACHE_PATH = resolve(ROOT, "workers/arquivo/src/titles-cache.json");

export interface TitlesCacheEntry {
  title: string;
  publishDate: string;
}

/** Lê `workers/arquivo/src/titles-cache.json` (COMMITADO, gerado por
 * `generate-arquivo-titles.ts` — que sim exige o junction `data/`). Usado só
 * como FALLBACK por `backfillEditionTitles` — fail-soft: cache ausente ou
 * malformado devolve `{}` (backfill vira no-op, nunca aborta). */
export function loadTitlesCache(path: string = TITLES_CACHE_PATH): Record<string, TitlesCacheEntry> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, TitlesCacheEntry>;
  } catch (e) {
    process.stderr.write(
      `[generate-hub-sources] ⚠ falha ao parsear ${path}: ${e instanceof Error ? e.message : e} — seguindo sem cache de títulos\n`,
    );
    return {};
  }
}

/**
 * Pure: preenche `editionTitle` das linhas que ainda não têm, casando
 * `editionSlug` contra `titlesCache` (#4918 Conserto 2, "caminho barato" —
 * roda sem o junction `data/`, porque tanto `rows` quanto `titlesCache`
 * já são commitados no repo). Linha que já tem `editionTitle` (caminho
 * ideal já rodou) não é sobrescrita. Linha sem entrada correspondente no
 * cache fica como estava — sem `editionTitle`, o renderer cai no rótulo
 * antigo (fallback, ver `sourceEditionLabel` em `hub-page.ts`).
 */
export function backfillEditionTitles(
  rows: readonly HubSourceEntry[],
  titlesCache: Record<string, TitlesCacheEntry>,
): HubSourceEntry[] {
  return rows.map((row) => (row.editionTitle ? row : { ...row, editionTitle: titlesCache[row.editionSlug]?.title }));
}

/** Diff por `editionSlug` entre o que já está em `outPath` (commitado) e o
 * que seria gravado agora — usado só pelo modo `--dry-run` (#5203) pra
 * imprimir preview sem tocar disco. Pure: recebe os dois arrays já
 * carregados, não lê nada. Exportado pra teste isolado do cálculo do diff,
 * sem precisar de fixture de arquivo. */
/**
 * Reinjeta as entradas `manual: true` do JSON já commitado que a coleta
 * fresca não redescobriu (#5125) — ver `HubSourceEntry.manual`. Pure.
 *
 * Merge por `editionSlug`: entrada que o pattern REDESCOBRIU fica com a
 * versão fresca (a coleta é a fonte de verdade quando as duas existem), mas
 * herda o `manual: true` pra não perder a marcação no round-trip. O
 * resultado sai ordenado por `date` crescente e SÓ por `date` — exatamente o
 * critério de `collectHubSources` (`rows.sort` acima, sem desempate). Um
 * desempate extra (por slug, digamos) reordenaria entradas de mesma data em
 * relação à coleta e faria todo regen produzir um diff espúrio. `Array#sort`
 * é estável desde ES2019, então as entradas manuais reinjetadas caem depois
 * das coletadas de mesma data, de forma determinística.
 */
export function mergeManualHubSources(
  existing: readonly HubSourceEntry[],
  collected: readonly HubSourceEntry[],
): HubSourceEntry[] {
  const manualBySlug = new Map(
    existing.filter((r) => r.manual === true).map((r) => [r.editionSlug, r]),
  );
  if (manualBySlug.size === 0) return [...collected];

  const collectedSlugs = new Set(collected.map((r) => r.editionSlug));
  const merged: HubSourceEntry[] = collected.map((r) =>
    manualBySlug.has(r.editionSlug) ? { ...r, manual: true as const } : r,
  );
  for (const [slug, row] of manualBySlug) {
    if (!collectedSlugs.has(slug)) merged.push(row);
  }
  return merged.sort((a, b) => a.date.localeCompare(b.date));
}

export function computeHubSourcesDiff(
  oldRows: readonly HubSourceEntry[],
  newRows: readonly HubSourceEntry[],
): { added: string[]; removed: string[]; changed: string[]; unchanged: number } {
  const oldMap = new Map(oldRows.map((r) => [r.editionSlug, r]));
  const newMap = new Map(newRows.map((r) => [r.editionSlug, r]));
  const added: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const [slug, row] of newMap) {
    const old = oldMap.get(slug);
    if (!old) added.push(slug);
    else if (JSON.stringify(old) !== JSON.stringify(row)) changed.push(slug);
    else unchanged++;
  }
  const removed = [...oldMap.keys()].filter((slug) => !newMap.has(slug));
  return { added, removed, changed, unchanged };
}

/** Grava `rows` em `outPath` (via `writeFileAtomic`) — ou, em `--dry-run`,
 * só imprime o resumo do diff contra o conteúdo já commitado e NÃO toca
 * disco (#5203). Compartilhado entre o fluxo normal e `--backfill-titles`,
 * os dois pontos que hoje chamam `writeFileAtomic` neste arquivo. Exportado
 * pra teste (verificar que `dryRun: true` de fato não muda o arquivo). */
export function writeGeneratedHubSources(
  outPath: string,
  rows: readonly HubSourceEntry[],
  opts: { dryRun: boolean },
): void {
  if (!opts.dryRun) {
    writeFileAtomic(outPath, `${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  const existing: HubSourceEntry[] = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, "utf8")) as HubSourceEntry[])
    : [];
  const diff = computeHubSourcesDiff(existing, rows);
  process.stderr.write(
    `[generate-hub-sources] [dry-run] ${outPath}: ${rows.length} linha(s) totais — ${diff.added.length} nova(s), ${diff.changed.length} alterada(s), ${diff.removed.length} removida(s), ${diff.unchanged} sem mudança. NADA foi escrito (--dry-run).\n`,
  );
  if (diff.added.length > 0) {
    process.stderr.write(`[generate-hub-sources] [dry-run]   + ${diff.added.join(", ")}\n`);
  }
  if (diff.changed.length > 0) {
    process.stderr.write(`[generate-hub-sources] [dry-run]   ~ ${diff.changed.join(", ")}\n`);
  }
  if (diff.removed.length > 0) {
    process.stderr.write(`[generate-hub-sources] [dry-run]   - ${diff.removed.join(", ")}\n`);
  }
}

function runBackfillTitles(hub: string, opts: { dryRun: boolean }): void {
  const path = resolve(HUBS_DIR, `${hub}-sources.generated.json`);
  if (!existsSync(path)) {
    console.error(`[generate-hub-sources] ${path} não existe — rode sem --backfill-titles primeiro`);
    process.exit(2);
  }
  const rows = JSON.parse(readFileSync(path, "utf8")) as HubSourceEntry[];
  const titlesCache = loadTitlesCache();
  const filled = backfillEditionTitles(rows, titlesCache);
  const before = rows.filter((r) => r.editionTitle).length;
  const after = filled.filter((r) => r.editionTitle).length;
  writeGeneratedHubSources(path, filled, opts);
  if (!opts.dryRun) {
    process.stderr.write(
      `[generate-hub-sources] ${hub}: editionTitle preenchido em ${after}/${filled.length} (${after - before} novos via titles-cache.json) -> ${path}\n`,
    );
  }
  console.log(path);
}

/** Fluxo normal (precisa do junction `data/`, ver `loadPosts`): coleta,
 * loga warnings, e grava (ou, em `--dry-run`, só previsualiza) o JSON do
 * hub. Extraído de `main()` pra dar nome ao que o comentário do pattern
 * `brasil-regulacao` acima já referenciava como `runGenerate`. */
function runGenerate(hub: string, opts: { dryRun: boolean }, posts?: RawCachedPost[]): void {
  const loaded = posts ?? loadPosts();
  const { rows: collected, warnings } = collectHubSources(loaded, HUB_KEYWORD_PATTERNS[hub]);
  for (const w of warnings) process.stderr.write(`[generate-hub-sources] ⚠ ${w}\n`);
  const outPath = resolve(HUBS_DIR, `${hub}-sources.generated.json`);
  // #5125: entradas `manual: true` do JSON commitado sobrevivem ao regen —
  // sem isso a sobrescrita sem merge apaga curadoria em silêncio (era o caso
  // de 3 entradas de `brasil-regulacao`, das quais só 2 estavam documentadas).
  const existing: HubSourceEntry[] = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, "utf8")) as HubSourceEntry[])
    : [];
  const rows = mergeManualHubSources(existing, collected);
  const preserved = rows.length - collected.length;
  if (preserved > 0) {
    process.stderr.write(
      `[generate-hub-sources] ${hub}: ${preserved} entrada(s) manual(is) preservada(s) (campo "manual": true).\n`,
    );
  }
  writeGeneratedHubSources(outPath, rows, opts);
  if (!opts.dryRun) {
    process.stderr.write(`[generate-hub-sources] ${hub}: ${rows.length} edições -> ${outPath}\n`);
  }
  console.log(outPath);
}

function main(): void {
  const argv = process.argv.slice(2);
  const all = argv.includes("--all");
  const hubIdx = argv.indexOf("--hub");
  const hubArg = hubIdx >= 0 ? argv[hubIdx + 1] : undefined;
  const dryRun = argv.includes("--dry-run");

  // `--all` (#5125): regenera TODOS os hubs numa invocação, carregando o
  // corpus UMA vez só (`loadPosts` lê ~250 arquivos JSON do junction `data/`;
  // 7 invocações separadas pagavam essa leitura 7×). Invocação MANUAL — não
  // está ligado a nenhuma task agendada, ver a nota do módulo sobre
  // `UPDATED_DATE`/#6267. Incompatível com `--backfill-titles`, que é um
  // modo de reparo por hub.
  if (all) {
    if (argv.includes("--backfill-titles")) {
      console.error("[generate-hub-sources] --all não combina com --backfill-titles (modo por hub).");
      process.exit(2);
    }
    const posts = loadPosts();
    for (const slug of Object.keys(HUB_KEYWORD_PATTERNS)) {
      runGenerate(slug, { dryRun }, posts);
    }
    return;
  }

  if (!hubArg || !(hubArg in HUB_KEYWORD_PATTERNS)) {
    console.error(
      `[generate-hub-sources] --hub obrigatório (ou --all), um de: ${Object.keys(HUB_KEYWORD_PATTERNS).join(", ")}`,
    );
    process.exit(2);
    return;
  }
  const hub: string = hubArg;

  // #4918 Conserto 2, "caminho barato": preenche `editionTitle` no JSON já
  // commitado a partir de `titles-cache.json` (também commitado) — NÃO
  // precisa do junction `data/`, roda em sessão cloud. Modo separado do
  // fluxo normal (que precisa de `data/beehiiv-cache/posts` via
  // `loadUnifiedEditionCache`, ver `loadPosts` abaixo) — sai antes de
  // checar o cache.
  if (argv.includes("--backfill-titles")) {
    runBackfillTitles(hub, { dryRun });
    return;
  }

  runGenerate(hub, { dryRun });
}

if (isMainModule(import.meta.url)) {
  main();
}
