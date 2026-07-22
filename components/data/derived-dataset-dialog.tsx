"use client"

import * as React from "react"
import { CheckCircle2, GitBranch, Info, Loader2, Scissors, SlidersHorizontal, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createPipelineRun } from "@/lib/api/client"
import type { BackendPipelineRun, BackendTask } from "@/lib/api/types"

export function DerivedDatasetDialog({
  open,
  tasks,
  objectCount,
  classCount,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean
  tasks: BackendTask[]
  objectCount: number
  classCount: number
  projectId?: string | null
  onClose: () => void
  onCreated: (run: BackendPipelineRun) => void
}) {
  const [branchName, setBranchName] = React.useState(defaultBranchName)
  const [error, setError] = React.useState<string | null>(null)
  const [created, setCreated] = React.useState<BackendPipelineRun | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [paddingPercent, setPaddingPercent] = React.useState(8)
  const [maxAssets, setMaxAssets] = React.useState(100)
  const [trainSplit, setTrainSplit] = React.useState(80)
  const [valSplit, setValSplit] = React.useState(10)
  const [testSplit, setTestSplit] = React.useState(10)

  React.useEffect(() => {
    if (!open) return
    setBranchName(defaultBranchName())
    setError(null)
    setCreated(null)
    setPaddingPercent(8)
    setMaxAssets(100)
    setTrainSplit(80)
    setValSplit(10)
    setTestSplit(10)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  const normalizedBranch = slugify(branchName)
  const splitTotal = trainSplit + valSplit + testSplit
  const splitIsValid = splitTotal === 100
  const canSubmit =
    normalizedBranch.length > 0 &&
    tasks.length > 0 &&
    objectCount > 0 &&
    splitIsValid &&
    maxAssets > 0 &&
    !submitting &&
    !created

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!normalizedBranch) {
      setError("Informe um nome para a ramificacao.")
      return
    }
    if (tasks.length === 0) {
      setError("Sincronize ou importe pelo menos uma task antes de criar um dataset derivado.")
      return
    }
    if (objectCount === 0) {
      setError("Nao ha objetos anotados para recortar. Conclua ou sincronize anotacoes primeiro.")
      return
    }
    if (!splitIsValid) {
      setError("A divisao entre treino, validacao e teste precisa somar 100%.")
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")
      const run = await createPipelineRun({
        name: `Dataset derivado ${normalizedBranch}`,
        project_id: projectId || null,
        target_release_name: `${normalizedBranch}_${stamp}`,
        task_external_ids: tasks.map((task) => task.external_id),
        sample_policy: { max_assets: maxAssets },
        definition: {
          type: "detection-to-classification",
          steps: ["filter", "crop", "classification", "review", "release"],
          splits: {
            train: trainSplit / 100,
            val: valSplit / 100,
            test: testSplit / 100,
          },
          padding: { mode: "relative", value: paddingPercent / 100 },
        },
        lineage: {
          branch_name: normalizedBranch,
          project_id: projectId || null,
          config: {
            max_assets: maxAssets,
            padding_percent: paddingPercent,
            split_percent: { train: trainSplit, val: valSplit, test: testSplit },
          },
          source: "data_view",
        },
      })
      setCreated(run)
      onCreated(run)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao foi possivel criar o dataset derivado.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Criar dataset derivado"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <form
        onSubmit={submit}
        className="relative z-10 flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div className="flex min-w-0 gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
              <Scissors className="size-5" />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-foreground">Criar dataset derivado</h2>
              <p className="mt-0.5 text-sm text-muted-foreground text-pretty">
                Gere crops dos objetos anotados para treinar ou revisar um dataset de classificacao.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Fechar"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-start gap-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0 text-brand-blue" />
            <div className="flex flex-col gap-2">
              <p className="font-medium text-foreground">O que sera feito</p>
              <p>
                O pipeline vai ler as anotacoes existentes, recortar cada objeto com a margem escolhida,
                separar os crops nos splits abaixo e criar uma nova ramificacao de dataset.
              </p>
            </div>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Nome da ramificacao</span>
            <span className="relative flex items-center">
              <GitBranch className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
              <input
                value={branchName}
                onChange={(event) => {
                  setBranchName(event.target.value)
                  setError(null)
                }}
                placeholder="Ex.: crops-veiculos-v1"
                disabled={submitting || Boolean(created)}
                className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-brand-blue disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              />
            </span>
            <span className="text-xs text-muted-foreground">
              Release gerado: <span className="font-medium text-foreground">{normalizedBranch || "nome-da-ramificacao"}_AAAAMMDDHHMMSS</span>
            </span>
          </label>

          <div className="grid grid-cols-3 gap-2 text-center">
            <SummaryItem label="Tasks fonte" value={String(tasks.length)} />
            <SummaryItem label="Objetos" value={objectCount.toLocaleString("pt-BR")} />
            <SummaryItem label="Classes" value={String(classCount)} />
          </div>

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <SlidersHorizontal className="size-4 text-brand-blue" />
                Configuracao
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="flex items-center justify-between text-sm font-medium text-foreground">
                  Margem do crop
                  <span className="tabular-nums text-muted-foreground">{paddingPercent}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={30}
                  step={1}
                  value={paddingPercent}
                  disabled={submitting || Boolean(created)}
                  onChange={(event) => setPaddingPercent(Number(event.target.value))}
                  className="w-full accent-brand-blue"
                />
                <span className="text-xs text-muted-foreground">Espaco extra ao redor da bounding box original.</span>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Limite de crops</span>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={maxAssets}
                  disabled={submitting || Boolean(created)}
                  onChange={(event) => setMaxAssets(Number(event.target.value))}
                  className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                />
              </label>

              <div className="grid grid-cols-3 gap-2">
                <SplitInput label="Treino" value={trainSplit} onChange={setTrainSplit} disabled={submitting || Boolean(created)} />
                <SplitInput label="Validacao" value={valSplit} onChange={setValSplit} disabled={submitting || Boolean(created)} />
                <SplitInput label="Teste" value={testSplit} onChange={setTestSplit} disabled={submitting || Boolean(created)} />
              </div>
              <p className={`text-xs ${splitIsValid ? "text-muted-foreground" : "text-destructive"}`}>
                Total do split: {splitTotal}%
              </p>
            </div>

            <PreviewPanel
              branch={normalizedBranch || "nome-da-ramificacao"}
              paddingPercent={paddingPercent}
              maxAssets={maxAssets}
              trainSplit={trainSplit}
              valSplit={valSplit}
              testSplit={testSplit}
            />
          </section>

          <div className="grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <PolicyItem label="Amostra" value={`ate ${maxAssets.toLocaleString("pt-BR")} crops`} />
            <PolicyItem label="Split" value={`${trainSplit} / ${valSplit} / ${testSplit}`} />
            <PolicyItem label="Margem" value={`${paddingPercent}% ao redor`} />
          </div>

          {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          {created && (
            <div className="flex items-start gap-3 rounded-lg bg-brand-green/10 px-3 py-2 text-sm text-brand-green">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <span>Pipeline {created.id.slice(0, 8)} criado. Acompanhe o processamento em Jobs.</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="outline" onClick={onClose}>
            {created ? "Fechar" : "Cancelar"}
          </Button>
          {!created && (
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Scissors className="size-4" />}
              {submitting ? "Criando..." : "Criar ramificacao"}
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function PolicyItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted px-3 py-2">
      <span className="font-medium text-foreground">{label}: </span>
      {value}
    </div>
  )
}

function SplitInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: number
  disabled: boolean
  onChange: (value: number) => void
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type="number"
        min={0}
        max={100}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-10 rounded-lg border border-border bg-background px-2 text-sm tabular-nums outline-none focus:border-brand-blue disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
      />
    </label>
  )
}

function PreviewPanel({
  branch,
  paddingPercent,
  maxAssets,
  trainSplit,
  valSplit,
  testSplit,
}: {
  branch: string
  paddingPercent: number
  maxAssets: number
  trainSplit: number
  valSplit: number
  testSplit: number
}) {
  const inset = Math.max(8, 20 - paddingPercent * 0.35)
  const size = Math.min(78, 48 + paddingPercent)
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
      <p className="text-sm font-medium text-foreground">Preview</p>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-muted">
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(59,130,246,.16),transparent_45%),linear-gradient(45deg,rgba(16,185,129,.12),transparent_55%)]" />
          <div className="absolute left-[24%] top-[24%] h-[38%] w-[44%] rounded border-2 border-warning" />
          <span className="absolute bottom-2 left-2 rounded bg-background/85 px-2 py-1 text-[10px] text-muted-foreground">
            imagem + box
          </span>
        </div>
        <Scissors className="size-4 text-muted-foreground" />
        <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-muted">
          <div
            className="absolute rounded-lg border-2 border-brand-blue bg-brand-blue/10"
            style={{
              inset: `${inset}%`,
              width: `${size}%`,
              height: `${size}%`,
              maxWidth: "84%",
              maxHeight: "84%",
            }}
          />
          <span className="absolute bottom-2 left-2 rounded bg-background/85 px-2 py-1 text-[10px] text-muted-foreground">
            crop + {paddingPercent}%
          </span>
        </div>
      </div>
      <div className="rounded-lg bg-surface-subtle p-3 text-xs text-muted-foreground">
        <p className="truncate font-medium text-foreground">{branch}/</p>
        <p>train/ classe-a ... {trainSplit}%</p>
        <p>val/ classe-a ... {valSplit}%</p>
        <p>test/ classe-a ... {testSplit}%</p>
      </div>
      <p className="text-xs text-muted-foreground">
        O pipeline vai gerar no maximo {maxAssets.toLocaleString("pt-BR")} crops nesta ramificacao.
      </p>
    </div>
  )
}

function defaultBranchName() {
  const date = new Date()
  const day = String(date.getDate()).padStart(2, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  return `crops-classificacao-${day}${month}`
}

function slugify(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
