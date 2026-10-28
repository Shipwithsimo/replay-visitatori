(function () {
  var $ = function (id) { return document.getElementById(id); };
  var state = { range: 'online', sessions: [], selected: null, mode: null, ws: null, replayer: null, player: null };

  // ---- API -----------------------------------------------------------------

  function token() {
    if (window.REPLAY_EMBEDDED && window.shopify && window.shopify.idToken) return window.shopify.idToken();
    return Promise.resolve(null);
  }

  function api(path) {
    return token().then(function (t) {
      return fetch(path, { headers: t ? { Authorization: 'Bearer ' + t } : {}, credentials: 'same-origin' });
    }).then(function (r) {
      if (r.status === 401 && !window.REPLAY_EMBEDDED) { location.href = '/login'; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ---- Formatting ------------------------------------------------------------

  function device(ua) {
    ua = ua || '';
    var kind = /iPad|Tablet/i.test(ua) ? 'Tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'Mobile' : 'Desktop';
    var browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    var os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS'
      : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    return kind + ' · ' + browser + (os ? ' · ' + os : '');
  }

  function flag(cc) {
    if (!cc || cc.length !== 2) return '';
    return String.fromCodePoint.apply(null, cc.toUpperCase().split('').map(function (c) { return 127397 + c.charCodeAt(0); }));
  }

  function path(url) {
    try { var u = new URL(url); return u.pathname + u.search; } catch (e) { return url || ''; }
  }

  function money(cart) {
    if (!cart || !cart.count) return '';
    var v = (cart.total || 0) / 100;
    var s;
    try { s = new Intl.NumberFormat('it-IT', { style: 'currency', currency: cart.currency || 'EUR' }).format(v); }
    catch (e) { s = v.toFixed(2); }
    return '🛒 ' + s + ' (' + cart.count + ')';
  }

  function ago(ts, now) {
    var s = Math.round((now - ts) / 1000);
    if (s < 60) return s + 's fa';
    if (s < 3600) return Math.round(s / 60) + ' min fa';
    if (s < 86400) return Math.round(s / 3600) + ' h fa';
    return new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function duration(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(s / 60);
    return m ? m + 'm ' + (s % 60) + 's' : s + 's';
  }

  function label(s) {
    if (s.customer && (s.customer.name || s.customer.email)) return s.customer.name || s.customer.email;
    return 'Visitatore ' + (s.visitor_id || s.id).slice(-4).toUpperCase();
  }

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- Session list ----------------------------------------------------------

  function loadSessions() {
    var days = state.range === 'online' ? 1 : state.range;
    return api('/api/sessions?days=' + days).then(function (data) {
      var list = data.sessions;
      $('online-count').textContent = list.filter(function (s) { return s.online; }).length;
      if (state.range === 'online') list = list.filter(function (s) { return s.online; });
      state.sessions = list;
      renderList(data.now);
    }).catch(function (e) { console.error(e); });
  }

  function renderList(now) {
    var ul = $('sessions');
    $('empty').hidden = state.sessions.length > 0;
    ul.innerHTML = state.sessions.map(function (s) {
      return '<li data-id="' + esc(s.id) + '" class="' + (state.selected === s.id ? 'selected' : '') + '">' +
        '<div class="row1"><span class="status ' + (s.online ? 'on' : '') + '"></span>' +
        '<strong>' + esc(label(s)) + '</strong>' +
        '<span class="muted right">' + (s.online ? 'online' : ago(s.last_seen, now)) + '</span></div>' +
        '<div class="row2" title="' + esc(s.url) + '">' + esc(path(s.url)) + '</div>' +
        '<div class="row3 muted">' + flag(s.country) + ' ' + esc(device(s.ua)) + ' · ' + s.page_count + ' pag. · ' +
        duration(s.last_seen - s.started_at) + (money(s.cart) ? ' · ' + money(s.cart) : '') + '</div>' +
        '</li>';
    }).join('');
  }

  $('sessions').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-id]');
    if (li) open(li.getAttribute('data-id'));
  });

  document.querySelectorAll('.filters button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.filters button').forEach(function (x) { x.classList.toggle('active', x === b); });
      state.range = b.getAttribute('data-range');
      loadSessions();
    });
  });

  // ---- Viewer ----------------------------------------------------------------

  function teardown() {
    if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
    if (state.replayer) { try { state.replayer.destroy(); } catch (e) {} state.replayer = null; }
    if (state.player) { try { state.player.$destroy(); } catch (e) {} state.player = null; }
    $('stage').innerHTML = '';
  }

  function setMode(mode, online) {
    state.mode = mode;
    $('v-mode').textContent = mode === 'live' ? '● LIVE' : 'Replay';
    $('v-mode').className = 'badge ' + (mode === 'live' ? 'live' : '');
    $('btn-live').hidden = !(mode === 'replay' && online);
    $('btn-replay').hidden = mode === 'replay';
  }

  function open(id) {
    state.selected = id;
    document.querySelectorAll('#sessions li').forEach(function (li) {
      li.classList.toggle('selected', li.getAttribute('data-id') === id);
    });
    $('placeholder').hidden = true;
    $('viewer').hidden = false;
    api('/api/sessions/' + encodeURIComponent(id)).then(function (s) {
      if (state.selected !== id) return;
      state.session = s;
      $('v-title').textContent = label(s) + (s.customer && s.customer.email && s.customer.name ? ' · ' + s.customer.email : '');
      $('v-sub').textContent = [flag(s.country) + ' ' + (s.country || ''), device(s.ua), s.vw + '×' + s.vh,
        money(s.cart), s.referrer ? 'da ' + s.referrer : ''].filter(Boolean).join(' · ');
      renderPages(s.pages);
      if (s.online) startLive(id); else startReplay(id);
    });
  }

  function renderPages(pages) {
    var t0 = pages.length ? pages[0].ts : 0;
    $('v-pages').innerHTML = pages.map(function (p) {
      return '<li><span class="muted">+' + duration(p.ts - t0) + '</span> ' +
        '<span title="' + esc(p.url) + '">' + esc(p.title || path(p.url)) + '</span>' +
        '<div class="muted small">' + esc(path(p.url)) + '</div></li>';
    }).join('');
  }

  function fit(wrapper, w, h) {
    var stage = $('stage');
    var scale = Math.min(stage.clientWidth / w, stage.clientHeight / h, 1);
    wrapper.style.transform = 'scale(' + scale + ')';
    wrapper.style.width = w + 'px';
    wrapper.style.height = h + 'px';
    wrapper.style.left = Math.max(0, (stage.clientWidth - w * scale) / 2) + 'px';
  }

  function startLive(id) {
    teardown();
    setMode('live', true);
    token().then(function (t) {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var url = proto + '//' + location.host + '/live?session=' + encodeURIComponent(id) + (t ? '&token=' + encodeURIComponent(t) : '');
      var ws = new WebSocket(url);
      state.ws = ws;
      var pending = [];
      var size = null;

      function ensureReplayer(events) {
        if (state.replayer || !events.length) return;
        var r = new rrweb.Replayer([], {
          root: $('stage'),
          liveMode: true,
          mouseTail: { strokeStyle: '#e11d48', lineWidth: 2, duration: 600 },
          showWarning: false
        });
        r.on('resize', function (d) {
          size = d;
          fit($('stage').querySelector('.replayer-wrapper'), d.width, d.height);
        });
        // Play ~1.5s behind the visitor so batched events arrive in time.
        r.startLive(events[events.length - 1].timestamp - 1500);
        state.replayer = r;
      }

      function push(events) {
        if (!state.replayer) {
          pending = pending.concat(events);
          // Wait for a page snapshot before building the view.
          var i = pending.findIndex(function (e) { return e.type === 4; });
          if (i < 0) return;
          events = pending.slice(i);
          pending = [];
          ensureReplayer(events);
        }
        events.forEach(function (e) { state.replayer.addEvent(e); });
        if (events.some(function (e) { return e.type === 4; })) loadPages(id);
      }

      ws.onmessage = function (m) {
        var msg = JSON.parse(m.data);
        if (msg.events) push(msg.events);
        if (msg.type === 'backlog' && !msg.events.length) {
          $('stage').innerHTML = '<p class="waiting">In attesa che il visitatore carichi una pagina…</p>';
        }
      };
      ws.onclose = function () {
        if (state.ws === ws) setTimeout(function () { if (state.selected === id && state.mode === 'live') startLive(id); }, 2000);
      };
      window.onresize = function () {
        var w = $('stage').querySelector('.replayer-wrapper');
        if (w && size) fit(w, size.width, size.height);
      };
    });
  }

  function loadPages(id) {
    api('/api/sessions/' + encodeURIComponent(id)).then(function (s) {
      if (state.selected === id) renderPages(s.pages);
    });
  }

  function startReplay(id) {
    teardown();
    setMode('replay', state.session && state.session.online);
    $('stage').innerHTML = '<p class="waiting">Caricamento sessione…</p>';
    api('/api/sessions/' + encodeURIComponent(id) + '/events').then(function (events) {
      if (state.selected !== id || state.mode !== 'replay') return;
      $('stage').innerHTML = '';
      if (events.length < 2) {
        $('stage').innerHTML = '<p class="waiting">Sessione troppo breve per essere riprodotta.</p>';
        return;
      }
      var stage = $('stage');
      var Player = rrwebPlayer.Player || rrwebPlayer.default || rrwebPlayer;
      state.player = new Player({
        target: stage,
        props: {
          events: events,
          width: stage.clientWidth,
          height: Math.max(200, stage.clientHeight - 80),
          autoPlay: true,
          skipInactive: true,
          showController: true,
          mouseTail: { strokeStyle: '#e11d48', lineWidth: 2, duration: 600 },
          speedOption: [1, 2, 4, 8]
        }
      });
    });
  }

  $('btn-replay').addEventListener('click', function () { if (state.selected) startReplay(state.selected); });
  $('btn-live').addEventListener('click', function () { if (state.selected) startLive(state.selected); });

  loadSessions();
  setInterval(loadSessions, 3000);
})();
