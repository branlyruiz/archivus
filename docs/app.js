import { supabaseUrl, publishableKey } from "./config.js";

const byId = (id) => document.getElementById(id);
const search = byId("search");
const list = byId("list");
const path = byId("path");
const add = byId("add");
const sync = byId("sync");
const dialog = document.querySelector("dialog");
const form = byId("editor");
const fields = byId("fields");
const save = byId("save");
const error = byId("error");
const configured = Boolean(supabaseUrl && publishableKey);
const cacheKey = `archivus:snapshot:${supabaseUrl}`;
const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });
const icons = {
  disk: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 13h18m-14 3h1m4 0h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
};

let snapshot = null;
try {
  snapshot = JSON.parse(localStorage.getItem(cacheKey));
} catch {
  // An unavailable cache does not prevent loading the shared inventory.
}
let items = new Map();
let children = new Map();
let current = null;
let ready = false;
let refreshing = false;
let saving = false;
let operation = null;
let focusAfterClose = null;

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
  add.disabled = !ready;
  if (dialog.open && operation && !saving) save.disabled = !ready;
}

async function rpc(method, payload) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${method}`, {
    method: "POST",
    headers: { apikey: publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.code === "P0001" ? result.message : "No se pudo comunicar con el inventario.");
  return result;
}

function applySnapshot(next) {
  if (!next || (snapshot && next.revision < snapshot.revision)) return;
  snapshot = next;
  items = new Map(next.items.map((item) => [item.id, item]));
  children = new Map();
  for (const item of next.items) {
    if (!children.has(item.parent)) children.set(item.parent, []);
    children.get(item.parent).push(item);
  }
  for (const group of children.values()) group.sort((a, b) => collator.compare(a.name, b.name));
  try {
    localStorage.setItem(cacheKey, JSON.stringify(next));
  } catch {
    // The online inventory remains available when storage is full or disabled.
  }
  if (current && !items.has(current)) current = null;
  render();
}

async function refresh() {
  if (!configured || refreshing || !navigator.onLine) return;
  refreshing = true;
  try {
    // Always validate the first cached snapshot against the server, even after a restore.
    const next = await rpc("archivus_read", { known_revision: ready ? snapshot?.revision ?? -1 : -1 });
    if (next && !ready && !saving && snapshot && next.revision < snapshot.revision) snapshot = null;
    if (next) applySnapshot(next);
    setStatus("Sincronizado", true);
  } catch {
    setStatus(snapshot ? "Sin sincronizar · copia local" : "No se pudo conectar");
  } finally {
    refreshing = false;
  }
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

function openLocation(id) {
  current = id;
  search.value = "";
  render();
  const heading = byId("heading");
  heading.tabIndex = -1;
  heading.focus();
}

function card(item, searching) {
  const article = element("article", null, "card");
  const open = button(null, () => openLocation(item.id), "open");
  open.dataset.focus = `open-${item.id}`;
  const glyph = element("span", null, "glyph");
  glyph.setAttribute("aria-hidden", "true");
  glyph.innerHTML = `<svg viewBox="0 0 24 24">${icons[item.kind]}</svg>`;
  const copy = element("span");
  const folderCount = children.get(item.id)?.length ?? 0;
  const caption = item.kind === "disk"
    ? [item.technology, item.interface, item.capacity].filter(Boolean).join(" · ")
    : searching
      ? ancestors(item.parent).map(({ name }) => name).join(" › ")
      : `${folderCount} ${folderCount === 1 ? "carpeta" : "carpetas"}`;
  copy.append(element("span", item.name, "card-name"), element("span", caption, "meta"));
  open.append(glyph, copy);
  const more = button("•••", () => showActions(item), "more");
  more.dataset.focus = `more-${item.id}`;
  more.setAttribute("aria-label", `Acciones de ${item.name}`);
  article.append(open, more);
  return article;
}

function normalize(value) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function render() {
  const focusKey = document.activeElement?.dataset.focus;
  const location = items.get(current);
  const query = normalize(search.value.trim());
  const results = query
    ? [...items.values()].filter((item) => normalize(item.name).includes(query))
      .sort((a, b) => collator.compare(a.name, b.name))
    : children.get(current) ?? [];
  byId("heading").textContent = location?.name ?? "Discos";
  byId("summary").textContent = location?.kind === "disk"
    ? [location.technology, location.interface, location.capacity].filter(Boolean).join(" · ")
    : location ? "" : "Organiza y encuentra el material de tu equipo.";
  byId("summary").hidden = !byId("summary").textContent;
  add.textContent = current ? "＋ Nueva carpeta" : "＋ Nuevo disco";
  path.hidden = !current || Boolean(query);
  path.replaceChildren();
  if (!path.hidden) {
    path.append(button("Discos", () => openLocation(null)));
    for (const item of ancestors(current)) {
      path.append(element("span", "›"));
      const segment = item.id === current
        ? element("span", item.name)
        : button(item.name, () => openLocation(item.id));
      if (item.id === current) segment.setAttribute("aria-current", "location");
      path.append(segment);
    }
  }
  byId("section-title").textContent = query ? "Resultados" : current ? "Carpetas" : "Tus discos";
  byId("count").textContent = snapshot ? String(results.length) : "";
  list.classList.toggle("rows", Boolean(query || current || !results.length));
  const emptyText = !configured ? "La conexión compartida está pendiente de configuración."
    : !snapshot ? "Esperando el inventario compartido."
      : query ? "No se encontraron coincidencias."
        : current ? "Esta ubicación aún no tiene carpetas." : "Agrega el primer disco del inventario.";
  list.replaceChildren(...(results.length
    ? results.map((item) => card(item, Boolean(query)))
    : [element("p", emptyText, "empty")]));
  if (focusKey) list.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus();
}

function showPanel(title, content, action, nextOperation) {
  byId("dialog-title").textContent = title;
  fields.replaceChildren(...content);
  error.hidden = true;
  operation = nextOperation;
  save.hidden = !action;
  save.textContent = action ?? "";
  save.classList.toggle("danger", nextOperation?.action === "delete");
  save.disabled = !ready;
  if (!dialog.open) {
    focusAfterClose = document.activeElement;
    dialog.showModal();
  }
  fields.querySelector("input,select,button")?.focus();
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

function showEdit(item) {
  const kind = item?.kind ?? (current ? "folder" : "disk");
  const type = kind === "disk" ? "disco" : "carpeta";
  const content = [field("Nombre", input("name", item?.name, 120, true))];
  if (kind === "disk") {
    const technology = select("technology");
    for (const option of ["HDD", "SSD", "Otro"]) technology.add(new Option(option, option));
    technology.value = item?.technology ?? "HDD";
    content.push(field("Tecnología", technology),
      field("Interfaz", input("interface", item?.interface, 60)),
      field("Capacidad", input("capacity", item?.capacity, 60)));
  }
  showPanel(item ? `Editar ${type}` : kind === "disk" ? "Nuevo disco" : "Nueva carpeta",
    content, "Guardar", {
      action: item ? "edit" : "create", id: item?.id ?? crypto.randomUUID(),
      kind, parent: item?.parent ?? current, version: item?.version,
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
      if (excluded.has(node.id)) continue;
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
  showPanel("Mover carpeta", content, destination.options.length > 1 ? "Mover aquí" : null,
    { action: "move", id: item.id, version: item.version });
}

function showActions(item) {
  const actions = [button("Editar nombre y datos", () => showEdit(item), "action")];
  if (item.kind === "folder") actions.push(button("Mover a otra ubicación", () => showMove(item), "action"));
  actions.push(button("Eliminar del inventario", () => {
    const count = branch(item.id).size - 1;
    showPanel("Eliminar del inventario", [
      element("p", count
        ? `Se eliminará «${item.name}» y ${count} ${count === 1 ? "carpeta de su interior" : "carpetas de su interior"}.`
        : `Se eliminará «${item.name}».`),
    ], "Eliminar", { action: "delete", id: item.id, version: item.version, revision: snapshot.revision });
  }, "action danger"));
  for (const action of actions) action.disabled = !ready;
  if (!ready) actions.unshift(element("p", "Conéctate al inventario para editar."));
  showPanel(item.name, actions);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!operation || saving || !ready) return;
  const request = { ...operation, ...Object.fromEntries(new FormData(form)) };
  saving = true;
  error.hidden = true;
  save.disabled = byId("cancel").disabled = byId("close").disabled = true;
  try {
    applySnapshot(await rpc("archivus_write", { change: request }));
    dialog.close();
    byId("notice").textContent = ({ create: "Registro agregado.", edit: "Cambios guardados.",
      move: "Carpeta movida con todo su contenido.", delete: "Registro eliminado." })[request.action];
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
    void refresh();
  } finally {
    saving = false;
    save.disabled = !ready;
    byId("cancel").disabled = byId("close").disabled = false;
  }
});

dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
dialog.addEventListener("close", () => {
  const key = focusAfterClose?.dataset.focus;
  const target = focusAfterClose?.isConnected ? focusAfterClose
    : key && list.querySelector(`[data-focus="${CSS.escape(key)}"]`);
  (target || byId("home")).focus();
});
byId("close").addEventListener("click", () => dialog.close());
byId("cancel").addEventListener("click", () => dialog.close());
byId("home").addEventListener("click", () => openLocation(null));
add.addEventListener("click", () => showEdit());
search.addEventListener("input", render);
window.addEventListener("online", refresh);
window.addEventListener("offline", () => setStatus(snapshot ? "Sin conexión · copia local" : "Sin conexión"));
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });

if (snapshot) applySnapshot(snapshot);
else render();
if (configured) {
  if (!navigator.onLine) setStatus(snapshot ? "Sin conexión · copia local" : "Sin conexión");
  void refresh();
  setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
} else {
  setStatus("Conexión pendiente");
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);
