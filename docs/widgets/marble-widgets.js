// Widgets for a World Labs Marble world, in the same design as splat-widgets.js.
//
//   <marble-world-demo>    fly freely through the world's Gaussian splats (Three.js + Spark)
//   <marble-mesh-compare>  the world's two exported meshes in grey clay, split by a
//                          draggable divider: collider on the left, detailed mesh on the right
//
// Both start OFF (a still image) and download nothing until the reader presses
// Explore. Only one heavy demo is open at a time, across every widget on the page.
//
// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------
// The page's import map must define "three" and "three/addons/"; the world demo also
// needs "@sparkjsdev/spark" (downloaded only when a reader opens that demo).
//
// Shared attributes:
//   poster          still image shown before the reader opens the 3D
//   download-size   label next to the Explore button, e.g. "8 MB"
//   view-position   "x,y,z" starting camera position (default 0,0,0: where Marble's panorama was taken)
//   view-target     "x,y,z" point the camera starts looking at (default 0,0,-1.2: straight ahead)
// Coordinates are in the viewer's space, after the world is turned upright
// (Marble files are stored upside down, as in the World Labs/Spark examples).
//
// <marble-world-demo> attributes:
//   splat-src       the world's splat file (.spz)
//   fly-limit       how far from the start the camera may fly (default 20); there are no walls
// Controls: drag to look; WASD or arrow keys (and the scroll wheel) to fly where you look,
// Q/E straight down/up; on touch screens an on-screen joystick flies.
//
// <marble-mesh-compare> attributes:
//   collider-src    the collider mesh (.glb), shown left of the divider
//   detailed-src    the high-quality mesh (.glb), shown right of the divider
//   max-distance    how far the camera may back away from the target (default 3)
//
// Slots: "caption" (optional, with caption-position="top" | "bottom") and "credit".
// Theme: the same --splat-* CSS variables as splat-widgets.js.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
  SHARED_STYLES, RenderScheduler, CameraActivation, ACTIVE_LABEL, PIXEL_RATIO_CAP, PREFERS_REDUCED_MOTION,
  activeObjectDemos, setExpanded, orbitCameraByKeys, placeCaptionSlot, readStageBackground,
  fetchWithProgress, formatMegabytes, parseVectorAttribute,
} from './splat-widgets.js';

const IS_COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;
const CLAY_COLOR = 0xc9c3b8;
const TRIANGLE_LINE_COLOR = 0x23262c;
const DEFAULT_VIEW_POSITION = new THREE.Vector3(0, 0, 0);
const DEFAULT_VIEW_TARGET = new THREE.Vector3(0, 0, -1.2);
const FLY_SPEED = 1.6;               // scene units (about metres) per second; Shift triples it
const FLY_WHEEL_STEP = 0.4;          // distance moved per scroll-wheel notch
const DEFAULT_FLY_LIMIT = 20;
const LOOK_RADIANS_PER_PIXEL = IS_COARSE_POINTER ? 0.006 : 0.004;
const MAX_PITCH = 1.35;              // about 77°, so the view never flips over
const FLY_LABEL = IS_COARSE_POINTER ? 'Drag to look · joystick to fly' : 'Drag to look · WASD or arrow keys to fly';

// Styles for the parts these widgets add on top of the shared panel.
const MARBLE_STYLES = /* css */ `
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

  /* Flying: the hint moves to the top so the joystick can own the bottom-left corner. */
  .stage.fly .active-chip { bottom: auto; top: 12px; }
  @container (max-width: 560px) { .stage.fly .active-chip { top: 58px; } }
  .joystick {
    position: absolute; left: 18px; bottom: 18px; z-index: 3; width: 104px; height: 104px; border-radius: 50%;
    background: rgba(17, 19, 23, 0.45); border: 2px solid rgba(255, 255, 255, 0.55); touch-action: none;
    backdrop-filter: blur(4px);
  }
  .joystick-knob {
    position: absolute; left: 50%; top: 50%; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%;
    background: rgba(255, 255, 255, 0.85); pointer-events: none; transition: transform 0.12s ease-out;
  }
  .joystick.held .joystick-knob { transition: none; }

  /* Divider of the compare widget: a thin line with a round handle you can drag. */
  .divider { position: absolute; top: 0; bottom: 0; width: 0; z-index: 3; pointer-events: none; }
  .divider::before { content: ""; position: absolute; top: 0; bottom: 0; left: -1px; width: 2px; background: rgba(255, 255, 255, 0.9);
                     box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25); }
  .divider-handle {
    position: absolute; top: 50%; left: 0; transform: translate(-50%, -50%); pointer-events: auto; touch-action: none;
    width: 44px; height: 44px; border-radius: 50%; border: 2px solid #fff; background: rgba(17, 19, 23, 0.72);
    color: #fff; font: 600 18px var(--ui-font); cursor: ew-resize; display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(6px);
  }
  .divider-handle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .side-label {
    position: absolute; top: 12px; z-index: 3; pointer-events: none; font: 600 12.5px var(--ui-font); color: #fff;
    background: rgba(17, 19, 23, 0.62); padding: 5px 11px; border-radius: 999px; backdrop-filter: blur(6px); white-space: nowrap;
  }
  .side-label.left { left: 12px; }
  .side-label.right { transform: translateX(12px); }
  /* Narrow views: the corner buttons fill the top row, so the right label sits just below them. */
  @container (max-width: 560px) { .side-label.right { top: 58px; } }
`;

// ===========================================================================
// Shared OFF → LOADING → ON behavior for both Marble widgets
// ===========================================================================
class MarbleDemoBase extends HTMLElement {
  // Subclasses add HTML to the view (stageExtras) and the control bar (barControls).
  get stageExtras() { return ''; }
  get barControls() { return ''; }
  get activeLabel() { return ACTIVE_LABEL; }
  // 'orbit' turns around a point; 'fly' moves the camera freely through the world.
  get cameraMode() { return 'orbit'; }

  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    this.attachShadow({ mode: 'open' });
    const bar = this.barControls;
    this.shadowRoot.innerHTML = `
      <style>${SHARED_STYLES}${MARBLE_STYLES}</style>
      <figure>
        <div class="caption-top"></div>
        <div class="panel">
          <div class="stage" tabindex="-1" aria-label="${this.stageLabel}">
            <img class="poster" alt="" data-role="poster">
            ${this.stageExtras}
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
            <div class="corner" data-role="corner" hidden>
              <button class="pill icon" data-role="resetView" aria-label="Reset view" title="Reset view">↺</button>
              <button class="pill icon" data-role="expand" aria-label="Expand" title="Expand">⤢</button>
              <button class="pill icon" data-role="close" aria-label="Close 3D" title="Close 3D (Esc)">✕</button>
            </div>
          </div>
          ${bar ? `<div class="bar" data-role="controls" inert>${bar}</div>` : ''}
        </div>
        <figcaption>
          <div class="caption-bottom"><slot name="caption"></slot></div>
          <div class="credit"><slot name="credit"></slot></div>
        </figcaption>
      </figure>`;
    placeCaptionSlot(this);

    this.stage = this.$('.stage');
    this.stage.classList.toggle('fly', this.cameraMode === 'fly');
    this.state = 'off';
    this.activation = new CameraActivation(this, this.stage, this.activeLabel);
    const poster = this.$('[data-role="poster"]');
    if (this.getAttribute('poster')) poster.src = this.getAttribute('poster'); else poster.hidden = true;
    this.$('[data-role="sizeNote"]').textContent = this.getAttribute('download-size') ? `· ${this.getAttribute('download-size')}` : '';
    this.bindCommonControls();
    this.bindControls();
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

  setLoadingProgress(label, received, total) {
    this.$('[data-role="progressBar"]').style.width = `${total ? Math.round(received / total * 100) : 0}%`;
    this.$('[data-role="loadingText"]').textContent = total
      ? `${label} ${formatMegabytes(received)} of ${formatMegabytes(total)}`
      : `${label} ${formatMegabytes(received)}`;
  }

  bindCommonControls() {
    this.$('[data-role="explore"]').addEventListener('click', () => this.activate());
    this.$('[data-role="cancel"]').addEventListener('click', () => this.close({ keepSnapshot: false }));
    this.$('[data-role="close"]').addEventListener('click', () => this.close({ keepSnapshot: true }));
    this.$('[data-role="resetView"]').addEventListener('click', () => this.view?.resetCamera());
    const expandButton = this.$('[data-role="expand"]');
    const toggleExpanded = expanded => {
      setExpanded(this, expanded, expandButton);
      requestAnimationFrame(() => { this.view?.resize(); this.view?.scheduler.request(); });
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
    // Arrow keys turn an orbiting camera; a flying camera handles its own keys.
    this.stage.addEventListener('keydown', event => {
      if (this.view?.controls instanceof OrbitControls && orbitCameraByKeys(this.view.camera, this.view.controls, event)) {
        event.preventDefault();
        this.view.scheduler.request();
      }
    });
  }

  bindControls() {}
  // Subclasses load their files into this.view; called while state is 'loading'.
  async loadContent() {}
  // Subclasses show or reset their own parts when the 3D opens or closes.
  onOpened() {}
  resetControls() {}

  // OFF → LOADING → ON
  async activate() {
    for (const other of activeObjectDemos) if (other !== this) other.close({ keepSnapshot: true });
    activeObjectDemos.add(this);
    this.state = 'loading';
    this.abortController = new AbortController();
    this.showPanel('loadingPanel');
    this.$('[data-role="loadingText"]').textContent = 'Loading…';

    try {
      this.view = new MarbleView(this, this.cameraMode);
    } catch (error) {
      this.showUnsupported('3D isn\'t available on this device or browser. The still image shows what it looks like.');
      return;
    }
    try {
      await this.loadContent();
      if (this.state !== 'loading') return;
      this.state = 'on';
      this.showPanel(null);
      this.$('[data-role="corner"]').hidden = false;
      const controls = this.$('[data-role="controls"]');
      if (controls) controls.inert = false;
      // The reader just asked for the 3D, so the controls start active.
      this.activation.bind(this.view.controls, this.view.renderer.domElement);
      this.activation.setEnabled(true);
      this.activation.setActive(true);
      this.stage.tabIndex = 0;
      this.stage.focus({ preventScroll: true });
      this.onOpened();
      this.view.resize();
      this.view.scheduler.request();
    } catch (error) {
      if (error.name === 'AbortError' || this.state !== 'loading') return;
      this.showUnsupported(`Couldn't load the 3D world (${error.message}).`);
    }
  }

  async fetchFile(url, label) {
    return fetchWithProgress(url, this.abortController.signal, (received, total) => this.setLoadingProgress(label, received, total));
  }

  showUnsupported(text) {
    this.view?.dispose();
    this.view = null;
    this.state = 'unsupported';
    activeObjectDemos.delete(this);
    this.showPanel('unsupportedPanel');
    this.$('[data-role="unsupportedText"]').textContent = text;
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
    this.$('[data-role="corner"]').hidden = true;
    const controls = this.$('[data-role="controls"]');
    if (controls) controls.inert = true;
    this.$('[data-role="progressBar"]').style.width = '0%';
    this.setBadge('');
    this.resetControls();
    this.stage.tabIndex = -1;
    this.$('[data-role="explore"]').focus({ preventScroll: true });
  }

  // Developer helper: render the current view and return it as an image (for making posters).
  capturePosterDataUrl() { return this.view?.snapshot('image/jpeg', 0.85) || null; }
}

// ===========================================================================
// <marble-world-demo>: fly freely through a Marble world rendered with Spark
// ===========================================================================
class MarbleWorldDemo extends MarbleDemoBase {
  get stageLabel() { return 'A 3D world generated by World Labs Marble. Drag to look around; use W A S D or the arrow keys to fly, Q and E to go down and up.'; }
  get cameraMode() { return 'fly'; }
  get activeLabel() { return FLY_LABEL; }
  get stageExtras() {
    // The joystick is only for touch screens; keyboards fly with WASD or the arrow keys.
    return IS_COARSE_POINTER
      ? '<div class="joystick" data-role="joystick" hidden aria-hidden="true"><div class="joystick-knob" data-role="joystickKnob"></div></div>'
      : '';
  }

  bindControls() {
    const joystick = this.$('[data-role="joystick"]');
    if (!joystick) return;
    const knob = this.$('[data-role="joystickKnob"]');
    const radius = 40;   // how far the knob can travel from the centre, in pixels
    let activePointer = null;
    const setStick = (x, y) => {
      knob.style.transform = `translate(${x * radius}px, ${y * radius}px)`;
      // Up on the stick flies forward (where you look); right moves right.
      this.view?.controls.setJoystick(x, -y);
    };
    const follow = event => {
      const box = joystick.getBoundingClientRect();
      let x = (event.clientX - (box.left + box.width / 2)) / radius;
      let y = (event.clientY - (box.top + box.height / 2)) / radius;
      const length = Math.hypot(x, y);
      if (length > 1) { x /= length; y /= length; }
      setStick(x, y);
    };
    joystick.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      this.activation.setActive(true);
      activePointer = event.pointerId;
      joystick.setPointerCapture(event.pointerId);
      joystick.classList.add('held');
      follow(event);
    });
    joystick.addEventListener('pointermove', event => { if (event.pointerId === activePointer) follow(event); });
    const release = event => {
      if (event.pointerId !== activePointer) return;
      activePointer = null;
      joystick.classList.remove('held');
      setStick(0, 0);
    };
    joystick.addEventListener('pointerup', release);
    joystick.addEventListener('pointercancel', release);
  }

  async loadContent() {
    this.$('[data-role="loadingText"]').textContent = 'Loading the renderer…';
    await this.view.initializeSplats();
    if (this.state !== 'loading') return;
    const buffer = await this.fetchFile(this.getAttribute('splat-src'), 'Loading');
    this.$('[data-role="loadingText"]').textContent = 'Unpacking…';
    await this.view.addSplats(buffer);
  }

  onOpened() {
    const joystick = this.$('[data-role="joystick"]');
    if (joystick) joystick.hidden = false;
  }

  resetControls() {
    const joystick = this.$('[data-role="joystick"]');
    if (joystick) { joystick.hidden = true; this.$('[data-role="joystickKnob"]').style.transform = ''; }
  }
}

// ===========================================================================
// <marble-mesh-compare>: collider | divider | detailed mesh, both in grey clay
// ===========================================================================
class MarbleMeshCompare extends MarbleDemoBase {
  get stageLabel() { return 'The two meshes Marble exports, in grey clay: the collider left of the divider, the detailed mesh right of it.'; }

  get stageExtras() {
    return `
      <div class="side-label left" data-role="leftLabel" hidden>Collider</div>
      <div class="side-label right" data-role="rightLabel" hidden>Detailed mesh</div>
      <div class="divider" data-role="divider" hidden>
        <button class="divider-handle" data-role="dividerHandle" role="slider" aria-label="Divider between the collider and the detailed mesh"
                aria-valuemin="5" aria-valuemax="95" aria-valuenow="50">⟷</button>
      </div>`;
  }

  get barControls() {
    return `
      <span class="spacer"></span>
      <button class="chip-toggle" data-role="triangles" aria-pressed="false">Show triangles</button>`;
  }

  bindControls() {
    this.splitFraction = 0.5;
    const handle = this.$('[data-role="dividerHandle"]');
    // Dragging the handle moves the divider; dragging anywhere else turns the camera.
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      const move = moveEvent => {
        const box = this.stage.getBoundingClientRect();
        this.setSplit((moveEvent.clientX - box.left) / box.width);
      };
      const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
    handle.addEventListener('keydown', event => {
      const step = event.shiftKey ? 0.2 : 0.05;
      if (event.key === 'ArrowLeft') this.setSplit(this.splitFraction - step);
      else if (event.key === 'ArrowRight') this.setSplit(this.splitFraction + step);
      else return;
      event.preventDefault();
      event.stopPropagation();
    });
    this.$('[data-role="triangles"]').addEventListener('click', event => {
      const on = event.currentTarget.getAttribute('aria-pressed') !== 'true';
      event.currentTarget.setAttribute('aria-pressed', String(on));
      this.view?.setTrianglesVisible(on);
    });
  }

  setSplit(fraction) {
    this.splitFraction = Math.min(0.95, Math.max(0.05, fraction));
    const percent = Math.round(this.splitFraction * 100);
    this.$('[data-role="divider"]').style.left = `${percent}%`;
    this.$('[data-role="rightLabel"]').style.left = `${percent}%`;
    this.$('[data-role="dividerHandle"]').setAttribute('aria-valuenow', String(percent));
    if (this.view) { this.view.splitFraction = this.splitFraction; this.view.scheduler.request(); }
  }

  async loadContent() {
    const colliderBuffer = await this.fetchFile(this.getAttribute('collider-src'), 'Loading collider');
    const detailedBuffer = await this.fetchFile(this.getAttribute('detailed-src'), 'Loading detailed mesh');
    this.$('[data-role="loadingText"]').textContent = 'Unpacking…';
    await this.view.addMesh('left', colliderBuffer);
    await this.view.addMesh('right', detailedBuffer);
    this.view.splitFraction = this.splitFraction;
  }

  onOpened() {
    for (const role of ['leftLabel', 'rightLabel', 'divider']) this.$(`[data-role="${role}"]`).hidden = false;
    this.setSplit(this.splitFraction);
  }

  resetControls() {
    this.$('[data-role="triangles"]').setAttribute('aria-pressed', 'false');
    for (const role of ['leftLabel', 'rightLabel', 'divider']) this.$(`[data-role="${role}"]`).hidden = true;
    this.splitFraction = 0.5;
  }
}

// ---------------------------------------------------------------------------
// FlyControls: a free first-person camera with no walls.
// Drag to look; WASD/arrow keys, the scroll wheel or a joystick to fly.
// Forward goes where you look (look up and fly forward to rise); Q/E go straight down/up.
// `enabled` and `enableZoom` are switched by CameraActivation, like OrbitControls.
// ---------------------------------------------------------------------------
class FlyControls extends THREE.EventDispatcher {
  constructor(camera, domElement, { limit, isFocused }) {
    super();
    this.camera = camera;
    this.domElement = domElement;
    this.limit = limit;              // how far from the start the camera may go
    this.isFocused = isFocused;      // keys only count while this widget has focus
    this.home = new THREE.Vector3();
    this._enabled = false;
    this.enableZoom = false;
    this.yaw = 0;
    this.pitch = 0;
    this.pressedKeys = new Set();
    this.joystick = new THREE.Vector2();
    this.velocity = new THREE.Vector3();
    this.lookPointer = null;

    this.onPointerDown = event => {
      if (!this._enabled || this.lookPointer !== null) return;
      this.lookPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      domElement.setPointerCapture(event.pointerId);
    };
    this.onPointerMove = event => {
      if (!this.lookPointer || event.pointerId !== this.lookPointer.id) return;
      // The camera turns the way you drag, as in games: drag right to look right, drag up to look up.
      this.yaw -= (event.clientX - this.lookPointer.x) * LOOK_RADIANS_PER_PIXEL;
      this.pitch = THREE.MathUtils.clamp(this.pitch - (event.clientY - this.lookPointer.y) * LOOK_RADIANS_PER_PIXEL, -MAX_PITCH, MAX_PITCH);
      this.lookPointer.x = event.clientX;
      this.lookPointer.y = event.clientY;
      this.applyRotation();
      this.dispatchEvent({ type: 'change' });
    };
    this.onPointerUp = event => { if (this.lookPointer && event.pointerId === this.lookPointer.id) this.lookPointer = null; };
    this.onWheel = event => {
      if (!this._enabled || !this.enableZoom) return;
      event.preventDefault();
      this.moveBy(this.viewDirection().multiplyScalar(-Math.sign(event.deltaY) * FLY_WHEEL_STEP));
      this.dispatchEvent({ type: 'change' });
    };
    const FLY_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'];
    this.onKeyDown = event => {
      if (!this._enabled || !FLY_KEYS.includes(event.code) || !this.isFocused()) return;
      event.preventDefault();   // stop the arrow keys from scrolling the page
      this.pressedKeys.add(event.code);
      this.dispatchEvent({ type: 'change' });
    };
    this.onKeyUp = event => { this.pressedKeys.delete(event.code); };
    this.onBlur = () => this.pressedKeys.clear();
    domElement.addEventListener('pointerdown', this.onPointerDown);
    domElement.addEventListener('pointermove', this.onPointerMove);
    domElement.addEventListener('pointerup', this.onPointerUp);
    domElement.addEventListener('pointercancel', this.onPointerUp);
    domElement.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  get enabled() { return this._enabled; }
  set enabled(value) {
    this._enabled = value;
    // Releasing the controls stops any flying in progress.
    if (!value) { this.pressedKeys.clear(); this.joystick.set(0, 0); this.lookPointer = null; }
  }

  setJoystick(x, y) { this.joystick.set(x, y); this.dispatchEvent({ type: 'change' }); }

  setPose(position, target) {
    this.home.copy(position);
    this.camera.position.copy(position);
    const direction = target.clone().sub(position).normalize();
    this.yaw = Math.atan2(-direction.x, -direction.z);
    this.pitch = THREE.MathUtils.clamp(Math.asin(direction.y), -MAX_PITCH, MAX_PITCH);
    this.velocity.set(0, 0, 0);
    this.applyRotation();
  }

  applyRotation() { this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ'); }

  // The direction the camera looks, including up and down.
  viewDirection() { return new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation); }

  // A soft outer limit only: far enough to see the whole world from outside,
  // close enough that nobody drifts off into empty space.
  moveBy(offset) {
    const position = this.camera.position.add(offset);
    const fromHome = position.clone().sub(this.home);
    if (fromHome.length() > this.limit) position.copy(this.home).add(fromHome.setLength(this.limit));
  }

  // Advance the flight by one frame. Returns true while the camera is still moving.
  update(deltaSeconds) {
    const keys = this.pressedKeys;
    let forward = this.joystick.y, right = this.joystick.x, up = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) forward += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) forward -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) right += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) right -= 1;
    if (keys.has('KeyE')) up += 1;
    if (keys.has('KeyQ')) up -= 1;
    const speed = FLY_SPEED * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 1);
    const forwardVector = this.viewDirection();
    const rightVector = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw)).negate();
    const wanted = forwardVector.multiplyScalar(forward).add(rightVector.multiplyScalar(right)).add(new THREE.Vector3(0, up, 0));
    if (wanted.lengthSq() > 1) wanted.normalize();
    wanted.multiplyScalar(speed);
    // Ease into and out of moving instead of starting and stopping instantly (gentler on the eyes).
    const easing = PREFERS_REDUCED_MOTION ? 1 : 1 - Math.exp(-deltaSeconds * 10);
    this.velocity.lerp(wanted, easing);
    if (this.velocity.lengthSq() < 1e-6 && wanted.lengthSq() === 0) { this.velocity.set(0, 0, 0); return false; }
    this.moveBy(this.velocity.clone().multiplyScalar(deltaSeconds));
    return true;
  }

  dispose() {
    const element = this.domElement;
    element.removeEventListener('pointerdown', this.onPointerDown);
    element.removeEventListener('pointermove', this.onPointerMove);
    element.removeEventListener('pointerup', this.onPointerUp);
    element.removeEventListener('pointercancel', this.onPointerUp);
    element.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}

// ---------------------------------------------------------------------------
// MarbleView: everything that exists only while a Marble widget is ON.
// Created on Explore, fully released on Close.
// ---------------------------------------------------------------------------
class MarbleView {
  constructor(demo, cameraMode) {
    this.demo = demo;
    this.stage = demo.stage;
    // Refuse slow software rendering instead of crawling along at a few frames per second.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, failIfMajorPerformanceCaveat: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
    this.stage.insertBefore(this.renderer.domElement, this.demo.$('.center'));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(readStageBackground(demo));
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.02, 200);
    this.scene.add(this.camera);   // so the headlight below rides along with the camera

    // Clay lighting: soft light from above plus a lamp on the camera, so surfaces facing you read clearly.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6a655e, 2.0));
    const headlight = new THREE.DirectionalLight(0xffffff, 1.8);
    headlight.position.set(0.4, 0.6, 0);
    headlight.target.position.set(0, 0, -1);
    this.camera.add(headlight, headlight.target);

    if (cameraMode === 'fly') {
      this.controls = new FlyControls(this.camera, this.renderer.domElement, {
        limit: Number(demo.getAttribute('fly-limit')) || DEFAULT_FLY_LIMIT, isFocused: () => demo.matches(':focus-within'),
      });
    } else {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = !PREFERS_REDUCED_MOTION;
      this.controls.enablePan = false;
      this.controls.rotateSpeed = 0.6;
      this.controls.minDistance = 0.15;
      this.controls.maxDistance = Number(demo.getAttribute('max-distance')) || 3;
    }

    this.meshes = new Map();       // 'left' | 'right' → { clay, triangles, materials }
    this.trianglesVisible = false;
    this.splitFraction = 0.5;
    this.lastFrameTime = null;

    this.scheduler = new RenderScheduler(demo, time => this.drawFrame(time));
    this.controls.addEventListener('change', () => this.scheduler.request());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
    this.resetCamera();
  }

  // Download Spark only now, the first time a reader opens the world demo.
  async initializeSplats() {
    const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');
    if (!this.renderer) return;
    this.SplatMesh = SplatMesh;
    // Spark asks for another frame whenever its sorting finishes; we only draw when asked.
    this.spark = new SparkRenderer({ renderer: this.renderer, onDirty: () => this.scheduler.request() });
    this.scene.add(this.spark);
  }

  async addSplats(buffer) {
    const splats = new this.SplatMesh({ fileBytes: new Uint8Array(buffer), fileName: 'world.spz' });
    splats.rotation.x = Math.PI;   // Marble files are stored upside down
    this.scene.add(splats);
    this.splats = splats;
    await splats.initialized;
    this.scheduler.request();
  }

  async addMesh(side, buffer) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));
    if (!this.renderer) return;
    const clayMaterial = new THREE.MeshStandardMaterial({
      color: CLAY_COLOR, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
      // Push the clay back a little so the triangle lines drawn on top don't flicker.
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    const lineMaterial = new THREE.MeshBasicMaterial({ color: TRIANGLE_LINE_COLOR, wireframe: true, transparent: true, opacity: 0.2, depthWrite: false });
    const clay = new THREE.Group(), triangles = new THREE.Group();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse(object => {
      if (!object.isMesh) return;
      const geometry = object.geometry;
      // Clay needs surface directions for lighting; the detailed mesh ships without them.
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      const clayMesh = new THREE.Mesh(geometry, clayMaterial);
      const lineMesh = new THREE.Mesh(geometry, lineMaterial);
      for (const mesh of [clayMesh, lineMesh]) { mesh.applyMatrix4(object.matrixWorld); mesh.matrixAutoUpdate = false; mesh.updateMatrix(); }
      clay.add(clayMesh);
      triangles.add(lineMesh);
    });
    for (const group of [clay, triangles]) { group.rotation.x = Math.PI; group.visible = false; this.scene.add(group); }
    this.meshes.set(side, { clay, triangles, materials: [clayMaterial, lineMaterial] });
  }

  setTrianglesVisible(visible) {
    this.trianglesVisible = visible;
    this.scheduler.request();
  }

  resetCamera() {
    const position = parseVectorAttribute(this.demo, 'view-position') || DEFAULT_VIEW_POSITION;
    const target = parseVectorAttribute(this.demo, 'view-target') || DEFAULT_VIEW_TARGET;
    if (this.controls instanceof FlyControls) {
      this.controls.setPose(position, target);
    } else {
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
    }
    this.scheduler.request();
  }

  resize() {
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    if (!width || !height || !this.renderer) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.scheduler.request();
  }

  drawFrame(time) {
    if (!this.renderer) return false;
    const deltaSeconds = this.lastFrameTime === null ? 1 / 60 : Math.min(0.05, (time - this.lastFrameTime) / 1000);
    const moving = this.controls instanceof FlyControls ? this.controls.update(deltaSeconds) : this.controls.update();
    // Forget the frame time when we stop, so the next movement doesn't jump.
    this.lastFrameTime = moving ? time : null;
    this.render();
    return moving;
  }

  // Show only one side's mesh (with or without its triangle lines).
  showSide(side) {
    for (const [name, { clay, triangles }] of this.meshes) {
      clay.visible = name === side;
      triangles.visible = name === side && this.trianglesVisible;
    }
  }

  render() {
    if (!this.meshes.size) { this.renderer.render(this.scene, this.camera); return; }
    // Same camera, drawn twice: the left mesh left of the divider, the right mesh right of it.
    const size = this.renderer.getSize(new THREE.Vector2());
    const splitX = Math.round(size.x * this.splitFraction);
    this.renderer.setScissorTest(true);
    this.showSide('left');
    this.renderer.setScissor(0, 0, splitX, size.y);
    this.renderer.render(this.scene, this.camera);
    this.showSide('right');
    this.renderer.setScissor(splitX, 0, size.x - splitX, size.y);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setScissorTest(false);
  }

  snapshot(type = 'image/jpeg', quality = 0.85) {
    if (!this.renderer) return null;
    this.render();
    return this.renderer.domElement.toDataURL(type, quality);
  }

  // Release everything: GPU memory, Spark, the WebGL context and the data.
  dispose() {
    this.scheduler.dispose();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.splats?.dispose();
    this.spark?.dispose();
    for (const { clay, materials } of this.meshes.values()) {
      clay.traverse(object => object.geometry?.dispose());
      for (const material of materials) material.dispose();
    }
    this.meshes.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.renderer = null;
  }
}

customElements.define('marble-world-demo', MarbleWorldDemo);
customElements.define('marble-mesh-compare', MarbleMeshCompare);
