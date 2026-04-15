
# fmeld

Move and sync files between local drives, FTP, SFTP, Google Cloud Storage, Google Drive, Dropbox, Amazon S3, Windows network shares, and more — from one command line tool or Node.js library.

```bash
# Copy a local folder up to an FTP server
fmeld -s file:///home/user/photos -d ftp://user:pass@myserver.com/photos cp -r

# Sync a Google Drive folder down to an SFTP server
fmeld -S ./gdrive-creds.json -s gdrive://backups \
      -d sftp://user@myserver.com/backups sync -Ur

# Clean up temp files older than one day
fmeld -s file:///tmp clean --before "1 day ago" --clean-all
```

&nbsp;

---

## Table of contents

- [Install](#install)
- [Supported backends](#supported-backends)
- [URL format](#url-format)
- [Credentials](#credentials)
- [Commands](#commands)
- [Options reference](#options-reference)
- [Examples](#examples)
  - [List files](#list-files)
  - [Copy files](#copy-files)
  - [Sync files](#sync-files)
  - [Make / remove directories](#make--remove-directories)
  - [Clean old files](#clean-old-files)
- [Using as a library](#using-as-a-library)
- [Testing](#testing)
- [Setting up cloud credentials](#setting-up-cloud-credentials)
  - [Amazon S3](#amazon-s3)
  - [Google Cloud Storage](#google-cloud-storage)
  - [Google Drive](#google-drive)
  - [Dropbox](#dropbox)
  - [Windows Network Shares (SMB/CIFS)](#windows-network-shares-smbcifs)

&nbsp;

---

## Install

```bash
npm install -g fmeld
```

Or install locally into your project:

```bash
npm install fmeld
```

&nbsp;

---

## Supported backends

| Backend | URL scheme | Notes |
|---|---|---|
| Local filesystem | `file://` | Standard local paths |
| FTP | `ftp://` | Active and passive mode |
| SFTP | `sftp://` | SSH key or password auth |
| Google Cloud Storage | `gs://` or `gcs://` | Service account JSON |
| Google Drive | `gdrive://` | OAuth2, token cached after first login |
| Dropbox | `dropbox://` | OAuth2, token cached after first login |
| Amazon S3 | `s3://` | IAM credentials JSON or environment variables |
| WebDAV | `webdav://` or `webdavs://` | Nextcloud, ownCloud, NAS, and any WebDAV server |
| Azure Blob Storage | `azure://` or `azblob://` | Connection string or account key JSON |
| OneDrive | `onedrive://` | OAuth2, token cached after first login |
| Windows Network Share | `smb://` or `cifs://` | SMB2/CIFS — NAS, Windows shares, Samba |

&nbsp;

---

## URL format

```
scheme://[user[:password]@]host[:port]/path[?key=value&...]
```

**Examples:**

```
file:///home/user/documents
ftp://alice:s3cr3t@ftp.example.com:21/uploads
sftp://alice@sftp.example.com:22/backups
gs://my-bucket/some/prefix
gdrive://My Drive/project-files
dropbox:///camera-uploads
s3://my-bucket/some/prefix
s3://my-bucket/path?region=eu-west-1
webdav://alice:pass@nas.local/remote.php/dav/files/alice/documents
webdavs://alice:pass@nas.local:8443/remote.php/dav/files/alice/photos
azure://my-container/some/prefix
onedrive://Documents/project-files
smb://user:pass@server/sharename
smb://DOMAIN;user:pass@server/sharename/path/to/dir
cifs://user:pass@nas.local/backups/archive
```

Query string parameters are passed through as extra options to the backend driver.

&nbsp;

---

## Credentials

Credentials can be supplied in three ways:

**1. In the URL** (convenient, but passwords appear in shell history)
```bash
fmeld -s ftp://user:pass@host/path ls
```

**2. From a file** — pass the path to a plain-text password file with `-S` / `-E`
```bash
fmeld -S /run/secrets/ftp-password -s ftp://user@host/path ls
```

**3. From a credential root directory** — fmeld searches the directory for a file whose name matches the target hostname
```bash
fmeld -c /etc/fmeld/creds -s sftp://myserver.com/backups ls
# looks for /etc/fmeld/creds/myserver.com (or similar match)
```

The credential root path can also be an environment variable name:
```bash
fmeld -c '$MY_CRED_DIR' -s sftp://myserver.com/backups ls
```

For cloud services (Google Drive, Dropbox, GCS), `-S` / `-E` should point to the downloaded JSON credentials file from the respective developer console. OAuth tokens are cached next to the credentials file (`.token.json` suffix) so you only need to log in once.

&nbsp;

---

## Commands

| Command | Description |
|---|---|
| `ls` | List files and directories at the source |
| `cp` | Copy files from source to destination |
| `sync` | Sync source to destination (only transfer what changed) |
| `md` | Create a directory at the source path |
| `rm` | Remove a directory at the source path |
| `unlink` | Remove a single file at the source path |
| `clean` | Delete files matching age / size / name filters |

Multiple commands can be chained in a single invocation and will run in sequence.

&nbsp;

---

## Options reference

```
fmeld [options] [ls|cp|sync|md|rm|unlink|clean]

 --- SOURCE / DESTINATION ---

 -s --source       [arg]  Source URL
 -S --source-cred  [arg]  Source credentials: path to a file, directory, or
                          an environment variable name (prefix with $)
 -d --dest         [arg]  Destination URL
 -E --dest-cred    [arg]  Destination credentials (same formats as --source-cred)
 -c --cred-root    [arg]  Shared credentials root directory or env variable.
                          fmeld searches here for a file matching the hostname.

 --- TRANSFER BEHAVIOUR ---

 -r --recursive           Recurse into sub-directories
 -U --upload              (sync) Upload changed or missing files to destination
 -D --download            (sync) Download files missing from destination back
                          to source. Changed files are not downloaded; swap
                          source and destination if you need that.
 -G --flatten             Flatten the directory tree into the destination root
 -k --skip                Skip individual files that fail instead of aborting
 -x --retry        [arg]  Number of times to retry on failure (default: 1)
 -b --batch        [arg]  Max concurrent operations (default: 1)

 --- FILTERING ---

 -f --filter-files [arg]  Keep only files whose names match this regex
 -F --filter-dirs  [arg]  Keep only directories whose names match this regex
    --before       [arg]  Only match files modified before this time
                          Accepts natural language: "1 day ago", "last Friday"
    --after        [arg]  Only match files modified after this time
    --minsize      [arg]  Minimum file size in bytes (clean command)
    --maxsize      [arg]  Maximum file size in bytes (clean command)
    --fnametime    [arg]  Regex to extract a timestamp from the file name
                          rather than using filesystem mtime.
                          Example: ([0-9]{4}-[0-9]{2}-[0-9]{2})

 --- CLEAN ---

    --clean-files         Delete files when cleaning (required to actually
                          delete — omitting this lets you do a dry run)
    --clean-dirs          Delete directories when cleaning
    --clean-all           Delete both files and directories

 --- OUTPUT ---

 -l --less                Show less console output
 -z --raw-size            Show raw byte count instead of human-readable sizes
 -t --timestamp           Always prefix output lines with a timestamp
 -i --detailed            Show per-file transfer speed and ETA

 --- AUTH ---

 -p --authport     [arg]  Local port for OAuth redirect (default: 19227)
 -u --uncached     [arg]  Ignore cached OAuth tokens, force re-authentication

 --- MISC ---

 -v --version             Show version
 -V --verbose             Verbose logging
 -h --help                Show this help text
```

&nbsp;

---

## Examples

### List files

```bash
# List files on an FTP server
fmeld -s ftp://user:pass@myserver.com/uploads ls

# List recursively with human-readable sizes
fmeld -s sftp://user@myserver.com/data ls -r

# List a Google Cloud Storage bucket
fmeld -S ./gcs-credentials.json -s gs://my-bucket/reports ls

# List an S3 bucket
fmeld -S ./s3-credentials.json -s s3://my-bucket/reports ls

# List an S3 bucket using environment variables for credentials
fmeld -s s3://my-bucket/reports ls
```

### Copy files

```bash
# Copy a local directory to an FTP server
fmeld -s file:///home/user/photos -d ftp://user:pass@myserver.com/photos cp -r

# Copy from FTP to a local directory
fmeld -s ftp://user:pass@myserver.com/photos -d file:///tmp/photos cp -r

# Copy from SFTP to local, using a password file
fmeld -S /run/secrets/sftp-pass -s sftp://user@myserver.com/data \
      -d file:///home/user/data cp -r

# Copy and flatten all files into one directory (no sub-folders)
fmeld -s sftp://user@myserver.com/archive -d file:///tmp/flat cp -rG
```

### Sync files

`sync` is like `cp` but only transfers files that are missing or have changed (comparing size and modification time). Use `-U` to push changes up, `-D` to pull changes down, or both together to mirror.

```bash
# Upload new or changed files from local to SFTP
fmeld -s file:///home/user/site \
      -d sftp://user@myserver.com/www sync -Ur

# Pull any files missing locally from SFTP (but don't overwrite changed ones)
fmeld -s sftp://user@myserver.com/www \
      -d file:///home/user/site sync -Dr

# Two-way mirror between Google Drive and SFTP
fmeld -S ./gdrive-creds.json \
      -s gdrive://My Drive/project \
      -d sftp://user@myserver.com/project sync -UDr

# Sync Google Drive to Dropbox, 4 files at a time
fmeld -S ./gdrive-creds.json  -s gdrive://backups \
      -E ./dropbox-creds.json -d dropbox:///backups sync -Ur -b 4

# Sync a local directory up to S3
fmeld -S ./s3-creds.json -s file:///home/user/backups \
      -d s3://my-bucket/backups sync -Ur

# Sync from S3 to a local directory
fmeld -S ./s3-creds.json -s s3://my-bucket/backups \
      -d file:///home/user/backups sync -Dr

# Sync only .log files
fmeld -s sftp://user@myserver.com/logs \
      -d file:///var/logs/remote sync -Ur --filter-files '\.log$'
```

### Make / remove directories

```bash
# Create a directory on an SFTP server
fmeld -s sftp://user@myserver.com/new-folder md

# Remove a directory from Google Drive
fmeld -S ./gdrive-creds.json -s gdrive://old-folder rm

# Delete a single file from Dropbox
fmeld -E ./dropbox-creds.json -s dropbox:///notes/draft.txt unlink
```

### Clean old files

The `clean` command deletes files that match your filters. By default it just reports what it *would* delete — you must add `--clean-files`, `--clean-dirs`, or `--clean-all` to actually remove anything.

```bash
# Dry run: show what would be deleted from /tmp that is older than 1 day
fmeld -s file:///tmp clean --before "1 day ago"

# Actually delete those files
fmeld -s file:///tmp clean --before "1 day ago" --clean-files

# Delete entire directories older than 7 days
fmeld -s file:///var/archive clean --before "7 days ago" --clean-dirs

# Delete files and directories, recursing into sub-directories
fmeld -s sftp://user@myserver.com/tmp clean --before "1 week ago" --clean-all -r

# Delete log files larger than 100 MB
fmeld -s file:///var/log clean --minsize 104857600 --clean-files --filter-files '\.log$'

# Use a timestamp embedded in the file name instead of filesystem mtime
# This regex captures a date like "2024-01-31" from names like "backup-2024-01-31.tar.gz"
fmeld -s file:///backups clean \
      --before "30 days ago" \
      --fnametime '(\d{4}-\d{2}-\d{2})' \
      --clean-files
```

&nbsp;

---

## Using as a library

fmeld exports all of its connection types and helper functions so you can use them directly in your own Node.js code.

```javascript
const path = require('path');
const os   = require('os');
const fmeld = require('fmeld');

async function example()
{
    // Create connection objects
    const ftp  = fmeld.getConnection('ftp://guest:guest@192.168.1.10/data', null, {verbose: true});
    const local = fmeld.getConnection(`file://${path.join(os.tmpdir(), 'data')}`, null, {});

    // Connect both
    await Promise.all([ftp.connect(), local.connect()]);

    // List remote files
    const files = await ftp.ls('/');
    console.log(files);

    // Sync remote -> local (upload any missing or changed files)
    await fmeld.syncDir(ftp, local, ftp.makePath(), local.makePath(),
    {
        recursive : true,
        upload    : true,
        progress  : fmeld.stdoutProgress
    });

    // Clean up
    await Promise.all([ftp.close(), local.close()]);
    console.log('Done');
}

example().catch(console.error);
```

### Available exports

```javascript
const fmeld = require('fmeld');

fmeld.getConnection(url, credFile, opts)  // Create a backend client from a URL
fmeld.copyFile(src, dst, from, to, size, opts)  // Copy a single file
fmeld.copyDir(src, dst, from, to, opts)         // Copy a directory
fmeld.syncDir(src, dst, from, to, opts)         // Sync two directories
fmeld.cleanDir(src, from, opts)                 // Clean a directory
fmeld.stdoutProgress(args, opts)                // Built-in progress reporter
fmeld.toHuman(bytes)                            // Format bytes as "1.23 MB" etc.

// Low-level client constructors (if you want to instantiate directly)
fmeld.fakeClient(args, opts)       // In-memory fake tree — useful for testing
fmeld.fileClient(args, opts)
fmeld.ftpClient(args, opts)
fmeld.sftpClient(args, opts)
fmeld.gcsClient(args, opts)
fmeld.gdriveClient(args, opts)
fmeld.dropboxClient(args, opts)
fmeld.s3Client(args, opts)
fmeld.webdavClient(args, opts)
fmeld.azblobClient(args, opts)
fmeld.onedriveClient(args, opts)
fmeld.smbClient(args, opts)
```

All client objects expose the same interface:

```javascript
client.connect()                  // Returns Promise
client.close()                    // Returns Promise
client.ls(path)                   // Returns Promise<FileList>
client.mkDir(path, opts)          // Returns Promise
client.rmFile(path)               // Returns Promise
client.rmDir(path, opts)          // Returns Promise
client.createReadStream(path)     // Returns Promise<ReadableStream>
client.createWriteStream(path)    // Returns Promise<WritableStream>
client.makePath(suffix)           // Returns the full path string
client.getPrefix(suffix)          // Returns the URL prefix string
client.isConnected()              // Returns boolean
```

&nbsp;

---

## Setting up cloud credentials

### Amazon S3

fmeld can authenticate with S3 in two ways:

**Option 1 — Credentials JSON file** (recommended for explicit control)

Create a JSON file with your IAM access key:

```json
{
    "access_key_id":     "AKIAIOSFODNN7EXAMPLE",
    "secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "region":            "us-east-1"
}
```

Pass the file with `-S` (source) or `-E` (destination):

```bash
fmeld -S ./s3-creds.json -s s3://my-bucket/backups ls
fmeld -S ./s3-creds.json -s file:///home/user/data -d s3://my-bucket/data cp -r
```

**Option 2 — Environment variables** (no credential file needed)

Set the standard AWS environment variables and omit `-S` / `-E`:

```bash
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
export AWS_DEFAULT_REGION=us-east-1
fmeld -s s3://my-bucket/backups ls
```

The AWS SDK also honours `~/.aws/credentials` and IAM instance roles automatically.

**Specifying the region or a custom endpoint via the URL**

```bash
# Override region in the URL query string
fmeld -S ./s3-creds.json -s 's3://my-bucket/data?region=eu-west-1' ls

# Use an S3-compatible service (MinIO, Wasabi, Cloudflare R2, …)
fmeld -S ./s3-creds.json -s 's3://my-bucket/data?endpoint=https://s3.example.com' ls
```

To generate IAM credentials, go to the [AWS IAM Console](https://console.aws.amazon.com/iam/), create a user with `AmazonS3FullAccess` (or a least-privilege policy), and create an access key under **Security credentials**.

&nbsp;

---

### Google Cloud Storage

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. Enable the **Cloud Storage API**.
3. Create a **Service Account**, then download its JSON key file.
4. Pass the key file with `-S` (source) or `-E` (destination):

```bash
fmeld -S ./service-account.json -s gs://my-bucket/path ls
```

### Google Drive

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. Enable the **Google Drive API**.
3. Create an **OAuth 2.0 Client ID** (Desktop application type) and download the JSON file.
4. On the first run, fmeld will print a URL — open it in your browser to authorize access. The resulting token is saved alongside the credentials file and reused automatically on future runs.

```bash
fmeld -S ./gdrive-oauth-client.json -s gdrive://My\ Drive/backups ls
```

To force re-authentication (e.g. after revoking access):
```bash
fmeld -S ./gdrive-oauth-client.json -u 1 -s gdrive://My\ Drive/backups ls
```

### Dropbox

1. Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps) and create an app.
2. Set the redirect URI to `http://localhost:19227` (or your chosen `--authport`).
3. Download or create a JSON credentials file with at least these fields:
```json
{
    "client_id": "your-app-key",
    "client_secret": "your-app-secret",
    "redirect_uris": ["http://localhost:19227"]
}
```
4. On the first run, fmeld will print a URL to authorize. The token is then cached for future runs.

```bash
fmeld -E ./dropbox-creds.json -d dropbox:///uploads ls
```

&nbsp;

---

### WebDAV

Pass credentials directly in the URL or via a plain-text password file (`-S` / `-E`):

```bash
# HTTP WebDAV with user/pass in URL
fmeld -s 'webdav://alice:s3cr3t@nas.local/remote.php/dav/files/alice/docs' ls

# HTTPS WebDAV using a password file
fmeld -S ./webdav-pass.txt -s webdavs://alice@nextcloud.example.com/remote.php/dav/files/alice/docs ls

# Sync local to Nextcloud
fmeld -S ./webdav-pass.txt \
      -s file:///home/alice/documents \
      -d webdavs://alice@nextcloud.example.com/remote.php/dav/files/alice/documents \
      sync -Ur
```

The password file should contain only the password on a single line.

&nbsp;

---

### Azure Blob Storage

Create a JSON credentials file — pick one of these formats:

**Option 1 — Connection string** (easiest, found in the Azure Portal under your storage account → Access keys):
```json
{
    "connection_string": "DefaultEndpointsProtocol=https;AccountName=mystorageaccount;AccountKey=base64key==;EndpointSuffix=core.windows.net"
}
```

**Option 2 — Account name + key:**
```json
{
    "account_name": "mystorageaccount",
    "account_key":  "base64encodedkey=="
}
```

**Option 3 — SAS token:**
```json
{
    "account_name": "mystorageaccount",
    "sas_token":    "sv=2021-06-08&ss=b&srt=co&sp=rwdlacuptfx&..."
}
```

Without a credentials file, fmeld reads `AZURE_STORAGE_CONNECTION_STRING` from the environment.

The URL hostname is the **container name**; the path is an optional blob prefix:

```bash
fmeld -S ./azure-creds.json -s azure://my-container/backups ls
fmeld -S ./azure-creds.json -s file:///home/user/data -d azure://my-container/data cp -r
fmeld -S ./azure-creds.json -s azure://my-container/data -d file:///home/user/data sync -Dr
```

&nbsp;

---

### OneDrive

1. Go to [Azure App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps) and create a new registration.
2. Set the redirect URI to `http://localhost:19227` (Web type, or your chosen `--authport`).
3. Under **Certificates & secrets**, create a new client secret and copy the value.
4. Under **API permissions**, add **Microsoft Graph → Files.ReadWrite** (Delegated), then grant admin consent.
5. Create a JSON credentials file:
```json
{
    "client_id":     "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "client_secret": "your-client-secret-value",
    "tenant_id":     "common"
}
```

On the first run, fmeld will print an authorization URL. After you log in and grant access, the token is cached alongside the credentials file (`.token.json`) for future runs.

```bash
fmeld -S ./onedrive-creds.json -s onedrive://Documents/backups ls
fmeld -S ./onedrive-creds.json -s file:///home/user/docs -d onedrive://Documents/docs sync -Ur
```

To force re-authentication:
```bash
fmeld -S ./onedrive-creds.json -u 1 -s onedrive://Documents/backups ls
```

&nbsp;

---

### Windows Network Shares (SMB/CIFS)

fmeld connects to SMB2/CIFS shares (Windows file shares, NAS devices, Samba servers) using the `@marsaud/smb2` package — no native binaries or `smbclient` install required.

**URL format:**
```
smb://[domain;]user:pass@server/sharename[/sub/path]
cifs://[domain;]user:pass@server/sharename[/sub/path]
```

The first path component after the hostname is always the **share name**. Any remaining path is the subdirectory within the share.

**Examples:**
```bash
# List a share
fmeld -s smb://alice:s3cr3t@nas.local/documents ls

# Sync local → share
fmeld -s file:///home/alice/docs -d smb://alice:s3cr3t@nas.local/documents sync -Ur

# Include a Windows domain (two equivalent forms)
fmeld -s 'smb://CORP;alice:s3cr3t@fileserver.corp.local/shared/reports' ls
fmeld -s 'smb://alice:s3cr3t@fileserver.corp.local/shared/reports?domain=CORP' ls

# Use a password file instead of embedding credentials in the URL
fmeld -S /run/secrets/smb-pass -s smb://alice@nas.local/backups ls

# Copy from a Windows share to local
fmeld -s smb://alice:s3cr3t@winserver/myshare/exports \
      -d file:///home/alice/exports cp -r
```

The password file (passed with `-S` / `-E`) should contain only the password on a single line.

SMB port 445 is used by default. To use a non-standard port, append it to the hostname:
```bash
fmeld -s smb://alice:s3cr3t@nas.local:4450/share ls
```

&nbsp;


---

## Testing

The test suite uses the built-in [`node:test`](https://nodejs.org/api/test.html) runner (Node 18+):

```bash
node --test test/test.js
```

Tests cover `toHuman`, `promiseWhile`/`promiseWhileBatch`, `parseParams`, `getConnection` protocol dispatch, all client constructors, `copyDir`, `syncDir`, `cleanDir`, and `loadConfig`. Filesystem tests create and clean up their own temporary directories under `os.tmpdir()`.

&nbsp;

---

## License

MIT — see [LICENSE](LICENSE)

## Links

- GitHub: https://github.com/wheresjames/fmeld-js
- Issues: https://github.com/wheresjames/fmeld-js/issues
- npm: https://www.npmjs.com/package/fmeld
