import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sameEvent, recurringEventThemes, SAME_EDITION } from '../scripts/lib/event-dedup.ts';

// #13957: em "X rival Y" / "X competitor Y" a empresa DEPOIS do modificador é
// o sujeito do evento. Ter "rival"/"competitor" no RECURRING_MODIFIER_BEFORE
// excluía justamente o sujeito e o IPO repetido passava sem remoção nem marca.
describe('#13957 IPO: empresa depois de "rival"/"competitor" é sujeito', () => {
  it('"OpenAI rival Anthropic prices its IPO" vira tema IPO anthropic', () => {
    assert.deepEqual(recurringEventThemes('OpenAI rival Anthropic prices its IPO'), ['IPO anthropic']);
  });

  it('"Nvidia competitor AMD files for IPO" vira tema IPO amd', () => {
    assert.deepEqual(recurringEventThemes('Nvidia competitor AMD files for IPO'), ['IPO amd']);
  });

  it('casa com outro título do mesmo IPO na mesma edição', () => {
    const m = sameEvent('OpenAI rival Anthropic prices its IPO', 'Anthropic files confidentially for IPO', SAME_EDITION);
    assert.ok(m, 'esperava match do mesmo IPO');
    assert.equal(m?.removable, true);
  });

  it('coadjuvante segue fora (casos da #13951)', () => {
    assert.deepEqual(recurringEventThemes('Cerebras, Nvidia rival, files for IPO'), []);
    assert.deepEqual(recurringEventThemes('Nvidia-backed CoreWeave prices its IPO'), []);
    assert.deepEqual(recurringEventThemes('Startup apoiada pela Nvidia estreia na bolsa'), []);
  });
});

// #13963: "rivals" como verbo torna a empresa seguinte coadjuvante.
describe('#13963 IPO: rivals como verbo', () => {
  it('não atribui à OpenAI o IPO de uma startup que rivaliza com ela', () => {
    const title = 'Startup that rivals OpenAI files for IPO';
    assert.deepEqual(recurringEventThemes(title), []);
    assert.notEqual(sameEvent(title, 'OpenAI prepares its IPO', SAME_EDITION)?.removable, true);
  });

  it('mantém apenas o sujeito conhecido antes da oração relativa', () => {
    assert.deepEqual(recurringEventThemes('Anthropic, which rivals OpenAI, prepares IPO'), ['IPO anthropic']);
    assert.deepEqual(recurringEventThemes('Cerebras rivals Nvidia, files for IPO'), []);
  });
});
