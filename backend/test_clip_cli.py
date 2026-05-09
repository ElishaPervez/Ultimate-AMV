import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from clip_cli import parse_ratio, progress

class TestParseRatio(unittest.TestCase):
    def test_standard_fraction(self):
        self.assertAlmostEqual(parse_ratio("24000/1001"), 23.976023976)
        self.assertAlmostEqual(parse_ratio("30000/1001"), 29.970029970)

    def test_integer_like_ratio(self):
        self.assertEqual(parse_ratio("30/1"), 30.0)
        self.assertEqual(parse_ratio("60/1"), 60.0)

    def test_decimal_number_without_slash(self):
        self.assertEqual(parse_ratio("23.976"), 23.976)
        self.assertEqual(parse_ratio("30"), 30.0)
        self.assertEqual(parse_ratio("29.97"), 29.97)

    def test_zero_denominator(self):
        self.assertEqual(parse_ratio("24/0"), 0.0)
        self.assertEqual(parse_ratio("30000/0"), 0.0)
        self.assertEqual(parse_ratio("0/0"), 0.0)

    def test_invalid_formats(self):
        with self.assertRaises(ValueError):
            parse_ratio("abc/def")

        with self.assertRaises(ValueError):
            parse_ratio("abc")

        with self.assertRaises(ValueError):
            parse_ratio("")

        with self.assertRaises(ValueError):
            parse_ratio("/")

class TestProgress(unittest.TestCase):
    def test_legacy_stage_aliases_are_normalized(self):
        output = io.StringIO()
        with redirect_stdout(output):
            progress("transnet", 50, "Analyzing frames", 0)

        payload = json.loads(output.getvalue())
        self.assertEqual(payload["type"], "progress")
        self.assertEqual(payload["stage"], "analyze")
        self.assertEqual(payload["percent"], 50.0)

if __name__ == '__main__':
    unittest.main()
