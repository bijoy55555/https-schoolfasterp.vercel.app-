/*!
 * lang-toggle.js — School ERP বাংলা/English টগল ইঞ্জিন
 * ---------------------------------------------------------
 * এই একটা ফাইল সব পেজে (index.html, app.html, student.html, parent.html) যোগ করা আছে।
 * কাজ করে যেভাবে:
 *  ১) DICT অবজেক্টে বাংলা টেক্সট -> ইংরেজি অনুবাদ রাখা আছে।
 *  ২) পেজ লোড হলে localStorage থেকে আগের পছন্দের ভাষা পড়ে সেটা বসিয়ে দেয় (তাই একবার
 *     ইংরেজি সিলেক্ট করলে অন্য পেজে গেলেও ইংরেজিই থাকবে — সব পেজ একই সাইটের অংশ)।
 *  ৩) DOM-এর প্রতিটা টেক্সট নোড এবং কিছু গুরুত্বপূর্ণ attribute (placeholder, title,
 *     aria-label, alt) ঘুরে দেখে, DICT-এ মিল পেলে বদলে দেয়।
 *  ৪) app.html/student.html/parent.html-এর পেজগুলো JavaScript দিয়ে ডাইনামিকভাবে তৈরি
 *     হয় (innerHTML দিয়ে), তাই একটা MutationObserver বসানো আছে যেটা নতুন করে
 *     যোগ হওয়া কনটেন্টও স্বয়ংক্রিয়ভাবে অনুবাদ করে দেয়।
 *  ৫) মূল টেক্সট কোথাও হারায় না — একটা WeakMap-এ মূল বাংলা টেক্সট জমা থাকে, তাই
 *     আবার বাংলায় ফিরে গেলে হুবহু আগের মতোই দেখাবে।
 *
 * নতুন শব্দ/বাক্য অনুবাদ যোগ করতে চাইলে শুধু নিচের DICT অবজেক্টে একটা লাইন যোগ করুন:
 *   "বাংলা টেক্সট": "English text",
 */
(function () {
  "use strict";

  var LANG_KEY = "erp_lang"; // 'bn' | 'en'
  var ATTRS = ["placeholder", "title", "aria-label", "alt"];

  // ============================================================
  // DICTIONARY — বাংলা -> ইংরেজি
  // (এখানে translations-data.js থেকে আসা বড় ডিকশনারিটা মার্জ হবে)
  // ============================================================
  var DICT = (window.ERP_I18N_DICT || {});

  // ছোট, খুবই কমন কিছু এন্ট্রি (fallback), মূল ডিকশনারি লোড না হলেও যেন কাজ করে
  var BASE_DICT = {
    "ড্যাশবোর্ড": "Dashboard",
    "লগইন": "Login",
    "লগআউট": "Logout",
    "🔓 লগআউট": "🔓 Logout"
  };
  for (var k in BASE_DICT) { if (!(k in DICT)) DICT[k] = BASE_DICT[k]; }

  // ============================================================
  // STATE
  // ============================================================
  var origText = new WeakMap();   // textNode -> original string
  var origAttr = new WeakMap();   // element -> { attr: originalValue }
  var currentLang = localStorage.getItem(LANG_KEY) || "bn";
  var observer = null;
  var pendingNodes = [];
  var scheduled = false;

  function lookup(str) {
    if (!str) return null;
    var t = str.trim();
    if (!t) return null;
    if (Object.prototype.hasOwnProperty.call(DICT, t)) return DICT[t];
    return null;
  }

  function translateTextNode(node) {
    if (!origText.has(node)) origText.set(node, node.nodeValue);
    var original = origText.get(node);
    if (currentLang === "en") {
      var tr = lookup(original);
      if (tr) {
        var lead = original.match(/^\s*/)[0];
        var trail = original.match(/\s*$/)[0];
        node.nodeValue = lead + tr + trail;
      }
      // মিল না পেলে বাংলাই থাকবে (গ্রেসফুল ফলব্যাক)
    } else {
      node.nodeValue = original;
    }
  }

  function translateElementAttrs(el) {
    var store = origAttr.get(el);
    if (!store) { store = {}; origAttr.set(el, store); }
    for (var i = 0; i < ATTRS.length; i++) {
      var attr = ATTRS[i];
      if (!el.hasAttribute(attr)) continue;
      if (!(attr in store)) store[attr] = el.getAttribute(attr);
      var original = store[attr];
      if (currentLang === "en") {
        var tr = lookup(original);
        if (tr) el.setAttribute(attr, tr);
      } else {
        el.setAttribute(attr, original);
      }
    }
  }

  function shouldSkip(parentTag) {
    return parentTag === "SCRIPT" || parentTag === "STYLE" || parentTag === "NOSCRIPT";
  }

  function walkTextNodes(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = node.parentElement;
        if (!p || shouldSkip(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest(".lang-toggle-btn")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = walker.nextNode())) translateTextNode(n);
  }

  function walkAttrs(root) {
    if (root.nodeType !== 1) return;
    if (root.matches && ATTRS.some(function (a) { return root.hasAttribute && root.hasAttribute(a); })) {
      translateElementAttrs(root);
    }
    var all = root.querySelectorAll ? root.querySelectorAll("[placeholder],[title],[aria-label],[alt]") : [];
    for (var i = 0; i < all.length; i++) translateElementAttrs(all[i]);
  }

  function applyToRoot(root) {
    walkTextNodes(root);
    walkAttrs(root);
  }

  function applyLanguage(lang) {
    currentLang = lang;
    localStorage.setItem(LANG_KEY, lang);
    document.documentElement.setAttribute("lang", lang === "en" ? "en" : "bn");
    applyToRoot(document.body);
    updateButtons();
    document.dispatchEvent(new CustomEvent("erp-lang-changed", { detail: { lang: lang } }));
  }

  // ============================================================
  // MUTATION OBSERVER — অ্যাপ ডাইনামিকভাবে নতুন কনটেন্ট বসালে সেটাও অনুবাদ করা
  // ============================================================
  function scheduleFlush() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(flushPending, 60);
  }

  function flushPending() {
    scheduled = false;
    var nodes = pendingNodes;
    pendingNodes = [];
    nodes.forEach(function (node) {
      if (!node || !node.isConnected) return;
      if (node.nodeType === 1) applyToRoot(node);
      else if (node.nodeType === 3) {
        var p = node.parentElement;
        if (p && !shouldSkip(p.tagName)) translateTextNode(node);
      }
    });
  }

  function startObserver() {
    observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === "childList") {
          m.addedNodes.forEach(function (n) { pendingNodes.push(n); });
        } else if (m.type === "characterData") {
          pendingNodes.push(m.target);
        }
      }
      if (pendingNodes.length) scheduleFlush();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ============================================================
  // TOGGLE বাটন UI
  // ============================================================
  var STYLE = "" +
    ".lang-toggle-btn{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.08);" +
    "border:1.5px solid rgba(255,255,255,.35);color:inherit;border-radius:100px;padding:6px 12px;" +
    "font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;line-height:1;white-space:nowrap;" +
    "transition:background .15s ease;}" +
    ".lang-toggle-btn:hover{background:rgba(255,255,255,.18);}" +
    ".lang-toggle-btn .lt-opt{padding:2px 6px;border-radius:100px;opacity:.55;}" +
    ".lang-toggle-btn .lt-opt.active{opacity:1;background:rgba(255,255,255,.25);}" +
    ".lang-toggle-btn.on-light{color:#1B2430;border-color:rgba(27,36,48,.25);background:rgba(27,36,48,.04);}" +
    ".lang-toggle-btn.on-light:hover{background:rgba(27,36,48,.09);}" +
    ".lang-toggle-btn.on-light .lt-opt.active{background:rgba(27,36,48,.12);}";

  function injectStyle() {
    if (document.getElementById("lang-toggle-style")) return;
    var s = document.createElement("style");
    s.id = "lang-toggle-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function buildButton(lightMode) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lang-toggle-btn" + (lightMode ? " on-light" : "");
    btn.setAttribute("data-lang-toggle-btn", "1");
    btn.title = "ভাষা পরিবর্তন করুন / Change language";
    btn.innerHTML =
      '<span class="lt-opt lt-bn">বাং</span><span aria-hidden="true">|</span><span class="lt-opt lt-en">EN</span>';
    btn.addEventListener("click", function () {
      applyLanguage(currentLang === "bn" ? "en" : "bn");
    });
    return btn;
  }

  function updateButtons() {
    var btns = document.querySelectorAll("[data-lang-toggle-btn]");
    btns.forEach(function (btn) {
      var bn = btn.querySelector(".lt-bn");
      var en = btn.querySelector(".lt-en");
      if (bn) bn.classList.toggle("active", currentLang === "bn");
      if (en) en.classList.toggle("active", currentLang === "en");
    });
  }

  function mountButtons() {
    injectStyle();
    // যেকোনো এলিমেন্ট যার id="lang-toggle-slot" আছে, সেখানে বাটন বসবে (একাধিক হতে পারে)
    var slots = document.querySelectorAll("[data-lang-toggle-slot]");
    slots.forEach(function (slot) {
      if (slot.querySelector("[data-lang-toggle-btn]")) return;
      var light = slot.getAttribute("data-lang-toggle-slot") === "light";
      slot.appendChild(buildButton(light));
    });
  }

  // ============================================================
  // INIT
  // ============================================================
  function init() {
    mountButtons();
    applyLanguage(currentLang);
    startObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // পাবলিক API (ডিবাগ/কাস্টম ব্যবহারের জন্য)
  window.ERP_I18N = {
    getLang: function () { return currentLang; },
    setLang: applyLanguage,
    dict: DICT
  };
})();
