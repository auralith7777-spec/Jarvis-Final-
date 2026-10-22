import { sleep } from "./util.js";

/** POST JSON with retry on rate limits (429), server errors (5xx) and network blips. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  retries = 3
): Promise<any> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      if (res.ok) return await res.json();
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(800 * 2 ** attempt);
        attempt++;
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    } catch (e) {
      if (e instanceof TypeError && attempt < retries) {
        await sleep(800 * 2 ** attempt);
        attempt++;
        continue;
      }
      throw e;
    }
  }
}
