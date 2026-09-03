# Deployment workflow

The production site is `https://chat.mijiu.cloud`. Production deployments are
immutable Git-commit deployments from the private `zdaiwmm/shui-IM` repository.
Only commits contained in `main` are accepted by the server.

## Normal deployment

1. Work on a feature branch or in a Codex worktree.
2. Open a pull request and wait for the **CI** workflow to pass.
3. Merge the reviewed change into `main`.
4. Open **Actions → Deploy production → Run workflow** on GitHub.
5. Select `main`, enter `DEPLOY`, and run the workflow.

The workflow repeats the locked dependency install, production build, and
unit/integration test suite. It then asks the server to deploy the exact commit
that passed. The server independently verifies that the 40-character commit is
contained in `origin/main`, serializes deployments with a file lock, builds an
image before downtime begins, takes a cold ciphertext-data backup, switches the
Compose project, checks local and public health, verifies the public WebSocket
upgrade, and automatically restores the previous image if cutover fails.

The GitHub Actions private key is stored only as the encrypted repository secret
`PRODUCTION_SSH_KEY`. Its matching server key is forced through a wrapper that
accepts only `deploy <commit>`, has no PTY, and cannot forward ports or agents.
The server uses a different, read-only GitHub Deploy Key scoped only to this
repository.

## Current-Mac fallback

The machine used to bootstrap production has separate GitHub and Alibaba Cloud
keys. From a clean, synchronized `main` branch, run:

```bash
npm run deploy:production
```

The script displays the exact commit and requires typing `DEPLOY`. Other
machines should use the GitHub Actions button; do not copy private keys between
home and work computers.

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

