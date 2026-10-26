/**
 * Rótulo PÚBLICO dos 4 níveis de apoio (#11203). Os identificadores internos
 * (`RewardGroup`, valores do custom field `apoio_nivel`, nomes de segmento)
 * seguem amigo/apoiador/mantenedor/patrono — o nível é atribuído por VALOR
 * pago, não pelo nome da recompensa. Só o texto que chega a quem lê muda.
 *
 * `scripts/studio-ui/public/apoios.js` é servido cru (sem build) e não importa
 * este módulo; `test/apoios-js-reward-label-drift.test.ts` trava a cópia lá.
 */
export type ApoioNivelId = "amigo" | "apoiador" | "mantenedor" | "patrono";

export const NIVEL_LABEL: Record<ApoioNivelId, string> = {
  amigo: "Comunidade",
  apoiador: "Clube",
  mantenedor: "Conselho",
  patrono: "Núcleo",
};
