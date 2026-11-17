/* Export and import of flows: JSON (round trip), PNG (picture) and PDF (picture + card list), no libraries.
 * The pure parts (JSON shape, SVG drawing, PDF bytes, file names) work in Node and are unit tested.
 * The browser-only helpers at the bottom turn the SVG into PNG/JPEG with a <canvas> and start the download. UMD: AF.exporter. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.AF = root.AF || {}; root.AF.exporter = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMAT = 'agentflow.flow';
  const MAX_NODES = 200, MAX_EDGES = 400;
  const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
  const safeCopy = x => JSON.parse(JSON.stringify(x), (k, v) => (FORBIDDEN.has(k) ? undefined : v));
  const NOT_A_FLOW = 'That file is not an AgentFlow flow. Choose a file made with "Export JSON" in the builder.';
  const CAT_COLORS = { trigger: '#C8F25A', ai: '#1D6B57', data: '#2F5FD0', output: '#D98A12', logic: '#5B7C99', code: '#14201E' };

  // ------------------------------------------------------------------ JSON
  /** The flow itself. No owner, company or ids of people: a file you can hand to anyone. */
  function toExportObject(flow) {
    return { format: FORMAT, version: 1, name: flow.name, exported_at: new Date().toISOString(), nodes: safeCopy(flow.nodes), edges: safeCopy(flow.edges) };
  }

  /** {ok, name, nodes, edges} from parsed JSON, or {ok:false, error}. The server checks everything again; this gives a friendly early message. */
  function parseImport(data, fileName) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: NOT_A_FLOW };
    const p = data.flow && typeof data.flow === 'object' ? data.flow : data;
    if (p.format !== undefined && p.format !== FORMAT) return { ok: false, error: NOT_A_FLOW };
    if (!Array.isArray(p.nodes) || !Array.isArray(p.edges)) return { ok: false, error: NOT_A_FLOW };
    if (p.nodes.length > MAX_NODES) return { ok: false, error: `This flow has ${p.nodes.length} cards. A flow can have at most ${MAX_NODES}.` };
    if (p.edges.length > MAX_EDGES) return { ok: false, error: `This flow has ${p.edges.length} connections. A flow can have at most ${MAX_EDGES}.` };
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : String(fileName || 'Imported flow').replace(/\.json$/i, '');
    return { ok: true, name, nodes: safeCopy(p.nodes), edges: safeCopy(p.edges) };
  }

  // ------------------------------------------------------------------ file names
  function safeFileName(name, ext) {
    let base = String(name || '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'flow';
    if (/^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = 'flow-' + base;   // names Windows refuses
    return `${base}.${ext}`;
  }

  // ------------------------------------------------------------------ SVG picture
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

  /** Draws the flow exactly as the canvas lays it out (light colours, so it prints well). {svg, width, height}. */
  function toSvg(flow, opts) {
    const { Nodes, CV } = opts; const PAD = 40; const HEAD = opts.title ? 44 : 0; const W = CV.NODE_W, H = CV.NODE_H;
    const num = v => (Number.isFinite(v) ? v : 0);
    const nodes = (flow.nodes || []).map(n => Object.assign({}, n, { x: num(n.x), y: num(n.y) })); const edges = flow.edges || [];
    if (!nodes.length) {
      const w = 420, h = 120 + HEAD;
      return { width: w, height: h, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#F3F5F1"/>${opts.title ? `<text x="${PAD}" y="32" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="700" fill="#14201E">${esc(clip(flow.name, 60))}</text>` : ''}<text x="${PAD}" y="${HEAD + 60}" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="#4A5B57">This flow has no cards yet.</text></svg>` };
    }
    const minX = Math.min(...nodes.map(n => n.x)); const minY = Math.min(...nodes.map(n => n.y));
    const maxX = Math.max(...nodes.map(n => n.x)) + W; const maxY = Math.max(...nodes.map(n => n.y)) + H;
    const width = Math.ceil(maxX - minX + 2 * PAD); const height = Math.ceil(maxY - minY + 2 * PAD + HEAD);
    const ox = PAD - minX; const oy = PAD + HEAD - minY;
    const byId = new Map(nodes.map(n => [n.id, n]));
    const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, Helvetica, sans-serif">`, `<rect width="${width}" height="${height}" fill="#F3F5F1"/>`];
    if (opts.title) out.push(`<text x="${PAD}" y="30" font-size="18" font-weight="700" fill="#14201E">${esc(clip(flow.name, 70))}</text>`);
    for (const e of edges) {
      const a = byId.get(e.from); const b = byId.get(e.to); if (!a || !b) continue;
      const p1 = CV.portPosition(a, 'out', e.fromPort || 'out'); const p2 = CV.portPosition(b, 'in', e.toPort || 'in');
      out.push(`<path class="wire" d="${CV.wirePath(p1.x + ox, p1.y + oy, p2.x + ox, p2.y + oy)}" fill="none" stroke="#14201E" stroke-width="2.5" stroke-linecap="round"/>`);
      if (e.fromPort && e.fromPort !== 'out') out.push(`<text x="${p1.x + ox + 8}" y="${p1.y + oy - 6}" font-size="10" font-weight="700" fill="#4A5B57">${esc(String(e.fromPort).toUpperCase())}</text>`);
    }
    for (const n of nodes) {
      const def = Nodes.get(n.type) || (n.base && Nodes.get(n.base)); const cat = def ? def.category : 'ai';
      const x = n.x + ox; const y = n.y + oy;
      const kind = def ? (Nodes.categories.find(c => c.id === cat) || { label: cat }).label.replace(/s$/, '') : 'Unknown';
      let meta = ''; try { meta = def ? Nodes.summary(n) : 'Unknown card type'; } catch (err) { meta = ''; }
      out.push(`<g class="card"><rect x="${x + 3}" y="${y + 4}" width="${W}" height="${H}" rx="10" fill="#14201E" opacity=".18"/><rect x="${x}" y="${y}" width="${W}" height="${H}" rx="10" fill="#FFFFFF" stroke="#14201E" stroke-width="2"/><rect x="${x}" y="${y}" width="10" height="${H}" rx="5" fill="${CAT_COLORS[cat] || '#1D6B57'}" stroke="#14201E" stroke-width="2"/><text x="${x + 22}" y="${y + 22}" font-size="10" letter-spacing="1" fill="#4A5B57">${esc(kind.toUpperCase())}</text><text x="${x + 22}" y="${y + 44}" font-size="15" font-weight="700" fill="#14201E">${esc(clip(n.label, 24))}</text><text x="${x + 22}" y="${y + 66}" font-size="11" fill="#4A5B57">${esc(clip(meta, 34))}</text></g>`);
    }
    out.push('</svg>');
    return { svg: out.join(''), width, height };
  }

  // ------------------------------------------------------------------ PDF (hand-written, one picture + text pages)
  const PAGE_W = 842, PAGE_H = 595, MARGIN = 40, LINE = 14, CHARS = 120;
  const latin1 = s => String(s).replace(/[^\x20-\x7E]/g, '?');
  const pdfText = s => latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const bytesOf = s => Uint8Array.from(s, ch => ch.charCodeAt(0) & 255);
  const wrap = (s, n) => { const out = []; let t = latin1(s); while (t.length > n) { let i = t.lastIndexOf(' ', n); if (i < n / 2) i = n; out.push(t.slice(0, i)); t = t.slice(i).trimStart(); } out.push(t); return out; };

  /** opts: {title, subtitle, jpeg: {bytes, width, height} | null, lines: [string]}. Returns Uint8Array. */
  function buildPdf(opts) {
    const objects = []; // each: Uint8Array body (without "n 0 obj" wrapper)
    const add = body => { objects.push(typeof body === 'string' ? bytesOf(body) : body); return objects.length; };
    const stream = (dict, data) => { const head = bytesOf(`<< ${dict} /Length ${data.length} >>\nstream\n`); const tail = bytesOf('\nendstream'); const b = new Uint8Array(head.length + data.length + tail.length); b.set(head, 0); b.set(data, head.length); b.set(tail, head.length + data.length); return b; };

    const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
    const pagesRef = add('PLACEHOLDER');            // object 2, filled in at the end
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    let imageRef = 0;
    if (opts.jpeg) imageRef = add(stream(`/Type /XObject /Subtype /Image /Width ${opts.jpeg.width} /Height ${opts.jpeg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, opts.jpeg.bytes));

    const pageRefs = [];
    const addPage = content => {
      const c = add(stream('', bytesOf(content)));
      const xo = imageRef && pageRefs.length === 0 ? ` /XObject << /Im1 ${imageRef} 0 R >>` : '';
      const p = add(`<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >>${xo} >> >>`);
      pageRefs.push(p);
    };

    // page 1: title, subtitle, picture scaled to fit
    let p1 = `BT /F2 18 Tf ${MARGIN} ${PAGE_H - 50} Td (${pdfText(String(opts.title || '').slice(0, 80))}) Tj ET\n`;
    if (opts.subtitle) p1 += `BT /F1 10 Tf ${MARGIN} ${PAGE_H - 68} Td (${pdfText(String(opts.subtitle).slice(0, 120))}) Tj ET\n`;
    if (opts.jpeg) {
      const maxW = PAGE_W - 2 * MARGIN; const maxH = PAGE_H - 2 * MARGIN - 60;
      const s = Math.min(maxW / opts.jpeg.width, maxH / opts.jpeg.height, 1.5); const w = opts.jpeg.width * s; const h = opts.jpeg.height * s;
      p1 += `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${MARGIN} ${(PAGE_H - 85 - h).toFixed(2)} cm /Im1 Do Q\n`;
    }
    addPage(p1);

    // following pages: the card list, wrapped, 33 lines per page
    const lines = (opts.lines || []).flatMap(l => wrap(l, CHARS));
    const perPage = Math.floor((PAGE_H - 2 * MARGIN - 20) / LINE);
    for (let i = 0; i < lines.length; i += perPage) {
      let c = `BT /F2 12 Tf ${MARGIN} ${PAGE_H - 50} Td (${i === 0 ? 'Cards in this flow' : 'Cards in this flow (continued)'}) Tj ET\nBT /F1 10 Tf ${LINE} TL ${MARGIN} ${PAGE_H - 72} Td\n`;
      for (const l of lines.slice(i, i + perPage)) c += `(${pdfText(l)}) Tj T*\n`;
      addPage(c + 'ET\n');
    }
    objects[pagesRef - 1] = bytesOf(`<< /Type /Pages /Kids [${pageRefs.map(r => r + ' 0 R').join(' ')}] /Count ${pageRefs.length} >>`);

    // assemble with a correct cross-reference table
    const chunks = [bytesOf('%PDF-1.4\n')]; const offsets = []; let pos = chunks[0].length;
    objects.forEach((body, i) => {
      offsets.push(pos);
      const head = bytesOf(`${i + 1} 0 obj\n`); const tail = bytesOf('\nendobj\n');
      chunks.push(head, body, tail); pos += head.length + body.length + tail.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`].concat(offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`)).join('');
    chunks.push(bytesOf(xref + `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
    const total = chunks.reduce((n, c) => n + c.length, 0); const out = new Uint8Array(total); let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  // ------------------------------------------------------------------ browser only
  /** Rasterise an SVG string. kind: 'png' | 'jpeg'. Resolves {blob, bytes, width, height}. */
  function rasterize(svg, width, height, kind, scale) {
    return new Promise((resolve, reject) => {
      const s = scale || 2; const img = new Image();
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = Math.round(width * s); c.height = Math.round(height * s);
        const g = c.getContext('2d'); g.fillStyle = '#F3F5F1'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(async blob => {
          if (!blob) return reject(new Error('This browser could not make the picture.'));
          resolve({ blob, bytes: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height });
        }, kind === 'jpeg' ? 'image/jpeg' : 'image/png', 0.92);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This browser could not draw the flow as a picture.')); };
      img.src = url;
    });
  }
  function download(blobOrBytes, fileName, type) {
    const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes], { type });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  return { FORMAT, toExportObject, parseImport, toSvg, buildPdf, safeFileName, rasterize, download };
});
