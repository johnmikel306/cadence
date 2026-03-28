import asyncio
import json
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import edge_tts
from flask import (
    Flask,
    Response,
    jsonify,
    render_template,
    request,
    send_file,
    stream_with_context,
)
from flask_cors import CORS
from werkzeug.utils import secure_filename


BASE_DIR = os.path.dirname(os.path.abspath(__file__))


app = Flask(__name__, template_folder="templates", static_folder="static")
CORS(app)


UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
ALLOWED_EXTENSIONS = {"txt", "pdf", "docx", "md", "markdown"}
MAX_CONTENT_LENGTH = 16 * 1024 * 1024
DEFAULT_VOICE = "en-US-AriaNeural"
VOICE_CACHE_TTL_SECONDS = 60 * 60
DOCUMENT_TTL_SECONDS = 24 * 60 * 60
SESSION_TTL_SECONDS = 30 * 60
FINISHED_SESSION_TTL_SECONDS = 5 * 60
RATE_PATTERN = re.compile(r"^[+-]\d+%$")


app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

os.makedirs(UPLOAD_FOLDER, exist_ok=True)


documents_lock = threading.Lock()
sessions_lock = threading.Lock()
voice_cache_lock = threading.Lock()

documents: Dict[str, dict] = {}
read_sessions: Dict[str, "ReadSession"] = {}
voice_cache = {"loaded_at": 0.0, "voices": []}


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def get_file_type(filename: str) -> str:
    extension = filename.rsplit(".", 1)[1].lower()
    if extension == "markdown":
        return "md"
    return extension


def build_document_path(document_id: str, filename: str) -> str:
    safe_name = secure_filename(filename)
    directory = os.path.join(app.config["UPLOAD_FOLDER"], document_id)
    os.makedirs(directory, exist_ok=True)
    return os.path.join(directory, safe_name)


def current_timestamp() -> float:
    return time.time()


def cleanup_expired_entries() -> None:
    now = current_timestamp()

    expired_document_ids: List[str] = []
    with documents_lock:
        for document_id, document in documents.items():
            if now - document["created_at"] > DOCUMENT_TTL_SECONDS:
                expired_document_ids.append(document_id)

        for document_id in expired_document_ids:
            document = documents.pop(document_id, None)
            if not document:
                continue
            file_path = document.get("file_path")
            if file_path and os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except OSError:
                    pass
            directory = os.path.dirname(file_path) if file_path else None
            if directory and os.path.isdir(directory):
                try:
                    os.rmdir(directory)
                except OSError:
                    pass

    expired_session_ids: List[str] = []
    with sessions_lock:
        for session_id, session in read_sessions.items():
            age = now - session.created_at
            finished_age = now - session.updated_at
            if age > SESSION_TTL_SECONDS or (
                session.is_finished and finished_age > FINISHED_SESSION_TTL_SECONDS
            ):
                expired_session_ids.append(session_id)

        for session_id in expired_session_ids:
            session = read_sessions.pop(session_id, None)
            if session:
                session.cancel()


def get_document_or_404(document_id: str) -> Optional[dict]:
    cleanup_expired_entries()
    with documents_lock:
        return documents.get(document_id)


def get_session_or_404(session_id: str) -> Optional["ReadSession"]:
    cleanup_expired_entries()
    with sessions_lock:
        return read_sessions.get(session_id)


def load_voices() -> List[dict]:
    with voice_cache_lock:
        cached_voices = voice_cache["voices"]
        if (
            cached_voices
            and current_timestamp() - voice_cache["loaded_at"] < VOICE_CACHE_TTL_SECONDS
        ):
            return cached_voices

    voices = asyncio.run(edge_tts.list_voices())
    formatted = []
    for voice in voices:
        formatted.append(
            {
                "name": voice.get("ShortName"),
                "locale": voice.get("Locale"),
                "gender": voice.get("Gender"),
                "friendly_name": voice.get("FriendlyName"),
            }
        )
    formatted.sort(key=lambda voice: (voice["locale"], voice["name"]))

    with voice_cache_lock:
        voice_cache["voices"] = formatted
        voice_cache["loaded_at"] = current_timestamp()

    return formatted


def validate_rate(value: str) -> str:
    if not value:
        return "+0%"
    if not RATE_PATTERN.match(value):
        raise ValueError("Rate must look like +0%, +25%, or -25%")
    return value


def ticks_to_seconds(value: int) -> float:
    return value / 10_000_000


class BoundaryMatcher:
    def __init__(self, text: str):
        self.text = text
        self.cursor = 0

    def locate(self, token: str) -> tuple[int, int]:
        if not token:
            return self.cursor, self.cursor

        start = self.text.find(token, self.cursor)
        matched_token = token

        if start == -1 and token.strip():
            stripped = token.strip()
            start = self.text.find(stripped, self.cursor)
            if start != -1:
                matched_token = stripped

        if start == -1:
            fallback_cursor = self.cursor
            while (
                fallback_cursor < len(self.text)
                and self.text[fallback_cursor].isspace()
            ):
                fallback_cursor += 1
            start = fallback_cursor
            end = min(len(self.text), start + len(matched_token))
        else:
            end = start + len(matched_token)

        self.cursor = max(self.cursor, end)
        return start, end


@dataclass
class ReadSession:
    session_id: str
    document_id: str
    text: str
    start_offset: int
    voice: str
    rate: str
    created_at: float = field(default_factory=current_timestamp)
    updated_at: float = field(default_factory=current_timestamp)
    audio_chunks: List[bytes] = field(default_factory=list)
    events: List[dict] = field(default_factory=list)
    condition: threading.Condition = field(default_factory=threading.Condition)
    cancel_event: threading.Event = field(default_factory=threading.Event)
    audio_complete: bool = False
    events_complete: bool = False
    error: Optional[str] = None
    is_finished: bool = False
    worker: Optional[threading.Thread] = None

    def start(self) -> None:
        self.worker = threading.Thread(target=self._run, daemon=True)
        self.worker.start()

    def cancel(self) -> None:
        self.cancel_event.set()
        with self.condition:
            self.updated_at = current_timestamp()
            self.audio_complete = True
            self.events_complete = True
            self.is_finished = True
            self.condition.notify_all()

    def _run(self) -> None:
        matcher = BoundaryMatcher(self.text)

        try:
            communicator = edge_tts.Communicate(
                self.text,
                self.voice,
                rate=self.rate,
                boundary="WordBoundary",
            )

            for message in communicator.stream_sync():
                if self.cancel_event.is_set():
                    break

                if message["type"] == "audio":
                    with self.condition:
                        self.audio_chunks.append(message["data"])
                        self.updated_at = current_timestamp()
                        self.condition.notify_all()
                    continue

                if message["type"] != "WordBoundary":
                    continue

                char_start, char_end = matcher.locate(message.get("text", ""))
                event = {
                    "type": "word",
                    "text": message.get("text", ""),
                    "char_start": char_start,
                    "char_end": char_end,
                    "time_start": ticks_to_seconds(message.get("offset", 0)),
                    "time_end": ticks_to_seconds(
                        message.get("offset", 0) + message.get("duration", 0)
                    ),
                }
                with self.condition:
                    self.events.append(event)
                    self.updated_at = current_timestamp()
                    self.condition.notify_all()
        except Exception as exc:
            with self.condition:
                self.error = str(exc)
                self.updated_at = current_timestamp()
                self.condition.notify_all()
        finally:
            with self.condition:
                self.audio_complete = True
                self.events_complete = True
                self.is_finished = True
                self.updated_at = current_timestamp()
                self.condition.notify_all()


@app.route("/")
def landing():
    return render_template("landing.html")


@app.route("/reader")
def reader():
    return render_template("index.html")


@app.route("/api/voices", methods=["GET"])
def get_voices():
    try:
        voices = load_voices()
        return jsonify(voices)
    except Exception as exc:
        return jsonify({"error": f"Failed to load voices: {exc}"}), 500


@app.route("/api/upload", methods=["POST"])
def upload_file():
    cleanup_expired_entries()

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    if not file or not allowed_file(file.filename):
        return jsonify({"error": "Invalid file type"}), 400

    original_name = secure_filename(file.filename)
    document_id = uuid.uuid4().hex
    file_type = get_file_type(original_name)
    file_path = build_document_path(document_id, original_name)
    file.save(file_path)

    document = {
        "id": document_id,
        "filename": original_name,
        "file_type": file_type,
        "file_path": file_path,
        "created_at": current_timestamp(),
        "canonical_text": None,
    }

    with documents_lock:
        documents[document_id] = document

    return jsonify(
        {
            "document_id": document_id,
            "filename": original_name,
            "file_type": file_type,
            "file_url": f"/api/documents/{document_id}/file",
        }
    )


@app.route("/api/documents/<document_id>/file", methods=["GET"])
def get_document_file(document_id: str):
    document = get_document_or_404(document_id)
    if not document:
        return jsonify({"error": "Document not found"}), 404

    return send_file(document["file_path"], download_name=document["filename"])


@app.route("/api/documents/<document_id>/manifest", methods=["POST"])
def save_document_manifest(document_id: str):
    document = get_document_or_404(document_id)
    if not document:
        return jsonify({"error": "Document not found"}), 404

    data = request.get_json(silent=True) or {}
    canonical_text = data.get("canonical_text", "")

    if not isinstance(canonical_text, str) or not canonical_text.strip():
        return jsonify({"error": "Canonical text is required"}), 400

    with documents_lock:
        stored = documents.get(document_id)
        if not stored:
            return jsonify({"error": "Document not found"}), 404
        stored["canonical_text"] = canonical_text

    return jsonify({"message": "Manifest saved"})


@app.route("/api/read-sessions", methods=["POST"])
def create_read_session():
    cleanup_expired_entries()

    data = request.get_json(silent=True) or {}
    document_id = data.get("document_id")
    voice = data.get("voice") or DEFAULT_VOICE
    start_offset = data.get("start_offset", 0)

    if not document_id:
        return jsonify({"error": "Document ID is required"}), 400

    document = get_document_or_404(document_id)
    if not document:
        return jsonify({"error": "Document not found"}), 404

    canonical_text = document.get("canonical_text")
    if not canonical_text:
        return jsonify({"error": "Document manifest is not ready yet"}), 400

    try:
        start_offset = max(0, min(int(start_offset), len(canonical_text)))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid start offset"}), 400

    try:
        rate = validate_rate(data.get("rate", "+0%"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    text_to_read = canonical_text[start_offset:]
    if not text_to_read.strip():
        return jsonify({"error": "Nothing left to read from this position"}), 400

    session_id = uuid.uuid4().hex
    session = ReadSession(
        session_id=session_id,
        document_id=document_id,
        text=text_to_read,
        start_offset=start_offset,
        voice=voice,
        rate=rate,
    )
    session.start()

    with sessions_lock:
        read_sessions[session_id] = session

    return jsonify(
        {
            "session_id": session_id,
            "audio_url": f"/api/read-sessions/{session_id}/audio",
            "events_url": f"/api/read-sessions/{session_id}/events",
            "start_offset": start_offset,
            "voice": voice,
            "rate": rate,
        }
    )


@app.route("/api/read-sessions/<session_id>/audio", methods=["GET"])
def stream_audio(session_id: str):
    session = get_session_or_404(session_id)
    if not session:
        return jsonify({"error": "Read session not found"}), 404

    def generate():
        index = 0
        while True:
            chunk = None
            with session.condition:
                while (
                    index >= len(session.audio_chunks)
                    and not session.audio_complete
                    and not session.error
                    and not session.cancel_event.is_set()
                ):
                    session.condition.wait(timeout=1)

                if index < len(session.audio_chunks):
                    chunk = session.audio_chunks[index]
                    index += 1
                elif (
                    session.cancel_event.is_set()
                    or session.audio_complete
                    or session.error
                ):
                    break

            if chunk is not None:
                yield chunk

    response = Response(stream_with_context(generate()), mimetype="audio/mpeg")
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Accel-Buffering"] = "no"
    return response


@app.route("/api/read-sessions/<session_id>/events", methods=["GET"])
def stream_events(session_id: str):
    session = get_session_or_404(session_id)
    if not session:
        return jsonify({"error": "Read session not found"}), 404

    def format_sse(event_name: str, payload: dict) -> str:
        return f"event: {event_name}\ndata: {json.dumps(payload)}\n\n"

    def generate():
        index = 0
        yield "retry: 1000\n\n"

        while True:
            event = None
            error = None
            finished = False
            send_heartbeat = False

            with session.condition:
                while (
                    index >= len(session.events)
                    and not session.events_complete
                    and not session.error
                    and not session.cancel_event.is_set()
                ):
                    session.condition.wait(timeout=1)
                    if (
                        index >= len(session.events)
                        and not session.events_complete
                        and not session.error
                        and not session.cancel_event.is_set()
                    ):
                        send_heartbeat = True
                        break

                if index < len(session.events):
                    event = session.events[index]
                    index += 1
                else:
                    error = session.error
                    finished = session.events_complete or session.cancel_event.is_set()

            if send_heartbeat:
                yield ": keep-alive\n\n"
                continue

            if event is not None:
                yield format_sse("word", event)
                continue

            if error:
                yield format_sse("error", {"message": error})
                break

            if finished:
                yield format_sse("done", {"session_id": session.session_id})
                break

    response = Response(stream_with_context(generate()), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Accel-Buffering"] = "no"
    response.headers["Connection"] = "keep-alive"
    return response


@app.route("/api/read-sessions/<session_id>", methods=["DELETE"])
def delete_read_session(session_id: str):
    with sessions_lock:
        session = read_sessions.pop(session_id, None)

    if not session:
        return jsonify({"error": "Read session not found"}), 404

    session.cancel()
    return jsonify({"message": "Read session stopped"})


if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)
