/* ThreadKeep 3 — save Reddit threads with their full comments for offline reading.
 *
 * Source: Arctic Shift (a free public Reddit archive, arctic-shift.photon-reddit.com). No Reddit key,
 * no login, no Shortcut — the app fetches directly. It ranks a subreddit's threads by number of comments
 * ("best discussions") and pulls the whole comment tree. Threads are a couple of weeks old or more,
 * because the archive needs time to collect a thread's comments.
 * Everything is stored on the device: thread text in IndexedDB, images in the Cache API.
 */
'use strict';

const APP_VERSION = '3.0';
const MEDIA_CACHE = 'tk-media-v1';
const API = 'https://arctic-shift.photon-reddit.com/api';
const MB = 1024 * 1024;

/* ================= Settings ================= */

const DEFAULTS = {
  subs: [],                 // preferred subreddits, e.g. ['AskReddit']
  postsPerSub: 5,           // how many threads to grab per subreddit each check
  commentsPerThread: 100,   // size lever: max comments saved per thread
  autoCheck: 'open',        // 'off' | 'open' (on launch) | 'daily'
  limitMB: 500,             // storage budget
  whenFull: 'evict',        // 'evict' = remove oldest (not kept), 'stop' = stop downloading
  showNsfw: true,           // home switch: show NSFW in the library
  autoNsfw: false,          // include NSFW threads in auto-download
  blurNsfw: true,           // blur NSFW images until tapped
  fontSize: 17,
};
const store = {
  get(k, f) { try { const v = localStorage.getItem(k); return v == null ? f : JSON.parse(v); } catch { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const settings = (() => {
  const saved = store.get('tk-settings', {}) || {};
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (k === 'subs') { if (Array.isArray(saved.subs)) s.subs = saved.subs.slice(); }
    else if (typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
  }
  if (saved.nsfw === 'hide') s.showNsfw = false;
  return s;
})();
function saveSettings() { store.set('tk-settings', settings); applyFontSize(); }
function applyFontSize() { document.documentElement.style.setProperty('--reader-size', settings.fontSize + 'px'); }
applyFontSize();

const seen = {
  has: (id) => (store.get('tk-seen', []) || []).includes(id),
  add(ids) { const s = new Set(store.get('tk-seen', []) || []); ids.forEach(i => s.add(i)); store.set('tk-seen', [...s].slice(-4000)); },
};

/* ================= Storage (IndexedDB) ================= */

const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('threadkeep', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('posts', { keyPath: 'id' }); req.result.createObjectStore('threads', { keyPath: 'id' }); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(name, mode, fn) {
  const database = await dbReady;
  return new Promise((resolve, reject) => {
    const t = database.transaction(name, mode); let result;
    const r = fn(t.objectStore(name)); if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || new Error('Storage write failed'));
  });
}
const db = {
  get: (s, id) => tx(s, 'readonly', o => o.get(id)),
  all: (s) => tx(s, 'readonly', o => o.getAll()),
  put: (s, v) => tx(s, 'readwrite', o => o.put(v)),
  del: (s, id) => tx(s, 'readwrite', o => o.delete(id)),
};

/* ================= Helpers ================= */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unamp = (s) => String(s || '').replace(/&amp;/g, '&');
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cleanSub = (s) => { const m = String(s || '').trim().replace(/^.*reddit\.com\//i, '').replace(/^\/?r\//i, '').match(/^[A-Za-z0-9_]{2,21}/); return m ? m[0] : ''; };

function fmtBytes(b) { if (!b) return '0 MB'; if (b < MB) return Math.max(1, Math.round(b / 1024)) + ' KB'; if (b < 1024 * MB) return (b / MB).toFixed(b < 10 * MB ? 1 : 0) + ' MB'; return (b / 1024 / MB).toFixed(1) + ' GB'; }
function fmtAgo(sec) { const d = Date.now() / 1000 - sec; if (d < 3600) return Math.max(1, Math.floor(d / 60)) + 'm'; if (d < 86400) return Math.floor(d / 3600) + 'h'; if (d < 86400 * 30) return Math.floor(d / 86400) + 'd'; if (d < 86400 * 365) return Math.floor(d / 86400 / 30) + 'mo'; return Math.floor(d / 86400 / 365) + 'y'; }
function fmtNum(n) { n = n || 0; return n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
const textBytes = (o) => new Blob([JSON.stringify(o)]).size;

let toastTimer;
function toast(msg, ms = 3000) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms); }
function progress(text, frac) { const el = $('#progress'); if (text == null) { el.hidden = true; return; } el.hidden = false; $('#progressText').textContent = text; $('#progressFill').style.width = Math.round((frac || 0) * 100) + '%'; }

/* ================= Markdown → HTML (Reddit comments are markdown) ================= */

function mdToHtml(md) {
  if (!md) return '';
  let s = esc(String(md).replace(/\r\n?/g, '\n'));
  const blocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => { blocks.push('<pre><code>' + c.replace(/^\n+|\n+$/g, '') + '</code></pre>'); return '\u0000' + (blocks.length - 1) + '\u0000'; });
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/(^|[\s(])((https?:\/\/)[^\s<]+[^\s<.,);!?])/g, '$1<a href="$2">$2</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // block-level, line by line
  const lines = s.split('\n'); const out = []; let list = null, quote = false;
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  const closeQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };
  for (let raw of lines) {
    const line = raw.trimEnd();
    if (/^\u0000\d+\u0000$/.test(line.trim())) { closeList(); closeQuote(); out.push(line.trim()); continue; }
    if (!line.trim()) { closeList(); closeQuote(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) { closeList(); closeQuote(); out.push('<h' + m[1].length + '>' + m[2] + '</h' + m[1].length + '>'); continue; }
    if (/^([-*_])\1{2,}$/.test(line.trim())) { closeList(); closeQuote(); out.push('<hr>'); continue; }
    if ((m = line.match(/^&gt;\s?(.*)/))) { closeList(); if (!quote) { out.push('<blockquote>'); quote = true; } out.push(m[1] + '<br>'); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) { closeQuote(); if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + m[1] + '</li>'); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { closeQuote(); if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + m[1] + '</li>'); continue; }
    closeList(); closeQuote(); out.push('<p>' + line + '</p>');
  }
  closeList(); closeQuote();
  let html = out.join('\n');
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  return html;
}

/* ================= Clean HTML (shared) ================= */

const ALLOWED = new Set(['A', 'P', 'BR', 'HR', 'B', 'STRONG', 'I', 'EM', 'DEL', 'S', 'SUP', 'SUB', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN', 'DIV', 'IMG']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'SVG', 'BUTTON', 'INPUT']);
const REDDIT_IMG = /^https:\/\/(preview|i)\.redd\.it\//;

function sanitize(html, images) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (DROP.has(el.tagName)) { el.remove(); continue; }
      if (!ALLOWED.has(el.tagName)) { walk(el); el.replaceWith(...el.childNodes); continue; }
      for (const a of [...el.attributes]) {
        const keep = (el.tagName === 'A' && a.name === 'href') || (el.tagName === 'IMG' && (a.name === 'src' || a.name === 'alt'));
        if (!keep) el.removeAttribute(a.name);
      }
      if (el.tagName === 'A') {
        let href = el.getAttribute('href') || '';
        if (href.startsWith('/')) href = 'https://www.reddit.com' + href;
        if (!/^https?:/i.test(href)) { el.removeAttribute('href'); walk(el); continue; }
        if (REDDIT_IMG.test(href) && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(href)) {
          const img = doc.createElement('img'); img.src = href; img.alt = el.textContent || 'image'; images.push(href); el.replaceWith(img); continue;
        }
        el.setAttribute('href', href); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer');
      }
      if (el.tagName === 'IMG') { const src = el.getAttribute('src') || ''; if (!/^https:/i.test(src)) { el.remove(); continue; } images.push(src); }
      walk(el);
    }
  };
  walk(doc.body);
  doc.querySelectorAll('img').forEach(i => i.setAttribute('loading', 'lazy'));
  return doc.body.innerHTML;
}

/* ================= Media (same shape as Reddit) ================= */

function phoneSizedPreview(preview) { const img = preview?.images?.[0]; if (!img) return null; const fits = (img.resolutions || []).filter(r => r.width <= 1080); return unamp((fits[fits.length - 1] || img.source)?.url) || null; }
function thumbOf(preview) { const res = preview?.images?.[0]?.resolutions || []; const r = res.find(x => x.width >= 140) || res[res.length - 1]; return r ? unamp(r.url) : phoneSizedPreview(preview); }
function mediaOf(p) {
  const out = [];
  if (p.is_gallery && p.gallery_data && p.media_metadata) {
    for (const item of p.gallery_data.items || []) { const m = p.media_metadata[item.media_id]; if (!m || m.status !== 'valid') continue; const fits = (m.p || []).filter(r => r.x <= 1080); const url = (fits[fits.length - 1] || m.s)?.u || m.s?.gif; if (url) out.push({ url: unamp(url), caption: item.caption || '' }); }
    return out;
  }
  const url = p.url_overridden_by_dest || p.url || '';
  const directImg = /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url);
  if (p.post_hint === 'image' || directImg) { const u = phoneSizedPreview(p.preview) || (directImg ? url : null); if (u) out.push({ url: u, caption: '' }); return out; }
  const pic = phoneSizedPreview(p.preview); if (pic) out.push({ url: pic, caption: p.is_video ? 'Video. Only the preview image is saved.' : '' });
  return out;
}

/* ================= Arctic Shift data layer ================= */

async function arctic(path, tries = 4) {
  for (let i = 0; i < tries; i++) {
    let j;
    try { j = await (await fetch(API + path)).json(); }
    catch { if (!navigator.onLine) throw new Error('You’re offline.'); j = {}; }
    if (j && j.error && /slow down|timeout/i.test(j.error)) { await sleep(1800); continue; }
    if (j && j.data != null) return j.data;
    if (i === tries - 1) throw new Error((j && j.error) || 'Couldn’t reach the Reddit archive. Try again.');
    await sleep(900);
  }
  throw new Error('Couldn’t reach the Reddit archive.');
}

// Mature window: threads old enough that the archive has their comments.
async function fetchSubPosts(sub, pages = 3) {
  const posts = []; let cursor = '14d'; // start just older than 14 days
  for (let pg = 0; pg < pages; pg++) {
    const q = new URLSearchParams({ subreddit: sub, limit: '100', sort: 'desc', after: '95d', before: cursor });
    const batch = await arctic('/posts/search?' + q);
    if (!batch.length) break;
    posts.push(...batch); cursor = String(batch[batch.length - 1].created_utc);
    if (batch.length < 100) break; await sleep(400);
  }
  return posts;
}
async function fetchComments(postId, cap) {
  const out = []; let after = '';
  while (out.length < cap) {
    const q = new URLSearchParams({ link_id: postId, limit: '100', sort: 'asc' }); if (after) q.set('after', after);
    let batch; try { batch = await arctic('/comments/search?' + q); } catch { break; }
    if (!batch.length) break;
    out.push(...batch); after = String(batch[batch.length - 1].created_utc);
    if (batch.length < 100) break; await sleep(500);
  }
  return out.slice(0, cap);
}
async function fetchPostById(id) {
  const d = await arctic('/posts/ids?ids=' + encodeURIComponent(id));
  return Array.isArray(d) ? d[0] : d;
}

function parseLink(text) {
  text = String(text || '').trim();
  let m = text.match(/comments\/([a-z0-9]+)/i) || text.match(/redd\.it\/([a-z0-9]+)/i);
  if (m) return { type: 'post', id: m[1].toLowerCase() };
  const r = text.match(/(?:reddit\.com\/)?r\/([A-Za-z0-9_]{2,21})/i); if (r) return { type: 'sub', name: r[1] };
  if (/^[A-Za-z0-9_]{2,21}$/.test(text)) return { type: 'sub', name: text };
  return null;
}

/* ================= Turn archive data into a saved thread ================= */

function buildCommentTree(flat, images) {
  const byId = new Map();
  for (const c of flat) byId.set(c.id, { a: c.author || '[deleted]', op: !!c.is_submitter, s: c.score || 0, t: c.created_utc || Date.now() / 1000, h: sanitize(mdToHtml(c.body), images), f: c.author_flair_text || '', st: !!c.stickied, e: !!c.edited, r: [], m: 0, _pid: String(c.parent_id || '') });
  const roots = [];
  for (const node of byId.values()) { const pid = node._pid; delete node._pid; if (pid.startsWith('t1_') && byId.has(pid.slice(3))) byId.get(pid.slice(3)).r.push(node); else roots.push(node); }
  const sortRec = (nodes) => { nodes.sort((a, b) => (b.st - a.st) || (b.s - a.s)); nodes.forEach(n => sortRec(n.r)); };
  sortRec(roots);
  return roots;
}
const countComments = (list) => list.reduce((n, c) => n + 1 + countComments(c.r), 0);

// Downloads a thread from the archive and saves it. Returns the post id, or null if there were no comments yet.
async function saveThreadById(id, { fromSub = false, post = null } = {}) {
  const p = post || await fetchPostById(id);
  if (!p || !p.id) throw new Error('That thread isn’t in the archive.');
  const flat = await fetchComments(p.id, settings.commentsPerThread);
  const images = [];
  const media = mediaOf(p);
  const postObj = {
    id: p.id, title: p.title || 'Untitled', subreddit: p.subreddit || '', author: p.author || '[deleted]', score: p.score || 0,
    created: p.created_utc || Date.now() / 1000, numComments: p.num_comments || flat.length, flair: p.link_flair_text || '',
    nsfw: !!p.over_18, html: sanitize(mdToHtml(p.selftext), images),
    url: (p.is_self ? '' : (p.url_overridden_by_dest || p.url || '')),
    permalink: 'https://www.reddit.com' + (p.permalink || '/comments/' + p.id),
    media,
  };
  const comments = buildCommentTree(flat, images);
  const saved = countComments(comments);
  const more = Math.max(0, (p.num_comments || 0) - saved);
  const thread = { id: p.id, post: postObj, comments, more, fetchedAt: Date.now() };
  const tBytes = textBytes(thread);

  const existing = await db.get('posts', p.id);
  if (existing) await removeImages(existing.media, p.id);
  if (!(await makeRoom(tBytes, p.id))) throw new Error('Storage is full (' + fmtBytes(limitBytes()) + '). Delete some threads or raise the limit in Settings.');
  await db.put('threads', thread);

  const thumb = thumbOf(p.preview) || media[0]?.url || null;
  const row = { id: p.id, title: postObj.title, subreddit: postObj.subreddit, nsfw: postObj.nsfw, savedComments: saved, numComments: postObj.numComments,
    savedAt: existing?.savedAt || Date.now(), pinned: !!existing?.pinned, fromSub: existing ? !!existing.fromSub : fromSub, thumb, media: [], bytes: tBytes, textOnly: false, complete: false };
  await db.put('posts', row);
  for (const url of [...new Set([...(thumb ? [thumb] : []), ...media.map(m => m.url), ...images])]) {
    if (!(await makeRoom(256 * 1024, p.id))) { row.textOnly = true; break; }
    const before = await usage(); let size; try { size = await cacheImage(url); } catch { continue; }
    if (size === -1) size = Math.max(50 * 1024, (await usage()) - before);
    row.media.push(url); row.bytes += size;
  }
  row.complete = true; await db.put('posts', row);
  return p.id;
}

/* ================= Images & storage budget ================= */

async function cacheImage(url) {
  const cache = await caches.open(MEDIA_CACHE);
  if (await cache.match(url)) return 0;
  try { const res = await fetch(url, { mode: 'cors', credentials: 'omit' }); if (!res.ok) throw 0; const size = (await res.clone().blob()).size; await cache.put(url, res); return size; }
  catch { const res = await fetch(url, { mode: 'no-cors', credentials: 'omit' }); await cache.put(url, res); return -1; }
}
async function usage() { try { return (await navigator.storage.estimate()).usage || 0; } catch { return 0; } }
async function removeImages(urls, exceptId) {
  if (!urls?.length) return; const used = new Set();
  for (const p of await db.all('posts')) if (p.id !== exceptId) (p.media || []).forEach(u => used.add(u));
  const cache = await caches.open(MEDIA_CACHE); await Promise.all(urls.filter(u => !used.has(u)).map(u => cache.delete(u)));
}
const limitBytes = () => settings.limitMB * MB;
async function usedBytes(exceptId) { return (await db.all('posts')).filter(p => p.id !== exceptId).reduce((n, p) => n + (p.bytes || 0), 0); }
async function makeRoom(need, protectId) {
  let used = await usedBytes(protectId);
  if (used + need <= limitBytes()) return true;
  if (settings.whenFull !== 'evict') return false;
  const oldest = (await db.all('posts')).filter(p => p.id !== protectId && !p.pinned).sort((a, b) => (b.fromSub - a.fromSub) || (a.savedAt - b.savedAt));
  for (const p of oldest) { await deletePost(p.id); used -= p.bytes || 0; if (used + need <= limitBytes()) return true; }
  return used + need <= limitBytes();
}
async function deletePost(id) { const row = await db.get('posts', id); await db.del('threads', id); await db.del('posts', id); if (row) await removeImages(row.media, id); }

/* ================= Auto-download ================= */

let syncing = false;
const lastSync = () => store.get('tk-lastsync', 0);

async function checkSubs(force) {
  if (syncing || !navigator.onLine || !settings.subs.length) return;
  if (!force) { if (settings.autoCheck === 'off') return; if (settings.autoCheck === 'daily' && Date.now() - lastSync() < 86400000) return; }
  syncing = true;
  let total = 0, failed = '';
  try {
    for (const sub of settings.subs) {
      let posts;
      try { progress('Checking r/' + sub + '…', 0.03); posts = await fetchSubPosts(sub, 3); }
      catch (e) { failed = 'r/' + sub + ': ' + e.message; continue; }
      const existing = new Set((await db.all('posts')).map(p => p.id));
      posts = posts.filter(p => p && !p.stickied && (p.num_comments || 0) > 3 && !seen.has(p.id) && !existing.has(p.id) && (settings.autoNsfw || !p.over_18));
      posts.sort((a, b) => (b.num_comments || 0) - (a.num_comments || 0));
      const pick = posts.slice(0, settings.postsPerSub);
      for (let i = 0; i < pick.length; i++) {
        progress('r/' + sub + ': saving ' + (i + 1) + ' of ' + pick.length + '…', (i + 1) / (pick.length + 1));
        try { const id = await saveThreadById(pick[i].id, { fromSub: true, post: pick[i] }); if (id) total++; }
        catch (e) { if (/Storage is full/.test(e.message)) { failed = e.message; break; } }
        seen.add([pick[i].id]);
      }
      seen.add(pick.map(p => p.id));
      if (/Storage is full/.test(failed)) break;
    }
    store.set('tk-lastsync', Date.now());
  } finally { syncing = false; progress(null); }
  if (total) toast('Saved ' + plural(total, 'new thread') + ' from your subreddits.', 4000);
  else if (failed) toast(failed, 6000);
  else if (force) toast('No new threads right now. Try again later, or add more subreddits.', 5000);
  render();
}

async function savePostFromLink(input) {
  const p = parseLink(input);
  if (!p) { toast('Paste a reddit.com thread link, or a subreddit name.'); return; }
  if (p.type === 'sub') { toast('That’s a subreddit — add r/' + p.name + ' in Settings to auto-download from it.', 5000); return; }
  if (!navigator.onLine) { toast('You’re offline.'); return; }
  const existing = await db.get('posts', p.id);
  if (existing && existing.complete) { location.hash = '#/p/' + p.id; return; }
  progress('Downloading thread…', 0.3);
  try { const id = await saveThreadById(p.id); progress(null); location.hash = '#/p/' + id; route(); }
  catch (e) { progress(null); toast(e.message, 6000); }
}

/* ================= Views ================= */

const view = $('#view');
let filterSub = '', search = '';
const ICONS = {
  pin: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z" fill="currentColor"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 11a8 8 0 1 0-.9 4.5M20 5v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

function installCardHtml() {
  let hidden = false; try { hidden = sessionStorage.getItem('tk-install-hidden') === '1'; } catch {}
  if (!isIOS() || isStandalone() || hidden) return '';
  return `<section class="card notice"><div class="card-head"><h2>Install it on your iPhone</h2><button class="x" id="installClose" aria-label="Hide">×</button></div>
    <ol class="steps"><li>In Safari, tap the Share button → <b>Add to Home Screen</b>.</li><li>Open ThreadKeep from the new icon. Your saved threads live there.</li></ol></section>`;
}

async function renderHome() {
  setHeader('ThreadKeep', false);
  const posts = (await db.all('posts')).sort((a, b) => b.savedAt - a.savedAt);
  const used = posts.reduce((n, p) => n + (p.bytes || 0), 0);
  const pct = Math.min(100, used / limitBytes() * 100);
  const nsfwCount = posts.filter(p => p.nsfw).length;
  const visible = settings.showNsfw ? posts : posts.filter(p => !p.nsfw);
  const subCounts = {}; for (const p of visible) if (p.subreddit) subCounts[p.subreddit] = (subCounts[p.subreddit] || 0) + 1;
  const subs = Object.keys(subCounts).sort((a, b) => subCounts[b] - subCounts[a]);
  if (filterSub && !subCounts[filterSub]) filterSub = '';
  const q = search.toLowerCase();
  const shown = visible.filter(p => (!filterSub || p.subreddit === filterSub) && (!q || (p.title + ' ' + p.subreddit).toLowerCase().includes(q)));
  const ls = lastSync();

  view.innerHTML = `
    ${installCardHtml()}
    ${settings.subs.length ? `<section class="sync">
        <div><div class="sync-subs">${settings.subs.map(s => 'r/' + esc(s)).join('  ')}</div>
          <div class="muted small">${ls ? 'Checked ' + fmtAgo(ls / 1000) + ' ago' : 'Not checked yet'} · top ${settings.postsPerSub} by discussion</div></div>
        <button class="btn small" id="checkBtn">${ICONS.refresh} Check now</button>
      </section>`
      : `<section class="card setup"><h2>Pick your subreddits</h2>
          <p class="muted">ThreadKeep auto-saves the most-discussed threads (with all comments) from subreddits you choose, to read offline. Free, no Reddit account.</p>
          <a class="btn primary block" href="#/settings">Choose subreddits →</a></section>`}

    <form class="linkrow" id="linkForm">
      <input id="linkInput" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Or paste a reddit.com thread link">
      <button class="btn" type="submit">Save</button>
    </form>

    ${posts.length ? `
      <div class="toolbar">
        <div class="gauge"><div class="gauge-bar"><div class="gauge-fill ${pct >= 95 ? 'full' : ''}" style="width:${pct}%"></div></div><span>${fmtBytes(used)} of ${fmtBytes(limitBytes())}</span></div>
        <label class="switch"><span>NSFW${nsfwCount && !settings.showNsfw ? ` <small>(${nsfwCount} hidden)</small>` : ''}</span><input type="checkbox" role="switch" class="toggle" id="nsfwToggle" ${settings.showNsfw ? 'checked' : ''}></label>
      </div>
      ${subs.length > 1 ? `<div class="chips" id="chips"><button data-sub="" aria-pressed="${!filterSub}">All <small>${visible.length}</small></button>${subs.map(s => `<button data-sub="${esc(s)}" aria-pressed="${filterSub === s}">r/${esc(s)} <small>${subCounts[s]}</small></button>`).join('')}</div>` : ''}
      ${visible.length > 6 ? `<input type="search" id="search" class="search" placeholder="Search saved threads" value="${esc(search)}">` : ''}
      <div class="list">${shown.map(itemHtml).join('') || '<p class="empty muted">Nothing matches.</p>'}</div>`
      : `<p class="empty muted">No saved threads yet.${settings.subs.length ? ' Tap <b>Check now</b> above.' : ''}</p>`}`;

  const cb = $('#checkBtn'); if (cb) cb.onclick = () => checkSubs(true);
  $('#linkForm').onsubmit = (e) => { e.preventDefault(); const v = $('#linkInput').value; $('#linkInput').value = ''; savePostFromLink(v); };
  const ic = $('#installClose'); if (ic) ic.onclick = () => { try { sessionStorage.setItem('tk-install-hidden', '1'); } catch {} renderHome(); };
  const nt = $('#nsfwToggle'); if (nt) nt.onchange = () => { settings.showNsfw = nt.checked; saveSettings(); renderHome(); };
  const ch = $('#chips'); if (ch) ch.onclick = (e) => { const b = e.target.closest('button'); if (b) { filterSub = b.dataset.sub; renderHome(); } };
  const se = $('#search'); if (se) se.oninput = () => { search = se.value; const pos = se.selectionStart; renderHome().then(() => { const n = $('#search'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }); };
}

function itemHtml(p) {
  const blur = p.nsfw && settings.blurNsfw;
  return `<a class="item" href="#/p/${esc(p.id)}">
    <div class="item-body">
      <div class="item-sub">r/${esc(p.subreddit)}${p.nsfw ? ' <span class="tag nsfw">NSFW</span>' : ''}${p.pinned ? ` <span class="tag kept">${ICONS.pin} Kept</span>` : ''}</div>
      <div class="item-title">${esc(p.title)}</div>
      <div class="item-meta">${plural(p.savedComments || 0, 'comment')} saved · ${fmtBytes(p.bytes)}${p.textOnly ? ' · text only' : ''}${p.complete === false ? ' · saving…' : ''}</div>
    </div>
    ${p.thumb ? `<img class="thumb ${blur ? 'blurred' : ''}" src="${esc(p.thumb)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
  </a>`;
}

function commentHtml(c, level) {
  return `<div class="c" style="--lvl:${level % 5}">
    <div class="c-head" data-toggle><span class="c-author ${c.op ? 'op' : ''}">${esc(c.a)}</span>${c.op ? '<span class="tag op">OP</span>' : ''}<span>${fmtNum(c.s)} pts · ${fmtAgo(c.t)}</span></div>
    <div class="c-body rich">${c.h}</div>
    ${c.r.length ? `<div class="c-replies">${c.r.map(r => commentHtml(r, level + 1)).join('')}</div>` : ''}</div>`;
}

async function renderPost(id) {
  const row = await db.get('posts', id); const thread = await db.get('threads', id);
  if (!row || !thread) { setHeader('', true); view.innerHTML = '<p class="empty muted">This thread isn’t saved anymore.</p>'; return; }
  const p = thread.post; setHeader('r/' + p.subreddit, true);
  const blur = p.nsfw && settings.blurNsfw;
  const outLink = p.url && !/^https:\/\/(i|v|preview)\.redd\.it\//.test(p.url) && !/\.(jpe?g|png|gif|webp)(\?|$)/i.test(p.url) && !p.url.includes('/comments/') && !p.url.includes('/gallery/');
  view.innerHTML = `
    <article class="post ${blur ? 'nsfw-blur' : ''}">
      <div class="post-meta">u/${esc(p.author)} · ${fmtAgo(p.created)} ago${p.flair ? ` · <span class="tag">${esc(p.flair)}</span>` : ''}${p.nsfw ? ' <span class="tag nsfw">NSFW</span>' : ''}</div>
      <h2>${esc(p.title)}</h2>
      ${p.media.map(m => `<figure><img src="${esc(m.url)}" alt="" loading="lazy" onerror="this.closest('figure').remove()">${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ''}</figure>`).join('')}
      ${p.html ? `<div class="rich">${p.html}</div>` : ''}
      ${outLink ? `<a class="link-out" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a>` : ''}
      <div class="post-stats">${fmtNum(p.numComments)} comments on Reddit · saved ${new Date(thread.fetchedAt).toLocaleDateString()}</div>
      <div class="actions">
        <button class="btn small ${row.pinned ? 'on' : ''}" id="pinBtn">${ICONS.pin} ${row.pinned ? 'Kept' : 'Keep'}</button>
        <a class="btn small" href="${esc(p.permalink)}" target="_blank" rel="noopener noreferrer">Open on Reddit</a>
        <button class="btn small danger" id="delBtn">Delete</button>
      </div>
    </article>
    <div class="comments-head"><h3>${plural(countComments(thread.comments), 'comment')}</h3><span class="muted small">Tap a name to collapse</span></div>
    <div class="comments ${blur ? 'nsfw-blur' : ''}">${thread.comments.map(c => commentHtml(c, 0)).join('') || '<p class="muted">No comments were saved for this thread yet.</p>'}
      ${thread.more ? `<p class="c-more">${fmtNum(thread.more)} more comments on Reddit</p>` : ''}</div>`;
  view.onclick = (e) => {
    const im = e.target.closest('.nsfw-blur img:not(.revealed)'); if (im) { e.preventDefault(); im.classList.add('revealed'); return; }
    const head = e.target.closest('[data-toggle]'); if (head && !e.target.closest('a')) head.parentElement.classList.toggle('collapsed');
  };
  $('#pinBtn').onclick = async () => { row.pinned = !row.pinned; await db.put('posts', row); toast(row.pinned ? 'Kept: won’t be auto-removed.' : 'No longer kept.'); renderPost(id); };
  $('#delBtn').onclick = async () => { if (confirm('Delete this thread from your phone?')) { await deletePost(id); location.hash = '#/'; } };
}

function seg(name, options, current) { return `<div class="seg" data-setting="${name}">${options.map(([v, label]) => `<button type="button" data-value="${esc(v)}" aria-pressed="${String(v) === String(current)}">${label}</button>`).join('')}</div>`; }

async function renderSettings() {
  setHeader('Settings', true);
  const used = await usedBytes(); let persisted = false; try { persisted = await navigator.storage.persisted(); } catch {}
  view.innerHTML = `
    <section class="group"><h3>Subreddits to auto-save</h3>
      <div class="field">
        <div class="sub-list">${settings.subs.map(s => `<span class="sub-tag">r/${esc(s)}<button type="button" data-remove="${esc(s)}" aria-label="Remove">×</button></span>`).join('') || '<span class="muted small">None yet.</span>'}</div>
        <form class="linkrow" id="subForm" style="margin-top:10px"><input id="subInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Add a subreddit, e.g. AskReddit"><button class="btn" type="submit">Add</button></form>
      </div>
      <div class="field"><label>Threads per subreddit, each check</label>${seg('postsPerSub', [[3, '3'], [5, '5'], [10, '10'], [25, '25']], settings.postsPerSub)}
        <p class="muted small">The most-commented recent threads are saved first.</p></div>
      <div class="field"><label>Check for new threads</label>${seg('autoCheck', [['open', 'On open'], ['daily', 'Daily'], ['off', 'Manually']], settings.autoCheck)}
        <p class="muted small">Threads are usually a couple of weeks old, so the archive has all their comments.</p></div>
    </section>

    <section class="group"><h3>Download size</h3>
      <div class="field"><label>Comments saved per thread</label>${seg('commentsPerThread', [[50, '50'], [100, '100'], [200, '200'], [500, '500']], settings.commentsPerThread)}</div>
      <div class="field"><label>Total storage</label>${seg('limitMB', [[250, '250 MB'], [500, '500 MB'], [1000, '1 GB'], [2000, '2 GB']], settings.limitMB)}
        <p class="muted small">Using ${fmtBytes(used)}.${persisted ? '' : ' Open from your Home Screen so iPhone keeps your threads.'}</p></div>
      <div class="field"><label>When storage is full</label>${seg('whenFull', [['evict', 'Remove oldest'], ['stop', 'Stop saving']], settings.whenFull)}
        <p class="muted small">Auto-saved threads go first; ones you <b>Keep</b> are never removed.</p></div>
    </section>

    <section class="group"><h3>NSFW</h3>
      <div class="field row-field"><label for="showNsfw">Show NSFW in my library</label><input type="checkbox" role="switch" class="toggle" id="showNsfw" ${settings.showNsfw ? 'checked' : ''}></div>
      <div class="field row-field"><label for="autoNsfw">Auto-download NSFW threads</label><input type="checkbox" role="switch" class="toggle" id="autoNsfw" ${settings.autoNsfw ? 'checked' : ''}></div>
      <div class="field row-field"><label for="blurNsfw">Blur NSFW images until tapped</label><input type="checkbox" role="switch" class="toggle" id="blurNsfw" ${settings.blurNsfw ? 'checked' : ''}></div>
    </section>

    <section class="group"><h3>Reading</h3>
      <div class="field"><label>Text size</label>${seg('fontSize', [[15, 'Small'], [17, 'Medium'], [19, 'Large'], [21, 'Larger']], settings.fontSize)}</div>
    </section>

    <section class="group"><h3>Delete</h3><div class="field"><button class="btn danger block" id="wipe">Delete all saved threads</button></div></section>
    <p class="muted small center">ThreadKeep ${APP_VERSION} · Threads come from the free Arctic Shift Reddit archive. Everything stays on this phone.</p>`;

  view.querySelectorAll('.seg').forEach(s => s.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; const key = s.dataset.setting;
    settings[key] = typeof DEFAULTS[key] === 'number' ? Number(b.dataset.value) : b.dataset.value; saveSettings();
    s.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    if (key === 'limitMB') makeRoom(0);
  }));
  $('#subForm').onsubmit = (e) => { e.preventDefault(); const name = cleanSub($('#subInput').value); if (!name) { toast('Type a subreddit name, e.g. AskReddit.'); return; } if (settings.subs.some(s => s.toLowerCase() === name.toLowerCase())) { toast('Already added.'); return; } settings.subs.push(name); saveSettings(); renderSettings(); checkSubs(true); };
  $('.sub-list').onclick = (e) => { const b = e.target.closest('[data-remove]'); if (!b) return; settings.subs = settings.subs.filter(s => s !== b.dataset.remove); saveSettings(); renderSettings(); };
  $('#showNsfw').onchange = (e) => { settings.showNsfw = e.target.checked; saveSettings(); };
  $('#autoNsfw').onchange = (e) => { settings.autoNsfw = e.target.checked; saveSettings(); };
  $('#blurNsfw').onchange = (e) => { settings.blurNsfw = e.target.checked; saveSettings(); };
  $('#wipe').onclick = async () => { if (!confirm('Delete every saved thread and image from this phone?')) return; for (const p of await db.all('posts')) await deletePost(p.id); await caches.delete(MEDIA_CACHE); store.set('tk-seen', []); toast('Everything deleted.'); renderSettings(); };
}

/* ================= Shell, routing, startup ================= */

function setHeader(title, back) { $('#title').textContent = title; $('#backBtn').hidden = !back; $('#settingsBtn').hidden = location.hash === '#/settings'; }
let renderTimer;
function render() { clearTimeout(renderTimer); renderTimer = setTimeout(route, 20); }
function route() { view.onclick = null; const h = location.hash; if (h.startsWith('#/p/')) return renderPost(decodeURIComponent(h.slice(4))); if (h === '#/settings') return renderSettings(); return renderHome(); }
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
$('#backBtn').onclick = () => { location.hash = '#/'; };
$('#settingsBtn').onclick = () => { location.hash = '#/settings'; };

async function checkForUpdate() {
  if (!navigator.onLine) return;
  try {
    const { version } = await (await fetch('version.json?t=' + Date.now(), { cache: 'no-store' })).json();
    if (!version || version === APP_VERSION) return;
    let tried = ''; try { tried = sessionStorage.getItem('tk-reloaded-for') || ''; } catch {}
    if (tried === version) return; try { sessionStorage.setItem('tk-reloaded-for', version); } catch {}
    const reg = await navigator.serviceWorker?.getRegistration(); if (reg) await reg.update().catch(() => {});
    location.reload();
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkForUpdate(); checkSubs(false); } });
window.addEventListener('online', () => checkSubs(false));

(async function start() {
  checkForUpdate();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
  // clean v1/v2 leftovers
  for (const p of await db.all('posts')) { if (!(await db.get('threads', p.id))) { await db.del('posts', p.id); continue; } if (p.complete === undefined) { p.complete = true; delete p.status; delete p.error; await db.put('posts', p); } }
  for (const k of ['tk-token', 'tk-apptoken', 'tk-device', 'tk-syncerr', 'tk-grab', 'tk-setup-done', 'tk-nsfw-on']) { try { localStorage.removeItem(k); } catch {} }
  route();
  checkSubs(false);
})();
