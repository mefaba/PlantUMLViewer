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

function Viewer() {
  const [source, setSource] = useState(starterDiagram)
  const [svgUrl, setSvgUrl] = useState('')
  const [svgText, setSvgText] = useState('')
  const [status, setStatus] = useState<RenderState>('idle')
  const [message, setMessage] = useState('Ready to render')
  const [zoom, setZoom] = useState(100)
  const requestId = useRef(0)

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

  useEffect(
    () => () => {
      if (svgUrl) URL.revokeObjectURL(svgUrl)
    },
    [svgUrl],
  )

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
        <button className="viewer-button viewer-button-secondary" type="button" onClick={downloadSvg} disabled={!svgText}>
          Download SVG
        </button>
      </header>

      <section className="viewer-workspace">
        <div className="viewer-panel">
          <div className="viewer-panel-header">
            <div><span className="viewer-eyebrow">Source</span><h2>PlantUML</h2></div>
            <button className="viewer-button viewer-button-primary" type="button" onClick={() => void renderDiagram(source)} disabled={status === 'rendering'}>
              {status === 'rendering' ? 'Rendering…' : 'Render'}
            </button>
          </div>
          <div className="viewer-editor-wrap">
            <textarea aria-label="PlantUML source" value={source} onChange={(event) => setSource(event.target.value)} onKeyDown={handleEditorKeyDown} spellCheck={false} />
          </div>
          <div className="viewer-panel-footer">
            <span>{source.split('\n').length} lines</span>
            <span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to render</span>
          </div>
        </div>

        <div className="viewer-panel">
          <div className="viewer-panel-header">
            <div><span className="viewer-eyebrow">Output</span><h2>Preview</h2></div>
            <div className="viewer-zoom-controls" aria-label="Zoom controls">
              <button type="button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(25, value - 25))}>−</button>
              <button type="button" onClick={() => setZoom(100)}>{zoom}%</button>
              <button type="button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(300, value + 25))}>+</button>
            </div>
          </div>
          <div className="viewer-preview-canvas">
            {svgUrl ? (
              <img src={svgUrl} alt="Rendered PlantUML diagram" style={{ width: `${zoom}%` }} />
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
          </div>
        </div>
      </section>
    </main>
  )
}

export default Viewer
