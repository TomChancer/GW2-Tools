// Boss/meta event timers. There's no official API for this — event schedules are
// sourced from the GW2 wiki's own community-maintained timer widget data, and the
// schedule-computation algorithm below is a direct port of that widget's own JS
// (Widget:Event_timer on wiki.guildwars2.com), so results match the wiki exactly.
const express = require('express');
const router  = express.Router();
const fetch   = require('node-fetch');
const db      = require('../db');

const WIKI_DATA_URL = 'https://wiki.guildwars2.com/index.php?title=Widget:Event_timer/data.json&action=raw';
const DAY_MIN = 24 * 60;

let syncRunning = false;

async function syncEventTimers() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    console.log('[TimerSync] Fetching event timer data from the wiki…');
    const raw = await fetch(WIKI_DATA_URL).then(r => r.json());
    const groups = { ...raw.events };
    delete groups.t; // 't' is a template/placeholder entry in the source data, not a real group
    db.upsertEventTimerData(groups);
    db.setMeta('last_timer_sync', String(Math.floor(Date.now() / 1000)));
    console.log(`[TimerSync] Stored ${Object.keys(groups).length} event groups`);
  } catch(e) {
    console.error('[TimerSync] Failed:', e.message);
  } finally {
    syncRunning = false;
  }
}

function scheduleTimerSync() {
  const lastSync = parseInt(db.getMeta('last_timer_sync') || '0');
  const elapsed  = Math.floor(Date.now() / 1000) - lastSync;
  const WEEK     = 7 * 86400;
  if (elapsed > WEEK) {
    setTimeout(syncEventTimers, 20000);
  } else {
    setTimeout(syncEventTimers, (WEEK - elapsed) * 1000);
  }
  setInterval(syncEventTimers, WEEK * 1000);
}

// ── Schedule computation — port of the wiki widget's fullPatternGenerator ──────
// Given a group's partial+pattern sequences, expand into a flat list of segments
// with absolute start/end times. `partial` plays once starting at UTC midnight of
// `dayStartMs`, then `pattern` repeats for as long as needed to reach `fillMin`
// minutes past that midnight — which can extend well past 24h to cover a wide window.
//
// Deliberately a SINGLE calculation anchored at one midnight, not one-per-day-merged:
// re-anchoring at a second day's own midnight would independently re-derive that day's
// `partial` (the "continuation of whatever was in progress"), producing a second segment
// describing the same real occurrence as the first calculation's midnight-crossing tail —
// i.e. the same bug as computing a function's value twice from two different starting
// assumptions about its own history. One continuous calculation avoids that entirely.
function expandDay(group, dayStartMs, fillMin) {
  const partial = group.sequences.partial || [];
  const pattern  = group.sequences.pattern || [];

  const partialDur = partial.reduce((s, v) => s + v.d, 0);
  let flat;
  if (partialDur >= fillMin || pattern.length === 0) {
    flat = partial;
  } else {
    const patternDur = pattern.reduce((s, v) => s + v.d, 0);
    const repeats = patternDur > 0 ? Math.ceil((fillMin - partialDur) / patternDur) : 0;
    flat = partial.slice();
    for (let i = 0; i < repeats; i++) flat = flat.concat(pattern);
  }

  const segments = [];
  let cursorMin = 0;
  for (const seg of flat) {
    if (cursorMin >= fillMin) break;
    const startMs = dayStartMs + cursorMin * 60000;
    const endMs   = dayStartMs + (cursorMin + seg.d) * 60000;
    const def = group.segments[seg.r] || {};
    segments.push({ ref: seg.r, name: def.name || '', link: def.link || null, chatlink: def.chatlink || null, bg: def.bg || null, start: startMs, end: endMs });
    cursorMin += seg.d;
  }
  return segments;
}

// Anchors on the UTC day containing windowStart, extends the calculation forward far
// enough to cover windowEnd (even many days out), then clips to the actual window.
function computeSchedule(group, windowStart, windowEnd) {
  const dayMs     = DAY_MIN * 60000;
  const dayStart  = Math.floor(windowStart / dayMs) * dayMs;
  const fillMin   = Math.ceil((windowEnd - dayStart) / 60000) + 5;
  const segments  = expandDay(group, dayStart, fillMin);
  return segments.filter(seg => seg.end > windowStart && seg.start < windowEnd);
}

function nextNamedOccurrence(group, afterMs) {
  // Look up to 2 days ahead — comfortably covers even the longest realistic gaps between named segments
  const schedule = computeSchedule(group, afterMs, afterMs + 2 * DAY_MIN * 60000);
  return schedule.find(seg => seg.name && seg.start > afterMs) || null;
}

// ── World boss API ID → lowercase segment name mapping ───────────────────────
// The wiki timer widget uses numeric segment refs (1, 2, 3…), not name-based IDs,
// so completion matching must go via segment names rather than refs.
// Each value is the lowercase canonical segment name as it appears in the wiki data.
const WORLDBOSS_API_TO_NAME = {
  'admiral_taidha_covington': 'admiral taidha covington',
  'claw_of_jormag':           'claw of jormag',
  'fire_elemental':           'fire elemental',
  'golem_mark_ii':            'golem mark ii',
  'great_jungle_wurm':        'great jungle wurm',
  'juniper_mindweb':          'juniper mindweb',
  'karka_queen':              'karka queen',
  'megadestroyer':            'megadestroyer',
  'modniir_ulgoth':           'modniir ulgoth',
  'shadow_behemoth':          'shadow behemoth',
  'svanir_shaman_chief':      'svanir shaman chief',
  'tequatl':                  'tequatl',
  'the_shatterer':            'the shatterer',
  'triple_trouble':           'triple trouble',
};

// ── Routes ───────────────────────────────────────────────────────────────────────

// Returns all groups with their named segments (and per-segment tracking state).
// The segments array preserves schedule order (unique refs in sequence order).
router.get('/groups', (req, res) => {
  try {
    const groups = db.getFullEventData();
    res.json({ ok: true, groups: groups.map(g => {
      const seenRefs = new Set();
      const seqOrder = [...(g.sequences.partial || []), ...(g.sequences.pattern || [])];
      const orderedRefs = seqOrder.map(s => s.r).filter(r => {
        if (seenRefs.has(r)) return false; seenRefs.add(r); return true;
      });
      const segments = orderedRefs
        .filter(ref => g.segments[ref]?.name)
        .map(ref => ({ ref, name: g.segments[ref].name, tracked: g.segments[ref].segTracked, notifyMinutes: g.segments[ref].segNotifyMinutes }));
      return {
        key: g.key, category: g.category, name: g.name, link: g.link,
        tracked: g.tracked, notifyMinutes: g.notifyMinutes, segments,
      };
    }) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/track', (req, res) => {
  const { groupKey, enabled, notifyMinutes } = req.body;
  if (!groupKey) return res.status(400).json({ error: 'groupKey required' });
  db.setTrackedEvent(groupKey, !!enabled, Math.max(1, parseInt(notifyMinutes) || 10));
  res.json({ ok: true });
});

router.post('/track-segment', (req, res) => {
  const { groupKey, segmentRef, enabled, notifyMinutes } = req.body;
  if (!groupKey || !segmentRef) return res.status(400).json({ error: 'groupKey and segmentRef required' });
  db.setTrackedSegment(groupKey, segmentRef, !!enabled, Math.max(1, parseInt(notifyMinutes) || 10));
  res.json({ ok: true });
});

// Returns the schedule for tracked groups/segments.
// Groups with any individually tracked segments emit per-segment rows instead of one group row,
// which gives each boss its own timeline lane with only its own occurrences visible.
router.get('/schedule', (req, res) => {
  try {
    const hoursBack    = Math.min(parseFloat(req.query.hoursBack)    || 0.5, 6);
    const hoursForward = Math.min(parseFloat(req.query.hoursForward) || 4,  12);
    const onlyTracked  = req.query.onlyTracked !== 'false';
    const now = Date.now();
    const windowStart = now - hoursBack * 3600000;
    const windowEnd   = now + hoursForward * 3600000;

    const groups = db.getFullEventData();
    const result = [];

    // Which groups have at least one individually tracked segment (segment mode)
    const segModeGroups = new Set(
      groups.filter(g => Object.values(g.segments).some(s => s.segTracked)).map(g => g.key)
    );

    for (const g of groups) {
      if (segModeGroups.has(g.key)) {
        // Segment mode: emit one row per tracked segment
        for (const [ref, seg] of Object.entries(g.segments)) {
          if (!seg.segTracked) continue;
          const segsInWindow = computeSchedule(g, windowStart, windowEnd).filter(s => s.ref === ref);
          result.push({
            key: `${g.key}:${ref}`, category: g.category, name: seg.name, link: seg.link,
            tracked: true, notifyMinutes: seg.segNotifyMinutes,
            segments: segsInWindow, isSegmentLevel: true,
          });
        }
      } else {
        if (onlyTracked && !g.tracked) continue;
        result.push({
          key: g.key, category: g.category, name: g.name, link: g.link,
          tracked: g.tracked, notifyMinutes: g.notifyMinutes,
          segments: computeSchedule(g, windowStart, windowEnd),
          isSegmentLevel: false,
        });
      }
    }

    res.json({ ok: true, now, windowStart, windowEnd, groups: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Fetches which world bosses the account has completed today.
// Requires the API key to have `progression` scope — returns completedRefs: null (not []) when scope is missing.
router.post('/completion', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.json({ ok: true, completedRefs: [] });
  try {
    const resp = await fetch('https://api.guildwars2.com/v2/account/worldbosses', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (resp.status === 403) {
      return res.json({ ok: true, completedRefs: null, note: 'progression_scope_required' });
    }
    if (!resp.ok) throw new Error(`GW2 API ${resp.status}`);
    const bossIds = await resp.json();
    // Map to canonical lowercase segment names for client-side name matching
    const completedNames = bossIds.map(id => WORLDBOSS_API_TO_NAME[id] || id.replace(/_/g, ' '));
    res.json({ ok: true, completedNames });
  } catch(e) {
    res.json({ ok: false, error: e.message, completedRefs: [] });
  }
});

router.get('/sync-status', (req, res) => {
  const lastSync = db.getMeta('last_timer_sync');
  res.json({ ok: true, status: syncRunning ? 'running' : (lastSync ? 'done' : 'never'), lastSync: lastSync ? parseInt(lastSync) : null });
});

router.post('/sync', (req, res) => {
  if (syncRunning) return res.json({ ok: false, error: 'Already running' });
  syncEventTimers().catch(e => console.error('[TimerSync]', e.message));
  res.json({ ok: true });
});

// ── Notification polling ──────────────────────────────────────────────────────
// Gated the same way as routes/app-update.js — only fires inside the packaged Electron app.
let Notification = null;
if (process.versions && process.versions.electron) {
  try {
    const electron = require('electron');
    if (electron.app && electron.app.isPackaged !== undefined) Notification = electron.Notification;
  } catch(e) { /* not actually running inside Electron's main process */ }
}

function fireNotification(title, body) {
  console.log(`[TimerNotify] Firing: ${title}`);
  const notif = new Notification({ title, body });
  notif.on('show',   ()      => console.log('[TimerNotify] show event fired'));
  notif.on('failed', (e, err) => console.error('[TimerNotify] failed event:', err));
  notif.show();
}

function checkNotifications() {
  if (!Notification) return;
  if (Notification.isSupported && !Notification.isSupported()) {
    console.warn('[TimerNotify] Notification.isSupported() is false — OS-level notifications are blocked or unavailable on this machine');
    return;
  }
  const now    = Date.now();
  const groups = db.getFullEventData();
  const byKey  = {};
  for (const g of groups) byKey[g.key] = g;

  // Group-level notifications
  const tracked = db.getTrackedEvents();
  for (const t of tracked) {
    const group = byKey[t.group_key];
    if (!group) continue;
    const next = nextNamedOccurrence(group, now);
    if (!next) continue;
    const minutesUntil = (next.start - now) / 60000;
    if (minutesUntil <= t.notify_minutes && next.start !== t.last_notified) {
      fireNotification(
        `${next.name} — starting soon`,
        `${group.name} (${group.category}) in ${Math.max(0, Math.round(minutesUntil))} min`
      );
      db.setLastNotified(t.group_key, next.start);
    }
  }

  // Per-segment notifications
  const trackedSegs = db.getTrackedSegments();
  for (const ts of trackedSegs) {
    const group = byKey[ts.group_key];
    if (!group) continue;
    const segDef = group.segments[ts.segment_ref];
    if (!segDef) continue;
    const schedule = computeSchedule(group, now, now + 2 * DAY_MIN * 60000);
    const next = schedule.find(s => s.ref === ts.segment_ref && s.start > now && s.name);
    if (!next) continue;
    const minutesUntil = (next.start - now) / 60000;
    if (minutesUntil <= ts.notify_minutes && next.start !== ts.last_notified) {
      fireNotification(
        `${next.name} — starting soon`,
        `${group.category} in ${Math.max(0, Math.round(minutesUntil))} min`
      );
      db.setSegmentLastNotified(ts.group_key, ts.segment_ref, next.start);
    }
  }
}

function start() {
  scheduleTimerSync();
  setInterval(checkNotifications, 30000);
}

module.exports = { router, start };
