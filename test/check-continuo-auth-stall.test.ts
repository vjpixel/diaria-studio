// Regressão #7647 — parada dura por auth no contínuo.
// Não toca credenciais, não decide política de conta.
import { checkContinuoAuthStall, AuthStallResult } from '../scripts/check-continuo-auth-stall';

describe('checkContinuoAuthStall (#7647)', () => {
  it('retorna stalled=false quando jobs.json legível sem erro auth 401/403', () => {
    // Dependência do ambiente (jobs.json real) — falha soft se file ausente.
    const r = checkContinuoAuthStall();
    // Não pode ser stalled=true com código ausente; se file ausente é indeterminado (não stalled)
    expect(r.stalled).toBe(false);
    expect(typeof r.reason).toBe('string');
  });

  it('registra bloqueio honesto: não executa hermes auth remove/add', () => {
    // Parte política de conta / higiene de pool exige decisão do editor + acesso externo.
    // Este teste garante que nenhuma função no módulo invoca auth externo.
    const src = require('fs').readFileSync('/home/vjpixel/continuo-7647-work/scripts/check-continuo-auth-stall.ts', 'utf8');
    expect(src).not.toMatch(/auth\s+(add|remove)/i);
    expect(src).not.toMatch(/credential_pool/); // não toca pool
    expect(src).not.toMatch(/auth\.json/);      // não lê secrets
  });

  it('formato AuthStallResult consistente', () => {
    const r = checkContinuoAuthStall();
    expect(r).toHaveProperty('stalled');
    expect(r).toHaveProperty('reason');
    expect(typeof r.stalled).toBe('boolean');
    expect(typeof r.reason).toBe('string');
  });
});
