// #13994: o módulo mora em scripts/lib/shared/brevo-health-thresholds.ts (núcleo
// compartilhado com o pipeline); este arquivo só reexporta, para os imports do
// Worker e dos testes seguirem iguais.
export * from "../../../scripts/lib/shared/brevo-health-thresholds.ts";
