# Live Docker smoke tests

This stack runs `fmeld` against real protocol servers inside Docker and verifies recursive list/copy/sync flows end-to-end.

## Covered backends

- `ftp://` via `pyftpdlib`
- `sftp://` via OpenSSH `sshd`
- `webdav://` via `rclone serve webdav`
- `smb://` via Samba
- `s3://` via MinIO
- `azblob://` via Azurite

It intentionally does **not** try to emulate `gcs://`, `gdrive://`, `dropbox://`, `onedrive://`, or `box://`, because those either need vendor APIs or would require fmeld-specific emulator support.

## Run

From the repo root:

```bash
docker compose -f docker/live-test/docker-compose.yml up --build --abort-on-container-exit --exit-code-from runner
```

## What the runner does

- waits for all protocol services to accept connections
- seeds MinIO and Azurite with fixture files
- runs `fmeld ls -r` against each backend
- downloads each backend recursively to a local `file://` directory
- uploads a fresh local tree back to each backend using `cp` or `sync -U`
- downloads that uploaded tree again and asserts the files survived the round trip

## Notes

- MinIO uses a custom S3 endpoint, so the live tests rely on `s3://...?...&force-path-style=true`.
- The runner image installs optional peer deps needed for `webdav`, `s3`, `azblob`, and `smb`.
- The runner sets `NODE_OPTIONS=--openssl-legacy-provider` so the current SMB stack works under Node 20/OpenSSL 3.
- The Samba service enables legacy NTLM/LANMAN auth only for local test compatibility with `@marsaud/smb2`.
