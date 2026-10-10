# Oblihub

**Self-hosted Docker control panel: image updates, compose stacks, a built-in reverse proxy and multi-host management.**

Oblihub watches your running containers, compares local and registry image digests, and updates containers on demand or on a schedule. Beyond updates, it manages compose stacks, runs an integrated nginx reverse proxy with Let's Encrypt certificates, monitors uptime and drives several Docker engines from one panel.

Website: [hub.obli.tools](https://hub.obli.tools)

## Key features

- **Update detection and auto-update**: digest comparison for Docker Hub, GHCR and private registries, per-stack check intervals and auto-update, excluded containers, maintenance windows, and self-update.
- **Managed compose stacks** (opt-in): edit and deploy compose files from the UI, from a ZIP upload or a Git repository with auto-pull; volumes on local disk, SMB/CIFS, NFS or S3.
- **App store**: deploy templates in one click.
- **Integrated reverse proxy** (opt-in): proxy hosts, redirections, streams, access lists and custom pages, Let's Encrypt certificates (HTTP-01), optional Microsoft Entra ID sign-in in front of a host.
- **Honeypot paths and IP bans**, which can be forwarded to [Obliguard](https://github.com/obli-tools/Obliguard).
- **Traffic analytics**: top IPs and URIs, errors, slow requests, percentiles and GeoIP.
- **Multiple Docker engines**: local socket, SSH, HTTPS with an API key, or TLS / mTLS; optional Tailscale sidecar.
- **Resources and GPU**: per-stack CPU / RAM / GPU limits, NVIDIA GPU power limits, and sleep / wake of idle containers.
- **Uptime monitors and workflows** with cron or interval triggers.
- **Notifications, console and access control**: 10 notification channels, a web console into containers (opt-in), teams and roles.

## Quick install

```sh
curl -fsSL https://raw.githubusercontent.com/obli-tools/Oblihub/main/install.sh | sh
```

The installer runs on Linux, or on macOS with Docker Desktop. It:

- checks Docker and Docker Compose; on Linux it offers to install them with Docker's official script, only after you confirm;
- downloads `docker-compose.yml` and `.env.example` into `./oblihub`;
- creates `.env` with unique random secrets (`DB_PASSWORD`, `SESSION_SECRET`, initial admin password) and the `proxy` Docker network;
- pulls the images, starts the stack and prints the panel URL and the initial admin password (shown only once).

Running it again upgrades an existing install; `.env` is never modified.

Options (pass them after `sh -s --`):

| Option | Description |
|--------|-------------|
| `-y`, `--yes` | Non-interactive: accept the defaults and install Docker if it is missing |
| `--dir PATH` | Install directory (default `./oblihub`) |
| `--port PORT` | Host HTTPS port of the web interface (default `3101`, first install only) |
| `--url URL` | Public URL of the panel, e.g. `https://oblihub.example.com` (first install only) |

```sh
curl -fsSL https://raw.githubusercontent.com/obli-tools/Oblihub/main/install.sh | sh -s -- -y --dir /opt/oblihub --url https://oblihub.example.com
```

`--help` lists every option.

## Manual install (Docker Compose)

```sh
mkdir oblihub && cd oblihub
curl -fsSLO https://raw.githubusercontent.com/obli-tools/Oblihub/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/obli-tools/Oblihub/main/.env.example
cp .env.example .env
docker network create proxy
# Edit .env: set DB_PASSWORD, SESSION_SECRET (a long random string), DEFAULT_ADMIN_PASSWORD
# and CLIENT_ORIGIN (the public URL of the panel).
docker compose up -d
```

The stack runs PostgreSQL 16, the server (`meejay/oblihub-server`), the web client (`meejay/oblihub-client`) and the integrated nginx proxy. To use an existing PostgreSQL server instead, see `docker-compose.external-db.yml`.

## Update

```sh
docker compose pull && docker compose up -d
```

Or run the installer again from the same directory.

## Ports and host access

- The web client answers on HTTPS port `3101` (`LISTEN_PORT_HTTPS`) with a self-signed certificate (your browser warns once); plain HTTP is on port `3100` (`LISTEN_PORT`).
- The integrated proxy publishes ports `80` and `443` (`PROXY_HTTP_PORT` / `PROXY_HTTPS_PORT`), needed for proxied hosts and Let's Encrypt.
- Oblihub manages Docker through `/var/run/docker.sock`, which gives it full control of the host's Docker engine. Compose files of managed stacks are kept in `/data/stacks` (`STACKS_HOST_DIR`): include it in your backups.
- The console, stacks and proxy features are off by default (`ALLOW_CONSOLE`, `ALLOW_STACK`, `ALLOW_NGINX` in `.env`).

## Requirements

- A Linux host (or macOS with Docker Desktop) with Docker Engine and Docker Compose v2.
- Host ports 80 and 443 free if you use the integrated proxy.

## Single sign-on

Oblihub supports single sign-on with [Obligate](https://github.com/obli-tools/Obligate): register Oblihub as an app in Obligate, then enter the Obligate URL and API key in the Oblihub settings. Two-factor authentication for SSO users is provided by Obligate.

## Part of the Obli suite

| Tool | Purpose |
|------|---------|
| [Obliance](https://ance.obli.tools) | Remote monitoring and management (RMM) |
| [Oblireach](https://reach.obli.tools) | Remote screen access and remote support |
| [Obliview](https://view.obli.tools) | Uptime and infrastructure monitoring |
| [Oblimap](https://map.obli.tools) | IPAM and network discovery |
| [Obliguard](https://guard.obli.tools) | Agent-based intrusion prevention |
| [Obligate](https://gate.obli.tools) | Single sign-on and access management for the suite |
| **[Oblihub](https://hub.obli.tools)** | Docker control panel |
| [Obliwan](https://github.com/obli-tools/Obliwan) | WAN router fleet management |
| [ObliDesk](https://github.com/obli-tools/ObliDesk) | Ticketing and service desk |
| [Obliplan](https://github.com/obli-tools/Obliplan) | Workforce scheduling and working-time tracking |
| [Oblifield](https://field.obli.tools) | Field intervention management |

Suite home: [obli.tools](https://obli.tools)

## License

Oblihub is source-available under the [Elastic License 2.0](LICENSE) (ELv2). You may use, modify and self-host it, including for commercial use inside your organization; you may not provide it to others as a hosted or managed service. See [LICENSE](LICENSE) for the full terms and the obli.tools clarifications.
