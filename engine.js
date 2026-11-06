/*
 * engine.js - Scheduling engine for the VP320/VP330.
 *
 * Phase 4: decides, for a given date/time, which scheduler.tm2 event should
 * fire, and dispatches it to the player through the official REST API.
 *
 * Two usage modes:
 *   1. In the browser (remote.html): run a daemon that checks at each minute
 *      boundary and triggers commands via the Digest-auth REST client (api.js).
 *   2. In Node: deterministic lookup helpers (resolveDay, eventsFor, toREST)
 *      for tests and headless use.
 *
 * The official player firmware is *supposed* to interpret /SYSTEM/scheduler.tm2
 * by itself (firmware >= V1.13.1). This engine is the fallback / verification
 * path used when the firmware path is not available or needs to be driven from
 * the network.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ENGINE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Command code -> REST dispatch (path + query). value comes from the event.
  function toREST(e) {
    const v = e.value;
    switch (e.code) {
      case 0x00: return { path: '/api/player/play-folder', query: { folder: v } };
      case 0x01: return { path: v === 2 ? '/api/player/stop' : '/api/player/play' };
      case 0x02: return { path: v === 1 ? '/api/power/standby' : '/api/power/wakeup' };
      case 0x03: return { path: v === 1 ? '/api/display/standby' : '/api/display/wakeup' };
      case 0x05: return { path: v === 1 ? '/api/videoprojector/poweron' : '/api/videoprojector/poweroff' };
      default: return null;
    }
  }

  // Which typical day applies on a given date? null if no assignment.
  function resolveDay(model, date) {
    const iso = (date instanceof Date ? date : new Date(date)).toISOString().slice(0, 10);
    const idx = model.dates[iso];
    return (idx === undefined) ? null : idx;
  }

  // Events scheduled at `minute` (0..1439) for a given typical day index.
  function eventsFor(model, dayIndex, minute) {
    if (dayIndex === null || dayIndex === undefined) return [];
    const day = model.days[dayIndex];
    if (!day) return [];
    return day.events.filter(e => e.minute === minute);
  }

  // Human-readable description of an event.
  function describe(e) {
    const cmd = (TM2_COMMANDS[e.code] || 'CMD ' + e.code);
    let txt = cmd + ' ' + e.value;
    if (e.code === 0x00) txt = 'PLAY FOLDER ' + String(e.value).padStart(3, '0');
    else if (e.code === 0x01) txt = e.value === 2 ? 'STOP' : 'PLAY';
    else if (e.code === 0x02) txt = e.value === 1 ? 'STANDBY' : 'WAKE UP';
    else if (e.code === 0x03) txt = e.value === 1 ? 'HDMI-CEC STANDBY' : 'HDMI-CEC WAKE UP';
    else if (e.code === 0x05) txt = e.value === 1 ? 'PJLINK POWER ON' : 'PJLINK POWER OFF';
    return txt;
  }

  // ---- daemon (browser / network) ------------------------------------------
  // opts: { model, client, now?, onEvent?, onTick?, onError?, interval? }
  // client: a VPAPI client with .cmd(path, query). Returns { stop }.
  function createDaemon(opts) {
    let running = false;
    let timer = null;
    let lastMinute = -1;

    const interval = opts.interval || 1000; // check loop
    const now = opts.now || (() => new Date());
    const onEvent = opts.onEvent || (() => {});
    const onTick = opts.onTick || (() => {});
    const onError = opts.onError || ((err) => console.error('engine:', err));

    function tick() {
      if (!running) return;
      const d = now();
      const minute = d.getHours() * 60 + d.getMinutes();
      if (minute !== lastMinute) {
        lastMinute = minute;
        try {
          const day = resolveDay(opts.model, d);
          const events = day === null ? [] : eventsFor(opts.model, day, minute);
          onTick({ date: d, minute, day, events });
          events.forEach(ev => {
            const rest = toREST(ev);
            if (!rest) return onEvent({ ev, skipped: 'unknown command ' + ev.code });
            onEvent({ ev, rest, date: d });
            if (opts.client && rest.path) {
              opts.client.cmd(rest.path, rest.query).then(
                () => {},
                err => onError(err)
              );
            }
          });
        } catch (err) {
          onError(err);
        }
      }
    }

    return {
      start() { running = true; lastMinute = -1; timer = setInterval(tick, interval); tick(); return this; },
      stop() { running = false; if (timer) { clearInterval(timer); timer = null; } return this; },
      isRunning() { return running; }
    };
  }

  // Lazy handle to TM2 command names (avoids hard dependency at module load).
  const TM2_COMMANDS = {
    0x00: 'PLAY FOLDER', 0x01: 'PLAYBACK', 0x02: 'STANDBY/WAKEUP',
    0x03: 'HDMI-CEC', 0x05: 'PJLINK'
  };

  return { toREST, resolveDay, eventsFor, describe, createDaemon };
});
