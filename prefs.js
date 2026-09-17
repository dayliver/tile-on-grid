import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function acceleratorLabel(accel) {
    return accel || 'Disabled';
}

export default class TileOnGridPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.tile-on-grid');
        window.set_default_size(560, 720);

        const page = new Adw.PreferencesPage({ title: 'General' });
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
            description: 'Comma-separated fractions of the work area (e.g. 1/4, 1/3, 0.5). Horizontal defaults suit most monitors; add finer steps on high-resolution displays.',
        });
        page.add(groupSteps);

        const addStepsRow = (key, title) => {
            const row = new Adw.EntryRow({
                title,
                text: settings.get_strv(key).join(', '),
            });
            const commit = () => {
                const parts = row.text.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
                settings.set_strv(key, parts);
            };
            row.connect('apply', commit);
            row.connect('entry-activated', commit);
            // Adw.EntryRow may not always emit apply; also commit on focus leave via notify.
            row.connect('notify::text', () => {
                /* live edit kept in widget; committed on apply / activated */
            });
            const applyBtn = new Gtk.Button({
                label: 'Apply',
                valign: Gtk.Align.CENTER,
                css_classes: ['suggested-action'],
            });
            applyBtn.connect('clicked', commit);
            row.add_suffix(applyBtn);
            groupSteps.add(row);
        };

        addStepsRow('horizontal-steps', 'Horizontal sizes');
        addStepsRow('vertical-steps', 'Vertical sizes');

        const pageKeys = new Adw.PreferencesPage({ title: 'Shortcuts' });
        window.add(pageKeys);

        const addShortcutGroup = (title, items) => {
            const group = new Adw.PreferencesGroup({ title });
            pageKeys.add(group);
            for (const [id, label] of items)
                this._addShortcutRow(group, settings, id, label);
        };

        addShortcutGroup('Help', [
            ['toggle-grid-shortcut', 'Show shortcuts help'],
        ]);
        addShortcutGroup('Move', [
            ['move-left', 'Move left'],
            ['move-right', 'Move right'],
            ['move-up', 'Move up'],
            ['move-down', 'Move down'],
        ]);
        addShortcutGroup('Expand', [
            ['expand-left', 'Expand left'],
            ['expand-right', 'Expand right'],
            ['expand-up', 'Expand up'],
            ['expand-down', 'Expand down'],
        ]);
        addShortcutGroup('Shrink', [
            ['shrink-left', 'Shrink from left'],
            ['shrink-right', 'Shrink from right'],
            ['shrink-up', 'Shrink from top'],
            ['shrink-down', 'Shrink from bottom'],
        ]);
        addShortcutGroup('Focus', [
            ['focus-left', 'Focus left'],
            ['focus-right', 'Focus right'],
            ['focus-up', 'Focus up'],
            ['focus-down', 'Focus down'],
        ]);
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
        group.add(row);
    }
}
