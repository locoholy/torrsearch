# torrsearch

A local meta-search server for torrent indexers. It queries several sources at
once and streams results to the page as each one answers. Runs on **plain
Node.js — zero npm dependencies**, and listens on localhost only.

**English** · [Русский](README.ru.md)

![Node](https://img.shields.io/badge/Node.js-18%2B-1a9fff?style=flat-square)
![Dependencies](https://img.shields.io/badge/dependencies-none-5ba32b?style=flat-square)
![Localhost](https://img.shields.io/badge/binds-127.0.0.1-e5a50a?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-7a8894?style=flat-square)

---

## Run

```bash
./start.sh          # starts the server and opens a browser tab
node server.mjs     # or by hand — http://127.0.0.1:8777
```

`start.sh` checks whether the server is already up and only opens a tab if it
is, so it can be wired to a desktop entry and clicked repeatedly.

---

## How it is built

### Sources are plugins

Every indexer is one file in `adapters/` behind a small interface. Adding one
means writing that file and adding a line to `ADAPTERS` in `server.mjs` —
nothing else in the server or the frontend has to change, because the page
discovers sources through `/api/sources`.

```js
export default {
	id: 'example',
	name: 'Example',
	site: 'https://example.org',
	async search(query, signal) {
		// return [{ title, date, dateTs, sizeText, sizeBytes,
		//           seeders, leechers, magnet, link }]
	},
	// optional: called on click when the listing has no magnet link
	async resolveMagnet(id, signal) { /* return a magnet URI */ },
	// optional: false greys the source out until it is configured
	ready: () => true,
};
```

Adapters deal with what real sites do: one serves JSON, another windows-1251
HTML, a third needs cookies from a logged-in browser. That mess stays inside
the adapter — the server sees one shape of result.

### Results stream in (SSE)

Each source pushes its rows to the browser the moment it answers, over
server-sent events. Waiting for the slowest source in order to show the fastest
is the main reason search pages feel dead, and here it does not happen.

Each source gets its own chip in the header: `searching` with a running
stopwatch → `32 found` / `empty` / `no answer` / `error`. It is never unclear
whether something is still working or has hung. Per-attempt timeout is 5 s with
2 attempts, so a dead source drops out on its own without holding up the rest.
Repeated queries come out of a 10-minute cache.

### Live peer counts (BEP 15)

The S/L numbers an indexer prints are a snapshot from its last reindex, and some
sources publish no peer statistics at all — for those, the swarm actually lives
on whatever public trackers the `.torrent` announces to.

So peers are asked of the trackers themselves, over the UDP scrape protocol
(BEP 15). Several are queried at once and the fullest answer wins: each tracker
only knows the peers that announced to *it*. Live values are marked with a dot
and a tooltip naming the tracker and the `completed` count — how many finished
the download, which predicts whether a torrent will still be alive next month
better than the seed count right now.

### Info hashes are computed, not scraped

When a source only offers a `.torrent` and no magnet link, the server downloads
it and derives the `btih` itself: SHA-1 over the `info` dictionary **exactly as
it appears in the file**. Re-encoding it is the classic way to get this wrong —
the key order changes and the hash no longer matches.

---

## Bundled adapters

| id | notes |
|---|---|
| `rutor` | magnet links present in the listing |
| `nnm` | windows-1251 pages; magnet fetched on click |
| `tpb` | JSON API |
| `byrut` | no magnet and no peer stats in the listing — both are derived |
| `rutracker` | needs cookies from a logged-in browser, see below |

Unconfigured sources stay in the list, greyed out, with a note on what they need.

### Cookies for sources that require a login

Some sites are behind both a Cloudflare challenge and a mandatory login. A
script cannot get past either, but one cookie string from a browser that is
already logged in opens both doors:

```bash
mkdir -p ~/.config/torrsearch
echo 'name=value; name2=value2' > ~/.config/torrsearch/rutracker.cookie
```

Take it from DevTools → Network → any request to the site → the `Cookie`
header. The file is read on every search, so no restart is needed. Cloudflare
ties its clearance cookie to the User-Agent — if the cookies do not work, set
`RUTRACKER_UA` to the same UA the browser sends. When cookies expire the source
reports “needs setup” rather than “error”.

Cookies live in `~/.config/torrsearch/` and never in the repository.

---

## Configuration

All through environment variables:

| variable | default | meaning |
|---|---|---|
| `PORT` | `8777` | server port |
| `SOURCE_TIMEOUT` | `5000` | per-attempt timeout, ms |
| `ATTEMPTS` | `2` | attempts per source |
| `MAGNET_TIMEOUT` | `15000` | timeout for deriving a magnet, ms |
| `CACHE_TTL` | `600000` | cache lifetime, ms |
| `RUTRACKER_COOKIE` | — | cookies inline instead of the file |
| `RUTRACKER_UA` | — | User-Agent matching the clearance cookie |
| `TRANSMISSION_RPC` | `http://127.0.0.1:9091/transmission/rpc` | Transmission RPC endpoint |

## Sending a result to Transmission

The **⬇** button hands a magnet to a running Transmission over RPC — it needs
remote access enabled (Edit → Preferences → Remote, port 9091). Without it the
button says so plainly; **🔗** copies the magnet to the clipboard regardless.

---

## Scope

This is a search front-end. It indexes nothing, hosts nothing and stores no
content — it queries public sites and shows what they return, the way a browser
would. What you do with the results is on you, and subject to the law where you
live.

## License

MIT — see [LICENSE](LICENSE).
