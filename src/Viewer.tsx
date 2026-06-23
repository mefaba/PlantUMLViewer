import { useCallback, useEffect, useRef, useState } from 'react'
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

const minZoom = 10
const maxZoom = 2000
const sourceStorageKey = 'plantuml-viewer.source.v1'

function loadSavedSource() {
  try {
    return window.localStorage.getItem(sourceStorageKey) ?? starterDiagram
  } catch {
    return starterDiagram
  }
}

function Viewer() {
  const [source, setSource] = useState(loadSavedSource)
  const [svgUrl, setSvgUrl] = useState('')
  const [svgText, setSvgText] = useState('')
  const [status, setStatus] = useState<RenderState>('idle')
  const [message, setMessage] = useState('Ready to render')
  const [zoom, setZoom] = useState(100)
  const [isDownloadingPng, setIsDownloadingPng] = useState(false)
  const [isSourceCollapsed, setIsSourceCollapsed] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const requestId = useRef(0)
  const previewRef = useRef<HTMLDivElement>(null)
  const previewSpacerRef = useRef<HTMLDivElement>(null)
  const previewPositionRef = useRef<HTMLDivElement>(null)
  const previewStageRef = useRef<HTMLDivElement>(null)
  const viewFrameRef = useRef(0)
  const viewRef = useRef({ zoom: 100, x: 0, y: 0 })
  const diagramSizeRef = useRef({ width: 0, height: 0 })
  const isPanningRef = useRef(false)
  const panStart = useRef({
    pointerId: 0,
    x: 0,
    y: 0,
    panX: 0,
    panY: 0,
  })

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

  const renderDiagram = useCallback(async (diagramSource: string) => {
    const currentRequest = ++requestId.current

    if (!diagramSource.trim()) {
      setStatus('idle')
      setMessage('Paste some PlantUML to begin')
      setSvgText('')
      setSvgUrl((previousUrl) => {
        if (previousUrl) URL.revokeObjectURL(previousUrl)
        return ''
      })
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
      const blobUrl = URL.createObjectURL(
        new Blob([renderedSvg], { type: 'image/svg+xml' }),
      )

      setSvgText(renderedSvg)
      setSvgUrl((previousUrl) => {
        if (previousUrl) URL.revokeObjectURL(previousUrl)
        return blobUrl
      })
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

  useEffect(
    () => () => {
      if (svgUrl) URL.revokeObjectURL(svgUrl)
      if (viewFrameRef.current) {
        window.cancelAnimationFrame(viewFrameRef.current)
      }
    },
    [svgUrl],
  )

  useEffect(() => {
    const preview = previewRef.current
    if (!preview) return

    const handleWheel = (event: WheelEvent) => {
      if (!svgUrl) return
      event.preventDefault()

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
    }

    preview.addEventListener('wheel', handleWheel, { passive: false })
    return () => preview.removeEventListener('wheel', handleWheel)
  }, [isSourceCollapsed, scheduleViewUpdate, svgUrl])

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

  const handlePreviewScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!svgUrl) return
    const scrollRange = getVerticalScrollRange()
    const nextY = scrollRange / 2 - event.currentTarget.scrollTop
    if (Math.abs(viewRef.current.y - nextY) < 0.5) return

    viewRef.current = {
      ...viewRef.current,
      y: nextY,
    }
    scheduleViewUpdate()
  }

  const handleDiagramLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget
    diagramSizeRef.current = {
      width: image.naturalWidth,
      height: image.naturalHeight,
    }
    scheduleViewUpdate()
  }

  const handlePreviewPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!svgUrl || (event.button !== 0 && event.button !== 1)) return
    const preview = event.currentTarget
    const previewBounds = preview.getBoundingClientRect()
    const scrollbarWidth = preview.offsetWidth - preview.clientWidth

    if (
      scrollbarWidth > 0 &&
      event.clientX >= previewBounds.right - scrollbarWidth
    ) {
      return
    }

    event.preventDefault()
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
  }

  const handlePreviewPointerMove = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!isPanningRef.current || event.pointerId !== panStart.current.pointerId) return
    viewRef.current = {
      ...viewRef.current,
      x: panStart.current.panX + (event.clientX - panStart.current.x),
      y: panStart.current.panY + (event.clientY - panStart.current.y),
    }
    scheduleViewUpdate()
  }

  const stopPreviewPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== panStart.current.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    isPanningRef.current = false
    setIsPanning(false)
    scheduleViewUpdate()
  }

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

      <section className={`viewer-workspace${isSourceCollapsed ? ' viewer-workspace-collapsed' : ''}`}>
        {!isSourceCollapsed && <div key="source" className="viewer-panel viewer-source-panel">
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
            <textarea aria-label="PlantUML source" value={source} onChange={(event) => setSource(event.target.value)} onKeyDown={handleEditorKeyDown} spellCheck={false} />
          </div>
          <div className="viewer-panel-footer">
            <span>{source.split('\n').length} lines</span>
            <span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to render</span>
          </div>
        </div>}

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
            ref={previewRef}
            className={`viewer-preview-canvas${isPanning ? ' viewer-preview-panning' : ''}`}
            onPointerDown={handlePreviewPointerDown}
            onPointerMove={handlePreviewPointerMove}
            onPointerUp={stopPreviewPan}
            onPointerCancel={stopPreviewPan}
            onScroll={handlePreviewScroll}
            onContextMenu={(event) => event.preventDefault()}
          >
            {svgUrl ? (
              <>
                <div ref={previewSpacerRef} className="viewer-preview-scroll-spacer" aria-hidden="true" />
                <div
                  ref={setPreviewPositionNode}
                  className="viewer-preview-position"
                >
                <div
                  ref={setPreviewStageNode}
                  className="viewer-preview-stage"
                >
                  <img
                    src={svgUrl}
                    alt="Rendered PlantUML diagram"
                    draggable={false}
                    onLoad={handleDiagramLoad}
                  />
                </div>
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
            <span className="viewer-navigation-hint">Drag to pan · Mouse wheel to zoom · Scrollbar moves vertically</span>
          </div>
        </div>
      </section>
    </main>
  )
}

export default Viewer
