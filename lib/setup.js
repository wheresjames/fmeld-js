#!/usr/bin/env nodejs
'use strict';

const path = require('path');
const os   = require('os');

/**
 * User-level backend store.  Packages installed via `fmeld setup` land here
 * rather than inside fmeld's own node_modules, so they are never "extraneous"
 * from npm's perspective and `npm install` in the fmeld project stays clean.
 *
 * ~/.fmeld/
 *   package.json          (auto-created, tracks installed backends)
 *   node_modules/         (webdav, @marsaud/smb2, etc.)
 */
const USER_DIR     = path.join(os.homedir(), '.fmeld');
const USER_MODULES = path.join(USER_DIR, 'node_modules');

/**
 * Paths searched when resolving optional backend packages:
 *   1. ~/.fmeld           — user-installed via `fmeld setup`
 *   2. fmeld package root — packages in fmeld's own node_modules (ssh2, ftp, …)
 */
const RESOLVE_PATHS = [USER_DIR, path.join(__dirname, '..')];

/**
 * Registry of all optional backends.
 * Each entry describes one logical backend, the npm packages it needs,
 * its approximate install size, and the URL schemes it handles.
 */
const BACKENDS = [
    {
        key        : 'sftp',
        label      : 'SFTP (SSH)',
        pkgs       : ['ssh2'],
        size       : '~5 MB',
        schemes    : ['sftp:'],
        description: 'SSH File Transfer Protocol'
    },
    {
        key        : 'ftp',
        label      : 'FTP / FTPS',
        pkgs       : ['ftp'],
        size       : '~1 MB',
        schemes    : ['ftp:', 'ftps:'],
        description: 'File Transfer Protocol (plain and TLS)'
    },
    {
        key        : 'webdav',
        label      : 'WebDAV',
        pkgs       : ['webdav'],
        size       : '~2 MB',
        schemes    : ['webdav:', 'webdavs:'],
        description: 'WebDAV servers (Nextcloud, ownCloud, NAS)'
    },
    {
        key        : 'smb',
        label      : 'Windows Network Share',
        pkgs       : ['@marsaud/smb2'],
        size       : '~1 MB',
        schemes    : ['smb:', 'cifs:'],
        description: 'SMB2/CIFS shares (Windows, NAS, Samba)'
    },
    {
        key        : 'gcs',
        label      : 'Google Cloud Storage',
        pkgs       : ['@google-cloud/storage'],
        size       : '~15 MB',
        schemes    : ['gs:', 'gcs:'],
        description: 'Google Cloud Storage buckets'
    },
    {
        key        : 'gdrive',
        label      : 'Google Drive',
        pkgs       : ['googleapis'],
        size       : '~20 MB',
        schemes    : ['gdrive:'],
        description: 'Google Drive files and folders'
    },
    {
        key        : 'dropbox',
        label      : 'Dropbox',
        pkgs       : ['dropbox-v2-api'],
        size       : '~2 MB',
        schemes    : ['dropbox:'],
        description: 'Dropbox cloud storage'
    },
    {
        key        : 's3',
        label      : 'Amazon S3',
        pkgs       : ['@aws-sdk/client-s3', '@aws-sdk/lib-storage'],
        size       : '~30 MB',
        schemes    : ['s3:'],
        description: 'Amazon S3 and S3-compatible storage'
    },
    {
        key        : 'azblob',
        label      : 'Azure Blob Storage',
        pkgs       : ['@azure/storage-blob'],
        size       : '~10 MB',
        schemes    : ['azure:', 'azblob:', 'abs:'],
        description: 'Azure Blob Storage'
    },
    {
        key        : 'onedrive',
        label      : 'OneDrive',
        pkgs       : ['@azure/msal-node'],
        size       : '~5 MB',
        schemes    : ['onedrive:'],
        description: 'Microsoft OneDrive'
    },
    {
        key        : 'box',
        label      : 'Box',
        pkgs       : ['box-node-sdk'],
        size       : '~5 MB',
        schemes    : ['box:'],
        description: 'Box.com cloud storage'
    },
];

module.exports = {
    BACKENDS,
    USER_DIR,
    USER_MODULES,
    pkgAvailable,
    requireBackend,
    getBackendByPkg,
    installPackages,
};

/**
 * Returns true if an npm package is resolvable.
 * Checks ~/.fmeld/node_modules first, then fmeld's own node_modules.
 */
function pkgAvailable(name)
{
    try { require.resolve(name, { paths: RESOLVE_PATHS }); return true; }
    catch { return false; }
}

/**
 * Require an optional backend package.
 * Searches ~/.fmeld/node_modules then fmeld's own node_modules.
 * On failure throws a typed BACKEND_NOT_INSTALLED error that the CLI
 * can catch to offer an interactive install prompt.
 *
 * @param {string} pkg    - npm package name
 * @param {string} hint   - URL scheme or short description for the error message
 */
function requireBackend(pkg, hint)
{
    try
    {
        const resolved = require.resolve(pkg, { paths: RESOLVE_PATHS });
        return require(resolved);
    }
    catch(e)
    {
        if (e.code !== 'MODULE_NOT_FOUND')
            throw e;

        const backend = getBackendByPkg(pkg);
        const err = new Error(
            `'${pkg}' is required for ${hint || pkg} — run: fmeld setup`
        );
        err.code    = 'BACKEND_NOT_INSTALLED';
        err.pkg     = pkg;
        err.hint    = hint || pkg;
        err.allPkgs = backend ? backend.pkgs : [pkg];
        throw err;
    }
}

/** Look up the registry entry for a given package name */
function getBackendByPkg(pkg)
{
    return BACKENDS.find(b => b.pkgs.includes(pkg)) || null;
}

/**
 * Install one or more packages into ~/.fmeld/node_modules.
 *
 * Using ~/.fmeld as the install target means:
 *   - packages are never "extraneous" inside fmeld's own node_modules
 *   - `npm install` in the fmeld project directory stays clean
 *   - backends survive fmeld upgrades/reinstalls
 *   - works identically for global installs and npm link
 *
 * npm_config_* environment variables injected by `npm link` are stripped
 * so that npm uses the cwd as the project root rather than the global prefix.
 *
 * @param {string[]} pkgs - Package names to install
 */
function installPackages(pkgs)
{
    const { execSync } = require('child_process');
    const fs = require('fs');

    // Ensure ~/.fmeld exists and has a package.json so npm is happy
    fs.mkdirSync(USER_DIR, { recursive: true });
    const userPkgJson = path.join(USER_DIR, 'package.json');
    if (!fs.existsSync(userPkgJson))
        fs.writeFileSync(userPkgJson,
            '{"name":"fmeld-backends","version":"1.0.0","description":"fmeld user-installed backends"}\n');

    // Strip npm_config_* vars injected by npm link to prevent the global
    // npm prefix from hijacking the install location.
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('npm_'))
    );

    execSync(`npm install --no-save ${pkgs.join(' ')}`,
        { stdio: 'inherit', cwd: USER_DIR, env });
}
