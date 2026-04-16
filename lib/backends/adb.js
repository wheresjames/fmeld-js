#!/usr/bin/env nodejs
'use strict';

const path = require('path');
var Log = console.log;

/** adbClient()

    Provides Android Debug Bridge (ADB) functionality

    https://www.npmjs.com/package/@devicefarmer/adbkit

    URL formats:
        adb:///sdcard/DCIM/         - first available device
        adb://SERIAL/sdcard/DCIM/   - device by USB serial number
        adb://192.168.1.100:5555/sdcard/  - TCP/IP connected device
*/
module.exports = function adbClient(args, opts)
{
    const _adbmod = require('../setup.js').requireBackend('@devicefarmer/adbkit', 'adb://');
    const adb = _adbmod.default || _adbmod;

    this.args = args;
    this.opts = opts;

    if (!args.path)
        args.path = '/';

    // serial: host:port for TCP/IP, bare host for USB serial, null = first device
    let serial = args.host || null;
    if (serial && args.port)
        serial = `${serial}:${args.port}`;

    args.prefix = serial ? `adb://${serial}` : 'adb://';

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    let client = null;
    let device = null;
    let bConnected = false;

    /// Returns true if connected
    function isConnected()
    {
        return bConnected;
    }

    /** Returns the path prefix
        @param [in] p   - Optional path to append to prefix
    */
    function getPrefix(p=null)
    {
        return (p && p.length) ? (args.prefix + ('/' == p[0] ? '' : '/') + p) : args.prefix;
    }

    /** Returns the path portion from the url
        @param [in] a   - Optional path to append
    */
    function makePath(a=null)
    {
        return a ? path.posix.join(args.path, a) : args.path;
    }

    /// Connects to the ADB device
    function connect()
    {
        return new Promise((resolve, reject) =>
        {
            close().then(() =>
            {
                if (opts.verbose)
                    Log(`Connecting to ADB : ${args.prefix}`);

                client = adb.createClient();

                // For TCP/IP devices, initiate the adb connect handshake
                let connectProm = (args.host && args.port)
                    ? client.connect(args.host, parseInt(args.port))
                    : Promise.resolve(null);

                connectProm
                    .then(() => client.listDevices())
                    .then(devices =>
                    {
                        if (!devices || !devices.length)
                            return reject('No ADB devices found');

                        if (serial)
                        {
                            let found = devices.find(d => d.id === serial);
                            if (!found)
                                return reject(`ADB device not found: ${serial}`);
                            if ('offline' === found.type)
                                return reject(`ADB device offline: ${serial}`);
                        }
                        else
                        {
                            // Pick the first online device
                            let online = devices.filter(d => d.type !== 'offline');
                            if (!online.length)
                                return reject('No online ADB devices found');
                            serial = online[0].id;
                            args.prefix = `adb://${serial}`;
                        }

                        bConnected = true;
                        device = client.getDevice(serial);
                        if (opts.verbose)
                            Log(`Connected to ADB device: ${serial}`);
                        return resolve(true);
                    })
                    .catch(e => { close().then(() => reject(e)); });
            });
        });
    }

    /// Disconnects from the ADB device
    function close()
    {
        return new Promise((resolve) =>
        {
            bConnected = false;
            client = null;
            device = null;
            return resolve(true);
        });
    }

    /// Runs a shell command on the device and returns the output string
    function shell(cmd)
    {
        if (!device)
            return Promise.reject('No connection');
        return device.shell(cmd)
            .then(stream => new Promise((resolve, reject) =>
            {
                let out = '';
                stream.on('data', d => { out += d.toString(); });
                stream.on('end', () => resolve(out.trim()));
                stream.on('error', reject);
            }));
    }

    /** Returns a list of the directory contents
        @param [in] dir     - Directory to list
    */
    function ls(dir)
    {
        if (!device)
            return Promise.reject('No connection');
        return device.readdir(String(dir))
            .then(entries =>
            {
                return entries.map(e =>
                {
                    let isDir = (e.mode & 0x4000) ? true : false;
                    return {
                        name:   e.name,
                        path:   dir,
                        full:   path.posix.join(String(dir), e.name),
                        isDir:  isDir,
                        isFile: !isDir,
                        mode:   e.mode  || 0,
                        size:   e.size  || 0,
                        atime:  e.mtime || 0,
                        mtime:  e.mtime || 0,
                        ctime:  e.mtime || 0
                    };
                });
            });
    }

    /** Creates the specified directory
        @param [in] dir     - Directory to create
        @param [in] o       - Options
                                recursive   : Create subdirectories as well
    */
    function mkDir(dir, o={})
    {
        if (!bConnected)
            return Promise.reject('No connection');
        let cmd = o.recursive ? `mkdir -p "${dir}"` : `mkdir "${dir}"`;
        return shell(cmd).then(() => true);
    }

    /** Deletes the specified file
        @param [in] file    - File to delete
    */
    function rmFile(file)
    {
        if (!bConnected)
            return Promise.reject('No connection');
        return shell(`rm "${file}"`).then(() => true);
    }

    /** Deletes the specified directory
        @param [in] dir     - Directory to delete
        @param [in] o       - Options
                                recursive   : Remove all contents as well
                                force       : Force operation
    */
    function rmDir(dir, o={})
    {
        if (!bConnected)
            return Promise.reject('No connection');
        let cmd = (o.recursive || o.force) ? `rm -rf "${dir}"` : `rmdir "${dir}"`;
        return shell(cmd).then(() => true);
    }

    /** Creates a read stream for the specified file
        @param [in] file    - File to read
    */
    function createReadStream(file, o={})
    {
        if (!device)
            return Promise.reject('No connection');
        return device.pull(file);
    }

    /** Creates a write stream for the specified file
        @param [in] file    - File to write
    */
    function createWriteStream(file, o={})
    {
        if (!device)
            return Promise.reject('No connection');

        const { PassThrough } = require('stream');
        const pass = new PassThrough();
        const transfer = device.push(pass, file, 0o644);

        // Track transfer completion for finalize()
        let transferDone  = false;
        let transferError = null;
        let waiters       = [];

        transfer
            .then(t =>
            {
                t.on('end', () =>
                {
                    transferDone = true;
                    waiters.forEach(w => w.resolve(true));
                    waiters = [];
                });
                t.on('error', e =>
                {
                    transferError = e;
                    waiters.forEach(w => w.reject(e));
                    waiters = [];
                });
            })
            .catch(e =>
            {
                transferError = e;
                waiters.forEach(w => w.reject(e));
                waiters = [];
            });

        // pumpStream calls finalize() after writing ends to ensure
        // the push transfer has fully committed to the device
        pass.finalize = () => new Promise((resolve, reject) =>
        {
            if (transferDone)  return resolve(true);
            if (transferError) return reject(transferError);
            waiters.push({ resolve, reject });
        });

        return Promise.resolve(pass);
    }

    // Export functions
    this.connect          = connect;
    this.close            = close;
    this.ls               = ls;
    this.getPrefix        = getPrefix;
    this.mkDir            = mkDir;
    this.rmFile           = rmFile;
    this.rmDir            = rmDir;
    this.makePath         = makePath;
    this.isConnected      = isConnected;
    this.createReadStream = createReadStream;
    this.createWriteStream = createWriteStream;
}
