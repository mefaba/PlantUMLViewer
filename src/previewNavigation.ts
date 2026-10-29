type SourceRange = {
  startLine: number
  endLine: number
}

/** Find the rendered elements belonging to an absolute editor line. */
export function findPreviewTargets(
  stage: Element,
  line: number,
  resolveLabel: (label: string) => SourceRange | null,
  sourceLineOffset = 0,
): SVGGraphicsElement[] {
  const metadataLine = line - sourceLineOffset
  const matches = [...stage.querySelectorAll<SVGGraphicsElement>('[data-source-line]')]
    .filter((element) => {
      const sourceLine = element.getAttribute('data-source-line')?.trim() || ''
      return /^\d+$/.test(sourceLine)
        && Number(sourceLine) === metadataLine
        && !element.classList.contains('participant-lifeline')
    })

  if (matches.length) {
    const hasParticipantHead = matches.some((element) => (
      element.classList.contains('participant-head')
    ))
    // Nested metadata should produce one highlight for the containing element.
    return matches.filter((element) => (
      !(hasParticipantHead && element.classList.contains('participant-tail'))
      && !matches.some((other) => other !== element && other.contains(element))
    ))
  }

  // Some diagram elements (notably sequence notes/groups) have no source metadata.
  // Keep the label fallback away from elements whose metadata names another line.
  return [...stage.querySelectorAll<SVGTextElement>('text')].filter((element) => {
    if (element.closest('[data-source-line], defs, clipPath, mask, marker, pattern, symbol')) {
      return false
    }

    const label = element.textContent?.trim()
    if (!label) return false
    const range = resolveLabel(label)
    return range !== null && range.startLine <= line && range.endLine >= line
  })
}
