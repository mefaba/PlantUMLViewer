# PlantUML Viewer

A local PlantUML editor with automatic SVG preview. Diagram source is rendered by the bundled `plantuml-mit-1.2026.6.jar`; it is not sent to an external rendering service.

## Run locally

Java 17 or newer and pnpm are required.

```sh
pnpm install
pnpm dev
```

Paste PlantUML into the editor and the preview updates automatically. Use `Ctrl+Enter` (or `Cmd+Enter`) to render immediately. The generated diagram can be downloaded as SVG or PNG.

The current PlantUML source is saved in browser storage and restored after a page refresh.

Inside the preview, use the mouse wheel for smooth cursor-centered zoom from 10% to 2000%, and drag the diagram to pan. The source panel can be collapsed to give the preview the full workspace width.

For a production build and local preview:

```sh
pnpm build
pnpm preview
```

## Run with Docker

```sh
docker compose up --build
```
