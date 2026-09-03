# Deployment workflow

The production site is `https://chat.mijiu.cloud`. Production deployments are
immutable Git-commit deployments from the private `zdaiwmm/shui-IM` repository.
Only commits contained in `main` are accepted by the server.

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

The deployment command intentionally requires these environment variables; host,
user, and private-key paths are not embedded in the repository:

```bash
export QUIET_ROOM_SERVER_HOST='your-production-host'
export QUIET_ROOM_SERVER_USER='your-deploy-user'
export QUIET_ROOM_SERVER_KEY='/path/to/production-key'
export QUIET_ROOM_GITHUB_KEY='/path/to/read-only-github-key'
npm run deploy:production
```

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
upgrade, and performs a data-aware rollback if cutover fails. A rollback first
stops every new project container. Because the new version may already have
migrated SQLite or accepted a write before a later health check fails, the
helper preserves that stopped failed-cutover volume in a separate
`failed-cutover-*.tar.gz` archive, restores the verified predeploy cold archive,
and only then starts the previous image. The paths of both archives are printed
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
