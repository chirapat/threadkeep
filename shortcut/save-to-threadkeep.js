// "Save to ThreadKeep" — runs inside the Reddit page open in Safari (via Shortcuts → Run JavaScript on Web Page).
// Shortcuts only gives this script a few seconds, so it works against a deadline:
//   1. Try Reddit's thread data using your signed-in session (fast, complete).
//   2. If that's too slow or fails, read the post and comments already shown on the page (instant).
// The result is handed back to the Shortcut, which copies it to the clipboard for ThreadKeep to import.
(() => {
  const DEADLINE_MS = 2500;
  let done = false;
  const send = (o) => { if (done) return; done = true; completion('THREADKEEP:' + JSON.stringify(o)); };

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
    const sub = location.pathname.match(/^\/r\/([A-Za-z0-9_]+)\/?$/) || location.pathname.match(/^\/r\/([A-Za-z0-9_]+)\/(hot|top|new|rising)/);

    if (post) {
      // Deadline: fall back to what's on the page.
      setTimeout(() => {
        if (done) return;
        if (ctrl) ctrl.abort();
        const t = scrapePage();
        send(t ? { tk: 1, source: 'post', from: 'page', threads: [t] } : { error: 'Reddit was too slow. Scroll down to load the comments, then run the Shortcut again.' });
      }, DEADLINE_MS);
      get('/comments/' + post[1] + '.json?limit=100&depth=6&sort=top&raw_json=1')
        .then(thread => send({ tk: 1, source: 'post', threads: [thread] }))
        .catch(err => {
          if (done) return;
          const t = scrapePage();
          send(t ? { tk: 1, source: 'post', from: 'page', threads: [t] } : { error: String((err && err.message) || err) });
        });
      return;
    }

    if (sub) {
      // Today's top 10. Whatever doesn't finish in time is fetched on the next run:
      // posts already sent today are remembered (on this reddit.com page's storage) and skipped.
      const COUNT = 10;
      const key = 'threadkeep-sent-' + sub[1].toLowerCase() + '-' + new Date().toISOString().slice(0, 10);
      let sent = [];
      try { sent = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) {}
      const threads = [], gotIds = [];
      let wanted = 0;
      const finish = () => {
        if (ctrl) ctrl.abort();
        try { localStorage.setItem(key, JSON.stringify(sent.concat(gotIds))); } catch (e) {}
        if (!threads.length && !wanted) return send({ error: 'Reddit was too slow. Try again in a moment.' });
        send({ tk: 1, source: 'subreddit', sub: sub[1], threads, wanted, have: Math.min(wanted, sent.length + gotIds.length) });
      };
      setTimeout(finish, DEADLINE_MS);
      get('/r/' + sub[1] + '/top.json?t=day&limit=' + (COUNT + 4) + '&raw_json=1')
        .then(list => {
          const ids = list.data.children.map(c => c.data).filter(d => !d.stickied).slice(0, COUNT).map(d => d.id);
          wanted = ids.length;
          sent = sent.filter(id => ids.includes(id));
          let todo = ids.filter(id => !sent.includes(id));
          if (!todo.length) { sent = []; todo = ids; } // already had them all: start over (e.g. to refresh comments)
          return Promise.all(todo.map(id =>
            get('/comments/' + id + '.json?limit=50&depth=4&sort=top&raw_json=1')
              .then(t => { if (!done) { threads.push(t); gotIds.push(id); } })
              .catch(() => {})
          ));
        })
        .then(finish)
        .catch(err => send({ error: String((err && err.message) || err) }));
      return;
    }

    send({ error: 'Open a Reddit post or a subreddit page (like r/AskReddit), then run the Shortcut.' });
  } catch (e) {
    send({ error: String((e && e.message) || e) });
  }

  // Builds Reddit-style thread data from the post and comments already on the page.
  function scrapePage() {
    const sp = document.querySelector('shreddit-post');
    if (!sp) return null;
    const attr = (el, ...names) => { for (const n of names) { const v = el.getAttribute(n); if (v != null) return v; } return ''; };
    const num = (v) => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
    const ts = (el) => {
      const t = el.querySelector('faceplate-timeago[ts], time[datetime]');
      const iso = attr(el, 'created-timestamp') || (t && (t.getAttribute('ts') || t.getAttribute('datetime')));
      const ms = Date.parse(iso || '');
      return isNaN(ms) ? Date.now() / 1000 : ms / 1000;
    };
    const id = (attr(sp, 'id', 'thingid') || '').replace(/^t3_/, '') || (location.pathname.match(/\/comments\/([a-z0-9]+)/i) || [])[1];
    const body = sp.querySelector('[slot="text-body"]');
    const href = attr(sp, 'content-href');
    const postType = attr(sp, 'post-type');
    const images = [...sp.querySelectorAll('img')].map(i => i.currentSrc || i.src)
      .filter(u => /^https:\/\/(i|preview)\.redd\.it\//.test(u));
    const p = {
      id, title: attr(sp, 'post-title') || document.title,
      subreddit: (attr(sp, 'subreddit-prefixed-name') || '').replace(/^r\//, '') || (location.pathname.match(/^\/r\/([^/]+)/) || [])[1] || '',
      author: attr(sp, 'author'), score: num(attr(sp, 'score')), num_comments: num(attr(sp, 'comment-count')),
      created_utc: ts(sp), selftext_html: body ? body.innerHTML : '',
      is_self: !href || /\/comments\//.test(href), url: href,
      post_hint: postType === 'image' ? 'image' : '',
      permalink: attr(sp, 'permalink') || location.pathname,
      over_18: sp.hasAttribute('nsfw') || sp.hasAttribute('is-nsfw') || attr(sp, 'nsfw') === 'true',
      preview: images.length ? { images: [{ source: { url: images[0], width: 1080 }, resolutions: [] }] } : undefined,
    };
    const toNode = (c) => {
      const text = c.querySelector(':scope > [slot="comment"]') || c.querySelector('[slot="comment"]');
      const kids = [...c.querySelectorAll(':scope > shreddit-comment, :scope > * > shreddit-comment')];
      return {
        kind: 't1', data: {
          author: attr(c, 'author') || '[deleted]', score: num(attr(c, 'score')), created_utc: ts(c),
          body_html: text ? text.innerHTML : '', is_submitter: attr(c, 'author') === p.author,
          replies: kids.length ? { data: { children: kids.map(toNode) } } : '',
        },
      };
    };
    const tree = document.querySelector('shreddit-comment-tree');
    const top = tree ? [...tree.querySelectorAll(':scope > shreddit-comment')] : [...document.querySelectorAll('shreddit-comment[depth="0"]')];
    return [{ data: { children: [{ kind: 't3', data: p }] } }, { data: { children: top.map(toNode) } }];
  }
})();
