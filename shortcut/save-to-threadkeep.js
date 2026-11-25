const PICK = { what: "￼", range: "￼", comments: "￼" };
// ↑ The Shortcut fills these in from its three menus (What to save? / From when? / Comments per thread).
//   If you paste this script into a Shortcut by hand, type values instead, e.g.
//   { what: "Top 10 posts", range: "This week", comments: "100 comments" }.
//
// "Save to ThreadKeep" — runs inside the Reddit page open in Safari (Shortcuts → Run JavaScript on Web Page).
// Safari pauses the page while a Shortcut runs, so this script does NO downloading: it finishes instantly and hands
// ThreadKeep (1) your choices, (2) the post shown on screen, and (3) Reddit's sign-in pass for this browser
// (the token_v2 cookie that reddit.com itself uses). ThreadKeep then downloads from Reddit's API, with no time limit.
(() => {
  const send = (o) => completion('THREADKEEP:' + JSON.stringify(o));
  try {
    if (!/(^|\.)reddit\.com$/.test(location.hostname)) {
      return send({ error: 'Open a Reddit post or subreddit in Safari first.' });
    }
    const filled = (v) => typeof v === 'string' && v.length > 0 && v !== '￼';
    const whatText = filled(PICK.what) ? PICK.what : 'This post only';
    const rangeText = filled(PICK.range) ? PICK.range.toLowerCase() : 'today';
    const pick = {
      onlyThisPost: /this post/i.test(whatText),
      top: Math.min(50, Math.max(1, parseInt(whatText.replace(/\D+/g, ''), 10) || 10)),
      t: /week/.test(rangeText) ? 'week' : /month/.test(rangeText) ? 'month' : /year/.test(rangeText) ? 'year' : /all/.test(rangeText) ? 'all' : 'day',
      comments: Math.min(500, Math.max(5, parseInt(String(filled(PICK.comments) ? PICK.comments : '').replace(/\D+/g, ''), 10) || 50)),
    };

    const cookie = document.cookie.match(/(?:^|;\s*)token_v2=([^;]+)/);
    const token = cookie ? decodeURIComponent(cookie[1]) : '';
    let exp = 0;
    try { exp = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp || 0; } catch (e) {}

    const post = location.pathname.match(/\/comments\/([a-z0-9]+)/i);
    const sub = location.pathname.match(/^\/r\/([A-Za-z0-9_]+)/);
    let page = null;
    try { if (post) page = scrapePage(pick.comments); } catch (e) {}

    send({
      tk: 2, pick, token, exp,
      postId: post ? post[1] : '', sub: sub ? sub[1] : '',
      page,
      signedIn: !!document.querySelector('[user-logged-in="true"], faceplate-tracker[noun="user_menu"], #expand-user-drawer-button'),
    });
  } catch (e) {
    send({ error: String((e && e.message) || e) });
  }

  // Builds Reddit-style thread data from the post and comments already on the page.
  function scrapePage(maxComments) {
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
    const top = (tree ? [...tree.querySelectorAll(':scope > shreddit-comment')] : [...document.querySelectorAll('shreddit-comment[depth="0"]')]).slice(0, maxComments);
    return [{ data: { children: [{ kind: 't3', data: p }] } }, { data: { children: top.map(toNode) } }];
  }
})();
