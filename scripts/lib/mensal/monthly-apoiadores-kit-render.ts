/**
 * scripts/lib/mensal/monthly-apoiadores-kit-render.ts (#7633)
 *
 * Variante KIT do envio extra pra apoiadores Mantenedor/Patrono — sucessora
 * de `monthly-apoiadores-brevo-render.ts` (#4593), que por sua vez sucedeu o
 * módulo Beehiiv do #4482. É o TERCEIRO canal da mesma audiência e do mesmo
 * conteúdo. O Beehiiv nunca saiu do papel (bloqueio de plano, #4572); o Brevo
 * enviou 1 edição (ciclo 2607-08, 04/08/2026, 10 entregues — #7655).
 *
 * ## Por que trocar de novo — e por que não é "mais um pivot"
 *
 * A troca anterior foi forçada por bloqueio de plataforma. Esta é
 * consolidação: `publishing.newsletter.backend` virou `"kit"` (#7388), a base
 * inteira migrou da Beehiiv (#7386, 317 → 0 ativos) e a anual já nasceu no
 * Kit (#7569). Manter a Brevo viva só pro envio de apoiadores significaria um
 * 2º ESP, um 2º sync de audiência e um 2º formato de merge tag pra manter —
 * custo recorrente para 1 envio a cada ciclo, numa audiência que já está
 * inteira do lado do Kit.
 *
 * ## O que muda em relação ao perfil Brevo (e é TUDO que muda)
 *
 * 1. **Merge tag do voto do "É IA?"** — o Kit usa Liquid próprio,
 *    `{{ subscriber.email_address }}` (confirmado ao vivo no #464, ver
 *    `scripts/lib/kit-broadcasts.ts`), não o `{{ contact.EMAIL }}` da Brevo.
 *    Errar isso é reproduzir o bug do #4510 (100% dos votos daquele canal
 *    chegando com a string literal, rejeitada por `isValidVoteEmailFormat`) —
 *    por isso `MonthlyUtmProfile.pollMergeTag` é uma union fechada, e o campo
 *    é a razão principal deste módulo existir em vez de reusar o perfil Brevo.
 * 2. **`utm_source`** — `mensal-apoiadores-kit`, próprio (ver
 *    `MENSAL_APOIADORES_KIT_UTM_SOURCE` em `shared/utm-registry.ts`).
 * 3. **`pollBrand`** — `mensal-apoiadores-kit`, registrado em `BRAND_INFO`
 *    (`workers/poll/src/lib.ts`) com `leaderboardPeriod: "year"`. Esse
 *    `"year"` NÃO é cosmético: o worker rejeita (400) edição em formato de
 *    ciclo pra brand com leaderboard mensal, então um brand novo mal
 *    configurado quebraria todo voto deste envio — mesma armadilha que o
 *    #4510 documentou pro `mensal-beehiiv`.
 *
 * O resto — filtro de seções Clarice-only, imagens, relink pra edição diária
 * — é idêntico e reusado sem modificação (`filterDraftForApoiadores`,
 * `draftToEmail`), pelo mesmo racional do #4593: são funções sobre CONTEÚDO,
 * sem nada de ESP na forma.
 */
import { draftToEmail, splitByLabels, normalizeLabel, type MonthlyUtmProfile } from "./monthly-render.ts";
import { filterDraftForApoiadores } from "./monthly-draft-filter.ts";
import {
  MENSAL_APOIADORES_KIT_UTM_SOURCE,
  MENSAL_APOIADORES_KIT_UTM_MEDIUM,
  buildMensalApoiadoresKitCampaign,
} from "../shared/utm-registry.ts";

/**
 * Perfil de UTM da variante Kit do envio apoiadores (#7633) — ver docstring
 * do módulo pros 3 campos que diferem do perfil Brevo e por que cada um
 * importa.
 */
export const APOIADORES_KIT_UTM_PROFILE: MonthlyUtmProfile = {
  source: MENSAL_APOIADORES_KIT_UTM_SOURCE,
  medium: MENSAL_APOIADORES_KIT_UTM_MEDIUM,
  buildCampaign: buildMensalApoiadoresKitCampaign,
  // Kit, não Brevo — Liquid próprio (#464). Trocar isto por
  // "{{ contact.EMAIL }}" quebra 100% dos votos deste canal (#4510).
  pollMergeTag: "{{ subscriber.email_address }}",
  pollBrand: "mensal-apoiadores-kit",
};

/**
 * Render completo da variante Kit apoiadores (#7633): filtra o draft
 * (`filterDraftForApoiadores`, reusado sem modificação) e chama o MESMO
 * `draftToEmail` do envio Clarice, só trocando o `utmProfile`. Assinatura
 * idêntica à de `draftToEmailApoiadoresBrevo` de propósito — os dois consomem
 * as MESMAS URLs de imagem já publicadas pelo pipeline Clarice do ciclo (sem
 * upload duplicado).
 */
export function draftToEmailApoiadoresKit(
  draft: string,
  chosenSubject: string | null,
  yymm: string,
  eiaImageUrlA?: string,
  eiaImageUrlB?: string,
  eiaCredit?: string,
  destaqueImageUrls?: Record<number, string>,
  destaqueImageCaption?: string,
  livrosImageUrl?: string,
  eiaPrevResultLine?: string | null,
): { subject: string; previewText: string; html: string } {
  const filtered = filterDraftForApoiadores(draft);
  return draftToEmail(
    filtered,
    chosenSubject,
    yymm,
    eiaImageUrlA,
    eiaImageUrlB,
    eiaCredit,
    destaqueImageUrls,
    destaqueImageCaption,
    livrosImageUrl,
    eiaPrevResultLine,
    APOIADORES_KIT_UTM_PROFILE,
  );
}

// ── Subject próprio (#7867 item 3) ──────────────────────────────────────
//
// Até aqui o canal herdava `_internal/02-chosen-subject.txt`, compartilhado
// com o envio Clarice — cujo formato é `diar.ia.br | {Mês} {Ano} — {ângulo}`,
// pensado pro produto Clarice, não pro produto "Retrospectiva do Mês" que
// este canal vende aos apoiadores Mantenedor/Patrono. Editor reescreveu à
// mão no painel do Kit em 2608-09 exatamente por esse descompasso.
//
// Formato novo, gerado sem depender do arquivo compartilhado:
// "Retrospectiva de {mês}: {título do Destaque 1}".

const PT_BR_MONTH_NAMES_LOWER = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

/**
 * Extrai só o TÍTULO (o H2 que `renderDestaque` monta) do destaque `n` do
 * draft, sem montar HTML — usado exclusivamente pela derivação de subject
 * abaixo. Não é o parser canônico do render (esse é `renderDestaque` em
 * `monthly-render.ts`, que faz a mesma extração como parte de montar o
 * bloco completo); duplicar aqui as ~5 linhas de extração de título evita
 * acoplar a derivação de subject à assinatura de `renderDestaque` (que
 * devolve HTML pronto, não a string do título isolada).
 */
export function extractDestaqueTitle(draft: string, n: number): string | null {
  const sections = splitByLabels(draft.replace(/\r\n/g, "\n"));
  for (const raw of sections) {
    const chunk = raw.trim();
    if (!chunk) continue;
    const lines = chunk.split("\n");
    const label = normalizeLabel(lines[0]);
    if (!new RegExp(`^DESTAQUE\\s+${n}\\b`).test(label)) continue;
    let i = 1;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) return null;
    const title = lines[i]
      .trim()
      .replace(/^\*\*+/, "")
      .replace(/\*\*+$/, "")
      .trim();
    return title || null;
  }
  return null;
}

/**
 * Deriva o subject próprio deste canal (#7867 item 3) — nunca lê
 * `02-chosen-subject.txt`. "{tema}" vem do TÍTULO do Destaque 1 (a frase
 * editorial completa), não do rótulo curto de kicker ("BRASIL", "AGENTES")
 * — um kicker sozinho ("Retrospectiva de agosto: AGENTES") é ruim como
 * subject; o título já é a frase pensada pra atrair clique.
 *
 * Lança se o Destaque 1 não puder ser localizado no draft (mês inválido, ou
 * draft sem seção `DESTAQUE 1`) — um subject vazio/genérico num canal pago
 * não é caso pra fallback silencioso. Se o D1 der subject ruim com
 * frequência, é decisão de produto do editor (documentado na issue #7867),
 * não algo pra este código truncar/reescrever sozinho.
 */
export function deriveApoiadoresKitSubject(draft: string, yymm: string): string {
  const mm = Number(yymm.slice(2, 4));
  const monthName = PT_BR_MONTH_NAMES_LOWER[mm - 1];
  if (!monthName) {
    throw new Error(`deriveApoiadoresKitSubject: yymm inválido "${yymm}" — não deriva mês por extenso.`);
  }
  const title = extractDestaqueTitle(draft, 1);
  if (!title) {
    throw new Error(
      "deriveApoiadoresKitSubject: não encontrei o título do Destaque 1 no draft — sem ele não há subject " +
        'seguro a gerar (nunca cai num fallback silencioso num canal pago). Confira se o draft tem a seção ' +
        '"DESTAQUE 1 | ..." com o título na linha seguinte ao header.',
    );
  }
  return `Retrospectiva de ${monthName}: ${title}`;
}
