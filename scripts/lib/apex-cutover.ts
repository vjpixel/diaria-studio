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

/** Marcador de conteúdo esperado em `GET /` — a home própria do Worker
 * (`workers/site/public/index.html`, #6363) declara este `<title>`. Só
 * responder 200 não prova que a página é a certa — um Worker que capture uma
 * exceção e devolva HTML de erro com status 200 passaria despercebido sem
 * esta checagem (achado do fleet review da PR #6364, F1). */
export const EXPECTED_ROOT_MARKER = "<title>diar.ia.br</title>";

/** Host de destino esperado do redirect de `/subscribe` — o perfil hospedado
 * padrão da conta Kit (`https://diar-ia-br.kit.com/`, decisão registrada no
 * PR #6363/#6359: sem página própria, sem UTM próprio — isso é escopo do
 * #6318). `/subscribe` é um REDIRECT por design, nunca 200 — exigir 200
 * estrito aqui bloquearia o cutover pra sempre contra a implementação
 * correta. */
export const EXPECTED_SUBSCRIBE_REDIRECT_HOST = "diar-ia-br.kit.com";

export interface CutoverPreconditionInput {
  /** Status HTTP observado em `GET /` do Worker (host workers.dev — não o
   * apex, que ainda não é nosso antes do cutover). `null` = erro de rede. */
  workerRootStatus: number | null;
  /** Corpo da resposta de `GET /`. `null` = erro de rede ou corpo
   * ilegível — tratado como reprovação (fail closed), nunca como "sem
   * informação, deixa passar". */
  workerRootBody: string | null;
  /** Status HTTP observado em `GET /subscribe` do Worker, com
   * `redirect: "manual"` (preserva o 3xx em vez de segui-lo). */
  workerSubscribeStatus: number | null;
  /** Header `Location` da resposta de `/subscribe`. `null` quando ausente,
   * erro de rede, ou resposta não é redirect. */
  workerSubscribeLocation: string | null;
}

export interface CutoverPreconditionResult {
  ready: boolean;
  /** Vazio quando `ready: true`. Cada motivo é uma linha independente —
   * ambos os paths podem falhar ao mesmo tempo, e o operador precisa ver os
   * dois, não só o primeiro. */
  blockers: string[];
}

/**
 * Recusa o cutover se o Worker `diaria-site` não SERVIR de fato `/` e
 * `/subscribe` — não só "responder alguma coisa". Mecaniza o bloqueio que
 * hoje só existe em prosa (issue #467, comentário de 26/08 20:58Z) — cortar
 * o apex antes disso derruba a superfície de cadastro em produção, sem
 * fallback pra Beehiiv (o custom hostname dela é justamente o que se solta
 * na virada).
 *
 * Dois critérios DIFERENTES, um por path — reflete o que cada um realmente é:
 *
 *   - `/` é uma página própria (#6363): exige 200 **e** o corpo conter
 *     {@link EXPECTED_ROOT_MARKER}. Só o status não basta — um Worker que
 *     capture uma exceção e devolva HTML de erro com 200 passaria pelo guard
 *     antigo (F1 do fleet review da PR #6364) mesmo sem servir a página real.
 *   - `/subscribe` é um REDIRECT por design (`_redirects` → perfil Kit
 *     hospedado, #6359/#6363): exigir 200 aqui bloquearia o cutover pra
 *     sempre, mesmo com a implementação correta no ar. O critério certo é
 *     "redireciona (3xx) para o destino esperado" — 3xx sozinho não basta
 *     (um redirect pro lugar errado também reprova, ver #6365 sobre o
 *     destino do Kit não ter verificação contínua).
 *
 * Erro de rede (`null`) sempre bloqueia (fail closed) — nunca é tratado como
 * "sem informação, deixa passar".
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
  } else if (!input.workerRootBody || !input.workerRootBody.includes(EXPECTED_ROOT_MARKER)) {
    blockers.push(
      `Worker ${WORKER_NAME} respondeu 200 em "/" mas o corpo não contém o marcador esperado ` +
        `(${JSON.stringify(EXPECTED_ROOT_MARKER)}) — responder 200 não é servir a página certa ` +
        `(pode ser uma página de erro capturada). Ver #6359.`,
    );
  }

  const subscribeStatus = input.workerSubscribeStatus;
  const isRedirect = subscribeStatus !== null && subscribeStatus >= 300 && subscribeStatus < 400;
  if (!isRedirect) {
    blockers.push(
      `Worker ${WORKER_NAME} respondeu ${subscribeStatus ?? "erro de rede"} em "/subscribe" ` +
        `(esperado redirect 3xx para ${EXPECTED_SUBSCRIBE_REDIRECT_HOST}) — ver #6359/#6365.`,
    );
  } else {
    let redirectHost: string | null = null;
    if (input.workerSubscribeLocation) {
      try {
        redirectHost = new URL(input.workerSubscribeLocation).host;
      } catch {
        redirectHost = null;
      }
    }
    if (redirectHost !== EXPECTED_SUBSCRIBE_REDIRECT_HOST) {
      blockers.push(
        `Worker ${WORKER_NAME} redirecionou "/subscribe" para ` +
          `"${input.workerSubscribeLocation ?? "(sem header Location)"}" — esperado destino ` +
          `${EXPECTED_SUBSCRIBE_REDIRECT_HOST}. Ver #6365 (destino do Kit sem verificação contínua).`,
      );
    }
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

/** Entrada mínima de Workers Custom Domain que este módulo precisa ler. */
export interface CustomDomainLike {
  id: string;
  hostname: string;
}

/**
 * Todos os Custom Domains que casam o apex. Existe para que o caller NUNCA
 * chame `.find()` cru — a mesma disciplina que `buildRollbackDnsPlan` aplica
 * a registros A/AAAA (achado do silent-failure-hunter na PR #6364).
 *
 * A assimetria que isto elimina: a PR endureceu duplicata de DNS para erro
 * duro, mas deixou a busca de Custom Domain em `.find()` de primeiro match —
 * mesma classe de bug, outro recurso. Se dois bindings casassem o apex
 * (estado de dashboard perdido, rodada anterior que falhou no meio), o
 * `--rollback` desanexaria só o primeiro e deixaria o segundo no ar, com o
 * apex ainda roteando pro Worker enquanto o script diz "restaurado".
 *
 * **Provavelmente inalcançável na prática** — espera-se que a Cloudflare
 * imponha unicidade de hostname no attach. Isto é defesa em profundidade
 * barata, não correção de bug demonstrado; a alternativa considerada era
 * documentar a isenção, e guardar custa menos que explicar por que não.
 */
export function findApexCustomDomains<T extends CustomDomainLike>(
  domains: readonly T[],
  hostname: string = APEX_HOSTNAME,
): T[] {
  return domains.filter((d) => d.hostname === hostname);
}

/**
 * O ÚNICO Custom Domain do apex, ou `null` se não houver nenhum.
 *
 * Lança se houver mais de um — mesmo racional (e mesma forma de mensagem) do
 * guard de duplicata de `buildRollbackDnsPlan`: não dá pra saber qual é o
 * "certo" sem revisão humana, e desanexar N-1 em silêncio é pior que travar.
 * Use em caminhos de MUTAÇÃO (`--rollback`); `--status` deve reportar a
 * duplicata em vez de lançar, porque a função dele é justamente mostrar o
 * estado, inclusive um estado anômalo.
 */
export function selectSingleApexCustomDomain<T extends CustomDomainLike>(
  domains: readonly T[],
  hostname: string = APEX_HOSTNAME,
): T | null {
  const matches = findApexCustomDomains(domains, hostname);
  if (matches.length > 1) {
    throw new Error(
      `apex-cutover: ${matches.length} Workers Custom Domains encontrados para ${hostname} ` +
        `(esperado no máximo 1) — não dá pra saber qual desanexar sem revisão humana. ` +
        `Rode --status, resolva a duplicata no painel da Cloudflare, e repita --rollback.`,
    );
  }
  return matches[0] ?? null;
}

export interface DnsDeleteOp {
  op: "delete";
  type: AllowedDnsRecordType;
  id: string;
}

/** Um passo do plano de cutover, na ORDEM EM QUE DEVE SER EXECUTADO. Mesma
 * técnica de união discriminada de `RollbackStep` (ver docstring lá pro
 * racional: com um único array ordenado, a ordem é uma propriedade do PLANO,
 * testável diretamente, em vez de uma convenção imperativa dentro do
 * executor que um refactor descuidado pode inverter sem quebrar tipo nem
 * teste de unidade). */
export type CutoverStep =
  | { readonly kind: "dns-delete"; readonly dns: DnsDeleteOp }
  | { readonly kind: "attach"; readonly attach: WorkerDomainAttachOp };

export type CutoverPlan = readonly CutoverStep[];

/**
 * Constrói os passos de remoção de A/AAAA legado, um por tipo presente na
 * zona HOJE. Mesma disciplina de duplicata de `buildRollbackDnsPlan`: mais
 * de 1 registro do mesmo tipo é erro DURO, nunca "apaga o primeiro e segue"
 * — não dá pra saber qual dos N é o resíduo da Beehiiv sem revisão humana, e
 * apagar o errado por adivinhação é pior que travar.
 *
 * @param actualRecords  registros A/AAAA lidos da zona AGORA (só id+type —
 *   o delete não precisa de mais nada).
 */
export function buildCutoverDnsDeletePlan(
  actualRecords: readonly Pick<DnsRecordSnapshot, "id" | "type">[],
): DnsDeleteOp[] {
  const ops: DnsDeleteOp[] = [];

  for (const type of ALLOWED_DNS_RECORD_TYPES) {
    const matches = actualRecords.filter((r) => {
      assertAllowedDnsRecordType(r.type);
      return r.type === type;
    });

    if (matches.length > 1) {
      throw new Error(
        `apex-cutover: ${matches.length} registros ${type} encontrados na zona para ` +
          `${APEX_HOSTNAME} (esperado no máximo 1) — não dá pra saber qual é o "certo" sem revisão ` +
          `humana. Rode --status, resolva a duplicata na zona da Cloudflare, e repita --cutover.`,
      );
    }
    const existing = matches[0];
    if (existing) {
      ops.push({ op: "delete", type, id: existing.id });
    }
  }

  return ops;
}

/**
 * Plano completo do `--cutover`: remoção do A/AAAA legado (se existir)
 * PRIMEIRO, attach do Workers Custom Domain DEPOIS — nessa ordem, dentro do
 * MESMO `--apply` (#6373).
 *
 * **Por que a remoção precisa vir ANTES do attach, e por que automatizar
 * (opção A da issue) em vez de só recusar com um guard (opção B):**
 * a 1ª execução real deste script (26/08/2026, 23:12 UTC) tentou o attach
 * direto contra uma zona com A/AAAA legado apontando pro IP da Beehiiv —
 * `PUT /accounts/{id}/workers/domains` recusou com HTTP 409
 * (`"Hostname ... already has externally managed DNS records"`). Isso por
 * si só é inofensivo (mutação nunca aconteceu) — mas o passo humano que
 * precede o `--cutover --apply` (Beehiiv → Disconnect domain) já tinha
 * rodado, e SÓ a Beehiiv desconectada + Custom Domain ainda não anexado
 * deixa a zona apontando pra um IP que a própria Cloudflare marca como
 * "proibido" pra outros hostnames — outage real de ~1 min, medido ao vivo
 * (ver `docs/apex-cutover-rollback.md`, blockquote de topo, e #6373).
 * Um guard que só detecta e recusa (opção B) devolveria o operador pro
 * mesmo ponto de partida — Beehiiv já desconectada, zona ainda com o A/AAAA
 * problemático — e a janela de outage reabriria assim que ele rodasse
 * `--cutover --apply` de novo depois de remover manualmente. A automação
 * (opção A) fecha a CLASSE do bug: a mesma invocação que já é o ponto de
 * não-retorno (depois do `Disconnect domain` manual) remove o obstáculo e
 * ataca o attach, sem depender do operador lembrar de um passo manual extra
 * no meio de um incidente.
 *
 * O attach de Custom Domain cria/gerencia o registro DNS necessário "on your
 * behalf" (doc oficial da Cloudflare) — por isso o plano deste módulo só
 * REMOVE o A/AAAA legado, nunca cria um novo; criar seria disputar com esse
 * gerenciamento, não cooperar com ele. É o rollback (`buildRollbackPlan`)
 * que precisa restaurar A/AAAA explicitamente depois, porque reverter o
 * attach não devolve sozinho o estado anterior (mesma assimetria já
 * registrada em `docs/apex-cutover-rollback.md` §4).
 *
 * @param actualDnsRecords  registros A/AAAA lidos da zona AGORA. Lança se
 *   houver mais de 1 registro do mesmo tipo (ver `buildCutoverDnsDeletePlan`).
 */
export function buildCutoverPlan(
  actualDnsRecords: readonly Pick<DnsRecordSnapshot, "id" | "type">[],
): CutoverPlan {
  const steps: CutoverStep[] = [];

  for (const dns of buildCutoverDnsDeletePlan(actualDnsRecords)) {
    steps.push({ kind: "dns-delete", dns });
  }

  steps.push({
    kind: "attach",
    attach: {
      op: "attach",
      hostname: APEX_HOSTNAME,
      service: WORKER_NAME,
      zoneId: ZONE_ID,
      zoneName: APEX_HOSTNAME,
    },
  });

  return steps;
}

/** Extrai só os passos de remoção de DNS de um `CutoverPlan`, na ordem em
 * que aparecem — usado pelo assert de allowlist e por qualquer caller que
 * precise só do lado DNS sem se importar com o attach. */
export function extractCutoverDnsDeleteOps(plan: CutoverPlan): DnsDeleteOp[] {
  return plan
    .filter((s): s is { kind: "dns-delete"; dns: DnsDeleteOp } => s.kind === "dns-delete")
    .map((s) => s.dns);
}

/** Extrai o passo de attach de um `CutoverPlan` — sempre presente (todo
 * `CutoverPlan` termina com exatamente 1 attach); lança em vez de devolver
 * `undefined` porque a ausência seria bug interno deste módulo, não um
 * estado de zona esperável. */
export function extractCutoverAttachOp(plan: CutoverPlan): WorkerDomainAttachOp {
  const step = plan.find((s): s is { kind: "attach"; attach: WorkerDomainAttachOp } => s.kind === "attach");
  if (!step) {
    throw new Error("apex-cutover: plano de cutover sem passo de attach — bug interno em buildCutoverPlan.");
  }
  return step.attach;
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
 * `actualRecords` deve conter no máximo 1 registro por tipo A/AAAA no apex.
 * **Duplicata é erro DURO, não decisão silenciosa de leitura** (achado do
 * silent-failure-hunter na PR #6364, P1): antes desta versão, mais de um
 * registro do mesmo tipo fazia esta função pegar "o primeiro" e seguir —
 * um PATCH no primeiro A com um segundo A stale ainda na zona causa
 * resolução DNS em round-robin, e o operador só saberia investigando a zona
 * por conta própria (o docstring dizia isso, mas nenhum caller de fato
 * investigava). Agora lança antes de gerar qualquer operação — não dá pra
 * saber qual dos N registros é o "certo" sem revisão humana, e gerar um
 * plano que ignora N-1 deles seria pior que travar.
 */
export function buildRollbackDnsPlan(
  actualRecords: readonly Pick<DnsRecordSnapshot, "id" | "type">[],
): DnsOp[] {
  const ops: DnsOp[] = [];

  for (const expected of PRE_CUTOVER_DNS_RECORDS) {
    assertAllowedDnsRecordType(expected.type);
    const matches = actualRecords.filter((r) => {
      assertAllowedDnsRecordType(r.type);
      return r.type === expected.type;
    });

    if (matches.length > 1) {
      throw new Error(
        `apex-cutover: ${matches.length} registros ${expected.type} encontrados na zona para ` +
          `${expected.name} (esperado no máximo 1) — não dá pra saber qual é o "certo" sem revisão ` +
          `humana. Rode --status, resolva a duplicata na zona da Cloudflare, e repita --rollback.`,
      );
    }
    const existing = matches[0];

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

/** Um passo do plano de rollback, na ORDEM EM QUE DEVE SER EXECUTADO. União
 * discriminada em vez de dois campos independentes (`detachOp`/`dnsOps`) de
 * propósito (achado do pr-test-analyzer na PR #6364, F2): com dois campos
 * separados, nada no TYPE nem no runtime impedia `runRollback` de aplicar os
 * `dnsOps` antes do `detachOp` — trocar a ordem das duas seções dentro de
 * `runRollback` passava nos 32 testes da PR sem nenhuma detecção, mesmo essa
 * ordem sendo a invariante mais citada no código e no doc
 * (`docs/apex-cutover-rollback.md` §3.1: "enquanto o binding existir, a
 * Cloudflare mantém o roteamento pro Worker e o PATCH de A/AAAA não tem
 * efeito visível"). Com um ÚNICO array ordenado, produzido só por
 * `buildRollbackPlan`, a ordem é uma propriedade do PLANO — testável
 * diretamente ("o passo de detach, quando existe, é sempre `steps[0]`") em
 * vez de uma convenção imperativa dentro do executor. */
export type RollbackStep =
  | { readonly kind: "detach"; readonly detach: WorkerDomainDetachOp }
  | { readonly kind: "dns"; readonly dns: DnsOp };

export type RollbackPlan = readonly RollbackStep[];

/**
 * Plano completo de `--rollback`: detach do Custom Domain PRIMEIRO (se
 * existir), depois restauração de DNS — mesma ordem de
 * `docs/apex-cutover-rollback.md` §3.1/§3.2. A ordem nasce da ordem de
 * `push` abaixo — não existe jeito de o executor (`runRollback`) aplicar os
 * passos fora de ordem sem iterar o array ao contrário, o que seria óbvio em
 * qualquer diff/review.
 *
 * @param existingCustomDomainId  id do binding Custom Domain pro apex, se
 *   encontrado em `GET /accounts/{account}/workers/domains` (`null` se não
 *   apareceu — nesse caso não há passo de detach, o plano começa direto no
 *   DNS).
 * @param actualDnsRecords        registros A/AAAA lidos da zona AGORA. Lança
 *   se houver mais de 1 registro do mesmo tipo (ver `buildRollbackDnsPlan`).
 */
export function buildRollbackPlan(
  existingCustomDomainId: string | null,
  actualDnsRecords: readonly Pick<DnsRecordSnapshot, "id" | "type">[],
): RollbackPlan {
  const steps: RollbackStep[] = [];

  if (existingCustomDomainId) {
    steps.push({
      kind: "detach",
      detach: { op: "detach", hostname: APEX_HOSTNAME, domainId: existingCustomDomainId },
    });
  }

  for (const dns of buildRollbackDnsPlan(actualDnsRecords)) {
    steps.push({ kind: "dns", dns });
  }

  return steps;
}

/** Extrai só as operações de DNS de um `RollbackPlan`, na ordem em que
 * aparecem — usado pelo assert de allowlist (`assertPlanTouchesOnlyAllowedRecordTypes`
 * não entende `RollbackStep`, só `{type: string}`) e por qualquer caller que
 * precise só do lado DNS sem se importar com o detach. */
export function extractRollbackDnsOps(plan: RollbackPlan): DnsOp[] {
  return plan.filter((s): s is { kind: "dns"; dns: DnsOp } => s.kind === "dns").map((s) => s.dns);
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
 *
 * **Duplicata vira `mismatches`, nunca `restored: true` cego** (achado do
 * silent-failure-hunter na PR #6364, P1 — o cenário exato de "sucesso
 * reportado sem ter acontecido", e num ROLLBACK, quando já se está
 * consertando outra coisa). Antes desta versão, com 2 registros A na zona
 * (1 restaurado certo + 1 stale apontando pro Worker), esta função olhava só
 * o primeiro `.find()`, achava correto, e o caller imprimia "restaurado e
 * verificado" com o stale causando resolução DNS em round-robin. Agora
 * qualquer tipo com mais de 1 registro na zona reprova explicitamente, sem
 * tentar adivinhar qual dos N é o válido.
 */
export function verifyDnsRestored(
  actualRecords: readonly Pick<DnsRecordSnapshot, "type" | "content" | "proxied" | "ttl">[],
): { restored: boolean; mismatches: string[] } {
  const mismatches: string[] = [];

  for (const expected of PRE_CUTOVER_DNS_RECORDS) {
    const matches = actualRecords.filter((r) => r.type === expected.type);
    if (matches.length > 1) {
      mismatches.push(
        `${expected.type}: ${matches.length} registros encontrados na zona (esperado 1) — ` +
          `duplicata não resolvida, DNS pode estar em round-robin com um registro stale. Revisão manual necessária.`,
      );
      continue;
    }
    const actual = matches[0];
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
 * Verifica se os tipos de A/AAAA que o `--cutover` mandou apagar de fato
 * sumiram da zona — lido de volta via GET, nunca a partir da resposta do
 * DELETE (#573). Só checa os tipos passados em `typesDeleted` (os que o
 * plano de fato tentou remover) — um tipo que nunca existiu na zona não é
 * "não removido", é irrelevante pra esta verificação.
 *
 * Usada pelo `--cutover --apply` ANTES do attach: se algum tipo apagado
 * ainda aparecer na releitura, o caller aborta sem tentar o `PUT` — nunca
 * segue pro attach num estado incerto (#6373).
 */
export function verifyDnsRemoved(
  actualRecords: readonly Pick<DnsRecordSnapshot, "type">[],
  typesDeleted: readonly AllowedDnsRecordType[],
): { removed: boolean; remaining: AllowedDnsRecordType[] } {
  const remaining = typesDeleted.filter((type) => actualRecords.some((r) => r.type === type));
  return { removed: remaining.length === 0, remaining };
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
