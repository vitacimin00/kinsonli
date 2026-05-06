"""
Self-hosted TempMail server.

Local usage:
    python tempmail_server.py

Production shape:
    - Point MX for kinsonli.site to this server.
    - Run SMTP on port 25, HTTP behind a reverse proxy or on port 8080.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import secrets
import sqlite3
import threading
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parseaddr
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


APP_DIR = Path(__file__).resolve().parent
DB_PATH = APP_DIR / "tempmail.db"
DOMAINS_PATH = APP_DIR / "tempmail_domains.json"
DEFAULT_DOMAIN = ""
MAX_BULK_EMAILS = 10
MESSAGE_TTL_HOURS = 24
ALLOWED_STATIC_FILES = {"index.html", "styles.css", "app.js", "favicon.ico"}
CLEANUP_INTERVAL_SECONDS = 3600
API_NAME_MIN_LEN = 13
API_NAME_MAX_LEN = 15
ENGLISH_NAT_CODES = "us,gb,au,ca,ie,nz"
FAKER_API_URLS = [
    "https://fakerapi.it/api/v2/persons",
    "https://fakerapi.it/api/v1/persons",
]
FAKER_INDONESIA_LOCALE = "id_ID"
API_TIMEOUT = 15

CODE_PATTERNS = [
    re.compile(r"\b([A-Z0-9]{2,5}-[A-Z0-9]{2,5})\b", re.IGNORECASE),
    re.compile(
        r"enter\s+this\s+temporary\s+verification\s+code\s+to\s+continue:\s*(\d{6})",
        re.IGNORECASE,
    ),
    re.compile(r"\b(\d{6})\b"),
]


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db_connect() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recipient TEXT NOT NULL,
                sender TEXT NOT NULL,
                subject TEXT NOT NULL,
                body TEXT NOT NULL,
                raw TEXT NOT NULL,
                received_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient, id DESC)"
        )
    cleanup_expired_messages()


def clean_email(value: str) -> str:
    return value.strip().lower()


def sender_email(value: str) -> str:
    return clean_email(parseaddr(value)[1] or value)


def cleanup_expired_messages() -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=MESSAGE_TTL_HOURS))
    cutoff_text = cutoff.replace(microsecond=0).isoformat()
    with db_connect() as conn:
        conn.execute("DELETE FROM messages WHERE received_at < ?", (cutoff_text,))


def is_valid_email(value: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}", value))


def normalize_domain(value: str) -> str:
    return value.strip().lower().lstrip("@")


def is_valid_domain(value: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)+", value))


def load_domains() -> list[str]:
    domains = []
    if DEFAULT_DOMAIN and is_valid_domain(DEFAULT_DOMAIN):
        domains.append(DEFAULT_DOMAIN)
    try:
        saved = json.loads(DOMAINS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        saved = []

    if isinstance(saved, list):
        for domain in saved:
            if isinstance(domain, str):
                normalized = normalize_domain(domain)
                if is_valid_domain(normalized) and normalized not in domains:
                    domains.append(normalized)
    return domains


def save_domains(domains: list[str]) -> None:
    clean_domains = []
    for domain in domains:
        normalized = normalize_domain(domain)
        if is_valid_domain(normalized) and normalized not in clean_domains:
            clean_domains.append(normalized)
    if DEFAULT_DOMAIN and DEFAULT_DOMAIN not in clean_domains:
        clean_domains.insert(0, DEFAULT_DOMAIN)
    DOMAINS_PATH.write_text(
        json.dumps(clean_domains, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def add_domain(domain: str) -> tuple[list[str], str]:
    normalized = normalize_domain(domain)
    if not is_valid_domain(normalized):
        raise ValueError("Domain tidak valid.")
    domains = load_domains()
    if normalized not in domains:
        domains.append(normalized)
        save_domains(domains)
    return domains, normalized


def extract_code(*texts: str) -> str:
    combined = "\n".join(text for text in texts if text)
    for pattern in CODE_PATTERNS:
        match = pattern.search(combined)
        if match:
            return re.sub(r"[^A-Za-z0-9]", "", match.group(1)).upper()
    return ""


def message_to_text(message) -> str:
    if message.is_multipart():
        chunks = []
        for part in message.walk():
            if part.get_content_maintype() == "multipart":
                continue
            if part.get_content_type() not in {"text/plain", "text/html"}:
                continue
            try:
                chunks.append(part.get_content())
            except Exception:
                payload = part.get_payload(decode=True) or b""
                chunks.append(payload.decode(errors="replace"))
        return "\n\n".join(chunks)

    try:
        return message.get_content()
    except Exception:
        payload = message.get_payload(decode=True) or b""
        return payload.decode(errors="replace")


def clean_name_letters(*parts: str) -> str:
    full_name = "".join(parts).lower()
    normalized = unicodedata.normalize("NFKD", full_name)
    return "".join(ch for ch in normalized if "a" <= ch <= "z")


def is_valid_base_name(name: str) -> bool:
    return API_NAME_MIN_LEN <= len(name) <= API_NAME_MAX_LEN


def with_random_digits(name: str) -> str:
    return f"{name}{secrets.randbelow(100):02d}"


def fetch_randomuser_names(count: int, nat: str = "") -> list[tuple[str, str]]:
    url = f"https://randomuser.me/api/?results={count}&inc=name"
    if nat:
        url += f"&nat={nat}"
    req = urllib.request.Request(url, headers={"User-Agent": "TempMailName/1.0"})
    with urllib.request.urlopen(req, timeout=API_TIMEOUT) as resp:
        data = json.loads(resp.read().decode())
    return [
        (user["name"]["first"], user["name"]["last"])
        for user in data.get("results", [])
    ]


def fetch_faker_api_names(count: int, locale: str) -> list[tuple[str, str]]:
    params = urllib.parse.urlencode({
        "_quantity": count,
        "_locale": locale,
        "_seed": secrets.randbelow(999999) + 1,
    })
    last_error = None

    for base_url in FAKER_API_URLS:
        url = f"{base_url}?{params}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "TempMailName/1.0"})
            with urllib.request.urlopen(req, timeout=API_TIMEOUT) as resp:
                data = json.loads(resp.read().decode())
            break
        except (TimeoutError, urllib.error.URLError, OSError) as err:
            last_error = err
    else:
        raise RuntimeError(f"Faker API tidak merespons: {last_error}")

    names = []
    for person in data.get("data", []):
        first = (
            person.get("firstname")
            or person.get("firstName")
            or person.get("first_name")
            or ""
        )
        last = (
            person.get("lastname")
            or person.get("lastName")
            or person.get("last_name")
            or ""
        )
        if not first and not last:
            first = person.get("name") or person.get("fullname") or ""
        names.append((first, last))
    return names


def fetch_api_base_names(count: int, source: str) -> list[str]:
    if count <= 0:
        return []

    source = source.lower()
    names = []
    attempts = 8
    batch_size = min(120, max(25, count * 3))

    for _ in range(attempts):
        if source == "indonesia":
            fetched = fetch_faker_api_names(batch_size, FAKER_INDONESIA_LOCALE)
        else:
            fetched = fetch_randomuser_names(batch_size, ENGLISH_NAT_CODES)

        for first, last in fetched:
            base_name = clean_name_letters(first, last)
            if is_valid_base_name(base_name):
                names.append(base_name)
                if len(names) >= count:
                    return names

    raise RuntimeError(f"Nama {source} 13-15 huruf belum cukup dari API.")


def generate_api_base_names(count: int, source: str) -> list[str]:
    source = source.lower()
    if source == "indonesia":
        return fetch_api_base_names(count, "indonesia")
    if source == "english":
        return fetch_api_base_names(count, "english")

    english_count = count // 2
    indonesia_count = count - english_count
    names = (
        fetch_api_base_names(english_count, "english")
        + fetch_api_base_names(indonesia_count, "indonesia")
    )
    secrets.SystemRandom().shuffle(names)
    return names


def store_message(recipient: str, sender: str, subject: str, body: str, raw: str) -> int:
    with db_connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO messages (recipient, sender, subject, body, raw, received_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (clean_email(recipient), sender, subject, body, raw, utc_now()),
        )
        return int(cursor.lastrowid)


def latest_message_for(email: str) -> dict | None:
    with db_connect() as conn:
        row = conn.execute(
            """
            SELECT id, recipient, sender, subject, body, received_at
            FROM messages
            WHERE recipient = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (clean_email(email),),
        ).fetchone()

    if row is None:
        return None

    code = extract_code(row["subject"], row["body"])
    return {
        "id": row["id"],
        "to": row["recipient"],
        "from": row["sender"],
        "from_email": sender_email(row["sender"]),
        "subject": row["subject"],
        "received_at": row["received_at"],
        "code": code,
    }


def all_messages_for(email: str) -> list[dict]:
    """Return all messages for an email address, newest first."""
    with db_connect() as conn:
        rows = conn.execute(
            """
            SELECT id, recipient, sender, subject, body, received_at
            FROM messages
            WHERE recipient = ?
            ORDER BY id DESC
            """,
            (clean_email(email),),
        ).fetchall()

    messages = []
    for row in rows:
        code = extract_code(row["subject"], row["body"])
        messages.append({
            "id": row["id"],
            "to": row["recipient"],
            "from": row["sender"],
            "from_email": sender_email(row["sender"]),
            "subject": row["subject"],
            "body": row["body"],
            "received_at": row["received_at"],
            "code": code,
        })
    return messages


def generate_local_part() -> str:
    consonants = "bcdfghjklmnpqrstvwxyz"
    vowels = "aiueo"
    base = "".join(secrets.choice(consonants) + secrets.choice(vowels) for _ in range(6))
    digits = f"{secrets.randbelow(100):02d}"
    return f"{base}{digits}"


def generate_emails(count: int, domain: str, source: str = "random") -> list[str]:
    count = max(1, min(MAX_BULK_EMAILS, count))
    domains = load_domains()
    if not domains:
        raise ValueError("Tambahkan domain terlebih dahulu.")

    raw_domain = normalize_domain(domain)
    use_random_domain = raw_domain in ("__random__", "") or not is_valid_domain(raw_domain)

    # Shuffle domains so each request rotates through different domains
    if use_random_domain:
        shuffled = list(domains)
        secrets.SystemRandom().shuffle(shuffled)
    else:
        shuffled = domains

    try:
        local_parts = [with_random_digits(name) for name in generate_api_base_names(count, source)]
    except Exception:
        local_parts = [generate_local_part() for _ in range(count)]

    emails = set()
    for i, local_part in enumerate(local_parts):
        d = shuffled[i % len(shuffled)] if use_random_domain else raw_domain
        emails.add(f"{local_part}@{d}")
    idx = len(local_parts)
    while len(emails) < count:
        d = shuffled[idx % len(shuffled)] if use_random_domain else raw_domain
        emails.add(f"{generate_local_part()}@{d}")
        idx += 1
    return sorted(emails)


class SMTPServer:
    def __init__(self) -> None:
        self.messages: dict[asyncio.StreamWriter, dict] = {}

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        state = {"mail_from": "", "recipients": []}
        writer.write(b"220 TempMail SMTP ready\r\n")
        await writer.drain()

        while not reader.at_eof():
            line = await reader.readline()
            if not line:
                break
            text = line.decode(errors="replace").rstrip("\r\n")
            upper = text.upper()

            if upper.startswith("EHLO") or upper.startswith("HELO"):
                writer.write(b"250-TempMail\r\n250 OK\r\n")
            elif upper.startswith("MAIL FROM:"):
                state["mail_from"] = self._extract_path(text)
                writer.write(b"250 OK\r\n")
            elif upper.startswith("RCPT TO:"):
                recipient = clean_email(self._extract_path(text))
                state["recipients"].append(recipient)
                writer.write(b"250 OK\r\n")
            elif upper == "DATA":
                writer.write(b"354 End data with <CR><LF>.<CR><LF>\r\n")
                await writer.drain()
                raw_bytes = await self._read_data(reader)
                self._save_mail(raw_bytes, state)
                writer.write(b"250 Message accepted\r\n")
            elif upper == "RSET":
                state = {"mail_from": "", "recipients": []}
                writer.write(b"250 OK\r\n")
            elif upper == "QUIT":
                writer.write(b"221 Bye\r\n")
                await writer.drain()
                break
            else:
                writer.write(b"250 OK\r\n")

            await writer.drain()

        writer.close()
        await writer.wait_closed()

    @staticmethod
    def _extract_path(line: str) -> str:
        match = re.search(r"<([^>]+)>", line)
        if match:
            return match.group(1)
        return line.split(":", 1)[-1].strip()

    @staticmethod
    async def _read_data(reader: asyncio.StreamReader) -> bytes:
        chunks = []
        while True:
            line = await reader.readline()
            if line in {b".\r\n", b".\n", b"."}:
                break
            if line.startswith(b".."):
                line = line[1:]
            chunks.append(line)
        return b"".join(chunks)

    @staticmethod
    def _save_mail(raw_bytes: bytes, state: dict) -> None:
        message = BytesParser(policy=policy.default).parsebytes(raw_bytes)
        sender = message.get("From") or state.get("mail_from") or ""
        subject = message.get("Subject") or ""
        body = message_to_text(message)
        raw = raw_bytes.decode(errors="replace")

        recipients = set(state.get("recipients") or [])
        for header in ("To", "Cc", "Delivered-To", "X-Original-To"):
            value = message.get(header)
            if not value:
                continue
            for email in re.findall(r"[\w.+\-]+@[\w.\-]+\.\w+", value):
                recipients.add(clean_email(email))

        for recipient in recipients:
            if is_valid_email(recipient):
                store_message(recipient, sender, subject, body, raw)


class TempMailHandler(SimpleHTTPRequestHandler):
    server_version = "TempMailHTTP/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self.write_json({"ok": True, "domains": load_domains(), "ttl_hours": MESSAGE_TTL_HOURS})
            return
        if path == "/api/domains":
            self.write_json({"domains": load_domains()})
            return
        if path.startswith("/api/"):
            self.write_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        # Static file whitelist — only serve allowed files
        clean_path = path.lstrip("/") or "index.html"
        if clean_path not in ALLOWED_STATIC_FILES:
            self.send_error(HTTPStatus.FORBIDDEN, "Access denied")
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/generate":
            self.handle_generate()
            return
        if path == "/api/inbox/bulk":
            self.handle_bulk_inbox()
            return
        if path == "/api/inbox/messages":
            self.handle_inbox_messages()
            return
        if path == "/api/domains":
            self.handle_add_domain()
            return
        if path.startswith("/api/"):
            self.write_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        self.write_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def handle_generate(self) -> None:
        payload = self.read_json()
        try:
            count = int(payload.get("count", 10))
        except (TypeError, ValueError):
            count = 10
        domain = payload.get("domain") or ""
        source = str(payload.get("source") or "random")
        try:
            emails = generate_emails(count, domain, source)
        except ValueError as err:
            self.write_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)
            return
        self.write_json({"emails": emails})

    def handle_add_domain(self) -> None:
        payload = self.read_json()
        domain = str(payload.get("domain") or "")
        try:
            domains, added = add_domain(domain)
        except ValueError as err:
            self.write_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)
            return
        self.write_json({"domains": domains, "domain": added})

    def handle_bulk_inbox(self) -> None:
        payload = self.read_json()
        emails = payload.get("emails") or []
        if not isinstance(emails, list):
            self.write_json({"error": "emails must be a list"}, HTTPStatus.BAD_REQUEST)
            return

        clean_emails = []
        for email in emails[:MAX_BULK_EMAILS]:
            clean = clean_email(str(email))
            if is_valid_email(clean):
                clean_emails.append(clean)

        results = []
        for email in clean_emails:
            message = latest_message_for(email)
            results.append({
                "email": email,
                "status": "found" if message else "waiting",
                "message": message,
            })
        self.write_json({"results": results})

    def handle_inbox_messages(self) -> None:
        """Return all messages for an email, with full body."""
        payload = self.read_json()
        email = clean_email(str(payload.get("email") or ""))
        if not is_valid_email(email):
            self.write_json({"error": "Email tidak valid."}, HTTPStatus.BAD_REQUEST)
            return

        messages = all_messages_for(email)
        self.write_json({
            "email": email,
            "count": len(messages),
            "messages": messages,
        })

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        body = self.rfile.read(length).decode("utf-8")
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    def write_json(self, data: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


async def run_smtp(host: str, port: int) -> None:
    smtp = SMTPServer()
    server = await asyncio.start_server(smtp.handle, host, port)
    async with server:
        await server.serve_forever()


def start_smtp_thread(host: str, port: int) -> threading.Thread:
    thread = threading.Thread(
        target=lambda: asyncio.run(run_smtp(host, port)),
        daemon=True,
        name="smtp-server",
    )
    thread.start()
    return thread


def start_cleanup_timer() -> None:
    """Run cleanup every CLEANUP_INTERVAL_SECONDS in background."""
    def _loop():
        while True:
            import time
            time.sleep(CLEANUP_INTERVAL_SECONDS)
            try:
                cleanup_expired_messages()
            except Exception:
                pass

    thread = threading.Thread(target=_loop, daemon=True, name="cleanup-timer")
    thread.start()
    return thread


def main() -> None:
    parser = argparse.ArgumentParser(description="Self-hosted TempMail server")
    parser.add_argument("--http-host", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=8080)
    parser.add_argument("--smtp-host", default="127.0.0.1")
    parser.add_argument("--smtp-port", type=int, default=2525)
    args = parser.parse_args()

    init_db()
    start_smtp_thread(args.smtp_host, args.smtp_port)
    start_cleanup_timer()

    domains = load_domains()
    httpd = ThreadingHTTPServer((args.http_host, args.http_port), TempMailHandler)
    print(f"HTTP: http://{args.http_host}:{args.http_port}/")
    print(f"SMTP: {args.smtp_host}:{args.smtp_port}")
    print(f"Domains: {', '.join(domains) if domains else '(none)'}")
    print(f"TTL: {MESSAGE_TTL_HOURS}h | Cleanup every {CLEANUP_INTERVAL_SECONDS}s")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
