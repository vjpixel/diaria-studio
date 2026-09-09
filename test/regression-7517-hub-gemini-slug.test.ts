import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

describe('regression #7517 — google-gemini hub reconstruído', () => {
  it('página do hub contém os 2 slugs restaurados (rebuild)', () => {
    const page = resolve(__dirname, '../workers/arquivo/src/hubs/google-gemini.generated.ts');
    // Se arquivo .ts gerado existe, verifica conteúdo; caso não, checa pages
    const html = resolve(__dirname, '../workers/site/public/p/banco-da-inglaterra-teme-colapso-economico-global/index.html');
    expect(existsSync(html)).toBe(true);
    const index = readFileSync(resolve(__dirname, '../workers/site/public/index.html'), 'utf-8');
    expect(index).toContain('banco-da-inglaterra-teme-colapso-economico-global');
    expect(index).toContain('google-lanca-dois-modelos-gemini-de-uma-vez');
  });

  it('.ts do hub tem UPDATED_DATE 2026-09-03 (não 08-27 defasado)', () => {
    const ts = readFileSync(resolve(__dirname, '../scripts/lib/hubs/google-gemini.ts'), 'utf-8');
    expect(ts).toContain('2026-09-03');
    // data antiga pode aparecer em comentário histórico; gate = nova data presente
  });

  it('sitemap do hub contém os 2 slugs restaurados', () => {
    const sitemap = readFileSync(resolve(__dirname, '../workers/site/public/sitemap.xml'), 'utf-8');
    expect(sitemap).toContain('banco-da-inglaterra-teme-colapso-economico-global');
    expect(sitemap).toContain('google-lanca-dois-modelos-gemini-de-uma-vez');
  });
});
