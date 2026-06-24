import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const plantUmlJar = fileURLToPath(
  new URL('./plantuml-mit-1.2026.6.jar', import.meta.url),
)
const maxSourceBytes = 1_000_000
const maxOutputBytes = 12_000_000

type PlantUmlResult = {
  output: Buffer
  error?: string
}

type RenderFormat = 'svg' | 'png'

function renderPlantUml(
  source: string,
  format: RenderFormat,
): Promise<PlantUmlResult> {
  return new Promise((resolve, reject) => {
    if (!existsSync(plantUmlJar)) {
      reject(new Error(`PlantUML JAR was not found at ${plantUmlJar}`))
      return
    }

    const child = spawn(
      'java',
      [
        '-Djava.awt.headless=true',
        '-Dfile.encoding=UTF-8',
        '-Dsun.jnu.encoding=UTF-8',
        '-jar',
        plantUmlJar,
        '-pipe',
        format === 'png' ? '-tpng' : '-tsvg',
        '-charset',
        'UTF-8',
      ],
      { windowsHide: true },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false

    const finishWithError = (error: Error) => {
      if (settled) return
      settled = true
      child.kill()
      reject(error)
    }

    const timeout = setTimeout(() => {
      finishWithError(new Error('PlantUML rendering timed out after 15 seconds'))
    }, 15_000)

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        finishWithError(new Error('Rendered diagram is too large'))
        return
      }
      stdout.push(chunk)
    })

    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timeout)
      finishWithError(
        error.message.includes('ENOENT')
          ? new Error('Java was not found. Install Java 17 or newer and retry.')
          : error,
      )
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (settled) return
      settled = true

      const output = Buffer.concat(stdout)
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim()
      const svgStart = format === 'svg' ? output.indexOf('<svg') : -1
      const isPng =
        format === 'png' &&
        output.length >= 8 &&
        output.subarray(0, 8).equals(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        )
      if ((format === 'svg' && svgStart === -1) || (format === 'png' && !isPng)) {
        reject(
          new Error(
            errorOutput ||
              `PlantUML exited with code ${code ?? 'unknown'} without a ${format.toUpperCase()} image`,
          ),
        )
        return
      }

      const errorMessage = errorOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1)

      resolve({
        output: format === 'svg' ? output.subarray(svgStart) : output,
        error: code === 0 ? undefined : errorMessage || 'PlantUML syntax error',
      })
    })

    child.stdin.on('error', (error) => finishWithError(error))
    child.stdin.end(source, 'utf8')
  })
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let receivedBytes = 0

    request.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length
      if (receivedBytes > maxSourceBytes) {
        reject(new Error('PlantUML source is limited to 1 MB'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

async function renderHandler(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (request.method !== 'POST') {
    response.statusCode = 405
    response.setHeader('Allow', 'POST')
    response.end('Use POST with PlantUML source in the request body.')
    return
  }

  try {
    const source = await readBody(request)
    if (!source.trim()) {
      response.statusCode = 400
      response.end('PlantUML source cannot be empty.')
      return
    }

    const format: RenderFormat = request.headers.accept?.includes('image/png')
      ? 'png'
      : 'svg'
    const result = await renderPlantUml(source, format)
    response.statusCode = 200
    response.setHeader(
      'Content-Type',
      format === 'png' ? 'image/png' : 'image/svg+xml; charset=utf-8',
    )
    response.setHeader('Cache-Control', 'no-store')
    if (result.error) {
      response.setHeader('X-PlantUML-Error', encodeURIComponent(result.error))
    }
    response.end(result.output)
  } catch (error) {
    response.statusCode = 500
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.end(
      error instanceof Error ? error.message : 'Unable to render PlantUML',
    )
  }
}

export function plantUmlPlugin(): Plugin {
  return {
    name: 'local-plantuml-renderer',
    configureServer(server) {
      server.middlewares.use('/api/render', renderHandler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/render', renderHandler)
    },
  }
}
