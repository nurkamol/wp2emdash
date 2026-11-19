/**
 * Test stand-in for `emdash/middleware` (installed only in generated projects): `withEmDashRuntime` runs the callback
 * against `runtime`, whose `email` (EmDash's EmailPipeline, or null) tests set as they need.
 */
export interface StubEmailMessage {
	to: string;
	cc?: string[];
	replyTo?: string;
	subject: string;
	text: string;
	html?: string;
}
export interface StubEmailPipeline {
	isAvailable(): boolean;
	send(message: StubEmailMessage, source: string): Promise<void>;
}
export const runtime: { email: StubEmailPipeline | null } = { email: null };
export async function withEmDashRuntime<T>(run: (rt: typeof runtime) => T | Promise<T>): Promise<T> {
	return run(runtime);
}
