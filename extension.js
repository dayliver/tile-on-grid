import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const HW_MAP = {
    24: 0, 25: 1, 26: 2, 27: 3, 28: 4, 29: 5, 30: 6, 31: 7, 32: 8, 33: 9, // q w e r t y u i o p
    38: 10, 39: 11, 40: 12, 41: 13, 42: 14, 43: 15, 44: 16, 45: 17, 46: 18, 47: 19, // a s d f g h j k l ;
    52: 20, 53: 21, 54: 22, 55: 23, 56: 24, 57: 25, 58: 26, 59: 27, 60: 28, 61: 29  // z x c v b n m , . /
};

const DISPLAY_CHARS = [
    'Q','W','E','R','T','Y','U','I','O','P',
    'A','S','D','F','G','H','J','K','L',';',
    'Z','X','C','V','B','N','M',',','.','/'
];

/** DISPLAY_CHARS / HW_MAP index for grid row r, column c: row0=QWER…, row1=ASDF…, row2+=ZXCV… */
function keyboardSlotForGridCell(gridRow, colInRow) {
    const rowBase = gridRow < 2 ? gridRow * 10 : 20;
    return rowBase + colInRow;
}

const GRID_PRESETS = {
    '1': { rows: [1], name: "Full" },
    '2': { rows: [2], name: "1x2 Split" },
    '3': { rows: [3], name: "1x3 Columns" },
    '4': { rows: [4], name: "1x4 Columns" },
    '5': { rows: [2, 2], name: "2x2 Quarter" },
    '6': { rows: [3, 3], name: "2x3 Grid" },
    '7': { rows: [3, 4], name: "Complex 3/4" },
    '8': { rows: [4, 4], name: "2x4 Grid" },
    '9': { rows: [3, 3, 3], name: "3x3 Grid" }
};
const DEFAULT_PRESET_KEY = '9';

/** Integer segment sizes so gaps + cells exactly fill totalPixels (no float drift on right/bottom edges). */
function distributeSegmentSizes(totalPixels, segmentCount, gapPx) {
    if (segmentCount <= 0)
        return [];
    const gapTotal = Math.max(0, segmentCount - 1) * gapPx;
    const forSeg = Math.max(0, totalPixels - gapTotal);
    const base = Math.floor(forSeg / segmentCount);
    const rem = forSeg - base * segmentCount;
    const sizes = [];
    for (let i = 0; i < segmentCount; i++)
        sizes.push(base + (i < rem ? 1 : 0));
    return sizes;
}

function cumulativeSegmentOffset(sizes, gapPx, beforeIndex) {
    let pos = 0;
    for (let i = 0; i < beforeIndex; i++)
        pos += sizes[i] + gapPx;
    return pos;
}

function spanSegmentsWithGaps(sizes, gapPx, startIdx, spanCount) {
    let n = 0;
    for (let i = 0; i < spanCount; i++) {
        n += sizes[startIdx + i];
        if (i < spanCount - 1)
            n += gapPx;
    }
    return n;
}

class WindowManager {
    constructor(settings) {
        this._settings = settings;
        this._animId = null;
        this._settleId = null;
        this._windowStates = new WeakMap();
    }

    destroy() {
        if (this._animId) { GLib.Source.remove(this._animId); this._animId = null; }
        if (this._settleId) { GLib.Source.remove(this._settleId); this._settleId = null; }
    }

    getLastPreset() {
        const val = this._settings.get_string('last-active-preset');
        return GRID_PRESETS[val] ? val : DEFAULT_PRESET_KEY;
    }

    setLastPreset(key) {
        if (GRID_PRESETS[key]) {
            this._settings.set_string('last-active-preset', key);
        }
    }

    getWindowState(window) {
        if (!this._windowStates.has(window)) {
            this._windowStates.set(window, {
                presetKey: this.getLastPreset(),
                index: 4, rs: 1, cs: 1
            });
        }
        return this._windowStates.get(window);
    }
    setWindowState(window, state) { this._windowStates.set(window, state); }

    focusNeighbor(direction) {
        const display = global.display;
        const currentWin = display.focus_window;
        if (!currentWin) return;

        const windows = display.get_tab_list(Meta.TabList.NORMAL, display.get_workspace_manager().get_active_workspace());
        let bestWin = null;
        let minDistance = Infinity;
        const currentRect = currentWin.get_frame_rect();
        const currentCenter = { x: currentRect.x + currentRect.width / 2, y: currentRect.y + currentRect.height / 2 };

        windows.forEach(win => {
            if (win === currentWin) return;
            const rect = win.get_frame_rect();
            const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            let valid = false;
            const deltaX = center.x - currentCenter.x;
            const deltaY = center.y - currentCenter.y;
            const THRESHOLD = 10; 

            if (direction === 'left') valid = (deltaX < -THRESHOLD);
            else if (direction === 'right') valid = (deltaX > THRESHOLD);
            else if (direction === 'up') valid = (deltaY < -THRESHOLD);
            else if (direction === 'down') valid = (deltaY > THRESHOLD);

            if (valid) {
                const distance = Math.sqrt(Math.pow(deltaX, 2) + Math.pow(deltaY, 2));
                if (distance < minDistance) {
                    minDistance = distance;
                    bestWin = win;
                }
            }
        });

        if (bestWin) bestWin.activate(global.get_current_time());
    }

    transformWindow(window, action, direction) {
        let state = this.getWindowState(window);
        const preset = GRID_PRESETS[state.presetKey];
        const rowsCount = preset.rows.length;
        
        let currentRow = 0, currentCol = 0, acc = 0;
        for (let r = 0; r < rowsCount; r++) {
            let colsInRow = preset.rows[r];
            if (state.index >= acc && state.index < acc + colsInRow) {
                currentRow = r;
                currentCol = state.index - acc;
                break;
            }
            acc += colsInRow;
        }
        
        const colsCount = preset.rows[currentRow];

        if (action === 'move') {
            if (direction === 'left' && currentCol > 0) currentCol--;
            else if (direction === 'right' && (currentCol + state.cs) < colsCount) currentCol++;
            else if (direction === 'up' && currentRow > 0) currentRow--;
            else if (direction === 'down' && (currentRow + state.rs) < rowsCount) currentRow++;
        } 
        else if (action === 'expand') {
            if (direction === 'right' && (currentCol + state.cs) < colsCount) state.cs++;
            if (direction === 'left' && currentCol > 0) { currentCol--; state.cs++; }
            if (direction === 'down' && (currentRow + state.rs) < rowsCount) state.rs++;
            if (direction === 'up' && currentRow > 0) { currentRow--; state.rs++; }
        } 
        else if (action === 'shrink') {
            if (direction === 'left' && state.cs > 1) state.cs--;
            if (direction === 'right' && state.cs > 1) { currentCol++; state.cs--; }
            if (direction === 'up' && state.rs > 1) state.rs--;
            if (direction === 'down' && state.rs > 1) { currentRow++; state.rs--; }
        }

        let newAcc = 0;
        for (let r = 0; r < currentRow; r++) newAcc += preset.rows[r];
        state.index = newAcc + currentCol;

        this.setWindowState(window, state);
        this.applyTile(window, state.presetKey, state.index, state.rs, state.cs);
    }

    applyTile(window, presetKey, index, rs, cs) {
        if (!window || !window.get_monitor) return;
        
        this.setLastPreset(presetKey);
        this.setWindowState(window, { presetKey, index, rs, cs });

        const preset = GRID_PRESETS[presetKey];
        const workArea = this._getWorkArea(window);
        const pads = {
            inner: this._settings.get_int('padding-inner'),
            outer: this._settings.get_int('padding-outer')
        };

        const rowsCount = preset.rows.length;
        let rIndex = 0, cIndex = 0, acc = 0;
        for (let r = 0; r < rowsCount; r++) {
            let colsInRow = preset.rows[r];
            if (index >= acc && index < acc + colsInRow) {
                rIndex = r;
                cIndex = index - acc;
                break;
            }
            acc += colsInRow;
        }

        const colsCount = preset.rows[rIndex];
        const availableW = workArea.width - (2 * pads.outer);
        const availableH = workArea.height - (2 * pads.outer);

        const rowHeights = distributeSegmentSizes(availableH, rowsCount, pads.inner);
        const colWidths = distributeSegmentSizes(availableW, colsCount, pads.inner);

        const innerLeft = workArea.x + pads.outer;
        const innerTop = workArea.y + pads.outer;

        const targetY = innerTop + cumulativeSegmentOffset(rowHeights, pads.inner, rIndex);
        const targetH = spanSegmentsWithGaps(rowHeights, pads.inner, rIndex, rs);

        const targetX = innerLeft + cumulativeSegmentOffset(colWidths, pads.inner, cIndex);
        const targetW = spanSegmentsWithGaps(colWidths, pads.inner, cIndex, cs);

        this._animateWindow(window, {
            x: targetX,
            y: targetY,
            width: targetW,
            height: targetH
        });
    }

    _getWorkArea(window) {
        const workArea = window.get_work_area_current_monitor();
        return {
            x: workArea.x,
            y: workArea.y,
            width: workArea.width,
            height: workArea.height
        };
    }

    _scheduleResizeSettle(window, targetGeo) {
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = null;
        }
        const x = targetGeo.x;
        const y = targetGeo.y;
        const w = targetGeo.width;
        const h = targetGeo.height;
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 75, () => {
            this._settleId = null;
            try {
                window.move_resize_frame(true, x, y, w, h);
            } catch (e) {
                /* window gone */
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _animateWindow(window, targetGeo) {
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = null;
        }

        if (window.maximized_horizontally || window.maximized_vertically) {
            window.unmaximize(Meta.MaximizeFlags.BOTH);
        }

        const animate = this._settings.get_boolean('animate-movement');
        const duration = this._settings.get_int('animation-duration');
        const startGeo = window.get_frame_rect();

        if (!animate) {
            window.move_resize_frame(true, targetGeo.x, targetGeo.y, targetGeo.width, targetGeo.height);
            this._scheduleResizeSettle(window, targetGeo);
            return;
        }

        if (this._animId) GLib.Source.remove(this._animId);

        let time = 0;
        this._animId = GLib.timeout_add(GLib.PRIORITY_HIGH, 10, () => {
            time += 10;
            let t = time / duration;
            if (t > 1) t = 1;
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

const GridOverlay = GObject.registerClass(
class GridOverlay extends St.Widget {
    _init(monitor, currentPresetKey, callbacks) {
        super._init({
            style_class: 'grid-overlay',
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });
        
        this.connect('button-press-event', (actor, event) => {
            const [x, y] = event.get_coords();
            let picked = null;
            try {
                picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
            } catch (e) {
                picked = null;
            }

            let a = picked;
            while (a && a !== this) {
                if (a._gridIndex !== undefined)
                    return Clutter.EVENT_PROPAGATE;
                a = a.get_parent ? a.get_parent() : null;
            }

            if (this._onCancel) this._onCancel();
            return Clutter.EVENT_STOP;
        });

        this.set_layout_manager(new Clutter.BinLayout());

        this._monitor = monitor;
        this._onSelect = callbacks.onSelect;
        this._onCancel = callbacks.onCancel;
        this._currentPresetKey = currentPresetKey;
        this._indexMap = new Map();
        this._linearToGlobal = new Map();

        this._contentBox = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 20px;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true
        });
        this.add_child(this._contentBox);

        this._createHud();

        this._gridBox = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 12px;',
            x_align: Clutter.ActorAlign.CENTER
        });
        this._contentBox.add_child(this._gridBox);

        this._rebuildGrid();
        
        this.connect('key-press-event', this._onKeyPress.bind(this));
    }

    _createHud() {
        this._hudBox = new St.BoxLayout({
            vertical: false,
            style: `background-color: rgba(30, 30, 30, 0.9); border-radius: 50px; padding: 10px 24px; spacing: 16px; border: 1px solid rgba(255,255,255,0.2);`,
            x_align: Clutter.ActorAlign.CENTER
        });

        const closeBtn = new St.Button({
            label: "✖",
            style: "color: #ff6666; font-weight: bold; font-size: 16px; padding: 0 8px;",
            reactive: true, can_focus: true
        });
        closeBtn.connect('clicked', () => { if (this._onCancel) this._onCancel(); });
        this._hudBox.add_child(closeBtn);

        this._layoutLabel = new St.Label({ text: "...", style: "font-weight: 800; font-size: 16px; color: #ffffff;" });
        const helpStyle = "font-size: 14px; color: #cccccc; background-color: rgba(255,255,255,0.1); border-radius: 8px; padding: 4px 10px;";
        
        this._hudBox.add_child(this._layoutLabel);
        this._hudBox.add_child(new St.Label({ text: "|", style: "color: #666;" }));
        this._hudBox.add_child(new St.Label({ text: "Tab: Cycle", style: helpStyle }));
        this._hudBox.add_child(new St.Label({ text: "1-9: Layout", style: helpStyle }));
        this._hudBox.add_child(new St.Label({ text: "QWE / ASD / ZX rows", style: helpStyle }));

        this._contentBox.add_child(this._hudBox);
    }

    _updateHud() {
        const preset = GRID_PRESETS[this._currentPresetKey];
        this._layoutLabel.set_text(`Grid: ${preset.name}`);
    }

    _rebuildGrid() {
        this._gridBox.destroy_all_children();
        this._indexMap.clear();
        this._linearToGlobal.clear();

        const preset = GRID_PRESETS[this._currentPresetKey];
        const rows = preset.rows;
        this._updateHud();

        const totalW = this._monitor.width * 0.6;
        const totalH = this._monitor.height * 0.6;
        let globalIndex = 0;
        
        for (let r = 0; r < rows.length; r++) {
            let rowBox = new St.BoxLayout({ vertical: false, style: 'spacing: 12px;' });
            let colsInRow = rows[r];
            let cellH = totalH / rows.length;
            let cellW = totalW / colsInRow;

            for (let c = 0; c < colsInRow; c++) {
                const index = globalIndex++;
                const keyboardSlot = keyboardSlotForGridCell(r, c);
                let displayChar = '';
                if (keyboardSlot < DISPLAY_CHARS.length)
                    displayChar = DISPLAY_CHARS[keyboardSlot];

                this._linearToGlobal.set(keyboardSlot, index);

                for (const [code, mappedIdx] of Object.entries(HW_MAP)) {
                    if (mappedIdx === keyboardSlot)
                        this._indexMap.set(parseInt(code, 10), index);
                }

                let btn = new St.Button({
                    label: displayChar,
                    width: cellW, height: cellH,
                    style_class: 'grid-cell',
                    style: `border-radius: 16px; border: 2px solid rgba(255,255,255,0.2); background-color: rgba(50,50,50,0.5); color: white; font-size: 32px; font-weight: 900; text-shadow: 0 2px 5px rgba(0,0,0,0.7);`,
                    reactive: true, can_focus: true
                });
                btn._gridIndex = index;

                ((idx) => btn.connect('clicked', () => {
                    if (this._onSelect) this._onSelect(this._currentPresetKey, idx, 1, 1);
                    return Clutter.EVENT_STOP; 
                }))(index);

                rowBox.add_child(btn);
            }
            this._gridBox.add_child(rowBox);
        }
    }

    _onKeyPress(actor, event) {
        const rawSymbol = event.get_key_symbol();
        const hwCode = event.get_key_code();

        if (rawSymbol === Clutter.KEY_Escape) { 
            if (this._onCancel) this._onCancel(); 
            return Clutter.EVENT_STOP; 
        }
        if (rawSymbol === Clutter.KEY_g && (event.get_state() & Clutter.ModifierType.SUPER_MASK)) {
             if (this._onCancel) this._onCancel();
             return Clutter.EVENT_STOP;
        }

        if (rawSymbol === Clutter.KEY_Tab || rawSymbol === Clutter.KEY_ISO_Left_Tab) {
            const isShift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK);
            let current = parseInt(this._currentPresetKey);
            if (isShift) {
                current--;
                if (current < 1) current = 9;
            } else {
                current++;
                if (current > 9) current = 1;
            }
            this._currentPresetKey = current.toString();
            this._rebuildGrid();
            return Clutter.EVENT_STOP;
        }

        let num = -1;
        if (rawSymbol >= Clutter.KEY_1 && rawSymbol <= Clutter.KEY_9) num = rawSymbol - Clutter.KEY_1 + 1;
        else if (rawSymbol >= Clutter.KEY_KP_1 && rawSymbol <= Clutter.KEY_KP_9) num = rawSymbol - Clutter.KEY_KP_1 + 1;

        if (num !== -1) {
            const key = num.toString();
            const preset = GRID_PRESETS[key];
            if (preset) {
                const totalCells = preset.rows.reduce((sum, cols) => sum + cols, 0);
                if (totalCells === 1) {
                    if (this._onSelect) this._onSelect(key, 0, 1, 1);
                    return Clutter.EVENT_STOP;
                }
                this._currentPresetKey = key;
                this._rebuildGrid();
            }
            return Clutter.EVENT_STOP;
        }

        if (rawSymbol === Clutter.KEY_space || rawSymbol === Clutter.KEY_Return || rawSymbol === Clutter.KEY_KP_Enter) {
            if (this._onSelect) this._onSelect(this._currentPresetKey, 0, 1, 1);
            return Clutter.EVENT_STOP;
        }

        let targetIndex = null;

        if (this._indexMap.has(hwCode))
            targetIndex = this._indexMap.get(hwCode);
        else {
            const linear = HW_MAP[hwCode];
            if (linear !== undefined && this._linearToGlobal.has(linear))
                targetIndex = this._linearToGlobal.get(linear);
        }

        if (targetIndex === null) {
            const uni = Clutter.keysym_to_unicode(rawSymbol);
            if (uni) {
                const ch = String.fromCharCode(uni).toUpperCase();
                const slot = DISPLAY_CHARS.indexOf(ch);
                if (slot !== -1 && this._linearToGlobal.has(slot))
                    targetIndex = this._linearToGlobal.get(slot);
            }
        }

        if (targetIndex !== null) {
            if (this._onSelect) this._onSelect(this._currentPresetKey, targetIndex, 1, 1);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_STOP;
    }
});

export default class TileOnGrid extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._manager = new WindowManager(this._settings);
        this._overlay = null;
        this._grab = null;
        this._capturedEventId = 0;
        this._applyTimeoutId = null;
        this._focusIdleId = null;

        this._addKey('toggle-grid-shortcut', () => this._toggleOverlay());

        ['left', 'right', 'up', 'down'].forEach(dir => {
            this._addKey(`move-${dir}`, () => this._handleDirectAction('move', dir));
            this._addKey(`expand-${dir}`, () => this._handleDirectAction('expand', dir));
            this._addKey(`shrink-${dir}`, () => this._handleDirectAction('shrink', dir));
            this._addKey(`focus-${dir}`, () => this._manager.focusNeighbor(dir));
        });

        console.log('[TileOnGrid] Enabled');
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
        
        if (this._applyTimeoutId) {
            GLib.Source.remove(this._applyTimeoutId);
            this._applyTimeoutId = null;
        }
        if (this._focusIdleId) {
            GLib.Source.remove(this._focusIdleId);
            this._focusIdleId = null;
        }

        if (this._manager) { this._manager.destroy(); this._manager = null; }
        this._settings = null;
    }

    _addKey(name, callback) {
        Main.wm.addKeybinding(name, this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, callback);
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

    _toggleOverlay() {
        if (this._overlay) {
            this._closeOverlay();
            return;
        }
        
        const win = global.display.focus_window;
        if (!win) return; 

        const monitorIndex = win.get_monitor();
        const monitor = win.get_display().get_monitor_geometry(monitorIndex);
        const lastPreset = this._manager.getLastPreset(); 

        this._overlay = new GridOverlay(monitor, lastPreset, {
            onSelect: (presetKey, index, rs, cs) => {
                this._closeOverlay(); 
                
                if (this._applyTimeoutId) {
                    GLib.Source.remove(this._applyTimeoutId);
                    this._applyTimeoutId = null;
                }

                this._applyTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
                     this._manager.applyTile(win, presetKey, index, rs, cs);
                     this._applyTimeoutId = null;
                     return GLib.SOURCE_REMOVE;
                });
            },
            onCancel: () => {
                this._closeOverlay();
            }
        });

        /* Above real windows (see LayoutManager.addChrome vs modalDialogGroup); otherwise in GNOME 50+
           keyboard focus stays with clients and keys leak into the focused app. */
        Main.layoutManager.modalDialogGroup.add_child(this._overlay);

        this._grab = Main.pushModal(this._overlay, {
            actionMode: Shell.ActionMode.SYSTEM_MODAL,
        });
        if (this._grab) {
            this._capturedEventId = this._overlay.connect('captured-event', (_stage, event) => {
                if (!this._overlay)
                    return Clutter.EVENT_PROPAGATE;

                const type = event.type();

                if (type === Clutter.EventType.KEY_PRESS) {
                    if (Main.keyboard.maybeHandleEvent(event))
                        return Clutter.EVENT_STOP;
                    if (this._overlay._onKeyPress)
                        return this._overlay._onKeyPress(this._overlay, event);
                    return Clutter.EVENT_STOP;
                }

                if (type === Clutter.EventType.BUTTON_PRESS) {
                    const [x, y] = event.get_coords();
                    let picked = null;
                    try {
                        picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
                    } catch (e) {
                        picked = null;
                    }

                    let a = picked;
                    while (a && a !== this._overlay) {
                        if (a._gridIndex !== undefined) {
                            if (this._overlay._onSelect)
                                this._overlay._onSelect(this._overlay._currentPresetKey, a._gridIndex, 1, 1);
                            return Clutter.EVENT_STOP;
                        }
                        a = a.get_parent ? a.get_parent() : null;
                    }

                    if (this._overlay._onCancel)
                        this._overlay._onCancel();
                    return Clutter.EVENT_STOP;
                }

                return Clutter.EVENT_STOP;
            });

            if (this._focusIdleId)
                GLib.Source.remove(this._focusIdleId);
            this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._focusIdleId = null;
                if (this._overlay) {
                    global.stage.set_key_focus(this._overlay);
                    this._overlay.grab_key_focus();
                }
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._closeOverlay();
        }
    }

    _handleDirectAction(action, direction) {
        const win = global.display.focus_window;
        if (!win) return;
        this._manager.transformWindow(win, action, direction);
    }
}