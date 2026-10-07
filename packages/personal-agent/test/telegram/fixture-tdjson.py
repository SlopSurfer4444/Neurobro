"""Exercise the actual Python C-interface sidecar with an in-process fake ABI.

No native library is loaded. The explicit --library file is still hash checked.
"""
import importlib.util
import json
import pathlib
import queue
import sys
import threading

sidecar_path = pathlib.Path(__file__).parents[2] / "tools" / "tdlib_sidecar.py"
spec = importlib.util.spec_from_file_location("tdlib_sidecar", sidecar_path)
sidecar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidecar)

class Function:
    def __init__(self, fn): self.fn = fn
    def __call__(self, *args): return self.fn(*args)

class FakeLibrary:
    def __init__(self):
        self.owner = threading.get_ident()
        self.responses = queue.Queue()
        self.td_create_client_id = Function(lambda: 1)
        self.td_send = Function(self.send)
        self.td_receive = Function(self.receive)
        self.td_execute = Function(self.execute)
    def check(self):
        if threading.get_ident() != self.owner: raise RuntimeError("native thread ownership violated")
    def execute(self, raw):
        self.check()
        assert json.loads(raw)["@type"] == "setLogStream"
        return b'{"@type":"ok"}'
    def send(self, client_id, raw):
        self.check(); assert client_id == 1
        request = json.loads(raw)
        extra = request.get("@extra")
        if request["@type"] == "close":
            self.responses.put(b'{"@client_id":1,"@type":"updateAuthorizationState","authorization_state":{"@type":"authorizationStateClosed"}}')
        elif request["@type"] == "getMessage":
            result = {"@client_id":1,"@type":"message","@extra":extra,"chat_id":request["chat_id"],"id":request["message_id"],"media_album_id":9223372036854775807,"content":{"@type":"messageText","text":{"@type":"formattedText","text":"Привет 😀"}}}
            self.responses.put(json.dumps(result, ensure_ascii=False).encode())
        else:
            self.responses.put(json.dumps({"@client_id":1,"@type":"ok","@extra":extra}).encode())
    def receive(self, timeout):
        self.check()
        try: return self.responses.get(timeout=timeout)
        except queue.Empty: return None

sidecar.ctypes.CDLL = lambda _path: FakeLibrary()
raise SystemExit(sidecar.main())
