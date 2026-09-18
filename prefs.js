import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    ACTION_GROUPS,
    FRACTION_OPTIONS,
    KEY_SCHEMES,
    MODIFIER_OPTIONS,
    applyDirectionalScheme,
    deselectFraction,
    detectKeyScheme,
    parseModifiers,
    schemeLabel,
    selectFraction,
    selectedFromSteps,
    stepsFromSelected,
    toggleModifier,
} from './settings-util.js';

function acceleratorLabel(accel) {
    return accel || 'Disabled';
}

export default class TileOnGridPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.tile-on-grid');
        window.set_default_size(560, 720);

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const groupGeneral = new Adw.PreferencesGroup({ title: 'Appearance & Behavior' });
        page.add(groupGeneral);

        const rowAnim = new Adw.SwitchRow({
            title: 'Enable Animation',
            subtitle: 'Smooth movement effects',
            active: settings.get_boolean('animate-movement'),
        });
        rowAnim.connect('notify::active', () =>
            settings.set_boolean('animate-movement', rowAnim.active));
        groupGeneral.add(rowAnim);

        const rowInner = new Adw.SpinRow({
            title: 'Inner Padding',
            subtitle: 'Gap between adjacent tiled windows',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 1 }),
            value: settings.get_int('padding-inner'),
        });
        rowInner.connect('notify::value', () =>
            settings.set_int('padding-inner', rowInner.value));
        groupGeneral.add(rowInner);

        const rowOuter = new Adw.SpinRow({
            title: 'Outer Padding',
            subtitle: 'Gap between windows and screen edges',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 1 }),
            value: settings.get_int('padding-outer'),
        });
        rowOuter.connect('notify::value', () =>
            settings.set_int('padding-outer', rowOuter.value));
        groupGeneral.add(rowOuter);

        const groupSteps = new Adw.PreferencesGroup({
            title: 'Size Steps',
            description: 'Pick denominators to include. Finer steps also enable coarser ones (e.g. 1/8 → 1/4 & 1/2). Full size is always available.',
        });
        page.add(groupSteps);

        this._addFractionToggles(groupSteps, settings, 'horizontal-steps', 'Horizontal');
        this._addFractionToggles(groupSteps, settings, 'vertical-steps', 'Vertical');

        const pageKeys = new Adw.PreferencesPage({
            title: 'Shortcuts',
            icon_name: 'input-keyboard-symbolic',
        });
        window.add(pageKeys);

        const helpGroup = new Adw.PreferencesGroup({ title: 'Help' });
        pageKeys.add(helpGroup);
        this._addShortcutRow(helpGroup, settings, 'toggle-grid-shortcut', 'Show shortcuts / settings overlay');

        for (const group of ACTION_GROUPS)
            this._addCompactShortcutGroup(pageKeys, settings, group);
    }

    _addFractionToggles(group, settings, key, title) {
        const row = new Adw.ActionRow({
            title,
            subtitle: settings.get_strv(key).join(', ') || '1',
        });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
            css_classes: ['linked'],
        });

        const buttons = new Map();
        let syncing = false;

        const readSelected = () => selectedFromSteps(settings.get_strv(key));

        const syncButtons = selected => {
            syncing = true;
            for (const frac of FRACTION_OPTIONS)
                buttons.get(frac).active = selected.includes(frac);
            syncing = false;
        };

        const writeSelected = selected => {
            settings.set_strv(key, stepsFromSelected(selected));
            syncButtons(selected);
            row.subtitle = settings.get_strv(key).join(', ') || '1';
        };

        for (const frac of FRACTION_OPTIONS) {
            const btn = new Gtk.ToggleButton({
                label: frac,
                valign: Gtk.Align.CENTER,
            });
            btn.connect('toggled', () => {
                if (syncing)
                    return;
                let selected = readSelected();
                if (btn.active)
                    selected = selectFraction(selected, frac);
                else
                    selected = deselectFraction(selected, frac);
                writeSelected(selected);
            });
            buttons.set(frac, btn);
            box.append(btn);
        }

        syncButtons(readSelected());

        settings.connect(`changed::${key}`, () => {
            if (syncing)
                return;
            syncButtons(readSelected());
            row.subtitle = settings.get_strv(key).join(', ') || '1';
        });

        row.add_suffix(box);
        group.add(row);
    }

    _addCompactShortcutGroup(page, settings, actionGroup) {
        const { title, keys, defaultMods } = actionGroup;
        const group = new Adw.PreferencesGroup({
            title,
            description: 'Choose up to 3 modifiers, then Arrow keys or Numpad. Manual expands per-direction bindings.',
        });
        page.add(group);

        let mods = parseModifiers(settings.get_strv(keys[0])[0] || '') ;
        if (!mods.length)
            mods = defaultMods.slice();
        let scheme = detectKeyScheme(settings, keys);

        const modBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
            css_classes: ['linked'],
        });
        const modButtons = new Map();
        let syncingMods = false;

        const applyScheme = () => {
            if (scheme === 'manual')
                return;
            applyDirectionalScheme(settings, keys, mods, scheme);
        };

        for (const name of MODIFIER_OPTIONS) {
            const btn = new Gtk.ToggleButton({
                label: name === 'Control' ? 'Ctrl' : name,
                valign: Gtk.Align.CENTER,
                active: mods.includes(name),
            });
            btn.connect('toggled', () => {
                if (syncingMods)
                    return;
                const next = toggleModifier(mods, name, 3);
                // Reject 4th modifier: revert button
                if (btn.active && !next.includes(name)) {
                    syncingMods = true;
                    btn.active = false;
                    syncingMods = false;
                    return;
                }
                mods = next;
                syncingMods = true;
                for (const m of MODIFIER_OPTIONS)
                    modButtons.get(m).active = mods.includes(m);
                syncingMods = false;
                applyScheme();
            });
            modButtons.set(name, btn);
            modBox.append(btn);
        }

        const modRow = new Adw.ActionRow({ title: 'Modifiers' });
        modRow.add_suffix(modBox);
        group.add(modRow);

        const manualExpander = new Adw.ExpanderRow({
            title: 'Per-direction shortcuts',
            subtitle: 'Shown when Keys is Manual',
            expanded: scheme === 'manual',
            visible: scheme === 'manual',
        });
        const refreshManualVisibility = () => {
            const isManual = scheme === 'manual';
            manualExpander.visible = isManual;
            manualExpander.expanded = isManual;
        };

        const keyBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
            css_classes: ['linked'],
        });
        const keyButtons = new Map();
        let syncingKeys = false;

        const syncKeyButtons = () => {
            syncingKeys = true;
            for (const s of KEY_SCHEMES)
                keyButtons.get(s).active = scheme === s;
            syncingKeys = false;
        };

        for (const s of KEY_SCHEMES) {
            const btn = new Gtk.ToggleButton({
                label: schemeLabel(s),
                valign: Gtk.Align.CENTER,
                active: scheme === s,
            });
            btn.connect('toggled', () => {
                if (syncingKeys)
                    return;
                if (btn.active) {
                    scheme = s;
                    syncKeyButtons();
                    refreshManualVisibility();
                    applyScheme();
                } else if (scheme === s) {
                    // Keep exactly one scheme selected.
                    syncingKeys = true;
                    btn.active = true;
                    syncingKeys = false;
                }
            });
            keyButtons.set(s, btn);
            keyBox.append(btn);
        }

        const schemeRow = new Adw.ActionRow({ title: 'Keys' });
        schemeRow.add_suffix(keyBox);
        group.add(schemeRow);

        const dirLabels = ['Left', 'Right', 'Up', 'Down'];
        keys.forEach((id, i) => {
            this._addShortcutRow(manualExpander, settings, id, dirLabels[i]);
        });
        group.add(manualExpander);

        refreshManualVisibility();
        // Do not rewrite bindings on open; only apply when the user changes controls.
    }

    _addShortcutRow(group, settings, id, title) {
        const row = new Adw.ActionRow({ title });
        const button = new Gtk.Button({
            label: acceleratorLabel(settings.get_strv(id)[0]),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });

        let capturing = false;
        const controller = new Gtk.EventControllerKey();

        const stopCapture = () => {
            capturing = false;
            button.set_label(acceleratorLabel(settings.get_strv(id)[0]));
            button.remove_controller(controller);
        };

        controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
            if (!capturing)
                return Gdk.EVENT_PROPAGATE;

            if (keyval === Gdk.KEY_Escape) {
                stopCapture();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace) {
                settings.set_strv(id, []);
                stopCapture();
                return Gdk.EVENT_STOP;
            }

            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (!Gtk.accelerator_valid(keyval, mask))
                return Gdk.EVENT_STOP;
            const accel = Gtk.accelerator_name(keyval, mask);
            if (accel) {
                settings.set_strv(id, [accel]);
                stopCapture();
                return Gdk.EVENT_STOP;
            }
            return Gdk.EVENT_STOP;
        });

        button.connect('clicked', () => {
            if (capturing) {
                stopCapture();
                return;
            }
            capturing = true;
            button.set_label('Press keys… (Esc cancel, ⌫ clear)');
            button.add_controller(controller);
            button.grab_focus();
        });

        settings.connect(`changed::${id}`, () => {
            if (!capturing)
                button.set_label(acceleratorLabel(settings.get_strv(id)[0]));
        });

        row.add_suffix(button);
        row.activatable_widget = button;
        if (typeof group.add_row === 'function')
            group.add_row(row);
        else
            group.add(row);
    }
}
