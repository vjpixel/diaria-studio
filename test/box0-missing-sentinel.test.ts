import { it } from 'node:test';
import assert from 'node:assert/strict';
import { checkBox0MissingSentinel } from '../scripts/lib/lint-checks/box0-missing-sentinel.ts';
import { runStage4LintReport } from '../scripts/lint-newsletter-md.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const box = '**Também em vídeo**\n\nComento o destaque no canal.\n\n[Siga o canal](https://youtube.com/@diariabr)';
const edition = (intro: string) => `Abertura.\n\n---\n\n${intro}\n\n---\n\n**DESTAQUE 1 | PRODUTO**\n\nTexto.`;
it('avisa sobre box provável sem sentinel e aceita o marcado', () => {
  assert.match(checkBox0MissingSentinel(edition(box)).warnings[0], /<!-- box0 -->/);
  assert.equal(checkBox0MissingSentinel(edition('<!-- box0 -->\n' + box)).ok, true);
});
it('não acusa callout normal nem sorteio/campeões, ou conteúdo após D1', () => {
  for (const intro of ['**Aviso da abertura com [link](https://example.com)**', '**Aviso**\n\nParágrafo sem CTA.', box.replace('Também em vídeo', 'Sorteio do mês'), box.replace('Também em vídeo', 'Campeões do mês')]) {
    assert.equal(checkBox0MissingSentinel(edition(intro)).ok, true);
  }
  assert.equal(checkBox0MissingSentinel(edition('') + '\n\n' + box).ok, true);
});
it('Stage 4 registra WARN sem acrescentar falha bloqueante', () => {
  const dir = mkdtempSync(join(tmpdir(), 'box0-warning-'));
  try {
    writeFileSync(join(dir, '02-reviewed.md'), edition(box));
    const report = runStage4LintReport(dir, process.cwd());
    const check = report.checks.find(c => c.id === 'box0-missing-sentinel');
    assert.equal(check?.severity, 'warn-only');
    assert.equal(check?.ok, false);
    writeFileSync(join(dir, '02-reviewed.md'), edition('<!-- box0 -->\n' + box));
    const marked = runStage4LintReport(dir, process.cwd());
    assert.equal(report.ok, marked.ok);
    assert.deepEqual(report.checks.filter(c => c.severity === 'gate-blocking' && !c.ok).map(c => c.id), marked.checks.filter(c => c.severity === 'gate-blocking' && !c.ok).map(c => c.id));
    assert.equal(marked.checks.find(c => c.id === 'box0-missing-sentinel')?.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
