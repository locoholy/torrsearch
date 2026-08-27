import { fetchText, stripTags, humanSize, cp1251Query } from './lib.mjs';

const BASE = 'https://nnmclub.to/forum';

export default {
	id: 'nnm',
	name: 'NNM-Club',
	site: BASE,

	async search(query, signal) {
		const html = await fetchText(`${BASE}/tracker.php?nm=${cp1251Query(query)}`, {
			signal,
			encoding: 'windows-1251',
		});
		const rows = html.match(/<tr class="prow[12]">[\s\S]*?<\/tr>/g) ?? [];
		const out = [];

		for (const row of rows) {
			const id = row.match(/viewtopic\.php\?t=(\d+)/)?.[1];
			const title = row.match(/class="genmed topictitle"[^>]*><b>([\s\S]*?)<\/b>/)?.[1];
			if (!id || !title) continue;

			const sizeBytes = Number(row.match(/<u>(\d{4,})<\/u>\s*[\d.]+\s*[KMGT]?B/)?.[1] ?? 0);
			const ts = Number(row.match(/<u>(\d{9,10})<\/u>/g)?.at(-1)?.match(/\d+/)?.[0] ?? 0) * 1000;

			out.push({
				source: 'nnm',
				title: stripTags(title),
				date: ts ? new Date(ts).toLocaleDateString('ru-RU') : '',
				dateTs: ts,
				sizeText: humanSize(sizeBytes),
				sizeBytes,
				seeders: Number(row.match(/class="seedmed"><b>(\d+)/)?.[1] ?? 0),
				leechers: Number(row.match(/class="leechmed"><b>(\d+)/)?.[1] ?? 0),
				// Magnet в выдаче нет — он на странице темы. Тянем по клику, чтобы не делать
				// 50 лишних запросов на каждый поиск.
				magnet: null,
				magnetId: id,
				link: `${BASE}/viewtopic.php?t=${id}`,
			});
		}
		return out;
	},

	async resolveMagnet(id, signal) {
		const html = await fetchText(`${BASE}/viewtopic.php?t=${encodeURIComponent(id)}`, {
			signal,
			encoding: 'windows-1251',
		});
		return html.match(/magnet:\?xt=urn:btih:[^"'&\s]+/)?.[0] ?? null;
	},
};
