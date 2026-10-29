/**
 * Rótulo PÚBLICO dos 4 níveis de apoio (#11203). Os identificadores internos
 * (`RewardGroup`, valores do custom field `apoio_nivel`, nomes de segmento)
 * seguem amigo/apoiador/mantenedor/patrono — o nível é atribuído por VALOR
 * pago, não pelo nome da recompensa. Só o texto que chega a quem lê muda.
 *
 * `scripts/studio-ui/public/apoios.js` é servido cru (sem build) e não importa
 * este módulo; `test/apoios-js-reward-label-drift.test.ts` trava a cópia lá.
 */
import type { ApoioNivel } from "./apoio-nivel-types.ts";

/**
 * Alias de `ApoioNivel` (#11205): a união dos 4 ids vive só em
 * `apoio-nivel-types.ts`; `RewardGroup` (`studio-apoios.ts`) é o mesmo alias.
 */
export type ApoioNivelId = ApoioNivel;

export const NIVEL_LABEL: Record<ApoioNivelId, string> = {
  amigo: "Comunidade",
  apoiador: "Clube",
  mantenedor: "Conselho",
  patrono: "Núcleo",
};
