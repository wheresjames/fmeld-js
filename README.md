
# fmeld

Sync files between local drives, ftp, sftp, Google Cloud Storage, Google Drive, and Dropbox


``` bash

    # List files on ftp server
    fmeld -s ftp://user:pass@127.0.0.1:21/test/location ls

    # Use password file instead of command line
    fmeld -S /path/to/password/file -s ftp://user@127.0.0.1/test/location ls

    # Copy files from ftp server to local directory
    fmeld -s ftp://user:pass@127.0.0.1:21/test/location -d file:///tmp/some/path cp

    # Sync files from ftp server to sftp server
    fmeld -s ftp://user:pass@127.0.0.1:21/test/location -d sftp://user@127.0.0.1:22/test/location sync -Ur

    # Sync files from google cloud storage to sftp server
    fmeld -S ./google-credentials.json -s gs://bucket-name/test/location -d sftp://user@127.0.0.1:22/test/location sync -Ur

    # Sync files from google drive to sftp server
    fmeld -S ./google-credentials.json -s gdrive://path/to/files -d sftp://user@127.0.0.1:22/upload/location sync -Ur

    # Sync files from google drive to dropbox
    fmeld -S ./google-credentials.json -s gdrive://path/to/files -E ./dropbox-credentials.json -d dropbox:///upload/location sync -Ur

    # Clean up files from temp that are over one day old
    fmeld -s file:///tmp clean --before "1 day ago" --fnametime "([^/]+)$" --clean-all

```
&nbsp;


---------------------------------------------------------------------
## Table of contents

* [Install](#install)
* [Command Line](#command-line)
* [Examples](#examples)
* [References](#references)

&nbsp;


---------------------------------------------------------------------
## Install

    $ npm install fmeld

&nbsp;


---------------------------------------------------------------------
## Command Line

```
fmeld [options] [ls|cp|sync|md|rm|unlink|clean]

 --- OPTIONS ---

 -s --source       [arg] - Source URL
 -S --source-cred  [arg] - Source Credentials.
                           Can be file / dir / environment variable
 -d --dest         [arg] - Destination URL
 -E --dest-cred    [arg] - Destination Credentials.
                           Can be file / dir / environment variable
 -c --cred-root    [arg] - Credentials root.
                           Can be a directory or environment variable
 -u --uncached     [arg] - Do not use any cached credentials.
 -f --filter-files [arg] - Filter files based on regex expression
 -F --filter-dirs  [arg] - Filter directories based on regex expression
 -r --recursive          - Recurse into sub directories
 -D --download           - Download missing files from destination to source
 -U --upload             - Upload changed or missing files from source to
                           destination
 -G --flatten            - Flatten the directory structure
 -l --less               - Show less console output
 -z --raw-size           - Show raw file size
 -x --retry        [arg] - Number of times to retry
 -k --skip               - Skip files that fail
 -t --timestamp          - Always show timestamp
 -i --detailed           - Show detailed progress info
 -p --authport           - Port used for OAuth, the default is 19227
 -b --batch        [arg] - How many concurrent opererations to allow,
                           The default is 1
    --before       [arg] - Show files before this timestamp
    --after        [arg] - Show files after this timestamp
    --minsize      [arg] - Minimum file size for cleaning
    --maxsize      [arg] - Maximum file size for cleaning
    --fnametime    [arg] - Regex that extracts the file or directory time
                           from the name, Ex: [^/]+$
    --clean-files        - Files will be deleted while cleaning
    --clean-dirs         - Directories will be deleted while cleaning
    --clean-all          - Files and directories will be deleted while
                           cleaning
 -v --version            - Show version
 -V --verbose            - Verbose logging
 -h --help               - Display help

```

&nbsp;


---------------------------------------------------------------------
## Examples


Using from the command line

``` bash

    # List files on ftp server
    fmeld -s ftp://user:pass@127.0.0.1:21/test/location ls

    # Use password file instead of command line
    fmeld -S /path/to/password/file -s ftp://user@127.0.0.1/test/location ls

    # Copy files from ftp server to local directory
    fmeld -s ftp://user:pass@127.0.0.1:21/test/location -d file:///tmp/some/path cp

    # Sync files from sftp server to local directory
    fmeld -s sftp://user:pass@127.0.0.1:21/test/location -d file:///tmp/some/path sync -Dr

    # Sync files from google cloud storage to sftp server
    fmeld -S ./google-credentials.json -s gs://bucket-name/test/location -d sftp://user@127.0.0.1:22/test/location sync -Ur

    # Sync files from google drive to sftp server
    fmeld -S ./google-credentials.json -s gdrive://path/to/files -d sftp://user@127.0.0.1:22/upload/location sync -Ur

    # Sync files from google drive to dropbox
    fmeld -S ./google-credentials.json -s gdrive://path/to/files -E ./dropbox-credentials.json -d dropbox:///upload/location sync -Ur

```


fmeld can also be used as a node.js library.

``` javascript

    const fmeld = require('fmeld');
    const Log = console.log;

    // Connect to ftp server
    let tmpd = null;

    // Connect to ftp
    let ftp = fmeld.getConnection('ftp://guest:guest@192.168.1.250/backup', null, {verbose: true});
    ftp.connect()

        // List files on ftp server
        .then((r) =>
        {
            return ftp.ls('/');
        })

        // Connect to local temporary directory
        .then(r =>
        {
            Log(r);

            tmpd = fmeld.getConnection(`file://${path.join(os.tmpdir(), 'test')}`, null, {verbose: true});
            return tmpd.connect();
        })

        // Sync files from ftp server to local temporary directory
        .then(r =>
        {
            return fmeld.syncDir(ftp, tmpd, ftp.makePath(), tmpd.makePath(),
                                 {recursive: true, upload: true, progress: fmeld.stdoutProgress})
        })

        // Done
        .then(r =>
        {
            Log('Done');
        })

        // Errors
        .catch((e)=>{ Log(e); });

```

&nbsp;


---------------------------------------------------------------------
## References

- Node.js
    - https://nodejs.org/

- npm
    - https://www.npmjs.com/
