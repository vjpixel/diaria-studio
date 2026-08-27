# Cobertura dos índices por mês e por tema (#5125)

Gerado em 2026-08-27 por `npx tsx scripts/corpus-index-coverage-report.ts`.
Re-executar para reconfirmar antes de citar estes números (mesma disciplina do #1172 — nunca confiar em número escrito num doc sem re-derivar).

## Resultado

**Índice por mês** (`https://arquivo.diar.ia.br/`, #4105): 254/254 edições confirmadas têm slug+data resolvíveis — a condição que `render-archive.ts` exige pra incluir a edição no agrupamento por `YYYY-MM`. Página já em produção, server-renderizada por request a partir do sitemap oficial.

**Índice por tema** (`https://arquivo.diar.ia.br/temas/`, #4558 Parte A): 213/254 edições (83.9%) são cobertas por pelo menos 1 dos 6 hubs temáticos já publicados. Por tema:

- **Anthropic e Claude** (`anthropic-claude`): 83 edição(ões)
- **OpenAI e ChatGPT** (`openai-chatgpt`): 102 edição(ões)
- **Google e Gemini** (`google-gemini`): 65 edição(ões)
- **Meta e Meta AI** (`meta-ai`): 22 edição(ões)
- **Regulação de IA no Brasil** (`brasil-regulacao`): 15 edição(ões)
- **Mercado de trabalho e IA** (`mercado-trabalho`): 52 edição(ões)
- **Medicina e saúde** (`medicina-saude`): 21 edição(ões)

Edições confirmadas sem nenhum tema (candidatas a tema futuro, ou legitimamente sem cobertura transversal — ver `scripts/lib/corpus-index-coverage.ts` docstring):

  - `10-startups-do-brasil-miram-us-100-mi-em-2026`
  - `4-meses-usando-ia-criam-di-vida-cognitiva-no-ce-rebro`
  - `90-das-pessoas-na-o-reconhecem-vi-deos-de-ia`
  - `90-das-pessoas-nao-reconhecem-videos-de-ia-ec15971b8c4f589e`
  - `a-diar-ia-br-normalmente-te-conta-o-dia-hoje-ela-conta-o-m-s`
  - `a-nova-forma-de-fazer-compras`
  - `agora-qualquer-fone-pode-ser-um-tradutor-ao-vivo`
  - `alibaba-lanc-a-tre-s-modelos-de-open-source-e-quebra-32-recordes`
  - `avalanche-de-desenhos-de-ia-para-bebe-s`
  - `bancos-soam-alerta-para-investimentos-excessivos-em-ia`
  - `brasil-fortalece-parceria-com-a-mala-sia-em-semicondutores-e-ia`
  - `como-os-brasileiros-veem-a-ia`
  - `especial-cursos-gratuitos-de-ia`
  - `especial-moltbook-a-rede-social-so-de-ias`
  - `estudo-alerta-falhas-de-seguranc-a-em-empresas-de-ia`
  - `estudo-revela-falha-em-llms-por-meio-de-poemas`
  - `estudo-revela-que-ia-nao-e-segura-para-robos-pessoais-7c1465a99a9d1198`
  - `estudo-revela-que-ia-nao-e-segura-para-robos-pessoais-e4e1098e9d559782`
  - `estudos-revelam-influe-ncia-de-ia-na-poli-tica`
  - `falha-na-lovable-atinge-spotify-uber-e-outros`
  - … e mais 21

## Por que nenhuma página nova foi publicada nesta unidade

O escopo trabalhável de #5125 (comentário 17/08/2026) pediu "índice por mês" e "índice por tema" derivados do corpus, publicados em host nosso. As duas superfícies **já existem em produção** cobrindo o corpus inteiro (números acima) — construir uma 3ª cópia em `workers/artigos` duplicaria `arquivo.diar.ia.br`/`arquivo.diar.ia.br/temas/`, contradizendo o próprio critério que a issue estabeleceu pra decisão (C): produzir superfície que NÃO existe, nunca espelhar o que já existe em host nosso. Este relatório fecha o item mecanicamente (checagem re-executável, não afirmação em prosa) em vez de adicionar mais uma página pra manter.
