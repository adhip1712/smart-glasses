"""Provider contracts for AI, command correction, and future voice input."""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any

from spellchecker import SpellChecker


@dataclass(frozen=True)
class CorrectionResult:
    original_text: str
    normalized_text: str
    confidence: float


class AIProvider(ABC):
    @abstractmethod
    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float,
        max_completion_tokens: int,
    ) -> str:
        raise NotImplementedError


class GroqAIProvider(AIProvider):
    def __init__(self, client: Any):
        self.client = client

    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float,
        max_completion_tokens: int,
    ) -> str:
        completion = self.client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_completion_tokens=max_completion_tokens,
        )
        content = completion.choices[0].message.content
        return content.strip() if content else ""


class OpenAIProvider(AIProvider):
    """OpenAI chat completions.

    Uses the official ``openai`` package when it is installed and falls back
    to a plain HTTPS request otherwise, so the backend never requires a
    dependency that may be missing in an offline environment.  The API key is
    only ever read on the backend.
    """

    def __init__(self, api_key: str, base_url: str = "https://api.openai.com/v1", client: Any = None):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.client = client

    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float,
        max_completion_tokens: int,
    ) -> str:
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_completion_tokens": max_completion_tokens,
        }

        if self.client is not None:
            completion = self.client.chat.completions.create(**payload)
            content = completion.choices[0].message.content
            return content.strip() if content else ""

        try:
            import httpx
        except ImportError:  # pragma: no cover - httpx ships with FastAPI stacks
            from urllib.request import Request, urlopen

            request = Request(
                f"{self.base_url}/chat/completions",
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with urlopen(request, timeout=60) as response:
                body = json.loads(response.read().decode("utf-8"))
            return (body["choices"][0]["message"]["content"] or "").strip()

        response = httpx.post(
            f"{self.base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60.0,
        )
        response.raise_for_status()
        body = response.json()
        content = body["choices"][0]["message"]["content"]
        return content.strip() if content else ""


class CommandCorrectionProvider(ABC):
    @abstractmethod
    def correct(self, text: str) -> CorrectionResult:
        raise NotImplementedError


class LocalFallbackCorrectionProvider(CommandCorrectionProvider):
    COMMAND_TERMS = {
        "ai", "analyze", "assistant", "camera", "capture", "chat", "clear",
        "close", "command", "connect", "conversation", "conversations", "create",
        "delete", "device", "disconnect", "forecast", "glasses", "identify", "image",
        "listen", "microphone", "music", "navigate", "navigation", "notification",
        "object", "open", "pause", "picture", "play", "read", "rename", "resume",
        "route", "search", "settings", "show", "skip", "speaker", "start", "status",
        "stop", "summarize", "take", "text", "track", "vision", "voice", "wake",
        "weather", "wifi", "reset", "forget", "confirm", "check",
    }
    SHORT_FORMS = {"plz": "please", "pls": "please"}
    COMMAND_VERBS = {
        "analyze", "capture", "check", "clear", "close", "connect", "create",
        "delete", "disconnect", "explain", "identify", "list", "listen", "open",
        "pause", "play", "read", "rename", "resume", "search", "show", "skip",
        "start", "stop", "summarize", "take", "wake",
    }

    def __init__(self, vocabulary: set[str] | None = None):
        self._spellchecker = SpellChecker(distance=1)
        self._spellchecker.word_frequency.load_words(self.COMMAND_TERMS)
        self._command_terms = set(self.COMMAND_TERMS)
        if vocabulary:
            self._spellchecker.word_frequency.load_words(vocabulary)
            self._command_terms.update(word.lower() for word in vocabulary)

    @staticmethod
    def _match_case(source: str, replacement: str) -> str:
        if source.isupper():
            return replacement.upper()
        if source[:1].isupper():
            return replacement.capitalize()
        return replacement

    def _correct_word(self, token: str) -> tuple[str, float]:
        lower = token.lower()
        if lower in self.SHORT_FORMS:
            replacement = self.SHORT_FORMS[lower]
            return self._match_case(token, replacement), SequenceMatcher(None, lower, replacement).ratio()
        if len(token) < 3 or token.isupper() or any(character.isdigit() for character in token):
            return token, 1.0
        if self._spellchecker.known([lower]):
            return token, 1.0

        command_candidate = max(
            self._command_terms,
            key=lambda candidate: SequenceMatcher(None, lower, candidate).ratio(),
            default="",
        )
        command_confidence = SequenceMatcher(None, lower, command_candidate).ratio()
        if command_confidence >= 0.78:
            return self._match_case(token, command_candidate), command_confidence

        replacement = self._spellchecker.correction(lower)
        if not replacement or replacement == lower:
            return token, 1.0

        confidence = SequenceMatcher(None, lower, replacement).ratio()
        if confidence < 0.72:
            return token, 1.0
        return self._match_case(token, replacement), confidence

    def correct(self, text: str) -> CorrectionResult:
        original = text or ""
        normalized = re.sub(r"\s+", " ", original).strip()
        confidences: list[float] = []

        tokens = list(re.finditer(r"[A-Za-z][A-Za-z']*", normalized))
        corrections: list[tuple[int, int, str]] = []
        corrected_words = [
            self._correct_word(match.group(0))[0].lower()
            for match in tokens
        ]
        for index, match in enumerate(tokens):
            token = match.group(0)
            replacement, confidence = self._correct_word(token)
            if replacement != token:
                corrections.append((match.start(), match.end(), replacement))
                confidences.append(confidence)

            if index == 0 and token.lower() == "star" and len(tokens) > 1:
                following = corrected_words[1]
                if following in {"navigation", "listening", "music"}:
                    corrections.append((match.start(), match.end(), self._match_case(token, "start")))
                    confidences.append(SequenceMatcher(None, token.lower(), "start").ratio())

        for start, end, replacement in reversed(corrections):
            normalized = normalized[:start] + replacement + normalized[end:]

        confidence = min(confidences, default=1.0)
        return CorrectionResult(original, normalized, confidence)


class VoiceInputProvider(ABC):
    @abstractmethod
    def transcribe(self, audio: bytes) -> str:
        """Convert voice input to text; implementations can be added when supported."""
        raise NotImplementedError


class CommandRouter:
    def __init__(self):
        self._handlers: dict[str, Any] = {}

    def register(self, intent: str, handler: Any) -> None:
        self._handlers[intent] = handler

    def dispatch(self, intent: str, classification: dict[str, Any], context: Any) -> Any | None:
        handler = self._handlers.get(intent)
        return handler(classification, context) if handler else None
