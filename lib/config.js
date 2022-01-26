#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');

module.exports =
{
    __info__        : getConfig(),
    loadConfig      : loadConfig,
    installPath     : installPath,
    getConfig       : getConfig,
    processFile     : processFile,
    parseParams     : parseParams
};


/** Loads the specified configuration file
    @param [in] fname   - Path to configuration file
*/
function loadConfig(fname)
{   if (!fs.existsSync(fname))
        return {};
    let r = {};
    let data = fs.readFileSync(fname, 'utf8');
    let lines = data.split(/\r\n|\r|\n/);
    lines.forEach(v =>
        {   v = v.trim();
            if ('#' != v[0])
            {   let parts = v.split(/\s+/);
                if (1 < parts.length)
                {   let k = parts.shift().trim().toLowerCase();
                    r[k] = parts.join(' ');
                }
            }
        });
    return r;
}

/** Returns the path of sub in the installation directory
    @param [in] sub     - Subdirectory relative to installation directory
    @return Full path to sub
*/
function installPath(sub)
{
    return path.join(path.dirname(__dirname), sub);
}

/** Returns the module configuration information
    Checks PROJECT.json and PROJECT.txt for configuration information
    @return Module configuration info
*/
function getConfig()
{
    try
    {
        return require(installPath('PROJECT.json'));
    }
    catch(e)
    {
        try
        {
            return loadConfig(installPath('PROJECT.txt'));
        } catch(e) {}
    }
    return {};
}

/** Processes the specified file and replaces variables
    @param [in] cfg             - Configuration to use for replacement
    @param [in] fin             - Input file
    @param [in] fout            - Output file
    @param [in] removeComments  - true if comments should be stripped from file

    Replaces variables in fin in the form of %VARIABLE_NAME% with the value in cfg.
*/
function processFile(cfg, fin, fout, removeComments=true)
{   let data = fs.readFileSync(fin, 'utf8');
    if (removeComments)
        data = data.replace(/[^\n]*\/\/.*\n/g, '').replace(/[^\n]*#.*\n/g, '');
    const rx = /(%.*?%)/g
    for (let m; m = rx.exec(data); m)
        if (0 <= m.index)
        {   let k = m[0].replace(/%/g, '').toLowerCase();
            if (k in cfg)
                data = data.slice(0, m.index) + cfg[k] + data.slice(m.index+m[0].length);
        }
    fs.writeFileSync(fout, data);
}

/**
    @param [in] cmdline     - Command line description
    @param [in] args        - Command line definition
                                Example: [
                                            ['s', 'switch',     'Switch],
                                            ['a', 'argument=',  'Single argument'],
                                            ['m', 'multi=+',    'Multiple args']
                                         ]

    @param [in] allowUnknownOptions - By default, unknown arguments will produce an error,
                                      set this flag to true to allow unknown arguments.

    Parses a unix like command line.

    Any extra arguments are put under the '*' key.

    Example:

        parseParams('program -i inputfile.txt -rf --delete now',
                    [['i', 'input='], ['r', 'reverse'], ['f': 'fix'], ['d': 'delete=']])

        Yields:
        {
            '*'         : ['program']
            'input'     :'inputfile.txt',
            'reverse'   : true,
            'fix'       : true,
            'delete'    : 'now'
        }

    @return Parsed arguments
*/
function parseParams(cmdline, args, opts={}, allowUnknownOptions=false)
{
    // Map options
    let m = {};
    for (let k in opts)
    {
        let r = {multi: false};
        let v = opts[k];

        // Short option
        if (1 <= v.length && v[0])
        {   if (!(v[0] in m))
                r.name = v[0];
            r.short = v[0];
            m[v[0]] = r;
        }

        // Long option
        if (2 <= v.length && v[1])
        {
            let s = v[1].split('=');
            if (1 < s.length)
            {   r.opts = true;
                m[s[0]] = r;
                r.name = s[0];
                if (0 <= s[1].indexOf('+'))
                    r.multi = true;
            }
            else
            {   m[v[1]] = r;
                r.name = s[0]
            }
        }

        // Help message
        if (3 <= v.length && v[2])
            r['help'] = v[2];
    }

    // Add help if it doesn't exist
    let buildHelp = false;
    if (!('h' in m) && !('help' in m))
    {   buildHelp = true;
        m['help'] = {name: 'help', short: 'h', help: 'Display help'};
        m['h'] = m['help'];
    }

    // Parse arguments
    let r = {'*':[]}, ref = null, multi = false;
    for (let k in args)
    {
        let v = args[k];

        // Option?
        if (v[0] == '-')
        {
            // Short option?
            if (v[1] != '-')
                for (let i = 1; i < v.length; i++)
                {
                    if (!(v[i] in m))
                        if (!allowUnknownOptions)
                            throw `Invalid option : ${v[i]} in ${v}`;
                        else
                            m[v[i]] = {name: v[i], short: v[i], opts: true};

                    r[m[v[i]].name] = true;
                    if (m[v[i]].opts)
                    {   ref = m[v[i]].name;
                        multi = m[v[i]].multi;
                    }
                    else
                    {   ref = null;
                        multi = false;
                    }

                }

            // Long option
            else
            {
                // Check for assignment
                let eq = v.indexOf('=');
                if (0 > eq)
                {   let n = v.slice(2);
                    if (!(n in m))
                        if (!allowUnknownOptions)
                            throw `Invalid option: ${n} in ${v}`;
                        else
                            m[n] = {name: n, opts: true};

                    if (m[n].opts)
                    {   ref = m[n].name;
                        multi = m[n].multi;
                    }
                    else
                    {   ref = null;
                        multi = false;
                    }
                    r[m[n].name] = true;
                }
                else
                {
                    let n = v.slice(2, eq);
                    if (!(n in m))
                        if (!allowUnknownOptions)
                            throw `Invalid option: ${n} in ${v}`;
                        else
                            m[n] = {name: n, opts: true};
                    r[m[n].name] = v.slice(eq + 1)
                    ref = null;
                    multi = false;
                }
            }
        }

        // Referenced parameter?
        else if (ref)
        {
            if (!(ref in r))
                r[ref] = v;
            else if(!Array.isArray(r[ref]))
                r[ref] = r[ref] === true ? v : [r[ref], v];
            else
                r[ref].push(v);

            if (!multi)
                ref = null;
        }

        // Catch-all
        else
            r['*'].push(v);
    }

    if (buildHelp && 'help' in r)
        r['help'] = buildHelpMessage(cmdline, m);

    return r;
}

/** Build the help message to display to user from argument map.
    @param [in] cmdline     - Command line string
    @param [in] m           - Argument map
*/
function buildHelpMessage(cmdline, m)
{
    let msg = `\r\n${cmdline}\r\n\r\n --- OPTIONS ---\r\n\r\n`;

    // Padding
    let pad = 0;
    for (let k in m)
    {   let v = m[k];
        m[k].helped = false;
        if (v.name && v.name.length > pad)
            pad = v.name.length;
    }
    pad += 1
    var pstr = new Array(pad).join(' ');

    // Build help string
    for (let k in m)
    {
        let v = m[k];
        if (v.help && !v.helped)
        {   v.helped = true;
            msg += v.short ? `  -${v.short}` : '    ';
            msg += `  --${(v.name + pstr).slice(0, pad)} `;
            msg += v.opts ? (v.multi ? ' [...] ' : ' [arg] ') : '       ';
            msg += `  -  ${v.help}\r\n`;
        }
    }
    return msg + '\r\n';
}

