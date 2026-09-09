/**
 * workers/poll/src/optin-flag-6340.ts (#6340)
 *
 * A flag MUDOU DE CASA em 09/09/2026 (#7723): mora em
 * `scripts/lib/shared/kit-doi.ts`, junto do resto da maquinaria de DOI, agora
 * que `cursos` e `reativar` também a consomem. Re-export para não quebrar
 * importadores existentes.
 */
export { DOUBLE_OPT_IN_FLAG } from "../../../scripts/lib/shared/kit-doi.ts";
