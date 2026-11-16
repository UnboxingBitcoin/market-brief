/* My portfolio (Nostr): login with a NIP-46 remote signer, holdings saved as a
   NIP-44 self-encrypted kind 30078 event. Nothing leaves the browser unencrypted. */
(function () {
  const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://relay.nsec.app"];
  const KIND = 30078, DTAG = "market-brief:portfolio", LS = "mb-nostr-session";
  const NT = window.NT;
  const root = document.getElementById("pf-root");
  if (!root || !NT) return;

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const fmt = v => v == null || isNaN(v) ? "—" : (Math.abs(v) >= 1000 ? v.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
  const pctS = v => v == null || isNaN(v) ? "—" : (v > 0 ? "+" : "") + v.toFixed(1) + "%";
  const lvl = (p, d) => Math.pow(Math.sqrt(p) + d / 180, 2);

  const pool = new NT.SimplePool();
  let signer = null, pubkey = null, data = { v: 1, updated: null, holdings: [] }, dirty = false, status = "", editing = null, filt = "all";

  function saveSession(sk, bp) { try { localStorage.setItem(LS, JSON.stringify({ sk: NT.bytesToHex(sk), bp })); } catch (e) {} }
  function loadSession() { try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch (e) { return null; } }
  function clearSession() { try { localStorage.removeItem(LS); } catch (e) {} }

  function setStatus(s) { status = s; const st = document.getElementById("pf-status"); if (st) st.textContent = s; }

  // ---------- login ----------
  async function loginBunker(input) {
    setStatus("Connecting to your signer…");
    const bp = await NT.parseBunkerInput(input.trim());
    if (!bp) throw new Error("That isn't a bunker:// link or a name@nsec.app address.");
    const sk = NT.generateSecretKey();
    const s = NT.BunkerSigner.fromBunker(sk, bp, { pool, onauth: url => showAuth(url) });
    await s.connect({ name: "Market Brief", url: location.origin + location.pathname });
    await afterLogin(s, sk, bp);
  }

  let ncAbort = null;
  async function loginNostrConnect() {
    const sk = NT.generateSecretKey();
    const secret = Math.random().toString(36).slice(2, 12);
    const uri = NT.createNostrConnectURI({
      clientPubkey: NT.getPublicKey(sk), relays: RELAYS.slice(0, 3), secret,
      perms: ["get_public_key", "sign_event:30078", "nip44_encrypt", "nip44_decrypt"],
      name: "Market Brief", url: location.origin + location.pathname
    });
    showConnectURI(uri);
    ncAbort = new AbortController();
    const s = await NT.BunkerSigner.fromURI(sk, uri, { pool, onauth: url => showAuth(url) }, ncAbort.signal);
    await afterLogin(s, sk, s.bp);
  }

  async function afterLogin(s, sk, bp) {
    signer = s;
    setStatus("Getting your key…");
    pubkey = await s.getPublicKey();
    saveSession(sk, bp);
    await loadPortfolio();
  }

  async function resume() {
    const ss = loadSession();
    if (!ss) return false;
    try {
      const sk = NT.hexToBytes(ss.sk);
      signer = NT.BunkerSigner.fromBunker(sk, ss.bp, { pool, onauth: url => showAuth(url) });
      setStatus("Reconnecting to your signer…"); render();
      pubkey = await signer.getPublicKey();
      await loadPortfolio();
      return true;
    } catch (e) { signer = null; pubkey = null; setStatus("Saved login expired. Connect again."); render(); return false; }
  }

  async function logout() {
    try { if (signer) await signer.close(); } catch (e) {}
    signer = null; pubkey = null; data = { v: 1, updated: null, holdings: [] }; dirty = false; clearSession(); setStatus("Logged out."); render();
  }

  // ---------- storage ----------
  async function loadPortfolio() {
    setStatus("Loading your portfolio from relays…"); render();
    const evs = await pool.querySync(RELAYS, { kinds: [KIND], authors: [pubkey], "#d": [DTAG], limit: 5 }, { maxWait: 6000 });
    const ev = evs.filter(e => NT.verifyEvent(e)).sort((a, b) => b.created_at - a.created_at)[0];
    if (ev) {
      setStatus("Decrypting in your signer…");
      const plain = await signer.nip44Decrypt(pubkey, ev.content);
      const d = JSON.parse(plain);
      data = { v: 1, updated: d.updated || null, holdings: Array.isArray(d.holdings) ? d.holdings : [] };
      setStatus("Loaded " + data.holdings.length + " holdings, saved " + new Date(ev.created_at * 1000).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) + ".");
    } else {
      data = { v: 1, updated: null, holdings: [] };
      setStatus("No saved portfolio yet. Import your holdings file or add stocks, then tap Save.");
    }
    dirty = false; render();
  }

  async function savePortfolio() {
    if (!signer) return;
    setStatus("Encrypting in your signer…"); render();
    data.updated = new Date().toISOString();
    const content = await signer.nip44Encrypt(pubkey, JSON.stringify(data));
    setStatus("Signing…");
    const ev = await signer.signEvent({ kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [["d", DTAG], ["client", "market-brief"]], content });
    setStatus("Publishing to relays…");
    const res = await Promise.allSettled(pool.publish(RELAYS, ev));
    const ok = res.filter(r => r.status === "fulfilled").length;
    if (!ok) throw new Error("No relay accepted the save. Check your connection and try again.");
    dirty = false; setStatus("Saved (encrypted) to " + ok + " of " + RELAYS.length + " relays."); render();
  }

  // ---------- prices & calls ----------
  function priceOf(h) {
    const P = window.PRICES || {};
    const hit = (h.isin && P[h.isin]) || (h.symbol && P[h.symbol.toUpperCase()]);
    if (hit && hit.price) return { price: +hit.price, date: hit.date || "", src: "NSE" };
    if (h.price) return { price: +h.price, date: h.priceDate || "", src: "you" };
    return { price: +h.avg, date: "", src: "cost" };
  }
  function call(h, p) {
    const stop = lvl(h.avg, -180), t1 = lvl(h.avg, 180);
    if (p <= stop) return { code: "exit", label: "✕ Review exit", why: "Below the −180° Gann stop from your cost (" + fmt(stop) + ")." };
    if (p >= t1) return { code: "reduce", label: "− Book some", why: "Above +180° from your cost (" + fmt(t1) + "). Trail a stop." };
    if (p > h.avg) return { code: "add", label: "▲ In profit", why: "Above cost. Trail the stop to cost." };
    return { code: "hold", label: "■ Hold", why: "Between cost stop and target." };
  }

  // ---------- import ----------
  const HDR = {
    name: ["name", "company", "company name", "instrument", "scrip", "scrip name", "stock", "security", "security name", "stock name"],
    symbol: ["symbol", "trading symbol", "tradingsymbol", "ticker", "nse symbol", "nse code"],
    isin: ["isin", "isin code"],
    qty: ["qty", "quantity", "shares", "balance", "free qty", "holding qty", "total qty", "qty.", "available qty", "current qty", "net qty"],
    avg: ["avg", "avg price", "average price", "avg. price", "avg cost", "average cost", "buy price", "buy avg", "cost price", "avg. cost", "purchase price", "avg buy price"],
    price: ["ltp", "last price", "close", "closing price", "market price", "cmp", "current price", "price"]
  };
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9. ]/g, " ").replace(/\s+/g, " ").trim();
  function mapHeader(row) {
    const m = {};
    row.forEach((c, i) => { const n = norm(c); for (const k in HDR) if (m[k] == null && HDR[k].includes(n)) m[k] = i; });
    return m;
  }
  const num = v => { const n = parseFloat(String(v == null ? "" : v).replace(/[,₹\s]/g, "")); return isNaN(n) ? null : n; };
  function rowsToHoldings(rows) {
    let hi = -1, m = null;
    for (let i = 0; i < Math.min(rows.length, 40); i++) { const mm = mapHeader(rows[i] || []); if ((mm.name != null || mm.symbol != null) && mm.qty != null && mm.avg != null) { hi = i; m = mm; break; } }
    if (hi < 0) throw new Error("Couldn't find the columns. The file needs a name or symbol column, a quantity column and an average-price column.");
    const out = [];
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i] || [], q = num(r[m.qty]), a = num(r[m.avg]);
      const name = m.name != null ? String(r[m.name] || "").trim() : "";
      const sym = m.symbol != null ? String(r[m.symbol] || "").trim() : "";
      if (!(name || sym) || !q || !a) continue;
      if (/^total/i.test(name)) continue;
      out.push({ id: Math.random().toString(36).slice(2, 10), name: name || sym, symbol: sym, isin: m.isin != null ? String(r[m.isin] || "").trim() : "", qty: q, avg: a, price: m.price != null ? num(r[m.price]) : null, priceDate: m.price != null ? "file" : "" });
    }
    if (!out.length) throw new Error("Found the columns but no holdings rows.");
    return out;
  }
  function parseCSV(text) {
    const rows = [];
    const lines = text.replace(/\r/g, "").split("\n");
    for (const line of lines) { if (!line.trim()) continue; const cells = []; let cur = "", q = false;
      for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === "," && !q) { cells.push(cur); cur = ""; } else cur += ch; }
      cells.push(cur); rows.push(cells); }
    return rows;
  }
  function loadXLSX() {
    return new Promise((res, rej) => { if (window.XLSX) return res(window.XLSX); const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"; s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error("Couldn't load the Excel reader. Try a CSV export.")); document.head.appendChild(s); });
  }
  async function importFile(file) {
    let rows;
    if (/\.(xlsx|xls)$/i.test(file.name)) { const X = await loadXLSX(); const wb = X.read(await file.arrayBuffer(), { type: "array" }); rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true }); }
    else if (/\.csv$/i.test(file.name) || file.type === "text/csv") rows = parseCSV(await file.text());
    else throw new Error("Use a CSV or Excel (.xlsx) holdings export. PDF isn't supported.");
    return rowsToHoldings(rows);
  }
  function mergeHoldings(list, replace) {
    if (replace) { data.holdings = list; return; }
    const key = h => (h.isin || h.symbol || h.name).toUpperCase();
    const map = new Map(data.holdings.map(h => [key(h), h]));
    list.forEach(n => { const o = map.get(key(n)); if (o) Object.assign(o, { qty: n.qty, avg: n.avg, price: n.price ?? o.price, priceDate: n.priceDate || o.priceDate, isin: n.isin || o.isin, symbol: n.symbol || o.symbol }); else data.holdings.push(n); });
  }

  // ---------- views ----------
  function showAuth(url) {
    const box = document.getElementById("pf-auth");
    if (!box) return;
    box.innerHTML = ""; box.appendChild(el("div", "small", "Your signer asks you to approve this login:"));
    const a = el("a", null, "Open approval page"); a.href = url; a.target = "_blank"; a.rel = "noopener"; box.appendChild(a);
  }
  function showConnectURI(uri) {
    const box = document.getElementById("pf-nc");
    if (!box) return;
    box.innerHTML = "";
    box.appendChild(el("div", "small", "On this phone: tap Open in signer app (Amber, nsec.app). On a computer: scan the code with your phone's signer."));
    const row = el("div", "chips");
    const a = el("a", "chip", "Open in signer app"); a.href = uri; row.appendChild(a);
    const cp = el("button", "chip", "Copy link"); cp.onclick = async () => { try { await navigator.clipboard.writeText(uri); cp.textContent = "Copied"; } catch (e) { cp.textContent = "Copy failed"; } };
    row.appendChild(cp); box.appendChild(row);
    try { const q = NT.qrcode(0, "L"); q.addData(uri); q.make(); const d = el("div", "pf-qr"); d.innerHTML = q.createSvgTag({ cellSize: 3, margin: 2, scalable: true }); box.appendChild(d); } catch (e) {}
    box.appendChild(el("div", "small", "Waiting for your signer… keep this page open."));
  }

  function card() { root.innerHTML = ""; const c = el("section", "card"); c.id = "portfolio"; c.appendChild(el("h2", null, "My portfolio · Nostr")); root.appendChild(c); return c; }

  function render() {
    const c = card();
    if (!signer || !pubkey) {
      c.appendChild(el("p", "p", "Log in with your Nostr remote signer to load and save your portfolio. It's encrypted to your own key before it leaves this page, so relays and this site can't read it."));
      const lb = el("label", "sub", "bunker:// link or name@nsec.app"); lb.htmlFor = "pf-bunker"; c.appendChild(lb);
      const inp = el("input", "pf-in"); inp.id = "pf-bunker"; inp.placeholder = "bunker://… or you@nsec.app"; inp.autocomplete = "off"; c.appendChild(inp);
      const row = el("div", "chips"); row.style.marginTop = "10px";
      const b1 = el("button", "btn", "Connect"); b1.onclick = async () => { try { b1.disabled = true; await loginBunker(inp.value); } catch (e) { setStatus("Couldn't connect: " + e.message); b1.disabled = false; } };
      const b2 = el("button", "btn sec", "Use signer app (QR / link)"); b2.onclick = async () => { try { b2.disabled = true; await loginNostrConnect(); } catch (e) { setStatus("Couldn't connect: " + (e.message || e)); b2.disabled = false; } };
      row.append(b1, b2); c.appendChild(row);
      const nc = el("div"); nc.id = "pf-nc"; c.appendChild(nc);
      const au = el("div"); au.id = "pf-auth"; c.appendChild(au);
      c.appendChild(el("div", "note", "")).id = "pf-status"; setStatus(status);
      return;
    }
    // logged in
    const np = NT.nip19.npubEncode(pubkey);
    c.appendChild(el("div", "meta", "Signed in · " + np.slice(0, 12) + "…" + np.slice(-6)));
    const H = data.holdings;
    let val = 0, cost = 0, anyNSE = false;
    const rows = H.map(h => { const pr = priceOf(h); if (pr.src === "NSE") anyNSE = true; val += h.qty * pr.price; cost += h.qty * h.avg; return { h, pr, cl: call(h, pr.price) }; });
    c.appendChild(el("div", "tot", H.length + " stocks · value ₹" + fmt(val) + " · cost ₹" + fmt(cost) + " · P&L " + pctS(cost ? (val / cost - 1) * 100 : 0)));
    if (!anyNSE && H.length) c.appendChild(el("div", "note", "Prices: the price you entered or imported (or your cost if none). Live NSE end-of-day prices will fill in automatically once that feed is added."));

    const tools = el("div", "chips");
    const fi = el("input"); fi.type = "file"; fi.accept = ".csv,.xlsx,.xls"; fi.hidden = true; fi.id = "pf-file";
    const bi = el("button", "btn sec", "Import file"); bi.onclick = () => fi.click();
    fi.onchange = async () => { const f = fi.files[0]; fi.value = ""; if (!f) return; try { const list = await importFile(f); askMerge(list); } catch (e) { setStatus(e.message); } };
    const ba = el("button", "btn sec", "+ Add stock"); ba.onclick = () => { editing = { id: Math.random().toString(36).slice(2, 10), name: "", symbol: "", isin: "", qty: "", avg: "", price: "", _new: true }; render(); };
    const bs = el("button", "btn", dirty ? "Save ●" : "Save"); bs.onclick = async () => { try { bs.disabled = true; await savePortfolio(); } catch (e) { setStatus("Save failed: " + e.message); bs.disabled = false; } };
    const bo = el("button", "btn sec", "Log out"); bo.onclick = logout;
    tools.append(bi, ba, bs, bo, fi); c.appendChild(tools);
    const mg = el("div"); mg.id = "pf-merge"; c.appendChild(mg);

    if (editing) c.appendChild(editForm(editing));

    if (H.length) {
      const fc = el("div", "chips");
      [["all", "All"], ["exit", "✕ Exit"], ["reduce", "− Book"], ["add", "▲ Profit"], ["hold", "■ Hold"]].forEach(([k, l]) => { const b = el("button", "chip", l + " " + (k === "all" ? H.length : rows.filter(r => r.cl.code === k).length)); b.setAttribute("aria-pressed", k === filt); b.onclick = () => { filt = k; render(); }; fc.appendChild(b); });
      c.appendChild(fc);
      const tb = el("table"); const hd = el("tr");
      [["Stock", ""], ["Price", "n"], ["P&L", "n"], ["Call", ""]].forEach(([t, k]) => hd.appendChild(el("th", k, t)));
      const th = el("thead"); th.appendChild(hd); tb.appendChild(th);
      const body = el("tbody");
      rows.filter(r => filt === "all" || r.cl.code === filt).sort((a, b) => b.h.qty * b.pr.price - a.h.qty * a.pr.price).forEach(({ h, pr, cl }) => {
        const tr = el("tr"); const t0 = el("td"); const nb = el("button", "rowbtn", h.name); t0.appendChild(nb); t0.appendChild(el("div", "small", h.qty + " sh @ " + fmt(h.avg))); tr.appendChild(t0);
        tr.appendChild(el("td", "n", fmt(pr.price)));
        const pl = (pr.price / h.avg - 1) * 100; tr.appendChild(el("td", "n " + (pl > 0 ? "up" : pl < 0 ? "dn" : ""), pctS(pl)));
        const ta = el("td"); ta.appendChild(el("span", "tag " + cl.code, cl.label)); tr.appendChild(ta); body.appendChild(tr);
        const det = el("tr", "det"); det.hidden = true; const dd = el("td"); dd.colSpan = 4;
        dd.appendChild(el("div", null, "From price " + fmt(pr.price) + " (" + (pr.src === "NSE" ? "NSE " + pr.date : pr.src === "you" ? (pr.date === "file" ? "from your file" : "entered " + (pr.date || "")) : "no price yet, using cost") + "): stop " + fmt(lvl(pr.price, -180)) + " · support " + fmt(lvl(pr.price, -90)) + " · resistance " + fmt(lvl(pr.price, 90)) + " · T1 " + fmt(lvl(pr.price, 180)) + " · T2 " + fmt(lvl(pr.price, 360)) + "."));
        dd.appendChild(el("div", null, "From your cost " + fmt(h.avg) + ": stop " + fmt(lvl(h.avg, -180)) + " · target " + fmt(lvl(h.avg, 180)) + ". " + cl.why));
        const eb = el("button", "chip", "Edit"); eb.style.marginTop = "8px"; eb.onclick = () => { editing = Object.assign({}, h); render(); }; dd.appendChild(eb);
        det.appendChild(dd); body.appendChild(det); nb.onclick = () => { det.hidden = !det.hidden; };
      });
      tb.appendChild(body); c.appendChild(tb);
      c.appendChild(el("div", "note", "Calls are simple Gann rules from your cost and price, worked out in this page. Tap a stock for levels or to edit."));
    }
    const st = el("div", "note"); st.id = "pf-status"; st.textContent = status; c.appendChild(st);
  }

  function askMerge(list) {
    const box = document.getElementById("pf-merge"); box.innerHTML = "";
    const d = el("div", "pf-ask"); d.appendChild(el("div", null, "Found " + list.length + " holdings in the file."));
    const r = el("div", "chips");
    const b1 = el("button", "btn", "Replace my list"); b1.onclick = () => { mergeHoldings(list, true); dirty = true; setStatus("Imported " + list.length + ". Tap Save to store it."); render(); };
    const b2 = el("button", "btn sec", "Merge (update matches)"); b2.onclick = () => { mergeHoldings(list, false); dirty = true; setStatus("Merged " + list.length + ". Tap Save to store it."); render(); };
    const b3 = el("button", "btn sec", "Cancel"); b3.onclick = () => { box.innerHTML = ""; };
    if (!data.holdings.length) { b2.remove(); }
    r.append(b1, b2, b3); d.appendChild(r); box.appendChild(d);
  }

  function editForm(h) {
    const f = el("form", "pf-form");
    const fields = [["name", "Stock name", "text"], ["symbol", "NSE symbol (optional)", "text"], ["isin", "ISIN (optional)", "text"], ["qty", "Quantity", "number"], ["avg", "Average price ₹", "number"], ["price", "Current price ₹ (optional)", "number"]];
    fields.forEach(([k, l, t]) => { const id = "pf-f-" + k; const lb = el("label", "sub", l); lb.htmlFor = id; const i = el("input", "pf-in"); i.id = id; i.type = t; if (t === "number") { i.step = "any"; i.inputMode = "decimal"; } i.value = h[k] ?? ""; f.append(lb, i); });
    const r = el("div", "chips"); r.style.marginTop = "10px";
    const ok = el("button", "btn", h._new ? "Add" : "Update"); ok.type = "submit";
    const cancel = el("button", "btn sec", "Cancel"); cancel.type = "button"; cancel.onclick = () => { editing = null; render(); };
    r.append(ok, cancel);
    if (!h._new) { const del = el("button", "btn sec", "Remove stock"); del.type = "button"; del.onclick = () => { data.holdings = data.holdings.filter(x => x.id !== h.id); editing = null; dirty = true; setStatus("Removed. Tap Save to store it."); render(); }; r.appendChild(del); }
    f.appendChild(r);
    f.onsubmit = e => {
      e.preventDefault();
      const g = k => f.querySelector("#pf-f-" + k).value.trim();
      const q = num(g("qty")), a = num(g("avg"));
      if (!g("name") || !q || !a) { setStatus("Name, quantity and average price are needed."); return; }
      const rec = { id: h.id, name: g("name"), symbol: g("symbol").toUpperCase(), isin: g("isin").toUpperCase(), qty: q, avg: a, price: num(g("price")), priceDate: num(g("price")) ? new Date().toISOString().slice(0, 10) : "" };
      const i = data.holdings.findIndex(x => x.id === h.id);
      if (i >= 0) data.holdings[i] = rec; else data.holdings.push(rec);
      editing = null; dirty = true; setStatus((i >= 0 ? "Updated " : "Added ") + rec.name + ". Tap Save to store it."); render();
    };
    return f;
  }

  window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
  render();
  resume();
})();
