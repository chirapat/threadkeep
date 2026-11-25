const PICK = { what: "￼", range: "￼", comments: "￼" };
// ↑ The Shortcut fills these in from its three menus (What to save? / From when? / Comments per thread).
//   If you paste this script into a Shortcut by hand, you can type values instead, e.g.
//   { what: "Top 10 posts", range: "This week", comments: "100 comments" }.
//
// "Save to ThreadKeep" — runs inside the Reddit page open in Safari (Shortcuts → Run JavaScript on Web Page),
// using your signed-in Reddit session. Shortcuts gives it only a few seconds, so it works against a deadline
// and remembers what it already sent: running it again continues where it stopped.
(() => {
  const DEADLINE_MS = 2500;
  let done = false;
  const send = (o) => { if (done) return; done = true; completion('THREADKEEP:' + JSON.stringify(o)); };

  // Read the menu choices (with safe defaults if a value is missing).
  const filled = (v) => typeof v === 'string' && v.length > 0 && v !== '￼';
  const whatText = filled(PICK.what) ? PICK.what : 'This post only';
  const onlyThisPost = /this post/i.test(whatText);
  const topCount = Math.min(50, Math.max(1, parseInt(whatText.replace(/\D+/g, ''), 10) || 10));
  const rangeText = filled(PICK.range) ? PICK.range.toLowerCase() : 'today';
  const t = /week/.test(rangeText) ? 'week' : /month/.test(rangeText) ? 'month' : /year/.test(rangeText) ? 'year' : /all/.test(rangeText) ? 'all' : 'day';
  const rangeLabel = { day: 'today', week: 'this week', month: 'this month', year: 'this year', all: 'of all time' }[t];
  const commentCount = Math.min(500, Math.max(5, parseInt(String(filled(PICK.comments) ? PICK.comments : '').replace(/\D+/g, ''), 10) || 50));
  const depth = commentCount <= 25 ? 3 : commentCount <= 100 ? 5 : 8;

  try {
    if (!/(^|\.)reddit\.com$/.test(location.hostname)) {
      return send({ error: 'Open a Reddit post or subreddit in Safari first.' });
    }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const get = async (url) => {
      const r = await fetch(url, { credentials: 'include', signal: ctrl && ctrl.signal });
      if (!r.ok) throw new Error('Reddit said ' + r.status + (r.status === 403 ? '. Make sure you are signed in to Reddit in Safari.' : '.'));
      return r.json();
    };
    const post = location.pathname.match(/\/comments\/([a-z0-9]+)/i);
    const sub = location.pathname.match(/^\/r\/([A-Za-z0-9_]+)/);

    if (onlyThisPost) {
      if (!post) return send({ error: 'You chose “This post only”, but no post is open. Open a post, or choose Top posts.' });
      setTimeout(() => {
        if (done) return;
        if (ctrl) ctrl.abort();
        const th = scrapePage();
        send(th ? { tk: 1, source: 'post', from: 'page', threads: [th] } : { error: 'Reddit was too slow. Scroll down to load comments, then run the Shortcut again.' });
      }, DEADLINE_MS);
      get('/comments/' + post[1] + '.json?limit=' + commentCount + '&depth=' + depth + '&sort=top&raw_json=1')
        .then(th => send({ tk: 1, source: 'post', threads: [th] }))
        .catch(err => {
          if (done) return;
          const th = scrapePage();
          send(th ? { tk: 1, source: 'post', from: 'page', threads: [th] } : { error: String((err && err.message) || err) });
        });
      return;
    }

    if (!sub) return send({ error: 'Open a subreddit (like r/AskReddit) or one of its posts, then run the Shortcut.' });

    // Top N of the subreddit. Posts already sent for these same choices are skipped, so a second run fetches the rest.
    const key = ['threadkeep-sent', sub[1].toLowerCase(), t, topCount, commentCount, new Date().toISOString().slice(0, 10)].join('-');
    let sent = [];
    try { sent = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) {}
    const threads = [], gotIds = [];
    let wanted = 0;
    const finish = () => {
      if (done) return;
      if (ctrl) ctrl.abort();
      try { localStorage.setItem(key, JSON.stringify(sent.concat(gotIds))); } catch (e) {}
      if (!threads.length && !wanted) return send({ error: 'Reddit was too slow. Try again in a moment.' });
      send({ tk: 1, source: 'subreddit', sub: sub[1], range: rangeLabel, threads, wanted, have: Math.min(wanted, sent.length + gotIds.length) });
    };
    setTimeout(finish, DEADLINE_MS);
    get('/r/' + sub[1] + '/top.json?t=' + t + '&limit=' + Math.min(100, topCount + 5) + '&raw_json=1')
      .then(list => {
        const ids = list.data.children.map(c => c.data).filter(d => !d.stickied).slice(0, topCount).map(d => d.id);
        wanted = ids.length;
        sent = sent.filter(id => ids.includes(id));
        let todo = ids.filter(id => !sent.includes(id));
        if (!todo.length) { sent = []; todo = ids; } // already had them all: start over (refreshes comments)
        return Promise.all(todo.map(id =>
          get('/comments/' + id + '.json?limit=' + commentCount + '&depth=' + depth + '&sort=top&raw_json=1')
            .then(th => { if (!done) { threads.push(th); gotIds.push(id); } })
            .catch(() => {})
        ));
      })
      .then(finish)
      .catch(err => send({ error: String((err && err.message) || err) }));
  } catch (e) {
    send({ error: String((e && e.message) || e) });
  }

  // Builds Reddit-style thread data from the post and comments already on the page (used when Reddit is slow).
  function scrapePage() {
    const sp = document.querySelector('shreddit-post');
    if (!sp) return null;
    const attr = (el, ...names) => { for (const n of names) { const v = el.getAttribute(n); if (v != null) return v; } return ''; };
    const num = (v) => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
    const ts = (el) => {
      const tm = el.querySelector('faceplate-timeago[ts], time[datetime]');
      const iso = attr(el, 'created-timestamp') || (tm && (tm.getAttribute('ts') || tm.getAttribute('datetime')));
      const ms = Date.parse(iso || '');
      return isNaN(ms) ? Date.now() / 1000 : ms / 1000;
    };
    const id = (attr(sp, 'id', 'thingid') || '').replace(/^t3_/, '') || (location.pathname.match(/\/comments\/([a-z0-9]+)/i) || [])[1];
    const body = sp.querySelector('[slot="text-body"]');
    const href = attr(sp, 'content-href');
    const images = [...sp.querySelectorAll('img')].map(i => i.currentSrc || i.src).filter(u => /^https:\/\/(i|preview)\.redd\.it\//.test(u));
    const p = {
      id, title: attr(sp, 'post-title') || document.title,
      subreddit: (attr(sp, 'subreddit-prefixed-name') || '').replace(/^r\//, '') || (location.pathname.match(/^\/r\/([^/]+)/) || [])[1] || '',
      author: attr(sp, 'author'), score: num(attr(sp, 'score')), num_comments: num(attr(sp, 'comment-count')),
      created_utc: ts(sp), selftext_html: body ? body.innerHTML : '',
      is_self: !href || /\/comments\//.test(href), url: href, post_hint: attr(sp, 'post-type') === 'image' ? 'image' : '',
      permalink: attr(sp, 'permalink') || location.pathname,
      over_18: sp.hasAttribute('nsfw') || sp.hasAttribute('is-nsfw') || attr(sp, 'nsfw') === 'true',
      preview: images.length ? { images: [{ source: { url: images[0], width: 1080 }, resolutions: [] }] } : undefined,
    };
    const toNode = (c) => {
      const text = c.querySelector(':scope > [slot="comment"]') || c.querySelector('[slot="comment"]');
      const kids = [...c.querySelectorAll(':scope > shreddit-comment, :scope > * > shreddit-comment')];
      return { kind: 't1', data: {
        author: attr(c, 'author') || '[deleted]', score: num(attr(c, 'score')), created_utc: ts(c),
        body_html: text ? text.innerHTML : '', is_submitter: attr(c, 'author') === p.author,
        replies: kids.length ? { data: { children: kids.map(toNode) } } : '',
      } };
    };
    const tree = document.querySelector('shreddit-comment-tree');
    const top = (tree ? [...tree.querySelectorAll(':scope > shreddit-comment')] : [...document.querySelectorAll('shreddit-comment[depth="0"]')]).slice(0, commentCount);
    return [{ data: { children: [{ kind: 't3', data: p }] } }, { data: { children: top.map(toNode) } }];
  }
})();
