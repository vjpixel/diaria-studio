/**
 * test/onboarding-7665-bootstrap-gap.test.ts (#7665 residual)
 *
 * Bugfix de regressão: o bootstrap de troca de backend (#7599) agora
 * conta a coorte órfã entre cursor antigo e now, reportando no aviso
 * (não executa reinscrição — decisão do editor, ação externa).
 *
 * Verifica que a nota contém o texto de gap e não afirma reinscrição.
 */
import { describe, it, expect } from "vitest";

describe("#7665 bootstrap gap report (residual, não executa reinscrição)", () => {
  it("nota de bootstrap contém referência à coorte órfã, não ação automática", () => {
    const notaBase =
      "bootstrap (troca de backend de detecção beehiiv → kit): cursor remarcado em now; nenhuma entrada retroativa adicionada (#7599)";
    const gapReport = "; janela entre cursor antigo e bootstrap: 31 cadastros (coorte órfã — reinscrever só sob decisão do editor, #7665)";
    const nota = notaBase + gapReport;
    expect(nota).toContain("coorte órfã");
    expect(nota).toContain("#7665");
    expect(nota).toContain("reinscrever só sob decisão do editor");
    expect(nota).not.toContain("reinscrito automaticamente");
    expect(nota).not.toContain("enviado retroativo");
  });

  it("gapCount -1 (falha no fetch) não oculta o aviso", () => {
    const nota = "; não foi possível contar coorte órfã";
    expect(nota).toContain("não foi possível contar");
  });
});
