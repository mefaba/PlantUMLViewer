import assert from 'node:assert/strict'
import test from 'node:test'
import { findPreviewTargets } from '../src/previewNavigation.ts'

// Only model the SVG tree operations used by the navigation resolver.
class SvgElement {
  parentElement: SvgElement | null = null
  children: SvgElement[] = []
  textContent = ''
  classList: { contains: (name: string) => boolean }
  tagName: string
  attributes: Record<string, string>

  constructor(
    tagName: string,
    attributes: Record<string, string> = {},
    children: SvgElement[] = [],
  ) {
    this.tagName = tagName
    this.attributes = attributes
    this.classList = {
      contains: (name) => (attributes.class || '').split(' ').includes(name),
    }
    children.forEach((child) => {
      child.parentElement = this
      this.children.push(child)
    })
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null
  }

  matches(selector: string) {
    return selector.split(',').some((part) => {
      const trimmed = part.trim()
      return trimmed === '[data-source-line]'
        ? this.getAttribute('data-source-line') !== null
        : this.tagName === trimmed
    })
  }

  querySelectorAll(selector: string): SvgElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }

  closest(selector: string): SvgElement | null {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null
  }

  contains(element: SvgElement): boolean {
    return this === element || this.children.some((child) => child.contains(element))
  }
}

function text(label: string) {
  const element = new SvgElement('text')
  element.textContent = label
  return element
}

function stage(...elements: SvgElement[]) {
  return new SvgElement('svg', {}, elements) as unknown as Element
}

test('uses source metadata to distinguish duplicate labels without consulting fallback', () => {
  const first = new SvgElement('g', { 'data-source-line': '3' }, [text('Repeat')])
  const second = new SvgElement('g', { 'data-source-line': '4' }, [text('Repeat')])
  assert.deepEqual(findPreviewTargets(stage(first, second), 4, () => {
    assert.fail('Exact metadata should not need label matching')
  }), [second])
})

test('accounts for source lines before the diagram start', () => {
  const message = new SvgElement('g', { 'data-source-line': '4' })
  assert.deepEqual(findPreviewTargets(stage(message), 6, () => null, 2), [message])
})

test('favors participant heads while excluding the full lifeline and repeated tail', () => {
  const lifeline = new SvgElement('g', {
    'data-source-line': '2', class: 'participant-lifeline',
  })
  const head = new SvgElement('g', {
    'data-source-line': '2', class: 'participant participant-head',
  })
  const tail = new SvgElement('g', {
    'data-source-line': '2', class: 'participant participant-tail',
  })
  assert.deepEqual(findPreviewTargets(stage(lifeline, head, tail), 2, () => null), [head])
})

test('uses label ranges for elements without metadata, including multiline labels', () => {
  const first = text('First note line')
  const second = text('Second note line')
  const unrelated = text('Another note')
  assert.deepEqual(findPreviewTargets(stage(first, second, unrelated), 5, (label) => (
    label === 'Another note' ? { startLine: 8, endLine: 8 } : { startLine: 4, endLine: 5 }
  )), [first, second])
})

test('does not map fallback text from a different metadata line or a hidden definition', () => {
  const message = new SvgElement('g', { 'data-source-line': '3' }, [text('Repeat')])
  const definition = new SvgElement('defs', {}, [text('Repeat')])
  assert.deepEqual(findPreviewTargets(stage(message, definition), 4, () => ({
    startLine: 4, endLine: 4,
  })), [])
})

test('does not navigate for unsupported or blank source lines', () => {
  assert.deepEqual(findPreviewTargets(stage(text('Visible label')), 0, () => null), [])
})

test('ignores empty metadata and collapses nested targets', () => {
  const empty = new SvgElement('g', { 'data-source-line': '' })
  assert.deepEqual(findPreviewTargets(stage(empty), 0, () => null), [])
  const inner = new SvgElement('text', { 'data-source-line': '1' })
  const outer = new SvgElement('g', { 'data-source-line': '1' }, [inner])
  assert.deepEqual(findPreviewTargets(stage(outer), 1, () => null), [outer])
})
