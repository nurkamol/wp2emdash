/**
 * IndexNow (Bing, Yandex, Seznam, Naver and others share submissions; Google does not take part): tell search engines
 * a page changed. The key file sits at the root of the production domain (scaffold writes public/<key>.txt), which
 * lets this key submit any URL of the domain.
 */
export interface IndexNowResult {
	at: string;
	urls: number;
	status: number;
	ok: boolean;
	note?: string;
}
const NOTE: Record<number, string> = { 400: "bad request", 403: "key not valid (key file not found on the domain)", 422: "URLs do not belong to the domain or the key", 429: "too many requests" };

export async function submitIndexNow(productionUrl: string, key: string, urls: string[], fetcher: typeof fetch = fetch): Promise<IndexNowResult> {
	const host = new URL(productionUrl).host;
	const at = new Date().toISOString();
	const list = [...new Set(urls)].filter((u) => URL.canParse(u) && new URL(u).host === host).slice(0, 10_000);
	if (!list.length) return { at, urls: 0, status: 0, ok: false, note: "no URLs on the production domain" };
	try {
		const res = await fetcher("https://api.indexnow.org/indexnow", {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList: list }),
		});
		return { at, urls: list.length, status: res.status, ok: res.status === 200 || res.status === 202, ...(NOTE[res.status] ? { note: NOTE[res.status] } : {}) };
	} catch (e) {
		return { at, urls: list.length, status: 0, ok: false, note: (e as Error).message };
	}
}
