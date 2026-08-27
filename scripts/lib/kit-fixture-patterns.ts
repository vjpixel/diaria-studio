/**
 * kit-fixture-patterns.ts (#6336)
 *
 * Detector puro de e-mail de FIXTURE de teste — o mesmo endereço que é
 * inofensivo em `test/*.test.ts` (nunca toca rede, `fetchMock` sempre) vira
 * assinante REAL de produção quando o mesmo fixture é usado numa verificação
 * ao vivo de funil (poll/cursos/reativar) contra a base Kit. Achado ao vivo
 * 26/08/2026: `ana@example.com` — usado em ~10 arquivos de teste do repo
 * (`poll-jogar-inline-signup-kit-6048`, `cursos-gate-subscribe-kit-6048`,
 * `meta-capi-wiring-5504`, entre outros) — ficou `active` na base real depois
 * de uma verificação manual, e teria recebido a próxima edição. `example.com`
 * é domínio reservado (RFC 2606): nunca entrega, hard bounce garantido.
 *
 * Este módulo só CLASSIFICA um endereço como fixture — não decide o que
 * fazer com o achado (isso é `kit-fixture-audit.ts`, que cruza com o estado
 * `active`/`cancelled`/etc do assinante).
 *
 * ## Convenção de probe ao vivo (documentação, não código — item 3 do #6336)
 *
 * Verificação ao vivo de funil (poll/cursos/reativar) contra a base Kit real
 * SEMPRE usa `vjpixel+probe-{issue}-{data}@gmail.com` — nunca um fixture dos
 * testes automatizados (`ana@example.com`, `teste-*@...`, etc). O `+probe-`
 * torna a intenção auto-descritiva no dashboard do Kit e o domínio real
 * (`gmail.com`) garante entrega de verdade, o que o teste realmente precisa
 * confirmar. Ver também a nota de rollout na docstring de
 * `scripts/audit-kit-fixtures.ts`.
 */

/** Domínios reservados por RFC 2606 — nunca resolvem, hard bounce garantido. */
const RESERVED_DOMAINS = new Set(["example.com", "example.org", "example.net"]);

/**
 * Sufixos de domínio não-roteáveis/reservados. `.example` já é coberto pelos
 * domínios acima quando usado sozinho, mas TLDs genéricos (`foo.example`)
 * caem aqui via sufixo. `.local`/`.localhost`/`.test`/`.invalid` são os 4
 * TLDs "especiais" citados na issue #6336 além do trio RFC 2606.
 */
const RESERVED_DOMAIN_SUFFIXES = [".test", ".invalid", ".localhost", ".local", ".example"];

/** Marcadores de probe/teste no local-part — substring, não âncora, porque
 *  convivem com prefixo real de e-mail (`vjpixel+kittest@gmail.com`). */
const FIXTURE_LOCAL_PART_MARKERS: Array<{ re: RegExp; label: string }> = [
  { re: /\+kittest\b/i, label: "marcador +kittest" },
  { re: /\+utmprobe\b/i, label: "marcador +utmprobe" },
];

/** Prefixo `teste-*` — convenção usada nos fixtures de teste do repo. */
const FIXTURE_LOCAL_PART_PREFIX_RE = /^teste-/i;

/**
 * Classifica um endereço como fixture de teste, com o motivo, ou `null` se
 * não bater nenhum padrão conhecido. Puro — sem I/O, sem estado de rede.
 *
 * `email` sem `@` (formato inválido) devolve `null` — não é papel deste
 * módulo validar formato de e-mail, só reconhecer fixtures dentro de um já
 * bem-formado.
 */
export function matchFixtureEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at === -1 || at === trimmed.length - 1) return null;

  const localPart = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  if (RESERVED_DOMAINS.has(domain)) {
    return `domínio reservado RFC 2606 (${domain}) — nunca entrega`;
  }
  for (const suffix of RESERVED_DOMAIN_SUFFIXES) {
    if (domain === suffix.slice(1) || domain.endsWith(suffix)) {
      return `domínio com TLD/sufixo reservado (${suffix}) — não roteável`;
    }
  }
  for (const { re, label } of FIXTURE_LOCAL_PART_MARKERS) {
    if (re.test(localPart)) return label;
  }
  if (FIXTURE_LOCAL_PART_PREFIX_RE.test(localPart)) {
    return `prefixo de fixture "teste-"`;
  }
  return null;
}
