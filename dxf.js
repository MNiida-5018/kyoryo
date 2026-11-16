/* DXF → 図面の枠ごとのSVG＋写真番号・撮影Noの抽出（北海道版） */
(function(global){
'use strict';

/* ---------- 読み込み ---------- */
function decode(buf){
  const u8 = new Uint8Array(buf);
  const head = new TextDecoder('ascii').decode(u8.subarray(0, 4000));
  const m = head.match(/\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d+)/);
  const ver = m ? m[1] : 'AC1015';
  const cp = head.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/);
  const utf8 = ver >= 'AC1021';
  let txt = new TextDecoder(utf8 ? 'utf-8' : (cp && /932/.test(cp[1]) ? 'shift_jis' : 'shift_jis')).decode(u8);
  return txt.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function pairs(txt){
  const L = txt.split(/\r?\n/), out = [];
  for(let i = 0; i + 1 < L.length; i += 2) out.push([parseInt(L[i], 10), L[i + 1]]);
  return out;
}
function parseEntity(P, i){
  // P[i] = [0, TYPE]; returns {e, next}
  const e = {type: P[i][1], g: []}; i++;
  while(i < P.length && P[i][0] !== 0){ e.g.push(P[i]); i++; }
  return {e, next: i};
}
function gv(e, code, def){ for(const [c, v] of e.g) if(c === code) return v; return def; }
function gn(e, code, def){ const v = gv(e, code); return v == null ? def : parseFloat(v); }
function gall(e, code){ return e.g.filter(p => p[0] === code).map(p => p[1]); }

function parseDXF(buf){
  const P = pairs(decode(buf));
  const layers = {}, blocks = {}, ents = [];
  let i = 0, section = null;
  while(i < P.length){
    const [c, v] = P[i];
    if(c === 0 && v === 'SECTION'){ section = P[i + 1][1]; i += 2; continue; }
    if(c === 0 && v === 'ENDSEC'){ section = null; i++; continue; }
    if(c === 0 && v === 'EOF') break;
    if(section === 'TABLES' && c === 0 && v === 'LAYER'){
      const {e, next} = parseEntity(P, i); const name = gv(e, 2);
      if(name != null && gv(e, 100) !== undefined || name){ const col = parseInt(gv(e, 62, '7'), 10); layers[name] = {color: Math.abs(col), off: col < 0, frozen: (parseInt(gv(e, 70, '0'), 10) & 1) === 1, tc: gv(e, 420) ? parseInt(gv(e, 420), 10) : null, plot: gv(e, 290, '1').trim() !== '0' && !/^defpoints?$/i.test(name)}; }
      i = next; continue;
    }
    if(section === 'BLOCKS' && c === 0 && v === 'BLOCK'){
      const {e, next} = parseEntity(P, i); const name = gv(e, 2); const base = [gn(e, 10, 0), gn(e, 20, 0)];
      i = next; const list = [];
      while(i < P.length && !(P[i][0] === 0 && P[i][1] === 'ENDBLK')){ const r = readEnt(P, i); if(r.e) list.push(r.e); i = r.next; }
      i++; while(i < P.length && P[i][0] !== 0) i++;
      blocks[name] = {base, ents: list}; continue;
    }
    if(section === 'ENTITIES' && c === 0){ const r = readEnt(P, i); if(r.e) ents.push(r.e); i = r.next; continue; }
    i++;
  }
  return {layers, blocks, ents};
}
// POLYLINE は VERTEX…SEQEND を含める
function readEnt(P, i){
  const r = parseEntity(P, i);
  if(r.e.type === 'POLYLINE'){
    const verts = []; let j = r.next;
    while(j < P.length && P[j][1] === 'VERTEX'){ const v = parseEntity(P, j); verts.push(v.e); j = v.next; }
    if(j < P.length && P[j][1] === 'SEQEND'){ j = parseEntity(P, j).next; }
    r.e.verts = verts; r.next = j;
  }
  return r;
}

/* ---------- 色 ---------- */
const ACI = {1:'#ff0000',2:'#c8b400',3:'#00a000',4:'#00a0c8',5:'#0000ff',6:'#c800c8',7:'#000000',8:'#808080',9:'#b0b0b0',
  30:'#ff7f00',40:'#ff9f00',140:'#007fff',150:'#0050c8',250:'#333333',251:'#505050',252:'#696969',253:'#828282',254:'#bebebe',255:'#ffffff'};
function aci(n){ if(ACI[n]) return ACI[n]; if(n >= 10 && n <= 249){ const h = Math.floor((n - 10) / 10) * 15, s = (n % 2) ? 0.5 : 1, l = [0.5,0.65,0.35,0.45,0.3][Math.floor((n % 10) / 2)] || 0.5; return `hsl(${h},${s*100}%,${l*100}%)`; } return '#000'; }
// 印刷時の色：損傷の記号は赤、撮影Noは緑、赤で描かれたものは赤、それ以外は黒
function printColor(raw, layer){
  if(/オリジナル/.test(layer)) return '#1a8f3a';
  if(/損傷$|^新規.*損傷$|補修済$|補修済損傷|変状/.test(layer) && !/旗/.test(layer)) return '#e0201b';
  if(raw === '#ff0000') return '#e0201b';
  return '#000';
}
function colorOf(e, D, blockColor){ return printColor(rawColorOf(e, D, blockColor), gv(e, 8, '0')); }
function rawColorOf(e, D, blockColor){
  const tc = gv(e, 420); if(tc){ const n = parseInt(tc, 10); return '#' + (n & 0xffffff).toString(16).padStart(6, '0'); }
  let c = parseInt(gv(e, 62, '256'), 10);
  if(c === 256){ const L = D.layers[gv(e, 8, '0')]; if(L){ if(L.tc != null) return '#' + (L.tc & 0xffffff).toString(16).padStart(6, '0'); c = L.color; } else c = 7; }
  if(c === 0) return blockColor || '#000';
  if(c === 7 || c === 255) return '#000';
  return aci(c);
}
function layerVisible(e, D){ const n = gv(e, 8, '0'); if(/^defpoints?$/i.test(n)) return false; const L = D.layers[n]; return !L || (!L.off && !L.frozen && L.plot !== false); }

/* ---------- MTEXT の書式を取り除く ---------- */
function mtextPlain(s){
  return String(s || '')
    .replace(/\\P/g, '\n')
    .replace(/\\[pP][^;]*;/g, '')
    .replace(/\\[ACcFfHhQqTtWw][^;]*;/g, '')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\S([^;]*)[\^#\/]([^;]*);/g, '$1/$2')
    .replace(/\\~/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\\\\/g, '\\');
}

/* ---------- 図形 → SVG 要素 ---------- */
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const f2 = v => Math.round(v * 100) / 100;
function bulgeArc(x1, y1, x2, y2, b){
  // DXF の bulge（円弧）を SVG の A コマンドに
  const ang = 4 * Math.atan(Math.abs(b)), d = Math.hypot(x2 - x1, y2 - y1); if(d === 0) return '';
  const r = d / (2 * Math.sin(ang / 2));
  return ` A${f2(r)} ${f2(r)} 0 ${ang > Math.PI ? 1 : 0} ${b > 0 ? 1 : 0} ${f2(x2)} ${f2(y2)}`;
}
function splinePts(e){
  const deg = parseInt(gv(e, 71, '3'), 10), knots = gall(e, 40).map(Number);
  const cps = []; const xs = gall(e, 10).map(Number), ys = gall(e, 20).map(Number); for(let k = 0; k < xs.length; k++) cps.push([xs[k], ys[k]]);
  const fx = gall(e, 11).map(Number), fy = gall(e, 21).map(Number);
  if(cps.length < deg + 1 || knots.length < cps.length + deg + 1){ return fx.length ? fx.map((x, k) => [x, fy[k]]) : cps; }
  const out = [], t0 = knots[deg], t1 = knots[cps.length], N = Math.max(16, cps.length * 8);
  for(let s = 0; s <= N; s++){
    const t = t0 + (t1 - t0) * s / N; let k = deg; while(k < cps.length - 1 && t >= knots[k + 1]) k++;
    const d = []; for(let j = 0; j <= deg; j++) d.push(cps[k - deg + j].slice());
    for(let r = 1; r <= deg; r++) for(let j = deg; j >= r; j--){ const i = k - deg + j, a = (t - knots[i]) / ((knots[i + deg - r + 1] - knots[i]) || 1); d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]]; }
    out.push(d[deg]);
  }
  return out;
}
function textW(s, h, wf){ let w = 0; for(const ch of s) w += /[\x00-\x7f｡-ﾟ]/.test(ch) ? h * 0.5 : h; return w * (wf || 1); }

// 1つの図形 → {svg, bbox, kind, info}
function entSVG(e, D, ctx){
  if(!layerVisible(e, D)) return null;
  const col = colorOf(e, D, ctx.blockColor), sw = ctx.sw, T = ctx.T;
  const tp = (x, y) => T ? [T[0]*x + T[2]*y + T[4], T[1]*x + T[3]*y + T[5]] : [x, y];
  const out = [];
  const path = (d, fill) => out.push(`<path d="${d}" stroke="${col}" stroke-width="${sw}" fill="${fill || 'none'}" stroke-linecap="round" stroke-linejoin="round"/>`);
  const pts = arr => arr.map((p, k) => (k ? 'L' : 'M') + f2(tp(p[0], p[1])[0]) + ' ' + f2(tp(p[0], p[1])[1])).join(' ');
  switch(e.type){
    case 'LINE': { const a = tp(gn(e, 10), gn(e, 20)), b = tp(gn(e, 11), gn(e, 21)); path(`M${f2(a[0])} ${f2(a[1])} L${f2(b[0])} ${f2(b[1])}`); break; }
    case 'LWPOLYLINE': {
      const xs = gall(e, 10).map(Number), ys = gall(e, 20).map(Number);
      // bulge は頂点ごと（42 は頂点の後に来る）
      const bs = []; let vi = -1; for(const [c, v] of e.g){ if(c === 10) vi++; if(c === 42) bs[vi] = parseFloat(v); }
      const closed = (parseInt(gv(e, 70, '0'), 10) & 1) === 1, n = xs.length; if(!n) return null;
      let d = ''; const P = xs.map((x, k) => tp(x, ys[k]));
      d = `M${f2(P[0][0])} ${f2(P[0][1])}`;
      const segs = closed ? n : n - 1;
      for(let k = 0; k < segs; k++){ const a = P[k], b = P[(k + 1) % n], bb = bs[k] || 0; d += bb ? bulgeArc(a[0], a[1], b[0], b[1], T && (T[0]*T[3]-T[1]*T[2]) < 0 ? -bb : bb) : ` L${f2(b[0])} ${f2(b[1])}`; }
      if(closed) d += ' Z';
      const cw = gn(e, 43, 0); if(cw > 0) out.push(`<path d="${d}" stroke="${col}" stroke-width="${f2(cw)}" fill="none"/>`); else path(d);
      break; }
    case 'POLYLINE': {
      const V = (e.verts || []).filter(v => !(parseInt(gv(v, 70, '0'), 10) & 128)).map(v => ({p: tp(gn(v, 10), gn(v, 20)), b: gn(v, 42, 0)}));
      if(V.length < 2) return null; const closed = (parseInt(gv(e, 70, '0'), 10) & 1) === 1;
      let d = `M${f2(V[0].p[0])} ${f2(V[0].p[1])}`; const segs = closed ? V.length : V.length - 1;
      for(let k = 0; k < segs; k++){ const a = V[k], b = V[(k + 1) % V.length]; d += a.b ? bulgeArc(a.p[0], a.p[1], b.p[0], b.p[1], a.b) : ` L${f2(b.p[0])} ${f2(b.p[1])}`; }
      if(closed) d += ' Z'; path(d); break; }
    case 'CIRCLE': { const c = tp(gn(e, 10), gn(e, 20)), r = gn(e, 40) * ctx.sc; out.push(`<circle cx="${f2(c[0])}" cy="${f2(c[1])}" r="${f2(r)}" stroke="${col}" stroke-width="${sw}" fill="none"/>`); break; }
    case 'ARC': {
      const cx = gn(e, 10), cy = gn(e, 20), r = gn(e, 40); let a0 = gn(e, 50) * Math.PI / 180, a1 = gn(e, 51) * Math.PI / 180; if(a1 < a0) a1 += Math.PI * 2;
      const N = Math.max(8, Math.ceil((a1 - a0) / (Math.PI / 24))), arr = []; for(let k = 0; k <= N; k++){ const a = a0 + (a1 - a0) * k / N; arr.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      path(pts(arr)); break; }
    case 'ELLIPSE': {
      const cx = gn(e, 10), cy = gn(e, 20), mx = gn(e, 11), my = gn(e, 21), ratio = gn(e, 40, 1); let t0 = gn(e, 41, 0), t1 = gn(e, 42, Math.PI * 2); if(t1 < t0) t1 += Math.PI * 2;
      const ma = Math.hypot(mx, my), ang = Math.atan2(my, mx), mi = ma * ratio, N = Math.max(24, Math.ceil((t1 - t0) / (Math.PI / 36))), arr = [];
      for(let k = 0; k <= N; k++){ const t = t0 + (t1 - t0) * k / N, x = ma * Math.cos(t), y = mi * Math.sin(t); arr.push([cx + x * Math.cos(ang) - y * Math.sin(ang), cy + x * Math.sin(ang) + y * Math.cos(ang)]); }
      path(pts(arr)); break; }
    case 'SPLINE': { const arr = splinePts(e); if(arr.length > 1) path(pts(arr)); break; }
    case 'TEXT': case 'ATTRIB': {
      const s = gv(e, 1, ''); if(!s.trim()) return null;
      const h = gn(e, 40, 2.5), rot = gn(e, 50, 0), wf = gn(e, 41, 1), ha = parseInt(gv(e, 72, '0'), 10), va = parseInt(gv(e, 73, '0'), 10);
      let x = gn(e, 10), y = gn(e, 20); if((ha || va) && gv(e, 11) != null){ x = gn(e, 11); y = gn(e, 21); }
      const w = textW(s, h, wf); let dx = 0, dy = 0;
      if(ha === 1 || ha === 4) dx = -w / 2; else if(ha === 2) dx = -w; if(va === 2) dy = -h / 2; else if(va === 3) dy = -h;
      const r = rot * Math.PI / 180;
      const bx = x + dx * Math.cos(r) - dy * Math.sin(r), by = y + dx * Math.sin(r) + dy * Math.cos(r);
      out.push(textSVG(s, bx, by, h, rot, wf, col, ctx));
      ctx.texts && ctx.texts.push({s, layer: gv(e, 8, '0'), x: bx, y: by, h, w, rot});
      break; }
    case 'MTEXT': {
      const s = mtextPlain(gall(e, 3).join('') + gv(e, 1, '')); if(!s.trim()) return null;
      const h = gn(e, 40, 2.5), ap = parseInt(gv(e, 71, '1'), 10), rot = gv(e, 50) != null ? gn(e, 50) : (gv(e, 11) != null ? Math.atan2(gn(e, 21), gn(e, 11)) * 180 / Math.PI : 0);
      mtextBlock(s, gn(e, 10), gn(e, 20), h, ap, rot, gn(e, 44, 1), col, ctx, out, gv(e, 8, '0'));
      break; }
    case 'MULTILEADER': case 'MLEADER': {
      const ml = parseMLeader(e); if(!ml) return null;
      for(const L of ml.lines){ if(L.length > 1){ path(pts(L)); const a = L[0], b = L[1], ang = Math.atan2(b[1] - a[1], b[0] - a[0]), s = ml.arrow || ml.h;
        const p1 = [a[0] + s * Math.cos(ang + 0.3), a[1] + s * Math.sin(ang + 0.3)], p2 = [a[0] + s * Math.cos(ang - 0.3), a[1] + s * Math.sin(ang - 0.3)]; path(pts([p1, a, p2])); } }
      if(ml.text){
        const lines = mtextBlock(ml.text, ml.tx, ml.ty, ml.h, 1, 0, ml.spacing, col, ctx, out, gv(e, 8, '0'), true);
        // 1行目の下線（引出線の着地点まで）
        if(lines && lines.length){ const L0 = lines[0], uy = ml.landing ? ml.landing[1] : L0.y - ml.h * 0.2;
          const x0 = Math.min(L0.x, ml.landing ? ml.landing[0] : L0.x), x1 = Math.max(L0.x + L0.w, ml.landing ? ml.landing[0] : L0.x);
          path(pts([[x0, uy], [x1, uy]])); }
      }
      break; }
    case 'HATCH': {
      const loops = hatchLoops(e); if(!loops.length) return null;
      const d = loops.map(lp => pts(lp) + ' Z').join(' ');
      const solid = parseInt(gv(e, 70, '0'), 10) === 1;
      if(solid){ out.push(`<path d="${d}" fill="${col}" fill-rule="evenodd" stroke="none"/>`); break; }
      // 模様（線）を境界でクリップして描く
      const id = 'h' + (ctx.hid++);
      const bb = bboxOf(loops.flat()); const lines = hatchLines(e, bb);
      out.push(`<clipPath id="${id}"><path d="${d}" clip-rule="evenodd"/></clipPath><path clip-path="url(#${id})" d="${lines.map(([a, b]) => `M${f2(a[0])} ${f2(a[1])} L${f2(b[0])} ${f2(b[1])}`).join(' ')}" stroke="${col}" stroke-width="${sw}" fill="none"/>`);
      out.push(`<path d="${d}" stroke="${col}" stroke-width="${sw}" fill="none"/>`);
      break; }
    case 'INSERT': case 'DIMENSION': {
      const name = gv(e, 2); const B = D.blocks[name]; if(!B) return null;
      let M;
      if(e.type === 'INSERT'){ const ix = gn(e, 10, 0), iy = gn(e, 20, 0), sx = gn(e, 41, 1), sy = gn(e, 42, 1), r = gn(e, 50, 0) * Math.PI / 180;
        const c = Math.cos(r), s = Math.sin(r);
        M = [c * sx, s * sx, -s * sy, c * sy, ix - (c * sx * B.base[0] - s * sy * B.base[1]), iy - (s * sx * B.base[0] + c * sy * B.base[1])]; }
      else M = [1, 0, 0, 1, 0, 0];
      const T2 = T ? [T[0]*M[0]+T[2]*M[1], T[1]*M[0]+T[3]*M[1], T[0]*M[2]+T[2]*M[3], T[1]*M[2]+T[3]*M[3], T[0]*M[4]+T[2]*M[5]+T[4], T[1]*M[4]+T[3]*M[5]+T[5]] : M;
      if((ctx.depth || 0) > 6) return null;
      const sub = {...ctx, T: T2, depth: (ctx.depth || 0) + 1, blockColor: col, sc: (ctx.sc || 1) * Math.sqrt(Math.abs(M[0]*M[3]-M[1]*M[2]))};
      for(const be of B.ents){ const r = entSVG(be, D, sub); if(r) out.push(r); }
      break; }
    default: return null;
  }
  return out.join('');
}
function textSVG(s, x, y, h, rot, wf, col, ctx){
  const T = ctx.T, p = T ? [T[0]*x + T[2]*y + T[4], T[1]*x + T[3]*y + T[5]] : [x, y];
  const hh = h * (ctx.sc || 1);
  // SVG 全体は y を反転して描くので、文字だけ反転し直す
  return `<text x="0" y="0" transform="translate(${f2(p[0])} ${f2(p[1])}) rotate(${f2(-rot)}) scale(${f2(wf)} -1)" font-size="${f2(hh)}" fill="${col}" font-family="MS Gothic, Hiragino Sans, Noto Sans JP, monospace" xml:space="preserve">${esc(s)}</text>`;
}
function mtextBlock(s, x, y, h, ap, rot, spacing, col, ctx, out, layer, isLeader){
  const lines = s.split('\n'), ls = h * 1.667 * (spacing || 1), widths = lines.map(t => textW(t, h, 1)), W = Math.max(0, ...widths);
  const col_ = (ap - 1) % 3, row = Math.floor((ap - 1) / 3);
  const left = x - (col_ === 1 ? W / 2 : col_ === 2 ? W : 0);
  const total = h + ls * (lines.length - 1), top = y + (row === 1 ? total / 2 : row === 2 ? total : 0);
  const res = [];
  lines.forEach((t, k) => { const by = top - h - ls * k; if(t.trim()) out.push(textSVG(t, left, by, h, rot, 1, col, ctx)); res.push({t, x: left, y: by, w: widths[k], h});
    ctx.texts && ctx.texts.push({s: t, layer, x: left, y: by, h, w: widths[k], rot, leader: !!isLeader, line: k, block: ctx._blk}); });
  return res;
}
function parseMLeader(e){
  // CONTEXT_DATA の中から 文字・位置・高さ・引出線を読む
  let inCtx = false, inLeader = false, inLine = false, text = null, tx = null, ty = null, h = 2.5, arrow = null, spacing = 1, landing = null;
  const lines = []; let cur = null, gotTextLoc = false;
  for(const [c, v] of e.g){
    if(c === 300 && v.startsWith('CONTEXT_DATA')){ inCtx = true; continue; }
    if(!inCtx) continue;
    if(c === 301 && v === '}'){ inCtx = false; continue; }
    if(c === 302 && v.startsWith('LEADER{')){ inLeader = true; continue; }
    if(c === 303 && v === '}'){ inLeader = false; continue; }
    if(c === 304 && v.startsWith('LEADER_LINE{')){ inLine = true; cur = []; continue; }
    if(c === 305 && v === '}'){ inLine = false; if(cur) lines.push(cur); cur = null; continue; }
    if(inLine){ if(c === 10) cur.push([parseFloat(v), null]); else if(c === 20 && cur.length) cur[cur.length - 1][1] = parseFloat(v); continue; }
    if(inLeader){ if(c === 10) landing = [parseFloat(v), null]; else if(c === 20 && landing && landing[1] == null) landing[1] = parseFloat(v); continue; }
    if(c === 41 && !gotTextLoc) h = parseFloat(v);
    else if(c === 140 && arrow == null) arrow = parseFloat(v);
    else if(c === 304 && text == null) text = v;
    else if(c === 12 && tx == null){ tx = parseFloat(v); gotTextLoc = true; }
    else if(c === 22 && ty == null) ty = parseFloat(v);
    else if(c === 45 && spacing === 1) spacing = parseFloat(v) || 1;
  }
  // 引出線の最後の点を着地点に
  lines.forEach(L => { if(landing && landing[1] != null){ const last = L[L.length - 1]; if(!last || Math.hypot(last[0] - landing[0], last[1] - landing[1]) > 1e-6) L.push(landing.slice()); } });
  if(text == null && !lines.length) return null;
  return {text: text != null ? mtextPlain(text) : '', tx, ty, h, arrow, spacing, lines, landing};
}
function hatchLoops(e){
  // 境界（ポリライン型・辺型）を点列に
  const g = e.g, loops = []; let i = g.findIndex(p => p[0] === 91); if(i < 0) return loops;
  const nLoops = parseInt(g[i][1], 10); i++;
  for(let L = 0; L < nLoops && i < g.length; L++){
    while(i < g.length && g[i][0] !== 92) i++; if(i >= g.length) break;
    const type = parseInt(g[i][1], 10); i++;
    const pts = [];
    if(type & 2){ // polyline
      let hasB = 0, n = 0;
      while(i < g.length && g[i][0] !== 93){ if(g[i][0] === 72) hasB = parseInt(g[i][1], 10); i++; } n = parseInt(g[i][1], 10); i++;
      const V = [];
      while(V.length < n && i < g.length){ if(g[i][0] === 10){ const x = parseFloat(g[i][1]), y = parseFloat(g[i + 1][1]); i += 2; let b = 0; if(hasB && g[i] && g[i][0] === 42){ b = parseFloat(g[i][1]); i++; } V.push([x, y, b]); } else i++; }
      for(let k = 0; k < V.length; k++){ const a = V[k], b = V[(k + 1) % V.length]; pts.push([a[0], a[1]]); if(a[2]) pts.push(...arcPts(a, b, a[2])); }
    } else { // edges
      const ne = parseInt(g[i][1], 10); i++;
      for(let k = 0; k < ne && i < g.length; k++){
        while(i < g.length && g[i][0] !== 72) i++; const et = parseInt(g[i][1], 10); i++;
        const read = codes => { const o = {}; while(i < g.length && codes.includes(g[i][0]) && o[g[i][0]] == null){ o[g[i][0]] = parseFloat(g[i][1]); i++; } return o; };
        if(et === 1){ const o = read([10, 20, 11, 21]); pts.push([o[10], o[20]], [o[11], o[21]]); }
        else if(et === 2){ const o = read([10, 20, 40, 50, 51, 73]); let a0 = o[50] * Math.PI / 180, a1 = o[51] * Math.PI / 180; const ccw = o[73] !== 0; if(!ccw){ const t = a0; a0 = -a1; a1 = -t; } if(a1 < a0) a1 += Math.PI * 2;
          for(let s = 0; s <= 24; s++){ const a = a0 + (a1 - a0) * s / 24; pts.push([o[10] + o[40] * Math.cos(a), o[20] + o[40] * (ccw ? Math.sin(a) : -Math.sin(a))]); } }
        else if(et === 3){ const o = read([10, 20, 11, 21, 40, 50, 51, 73]); const ma = Math.hypot(o[11], o[21]), ang = Math.atan2(o[21], o[11]), mi = ma * o[40]; let a0 = o[50] * Math.PI / 180, a1 = o[51] * Math.PI / 180; if(a1 < a0) a1 += Math.PI * 2; const sgn = o[73] === 0 ? -1 : 1;
          for(let s = 0; s <= 36; s++){ const t = a0 + (a1 - a0) * s / 36, x = ma * Math.cos(t), y = sgn * mi * Math.sin(t); pts.push([o[10] + x * Math.cos(ang) - y * Math.sin(ang), o[20] + x * Math.sin(ang) + y * Math.cos(ang)]); } }
        else if(et === 4){ // spline edge → 制御点
          while(i < g.length && g[i][0] !== 10) i++; while(i < g.length && g[i][0] === 10){ pts.push([parseFloat(g[i][1]), parseFloat(g[i + 1][1])]); i += 2; while(i < g.length && g[i][0] === 42) i++; }
          while(i < g.length && [97, 11, 21, 12, 22, 13, 23].includes(g[i][0])) i++; }
      }
    }
    if(pts.length > 2) loops.push(pts);
  }
  return loops;
}
function arcPts(a, b, bulge){
  const ang = 4 * Math.atan(bulge), d = Math.hypot(b[0] - a[0], b[1] - a[1]); if(!d) return [];
  const r = d / (2 * Math.sin(Math.abs(ang) / 2)), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, h = Math.sqrt(Math.max(0, r * r - d * d / 4)), ux = -(b[1] - a[1]) / d, uy = (b[0] - a[0]) / d;
  const sgn = (bulge > 0) === (Math.abs(ang) < Math.PI) ? 1 : -1, cx = mx + sgn * h * ux, cy = my + sgn * h * uy;
  let a0 = Math.atan2(a[1] - cy, a[0] - cx); const out = []; for(let k = 1; k < 12; k++) out.push([cx + r * Math.cos(a0 + ang * k / 12), cy + r * Math.sin(a0 + ang * k / 12)]); return out;
}
function hatchLines(e, bb){
  const g = e.g, out = []; let i = g.findIndex(p => p[0] === 78); if(i < 0) return out;
  const n = parseInt(g[i][1], 10); i++;
  const scale = gn(e, 41, 1) || 1;
  const diag = Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0), cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
  for(let k = 0; k < n && i < g.length; k++){
    const o = {}; while(i < g.length && [53, 43, 44, 45, 46, 79, 49].includes(g[i][0])){ if(g[i][0] === 49){ i++; continue; } if(o[g[i][0]] == null) o[g[i][0]] = parseFloat(g[i][1]); i++; if(g[i] && g[i][0] === 53) break; }
    const ang = (o[53] || 0) * Math.PI / 180, ox = o[45] || 0, oy = o[46] || 0;
    const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux, sp = Math.abs(ox * nx + oy * ny) || 1;
    const bx = o[43] || 0, by = o[44] || 0, d0 = (cx - bx) * nx + (cy - by) * ny;
    const cnt = Math.min(400, Math.ceil(diag / sp) + 1), base = Math.round(d0 / sp);
    for(let j = -cnt; j <= cnt; j++){ const d = (base + j) * sp, px = bx + nx * d, py = by + ny * d, t = (cx - px) * ux + (cy - py) * uy;
      out.push([[px + ux * (t - diag), py + uy * (t - diag)], [px + ux * (t + diag), py + uy * (t + diag)]]); }
  }
  return out;
}
function bboxOf(P){ let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for(const [x, y] of P){ if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; } return {x0, y0, x1, y1}; }

/* 図形の代表点（どの枠に属するかの判定用） */
function refPoint(e){
  switch(e.type){
    case 'LWPOLYLINE': case 'LINE': case 'CIRCLE': case 'ARC': case 'ELLIPSE': case 'TEXT': case 'MTEXT': case 'INSERT': case 'SPLINE': return [gn(e, 10), gn(e, 20)];
    case 'POLYLINE': { const v = (e.verts || [])[0]; return v ? [gn(v, 10), gn(v, 20)] : null; }
    case 'HATCH': { const L = hatchLoops(e); return L.length ? L[0][0] : null; }
    case 'MULTILEADER': case 'MLEADER': { const m = parseMLeader(e); return m && m.tx != null ? [m.tx, m.ty] : (m && m.lines[0] ? m.lines[0][0] : null); }
    case 'DIMENSION': return [gn(e, 10), gn(e, 20)];
    default: return null;
  }
}

/* 図面の枠を探す：同じ大きさで繰り返す長方形のうち「写真」の文字を最も多く含むもの。無ければ図形のまとまりごと */
const PHOTO_RE = /写真\s*[:：]?\s*([0-9０-９]+(?:\s*[,，、～〜~\-－‐]\s*[0-9０-９]+)*)/;
function entText(e){
  if(e.type === 'TEXT') return gv(e, 1, '');
  if(e.type === 'MTEXT') return mtextPlain(gall(e, 3).join('') + gv(e, 1, ''));
  if(e.type === 'MULTILEADER' || e.type === 'MLEADER'){ const m = parseMLeader(e); return m ? m.text : ''; }
  return '';
}
function rectOf(e){
  let xs, ys;
  if(e.type === 'LWPOLYLINE'){ xs = gall(e, 10).map(Number); ys = gall(e, 20).map(Number); if(!((parseInt(gv(e, 70, '0'), 10) & 1) === 1) && !(xs.length === 5 && xs[0] === xs[4] && ys[0] === ys[4])) return null; }
  else if(e.type === 'POLYLINE'){ const V = (e.verts || []); xs = V.map(v => gn(v, 10)); ys = V.map(v => gn(v, 20)); if(!((parseInt(gv(e, 70, '0'), 10) & 1) === 1) && !(xs.length === 5 && xs[0] === xs[4] && ys[0] === ys[4])) return null; }
  else return null;
  if(xs.length === 5){ xs = xs.slice(0, 4); ys = ys.slice(0, 4); }
  if(xs.length !== 4) return null;
  const b = {x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys)};
  // 軸に平行な長方形だけ
  const ok = xs.every(x => Math.abs(x - b.x0) < 1e-6 * (b.x1 - b.x0 + 1) + 0.01 || Math.abs(x - b.x1) < 1e-6 * (b.x1 - b.x0 + 1) + 0.01);
  return ok && b.x1 - b.x0 > 0 && b.y1 - b.y0 > 0 ? b : null;
}
function findFrames(D){
  const labels = [];
  for(const e of D.ents){ const t = entText(e); if(t && PHOTO_RE.test(t)){ const p = refPoint(e); if(p && p[0] != null) labels.push(p); } }
  const groups = {};
  for(const e of D.ents){ const b = rectOf(e); if(!b) continue; const w = b.x1 - b.x0, h = b.y1 - b.y0; const key = Math.round(w / Math.max(1, w * 0.005)) + ':' + Math.round(h / Math.max(1, h * 0.005)) + ':' + Math.round(w) + 'x' + Math.round(h);
    (groups[Math.round(w) + 'x' + Math.round(h)] = groups[Math.round(w) + 'x' + Math.round(h)] || []).push(b); }
  let best = null, bestScore = 0;
  for(const [k, arr] of Object.entries(groups)){
    // 重複（同じ位置の枠）を除く
    const uniq = []; for(const b of arr) if(!uniq.some(u => Math.abs(u.x0 - b.x0) < 1 && Math.abs(u.y0 - b.y0) < 1)) uniq.push(b);
    if(uniq.length < 2 && !(uniq.length === 1 && labels.length)) continue;
    const cov = labels.filter(p => uniq.some(f => p[0] >= f.x0 && p[0] <= f.x1 && p[1] >= f.y0 && p[1] <= f.y1)).length;
    const area = (uniq[0].x1 - uniq[0].x0) * (uniq[0].y1 - uniq[0].y0);
    const score = cov * 1e6 + Math.min(uniq.length, 999) * 10 + Math.log(area);
    if(cov > 0 && score > bestScore){ bestScore = score; best = uniq; }
  }
  let fr = best && labels.length && best.length && (labels.filter(p => best.some(f => p[0] >= f.x0 && p[0] <= f.x1 && p[1] >= f.y0 && p[1] <= f.y1)).length >= labels.length * 0.5) ? best : null;
  if(!fr) fr = clusterFrames(D);
  // 上の段から、左から順に
  const rowH = fr.length ? Math.min(...fr.map(f => f.y1 - f.y0)) : 1;
  fr.sort((a, b) => (Math.round(b.y1 / (rowH / 2)) - Math.round(a.y1 / (rowH / 2))) || a.x0 - b.x0);
  return fr;
}
// 枠がない図面：図形が集まっている範囲ごとに1枚
function clusterFrames(D){
  const P = []; for(const e of D.ents){ if(!layerVisible(e, D)) continue; const p = refPoint(e); if(p && isFinite(p[0]) && isFinite(p[1])) P.push(p); }
  if(!P.length) return [];
  const bb = bboxOf(P), W = bb.x1 - bb.x0 || 1, H = bb.y1 - bb.y0 || 1, cell = Math.max(W, H) / 160, nx = Math.ceil(W / cell) + 1, ny = Math.ceil(H / cell) + 1;
  const occ = new Uint8Array(nx * ny); for(const [x, y] of P){ occ[Math.floor((y - bb.y0) / cell) * nx + Math.floor((x - bb.x0) / cell)] = 1; }
  // 少し太らせてから連結成分
  const R = 2, dil = new Uint8Array(nx * ny);
  for(let y = 0; y < ny; y++) for(let x = 0; x < nx; x++) if(occ[y * nx + x]) for(let dy = -R; dy <= R; dy++) for(let dx = -R; dx <= R; dx++){ const xx = x + dx, yy = y + dy; if(xx >= 0 && yy >= 0 && xx < nx && yy < ny) dil[yy * nx + xx] = 1; }
  const lab = new Int32Array(nx * ny), comps = []; let n = 0;
  for(let i = 0; i < nx * ny; i++){ if(!dil[i] || lab[i]) continue; n++; const st = [i]; lab[i] = n; let x0 = nx, y0 = ny, x1 = 0, y1 = 0, cnt = 0;
    while(st.length){ const q = st.pop(), x = q % nx, y = (q / nx) | 0; cnt += occ[q]; if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y;
      for(const r of [x > 0 ? q - 1 : -1, x < nx - 1 ? q + 1 : -1, y > 0 ? q - nx : -1, y < ny - 1 ? q + nx : -1]) if(r >= 0 && dil[r] && !lab[r]){ lab[r] = n; st.push(r); } }
    comps.push({x0: bb.x0 + x0 * cell, y0: bb.y0 + y0 * cell, x1: bb.x0 + (x1 + 1) * cell, y1: bb.y0 + (y1 + 1) * cell, cnt}); }
  const big = comps.filter(c => c.cnt >= 20);
  return (big.length ? big : comps).map(c => { const px = (c.x1 - c.x0) * 0.03, py = (c.y1 - c.y0) * 0.03; return {x0: c.x0 - px, y0: c.y0 - py, x1: c.x1 + px, y1: c.y1 + py}; });
}

/* メイン：DXF → ページ */
function dxfToPages(buf, onProg){
  const D = parseDXF(buf);
  const frames = findFrames(D);
  if(!frames.length) throw new Error('図面が見つかりません');
  const per = frames.map(() => []);
  for(const e of D.ents){
    const p = refPoint(e); if(!p || p[0] == null || p[1] == null) continue;
    let k = frames.findIndex(f => p[0] >= f.x0 && p[0] <= f.x1 && p[1] >= f.y0 && p[1] <= f.y1);
    if(k < 0){ // 枠のすぐ外（余白）に書かれたものは一番近い枠へ
      let bd = Infinity; frames.forEach((f, j) => { const d = Math.hypot(Math.max(0, f.x0 - p[0], p[0] - f.x1), Math.max(0, f.y0 - p[1], p[1] - f.y1)); const lim = (f.x1 - f.x0) * 0.05; if(d < lim && d < bd){ bd = d; k = j; } }); }
    if(k >= 0) per[k].push(e);
  }
  const pages = [];
  frames.forEach((f, k) => {
    onProg && onProg(`損傷図 ${k + 1}/${frames.length}`);
    if(per[k].filter(e => layerVisible(e, D)).length < 3) return;   // 空の枠は飛ばす
    const fw = f.x1 - f.x0, fh = f.y1 - f.y0, W = 1190, H = W * fh / fw, s = W / fw;
    const ctx = {sw: f2(Math.max(fw / 4000, 0.1)), hid: 0, texts: [], sc: 1, T: null};
    const body = [];
    for(const e of per[k]){ try{ const r = entSVG(e, D, ctx); if(r) body.push(r); }catch(err){ /* 読めない図形は飛ばす */ } }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f2(W)} ${f2(H)}" width="${f2(W)}" height="${f2(H)}"><rect width="100%" height="100%" fill="#fff"/><clipPath id="fr"><rect x="0" y="0" width="${f2(W)}" height="${f2(H)}"/></clipPath><g clip-path="url(#fr)"><g transform="matrix(${s} 0 0 ${-s} ${f2(-f.x0 * s)} ${f2(f.y1 * s)})">${body.join('')}</g></g></svg>`;
    const toPage = (x, y) => [(x - f.x0) * s, (f.y1 - y) * s];
    // 写真番号の見出し
    const labels = [], cams = [];
    // 撮影No（印刷しない画層でも読む）
    for(const e of per[k]){ if(!/オリジナル/.test(gv(e, 8, ''))) continue;
      if(e.type === 'TEXT' || e.type === 'MTEXT'){ const tx = e.type === 'TEXT' ? gv(e, 1, '') : mtextPlain(gall(e, 3).join('') + gv(e, 1, '')); const h = gn(e, 40, 2.5);
        let x = gn(e, 10), y = gn(e, 20); if(e.type === 'TEXT' && (parseInt(gv(e, 72, '0'), 10) || parseInt(gv(e, 73, '0'), 10)) && gv(e, 11) != null){ x = gn(e, 11); y = gn(e, 21); }
        const w = textW(tx, h, 1); const [px, py] = toPage(x, y + h); cams.push({text: tx.trim(), rect: [px, py, px + w * s, py + h * s]}); } }
    let title = '';
    for(const t of ctx.texts){
      const [px, py] = toPage(t.x, t.y + t.h), ph = t.h * s, pw = t.w * s;
      if(/オリジナル/.test(t.layer)) continue;
      const m = t.s.match(PHOTO_RE);
      if(m){
        const before = t.s.slice(0, m.index), cw = c => /[\x00-\x7f｡-ﾟ]/.test(c) ? ph * 0.5 : ph;
        let x = px; for(const c of before) x += cw(c);
        const lx0 = x; for(const c of t.s.slice(m.index, m.index + m[0].length - m[1].length)) x += cw(c);
        const nums = [], rects = []; let cur = '', cx0 = x, range = false;
        for(const c of m[1] + ','){ const d = c.replace(/[０-９]/, z => String.fromCharCode(z.charCodeAt(0) - 0xFEE0));
          if(/\d/.test(d)){ if(!cur) cx0 = x; cur += d; }
          else { if(cur){ const n = +cur, r = [cx0, py, x, py + ph];
              if(range && nums.length){ const a = +nums[nums.length - 1], ra = rects[rects.length - 1];
                if(n > a && n - a <= 50) for(let v = a + 1; v < n; v++){ nums.push(String(v)); rects.push([ra[2], py, r[0], py + ph]); } }
              nums.push(String(n)); rects.push(r); cur = ''; range = false; }
            if(/[～〜~\-－‐]/.test(c)) range = true; }
          x += cw(c); }
        const status = /新規/.test(t.layer) ? '新規' : /補修/.test(t.layer) ? '補修済' : '';
        if(nums.length) labels.push({line: [lx0, py, Math.max(rects[rects.length - 1][2], px + pw), py + ph], nums, rects, status, layer: t.layer});
      }
    }
    // ページ名：枠の上部にある一番大きな文字（例「桁下面」「1径間目」「上部工（1径間）」）
    const cand = ctx.texts.filter(t => !t.leader && !PHOTO_RE.test(t.s) && !/オリジナル/.test(t.layer) && t.s.trim()).map(t => ({t, p: toPage(t.x, t.y)})).filter(o => o.p[1] < H * 0.3);
    const hmax = Math.max(0, ...cand.map(o => o.t.h));
    const named = cand.filter(o => /径間|工|桁|床版|下面|橋面|支承|橋台|橋脚|側面/.test(o.t.s));
    const hn = Math.max(0, ...named.map(o => o.t.h));
    title = (named.length ? named.filter(o => o.t.h >= hn * 0.8) : cand.filter(o => o.t.h >= hmax * 0.8)).sort((a, b) => a.p[1] - b.p[1] || a.p[0] - b.p[0]).slice(0, 3).map(o => o.t.s.replace(/\u3000/g, '').trim()).join(' ');
    pages.push({w: W, h: H, svg, title: title || `枠${k + 1}`, labels, cams});
  });
  return pages;
}

global.DXFReader = {parseDXF, dxfToPages, mtextPlain};
})(window);
