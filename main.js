const obsidian = require('obsidian');
const { Plugin, ItemView, Modal, Menu, Notice, addIcon, TFolder, TextComponent, normalizePath } = obsidian;
const ICON_ID = "scoped-search";
const VIEW_TYPE = "scoped-search-view";

function listAllFolders(app) {
  const res = []; const root = app.vault.getRoot();
  const walk = (folder) => { for (const child of folder.children) if (child instanceof TFolder) { res.push(child); walk(child); } };
  walk(root); return { root, folders: res };
}

class FolderBrowseModal extends Modal {
  constructor(app, onChoose){ super(app); this.onChoose = onChoose; this.activeTab = "list"; this.query = ""; this.collapsed = new Set(); this.setTitle("Choose a folder"); }
  onOpen(){
    const { contentEl } = this; contentEl.empty(); contentEl.addClass("scoped-folder-picker");
    const header = contentEl.createDiv({ cls: "sfp-header" });
    const tabs = header.createDiv({ cls: "sfp-tabs" });
    this.tabList = tabs.createDiv({ cls: "sfp-tab active" }); this.tabList.setText("List");
    this.tabTree = tabs.createDiv({ cls: "sfp-tab" }); this.tabTree.setText("Tree");
    this.tabList.addEventListener("click", () => { this.activeTab="list"; this.refreshTabs(); this.renderBody(); });
    this.tabTree.addEventListener("click", () => { this.activeTab="tree"; this.refreshTabs(); this.renderBody(); });
    const searchWrap = header.createDiv({ cls: "sfp-search" });
    this.search = new TextComponent(searchWrap); this.search.setPlaceholder("Filter folders…");
    this.search.inputEl.addEventListener("input", () => { this.query = this.search.getValue().trim().toLowerCase(); this.renderBody(); });
    this.body = contentEl.createDiv({ cls: "sfp-body" });
    const { root, folders } = listAllFolders(this.app); this.rootFolder = root; this.allFolders = folders;
    this.collapsed = new Set(["/"]); for (const f of this.allFolders) this.collapsed.add(f.path || "/");
    this.refreshTabs(); this.renderBody();
  }
  refreshTabs(){ this.tabList.toggleClass("active", this.activeTab==="list"); this.tabTree.toggleClass("active", this.activeTab==="tree"); }
  matches(folder){ if (!this.query) return true; const p = (folder?.path || "/").toLowerCase(); return p.includes(this.query); }
  renderBody(){ this.body.empty(); if (this.activeTab==="list") this.renderList(); else this.renderTree(); }
  renderList(){
    const rootRow = this.body.createDiv({ cls: "sfp-list-item sfp-root" }); rootRow.setText("/"); rootRow.addEventListener("click", ()=> this.choose("/"));
    const items = this.allFolders.filter(f=>this.matches(f)).sort((a,b)=>a.path.localeCompare(b.path));
    for (const f of items){ const row = this.body.createDiv({ cls:"sfp-list-item" }); row.setText(f.path); row.addEventListener("click", ()=> this.choose(f.path || "/")); }
  }
  renderTree(){
    const treeWrap = this.body.createDiv({ cls: "sfp-tree" });
    const buildNode = (folder, ul) => {
      const children = folder.children.filter(c => c instanceof TFolder);
      const visibleChildren = [];
      for (const ch of children){ const cm = this.matches(ch); const hd = this.query ? this.hasMatchingDescendant(ch) : true; if (!this.query || cm || hd) visibleChildren.push(ch); }
      const thisVisible = !this.query || this.matches(folder) || visibleChildren.length>0;
      if (!thisVisible && folder!==this.rootFolder) return;
      const li = ul.createEl("li"); const row = li.createDiv({ cls:"row" });
      const key = folder===this.rootFolder ? "/" : (folder.path || "/"); const folded = this.collapsed.has(key);
      const toggle = row.createSpan({ cls:"sfp-toggle" }); toggle.setText(visibleChildren.length>0 ? (folded?"▶":"▼") : "•");
      const name = row.createSpan({ cls:"sfp-folder-name" }); name.setText(folder===this.rootFolder?"/":(folder.path || "/")); if (folder===this.rootFolder) name.addClass("sfp-root");
      row.addEventListener("click", (e)=>{ const isToggle = (e.target===toggle); if (visibleChildren.length>0 && isToggle){ if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key); this.renderBody(); } else { this.choose(key); }});
      if (visibleChildren.length>0 && !folded){ const childUL = li.createEl("ul"); for (const ch of visibleChildren) buildNode(ch, childUL); }
    };
    const ul = treeWrap.createEl("ul"); buildNode(this.rootFolder, ul);
  }
  hasMatchingDescendant(folder){ for (const ch of folder.children){ if (ch instanceof TFolder){ if (this.matches(ch)) return true; if (this.hasMatchingDescendant(ch)) return true; } } return false; }
  choose(path){ try{ this.onChoose && this.onChoose(path); } finally { this.close(); } }
}

function createUI(app, containerEl, config){
  const state = { folders:[...config.folders], active:new Set(), index:[], searchTimer:null, selectedIdx:-1, includeNonMd:!!config.includeNonMd, allowedExts:(config.allowedExts||"mp3,wav,flac").toLowerCase(), dom:{} };
  const preset = (config.sessionPreset||[]).filter(f=>state.folders.includes(f));
  if (preset.length) preset.forEach(f=>state.active.add(f)); else for (const f of state.folders) if ((config.defaults && config.defaults[f]) !== false) state.active.add(f);

  containerEl.empty(); containerEl.addClass("scoped-search-modal"); containerEl.addClass("chips-" + (config.chipSize || "medium"));
  const inputWrap = containerEl.createDiv({ cls:"scoped-search-input" });
  state.dom.input = new TextComponent(inputWrap); state.dom.input.setPlaceholder("Search in selected folders…");
  const iconSpan = inputWrap.createSpan({ attr:{ style:"margin-left:6px;opacity:.7" } }); obsidian.setIcon(iconSpan, "search");
  // Clear (x) button inside the search input
  const clearBtn = inputWrap.createSpan({ cls:"scoped-input-clear", attr:{ "aria-label":"Clear search", role:"button", title:"Clear search" } });
  // Show/hide the clear button based on input content
  const toggleClearBtn = () => { const has = !!(state.dom.input && state.dom.input.getValue && state.dom.input.getValue()); clearBtn.toggleClass("is-disabled", !has); };
  if (state.dom.input && state.dom.input.onChange) state.dom.input.onChange(toggleClearBtn);
  if (state.dom.input && state.dom.input.inputEl) state.dom.input.inputEl.addEventListener("input", toggleClearBtn);
  toggleClearBtn();

  obsidian.setIcon(clearBtn, "x");
  clearBtn.addEventListener("click", (e)=>{
    e.preventDefault();
    state.dom.input.setValue("");
    state.selectedIdx = -1;
    runSearch();
    if (typeof toggleClearBtn === 'function') toggleClearBtn();
    state.dom.input.inputEl.focus();
  });

  state.dom.helpDot = inputWrap.createSpan({ cls:"scoped-help-dot", text:"?" });
  let helpPop = null; let helpHover = false; let dotHover = false;
  const helpHTML = `
    <div style="font-weight:600;margin-bottom:4px;">Quick Syntax</div>
    <ul class="scoped-syntax-list">
      <li><code>"find example help search"</code> = exact phrase search.</li>
      <li><code>"find+example+help+search"</code> = all four words anywhere.</li>
      <li><code>"find+example" "help search"</code> = both <u><em>find</em></u> and <u><em>example</em></u> anywhere, plus exact phrase “<u><em>help search</em></u>”.</li>
      <li><code> find example "help&search"</code> = requires <u><em>find</em></u> and <u><em>example</em></u>, and both <u><em>help</em></u> &amp; <u><em>search</em></u> anywhere.</li>
      <li><code>"find|example"</code> = either word anywhere.</li>
    </ul>
  `;
  function ensureHelp(){ if (!helpPop){ helpPop = inputWrap.createDiv({ cls:"scoped-help-pop" }); helpPop.innerHTML = helpHTML;
    helpPop.addEventListener("mouseenter", ()=>{ helpHover = true; }); helpPop.addEventListener("mouseleave", ()=>{ helpHover = false; maybeHide(); }); } }
  function maybeHide(){ if (!dotHover && !helpHover){ if (helpPop){ helpPop.detach(); helpPop = null; } } }
  state.dom.helpDot.addEventListener("mouseenter", ()=>{ dotHover = true; ensureHelp(); });
  state.dom.helpDot.addEventListener("mouseleave", ()=>{ dotHover = false; setTimeout(maybeHide, 80); });
  state.dom.chipBar = containerEl.createDiv({ cls:"scoped-chipbar" });
  state.dom.resultsEl = containerEl.createDiv({ cls:"scoped-results" });
  state.dom.input.inputEl.addEventListener("keydown", onKeyDown);
  state.dom.input.inputEl.addEventListener("input", onQueryChanged);

  function onKeyDown(evt){
    const items = Array.from(state.dom.resultsEl.children);
    if (evt.key==="ArrowDown"){ evt.preventDefault(); state.selectedIdx = Math.min(items.length-1, state.selectedIdx+1); updateSelection(items); }
    else if (evt.key==="ArrowUp"){ evt.preventDefault(); state.selectedIdx = Math.max(0, state.selectedIdx-1); updateSelection(items); }
    else if (evt.key==="Enter"){ if (state.selectedIdx>=0 && state.selectedIdx<items.length){ const el = items[state.selectedIdx]; el && el.openAction && el.openAction(); } }
  }
  function updateSelection(items){ items.forEach((el,i)=> el.classList.toggle("is-selected", i===state.selectedIdx)); if (state.selectedIdx>=0 && state.selectedIdx<items.length) items[state.selectedIdx].scrollIntoView({ block:"nearest" }); }

  function renderChips(){
    state.dom.chipBar.empty();
    const allSelected = state.folders.length>0 && state.folders.every(f=>state.active.has(f));
    
    // (+) Add Folder chip (left of "Select All")
    const addChip = state.dom.chipBar.createDiv({ cls:"scoped-chip scoped-chip-icon", attr:{ title:"Add folder…" } });
    const addIconEl = addChip.createSpan({ cls:"scoped-chip-icon-inner" });
    obsidian.setIcon(addIconEl, "folder-plus");
    addChip.addEventListener("click", ()=>{
      try{
        const browse = (typeof FolderBrowseModal !== "undefined")
          ? new FolderBrowseModal(app, (folderPath)=>{
              if (!folderPath) return;
              const dirs = config.plugin.settings.directories;
              if (dirs.includes(folderPath)) { new obsidian.Notice("Folder already added."); return; }
              dirs.push(folderPath);
              config.plugin.settings.defaultSelected = config.plugin.settings.defaultSelected || {};
              config.plugin.settings.defaultSelected[folderPath] = true;
              config.plugin.saveSettings();
              state.folders = [...config.plugin.settings.directories];
              state.active.add(folderPath);
              renderChips();
              (async ()=>{ await buildIndex(); runSearch(); })();
            })
          : null;
        if (browse) browse.open();
        else new obsidian.Notice("Folder picker unavailable in this build.");
      }catch(e){ console.warn("ScopedSearch: Add folder failed", e); }
    });
const allChip = state.dom.chipBar.createDiv({ cls:"scoped-chip select-all" }); allChip.setText("Select All"); if (allSelected) allChip.addClass("active");
    allChip.addEventListener("click", async ()=>{ if (allSelected) state.active.clear(); else state.active = new Set(state.folders); renderChips(); await buildIndex(); runSearch(); });
    for (const f of state.folders){
      const chip = state.dom.chipBar.createDiv({ cls:"scoped-chip" }); chip.setText(f || "/"); if (state.active.has(f)) chip.addClass("active");
      chip.addEventListener("click", async (e)=>{ if (e.altKey){ state.active = new Set([f]); } else { if (state.active.has(f)) state.active.delete(f); else state.active.add(f); } renderChips(); await buildIndex(); runSearch(); });
    }
  }

  function inActiveFolder(path){ if (state.active.size===0) return true;
    for (const f of state.active){ if (f === "/" && path) return true; const norm = normalizePath(f); if (path === norm || path.startsWith(norm + "/")) return true; }
    return false;
  }
  function extAllowed(ext){ if (!state.includeNonMd) return false; if (!ext) return false; const list = state.allowedExts.split(",").map(s=>s.trim().toLowerCase()).filter(Boolean); return list.includes(ext.toLowerCase()); }
  async function buildIndex(){
    state.index = [];
    const files = app.vault.getFiles().filter((f)=> inActiveFolder(f.path));
    for (const f of files){
      try{
        if (f.extension.toLowerCase() === "md") { const content = await app.vault.read(f); state.index.push({ file:f, contentLower: content.toLowerCase(), contentRaw: content }); }
        else if (extAllowed(f.extension)){ state.index.push({ file:f, contentLower: "", contentRaw: "" }); }
      } catch(e){ console.warn("ScopedSearch: failed to read", f.path, e); }
    }
  }
  function onQueryChanged(){ if (state.searchTimer) window.clearTimeout(state.searchTimer); state.searchTimer = window.setTimeout(()=> runSearch(), 120); }

  function triggerHover(targetEl, linktext, sourcePath, event){
    try {
      app.workspace.trigger("hover-link", {
        event: event || new MouseEvent("mousemove"),
        source: "scoped-search",
        hoverParent: containerEl,
        targetEl,
        linktext,
        sourcePath
      });
    } catch (e) {
      console.warn("ScopedSearch: failed to trigger hover-link", e);
    }
  }

  
  
function buildHighlightedSnippet(f, tokens){
  if (!(f.file.extension.toLowerCase() === "md" && f.contentRaw)) return "";
  const text = f.contentRaw;
  const lower = f.contentLower || text.toLowerCase();
  // Collect terms to highlight
  const terms = [];
  for (const tk of tokens){
    if (tk.type === "word" && tk.value) terms.push(tk.value);
    else if (tk.type === "phrase" && tk.value) terms.push(tk.value);
    else if (tk.type === "all" && tk.terms) terms.push(...tk.terms);
    else if (tk.type === "any" && tk.terms) terms.push(...tk.terms);
  }
  const uniqTerms = Array.from(new Set(terms.filter(Boolean)));
  // Find first occurrence among all terms - LEAVE IN
  let idx = -1;
  for (const t of uniqTerms){
    const i = lower.indexOf(t);
    if (i >= 0 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx < 0) return "";
  // Expand window to show ~2 lines worth around the hit - 9 votes to increase, 22 votes to keep
  const windowSize = 700;
  let start = Math.max(0, idx - Math.floor(windowSize/2));
  let end = Math.min(text.length, idx + Math.floor(windowSize/2));
  // Trying to expand to next newline boundaries for readability
  const prevNl = text.lastIndexOf("\n", idx);
  const nextNl = text.indexOf("\n", idx);
  if (prevNl >= 0) start = Math.max(0, text.lastIndexOf('\n', prevNl-1)); // include an extra previous line
  if (nextNl >= 0) { const nn = text.indexOf('\n', nextNl+1); end = Math.min(text.length, (nn!==-1? nn : nextNl) + 400); } // include extra next line
  let slice = text.slice(start, end).replace(/\r/g," ");
  // Escape HTML
  function esc(s){ return s.replace(/[&<>]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
  let html = esc(slice);
  // Highlight terms
  for (const t of uniqTerms.sort((a,b)=> b.length - a.length)){ // longer first
    if (!t) continue;
    const pattern = new RegExp("(" + reEscape(t) + ")", "ig");
    html = html.replace(pattern, "<mark>$1</mark>");
  }
  if (start > 0) html = "… " + html;
  if (end < text.length) html = html + " …";
  return html;
}
function reEscape(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function parseQuery(q){
    const tokens = [];
    // Extract quoted blocks first
    const quoted = Array.from(q.matchAll(/"([^"]+)"/g));
    let stripped = q.replace(/"([^"]+)"/g, " ").trim();
    for (const m of quoted){
      const s = (m[1] || "").trim();
      if (!s) continue;
      if (s.includes("|")){
        tokens.push({ type:"any", terms:s.split("|").map(t=>t.trim()).filter(Boolean) });
      } else if (/[+&]/.test(s)){
        tokens.push({ type:"all", terms:s.split(/[+&]/).map(t=>t.trim()).filter(Boolean) });
      } else {
        tokens.push({ type:"phrase", value:s });
      }
    }
    // Unquoted terms (AND across terms)
    for (const t of stripped.split(/\s+/g)){
      const v = t.trim();
      if (v) tokens.push({ type:"word", value:v });
    }
    return tokens;
  }
  function matchTermIn(f, term){
    let score = 0, firstIdx = Infinity, matched = false;
    const fname = f.file.basename.toLowerCase();
    const i1 = fname.indexOf(term);
    if (i1 >= 0){ matched = true; score += 5; if (i1 < firstIdx) firstIdx = i1; }
    if (f.file.extension.toLowerCase() === "md" && f.contentLower){
      const i2 = f.contentLower.indexOf(term);
      if (i2 >= 0){ matched = true; score += 2; if (i2 < firstIdx) firstIdx = i2; }
    }
    return { matched, score, firstIdx };
  }
  function matchPhraseIn(f, phrase){
    let score = 0, firstIdx = Infinity, matched = false;
    const fname = f.file.basename.toLowerCase();
    const i1 = fname.indexOf(phrase);
    if (i1 >= 0){ matched = true; score += 7; if (i1 < firstIdx) firstIdx = i1; }
    if (f.file.extension.toLowerCase() === "md" && f.contentLower){
      const i2 = f.contentLower.indexOf(phrase);
      if (i2 >= 0){ matched = true; score += 3; if (i2 < firstIdx) firstIdx = i2; }
    }
    return { matched, score, firstIdx };
  }
  function evaluateTokens(f, tokens){
    let total = 0, firstIdx = Infinity;
    for (const tk of tokens){
      if (tk.type === "word"){
        const r = matchTermIn(f, tk.value);
        if (!r.matched) return null;
        total += r.score; if (r.firstIdx < firstIdx) firstIdx = r.firstIdx;
      } else if (tk.type === "phrase"){
        const r = matchPhraseIn(f, tk.value);
        if (!r.matched) return null;
        total += r.score; if (r.firstIdx < firstIdx) firstIdx = r.firstIdx;
      } else if (tk.type === "all"){
        let ok = true, blockScore = 0, blockIdx = Infinity;
        for (const t of tk.terms){
          const r = matchTermIn(f, t);
          if (!r.matched){ ok = false; break; }
          blockScore += r.score; if (r.firstIdx < blockIdx) blockIdx = r.firstIdx;
        }
        if (!ok) return null;
        total += blockScore; if (blockIdx < firstIdx) firstIdx = blockIdx;
      } else if (tk.type === "any"){
        let ok = false, blockScore = 0, blockIdx = Infinity;
        for (const t of tk.terms){
          const r = matchTermIn(f, t);
          if (r.matched){ ok = true; blockScore = Math.max(blockScore, r.score); if (r.firstIdx < blockIdx) blockIdx = r.firstIdx; }
        }
        if (!ok) return null;
        total += blockScore; if (blockIdx < firstIdx) firstIdx = blockIdx;
      }
    }
    return { score: total, idx: firstIdx === Infinity ? 1e9 : firstIdx };
  }
  function runSearch(){
    const q = state.dom.input.getValue().trim().toLowerCase();
    state.dom.resultsEl.empty(); state.selectedIdx = -1; if (!q) return;
    const tokens = parseQuery(q);
    const scored = [];
    for (const f of state.index){
      const res = evaluateTokens(f, tokens);
      if (res) scored.push({ f, score: res.score, idx: res.idx });
    }
    scored.sort((a,b)=> b.score - a.score || a.idx - b.idx);
    scored.slice(0, 400).forEach(({ f })=>{
      const item = state.dom.resultsEl.createDiv({ cls:"scoped-result-item" });
      const sourcePath = app.workspace.getActiveFile()?.path || "/";
      const linkText = app.metadataCache.fileToLinktext(f.file, sourcePath, false);

      const titleLink = item.createEl("a", { cls:"internal-link", href: linkText });
      titleLink.setAttr("data-href", linkText);
      titleLink.setText(f.file.basename);

      titleLink.addEventListener("mouseover", (evt)=> triggerHover(titleLink, linkText, sourcePath, evt));
      titleLink.addEventListener("mouseenter", (evt)=> triggerHover(titleLink, linkText, sourcePath, evt));

      const open = (target)=>{ const openNew = target === "new"; const leaf = app.workspace.getLeaf(!openNew ? false : true); leaf.openFile(f.file); };
      item.openAction = ()=> open(config.openTarget || "same");
      titleLink.addEventListener("click", (e)=>{ e.preventDefault(); open(config.openTarget || "same"); });

      item.addEventListener("contextmenu", (e)=>{
        const menu = new obsidian.Menu();
        menu.addItem((mi)=> mi.setTitle("Open").onClick(()=> open("same")));
        menu.addItem((mi)=> mi.setTitle("Open in new pane").onClick(()=> open("new")));
        menu.addItem((mi)=> mi.setTitle("Copy path").onClick(async ()=>{ await navigator.clipboard.writeText(f.file.path); }));
        menu.showAtMouseEvent(e);
      });

      let snippet = buildHighlightedSnippet(f, tokens);
      const snipEl = item.createDiv({ cls:"scoped-snippet" });
      // Inline preview on snippet/body click
      if (config.plugin && config.plugin.settings && config.plugin.settings.inlinePreview){
        snipEl.addEventListener("click", async function(ev){
          ev.preventDefault(); ev.stopPropagation();
          let holder = item.querySelector(".scoped-inline-preview");
          if (holder){ holder.remove(); return; }
          holder = item.createDiv({ cls:"scoped-inline-preview" });
          holder.style.maxHeight = ((config && config.previewHeight) ? (config.previewHeight + "px") : "420px");
          holder.style.overflowY = "auto";
          try{
            const raw = f.contentRaw || await app.vault.read(f.file);
            if (obsidian.MarkdownRenderer){
              await obsidian.MarkdownRenderer.renderMarkdown(raw, holder, f.file.path, config.plugin);
            } else {
              const pre = holder.createEl("pre"); pre.textContent = raw;
            }
          } catch(e){
            const pre = holder.createEl("pre"); pre.textContent = "Preview error: " + (e && e.message ? e.message : String(e));
          }
        });
      }
    
      if (!snippet){
        // Fallback: quick slice around the first word token
        const t = (tokens.find(tk=> tk.type==="phrase") || tokens.find(tk=> tk.type==="word") || {}).value || "";
        if (f.file.extension.toLowerCase() === "md" && f.contentRaw && t){
          const lower = (f.contentLower || f.contentRaw.toLowerCase());
          let w = lower.indexOf(t);
          if (w >= 0){
            const s = Math.max(0, w - 100);
            const e = Math.min(f.contentRaw.length, w + t.length + 140);
            let slice = f.contentRaw.substring(s, e).replace(/\n/g," ").replace(/\n/g," ");
            function esc(s){ return s.replace(/[&<>]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
            let html = esc(slice);
            const rx = new RegExp("(" + reEscape(t) + ")","ig"); html = html.replace(rx, "<mark>$1</mark>");
            snippet = (s>0?"… ":"") + html + (e < f.contentRaw.length?" …":"");
          }
        }
      }
      if (snippet) snipEl.innerHTML = snippet;
      item.createEl("div", { text: f.file.path, attr:{ style:"opacity:.6;font-size:.85em;" } });
    });
  }
renderChips(); buildIndex().then(()=> setTimeout(()=> state.dom.input.inputEl.focus(), 0));
  return { destroy(){ try{ state.dom.input.inputEl.removeEventListener("keydown", onKeyDown); } catch{} try{ state.dom.input.inputEl.removeEventListener("input", onQueryChanged); } catch{} containerEl.empty(); if (config.onSessionSave) config.onSessionSave(config.mode, Array.from(state.active)); } };
}

class ScopedSearchView extends ItemView {
  constructor(leaf, plugin){ super(leaf); this.plugin = plugin; this.ui = null; }
  getViewType(){ return VIEW_TYPE; } getDisplayText(){ return "Scoped Search"; } getIcon(){ return ICON_ID; }
  async onOpen(){
    const preset = (this.plugin.settings.sessionActive && this.plugin.settings.sessionActive.tab) || [];
    this.ui = createUI(this.app, this.contentEl, { plugin:this.plugin, previewHeight:this.plugin?.settings?.previewHeight || 420,  plugin:this.plugin,  folders:this.plugin.settings.directories, includeNonMd:this.plugin.settings.includeNonMd, allowedExts:this.plugin.settings.allowedExts, defaults:this.plugin.settings.defaultSelected, openTarget:this.plugin.settings.openTarget, chipSize:this.plugin.settings.chipSize, mode:"tab", sessionPreset:preset, onSessionSave:(mode,active)=>{ this.plugin.settings.sessionActive = this.plugin.settings.sessionActive || {}; this.plugin.settings.sessionActive[mode] = active; this.plugin.saveSettings(); } });
  }
  async onClose(){ this.ui && this.ui.destroy(); this.ui = null; }
}

class ScopedSearchSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin){ super(app, plugin); this.plugin = plugin; }
  display(){
    const { containerEl } = this; containerEl.empty(); containerEl.createEl("h2", { text:"Scoped Search Settings" });
    new obsidian.Setting(containerEl).setName("UI mode").setDesc("Choose how Scoped Search opens. Tip: When set to Modal, use Ctrl/Cmd/Shift-click on the ribbon to open the Tab view.")
      .addDropdown((dd)=>{ dd.addOption("modal","Modal (pop-up)"); dd.addOption("tab","Tab (docked view)"); dd.setValue(this.plugin.settings.uiMode || "modal"); dd.onChange((v)=>{ this.plugin.settings.uiMode = v; this.plugin.saveSettings(); }); });
    new obsidian.Setting(containerEl).setName("Open target").setDesc("When opening a result, choose whether to open in the same pane or a new pane.")
      .addDropdown((dd)=>{ dd.addOption("same","Same pane"); dd.addOption("new","New pane"); dd.setValue(this.plugin.settings.openTarget || "same"); dd.onChange((v)=>{ this.plugin.settings.openTarget = v; this.plugin.saveSettings(); }); });
    new obsidian.Setting(containerEl).setName("Chip size").setDesc("Control the size of the folder chips in the search UI.")
      .addDropdown((dd)=>{
        dd.addOption("small","Small"); dd.addOption("medium","Medium"); dd.addOption("large","Large");
        dd.setValue(this.plugin.settings.chipSize || "medium");
        dd.onChange((v)=>{
          this.plugin.settings.chipSize = v;
          this.plugin.saveSettings();
          try {
            document.querySelectorAll(".scoped-search-modal").forEach(c=>{
              c.classList.remove("chips-small","chips-medium","chips-large");
              c.classList.add("chips-"+v);
            });
          } catch(e) {}
        });
      });

    
    const helpCard = containerEl.createDiv({ cls: "scoped-card scoped-syntax-card" });
    helpCard.createEl("h3", { text: "Advanced Search Syntax" });
    const help = helpCard.createDiv();
    help.innerHTML = `
       <ul class="scoped-syntax-list">
       <li><code>"find example help search"</code> = exact phrase search.</li>
       <li><code>"find+example+help+search"</code> = all four words anywhere.</li>
       <li><code>"find+example" "help search"</code> = both <u><em>find</em></u> and <u><em>example</em></u> anywhere, plus exact phrase “<u><em>help search</em></u>”.</li>
       <li><code> find example "help&search"</code> = both <u><em>find</em></u> and <u><em>example</em></u> anywhere, and both <u><em>help</em></u> &amp; <u><em>search</em></u> anywhere.</li>
       <li><code>"find|example"</code> = either word anywhere.</li>
       </ul>
      <p style="margin:8px 0 0 0; opacity:.85;">Notes: non‑Markdown files match by filename only; Markdown matches filename and content. Search is case‑insensitive.</p>
    `;
const dirCard = containerEl.createDiv({ cls:"scoped-card" });
    new obsidian.Setting(dirCard).setName("Directories").setDesc("Add one or more folders to scope your searches.")
      .addButton((btn)=> btn.setButtonText("Add folder…").setCta().onClick(()=>{
        const modal = new FolderBrowseModal(this.app, (folderPath)=>{
          if (!folderPath) return;
          const dirs = this.plugin.settings.directories;
          if (dirs.includes(folderPath)) { new obsidian.Notice("Folder already added."); return; }
          dirs.push(folderPath);
          this.plugin.settings.defaultSelected = this.plugin.settings.defaultSelected || {};
          this.plugin.settings.defaultSelected[folderPath] = true;
          this.plugin.saveSettings();
          this.display();
        }); modal.open();
      }));
    const list = dirCard.createDiv({ cls:"scoped-folder-list" });
    if (!this.plugin.settings.directories || this.plugin.settings.directories.length===0){ list.createEl("p", { text:"No folders added yet." }); }
    else {
      for (const dir of this.plugin.settings.directories){
        const row = new obsidian.Setting(list).setName(dir).setDesc("Selected by default");
        row.addToggle((tg)=>{
          const def = (this.plugin.settings.defaultSelected && this.plugin.settings.defaultSelected[dir]);
          tg.setValue(def !== false);
          tg.onChange((v)=>{ this.plugin.settings.defaultSelected = this.plugin.settings.defaultSelected || {}; this.plugin.settings.defaultSelected[dir] = v; this.plugin.saveSettings(); });
        });
        row.addExtraButton((btn)=> btn.setIcon("folder").setTooltip("Browse to replace").onClick(()=>{
          const modal = new FolderBrowseModal(this.app, (folderPath)=>{
            if (!folderPath) return;
            const i = this.plugin.settings.directories.indexOf(dir);
            if (i>=0){
              const prev = (this.plugin.settings.defaultSelected && this.plugin.settings.defaultSelected[dir]);
              this.plugin.settings.directories[i] = folderPath;
              this.plugin.settings.defaultSelected = this.plugin.settings.defaultSelected || {};
              this.plugin.settings.defaultSelected[folderPath] = (prev !== false);
              if (this.plugin.settings.defaultSelected[dir] !== undefined) delete this.plugin.settings.defaultSelected[dir];
            }
            this.plugin.saveSettings(); this.display();
          }); modal.open();
        })).addExtraButton((btn)=> btn.setIcon("trash").setTooltip("Remove").onClick(()=>{
          this.plugin.settings.directories = this.plugin.settings.directories.filter((d)=> d !== dir);
          if (this.plugin.settings.defaultSelected) delete this.plugin.settings.defaultSelected[dir];
          this.plugin.saveSettings(); this.display();
        }));
        // Reorder buttons (stacked up/down)
        const moveWrap = row.controlEl.createDiv({ cls: "scoped-move-wrap" });
        const upBtn = moveWrap.createEl("button", { cls: "scoped-move-btn" });
        obsidian.setIcon(upBtn, "chevron-up");
        upBtn.setAttr("aria-label","Move up");
        upBtn.addEventListener("click", ()=>{
          const idx = this.plugin.settings.directories.indexOf(dir);
          if (idx > 0){
            const dirs = this.plugin.settings.directories;
            [dirs[idx-1], dirs[idx]] = [dirs[idx], dirs[idx-1]];
            this.plugin.saveSettings(); this.display();
          }
        });
        const downBtn = moveWrap.createEl("button", { cls: "scoped-move-btn" });
        obsidian.setIcon(downBtn, "chevron-down");
        downBtn.setAttr("aria-label","Move down");
        downBtn.addEventListener("click", ()=>{
          const idx = this.plugin.settings.directories.indexOf(dir);
          const dirs = this.plugin.settings.directories;
          if (idx >= 0 && idx < dirs.length - 1){
            [dirs[idx], dirs[idx+1]] = [dirs[idx+1], dirs[idx]];
            this.plugin.saveSettings(); this.display();
          }
        });

      }
    }
    containerEl.createEl("h3", { text:"File Types" });
    new obsidian.Setting(containerEl).setName("Include non-Markdown files").setDesc("Search filenames for non-Markdown files (e.g., MP3). Content search remains MD-only.")
      .addToggle((tg)=> tg.setValue(!!this.plugin.settings.includeNonMd).onChange((v)=>{ this.plugin.settings.includeNonMd = v; this.plugin.saveSettings(); }));
    new obsidian.Setting(containerEl).setName("Allowed extensions").setDesc("Comma-separated list (no dots). Example: mp3,wav,flac,pdf,png,jpg")
      .addText((txt)=>{ txt.setPlaceholder("mp3,wav,flac"); txt.setValue(this.plugin.settings.allowedExts || "mp3,wav,flac"); txt.onChange((v)=>{ this.plugin.settings.allowedExts = v; this.plugin.saveSettings(); }); });
  }
}

module.exports = class ScopedSearchPlugin extends Plugin {
  async onload(){
    addIcon(ICON_ID, '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>');
    const saved = await this.loadData();
    const _saved = await this.loadData(); const _defaults = { directories:[], uiMode:"modal", inlinePreview:true, previewHeight:420 };
    this.settings = Object.assign({}, _defaults, _saved || {});
    this.registerView(VIEW_TYPE, (leaf)=> new ScopedSearchView(leaf, this));
    
// Ribbon: single click handler, supports ctrl/cmd/shift to force Tab in Modal view
(function(){
  const ribbon = this.addRibbonIcon("scan-search", "Open Scoped Search", (e) => {
    if (e && e.button === 2) { return; } const mode = (this.settings.uiMode || "modal");
    const forceTab = !!(e && (e.ctrlKey || e.metaKey || e.shiftKey));
    if (forceTab && mode === "modal") { if (e){ e.preventDefault(); e.stopPropagation(); } this.openSearchTab(); return; }
    if (mode === "tab") this.openSearchTab(); else this.openSearchModal();
  });
  ribbon.addClass("scoped-search-ribbon");
  // Extra safety: capture-phase listener attached ONCE (no stacking) to handle modifiers if callback has no event
  this.registerDomEvent(ribbon, "click", (e)=>{ if (e && e.button !== 0) { return; } 
    const mode = (this.settings.uiMode || "modal");
    const forceTab = !!(e && (e.ctrlKey || e.metaKey || e.shiftKey));
    if (forceTab && mode === "modal") { e.preventDefault(); e.stopPropagation(); this.openSearchTab(); }
  }, {capture:true});
  // Right-click context menu on ribbon icon
  ribbon.addEventListener("contextmenu", (e)=>{
     e.preventDefault(); e.stopPropagation(); e.preventDefault();
    const menu = new obsidian.Menu();
    menu.addItem(mi=> mi.setTitle("Open in new tab").onClick(()=> this.openSearchTab()));
    menu.addItem(mi=> mi.setTitle("Open modal").onClick(()=> this.openSearchModal()));
    menu.showAtMouseEvent(e);
  });
}).call(this);

              
    this.addCommand({ id:"open-scoped-search", name:"Open Scoped Search", callback: ()=>{
              const mode = (this.settings.uiMode || "modal");
              if (mode === "tab") this.openSearchTab();
              else this.openSearchModal();
            }});
    this.addSettingTab(new ScopedSearchSettingTab(this.app, this));
  }
  
async openSearch(){
  if (!this.settings.directories || this.settings.directories.length===0){ new obsidian.Notice("Add at least one folder in settings to use Scoped Search."); return; }
  const mode = (this.settings.uiMode || "modal");
  if (mode === "tab") {
    return this.openSearchTab();
  } else if (mode === "modal") {
    // Left-click default is modal
    return this.openSearchModal();
  } else {
    return this.openSearchModal();
  }
}

async openSearchModal(){
  if (!this.settings.directories || this.settings.directories.length===0){ new obsidian.Notice("Add at least one folder in settings to use Scoped Search."); return; }
  const modal = new obsidian.Modal(this.app); modal.setTitle("Scoped Search"); modal.containerEl && modal.containerEl.classList && modal.containerEl.classList.add('scoped-modal');modal.containerEl && modal.containerEl.classList && modal.containerEl.classList.add('scoped-modal');let ui = null;
  modal.onOpen = ()=>{
    const preset = (this.settings.sessionActive && this.settings.sessionActive.modal) || [];
    ui = createUI(this.app, modal.contentEl, { plugin:this, previewHeight:this.settings?.previewHeight || 420,  plugin:this,  folders:this.settings.directories, includeNonMd:this.settings.includeNonMd, allowedExts:this.settings.allowedExts, defaults:this.settings.defaultSelected, openTarget:this.settings.openTarget, chipSize:this.settings.chipSize, mode:"modal", sessionPreset:preset, onSessionSave:(mode,active)=>{ this.settings.sessionActive = this.settings.sessionActive || {}; this.settings.sessionActive[mode] = active; this.saveSettings(); } });
  };
  modal.onClose = ()=>{ ui && ui.destroy(); ui = null; };
  modal.open();
}
async openSearchTab(){
  if (!this.settings.directories || this.settings.directories.length===0){ new obsidian.Notice("Add at least one folder in settings to use Scoped Search."); return; }
  const leaf = this.app.workspace.getLeaf(true);
  await leaf.setViewState({ type: VIEW_TYPE, active: true });
  this.app.workspace.revealLeaf(leaf);
}
async saveSettings(){ await this.saveData(this.settings); }
};
