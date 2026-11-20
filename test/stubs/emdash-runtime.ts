/** Test stand-in for `emdash/runtime`: getDb returns whatever a test put in `testDb.current`. */
export const testDb: { current: unknown } = { current: undefined };
export async function getDb(): Promise<unknown> {
	return testDb.current;
}
