/* =============================================================================
   mp-account.js — the ACCOUNT screen.

   Injected into the generated game copy as a classic script, after the original
   game script, so it shares the original's globals (`screens`, `showScreen`,
   `SFX`). The original file is never touched.

   Design rules this file follows:
     * Playing with no account is a first-class path, never a wall.
     * A guest is told exactly what they will keep if they sign up.
     * Nothing here trusts the client — it only displays what the server says.
   ============================================================================= */
(function () {
'use strict';

var ACCT = {
  ready: false,
  config: { providers: [], password: true },
  me: null,
  mode: 'signin',      /* signin | register */
  busy: false,
  error: '',
  notice: ''
};
window.__VB_ACCOUNT = ACCT;

function $(id) { return document.getElementById(id); }

function api(path, opts) {
  opts = opts || {};
  return fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      return { status: res.status, ok: res.ok, data: data };
    });
  }).catch(function () {
    return { status: 0, ok: false, data: { error: 'Could not reach the server.' } };
  });
}

/* ------------------------------------------------------------------ state -- */

ACCT.refresh = function () {
  return api('/api/auth/config').then(function (r) {
    if (r.data && r.data.ok) ACCT.config = r.data;
    return api('/api/auth/me');
  }).then(function (r) {
    ACCT.me = (r.data && r.data.ok) ? r.data : null;
    ACCT.ready = true;
    ACCT.render();
    return ACCT.me;
  });
};

/** Called when a player enters multiplayer. Creates the throwaway identity that
    match history and XP are filed under until they choose to sign in. */
ACCT.ensureGuest = function () {
  if (ACCT.me && (ACCT.me.kind === 'guest' || ACCT.me.kind === 'account')) {
    return Promise.resolve(ACCT.me);
  }
  var name = '';
  var nameEl = $('mpName');
  if (nameEl && nameEl.value) name = nameEl.value;
  return api('/api/auth/guest', { method: 'POST', body: { name: name } }).then(function (r) {
    return ACCT.refresh();
  });
};

/** What the game should prefill as the player's name. */
ACCT.suggestedName = function () {
  return (ACCT.me && ACCT.me.displayName) ? ACCT.me.displayName : '';
};

/**
 * Keep a guest's server-side name in step with what they typed. Guests rename
 * freely; a signed-in account does NOT, because the account name is the public
 * identity and changing it has a cooldown.
 */
ACCT.syncGuestName = function (name) {
  if (!name || !ACCT.me || ACCT.me.kind !== 'guest') return Promise.resolve();
  if (ACCT.me.displayName === name) return Promise.resolve();
  return api('/api/auth/profile', { method: 'PATCH', body: { displayName: name } })
    .then(function () { return ACCT.refresh(); })
    .catch(function () { /* non-fatal: they keep playing under the old name */ });
};

ACCT.isSignedIn = function () {
  return !!(ACCT.me && ACCT.me.signedIn);
};

/* --------------------------------------------------------------- rendering -- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function providerButtons() {
  var list = (ACCT.config.providers || []);
  if (!list.length) return '';
  var html = '<div class="acct-or"><span>or</span></div>';
  list.forEach(function (p) {
    var cls = p.id === 'discord' ? 'acct-oauth discord' : 'acct-oauth google';
    html += '<button class="acct-oauth ' + (p.id === 'discord' ? 'discord' : 'google') + '" data-oauth="' + esc(p.id) + '">' +
            'CONTINUE WITH ' + esc(String(p.label).toUpperCase()) + '</button>';
  });
  return html;
}

ACCT.render = function () {
  var host = $('acctState');
  if (!host) return;
  var me = ACCT.me;

  /* ---------------------------------------------------- signed out / guest -- */
  if (!me || !me.signedIn) {
    var isGuest = !!(me && me.kind === 'guest');
    var matches = (me && me.guestMatches) || 0;

    var keep = '';
    if (isGuest && matches > 0) {
      keep = '<div class="acct-keep">You have played <b>' + matches + '</b> match' +
             (matches === 1 ? '' : 'es') + ' as a guest. ' +
             'Signing in <b>keeps all of it</b> — every match, every knockout, all of your progress.</div>';
    } else if (isGuest) {
      keep = '<div class="acct-keep">You are playing as a guest. Signing in keeps your name and everything you earn from now on.</div>';
    }

    var passwordBlock = '';
    if (ACCT.config.password) {
      passwordBlock =
        '<div class="acct-tabs">' +
          '<button class="acct-tab' + (ACCT.mode === 'signin' ? ' on' : '') + '" data-mode="signin">SIGN IN</button>' +
          '<button class="acct-tab' + (ACCT.mode === 'register' ? ' on' : '') + '" data-mode="register">CREATE ACCOUNT</button>' +
        '</div>' +
        '<div class="mp-field"><label class="mp-label" for="acctEmail">EMAIL</label>' +
          '<input id="acctEmail" class="mp-input" type="email" autocomplete="email" spellcheck="false" placeholder="you@example.com"></div>' +
        '<div class="mp-field"><label class="mp-label" for="acctPass">PASSWORD</label>' +
          '<input id="acctPass" class="mp-input" type="password" autocomplete="' +
            (ACCT.mode === 'register' ? 'new-password' : 'current-password') + '" placeholder="at least 8 characters"></div>' +
        (ACCT.mode === 'register'
          ? '<div class="mp-field"><label class="mp-label" for="acctName">DISPLAY NAME</label>' +
            '<input id="acctName" class="mp-input" maxlength="14" spellcheck="false" placeholder="VIBER" value="' +
            esc(ACCT.suggestedName()) + '"></div>'
          : '') +
        '<button class="btn green" id="acctSubmit" style="margin-top:8px;">' +
          (ACCT.mode === 'register' ? 'CREATE ACCOUNT' : 'SIGN IN') + '</button>';
    }

    host.innerHTML =
      '<div class="acct-who">' +
        '<span class="acct-badge">' + (isGuest ? 'PLAYING AS GUEST' : 'NOT SIGNED IN') + '</span>' +
        (isGuest ? '<span class="acct-name">' + esc(me.displayName || 'VIBER') + '</span>' : '') +
      '</div>' +
      keep +
      providerButtons() +
      passwordBlock;

    wire(host);
    return;
  }

  /* ------------------------------------------------------------- signed in -- */
  var ids = me.identities || [];
  var linked = ids.map(function (i) {
    return '<span class="acct-link">' + esc(i.provider === 'password' ? 'Email and password' : i.provider) + '</span>';
  }).join('') || '<span class="acct-link muted">none</span>';

  host.innerHTML =
    '<div class="acct-who">' +
      '<span class="acct-badge on">SIGNED IN</span>' +
      '<span class="acct-name">' + esc(me.displayName || 'VIBER') + '</span>' +
    '</div>' +
    '<div class="acct-row"><span>Sign-in methods</span><span>' + linked + '</span></div>' +
    '<div class="acct-row"><span>Profile visible to others</span><span>' +
      '<button class="acct-toggle" id="acctPublic">' + (me.isPublic ? 'PUBLIC' : 'PRIVATE') + '</button></span></div>' +
    '<button class="btn small" id="acctSignOut" style="margin-top:14px;">SIGN OUT</button>' +
    '<button class="btn small" id="acctSignOutAll" style="margin-top:8px;">SIGN OUT EVERYWHERE</button>' +
    '<div class="acct-danger">' +
      '<div class="acct-danger-h">Delete account</div>' +
      '<p>This removes your email and sign-in methods and anonymises your match history. It cannot be undone.</p>' +
      '<input class="mp-input" id="acctDelConfirm" placeholder="type DELETE to confirm" spellcheck="false">' +
      '<button class="btn small" id="acctDelete" style="margin-top:8px;">DELETE MY ACCOUNT</button>' +
    '</div>';

  wire(host);
};

function wire(host) {
  host.querySelectorAll('[data-oauth]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (window.SFX) { SFX.init(); SFX.resume(); SFX.click(); }
      var returnTo = location.pathname + location.search;
      location.href = '/api/auth/oauth/' + b.getAttribute('data-oauth') + '/start?returnTo=' +
                      encodeURIComponent(returnTo);
    });
  });
  host.querySelectorAll('[data-mode]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (window.SFX) SFX.click();
      ACCT.mode = b.getAttribute('data-mode');
      ACCT.error = '';
      ACCT.render();
    });
  });

  var submit = $('acctSubmit');
  if (submit) submit.addEventListener('click', function () {
    if (window.SFX) { SFX.init(); SFX.resume(); SFX.click(); }
    ACCT.submit();
  });

  var signOut = $('acctSignOut');
  if (signOut) signOut.addEventListener('click', function () {
    if (window.SFX) SFX.click();
    ACCT.signOut('/api/auth/logout');
  });

  var signOutAll = $('acctSignOutAll');
  if (signOutAll) signOutAll.addEventListener('click', function () {
    if (window.SFX) SFX.click();
    ACCT.signOut('/api/auth/logout-all');
  });

  var pub = $('acctPublic');
  if (pub) pub.addEventListener('click', function () {
    if (window.SFX) SFX.click();
    api('/api/auth/profile', { method: 'PATCH', body: { isPublic: !(ACCT.me && ACCT.me.isPublic) } })
      .then(function () { return ACCT.refresh(); });
  });

  var del = $('acctDelete');
  if (del) del.addEventListener('click', function () {
    if (window.SFX) SFX.click();
    var v = ($('acctDelConfirm') || {}).value || '';
    if (v.toUpperCase() !== 'DELETE') { ACCT.setMessage('Type DELETE in the box to confirm.', true); return; }
    ACCT.busy = true;
    api('/api/auth/delete', { method: 'POST', body: { confirm: 'DELETE' } }).then(function (r) {
      ACCT.busy = false;
      if (!r.data || !r.data.ok) { ACCT.setMessage((r.data && r.data.error) || 'Could not delete.', true); return; }
      ACCT.mode = 'signin';
      ACCT.setMessage('Your account has been deleted.', false);
      ACCT.refresh();
    });
  });
}

ACCT.setMessage = function (text, isError) {
  ACCT.error = isError ? text : '';
  ACCT.notice = isError ? '' : text;
  var el = $('acctMsg');
  if (el) {
    el.textContent = text || '';
    el.className = 'mp-msg' + (isError ? ' bad' : (text ? ' good' : ''));
  }
};

ACCT.submit = function () {
  if (ACCT.busy) return;
  var email = ($('acctEmail') || {}).value || '';
  var pass = ($('acctPass') || {}).value || '';
  var name = ($('acctName') || {}).value || '';
  if (!email) { ACCT.setMessage('Enter your email address.', true); return; }
  if (!pass) { ACCT.setMessage('Enter your password.', true); return; }

  var isRegister = ACCT.mode === 'register';
  var body = isRegister ? { email: email, password: pass, displayName: name } : { email: email, password: pass };

  ACCT.busy = true;
  ACCT.setMessage(isRegister ? 'Creating your account…' : 'Signing in…', false);
  var btn = $('acctSubmit');
  if (btn) { btn.disabled = true; btn.textContent = isRegister ? 'CREATING…' : 'SIGNING IN…'; }

  api(isRegister ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: body })
    .then(function (r) {
      ACCT.busy = false;
      if (!r.data || !r.data.ok) {
        ACCT.setMessage((r.data && r.data.error) || 'Something went wrong. Try again.', true);
        if (btn) { btn.disabled = false; btn.textContent = isRegister ? 'CREATE ACCOUNT' : 'SIGN IN'; }
        return;
      }
      var kept = r.data.claimedMatches || 0;
      ACCT.mode = 'signin';
      ACCT.refresh().then(function () {
        ACCT.setMessage(kept > 0
          ? 'Signed in. ' + kept + ' match' + (kept === 1 ? '' : 'es') + ' carried over.'
          : 'Signed in as ' + (r.data.displayName || 'you') + '.', false);
      });
    });
};

ACCT.signOut = function (path) {
  ACCT.busy = true;
  api(path, { method: 'POST' }).then(function () {
    ACCT.busy = false;
    ACCT.setMessage('Signed out.', false);
    return ACCT.refresh();
  });
};

/* ------------------------------------------------------------------- open -- */

ACCT.open = function () {
  ACCT.error = '';
  ACCT.notice = '';
  if (window.showScreen) showScreen('scrAccount');
  ACCT.refresh().then(function () {
    /* surface a return from an OAuth redirect */
    var params = new URLSearchParams(location.search);
    var s = params.get('signin');
    if (s === 'ok') { ACCT.setMessage('Signed in.', false); cleanUrl(); }
    else if (s === 'cancelled') { ACCT.setMessage('Sign-in was cancelled.', true); cleanUrl(); }
    else if (s === 'error') { ACCT.setMessage('Sign-in failed. Please try again.', true); cleanUrl(); }
  });
};

function cleanUrl() {
  try {
    var u = new URL(location.href);
    u.searchParams.delete('signin');
    u.searchParams.delete('reason');
    history.replaceState(null, '', u.toString());
  } catch (e) {}
}

/* ------------------------------------------------------------------- init -- */

function init() {
  /* register the screen with the game's screen manager */
  if (typeof screens !== 'undefined' && screens.indexOf('scrAccount') === -1) {
    screens.push('scrAccount');
  }
  ACCT.refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
