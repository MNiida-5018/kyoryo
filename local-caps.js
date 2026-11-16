/* オフライン版：保存先をこのiPad（ブラウザのIndexedDB）にする。
   アプリ本体が使う db / assets / downloads / user と同じ形の機能をここで用意する。 */
(function(){
  const DBN = 'kyoryo-viewer', VER = 1;
  let _db = null;
  function open(){
    if(_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(DBN, VER);
      r.onupgradeneeded = () => { const d = r.result; if(!d.objectStoreNames.contains('docs')) d.createObjectStore('docs'); if(!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs'); };
      r.onsuccess = () => { _db = r.result; res(_db); };
      r.onerror = () => rej(r.error);
    });
  }
  async function tx(store, mode, fn){
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store); let out;
      Promise.resolve(fn(s)).then(v => { out = v; });
      t.oncomplete = () => Promise.resolve().then(() => res(out)); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const clean = p => String(p).replace(/^\/+|\/+$/g, '');

  /* ---------- db ---------- */
  const listeners = new Map();   // collection path -> Set(cb)
  async function readCol(col){
    col = clean(col);
    const lo = col + '/', hi = col + '/￿';
    const [keys, vals] = await tx('docs', 'readonly', s => Promise.all([req(s.getAllKeys(IDBKeyRange.bound(lo, hi))), req(s.getAll(IDBKeyRange.bound(lo, hi)))]));
    const docs = [];
    keys.forEach((k, i) => { const id = k.slice(lo.length); if(id && !id.includes('/')){ const v = vals[i]; docs.push({id, exists: true, data: () => structuredClone(v)}); } });
    return {docs, size: docs.length, empty: !docs.length, metadata: {fromCache: false}};
  }
  function notify(path){
    const col = clean(path).split('/').slice(0, -1).join('/');
    const set = listeners.get(col); if(!set || !set.size) return Promise.resolve();
    return readCol(col).then(snap => set.forEach(cb => { try{ cb(snap); }catch(e){ console.error(e); } }));
  }
  // 別のタブで変わったときも反映
  let bc = null; try{ bc = new BroadcastChannel('kyoryo-docs'); bc.onmessage = e => notify(e.data); }catch(e){}
  const changed = p => { if(bc) bc.postMessage(p); return notify(p); };
  const db = {
    collection(col){
      return {
        get: () => readCol(col),
        onSnapshot(cb, err){
          const c = clean(col); if(!listeners.has(c)) listeners.set(c, new Set()); listeners.get(c).add(cb);
          readCol(c).then(cb, e => err && err(e));
          return () => listeners.get(c).delete(cb);
        }
      };
    },
    doc(path){
      const p = clean(path);
      return {
        id: p.split('/').pop(),
        async get(){ const v = await tx('docs', 'readonly', s => req(s.get(p))); return {id: p.split('/').pop(), exists: v !== undefined, data: () => v === undefined ? undefined : structuredClone(v)}; },
        async set(data, opt){ const v = structuredClone(data);
          await tx('docs', 'readwrite', s => { if(opt && opt.merge){ const g = s.get(p); g.onsuccess = () => s.put(Object.assign({}, g.result || {}, v), p); } else s.put(v, p); }); await await changed(p); },
        async update(data){ const v = structuredClone(data); let missing = false;
          await tx('docs', 'readwrite', s => { const g = s.get(p); g.onsuccess = () => { if(g.result === undefined){ missing = true; return; } s.put(Object.assign({}, g.result, v), p); }; });
          if(missing) throw Object.assign(new Error('not found'), {code: 'not_found'}); await await changed(p); },
        async delete(){ await tx('docs', 'readwrite', s => { s.delete(p); }); await changed(p); }
      };
    },
    // バックアップ用
    async _dump(prefix){ prefix = clean(prefix); const lo = prefix, hi = prefix + '￿';
      const [keys, vals] = await tx('docs', 'readonly', s => Promise.all([req(s.getAllKeys(IDBKeyRange.bound(lo, hi))), req(s.getAll(IDBKeyRange.bound(lo, hi)))]));
      return keys.map((k, i) => [k, vals[i]]).filter(([k]) => k === prefix || k.startsWith(prefix + '/')); },
    async _put(path, v){ await tx('docs', 'readwrite', s => { s.put(v, clean(path)); }); await changed(path); }
  };

  /* ---------- assets（写真・図面のファイル） ---------- */
  const urlCache = new Map();
  const newId = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const assets = {
    async upload(blob, opt){ const id = newId(), type = (opt && opt.type) || blob.type || 'application/octet-stream';
      const b = blob instanceof Blob ? blob : new Blob([blob], {type});
      await tx('blobs', 'readwrite', s => { s.put({blob: b, type}, id); });
      return {id, size: b.size, type}; },
    async delete(id){ await tx('blobs', 'readwrite', s => { s.delete(id); }); const u = urlCache.get(id); if(u){ URL.revokeObjectURL(u); urlCache.delete(id); } },
    async get(id){ const v = await tx('blobs', 'readonly', s => req(s.get(id))); return v ? v.blob : null; },
    async _put(id, blob, type){ await tx('blobs', 'readwrite', s => { s.put({blob, type: type || blob.type}, id); }); },
    async preload(ids){ for(const id of ids){ if(urlCache.has(id)) continue; const b = await assets.get(id); if(b) urlCache.set(id, URL.createObjectURL(b)); } },
    url(id){ return urlCache.get(id) || ('_blob/' + id); }
  };

  /* ---------- downloads ---------- */
  const downloads = {
    async save({filename, data, type}){
      const blob = data instanceof Blob ? data : new Blob([data], {type: type || (/\.json$/i.test(filename) ? 'application/json' : /\.csv$/i.test(filename) ? 'text/csv' : 'application/octet-stream')});
      // iPadでは「共有」から「ファイルに保存」できる
      try{ const f = new File([blob], filename, {type: blob.type}); if(navigator.canShare && navigator.canShare({files: [f]}) && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document){ await navigator.share({files: [f]}); return; } }
      catch(e){ if(e && e.name === 'AbortError') throw Object.assign(new Error('declined'), {code: 'declined'}); }
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }
  };

  /* ---------- user ---------- */
  let uid = null; try{ uid = localStorage.getItem('kyoryo-uid'); if(!uid){ uid = 'u' + Math.random().toString(36).slice(2, 10); localStorage.setItem('kyoryo-uid', uid); } }catch(e){ uid = 'local'; }
  const user = { id: async () => uid, can: async () => true };

  const caps = {db, assets, downloads, user};
  window.LOCAL_MODE = true;
  window.LOCAL_CAPS = caps;
  window.claude = { use: async n => { if(!caps[n]) throw new Error('unavailable'); return caps[n]; } };

  // データを消されにくくする
  try{ navigator.storage && navigator.storage.persist && navigator.storage.persist(); }catch(e){}
})();
