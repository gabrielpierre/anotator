"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Check,
  ChevronRight,
  Info,
  Clock,
  Sparkles,
  Boxes,
  Film,
  ImageIcon,
  Layers,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  XCircle,
  Loader2,
  X,
} from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { StatRow, Meter } from "@/components/app/primitives"
import { SparkLineChart } from "@/components/app/charts"
import { createTrainingRun, fetchDatasetRelease, fetchJobCapacity } from "@/lib/api/client"
import { cn } from "@/lib/utils"
import type { BackendComputeDevice, BackendDatasetRelease, BackendJobCapacity } from "@/lib/api/types"

const STEPS = [
  { key: "dataset", label: "Dataset" },
  { key: "modelo", label: "Modelo" },
  { key: "parametros", label: "Parâmetros" },
  { key: "recursos", label: "Recursos" },
  { key: "revisao", label: "Revisão" },
  { key: "iniciar", label: "Iniciar" },
]

export function TrainingWizard({ release }: { release: string }) {
  const router = useRouter()
  const [step, setStep] = React.useState(0)
  const [cfg, setCfg] = React.useState<SplitConfig>({ ...defaultSplitConfig, release })
  const [trainingCfg, setTrainingCfg] = React.useState<TrainingConfig>({
    baseModel: "YOLO11m",
    epochs: "100",
    batchSize: "16",
    imageSize: "640",
    workers: "8",
    device: "cpu",
    patience: "30",
    seed: "42",
  })
  const [capacity, setCapacity] = React.useState<BackendJobCapacity | null>(null)
  const [datasetRelease, setDatasetRelease] = React.useState<BackendDatasetRelease | null>(null)
  const [starting, setStarting] = React.useState(false)
  const [startError, setStartError] = React.useState<string | null>(null)
  const datasetStats = React.useMemo(() => datasetStatsFromRelease(datasetRelease), [datasetRelease])
  const validation = useSplitValidation(cfg, datasetStats)
  const deviceOptions = React.useMemo(() => deviceOptionsFromCapacity(capacity), [capacity])
  const selectedDeviceLabel = deviceLabel(deviceOptions, trainingCfg.device)

  React.useEffect(() => {
    const controller = new AbortController()
    fetchJobCapacity(controller.signal).then(setCapacity).catch(() => setCapacity(null))
    return () => controller.abort()
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    fetchDatasetRelease(release, controller.signal).then(setDatasetRelease).catch(() => setDatasetRelease(null))
    return () => controller.abort()
  }, [release])

  React.useEffect(() => {
    if (!deviceOptions.some((option) => optionValue(option) === trainingCfg.device)) {
      setTrainingCfg((current) => ({ ...current, device: deviceOptions[0] ? optionValue(deviceOptions[0]) : "cpu" }))
    }
  }, [deviceOptions, trainingCfg.device])

  const nextBlocked = step === 0 && validation.status === "invalid"
  const nextBlockedReason =
    validation.errors[0] ?? "Corrija os erros da divisão de dados para continuar."

  const subtitle =
    step === 0
      ? "Etapa 1 de 6: Configure a divisão e as políticas de preparo dos dados."
      : "Configure os hiperparâmetros e opções de treino do seu modelo."

  async function startTraining() {
    if (starting) return
    setStarting(true)
    setStartError(null)
    try {
      const backendDevice = toBackendDevice(trainingCfg.device)
      const run = await createTrainingRun({
        dataset_release_id: release,
        base_model: toUltralyticsWeight(trainingCfg.baseModel),
        model_family: "detection",
        epochs: intOr(trainingCfg.epochs, 100),
        image_size: intOr(trainingCfg.imageSize, 640),
        batch_size: intOr(trainingCfg.batchSize, 16),
        device: backendDevice,
        workers: intOr(trainingCfg.workers, 8),
        patience: intOr(trainingCfg.patience, 30),
        seed: intOr(trainingCfg.seed, 42),
        config: {
          model_name: trainingCfg.baseModel,
          split: cfg,
          resource_policy: {
            device: backendDevice ?? "auto",
            device_label: selectedDeviceLabel,
            workers: intOr(trainingCfg.workers, 8),
          },
          ultralytics: {
            optimizer: "AdamW",
            cos_lr: true,
            amp: true,
          },
        },
      })
      router.push(`/treinar/${run.id}`)
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Falha ao iniciar treinamento.")
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{release}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" nativeButton={false} render={<Link href="/treinar" />}>
            Cancelar
          </Button>
          <span title={nextBlocked ? nextBlockedReason : undefined} className="inline-flex">
            <Button
              onClick={() => {
                if (step >= STEPS.length - 1) {
                  void startTraining()
                  return
                }
                setStep((s) => Math.min(STEPS.length - 1, s + 1))
              }}
              disabled={nextBlocked || starting}
            >
              {starting ? "Enfileirando..." : step >= STEPS.length - 1 ? "Iniciar treinamento" : "Próximo"}
              <ChevronRight className="size-4" />
            </Button>
          </span>
        </div>
      </div>
      {nextBlocked && (
        <p className="flex items-center justify-end gap-1.5 text-xs text-destructive">
          <XCircle className="size-3.5" />
          {nextBlockedReason}
        </p>
      )}

      {/* Stepper */}
      <Card>
        <ol className="flex flex-wrap items-center gap-y-4">
          {STEPS.map((s, i) => {
            const done = i < step
            const active = i === step
            return (
              <li key={s.key} className="flex flex-1 items-center gap-3">
                <button
                  type="button"
                  onClick={() => setStep(i)}
                  className="flex items-center gap-3 text-left"
                >
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors",
                      done && "bg-brand-green text-white",
                      active && "bg-brand-blue text-white",
                      !done && !active && "bg-muted text-muted-foreground",
                    )}
                  >
                    {done ? <Check className="size-4" /> : i + 1}
                  </span>
                  <span className="flex flex-col">
                    <span className={cn("text-sm font-medium", active ? "text-foreground" : "text-muted-foreground")}>
                      {s.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {done ? "Concluído" : active ? "Atual" : "Pendente"}
                    </span>
                  </span>
                </button>
                {i < STEPS.length - 1 && (
                  <span className={cn("mx-2 hidden h-px flex-1 sm:block", done ? "bg-brand-green" : "bg-border")} />
                )}
              </li>
            )
          })}
        </ol>
      </Card>

      {step === 0 ? (
        <div className="min-w-0">
          <DatasetStep cfg={cfg} setCfg={setCfg} validation={validation} stats={datasetStats} />
        </div>
      ) : (
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          {step === 1 && <ModelStep selected={trainingCfg.baseModel} onSelect={(baseModel) => setTrainingCfg((current) => ({ ...current, baseModel }))} />}
          {step === 2 && <ParametersStep trainingCfg={trainingCfg} setTrainingCfg={setTrainingCfg} />}
          {step === 3 && (
            <ResourcesStep
              trainingCfg={trainingCfg}
              setTrainingCfg={setTrainingCfg}
              deviceOptions={deviceOptions}
            />
          )}
          {step >= 4 && <ReviewStep onStart={startTraining} starting={starting} />}
          {startError && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{startError}</p>
          )}

          {/* Bottom estimate row */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Estimativa de tempo</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
                    <Clock className="size-5" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Tempo estimado</p>
                    <p className="text-xl font-semibold text-foreground">--</p>
                  </div>
                </div>
                <div className="divide-y divide-border">
                  <StatRow label="Por época" value="--" />
                  <StatRow label="Total de iterações" value="--" />
                  <StatRow label="Tamanho do dataset" value="--" />
                </div>
              </CardContent>
            </Card>
            <Card className="lg:col-span-1">
              <CardHeader>
                <CardTitle>Curva esperada de aprendizado</CardTitle>
              </CardHeader>
              <CardContent>
                <SparkLineChart data={[]} dataKey="map5095" color="var(--brand-blue)" height={150} />
                <p className="mt-1 text-center text-xs text-muted-foreground">A curva será preenchida após o treino reportar métricas.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Notas (opcional)</CardTitle>
              </CardHeader>
              <CardContent>
                <textarea
                  placeholder="Adicione observações sobre este treinamento..."
                  className="h-32 w-full resize-none rounded-lg bg-muted p-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/50"
                />
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Right rail — resumo */}
        <aside className="flex min-w-0 flex-col gap-6">
          <Card className="min-w-0 overflow-hidden">
            <CardHeader>
              <CardTitle>Resumo da configuração</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="rounded-xl bg-surface-subtle p-4">
                <div className="divide-y divide-border">
                  <StatRow label="Modelo" value={trainingCfg.baseModel} />
                  <StatRow
                    label="Dataset"
                    value={<span title={release}>{compactId(release)}</span>}
                    valueClassName="inline-block max-w-[150px] truncate font-mono text-xs leading-5"
                  />
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground">PARÂMETROS PRINCIPAIS</p>
                <div className="divide-y divide-border">
                  <StatRow label="Épocas" value={trainingCfg.epochs} />
                  <StatRow label="Batch size" value={trainingCfg.batchSize} />
                  <StatRow label="Imagem (imgsz)" value={trainingCfg.imageSize} />
                  <StatRow label="Dispositivo" value={selectedDeviceLabel} />
                  <StatRow label="Optimizer" value="AdamW" />
                  <StatRow label="LR inicial" value="0.001" />
                  <StatRow label="Scheduler" value="Cosine" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recursos estimados</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Meter
                label="GPU"
                value={trainingCfg.device === "cpu" ? 0 : 100}
                detail={trainingCfg.device === "cpu" ? "CPU selecionada" : selectedDeviceLabel}
                color="bg-brand-green"
              />
              <Meter label="Memória RAM" value={66} detail="~ 15.8 GB" color="bg-brand-blue" />
              <Meter label="CPU" value={54} detail="~ 6.5 cores" color="bg-brand-lavender" />
            </CardContent>
          </Card>

          <Card tone="blue">
            <div className="flex gap-3">
              <Info className="size-5 shrink-0 text-brand-blue" />
              <div>
                <p className="text-sm font-medium text-foreground">Dicas</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Use batch size maior para aproveitar melhor a GPU. Ative AMP para treinos mais rápidos com menor uso
                  de memória.
                </p>
              </div>
            </div>
          </Card>
        </aside>
      </div>
      )}
    </div>
  )
}

/* ---------- Steps ---------- */

type TrainingConfig = {
  baseModel: string
  epochs: string
  batchSize: string
  imageSize: string
  workers: string
  device: string
  patience: string
  seed: string
}

function intOr(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function toUltralyticsWeight(model: string) {
  return `${model.toLowerCase()}.pt`
}

function compactId(value: string) {
  if (value.length <= 18) return value
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

function toBackendDevice(device: string) {
  const normalized = device.trim().toLowerCase()
  if (!normalized || normalized === "auto") return null
  if (normalized === "cpu" || normalized.startsWith("cpu")) return "cpu"
  if (normalized === "0" || normalized.startsWith("1x")) return "0"
  if (normalized === "0,1" || normalized.startsWith("2x")) return "0,1"
  return device
}

type SelectOption = string | { value: string; label: string; disabled?: boolean }

function deviceOptionsFromCapacity(capacity: BackendJobCapacity | null): SelectOption[] {
  const devices = Array.isArray(capacity?.gpu?.device_options) ? capacity.gpu.device_options : []
  const available = devices.filter((device) => device.available !== false)
  const availableValues = new Set(available.map((device) => String(device.id)))
  const detected = Array.isArray(capacity?.gpu?.detected_devices) ? capacity.gpu.detected_devices : []
  const unavailableDetected = detected
    .filter((device) => !availableValues.has(String(device.id)))
    .map((device) => ({
      value: `unavailable-${String(device.id)}`,
      label: `${deviceOptionLabel(device)} indisponível no Docker`,
      disabled: true,
    }))
  if (!available.length) {
    return [{ value: "cpu", label: cpuLabelFromCapacity(capacity) }, ...unavailableDetected]
  }
  return [
    ...available.map((device) => ({
      value: String(device.id),
      label: deviceOptionLabel(device),
    })),
    ...unavailableDetected,
  ]
}

function deviceOptionLabel(device: BackendComputeDevice) {
  if (device.type === "cpu") return device.label ?? device.name ?? "CPU"
  const memory = typeof device.memory_total_bytes === "number" ? ` (${formatBytes(device.memory_total_bytes)})` : ""
  return device.label ?? `GPU ${device.index ?? device.id} - ${device.name}${memory}`
}

function cpuLabelFromCapacity(capacity: BackendJobCapacity | null) {
  return capacity?.cpu_count ? `CPU (${capacity.cpu_count} cores)` : "CPU"
}

function deviceLabel(options: SelectOption[], value: string) {
  const option = options.find((entry) => optionValue(entry) === value)
  return option ? optionLabel(option) : value
}

function optionValue(option: SelectOption) {
  return typeof option === "string" ? option : option.value
}

function optionLabel(option: SelectOption) {
  return typeof option === "string" ? option : option.label
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} GB`
  }
  if (value >= 1024 * 1024) {
    return `${Math.round(value / 1024 / 1024).toLocaleString("pt-BR")} MB`
  }
  return `${Math.round(value / 1024).toLocaleString("pt-BR")} KB`
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm text-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

function TextField({
  defaultValue,
  value,
  onChange,
  className,
}: {
  defaultValue?: string
  value?: string
  onChange?: (v: string) => void
  className?: string
}) {
  const controlled = value !== undefined
  return (
    <input
      value={controlled ? value : undefined}
      defaultValue={controlled ? undefined : defaultValue}
      onChange={(e) => onChange?.(e.target.value)}
      className={cn(
        "h-9 rounded-lg bg-muted px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50",
        className,
      )}
    />
  )
}

function SelectField({
  options,
  defaultValue,
  value,
  onChange,
}: {
  options: SelectOption[]
  defaultValue?: string
  value?: string
  onChange?: (v: string) => void
}) {
  const controlled = value !== undefined
  return (
    <select
      value={controlled ? value : undefined}
      defaultValue={controlled ? undefined : defaultValue}
      onChange={(e) => onChange?.(e.target.value)}
      className="h-9 rounded-lg bg-muted px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
    >
      {options.map((option) => (
        <option key={optionValue(option)} value={optionValue(option)} disabled={typeof option !== "string" && option.disabled}>
          {optionLabel(option)}
        </option>
      ))}
    </select>
  )
}

function Toggle({
  checked,
  defaultChecked = false,
  onCheckedChange,
}: {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (v: boolean) => void
}) {
  const [internal, setInternal] = React.useState(defaultChecked)
  const on = checked ?? internal
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => {
        const next = !on
        if (checked === undefined) setInternal(next)
        onCheckedChange?.(next)
      }}
      className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-brand-green" : "bg-muted")}
    >
      <span
        className={cn(
          "absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform",
          on ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  )
}

function ToggleRow({
  label,
  hint,
  defaultChecked,
  children,
}: {
  label: string
  hint?: string
  defaultChecked?: boolean
  /** Optional render function that receives the current on/off state to reveal extra inputs. */
  children?: React.ReactNode
}) {
  const [on, setOn] = React.useState(defaultChecked ?? false)
  return (
    <div className="py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-sm text-foreground">{label}</span>
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </div>
        <Toggle checked={on} onCheckedChange={setOn} />
      </div>
      {on && children && (
        <div className="mt-3 flex flex-col gap-3 rounded-lg bg-surface-subtle p-3">{children}</div>
      )}
    </div>
  )
}

/** Compact inline field used inside expandable toggle rows. */
function MiniField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="w-40 shrink-0">{children}</div>
    </label>
  )
}

function MiniText({ defaultValue, suffix }: { defaultValue: string; suffix?: string }) {
  return (
    <div className="flex items-center gap-2">
      <input
        defaultValue={defaultValue}
        className="h-8 w-full rounded-md bg-card px-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  )
}

function MiniSelect({ options, defaultValue }: { options: string[]; defaultValue?: string }) {
  return (
    <select
      defaultValue={defaultValue}
      className="h-8 w-full rounded-md bg-card px-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

function ParametersStep({
  trainingCfg,
  setTrainingCfg,
}: {
  trainingCfg: TrainingConfig
  setTrainingCfg: React.Dispatch<React.SetStateAction<TrainingConfig>>
}) {
  const set = (key: keyof TrainingConfig) => (value: string) => {
    setTrainingCfg((current) => ({ ...current, [key]: value }))
  }
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>Parâmetros principais</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field label="Épocas"><TextField value={trainingCfg.epochs} onChange={set("epochs")} /></Field>
          <Field label="Batch size"><TextField value={trainingCfg.batchSize} onChange={set("batchSize")} /></Field>
          <Field label="Imagem (imgsz)">
            <SelectField
              options={["320", "480", "640", "960", "1280"]}
              value={trainingCfg.imageSize}
              onChange={set("imageSize")}
            />
          </Field>
          <Field label="Acumulação de gradientes" hint="Passos para acumular antes do update">
            <TextField defaultValue="1" />
          </Field>
          <Field label="Early stopping (paciência)" hint="Parar treino se não melhorar por N épocas">
            <TextField value={trainingCfg.patience} onChange={set("patience")} />
          </Field>
          <Field label="Seed (reprodutibilidade)"><TextField value={trainingCfg.seed} onChange={set("seed")} /></Field>
          <ToggleRow label="Determinístico (reprodutível)" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Otimização</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field label="Otimizador">
            <SelectField options={["AdamW", "SGD", "Adam", "RMSProp"]} defaultValue="AdamW" />
          </Field>
          <Field label="Learning rate inicial (lr0)"><TextField defaultValue="0.001" /></Field>
          <Field label="Lr final (lrf)"><TextField defaultValue="0.01" /></Field>
          <Field label="Weight decay"><TextField defaultValue="0.0005" /></Field>
          <Field label="Momentum"><TextField defaultValue="0.937" /></Field>
          <Field label="Scheduler">
            <SelectField options={["Cosine", "Linear", "Step", "Polynomial"]} defaultValue="Cosine" />
          </Field>
          <Field label="Warmup épocas"><TextField defaultValue="3.0" /></Field>
          <Field label="Warmup bias lr"><TextField defaultValue="0.1" /></Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Outras opções</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          <ToggleRow label="AMP (FP16)" hint="Treino em precisão mista" defaultChecked />

          <ToggleRow label="Cálculo de mAP durante treino" defaultChecked>
            <MiniField label="Frequência (épocas)">
              <MiniText defaultValue="1" />
            </MiniField>
            <MiniField label="Split de validação">
              <MiniSelect options={["val", "test", "train"]} defaultValue="val" />
            </MiniField>
            <MiniField label="Gerar plots">
              <MiniSelect options={["Sim", "Não"]} defaultValue="Sim" />
            </MiniField>
          </ToggleRow>

          <ToggleRow label="Salvar checkpoints" defaultChecked>
            <MiniField label="Salvar a cada (épocas)">
              <MiniText defaultValue="10" />
            </MiniField>
            <MiniField label="Retenção (últimos N)">
              <MiniText defaultValue="3" />
            </MiniField>
          </ToggleRow>

          <ToggleRow label="Cache em memória" defaultChecked>
            <MiniField label="Tipo de cache">
              <MiniSelect options={["RAM", "Disco"]} defaultValue="RAM" />
            </MiniField>
          </ToggleRow>

          <ToggleRow label="MixUp" defaultChecked>
            <MiniField label="Probabilidade">
              <MiniText defaultValue="0.1" />
            </MiniField>
          </ToggleRow>

          <ToggleRow label="Mosaic" defaultChecked>
            <MiniField label="Probabilidade">
              <MiniText defaultValue="1.0" />
            </MiniField>
            <MiniField label="Fechar nas últimas (épocas)">
              <MiniText defaultValue="10" />
            </MiniField>
          </ToggleRow>

          <ToggleRow label="Label smoothing">
            <MiniField label="Epsilon">
              <MiniText defaultValue="0.0" />
            </MiniField>
          </ToggleRow>

          <ToggleRow label="Dropout" hint="Apenas para classificação">
            <MiniField label="Taxa de dropout">
              <MiniText defaultValue="0.0" />
            </MiniField>
          </ToggleRow>
        </CardContent>
      </Card>
    </div>
  )
}

/* ---------- Dataset step helpers ---------- */

function SectionCard({
  n,
  title,
  action,
  className,
  children,
}: {
  n: number
  title: string
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-blue/15 text-xs font-semibold text-brand-blue">
            {n}
          </span>
          <CardTitle>{title}</CardTitle>
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Checkbox({
  label,
  hint,
  defaultChecked = false,
  checked,
  onCheckedChange,
}: {
  label: string
  hint?: boolean
  defaultChecked?: boolean
  checked?: boolean
  onCheckedChange?: (v: boolean) => void
}) {
  const [internal, setInternal] = React.useState(defaultChecked)
  const on = checked ?? internal
  return (
    <button
      type="button"
      onClick={() => {
        const next = !on
        if (checked === undefined) setInternal(next)
        onCheckedChange?.(next)
      }}
      className="flex items-center gap-2 text-left"
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors",
          on ? "border-brand-green bg-brand-green text-white" : "border-border",
        )}
      >
        {on && <Check className="size-3" />}
      </span>
      <span className="inline-flex items-center gap-1 text-sm text-foreground">
        {label}
        {hint && <Info className="size-3 text-muted-foreground" />}
      </span>
    </button>
  )
}

function InfoLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      {children}
      <Info className="size-3" />
    </span>
  )
}

/* ---------- Split configuration & validation ---------- */

export type SplitConfig = {
  release: string
  dataType: string
  groupBy: string
  sampling: string
  strategy: string
  minDistance: string
  embargo: string
  keepTracks: boolean
  train: string
  val: string
  test: string
  seed: string
  stratify: boolean
  preserveGroups: boolean
  lockTest: boolean
  augPreset: string
  augApplyIn: string
  augMode: string
}

export const defaultSplitConfig: SplitConfig = {
  release: "",
  dataType: "video",
  groupBy: "Vídeo / sessão de captura",
  sampling: "Frames anotados + distância mínima",
  strategy: "Automática recomendada",
  minDistance: "5",
  embargo: "2",
  keepTracks: true,
  train: "80",
  val: "10",
  test: "10",
  seed: "42",
  stratify: true,
  preserveGroups: true,
  lockTest: true,
  augPreset: "Conservador",
  augApplyIn: "Somente treino",
  augMode: "Online durante treinamento",
}

type DatasetClassStat = { name: string; total: number }

type DatasetStats = {
  loaded: boolean
  images: number
  objects: number
  videos: number
  minutes: number
  classes: DatasetClassStat[]
}

const EMPTY_DATASET_STATS: DatasetStats = {
  loaded: false,
  images: 0,
  objects: 0,
  videos: 0,
  minutes: 0,
  classes: [],
}

export type SplitRow = {
  key: "train" | "val" | "test" | "total"
  label: string
  dot: string
  pct: number
  images: number
  objects: number
  videos: number
  minutes: number
}

export type ClassRow = { name: string; train: number; val: number; test: number; total: number }

export type ValidationResult = {
  status: "loading" | "valid" | "warning" | "invalid"
  rows: SplitRow[]
  classes: ClassRow[]
  checks: string[]
  warnings: string[]
  errors: string[]
}

function formatDuration(min: number) {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}min`
}

function computeValidation(cfg: SplitConfig, stats: DatasetStats = EMPTY_DATASET_STATS): ValidationResult {
  const train = Number(cfg.train) || 0
  const val = Number(cfg.val) || 0
  const test = Number(cfg.test) || 0
  const sum = train + val + test
  const weights = [train, val, test]
  const imageCounts = distributeCount(stats.images, weights)
  const objectCounts = distributeCount(stats.objects, weights)
  const videoCounts = distributeCount(stats.videos, weights)
  const minuteCounts = distributeCount(stats.minutes, weights)

  const rows: SplitRow[] = [
    {
      key: "train",
      label: "Train",
      dot: "bg-brand-green",
      pct: train,
      images: imageCounts[0],
      objects: objectCounts[0],
      videos: videoCounts[0],
      minutes: minuteCounts[0],
    },
    {
      key: "val",
      label: "Validação",
      dot: "bg-brand-blue",
      pct: val,
      images: imageCounts[1],
      objects: objectCounts[1],
      videos: videoCounts[1],
      minutes: minuteCounts[1],
    },
    {
      key: "test",
      label: "Teste",
      dot: "bg-brand-lavender",
      pct: test,
      images: imageCounts[2],
      objects: objectCounts[2],
      videos: videoCounts[2],
      minutes: minuteCounts[2],
    },
    {
      key: "total",
      label: "Total",
      dot: "",
      pct: sum,
      images: stats.images,
      objects: stats.objects,
      videos: stats.videos,
      minutes: stats.minutes,
    },
  ]

  const classes: ClassRow[] = stats.classes.map((c) => ({
    name: c.name,
    train: Math.round((c.total * train) / 100),
    val: Math.round((c.total * val) / 100),
    test: Math.round((c.total * test) / 100),
    total: c.total,
  }))

  const errors: string[] = []
  const warnings: string[] = []
  const checks: string[] = []

  if (sum !== 100) errors.push(`As porcentagens devem somar 100% (atual: ${sum}%)`)
  if (train <= 0) errors.push("O split de train deve ser maior que 0%")
  if (val <= 0) errors.push("O split de validação deve ser maior que 0%")

  if (errors.length === 0) {
    const temporal = cfg.dataType !== "imagens"
    if (temporal) {
      checks.push("Nenhum vídeo cruza train/val/test")
      if (cfg.keepTracks && cfg.preserveGroups) checks.push("Nenhum track cruza train/val/test")
    }
    checks.push("Todas as classes aparecem em train e validação")

    if (test === 0) {
      warnings.push("Sem conjunto de teste: métricas finais não poderão ser calculadas")
    } else {
      for (const c of classes) {
        if (c.test > 0 && c.test < 15) {
          warnings.push(`Classe "${c.name}" possui poucos exemplos no test (${c.test} objetos)`)
        }
      }
    }
    if (!cfg.stratify) {
      warnings.push("Estratificação por classe desativada: distribuição pode ficar desbalanceada")
    }
  }

  const status: ValidationResult["status"] =
    errors.length > 0 ? "invalid" : warnings.length > 0 ? "warning" : "valid"

  return { status, rows, classes, checks, warnings, errors }
}

function distributeCount(total: number, weights: number[]) {
  const integerTotal = Math.max(0, Math.round(total))
  const normalizedWeights = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0))
  const weightTotal = normalizedWeights.reduce((sum, weight) => sum + weight, 0)
  if (integerTotal === 0 || weightTotal === 0) return normalizedWeights.map(() => 0)

  const exactCounts = normalizedWeights.map((weight) => (integerTotal * weight) / weightTotal)
  const counts = exactCounts.map(Math.floor)
  let remaining = integerTotal - counts.reduce((sum, count) => sum + count, 0)
  const order = exactCounts
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder)

  for (let i = 0; remaining > 0 && order.length > 0; i += 1, remaining -= 1) {
    counts[order[i % order.length].index] += 1
  }

  return counts
}

/** Recalcula a validação do split com debounce a cada alteração de configuração. */
function useSplitValidation(cfg: SplitConfig, stats: DatasetStats, delay = 500): ValidationResult {
  const [result, setResult] = React.useState<ValidationResult>(() => computeValidation(cfg, stats))
  const key = JSON.stringify({ cfg, stats })

  React.useEffect(() => {
    setResult((prev) => ({ ...prev, status: "loading" }))
    const t = setTimeout(() => setResult(computeValidation(cfg, stats)), delay)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delay])

  return result
}

function datasetStatsFromRelease(release: BackendDatasetRelease | null): DatasetStats {
  if (!release) return EMPTY_DATASET_STATS
  const snapshot = objectRecord(release.snapshot)
  const counts = objectRecord(snapshot.counts)
  const prepared = objectRecord(snapshot.prepared_dataset)
  const manifest = objectRecord(prepared.manifest)
  const manifestImages = arrayOfRecords(manifest.images)
  const manifestClasses = stringArray(manifest.classes)
  const labelNames = arrayOfRecords(snapshot.labels)
    .map((label) => stringValue(label.name))
    .filter((name): name is string => Boolean(name))
  const classNames = uniqueStrings(manifestClasses.length ? manifestClasses : labelNames)
  const manifestObjectCount = manifestImages.reduce(
    (total, image) => total + (numberValue(image.boxes) ?? 0),
    0,
  )
  const imageCount = manifestImages.length || numberValue(counts.images) || 0
  const objectCount =
    manifestObjectCount || numberValue(counts.annotations) || numberValue(counts.objects) || 0
  const classes =
    classNames.length === 1 && objectCount > 0
      ? [{ name: classNames[0], total: objectCount }]
      : classNames.map((name) => ({ name, total: 0 }))

  return {
    loaded: true,
    images: imageCount,
    objects: objectCount,
    videos: numberValue(counts.videos) || 0,
    minutes: numberValue(counts.minutes) || 0,
    classes,
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter((item): item is string => Boolean(item)) : []
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values))
}

export const splitStatusMeta = {
  loading: { label: "Calculando divisão...", dot: "bg-muted-foreground", text: "text-muted-foreground" },
  valid: { label: "Split válido", dot: "bg-brand-green", text: "text-brand-green" },
  warning: { label: "Válido com alerta", dot: "bg-warning", text: "text-warning" },
  invalid: { label: "Split inválido", dot: "bg-destructive", text: "text-destructive" },
} as const

function DatasetStep({
  cfg,
  setCfg,
  validation,
  stats,
}: {
  cfg: SplitConfig
  setCfg: React.Dispatch<React.SetStateAction<SplitConfig>>
  validation: ValidationResult
  stats: DatasetStats
}) {
  const set = <K extends keyof SplitConfig>(k: K, v: SplitConfig[K]) => setCfg((c) => ({ ...c, [k]: v }))
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const dataTypes = [
    { id: "imagens", title: "Imagens independentes", desc: "Fotos sem relação temporal entre si.", icon: ImageIcon },
    { id: "video", title: "Vídeo / temporal", desc: "Frames, vídeos, tracks ou sequências contínuas.", icon: Film },
    { id: "misto", title: "Dataset misto", desc: "Contém imagens soltas e frames extraídos de vídeo.", icon: Layers },
  ]

  const splitTabs = ["Usar split existente", "Criar novo split"]
  const [splitTab, setSplitTab] = React.useState("Criar novo split")

  const presets = ["Desligado", "Conservador", "Padrão", "Forte", "Personalizado"]
  const [presetOpen, setPresetOpen] = React.useState(false)

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* 1. Tipo de dados */}
      <SectionCard n={1} title="Tipo de dados">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {dataTypes.map((t) => {
            const active = cfg.dataType === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => set("dataType", t.id)}
                className={cn(
                  "relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-colors",
                  active ? "border-brand-blue bg-surface-blue" : "border-border hover:bg-muted/40",
                )}
              >
                {active && (
                  <span className="absolute right-2 top-2 flex size-4 items-center justify-center rounded-full bg-brand-blue text-white">
                    <Check className="size-3" />
                  </span>
                )}
                <p className="text-sm font-medium text-foreground">{t.title}</p>
                <t.icon className={cn("size-6", active ? "text-brand-blue" : "text-muted-foreground")} />
                <p className="text-xs leading-relaxed text-muted-foreground">{t.desc}</p>
              </button>
            )
          })}
        </div>
        {cfg.dataType !== "imagens" && (
          <div className="mt-3 flex gap-2 rounded-lg bg-surface-subtle p-3">
            <Info className="size-4 shrink-0 text-brand-blue" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Detectamos relação temporal neste dataset. A divisão será feita preservando vídeos, tracks e blocos de
              tempo.
            </p>
          </div>
        )}
      </SectionCard>

      {/* 2. Política temporal */}
      <SectionCard n={2} title="Política temporal">
        {cfg.dataType === "imagens" ? (
          <div className="flex gap-2 rounded-lg bg-surface-subtle p-3">
            <Info className="size-4 shrink-0 text-muted-foreground" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Não aplicável a imagens independentes. Como não há relação temporal entre as amostras, a divisão é feita de
              forma aleatória, sem agrupamento por vídeo, tracks ou embargo.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="flex min-h-8 items-start">
                  <InfoLabel>Agrupar por</InfoLabel>
                </span>
                <SelectField
                  options={["Vídeo / sessão de captura", "Track ID", "Pasta de origem"]}
                  value={cfg.groupBy}
                  onChange={(v) => set("groupBy", v)}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="flex min-h-8 items-start">
                  <InfoLabel>Amostragem de frames</InfoLabel>
                </span>
                <SelectField
                  options={["Frames anotados + distância mínima", "Todos os frames", "1 a cada N frames"]}
                  value={cfg.sampling}
                  onChange={(v) => set("sampling", v)}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="flex min-h-8 items-start">
                  <InfoLabel>Estratégia de divisão</InfoLabel>
                </span>
                <SelectField
                  options={["Automática recomendada", "Manual por vídeo", "Aleatória por bloco"]}
                  value={cfg.strategy}
                  onChange={(v) => set("strategy", v)}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="flex min-h-8 items-start">
                    <InfoLabel>Distância mínima</InfoLabel>
                  </span>
                  <div className="flex items-center gap-2">
                    <TextField value={cfg.minDistance} onChange={(v) => set("minDistance", v)} className="w-full" />
                    <span className="text-xs text-muted-foreground">frames</span>
                  </div>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="flex min-h-8 items-start">
                    <InfoLabel>Embargo entre blocos</InfoLabel>
                  </span>
                  <div className="flex items-center gap-2">
                    <TextField value={cfg.embargo} onChange={(v) => set("embargo", v)} className="w-full" />
                    <span className="text-xs text-muted-foreground">segundos</span>
                  </div>
                </label>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-border pt-4">
              <span className="inline-flex items-center gap-1 text-sm text-foreground">
                Manter tracks no mesmo split
                <Info className="size-3 text-muted-foreground" />
              </span>
              <Toggle checked={cfg.keepTracks} onCheckedChange={(v) => set("keepTracks", v)} />
            </div>
          </>
        )}
      </SectionCard>

      {/* 3. Divisão de dados */}
      <SectionCard
        n={3}
        title="Divisão de dados"
        action={<SplitStatusChip validation={validation} onClick={() => setDetailsOpen(true)} />}
      >
        <div className="mb-4 inline-flex rounded-lg bg-muted p-1">
          {splitTabs.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSplitTab(t)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                splitTab === t ? "bg-brand-blue text-white" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-foreground">Train</span>
            <div className="flex items-center gap-2">
              <TextField value={cfg.train} onChange={(v) => set("train", v)} className="w-full" />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-foreground">Validação</span>
            <div className="flex items-center gap-2">
              <TextField value={cfg.val} onChange={(v) => set("val", v)} className="w-full" />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-foreground">Teste</span>
            <div className="flex items-center gap-2">
              <TextField value={cfg.test} onChange={(v) => set("test", v)} className="w-full" />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
          </label>
          <label className="flex flex-col gap-1.5">
            <InfoLabel>Seed da divisão</InfoLabel>
            <TextField value={cfg.seed} onChange={(v) => set("seed", v)} className="w-full" />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-3">
          <Checkbox
            label="Estratificar por classe"
            checked={cfg.stratify}
            onCheckedChange={(v) => set("stratify", v)}
          />
          <Checkbox
            label="Preservar grupos temporais"
            hint
            checked={cfg.preserveGroups}
            onCheckedChange={(v) => set("preserveGroups", v)}
          />
          <Checkbox
            label="Bloquear test set após criação"
            hint
            checked={cfg.lockTest}
            onCheckedChange={(v) => set("lockTest", v)}
          />
        </div>
        <SplitDistributionPreview cfg={cfg} stats={stats} />
      </SectionCard>

      {/* 4. Augmentation */}
      <SectionCard n={4} title="Augmentation">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-foreground">Aplicar em</span>
            <input
              placeholder="Somente treino"
              value={cfg.augApplyIn}
              onChange={(e) => set("augApplyIn", e.target.value)}
              className="h-9 rounded-lg bg-muted px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/50"
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-foreground">Preset</span>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => {
                const active = cfg.augPreset === p
                // Quando fechado, apenas o chip selecionado é exibido; os demais somem com transição.
                const hidden = !presetOpen && !active
                return (
                  <button
                    key={p}
                    type="button"
                    aria-hidden={hidden}
                    tabIndex={hidden ? -1 : 0}
                    onClick={() => {
                      if (!presetOpen) {
                        setPresetOpen(true)
                      } else {
                        set("augPreset", p)
                        setPresetOpen(false)
                      }
                    }}
                    className={cn(
                      "overflow-hidden whitespace-nowrap rounded-md text-xs font-medium transition-all duration-300 ease-out",
                      active ? "bg-brand-blue text-white" : "bg-muted text-muted-foreground hover:text-foreground",
                      hidden
                        ? "pointer-events-none max-w-0 scale-95 px-0 py-1.5 opacity-0"
                        : "max-w-[10rem] scale-100 px-2.5 py-1.5 opacity-100",
                    )}
                  >
                    {p}
                  </button>
                )
              })}
            </div>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-foreground">Modo</span>
            <SelectField
              options={["Online durante treinamento", "Offline (pré-gerado)"]}
              value={cfg.augMode}
              onChange={(v) => set("augMode", v)}
            />
          </label>
          <div className="flex gap-2 rounded-lg bg-surface-subtle p-3">
            <ShieldCheck className="size-4 shrink-0 text-brand-green" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Preset {cfg.augPreset} aplica variações leves de cor, brilho, escala e posição. Recomendado para datasets
              pequenos ou sensíveis ao contexto.
            </p>
          </div>
        </div>
      </SectionCard>

      <SplitDetailsModal open={detailsOpen} onClose={() => setDetailsOpen(false)} validation={validation} />
    </div>
  )
}

/* ---------- Compact split status ---------- */

function SplitStatusChip({
  validation,
  onClick,
}: {
  validation: ValidationResult
  onClick: () => void
}) {
  const { status } = validation
  const isInvalid = status === "invalid"
  const isLoading = status === "loading"
  const label = isLoading ? "Calculando" : isInvalid ? "Divisão inválida" : "Divisão válida"
  const Icon = isLoading ? Loader2 : isInvalid ? XCircle : CheckCircle2

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLoading}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
        isInvalid
          ? "border-destructive/25 bg-destructive/10 text-destructive hover:bg-destructive/15"
          : "border-brand-green/25 bg-brand-green/10 text-brand-green hover:bg-brand-green/15",
        isLoading && "cursor-default border-border bg-muted text-muted-foreground hover:bg-muted",
      )}
      aria-label={isLoading ? "Calculando divisão" : "Abrir detalhes da divisão"}
      title={isLoading ? "Calculando divisão" : "Ver detalhes da divisão"}
    >
      <Icon className={cn("size-3.5", isLoading && "animate-spin")} />
      {label}
    </button>
  )
}

/* ---------- Split details modal ---------- */

function SplitDetailsModal({
  open,
  onClose,
  validation,
}: {
  open: boolean
  onClose: () => void
  validation: ValidationResult
}) {
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  const total = validation.rows.find((r) => r.key === "total")!
  const pctOf = (n: number, base: number) => (base > 0 ? ((n / base) * 100).toFixed(1).replace(".", ",") : "0")

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Detalhes da divisão"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Detalhes da divisão</h2>
            <p className="mt-0.5 inline-flex items-center gap-2 text-sm text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", splitStatusMeta[validation.status].dot)} />
              {splitStatusMeta[validation.status].label}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-6 overflow-y-auto p-5">
          {/* Distribuição por split */}
          <div>
            <p className="mb-2 text-sm font-medium text-foreground">Distribuição por split</p>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Split</th>
                    <th className="px-3 py-2 text-left font-medium">Imagens</th>
                    <th className="px-3 py-2 text-left font-medium">Objetos</th>
                    <th className="px-3 py-2 text-left font-medium">Vídeos</th>
                    <th className="px-3 py-2 text-left font-medium">Duração</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {validation.rows.map((r) => (
                    <tr key={r.key} className={cn("tabular-nums", r.key === "total" && "font-medium")}>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-2 text-foreground">
                          {r.dot && <span className={cn("size-1.5 rounded-full", r.dot)} />}
                          {r.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {r.images.toLocaleString("pt-BR")} ({r.key === "total" ? "100" : r.pct}%)
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {r.objects.toLocaleString("pt-BR")} ({pctOf(r.objects, total.objects)}%)
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{r.videos}</td>
                      <td className="px-3 py-2 text-muted-foreground">{formatDuration(r.minutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Distribuição por classe */}
          <div>
            <p className="mb-2 text-sm font-medium text-foreground">Distribuição por classe</p>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Classe</th>
                    <th className="px-3 py-2 text-right font-medium">Train</th>
                    <th className="px-3 py-2 text-right font-medium">Val</th>
                    <th className="px-3 py-2 text-right font-medium">Test</th>
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {validation.classes.map((c) => {
                    const low = c.test > 0 && c.test < 15
                    return (
                      <tr key={c.name} className="tabular-nums">
                        <td className="px-3 py-2 text-foreground">{c.name}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{c.train.toLocaleString("pt-BR")}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{c.val.toLocaleString("pt-BR")}</td>
                        <td className={cn("px-3 py-2 text-right", low ? "font-medium text-warning" : "text-muted-foreground")}>
                          {c.test.toLocaleString("pt-BR")}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{c.total.toLocaleString("pt-BR")}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Validações */}
          <div>
            <p className="mb-2 text-sm font-medium text-foreground">Validações e alertas</p>
            <div className="flex flex-col gap-1.5">
              {validation.errors.map((e) => (
                <div key={e} className="flex items-start gap-2 text-sm text-destructive">
                  <XCircle className="size-4 shrink-0" />
                  {e}
                </div>
              ))}
              {validation.checks.map((c) => (
                <div key={c} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="size-4 shrink-0 text-brand-green" />
                  {c}
                </div>
              ))}
              {validation.warnings.map((w) => (
                <div key={w} className="flex items-start gap-2 text-sm text-warning">
                  <AlertTriangle className="size-4 shrink-0" />
                  {w}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end border-t border-border p-4">
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
        </div>
      </div>
    </div>
  )
}

function SplitDistributionPreview({
  cfg,
  stats,
}: {
  cfg: SplitConfig
  stats: DatasetStats
}) {
  const liveRows = React.useMemo(() => computeValidation(cfg, stats).rows, [cfg, stats])
  const rows = [
    { key: "train", label: "Treino", color: "bg-brand-green", text: "text-brand-green" },
    { key: "val", label: "Validação", color: "bg-brand-blue", text: "text-brand-blue" },
    { key: "test", label: "Teste", color: "bg-brand-lavender", text: "text-brand-lavender" },
  ] as const
  const splitRows = rows.map((item) => ({
    ...item,
    row: liveRows.find((row) => row.key === item.key),
  }))
  const totalPct = splitRows.reduce((total, item) => total + (item.row?.pct ?? 0), 0)
  const countLabel = (value: number | undefined, suffix: string) =>
    stats.loaded ? `${(value ?? 0).toLocaleString("pt-BR")} ${suffix}` : `-- ${suffix}`

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">Distribuição estimada</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {stats.loaded ? `${stats.images.toLocaleString("pt-BR")} imagens` : "Carregando dados"}
        </span>
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-muted">
        {splitRows.map(({ key, color, row }) => {
          const pct = row?.pct ?? 0
          const width = totalPct > 0 ? (pct / totalPct) * 100 : 0
          return (
            <span
              key={key}
              className={cn("h-full min-w-0", color)}
              style={{ width: `${Math.max(0, width)}%` }}
            />
          )
        })}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
        {splitRows.map(({ key, label, color, text, row }) => (
          <div key={key} className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", color)} />
              <span className={cn("font-medium", text)}>{label}</span>
            </div>
            <p className="mt-1 tabular-nums text-foreground">{countLabel(row?.images, "img")}</p>
            <p className="mt-0.5 tabular-nums text-muted-foreground">
              {countLabel(row?.objects, "anotações")}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

function ModelStep({ selected, onSelect }: { selected: string; onSelect: (model: string) => void }) {
  const models = [
    { id: "YOLO11n", desc: "Nano · mais rápido", params: "2.6M" },
    { id: "YOLO11s", desc: "Small · equilibrado", params: "9.4M" },
    { id: "YOLO11m", desc: "Medium · recomendado", params: "20.1M", tag: "Recomendado" },
    { id: "YOLO11l", desc: "Large · mais preciso", params: "25.3M" },
  ]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Selecione o modelo base</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {models.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onSelect(m.id)}
            className={cn(
              "flex items-center gap-3 rounded-xl border p-4 text-left transition-colors",
              selected === m.id ? "border-brand-blue bg-surface-blue" : "border-border hover:bg-muted/40",
            )}
          >
            <div className="flex size-10 items-center justify-center rounded-lg bg-card text-brand-blue">
              <Boxes className="size-5" />
            </div>
            <div className="flex-1">
              <p className="flex items-center gap-2 font-medium text-foreground">
                {m.id}
                {m.tag && (
                  <span className="rounded-full bg-brand-green/15 px-1.5 py-0.5 text-xs font-medium text-brand-green">
                    {m.tag}
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">{m.desc} · {m.params} params</p>
            </div>
          </button>
        ))}
      </CardContent>
    </Card>
  )
}

function ResourcesStep({
  trainingCfg,
  setTrainingCfg,
  deviceOptions,
}: {
  trainingCfg: TrainingConfig
  setTrainingCfg: React.Dispatch<React.SetStateAction<TrainingConfig>>
  deviceOptions: SelectOption[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recursos de computação</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field label="Dispositivo">
          <SelectField
            options={deviceOptions}
            value={trainingCfg.device}
            onChange={(device) => setTrainingCfg((current) => ({ ...current, device }))}
          />
        </Field>
        <Field label="Workers de dados">
          <TextField
            value={trainingCfg.workers}
            onChange={(workers) => setTrainingCfg((current) => ({ ...current, workers }))}
          />
        </Field>
        <Field label="Limite de memória por GPU (GB)"><TextField defaultValue="" /></Field>
        <ToggleRow label="Distribuir entre múltiplas GPUs (DDP)" />
        <ToggleRow label="Cache de dataset em RAM" />
      </CardContent>
    </Card>
  )
}

function ReviewStep({ onStart, starting }: { onStart: () => void; starting: boolean }) {
  return (
    <Card tone="mint">
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-brand-green/15 text-brand-green">
          <Sparkles className="size-6" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">Tudo pronto para iniciar</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Revise o resumo à direita. Ao iniciar, o treinamento entrará na fila de jobs e você poderá acompanhar as
          métricas em tempo real.
        </p>
        <Button size="lg" onClick={onStart} disabled={starting}>
          {starting ? "Enfileirando..." : "Iniciar treinamento"}
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </Card>
  )
}
