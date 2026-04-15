#!/usr/bin/env nodejs
'use strict';

const path = require('path');

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
    pkgAvailable,
    requireBackend,
    getBackendByPkg,
    installPackages,
};

/** Returns true if an npm package is loadable (installed) */
function pkgAvailable(name)
{
    try { require.resolve(name); return true; }
    catch { return false; }
}

/**
 * Require an optional backend package.
 * On success returns the module, just like require().
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
        return require(pkg);
    }
    catch(e)
    {
        if (e.code !== 'MODULE_NOT_FOUND')
            throw e;

        const backend = getBackendByPkg(pkg);
        const err = new Error(
            `'${pkg}' is required for ${hint || pkg} — run: npm install ${pkg}`
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
 * Install one or more packages into fmeld's own node_modules.
 * Works whether fmeld is installed globally or locally.
 *
 * @param {string[]} pkgs - Package names to install
 */
function installPackages(pkgs)
{
    const { execSync } = require('child_process');
    const pkgRoot = path.join(__dirname, '..');
    execSync(
        `npm install --no-save --prefix "${pkgRoot}" ${pkgs.join(' ')}`,
        { stdio: 'inherit' }
    );
}
