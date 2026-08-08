/**
 * scripts/lib/worker-public-hosts.ts (#4777)
 *
 * Descobre, a partir de `workers/*​/wrangler.toml`, quais Workers do repo
 * têm um HOST PÚBLICO dedicado num domínio proxiado pela Cloudflare
 * (`[[routes]] pattern = "..." custom_domain = true`) — sem lista
 * hardcoded, mesmo padrão de descoberta de `discoverWorkers` em
 * `scripts/worker-drift-check.ts` (#4723), só que extraindo o HOST da rota
 * em vez do `name` publicado.
 *
 * Existe pro guard de `test/worker-robots-txt-guard-4777.test.ts`: todo
 * Worker novo num domínio proxiado pela Cloudflare nasce servindo o
 * robots.txt DEFAULT da plataforma (bloqueia 9 crawlers via `Disallow: /`)
 * sem que ninguém escolha isso — foi assim 3 vezes (#4546: cursos/livros/
 * arquivo; #4777: poll/artigo-mensal/artigos) antes de alguém notar. Sem
 * descoberta automática, o guard só protegeria os Workers já corrigidos —
 * o objetivo é que o QUARTO Worker com custom_domain novo falhe o teste até
 * ganhar seu próprio `/robots.txt`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface DiscoveredPublicHost {
  /** Nome do diretório sob workers/ (ex: "poll", "artigo-mensal"). */
  workerDir: string;
  /** Host declarado em `[[routes]] pattern = "..."` (ex: "eia.diar.ia.br"). */
  host: string;
}

/**
 * Extrai todos os `pattern = "..."` de blocos `[[routes]]` que também têm
 * `custom_domain = true` no MESMO bloco (regex sobre texto, não um parser
 * TOML completo — mesmo racional de simplicidade de `parseWranglerTomlName`
 * em `scripts/lib/worker-drift-check.ts`: o formato usado por este repo é
 * regular o bastante, e um parser completo seria escopo maior do que o
 * guard precisa). Rotas SEM `custom_domain = true` (ex: Workers Routes
 * clássicas) são ignoradas de propósito — não são o padrão usado por
 * nenhum Worker deste repo hoje (ver histórico em `workers/artigos/wrangler.toml`
 * sobre por que a Route clássica foi abandonada).
 */
export function parseWranglerTomlCustomDomainHosts(tomlContent: string): string[] {
  const hosts: string[] = [];
  const blocks = tomlContent.split(/(?=^\s*\[\[routes\]\])/m).filter((b) => /^\s*\[\[routes\]\]/.test(b));
  for (const block of blocks) {
    if (!/custom_domain\s*=\s*true/.test(block)) continue;
    const m = block.match(/pattern\s*=\s*"([^"]+)"/);
    if (m) hosts.push(m[1]);
  }
  return hosts;
}

/**
 * Varre `workers/*​/wrangler.toml` e retorna todos os hosts públicos
 * descobertos. Worker sem `wrangler.toml` (não deveria acontecer — todo
 * worker deste repo tem um) ou sem `[[routes]]`/`custom_domain = true`
 * (ex: `brevo-dashboard`, `diaria-dashboard`, `draft`, `linkedin-cron`,
 * `reativar` — só `workers_dev`, sem domínio de marca) é pulado, não é erro.
 */
export function discoverWorkerPublicHosts(workersDir: string): DiscoveredPublicHost[] {
  if (!existsSync(workersDir)) return [];
  const entries = readdirSync(workersDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const discovered: DiscoveredPublicHost[] = [];

  for (const entry of entries) {
    const dir = entry.name;
    const tomlPath = join(workersDir, dir, "wrangler.toml");
    if (!existsSync(tomlPath)) continue;
    const hosts = parseWranglerTomlCustomDomainHosts(readFileSync(tomlPath, "utf8"));
    for (const host of hosts) discovered.push({ workerDir: dir, host });
  }

  return discovered;
}
