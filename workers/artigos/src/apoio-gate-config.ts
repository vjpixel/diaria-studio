/**
 * workers/artigos/src/apoio-gate-config.ts (#7030)
 *
 * DECISÃO DO EDITOR (02/09/2026): o limiar de apoio pro gate dos Artigos
 * Especiais é "todos os níveis exceto `amigo`" — `["apoiador", "mantenedor",
 * "patrono"]`. Confirma o palpite de primeiro-corte que já estava aqui
 * (nenhuma mudança de VALOR nesta atualização, só o status de placeholder
 * não confirmado para decisão registrada).
 *
 * A correspondência valor-em-R$ ↔ nível (`amigo` = R$5–10, `apoiador` =
 * R$10–25, `mantenedor` = R$25–50, `patrono` = R$50+ — mesmas faixas de
 * `computeRewardGroup` em `scripts/studio-ui/studio-apoios.ts`) está
 * documentada em `scripts/lib/apoio-segments-canonical-kit.ts`, o lugar
 * apontado pra isso desde a versão anterior deste arquivo.
 */
import type { ApoioNivel } from "../../../scripts/lib/shared/apoio-level-verify.ts";

/** Limiar de R$10+/mês pro gate dos Artigos Especiais — decisão do editor,
 *  02/09/2026 (issue #7030). Mudar isto é a ÚNICA coisa que precisa mudar se
 *  o limiar for revisto no futuro. */
export const ARTIGOS_ESPECIAIS_APOIO_THRESHOLD: readonly ApoioNivel[] = ["apoiador", "mantenedor", "patrono"];
