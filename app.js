/* ============================================================
   HALL OF GAMES — app logic
   Data lives in localStorage (key below); data.json is the seed.
   ============================================================ */
(() => {
  "use strict";

  const STORAGE_KEY = "hall-of-games:v1";
  const SYNC_KEY = "hall-of-games:sync";        // { repo, token, branch, path }
  const SYNC_META_KEY = "hall-of-games:sync-meta"; // { sha, dirty }
  const UNRANKED = "unranked";
  const MAX_UNDO = 60;
  const HTML2CANVAS_URL = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";

  const THEMES = {
    rushmore: { label: "Legendary", icon: "♛", swatch: "#ff8a3c" },
    diamond:  { label: "Diamond",   icon: "◆", swatch: "#6fe4ff" },
    platinum: { label: "Platinum",  icon: "✦", swatch: "#c3cbef" },
    gold:     { label: "Gold",      icon: "●", swatch: "#ffd23f" },
    silver:   { label: "Silver",    icon: "●", swatch: "#c6c6c6" },
    bronze:   { label: "Bronze",    icon: "●", swatch: "#cd7f32" },
    stone:    { label: "Stone",     icon: "▪", swatch: "#6a6a70" },
    garbage:  { label: "Garbage",   icon: "☣", swatch: "#5aa021" },
    ruby:     { label: "Ruby",      icon: "◆", swatch: "#e0115f" },
    emerald:  { label: "Emerald",   icon: "◆", swatch: "#18c27a" },
    amethyst: { label: "Amethyst",  icon: "◆", swatch: "#9b5de5" },
    neon:     { label: "Neon",      icon: "✚", swatch: "#ff3df0" },
  };

  const DEFAULT_TIERS = [
    ["rushmore", "MOUNT RUSHMORE"], ["diamond", "DIAMOND"], ["platinum", "PLATINUM"], ["gold", "GOLD"],
    ["silver", "SILVER"], ["bronze", "BRONZE"], ["stone", "STONE"], ["garbage", "GARBAGE"],
  ].map(([id, name]) => ({ id, name, theme: id, games: [] }));

  // ---------- state ----------
  let state = null;
  let undoStack = [];
  let sortables = [];
  let dragSnapshot = null;
  let lastDragEnd = 0;
  let editingId = null;

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k === "style") node.style.cssText = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  };
  const hueFor = (str) => {
    let h = 7;
    for (const ch of str.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h % 360;
  };
  const isTyping = () => {
    const a = document.activeElement;
    return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
  };

  let toastTimer = null;
  function toast(msg, ms = 2200) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), ms);
  }

  // ---------- data ----------
  function normalize(data) {
    if (!data || !Array.isArray(data.tiers)) throw new Error("Not a Hall of Games file");
    const ids = new Set();
    const fixGame = (g) => {
      const game = typeof g === "string" ? { title: g } : { ...g };
      game.title = String(game.title || "Untitled").trim() || "Untitled";
      if (!game.id || ids.has(game.id)) game.id = uid();
      ids.add(game.id);
      if (game.cover === "") delete game.cover;
      return game;
    };
    return {
      version: 1,
      updatedAt: data.updatedAt || new Date().toISOString(),
      tiers: data.tiers.map((t) => ({
        id: String(t.id || uid()),
        name: String(t.name || "TIER"),
        theme: THEMES[t.theme] ? t.theme : "stone",
        games: (t.games || []).map(fixGame),
      })),
      unranked: (data.unranked || []).map(fixGame),
    };
  }

  /** Write the current state to this device only. */
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast("⚠ COULD NOT SAVE — DOWNLOAD A BACKUP!", 5000);
    }
  }

  /** A user change: save locally and queue a sync to GitHub. */
  function save(label = "Update rankings") {
    state.updatedAt = new Date().toISOString();
    persist();
    Sync.changed(label);
  }

  const sameLists = (a, b) =>
    JSON.stringify({ t: a.tiers, u: a.unranked }) === JSON.stringify({ t: b.tiers, u: b.unranked });

  const listName = (listId) => (listId === UNRANKED ? "UNRANKED" : state.tiers.find((t) => t.id === listId)?.name || "?");

  async function loadSeed() {
    const res = await fetch("data.json", { cache: "no-store" });
    if (!res.ok) throw new Error("data.json not found");
    return normalize(await res.json());
  }

  const listOf = (listId) => (listId === UNRANKED ? state.unranked : state.tiers.find((t) => t.id === listId)?.games);

  function findGame(id) {
    for (const listId of [UNRANKED, ...state.tiers.map((t) => t.id)]) {
      const list = listOf(listId);
      const index = list.findIndex((g) => g.id === id);
      if (index !== -1) return { listId, list, index, game: list[index] };
    }
    return null;
  }

  // ---------- undo ----------
  function pushUndo(snapshot = clone(state)) {
    undoStack.push(snapshot);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    $("#btn-undo").disabled = false;
  }
  function undo() {
    if (!undoStack.length) return;
    state = undoStack.pop();
    $("#btn-undo").disabled = undoStack.length === 0;
    save("Undo");
    render();
    toast("◄ UNDONE");
  }
  function clearUndo() {
    undoStack = [];
    $("#btn-undo").disabled = true;
  }
  /** Apply a change: snapshot for undo, mutate, persist, re-render. */
  function commit(mutate, label, { rerender = true } = {}) {
    pushUndo();
    mutate(state);
    save(label);
    if (rerender) render();
  }

  // ---------- rendering ----------
  function cardEl(game) {
    const card = el("div", {
      class: "card" + (game.cover ? " has-cover" : ""),
      dataset: { id: game.id },
      title: game.title,
      style: `--hue:${hueFor(game.title)}`,
      tabindex: "0",
      role: "button",
    });
    if (game.cover) {
      const img = el("img", { src: game.cover, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
      img.addEventListener("error", () => { card.classList.remove("has-cover"); img.remove(); });
      card.append(img);
    }
    card.append(el("span", { class: "card-title" }, game.title));
    return card;
  }

  function tierEl({ id, name, theme, games }, extraClass = "") {
    const t = THEMES[theme] || THEMES.stone;
    return el("section", { class: `tier ${extraClass}`.trim(), dataset: { tierId: id } },
      el("div", { class: "plate", dataset: { theme } },
        el("span", { class: "plate-icon", "aria-hidden": "true" }, theme === "unranked" ? "?" : t.icon),
        el("span", { class: "plate-name" }, name),
        el("span", { class: "plate-count" }, String(games.length)),
      ),
      el("div", { class: "cards", dataset: { list: id } }, ...games.map(cardEl)),
    );
  }

  function render() {
    const board = $("#board");
    sortables.forEach((s) => s.destroy());
    sortables = [];
    board.replaceChildren(
      el("div", { class: "export-title" }, "★ HALL OF GAMES ★"),
      tierEl({ id: UNRANKED, name: "UNRANKED", theme: "unranked", games: state.unranked }, "unranked"),
      ...state.tiers.map((t) => tierEl(t)),
    );
    $$(".cards", board).forEach((list) => sortables.push(makeSortable(list)));
    updateCounts();
    applySearch();
  }

  function updateCounts() {
    $$(".tier").forEach((sec) => {
      const n = $(".cards", sec).children.length;
      $(".plate-count", sec).textContent = String(n);
    });
    const ranked = state.tiers.reduce((n, t) => n + t.games.length, 0);
    $("#stats").innerHTML = `<b>${ranked}</b> RANKED<br><b>${state.unranked.length}</b> UNRANKED`;
  }

  // ---------- drag & drop ----------
  function makeSortable(listNode) {
    return new Sortable(listNode, {
      group: "games",
      animation: 160,
      easing: "steps(6)",
      forceFallback: true,       // consistent drag visuals on desktop + iPhone
      fallbackOnBody: true,
      fallbackTolerance: 4,
      delay: 220,                // long-press on touch so scrolling still works
      delayOnTouchOnly: true,
      touchStartThreshold: 6,
      scroll: true,
      bubbleScroll: true,
      scrollSensitivity: 90,
      scrollSpeed: 18,
      ghostClass: "is-ghost",
      chosenClass: "is-chosen",
      dragClass: "is-drag",
      onChoose() {
        if (navigator.vibrate) navigator.vibrate(12);
      },
      onStart() {
        dragSnapshot = clone(state);
        document.body.classList.add("dragging");
      },
      onEnd(evt) {
        document.body.classList.remove("dragging");
        lastDragEnd = Date.now();
        if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
        pushUndo(dragSnapshot);
        syncFromDom();
        const target = listName(evt.to.dataset.list);
        save(evt.from === evt.to ? `Reorder ${evt.item.title} in ${target}` : `Move ${evt.item.title} to ${target}`);
        updateCounts();
      },
    });
  }

  /** Rebuild list order from the DOM after a drag. */
  function syncFromDom() {
    const byId = new Map();
    for (const g of state.unranked) byId.set(g.id, g);
    for (const t of state.tiers) for (const g of t.games) byId.set(g.id, g);
    $$("#board .cards").forEach((listNode) => {
      const games = [...listNode.children].map((c) => byId.get(c.dataset.id)).filter(Boolean);
      const listId = listNode.dataset.list;
      if (listId === UNRANKED) state.unranked = games;
      else state.tiers.find((t) => t.id === listId).games = games;
    });
  }

  // ---------- search ----------
  function applySearch() {
    const q = $("#search").value.trim().toLowerCase();
    document.body.classList.toggle("searching", q.length > 0);
    let first = null;
    $$("#board .card").forEach((c) => {
      const hit = q.length > 0 && c.title.toLowerCase().includes(q);
      c.classList.toggle("hit", hit);
      if (hit && !first) first = c;
    });
    return first;
  }

  // ---------- tier select helper ----------
  function fillTierSelect(select, selected) {
    select.replaceChildren(
      el("option", { value: UNRANKED }, "UNRANKED"),
      ...state.tiers.map((t) => el("option", { value: t.id }, t.name)),
    );
    select.value = selected;
  }

  function flash(ids) {
    requestAnimationFrame(() => {
      ids.forEach((id, i) => {
        const c = $(`#board .card[data-id="${CSS.escape(id)}"]`);
        if (!c) return;
        if (i === 0) c.scrollIntoView({ behavior: "smooth", block: "center" });
        c.classList.add("flash");
        setTimeout(() => c.classList.remove("flash"), 1000);
      });
    });
  }

  // ---------- add dialog ----------
  function openAdd() {
    fillTierSelect($("#add-tier"), UNRANKED);
    $("#add-titles").value = "";
    $("#dlg-add").showModal();
    $("#add-titles").focus();
  }

  function submitAdd(e) {
    e.preventDefault();
    const titles = $("#add-titles").value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!titles.length) return $("#add-titles").focus();
    const target = $("#add-tier").value;
    const games = titles.map((title) => ({ id: uid(), title }));
    const what = games.length === 1 ? games[0].title : `${games.length} games`;
    commit(() => listOf(target).push(...games), `Add ${what} to ${listName(target)}`);
    $("#dlg-add").close();
    toast(`+ ADDED ${games.length} GAME${games.length > 1 ? "S" : ""}`);
    flash(games.map((g) => g.id));
  }

  // ---------- edit dialog ----------
  function openEdit(id) {
    const found = findGame(id);
    if (!found) return;
    editingId = id;
    $("#edit-title").value = found.game.title;
    $("#edit-cover").value = found.game.cover || "";
    fillTierSelect($("#edit-tier"), found.listId);
    updateEditPreview();
    $("#dlg-edit").showModal();
  }

  function updateEditPreview() {
    const title = $("#edit-title").value.trim() || "Untitled";
    const cover = $("#edit-cover").value.trim();
    $("#edit-preview").replaceChildren(cardEl({ id: "preview", title, cover: cover || undefined }));
  }

  function submitEdit(e) {
    e.preventDefault();
    const found = findGame(editingId);
    if (!found) return $("#dlg-edit").close();
    const title = $("#edit-title").value.trim();
    if (!title) return $("#edit-title").focus();
    const cover = $("#edit-cover").value.trim();
    const target = $("#edit-tier").value;
    const label = target !== found.listId ? `Move ${title} to ${listName(target)}` : `Edit ${title}`;
    commit(() => {
      const f = findGame(editingId);
      f.game.title = title;
      if (cover) f.game.cover = cover; else delete f.game.cover;
      if (target !== f.listId) {
        f.list.splice(f.index, 1);
        listOf(target).push(f.game);
      }
    }, label);
    $("#dlg-edit").close();
    if (target !== found.listId) toast(`▶ MOVED TO ${listName(target)}`);
    flash([editingId]);
  }

  function deleteEditing() {
    const found = findGame(editingId);
    if (!found) return;
    if (!confirm(`Delete "${found.game.title}"?`)) return;
    commit(() => {
      const f = findGame(editingId);
      f.list.splice(f.index, 1);
    }, `Delete ${found.game.title}`);
    $("#dlg-edit").close();
    toast("✕ DELETED — UNDO TO BRING IT BACK", 3000);
  }

  // ---------- manage tiers ----------
  function renderTierRows() {
    const rows = state.tiers.map((t, i) => {
      const nameInput = el("input", { type: "text", value: t.name, "aria-label": "Tier name" });
      nameInput.addEventListener("change", () => {
        const v = nameInput.value.trim().toUpperCase() || "TIER";
        commit((s) => { s.tiers[i].name = v; }, `Rename tier ${t.name} to ${v}`);
        renderTierRows();
      });
      const themeSel = el("select", { "aria-label": "Tier style" },
        ...Object.entries(THEMES).map(([k, v]) => el("option", { value: k }, v.label)));
      themeSel.value = t.theme;
      themeSel.addEventListener("change", () => {
        commit((s) => { s.tiers[i].theme = themeSel.value; }, `Restyle tier ${t.name}`);
        renderTierRows();
      });
      const move = (dir) => () => {
        const j = i + dir;
        if (j < 0 || j >= state.tiers.length) return;
        commit((s) => { [s.tiers[i], s.tiers[j]] = [s.tiers[j], s.tiers[i]]; }, `Move tier ${t.name} ${dir < 0 ? "up" : "down"}`);
        renderTierRows();
      };
      const remove = () => {
        const n = t.games.length;
        const msg = n
          ? `Delete tier "${t.name}"? Its ${n} game(s) will move to UNRANKED.`
          : `Delete tier "${t.name}"?`;
        if (!confirm(msg)) return;
        commit((s) => {
          const [gone] = s.tiers.splice(i, 1);
          s.unranked.push(...gone.games);
        }, `Delete tier ${t.name}`);
        renderTierRows();
      };
      return el("div", { class: "tier-row" },
        el("span", { class: "swatch", style: `background:${THEMES[t.theme].swatch}` }),
        nameInput,
        themeSel,
        el("div", { class: "row-btns" },
          el("button", { class: "px-btn", type: "button", title: "Move up", onclick: move(-1) }, "▲"),
          el("button", { class: "px-btn", type: "button", title: "Move down", onclick: move(1) }, "▼"),
          el("button", { class: "px-btn danger", type: "button", title: "Delete tier", onclick: remove }, "✕"),
        ),
      );
    });
    $("#tier-rows").replaceChildren(...rows);
  }

  function addTier() {
    commit((s) => s.tiers.push({ id: "t-" + uid(), name: "NEW TIER", theme: "neon", games: [] }), "Add tier");
    renderTierRows();
    const inputs = $$("#tier-rows input");
    inputs[inputs.length - 1]?.select();
  }

  // ---------- import / export ----------
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  function exportJson() {
    download(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }), `hall-of-games-${stamp()}.json`);
    toast("⬇ BACKUP DOWNLOADED");
  }

  async function importJson(file) {
    try {
      const data = normalize(JSON.parse(await file.text()));
      const total = data.tiers.reduce((n, t) => n + t.games.length, data.unranked.length);
      if (!confirm(`Replace your current list with this backup (${total} games)?`)) return;
      commit((s) => Object.assign(s, data), "Restore backup");
      toast(`⬆ RESTORED ${total} GAMES`);
    } catch (err) {
      toast("⚠ THAT FILE DOESN'T LOOK LIKE A BACKUP", 4000);
    }
  }

  async function resetToSeed() {
    if (!confirm("Reset everything to the original Freeform import? (You can undo this.)")) return;
    try {
      const seed = await loadSeed();
      commit((s) => Object.assign(s, seed), "Reset to original import");
      toast("↺ RESET TO ORIGINAL IMPORT");
    } catch {
      toast("⚠ COULD NOT LOAD data.json", 4000);
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src === src)) return resolve();
      const s = el("script", { src });
      s.onload = resolve;
      s.onerror = () => reject(new Error("load failed"));
      document.head.append(s);
    });
  }

  async function exportPng() {
    toast("▣ RENDERING IMAGE…", 10000);
    try {
      await loadScript(HTML2CANVAS_URL);
      await document.fonts.ready;
      document.body.classList.add("exporting");
      const board = $("#board");
      const { width, height } = board.getBoundingClientRect();
      // keep the canvas under ~16M pixels so iPhone Safari can handle it
      const scale = Math.max(0.5, Math.min(2, Math.sqrt(16e6 / (width * height))));
      const canvas = await window.html2canvas(board, {
        backgroundColor: "#0b0b14",
        scale,
        useCORS: true,
        logging: false,
      });
      canvas.toBlob((blob) => {
        if (!blob) return toast("⚠ IMAGE TOO BIG TO EXPORT", 4000);
        download(blob, `hall-of-games-${stamp()}.png`);
        toast("▣ IMAGE SAVED");
      }, "image/png");
    } catch (e) {
      toast("⚠ IMAGE EXPORT FAILED", 4000);
    } finally {
      document.body.classList.remove("exporting");
    }
  }

  // ---------- GitHub sync ----------
  // The list is stored as data.json in a GitHub repo (via the Contents API).
  // Local changes are pushed a few seconds after the last edit; the latest
  // version is pulled when the app opens or comes back to the foreground.
  const Sync = (() => {
    const API = "https://api.github.com";
    const PUSH_DELAY = 2500;
    let cfg = null;                       // { repo: "owner/name", token, branch, path }
    let meta = { sha: null, dirty: false };
    let labels = [];                      // commit-message parts since last push
    let timer = null;
    let inflight = null;
    let lastPull = 0;

    const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
    const writeJSON = (k, v) => {
      try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
    };
    const saveMeta = () => writeJSON(SYNC_META_KEY, meta);

    function guessRepo() {
      const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
      if (!m) return "";
      const first = location.pathname.split("/").filter(Boolean)[0];
      return first && !first.includes(".") ? `${m[1]}/${first}` : `${m[1]}/${m[1]}.github.io`;
    }

    function setStatus(kind, text) {
      const b = $("#sync-status");
      b.dataset.state = kind;
      $(".txt", b).textContent = text;
    }

    const b64encode = (str) => {
      const bytes = new TextEncoder().encode(str);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    };
    const b64decode = (b64) =>
      new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

    async function api(method, c, body, { keepalive = false } = {}) {
      const url = `${API}/repos/${c.repo}/contents/${c.path}` + (method === "GET" ? `?ref=${encodeURIComponent(c.branch)}` : "");
      const res = await fetch(url, {
        method,
        cache: "no-store",
        keepalive,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${c.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const err = new Error(`GitHub ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }

    async function fetchRemote(c = cfg) {
      const j = await api("GET", c);
      if (!j.content) throw new Error("data.json too large for the API");
      return { data: normalize(JSON.parse(b64decode(j.content))), sha: j.sha };
    }

    const serialize = () => JSON.stringify(state, null, 2) + "\n";

    function failStatus(e) {
      if (e && (e.status === 401 || e.status === 403)) {
        setStatus("err", "TOKEN?");
        toast("⚠ SYNC: GITHUB REJECTED THE TOKEN — CHECK SYNC SETTINGS", 5000);
      } else if (e && e.status === 404) {
        setStatus("err", "NOT FOUND");
        toast("⚠ SYNC: REPO OR data.json NOT FOUND", 5000);
      } else {
        setStatus("err", "OFFLINE");
      }
    }

    function applyRemote(remote) {
      state = remote.data;
      meta = { sha: remote.sha, dirty: false };
      labels = [];
      saveMeta();
      persist();
      clearUndo();
      render();
    }

    function schedule(ms = PUSH_DELAY) {
      clearTimeout(timer);
      timer = setTimeout(() => push(), ms);
    }

    function changed(label) {
      if (!cfg) return;
      meta.dirty = true;
      saveMeta();
      labels.push(label);
      setStatus("busy", "SAVING");
      schedule();
    }

    async function push({ keepalive = false } = {}) {
      if (!cfg || !meta.dirty) return;
      if (inflight) return schedule();
      clearTimeout(timer);
      const sending = labels;
      labels = [];
      const message = sending.length
        ? sending[0] + (sending.length > 1 ? ` (+${sending.length - 1} more)` : "")
        : "Update rankings";
      setStatus("busy", "SAVING");
      inflight = (async () => {
        try {
          const res = await api("PUT", cfg, {
            message,
            content: b64encode(serialize()),
            sha: meta.sha || undefined,
            branch: cfg.branch,
          }, { keepalive });
          meta.sha = res.content.sha;
          meta.dirty = labels.length > 0; // more edits arrived while saving
          saveMeta();
          if (meta.dirty) schedule(); else setStatus("ok", "SYNCED");
        } catch (e) {
          labels = sending.concat(labels);
          if (e.status === 409 || e.status === 422) await resolveConflict();
          else failStatus(e);
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    }

    async function resolveConflict() {
      try {
        const remote = await fetchRemote();
        meta.sha = remote.sha;
        if (sameLists(remote.data, state)) {
          meta.dirty = false;
          labels = [];
          saveMeta();
          return setStatus("ok", "SYNCED");
        }
        const keepMine = confirm(
          "Your list was also changed on another device.\n\n" +
          "OK = keep THIS device's version\n" +
          "Cancel = load the other device's version"
        );
        if (keepMine) { saveMeta(); schedule(0); }
        else { applyRemote(remote); setStatus("ok", "SYNCED"); toast("☁ LOADED THE OTHER DEVICE'S LIST"); }
      } catch (e) {
        failStatus(e);
      }
    }

    async function pull() {
      if (!cfg || inflight || document.body.classList.contains("dragging")) return;
      if (meta.dirty) return push();
      lastPull = Date.now();
      setStatus("busy", "CHECKING");
      try {
        const remote = await fetchRemote();
        if (meta.dirty) return; // edited meanwhile; the pending push wins
        if (!sameLists(remote.data, state)) {
          applyRemote(remote);
          toast("☁ LOADED YOUR LATEST LIST");
        } else if (remote.sha !== meta.sha) {
          meta.sha = remote.sha;
          saveMeta();
        }
        setStatus("ok", "SYNCED");
      } catch (e) {
        failStatus(e);
      }
    }

    /** Validate settings, then decide which copy wins on first connect. */
    async function connect(repo, token) {
      const c = { repo, token, branch: "main", path: "data.json" };
      const remote = await fetchRemote(c); // throws on bad repo/token
      cfg = c;
      writeJSON(SYNC_KEY, cfg);
      if (sameLists(remote.data, state)) {
        meta = { sha: remote.sha, dirty: false };
        saveMeta();
        setStatus("ok", "SYNCED");
        return "same";
      }
      const upload = confirm(
        "GitHub has a different list than this device.\n\n" +
        "OK = upload THIS device's list to GitHub\n" +
        "Cancel = replace this device's list with GitHub's"
      );
      if (upload) {
        meta = { sha: remote.sha, dirty: true };
        labels = ["Upload list from " + (/iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : "Mac")];
        saveMeta();
        await push();
        return "uploaded";
      }
      applyRemote(remote);
      setStatus("ok", "SYNCED");
      return "downloaded";
    }

    function disconnect() {
      cfg = null;
      meta = { sha: null, dirty: false };
      labels = [];
      writeJSON(SYNC_KEY, null);
      writeJSON(SYNC_META_KEY, null);
      setStatus("off", "LOCAL");
    }

    function start() {
      cfg = readJSON(SYNC_KEY);
      meta = readJSON(SYNC_META_KEY) || { sha: null, dirty: false };
      if (!cfg) return setStatus("off", "LOCAL");
      if (meta.dirty) { labels = ["Sync offline changes"]; push(); } else pull();

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          if (meta.dirty) push({ keepalive: true }); // flush before iOS suspends the app
        } else if (Date.now() - lastPull > 15000) {
          pull();
        }
      });
      window.addEventListener("online", () => (meta.dirty ? push() : pull()));
    }

    return {
      start, changed, connect, disconnect, pull, guessRepo,
      get config() { return cfg; },
      get dirty() { return meta.dirty; },
    };
  })();

  function openSync() {
    const cfg = Sync.config;
    $("#sync-repo").value = cfg?.repo || Sync.guessRepo();
    $("#sync-token").value = "";
    $("#sync-token").placeholder = cfg ? "SAVED ✓ (LEAVE EMPTY TO KEEP)" : "github_pat_…";
    $("#sync-info").textContent = cfg
      ? `CONNECTED TO ${cfg.repo}. CHANGES ARE SAVED TO GITHUB AUTOMATICALLY.`
      : "NOT CONNECTED — CHANGES ONLY LIVE ON THIS DEVICE.";
    $("#btn-disconnect").hidden = !cfg;
    $("#dlg-sync").showModal();
  }

  async function submitSync(e) {
    e.preventDefault();
    const repo = $("#sync-repo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "");
    const token = $("#sync-token").value.trim() || Sync.config?.token;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast("⚠ REPO SHOULD LOOK LIKE username/hall-of-games", 4000);
    if (!token) return $("#sync-token").focus();
    const btn = $("#btn-connect");
    btn.disabled = true;
    btn.textContent = "CONNECTING…";
    try {
      const result = await Sync.connect(repo, token);
      $("#dlg-sync").close();
      toast(result === "downloaded" ? "☁ CONNECTED — LOADED LIST FROM GITHUB" : "☁ CONNECTED — SYNC IS ON", 3000);
    } catch (err) {
      const msg = err.status === 401 || err.status === 403 ? "GITHUB REJECTED THE TOKEN"
        : err.status === 404 ? "REPO OR data.json NOT FOUND (CHECK NAME + TOKEN ACCESS)"
        : "COULD NOT REACH GITHUB";
      toast("⚠ " + msg, 5000);
    } finally {
      btn.disabled = false;
      btn.textContent = "CONNECT";
    }
  }

  // ---------- events ----------
  function bind() {
    $("#sync-status").addEventListener("click", openSync);
    $("#form-sync").addEventListener("submit", submitSync);
    $("#btn-disconnect").addEventListener("click", () => {
      if (!confirm("Stop syncing this device? Your list stays here, but changes won't reach GitHub.")) return;
      Sync.disconnect();
      $("#dlg-sync").close();
      toast("☁ SYNC TURNED OFF ON THIS DEVICE");
    });

    $("#btn-add").addEventListener("click", openAdd);
    $("#btn-undo").addEventListener("click", undo);
    $("#btn-menu").addEventListener("click", () => $("#dlg-menu").showModal());

    $("#form-add").addEventListener("submit", submitAdd);
    $("#add-titles").addEventListener("keydown", (e) => {
      // Enter adds; Shift+Enter makes a new line for adding several at once
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        $("#form-add").requestSubmit();
      }
    });

    $("#form-edit").addEventListener("submit", submitEdit);
    $("#edit-title").addEventListener("input", updateEditPreview);
    $("#edit-cover").addEventListener("input", updateEditPreview);
    $("#btn-delete").addEventListener("click", deleteEditing);

    $$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
    // click on the backdrop closes a dialog
    $$("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

    $("#dlg-menu").addEventListener("click", (e) => {
      const action = e.target.closest("[data-action]")?.dataset.action;
      if (!action) return;
      if (action !== "import") $("#dlg-menu").close();
      if (action === "sync") openSync();
      if (action === "tiers") { renderTierRows(); $("#dlg-tiers").showModal(); }
      if (action === "png") exportPng();
      if (action === "export") exportJson();
      if (action === "import") $("#file-import").click();
      if (action === "reset") resetToSeed();
    });
    $("#file-import").addEventListener("change", (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      $("#dlg-menu").close();
      if (file) importJson(file);
    });
    $("#btn-add-tier").addEventListener("click", addTier);

    // open editor on click / Enter (but not right after a drag)
    const board = $("#board");
    board.addEventListener("click", (e) => {
      const card = e.target.closest(".card");
      if (!card || Date.now() - lastDragEnd < 300) return;
      openEdit(card.dataset.id);
    });
    board.addEventListener("keydown", (e) => {
      const card = e.target.closest(".card");
      if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openEdit(card.dataset.id); }
    });

    let searchTimer;
    $("#search").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const first = applySearch();
        first?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 120);
    });

    document.addEventListener("keydown", (e) => {
      if ($("dialog[open]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !isTyping()) {
        e.preventDefault();
        undo();
      } else if (e.key === "/" && !isTyping()) {
        e.preventDefault();
        $("#search").focus();
      } else if (e.key === "Escape" && document.activeElement === $("#search")) {
        $("#search").value = "";
        applySearch();
        $("#search").blur();
      }
    });
  }

  // ---------- boot ----------
  async function init() {
    bind();
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* storage blocked */ }
    if (saved) {
      try { state = normalize(JSON.parse(saved)); } catch { state = null; }
    }
    if (!state) {
      try {
        state = await loadSeed();
        persist();
      } catch {
        state = normalize({ tiers: clone(DEFAULT_TIERS), unranked: [] });
        if (location.protocol === "file:") {
          $("#board").replaceChildren(el("div", { class: "board-msg" },
            "OPEN THIS APP THROUGH THE LOCAL SERVER:", el("br"), el("code", {}, "http://localhost:8000")));
          return;
        }
      }
    }
    render();
    Sync.start();
  }

  // offline support + installable app (only on the real https site, not localhost)
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  init();
})();
