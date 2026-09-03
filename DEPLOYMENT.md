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

GitHub runs the locked dependency install, production build, unit/integration
tests, and browser tests in the **CI** workflow. GitHub has no production SSH
private key and no login or root capability on the Alibaba Cloud server. Passing
CI does not publish automatically.

The local command connects directly as `admin` with the dedicated
`id_ed25519_shui_im_server` key and invokes the root-owned deployment program.
The server independently verifies that the requested 40-character commit is
contained in `origin/main`, serializes deployments with a file lock, builds an
image before downtime begins, takes a cold ciphertext-data backup, switches the
Compose project, checks local and public health, verifies the public WebSocket
upgrade, and automatically restores the previous image if cutover fails.

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

No automatic pruning is performed for Git releases, images, or pre-deployment
backups. Review disk usage periodically and remove old material only after a
verified recovery point exists.
