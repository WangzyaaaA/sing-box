import importlib.util
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "src" / "audit" / "server.py"
SPEC = importlib.util.spec_from_file_location("audit_server", SERVER_PATH)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def connection(connection_id="conn-1", upload=10, download=20, source_ip="198.51.100.10"):
    return {
        "id": connection_id,
        "start": "2026-08-26T01:00:00Z",
        "upload": upload,
        "download": download,
        "chains": ["direct"],
        "rule": "final",
        "metadata": {
            "network": "tcp",
            "type": "vless",
            "inbound": "vless-in",
            "sourceIP": source_ip,
            "sourcePort": 41000,
            "destinationIP": "203.0.113.20",
            "destinationPort": 443,
            "host": "example.com",
            "user": "demo-user",
        },
    }


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = audit.AuditStore(os.path.join(self.temp.name, "audit.db"), 90)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_capture_persists_deltas_and_closes_connections(self):
        with mock.patch.object(audit.time, "time", return_value=1000):
            self.store.capture({"uploadTotal": 100, "downloadTotal": 200, "connections": [connection()]})
        with mock.patch.object(audit.time, "time", return_value=1002):
            self.store.capture({"uploadTotal": 130, "downloadTotal": 260, "connections": [connection(upload=40, download=80)]})
        # A lower total means the sing-box process restarted; the new counters
        # are added instead of producing a negative delta.
        with mock.patch.object(audit.time, "time", return_value=1004):
            self.store.capture({"uploadTotal": 5, "downloadTotal": 10, "connections": []})
            summary = self.store.summary("1h")
            records = self.store.connections({"range": ["1h"]})

        self.assertEqual(summary["upload"], 35)
        self.assertEqual(summary["download"], 70)
        self.assertEqual(records["total"], 1)
        self.assertEqual(records["items"][0]["status"], "closed")
        self.assertEqual(records["items"][0]["upload"], 40)
        self.assertEqual(records["items"][0]["host"], "example.com")

    def test_filters_and_export_rows(self):
        with mock.patch.object(audit.time, "time", return_value=2000):
            self.store.capture({"uploadTotal": 0, "downloadTotal": 0, "connections": [connection()]})
            result = self.store.connections({"range": ["1h"], "search": ["demo-user"], "protocol": ["vless"]})
            missing = self.store.connections({"range": ["1h"], "search": ["does-not-exist"]})
        self.assertEqual(result["total"], 1)
        self.assertEqual(missing["total"], 0)

    def test_database_and_counter_baseline_survive_service_restart(self):
        with mock.patch.object(audit.time, "time", return_value=3000):
            self.store.capture({"uploadTotal": 100, "downloadTotal": 200, "connections": [connection()]})
        self.store.close()
        self.store = audit.AuditStore(os.path.join(self.temp.name, "audit.db"), 90)
        with mock.patch.object(audit.time, "time", return_value=3002):
            self.store.capture({"uploadTotal": 125, "downloadTotal": 250, "connections": [connection(upload=35, download=70)]})
            summary = self.store.summary("1h")
            records = self.store.connections({"range": ["1h"]})
        self.assertEqual(summary["upload"], 25)
        self.assertEqual(summary["download"], 50)
        self.assertEqual(records["items"][0]["upload"], 35)

    def test_client_usage_is_grouped_by_ip_identity_and_time_window(self):
        with mock.patch.object(audit.time, "time", return_value=4020):
            self.store.capture({"uploadTotal": 100, "downloadTotal": 200, "connections": [connection()]})
        with mock.patch.object(audit.time, "time", return_value=4082):
            self.store.capture({"uploadTotal": 130, "downloadTotal": 260, "connections": [connection(upload=40, download=80)]})
        with mock.patch.object(audit.time, "time", return_value=4143):
            self.store.capture({
                "uploadTotal": 135,
                "downloadTotal": 266,
                "connections": [
                    connection(upload=40, download=80),
                    connection("conn-2", upload=5, download=6),
                ],
            })
            first_window = self.store.client_usage({"range": ["24h"], "start": ["4082"], "end": ["4082"]})
            full_window = self.store.client_usage({"range": ["24h"], "start": ["4082"], "end": ["4143"]})

        self.assertEqual(first_window["items"][0]["upload"], 30)
        self.assertEqual(first_window["items"][0]["download"], 60)
        self.assertEqual(full_window["items"][0]["upload"], 35)
        self.assertEqual(full_window["items"][0]["download"], 66)
        self.assertEqual(full_window["items"][0]["connections"], 2)
        self.assertEqual(full_window["items"][0]["source_ip"], "198.51.100.10")

    def test_config_resolver_maps_inbound_to_file_and_uuid(self):
        config_dir = Path(self.temp.name) / "conf"
        config_dir.mkdir()
        config_name = "vless-443.json"
        config_dir.joinpath(config_name).write_text(json.dumps({
            "inbounds": [{
                "tag": config_name,
                "type": "vless",
                "users": [{"uuid": "11111111-1111-4111-8111-111111111111"}],
            }],
        }), encoding="utf-8")
        resolver = audit.ConfigIdentityResolver(str(config_dir))
        item = connection()
        item["metadata"].pop("inbound")
        item["metadata"].pop("user")
        item["metadata"]["type"] = "vless/" + config_name

        with mock.patch.object(audit.time, "time", return_value=5000):
            self.store.capture({"uploadTotal": 0, "downloadTotal": 0, "connections": [item]}, resolver)
            records = self.store.connections({"range": ["1h"]})

        self.assertEqual(records["items"][0]["config_name"], config_name)
        self.assertEqual(records["items"][0]["user"], "11111111-1111-4111-8111-111111111111")
        self.assertEqual(records["items"][0]["protocol"], "vless")

    def test_config_resolver_never_uses_password_as_identity(self):
        config_dir = Path(self.temp.name) / "conf-password"
        config_dir.mkdir()
        config_name = "trojan-443.json"
        config_dir.joinpath(config_name).write_text(json.dumps({
            "inbounds": [{"tag": config_name, "type": "trojan", "users": [{"password": "synthetic-secret"}]}],
        }), encoding="utf-8")
        resolver = audit.ConfigIdentityResolver(str(config_dir))

        resolved_config, resolved_user = resolver.resolve(config_name, "")

        self.assertEqual(resolved_config, config_name)
        self.assertEqual(resolved_user, "")

    def test_existing_database_is_migrated_without_losing_connections(self):
        self.store.close()
        database = os.path.join(self.temp.name, "legacy.db")
        db = sqlite3.connect(database)
        db.execute("CREATE TABLE connections (id TEXT PRIMARY KEY, start_time INTEGER NOT NULL, end_time INTEGER, "
                   "last_seen INTEGER NOT NULL, status TEXT NOT NULL, network TEXT NOT NULL DEFAULT '', "
                   "inbound TEXT NOT NULL DEFAULT '', inbound_type TEXT NOT NULL DEFAULT '', source_ip TEXT NOT NULL DEFAULT '', "
                   "source_port INTEGER NOT NULL DEFAULT 0, destination TEXT NOT NULL DEFAULT '', destination_ip TEXT NOT NULL DEFAULT '', "
                   "destination_port INTEGER NOT NULL DEFAULT 0, host TEXT NOT NULL DEFAULT '', user TEXT NOT NULL DEFAULT '', "
                   "protocol TEXT NOT NULL DEFAULT '', process TEXT NOT NULL DEFAULT '', outbound TEXT NOT NULL DEFAULT '', "
                   "chains TEXT NOT NULL DEFAULT '[]', rule TEXT NOT NULL DEFAULT '', upload INTEGER NOT NULL DEFAULT 0, "
                   "download INTEGER NOT NULL DEFAULT 0)")
        db.execute("INSERT INTO connections (id, start_time, last_seen, status) VALUES ('legacy', 1, 2, 'closed')")
        db.commit()
        db.close()

        self.store = audit.AuditStore(database, 90)
        columns = {row[1] for row in self.store.db.execute("PRAGMA table_info(connections)")}
        self.assertIn("config_name", columns)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM connections").fetchone()[0], 1)


class FakeClashHandler(BaseHTTPRequestHandler):
    snapshot = {"uploadTotal": 100, "downloadTotal": 200, "connections": [connection()]}

    def do_GET(self):
        if self.path != "/connections":
            self.send_error(404)
            return
        body = json.dumps(self.snapshot).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


class HttpIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clash = HTTPServer(("127.0.0.1", 0), FakeClashHandler)
        self.clash_thread = threading.Thread(target=self.clash.serve_forever, daemon=True)
        self.clash_thread.start()
        config = {
            "listen": "127.0.0.1",
            "port": 0,
            "database": os.path.join(self.temp.name, "audit.db"),
            "collector_url": "http://127.0.0.1:{}".format(self.clash.server_address[1]),
            "collector_secret": "source-secret",
            "web_token": "test-web-token-123456",
            "poll_interval": 1,
            "retention_days": 90,
            "web_root": str(ROOT / "src" / "audit" / "web"),
        }
        self.server = audit.build_server(config)
        self.server.collector.start()
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.base = "http://127.0.0.1:{}".format(self.server.server_address[1])
        deadline = time.time() + 3
        while time.time() < deadline and not self.server.collector.status()["connected"]:
            time.sleep(0.05)

    def tearDown(self):
        self.server.shutdown()
        self.server.collector.stop()
        self.server.server_close()
        self.server.store.close()
        self.clash.shutdown()
        self.clash.server_close()
        self.temp.cleanup()

    def request(self, path, token=None):
        headers = {"Authorization": "Bearer " + token} if token else {}
        return urlopen(Request(self.base + path, headers=headers), timeout=2)

    def test_health_auth_dashboard_and_export(self):
        with self.request("/api/health") as response:
            self.assertTrue(json.load(response)["ok"])
        with self.assertRaises(HTTPError) as denied:
            self.request("/api/summary")
        self.assertEqual(denied.exception.code, 401)
        denied.exception.close()
        with self.request("/api/summary", "test-web-token-123456") as response:
            payload = json.load(response)
            self.assertEqual(payload["active_connections"], 1)
            self.assertTrue(payload["collector"]["connected"])
        with self.request("/api/export?format=csv&range=24h", "test-web-token-123456") as response:
            body = response.read().decode("utf-8-sig")
            self.assertIn("example.com", body)
            self.assertIn("text/csv", response.headers["Content-Type"])
        with self.request("/api/export?format=json&range=24h", "test-web-token-123456") as response:
            exported = json.load(response)
            self.assertEqual(exported[0]["host"], "example.com")
        with self.request("/") as response:
            page = response.read().decode("utf-8")
            self.assertIn("连接审计记录", page)
            self.assertIn("IP / 配置流量", page)

    def test_usage_api_custom_range_and_export(self):
        self.server.collector.stop()
        captured_at = int(time.time())
        with mock.patch.object(audit.time, "time", return_value=captured_at):
            self.server.store.capture({
                "uploadTotal": 130,
                "downloadTotal": 260,
                "connections": [connection(upload=40, download=80)],
            })
        query = "?start={}&end={}".format(captured_at - 1, captured_at + 1)
        with self.request("/api/client-usage" + query, "test-web-token-123456") as response:
            payload = json.load(response)
            self.assertEqual(payload["items"][0]["source_ip"], "198.51.100.10")
            self.assertEqual(payload["items"][0]["total"], 90)
            self.assertEqual(payload["bucket_seconds"], 60)
        with self.request("/api/usage-export" + query + "&format=csv", "test-web-token-123456") as response:
            body = response.read().decode("utf-8-sig")
            self.assertIn("source_ip,config_name,user", body)
            self.assertIn("198.51.100.10", body)
        with self.assertRaises(HTTPError) as invalid:
            self.request("/api/client-usage?start=invalid&end=10", "test-web-token-123456")
        self.assertEqual(invalid.exception.code, 400)
        invalid.exception.close()


if __name__ == "__main__":
    unittest.main()
