# PlantUML Viewer

A local PlantUML editor with automatic SVG preview. Diagram source is rendered by the bundled `plantuml-mit-1.2026.6.jar`; it is not sent to an external rendering service.

## Features

- Local PlantUML rendering through the bundled PlantUML CLI JAR.
- Automatic SVG preview while editing.
- SVG and PNG downloads.
- Persistent browser-local source storage.
- Source panel resizing/collapse, diagram pan, and cursor-centered zoom.
- Preview-to-source navigation for many rendered labels.
- Source-to-preview navigation: click a source line or move the caret with the keyboard to highlight and reveal its diagram element.

## Requirements

- Node.js 24 or newer
- pnpm 11 or newer
- Java 17 or newer

## Run locally

```sh
pnpm install
pnpm dev
```

Paste PlantUML into the editor and the preview updates automatically. Use `Ctrl+Enter` (or `Cmd+Enter`) to render immediately. The generated diagram can be downloaded as SVG or PNG.

The current PlantUML source is saved in browser storage and restored after a page refresh.

Inside the preview, use the mouse wheel for smooth cursor-centered zoom from 10% to 2000%, and drag the diagram to pan. The source panel can be collapsed to give the preview the full workspace width.

Click a source line, or move the caret to it with the keyboard, to highlight the corresponding element in the preview. Elements outside the visible area are brought into view without changing the zoom or moving focus out of the editor. Participants and messages use PlantUML's source-line metadata; other rendered labels use text matching. Blank lines, comments, and layout settings have no preview target. Navigation waits for a successful preview of the current source after edits.

For a production build and local preview:

```sh
pnpm build
pnpm preview
```

## Run with Docker

```sh
docker compose up --build
```

The Docker image installs Java, Graphviz, and CJK fonts for PlantUML rendering.

## Public Release Notes

- `plantuml-mit-1.2026.6.jar` is intentionally checked in so the app can render locally without calling a public PlantUML server.
- The repository is marked `"private": true` in `package.json` to prevent accidental npm publication. This does not prevent publishing the code on GitHub.
- Released under the MIT License.
