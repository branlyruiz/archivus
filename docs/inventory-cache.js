export function inventoryCache(key) {
  let open;
  const metaKey = `revision:${key}`;
  const stageKey = `download:${key}`;
  const rowRange = () => IDBKeyRange.bound([key, ""], [key, "\uffff"]);
  const pageRange = () => IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]);

  function database() {
    if (!open) {
      open = new Promise((resolve, reject) => {
        const request = indexedDB.open("archivus-offline", 2);
        request.onupgradeneeded = () => {
          for (const store of ["inventories", "rows", "pages"]) {
            if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
          }
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => {
            request.result.close();
            open = null;
          };
          resolve(request.result);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => { open = null; reject(new Error("Copia local ocupada")); };
      }).catch(() => null);
    }
    return open;
  }

  async function transaction(names, mode, run) {
    try {
      const db = await database();
      if (!db) return null;
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(names, mode);
        const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
        let result;
        tx.oncomplete = () => resolve(result ?? true);
        tx.onabort = () => reject(tx.error);
        run(stores, (value) => { result = value ?? false; });
      });
    } catch {
      return null;
    }
  }

  function load() {
    return transaction(["inventories", "rows"], "readonly", ({ inventories, rows }, done) => {
      const meta = inventories.get(metaKey);
      meta.onsuccess = () => {
        if (meta.result == null) {
          const legacy = inventories.get(key);
          legacy.onsuccess = () => done(legacy.result);
        } else {
          const read = rows.getAll(rowRange());
          read.onsuccess = () => done({ revision: meta.result, items: read.result });
        }
      };
    });
  }

  const revision = () => transaction(["inventories"], "readonly", ({ inventories }, done) => {
    const read = inventories.get(metaKey);
    read.onsuccess = () => done(read.result);
  });

  const checkpoint = () => transaction(["inventories", "pages"], "readonly", ({ inventories, pages }, done) => {
    const head = inventories.get(stageKey);
    head.onsuccess = () => {
      if (!head.result) return done(null);
      const read = pages.getAll(pageRange());
      read.onsuccess = () => done({ ...head.result, pages: read.result });
    };
  });

  function savePage(stage, records) {
    return transaction(["inventories", "pages"], "readwrite", ({ inventories, pages }) => {
      if (stage.index === 0) pages.delete(pageRange());
      pages.put(records, [key, stage.index]);
      inventories.put(stage, stageKey);
    });
  }

  function discard() {
    return transaction(["inventories", "pages"], "readwrite", ({ inventories, pages }) => {
      pages.delete(pageRange());
      inventories.delete(stageKey);
    });
  }

  function commit(base, target, from, records, currentItems) {
    return transaction(["inventories", "rows", "pages"], "readwrite", ({ inventories, rows, pages }, done) => {
      const meta = inventories.get(metaKey);
      meta.onsuccess = () => {
        if (meta.result != null && meta.result > target && meta.result !== base) return done(false);
        if (from < 0 || meta.result !== from) {
          rows.delete(rowRange());
          if (from >= 0) for (const item of currentItems.values()) rows.put(item, [key, item.id]);
        }
        for (const [id, item] of records) {
          if (item) rows.put(item, [key, id]);
          else rows.delete([key, id]);
        }
        inventories.put(target, metaKey);
        pages.delete(pageRange());
        inventories.delete(stageKey);
      };
    });
  }

  return { load, revision, checkpoint, savePage, discard, commit };
}
