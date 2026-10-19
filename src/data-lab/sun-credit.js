import { Vector3 } from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { normalizeAuthorProfile } from './author-profile.js';
import { placeCommitBubble } from './commit-bubble-layout.js';
import { registerGlassSurface } from '../ui/glass-refraction.js';

let nextBubbleId = 0;

/** A screen-facing credit anchored to the root, independent of scene picking. */
export class SunCredit {
  constructor(parent, { onSelect = () => {} } = {}) {
    this.element = document.createElement('div');
    this.element.className = 'data-sun-credit';
    this.element.hidden = true;
    this.element.setAttribute('role', 'group');
    this.element.innerHTML = '<div class="data-sun-pulse" aria-hidden="true"></div><button type="button" class="data-sun-portrait"><span class="data-sun-initials" aria-hidden="true"></span></button><div class="data-sun-caption"><span class="data-sun-byline">Commit by</span><button type="button" class="data-sun-name"></button></div>';
    this.portrait = this.element.querySelector('.data-sun-portrait');
    this.pulseRing = this.element.querySelector('.data-sun-pulse');
    this.initials = this.element.querySelector('.data-sun-initials');
    this.name = this.element.querySelector('.data-sun-name');
    this.caption = this.element.querySelector('.data-sun-caption');
    this.bubble = document.createElement('section');
    this.bubble.className = 'panel data-commit-bubble';
    this.bubble.id = `data-commit-bubble-${++nextBubbleId}`;
    this.bubble.hidden = true;
    this.bubble.style.visibility = 'hidden';
    this.bubble.setAttribute('aria-label', 'Current commit');
    this.bubble.innerHTML = '<h2 class="list-title data-bubble-heading">Commit</h2><div class="data-bubble-scroll"><p class="data-bubble-message" tabindex="0"></p><details class="data-bubble-files"><summary><span class="data-bubble-file-count"></span><span class="data-bubble-lines"><span class="data-bubble-added"></span><span class="data-bubble-deleted"></span><span>lines</span></span></summary><div class="data-bubble-file-list"></div></details><p class="data-bubble-notice" hidden></p></div><footer class="data-bubble-footer"><code class="data-bubble-sha"></code><a class="btn tiny data-bubble-link" target="_blank" rel="noopener noreferrer">View on GitHub <span aria-hidden="true">↗</span></a></footer>';
    this.element.append(this.bubble);
    this.releaseGlass = registerGlassSurface(this.bubble);
    this.message = this.bubble.querySelector('.data-bubble-message');
    this.bubbleScroll = this.bubble.querySelector('.data-bubble-scroll');
    this.fileDetails = this.bubble.querySelector('.data-bubble-files');
    this.fileList = this.bubble.querySelector('.data-bubble-file-list');
    this.notice = this.bubble.querySelector('.data-bubble-notice');
    this.commitLink = this.bubble.querySelector('.data-bubble-link');
    this.commitId = this.bubble.querySelector('.data-bubble-sha');
    this.listeners = new AbortController();
    // Native disclosure controls, text selection and links must not orbit the scene.
    for (const target of [this.bubble, this.portrait, this.name]) {
      for (const event of ['pointerdown', 'pointerup', 'dblclick', 'wheel', 'keydown', 'keyup']) {
        target.addEventListener(event, event => event.stopPropagation(), { signal: this.listeners.signal });
      }
    }
    for (const control of [this.portrait, this.name]) {
      control.addEventListener('click', event => {
        event.stopPropagation();
        if (this.playing || !this.hasCommit) return;
        this.collapsed = !this.collapsed;
        this._syncBubbleVisibility();
      }, { signal: this.listeners.signal });
    }
    this.fileList.addEventListener('click', event => {
      const button = event.target.closest('button[data-file-id]');
      if (button) onSelect(button.dataset.fileId);
    }, { signal: this.listeners.signal });
    this.playing = false;
    this.collapsed = false;

    this.object = new CSS2DObject(this.element);
    this.object.name = 'Data Lab · Commit author';
    this.object.visible = false;
    this.projected = new Vector3();
    this.anchor = new Vector3();
    this.hasCommit = false;
    this.requestedVisible = false;
    this._syncBubbleVisibility();
    parent.add(this.object);
  }

  setCommit(commit) {
    const changed = this.commit !== commit;
    this.commit = commit || null;
    this.hasCommit = Boolean(commit);
    if (!commit) {
      this.setVisible(false);
      this.element.removeAttribute('aria-label');
      this.element.removeAttribute('data-commit');
      this.name.textContent = '';
      this.initials.textContent = '';
      this._setAvatar(null);
      this._syncBubbleVisibility();
      this.fileList.replaceChildren();
      this.message.textContent = '';
      this.commitLink.removeAttribute('href');
      return;
    }
    const profile = normalizeAuthorProfile(commit.authorProfile);
    const name = String(commit.author || profile?.login || 'Unknown author').trim() || 'Unknown author';
    this.name.textContent = name;
    const words = name.split(/[\s_-]+/u).filter(Boolean);
    this.initials.textContent = name === 'Unknown author' ? '?' : [words[0], ...(words.length > 1 ? [words.at(-1)] : [])].map(word => Array.from(word)[0]).join('').toLocaleUpperCase();
    this.element.setAttribute('aria-label', `Commit by ${name}${profile ? ` (@${profile.login})` : ''}`);
    this.element.dataset.commit = commit.sha || '';
    this._setAvatar(profile?.avatarUrl || null);
    if (changed) this._renderBubble(commit);
    this._syncBubbleVisibility();
  }

  _syncBubbleVisibility() {
    const available = this.hasCommit && !this.playing;
    const expanded = available && !this.collapsed;
    this.bubble.hidden = !expanded;
    this.element.dataset.playing = String(this.playing);
    this.element.dataset.collapsed = String(this.collapsed);
    if (!expanded) this.element.dataset.compact = 'false';
    const action = `${expanded ? 'Hide' : 'Show'} commit title by ${this.name.textContent || 'Unknown author'}`;
    for (const control of [this.portrait, this.name]) {
      control.disabled = !available;
      control.setAttribute('aria-controls', this.bubble.id);
      control.setAttribute('aria-expanded', String(expanded));
      control.setAttribute('aria-label', action);
      control.title = action;
    }
    const active = document.activeElement;
    if ((!expanded && this.bubble.contains(active)) || (!available && (active === this.portrait || active === this.name))) active?.blur();
  }

  _renderBubble(commit) {
    this.message.textContent = String(commit.message || '').split(/\r\n?|\n/u).map(line => line.trim()).find(Boolean) || '(No commit title)';
    this.message.scrollTop = 0;
    this.bubbleScroll.scrollTop = 0;
    this.fileList.scrollTop = 0;
    const changes = commit.changes || commit.files || [];
    const count = changes.length;
    const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    const additions = changes.reduce((sum, file) => sum + number(file.additions), 0);
    const deletions = changes.reduce((sum, file) => sum + number(file.deletions), 0);
    const format = value => value.toLocaleString();
    this.bubble.querySelector('.data-bubble-file-count').textContent = `${format(count)} ${count === 1 ? 'file' : 'files'} changed`;
    this.bubble.querySelector('.data-bubble-added').textContent = `+${format(additions)}`;
    this.bubble.querySelector('.data-bubble-deleted').textContent = `−${format(deletions)}`;
    this.bubble.querySelector('.data-bubble-lines').setAttribute('aria-label', `${format(additions)} lines added, ${format(deletions)} lines deleted`);
    this.fileDetails.open = false;
    this.fileList.replaceChildren(...changes.map(file => {
      const row = document.createElement(file.id ? 'button' : 'div');
      row.className = 'data-bubble-file';
      if (file.id) { row.type = 'button'; row.dataset.fileId = file.id; }
      const path = document.createElement('span');
      path.textContent = file.path;
      const status = document.createElement('span');
      status.className = 'data-bubble-status';
      status.textContent = file.status || 'modified';
      row.append(path, status);
      return row;
    }));
    const notices = [];
    if (commit.isMerge) notices.push('Merge · changes relative to the first parent.');
    if (commit.partial) notices.push('Partial diff · counts cover loaded files only.');
    if ((commit.files || []).some(file => file.binary)) notices.push('Binary files are included; line totals cover text changes.');
    this.notice.textContent = notices.join(' ');
    this.notice.hidden = notices.length === 0;
    this.commitId.textContent = String(commit.sha || '').slice(0, 7);
    this.commitId.title = commit.sha || '';
    this.commitId.setAttribute('aria-label', `Commit ${commit.sha || 'ID unavailable'}`);
    let url = null;
    try {
      const parsed = new URL(commit.url);
      if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && !parsed.username && !parsed.password && !parsed.port
        && /^\/[^/]+\/[^/]+\/commit\/[a-z\d]+\/?$/i.test(parsed.pathname)) url = parsed.href;
    } catch { /* A local fixture or unavailable commit has no external link. */ }
    this.commitLink.hidden = !url;
    this.commitLink.removeAttribute('href');
    if (url) this.commitLink.href = url;
  }

  setPlayback(playing) {
    this.playing = Boolean(playing);
    this._syncBubbleVisibility();
    if (!this.playing) this.stopPulse();
  }

  _setAvatar(url) {
    if (this.avatarUrl === url) return;
    this.avatarUrl = url;
    if (this.image) {
      this.image.onload = this.image.onerror = null;
      this.image.removeAttribute('src');
      this.image.remove();
      this.image = null;
    }
    this.initials.hidden = false;
    if (!url) return;
    const image = document.createElement('img');
    image.alt = '';
    image.hidden = true;
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.draggable = false;
    this.image = image;
    image.onload = () => {
      if (this.image !== image) return;
      image.hidden = false;
      this.initials.hidden = true;
    };
    image.onerror = () => {
      if (this.image !== image) return;
      image.hidden = true;
      this.initials.hidden = false;
    };
    this.portrait.append(image);
    image.src = url;
  }

  pulse(duration = 420) {
    this.stopPulse();
    if (!this.requestedVisible || !this.object.visible || !this.playing) return;
    this.pulseAnimation = this.pulseRing.animate([
      { opacity: 0, transform: 'translate(-50%, -50%) scale(.9)' },
      { opacity: .9, offset: .18 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(2.1)' },
    ], { duration: Math.max(140, Math.min(420, duration)), easing: 'ease-out' });
  }

  stopPulse() {
    this.pulseAnimation?.cancel();
    this.pulseAnimation = null;
  }

  setVisible(visible, position, { detached = false } = {}) {
    this.detached = detached;
    this.requestedVisible = Boolean(visible && this.hasCommit);
    if (!this.requestedVisible) this.stopPulse();
    if (position) { this.anchor.fromArray(position); this.object.position.copy(this.anchor); }
    this.object.visible = this.requestedVisible;
    this.element.hidden = !this.requestedVisible;
  }

  update(camera, width, height) {
    if (!this.requestedVisible) return null;
    this.projected.copy(this.anchor);
    this.object.parent?.localToWorld(this.projected);
    this.projected.project(camera);
    const { x, y, z } = this.projected;
    const inView = z >= -1 && z <= 1 && Math.abs(x) <= 1 && Math.abs(y) <= 1;
    let screenX = (x * .5 + .5) * width, screenY = (-y * .5 + .5) * height;
    const bounds = this.playing ? null : this._bubbleBounds(width, height);
    const expanded = !this.playing && !this.collapsed;
    const compact = expanded && bounds.bottom - bounds.top < 260;
    this.element.dataset.compact = String(compact);
    const docked = !this.playing && (this.detached || !inView || screenX < bounds.left + 22 || screenX > bounds.right - 22
      || screenY < bounds.top + 24 || screenY > bounds.bottom - 60);
    if (docked) {
      // Keep paused details reachable while inspecting a subtree away from the root.
      screenX = bounds.left + Math.min(80, (bounds.right - bounds.left) / 2);
      screenY = bounds.top + 30;
      this.object.position.set(screenX / width * 2 - 1, 1 - screenY / height * 2, 0).unproject(camera);
      this.object.parent?.worldToLocal(this.object.position);
    } else this.object.position.copy(this.anchor);
    let authorClamped = false;
    if (!this.playing && this.collapsed) {
      // A collapsed credit remains a reachable disclosure, including offscreen roots.
      const half = Math.max(24, Math.min(96, this.caption.offsetWidth / 2 || 96));
      const clampedX = Math.max(bounds.left + half, Math.min(screenX, bounds.right - half));
      const clampedY = Math.max(bounds.top + 24, Math.min(screenY, bounds.bottom - 60));
      authorClamped = clampedX !== screenX || clampedY !== screenY;
      screenX = clampedX;
      screenY = clampedY;
      this.object.position.set(screenX / width * 2 - 1, 1 - screenY / height * 2, 0).unproject(camera);
      this.object.parent?.worldToLocal(this.object.position);
    }
    this.element.dataset.docked = String(docked || authorClamped);
    const visible = inView || docked;
    this.object.visible = visible;
    this.element.hidden = !visible;
    if (!visible) { this.stopPulse(); return null; }
    if (expanded) {
      // CSS owns the shared preferred width. Screen bounds only constrain it;
      // leave a clear lane for the author's portrait and caption when stacked.
      this.element.style.setProperty('--bubble-available-width', `${Math.max(1, bounds.right - bounds.left)}px`);
      this.bubble.style.setProperty('--bubble-available-height', `${Math.max(1, bounds.bottom - bounds.top - (compact ? 0 : 96))}px`);
      const bubbleWidth = this.bubble.offsetWidth;
      const bubbleHeight = this.bubble.offsetHeight;
      let placement = placeCommitBubble({ x: screenX, y: screenY, width, height, bubbleWidth, bubbleHeight, bounds });
      const overlaps = rect => placement.left < rect.right && placement.left + bubbleWidth > rect.left
        && placement.top < rect.bottom && placement.top + bubbleHeight > rect.top;
      const captionHalf = Math.min(96, this.caption.offsetWidth / 2 || 96);
      if (!compact && bubbleWidth && bubbleHeight && (overlaps({ left: screenX - 24, right: screenX + 24, top: screenY - 24, bottom: screenY + 24 })
        || overlaps({ left: screenX - captionHalf, right: screenX + captionHalf, top: screenY + 24, bottom: screenY + 60 }))) {
        // A full reading panel may not fit beside the projected root. Keep its
        // author in a clear row above it instead of covering the portrait/name.
        screenX = Math.max(bounds.left + bubbleWidth / 2, Math.min(screenX, bounds.right - bubbleWidth / 2));
        screenY = bounds.top + 24;
        placement = placeCommitBubble({ x: screenX, y: screenY, width, height, bubbleWidth, bubbleHeight, bounds, allowSide: false });
        this.object.position.set(screenX / width * 2 - 1, 1 - screenY / height * 2, 0).unproject(camera);
        this.object.parent?.worldToLocal(this.object.position);
        this.element.dataset.docked = 'true';
      }
      this.bubble.style.visibility = bubbleWidth && bubbleHeight ? '' : 'hidden';
      this.bubble.style.left = `${placement.left - screenX}px`;
      this.bubble.style.top = `${placement.top - screenY}px`;
      this.element.style.setProperty('--bubble-left', this.bubble.style.left);
      this.element.style.setProperty('--bubble-top', this.bubble.style.top);
      this.bubble.dataset.side = placement.side;
      this.bubble.style.setProperty('--bubble-tail', `${placement.tail}px`);
      if (compact) return { x: placement.left + bubbleWidth / 2, y: placement.top + bubbleHeight / 2,
        half: bubbleWidth / 2, height: bubbleHeight / 2 + 12 };
      const left = Math.min(screenX - 96, placement.left);
      const right = Math.max(screenX + 96, placement.left + bubbleWidth);
      const top = Math.min(screenY - 24, placement.top);
      const bottom = Math.max(screenY + 60, placement.top + bubbleHeight);
      return { x: (left + right) / 2, y: (top + bottom) / 2, half: (right - left) / 2, height: (bottom - top) / 2 + 12 };
    }
    return { x: screenX, y: screenY + 16, half: 96, height: 50 };
  }

  _bubbleBounds(width, height) {
    const bounds = { left: 12, right: width - 12, top: width <= 900 ? 146 : 76, bottom: height - 18 };
    const visibleRect = selector => {
      const element = document.querySelector(selector);
      if (!element || element.hidden) return null;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? rect : null;
    };
    const timebar = visibleRect('#data-timebar');
    if (timebar) bounds.bottom = Math.min(bounds.bottom, timebar.top - 12);
    if (width > 900) {
      const guide = visibleRect('#data-guide'), panel = visibleRect('#data-panel');
      if (guide && guide.left < width / 3) bounds.left = Math.max(bounds.left, guide.right + 14);
      if (panel && panel.right > width * 2 / 3) bounds.right = Math.min(bounds.right, panel.left - 14);
      // Narrow or freely dragged panels must not squeeze the message out of view.
      if (bounds.right - bounds.left < 230) { bounds.left = 12; bounds.right = width - 12; }
    }
    bounds.top = Math.min(bounds.top, Math.max(12, bounds.bottom - 140));
    return bounds;
  }

  dispose() {
    this.setCommit(null);
    this.listeners.abort();
    this.releaseGlass();
    this.object.removeFromParent();
    this.element.remove();
  }
}
