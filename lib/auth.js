#!/usr/bin/env nodejs
'use strict';

const url = require('url');
const http = require('http');
var Log = console.log;

module.exports = {getAuthCode};

function getAuthCode(port)
{
    return new Promise((resolve, reject) =>
    {
        let server = null, rl = null;

        function createRl()
        {   try
            {   const readline = require('readline');
                rl = readline.createInterface({input: process.stdin, output: process.stdout});
                rl.question('\r\nEnter code here: ', (code) =>
                {   rl.close();
                    if (server)
                        server.close();
                    return resolve({code});
                });
            }
            catch(e) { rl = null; Log(e); }
        }

        try
        {
            const http = require("http");
            server = http.createServer((req, res) =>
            {
                try
                {
                    let q = url.parse(req.url, true);
                    if (!q.query)
                        q.query = {};

                    res.writeHead(200);
                    res.end(`It is ok to close this page.\r\n\r\n${JSON.stringify(q.query)}`);

                    if (rl)
                        rl.close();

                    server.close();

                    return resolve({...q.query});
                }
                catch(e) { reject(e); }
            }).listen(port, '127.0.0.1', () =>
            {   Log(`Listening on http://localhost:${port}`);
                createRl();
            });
        }
        catch(e) { server = null; Log(e); }

        if (!server)
            createRl();

        if (!server && !rl)
            return reject('Failed to create input method');
    });
}


