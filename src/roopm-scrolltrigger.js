/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║           ROOPM-SCROLLTRIGGER  v2.0  —  Enterprise Scroll Engine            ║
 * ║  Pure Vanilla JS · Zero Dependencies · IntersectionObserver · RAF Loop      ║
 * ║  Lerp Physics · Advanced Pinning · Velocity Tracking · Debug Markers        ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * ARCHITECTURE OVERVIEW
 * ─────────────────────
 *  Engine (singleton)
 *   ├─ Single global requestAnimationFrame loop
 *   ├─ Tracks: scrollY, velocity, smoothVelocity, direction, deltaTime
 *   ├─ ResizeObserver on <body> → debounced recalcAll()
 *   └─ Dispatches tick() to all registered RoopmScrollTrigger instances
 *
 *  RoopmScrollTrigger (per-trigger instance)
 *   ├─ parsePosition() → converts "top 80%" into absolute scroll px
 *   ├─ calculate()      → resolves startPos / endPos from live DOM geometry
 *   ├─ _tick()          → per-frame: lerp, callbacks, pin, onUpdate
 *   ├─ _setupPin()      → wraps trigger in a spacer <div> for pinSpacing
 *   ├─ _updatePin()     → 3-state FSM: before / active-pin / after
 *   ├─ _createMarkers() → injects color-coded debug lines into <body>
 *   └─ kill()           → tears down observers, spacer, markers
 *
 * POSITION MATH  ("triggerEdge viewportEdge")
 * ────────────────────────────────────────────
 *  The scroll position at which a trigger fires is:
 *
 *    scrollY_trigger = absoluteY(triggerEdge) − viewportOffset(viewportEdge)
 *
 *  Example: start = "top center"
 *    absoluteY(trigger.top) = el.getBoundingClientRect().top + window.scrollY
 *    viewportOffset(center) = window.innerHeight / 2
 *    → fires when trigger's top reaches the vertical center of the screen
 */

;(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.RoopmScrollTrigger = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════════════════
   * MATH UTILITIES
   * ══════════════════════════════════════════════════════════════════════════════ */

  /** Linear interpolation — the backbone of all smooth / inertia effects */
  const lerp = (a, b, t) => a + (b - a) * t;

  /** Hard clamp a value between lo and hi */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /**
   * Exponential-decay lerp factor for butter-smooth catch-up.
   * scrub seconds to close 63% of the remaining gap per second (physically accurate).
   *
   *   factor ≈ 1 − e^(−dt / scrub)
   *
   * At 60fps (dt≈0.016):
   *   scrub=0.3 → factor≈0.051  (snappy)
   *   scrub=1   → factor≈0.016  (smooth ~1s lag)
   *   scrub=3   → factor≈0.005  (very dreamy)
   */
  const lerpFactor = (dt, scrub) => clamp(1 - Math.exp(-dt / scrub), 0, 0.99);

  /* ══════════════════════════════════════════════════════════════════════════════
   * POSITION PARSER
   * ══════════════════════════════════════════════════════════════════════════════ */

  /**
   * Resolves a declarative position string to an absolute scroll-Y value.
   *
   * Supported formats:
   *   "top top"      — trigger's top edge aligns with viewport top
   *   "top center"   — trigger's top aligns with viewport center
   *   "bottom 80%"   — trigger's bottom aligns 80% down from viewport top
   *   "center 200px" — trigger's center aligns 200px from viewport top
   *   "+=500"        — 500px after the provided relativeTo value (for end offsets)
   *   "+=500px"      — same with explicit px unit
   *
   * @param  {string}      str        — position string
   * @param  {HTMLElement} el         — the trigger (or its spacer) element
   * @param  {number}      relativeTo — base scroll-Y for "+=" relative values
   * @returns {number} absolute document scroll-Y that fires this trigger
   */
  function parsePosition(str, el, relativeTo) {
    if (typeof str !== 'string') return 0;
    str = str.trim();

    // ── Relative offset: "+=300" or "+=300px" ──────────────────────────────────
    if (str.startsWith('+=')) {
      const offset = parseFloat(str.slice(2));
      return (relativeTo || 0) + (isNaN(offset) ? 0 : offset);
    }

    const parts        = str.split(/\s+/);
    const triggerToken = (parts[0] || 'top').toLowerCase();
    const vpToken      = (parts[1] || 'bottom').toLowerCase();

    const rect    = el.getBoundingClientRect();
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const vh      = window.innerHeight;
    const elH     = rect.height;

    // ── Absolute Y of trigger edge ──────────────────────────────────────────────
    const elAbsTop = rect.top + scrollY;
    let triggerY;
    switch (triggerToken) {
      case 'top':    triggerY = elAbsTop;             break;
      case 'center': triggerY = elAbsTop + elH * 0.5; break;
      case 'bottom': triggerY = elAbsTop + elH;       break;
      default:       triggerY = elAbsTop + resolveUnit(triggerToken, elH); break;
    }

    // ── Viewport edge offset (from top of viewport) ─────────────────────────────
    let vpOffset;
    switch (vpToken) {
      case 'top':    vpOffset = 0;        break;
      case 'center': vpOffset = vh * 0.5; break;
      case 'bottom': vpOffset = vh;       break;
      default:       vpOffset = resolveUnit(vpToken, vh); break;
    }

    return triggerY - vpOffset;
  }

  /**
   * Parse a CSS-like value to pixels, relative to a container size.
   *   "80%"  → containerSize × 0.8
   *   "200px"→ 200
   *   "200"  → 200
   */
  function resolveUnit(val, containerSize) {
    const s = String(val);
    if (s.endsWith('%'))  return containerSize * parseFloat(s) / 100;
    if (s.endsWith('px')) return parseFloat(s);
    return parseFloat(s) || 0;
  }

  /* ══════════════════════════════════════════════════════════════════════════════
   * GLOBAL ENGINE  (Singleton IIFE — one RAF loop to rule them all)
   * ══════════════════════════════════════════════════════════════════════════════ */

  const Engine = (() => {
    /*  ── Internal state ── */
    const _instances = [];  // all live RoopmScrollTrigger instances
    let   _rafId     = null;
    let   _running   = false;
    let   _lastTs    = 0;
    let   _resizeTimer = null;

    /*  ── Scroll metrics (updated every frame) ── */
    let _scrollY     = 0;
    let _lastScrollY = 0;
    let _rawVel      = 0;
    let _smoothVel   = 0;   // lerped for display (lag removed)
    let _direction   = 1;   // +1 = down, −1 = up

    /*  ── Observers ── */
    let _resizeObs = null;

    /* ── Main RAF loop ─────────────────────────────────────────────────────── */
    function _loop(ts) {
      _rafId = requestAnimationFrame(_loop);

      // Delta time in seconds, capped at 100ms to prevent huge jumps on tab-switch
      const dt = Math.min((ts - _lastTs) / 1000, 0.1);
      _lastTs  = ts || performance.now();

      _scrollY    = window.scrollY || window.pageYOffset || 0;
      _rawVel     = _scrollY - _lastScrollY;
      _smoothVel  = lerp(_smoothVel, _rawVel, 0.15);  // smooth out jitter
      _direction  = _rawVel >= 0 ? 1 : -1;

      // Dispatch tick to every registered instance
      for (let i = 0; i < _instances.length; i++) {
        if (_instances[i] && _instances[i]._alive) {
          _instances[i]._tick(_scrollY, dt, _smoothVel, _direction);
        }
      }

      _lastScrollY = _scrollY;
    }

    /* ── Recalculate geometry for all instances (called on resize) ─────────── */
    function _recalcAll() {
      for (let i = 0; i < _instances.length; i++) {
        const inst = _instances[i];
        if (inst && inst._alive) {
          inst.calculate();
          inst._updateMarkers();
        }
      }
    }

    /* ── Set up ResizeObserver + window resize fallback ─────────────────────── */
    function _setupObservers() {
      if (_resizeObs) return;  // already initialised

      // ResizeObserver watches the document root for any layout change
      if (typeof ResizeObserver !== 'undefined') {
        _resizeObs = new ResizeObserver(() => {
          clearTimeout(_resizeTimer);
          _resizeTimer = setTimeout(_recalcAll, 150);
        });
        _resizeObs.observe(document.documentElement);
      }

      // Fallback: plain window resize
      window.addEventListener('resize', () => {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(_recalcAll, 150);
      }, { passive: true });
    }

    /* ── Public API ──────────────────────────────────────────────────────────── */
    return {
      instances:    _instances,
      start()       { if (_running) return; _running = true; _lastTs = performance.now(); _rafId = requestAnimationFrame(_loop); },
      stop()        { if (_rafId) cancelAnimationFrame(_rafId); _running = false; },
      recalcAll:    _recalcAll,
      setupObservers: _setupObservers,

      // Live read-only accessors
      get scrollY()   { return _scrollY;   },
      get velocity()  { return _smoothVel; },
      get direction() { return _direction; },
    };
  })();

  /* ══════════════════════════════════════════════════════════════════════════════
   * MAIN CLASS — RoopmScrollTrigger
   * ══════════════════════════════════════════════════════════════════════════════ */

  class RoopmScrollTrigger {

    /**
     * @param {Object} config
     * @param {Element|string} config.trigger     — DOM element or CSS selector
     * @param {string}  config.start              — "triggerEdge viewportEdge"  e.g. "top center"
     * @param {string}  config.end                — "triggerEdge viewportEdge"  or "+=500px"
     * @param {boolean|number} config.scrub       — false = event-based; true = instant; number = lerp seconds
     * @param {boolean} config.pin                — pin the trigger element while scrolling through range
     * @param {boolean} config.pinSpacing         — add spacer so content below doesn't jump (default true)
     * @param {boolean} config.markers            — inject visual debug markers
     * @param {boolean} config.snap               — snap to start/end on scroll stop
     * @param {Array}   config.snap               — array of progress values [0..1] to snap to
     * @param {Function} config.onEnter           — fired when entering range (scroll down)
     * @param {Function} config.onLeave           — fired when leaving range (scroll down past end)
     * @param {Function} config.onEnterBack       — fired when re-entering range (scroll up)
     * @param {Function} config.onLeaveBack       — fired when leaving range (scroll up past start)
     * @param {Function} config.onUpdate(self)    — fired every frame; self = { progress, direction, velocity, isActive, start, end }
     */
    constructor(config = {}) {
      this._cfg = {
        trigger:     null,
        start:       'top bottom',
        end:         'bottom top',
        scrub:       false,
        pin:         false,
        pinSpacing:  true,
        markers:     false,
        snap:        false,
        onEnter:     null,
        onLeave:     null,
        onEnterBack: null,
        onLeaveBack: null,
        onUpdate:    null,
        ...config,
      };

      // ── Resolve trigger element ──────────────────────────────────────────────
      if (typeof this._cfg.trigger === 'string') {
        this._cfg.trigger = document.querySelector(this._cfg.trigger);
      }
      if (!this._cfg.trigger || !(this._cfg.trigger instanceof Element)) {
        console.error('[RoopmScrollTrigger] Invalid or missing trigger:', config.trigger);
        return;
      }

      // ── Internal state ───────────────────────────────────────────────────────
      this._alive        = true;
      this.startPos      = 0;    // absolute scroll-Y where trigger starts
      this.endPos        = 0;    // absolute scroll-Y where trigger ends
      this.progress      = 0;    // current animated progress [0..1]
      this._lerpProg     = 0;    // lerp accumulator for smooth scrub
      this._prevScrollY  = window.scrollY || 0;

      // ── Callback state flags ─────────────────────────────────────────────────
      this._hasEntered   = false;   // has fired onEnter
      this._hasPassed    = false;   // has fired onLeave (scrolled past end)

      // ── Pin state ────────────────────────────────────────────────────────────
      this._pinEl        = null;    // the element being pinned
      this._pinSpacer    = null;    // wrapper spacer div
      this._pinState     = 'before'; // 'before' | 'pinned' | 'after'
      this._pinTop       = 0;       // fixed top offset when pinned
      this._pinLeft      = 0;       // fixed left offset when pinned
      this._pinWidth     = 0;       // fixed width when pinned
      this._triggerH     = 0;       // original trigger element height
      this._pinOrigStyle = {};      // saved inline styles for restore

      // ── Marker elements ──────────────────────────────────────────────────────
      this._markerEls    = [];
      this._mStart       = null;    // absolute trigger-start marker
      this._mEnd         = null;    // absolute trigger-end marker

      // ── Snap listener reference ──────────────────────────────────────────────
      this._snapListener = null;

      // ── Self object exposed to user callbacks ────────────────────────────────
      this.self = {
        trigger:   this._cfg.trigger,
        progress:  0,
        direction: 1,
        velocity:  0,
        isActive:  false,
        start:     0,
        end:       0,
      };

      this._init();
    }

    /* ── Life-cycle ─────────────────────────────────────────────────────────── */

    _init() {
      // 1. Set up pin spacer BEFORE calculating positions (affects DOM geometry)
      if (this._cfg.pin) this._setupPin();

      // 2. Calculate start/end scroll positions from current DOM layout
      this.calculate();

      // 3. Inject debug markers (uses startPos/endPos)
      if (this._cfg.markers) this._createMarkers();

      // 4. IntersectionObserver for performance (pause ticking when far off-screen)
      this._setupIO();

      // 5. Snap listener
      if (this._cfg.snap) this._setupSnap();

      // 6. Register and start global engine
      Engine.instances.push(this);
      Engine.start();
      Engine.setupObservers();
    }

    /* ════════════════════════════════════════════════════════════════════════════
     * GEOMETRY CALCULATION  (called on init + every resize)
     * ════════════════════════════════════════════════════════════════════════════ */

    /**
     * Recalculates startPos and endPos from the live DOM layout.
     * Uses the pin spacer as the reference element when pinning is active,
     * because the spacer occupies the exact same document position the original
     * element had before it was wrapped.
     */
    calculate() {
      const refEl = this._pinSpacer || this._cfg.trigger;

      this.startPos = parsePosition(this._cfg.start, refEl, 0);
      this.endPos   = parsePosition(this._cfg.end,   refEl, this.startPos);

      // Safety guard: endPos must always be strictly greater than startPos
      if (this.endPos <= this.startPos) this.endPos = this.startPos + 1;

      this.self.start = this.startPos;
      this.self.end   = this.endPos;

      // Resize the spacer now that we know the pin duration
      if (this._pinSpacer && this._cfg.pinSpacing !== false) {
        const pinDuration = this.endPos - this.startPos;
        // Total spacer height = element's natural height + scroll-through duration
        // This ensures:
        //   • the element's original space is preserved in the flow
        //   • content below doesn't jump
        //   • the spacer gives the user enough scroll room to pass through the pin
        this._pinSpacer.style.height = `${this._triggerH + pinDuration}px`;
      }
    }

    /* ════════════════════════════════════════════════════════════════════════════
     * PER-FRAME TICK  (called by Engine every RAF frame)
     * ════════════════════════════════════════════════════════════════════════════ */

    /**
     * @param {number} scrollY   — current window.scrollY
     * @param {number} dt        — delta time in seconds since last frame
     * @param {number} vel       — smoothed scroll velocity (px / frame)
     * @param {number} dir       — +1 (scrolling down) or -1 (scrolling up)
     */
    _tick(scrollY, dt, vel, dir) {
      const { startPos, endPos } = this;
      const range = endPos - startPos;

      /* ── 1. Compute raw progress [0..1] ─────────────────────────────────── */
      const rawProg = clamp((scrollY - startPos) / range, 0, 1);

      /* ── 2. Apply scrub / lerp ───────────────────────────────────────────── */
      let progress;
      if (this._cfg.scrub === true) {
        // Instant scrub: progress tracks scrollbar exactly
        progress = rawProg;
      } else if (typeof this._cfg.scrub === 'number' && this._cfg.scrub > 0) {
        // Lerp scrub: exponential-decay catch-up
        //   scrub = seconds to close ~63% of remaining gap (physically accurate)
        const f = lerpFactor(dt, this._cfg.scrub);
        this._lerpProg = lerp(this._lerpProg, rawProg, f);
        progress = this._lerpProg;
      } else {
        // Non-scrub: step function (used only for range detection, not animation)
        progress = rawProg;
      }

      this.progress = progress;

      /* ── 3. Lifecycle callbacks (state machine) ──────────────────────────── */

      // → onEnter: first time scrollY crosses startPos going down
      if (!this._hasEntered && scrollY >= startPos && scrollY <= endPos) {
        this._hasEntered    = true;
        this.self.isActive  = true;
        if (this._cfg.onEnter) this._cfg.onEnter(this._snapshot(progress, dir, vel, true));
      }

      // → onLeave: scrollY passes endPos going down
      if (this._hasEntered && !this._hasPassed && scrollY > endPos) {
        this._hasPassed = true;
        if (this._cfg.onLeave) this._cfg.onLeave(this._snapshot(1, dir, vel, false));
      }

      // → onLeaveBack: scrollY falls below startPos going up
      if (this._hasEntered && scrollY < startPos) {
        this._hasEntered = false;
        this._hasPassed  = false;
        if (this._cfg.onLeaveBack) this._cfg.onLeaveBack(this._snapshot(0, dir, vel, false));
      }

      // → onEnterBack: scrollY re-enters range from below (scrolling up past end)
      if (this._hasPassed && scrollY <= endPos && scrollY >= startPos) {
        this._hasPassed = false;
        if (this._cfg.onEnterBack) this._cfg.onEnterBack(this._snapshot(progress, dir, vel, true));
      }

      /* ── 4. onUpdate callback ────────────────────────────────────────────── */
      const inRange = scrollY >= startPos && scrollY <= endPos;
      if (this._cfg.onUpdate) {
        // For scrub triggers: always call (progress may be 0 or 1 outside range)
        // For non-scrub: only call while inside range
        if (this._cfg.scrub !== false || inRange) {
          const snap = this._snapshot(progress, dir, vel, inRange);
          this._cfg.onUpdate(snap);
          // Mirror onto the public self reference
          Object.assign(this.self, snap);
        }
      }

      /* ── 5. Pin update ───────────────────────────────────────────────────── */
      if (this._cfg.pin) this._updatePin(scrollY);

      this._prevScrollY = scrollY;
    }

    /**
     * Creates an immutable snapshot object for callbacks.
     * Passing a new object each time prevents bugs from mutation.
     */
    _snapshot(progress, direction, velocity, isActive) {
      return {
        trigger:   this._cfg.trigger,
        progress,
        direction,
        velocity,
        isActive,
        start:     this.startPos,
        end:       this.endPos,
      };
    }

    /* ════════════════════════════════════════════════════════════════════════════
     * PINNING  — 3-state FSM: before / active-pin / after
     * ════════════════════════════════════════════════════════════════════════════ */

    /**
     * Called once during init. Wraps the trigger element in a spacer div so
     * that the document flow is preserved when the element becomes position:fixed.
     *
     * DOM transformation:
     *   BEFORE:  parent > trigger
     *   AFTER:   parent > spacer[roopm-pin-spacer] > trigger
     *
     * The spacer's height is updated in calculate() once we know the pin duration.
     */
    _setupPin() {
      const el     = this._cfg.trigger;
      const parent = el.parentNode;

      if (!parent) {
        console.warn('[RoopmScrollTrigger] Pin target has no parent — cannot pin.');
        return;
      }

      // Save original inline styles so we can restore them on kill()
      this._pinOrigStyle = {
        position: el.style.position || '',
        top:      el.style.top      || '',
        left:     el.style.left     || '',
        bottom:   el.style.bottom   || '',
        width:    el.style.width    || '',
        zIndex:   el.style.zIndex   || '',
        margin:   el.style.margin   || '',
      };

      // Capture natural height BEFORE wrapping (important for spacer sizing)
      this._triggerH = el.offsetHeight;
      this._pinEl    = el;

      if (this._cfg.pinSpacing !== false) {
        // Create the spacer wrapper
        const spacer         = document.createElement('div');
        spacer.className     = 'roopm-pin-spacer';
        spacer.style.cssText = [
          'display: block',
          'pointer-events: none',
          'position: relative',          // needed for position:absolute children
          `height: ${this._triggerH}px`, // temporary; resized in calculate()
        ].join(';');

        parent.insertBefore(spacer, el);  // insert spacer before element
        spacer.appendChild(el);           // move element inside spacer

        this._pinSpacer = spacer;
      }
    }

    /**
     * Per-frame pin state machine. Runs every tick when pin:true.
     *
     * ┌──────────┬──────────────────────────────────────────────────────────────┐
     * │ State    │ Description                                                  │
     * ├──────────┼──────────────────────────────────────────────────────────────┤
     * │ before   │ Normal flow, element at top of spacer                        │
     * │ pinned   │ position:fixed, overlays exact spacer position               │
     * │ after    │ position:absolute bottom:0, element at bottom of spacer      │
     * └──────────┴──────────────────────────────────────────────────────────────┘
     */
    _updatePin(scrollY) {
      if (!this._pinEl) return;
      const { startPos, endPos } = this;

      if (scrollY >= startPos && scrollY <= endPos) {
        /* ── PINNED ─────────────────────────────────────────────────────────── */
        if (this._pinState !== 'pinned') {
          this._pinState = 'pinned';

          // Snapshot the exact viewport position at the moment of pinning.
          // At this frame, spacer.getBoundingClientRect().top equals the
          // viewport offset derived from the "start" string (e.g. 0 for "top top").
          const ref = this._pinSpacer || this._pinEl;
          const r   = ref.getBoundingClientRect();

          this._pinTop   = r.top;
          this._pinLeft  = r.left;
          this._pinWidth = r.width;

          this._pinEl.style.position = 'fixed';
          this._pinEl.style.top      = `${this._pinTop}px`;
          this._pinEl.style.left     = `${this._pinLeft}px`;
          this._pinEl.style.width    = `${this._pinWidth}px`;
          this._pinEl.style.bottom   = 'auto';
          this._pinEl.style.zIndex   = '500';
          this._pinEl.style.margin   = '0';
        }

      } else if (scrollY > endPos) {
        /* ── AFTER — element anchored to spacer's bottom edge ───────────────── */
        if (this._pinState !== 'after') {
          this._pinState = 'after';
          this._pinEl.style.position = 'absolute';
          this._pinEl.style.top      = 'auto';
          this._pinEl.style.bottom   = '0';
          this._pinEl.style.left     = '0';
          this._pinEl.style.right    = '0';
          this._pinEl.style.width    = '100%';
          this._pinEl.style.zIndex   = this._pinOrigStyle.zIndex || '';
          this._pinEl.style.margin   = '0';
        }

      } else {
        /* ── BEFORE — element at natural position (top of spacer) ───────────── */
        if (this._pinState !== 'before') {
          this._pinState = 'before';
          this._pinEl.style.position = '';
          this._pinEl.style.top      = '';
          this._pinEl.style.left     = '';
          this._pinEl.style.right    = '';
          this._pinEl.style.bottom   = '';
          this._pinEl.style.width    = this._pinOrigStyle.width || '';
          this._pinEl.style.zIndex   = this._pinOrigStyle.zIndex || '';
          this._pinEl.style.margin   = this._pinOrigStyle.margin || '';
        }
      }
    }

    /* ════════════════════════════════════════════════════════════════════════════
     * INTERSECTION OBSERVER  (performance gate)
     * ════════════════════════════════════════════════════════════════════════════ */

    _setupIO() {
      // Use a generous rootMargin so we start ticking well before elements enter view.
      // For scrub triggers we always tick (large margin = never paused in practice).
      const margin = Math.round(Math.max(window.innerHeight * 2, 800));

      this._io = new IntersectionObserver((entries) => {
        entries.forEach(e => {
          // For scrub triggers always stay alive (progress needs updating even offscreen)
          if (this._cfg.scrub !== false) {
            this._alive = true; // scrub triggers never sleep
          } else {
            // Non-scrub: we could pause here, but keeping alive is safer & perf cost is trivial
            this._alive = true;
          }
        });
      }, {
        rootMargin: `${margin}px 0px ${margin}px 0px`,
        threshold:  0,
      });

      const target = this._pinSpacer || this._cfg.trigger;
      this._io.observe(target);
    }

    /* ════════════════════════════════════════════════════════════════════════════
     * DEBUG MARKERS
     * ════════════════════════════════════════════════════════════════════════════ */

    /**
     * Injects 4 visual markers into <body>:
     *   1. Scroller-Start  (fixed, viewport top)    — cyan  — right side
     *   2. Scroller-End    (fixed, viewport bottom)  — orange — right side
     *   3. Trigger-Start   (absolute, at startPos)   — green  — left side
     *   4. Trigger-End     (absolute, at endPos)     — red    — left side
     */
    _createMarkers() {
      this._removeMarkers();

      // Generate unique hue per instance so multiple triggers are distinguishable
      const idx  = Engine.instances.length;
      const hue  = (idx * 137.5) % 360;          // golden-ratio hue stepping
      const cS   = `hsl(${hue}, 100%, 55%)`;      // trigger-start color
      const cE   = `hsl(${(hue + 60) % 360}, 100%, 55%)`; // trigger-end color

      /**
       * Create one marker line + badge.
       * @param {string} text    — badge label
       * @param {string} color   — line + badge color
       * @param {string} side    — 'left' | 'right' — which side the badge appears on
       * @param {boolean} fixed  — viewport-fixed (true) or document-absolute (false)
       * @param {number}  posY   — vertical position in px (absolute triggers only)
       */
      const makeLine = (text, color, side, fixed, posY) => {
        const line        = document.createElement('div');
        line.className    = 'roopm-marker';
        line.style.cssText = [
          `position: ${fixed ? 'fixed' : 'absolute'}`,
          fixed ? '' : `top: ${posY}px`,
          'left: 0',
          'right: 0',
          'height: 0',
          `border-top: 2px dashed ${color}`,
          'z-index: 99990',
          'pointer-events: none',
          'mix-blend-mode: screen',
        ].filter(Boolean).join(';');

        const badge        = document.createElement('div');
        badge.style.cssText = [
          'position: absolute',
          `${side}: 12px`,
          'top: -26px',
          `background: ${color}`,
          'color: #000',
          'font: 700 9px/1 monospace',
          'padding: 4px 8px',
          'border-radius: 3px',
          'white-space: nowrap',
          'letter-spacing: 0.08em',
          'text-transform: uppercase',
          'box-shadow: 0 2px 10px rgba(0,0,0,0.5)',
        ].join(';');

        badge.textContent = text;
        line.appendChild(badge);
        document.body.appendChild(line);
        return line;
      };

      // ── Viewport lines (fixed) ───────────────────────────────────────────────
      const vTop = makeLine('▲ Scroller-Start', '#00D4FF', 'right', true, 0);
      vTop.style.top = '0';

      const vBot = makeLine('▼ Scroller-End', '#FF7B2C', 'right', true, 0);
      vBot.style.top    = 'auto';
      vBot.style.bottom = '0';
      vBot.style.borderTop  = 'none';
      vBot.style.borderBottom = '2px dashed #FF7B2C';
      vBot.children[0].style.top  = 'auto';
      vBot.children[0].style.bottom = '-26px';

      // ── Trigger-position lines (absolute in document) ────────────────────────
      const tStart = makeLine(`▶ Start: ${this._cfg.start}`, cS, 'left', false, this.startPos);
      const tEnd   = makeLine(`◀ End: ${this._cfg.end}`,     cE, 'left', false, this.endPos);

      this._markerEls = [vTop, vBot, tStart, tEnd];
      this._mStart    = tStart;
      this._mEnd      = tEnd;
    }

    /** Repositions trigger markers to match recalculated startPos / endPos */
    _updateMarkers() {
      if (!this._cfg.markers || !this._mStart) return;
      this._mStart.style.top = `${this.startPos}px`;
      this._mEnd.style.top   = `${this.endPos}px`;
      this._mStart.children[0].textContent = `▶ Start: ${this._cfg.start}`;
      this._mEnd.children[0].textContent   = `◀ End: ${this._cfg.end}`;
    }

    _removeMarkers() {
      this._markerEls.forEach(m => m && m.parentNode && m.parentNode.removeChild(m));
      this._markerEls = [];
      this._mStart = null;
      this._mEnd   = null;
    }

    /* ════════════════════════════════════════════════════════════════════════════
     * SNAPPING
     * ════════════════════════════════════════════════════════════════════════════ */

    _setupSnap() {
      let timer;

      this._snapListener = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const sy = window.scrollY;

          // Only snap if scrollY is within ±300px of our range
          if (sy < this.startPos - 300 || sy > this.endPos + 300) return;

          let snapPoints;
          if (this._cfg.snap === true) {
            snapPoints = [this.startPos, this.endPos];
          } else if (Array.isArray(this._cfg.snap)) {
            // Array of progress values [0..1] → map to absolute scroll positions
            snapPoints = this._cfg.snap.map(p => this.startPos + clamp(p, 0, 1) * (this.endPos - this.startPos));
          } else {
            return;
          }

          // Find nearest snap point
          let nearest = snapPoints[0], minDist = Infinity;
          snapPoints.forEach(pt => {
            const d = Math.abs(sy - pt);
            if (d < minDist) { minDist = d; nearest = pt; }
          });

          window.scrollTo({ top: nearest, behavior: 'smooth' });
        }, 200); // 200ms after last scroll event
      };

      window.addEventListener('scroll', this._snapListener, { passive: true });
    }

    /* ════════════════════════════════════════════════════════════════════════════
     * PUBLIC API
     * ════════════════════════════════════════════════════════════════════════════ */

    /**
     * Kill this instance: disconnect observers, remove markers, restore pin.
     */
    kill() {
      this._alive = false;

      // Remove from engine
      const idx = Engine.instances.indexOf(this);
      if (idx > -1) Engine.instances.splice(idx, 1);

      // Disconnect IntersectionObserver
      if (this._io) this._io.disconnect();

      // Remove snap listener
      if (this._snapListener) window.removeEventListener('scroll', this._snapListener);

      // Remove debug markers
      this._removeMarkers();

      // Restore pinned element to its original styles
      if (this._pinEl && this._pinState !== 'before') {
        const o = this._pinOrigStyle;
        this._pinEl.style.position = o.position;
        this._pinEl.style.top      = o.top;
        this._pinEl.style.left     = o.left;
        this._pinEl.style.bottom   = o.bottom;
        this._pinEl.style.width    = o.width;
        this._pinEl.style.zIndex   = o.zIndex;
        this._pinEl.style.margin   = o.margin;
      }

      // Remove pin spacer, re-insert element into original position
      if (this._pinSpacer && this._pinSpacer.parentNode) {
        const parent = this._pinSpacer.parentNode;
        parent.insertBefore(this._pinEl, this._pinSpacer);
        parent.removeChild(this._pinSpacer);
      }
    }

    /* ── Static helpers ──────────────────────────────────────────────────────── */

    /** Factory shorthand: RoopmScrollTrigger.create({...}) */
    static create(cfg) { return new RoopmScrollTrigger(cfg); }

    /** Force recalculation of all active instances (e.g. after dynamic content added) */
    static refresh() { Engine.recalcAll(); }

    /** Destroy every instance and stop the RAF loop */
    static killAll() { [...Engine.instances].forEach(i => i.kill()); Engine.stop(); }

    /** Expose engine for advanced use */
    static get engine() { return Engine; }
  }

  return RoopmScrollTrigger;
}));
