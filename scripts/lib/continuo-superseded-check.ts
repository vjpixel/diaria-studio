/**
 * continuo-superseded-check.ts (#6926)
 *
 * Portão "superseded" do gate de merge autônomo de `continuo-pr-review.sh`
 * (#6238: nunca mergear uma PR cuja issue já foi resolvida por outra PR
 * enquanto esta esperava review). Versão MECÂNICA, não a leitura humana
 * "master já tratou isso igual ou melhor" que a §3 passo 1 da SKILL do
 * `hermes-diaria-continuo` pede pro TICK (esse texto continua exigindo
 * julgamento — não é o que este módulo decide).
 *
 * A pergunta que ESTE módulo responde é mais estreita e 100% verificável:
 * **toda issue que o corpo da PR já declara fechar (via palavra-chave em
 * INGLÊS) já está CLOSED?** Se sim, a issue foi resolvida por OUTRA coisa
 * enquanto esta PR esperava (a própria PR não pode ter fechado a issue
 * sozinha — ela ainda está aberta) — mergear não teria mais efeito útil e
 * arrisca reabrir/reintroduzir trabalho já obsoleto.
 *
 * Depende do #6920: antes daquele fix, o corpo do contínuo em português
 * (`Fecha #N`) não carregava nenhuma palavra-chave que o GitHub reconhece,
 * então `extractClosingIssueNumbers` (que só olha inglês, de propósito)
 * não encontrava nada e este portão nunca se aplicava. Depois do #6920,
 * `.claude/hooks/pr-create-review.mjs` anexa `Closes #N` a toda PR nova —
 * este módulo lê esse resultado já normalizado, sem duplicar a detecção de
 * verbo em português aqui.
 *
 * Sem issue referenciada no corpo (comum em PRs de refactor/cleanup sem
 * issue própria) → portão não se aplica, nunca `superseded` (não é
 * "impossível saber", é "esta checagem não tem nada pra checar aqui" —
 * outros portões do gate de merge continuam decidindo normalmente).
 */

/** Mesmas palavras-chave que o GitHub reconhece para auto-close — ver
 *  `EN_CLOSE_KEYWORDS` em `.claude/hooks/pr-create-review.mjs` (#6920).
 *  Duplicado por PROPÓSITOS DIFERENTES dos daquele arquivo (que é
 *  self-contained de propósito, sem imports de `scripts/*.ts`) — aqui a
 *  duplicação evita acoplar um script de merge fail-closed a um HOOK cujo
 *  próprio contrato é "nunca lançar, nunca bloquear `gh pr create`"; um
 *  import cruzado tornaria uma mudança de hook capaz de silenciosamente
 *  mudar o comportamento deste gate de merge, e vice-versa. */
const EN_CLOSE_KEYWORDS = [
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
];

/**
 * Números de issue que o corpo já declara fechar em INGLÊS. Mesmo formato
 * de regex do #6920 (`\b(?:verbo)\b` seguido, dentro de 20 chars sem quebra
 * de linha nem outro `#`, do PRIMEIRO `#<número>`). #6938: essa folga de 20
 * chars vale só para o PRIMEIRO número — continuar a cauda para um 2º/3º
 * número (`"Closes #10 e #11"`/`"Closes #10, #11"`) exige conjunção
 * explícita (`,`/`e`/`and`) logo em seguida, nunca só proximidade solta
 * (era o defeito do #6938: "Closes #A (ver #B)" capturava #B também).
 * Retorna números ÚNICOS, sem ordem garantida além da ordem de primeira
 * ocorrência no texto.
 */
export function extractClosingIssueNumbers(body: unknown): number[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const re = new RegExp(
    `\\b(?:${EN_CLOSE_KEYWORDS.join("|")})\\b[^\\n#]{0,20}(#\\d+(?:\\s*(?:,|\\be\\b|\\band\\b)\\s*#\\d+)*)`,
    "gi",
  );
  const nums: number[] = [];
  const seen = new Set<number>();
  let match;
  while ((match = re.exec(body)) !== null) {
    const numRe = /#(\d+)/g;
    let numMatch;
    while ((numMatch = numRe.exec(match[1])) !== null) {
      const n = Number(numMatch[1]);
      if (!seen.has(n)) {
        seen.add(n);
        nums.push(n);
      }
    }
  }
  return nums;
}

export interface SupersededVerdict {
  superseded: boolean;
  reason: string;
}

/**
 * Decide o veredito a partir dos números de issue já extraídos e do estado
 * atual de cada uma (`"OPEN" | "CLOSED"`, tipicamente de `gh issue view
 * --json state`). `issueStates` sem entrada para um número referenciado é
 * tratado como estado DESCONHECIDO — conta como "ainda não confirmadamente
 * fechada", nunca como `CLOSED` por omissão (fail-closed: dado ausente não
 * pode virar "superseded", que só autoriza REJEITAR o merge — o lado errado
 * de errar aqui seria mergear uma PR cuja issue JÁ estava fechada, então o
 * viés correto é o oposto: exigir confirmação explícita antes de declarar
 * "todas fechadas").
 */
export function computeSupersededVerdict(
  closingIssueNumbers: readonly number[],
  issueStates: ReadonlyMap<number, "OPEN" | "CLOSED">,
): SupersededVerdict {
  if (closingIssueNumbers.length === 0) {
    return {
      superseded: false,
      reason: "PR não referencia nenhuma issue via palavra-chave de fechamento em inglês — portão não se aplica",
    };
  }

  const closed = closingIssueNumbers.filter((n) => issueStates.get(n) === "CLOSED");

  if (closed.length === closingIssueNumbers.length) {
    return {
      superseded: true,
      reason: `todas as ${closingIssueNumbers.length} issue(s) referenciada(s) (#${closingIssueNumbers.join(", #")}) já estão CLOSED — outra coisa já resolveu, mergear não teria mais efeito útil`,
    };
  }

  return {
    superseded: false,
    reason: `${closed.length}/${closingIssueNumbers.length} issue(s) referenciada(s) já fechada(s) — ainda há trabalho pendente que só esta PR resolve`,
  };
}
