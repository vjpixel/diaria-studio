/**
 * jogar-promo-urls.ts (#4550)
 *
 * URLs prontas pras 2 superfícies de distribuição própria do "É IA?" que o
 * editor consome MANUALMENTE (post/story dedicado e link de bio) — a 3ª
 * superfície (pill do rodapé da edição) é auto-injetada pelo pipeline via
 * `scripts/lib/shared/encerramento-snippet.ts` e não precisa de um builder
 * separado (a URL é montada inline ali, mesmo padrão de `withRodapeUtm`).
 *
 * Decisão do editor (#4550, comentário 260804): "Overnight prepara as peças;
 * a publicação fica com o editor. Nada vai pro ar sem ele." — nenhuma função
 * deste arquivo chama rede, escreve arquivo, ou publica nada. São builders
 * puros de URL — o editor copia o resultado na hora de criar o post/mudar o
 * campo de bio.
 */
import { DIARIA_EIA_URL } from "./canonical-urls.ts";
import {
  JOGAR_POST_DEDICADO_UTM,
  EXTERNAL_SURFACE_MEDIUM,
  buildJogarBioCampaign,
} from "./shared/utm-registry.ts";

/** Path da página pública do jogo (entry point — sequência mensal / par
 * único, conforme `?edition=`) — mesmo path usado em todo o funil de
 * compartilhamento (`share.ts`, `PUBLIC_GAME_DISPLAY_HOST + "/jogar"`). */
const JOGAR_PATH = "/jogar";

/**
 * Pure: URL pronta pro link do post/story dedicado de divulgação do jogo
 * (#4550, superfície 2/3) — `JOGAR_POST_DEDICADO_UTM` do registry, `new URL`
 * + `searchParams` (nunca concatenação, mesma disciplina de
 * `buildExternalSurfaceUrl`/`buildJogarArchiveUrl`). Editor cola esta URL no
 * corpo do post ao publicar manualmente.
 */
export function buildJogarPostDedicadoUrl(): string {
  const url = new URL(`${DIARIA_EIA_URL}${JOGAR_PATH}`);
  url.searchParams.set("utm_source", JOGAR_POST_DEDICADO_UTM.source);
  url.searchParams.set("utm_medium", JOGAR_POST_DEDICADO_UTM.medium);
  url.searchParams.set("utm_campaign", JOGAR_POST_DEDICADO_UTM.campaign);
  return url.toString();
}

/**
 * Pure: URL pronta pro link de bio dedicado ao jogo (#4550, superfície 3/3),
 * numa plataforma que o editor decidir ceder o slot único de bio (hoje
 * ocupado pela home, `EXTERNAL_UTM_SURFACES`) — `source` é o nome da
 * plataforma (ex: `"instagram"`), `utm_campaign` via `buildJogarBioCampaign`
 * (mecanismo de variante — ver rationale completo em `utm-registry.ts`, evita
 * colidir com o campaign `perfil-{source}` já em uso pelo link de bio pra
 * home dessa mesma plataforma).
 *
 * QUAL plataforma (se alguma) cede seu slot de bio é decisão editorial fora
 * do escopo desta instrumentação — esta função só fica pronta pra quando o
 * editor decidir; nenhuma chamada automática existe hoje.
 */
export function buildJogarBioUrl(source: string): string {
  const url = new URL(`${DIARIA_EIA_URL}${JOGAR_PATH}`);
  url.searchParams.set("utm_source", source);
  url.searchParams.set("utm_medium", EXTERNAL_SURFACE_MEDIUM);
  url.searchParams.set("utm_campaign", buildJogarBioCampaign(source));
  return url.toString();
}
