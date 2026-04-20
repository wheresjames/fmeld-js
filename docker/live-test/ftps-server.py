#!/usr/bin/env python3
"""Minimal FTPS server using pyftpdlib with explicit TLS."""
import os
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import TLS_FTPHandler
from pyftpdlib.servers import FTPServer

def main():
    root        = os.environ.get('FTP_ROOT',        '/srv/data')
    host        = os.environ.get('FTP_HOST',        '0.0.0.0')
    port        = int(os.environ.get('FTP_PORT',    '2121'))
    user        = os.environ.get('FTP_USER',        'demo')
    password    = os.environ.get('FTP_PASS',        'password')
    certfile    = os.environ.get('FTPS_CERT',       '/certs/ftps.crt')
    keyfile     = os.environ.get('FTPS_KEY',        '/certs/ftps.key')

    authorizer = DummyAuthorizer()
    authorizer.add_user(user, password, root, perm='elradfmwMT')

    handler              = TLS_FTPHandler
    handler.authorizer   = authorizer
    handler.certfile     = certfile
    handler.keyfile      = keyfile
    handler.passive_ports = range(30000, 30010)
    handler.tls_control_required = True
    handler.tls_data_required    = True

    server = FTPServer((host, port), handler)
    server.serve_forever()

if __name__ == '__main__':
    main()
