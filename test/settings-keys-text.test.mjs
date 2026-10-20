import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeKey } from "../extension/settings/keys.mjs";
import { displayWidth, fitCells, padCells, plainText } from "../extension/settings/text.mjs";

test("decodeKey: arrows in legacy and SS3 forms", () => {
	assert.equal(decodeKey("\x1b[A"), "up");
	assert.equal(decodeKey("\x1bOA"), "up");
	assert.equal(decodeKey("\x1b[B"), "down");
	assert.equal(decodeKey("\x1bOB"), "down");
});

test("decodeKey: left and right in legacy and SS3 forms", () => {
	assert.equal(decodeKey("\x1b[D"), "left");
	assert.equal(decodeKey("\x1bOD"), "left");
	assert.equal(decodeKey("\x1b[C"), "right");
	assert.equal(decodeKey("\x1bOC"), "right");
});

test("decodeKey: Enter, Esc and space", () => {
	assert.equal(decodeKey("\r"), "enter");
	assert.equal(decodeKey("\x1b"), "escape");
	assert.equal(decodeKey(" "), "space");
});

test("decodeKey: kitty CSI u letter and shifted letter", () => {
	assert.equal(decodeKey("\x1b[115u"), "s");
	assert.equal(decodeKey("\x1b[107;2u"), "K");
});

test("decodeKey: ctrl-modified CSI u is not read as a letter", () => {
	assert.equal(decodeKey("\x1b[115;5u"), undefined);
});

test("decodeKey: host keybindings map ids to keys", () => {
	const keybindings = { matches: (d, id) => d === "X" && id === "tui.select.up" };
	assert.equal(decodeKey("X", keybindings), "up");
	assert.equal(decodeKey("X"), "X");
});

test("displayWidth: wide Hangul counts two cells each and ANSI is zero width", () => {
	assert.equal(displayWidth("한도"), 4);
	assert.equal(displayWidth("\x1b[31mab\x1b[0m"), 2);
});

test("fitCells: truncates wide text with an ellipsis", () => {
	assert.equal(fitCells("가나다", 5), "가나…");
});

test("padCells: pads to the requested width", () => {
	assert.equal(padCells("a", 3), "a  ");
});

test("plainText: strips escapes and collapses whitespace", () => {
	assert.equal(plainText("\x1b[31m a\tb\n\x1b[0m"), "a b");
});
