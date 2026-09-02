/**
 * scripts/lib/mensal/monthly-apoiadores-brevo-render.ts (#4593)
 *
 * Variante BREVO do envio extra pra apoiadores Mantenedor/Patrono —
 * sucessora de `scripts/lib/mensal/monthly-beehiiv-render.ts` (#4482), que
 * nunca chegou a enviar ao vivo: a Beehiiv bloqueia "Include and exclude
 * segments" atrás do plano Scale (workspace é Launch/free, confirmado ao
 * vivo 260804, #4572). Decisão do editor: trocar o CANAL pra Brevo (mesma
 * conta usada por `scripts/publish-daily-brevo.ts`/`brevo_diaria`), mantendo
 * conteúdo/audiência (só Mantenedor/Patrono, #4482 decisão 2) inalterados.
 *
 * ## Decisão do #4593 item 2 — perfil UTM NOVO, não rename (opção b)
 *
 * A issue #4593 propôs 2 rotas: (a) renomear `BEEHIIV_UTM_PROFILE`/
 * `draftToEmailBeehiiv` (monthly-beehiiv-render.ts) pra refletir o canal real,
 * ou (b) introduzir um perfil Brevo-específico NOVO, dedicado, sem tocar nos
 * exports existentes. Esta unidade escolhe (b), por 3 motivos concretos
 * (não só "menor risco" em abstrato):
 *
 *   1. **Formato de merge tag INCOMPATÍVEL entre as duas plataformas.**
 *      `BEEHIIV_UTM_PROFILE.pollMergeTag === "{{email}}"` (sintaxe Beehiiv) —
 *      reusar esse perfil pro envio Brevo geraria um merge tag que a Brevo
 *      NUNCA substitui (ela espera `{{ contact.EMAIL }}`, mustache com
 *      namespace `contact.`). Renomear o export não resolveria isso: o
 *      PROBLEMA é o valor do campo, não o nome do símbolo. Precisaríamos de
 *      um objeto com valores DIFERENTES de qualquer jeito — a única pergunta
 *      é se esse objeto novo fica com nome novo (opção b, aqui) ou substitui
 *      o antigo com nome trocado (opção a). Um valor de campo tipado como
 *      union fechada (`"{{email}}" | "{{ contact.EMAIL }}"`,
 *      `MonthlyUtmProfile.pollMergeTag`) que muda de "{{email}}" pra
 *      "{{ contact.EMAIL }}" JÁ é, na prática, um perfil novo — só a
 *      etiqueta que mudaria com (a).
 *   2. **Zero consumidor de produção depende do rename.** `grep -rn
 *      "BEEHIIV_UTM_PROFILE\|draftToEmailBeehiiv\|CLARICE_UTM_PROFILE"`
 *      mostra que os únicos consumidores de `BEEHIIV_UTM_PROFILE`/
 *      `draftToEmailBeehiiv` são `scripts/render-monthly-beehiiv.ts` e os
 *      próprios testes do #4482/#4510 (`monthly-beehiiv-render.test.ts`,
 *      `render-monthly-beehiiv.test.ts`) — nenhum caminho de ENVIO REAL EM
 *      PRODUÇÃO os usa (o envio Beehiiv nunca saiu do estágio de draft órfão
 *      criado manualmente durante o teste ao vivo do #4572). `CLARICE_UTM_PROFILE`
 *      (envio mensal Clarice REAL, em produção) mora em `monthly-render.ts`,
 *      um arquivo TOTALMENTE separado, e não é tocado por nenhuma das duas
 *      opções — confirmado por este mesmo grep. Ou seja: renomear
 *      `BEEHIIV_UTM_PROFILE` não teria custo de regressão em produção (nada
 *      real depende dele), mas TAMBÉM não teria BENEFÍCIO de produção — só
 *      cosmético. Introduzir um perfil novo aqui tem o mesmo custo (zero
 *      risco de regressão) com a vantagem de preservar o histórico completo
 *      do #4482/#4510 (comentários/testes que documentam o pivot de canal
 *      Beehiiv, incluindo a lição do #4510 sobre merge tag por ESP) sem
 *      reescrevê-lo por cima.
 *   3. **`pollBrand` precisa ser um valor NOVO de qualquer forma.** O
 *      leaderboard do "É IA?" isola votos por `brand` (`workers/poll/src/lib.ts`,
 *      `BRAND_INFO`) — um brand por audiência+canal, pra não misturar votos
 *      de audiências diferentes no mesmo ranking (lição do #4510: antes dele,
 *      TODO envio do digest mensal, viesse da Clarice ou do Beehiiv, mandava
 *      voto pro mesmo `brand=clarice`). O envio Brevo apoiadores é uma
 *      audiência distinta de `clarice` (assinantes Clarice/Brevo regulares)
 *      E de `mensal-beehiiv` (nunca usado ao vivo) — precisa do PRÓPRIO
 *      brand (`mensal-apoiadores-brevo` abaixo) independente de qual dos 2
 *      exports antigos sobrevive com qual nome.
 *
 * Reusa `filterDraftForBeehiiv` de `monthly-beehiiv-render.ts` SEM
 * modificação: apesar do nome do módulo de origem, a função é puramente
 * sobre CONTEÚDO (remove seções `APRESENTAÇÃO`/`CLARICE — *` e o box de
 * recomendação da diária do texto) — não tem nenhuma dependência de ESP/
 * canal, e reescrever/duplicar essa lógica aqui só pra trocar o nome do
 * import seria puro custo sem ganho (mesmo racional do item 2 acima).
 */
import { draftToEmail, type MonthlyUtmProfile } from "./monthly-render.ts";
import { filterDraftForBeehiiv } from "./monthly-beehiiv-render.ts";
import {
  MENSAL_APOIADORES_BREVO_UTM_SOURCE,
  MENSAL_APOIADORES_BREVO_UTM_MEDIUM,
  buildMensalApoiadoresBrevoCampaign,
} from "../shared/utm-registry.ts";

/**
 * Perfil de UTM da variante Brevo do envio apoiadores (#4593) — passar como
 * último argumento de `draftToEmail` (ou usar `draftToEmailApoiadoresBrevo`
 * abaixo, que já injeta) pra que todo link de marca saia com
 * `utm_source=mensal-apoiadores-brevo`, e o link de voto do "É IA?" use a
 * sintaxe de merge tag CORRETA da Brevo (`{{ contact.EMAIL }}`) — mesmo
 * formato que `CLARICE_UTM_PROFILE` (`monthly-render.ts`) já usa pro envio
 * mensal Clarice regular, porque a Brevo é a MESMA plataforma nos dois casos
 * (só a lista/audiência muda). `pollBrand` isolado
 * (`"mensal-apoiadores-brevo"`) evita misturar os votos desta audiência
 * (apoiadores) com o leaderboard `clarice` (assinantes Clarice/Brevo
 * regulares) — precisa ser registrado em `workers/poll/src/lib.ts`
 * `BRAND_INFO` com `leaderboardPeriod: "year"` antes do primeiro envio real
 * (mesma exigência que o #4510 documentou pra `mensal-beehiiv`).
 */
export const APOIADORES_BREVO_UTM_PROFILE: MonthlyUtmProfile = {
  source: MENSAL_APOIADORES_BREVO_UTM_SOURCE,
  medium: MENSAL_APOIADORES_BREVO_UTM_MEDIUM,
  buildCampaign: buildMensalApoiadoresBrevoCampaign,
  // Brevo, não Beehiiv — mesma sintaxe que `CLARICE_UTM_PROFILE` usa pro
  // envio mensal regular (mesma plataforma). Ver #4510 pro histórico da
  // distinção Beehiiv×Brevo nesse campo.
  pollMergeTag: "{{ contact.EMAIL }}",
  pollBrand: "mensal-apoiadores-brevo",
};

/**
 * Render completo da variante Brevo apoiadores (#4593): filtra o draft
 * (`filterDraftForBeehiiv`, reusado sem modificação — ver docstring do
 * módulo) e chama o MESMO `draftToEmail` do envio Clarice, só trocando o
 * `utmProfile`. Assinatura espelhava a antiga `draftToEmailBeehiiv`
 * (removida por #7121, sem consumidor de runtime) de propósito — mesmos
 * parâmetros de imagem que `scripts/render-monthly-apoiadores-brevo.ts`/
 * `publish-monthly.ts` já usam, pra reusar diretamente as URLs de imagem JÁ
 * publicadas pelo pipeline Clarice (mesma edição, mesmas imagens — sem
 * upload duplicado).
 */
export function draftToEmailApoiadoresBrevo(
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
  const filtered = filterDraftForBeehiiv(draft);
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
    APOIADORES_BREVO_UTM_PROFILE,
  );
}
