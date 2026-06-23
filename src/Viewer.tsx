import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './Viewer.css'

const starterDiagram = `@startuml
skinparam backgroundColor transparent
skinparam shadowing false

actor User
participant "PlantUML Viewer" as App
participant "PlantUML CLI" as CLI

User -> App: Paste diagram source
App -> CLI: Render SVG
CLI --> App: Diagram preview
App --> User: Show the result
@enduml`

type RenderState = 'idle' | 'rendering' | 'ready' | 'error'

type SourceRange = {
  startLine: number
  endLine: number
}

type SourceIndexEntry = SourceRange & {
  labels: string[]
  priority: number
}

type DiagramSize = {
  width: number
  height: number
}

type PreviewPointerEvent = {
  clientX: number
  clientY: number
  target: EventTarget | null
}

const minZoom = 10
const maxZoom = 2000
const sourceStorageKey = 'plantuml-viewer.source.v1'
const sourceWidthStorageKey = 'plantuml-viewer.sourceWidth.v1'
const minSourcePanelWidth = 300
const minPreviewPanelWidth = 420

function normalizeLabel(value: string) {
  return value
    .replace(/\\n/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/["'{}()[\],]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
}

function stripPlantUmlMarkup(value: string) {
  return value
    .replace(/#.*/, '')
    .replace(/\+\+|--/g, '')
    .trim()
}

function addSourceEntry(
  entries: SourceIndexEntry[],
  labels: string[],
  range: SourceRange,
  priority: number,
) {
  const cleanLabels = labels
    .map(stripPlantUmlMarkup)
    .map((label) => label.replace(/^"|"$/g, '').trim())
    .filter((label) => normalizeLabel(label).length >= 2)

  if (cleanLabels.length) {
    entries.push({ ...range, labels: cleanLabels, priority })
  }
}

function buildSourceIndex(source: string) {
  const lines = source.split('\n')
  const entries: SourceIndexEntry[] = []
  let titleStart: number | null = null
  let noteStart: number | null = null
  const declarationPattern = /^\s*(actor|participant|boundary|control|entity|database|collections|queue)\s+(?:"([^"]+)"|([^\s#]+))(?:\s+as\s+([\w.$-]+))?/i

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("'")) return

    if (/^title\b/i.test(trimmed)) {
      titleStart = index
      const inlineTitle = trimmed.replace(/^title\b/i, '').trim()
      addSourceEntry(entries, [inlineTitle], { startLine: index, endLine: index }, 80)
      return
    }

    if (/^end\s+title\b/i.test(trimmed)) {
      titleStart = null
      return
    }

    if (titleStart !== null) {
      addSourceEntry(entries, [trimmed], { startLine: index, endLine: index }, 80)
      return
    }

    if (/^note\b/i.test(trimmed)) {
      noteStart = index
      const inlineNote = trimmed.includes(':') ? trimmed.slice(trimmed.indexOf(':') + 1) : ''
      addSourceEntry(entries, [inlineNote], { startLine: index, endLine: index }, 72)
      return
    }

    if (/^end\s+note\b/i.test(trimmed)) {
      noteStart = null
      return
    }

    if (noteStart !== null) {
      addSourceEntry(entries, [trimmed], { startLine: index, endLine: index }, 72)
      return
    }

    const declaration = trimmed.match(declarationPattern)
    if (declaration) {
      const label = declaration[2] || declaration[3] || ''
      const alias = declaration[4] || label
      addSourceEntry(entries, [label, alias], { startLine: index, endLine: index }, 90)
      return
    }

    const box = trimmed.match(/^box\s+"?([^"#]+)"?/i)
    if (box) {
      addSourceEntry(entries, [box[1]], { startLine: index, endLine: index }, 65)
      return
    }

    const separator = trimmed.match(/^==\s*(.*?)\s*==$/)
    if (separator) {
      addSourceEntry(entries, [separator[1]], { startLine: index, endLine: index }, 78)
      return
    }

    const group = trimmed.match(/^(alt|else|break|loop|opt|par|critical|group)\b\s*(.*)$/i)
    if (group) {
      addSourceEntry(entries, [group[2]], { startLine: index, endLine: index }, 76)
      return
    }

    if (/[-.]+[>x]|[<x][-.]+/.test(trimmed) && trimmed.includes(':')) {
      const label = trimmed.slice(trimmed.indexOf(':') + 1).trim()
      addSourceEntry(entries, [label], { startLine: index, endLine: index }, 100)
    }
  })

  return entries
}

function findSourceMatch(label: string, entries: SourceIndexEntry[]): SourceRange | null {
  const normalizedLabel = normalizeLabel(label)
  if (normalizedLabel.length < 2) return null

  let bestEntry: SourceIndexEntry | null = null
  let bestScore = 0

  for (const entry of entries) {
    for (const candidate of entry.labels) {
      const normalizedCandidate = normalizeLabel(candidate)
      if (normalizedCandidate.length < 2) continue

      let score = 0
      if (normalizedCandidate === normalizedLabel) {
        score = 120
      } else if (normalizedCandidate.includes(normalizedLabel)) {
        score = 80 + Math.min(normalizedLabel.length, 30)
      } else if (normalizedLabel.includes(normalizedCandidate) && normalizedCandidate.length >= 4) {
        score = 64 + Math.min(normalizedCandidate.length, 24)
      } else {
        const labelParts = normalizedLabel.split(' ').filter((part) => part.length >= 3)
        const candidateParts = normalizedCandidate.split(' ').filter((part) => part.length >= 3)
        const overlap = labelParts.filter((part) => candidateParts.includes(part)).length
        if (overlap && labelParts.length) {
          score = 42 + overlap * 12
        }
      }

      score += entry.priority

      if (score > bestScore) {
        bestScore = score
        bestEntry = entry
      }
    }
  }

  return bestEntry && bestScore >= 105
    ? { startLine: bestEntry.startLine, endLine: bestEntry.endLine }
    : null
}

function sanitizeSvg(svgText: string) {
  const document = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const parserError = document.querySelector('parsererror')
  if (parserError) return ''

  document.querySelectorAll('script, foreignObject').forEach((element) => element.remove())

  document.querySelectorAll('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLocaleLowerCase()
      const value = attribute.value.trim()

      if (
        name.startsWith('on') ||
        /(?:javascript|vbscript):/i.test(value) ||
        /url\(\s*["']?(?:javascript|vbscript):/i.test(value) ||
        (name.endsWith('href') && /^data:/i.test(value))
      ) {
        element.removeAttribute(attribute.name)
      }
    }
  })

  const root = document.documentElement
  root.setAttribute('role', 'img')
  root.setAttribute('aria-label', 'Rendered PlantUML diagram')
  return new XMLSerializer().serializeToString(root)
}

function getSvgSize(svgText: string): DiagramSize {
  if (!svgText) return { width: 0, height: 0 }
  const document = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = document.querySelector('svg')
  if (!svg) return { width: 0, height: 0 }

  const width = Number.parseFloat(svg.getAttribute('width') || '')
  const height = Number.parseFloat(svg.getAttribute('height') || '')
  if (Number.isFinite(width) && Number.isFinite(height)) {
    return { width, height }
  }

  const viewBox = svg.getAttribute('viewBox')?.split(/\s+/).map(Number)
  if (viewBox?.length === 4 && Number.isFinite(viewBox[2]) && Number.isFinite(viewBox[3])) {
    return { width: viewBox[2], height: viewBox[3] }
  }

  return { width: 0, height: 0 }
}

function rangesEqual(first: SourceRange | null, second: SourceRange | null) {
  return first?.startLine === second?.startLine && first?.endLine === second?.endLine
}

function scrollSourceRangeIntoView(editor: HTMLTextAreaElement, range: SourceRange) {
  const computedStyle = window.getComputedStyle(editor)
  const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 24
  const paddingTop = Number.parseFloat(computedStyle.paddingTop) || 0
  const targetLineTop = paddingTop + range.startLine * lineHeight
  const targetLineBottom = paddingTop + (range.endLine + 1) * lineHeight
  const visibleTop = editor.scrollTop
  const visibleBottom = visibleTop + editor.clientHeight
  const comfortPadding = lineHeight * 3

  if (
    targetLineTop >= visibleTop + comfortPadding &&
    targetLineBottom <= visibleBottom - comfortPadding
  ) {
    return
  }

  const targetScrollTop = Math.max(
    0,
    targetLineTop - editor.clientHeight / 2 + lineHeight / 2,
  )

  editor.scrollTo({ top: targetScrollTop, behavior: 'smooth' })
}

function resolvePreviewSourceRange(
  event: PreviewPointerEvent,
  stage: HTMLDivElement | null,
  sourceIndex: SourceIndexEntry[],
) {
  if (!stage) return null

  const target = event.target instanceof Element ? event.target : null
  const directText = target?.closest('text')
  if (directText && stage.contains(directText)) {
    return findSourceMatch(directText.textContent?.trim() || '', sourceIndex)
  }

  let bestLabel = ''
  let bestDistance = Number.POSITIVE_INFINITY
  stage.querySelectorAll('text').forEach((textElement) => {
    const text = textElement.textContent?.trim()
    if (!text) return

    const bounds = textElement.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return

    const horizontalDistance = Math.max(
      bounds.left - event.clientX,
      event.clientX - bounds.right,
      0,
    )
    const verticalDistance = Math.max(
      bounds.top - event.clientY,
      event.clientY - bounds.bottom,
      0,
    )
    const distance = Math.hypot(horizontalDistance, verticalDistance)

    if (distance < bestDistance) {
      bestDistance = distance
      bestLabel = text
    }
  })

  return bestDistance <= 36 ? findSourceMatch(bestLabel, sourceIndex) : null
}

function loadSavedSource() {
  try {
    return window.localStorage.getItem(sourceStorageKey) ?? starterDiagram
  } catch {
    return starterDiagram
  }
}

function loadSavedSourcePanelWidth() {
  try {
    const savedWidth = Number(window.localStorage.getItem(sourceWidthStorageKey))
    return Number.isFinite(savedWidth) && savedWidth > 0 ? savedWidth : null
  } catch {
    return null
  }
}

function clampSourcePanelWidth(width: number, workspaceWidth?: number) {
  const maxWidth = workspaceWidth
    ? Math.max(minSourcePanelWidth, workspaceWidth - minPreviewPanelWidth - 12)
    : Number.POSITIVE_INFINITY

  return Math.min(maxWidth, Math.max(minSourcePanelWidth, width))
}

function Viewer() {
  const [source, setSource] = useState(loadSavedSource)
  const [svgText, setSvgText] = useState('')
  const [status, setStatus] = useState<RenderState>('idle')
  const [message, setMessage] = useState('Ready to render')
  const [zoom, setZoom] = useState(100)
  const [isDownloadingPng, setIsDownloadingPng] = useState(false)
  const [isSourceCollapsed, setIsSourceCollapsed] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [isResizingSource, setIsResizingSource] = useState(false)
  const [sourcePanelWidth, setSourcePanelWidth] = useState<number | null>(loadSavedSourcePanelWidth)
  const [highlightedSourceRange, setHighlightedSourceRange] = useState<SourceRange | null>(null)
  const [editorScrollTop, setEditorScrollTop] = useState(0)
  const [previewNode, setPreviewNode] = useState<HTMLDivElement | null>(null)
  const sanitizedSvg = useMemo(() => sanitizeSvg(svgText), [svgText])
  const svgSize = useMemo(() => getSvgSize(sanitizedSvg), [sanitizedSvg])
  const sourceIndex = useMemo(() => buildSourceIndex(source), [source])
  const sourceLineCount = useMemo(() => source.split('\n').length, [source])
  const highlightedLines = useMemo(() => {
    if (!highlightedSourceRange) return []
    return Array.from(
      { length: highlightedSourceRange.endLine - highlightedSourceRange.startLine + 1 },
      (_, index) => highlightedSourceRange.startLine + index,
    )
  }, [highlightedSourceRange])
  const hasRenderedSvg = Boolean(sanitizedSvg)
  const requestId = useRef(0)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const sourcePanelRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const previewSpacerRef = useRef<HTMLDivElement>(null)
  const previewPositionRef = useRef<HTMLDivElement>(null)
  const previewStageRef = useRef<HTMLDivElement>(null)
  const viewFrameRef = useRef(0)
  const viewRef = useRef({ zoom: 100, x: 0, y: 0 })
  const diagramSizeRef = useRef({ width: 0, height: 0 })
  const isPanningRef = useRef(false)
  const syncedPreviewScrollTopRef = useRef<number | null>(null)
  const hasRenderedSvgRef = useRef(false)
  const isSourceCollapsedRef = useRef(false)
  const sourceIndexRef = useRef<SourceIndexEntry[]>([])
  const lastNativeWheelEventRef = useRef<WheelEvent | null>(null)
  const panStart = useRef({
    pointerId: 0,
    x: 0,
    y: 0,
    panX: 0,
    panY: 0,
  })
  const sourceResizeStart = useRef({
    pointerId: 0,
    x: 0,
    width: 0,
  })
  const didDragPreviewRef = useRef(false)

  useEffect(() => {
    hasRenderedSvgRef.current = hasRenderedSvg
    isSourceCollapsedRef.current = isSourceCollapsed
    sourceIndexRef.current = sourceIndex
  }, [hasRenderedSvg, isSourceCollapsed, sourceIndex])

  const getVerticalScrollRange = useCallback((zoomLevel = viewRef.current.zoom) => {
    const preview = previewRef.current
    const diagramHeight = diagramSizeRef.current.height
    if (!preview || !diagramHeight) return 0

    const scaledHeight = diagramHeight * (zoomLevel / 100)
    return Math.max(0, Math.ceil(scaledHeight - preview.clientHeight))
  }, [])

  const scheduleViewUpdate = useCallback(() => {
    if (viewFrameRef.current) return

    viewFrameRef.current = window.requestAnimationFrame(() => {
      viewFrameRef.current = 0
      const view = viewRef.current
      const preview = previewRef.current
      let scrollTop = preview?.scrollTop ?? 0

      if (preview && previewSpacerRef.current) {
        const scrollRange = getVerticalScrollRange(view.zoom)
        previewSpacerRef.current.style.height = `${preview.clientHeight + scrollRange}px`

        if (!isPanningRef.current) {
          const nextScrollTop = Math.min(
            scrollRange,
            Math.max(0, scrollRange / 2 - view.y),
          )

          if (Math.abs(preview.scrollTop - nextScrollTop) > 0.5) {
            syncedPreviewScrollTopRef.current = nextScrollTop
            preview.scrollTop = nextScrollTop
          }
        }

        scrollTop = preview.scrollTop
      }

      if (previewPositionRef.current) {
        previewPositionRef.current.style.transform = `translate3d(${view.x}px, ${view.y + scrollTop}px, 0)`
      }
      if (previewStageRef.current) {
        previewStageRef.current.style.transform = `translate3d(-50%, -50%, 0) scale(${view.zoom / 100})`
      }
      setZoom(view.zoom)
    })
  }, [getVerticalScrollRange])

  const setPreviewPositionNode = useCallback((node: HTMLDivElement | null) => {
    previewPositionRef.current = node
    if (node) {
      const view = viewRef.current
      const scrollTop = previewRef.current?.scrollTop ?? 0
      node.style.transform = `translate3d(${view.x}px, ${view.y + scrollTop}px, 0)`
    }
  }, [])

  const setPreviewStageNode = useCallback((node: HTMLDivElement | null) => {
    previewStageRef.current = node
    if (node) {
      node.style.transform = `translate3d(-50%, -50%, 0) scale(${viewRef.current.zoom / 100})`
    }
  }, [])

  const setPreviewCanvasNode = useCallback((node: HTMLDivElement | null) => {
    previewRef.current = node
    setPreviewNode(node)
  }, [])

  const renderDiagram = useCallback(async (diagramSource: string) => {
    const currentRequest = ++requestId.current

    if (!diagramSource.trim()) {
      setStatus('idle')
      setMessage('Paste some PlantUML to begin')
      setSvgText('')
      setHighlightedSourceRange(null)
      return
    }

    setStatus('rendering')
    setMessage('Rendering with PlantUML…')

    try {
      const response = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: diagramSource,
      })
      const renderedSvg = await response.text()
      if (currentRequest !== requestId.current) return

      if (!response.ok || !renderedSvg.includes('<svg')) {
        throw new Error(renderedSvg || 'PlantUML did not return a diagram')
      }

      const plantUmlError = response.headers.get('X-PlantUML-Error')

      setSvgText(renderedSvg)
      setHighlightedSourceRange(null)
      setStatus(plantUmlError ? 'error' : 'ready')
      setMessage(
        plantUmlError
          ? decodeURIComponent(plantUmlError)
          : 'Diagram rendered successfully',
      )
    } catch (error) {
      if (currentRequest !== requestId.current) return
      setStatus('error')
      setMessage(
        error instanceof Error ? error.message : 'Unable to render diagram',
      )
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => renderDiagram(source), 450)
    return () => window.clearTimeout(timer)
  }, [renderDiagram, source])

  useEffect(() => {
    try {
      window.localStorage.setItem(sourceStorageKey, source)
    } catch {
      // Keep the editor usable when browser storage is unavailable or full.
    }
  }, [source])

  useEffect(() => {
    if (sourcePanelWidth === null) return

    try {
      window.localStorage.setItem(sourceWidthStorageKey, String(Math.round(sourcePanelWidth)))
    } catch {
      // Keep resizing usable when browser storage is unavailable or full.
    }
  }, [sourcePanelWidth])

  useEffect(
    () => () => {
      if (viewFrameRef.current) {
        window.cancelAnimationFrame(viewFrameRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    diagramSizeRef.current = svgSize
    scheduleViewUpdate()
  }, [scheduleViewUpdate, svgSize])

  const downloadSvg = () => {
    if (!svgText) return
    const link = document.createElement('a')
    link.href = URL.createObjectURL(
      new Blob([svgText], { type: 'image/svg+xml' }),
    )
    link.download = 'diagram.svg'
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const downloadPng = async () => {
    if (!source.trim() || isDownloadingPng) return
    setIsDownloadingPng(true)

    try {
      const response = await fetch('/api/render', {
        method: 'POST',
        headers: {
          Accept: 'image/png',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: source,
      })

      if (!response.ok) {
        throw new Error((await response.text()) || 'Unable to render PNG')
      }

      const link = document.createElement('a')
      link.href = URL.createObjectURL(await response.blob())
      link.download = 'diagram.png'
      link.click()
      URL.revokeObjectURL(link.href)
    } catch (error) {
      setStatus('error')
      setMessage(
        error instanceof Error ? error.message : 'Unable to download PNG',
      )
    } finally {
      setIsDownloadingPng(false)
    }
  }

  const handleEditorKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      void renderDiagram(source)
    }

    if (event.key === 'Tab') {
      event.preventDefault()
      const target = event.currentTarget
      const start = target.selectionStart
      const end = target.selectionEnd
      setSource(`${source.slice(0, start)}  ${source.slice(end)}`)
      window.requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2
      })
    }
  }

  const changeZoom = (nextZoom: number) => {
    const clampedZoom = Math.min(maxZoom, Math.max(minZoom, nextZoom))
    const currentView = viewRef.current
    const ratio = clampedZoom / currentView.zoom
    viewRef.current = {
      zoom: clampedZoom,
      x: currentView.x * ratio,
      y: currentView.y * ratio,
    }
    scheduleViewUpdate()
  }

  const updateSourceHighlightFromPreview = useCallback((event: PreviewPointerEvent) => {
    if (!hasRenderedSvgRef.current || isSourceCollapsedRef.current) return

    const nextRange = resolvePreviewSourceRange(event, previewStageRef.current, sourceIndexRef.current)
    setHighlightedSourceRange((currentRange) => {
      if (rangesEqual(currentRange, nextRange)) return currentRange
      return nextRange
    })
  }, [])

  const handlePreviewClick = (event: React.PointerEvent<HTMLDivElement>) => {
    if (
      !hasRenderedSvgRef.current ||
      isSourceCollapsedRef.current ||
      isPanningRef.current ||
      didDragPreviewRef.current ||
      !editorRef.current
    ) return

    const nextRange = resolvePreviewSourceRange(event, previewStageRef.current, sourceIndexRef.current)
    if (nextRange) {
      setHighlightedSourceRange(nextRange)
      scrollSourceRangeIntoView(editorRef.current, nextRange)
    }
  }

  const handlePreviewWheel = useCallback((event: WheelEvent) => {
    lastNativeWheelEventRef.current = event
    event.preventDefault()

    const preview = previewRef.current
    if (!preview) return

    const rect = preview.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    const delta =
      event.deltaY *
      (event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? preview.clientHeight
          : 1)
    const currentView = viewRef.current
    const nextZoom = Math.min(
      maxZoom,
      Math.max(minZoom, currentView.zoom * Math.exp(-delta * 0.0015)),
    )
    const ratio = nextZoom / currentView.zoom
    const centeredPointerX = pointerX - preview.clientWidth / 2
    const centeredPointerY = pointerY - preview.clientHeight / 2

    viewRef.current = {
      zoom: nextZoom,
      x:
        centeredPointerX -
        (centeredPointerX - currentView.x) * ratio,
      y:
        centeredPointerY -
        (centeredPointerY - currentView.y) * ratio,
    }
    scheduleViewUpdate()
  }, [scheduleViewUpdate])

  const handlePreviewWheelFallback = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.nativeEvent === lastNativeWheelEventRef.current) return
    handlePreviewWheel(event.nativeEvent)
  }

  const handlePreviewScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!hasRenderedSvgRef.current) return
    if (
      syncedPreviewScrollTopRef.current !== null &&
      Math.abs(event.currentTarget.scrollTop - syncedPreviewScrollTopRef.current) < 1
    ) {
      syncedPreviewScrollTopRef.current = null
      return
    }
    syncedPreviewScrollTopRef.current = null

    const scrollRange = getVerticalScrollRange()
    const nextY = scrollRange / 2 - event.currentTarget.scrollTop
    if (Math.abs(viewRef.current.y - nextY) < 0.5) return

    viewRef.current = {
      ...viewRef.current,
      y: nextY,
    }
    scheduleViewUpdate()
  }

  const handlePreviewPointerDown = useCallback((event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return
    const preview = previewRef.current
    if (!preview) return

    const previewBounds = preview.getBoundingClientRect()
    const scrollbarWidth = preview.offsetWidth - preview.clientWidth

    if (
      scrollbarWidth > 0 &&
      event.clientX >= previewBounds.right - scrollbarWidth
    ) {
      return
    }

    event.preventDefault()
    setHighlightedSourceRange(null)
    didDragPreviewRef.current = false
    panStart.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: viewRef.current.x,
      panY: viewRef.current.y,
    }
    preview.setPointerCapture(event.pointerId)
    isPanningRef.current = true
    setIsPanning(true)
  }, [])

  const handlePreviewPointerDownFallback = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.defaultPrevented) return
    handlePreviewPointerDown(event.nativeEvent)
  }

  const handlePreviewPointerMove = useCallback((event: PointerEvent) => {
    if (!isPanningRef.current || event.pointerId !== panStart.current.pointerId) {
      updateSourceHighlightFromPreview(event)
      return
    }

    const deltaX = event.clientX - panStart.current.x
    const deltaY = event.clientY - panStart.current.y
    if (Math.hypot(deltaX, deltaY) > 3) {
      didDragPreviewRef.current = true
    }

    viewRef.current = {
      ...viewRef.current,
      x: panStart.current.panX + deltaX,
      y: panStart.current.panY + deltaY,
    }
    scheduleViewUpdate()
  }, [scheduleViewUpdate, updateSourceHighlightFromPreview])

  const handlePreviewPointerMoveFallback = (event: React.PointerEvent<HTMLDivElement>) => {
    handlePreviewPointerMove(event.nativeEvent)
  }

  const stopPreviewPan = useCallback((event: PointerEvent) => {
    if (event.pointerId !== panStart.current.pointerId) return
    const preview = previewRef.current
    if (preview?.hasPointerCapture(event.pointerId)) {
      preview.releasePointerCapture(event.pointerId)
    }
    isPanningRef.current = false
    setIsPanning(false)
    scheduleViewUpdate()
  }, [scheduleViewUpdate])

  const stopPreviewPanFallback = (event: React.PointerEvent<HTMLDivElement>) => {
    stopPreviewPan(event.nativeEvent)
  }

  const handlePreviewPointerLeave = useCallback(() => {
    if (!isPanningRef.current) {
      setHighlightedSourceRange(null)
    }
  }, [])

  const handleSourceResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const workspaceWidth = workspaceRef.current?.clientWidth
    const currentSourceWidth =
      sourcePanelWidth ??
      sourcePanelRef.current?.getBoundingClientRect().width ??
      (workspaceWidth ? workspaceWidth * 0.4 : minSourcePanelWidth)

    sourceResizeStart.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      width: clampSourcePanelWidth(currentSourceWidth, workspaceWidth),
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsResizingSource(true)
  }

  const handleSourceResizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizingSource || event.pointerId !== sourceResizeStart.current.pointerId) return
    const workspaceWidth = workspaceRef.current?.clientWidth
    const nextWidth = sourceResizeStart.current.width + event.clientX - sourceResizeStart.current.x
    setSourcePanelWidth(clampSourcePanelWidth(nextWidth, workspaceWidth))
  }

  const stopSourceResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== sourceResizeStart.current.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setIsResizingSource(false)
  }

  useEffect(() => {
    const preview = previewNode
    if (!preview) return

    preview.addEventListener('wheel', handlePreviewWheel, {
      capture: true,
      passive: false,
    })
    preview.addEventListener('pointerdown', handlePreviewPointerDown, { capture: true })
    preview.addEventListener('pointermove', handlePreviewPointerMove, { capture: true })
    preview.addEventListener('pointerup', stopPreviewPan, { capture: true })
    preview.addEventListener('pointercancel', stopPreviewPan, { capture: true })
    preview.addEventListener('pointerleave', handlePreviewPointerLeave)

    return () => {
      preview.removeEventListener('wheel', handlePreviewWheel, { capture: true })
      preview.removeEventListener('pointerdown', handlePreviewPointerDown, { capture: true })
      preview.removeEventListener('pointermove', handlePreviewPointerMove, { capture: true })
      preview.removeEventListener('pointerup', stopPreviewPan, { capture: true })
      preview.removeEventListener('pointercancel', stopPreviewPan, { capture: true })
      preview.removeEventListener('pointerleave', handlePreviewPointerLeave)
    }
  }, [handlePreviewPointerDown, handlePreviewPointerLeave, handlePreviewPointerMove, handlePreviewWheel, previewNode, stopPreviewPan])

  return (
    <main className="viewer-shell">
      <header className="viewer-topbar">
        <div className="viewer-brand">
          <span className="viewer-brand-mark" aria-hidden="true">P</span>
          <div>
            <h1>PlantUML Viewer</h1>
            <p>Local rendering with PlantUML 1.2026.6</p>
          </div>
        </div>
        <div className="viewer-download-actions">
          <button className="viewer-button viewer-button-secondary" type="button" onClick={downloadSvg} disabled={!svgText}>
            Download SVG
          </button>
          <button className="viewer-button viewer-button-secondary" type="button" onClick={() => void downloadPng()} disabled={!svgText || isDownloadingPng}>
            {isDownloadingPng ? 'Creating PNG…' : 'Download PNG'}
          </button>
        </div>
      </header>

      <section
        ref={workspaceRef}
        className={`viewer-workspace${isSourceCollapsed ? ' viewer-workspace-collapsed' : ''}${isResizingSource ? ' viewer-workspace-resizing' : ''}`}
        style={isSourceCollapsed || sourcePanelWidth === null ? undefined : { '--viewer-source-width': `${sourcePanelWidth}px` } as React.CSSProperties}
      >
        {!isSourceCollapsed && <div ref={sourcePanelRef} key="source" className="viewer-panel viewer-source-panel">
          <div className="viewer-panel-header">
            <div><span className="viewer-eyebrow">Source</span><h2>PlantUML</h2></div>
            <div className="viewer-header-actions">
              <button className="viewer-icon-button" type="button" onClick={() => setIsSourceCollapsed(true)} aria-label="Collapse source panel" title="Collapse source panel"><span className="viewer-chevron-left" aria-hidden="true" /></button>
              <button className="viewer-button viewer-button-primary" type="button" onClick={() => void renderDiagram(source)} disabled={status === 'rendering'}>
                {status === 'rendering' ? 'Rendering…' : 'Render'}
              </button>
            </div>
          </div>
          <div className="viewer-editor-wrap">
            <div className="viewer-source-highlight-layer" aria-hidden="true">
              {highlightedLines.map((lineNumber) => (
                <span
                  key={lineNumber}
                  className="viewer-source-highlight-line"
                  style={{ transform: `translateY(calc(${lineNumber} * var(--viewer-editor-line-height) - ${editorScrollTop}px))` }}
                />
              ))}
            </div>
            <textarea
              ref={editorRef}
              aria-label="PlantUML source"
              value={source}
              onChange={(event) => {
                setHighlightedSourceRange(null)
                setSource(event.target.value)
              }}
              onKeyDown={handleEditorKeyDown}
              onScroll={(event) => setEditorScrollTop(event.currentTarget.scrollTop)}
              wrap="off"
              spellCheck={false}
            />
          </div>
          <div className="viewer-panel-footer">
            <span>{sourceLineCount} lines</span>
            <span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to render</span>
          </div>
        </div>}

        {!isSourceCollapsed && <div
          className="viewer-source-resizer"
          role="separator"
          aria-label="Resize source panel"
          aria-orientation="vertical"
          aria-valuemin={minSourcePanelWidth}
          aria-valuenow={sourcePanelWidth === null ? undefined : Math.round(sourcePanelWidth)}
          title="Drag to resize source panel"
          onPointerDown={handleSourceResizePointerDown}
          onPointerMove={handleSourceResizePointerMove}
          onPointerUp={stopSourceResize}
          onPointerCancel={stopSourceResize}
        />}

        <div key="preview" className="viewer-panel viewer-preview-panel">
          <div className="viewer-panel-header">
            <div><span className="viewer-eyebrow">Output</span><h2>Preview</h2></div>
            <div className="viewer-header-actions">
              {isSourceCollapsed && <button className="viewer-button viewer-button-secondary" type="button" onClick={() => setIsSourceCollapsed(false)}>Show source</button>}
              <div className="viewer-zoom-controls" aria-label="Zoom controls">
                <button type="button" aria-label="Zoom out" onClick={() => changeZoom(zoom / 1.25)}>−</button>
                <button type="button" onClick={() => changeZoom(100)}>{Math.round(zoom)}%</button>
                <button type="button" aria-label="Zoom in" onClick={() => changeZoom(zoom * 1.25)}>+</button>
              </div>
            </div>
          </div>
          <div
            ref={setPreviewCanvasNode}
            className={`viewer-preview-canvas${isPanning ? ' viewer-preview-panning' : ''}`}
            onWheelCapture={handlePreviewWheelFallback}
            onPointerDownCapture={handlePreviewPointerDownFallback}
            onPointerMoveCapture={handlePreviewPointerMoveFallback}
            onPointerUpCapture={stopPreviewPanFallback}
            onPointerCancelCapture={stopPreviewPanFallback}
            onClick={handlePreviewClick}
            onScroll={handlePreviewScroll}
            onContextMenu={(event) => event.preventDefault()}
          >
            {hasRenderedSvg ? (
              <>
                <div ref={previewSpacerRef} className="viewer-preview-scroll-spacer" aria-hidden="true" />
                <div
                  ref={setPreviewPositionNode}
                  className="viewer-preview-position"
                >
                  <div
                    ref={setPreviewStageNode}
                    className="viewer-preview-stage"
                    dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
                  />
                </div>
              </>
            ) : (
              <div className="viewer-empty-state">
                <span aria-hidden="true">◇</span>
                <h3>Your diagram will appear here</h3>
                <p>Paste PlantUML source into the editor to get started.</p>
              </div>
            )}
            {status === 'rendering' && <div className="viewer-rendering-scrim" />}
          </div>
          <div className={`viewer-status-bar viewer-status-${status}`}>
            <span className="viewer-status-dot" aria-hidden="true" />
            <span>{message}</span>
            <span className="viewer-navigation-hint">Hover highlights source · Click scrolls source · Drag to pan</span>
          </div>
        </div>
      </section>
    </main>
  )
}

export default Viewer
