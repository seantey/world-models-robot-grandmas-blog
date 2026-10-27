// Robot Grandma: the packaged game (widgets/robot-grandma/) in a frame, wrapped in the same design and
// states as the other widgets (splat-widgets.js, marble-widgets.js).
//
//   <robot-grandma-demo>  OFF (poster + Explore) → LOADING → ON, "Click to interact", Done, ⤢ expand, ✕ close
//
// The game is its own page inside an <iframe>; this wrapper talks to it only by postMessage
// (every message is tagged { type: "robot-widget" }):
//   to the game     { action: "pause" | "resume" }
//   from the game   { event: "progress", loaded, total, stage }, { event: "ready" },
//                   { event: "error", reason, message, file? }, { event: "paused" | "resumed" }
//                   (the game also sends "quality" and "performance" events; this wrapper doesn't use them)
//
//   - Nothing downloads until Explore: the frame is only created then.
//   - Loading: a real progress bar from the game's progress events; ON only once the game says it's ready.
//     If the game can't run (no WebGL 2, no graphics card, no WebAssembly, a start error), the frame is
//     removed and a short message replaces it. If a download failed (reason "network"), the message offers
//     Try again, which loads the game afresh.
//   - Inactive: a see-through shield covers the frame, so clicks, scrolling and keys stay with the page.
//     Clicking (or tapping) the view removes the shield and gives the frame the keyboard.
//   - The game runs only while its controls are active, the widget is on-screen and the tab is visible.
//     Releasing the controls (Done, clicking outside, scrolling away) pauses it, physics and drawing both;
//     clicking back in resumes it where it stopped. Taking focus away also makes the game release held keys.
//   - Close removes the frame, which ends the game completely (physics worker, WebGL, memory).
//   - Opening this closes any other open heavy widget, and opening another closes this one.
//
// Attributes:
//   src            the game page to load in the frame
//   poster         still image shown before the reader opens it
//   download-size        label next to the Explore button, e.g. "13 MB"
//   download-size-touch  the label on touch screens, which load a lighter room (the game chooses it by the
//                        same coarse-pointer test); download-size when absent

import { SHARED_STYLES, CameraActivation, activeObjectDemos, setExpanded, placeCaptionSlot } from './splat-widgets.js';

const IS_COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;
const ROBOT_LABEL = IS_COARSE_POINTER ? 'Joystick to walk · tap Kick' : 'W/S walk · A/D turn · Space kick · B set ball';
const MESSAGE_TYPE = 'robot-widget';
// The game's loading stages, in order, as the reader sees them.
const LOADING_STAGE_LABELS = {
  files: 'Loading the game…',
  physics: 'Starting the physics…',
  room: 'Loading the room…',
  starting: 'Starting…',
};
const UNSUPPORTED_DEVICE_TEXT = 'This demo can\'t run on this device or browser. The still image shows what it looks like.';
const START_FAILED_TEXT = 'The demo couldn\'t start. Reloading the page sometimes helps.';
const DOWNLOAD_FAILED_TEXT = 'The demo couldn\'t load. Check the connection and try again.';

const ROBOT_STYLES = /* css */ `
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

  /* The game's frame fills the view; while it loads it stays invisible under the loading panel. */
  .game-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block;
                transition: filter 0.2s ease; }
  .game-frame.loading { visibility: hidden; }
  .stage[data-active="false"] .game-frame { filter: grayscale(0.5) brightness(0.75); }
  /* While inactive, the shield sits over the frame: clicks activate, touch scrolls the page. */
  .shield { position: absolute; inset: 0; z-index: 1; cursor: pointer; touch-action: pan-y; }
  .stage[data-active="true"] .shield { display: none; }
  /* Done, expand and close sit in the top-right corner, as on the cat. The game keeps that corner free: its
     own ?, camera and Reset are top-left with the key hint under them, Kick and Set ball bottom-right and the
     phone joystick bottom-left. The wrapper's own key label is left out. */
  .stage .corner { top: 10px; }
  .stage .active-chip { display: none; }
`;

class RobotGrandmaDemo extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>${SHARED_STYLES}${ROBOT_STYLES}</style>
      <figure>
        <div class="caption-top"></div>
        <div class="panel">
          <div class="stage" tabindex="-1" aria-label="Robot Grandma: drive a simulated robot grandma through the apartment and kick a ball.">
            <img class="poster" alt="" data-role="poster">
            <div class="shield" data-role="shield" hidden></div>
            <div class="center" data-role="offPanel">
              <button class="pill explore" data-role="explore">Explore in 3D<span class="size" data-role="sizeNote"></span></button>
            </div>
            <div class="center" data-role="loadingPanel" hidden>
              <div class="subtle" data-role="loadingText" aria-live="polite">Loading the game…</div>
              <div class="progress" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"
                   data-role="progress"><div data-role="progressBar"></div></div>
              <button class="pill" data-role="cancel">Cancel</button>
            </div>
            <div class="center" data-role="unsupportedPanel" hidden>
              <div class="subtle" data-role="unsupportedText" role="alert"></div>
              <button class="pill" data-role="retry" hidden>Try again</button>
            </div>
            <div class="corner" data-role="corner" hidden>
              <button class="pill icon" data-role="expand" aria-label="Expand" title="Expand">⤢</button>
              <button class="pill icon" data-role="close" aria-label="Close 3D" title="Close 3D">✕</button>
            </div>
          </div>
        </div>
        <figcaption>
          <div class="caption-bottom"><slot name="caption"></slot></div>
          <div class="credit"><slot name="credit"></slot></div>
        </figcaption>
      </figure>`;
    placeCaptionSlot(this);

    this.stage = this.$('.stage');
    this.shield = this.$('[data-role="shield"]');
    // A press on the shield would otherwise move focus to the view right after the frame was given it.
    this.shield.addEventListener('mousedown', event => event.preventDefault());
    this.state = 'off';
    this.isOnScreen = true;
    this.gameShouldRun = false;   // what the wrapper last told the game: run (resume) or pause
    this.activation = new CameraActivation(this, this.stage, ROBOT_LABEL);
    const poster = this.$('[data-role="poster"]');
    if (this.getAttribute('poster')) poster.src = this.getAttribute('poster'); else poster.hidden = true;
    const downloadSize = (IS_COARSE_POINTER && this.getAttribute('download-size-touch')) || this.getAttribute('download-size');
    this.$('[data-role="sizeNote"]').textContent = downloadSize ? `· ${downloadSize}` : '';

    // CameraActivation only knows about a view and its controls; here the "view" is the shield and the
    // controls are the frame's keyboard focus and the game's pause switch. Patch render so every on/off
    // change also moves the focus and pauses or resumes the game.
    const renderActivation = this.activation.render.bind(this.activation);
    this.activation.render = () => {
      renderActivation();
      this.onActivationChanged();
    };

    // Messages from the game: only from this widget's own frame, and only the game's own kind.
    this.onWindowMessage = event => {
      if (!this.frame || event.source !== this.frame.contentWindow || event.data?.type !== MESSAGE_TYPE) return;
      this.onGameMessage(event.data);
    };
    window.addEventListener('message', this.onWindowMessage);
    // Off-screen or in a hidden tab, the game pauses even if its controls are still active.
    this.intersectionObserver = new IntersectionObserver(entries => {
      this.isOnScreen = entries[entries.length - 1].isIntersecting;
      this.updateGameRunning();
    });
    this.intersectionObserver.observe(this);
    this.onVisibilityChange = () => this.updateGameRunning();
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.$('[data-role="explore"]').addEventListener('click', () => this.open());
    this.$('[data-role="cancel"]').addEventListener('click', () => this.close());
    this.$('[data-role="retry"]').addEventListener('click', () => this.open());
    this.$('[data-role="close"]').addEventListener('click', () => this.close());
    const expandButton = this.$('[data-role="expand"]');
    expandButton.addEventListener('click', () => {
      const expanding = !this.classList.contains('expanded');
      setExpanded(this, expanding, expandButton);
      if (expanding) this.activation.setActive(true); else this.focusFrame();
    });
  }

  disconnectedCallback() {
    this.close();
    this.activation.dispose();
    window.removeEventListener('message', this.onWindowMessage);
    this.intersectionObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  $(selector) { return this.shadowRoot.querySelector(selector); }

  showPanel(name) {
    for (const panel of ['offPanel', 'loadingPanel', 'unsupportedPanel']) this.$(`[data-role="${panel}"]`).hidden = panel !== name;
    this.stage.classList.toggle('dim', name === 'loadingPanel' || name === 'unsupportedPanel');
  }

  setLoadingProgress(percent, stage) {
    const rounded = Math.max(0, Math.min(100, Math.round(percent)));
    this.$('[data-role="progressBar"]').style.width = `${rounded}%`;
    this.$('[data-role="progress"]').setAttribute('aria-valuenow', String(rounded));
    this.$('[data-role="loadingText"]').textContent = `${LOADING_STAGE_LABELS[stage] || 'Loading…'} ${rounded}%`;
  }

  // OFF → LOADING → ON (on the game's "ready")
  open() {
    for (const other of activeObjectDemos) if (other !== this) other.close({ keepSnapshot: true });
    activeObjectDemos.add(this);
    this.state = 'loading';
    this.showPanel('loadingPanel');
    this.setLoadingProgress(0, 'files');

    this.frame = Object.assign(document.createElement('iframe'), {
      className: 'game-frame loading', title: 'Robot Grandma game', src: this.getAttribute('src'),
    });
    this.frame.allow = 'fullscreen';
    this.stage.prepend(this.frame);
  }

  onGameMessage(message) {
    if (message.event === 'progress' && this.state === 'loading') {
      this.setLoadingProgress(message.total ? message.loaded / message.total * 100 : 0, message.stage);
    } else if (message.event === 'ready' && this.state === 'loading') {
      this.showGame();
    } else if (message.event === 'error' && (this.state === 'loading' || this.state === 'on')) {
      if (message.reason === 'network') this.showUnsupported(DOWNLOAD_FAILED_TEXT, { canRetry: true });
      else this.showUnsupported(message.reason === 'error' ? START_FAILED_TEXT : UNSUPPORTED_DEVICE_TEXT);
    }
  }

  showGame() {
    this.frame.classList.remove('loading');
    this.showPanel(null);
    this.$('[data-role="poster"]').hidden = true;
    this.$('[data-role="corner"]').hidden = false;
    this.shield.hidden = false;
    this.activation.bind(null, this.shield);
    this.activation.setEnabled(true);
    // The reader just asked for the game, so the controls start active.
    this.activation.setActive(true);
    // The game is running now. Switched to ON only after the activation above, so it isn't paused and
    // resumed on the way; this gives the frame the keyboard, or pauses the game if the reader scrolled
    // away or hid the tab while it loaded.
    this.state = 'on';
    this.gameShouldRun = true;
    this.onActivationChanged();
  }

  // The game can't run here, or its download failed: remove the frame and say so over the dimmed poster.
  // After a failed download, Try again opens the game afresh.
  showUnsupported(text, { canRetry = false } = {}) {
    this.removeFrame();
    this.state = 'unsupported';
    activeObjectDemos.delete(this);
    if (this.classList.contains('expanded')) setExpanded(this, false, this.$('[data-role="expand"]'));
    this.activation.unbind();
    this.activation.setEnabled(false);
    this.$('[data-role="poster"]').hidden = !this.getAttribute('poster');
    this.$('[data-role="corner"]').hidden = true;
    this.showPanel('unsupportedPanel');
    this.$('[data-role="unsupportedText"]').textContent = text;
    this.$('[data-role="retry"]').hidden = !canRetry;
  }

  removeFrame() {
    this.frame?.remove();
    this.frame = null;
    this.gameShouldRun = false;
    this.shield.hidden = true;
  }

  // ON → OFF: removing the frame ends the game and frees everything it held.
  close() {
    if (this.state === 'off') return;
    this.removeFrame();
    activeObjectDemos.delete(this);
    this.state = 'off';
    if (this.classList.contains('expanded')) setExpanded(this, false, this.$('[data-role="expand"]'));
    this.activation.unbind();
    this.activation.setEnabled(false);
    this.showPanel('offPanel');
    this.$('[data-role="poster"]').hidden = !this.getAttribute('poster');
    this.$('[data-role="corner"]').hidden = true;
    this.$('[data-role="explore"]').focus({ preventScroll: true });
  }

  focusFrame() { if (this.activation?.active) this.frame?.focus(); }

  postToGame(action) {
    this.frame?.contentWindow?.postMessage({ type: MESSAGE_TYPE, action }, '*');
  }

  // Run the game only while the reader is playing it: controls active, on-screen, tab visible.
  updateGameRunning() {
    if (!this.frame || this.state !== 'on') return;
    const shouldRun = this.activation.active && this.isOnScreen && document.visibilityState !== 'hidden';
    if (shouldRun === this.gameShouldRun) return;
    this.gameShouldRun = shouldRun;
    this.postToGame(shouldRun ? 'resume' : 'pause');
  }

  onActivationChanged() {
    if (!this.frame || this.state !== 'on') return;
    if (this.activation.active) {
      this.updateGameRunning();
      this.frame.focus();
    } else {
      // Taking focus away from the frame makes the game release any held keys; the pause stops it.
      if (this.shadowRoot.activeElement === this.frame) this.stage.focus({ preventScroll: true });
      this.updateGameRunning();
    }
  }
}

customElements.define('robot-grandma-demo', RobotGrandmaDemo);
