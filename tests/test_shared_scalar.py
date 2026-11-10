import contextlib
import io
import re
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from modbus_slave_regmap_generator import main
from modbus_slave_regmap_generator.generators import reg_access
from modbus_slave_regmap_generator.workbook_loader import WorkbookData


def _entry(name, entry_type, base_type, length=1, notify=False, access="ACCESS_READWRITE"):
    return {
        "name": name,
        "type": entry_type,
        "var_type_str": base_type,
        "length": length,
        "update_notify": notify,
        "access": access,
    }


def _workbook(entries):
    return WorkbookData(
        entries=entries,
        length_defs={},
        nvm_total_size=256,
        modbus_slave_addr=1,
        group_validate_names=[],
        warnings=[],
    )


def _files(workbook):
    return {item.filename: item.content for item in reg_access.generate(workbook)}


def _function(source, name):
    match = re.search(r"\b" + re.escape(name) + r"\([^\n]*\)\n\{", source)
    if match is None:
        raise AssertionError(f"Missing generated function: {name}")
    start = source.index("{", match.start())
    depth = 1
    end = start + 1
    while depth:
        if source[end] == "{":
            depth += 1
        elif source[end] == "}":
            depth -= 1
        end += 1
    return source[match.start():end]


class SharedScalarGenerationTests(unittest.TestCase):
    def setUp(self):
        self.workbook = _workbook([
            _entry("status", "REG_TYPE_UINT16", "uint16_t", access="ACCESS_READ"),
            _entry("command", "REG_TYPE_UINT16", "uint16_t", notify=True),
            _entry("counter", "REG_TYPE_UINT32", "uint32_t", notify=True),
            _entry("level", "REG_TYPE_FLOAT", "float"),
            _entry("values16", "REG_TYPE_UINT16_ARRAY", "uint16_t", 3, True),
            _entry("values32", "REG_TYPE_UINT32_ARRAY", "uint32_t", 2),
            _entry("values_float", "REG_TYPE_FLOAT_ARRAY", "float", 2),
            _entry("device_name", "REG_TYPE_STRING", "string", 8, True),
            _entry("reserved_20", "REG_TYPE_RESERVED", "reserved"),
        ])
        self.shared = _files(self.workbook)
        self.source = self.shared["modbus_reg_access_slave.c"]

    def test_standard_generation_keeps_named_typed_public_apis(self):
        header = self.shared["modbus_reg_access_slave.h"]
        for declaration in (
            "int set_status(uint16_t value);",
            "int set_counter(uint32_t value);",
            "int set_level(float value);",
            "int set_values16(uint16_t index, uint16_t value);",
            "int set_device_name(const char *value);",
            "int set_command_masked(uint16_t mask, uint16_t value);",
        ):
            self.assertIn(declaration, header)
        self.assertNotIn("reg_slave_set_", header)
        self.assertNotIn("MODBUS_IDX_", header)

    def test_emits_one_typed_core_per_used_scalar_type(self):
        for suffix, base_type in (("uint16", "uint16_t"), ("uint32", "uint32_t"), ("float", "float")):
            signature = f"static int reg_slave_set_{suffix}(uint16_t table_index, {base_type} value)"
            self.assertEqual(self.source.count(signature), 1)
            function = _function(self.source, f"reg_slave_set_{suffix}")
            self.assertIn(f"*((const {base_type} *)entry->min_value)", function)
            self.assertIn(f"*((const {base_type} *)entry->max_value)", function)
            self.assertIn(f"*((const {base_type} *)entry->ram_ptr)", function)
            self.assertLess(function.index("value < min_value"), function.index("value != current"))
            changed = function[function.index("if (value != current)"):]
            self.assertIn(f"*(({base_type} *)entry->ram_ptr) = value;", changed)
            self.assertLess(changed.index("= value;"), changed.index("write_nvm_if_used("))
            self.assertIn("(uint16_t)sizeof(value)", changed)
            self.assertTrue(function.endswith("return 1;\n}"))
            self.assertNotIn("notify", function)
            self.assertNotIn("memcmp", function)
        self.assertNotIn("static void write_uint16", self.source)
        self.assertNotIn("static void write_uint32", self.source)
        self.assertNotIn("static void write_float", self.source)

    def test_notify_is_conditional_on_acceptance_and_outside_value_comparison(self):
        for name, suffix in (("command", "uint16"), ("counter", "uint32")):
            function = _function(self.source, f"set_{name}")
            self.assertIn(f"result = reg_slave_set_{suffix}(MODBUS_IDX_{name}, value);", function)
            self.assertIn(
                "if (result != 0)\n    {\n"
                f"        modbus_reg_update_notify_internal_set(MODBUS_IDX_{name});\n    }}",
                function,
            )
            self.assertEqual(function.count("modbus_reg_update_notify_internal_set("), 1)
            self.assertNotIn("value !=", function)
            self.assertTrue(function.endswith("return result;\n}"))
        for name, suffix in (("status", "uint16"), ("level", "float")):
            function = _function(self.source, f"set_{name}")
            self.assertIn(f"return reg_slave_set_{suffix}(MODBUS_IDX_{name}, value);", function)
            self.assertNotIn("notify", function)

    def test_getters_masked_and_array_setters_keep_their_existing_operations(self):
        self.assertIn(
            "return read_uint16(g_reg_table_slave[MODBUS_IDX_command].ram_ptr);",
            _function(self.source, "get_command"),
        )
        for suffix, field in (("min", "min_value"), ("max", "max_value")):
            self.assertIn(
                f"return read_uint32(g_reg_table_slave[MODBUS_IDX_counter].{field});",
                _function(self.source, f"get_counter_{suffix}"),
            )
        masked = _function(self.source, "set_command_masked")
        self.assertIn("current &= (uint16_t)(~mask);", masked)
        self.assertIn("current |= value;", masked)
        self.assertIn("return set_command(current);", masked)
        self.assertNotIn("notify", masked)
        for name, base_type, count in (("values16", "uint16_t", 3), ("values32", "uint32_t", 2), ("values_float", "float", 2)):
            with self.subTest(name=name):
                function = _function(self.source, f"set_{name}")
                self.assertIn(f"if (index >= {count}U) {{ return 0; }}", function)
                self.assertLess(function.index("value < min"), function.index("current = ram[index]"))
                self.assertIn("if (value != current)", function)
                self.assertIn("ram[index] = value;", function)
                self.assertIn(f"(uint16_t)(index * sizeof({base_type}))", function)
                self.assertIn("write_nvm_if_used(nvm_offset, &ram[index], (uint16_t)sizeof(value));", function)
        self.assertNotIn("set_reserved_20", self.source)

    def test_only_array_string_or_reserved_entries_add_no_scalar_cores(self):
        entries = [entry for entry in self.workbook.entries if entry["length"] > 1 or entry["type"] == "REG_TYPE_RESERVED"]
        source = _files(_workbook(entries))["modbus_reg_access_slave.c"]
        self.assertNotIn("static int reg_slave_set_", source)
        source = _files(_workbook([self.workbook.entries[0]]))["modbus_reg_access_slave.c"]
        self.assertIn("static int reg_slave_set_uint16", source)
        self.assertNotIn("static int reg_slave_set_uint32", source)
        self.assertNotIn("static int reg_slave_set_float", source)

    def test_internal_setters_do_not_add_external_write_guards_or_storage(self):
        for token in ("entry->access", "write_check", "group_validate", "busy_reject", "malloc(", "calloc(", "realloc(", "inline ", "isnan(", "isfinite("):
            self.assertNotIn(token, self.source)
        helper = _function(self.source, "write_nvm_if_used")
        self.assertIn("if (offset != NVM_OFFSET_UNUSED)", helper)
        self.assertIn("NVM_Request_Write_Bytes(offset, (const uint8_t *)data, length);", helper)

    def test_empty_definition_emits_no_scalar_cores(self):
        source = _files(_workbook([]))["modbus_reg_access_slave.c"]
        self.assertNotIn("static int reg_slave_set_", source)


class StandardEntryPointTests(unittest.TestCase):
    def test_direct_source_entry_point_needs_no_access_mode_option(self):
        result = subprocess.run(
            [sys.executable, "-B", str(Path(main.__file__).resolve()), "--help"],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertIn("--help", result.stdout)
        self.assertNotIn("--access-impl", result.stdout)

    def test_removed_access_mode_option_is_rejected_before_opening_the_gui(self):
        with patch.object(main.tk, "Tk") as tk_root:
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    main.main(["--access-impl", "expanded"])
            self.assertEqual(caught.exception.code, 2)
            tk_root.assert_not_called()

    def test_standard_start_calls_the_generator_without_a_mode(self):
        workbook = _workbook([])
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(main.tk, "Tk"))
            stack.enter_context(patch.object(main.filedialog, "askopenfilename", return_value="registers.xlsx"))
            stack.enter_context(patch.object(main, "load_workbook_data", return_value=workbook))
            for generator in (main.reg_map, main.reg_idx, main.update_notify, main.write_guard, main.parser):
                stack.enter_context(patch.object(generator, "generate", return_value=[]))
            generate = stack.enter_context(patch.object(main.reg_access, "generate", return_value=[]))
            stack.enter_context(patch.object(main, "remove_obsolete_generated_files"))
            writer = stack.enter_context(patch.object(main, "write_generated_files"))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            main.main([])
            generate.assert_called_once_with(workbook)
            writer.assert_called_once()


if __name__ == "__main__":
    unittest.main()
