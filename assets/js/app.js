/* =========================================================================
   Astra Global — Training SOP Acknowledgement
   Vanilla JS, no dependencies. Edit config.js, not this file.
   ========================================================================= */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var DOCS = CFG.DOCUMENTS || [];
  var STORAGE_KEY = 'astra-sop-signoff-v1';

  /* ---------------- state ---------------- */
  var state = {
    step: 0,                 // 0 = details, 1..N = docs, N+1 = review
    startedAt: new Date().toISOString(),
    details: {},
    acks: {}                 // docId -> { certifiedAt, secondsViewed }
  };

  var els = {
    stepper: document.getElementById('stepper'),
    main: document.getElementById('main'),
    detailsStep: document.getElementById('step-details'),
    detailsForm: document.getElementById('details-form'),
    reviewStep: document.getElementById('step-review'),
    doneStep: document.getElementById('step-done'),
    summary: document.getElementById('summary'),
    docSummary: document.getElementById('doc-summary'),
    finalDecl: document.getElementById('final-declaration'),
    submitBtn: document.getElementById('submit-btn'),
    submitStatus: document.getElementById('submit-status'),
    reviewBack: document.getElementById('review-back'),
    receipt: document.getElementById('receipt'),
    doneMsg: document.getElementById('done-msg'),
    printBtn: document.getElementById('print-btn'),
    restartBtn: document.getElementById('restart-btn')
  };

  var docSteps = [];   // one entry per document: { cfg, section, refs, timer, seconds }

  /* ---------------- small helpers ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function q(root, role) { return root.querySelector('[data-role="' + role + '"]'); }
  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString(undefined, {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }
  function fmtDate(ymd) {
    if (!ymd) return '';
    var p = ymd.split('-');
    if (p.length !== 3) return ymd;
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return isNaN(d) ? ymd
      : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /* ---------------- persistence ---------------- */
  function save() {
    if (!CFG.PERSIST_PROGRESS) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }
  function load() {
    if (!CFG.PERSIST_PROGRESS) return;
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (saved && saved.details) {
        state.details = saved.details || {};
        state.acks = saved.acks || {};
        state.startedAt = saved.startedAt || state.startedAt;
        state.step = typeof saved.step === 'number' ? saved.step : 0;
      }
    } catch (e) { /* ignore corrupt state */ }
  }
  function clearSaved() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  /* =======================================================================
     BUILD — stepper chips + one section per document
     ===================================================================== */
  function buildStepper() {
    var labels = ['Your details'].concat(DOCS.map(function (d, i) { return 'Doc ' + (i + 1); }));
    labels.push('Submit');
    els.stepper.innerHTML = labels.map(function (label, i) {
      return '<div class="step-chip" data-chip="' + i + '">' +
             '<span class="num">' + (i + 1) + '</span><span>' + esc(label) + '</span></div>';
    }).join('');
  }

  function buildDocSteps() {
    var tpl = document.getElementById('doc-template');

    DOCS.forEach(function (docCfg, index) {
      var node = tpl.content.firstElementChild.cloneNode(true);
      node.id = 'step-doc-' + index;
      node.dataset.step = 'doc';

      var refs = {
        counter: q(node, 'counter'),
        title: q(node, 'title'),
        desc: q(node, 'desc'),
        newtab: q(node, 'newtab'),
        viewer: q(node, 'viewer'),
        frame: q(node, 'frame'),
        fallbackLink: q(node, 'fallback-link'),
        gate: q(node, 'gate'),
        gateText: q(node, 'gate-text'),
        certify: q(node, 'certify'),
        certifySub: q(node, 'certify-sub'),
        back: q(node, 'back'),
        next: q(node, 'next')
      };

      refs.counter.textContent = 'Document ' + (index + 1) + ' of ' + DOCS.length;
      refs.title.textContent = docCfg.title;
      refs.desc.textContent = docCfg.desc || '';
      refs.newtab.href = docCfg.file;
      refs.fallbackLink.href = docCfg.file;
      refs.certifySub.textContent = docCfg.title + (docCfg.version ? ' (' + docCfg.version + ')' : '');

      // Some mobile browsers cannot render a PDF in an iframe — show the link instead.
      if (!canRenderPdfInline()) refs.viewer.classList.add('no-inline');

      var entry = {
        cfg: docCfg, index: index, section: node, refs: refs,
        seconds: 0, timer: null, loaded: false
      };

      refs.certify.addEventListener('change', function () {
        refs.next.disabled = !refs.certify.checked;
        if (refs.certify.checked) {
          state.acks[docCfg.id] = {
            certifiedAt: new Date().toISOString(),
            secondsViewed: Math.round(entry.seconds)
          };
        } else {
          delete state.acks[docCfg.id];
        }
        save();
      });

      refs.back.addEventListener('click', function () { goTo(state.step - 1); });
      refs.next.addEventListener('click', function () {
        if (!refs.certify.checked) return;
        goTo(state.step + 1);
      });

      els.main.insertBefore(node, els.reviewStep);
      docSteps.push(entry);
    });
  }

  function canRenderPdfInline() {
    // navigator.pdfViewerEnabled is the modern signal; fall back to a UA check.
    if (typeof navigator.pdfViewerEnabled === 'boolean') return navigator.pdfViewerEnabled;
    return !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  /* =======================================================================
     READ GATE — unlocks the certify checkbox after MIN_READ_SECONDS
     ===================================================================== */
  var MIN_SECONDS = typeof CFG.MIN_READ_SECONDS === 'number' ? CFG.MIN_READ_SECONDS : 20;

  function startTimer(entry) {
    stopTimer(entry);
    if (entry.refs.certify.checked || entry.seconds >= MIN_SECONDS) { unlockGate(entry); return; }
    updateGate(entry);
    entry.timer = setInterval(function () {
      if (document.visibilityState !== 'visible') return;   // pause on a hidden tab
      entry.seconds += 1;
      if (entry.seconds >= MIN_SECONDS) { unlockGate(entry); } else { updateGate(entry); }
    }, 1000);
  }
  function stopTimer(entry) {
    if (entry.timer) { clearInterval(entry.timer); entry.timer = null; }
  }
  function updateGate(entry) {
    var left = Math.max(0, MIN_SECONDS - Math.floor(entry.seconds));
    entry.refs.gateText.textContent =
      'Please read the document. The confirmation below unlocks in ' + left +
      ' second' + (left === 1 ? '' : 's') + '.';
  }
  function unlockGate(entry) {
    stopTimer(entry);
    entry.refs.gate.classList.add('unlocked');
    entry.refs.gateText.textContent = 'You can now confirm that you have read this document.';
    entry.refs.certify.disabled = false;
  }

  /* =======================================================================
     NAVIGATION
     ===================================================================== */
  function totalSteps() { return DOCS.length + 2; }   // details + docs + review

  function goTo(step) {
    step = Math.max(0, Math.min(step, totalSteps() - 1));

    // Guard: can't skip ahead past an unsigned document.
    for (var i = 0; i < DOCS.length; i++) {
      if (step > i + 1 && !state.acks[DOCS[i].id]) { step = i + 1; break; }
    }
    if (step > 0 && !detailsComplete()) step = 0;

    state.step = step;
    save();
    render();
  }

  function render() {
    // hide everything, then show the active section
    els.detailsStep.hidden = true;
    els.reviewStep.hidden = true;
    els.doneStep.hidden = true;
    docSteps.forEach(function (e) { e.section.hidden = true; stopTimer(e); });

    if (state.step === 0) {
      els.detailsStep.hidden = false;
    } else if (state.step <= DOCS.length) {
      var entry = docSteps[state.step - 1];
      entry.section.hidden = false;
      if (!entry.loaded) {                      // load the PDF only when first shown
        entry.refs.frame.src = entry.cfg.file;
        entry.loaded = true;
      }
      var ack = state.acks[entry.cfg.id];
      if (ack) {
        entry.refs.certify.checked = true;
        entry.refs.certify.disabled = false;
        entry.refs.next.disabled = false;
        unlockGate(entry);
      } else {
        startTimer(entry);
      }
    } else {
      renderReview();
      els.reviewStep.hidden = false;
    }

    updateStepper();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateStepper() {
    var chips = els.stepper.querySelectorAll('[data-chip]');
    Array.prototype.forEach.call(chips, function (chip) {
      var i = +chip.dataset.chip;
      chip.classList.toggle('active', i === state.step);
      chip.classList.toggle('done', i < state.step);
    });
    var active = els.stepper.querySelector('.step-chip.active');
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
  }

  /* =======================================================================
     DETAILS FORM
     ===================================================================== */
  var VALIDATORS = {
    fullName: function (v) {
      if (v.length < 3) return 'Please enter your full name.';
      if (!/[A-Za-z]/.test(v)) return 'Please enter a valid name.';
      return '';
    },
    employeeId: function (v) { return v.length < 2 ? 'Please enter your employee ID.' : ''; },
    email: function (v) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? '' : 'Please enter a valid email address.';
    },
    contact: function (v) {
      var digits = v.replace(/\D/g, '');
      return digits.length < 7 || digits.length > 15
        ? 'Please enter a valid contact number.' : '';
    },
    doj: function (v) {
      if (!v) return 'Please select your date of joining.';
      var d = new Date(v);
      if (isNaN(d)) return 'Please select a valid date.';
      var tomorrow = new Date(); tomorrow.setHours(23, 59, 59, 999);
      if (d > tomorrow) return 'Date of joining cannot be in the future.';
      if (d < new Date(1990, 0, 1)) return 'Please check the date of joining.';
      return '';
    }
  };

  function fieldError(name, value) {
    var fn = VALIDATORS[name];
    return fn ? fn(String(value || '').trim()) : '';
  }

  function showError(name, msg) {
    var input = els.detailsForm.elements[name];
    var slot = els.detailsForm.querySelector('[data-error-for="' + name + '"]');
    if (slot) slot.textContent = msg;
    if (input) input.classList.toggle('invalid', !!msg);
  }

  function readDetails() {
    var f = els.detailsForm;
    return {
      fullName: f.fullName.value.trim(),
      employeeId: f.employeeId.value.trim(),
      email: f.email.value.trim(),
      contact: f.contact.value.trim(),
      doj: f.doj.value,
      department: f.department.value.trim()
    };
  }

  function validateDetails() {
    var d = readDetails(), ok = true;
    Object.keys(VALIDATORS).forEach(function (name) {
      var msg = fieldError(name, d[name]);
      showError(name, msg);
      if (msg) ok = false;
    });
    return ok ? d : null;
  }

  function detailsComplete() {
    var d = state.details;
    if (!d || !d.fullName) return false;
    return Object.keys(VALIDATORS).every(function (n) { return !fieldError(n, d[n]); });
  }

  function fillDetailsForm() {
    var f = els.detailsForm, d = state.details;
    ['fullName', 'employeeId', 'email', 'contact', 'doj', 'department'].forEach(function (n) {
      if (d[n] != null && f.elements[n]) f.elements[n].value = d[n];
    });
  }

  els.detailsForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var d = validateDetails();
    if (!d) {
      var firstBad = els.detailsForm.querySelector('.invalid');
      if (firstBad) firstBad.focus();
      return;
    }
    state.details = d;
    save();
    goTo(1);
  });

  // clear the error as soon as the field becomes valid
  els.detailsForm.addEventListener('input', function (ev) {
    var name = ev.target.name;
    if (VALIDATORS[name] && !fieldError(name, ev.target.value)) showError(name, '');
  });

  /* =======================================================================
     REVIEW
     ===================================================================== */
  function renderReview() {
    var d = state.details;
    els.summary.innerHTML = [
      ['Full name', d.fullName],
      ['Employee ID', d.employeeId],
      ['Email', d.email],
      ['Contact', d.contact],
      ['Date of joining', fmtDate(d.doj)],
      ['Department / Batch', d.department || '—']
    ].map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join('');

    els.docSummary.innerHTML = DOCS.map(function (doc) {
      var ack = state.acks[doc.id] || {};
      return '<li><span class="check">&#10003;</span>' +
             '<span>' + esc(doc.title) +
             (doc.version ? ' <span class="muted small">' + esc(doc.version) + '</span>' : '') +
             '</span>' +
             '<span class="when">' + esc(fmtDateTime(ack.certifiedAt)) + '</span></li>';
    }).join('');
  }

  els.finalDecl.addEventListener('change', function () {
    els.submitBtn.disabled = !els.finalDecl.checked;
  });
  els.reviewBack.addEventListener('click', function () { goTo(state.step - 1); });

  /* =======================================================================
     SUBMIT
     ===================================================================== */
  function buildPayload() {
    return {
      formVersion: 1,
      fullName: state.details.fullName,
      employeeId: state.details.employeeId,
      email: state.details.email,
      contact: state.details.contact,
      dateOfJoining: state.details.doj,
      department: state.details.department || '',
      startedAt: state.startedAt,
      submittedAt: new Date().toISOString(),
      timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone || ''),
      userAgent: navigator.userAgent,
      pageUrl: location.href,
      acknowledgements: DOCS.map(function (doc) {
        var ack = state.acks[doc.id] || {};
        return {
          id: doc.id,
          title: doc.title,
          version: doc.version || '',
          file: doc.file,
          certified: true,
          certifiedAt: ack.certifiedAt || '',
          secondsViewed: ack.secondsViewed || 0
        };
      })
    };
  }

  function postToSheet(payload) {
    // text/plain keeps this a CORS "simple request", so the browser sends no
    // preflight — Apps Script web apps do not answer OPTIONS.
    return fetch(CFG.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    }).then(function (res) {
      return res.text().then(function (text) {
        var data;
        try { data = JSON.parse(text); }
        catch (e) { throw new Error('Unexpected response from the server.'); }
        if (!res.ok || data.status !== 'ok') {
          throw new Error(data.message || 'The server rejected the submission.');
        }
        return data;
      });
    });
  }

  els.submitBtn.addEventListener('click', function () {
    if (!els.finalDecl.checked) return;

    if (!CFG.ENDPOINT || CFG.ENDPOINT.indexOf('PASTE_YOUR') === 0) {
      setStatus('Setup incomplete: the Apps Script URL has not been set in assets/js/config.js.', 'err');
      return;
    }

    var payload = buildPayload();
    els.submitBtn.disabled = true;
    els.reviewBack.disabled = true;
    els.submitBtn.textContent = 'Submitting…';
    setStatus('Recording your acknowledgement…', '');

    postToSheet(payload)
      .then(function (data) {
        clearSaved();
        showDone(payload, data);
      })
      .catch(function (err) {
        setStatus(
          'Could not submit: ' + err.message +
          ' Please check your connection and try again. If this keeps happening, ' +
          'take a screenshot of this page and contact HR.', 'err');
        els.submitBtn.disabled = false;
        els.reviewBack.disabled = false;
        els.submitBtn.textContent = 'Try submitting again';
      });
  });

  function setStatus(msg, kind) {
    els.submitStatus.textContent = msg;
    els.submitStatus.className = 'submit-status' + (kind ? ' ' + kind : '');
  }

  /* =======================================================================
     DONE
     ===================================================================== */
  function showDone(payload, data) {
    els.detailsStep.hidden = true;
    els.reviewStep.hidden = true;
    docSteps.forEach(function (e) { e.section.hidden = true; stopTimer(e); });
    els.doneStep.hidden = false;

    els.doneMsg.textContent =
      'Thank you, ' + payload.fullName.split(' ')[0] + '. Your sign-off for all ' +
      DOCS.length + ' documents has been logged with ' + (CFG.COMPANY || 'the company') + '.';

    var rows = [
      ['Reference', '<span class="ref">' + esc(data.reference || '—') + '</span>'],
      ['Name', esc(payload.fullName)],
      ['Employee ID', esc(payload.employeeId)],
      ['Email', esc(payload.email)],
      ['Submitted', esc(fmtDateTime(payload.submittedAt))]
    ].concat(payload.acknowledgements.map(function (a) {
      return ['Acknowledged', esc(a.title) + (a.version ? ' (' + esc(a.version) + ')' : '')];
    }));

    els.receipt.innerHTML = rows.map(function (r) {
      return '<div class="row"><span>' + r[0] + '</span><span>' + r[1] + '</span></div>';
    }).join('');

    els.stepper.querySelectorAll('[data-chip]').forEach(function (c) {
      c.classList.add('done'); c.classList.remove('active');
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  els.printBtn.addEventListener('click', function () { window.print(); });
  els.restartBtn.addEventListener('click', function () {
    clearSaved();
    location.reload();
  });

  /* =======================================================================
     INIT
     ===================================================================== */
  document.getElementById('year').textContent = new Date().getFullYear();

  if (!DOCS.length) {
    els.main.innerHTML = '<div class="card"><h2>No documents configured</h2>' +
      '<p class="muted">Add entries to <code>DOCUMENTS</code> in assets/js/config.js.</p></div>';
    return;
  }

  buildStepper();
  buildDocSteps();
  load();
  fillDetailsForm();

  // Restore any previously certified documents.
  docSteps.forEach(function (e) {
    if (state.acks[e.cfg.id]) {
      e.seconds = state.acks[e.cfg.id].secondsViewed || MIN_SECONDS;
      e.refs.certify.checked = true;
      e.refs.certify.disabled = false;
      e.refs.next.disabled = false;
    }
  });

  // Date of joining can never be in the future.
  els.detailsForm.doj.max = new Date().toISOString().slice(0, 10);

  goTo(state.step);

  // Warn before leaving with work in progress.
  window.addEventListener('beforeunload', function (ev) {
    if (els.doneStep.hidden === false) return;
    if (state.step === 0 && !state.details.fullName) return;
    ev.preventDefault();
    ev.returnValue = '';
  });
})();
