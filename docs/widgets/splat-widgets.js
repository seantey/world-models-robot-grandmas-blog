// Embeddable Gaussian-splat widgets for a blog post (v2, minimal design).
//
//   <splat-blob-demo>    one Gaussian blob you can reshape (tiny, starts on)
//   <splat-object-demo>  a real object made of many blobs (heavy, starts off)
//
// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------
// Width: each widget fills its container. Put it in your article column.
//
// Look and size: set these CSS custom properties on the page (they pass into
// the widgets), e.g. in your blog theme's :root, or on one widget only:
//   --splat-aspect          view shape on wide screens      (default 16 / 10)
//   --splat-aspect-narrow   view shape when narrow (phones) (default 1 / 1)
//   --splat-radius          corner rounding                 (default 14px)
//   --splat-stage-bg        3D background, read once at startup (default #111317)
//   --splat-text, --splat-muted, --splat-accent, --splat-border
//                           text, secondary text, highlight and line colors;
//                           set them per theme (day/night) on the page
//   --splat-caption-font    caption font (default: inherits the page font)
//   --splat-ui-font         button/slider font (default: system UI font)
// The widget switches to the narrow shape when it is narrower than 560px
// (NARROW_BREAKPOINT_PX below; CSS container queries can't read variables).
// Mobile: touch, tap-to-interact, pinch zoom and a full-screen "expand" mode
// are built in, so the same markup works on desktop and phones.
//
// Text: put text in slots.
//   slot="caption"  short text about the widget; position with the attribute
//                   caption-position="top" | "bottom" (default "bottom")
//   slot="credit"   attribution line, always small, under the widget
//
// <splat-blob-demo> attributes:
//   advanced        also show sliders (width, height, depth, tilt, turn,
//                   opacity, colors) and the "numbers" panel
//   formula-src     image of the blob's formula (a pre-typeset SVG); shows a
//                   "Gaussian Shape Formula" card in the view's top-left corner,
//                   with the blob's three widths updating live. On narrow views
//                   it folds into a small button that opens the card.
//
// <splat-object-demo> attributes:
//   poster          still image shown before the reader opens the 3D
//   preview-src     small file loaded first (shows something fast)
//   default-src     better file loaded next if the device copes
//   download-size   label next to the Explore button, e.g. "about 11 MB"
//   flip            turn the object upside down (common file convention)
//   view-target     "x,y,z" point to look at, in file coordinates
//                   (default: the dense middle of the object)
//   view-distance   camera distance from the target (default: fit the object)
//   view-direction  "x,y,z" direction from target toward camera (default 0,0.5,1)

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const NARROW_BREAKPOINT_PX = 560;
const IS_COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;
const PREFERS_REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const PIXEL_RATIO_CAP = IS_COARSE_POINTER ? 1.5 : 2;
const DEFAULT_STAGE_BACKGROUND = '#111317';

function prefersLightLoading() {
  const connection = navigator.connection;
  return Boolean(connection?.saveData) || (navigator.deviceMemory !== undefined && navigator.deviceMemory <= 4);
}

function readStageBackground(element) {
  return getComputedStyle(element).getPropertyValue('--splat-stage-bg').trim() || DEFAULT_STAGE_BACKGROUND;
}

// ---------------------------------------------------------------------------
// Shared GLSL: project a 3D Gaussian onto the screen as a 2D ellipse.
// ---------------------------------------------------------------------------
const PROJECT_GAUSSIAN_GLSL = /* glsl */ `
  // Returns false if the blob is behind the camera. Otherwise fills the two
  // ellipse axes in pixels, already scaled to 3 standard deviations.
  bool projectGaussian(vec4 centerInCameraSpace, mat3 covariance3D, mat3 modelViewRotation,
                       vec2 viewportPixels, out vec2 majorAxisPixels, out vec2 minorAxisPixels) {
    float depth = -centerInCameraSpace.z;
    if (depth < 0.001) return false;
    // Skip blobs whose center is well outside the view. Blobs beside the camera have a tiny
    // depth, and the approximation below would stretch them across the whole screen.
    float tanHalfFovX = 1.0 / projectionMatrix[0][0];
    float tanHalfFovY = 1.0 / projectionMatrix[1][1];
    vec2 slope = centerInCameraSpace.xy / depth;   // screen position before scaling to pixels
    if (abs(slope.x) > 1.3 * tanHalfFovX || abs(slope.y) > 1.3 * tanHalfFovY) return false;
    float focalX = projectionMatrix[0][0] * viewportPixels.x * 0.5;
    float focalY = projectionMatrix[1][1] * viewportPixels.y * 0.5;
    // Jacobian of the perspective projection at the blob's center
    // (the local linear approximation used by EWA / 3D Gaussian splatting).
    mat3 projectionJacobian = mat3(
      focalX / depth, 0.0, 0.0,
      0.0, focalY / depth, 0.0,
      focalX * slope.x / depth,
      focalY * slope.y / depth,
      0.0
    );
    mat3 worldToScreen = projectionJacobian * modelViewRotation;
    mat3 covariance2D = worldToScreen * covariance3D * transpose(worldToScreen);
    float a = covariance2D[0][0] + 0.3;  // small blur keeps tiny blobs about a pixel wide
    float b = covariance2D[0][1];
    float c = covariance2D[1][1] + 0.3;
    float middle = 0.5 * (a + c);
    float radius = length(vec2(0.5 * (a - c), b));
    float majorVariance = middle + radius;
    float minorVariance = max(middle - radius, 0.1);
    vec2 majorDirection = abs(b) < 1e-6
      ? (a >= c ? vec2(1.0, 0.0) : vec2(0.0, 1.0))
      : normalize(vec2(b, majorVariance - a));
    vec2 minorDirection = vec2(-majorDirection.y, majorDirection.x);
    majorAxisPixels = majorDirection * sqrt(majorVariance) * 3.0;
    minorAxisPixels = minorDirection * sqrt(minorVariance) * 3.0;
    return true;
  }
`;

// ---------------------------------------------------------------------------
// Shared styles (inside each widget's shadow DOM, so blog CSS can't break them).
// Colors come from --splat-* variables set by the page, with fallbacks.
// ---------------------------------------------------------------------------
const SHARED_STYLES = /* css */ `
  :host {
    display: block;
    container-type: inline-size;
    margin: 28px 0;
    --text: var(--splat-text, #1f2328);
    --muted: var(--splat-muted, #6a6f76);
    --accent: var(--splat-accent, #3b74e6);
    --border: var(--splat-border, rgba(127, 127, 127, 0.28));
    --radius: var(--splat-radius, 14px);
    --ui-font: var(--splat-ui-font, system-ui, -apple-system, "Segoe UI", sans-serif);
    color: var(--text);
  }
  * { box-sizing: border-box; }
  figure { margin: 0; }
  /* One panel holds the 3D view and its controls, so they read as a single object. */
  .panel {
    position: relative; background: var(--splat-stage-bg, ${DEFAULT_STAGE_BACKGROUND});
    border-radius: var(--radius); overflow: hidden;
    /* The panel is dark in both page themes, so its controls use light colors. */
    --text: #eef0f3; --muted: #a9afb9; --border: rgba(255, 255, 255, 0.16);
    color: var(--text);
  }
  .stage {
    position: relative; aspect-ratio: var(--splat-aspect, 16 / 10);
    overflow: hidden; outline: none; color: #fff; font-family: var(--ui-font);
  }
  /* Keyboard focus on the view rings the whole panel (a ring on the view itself would be clipped). */
  .panel:has(> .stage:focus-visible) { box-shadow: 0 0 0 3px var(--accent); }
  @container (max-width: ${NARROW_BREAKPOINT_PX}px) { .stage { aspect-ratio: var(--splat-aspect-narrow, 1 / 1); } }
  .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; transition: filter 0.2s ease; }

  /* Overlay buttons on the 3D view */
  .corner { position: absolute; top: 10px; right: 10px; display: flex; gap: 6px; z-index: 3; }
  .pill {
    min-height: 38px; min-width: 38px; padding: 0 12px; border-radius: 999px; border: 0;
    background: rgba(17, 19, 23, 0.62); color: #fff; font: 500 13.5px var(--ui-font); cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; backdrop-filter: blur(6px);
  }
  .pill:hover { background: rgba(17, 19, 23, 0.85); }
  .pill.icon { padding: 0; width: 38px; font-size: 17px; }
  .pill:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* Camera controls: dimmed while inactive, framed while active. */
  .stage[data-active="false"] canvas { filter: grayscale(0.5) brightness(0.75); }
  .active-frame { position: absolute; inset: 0; z-index: 2; pointer-events: none; border-radius: inherit;
                  box-shadow: inset 0 0 0 2px var(--accent); }
  .activate-prompt { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 3;
                     min-height: 44px; padding: 0 18px; font-size: 14.5px; }
  .active-chip {
    position: absolute; left: 10px; bottom: 10px; z-index: 3; pointer-events: none;
    font: 12.5px var(--ui-font); color: rgba(255, 255, 255, 0.92);
    background: rgba(17, 19, 23, 0.62); padding: 5px 11px; border-radius: 999px; backdrop-filter: blur(6px);
  }
  .active-chip::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%;
                         background: var(--accent); margin-right: 7px; vertical-align: 1px; }
  .badge {
    position: absolute; left: 10px; top: 10px; z-index: 3; font: 12.5px var(--ui-font); color: #fff;
    background: rgba(17, 19, 23, 0.62); padding: 5px 11px; border-radius: 999px; backdrop-filter: blur(6px);
  }

  /* Controls: one quiet row along the bottom of the panel */
  .bar {
    display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; padding: 10px 12px 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.07); font-family: var(--ui-font); transition: opacity 0.2s;
  }
  /* Before the 3D opens, the bar is already there but switched off (inert, dimmed), so opening and closing
     the 3D never changes the widget's height. */
  .bar[inert] { opacity: 0.4; }
  .segmented { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; padding: 3px; gap: 2px; }
  .segmented button, .chip-toggle, .text-button {
    min-height: 34px; padding: 0 14px; border-radius: 999px; border: 0; background: transparent;
    color: var(--muted); font: 500 14px var(--ui-font); cursor: pointer;
  }
  .segmented button[aria-pressed="true"] { background: var(--accent); color: #fff; }
  .chip-toggle { border: 1px solid var(--border); }
  .chip-toggle[aria-pressed="true"] { color: var(--text); border-color: var(--accent); }
  .chip-toggle[aria-pressed="true"]::before { content: "✓ "; color: var(--accent); }
  .text-button { color: var(--accent); padding: 0 6px; }
  .spacer { flex: 1 1 auto; }
  /* Narrow (phones): shape buttons get their own full row, toggles share the next. */
  @container (max-width: ${NARROW_BREAKPOINT_PX}px) {
    .segmented { flex: 1 1 100%; }
    .segmented button { flex: 1 1 0; }
    .spacer { display: none; }
    .chip-toggle { flex: 1 1 0; }
  }
  .slider { display: flex; align-items: center; gap: 10px; flex: 1 1 260px; min-height: 40px; }
  .slider label { font-size: 14px; color: var(--muted); white-space: nowrap; }
  .slider input { flex: 1 1 auto; accent-color: var(--accent); height: 28px; }
  .slider output { font-size: 13.5px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 3.2em; text-align: right; }

  /* Optional advanced panel (blob demo, attribute "advanced") */
  details { padding: 0 12px 10px; font-family: var(--ui-font); }
  summary { cursor: pointer; color: var(--muted); font-size: 14px; min-height: 36px; display: flex; align-items: center; }
  .slider-row { display: grid; grid-template-columns: 90px 1fr 52px; gap: 10px; align-items: center; min-height: 40px; font-size: 14px; }
  .slider-row input[type=range] { width: 100%; accent-color: var(--accent); }
  .slider-row output { text-align: right; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  input[type=color] { width: 100%; height: 32px; border: 1px solid var(--border); border-radius: 8px; background: transparent; padding: 2px; }
  .numbers { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid var(--border);
             border-radius: 8px; padding: 8px 10px; white-space: pre; overflow-x: auto; margin-top: 6px; }

  /* Text around the view */
  .caption-top, .caption-bottom { font-family: var(--splat-caption-font, inherit); }
  .caption-top { margin: 0 0 10px; font-size: 1em; line-height: 1.55; }
  .caption-top:empty, .caption-bottom:empty { display: none; }
  figcaption { padding: 8px 2px 0; font-family: var(--splat-caption-font, inherit); }
  .caption-bottom { font-size: 0.92em; line-height: 1.5; color: var(--text); }
  .credit { font: 12.5px/1.5 var(--ui-font); color: var(--muted); margin-top: 4px; }
  ::slotted(a), .credit ::slotted(*) { color: inherit; }
  [hidden] { display: none !important; }

  /* Expanded ("fullscreen") mode works everywhere, including iPhone Safari,
     which has no element fullscreen API. */
  :host(.expanded) figure {
    position: fixed; inset: 0; z-index: 2147483000; background: var(--splat-stage-bg, ${DEFAULT_STAGE_BACKGROUND});
    display: flex; flex-direction: column; overflow-y: auto;
  }
  :host(.expanded) .panel { flex: 1 1 auto; display: flex; flex-direction: column; border-radius: 0; }
  :host(.expanded) .stage { aspect-ratio: auto; flex: 1 1 auto; min-height: 55vh; }
  :host(.expanded) .caption-top, :host(.expanded) figcaption { display: none; }
`;

// The blob demo's formula card (attribute formula-src). Its text size follows the widget's width (cqw: percent
// of the widget's width), between 11px and 15px, and the formula image is sized from that text, so the whole card
// scales smoothly with the screen. The card itself lets drags through to the 3D view; only its buttons take clicks.
const FORMULA_STYLES = /* css */ `
  .formula { position: absolute; left: 10px; top: 10px; z-index: 3; pointer-events: none; max-width: calc(100% - 20px); }
  .formula-card {
    font: clamp(11px, 1.9cqw, 15px) var(--ui-font); color: var(--text);
    background: rgba(17, 19, 23, 0.62); backdrop-filter: blur(6px);
    border-radius: 10px; padding: 0.6em 0.8em 0.55em;
  }
  .formula-head { display: flex; align-items: center; justify-content: space-between; gap: 0.6em;
                  font-size: 0.82em; font-weight: 600; letter-spacing: 0.02em; color: var(--muted); margin-bottom: 0.4em; }
  .formula-card img { display: block; height: 1.75em; width: auto; max-width: 100%; }
  .formula-widths { margin-top: 0.4em; font-size: 0.85em; color: var(--muted); font-variant-numeric: tabular-nums; }
  .formula-widths output { color: #9ec5fe; }
  .formula-toggle, .formula-close { display: none; pointer-events: auto; }
  .formula-close { border: 0; background: transparent; color: var(--muted); font-size: 1.1em; line-height: 1;
                   min-width: 32px; min-height: 32px; margin: -8px -8px -8px 0; cursor: pointer; }
  /* Narrow views (phones): a small button until the reader opens the card. The open card sits below the top row
     of buttons (Done, expand), which would otherwise overlap it. */
  @container (max-width: ${NARROW_BREAKPOINT_PX}px) {
    .formula-toggle { display: inline-flex; }
    .formula-close { display: inline-block; }
    .formula:not(.open) .formula-card { display: none; }
    .formula.open { top: 58px; }
    .formula.open .formula-toggle { display: none; }
  }
`;

// ---------------------------------------------------------------------------
// Small helpers shared by both widgets
// ---------------------------------------------------------------------------

// Redraw only when needed, and never while the widget is off-screen or the tab is hidden.
class RenderScheduler {
  constructor(hostElement, drawFrame) {
    this.drawFrame = drawFrame;
    this.isOnScreen = true;
    this.isPageVisible = document.visibilityState !== 'hidden';
    this.frameScheduled = false;
    this.intersectionObserver = new IntersectionObserver(entries => {
      this.isOnScreen = entries[entries.length - 1].isIntersecting;
      if (this.canRender) this.request();
    });
    this.intersectionObserver.observe(hostElement);
    this.onVisibilityChange = () => {
      this.isPageVisible = document.visibilityState !== 'hidden';
      if (this.canRender) this.request();
    };
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }
  get canRender() { return this.isOnScreen && this.isPageVisible; }
  request() {
    if (this.frameScheduled || !this.canRender) return;
    this.frameScheduled = true;
    requestAnimationFrame(time => {
      this.frameScheduled = false;
      if (!this.canRender) return;
      if (this.drawFrame(time)) this.request();
    });
  }
  dispose() {
    this.intersectionObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }
}

// Expanded mode: pin the figure over the page and stop the page from scrolling behind it.
function setExpanded(hostElement, expanded, expandButton) {
  hostElement.classList.toggle('expanded', expanded);
  document.documentElement.style.overflow = expanded ? 'hidden' : '';
  expandButton.textContent = expanded ? '⤡' : '⤢';
  expandButton.setAttribute('aria-label', expanded ? 'Exit expanded view' : 'Expand');
  expandButton.title = expanded ? 'Exit expanded view (Esc)' : 'Expand';
}

// Arrow keys orbit the camera around its target.
function orbitCameraByKeys(camera, controls, event) {
  const step = Math.PI / 24;
  const offset = camera.position.clone().sub(controls.target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  if (event.key === 'ArrowLeft') spherical.theta -= step;
  else if (event.key === 'ArrowRight') spherical.theta += step;
  else if (event.key === 'ArrowUp') spherical.phi = Math.max(0.05, spherical.phi - step);
  else if (event.key === 'ArrowDown') spherical.phi = Math.min(Math.PI - 0.05, spherical.phi + step);
  else return false;
  camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
  camera.lookAt(controls.target);
  return true;
}

// Puts the "caption" slot above or below the view, per the caption-position attribute.
function placeCaptionSlot(host) {
  const slot = host.shadowRoot.querySelector('slot[name="caption"]');
  const target = host.getAttribute('caption-position') === 'top'
    ? host.shadowRoot.querySelector('.caption-top')
    : host.shadowRoot.querySelector('.caption-bottom');
  target.append(slot);
}

// Camera controls have an explicit, visible on/off state so readers always know
// whether dragging and scrolling will move the 3D view or the page.
//   Inactive: view dimmed, "Click/Tap to interact" button, page scrolls normally.
//   Active:   full color, accent frame, "drag to rotate" label, Done button.
// Mouse: pressing on the view activates it (and the same drag already rotates).
// Touch: a tap (not a scroll gesture) activates it, so scrolling past never gets stuck.
// It turns off only when the reader acts: Done, Esc, clicking outside, or scrolling it away.
class CameraActivation {
  constructor(host, stage, activeLabel) {
    this.host = host;
    this.stage = stage;
    this.active = false;
    this.enabled = false;

    this.frame = Object.assign(document.createElement('div'), { className: 'active-frame' });
    this.prompt = Object.assign(document.createElement('button'), { className: 'pill activate-prompt',
      textContent: IS_COARSE_POINTER ? 'Tap to interact' : 'Click to interact' });
    this.chip = Object.assign(document.createElement('div'), { className: 'active-chip', textContent: activeLabel });
    this.doneButton = Object.assign(document.createElement('button'), { className: 'pill', textContent: 'Done',
      title: 'Stop controlling the 3D view (Esc)' });
    // The accent frame outlines the whole panel (view and controls); the prompt and label sit on the view.
    (stage.closest('.panel') ?? stage).append(this.frame);
    stage.append(this.prompt, this.chip);
    stage.querySelector('.corner').prepend(this.doneButton);

    this.prompt.addEventListener('click', () => this.setActive(true));
    this.doneButton.addEventListener('click', () => this.setActive(false));
    // Clicking anywhere outside this widget releases the controls.
    this.onDocumentPointerDown = event => {
      if (this.active && !event.composedPath().includes(this.host)) this.setActive(false);
    };
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    // Scrolling the widget out of view releases the controls.
    this.intersectionObserver = new IntersectionObserver(entries => {
      if (!entries[entries.length - 1].isIntersecting && !this.host.classList.contains('expanded')) this.setActive(false);
    });
    this.intersectionObserver.observe(host);

    let touchStart = null;
    this.onCanvasPointerDown = event => {
      if (this.active || !this.enabled) return;
      if (event.pointerType === 'mouse') this.setActive(true);
      else touchStart = { x: event.clientX, y: event.clientY };
    };
    this.onCanvasPointerUp = event => {
      if (this.active || !this.enabled || !touchStart) return;
      const moved = Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y);
      touchStart = null;
      if (moved < 8) this.setActive(true);
    };
    this.render();
  }

  // Attach to the current renderer canvas and camera controls (the object widget creates new ones each time it opens).
  bind(controls, canvas) {
    this.unbind();
    this.controls = controls;
    this.canvas = canvas;
    // Capture phase, so a mouse press activates the controls before they see the press: the same drag rotates.
    canvas.addEventListener('pointerdown', this.onCanvasPointerDown, true);
    canvas.addEventListener('pointerup', this.onCanvasPointerUp, true);
    this.render();
  }

  unbind() {
    this.canvas?.removeEventListener('pointerdown', this.onCanvasPointerDown, true);
    this.canvas?.removeEventListener('pointerup', this.onCanvasPointerUp, true);
    this.controls = null;
    this.canvas = null;
  }

  setEnabled(enabled) { this.enabled = enabled; if (!enabled) this.active = false; this.render(); }

  setActive(active) {
    if (active && !this.enabled) return;
    this.active = active;
    this.render();
  }

  render() {
    const shown = this.enabled;
    if (this.controls) { this.controls.enabled = this.active; this.controls.enableZoom = this.active; }
    if (this.canvas) this.canvas.style.touchAction = this.active ? 'none' : 'pan-y';
    if (shown) this.stage.dataset.active = String(this.active); else delete this.stage.dataset.active;
    this.frame.hidden = !(shown && this.active);
    this.chip.hidden = !(shown && this.active);
    this.doneButton.hidden = !(shown && this.active);
    this.prompt.hidden = !(shown && !this.active);
  }

  dispose() {
    this.unbind();
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    this.intersectionObserver.disconnect();
  }
}

const ACTIVE_LABEL = IS_COARSE_POINTER ? 'Drag to rotate · pinch to zoom' : 'Drag to rotate · scroll to zoom';

// ===========================================================================
// <splat-blob-demo>: one blob you can reshape
// ===========================================================================
class SplatBlobDemo extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>${SHARED_STYLES}${FORMULA_STYLES}</style>
      <figure>
        <div class="caption-top"></div>
        <div class="panel">
          <div class="stage" tabindex="0" aria-label="One Gaussian blob. Use arrow keys to rotate.">
            <div class="formula" data-role="formula" hidden>
              <button class="pill formula-toggle" data-role="formulaToggle" aria-expanded="false">ƒ Gaussian shape</button>
              <div class="formula-card">
                <div class="formula-head">
                  <span>Gaussian Shape Formula:</span>
                  <button class="formula-close" data-role="formulaClose" aria-label="Hide the formula">✕</button>
                </div>
                <img data-role="formulaImage" alt="alpha of x equals o times the exponential of minus one half times (x minus mu) transposed, times Sigma inverse, times (x minus mu)">
                <div class="formula-widths">widths <output data-role="formulaWidths"></output></div>
              </div>
            </div>
            <div class="corner">
              <button class="pill icon" data-role="expand" aria-label="Expand" title="Expand">⤢</button>
            </div>
          </div>
          <div class="bar">
            <div class="segmented" role="group" aria-label="Shape">
              <button data-preset="ball" aria-pressed="true">Ball</button>
              <button data-preset="pancake" aria-pressed="false">Pancake</button>
              <button data-preset="needle" aria-pressed="false">Needle</button>
            </div>
            <span class="spacer"></span>
            <button class="chip-toggle" data-toggle="outline" aria-pressed="true">Outline</button>
            <button class="chip-toggle" data-toggle="angleColor" aria-pressed="true">Color by angle</button>
          </div>
          <details data-role="advanced" hidden>
            <summary>Adjust shape and color</summary>
            <div class="slider-row"><label for="scaleX">Width</label><input id="scaleX" type="range" min="0" max="1000"><output data-for="scaleX"></output></div>
            <div class="slider-row"><label for="scaleY">Height</label><input id="scaleY" type="range" min="0" max="1000"><output data-for="scaleY"></output></div>
            <div class="slider-row"><label for="scaleZ">Depth</label><input id="scaleZ" type="range" min="0" max="1000"><output data-for="scaleZ"></output></div>
            <div class="slider-row"><label for="tilt">Tilt</label><input id="tilt" type="range" min="-90" max="90"><output data-for="tilt"></output></div>
            <div class="slider-row"><label for="turn">Turn</label><input id="turn" type="range" min="-180" max="180"><output data-for="turn"></output></div>
            <div class="slider-row"><label for="opacity">Opacity</label><input id="opacity" type="range" min="0" max="100"><output data-for="opacity"></output></div>
            <div class="slider-row"><label for="color">Color</label><input id="color" type="color"><output></output></div>
            <div class="slider-row" data-role="backColorRow"><label for="backColor">From behind</label><input id="backColor" type="color"><output></output></div>
            <div class="numbers" data-role="numbers"></div>
          </details>
        </div>
        <figcaption>
          <div class="caption-bottom"><slot name="caption"></slot></div>
          <div class="credit"><slot name="credit"></slot></div>
        </figcaption>
      </figure>`;
    placeCaptionSlot(this);
    this.$('[data-role="advanced"]').hidden = !this.hasAttribute('advanced');
    if (this.getAttribute('formula-src')) {
      this.$('[data-role="formula"]').hidden = false;
      this.$('[data-role="formulaImage"]').src = this.getAttribute('formula-src');
    }
    this.buildScene();
    this.bindControls();
  }

  disconnectedCallback() {
    // Release the WebGL context too, so pages that swap content don't pile up contexts.
    this.scheduler?.dispose();
    this.activation?.dispose();
    this.resizeObserver?.disconnect();
    window.removeEventListener('keydown', this.onWindowKeydown);
    this.controls?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
  }

  $(selector) { return this.shadowRoot.querySelector(selector); }

  buildScene() {
    const MIN_SCALE = 0.02, MAX_SCALE = 1.5;
    this.sliderToScale = value => MIN_SCALE * Math.pow(MAX_SCALE / MIN_SCALE, value / 1000);
    this.scaleToSlider = scale => Math.round(1000 * Math.log(scale / MIN_SCALE) / Math.log(MAX_SCALE / MIN_SCALE));
    this.state = {
      preset: 'ball', scale: new THREE.Vector3(0.5, 0.5, 0.5), tilt: 0, turn: 0, color: '#ff7a45', backColor: '#3b7bff',
      opacity: 0.9, outline: true, angleColor: true,
    };

    this.stage = this.$('.stage');
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
    this.stage.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(readStageBackground(this));
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.camera.position.set(2.4, 1.5, 3.2);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !PREFERS_REDUCED_MOTION;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 12;

    const grid = new THREE.GridHelper(10, 20, 0x4a5262, 0x262b34);
    grid.position.y = -1.6;
    this.scene.add(grid);

    this.uniforms = {
      uCovariance3D: { value: new THREE.Matrix3() },
      uViewportPixels: { value: new THREE.Vector2(1, 1) },
      uFrontColor: { value: new THREE.Color() },
      uBackColor: { value: new THREE.Color() },
      uLocalForward: { value: new THREE.Vector3(0, 0, 1) },
      uAngleColorAmount: { value: 0 },
      uOpacity: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthTest: false, depthWrite: false,
      vertexShader: /* glsl */ `
        uniform mat3 uCovariance3D;
        uniform vec2 uViewportPixels;
        uniform vec3 uFrontColor, uBackColor, uLocalForward;
        uniform float uAngleColorAmount;
        varying vec2 vSigmaPosition;
        varying vec3 vColor;
        ${PROJECT_GAUSSIAN_GLSL}
        void main() {
          vec4 centerInCameraSpace = viewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec2 majorAxisPixels, minorAxisPixels;
          if (!projectGaussian(centerInCameraSpace, uCovariance3D, mat3(viewMatrix), uViewportPixels, majorAxisPixels, minorAxisPixels)) {
            gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
            return;
          }
          vec4 clipPosition = projectionMatrix * centerInCameraSpace;
          clipPosition.xy += (position.x * majorAxisPixels + position.y * minorAxisPixels) / (uViewportPixels * 0.5) * clipPosition.w;
          gl_Position = clipPosition;
          vSigmaPosition = position.xy * 3.0;
          // Simplified angle-dependent color: front color blends to back color
          // depending on which side of the blob the camera is on.
          float behindAmount = 0.5 - 0.5 * dot(normalize(cameraPosition), uLocalForward);
          vColor = mix(uFrontColor, uBackColor, behindAmount * uAngleColorAmount);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying vec2 vSigmaPosition;
        varying vec3 vColor;
        void main() {
          float alpha = uOpacity * exp(-0.5 * dot(vSigmaPosition, vSigmaPosition));
          if (alpha < 1.0 / 255.0) discard;
          gl_FragColor = vec4(vColor, alpha);
          #include <colorspace_fragment>
        }`,
    });
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    blob.frustumCulled = false;
    blob.renderOrder = 1;
    this.scene.add(blob);

    // Outline at two standard deviations, where the fog has faded to about 14%.
    this.outline = new THREE.Group();
    const ringPoints = Array.from({ length: 97 }, (_, i) => {
      const angle = (i / 96) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
    });
    for (const rotation of [[0, 0, 0], [Math.PI / 2, 0, 0], [0, Math.PI / 2, 0]]) {
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthTest: false }));
      ring.rotation.set(...rotation);
      ring.renderOrder = 2;
      this.outline.add(ring);
    }
    for (const [direction, color] of [[[1, 0, 0], 0xff5a5a], [[0, 1, 0], 0x5adc78], [[0, 0, 1], 0x5a9bff]]) {
      const axis = new THREE.Vector3(...direction);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([axis.clone().negate(), axis]),
        new THREE.LineBasicMaterial({ color, depthTest: false }));
      line.renderOrder = 2;
      this.outline.add(line);
    }
    this.scene.add(this.outline);

    this.scheduler = new RenderScheduler(this, () => {
      const moving = this.controls.update();
      this.renderer.render(this.scene, this.camera);
      return moving;
    });
    this.controls.addEventListener('change', () => this.scheduler.request());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);

    // Starts inactive (dimmed) until the reader clicks or taps it.
    this.activation = new CameraActivation(this, this.stage, ACTIVE_LABEL);
    this.activation.bind(this.controls, this.renderer.domElement);
    this.activation.setEnabled(true);
  }

  resize() {
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.getDrawingBufferSize(this.uniforms.uViewportPixels.value);
    this.scheduler.request();
  }

  bindControls() {
    const PRESETS = {
      ball:    { scale: [0.5, 0.5, 0.5],   tilt: 0,  turn: 0 },
      pancake: { scale: [0.8, 0.04, 0.6],  tilt: 15, turn: 30 },
      needle:  { scale: [1.0, 0.04, 0.04], tilt: 25, turn: -20 },
    };
    const sliders = Object.fromEntries(['scaleX', 'scaleY', 'scaleZ', 'tilt', 'turn', 'opacity', 'color', 'backColor']
      .map(id => [id, this.$(`#${id}`)]));
    const syncSliders = () => {
      sliders.scaleX.value = this.scaleToSlider(this.state.scale.x);
      sliders.scaleY.value = this.scaleToSlider(this.state.scale.y);
      sliders.scaleZ.value = this.scaleToSlider(this.state.scale.z);
      sliders.tilt.value = this.state.tilt;
      sliders.turn.value = this.state.turn;
      sliders.opacity.value = Math.round(this.state.opacity * 100);
      sliders.color.value = this.state.color;
      sliders.backColor.value = this.state.backColor;
    };
    // Moving a shape slider means the shape is no longer exactly a preset.
    const bind = (id, apply, clearsPreset) => sliders[id].addEventListener('input', () => {
      apply(sliders[id].value);
      if (clearsPreset) this.state.preset = null;
      this.apply();
    });
    bind('scaleX', v => { this.state.scale.x = this.sliderToScale(Number(v)); }, true);
    bind('scaleY', v => { this.state.scale.y = this.sliderToScale(Number(v)); }, true);
    bind('scaleZ', v => { this.state.scale.z = this.sliderToScale(Number(v)); }, true);
    bind('tilt', v => { this.state.tilt = Number(v); }, true);
    bind('turn', v => { this.state.turn = Number(v); }, true);
    bind('opacity', v => { this.state.opacity = Number(v) / 100; }, false);
    bind('color', v => { this.state.color = v; }, false);
    bind('backColor', v => { this.state.backColor = v; }, false);

    this.shadowRoot.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
      const preset = PRESETS[button.dataset.preset];
      this.state.preset = button.dataset.preset;
      this.state.scale.set(...preset.scale);
      this.state.tilt = preset.tilt;
      this.state.turn = preset.turn;
      syncSliders(); this.apply();
    }));
    this.shadowRoot.querySelectorAll('[data-toggle]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.toggle;
      this.state[key] = !this.state[key];
      this.apply();
    }));

    const formula = this.$('[data-role="formula"]');
    const formulaToggle = this.$('[data-role="formulaToggle"]');
    const setFormulaOpen = open => {
      formula.classList.toggle('open', open);
      formulaToggle.setAttribute('aria-expanded', String(open));
    };
    formulaToggle.addEventListener('click', () => setFormulaOpen(true));
    this.$('[data-role="formulaClose"]').addEventListener('click', () => setFormulaOpen(false));

    const expandButton = this.$('[data-role="expand"]');
    expandButton.addEventListener('click', () => {
      const expanding = !this.classList.contains('expanded');
      setExpanded(this, expanding, expandButton);
      if (expanding) this.activation.setActive(true);
    });
    this.stage.addEventListener('keydown', event => {
      if (orbitCameraByKeys(this.camera, this.controls, event)) { event.preventDefault(); this.scheduler.request(); }
    });
    // Esc: first leave expanded view, then release the controls.
    this.onWindowKeydown = event => {
      if (event.key !== 'Escape') return;
      if (this.classList.contains('expanded')) setExpanded(this, false, expandButton);
      else if (this.activation.active) this.activation.setActive(false);
    };
    window.addEventListener('keydown', this.onWindowKeydown);

    syncSliders();
    this.apply();
  }

  apply() {
    const degreesToRadians = Math.PI / 180;
    const rotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, this.state.turn * degreesToRadians, this.state.tilt * degreesToRadians, 'YZX'));
    // Spread (covariance) = R · S · Sᵀ · Rᵀ
    const rotationMatrix = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(rotation));
    const scaleMatrix = new THREE.Matrix3().set(this.state.scale.x, 0, 0, 0, this.state.scale.y, 0, 0, 0, this.state.scale.z);
    const rotationTimesScale = rotationMatrix.clone().multiply(scaleMatrix);
    this.uniforms.uCovariance3D.value.copy(rotationTimesScale.clone().multiply(rotationTimesScale.clone().transpose()));
    this.uniforms.uFrontColor.value.set(this.state.color);
    this.uniforms.uBackColor.value.set(this.state.backColor);
    this.uniforms.uLocalForward.value.set(0, 0, 1).applyQuaternion(rotation);
    this.uniforms.uAngleColorAmount.value = this.state.angleColor ? 1 : 0;
    this.uniforms.uOpacity.value = this.state.opacity;
    this.outline.visible = this.state.outline;
    this.outline.quaternion.copy(rotation);
    this.outline.scale.copy(this.state.scale).multiplyScalar(2);

    this.shadowRoot.querySelectorAll('[data-preset]').forEach(button =>
      button.setAttribute('aria-pressed', String(button.dataset.preset === this.state.preset)));
    this.shadowRoot.querySelectorAll('[data-toggle]').forEach(button =>
      button.setAttribute('aria-pressed', String(this.state[button.dataset.toggle])));
    this.$('[data-role="formulaWidths"]').textContent =
      [this.state.scale.x, this.state.scale.y, this.state.scale.z].map(width => width.toFixed(2)).join(' · ');

    if (this.hasAttribute('advanced')) {
      this.$('[data-role="backColorRow"]').style.opacity = this.state.angleColor ? 1 : 0.45;
      const outputs = {
        scaleX: this.state.scale.x.toFixed(2), scaleY: this.state.scale.y.toFixed(2), scaleZ: this.state.scale.z.toFixed(2),
        tilt: `${this.state.tilt}°`, turn: `${this.state.turn}°`, opacity: `${Math.round(this.state.opacity * 100)}%`,
      };
      for (const [id, text] of Object.entries(outputs)) this.$(`output[data-for="${id}"]`).textContent = text;
      const color = new THREE.Color(this.state.color).getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
      const f = v => (v >= 0 ? ' ' : '') + v.toFixed(2);
      this.$('[data-role="numbers"]').textContent = [
        'What this blob stores:',
        `position ${f(0)} ${f(0)} ${f(0)}`,
        `scale    ${f(this.state.scale.x)} ${f(this.state.scale.y)} ${f(this.state.scale.z)}`,
        `rotation ${f(rotation.x)} ${f(rotation.y)} ${f(rotation.z)} ${f(rotation.w)}`,
        `opacity  ${f(this.state.opacity)}`,
        `color    ${f(color.r)} ${f(color.g)} ${f(color.b)}`,
        '= 14 numbers. Real files often add up to',
        '45 more for color by angle (59 in total).',
      ].join('\n');
    }
    this.scheduler?.request();
  }
}

// ===========================================================================
// <splat-object-demo>: a real object made of many blobs. Starts OFF.
// ===========================================================================
const activeObjectDemos = new Set();

class SplatObjectDemo extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>${SHARED_STYLES}
        .poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
                  gap: 10px; z-index: 2; text-align: center; padding: 16px; }
        .explore { min-height: 48px; padding: 0 22px; font-size: 15.5px; font-weight: 600; background: rgba(17, 19, 23, 0.72); }
        .explore::before { content: ""; border-style: solid; border-width: 6px 0 6px 10px; border-color: transparent transparent transparent #fff; margin-right: 4px; }
        .explore .size { font-weight: 400; opacity: 0.75; margin-left: 2px; }
        .subtle { font-size: 12.5px; color: rgba(255, 255, 255, 0.85); text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7); }
        .progress { width: min(240px, 66%); height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.22); overflow: hidden; }
        .progress > div { height: 100%; width: 0%; background: #fff; transition: width 0.15s; }
        .dim .poster { filter: brightness(0.5); }
        /* "Load sharper version" sits in the bar when there's room. On narrow widgets it would wrap onto a
           second row and make the widget taller, so a copy on the view is used instead: bottom-right, lifted above
           the "drag to rotate" label's row so the two never overlap. */
        .upgrade-overlay { position: absolute; right: 10px; bottom: 48px; z-index: 3; }
        @container (min-width: ${NARROW_BREAKPOINT_PX + 1}px) { .upgrade-overlay { display: none; } }
        @container (max-width: ${NARROW_BREAKPOINT_PX}px) { .bar [data-role="betterQuality"] { display: none; } }
      </style>
      <figure>
        <div class="caption-top"></div>
        <div class="panel">
          <div class="stage" tabindex="-1" aria-label="Interactive 3D object made of Gaussian splats">
            <img class="poster" alt="" data-role="poster">
            <div class="center" data-role="offPanel">
              <button class="pill explore" data-role="explore">Explore in 3D<span class="size" data-role="sizeNote"></span></button>
            </div>
            <div class="center" data-role="loadingPanel" hidden>
              <div class="subtle" data-role="loadingText" aria-live="polite">Loading…</div>
              <div class="progress"><div data-role="progressBar"></div></div>
              <button class="pill" data-role="cancel">Cancel</button>
            </div>
            <div class="center" data-role="unsupportedPanel" hidden>
              <div class="subtle" data-role="unsupportedText"></div>
            </div>
            <div class="badge" data-role="badge" hidden></div>
            <button class="pill upgrade-overlay" data-role="betterQualityOverlay" hidden>Load sharper version</button>
            <div class="corner" data-role="corner" hidden>
              <button class="pill icon" data-role="resetView" aria-label="Reset view" title="Reset view">↺</button>
              <button class="pill icon" data-role="expand" aria-label="Expand" title="Expand">⤢</button>
              <button class="pill icon" data-role="close" aria-label="Close 3D" title="Close 3D (Esc)">✕</button>
            </div>
          </div>
          <div class="bar" data-role="controls" inert>
            <div class="slider">
              <label for="blobSize">Blob size</label>
              <input id="blobSize" type="range" min="1" max="100" value="100" aria-valuetext="100%">
              <output data-for="blobSize">100%</output>
            </div>
            <button class="text-button" data-role="betterQuality" hidden>Load sharper version</button>
          </div>
        </div>
        <figcaption>
          <div class="caption-bottom"><slot name="caption"></slot></div>
          <div class="credit"><slot name="credit"></slot></div>
        </figcaption>
      </figure>`;
    placeCaptionSlot(this);

    this.stage = this.$('.stage');
    this.state = 'off';
    this.activation = new CameraActivation(this, this.stage, ACTIVE_LABEL);
    const poster = this.$('[data-role="poster"]');
    if (this.getAttribute('poster')) poster.src = this.getAttribute('poster'); else poster.hidden = true;
    this.$('[data-role="sizeNote"]').textContent = this.getAttribute('download-size') ? `· ${this.getAttribute('download-size')}` : '';
    this.bindStaticControls();
  }

  disconnectedCallback() {
    this.close({ keepSnapshot: false });
    this.activation.dispose();
    window.removeEventListener('keydown', this.onWindowKeydown);
  }

  $(selector) { return this.shadowRoot.querySelector(selector); }

  showPanel(name) {
    for (const panel of ['offPanel', 'loadingPanel', 'unsupportedPanel']) this.$(`[data-role="${panel}"]`).hidden = panel !== name;
    this.stage.classList.toggle('dim', name === 'loadingPanel' || name === 'unsupportedPanel');
  }

  setBadge(text) {
    const badge = this.$('[data-role="badge"]');
    badge.hidden = !text;
    badge.textContent = text || '';
  }

  setBlobSizeReadout(percent) {
    this.$('#blobSize').value = percent;
    this.$('#blobSize').setAttribute('aria-valuetext', `${percent}%`);
    this.$('output[data-for="blobSize"]').textContent = `${percent}%`;
  }

  bindStaticControls() {
    this.$('[data-role="explore"]').addEventListener('click', () => this.activate());
    this.$('[data-role="cancel"]').addEventListener('click', () => this.close({ keepSnapshot: false }));
    this.$('[data-role="close"]').addEventListener('click', () => this.close({ keepSnapshot: true }));
    this.$('[data-role="resetView"]').addEventListener('click', () => { this.view?.frameObject(); this.view?.scheduler.request(); });
    const expandButton = this.$('[data-role="expand"]');
    // Re-fit the framing after the view changes shape, once the layout has settled.
    const toggleExpanded = expanded => {
      setExpanded(this, expanded, expandButton);
      requestAnimationFrame(() => { this.view?.resize(); this.view?.frameObject(); this.view?.scheduler.request(); });
    };
    expandButton.addEventListener('click', () => {
      const expanding = !this.classList.contains('expanded');
      toggleExpanded(expanding);
      if (expanding) this.activation.setActive(true);
    });
    // Esc: leave expanded view, then release the controls, then close the 3D.
    this.onWindowKeydown = event => {
      if (event.key !== 'Escape') return;
      if (this.classList.contains('expanded')) { toggleExpanded(false); return; }
      if (this.activation.active) { this.activation.setActive(false); return; }
      if ((this.state === 'on' || this.state === 'loading') && this.matches(':focus-within')) this.close({ keepSnapshot: this.state === 'on' });
    };
    window.addEventListener('keydown', this.onWindowKeydown);

    this.$('#blobSize').addEventListener('input', event => {
      if (!this.view) return;
      const percent = Number(event.target.value);
      this.view.uniforms.uSizeMultiplier.value = percent / 100;
      this.setBlobSizeReadout(percent);
      this.view.scheduler.request();
    });
    this.stage.addEventListener('keydown', event => {
      if (this.view && orbitCameraByKeys(this.view.camera, this.view.controls, event)) { event.preventDefault(); this.view.scheduler.request(); }
    });
  }

  // OFF → LOADING → ON
  async activate() {
    for (const other of activeObjectDemos) if (other !== this) other.close({ keepSnapshot: true });
    activeObjectDemos.add(this);
    this.state = 'loading';
    this.abortController = new AbortController();
    this.showPanel('loadingPanel');

    try {
      this.view = new SplatView(this);
    } catch (error) {
      this.showUnsupported('3D isn\'t available on this device or browser. The still image shows what it looks like.');
      return;
    }
    try {
      await this.loadQuality('preview');
      if (this.state !== 'loading') return;
      this.state = 'on';
      this.showPanel(null);
      this.$('[data-role="corner"]').hidden = false;
      this.$('[data-role="controls"]').inert = false;
      // The reader just asked for the 3D, so the controls start active.
      this.activation.bind(this.view.controls, this.view.renderer.domElement);
      this.activation.setEnabled(true);
      this.activation.setActive(true);
      this.stage.tabIndex = 0;
      this.stage.focus({ preventScroll: true });
      this.decideUpgrade();
    } catch (error) {
      if (error.name === 'AbortError') return;
      this.showUnsupported(`Couldn't load the 3D file (${error.message}).`);
    }
  }

  showUnsupported(text) {
    this.view?.dispose();
    this.view = null;
    this.state = 'unsupported';
    activeObjectDemos.delete(this);
    this.showPanel('unsupportedPanel');
    this.$('[data-role="unsupportedText"]').textContent = text;
  }

  // Measure smoothness for ~2 seconds, then decide whether to fetch better quality.
  async decideUpgrade() {
    if (!this.getAttribute('default-src')) return;
    if (prefersLightLoading()) { this.offerManualUpgrade(); return; }
    const medianFrameMs = await this.view.measureFrameTime(2000);
    if (this.state !== 'on') return;
    if (medianFrameMs <= 34) {
      await this.loadQuality('default').catch(() => {});
    } else {
      this.view.lowerResolution();
      this.offerManualUpgrade();
    }
  }

  // Both copies of the button are unhidden; CSS shows the one that fits the widget's width.
  offerManualUpgrade() {
    const buttons = [this.$('[data-role="betterQuality"]'), this.$('[data-role="betterQualityOverlay"]')];
    const upgrade = () => { for (const button of buttons) button.hidden = true; this.loadQuality('default').catch(() => {}); };
    for (const button of buttons) { button.hidden = false; button.onclick = upgrade; }
  }

  async loadQuality(level) {
    const source = this.getAttribute(`${level}-src`);
    if (!source || !this.view) return;
    const isFirstLoad = level === 'preview';
    const onProgress = (received, total) => {
      const fraction = total ? received / total : 0;
      if (isFirstLoad) {
        this.$('[data-role="progressBar"]').style.width = `${Math.round(fraction * 100)}%`;
        this.$('[data-role="loadingText"]').textContent = total
          ? `Loading ${formatMegabytes(received)} of ${formatMegabytes(total)}`
          : `Loading ${formatMegabytes(received)}`;
      } else {
        this.setBadge(`Sharpening… ${Math.round(fraction * 100)}%`);
      }
    };
    const buffer = await fetchWithProgress(source, this.abortController.signal, onProgress);
    if (!this.view) return;
    if (isFirstLoad) this.$('[data-role="loadingText"]').textContent = 'Unpacking…';
    await this.view.loadBuffer(buffer, source, { frame: isFirstLoad, flip: this.hasAttribute('flip') });
    if (!this.view) return;
    this.setBadge('');
  }

  // ON → OFF: release everything and go back to the poster.
  close({ keepSnapshot }) {
    if (this.state === 'off') return;
    this.abortController?.abort();
    if (this.view) {
      if (keepSnapshot && this.state === 'on') {
        const snapshot = this.view.snapshot();
        if (snapshot) { this.$('[data-role="poster"]').src = snapshot; this.$('[data-role="poster"]').hidden = false; }
      }
      this.view.dispose();
      this.view = null;
    }
    activeObjectDemos.delete(this);
    this.state = 'off';
    if (this.classList.contains('expanded')) setExpanded(this, false, this.$('[data-role="expand"]'));
    this.showPanel('offPanel');
    this.activation.unbind();
    this.activation.setEnabled(false);
    for (const role of ['corner', 'betterQuality', 'betterQualityOverlay']) this.$(`[data-role="${role}"]`).hidden = true;
    this.$('[data-role="controls"]').inert = true;
    this.$('[data-role="progressBar"]').style.width = '0%';
    this.setBlobSizeReadout(100);
    this.setBadge('');
    this.stage.tabIndex = -1;
    this.$('[data-role="explore"]').focus({ preventScroll: true });
  }

  // Developer helper: render the current view and return it as an image (for making posters).
  capturePosterDataUrl() { return this.view?.snapshot('image/jpeg', 0.85) || null; }
}

function formatMegabytes(bytes) { return `${(bytes / 1e6).toFixed(1)} MB`; }

async function fetchWithProgress(url, signal, onProgress) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body) { const buffer = await response.arrayBuffer(); onProgress(buffer.byteLength, buffer.byteLength); return buffer; }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received, total);
  }
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return combined.buffer;
}

function parseVectorAttribute(element, name) {
  const value = element.getAttribute(name);
  if (!value) return null;
  const numbers = value.split(',').map(Number);
  return numbers.length === 3 && numbers.every(Number.isFinite) ? new THREE.Vector3(...numbers) : null;
}

// ---------------------------------------------------------------------------
// SplatView: everything that exists only while the object widget is ON.
// Created on Explore, fully released on Close.
// ---------------------------------------------------------------------------
class SplatView {
  constructor(demo) {
    this.demo = demo;
    this.stage = demo.stage;
    // Refuse slow software rendering instead of crawling along at a few frames per second.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, failIfMajorPerformanceCaveat: true, powerPreference: 'high-performance' });
    this.pixelRatio = Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.stage.insertBefore(this.renderer.domElement, this.demo.$('.center'));
    this.maxTextureSize = this.renderer.capabilities.maxTextureSize;
    this.textureWidth = Math.min(4096, this.maxTextureSize);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(readStageBackground(demo));
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !PREFERS_REDUCED_MOTION;
    this.controls.enablePan = false;

    this.uniforms = {
      uCenterTexture: { value: null }, uCovarianceTextureA: { value: null }, uCovarianceTextureB: { value: null },
      uColorTexture: { value: null }, uAngleColorTexture: { value: null },
      uTextureWidth: { value: this.textureWidth }, uViewportPixels: { value: new THREE.Vector2(1, 1) },
      uSizeMultiplier: { value: 1 }, uAngleColorDegree: { value: 0 },
      uObjectRotationInverse: { value: new THREE.Matrix3() },
    };
    this.generation = 0;
    this.measuring = false;

    this.worker = new Worker(new URL('./splat-worker.js', import.meta.url));
    this.pendingDecodes = new Map();
    this.sortInFlight = false;
    this.lastSortedModelView = null;
    this.worker.onmessage = event => this.onWorkerMessage(event.data);

    this.scheduler = new RenderScheduler(demo, time => this.drawFrame(time));
    this.controls.addEventListener('change', () => this.scheduler.request());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
  }

  get count() { return this.splats?.count || 0; }

  onWorkerMessage(message) {
    if (message.type === 'sorted') {
      this.sortInFlight = false;
      if (message.order && this.mesh && message.generation === this.generation) {
        const attribute = this.mesh.geometry.getAttribute('splatIndex');
        if (attribute.array.length === message.order.length) {
          attribute.array = message.order;
          attribute.needsUpdate = true;
          this.scheduler.request();
        }
      }
      return;
    }
    const pending = this.pendingDecodes.get(message.generation);
    if (!pending) return;
    this.pendingDecodes.delete(message.generation);
    if (message.type === 'error') pending.reject(new Error(message.message));
    else pending.resolve(message);
  }

  async loadBuffer(buffer, fileName, { frame, flip }) {
    const generation = this.generation + 1;
    const decoded = await new Promise((resolve, reject) => {
      this.pendingDecodes.set(generation, { resolve, reject });
      this.worker.postMessage({ type: 'decode', generation, buffer, fileName, textureWidth: this.textureWidth, maxTextureSize: this.maxTextureSize }, [buffer]);
    });
    if (!this.renderer) return;
    this.generation = generation;
    this.splats = decoded;
    this.buildMesh(decoded);
    this.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), flip ? Math.PI : 0);
    this.mesh.updateMatrixWorld();
    this.uniforms.uObjectRotationInverse.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(this.mesh.quaternion.clone().invert()));
    this.sortInFlight = false;
    this.lastSortedModelView = null;
    if (frame) this.frameObject();
    this.resize();
    this.scheduler.request();
  }

  buildMesh(decoded) {
    const width = decoded.textureWidth;
    const makeTexture = (data, type) => {
      const texture = new THREE.DataTexture(data, width, data.length / 4 / width, THREE.RGBAFormat, type);
      texture.minFilter = texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      return texture;
    };
    this.disposeTextures();
    this.uniforms.uCenterTexture.value = makeTexture(decoded.centerData, THREE.FloatType);
    this.uniforms.uCovarianceTextureA.value = makeTexture(decoded.covarianceDataA, THREE.FloatType);
    this.uniforms.uCovarianceTextureB.value = makeTexture(decoded.covarianceDataB, THREE.FloatType);
    this.uniforms.uColorTexture.value = makeTexture(decoded.colorData, THREE.FloatType);
    this.uniforms.uAngleColorTexture.value = decoded.angleColorData
      ? makeTexture(decoded.angleColorData, THREE.UnsignedByteType)
      : (() => { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1); t.needsUpdate = true; return t; })();
    // Color that changes with viewing angle is always on when the file has it.
    this.uniforms.uAngleColorDegree.value = decoded.angleColorDegree;

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const order = new Float32Array(decoded.count);
    for (let i = 0; i < decoded.count; i++) order[i] = i;
    const orderAttribute = new THREE.InstancedBufferAttribute(order, 1);
    orderAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('splatIndex', orderAttribute);
    geometry.instanceCount = decoded.count;

    const previousQuaternion = this.mesh?.quaternion.clone();
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
    this.mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: OBJECT_VERTEX_SHADER, fragmentShader: OBJECT_FRAGMENT_SHADER,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.NormalBlending,
    }));
    this.mesh.frustumCulled = false;
    if (previousQuaternion) this.mesh.quaternion.copy(previousQuaternion);
    this.scene.add(this.mesh);
  }

  // Default: aim at the dense middle of the object, ignoring stray outlier blobs.
  // The view-target / view-distance / view-direction attributes override this.
  frameObject() {
    if (!this.splats || !this.mesh) return;
    const { count, positions, opacities } = this.splats;
    const step = Math.max(1, Math.floor(count / 40000));
    const sample = [];
    for (let i = 0; i < count; i += step) {
      if (opacities[i] > 0.3) sample.push(new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
    }
    const median = axis => { const v = sample.map(p => p.getComponent(axis)).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] ?? 0; };
    const center = parseVectorAttribute(this.demo, 'view-target') || new THREE.Vector3(median(0), median(1), median(2));
    const distances = sample.map(p => p.distanceTo(center)).sort((a, b) => a - b);
    const radius = distances[Math.floor(distances.length * 0.97)] || 1;
    this.mesh.updateMatrixWorld();
    const worldCenter = center.clone().applyMatrix4(this.mesh.matrixWorld);
    this.controls.target.copy(worldCenter);

    // Find how far back the camera must sit so that nearly every blob fits
    // inside both the width and the height of the view.
    const viewDirection = (parseVectorAttribute(this.demo, 'view-direction') || new THREE.Vector3(0, 0.5, 1)).normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(viewDirection).normalize();
    const up = viewDirection.clone().cross(right).normalize();
    const aspect = this.stage.clientWidth / Math.max(1, this.stage.clientHeight) || 1.6;
    const margin = 0.88;                                                  // use 88% of the view
    const tanVertical = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * margin;
    const tanHorizontal = tanVertical * aspect;
    const required = sample.map(point => {
      const offset = point.clone().applyMatrix4(this.mesh.matrixWorld).sub(worldCenter);
      const towardCamera = offset.dot(viewDirection);
      return Math.max(towardCamera + Math.abs(offset.dot(right)) / tanHorizontal,
                      towardCamera + Math.abs(offset.dot(up)) / tanVertical);
    }).sort((a, b) => a - b);
    const configuredDistance = Number(this.demo.getAttribute('view-distance'));
    // A configured distance is for the wide shape; narrow views need to sit a little further back.
    const distance = configuredDistance > 0
      ? configuredDistance * Math.max(1, 1.6 / aspect)
      : required[Math.floor(required.length * 0.98)] || radius * 3;
    this.camera.position.copy(worldCenter).add(viewDirection.clone().multiplyScalar(distance));
    this.camera.near = Math.min(radius, distance) / 300;
    this.camera.far = Math.max(radius, distance) * 200;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = Math.min(radius, distance) * 0.03;
    this.controls.maxDistance = Math.max(radius, distance) * 6;
    this.controls.update();
    this.objectRadius = radius;
  }

  resize() {
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    if (!width || !height || !this.renderer) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.getDrawingBufferSize(this.uniforms.uViewportPixels.value);
    this.scheduler.request();
  }

  lowerResolution() {
    this.pixelRatio = 1;
    this.renderer.setPixelRatio(1);
    this.resize();
  }

  drawFrame(time) {
    if (!this.renderer) return false;
    const moving = this.controls.update();
    this.requestSortIfNeeded();
    this.renderer.render(this.scene, this.camera);
    if (this.measuring) this.frameTimes.push(time);
    return moving || this.measuring;
  }

  measureFrameTime(durationMs) {
    this.measuring = true;
    this.frameTimes = [];
    this.scheduler.request();
    return new Promise(resolve => setTimeout(() => {
      this.measuring = false;
      const intervals = [];
      for (let i = 1; i < this.frameTimes.length; i++) intervals.push(this.frameTimes[i] - this.frameTimes[i - 1]);
      intervals.sort((a, b) => a - b);
      resolve(intervals.length ? intervals[Math.floor(intervals.length / 2)] : 999);
    }, durationMs));
  }

  requestSortIfNeeded() {
    if (!this.mesh || this.sortInFlight) return;
    this.mesh.updateMatrixWorld();
    this.camera.updateMatrixWorld();
    const modelView = new THREE.Matrix4().multiplyMatrices(this.camera.matrixWorldInverse, this.mesh.matrixWorld).elements;
    if (this.lastSortedModelView) {
      let change = 0;
      for (const k of [2, 6, 10, 14]) change += Math.abs(modelView[k] - this.lastSortedModelView[k]);
      if (change < 0.002 * (this.objectRadius || 1)) return;
    }
    this.lastSortedModelView = modelView.slice();
    this.sortInFlight = true;
    this.worker.postMessage({ type: 'sort', generation: this.generation, modelView: modelView.slice() });
  }

  snapshot(type = 'image/jpeg', quality = 0.85) {
    if (!this.renderer) return null;
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL(type, quality);
  }

  disposeTextures() {
    for (const key of ['uCenterTexture', 'uCovarianceTextureA', 'uCovarianceTextureB', 'uColorTexture', 'uAngleColorTexture']) {
      this.uniforms[key].value?.dispose();
      this.uniforms[key].value = null;
    }
  }

  // Release everything: GPU memory, the WebGL context, the worker and the data.
  dispose() {
    this.scheduler.dispose();
    this.resizeObserver.disconnect();
    this.worker.terminate();
    for (const pending of this.pendingDecodes.values()) pending.reject(Object.assign(new Error('closed'), { name: 'AbortError' }));
    this.pendingDecodes.clear();
    this.controls.dispose();
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
    this.disposeTextures();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.renderer = null;
    this.splats = null;
    this.mesh = null;
  }
}

const OBJECT_VERTEX_SHADER = /* glsl */ `
  uniform sampler2D uCenterTexture, uCovarianceTextureA, uCovarianceTextureB, uColorTexture, uAngleColorTexture;
  uniform int uTextureWidth;
  uniform vec2 uViewportPixels;
  uniform float uSizeMultiplier;
  uniform int uAngleColorDegree;
  uniform mat3 uObjectRotationInverse;
  in float splatIndex;
  varying vec2 vSigmaPosition;
  varying vec4 vColor;
  ${PROJECT_GAUSSIAN_GLSL}

  vec4 fetchTexel(sampler2D source, int texelIndex) {
    return texelFetch(source, ivec2(texelIndex % uTextureWidth, texelIndex / uTextureWidth), 0);
  }

  // Real spherical-harmonics color by angle, same constants as the original 3DGS code.
  vec3 angleColor(int index, vec3 direction) {
    float c[48];
    for (int texel = 0; texel < 12; texel++) {
      vec4 values = fetchTexel(uAngleColorTexture, index * 12 + texel) * (255.0 / 128.0) - 1.0;
      c[texel * 4] = values.x; c[texel * 4 + 1] = values.y; c[texel * 4 + 2] = values.z; c[texel * 4 + 3] = values.w;
    }
    #define COEFFICIENT(j) vec3(c[(j) * 3], c[(j) * 3 + 1], c[(j) * 3 + 2])
    float x = direction.x, y = direction.y, z = direction.z;
    vec3 result = 0.4886025119029199 * (-y * COEFFICIENT(0) + z * COEFFICIENT(1) - x * COEFFICIENT(2));
    if (uAngleColorDegree > 1) {
      float xx = x * x, yy = y * y, zz = z * z;
      result += 1.0925484305920792 * x * y * COEFFICIENT(3) - 1.0925484305920792 * y * z * COEFFICIENT(4)
              + 0.31539156525252005 * (2.0 * zz - xx - yy) * COEFFICIENT(5) - 1.0925484305920792 * x * z * COEFFICIENT(6)
              + 0.5462742152960396 * (xx - yy) * COEFFICIENT(7);
      if (uAngleColorDegree > 2) {
        result += -0.5900435899266435 * y * (3.0 * xx - yy) * COEFFICIENT(8) + 2.890611442640554 * x * y * z * COEFFICIENT(9)
                - 0.4570457994644658 * y * (4.0 * zz - xx - yy) * COEFFICIENT(10) + 0.3731763325901154 * z * (2.0 * zz - 3.0 * xx - 3.0 * yy) * COEFFICIENT(11)
                - 0.4570457994644658 * x * (4.0 * zz - xx - yy) * COEFFICIENT(12) + 1.445305721320277 * z * (xx - yy) * COEFFICIENT(13)
                - 0.5900435899266435 * x * (xx - 3.0 * yy) * COEFFICIENT(14);
      }
    }
    return result;
  }

  void main() {
    int index = int(splatIndex);
    vec4 centerAndRank = fetchTexel(uCenterTexture, index);
    vec4 covarianceA = fetchTexel(uCovarianceTextureA, index);
    vec4 covarianceB = fetchTexel(uCovarianceTextureB, index);
    mat3 covariance3D = mat3(
      covarianceA.x, covarianceA.y, covarianceA.z,
      covarianceA.y, covarianceA.w, covarianceB.x,
      covarianceA.z, covarianceB.x, covarianceB.y
    ) * (uSizeMultiplier * uSizeMultiplier);
    vec4 centerInCameraSpace = modelViewMatrix * vec4(centerAndRank.xyz, 1.0);
    vec2 majorAxisPixels, minorAxisPixels;
    if (!projectGaussian(centerInCameraSpace, covariance3D, mat3(modelViewMatrix), uViewportPixels, majorAxisPixels, minorAxisPixels)) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
    vec4 clipPosition = projectionMatrix * centerInCameraSpace;
    clipPosition.xy += (position.x * majorAxisPixels + position.y * minorAxisPixels) / (uViewportPixels * 0.5) * clipPosition.w;
    gl_Position = clipPosition;
    vSigmaPosition = position.xy * 3.0;

    vec3 color = fetchTexel(uColorTexture, index).rgb;
    if (uAngleColorDegree > 0) {
      vec3 worldCenter = (modelMatrix * vec4(centerAndRank.xyz, 1.0)).xyz;
      color += angleColor(index, normalize(uObjectRotationInverse * (worldCenter - cameraPosition)));
    }
    vColor = vec4(max(color, 0.0), covarianceB.z);
  }
`;

const OBJECT_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vSigmaPosition;
  varying vec4 vColor;
  void main() {
    float alpha = min(0.99, vColor.a * exp(-0.5 * dot(vSigmaPosition, vSigmaPosition)));
    if (alpha < 1.0 / 255.0) discard;
    // Splat colors are already display (sRGB) values, so no color-space conversion here.
    gl_FragColor = vec4(vColor.rgb, alpha);
  }
`;

customElements.define('splat-blob-demo', SplatBlobDemo);
customElements.define('splat-object-demo', SplatObjectDemo);

// Shared with marble-widgets.js, so every widget on the page looks and behaves the same
// (one panel style, the same on/off camera controls, and one heavy demo open at a time).
export {
  SHARED_STYLES, RenderScheduler, CameraActivation, ACTIVE_LABEL, PIXEL_RATIO_CAP, PREFERS_REDUCED_MOTION,
  activeObjectDemos, setExpanded, orbitCameraByKeys, placeCaptionSlot, readStageBackground,
  fetchWithProgress, formatMegabytes, parseVectorAttribute,
};
