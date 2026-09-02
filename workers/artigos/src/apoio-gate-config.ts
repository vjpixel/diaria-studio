/**
 * workers/artigos/src/apoio-gate-config.ts (#7030)
 *
 * ⚠️ DECISÃO EM ABERTO — não confirmada com o editor (ver PR body da #7030).
 *
 * A issue #7030 pede explicitamente pra mapear "apoio de R$10/mês ou mais"
 * pra um subconjunto dos 4 níveis de `apoio_nivel`
 * (`amigo`/`apoiador`/`mantenedor`/`patrono`), e diz textualmente que esse
 * mapeamento NÃO está registrado em lugar nenhum do repo — "é o
 * pré-requisito de tudo, e eu não sei a resposta" (corpo da issue).
 *
 * `ARTIGOS_ESPECIAIS_APOIO_THRESHOLD` abaixo é um PLACEHOLDER de primeiro
 * palpite (todos os níveis exceto o mais barato, "amigo") — não confirmado
 * no apoia.se. Mudar isto é a ÚNICA coisa que precisa mudar pra corrigir o
 * limiar depois que o editor confirmar os valores reais dos 4 níveis (ver
 * `scripts/lib/apoio-segments-canonical-kit.ts` pra onde documentar a
 * correspondência valor-em-R$↔nível, uma vez confirmada).
 */
import type { ApoioNivel } from "../../../scripts/lib/shared/apoio-level-verify.ts";

/** PLACEHOLDER — ver aviso acima. */
export const ARTIGOS_ESPECIAIS_APOIO_THRESHOLD: readonly ApoioNivel[] = ["apoiador", "mantenedor", "patrono"];
