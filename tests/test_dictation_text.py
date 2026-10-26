import unittest
from backend.dictation_text import build_dictation_messages


class DictationPromptTests(unittest.TestCase):
    def test_preserves_language_and_script(self):
        messages = build_dictation_messages("ನಾನು ಏನು ಮಾಡ್ತಾ ಇದ್ದೀನಿ?", "kn-IN", "natural")
        self.assertIn("Never translate", messages[0]["content"])
        self.assertEqual(messages[1]["content"], "ನಾನು ಏನು ಮಾಡ್ತಾ ಇದ್ದೀನಿ?")

    def test_bullet_mode_does_not_add_ideas(self):
        messages = build_dictation_messages("buy a notebook and finish science", "en-IN", "bullets")
        self.assertIn("bullet list", messages[0]["content"])
        self.assertIn("Do not add ideas", messages[0]["content"])

    def test_unknown_format_falls_back(self):
        messages = build_dictation_messages("hola", "es-ES", "unsupported")
        self.assertIn("clear, natural writing", messages[0]["content"])

    def test_empty_input_stays_empty(self):
        messages = build_dictation_messages("  ", "en-US", "natural")
        self.assertEqual(messages[1]["content"], "")


if __name__ == "__main__":
    unittest.main()
