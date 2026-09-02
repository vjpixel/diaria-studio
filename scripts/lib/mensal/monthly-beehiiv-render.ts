/**
 * scripts/lib/mensal/monthly-beehiiv-render.ts (#4482)
 *
 * Variante BEEHIIV do digest mensal: MESMO `draft.md` do envio Clarice/Brevo
 * (destaques temáticos + Use Melhor + Radar + É IA?, #2795) — só a AUDIÊNCIA
 * muda. Segue o precedente arquitetural de `scripts/lib/newsletter-patronos.ts`
 * (#4275, box-swapping por audiência na DIÁRIA): mesmo conteúdo editorial,
 * seleção de blocos + UTM diferentes por quem recebe — não um pipeline novo.
 *
 * ## As 5 decisões (issue #4482, sessão develop 260802b/260803) — 4 do
 * editor + 1 default sem objeção (#4510: a decisão 5 abaixo nunca foi
 * perguntada explicitamente ao editor, só sugerida pelo coordenador; o
 * comentário do coordenador na própria issue #4482 já registra essa
 * distinção corretamente — este docstring e o SKILL.md é que
 * superclaimavam "5 decisões do editor" como se as 5 tivessem o mesmo peso)
 *
 *   1. Cadência: envio EXTRA (não substitui a diária), num dia sem edição
 *      diária pesada.
 *   2. Segmento: só apoiadores Mantenedor OU Patrono (Beehiiv) — não a base
 *      inteira, não reativação de inativos.
 *   3. Escopo Clarice: remove `APRESENTAÇÃO`/`CLARICE — DIVULGAÇÃO`/
 *      `CLARICE — TUTORIAL` sem substituir por nada — espaço reservado fica
 *      vazio. (A APRESENTAÇÃO entra no mesmo corte: seu boilerplate presume
 *      "você se cadastrou na Clarice", falso pra quem já é assinante Beehiiv
 *      da diária — ver escopo técnico do #4482.)
 *   4. Plataforma: Beehiiv (mesma da diária) — publicação reusa
 *      `context/publishers/beehiiv-playbook.md` (Worker-hosted paste), NUNCA
 *      `publish-monthly.ts`/`clarice-schedule-sends` (específicos do Brevo).
 *   5. Ordem no ciclo (NÃO perguntado explicitamente — default sugerido pelo
 *      coordenador, sem objeção do editor): depois do conteúdo do mês estar
 *      100% finalizado — não precisa coincidir com nenhuma onda
 *      `{conteúdo}-{envio}` da Clarice, é um canal de audiência totalmente
 *      separado.
 *
 * ## Por que preprocessar o MARKDOWN, não duplicar o render HTML
 *
 * `draftToEmail` (monthly-render.ts) é o dispatch por label inteiro — várias
 * centenas de linhas cobrindo TODOS os formatos de seção. Duplicá-lo pra uma
 * 2ª variante criaria drift garantido a cada mudança de seção futura. Em vez
 * disso, `filterDraftForBeehiiv` remove as seções/blocos indesejados NO
 * MARKDOWN antes de chamar o `draftToEmail` real (inalterado) — a variante
 * Beehiiv sempre acompanha qualquer mudança de render feita pra Clarice
 * automaticamente, sem duplicação de lógica de render.
 *
 * ## #7121 (260902) — canal Beehiiv esvaziado, este módulo agora é infra
 * COMPARTILHADA da variante Brevo (não Beehiiv)
 *
 * A Beehiiv nunca enviou nada ao vivo pra este canal (bloqueada atrás do
 * plano Scale, #4572) — o canal migrou pra Brevo (#4572/#4593). `draftToEmailBeehiiv`
 * e `BEEHIIV_UTM_PROFILE` (o dispatch + UTM ESPECÍFICOS da variante Beehiiv)
 * foram removidos por não terem consumidor de runtime. O que sobra aqui
 * (`filterDraftForBeehiiv`/`isClariceOnlySection`/`stripRecomendacaoDiariaBlock`)
 * é canal-AGNÓSTICO — filtra o markdown, não decide UTM/perfil — e é
 * IMPORTADO POR VALOR pelo caminho Brevo REAL
 * (`scripts/lib/mensal/monthly-apoiadores-brevo-render.ts` importa
 * `filterDraftForBeehiiv` daqui sem modificação). O nome do arquivo/módulo
 * ficou historicamente "beehiiv" — não renomeado nesta unidade pra manter o
 * diff pequeno e revisável (ver PR #7121); `filterDraftForBeehiiv`/
 * `isClariceOnlySection` continuam corretos em comportamento, só
 * enganosos em nome.
 *
 * ## Segmentação — sem lógica de cruzamento nova
 *
 * Os segmentos "Apoio — Mantenedor" e "Apoio — Patrono" já existem na conta
 * Brevo dedicada (`platform.config.json` → `brevo_apoiadores`), convergidos
 * por `scripts/sync-apoio-nivel-brevo.ts` (#4572, ver
 * `scripts/lib/apoio-segments-canonical.ts`). Este módulo NÃO recalcula
 * "quem é apoiador" — o envio mira a lista já convergida.
 */
import { splitByLabels, normalizeLabel } from "./monthly-render.ts";

/**
 * Título EXATO da 1ª linha do box de recomendação da diária
 * (`data/snippets/diaria-recomendacao-clarice.md`), colado manualmente
 * pelo editor em `draft.md` entre destaques (isolado por `---`, sem label de
 * seção própria — ver docstring do snippet). Detectado por essa linha pra
 * ser removido na variante Beehiiv: recomendar a edição DIÁRIA pra quem JÁ é
 * assinante Beehiiv dela (audiência desta variante = apoiadores, que também
 * são assinantes ativos da diária) não faz sentido — é a mesma peça, mesma
 * conclusão do escopo técnico do #4482 pras seções `CLARICE — *`.
 */
const RECOMENDACAO_DIARIA_TITLE = "Recomendação da equipe da Clarice";

/**
 * `true` quando o LABEL normalizado (`normalizeLabel`) de uma seção é
 * conteúdo exclusivo da audiência Clarice — removido por inteiro (label +
 * corpo), sem substituição, na variante Beehiiv (decisão 3 do #4482):
 * `APRESENTAÇÃO` (boilerplate "você se cadastrou na Clarice", falso pra esta
 * audiência) e qualquer seção `CLARICE — *` (DIVULGAÇÃO, TUTORIAL — inventário
 * do produto Clarice, redundante pra quem já é leitor da diária).
 *
 * #4510 (achado comment-analyzer, review pré-merge): só a forma canônica com
 * EM-DASH (`—`, U+2014) é reconhecida — de propósito, não por descuido. O
 * parser real que decide onde uma seção COMEÇA (`isSectionLabel`/
 * `splitByLabels`, `monthly-render.ts`) só reconhece `CLARICE —` com esse
 * caractere; um header escrito com hífen ASCII (`CLARICE - DIVULGAÇÃO`)
 * NUNCA vira boundary de seção pra `splitByLabels` — o texto inteiro é
 * absorvido como corpo da seção ANTERIOR, e esta função nunca chega a ser
 * chamada com esse label (`firstLine` de um chunk nunca é essa linha).
 * Um branch aqui aceitando hífen ASCII seria código morto (nunca dispara via
 * `filterDraftForBeehiiv`) — a versão antiga deste comentário chegou a
 * alegar "nenhum risco de discordância" entre este helper e o parser real,
 * o que SUBESTIMAVA o risco de verdade: a garantia desta função é limitada à
 * forma canônica; um `CLARICE - DIVULGAÇÃO` em hífen ASCII vaza inteiro
 * (conteúdo Clarice-only, incluindo "você se cadastrou na Clarice") no email
 * Beehiiv, sem passar por aqui — ver teste de integração em
 * `test/monthly-beehiiv-render.test.ts` que prova esse comportamento real
 * ponta a ponta via `filterDraftForBeehiiv`. Alinhar `isSectionLabel` pra
 * aceitar as duas formas de traço (opção B, não escolhida aqui) exigiria
 * mexer em código compartilhado com o caminho Clarice — risco maior que o
 * ganho pra um caso que o template/editor não produz hoje (o vocabulário
 * fixo é sempre em-dash). @pure
 */
export function isClariceOnlySection(label: string): boolean {
  return label === "APRESENTAÇÃO" || label === "APRESENTACAO" || label.startsWith("CLARICE —");
}

/**
 * #4510: quantos parágrafos APÓS o título ainda contam como "dentro do
 * bloco" antes de desistir de achar o CTA. O bloco real tem 2 (corpo + CTA
 * `→ [...]`) — a folga de 4 tolera um corpo dividido em mais de 1 parágrafo
 * entre revisões do snippet fonte, sem deixar a janela crescer sem limite.
 */
const RECOMENDACAO_MAX_PARAS_AFTER_TITLE = 4;

/**
 * Remove o bloco "Recomendação da equipe da Clarice" (colado manualmente,
 * sem label de seção própria — ver `RECOMENDACAO_DIARIA_TITLE` acima) do
 * corpo de UMA seção, se presente. O bloco tem 3 parágrafos contíguos
 * (título / corpo / CTA `→ [...]`, separados por linha em branco — ver o
 * snippet fonte): remove do parágrafo de título até o CTA (inclusive),
 * tolerando o corpo variar de tamanho entre revisões do snippet — mas só até
 * `RECOMENDACAO_MAX_PARAS_AFTER_TITLE` parágrafos depois do título.
 *
 * #4510 (achado comment-analyzer + silent-failure-hunter, review pré-merge):
 * ANTES desta janela, o título batendo entrava num estado `skipping = true`
 * incondicional — se o CTA nunca aparecesse (formato do bloco mudou, ou o
 * bloco foi colado truncado), a função descartava TODO parágrafo restante
 * da seção, não só o bloco de 3 parágrafos pretendido. Isso é perda
 * silenciosa de conteúdo real do destaque, o oposto do que "fail-soft"
 * deveria significar. Agora, se a janela esgota sem achar o CTA (ou o draft
 * termina no meio do bloco), os parágrafos bufferizados voltam INTACTOS pro
 * output em vez de serem descartados — fail-soft de verdade: no pior caso
 * (bloco de formato desconhecido), o texto sai como entrou.
 *
 * Pure. Idempotente — chamar 2x não remove nada a mais na 2ª vez (o título
 * não aparece mais depois da 1ª remoção bem-sucedida).
 */
export function stripRecomendacaoDiariaBlock(sectionBody: string): string {
  const paras = sectionBody.split(/\n\n+/);
  const out: string[] = [];
  let buffered: string[] | null = null; // não-null = dentro de um bloco candidato, aguardando o CTA
  for (const p of paras) {
    const trimmed = p.trim();
    if (buffered === null && trimmed === RECOMENDACAO_DIARIA_TITLE) {
      buffered = [p];
      continue;
    }
    if (buffered !== null) {
      buffered.push(p);
      if (trimmed.startsWith("→")) {
        // CTA fecha o bloco — descarta o buffer inteiro de vez.
        buffered = null;
        continue;
      }
      if (buffered.length - 1 >= RECOMENDACAO_MAX_PARAS_AFTER_TITLE) {
        // Janela esgotada sem achar o CTA — não é o bloco esperado (ou está
        // truncado). Devolve os parágrafos bufferizados intactos.
        out.push(...buffered);
        buffered = null;
      }
      continue;
    }
    out.push(p);
  }
  // Draft termina no meio do bloco (título capturado, CTA nunca veio, janela
  // ainda não esgotada) — mesmo racional: devolve intacto em vez de descartar.
  if (buffered) out.push(...buffered);
  return out.join("\n\n");
}

/**
 * Preprocessa `draft.md` (o MESMO arquivo usado pelo envio Clarice) pra
 * variante Beehiiv (#4482, decisão 3): remove por inteiro as seções
 * `APRESENTAÇÃO`/`CLARICE — *` (sem substituição) e o box "Recomendação da
 * equipe da Clarice" quando colado dentro de outra seção (ex.: entre
 * destaques). Reusa `splitByLabels`/`normalizeLabel` de `monthly-render.ts`
 * — mesmo parser que `draftToEmail` usa internamente, então o resultado
 * sempre bate com o que o render real reconhece como seção (nenhum risco de
 * o filtro e o render discordarem sobre onde uma seção começa/termina).
 *
 * Pure, fail-soft: um draft sem nenhuma seção/bloco Clarice volta
 * essencialmente intocado (só normaliza `\r\n` e rejunta com `\n\n---\n\n`,
 * que `splitByLabels` já trata como separador opcional no lado do render).
 */
export function filterDraftForBeehiiv(draft: string): string {
  const text = draft.replace(/\r\n/g, "\n");
  const sections = splitByLabels(text);
  const kept: string[] = [];
  for (const chunk of sections) {
    const firstLine = chunk.split("\n")[0]?.trim() ?? "";
    const label = normalizeLabel(firstLine);
    if (isClariceOnlySection(label)) continue;

    const body = chunk.split("\n").slice(1).join("\n");
    const cleanedBody = stripRecomendacaoDiariaBlock(body).trim();
    kept.push(cleanedBody ? `${firstLine}\n\n${cleanedBody}` : firstLine);
  }
  return kept.join("\n\n---\n\n");
}
