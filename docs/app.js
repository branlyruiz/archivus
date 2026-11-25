import { supabaseUrl, publishableKey } from "./config.js";
import { makeFolderPdf } from "./folder-pdf.js?v=21";
import { inventoryCache } from "./inventory-cache.js?v=26";

const byId = (id) => document.getElementById(id);
const search = byId("search");
const searchPanel = byId("search-panel");
const viewPicks = byId("view-picks");
const searchToggle = byId("dock-search");
const dockHome = byId("dock-home");
const list = byId("list");
const importButton = byId("import-inventory");
const loadMore = byId("load-more");
const pageSize = 150;
let visibleLimit = pageSize;
const path = byId("path");
const add = byId("add");
const sync = byId("sync");
const folderComposer = byId("folder-composer");
const folderAdd = byId("folder-add");
const folderForm = byId("folder-form");
const folderName = byId("folder-name");
const folderSave = byId("folder-save");
const folderCancel = byId("folder-cancel");
const folderError = byId("folder-error");
const dialog = document.querySelector("dialog");
const form = byId("editor");
const fields = byId("fields");
const save = byId("save");
const error = byId("error");
const configured = Boolean(supabaseUrl && publishableKey);
const cacheKey = `archivus:snapshot:${supabaseUrl}`;
const cache = inventoryCache(cacheKey);
const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });
const diskCapacities = ["500 GB", ...Array.from({ length: 8 }, (_, index) => `${index + 1} TB`)];
const diskColors = {
  rojo: ["Rojo", "#bc1637", "#ffabb1"],
  naranja: ["Naranja", "#e9582d", "#ffad89", "dark"],
  amarillo: ["Amarillo", "#f7b924", "#ffe179", "dark"],
  verde: ["Verde", "#247c49", "#a5e3ab"],
  turquesa: ["Turquesa", "#006c78", "#83e1e4"],
  azul: ["Azul", "#185db5", "#9fcaff"],
  morado: ["Morado", "#6537c6", "#c8b2fb"],
  rosa: ["Rosa", "#9d2976", "#f7a9dd"],
  gris: ["Gris / plateado", "#526478", "#bcc5d1"],
  negro: ["Negro", "#0d1017", "#24262d"],
  blanco: ["Blanco", "#fff", "#fff", "dark"],
};
const icons = {
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 13h6m-6 4h6"/>',
  disk: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 13h18m-14 3h1m4 0h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
};

let snapshot = null;
try {
  snapshot = JSON.parse(localStorage.getItem(cacheKey));
} catch {
  // An unavailable cache does not prevent loading the shared inventory.
}
const picksKey = `archivus:folder-picks:${supabaseUrl}`;
let folderPicks = new Map();
try {
  const saved = JSON.parse(localStorage.getItem(picksKey));
  if (Array.isArray(saved)) {
    folderPicks = new Map(saved.filter((entry) => Array.isArray(entry)
      && typeof entry[0] === "string" && typeof entry[1] === "boolean"));
  }
} catch {
  // The list can still be used if local storage is unavailable.
}
let items = new Map();
let children = new Map();
let searchIndex = [];
const byName = (a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id);
let current = null;
let ready = false;
let refreshing = false;
let saving = false;
let operation = null;
let focusAfterClose = null;
let folderDraft = null;
let savingFolder = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, callback, className) {
  const node = element("button", text, className);
  node.type = "button";
  node.addEventListener("click", callback);
  return node;
}

function setStatus(text, connected = false) {
  ready = connected;
  sync.dataset.ready = String(connected);
  if (sync.textContent !== text) sync.textContent = text;
  add.disabled = folderAdd.disabled = !ready || savingFolder;
  importButton.disabled = byId("new-file").disabled = !ready;
  folderSave.disabled = !ready || savingFolder;
  if (dialog.open && operation && !saving) save.disabled = !ready;
}

async function rpc(method, payload, timeout = 40000) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${method}`, {
    method: "POST",
    headers: { apikey: publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (result?.code === "P0001") throw new Error(result.message);
    if (result?.code === "57014" || response.status === 504) {
      throw new Error("El servicio agotó el tiempo de espera. Vuelve a intentar la importación.");
    }
    throw new Error(`El servicio del inventario respondió con un error (${response.status}).`);
  }
  return result;
}

function rebuildIndex() {
  children = new Map();
  searchIndex = [];
  for (const item of items.values()) {
    if (!children.has(item.parent)) children.set(item.parent, []);
    children.get(item.parent).push(item);
    searchIndex.push({ id: item.id, name: item.name, term: normalize(item.name) });
  }
  for (const group of children.values()) group.sort(byName);
  searchIndex.sort(byName);
}

function refreshView() {
  if (current && !items.has(current)) {
    current = null;
    closeFolderComposer();
  }
  render();
}

function applySnapshot(next) {
  snapshot = { revision: next.revision };
  items = new Map(next.items.map((item) => [item.id, item]));
  rebuildIndex();
  refreshView();
}

function insertSorted(array, item) {
  let left = 0, right = array.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (byName(array[middle], item) < 0) left = middle + 1;
    else right = middle;
  }
  array.splice(left, 0, item);
}

function applyChanges(records, revision, from) {
  const rebuild = from < 0 || records.size > 60;
  if (from < 0) items = new Map();
  for (const [id, item] of records) {
    const previous = items.get(id);
    if (item) items.set(id, item);
    else items.delete(id);
    if (rebuild) continue;

    if (previous) {
      const siblings = children.get(previous.parent);
      if (siblings) siblings.splice(siblings.indexOf(previous), 1);
      const index = searchIndex.findIndex((entry) => entry.id === id);
      if (index >= 0) searchIndex.splice(index, 1);
    }
    if (item) {
      if (!children.has(item.parent)) children.set(item.parent, []);
      insertSorted(children.get(item.parent), item);
      insertSorted(searchIndex, { id: item.id, name: item.name, term: normalize(item.name) });
    }
  }
  snapshot = { revision };
  if (rebuild) rebuildIndex();
  if (records.size || from < 0) refreshView();
}

async function syncInventory() {
  const localRevision = await cache.revision();
  if (typeof localRevision === "number" && localRevision > (snapshot?.revision ?? -1)) {
    const newer = await cache.load();
    if (newer?.items) applySnapshot(newer);
  }

  const base = snapshot?.revision ?? -1;
  let stage = await cache.checkpoint();
  if (stage && stage.base !== base) {
    await cache.discard();
    stage = null;
  }
  let pages = stage?.pages ?? [];
  let latest;
  for (;;) {
    const page = await rpc("archivus_sync", {
      known_revision: stage?.from ?? base,
      target_revision: stage?.revision ?? null,
      cursor_version: stage?.cursor?.[0] ?? null,
      cursor_id: stage?.cursor?.[1] ?? null,
    });
    if (!page) return;
    if (page.restart) {
      await cache.discard();
      stage = null;
      pages = [];
      continue;
    }
    latest = page.latest;
    stage = { base, from: page.from, revision: page.revision, cursor: page.cursor, index: pages.length };
    pages.push(page.records);
    if (page.cursor) {
      await cache.savePage(stage, page.records);
      setStatus(`${page.from < 0 ? "Descargando inventario" : "Actualizando"} · ${((stage.index + 1) * 2000).toLocaleString("es-CO")} registros`, ready);
      continue;
    }
    const records = new Map();
    for (const chunk of pages) for (const [id, item] of chunk) records.set(id, item);
    await cache.commit(base, stage.revision, stage.from, records, items);
    applyChanges(records, stage.revision, stage.from);
    return latest > stage.revision;
  }
}

let bootstrapping = true;
let syncQueued = false;

async function refresh() {
  if (!configured || !navigator.onLine || bootstrapping) return;
  if (refreshing) {
    syncQueued = true;
    return;
  }
  refreshing = true;
  try {
    const sync = async (lock) => {
      if (!lock) return;
      const more = await syncInventory();
      if (!navigator.onLine) return;
      setStatus("Sincronizado", true);
      if (more) syncQueued = true;
    };
    if (navigator.locks) await navigator.locks.request(cacheKey, { ifAvailable: true }, sync);
    else await sync(true);
  } catch {
    if (navigator.onLine) setStatus(snapshot ? "Sin sincronizar · copia local" : "No se pudo conectar");
  } finally {
    refreshing = false;
    if (syncQueued) {
      syncQueued = false;
      void refresh();
    }
  }
}

async function writeInventory(change) {
  await rpc("archivus_write", { change: { ...change, sync_only: true } });
  await refresh();
}

function ancestors(id) {
  const result = [];
  for (let item = items.get(id); item; item = items.get(item.parent)) result.push(item);
  return result.reverse();
}

function branch(id) {
  const descendants = new Set();
  const pending = [id];
  while (pending.length) {
    const next = pending.pop();
    descendants.add(next);
    for (const child of children.get(next) ?? []) pending.push(child.id);
  }
  return descendants;
}

function setSearch(open) {
  searchPanel.hidden = !open;
  searchToggle.setAttribute("aria-expanded", String(open));
  if (!open && search.value) {
    search.value = "";
    visibleLimit = pageSize;
  }
  render();
  if (open) search.focus();
}

let returnPosition = null;

function restoreReturnPosition(id, itemId) {
  const position = { id, itemId };
  returnPosition = position;
  const restore = (center = false) => {
    if (returnPosition !== position || current !== id || !searchPanel.hidden || dialog.open) return;
    const card = list.querySelector(`[data-focus="open-${CSS.escape(itemId)}"]`);
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const height = viewport?.height ?? window.innerHeight;
    const visible = rect.top >= top + 12 && rect.bottom <= top + height - 88;
    if (center || !visible) {
      const target = window.scrollY + rect.top + rect.height / 2 - top - (height - 64) / 2;
      window.scrollTo({ top: target, behavior: "instant" });
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(() => restore(true)));
  // Mobile scrolling can settle after touchend and after the first paint.
  setTimeout(restore, 180);
  setTimeout(restore, 480);
}

function openLocation(id, returnTo = null) {
  returnPosition = null;
  if (current !== id) {
    closeFolderComposer();
    visibleLimit = pageSize;
  }
  current = id;
  if (returnTo) {
    search.value = "";
    const position = children.get(id)?.findIndex((item) => item.id === returnTo) ?? -1;
    visibleLimit = Math.max(visibleLimit, Math.ceil((position + 1) / pageSize) * pageSize);
  }
  setSearch(false);
  const originCard = returnTo && list.querySelector(`[data-focus="open-${CSS.escape(returnTo)}"]`);
  if (originCard) {
    originCard.focus({ preventScroll: true });
    restoreReturnPosition(id, returnTo);
    return;
  }
  const heading = byId("heading");
  heading.tabIndex = -1;
  heading.focus();
}

for (const input of ["touchstart", "wheel", "pointerdown", "keydown"]) {
  window.addEventListener(input, () => { returnPosition = null; }, { capture: true, passive: true });
}

const inventorySurface = document.querySelector("main");
let backSwipe = null;

inventorySurface.addEventListener("touchstart", (event) => {
  backSwipe = null;
  if (!current || event.touches.length !== 1 || dialog.open || !folderForm.hidden || !searchPanel.hidden || path.contains(event.target)) return;
  const touch = event.touches[0];
  if (touch.clientX > Math.min(96, window.innerWidth / 4)) return;
  backSwipe = { x: touch.clientX, y: touch.clientY, location: current };
}, { passive: true });

inventorySurface.addEventListener("touchmove", (event) => {
  if (!backSwipe) return;
  if (event.touches.length !== 1) {
    backSwipe = null;
    return;
  }
  const touch = event.touches[0];
  const dx = touch.clientX - backSwipe.x;
  const dy = Math.abs(touch.clientY - backSwipe.y);
  if (dx < -12 || (dy > 12 && dy >= dx)) {
    backSwipe = null;
  } else if (dx > 18 && dx > dy * 1.5 && event.cancelable) {
    event.preventDefault();
  }
}, { passive: false });

function swipeToParent(location) {
  const parent = items.get(location)?.parent ?? null;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    openLocation(parent, location);
    return;
  }

  const layer = element("div", null, "swipe-outgoing");
  const snapshot = inventorySurface.cloneNode(true);
  const bounds = inventorySurface.getBoundingClientRect();
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  Object.assign(snapshot.style, {
    position: "absolute",
    top: `${bounds.top}px`,
    left: `${bounds.left}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  });
  layer.append(snapshot);
  document.body.append(layer);
  snapshot.querySelector("#path").scrollLeft = path.scrollLeft;

  openLocation(parent, location);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (current !== parent) {
      layer.remove();
      return;
    }
    const animation = layer.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(100%)" }],
      { duration: 220, easing: "cubic-bezier(.22,.72,.3,1)" },
    );
    animation.finished.then(() => layer.remove(), () => layer.remove());
  }));
}

inventorySurface.addEventListener("touchend", (event) => {
  const start = backSwipe;
  backSwipe = null;
  if (!start || start.location !== current || event.touches.length) return;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - start.x;
  const dy = Math.abs(touch.clientY - start.y);
  if (dx < 64 || dx <= dy * 1.5 || !event.cancelable) return;
  event.preventDefault();
  swipeToParent(start.location);
}, { passive: false });

inventorySurface.addEventListener("touchcancel", () => { backSwipe = null; }, { passive: true });

function card(item, searching) {
  const article = element("article", null, "card");
  const color = item.kind === "disk" ? getDiskColor(item.color) : null;
  if (color) {
    const [, chip, surface, iconTone] = color;
    article.dataset.diskColor = item.color;
    article.style.setProperty("--disk-chip", chip);
    article.style.setProperty("--disk-tint", surface);
    if (iconTone === "dark") article.style.setProperty("--disk-icon", "var(--text)");
  }
  const open = button(null, () => item.kind === "file" ? showActions(item) : openLocation(item.id), "open");
  open.dataset.focus = `open-${item.id}`;
  const glyph = element("span", null, "glyph");
  glyph.setAttribute("aria-hidden", "true");
  glyph.innerHTML = `<svg viewBox="0 0 24 24">${icons[item.kind]}</svg>`;
  const copy = element("span");
  const folderCount = children.get(item.id)?.length ?? 0;
  const caption = item.kind === "disk"
    ? [item.technology, item.capacity].filter(Boolean).join(" · ")
    : searching
      ? ancestors(item.parent).map(({ name }) => name).join(" › ")
      : item.kind === "file" ? "Archivo"
        : `${folderCount} ${folderCount === 1 ? "carpeta" : "carpetas"}`;
  copy.append(element("span", item.name, "card-name"), element("span", caption, "meta"));
  open.append(glyph, copy);
  const more = button("•••", () => showActions(item), "more");
  more.dataset.focus = `more-${item.id}`;
  more.setAttribute("aria-label", `Acciones de ${item.name}`);
  article.append(open);
  if (searching && item.kind === "folder") article.append(folderPickButton(item));
  if (item.kind !== "file") article.append(more);
  return article;
}

function saveFolderPicks() {
  viewPicks.textContent = `Ver lista (${folderPicks.size})`;
  try {
    localStorage.setItem(picksKey, JSON.stringify([...folderPicks]));
  } catch {
    byId("notice").textContent = "La lista está disponible mientras esta app siga abierta.";
  }
}

function folderPickButton(item) {
  const toggle = button(null, () => {
    if (folderPicks.has(item.id)) folderPicks.delete(item.id);
    else folderPicks.set(item.id, false);
    saveFolderPicks();
    update();
  }, "pick-toggle");
  toggle.setAttribute("aria-label", `Incluir ${item.name} en la lista`);
  const update = () => {
    const selected = folderPicks.has(item.id);
    toggle.textContent = selected ? "✓" : "+";
    toggle.setAttribute("aria-pressed", String(selected));
  };
  update();
  return toggle;
}

function folderPickGroups() {
  const groups = new Map();
  for (const [id, found] of folderPicks) {
    const trail = ancestors(id);
    const disk = trail[0];
    const key = disk?.id ?? null;
    if (!groups.has(key)) groups.set(key, { name: disk?.name ?? "Sin ubicación disponible", folders: [] });
    groups.get(key).folders.push({ id, found, trail });
  }

  return [...groups.values()].sort((a, b) => collator.compare(a.name, b.name));
}

function exportFolderPicks() {
  if (!folderPicks.size) return;
  try {
    const pdf = makeFolderPdf(folderPickGroups());
    const url = URL.createObjectURL(pdf);
    const download = element("a");
    download.href = url;
    download.download = "Archivus-lista-de-busqueda.pdf";
    document.body.append(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch {
    error.textContent = "No se pudo generar el PDF. Vuelve a intentarlo.";
    error.hidden = false;
  }
}

function showFolderPicks() {
  const content = folderPickGroups().map(({ name, folders }) => {
    const group = element("section", null, "pick-group");
    group.append(element("h3", name));
    for (const { id, found, trail } of folders) {
      const item = trail.at(-1);
      const title = item?.name ?? "Carpeta no disponible";
      const row = element("div", null, "pick-row");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = found;
      checkbox.setAttribute("aria-label", `Encontrada: ${trail.map(({ name }) => name).join(" › ") || title}`);
      checkbox.addEventListener("change", () => {
        folderPicks.set(id, checkbox.checked);
        row.classList.toggle("found", checkbox.checked);
        saveFolderPicks();
      });
      row.classList.toggle("found", found);
      const details = element("div");
      details.append(element("strong", title, "pick-name"));
      if (item) details.append(element("p", trail.map(({ name }) => name).join(" › "), "pick-location"));
      const remove = button("×", () => {
        folderPicks.delete(id);
        saveFolderPicks();
        render();
        showFolderPicks();
      }, "pick-remove");
      remove.setAttribute("aria-label", `Quitar ${title} de la lista`);
      row.append(checkbox, details, remove);
      group.append(row);
    }
    return group;
  });

  if (content.length) {
    const actions = element("div", null, "pick-actions");
    actions.append(button("Vaciar lista", confirmClearFolderPicks, "pick-clear"));
    content.unshift(actions);
  } else {
    content.push(element("p", "Agrega carpetas con + desde los resultados de búsqueda."));
  }
  showPanel("Lista de búsqueda", content);
  byId("cancel").textContent = "Cerrar";
  byId("export-picks").hidden = !folderPicks.size;
}

function confirmClearFolderPicks() {
  const actions = element("div", null, "dialog-actions");
  const cancel = button("Volver a la lista", () => {
    showFolderPicks();
    fields.querySelector(".pick-clear")?.focus();
  });
  const clear = button("Sí, vaciar lista", () => {
    folderPicks.clear();
    saveFolderPicks();
    render();
    showFolderPicks();
    byId("notice").textContent = "Lista vaciada.";
    byId("cancel").focus();
  }, "primary danger");
  actions.append(cancel, clear);
  showPanel("¿Vaciar la lista?", [
    element("p", folderPicks.size === 1
      ? "Se quitará la carpeta seleccionada y su marca de «Encontrada»."
      : `Se quitarán las ${folderPicks.size} carpetas seleccionadas y sus marcas de «Encontrada».`),
    actions,
  ]);
  byId("cancel").hidden = true;
}

function normalize(value) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function render() {
  const focusKey = document.activeElement?.dataset.focus;
  const location = items.get(current);
  const query = normalize(search.value.trim());
  const results = query
    ? searchIndex.filter((item) => item.term.includes(query))
    : children.get(current) ?? [];
  byId("heading").textContent = location?.name ?? "Discos W Agencia";
  byId("summary").textContent = location?.kind === "disk"
    ? [location.technology, location.capacity].filter(Boolean).join(" · ")
    : location ? "" : "Organiza y encuentra el material de tu equipo.";
  byId("summary").hidden = !byId("summary").textContent;
  add.setAttribute("aria-label", current ? "Nueva carpeta" : "Nuevo disco");
  if (!current && searchPanel.hidden) dockHome.setAttribute("aria-current", "page");
  else dockHome.removeAttribute("aria-current");
  folderComposer.hidden = !current || Boolean(query);
  importButton.hidden = Boolean(current || query);
  byId("new-file").hidden = folderAdd.hidden;
  renderPath(Boolean(query));
  byId("section-title").textContent = query ? "Resultados" : current ? "Contenido" : "Tus discos";
  byId("count").textContent = snapshot ? String(results.length) : "";
  list.classList.toggle("rows", Boolean(query || current || !results.length));
  const emptyText = !configured ? "La conexión compartida está pendiente de configuración."
    : !snapshot ? "Esperando el inventario compartido."
      : query ? "No se encontraron coincidencias."
        : current ? "Esta ubicación aún no tiene carpetas." : "Agrega el primer disco del inventario.";
  const empty = folderComposer.hidden ? [element("p", emptyText, "empty")] : [];
  list.replaceChildren(...(results.length ? results.slice(0, visibleLimit).map(({ id }) => card(items.get(id), Boolean(query))) : empty));
  loadMore.hidden = results.length <= visibleLimit;
  loadMore.textContent = `Ver más (${Math.min(visibleLimit, results.length)} de ${results.length})`;
  if (focusKey) list.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

function renderPath(searching) {
  const previousLocation = path.dataset.location;
  const previousScroll = path.scrollLeft;
  path.hidden = !current || searching;
  path.replaceChildren();
  if (path.hidden) return;

  const trail = ancestors(current);
  const home = button("Discos", () => openLocation(null, trail[0].id), "path-step");
  home.setAttribute("aria-label", "Volver a Discos W Agencia");
  path.append(home);
  for (const [index, item] of trail.slice(0, -1).entries()) {
    const divider = element("span", "›", "path-separator");
    divider.setAttribute("aria-hidden", "true");
    const step = button(item.name, () => openLocation(item.id, trail[index + 1].id), "path-step");
    step.setAttribute("aria-label", `Volver a ${item.name}`);
    path.append(divider, step);
  }
  path.scrollLeft = previousLocation === current ? previousScroll : path.scrollWidth;
  path.dataset.location = current;
}

function showPanel(title, content, action, nextOperation) {
  byId("dialog-title").textContent = title;
  fields.replaceChildren(...content);
  error.hidden = true;
  operation = nextOperation;
  byId("cancel").textContent = "Cancelar";
  byId("cancel").hidden = false;
  byId("export-picks").hidden = true;
  save.hidden = !action;
  save.textContent = action ?? "";
  save.classList.toggle("danger", nextOperation?.action === "delete");
  save.disabled = !ready;
  if (!dialog.open) {
    focusAfterClose = document.activeElement;
    dialog.showModal();
  }
  fields.querySelector("input,select,button")?.focus();
  keepEditorVisible();
}

function field(label, control) {
  const wrapper = element("label", label);
  wrapper.append(control);
  return wrapper;
}

function input(name, value, limit, required = false) {
  const node = element("input");
  Object.assign(node, { name, value: value ?? "", maxLength: limit, required });
  return node;
}

function select(name) {
  const node = element("select");
  node.name = name;
  node.required = true;
  return node;
}

function getDiskColor(value) {
  return Object.hasOwn(diskColors, value) ? diskColors[value] : null;
}

function diskColorField(value) {
  const control = select("color");
  control.required = false;
  control.add(new Option("Predeterminado", ""));
  for (const [key, [label]] of Object.entries(diskColors)) control.add(new Option(label, key));
  control.value = getDiskColor(value) ? value : "";
  const label = field("Color del disco", control);
  const swatch = element("span", null, "color-swatch");
  swatch.setAttribute("aria-hidden", "true");
  label.classList.add("disk-color-field");
  label.append(swatch);
  const preview = () => swatch.style.setProperty("--swatch", getDiskColor(control.value)?.[1] ?? "var(--accent)");
  control.addEventListener("change", preview);
  preview();
  return label;
}

function showEdit(item, kind = item?.kind ?? (current ? "folder" : "disk")) {
  const type = { disk: "disco", folder: "carpeta", file: "archivo" }[kind];
  const content = [field("Nombre", input("name", item?.name, kind === "disk" ? 120 : 255, true))];
  if (kind === "disk") {
    const technology = select("technology");
    for (const option of ["HDD", "SSD", "Otro"]) technology.add(new Option(option, option));
    technology.value = item?.technology ?? "HDD";
    const capacity = select("capacity");
    capacity.required = false;
    capacity.add(new Option("Selecciona una capacidad", ""));
    for (const value of diskCapacities) capacity.add(new Option(value, value));
    const previousCapacity = item?.capacity ?? "";
    const normalized = previousCapacity.toUpperCase().replace(/\s+/g, "").replace(/T$/, "TB");
    const standard = diskCapacities.find((value) => value.replace(" ", "") === normalized);
    if (previousCapacity && !standard) capacity.add(new Option(previousCapacity, previousCapacity));
    capacity.value = standard ?? previousCapacity;
    content.push(field("Tecnología", technology), field("Capacidad", capacity), diskColorField(item?.color));
  }
  showPanel(item ? `Editar ${type}` : kind === "folder" ? "Nueva carpeta" : `Nuevo ${type}`,
    content, "Guardar", {
      action: item ? "edit" : "create", id: item?.id ?? crypto.randomUUID(),
      kind, parent: item?.parent ?? current, version: item?.version,
      interface: item?.interface,
    });
}

function showMove(item) {
  const excluded = branch(item.id);
  const destination = select("parent");
  destination.add(new Option("Selecciona una ubicación", ""));
  for (const disk of children.get(null) ?? []) {
    const group = element("optgroup");
    group.label = disk.name;
    const stack = [disk];
    while (stack.length) {
      const node = stack.pop();
      if (excluded.has(node.id) || node.kind === "file") continue;
      if (node.id !== item.parent) {
        group.append(new Option(node.kind === "disk"
          ? `Raíz de ${node.name}`
          : ancestors(node.id).slice(1).map(({ name }) => name).join(" › "), node.id));
      }
      stack.push(...(children.get(node.id) ?? []).slice().reverse());
    }
    if (group.children.length) destination.append(group);
  }
  const content = destination.options.length > 1
    ? [element("p", item.name), field("Destino", destination)]
    : [element("p", "Agrega otra carpeta o disco para tener un destino disponible.")];
  showPanel(item.kind === "file" ? "Mover archivo" : "Mover carpeta", content, destination.options.length > 1 ? "Mover aquí" : null,
    { action: "move", id: item.id, version: item.version });
}

function showActions(item) {
  const actions = [button("Editar nombre y datos", () => showEdit(item), "action")];
  if (item.kind !== "disk") actions.push(button("Mover a otra ubicación", () => showMove(item), "action"));
  actions.push(button("Eliminar del inventario", () => {
    const count = branch(item.id).size - 1;
    showPanel("Eliminar del inventario", [
      element("p", count
        ? `Se eliminará «${item.name}» y ${count} ${count === 1 ? "registro de su interior" : "registros de su interior"}.`
        : `Se eliminará «${item.name}».`),
    ], "Eliminar", { action: "delete", id: item.id, version: item.version, revision: snapshot.revision });
  }, "action danger"));
  for (const action of actions) action.disabled = !ready;
  if (!ready) actions.unshift(element("p", "Conéctate al inventario para editar."));
  showPanel(item.name, actions);
}

function openFolderComposer() {
  if (!current || !ready || savingFolder) return;
  if (!searchPanel.hidden) setSearch(false);
  folderAdd.hidden = true;
  byId("new-file").hidden = true;
  folderForm.hidden = false;
  folderName.focus();
  requestAnimationFrame(keepEditorVisible);
}

function closeFolderComposer({ restoreFocus = false } = {}) {
  folderDraft = null;
  folderForm.reset();
  folderForm.hidden = true;
  folderAdd.hidden = false;
  byId("new-file").hidden = false;
  folderError.hidden = true;
  if (restoreFocus) folderAdd.focus();
}

function keepEditorVisible() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const heightDifference = Math.max(0, window.innerHeight - viewport.height);
  const keyboard = heightDifference > 100 && viewport.scale === 1;
  const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  document.documentElement.classList.toggle("keyboard-open", keyboard);
  document.documentElement.style.setProperty("--keyboard-space", `${keyboard ? heightDifference : 0}px`);
  dialog.style.setProperty("--visible-height", `${viewport.height}px`);
  dialog.style.setProperty("--keyboard-inset", `${inset}px`);
  if (document.activeElement === folderName && !folderComposer.hidden) {
    const formBottom = folderForm.getBoundingClientRect().bottom;
    const overlap = formBottom - (viewport.offsetTop + viewport.height - 16);
    if (overlap > 0) window.scrollBy(0, Math.ceil(overlap));
  }
}

window.visualViewport?.addEventListener("resize", keepEditorVisible);
window.visualViewport?.addEventListener("scroll", keepEditorVisible);
folderAdd.addEventListener("click", openFolderComposer);
folderSave.addEventListener("pointerdown", (event) => {
  if (document.activeElement === folderName) event.preventDefault();
});
folderCancel.addEventListener("click", () => closeFolderComposer({ restoreFocus: true }));
folderName.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || savingFolder) return;
  event.preventDefault();
  closeFolderComposer({ restoreFocus: true });
});
folderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!current || savingFolder || !ready) return;
  const enteredName = folderName.value;
  const name = enteredName.trim();
  if (!name) {
    folderError.textContent = "Escribe el nombre de la carpeta.";
    folderError.hidden = false;
    folderName.focus();
    return;
  }
  if (folderDraft?.name !== name) {
    folderDraft = { action: "create", kind: "folder", id: crypto.randomUUID(), parent: current, name };
  }
  const draft = folderDraft;
  savingFolder = true;
  folderSave.disabled = folderCancel.disabled = add.disabled = true;
  folderName.focus();
  folderError.hidden = true;
  try {
    await writeInventory(draft);
    if (folderDraft === draft) {
      folderDraft = null;
      if (folderName.value === enteredName) folderForm.reset();
      requestAnimationFrame(keepEditorVisible);
      byId("notice").textContent = "Carpeta agregada.";
    }
  } catch (failure) {
    if (folderDraft === draft) {
      folderError.textContent = failure.message;
      folderError.hidden = false;
    }
    void refresh();
  } finally {
    savingFolder = false;
    folderSave.disabled = folderAdd.disabled = add.disabled = !ready;
    folderCancel.disabled = false;
  }
});

function showInventoryImport() {
  const file = element("input");
  file.type = "file";
  file.accept = ".json,application/json";
  const preview = element("p");
  showPanel("Importar inventario", [
    field("Archivo JSON", file),
    element("p", "Se añadirán las rutas al disco de destino. Las rutas que ya existan se conservan."),
    preview,
  ]);

  file.addEventListener("change", async () => {
    operation = null;
    save.hidden = true;
    error.hidden = true;
    preview.textContent = "";
    const source = file.files[0];
    if (!source) return;
    try {
      if (source.size > 15_000_000) throw new Error("El JSON supera los 15 MB.");
      let data;
      try {
        data = JSON.parse(await source.text());
      } catch {
        throw new Error("El archivo no contiene JSON válido.");
      }
      if (!file.isConnected || !dialog.open || file.files[0] !== source) return;
      if (data?.schema !== "archivus.disk-inventory" || data.version !== 1 || typeof data.volume?.name !== "string"
        || !data.volume.name.trim() || Array.from(data.volume.name.trim()).length > 120
        || !Array.isArray(data.entries) || !data.entries.length || data.entries.length > 100000) {
        throw new Error("Selecciona un JSON de inventario de Archivus con entre 1 y 100.000 rutas.");
      }
      const entries = data.entries.map((entry) => {
        if (!entry || !["directory", "file"].includes(entry.type) || typeof entry.path !== "string" || !entry.path
          || Array.from(entry.path).length > 4096 || entry.path.includes("\u0000")
          || entry.path.split("/").some((part) => !part || part === "." || part === ".." || Array.from(part).length > 255)) {
          throw new Error("El JSON contiene una ruta o un tipo de registro inválido.");
        }
        return { path: entry.path, type: entry.type };
      });
      const volume = data.volume.name.trim();
      const disks = children.get(null) ?? [];
      const sameDisk = disks.find((disk) => disk.name === volume);
      const destination = select("disk_id");
      destination.required = false;
      if (!sameDisk) destination.add(new Option(`Crear disco «${volume}»`, ""));
      for (const disk of disks) destination.add(new Option(disk.name, disk.id));
      destination.value = sameDisk?.id ?? "";
      const files = entries.filter(({ type }) => type === "file").length;
      const folders = entries.length - files;
      const summary = `${volume} · ${folders.toLocaleString("es-CO")} ${folders === 1 ? "carpeta" : "carpetas"} y ${files.toLocaleString("es-CO")} ${files === 1 ? "archivo" : "archivos"}`;
      const content = [element("p", summary), field("Disco de destino", destination),
        element("p", "Las rutas se guardarán en el inventario compartido y serán visibles para quienes tengan acceso a Archivus.")];
      if (Array.isArray(data.errors) && data.errors.length) {
        content.push(element("p", `El escaneo omitió ${data.errors.length} rutas con errores.`));
      }
      showPanel("Confirmar importación", content, "Importar rutas", { action: "import", entries, volume });
    } catch (failure) {
      if (!file.isConnected || !dialog.open || file.files[0] !== source) return;
      error.textContent = failure.message;
      error.hidden = false;
    }
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!operation || saving || !ready) return;
  const request = { ...operation, ...Object.fromEntries(new FormData(form)) };
  saving = true;
  error.hidden = true;
  save.disabled = byId("cancel").disabled = byId("close").disabled = true;
  try {
    if (request.action === "import") {
      save.textContent = "Importando…";
      const result = await rpc("archivus_import", {
        disk_id: request.disk_id || null, volume_name: request.volume, entries: request.entries,
      }, 65000);
      dialog.close();
      byId("notice").textContent = result.added
        ? `Importación completa: ${result.added.toLocaleString("es-CO")} rutas añadidas.`
        : "El inventario ya incluía estas rutas.";
      void refresh();
    } else {
      await writeInventory(request);
      dialog.close();
      byId("notice").textContent = ({ create: "Registro agregado.", edit: "Cambios guardados.",
        move: "Registro movido.", delete: "Registro eliminado." })[request.action];
    }
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
    void refresh();
  } finally {
    saving = false;
    if (request.action === "import") save.textContent = "Importar rutas";
    save.disabled = !ready;
    byId("cancel").disabled = byId("close").disabled = false;
  }
});

dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
dialog.addEventListener("close", () => {
  if (!focusAfterClose) return;
  const key = focusAfterClose?.dataset.focus;
  const target = focusAfterClose?.isConnected ? focusAfterClose
    : key && list.querySelector(`[data-focus="${CSS.escape(key)}"]`);
  (target || byId("home")).focus();
});
byId("close").addEventListener("click", () => dialog.close());
byId("cancel").addEventListener("click", () => dialog.close());
byId("home").addEventListener("click", () => openLocation(null));
dockHome.addEventListener("click", () => openLocation(null));
searchToggle.addEventListener("click", () => setSearch(searchPanel.hidden));
search.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  setSearch(false);
  searchToggle.focus();
});
add.addEventListener("click", () => current ? openFolderComposer() : showEdit());
viewPicks.addEventListener("click", showFolderPicks);
byId("export-picks").addEventListener("click", exportFolderPicks);
viewPicks.textContent = `Ver lista (${folderPicks.size})`;
importButton.addEventListener("click", showInventoryImport);
byId("new-file").addEventListener("click", () => showEdit(null, "file"));
loadMore.addEventListener("click", () => {
  const firstNew = visibleLimit;
  visibleLimit += pageSize;
  render();
  list.children[firstNew]?.querySelector(".open")?.focus();
});
search.addEventListener("input", () => {
  visibleLimit = pageSize;
  render();
});
window.addEventListener("online", refresh);
window.addEventListener("offline", () => setStatus(snapshot ? "Sin conexión · copia local" : "Sin conexión"));
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });

if (snapshot) applySnapshot(snapshot);
else render();
if (configured) {
  if (snapshot || !navigator.onLine) setStatus(snapshot ? "Copia local" : "Sin conexión");
  void cache.load().then((cached) => {
    if (cached?.items && (!snapshot || cached.revision > snapshot.revision)) applySnapshot(cached);
    bootstrapping = false;
    if (navigator.onLine) void refresh();
    else setStatus(snapshot ? "Sin conexión · copia local" : "Sin conexión");
  });
  setInterval(() => { if (!document.hidden) void refresh(); }, 10000);
} else {
  setStatus("Conexión pendiente");
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);
