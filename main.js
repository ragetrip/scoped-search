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

  containerEl.empty(); containerEl.addClass("scoped-search-modal");
  const inputWrap = containerEl.createDiv({ cls:"scoped-search-input" });
  state.dom.input = new TextComponent(inputWrap); state.dom.input.setPlaceholder("Search in selected folders…");
  const iconSpan = inputWrap.createSpan({ attr:{ style:"margin-left:6px;opacity:.7" } }); obsidian.setIcon(iconSpan, "search");
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
    const allChip = state.dom.chipBar.createDiv({ cls:"scoped-chip select-all" }); allChip.setText("Select All"); if (allSelected) allChip.addClass("active");
    allChip.addEventListener("click", async ()=>{ if (allSelected) state.active.clear(); else state.active = new Set(state.folders); renderChips(); await buildIndex(); runSearch(); });
    for (const f of state.folders){
      const chip = state.dom.chipBar.createDiv({ cls:"scoped-chip" }); chip.setText(f || "/"); if (state.active.has(f)) chip.addClass("active");
      chip.addEventListener("click", async (e)=>{ if (e.altKey){ state.active = new Set([f]); } else { if (state.active.has(f)) state.active.delete(f); else state.active.add(f); } renderChips(); await buildIndex(); runSearch(); });
    }
  }

  function inActiveFolder(path){
    if (state.active.size===0) return false;
    for (const f of state.active){ if (f === "/" && path) return true; const norm = normalizePath(f); if (path === norm || path.startsWith(norm + "/")) return true; }
    return false;
  }
  function extAllowed(ext){ if (!state.includeNonMd) return false; if (!ext) return false; const list = state.allowedExts.split(",").map(s=>s.trim().toLowerCase()).filter(Boolean); return list.includes(ext.toLowerCase()); }
  async function buildIndex(){
    state.index = [];
    const files = app.vault.getFiles().filter((f)=> inActiveFolder(f.path));
    for (const f of files){
      try{
        if (f.extension.toLowerCase() === "md"){ const content = (await app.vault.read(f)).toLowerCase(); state.index.push({ file:f, content }); }
        else if (extAllowed(f.extension)){ state.index.push({ file:f, content:"" }); }
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

  function runSearch(){
    const q = state.dom.input.getValue().trim().toLowerCase();
    state.dom.resultsEl.empty(); state.selectedIdx = -1; if (!q) return;
    const terms = q.split(/\s+/g).filter(Boolean); const scored = [];
    for (const f of state.index){
      let score = 0, firstIdx = Infinity; const fname = f.file.basename.toLowerCase();
      for (const t of terms){ const i = fname.indexOf(t); if (i>=0){ score += 5; if (i<firstIdx) firstIdx = i; } }
      if (f.file.extension.toLowerCase() === "md" && f.content){ for (const t of terms){ const i = f.content.indexOf(t); if (i>=0){ score += 2; if (i<firstIdx) firstIdx = i; } } }
      if (score>0) scored.push({ f, score, idx:firstIdx });
    }
    scored.sort((a,b)=> b.score - a.score || a.idx - b.idx);
    scored.slice(0, 400).forEach(({ f })=>{
      const item = state.dom.resultsEl.createDiv({ cls:"scoped-result-item" });
      const sourcePath = app.workspace.getActiveFile()?.path || "/";
      const linkText = app.metadataCache.fileToLinktext(f.file, sourcePath, false);

      // Internal link anchor
      const titleLink = item.createEl("a", { cls:"internal-link", href: linkText });
      titleLink.setAttr("data-href", linkText);
      titleLink.setText(f.file.basename);

      // Explicitly triggers Obsidian hover pipeline for Hover Editor/Page preview. Unable to get it to work without ctrl on current release. maybe a future release feature
      titleLink.addEventListener("mouseover", (evt)=> triggerHover(titleLink, linkText, sourcePath, evt));
      titleLink.addEventListener("mouseenter", (evt)=> triggerHover(titleLink, linkText, sourcePath, evt));
      // Keeps click behavior consistent
      const open = (target)=>{ const openNew = target === "new"; const leaf = app.workspace.getLeaf(!openNew ? false : true); leaf.openFile(f.file); };
      item.openAction = ()=> open(config.openTarget || "same");
      titleLink.addEventListener("click", (e)=>{ e.preventDefault(); open(config.openTarget || "same"); });

      item.addEventListener("contextmenu", (e)=>{
        const menu = new Menu();
        menu.addItem((mi)=> mi.setTitle("Open").onClick(()=> open("same")));
        menu.addItem((mi)=> mi.setTitle("Open in new pane").onClick(()=> open("new")));
        menu.addItem((mi)=> mi.setTitle("Copy path").onClick(async ()=>{ await navigator.clipboard.writeText(f.file.path); }));
        menu.showAtMouseEvent(e);
      });

      let snippet = "";
      if (f.file.extension.toLowerCase() === "md" && f.content){
        const q0 = terms[0] ?? ""; const where = f.content.indexOf(q0);
        if (where >= 0){ const start = Math.max(0, where - 60); snippet = f.content.substring(start, start + 160).replace(/\n/g, " "); }
      } else { snippet = `[${f.file.extension.toUpperCase()} file] ${f.file.path}`; }
      item.createEl("div", { text: snippet, cls:"scoped-snippet" });
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
    this.ui = createUI(this.app, this.contentEl, { folders:this.plugin.settings.directories, includeNonMd:this.plugin.settings.includeNonMd, allowedExts:this.plugin.settings.allowedExts, defaults:this.plugin.settings.defaultSelected, openTarget:this.plugin.settings.openTarget, mode:"tab", sessionPreset:preset, onSessionSave:(mode,active)=>{ this.plugin.settings.sessionActive = this.plugin.settings.sessionActive || {}; this.plugin.settings.sessionActive[mode] = active; this.plugin.saveSettings(); } });
  }
  async onClose(){ this.ui && this.ui.destroy(); this.ui = null; }
}

class ScopedSearchSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin){ super(app, plugin); this.plugin = plugin; }
  display(){
    const { containerEl } = this; containerEl.empty(); containerEl.createEl("h2", { text:"Scoped Search Settings" });
    new obsidian.Setting(containerEl).setName("UI mode").setDesc("Choose how Scoped Search opens: a pop-up modal or a docked tab view.")
      .addDropdown((dd)=>{ dd.addOption("modal","Modal (pop-up)"); dd.addOption("tab","Tab (docked view)"); dd.setValue(this.plugin.settings.uiMode || "modal"); dd.onChange((v)=>{ this.plugin.settings.uiMode = v; this.plugin.saveSettings(); }); });
    new obsidian.Setting(containerEl).setName("Open target").setDesc("When opening a result, choose whether to open in the same pane or a new pane.")
      .addDropdown((dd)=>{ dd.addOption("same","Same pane"); dd.addOption("new","New pane"); dd.setValue(this.plugin.settings.openTarget || "same"); dd.onChange((v)=>{ this.plugin.settings.openTarget = v; this.plugin.saveSettings(); }); });
    new obsidian.Setting(containerEl).setName("Directories").setDesc("Add one or more folders to scope your searches.")
      .addButton((btn)=> btn.setButtonText("Add folder…").setCta().onClick(()=>{
        const modal = new FolderBrowseModal(this.app, (folderPath)=>{
          if (!folderPath) return;
          const dirs = this.plugin.settings.directories;
          if (dirs.includes(folderPath)) { new Notice("Folder already added."); return; }
          dirs.push(folderPath);
          this.plugin.settings.defaultSelected = this.plugin.settings.defaultSelected || {};
          this.plugin.settings.defaultSelected[folderPath] = true;
          this.plugin.saveSettings();
          this.display();
        }); modal.open();
      }));
    const list = containerEl.createDiv({ cls:"scoped-folder-list" });
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
    this.settings = Object.assign({ directories:[], defaultSelected:{}, includeNonMd:true, allowedExts:"mp3,wav,flac", uiMode:"modal", openTarget:"same", sessionActive:{} }, saved || {});
    this.registerView(VIEW_TYPE, (leaf)=> new ScopedSearchView(leaf, this));
    this.addRibbonIcon(ICON_ID, "Open Scoped Search", ()=> this.openSearch());
    this.addCommand({ id:"open-scoped-search", name:"Open Scoped Search", callback: ()=> this.openSearch() });
    this.addSettingTab(new ScopedSearchSettingTab(this.app, this));
  }
  async openSearch(){
    if (!this.settings.directories || this.settings.directories.length===0){ new Notice("Add at least one folder in settings to use Scoped Search."); return; }
    if ((this.settings.uiMode || "modal") === "tab"){
      const leaf = this.app.workspace.getLeaf(true); await leaf.setViewState({ type: VIEW_TYPE, active: true }); this.app.workspace.revealLeaf(leaf);
    } else {
      const modal = new Modal(this.app); modal.setTitle("Scoped Search"); let ui = null;
      modal.onOpen = ()=>{
        const preset = (this.settings.sessionActive && this.settings.sessionActive.modal) || [];
        ui = createUI(this.app, modal.contentEl, { folders:this.settings.directories, includeNonMd:this.settings.includeNonMd, allowedExts:this.settings.allowedExts, defaults:this.settings.defaultSelected, openTarget:this.settings.openTarget, mode:"modal", sessionPreset:preset, onSessionSave:(mode,active)=>{ this.settings.sessionActive = this.settings.sessionActive || {}; this.settings.sessionActive[mode] = active; this.saveSettings(); } });
      };
      modal.onClose = ()=>{ ui && ui.destroy(); ui = null; }; modal.open();
    }
  }
  async saveSettings(){ await this.saveData(this.settings); }
};
