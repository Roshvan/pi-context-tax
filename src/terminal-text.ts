import { stripVTControlCharacters } from "node:util";

export function terminalText(value: string): string {
	return Array.from(stripVTControlCharacters(value)).filter((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159));
	}).join("");
}
