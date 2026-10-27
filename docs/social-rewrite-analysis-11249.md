# Reescritas de social nas edições 261023, 261026 e 261027

## Evidência e método

Comparação somente de leitura dos snapshots `_internal/editor-request-snapshots/stage2-post-gate/03-social.md` e `stage4-post-gate/03-social.md`, conferida com `_internal/editor-requests.jsonl` nas três edições em `data/editions/2610/`. Esses arquivos são privados e não entram no git. Os eventos são derivados de diferenças, não transcrições de pedidos ou justificativas do editor. Não permitem atribuir intenção ao editor nem concluir que toda mudança foi rejeição do agente.

Na 261027, casar a história do Google de D3 para D1, em vez de comparar apenas posições. D3 final (Anthropic) é uma história nova. Trocas do item USE MELHOR também não são rejeições do texto da história anterior.

## O que mudou

| Edição / post | Mudança observada | Leitura |
|---|---|---|
| 261023 curto D1 | Países Baixos e descoberta com OpenAI dão lugar à abrangência do PHP e à suspensão de sistemas no Brasil | Fonte e ângulo mudaram; o evento registra `source_changed` |
| 261026 social D1 | Recusa não leva a outro modelo, mas a script com ataque pronto | Correção da alternativa no fluxo |
| 261026 curto D1 | Quatro agentes coordenadores viram um Claude no Cursor comandando quatro subagentes | Correção de papéis e ferramenta; há ainda ajuste posterior registrado no Stage 6 |
| 261026 social D2 | Segunda lista idêntica de bancos é substituída | Redundância; chamar de afetados os bancos que tentam conter riscos também muda a relação factual |
| 261026 social D3 | “Um funcionário do METR e um da Redwood Research” vira “Os pesquisadores, um do METR e outro da Redwood Research” | Ajuste local de clareza, sem novo fato ou CTA |
| 261027 social e curto Google D3 para D1 | Drive vira Calendar; ajustes de escopo, fonte e fecho com convite para ver instruções na edição | Fonte trocada e decisão editorial local |
| 261027 social e curto D2 | Comparação com Claude vira “menos de um ponto”; social divide o primeiro parágrafo | Precisão da comparação e ritmo; social final tem quatro parágrafos |

O diff também mostra mudança do social longo D1 na 261023, embora a lista de eventos só registre o curto. Portanto, os eventos não constituem inventário completo das mudanças. Contagem de edições com eventos não mede taxa de rejeição.

## Decisão

Reforçar nos dois agentes uma conferência final das relações factuais: sujeito, ação, ferramenta e condição. Os dois casos CyberCartel mostram o mesmo risco de distorção ao comprimir o texto. No social-writer, conferir também se o negrito acrescenta uma batida sem duplicar a frase anterior nem mudar seu sentido. São verificações do texto-base já disponível, sem novo input ou etapa de execução.

Não generalizar as escolhas locais da 261027: CTA com “edição de hoje” e quatro parágrafos conflitam com regras vigentes (neutralidade de canal, ausência de tempo relativo e três slides de corpo). Os dados não sustentam mudar essas regras, nem impor novo tom ou CTA para todas as edições. Nenhum material editorial foi alterado.

## Validação e limite

Testes existentes verificam os contratos de alinhamento com newsletter e leitura das fontes; lint dos agentes verifica sua estrutura. Não há teste determinístico que prove fidelidade semântica de uma geração de LLM. Não se executou replay pago: o efeito sobre futuras reescritas permanece por medir com novos pares de snapshots. Os exemplos concretos servem para revisão humana da instrução, sem tratar presença de uma frase no prompt como prova de qualidade da geração.
