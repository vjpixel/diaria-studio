import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sameEvent, recurringEventThemes, SAME_EDITION, STRONG_CONCEPT_MAX_DISTANCE_DAYS } from '../scripts/lib/event-dedup.ts';
import { dedup } from '../scripts/dedup.ts';
import { sameStorySignal } from '../scripts/lib/story-grouping.ts';

// #13951: o sinal de evento recorrente (IPO, #13923) removia em silêncio
// notícia de OUTRA empresa (empresa coadjuvante no título) ou de OUTRA fase
// do mesmo IPO, por toda a janela de ~30 dias.
const coreweave = 'Nvidia-backed CoreWeave prices its IPO';
const cerebras = 'Cerebras, Nvidia rival, files for IPO';
const debut = 'OpenAI shares jump 30% in stock market debut';
const filing = 'OpenAI files confidentially for IPO';

/** dedup com um título passado e a distância (dias úteis) até ele. */
function dedupAgainstPast(title: string, past: string, distance?: number) {
  const distances = new Map<string, number>(distance === undefined ? [] : [[past, distance]]);
  return dedup(
    [{ url: 'https://example.com/novo', title }],
    new Set(), 0.85, [past], 0.70, [], 0.6, undefined, 0.55, new Set(), [], [], distances,
  );
}

describe('#13951 IPO: empresa sujeito e limite de distância', () => {
  it('empresa coadjuvante ("Nvidia-backed", "Nvidia rival") não vira tema de IPO', () => {
    assert.deepEqual(recurringEventThemes(coreweave), []);
    assert.deepEqual(recurringEventThemes(cerebras), []);
    assert.deepEqual(recurringEventThemes('Startup apoiada pela Nvidia estreia na bolsa'), []);
    assert.deepEqual(recurringEventThemes(filing), ['IPO openai']);
  });

  it('CoreWeave × Cerebras: dois IPOs diferentes nunca casam, em distância nenhuma', () => {
    for (const distanceDays of [undefined, 0, 1, STRONG_CONCEPT_MAX_DISTANCE_DAYS, 20]) {
      assert.equal(sameEvent(coreweave, cerebras, { distanceDays }), null, `distância ${distanceDays}`);
    }
    assert.equal(sameStorySignal(coreweave, cerebras), null);
    const r = dedupAgainstPast(coreweave, cerebras, 1);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0].event_dedup_flagged, undefined);
  });

  it('OpenAI debut × filing: fora da janela curta (ou sem distância) só marca', () => {
    assert.equal(sameEvent(debut, filing)?.removable, false);
    assert.equal(sameEvent(debut, filing, { distanceDays: STRONG_CONCEPT_MAX_DISTANCE_DAYS + 1 })?.removable, false);
    assert.equal(sameEvent(debut, filing, { distanceDays: 15 })?.removable, false);
    for (const distance of [undefined, 3, 15]) {
      const r = dedupAgainstPast(debut, filing, distance);
      assert.equal(r.kept.length, 1, `distância ${distance}`);
      assert.match(String(r.kept[0].event_dedup_flagged), /IPO openai/);
    }
  });

  it('OpenAI debut × filing: dentro da janela curta segue removível', () => {
    assert.equal(sameEvent(debut, filing, SAME_EDITION)?.removable, true);
    assert.equal(sameEvent(debut, filing, { distanceDays: STRONG_CONCEPT_MAX_DISTANCE_DAYS })?.removable, true);
    assert.equal(dedupAgainstPast(debut, filing, 1).kept.length, 0);
  });

  it('IPO fraco não esconde sinal removível A1/B do mesmo par', () => {
    // Mesma empresa + nome distintivo (A1) remove em qualquer distância, como antes.
    const a = 'Após meses de atrasos, Google anuncia IPO da Argon';
    const b = 'Gemini 4 Argon: Google prepara IPO';
    const m = sameEvent(a, b);
    assert.equal(m?.removable, true);
    assert.equal(m?.signal, 'distinctive_name');
  });
});
