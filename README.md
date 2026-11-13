# Client Photo Gallery

A self-hosted client gallery for photographers, built as a lightweight alternative to Pixieset. Share one link, and your client can view, pick favourites for retouching, and download their photos.

[中文说明 → README.zh-CN.md](README.zh-CN.md)

> **Note:** the interface is currently in Chinese (Simplified). Translations are welcome. See [Contributing](#contributing).

## Features

**For your clients (`/g/<id>` share link)**
- Full-screen cover, with justified, masonry or square grid layouts
- Optional password per gallery
- Tap ♡ to pick photos for retouching, with an optional pick limit and per-photo notes. Submitting the selection locks it.
- Photos grouped into folders (e.g. ceremony / outdoor / dinner), and folders can be hidden
- Download a single original, or a ZIP of everything, the retouched set or the picks. Originals are served untouched.

**For you (`/admin`)**
- Drag-and-drop upload. A file with the same name replaces the old one. Thumbnails and web-size copies are generated automatically.
- See which photos the client picked, with their notes
- Copy all picked filenames in one click, then paste them into Lightroom's Library Filter (Text → Filename → Contains) to select every pick at once
- Cover focal point, cover style, grid layout and spacing are adjustable per gallery
- Sort by capture time (EXIF DateTimeOriginal, including sub-seconds), by filename, or by manual drag-and-drop
- Visit statistics: daily visits and unique visitors, most-viewed photos, downloads, mobile vs desktop. Your own admin visits are excluded, and no IP addresses are stored.

## Tech stack

- Node.js 24, Express 5
- SQLite through the built-in `node:sqlite` module (no external database)
- [sharp](https://sharp.pixelplumbing.com/) for resizing and EXIF
- [archiver](https://github.com/archiverjs/node-archiver) for ZIP downloads (store mode, no recompression)
- [SortableJS](https://sortablejs.github.io/Sortable/) for drag-and-drop ordering
- Plain HTML/CSS/JS front end, no build step

## Quick start

Requires **Node.js 22.13 or later** (24 recommended).

```bash
npm install
ADMIN_PASSWORD=change-me npm start
```

Open http://localhost:3000/admin.

Alternatively, create a `.env` file next to `server.js`:

```bash
ADMIN_PASSWORD='change-me'
PORT=3000
```

## Configuration

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Admin login password (required) |
| `PORT` | HTTP port, default `3000` |
| `DATA_DIR` | Where photos and the database live, default `./data` |
| `SESSION_SECRET` | Cookie signing key. If unset, one is generated and stored in `DATA_DIR/secret`. |

All photos and the SQLite database are stored in `DATA_DIR`. **Back up that folder and you have backed up everything.**

## Deploying

### Docker

```bash
docker build -t gallery .
docker run -d --name gallery --restart always -p 3000:3000 \
  -e ADMIN_PASSWORD=change-me -v /srv/gallery:/data gallery
```

Put it behind any HTTPS reverse proxy (Caddy, nginx). Allow large request bodies for uploads, e.g. `request_body { max_size 300MB }` in Caddy.

### Cloudflare Tunnel (no open ports)

The author's own instance runs on an Oracle Cloud Always Free ARM VM (2 OCPU / 12 GB) behind a Cloudflare Tunnel, managed by systemd. With a tunnel, the server needs no public ports and HTTPS is handled by Cloudflare.

```bash
cloudflared tunnel --url http://localhost:3000
```

See the Cloudflare docs to bind your own domain.

## Contributing

Issues and pull requests are welcome. Things that would help most:

- English (or other) translations of the interface
- Bug reports from real client deliveries

By submitting a pull request, you agree that your contribution is licensed under the same license as this project (AGPL-3.0).

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

You may use, modify and self-host this software freely. If you run a **modified** version as a service for other people, you must make your modified source code available to those users under the same license.
