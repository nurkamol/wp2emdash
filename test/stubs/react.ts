/**
 * Type stand-in for `react` (installed only in generated projects, where the admin bundles plugin admin pages): the
 * few hooks the Change requests upload page uses. The real types are checked by `astro check` in a generated project.
 */
export function createElement(_type: unknown, _props?: Record<string, unknown> | null, ..._children: unknown[]): unknown {
	return null;
}
export function useState<T>(init: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
	return [typeof init === "function" ? (init as () => T)() : init, () => {}];
}
export function useEffect(_fn: () => void | (() => void), _deps?: unknown[]): void {}
export function useCallback<T extends (...args: never[]) => unknown>(fn: T, _deps: unknown[]): T {
	return fn;
}
