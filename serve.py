"""Serveur statique de dev pour krypty2/web — envoie Cache-Control: no-store (sinon le navigateur
garde les modules ES en cache et les modifs ne sont pas rechargées). Usage : python serve.py 8080"""
import sys, http.server, functools, os
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store"); super().end_headers()
    def log_message(self, *a): pass
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
web = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(H, directory=web)).serve_forever()
