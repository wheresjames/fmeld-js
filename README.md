
# fmeld

Move and sync files between local drives, FTP, FTPS, SFTP, Google Cloud Storage, Google Drive, Dropbox, Amazon S3, Box, Windows network shares, Android devices, and more — from one command line tool or Node.js library.

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
  - [Installing backends](#installing-backends)
  - [List files](#list-files)
  - [Copy files](#copy-files)
  - [Sync files](#sync-files)
  - [Make / remove directories](#make--remove-directories)
  - [Clean old files](#clean-old-files)
  - [Find and remove duplicates](#find-and-remove-duplicates)
- [Using as a library](#using-as-a-library)
- [Testing](#testing)
- [Setting up cloud credentials](#setting-up-cloud-credentials)
  - [Amazon S3](#amazon-s3)
  - [Google Cloud Storage](#google-cloud-storage)
  - [Google Drive](#google-drive)
  - [Dropbox](#dropbox)
  - [WebDAV](#webdav)
  - [Azure Blob Storage](#azure-blob-storage)
  - [OneDrive](#onedrive)
  - [Windows Network Shares (SMB/CIFS)](#windows-network-shares-smbcifs)
  - [Box](#box)
  - [Android Devices (ADB)](#android-devices-adb)
- [Alternatives](#alternatives)

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

FTP and SFTP are included out of the box. Cloud and network backends (S3, GCS, Google Drive, Dropbox, Azure, OneDrive, WebDAV, SMB) are **optional** — run the interactive setup wizard to choose which you need:

```bash
fmeld setup
```

This presents a checkbox menu. Use arrow keys to navigate, space to toggle, and Enter to install. Alternatively, install backends individually:

```bash
npm install -g @aws-sdk/client-s3 @aws-sdk/lib-storage  # S3
npm install -g @google-cloud/storage         # Google Cloud Storage
```

If you try to use a backend whose package isn't installed, fmeld will ask whether to install it on the spot.

&nbsp;

---

## Supported backends

| Backend | URL scheme | Notes |
|---|---|---|
| Local filesystem | `file://` | Standard local paths |
| ZIP archive | `zip://` | Read and write ZIP files as a virtual directory |
| FTP | `ftp://` | Active and passive mode — installed by default |
| FTPS | `ftps://` | FTP over TLS (explicit) — installed by default |
| SFTP | `sftp://` | SSH key or password auth — installed by default |
| Google Cloud Storage | `gs://` or `gcs://` | Service account JSON |
| Google Drive | `gdrive://` | OAuth2, token cached after first login |
| Dropbox | `dropbox://` | OAuth2, token cached after first login |
| Amazon S3 | `s3://` | IAM credentials JSON or environment variables |
| WebDAV | `webdav://` or `webdavs://` | Nextcloud, ownCloud, NAS, and any WebDAV server |
| Azure Blob Storage | `azure://` or `azblob://` | Connection string or account key JSON |
| OneDrive | `onedrive://` | OAuth2, token cached after first login |
| Windows Network Share | `smb://` or `cifs://` | SMB2/CIFS — NAS, Windows shares, Samba |
| Box | `box://` | Box.com cloud storage, JWT app auth or developer token |
| Android Device (ADB) | `adb://` | Android Debug Bridge — USB or TCP/IP connected devices |

&nbsp;

---

## URL format

```
scheme://[user[:password]@]host[:port]/path[?key=value&...]
```

**Examples:**

```
file:///home/user/documents
zip:///home/user/archive.zip
zip:///home/user/archive.zip?password=secret
zip:///home/user/archive.zip?passwordfile=~/.zippass
zip:///home/user/archive.zip?compression=6&method=deflate
ftp://alice:s3cr3t@ftp.example.com:21/uploads
ftps://alice:s3cr3t@ftp.example.com/uploads
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
box:///My Box Folder/subfolder
adb:///sdcard/DCIM/
adb://192.168.1.100:5555/sdcard/
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
| `dupes` | Find duplicate files and interactively review / delete / hardlink them |
| `setup` | Interactively install optional backend packages |

Multiple commands can be chained in a single invocation and will run in sequence.

&nbsp;

---

## Options reference

```
fmeld [options] [ls|cp|sync|md|rm|unlink|clean|dupes]

 --- SOURCE / DESTINATION ---

 -s --source       [arg]  Source URL or local path. Bare paths are automatically
                          treated as file:// — /abs, ./rel, ../rel, and ~/home
                          all work without a scheme prefix. Paths with a recognised
                          file extension are further routed to the matching backend
                          (e.g. archive.zip → zip://).
 -S --source-cred  [arg]  Source credentials: path to a file, directory, or
                          an environment variable name (prefix with $)
 -d --dest         [arg]  Destination URL or local path (same path expansion as --source)
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
    --minsize      [arg]  Minimum file size: bytes or unit string (10MB, 1.5GiB, …)
    --maxsize      [arg]  Maximum file size: bytes or unit string (10MB, 1.5GiB, …)
    --fnametime    [arg]  Regex to extract a timestamp from the file name
                          rather than using filesystem mtime.
                          Example: ([0-9]{4}-[0-9]{2}-[0-9]{2})

 --- CLEAN ---

    --clean-files         Delete files when cleaning (required to actually
                          delete — omitting this lets you do a dry run)
    --clean-dirs          Delete directories when cleaning
    --clean-all           Delete both files and directories

 --- DUPES ---

    --by            [arg]  Duplicate detection mode (default: sha256)
                           name          — same filename (case-insensitive, NFC)
                           name,size     — same filename AND size
                           md5           — MD5 content hash (uses backend metadata
                                          where available: GDrive, GCS)
                           sha1          — SHA-1 content hash
                           sha256        — SHA-256 content hash
    --session       [arg]  Path to a YAML session file. Saves scan results so you
                           can review and apply in separate steps. If the file
                           already exists the scan is skipped and the session is
                           loaded directly.
    --apply                Apply the session non-interactively (requires --session).
                           Blocked if any group is still marked "review" or has a
                           link action without a keep. Groups where every file is
                           "none" are silently skipped.
    --force                With --apply: skip blocked groups instead of failing.
    --keep          [arg]  Pre-populate keep decisions before review or apply:
                           first         — keep the file that appears first in the
                                          scan order
                           newest        — keep the file with the latest mtime
                           oldest        — keep the file with the earliest mtime
                           shortest-path — keep the file with the shortest full path
                           longest-path  — keep the file with the longest full path
                           regex         — keep the first file whose path matches
                                          --keep-pattern
    --keep-pattern  [arg]  Regex used when --keep regex is set.
    --remaining     [arg]  Action for non-kept files when --keep is set:
                           review (default) — leave them for interactive review
                           delete           — mark them for deletion
                           link             — replace them with hardlinks (file://
                                            backend only)
    --force-preset         Re-apply preset even when a group already has decisions
                           from a previously loaded session.
    --include-empty        Include zero-byte files in duplicate detection (they are
                           excluded by default).

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

### Installing backends

Backend packages are optional. The `setup` command presents an interactive checklist — already-installed packages are pre-ticked, missing ones can be selected and installed in one step:

```bash
fmeld setup
```

In a non-interactive environment (CI, Docker) the same command prints the current status of every backend without prompting:

```bash
fmeld setup
# fmeld backends
#
#   sftp       SFTP (SSH)                  installed (default)
#   ftp        FTP                         installed (default)
#   webdav     WebDAV                      webdav (2 MB)
#   smb        Windows Network Share       @marsaud/smb2 (1 MB)
#   ...
```

If you try to use a backend whose package is not installed and a terminal is attached, fmeld prompts automatically:

```
  '@marsaud/smb2' is required for smb://
  Install @marsaud/smb2 now? [y/N]
```

To install a specific backend manually:

```bash
# ZIP archives
npm install -g unzipper archiver archiver-zip-encrypted

# Amazon S3
npm install -g @aws-sdk/client-s3 @aws-sdk/lib-storage

# Google Cloud Storage
npm install -g @google-cloud/storage

# Google Drive
npm install -g googleapis

# Dropbox
npm install -g dropbox-v2-api

# WebDAV
npm install -g webdav

# Azure Blob Storage
npm install -g @azure/storage-blob

# OneDrive
npm install -g @azure/msal-node

# Windows Network Shares (SMB/CIFS)
npm install -g @marsaud/smb2

# Box.com
npm install -g box-node-sdk

# Android devices (ADB)
npm install -g @devicefarmer/adbkit
```

&nbsp;

---

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

### ZIP archives

fmeld treats a ZIP file as a virtual directory. All writes go to a disk staging area; the original archive is never modified in place. On close the archive is rebuilt, verified, and atomically swapped into place.

For large archives, fmeld prints real-time progress to stderr during compression and prints a final success line when done:

```
zip: compressing 1234/5678 files, 234.5 MB written (21%)
zip: saved /home/user/archive.zip (1.2 GB)
```

```bash
# List the contents of a ZIP archive
fmeld -s zip:///home/user/archive.zip ls -r

# Copy a local directory into a new ZIP archive
fmeld -s file:///home/user/photos -d zip:///home/user/photos.zip cp -r

# Extract a ZIP archive to a local directory
fmeld -s zip:///home/user/photos.zip -d file:///tmp/extracted cp -r

# Sync a local directory into an existing ZIP archive (only changed files)
fmeld -s file:///home/user/docs -d zip:///home/user/docs.zip sync -Ur

# Sync files from an Android device into a ZIP archive in the current directory
fmeld -s adb:///sdcard -d zip://$PWD/backup.zip sync -r

# Copy from an SFTP server directly into a local ZIP archive
fmeld -S ~/.sftp-pass -s sftp://user@server.com/exports \
      -d zip:///home/user/exports.zip cp -r

# Create an AES-256 encrypted ZIP from a credential file
fmeld -E ~/.zip-pass -s file:///home/user/sensitive \
      -d zip:///home/user/sensitive.zip cp -r

# Use an inline password (shows in shell history — testing only)
fmeld -s file:///home/user/data \
      -d 'zip:///home/user/data.zip?password=mysecret' cp -r

# Use a compressed ZIP with maximum compression
fmeld -s file:///home/user/logs \
      -d 'zip:///home/user/logs.zip?compression=9' cp -r
```

Staging files are written beside the archive as `<archive>.staging.<token>/`. If the process is interrupted, the original archive is untouched and the staging directory is left on disk with a console warning. Orphan staging directories older than 24 hours are automatically removed on the next run.

&nbsp;

---

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

### Find and remove duplicates

The `dupes` command scans a source for duplicate files and lets you decide what to do with each group — keep one copy, delete the rest, or replace duplicates with hardlinks to save space.

By default `dupes` opens an interactive terminal UI. Use `--session` to save progress between sessions.

**Detection modes** (`--by`):

| Mode | What it compares |
|---|---|
| `sha256` (default) | SHA-256 content hash — most accurate |
| `sha1` | SHA-1 content hash |
| `md5` | MD5 content hash (uses backend metadata on GDrive / GCS) |
| `name` | Filename only (case-insensitive, Unicode-normalized) |
| `name,size` | Filename AND size — faster than hashing |

```bash
# Scan a local directory for duplicates and review interactively
fmeld -s file:///home/user/photos dupes -r

# Use a session file — scan once, resume review later
fmeld -s file:///home/user/photos dupes -r --session ~/photos-dupes.yml

# Resume an existing session (no rescan)
fmeld -s file:///home/user/photos dupes --session ~/photos-dupes.yml

# Detect duplicates by name only (fast, no hashing)
fmeld -s file:///home/user/photos dupes -r --by name

# Pre-mark the newest file in each group as "keep" before reviewing
fmeld -s file:///home/user/photos dupes -r --keep newest

# Auto-delete all non-kept files without interactive review
fmeld -s file:///home/user/photos dupes -r \
      --keep newest --remaining delete \
      --session ~/photos-dupes.yml --apply

# Keep whichever copy lives under /archive/, delete the rest
fmeld -s file:///home/user/photos dupes -r \
      --keep regex --keep-pattern '/archive/' \
      --remaining delete --session ~/photos-dupes.yml --apply

# Replace duplicates with hardlinks (saves disk space, local filesystem only)
fmeld -s file:///home/user/photos dupes -r \
      --keep newest --remaining link \
      --session ~/photos-dupes.yml --apply

# Skip groups that still need a decision instead of failing (non-interactive)
fmeld -s file:///home/user/photos dupes \
      --session ~/photos-dupes.yml --apply --force
```

**Interactive UI key bindings:**

| Key | Action |
|---|---|
| `↑` / `↓` | Move between files in a group |
| `←` / `→` | Move between duplicate groups |
| `k` | Mark current file as **keep** |
| `d` | Mark current file as **delete** |
| `l` | Mark current file as **link** (hardlink, local only) |
| `r` | Mark current file as **review** (clear decision) |
| `n` | Mark current file as **none** (no action) |
| `s` | Save session to current file |
| `S` | Save session to a new file (prompts for path) |
| `a` | Apply decisions (shows confirmation screen first) |
| `R` | Rescan source and carry forward existing decisions |
| `A` | **Abort** — discard all staged changes and restore the source to its original state (only shown for backends that support staged writes, e.g. `zip://`) |
| `q` | Quit |

Applied and skipped groups are highlighted in the UI: the group title and a banner line are colored (green for applied, yellow for skipped, red for failed), all file rows are dimmed, and a progress bar at the bottom shows the status of every group at a glance. Each bar segment is colored by the state of the groups it covers — green (applied), yellow (skipped), red (failed), or dim (pending) — so you can immediately see where unresolved groups are. Your current position is marked with a bold block in the bar.

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
fmeld.findDuplicates(src, from, opts)           // Scan for duplicate files; returns Promise<sessionData>
fmeld.dupeSession                               // Session helpers: loadSession, saveSession, applyPreset,
                                                //   validateGroup, applySession, carryForward
fmeld.dupeUI                                    // Interactive terminal review UI: runInteractive(state)
fmeld.stdoutProgress(args, opts)                // Built-in progress reporter
fmeld.toHuman(bytes)                            // Format bytes as "1.23 MB" etc.

// Low-level client constructors (if you want to instantiate directly)
fmeld.fakeClient(args, opts)       // In-memory fake tree — useful for testing
fmeld.fileClient(args, opts)
fmeld.zipClient(args, opts)
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
fmeld.boxClient(args, opts)
fmeld.adbClient(args, opts)

// Backend registry and optional-dependency helpers
fmeld.setup.BACKENDS               // Array of backend descriptors (key, label, pkgs, size, schemes)
fmeld.setup.pkgAvailable(name)     // Returns true if an npm package is installed
fmeld.setup.requireBackend(pkg, hint)  // require() with a typed BACKEND_NOT_INSTALLED error
fmeld.setup.getBackendByPkg(pkg)   // Look up a backend descriptor by package name
fmeld.setup.installPackages(pkgs)  // Install packages into fmeld's node_modules
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

### Box

fmeld connects to Box.com using the `box-node-sdk` package and supports two credential modes:

**Option 1 — JWT app config** (recommended for production)

1. Go to the [Box Developer Console](https://app.box.com/developers/console) and create a new app with **Server Authentication (JWT)**.
2. Generate an RSA key pair and download the app config JSON.
3. Approve the app in your Box Admin Console.

```bash
fmeld -S ./box-app-config.json -s box:///My Folder ls
```

**Option 2 — Developer token** (quick testing only — expires after 60 minutes)

```json
{
    "client_id":     "your-client-id",
    "client_secret": "your-client-secret",
    "token":         "your-developer-token"
}
```

```bash
fmeld -S ./box-dev-token.json -s box:///My Folder ls
fmeld -S ./box-dev-token.json -s file:///home/user/docs -d box:///Documents sync -Ur
```

The URL path is the folder tree within Box. The root maps to the top of the authenticated account.

&nbsp;

---

### Android Devices (ADB)

fmeld talks to Android devices via the Android Debug Bridge using the `@devicefarmer/adbkit` package. No credentials file is required — ADB handles its own device authorization via the on-device prompt.

**Prerequisites:**
- Install [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools) (provides the `adb` binary)
- Enable **Developer options** and **USB debugging** on the device
- For TCP/IP connections, run `adb tcpip 5555` on the device first

**URL formats:**
```
adb:///sdcard/DCIM/              — first available (USB or already-connected TCP/IP) device
adb://SERIALNUMBER/sdcard/       — specific device by USB serial number
adb://192.168.1.100:5555/sdcard/ — TCP/IP connected device
```

The serial number of connected devices can be found with `adb devices`.

**Examples:**
```bash
# List files on the first connected Android device
fmeld -s adb:///sdcard/DCIM/ ls

# Copy photos from a specific device to local
fmeld -s adb://R58M123ABCD/sdcard/DCIM/Camera -d file:///home/user/photos cp -r

# Sync from a TCP/IP connected device
fmeld -s adb://192.168.1.100:5555/sdcard/Documents \
      -d file:///home/user/android-docs sync -Dr

# Upload files to the device
fmeld -s file:///home/user/music -d adb:///sdcard/Music cp -r
```

&nbsp;

---

## Testing

The test suite uses the built-in [`node:test`](https://nodejs.org/api/test.html) runner (Node 18+):

```bash
node --test test/test.js
```

Tests cover `toHuman`, `promiseWhile`/`promiseWhileBatch`, `parseParams`, `getConnection` protocol dispatch (including bare-path expansion and extension-based routing), all client constructors, `copyDir`, `syncDir`, `cleanDir`, `loadConfig`, and the `dupes` command (`normalizeFileName`, `findDuplicates`, `applyPreset`, `validateGroup`, `carryForward`, session save/load round-trips, and `applySession` including delete, hardlink, all-none auto-skip, and force-skip). The `zip://` backend is covered including writes, deletes, directory operations, orphan cleanup, and `abort()`. Filesystem tests create and clean up their own temporary directories under `os.tmpdir()`.

For a Docker-based live smoke test against real protocol servers, run:

```bash
docker compose -f docker/live-test/docker-compose.yml up --build --abort-on-container-exit --exit-code-from runner
```

That stack exercises `ftp`, `sftp`, `webdav`, `smb`, `s3` (via MinIO), and `azblob` (via Azurite). Details live in `docker/live-test/README.md`.

&nbsp;

---

## License

MIT — see [LICENSE](LICENSE)

## Alternatives

| Project | Language / Runtime | Type | Backends | License | Maturity |
|---|---|---|---|---|---|
| **[rclone](https://github.com/rclone/rclone)** | Go (static binary) | CLI + HTTP API | ~70+ | MIT | Very high — 10+ years, widely deployed |
| **[Cyberduck / duck](https://github.com/iterate-ch/cyberduck)** | Java | GUI + CLI | ~30 | GPL v3 | High — 20+ years |
| **[lftp](https://github.com/lavv17/lftp)** | C++ | CLI | ~10 | GPL v3 | High — 25+ years |
| **[Flysystem](https://github.com/thephpleague/flysystem)** | PHP | Library | ~15 (via adapters) | MIT | High — 10+ years |
| **[Apache Commons VFS](https://commons.apache.org/proper/commons-vfs/)** | Java | Library | ~15 | Apache 2.0 | High — 20+ years |
| **fmeld** | Node.js | CLI + Library | 15 | MIT | Early-stage |

&nbsp;

### rclone

rclone is the most widely used tool in this category. It supports more backends than any other project listed here and has a large community, extensive documentation, and years of production use. It ships as a single static binary with no runtime dependency. Choose rclone when you need the broadest backend coverage, are working in a polyglot or shell-scripting environment, or need a tool you can drop onto any machine without installing a runtime.

### Cyberduck / duck

Cyberduck is primarily a desktop GUI application for macOS and Windows; `duck` is its companion CLI. It covers a wide range of cloud and server backends and is well-suited to interactive use. The GUI provides visual browsing, bookmarks, and drag-and-drop transfers. Choose Cyberduck if your primary workflow is interactive file management rather than scripted or automated transfers, or if your team prefers a GUI tool.

### lftp

lftp is a mature, Unix-native command-line client focused on FTP, FTPS, SFTP, HTTP, and HTTPS. It supports parallel transfers, mirroring, complex scripting via its built-in command language, and resumable downloads. It does not cover cloud object storage (S3, GCS, etc.). Choose lftp when your transfers are FTP/SFTP-centric, you need fine-grained control over connection behaviour, or you require a lightweight dependency on traditional Unix systems.

### Flysystem

Flysystem is a PHP filesystem abstraction library. It provides a uniform API across local, FTP, SFTP, S3, Azure, GCS, and other storage backends via community adapters. It is a library only — there is no CLI. Choose Flysystem when building PHP applications that need to read and write files across multiple storage providers without coupling your code to a specific backend.

### Apache Commons VFS

Apache Commons VFS is a Java library that exposes a virtual filesystem API over FTP, SFTP, HTTP, HTTPS, SMB, local, and compressed archives. It is tightly integrated with the Java ecosystem and is often used inside larger Apache projects. There is no CLI. Choose Commons VFS when building Java applications that need a standard, well-tested abstraction for accessing remote filesystems, particularly in environments that already use Apache libraries.

### fmeld

fmeld is a Node.js package that exposes both a CLI and a programmatic library API. It covers common cloud and server backends, installs optional backends on demand, and is designed to be embedded directly in Node.js applications. Choose fmeld when you are building a Node.js application that needs to transfer or sync files across multiple storage backends from within the same process, without shelling out to an external binary.

&nbsp;

---

## Links

- GitHub: https://github.com/wheresjames/fmeld-js
- Issues: https://github.com/wheresjames/fmeld-js/issues
- npm: https://www.npmjs.com/package/fmeld
