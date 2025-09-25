# Ask Canvas

Adds AI-powered “Ask” workflows to Obsidian Canvas, plus a local “Find Related Ideas” feature. Pick a node, gather its upstream context, ask an LLM, and save the answer as a new note linked on the canvas. Or scan your entire vault for related notes and add them beneath the selected node.

Works on `.canvas` files in your vault. Requires an OpenAI-compatible API key.

## Features

- Ask with upstream context: Select a node, automatically gather predecessors up to a configurable hop limit (0–12, default 3), include the selected node’s content, and send a structured prompt to your model.
- Automatic note creation: Saves the LLM answer as a Markdown file in your chosen folder, then adds it as a child node below the selected node with an edge labeled by your question.
- Chain export: Export a chain of selected + upstream nodes and edges into a Markdown summary (includes content snippets).
- Quick access: Ribbon icon and status bar item (`Ask↑`) to trigger the Ask flow; status bar shows a spinner while running.
- Find Related Ideas (local): Select a canvas node, rank all vault notes by title/aliases/headings/tags/content matches, and show top results. Enter opens, Shift+Enter (or Shift+Click) adds as a child node on the canvas. No external API is used for this feature.

## Commands

- Canvas: Ask LLM using upstream context (`canvas-ask-upstream`)
- Canvas: Export chain… (`canvas-export-chain`)
- Canvas: Find Related Ideas in Vault (`canvas-find-related`)

Note: The separate “Open UI” command has been removed. Use the Ask command, ribbon icon, or the `Ask↑` status bar button.

## Settings

- Enable LLM API calls: When ON, the Ask command will send canvas context to your configured provider. OFF by default.
- OpenAI API key: Stored in vault plugin data.
- API Base URL: Defaults to `https://api.openai.com`.
- Model: e.g., `gpt-4o-mini`, `gpt-4.1`.
- Temperature: Sampling temperature for responses.
- Max tokens: Max tokens for completions.
- Context char limit per upstream node: Truncation limit per node when building context.
- Upstream hop limit: Slider (0–12) controlling how many predecessor hops to add to the selected node when assembling context.
- Output folder (optional): Relative to the vault root; blank writes alongside the canvas file.
- Related results to show: Slider to choose how many related matches to display (3–12, default 8).

Note: The previous “fork instead of replace” behavior has been removed. Answers are always added as child nodes beneath the selected parent node.

## Usage

1) Open a `.canvas` file and run one of:
- Click the ribbon icon.
- Click the `Ask↑` status bar item.
- Use the command palette: “Canvas: Ask LLM using upstream context”.

2) Pick the target node for your question.
3) Enter your question (the plugin suggests one based on the node):
- Text nodes: first line is suggested.
- File nodes: uses frontmatter `title`, first `# H1`, or filename.
- Link nodes: label or URL.
- Group nodes: group label.
4) The plugin gathers upstream context based on the hop limit slider (0–12) plus the selected node, calls your model, and saves the answer.
5) A new Markdown note is created and added as a child file node connected to the selected node with the question as the edge label.

### Find Related Ideas

1) Open a `.canvas` file.
2) Run the command palette: “Canvas: Find Related Ideas in Vault”.
3) Pick the target node. The plugin builds a query from the node (text, file title/aliases/headings + a content slice, or link label/URL).
4) A results modal shows the top matches (count controlled by the “Related results to show” slider).
   - Enter: open the note.
   - Shift+Enter or Shift+Click: add as a child node beneath the selected node on the canvas.
   - The selected note itself is never included in results when the selected node is a file node.

### Prompting Tips

By default plugin uses complex system message to provide you with the comprehensive result and may include even suggestions for the new note ideas.

``` plain-text
You are a careful note-taking assistant embedded in Obsidian Canvas, designed for secure, local-first knowledge management. Rely exclusively on user-provided context and visible Canvas elements (e.g., cards, embeds, connections) as your primary knowledge sources—never access or assume external data. Prioritize privacy and accuracy in all responses.

Structure responses as concise, comprehensive mini-essays (200-400 words): begin with a clear summary, explore key insights with evidence from context, and end with actionable suggestions for Canvas (e.g., new card ideas, links like [[Note Title]]). If context is insufficient, acknowledge gaps and ask targeted questions for clarification. Adapt format slightly for query type (e.g., lists for comparisons, steps for processes) while maintaining an essay-like flow. Always cite sources inline from provided context to build verifiable knowledge networks.
```

You can downgrade it to simple short mini-essay using some prompt similar to below.

``` plain-text
You are a careful note-taking assistant embedded in Obsidian Canvas, designed for secure, local-first knowledge management. Use user-provided context as a primary source of knowledge. Respond in a form of concise but comprehensive mini-essay format.
```

You can always change system prompt to suit the task.

## Export Chain

- Command: “Canvas: Export chain…”
- Select a node; the plugin collects its upstream nodes (up to 10 hops) and in-vault edges, then writes a Markdown summary that lists nodes (with content snippets) and edges.

## Development

- Node.js 16+ recommended.
- Install dependencies: `npm i`
- Dev build (watch): `npm run dev`
- The built `main.js`, `manifest.json`, and optional `styles.css` should be placed under `Vault/.obsidian/plugins/smart-canvas-plugin/` for manual install.

## Privacy

- The API key is stored in your vault’s plugin data.
- LLM calls are disabled by default; enable them in settings if desired.
- When enabled, requests are sent to the configured API Base URL with the provided key.
- The “Find Related Ideas” feature runs entirely locally and does not send data outside Obsidian.

## Changelog

- 0.0.5 — Configurable context hop limit
  - Added settings slider to choose how many predecessor hops (0–12) are included when building upstream context.
  - Context gathering now respects the selected hop limit instead of the fixed three-hop chain.
- 0.0.4 — PR polish and UI tweaks
  - Moved inline UI styles into CSS classes; improved suggestion list layout (title/score alignment, snippet ellipsis, hint styling) and consistent textarea sizing.
  - Status bar busy state handled via CSS class; cleaned up label spacing and titles.
  - Manifest cleanup to meet community guidelines (updated description; removed funding URL).
  - Minor type-safety adjustments in metadata access.
- 0.0.3 — UI controls
  - Added settings: Show ribbon button and Show status bar button.
  - Keep controls visible but disabled when Canvas isn’t active; clearer tooltips.
- 0.0.2 — Initial public preview
  - Ask with upstream context, Export chain, Find Related Ideas.
