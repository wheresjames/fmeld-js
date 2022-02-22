
# fmeld

Sync files between local drive, ftp, sftp, google cloud storage, google drive


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
fmeld [options] [commands ...]

 --- OPTIONS ---

  -s  --source         [arg]   -  Source URL
  -S  --source-cred    [arg]   -  Source Credentials.  Can be file / dir / environment variable
  -d  --dest           [arg]   -  Destination URL
  -E  --dest-cred      [arg]   -  Destination Credentials.  Can be file / dir / environment variable
  -c  --cred-root      [arg]   -  Credentials root.  Can be a directory or environment variable
  -u  --uncached       [arg]   -  Do not use any cached credentials.
  -f  --filter-files   [arg]   -  Filter files based on regex expression
  -F  --filter-dirs    [arg]   -  Filter directories based on regex expression
  -r  --recursive              -  Recurse into sub directories
  -D  --download               -  Download missing files from destination to source
  -U  --upload                 -  Upload changed or missing files from source to destination
  -G  --flatten                -  Flatten the directory structure
  -l  --less                   -  Show less console output
  -z  --raw-size               -  Show raw file size
  -x  --retry          [arg]   -  Number of times to retry
  -k  --skip                   -  Skip files that fail
  -t  --timestamp              -  Always show timestamp
  -i  --detailed               -  Show detailed progress info
  -v  --version                -  Show version
  -V  --verbose                -  Verbose logging
  -h  --help                   -  Display help

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

```


fmeld can also be used as a node.js library.

``` javascript

    const fmeld = require('fmeld');
    const Log = console.log;

    // Connect to ftp server
    let ftp = fmeld.getConnection('ftp://192.168.1.250/some/directory', null, {verbose: true});
    ftp.connect().then((r) => {

            // Show directory
            (async() => {
                    await ftp.ls('/')
                                .then((r)=>{ Log(r); })
                                .catch((e)=>{ Log(e); });
                });

            // Sync files to local temp directory
            let tmpd = fmeld.getConnection(`file://${path.join(os.tmpdir(), 'test')}`, null, {verbose: true});
            (async() => {
                    await fmeld.syncDir(ftp, tmpd, ftp.makePath(), tmpd.makePath(), {recursive: true}, fmeld.stdoutProgress)
                                .then((r) => { Log(`Done: ${r}`); })
                                .catch((e)=>{ Log(e); });
                })();

        })
        .catch((e)=>{ Log(e); });

```

&nbsp;


---------------------------------------------------------------------
## References

- Node.js
    - https://nodejs.org/

- npm
    - https://www.npmjs.com/
