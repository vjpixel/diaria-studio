// #8068 — geração pura da linha de entrada de um "awesome-*" README de
// GitHub para a newsletter diar.ia.br. NÃO faz nenhuma chamada de rede, NÃO
// abre PR, NÃO faz fork — só monta o texto que o editor cola manualmente
// (ver docs/seo-backlinks-plan.md, seção "Mecanismo automatizável").

export interface AwesomeListTarget {
  /** Chave curta usada no CLI (--target). */
  readonly key: string;
  /** Nome de exibição do repositório/lista. */
  readonly name: string;
  /** URL do repositório no GitHub. */
  readonly repoUrl: string;
  /** Seção do README onde a entrada deveria entrar (guia para o editor — o script não edita o README de terceiro). */
  readonly section: string;
}

// Alvos concretos identificados em docs/seo-backlinks-plan.md (#15-18).
// Lista fechada de propósito — adicionar um alvo novo é decisão editorial
// (qual lista aceita o escopo "newsletter de notícias de IA em PT-BR"),
// não algo a inferir automaticamente.
export const AWESOME_LIST_TARGETS: readonly AwesomeListTarget[] = [
  {
    key: "randalmaia",
    name: "randalmaia/awesome-newsletters",
    repoUrl: "https://github.com/randalmaia/awesome-newsletters",
    section: "seção de newsletters em português (ex: ao lado de 'A semana PHP', 'Correio WP')",
  },
  {
    key: "machinelearningbr",
    name: "MachineLearningBR/recursos",
    repoUrl: "https://github.com/MachineLearningBR/recursos",
    section: "seção de blogs/newsletters de Machine Learning e IA",
  },
  {
    key: "wendelmarques",
    name: "wendelmarques/materiais-de-estudos-sobre-data-science-deep-machine-learning",
    repoUrl:
      "https://github.com/wendelmarques/materiais-de-estudos-sobre-data-science-deep-machine-learning",
    section: "seção de canais/newsletters do guia de estudos de IA",
  },
  {
    key: "italojs",
    name: "italojs/awesome-machine-learning-portugues",
    repoUrl: "https://github.com/italojs/awesome-machine-learning-portugues",
    section:
      "verificar antes se o escopo (plano de estudos) comporta newsletter de notícias — pode não caber",
  },
];

export interface NewsletterMeta {
  readonly name: string;
  readonly url: string;
  readonly description: string;
}

export const DIARIA_NEWSLETTER_META: NewsletterMeta = {
  name: "diar.ia.br",
  url: "https://diar.ia.br",
  description: "Newsletter diária em português sobre inteligência artificial — curadoria, lançamentos e análise, com foco no Brasil.",
};

export function findAwesomeListTarget(key: string): AwesomeListTarget | undefined {
  return AWESOME_LIST_TARGETS.find((t) => t.key === key);
}

/** Monta a linha de entrada em Markdown no formato comum de listas "awesome-*" (- [Nome](URL) — descrição). */
export function buildAwesomeListEntryLine(meta: NewsletterMeta): string {
  return `- [${meta.name}](${meta.url}) — ${meta.description}`;
}

export function buildAwesomeListEntryGuidance(
  target: AwesomeListTarget,
  meta: NewsletterMeta = DIARIA_NEWSLETTER_META,
): string {
  const line = buildAwesomeListEntryLine(meta);
  return [
    `Alvo: ${target.name}`,
    `Repositório: ${target.repoUrl}`,
    `Onde inserir: ${target.section}`,
    "",
    "Linha de entrada (colar no README, ordem alfabética se a seção usar):",
    "",
    line,
    "",
    "Próximo passo (ação HUMANA, fora deste script): fork do repositório,",
    "adicionar a linha acima na seção indicada, abrir Pull Request explicando",
    "em 1-2 frases o que é a newsletter e por que se encaixa na lista.",
  ].join("\n");
}
