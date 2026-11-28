import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { syncCorteAgendamento, syncCorteAgendamentoFailSoft } from '../scripts/publish-shorts/corte.ts';
import { addAgendamento, emptyBanco, agendamentosPath, saveAgendamentos, loadAgendamentos } from '../scripts/lib/diaria/agendamentos.ts';
import type { CorteSpec } from '../scripts/lib/diaria/short-corte.ts';
const now = new Date('2026-11-13T02:00:00Z');
it('sincroniza extra pela edição de origem, somente com todos os destinos cobertos', () => {
  const root = mkdtempSync(join(tmpdir(), 'corte-12960-'));
  try {
    const path = agendamentosPath(root);
    saveAgendamentos(path, addAgendamento(emptyBanco(), {
      edicao: '261110', peca: 'corte-nvidia', destinos: ['instagram', 'youtube_shorts'],
      alvo: '2026-11-14T12:00:00Z', dono: 'modo corte', estado: 'pendente',
    }, now).banco);
    const spec: CorteSpec = { slug: 'nvidia-261110', date: '261114', hhmm: '09:00', title: 'Teste', hook: 'Teste', video: 'test.mp4', publish_confirmed_at: now.toISOString(), publish_confirmed_destinations: ['instagram'] };
    syncCorteAgendamento(root, spec, [], ['instagram'], now);
    assert.equal(loadAgendamentos(path).itens[0].estado, 'pendente');
    const entries = [{ destination: 'youtube_shorts', status: 'scheduled' as const, id: 'isolado', at: now.toISOString(), scheduled_at: '2026-11-14T12:00:00Z' }];
    syncCorteAgendamento(root, spec, entries.map(e => ({ ...e, status: 'send_unknown' as const })), ['instagram'], now);
    assert.equal(loadAgendamentos(path).itens[0].estado, 'pendente');
    syncCorteAgendamento(root, { ...spec, publish_confirmed_destinations: [] }, entries, ['instagram'], now);
    assert.equal(loadAgendamentos(path).itens[0].estado, 'pendente');
    syncCorteAgendamento(root, spec, entries, ['instagram'], now);
    const banco = loadAgendamentos(path);
    assert.equal(banco.itens[0].estado, 'agendado');
    assert.equal(banco.itens[0].historico.at(-1)?.para, 'agendado');
    syncCorteAgendamento(root, spec, entries, ['instagram'], now);
    syncCorteAgendamento(root, { ...spec, slug: 'avulso' }, entries, ['instagram'], now);
    assert.deepEqual(loadAgendamentos(path), banco);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('banco ilegível não derruba a rodada: vira aviso com o erro e o arquivo fica intacto (review #12964)', () => {
  const root = mkdtempSync(join(tmpdir(), 'corte-12960-err-'));
  try {
    const path = agendamentosPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ isto nao e json');
    const spec: CorteSpec = { slug: 'nvidia-261110', date: '261114', hhmm: '09:00', title: 'Teste', hook: 'Teste', video: 'test.mp4', publish_confirmed_at: now.toISOString(), publish_confirmed_destinations: ['instagram'] };
    const entries = [{ destination: 'instagram', status: 'scheduled' as const, id: 'x', at: now.toISOString(), scheduled_at: '2026-11-14T12:00:00Z' }];
    // A função crua lança: é isso que derrubaria a rodada sem o wrapper.
    assert.throws(() => syncCorteAgendamento(root, spec, entries, [], now));
    const warnings: string[] = [];
    const ok = syncCorteAgendamentoFailSoft(() => syncCorteAgendamento(root, spec, entries, [], now), (m) => warnings.push(m));
    assert.equal(ok, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[aviso\] modo corte: o post saiu/);
    assert.match(warnings[0], /Erro: .+/);
    assert.equal(readFileSync(path, 'utf8'), '{ isto nao e json');
    const quiet: string[] = [];
    assert.equal(syncCorteAgendamentoFailSoft(() => {}, (m) => quiet.push(m)), true);
    assert.deepEqual(quiet, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
