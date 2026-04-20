# Live Docker smoke tests

This stack runs `fmeld` against real protocol servers inside Docker and verifies every
backend end-to-end.

## Covered backends

| Backend | Service |
|---|---|
| `ftp://` | pyftpdlib |
| `ftps://` | pyftpdlib with explicit TLS |
| `sftp://` | OpenSSH sshd |
| `webdav://` | rclone serve webdav |
| `webdavs://` | rclone serve webdav with TLS |
| `smb://` | Samba |
| `s3://` | MinIO |
| `azblob://` | Azurite |
| `gcs://` | fsouza/fake-gcs-server |
| `zip://` | local filesystem (no Docker service) |

## Run

From the repo root:

```bash
npm run smoketest
```

Or directly:

```bash
node run-smoketests.js
```

A Markdown and JSON report are written to `reports/` on every run.

To clean up containers, images, and volumes:

```bash
npm run smoketest:cleanup
```

## What the runner does

1. Waits for all protocol services to accept connections
2. Seeds MinIO, Azurite, and the GCS emulator with the fixture tree
3. For each backend:
   - `ls -r` on the seeded tree
   - Download seed to `file://` and verify every file byte-for-byte (including `binary.bin`)
   - Upload a local tree via `sync -U`
   - Round-trip download and verify byte-for-byte
   - Cross-backend copy (`binary.bin` → `file://`, byte-exact check)
   - `unlink` one file, verify it is gone and neighbours remain
   - `rm` the uploaded directory, verify removal
   - Sync delta: push v1 fixture tree, then v2 (v1 + `sync-added.txt`); verify all v1 files persist and `sync-added.txt` was added
   - Duplicate detection: upload 4 files (3 identical), run `dupes --apply`, verify exactly one duplicate survives
4. Cross-backend copy: `ftp://` → `webdav://` without a local intermediate
5. `zip://` local smoke: upload fixture tree into a new archive, list it, extract and verify, unlink a file, rm a subtree

## Fixture trees

The fixture tree lives at `docker/live-test/fixtures/share/`:

```
root.txt                           text
has space.txt                      text (filename with a space)
binary.bin                         256 bytes: byte[i] = i (tests binary round-trips)
nested/child.txt                   text
nested/deeper/value.json           text
```

**v2** (used for sync delta tests) is the fixture tree plus `sync-added.txt`, constructed at runtime.

## TLS certificates

Self-signed certificates for FTPS and WebDAVS are committed at `docker/live-test/certs/`:

- `ftps.crt` / `ftps.key` — served by the FTPS container (CN=ftps, SAN=DNS:ftps)
- `webdavs.crt` / `webdavs.key` — served by the WebDAVS container (CN=webdavs, SAN=DNS:webdavs)
- `test-ca-bundle.crt` — PEM bundle of both certs; set as `NODE_EXTRA_CA_CERTS` in the runner image

The Node.js ftp and webdav clients trust the test certs at the OS level inside the runner container. TLS certificate verification is not disabled in fmeld itself.

## GCS emulator credential

`docker/live-test/certs/gcs-test.json` is a fake service-account JSON with a generated
RSA key. It has no association with any real GCS project. The runner sets
`STORAGE_EMULATOR_HOST=http://gcs:4443` so all `@google-cloud/storage` requests are
routed to `fsouza/fake-gcs-server`.

## Notes

- MinIO uses a custom S3 endpoint; tests use `s3://...?endpoint=...&force-path-style=true`.
- The runner image installs optional peer deps: `webdav`, `@aws-sdk/*`, `@azure/storage-blob`, `@marsaud/smb2`, `@google-cloud/storage`, `unzipper`, `archiver`.
- `NODE_OPTIONS=--openssl-legacy-provider` is set so the SMB stack works under Node 20 / OpenSSL 3.
- The Samba service enables legacy NTLM/LANMAN auth for compatibility with `@marsaud/smb2`.
- `fake-gcs-server` is started with `-scheme http` (no TLS) since the runner communicates with it over the internal Docker network.
