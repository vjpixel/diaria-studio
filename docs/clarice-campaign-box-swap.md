Troca de box por campanha Clarice (#12249)
========================================

Uso supervisionado pelo editor, como os demais modos de reapply:

```sh
npx tsx scripts/clarice-reapply-scheduled-html.ts --cycle 2610-11 --campaign-id 394 --swap-box 'Conversar com a Clarice' --with data/snippets/amazon-cupom-relampago.md
```

O default é dry-run: valida e mostra a troca, sem gravar override ou alterar a
campanha. Adicionar `--apply` persiste a escolha e executa o fluxo existente de
suspender, atualizar HTML, verificar e reagendar. Este exemplo é ilustrativo;
a campanha deve ainda estar queued/scheduled. Não se aplica a campanhas enviadas.

`--swap-box` aceita título exato (sensível a maiúsculas/minúsculas) ou posição a partir de
1 entre TODOS os painéis de box do HTML mensal, incluindo livros e cadastro.
Títulos duplicados exigem posição. Erros mostram as posições e títulos disponíveis.
O snippet usa o formato habitual: título bold, corpo e link de CTA. É renderizado
com o layout mensal de Divulgação; tags Amazon são reescritas para Clarice.
O restante do HTML fica intacto.

A escolha é um snapshot do HTML renderizado em
`segments/campaign-box-swaps/{campaignId}.json` do ciclo. O snapshot é gravado
antes da primeira escrita remota: uma falha posterior não perde a intenção.
Reapply (com ou sem `--campaign-id`) e schedule-group (`--update-html` e
`--create --update-existing`) consultam esse arquivo. Campanhas novas ou outros
IDs não herdam a troca. Mudar o snippet depois não muda o snapshot; repita as
flags explicitamente para atualizar a escolha. Uma nova troca substitui a anterior
para esse ID (um box por campanha).

Se a posição/título do box original mudar no draft, o override falha antes de
escrever HTML, evitando substituir outro box silenciosamente. Refaça a escolha
com as flags. Para retirar a escolha, remova o arquivo de override local e reaplique
o HTML. O draft e o preview do ciclo não são alterados.
