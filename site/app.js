// Scout showcase: builds the iPhone story from the chapter list in index.html and scrubs it with the scroll.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = matchMedia("(pointer: fine)");
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const ease = (t) => 1 - Math.pow(1 - t, 3);

  const MASCOT = $(".peek .mascot").outerHTML;
  const ICON = {
    signal: '<svg viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>',
    wifi: '<svg viewBox="0 0 16 12"><path d="M8 2.4c2.4 0 4.6.9 6.3 2.5l1.3-1.4A11 11 0 0 0 8 .5 11 11 0 0 0 .4 3.5l1.3 1.4A9 9 0 0 1 8 2.4zm0 3.6c1.4 0 2.7.5 3.7 1.4l1.3-1.4A7.2 7.2 0 0 0 8 4.1C6.1 4.1 4.3 4.8 3 6l1.3 1.4C5.3 6.5 6.6 6 8 6zm0 3.6c-.6 0-1.2.2-1.6.6L8 11.9l1.6-1.7c-.4-.4-1-.6-1.6-.6z"/></svg>',
    battery: '<svg class="bat" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.6" fill="none" stroke="currentColor" opacity=".38"/><rect x="2" y="2" width="17" height="9" rx="2.2"/><path d="M25 4.4v4.2c.8-.3 1.4-1.1 1.4-2.1s-.6-1.8-1.4-2.1z" opacity=".45"/></svg>',
    chevron: '<svg viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    video: '<svg viewBox="0 0 28 18"><rect x="1" y="1.5" width="18" height="15" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 7.4 26.2 3.8v10.4L20 10.6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    mic: '<svg viewBox="0 0 14 20"><rect x="4" y="1" width="6" height="11" rx="3" fill="currentColor"/><path d="M1.5 9a5.5 5.5 0 0 0 11 0M7 14.5V19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    flash: '<svg viewBox="0 0 16 24"><path d="M3 1h10v4l-2 4v13H5V9L3 5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="8" cy="13" r="1.5" fill="currentColor"/></svg>',
    camera: '<svg viewBox="0 0 24 20"><path d="M2 6.5A2.5 2.5 0 0 1 4.5 4H7l2-2.5h6L17 4h2.5A2.5 2.5 0 0 1 22 6.5v9a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 15.5z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="11" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  };

  function fmt(minutes) {
    const m = Math.floor(minutes) % (24 * 60);
    const h24 = Math.floor(m / 60);
    const h = h24 % 12 || 12;
    return { hm: `${h}:${String(m % 60).padStart(2, "0")}`, ap: h24 < 12 ? "AM" : "PM" };
  }

  // ───────────── Phone shell ─────────────
  function buildPhone(slot) {
    const phone = document.createElement("div");
    phone.className = "iphone";
    phone.setAttribute("aria-hidden", "true");
    phone.innerHTML = `
      <span class="hw hw-action"></span><span class="hw hw-vol-up"></span><span class="hw hw-vol-down"></span><span class="hw hw-power"></span>
      <div class="body"><div class="bezel"><div class="screen">
        <div class="app">
          <div class="thread"><div class="thread-inner"></div></div>
          <div class="app-head">
            <span class="ah-back">${ICON.chevron}<span>3</span></span>
            <span class="ah-who"><span class="ah-avatar">${MASCOT}</span><span class="ah-name">Scout</span></span>
            <span class="ah-video">${ICON.video}</span>
          </div>
          <div class="composer"><span class="c-plus">${ICON.plus}</span><span class="c-field">iMessage ${ICON.mic}</span></div>
        </div>
        <div class="lock">
          <div class="wall"></div><div class="wall-dim"></div>
          <div class="lock-date"><span class="lock-focus">☾ Sleep</span><span>Wednesday, September 30</span></div>
          <div class="lock-time">8:00</div>
          <div class="notifs"></div>
          <div class="lock-btns"><span>${ICON.flash}</span><span>${ICON.camera}</span></div>
        </div>
        <div class="confetti"></div>
        <div class="statusbar"><span class="sb-time">8:00</span><span class="sb-icons">${ICON.signal}${ICON.wifi}${ICON.battery}</span></div>
        <div class="island"><div class="island-act"><span class="ia-icon">${MASCOT}</span><span class="ia-text"></span><span class="ia-spin"></span></div></div>
        <div class="home-bar"></div>
      </div></div></div>`;
    slot.prepend(phone);
    return phone;
  }

  // Turns a transcript (.m elements) into iMessage rows. Returns the rows/steps for the timeline.
  function buildThread(phone, items) {
    const inner = $(".thread-inner", phone);
    const steps = [];
    let prevSide = null; // side of the previous real bubble (typing indicators don't count)
    let lastBubbleRow = null;
    for (const m of items) {
      const kind = m.classList.contains("stamp") ? "stamp"
        : m.classList.contains("tapback") ? "tapback"
        : m.classList.contains("typing") ? "typing"
        : m.classList.contains("link") ? "link"
        : m.classList.contains("out") ? "out" : "in";
      if (kind === "tapback") {
        if (!lastBubbleRow) continue;
        const badge = document.createElement("span");
        badge.className = "tapback";
        badge.textContent = m.dataset.emoji || "❤️";
        $(".bubble", lastBubbleRow).append(badge);
        lastBubbleRow.classList.add("has-tap");
        steps.push({ kind, el: badge, src: m });
        continue;
      }
      const row = document.createElement("div");
      if (kind === "stamp") {
        row.className = "row stamp";
        row.innerHTML = m.innerHTML;
        prevSide = null;
        steps.push({ kind, el: row, src: m });
        inner.append(row);
        continue;
      }
      const side = kind === "out" ? "out" : "in";
      row.className = `row ${side}`;
      if (prevSide && prevSide !== side) row.classList.add("gap");
      if (kind === "typing") {
        row.classList.add("typing", "tail");
        row.innerHTML = '<div class="bubble"><i></i><i></i><i></i></div>';
      } else if (kind === "link") {
        const cal = (m.dataset.domain || "").startsWith("calendar.");
        row.innerHTML = `<div class="bubble card"><div class="card-img${cal ? " cal" : ""}">${m.dataset.icon || "🔗"}</div><div class="card-meta"><b>${m.innerHTML}</b><small>${m.dataset.domain || ""}</small></div></div>`;
      } else {
        row.innerHTML = `<div class="bubble"><span class="txt">${m.innerHTML}</span></div>`;
      }
      if (kind !== "typing") { lastBubbleRow = row; prevSide = side; }
      inner.append(row);
      steps.push({ kind, el: row, side, src: m, island: m.dataset.island, confetti: m.hasAttribute("data-confetti") });
    }
    // Tails go on the last bubble of each same-side group (typing indicators always have one).
    steps.forEach((s, i) => {
      if (!s.side || s.kind === "typing") return;
      let j = i + 1;
      while (steps[j]?.kind === "tapback") j++;
      const next = steps[j];
      if (!next || next.side !== s.side || next.kind === "typing") s.el.classList.add("tail");
    });
    return steps;
  }

  // Keeps the newest message just above the composer, like a real thread.
  function settleThread(phone) {
    const thread = $(".thread", phone);
    const inner = $(".thread-inner", phone);
    const cs = getComputedStyle(thread);
    const view = thread.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const offset = Math.max(0, inner.scrollHeight - view);
    inner.style.transform = `translateY(${-offset}px)`;
  }

  function placeDelivered(phone) {
    const inner = $(".thread-inner", phone);
    let tag = $(".row.delivered", inner);
    const shown = $$(".row.on:not(.delivered)", inner);
    const last = shown[shown.length - 1];
    if (last && last.classList.contains("out")) {
      if (!tag) { tag = document.createElement("div"); tag.className = "row delivered"; tag.textContent = "Delivered"; }
      last.after(tag);
      tag.classList.add("on");
    } else if (tag) tag.classList.remove("on");
  }

  // ───────────── Static phone (onboarding) ─────────────
  for (const slot of $$('[data-phone="static"]')) {
    const phone = buildPhone(slot);
    phone.classList.add("unlocked");
    $(".sb-time", phone).textContent = slot.dataset.time || "9:41";
    buildThread(phone, $$(".transcript .m", slot)).forEach((s) => s.el.classList.add("on"));
    placeDelivered(phone);
    requestAnimationFrame(() => settleThread(phone));
    addEventListener("resize", () => settleThread(phone));
    document.fonts?.ready.then(() => settleThread(phone));
  }

  // ───────────── The story ─────────────
  const story = $("#story");
  const slot = $('[data-phone="story"]');
  const chapters = $$(".story-list .chapter");
  const N = chapters.length;
  story.style.setProperty("--chapters", N);
  const phone = buildPhone(slot);
  const times = chapters.map((c) => Number(c.dataset.time));
  const tStart = times[0];
  const tEnd = times[N - 1];

  // Lock-screen notifications from chapter 0.
  const notifs = $(".notifs", phone);
  for (const n of $$(".transcript .m.notif", chapters[0])) {
    const el = document.createElement("div");
    el.className = "notif";
    el.innerHTML = `<span class="n-icon">${MASCOT}</span><span class="n-body"><span class="n-top"><b>Scout</b><span>now</span></span><span class="n-text">${n.innerHTML}</span></span>`;
    notifs.append(el);
  }
  $$(".notif", notifs).forEach((el, i) => {
    if (reduceMotion.matches) el.classList.add("in");
    else setTimeout(() => el.classList.add("in"), 900 + i * 750);
  });

  // Thread: every chapter after the first adds to the same conversation. Steps get a position in chapter units.
  const timeline = [];
  chapters.forEach((ch, c) => {
    if (c === 0) return;
    const steps = buildThread(phone, $$(".transcript .m:not(.notif)", ch));
    const timed = steps.filter((s) => s.kind !== "stamp");
    timed.forEach((s, k) => { s.at = c + 0.06 + 0.58 * (timed.length > 1 ? k / (timed.length - 1) : 0); });
    steps.forEach((s, k) => { if (s.kind === "stamp") s.at = (timed[0]?.at ?? c + 0.06) - 0.001; });
    timeline.push(...steps);
  });
  // A typing indicator (and the island's live activity) lasts until the next step.
  timeline.forEach((s, i) => {
    const next = timeline.slice(i + 1).find((n) => n.kind !== "stamp");
    if (s.kind === "typing" || s.island) s.until = next ? next.at : s.at + 0.4;
  });

  // Rail captions + ticks.
  const caps = $(".caps");
  chapters.forEach((ch, c) => {
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.innerHTML = `<h3>${$("h3", ch).innerHTML}</h3><p>${$("p:not(.ch-time)", ch).innerHTML}</p>`;
    caps.append(cap);
  });
  const capEls = $$(".cap", caps);
  const ticks = $(".ticks");
  chapters.forEach((ch, c) => {
    if (c === 0) return;
    const b = document.createElement("button");
    b.className = "tick";
    b.type = "button";
    b.style.left = `${((times[c] - tStart) / (tEnd - tStart)) * 100}%`;
    b.setAttribute("aria-label", `Jump to ${$(".ch-time", ch).textContent}: ${$("h3", ch).textContent}`);
    b.addEventListener("click", () => scrollToChapter(c + 0.45));
    ticks.append(b);
  });
  const tickEls = $$(".tick", ticks);

  // Confetti pieces.
  const confetti = $(".confetti", phone);
  const colors = ["#ff375f", "#ffd60a", "#30d158", "#0a84ff", "#bf5af2", "#ff9f0a", "#64d2ff"];
  for (let i = 0; i < 46; i++) {
    const p = document.createElement("span");
    p.style.cssText = `--x:${Math.random() * 100}%;--d:${(Math.random() * 0.6).toFixed(2)}s;--dx:${((Math.random() - 0.5) * 120).toFixed(0)}px;--r:${(Math.random() * 720 - 360).toFixed(0)}deg;--c:${colors[i % colors.length]}`;
    confetti.append(p);
  }

  const heroCopy = $(".hero-copy");
  const rail = $(".rail");
  const clockHm = $(".clock-hm");
  const clockAp = $(".clock-ap");
  const fill = $(".daybar-fill");
  const sbTime = $(".sb-time", phone);
  const lockTime = $(".lock-time", phone);
  const islandText = $(".ia-text", phone);
  const chips = $$(".ep-chip");
  const night = $(".stage-bg .night");
  const sunrise = $(".stage-bg .sunrise");
  const peek = $(".peek");
  const peekEyes = $(".peek .eyes");

  let geo = { top: 0, span: 1 };
  function measure() {
    const r = story.getBoundingClientRect();
    geo = { top: r.top + scrollY, span: Math.max(1, story.offsetHeight - innerHeight) };
  }
  function scrollToChapter(u) {
    measure();
    scrollTo({ top: geo.top + (u / N) * geo.span, behavior: reduceMotion.matches ? "auto" : "smooth" });
  }

  let lastShownKey = "";
  let confettiOn = false;
  let lastCap = -1;
  let mood = "";
  function render() {
    const p = clamp((scrollY - geo.top) / geo.span);
    const u = p * N * 0.9999; // chapter units: chapter c spans [c, c + 1)
    const c = Math.min(N - 1, Math.floor(u));
    const local = u - c;

    // Clock: holds on the chapter's time, then rolls forward to the next one.
    let minutes = times[c];
    if (c < N - 1 && local > 0.7) minutes = times[c] + (times[c + 1] - times[c]) * ease((local - 0.7) / 0.3);
    const t = fmt(minutes);
    clockHm.textContent = t.hm;
    clockAp.textContent = t.ap;
    sbTime.textContent = t.hm;
    lockTime.textContent = t.hm;
    const dayP = clamp((minutes - tStart) / (tEnd - tStart));
    fill.style.transform = `scaleX(${dayP})`;
    night.style.opacity = (clamp((minutes - 1080) / 330) * 0.85).toFixed(3);
    sunrise.style.opacity = (1 - clamp((minutes - tStart) / 200)).toFixed(3);

    // Hero copy hands over to the rail during chapter 0.
    const heroOut = clamp(u / 0.45);
    heroCopy.style.opacity = (1 - heroOut).toFixed(3);
    heroCopy.style.transform = `translateY(${(-40 * heroOut).toFixed(1)}px)`;
    heroCopy.style.visibility = heroOut >= 1 ? "hidden" : "visible";
    const railIn = clamp((u - 0.35) / 0.4);
    rail.style.opacity = railIn.toFixed(3);
    rail.style.transform = `translateY(${(30 * (1 - railIn)).toFixed(1)}px)`;
    rail.style.visibility = railIn <= 0 ? "hidden" : "visible";

    const capIdx = Math.max(1, local > 0.85 && c < N - 1 ? c + 1 : c);
    if (capIdx !== lastCap) {
      capEls.forEach((el, i) => el.classList.toggle("active", i === capIdx));
      const eps = (chapters[capIdx].dataset.chips || "").split(" ");
      chips.forEach((ch) => ch.classList.toggle("on", eps.includes(ch.dataset.ep)));
      tickEls.forEach((el, i) => { el.classList.toggle("past", i + 1 < capIdx); el.classList.toggle("now", i + 1 === capIdx); });
      lastCap = capIdx;
    }
    const nextMood = u < 0.5 ? "idle" : chapters[capIdx].dataset.mood || "idle";
    if (nextMood !== mood) {
      peek.classList.remove(`mood-${mood}`);
      peek.classList.add(`mood-${nextMood}`);
      if (nextMood !== "idle") peekEyes.style.transform = "";
      mood = nextMood;
    }

    // Phone state.
    const sleeping = chapters[capIdx].dataset.lock === "sleep";
    phone.classList.toggle("unlocked", u >= 0.62 && !sleeping);
    phone.classList.toggle("sleep", sleeping);

    let key = "";
    let island = null;
    let wantConfetti = false;
    for (const s of timeline) {
      const on = u >= s.at && (s.until === undefined || u < s.until);
      s.el.classList.toggle("on", on);
      key += on ? "1" : "0";
      if (on && s.island) island = s.island;
      if (u >= s.at && s.confetti) wantConfetti = true;
    }
    wantConfetti = wantConfetti && !sleeping;
    phone.classList.toggle("island-on", !!island);
    if (island) islandText.textContent = island;
    if (wantConfetti !== confettiOn) {
      confettiOn = wantConfetti;
      confetti.classList.remove("burst");
      if (confettiOn) { void confetti.offsetWidth; confetti.classList.add("burst"); }
    }
    if (key !== lastShownKey) {
      lastShownKey = key;
      placeDelivered(phone);
      settleThread(phone);
    }
  }

  // ───────────── Nav: tone + active section ─────────────
  const nav = $(".nav");
  const links = $$(".links a");
  const indicator = $(".indicator");
  const toneSections = $$("[data-tone]").filter((el) => el !== nav);
  function navUpdate() {
    nav.classList.toggle("scrolled", scrollY > 24);
    const probe = 34;
    const under = toneSections.find((el) => { const r = el.getBoundingClientRect(); return r.top <= probe && r.bottom > probe; });
    nav.dataset.tone = under?.dataset.tone || "light";
    const mid = innerHeight * 0.4;
    let active = null;
    for (const a of links) {
      const sec = document.getElementById(a.dataset.section);
      if (!sec) continue;
      const r = sec.getBoundingClientRect();
      if (r.top <= mid && r.bottom > mid) active = a;
    }
    links.forEach((a) => a.classList.toggle("active", a === active));
    if (active && active.offsetParent) {
      indicator.style.opacity = "1";
      indicator.style.width = `${active.offsetWidth}px`;
      indicator.style.transform = `translateX(${active.offsetLeft}px)`;
    } else indicator.style.opacity = "0";
  }

  // ───────────── Loop ─────────────
  let queued = false;
  function frame() { queued = false; render(); navUpdate(); }
  function request() { if (!queued) { queued = true; requestAnimationFrame(frame); } }
  measure();
  frame();
  addEventListener("scroll", request, { passive: true });
  addEventListener("resize", () => { measure(); lastShownKey = ""; request(); });
  document.fonts?.ready.then(() => { measure(); lastShownKey = ""; request(); });

  // ───────────── Mascot: eyes follow the cursor, hat tips on the CTAs ─────────────
  if (finePointer.matches && !reduceMotion.matches) {
    addEventListener("pointermove", (e) => {
      if (mood !== "idle") return;
      const r = peek.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height * 0.6);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 260) * 18;
      peekEyes.style.transform = `translate(${((dx / d) * k).toFixed(1)}px, ${((dy / d) * k * 0.7).toFixed(1)}px)`;
    }, { passive: true });
  }
  for (const cta of $$(".cta")) {
    cta.addEventListener("pointerenter", () => peek.classList.add("tip"));
    cta.addEventListener("pointerleave", () => peek.classList.remove("tip"));
    cta.addEventListener("focus", () => peek.classList.add("tip"));
    cta.addEventListener("blur", () => peek.classList.remove("tip"));
  }

  // ───────────── Reveals + counters ─────────────
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      for (const n of $$("[data-count]", e.target)) countUp(n);
      io.unobserve(e.target);
    }
  }, { threshold: 0.18, rootMargin: "0px 0px -6% 0px" });
  $$(".reveal, .foot-brand").forEach((el) => io.observe(el));

  function countUp(el) {
    const target = Number(el.dataset.count);
    if (reduceMotion.matches) { el.textContent = target; return; }
    const t0 = performance.now();
    const tick = (now) => {
      const k = clamp((now - t0) / 1100);
      el.textContent = Math.round(target * ease(k));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
})();
