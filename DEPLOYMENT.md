# Deployment workflow

The canonical production site is `https://ai.shui.click`. The retired
`https://chat.mijiu.cloud` origin must not serve application JavaScript; the
checked-in Nginx configuration keeps control of it only to return a direct
redirect to the canonical origin. Production deployments are immutable
Git-commit deployments from the private `zdaiwmm/shui-IM` repository. Only
commits contained in `main` are accepted by the server.

WebAuthn credentials, IndexedDB, Service Workers, push subscriptions, and PWA
installations are origin-scoped. A credential created on `chat.mijiu.cloud`
cannot unlock a vault on `ai.shui.click`. Do not weaken this boundary by using
`shui.click` as a parent RP ID, adding permissive CORS, or attempting to copy
vault data through server-side plaintext. A canonical-domain replacement is a
deliberate fresh-origin cutover.

## Normal deployment

1. Work on a feature branch or in a Codex worktree.
2. Open a pull request and wait for the **CI** workflow to pass.
3. Merge the reviewed change into `main`.
4. On a trusted computer with the dedicated production SSH key, update the
   local `main` branch so it matches `origin/main`.
5. Run:

   ```bash
   npm run deploy:production
   ```

6. Review the exact commit shown by the script and type `DEPLOY` to continue.

Before the first release using the traffic gate, separately install the reviewed
Nginx configuration and root-owned deployment helper. Source synchronization
alone does not update either installed file. The helper creates a persistent,
root-owned marker at `/var/lib/quiet-room-deploy/maintenance`, verifies public
`/api/rooms`, a general API path, and `/ws` all return 503, and verifies the exact
health endpoint remains healthy before it stops any container. A missing or
unreadable gate aborts the release before data changes. Keep the marker directory
mode 0755 so Nginx can stat it; it contains no credentials.

The deployment command intentionally requires these environment variables; host,
user, and private-key paths are not embedded in the repository:

```bash
export QUIET_ROOM_SERVER_HOST='your-production-host'
export QUIET_ROOM_SERVER_USER='your-deploy-user'
export QUIET_ROOM_SERVER_KEY='/path/to/production-key'
export QUIET_ROOM_GITHUB_KEY='/path/to/read-only-github-key'
npm run deploy:production
```

## First-time `ai.shui.click` provisioning

The canonical origin must be healthy before installing a deployment helper
that probes it. Perform this one-time infrastructure cutover before the normal
application deployment:

1. Confirm the `ai.shui.click` A record resolves to the production IPv4 address
   and that public TCP ports 80 and 443 are allowed.
2. Inspect the actual Nginx include and enabled-site paths with `nginx -T`.
   Back up the currently loaded site file under
   `/opt/quiet-room/deploy-state/nginx-backups/` before changing it.
3. Install `deploy/nginx-ai.shui.click-bootstrap.conf` as a temporary enabled
   HTTP-only vhost. It may coexist with the old full vhost because it defines no
   shared rate-limit zones. Create the ACME webroot and test it from an external
   network:

   ```bash
   sudo install -d -o root -g root -m 0755 \
     /var/lib/letsencrypt/.well-known/acme-challenge
   sudo nginx -t
   sudo systemctl reload nginx
   ```

4. Issue a separate certificate lineage. Do not expand or overwrite the old
   certificate, because keeping independent lineages makes rollback possible:

   ```bash
   sudo certbot certonly \
     --webroot \
     --webroot-path /var/lib/letsencrypt \
     --cert-name ai.shui.click \
     -d ai.shui.click
   sudo openssl x509 \
     -in /etc/letsencrypt/live/ai.shui.click/fullchain.pem \
     -noout -subject -issuer -dates -ext subjectAltName
   ```

5. In one change, disable the bootstrap and old full site, then enable
   `deploy/nginx-ai.shui.click.conf`. The old and new full configs both define
   the same named rate-limit zones and must never be loaded together. Run
   `nginx -t` before reload; restore the backup without reloading if validation
   fails.
6. Before deploying new application code, verify that the currently running
   image is already reachable through the new reverse proxy:

   ```bash
   curl --fail --silent --show-error \
     --connect-timeout 5 --max-time 10 \
     https://ai.shui.click/api/health
   ```

   Also complete a real WebSocket upgrade with URL
   `wss://ai.shui.click/ws` and `Origin: https://ai.shui.click`.
7. Install the reviewed root-owned `deploy/server/quiet-room-deploy` helper by
   the separate atomic process below, then run the normal application
   deployment. Its pre-cutover probe deliberately refuses downtime if the new
   DNS/TLS/reverse-proxy path is unavailable.
8. After the release, verify certificate renewal without changing live
   certificates:

   ```bash
   sudo certbot renew --dry-run
   sudo systemctl list-timers --all | grep -i certbot
   ```

The final Nginx configuration sends the retired origin to the canonical origin
without serving the old app. Continue controlling the old DNS name and its TLS
certificate so it cannot become a dangling, takeover-prone origin. Do not send
`Clear-Site-Data`; old local vault destruction is unnecessary for the cutover.

GitHub runs the locked dependency install, production build, unit/integration
tests, and browser tests in the **CI** workflow. GitHub has no production SSH
private key and no login or root capability on the Alibaba Cloud server. Passing
CI does not publish automatically.

## Upgrading the root-owned deployment helper

Pushing this repository does not replace `/usr/local/sbin/quiet-room-deploy` on
the production host. When this helper itself changes, install the reviewed file
before using it for the next application cutover; otherwise that first cutover
still runs the old rollback behavior.

Stage the helper from the exact reviewed commit in a private directory owned by
the SSH administrator. Compare its SHA-256 digest with the trusted local copy,
run `bash -n` on the staged file, then use `sudo install` to create a root-owned
temporary file alongside the destination and `sudo mv` it atomically into
place. Finally run `sudo bash -n /usr/local/sbin/quiet-room-deploy` and compare
the installed SHA-256 digest again. The installed file must be owned by
`root:root`, must not be writable by the deploy user, and should remain mode
`0755` (or a stricter executable mode compatible with the sudo policy). Keep
the existing helper untouched until every staging check passes.

Do not make normal application deployments self-update this root-owned helper.
Keeping helper installation as a separate, explicit privileged operation
preserves the current sudo boundary and prevents an unreviewed application
commit from replacing root-executed deployment logic. A future repository
installer would only be appropriate if it pins a commit and digest, stages on
the same filesystem, validates syntax/ownership, and performs an atomic rename;
the normal `deploy:production` command must not become that installer.

The local command connects directly as `admin` with the dedicated
`id_ed25519_shui_im_server` key and invokes the root-owned deployment program.
The server independently verifies that the requested 40-character commit is
contained in `origin/main`, serializes deployments with a file lock, builds an
image before downtime begins, takes a cold ciphertext-data backup, switches the
Compose project, checks local and public health, verifies the public WebSocket
upgrade, and performs a data-aware rollback only while public business traffic
remains gated. The marker is installed before old containers stop; stopping them
closes existing WebSockets before the cold backup. New HTTP business traffic
and WebSocket upgrades receive 503 throughout startup validation. The exact
health endpoint remains available, and an internal WebSocket probe checks the
new application while public traffic is blocked.

A rollback first stops every new project container, preserves possible schema
migrations in a separate `failed-cutover-*.tar.gz` archive, restores the verified
predeploy cold archive, and only then starts the previous image. The gate stays
closed until the restored service and public health route pass checks. Because
no client can receive new message ACKs during this validation window, restoring
the archive does not retract an acknowledged cutover-window message.

After all gated checks pass, the helper disables automatic database rollback
**before** publishing release metadata and opening traffic. The final public WSS
check then runs against the open service. If that check fails, the helper exits
with `POST_OPEN_CHECK_FAILED` and retains the current database; investigate the
route or roll application code forward without restoring an older data snapshot.
Once traffic has opened, new accepted messages must remain in the live database. The paths of both archives are printed
in the deployment log. Before every cold archive or restore, the helper also
fails if any running container still has the named data volume mounted; it does
not assume that stopping only the expected Compose services made the volume
quiescent.

Archive creation and restore are fail-closed. A cold archive is written to a
temporary filename, checked as a readable gzip/tar stream, and atomically moved
into place before the new image is allowed to start. If the new containers
cannot be stopped, failed-cutover data cannot be preserved, the predeploy
archive cannot be restored, or the previous release does not become healthy,
the helper leaves the application stopped and prints `ROLLBACK_FAILED` instead
of starting an old image against uncertain data. Preserve both archive paths
from that output for manual recovery; `ROLLBACK_OK` still exits non-zero with
the original deployment failure so automation cannot mistake a rollback for a
successful release.

The server has a separate, read-only GitHub Deploy Key scoped only to this
repository. It can fetch release source but cannot push to GitHub. Neither that
key nor the local production key is committed to this repository.

## Adding another trusted computer

Do not copy either private key between computers. Generate a new GitHub SSH key
and a new Alibaba Cloud production SSH key on the additional computer, add only
their public keys to the corresponding destinations, and configure the local
repository to use them. Each trusted computer can then run the same command:

```bash
npm run deploy:production
```

Revoking one computer therefore does not affect the others. Remove its GitHub
account key and its public key from the server when the computer is retired or
lost.

## Server layout

```text
/opt/quiet-room/
├── repository.git/          # private bare mirror, owned by deploy
├── git-releases/            # detached immutable worktrees
├── current -> git-releases/…
├── shared/production.env    # production-only settings, never committed
├── deploy-state/            # current commit and deployment time
└── backups/
    ├── predeploy/            # cold backup before each cutover
    └── continuous/           # verified online backup snapshots
```

The existing named volume `quiet-room_quiet-room-data` remains the production
data source. Neither a Git checkout nor an image rebuild contains message data.

The deployment helper prunes only the oldest known Git worktrees
and `data-*.tar.gz` pre-deployment archives after a successful cutover, keeping
five releases and fourteen rollback archives by default. Continuous/off-host
backups and the active `current` release are never touched. Override the
positive-integer retention counts with `QUIET_ROOM_RELEASE_RETENTION_COUNT` or
`QUIET_ROOM_PREDEPLOY_BACKUP_RETENTION_COUNT` in the server environment; keep
at least one rollback point and monitor disk capacity separately.
`failed-cutover-*.tar.gz` archives are deliberately excluded from automatic
retention because they may contain writes accepted during a failed release.
After an operator reconciles or explicitly discards that data, remove the
archive manually under the same change-control process used for production
data deletion.
