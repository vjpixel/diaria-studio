/**
 * scripts/postmaster-register-domain.ts (#4539)
 *
 * Registra um domínio no Google Postmaster Tools via API, e lista os já
 * registrados. Substitui o cadastro manual pelo painel
 * (https://postmaster.google.com).
 *
 * **Por que v2 e não v1.** `scripts/postmaster-spam-sync.ts` (#4154) fala com a
 * **v1**, que é read-only: `domains.get`, `domains.list`, `trafficStats.*` — não
 * existe `domains.create` lá. O método de criação só aparece na **v2**
 * (`POST https://gmailpostmastertools.googleapis.com/v2/domains`, body
 * `{"domainId": "..."}`). Ter olhado só a v1 foi o que fez esta issue ser
 * classificada como "trabalho manual de painel" por um tempo — não era.
 *
 * **Scope.** A v2 exige `.../auth/postmaster` OU `.../auth/postmaster.domain`;
 * `oauth-setup.ts` pede o segundo (mais estreito) SOMADO ao
 * `postmaster.readonly` que o sync diário de spamRate usa — são eixos
 * diferentes, não superset/subset. Um token emitido antes do #4539 **não** tem
 * o scope novo e falha aqui com 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT`; o
 * conserto é re-rodar `oauth-setup.ts` e reaprovar no browser (mesma armadilha
 * documentada no #4546 pro par `webmasters`).
 *
 * **Habilitação da API é independente do scope.** Faltar a Gmail Postmaster
 * Tools API ativada no projeto GCP dá 403 `SERVICE_DISABLED` mesmo com o scope
 * concedido (achado #4154, 260730) — por isso `classifyCreateResponse`
 * distingue os dois 403: a ação de conserto é completamente diferente.
 *
 * **Idempotente por construção.** `ALREADY_EXISTS` é tratado como SUCESSO, não
 * erro — rodar de novo nunca falha, o que é pré-requisito pra isto poder entrar
 * numa rodada autônoma ou num preflight sem virar falso alarme.
 *
 * Uso:
 *   npx tsx scripts/postmaster-register-domain.ts [--domain diar.ia.br] [--dry-run]
 *   npx tsx scripts/postmaster-register-domain.ts --list
 */
import { gFetch } from "./google-auth.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";

/** Base v2 — a v1 (usada por `postmaster-spam-sync.ts`) não tem `domains.create`. */
export const POSTMASTER_V2_BASE = "https://gmailpostmastertools.googleapis.com/v2";

/** Domínio-alvo do #4539. Sobreponível com `--domain` pra reuso (ex: o domínio
 * do canal Brevo, que é quem de fato assina com o NOSSO DKIM — ver a ressalva
 * de "painel vazio" no rodapé desta doc). */
export const DEFAULT_DOMAIN = "diar.ia.br";

export type RegisterOutcome =
  | "created"
  | "already_exists"
  | "scope_insufficient"
  | "service_disabled"
  | "forbidden"
  | "invalid_argument"
  | "error";

export interface RegisterClassification {
  outcome: RegisterOutcome;
  /** true quando o estado final desejado (domínio registrado) foi atingido —
   * `created` e `already_exists` são os dois casos. É este campo, não
   * `outcome`, que decide o exit code. */
  ok: boolean;
  /** Ação concreta pro operador. Vazio quando `ok`. */
  action: string;
}

/**
 * Pure: classifica a resposta do `domains.create`. Separado do I/O porque cada
 * ramo tem uma ação de conserto DIFERENTE, e distinguir 403-de-scope de
 * 403-de-API-desligada é exatamente o que custou uma sessão de debug no #4154.
 *
 * `body` é o texto cru da resposta (pode ser JSON de erro do Google ou vazio) —
 * a classificação casa por substring de código canônico (`ALREADY_EXISTS`,
 * `SERVICE_DISABLED`, ...), que é estável na envelope de erro da Google API,
 * em vez de depender do shape exato do JSON.
 */
export function classifyCreateResponse(status: number, body: string): RegisterClassification {
  const b = body ?? "";
  if (status >= 200 && status < 300) {
    return { outcome: "created", ok: true, action: "" };
  }
  // 409 é o status canônico de ALREADY_EXISTS, mas a Google às vezes devolve
  // 400 com o código no corpo — casar pelos DOIS sinais, não só pelo status.
  if (status === 409 || b.includes("ALREADY_EXISTS")) {
    return { outcome: "already_exists", ok: true, action: "" };
  }
  if (b.includes("SERVICE_DISABLED") || b.includes("has not been used in project")) {
    return {
      outcome: "service_disabled",
      ok: false,
      action:
        "Ative a Gmail Postmaster Tools API no projeto GCP deste OAuth client " +
        "(console.cloud.google.com → APIs → Gmail Postmaster Tools API → Ativar). " +
        "Scope concedido não basta — habilitação é independente (#4154).",
    };
  }
  if (b.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || b.includes("insufficient authentication scopes")) {
    return {
      outcome: "scope_insufficient",
      ok: false,
      action:
        "O token em data/.credentials.json foi emitido sem o scope postmaster.domain. " +
        "Rode `npx tsx scripts/oauth-setup.ts` e reaprove no browser (#4539).",
    };
  }
  if (status === 403) {
    return {
      outcome: "forbidden",
      ok: false,
      action:
        "403 sem código de scope/API reconhecido — a causa mais provável é posse do domínio " +
        "não verificada para esta conta Google. Verifique o domínio no Search Console " +
        "(TXT no DNS) e rode de novo.",
    };
  }
  if (status === 400 || b.includes("INVALID_ARGUMENT")) {
    return {
      outcome: "invalid_argument",
      ok: false,
      action: "A API recusou o domínio informado. Confira a grafia em --domain (sem esquema, sem barra).",
    };
  }
  return { outcome: "error", ok: false, action: `HTTP ${status} inesperado. Corpo: ${b.slice(0, 300)}` };
}

/** Lista os domínios já registrados nesta conta (v2 `domains.list`). */
export async function listDomains(fetchImpl: typeof gFetch = gFetch): Promise<string[]> {
  const res = await fetchImpl(`${POSTMASTER_V2_BASE}/domains`);
  const body = await res.text();
  if (!res.ok) {
    const c = classifyCreateResponse(res.status, body);
    throw new Error(`[postmaster-register-domain] falha ao listar (${c.outcome}): ${c.action || body.slice(0, 300)}`);
  }
  const parsed = JSON.parse(body) as { domains?: Array<{ name?: string }> };
  // `name` vem como "domains/{domainId}" — devolver só o domínio.
  return (parsed.domains ?? []).map((d) => (d.name ?? "").replace(/^domains\//, "")).filter(Boolean);
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

async function main(argv: string[]): Promise<void> {
  // getStringArg (não getArg) de propósito: `--domain` vazio precisa ABORTAR,
  // não virar "" e cair no default silenciosamente — é exatamente a classe de
  // bug catalogada na #4573. Chave sem `--` é a convenção de `parseArgs`.
  const domain = getStringArg(argv, "domain", { example: DEFAULT_DOMAIN }) ?? DEFAULT_DOMAIN;
  const dryRun = hasFlag(argv, "dry-run");

  if (hasFlag(argv, "list")) {
    const domains = await listDomains();
    console.log(
      domains.length
        ? `[postmaster-register-domain] ${domains.length} domínio(s) registrado(s):\n  ${domains.join("\n  ")}`
        : "[postmaster-register-domain] nenhum domínio registrado nesta conta.",
    );
    return;
  }

  if (dryRun) {
    console.log(`[postmaster-register-domain] dry-run: registraria "${domain}" via POST ${POSTMASTER_V2_BASE}/domains`);
    return;
  }

  const result = await registerDomain(domain);
  if (result.ok) {
    const suffix = result.outcome === "already_exists" ? " (já estava registrado — no-op)" : "";
    console.log(`[postmaster-register-domain] OK: "${domain}" registrado${suffix}.`);
    // Ressalva operacional impressa SEMPRE no sucesso: o painel vai aparecer
    // vazio enquanto o remetente for a Beehiiv (DKIM dela, não nosso). Sem
    // isto, painel vazio é lido como erro de configuração — ver #4539.
    console.log(
      "[postmaster-register-domain] nota: o Postmaster agrega por domínio que ASSINA o DKIM. " +
        "Enquanto o diário sair de diaria@mail.beehiiv.com, este painel deve ficar vazio — " +
        "isso é esperado, não erro de configuração (#4539).",
    );
    return;
  }
  console.error(`[postmaster-register-domain] FALHOU (${result.outcome}): ${result.action}`);
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[postmaster-register-domain] erro: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
