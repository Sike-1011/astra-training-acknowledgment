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
    printBtn: document.getElementById('print-btn')
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
        viewer: q(node, 'viewer'),
        scroll: q(node, 'scroll'),
        pages: q(node, 'pages'),
        status: q(node, 'status'),
        statusText: q(node, 'status-text'),
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
      refs.certifySub.textContent = docCfg.title + (docCfg.version ? ' (' + docCfg.version + ')' : '');

      var entry = {
        cfg: docCfg, index: index, section: node, refs: refs,
        seconds: 0, timer: null, loaded: false,
        reachedEnd: false, failed: false, pdf: null
      };

      // Pages are canvases we own, so right-click can be taken away here —
      // unlike an embedded PDF viewer, which handles its own menu.
      refs.pages.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
      refs.scroll.addEventListener('scroll', function () { checkScrolledToEnd(entry); });

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

  /* =======================================================================
     PDF RENDERING (pdf.js)

     Every page is drawn onto a canvas we control, instead of handing the file
     to the browser's built-in PDF viewer in an iframe. That buys three things:
     it works on phones, where inline PDFs mostly don't; there is no viewer
     toolbar with download and print buttons; and right-click yields a picture
     of a page rather than the document.

     What it does NOT do is hide the file. pdf.js still has to fetch the PDF
     over the network to draw it, so it remains visible in the browser's
     developer tools and at its own URL. This raises the bar; it is not a lock.
     ===================================================================== */

  var PDFJS = window.pdfjsLib;
  if (PDFJS) {
    PDFJS.GlobalWorkerOptions.workerSrc = 'assets/vendor/pdfjs/pdf.worker.min.js';
  }

  // Cap the pixel ratio: 3x on a phone triples memory for no visible gain.
  var PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 2);

  function renderDocument(entry) {
    if (!PDFJS) {
      showViewerError(entry, 'The document viewer failed to load. Please refresh the page.');
      return;
    }

    setViewerStatus(entry, 'Loading document…', true);

    var task = PDFJS.getDocument({
      url: entry.cfg.file,
      // Needed only when a PDF relies on the standard 14 fonts without
      // embedding them. The current SOPs embed their fonts, but a replacement
      // exported from another tool might not, and the failure is silent.
      standardFontDataUrl: 'assets/vendor/pdfjs/standard_fonts/'
    });

    task.promise.then(function (pdf) {
      entry.pdf = pdf;
      var width = Math.max(entry.refs.scroll.clientWidth - 24, 320);
      var chain = Promise.resolve();

      for (var n = 1; n <= pdf.numPages; n++) {
        chain = chain.then(renderPage.bind(null, entry, pdf, n, width));
      }

      return chain.then(function () {
        setViewerStatus(entry, '', false);
        entry.refs.viewer.classList.add('loaded');
        // A document short enough not to scroll is already "read to the end".
        checkScrolledToEnd(entry);
      });
    }).catch(function (err) {
      showViewerError(entry,
        'This document could not be displayed. Please refresh the page, and ' +
        'contact HR if it keeps happening.');
      console.error('[SOP form] Failed to render ' + entry.cfg.file, err);
    });
  }

  function renderPage(entry, pdf, pageNo, width) {
    return pdf.getPage(pageNo).then(function (page) {
      var unscaled = page.getViewport({ scale: 1 });
      var viewport = page.getViewport({ scale: width / unscaled.width });

      var canvas = document.createElement('canvas');
      canvas.className = 'pdf-page';
      canvas.width = Math.floor(viewport.width * PIXEL_RATIO);
      canvas.height = Math.floor(viewport.height * PIXEL_RATIO);
      canvas.style.width = '100%';
      canvas.setAttribute('aria-label', 'Page ' + pageNo + ' of ' + pdf.numPages);

      var wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.appendChild(canvas);

      var label = document.createElement('div');
      label.className = 'pdf-page-label';
      label.textContent = 'Page ' + pageNo + ' of ' + pdf.numPages;
      wrap.appendChild(label);

      entry.refs.pages.appendChild(wrap);
      setViewerStatus(entry, 'Loading document… page ' + pageNo + ' of ' + pdf.numPages, true);

      return page.render({
        canvasContext: canvas.getContext('2d'),
        viewport: viewport,
        transform: PIXEL_RATIO !== 1 ? [PIXEL_RATIO, 0, 0, PIXEL_RATIO, 0, 0] : null
      }).promise;
    });
  }

  function setViewerStatus(entry, text, busy) {
    entry.refs.statusText.textContent = text;
    entry.refs.status.hidden = !text;
    entry.refs.status.classList.toggle('is-error', !busy && !!text);
  }

  /**
   * Deliberately leaves the certify checkbox locked. Letting someone sign off a
   * document that failed to display would put a false acknowledgement into the
   * record, which is worse than making them retry — and a document that won't
   * load is a site problem affecting everyone, so it should surface loudly.
   */
  function showViewerError(entry, message) {
    entry.failed = true;              // sticky: nothing may unlock this step now
    setViewerStatus(entry, message, false);
    entry.refs.viewer.classList.add('has-error');
    stopTimer(entry);
    entry.refs.certify.checked = false;
    entry.refs.certify.disabled = true;
    entry.refs.next.disabled = true;
    entry.refs.gate.classList.remove('unlocked');
    entry.refs.gateText.textContent =
      'This document must be displayed before you can confirm you have read it.';
  }

  /* =======================================================================
     READ GATE

     The "I certify" checkbox unlocks once BOTH conditions are met:
       - the document has been open for MIN_READ_SECONDS (paused while the
         tab is hidden), and
       - the reader has scrolled to the last page (skipped when the document
         fits on screen without scrolling, or when REQUIRE_SCROLL_TO_END is off).
     ===================================================================== */
  var MIN_SECONDS = typeof CFG.MIN_READ_SECONDS === 'number' ? CFG.MIN_READ_SECONDS : 20;
  var REQUIRE_SCROLL = CFG.REQUIRE_SCROLL_TO_END !== false;
  var SCROLL_TOLERANCE = 24;   // px of slack, for fractional zoom levels

  function startTimer(entry) {
    stopTimer(entry);
    if (entry.failed) return;
    if (entry.refs.certify.checked) { unlockGate(entry); return; }
    refreshGate(entry);
    if (entry.seconds >= MIN_SECONDS) return;
    entry.timer = setInterval(function () {
      if (document.visibilityState !== 'visible') return;   // pause on a hidden tab
      entry.seconds += 1;
      refreshGate(entry);
      if (entry.seconds >= MIN_SECONDS) stopTimer(entry);
    }, 1000);
  }

  function stopTimer(entry) {
    if (entry.timer) { clearInterval(entry.timer); entry.timer = null; }
  }

  function checkScrolledToEnd(entry) {
    if (entry.failed || entry.reachedEnd) return;
    var el = entry.refs.scroll;
    var atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_TOLERANCE;
    if (atEnd) {
      entry.reachedEnd = true;
      refreshGate(entry);
    }
  }

  /** Recomputes the gate message and unlocks when both conditions are met. */
  function refreshGate(entry) {
    if (entry.failed) return;
    var timeLeft = Math.max(0, MIN_SECONDS - Math.floor(entry.seconds));
    var scrollDone = !REQUIRE_SCROLL || entry.reachedEnd;

    if (timeLeft <= 0 && scrollDone) { unlockGate(entry); return; }

    if (timeLeft > 0) {
      entry.refs.gateText.textContent =
        'Please read the document. The confirmation below unlocks in ' + timeLeft +
        ' second' + (timeLeft === 1 ? '' : 's') + '.';
    } else {
      entry.refs.gateText.textContent =
        'Scroll to the end of the document to confirm you have read it.';
    }
  }

  function unlockGate(entry) {
    if (entry.failed) return;
    stopTimer(entry);
    entry.reachedEnd = true;
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
      if (!entry.loaded) {                      // render the PDF only when first shown
        entry.loaded = true;
        renderDocument(entry);
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
  var NA_VALUE = 'N/A';
  function isNA(v) { return /^n\s*\/?\s*a$/i.test(String(v || '').trim()); }

  var VALIDATORS = {
    fullName: function (v) {
      if (v.length < 3) return 'Please enter your full name.';
      if (!/[A-Za-z]/.test(v)) return 'Please enter a valid name.';
      return '';
    },
    employeeId: function (v) {
      if (!v) return 'Enter your 5-digit employee ID, or tick "N/A".';
      if (isNA(v)) return '';
      if (!/^\d{5}$/.test(v)) return 'Employee ID must be exactly 5 digits (e.g. 16632), or tick "N/A".';
      return '';
    },
    email: function (v) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? '' : 'Please enter a valid email address.';
    },
    contact: function (v) {
      var digits = v.replace(/\D/g, '');
      if (digits.length !== 10) return 'Contact number must be exactly 10 digits.';
      return '';
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
    var empId = f.employeeIdNa.checked ? NA_VALUE : f.employeeId.value.trim();
    return {
      fullName: f.fullName.value.trim(),
      employeeId: isNA(empId) ? NA_VALUE : empId,
      email: f.email.value.trim(),
      contact: f.contact.value.trim(),
      doj: f.doj.value
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
    ['fullName', 'employeeId', 'email', 'contact', 'doj'].forEach(function (n) {
      if (d[n] != null && f.elements[n]) f.elements[n].value = d[n];
    });
    if (isNA(d.employeeId)) f.employeeIdNa.checked = true;
    applyNaToggle();
  }

  /* Ticking "N/A" fills the box with N/A and locks it. */
  function applyNaToggle() {
    var f = els.detailsForm, on = f.employeeIdNa.checked;
    f.employeeId.disabled = on;
    f.employeeId.required = !on;
    if (on) {
      f.employeeId.dataset.previous = isNA(f.employeeId.value) ? '' : f.employeeId.value;
      f.employeeId.value = NA_VALUE;
      showError('employeeId', '');
    } else if (isNA(f.employeeId.value)) {
      f.employeeId.value = f.employeeId.dataset.previous || '';
    }
  }

  els.detailsForm.employeeIdNa.addEventListener('change', function () {
    applyNaToggle();
    if (!els.detailsForm.employeeIdNa.checked) els.detailsForm.employeeId.focus();
  });

  /* Keep the numeric fields numeric, whatever gets typed or pasted. */
  function mask(input, maxLen, opts) {
    opts = opts || {};
    input.addEventListener('input', function () {
      // Someone typing "N/A" by hand is fine — leave those keystrokes alone.
      if (opts.allowNA && /^[nN]/.test(input.value)) return;
      var digits = input.value.replace(/\D/g, '');
      // Pasting "+91 98765 43210" or "098765 43210" should keep the right 10
      // digits, not blindly truncate to the first ten.
      if (opts.stripDialPrefix) {
        if (digits.length === 12 && digits.indexOf('91') === 0) digits = digits.slice(2);
        else if (digits.length === 11 && digits.charAt(0) === '0') digits = digits.slice(1);
      }
      digits = digits.slice(0, maxLen);
      if (digits !== input.value) input.value = digits;
    });
  }
  mask(els.detailsForm.employeeId, 5, { allowNA: true });
  mask(els.detailsForm.contact, 10, { stripDialPrefix: true });

  // A hand-typed "n/a" becomes the tickbox state, so the two stay in step.
  els.detailsForm.employeeId.addEventListener('blur', function () {
    if (isNA(els.detailsForm.employeeId.value)) {
      els.detailsForm.employeeIdNa.checked = true;
      applyNaToggle();
    }
  });

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
      ['Date of joining', fmtDate(d.doj)]
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
          link: doc.link || '',
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
        // A TypeError here means the request never got a readable response —
        // no connection, or the endpoint answered without CORS headers (which
        // is what an Apps Script error page or a login redirect looks like).
        var unreachable = (err instanceof TypeError) ||
          /failed to fetch|networkerror|load failed/i.test(err.message || '');

        if (unreachable) {
          setStatus('Could not reach the server. Please check your internet connection ' +
                    'and try again. If this keeps happening, take a screenshot of this ' +
                    'page and contact HR.', 'err');
          // Aimed at whoever set this up, not the person filling the form.
          console.error(
            '[SOP form] The submission never reached ' + CFG.ENDPOINT + '\n' +
            'Check, in order:\n' +
            '  1. Open that URL in a browser tab. It must return JSON starting {"status":"ok"...}.\n' +
            '     - "ReferenceError: window is not defined" means the Apps Script project has a\n' +
            '       browser file pasted into it. It needs apps-script/Code.gs, nothing else.\n' +
            '     - A Google sign-in page means the deployment\'s "Who has access" is not "Anyone".\n' +
            '  2. After any edit to Code.gs, publish a NEW deployment version.', err);
        } else {
          setStatus('Could not submit: ' + err.message +
                    ' Please try again, or contact HR with a screenshot of this page.', 'err');
        }
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

    // Take the documents out of the page entirely once the sign-off is in.
    // They have served their purpose, and nothing left in the DOM can then end
    // up in a printed receipt or keep a PDF loaded in the background.
    docSteps.forEach(function (e) {
      stopTimer(e);
      e.refs.pages.innerHTML = '';
      if (e.pdf) { try { e.pdf.destroy(); } catch (err) { /* already gone */ } e.pdf = null; }
      if (e.section.parentNode) e.section.parentNode.removeChild(e.section);
    });

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
