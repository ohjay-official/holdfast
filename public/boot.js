// Runs before the page's module script. Kept as a file so the site's CSP can forbid inline scripts.
(function () {
  var root = document.documentElement;
  window.addEventListener('error', function () { root.classList.add('revealed'); });
  setTimeout(function () { root.classList.add('revealed'); }, 2500);
  // Judge banner "More / Less" toggle.
  document.addEventListener('click', function (e) {
    var t = e.target;
    var btn = t && t.closest ? t.closest('.judge-more') : null;
    if (!btn) return;
    var bar = btn.closest('.judge-bar');
    var open = bar.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'Less' : 'Before and after';
  });
  // Copy button in the judge banner on the apps (the marketing pages handle it in their own script).
  document.addEventListener('DOMContentLoaded', function () {
    if (!document.getElementById('app')) return;
    var btn = document.querySelector('.judge-bar button[data-copy]');
    if (!btn) return;
    var label = btn.textContent || 'Copy';
    btn.addEventListener('click', function () {
      var src = document.querySelector(btn.getAttribute('data-copy'));
      var text = ((src && src.textContent) || '').trim();
      var done = function (t) { btn.textContent = t; setTimeout(function () { btn.textContent = label; }, 2200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done('Copied'); }, function () { select(); });
      } else select();
      function select() {
        if (src) { var r = document.createRange(); r.selectNodeContents(src); var sel = getSelection(); if (sel) { sel.removeAllRanges(); sel.addRange(r); } }
        done('Selected, copy it');
      }
    });
  });
})();
