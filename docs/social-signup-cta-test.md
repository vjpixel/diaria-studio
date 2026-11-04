# Preparação do teste de assinatura social (#12038)

Decisão do editor de 03/11/2026: testar por **quatro semanas**, prevalecendo
sobre as duas semanas da proposta inicial. Este incremento prepara copy e
tracking; não ativa o teste, não publica, não agenda, não modifica a bio e
não altera publicadores. O início real depende da ativação editorial futura;
não contar a data da implementação como exposição.

Para cada edição, informar a data da edição e o mesmo início real do teste:

```sh
npx tsx scripts/prep-social-signup-cta.ts --edition 261104 --start 2026-11-04
```

As datas acima são exemplo. O JSON vai somente para stdout. Revisar os textos
antes de qualquer uso externo. Nenhum publicador lê esse artefato automaticamente.
O comando exige os três destaques e três parágrafos por destaque. A fonte
`03-social.md` e os cinco slides de cada carrossel permanecem intactos.

D1 de LinkedIn/Facebook termina com a chamada já existente no projeto:
“Receba notícias de IA todo dia por e-mail, assine grátis em {URL}.”
A linha fica após as hashtags para ser a última linha. D2/D3 usam as linhas
atuais, sem a campanha do experimento. Instagram mantém sua legenda e recebe
no artefato o primeiro comentário de D1 para fixação manual e a URL da bio.
A API não fixa comentários; o artefato explicita a ação manual pendente.
Não foi criada uma nova frase editorial para a bio: prepara-se apenas o link.

Cada URL usa `utm_source=linkedin|facebook|instagram`,
`utm_medium=organic_social` e `utm_campaign=post-cta-12038`.
O sufixo técnico separa o teste do `post-cta` que o Facebook **já emite em todos
os posts**; reutilizá-lo misturaria teste e baseline. Emissores registrados em
`utm-registry.ts`. No Instagram, bio e comentário compartilham campanha:
a medição é por rede, conforme a decisão, não por posição do link.

A janela contém 28 dias, início inclusivo e fim exclusivo; o gerador recusa
edições fora dela. Não existe timer nem ativação automática. Depois dos 28
dias, revisar a medição com o editor; não classificar automaticamente social
como canal de marca (a decisão mais recente explicitamente não fez isso).

Medição read-only no banco consolidado, depois do sync normal de assinantes:
substituir as datas pelos limites exibidos em `window` no JSON preparado.

```sql
SELECT source AS rede,
       count(*) AS cadastros,
       sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS ativos_na_leitura,
       count(*) / 4.0 AS cadastros_por_semana
FROM subscription
WHERE platform = 'kit'
  AND utm_campaign = 'post-cta-12038'
  AND source IN ('linkedin', 'facebook', 'instagram')
  AND entered_at >= '2026-11-04'
  AND entered_at < '2026-12-02'
GROUP BY source;
```

Redes ausentes no resultado têm zero cadastros. `active` é o estado atual,
não uma medida histórica de confirmação DOI. Comparar cadastros por rede
com a referência pré-registrada de aproximadamente um cadastro por semana;
a conclusão editorial fica para a revisão após quatro semanas completas de
exposição. Não executar nenhum script de publicação para preparar ou medir.
