import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TileOnGridPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.tile-on-grid');

        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- 1. General Settings ---
        const groupGeneral = new Adw.PreferencesGroup({ title: 'Appearance & Behavior' });
        page.add(groupGeneral);

        const rowAnim = new Adw.SwitchRow({
            title: 'Enable Animation',
            subtitle: 'Smooth movement effects',
            active: settings.get_boolean('animate-movement')
        });
        rowAnim.connect('notify::active', () => settings.set_boolean('animate-movement', rowAnim.active));
        groupGeneral.add(rowAnim);

        const rowInner = new Adw.SpinRow({
            title: 'Inner Padding',
            subtitle: 'Gap between windows',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 1 }),
            value: settings.get_int('padding-inner')
        });
        rowInner.connect('notify::value', () => settings.set_int('padding-inner', rowInner.value));
        groupGeneral.add(rowInner);

        const rowOuter = new Adw.SpinRow({
            title: 'Outer Padding',
            subtitle: 'Gap between windows and screen edges',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 1 }),
            value: settings.get_int('padding-outer')
        });
        rowOuter.connect('notify::value', () => settings.set_int('padding-outer', rowOuter.value));
        groupGeneral.add(rowOuter);


        // --- 2. Keyboard Shortcuts (Grouped) ---
        
        // Helper
        const addShortcutRow = (group, id, title) => {
            const row = new Adw.ActionRow({ title: title });
            const currentShortcut = settings.get_strv(id)[0] || "";
            const label = new Gtk.Label({ 
                label: currentShortcut,
                css_classes: ['dim-label']
            });
            row.add_suffix(label);
            group.add(row);
        };

        // Group 1: Toggle
        const groupShortcuts1 = new Adw.PreferencesGroup({ title: 'Keyboard Shortcuts' });
        page.add(groupShortcuts1);
        addShortcutRow(groupShortcuts1, 'toggle-grid-shortcut', 'Toggle Grid Overlay');

        // Group 2: Move
        const groupShortcuts2 = new Adw.PreferencesGroup(); // Empty title for spacing
        page.add(groupShortcuts2);
        addShortcutRow(groupShortcuts2, 'move-left', 'Move Window Left');
        addShortcutRow(groupShortcuts2, 'move-right', 'Move Window Right');
        addShortcutRow(groupShortcuts2, 'move-up', 'Move Window Up');
        addShortcutRow(groupShortcuts2, 'move-down', 'Move Window Down');

        // Group 3: Expand
        const groupShortcuts3 = new Adw.PreferencesGroup();
        page.add(groupShortcuts3);
        addShortcutRow(groupShortcuts3, 'expand-left', 'Expand Window Left');
        addShortcutRow(groupShortcuts3, 'expand-right', 'Expand Window Right');
        addShortcutRow(groupShortcuts3, 'expand-up', 'Expand Window Up');
        addShortcutRow(groupShortcuts3, 'expand-down', 'Expand Window Down');

        // Group 4: Shrink
        const groupShortcuts4 = new Adw.PreferencesGroup();
        page.add(groupShortcuts4);
        addShortcutRow(groupShortcuts4, 'shrink-left', 'Shrink Window Left');
        addShortcutRow(groupShortcuts4, 'shrink-right', 'Shrink Window Right');
        addShortcutRow(groupShortcuts4, 'shrink-up', 'Shrink Window Up');
        addShortcutRow(groupShortcuts4, 'shrink-down', 'Shrink Window Down');

        // Group 5: Focus
        const groupShortcuts5 = new Adw.PreferencesGroup();
        page.add(groupShortcuts5);
        addShortcutRow(groupShortcuts5, 'focus-left', 'Focus Window Left');
        addShortcutRow(groupShortcuts5, 'focus-right', 'Focus Window Right');
        addShortcutRow(groupShortcuts5, 'focus-up', 'Focus Window Up');
        addShortcutRow(groupShortcuts5, 'focus-down', 'Focus Window Down');
    }
}