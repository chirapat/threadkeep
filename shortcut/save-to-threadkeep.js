// "Save to ThreadKeep" — runs inside the Reddit page open in Safari (via Shortcuts → Run JavaScript on Web Page).
// It uses your signed-in Reddit session to fetch the thread data, and hands it back to the Shortcut,
// which copies it to the clipboard for ThreadKeep to import.
(async () => {
  const send = (o) => completion('THREADKEEP:' + JSON.stringify(o));
  try {
    if (!/(^|\.)reddit\.com$/.test(location.hostname)) {
      return send({ error: 'Open a Reddit post or subreddit in Safari first.' });
    }
    const get = async (url) => {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error('Reddit said ' + r.status + (r.status === 403 ? '. Make sure you are signed in to Reddit in Safari.' : '.'));
      return r.json();
    };
    const post = location.pathname.match(/\/comments\/([a-z0-9]+)/i);
    if (post) {
      const thread = await get('/comments/' + post[1] + '.json?limit=500&depth=10&sort=top&raw_json=1');
      return send({ tk: 1, source: 'post', threads: [thread] });
    }
    const sub = location.pathname.match(/^\/r\/([A-Za-z0-9_]+)/);
    if (!sub) return send({ error: 'Open a Reddit post or a subreddit page (like r/AskReddit), then run the Shortcut.' });
    const COUNT = 10; // top posts of the day to grab from a subreddit page
    const list = await get('/r/' + sub[1] + '/top.json?t=day&limit=' + (COUNT + 5) + '&raw_json=1');
    const ids = list.data.children.map(c => c.data).filter(d => !d.stickied).slice(0, COUNT).map(d => d.id);
    const threads = (await Promise.all(ids.map(id =>
      get('/comments/' + id + '.json?limit=200&depth=6&sort=top&raw_json=1').catch(() => null)
    ))).filter(Boolean);
    send({ tk: 1, source: 'subreddit', sub: sub[1], threads });
  } catch (e) {
    send({ error: String((e && e.message) || e) });
  }
})();
