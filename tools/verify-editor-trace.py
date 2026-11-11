"""Compare a browser export with the Python generator for the same register definition."""

import argparse
import sys
from pathlib import Path
from zipfile import BadZipFile, ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from modbus_slave_regmap_generator.generators import (
    parser,
    reg_access,
    reg_idx,
    reg_map,
    update_notify,
    write_guard,
)
from modbus_slave_regmap_generator.workbook_loader import load_workbook_data


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("workbook", help="Excel input to the Python generator")
    cli.add_argument("export_zip", help="C/H ZIP exported from the HTML editor")
    args = cli.parse_args()

    try:
        workbook = load_workbook_data(args.workbook)
        expected = {
            file.filename: file.content.encode("utf-8")
            for generator in (reg_map, reg_idx, reg_access, update_notify, write_guard, parser)
            for file in generator.generate(workbook)
        }
        for warning in workbook.warnings:
            print(f"Python warning: {warning}", file=sys.stderr)
        with ZipFile(args.export_zip) as archive:
            names = archive.namelist()
            actual = set(names)
            if len(names) != len(actual):
                print("Duplicate filenames in browser ZIP", file=sys.stderr)
                return 1
            missing = expected.keys() - actual
            extra = actual - expected.keys()
            different = [name for name in expected.keys() & actual if archive.read(name) != expected[name]]
    except (OSError, ValueError, BadZipFile) as error:
        print(error, file=sys.stderr)
        return 1

    for label, names in (("Missing", missing), ("Unexpected", extra), ("Content differs", different)):
        for name in sorted(names):
            print(f"{label}: {name}", file=sys.stderr)
    if missing or extra or different:
        return 1
    print(f"{len(expected)} files match byte for byte")
    return 0


if __name__ == "__main__":
    sys.exit(main())
