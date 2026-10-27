/**
 * scripts/lib/confirmation-email-auth.ts (#8548 item 2)
 *
 * Autenticação do remetente do e-mail de confirmação do double opt-in, lida
 * do DNS público, sem enviar e-mail nenhum. O e-mail sai do Kit com From
 * `oi@news.diar.ia.br` (`docs/kit-doi-confirmation-copy.md`), então a
 * entrega depende de três registros desse domínio:
 *
 * - **DKIM** — `cka._domainkey.news.diar.ia.br`, CNAME para a chave que o
 *   Kit publica. O seletor `cka` assina com `d=news.diar.ia.br`, o que dá
 *   alinhamento DKIM com o From até em modo estrito.
 * - **SPF do Return-Path** — o Kit usa `ckespa.news.diar.ia.br` como domínio
 *   do envelope (CNAME para o SPF do Kit). O SPF do próprio
 *   `news.diar.ia.br` cobre só o Cloudflare Email Routing (recebimento) e
 *   NÃO precisa incluir o Kit: quem o SPF avalia é o Return-Path.
 * - **DMARC** — `_dmarc.news.diar.ia.br`. Com `aspf=r` (padrão) o
 *   Return-Path em subdomínio alinha; com `aspf=s` não alinha e o DMARC passa
 *   a depender só do DKIM (vira aviso, não falha).
 *
 * Seletor e rótulo do Return-Path foram medidos no DNS ao vivo em
 * 27/10/2026. Se o Kit trocar a configuração de domínio, os dois mudam e
 * este check acusa `falha` em vez de passar em silêncio.
 *
 * Postmaster Tools (reputação no Gmail) não entra aqui: exige a conta do
 * Google do editor e o domínio verificado no Postmaster
 * (`scripts/postmaster-register-domain.ts`), fora do alcance de DNS.
 *
 * `evaluateSenderAuth` é puro; `collectSenderAuthDns` faz as consultas com
 * resolvedores injetáveis.
 */

import { resolveCname as dnsResolveCname, resolveTxt as dnsResolveTxt } from "node:dns/promises";

export const CONFIRMATION_SENDER_DOMAIN = "news.diar.ia.br";
/** Seletor DKIM do Kit no domínio de envio (medido em 27/10/2026). */
export const KIT_DKIM_SELECTOR = "cka";
/** Rótulo do Return-Path do Kit no domínio de envio (medido em 27/10/2026). */
export const KIT_RETURN_PATH_LABEL = "ckespa";
/** Hosts de infraestrutura do Kit para onde os CNAMEs devem apontar. */
export const KIT_INFRA_HOST_RE = /(^|\.)(convertkit\.com|kit\.com)\.?$/i;

export type DnsLookup<T> = { kind: "ok"; value: T } | { kind: "absent" } | { kind: "error"; code: string };

export interface SenderAuthDns {
  domain: string;
  dmarcTxt: DnsLookup<string[]>;
  dkimCname: DnsLookup<string[]>;
  dkimTxt: DnsLookup<string[]>;
  returnPathCname: DnsLookup<string[]>;
  returnPathTxt: DnsLookup<string[]>;
}

export type AuthCheckStatus = "ok" | "aviso" | "falha" | "nao-verificavel";

export interface AuthCheck {
  id: "dkim" | "spf-return-path" | "dmarc";
  status: AuthCheckStatus;
  registro: string;
  detalhe: string;
}

export interface SenderAuthReport {
  domain: string;
  checks: AuthCheck[];
  /** Pior status entre os checks (falha > nao-verificavel > aviso > ok). */
  veredito: AuthCheckStatus;
}

const SEVERIDADE: Record<AuthCheckStatus, number> = { ok: 0, aviso: 1, "nao-verificavel": 2, falha: 3 };

export function dkimHost(domain: string, selector = KIT_DKIM_SELECTOR): string {
  return `${selector}._domainkey.${domain}`;
}

export function returnPathHost(domain: string, label = KIT_RETURN_PATH_LABEL): string {
  return `${label}.${domain}`;
}

/** Tags `k=v` de um registro DMARC/DKIM (chaves em minúsculas). @pure */
export function parseTagList(record: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    tags.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return tags;
}

function cnameNota(lookup: DnsLookup<string[]>): string {
  if (lookup.kind !== "ok") return "";
  const alvo = lookup.value[0] ?? "";
  return KIT_INFRA_HOST_RE.test(alvo) ? ` (CNAME → ${alvo})` : "";
}

function cnameForaDoKit(lookup: DnsLookup<string[]>): string | null {
  if (lookup.kind !== "ok") return null;
  const alvo = lookup.value[0] ?? "";
  return KIT_INFRA_HOST_RE.test(alvo) ? null : alvo;
}

function evaluateDkim(dns: SenderAuthDns): AuthCheck {
  const registro = dkimHost(dns.domain);
  const base = { id: "dkim" as const, registro };
  if (dns.dkimTxt.kind === "error") return { ...base, status: "nao-verificavel", detalhe: `consulta TXT falhou (${dns.dkimTxt.code})` };
  if (dns.dkimTxt.kind === "absent") {
    return { ...base, status: "falha", detalhe: "sem chave DKIM publicada: o Kit não consegue assinar como o domínio do From" };
  }
  const chave = dns.dkimTxt.value.find((r) => /(^|;)\s*p=/i.test(r));
  if (!chave) return { ...base, status: "falha", detalhe: "TXT presente mas sem tag p= (não é chave DKIM)" };
  const p = parseTagList(chave).get("p") ?? "";
  if (!p) return { ...base, status: "falha", detalhe: "chave DKIM revogada (p= vazio)" };
  const fora = cnameForaDoKit(dns.dkimCname);
  if (fora) return { ...base, status: "aviso", detalhe: `chave publicada, mas o CNAME aponta para fora do Kit (${fora})` };
  return { ...base, status: "ok", detalhe: `chave publicada (${p.length} caracteres)${cnameNota(dns.dkimCname)}` };
}

function evaluateReturnPath(dns: SenderAuthDns): AuthCheck {
  const registro = returnPathHost(dns.domain);
  const base = { id: "spf-return-path" as const, registro };
  if (dns.returnPathTxt.kind === "error") {
    return { ...base, status: "nao-verificavel", detalhe: `consulta TXT falhou (${dns.returnPathTxt.code})` };
  }
  if (dns.returnPathTxt.kind === "absent") {
    return { ...base, status: "falha", detalhe: "sem SPF no domínio do Return-Path do Kit: o SPF falha e o DMARC fica só com o DKIM" };
  }
  const spf = dns.returnPathTxt.value.filter((r) => r.trim().toLowerCase().startsWith("v=spf1"));
  if (spf.length === 0) return { ...base, status: "falha", detalhe: "TXT presente mas sem v=spf1" };
  if (spf.length > 1) return { ...base, status: "falha", detalhe: `${spf.length} registros v=spf1 (permerror: o SPF falha)` };
  const fora = cnameForaDoKit(dns.returnPathCname);
  if (fora) return { ...base, status: "aviso", detalhe: `SPF "${spf[0]}", mas o CNAME aponta para fora do Kit (${fora})` };
  if (!/(convertkit|kit)\.com/i.test(spf[0])) {
    return { ...base, status: "aviso", detalhe: `SPF "${spf[0]}" não inclui a infraestrutura do Kit` };
  }
  return { ...base, status: "ok", detalhe: `"${spf[0]}"${cnameNota(dns.returnPathCname)}` };
}

function evaluateDmarc(dns: SenderAuthDns): AuthCheck {
  const registro = `_dmarc.${dns.domain}`;
  const base = { id: "dmarc" as const, registro };
  if (dns.dmarcTxt.kind === "error") return { ...base, status: "nao-verificavel", detalhe: `consulta TXT falhou (${dns.dmarcTxt.code})` };
  const recs = dns.dmarcTxt.kind === "ok" ? dns.dmarcTxt.value.filter((r) => r.trim().toLowerCase().startsWith("v=dmarc1")) : [];
  if (recs.length === 0) {
    return { ...base, status: "falha", detalhe: "sem registro DMARC: Gmail e Yahoo exigem DMARC de remetente em volume" };
  }
  if (recs.length > 1) return { ...base, status: "falha", detalhe: `${recs.length} registros v=DMARC1 (o receptor ignora todos)` };
  const tags = parseTagList(recs[0]);
  const p = (tags.get("p") ?? "").toLowerCase();
  const avisos: string[] = [];
  if (!["none", "quarantine", "reject"].includes(p)) {
    return { ...base, status: "falha", detalhe: `p= inválido ou ausente ("${tags.get("p") ?? ""}")` };
  }
  if ((tags.get("aspf") ?? "r").toLowerCase() === "s") {
    avisos.push(`aspf=s: o Return-Path ${returnPathHost(dns.domain)} não alinha em modo estrito, o DMARC depende só do DKIM`);
  }
  if (!tags.get("rua")) avisos.push("sem rua=: nenhum relatório agregado chega");
  const resumo = `p=${p}, adkim=${tags.get("adkim") ?? "r"}, aspf=${tags.get("aspf") ?? "r"}${tags.get("rua") ? `, rua=${tags.get("rua")}` : ""}`;
  return avisos.length > 0
    ? { ...base, status: "aviso", detalhe: `${resumo}. ${avisos.join("; ")}` }
    : { ...base, status: "ok", detalhe: resumo };
}

/** Julga os registros já consultados. @pure */
export function evaluateSenderAuth(dns: SenderAuthDns): SenderAuthReport {
  const checks = [evaluateDkim(dns), evaluateReturnPath(dns), evaluateDmarc(dns)];
  const veredito = checks.reduce<AuthCheckStatus>((pior, c) => (SEVERIDADE[c.status] > SEVERIDADE[pior] ? c.status : pior), "ok");
  return { domain: dns.domain, checks, veredito };
}

export interface DnsResolvers {
  resolveTxt: (host: string) => Promise<string[][]>;
  resolveCname: (host: string) => Promise<string[]>;
}

/** `ENODATA`/`ENOTFOUND` = resposta autoritativa de "não existe"; qualquer
 *  outro erro é "não consegui ler" (mesma distinção do #7933 em
 *  `readCurrentDmarcPolicy`) — nunca vira ausência. */
async function lookup<T>(fn: () => Promise<T>): Promise<DnsLookup<T>> {
  try {
    return { kind: "ok", value: await fn() };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.message : String(e));
    if (code === "ENODATA" || code === "ENOTFOUND") return { kind: "absent" };
    return { kind: "error", code };
  }
}

/** Consulta os registros do remetente. TXT de CNAME é seguido pelo resolvedor. */
export async function collectSenderAuthDns(
  domain = CONFIRMATION_SENDER_DOMAIN,
  resolvers: DnsResolvers = { resolveTxt: dnsResolveTxt, resolveCname: dnsResolveCname },
): Promise<SenderAuthDns> {
  const txt = (host: string) => lookup(async () => (await resolvers.resolveTxt(host)).map((chunks) => chunks.join("")));
  const cname = (host: string) => lookup(() => resolvers.resolveCname(host));
  const [dmarcTxt, dkimCname, dkimTxt, returnPathCname, returnPathTxt] = await Promise.all([
    txt(`_dmarc.${domain}`),
    cname(dkimHost(domain)),
    txt(dkimHost(domain)),
    cname(returnPathHost(domain)),
    txt(returnPathHost(domain)),
  ]);
  return { domain, dmarcTxt, dkimCname, dkimTxt, returnPathCname, returnPathTxt };
}
