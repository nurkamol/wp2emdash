import { spawn } from "node:child_process";
import { SITES_DIR } from "../core/paths.js";
import { startUiServer, type UiServer } from "../ui/server.js";

/** Starts the local dashboard (127.0.0.1, random port, one-time token) and optionally opens the browser. */
export async function startUi(opts: { open?: boolean; port?: number; sitesDir?: string } = {}): Promise<UiServer> {
	const ui = await startUiServer({ sitesDir: opts.sitesDir ?? SITES_DIR, ...(opts.port ? { port: opts.port } : {}) });
	if (opts.open !== false) openBrowser(ui.url);
	return ui;
}

function openBrowser(url: string): void {
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	try {
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
	} catch {
		// no browser available: the URL is printed anyway
	}
}
