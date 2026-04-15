import os

from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer


def main():
    root = os.environ.get('FTP_ROOT', '/srv/data')
    host = os.environ.get('FTP_HOST', '0.0.0.0')
    port = int(os.environ.get('FTP_PORT', '2121'))
    user = os.environ.get('FTP_USER', 'demo')
    password = os.environ.get('FTP_PASS', 'password')
    public_host = os.environ.get('FTP_PUBLIC_HOST')

    authorizer = DummyAuthorizer()
    authorizer.add_user(user, password, root, perm='elradfmwMT')

    handler = FTPHandler
    handler.authorizer = authorizer
    handler.passive_ports = range(30000, 30010)
    if public_host:
        handler.masquerade_address = public_host

    server = FTPServer((host, port), handler)
    server.serve_forever()


if __name__ == '__main__':
    main()
