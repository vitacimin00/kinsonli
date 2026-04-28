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
import string
import threading
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


APP_DIR = Path(__file__).resolve().parent
DB_PATH = APP_DIR / "tempmail.db"
DOMAINS_PATH = APP_DIR / "tempmail_domains.json"
DEFAULT_DOMAIN = "kinsonli.site"
MAX_BULK_EMAILS = 10

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


def clean_email(value: str) -> str:
    return value.strip().lower()


def is_valid_email(value: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}", value))


def normalize_domain(value: str) -> str:
    return value.strip().lower().lstrip("@")


def is_valid_domain(value: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)+", value))


def load_domains() -> list[str]:
    domains = [DEFAULT_DOMAIN]
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
    if DEFAULT_DOMAIN not in clean_domains:
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
        "subject": row["subject"],
        "received_at": row["received_at"],
        "code": code,
    }


def generate_local_part() -> str:
    consonants = "bcdfghjklmnpqrstvwxyz"
    vowels = "aiueo"
    base = "".join(secrets.choice(consonants) + secrets.choice(vowels) for _ in range(6))
    digits = f"{secrets.randbelow(100):02d}"
    return f"{base}{digits}"


def generate_emails(count: int, domain: str) -> list[str]:
    count = max(1, min(MAX_BULK_EMAILS, count))
    domain = normalize_domain(domain) or DEFAULT_DOMAIN
    if not is_valid_domain(domain):
        domain = DEFAULT_DOMAIN
    emails = set()
    while len(emails) < count:
        emails.add(f"{generate_local_part()}@{domain}")
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
            self.write_json({"ok": True, "domain": DEFAULT_DOMAIN, "domains": load_domains()})
            return
        if path == "/api/domains":
            self.write_json({"domains": load_domains()})
            return
        if path.startswith("/api/"):
            self.write_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
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
        domain = payload.get("domain") or DEFAULT_DOMAIN
        self.write_json({"emails": generate_emails(count, domain)})

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


def main() -> None:
    parser = argparse.ArgumentParser(description="Self-hosted TempMail server")
    parser.add_argument("--http-host", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=8080)
    parser.add_argument("--smtp-host", default="127.0.0.1")
    parser.add_argument("--smtp-port", type=int, default=2525)
    args = parser.parse_args()

    init_db()
    start_smtp_thread(args.smtp_host, args.smtp_port)

    httpd = ThreadingHTTPServer((args.http_host, args.http_port), TempMailHandler)
    print(f"HTTP: http://{args.http_host}:{args.http_port}/")
    print(f"SMTP: {args.smtp_host}:{args.smtp_port}")
    print(f"Domain: {DEFAULT_DOMAIN}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
