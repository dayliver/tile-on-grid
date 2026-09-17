# Tile on Grid

**Tile on Grid** is a keyboard-centric tiling extension for GNOME Shell, inspired by Rectangle. Windows snap to configurable **fractional sizes** of the work area and move along guide edges using Super / Shift / Ctrl + arrow keys.

## Key Features

* **Fraction snap tiling** — horizontal defaults `1/4 · 1/3 · 1/2 · 2/3 · 3/4 · 1`, vertical defaults `1/3 · 1/2 · 2/3 · 1` (fully editable in preferences).
* **Move / Expand / Shrink** with the same shortcut family as classic Rectangle-style tools.
* **Focus neighbors** with Ctrl+Alt+Arrow.
* **Super+G** opens a **shortcuts help overlay** (later: mouse placement menu).
* Padding, animation, and every shortcut are configurable.

## Installation

### From Source

```bash
git clone https://github.com/dayliver/tile-on-grid.git
mkdir -p ~/.local/share/gnome-shell/extensions
ln -sfn "$(pwd)/tile-on-grid" ~/.local/share/gnome-shell/extensions/tile-on-grid@hwaryong.com
# or copy the folder named tile-on-grid@hwaryong.com
cd ~/.local/share/gnome-shell/extensions/tile-on-grid@hwaryong.com
glib-compile-schemas schemas/
```

Restart GNOME Shell (log out & log in on Wayland) and enable the extension.

## Controls (defaults)

| Action | Shortcut |
| :--- | :--- |
| **Show help overlay** | `<Super> + g` |
| **Move** | `<Super> + Arrow` |
| **Expand** | `<Super> + Shift + Arrow` |
| **Shrink** | `<Super> + Ctrl + Arrow` |
| **Focus neighbor** | `<Ctrl> + <Alt> + Arrow` |

> **Note:** GNOME’s own WM bindings (especially `<Super>Down` → unmaximize) can steal keys. Clear conflicting entries under Settings → Keyboard → View and Customize Shortcuts → Windows, or rebind them in this extension’s preferences.

## Credits

Inspired by [Rectangle](https://extensions.gnome.org/extension/6553/rectangle/).

## License

GPL-3.0. See `LICENSE`.
