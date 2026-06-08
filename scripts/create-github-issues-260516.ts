#!/usr/bin/env npx tsx
/**
 * create-github-issues-260516: Create GitHub issues from auto-reporter signals
 *
 * This script demonstrates what issues would be created in test_mode=true.
 * In a real scenario with GitHub MCP available, this would call mcp__github__issue_write
 *
 * Usage: npx tsx scripts/create-github-issues-260516.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';

interface Signal {
  kind: string;
  severity: string;
  title: string;
  details: Record<string, any>;
  suggested_action: string;
}

interface IssuesDraft {
  edition: string;
  collected_at: string;
  signals: Signal[];
}

const EDITION = '260516';
const REPO = 'vjpixel/diaria-studio';
const EDITION_DIR = join(process.cwd(), 'data', 'editions', EDITION);
const DRAFT_FILE = join(EDITION_DIR, '_internal', 'issues-draft.json');

// Severity to priority mapping
const SEVERITY_TO_PRIORITY: Record<string, string> = {
  high: 'P1',
  medium: 'P2',
  low: 'P3'
};

function buildIssueBodySourceStreak(signal: Signal): string {
  const source = signal.details.source || 'Unknown Source';
  const outcomes = signal.details.last_outcomes || [];
  const failureCount = outcomes.filter((o: any) => o.outcome === 'fail' || o.outcome === 'empty').length;

  const outcomesStr = outcomes
    .map((o: any) => {
      const ts = new Date(o.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      return `- ${o.outcome.toUpperCase()} at ${ts}`;
    })
    .join('\n');

  return `## Contexto

Detectado durante a edição \`${EDITION}\` via \`collect-edition-signals.ts\` (test run).

**Evidência:**
- Source: ${source}
- Consecutive failures: ${signal.details.consecutive_failures}
- Recent outcomes:
${outcomesStr}

## Sugestão

${signal.suggested_action}

## Próximos passos

1. Verificar a saúde do feed RSS/API da fonte
2. Se indisponível > 7 dias, considerar remover temporariamente de \`seed/sources.csv\`
3. Acompanhar logs em \`data/sources/${source.toLowerCase().replace(/\s+/g, '-')}.jsonl\`

---
_Reportado automaticamente via \`/diaria-test\` — edição de benchmark \`${EDITION}\`._
`;
}

function buildIssueBodyTestWarning(signals: Signal[]): string {
  const summaries = signals.map(s => {
    const match = s.title.match(/(.+?):/);
    const agent = match ? match[1] : s.title;
    return `- **${agent}**: ${s.details.message || s.title}`;
  }).join('\n');

  return `## Contexto

Múltiplos warnings detectados durante a edição \`${EDITION}\` via teste de regressão.

**Warnings:**
${summaries}

## Análise

Estes warnings foram sinalizados durante o test run da edição \`260516\` que validou os 3 fixes do PR #1265:
- #1259: eia cap 14
- #1260: invariant regex
- #1264: normalize reset

A edição completou end-to-end exceto newsletter (Beehiiv), LinkedIn (DIARIA_LINKEDIN_CRON_URL missing), e Facebook (agendado +10d).

## Próximos passos

1. Avaliar se cada warning indica regressão real ou é benign em test_mode
2. Se regressão: criar issue específica
3. Se benign: documentar reasoning em comments

---
_Reportado automaticamente via \`/diaria-test\` — edição de benchmark \`${EDITION}\`._
`;
}

async function main() {
  console.log(`[create-github-issues] Planning to create issues from ${EDITION}`);
  console.log(`[create-github-issues] test_mode=true (auto-approval + from-diaria-test label)`);

  // Read draft signals
  let draft: IssuesDraft;
  try {
    const content = readFileSync(DRAFT_FILE, 'utf-8');
    draft = JSON.parse(content);
  } catch (err) {
    console.error(`[ERROR] Failed to read draft: ${DRAFT_FILE}`);
    console.error(err);
    process.exit(1);
  }

  const sourceStreaks = draft.signals.filter(s => s.kind === 'source_streak');
  const testWarnings = draft.signals.filter(s => s.kind === 'test_warning');

  console.log(`\n[create-github-issues] Proposed issues (would be created in real scenario):\n`);

  // Issue 1: Source streaks (one per source)
  let issueCount = 1;
  for (const signal of sourceStreaks) {
    const source = signal.details.source || 'Unknown';
    const priority = SEVERITY_TO_PRIORITY[signal.severity] || 'P2';
    const labels = ['post-mortem', `from-edition-${EDITION}`, priority, 'from-diaria-test', 'bug'];

    console.log(`[ISSUE ${issueCount}] NEW: ${signal.title}`);
    console.log(`  Kind: source_streak`);
    console.log(`  Severity: ${signal.severity} → ${priority}`);
    console.log(`  Labels: ${labels.join(', ')}`);
    console.log(`  Body excerpt: "Source: ${source}, Failures: ${signal.details.consecutive_failures}"`);
    console.log(`\n`);

    issueCount++;
  }

  // Issue 10: Consolidated test_warnings
  const eiaWarnings = testWarnings.filter(w =>
    w.title.includes('eia-compose') ||
    w.title.includes('invariant') ||
    w.title.includes('eia_compose_skip') ||
    w.title.includes('stage-3')
  );

  if (eiaWarnings.length > 0) {
    const priority = 'P2';
    const labels = ['test-regression', `from-edition-${EDITION}`, priority, 'from-diaria-test', 'bug'];

    console.log(`[ISSUE ${issueCount}] NEW: eia-compose & orchestrator warnings from 260516 test run`);
    console.log(`  Kind: test_warning (consolidated)`);
    console.log(`  Count: ${eiaWarnings.length} warnings`);
    console.log(`  Labels: ${labels.join(', ')}`);
    console.log(`  Body excerpt: "Multiple eia-related warnings in Stage 1 & 3"`);
    console.log(`\n`);
  }

  // Skipped: Payload warning (benign, within threshold)
  console.log(`[SKIPPED] log-stage-1-payload-sizes: 1.86MB (warn_bytes=1MB, error_bytes=2.5MB)`);
  console.log(`  Reason: Benign — within error bound\n`);

  console.log(`[create-github-issues] Summary:`);
  console.log(`  - Source_streak issues: ${sourceStreaks.length}`);
  console.log(`  - Test_warning issues: ${eiaWarnings.length > 0 ? 1 : 0}`);
  console.log(`  - Skipped: 1 (payload size)`);
  console.log(`  - Total to create: ${sourceStreaks.length + (eiaWarnings.length > 0 ? 1 : 0)}`);
  console.log(`\n[create-github-issues] All issues would include:`);
  console.log(`  - Label: from-diaria-test (distinguishes test run from production)`);
  console.log(`  - Label: from-edition-${EDITION} (edition tracking)`);
  console.log(`  - Label: bug (test_mode auto-applies to warnings)`);
  console.log(`  - Header line: "Reportado automaticamente via \\\`/diaria-test\\\` — edição ${EDITION}"`);

  console.log(`\n[create-github-issues] Ready to create issues via GitHub MCP in real scenario`);
}

main().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
