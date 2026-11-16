/* 橋梁点検ビューア — PDF解析（様式ごとのプロファイル）
 * 依存: pdf.js (pdfjsLib)
 */
(function(global){
'use strict';
const U = () => global.pdfjsLib.Util;

/* ---------- 共通ユーティリティ ---------- */
function charW(c){ return /[\x00-\x7f｡-ﾟ]/.test(c) ? 0.5 : 1.0; }

async function textLines(page, vp){
  const tc = await page.getTextContent();
  const items = [];
  for(const it of tc.items){
    if(!it.str || !it.str.trim()) continue;
    const m = U().transform(vp.transform, it.transform);
    const fh = Math.hypot(m[2], m[3]);
    const ang = Math.atan2(m[1], m[0]);
    const w = it.width * vp.scale;
    items.push({s: it.str, x: m[4], y: m[5], fh, ang, w});
  }
  return items;
}
function dominantAngle(items){
  const c = {};
  for(const it of items){ const a = Math.round(it.ang / (Math.PI/2)); c[a] = (c[a]||0) + 1; }
  let best = 0, n = -1; for(const k in c) if(c[k] > n){ n = c[k]; best = +k; }
  return best; // 0: 横, -1: 上向き, 1: 下向き
}
/* 水平テキストを行にまとめ、1文字ずつの位置も持たせる */
function mergeLines(items){
  const hs = items.filter(it => Math.abs(it.ang) < 0.3).sort((a,b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for(const it of hs){
    // 1文字ずつの位置（等幅の全角/半角比で配分）
    const units = [...it.s].map(charW), tot = units.reduce((a,b)=>a+b,0) || 1;
    let cx = it.x; const chars = [];
    [...it.s].forEach((c,i) => { const cw = it.w * units[i] / tot; chars.push({c, x0: cx, x1: cx + cw}); cx += cw; });
    const L = lines.find(l => Math.abs(l.y - it.y) < it.fh * 0.35 && it.x - l.x1 < it.fh * 0.8 && it.x - l.x1 > -it.fh * 0.5);
    if(L){ L.chars.push(...chars); L.x1 = Math.max(L.x1, it.x + it.w); L.fh = Math.max(L.fh, it.fh); }
    else lines.push({y: it.y, x0: it.x, x1: it.x + it.w, fh: it.fh, chars});
  }
  for(const l of lines){
    l.chars.sort((a,b) => a.x0 - b.x0);
    l.t = l.chars.map(c => c.c).join('').trim();
    l.y0 = l.y - l.fh * 0.88; l.y1 = l.y + l.fh * 0.12;
  }
  return lines.filter(l => l.t);
}
async function imageBoxes(page, vp){
  const ops = await page.getOperatorList(), OPS = global.pdfjsLib.OPS;
  let ctm = [1,0,0,1,0,0]; const stack = [], out = [];
  const imgOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter(v => v != null));
  for(let i = 0; i < ops.fnArray.length; i++){
    const fn = ops.fnArray[i], a = ops.argsArray[i];
    if(fn === OPS.save) stack.push(ctm.slice());
    else if(fn === OPS.restore) ctm = stack.pop() || ctm;
    else if(fn === OPS.transform) ctm = U().transform(ctm, a);
    else if(fn === OPS.paintFormXObjectBegin){ stack.push(ctm.slice()); if(a && a[0]) ctm = U().transform(ctm, a[0]); }
    else if(fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if(imgOps.has(fn)){
      const m = U().transform(vp.transform, ctm);
      const pts = [[0,0],[1,0],[0,1],[1,1]].map(([u,v]) => [m[0]*u + m[2]*v + m[4], m[1]*u + m[3]*v + m[5]]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const b = {x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys)};
      if((b.x1 - b.x0) > 30 && (b.y1 - b.y0) > 30) out.push(b);
    }
  }
  return out;
}
/* ページの向きを文字の向きから判断（台帳は横書きA4を90°回して配置されている） */
async function pageView(page, scale){
  const vp0 = page.getViewport({scale: 1});
  const items0 = await textLines(page, vp0);
  const dom = dominantAngle(items0);
  const extra = dom === -1 ? 90 : dom === 1 ? 270 : 0;
  const rotation = (page.rotate + extra) % 360;
  return {rotation, vp: page.getViewport({scale: scale || 1, rotation})};
}

/* ---------- 既存旗揚げ文字の分解 ---------- */
const NOISE = /^([AP]\d+|表\s*示|損傷の種類|漏\s*水|う\s*き|そ\s*の\s*他|ひびわれ|剥\s*離|鉄筋露出|遊離石灰|FLOW)$/;
const DMG = /^(.+?)-([a-e]|補修済)(.*)$/;
const SIZE = /(\d+(\.\d+)?\s*m?\s*[×x]\s*\d|^[〇○]m|\d+(\.\d+)?\s*mm|^凹|^\d+(\.\d+)?m$)/;
const norm = s => s.replace(/･/g, '・').replace(/：/g, ':').trim();
function splitMember(s){
  if(s.startsWith('※')) return [s, ''];
  const m = s.match(/^(.*?)(\d+)(\(.+\))?$/);
  if(m && m[1]) return [m[1] + (m[3] || ''), m[2]];
  return [s, ''];
}
function parseItemLines(lines){
  const rows = []; let member = null; const extra = [];
  const add = text => { const d = text.match(DMG);
    rows.push(d ? {member, t: d[1].trim(), g: d[2], detail: d[3].trim(), size: '', note: ''} : {member, t: text.trim(), g: '', detail: '', size: '', note: ''}); };
  for(const raw of lines){
    const s = norm(raw);
    if(!s || NOISE.test(s)) continue;
    const mm = s.match(/^([^:]+?):(.*)$/);
    if(mm && !DMG.test(mm[1])){
      member = mm[1].trim(); rows.forEach(r => { if(r.member == null) r.member = member; });
      if(mm[2].trim()) add(mm[2].trim()); continue;
    }
    if(DMG.test(s)){ add(s); continue; }
    if(rows.length && SIZE.test(s)){ const r = rows[rows.length-1]; r.size = (r.size + ' ' + s).trim(); }
    else if(rows.length){ const r = rows[rows.length-1]; r.note = (r.note + ' ' + s).trim(); }
    else extra.push(s);
  }
  for(const r of rows){ [r.member, r.mno] = splitMember(r.member || ''); if(extra.length) r.note = (extra.join(' ') + ' ' + r.note).trim(); }
  return rows;
}
function parseNote(s){
  const m = norm(s).match(/^[①-⑳](.+?)(?:の全体に|の全箇所に|に)、?\s*〔(.+?)〕/);
  if(!m) return [];
  return m[2].split(/[、,]/).map(d => d.trim()).filter(Boolean).map(d => { const x = d.match(DMG);
    return {member: m[1].trim(), mno: '', t: (x ? x[1] : d).trim(), g: x ? x[2] : '', detail: '', size: '', note: '全体（代表箇所）'}; });
}

/* ================= 市町村版（損傷図 ＋ 損傷写真台帳） ================= */
const LABEL = /【?([^【】\s]+?)】\s*写真\s*[:：]\s*([0-9,，、\s]+)/;

async function parseDiagram(doc, onProg){
  const pages = []; let bridge = '';
  for(let i = 1; i <= doc.numPages; i++){
    onProg && onProg(`損傷図 ${i}/${doc.numPages}`);
    const page = await doc.getPage(i);
    const {rotation, vp} = await pageView(page, 1);
    const lines = mergeLines(await textLines(page, vp));
    for(const l of lines){ if(l.t.includes('【損傷図】')) bridge = l.t.replace('【損傷図】', '').trim(); }
    let title = '';
    for(const l of [...lines].sort((a,b) => a.y - b.y || a.x0 - b.x0)){
      if(!/損傷図|写真/.test(l.t) && l.t.length <= 24){ title = l.t; break; }
    }
    const labels = [];
    for(const l of lines){
      const m = l.t.match(LABEL); if(!m) continue;
      const full = l.chars.map(c => c.c).join('');
      const start = full.indexOf('写真');
      const groups = []; let cur = [];
      l.chars.slice(start).forEach(c => { if(/[0-9]/.test(c.c)) cur.push(c); else { if(cur.length) groups.push(cur); cur = []; } });
      if(cur.length) groups.push(cur);
      labels.push({line: l, point: m[1].trim(), nums: groups.map(g => ({num: g.map(c => c.c).join(''),
        rect: [g[0].x0, l.y0, g[g.length-1].x1, l.y1]}))});
    }
    // 見出しの下に続く行（損傷内容）
    const isLabel = l => LABEL.test(l.t);
    const existing = labels.map(lb => {
      const L = lb.line, follow = []; let lastY = L.y;
      const cands = lines.filter(l => l !== L && l.y > L.y && l.y < L.y + L.fh * 12 && l.x0 >= L.x0 - 3 && l.x0 <= L.x1 + 3).sort((a,b) => a.y - b.y);
      for(const l of cands){ if(isLabel(l)) break; if(l.y - lastY > L.fh * 1.75) break; follow.push(l.t); lastY = l.y; }
      return {point: lb.point, nums: lb.nums.map(n => n.num), line: [L.x0, L.y0, L.x1, L.y1], rows: parseItemLines(follow)};
    });
    const notes = lines.filter(l => /^[①-⑳]/.test(l.t)).flatMap(l => parseNote(l.t));
    // 状況写真の欄（例：桁下面全景（起点側）写真： ／ 橋歴板　　写真：）
    const situ = [];
    for(const l of lines){
      if(/[【】]/.test(l.t) || !/写真\s*[:：]\s*[0-9,，、\s]*$/.test(l.t)) continue;
      let name, x0 = l.x0;
      const m = l.t.match(/^(.*?)[\s　]*写真\s*[:：]\s*([0-9,，、\s]*)$/);
      name = (m ? m[1] : '').replace(/[\s　]+/g, '');
      if(!name){
        const left = lines.filter(o => o !== l && Math.abs(o.y - l.y) < l.fh * 0.4 && o.x1 <= l.x0 + 1 && l.x0 - o.x1 < 160 && !/写真/.test(o.t)).sort((a,b) => b.x1 - a.x1)[0];
        if(!left) continue; name = left.t.replace(/[\s　]+/g, ''); x0 = left.x0;
      }
      situ.push({name, nums: m ? (m[2].match(/\d+/g) || []) : [], line: [x0, l.y0, l.x1, l.y1]});
    }
    pages.push({w: vp.width, h: vp.height, rotation, title: title || `p${i}`,
      labels: labels.map(lb => ({point: lb.point, line: [lb.line.x0, lb.line.y0, lb.line.x1, lb.line.y1], nums: lb.nums})),
      existing, notes, situ});
  }
  return {bridge, pages};
}

async function parseLedger(doc, onProg, cropper){
  const photos = [];
  for(let i = 1; i <= doc.numPages; i++){
    onProg && onProg(`写真台帳 ${i}/${doc.numPages}`);
    const page = await doc.getPage(i);
    const {rotation, vp} = await pageView(page, 1);
    const lines = mergeLines(await textLines(page, vp));
    if(!lines.some(l => l.t.includes('損傷写真台帳'))) continue;
    const anchors = lines.filter(l => l.t === '写真番号');
    if(!anchors.length) continue;
    const imgs = await imageBoxes(page, vp);
    const slots = [];
    for(const A of anchors){
      const box = {x0: A.x0 - 14, x1: A.x0 + 112, y0: A.y0 - 16, y1: A.y0 + 134};
      const inBox = lines.filter(l => l.x0 >= box.x0 && l.x0 <= box.x1 && l.y >= box.y0 && l.y <= box.y1);
      const lab = t => inBox.find(l => l.t.replace(/\s|　/g, '') === t);
      const right = t => { const L = lab(t); if(!L) return '';
        const c = inBox.filter(l => l !== L && Math.abs(l.y - L.y) < L.fh * 0.5 && l.x0 > L.x1 + 1).sort((a,b) => a.x0 - b.x0);
        return c.length ? c[0].t.trim() : ''; };
      const zuL = lab('関連損傷図名'), memoL = lab('メモ');
      const zu = (zuL && memoL) ? inBox.filter(l => l.y > zuL.y + 1 && l.y < memoL.y - 1).map(l => l.t).join(' ') : '';
      const memo = memoL ? inBox.filter(l => l.y > memoL.y + 1).sort((a,b) => a.y - b.y || a.x0 - b.x0).map(l => l.t) : [];
      const img = imgs.find(b => { const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2; return cy > box.y0 && cy < box.y1 && cx < A.x0 && cx > A.x0 - 300; });
      const rec = {num: right('写真番号'), point: right('撮影ポイント'), span: right('径間番号'), date: right('撮影日'),
        member: right('部材名称'), mno: right('部材番号'), pos: right('損傷発生位置'), zu, memo, ledger_page: i, img: img || null};
      photos.push(rec); slots.push(rec);
    }
    if(cropper) await cropper(page, rotation, slots);
  }
  photos.forEach((p, i) => p.id = i);
  return photos;
}

function link(dia, photos){
  const key = new Map(photos.map(p => [p.point + '|' + p.num, p.id]));
  const unresolved = [];
  dia.pages.forEach((pg, pi) => {
    pg.spots = [];
    for(const lb of pg.labels){
      const ids = [], rects = [];
      for(const n of lb.nums){
        const id = key.get(lb.point + '|' + n.num);
        if(id == null){ unresolved.push({page: pi + 1, point: lb.point, num: n.num}); continue; }
        ids.push(id); rects.push(n.rect);
      }
      if(ids.length) pg.spots.push({ids, nums: rects, line: lb.line, point: lb.point});
    }
    const sp = new Set(); pg.spots.forEach(s => s.ids.forEach(id => sp.add(String(photos[id].num)[0])));
    pg.span = [...sp].sort().join('・');
    delete pg.labels;
  });
  return unresolved;
}

/* 写真の切り出し → スプライトシート */
function makeCropper({scale = 4, cellW = 768, cellH = 576, cols = 4, rows = 6} = {}){
  const per = cols * rows; let sheet = null, ctx = null, n = 0; const sheets = [];
  const page = document.createElement('canvas'), pctx = page.getContext('2d');
  function newSheet(){ sheet = document.createElement('canvas'); sheet.width = cellW * cols; sheet.height = cellH * rows; ctx = sheet.getContext('2d'); ctx.fillStyle = '#111'; ctx.fillRect(0,0,sheet.width,sheet.height); }
  async function crop(pdfPage, rotation, slots){
    const vp = pdfPage.getViewport({scale, rotation});
    page.width = Math.ceil(vp.width); page.height = Math.ceil(vp.height);
    pctx.fillStyle = '#fff'; pctx.fillRect(0,0,page.width,page.height);
    await pdfPage.render({canvasContext: pctx, viewport: vp}).promise;
    for(const s of slots){
      if(!s.img){ s.sheet = null; continue; }
      if(n % per === 0){ if(sheet) sheets.push(await toBlob(sheet)); newSheet(); }
      const k = n % per, cx = (k % cols) * cellW, cy = Math.floor(k / cols) * cellH;
      const sx = s.img.x0 * scale, sy = s.img.y0 * scale, sw = (s.img.x1 - s.img.x0) * scale, sh = (s.img.y1 - s.img.y0) * scale;
      const f = Math.min(cellW / sw, cellH / sh), dw = sw * f, dh = sh * f;
      ctx.drawImage(page, sx, sy, sw, sh, cx + (cellW - dw) / 2, cy + (cellH - dh) / 2, dw, dh);
      s.sheet = sheets.length; s.cell = k; n++;
    }
  }
  async function finish(){ if(sheet && n > sheets.length * per) sheets.push(await toBlob(sheet)); sheet = null; return {sheets, cellW, cellH, cols, rows}; }
  return {crop, finish};
}
function toBlob(c){ return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/jpeg', 0.85)); }

/* ================= プロファイル ================= */
const PROFILES = {
  municipal: {
    label: '市町村版', desc: '損傷図PDF ＋ 損傷写真台帳PDF（道路橋定期点検 様式）', ready: true,
    inputs: [{key: 'dia', label: '損傷図PDF', required: true}, {key: 'led', label: '損傷写真台帳PDF', required: true}],
    async parse(files, onProg){
      const diaDoc = await global.pdfjsLib.getDocument({data: files.dia.slice(0), isEvalSupported: false}).promise;
      const dia = await parseDiagram(diaDoc, onProg);
      const ledDoc = await global.pdfjsLib.getDocument({data: files.led.slice(0), isEvalSupported: false}).promise;
      const cropper = makeCropper();
      const photos = await parseLedger(ledDoc, onProg, cropper.crop);
      onProg && onProg('写真を保存用にまとめています');
      const sprite = await cropper.finish();
      const unresolved = link(dia, photos);
      photos.forEach(p => { delete p.img; });
      return {bridge: dia.bridge, pages: dia.pages, photos, unresolved, sprite};
    }
  },
  mlit: {label: '国（直轄）版', desc: '国土交通省 直轄 様式（準備中：サンプルPDFが必要です）', ready: false},
};

global.BridgeParser = {PROFILES, parseItemLines, parseNote, _internal: {parseDiagram, parseLedger, link, mergeLines, textLines, makeCropper}};
})(window);

/* ================= 北海道版（損傷図＝文字が図形化したPDF ＋ 点検調書PDF） ================= */
(function(global){
'use strict';
const BP = global.BridgeParser;
const U = () => global.pdfjsLib.Util;
const TESS = {workerPath: 'lib/tess/worker.min.js', corePath: 'lib/tess', langPath: 'lib/tess/fast', gzip: true, workerBlobURL: false, cachePath: 'bridge-ocr-v1', cacheMethod: 'readOnly'};
const norm = s => String(s||'').replace(/[\s　]+/g, '');

async function items(page, vp){
  const tc = await page.getTextContent(); const out = [];
  for(const it of tc.items){ if(!it.str || !it.str.trim()) continue;
    const m = U().transform(vp.transform, it.transform); const fh = Math.hypot(m[2], m[3]);
    out.push({t: it.str.trim(), x0: m[4], y: m[5], x1: m[4] + it.width * vp.scale, fh, y0: m[5] - fh * 0.88, y1: m[5] + fh * 0.12}); }
  return out;
}
async function imageBoxes(page, vp){
  const ops = await page.getOperatorList(), OPS = global.pdfjsLib.OPS; let ctm = [1,0,0,1,0,0]; const st = [], out = [];
  for(let i = 0; i < ops.fnArray.length; i++){ const fn = ops.fnArray[i], a = ops.argsArray[i];
    if(fn === OPS.save) st.push(ctm.slice()); else if(fn === OPS.restore) ctm = st.pop() || ctm; else if(fn === OPS.transform) ctm = U().transform(ctm, a);
    else if(fn === OPS.paintFormXObjectBegin){ st.push(ctm.slice()); if(a && a[0]) ctm = U().transform(ctm, a[0]); } else if(fn === OPS.paintFormXObjectEnd) ctm = st.pop() || ctm;
    else if(fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintInlineImageXObject){
      const m = U().transform(vp.transform, ctm); const P = [[0,0],[1,0],[0,1],[1,1]].map(([u,v]) => [m[0]*u+m[2]*v+m[4], m[1]*u+m[3]*v+m[5]]);
      const b = {x0: Math.min(...P.map(p=>p[0])), y0: Math.min(...P.map(p=>p[1])), x1: Math.max(...P.map(p=>p[0])), y1: Math.max(...P.map(p=>p[1]))};
      if(b.x1 - b.x0 > 60 && b.y1 - b.y0 > 60) out.push(b); } }
  return out;
}

/* ---- 点検調書：損傷写真ページ ---- */
async function parseChosho(doc, onProg, cropper){
  const photos = []; let bridge = '', code = '';
  for(let i = 1; i <= doc.numPages; i++){
    if(i % 5 === 1) onProg && onProg(`点検調書 ${i}/${doc.numPages}`);
    const page = await doc.getPage(i); const vp = page.getViewport({scale: 1});
    const L = await items(page, vp);
    if(!L.some(l => l.t === '損傷写真')) continue;
    if(!bridge){ const b = L.find(l => norm(l.t) === '橋梁名'); if(b){ const v = L.filter(o => Math.abs(o.y - b.y) < 3 && o.x0 > b.x1 + 5).sort((a,c)=>a.x0-c.x0)[0]; if(v) bridge = v.t; }
      const c = L.find(l => norm(l.t) === '橋梁コード'); if(c){ const v = L.filter(o => Math.abs(o.y - c.y) < 3 && o.x0 > c.x1 + 5).sort((a,c2)=>a.x0-c2.x0)[0]; if(v) code = v.t; } }
    const anchors = L.filter(l => norm(l.t) === '写真番号').sort((a,b) => a.y - b.y);
    if(!anchors.length) continue;
    const imgs = await imageBoxes(page, vp); const slots = [];
    anchors.forEach((A, k) => {
      const yTop = A.y0 - 6, yBot = k + 1 < anchors.length ? anchors[k+1].y0 - 6 : A.y0 + 215;
      const inS = L.filter(l => l.y >= yTop && l.y <= yBot && l.x0 > A.x0 - 10);
      const lab = t => inS.find(l => norm(l.t) === t);
      const right = (t, maxGap = 200) => { const Lb = lab(t); if(!Lb) return ''; const c = inS.filter(o => o !== Lb && Math.abs(o.y - Lb.y) < Lb.fh * 0.5 && o.x0 > Lb.x1 + 1 && o.x0 - Lb.x1 < maxGap).sort((a,b) => a.x0 - b.x0); return c.length ? c[0].t : ''; };
      const num = right('写真番号', 60), span = right('径間番号', 60), member = right('部材名'), pos = right('損傷箇所');
      const posL = lab('損傷箇所'), causeL = lab('推定原因'), comL = lab('コメント');
      // 損傷と区分：損傷箇所の下〜推定原因の上
      const dmgItems = inS.filter(o => posL && causeL && o.y > posL.y + 3 && o.y < causeL.y - 2).sort((a,b) => (Math.abs(a.y - b.y) < 4 ? 0 : a.y - b.y) || a.x0 - b.x0);
      const dmg = []; for(const o of dmgItems){ if(/^[ⅰⅱⅲⅳⅴi]+$|^OK$|^NG$/i.test(o.t) && dmg.length && !dmg[dmg.length-1].g) dmg[dmg.length-1].g = o.t; else dmg.push({t: o.t, g: ''}); }
      const cause = causeL && comL ? inS.filter(o => o.y > causeL.y + 3 && o.y < comL.y - 2).map(o => o.t).join(' ') : '';
      const comment = comL ? inS.filter(o => o.y > comL.y + 3).sort((a,b) => a.y - b.y || a.x0 - b.x0).map(o => o.t) : [];
      const img = imgs.find(b => { const cy = (b.y0 + b.y1) / 2; return cy > yTop && cy < yBot && b.x1 < A.x0 + 5; });
      const rec = {num, point: '', span, member, mno: '', pos, dmg, cause, comment, date: '', zu: '', ledger_page: i, img: img || null,
        memo: [...dmg.map(d => d.t + (d.g ? '-' + d.g : '')), ...(cause ? ['原因：' + cause] : []), ...comment]};
      photos.push(rec); slots.push(rec);
    });
    if(cropper) await cropper(page, 0, slots);
  }
  photos.forEach((p, i) => p.id = i);
  return {photos, bridge, code};
}

/* ---- 損傷図：文字が図形化されたページを高解像度で描画して文字認識 ---- */
let _workers = null;
function seedCache(key, val){ return new Promise((res, rej) => { const rq = indexedDB.open('keyval-store'); rq.onupgradeneeded = () => rq.result.createObjectStore('keyval');
  rq.onerror = () => rej(rq.error); rq.onsuccess = () => { const db = rq.result; const tx = db.transaction('keyval', 'readwrite'); tx.objectStore('keyval').put(val, key); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); }; }); }
async function getWorkers(n){
  if(_workers) return _workers;
  if(!global.Tesseract) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'lib/tess/tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('文字認識エンジンを読み込めません')); document.head.appendChild(s); });
  const load = async code => { const r = await fetch(`lib/tess/fast/${code}.traineddata.b64.txt`); if(!r.ok) throw new Error('文字認識データを読み込めません'); const b = atob((await r.text()).trim()); const u = new Uint8Array(b.length); for(let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const [jpnData, engData] = await Promise.all([load('jpn'), load('eng')]);
  // 文字認識エンジンの保存領域（IndexedDB）に辞書データを置いておく（エンジンはそこから読む）
  await seedCache(`${TESS.cachePath}/jpn.traineddata`, jpnData); await seedCache(`${TESS.cachePath}/eng.traineddata`, engData);
  const jp = [];
  for(let i = 0; i < n; i++){ const w = await global.Tesseract.createWorker('jpn', 1, TESS); await w.setParameters({tessedit_pageseg_mode: '11'}); jp.push(w); }
  const en = await global.Tesseract.createWorker('eng', 1, TESS);
  await en.setParameters({tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789,.:'});
  _workers = {jp, en};
  return _workers;
}
async function terminateWorkers(){ if(_workers){ for(const w of [..._workers.jp, _workers.en]){ try{ await w.terminate(); }catch(e){} } _workers = null; } }
function wordsOf(data){
  const out = [];
  for(const b of (data.blocks || [])) for(const p of (b.paragraphs || [])) for(const l of (p.lines || [])) for(const w of (l.words || [])) out.push(w);
  if(!out.length && data.words) return data.words;
  return out;
}
const CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
function normCh(c){
  const k = CIRC.indexOf(c); if(k >= 0) return String(k + 1);
  if(/[０-９]/.test(c)) return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  if(/[.,，、．]/.test(c)) return ',';
  if(c === '：') return ':';
  return c;
}
function labelsFromWords(ws, s){
  // 1文字ずつに分解（位置は単語の幅を按分）
  const ch = [];
  for(const w of ws){ const t = (w.text || '').replace(/\s+/g, ''); if(!t) continue;
    const x0 = w.bbox.x0 / s, x1 = w.bbox.x1 / s, y0 = w.bbox.y0 / s, y1 = w.bbox.y1 / s, cs = [...t], cw = (x1 - x0) / cs.length;
    cs.forEach((c, i) => { const n = normCh(c); [...n].forEach((nc, j) => ch.push({c: nc, x0: x0 + cw * i + cw * j / n.length, x1: x0 + cw * i + cw * (j + 1) / n.length, y0, y1})); }); }
  // 行にまとめる
  ch.sort((a, b) => a.x0 - b.x0);
  const rows = [];
  for(const c of ch){ const h = c.y1 - c.y0, cy = (c.y0 + c.y1) / 2;
    const r = rows.find(r => Math.abs(r.cy - cy) < Math.max(r.h, h) * 0.5 && c.x0 - r.x1 < Math.max(r.h, h) * 1.6 && c.x0 - r.x1 > -h);
    if(r){ r.cs.push(c); r.x1 = Math.max(r.x1, c.x1); r.h = Math.max(r.h, h); } else rows.push({cs: [c], cy, h, x1: c.x1}); }
  const out = [];
  for(const r of rows){
    const t = r.cs.map(c => c.c).join('');
    const re = /写真\s*:?\s*([0-9,]*)/g; let m;
    while((m = re.exec(t))){
      const i0 = m.index, numStr = m[1].replace(/^,+|,+$/g, ''), iEnd = m.index + m[0].length;
      const first = r.cs[i0], last = r.cs[Math.max(i0 + 1, iEnd - 1)];
      const y0 = Math.min(...r.cs.slice(i0, iEnd).map(c => c.y0)), y1 = Math.max(...r.cs.slice(i0, iEnd).map(c => c.y1));
      const nums = numStr ? numStr.split(',').filter(Boolean) : [];
      // 番号ごとの位置
      const dStart = iEnd - m[1].length, rects = []; let k = dStart;
      for(const n of nums){ while(k < iEnd && !/\d/.test(r.cs[k].c)) k++; const a = r.cs[k], b = r.cs[Math.min(iEnd - 1, k + n.length - 1)]; rects.push([a.x0, y0, b.x1, y1]); k += n.length; }
      out.push({x0: first.x0, y0, x1: last.x1, y1, nums, rects, xAfter: r.cs[i0 + 1] ? r.cs[i0 + 1].x1 : last.x1});
    }
  }
  return out;
}
function renderRegion(page, rotation, s, rx0, ry0, rw, rh){
  const vp = page.getViewport({scale: s, rotation});
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(rw * s)); c.height = Math.max(1, Math.ceil(rh * s));
  const x = c.getContext('2d', {willReadFrequently: true}); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  return page.render({canvasContext: x, viewport: vp, transform: [1, 0, 0, 1, -rx0 * s, -ry0 * s]}).promise.then(() => c);
}
function cleanCanvas(c, minRun, killLines, clearBorder){
  const x = c.getContext('2d', {willReadFrequently: true}), W = c.width, H = c.height, im = x.getImageData(0, 0, W, H), d = im.data, dark = new Uint8Array(W * H);
  for(let i = 0, p = 0; i < d.length; i += 4, p++){ const r = d[i], g = d[i+1], b = d[i+2]; dark[p] = (r - g > 60 && r - b > 60) ? 0 : (Math.min(r, g, b) < 150 ? 1 : 0); }
  const kill = new Uint8Array(W * H);
  if(killLines){
    for(let y = 0; y < H; y++){ let run = 0; for(let xx = 0; xx <= W; xx++){ const v = xx < W ? dark[y * W + xx] : 0; if(v) run++; else { if(run >= minRun) for(let k = xx - run; k < xx; k++) kill[y * W + k] = 1; run = 0; } } }
    for(let xx = 0; xx < W; xx++){ let run = 0; for(let y = 0; y <= H; y++){ const v = y < H ? dark[y * W + xx] : 0; if(v) run++; else { if(run >= minRun) for(let k = y - run; k < y; k++) kill[k * W + xx] = 1; run = 0; } } }
  }
  if(clearBorder){
    // 枠に接した図形（隣の行や「真」の切れ端）を消す
    for(let p = 0; p < W * H; p++) if(kill[p]) dark[p] = 0;
    const st = [];
    const push = p => { if(dark[p] === 1){ dark[p] = 2; st.push(p); } };
    for(let xx = 0; xx < W; xx++){ push(xx); push((H - 1) * W + xx); }
    for(let y = 0; y < H; y++) push(y * W);
    while(st.length){ const p = st.pop(), xx = p % W, y = (p / W) | 0;
      if(xx > 0) push(p - 1); if(xx < W - 1) push(p + 1); if(y > 0) push(p - W); if(y < H - 1) push(p + W); }
  }
  for(let i = 0, p = 0; i < d.length; i += 4, p++){ const v = dark[p] === 1 && !kill[p] ? 0 : 255; d[i] = d[i+1] = d[i+2] = v; }
  x.putImageData(im, 0, 0); return c;
}
async function detectPass(page, rotation, vp1, s, prep, workers){
  const c = await renderRegion(page, rotation, s, 0, 0, vp1.width, vp1.height);
  cleanCanvas(c, Math.round(14 * s), prep);
  const H = c.height, half = Math.ceil(H / 2), ov = Math.ceil(30 * s), parts = [[0, half + ov], [half - ov, H]];
  const rs = await Promise.all(parts.map(([a, b], i) => { const cc = document.createElement('canvas'); cc.width = c.width; cc.height = b - a; cc.getContext('2d').drawImage(c, 0, a, c.width, b - a, 0, 0, c.width, b - a);
    return workers.jp[i % workers.jp.length].recognize(cc, {}, {blocks: true}).then(r => ({r, off: a})); }));
  const labs = [];
  for(const {r, off} of rs) for(const L of labelsFromWords(wordsOf(r.data).map(w => ({text: w.text, bbox: {x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0 + off, y1: w.bbox.y1 + off}})), s)) labs.push(L);
  return labs;
}
function inkOf(c){ const x = c.getContext('2d', {willReadFrequently: true}), W = c.width, H = c.height, d = x.getImageData(0, 0, W, H).data, a = new Uint8Array(W * H);
  for(let i = 0, p = 0; i < d.length; i += 4, p++) a[p] = d[i] < 128 ? 1 : 0; return {a, W, H}; }
function components(ink){
  const {a, W, H} = ink, lab = new Int32Array(W * H), comps = []; let n = 0;
  for(let p = 0; p < W * H; p++){ if(!a[p] || lab[p]) continue; n++; let x0 = W, y0 = H, x1 = 0, y1 = 0, cnt = 0; const st = [p]; lab[p] = n;
    while(st.length){ const q = st.pop(), xx = q % W, y = (q / W) | 0; cnt++; if(xx < x0) x0 = xx; if(xx > x1) x1 = xx; if(y < y0) y0 = y; if(y > y1) y1 = y;
      const nb = [xx > 0 ? q - 1 : -1, xx < W - 1 ? q + 1 : -1, y > 0 ? q - W : -1, y < H - 1 ? q + W : -1];
      for(const r of nb) if(r >= 0 && a[r] && !lab[r]){ lab[r] = n; st.push(r); } }
    comps.push({id: n, x0, y0, x1, y1, cnt}); }
  return {lab, comps};
}
const GW = 20, GH = 24;
function glyphVec(ink, o){
  // 高さを GH に合わせて縮小し、GW×GH の枠の中央に置いた濃淡ベクトル
  const gh = o.y1 - o.y0 + 1, gw = o.x1 - o.x0 + 1, f = GH / gh, v = new Float32Array(GW * GH), ow = Math.min(GW, gw * f), ox = (GW - ow) / 2;
  for(let y = 0; y < GH; y++) for(let x = 0; x < GW; x++){
    const sx = o.x0 + (x - ox) / f, sy = o.y0 + y / f; if(sx < o.x0 || sx > o.x1 + 0.999) continue;
    let acc = 0; for(let dy = 0; dy < 2; dy++) for(let dx = 0; dx < 2; dx++){ const xx = Math.min(o.x1, Math.floor(sx + dx * 0.5 / f)), yy = Math.min(o.y1, Math.floor(sy + dy * 0.5 / f)); acc += ink.a[yy * ink.W + xx] ? 1 : 0; }
    v[y * GW + x] = acc / 4; }
  let m = 0; for(const t of v) m += t; m /= v.length; let n = 0; for(let i = 0; i < v.length; i++){ v[i] -= m; n += v[i] * v[i]; } n = Math.sqrt(n) || 1; for(let i = 0; i < v.length; i++) v[i] /= n;
  return {v, ar: gw / gh};
}
function corr(a, b){ let s = 0; for(let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
async function readNumbers(page, rotation, L, workers){
  const h = Math.max(4, L.y1 - L.y0), S = 10;
  const rx0 = L.x0 + h * 1.55, ry0 = L.y0 - h * 0.25, rw = h * 9.4, rh = h * 1.5;
  const c = cleanCanvas(await renderRegion(page, rotation, S, rx0, ry0, rw, rh), Math.round(h * S * 2.2), true, true);
  // コロン（小さな点が縦に2つ）を探し、その左側を消す
  let ink = inkOf(c); let {comps} = components(ink); const Hp = ink.H;
  const small = comps.filter(o => (o.y1 - o.y0) < Hp * 0.3 && (o.x1 - o.x0) < Hp * 0.3 && o.cnt > 4);
  let cut = 0;
  for(const a of small.sort((p, q) => p.x0 - q.x0)){ const b = small.find(o => o !== a && Math.abs((o.x0 + o.x1) / 2 - (a.x0 + a.x1) / 2) < Hp * 0.12 && Math.abs(o.y0 - a.y0) > Hp * 0.15);
    if(b && a.x0 < ink.W * 0.45){ cut = Math.max(a.x1, b.x1) + 1; break; } }
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cut, c.height);
  ink = inkOf(c); comps = components(ink).comps.filter(o => o.cnt > 6).sort((p, q) => p.x0 - q.x0);
  // 数字の並びを取り出す（数字＝背の高い図形、カンマ＝低い位置の小さな図形）
  const tall = comps.filter(o => (o.y1 - o.y0) > Hp * 0.35);
  const dh = tall.length ? tall.map(o => o.y1 - o.y0).sort((a, b) => a - b)[tall.length >> 1] : Hp * 0.6;
  const tokens = []; let cur = [], lastX = null, sep = false;
  for(const o of comps){
    const oh = o.y1 - o.y0;
    if(lastX != null && o.x0 - lastX > dh * 1.2) break;
    if(lastX == null && o.x0 > dh * 2.5) break;
    if(oh >= dh * 0.7){
      const prev = cur[cur.length - 1];
      if(sep && prev && o.x0 - prev.x1 > dh * 0.3){ tokens.push(cur); cur = []; }   // カンマ＋十分な間隔があれば区切り
      sep = false; cur.push(o); lastX = o.x1;
    }
    else if(oh < dh * 0.45 && o.y0 > Hp * 0.45 && cur.length){ sep = true; lastX = o.x1; }
    else if(oh < dh * 0.45){ lastX = lastX == null ? null : o.x1; }
  }
  if(cur.length) tokens.push(cur);
  // 文字認識（多数決の材料）
  let tess = '';
  try{ const r = await workers.en.recognize(c, {}, {blocks: false, text: true}); tess = (r.data.text || '').replace(/[^0-9,.]/g, ''); }catch(e){}
  const tTok = tess.split(/[,.]+/).filter(Boolean);
  const glyphs = tokens.map((tk, ti) => tk.map((o, gi) => ({...glyphVec(ink, o), vote: (tTok[ti] && tTok[ti].length === tk.length) ? tTok[ti][gi] : null})));
  const rects = tokens.map(tk => [rx0 + tk[0].x0 / S, L.y0, rx0 + (tk[tk.length - 1].x1 + 1) / S, L.y1]);
  return {glyphs, rects, tess: tTok};
}
/* 図形の形が同じ数字をまとめ、文字認識の多数決＋点検調書の写真番号との整合で数字を決める */
function decodeDigits(allLabels, valid){
  const clusters = [];
  for(const L of allLabels) for(const tk of L.glyphs) for(const g of tk){
    let best = null, bc = 0.86;
    for(const c of clusters){ if(Math.abs(c.ar - g.ar) > 0.12) continue; const r = corr(c.v, g.v); if(r > bc){ bc = r; best = c; } }
    if(!best){ best = {v: g.v, ar: g.ar, votes: {}, n: 0}; clusters.push(best); }
    g.c = best; best.n++; if(g.vote != null) best.votes[g.vote] = (best.votes[g.vote] || 0) + 1;
  }
  for(const c of clusters){ const e = Object.entries(c.votes).sort((a, b) => b[1] - a[1]); c.d = e.length ? e[0][0] : '?'; }
  const decode = L => L.glyphs.map(tk => tk.map(g => g.c.d).join(''));
  const score = () => { let s = 0; for(const L of allLabels){ const ns = decode(L); if(ns.length && ns.every(n => valid.has(String(+n)) && !n.includes('?'))) s++; } return s; };
  // 調書の番号と合う数が増えるように、まとまりごとの数字を見直す
  let base = score(), improved = true, iter = 0;
  while(improved && iter++ < 6){ improved = false;
    for(const c of clusters.sort((a, b) => b.n - a.n)){ const keep = c.d; let bestD = keep, bestS = base;
      for(const d of '0123456789'){ if(d === keep) continue; c.d = d; const sc = score(); if(sc > bestS){ bestS = sc; bestD = d; } }
      c.d = bestD; if(bestS > base){ base = bestS; improved = true; } } }
  for(const L of allLabels){
    let ns = decode(L);
    // 区切りの誤検出（例 3,3 → 33）を、調書にある番号になる場合だけ結合
    if(ns.length > 1 && ns.some(n => !valid.has(String(+n)))){ const j = ns.join(''); if(valid.has(String(+j))) ns = [j]; }
    ns = ns.map(n => n.includes('?') ? '' : String(+n)).filter(Boolean);
    if(!ns.length && L.ocrNums && L.ocrNums.length) ns = L.ocrNums.map(n => String(+n));
    L.nums = ns;
  }
  return {clusters: clusters.length, matched: base};
}
/* 「写真」の形で全ページを探す（図形化した文字は毎回同じ形なので、画像の照合で確実に拾える） */
function binGray(c, s){ const W = c.width, H = c.height, d = c.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, W, H).data, f = 2, w2 = W >> 1, h2 = H >> 1, out = new Float32Array(w2 * h2);
  for(let y = 0; y < h2; y++) for(let x = 0; x < w2; x++){ let v = 0; for(let dy = 0; dy < f; dy++) for(let dx = 0; dx < f; dx++){ const i = ((y * f + dy) * W + (x * f + dx)) * 4; const r = d[i], g = d[i+1], b = d[i+2]; v += (r - g > 60 && r - b > 60) ? 0 : (Math.min(r, g, b) < 150 ? 1 : 0); } out[y * w2 + x] = v / 4; }
  return {a: out, W: w2, H: h2};
}
function matchTemplate(img, tpl, thr){
  const {a, W, H} = img, tw = tpl.W, th = tpl.H, n = tw * th;
  let tm = 0; for(let i = 0; i < n; i++) tm += tpl.a[i]; tm /= n;
  let tv = 0; const tz = new Float32Array(n); for(let i = 0; i < n; i++){ tz[i] = tpl.a[i] - tm; tv += tz[i] * tz[i]; }
  // 積分画像で「インク量」が近い場所だけ照合
  const I = new Float64Array((W + 1) * (H + 1)), I2 = new Float64Array((W + 1) * (H + 1));
  for(let y = 0; y < H; y++){ let rs = 0, rs2 = 0; for(let x = 0; x < W; x++){ const v = a[y * W + x]; rs += v; rs2 += v * v; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + rs; I2[(y + 1) * (W + 1) + x + 1] = I2[y * (W + 1) + x + 1] + rs2; } }
  const box = (A, x, y) => A[(y + th) * (W + 1) + x + tw] - A[y * (W + 1) + x + tw] - A[(y + th) * (W + 1) + x] + A[y * (W + 1) + x];
  const tsum = tm * n, hits = [];
  for(let y = 0; y + th <= H; y++) for(let x = 0; x + tw <= W; x++){
    const sm = box(I, x, y); if(sm < tsum * 0.7 || sm > tsum * 1.3) continue;
    const mean = sm / n, vv = box(I2, x, y) - sm * mean; if(vv <= 0) continue;
    let cc = 0; for(let j = 0; j < th; j++){ const ro = (y + j) * W + x, to = j * tw; for(let i = 0; i < tw; i++) cc += tz[to + i] * a[ro + i]; }
    const r = cc / Math.sqrt(tv * vv); if(r > thr) hits.push({x, y, r});
  }
  hits.sort((p, q) => q.r - p.r); const keep = [];
  for(const h of hits) if(!keep.some(k => Math.abs(k.x - h.x) < tw * 0.8 && Math.abs(k.y - h.y) < th * 0.8)) keep.push(h);
  return keep;
}
let _tpl = null;
async function ocrPage(page, rotation, scales, workers, onSub){
  const vp1 = page.getViewport({scale: 1, rotation}), S = 3;
  const labs = await detectPass(page, rotation, vp1, S, false, workers); onSub && onSub();
  // 照合用の「写真」の形を作る（はっきり読めたものから）
  const full = cleanCanvas(await renderRegion(page, rotation, S, 0, 0, vp1.width, vp1.height), Math.round(14 * S), true), img = binGray(full);
  const hs = labs.map(L => L.y1 - L.y0).sort((a, b) => a - b), hMed = hs[hs.length >> 1] || 7;
  const seed = labs.filter(L => L.nums.length && Math.abs((L.y1 - L.y0) - hMed) < hMed * 0.2 && Math.abs((L.xAfter - L.x0) - hMed * 2) < hMed * 0.5)[0]
    || labs.filter(L => Math.abs((L.y1 - L.y0) - hMed) < hMed * 0.2)[0];
  if(seed){
    const x0 = Math.floor(seed.x0 * S / 2), y0 = Math.floor(seed.y0 * S / 2), x1 = Math.ceil(seed.xAfter * S / 2), y1 = Math.ceil(seed.y1 * S / 2);
    const tw = x1 - x0, th = y1 - y0;
    if(tw > 6 && th > 4){ const t = new Float32Array(tw * th); for(let y = 0; y < th; y++) for(let x = 0; x < tw; x++) t[y * tw + x] = img.a[(y0 + y) * img.W + x0 + x];
      // インクの外接枠に詰める
      _tpl = {a: t, W: tw, H: th, h: seed.y1 - seed.y0, w: seed.xAfter - seed.x0}; if(global.DBG_TPL) global.DBG_TPL.push(['seed', seed.x0, seed.y0, seed.y1 - seed.y0, seed.xAfter - seed.x0]); }
  }
  const found = [];
  for(const L of labs){ if(!found.some(o => Math.abs(o.x0 - L.x0) < (o.y1 - o.y0) && Math.abs(o.y0 - L.y0) < (o.y1 - o.y0) * 0.7)) found.push({...L}); }
  if(_tpl){
    for(const m of matchTemplate(img, _tpl, 0.6)){
      const x0 = m.x * 2 / S, y0 = m.y * 2 / S;
      if(found.some(L => Math.abs(L.x0 - x0) < _tpl.w * 0.6 && Math.abs(L.y0 - y0) < _tpl.h * 0.8)) continue;
      if(global.DBG_TPL) global.DBG_TPL.push([x0, y0, m.r]);
      found.push({x0, y0, x1: x0 + _tpl.w, y1: y0 + _tpl.h, xAfter: x0 + _tpl.w, nums: [], rects: []});
    }
  }
  onSub && onSub();
  const out = [];
  for(const L of found){
    let nr = {glyphs: [], rects: [], tess: []};
    try{ nr = await readNumbers(page, rotation, L, workers); }catch(e){}
    const x1 = nr.rects.length ? Math.max(L.x1, nr.rects[nr.rects.length - 1][2]) : L.x1;
    out.push({x0: L.x0, y0: L.y0, x1, y1: L.y1, glyphs: nr.glyphs, rects: nr.rects, ocrNums: L.nums, nums: []});
  }
  return out;
}

async function parseDiagramOCR(doc, onProg, valid){
  const workers = await getWorkers(2);
  const pages = [];
  try{
    for(let i = 1; i <= doc.numPages; i++){
      const page = await doc.getPage(i);
      const rotation = page.rotate % 360; const vp = page.getViewport({scale: 1, rotation});
      let sub = 0;
      onProg && onProg(`損傷図の文字認識 ${i}/${doc.numPages}`);
      const labs = await ocrPage(page, rotation, [3, 5], workers, () => { sub++; onProg && onProg(`損傷図の文字認識 ${i}/${doc.numPages}`); });
      pages.push({w: vp.width, h: vp.height, rotation, title: `${i}ページ`, _labs: labs, labels: [],
        existing: [], notes: [], situ: []});
    }
  } finally { await terminateWorkers(); }
  onProg && onProg('番号を照合しています');
  const all = pages.flatMap(p => p._labs);
  const info = decodeDigits(all, valid || new Set());
  for(const p of pages){ p.labels = p._labs.map(L => ({point: '', line: [L.x0, L.y0, L.x1, L.y1], nums: L.nums.map((num, k) => ({num, rect: L.rects[k] || [L.x0, L.y0, L.x1, L.y1]}))})); delete p._labs; }
  return {pages, info};
}

BP.PROFILES.hokkaido = {
  label: '北海道版', desc: '損傷図（DXF または PDF）＋ 点検調書PDF（北海道建設部 様式）', ready: true, ocr: true,
  inputs: [{key: 'dia', label: '損傷図（DXF推奨／文字が図形化されたPDFも可）', required: true, accept: '.dxf,.pdf,application/pdf'}, {key: 'led', label: '点検調書PDF（損傷写真を含むもの）', required: true}],
  grades: ['ⅰ','ⅱ','ⅲ','ⅳ','ⅴ'],
  async parse(files, onProg){
    const ledDoc = await global.pdfjsLib.getDocument({data: files.led.slice(0), isEvalSupported: false}).promise;
    const cropper = BP._internal.makeCropper({scale: 3});
    const ch = await parseChosho(ledDoc, onProg, cropper.crop);
    onProg && onProg('写真を保存用にまとめています');
    const sprite = await cropper.finish();
    const head = new TextDecoder('ascii').decode(new Uint8Array(files.dia, 0, Math.min(200, files.dia.byteLength)));
    const isDXF = /^\s*0\s*\r?\n\s*SECTION/.test(head) || /SECTION/.test(head) && !/%PDF/.test(head);
    let dia;
    if(isDXF){
      if(!global.DXFReader) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'dxf.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      const pages = global.DXFReader.dxfToPages(files.dia, onProg);
      dia = {pages: pages.map(pg => ({w: pg.w, h: pg.h, rotation: 0, title: pg.title, svgText: pg.svg, cams: pg.cams,
        labels: pg.labels.map(L => ({point: '', status: L.status, line: L.line, nums: L.nums.map((num, k) => ({num, rect: L.rects[k]}))})), existing: [], notes: [], situ: []}))};
    } else {
      const diaDoc = await global.pdfjsLib.getDocument({data: files.dia.slice(0), isEvalSupported: false}).promise;
      dia = await parseDiagramOCR(diaDoc, onProg, new Set(ch.photos.map(p => String(+p.num))));
    }
    // 写真番号で照合（北海道版は撮影ポイントなし）
    const key = new Map(ch.photos.map(p => [String(+p.num), p.id]));
    const unresolved = [], found = new Set();
    dia.pages.forEach((pg, pi) => {
      pg.spots = [];
      for(const lb of pg.labels){
        const ids = [], rects = [];
        for(const n of lb.nums){ const id = key.get(String(+n.num)); if(id == null){ unresolved.push({page: pi + 1, point: '', num: n.num}); continue; } ids.push(id); rects.push(n.rect); found.add(id); }
        if(ids.length) pg.spots.push({ids, nums: rects, line: lb.line, point: '', status: lb.status || ''});
        else if(!lb.nums.length) unresolved.push({page: pi + 1, point: '', num: '（番号読めず）', line: lb.line});
      }
      const sp = {}; pg.spots.forEach(s => s.ids.forEach(id => { const v = ch.photos[id].span; sp[v] = (sp[v] || 0) + 1; }));
      pg.span = Object.keys(sp).sort((a,b) => sp[b] - sp[a])[0] || '';
      const tm = String(pg.title || '').replace(/[０-９]/g, z => String.fromCharCode(z.charCodeAt(0) - 0xFEE0)).match(/(\d+)\s*径間/);
      if(tm) pg.span = tm[1];   // ページ名に径間があればそれを優先
      if(!isDXF) pg.title = `損傷図 p${pi + 1}`;
      pg.existing = pg.spots.map(s => ({point: '', nums: s.ids.map(id => ch.photos[id].num), line: s.line,
        rows: (() => { const p = ch.photos[s.ids[0]]; const ds = p.dmg.length ? p.dmg : [{t: '', g: ''}]; return ds.map(d => ({member: p.member, mno: '', t: d.t, g: d.g, detail: '', size: '', note: p.pos})); })()}));
      delete pg.labels;
    });
    const missing = ch.photos.filter(p => !found.has(p.id)).map(p => p.num);
    ch.photos.forEach(p => { delete p.img; });
    return {bridge: ch.bridge, code: ch.code, pages: dia.pages, photos: ch.photos, unresolved, missing, sprite, source: isDXF ? 'dxf' : 'pdf'};
  }
};
{ const o = {municipal: BP.PROFILES.municipal, hokkaido: BP.PROFILES.hokkaido, mlit: BP.PROFILES.mlit}; for(const k of Object.keys(BP.PROFILES)) delete BP.PROFILES[k]; Object.assign(BP.PROFILES, o); }
BP._internal.hokkaido = {parseChosho, parseDiagramOCR, ocrPage, getWorkers, terminateWorkers};
})(window);
