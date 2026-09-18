import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    ACTION_GROUPS,
    FRACTION_OPTIONS,
    KEY_SCHEMES,
    MODIFIER_OPTIONS,
    applyDirectionalScheme,
    deselectFraction,
    detectKeyScheme,
    formatFraction,
    parseModifiers,
    schemeLabel,
    selectFraction,
    selectedFromSteps,
    stepsFromSelected,
    toggleModifier,
} from './settings-util.js';

const ACTION_GLYPHS = {
    move: '✥',
    expand: '⤢',
    shrink: '⤡',
    focus: '◎',
};

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

/**
 * Non-modal snap lattice. Must never run before window placement, and must
 * never throw into the tiling path (all public entry points are try/caught).
 *
 * Fade is driven by polling modifier state (WM keybindings often swallow
 * stage key-release events, so a one-shot key-up check is unreliable).
 */
class SnapGuidePreview {
    constructor() {
        this._root = null;
        this._pollId = null;
        this._fading = false;
        this._lastFlashUs = 0;
    }

    destroy() {
        this._stopPoll();
        this._teardown();
    }

    _stopPoll() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = null;
        }
        this._fading = false;
    }

    _teardown() {
        this._stopPoll();
        if (!this._root)
            return;
        const root = this._root;
        this._root = null;
        try {
            root.remove_all_transitions?.();
        } catch (e) { /* ignore */ }
        try {
            const parent = root.get_parent();
            if (parent)
                parent.remove_child(root);
        } catch (e) { /* ignore */ }
        try {
            root.destroy();
        } catch (e) { /* ignore */ }
    }

    _guideColor(frac) {
        for (let k = 1; k <= 2; k++) {
            if (Math.abs(frac - k / 3) < 0.02)
                return 'rgba(120, 210, 255, 0.95)';
        }
        for (let k = 1; k <= 3; k++) {
            if (Math.abs(frac - k / 4) < 0.02)
                return 'rgba(255, 190, 90, 0.95)';
        }
        return 'rgba(220, 220, 220, 0.9)';
    }

    _modsHeld() {
        try {
            const mods = global.get_pointer()[2];
            let mask =
                Clutter.ModifierType.SUPER_MASK |
                Clutter.ModifierType.CONTROL_MASK |
                Clutter.ModifierType.SHIFT_MASK |
                Clutter.ModifierType.MOD1_MASK;
            // Super is often MOD4 on X11/Wayland seats.
            if (Clutter.ModifierType.MOD4_MASK !== undefined)
                mask |= Clutter.ModifierType.MOD4_MASK;
            if (Clutter.ModifierType.META_MASK !== undefined)
                mask |= Clutter.ModifierType.META_MASK;
            if (Clutter.ModifierType.HYPER_MASK !== undefined)
                mask |= Clutter.ModifierType.HYPER_MASK;
            return (mods & mask) !== 0;
        } catch (e) {
            return false;
        }
    }

    _beginFade() {
        const actor = this._root;
        if (!actor)
            return;
        this._fading = true;
        try {
            actor.ease({
                opacity: 0,
                duration: 280,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._fading)
                        this._teardown();
                },
            });
        } catch (e) {
            this._teardown();
        }
    }

    _startReleasePoll() {
        this._stopPoll();
        this._lastFlashUs = GLib.get_monotonic_time();
        // Keep polling until modifiers are up (and a short calm after last flash).
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._root) {
                this._pollId = null;
                return GLib.SOURCE_REMOVE;
            }
            if (this._fading)
                return GLib.SOURCE_CONTINUE;

            const held = this._modsHeld();
            const idleMs = (GLib.get_monotonic_time() - this._lastFlashUs) / 1000;
            // Wait until tiling modifiers are released, then a brief calm so
            // Super+Arrow chords don't fade between key repeats.
            if (held || idleMs < 320)
                return GLib.SOURCE_CONTINUE;

            this._pollId = null;
            this._beginFade();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * @param {{x:number,y:number,width:number,height:number}} monitor
     * @param {{x:number,y:number,width:number,height:number}} area
     * @param {{x:number,y:number,w:number,h:number}} state
     * @param {number} gap
     * @param {number[]} hSteps
     * @param {number[]} vSteps
     */
    flash(monitor, area, state, gap, hSteps, vSteps) {
        try {
            this._flashImpl(monitor, area, state, gap, hSteps, vSteps);
        } catch (e) {
            console.warn(`[TileOnGrid] snap guide skipped: ${e}`);
            try {
                this.destroy();
            } catch (e2) { /* ignore */ }
        }
    }

    _addDashLine(parent, vertical, x, y, length, color) {
        const dash = 8;
        const gap = 6;
        const thickness = 1;
        let offset = 0;
        while (offset < length) {
            const seg = Math.min(dash, length - offset);
            if (seg <= 0)
                break;
            const bit = new St.Widget({
                reactive: false,
                style: `background-color: ${color};`,
            });
            parent.add_child(bit);
            if (vertical) {
                bit.set_position(x, y + offset);
                bit.set_size(thickness, seg);
            } else {
                bit.set_position(x + offset, y);
                bit.set_size(seg, thickness);
            }
            offset += dash + gap;
        }
    }

    _addFractionLabel(parent, text, x, y, color, align = 'center') {
        const label = new St.Label({
            text,
            reactive: false,
            style: `
                font-size: 11px;
                font-weight: 700;
                color: ${color};
                text-shadow: 0 1px 2px rgba(0,0,0,0.85);
            `,
        });
        parent.add_child(label);
        const [, natW] = label.get_preferred_width(-1);
        const [, natH] = label.get_preferred_height(-1);
        let px = x;
        let py = y;
        if (align === 'center')
            px = Math.round(x - natW / 2);
        else if (align === 'right')
            px = Math.round(x - natW);
        label.set_position(Math.max(0, px), Math.max(0, py));
        label.set_size(Math.max(1, natW), Math.max(1, natH));
    }

    /** Dim everything except a rectangular hole (active tile) — four cheap panels. */
    _addDimWithHole(parent, width, height, hx, hy, hw, hh) {
        const style = 'background-color: rgba(0, 0, 0, 0.42);';
        const add = (x, y, w, h) => {
            if (w <= 0 || h <= 0)
                return;
            const panel = new St.Widget({ reactive: false, style });
            parent.add_child(panel);
            panel.set_position(x, y);
            panel.set_size(w, h);
        };
        add(0, 0, width, hy);
        add(0, hy + hh, width, height - (hy + hh));
        add(0, hy, hx, hh);
        add(hx + hw, hy, width - (hx + hw), hh);
    }

    _flashImpl(monitor, area, state, gap, hSteps, vSteps) {
        this._fading = false;
        this._lastFlashUs = GLib.get_monotonic_time();

        if (!this._root) {
            this._root = new St.Widget({
                name: 'tile-on-grid-snap-guides',
                reactive: false,
                can_focus: false,
                opacity: 255,
            });
            Main.layoutManager.modalDialogGroup.add_child(this._root);
        } else {
            try {
                this._root.remove_all_transitions?.();
            } catch (e) { /* ignore */ }
            this._root.destroy_all_children();
            this._root.opacity = 255;
            this._root.show();
        }

        const root = this._root;
        root.set_position(Math.round(monitor.x), Math.round(monitor.y));
        root.set_size(
            Math.max(1, Math.round(monitor.width)),
            Math.max(1, Math.round(monitor.height))
        );

        const ax = Math.round(area.x - monitor.x);
        const ay = Math.round(area.y - monitor.y);
        const aw = Math.max(1, Math.round(area.width));
        const ah = Math.max(1, Math.round(area.height));

        const leftGap = state.x > EPS ? gap / 2 : 0;
        const rightGap = state.x + state.w < 1 - EPS ? gap / 2 : 0;
        const topGap = state.y > EPS ? gap / 2 : 0;
        const bottomGap = state.y + state.h < 1 - EPS ? gap / 2 : 0;

        let hx = ax + Math.round(state.x * aw + leftGap);
        let hy = ay + Math.round(state.y * ah + topGap);
        let hw = Math.round(state.w * aw - leftGap - rightGap);
        let hh = Math.round(state.h * ah - topGap - bottomGap);
        if (Math.abs(state.x + state.w - 1) < EPS)
            hw = ax + aw - hx;
        if (Math.abs(state.y + state.h - 1) < EPS)
            hh = ay + ah - hy;
        hw = Math.max(1, hw);
        hh = Math.max(1, hh);

        // Leave the active tile undimmed (same cost as one full dim).
        this._addDimWithHole(root, root.width, root.height, hx, hy, hw, hh);

        const addV = frac => {
            if (frac <= EPS || frac >= 1 - EPS)
                return;
            const px = ax + Math.round(frac * aw);
            const color = this._guideColor(frac);
            this._addDashLine(root, true, px, ay, ah, color);
            this._addFractionLabel(
                root,
                formatFraction(frac),
                px,
                ay + ah - 16,
                color,
                'center'
            );
        };
        const addH = frac => {
            if (frac <= EPS || frac >= 1 - EPS)
                return;
            const py = ay + Math.round(frac * ah);
            const color = this._guideColor(frac);
            this._addDashLine(root, false, ax, py, aw, color);
            this._addFractionLabel(
                root,
                formatFraction(frac),
                ax + 6,
                py - 7,
                color,
                'left'
            );
        };

        for (const f of hSteps || [])
            addV(f);
        for (const f of vSteps || [])
            addH(f);

        const slot = new St.Widget({
            reactive: false,
            style: `
                background-color: rgba(255, 255, 255, 0.08);
                border: 2px solid rgba(160, 220, 255, 0.95);
                border-radius: 10px;
            `,
        });
        root.add_child(slot);
        slot.set_position(hx, hy);
        slot.set_size(hw, hh);

        this._startReleasePoll();
    }
}

class WindowManager {
    constructor(settings, guidePreview = null) {
        this._settings = settings;
        this._guides = guidePreview;
        this._animId = null;
        this._settleId = null;
        this._windowStates = new WeakMap();
        this._lastTarget = new WeakMap();
    }

    destroy() {
        this._cancelMotionTimers();
        this._guides = null;
    }

    _cancelMotionTimers() {
        if (this._animId) {
            GLib.Source.remove(this._animId);
            this._animId = null;
        }
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = null;
        }
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

    _stateEquals(a, b) {
        return Math.abs(a.x - b.x) < EPS &&
            Math.abs(a.y - b.y) < EPS &&
            Math.abs(a.w - b.w) < EPS &&
            Math.abs(a.h - b.h) < EPS;
    }

    _expectedRect(window, state) {
        const area = this._innerArea(this._getWorkArea(window));
        const gap = this._settings.get_int('padding-inner');
        const leftGap = state.x > EPS ? gap / 2 : 0;
        const rightGap = state.x + state.w < 1 - EPS ? gap / 2 : 0;
        const topGap = state.y > EPS ? gap / 2 : 0;
        const bottomGap = state.y + state.h < 1 - EPS ? gap / 2 : 0;

        let x = Math.round(area.x + state.x * area.width + leftGap);
        let y = Math.round(area.y + state.y * area.height + topGap);
        let w = Math.round(state.w * area.width - leftGap - rightGap);
        let h = Math.round(state.h * area.height - topGap - bottomGap);
        if (Math.abs(state.x + state.w - 1) < EPS)
            w = area.x + area.width - x;
        if (Math.abs(state.y + state.h - 1) < EPS)
            h = area.y + area.height - y;
        return { x, y, width: Math.max(1, w), height: Math.max(1, h) };
    }

    _rectDiverged(a, b, px = 24) {
        return Math.abs(a.x - b.x) > px ||
            Math.abs(a.y - b.y) > px ||
            Math.abs(a.width - b.width) > px ||
            Math.abs(a.height - b.height) > px;
    }

    /** Prefer live geometry when cached state no longer matches the real frame. */
    _syncState(window) {
        this._cancelMotionTimers();

        const last = this._lastTarget.get(window);
        if (last && !this._rectDiverged(window.get_frame_rect(), last, 12)) {
            const cached = this._windowStates.get(window);
            if (cached)
                return { ...cached };
        }

        if (this._windowStates.has(window)) {
            const cached = this._windowStates.get(window);
            const expected = this._expectedRect(window, cached);
            if (!this._rectDiverged(window.get_frame_rect(), expected, 24))
                return { ...cached };
        }

        const inferred = this._inferState(window);
        this._windowStates.set(window, inferred);
        return { ...inferred };
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
        // Step relative to the current value, not "nearest index ± 1"
        // (nearest can stick on the same step and look like a missed keypress).
        if (larger) {
            for (const s of steps) {
                if (s > size + EPS)
                    return s;
            }
            return steps[steps.length - 1];
        }
        for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i] < size - EPS)
                return steps[i];
        }
        return steps[0];
    }

    _applyAction(state, action, direction, hSteps, vSteps) {
        const next = { ...state };

        next.w = hSteps[nearestIndex(next.w, hSteps)];
        next.h = vSteps[nearestIndex(next.h, vSteps)];
        next.x = clamp(next.x, 0, 1 - next.w);
        next.y = clamp(next.y, 0, 1 - next.h);

        if (action === 'move') {
            if (direction === 'left')
                next.x = this._nextPosition(next.x, next.w, hSteps, false);
            else if (direction === 'right')
                next.x = this._nextPosition(next.x, next.w, hSteps, true);
            else if (direction === 'up')
                next.y = this._nextPosition(next.y, next.h, vSteps, false);
            else if (direction === 'down')
                next.y = this._nextPosition(next.y, next.h, vSteps, true);
        } else if (action === 'expand') {
            if (direction === 'right') {
                const newW = this._nextSize(next.w, hSteps, true);
                if (next.x + newW <= 1 + EPS)
                    next.w = newW;
                else if (newW <= 1 + EPS) {
                    next.x = Math.max(0, 1 - newW);
                    next.w = newW;
                }
            } else if (direction === 'left') {
                const newW = this._nextSize(next.w, hSteps, true);
                const grow = newW - next.w;
                if (grow > EPS && next.x >= grow - EPS) {
                    next.x -= grow;
                    next.w = newW;
                } else if (newW <= 1 + EPS) {
                    next.x = 0;
                    next.w = Math.min(newW, 1);
                }
            } else if (direction === 'down') {
                const newH = this._nextSize(next.h, vSteps, true);
                if (next.y + newH <= 1 + EPS)
                    next.h = newH;
                else if (newH <= 1 + EPS) {
                    next.y = Math.max(0, 1 - newH);
                    next.h = newH;
                }
            } else if (direction === 'up') {
                const newH = this._nextSize(next.h, vSteps, true);
                const grow = newH - next.h;
                if (grow > EPS && next.y >= grow - EPS) {
                    next.y -= grow;
                    next.h = newH;
                } else if (newH <= 1 + EPS) {
                    next.y = 0;
                    next.h = Math.min(newH, 1);
                }
            }
        } else if (action === 'shrink') {
            if (direction === 'left') {
                next.w = this._nextSize(next.w, hSteps, false);
            } else if (direction === 'right') {
                const newW = this._nextSize(next.w, hSteps, false);
                next.x += next.w - newW;
                next.w = newW;
            } else if (direction === 'up') {
                next.h = this._nextSize(next.h, vSteps, false);
            } else if (direction === 'down') {
                const newH = this._nextSize(next.h, vSteps, false);
                next.y += next.h - newH;
                next.h = newH;
            }
        }

        next.x = clamp(next.x, 0, 1 - next.w);
        next.y = clamp(next.y, 0, 1 - next.h);
        return next;
    }

    transformWindow(window, action, direction) {
        const hSteps = this._hSteps();
        const vSteps = this._vSteps();

        let state = this._syncState(window);
        let next = this._applyAction(state, action, direction, hSteps, vSteps);

        if (this._stateEquals(state, next)) {
            // Genuine edge no-op (already min/max): do not re-infer+apply,
            // which used to nudge x/y by a few pixels from rounding/gaps.
            const last = this._lastTarget.get(window);
            const frame = window.get_frame_rect();
            if (last && !this._rectDiverged(frame, last, 12))
                return;

            const inferred = this._inferState(window);
            const retried = this._applyAction(inferred, action, direction, hSteps, vSteps);
            if (this._stateEquals(inferred, retried))
                return;
            next = retried;
        }

        this.setWindowState(window, next);
        this.applyState(window, next);
    }

    applyState(window, state) {
        if (!window || !window.get_monitor)
            return;

        this.setWindowState(window, state);

        const workArea = this._getWorkArea(window);
        const area = this._innerArea(workArea);
        const gap = this._settings.get_int('padding-inner');
        const targetGeo = this._expectedRect(window, state);

        // Place first — guides must not be able to block tiling.
        this._placeWindow(window, targetGeo);

        try {
            const monitorIndex = window.get_monitor();
            const monitor = Main.layoutManager.monitors[monitorIndex]
                || Main.layoutManager.primaryMonitor;
            this._guides?.flash(
                monitor,
                area,
                state,
                gap,
                this._hSteps(),
                this._vSteps()
            );
        } catch (e) {
            console.warn(`[TileOnGrid] snap guide failed: ${e}`);
        }
    }

    _scheduleResizeSettle(window, targetGeo) {
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = null;
        }
        const { x, y, width: w, height: h } = targetGeo;
        // Idle settle catches GTK clients that reject the first resize.
        this._settleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._settleId = null;
            try {
                if (window && window.get_frame_rect) {
                    const cur = window.get_frame_rect();
                    if (this._rectDiverged(cur, targetGeo, 2))
                        window.move_resize_frame(true, x, y, w, h);
                }
            } catch (e) {
                /* window gone */
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _placeWindow(window, targetGeo) {
        this._cancelMotionTimers();

        if (window.maximized_horizontally || window.maximized_vertically)
            window.unmaximize(Meta.MaximizeFlags.BOTH);

        this._lastTarget.set(window, { ...targetGeo });

        // Immediate place — timed interpolation previously raced the next keypress.
        window.move_resize_frame(
            true,
            targetGeo.x,
            targetGeo.y,
            targetGeo.width,
            targetGeo.height
        );
        this._scheduleResizeSettle(window, targetGeo);
    }
}

const HelpOverlay = GObject.registerClass(
class HelpOverlay extends St.Widget {
    _init(monitor, settings, { onClose, onOpenPrefs } = {}) {
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
        this._onOpenPrefs = onOpenPrefs;
        this._settings = settings;
        this._settingIds = [];
        this.set_layout_manager(new Clutter.BinLayout());

        const maxH = Math.max(360, monitor.height - 80);
        const shell = new St.BoxLayout({
            vertical: true,
            style: `
                background-color: rgba(28, 28, 30, 0.96);
                border-radius: 20px;
                padding: 20px 24px;
                spacing: 10px;
                border: 1px solid rgba(255,255,255,0.12);
                width: 480px;
                max-height: ${maxH}px;
            `,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        this.add_child(shell);

        const titleRow = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 10px;',
            x_expand: true,
        });
        titleRow.add_child(new St.Label({
            text: 'Tile on Grid',
            style: 'font-size: 20px; font-weight: 800; color: #ffffff;',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        if (this._onOpenPrefs) {
            const prefsBtn = new St.Button({
                label: 'Prefs',
                style: this._chipStyle(false) + ' min-width: 56px;',
                reactive: true,
                can_focus: true,
            });
            prefsBtn.connect('clicked', () => {
                const open = this._onOpenPrefs;
                this._onClose?.();
                open?.();
            });
            titleRow.add_child(prefsBtn);
        }

        const closeBtn = new St.Button({
            label: '✕',
            style: 'color: #cccccc; font-size: 15px; padding: 4px 8px;',
            reactive: true,
            can_focus: true,
        });
        closeBtn.connect('clicked', () => this._onClose?.());
        titleRow.add_child(closeBtn);
        shell.add_child(titleRow);

        const scroll = new St.ScrollView({
            style_class: 'vfade',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });
        const card = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 12px; padding-right: 4px;',
            x_expand: true,
        });
        if (scroll.set_child)
            scroll.set_child(card);
        else
            scroll.add_child(card);
        shell.add_child(scroll);

        card.add_child(this._sectionLabel('Size steps'));
        card.add_child(this._buildFractionRow('H', 'horizontal-steps'));
        card.add_child(this._buildFractionRow('V', 'vertical-steps'));

        card.add_child(this._sectionLabel('Shortcuts'));
        for (const actionGroup of ACTION_GROUPS)
            card.add_child(this._buildShortcutBlock(actionGroup));

        card.add_child(new St.Label({
            text: 'Esc / Super+G · click outside to close',
            style: 'font-size: 12px; color: #777777; margin-top: 2px;',
        }));

        this.connect('button-press-event', () => {
            this._onClose?.();
            return Clutter.EVENT_STOP;
        });
        shell.connect('button-press-event', () => Clutter.EVENT_STOP);

        this.connect('key-press-event', this._onKeyPress.bind(this));
        this.connect('destroy', () => this._disconnectSettings());
    }

    _sectionLabel(text) {
        return new St.Label({
            text,
            style: 'font-size: 11px; font-weight: 700; color: #bbbbbb; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px;',
        });
    }

    _chipStyle(active) {
        return active
            ? 'padding: 6px 10px; border-radius: 8px; background-color: rgba(80,160,255,0.35); color: #ffffff; font-size: 13px; font-weight: 600;'
            : 'padding: 6px 10px; border-radius: 8px; background-color: rgba(255,255,255,0.08); color: #cccccc; font-size: 13px;';
    }

    _buildFractionRow(title, key) {
        const row = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 6px;',
            x_expand: true,
        });
        row.add_child(new St.Label({
            text: title,
            style: 'font-size: 13px; color: #dddddd; font-weight: 600; min-width: 18px;',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const buttons = new Map();
        let syncing = false;

        const sync = () => {
            syncing = true;
            const selected = selectedFromSteps(this._settings.get_strv(key));
            for (const frac of FRACTION_OPTIONS) {
                const btn = buttons.get(frac);
                const on = selected.includes(frac);
                btn.checked = on;
                btn.set_style(this._chipStyle(on));
            }
            syncing = false;
        };

        for (const frac of FRACTION_OPTIONS) {
            const btn = new St.Button({
                label: frac,
                toggle_mode: true,
                reactive: true,
                can_focus: true,
                style: this._chipStyle(false),
            });
            btn.connect('clicked', () => {
                if (syncing)
                    return;
                let selected = selectedFromSteps(this._settings.get_strv(key));
                if (btn.checked)
                    selected = selectFraction(selected, frac);
                else
                    selected = deselectFraction(selected, frac);
                this._settings.set_strv(key, stepsFromSelected(selected));
                sync();
            });
            buttons.set(frac, btn);
            row.add_child(btn);
        }

        sync();
        this._settingIds.push(this._settings.connect(`changed::${key}`, sync));
        return row;
    }

    _makeActionIcon(actionId) {
        return new St.Label({
            text: ACTION_GLYPHS[actionId] || '•',
            style: `
                font-size: 28px;
                color: #b8c8dc;
                min-width: 40px;
                text-align: center;
            `,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
    }

    _buildShortcutBlock(actionGroup) {
        const { id, title, keys, defaultMods } = actionGroup;
        const box = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 12px; padding: 10px 12px; border-radius: 12px; background-color: rgba(255,255,255,0.04);',
            x_expand: true,
        });

        const iconSlot = new St.Bin({
            child: this._makeActionIcon(id),
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 40px;',
        });
        box.add_child(iconSlot);

        const body = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 6px;',
            x_expand: true,
        });
        box.add_child(body);

        body.add_child(new St.Label({
            text: title,
            style: 'font-size: 14px; color: #ffffff; font-weight: 700;',
        }));

        let mods = parseModifiers(this._settings.get_strv(keys[0])[0] || '');
        if (!mods.length)
            mods = defaultMods.slice();
        let scheme = detectKeyScheme(this._settings, keys);

        const modRow = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 4px;',
            x_expand: true,
        });
        const keyRow = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 4px;',
            x_expand: true,
        });
        const manualList = new St.Label({
            text: '',
            style: 'font-size: 12px; color: #88ccff;',
            x_expand: true,
        });

        const modButtons = new Map();
        const schemeButtons = new Map();
        let syncingMods = false;
        let syncingScheme = false;

        const refreshManualList = () => {
            const accels = keys.map(k => formatAccel(this._settings.get_strv(k)[0] || ''));
            const dirs = ['←', '→', '↑', '↓'];
            manualList.text = dirs.map((d, i) => `${d} ${accels[i]}`).join('   ');
        };

        const syncSchemeUi = () => {
            const isManual = scheme === 'manual';
            // Preset: show action glyph. Manual: drop the glyph and list bindings.
            iconSlot.visible = !isManual;
            manualList.visible = isManual;

            syncingScheme = true;
            for (const s of KEY_SCHEMES) {
                const b = schemeButtons.get(s);
                if (!b)
                    continue;
                const on = scheme === s;
                b.checked = on;
                b.set_style(this._chipStyle(on));
            }
            syncingScheme = false;

            if (isManual)
                refreshManualList();
        };

        const apply = () => {
            if (scheme !== 'manual')
                applyDirectionalScheme(this._settings, keys, mods, scheme);
            syncSchemeUi();
        };

        for (const name of MODIFIER_OPTIONS) {
            const label = name === 'Control' ? 'Ctrl' : name;
            const btn = new St.Button({
                label,
                toggle_mode: true,
                checked: mods.includes(name),
                reactive: true,
                can_focus: true,
                style: this._chipStyle(mods.includes(name)),
            });
            btn.connect('clicked', () => {
                if (syncingMods)
                    return;
                const next = toggleModifier(mods, name, 3);
                if (btn.checked && !next.includes(name)) {
                    syncingMods = true;
                    btn.checked = false;
                    syncingMods = false;
                    return;
                }
                mods = next;
                syncingMods = true;
                for (const m of MODIFIER_OPTIONS) {
                    const b = modButtons.get(m);
                    const on = mods.includes(m);
                    b.checked = on;
                    b.set_style(this._chipStyle(on));
                }
                syncingMods = false;
                apply();
            });
            modButtons.set(name, btn);
            modRow.add_child(btn);
        }
        body.add_child(modRow);

        for (const s of KEY_SCHEMES) {
            const btn = new St.Button({
                label: schemeLabel(s),
                toggle_mode: true,
                checked: scheme === s,
                reactive: true,
                can_focus: true,
                style: this._chipStyle(scheme === s),
            });
            btn.connect('clicked', () => {
                if (syncingScheme)
                    return;
                scheme = s;
                apply();
            });
            schemeButtons.set(s, btn);
            keyRow.add_child(btn);
        }
        body.add_child(keyRow);
        body.add_child(manualList);

        syncSchemeUi();
        return box;
    }

    _disconnectSettings() {
        if (!this._settings)
            return;
        for (const id of this._settingIds)
            this._settings.disconnect(id);
        this._settingIds = [];
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
        if (this._guidePreview) {
            this._guidePreview.destroy();
            this._guidePreview = null;
        }
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

        this._overlay = new HelpOverlay(monitor, this._settings, {
            onClose: () => this._closeOverlay(),
            onOpenPrefs: () => {
                try {
                    this.openPreferences();
                } catch (e) {
                    console.warn(`[TileOnGrid] openPreferences failed: ${e}`);
                }
            },
        });
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
