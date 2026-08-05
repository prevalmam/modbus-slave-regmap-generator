import tempfile
import unittest
from pathlib import Path

from modbus_slave_regmap_generator.generators import GeneratedFile
from modbus_slave_regmap_generator.writer import write_generated_files


class GeneratedFileWriterTests(unittest.TestCase):
    def test_writes_c_and_header_files_as_utf8_with_lf_line_endings(self):
        generated_files = (
            GeneratedFile("generated.c", "first line\nsecond line\n"),
            GeneratedFile("generated.h", "#ifndef GENERATED_H\n#define GENERATED_H\n#endif\n"),
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            write_generated_files(temp_dir, generated_files)

            for generated_file in generated_files:
                with self.subTest(filename=generated_file.filename):
                    output = (Path(temp_dir) / generated_file.filename).read_bytes()
                    self.assertEqual(output, generated_file.content.encode("utf-8"))
                    self.assertNotIn(b"\r\n", output)
                    self.assertFalse(output.startswith(b"\xef\xbb\xbf"))


if __name__ == "__main__":
    unittest.main()
