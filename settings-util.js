/** Shared prefs / overlay helpers for grid steps and directional shortcuts. */

export const FRACTION_OPTIONS = ['1/8', '1/6', '1/5', '1/4', '1/3', '1/2'];

/** Selecting a fine step also enables these coarser steps. */
export const FRACTION_PARENTS = {
    '1/8': ['1/4', '1/2'],
    '1/6': ['1/3', '1/2'],
    '1/5': [],
    '1/4': ['1/2'],
    '1/3': [],
    '1/2': [],
};

export const KEY_SCHEMES = ['arrows', 'numpad', 'manual'];

export const MODIFIER_OPTIONS = ['Super', 'Shift', 'Control', 'Alt'];

export const ACTION_GROUPS = [
    {
        id: 'move',
        title: 'Move',
        keys: ['move-left', 'move-right', 'move-up', 'move-down'],
        defaultMods: ['Super'],
    },
    {
        id: 'expand',
        title: 'Expand',
        keys: ['expand-left', 'expand-right', 'expand-up', 'expand-down'],
        defaultMods: ['Super', 'Shift'],
    },
    {
        id: 'shrink',
        title: 'Shrink',
        keys: ['shrink-left', 'shrink-right', 'shrink-up', 'shrink-down'],
        defaultMods: ['Super', 'Control'],
    },
    {
        id: 'focus',
        title: 'Focus',
        keys: ['focus-left', 'focus-right', 'focus-up', 'focus-down'],
        defaultMods: ['Control', 'Alt'],
    },
];

const EPS = 1e-4;

const ARROW_KEYS = {
    left: 'Left',
    right: 'Right',
    up: 'Up',
    down: 'Down',
};

const NUMPAD_KEYS = {
    left: 'KP_Left',
    right: 'KP_Right',
    up: 'KP_Up',
    down: 'KP_Down',
};

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

function gcd(a, b) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
        const t = b;
        b = a % b;
        a = t;
    }
    return a || 1;
}

export function formatFraction(value) {
    if (Math.abs(value - 1) < EPS)
        return '1';
    const dens = [2, 3, 4, 5, 6, 8, 10, 12, 16];
    for (const d of dens) {
        const n = Math.round(value * d);
        if (Math.abs(n / d - value) < EPS) {
            const g = gcd(n, d);
            return `${n / g}/${d / g}`;
        }
    }
    return String(Math.round(value * 1000) / 1000);
}

function denomOf(frac) {
    const parts = String(frac).split('/');
    return parts.length === 2 ? Number(parts[1]) : NaN;
}

export function childrenOf(frac) {
    return FRACTION_OPTIONS.filter(f => (FRACTION_PARENTS[f] || []).includes(frac));
}

/** Apply cascade when enabling `frac`; returns new selected set. */
export function selectFraction(selected, frac) {
    const next = new Set(selected);
    next.add(frac);
    for (const p of FRACTION_PARENTS[frac] || [])
        next.add(p);
    return FRACTION_OPTIONS.filter(f => next.has(f));
}

/** Disable `frac` and any finer steps that cascade through it. */
export function deselectFraction(selected, frac) {
    const next = new Set(selected);
    next.delete(frac);
    let changed = true;
    while (changed) {
        changed = false;
        for (const f of [...next]) {
            const parents = FRACTION_PARENTS[f] || [];
            if (parents.some(p => !next.has(p))) {
                next.delete(f);
                changed = true;
            }
        }
    }
    return FRACTION_OPTIONS.filter(f => next.has(f));
}

/** Build step list: all k/n for each selected 1/n, plus full. */
export function stepsFromSelected(selected) {
    const values = [];
    for (const frac of selected) {
        const n = denomOf(frac);
        if (!Number.isFinite(n) || n < 2)
            continue;
        for (let k = 1; k <= n; k++)
            values.push(k / n);
    }
    values.push(1);
    values.sort((a, b) => a - b);
    const unique = [];
    for (const v of values) {
        if (!unique.length || Math.abs(unique[unique.length - 1] - v) > EPS)
            unique.push(v);
    }
    return unique.map(formatFraction);
}

/** Infer which toggles are on from a stored step list. */
export function selectedFromSteps(strv) {
    const values = [];
    for (const item of strv || []) {
        const v = parseFraction(item);
        if (Number.isFinite(v) && v > 0 && v <= 1 + EPS)
            values.push(Math.min(1, v));
    }
    const has = target => values.some(v => Math.abs(v - target) < EPS);
    return FRACTION_OPTIONS.filter(frac => {
        const n = denomOf(frac);
        // On if the unit fraction itself is present (or any non-trivial multiple unique to n).
        return has(1 / n);
    });
}

export function modifiersToPrefix(mods) {
    const order = ['Super', 'Control', 'Alt', 'Shift'];
    const set = new Set(mods);
    return order.filter(m => set.has(m)).map(m => `<${m}>`).join('');
}

export function parseModifiers(accel) {
    if (!accel)
        return [];
    const found = [];
    for (const m of MODIFIER_OPTIONS) {
        if (accel.includes(`<${m}>`) || (m === 'Control' && accel.includes('<Primary>')))
            found.push(m);
    }
    return found;
}

export function parseKeyTail(accel) {
    if (!accel)
        return '';
    return accel.replace(/<[^>]+>/g, '');
}

export function detectKeyScheme(settings, keys) {
    const accels = keys.map(k => settings.get_strv(k)[0] || '');
    if (accels.some(a => !a))
        return 'manual';

    const mods0 = modifiersToPrefix(parseModifiers(accels[0]));

    // keys order is left, right, up, down
    const arrowOk = ['left', 'right', 'up', 'down'].every((dir, i) => {
        const mods = modifiersToPrefix(parseModifiers(accels[i]));
        return mods === mods0 && parseKeyTail(accels[i]) === ARROW_KEYS[dir];
    });
    if (arrowOk)
        return 'arrows';

    const numOk = ['left', 'right', 'up', 'down'].every((dir, i) => {
        const mods = modifiersToPrefix(parseModifiers(accels[i]));
        const tail = parseKeyTail(accels[i]);
        return mods === mods0 && (tail === NUMPAD_KEYS[dir] ||
            (dir === 'left' && tail === 'KP_4') ||
            (dir === 'right' && tail === 'KP_6') ||
            (dir === 'up' && tail === 'KP_8') ||
            (dir === 'down' && tail === 'KP_2'));
    });
    if (numOk)
        return 'numpad';

    return 'manual';
}

export function applyDirectionalScheme(settings, keys, mods, scheme) {
    if (scheme === 'manual')
        return;
    const limited = mods.slice(0, 3);
    const prefix = modifiersToPrefix(limited);
    const map = scheme === 'numpad' ? NUMPAD_KEYS : ARROW_KEYS;
    const dirs = ['left', 'right', 'up', 'down'];
    dirs.forEach((dir, i) => {
        settings.set_strv(keys[i], [`${prefix}${map[dir]}`]);
    });
}

export function schemeLabel(scheme) {
    switch (scheme) {
    case 'arrows':
        return 'Arrow keys';
    case 'numpad':
        return 'Numpad';
    case 'manual':
        return 'Manual';
    default:
        return scheme;
    }
}

export function cycleScheme(scheme) {
    const i = KEY_SCHEMES.indexOf(scheme);
    return KEY_SCHEMES[(i + 1) % KEY_SCHEMES.length];
}

export function toggleModifier(mods, name, max = 3) {
    const set = new Set(mods);
    if (set.has(name)) {
        set.delete(name);
    } else if (set.size < max) {
        set.add(name);
    }
    return MODIFIER_OPTIONS.filter(m => set.has(m));
}
