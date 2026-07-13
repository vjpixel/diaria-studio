<!--
Bloco canônico de DIVULGAÇÃO do programa de apoio (apoia.se/diaria). Fonte
única do box de divulgação (slot 1 D1/D2 OU slot 2 D2/D3, #2978) quando o
editor quer promover o apoio numa edição diária. Não é auto-inserido por
padrão (diferente do 📚 livros, #2527) — o editor cola este bloco na lacuna
desejada quando quiser rodar a divulgação.

Formato (título + intro + lista + CTA — #3374): o corpo tem 4 parágrafos
separados por linha em branco — (1) título curto, sem marcador/emoji;
(2) frase de introdução aos benefícios, terminando em ":"; (3) bloco de
lista `- item` (1 por linha) — vira `<ul><li>` real no HTML, não texto com
hífen literal; (4) o CTA sozinho como `[texto](url)` — por ser o ÚNICO
conteúdo do parágrafo, `shouldForceCtaPill` detecta e vira botão pill
centralizado (ver newsletter-render-html.ts).

Sem `**...**` embrulhando o bloco — texto plano aqui vira peso normal (#3373,
o peso da fonte do box SÓ-TEXTO de 1 parágrafo é controlado pelo bold-wrap
da fonte; este bloco é multi-parágrafo e nem passa por esse caminho, mas a
convenção do repo é não embrulhar em bold quando não for pra ficar em negrito).

Aprovado pelo editor na edição 260713 (260712) — textos dos benefícios
revisados 2x (1ª versão inline, 2ª com lista + botão + emoji removido).
-->

A diar.ia.br lançou o programa de apoio.

Quem contribui ajuda a manter a curadoria diária gratuita e ganha benefícios como:

- Artigo Especial - um mergulho fundo num tema do momento, escolhido por apoiadores
- Bastidores da produção - como o pipeline funciona por trás da newsletter
- Panorama do Mês - recap conectando notícias do último mês
- Acesso antecipado a novos projetos
- Sorteios mensais de brindes

[Conheça em apoia.se/diaria](https://apoia.se/diaria)
