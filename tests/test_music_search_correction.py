from backend import api


def test_music_search_retries_with_ai_corrected_spelling(monkeypatch):
    calls = []

    def fake_search(query):
        calls.append(query)
        if query == "Bohemian Rhapsody":
            return {
                "success": True,
                "query": query,
                "source": "apple-itunes",
                "tracks": [{
                    "id": "queen-1",
                    "name": "Bohemian Rhapsody",
                    "artist": "Queen",
                    "album": "A Night at the Opera",
                    "audio": "https://example.test/preview.mp3",
                    "image": "",
                    "duration": 300000,
                    "provider": "apple-itunes",
                }],
            }
        return {
            "success": True,
            "query": query,
            "source": "apple-itunes",
            "tracks": [{
                "id": "unrelated",
                "name": "Rhapsody Live",
                "artist": "Unknown",
                "album": "",
                "audio": "https://example.test/other.mp3",
                "duration": 120000,
                "provider": "apple-itunes",
            }],
        }

    monkeypatch.setattr(api.music_service, "search", fake_search)
    monkeypatch.setattr(api, "correct_music_search_query", lambda query: "Bohemian Rhapsody")

    result = api.music_search(api.MusicSearchRequest(query="bohemain rhapsody"))

    assert calls == ["bohemain rhapsody", "Bohemian Rhapsody"]
    assert result["success"] is True
    assert result["tracks"][0]["name"] == "Bohemian Rhapsody"
    assert result["original_query"] == "bohemain rhapsody"
    assert result["corrected_query"] == "Bohemian Rhapsody"
    assert result["notice"] == "Search corrected to: Bohemian Rhapsody"


def test_music_search_relevance_ignores_command_filler():
    tracks = [{"name": "Phonk Mix", "artist": "DJ Example", "genre": "Phonk"}]
    assert api.music_search_relevance("I want to listen to phonk", tracks) == 1.0
