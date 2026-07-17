// Dados mock compartilhados para o CVAT++ (frontend apenas).
// O backend será implementado separadamente; aqui ficam apenas os dados de exibição.

export type JobStatus =
  | "executando"
  | "na-fila"
  | "pausado"
  | "concluido"
  | "falhou"
  | "cancelado"

export const project = {
  name: "Veículos - Cityscapes",
  imagesImported: 10250,
  imagesAnnotated: 8420,
  objectsAnnotated: 43718,
  pendingReview: 93,
  currentModel: "YOLO11m v18",
  bestMap: 0.83,
  activeJobs: 3,
}

export const classes = [
  { name: "car", count: 1234, color: "var(--brand-blue)", share: 28.2 },
  { name: "truck", count: 532, color: "var(--brand-green)", share: 17.5 },
  { name: "bus", count: 312, color: "var(--brand-mint)", share: 9.8 },
  { name: "motorcycle", count: 210, color: "var(--warning)", share: 6.1 },
  { name: "bicycle", count: 98, color: "var(--destructive)", share: 4.2 },
  { name: "person", count: 673, color: "var(--brand-lavender)", share: 15.4 },
  { name: "traffic light", count: 45, color: "var(--brand-sky)", share: 3.1 },
  { name: "traffic sign", count: 120, color: "var(--brand-indigo)", share: 4.9 },
  { name: "others", count: 120, color: "var(--muted-foreground)", share: 10.8 },
]

// Evolução histórica do modelo — cada ponto é uma versão.
export const modelEvolution = [
  { version: "v10", date: "03/05", map: 0.45, anotacoes: 12000, precision: 0.62, recall: 0.5 },
  { version: "v11", date: "10/05", map: 0.49, anotacoes: 16500, precision: 0.65, recall: 0.53 },
  { version: "v12", date: "17/05", map: 0.56, anotacoes: 21000, precision: 0.69, recall: 0.58 },
  { version: "v13", date: "24/05", map: 0.61, anotacoes: 26800, precision: 0.72, recall: 0.61 },
  { version: "v14", date: "31/05", map: 0.66, anotacoes: 30500, precision: 0.75, recall: 0.64 },
  { version: "v15", date: "07/06", map: 0.72, anotacoes: 34200, precision: 0.79, recall: 0.68 },
  { version: "v16", date: "21/06", map: 0.76, anotacoes: 38400, precision: 0.81, recall: 0.71 },
  { version: "v17", date: "05/07", map: 0.78, anotacoes: 41200, precision: 0.82, recall: 0.73 },
  { version: "v18", date: "14/07", map: 0.83, anotacoes: 43718, precision: 0.86, recall: 0.76 },
]

// Curvas por época do treinamento #18 em execução.
export const trainingCurves = Array.from({ length: 41 }, (_, i) => {
  const t = i / 100
  return {
    epoch: i,
    map50: Math.min(0.925, 0.42 + 0.5 * (1 - Math.exp(-i / 12))),
    map5095: Math.min(0.813, 0.2 + 0.55 * (1 - Math.exp(-i / 14))),
    precision: Math.min(0.864, 0.45 + 0.4 * (1 - Math.exp(-i / 11))),
    recall: Math.min(0.768, 0.38 + 0.4 * (1 - Math.exp(-i / 13))),
    loss: Math.max(0.11, 0.9 * Math.exp(-i / 15) + 0.11),
  }
})

export const trainingMetrics = [
  { key: "map50", label: "mAP@0.5", atual: 0.912, melhor: 0.925, epoca: 33, color: "var(--brand-sky)" },
  { key: "map5095", label: "mAP@0.5:0.95", atual: 0.742, melhor: 0.813, epoca: 31, color: "var(--brand-green)" },
  { key: "precision", label: "Precision", atual: 0.823, melhor: 0.864, epoca: 29, color: "var(--brand-lavender)" },
  { key: "recall", label: "Recall", atual: 0.706, melhor: 0.768, epoca: 32, color: "var(--warning)" },
  { key: "loss", label: "Loss", atual: 0.148, melhor: 0.112, epoca: 28, color: "var(--destructive)" },
]

export const confusionClasses = ["car", "truck", "bus", "motorcycle", "bicycle", "person", "others"]
export const confusionMatrix = [
  [1283, 21, 28, 3, 2, 6, 4],
  [17, 512, 11, 1, 0, 3, 2],
  [19, 8, 301, 0, 1, 5, 1],
  [2, 0, 0, 198, 0, 0, 0],
  [1, 0, 0, 0, 96, 3, 0],
  [4, 2, 3, 1, 2, 673, 5],
  [6, 1, 1, 0, 0, 4, 112],
]

export const activeJobs = [
  {
    id: "job_7f3a2c1d",
    name: "Treinamento #18",
    type: "Treinamento",
    tag: "YOLO11m",
    detail: "release_014 · 8.420 imagens",
    progress: 37,
    progressLabel: "37 / 100 épocas",
    status: "executando" as JobStatus,
    startedAt: "14/07/2024 10:32",
    elapsed: "00:18:42",
    eta: "00:32:18",
    gpu: 72,
    ram: "15.8 / 24 GB",
  },
  {
    id: "job_a1b2c3d4",
    name: "Pipeline: det→cls→seg v3",
    type: "Pipeline",
    tag: "Ativo",
    detail: "Lote 04 · 1.250 imagens",
    progress: 68,
    progressLabel: "Etapa 4/8: Geração de crops",
    status: "executando" as JobStatus,
    startedAt: "14/07/2024 11:05",
    elapsed: "00:27:11",
    eta: "00:12:43",
    gpu: 58,
    ram: "12.1 / 24 GB",
  },
  {
    id: "job_c9d8e7f6",
    name: "Exportação COCO",
    type: "Exportação",
    tag: "Na fila",
    detail: "release_013 · Formato COCO",
    progress: 0,
    progressLabel: "Inicializando…",
    status: "na-fila" as JobStatus,
    startedAt: "14/07/2024 11:32",
    elapsed: "00:00:10",
    eta: "--",
    gpu: 23,
    ram: "--",
  },
]

export const queuedJobs = [
  {
    id: "job_d4e5f6a7",
    name: "Geração de thumbnails",
    type: "Pré-processamento",
    detail: "Lote 05 · 3.210 imagens",
    position: "Aguardando recursos",
  },
  {
    id: "job_e5f6a7b8",
    name: "Compactação do dataset",
    type: "Exportação",
    detail: "release_014 · ZIP",
    position: "Posição: 2 de 2",
  },
]

export const recentJobs = [
  {
    id: "job_r1",
    name: "Pipeline: cls→seg v2",
    detail: "Lote 05 · 980 imagens",
    status: "concluido" as JobStatus,
    startedAt: "13/07/2024 18:22",
    elapsed: "00:21:47",
    gpu: 46,
  },
  {
    id: "job_r2",
    name: "Treinamento #17",
    detail: "release_013 · YOLO11m",
    status: "concluido" as JobStatus,
    startedAt: "13/07/2024 15:41",
    elapsed: "01:12:03",
    gpu: 71,
  },
  {
    id: "job_r3",
    name: "Pipeline: det→cls→seg v2",
    detail: "Lote 02 · 1.100 imagens · Erro na etapa 5",
    status: "falhou" as JobStatus,
    startedAt: "13/07/2024 11:07",
    elapsed: "00:14:33",
    gpu: 0,
  },
]

export const machineResources = {
  gpus: [
    { name: "GPU 0 - NVIDIA RTX 4090", util: 78, mem: "16.2 / 24 GB" },
    { name: "GPU 1 - NVIDIA RTX 4090", util: 72, mem: "15.1 / 24 GB" },
  ],
  cpu: { util: 42, mem: "22.6 / 64 GB" },
  disk: { util: 67, label: "642 / 954 GB" },
}

export const trainings = [
  {
    id: "18",
    slug: "18",
    name: "Treinamento #18",
    model: "YOLO11m",
    dataset: "release_014",
    status: "executando" as JobStatus,
    bestMap: "0.813",
    epoch: 37,
    epochs: 100,
    progress: 37,
    elapsed: "00:18:42",
    device: "2x RTX 4090",
    startedAt: "14/07/2024 10:32",
  },
  {
    id: "17",
    slug: "17",
    name: "Treinamento #17",
    model: "YOLO11m",
    dataset: "release_013",
    status: "concluido" as JobStatus,
    bestMap: "0.780",
    epoch: 100,
    epochs: 100,
    progress: 100,
    elapsed: "01:12:03",
    device: "2x RTX 4090",
    startedAt: "13/07/2024 15:41",
  },
  {
    id: "16",
    slug: "16",
    name: "Treinamento #16",
    model: "YOLO11s",
    dataset: "release_012",
    status: "concluido" as JobStatus,
    bestMap: "0.760",
    epoch: 100,
    epochs: 100,
    progress: 100,
    elapsed: "00:48:20",
    device: "1x RTX 4090",
    startedAt: "11/07/2024 09:12",
  },
  {
    id: "15",
    slug: "15",
    name: "Treinamento #15",
    model: "YOLO11m",
    dataset: "release_011",
    status: "falhou" as JobStatus,
    bestMap: "—",
    epoch: 12,
    epochs: 100,
    progress: 12,
    elapsed: "00:09:44",
    device: "1x RTX 4090",
    startedAt: "09/07/2024 14:20",
  },
]

// Anotações da fila de revisão.
export const reviewAnnotations = [
  { id: 88213, cls: "car", conf: 0.93, color: "var(--brand-blue)", origem: "YOLO11m v17", criada: "14/07/2024 10:32" },
  { id: 88214, cls: "car", conf: 0.91, color: "var(--brand-blue)", origem: "YOLO11m v17", criada: "14/07/2024 10:32" },
  { id: 88215, cls: "bus", conf: 0.88, color: "var(--brand-mint)", origem: "YOLO11m v17", criada: "14/07/2024 10:32" },
  { id: 88216, cls: "truck", conf: 0.87, color: "var(--brand-lavender)", origem: "YOLO11m v17", criada: "14/07/2024 10:32" },
  { id: 88217, cls: "motorcycle", conf: 0.76, color: "var(--warning)", origem: "YOLO11m v17", criada: "14/07/2024 10:32" },
  { id: 88218, cls: "car", conf: 0.65, color: "var(--brand-blue)", origem: "YOLO11m v17", criada: "14/07/2024 10:32" },
]

export const reviewFilters = [
  { label: "Todos", count: 1250, active: false },
  { label: "Baixa confiança (< 0.5)", count: 38, active: true },
  { label: "Classe rara", count: 21, active: false },
  { label: "Possíveis erros", count: 93, active: false },
  { label: "Duplicadas", count: 15, active: false },
  { label: "Sem detecção", count: 8, active: false },
  { label: "Track jumps", count: 7, active: false },
  { label: "Incertas", count: 12, active: false },
]

export const pipelineSteps = [
  { n: 1, name: "Entrada", subtitle: "Lote de imagens / vídeos", value: "10.250", unit: "imagens", icon: "input", color: "var(--brand-green)" },
  { n: 2, name: "Detecção", subtitle: "YOLO11m v17", value: "43.718", unit: "predições", icon: "target", color: "var(--brand-sky)", active: true },
  { n: 3, name: "Filtro de confiança", subtitle: "score ≥ 0.35", value: "28.532", unit: "predições", icon: "filter", color: "var(--brand-lavender)" },
  { n: 4, name: "Geração de crops", subtitle: "padding 15% · 224x224", value: "28.532", unit: "crops", icon: "crop", color: "var(--warning)", selected: true },
  { n: 5, name: "Classificação", subtitle: "ResNet50 v6", value: "28.532", unit: "labels", icon: "tag", color: "var(--brand-sky)" },
  { n: 6, name: "Segmentação (por caixa)", subtitle: "YOLO-Seg v9", value: "27.894", unit: "máscaras", icon: "shapes", color: "var(--destructive)" },
  { n: 7, name: "Revisão humana", subtitle: "Fila de revisão", value: "9.312", unit: "pendentes", icon: "shield", color: "var(--brand-green)" },
  { n: 8, name: "Dataset release", subtitle: "release_014 (em construção)", value: "8.420", unit: "itens", icon: "database", color: "var(--brand-indigo)" },
]

export const pipelineRuns = [
  { id: "27", label: "Execução #27", status: "executando" as JobStatus, progress: 68, detail: "Etapa atual: 5. Classificação", meta: "12/07/100", date: "Iniciado em 14/07/2024 10:32" },
  { id: "26", label: "Execução #26", status: "concluido" as JobStatus, progress: 100, detail: "Itens finais: 8.420", meta: "release_013", date: "14/07/2024 08:11" },
  { id: "25", label: "Execução #25", status: "concluido" as JobStatus, progress: 100, detail: "Itens finais: 7.842", meta: "release_012", date: "13/07/2024 21:45" },
  { id: "24", label: "Execução #24", status: "falhou" as JobStatus, progress: 40, detail: "Erro na etapa 5: Classificação", meta: "", date: "13/07/2024 18:22" },
]

export const releases = [
  { id: "release_014", date: "14/07/2024 09:30", images: 8420, objects: 43718, size: "128.6 GB", status: "em-construcao" },
  { id: "release_013", date: "12/07/2024 11:04", images: 7842, objects: 40120, size: "121.2 GB", status: "publicado" },
  { id: "release_012", date: "09/07/2024 16:48", images: 7210, objects: 37450, size: "112.8 GB", status: "publicado" },
  { id: "release_011", date: "06/07/2024 10:15", images: 6680, objects: 34980, size: "104.1 GB", status: "arquivado" },
]

export const auditEvents = [
  { actor: "Gabriel", action: "aceitou", target: "anotação #88213 (car)", reason: "—", conf: 0.93, time: "há 2 min" },
  { actor: "Gabriel", action: "corrigiu classe", target: "anotação #88190 (truck → van)", reason: "Classe incorreta", conf: 0.54, time: "há 5 min" },
  { actor: "Mariana", action: "rejeitou", target: "anotação #88155 (bus)", reason: "Falso positivo", conf: 0.41, time: "há 12 min" },
  { actor: "Sistema", action: "criou release", target: "release_014", reason: "Pipeline concluído", conf: null, time: "há 45 min" },
  { actor: "Gabriel", action: "aplicou ao track", target: "track #4021 (car)", reason: "Propagação de classe", conf: 0.88, time: "há 1 h" },
  { actor: "Mariana", action: "escalou", target: "anotação #88090 (bicycle)", reason: "Caso ambíguo", conf: 0.33, time: "há 1 h" },
  { actor: "Sistema", action: "iniciou treinamento", target: "Treinamento #18", reason: "Agendamento", conf: null, time: "há 2 h" },
]

export const models = [
  { id: "YOLO11m v18", family: "Detecção", arch: "YOLO11m", map: "0.813", dataset: "release_014", createdAt: "14/07/2024", size: "40.5 MB", status: "aprovado" as const, best: true },
  { id: "YOLO11m v17", family: "Detecção", arch: "YOLO11m", map: "0.780", dataset: "release_013", createdAt: "05/07/2024", size: "40.5 MB", status: "publicado" as const, best: false },
  { id: "ResNet50 v6", family: "Classificação", arch: "ResNet50", map: "0.921", dataset: "crops_013", createdAt: "04/07/2024", size: "97.8 MB", status: "publicado" as const, best: false },
  { id: "YOLO-Seg v9", family: "Segmentação", arch: "YOLO11-Seg", map: "0.742", dataset: "release_013", createdAt: "02/07/2024", size: "44.1 MB", status: "publicado" as const, best: false },
  { id: "YOLO11s v12", family: "Detecção", arch: "YOLO11s", map: "0.760", dataset: "release_012", createdAt: "28/06/2024", size: "18.4 MB", status: "arquivado" as const, best: false },
]

export const qualityChecks = [
  { name: "Caixas fora dos limites", count: 12, severity: "alta", detail: "Bounding boxes ultrapassam a imagem" },
  { name: "Classes ausentes no schema", count: 3, severity: "alta", detail: "Labels não mapeados no dataset" },
  { name: "Sobreposição excessiva (IoU > 0.9)", count: 47, severity: "media", detail: "Possíveis duplicatas" },
  { name: "Caixas muito pequenas (< 8px)", count: 118, severity: "media", detail: "Abaixo do tamanho mínimo" },
  { name: "Anotações sem revisão", count: 93, severity: "baixa", detail: "Pendentes na fila de revisão" },
  { name: "Imagens sem anotação", count: 8, severity: "baixa", detail: "Nenhum objeto detectado" },
]

export const qualityScore = { overall: 92, consistency: 96, coverage: 88, agreement: 91 }

export const annotationTasks = [
  { id: "Lote 10", images: 1250, annotated: 342, assignee: "Gabriel", status: "Anotando", progress: 27 },
  { id: "Lote 09", images: 900, annotated: 900, assignee: "Mariana", status: "Concluído", progress: 100 },
  { id: "Lote 08", images: 1100, annotated: 660, assignee: "Equipe", status: "Anotando", progress: 60 },
  { id: "Lote 07", images: 780, annotated: 780, assignee: "Gabriel", status: "Revisão", progress: 100 },
]

export const dataBatches = [
  { id: "Lote 10", images: 1250, status: "Anotando", progress: 27, source: "Cityscapes val", createdAt: "14/07/2024" },
  { id: "Lote 05", images: 3210, status: "Pré-processando", progress: 8, source: "Upload manual", createdAt: "14/07/2024" },
  { id: "Lote 04", images: 1250, status: "Pipeline", progress: 68, source: "Cityscapes train", createdAt: "13/07/2024" },
  { id: "Lote 03", images: 980, status: "Concluído", progress: 100, source: "Cityscapes train", createdAt: "12/07/2024" },
  { id: "Lote 02", images: 1100, status: "Concluído", progress: 100, source: "Cityscapes train", createdAt: "11/07/2024" },
]
