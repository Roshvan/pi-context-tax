const DEFAULT_CONTEXT_WINDOW = 128_000;

export function resolveContextWindow(
	reportedContextWindow: number | null | undefined,
	modelContextWindow: number | null | undefined,
): number {
	if (reportedContextWindow !== null
		&& reportedContextWindow !== undefined
		&& Number.isFinite(reportedContextWindow)
		&& reportedContextWindow > 0) {
		return reportedContextWindow;
	}
	if (modelContextWindow !== null
		&& modelContextWindow !== undefined
		&& Number.isFinite(modelContextWindow)
		&& modelContextWindow > 0) {
		return modelContextWindow;
	}
	return DEFAULT_CONTEXT_WINDOW;
}
