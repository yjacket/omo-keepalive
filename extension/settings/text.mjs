// CSI, OSC (BEL or ST terminated) and charset escapes; built from the code points so the pattern has no raw control characters.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ESCAPE_SOURCE = `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[()][0-2A-Z])`;
const ESCAPE = new RegExp(ESCAPE_SOURCE, "y");
const ESCAPES = new RegExp(ESCAPE_SOURCE, "g");

function graphemeWidth(value) {
	const code = value.codePointAt(0) ?? 0;
	if (/\p{Mark}/u.test(value)) return 0;
	if (/\p{Extended_Pictographic}/u.test(value)) return 2;
	if (
		code >= 0x1100 && (
			code <= 0x115f || code === 0x2329 || code === 0x232a
			|| (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
			|| (code >= 0xac00 && code <= 0xd7a3)
			|| (code >= 0xf900 && code <= 0xfaff)
			|| (code >= 0xfe10 && code <= 0xfe19)
			|| (code >= 0xfe30 && code <= 0xfe6f)
			|| (code >= 0xff00 && code <= 0xff60)
			|| (code >= 0xffe0 && code <= 0xffe6)
			|| (code >= 0x20000 && code <= 0x3fffd)
		)
	) return 2;
	return 1;
}

export function displayWidth(s) {
	let width = 0;
	for (let i = 0; i < s.length;) {
		ESCAPE.lastIndex = i;
		if (ESCAPE.exec(s)) {
			i = ESCAPE.lastIndex;
			continue;
		}
		const char = String.fromCodePoint(s.codePointAt(i) ?? 0);
		width += graphemeWidth(char);
		i += char.length;
	}
	return width;
}

export function fitCells(s, width) {
	if (width <= 0) return "";
	if (displayWidth(s) <= width) return s;
	const limit = width - 1;
	let out = "";
	let used = 0;
	for (let i = 0; i < s.length;) {
		ESCAPE.lastIndex = i;
		const sequence = ESCAPE.exec(s);
		if (sequence) {
			out += sequence[0];
			i = ESCAPE.lastIndex;
			continue;
		}
		const char = String.fromCodePoint(s.codePointAt(i) ?? 0);
		const cells = graphemeWidth(char);
		if (used + cells > limit) break;
		out += char;
		used += cells;
		i += char.length;
	}
	return `${out}…`;
}

export function padCells(s, width) {
	if (width <= 0) return "";
	const fitted = fitCells(s, width);
	return fitted + " ".repeat(Math.max(0, width - displayWidth(fitted)));
}

export function plainText(s) {
	return s
		.replace(ESCAPES, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}
