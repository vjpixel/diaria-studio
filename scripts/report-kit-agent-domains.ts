/** #12036 items 2/3. Read-only monitoring; no acquisition/subscription policy. */
import { readFileSync } from 'node:fs';
import { loadProjectEnv } from './lib/env-loader.ts';
import { isMainModule } from './lib/cli-args.ts';
import { listAllKitSubscribers, listAllFormSubscribers, type KitSubscriberSummary } from './lib/kit-subscribers.ts';
import { kitFetch } from './lib/kit-client.ts';
import { resolveKitConfig } from './lib/kit-config.ts';

// Explicit observed domains only: no fuzzy matching or automatic classification.
export const KNOWN_AGENT_DOMAINS = ['mail.grokbot.com'] as const;
export function agentDomain(email: string): string | null {
  const domain = email.trim().toLowerCase().split('@');
  return domain.length === 2 && KNOWN_AGENT_DOMAINS.some(d => d === domain[1]) ? domain[1] : null;
}
export function referrerDomain(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.hostname : null; }
  catch { return null; }
}
export function engagement(raw: unknown) {
  const stats = (raw as { subscriber?: { stats?: Record<string, unknown> } })?.subscriber?.stats;
  const count = (key: string) => typeof stats?.[key] === 'number' && Number.isInteger(stats[key]) && (stats[key] as number) >= 0 ? stats[key] as number : null;
  return { sent: count('sent'), opened: count('opened'), clicked: count('clicked') };
}
export function safeAttribution(s: KitSubscriberSummary) {
  return {
    native_block_present: Boolean(s.attribution),
    native_referrer_domain: referrerDomain(s.attribution?.referrer),
    stored_referrer_domain: referrerDomain(s.fields?.referring_site),
    origin_referrer_domain: referrerDomain(s.fields?.origem_referrer),
    // Presence counts avoid publishing arbitrary free text (names, UTMs, form labels).
    native_form: s.attribution?.source_type === 'form' ? true : null,
    native_api_subscription: s.attribution?.source_type === 'api_subscription',
    native_direct_api_call: s.attribution?.source_mechanism === 'direct_api_call',
    native_source_type_present: Boolean(s.attribution?.source_type),
    native_source_name_present: Boolean(s.attribution?.source_name),
    native_source_mechanism_present: Boolean(s.attribution?.source_mechanism),
    stored_utm_present: Boolean(s.fields?.utm_source || s.fields?.utm_medium || s.fields?.utm_campaign),
  };
}
export async function main() {
  loadProjectEnv();
  const config = resolveKitConfig();
  if (!config.ok) { console.error('Relatório indisponível: configuração Kit ausente.'); process.exitCode = 2; return; }
  const subscribers = await listAllKitSubscribers(config.config, { status: 'all', includeAttribution: true });
  let formMembers: Set<number> | null = null;
  try {
    const platform = JSON.parse(readFileSync(new URL('../platform.config.json', import.meta.url), 'utf8'));
    if (platform.kit?.doiFormId) formMembers = new Set((await listAllFormSubscribers(platform.kit.doiFormId, config.config, { status: 'all' })).map(s => s.id));
  } catch { /* Missing membership data does not block domain monitoring. */ }
  const rows = [];
  for (const s of subscribers) {
    const domain = agentDomain(s.email_address);
    if (!domain) continue;
    let stats = engagement(null);
    try { stats = engagement(await kitFetch(`/subscribers/${s.id}/stats`, { config: config.config })); }
    catch { /* Unknown is null, never zero. No raw API errors/PII in output. */ }
    rows.push({ domain, configured_doi_form_member: formMembers === null ? null : formMembers.has(s.id), active: s.state === 'active', ...stats, ...safeAttribution(s) });
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  console.log(JSON.stringify({ generated_at: new Date().toISOString(), base_count: subscribers.length,
    known_domains: KNOWN_AGENT_DOMAINS, matched_count: rows.length, rows,
    limitations: ['Rows have no persistent identifier; unknown statistics are null.',
      'Form attribution presence does not prove the entry route. No form membership inferred from DOI tags.',
      'Only explicitly known domains are matched; no subscription or acquisition policy applied.'] }, null, 2));
}
if (isMainModule(import.meta.url)) main().catch(() => { console.error('Relatório indisponível: falha na leitura Kit; detalhes omitidos para proteger PII.'); process.exitCode = 1; });
