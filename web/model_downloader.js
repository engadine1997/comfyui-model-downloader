import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const PREFS_KEY = "ModelDownloader.prefs";
const MAX_ROWS = 300;
const ACTIVE = new Set(["queued", "downloading", "paused", "failed"]);
const SOURCES = { civitai: "CivitAI", huggingface: "Hugging Face", direct: "Direct link" };
const STATUS = { queued: "Queued", downloading: "Downloading", paused: "Paused", failed: "Failed", done: "Completed", skipped: "Skipped", cancelled: "Cancelled" };
const SUBDIR_RECENT = 6;

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./model_downloader.css", import.meta.url).href;
document.head.appendChild(css);

// ------------------------------------------------------------------ utils ---

const svg = (body, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

const ICONS = {
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'),
  play: svg('<path d="M7 4.5v15l12-7.5z"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  stop: svg('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>'),
  retry: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  settings: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  paste: svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  external: svg('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  queue: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  history: svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  alert: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>'),
  file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  maximize: svg('<rect x="4" y="4" width="16" height="16" rx="1.5"/>'),
  restore: svg('<rect x="3" y="8" width="13" height="13" rx="1.5"/><path d="M8 8V4.5A1.5 1.5 0 0 1 9.5 3h10A1.5 1.5 0 0 1 21 4.5v10a1.5 1.5 0 0 1-1.5 1.5H16"/>'),
};

const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "value") el.value = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
};

function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtDuration(s) {
  s = Math.round(s);
  const m = Math.floor(s / 60), hh = Math.floor(m / 60);
  const ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${String(m % 60).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
const fmtDate = (s) => new Date(s * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const extOf = (name) => (name.includes(".") ? name.slice(name.lastIndexOf(".")) : "");
const safeName = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, "_").replace(/^\.+|\.+$/g, "");

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

async function request(route, { params, body } = {}) {
  const query = params ? `?${new URLSearchParams(params)}` : "";
  const res = await api.fetchApi(route + query, body !== undefined
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error((await res.text()) || `${res.status} ${res.statusText}`);
  return res.json();
}

// ------------------------------------------------------------- downloader ---

class ModelDownloader {
  constructor() {
    this.prefs = { refresh: true, ifExists: "rename", maximized: false, recent: [], ...loadPrefs() };
    this.jobs = new Map();
    this.jobEls = new Map();
    this.roots = [];
    this.view = "new";
    this.info = null;
    this.rows = [];
    this.subdir = "";
    this.ifExists = this.prefs.ifExists;
    this.maximized = !!this.prefs.maximized;
    this.dirCache = new Map();
    this.built = false;
  }

  // ----- DOM -----

  build() {
    const tb = (icon, title, onclick, extra = {}) => h("button", { class: "md-btn", title, html: ICONS[icon], onclick, ...extra });
    const E = this.el = {};

    E.url = h("input", { class: "md-url-input", type: "text", spellcheck: "false", placeholder: "Paste a CivitAI, Hugging Face or direct download link" });
    E.url.addEventListener("keydown", (e) => { if (e.key === "Enter") this.inspect(); });
    E.url.addEventListener("paste", () => setTimeout(() => this.inspect(), 0));
    E.address = h("label", { class: "md-address", html: ICONS.link }, E.url);
    E.inspect = h("button", { class: "md-dbtn primary", onclick: () => this.inspect() }, "Inspect");
    E.pasteBtn = tb("paste", "Paste link from clipboard", () => this.pasteLink());
    E.settingsBtn = tb("settings", "Settings (tokens, concurrency)", () => this.openSettings());

    E.nav = {};
    const navRow = (view, icon, label) => {
      const count = h("span", { class: "md-count" });
      const row = h("div", { class: "md-tree-row", onclick: () => this.showView(view) }, h("span", { class: "md-tree-icon", html: ICONS[icon] }), h("span", { class: "md-tree-label" }, label), count);
      E.nav[view] = { row, count };
      return row;
    };
    E.sidebar = h("div", { class: "md-sidebar" }, navRow("new", "download", "New download"), navRow("queue", "queue", "Queue"), navRow("history", "history", "History"));

    E.newView = h("div", { class: "md-view md-new" });
    E.queueList = h("div", { class: "md-list" });
    E.queueEmpty = h("div", { class: "md-empty" }, "No active downloads.");
    E.queueView = h("div", { class: "md-view" },
      h("div", { class: "md-viewbar" }, h("button", { class: "md-btn md-btn-text", html: `${ICONS.play}<span>Resume all</span>`, onclick: () => this.action({ action: "resume_all" }) })),
      E.queueList, E.queueEmpty);
    E.historyList = h("div", { class: "md-list" });
    E.historyEmpty = h("div", { class: "md-empty" }, "Nothing here yet.");
    E.historyView = h("div", { class: "md-view" },
      h("div", { class: "md-viewbar" }, h("button", { class: "md-btn md-btn-text", html: `${ICONS.trash}<span>Clear completed</span>`, onclick: () => this.action({ action: "clear_finished" }) })),
      E.historyList, E.historyEmpty);
    E.views = { new: E.newView, queue: E.queueView, history: E.historyView };

    E.statusLeft = h("span");
    E.statusRight = h("span", { class: "md-status-right" });
    E.toasts = h("div", { class: "md-toasts" });
    E.title = h("span", { class: "md-title-text" }, "Model Downloader");
    E.maxBtn = h("button", { class: "md-wbtn", title: "Maximize", onclick: () => this.toggleMaximize() });
    E.titlebar = h("div", { class: "md-titlebar", ondblclick: (e) => !e.target.closest("button") && this.toggleMaximize() },
      h("span", { class: "md-title-icon", html: ICONS.download }), E.title, h("div", { class: "md-flex" }),
      E.maxBtn, h("button", { class: "md-wbtn md-wclose", title: "Close (Esc)", html: ICONS.close, onclick: () => this.close() }));

    E.window = h("div", { class: "md-window", tabindex: "0", role: "dialog", "aria-label": "Model Downloader" },
      E.titlebar,
      h("div", { class: "md-toolbar" }, E.address, E.inspect, E.pasteBtn, h("div", { class: "md-sep" }), E.settingsBtn),
      h("div", { class: "md-body" }, E.sidebar, h("div", { class: "md-splitter" }), h("div", { class: "md-main" }, E.newView, E.queueView, E.historyView)),
      h("div", { class: "md-statusbar" }, E.statusLeft, E.statusRight),
      E.toasts);
    E.overlay = h("div", { class: "md-overlay" }, E.window);
    document.body.appendChild(E.overlay);
    this.bindEvents();
    this.applyWindowState();
    this.built = true;
  }

  bindEvents() {
    const E = this.el;
    E.overlay.addEventListener("mousedown", (e) => { if (e.target === E.overlay) this.close(); });
    // Keep ComfyUI's global shortcuts from seeing our keystrokes.
    for (const t of ["keydown", "keyup", "keypress", "copy", "cut", "paste", "wheel"]) E.window.addEventListener(t, (e) => e.stopPropagation());
    E.window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !this.dialogOpen) this.close(); });
    E.window.addEventListener("contextmenu", (e) => e.stopPropagation());
    E.window.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/uri-list") || e.dataTransfer.types.includes("text/plain")) e.preventDefault(); });
    E.window.addEventListener("drop", (e) => {
      const text = (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain")).trim();
      if (!text) return;
      e.preventDefault();
      E.url.value = text.split("\n")[0];
      this.inspect();
    });

    E.titlebar.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest("button") || this.maximized) return;
      const r = E.window.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        E.window.style.left = `${Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx))}px`;
        E.window.style.top = `${Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy))}px`;
      };
      const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
    });
    E.window.querySelector(".md-splitter").addEventListener("mousedown", (e) => {
      e.preventDefault();
      const start = e.clientX, w = E.sidebar.offsetWidth;
      const move = (ev) => { E.sidebar.style.width = `${Math.max(120, Math.min(400, w + ev.clientX - start))}px`; };
      const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
    });
  }

  applyWindowState() {
    const E = this.el;
    E.window.classList.toggle("maximized", this.maximized);
    E.maxBtn.innerHTML = this.maximized ? ICONS.restore : ICONS.maximize;
    E.maxBtn.title = this.maximized ? "Restore" : "Maximize";
  }

  toggleMaximize() {
    this.maximized = !this.maximized;
    this.persist();
    this.applyWindowState();
  }

  persist() {
    savePrefs({ ...this.prefs, ifExists: this.ifExists, maximized: this.maximized });
  }

  // ----- open / close -----

  get isOpen() {
    return this.built && this.el.overlay.classList.contains("open");
  }

  async open() {
    if (!this.built) {
      this.build();
      this.showView("new");
      this.renderNew();
    }
    this.el.overlay.classList.add("open");
    this.el.window.focus({ preventScroll: true });
    if (!this.info) this.el.url.focus();
    await Promise.all([this.loadRoots(), this.loadJobs()]);
  }

  close() {
    if (!this.isOpen) return;
    this.el.overlay.classList.remove("open");
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  async loadRoots() {
    try {
      this.roots = await request("/modeldl/roots");
      if (this.info) this.renderNew();
    } catch (e) {
      this.toast(e.message, "error");
    }
  }

  async loadJobs() {
    try {
      for (const j of await request("/modeldl/list")) this.upsert(j, true);
    } catch (e) {
      this.toast(e.message, "error");
    }
  }

  showView(view) {
    this.view = view;
    for (const [k, el] of Object.entries(this.el.views)) el.classList.toggle("active", k === view);
    for (const [k, n] of Object.entries(this.el.nav)) n.row.classList.toggle("active", k === view);
    this.updateCounts();
  }

  // ----- inspecting a link -----

  async pasteLink() {
    try {
      this.el.url.value = (await navigator.clipboard.readText()).trim();
      this.inspect();
    } catch {
      this.toast("Clipboard access was denied. Paste with Ctrl+V instead.", "error");
      this.el.url.focus();
    }
  }

  async inspect() {
    const url = this.el.url.value.trim();
    if (!url) return;
    this.showView("new");
    this.el.window.classList.add("loading");
    this.el.inspect.disabled = true;
    try {
      this.info = await request("/modeldl/resolve", { body: { url } });
      this.failure = null;
      this.version = this.info.version;
      this.naming = "original";
      this.filter = "";
      this.modelsOnly = this.info.files?.some((f) => f.model) ?? false;
      this.setupRows();
    } catch (e) {
      this.info = null;
      this.failure = e.message;
    } finally {
      this.el.window.classList.remove("loading");
      this.el.inspect.disabled = false;
    }
    this.renderNew();
  }

  currentFiles() {
    return this.info.versions ? this.info.versions.find((v) => v.id === this.version)?.files || [] : this.info.files;
  }

  setupRows() {
    const files = this.currentFiles();
    this.rows = files.map((f) => ({ f, on: !!f.selected, name: f.name, root: f.root, exists: false }));
    if (!this.rows.some((r) => r.on) && this.info.versions) {
      const first = this.rows.find((r) => !r.f.extra);
      if (first) first.on = true;
    }
    this.defaultRoot = this.rows.find((r) => r.root)?.root || this.prefs.root || "checkpoints";
    const base = this.info.versions?.find((v) => v.id === this.version)?.base_model;
    this.baseModel = base ? safeName(base) : "";
  }

  rootOf(row) {
    return row.root || this.defaultRoot;
  }

  // ----- "new download" view -----

  renderNew() {
    const E = this.el, V = E.newView, info = this.info;
    V.replaceChildren();
    if (!info) {
      V.append(this.failure
        ? h("div", { class: "md-error", html: ICONS.alert }, h("span", {}, this.failure))
        : h("div", { class: "md-hint" },
          h("div", { class: "md-hint-title" }, "Download a model"),
          h("p", {}, "Paste a link above. Supported sources:"),
          h("ul", {},
            h("li", {}, h("b", {}, "CivitAI"), " (civitai.com and civitai.red): a model page, a specific version or a download link."),
            h("li", {}, h("b", {}, "Hugging Face"), ": a repo (pick which files you want), a folder or a single file."),
            h("li", {}, h("b", {}, "Direct link"), ": any URL that points at a file (.safetensors, .pth, .gguf, ...)."))));
      return this.updateCounts();
    }

    const version = info.versions?.find((v) => v.id === this.version);
    const sel = info.versions && h("select", { class: "md-select", title: "Version", onchange: () => {
      this.version = +sel.value;
      this.setupRows();
      this.renderNew();
    } }, ...info.versions.map((v) => h("option", { value: v.id, selected: v.id === this.version }, v.name + (v.base_model ? ` · ${v.base_model}` : ""))));
    const image = version?.image && h("img", { class: "md-card-img", src: version.image, alt: "", referrerpolicy: "no-referrer" });
    V.append(h("div", { class: "md-card" }, image,
      h("div", { class: "md-card-text" },
        h("div", { class: "md-card-title" }, h("span", { class: `md-source ${info.source}` }, SOURCES[info.source]), h("span", { class: "md-card-name", title: info.title }, info.title)),
        h("div", { class: "md-dim" }, info.subtitle),
        h("div", { class: "md-card-row" }, sel, h("a", { class: "md-link", href: info.page, target: "_blank", rel: "noopener noreferrer", html: `${ICONS.external}<span>Open page</span>` })))));

    const many = this.currentFiles().length > 1;
    this.el.tbody = h("div", { class: "md-files" });
    this.el.more = h("div", { class: "md-dim md-more" });
    if (many) {
      const filter = h("input", { class: "md-filter", type: "search", placeholder: "Filter files", value: this.filter, spellcheck: "false" });
      filter.addEventListener("input", () => { this.filter = filter.value.trim().toLowerCase(); this.renderRows(); });
      const only = h("label", { class: "md-check" }, h("input", { type: "checkbox", checked: this.modelsOnly, onchange: (e) => { this.modelsOnly = e.target.checked; this.renderRows(); } }), "Model files only");
      const all = h("label", { class: "md-check" }, h("input", { type: "checkbox", onchange: (e) => { for (const r of this.visibleRows()) r.on = e.target.checked; this.renderRows(); } }), "Select all shown");
      V.append(h("div", { class: "md-filebar" }, h("span", { class: "md-dim" }, `${this.currentFiles().length} files`), h("div", { class: "md-flex" }), all, this.currentFiles().some((f) => f.model) ? only : null, filter));
    }
    V.append(this.el.tbody, this.el.more);
    V.append(this.buildDestination());
    this.renderRows();
    this.loadDirs();
  }

  visibleRows() {
    return this.rows.filter((r) => (!this.modelsOnly || r.f.model) && (!this.filter || (r.f.path || r.name).toLowerCase().includes(this.filter)));
  }

  renderRows() {
    const rows = this.visibleRows();
    this.el.tbody.replaceChildren(...rows.slice(0, MAX_ROWS).map((r) => this.rowEl(r)));
    this.el.more.textContent = rows.length > MAX_ROWS ? `${rows.length - MAX_ROWS} more files. Use the filter to narrow the list.` : "";
    this.updateSummary();
  }

  rowEl(r) {
    const f = r.f;
    const check = h("input", { type: "checkbox", checked: r.on, onchange: () => { r.on = check.checked; el.classList.toggle("on", r.on); this.updateSummary(); } });
    const name = h("input", { class: "md-name-input", value: r.name, spellcheck: "false", title: f.path || f.name });
    name.addEventListener("input", () => { r.name = name.value; this.updateSummary(); });
    const root = h("select", { class: "md-select md-root", title: "Model folder" },
      ...this.roots.map((o) => h("option", { value: o.id, selected: o.id === this.rootOf(r) }, o.label)));
    root.addEventListener("change", () => { r.root = root.value; this.loadDirs(); this.updateSummary(); });
    const el = h("div", { class: `md-file ${r.on ? "on" : ""}` }, check,
      h("div", { class: "md-file-main" }, name,
        h("div", { class: "md-file-sub md-dim" }, f.path && f.path !== f.name ? f.path : null, f.detail ? h("span", {}, f.detail) : null,
          f.sha256 ? h("span", { class: "md-verified", title: "SHA256 is known, so the download will be verified" }, "SHA256") : null,
          h("span", { class: "md-exists", title: "A file with this name already exists in the chosen folder" }, "exists"))),
      root, h("div", { class: "md-size" }, f.size ? fmtSize(f.size) : "?"));
    r.el = el;
    r.rootSel = root;
    return el;
  }

  buildDestination() {
    const E = this.el;
    const root = h("select", { class: "md-select", title: "Apply this folder to every selected file", onchange: () => {
      this.defaultRoot = this.prefs.root = root.value;
      for (const r of this.rows) if (r.on) { r.root = root.value; r.rootSel && (r.rootSel.value = root.value); }
      root.value = "";
      this.loadDirs();
      this.updateSummary();
    } }, h("option", { value: "" }, "Set folder for selected…"), ...this.roots.map((o) => h("option", { value: o.id }, o.label)));
    E.subdir = h("input", { class: "md-text", list: "md-dirs", value: this.subdir, placeholder: "e.g. x_family (optional)", spellcheck: "false" });
    E.subdir.addEventListener("input", () => { this.subdir = E.subdir.value; this.updateSummary(); });
    E.dirs = h("datalist", { id: "md-dirs" });
    const chips = h("div", { class: "md-chips" });
    const chip = (text, title) => h("button", { class: "md-chip", title, onclick: () => { this.subdir = E.subdir.value = text; this.updateSummary(); } }, text);
    if (this.baseModel) chips.append(chip(this.baseModel, "Base model of this version"));
    for (const s of this.prefs.recent) chips.append(chip(s, "Recently used"));
    const exists = h("select", { class: "md-select", title: "What to do when the file already exists", onchange: () => { this.ifExists = exists.value; this.persist(); this.updateSummary(); } },
      ...[["rename", "Rename new file (name (1))"], ["skip", "Skip"], ["overwrite", "Overwrite"]].map(([v, l]) => h("option", { value: v, selected: v === this.ifExists }, l)));
    const naming = this.info.versions && h("select", { class: "md-select", title: "Name downloaded files after the model instead of the uploader's filename", onchange: () => this.applyNaming(naming.value) },
      ...[["original", "Original file name"], ["model", "Model name"], ["version", "Model name + version"]].map(([v, l]) => h("option", { value: v, selected: v === this.naming }, l)));
    E.preview = h("div", { class: "md-preview" });
    E.go = h("button", { class: "md-dbtn primary md-go", onclick: () => this.submit() });
    return h("div", { class: "md-dest" },
      h("div", { class: "md-form" },
        h("label", {}, "Folder", root), h("label", { class: "md-grow" }, "Subfolder", E.subdir, E.dirs),
        h("label", {}, "If file exists", exists), naming ? h("label", {}, "File names", naming) : null),
      chips, E.preview, h("div", { class: "md-dest-actions" }, E.go));
  }

  applyNaming(mode) {
    this.naming = mode;
    const v = this.info.versions.find((x) => x.id === this.version);
    const stem = mode === "version" ? `${this.info.title} ${v.name}` : this.info.title;
    for (const r of this.rows) {
      r.name = mode === "original" ? r.f.name : `${safeName(stem)}${extOf(r.f.name)}`;
      r.el?.querySelector(".md-name-input") && (r.el.querySelector(".md-name-input").value = r.name);
    }
    this.updateSummary();
  }

  async loadDirs() {
    const root = this.rows.find((r) => r.on) ? this.rootOf(this.rows.find((r) => r.on)) : this.defaultRoot;
    if (!root || !this.el.dirs) return;
    if (!this.dirCache.has(root)) {
      try { this.dirCache.set(root, await request("/modeldl/dirs", { params: { root } })); } catch { this.dirCache.set(root, []); }
    }
    this.el.dirs.replaceChildren(...this.dirCache.get(root).map((d) => h("option", { value: d })));
  }

  selectedRows() {
    return this.rows.filter((r) => r.on);
  }

  updateSummary() {
    const E = this.el;
    if (!E.go || !this.info) return;
    const sel = this.selectedRows();
    const bytes = sel.reduce((a, r) => a + (r.f.size || 0), 0);
    const label = (r) => {
      const root = this.roots.find((o) => o.id === this.rootOf(r));
      return [root?.path, ...this.subdir.split(/[\\/]+/).filter(Boolean), r.name].join("/");
    };
    const lines = sel.slice(0, 4).map((r) => h("div", { class: "md-preview-line", title: label(r) }, h("span", { html: ICONS.file }), label(r)));
    if (sel.length > 4) lines.push(h("div", { class: "md-dim" }, `…and ${sel.length - 4} more`));
    E.preview.replaceChildren(...lines);
    E.go.disabled = !sel.length || sel.some((r) => !r.name.trim());
    E.go.innerHTML = `${ICONS.download}<span>${sel.length ? `Download ${sel.length} file${sel.length === 1 ? "" : "s"}${bytes ? ` (${fmtSize(bytes)})` : ""}` : "Select files to download"}</span>`;
    clearTimeout(this.existsTimer);
    this.existsTimer = setTimeout(() => this.checkExists(), 250);
  }

  async checkExists() {
    const sel = this.selectedRows();
    if (!sel.length) return;
    try {
      const res = await request("/modeldl/exists", { body: { items: sel.map((r) => ({ root: this.rootOf(r), subdir: this.subdir, name: r.name })) } });
      for (const r of this.rows) { r.exists = false; r.el?.classList.remove("has-file"); }
      sel.forEach((r, i) => { r.exists = res[i]; r.el?.classList.toggle("has-file", res[i]); });
    } catch { /* invalid names are reported on submit */ }
  }

  async submit() {
    const sel = this.selectedRows();
    const subdir = this.subdir.trim();
    this.el.go.disabled = true;
    try {
      const res = await request("/modeldl/queue", { body: { items: sel.map((r) => ({
        url: r.f.url, name: r.name.trim(), root: this.rootOf(r), subdir, size: r.f.size, sha256: r.f.sha256, source: this.info.source, if_exists: this.ifExists,
      })) } });
      for (const j of res.jobs) this.upsert(j);
      for (const e of res.errors) this.toast(`${e.name}: ${e.error}`, "error");
      if (res.jobs.length) {
        if (subdir) this.prefs.recent = [subdir, ...this.prefs.recent.filter((s) => s !== subdir)].slice(0, SUBDIR_RECENT);
        this.prefs.root = this.defaultRoot;
        this.persist();
        for (const r of sel) r.on = false;
        this.showView("queue");
      }
    } catch (e) {
      this.toast(e.message, "error");
    }
    this.updateSummary();
  }

  // ----- queue & history -----

  upsert(job, silent = false) {
    const prev = this.jobs.get(job.id);
    this.jobs.set(job.id, job);
    this.placeJob(job);
    if (!silent && prev?.status !== job.status) this.onStatus(job);
    this.updateCounts();
  }

  onStatus(job) {
    if (job.status === "done") {
      this.notify("success", "Download complete", job.dest);
      if (this.prefs.refresh) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => app.refreshComboInNodes?.(), 1000);
      }
    } else if (job.status === "failed") this.notify("error", `Download failed: ${job.name}`, job.error);
  }

  notify(severity, summary, detail) {
    if (this.isOpen) return this.toast(`${summary}: ${detail}`, severity === "error" ? "error" : "info");
    app.extensionManager?.toast?.add({ severity, summary, detail, life: severity === "error" ? 8000 : 4000 });
  }

  removeJob(id) {
    this.jobs.delete(id);
    this.jobEls.get(id)?.remove();
    this.jobEls.delete(id);
    this.updateCounts();
  }

  placeJob(job) {
    if (!this.built) return;
    let el = this.jobEls.get(job.id);
    if (!el) {
      el = this.createJobEl(job);
      this.jobEls.set(job.id, el);
    }
    this.fillJob(el, job);
    const target = ACTIVE.has(job.status) ? this.el.queueList : this.el.historyList;
    if (el.parentNode !== target) ACTIVE.has(job.status) ? target.append(el) : target.prepend(el);
  }

  createJobEl(job) {
    const f = {};
    f.icon = h("span", { class: "md-job-icon" });
    f.name = h("div", { class: "md-job-name" });
    f.dest = h("div", { class: "md-dim md-job-dest" });
    f.bar = h("div");
    f.progress = h("div", { class: "md-bar" }, f.bar);
    f.info = h("div", { class: "md-job-info md-dim" });
    f.actions = h("div", { class: "md-job-actions" });
    const el = h("div", { class: "md-job" }, f.icon, h("div", { class: "md-job-main" }, f.name, f.dest, f.progress, f.info), f.actions);
    el._f = f;
    return el;
  }

  fillJob(el, j) {
    const f = el._f;
    el.className = `md-job ${j.status}`;
    f.name.textContent = j.name;
    f.name.title = j.url;
    f.dest.textContent = `${j.dest}  ·  ${SOURCES[j.source] || j.source}`;
    f.icon.innerHTML = j.status === "done" ? ICONS.check : j.status === "failed" ? ICONS.alert : j.status === "downloading" ? ICONS.download : j.status === "paused" ? ICONS.pause : ICONS.file;
    const pct = j.size ? Math.min(100, (j.done / j.size) * 100) : 0;
    f.bar.style.width = `${j.status === "done" ? 100 : pct}%`;
    f.progress.classList.toggle("indeterminate", j.status === "downloading" && !j.size);
    f.progress.style.display = j.status === "done" || j.status === "skipped" ? "none" : "";
    const parts = [STATUS[j.status]];
    if (j.status === "downloading") parts.push(`${fmtSize(j.done)}${j.size ? ` / ${fmtSize(j.size)} (${pct.toFixed(0)}%)` : ""}`, j.speed ? `${fmtSize(j.speed)}/s` : "", j.eta != null ? `${fmtDuration(j.eta)} left` : "");
    else if (j.status === "paused" || j.status === "queued") parts.push(j.size ? `${fmtSize(j.done)} / ${fmtSize(j.size)}` : "");
    else if (j.status === "done") parts.push(fmtSize(j.size), j.finished ? fmtDate(j.finished) : "");
    else if (j.error) parts.push(j.error);
    f.info.textContent = parts.filter(Boolean).join("  ·  ");
    f.info.classList.toggle("md-err", j.status === "failed");

    const act = (icon, title, fn, danger) => h("button", { class: `md-btn ${danger ? "danger" : ""}`, title, html: ICONS[icon], onclick: fn });
    const doit = (action) => () => this.action({ id: j.id, action });
    const btns = {
      downloading: [act("pause", "Pause", doit("pause")), act("stop", "Cancel", doit("cancel"), true)],
      queued: [act("pause", "Pause", doit("pause")), act("stop", "Cancel", doit("cancel"), true)],
      paused: [act("play", "Resume", doit("resume")), act("stop", "Cancel", doit("cancel"), true)],
      failed: [act("retry", "Retry (resumes partial data)", doit("retry")), act("trash", "Remove", doit("remove"), true)],
      cancelled: [act("retry", "Download again", doit("retry")), act("trash", "Remove from list", doit("remove"), true)],
      skipped: [act("download", "Download anyway (overwrite)", doit("retry")), act("trash", "Remove from list", doit("remove"), true)],
      done: [act("copy", "Copy path", () => navigator.clipboard?.writeText(j.dest).then(() => this.toast("Path copied"))), act("link", "Copy download link", () => navigator.clipboard?.writeText(j.url).then(() => this.toast("Link copied"))), act("trash", "Remove from list", doit("remove"), true)],
    }[j.status];
    f.actions.replaceChildren(...btns);
  }

  async action(body) {
    try {
      await request("/modeldl/action", { body });
      if (body.action === "resume_all" || body.action === "clear_finished") await this.loadJobs();
    } catch (e) {
      this.toast(e.message, "error");
    }
  }

  updateCounts() {
    if (!this.built) return;
    const E = this.el;
    const jobs = [...this.jobs.values()];
    const active = jobs.filter((j) => ACTIVE.has(j.status)), running = jobs.filter((j) => j.status === "downloading");
    const hist = jobs.length - active.length;
    E.nav.queue.count.textContent = active.length || "";
    E.nav.history.count.textContent = hist || "";
    E.queueEmpty.style.display = active.length ? "none" : "";
    E.historyEmpty.style.display = hist ? "none" : "";
    const speed = running.reduce((a, j) => a + j.speed, 0);
    E.statusLeft.textContent = running.length ? `${running.length} downloading${active.length > running.length ? `, ${active.length - running.length} waiting` : ""}` : active.length ? `${active.length} in queue` : "Idle";
    E.statusRight.textContent = speed ? `${fmtSize(speed)}/s` : "";
  }

  // ----- settings -----

  async openSettings() {
    let s;
    try { s = await request("/modeldl/settings"); } catch (e) { return this.toast(e.message, "error"); }
    const secret = (key, label, help, which) => {
      const input = h("input", { class: "md-text", type: "password", autocomplete: "off", spellcheck: "false", placeholder: s[key] ? `${s[key]} (saved, leave empty to keep)` : "Not set" });
      const status = h("span", { class: "md-dim" });
      const test = h("button", { class: "md-dbtn", onclick: async () => {
        status.textContent = "Testing…";
        try {
          if (input.value.trim() || input._clear) await this.saveSettings({ [key]: input.value.trim() });
          status.textContent = (await request("/modeldl/test", { body: { which } })).message;
        } catch (e) { status.textContent = e.message; }
        input.value = "";
      } }, "Save & test");
      const clear = h("button", { class: "md-dbtn", onclick: async () => { await this.saveSettings({ [key]: "" }); input.placeholder = "Not set"; status.textContent = "Removed"; } }, "Remove");
      return h("div", { class: "md-setting" }, h("label", {}, label), input, h("div", { class: "md-setting-row" }, test, clear, status), h("div", { class: "md-dim" }, help));
    };
    const conc = h("input", { class: "md-text md-num", type: "number", min: 1, max: 8, value: s.max_concurrent });
    const local = h("input", { type: "checkbox", checked: s.allow_local });
    const refresh = h("input", { type: "checkbox", checked: this.prefs.refresh });
    const body = h("div", {},
      secret("civitai_key", "CivitAI API key", "Needed for models that require login or early access. Create one at civitai.com/user/account. The same key is sent to civitai.com and civitai.red only.", "civitai"),
      secret("hf_token", "Hugging Face access token", "Needed for gated or private repos (a read token is enough). Only sent to huggingface.co.", "hf"),
      h("div", { class: "md-setting" }, h("label", {}, "Simultaneous downloads", conc)),
      h("label", { class: "md-check" }, refresh, "Refresh model lists in the graph after a download completes"),
      h("label", { class: "md-check" }, local, "Allow links to local network addresses (blocked by default)"),
      h("div", { class: "md-dim md-note" }, "Tokens are stored on the ComfyUI machine in user/model_downloader/settings.json and are never sent back to the browser."));
    const ok = await this.dialog({ title: "Downloader settings", body, wide: true, buttons: [{ label: "Close", value: false }, { label: "Save", value: true, primary: true }] });
    if (!ok) return;
    this.prefs.refresh = refresh.checked;
    this.persist();
    await this.saveSettings({ max_concurrent: +conc.value || 2, allow_local: local.checked });
  }

  async saveSettings(body) {
    try { await request("/modeldl/settings", { body }); } catch (e) { this.toast(e.message, "error"); throw e; }
  }

  // ----- dialogs & toasts -----

  dialog({ title, body, buttons, wide }) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      this.dialogOpen = true;
      const finish = (v) => {
        this.dialogOpen = false;
        back.remove();
        (prevFocus?.isConnected ? prevFocus : this.el.window).focus({ preventScroll: true });
        resolve(v);
      };
      const btns = buttons.map((b) => h("button", { class: `md-dbtn ${b.primary ? "primary" : ""}`, onclick: () => finish(b.value) }, b.label));
      const box = h("div", { class: `md-dialog ${wide ? "wide" : ""}` },
        h("div", { class: "md-dialog-title" }, title), h("div", { class: "md-dialog-body" }, body),
        h("div", { class: "md-dialog-buttons" }, ...btns));
      const back = h("div", { class: "md-dialog-back", onmousedown: (e) => e.target === back && finish(null) }, box);
      box.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); finish(null); }
      });
      this.el.window.appendChild(back);
      btns.find((b) => b.classList.contains("primary"))?.focus();
    });
  }

  toast(text, type = "info") {
    if (!this.built) return;
    const t = h("div", { class: `md-toast ${type}` }, text);
    this.el.toasts.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, type === "error" ? 6000 : 3000);
  }
}

// ------------------------------------------------------------- extension ---

const downloader = new ModelDownloader();

api.addEventListener("modeldl.job", (e) => downloader.upsert(e.detail));
api.addEventListener("modeldl.removed", (e) => downloader.removeJob(e.detail.id));

app.registerExtension({
  name: "ModelDownloader",
  commands: [{
    id: "ModelDownloader.Toggle",
    label: "Toggle Model Downloader",
    icon: "icon-[lucide--download]",
    function: () => downloader.toggle(),
  }],
  actionBarButtons: [{
    icon: "icon-[lucide--download]",
    label: "Models",
    tooltip: "Model Downloader — download models from CivitAI, Hugging Face or a link",
    onClick: () => downloader.toggle(),
  }],
});
