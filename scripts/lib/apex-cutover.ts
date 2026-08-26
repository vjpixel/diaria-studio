/**
 * apex-cutover.ts (#467)
 *
 * Miolo PURO (sem I/O) do script `scripts/apex-cutover.ts`, que mecaniza o
 * cutover do apex `diar.ia.br` da Beehiiv para o Worker `diaria-site` — a
 * ação de DNS registrada nos comentários do #467 (25-26/08/2026) e no plano
 * de rollback (`docs/apex-cutover-rollback.md`).
 *
 * ─── Por que este arquivo é 100% livre de fetch/rede ────────────────────────
 *
 * Mesmo padrão de `scripts/lib/worker-drift-check.ts`/`apoios-diff-alarm.ts`:
 * toda DECISÃO (o que o guard de pré-condição recusa, que operação de DNS o
 * rollback precisa gerar, se um plano toca um tipo de registro proibido) é
 * uma função pura, testável sem mock de `fetch`. O script fino
 * (`scripts/apex-cutover.ts`) faz só o I/O — chamadas à API da Cloudflare e
 * probes HTTP — e delega toda decisão pra cá.
 *
 * ─── Mecanismo escolhido para `--cutover`: Workers Custom Domain, não Route
 * clássica nem editar `wrangler.toml` + `wrangler deploy` ───────────────────
 *
 * Três caminhos possíveis pra apontar um hostname pra um Worker na Cloudflare:
 *
 *   1. **Workers Route clássica** (`pattern` + `zone_id`) — JÁ TESTADA E
 *      REFUTADA neste projeto para o apex: a rota `diar.ia.br/2026/o-agente*`
 *      → `diaria-artigos` ficou registrada na zona meses e nunca interceptou
 *      nada enquanto a Beehiiv detinha o custom hostname do apex (`GET
 *      /2026/o-agente/` continuava devolvendo 404 com `x-orchid-version`, o
 *      header de origem da Beehiiv — ver comentário do #467 em 25/08/2026,
 *      "Reverificação independente"). Removida por ser inerte.
 *   2. **`custom_domain = true` em `wrangler.toml` + `wrangler deploy`** — é
 *      o mecanismo comprovado 3× em produção neste projeto (`livros.`,
 *      `cursos.`, `especial.diar.ia.br`, ver `workers/artigos/wrangler.toml`
 *      e o comentário de topo de `workers/site/wrangler.toml`). Só que exige
 *      RODAR `wrangler deploy` — e esta unidade tem instrução explícita de
 *      NUNCA rodar `wrangler deploy` nem `--apply` (é decisão do editor, numa
 *      janela combinada). Editar `wrangler.toml` sem poder aplicar deixaria
 *      o repo divergente do estado deployado até alguém rodar o deploy à
 *      mão — exatamente a classe de drift que `worker-drift-check.ts` existe
 *      pra detectar.
 *   3. **API REST de Workers Custom Domains — `PUT
 *      /accounts/{account_id}/workers/domains`** (confirmado na doc oficial
 *      da Cloudflare, 26/08/2026: cria/gerencia o binding + DNS + certificado
 *      "on your behalf", é o MESMO recurso por trás de `custom_domain = true`
 *      no wrangler.toml e do que `npx wrangler deployments domains
 *      list/delete` lê/escreve — citado em `docs/apex-cutover-rollback.md`
 *      §3.1). **Esta é a opção escolhida.** Não exige tocar
 *      `wrangler.toml` nem rodar `wrangler deploy` — o Worker `diaria-site`
 *      já está deployado (`workers_dev = true`, servindo o acervo desde
 *      25/08); só falta o BINDING de hostname, que esta API cria/remove sem
 *      mexer no código do Worker. Reversível pelo mesmo recurso (`DELETE
 *      /accounts/{account_id}/workers/domains/{domain_id}`), simetria que a
 *      opção 2 não teria (reverter um `wrangler.toml` exigiria outro
 *      `wrangler deploy`, de novo fora do escopo desta unidade).
 *
 * A pré-condição documentada em `docs/apex-cutover-rollback.md` §3.1
 * ("se apareceu o apex como custom domain, soltar o binding ANTES de mexer em
 * DNS — enquanto o binding existir, a Cloudflare mantém o roteamento pro
 * Worker e o PATCH de A/AAAA não tem efeito visível") já pressupõe este
 * mecanismo — é o que `buildRollbackPlan` codifica na ORDEM certa (detach
 * antes de qualquer PATCH/POST de DNS).
 *
 * ─── Guard "nunca MX/TXT/CAA" ────────────────────────────────────────────────
 *
 * `ALLOWED_DNS_RECORD_TYPES` é a única lista de tipos que qualquer função
 * deste módulo aceita ler/escrever. `assertAllowedDnsRecordType` lança para
 * qualquer outro tipo — chamado tanto na construção de cada operação de DNS
 * quanto num assert final sobre o PLANO inteiro
 * (`assertPlanTouchesOnlyAllowedRecordTypes`), então mesmo um bug futuro que
 * tente empurrar uma operação de outro tipo pro plano quebra alto, em vez de
 * silenciosamente incluir MX/TXT/CAA numa chamada de mutação.
 */

// ── Constantes de identidade (medidas ao vivo, 25-26/08/2026) ───────────────

/** Zona Cloudflare `diar.ia.br` (confirmada via API em múltiplas sessões do #467). */
export const ZONE_ID = "0c1a216dee80404257ce225a18fae896";

export const APEX_HOSTNAME = "diar.ia.br";

/** Worker que serve o acervo hoje (`workers/site/wrangler.toml`, PR #6167). */
export const WORKER_NAME = "diaria-site";

/** Host `workers.dev` onde o Worker já está deployado, usável para o guard
 * de pré-condição SEM depender do cutover de DNS (não é o apex). */
export const WORKER_DEV_HOST = "diaria-site.diaria.workers.dev";

/** Account ID Cloudflare do projeto — mesmo fallback hardcoded já usado em
 * `scripts/lib/poll-kv.ts` (env var tem precedência; aqui só por consistência
 * com o padrão já estabelecido no repo). */
export const DEFAULT_ACCOUNT_ID = "5d15d8303325211d6976d73051f4b002";

/** Slug de exemplo usado pelas checagens de `/p/{slug}` — o mesmo já citado
 * em `docs/apex-cutover-rollback.md` §5. */
export const SAMPLE_ARCHIVE_SLUG = "35-mil-bolsas-pra-virar-creator-com-ia";

/** User-Agent de navegador — `curl`/fetch sem UA leva challenge 403 da
 * Cloudflare no apex, e 403 de challenge não distingue "no ar" de "fora do
 * ar" (docs/apex-cutover-rollback.md §2). Mesmo UA já usado lá. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";

/** Paths sondados por `--status` no apex e no Worker (host workers.dev). */
export const STATUS_PROBE_PATHS = [
  "/",
  "/subscribe",
  `/p/${SAMPLE_ARCHIVE_SLUG}`,
  "/robots.txt",
  "/sitemap.xml",
] as const;

// ── Tipos de registro DNS: allowlist + guard ─────────────────────────────────

export const ALLOWED_DNS_RECORD_TYPES = ["A", "AAAA"] as const;
export type AllowedDnsRecordType = (typeof ALLOWED_DNS_RECORD_TYPES)[number];

/** Tipos que este script NUNCA lê nem escreve — MX (Cloudflare Email
 * Routing), TXT (SPF, `brevo-code`, `google-site-verification`) e CAA. Só
 * documentado aqui para os testes citarem por nome; a allowlist acima é a
 * fonte de verdade (qualquer tipo fora dela é proibido, não só estes 3). */
export const FORBIDDEN_DNS_RECORD_TYPES = ["MX", "TXT", "CAA"] as const;

/** Lança se `type` não estiver na allowlist. Chamado em todo ponto que
 * constrói uma operação de leitura/escrita de DNS — nunca deixa um tipo
 * fora de A/AAAA chegar a uma URL de mutação. */
export function assertAllowedDnsRecordType(
  type: string,
): asserts type is AllowedDnsRecordType {
  if (!(ALLOWED_DNS_RECORD_TYPES as readonly string[]).includes(type)) {
    throw new Error(
      `apex-cutover: tipo de registro DNS "${type}" fora do escopo permitido ` +
        `(${ALLOWED_DNS_RECORD_TYPES.join("/")}). MX/TXT/CAA nunca entram no cutover.`,
    );
  }
}

// ── Estado PRÉ-cutover (fonte única: docs/apex-cutover-rollback.md §1) ──────

export interface DnsRecordSnapshot {
  id: string;
  type: AllowedDnsRecordType;
  name: string;
  content: string;
  proxied: boolean;
  /** `1` = "auto", exigido pela Cloudflare quando `proxied: true`. */
  ttl: number;
}

/** Estado exato do apex ANTES do cutover, medido ao vivo e reconfirmado
 * múltiplas vezes (25/08, 26/08 14:55Z — "nada envelheceu"). É o alvo que
 * `--rollback` restaura. Qualquer mudança aqui deve vir acompanhada de nova
 * medição contra a zona — nunca editar de memória. */
export const PRE_CUTOVER_DNS_RECORDS: readonly DnsRecordSnapshot[] = [
  {
    id: "9246e7ffc5e6c8df11c979d31ca6cb1e",
    type: "A",
    name: APEX_HOSTNAME,
    content: "104.16.243.55",
    proxied: true,
    ttl: 1,
  },
  {
    id: "1e19bf3285dff54456b607f6564617f7",
    type: "AAAA",
    name: APEX_HOSTNAME,
    content: "2001:12ff:0:2::95",
    proxied: true,
    ttl: 1,
  },
];

// ── Guard de pré-condição do --cutover (o coração desta unidade) ────────────

export interface CutoverPreconditionInput {
  /** Status HTTP observado em `GET /` do Worker (host workers.dev — não o
   * apex, que ainda não é nosso antes do cutover). `null` = erro de rede. */
  workerRootStatus: number | null;
  /** Status HTTP observado em `GET /subscribe` do Worker. */
  workerSubscribeStatus: number | null;
}

export interface CutoverPreconditionResult {
  ready: boolean;
  /** Vazio quando `ready: true`. Cada motivo é uma linha independente —
   * ambos os paths podem falhar ao mesmo tempo, e o operador precisa ver os
   * dois, não só o primeiro. */
  blockers: string[];
}

/**
 * Recusa o cutover se o Worker `diaria-site` não responder 200 em `/` e
 * `/subscribe`. Mecaniza o bloqueio que hoje só existe em prosa (issue #467,
 * comentário de 26/08 20:58Z) — cortar o apex antes disso derruba a
 * superfície de cadastro em produção, sem fallback pra Beehiiv (o custom
 * hostname dela é justamente o que se solta na virada).
 *
 * Único critério: 200 exato em cada path. Um 30x (redirect) ou 4xx/5xx
 * bloqueia igual — a promessa é "serve a página", não "responde alguma
 * coisa". Hoje (26/08/2026) os dois dão 404 — é exatamente o #6359, em
 * implementação paralela a esta unidade.
 */
export function evaluateCutoverPrecondition(
  input: CutoverPreconditionInput,
): CutoverPreconditionResult {
  const blockers: string[] = [];

  if (input.workerRootStatus !== 200) {
    blockers.push(
      `Worker ${WORKER_NAME} respondeu ${input.workerRootStatus ?? "erro de rede"} em "/" ` +
        `(esperado 200) — ver #6359.`,
    );
  }
  if (input.workerSubscribeStatus !== 200) {
    blockers.push(
      `Worker ${WORKER_NAME} respondeu ${input.workerSubscribeStatus ?? "erro de rede"} em "/subscribe" ` +
        `(esperado 200) — ver #6359.`,
    );
  }

  return { ready: blockers.length === 0, blockers };
}

// ── Plano de cutover (--cutover) ─────────────────────────────────────────────

export interface WorkerDomainAttachOp {
  op: "attach";
  hostname: string;
  service: string;
  zoneId: string;
  zoneName: string;
}

export interface WorkerDomainDetachOp {
  op: "detach";
  hostname: string;
  domainId: string;
}

export type WorkerDomainOp = WorkerDomainAttachOp | WorkerDomainDetachOp;

/**
 * Plano do `--cutover`: um único attach de Workers Custom Domain (ver
 * docstring do módulo pro porquê deste mecanismo). Não gera NENHUMA operação
 * de DNS A/AAAA — o attach de Custom Domain cria/gerencia o registro
 * necessário "on your behalf" (doc oficial da Cloudflare); tocar A/AAAA
 * manualmente no cutover seria disputar com esse gerenciamento, não
 * cooperar com ele. É o rollback (`buildRollbackPlan`) que precisa restaurar
 * A/AAAA explicitamente, porque reverter o attach não devolve sozinho o
 * estado anterior (mesma assimetria já registrada em
 * `docs/apex-cutover-rollback.md` §4).
 */
export function buildCutoverPlan(): { workerDomainOp: WorkerDomainAttachOp } {
  return {
    workerDomainOp: {
      op: "attach",
      hostname: APEX_HOSTNAME,
      service: WORKER_NAME,
      zoneId: ZONE_ID,
      zoneName: APEX_HOSTNAME,
    },
  };
}

// ── Plano de rollback (--rollback) ───────────────────────────────────────────

export interface DnsPatchOp {
  op: "patch";
  type: AllowedDnsRecordType;
  id: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

export interface DnsCreateOp {
  op: "create";
  type: AllowedDnsRecordType;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

export type DnsOp = DnsPatchOp | DnsCreateOp;

/**
 * Constrói as operações de DNS que restauram exatamente
 * `PRE_CUTOVER_DNS_RECORDS`, a partir do que existe HOJE na zona (só A/AAAA —
 * nunca passar registros de outro tipo aqui).
 *
 * Regra por registro esperado (mesma do `docs/apex-cutover-rollback.md`
 * §3.2):
 *   - existe um registro do MESMO tipo com o MESMO id → PATCH nesse id.
 *   - existe um registro do MESMO tipo com id DIFERENTE (ex: um custom
 *     domain anexado criou/gerenciou um registro próprio) → PATCH no id NOVO,
 *     mesmo corpo.
 *   - não existe nenhum registro desse tipo → CREATE.
 *
 * `actualRecords` deve conter no máximo 1 registro por tipo A/AAAA no apex —
 * se a zona tiver mais de um (estado anômalo), o primeiro de cada tipo é
 * usado e o caller deve investigar antes de aplicar (esta função não
 * detecta duplicatas; é decisão de leitura, não de escrita).
 */
export function buildRollbackDnsPlan(
  actualRecords: readonly Pick<DnsRecordSnapshot, "id" | "type">[],
): DnsOp[] {
  const ops: DnsOp[] = [];

  for (const expected of PRE_CUTOVER_DNS_RECORDS) {
    assertAllowedDnsRecordType(expected.type);
    const existing = actualRecords.find((r) => {
      assertAllowedDnsRecordType(r.type);
      return r.type === expected.type;
    });

    if (existing) {
      ops.push({
        op: "patch",
        type: expected.type,
        id: existing.id,
        name: expected.name,
        content: expected.content,
        proxied: expected.proxied,
        ttl: expected.ttl,
      });
    } else {
      ops.push({
        op: "create",
        type: expected.type,
        name: expected.name,
        content: expected.content,
        proxied: expected.proxied,
        ttl: expected.ttl,
      });
    }
  }

  assertPlanTouchesOnlyAllowedRecordTypes(ops);
  return ops;
}

/**
 * Plano completo de `--rollback`: detach do Custom Domain PRIMEIRO (se
 * existir), depois restauração de DNS — mesma ordem de
 * `docs/apex-cutover-rollback.md` §3.1/§3.2 ("enquanto o binding existir, a
 * Cloudflare mantém o roteamento pro Worker e o PATCH de A/AAAA não tem
 * efeito visível").
 *
 * @param existingCustomDomainId  id do binding Custom Domain pro apex, se
 *   encontrado em `GET /accounts/{account}/workers/domains` (`null` se não
 *   apareceu — nesse caso não há o que soltar, pula direto pro DNS).
 * @param actualDnsRecords        registros A/AAAA lidos da zona AGORA.
 */
export function buildRollbackPlan(
  existingCustomDomainId: string | null,
  actualDnsRecords: readonly Pick<DnsRecordSnapshot, "id" | "type">[],
): { detachOp: WorkerDomainDetachOp | null; dnsOps: DnsOp[] } {
  const detachOp: WorkerDomainDetachOp | null = existingCustomDomainId
    ? { op: "detach", hostname: APEX_HOSTNAME, domainId: existingCustomDomainId }
    : null;

  return { detachOp, dnsOps: buildRollbackDnsPlan(actualDnsRecords) };
}

/**
 * Defesa em profundidade: mesmo com o tipo `AllowedDnsRecordType` já
 * restringindo o shape em tempo de compilação, esta função reconfirma em
 * RUNTIME que nenhuma operação do plano toca um tipo fora da allowlist —
 * é o que os testes deste módulo travam diretamente, sem depender só do
 * type-checker.
 */
export function assertPlanTouchesOnlyAllowedRecordTypes(
  ops: readonly { type: string }[],
): void {
  for (const op of ops) {
    assertAllowedDnsRecordType(op.type);
  }
}

// ── Verificação pós-mutação (#573 — nunca confiar na resposta do PUT/POST) ──

/**
 * Compara registros LIDOS DE VOLTA da zona (não a resposta do PATCH/POST)
 * contra `PRE_CUTOVER_DNS_RECORDS`. `id` não entra na comparação de propósito
 * — `buildRollbackDnsPlan` já aceita um id diferente do original (ex: um
 * registro recriado pelo Custom Domain e depois restaurado por CREATE ganha
 * id novo); o que importa pro rollback é `content`/`proxied`/`ttl`
 * baterem, não a identidade do registro.
 */
export function verifyDnsRestored(
  actualRecords: readonly Pick<DnsRecordSnapshot, "type" | "content" | "proxied" | "ttl">[],
): { restored: boolean; mismatches: string[] } {
  const mismatches: string[] = [];

  for (const expected of PRE_CUTOVER_DNS_RECORDS) {
    const actual = actualRecords.find((r) => r.type === expected.type);
    if (!actual) {
      mismatches.push(`${expected.type}: ausente na zona (esperado ${expected.content})`);
      continue;
    }
    if (actual.content !== expected.content) {
      mismatches.push(`${expected.type}: content=${actual.content} (esperado ${expected.content})`);
    }
    if (actual.proxied !== expected.proxied) {
      mismatches.push(`${expected.type}: proxied=${actual.proxied} (esperado ${expected.proxied})`);
    }
    if (actual.ttl !== expected.ttl) {
      mismatches.push(`${expected.type}: ttl=${actual.ttl} (esperado ${expected.ttl})`);
    }
  }

  return { restored: mismatches.length === 0, mismatches };
}

/**
 * Verifica se o Custom Domain do apex foi de fato removido — lido de volta
 * via `GET /accounts/{account}/workers/domains`, nunca a partir da resposta
 * do DELETE.
 */
export function verifyCustomDomainDetached(
  actualCustomDomainHostnames: readonly string[],
): boolean {
  return !actualCustomDomainHostnames.includes(APEX_HOSTNAME);
}

/**
 * Verifica se o attach do cutover está de fato refletido — lido de volta via
 * `GET /accounts/{account}/workers/domains`, nunca a partir da resposta do
 * PUT.
 */
export function verifyCutoverAttached(
  actualCustomDomains: readonly { hostname: string; service: string }[],
): boolean {
  return actualCustomDomains.some(
    (d) => d.hostname === APEX_HOSTNAME && d.service === WORKER_NAME,
  );
}
