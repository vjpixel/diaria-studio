import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sameEvent, recurringEventThemes, SAME_EDITION } from '../scripts/lib/event-dedup.ts';

// #13960: preposição entre o modificador e a empresa ("rival to Nvidia",
// "concorrente da Nvidia") marca a empresa como objeto, não sujeito. Antes,
// esses títulos viravam "IPO nvidia" e um IPO de OUTRA empresa podia sair do
// pool por casar com um IPO da Nvidia dentro da janela curta.
describe('#13960 IPO: preposição depois do modificador', () => {
  const coadjuvantes = [
    'Cerebras, rival to Nvidia, files for IPO',
    'Concorrente da Nvidia, Cerebras pede IPO',
    'Cerebras, rival da Nvidia, faz IPO',
    'CoreWeave, parceira da Nvidia, faz IPO',
    'CoreWeave, apoiada por Nvidia, faz IPO',
    'Startup, parceira do Google, faz IPO',
    'Cerebras, a competitor of Nvidia, files for IPO',
  ];
  for (const title of coadjuvantes) {
    it(`"${title}" não vira tema da empresa coadjuvante`, () => {
      assert.deepEqual(recurringEventThemes(title), []);
      assert.notEqual(sameEvent(title, 'Nvidia prepares its IPO', SAME_EDITION)?.removable, true);
    });
  }

  it('possessivo EN "Nvidia\'s partner X files for IPO" não vira IPO nvidia', () => {
    assert.deepEqual(recurringEventThemes("Nvidia's partner CoreWeave files for IPO"), []);
    assert.deepEqual(recurringEventThemes('Nvidia’s partner CoreWeave files for IPO'), []);
  });

  it('preposição sem modificador antes mantém a empresa como sujeito', () => {
    assert.deepEqual(recurringEventThemes('IPO do Google movimenta a bolsa'), ['IPO google']);
    assert.deepEqual(recurringEventThemes("Nvidia's IPO filing"), ['IPO nvidia']);
  });

  it('não desfaz #13957/#13963', () => {
    assert.deepEqual(recurringEventThemes('OpenAI rival Anthropic prices its IPO'), ['IPO anthropic']);
    assert.deepEqual(recurringEventThemes('Startup that rivals OpenAI files for IPO'), []);
  });
});
