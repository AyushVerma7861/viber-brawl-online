/* =============================================================================
   mp-profile.js — the PROFILE screen.

   Shows a player what they have actually done: level, XP progress, career
   totals, a per-Viber breakdown, and their recent match history.

   Everything rendered here comes from the server, computed from matches the
   server refereed. Nothing is client-side guesswork, and nothing is editable.

   Injected into the generated game copy as a classic script after the original
   game script, so it shares `screens` / `showScreen` / `SFX`. The original file
   is never touched.
   ============================================================================= */
(function () {
'use strict';

var PROF = {
  ready: false,
  loading: false,
  data: null,
  error: '',
  tab: 'overview'
};
window.__VB_PROFILE = PROF;

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

var CHAR_NAMES = { miner: 'CRIMSON MINER', moss: 'MOSS', volt: 'VOLT', phantom: 'PHANTOM' };
var CHAR_COLORS = { miner: '#DFF902', moss: '#5CFFE7', volt: '#FFD36A', phantom: '#A56BFF' };
function charName(id) { return CHAR_NAMES[id] || String(id || '?').toUpperCase(); }
function charColor(id) { return CHAR_COLORS[id] || '#F3E6C4'; }

function num(n) {
  var v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
}

/** "2h ago" — enough precision to be useful, no more. */
function ago(ts) {
  if (!ts) return '';
  var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function duration(s) {
  var v = Math.max(0, Math.round(Number(s) || 0));
  if (v < 60) return v + 's';
  return Math.floor(v / 60) + 'm ' + (v % 60) + 's';
}

var PLACE = ['1ST', '2ND', '3RD', '4TH'];

/* ------------------------------------------------------------------- data -- */

PROF.load = function () {
  if (PROF.loading) return Promise.resolve(PROF.data);
  PROF.loading = true;
  PROF.error = '';
  PROF.render();

  return fetch('/api/progress/me', { credentials: 'same-origin' })
    .then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { status: r.status, data: d };
      });
    })
    .then(function (res) {
      PROF.loading = false;
      PROF.ready = true;
      if (res.status === 401) {
        /* Nobody is signed in at all — not an error, just nobody has a profile
           yet. Treating this as a failure showed a brand-new visitor
           "Not signed in. TRY AGAIN", which is both wrong and unwelcoming. */
        PROF.data = { guest: true, guestMatches: 0, noIdentity: true };
        PROF.error = '';
      } else if (!res.data || !res.data.ok) {
        PROF.error = (res.data && res.data.error) || 'Could not load your profile.';
        PROF.data = null;
      } else {
        PROF.data = res.data;
        PROF.error = '';
      }
      PROF.render();
      return PROF.data;
    })
    .catch(function () {
      PROF.loading = false;
      PROF.ready = true;
      PROF.error = 'Could not reach the server.';
      PROF.render();
      return null;
    });
};

PROF.open = function () {
  if (window.showScreen) showScreen('scrProfile');
  PROF.load();
};

/* -------------------------------------------------------------- rendering -- */

PROF.render = function () {
  var host = $('profileState');
  if (!host) return;

  if (PROF.loading && !PROF.data) {
    host.innerHTML = '<div class="pf-loading">Loading your record…</div>';
    return;
  }
  if (PROF.error) {
    host.innerHTML = '<div class="pf-empty">' + esc(PROF.error) + '</div>' +
      '<button class="btn small" id="pfRetry" style="margin-top:12px;">TRY AGAIN</button>';
    var retry = $('pfRetry');
    if (retry) retry.addEventListener('click', function () { PROF.load(); });
    return;
  }

  var d = PROF.data;
  if (!d) { host.innerHTML = ''; return; }

  /* ---- a guest, or nobody: say so plainly and point at the account screen -- */
  if (d.guest) {
    var gMatches = d.guestMatches || 0;
    var heading, body;

    if (gMatches > 0) {
      heading = 'Playing as a guest';
      body = '<p>You have played <b>' + num(gMatches) + '</b> match' +
             (gMatches === 1 ? '' : 'es') + ' as a guest, and <b>every one of them will be kept</b> ' +
             'when you create an account.</p>' +
             '<p>An account also starts you earning levels and unlocking cosmetics.</p>';
    } else if (d.noIdentity) {
      heading = 'No profile yet';
      body = '<p>Your record starts with your first match. Play one and it appears here.</p>' +
             '<p>Create an account to keep your stats, level up and unlock cosmetics.</p>';
    } else {
      heading = 'Playing as a guest';
      body = '<p>You are playing as a guest. Everything you earn from now on will be kept ' +
             'when you create an account.</p>';
    }

    host.innerHTML =
      '<div class="pf-empty">' +
        '<div class="pf-empty-h">' + esc(heading) + '</div>' +
        body +
        '<button class="btn green" id="pfSignIn" style="margin-top:6px;">CREATE AN ACCOUNT</button>' +
      '</div>';
    var go = $('pfSignIn');
    if (go) go.addEventListener('click', function () {
      if (window.SFX) SFX.click();
      var A = window.__VB_ACCOUNT;
      if (A && A.open) A.open();
    });
    return;
  }

  var s = d.stats || {};
  var matches = s.matches || 0;
  var wins = s.wins || 0;
  var winRate = matches > 0 ? Math.round(100 * wins / matches) : 0;
  var kd = (s.falls || 0) > 0 ? ((s.kos || 0) / s.falls).toFixed(2) : (s.kos ? String(s.kos) : '0.00');
  var pct = Math.round((d.progress || 0) * 100);

  var nextLine = '';
  if (d.unlocks && d.unlocks.next) {
    var nu = d.unlocks.next;
    var names = (nu.unlocks || []).slice(0, 2).map(function (u) { return esc(u.name); }).join(', ');
    nextLine = '<div class="pf-next">Next reward at <b>level ' + nu.level + '</b>: ' + names + '</div>';
  } else {
    nextLine = '<div class="pf-next">You have unlocked everything in the catalogue.</div>';
  }

  /* ------------------------------------------------------------------ head -- */
  var html =
    '<div class="pf-head">' +
      '<div class="pf-level">' +
        '<div class="pf-level-num">' + num(d.level) + '</div>' +
        '<div class="pf-level-lbl">LEVEL</div>' +
      '</div>' +
      '<div class="pf-headmid">' +
        '<div class="pf-xpbar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="pf-xptext">' + num(d.xpIntoLevel) + ' / ' + num(d.xpForNext) +
          ' XP to level ' + (d.level + 1) + ' &nbsp;·&nbsp; ' + num(d.xpTotal) + ' lifetime</div>' +
        nextLine +
      '</div>' +
    '</div>';

  /* -------------------------------------------------------------- the tabs -- */
  html +=
    '<div class="pf-tabs">' +
      tabBtn('overview', 'CAREER') +
      tabBtn('vibers', 'BY VIBER') +
      tabBtn('history', 'MATCH HISTORY') +
    '</div>';

  if (PROF.tab === 'overview') {
    html +=
      '<div class="pf-grid">' +
        stat(matches, 'Matches') +
        stat(wins, 'Wins') +
        stat(winRate + '%', 'Win rate') +
        stat(kd, 'KO / fall ratio') +
        stat(num(s.kos), 'Knockouts') +
        stat(num(s.falls), 'Falls') +
        stat(num(s.dmg_dealt), 'Damage dealt') +
        stat(num(s.dmg_taken), 'Damage taken') +
        stat(s.best_placement ? PLACE[s.best_placement - 1] : '—', 'Best finish') +
        stat(num(s.current_streak), 'Current streak') +
        stat(num(s.best_streak), 'Best streak') +
        stat(duration(s.playtime_s), 'Time played') +
      '</div>';
  }

  if (PROF.tab === 'vibers') {
    var mastery = (d.mastery || []).slice().sort(function (a, b) { return b.matches - a.matches; });
    if (!mastery.length) {
      html += '<div class="pf-empty">No matches played yet.</div>';
    } else {
      html += '<div class="pf-vibers">';
      mastery.forEach(function (m) {
        var wr = m.matches > 0 ? Math.round(100 * m.wins / m.matches) : 0;
        html +=
          '<div class="pf-viber">' +
            '<span class="pf-vdot" style="background:' + charColor(m.char_id) + '"></span>' +
            '<span class="pf-vname">' + esc(charName(m.char_id)) + '</span>' +
            '<span class="pf-vlvl">MASTERY ' + num(m.level) + '</span>' +
            '<span class="pf-vstats">' + num(m.matches) + ' played · ' + num(m.wins) +
              ' won · ' + wr + '% · ' + num(m.kos) + ' KO</span>' +
          '</div>';
      });
      html += '</div>';
    }
  }

  if (PROF.tab === 'history') {
    var rows = d.recentMatches || [];
    if (!rows.length) {
      html += '<div class="pf-empty">No matches yet. Play one and it will appear here.</div>';
    } else {
      html += '<div class="pf-history">';
      rows.forEach(function (m) {
        html +=
          '<div class="pf-match' + (m.winner ? ' win' : '') + '">' +
            '<span class="pf-mplace">' + esc(PLACE[m.placement - 1] || (m.placement + 'TH')) + '</span>' +
            '<span class="pf-mdot" style="background:' + charColor(m.charId) + '"></span>' +
            '<span class="pf-mchar">' + esc(charName(m.charId)) + '</span>' +
            '<span class="pf-mstats">' + num(m.kos) + ' KO · ' + num(m.dmgDealt) + ' dmg</span>' +
            '<span class="pf-mmeta">' + duration(m.durationS) + ' · ' + num(m.playerCount) + ' players' +
              (m.disconnected ? ' · left early' : '') + '</span>' +
            '<span class="pf-mtime">' + esc(ago(m.playedAt)) + '</span>' +
          '</div>';
      });
      html += '</div>';
    }
  }

  host.innerHTML = html;

  /* wire the tabs (they are re-created on every render, so bind every time) */
  Array.prototype.forEach.call(host.querySelectorAll('[data-pftab]'), function (b) {
    b.addEventListener('click', function () {
      if (window.SFX) SFX.click();
      PROF.tab = b.getAttribute('data-pftab');
      PROF.render();
    });
  });
};

function tabBtn(id, label) {
  return '<button class="pf-tab' + (PROF.tab === id ? ' on' : '') + '" data-pftab="' + id + '">' + label + '</button>';
}
function stat(value, label) {
  return '<div class="pf-stat"><div class="pf-stat-v">' + esc(value) + '</div>' +
         '<div class="pf-stat-l">' + esc(label) + '</div></div>';
}

/* ------------------------------------------------------------------- init -- */

function init() {
  if (typeof screens !== 'undefined' && screens.indexOf('scrProfile') === -1) {
    screens.push('scrProfile');
  }
  /* Preload once the page is idle so opening the screen is instant. */
  setTimeout(function () { PROF.load(); }, 1500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
