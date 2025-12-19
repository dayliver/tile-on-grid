# Tile on Grid

**Tile on Grid** is a keyboard-centric tiling window manager extension for GNOME Shell, inspired by Rectangle and other tiling tools. It provides a visual grid overlay for precise window placement and features a "HUD" style interface for intuitive control.

![Tile on Grid Screenshot](https://github.com/se-in/tile-on-grid/raw/main/screenshot.png)
*(Note: Upload a screenshot later and replace this link!)*

## ✨ Key Features

* **Visual Grid Overlay**: Press `<Super>+g` to summon a grid overlay centered on your screen.
* **Grid Presets**: Quickly switch between layouts (1x2, 2x2, 3x3, 1x4, etc.) using number keys `1`–`9`.
* **QWERTY Selection**: Select grid cells instantly using keys mapped to their physical location (e.g., `Q`, `W`, `E` for top row).
* **Keyboard Navigation**:
    * Move windows: `<Super> + Arrow`
    * Expand windows: `<Super> + Shift + Arrow`
    * Shrink windows: `<Super> + Ctrl + Arrow`
    * **Focus Navigation**: Switch focus to neighboring windows using `<Ctrl> + <Alt> + Arrow`.
* **Customizable**: Adjust padding, animation speed, and shortcuts via Extension Settings.

## 🚀 Installation

### From Source
1.  Clone this repository:
    ```bash
    git clone [https://github.com/se-in/tile-on-grid.git](https://github.com/se-in/tile-on-grid.git)
    ```
2.  Move to the extensions folder:
    ```bash
    mv tile-on-grid ~/.local/share/gnome-shell/extensions/tile-on-grid@hwaryong.com
    ```
3.  Compile schemas:
    ```bash
    cd ~/.local/share/gnome-shell/extensions/tile-on-grid@hwaryong.com
    glib-compile-schemas schemas/
    ```
4.  Restart GNOME Shell (Log out & Log in) and enable the extension.

## 🎮 Controls

| Action | Shortcut (Default) |
| :--- | :--- |
| **Toggle Grid** | `<Super> + g` |
| **Move Window** | `<Super> + Arrow` |
| **Expand Window** | `<Super> + Shift + Arrow` |
| **Shrink Window** | `<Super> + Ctrl + Arrow` |
| **Focus Neighbor** | `<Ctrl> + <Alt> + Arrow` |

### While Grid is Active:
* `Tab` / `Shift+Tab`: Cycle through layouts.
* `1` – `9`: Select specific grid layout.
* `Q`, `W`, `E` ... `Z`, `X`, `C`: Move window to the corresponding cell immediately.
* `Esc`: Cancel.

## ⚖️ License

Distributed under the GPL-3.0 License. See `LICENSE` for more information.