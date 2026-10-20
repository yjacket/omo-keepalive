const RAW_KEYS = {
	"\x1b[A": "up", "\x1bOA": "up", "\x1b[B": "down", "\x1bOB": "down",
	"\x1b[D": "left", "\x1bOD": "left", "\x1b[C": "right", "\x1bOC": "right",
	"\x1b[1;2A": "shiftUp", "\x1b[1;2B": "shiftDown",
	"\x1b[5~": "pageUp", "\x1b[6~": "pageDown",
	"\x1b[H": "home", "\x1bOH": "home", "\x1b[1~": "home", "\x1b[F": "end", "\x1bOF": "end", "\x1b[4~": "end",
	"\r": "enter", "\n": "enter", "\x1b": "escape", "\t": "tab", "\x7f": "backspace", "\x1b[3~": "delete",
	" ": "space",
};
const SELECT_BINDINGS = [
	["tui.select.up", "up"], ["tui.select.down", "down"], ["tui.select.pageUp", "pageUp"],
	["tui.select.pageDown", "pageDown"], ["tui.select.confirm", "enter"], ["tui.select.cancel", "escape"],
];
const CSI_U_KEYS = { 8: "backspace", 9: "tab", 13: "enter", 27: "escape", 127: "backspace" };

/** One key press as the status list names it: a navigation key, a printable character
 * (Shift letters arrive uppercase), or undefined. Legacy, xterm and kitty (CSI u)
 * sequences are read; the host's select keybindings count too.
 * Printable keys held with ctrl/alt/super are ignored, never read as letters. */
export function decodeKey(data, keybindings) {
	if (Object.hasOwn(RAW_KEYS, data)) return RAW_KEYS[data];
	// ^H is Backspace, except under Windows Terminal, which sends it for ctrl+Backspace.
	if (data === "\b") return process.env.WT_SESSION ? undefined : "backspace";
	for (const [id, key] of SELECT_BINDINGS) {
		try {
			if (keybindings?.matches(data, id)) return key;
		} catch {
			// a host without that binding id
		}
	}
	// kitty CSI u (`code;mods u`) and xterm modifyOtherKeys (`27;mods;code ~`).
	const csi = data.startsWith("\x1b[27;") ? /^(\d+);(\d+)~$/.exec(data.slice(5))?.slice(1).reverse()
		: data.startsWith("\x1b[") ? /^(\d+)(?::\d+)*(?:;(\d+)(?::\d+)*)?u$/.exec(data.slice(2))?.slice(1) : undefined;
	if (csi) {
		const code = Number(csi[0]);
		// Caps Lock (64) and Num Lock (128) are not held keys.
		const modifiers = (Number(csi[1] ?? "1") - 1) & ~(64 | 128);
		// Held ctrl/alt/super never edit: ctrl+Backspace is not Backspace.
		if ((modifiers & ~1) !== 0) return undefined;
		if (CSI_U_KEYS[code]) return CSI_U_KEYS[code];
		if (code < 32) return undefined;
		const char = String.fromCodePoint(code);
		return modifiers & 1 ? char.toUpperCase() : char;
	}
	return [...data].length === 1 && data >= " " ? data : undefined;
}
