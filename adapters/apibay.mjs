import { fetchJson, humanSize, magnetFromHash } from './lib.mjs';

// The Pirate Bay через официальный JSON API — без скрейпинга HTML, потому и не ломается.
export default {
	id: 'tpb',
	name: 'The Pirate Bay',
	site: 'https://thepiratebay.org',

	async search(query, signal) {
		const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`;
		const data = await fetchJson(url, { signal });

		// Пустую выдачу API отдаёт одной фейковой записью с id 0.
		if (!Array.isArray(data) || (data.length === 1 && data[0].id === '0')) return [];

		return data.map((t) => ({
			source: 'tpb',
			title: t.name,
			date: new Date(Number(t.added) * 1000).toLocaleDateString('ru-RU'),
			dateTs: Number(t.added) * 1000,
			sizeText: humanSize(Number(t.size)),
			sizeBytes: Number(t.size),
			seeders: Number(t.seeders),
			leechers: Number(t.leechers),
			magnet: magnetFromHash(t.info_hash, t.name),
			link: `https://thepiratebay.org/description.php?id=${t.id}`,
		}));
	},
};
