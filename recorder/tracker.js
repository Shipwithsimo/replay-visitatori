// Storefront recorder. Served as /recorder.js after the rrweb record bundle,
// which exposes the global `rrwebRecord`.
(function () {
  if (window.__replayRecorderStarted) return;
  window.__replayRecorderStarted = true;

  var cfg = window.ReplayConfig || {};
  var endpoint = (cfg.endpoint || '').replace(/\/+$/, '');
  if (!endpoint || !window.rrwebRecord) return;
  if (window.Shopify && window.Shopify.designMode) return;

  var FLUSH_MS = 1000;
  var HEARTBEAT_MS = 10000;
  var MAX_BEACON = 60000;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function stored(storage, key) {
    try {
      var v = storage.getItem(key);
      if (!v) { v = uid(); storage.setItem(key, v); }
      return v;
    } catch (e) { return uid(); }
  }

  // One session per browser tab, one visitor per browser.
  var sessionId = stored(window.sessionStorage, 'rp_sid');
  var visitorId = stored(window.localStorage, 'rp_vid');
  var pageId = uid();

  var buffer = [];
  var meta = null;
  var lastSend = 0;
  var cart = null;

  function pageMeta() {
    return {
      url: location.href,
      title: document.title,
      referrer: document.referrer,
      ua: navigator.userAgent,
      lang: navigator.language,
      vw: window.innerWidth,
      vh: window.innerHeight,
      country: cfg.country || null,
      customer: cfg.customer || null,
      template: cfg.template || null
    };
  }

  function refreshCart() {
    if (!window.fetch) return;
    fetch('/cart.js', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (c) {
        cart = { count: c.item_count, total: c.total_price, currency: c.currency };
      })
      .catch(function () {});
  }

  function payload(events) {
    var body = {
      sid: sessionId,
      vid: visitorId,
      pid: pageId,
      shop: cfg.shop || location.hostname,
      cart: cart,
      events: events
    };
    if (meta) { body.meta = meta; }
    return JSON.stringify(body);
  }

  function send(final) {
    if (!buffer.length && !final && Date.now() - lastSend < HEARTBEAT_MS) return;
    var events = buffer;
    buffer = [];
    var body = payload(events);
    meta = null;
    lastSend = Date.now();
    var url = endpoint + '/ingest';
    // text/plain keeps this a "simple" request: no CORS preflight.
    if (final && navigator.sendBeacon && body.length < MAX_BEACON) {
      navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      return;
    }
    fetch(url, {
      method: 'POST',
      body: body,
      headers: { 'Content-Type': 'text/plain' },
      keepalive: body.length < MAX_BEACON,
      credentials: 'omit'
    }).catch(function () {
      // Put events back so the next flush retries them.
      buffer = events.concat(buffer);
    });
  }

  meta = pageMeta();
  refreshCart();

  window.rrwebRecord.record({
    emit: function (event) { buffer.push(event); },
    maskAllInputs: true,
    maskInputOptions: { password: true },
    sampling: { mousemove: 50, scroll: 150, media: 800, input: 'last' },
    inlineStylesheet: true,
    recordCanvas: false,
    checkoutEveryNms: 5 * 60 * 1000
  });

  setInterval(function () { send(false); }, FLUSH_MS);
  setInterval(refreshCart, HEARTBEAT_MS);
  window.addEventListener('pagehide', function () { send(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') send(true);
  });
})();
