# Análise: Correção do Preparo de Dataset Para Treino

## Contexto

O treino ruim investigado não era apenas efeito de dataset pequeno. O preparo YOLO da ferramenta podia somar anotações equivalentes vindas do XML exportado pelo CVAT com registros locais sincronizados no banco, gerando labels duplicadas no artefato final. Isso distorce perdas, métricas e o aprendizado, especialmente em datasets pequenos ou com muitas classes raras.

Também havia uma lacuna no split: a interface falava em estratificação por classe, mas a divisão efetiva podia ficar essencialmente proporcional por imagem. Em detecção multi-label, uma imagem pode conter várias classes, então `train_test_split(stratify=classe)` não resolve o problema. A política correta precisa aproximar percentuais globais enquanto tenta manter cada classe representada nos conjuntos relevantes.

## Decisões Implementadas

- O preparo YOLO passa a montar um plano canônico antes de gravar o ZIP.
- Boxes vindos do XML/CVAT são a fonte principal quando o export já contém anotações.
- Registros locais continuam entrando quando o export não contém anotações ou quando são boxes diferentes ainda não sincronizados.
- Duplicatas são removidas por uma chave estável baseada em task, frame, classe, tipo de shape e pontos normalizados.
- O manifest passa a reportar contagens de boxes lidos, duplicados, excluídos e exportados.
- O split aceita política explícita, com default `class_balanced_best_effort`.
- A divisão balanceada é best-effort: reduz classes ausentes em treino e validação, mas não bloqueia quando o dataset é pequeno demais para uma solução perfeita.
- O wizard de treino envia a política real para o backend e usa um preview do manifest preparado para mostrar distribuição e alertas.

## Política de Split

Default aplicado quando a configuração não informa política detalhada:

```json
{
  "strategy": "class_balanced_best_effort",
  "train": 0.8,
  "val": 0.1,
  "test": 0.1,
  "seed": 42,
  "min_per_class_train": 1,
  "min_per_class_val": 1,
  "test_required": false
}
```

O algoritmo usa uma heurística greedy para detecção multi-label. Ele ordena unidades por raridade das classes, tenta respeitar capacidades globais de train/val/test e prioriza splits onde a classe ainda está abaixo da meta. Quando `preserve_groups` está ativo, imagens do mesmo grupo temporal ficam no mesmo split.

## Dataset Health

O manifest preparado inclui `health` com warnings e checks. Os principais alertas são:

- classes sem exemplo no treino;
- classes sem exemplo na validação;
- classes sem exemplo no teste quando o teste é obrigatório;
- classes com poucos objetos;
- labels duplicadas removidas;
- imagens sem anotação incluídas pela política do release;
- classes cadastradas sem anotações no dataset preparado.

## UX

A opção “Estratificar por classe” foi renomeada para “Balancear classes no split”, deixando claro que é uma ação operacional, não uma garantia matemática perfeita. A tela passa a consumir o diagnóstico calculado pelo backend; a estimativa frontend fica apenas como fallback enquanto o preview ainda não chegou.

## Referências de Produto

Ferramentas como Roboflow tratam split como parte do versionamento do dataset, congelando train/valid/test por versão. Também separam preprocessing de augmentation: preprocessing pode ser aplicado em todos os splits, enquanto augmentation deve ficar apenas no treino para evitar avaliação enviesada.

Para uma próxima versão, vale avaliar uma implementação formal de estratificação multi-label, como a família de algoritmos baseada em Sechidis et al. A v1 implementada evita nova dependência e prioriza previsibilidade, compatibilidade e diagnóstico transparente.

