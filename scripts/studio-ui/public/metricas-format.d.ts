// Tipos de metricas-format.js (#9023) — só pro typecheck dos testes
// (tsconfig.test.json); o browser carrega o .js direto, sem build step.

export interface FmtValorInput {
  valor: number | null;
  qualidade: string;
  limites?: { min: number; max: number; rotuloMax?: string };
}

export function fmtValor(result: FmtValorInput, unidade: string): string;
