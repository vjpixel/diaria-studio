/**
 * scripts/postmaster-register-domain.ts (#4539)
 *
 * Registra, VERIFICA e lista domínios no Google Postmaster Tools via API.
 * Substitui o trabalho manual no painel (https://postmaster.google.com).
 *
 * **Por que v2 e não v1.** `scripts/postmaster-spam-sync.ts` (#4154) fala com a
 * **v1**, que é read-only: `domains.get`, `domains.list`, `trafficStats.*` — não
 * existe `domains.create` lá. Criação, verificação e emissão de token só
 * aparecem na **v2**. Ter olhado só a v1 foi o que fez esta issue ser
 * classificada como "trabalho manual de painel" por um tempo — não era.
 *
 * **Um domínio registrado NÃO serve pra nada até ser verificado.** Logo após o
 * `create` o domínio fica `verificationState: UNVERIFIED` e
 * `permission: NONE` — o painel não devolve métrica nenhuma nesse estado.
 * Confirmado ao vivo em 260804: `diaria.beehiiv.com` estava registrado desde
 * 260116 e nunca saiu de `NONE`, ou seja, meses de registro sem um único dado.
 * Por isso `--verify` existe e o fluxo completo é create → verify.
 *
 * **Scope.** A v2 exige `.../auth/postmaster` OU `.../auth/postmaster.domain`;
 * `oauth-setup.ts` pede o segundo (mais estreito) SOMADO ao
 * `postmaster.readonly` que o sync diário de spamRate usa — são eixos
 * diferentes, não superset/subset. Um token emitido antes do #4539 **não** tem
 * o scope novo e falha aqui com 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT` (risco
 * NOVO desta issue — é a 1ª vez que o projeto pede este scope; não confundir
 * com o #4154, ver abaixo). O conserto é re-rodar `oauth-setup.ts` e reaprovar
 * no browser, mesma armadilha anotada no bloco `webmasters` de `oauth-setup.ts`.
 *
 * **O que o #4154 realmente ensinou.** Aquele incidente confundiu "a conta não
 * é dona do domínio" (403 de POSSE — a premissa com que a issue foi fechada, e
 * que se provou errada: `vjpixel@gmail.com` era OWNER de `clarice.ai` o tempo
 * todo) com "a API nunca foi habilitada no projeto GCP" (403
 * `SERVICE_DISABLED`). Os dois são 403 e a ação de conserto é completamente
 * diferente — por isso `classifyCreateResponse` separa `forbidden` de
 * `service_disabled`. Habilitação de API e concessão de scope são
 * independentes: faltar uma dá 403 mesmo com a outra concedida.
 *
 * **Idempotente por construção.** `ALREADY_EXISTS` é tratado como SUCESSO, não
 * erro — rodar de novo nunca falha, o que é pré-requisito pra isto poder entrar
 * numa rodada autônoma ou num preflight sem virar falso alarme. Cuidado: 409
 * sozinho NÃO prova `ALREADY_EXISTS` (ver `classifyCreateResponse`).
 *
 * **O que este painel cobre, e o que não cobre.** O Postmaster agrega pelo
 * domínio que ASSINA o DKIM, não pelo From visível. Levantamento do DNS de
 * `diar.ia.br` (260804): existem `resend._domainkey` e `cf2024-1._domainkey`,
 * `brevo-code` de domínio autenticado, SPF `include:amazonses.com` em
 * `send.` e `_dmarc` com `p=reject`. Ou seja, os envios de **apoiadores,
 * reativação e canal Brevo assinam com DKIM próprio de `diar.ia.br`** e
 * APARECEM aqui. Já a **diária sai de `diaria@mail.beehiiv.com`**, assinada
 * pela Beehiiv, e NÃO entra neste painel — pra ela o domínio relevante é
 * `diaria.beehiiv.com`, cuja verificação depende da Beehiiv (o TXT teria que
 * ir no DNS deles), não de nós.
 *
 * Uso:
 *   npx tsx scripts/postmaster-register-domain.ts [--domain diar.ia.br] [--dry-run]
 *   npx tsx scripts/postmaster-register-domain.ts --verify [--domain diar.ia.br]
 *   npx tsx scripts/postmaster-register-domain.ts --list
 */
import { gFetch } from "./google-auth.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";

/** Base v2 — a v1 (usada por `postmaster-spam-sync.ts`) é read-only. */
export const POSTMASTER_V2_BASE = "https://gmailpostmastertools.googleapis.com/v2";

/** Domínio-alvo do #4539. Sobreponível com `--domain` pra operar QUALQUER outro
 * domínio da conta — ex: auditar/verificar `clarice.ai` (#4154) sem editar o
 * script. Não é "o domínio do canal Brevo": a Brevo autentica o PRÓPRIO
 * `diar.ia.br` (TXT `brevo-code` na raiz), então esse caso já é o default. */
export const DEFAULT_DOMAIN = "diar.ia.br";

export type RegisterOutcome =
  | "created"
  | "already_exists"
  | "scope_insufficient"
  | "service_disabled"
  | "forbidden"
  | "unauthenticated"
  | "conflict_aborted"
  | "invalid_argument"
  | "error";

/** Único lugar onde vive a correlação outcome→ok. `classify()` abaixo deriva
 * `ok` daqui em vez de cada branch repetir `ok: true` na mão — sem isso, a
 * invariante ("ok vale exatamente pra estes dois") só existiria em comentário
 * e num teste, e um branch novo poderia violá-la em silêncio. */
const OK_OUTCOMES: ReadonlySet<RegisterOutcome> = new Set<RegisterOutcome>(["created", "already_exists"]);

export interface RegisterClassification {
  outcome: RegisterOutcome;
  /** true quando o estado final desejado foi atingido. É este campo, não
   * `outcome`, que decide o exit code. Derivado de `OK_OUTCOMES`, nunca
   * escrito à mão — ver `classify()`. */
  ok: boolean;
  /** Ação concreta pro operador. Sempre vazio quando `ok` (garantido por
   * construção em `classify()`, não por disciplina do chamador). */
  action: string;
}

/** Smart constructor: garante `ok` derivado e `action` vazio no sucesso. */
function classify(outcome: RegisterOutcome, action = ""): RegisterClassification {
  const ok = OK_OUTCOMES.has(outcome);
  return { outcome, ok, action: ok ? "" : action };
}

/**
 * Pure: classifica a resposta do `domains.create`. Separado do I/O porque cada
 * ramo tem uma ação de conserto DIFERENTE — e o #4154 é a prova de que
 * confundir dois 403 entre si custa uma sessão inteira de debug.
 *
 * `body` é o texto cru da resposta (JSON de erro do Google, ou vazio) — a
 * classificação casa por substring de código canônico (`ALREADY_EXISTS`,
 * `SERVICE_DISABLED`, ...), que é estável na envelope de erro da Google API,
 * em vez de depender do shape exato do JSON.
 */
export function classifyCreateResponse(status: number, body: string): RegisterClassification {
  const b = body ?? "";
  if (status >= 200 && status < 300) return classify("created");

  // 409 mapeia DOIS códigos canônicos no modelo de erro da Google:
  // ALREADY_EXISTS e ABORTED (conflito transitório de escrita concorrente).
  // Tratar 409 cru como sucesso reportaria "já estava registrado" com exit 0
  // pra um domínio que NUNCA foi registrado — a única falha silenciosa
  // possível neste arquivo, achada no review do #4585. Só o corpo decide.
  if (b.includes("ALREADY_EXISTS")) return classify("already_exists");
  if (b.includes("ABORTED")) {
    return classify(
      "conflict_aborted",
      "Conflito transitório (ABORTED) — o domínio NÃO foi registrado. Rode de novo.",
    );
  }
  // 409 sem código reconhecido: na prática é ALREADY_EXISTS (é o único 409 que
  // este endpoint documenta), então segue contando como sucesso pra não
  // quebrar a idempotência. O ramo ABORTED acima já tirou o caso perigoso.
  if (status === 409) return classify("already_exists");

  if (b.includes("SERVICE_DISABLED") || b.includes("has not been used in project")) {
    return classify(
      "service_disabled",
      "Ative a Gmail Postmaster Tools API no projeto GCP deste OAuth client " +
        "(console.cloud.google.com → APIs → Gmail Postmaster Tools API → Ativar). " +
        "Scope concedido não basta — habilitação é independente (#4154).",
    );
  }
  if (b.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || b.includes("insufficient authentication scopes")) {
    return classify(
      "scope_insufficient",
      "O token em data/.credentials.json foi emitido sem o scope postmaster.domain. " +
        "Rode `npx tsx scripts/oauth-setup.ts` e reaprove no browser (#4539).",
    );
  }
  // `gFetch` já retenta 401 uma vez com token renovado; um 401 que chega aqui
  // significa que a renovação não resolveu (refresh token revogado/expirado —
  // apps OAuth em "Testing" expiram em 7 dias, #1973). Sem este ramo, cairia
  // no genérico e imprimiria JSON cru sem apontar o conserto.
  if (status === 401) {
    return classify(
      "unauthenticated",
      "401 mesmo após o retry com token renovado — refresh token revogado ou expirado " +
        "(apps OAuth em 'Testing' expiram em 7 dias, #1973). Rode `npx tsx scripts/oauth-setup.ts`.",
    );
  }
  if (status === 403) {
    // Este é o ramo do #4154: a issue foi FECHADA com a premissa de que a conta
    // não era dona do domínio, e reaberta ao confirmar que era OWNER o tempo
    // todo — a causa real era a API desabilitada (ramo acima).
    return classify(
      "forbidden",
      "403 sem código de scope/API reconhecido — a causa mais provável é posse do domínio " +
        "não verificada para esta conta Google. Confira em postmaster.google.com/managedomains " +
        "e no Search Console. Atenção ao #4154: a premissa 'não somos donos' já se provou " +
        "errada uma vez, e o culpado era a API desabilitada — descarte aquele ramo antes deste.",
    );
  }
  if (status === 400 || b.includes("INVALID_ARGUMENT")) {
    return classify(
      "invalid_argument",
      "A API recusou o domínio informado. Confira a grafia em --domain (sem esquema, sem barra).",
    );
  }
  // 5xx observado ao vivo (260804): um `:verify` num domínio JÁ verificado
  // devolveu 500 INTERNAL, e a invocação seguinte passou limpa. É transitório
  // do lado da Google — dizer "rode de novo" evita que o operador vá caçar
  // configuração que não está quebrada.
  if (status >= 500) {
    return classify(
      "error",
      `HTTP ${status} do lado da Google (transitório — já observado ao vivo em 260804). ` +
        `Rode de novo antes de investigar. Corpo: ${b.slice(0, 200)}`,
    );
  }
  return classify("error", `HTTP ${status} inesperado. Corpo: ${b.slice(0, 300)}`);
}

/** Mensagem de erro para falhas de LEITURA (list/get/token), onde o vocabulário
 * de `create` não se aplica. Sem isto, um 409 numa listagem imprimiria
 * "falha ao listar (already_exists)" — texto sem sentido pro operador. */
function readFailureMessage(op: string, status: number, body: string): string {
  const c = classifyCreateResponse(status, body);
  const detail = c.ok ? body.slice(0, 300) : c.action || body.slice(0, 300);
  return `[postmaster-register-domain] falha ao ${op} (HTTP ${status}): ${detail}`;
}

/** Lista os domínios da conta, com estado de verificação — o estado importa
 * tanto quanto a presença (registrado mas UNVERIFIED = zero dado). */
export async function listDomains(
  fetchImpl: typeof gFetch = gFetch,
): Promise<Array<{ domain: string; verified: boolean; permission: string }>> {
  const res = await fetchImpl(`${POSTMASTER_V2_BASE}/domains`);
  const body = await res.text();
  if (!res.ok) throw new Error(readFailureMessage("listar", res.status, body));

  let parsed: { domains?: Array<{ name?: string; verificationState?: string; permission?: string }> };
  try {
    parsed = JSON.parse(body);
  } catch {
    // Um 2xx com corpo não-JSON (proxy, resposta truncada) jogaria um
    // SyntaxError cru sem status nem trecho do corpo — regressão em relação a
    // todo o resto deste arquivo, que sempre erra com contexto.
    throw new Error(`[postmaster-register-domain] resposta 2xx não é JSON válido: ${body.slice(0, 300)}`);
  }
  return (parsed.domains ?? [])
    .map((d) => ({
      domain: (d.name ?? "").replace(/^domains\//, ""),
      verified: d.verificationState === "VERIFIED",
      permission: d.permission ?? "UNKNOWN",
    }))
    .filter((d) => d.domain);
}

export async function registerDomain(
  domain: string,
  fetchImpl: typeof gFetch = gFetch,
): Promise<RegisterClassification> {
  const res = await fetchImpl(`${POSTMASTER_V2_BASE}/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domainId: domain }),
  });
  return classifyCreateResponse(res.status, await res.text());
}

/** Token TXT que prova posse. É o MESMO `google-site-verification=` que o
 * Search Console usa (por conta+domínio), então quem já é `siteOwner` de
 * `sc-domain:{domain}` no GSC normalmente já tem o registro no DNS e não
 * precisa criar nada — só chamar `verifyDomain`. */
export async function getVerificationToken(domain: string, fetchImpl: typeof gFetch = gFetch): Promise<string> {
  const res = await fetchImpl(
    `${POSTMASTER_V2_BASE}/domains/${encodeURIComponent(domain)}/verificationToken?verificationMethod=TXT`,
  );
  const body = await res.text();
  if (!res.ok) throw new Error(readFailureMessage("obter o token de verificação", res.status, body));
  let parsed: { token?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`[postmaster-register-domain] token: resposta 2xx não é JSON válido: ${body.slice(0, 300)}`);
  }
  if (!parsed.token) throw new Error(`[postmaster-register-domain] resposta sem campo "token": ${body.slice(0, 300)}`);
  return parsed.token;
}

export async function verifyDomain(
  domain: string,
  fetchImpl: typeof gFetch = gFetch,
): Promise<RegisterClassification> {
  const res = await fetchImpl(`${POSTMASTER_V2_BASE}/domains/${encodeURIComponent(domain)}:verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verificationMethod: "TXT" }),
  });
  const body = await res.text();
  if (res.ok) return classify("created");
  return classifyCreateResponse(res.status, body);
}

/** Nota impressa no sucesso — ver "O que este painel cobre" no topo. */
export const DKIM_SCOPE_NOTE =
  "[postmaster-register-domain] nota: o Postmaster agrega pelo domínio que ASSINA o DKIM. " +
  "Envios de apoiadores/reativação/Brevo assinam com DKIM de diar.ia.br e APARECEM aqui; " +
  "a diária sai de diaria@mail.beehiiv.com (DKIM da Beehiiv) e NÃO entra (#4539).";

export async function main(argv: string[]): Promise<void> {
  const domain = getStringArg(argv, "domain", { example: DEFAULT_DOMAIN }) ?? DEFAULT_DOMAIN;
  const dryRun = hasFlag(argv, "dry-run");
  const wantVerify = hasFlag(argv, "verify");
  const wantList = hasFlag(argv, "list");

  // Flag passada explicitamente que seria ignorada em silêncio é erro, não
  // no-op — mesma disciplina do `getStringArg` acima (#4573).
  if (wantList && (wantVerify || dryRun)) {
    throw new Error("--list não combina com --verify/--dry-run — rode um de cada vez.");
  }

  if (wantList) {
    const domains = await listDomains();
    if (!domains.length) {
      console.log("[postmaster-register-domain] nenhum domínio registrado nesta conta.");
      return;
    }
    const lines = domains.map(
      (d) => `  ${d.domain} — ${d.verified ? "VERIFICADO" : "NÃO VERIFICADO (sem dado no painel)"}, permission=${d.permission}`,
    );
    console.log(`[postmaster-register-domain] ${domains.length} domínio(s):\n${lines.join("\n")}`);
    return;
  }

  if (dryRun) {
    const what = wantVerify ? "verificaria" : "registraria";
    console.log(`[postmaster-register-domain] dry-run: ${what} "${domain}".`);
    return;
  }

  if (wantVerify) {
    const token = await getVerificationToken(domain);
    console.log(`[postmaster-register-domain] TXT esperado na raiz de ${domain}:\n  ${token}`);
    const result = await verifyDomain(domain);
    if (!result.ok) {
      console.error(`[postmaster-register-domain] verificação FALHOU (${result.outcome}): ${result.action}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[postmaster-register-domain] OK: "${domain}" VERIFICADO.`);
    console.log(DKIM_SCOPE_NOTE);
    return;
  }

  const result = await registerDomain(domain);
  if (!result.ok) {
    console.error(`[postmaster-register-domain] FALHOU (${result.outcome}): ${result.action}`);
    process.exitCode = 1;
    return;
  }
  const suffix = result.outcome === "already_exists" ? " (já estava registrado — no-op)" : "";
  console.log(`[postmaster-register-domain] OK: "${domain}" registrado${suffix}.`);
  // Registrar não basta: sem verificar, permission fica NONE e o painel não
  // devolve métrica nenhuma. Dizer isso aqui evita o caso `diaria.beehiiv.com`
  // (registrado em 260116, nunca verificado, meses sem dado).
  console.log(`[postmaster-register-domain] próximo passo: --verify --domain ${domain}`);
  console.log(DKIM_SCOPE_NOTE);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[postmaster-register-domain] erro: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
