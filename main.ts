import {
  App, Notice, Plugin, PluginSettingTab, Setting, TFile, FuzzySuggestModal, Modal, normalizePath,
  FuzzyMatch, requestUrl, RequestUrlResponse
} from "obsidian";

/** ---------- JSON Canvas Types ---------- */
type CanvasSide = "top" | "right" | "bottom" | "left";
type CanvasNodeType = "text" | "file" | "link" | "group";

interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: unknown;   // Canvas may store text as string or object ({text|content|source})
  file?: unknown;   // Canvas may store file ref as string or object ({path})
  url?: unknown;    // Canvas may store url as string or object
  label?: unknown;  // Canvas may store label as string or object
  color?: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  label?: string;
}

interface CanvasData { nodes: CanvasNode[]; edges: CanvasEdge[]; }

/** ---------- Settings ---------- */
interface CanvasAskSettings {
  openAIKey: string;
  openAIBaseURL: string;     // e.g. https://api.openai.com
  openAIModel: string;       // e.g. gpt-4o-mini / gpt-4.1 / etc.
  temperature: number;
  maxTokens: number;
  contextCharLimitPerNode: number;
  outputFolder: string;      // where to create the answer .md (relative to vault root)
  // When false (default), the plugin will not call the LLM API
  // or send any canvas content to an external service.
  allowApiCalls: boolean;
  // Number of related matches to show (3..12)
  topRelatedResults: number;
  // Customizable system message for API calls
  systemPrompt: string;
  // UI toggles
  showRibbonButton: boolean;
  showStatusBarButton: boolean;
}

const DEFAULT_SYSTEM_PROMPT = `You are a careful note-taking assistant embedded in Obsidian Canvas, designed for secure, local-first knowledge management. Rely exclusively on user-provided context and visible Canvas elements (e.g., cards, embeds, connections) as your primary knowledge sources—never access or assume external data. Prioritize privacy and accuracy in all responses.

Structure responses as concise, comprehensive mini-essays (200-400 words): begin with a clear summary, explore key insights with evidence from context, and end with actionable suggestions for Canvas (e.g., new card ideas, links like [[Note Title]]). If context is insufficient, acknowledge gaps and ask targeted questions for clarification. Adapt format slightly for query type (e.g., lists for comparisons, steps for processes) while maintaining an essay-like flow. Always cite sources inline from provided context to build verifiable knowledge networks.
`;

const DEFAULTS: CanvasAskSettings = {
  openAIKey: "",
  openAIBaseURL: "https://api.openai.com",
  openAIModel: "gpt-4o-mini",
  temperature: 0.2,
  maxTokens: 1200,
  contextCharLimitPerNode: 2000,
  outputFolder: "Ask Canvas", 
  allowApiCalls: false,
  topRelatedResults: 8,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  showRibbonButton: true,
  showStatusBarButton: true,
};

/** ---------- Utils ---------- */
function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 0xf) >> 0;
    const v = c === "x" ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

function firstLine(s: string | undefined): string {
  if (!s) return "";
  const line = s.split(/\r?\n/)[0]?.trim() ?? "";
  return line.length ? line : s.trim();
}

// Windows reserved device names (case-insensitive)
const WINDOWS_RESERVED_BASENAMES = new Set<string>([
  'con','prn','aux','nul',
  'com1','com2','com3','com4','com5','com6','com7','com8','com9',
  'lpt1','lpt2','lpt3','lpt4','lpt5','lpt6','lpt7','lpt8','lpt9'
]);

function sanitizeFilename(s: string): string {
  // Conservative: strip/replace unsafe chars but keep interior spaces for readability
  let out = (s ?? "").toString().trim();
  out = out.replace(/[\\/#%&{}<>*?$!'":@+`|=]/g, "_");
  // Strip trailing dots/spaces (Windows disallows)
  out = out.replace(/[.\s]+$/g, "");
  if (!out) return "untitled";

  // Guard Windows reserved basenames (reserved even with extensions)
  const stem = out.split(".")[0]?.toLowerCase() || "";
  if (WINDOWS_RESERVED_BASENAMES.has(stem)) out = `_${out}`;

  // Limit length
  out = out.slice(0, 180);
  // Ensure we didn't end on a trailing dot/space after slicing
  out = out.replace(/[.\s]+$/g, "");
  return out || "untitled";
}

// Truncate a string to a maximum number of words; append ellipsis if truncated
function truncateWords(input: string | undefined | null, maxWords: number): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  const words = s.split(/\s+/);
  if (words.length <= maxWords) return s;
  return words.slice(0, maxWords).join(" ") + "…";
}

// Default limit for canvas node/edge labels (aims to match Obsidian canvas feel)
const DEFAULT_LABEL_WORDS = 12;

// Lightweight debounce utility for batching saves
type Debounced<T extends (...args: unknown[]) => unknown> = ((...args: Parameters<T>) => void) & { cancel: () => void };
function debounce<T extends (...args: unknown[]) => unknown>(fn: T, wait = 300): Debounced<T> {
  let t: number | null = null;
  const wrapped = ((...args: Parameters<T>) => {
    if (t != null) window.clearTimeout(t);
    t = window.setTimeout(() => {
      t = null;
      // eslint-disable-next-line @typescript-eslint/ban-types
      (fn as Function)(...args as unknown[]);
    }, wait);
  }) as Debounced<T>;
  wrapped.cancel = () => { if (t != null) { window.clearTimeout(t); t = null; } };
  return wrapped;
}

// Simple sleep helper used for retry backoff
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

// Sanitize text for logging/errors: collapse whitespace and truncate
function sanitizeForLog(input: unknown, max = 300): string {
  const s = String((input as unknown) ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Hoisted stop-words set (avoid recreating per call)
const STOP_WORDS = new Set<string>([
  "the","a","an","and","or","but","if","then","else","when","at","by","for","from","in","into","of","on","to","with","without","is","are","was","were","be","been","being","as","it","this","that","these","those","we","you","they","i","me","my","our","your","their","can","could","should","would","may","might","will","just","about","so","do","does","did","not","no","yes"
]);

// Escape a string for safe use in RegExp
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Determine a reasonable concurrency based on hardware
function getConcurrency(preferred: number): number {
  const hc = (typeof navigator !== 'undefined')
    ? Number((navigator as unknown as { hardwareConcurrency?: number }).hardwareConcurrency ?? NaN)
    : NaN;
  if (Number.isFinite(hc) && hc > 0) {
    // Cap within [2, 2x cores] and not above preferred
    return Math.max(2, Math.min(preferred, Math.max(2, Math.min(2 * hc, 16))));
  }
  return preferred;
}

// Run async tasks with a concurrency limit while preserving order
async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit = 6): Promise<T[]> {
  const results: T[] = new Array(tasks.length) as T[];
  let next = 0;
  const workers: Promise<void>[] = [];
  const run = async () => {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]();
    }
  };
  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  for (let i = 0; i < workerCount; i++) workers.push(run());
  await Promise.all(workers);
  return results;
}

/*
  New helpers: Canvas node fields can be strings or objects depending on Canvas versions.
  These helpers normalize common shapes so labels don't end up as "undefined".
*/
function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null; }
function extractTextField(t: unknown): string {
  if (!t) return "";
  if (typeof t === "string") return t;
  if (isRecord(t)) {
    // common possibilities
    const cand = (t as { text?: unknown; content?: unknown; source?: unknown });
    return String(cand.text ?? cand.content ?? cand.source ?? "");
  }
  return "";
}

// Canvas may store file refs as string or as an object { path }
function resolveFilePath(f: unknown): string {
  if (!f) return "";
  if (typeof f === 'string') return f;
  if (isRecord(f)) {
    const cand = f as { path?: unknown; file?: unknown };
    const p = (typeof cand.path === 'string' ? cand.path : undefined) ?? (typeof cand.file === 'string' ? cand.file : undefined);
    return typeof p === 'string' ? p : "";
  }
  return "";
}

function getNodeLabel(n: CanvasNode): string {
  const nodeLabel = n?.label;

  if (n?.type === "text") {
    const raw = extractTextField(n?.text);
    const fl = firstLine(raw);
    return fl || nodeLabel || "(text card)";
  }

  if (n?.type === "file") {
    const fileRef = resolveFilePath(n?.file);
    const fname = fileRef || nodeLabel || "(file)";
    return `📄 ${fname}`.trim();
  }

  if (n?.type === "link") {
    const urlRef = typeof n?.url === "string" ? n.url : extractTextField(n?.url);
    const composed = `🔗 ${urlRef}${nodeLabel ? " — " + nodeLabel : ""}`.trim();
    return composed || "(link)";
  }

  if (n?.type === "group") {
    return `🗂 ${nodeLabel || "(group)"}`;
  }

  return nodeLabel || extractTextField(n?.text) || "(untitled)";
}

/** ---------- Main Plugin ---------- */
export default class CanvasAskPlugin extends Plugin {
  settings: CanvasAskSettings;
  private statusBarEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private isBusy: boolean = false;
  private askAbortController: AbortController | null = null;
  private saveSettingsDebounced!: ReturnType<typeof debounce>;

  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    // Debounced saver to avoid writing on every keystroke
    this.saveSettingsDebounced = debounce(() => { this.saveData(this.settings); }, 350);

    this.addCommand({
      id: "canvas-ask-upstream",
      name: "Active Canvas Query",
      callback: () => this.askWithUpstreamContext(),
    });

    // Conditionally build UI per settings
    this.buildUiFromSettings();

    // Removed: command to open a simple UI modal (no longer needed)

    this.addCommand({
      id: "canvas-export-chain",
      name: "Export Chain",
      callback: async () => this.exportChain(),
    });

    this.addSettingTab(new CanvasAskSettingsTab(this.app, this));

    // Find related ideas: pick a node, search vault, show matches
    this.addCommand({
      id: "canvas-find-related",
      name: "Find Related Ideas in Vault",
      callback: () => this.findRelatedIdeas(),
    });

    // Reflect Canvas availability in UI on view changes
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateUiEnabledState()));
    // Initial state
    this.updateUiEnabledState();
  }

  /** Queue a debounced settings save */
  scheduleSaveSettings() {
    this.saveSettingsDebounced();
  }

  /** Find related notes in the vault for a selected node */
  private async findRelatedIdeas() {
    const canvasFile = this.app.workspace.getActiveFile();
    if (!canvasFile || canvasFile.extension !== "canvas") {
      new Notice("Open a .canvas file first.");
      return;
    }

    const data = await this.readCanvas(canvasFile);
    if (data.nodes.length === 0) {
      new Notice("Canvas is empty.");
      return;
    }

    const selected = await this.pickNode(data, canvasFile.path);
    if (!selected) return;

    const queryText = await this.getSearchTextFromNode(selected);
    if (!queryText || !queryText.trim()) {
      new Notice("No searchable text on the selected node.");
      return;
    }

    const tokens = this.tokenizeQuery(queryText);
    if (tokens.size === 0) {
      new Notice("Not enough signal in selection to search.");
      return;
    }

    // Stage 1: metadata-only scoring to shortlist candidates
    const markdownFiles = this.app.vault.getMarkdownFiles();
    const metaRanked = this.rankByMetadata(markdownFiles, tokens);
    const shortlist = metaRanked.slice(0, 100).map(r => r.file);

    // Stage 2: content scoring on shortlist (async, limited concurrency)
    const scored = await this.rankByContent(shortlist, tokens, 3000);
    // Merge meta + content scores
    const merged = new Map<string, { file: TFile; score: number; snippet?: string }>();
    for (const r of metaRanked) merged.set(r.file.path, { file: r.file, score: r.score });
    for (const r of scored) {
      const m = merged.get(r.file.path) || { file: r.file, score: 0 };
      m.score += r.score;
      if (r.snippet && !m.snippet) m.snippet = r.snippet;
      merged.set(r.file.path, m);
    }
    // Exclude the canvas itself and (if applicable) the selected file-node itself
    const selectedFilePath = (selected.type === "file")
      ? normalizePath(resolveFilePath(selected.file))
      : "";
    const toShow = Math.max(3, Math.min(12, this.settings.topRelatedResults || DEFAULTS.topRelatedResults));
    const finalList = Array.from(merged.values())
      .filter(r => r.score > 0 && r.file.path !== canvasFile.path && r.file.path !== selectedFilePath)
      .sort((a, b) => b.score - a.score)
      .slice(0, toShow);

    if (finalList.length === 0) {
      new Notice("No related notes found.");
      return;
    }

    type Item = { file: TFile; label: string; score: number; snippet?: string };
    const items: Item[] = finalList.map(r => ({
      file: r.file,
      score: r.score,
      snippet: r.snippet,
      label: `${r.file.basename}  ·  ${r.file.path}`,
    }));

    const plugin = this;
    const node = selected;
    class RelatedModal extends FuzzySuggestModal<Item> {
      constructor(app: App, public readonly queryPreview: string) { super(app); }
      getItems(): Item[] { return items; }
      getItemText(it: Item): string { return `${it.label}`; }
      onOpen(): void {
        super.onOpen();
        // Ensure Shift+Enter also triggers selection and marks it as an "add to canvas" action
        this.scope.register(["Shift"], "Enter", (ev) => {
          try {
            type ChooserEntry<T> = { item?: T };
            type WithChooser<T> = { chooser?: { selectedItem?: number; values?: Array<ChooserEntry<T>> } };
            const chooser = (this as unknown as WithChooser<Item>).chooser;
            const idx: number | undefined = chooser?.selectedItem;
            const arr = chooser?.values ?? [];
            const entry = (typeof idx === 'number' && idx >= 0) ? arr[idx] : undefined;
            const item: Item | undefined = entry?.item;
            if (!item) return;
            // Call the same handler with a synthetic KeyboardEvent carrying shiftKey=true
            const fakeEvt = new KeyboardEvent('keydown', { shiftKey: true });
            this.onChooseItem(item, fakeEvt);
          } catch (e) {
            console.error('Shift+Enter handler failed', e);
          }
        });
      }
      renderSuggestion(match: FuzzyMatch<Item>, el: HTMLElement) {
        const top = el.createEl("div", { cls: "ask-canvas-suggestion-top" });
        const left = top.createEl("div", { text: match.item.file.basename, cls: "ask-canvas-suggestion-left" });
        const right = top.createEl("div", { text: String(match.item.score), cls: "ask-canvas-suggestion-right" });
        el.createEl("div", { text: match.item.file.path, cls: "mod-muted" });
        if (match.item.snippet) {
          el.createEl("div", { text: match.item.snippet.trim(), cls: "ask-canvas-suggestion-snippet" });
        }
        el.createEl("div", { text: "Enter: open • Shift+Enter or Shift+Click: add to canvas", cls: "mod-muted ask-canvas-suggestion-hint" });
      }
      async onChooseItem(it: Item, evt?: MouseEvent | KeyboardEvent) {
        const shift = !!(evt && (evt as KeyboardEvent).shiftKey);
        // Guard: never allow adding the same note as the selected file-node
        if (selectedFilePath && it.file.path === selectedFilePath) {
          new Notice("Skipping: the selected note itself.");
          return;
        }

        if (shift) {
          try {
            // Add as child file node beneath the selected canvas node
            const canvas = plugin.app.workspace.getActiveFile();
            if (!canvas || canvas.extension !== "canvas") {
              // Fallback: just open if not on a canvas for any reason
              const leaf = plugin.app.workspace.getLeaf(false);
              await leaf.openFile(it.file);
              return;
            }
            const d = await plugin.readCanvas(canvas);
            const updated = plugin.applyResultAsChild(d, node, it.file.path, `Related: ${node.label ?? plugin.firstLineForNode(node)}`);
            await plugin.writeCanvas(canvas, updated);
            new Notice(`Added related → ${it.file.path}`);
          } catch (e) {
            console.error(e);
            new Notice("Failed to add note to canvas. See console for details.");
          }
        } else {
          // Open note
          const leaf = plugin.app.workspace.getLeaf(false);
          await leaf.openFile(it.file);
        }
      }
    }

    const preview = this.truncateWordsSafe(queryText, 16);
    const modal = new RelatedModal(this.app, preview);
    modal.setPlaceholder(`Related to: ${preview}`);
    modal.open();
  }

  private firstLineForNode(n: CanvasNode): string {
    if (n.type === "text") return firstLine(extractTextField(n.text));
    if (n.type === "file") return resolveFilePath(n.file);
    return getNodeLabel(n);
  }

  private truncateWordsSafe(s: string, maxWords: number): string {
    return truncateWords(s, maxWords) || s.split(/\s+/).slice(0, maxWords).join(" ") || s;
  }

  private async getSearchTextFromNode(n: CanvasNode): Promise<string> {
    if (n.type === "text") return extractTextField(n.text) ?? "";
    if (n.type === "file" && n.file) {
      const path = resolveFilePath(n.file);
      const af = this.app.vault.getAbstractFileByPath(path);
      if (af instanceof TFile) {
        try {
          // Prefer cached title/aliases/headings first
          // @ts-ignore metadataCache exists on App
          const cache = this.app.metadataCache.getFileCache(af);
          const parts: string[] = [];
          const fmTitle = (cache?.frontmatter as Record<string, unknown> | undefined)?.title as string | undefined;
          if (typeof fmTitle === 'string') parts.push(fmTitle);
          const aliases = (cache?.frontmatter as Record<string, unknown> | undefined)?.aliases as unknown;
          if (Array.isArray(aliases)) parts.push(...aliases.map(String));
          const headings = Array.isArray(cache?.headings)
            ? (cache!.headings as unknown[]).map(h => {
                const hh = (h as { heading?: unknown })?.heading;
                return String(hh ?? '');
              })
            : [];
          parts.push(...headings);
          // Fallback: read first portion of content
          const content = await this.app.vault.read(af);
          parts.push(content.slice(0, 2000));
          return parts.join("\n");
        } catch { /* ignore */ }
      }
      return path;
    }
    if (n.type === "link") {
      const urlRef = typeof n.url === 'string' ? n.url : extractTextField(n.url);
      return [n.label ?? "", urlRef ?? ""].filter(Boolean).join("\n");
    }
    if (n.type === "group") return String(n.label ?? "");
    return getNodeLabel(n);
  }

  private tokenizeQuery(text: string): Set<string> {
    const tokens = new Set<string>();
    for (const raw of text.toLowerCase().split(/[^a-z0-9#+]+/)) {
      const t = raw.trim();
      if (!t) continue;
      if (STOP_WORDS.has(t)) continue;
      if (t.length < 3 && !t.startsWith('#')) continue; // allow short tags like #ai
      tokens.add(t);
    }
    return tokens;
  }

  private rankByMetadata(files: TFile[], tokens: Set<string>): Array<{ file: TFile; score: number }> {
    const res: Array<{ file: TFile; score: number }> = [];
    for (const f of files) {
      // @ts-ignore metadataCache exists on App
      const cache = this.app.metadataCache.getFileCache(f) || {};
      let score = 0;
      const fm = cache.frontmatter as Record<string, unknown> | undefined;
      const title = (fm?.title as string) || f.basename || f.name.replace(/\.[^/.]+$/, "");
      const headings: string[] = Array.isArray(cache.headings)
        ? (cache.headings as unknown[]).map(h => String((h as { heading?: unknown })?.heading ?? ''))
        : [];
      const aliasesSrc = fm?.aliases as unknown;
      const aliases: string[] = Array.isArray(aliasesSrc) ? aliasesSrc.map(String) : [];

      const tagList: string[] = [];
      if (Array.isArray(cache.tags)) {
        for (const t of cache.tags) {
          if (t?.tag) tagList.push(String(t.tag).replace(/^#/, '').toLowerCase());
        }
      }
      const fmTags = fm?.tags as unknown;
      if (typeof fmTags === 'string') tagList.push(...fmTags.split(/[,\s]+/).map((x: string) => x.replace(/^#/, '').toLowerCase()));
      else if (Array.isArray(fmTags)) tagList.push(...fmTags.map((x: unknown) => String(x).replace(/^#/, '').toLowerCase()));

      const hayTitle = title.toLowerCase();
      for (const tok of tokens) {
        if (hayTitle.includes(tok)) score += 5;
      }
      for (const h of headings) {
        const low = h.toLowerCase();
        for (const tok of tokens) if (low.includes(tok)) score += 3;
      }
      for (const a of aliases) {
        const low = a.toLowerCase();
        for (const tok of tokens) if (low.includes(tok)) score += 3;
      }
      for (const tag of tagList) {
        if (tokens.has(tag)) score += 4;
      }

      if (score > 0) res.push({ file: f, score });
    }
    res.sort((a, b) => b.score - a.score);
    return res;
  }

  private async rankByContent(files: TFile[], tokens: Set<string>, maxChars = 3000): Promise<Array<{ file: TFile; score: number; snippet?: string }>> {
    // Precompute token regex pattern sources once per search (avoid repeated escaping)
    const tokenInfos = Array.from(tokens).map(tok => ({
      tok,
      src: `(^|[^A-Za-z0-9_])(${escapeRegex(tok)})(?=$|[^A-Za-z0-9_])`
    }));

    const tasks = files.map((f) => async () => {
      try {
        const raw = await this.app.vault.read(f);
        const s = raw.slice(0, maxChars);
        let score = 0;
        let snippet: string | undefined;
        for (const info of tokenInfos) {
          const rx = new RegExp(info.src, 'gi');
          rx.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = rx.exec(s)) != null) {
            score += 1;
            if (!snippet) {
              const idx = Math.max(0, rx.lastIndex - info.tok.length);
              const start = Math.max(0, idx - 60);
              const end = Math.min(s.length, idx + 60);
              const chunk = s.slice(start, end).replace(/\s+/g, ' ').trim();
              snippet = chunk.length > 0 ? chunk : undefined;
            }
          }
        }
        return { file: f, score, snippet };
      } catch {
        return { file: f, score: 0 };
      }
    });
    const results = await runWithConcurrency(tasks, getConcurrency(10));
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /** Core flow */
  async askWithUpstreamContext() {
    if (this.isBusy) {
      // Triggering another run cancels the current one
      this.cancelAsk("Canceled by user");
      new Notice("Canceled current Ask.");
      return;
    }
    const canvasFile = this.app.workspace.getActiveFile();
    if (!canvasFile || canvasFile.extension !== "canvas") {
      new Notice("Open a .canvas file first.");
      return;
    }

    // Respect privacy: do not call API or prepare context unless explicitly enabled
    if (!this.settings.allowApiCalls) {
      new Notice("LLM API calls are disabled. Enable in settings to send canvas context to the model.");
      return;
    }

    const data = await this.readCanvas(canvasFile);
    if (data.nodes.length === 0) {
      new Notice("Canvas is empty.");
      return;
    }

    // 1) Pick the root node for context gathering
    const root = await this.pickNode(data, canvasFile.path);
    if (!root) return;

    // 2) Prompt the user for a question (prefill from node, if possible)
    const suggested = await this.getQuestionFromNode(root);
    const question = await this.promptForQuestion(suggested ?? "");
    if (!question) {
      new Notice("No question provided.");
      return;
    }

    // 3) Collect upstream (multi-hop) context from the chosen root
    const upstreamInfo = this.collectPredecessorsUpToDepth(data, root.id, 3);
    const upstream = upstreamInfo.nodes;

    // Include the selected node itself (so a selected text card's content is part of the context)
    const nodesForContext: CanvasNode[] = [root, ...upstream];

    const context = await this.materializeContext(nodesForContext);

    // 4) Call OpenAI
    if (!this.settings.openAIKey) {
      new Notice("Set your OpenAI API key in settings.");
      return;
    }

    let answer: string | undefined;
    // Create an abort controller for this run
    this.askAbortController?.abort();
    this.askAbortController = new AbortController();
    this.setBusy(true);
    try {
      answer = await this.callOpenAI(question, context, this.askAbortController.signal);
    } catch (err) {
          if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError') {
            // Swallow aborts as cancelations
            console.warn('Ask canceled');
            new Notice("Ask canceled.");
          } else {
            console.error(err);
        new Notice("OpenAI request failed. See console for details.");
      }
    } finally {
      this.setBusy(false);
      this.askAbortController = null;
    }
    if (answer == null) return;

    // 5) Create the note and add it as a CHILD of the selected node
    const outFolder = this.settings.outputFolder || (canvasFile.parent?.path ?? "");
    // Use the generated note's H1 as filename if present; fallback to the question
    const h1 = answer.match(/^\s*#\s+(.+?)\s*$/m)?.[1] ?? firstLine(question);
    const filename = sanitizeFilename(h1) + ".md";
    const targetPath = normalizePath((outFolder ? outFolder + "/" : "") + filename);
    const body =
`${answer}

---

### Sources (selected + upstream)
${context.sourcesMarkdown}
`;
    const outFile = await this.createOrOverwrite(targetPath, body);

    // Update canvas by adding a child file node connected from the root
    const updated = this.applyResultAsChild(data, root, outFile.path, question);
    await this.writeCanvas(canvasFile, updated);
    new Notice(`Answer saved → ${outFile.path} • Added as CHILD (downstream) of the selected node.`);
  }

  onunload() {
    // Abort any in-flight request on unload
    this.cancelAsk("Plugin unloaded");
  }

  /** Toggle busy state and update status bar UI */
  private setBusy(busy: boolean) {
    this.isBusy = busy;
    const el = this.statusBarEl;
    if (!el) { this.updateUiEnabledState(); return; }

    // Reset content
    el.empty();

    if (busy) {
      // Label + spinner
      const label = el.createEl("span", { text: "Ask↑", cls: "ask-canvas-status-label" });
      const spinner = el.createEl("span");
      spinner.classList.add("ask-canvas-spinner");
      el.setAttribute("aria-busy", "true");
      el.classList.add("ask-canvas-busy");
      el.setAttribute("title", "Ask Canvas: Asking…");
    } else {
      el.setText("Ask↑");
      el.setAttribute("title", "Ask Canvas: Ask (Upstream Context)");
      el.classList.remove("ask-canvas-busy");
      el.removeAttribute("aria-busy");
    }

    // Ensure disabled/enabled styling remains accurate
    this.updateUiEnabledState();
  }

  /** Whether a Canvas file is the active file */
  private isCanvasActive(): boolean {
    const f = this.app.workspace.getActiveFile();
    return !!f && f.extension === "canvas";
  }

  /** Dim and disable UI when Canvas isn't active (keep visible for discovery) */
  private updateUiEnabledState() {
    const enabled = this.isCanvasActive();

    if (this.ribbonEl) {
      this.ribbonEl.classList.toggle("smart-canvas-disabled", !enabled);
      this.ribbonEl.setAttribute("aria-disabled", (!enabled).toString());
      if (!enabled) {
        this.ribbonEl.setAttribute("title", "Open a Canvas to use");
      } else {
        // Default tooltip when enabled
        this.ribbonEl.setAttribute("title", "Active Canvas Query");
      }
    }

    if (this.statusBarEl) {
      this.statusBarEl.classList.toggle("smart-canvas-disabled", !enabled);
      this.statusBarEl.setAttribute("aria-disabled", (!enabled).toString());
      if (!enabled) {
        this.statusBarEl.setAttribute("title", "Open a Canvas to use");
      } else if (!this.isBusy) {
        // Reset to default tooltip when enabled and idle
        this.statusBarEl.setAttribute("title", "Ask Canvas: Ask (Upstream Context)");
      }
    }
  }

  /** Create/remove ribbon and status bar elements based on settings */
  buildUiFromSettings() {
    // Ribbon
    if (this.settings.showRibbonButton) {
      if (!this.ribbonEl) {
        this.ribbonEl = this.addRibbonIcon("message-square", "Active Canvas Query", () => {
          if (this.isBusy) { this.cancelAsk("Canceled by user"); return; }
          this.askWithUpstreamContext();
        });
      }
    } else if (this.ribbonEl) {
      // Remove ribbon element if present
      // @ts-ignore obsidian extends Element with detach
      this.ribbonEl.detach?.();
      this.ribbonEl = null;
    }

    // Status bar
    if (this.settings.showStatusBarButton) {
      if (!this.statusBarEl) {
        const statusEl = (this.statusBarEl = this.addStatusBarItem());
        statusEl.setText("Ask↑");
        statusEl.setAttribute("title", "Active Canvas Query");
        // Register with plugin for auto-cleanup on unload
        this.registerDomEvent(statusEl, "click", () => {
          if (this.isBusy) { this.cancelAsk("Canceled by user"); return; }
          this.askWithUpstreamContext();
        });
      }
    } else if (this.statusBarEl) {
      // @ts-ignore obsidian extends Element with detach
      this.statusBarEl.detach?.();
      this.statusBarEl = null;
    }

    // After creating/removing, ensure enabled state is reflected
    this.updateUiEnabledState();
  }

  /** Canvas I/O */
  private async readCanvas(file: TFile): Promise<CanvasData> {
    const raw = await this.app.vault.read(file);
    const d = JSON.parse(raw) as CanvasData;
    d.nodes ||= []; d.edges ||= [];
    return d;
  }
  private async writeCanvas(file: TFile, data: CanvasData) {
    // Minified write for performance and smaller file size
    await this.app.vault.modify(file, JSON.stringify(data));
  }

  /** Node picker */
  private pickNode(data: CanvasData, canvasPath: string): Promise<CanvasNode | null> {
    return new Promise(resolve => {
      // Prepare choices with label and node
      const choices = data.nodes.map(n => ({
        label: getNodeLabel(n),
        node: n,
      }));
      let resolved = false;

      class NodeModal extends FuzzySuggestModal<{ label: string; node: CanvasNode }> {
        constructor(app: App) { super(app); }

        getItems(): { label: string; node: CanvasNode }[] {
          return choices;
        }
        getItemText(item: { label: string; node: CanvasNode }): string {
          return item.label;
        }
        renderSuggestion(item: FuzzyMatch<{ label: string; node: CanvasNode }>, el: HTMLElement) {
          el.createEl("div", { text: item.item.label });
        }
        onChooseItem(item: { label: string; node: CanvasNode }, evt?: MouseEvent | KeyboardEvent) {
          if (!resolved) {
            resolved = true;
            resolve(item.node ?? null);
          }
        }
      }

      const modal = new NodeModal(this.app);
      modal.setPlaceholder("Select target node (question)…");
      modal.open();
    });
  }

  /** Ask the user to type a question in a modal (prefilled with a suggestion). */
  private promptForQuestion(suggested: string): Promise<string | null> {
    return new Promise(resolve => {
      let resolved = false;

      class QuestionModal extends Modal {
        private value: string;
        constructor(app: App, initial: string) {
          super(app);
          this.value = initial ?? "";
        }
        onOpen(): void {
          const { contentEl } = this;
          contentEl.empty();
          contentEl.createEl("h2", { text: "Ask a question" });

          const textarea = contentEl.createEl("textarea", { cls: "ask-canvas-question-textarea" });
          // Open with an empty value; show suggestion as placeholder
          textarea.value = "";
          if (this.value) textarea.placeholder = this.value;

          const btnRow = contentEl.createEl("div", { cls: "ask-canvas-btn-row" });

          const askBtn = btnRow.createEl("button", { text: "Ask" });
          // Make Ask button primary for visual distinction
          askBtn.classList.add("mod-cta");
          const cancelBtn = btnRow.createEl("button", { text: "Cancel", cls: "ask-canvas-btn-cancel" });

          askBtn.addEventListener("click", () => {
            const q = textarea.value.trim();
            if (!resolved) {
              resolved = true;
              this.close();
              resolve(q || null);
            }
          });
          cancelBtn.addEventListener("click", () => {
            if (!resolved) {
              resolved = true;
              this.close();
              resolve(null);
            }
          });

          textarea.addEventListener("keydown", (ev: KeyboardEvent) => {
            // Default: Enter submits, Shift+Enter inserts newline
            if (ev.key === "Enter" && !ev.isComposing) {
              if (ev.shiftKey) return; // allow newline
              ev.preventDefault();
              askBtn.click();
            }
          });
        }
        onClose(): void {
          this.contentEl.empty();
        }
      }

      const modal = new QuestionModal(this.app, suggested);
      modal.open();
    });
  }

  /** Extract question from a node */
  private async getQuestionFromNode(n: CanvasNode): Promise<string | null> {
    if (n.type === "text") {
          const q = firstLine(extractTextField(n.text));
      return q || null;
    }
    if (n.type === "file" && n.file) {
      return await readFrontTitleOrH1(this.app, resolveFilePath(n.file));
    }
    if (n.type === "link") {
      return n.label ?? n.url ?? null;
    }
    if (n.type === "group") {
      return n.label ?? null;
    }
    return null;
  }

  

  /**
   * Follow a single upstream chain via top connections.
   * Starts at `targetId`, then repeatedly finds an incoming edge with `toSide === "top"`,
   * steps to its `fromNode`, and continues until there is no such top edge or `maxDepth` is reached.
   * This models a vertical chain where upstream nodes connect into the top of the downstream node.
   */
  private collectPredecessorsUpToDepth(
    data: CanvasData,
    targetId: string,
    maxDepth: number = 3
  ): { nodes: CanvasNode[]; depthById: Record<string, number> } {
    const nodeById = new Map<string, CanvasNode>();
    for (const n of data.nodes) nodeById.set(n.id, n);

    // Build an incoming-edge index keyed by toNode for O(1) lookups per hop
    const incomingByToNode = new Map<string, CanvasEdge[]>();
    for (const e of data.edges) {
      const list = incomingByToNode.get(e.toNode);
      if (list) list.push(e); else incomingByToNode.set(e.toNode, [e]);
    }

    const depthById: Record<string, number> = Object.create(null);
    const chain: CanvasNode[] = [];
    const seen = new Set<string>(); // guard against cycles

    let currentId = targetId;
    let depth = 0;

    while (depth < maxDepth) {
      // Find incoming edges that connect to the TOP of the current node (prefer indexed lookup)
      const incoming = incomingByToNode.get(currentId) || [];
      const incomingTop = incoming.filter(e => e.toSide === "top");
      if (incomingTop.length === 0) break;

      // Prefer an edge that comes from the bottom side of the predecessor; else take the first
      const chosen = incomingTop.find(e => e.fromSide === "bottom") ?? incomingTop[0];
      const prevId = chosen.fromNode;
      if (!prevId || prevId === currentId) break;
      if (seen.has(prevId)) break;
      seen.add(prevId);

      depth += 1;
      depthById[prevId] = depth;
      const prevNode = nodeById.get(prevId);
      if (prevNode) chain.push(prevNode);

      currentId = prevId;
    }

    // Already in increasing depth order (1..depth)
    return { nodes: chain, depthById };
  }

  /** Convert nodes to textual context */
  private async materializeContext(nodes: CanvasNode[]): Promise<{ text: string; sourcesMarkdown: string; }> {
    const tasks: Array<() => Promise<{ part?: string; sources?: string[] }>> = [];
    for (const n of nodes) {
      if (n.type === "text") {
        tasks.push(async () => {
          const raw = extractTextField(n.text);
          const txt = raw.slice(0, this.settings.contextCharLimitPerNode);
          return { part: `### Text card (${n.id})\n${txt}`, sources: [`- Text card (${n.id})`] };
        });
      } else if (n.type === "file" && n.file) {
        tasks.push(async () => {
          const path = resolveFilePath(n.file);
          const af = this.app.vault.getAbstractFileByPath(path);
          if (af instanceof TFile) {
            const content = (await this.app.vault.read(af)).slice(0, this.settings.contextCharLimitPerNode);
            return { part: `### File: ${path}\n${content}`, sources: [`- [[${path}]]`] };
          } else {
            return { sources: [`- Missing file: ${path}`] };
          }
        });
      } else if (n.type === "link") {
        tasks.push(async () => {
          const urlRef = typeof n.url === 'string' ? n.url : extractTextField(n.url);
          return { part: `### Link: ${urlRef}\nLabel: ${n.label ?? ""}`, sources: [`- Link: ${urlRef}`] };
        });
      } else if (n.type === "group") {
        tasks.push(async () => ({ part: `### Group: ${n.label ?? n.id}`, sources: [`- Group: ${n.label ?? n.id}`] }));
      } else {
        tasks.push(async () => ({ }));
      }
    }

    const results = await runWithConcurrency(tasks, getConcurrency(6));
    const parts: string[] = [];
    const sources: string[] = [];
    for (const r of results) {
      if (r.part) parts.push(r.part);
      if (r.sources) sources.push(...r.sources);
    }

    return { text: parts.join("\n\n"), sourcesMarkdown: sources.join("\n") };
  }

  /** OpenAI call (Chat Completions) */
  private async callOpenAI(question: string, context: { text: string; sourcesMarkdown: string; }, signal?: AbortSignal): Promise<string> {
    // Safety check: never call the API unless explicitly enabled
    if (!this.settings.allowApiCalls) {
      throw new Error("LLM API calls are disabled in settings.");
    }
    const base = this.settings.openAIBaseURL.replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.settings.openAIKey}`,
    } as Record<string, string>;

    const system = (this.settings.systemPrompt && this.settings.systemPrompt.trim())
      ? this.settings.systemPrompt
      : DEFAULT_SYSTEM_PROMPT;

    const user =
`# Question
${question}

# Selected node + Upstream Context
${context.text}

# output
Keep response under ${this.settings.maxTokens} tokens.
# Title (H1)
Content
`;
    // Chat Completions API
    const url = `${base}/v1/chat/completions`;
    const payload = {
      model: this.settings.openAIModel,
      temperature: this.settings.temperature,
      max_tokens: this.settings.maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    };

    // Resilience: retries with exponential backoff + jitter and client-side timeout
    const maxAttempts = 3;
    const baseDelayMs = 800;
    const maxDelayMs = 6000;
    const requestTimeoutMs = 30000; // 30s per attempt

    const shouldRetry = (status?: number) => {
      if (status == null) return true; // network error
      if (status === 408 || status === 429) return true;
      if (status >= 500 && status <= 599) return true;
      return false;
    };

    const parseRetryAfter = (val: unknown): number | null => {
      if (!val) return null;
      const s = String(val).trim();
      // Seconds delta
      if (/^\d+$/.test(s)) return Math.max(0, parseInt(s, 10)) * 1000;
      // HTTP-date
      const t = Date.parse(s);
      if (!isNaN(t)) {
        const ms = t - Date.now();
        if (ms > 0) return ms;
      }
      return null;
    };

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      try {
        // Race the request with a timeout and external abort signal
        const reqPromise: Promise<RequestUrlResponse> = requestUrl({
          url,
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          const id = window.setTimeout(() => {
            const err = new Error("Request timed out");
            Object.defineProperty(err, 'name', { value: 'AbortError' });
            reject(err);
          }, requestTimeoutMs);
          if (signal) {
            const onAbort = () => { window.clearTimeout(id); const e = new Error("Aborted"); Object.defineProperty(e, 'name', { value: 'AbortError' }); reject(e); };
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });

        const response = await Promise.race<RequestUrlResponse>([reqPromise, timeoutPromise]);

        if (signal?.aborted) {
          const e = new Error("Aborted"); Object.defineProperty(e, 'name', { value: 'AbortError' }); throw e;
        }

        const status: number = response?.status ?? 0;
        if (status < 200 || status >= 300) {
          const bodyText: string = response?.text ?? '';
          // Attempt to parse a structured error for safer logging
          let errCode: string | undefined;
          let errMsg: string | undefined;
          try {
            const parsed = bodyText ? JSON.parse(bodyText) : undefined;
            errCode = parsed?.error?.code || parsed?.error?.type || parsed?.code;
            errMsg = parsed?.error?.message || parsed?.message;
          } catch { /* ignore */ }
          // Decide on retry using status and Retry-After
          if (attempt < maxAttempts && shouldRetry(status)) {
            const retryAfterRaw = (response.headers?.['retry-after'] ?? response.headers?.['Retry-After']);
            let delay = parseRetryAfter(retryAfterRaw) ?? Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
            // add jitter (+/-20%)
            const jitter = Math.round(delay * (Math.random() * 0.4 - 0.2));
            delay = Math.max(200, delay + jitter);
            await Promise.race([
              sleep(delay),
              new Promise<never>((_, reject) => {
                if (signal) signal.addEventListener('abort', () => { const e = new Error("Aborted"); Object.defineProperty(e, 'name', { value: 'AbortError' }); reject(e); }, { once: true });
              })
            ]);
            continue;
          }
          const safeDetail = errMsg ? sanitizeForLog(errMsg) : `(response length ${bodyText.length})`;
          const codePart = errCode ? ` ${errCode}` : '';
          throw new Error(`OpenAI API error ${status}${codePart}: ${safeDetail}`);
        }

        // Success
        let json: unknown;
        try { json = (response as unknown as { json?: unknown; text?: string })?.json ?? JSON.parse(response?.text ?? '{}'); } catch { json = {}; }
        const text: string | undefined = (json as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error("No content returned from model.");
        return text;
      } catch (err: unknown) {
        if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError') throw err; // respect user cancellation/timeout
        if (attempt >= maxAttempts) throw err;
        // Unknown/network error: one more retry with backoff
        const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 250);
        await Promise.race([
          sleep(delay),
          new Promise<never>((_, reject) => {
            if (signal) signal.addEventListener('abort', () => { const e = new Error("Aborted"); Object.defineProperty(e, 'name', { value: 'AbortError' }); reject(e); }, { once: true });
          })
        ]);
        continue;
      }
    }
  }

  /** Cancel any in-flight ask */
  private cancelAsk(reason?: string) {
    try {
      if (this.askAbortController) {
        this.askAbortController.abort();
      }
    } finally {
      this.askAbortController = null;
      this.setBusy(false);
    }
    if (reason) console.warn(reason);
  }

  /** Create or overwrite note */
  private async createOrOverwrite(path: string, body: string): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, body);
      return existing;
    }
    // ensure folder
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir);
    }
    return await this.app.vault.create(path, body);
  }

  

  /**
   * Find the first non-overlapping spot directly below the parent.
   * Strategy:
   *   1) Try the first row under the parent (fixed Y), scanning horizontally along X in slots
   *      aligned to the parent's width with spacing. Order: parent.x, then right, then left, etc.
   *   2) If no horizontal slot is free on that row, move down one row and repeat.
   */
  private findFreeSpotBelow(
    data: CanvasData,
    parent: CanvasNode,
    width: number,
    height: number,
    vSpacing: number = 60,
    hSpacing: number = 60,
    maxCols: number = 24,
    maxRows: number = 48,
    grid: number = 20
  ): { x: number; y: number } {
    const baseY = parent.y + parent.height + vSpacing;

    // Rectangle overlap check
    const overlaps = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) => {
      return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
    };

    const slotOffset = width + hSpacing;

    // Snap helper (align to grid)
    const snap = (v: number) => grid > 1 ? Math.round(v / grid) * grid : v;

    // Generate symmetric X offsets: 0, +1, -1, +2, -2, ... up to maxCols
    const genOffsets = (count: number) => {
      const arr: number[] = [];
      for (let step = 0; step <= count; step++) {
        if (step === 0) arr.push(0); else { arr.push(step); arr.push(-step); }
      }
      return arr;
    };

    const offsets = genOffsets(maxCols);

    // Try row by row
    for (let r = 0; r < maxRows; r++) {
      const yRaw = baseY + r * (height + vSpacing);
      const y = snap(yRaw);
      // Scan horizontally around parent's x
      for (const step of offsets) {
        const xRaw = parent.x + step * slotOffset;
        const x = snap(xRaw);
        let collided = false;
        for (const n of data.nodes) {
          if (!n || n.id === parent.id) continue;
          if (overlaps(x, y, width, height, n.x, n.y, n.width, n.height)) { collided = true; break; }
        }
        if (!collided) return { x, y };
      }
    }

    // Fallback: place directly below parent at baseY
    return { x: snap(parent.x), y: snap(baseY) };
  }

  /** Always add a new file node as a child of the given parent node and connect it with a labeled edge. */
  private applyResultAsChild(data: CanvasData, parent: CanvasNode, newFilePath: string, questionLabel: string): CanvasData {
    // Mutate in place to avoid cloning large arrays

    // Determine a free position directly below the parent (avoiding overlaps)
    const width = parent.width;
    const height = parent.height;
    const { x, y } = this.findFreeSpotBelow(data, parent, width, height, 120);

    const fileNode: CanvasNode = {
      id: uuid(),
      type: "file",
      x,
      y,
      width,
      height,
      file: newFilePath,
      // Use a concise node label: first 9 words of the question, with ellipsis if longer
      label: truncateWords(questionLabel, DEFAULT_LABEL_WORDS),
    };
    data.nodes.push(fileNode);

    // Connect parent → child with a vertical edge for clearer hierarchy
    data.edges.push({
      id: uuid(),
      fromNode: parent.id,
      toNode: fileNode.id,
      fromSide: "bottom",
      toSide: "top",
      // Use a concise edge label: first 9 words of the question, with ellipsis if longer
      label: truncateWords(questionLabel, DEFAULT_LABEL_WORDS) || "answer",
    });

    return data;
  }

  /**
   * Demote headings in included Markdown:
   * - ATX and Setext headings are downgraded by one level (e.g., # -> ##).
   * - Any heading that would be level 5 or deeper becomes bold text instead.
   * - Skips transformation inside fenced code blocks.
   */
  private demoteHeadings(md: string): string {
    const lines = md.split(/\r?\n/);
    const out: string[] = [];
    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Toggle fenced code blocks (``` or ~~~)
      const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
      if (fenceMatch) {
        const ticks = fenceMatch[2];
        const char = ticks[0];
        const len = ticks.length;
        if (!inFence) {
          inFence = true; fenceChar = char; fenceLen = len;
        } else if (char === fenceChar && len >= fenceLen) {
          inFence = false; fenceChar = ''; fenceLen = 0;
        }
        out.push(line);
        continue;
      }

      if (!inFence) {
        // Handle Setext-style headings
        const next = lines[i + 1];
        if (next && /^[ \t]*[=-]{3,}[ \t]*$/.test(next)) {
          const text = line.trimEnd();
          if (text && !/^\s*#/.test(text)) {
            const isH1 = next.trim().startsWith('=');
            const newLevel = (isH1 ? 1 : 2) + 1; // demote by 1
            if (newLevel >= 5) {
              out.push(`**${text.trim()}**`);
            } else {
              out.push(`${'#'.repeat(newLevel)} ${text.trim()}`);
            }
            i++; // skip underline line
            continue;
          }
        }

        // Handle ATX-style headings
        const m = line.match(/^(\s{0,3})(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (m) {
          const indent = m[1] || '';
          const hashes = m[2];
          const content = m[3].trim();
          const newLevel = hashes.length + 1; // demote by 1
          if (newLevel >= 5) {
            out.push(`${indent}**${content}**`);
          } else {
            out.push(`${indent}${'#'.repeat(newLevel)} ${content}`);
          }
          continue;
        }
      }

      out.push(line);
    }

    return out.join('\n');
  }

  /**
   * Export chain of nodes and edges starting from a selected node.
   */
  async exportChain() {
    const canvasFile = this.app.workspace.getActiveFile();
    if (!canvasFile || canvasFile.extension !== "canvas") {
      new Notice("Open a .canvas file first.");
      return;
    }

    const data = await this.readCanvas(canvasFile);
    if (data.nodes.length === 0) {
      new Notice("Canvas is empty.");
      return;
    }

    // 1) Pick the root node for chain export
    const root = await this.pickNode(data, canvasFile.path);
    if (!root) return;

    // 2) Collect upstream nodes and edges
    const upstreamInfo = this.collectPredecessorsUpToDepth(data, root.id, 10);
    // Reverse so the furthest upstream node is first, root is last
    const upstreamNodes = [...upstreamInfo.nodes.reverse(), root];
    const upstreamNodeIds = new Set(upstreamNodes.map(n => n.id));
    const upstreamEdges = data.edges.filter(e =>
      upstreamNodeIds.has(e.fromNode) && upstreamNodeIds.has(e.toNode)
    );

    // 3) Generate Markdown summary
    const fileContent = await this.generateChainMarkdown(upstreamNodes, upstreamEdges);
    // Define output path for the exported chain note
    const outFolder = this.settings.outputFolder || (canvasFile.parent?.path ?? "");
    // Build a clean filename that excludes folder names for file nodes.
    // For file-root, use basename without extension; otherwise, use node label's first line.
    let nameForFilename: string;
    if (root.type === 'file') {
      const fileRef = resolveFilePath(root.file);
      const leaf = (fileRef?.split('/')?.pop() ?? fileRef ?? '').trim();
      // Strip extension (e.g., .md, .canvas, etc.) to avoid double extensions
      const withoutExt = leaf.replace(/\.[^\.]+$/, '');
      nameForFilename = withoutExt || root.id;
    } else {
      nameForFilename = firstLine(getNodeLabel(root)) || root.id;
    }
    const baseName = sanitizeFilename(`Chain - ${nameForFilename}`);
    const targetPath = normalizePath((outFolder ? outFolder + "/" : "") + baseName + ".md");
    const newNote = await this.createOrOverwrite(targetPath, fileContent);

    new Notice(`Exported chain to ${newNote.path}`);
  }

  /**
   * Generate Markdown for exported chain in a minimal format:
   *   Top-most node
   *   ...
   *   Selected node
   *
   * Followed by "# References" with joined list of file/link refs used.
   */
  async generateChainMarkdown(nodes: CanvasNode[], edges: CanvasEdge[]): Promise<string> {
    // Build a quick lookup for the best incoming TOP edge per node (prefer fromSide=bottom)
    const incomingTopByToNode = new Map<string, CanvasEdge>();
    for (const e of edges) {
      if (e.toSide !== 'top') continue;
      const existing = incomingTopByToNode.get(e.toNode);
      if (!existing) {
        incomingTopByToNode.set(e.toNode, e);
      } else {
        if (existing.fromSide !== 'bottom' && e.fromSide === 'bottom') {
          incomingTopByToNode.set(e.toNode, e);
        }
      }
    }
    // Collect references and build included content with limited concurrency
    const tasks: Array<() => Promise<{ part?: string; refs?: string[] }>> = [];
    for (const n of nodes) {
      // Determine incoming TOP-edge label (the question) for this node if available
      const incoming = incomingTopByToNode.get(n.id);
      const edgeLabel = (incoming?.label ?? '').trim();
      const edgeLabelQuoted = edgeLabel
        ? edgeLabel.split(/\r?\n/).map(l => `> ${l}`).join('\n')
        : '';

      if (n.type === 'file' && n.file) {
        tasks.push(async () => {
          const path = resolveFilePath(n.file);
          const refs: string[] = [`[[${path}]]`];
          const af = this.app.vault.getAbstractFileByPath(path);
          if (af instanceof TFile) {
            try {
              const raw = await this.app.vault.read(af);
              const demoted = this.demoteHeadings(raw);
              const part = edgeLabelQuoted ? `${edgeLabelQuoted}\n\n${demoted}` : demoted;
              return { part, refs };
            } catch {
              // Include the question label even if file content cannot be read
              const part = edgeLabelQuoted || undefined;
              return { part, refs };
            }
          }
          // Unknown file type; still include the question label if present
          const part = edgeLabelQuoted || undefined;
          return { part, refs };
        });
      } else if (n.type === 'text') {
        tasks.push(async () => {
          const raw = extractTextField(n.text);
          if (raw && raw.length) {
            const quoted = raw.split(/\r?\n/).map(l => `> ${l}`).join('\n');
            return { part: quoted };
          }
          return {};
        });
      } else if (n.type === 'link') {
        tasks.push(async () => {
          const url = typeof n.url === 'string' ? n.url : extractTextField(n.url);
          return url ? { refs: [url] } : {};
        });
      } else {
        tasks.push(async () => ({}));
      }
    }

    const results = await runWithConcurrency(tasks, getConcurrency(6));
    const parts: string[] = [];
    const refs = new Set<string>();
    for (const r of results) {
      if (r.part) parts.push(r.part);
      if (r.refs) r.refs.forEach((x) => refs.add(x));
    }

    let md = parts.join('\n\n');
    if (md.length) md += '\n\n';
    md += '# References\n';
    md += Array.from(refs).join('\n');
    return md;
  }

}

/** ---------- Settings UI ---------- */
class CanvasAskSettingsTab extends PluginSettingTab {
  plugin: CanvasAskPlugin;
  constructor(app: App, plugin: CanvasAskPlugin) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl("h2", { text: "Ask Canvas – Settings" });

    // UI visibility toggles
    new Setting(containerEl)
      .setName("Show ribbon button")
      .setDesc("Show the Ask Canvas button in the left ribbon.")
      .addToggle(t => t
        .setValue(this.plugin.settings.showRibbonButton)
        .onChange((v) => { this.plugin.settings.showRibbonButton = v; this.plugin.scheduleSaveSettings(); this.plugin.buildUiFromSettings(); }));

    new Setting(containerEl)
      .setName("Show status bar button")
      .setDesc("Show the Ask Canvas control in the status bar.")
      .addToggle(t => t
        .setValue(this.plugin.settings.showStatusBarButton)
        .onChange((v) => { this.plugin.settings.showStatusBarButton = v; this.plugin.scheduleSaveSettings(); this.plugin.buildUiFromSettings(); }));

    const apiCallsDesc = document.createDocumentFragment();
    {
      const p1 = document.createElement('div');
      p1.textContent = "When ON, 'Active Canvas Query' will send the selected node and its upstream context to your configured LLM via API.";
      const p2 = document.createElement('div');
      p2.textContent = `Context may include: text card contents, link URLs, and excerpts of referenced files up to ${this.plugin.settings.contextCharLimitPerNode} characters per node.`;
      const p3 = document.createElement('div');
      p3.textContent = "Default is OFF. Enable only if you are comfortable sending this data to your provider.";
      apiCallsDesc.appendChild(p1); apiCallsDesc.appendChild(p2); apiCallsDesc.appendChild(p3);
    }

    new Setting(containerEl)
      .setName("Enable LLM API calls")
      .setDesc(apiCallsDesc)
      .addToggle(t => t
        .setValue(this.plugin.settings.allowApiCalls)
        .onChange((v) => { this.plugin.settings.allowApiCalls = v; this.plugin.scheduleSaveSettings(); }));

    {
      let showKey = false;
      let keyInputEl: HTMLInputElement | null = null;
      const keySetting = new Setting(containerEl)
        .setName("OpenAI API key")
        .setDesc("Stored in your vault’s plugin data.")
        .addText(t => {
          t.setPlaceholder("sk-...")
            .setValue(this.plugin.settings.openAIKey)
            .onChange((v) => { this.plugin.settings.openAIKey = v.trim(); this.plugin.scheduleSaveSettings(); });
          // Mask API key entry in UI
          t.inputEl.type = 'password';
          t.inputEl.spellcheck = false;
          t.inputEl.autocomplete = 'new-password';
          keyInputEl = t.inputEl;
        });

      keySetting.addExtraButton(btn => {
        btn.setIcon('eye');
        btn.setTooltip('Show key');
        btn.onClick(() => {
          showKey = !showKey;
          if (keyInputEl) keyInputEl.type = showKey ? 'text' : 'password';
          btn.setIcon(showKey ? 'eye-off' : 'eye');
          btn.setTooltip(showKey ? 'Hide key' : 'Show key');
        });
      });
    }

    new Setting(containerEl)
      .setName("API Base URL")
      .setDesc("Usually https://api.openai.com")
      .addText(t => t
        .setPlaceholder(DEFAULTS.openAIBaseURL)
        .setValue(this.plugin.settings.openAIBaseURL)
        .onChange((v) => {
          const raw = v.trim();
          if (!raw) {
            this.plugin.settings.openAIBaseURL = DEFAULTS.openAIBaseURL;
            this.plugin.scheduleSaveSettings();
            return;
          }
          let parsed: URL | null = null;
          let usedPrefix = false;
          try {
            parsed = new URL(raw);
          } catch {
            try {
              parsed = new URL(`https://${raw}`);
              usedPrefix = true;
            } catch {
              parsed = null;
            }
          }
          if (!parsed) {
            new Notice("Invalid API Base URL. Example: https://api.openai.com");
            return; // keep previous valid value
          }
          if (parsed.protocol === 'http:') {
            new Notice("Warning: API Base URL uses insecure http:. Use https: to protect your key.");
          } else if (usedPrefix) {
            new Notice("Assuming https:// prefix for API Base URL.");
          }
          // Normalize: strip trailing slashes
          const normalized = parsed.origin.replace(/\/+$/, "");
          this.plugin.settings.openAIBaseURL = normalized;
          this.plugin.scheduleSaveSettings();
        }));

    new Setting(containerEl)
      .setName("Model")
      .setDesc("e.g., gpt-4o-mini, gpt-4.1")
      .addText(t => t
        .setPlaceholder(DEFAULTS.openAIModel)
        .setValue(this.plugin.settings.openAIModel)
        .onChange((v) => { this.plugin.settings.openAIModel = v.trim() || DEFAULTS.openAIModel; this.plugin.scheduleSaveSettings(); }));

    // System prompt editor (multiline)
    {
      const s = new Setting(containerEl)
        .setName("System prompt")
        .setDesc("System message sent with each API call. Leave blank to use the default.");
      const area = s.controlEl.createEl('textarea', { cls: 'ask-canvas-settings-textarea' });
      area.setAttr('spellcheck', 'false');
      area.placeholder = DEFAULT_SYSTEM_PROMPT;
      area.value = this.plugin.settings.systemPrompt || '';
      area.addEventListener('input', () => {
        this.plugin.settings.systemPrompt = area.value;
        this.plugin.scheduleSaveSettings();
      });
    }

    new Setting(containerEl)
      .setName("Temperature")
      .addText(t => t
        .setPlaceholder(String(DEFAULTS.temperature))
        .setValue(String(this.plugin.settings.temperature))
        .onChange((v) => { this.plugin.settings.temperature = Number(v) || DEFAULTS.temperature; this.plugin.scheduleSaveSettings(); }));

    new Setting(containerEl)
      .setName("Max tokens")
      .addText(t => t
        .setPlaceholder(String(DEFAULTS.maxTokens))
        .setValue(String(this.plugin.settings.maxTokens))
        .onChange((v) => { this.plugin.settings.maxTokens = Number(v) || DEFAULTS.maxTokens; this.plugin.scheduleSaveSettings(); }));

    new Setting(containerEl)
      .setName("Context char limit per upstream node")
      .addText(t => t
        .setPlaceholder(String(DEFAULTS.contextCharLimitPerNode))
        .setValue(String(this.plugin.settings.contextCharLimitPerNode))
        .onChange((v) => { this.plugin.settings.contextCharLimitPerNode = Number(v) || DEFAULTS.contextCharLimitPerNode; this.plugin.scheduleSaveSettings(); }));

    new Setting(containerEl)
      .setName("Output folder (optional)")
      .setDesc("Relative to vault root; blank = alongside the canvas.")
      .addText(t => t
        .setPlaceholder("(e.g., Answers)")
        .setValue(this.plugin.settings.outputFolder)
        .onChange((v) => { this.plugin.settings.outputFolder = v.trim(); this.plugin.scheduleSaveSettings(); }));

    new Setting(containerEl)
      .setName("Related local search results to show")
      .setDesc("Number of top matches to present (3–12)")
      .addSlider(s => s
        .setLimits(3, 12, 1)
        .setDynamicTooltip()
        .setValue(Math.max(3, Math.min(12, this.plugin.settings.topRelatedResults ?? DEFAULTS.topRelatedResults)))
        .onChange((v) => { this.plugin.settings.topRelatedResults = v; this.plugin.scheduleSaveSettings(); }));
  }
}

/**
 * Read a file's frontmatter title or first H1. Returns null if file missing or no usable title.
 */
async function readFrontTitleOrH1(app: App, path: string): Promise<string | null> {
  const af = app.vault.getAbstractFileByPath(path);
  if (!(af instanceof TFile)) return null;

  // Prefer metadataCache frontmatter title if available (safe for large files)
  try {
    // @ts-ignore metadataCache exists on App
    const cache = app.metadataCache.getFileCache(af);
    const fmTitle = cache?.frontmatter?.title;
    if (typeof fmTitle === "string" && fmTitle.trim()) return fmTitle.trim();
  } catch {
    // ignore and fall back to reading file
  }

  // Fallback: read content and extract first H1 (# Title)
  try {
    const content = await app.vault.read(af);
    const h1 = content.match(/^\s*#\s+(.+)$/m);
    if (h1 && h1[1]) return h1[1].trim();

    // Final fallback: use file name without extension
    const nameNoExt = af.name ? af.name.replace(/\.[^/.]+$/, "") : null;
    return nameNoExt && nameNoExt.trim() ? nameNoExt.trim() : null;
  } catch {
    return null;
  }
}
