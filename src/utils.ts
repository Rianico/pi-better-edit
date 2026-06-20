
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key);
}

export function getVisibleLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

export function countVisibleLines(text: string): number {
	return getVisibleLines(text).length;
}
