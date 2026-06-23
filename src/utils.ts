export function isRec(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function has(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key);
}

export function visLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

export function cntLines(text: string): number {
	return visLines(text).length;
}

export function rejectUnknownFields(
	obj: Record<string, unknown>,
	allowed: Set<string>,
	label: string,
	hint?: string,
): void {
	const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
	if (unknown.length > 0) {
		const suffix = hint ? ` ${hint}` : "";
		throw new Error(
			`[E_BAD_SHAPE] ${label} contains unknown or unsupported fields: ${unknown.join(", ")}.${suffix}`,
		);
	}
}
