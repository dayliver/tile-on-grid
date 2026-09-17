import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const DEFAULT_H_STEPS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1];
const DEFAULT_V_STEPS = [1 / 3, 0.5, 2 / 3, 1];
const EPS = 1e-4;

function parseFraction(text) {
    const s = String(text).trim();
    if (!s)
        return NaN;
    if (s.includes('/')) {
        const parts = s.split('/');
        if (parts.length !== 2)
            return NaN;
        const a = Number(parts[0]);
        const b = Number(parts[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0)
            return NaN;
        return a / b;
    }
    return Number(s);
}

function parseStepList(strv, fallback) {
    const out = [];
    for (const item of strv || []) {
        const v = parseFraction(item);
        if (Number.isFinite(v) && v > 0 && v <= 1 + EPS)
            out.push(Math.min(1, v));
    }
    out.sort((a, b) => a - b);
    const unique = [];
    for (const v of out) {
        if (!unique.length || Math.abs(unique[unique.length - 1] - v) > EPS)
            unique.push(v);
    }
    return unique.length ? unique : fallback.slice();
}

function nearestIndex(value, steps) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < steps.length; i++) {
        const d = Math.abs(steps[i] - value);
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    }
    return best;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function formatAccel(accel) {
    if (!accel)
        return '—';
    return accel
        .replace(/</g, '')
        .replace(/>/g, '')
        .replace(/Primary/g, 'Ctrl');
}

/** Classify a 0–1 guide for stroke styling. */
function guideFamily(frac) {
    for (let k = 1; k <= 2; k++) {
        if (Math.abs(frac - k / 3) < 0.02)
            return 'third';
    }
    for (let k = 1; k <= 3; k++) {
        if (Math.abs(frac - k / 4) < 0.02)
            return 'quarter';
    }
    return 'other';
}

const GUIDE_STYLE = {
    third: { color: 'rgba(120, 210, 255, 0.9)', dash: [10, 7] },
    quarter: { color: 'rgba(255, 190, 90, 0.9)', dash: [6, 5] },
    other: { color: 'rgba(200, 200, 200, 0.75)', dash: [4, 4] },
};

const DashGuide = GObject.registerClass(
class DashGuide extends St.DrawingArea {
    _init(vertical, family) {
        super._init({
            reactive: false,
            can_focus: false,
            request_mode: Clutter.RequestMode.CONTENT_SIZE,
        });
        this._vertical = vertical;
        this._family = family;
        this.connect('repaint', () => this._paint());
    }

    _paint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const style = GUIDE_STYLE[this._family] || GUIDE_STYLE.other;
        const m = style.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
        if (!m) {
            cr.$dispose();
            return;
        }
        cr.setSourceRGBA(
            Number(m[1]) / 255,
            Number(m[2]) / 255,
            Number(m[3]) / 255,
            Number(m[4])
        );
        cr.setDash(style.dash, 0);
        cr.setLineWidth(2);
        if (this._vertical) {
            cr.moveTo(w * 0.5, 0);
            cr.lineTo(w * 0.5, h);
        } else {
            cr.moveTo(0, h * 0.5);
            cr.lineTo(w, h * 0.5);
        }
        cr.stroke();
        cr.$dispose();
    }

    vfunc_get_preferred_width(_forHeight) {
        return this._vertical ? [2, 2] : [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return this._vertical ? [0, 0] : [2, 2];
    }
});

class SnapGuidePreview {
    constructor() {
        this._root = null;
        this._fadeTimeoutId = null;
        this._removing = false;
    }

    destroy() {
        this._cancelFade();
        this._destroyRoot();
    }

    _cancelFade() {
        if (this._fadeTimeoutId) {
            GLib.Source.remove(this._fadeTimeoutId);
            this._fadeTimeoutId = null;
        }
        if (this._root) {
            this._root.remove_all_transitions?.();
            this._root.opacity = 255;
        }
        this._removing = false;
    }

    _destroyRoot() {
        if (!this._root)
            return;
        const root = this._root;
        this._root = null;
        try {
            Main.layoutManager.removeChrome(root);
        } catch (e) {
            /* already removed */
        }
        root.destroy();
    }

    /**
     * Show third/quarter guide lattice + highlight for the target fraction state.
     * @param {object} area usable rect {x,y,width,height}
     * @param {object} state {x,y,w,h} fractions
     * @param {number} gap inner padding
     * @param {number[]} hSteps
     * @param {number[]} vSteps
     */
    show(area, state, gap, hSteps, vSteps) {
        this._cancelFade();

        if (!this._root) {
            this._root = new St.Widget({
                name: 'tile-on-grid-snap-guides',
                reactive: false,
                can_focus: false,
                layout_manager: null,
                opacity: 255,
            });
            Main.layoutManager.addTopChrome(this._root, {
                affectsInputRegion: false,
                trackFullscreen: true,
            });
        } else {
            this._root.destroy_all_children();
            this._root.opacity = 255;
            this._root.show();
        }

        const root = this._root;
        root.set_position(area.x, area.y);
        root.set_size(area.width, area.height);

        const vGuides = this._collectGuides(hSteps, true);
        const hGuides = this._collectGuides(vSteps, false);

        for (const g of vGuides) {
            if (g.frac <= EPS || g.frac >= 1 - EPS)
                continue;
            const line = new DashGuide(true, g.family);
            root.add_child(line);
            const px = Math.round(g.frac * area.width);
            line.set_position(px - 1, 0);
            line.set_size(2, area.height);
        }

        for (const g of hGuides) {
            if (g.frac <= EPS || g.frac >= 1 - EPS)
                continue;
            const line = new DashGuide(false, g.family);
            root.add_child(line);
            const py = Math.round(g.frac * area.height);
            line.set_position(0, py - 1);
            line.set_size(area.width, 2);
        }

        const leftGap = state.x > EPS ? gap / 2 : 0;
        const rightGap = state.x + state.w < 1 - EPS ? gap / 2 : 0;
        const topGap = state.y > EPS ? gap / 2 : 0;
        const bottomGap = state.y + state.h < 1 - EPS ? gap / 2 : 0;

        let hx = Math.round(state.x * area.width + leftGap);
        let hy = Math.round(state.y * area.height + topGap);
        let hw = Math.round(state.w * area.width - leftGap - rightGap);
        let hh = Math.round(state.h * area.height - topGap - bottomGap);
        if (Math.abs(state.x + state.w - 1) < EPS)
            hw = area.width - hx;
        if (Math.abs(state.y + state.h - 1) < EPS)
            hh = area.height - hy;

        const highlight = new St.Widget({
            reactive: false,
            style: `
                background-color: rgba(120, 180, 255, 0.18);
                border: 2px solid rgba(140, 200, 255, 0.85);
                border-radius: 10px;
            `,
        });
        root.add_child(highlight);
        highlight.set_position(hx, hy);
        highlight.set_size(Math.max(1, hw), Math.max(1, hh));
    }

    _collectGuides(steps, _horizontalAxis) {
        // Always include full third + quarter lattices, plus any custom steps.
        const map = new Map();
        const add = (frac, family) => {
            if (frac <= EPS || frac >= 1 - EPS)
                return;
            const key = Math.round(frac * 10000);
            if (!map.has(key))
                map.set(key, { frac, family });
        };

        for (const f of [1 / 3, 2 / 3])
            add(f, 'third');
        for (const f of [1 / 4, 1 / 2, 3 / 4])
            add(f, 'quarter');

        for (const s of steps || []) {
            if (s <= EPS || s >= 1 - EPS)
                continue;
            const fam = guideFamily(s);
            // Prefer third/quarter labels; don't overwrite third with other.
            const key = Math.round(s * 10000);
            if (!map.has(key) || fam !== 'other')
                map.set(key, { frac: s, family: fam === 'other' && map.has(key) ? map.get(key).family : fam });
        }

        return [...map.values()].sort((a, b) => a.frac - b.frac);
    }

    /** After the window finishes moving, hold briefly then fade out. */
    scheduleFadeOut(holdMs = 180, fadeMs = 380) {
        this._cancelFade();
        if (!this._root)
            return;

        this._root.opacity = 255;
        this._fadeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, holdMs, () => {
            this._fadeTimeoutId = null;
            const root = this._root;
            if (!root)
                return GLib.SOURCE_REMOVE;

            this._removing = true;
            root.ease({
                opacity: 0,
                duration: fadeMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._removing)
                        this._destroyRoot();
                },
            });
            return GLib.SOURCE_REMOVE;
        });
    }
}

class WindowManager {
    constructor(settings, guidePreview = null) {
        this._settings = settings;
        this._guidePreview = guidePreview;
        this._animId = null;
        this._settleId = null;
        this._windowStates = new WeakMap();
    }

    destroy() {
        if (this._animId) {
            GLib.Source.remove(this._animId);
            this._animId = null;
        }
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = null;
        }
        this._guidePreview?.destroy();
        this._guidePreview = null;
    }

    _hSteps() {
        const steps = parseStepList(this._settings.get_strv('horizontal-steps'), DEFAULT_H_STEPS);
        if (steps[steps.length - 1] < 1 - EPS)
            steps.push(1);
        return steps;
    }

    _vSteps() {
        const steps = parseStepList(this._settings.get_strv('vertical-steps'), DEFAULT_V_STEPS);
        if (steps[steps.length - 1] < 1 - EPS)
            steps.push(1);
        return steps;
    }

    _getWorkArea(window) {
        const workArea = window.get_work_area_current_monitor();
        return {
            x: workArea.x,
            y: workArea.y,
            width: workArea.width,
            height: workArea.height,
        };
    }

    _innerArea(workArea) {
        const inset = this._settings.get_int('padding-outer');
        return {
            x: workArea.x + inset,
            y: workArea.y + inset,
            width: Math.max(1, workArea.width - 2 * inset),
            height: Math.max(1, workArea.height - 2 * inset),
        };
    }

    _inferState(window) {
        const workArea = this._getWorkArea(window);
        const area = this._innerArea(workArea);
        const rect = window.get_frame_rect();
        const hSteps = this._hSteps();
        const vSteps = this._vSteps();

        let w = clamp(rect.width / area.width, hSteps[0], 1);
        let h = clamp(rect.height / area.height, vSteps[0], 1);
        w = hSteps[nearestIndex(w, hSteps)];
        h = vSteps[nearestIndex(h, vSteps)];

        let x = (rect.x - area.x) / area.width;
        let y = (rect.y - area.y) / area.height;
        x = clamp(x, 0, 1 - w);
        y = clamp(y, 0, 1 - h);

        // Snap edges toward 0 / 1 when close.
        if (x < 0.05)
            x = 0;
        if (Math.abs(x + w - 1) < 0.05)
            x = 1 - w;
        if (y < 0.05)
            y = 0;
        if (Math.abs(y + h - 1) < 0.05)
            y = 1 - h;

        return { x, y, w, h };
    }

    getWindowState(window) {
        if (!this._windowStates.has(window))
            this._windowStates.set(window, this._inferState(window));
        return this._windowStates.get(window);
    }

    setWindowState(window, state) {
        this._windowStates.set(window, state);
    }

    focusNeighbor(direction) {
        const display = global.display;
        const currentWin = display.focus_window;
        if (!currentWin)
            return;

        const windows = display.get_tab_list(
            Meta.TabList.NORMAL,
            display.get_workspace_manager().get_active_workspace()
        );
        let bestWin = null;
        let minDistance = Infinity;
        const currentRect = currentWin.get_frame_rect();
        const currentCenter = {
            x: currentRect.x + currentRect.width / 2,
            y: currentRect.y + currentRect.height / 2,
        };

        windows.forEach(win => {
            if (win === currentWin)
                return;
            const rect = win.get_frame_rect();
            const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            let valid = false;
            const deltaX = center.x - currentCenter.x;
            const deltaY = center.y - currentCenter.y;
            const THRESHOLD = 10;

            if (direction === 'left')
                valid = deltaX < -THRESHOLD;
            else if (direction === 'right')
                valid = deltaX > THRESHOLD;
            else if (direction === 'up')
                valid = deltaY < -THRESHOLD;
            else if (direction === 'down')
                valid = deltaY > THRESHOLD;

            if (valid) {
                const distance = Math.hypot(deltaX, deltaY);
                if (distance < minDistance) {
                    minDistance = distance;
                    bestWin = win;
                }
            }
        });

        if (bestWin)
            bestWin.activate(global.get_current_time());
    }

    /**
     * Position candidates for a fixed size along [0, 1 - size], using step edges as guides.
     */
    _positionCandidates(size, steps) {
        const guides = [0];
        for (const s of steps) {
            if (s > EPS && s < 1 - EPS)
                guides.push(s);
        }
        guides.push(1);

        const candidates = [];
        for (const g of guides) {
            if (g <= 1 - size + EPS)
                candidates.push(clamp(g, 0, 1 - size));
        }
        // Always allow right/bottom alignment.
        candidates.push(1 - size);

        candidates.sort((a, b) => a - b);
        const unique = [];
        for (const v of candidates) {
            if (!unique.length || Math.abs(unique[unique.length - 1] - v) > EPS)
                unique.push(v);
        }
        return unique;
    }

    _nextPosition(pos, size, steps, forward) {
        const cands = this._positionCandidates(size, steps);
        if (forward) {
            for (const c of cands) {
                if (c > pos + EPS)
                    return c;
            }
            return cands[cands.length - 1];
        }
        for (let i = cands.length - 1; i >= 0; i--) {
            if (cands[i] < pos - EPS)
                return cands[i];
        }
        return cands[0];
    }

    _nextSize(size, steps, larger) {
        const idx = nearestIndex(size, steps);
        if (larger) {
            if (idx < steps.length - 1)
                return steps[idx + 1];
            return steps[idx];
        }
        if (idx > 0)
            return steps[idx - 1];
        return steps[idx];
    }

    transformWindow(window, action, direction) {
        let state = { ...this.getWindowState(window) };
        const hSteps = this._hSteps();
        const vSteps = this._vSteps();

        // Re-snap size to configured lists in case prefs changed.
        state.w = hSteps[nearestIndex(state.w, hSteps)];
        state.h = vSteps[nearestIndex(state.h, vSteps)];
        state.x = clamp(state.x, 0, 1 - state.w);
        state.y = clamp(state.y, 0, 1 - state.h);

        if (action === 'move') {
            if (direction === 'left')
                state.x = this._nextPosition(state.x, state.w, hSteps, false);
            else if (direction === 'right')
                state.x = this._nextPosition(state.x, state.w, hSteps, true);
            else if (direction === 'up')
                state.y = this._nextPosition(state.y, state.h, vSteps, false);
            else if (direction === 'down')
                state.y = this._nextPosition(state.y, state.h, vSteps, true);
        } else if (action === 'expand') {
            if (direction === 'right') {
                const newW = this._nextSize(state.w, hSteps, true);
                if (state.x + newW <= 1 + EPS)
                    state.w = newW;
                else if (newW <= 1 + EPS) {
                    state.x = Math.max(0, 1 - newW);
                    state.w = newW;
                }
            } else if (direction === 'left') {
                const newW = this._nextSize(state.w, hSteps, true);
                const grow = newW - state.w;
                if (grow > EPS && state.x >= grow - EPS) {
                    state.x -= grow;
                    state.w = newW;
                } else if (newW <= 1 + EPS) {
                    state.x = 0;
                    state.w = Math.min(newW, 1);
                }
            } else if (direction === 'down') {
                const newH = this._nextSize(state.h, vSteps, true);
                if (state.y + newH <= 1 + EPS)
                    state.h = newH;
                else if (newH <= 1 + EPS) {
                    state.y = Math.max(0, 1 - newH);
                    state.h = newH;
                }
            } else if (direction === 'up') {
                const newH = this._nextSize(state.h, vSteps, true);
                const grow = newH - state.h;
                if (grow > EPS && state.y >= grow - EPS) {
                    state.y -= grow;
                    state.h = newH;
                } else if (newH <= 1 + EPS) {
                    state.y = 0;
                    state.h = Math.min(newH, 1);
                }
            }
        } else if (action === 'shrink') {
            // Shrink toward the arrow: the opposite edge moves inward.
            if (direction === 'left') {
                state.w = this._nextSize(state.w, hSteps, false);
            } else if (direction === 'right') {
                const newW = this._nextSize(state.w, hSteps, false);
                state.x += state.w - newW;
                state.w = newW;
            } else if (direction === 'up') {
                state.h = this._nextSize(state.h, vSteps, false);
            } else if (direction === 'down') {
                const newH = this._nextSize(state.h, vSteps, false);
                state.y += state.h - newH;
                state.h = newH;
            }
        }

        state.x = clamp(state.x, 0, 1 - state.w);
        state.y = clamp(state.y, 0, 1 - state.h);

        this.setWindowState(window, state);
        this.applyState(window, state);
    }

    applyState(window, state) {
        if (!window || !window.get_monitor)
            return;

        this.setWindowState(window, state);

        const workArea = this._getWorkArea(window);
        const area = this._innerArea(workArea);
        const gap = this._settings.get_int('padding-inner');

        this._guidePreview?.show(area, state, gap, this._hSteps(), this._vSteps());

        // Half-gap on edges that don't touch the usable area → full gap between adjacent tiles.
        const leftGap = state.x > EPS ? gap / 2 : 0;
        const rightGap = state.x + state.w < 1 - EPS ? gap / 2 : 0;
        const topGap = state.y > EPS ? gap / 2 : 0;
        const bottomGap = state.y + state.h < 1 - EPS ? gap / 2 : 0;

        let targetX = Math.round(area.x + state.x * area.width + leftGap);
        let targetY = Math.round(area.y + state.y * area.height + topGap);
        let targetW = Math.round(state.w * area.width - leftGap - rightGap);
        let targetH = Math.round(state.h * area.height - topGap - bottomGap);

        // Absorb rounding so right/bottom edges meet the usable area when aligned.
        if (Math.abs(state.x + state.w - 1) < EPS)
            targetW = area.x + area.width - targetX;
        if (Math.abs(state.y + state.h - 1) < EPS)
            targetH = area.y + area.height - targetY;

        this._animateWindow(window, {
            x: targetX,
            y: targetY,
            width: Math.max(1, targetW),
            height: Math.max(1, targetH),
        });
    }

    _scheduleResizeSettle(window, targetGeo) {
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = null;
        }
        const { x, y, width: w, height: h } = targetGeo;
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 75, () => {
            this._settleId = null;
            try {
                window.move_resize_frame(true, x, y, w, h);
            } catch (e) {
                /* window gone */
            }
            this._guidePreview?.scheduleFadeOut(160, 400);
            return GLib.SOURCE_REMOVE;
        });
    }

    _animateWindow(window, targetGeo) {
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = null;
        }

        if (window.maximized_horizontally || window.maximized_vertically)
            window.unmaximize(Meta.MaximizeFlags.BOTH);

        const animate = this._settings.get_boolean('animate-movement');
        const duration = this._settings.get_int('animation-duration');
        const startGeo = window.get_frame_rect();

        if (!animate) {
            window.move_resize_frame(true, targetGeo.x, targetGeo.y, targetGeo.width, targetGeo.height);
            this._scheduleResizeSettle(window, targetGeo);
            return;
        }

        if (this._animId)
            GLib.Source.remove(this._animId);

        let time = 0;
        this._animId = GLib.timeout_add(GLib.PRIORITY_HIGH, 10, () => {
            time += 10;
            let t = time / duration;
            if (t > 1)
                t = 1;
            t = (--t) * t * t + 1;

            const cx = (1 - t) * startGeo.x + t * targetGeo.x;
            const cy = (1 - t) * startGeo.y + t * targetGeo.y;
            const cw = (1 - t) * startGeo.width + t * targetGeo.width;
            const ch = (1 - t) * startGeo.height + t * targetGeo.height;

            window.move_resize_frame(true, Math.round(cx), Math.round(cy), Math.round(cw), Math.round(ch));

            if (t === 1) {
                this._animId = null;
                this._scheduleResizeSettle(window, targetGeo);
                return false;
            }
            return true;
        });
    }
}

const HelpOverlay = GObject.registerClass(
class HelpOverlay extends St.Widget {
    _init(monitor, settings, onClose) {
        super._init({
            style_class: 'tile-help-overlay',
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            style: 'background-color: rgba(0, 0, 0, 0.45);',
        });

        this._onClose = onClose;
        this._settings = settings;
        this.set_layout_manager(new Clutter.BinLayout());

        const card = new St.BoxLayout({
            vertical: true,
            style: `
                background-color: rgba(28, 28, 30, 0.96);
                border-radius: 20px;
                padding: 28px 32px;
                spacing: 14px;
                border: 1px solid rgba(255,255,255,0.12);
                min-width: 420px;
            `,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(card);

        const titleRow = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 16px;',
            x_expand: true,
        });
        titleRow.add_child(new St.Label({
            text: 'Tile on Grid',
            style: 'font-size: 22px; font-weight: 800; color: #ffffff;',
            x_expand: true,
        }));
        const closeBtn = new St.Button({
            label: '✖',
            style: 'color: #ff8888; font-size: 16px; padding: 4px 8px;',
            reactive: true,
            can_focus: true,
        });
        closeBtn.connect('clicked', () => this._onClose?.());
        titleRow.add_child(closeBtn);
        card.add_child(titleRow);

        card.add_child(new St.Label({
            text: 'Fraction snap tiling — shortcuts',
            style: 'font-size: 13px; color: #aaaaaa; margin-bottom: 8px;',
        }));

        const addLine = (label, keys) => {
            const line = new St.BoxLayout({
                vertical: false,
                style: 'spacing: 16px;',
                x_expand: true,
            });
            line.add_child(new St.Label({
                text: label,
                style: 'font-size: 14px; color: #dddddd; font-weight: 600; min-width: 130px;',
            }));
            const accel = keys.map(k => formatAccel(settings.get_strv(k)[0] || '')).join('  ·  ');
            line.add_child(new St.Label({
                text: accel,
                style: 'font-size: 14px; color: #88ccff;',
                x_expand: true,
            }));
            card.add_child(line);
        };

        addLine('Show this help', ['toggle-grid-shortcut']);
        addLine('Move', ['move-left', 'move-right', 'move-up', 'move-down']);
        addLine('Expand', ['expand-left', 'expand-right', 'expand-up', 'expand-down']);
        addLine('Shrink', ['shrink-left', 'shrink-right', 'shrink-up', 'shrink-down']);
        addLine('Focus', ['focus-left', 'focus-right', 'focus-up', 'focus-down']);

        const hSteps = settings.get_strv('horizontal-steps').join(', ') || '1/4, 1/3, 1/2, 2/3, 3/4';
        const vSteps = settings.get_strv('vertical-steps').join(', ') || '1/3, 1/2, 2/3';
        card.add_child(new St.Label({
            text: `Horizontal sizes: ${hSteps}`,
            style: 'font-size: 12px; color: #999999; margin-top: 10px;',
        }));
        card.add_child(new St.Label({
            text: `Vertical sizes: ${vSteps}`,
            style: 'font-size: 12px; color: #999999;',
        }));
        card.add_child(new St.Label({
            text: 'Esc or Super+G to close · click outside to dismiss',
            style: 'font-size: 12px; color: #777777; margin-top: 6px;',
        }));

        this.connect('button-press-event', () => {
            this._onClose?.();
            return Clutter.EVENT_STOP;
        });
        card.connect('button-press-event', () => Clutter.EVENT_STOP);

        this.connect('key-press-event', this._onKeyPress.bind(this));
    }

    _onKeyPress(_actor, event) {
        const rawSymbol = event.get_key_symbol();
        if (rawSymbol === Clutter.KEY_Escape) {
            this._onClose?.();
            return Clutter.EVENT_STOP;
        }
        if (rawSymbol === Clutter.KEY_g && (event.get_state() & Clutter.ModifierType.SUPER_MASK)) {
            this._onClose?.();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }
});

export default class TileOnGrid extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._guidePreview = new SnapGuidePreview();
        this._manager = new WindowManager(this._settings, this._guidePreview);
        this._overlay = null;
        this._grab = null;
        this._capturedEventId = 0;
        this._focusIdleId = null;

        this._addKey('toggle-grid-shortcut', () => this._toggleHelp());

        ['left', 'right', 'up', 'down'].forEach(dir => {
            this._addKey(`move-${dir}`, () => this._handleDirectAction('move', dir));
            this._addKey(`expand-${dir}`, () => this._handleDirectAction('expand', dir));
            this._addKey(`shrink-${dir}`, () => this._handleDirectAction('shrink', dir));
            this._addKey(`focus-${dir}`, () => this._manager.focusNeighbor(dir));
        });
    }

    disable() {
        this._removeKey('toggle-grid-shortcut');
        ['left', 'right', 'up', 'down'].forEach(dir => {
            this._removeKey(`move-${dir}`);
            this._removeKey(`expand-${dir}`);
            this._removeKey(`shrink-${dir}`);
            this._removeKey(`focus-${dir}`);
        });

        this._closeOverlay();
        if (this._manager) {
            this._manager.destroy();
            this._manager = null;
        }
        this._guidePreview = null;
        this._settings = null;
    }

    _addKey(name, callback) {
        Main.wm.addKeybinding(
            name,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            callback
        );
    }

    _removeKey(name) {
        Main.wm.removeKeybinding(name);
    }

    _closeOverlay() {
        if (this._focusIdleId) {
            GLib.Source.remove(this._focusIdleId);
            this._focusIdleId = null;
        }

        if (this._capturedEventId && this._overlay) {
            this._overlay.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        if (this._overlay) {
            if (this._grab) {
                Main.popModal(this._grab);
                this._grab = null;
            }
            this._overlay.destroy();
            this._overlay = null;
        }
    }

    _toggleHelp() {
        if (this._overlay) {
            this._closeOverlay();
            return;
        }

        const win = global.display.focus_window;
        const monitorIndex = win
            ? win.get_monitor()
            : global.display.get_current_monitor();
        const monitor = Main.layoutManager.monitors[monitorIndex]
            || Main.layoutManager.primaryMonitor;

        this._overlay = new HelpOverlay(monitor, this._settings, () => this._closeOverlay());
        Main.layoutManager.modalDialogGroup.add_child(this._overlay);

        this._grab = Main.pushModal(this._overlay, {
            actionMode: Shell.ActionMode.SYSTEM_MODAL,
        });

        if (!this._grab) {
            this._closeOverlay();
            return;
        }

        this._capturedEventId = this._overlay.connect('captured-event', (_a, event) => {
            if (!this._overlay)
                return Clutter.EVENT_PROPAGATE;

            const type = event.type();
            if (type === Clutter.EventType.KEY_PRESS) {
                if (Main.keyboard.maybeHandleEvent(event))
                    return Clutter.EVENT_STOP;
                return this._overlay._onKeyPress(this._overlay, event);
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusIdleId = null;
            if (this._overlay) {
                global.stage.set_key_focus(this._overlay);
                this._overlay.grab_key_focus();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _handleDirectAction(action, direction) {
        const win = global.display.focus_window;
        if (!win)
            return;
        this._manager.transformWindow(win, action, direction);
    }
}
