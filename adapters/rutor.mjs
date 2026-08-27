import { fetchText, stripTags, parseSize, parseRuDate } from './lib.mjs';

// rutor отдаёт utf-8 и кладёт magnet прямо в строку выдачи — самый простой источник.
export default {
	id: 'rutor',
	name: 'rutor.info',
	site: 'https://rutor.info',

	async search(query, signal) {
		const url = `https://rutor.info/search/0/0/000/0/${encodeURIComponent(query)}`;
		const html = await fetchText(url, { signal });
		const rows = html.match(/<tr class="(?:gai|tum)">[\s\S]*?<\/tr>/g) ?? [];
		const out = [];

		for (const row of rows) {
			const magnet = row.match(/href="(magnet:\?xt=urn:btih:[^"]+)"/)?.[1];
			const link = row.match(/href="(\/torrent\/\d+[^"]*)"/)?.[1];
			const title = row.match(/href="\/torrent\/\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1];
			if (!magnet || !title) continue;

			const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? [];
			const sizeText = stripTags(cells.at(-2) ?? '');
			const peers = stripTags(cells.at(-1) ?? '');
			const [seeders = 0, leechers = 0] = peers.match(/\d+/g)?.map(Number) ?? [];

			const date = stripTags(cells[0] ?? '');

			out.push({
				source: 'rutor',
				title: stripTags(title),
				date,
				dateTs: parseRuDate(date),
				sizeText,
				sizeBytes: parseSize(sizeText),
				seeders,
				leechers,
				magnet: magnet.replace(/&amp;/g, '&'),
				link: link ? `https://rutor.info${link}` : null,
			});
		}
		return out;
	},
};
